/** D-137 P1.4 § A.14 — Webclient model-routing UI substrate.
 *
 *  Pure projection of `ChatSession.model_routing` into the chat header
 *  badge per § A.14 model-routing ladder:
 *
 *    free_pool  → "Free pool — <provider>"
 *    byok       → "BYOK — <provider>"
 *
 *  "local" is NOT a routing layer and is NOT shown in the UI — there is no
 *  "local-AI" surface, only the configured sources slot_1 / slot_2 /
 *  free_pool (D-191 retired force-local routing; aliasing is the sole PII
 *  protection, and the per-turn picker is the bidirectional routing control:
 *  pick a slot for privacy/cost, or the pool for capability on a non-PII
 *  turn). A slot's local endpoint is still detected (`isLocalSlotBaseUrl`) as
 *  plumbing for a future global local-only toggle — never as a visible badge.
 *
 *  Per § A.14 explicit-provider-labeling invariant: the badge MUST
 *  surface the routed provider before the user starts a turn that
 *  consumes remote inference. The webclient pulls the current layer
 *  from `ChatSession.model_routing.current` (set via
 *  `chat.session.set_model_pref` rpc) + listens to `chat.session_changed`
 *  broadcasts to refresh on per-session toggles. This module enforces no
 *  policy — the badge surface reads the field verbatim so any drift is
 *  visible.
 */

import {
  CHAT_MODEL_ROUTING_LAYERS,
  type ChatModelHint,
  type ChatModelRoutingLayer,
  type ChatSession,
} from '@recued/contracts';

import {
  hasEnabledFreePool,
  readLlmSlotDetail,
  type LlmConfigRecord,
  type LlmSlotDetail,
} from '../settings/llm-availability.js';

/** D-137 P1.4 § A.14 — badge state discriminator.
 *
 *  Codex P1.4 review P1-B fold — the webclient is forbidden from
 *  inventing local state (D-148 § A.4 invariant: webclient projects
 *  server-supplied state only, never synthesizes). When the server
 *  has not yet broadcast a routing snapshot or the field carries a
 *  value off the closed `ChatModelRoutingLayer` list, the badge
 *  surfaces a `'pending'` state instead of falling back to `'local'`.
 *  The UI renders a neutral "Model: pending" pill until the server
 *  pushes a valid `chat.session_changed` event. */
export type ModelRoutingBadgeKind = 'resolved' | 'pending';

export interface ResolvedModelRoutingBadge {
  kind: 'resolved';
  /** Layer discriminator — drives badge color + ordering. */
  layer: ChatModelRoutingLayer;
  /** Human-readable label rendered in the chat header. */
  label: string;
  /** Provider id (e.g. `'anthropic' | 'openai' | 'ollama@localhost'`).
   *  Empty string when undefined on the session row (substrate stays
   *  reachable when no provider has been resolved yet). */
  provider: string;
  /** Specific model id when resolved (e.g. `'claude-opus-4-7'`). */
  model_id: string;
  /** Remote-inference hint. Post-D-191 every routing layer (`free_pool` /
   *  `byok`) is remote-capable at the SESSION level — per-slot locality is
   *  detection-only plumbing (`is_local`), never surfaced in the UI — so this
   *  is always `true`. Retained for the exported badge shape; no renderer
   *  currently keys on it. */
  is_remote: boolean;
  /** D-167 chat provider-threading — false when `layer` is INHERITED from
   *  the per-pair global chat-model default (the common case); true when
   *  this session carries an explicit per-session override. Drives the
   *  chat-header "using global default" affordance + whether the
   *  "Use global default" (clear) control is shown. */
  overridden: boolean;
}

export interface PendingModelRoutingBadge {
  kind: 'pending';
  /** Always `'Model: pending'` until the server pushes a valid
   *  routing snapshot. Surfaces in the chat header as a neutral
   *  badge — distinct from a resolved server-supplied selection. */
  label: 'Model: pending';
}

export type ModelRoutingBadge =
  | ResolvedModelRoutingBadge
  | PendingModelRoutingBadge;

const LAYER_LABEL_PREFIX: Readonly<Record<ChatModelRoutingLayer, string>> = {
  free_pool: 'Free pool',
  byok: 'BYOK',
};

/** § A.14 — pure projection. The renderer calls this once per session
 *  + on every `chat.session_changed` broadcast carrying field
 *  `'model_pref'`. Returns a `'pending'` badge when the server
 *  state is missing or off-list — never synthesizes a layer locally
 *  (Codex P1.4 review P1-B fold). */
export const buildModelRoutingBadge = (
  routing: ChatSession['model_routing'] | null | undefined,
): ModelRoutingBadge => {
  if (!routing || !isChatModelRoutingLayer(routing.current)) {
    return { kind: 'pending', label: 'Model: pending' };
  }
  const layer = routing.current;
  const provider = routing.provider ?? '';
  const model_id = routing.model_id ?? '';
  const prefix = LAYER_LABEL_PREFIX[layer];
  const labelProvider = provider.length > 0 ? ` (${provider})` : '';
  return {
    kind: 'resolved',
    layer,
    label: `${prefix}${labelProvider}`,
    provider,
    model_id,
    // Post-D-191 both remaining layers are remote-capable at the session level
    // (locality is a per-slot display property, not a routing layer).
    is_remote: true,
    // D-167 — surface inherited-vs-override as a STRUCTURED flag (not baked
    // into the label); the chat-header renderer shows a "global default"
    // hint + the "Use global default" (clear) control off this. `false` when
    // the layer is inherited from the per-pair default (the common case).
    overridden: routing.overridden === true,
  };
};

/** Closed-list iteration for the layer-selector dropdown, in
 *  `free_pool → byok` order. ("Local" is not a layer and is not shown — a
 *  local endpoint is just a slot; there is no local-AI option.) */
export const CHAT_MODEL_ROUTING_LAYER_OPTIONS: ReadonlyArray<{
  layer: ChatModelRoutingLayer;
  label: string;
  is_remote: boolean;
  description: string;
}> = [
  {
    layer: 'free_pool',
    label: 'Free pool',
    is_remote: true,
    description: 'Uses your own free-tier API keys (Groq, OpenRouter, etc.).',
  },
  {
    layer: 'byok',
    label: 'BYOK',
    is_remote: true,
    description: 'Bring your own paid API key (Anthropic, OpenAI, etc.).',
  },
] as const;

const LAYER_SET = new Set<ChatModelRoutingLayer>(CHAT_MODEL_ROUTING_LAYERS);

const isChatModelRoutingLayer = (
  value: unknown,
): value is ChatModelRoutingLayer =>
  typeof value === 'string' && LAYER_SET.has(value as ChatModelRoutingLayer);

// ────────────────────────────────────────────────────────────────
// § A.14 slot-aware chat routing — the composer + Settings model picker
// surface the user's CONFIGURED slots by their role (Fast / Quality /
// Thinking) + the free pool, aligned with the AI/Models slot vocabulary.
// "Local" is NOT a top-level option and is NOT shown as a badge — there is no
// local-AI in the UI, only slot_1 / slot_2 / free_pool. Each option maps to
// the wire shape `{ layer, model_hint }`: a slot is always `layer: 'byok'`
// (D-191 retired force-local routing — a local endpoint is detection-only
// plumbing, not a routing layer or a visible label), and the hint selects
// WHICH slot the turn targets.
// ────────────────────────────────────────────────────────────────

/** One selectable chat model source — a configured slot or the free pool. */
export interface ChatModelSourceOption {
  /** Stable id: the slot key, or `'free_pool'`. */
  id: 'slot_1' | 'slot_2' | 'free_pool';
  /** Human label (`'Fast · anthropic'`, `'Thinking · ollama'`,
   *  `'Free pool'`). No locality suffix — there is no local-AI label. */
  label: string;
  /** The routing layer this source persists to (`'byok'` for any slot,
   *  `'free_pool'` for the pool). Locality is detection-only plumbing
   *  (`is_local`), never a layer and never a visible label. */
  layer: ChatModelRoutingLayer;
  /** The slot capability hint (which slot); absent for the free pool. */
  model_hint?: ChatModelHint;
  /** True when the slot's base_url is a local endpoint. Detection-only
   *  plumbing (reserved for a future global local-only toggle); NOT surfaced
   *  in the UI as a badge or label. */
  is_local: boolean;
}

const ROLE_LABEL: Readonly<Record<ChatModelHint, string>> = {
  fast: 'Fast',
  quality: 'Quality',
  thinking: 'Thinking',
};

const slotSourceOption = (slot: LlmSlotDetail): ChatModelSourceOption => {
  const provider = slot.provider || 'model';
  return {
    id: slot.key,
    label: `${ROLE_LABEL[slot.speed]} · ${provider}`,
    // Every configured slot persists as `'byok'`, never a routing layer
    // (D-191). `is_local` is detection-only plumbing (reserved for a future
    // global local-only toggle) — it is NOT surfaced as a label: there is no
    // "local-AI" in the UI, only slot_1 / slot_2 / free_pool.
    layer: 'byok',
    model_hint: slot.speed,
    is_local: slot.is_local,
  };
};

/** Project the LLM config into the picker's CONFIGURED source options, in
 *  slot_1 → slot_2 → free_pool order. Empty when nothing is configured (the
 *  picker then renders the "Configure LLM →" link). */
export const buildChatModelSourceOptions = (
  config: LlmConfigRecord | null,
): ChatModelSourceOption[] => {
  const options: ChatModelSourceOption[] = [];
  for (const key of ['slot_1', 'slot_2'] as const) {
    const slot = readLlmSlotDetail(config, key);
    if (slot !== null) options.push(slotSourceOption(slot));
  }
  if (hasEnabledFreePool(config)) {
    options.push({
      id: 'free_pool',
      label: 'Free pool',
      layer: 'free_pool',
      is_local: false,
    });
  }
  return options;
};

/** Match a session's `model_routing` (`{ current, model_hint? }`) to its
 *  picker option. `free_pool` matches by layer; a slot matches by hint, with
 *  a legacy/no-hint fallback to the first slot option (slot_1 / fast — the
 *  prior default). Returns `null` when nothing matches (e.g. the routed
 *  source is no longer configured). */
export const matchChatModelSource = (
  options: ReadonlyArray<ChatModelSourceOption>,
  routing:
    | { current: ChatModelRoutingLayer; model_hint?: ChatModelHint }
    | null
    | undefined,
): ChatModelSourceOption | null => {
  if (!routing) return null;
  if (routing.current === 'free_pool') {
    return options.find((o) => o.id === 'free_pool') ?? null;
  }
  // byok → match among the configured slots. Every slot is `layer: 'byok'`
  // now (D-191: locality is display-only, not a routing layer), so the layer
  // filter just excludes the free pool; the `model_hint` (slot_1=fast vs
  // slot_2=quality/thinking) disambiguates WHICH slot. With the standard
  // distinct-speed slot convention the hint uniquely identifies the slot; the
  // same-speed local+remote edge is closed by the exact-slot pin (Phase 6).
  // `null` when no slot is configured (the caller keeps the routing as-is
  // rather than synthesizing a divergent source).
  const candidates = options.filter(
    (o) => o.id !== 'free_pool' && o.layer === routing.current,
  );
  const hint = routing.model_hint;
  return (
    (hint !== undefined
      ? candidates.find((o) => o.model_hint === hint)
      : undefined)
    ?? candidates[0]
    ?? null
  );
};
