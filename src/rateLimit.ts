import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Free-tier rate limit — matches the worker's FREE_TIER_DAILY_LIMIT.
 * Change in both places if you bump it.
 */
export const FREE_TIER_DAILY_LIMIT = 10;

/**
 * Paid-tier daily cap. Scaffolding — not enforced client-side until
 * the app knows the user is paid (post-Stripe). Mirrors the worker's
 * PAID_TIER_DAILY_LIMIT.
 */
export const PAID_TIER_DAILY_LIMIT = 100;

// ── Waitlist promo token ─────────────────────────────────────────
// When a user joins the waitlist, the worker returns a token. The
// client stores it here and sends it with every /analyze request.
// Token holders get 100/day instead of 10/day — effectively unlimited
// until the iOS app launches and paid tiers take over.
const WL_TOKEN_KEY = 'monolog.wl.token';

/** Returns the stored waitlist token, or null if the user hasn't joined. */
export async function getWlToken(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(WL_TOKEN_KEY);
  } catch {
    return null;
  }
}

/** Stores the waitlist token returned by /waitlist. */
export async function setWlToken(token: string): Promise<void> {
  try {
    await AsyncStorage.setItem(WL_TOKEN_KEY, token);
  } catch {
    // Storage failure shouldn't block the user.
  }
}

/** Returns true if the user has a waitlist token (= unlimited sorting). */
export async function isUnlimited(): Promise<boolean> {
  return (await getWlToken()) !== null;
}

/**
 * Daily free-tier counter for AI sorts.
 * Stored in AsyncStorage as a tiny JSON blob: { date, used }.
 *
 *  - `date` is the local YYYY-MM-DD string. If the stored date doesn't
 *    match today, the counter resets to 0 — this handles "try again
 *    tomorrow" without needing a backend round-trip.
 *  - `used` is how many sorts have been used today.
 *
 * The Cloudflare Worker ALSO enforces this limit by IP (see worker/src/index.ts),
 * so clearing AsyncStorage doesn't bypass it — the worker will return 429
 * with `error: 'rate_limited'`. The client-side check is purely for UX
 * (instant feedback, no network round-trip when you're already over).
 */

const STORAGE_KEY = 'monolog.ratelimit.v1';

interface StoredCount {
  date: string; // YYYY-MM-DD (local)
  used: number;
}

function todayString(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Returns the current {date, used} count, or a fresh zero-state. */
async function readCount(): Promise<StoredCount> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return { date: todayString(), used: 0 };
    const parsed = JSON.parse(raw) as StoredCount;
    if (parsed.date !== todayString()) {
      // New day → reset.
      return { date: todayString(), used: 0 };
    }
    return parsed;
  } catch {
    return { date: todayString(), used: 0 };
  }
}

async function writeCount(count: StoredCount): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(count));
  } catch {
    // Storage failures shouldn't block the user.
  }
}

/** How many free sorts has the user used today (resets at local midnight). */
export async function getUsedToday(): Promise<number> {
  return (await readCount()).used;
}

/** How many free sorts are left today. Never negative. */
export async function getRemainingToday(): Promise<number> {
  return Math.max(0, FREE_TIER_DAILY_LIMIT - (await readCount()).used);
}

/**
 * Pre-flight check before sending a note to /analyze.
 * Returns true if the user is under their daily limit, false otherwise.
 * Use this to short-circuit the request and show a friendly upgrade prompt.
 */
export async function canSortMore(): Promise<boolean> {
  return (await getRemainingToday()) > 0;
}

/**
 * Increment today's counter by 1. Call this AFTER a successful /analyze
 * response (not before — if the request fails, the user shouldn't lose a slot).
 */
export async function recordSort(): Promise<void> {
  const c = await readCount();
  await writeCount({ date: c.date, used: c.used + 1 });
}

/**
 * Sync the local counter with the server's view after a 429.
 * The worker returns `used` in the rate-limited response — we trust it
 * over localStorage (the user may have cleared storage). If `serverUsed`
 * is provided, we overwrite the local count with it. Otherwise just
 * bump local by 1.
 */
export async function syncFromServer(serverUsed?: number): Promise<void> {
  const c = await readCount();
  const used = serverUsed ?? c.used + 1;
  await writeCount({ date: c.date, used });
}
