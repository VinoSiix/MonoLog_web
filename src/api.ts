import type { AnalyzeResponse, Reminder } from './types';

/**
 * Backend URL for the Monolog Cloudflare Worker.
 */
const DEFAULT_BACKEND_URL = 'https://minnotes-worker.timppamsix.workers.dev';

// ── Response validation ─────────────────────────────────────────
// The worker returns whatever the LLM JSON.parse'd, which is technically
// `unknown`. We can't trust the LLM to always produce well-formed output
// (it occasionally wraps in markdown, drops a field, or hallucinates a
// weird enum value). This validates the shape before the caller sees it
// so the rest of the app can rely on the AnalyzeResponse type.
//
// If validation fails, we fall back to a safe "none" response — the note
// still saves as plain text, we just don't act on a half-formed reminder.
const VALID_ACTIONS = new Set(['create', 'modify', 'skip', 'delete', 'none']);
const VALID_RECURRING = new Set(['none', 'daily', 'weekly', 'monthly', 'yearly']);

function isStringArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'number');
}

function validateAnalyzeResponse(raw: unknown, fallbackTitle: string): AnalyzeResponse {
  // Safe default — never throws. The caller saves the note as plain text.
  const safe: AnalyzeResponse = {
    action: 'none',
    title: fallbackTitle,
    needsReminder: false,
    reminder: null,
  };
  if (typeof raw !== 'object' || raw === null) return safe;

  const r = raw as Record<string, unknown>;

  // action
  const action = typeof r.action === 'string' && VALID_ACTIONS.has(r.action)
    ? (r.action as AnalyzeResponse['action'])
    : 'none';

  // title — coerce to string, fall back if missing
  const title = typeof r.title === 'string' && r.title.trim().length > 0
    ? r.title.slice(0, 200)
    : fallbackTitle;

  // needsReminder — must be boolean
  const needsReminder = typeof r.needsReminder === 'boolean' ? r.needsReminder : false;

  // reminder — null is fine; if present, must be a well-formed object
  let reminder: AnalyzeResponse['reminder'] = null;
  if (r.reminder && typeof r.reminder === 'object') {
    const rem = r.reminder as Record<string, unknown>;
    const datetime = typeof rem.datetime === 'string' ? rem.datetime : '';
    // Non-null assertion safe here because we only enter this branch when
    // r.reminder is an object (checked above). TS narrowing doesn't carry
    // through to the indexed access, hence the explicit cast.
    type RecurringType = NonNullable<NonNullable<AnalyzeResponse['reminder']>['recurring']>;
    const recurring: RecurringType = typeof rem.recurring === 'string' && VALID_RECURRING.has(rem.recurring)
      ? (rem.recurring as RecurringType)
      : 'none';
    // Only keep the reminder if datetime is present and parses to a real date.
    // Otherwise the reminder would fire at epoch 0 or NaN — worse than no reminder.
    if (datetime) {
      const d = new Date(datetime);
      if (!isNaN(d.getTime())) {
        reminder = {
          datetime,
          recurring,
          daysOfWeek: isStringArray(rem.daysOfWeek) ? rem.daysOfWeek : undefined,
          remindBeforeMinutes:
            typeof rem.remindBeforeMinutes === 'number' && rem.remindBeforeMinutes >= 0
              ? Math.min(rem.remindBeforeMinutes, 1440) // cap at 24h
              : 0,
        };
      }
    }
  }

  const targetReminderTitle =
    typeof r.targetReminderTitle === 'string' && r.targetReminderTitle.length > 0
      ? r.targetReminderTitle
      : undefined;

  let modify: AnalyzeResponse['modify'] | undefined;
  if (r.modify && typeof r.modify === 'object') {
    const m = r.modify as Record<string, unknown>;
    modify = {};
    if (typeof m.title === 'string') modify.title = m.title.slice(0, 200);
    if (typeof m.datetime === 'string') {
      const d = new Date(m.datetime);
      if (!isNaN(d.getTime())) modify.datetime = m.datetime;
    }
    if (typeof m.recurring === 'string' && VALID_RECURRING.has(m.recurring)) {
      type ModifyRecurring = NonNullable<NonNullable<AnalyzeResponse['modify']>['recurring']>;
      modify.recurring = m.recurring as ModifyRecurring;
    }
    if (isStringArray(m.daysOfWeek)) modify.daysOfWeek = m.daysOfWeek;
    if (typeof m.remindBeforeMinutes === 'number' && m.remindBeforeMinutes >= 0) {
      modify.remindBeforeMinutes = Math.min(m.remindBeforeMinutes, 1440);
    }
  }

  return { action, title, needsReminder, reminder, targetReminderTitle, modify };
}

/**
 * Thrown when the worker returns 429 (free-tier daily limit reached).
 * Carries the worker's view of `used` so the client can sync localStorage.
 */
export class RateLimitError extends Error {
  used: number;
  limit: number;
  constructor(message: string, used: number, limit: number) {
    super(message);
    this.name = 'RateLimitError';
    this.used = used;
    this.limit = limit;
  }
}

/**
 * Thrown when the worker returns 503 (Groq rate-limited globally, shared
 * 30 RPM free tier). The user's daily quota is NOT consumed for this —
 * callers should keep the draft and show a "try again in a minute" message.
 */
export class AiBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiBusyError';
  }
}

/**
 * Send raw note text to the worker for analysis.
 * Optionally include existing reminders so the AI can detect modify/delete/skip intents.
 * Returns the AI-parsed result or throws on failure.
 *
 * Throws `RateLimitError` on 429 (free-tier limit reached) — callers should
 * catch this specifically and show an upgrade prompt instead of falling
 * back to a plain note.
 */
export async function analyzeNote(
  text: string,
  timezoneOffset?: number,
  backendUrl?: string,
  reminders?: Pick<Reminder, 'id' | 'title'>[],
): Promise<AnalyzeResponse> {
  const url = (backendUrl || DEFAULT_BACKEND_URL).replace(/\/+$/, '') + '/analyze';

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, timezoneOffset, reminders }),
  });

  if (res.status === 429) {
    // Free-tier daily limit hit. Surface as a typed error so callers can
    // distinguish "rate limited" from "server down" — both otherwise look
    // like generic fetch failures.
    let used = 0;
    let limit = 5;
    let message = 'Free tier limit reached.';
    try {
      const body = await res.json();
      used = body.used ?? 0;
      limit = body.limit ?? 5;
      message = body.message ?? message;
    } catch {}
    throw new RateLimitError(message, used, limit);
  }

  if (!res.ok) {
    // 503 = Groq shared free-tier rate limit hit (30 RPM globally).
    // User's daily quota is NOT consumed. Distinct from 429 (user quota).
    if (res.status === 503) {
      let message = 'AI is busy right now. Try again in a minute.';
      try {
        const body = await res.json();
        if (typeof body.message === 'string') message = body.message;
      } catch {}
      throw new AiBusyError(message);
    }
    const body = await res.text();
    throw new Error(`Backend error (${res.status}): ${body}`);
  }

  // Validate the response shape before trusting it. The worker forwards
  // the LLM's JSON as-is, which can be malformed (missing fields, wrong
  // enum values, garbage datetime). If validation fails, we return a
  // safe "none" action so the note still saves as plain text.
  const raw = await res.json();
  const titleFallback = text.trim().split('\n')[0].slice(0, 80) || 'Untitled';
  return validateAnalyzeResponse(raw, titleFallback);
}

/**
 * Send a recorded audio file to the worker for transcription via Groq Whisper.
 * Returns the transcribed text or throws on failure.
 */
export async function transcribeAudio(
  recordingUri: string,
  mimeType?: string,
  backendUrl?: string,
): Promise<string> {
  const url = (backendUrl || DEFAULT_BACKEND_URL).replace(/\/+$/, '') + '/transcribe';

  const fallbackType = mimeType ?? 'audio/mp4';
  const fallbackName = mimeType?.includes('webm') ? 'recording.webm' : 'recording.m4a';

  const formData = new FormData();
  formData.append('file', {
    uri: recordingUri,
    type: fallbackType,
    name: fallbackName,
  } as unknown as Blob);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      body: formData,
    });
  } catch (e: any) {
    // Surface the actual cause — RN wraps file-read failures in a generic
    // "Network request failed" which tells us nothing.
    throw new Error(
      `Could not upload recording. URI: ${recordingUri}. ${e?.message ?? e}`,
    );
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Transcription error (${res.status}): ${body}`);
  }

  const data = await res.json() as { text: string };
  return data.text;
}
