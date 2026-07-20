import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';

const IS_WEB = Platform.OS === 'web';

// Configure notification handler — always show banners + sound when app is in foreground.
// Skip on web (expo-notifications has no web implementation).
if (!IS_WEB) {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

/**
 * Request notification permissions (required on iOS).
 * On web: requests the browser Notification permission.
 * Returns true if granted.
 */
export async function requestPermissions(): Promise<boolean> {
  if (IS_WEB) {
    if (typeof Notification === 'undefined') return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    const result = await Notification.requestPermission();
    return result === 'granted';
  }

  const { status: existing } = await Notifications.getPermissionsAsync();
  if (existing === 'granted') return true;

  const { status } = await Notifications.requestPermissionsAsync();
  return status === 'granted';
}

/** Format time like "6:00 PM" */
function fmtTime(d: Date): string {
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

/**
 * On web: there is no native scheduler, so we keep an in-memory map of
 * timeouts keyed by a generated id. Reminders will only fire while the
 * tab is open — that's an accepted limitation of the web build.
 */
const webTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Schedule local notifications for a reminder.
 *
 * If remindBeforeMinutes > 0, TWO notifications are created:
 * 1. Early heads-up (fireAt - remindBeforeMinutes)
 * 2. On-time (fireAt)
 *
 * Returns pipe-separated groups of comma-separated IDs:
 *   "earlyId1,earlyId2|onTimeId1,onTimeId2"
 * When no early reminder, just comma-separated IDs (no pipe).
 */
export async function scheduleReminder(reminder: {
  title: string;
  fireAt: Date;
  recurring: 'none' | 'daily' | 'weekly' | 'monthly';
  daysOfWeek?: number[];
  remindBeforeMinutes?: number;
}): Promise<string> {
  // ── WEB PATH ─────────────────────────────────────────────────
  if (IS_WEB) {
    const ids: string[] = [];
    const earlyMin = reminder.remindBeforeMinutes ?? 0;

    const scheduleWebTimeout = (fireDate: Date, isEarly: boolean, dayLabel?: string): string => {
      const id = `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const delayMs = Math.max(0, fireDate.getTime() - Date.now());
      // Cap setTimeout delay to ~24 days (max for many browsers) — fine for our use.
      const bodyText = isEarly
        ? `Starts in ${earlyMin} min at ${fmtTime(fireDate)}`
        : `It's time! ${fmtTime(fireDate)}`;
      const title = isEarly ? `⏰ ${earlyMin} min until ${reminder.title}` : `⏰ ${reminder.title}${dayLabel ? ' · ' + dayLabel : ''}`;

      const timer = setTimeout(() => {
        try {
          if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            new Notification(title, { body: bodyText });
          }
        } catch {}
      }, delayMs);
      webTimers.set(id, timer);
      return id;
    };

    // On-time
    ids.push(scheduleWebTimeout(reminder.fireAt, false));

    // Early
    if (earlyMin > 0) {
      const earlyDate = new Date(reminder.fireAt.getTime() - earlyMin * 60_000);
      ids.push(scheduleWebTimeout(earlyDate, true));
    }

    return ids.join(',');
  }

  // ── NATIVE PATH (unchanged) ──────────────────────────────────
  const earlyMin = reminder.remindBeforeMinutes ?? 0;
  const fireTime = fmtTime(reminder.fireAt);
  const fireHours = reminder.fireAt.getHours();
  const fireMinutes = reminder.fireAt.getMinutes();

  // ── Build the recurring days to schedule for ────────────────────
  let days: number[] | null = null; // null = single notification (not multi-day)
  if (reminder.recurring === 'weekly' && reminder.daysOfWeek && reminder.daysOfWeek.length > 1) {
    days = reminder.daysOfWeek;
  }

  const scheduleOne = async (offsetMinutes: number, isEarly: boolean): Promise<string[]> => {
    const ids: string[] = [];
    const bodyText = isEarly
      ? `Starts in ${earlyMin} min at ${fireTime}`
      : `It's time! ${fireTime}`;

    if (days) {
      // Multi-day weekly — one notification per day
      for (const day of days) {
        const trigger = buildWeekdayTrigger(day, fireHours, fireMinutes, offsetMinutes);
        const id = await Notifications.scheduleNotificationAsync({
          content: {
            title: isEarly ? `⏰ ${earlyMin} min until ${reminder.title}` : `⏰ ${reminder.title}`,
            body: bodyText,
            sound: true,
          },
          trigger,
        });
        ids.push(id);
      }
    } else {
      // Single notification
      const trigger = buildTrigger(reminder.fireAt, reminder.recurring, offsetMinutes);
      const id = await Notifications.scheduleNotificationAsync({
        content: {
          title: isEarly ? `⏰ ${earlyMin} min until ${reminder.title}` : `⏰ ${reminder.title}`,
          body: bodyText,
          sound: true,
        },
        trigger,
      });
      ids.push(id);
    }
    return ids;
  };

  // Schedule on-time (always)
  const onTimeIds = await scheduleOne(0, false);

  // Schedule early if > 0
  let earlyIds: string[] = [];
  if (earlyMin > 0) {
    earlyIds = await scheduleOne(-earlyMin, true);
  }

  if (earlyIds.length > 0) {
    return `${earlyIds.join(',')}|${onTimeIds.join(',')}`;
  }
  return onTimeIds.join(',');
}

/**
 * Cancel all scheduled notifications for a reminder ID string.
 * Handles pipe-separated groups (early|onTime) and comma-separated IDs.
 */
export async function cancelReminder(notificationId: string): Promise<void> {
  const parts = notificationId.includes('|') ? notificationId.split('|') : [notificationId];
  const allIds = parts.flatMap((p) => (p.includes(',') ? p.split(',') : [p]));

  if (IS_WEB) {
    for (const id of allIds) {
      const trimmed = id.trim();
      const timer = webTimers.get(trimmed);
      if (timer) {
        clearTimeout(timer);
        webTimers.delete(trimmed);
      }
    }
    return;
  }

  await Promise.allSettled(allIds.map((id) => Notifications.cancelScheduledNotificationAsync(id.trim())));
}

/**
 * Helper — build a weekly trigger for a specific weekday, with optional minute offset.
 * @param weekday JS getDay() value (0=Sun … 6=Sat)
 * @param offsetMinutes Negative = earlier (e.g. -10 = 10 min before)
 */
function buildWeekdayTrigger(
  weekday: number,
  hour: number,
  minute: number,
  offsetMinutes: number = 0,
): Notifications.NotificationTriggerInput {
  const total = hour * 60 + minute + offsetMinutes;
  const h = Math.floor(((total % 1440) + 1440) % 1440 / 60);
  const m = ((total % 1440) + 1440) % 1440 % 60;
  // Expo: 1 = Sunday … 7 = Saturday (JS .getDay(): 0 = Sun, so +1)
  return {
    type: Notifications.SchedulableTriggerInputTypes.WEEKLY,
    weekday: weekday + 1,
    hour: h,
    minute: m,
  };
}

/**
 * Helper — build the correct trigger for one-shot vs recurring, with optional minute offset.
 * @param offsetMinutes Negative = earlier (e.g. -10 = 10 min before)
 */
function buildTrigger(
  fireAt: Date,
  recurring: 'none' | 'daily' | 'weekly' | 'monthly',
  offsetMinutes: number = 0,
): Notifications.NotificationTriggerInput {
  if (recurring === 'none') {
    const shifted = new Date(fireAt.getTime() + offsetMinutes * 60_000);
    return {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: shifted,
    };
  }

  // ── Recurring triggers ────────────────────────────────────────
  const total = fireAt.getHours() * 60 + fireAt.getMinutes() + offsetMinutes;
  const hours = Math.floor(((total % 1440) + 1440) % 1440 / 60);
  const minutes = ((total % 1440) + 1440) % 1440 % 60;

  if (recurring === 'daily') {
    return {
      type: Notifications.SchedulableTriggerInputTypes.DAILY,
      hour: hours,
      minute: minutes,
    };
  }

  if (recurring === 'weekly') {
    // Expo: 1 = Sunday … 7 = Saturday (JS .getDay(): 0 = Sun, so +1)
    const weekday = fireAt.getDay() + 1;
    return {
      type: Notifications.SchedulableTriggerInputTypes.WEEKLY,
      weekday,
      hour: hours,
      minute: minutes,
    };
  }

  if (recurring === 'monthly') {
    const day = fireAt.getDate();
    return {
      type: Notifications.SchedulableTriggerInputTypes.MONTHLY,
      day,
      hour: hours,
      minute: minutes,
    };
  }

  // Fallback — daily (shouldn't reach here)
  return {
    type: Notifications.SchedulableTriggerInputTypes.DAILY,
    hour: hours,
    minute: minutes,
  };
}

/**
 * Add a listener for incoming notifications while app is foregrounded.
 * Returns a subscription (call .remove() to unsubscribe).
 * On web: returns a no-op subscription object.
 */
export function addNotificationListener(
  handler: (notification: Notifications.Notification) => void,
): Notifications.EventSubscription {
  if (IS_WEB) {
    return { remove: () => {} } as Notifications.EventSubscription;
  }
  return Notifications.addNotificationReceivedListener(handler);
}

/**
 * Add a listener for when user taps a notification.
 * On web: returns a no-op subscription object.
 */
export function addNotificationResponseListener(
  handler: (response: Notifications.NotificationResponse) => void,
): Notifications.EventSubscription {
  if (IS_WEB) {
    return { remove: () => {} } as Notifications.EventSubscription;
  }
  return Notifications.addNotificationResponseReceivedListener(handler);
}
