/** D-181 Slice 2 — static op-kind → lane classification.
 *
 *  The classifier is the publish-gate-style walk: every `IngredientKind` maps
 *  to exactly one `CallClass`, and only the two real lanes contend for a slot.
 *  These pins lock the mapping so a future kind addition forces a decision. */

import { describe, expect, it } from 'vitest';
import {
  callClassForKind,
  isGatedCallClass,
  EXECUTION_LANES,
  PROGRESS_CONTRACTS,
  AUTHORABLE_PROGRESS_CONTRACTS,
  type CallClass,
} from '../execution-lane.js';
import { INGREDIENT_KINDS, type IngredientKind } from '../ingredient.js';

describe('callClassForKind', () => {
  const expected: Record<IngredientKind, CallClass> = {
    service: 'local-heavy',
    cli: 'local-heavy', // D-182 — cli subprocess shares the local-heavy lane
    ai: 'ai-governor',
    http: 'external-io',
    mcp: 'external-io',
    connection: 'external-io',
    dom: 'external-io',
    chat: 'external-io',
    storage: 'fast-path',
  };

  it('maps every kind to its decided class', () => {
    for (const [kind, cls] of Object.entries(expected)) {
      expect(callClassForKind(kind as IngredientKind)).toBe(cls);
    }
  });

  it('classifies every closed-set kind (no kind falls through)', () => {
    for (const kind of INGREDIENT_KINDS) {
      // Throws/returns undefined would fail the membership assertion below.
      const cls = callClassForKind(kind);
      expect(['local-heavy', 'external-io', 'fast-path', 'ai-governor']).toContain(cls);
    }
    // The test's `expected` table must itself cover the live closed set, so a
    // newly added kind breaks this test until it is classified above.
    expect(new Set(Object.keys(expected))).toEqual(new Set(INGREDIENT_KINDS));
  });

  it('routes the heavy local tools (service) to local-heavy', () => {
    // docling / ffmpeg / whisper / pandoc / imagemagick / codex are kind:service.
    expect(callClassForKind('service')).toBe('local-heavy');
  });

  it('keeps ai off the lanes (its own governor)', () => {
    expect(callClassForKind('ai')).toBe('ai-governor');
    expect(isGatedCallClass('ai-governor')).toBe(false);
  });
});

describe('isGatedCallClass', () => {
  it('is true for the two lanes, false for the bypass classes', () => {
    expect(isGatedCallClass('local-heavy')).toBe(true);
    expect(isGatedCallClass('external-io')).toBe(true);
    expect(isGatedCallClass('fast-path')).toBe(false);
    expect(isGatedCallClass('ai-governor')).toBe(false);
  });

  it('narrows exactly to the EXECUTION_LANES set', () => {
    const gated = (['local-heavy', 'external-io', 'fast-path', 'ai-governor'] as CallClass[]).filter(
      isGatedCallClass,
    );
    expect(new Set(gated)).toEqual(new Set(EXECUTION_LANES));
  });
});

describe('closed sets', () => {
  it('EXECUTION_LANES + PROGRESS_CONTRACTS are stable', () => {
    expect(EXECUTION_LANES).toEqual(['local-heavy', 'external-io']);
    expect(PROGRESS_CONTRACTS).toEqual(['heartbeat', 'file-growth', 'provider-event', 'silent', 'resource']);
    // D-274 § 6a — the AUTHORABLE set is a DIFFERENT closed list and must stay
    // short by one. Pinning both is the point: a future member added to the
    // runtime list without a deliberate decision about declarability shows up
    // here as a red, not as a silently-widened publish surface.
    expect(AUTHORABLE_PROGRESS_CONTRACTS).toEqual(['heartbeat', 'file-growth', 'provider-event', 'silent']);
    expect(AUTHORABLE_PROGRESS_CONTRACTS).not.toContain('resource');
  });
});
