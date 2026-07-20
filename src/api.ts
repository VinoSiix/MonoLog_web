import type { AnalyzeResponse, Reminder } from './types';

/**
 * Backend URL for the Monolog Cloudflare Worker.
 */
const DEFAULT_BACKEND_URL = 'https://minnotes-worker.timppamsix.workers.dev';

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
    const body = await res.text();
    throw new Error(`Backend error (${res.status}): ${body}`);
  }

  return res.json();
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
