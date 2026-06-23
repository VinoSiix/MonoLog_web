/**
 * MinNotes Worker — bridges the app to Groq.
 * Single endpoint: POST /analyze
 * Takes a note → sends to llama-3.3-70b-versatile → returns structured reminder data.
 */

interface Env {
  GROQ_API_KEY: string;
}

interface AnalyzeResponse {
  title: string;
  needsReminder: boolean;
  reminder: {
    datetime: string; // ISO 8601
    recurring: 'none' | 'daily' | 'weekly' | 'monthly';
  } | null;
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS — allow the Expo Go / local dev origin
    const origin = request.headers.get('Origin') ?? '';
    const corsHeaders = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'POST only' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    if (!env.GROQ_API_KEY) {
      return new Response(JSON.stringify({ error: 'Groq API key not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // ── Route: /transcribe ──────────────────────────────────────
    const url = new URL(request.url);
    if (url.pathname === '/transcribe') {
      const formData = await request.formData();
      const file = formData.get('file');
      if (!file || !(file instanceof File)) {
        return new Response(JSON.stringify({ error: 'file is required' }), {
          status: 400,
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
    const { text, timezoneOffset } = await request.json() as { text?: string; timezoneOffset?: number };
    if (!text || text.trim().length === 0) {
      return new Response(JSON.stringify({ error: 'text is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    const offset = timezoneOffset ?? 0;
    const now = new Date();
    const localNow = formatLocal(now, offset);
    const localTz = `UTC${offset >= 0 ? '+' : '-'}${String(Math.abs(offset) / 60).padStart(2, '0')}:00`;

    const systemPrompt = `You are a note analyzer for a reminder app. Given a user's raw note text, extract:

1. A short title (max 6 words)
2. Does this need a reminder? (ANY mention of a task, errand, todo, event, appointment, or thing to remember)
3. If yes: the exact datetime (ISO 8601, NO timezone suffix) and recurrence pattern

Current local time (${localTz}): ${localNow}

Return ONLY valid JSON — no markdown, no explanation:
{
  "title": "short title",
  "needsReminder": true/false,
  "reminder": null or {
    "datetime": "ISO 8601 string (no timezone suffix, use local time)",
    "recurring": "none" | "daily" | "weekly" | "monthly"
  }
}

Rules:
- datetime MUST NOT include Z or any timezone suffix — return plain local time like "${localNow.slice(0, 10)}T18:00:00"
- If time is implied but not given (e.g. "tomorrow"): assume 12pm (noon) local
- recurring: "daily" = every day, "weekly" = same weekday, "monthly" = same day each month
- CRITICAL: Nearly ANY actionable note qualifies for a reminder. Examples:
  - "buy milk" → reminder tomorrow at 12pm
  - "call dentist" → reminder tomorrow at 12pm
  - "meeting on Friday" → reminder this Friday at 12pm
  - "remember to water plants" → reminder daily at 9am
  - "mom's birthday" → reminder this year on that date at 9am
  - "submit homework by Monday" → reminder Monday at 9am
  - "pick up package" → reminder tomorrow at 12pm
- Only set needsReminder to false for purely informational notes with no action needed (e.g. "sky is blue", "I like pizza", random thoughts with no todo aspect)
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
          max_tokens: 300,
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
  },
};
