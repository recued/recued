import type { CollectionRecord } from './collections.js';

/** Paired owner UI: create, inspect and edit events, and respond to invitations. */
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
  /** Omitted by older servers and local editors, which support every patch field. */
  editable_fields?: Array<keyof CalendarEventPatch>;
  edit_notice?: string;
  read_only_reason?: string;
  /** A provider read succeeded for this request; absent on cached/local reads. */
  provider_verified?: true;
  /** Saved details remain available when a remote refresh fails. */
  refresh_error?: string;
  /** Only a live provider invitation may offer organizer-facing responses. */
  invitation?: {
    organizer: { email: string; display_name?: string };
    attendee_email: string;
    response: 'accepted' | 'declined' | 'tentative' | 'needs_action';
    can_respond: boolean;
    scope: 'event' | 'occurrence' | 'series';
    unavailable_reason?: string;
  };
}

export type CalendarInvitationResponse = 'accepted' | 'tentative' | 'declined';
export interface CalendarEventRespondRequest extends CalendarEventRef {
  expected_version: string;
  expected_incarnation: string;
  response: CalendarInvitationResponse;
}
export type CalendarEventRespondResult =
  | { removed: false; snapshot: CalendarEventSnapshot }
  | { removed: true; source_id: string; response: 'declined' };

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

export interface CalendarEventDestination {
  slug: string;
  calendar_id: string;
  name: string;
  provider: 'local' | 'gcal' | 'graph' | 'caldav';
  incarnation: string;
}

export interface CalendarEventDestinations {
  destinations: CalendarEventDestination[];
  unavailable: Array<{ slug: string; reason: string }>;
}

export interface CalendarEventCreateRequest {
  slug: string;
  calendar_id: string;
  expected_incarnation: string;
  /** Retried unchanged until its outcome is known. A different draft needs a new ID. */
  creation_id: string;
  summary: string;
  description: string;
  location: string;
  start_at: number;
  end_at: number;
  timezone: string;
  is_all_day: boolean;
}

export interface CalendarEventCreateResult {
  slug: string;
  snapshot: CalendarEventSnapshot;
}

export const CALENDAR_EVENT_EDIT_LIMITS = {
  summary: 4096,
  location: 4096,
  description: 262_144,
} as const;
