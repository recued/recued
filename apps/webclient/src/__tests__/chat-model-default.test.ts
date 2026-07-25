/** D-174 R28 Slice A — global model-default projection (source_id form).
 *
 *  Acceptance:
 *    - buildChatModelDefaultModel(snapshot, config) resolves to the CONFIGURED
 *      source options and marks the stored default's source `selected` by EXACT
 *      `source_id === option.id` (no lossy layer fallback)
 *    - snapshot not loaded (null/undefined) OR config not loaded (null) →
 *      `loading`; config loaded with NO configured source → `empty` (the
 *      defect-fix discriminator, distinct from `loading`)
 *    - an absent / off-list stored source_id → resolved-but-not-`matched`
 *      (the page fails loud)
 *    - reduceChatDefaultModelPrefChanged rebuilds from the broadcast event's
 *      source_id
 */

import { describe, it, expect } from 'vitest';

import {
  buildChatModelDefaultModel,
  reduceChatDefaultModelPrefChanged,
  type ChatModelDefaultRenderModel,
} from '../settings/chat-model-default.js';

// D-174 R28 Slice B — a configured BYOK slot carries `has_key: true` (the wire
// redacts the secret), which is what `readLlmSlotDetail` gates "configured" on.
const config = {
  slot_1: { provider: 'anthropic', model: 'claude', has_key: true },
  slot_2: { provider: 'openai', model: 'gpt', has_key: true },
  free_pool: [{ id: 'groq', enabled: true }],
};

describe('buildChatModelDefaultModel', () => {
  it('resolves to the configured sources + marks the stored default by EXACT source_id', () => {
    const model = buildChatModelDefaultModel(
      { source_id: 'slot_2', updated_at: 42 },
      config,
    );
    expect(model.kind).toBe('resolved');
    if (model.kind === 'resolved') {
      expect(model.source_id).toBe('slot_2');
      expect(model.updated_at).toBe(42);
      expect(model.matched).toBe(true);
      expect(model.options.map((o) => o.id)).toEqual([
        'slot_1',
        'slot_2',
        'free_pool',
      ]);
      const selected = model.options.filter((o) => o.selected);
      expect(selected).toHaveLength(1);
      expect(selected[0]!.id).toBe('slot_2');
    }
  });

  it('options carry labels (Fast / Thinking / Free pool) — no "local"/"byok" jargon', () => {
    const model = buildChatModelDefaultModel(
      { source_id: 'free_pool', updated_at: 1 },
      config,
    );
    if (model.kind === 'resolved') {
      expect(model.options.map((o) => o.label)).toEqual([
        'Fast · anthropic',
        'Thinking · openai',
        'Free pool',
      ]);
      expect(model.options.find((o) => o.selected)!.id).toBe('free_pool');
    }
  });

  it('an absent (null) stored source_id resolves but is not `matched`', () => {
    const model = buildChatModelDefaultModel({ source_id: null, updated_at: 1 }, config);
    expect(model.kind).toBe('resolved');
    if (model.kind === 'resolved') {
      expect(model.source_id).toBeNull();
      expect(model.matched).toBe(false);
      expect(model.options.some((o) => o.selected)).toBe(false);
    }
  });

  it('an off-list stored source_id reads as null → resolved but not matched', () => {
    const model = buildChatModelDefaultModel({ source_id: 'turbo', updated_at: 1 }, config);
    expect(model.kind).toBe('resolved');
    if (model.kind === 'resolved') {
      expect(model.source_id).toBeNull();
      expect(model.matched).toBe(false);
    }
  });

  it('loading while the snapshot OR the config has not loaded yet', () => {
    expect(buildChatModelDefaultModel(null, config).kind).toBe('loading');
    expect(buildChatModelDefaultModel(undefined, config).kind).toBe('loading');
    // valid snapshot but config still null (in-flight) → loading, NOT empty
    expect(
      buildChatModelDefaultModel({ source_id: 'slot_1', updated_at: 1 }, null).kind,
    ).toBe('loading');
  });

  it('empty (NOT loading) when the config is loaded but no source is configured — defect fix', () => {
    expect(
      buildChatModelDefaultModel({ source_id: 'slot_1', updated_at: 1 }, {}).kind,
    ).toBe('empty');
  });
});

describe('reduceChatDefaultModelPrefChanged', () => {
  it('rebuilds the model from the broadcast event source_id', () => {
    const current: ChatModelDefaultRenderModel = {
      kind: 'loading',
      options: [],
      updated_at: 0,
    };
    const next = reduceChatDefaultModelPrefChanged(
      current,
      { source_id: 'free_pool', updated_at: 7 },
      config,
    );
    expect(next.kind).toBe('resolved');
    if (next.kind === 'resolved') {
      expect(next.source_id).toBe('free_pool');
      expect(next.updated_at).toBe(7);
      expect(next.options.find((o) => o.selected)!.id).toBe('free_pool');
    }
  });

  it('an off-list broadcast source_id resolves but is not matched', () => {
    const current: ChatModelDefaultRenderModel = {
      kind: 'loading',
      options: [],
      updated_at: 0,
    };
    const next = reduceChatDefaultModelPrefChanged(
      current,
      { source_id: 'garbage', updated_at: 9 },
      config,
    );
    expect(next.kind).toBe('resolved');
    if (next.kind === 'resolved') expect(next.matched).toBe(false);
  });
});
