/** Settings → AI/Models — GLOBAL chat behaviour: how this server carries
 *  context between turns, and how much of the tool catalog it sends.
 *
 *  ⛔⛔ GLOBAL, NOT PER-SOURCE, AND THAT IS THE POINT OF THE GROUPING. The
 *  catalog mode already had a per-source `<select>` on each LLM slot, which
 *  reads as a property of that provider. It is not: both of these settings
 *  change what EVERY chat turn carries, on every model, including turns that
 *  arrive over MCP and the D-148 P9 inbound channels with no paired client and
 *  no slot the owner ever looked at. Presenting them per-slot invites an owner
 *  to set one and believe they have set all.
 *
 *  🔑 THE TWO SHARE AN OPT-OUT CONVENTION ON PURPOSE. Both default ON, and both
 *  disable only on an explicit negative — `rolling_brief_enabled = '0'` in
 *  `chat_config`, `RECUED_CHAT_CATALOG_SMART_DEFAULTS=0` in the environment. An
 *  owner who learns the shape once knows both.
 *
 *  ⚠ CATALOG MODE IS PROJECTED, NOT STORED GLOBALLY, and this module does not
 *  pretend otherwise. The truth is a per-source map plus a smart default; a
 *  single global value does not exist. So the projection reports `'mixed'` when
 *  sources disagree rather than showing one of them and implying it is the
 *  whole picture — the same failure the per-slot control already has.
 *
 *  Per D-148 § A.4 the webclient PROJECTS server state and never synthesises
 *  it, so every field here is derived from a snapshot or reported as loading. */

import {
  CHAT_CATALOG_SMART_DEFAULT_BY_SOURCE,
  isChatCatalogDeliveryMode,
  type ChatCatalogDeliveryMode,
  type ChatModelSourceId,
} from '@recued/contracts';

import {
  hasEnabledFreePool,
  readLlmSlotDetail,
  type LlmConfigRecord,
} from './llm-availability.js';

/** What the catalog control shows. `'mixed'` is a real state, not an error:
 *  per-source overrides can legitimately disagree, and collapsing that to one
 *  value would misreport what the server will actually send. */
export type ChatCatalogGlobalMode = ChatCatalogDeliveryMode | 'mixed';

export interface ChatBehaviourResolvedModel {
  kind: 'resolved';
  /** Carry a rolling brief across turns. Server-scoped; default ON. */
  rolling_brief: boolean;
  /** The effective mode across every configured source. */
  catalog_mode: ChatCatalogGlobalMode;
  /** Per-source effective modes, so the UI can explain a `'mixed'` value
   *  instead of just reporting it. */
  catalog_by_source: ReadonlyArray<{
    source_id: ChatModelSourceId;
    mode: ChatCatalogDeliveryMode;
    /** True when this source carries an explicit override rather than the
     *  smart default — the thing an owner has to clear to get back to uniform. */
    overridden: boolean;
  }>;
}

export interface ChatBehaviourLoadingModel {
  kind: 'loading';
}

export type ChatBehaviourRenderModel =
  | ChatBehaviourResolvedModel
  | ChatBehaviourLoadingModel;

const LOADING: ChatBehaviourLoadingModel = { kind: 'loading' };

const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};

/** Which sources exist on this server.
 *
 *  ⛔ DERIVED FROM THE CONFIG, NEVER FROM THE CLOSED ID LIST: a server with one
 *  BYOK slot and no free pool must not report `'mixed'` because two sources it
 *  does not have would notionally disagree.
 *
 *  ⛔⛔ AND IT CALLS THE EXISTING PREDICATES RATHER THAN RE-DERIVING THEM. A
 *  first cut tested `slot.model !== undefined`, which is weaker than the real
 *  rule — `readLlmSlotDetail` requires provider + model + `has_key`, or a local
 *  base_url — so a half-configured slot would have counted as a source and
 *  could alone turn a uniform server `'mixed'`. Two statements of "is this slot
 *  real" is one too many. */
const configuredSources = (
  config: LlmConfigRecord | null,
): ReadonlyArray<ChatModelSourceId> => {
  const present: ChatModelSourceId[] = [];
  if (readLlmSlotDetail(config, 'slot_1') !== null) present.push('slot_1');
  if (readLlmSlotDetail(config, 'slot_2') !== null) present.push('slot_2');
  if (hasEnabledFreePool(config)) present.push('free_pool');
  return present;
};

/** (rolling-brief snapshot + LLM config) → the global behaviour projection.
 *  `'loading'` until BOTH have arrived — a freshly-loaded but source-less
 *  config is `{}`, never `null`, so `null` reliably means in-flight. */
export const buildChatBehaviourModel = (
  brief: { enabled?: unknown } | null | undefined,
  config: LlmConfigRecord | null,
  smartDefaultsEnabled = true,
): ChatBehaviourRenderModel => {
  if (!brief || typeof brief.enabled !== 'boolean' || config === null) {
    return LOADING;
  }
  const overrides = asRecord(asRecord(config)['catalog_modes']);
  const sources = configuredSources(config);
  const by = sources.map((source_id) => {
    const raw = overrides[source_id];
    const override = isChatCatalogDeliveryMode(raw) ? raw : null;
    // Precedence mirrors the server's `resolveCatalogModeForSource`:
    // explicit override → smart default (when on) → `full`.
    const mode: ChatCatalogDeliveryMode = override
      ?? (smartDefaultsEnabled
        ? CHAT_CATALOG_SMART_DEFAULT_BY_SOURCE[source_id]
        : 'full');
    return { source_id, mode, overridden: override !== null };
  });
  const distinct = new Set(by.map((b) => b.mode));
  return {
    kind: 'resolved',
    rolling_brief: brief.enabled,
    // No sources configured yet → report the smart default the FIRST source
    // would get, rather than 'mixed' over an empty set.
    catalog_mode:
      by.length === 0
        ? (smartDefaultsEnabled ? CHAT_CATALOG_SMART_DEFAULT_BY_SOURCE.slot_1 : 'full')
        : distinct.size === 1
          ? (by[0] as { mode: ChatCatalogDeliveryMode }).mode
          : 'mixed',
    catalog_by_source: by,
  };
};

/** Owner-facing copy for the catalog control. Kept beside the projection so a
 *  new mode cannot be added without a label — the `Record` is exhaustive over
 *  the union, so the compiler fails rather than the UI rendering a raw slug. */
export const CHAT_CATALOG_MODE_LABELS: Readonly<
  Record<ChatCatalogGlobalMode, string>
> = {
  full: 'Full catalog — every installed tool is listed',
  index: 'Indexed — a compact list, searched on demand',
  'lean-core': 'Lean core — core tools only, the rest found by search',
  mixed: 'Mixed — sources disagree',
};

/** Which sources a global catalog write must touch. ⛔ EVERY CONFIGURED SOURCE,
 *  INCLUDING THE ONES ALREADY ON THAT MODE. The per-source overrides are what
 *  make a value `'mixed'`, so a "set everything to X" that skipped sources
 *  already reading X would leave their OVERRIDES in place and the next smart-
 *  default change would silently un-set them again. */
export const chatCatalogGlobalWriteTargets = (
  model: ChatBehaviourRenderModel,
): ReadonlyArray<ChatModelSourceId> =>
  model.kind === 'resolved'
    ? model.catalog_by_source.map((b) => b.source_id)
    : [];
