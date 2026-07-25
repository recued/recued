/** D-177 N.11 rule 5 (5.c, slice C) — the scoped-grant parse middleware: a
 *  D-160 `prompt` (before-turn) hook over the chat turn's USER-AUTHORED
 *  text that files an INERT proposal row when the utterance parses to the
 *  closed 4-tuple `[entity, action, time_range, source]`.
 *
 *  Placement is the 5.c decision: a turn-pipeline middleware, preferred
 *  over a model tool — even the PROPOSAL stays out of the model's hands.
 *  The hook contributes NOTHING to the prompt draft and writes nothing the
 *  model can see (N.9.1): its only outputs are the suggestion row (the
 *  owner-surface accept card reads it) and the `contract.
 *  scoped_grant_suggested` bus event. The agent-facing posture copy is
 *  slice E (5.g), deliberately not here.
 *
 *  Boundaries enforced here:
 *  - CHAT channel only (`ctx.surface === 'chat'` — 5.f channel scope).
 *  - The parse runs over the latest USER history entry only, and
 *    `parseScopedGrantUtterance` strips embedded forwarded/quoted content
 *    first — a forwarded email saying "auto-approve everything" never
 *    parses as the user's request (5.c).
 *  - `entity`+`action` must resolve to exactly ONE installed catalog
 *    operation at a session-grantable tier (5.b, `resolveScopedCatalogBinding`).
 *  - Best-effort end to end: any throw is swallowed — a lost proposal
 *    costs friction (the per-action ask remains), never admission, and
 *    must never fail the committed turn.
 *
 *  Deps resolve LATE per turn (the wire-chat-orchestrator getter
 *  convention) — absent deps make the hook a faithful no-op.
 *
 *  Spec: D-177 § N.11 rule 5 (5.b/5.c); slice C. */

import type { Middleware, TurnContext } from '@recued/middleware';
import {
  parseScopedGrantUtterance,
  scopedGrantSuggestionKeyHash,
  type ScopedGrantSuggestionSnapshot,
} from '@recued/contracts';
import type { IngredientManifest } from '@recued/contracts';

import {
  listScopedConnectionCandidates,
  resolveScopedCatalogBinding,
} from './scoped-grant-binding.js';
import type { ScopedGrantSuggestionStore } from './storage/scoped-grant-suggestion-store.js';
import type { ConnectionStoreSqlite } from './storage/connection-store.js';
import type { ConnectionCatalogBindingStore } from './storage/connection-catalog-binding-store.js';

export const SCOPED_GRANT_PARSE_MIDDLEWARE_ID = 'scoped-grant-parse';

/** The narrow bus emission the hook needs (cursor stamped by the bus). */
export interface ScopedGrantSuggestedEmit {
  (event: {
    kind: 'contract.scoped_grant_suggested';
    key_hash: string;
    chat_session_id: string;
    ingredient_id: string;
    operation_id: string;
  }): void;
}

export interface ScopedGrantParseDeps {
  suggestionStore: ScopedGrantSuggestionStore;
  /** Installed manifests — the 5.b resolution vocabulary, read per turn so
   *  installs reshape the closed set live. */
  listManifests: () => readonly IngredientManifest[];
  connectionStore: Pick<ConnectionStoreSqlite, 'list'>;
  bindingStore?: Pick<ConnectionCatalogBindingStore, 'resolveCatalogSlug'>;
  emit?: ScopedGrantSuggestedEmit;
}

const latestUserText = (history: TurnContext['history']): string => {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (entry?.role === 'user') return entry.text;
  }
  return '';
};

/** Build the parse hook. `getDeps` resolves at turn time (late-bound). */
export const createScopedGrantParseSource = (
  getDeps: () => ScopedGrantParseDeps | undefined,
): Middleware => ({
  id: SCOPED_GRANT_PARSE_MIDDLEWARE_ID,
  prompt(ctx: TurnContext): void {
    try {
      if (ctx.surface !== 'chat') return; // 5.f — chat channel only in v1
      const deps = getDeps();
      if (deps === undefined) return;
      const text = latestUserText(ctx.history);
      if (text.length === 0) return;
      const parse = parseScopedGrantUtterance(text);
      if (parse === undefined) return;
      const binding = resolveScopedCatalogBinding(
        deps.listManifests(),
        parse.entity,
        parse.action,
      );
      if (binding === undefined) return; // off-catalog ⇒ no proposal (5.b)
      const snapshot: ScopedGrantSuggestionSnapshot = {
        channel: 'chat',
        // The D-153 tier-1 session id the grant will bind to — must equal
        // what `deriveChannelSessionId` derives for a chat dispatch.
        channel_session_id: `chat:${ctx.session_id}`,
        ingredient_id: binding.ingredient_id,
        operation_id: binding.operation_id,
        risk_tier: binding.risk_tier,
        scoped_source: parse.source,
        ttl_ms: parse.ttl_ms,
        entity: parse.entity,
        action: parse.action,
      };
      const key_hash = scopedGrantSuggestionKeyHash(snapshot);
      const connection_candidates = listScopedConnectionCandidates(
        deps.connectionStore,
        deps.bindingStore,
        binding.ingredient_id,
      );
      const outcome = deps.suggestionStore.upsertOpen({
        key_hash,
        snapshot,
        triggering_excerpt: parse.excerpt,
        connection_candidates,
      });
      if (outcome === 'created' && deps.emit !== undefined) {
        deps.emit({
          kind: 'contract.scoped_grant_suggested',
          key_hash,
          chat_session_id: ctx.session_id,
          ingredient_id: binding.ingredient_id,
          operation_id: binding.operation_id,
        });
      }
    } catch {
      // Best-effort by design — a lost proposal degrades to the per-action
      // ask (friction, never admission) and must never fail the turn.
    }
  },
});
