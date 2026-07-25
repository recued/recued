/** D-177 P2 — session-grant USE-RESOLUTION: the impure layer that looks up live
 *  session grants for a channel session and consumes one use at the Gateway's
 *  dispatch proceed point.
 *
 *  The pure substrate is `matchesSessionGrant` (`@recued/contracts` — the N.4
 *  common + per-mode predicate); the storage substrate is the
 *  `contract.contract_definition.*` lifecycle store (session rows are ordinary
 *  contract rows with `grant_kind: 'session'`, N.3). This resolver is the glue
 *  the commit Gateway's `sessionGrants` seam calls:
 *
 *  - `match(ctx)` — list the session rows bound to `ctx.channel_session_id`
 *    (the session index — `listSessionGrants`), evaluate the N.4 predicate
 *    against each at `now()`, and return the FIRST match's `contract_id`
 *    (soonest-expiring first — the grant closest to expiry burns first,
 *    preserving the most usable budget when several grants match). D-177
 *    N.13 (P6a): when no session grant matches, a SECOND pass evaluates the
 *    delegation rules (`listDelegationRules` × `matchesDelegationRule` —
 *    scope-bound ladder-6 standing rules, `write`-only, exact/open). Session
 *    grants deliberately match FIRST: they are the narrower authority
 *    (session-bound) and expire sooner, so their budget burns before a
 *    standing rule's. Read-only: matching never writes (consumption is the
 *    separate proceed-point step, N.4 step 4). `null` ⇒ no live grant
 *    absorbs this ask — the Gateway holds for approval exactly as today.
 *  - `consume(contract_id)` — the proceed-point write: atomic
 *    check-live-and-decrement (`consumeSessionGrant`). `false` ⇒ the grant
 *    died between match and consume (revoked / expired / exhausted) — the
 *    Gateway falls back to hold, fail closed. A use burned on a subsequently-
 *    failed dispatch is acceptable (conservative; same posture as the D-166
 *    contract use counter).
 *
 *  D2 — grants are consumed at the gate's ask-branch only, NEVER merged into
 *  the policy verdict (the verdict computation is unchanged; deny is never
 *  grant-overridden). Inert by construction until a grant row exists: with
 *  no `grant_kind: 'session'` rows and no `grant_kind: 'delegation'` rows,
 *  `match` scans two empty candidate sets and the gate behaves exactly as
 *  pre-D-177.
 *
 *  Spec: docs/d-177-spec.md § N.4 / N.9; landing order P2. */

import {
  BATCH_GRANT_TTL_MS,
  SESSION_GRANT_RISK_TIERS,
  matchesDelegationRule,
  matchesSessionGrant,
  type Actor,
  type Channel,
  type RiskTier,
  type SessionGrantMatchContext,
  type SessionGrantMintContext,
  type ScopedSenderCandidate,
} from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';

import type { ContractDefinitionStore } from './storage/contract-definition-store.js';

/** D-177 P5a — the batch mint context: everything the answered batch-ask
 *  row pins (the N.4 common-predicate bindings every member shares by
 *  join-key construction) plus the member set the approval snapshot
 *  enumerated. `max_uses` is DERIVED (= member count — one claim per
 *  approved item, the claim is the consumption); `expiry_at` is `now +
 *  BATCH_GRANT_TTL_MS` (the batch grant is the approval materialized,
 *  not an N.6 session loosening — its lifetime only covers the member
 *  resumes + the replay-absorption window). `approved_action_ref` is the
 *  batch row id — stable across at-least-once answer re-dispatches, so
 *  the mint dedupes durably. */
export interface SessionGrantBatchMintContext {
  readonly channel: Channel;
  readonly actor: Actor;
  readonly channel_session_id: string;
  readonly ingredient_slug: string;
  readonly operation_id?: string;
  readonly connection_name?: string;
  readonly recipe_id: string;
  readonly recipe_hash: string;
  readonly arg_shape_hash: string;
  readonly risk_tier: RiskTier;
  /** The batch row id (D8 anchor — durable mint idempotence key). */
  readonly approved_action_ref: string;
  /** D-177 N.14 — the governing door contract id when the batched holds
   *  came from a door dispatch (the batch key includes the source, so
   *  every member shares it). Stamped as the grant's `bound_contract_id`;
   *  an anonymous-actor batch WITHOUT it is refused at the store mint. */
  readonly source_contract_id?: string;
  readonly members: ReadonlyArray<{
    readonly member_id: string;
    readonly canonical_payload_hash: string;
  }>;
}

/** D-182 §8 — the raw-op mint context: a human's `allow_session` answer to a
 *  recipe-LESS raw catalog-op door hold. UNLIKE the recipe-bound `mint` it
 *  carries NO `recipe_id` / `recipe_hash` (a raw op has no recipe — the grant's
 *  `bound_recipe` is omitted), and the operation axis is REQUIRED (a raw op IS
 *  an op; the grant never wildcards it). The bounds come from the same
 *  `(mcp × contracted_user)` cell offer a recipe hold reads. `approved_action_ref`
 *  is the raw-op checkpoint's `run_id` (stable across at-least-once answer
 *  re-dispatches → durable mint idempotence). */
export interface SessionGrantRawOpMintContext {
  readonly channel: Channel;
  readonly actor: Actor;
  readonly channel_session_id: string;
  /** The backing catalog ingredient slug (the grant's ingredient axis). */
  readonly ingredient_slug: string;
  /** The catalog operation key — REQUIRED (raw_op never wildcards it). */
  readonly operation_id: string;
  /** The resolved connection, when the op binds one (omit for ai/storage). */
  readonly connection_name?: string;
  readonly risk_tier: RiskTier;
  readonly arg_shape_hash: string;
  readonly canonical_payload_hash: string;
  readonly entity_scope?: string;
  /** The raw-op checkpoint's `run_id` (D8 anchor — durable mint idempotence). */
  readonly approved_action_ref: string;
  /** Grant lifetime from the offer (`expiry_at = now + ttl_ms`). */
  readonly ttl_ms: number;
  /** Use budget from the offer — seeds `uses_remaining`. */
  readonly max_uses: number;
  /** D-177 N.14.6 — the DOOR contract this grant belongs to, stamped as the row's
   *  `bound_contract_id`. THIS is the field whose absence was the door-conflation
   *  bug: the raw-op mint is the live `(mcp, contracted_user)` grant path, and it
   *  scopes `actors: ['contracted_user']`, so the store's anonymous-requires-a-
   *  binding fence never fired and every row landed unbound — matchable by the
   *  same token AFTER the owner rebound it to a different contract. The resume
   *  already froze the id on the checkpoint for the liveness kill-switch; it was
   *  simply not carried this far. Absent for the owner's own stdio client, which
   *  is not a door and keeps its unbound grants. */
  readonly source_contract_id?: string;
}

/** The session-grant lookup + consumption + mint surface the commit Gateway's
 *  `sessionGrants` dep closes over (the host adds the run's recipe identity to
 *  the Gateway's per-call fields to form the full {@link SessionGrantMatchContext}
 *  / {@link SessionGrantMintContext}). */
export interface SessionGrantResolver {
  /** First live grant matching the envelope — session grants first, then
   *  (N.13) delegation rules — or `null`. Read-only. */
  match(ctx: SessionGrantMatchContext): string | null;
  /** Consume one use at the dispatch proceed point. `false` ⇒ fall back to
   *  hold (fail closed). D-177 P5a: `call.canonical_payload_hash` selects
   *  the member a `grant_mode: 'batch'` consumption atomically claims
   *  (exact rows ignore it). P5b: `call.pinned_projection_hash` is the
   *  FIRE's recomputed projection hash an `'open'` consumption is
   *  store-verified against (absent/divergent ⇒ `false`). */
  consume(
    contract_id: string,
    call?: {
      canonical_payload_hash?: string;
      pinned_projection_hash?: string;
      /** D-177 N.11 rule 5 — `'scoped'` consumption re-verifies 5.d
       *  containment at the store (destination emails vs the per-session
       *  sender candidate index). */
      destination_emails?: ReadonlyArray<string>;
      scoped_sender_candidates?: ReadonlyArray<ScopedSenderCandidate>;
      /** D-177 N.14 — the dispatching run's governing door contract id; a
       *  row carrying `bound_contract_id` consumes only against equality
       *  (store-re-verified, mirroring the matcher's door clause). */
      source_contract_id?: string;
    },
  ): boolean;
  /** D-177 P5a (N.10) — claim a SPECIFIC batch member at a batch-approved
   *  resume's proceed point, hash-verified against the CURRENT envelope
   *  (codex HIGH fold — a drifted resume re-asks, never spends the
   *  member). Atomic claim + decrement; `false` ⇒ re-hold. */
  claimBatchMember(
    contract_id: string,
    member_id: string,
    call: {
      arg_shape_hash: string;
      canonical_payload_hash: string;
      /** D-177 N.14.6 — the dispatching run's governing door contract id; a row
       *  carrying `bound_contract_id` claims only against equality (store-
       *  re-verified, mirroring `consume`'s door clause — the claim is the other
       *  spend path and burns a member). */
      source_contract_id?: string;
    },
  ): boolean;
  /** D-177 P5a (N.10) — mint the `grant_mode: 'batch'` grant from an
   *  answered batch-ask snapshot. NEVER throws (same posture as `mint`);
   *  returns the minted (or durably-deduped) `contract_id`, or
   *  `undefined` when the mint was refused/failed — the caller falls
   *  back to plain marker resumes (the approval still executes; only the
   *  member-claim accounting degrades to the per-checkpoint coverage). */
  mintBatch(ctx: SessionGrantBatchMintContext): string | undefined;
  /** D-182 §8 — mint a RAW-OP session grant from a recipe-LESS raw-op door
   *  hold's `allow_session` answer (the recipe-less exact-payload primitive
   *  `mintRawOpGrant`). NEVER throws (same posture as `mint`/`mintBatch`):
   *  every failure — out-of-vocabulary tier, a `RawOpGrantMintError`, an
   *  audit/broadcast hiccup — degrades to a warn and the human-approved resume
   *  proceeds untouched. Returns the minted (or durably-deduped) `contract_id`,
   *  or `undefined` on refusal. The recipe-bound `mint` REFUSES a recipe-less
   *  ctx (it requires recipe identity), so the raw-op path mints here. */
  mintRawOp(ctx: SessionGrantRawOpMintContext): string | undefined;
  /** D-177 P3 (N.5) — mint a session grant from a resume-admitted dispatch's
   *  envelope (the `allow_session` answer). NEVER throws: the mint is the
   *  convenience half of an already-human-approved dispatch, so every
   *  failure — an out-of-vocabulary tier, a store refusal
   *  (`SessionGrantMintError`), an audit/broadcast hiccup — degrades to a
   *  warn log and the resume proceeds untouched. On success the mint is
   *  audited (`session_grant_minted` activity row, D-120) and the
   *  `contract.contract_definition_changed` broadcast re-lists every paired
   *  client's contracts inspector. */
  mint(ctx: SessionGrantMintContext): void;
}

export interface CreateSessionGrantResolverDeps {
  /** The `contract.contract_definition.*` lifecycle store — session index
   *  (`listSessionGrants`) + atomic consumption (`consumeSessionGrant`) +
   *  the bounded mint primitive (`mintSessionGrant`). */
  readonly definitionStore: ContractDefinitionStore;
  /** Clock for the match-time liveness check + the mint's `expiry_at`
   *  derivation (epoch-ms). Defaults to `Date.now`. (Consumption re-reads
   *  the store's own clock — the store owns the authoritative liveness
   *  re-check at the write.) */
  readonly now?: () => number;
  /** D-177 P3 — the D-120 activity log for the `session_grant_minted` audit
   *  row. Optional (db-less harnesses): absent ⇒ the mint still lands, only
   *  the audit breadcrumb is skipped. */
  readonly auditLog?: AuditLogStore;
  /** D-177 P3 — the `contract.contract_definition_changed` broadcast seam
   *  (same event the `collection.contract.*` rpc emits), so a gateway-side
   *  mint re-lists the contracts inspector on every paired client live.
   *  Optional; emit failures are swallowed (observability-only). */
  readonly broadcast?: (event: {
    kind: 'contract.contract_definition_changed';
    op: 'mint' | 'revoke';
    contract_id: string;
  }) => void;
}

/** Build a {@link SessionGrantResolver} over the contract-definition store.
 *  Stateless beyond the injected clock — every call reads the store live, so a
 *  mid-session revoke (kill switch) takes effect on the next ask. */
export const createSessionGrantResolver = (
  deps: CreateSessionGrantResolverDeps,
): SessionGrantResolver => {
  const now = deps.now ?? ((): number => Date.now());
  return {
    match(ctx): string | null {
      const nowMs = now();
      for (const grant of deps.definitionStore.listSessionGrants(ctx.channel_session_id)) {
        if (matchesSessionGrant(grant, ctx, nowMs)) return grant.contract_id;
      }
      // D-177 N.13 (P6a) — the delegation pass: scope-bound standing rules,
      // evaluated only when no session grant absorbed the ask (session first
      // — narrower authority, sooner expiry). Inert until P6c mints a rule
      // (the listing is empty); both gates ride this same resolver, so the
      // commit AND catalog gates gain the pass together.
      for (const rule of deps.definitionStore.listDelegationRules()) {
        if (matchesDelegationRule(rule, ctx, nowMs)) return rule.contract_id;
      }
      return null;
    },
    consume(contract_id, call): boolean {
      return deps.definitionStore.consumeSessionGrant(contract_id, call);
    },
    claimBatchMember(contract_id, member_id, call): boolean {
      return deps.definitionStore.claimBatchMember(contract_id, member_id, call);
    },
    mintBatch(ctx): string | undefined {
      try {
        // D7 re-check — same posture as the exact mint: `read` never
        // grants, `destructive` never grants. The batch path upstream
        // only registers write/admin holds, so this is defense-in-depth.
        if (!(SESSION_GRANT_RISK_TIERS as readonly string[]).includes(ctx.risk_tier)) {
          console.warn(
            `[session-grant-resolver] batch mint refused: risk_tier '${ctx.risk_tier}' `
              + `is not session-grantable (D7) — ingredient '${ctx.ingredient_slug}', `
              + `batch ${ctx.approved_action_ref}`,
          );
          return undefined;
        }
        // DURABLE idempotence — the answered-ask re-dispatch is
        // at-least-once: one batch approval mints one grant. The batch
        // row id (`approved_action_ref`) is stable across retries; match
        // against ALL rows (live or dead) so a retry never resurrects a
        // revoked/exhausted grant.
        const twin = deps.definitionStore
          .listSessionGrants(ctx.channel_session_id)
          .find(
            (row) =>
              row.approved_action_ref === ctx.approved_action_ref
              && row.grant_mode === 'batch',
          );
        if (twin !== undefined) {
          console.info(
            `[session-grant-resolver] batch mint skipped: grant '${twin.contract_id}' `
              + `already exists for batch ${ctx.approved_action_ref} (at-least-once retry)`,
          );
          return twin.contract_id;
        }
        const minted_at = now();
        const def = deps.definitionStore.mintSessionGrant({
          minted_by: 'owner',
          display_name:
            `Batched approval — ${ctx.operation_id ?? ctx.ingredient_slug} `
            + `(${ctx.members.length} item${ctx.members.length === 1 ? '' : 's'})`,
          scope: {
            channels: [ctx.channel],
            actors: [ctx.actor],
            ingredient_ids: [ctx.ingredient_slug],
            ...(ctx.operation_id !== undefined
              ? { operation_ids: [ctx.operation_id] }
              : {}),
            ...(ctx.connection_name !== undefined
              ? { connection_names: [ctx.connection_name] }
              : {}),
          },
          channel_session_id: ctx.channel_session_id,
          grant_mode: 'batch',
          bound_recipe: { recipe_id: ctx.recipe_id, recipe_hash: ctx.recipe_hash },
          arg_shape_hash: ctx.arg_shape_hash,
          risk_tier: ctx.risk_tier,
          batch_members: ctx.members.map((m) => ({
            member_id: m.member_id,
            canonical_payload_hash: m.canonical_payload_hash,
          })),
          // D-177 N.14 — door batches bind their grant to the door contract
          // (same rule as the exact/open mint above).
          ...(ctx.source_contract_id !== undefined
            ? { bound_contract_id: ctx.source_contract_id }
            : {}),
          approved_action_ref: ctx.approved_action_ref,
          // The batch grant is the approval materialized: one claim per
          // approved item (`max_uses` = member count — claims decrement
          // both), alive only long enough for the member resumes + the
          // same-unit replay window (BATCH_GRANT_TTL_MS — deliberately
          // NOT the N.6 cell TTL; an unclaimed member past expiry simply
          // re-asks).
          expiry_at: minted_at + BATCH_GRANT_TTL_MS,
          max_uses: ctx.members.length,
        });
        // D-120 — audited like the exact mint (reserve-class: an
        // access-surface change). Best-effort.
        if (deps.auditLog !== undefined) {
          void deps.auditLog
            .logActivity({
              activity_id: '',
              timestamp: minted_at,
              action: 'session_grant_minted',
              target: def.contract_id,
              detail: JSON.stringify({
                grant_mode: 'batch',
                ingredient_slug: ctx.ingredient_slug,
                ...(ctx.operation_id !== undefined
                  ? { operation_id: ctx.operation_id }
                  : {}),
                ...(ctx.connection_name !== undefined
                  ? { connection_name: ctx.connection_name }
                  : {}),
                risk_tier: ctx.risk_tier,
                recipe_id: ctx.recipe_id,
                channel: ctx.channel,
                channel_session_id: ctx.channel_session_id,
                expiry_at: def.expiry_at,
                max_uses: ctx.members.length,
                member_count: ctx.members.length,
                approved_action_ref: ctx.approved_action_ref,
              }),
            })
            .catch(() => {
              /* best-effort — the grant row is the durable record */
            });
        }
        try {
          deps.broadcast?.({
            kind: 'contract.contract_definition_changed',
            op: 'mint',
            contract_id: def.contract_id,
          });
        } catch {
          /* observability-only — never unwind the mint */
        }
        return def.contract_id;
      } catch (e) {
        console.warn(
          `[session-grant-resolver] batch mint failed for ingredient '${ctx.ingredient_slug}' `
            + `(batch ${ctx.approved_action_ref}): `
            + (e instanceof Error ? e.message : String(e)),
        );
        return undefined;
      }
    },
    mintRawOp(ctx): string | undefined {
      try {
        // D7 re-check (same posture as `mint`/`mintBatch`): `read` never asks
        // for a grant and `destructive` never grants. The raw-op hold path only
        // offers `allow_session` for write/admin tiers, so this is
        // defense-in-depth against a tier that drifted while the ask was open.
        if (!(SESSION_GRANT_RISK_TIERS as readonly string[]).includes(ctx.risk_tier)) {
          console.warn(
            `[session-grant-resolver] raw_op mint refused: risk_tier '${ctx.risk_tier}' `
              + `is not session-grantable (D7) — op '${ctx.operation_id}' on `
              + `'${ctx.ingredient_slug}', run ${ctx.approved_action_ref}`,
          );
          return undefined;
        }
        // DURABLE idempotence — the answered-ask resume is at-least-once: a
        // crash between the mint and the checkpoint delete re-dispatches the
        // same answer. One approval mints one grant: skip when a `'raw_op'` row
        // for the SAME approval (`approved_action_ref` — the checkpoint's stable
        // `run_id`) with the SAME exact-payload identity already exists. Matched
        // against ALL rows (live or dead) so a retry never resurrects a grant
        // the owner already revoked or the session exhausted.
        const twin = deps.definitionStore
          .listSessionGrants(ctx.channel_session_id)
          .find(
            (row) =>
              row.approved_action_ref === ctx.approved_action_ref
              && row.grant_mode === 'raw_op'
              && row.scope.ingredient_ids?.includes(ctx.ingredient_slug) === true
              && row.arg_shape_hash === ctx.arg_shape_hash
              && row.canonical_payload_hash === ctx.canonical_payload_hash,
          );
        if (twin !== undefined) {
          console.info(
            `[session-grant-resolver] raw_op mint skipped: grant '${twin.contract_id}' `
              + `already exists for approval ${ctx.approved_action_ref} (at-least-once retry)`,
          );
          return twin.contract_id;
        }
        const minted_at = now();
        const def = deps.definitionStore.mintRawOpGrant({
          minted_by: 'owner',
          display_name: `Session grant (raw op) — ${ctx.operation_id}`,
          scope: {
            channels: [ctx.channel],
            actors: [ctx.actor],
            ingredient_ids: [ctx.ingredient_slug],
            operation_ids: [ctx.operation_id],
            ...(ctx.connection_name !== undefined
              ? { connection_names: [ctx.connection_name] }
              : {}),
          },
          channel_session_id: ctx.channel_session_id,
          risk_tier: ctx.risk_tier,
          arg_shape_hash: ctx.arg_shape_hash,
          canonical_payload_hash: ctx.canonical_payload_hash,
          ...(ctx.entity_scope !== undefined ? { entity_scope: ctx.entity_scope } : {}),
          // D-177 N.14.6 — a door's raw-op grant binds to the door contract that
          // was governing when the owner approved it (the matcher + consume both
          // require equality). Without this the row outlives its own contract: a
          // rebind moves the token to another contract while the session key —
          // `mcp:<token>` — never moves, and the grant follows.
          ...(ctx.source_contract_id !== undefined
            ? { bound_contract_id: ctx.source_contract_id }
            : {}),
          approved_action_ref: ctx.approved_action_ref,
          expiry_at: minted_at + ctx.ttl_ms,
          max_uses: ctx.max_uses,
        });
        // D-120 — audited like the exact / batch mint (reserve-class: a bounded
        // loosening of the ask gate is an access-surface change). Best-effort.
        if (deps.auditLog !== undefined) {
          void deps.auditLog
            .logActivity({
              activity_id: '',
              timestamp: minted_at,
              action: 'session_grant_minted',
              target: def.contract_id,
              detail: JSON.stringify({
                grant_mode: 'raw_op',
                ingredient_slug: ctx.ingredient_slug,
                operation_id: ctx.operation_id,
                ...(ctx.connection_name !== undefined
                  ? { connection_name: ctx.connection_name }
                  : {}),
                risk_tier: ctx.risk_tier,
                channel: ctx.channel,
                channel_session_id: ctx.channel_session_id,
                expiry_at: def.expiry_at,
                max_uses: ctx.max_uses,
                approved_action_ref: ctx.approved_action_ref,
              }),
            })
            .catch(() => {
              /* best-effort — the grant row is the durable record */
            });
        }
        try {
          deps.broadcast?.({
            kind: 'contract.contract_definition_changed',
            op: 'mint',
            contract_id: def.contract_id,
          });
        } catch {
          /* observability-only — never unwind the mint */
        }
        return def.contract_id;
      } catch (e) {
        console.warn(
          `[session-grant-resolver] raw_op mint failed for op '${ctx.operation_id}' on `
            + `'${ctx.ingredient_slug}' (run ${ctx.approved_action_ref}): `
            + (e instanceof Error ? e.message : String(e)),
        );
        return undefined;
      }
    },
    mint(ctx): void {
      try {
        // D7 re-check at the mint (the offer already gated on the tier, but
        // the tier here is the RESUME decision's — policy can mutate while
        // an ask is outstanding): `read` never grants, `destructive` never
        // grants. Fail closed to a warn — the approval itself stands.
        if (!(SESSION_GRANT_RISK_TIERS as readonly string[]).includes(ctx.risk_tier)) {
          console.warn(
            `[session-grant-resolver] mint refused: risk_tier '${ctx.risk_tier}' is not `
              + `session-grantable (D7) — ingredient '${ctx.ingredient_slug}', `
              + `run ${ctx.approved_action_ref}`,
          );
          return;
        }
        // D-177 P5b (N.11) — an `'open'` mint requires BOTH projection
        // fields (the Gateway computed them from the resume dispatch's own
        // walk); anything else is an approval-layer bug surfacing here.
        // Unknown future modes fail closed the same way. Fail to a warn —
        // the human-approved resume stands either way.
        const grant_mode: 'exact' | 'open' =
          ctx.grant_mode === 'open' ? 'open' : 'exact';
        if (
          grant_mode === 'open'
          && (ctx.pinned_projection_hash === undefined
            || ctx.pinned_projection_hash.length === 0
            || ctx.open_projection === undefined)
        ) {
          console.warn(
            `[session-grant-resolver] open mint refused: missing projection fields — `
              + `ingredient '${ctx.ingredient_slug}', run ${ctx.approved_action_ref}`,
          );
          return;
        }
        // D-182 §8 — this resolver's `mint` is the RECIPE-BOUND path (exact /
        // open), so it REQUIRES the run's recipe identity. The ctx fields are
        // optional only for the recipe-less raw-op door path, which mints
        // through its own primitive (`mintRawOpGrant`) and never reaches here.
        // A recipe-less ctx arriving here is an approval-layer bug — fail to a
        // warn (the human approval stands; the call simply re-asks next time),
        // same posture as the tier / projection guards above. Also narrows
        // `recipe_id` / `recipe_hash` to `string` for the `bound_recipe` mint.
        if (
          ctx.recipe_id === undefined
          || ctx.recipe_id.length === 0
          || ctx.recipe_hash === undefined
          || ctx.recipe_hash.length === 0
        ) {
          console.warn(
            `[session-grant-resolver] mint refused: missing recipe identity — `
              + `ingredient '${ctx.ingredient_slug}', run ${ctx.approved_action_ref}`,
          );
          return;
        }
        // DURABLE idempotence (codex MEDIUM fold) — the answered-ask resume
        // is at-least-once: a crash between the mint and the checkpoint
        // delete re-dispatches the same answer through a FRESH execution,
        // whose in-memory once-flag knows nothing of the first attempt.
        // One approval mints one grant: skip when a row for the SAME
        // approval (`approved_action_ref` — the paused run's anchor, stable
        // across retries) with the SAME envelope identity already exists.
        // The envelope is in the key because one run can hold more than
        // once (a second downstream gate = a new ask, same run_id) — those
        // are distinct approvals. Deliberately matched against ALL rows
        // (live or dead): a retry must not resurrect a grant the owner
        // already revoked or the session already exhausted. P5b: an open
        // retry twins on the projection hash (its per-mode identity) where
        // an exact retry twins on the payload hash.
        const twin = deps.definitionStore
          .listSessionGrants(ctx.channel_session_id)
          .find(
            (row) =>
              row.approved_action_ref === ctx.approved_action_ref
              && row.scope.ingredient_ids?.includes(ctx.ingredient_slug) === true
              && row.arg_shape_hash === ctx.arg_shape_hash
              && (grant_mode === 'open'
                ? row.grant_mode === 'open'
                  && row.pinned_projection_hash === ctx.pinned_projection_hash
                : (row.grant_mode ?? 'exact') === 'exact'
                  && row.canonical_payload_hash === ctx.canonical_payload_hash),
          );
        if (twin !== undefined) {
          console.info(
            `[session-grant-resolver] mint skipped: grant '${twin.contract_id}' already `
              + `exists for approval ${ctx.approved_action_ref} (at-least-once resume retry)`,
          );
          return;
        }
        const minted_at = now();
        const def = deps.definitionStore.mintSessionGrant({
          // N.5 — the owner is the only approver in the single-user model;
          // the answer reaches the resolver channel-stripped (D-158 I-10),
          // so the row's provenance is the role, not a device name.
          minted_by: 'owner',
          display_name:
            grant_mode === 'open'
              ? `Session grant (open) — ${ctx.operation_id ?? ctx.ingredient_slug}`
              : `Session grant — ${ctx.operation_id ?? ctx.ingredient_slug}`,
          // Bind every axis the envelope carried: the ingredient axis is
          // REQUIRED (N.3 — never a wildcard for session grants); operation /
          // connection bind exactly when the dispatch resolved them, and the
          // channel/actor axes pin the originating cell.
          scope: {
            channels: [ctx.channel],
            actors: [ctx.actor],
            ingredient_ids: [ctx.ingredient_slug],
            ...(ctx.operation_id !== undefined
              ? { operation_ids: [ctx.operation_id] }
              : {}),
            ...(ctx.connection_name !== undefined
              ? { connection_names: [ctx.connection_name] }
              : {}),
          },
          channel_session_id: ctx.channel_session_id,
          grant_mode,
          bound_recipe: { recipe_id: ctx.recipe_id, recipe_hash: ctx.recipe_hash },
          arg_shape_hash: ctx.arg_shape_hash,
          // codex HIGH fold — the row pins the approved tier; the matcher
          // requires equality (set-membership alone would let a write-
          // approved grant absorb an admin-tier re-classification).
          risk_tier: ctx.risk_tier,
          // The minting dispatch's payload hash lands on BOTH modes: it is
          // the exact arm's match identity, and forensic provenance on an
          // open row (the N.4 open arm never reads it).
          canonical_payload_hash: ctx.canonical_payload_hash,
          ...(grant_mode === 'open'
            ? {
                pinned_projection_hash: ctx.pinned_projection_hash,
                open_projection: ctx.open_projection,
              }
            : {}),
          ...(ctx.entity_scope !== undefined
            ? { entity_scope: ctx.entity_scope }
            : {}),
          // D-177 N.14 — a door dispatch's mint binds the grant to its
          // governing door contract (the matcher + consume both require
          // equality; an anonymous-scoped mint without it is refused at
          // the store — fail loud, never a silently-inert row).
          ...(ctx.source_contract_id !== undefined
            ? { bound_contract_id: ctx.source_contract_id }
            : {}),
          approved_action_ref: ctx.approved_action_ref,
          expiry_at: minted_at + ctx.ttl_ms,
          max_uses: ctx.max_uses,
        });
        // D-120 — the mint is audited. Reserve-class: a session grant is a
        // bounded loosening of the ask gate (an access-surface change, the
        // same forensic posture as inbound-token issuance), so the row
        // survives retention pruning. Best-effort: an audit failure never
        // unwinds the mint (the grant row itself is the durable record).
        if (deps.auditLog !== undefined) {
          void deps.auditLog
            .logActivity({
              activity_id: '',
              timestamp: minted_at,
              action: 'session_grant_minted',
              target: def.contract_id,
              detail: JSON.stringify({
                grant_mode,
                ingredient_slug: ctx.ingredient_slug,
                ...(ctx.operation_id !== undefined
                  ? { operation_id: ctx.operation_id }
                  : {}),
                ...(ctx.connection_name !== undefined
                  ? { connection_name: ctx.connection_name }
                  : {}),
                risk_tier: ctx.risk_tier,
                recipe_id: ctx.recipe_id,
                channel: ctx.channel,
                channel_session_id: ctx.channel_session_id,
                expiry_at: def.expiry_at,
                max_uses: ctx.max_uses,
                approved_action_ref: ctx.approved_action_ref,
                ...(grant_mode === 'open'
                  ? { pinned_projection_hash: ctx.pinned_projection_hash }
                  : {}),
              }),
            })
            .catch(() => {
              /* best-effort — the grant row is the durable record */
            });
        }
        try {
          deps.broadcast?.({
            kind: 'contract.contract_definition_changed',
            op: 'mint',
            contract_id: def.contract_id,
          });
        } catch {
          /* observability-only — never unwind the mint */
        }
      } catch (e) {
        // SessionGrantMintError (a malformed input — an approval-layer bug
        // surfacing at its source) or a store write failure. The dispatch
        // the human approved proceeds; the convenience grant is dropped.
        console.warn(
          `[session-grant-resolver] mint failed for ingredient '${ctx.ingredient_slug}' `
            + `(run ${ctx.approved_action_ref}): `
            + (e instanceof Error ? e.message : String(e)),
        );
      }
    },
  };
};
