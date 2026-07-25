/** D-120 Phase 1 — memory + provenance contracts.
 *
 *  Phase 1 ships:
 *    - Memory constants (retention default, read permission slug,
 *      output_string cap, recipe_insight flattened cap)
 *    - LinkKind taxonomy + LINK_KINDS constant + isLinkKind guard
 *    - LinkEmissionRule interface (consumed by Phase 3 shouldLink)
 *
 *  Tests cover constant values, kind guard correctness, and round-trip
 *  shape of the LinkEmissionRule type. Schema migration tests live
 *  alongside the server (`backend/server/src/__tests__/memory-schema.test.ts`).
 */

import { describe, expect, it } from 'vitest';
import {
  AUDIT_OUTPUT_STRING_MAX,
  LINK_KINDS,
  MEMORY_READ_PERMISSION,
  MEMORY_RETENTION_DEFAULT_DAYS,
  RECIPE_INSIGHT_FLATTENED_MAX_BYTES,
  isLinkKind,
  type LinkEmissionRule,
  type LinkKind,
} from '../index.js';

describe('D-120 Phase 1 — memory constants', () => {
  it('defaults retention to null — auto-prune off out of the box (post-D-120)', () => {
    expect(MEMORY_RETENTION_DEFAULT_DAYS).toBe(null);
  });

  it('exposes the read_memory permission slug for the staged-trust gate', () => {
    expect(MEMORY_READ_PERMISSION).toBe('read_memory');
  });

  it('caps output_string at 280 chars (tweet-length outcome summary)', () => {
    expect(AUDIT_OUTPUT_STRING_MAX).toBe(280);
  });

  it('caps recipe_insight.flattened at 16 KiB (bounded average ~1-3 KB)', () => {
    expect(RECIPE_INSIGHT_FLATTENED_MAX_BYTES).toBe(16_384);
  });
});

describe('D-120 Phase 1 — LinkKind taxonomy', () => {
  it('enumerates the three engine-emitted kinds in stable order', () => {
    expect(LINK_KINDS).toEqual([
      'execution.action',
      'execution.derived',
      'execution.write',
    ]);
  });

  it('isLinkKind accepts every defined kind', () => {
    for (const kind of LINK_KINDS) {
      expect(isLinkKind(kind)).toBe(true);
    }
  });

  it('isLinkKind rejects unknown strings, null, undefined, and non-strings', () => {
    expect(isLinkKind('execution.unknown')).toBe(false);
    expect(isLinkKind('execution.action.extra')).toBe(false);
    expect(isLinkKind('')).toBe(false);
    expect(isLinkKind(null)).toBe(false);
    expect(isLinkKind(undefined)).toBe(false);
    expect(isLinkKind(0)).toBe(false);
    expect(isLinkKind({ kind: 'execution.action' })).toBe(false);
  });
});

describe('D-120 Phase 1 — LinkEmissionRule shape', () => {
  it('admits empty emit_kinds (sidecar-collection sentinel)', () => {
    const rule: LinkEmissionRule = { collection: 'annotations', emit_kinds: [] };
    expect(rule.emit_kinds).toHaveLength(0);
  });

  it('carries the union narrowed to the LinkKind taxonomy', () => {
    const rule: LinkEmissionRule = {
      collection: 'mail',
      emit_kinds: ['execution.action', 'execution.derived'],
    };
    const kinds: readonly LinkKind[] = rule.emit_kinds;
    expect(kinds.every(isLinkKind)).toBe(true);
  });
});
