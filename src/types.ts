/** Shape returned by the worker's POST /analyze endpoint. */
export interface AnalyzeResponse {
  title: string;
  needsReminder: boolean;
  reminder: {
    /** ISO 8601 datetime string. */
    datetime: string;
    /** Recurrence pattern. */
    recurring: 'none' | 'daily' | 'weekly' | 'monthly';
  } | null;
}

/** A saved/processed note, stored locally. */
export interface Note {
  id: string;
  raw: string;
  title: string;
  createdAt: string; // ISO
}

/** An active reminder backed by a scheduled notification. */
export interface Reminder {
  id: string;
  title: string;
  /** ISO string for the first fire date. */
  fireAt: string;
  recurring: 'none' | 'daily' | 'weekly' | 'monthly';
  /** The notification identifier returned by expo-notifications (for cancellation). */
  notificationId: string;
}
