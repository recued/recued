import type { CollectionRecord } from './collections.js';
import { parseAddress, splitAddressList } from './contact.js';
import { mailRecipientInvalidReason } from './mail.js';

export interface CalendarEventGuest {
  email: string;
  display_name?: string;
}

export const CALENDAR_EVENT_GUEST_LIMITS = { count: 100, display_name: 256 } as const;

/** One concrete address per guest. Shared by the owner form and its server boundary. */
export const normalizeCalendarEventGuests = (value: unknown): CalendarEventGuest[] => {
  if (!Array.isArray(value) || value.length > CALENDAR_EVENT_GUEST_LIMITS.count) {
    throw new Error(`Choose up to ${CALENDAR_EVENT_GUEST_LIMITS.count} guests.`);
  }
  const guests = new Map<string, CalendarEventGuest>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.email !== 'string') {
      throw new Error('Enter one email address for each guest.');
    }
    if (mailRecipientInvalidReason(raw.email) !== null || splitAddressList(raw.email)[0] !== raw.email.trim()) {
      throw new Error('Enter one email address for each guest.');
    }
    const parsed = parseAddress(raw.email);
    if (!parsed || parsed.email !== raw.email.trim().toLowerCase()) {
      throw new Error('Enter one email address for each guest.');
    }
    if (raw.display_name !== undefined && (typeof raw.display_name !== 'string'
      || /[\x00-\x1f\x7f]/.test(raw.display_name)
      || new TextEncoder().encode(raw.display_name).length > CALENDAR_EVENT_GUEST_LIMITS.display_name)) {
      throw new Error('Use a shorter guest name without line breaks.');
    }
    if (!guests.has(parsed.email)) guests.set(parsed.email, { email: parsed.email,
      ...(raw.display_name?.trim() ? { display_name: raw.display_name.trim() } : {}) });
  }
  return [...guests.values()];
};

/** Paired owner UI: create, inspect and edit events, and respond to invitations. */
export interface CalendarEventRef {
  slug: string;
  source_id: string;
}

/** Owner-only preview of retained calendar data. Never reserves a time. */
export interface CalendarOverlapRequest {
  start_at: number;
  end_at: number;
  is_all_day: boolean;
  timezone: string;
  exclude?: CalendarEventRef & { expected_incarnation: string };
}
export interface CalendarOverlapResult {
  start_at: number;
  end_at: number;
  is_all_day: boolean;
  timezone: string;
  checked_at: number;
  events: Array<{
    summary: string;
    start_at: number;
    end_at: number;
    is_all_day: boolean;
    calendars: string[];
  }>;
  sources: Array<{
    slug: string;
    name: string;
    status: 'local' | 'synced' | 'stale' | 'unavailable';
    last_synced_at: number | null;
  }>;
  /** More saved rows or distinct events exist than this bounded preview read. */
  truncated: boolean;
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
  attendees?: ReadonlyArray<CalendarEventGuest & {
    response_status: 'accepted' | 'declined' | 'tentative' | 'needs_action';
  }>;
  /** The provider's complete count when the displayed list is bounded. */
  attendee_count?: number;
}

export interface CalendarEventSnapshot {
  event: CalendarEventDetails;
  /** The same warehouse version, including its inline or blob-backed body. */
  record: CollectionRecord;
  resource_version: string;
  /** Prevents an old draft from editing a replacement calendar with the same slug. */
  incarnation: string | null;
  editable: boolean;
  /** Present only when this server can delete this single local event. */
  deletable?: true;
  /** D-336 (spec §58) — present only when this server can delete this event from its connected
   *  calendar (Google, Outlook, CalDAV), read from that calendar in this request. `notice` says
   *  what the delete does: where the event goes from, and who is told. ⛔ Not `deletable`: an
   *  older client reads that as a local delete and tells the owner "Guests will not be
   *  notified", while Outlook and Google tell an event's guests it is cancelled. */
  provider_delete?: { notice: string };
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

export interface CalendarEventDeletionCheckRequest extends CalendarEventRef {
  expected_incarnation: string;
}

export interface CalendarEventDeleteRequest extends CalendarEventDeletionCheckRequest {
  expected_version: string;
}

export interface CalendarEventDeleteResult extends CalendarEventRef {
  incarnation: string;
  deleted: true;
}

/** Absence is meaningful only on the same, still-existing calendar: the local calendar's own
 *  record, or a connected calendar that answers it has no such event (D-336 spec §58). */
export interface CalendarEventDeletionState extends CalendarEventRef {
  incarnation: string;
  snapshot: CalendarEventSnapshot | null;
}

export interface CalendarEventDestination {
  slug: string;
  calendar_id: string;
  name: string;
  provider: 'local' | 'gcal' | 'graph' | 'caldav';
  incarnation: string;
  /** Present only when this live destination can send and track invitations. */
  can_invite?: true;
  invitation_unavailable_reason?: string;
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
  guests?: CalendarEventGuest[];
  /** Explicit owner intent; required together with a nonempty guest list. */
  send_invitations?: true;
}

export interface CalendarEventCreateResult {
  slug: string;
  snapshot: CalendarEventSnapshot;
  /** Provider creation acknowledged the requested guests, not proof of email delivery. */
  invitations_requested?: true;
}

export const CALENDAR_EVENT_EDIT_LIMITS = {
  summary: 4096,
  location: 4096,
  description: 262_144,
} as const;
