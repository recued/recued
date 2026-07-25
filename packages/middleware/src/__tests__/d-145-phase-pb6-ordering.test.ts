/** D-145 PB6 — composer ordering rules tests.
 *
 *  Covers § B.7.8:
 *    1. Resolutions before extractions that reference them
 *    2. Extractions before derived effects
 *    3. Stable order for same-class events (preserves AI-returned order) */

import { describe, expect, it } from 'vitest';

import type { ExtractionEvent } from '@recued/contracts';

import {
  orderEvents,
  orderExtractionEvents,
} from '../ai-output/ordering.js';

const ev = (
  kind: ExtractionEvent['kind'],
  confidence = 0.9,
  source_message_id?: string,
): ExtractionEvent => ({
  kind,
  confidence,
  args: {},
  ...(source_message_id !== undefined ? { source_message_id } : {}),
});

describe('D-145 PB6 — § B.7.8 rule 1 (resolutions before extractions)', () => {
  it('reorders extraction-then-resolution to resolution-then-extraction', () => {
    const events = [
      ev('extraction.commitment'),
      ev('resolution.alias'),
    ];
    const ordered = orderExtractionEvents(events);
    expect(ordered.map((e) => e.kind)).toEqual([
      'resolution.alias',
      'extraction.commitment',
    ]);
  });

  it('all three resolution kinds precede extractions', () => {
    const events = [
      ev('extraction.purchase'),
      ev('resolution.network_domain_inferred'),
      ev('extraction.commitment'),
      ev('resolution.contact_created_mention_only'),
      ev('extraction.task'),
      ev('resolution.alias'),
    ];
    const ordered = orderExtractionEvents(events);
    const classes = ordered.map((e) =>
      e.kind.startsWith('resolution.') ? 'resolution' : 'extraction',
    );
    // First three must be resolutions, last three must be extractions.
    expect(classes.slice(0, 3)).toEqual([
      'resolution',
      'resolution',
      'resolution',
    ]);
    expect(classes.slice(3, 6)).toEqual([
      'extraction',
      'extraction',
      'extraction',
    ]);
  });
});

describe('D-145 PB6 — § B.7.8 rule 3 (stable order within class)', () => {
  it('preserves original input order for same-class events', () => {
    const events = [
      ev('extraction.commitment'),
      ev('extraction.purchase'),
      ev('extraction.task'),
    ];
    const ordered = orderExtractionEvents(events);
    expect(ordered.map((e) => e.kind)).toEqual([
      'extraction.commitment',
      'extraction.purchase',
      'extraction.task',
    ]);
  });

  it('preserves resolution order when only resolutions present', () => {
    const events = [
      ev('resolution.contact_created_mention_only'),
      ev('resolution.alias'),
      ev('resolution.network_domain_inferred'),
    ];
    const ordered = orderExtractionEvents(events);
    expect(ordered.map((e) => e.kind)).toEqual([
      'resolution.contact_created_mention_only',
      'resolution.alias',
      'resolution.network_domain_inferred',
    ]);
  });

  it('mixed run preserves within-class order while sorting across classes', () => {
    const events = [
      ev('extraction.purchase'),
      ev('resolution.alias'),
      ev('extraction.commitment'),
      ev('resolution.network_domain_inferred'),
      ev('extraction.task'),
    ];
    const ordered = orderExtractionEvents(events);
    expect(ordered.map((e) => e.kind)).toEqual([
      'resolution.alias',
      'resolution.network_domain_inferred',
      'extraction.purchase',
      'extraction.commitment',
      'extraction.task',
    ]);
  });
});

describe('D-145 PB6 — orderEvents over arbitrary item shapes', () => {
  it('accepts a kindOf accessor for non-ExtractionEvent items', () => {
    interface Wrapper {
      readonly inner: ExtractionEvent;
      readonly tag: string;
    }
    const wrappers: Wrapper[] = [
      { inner: ev('extraction.commitment'), tag: 'a' },
      { inner: ev('resolution.alias'), tag: 'b' },
    ];
    const ordered = orderEvents(wrappers, (w) => w.inner.kind);
    expect(ordered.map((w) => w.tag)).toEqual(['b', 'a']);
  });

  it('returns an empty array on empty input', () => {
    expect(orderExtractionEvents([])).toEqual([]);
  });

  it('does not mutate the input array (pure)', () => {
    const events: ExtractionEvent[] = [
      ev('extraction.commitment'),
      ev('resolution.alias'),
    ];
    const before = events.map((e) => e.kind);
    orderExtractionEvents(events);
    expect(events.map((e) => e.kind)).toEqual(before);
  });
});

describe('D-145 PB6 — § B.7.8 ordering rule worked example', () => {
  it('the § B.7.6 sample message orders correctly', () => {
    // From § B.7.6: "I bought a car today" with mom-resolution.
    const events = [
      ev('extraction.purchase', 0.95, 'msg-7'),
      ev('resolution.alias', 0.99, 'msg-7'),
      ev('extraction.plan', 0.88, 'msg-7'),
      ev('extraction.commitment_status_check', 0.78, 'msg-7'),
    ];
    const ordered = orderExtractionEvents(events);
    expect(ordered.map((e) => e.kind)).toEqual([
      'resolution.alias',
      'extraction.purchase',
      'extraction.plan',
      'extraction.commitment_status_check',
    ]);
  });
});
