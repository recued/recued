/** Settings → global chat behaviour projection.
 *
 *  ⛔ THE CASE THAT MATTERS IS `'mixed'`, AND IT IS EASY TO GET WRONG IN BOTH
 *  DIRECTIONS. Catalog mode is stored PER SOURCE plus a smart default; there is
 *  no global value. Reporting one source's mode as "the" mode misstates what
 *  the server will send, and reporting `'mixed'` over sources that do not exist
 *  misstates it the other way. */

import { describe, expect, it } from 'vitest';

import {
  buildChatBehaviourModel,
  chatCatalogGlobalWriteTargets,
  CHAT_CATALOG_MODE_LABELS,
} from '../settings/chat-behaviour.js';

const byokSlot = (over: Record<string, unknown> = {}) => ({
  provider: 'openai-compatible',
  model: 'qwen3.7-plus',
  has_key: true,
  ...over,
});

describe('global chat behaviour projection', () => {
  it('is loading until BOTH the brief snapshot and the LLM config arrive', () => {
    expect(buildChatBehaviourModel(null, {}).kind).toBe('loading');
    expect(buildChatBehaviourModel({ enabled: true }, null).kind).toBe('loading');
    // A source-less config is `{}`, never null — so this must RESOLVE.
    expect(buildChatBehaviourModel({ enabled: true }, {}).kind).toBe('resolved');
  });

  it('reports the rolling brief straight from the snapshot', () => {
    const on = buildChatBehaviourModel({ enabled: true }, {});
    const off = buildChatBehaviourModel({ enabled: false }, {});
    expect(on.kind === 'resolved' && on.rolling_brief).toBe(true);
    expect(off.kind === 'resolved' && off.rolling_brief).toBe(false);
  });

  it('a non-boolean `enabled` is LOADING, never a silent false', () => {
    // The webclient projects server state; inventing `false` here would render
    // the brief as off on a server where it is on.
    expect(buildChatBehaviourModel({ enabled: 'yes' }, {}).kind).toBe('loading');
    expect(buildChatBehaviourModel({}, {}).kind).toBe('loading');
  });

  it('one configured slot on the smart default reads lean-core, not mixed', () => {
    const m = buildChatBehaviourModel({ enabled: true }, { slot_1: byokSlot() });
    expect(m.kind === 'resolved' && m.catalog_mode).toBe('lean-core');
    expect(m.kind === 'resolved' && m.catalog_by_source).toHaveLength(1);
  });

  /** ⛔ THE REGRESSION THIS PINS. A first cut counted a slot as configured on
   *  `model !== undefined`, so a half-filled slot_2 (no key) became a second
   *  source — and since it had no override it could disagree with slot_1 and
   *  turn a uniform server `'mixed'`. */
  it('a half-configured slot is NOT a source', () => {
    const m = buildChatBehaviourModel(
      { enabled: true },
      {
        slot_1: byokSlot(),
        slot_2: { provider: 'openai-compatible', model: 'x' }, // no has_key
        catalog_modes: { slot_2: 'full' },
      },
    );
    expect(m.kind === 'resolved' && m.catalog_by_source.map((b) => b.source_id))
      .toEqual(['slot_1']);
    expect(m.kind === 'resolved' && m.catalog_mode).toBe('lean-core');
  });

  it('reports mixed when two REAL sources disagree, and says which', () => {
    const m = buildChatBehaviourModel(
      { enabled: true },
      {
        slot_1: byokSlot(),
        slot_2: byokSlot({ model: 'other' }),
        catalog_modes: { slot_2: 'full' },
      },
    );
    expect(m.kind === 'resolved' && m.catalog_mode).toBe('mixed');
    if (m.kind !== 'resolved') throw new Error('unreachable');
    expect(m.catalog_by_source).toEqual([
      { source_id: 'slot_1', mode: 'lean-core', overridden: false },
      { source_id: 'slot_2', mode: 'full', overridden: true },
    ]);
  });

  it('an override that AGREES with the default is uniform, but still flagged', () => {
    // `overridden` is what an owner must clear to return to smart-default
    // tracking, so it stays true even when the value happens to match today.
    const m = buildChatBehaviourModel(
      { enabled: true },
      { slot_1: byokSlot(), catalog_modes: { slot_1: 'lean-core' } },
    );
    expect(m.kind === 'resolved' && m.catalog_mode).toBe('lean-core');
    expect(m.kind === 'resolved' && m.catalog_by_source[0]?.overridden).toBe(true);
  });

  it('smart defaults off drops every un-overridden source to full', () => {
    const m = buildChatBehaviourModel(
      { enabled: true },
      { slot_1: byokSlot(), slot_2: byokSlot({ model: 'b' }) },
      false,
    );
    expect(m.kind === 'resolved' && m.catalog_mode).toBe('full');
  });

  it('a malformed stored mode falls back to the default, not to a raw slug', () => {
    const m = buildChatBehaviourModel(
      { enabled: true },
      { slot_1: byokSlot(), catalog_modes: { slot_1: 'turbo' } },
    );
    expect(m.kind === 'resolved' && m.catalog_mode).toBe('lean-core');
    expect(m.kind === 'resolved' && m.catalog_by_source[0]?.overridden).toBe(false);
  });

  it('a global write targets EVERY configured source, including agreeing ones', () => {
    const m = buildChatBehaviourModel(
      { enabled: true },
      { slot_1: byokSlot(), slot_2: byokSlot({ model: 'b' }) },
    );
    expect(chatCatalogGlobalWriteTargets(m)).toEqual(['slot_1', 'slot_2']);
    expect(chatCatalogGlobalWriteTargets({ kind: 'loading' })).toEqual([]);
  });

  it('every mode the projection can report has owner-facing copy', () => {
    for (const mode of ['full', 'index', 'lean-core', 'mixed'] as const) {
      expect(CHAT_CATALOG_MODE_LABELS[mode]).toBeTruthy();
    }
  });
});
