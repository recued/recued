/** D-145 PB4 — packet shape budget enforcement tests.
 *
 *  Per § B.3.1. Validator catches packet-bytes / alternatives /
 *  rounds drift; the orchestrator policy decides whether to drop
 *  context, demote tier, or surface an `omitted_context` row. */

import { describe, it, expect } from 'vitest';

import {
  PacketShapeError,
  PACKET_SHAPE_VIOLATION_KINDS,
  assertPacketShape,
  validatePacketShape,
} from '../tier-strategy/packet-shape.js';

describe('D-145 PB4 — validatePacketShape happy path', () => {
  it('fast tier 800B packet → ok', () => {
    const r = validatePacketShape({ tier: 'fast', packet_bytes: 800 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.bytes).toBe(800);
      expect(r.tier).toBe('fast');
    }
  });

  it('mid tier 5KB packet → ok', () => {
    const r = validatePacketShape({ tier: 'mid', packet_bytes: 5_000 });
    expect(r.ok).toBe(true);
  });

  it('reasoning tier 30KB packet → ok', () => {
    const r = validatePacketShape({ tier: 'reasoning', packet_bytes: 30_000 });
    expect(r.ok).toBe(true);
  });

  it('measures packet bytes when packet supplied (no packet_bytes)', () => {
    const r = validatePacketShape({ tier: 'fast', packet: { hi: 'world' } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bytes).toBeGreaterThan(0);
  });

  it('handles UTF-8 byte length correctly', () => {
    // 'résumé' has accented chars — UTF-8 byte length > .length
    const r = validatePacketShape({ tier: 'fast', packet: 'résumé' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bytes).toBeGreaterThan(6);
  });
});

describe('D-145 PB4 — validatePacketShape violations', () => {
  it('fast tier 2KB packet → packet_oversized', () => {
    const r = validatePacketShape({ tier: 'fast', packet_bytes: 2_048 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.violations).toHaveLength(1);
      expect(r.violations[0]!.kind).toBe('packet_oversized');
      expect(r.violations[0]!.tier).toBe('fast');
      expect(r.violations[0]!.limit).toBe(1_024);
      expect(r.violations[0]!.actual).toBe(2_048);
    }
  });

  it('fast tier 3 alternatives → too_many_alternatives', () => {
    const r = validatePacketShape({
      tier: 'fast',
      packet_bytes: 100,
      alternatives_count: 3,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.violations).toHaveLength(1);
      expect(r.violations[0]!.kind).toBe('too_many_alternatives');
      expect(r.violations[0]!.limit).toBe(2);
      expect(r.violations[0]!.actual).toBe(3);
    }
  });

  it('fast tier rounds_so_far=1 → too_many_rounds (next round = 2)', () => {
    const r = validatePacketShape({
      tier: 'fast',
      packet_bytes: 100,
      rounds_so_far: 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.violations[0]!.kind).toBe('too_many_rounds');
      expect(r.violations[0]!.limit).toBe(1);
      expect(r.violations[0]!.actual).toBe(2);
    }
  });

  it('reports all 3 violations in one shot when applicable', () => {
    const r = validatePacketShape({
      tier: 'fast',
      packet_bytes: 5_000,
      alternatives_count: 9,
      rounds_so_far: 5,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.violations).toHaveLength(3);
      const kinds = new Set(r.violations.map((v) => v.kind));
      expect(kinds).toEqual(new Set(PACKET_SHAPE_VIOLATION_KINDS));
    }
  });

  it('reasoning tier 40KB packet → packet_oversized', () => {
    const r = validatePacketShape({ tier: 'reasoning', packet_bytes: 40_000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations[0]!.kind).toBe('packet_oversized');
  });

  it('mid tier 6 alternatives → too_many_alternatives', () => {
    const r = validatePacketShape({
      tier: 'mid',
      packet_bytes: 100,
      alternatives_count: 6,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.violations[0]!.limit).toBe(5);
      expect(r.violations[0]!.actual).toBe(6);
    }
  });
});

describe('D-145 PB4 — assertPacketShape (throws)', () => {
  it('throws PacketShapeError on violation', () => {
    expect(() =>
      assertPacketShape({ tier: 'fast', packet_bytes: 5_000 }),
    ).toThrow(PacketShapeError);
  });

  it('returns the ok shape on pass-through', () => {
    const r = assertPacketShape({ tier: 'mid', packet_bytes: 1_000 });
    expect(r.ok).toBe(true);
    expect(r.tier).toBe('mid');
    expect(r.bytes).toBe(1_000);
  });

  it('PacketShapeError carries violations array', () => {
    try {
      assertPacketShape({ tier: 'fast', packet_bytes: 5_000, alternatives_count: 9 });
      expect(true).toBe(false); // unreachable
    } catch (e) {
      expect(e).toBeInstanceOf(PacketShapeError);
      if (e instanceof PacketShapeError) {
        expect(e.violations).toHaveLength(2);
        expect(e.code).toBe('PACKET_SHAPE_VIOLATION');
      }
    }
  });
});
