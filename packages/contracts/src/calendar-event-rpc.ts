import type { CollectionRecord } from './collections.js';

/** Paired owner UI: inspect an event and edit a single local event. */
export interface CalendarEventRef {
  slug: string;
  source_id: string;
}

export interface CalendarEventDetails {
  record_id: string;
  source_id: string;
  calendar_id: string;
  calendar_name?: string;
  summary: string;
  description: string;
  description_truncated?: true;
  location: string;
  start_at: number;
  end_at: number;
  updated_at: number;
  timezone: string;
  is_all_day: boolean;
  status: 'confirmed' | 'tentative' | 'cancelled';
  is_recurring: boolean;
}

export interface CalendarEventSnapshot {
  event: CalendarEventDetails;
  /** The same warehouse version, including its inline or blob-backed body. */
  record: CollectionRecord;
  resource_version: string;
  /** Prevents an old draft from editing a replacement calendar with the same slug. */
  incarnation: string | null;
  editable: boolean;
  read_only_reason?: string;
}

export interface CalendarEventPatch {
  summary?: string;
  description?: string;
  location?: string;
  start_at?: number;
  end_at?: number;
}

export interface CalendarEventUpdateRequest extends CalendarEventRef {
  expected_version: string;
  expected_incarnation: string;
  patch: CalendarEventPatch;
}

export const CALENDAR_EVENT_EDIT_LIMITS = {
  summary: 4096,
  location: 4096,
  description: 262_144,
} as const;
