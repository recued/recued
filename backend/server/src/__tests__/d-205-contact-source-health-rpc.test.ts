/** D-205 #2c — `contact.source.list`: per-Source contact sync health.
 *
 *  The first reader of the runner's twelve per-cycle counters. Since D-205 #1 they
 *  have had exactly one writer and ZERO readers — `source_freshness_degradation`
 *  selects `(last_success_at, degraded)` and nothing else — so a leaf that failed
 *  every record on every cycle collapsed to a single boolean with the diagnosis
 *  sitting unread in the row beside it. */

import { describe, expect, it } from 'vitest';
import type { ContactSourceCycleCounts, SourceRegistration } from '@recued/contracts';

import { handleContactSourceList } from '../contact-source-handler.js';
import {
  CONTACT_SOURCE_STALE_AFTER_MS,
  deriveContactSourceFreshness,
  type ContactSourceSyncState,
  type ContactSourceSyncStateStore,
} from '../storage/contact-source-sync-state.js';

const NOW = 1_700_000_000_000;

const registration = (
  over: Partial<SourceRegistration> & { id: string },
): SourceRegistration => ({
  top_tier_kind: 'contact',
  source_kind: 'connection',
  source_label: 'HubSpot (work)',
  write_capable: false,
  registered_at: 1,
  ...over,
});

const counts = (over: Partial<ContactSourceCycleCounts> = {}): ContactSourceCycleCounts => ({
  hydrated: 0,
  unchanged: 0,
  skipped: 0, created: 0, promoted: 0,
  disconnected: 0,
  failed_rows: 0,
  unkeyable: 0,
  ambiguous: 0,
  conflicted: 0,
  repointed: 0,
  mirror_failed: 0,
  linked: 0,
  complete: true,
  ...over,
});

const state = (
  over: Partial<ContactSourceSyncState> & { source_id: string },
): ContactSourceSyncState => ({
  last_sync_started_at: null,
  last_sync_completed_at: null,
  last_success_at: null,
  last_error_code: null,
  last_error_message: null,
  degraded: false,
  stale_after_ms: CONTACT_SOURCE_STALE_AFTER_MS,
  last_cycle: null,
  ...over,
});

const deps = (
  registrations: SourceRegistration[],
  states: ContactSourceSyncState[],
) => ({
  resolver: {
    listSources: (kind?: string): SourceRegistration[] =>
      kind === undefined
        ? registrations
        : registrations.filter((r) => r.top_tier_kind === kind),
  } as never,
  syncState: { list: () => states } as unknown as ContactSourceSyncStateStore,
  now: () => NOW,
});

describe('D-205 #2c — contact.source.list', () => {
  it('surfaces the cycle counts — the twelve counters that had no reader', async () => {
    const { sources } = await handleContactSourceList(
      deps(
        [registration({ id: 'hubspot.work.contact' })],
        [
          state({
            source_id: 'hubspot.work.contact',
            last_success_at: NOW - 60_000,
            last_cycle: counts({ hydrated: 1240, skipped: 8800, created: 0, promoted: 0, linked: 1240 }),
          }),
        ],
      ),
    );

    expect(sources).toHaveLength(1);
    expect(sources[0]?.last_cycle).toEqual(
      counts({ hydrated: 1240, skipped: 8800, created: 0, promoted: 0, linked: 1240 }),
    );
    expect(sources[0]?.source_label).toBe('HubSpot (work)');
    expect(sources[0]?.degraded).toBe(false);
    expect(sources[0]?.stale).toBe(false);
  });

  it('carries the failure SAMPLES verbatim — a bug report, not a shrug', async () => {
    // `last_error_message` is assembled from structure the writer already destroyed
    // (summary + ' — ' + samples joined by ' | '). It is passed through whole rather
    // than re-parsed: reconstructing fields from a flattened string is lossy, and a
    // provenance/diagnosis surface that guesses is worse than one that quotes.
    const message =
      '12 record(s) failed their supplies promise or could not be written'
      + ' — hs_1: attributes.address promised by the declaration but absent from the record';
    const { sources } = await handleContactSourceList(
      deps(
        [registration({ id: 'hubspot.work.contact' })],
        [
          state({
            source_id: 'hubspot.work.contact',
            degraded: true,
            last_error_code: 'records_failed',
            last_error_message: message,
            last_cycle: counts({ failed_rows: 12 }),
          }),
        ],
      ),
    );

    expect(sources[0]?.last_error_code).toBe('records_failed');
    expect(sources[0]?.last_error_message).toBe(message);
    expect(sources[0]?.last_cycle?.failed_rows).toBe(12);
    // A degraded cycle never bumped last_success_at, so it reads STALE however
    // recently it ran — that is the whole point of the two fields being separate.
    expect(sources[0]?.degraded).toBe(true);
    expect(sources[0]?.stale).toBe(true);
  });

  it('🔑 the REGISTRY is the spine — a Source that has never run still appears', async () => {
    // Driving the list off the state table would make a Source that never got as far
    // as its first cycle VANISH from its own health page. A Source that is absent
    // reads as fine, which is the exact silent-failure this family exists to end.
    const { sources } = await handleContactSourceList(
      deps([registration({ id: 'salesforce.prod.contact' })], []),
    );

    expect(sources).toHaveLength(1);
    expect(sources[0]?.source_id).toBe('salesforce.prod.contact');
    expect(sources[0]?.last_success_at).toBeNull();
    expect(sources[0]?.last_cycle).toBeNull();
    // Never-synced reads STALE — we know nothing about it, which is not health.
    expect(sources[0]?.stale).toBe(true);
    // …but NOT degraded: it has not failed, it simply has not run.
    expect(sources[0]?.degraded).toBe(false);
  });

  it('drops a state row whose Source is gone, and never leaks a non-contact Source', async () => {
    const { sources } = await handleContactSourceList(
      deps(
        [
          registration({ id: 'hubspot.work.contact' }),
          // A file Source must not appear on the CONTACT strip.
          registration({
            id: 'gdrive.personal.file',
            top_tier_kind: 'file',
            source_label: 'Google Drive (personal)',
          }),
        ],
        [
          state({ source_id: 'hubspot.work.contact', last_success_at: NOW }),
          // An orphan: the Source was unregistered but its row lingers.
          state({ source_id: 'zoho.old.contact', last_success_at: NOW }),
        ],
      ),
    );

    expect(sources.map((s) => s.source_id)).toEqual(['hubspot.work.contact']);
  });


});

describe('D-205 #2c — deriveContactSourceFreshness', () => {
  it('a null state is STALE and never-synced — not healthy', () => {
    expect(deriveContactSourceFreshness(null, NOW)).toEqual({
      last_success_at: null,
      degraded: false,
      stale: true,
    });
  });

  it('a clean cycle older than stale_after_ms reads stale', () => {
    const old = state({
      source_id: 's',
      last_success_at: NOW - CONTACT_SOURCE_STALE_AFTER_MS - 1,
    });
    expect(deriveContactSourceFreshness(old, NOW).stale).toBe(true);

    const fresh = state({
      source_id: 's',
      last_success_at: NOW - CONTACT_SOURCE_STALE_AFTER_MS + 1,
    });
    expect(deriveContactSourceFreshness(fresh, NOW).stale).toBe(false);
  });

  it('degraded reads stale REGARDLESS of how recently it ran', () => {
    const justRanButBroken = state({
      source_id: 's',
      last_success_at: NOW,
      degraded: true,
    });
    expect(deriveContactSourceFreshness(justRanButBroken, NOW).stale).toBe(true);
  });
});
