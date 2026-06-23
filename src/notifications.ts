import * as Notifications from 'expo-notifications';

// Configure notification handler — always show banners + sound when app is in foreground.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/**
 * Request notification permissions (required on iOS).
 * Returns true if granted.
 */
export async function requestPermissions(): Promise<boolean> {
  const { status: existing } = await Notifications.getPermissionsAsync();
  if (existing === 'granted') return true;

  const { status } = await Notifications.requestPermissionsAsync();
  return status === 'granted';
}

/**
 * Schedule a local notification for a reminder.
 * Returns the expo-notifications identifier string.
 */
export async function scheduleReminder(reminder: {
  title: string;
  fireAt: Date;
  recurring: 'none' | 'daily' | 'weekly' | 'monthly';
}): Promise<string> {
  const trigger = buildTrigger(reminder.fireAt, reminder.recurring);

  const notificationId = await Notifications.scheduleNotificationAsync({
    content: {
      title: '⏰ ' + reminder.title,
      body: reminder.recurring === 'none'
        ? 'Reminder is due.'
        : `Recurring reminder (${reminder.recurring}).`,
      sound: true,
    },
    trigger,
  });

  return notificationId;
}

/**
 * Cancel a previously scheduled notification.
 */
export async function cancelReminder(notificationId: string): Promise<void> {
  await Notifications.cancelScheduledNotificationAsync(notificationId);
}

/**
 * Helper — build the correct trigger for one-shot vs recurring.
 */
function buildTrigger(
  fireAt: Date,
  recurring: 'none' | 'daily' | 'weekly' | 'monthly',
): Notifications.NotificationTriggerInput {
  if (recurring === 'none') {
    return {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: fireAt,
    };
  }

  // ── Recurring triggers ────────────────────────────────────────
  const hours = fireAt.getHours();
  const minutes = fireAt.getMinutes();

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
 */
export function addNotificationListener(
  handler: (notification: Notifications.Notification) => void,
): Notifications.EventSubscription {
  return Notifications.addNotificationReceivedListener(handler);
}

/**
 * Add a listener for when user taps a notification.
 */
export function addNotificationResponseListener(
  handler: (response: Notifications.NotificationResponse) => void,
): Notifications.EventSubscription {
  return Notifications.addNotificationResponseReceivedListener(handler);
}
