/** D-167 chat provider-threading § P5 + § A.14 slot-aware routing — the
 *  global chat-model default picker, graduated into D-174 D14 Settings ->
 *  AI / Models.
 *
 *  Pure projection of the per-pair GLOBAL chat-model default — the routing
 *  source every non-overridden chat session inherits — into the picker UI
 *  model. Choosing a source here applies universally to all chats: every
 *  session that has not been individually overridden resolves its effective
 *  routing from this default at read time, so the change takes effect across
 *  all conversations at once (the server re-fans the new source on the
 *  `chat.default_model_pref_changed` broadcast).
 *
 *  D-174 R28 Slice A — the default is persisted + displayed as a `source_id`
 *  (`slot_1` | `slot_2` | `free_pool`), the SAME ids the composer picker
 *  renders (`buildChatModelSourceOptions`), so Settings and the composer speak
 *  one vocabulary. The picker selects by exact `source_id === option.id` (no
 *  lossy `matchChatModelSource` layer-fallback). The `free_pool | byok`
 *  layer is an internal server-side resolution detail, never surfaced here.
 *  The page reads server state via `chat.default_model_pref.get` + listens to
 *  `chat.default_model_pref_changed`; writes via `chat.default_model_pref.set`.
 *
 *  Per D-148 § A.4 invariant — the webclient projects server-supplied state
 *  only, NEVER synthesizes. Three discriminators tell the states apart so the
 *  page renders the right thing:
 *    - `'loading'`  — the server snapshot / LLM config has not loaded yet.
 *    - `'empty'`    — both loaded, but NO model source is configured (no BYOK
 *                     slot + no enabled free pool); the page prompts the user
 *                     to add one + jump to Providers (Preference depends on it).
 *    - `'resolved'` — both loaded with ≥1 source; the picker renders options.
 */

import {
  isChatModelSourceId,
  type ChatModelSourceId,
} from '@recued/contracts';

import {
  buildChatModelSourceOptions,
  type ChatModelSourceOption,
} from '../chat/model-routing.js';
import type { LlmConfigRecord } from './llm-availability.js';

/** One selectable global-default source row — a configured slot or the free
 *  pool — plus whether it is the current default. */
export interface ChatModelDefaultOption extends ChatModelSourceOption {
  /** True for the source that is currently the global default. */
  selected: boolean;
}

/** Snapshot-driven model the page iterates. */
export interface ChatModelDefaultModel {
  kind: 'resolved';
  /** The stored default source the picker is pinned to. `null` when no default
   *  is chosen yet OR the saved source was removed (no selection + fail-loud). */
  source_id: ChatModelSourceId | null;
  options: ReadonlyArray<ChatModelDefaultOption>;
  /** True when the stored `source_id` matches one of the configured sources;
   *  false means none chosen / the saved source is no longer available (the
   *  picker shows no selection + a "choose one" notice). */
  matched: boolean;
  /** Wall-clock at last server write. `0` means no default has been set. */
  updated_at: number;
}

/** In-flight: the server snapshot and/or the LLM config has not loaded yet. */
export interface ChatModelDefaultLoadingModel {
  kind: 'loading';
  options: readonly [];
  updated_at: 0;
}

/** Resolved-EMPTY: the snapshot + config loaded but NO model source is
 *  configured. Distinct from `'loading'` so the page can prompt "add a source"
 *  + jump to Providers instead of a perpetual "Loading…" (the D-174 R28 defect). */
export interface ChatModelDefaultEmptyModel {
  kind: 'empty';
  options: readonly [];
  updated_at: number;
}

export type ChatModelDefaultRenderModel =
  | ChatModelDefaultModel
  | ChatModelDefaultLoadingModel
  | ChatModelDefaultEmptyModel;

const LOADING: ChatModelDefaultLoadingModel = {
  kind: 'loading',
  options: [],
  updated_at: 0,
};

/** (snapshot + LLM config) → model projection. Returns `'loading'` until BOTH
 *  the server snapshot AND the LLM config have loaded (a freshly-loaded but
 *  source-less config is `{}`, NOT `null` — so `null` reliably means in-flight).
 *  Once both resolve: zero configured sources → `'empty'`; else `'resolved'`,
 *  with the picker pinned to the stored `source_id` by EXACT id match. */
export const buildChatModelDefaultModel = (
  snapshot:
    | { source_id?: unknown; updated_at: number }
    | null
    | undefined,
  config: LlmConfigRecord | null,
): ChatModelDefaultRenderModel => {
  if (!snapshot || config === null) return LOADING;
  const sources = buildChatModelSourceOptions(config);
  if (sources.length === 0) {
    return { kind: 'empty', options: [], updated_at: snapshot.updated_at };
  }
  const source_id = isChatModelSourceId(snapshot.source_id)
    ? snapshot.source_id
    : null;
  const selected =
    source_id !== null
      ? sources.find((source) => source.id === source_id) ?? null
      : null;
  return {
    kind: 'resolved',
    source_id,
    options: sources.map((source) => ({
      ...source,
      selected: source.id === selected?.id,
    })),
    matched: selected !== null,
    updated_at: snapshot.updated_at,
  };
};

/** Pure reducer over the `chat.default_model_pref_changed` broadcast. The
 *  page invokes this on each event to refresh the model against the current
 *  LLM config (the event's `source_id` is the source of truth; its transient
 *  `{layer, model_hint}` snapshot is consumed by the chat-thread reducer, not
 *  here). */
export const reduceChatDefaultModelPrefChanged = (
  current: ChatModelDefaultRenderModel,
  event: { source_id?: unknown; updated_at: number },
  config: LlmConfigRecord | null,
): ChatModelDefaultRenderModel => {
  void current;
  return buildChatModelDefaultModel(event, config);
};
