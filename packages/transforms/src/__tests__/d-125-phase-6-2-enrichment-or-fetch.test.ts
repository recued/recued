/** D-125 Phase 6.2 — `enrichment-or-fetch` transform tests. */

import { describe, expect, it } from 'vitest';
import { enrichmentOrFetch } from '../enrichment-or-fetch.js';
import { ctx } from './helpers.js';
import type { EnrichmentRowSnapshot, TransformContext } from '../types.js';

const FROZEN_NOW = new Date('2026-04-28T12:00:00Z');
const NOW_MS = FROZEN_NOW.getTime();

const makeRow = (overrides: Partial<EnrichmentRowSnapshot> = {}): EnrichmentRowSnapshot => ({
  value: { brief: 'meeting brief', attendees: ['alice@x.com'] },
  event_at: NOW_MS - 60_000,
  ingested_at: NOW_MS - 60_000,
  stale: false,
  confidence: null,
  ...overrides,
});

const ctxWithReader = (
  reader: TransformContext['readEnrichmentRow'],
  extras: Partial<TransformContext> = {},
): TransformContext =>
  ctx({
    now: () => FROZEN_NOW,
    readEnrichmentRow: reader,
    ...extras,
  });

describe('enrichmentOrFetch — ref parsing', () => {
  it('parses data.<collection>.<id>.<topic> and reads the row', () => {
    const reader = (topic: string, scope: string, target_id: string) => {
      expect(topic).toBe('calendar_event_rollup');
      expect(scope).toBe('calendar');
      expect(target_id).toBe('evt_123');
      return makeRow();
    };
    const out = enrichmentOrFetch(
      { ref: 'data.calendar.evt_123.calendar_event_rollup' },
      ctxWithReader(reader),
    ) as { value: unknown; source: string };
    expect(out.source).toBe('enrichment');
    expect(out.value).toEqual({ brief: 'meeting brief', attendees: ['alice@x.com'] });
  });

  it('parses connection.<kind>.<name>.<topic> with composed scope', () => {
    const reader = (topic: string, scope: string, target_id: string) => {
      expect(topic).toBe('connection_health_trend');
      expect(scope).toBe('connection.api');
      expect(target_id).toBe('hubspot');
      return makeRow({ value: { error_rate: 0.02 } });
    };
    const out = enrichmentOrFetch(
      { ref: 'connection.api.hubspot.connection_health_trend' },
      ctxWithReader(reader),
    ) as { value: unknown; source: string };
    expect(out.source).toBe('enrichment');
    expect(out.value).toEqual({ error_rate: 0.02 });
  });

  it('handles target_ids with dots (e.g. emails)', () => {
    const reader = (topic: string, scope: string, target_id: string) => {
      expect(scope).toBe('contact');
      expect(target_id).toBe('bob@x.com');
      expect(topic).toBe('contact_timeline_rollup');
      return makeRow();
    };
    const out = enrichmentOrFetch(
      { ref: 'data.contact.bob@x.com.contact_timeline_rollup' },
      ctxWithReader(reader),
    ) as { source: string };
    expect(out.source).toBe('enrichment');
  });

  it('returns source: unparseable_ref when ref does not start with data./connection.', () => {
    const out = enrichmentOrFetch(
      { ref: 'config.foo.bar' },
      ctxWithReader(() => null),
    ) as { value: unknown; source: string; fallback?: string };
    expect(out.source).toBe('unparseable_ref');
    expect(out.value).toBeNull();
  });

  it('returns source: unparseable_ref when topic is not registered', () => {
    const out = enrichmentOrFetch(
      { ref: 'data.contact.bob@x.com.unknown_topic_zzz' },
      ctxWithReader(() => null),
    ) as { source: string };
    expect(out.source).toBe('unparseable_ref');
  });

  it('returns source: unparseable_ref when collection is not in the closed set', () => {
    const out = enrichmentOrFetch(
      { ref: 'data.foobar.id.contact_timeline_rollup' },
      ctxWithReader(() => null),
    ) as { source: string };
    expect(out.source).toBe('unparseable_ref');
  });
});

describe('enrichmentOrFetch — runtime hook', () => {
  it('returns source: no_runtime when readEnrichmentRow is missing', () => {
    const out = enrichmentOrFetch(
      { ref: 'data.calendar.evt_1.calendar_event_rollup', fallback_step: 'fetch_event' },
      ctx(),
    ) as { value: unknown; source: string; fallback?: string };
    expect(out.source).toBe('no_runtime');
    expect(out.fallback).toBe('fetch_event');
  });

  it('returns source: miss when reader returns null', () => {
    const out = enrichmentOrFetch(
      {
        ref: 'data.calendar.evt_1.calendar_event_rollup',
        fallback_step: 'fetch_event',
      },
      ctxWithReader(() => null),
    ) as { source: string; fallback?: string };
    expect(out.source).toBe('miss');
    expect(out.fallback).toBe('fetch_event');
  });
});

describe('enrichmentOrFetch — freshness gate', () => {
  it('returns source: stale when row.stale is true', () => {
    const out = enrichmentOrFetch(
      { ref: 'data.calendar.evt_1.calendar_event_rollup' },
      ctxWithReader(() => makeRow({ stale: true })),
    ) as { source: string };
    expect(out.source).toBe('stale');
  });

  it('returns source: stale when max_age_ms is exceeded', () => {
    const out = enrichmentOrFetch(
      {
        ref: 'data.calendar.evt_1.calendar_event_rollup',
        max_age_ms: 1_000,
      },
      ctxWithReader(() => makeRow({ event_at: NOW_MS - 60_000 })),
    ) as { source: string };
    expect(out.source).toBe('stale');
  });

  it('falls back to ingested_at when event_at is null', () => {
    const out = enrichmentOrFetch(
      {
        ref: 'data.calendar.evt_1.calendar_event_rollup',
        max_age_ms: 30_000,
      },
      ctxWithReader(() => makeRow({ event_at: null, ingested_at: NOW_MS - 5_000 })),
    ) as { source: string };
    expect(out.source).toBe('enrichment');
  });
});

describe('enrichmentOrFetch — trust gate', () => {
  it('returns source: low_trust when value.confidence < trust_min', () => {
    const out = enrichmentOrFetch(
      {
        ref: 'data.calendar.evt_1.calendar_event_rollup',
        trust_min: 0.9,
      },
      ctxWithReader(() =>
        makeRow({ value: { brief: 'x', confidence: 0.5 } }),
      ),
    ) as { source: string };
    expect(out.source).toBe('low_trust');
  });

  it('passes when value.confidence >= trust_min', () => {
    const out = enrichmentOrFetch(
      {
        ref: 'data.calendar.evt_1.calendar_event_rollup',
        trust_min: 0.5,
      },
      ctxWithReader(() =>
        makeRow({ value: { brief: 'x', confidence: 0.9 } }),
      ),
    ) as { source: string; confidence?: number };
    expect(out.source).toBe('enrichment');
    expect(out.confidence).toBe(0.9);
  });

  it('treats absent confidence as trusted (no signal = passthrough)', () => {
    const out = enrichmentOrFetch(
      { ref: 'data.calendar.evt_1.calendar_event_rollup' },
      ctxWithReader(() => makeRow({ value: { brief: 'x' } })),
    ) as { source: string; confidence?: number };
    expect(out.source).toBe('enrichment');
    expect(out.confidence).toBeUndefined();
  });
});

describe('enrichmentOrFetch — drill path', () => {
  it('drills into the value JSON for sub-field refs', () => {
    const out = enrichmentOrFetch(
      { ref: 'data.calendar.evt_1.calendar_event_rollup.brief' },
      ctxWithReader(() =>
        makeRow({ value: { brief: 'meeting at noon', attendees: ['x'] } }),
      ),
    ) as { value: unknown; source: string };
    expect(out.source).toBe('enrichment');
    expect(out.value).toBe('meeting at noon');
  });

  it('drilling past undefined returns null', () => {
    const out = enrichmentOrFetch(
      { ref: 'data.calendar.evt_1.calendar_event_rollup.missing.deep' },
      ctxWithReader(() => makeRow({ value: { brief: 'x' } })),
    ) as { value: unknown; source: string };
    expect(out.source).toBe('enrichment');
    expect(out.value).toBeNull();
  });

  it('does not drill through inherited or prototype-sensitive fields', () => {
    const unsafe = JSON.parse('{"__proto__":{"polluted":"secret"},"safe":"ok"}');
    const ctor = enrichmentOrFetch(
      { ref: 'data.calendar.evt_1.calendar_event_rollup.constructor.name' },
      ctxWithReader(() => makeRow({ value: {} })),
    ) as { value: unknown; source: string };
    const proto = enrichmentOrFetch(
      { ref: 'data.calendar.evt_1.calendar_event_rollup.__proto__.polluted' },
      ctxWithReader(() => makeRow({ value: unsafe })),
    ) as { value: unknown; source: string };
    expect(ctor.source).toBe('enrichment');
    expect(ctor.value).toBeNull();
    expect(proto.source).toBe('enrichment');
    expect(proto.value).toBeNull();
  });
});
