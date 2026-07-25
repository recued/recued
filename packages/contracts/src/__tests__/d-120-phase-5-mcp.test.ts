/** D-120 Phase 5 — MCP timeline contracts tests.
 *
 *  Covers:
 *    - parseTimelineEntityId: shape gate + first-colon split
 *    - formatTimelineEntityId: round-trips with parse
 *    - clampTimelineLimit: bounds + default
 *    - encode/decode cursor: round-trip + malformed handling
 *    - timelineEntryKey: composition + uniqueness shape
 *    - isTimelineSource: closed-set predicate
 */

import { describe, expect, it } from 'vitest';
import {
  TIMELINE_DEFAULT_LIMIT,
  TIMELINE_MAX_LIMIT,
  TIMELINE_SOURCES,
  isTimelineSource,
  parseTimelineEntityId,
  formatTimelineEntityId,
  clampTimelineLimit,
  encodeTimelineCursor,
  decodeTimelineCursor,
  timelineEntryKey,
} from '../mcp.js';

describe('parseTimelineEntityId', () => {
  it('parses the canonical <collection>:<id> shape', () => {
    expect(parseTimelineEntityId('mail:msg-abc123')).toEqual({
      collection: 'mail',
      id: 'msg-abc123',
    });
    expect(parseTimelineEntityId('deal:hubspot-42')).toEqual({
      collection: 'deal',
      id: 'hubspot-42',
    });
  });

  it('splits on the FIRST colon — preserves colons inside the id', () => {
    // RFC-822 message-ids legitimately contain colons in the local-part.
    expect(parseTimelineEntityId('mail:<abc@example.com>')).toEqual({
      collection: 'mail',
      id: '<abc@example.com>',
    });
    expect(parseTimelineEntityId('service:slack:xoxb-token')).toEqual({
      collection: 'service',
      id: 'slack:xoxb-token',
    });
  });

  it('returns null for missing colon', () => {
    expect(parseTimelineEntityId('msg-abc123')).toBeNull();
    expect(parseTimelineEntityId('mailmsg-abc')).toBeNull();
  });

  it('returns null for empty collection or empty id', () => {
    expect(parseTimelineEntityId(':msg-abc')).toBeNull();
    expect(parseTimelineEntityId('mail:')).toBeNull();
    expect(parseTimelineEntityId(':')).toBeNull();
    expect(parseTimelineEntityId('')).toBeNull();
  });

  it('returns null for non-string inputs', () => {
    expect(parseTimelineEntityId(undefined as unknown as string)).toBeNull();
    expect(parseTimelineEntityId(null as unknown as string)).toBeNull();
    expect(parseTimelineEntityId(42 as unknown as string)).toBeNull();
  });
});

describe('formatTimelineEntityId', () => {
  it('joins (collection, id) with a colon', () => {
    expect(formatTimelineEntityId('mail', 'msg-1')).toBe('mail:msg-1');
  });

  it('round-trips through parseTimelineEntityId', () => {
    const cases = [
      { collection: 'mail', id: 'msg-1' },
      { collection: 'deal', id: 'hubspot-42' },
      { collection: 'mail', id: '<abc@example.com>' },
    ];
    for (const c of cases) {
      const formatted = formatTimelineEntityId(c.collection, c.id);
      expect(parseTimelineEntityId(formatted)).toEqual(c);
    }
  });
});

describe('clampTimelineLimit', () => {
  it('returns the default for undefined', () => {
    expect(clampTimelineLimit(undefined)).toBe(TIMELINE_DEFAULT_LIMIT);
  });

  it('returns the default for non-positive / non-finite values', () => {
    expect(clampTimelineLimit(0)).toBe(TIMELINE_DEFAULT_LIMIT);
    expect(clampTimelineLimit(-5)).toBe(TIMELINE_DEFAULT_LIMIT);
    expect(clampTimelineLimit(NaN)).toBe(TIMELINE_DEFAULT_LIMIT);
    expect(clampTimelineLimit(Infinity)).toBe(TIMELINE_DEFAULT_LIMIT);
  });

  it('clamps to TIMELINE_MAX_LIMIT for over-cap requests', () => {
    expect(clampTimelineLimit(TIMELINE_MAX_LIMIT + 1)).toBe(TIMELINE_MAX_LIMIT);
    expect(clampTimelineLimit(10_000)).toBe(TIMELINE_MAX_LIMIT);
  });

  it('passes finite values within bounds through unchanged', () => {
    expect(clampTimelineLimit(1)).toBe(1);
    expect(clampTimelineLimit(50)).toBe(50);
    expect(clampTimelineLimit(TIMELINE_DEFAULT_LIMIT)).toBe(TIMELINE_DEFAULT_LIMIT);
    expect(clampTimelineLimit(TIMELINE_MAX_LIMIT)).toBe(TIMELINE_MAX_LIMIT);
  });

  it('floors fractional values', () => {
    expect(clampTimelineLimit(7.9)).toBe(7);
    expect(clampTimelineLimit(99.999)).toBe(99);
  });
});

describe('encode/decode cursor', () => {
  it('round-trips a typical cursor', () => {
    const cursor = { last_ts: 1_700_000_000_000, last_key: 'memory:execution.action:run-1:execution.action:1700000000000' };
    const encoded = encodeTimelineCursor(cursor);
    expect(typeof encoded).toBe('string');
    expect(encoded.length).toBeGreaterThan(0);
    expect(decodeTimelineCursor(encoded)).toEqual(cursor);
  });

  it('produces a base64url payload (no +, /, =)', () => {
    const encoded = encodeTimelineCursor({ last_ts: 1, last_key: 'x' });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('round-trips with non-ASCII / colons in the key', () => {
    const cursor = { last_ts: 99, last_key: 'mail:received:<id@日本.com>' };
    const encoded = encodeTimelineCursor(cursor);
    expect(decodeTimelineCursor(encoded)).toEqual(cursor);
  });

  it('returns null on garbage input', () => {
    expect(decodeTimelineCursor('!!!not-base64!!!')).toBeNull();
    expect(decodeTimelineCursor('')).toBeNull();
    expect(decodeTimelineCursor('e30=')).toBeNull(); // empty object — missing v
  });

  it('returns null on wrong cursor version', () => {
    // Hand-craft a cursor with v: "v0" (unknown version).
    const bad = btoa(JSON.stringify({ v: 'v0', last_ts: 1, last_key: 'x' }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeTimelineCursor(bad)).toBeNull();
  });

  it('returns null when last_ts is missing or non-number', () => {
    const bad1 = btoa(JSON.stringify({ v: 'v1', last_key: 'x' }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const bad2 = btoa(JSON.stringify({ v: 'v1', last_ts: 'abc', last_key: 'x' }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeTimelineCursor(bad1)).toBeNull();
    expect(decodeTimelineCursor(bad2)).toBeNull();
  });
});

describe('timelineEntryKey', () => {
  it('joins (source, kind, id) with colon separators', () => {
    expect(timelineEntryKey('memory', 'execution.action', 'run-1')).toBe(
      'memory:execution.action:run-1',
    );
    expect(timelineEntryKey('annotation', 'summary', 'ann-id')).toBe(
      'annotation:summary:ann-id',
    );
  });

  it('produces a deterministic, sortable string', () => {
    // Same inputs → same key.
    const a = timelineEntryKey('memory', 'execution.action', 'run-1');
    const b = timelineEntryKey('memory', 'execution.action', 'run-1');
    expect(a).toBe(b);
  });
});

describe('isTimelineSource', () => {
  it('accepts every value in TIMELINE_SOURCES', () => {
    for (const s of TIMELINE_SOURCES) {
      expect(isTimelineSource(s)).toBe(true);
    }
  });

  it('rejects unknown strings + non-strings', () => {
    expect(isTimelineSource('unknown')).toBe(false);
    expect(isTimelineSource('contact')).toBe(false); // not in the closed set
    expect(isTimelineSource(undefined)).toBe(false);
    expect(isTimelineSource(null)).toBe(false);
    expect(isTimelineSource(42)).toBe(false);
  });
});
