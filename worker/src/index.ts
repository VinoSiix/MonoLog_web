/**
 * Monolog Worker — bridges the app to Groq.
 * Single endpoint: POST /analyze
 * Takes a note → sends to llama-3.3-70b-versatile → returns structured reminder data.
 */

interface Env {
  GROQ_API_KEY: string;
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

    // Top-level catcher so Cloudflare never shows a raw 1101.
    try {
      return await handleRequest(request, env, corsHeaders);
    } catch (err) {
      return new Response(
        JSON.stringify({ error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }),
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
    const body = await request.json() as { text?: string; timezoneOffset?: number; reminders?: { id: string; title: string }[] };
    const { text, timezoneOffset, reminders } = body;
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
