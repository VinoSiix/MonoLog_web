/**
 * Monolog Worker — bridges the app to Groq.
 * Single endpoint: POST /analyze
 * Takes a note → sends to llama-3.3-70b-versatile → returns structured reminder data.
 */

interface Env {
  GROQ_API_KEY: string;
  WAITLIST: KVNamespace;
  RATELIMIT: KVNamespace;
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const corsHeaders = buildCorsHeaders(request.headers.get('Origin'));

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'POST only' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

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

    // ── Route: /waitlist ─────────────────────────────────────────
    // Accepts { email } → stores in KV keyed by normalized email.
    // Idempotent: re-submitting the same email returns ok without duplicating.
    const url = new URL(request.url);
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
      const wlIp = request.headers.get('CF-Connecting-IP')
        ?? request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
        ?? 'unknown';
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

      // Check if already on the list.
      const existing = await env.WAITLIST.get(`email:${normalized}`);
      if (existing) {
        return new Response(JSON.stringify({ ok: true, already: true }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      await env.WAITLIST.put(
        `email:${normalized}`,
        JSON.stringify({
          email: normalized,
          at: new Date().toISOString(),
          ua: request.headers.get('user-agent') ?? '',
          ref: request.headers.get('referer') ?? '',
        }),
      );

      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // ── Route: /transcribe ──────────────────────────────────────
    if (url.pathname === '/transcribe') {
      const formData = await request.formData();
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

      const groqForm = new FormData();
      groqForm.append('model', 'whisper-large-v3');
      groqForm.append('file', file);

      const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
        body: groqForm,
      });

      if (!groqRes.ok) {
        const err = await groqRes.text();
        return new Response(JSON.stringify({ error: `Groq Whisper error: ${err}` }), {
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

    // ── Free-tier rate limit: 5 analyzes/day per IP ───────────────
    // Key format: `rl:{ip}:{YYYY-MM-DD}` → count string.
    // TTL: 48h so stale buckets clean themselves up.
    // Returns 429 with a friendly message when over quota.
    // Client-side localStorage gate exists too — this catches users who
    // clear storage to bypass the limit. KV is eventually-consistent so
    // a determined abuser could squeeze 1-2 extra requests in under
    // heavy concurrent load; that's an acceptable tradeoff for a free tier.
    const FREE_TIER_DAILY_LIMIT = 5;
    const ip = request.headers.get('CF-Connecting-IP')
      ?? request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
      ?? 'unknown';
    const todayKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
    const rlKey = `rl:${ip}:${todayKey}`;
    const current = parseInt((await env.RATELIMIT.get(rlKey)) ?? '0', 10);
    if (current >= FREE_TIER_DAILY_LIMIT) {
      return new Response(JSON.stringify({
        error: 'rate_limited',
        message: `Free tier limit reached (${FREE_TIER_DAILY_LIMIT}/day). Try again tomorrow or upgrade to Pro for unlimited.`,
        limit: FREE_TIER_DAILY_LIMIT,
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
    // Increment + set TTL (only on the first hit do we set the TTL — saves
    // a KV write on subsequent requests the same day).
    const next = current + 1;
    if (current === 0) {
      await env.RATELIMIT.put(rlKey, String(next), { expirationTtl: 60 * 60 * 48 });
    } else {
      await env.RATELIMIT.put(rlKey, String(next));
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

      if (!groqRes.ok) {
        const errBody = await groqRes.text();
        return new Response(JSON.stringify({ error: `Groq error: ${errBody}` }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      const data = await groqRes.json() as { choices?: { message?: { content?: string } }[] };
      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        return new Response(JSON.stringify({ error: 'Groq returned empty' }), {
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

      const result: AnalyzeResponse = JSON.parse(json);
      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
}
