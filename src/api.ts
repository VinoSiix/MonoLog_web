import type { AnalyzeResponse } from './types';

/**
 * Backend URL for the MinNotes Cloudflare Worker.
 */
const DEFAULT_BACKEND_URL = 'https://minnotes-worker.glamorous-bus.workers.dev';

/**
 * Send raw note text to the worker for analysis.
 * Returns the AI-parsed result or throws on failure.
 */
export async function analyzeNote(
  text: string,
  timezoneOffset?: number,
  backendUrl?: string,
): Promise<AnalyzeResponse> {
  const url = (backendUrl || DEFAULT_BACKEND_URL).replace(/\/+$/, '') + '/analyze';

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, timezoneOffset }),
  });

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
  backendUrl?: string,
): Promise<string> {
  const url = (backendUrl || DEFAULT_BACKEND_URL).replace(/\/+$/, '') + '/transcribe';

  const formData = new FormData();
  formData.append('file', {
    uri: recordingUri,
    type: 'audio/mp4',
    name: 'recording.m4a',
  } as unknown as Blob);

  const res = await fetch(url, {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Transcription error (${res.status}): ${body}`);
  }

  const data = await res.json() as { text: string };
  return data.text;
}
