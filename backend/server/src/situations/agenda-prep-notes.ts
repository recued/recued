import type { EnrichmentStore } from '../storage/enrichment-store.js';

/** D-325 §15.7 amendment (2026-11-02, later) — whether a calendar event has Meeting preparation
 *  notes the Agenda may call ready: a fresh `preparation_notes` row for the event's record id.
 *  A row the cascade marked stale (the event changed since) or expired (past its 30 days) does
 *  not count. A read that fails says no, so a broken read never holds the Agenda itself. */
export const preparationNotesReady = (store: Pick<EnrichmentStore, 'list'>) => (calendarRecordId: string): boolean => {
  try {
    return store.list({ topic: 'preparation_notes', scope: 'calendar', target_id: calendarRecordId, fresh_only: true, limit: 1 }).length > 0;
  } catch {
    return false;
  }
};
