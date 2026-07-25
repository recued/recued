/** D-149 P9 § A.5.6 — status-link transformation helper tests.
 *
 *  Covers:
 *    - parseStatusLinkConfig accepts well-formed config, returns null on
 *      shape failure.
 *    - buildStatusLinkSourceView clips the source row to the
 *      per-projection ceiling.
 *    - fields_visible_override is intersected with the ceiling.
 *    - buildStatusLinkPacketRawInput pass-throughs the typed shape.
 *    - End-to-end no-leak: feed an over-specified source row + build a
 *      packet via the substrate; assert no out-of-ceiling fields leak. */

import { describe, expect, it } from 'vitest';
import {
  STATUS_PROJECTION_FIELDS_VISIBLE,
  buildRedactedPacket,
  type StatusLinkConfig,
} from '@recued/contracts';
import {
  buildStatusLinkPacketRawInput,
  buildStatusLinkSourceView,
  parseStatusLinkConfig,
} from '../ports/reception/transformations/status-link.js';

const NOW = 1_700_000_000_000;
const ENTITY_UPDATED_AT = NOW - 2 * 24 * 60 * 60 * 1000;

const goodConfig = (overrides: Partial<StatusLinkConfig> = {}): StatusLinkConfig => ({
  display_name: 'Mary',
  projection_kind: 'project',
  source_ref: { kind: 'data.project', project_id: 'proj-42' },
  refresh_policy: { auto_refresh_enabled: true, refresh_interval_seconds: 60 },
  comments_enabled: false,
  shows_update_history: true,
  expiry_days: 30,
  ...overrides,
});

describe('D-149 P9 § A.5.6 — parseStatusLinkConfig', () => {
  it('returns the config when shape is valid', () => {
    const parsed = parseStatusLinkConfig(goodConfig());
    expect(parsed).not.toBeNull();
    expect(parsed!.projection_kind).toBe('project');
    expect(parsed!.source_ref.kind).toBe('data.project');
  });

  it('returns null on missing display_name', () => {
    expect(parseStatusLinkConfig({ ...goodConfig(), display_name: '' })).toBeNull();
  });

  it('returns null on unknown projection_kind', () => {
    expect(
      parseStatusLinkConfig({
        ...goodConfig(),
        projection_kind: 'banana',
      } as unknown),
    ).toBeNull();
  });

  it('returns null on disallowed source_ref kind (vault.*)', () => {
    expect(
      parseStatusLinkConfig({
        ...goodConfig(),
        source_ref: { kind: 'vault.secret', secret_id: 's' },
      } as unknown),
    ).toBeNull();
  });

  it('returns null on null input', () => {
    expect(parseStatusLinkConfig(null)).toBeNull();
  });

  it('returns null on comments_enabled=true', () => {
    expect(parseStatusLinkConfig({ ...goodConfig(), comments_enabled: true })).toBeNull();
  });
});

describe('D-149 P9 § A.5.6 — buildStatusLinkSourceView', () => {
  it('clips source row to projection ceiling', () => {
    const view = buildStatusLinkSourceView(
      goodConfig(),
      {
        title: 'Q3 Launch',
        state: 'in_progress',
        open_commitment_count: 3,
        last_activity_at_relative: '2 hours ago',
        milestone_summary: 'Phase 2 done',
        // Out-of-ceiling fields:
        internal_codename: 'project-shadow',
        vendor_contracts: ['c-1', 'c-2'],
        slack_thread_url: 'https://slack.com/x',
      },
      ENTITY_UPDATED_AT,
      NOW,
    );
    const allowed = STATUS_PROJECTION_FIELDS_VISIBLE.project;
    for (const f of allowed) {
      expect(view.source_entity_row).toHaveProperty(f);
    }
    expect(view.source_entity_row).not.toHaveProperty('internal_codename');
    expect(view.source_entity_row).not.toHaveProperty('vendor_contracts');
    expect(view.source_entity_row).not.toHaveProperty('slack_thread_url');
  });

  it('intersects fields_visible_override with the projection ceiling', () => {
    // Override declares one in-ceiling field + one bogus field. The
    // bogus entry is dropped silently; in-ceiling field is preserved.
    const view = buildStatusLinkSourceView(
      goodConfig({
        fields_visible_override: ['title', 'internal_codename'],
      }),
      {
        title: 'Q3 Launch',
        state: 'in_progress',
        internal_codename: 'project-shadow',
      },
      ENTITY_UPDATED_AT,
      NOW,
    );
    expect(view.source_entity_row).toEqual({ title: 'Q3 Launch' });
    expect(view.fields_visible_override).toEqual(['title', 'internal_codename']);
  });

  it('handles missing source row fields gracefully', () => {
    const view = buildStatusLinkSourceView(
      goodConfig(),
      { title: 'Q3 Launch' },
      ENTITY_UPDATED_AT,
      NOW,
    );
    expect(view.source_entity_row).toEqual({ title: 'Q3 Launch' });
  });

  it('passes through comments_enabled + shows_update_history', () => {
    const view = buildStatusLinkSourceView(
      goodConfig({ shows_update_history: false }),
      { title: 'T' },
      ENTITY_UPDATED_AT,
      NOW,
    );
    expect(view.comments_enabled).toBe(false);
    expect(view.updates_visible).toBe(false);
  });
});

describe('D-149 P9 § A.5.6 — buildStatusLinkPacketRawInput', () => {
  it('pass-throughs the typed shape', () => {
    const view = buildStatusLinkSourceView(
      goodConfig(),
      { title: 'T', state: 'in_progress' },
      ENTITY_UPDATED_AT,
      NOW,
    );
    const raw = buildStatusLinkPacketRawInput(view);
    expect(raw.projection_kind).toBe('project');
    expect(raw.source_entity_row).toEqual({ title: 'T', state: 'in_progress' });
    expect(raw.last_updated_at).toBe(ENTITY_UPDATED_AT);
    expect(raw.now).toBe(NOW);
    expect(raw.updates_visible).toBe(true);
    expect(raw.comments_enabled).toBe(false);
  });

  it('omits fields_visible_override when undefined', () => {
    const view = buildStatusLinkSourceView(
      goodConfig(),
      { title: 'T' },
      ENTITY_UPDATED_AT,
      NOW,
    );
    const raw = buildStatusLinkPacketRawInput(view);
    expect('fields_visible_override' in raw).toBe(false);
  });

  it('passes fields_visible_override through when set', () => {
    const view = buildStatusLinkSourceView(
      goodConfig({ fields_visible_override: ['title', 'state'] }),
      { title: 'T', state: 'in_progress' },
      ENTITY_UPDATED_AT,
      NOW,
    );
    const raw = buildStatusLinkPacketRawInput(view);
    expect(raw.fields_visible_override).toEqual(['title', 'state']);
  });
});

describe('D-149 P9 § A.5.6 — end-to-end no-leak through substrate packet builder', () => {
  it('no out-of-ceiling fields appear in the rendered packet for project', () => {
    const view = buildStatusLinkSourceView(
      goodConfig({ projection_kind: 'project' }),
      {
        title: 'Q3 Launch',
        state: 'in_progress',
        open_commitment_count: 3,
        last_activity_at_relative: '2 hours ago',
        milestone_summary: 'Phase 2 done',
        internal_codename: 'project-shadow',
        vendor_contracts: ['c-1', 'c-2'],
        slack_thread_url: 'https://slack.com/x',
      },
      ENTITY_UPDATED_AT,
      NOW,
    );
    const raw = buildStatusLinkPacketRawInput(view);
    const packet = buildRedactedPacket('status_link_packet', raw, {
      now: NOW,
      randomToken: () => 'tok',
      max_ttl_ms: 90 * 24 * 60 * 60 * 1000,
    });
    const visible = packet.payload.visible_fields as Record<string, unknown>;
    expect(visible).not.toHaveProperty('internal_codename');
    expect(visible).not.toHaveProperty('vendor_contracts');
    expect(visible).not.toHaveProperty('slack_thread_url');
    expect(visible.title).toBe('Q3 Launch');
    expect(visible.state).toBe('in_progress');
  });

  it('itinerary visible_legs strips booking codes + confirmation numbers', () => {
    const view = buildStatusLinkSourceView(
      goodConfig({
        projection_kind: 'itinerary',
        source_ref: { kind: 'data.itinerary', itinerary_id: 'it-1' },
      }),
      {
        title: 'NYC trip',
        date_range: { start_at: NOW, end_at: NOW + 5 * 24 * 60 * 60 * 1000 },
        visible_legs: [
          {
            origin: 'SFO',
            destination: 'JFK',
            mode: 'flight',
            time: '08:00',
            // These MUST be stripped by the per-field redactor:
            confirmation_number: 'PNR123',
            booking_code: 'BC-456',
            loyalty_id: 'AA-789',
          },
        ],
        // Out-of-ceiling field:
        vendor_contract_ref: 'vc-1',
      },
      ENTITY_UPDATED_AT,
      NOW,
    );
    const raw = buildStatusLinkPacketRawInput(view);
    const packet = buildRedactedPacket('status_link_packet', raw, {
      now: NOW,
      randomToken: () => 'tok',
      max_ttl_ms: 90 * 24 * 60 * 60 * 1000,
    });
    const visible = packet.payload.visible_fields as {
      visible_legs?: Array<Record<string, unknown>>;
    };
    expect(visible).not.toHaveProperty('vendor_contract_ref');
    expect(visible.visible_legs).toHaveLength(1);
    const leg = visible.visible_legs![0]!;
    expect(leg).not.toHaveProperty('confirmation_number');
    expect(leg).not.toHaveProperty('booking_code');
    expect(leg).not.toHaveProperty('loyalty_id');
    expect(leg.origin).toBe('SFO');
    expect(leg.destination).toBe('JFK');
    expect(leg.mode).toBe('flight');
    expect(leg.time).toBe('08:00');
  });

  it('event_plan visible_attendees redacted via redactCounterpartyName', () => {
    const view = buildStatusLinkSourceView(
      goodConfig({
        projection_kind: 'event_plan',
        source_ref: { kind: 'data.event', event_id: 'evt-1' },
      }),
      {
        title: 'Wedding',
        date: '2026-08-15',
        location_label: 'Napa',
        agenda_summary: 'ceremony + dinner',
        visible_attendees: ['Alice Smith', 'Bob Jones'],
        tz_label: 'America/Los_Angeles',
        // Out-of-ceiling fields that MUST be stripped:
        vendor_contracts: ['v1', 'v2'],
        budget_total_cents: 500_000,
      },
      ENTITY_UPDATED_AT,
      NOW,
    );
    const raw = buildStatusLinkPacketRawInput(view);
    const packet = buildRedactedPacket('status_link_packet', raw, {
      now: NOW,
      randomToken: () => 'tok',
      max_ttl_ms: 90 * 24 * 60 * 60 * 1000,
    });
    const visible = packet.payload.visible_fields as {
      visible_attendees?: ReadonlyArray<string>;
      vendor_contracts?: unknown;
      budget_total_cents?: unknown;
    };
    expect(visible).not.toHaveProperty('vendor_contracts');
    expect(visible).not.toHaveProperty('budget_total_cents');
    // Attendee names redacted to first-name + initial form.
    expect(visible.visible_attendees).toHaveLength(2);
    expect(visible.visible_attendees![0]).not.toBe('Alice Smith');
    expect(visible.visible_attendees![1]).not.toBe('Bob Jones');
  });
});
