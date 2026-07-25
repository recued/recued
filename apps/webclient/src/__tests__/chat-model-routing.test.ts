/** D-137 P1.4 § A.14 — model-routing badge.
 *
 *  Acceptance (post-D-191 — routing layer is `free_pool | byok`;
 *  "local" is detection-only plumbing, never a routing layer or a UI label):
 *    - buildModelRoutingBadge returns layer + label + is_remote
 *    - free_pool layer → label "Free pool (<provider>)"
 *    - byok layer → label "BYOK (<provider>)"
 *    - missing provider → bare prefix label
 *    - unknown layer string → pending badge (never synthesizes a layer)
 *    - CHAT_MODEL_ROUTING_LAYER_OPTIONS surfaces 2 ordered free_pool → byok
 *    - a local-base_url slot is a `byok` source, detected but NOT labeled
 */

import { describe, it, expect } from 'vitest';
import type { ChatSession } from '@recued/contracts';
import {
  buildModelRoutingBadge,
  buildChatModelSourceOptions,
  matchChatModelSource,
  CHAT_MODEL_ROUTING_LAYER_OPTIONS,
} from '../chat/model-routing.js';

const routing = (
  current: string,
  provider?: string,
  model_id?: string,
): ChatSession['model_routing'] => ({
  current: current as ChatSession['model_routing']['current'],
  ...(provider ? { provider } : {}),
  ...(model_id ? { model_id } : {}),
});

describe('buildModelRoutingBadge', () => {
  it('free_pool layer renders "Free pool (<provider>)"', () => {
    const b = buildModelRoutingBadge(routing('free_pool', 'groq'));
    expect(b.kind).toBe('resolved');
    if (b.kind === 'resolved') {
      expect(b.layer).toBe('free_pool');
      expect(b.label).toBe('Free pool (groq)');
      expect(b.is_remote).toBe(true);
    }
  });

  it('byok layer renders "BYOK (<provider>)"', () => {
    const b = buildModelRoutingBadge(routing('byok', 'anthropic', 'claude-opus-4-7'));
    expect(b.kind).toBe('resolved');
    if (b.kind === 'resolved') {
      expect(b.layer).toBe('byok');
      expect(b.label).toBe('BYOK (anthropic)');
      expect(b.is_remote).toBe(true);
      expect(b.model_id).toBe('claude-opus-4-7');
    }
  });

  it('missing provider renders bare prefix label', () => {
    const b = buildModelRoutingBadge(routing('byok'));
    expect(b.kind).toBe('resolved');
    if (b.kind === 'resolved') {
      expect(b.label).toBe('BYOK');
    }
  });

  it('D-167: surfaces overridden as a structured flag (label unchanged)', () => {
    const inherited = buildModelRoutingBadge({ current: 'free_pool' });
    expect(inherited.kind).toBe('resolved');
    if (inherited.kind === 'resolved') {
      expect(inherited.overridden).toBe(false); // inherited from the global default
      expect(inherited.label).toBe('Free pool'); // NO presentation baked into the label
    }
    const overridden = buildModelRoutingBadge({ current: 'byok', overridden: true });
    if (overridden.kind === 'resolved') {
      expect(overridden.overridden).toBe(true);
      expect(overridden.label).toBe('BYOK');
    }
  });

  it('unknown layer string surfaces pending badge (NEVER synthesizes a layer)', () => {
    const b = buildModelRoutingBadge(routing('garbage'));
    expect(b.kind).toBe('pending');
    if (b.kind === 'pending') {
      expect(b.label).toBe('Model: pending');
    }
  });

  it('a legacy "local" layer string is off-list → pending (never resolves)', () => {
    // D-191 retired the `'local'` routing layer; a stray persisted value is
    // off the closed `ChatModelRoutingLayer` list, so the badge surfaces
    // pending rather than synthesizing a layer (Codex P1-B invariant).
    expect(buildModelRoutingBadge(routing('local')).kind).toBe('pending');
  });

  it('null/undefined routing surfaces pending badge', () => {
    expect(buildModelRoutingBadge(null).kind).toBe('pending');
    expect(buildModelRoutingBadge(undefined).kind).toBe('pending');
  });
});

describe('CHAT_MODEL_ROUTING_LAYER_OPTIONS', () => {
  it('surfaces 2 options in free_pool → byok order', () => {
    expect(CHAT_MODEL_ROUTING_LAYER_OPTIONS).toHaveLength(2);
    expect(CHAT_MODEL_ROUTING_LAYER_OPTIONS.map((o) => o.layer)).toEqual([
      'free_pool',
      'byok',
    ]);
  });

  it('marks free_pool + byok as remote', () => {
    const byLayer = Object.fromEntries(
      CHAT_MODEL_ROUTING_LAYER_OPTIONS.map((o) => [o.layer, o.is_remote]),
    );
    expect(byLayer.free_pool).toBe(true);
    expect(byLayer.byok).toBe(true);
  });

  it('each option carries a non-empty description', () => {
    for (const o of CHAT_MODEL_ROUTING_LAYER_OPTIONS) {
      expect(o.description.length).toBeGreaterThan(0);
    }
  });
});

describe('§ A.14 slot-aware chat model sources', () => {
  it('projects configured slots (by role + provider) and the free pool', () => {
    const options = buildChatModelSourceOptions({
      slot_1: { provider: 'anthropic', model: 'claude', has_key: true },
      slot_2: { provider: 'openai', model: 'gpt', has_key: true },
      free_pool: [{ id: 'groq', enabled: true }],
    });
    expect(options).toEqual([
      { id: 'slot_1', label: 'Fast · anthropic', layer: 'byok', model_hint: 'fast', is_local: false },
      { id: 'slot_2', label: 'Thinking · openai', layer: 'byok', model_hint: 'thinking', is_local: false },
      { id: 'free_pool', label: 'Free pool', layer: 'free_pool', is_local: false },
    ]);
  });

  it('a local-base_url slot is a byok source, detected (is_local) but NOT labeled (no api_key needed)', () => {
    // R29 — locality is detection-only plumbing (`is_local`), NOT a UI label:
    // the slot persists as `layer: 'byok'` and its label carries no "(local)".
    const options = buildChatModelSourceOptions({
      slot_1: { provider: 'ollama', model: 'qwen', base_url: 'http://localhost:11434/v1', speed: 'quality' },
    });
    expect(options).toEqual([
      { id: 'slot_1', label: 'Quality · ollama', layer: 'byok', model_hint: 'quality', is_local: true },
    ]);
  });

  it('omits unconfigured slots + a disabled free pool', () => {
    expect(buildChatModelSourceOptions({})).toEqual([]);
    expect(
      buildChatModelSourceOptions({ free_pool: [{ id: 'x', enabled: false }] }),
    ).toEqual([]);
  });

  it('matches free_pool routing by layer', () => {
    const options = buildChatModelSourceOptions({
      slot_1: { provider: 'anthropic', model: 'claude', has_key: true },
      free_pool: [{ id: 'groq', enabled: true }],
    });
    expect(matchChatModelSource(options, { current: 'free_pool' })?.id).toBe(
      'free_pool',
    );
  });

  it('matches a byok session to its slot by hint, falling back to the first slot when no hint', () => {
    const options = buildChatModelSourceOptions({
      slot_1: { provider: 'anthropic', model: 'claude', has_key: true },
      slot_2: { provider: 'openai', model: 'gpt', has_key: true },
    });
    expect(
      matchChatModelSource(options, { current: 'byok', model_hint: 'thinking' })?.id,
    ).toBe('slot_2');
    // legacy / no hint → the first byok slot (the prior default)
    expect(matchChatModelSource(options, { current: 'byok' })?.id).toBe('slot_1');
  });

  it('matches a local-base_url slot like any byok slot (locality is display-only)', () => {
    // slot_1 is a LOCAL ollama slot, slot_2 is remote. Post-D-191 both are
    // `layer: 'byok'`; locality is detection-only (not a routing distinction,
    // not a label), so matching is purely by hint (the same-speed local+remote
    // edge is closed by the exact-slot pin — D-191 Phase 6).
    const withLocal = buildChatModelSourceOptions({
      slot_1: { provider: 'ollama', model: 'qwen', base_url: 'http://localhost:11434/v1' },
      slot_2: { provider: 'openai', model: 'gpt', has_key: true },
    });
    const slot1 = withLocal.find((o) => o.id === 'slot_1');
    const slot2 = withLocal.find((o) => o.id === 'slot_2');
    expect(slot1?.layer).toBe('byok');
    expect(slot1?.is_local).toBe(true);
    expect(slot2?.is_local).toBe(false);
    expect(
      matchChatModelSource(withLocal, { current: 'byok', model_hint: slot1?.model_hint })?.id,
    ).toBe('slot_1');
    expect(
      matchChatModelSource(withLocal, { current: 'byok', model_hint: slot2?.model_hint })?.id,
    ).toBe('slot_2');
  });

  it('returns null when nothing matches / no options', () => {
    expect(matchChatModelSource([], { current: 'byok' })).toBeNull();
    expect(matchChatModelSource([], null)).toBeNull();
  });
});
