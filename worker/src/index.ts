/**
 * Monolog Worker — bridges the app to Groq.
 * Single endpoint: POST /analyze
 * Takes a note → sends to llama-3.3-70b-versatile → returns structured reminder data.
 */

interface Env {
  GROQ_API_KEY: string;
  WAITLIST: KVNamespace;
  RATELIMIT: KVNamespace;
  // Admin panel Basic Auth credentials — set via `wrangler secret put`.
  // Never hard-code these in the worker source; they would land in git.
  ADMIN_USER: string;
  ADMIN_PASS: string;
}

interface AnalyzeResponse {
  /**
   * What to do: "create" = new reminder, "modify" = change existing,
   * "skip" = silence one occurrence, "delete" = remove, "none" = just a note.
   */
  action: 'create' | 'modify' | 'skip' | 'delete' | 'none';
  title: string;
  needsReminder: boolean;
  reminder: {
    datetime: string; // ISO 8601
    recurring: 'none' | 'daily' | 'weekly' | 'monthly';
    daysOfWeek?: number[];
    /** Minutes before the event to send the early reminder (0 = at event time). */
    remindBeforeMinutes?: number;
  } | null;
  /** Title of the reminder to target (for modify/delete/skip). */
  targetReminderTitle?: string;
  /** New values for the target reminder (for modify action). */
  modify?: {
    title?: string;
    datetime?: string;
    recurring?: 'none' | 'daily' | 'weekly' | 'monthly';
    daysOfWeek?: number[];
    remindBeforeMinutes?: number;
  };
}

/** Format a Date as local ISO string (no timezone suffix). */
function formatLocal(utcDate: Date, offsetMinutes: number): string {
  const local = new Date(utcDate.getTime() - offsetMinutes * 60_000);
  const y = local.getUTCFullYear();
  const m = String(local.getUTCMonth() + 1).padStart(2, '0');
  const d = String(local.getUTCDate()).padStart(2, '0');
  const h = String(local.getUTCHours()).padStart(2, '0');
  const min = String(local.getUTCMinutes()).padStart(2, '0');
  const s = String(local.getUTCSeconds()).padStart(2, '0');
  return `${y}-${m}-${d}T${h}:${min}:${s}`;
}

// ── CORS allowlist ─────────────────────────────────────────────
// Production domain + common local dev origins. Anything else is rejected
// by the browser (no Access-Control-Allow-Origin header returned).
// Why: Origin reflection (echoing whatever Origin comes in) is the #1 CORS
// anti-pattern — if we ever add cookies/auth, any site could call us as
// the user. Allowlist now is future-proofing.
const ALLOWED_ORIGINS = new Set([
  'https://mono-log-web.vercel.app',
  'http://localhost:8081',    // Expo Metro (web)
  'http://localhost:19006',   // Expo Metro (web, alt)
  'http://127.0.0.1:8081',
  'https://localhost:8081',   // Some Expo setups use https
]);

function buildCorsHeaders(origin: string | null): Record<string, string> {
  if (!origin || !ALLOWED_ORIGINS.has(origin)) {
    // Returning {} means: no Access-Control-Allow-Origin header. Browser
    // will block the response. The request still reaches the worker, but
    // cross-origin JS can't read the response — which is what we want.
    return { Vary: 'Origin' };
  }
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

// ── Client IP lookup ────────────────────────────────────────────
// CF-Connecting-IP is set by Cloudflare's edge and CANNOT be spoofed by
// the client — it's overwritten at the edge before our worker sees it.
// We intentionally do NOT fall back to X-Forwarded-For: that header is
// client-controlled and trivially spoofable, which would let an attacker
// rotate fake IPs to bypass per-IP rate limits.
function getClientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown';
}

// ── Free-tier daily limit ───────────────────────────────────────
// Shared across /analyze and /transcribe (10 combined AI calls/day per IP).
// Defined once here so both routes reference the same source of truth.
const FREE_TIER_DAILY_LIMIT_GLOBAL = 10;

// ── Paid-tier daily limit ───────────────────────────────────────
// Hard cap for paid accounts. Currently scaffolding — not enforced
// until Stripe webhooks set a per-IP/account "paid" flag in KV. Once
// wired up, the worker will check that flag and use this limit instead.
// 100/day = ~3000/mo, plenty for any real user, caps abuse cost.
const PAID_TIER_DAILY_LIMIT = 100;

// ── Waitlist-promo daily limit ──────────────────────────────────
// Join the waitlist → get unlimited sorting until iOS launches.
// "Unlimited" = 100/day per token (effectively unlimited for a real
// user, but caps abuse if a token gets shared online). Groq's global
// 30 RPM is the real ceiling anyway.
const WL_PROMO_DAILY_LIMIT = 100;

/** Increment the per-IP daily counter. No-op on storage failure. */
async function bumpDailyCounter(env: Env, ip: string, current: number): Promise<void> {
  const todayKey = new Date().toISOString().slice(0, 10);
  const rlKey = `rl:${ip}:${todayKey}`;
  await bumpCounterKey(env, rlKey, current);
}

/** Increment an arbitrary rate-limit key. Sets 48h TTL on first use. */
async function bumpCounterKey(env: Env, rlKey: string, current: number): Promise<void> {
  const next = current + 1;
  if (current === 0) {
    await env.RATELIMIT.put(rlKey, String(next), { expirationTtl: 60 * 60 * 48 });
  } else {
    await env.RATELIMIT.put(rlKey, String(next));
  }
}

/**
 * Refund one slot from the per-IP daily counter. Used when the Groq
 * call failed on our side (5xx, rate-limit, empty response) so the
 * user isn't penalized for infrastructure problems. Clamps at 0.
 */
async function refundDailyCounter(env: Env, ip: string): Promise<void> {
  try {
    const todayKey = new Date().toISOString().slice(0, 10);
    const rlKey = `rl:${ip}:${todayKey}`;
    const raw = await env.RATELIMIT.get(rlKey);
    const c = Math.max(0, (parseInt(raw ?? '0', 10)) - 1);
    await env.RATELIMIT.put(rlKey, String(c));
  } catch {
    // Refund failure shouldn't crash the response path.
  }
}

/**
 * Refund one slot from the waitlist-token counter (same logic as
 * refundDailyCounter but keyed on the token, not the IP).
 */
async function refundWlCounter(env: Env, token: string): Promise<void> {
  try {
    const todayKey = new Date().toISOString().slice(0, 10);
    const rlKey = `rl-wl:${token}:${todayKey}`;
    const raw = await env.RATELIMIT.get(rlKey);
    const c = Math.max(0, (parseInt(raw ?? '0', 10)) - 1);
    await env.RATELIMIT.put(rlKey, String(c));
  } catch {
    // Refund failure shouldn't crash the response path.
  }
}

/**
 * Short hex digest for log fingerprinting without leaking raw content.
 * Used when logging malformed LLM output that may contain user PII.
 */
async function sha256Short(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generate a random waitlist token (48 hex chars = 192 bits of entropy).
 * Used to identify waitlist members on subsequent /analyze calls so they
 * get the promo limit instead of the free-tier limit. Not a secret in
 * the auth sense — it's just an abuse-resistant "I'm on the list" badge.
 */
function generateWlToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Look up a waitlist token in KV. Returns true if the token exists
 * (i.e. belongs to a real waitlist member). Tokens are stored under
 * `wl:{token}` on signup. They never expire — the promo ends when iOS
 * launches and we stop accepting new tokens, but existing ones keep
 * working until accounts replace them.
 */
async function isValidWlToken(env: Env, token: string): Promise<boolean> {
  if (!token || token.length !== 48) return false;
  const val = await env.WAITLIST.get(`wl:${token}`);
  return val !== null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin');

    // ── CORS preflight ──────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: buildCorsHeaders(origin) });
    }

    // ── Hard-reject bad origins BEFORE doing any work ───────────
    // Why: returning no ACAO header only blocks the browser from
    // READING the response — the request still runs, calls Groq,
    // writes to KV, and burns our quota. A malicious page can fire
    // many no-cors POSTs and silently drain us. So we 403 here for
    // any non-allowlisted origin when one is present.
    // (We allow missing Origin so curl/native apps still work.)
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return new Response(JSON.stringify({ error: 'forbidden origin' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', Vary: 'Origin' },
      });
    }

    const corsHeaders = buildCorsHeaders(origin);

    // Top-level catcher so Cloudflare never shows a raw 1101. We log only
    // a generic message — never raw error details that could leak internals
    // (KV keys, env var names, file paths) to a potential attacker.
    try {
      return await handleRequest(request, env, corsHeaders);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Log full error server-side (Cloudflare dashboard), return generic
      // to client. Avoid echoing stack traces.
      console.error('Worker error:', msg);
      return new Response(
        JSON.stringify({ error: 'internal error' }),
        { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } },
      );
    }
  },
};

async function handleRequest(
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>,
): Promise<Response> {

    if (!env.GROQ_API_KEY) {
      return new Response(JSON.stringify({ error: 'Groq API key not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    const url = new URL(request.url);

    // ── Route: /admin (Basic Auth) ──────────────────────────────
    // Returns waitlist entries as JSON for the admin dashboard.
    // Auth uses HTTP Basic over HTTPS (Cloudflare always terminates TLS).
    // Credentials come from env secrets — never from source. If the
    // secrets aren't set, we return 401 forever (fail-closed).
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
      return handleAdmin(request, env, corsHeaders);
    }

    // ── Route: /reset (self-service rate-limit reset) ───────────
    // Clears the caller's daily AI-sort counter so they can get 5 more
    // free sorts. Triggered by typing "reset1010" in the app, which also
    // wipes local storage + shows the welcome screen.
    //
    // Why we allow this: Groq's free tier is the real ceiling (30 RPM
    // shared globally). The per-IP daily counter is just UX polish. If
    // someone wants to spam /reset to get unlimited sorts, they still
    // hit Groq's RPM ceiling fast — and they're a single user, not
    // scalable abuse.
    //
    // Code-gated ({code: 'reset1010'}) so random POSTs don't trigger it.
    // The code is also in the client bundle, so this isn't real security
    // — it just prevents accidental resets from random traffic.
    if (url.pathname === '/reset') {
      let body: { code?: string };
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: 'invalid JSON' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
      if (body.code !== 'reset1010') {
        // Return the same shape as a successful reset so the endpoint
        // doesn't leak whether the code was wrong (mild obfuscation).
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
      const resetIp = getClientIp(request);
      const resetTodayKey = new Date().toISOString().slice(0, 10);
      const resetRlKey = `rl:${resetIp}:${resetTodayKey}`;
      await env.RATELIMIT.delete(resetRlKey);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // ── Route: /waitlist ─────────────────────────────────────────
    // Accepts { email } → stores in KV keyed by normalized email.
    // Idempotent: re-submitting the same email returns ok without duplicating.
    if (url.pathname === '/waitlist') {
      if (request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'POST only' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      let email: string | undefined;
      try {
        const body = await request.json() as { email?: string };
        email = body.email;
      } catch {
        return new Response(JSON.stringify({ error: 'invalid JSON' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      // Email validation — RFC 5322 simplified. Catches the obvious junk
      // (missing @, no domain dot, spaces, control chars) without being
      // so strict that we reject valid edge cases. Anything that passes
      // this regex AND delivers to a real inbox is good enough for a waitlist.
      const normalized = (email ?? '').toLowerCase().trim();
      const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;
      if (!normalized || !EMAIL_RE.test(normalized) || normalized.length > 320) {
        return new Response(JSON.stringify({ error: 'valid email required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      // ── Per-IP rate limit on waitlist signups ─────────────────
      // Without this, someone could script thousands of fake emails and
      // fill our KV with garbage. 5 signups per IP per hour is plenty for
      // a real human (typo-retries, multiple emails) but blocks flooding.
      // Uses a separate key prefix so it doesn't collide with /analyze counters.
      const wlIp = getClientIp(request);
      const wlHourKey = `wl-rl:${wlIp}:${Math.floor(Date.now() / 3_600_000)}`; // bucket = hour
      const wlCount = parseInt((await env.RATELIMIT.get(wlHourKey)) ?? '0', 10);
      if (wlCount >= 5) {
        return new Response(JSON.stringify({
          error: 'too_many_signups',
          message: 'Too many signups from this IP. Try again in an hour.',
        }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '3600', ...corsHeaders },
        });
      }
      const wlNext = wlCount + 1;
      if (wlCount === 0) {
        // TTL: 2 hours so the bucket expires after the rate-limit window.
        await env.RATELIMIT.put(wlHourKey, String(wlNext), { expirationTtl: 7200 });
      } else {
        await env.RATELIMIT.put(wlHourKey, String(wlNext));
      }

      // Check if already on the list. Return the SAME response shape
      // whether the email is new or existing — otherwise this endpoint
      // becomes an email-membership oracle (anyone can probe whether a
      // specific address is signed up). The landing page doesn't need
      // the `already` flag; it shows a generic success either way.
      const existing = await env.WAITLIST.get(`email:${normalized}`);
      if (!existing) {
        // Privacy minimization: store only email + timestamp.
        await env.WAITLIST.put(
          `email:${normalized}`,
          JSON.stringify({
            email: normalized,
            at: new Date().toISOString(),
          }),
        );
      }

      // ── Generate a waitlist promo token ──────────────────────
      // The client stores this and sends it with every /analyze call.
      // If valid, the worker applies the promo limit (100/day) instead
      // of the free-tier limit (10/day). Always generate a fresh token
      // on each signup request — if someone re-submits the same email
      // (new device, cleared storage) they get a new working token.
      // Old tokens remain valid.
      const wlToken = generateWlToken();
      await env.WAITLIST.put(`wl:${wlToken}`, normalized, { expirationTtl: 60 * 60 * 24 * 365 });

      return new Response(JSON.stringify({ ok: true, token: wlToken }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // ── Route: /transcribe ──────────────────────────────────────
    if (url.pathname === '/transcribe') {
      // ── Per-IP daily cap on transcriptions ─────────────────────
      // Whisper is more expensive than /analyze (audio vs text) so we
      // share the same daily bucket. Waitlist token holders get the
      // promo limit, same as /analyze.
      const tIp = getClientIp(request);
      const tTodayKey = new Date().toISOString().slice(0, 10);
      const tWlToken = request.headers.get('X-WL-Token') ?? '';
      const tHasWlToken = tWlToken ? await isValidWlToken(env, tWlToken) : false;
      const tRlKey = tHasWlToken ? `rl-wl:${tWlToken}:${tTodayKey}` : `rl:${tIp}:${tTodayKey}`;
      const tEffectiveLimit = tHasWlToken ? WL_PROMO_DAILY_LIMIT : FREE_TIER_DAILY_LIMIT_GLOBAL;
      const tCurrent = parseInt((await env.RATELIMIT.get(tRlKey)) ?? '0', 10);
      if (tCurrent >= tEffectiveLimit) {
        return new Response(JSON.stringify({
          error: 'rate_limited',
          message: `That's all ${tEffectiveLimit} for today. Try again tomorrow.`,
          limit: tEffectiveLimit,
          used: tCurrent,
        }), {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': '86400',
            ...corsHeaders,
          },
        });
      }

      // formData() throws on: empty body, wrong Content-Type, malformed
      // multipart. Without this catch the worker returns 500 (top-level
      // catcher), which is misleading — 400 tells the client they sent
      // something wrong, not that we crashed.
      let formData: FormData;
      try {
        formData = await request.formData();
      } catch {
        return new Response(JSON.stringify({
          error: 'invalid form data',
          message: 'Expected multipart/form-data with a "file" field.',
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
      const file = formData.get('file');
      if (!file || !(file instanceof File)) {
        return new Response(JSON.stringify({ error: 'file is required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      // ── File validation: type + size ───────────────────────────
      // Without this, anyone can upload any file type (executable, image,
      // huge binary) and we'd forward it to Groq. Groq would reject it,
      // but the upload itself costs us bandwidth + worker CPU time.
      // 25MB matches Whisper's own limit and is ~30 minutes of audio.
      const ALLOWED_AUDIO = new Set([
        'audio/mp4', 'audio/m4a', 'audio/x-m4a',
        'audio/webm', 'audio/wav', 'audio/x-wav',
        'audio/mpeg', 'audio/mp3', 'audio/ogg',
        'audio/flac', 'audio/aac',
      ]);
      // File.type can be empty or unreliable when uploaded from RN — also
      // accept based on extension as a fallback.
      const ext = file.name.toLowerCase().split('.').pop() ?? '';
      const ALLOWED_EXT = new Set(['mp4', 'm4a', 'webm', 'wav', 'mp3', 'ogg', 'flac', 'aac']);
      const typeOk = ALLOWED_AUDIO.has(file.type) || file.type === '' && ALLOWED_EXT.has(ext);
      if (!typeOk) {
        return new Response(JSON.stringify({
          error: 'unsupported file type',
          message: 'Only audio files (mp3, m4a, wav, webm, etc.) are accepted.',
          gotType: file.type || ext,
        }), {
          status: 415,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25 MB
      if (file.size > MAX_AUDIO_BYTES) {
        return new Response(JSON.stringify({
          error: 'file too large',
          message: `Max ${Math.round(MAX_AUDIO_BYTES / 1024 / 1024)}MB. Yours is ${Math.round(file.size / 1024 / 1024)}MB.`,
        }), {
          status: 413,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      // Reserve the shared daily slot BEFORE the expensive Groq call
      // (same pattern as /analyze — refund on infra-side failure).
      if (tHasWlToken) {
        await bumpCounterKey(env, tRlKey, tCurrent);
      } else {
        await bumpDailyCounter(env, tIp, tCurrent);
      }

      const groqForm = new FormData();
      groqForm.append('model', 'whisper-large-v3');
      groqForm.append('file', file);

      const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
        body: groqForm,
      });

      if (!groqRes.ok) {
        // Refund the slot on any Groq-side failure.
        if (tHasWlToken) await refundWlCounter(env, tWlToken); else await refundDailyCounter(env, tIp);
        if (groqRes.status === 429) {
          return new Response(JSON.stringify({
            error: 'ai_busy',
            message: 'AI is busy right now. Try again in a minute.',
          }), {
            status: 503,
            headers: { 'Content-Type': 'application/json', 'Retry-After': '60', ...corsHeaders },
          });
        }
        console.error('Groq Whisper error status:', groqRes.status);
        return new Response(JSON.stringify({
          error: 'transcription_failed',
          message: 'Transcription service is having issues. Try again.',
        }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      const data = await groqRes.json() as { text?: string };
      return new Response(JSON.stringify({ text: data.text ?? '' }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // ── Route: /analyze ──────────────────────────────────────────
    // Explicit path + method check. Without this, ANY POST to an
    // unmatched path with a JSON body would fall through into the
    // analyze logic and trigger a Groq call — widening the public
    // attack surface and making abuse monitoring harder.
    if (url.pathname !== '/analyze' || request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // ── Free-tier rate limit: 5 analyzes/day per IP ───────────────
    // Key format: `rl:{ip}:{YYYY-MM-DD}` → count string.
    // TTL: 48h so stale day buckets clean themselves up.
    // Returns 429 with a friendly message when over quota.
    // Client-side localStorage gate exists too — this catches users who
    // clear storage to bypass the limit.
    //
    // ── Count BEFORE the Groq call (not after) ────────────────────
    // Previously the counter was incremented only on success, so a
    // malicious prompt that forces malformed JSON could burn Groq
    // quota without ever consuming the user's daily slots. We now
    // increment optimistically BEFORE the call and refund the slot
    // only on infrastructure failures (Groq 5xx / network errors) —
    // NOT on malformed model output (which is almost always either a
    // prompt-injection attempt or a real model limitation, both of
    // which legitimately consumed Groq resources).
    // ── Rate limit: free 10/day, waitlist promo 100/day ─────────
    // If the request carries a valid waitlist token (X-WL-Token header),
    // use the promo limit instead of the free limit. The token is
    // generated on /waitlist signup and stored client-side.
    const ip = getClientIp(request);
    const todayKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
    const wlTokenRaw = request.headers.get('X-WL-Token') ?? '';
    const hasWlToken = wlTokenRaw ? await isValidWlToken(env, wlTokenRaw) : false;

    // Token holders get their OWN rate-limit key (per-token, not per-IP)
    // so their promo doesn't collide with the IP-based free counter.
    const rlKey = hasWlToken
      ? `rl-wl:${wlTokenRaw}:${todayKey}`
      : `rl:${ip}:${todayKey}`;
    const effectiveLimit = hasWlToken ? WL_PROMO_DAILY_LIMIT : FREE_TIER_DAILY_LIMIT_GLOBAL;
    const current = parseInt((await env.RATELIMIT.get(rlKey)) ?? '0', 10);
    if (current >= effectiveLimit) {
      return new Response(JSON.stringify({
        error: 'rate_limited',
        message: `That's all ${effectiveLimit} for today. Try again tomorrow.`,
        limit: effectiveLimit,
        used: current,
      }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': '86400',
          ...corsHeaders,
        },
      });
    }

    // Reserve the slot up-front. Token holders bump the token-keyed
    // counter; free users bump the IP-keyed counter.
    if (hasWlToken) {
      await bumpCounterKey(env, rlKey, current);
    } else {
      await bumpDailyCounter(env, ip, current);
    }

    const body = await request.json() as { text?: string; timezoneOffset?: number; reminders?: { id: string; title: string }[] };
    const { text, timezoneOffset, reminders } = body;
    if (!text || text.trim().length === 0) {
      return new Response(JSON.stringify({ error: 'text is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
    // ── Input length cap (DoS protection) ───────────────────────
    // Without this, someone could send 10MB of text and we'd forward it
    // to Groq — burning tokens + timing out. 10k chars is ~2k tokens,
    // plenty for any brain-dump; longer inputs are almost certainly abuse.
    // The client-side TextInput has no max length, so this is the only
    // gate.
    const MAX_NOTE_LENGTH = 10_000;
    if (text.length > MAX_NOTE_LENGTH) {
      return new Response(JSON.stringify({
        error: 'note too long',
        message: `Max ${MAX_NOTE_LENGTH} characters per note.`,
        limit: MAX_NOTE_LENGTH,
      }), {
        status: 413,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // ── timezoneOffset bounds check ─────────────────────────────
    // Valid timezone offsets are -12:00 to +14:00 = -720 to +840 min.
    // Anything else is garbage or abuse.
    const offset = Math.max(-840, Math.min(840, Number(timezoneOffset ?? 0) || 0));
    const now = new Date();
    const localNow = formatLocal(now, offset);
    const localTz = `UTC${offset >= 0 ? '+' : '-'}${String(Math.abs(offset) / 60).padStart(2, '0')}:00`;

    // Compute next Friday (used in the prompt examples) — must exist before the
    // systemPrompt template literal is built, or every request will throw
    // ReferenceError: nextFriday is not defined.
    const todayDay = now.getDay(); // 0=Sun … 6=Sat
    const daysUntilFriday = (5 - todayDay + 7) % 7 || 7; // next Friday (not today)
    const nextFridayDate = new Date(now.getTime() + daysUntilFriday * 24 * 60 * 60 * 1000);
    const nextFriday = `${nextFridayDate.getFullYear()}-${String(nextFridayDate.getMonth() + 1).padStart(2, '0')}-${String(nextFridayDate.getDate()).padStart(2, '0')}`;

    const remindersContext = reminders && reminders.length > 0
      ? `\n\nYour existing reminders (title → id):\n${reminders.map((r) => `- "${r.title}" (id: ${r.id})`).join('\n')}`
      : '\n\nYou have no existing reminders.';

    const systemPrompt = `You are a note analyzer for a reminder app. Given a user's raw note text, extract:

1. A short title (max 6 words)
2. Does this need a reminder? (ANY mention of a task, errand, todo, event, appointment, or thing to remember)
3. If yes: the exact datetime (ISO 8601, NO timezone suffix) and recurrence pattern

Current local time (${localTz}): ${localNow}

Existing reminders for context:${remindersContext}

Return ONLY valid JSON — no markdown, no explanation:
{
  "action": "create" | "modify" | "skip" | "delete" | "none",
  "title": "short title",
  "needsReminder": true/false,
  "reminder": null or {
    "datetime": "ISO 8601 string (no timezone suffix, use local time)",
    "recurring": "none" | "daily" | "weekly" | "monthly",
    "daysOfWeek": null or [0,1,2,3,4,5,6],
    "remindBeforeMinutes": null or number
  },
  "targetReminderTitle": null or "title of reminder to modify/delete/skip",
  "modify": null or { "title": "...", "datetime": "...", "recurring": "...", "daysOfWeek": [...], "remindBeforeMinutes": ... }
}

Rules:
- datetime MUST NOT include Z or any timezone suffix — return plain local time like "${localNow.slice(0, 10)}T18:00:00"
- If time is implied but not given (e.g. "tomorrow"): assume 12pm (noon) local
- recurring: "daily" = every day, "weekly" = same weekday(s), "monthly" = same day each month
- daysOfWeek: ONLY use for multi-day weekly patterns (0=Sun … 6=Sat). If only one day, set to null.
- remindBeforeMinutes: How many minutes BEFORE the event to send a heads-up. ALSO sends at event time. Examples:
  - Flight/airport/train: 120 (2 hours before)
  - Gym/workout class: 10
  - Meeting/appointment: 15
  - Birthday/event: 0 (at event time only, no early reminder)
  - Daily task (water plants, pills): 0
  If unsure, default to 0. Only set if user would reasonably need prep time.

=== ACTION RULES (choose the right one) ===
- "create" — user wants a NEW reminder. Fill reminder. Set targetReminderTitle and modify to null.
- "modify" — user wants to CHANGE an existing reminder (e.g. "change gym to 10am", "move swimming to tomorrow"). Set targetReminderTitle to the reminder's title. Fill in modify with only the fields that changed.
- "skip" — user wants to SILENCE a recurring reminder for today only (e.g. "skip gym today", "i got sick", "taking a break from gym"). Set targetReminderTitle. Set reminder to null.
- "delete" — user wants to REMOVE a reminder entirely (e.g. "swimming was cancelled", "remove gym"). Set targetReminderTitle. Set reminder to null.
- "none" — purely informational, no reminder action needed. Set needsReminder to false.

=== MATCHING LOGIC ===
Match the user's text to an existing reminder by KEYWORD in the title. E.g., "gym" matches "go to gym mon wed fri", "swimming" matches "swimming lesson". If no match found, default to "create" action.

=== EXAMPLES ===
- "buy milk" → {"action":"create","title":"buy milk","needsReminder":true,"reminder":{"datetime":"${localNow.slice(0, 10)}T12:00:00","recurring":"none","daysOfWeek":null,"remindBeforeMinutes":0},"targetReminderTitle":null,"modify":null}
- "go to gym mon wed fri at 6pm" → {"action":"create","title":"go to gym","needsReminder":true,"reminder":{"datetime":"${localNow.slice(0, 10)}T18:00:00","recurring":"weekly","daysOfWeek":[1,3,5],"remindBeforeMinutes":10},"targetReminderTitle":null,"modify":null}
- "flight to singapore on friday at 8am" → {"action":"create","title":"flight to Singapore","needsReminder":true,"reminder":{"datetime":"${nextFriday}T08:00:00","recurring":"none","daysOfWeek":null,"remindBeforeMinutes":120},"targetReminderTitle":null,"modify":null}
- "skip gym today I'm sick" → {"action":"skip","title":"skip gym","needsReminder":true,"reminder":null,"targetReminderTitle":"go to gym","modify":null}  
- "swimming was cancelled" → {"action":"delete","title":"swimming cancelled","needsReminder":false,"reminder":null,"targetReminderTitle":"swimming","modify":null}
- "move gym to 10am instead" → {"action":"modify","title":"move gym","needsReminder":true,"reminder":null,"targetReminderTitle":"go to gym","modify":{"datetime":"${localNow.slice(0, 10)}T10:00:00"}}
- Only set needsReminder to false for purely informational notes with no action needed
- When in doubt, SET needsReminder to true — it's better to over-create than miss one`;

    const userPrompt = `Analyze this note:\n\n${text}`;

    try {
      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.1,
          max_tokens: 600,
        }),
      });

      // ── Groq rate-limited (free tier 30 RPM shared globally) ───
      // Return a distinct error code so the client can show "AI is busy,
      // try again in a minute" instead of looking broken. Refund the
      // slot — this is an infrastructure capacity issue, not the user's
      // fault, and they didn't get a result.
      if (groqRes.status === 429) {
        if (hasWlToken) await refundWlCounter(env, wlTokenRaw); else await refundDailyCounter(env, ip);
        return new Response(JSON.stringify({
          error: 'ai_busy',
          message: 'AI is busy right now. Try again in a minute.',
        }), {
          status: 503,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '60', ...corsHeaders },
        });
      }

      if (!groqRes.ok) {
        // Other Groq error (5xx etc) — also refund. Log only the
        // status + first 200 chars server-side; never log the raw
        // request body or user-supplied text.
        const errBody = await groqRes.text();
        console.error('Groq /analyze error:', groqRes.status, errBody.slice(0, 200));
        if (hasWlToken) await refundWlCounter(env, wlTokenRaw); else await refundDailyCounter(env, ip);
        return new Response(JSON.stringify({
          error: 'ai_error',
          message: 'AI service is having issues. Try again.',
        }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      const data = await groqRes.json() as { choices?: { message?: { content?: string } }[] };
      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        // Empty response — refund (Groq returned nothing usable).
        if (hasWlToken) await refundWlCounter(env, wlTokenRaw); else await refundDailyCounter(env, ip);
        return new Response(JSON.stringify({
          error: 'ai_empty',
          message: 'AI returned an empty response. Try again.',
        }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      // Try to parse — the LLM might wrap in ```json
      let json = content;
      if (content.includes('```')) {
        const match = content.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
        if (match) json = match[1];
      }

      let result: AnalyzeResponse;
      try {
        result = JSON.parse(json);
      } catch {
        // Malformed JSON. Do NOT refund — the model was invoked and
        // produced output, which consumed real Groq quota. Almost
        // always this is either a prompt-injection attempt ("return
        // invalid JSON") or a genuine model failure; both consumed
        // Groq resources. Log a short hash only, never raw content
        // (which may contain user PII).
        const contentHash = await sha256Short(json);
        console.error('Groq returned malformed JSON (hash=' + contentHash + ', len=' + json.length + ')');
        return new Response(JSON.stringify({
          error: 'ai_parse_error',
          message: 'AI response was malformed. Try again.',
        }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      // ── SUCCESS — slot was already reserved before the call ──
      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    } catch (err) {
      // Catch-all for unexpected errors (network, etc). Don't leak details.
      console.error('Analyze unexpected error:', err instanceof Error ? err.message : String(err));
      return new Response(JSON.stringify({
        error: 'internal_error',
        message: 'Something went wrong. Try again.',
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
}

// ── Admin handler ───────────────────────────────────────────────
// Serves internal endpoints for the waitlist dashboard. All paths under
// /admin require HTTP Basic Auth with credentials stored in env secrets.
//
// Endpoints:
//   GET /admin/waitlist  → { count, entries: [{ email, at, ua, ref }] }
//   GET /admin/health    → { ok: true }  (auth check, no KV read)
//   anything else        → 404
//
// Why Basic Auth: the admin.html page runs in the browser and needs a
// stateless auth mechanism that works with fetch(). We could do a cookie
// flow, but Basic over HTTPS is simpler, well-understood, and impossible
// to get wrong with CSRF. Credentials live in Cloudflare secrets.
//
// CORS: admin endpoints intentionally return NO ACAO header. The dashboard
// on mono-log-web.vercel.app could read it via CORS, but for now we keep
// the admin page server-rendered (worker returns HTML) so there's no
// cross-origin request at all — admin.html is opened directly from the
// worker URL. This is simpler and avoids exposing the endpoint via CORS.
async function handleAdmin(
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  // Security headers applied to ALL admin responses. The admin page
  // shows waitlist emails, so we want defense-in-depth even though
  // Cloudflare already terminates TLS and the page is Basic-Auth-gated.
  const securityHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
  };

  // Fail-closed: if secrets aren't set, refuse all access.
  if (!env.ADMIN_USER || !env.ADMIN_PASS) {
    return new Response(JSON.stringify({ error: 'admin not configured' }), {
      status: 500,
      headers: securityHeaders,
    });
  }

  // ── Brute-force rate limit: 10 failed attempts per IP per hour ──
  // Without this, an attacker can hammer /admin with Basic Auth
  // guesses. The admin password is the only barrier to the waitlist,
  // so we add a per-IP failure lockout. Successful auth clears the
  // counter. Key: `adm-rl:{ip}:{hour-bucket}`. TTL 2h.
  const aIp = getClientIp(request);
  const aHourKey = `adm-rl:${aIp}:${Math.floor(Date.now() / 3_600_000)}`;
  const aFails = parseInt((await env.RATELIMIT.get(aHourKey)) ?? '0', 10);
  if (aFails >= 10) {
    return new Response(JSON.stringify({ error: 'too_many_attempts' }), {
      status: 429,
      headers: { ...securityHeaders, 'Retry-After': '3600' },
    });
  }

  // Validate Basic Auth header.
  const authHeader = request.headers.get('Authorization') ?? '';
  const match = authHeader.match(/^Basic\s+(.+)$/i);
  if (!match) {
    await registerAdminFailure(env, aHourKey, aFails);
    return unauthorizedResponse(securityHeaders);
  }

  let decoded: string;
  try {
    decoded = atob(match[1]);
  } catch {
    await registerAdminFailure(env, aHourKey, aFails);
    return unauthorizedResponse(securityHeaders);
  }

  // Decode is "user:pass". Use indexOf (not split) — passwords may contain ':'.
  const colonIdx = decoded.indexOf(':');
  if (colonIdx === -1) {
    await registerAdminFailure(env, aHourKey, aFails);
    return unauthorizedResponse(securityHeaders);
  }
  const user = decoded.slice(0, colonIdx);
  const pass = decoded.slice(colonIdx + 1);

  // Constant-time-ish comparison to avoid trivial timing attacks.
  // Not a true constant-time impl but better than `===` on attacker-controlled input.
  if (!timingSafeEqual(user, env.ADMIN_USER) || !timingSafeEqual(pass, env.ADMIN_PASS)) {
    await registerAdminFailure(env, aHourKey, aFails);
    return unauthorizedResponse(securityHeaders);
  }

  // ── Successful auth: clear this IP's failure counter ──
  try { await env.RATELIMIT.delete(aHourKey); } catch {}

  const url = new URL(request.url);

  // GET /admin → serve the admin dashboard HTML.
  // We bundle it here so deployment is single-file (no separate asset upload).
  if (url.pathname === '/admin' && request.method === 'GET') {
    return new Response(ADMIN_HTML, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        // Strict CSP for the dashboard: no remote resources at all.
        'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
      },
    });
  }

  // GET /admin/health → simple auth check, no KV read.
  if (url.pathname === '/admin/health' && request.method === 'GET') {
    return new Response(JSON.stringify({ ok: true }), { headers: securityHeaders });
  }

  // GET /admin/waitlist → all entries from KV.
  if (url.pathname === '/admin/waitlist' && request.method === 'GET') {
    const list = await env.WAITLIST.list({ prefix: 'email:' });
    const entries: unknown[] = [];
    // list() returns keys+metadata but not values. Fetch values in parallel.
    // KV list returns up to 1000 keys per page — paginate if needed.
    let cursor: string | undefined;
    do {
      const page = await env.WAITLIST.list({ prefix: 'email:', cursor });
      const values = await Promise.all(
        page.keys.map(async (k) => {
          const raw = await env.WAITLIST.get(k.name);
          if (!raw) return null;
          try { return JSON.parse(raw); } catch { return null; }
        }),
      );
      for (const v of values) {
        if (v) entries.push(v);
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);

    // Sort newest-first by `at` timestamp if present.
    entries.sort((a, b) => {
      const atA = (a as { at?: string })?.at ?? '';
      const atB = (b as { at?: string })?.at ?? '';
      return atB.localeCompare(atA);
    });

    return new Response(JSON.stringify({ count: entries.length, entries }), {
      headers: securityHeaders,
    });
  }

  return new Response(JSON.stringify({ error: 'not found' }), {
    status: 404,
    headers: securityHeaders,
  });
}

/** Increment the admin-auth failure counter for an IP/hour bucket. */
async function registerAdminFailure(env: Env, hourKey: string, currentFails: number): Promise<void> {
  try {
    const next = currentFails + 1;
    if (currentFails === 0) {
      await env.RATELIMIT.put(hourKey, String(next), { expirationTtl: 7200 });
    } else {
      await env.RATELIMIT.put(hourKey, String(next));
    }
  } catch {
    // Rate-limit failures shouldn't block the auth path.
  }
}

function unauthorizedResponse(extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'WWW-Authenticate': 'Basic realm="monolog-admin"',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      ...extraHeaders,
    },
  });
}

// String compare that doesn't short-circuit on first mismatched byte.
// Length mismatch always returns false. Good enough for credential checks
// — not a true constant-time impl but raises the bar over `===`.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ── Admin dashboard HTML (embedded as a string) ─────────────────
// Plain HTML + CSS + vanilla JS — no build step, no React. Fetches
// /admin/waitlist with the Basic auth header the browser already has
// cached from this session. Charts are hand-rolled SVG/CSS in the
// bklit aesthetic (monospace, dark, minimal).
const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>monolog · admin</title>
<style>
  :root {
    --bg: #0a0a0a;
    --panel: #131313;
    --text: #e8e8e8;
    --dim: #777;
    --line: #1f1f1f;
    --accent: #fff;
    --mono: ui-monospace, "SF Mono", Menlo, Monaco, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--mono);
    margin: 0;
    padding: 32px 20px 80px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 920px; margin: 0 auto; }
  h1 {
    font-size: 14px; letter-spacing: 0.15em; text-transform: uppercase;
    color: var(--dim); margin: 0 0 4px; font-weight: 500;
  }
  h1 strong { color: var(--text); font-weight: 600; }
  .sub { color: var(--dim); font-size: 12px; margin-bottom: 32px; }
  .grid {
    display: grid; gap: 16px; margin-bottom: 32px;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  }
  .stat {
    border: 1px solid var(--line); padding: 16px 18px; background: var(--panel);
  }
  .stat .label {
    font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase;
    color: var(--dim); margin-bottom: 8px;
  }
  .stat .value { font-size: 28px; font-weight: 500; }
  .stat .delta { font-size: 11px; color: var(--dim); margin-top: 4px; }
  .chart-card {
    border: 1px solid var(--line); padding: 20px; background: var(--panel);
    margin-bottom: 16px;
  }
  .chart-title {
    font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase;
    color: var(--dim); margin-bottom: 16px;
  }
  .bars { display: flex; align-items: flex-end; gap: 4px; height: 100px; }
  .bar {
    flex: 1; background: var(--text); min-height: 2px;
    transition: height 0.3s ease;
  }
  .bar:hover { background: #fff; }
  .x-axis {
    display: flex; gap: 4px; margin-top: 8px;
    font-size: 10px; color: var(--dim);
  }
  .x-axis span { flex: 1; text-align: center; }
  table {
    width: 100%; border-collapse: collapse;
    font-size: 13px;
  }
  th, td {
    text-align: left; padding: 10px 12px;
    border-bottom: 1px solid var(--line);
  }
  th {
    color: var(--dim); font-weight: 500; font-size: 11px;
    letter-spacing: 0.08em; text-transform: uppercase;
  }
  td.email { color: var(--text); }
  td.date, td.ua { color: var(--dim); font-size: 11px; }
  tr:hover td { background: rgba(255,255,255,0.02); }
  .empty { color: var(--dim); padding: 32px; text-align: center; font-size: 12px; }
  .refresh {
    background: transparent; border: 1px solid var(--line); color: var(--text);
    font-family: var(--mono); font-size: 11px; letter-spacing: 0.08em;
    text-transform: uppercase; padding: 8px 14px; cursor: pointer;
  }
  .refresh:hover { border-color: var(--text); }
  .actions { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
  .err { color: #e66; font-size: 12px; padding: 16px; border: 1px solid #421; background: #1a0e0e; }
</style>
</head>
<body>
<div class="wrap">
  <h1>monolog · <strong>admin</strong></h1>
  <div class="sub" id="sub">loading…</div>

  <div class="grid">
    <div class="stat"><div class="label">total signups</div><div class="value" id="total">—</div><div class="delta" id="totalDelta"></div></div>
    <div class="stat"><div class="label">last 24h</div><div class="value" id="last24">—</div></div>
    <div class="stat"><div class="label">last 7d</div><div class="value" id="last7">—</div></div>
    <div class="stat"><div class="label">avg/day (7d)</div><div class="value" id="avg">—</div></div>
  </div>

  <div class="chart-card">
    <div class="chart-title">signups · last 14 days</div>
    <div class="bars" id="bars"></div>
    <div class="x-axis" id="xaxis"></div>
  </div>

  <div class="actions">
    <div class="chart-title" style="margin: 0;">all signups</div>
    <button class="refresh" id="refreshBtn">refresh</button>
  </div>
  <div id="table-wrap"></div>
</div>

<script>
  async function load() {
    try {
      const res = await fetch('/admin/waitlist', { credentials: 'include' });
      if (res.status === 401) {
        document.getElementById('sub').textContent = 'unauthorized — close this tab and re-open with the auth URL';
        return;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      render(data.entries || []);
    } catch (e) {
      // Use textContent instead of innerHTML for error rendering —
      // e.message is browser-generated so it's safe, but textContent
      // is the right pattern and removes any future XSS risk if the
      // error source ever changes.
      const wrap = document.getElementById('table-wrap');
      wrap.textContent = 'failed to load: ' + (e.message || e);
      wrap.className = 'err';
    }
  }

  function dayKey(iso) {
    return new Date(iso).toISOString().slice(0, 10);
  }

  function render(entries) {
    const now = new Date();
    const cutoff24 = now.getTime() - 24 * 3600 * 1000;
    const cutoff7 = now.getTime() - 7 * 24 * 3600 * 1000;

    const total = entries.length;
    const last24 = entries.filter(e => new Date(e.at).getTime() >= cutoff24).length;
    const last7 = entries.filter(e => new Date(e.at).getTime() >= cutoff7).length;

    document.getElementById('total').textContent = total.toLocaleString();
    document.getElementById('last24').textContent = last24.toLocaleString();
    document.getElementById('last7').textContent = last7.toLocaleString();
    document.getElementById('avg').textContent = (last7 / 7).toFixed(1);

    const newest = entries[0]?.at;
    document.getElementById('sub').textContent = newest
      ? 'updated ' + new Date().toLocaleTimeString() + ' · newest ' + new Date(newest).toLocaleString()
      : 'no signups yet';

    // 14-day bar chart
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 24 * 3600 * 1000);
      const key = d.toISOString().slice(0, 10);
      const count = entries.filter(e => dayKey(e.at) === key).length;
      days.push({ key, count, label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) });
    }
    const max = Math.max(1, ...days.map(d => d.count));
    document.getElementById('bars').innerHTML = days.map(d =>
      '<div class="bar" style="height: ' + (d.count / max * 100) + '%; background: ' + (d.count === 0 ? '#222' : '#e8e8e8') + ';" title="' + d.count + ' on ' + d.label + '"></div>'
    ).join('');
    document.getElementById('xaxis').innerHTML = days.map(d => '<span>' + d.label.split(' ')[1] + '</span>').join('');

    // Table
    const wrap = document.getElementById('table-wrap');
    if (entries.length === 0) {
      wrap.innerHTML = '<div class="empty">no signups yet</div>';
      return;
    }
    let rows = '';
    for (const e of entries) {
      const email = escapeHtml(e.email || '');
      const date = e.at ? new Date(e.at).toLocaleString() : '—';
      rows += '<tr><td class="email">' + email + '</td><td class="date">' + date + '</td></tr>';
    }
    wrap.innerHTML = '<table><thead><tr><th>email</th><th>signed up</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  document.getElementById('refreshBtn').addEventListener('click', load);
  load();
</script>
</body>
</html>`;
