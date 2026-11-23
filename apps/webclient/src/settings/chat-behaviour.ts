/** Settings → AI/Models — GLOBAL chat behaviour: settings that change every
 *  chat turn on this server, whichever AI answers it, including turns that
 *  arrive over MCP and the D-148 P9 inbound channels with no paired client.
 *  Today that is the rolling brief (and, rendered beside it, D-323's install
 *  offers).
 *
 *  ⛔⛔ THE TOOL CATALOG DOES NOT BELONG HERE, AND IT USED TO BE HERE. The
 *  server resolves a turn's catalog mode from the AI that turn runs on
 *  (`chat-orchestrator.ts`: `resolveCatalogSource(layer, source_id)` picks the
 *  turn's source, `resolveCatalogModeForSource` then reads that source's
 *  override, else its default). It is a property of each AI, and each AI's
 *  card on Providers has its own select for it. This section once added a read-only "Tool catalog:"
 *  line, projected from the per-source values into one value or "Mixed",
 *  under a heading that says it applies "whichever AI it uses". That
 *  contradicted the selects the owner actually changes, so it went
 *  (2026-11-16). Before adding a setting here, check that the server reads it
 *  without a source.
 *
 *  Per D-148 § A.4 the webclient PROJECTS server state and never synthesises
 *  it, so every field here is derived from a snapshot or reported as loading. */

export interface ChatBehaviourResolvedModel {
  kind: 'resolved';
  /** Carry a rolling brief across turns. Server-scoped; default ON. */
  rolling_brief: boolean;
}

export interface ChatBehaviourLoadingModel {
  kind: 'loading';
}

export type ChatBehaviourRenderModel =
  | ChatBehaviourResolvedModel
  | ChatBehaviourLoadingModel;

const LOADING: ChatBehaviourLoadingModel = { kind: 'loading' };

/** Rolling-brief snapshot → the global behaviour projection. `'loading'`
 *  until the snapshot has arrived with a boolean `enabled`: a missing or
 *  malformed value is unknown, never a silent `false`. */
export const buildChatBehaviourModel = (
  brief: { enabled?: unknown } | null | undefined,
): ChatBehaviourRenderModel => {
  if (!brief || typeof brief.enabled !== 'boolean') return LOADING;
  return { kind: 'resolved', rolling_brief: brief.enabled };
};
