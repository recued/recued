/** Lever-2 (2026-07-02) — index-mode catalog delivery: pure-helper ratchets.
 *
 * Covers the two exported pure helpers that back the prototype catalog
 * knob (`RECUED_CHAT_CATALOG_MODE=index`): the env parser and the
 * word-safe description truncator. The projection behaviour itself
 * (index mode leans Tier-2 only, Tier-1/Tier-3 stay full, and the lean
 * shape reaches the serialized main-turn packet) is pinned end-to-end
 * through the real orchestrator in
 * `d-164-phase-6-3-chat-orchestrator-ratchet.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { CHAT_CATALOG_DELIVERY_MODES } from '@recued/contracts';
import {
  anyCatalogModeUsesToolsSearch,
  catalogModeUsesToolsSearch,
  CHAT_CATALOG_SMART_DEFAULT_BY_SOURCE,
  DEFAULT_CHAT_CATALOG_PROJECTION,
  parseChatCatalogProjectionEnv,
  resolveCatalogModeForSource,
  resolveCatalogProjectionForSource,
  resolveCatalogSource,
  truncateForIndex,
} from '../chat-orchestrator.js';

describe('Lever-2 parseChatCatalogProjectionEnv', () => {
  const indexEnv = (max?: string): Record<string, string | undefined> => ({
    RECUED_CHAT_CATALOG_MODE: 'index',
    ...(max !== undefined ? { RECUED_CHAT_CATALOG_INDEX_DESC_MAX: max } : {}),
  });

  it('defaults to full mode when the mode var is absent', () => {
    expect(parseChatCatalogProjectionEnv({})).toEqual({ mode: 'full' });
    expect(DEFAULT_CHAT_CATALOG_PROJECTION).toEqual({ mode: 'full' });
  });

  it('treats any non-"index" mode value as the full baseline', () => {
    // Mutation caught: a loose/substring mode match would leak into index mode.
    expect(parseChatCatalogProjectionEnv({ RECUED_CHAT_CATALOG_MODE: 'full' })).toEqual({
      mode: 'full',
    });
    expect(parseChatCatalogProjectionEnv({ RECUED_CHAT_CATALOG_MODE: 'INDEX' })).toEqual({
      mode: 'full',
    });
    expect(parseChatCatalogProjectionEnv({ RECUED_CHAT_CATALOG_MODE: 'index-lean' })).toEqual({
      mode: 'full',
    });
    expect(parseChatCatalogProjectionEnv({ RECUED_CHAT_CATALOG_MODE: '' })).toEqual({
      mode: 'full',
    });
  });

  it('enables index mode with no cap when the desc-max var is absent', () => {
    expect(parseChatCatalogProjectionEnv(indexEnv())).toEqual({ mode: 'index' });
  });

  it('accepts a positive integer cap (whitespace-trimmed)', () => {
    expect(parseChatCatalogProjectionEnv(indexEnv('120'))).toEqual({
      mode: 'index',
      indexDescriptionMaxChars: 120,
    });
    expect(parseChatCatalogProjectionEnv(indexEnv(' 88 '))).toEqual({
      mode: 'index',
      indexDescriptionMaxChars: 88,
    });
  });

  it('rejects non-integer / malformed caps whole (strict Number parse, no partial truncation)', () => {
    // Mutation caught: a `parseInt` regression silently turns "12.5"/"12abc" into cap 12.
    for (const bad of ['12.5', '12abc', '1e309', '0', '-5', 'abc', '', '  ']) {
      expect(parseChatCatalogProjectionEnv(indexEnv(bad))).toEqual({ mode: 'index' });
    }
  });

  it('enables lean-core (v2) mode on RECUED_CHAT_CATALOG_MODE=lean-core', () => {
    expect(parseChatCatalogProjectionEnv({ RECUED_CHAT_CATALOG_MODE: 'lean-core' })).toEqual({
      mode: 'lean-core',
    });
  });

  it('lean-core IGNORES the desc-max var (it drops Tier-2 wholesale — no descriptions to cap)', () => {
    // Mutation caught: lean-core erroneously carrying an indexDescriptionMaxChars
    // (meaningless — there are no Tier-2 entries to truncate).
    expect(
      parseChatCatalogProjectionEnv({
        RECUED_CHAT_CATALOG_MODE: 'lean-core',
        RECUED_CHAT_CATALOG_INDEX_DESC_MAX: '120',
      }),
    ).toEqual({ mode: 'lean-core' });
  });

  it('treats near-miss lean-core mode values as the full baseline (exact match only)', () => {
    // Mutation caught: a loose/substring/case-insensitive match leaking into lean-core.
    for (const bad of ['LEAN-CORE', 'lean', 'lean_core', 'leancore', 'lean-core-x', ' lean-core']) {
      expect(parseChatCatalogProjectionEnv({ RECUED_CHAT_CATALOG_MODE: bad })).toEqual({
        mode: 'full',
      });
    }
  });
});

describe('Lever-2 catalogModeUsesToolsSearch (the gate the wire + guidance composer share)', () => {
  it('is false ONLY for full mode — every thinning mode injects + guides tools.search', () => {
    // The wire's tools.search `enabled` gate and the system-prompt guidance
    // composer BOTH key on this predicate; they must not drift. full = no
    // thinning, no tool, no guidance; index + lean-core both thin + inject.
    expect(catalogModeUsesToolsSearch('full')).toBe(false);
    expect(catalogModeUsesToolsSearch('index')).toBe(true);
    expect(catalogModeUsesToolsSearch('lean-core')).toBe(true);
  });
});

describe('Lever-2 truncateForIndex', () => {
  it('returns the text unchanged when within the cap', () => {
    expect(truncateForIndex('hello world', 120)).toBe('hello world');
    expect(truncateForIndex('abcde', 5)).toBe('abcde');
  });

  it('returns the text unchanged for a non-positive cap', () => {
    expect(truncateForIndex('anything', 0)).toBe('anything');
    expect(truncateForIndex('anything', -3)).toBe('anything');
  });

  it('backs up to the last word boundary and ellipsizes', () => {
    // 'alpha beta gamma delta' capped at 12 → hard 'alpha beta g', last space at 10
    // (>= floor(12*0.6)=7) → cut 'alpha beta' → 'alpha beta…'
    expect(truncateForIndex('alpha beta gamma delta', 12)).toBe('alpha beta…');
  });

  it('hard-cuts a single long token when no usable word boundary exists', () => {
    // No space in the budget window → hard slice + ellipsis.
    expect(truncateForIndex('supercalifragilisticexpialidocious', 10)).toBe('supercalif…');
  });

  it('never emits a lone surrogate when the cut splits a non-BMP character', () => {
    // Mutation caught: dropping the surrogate guard leaves a broken code point.
    const withEmoji = 'ab\u{1F600}cd'; // 6 UTF-16 code units, emoji spans units 2-3
    const out = truncateForIndex(withEmoji, 3); // cut lands mid-surrogate
    expect(out).toBe('ab…');
    // No unpaired high surrogate survives.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
  });

  it('is deterministic (byte-stable) across calls — safe inside the cacheable prefix', () => {
    const long = 'Draft a personalized follow-up email to a HubSpot contact after a meeting';
    expect(truncateForIndex(long, 40)).toBe(truncateForIndex(long, 40));
  });
});

// ── Lever-2 per-slot — resolve the catalog mode/projection from the LLM source ──

describe('Lever-2 resolveCatalogModeForSource (per-slot precedence)', () => {
  const smart = CHAT_CATALOG_SMART_DEFAULT_BY_SOURCE;

  it('smart-default map: every source thins to index', () => {
    // Rationale lock (2026-07-26): the old split kept BYOK on `full` because
    // "the prefix is nearly free after call 1" — true, but that compares
    // full-cached to full-UNCACHED, never to `index`, which ALSO caches. A
    // same-bundle A/B over the 33-task llm lane measured index at 98%
    // cache-served on a BYOK slot (36,852 input/call vs full's ~82,014),
    // −49.9% input lane-wide, with discovery holding and `tools.search` at 0.
    expect(smart).toEqual({ free_pool: 'index', slot_1: 'index', slot_2: 'index' });
  });

  it('explicit per-source override wins over everything', () => {
    expect(
      resolveCatalogModeForSource('slot_1', { slot_1: 'lean-core' }, {
        smartDefaults: true,
        envGlobalMode: 'index',
      }),
    ).toBe('lean-core');
  });

  it('smart default applies for a KNOWN source only when the flag is on', () => {
    expect(
      resolveCatalogModeForSource('free_pool', undefined, { smartDefaults: true }),
    ).toBe('index'); // smart default
    expect(
      resolveCatalogModeForSource('free_pool', undefined, {
        smartDefaults: false,
        envGlobalMode: 'full',
      }),
    ).toBe('full'); // flag off → env-global, NOT the smart default
    expect(
      resolveCatalogModeForSource('slot_1', undefined, { smartDefaults: true }),
    ).toBe('index'); // BYOK now thins too — a REAL assertion since 2026-07-26
    expect(
      resolveCatalogModeForSource('slot_1', undefined, {
        smartDefaults: false,
        envGlobalMode: 'full',
      }),
    ).toBe('full'); // flag off → env-global, NOT the smart default
  });

  it('falls to env-global then full when no override / no smart default', () => {
    expect(
      resolveCatalogModeForSource('slot_2', undefined, {
        smartDefaults: false,
        envGlobalMode: 'index',
      }),
    ).toBe('index'); // env-global fallback
    expect(
      resolveCatalogModeForSource('slot_2', undefined, { smartDefaults: false }),
    ).toBe('full'); // ultimate default
  });

  it('an UNDEFINED/unpinned source NEVER thins via smart default (conservative)', () => {
    // Mutation caught: applying the smart default to an unknown source. We
    // can't predict which slot the matcher lands on, so an unpinned turn must
    // fall to env-global / full, never the (free-pool) smart default.
    expect(
      resolveCatalogModeForSource(undefined, undefined, { smartDefaults: true }),
    ).toBe('full');
    expect(
      resolveCatalogModeForSource(undefined, { free_pool: 'index' }, {
        smartDefaults: true,
        envGlobalMode: 'lean-core',
      }),
    ).toBe('lean-core'); // env-global, not a per-source override (source unknown)
  });
});

describe('Lever-2 resolveCatalogProjectionForSource', () => {
  it('wraps the resolved mode into a projection; index-desc-cap only for index', () => {
    expect(
      resolveCatalogProjectionForSource('free_pool', undefined, {
        smartDefaults: true,
        indexDescriptionMaxChars: 120,
      }),
    ).toEqual({ mode: 'index', indexDescriptionMaxChars: 120 });
    // A BYOK slot now ALSO smart-defaults to index, cap included.
    expect(
      resolveCatalogProjectionForSource('slot_1', undefined, {
        smartDefaults: true,
        indexDescriptionMaxChars: 120,
      }),
    ).toEqual({ mode: 'index', indexDescriptionMaxChars: 120 });
    // full / lean-core carry no desc cap even if one is passed. `full` is no
    // longer any source's default, so reach it through an explicit override —
    // otherwise this stops asserting the cap rule at all.
    expect(
      resolveCatalogProjectionForSource('slot_1', { slot_1: 'full' }, {
        smartDefaults: true,
        indexDescriptionMaxChars: 120,
      }),
    ).toEqual({ mode: 'full' });
    expect(
      resolveCatalogProjectionForSource('slot_2', { slot_2: 'lean-core' }, {
        smartDefaults: false,
        indexDescriptionMaxChars: 120,
      }),
    ).toEqual({ mode: 'lean-core' });
  });
});

describe('Lever-2 anyCatalogModeUsesToolsSearch (the wire enable gate)', () => {
  it('true iff at least one mode thins', () => {
    expect(anyCatalogModeUsesToolsSearch(['full'])).toBe(false);
    expect(anyCatalogModeUsesToolsSearch(['full', 'full'])).toBe(false);
    expect(anyCatalogModeUsesToolsSearch(['full', 'index'])).toBe(true);
    expect(anyCatalogModeUsesToolsSearch(['lean-core'])).toBe(true);
    expect(anyCatalogModeUsesToolsSearch([])).toBe(false);
  });

  it('Phase 2 enable-always — the full possible-modes set the wire passes enables', () => {
    // The wire passes `CHAT_CATALOG_DELIVERY_MODES` (every mode a source could
    // take live) so the tools.search wrapper is always enabled. This locks that
    // the chosen constant actually enables — a regression (e.g. narrowing it to
    // `['full']`) would strand a live-flipped leaned turn with an un-dispatchable
    // tool.
    expect(anyCatalogModeUsesToolsSearch(CHAT_CATALOG_DELIVERY_MODES)).toBe(true);
  });
});

describe('Lever-2 resolveCatalogSource (mirror the executor pin — catalog thins the routed model)', () => {
  it('free_pool layer → free_pool (regardless of a stale session slot pin)', () => {
    // Codex HIGH reverse case: session slot_1, caller overrides layer to
    // free_pool → the turn routes the pool, so the catalog source is free_pool
    // (→ index), NOT the stale slot_1 (→ full).
    expect(resolveCatalogSource('free_pool', 'slot_1')).toBe('free_pool');
    expect(resolveCatalogSource('free_pool', undefined)).toBe('free_pool');
    expect(resolveCatalogSource('free_pool', 'free_pool')).toBe('free_pool');
  });

  it('byok layer + a slot source → that slot (the executor pin fires)', () => {
    expect(resolveCatalogSource('byok', 'slot_1')).toBe('slot_1');
    expect(resolveCatalogSource('byok', 'slot_2')).toBe('slot_2');
  });

  it('byok layer + a NON-slot source → undefined (byok-unpinned → conservative)', () => {
    // Codex HIGH forward case: session free_pool, caller overrides layer to byok
    // → the turn routes byok UNPINNED, so the catalog must NOT thin from the
    // stale free_pool source; undefined → env/full.
    expect(resolveCatalogSource('byok', 'free_pool')).toBeUndefined();
    expect(resolveCatalogSource('byok', undefined)).toBeUndefined();
  });

  it('an undefined layer → undefined (no assumption)', () => {
    expect(resolveCatalogSource(undefined, 'slot_1')).toBeUndefined();
  });

  it('end-to-end: a byok-unpinned turn does NOT thin from a stale free_pool source', () => {
    // The composed guarantee: resolveCatalogSource(byok, free_pool) → undefined,
    // then resolveCatalogModeForSource(undefined, …) → env/full, never index.
    const src = resolveCatalogSource('byok', 'free_pool');
    expect(resolveCatalogModeForSource(src, undefined, { smartDefaults: true })).toBe('full');
  });
});
