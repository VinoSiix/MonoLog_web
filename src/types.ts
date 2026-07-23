/** Shape returned by the worker's POST /analyze endpoint. */
export interface AnalyzeResponse {
  title: string;
  needsReminder: boolean;
  /**
   * What to do with the incoming text:
   * - "create" — make a new reminder (default)
   * - "modify" — update an existing reminder (targetReminderTitle + modify set)
   * - "skip" — silence one occurrence of a recurring reminder
   * - "delete" — remove a reminder entirely
   * - "none" — just a note, no reminder action
   */
  action: 'create' | 'modify' | 'skip' | 'delete' | 'none';
  reminder: {
    /** ISO 8601 datetime string. */
    datetime: string;
    /** Recurrence pattern. */
    recurring: 'none' | 'daily' | 'weekly' | 'monthly';
    /** Specific days of the week (0=Sun … 6=Sat) for multi-day weekly patterns. */
    daysOfWeek?: number[];
    /** Send reminder this many minutes before the event (0 = at event time). */
    remindBeforeMinutes?: number;
  } | null;
  /** Title of the reminder to modify/delete/skip (for non-create actions). */
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

/** A saved/processed note, stored locally. */
export interface Note {
  id: string;
  raw: string;
  title: string;
  createdAt: string; // ISO
}

/** An active reminder backed by one or more scheduled notifications. */
export interface Reminder {
  id: string;
  title: string;
  /** ISO string for the first fire date. */
  fireAt: string;
  recurring: 'none' | 'daily' | 'weekly' | 'monthly';
  /**
   * Notification identifier(s) returned by expo-notifications.
   * Single ID for one-shot / daily / monthly / single-weekday.
   * Comma-separated IDs for multi-day weekly reminders.
   * When remindBeforeMinutes is set, uses PIPE-separated groups:
   * "earlyId1,earlyId2|onTimeId1,onTimeId2"
   */
  notificationId: string;
  /** Specific days of the week (0=Sun … 6=Sat) for multi-day weekly patterns. */
  daysOfWeek?: number[];
  /** ISO date strings (YYYY-MM-DD) for occurrences that should be skipped. */
  skipDates?: string[];
  /** Send reminder this many minutes before the event. 0 or unset = at event time. */
  remindBeforeMinutes?: number;
}
