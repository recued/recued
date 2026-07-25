/** D-177 P2 — the N.4 session-grant match predicate (pure).
 *
 *  A SessionGrant is a `contract_definition` row with `grant_kind: 'session'`
 *  (N.3 — `contract-definition.ts`): server-minted by the approval layer from a
 *  human answer, bound to one channel session + one recipe identity + one arg
 *  shape, and CONSUMED at the Gateway's ask-branch — never merged through the
 *  policy algebra (D2: grants only absorb `ask`; they are not policy).
 *
 *  This module is the PURE half: `matchesSessionGrant(grant, ctx, nowMs)`
 *  evaluates the N.4 step-3 predicate — the COMMON clauses every mode must
 *  satisfy, then the per-mode clause — and `matchesDelegationRule` (N.13,
 *  P6a) evaluates the same shared predicate for `grant_kind: 'delegation'`
 *  rows: the ladder-6 standing rule, scope-bound instead of session-bound,
 *  `write`-only in v1, exact/open modes only. The impure half (the
 *  `channel_session_id`-indexed lookup + the delegation listing + the
 *  consume-at-proceed-point write) lives server-side
 *  (`session-grant-resolver.ts` over `contract-definition-store.ts`); the
 *  Gateway calls both through the `CommitGatewayDeps.sessionGrants` seam.
 *
 *  Fail-closed posture throughout (N.9.3): every clause requires an EXPLICIT
 *  positive — a missing field, an empty string, an unknown `grant_mode`, an
 *  out-of-vocabulary risk tier, or a scope the dispatch can't prove itself
 *  inside all yield NO MATCH, and a no-match simply falls back to today's hold
 *  (`PreflightRequiredSignal` → checkpoint → `notification.ask`). Drift needs
 *  no detector: any material change — recipe content, operation, connection,
 *  arg shape, payload, entity scope — fails the equality and re-asks.
 *
 *  Spec: D-177 § N.3 / N.4 / N.9; landing order P2. */

import { isDelegatedMcpToken } from './commits.js';
import type { Actor, Channel } from './commits.js';
import { canonicalizeEmail } from './contact.js';
import type { RiskTier } from './ingredient.js';
import type { OperationApproval } from './ingredient-catalog.js';
import {
  contractScopeMatches,
  isContractActive,
  SCOPED_GRANT_SOURCES,
  type ContractDefinition,
} from './contract-definition.js';
import {
  isWellFormedOpenProjection,
  type OpenProjection,
} from './open-projection.js';

/** The risk tiers a session grant may absorb an `ask` for (D7 + D-211 Slice
 *  3): read joins write/admin so an explicitly tightened read can occupy the
 *  session rung; destructive never does. Approval provenance independently
 *  prevents every tier's `always` posture from matching a live session row. */
export const SESSION_GRANT_RISK_TIERS = ['read', 'write', 'admin'] as const satisfies
  readonly RiskTier[];

/** D-177 N.13 (P6a) — the risk tiers a DELEGATION RULE may absorb an `ask`
 *  for: deliberately STRICTER than {@link SESSION_GRANT_RISK_TIERS}. A
 *  delegation rule is standing cross-session authority (ladder step 7 — "auto
 *  with audit"), so v1 admits `write` only: `admin` delegation stays a
 *  deliberate hand-mint through the contracts surface, never a suggested
 *  promotion (ratified fork 2026-06-10). Widening later is this one line.
 *  The matcher enforces it row-and-envelope-side (a hand-shaped `admin`
 *  delegation row is inert), and the P6c suggestion learner + accept-mint use
 *  it as their suggest/mint ceiling. */
export const DELEGATION_RULE_RISK_TIERS = ['write'] as const satisfies
  readonly RiskTier[];

/** D-177 N.13 (P6c) — the minted delegation rule's TTL bound (ratified fork
 *  3: rule bounds are code constants, not per-cell vocabulary). The accept
 *  card may TIGHTEN (a shorter TTL) but never widen — the rpc and the store
 *  mint both enforce this ceiling, so a longer-lived rule is unrepresentable.
 *  Deliberately equals `DELEGATION_SUGGEST_LOOKBACK_MS` (the P6b learner's
 *  evidence window, which is DEFINED as this constant): while a minted rule
 *  lives its key raises no asks, so by natural expiry the pre-mint evidence
 *  has aged out and a re-suggestion needs genuinely fresh repeats. */
export const DELEGATION_RULE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** D-177 N.13 (P6c) — the rule's use-budget ceiling (fork 3; tighten-only
 *  editable on the accept card, same ceiling posture as
 *  {@link DELEGATION_RULE_TTL_MS}). */
export const DELEGATION_RULE_MAX_USES = 100;

/** The envelope-side tuple the N.4 predicate evaluates a grant against — the
 *  per-call ActionEnvelope view (N.1) narrowed to the match-relevant fields.
 *  The Gateway supplies everything it owns per call (slug, trusted operation
 *  key, resolved connection, the admission decision's risk tier, the P1b
 *  hashes, the run identity's channel/actor/session); the host closure adds
 *  the run's recipe identity (`recipe_id` + `recipe_hash`), which never
 *  crosses the Gateway seam. */
export interface SessionGrantMatchContext {
  readonly channel: Channel;
  readonly actor: Actor;
  /** The dispatching run's D-153 tier-1 session id (`CommitRunIdentity`). */
  readonly channel_session_id: string;
  /** D-177 N.14 — the dispatching run's governing DOOR contract id
   *  (`ExecutionSource.contract_id`), supplied by the host closure for
   *  door dispatches (the reception door and — N.14.6 — the delegated mcp
   *  door). Matched against a grant's `bound_contract_id` fail-closed
   *  ASYMMETRIC: a bound grant requires equality, and a DOOR ctx never
   *  matches an UNBOUND grant regardless of this field. Absent on
   *  owner-direct / contract-free dispatches — existing `user_self` grants
   *  and contexts are untouched. */
  readonly source_contract_id?: string;
  /** N.14.6 — the dispatching run's `ExecutionSource.mcp_token_id`, the ONLY
   *  field that tells the owner's own local stdio / CLI client from a delegated
   *  inbound door: the mcp channel forces BOTH to `contracted_user` + a
   *  `contract_id`, so `channel` and `actor` cannot classify this dispatch and
   *  the door clause below would otherwise sweep the owner in with the doors.
   *  Read ONLY through {@link isDelegatedMcpToken}, and only on `channel: 'mcp'`.
   *  Absent ⇒ delegated (fail closed — see that predicate's note). */
  readonly mcp_token_id?: string;
  readonly ingredient_slug: string;
  /** The catalog op's SHORT `operations`-map key (e.g. `deal.read`), present
   *  exactly when the dispatch carried a TRUSTED `surface_operation_key`
   *  (`stepMeta.surface_dispatch === true` — same can't-forge rule as the
   *  P1b exclusion lookup). Absent on simple-form dispatches. */
  readonly operation_id?: string;
  /** The resolved `connection` wire arg, when the dispatch carries one. */
  readonly connection_name?: string;
  /** The dispatching run's recipe identity (N.4). OPTIONAL since D-182 §8 — a
   *  RECIPE-LESS dispatch (a raw op the LLM calls without a recipe) carries
   *  neither. The recipe-bound modes (`'exact'`/`'batch'`/`'open'`) require BOTH
   *  to equal the grant's `bound_recipe`, so an absent identity simply never
   *  matches a recipe-bound grant (fail closed); the recipe-less modes
   *  (`'scoped'`/`'raw_op'`) never read them. */
  readonly recipe_id?: string;
  readonly recipe_hash?: string;
  /** The admission decision's tier (the `'ask'` verdict carries it). */
  readonly risk_tier: RiskTier;
  /** D-209 §1.7 — authorization approval before review/quality lifts. A
   *  session match requires `never` or `ask`; `always` (and malformed runtime
   *  input) skips only the session pass, leaving delegation matching live. */
  readonly pre_lift_approval: OperationApproval;
  /** P1b canonical action identity — both REQUIRED: a dispatch whose payload
   *  could not be canonicalized carries no hashes and must never grant-match
   *  (the Gateway skips the lookup entirely in that degraded form). */
  readonly arg_shape_hash: string;
  readonly canonical_payload_hash: string;
  /** Primary-entity binding when the op declares one (N.1 — reserved; nothing
   *  stamps it today). Matched both-absent-or-equal. */
  readonly entity_scope?: string;
  /** D-177 P5b (N.11) — the FIRE's recomputed `pinned_projection_hash`: the
   *  canonical hash over this dispatch's own open-projection walk (authority
   *  args → boundary roots → origin classes → pinned resolved values),
   *  computed by the same closure the mint used. Present exactly when the
   *  walk fully classified (rule 2 — a refused walk supplies nothing, and an
   *  absent hash can never match an `'open'` grant: fail closed). Equality
   *  against the grant's stored hash IS the per-mode `'open'` check: every
   *  pinned root resolving identically, every clean root still classifying
   *  clean, the whole authority structure unchanged. */
  readonly open_pinned_projection_hash?: string;
  /** D-177 N.11 rule 5 (rev 10, 5.d) — the held dispatch's CANONICAL email
   *  destination tokens (the N.2 destination authority value, extracted +
   *  `canonicalizeEmail`-normalized by the gateway closure; arrays
   *  element-wise). Present exactly when the dispatch's destination shape is
   *  the email kind v1 defines equality for (5.i.3) — absent ⇒ a `'scoped'`
   *  grant never matches (fail closed). */
  readonly destination_emails?: ReadonlyArray<string>;
  /** D-177 N.11 rule 5 (5.d hot-path) — the per-session forwarded-sender
   *  candidate index, supplied by the resolver seam (a NARROW precomputed
   *  index maintained as items are contributed — never a synchronous history
   *  mine, N.9.8). Each candidate is the EXTRACTED canonical sender token of
   *  a USER-contributed forwarded mail item (5.f contributor stamp gates
   *  eligibility upstream) with its contribution time. Absent ⇒ a `'scoped'`
   *  grant never matches. */
  readonly scoped_sender_candidates?: ReadonlyArray<ScopedSenderCandidate>;
}

/** D-177 N.11 rule 5 — one entry of the per-session forwarded-sender index. */
export interface ScopedSenderCandidate {
  /** The extracted, canonicalized sender address token (extraction-time
   *  concerns — confusables / IDN / `mailto:`-vs-display — are the index
   *  builder's; equality here is over the extracted token, 5.d). */
  readonly email: string;
  /** Epoch-ms the user contributed the forwarded item to the session. */
  readonly contributed_at: number;
}

/** D-177 P3 — the full mint-side context the approval layer hands the
 *  server's session-grant resolver: the SAME envelope tuple the N.4 match
 *  predicate evaluates (so a minted grant matches the very dispatch shape it
 *  was minted from — one vocabulary, two directions) plus the bounds and the
 *  approval anchor the N.5 mint stamps. Produced at the commit Gateway's
 *  resume-admitted ask-branch from the resume dispatch's OWN envelope — the
 *  hashes are recomputed from the merged resolved args by construction, which
 *  is exactly the D9 "approve-with-edits mints from the merged args" rule. */
export interface SessionGrantMintContext extends SessionGrantMatchContext {
  /** Grant lifetime from the offer (`expiry_at = now + ttl_ms`, N.5). */
  readonly ttl_ms: number;
  /** Use budget from the offer — seeds `uses_remaining` (N.5). */
  readonly max_uses: number;
  /** Audit anchor of the minting approval (D8) — the paused/resumed run's
   *  `run_id` (the execution-request anchor; the checkpoint itself is
   *  consumed at answer time, so the durable anchor is the audit row). */
  readonly approved_action_ref: string;
  /** D-177 P5b (N.11) — the mode the ask OFFERED and the human answered.
   *  `'open'` requires both projection fields below (the resolver refuses an
   *  open mint without them — fail closed); absent/`'exact'` mints today's
   *  exact-hash grant. */
  readonly grant_mode?: 'exact' | 'open';
  /** `'open'` only — the canonical projection hash recomputed from the
   *  RESUME dispatch's own walk (the D9 merged-args basis: an
   *  approve-with-edits resume pins the edited values). */
  readonly pinned_projection_hash?: string;
  /** `'open'` only — the normative rule-6 structure the hash covers; stored
   *  on the grant row for the inspector + the N.4 well-formedness check. */
  readonly open_projection?: OpenProjection;
}

/** D-177 P3/P4 — per-cell session-grant defaults (the N.6 vocabulary): the
 *  shape both the `policy_matrix_cell.session_grant_defaults` field (P4) and
 *  the in-code seed constant carry. Structurally validated at the store by the
 *  `session_grant_defaults` value_shape (`contract-schema.ts`); strictness is
 *  ranked on the canonical `session_grant_*` lattice fields
 *  (`contract-merge.ts`) and a policy-matrix write may only TIGHTEN it
 *  relative to the in-code baseline seed (the store's put-path floor guard —
 *  `sessionGrantDefaultsFloorViolations`, `policy-matrix.ts`). */
export interface SessionGrantDefaults {
  /** Grant lifetime (lattice ≤ — stricter = lower). */
  readonly ttl_ms: number;
  /** Use budget (lattice ≤ — stricter = lower). */
  readonly max_uses: number;
  /** Tiers `allow_session` may be offered for — ⊆ {@link SESSION_GRANT_RISK_TIERS}
   *  (subset = stricter). */
  readonly grantable_risk_tiers: readonly RiskTier[];
}

/** D-177 P3/P4 — the N.6 `('chat', 'user_self')` seed values: conservative
 *  starting bounds (1 h TTL, 5 uses, write+admin grantable — `destructive` is
 *  never session-grantable, D7). Since P4 these live ON the seeded
 *  `('chat','user_self')` cell (`BASELINE_POLICY_MATRIX_CELLS` references this
 *  constant, so seed and fallback can never drift). Doubles as the FLOOR the
 *  store's put-path guard enforces: a runtime cell edit may tighten below
 *  these values, never loosen above. The P5 follow-on seeded the other two
 *  attended ask-channels alongside it — see
 *  {@link SESSION_GRANT_DEFAULT_SEEDS}; every UNSEEDED `(channel × actor)`
 *  cell declares no defaults, so `allow_session` is simply not offered there
 *  (fail closed until a code-seed change declares defaults). */
export const CHAT_SESSION_GRANT_DEFAULTS: SessionGrantDefaults = {
  ttl_ms: 3_600_000,
  max_uses: 5,
  grantable_risk_tiers: ['read', 'write', 'admin'],
};

/** D-177 P5 (N.6 / resolved Q8) — the `('messenger', 'user_self')` seed: the
 *  owner sending themselves commands via Slack / Telegram / email. Values
 *  MIRROR the chat seed per resolved Q8 ("mirror the chat seed when wanted")
 *  — a deliberate copy, NOT a reference, so per-channel tuning stays a
 *  one-line change and the put-path floor guard keys on this cell's own seed.
 *  Owner cell only: `('messenger', 'contracted_user')` — a third party
 *  messaging in under a contact-bound contract — stays UNSEEDED (fail
 *  closed); standing repeat authority for an external party's dispatches is a
 *  categorically different trust posture than the owner's own remote
 *  commands. */
export const MESSENGER_SESSION_GRANT_DEFAULTS: SessionGrantDefaults = {
  ttl_ms: 3_600_000,
  max_uses: 5,
  grantable_risk_tiers: ['read', 'write', 'admin'],
};

/** D-177 P5 (N.6 / resolved Q8) — the `('mcp', 'contracted_user')` seed: the
 *  canonical contracted-AI surface (the owner's own assistant operating
 *  Recued over MCP through a D-171 door). `mcp` has no `user_self` cell —
 *  the contracted cell IS the mcp ask surface, and the contract (not this
 *  seed) stays the admissibility gate; the seed only lets the owner answer a
 *  contract-admitted hold with `allow_session`. The owner is the only
 *  approver (N.5) — the grant extends the OWNER's answer, never the agent's
 *  authority. Values mirror the chat seed (resolved Q8); deliberate copy for
 *  independent tuning, as above. */
export const MCP_SESSION_GRANT_DEFAULTS: SessionGrantDefaults = {
  ttl_ms: 3_600_000,
  max_uses: 5,
  grantable_risk_tiers: ['read', 'write', 'admin'],
};

/** D-177 N.14 (owner-ratified 2026-07-16) — the `(reception, anonymous)`
 *  seed: the reception DOOR cell. Reception holds ARE human-answered (the
 *  D-173 inbox is their answer surface), and every fire on a door shares the
 *  door's STABLE `channel_session_id` (`reception:<reception_id>` — the
 *  runner sets no visitor_id), so an `allow_session` answer here reads
 *  "allow for this form": the minted grant absorbs subsequent fires on THAT
 *  door until TTL/uses run out, then the next hold re-offers. Door-scaled
 *  bounds (a form takes fires over days, not a chat hour): 24 h / 20 uses.
 *  `write` ONLY — a reception hold is write-tier by construction (the
 *  reader-pinned `read` ceiling holds every write; `admin`/`destructive`
 *  never door-grant). The N.14 mint additionally stamps the door's
 *  `bound_contract_id` and the matcher's asymmetric door clauses apply —
 *  see `matchesGateGrant`. */
export const RECEPTION_SESSION_GRANT_DEFAULTS: SessionGrantDefaults = {
  ttl_ms: 86_400_000,
  max_uses: 20,
  grantable_risk_tiers: ['write'],
};

/** N.14.6 — is this dispatch a DOOR (an outside identity reaching in through an
 *  externally-established entry point) rather than the owner?
 *
 *  Two door families, each classified by the only field that can honestly carry
 *  the distinction on its channel:
 *    - `anonymous` — the reception visitor. The ACTOR says it (N.14 v1).
 *    - delegated `mcp` — an inbound bearer. The actor CANNOT say it: the mcp
 *      channel forces the owner's own stdio client to `contracted_user` + a
 *      `contract_id` too, so only {@link isDelegatedMcpToken} separates them.
 *
 *  Everything else is NOT a door, and deliberately so: a self-restricted
 *  `user_self` and the owner's contracted chat both carry a `contract_id`
 *  (`commits.ts`), and sweeping them in by field presence would strip the owner
 *  of their own unbound grants.
 *
 *  ⚠ The `llm_gateway` door IS a door and is deliberately NOT classified here —
 *  because it cannot hold a session grant at all, for TWO independent reasons, and
 *  a clause that cannot fire is not a fence, it is decoration:
 *    1. Its cell `(chat, contracted_user)` is UNSEEDED
 *       ({@link SESSION_GRANT_DEFAULT_SEEDS} — only `(chat, user_self)`,
 *       `(messenger, user_self)`, `(mcp, contracted_user)`, `(reception, anonymous)`),
 *       so `resolveSessionGrantOffer` never offers `allow_session` and no grant is
 *       ever minted for it.
 *    2. Its session id carries a per-request `randomUUID()`
 *       (`ports/llm-gateway/handler.ts` `sharedGatewayTurnInput`), so the tier-1 key
 *       `chat:llm_gateway:<token>:<uuid>` never repeats — a grant could not match a
 *       second call even if one existed.
 *  ⇒ NOT a second instance of the mcp defect. (An earlier note here claimed it was;
 *  that read a THROWAWAY source-shaped object in the llm-gateway handler — built only
 *  to resolve scope restrictions, with a fabricated stable `chat_session_id` — as if
 *  it were the dispatch source. The real one is `chat-orchestrator.ts`
 *  `runLlmGatewayTurn`.)
 *
 *  🔑 THE PRECONDITION THAT WOULD CHANGE THIS: seeding `(chat, contracted_user)`.
 *  That single change makes llm_gateway able to hold grants while it still classifies
 *  as NOT-a-door — i.e. it would CREATE the mcp defect on the chat channel. A tripwire
 *  test pins the cell as unseeded for exactly this reason. If you seed it, give
 *  llm_gateway a first-class door signal on `ExecutionSource` FIRST — never a
 *  `chat_session_id` prefix sniff, which is a naming convention wearing a fence's
 *  clothes. */
export const isDoorMatchContext = (ctx: {
  readonly channel: Channel;
  readonly actor: Actor;
  readonly mcp_token_id?: string;
}): boolean =>
  ctx.actor === 'anonymous'
  || (ctx.channel === 'mcp' && isDelegatedMcpToken(ctx.mcp_token_id));

/** D-177 P5 (N.6) — the seeded cells in one table: the three attended
 *  ask-channels (`chat` / `messenger` / `mcp` — the channels whose holds a
 *  human answers) plus — N.14 — the `(reception, anonymous)` door cell (a
 *  reception hold is answered by the owner in the D-173 inbox, so it is an
 *  attended ask surface too; the EVENT-FIRE channels never raise an ask, so
 *  a seed there would be a provable no-op). Single source of truth for BOTH consumers:
 *  `BASELINE_POLICY_MATRIX_CELLS` references these very objects on its cells
 *  and `resolveSessionGrantOffer`'s no-row fallback resolves through
 *  {@link seededSessionGrantDefaults} — the policy-matrix module-load
 *  assertion (`assertSessionGrantSeedLockstep`) pins the two views to the
 *  same object per cell, so seed and fallback can never drift. */
export const SESSION_GRANT_DEFAULT_SEEDS: ReadonlyArray<{
  readonly channel: Channel;
  readonly actor: Actor;
  readonly defaults: SessionGrantDefaults;
}> = [
  { channel: 'chat', actor: 'user_self', defaults: CHAT_SESSION_GRANT_DEFAULTS },
  {
    channel: 'messenger',
    actor: 'user_self',
    defaults: MESSENGER_SESSION_GRANT_DEFAULTS,
  },
  {
    channel: 'mcp',
    actor: 'contracted_user',
    defaults: MCP_SESSION_GRANT_DEFAULTS,
  },
  {
    channel: 'reception',
    actor: 'anonymous',
    defaults: RECEPTION_SESSION_GRANT_DEFAULTS,
  },
];

/** The in-code seed defaults for a `(channel, actor)` cell, or `undefined`
 *  when the cell is unseeded (no offer — fail closed). The no-row fallback
 *  half of `resolveSessionGrantOffer`, and the comparison basis for the
 *  policy-matrix lockstep assertion. Accepts plain strings so callers with
 *  unvalidated row segments stay type-safe. */
export const seededSessionGrantDefaults = (
  channel: Channel | string,
  actor: Actor | string,
): SessionGrantDefaults | undefined =>
  SESSION_GRANT_DEFAULT_SEEDS.find(
    (seed) => seed.channel === channel && seed.actor === actor,
  )?.defaults;

/** D-177 P3 — what a `gateway.preflight` ask offers alongside the
 *  `allow_session` option, and what the mint consumes on that answer: the
 *  bounds snapshot taken from the owner cell's defaults at RAISE time (so the
 *  answer mints exactly what the ask offered, even if the defaults are tuned
 *  while the ask is outstanding), plus the tier the ask SHOWED the human
 *  (codex HIGH fold — the mint refuses when the resume re-evaluates to a
 *  different tier: the grant must pin what was approved, not what drifted). */
export interface SessionGrantOffer {
  readonly ttl_ms: number;
  readonly max_uses: number;
  /** The hold's tier as offered — the mint precondition compares it to the
   *  resume decision's tier and skips the mint on drift. */
  readonly risk_tier: RiskTier;
  /** D-177 P5b (N.11) — the mode this offer mints. `'open'` is set by the
   *  RAISE SITE exactly when the hold's open-projection walk succeeded (the
   *  signal carried a preview — feasibility proven on this very dispatch);
   *  absent/`'exact'` keeps the P3 exact-hash mint. Rides the ask payload →
   *  answer → resume marker, so the mint executes precisely the mode the
   *  rendered sentence described (rule 7 — the sentence IS the grant).
   *
   *  D-182 §8 — `'raw_op'` is set by the recipe-less raw-op door hold (the
   *  `mcp × contracted_user` cell): the offer's bounds/tier come from the SAME
   *  `resolveSessionGrantOffer` resolution as a recipe hold, but the
   *  `allow_session` answer mints through `mintRawOpGrant` (the recipe-less
   *  exact-payload primitive) instead of the recipe-bound resolver. It never
   *  upgrades to `'open'` (a raw op carries no recipe to walk authority args
   *  against). */
  readonly grant_mode?: 'exact' | 'open' | 'raw_op';
}

/** D-177 P3/P4 — resolve whether `allow_session` is offered for a hold, and
 *  with what bounds (N.5). Fail-closed on every clause: defaults must exist
 *  for the `(channel × actor)` cell (the attended ask-channel seeds —
 *  {@link SESSION_GRANT_DEFAULT_SEEDS}, N.6 item 2), the hold's `risk_tier`
 *  must be a known tier inside BOTH the cell's `grantable_risk_tiers` and the
 *  {@link SESSION_GRANT_RISK_TIERS} ceiling (D7 — `destructive` never grants),
 *  and the hold's pre-lift approval must be known and not `always`. An absent /
 *  unknown tier or provenance offers nothing. The host adds run-shape conditions
 *  it owns (resumable checkpoint path, commit-gateway hold, a wired resolver)
 *  before calling.
 *
 *  SOURCE (D-187 slice 6 — the policy-matrix retirement): the defaults come
 *  from the in-code {@link SESSION_GRANT_DEFAULT_SEEDS} table (the three
 *  attended ask-channel cells). The retired
 *  `contract.policy_matrix.<channel>.<actor>` cell once carried a
 *  runtime-tunable `session_grant_defaults` override read through a
 *  contract-store `scan`, but no surface ever tuned it — the boot seed wrote
 *  the in-code values verbatim and slice 5 retired the overlay rpc — so the
 *  in-code seed is now the single source, byte-identical to the prior
 *  row-then-fallback resolution. A per-contract trust raise (the flagged
 *  follow-on) is where a future authored override re-enters. */
export const resolveSessionGrantOffer = (args: {
  readonly channel: Channel;
  readonly actor: Actor;
  /** The hold's tier as surfaced on the preflight signal — `string` (not
   *  `RiskTier`) because legacy raise sites may omit or widen it; anything
   *  not a known grantable tier resolves to no offer. */
  readonly risk_tier: string | undefined;
  /** D-209 §1.7 provenance from the real admission resolution. Missing is
   *  fail-closed: a legacy/unclassified hold gets no session-loosening option. */
  readonly pre_lift_approval: OperationApproval | undefined;
}): SessionGrantOffer | undefined => {
  const defaults = seededSessionGrantDefaults(args.channel, args.actor);
  if (defaults === undefined) return undefined;
  if (args.risk_tier === undefined) return undefined;
  if (
    args.pre_lift_approval !== 'never'
    && args.pre_lift_approval !== 'ask'
  ) return undefined;
  if (!(SESSION_GRANT_RISK_TIERS as readonly string[]).includes(args.risk_tier)) {
    return undefined;
  }
  if (
    !(defaults.grantable_risk_tiers as readonly string[]).includes(args.risk_tier)
  ) {
    return undefined;
  }
  // The membership check above proves `risk_tier` ∈ SESSION_GRANT_RISK_TIERS
  // ⊆ RiskTier — the narrowing is sound.
  return {
    ttl_ms: defaults.ttl_ms,
    max_uses: defaults.max_uses,
    risk_tier: args.risk_tier as RiskTier,
  };
};

/** A present, non-empty string — the runtime-defensive shape check for fields
 *  read off a JSON row (the value_shape admits `null` for every optional
 *  descriptor, and a hand-authored row could carry anything). */
const nonEmptyString = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0;

/** Internal — which gate-grant vocabulary {@link matchesGateGrant} evaluates.
 *  `'session'` is the P2 session grant (session-bound, D6); `'delegation'` is
 *  the N.13 ladder-6 delegation rule (scope-bound, no session binding). */
type GateGrantVariant = 'session' | 'delegation';

/** The N.4 match predicate, shared by both gate-consumed grant kinds: true
 *  iff `grant` admits the dispatch described by `ctx` at `nowMs`. Pure — no
 *  I/O, no clock reads, no mutation; consumption (the use decrement / member
 *  claim) is the caller's separate write at the dispatch proceed point, NOT
 *  part of matching.
 *
 *  Clause order mirrors N.4 step 3 — common predicate (ALL must hold for
 *  every mode), then per-mode:
 *
 *    common  `grant_kind` equals the variant's EXPLICIT literal ∧ live
 *            (`isContractActive`) ∧ the variant's binding clause —
 *            `'session'`: `channel_session_id` equal (D6);
 *            `'delegation'`: NO session binding on the row (scope replaces
 *            it — N.13; a delegation row carrying one is malformed → inert)
 *            ∧ risk tier within the variant's ceiling (D7 / N.13 fork 2) ∧
 *            `risk_tier` pinned-and-equal (P3 codex HIGH fold) ∧
 *            scope match (channel / actor / ingredient / operation /
 *            connection) ∧ `bound_recipe` equal ∧ `arg_shape_hash` equal ∧
 *            `entity_scope` both-absent-or-equal
 *    exact   (and any absent or unrecognized `grant_mode` — fail closed)
 *            `canonical_payload_hash` equal
 *    batch   P5a (N.10), SESSION-ONLY — an UNCONSUMED member's payload hash
 *            equals the envelope's (candidate match; the atomic claim is the
 *            proceed-point consumption — a lost claim race re-holds). A
 *            member set is ONE approval's enumeration, inherently
 *            session-bound — a `'batch'` delegation row is malformed → inert
 *            (N.13).
 *    open    P5b (N.11) — the fire's recomputed `pinned_projection_hash`
 *            equals the grant's ∧ the stored `open_projection` is
 *            well-formed (a refused fire walk supplies no hash → no match)
 *    raw_op  D-182 §8, SESSION-ONLY — the recipe-less raw-op door grant.
 *            RECIPE-LESS (the common `bound_recipe` clause is skipped, like
 *            `'scoped'`) but it HAS a minting dispatch, so it KEEPS the
 *            common `arg_shape_hash` pin and adds: operation axis explicit
 *            (never a wildcard) ∧ connection explicit when the dispatch
 *            resolves one (never wildcard) ∧ `canonical_payload_hash` equal
 *            (conservative v1 — exact payload). A `'raw_op'` delegation row
 *            is malformed → inert.
 *
 *  Two deliberate strictnesses beyond `contractScopeMatches`' wildcard
 *  semantics (codex HIGH fold, N.3): a gate grant's scope must EXPLICITLY
 *  name the dispatched ingredient — an empty `ingredient_ids` axis is a
 *  wildcard for standing contracts but NEVER for gate grants, else a grant
 *  could match across different tools sharing an arg shape. Likewise
 *  `arg_shape_hash` (and, for `'session'`, `channel_session_id`) must be
 *  PRESENT on the row, and `bound_recipe` for every RECIPE-BOUND mode
 *  (`'exact'`/`'batch'`/`'open'` — the recipe-less `'scoped'`/`'raw_op'`
 *  modes bind on op + connection scope instead). A grant row missing its
 *  bindings is malformed and inert. */
/** D-177 N.11 rule 5 (5.d) — the `'scoped'` containment predicate, shared
 *  VERBATIM by the match arm and the consume arm (the 5.a build constraint:
 *  consumption RE-VERIFIES containment at the proceed point, so a resolver
 *  bug can never spend a scoped use on a divergent fire — same
 *  defense-in-depth posture as the batch claim / open hash re-verify).
 *
 *  All deterministic, all fail-closed:
 *  - the row's `scoped_source` must be in the closed {@link SCOPED_GRANT_SOURCES}
 *    vocabulary (v1 exactly `'forwarded_item_sender'`);
 *  - the dispatch must carry at least one canonical destination email and the
 *    caller a candidate index (absent either ⇒ no match — a destination shape
 *    v1 defines no equality for falls through to ask, 5.i.3);
 *  - EVERY destination must EQUAL — canonical, exact, never substring — some
 *    candidate sender contributed within `[minted_at, expiry_at]` (5.d
 *    time-bounded eligibility: "each email I forward this afternoon" means
 *    items forwarded DURING the grant, not week-old history). Arrays check
 *    element-wise. */
export const scopedContainmentAdmits = (
  grant: ContractDefinition,
  call: Pick<
    SessionGrantMatchContext,
    'destination_emails' | 'scoped_sender_candidates'
  >,
): boolean => {
  if (
    grant.scoped_source === undefined
    || !(SCOPED_GRANT_SOURCES as readonly string[]).includes(grant.scoped_source)
  ) {
    return false;
  }
  // The window. `expiry_at` presence is enforced by the common bounded-by-
  // construction clause on the match path; re-required here so the consume
  // arm (which runs this helper standalone) keeps the same posture.
  if (grant.expiry_at === undefined || grant.expiry_at === null) return false;
  const windowStart = grant.minted_at;
  const windowEnd = grant.expiry_at;
  const destinations = call.destination_emails;
  const candidates = call.scoped_sender_candidates;
  if (!destinations || destinations.length === 0) return false;
  if (!candidates) return false;
  return destinations.every(
    (dest) =>
      nonEmptyString(dest)
      && candidates.some(
        (c) =>
          nonEmptyString(c.email)
          && c.email === dest
          && typeof c.contributed_at === 'number'
          && c.contributed_at >= windowStart
          && c.contributed_at <= windowEnd,
      ),
  );
};

/** D-177 N.11 rule 5 (slice D) — authority paths a `'scoped'` grant binds
 *  STRUCTURALLY rather than by destination equality: the connection-selector
 *  keys. The grant scope's `connection_names` axis already pins the resolved
 *  connection at match time (the 5.d "structurally bound by the grant"
 *  clause), so the selector value itself is not a destination and is exempt
 *  from the email-shape requirement below. Closed list — widening it exempts
 *  a path from containment, so every addition is a deliberate 5.d change. */
export const SCOPED_STRUCTURAL_AUTHORITY_PATHS: readonly string[] = [
  'connection',
  'connection_kind',
];

/** Dotted-path get over a resolved-args record (authority paths are
 *  `a.b`-style — `collectOperationAuthorityPaths` yields top-level keys plus
 *  the dotted wire baseline like `mcp.tool`).
 *
 *  Distinguishes ABSENT from PRESENT-BUT-UNWALKABLE (codex HIGH fold): a
 *  record intermediate missing the segment is genuine absence (`{ found:
 *  false }` — the dispatch carries nothing on that path, skip), but an
 *  intermediate that is an array / scalar / null while segments remain is a
 *  shape the walker cannot evaluate — e.g. `recipients.email` over
 *  `recipients: [{ email: ... }]` — and silently skipping it would leave a
 *  REAL authority value uncontained (fail open). Such paths report
 *  `unwalkable: true` and the extractor fails closed to no destinations. */
const getAtPath = (
  args: Readonly<Record<string, unknown>>,
  path: string,
): { found: boolean; unwalkable?: boolean; value?: unknown } => {
  let cur: unknown = args;
  const segs = path.split('.');
  for (let i = 0; i < segs.length; i++) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) {
      // Segments remain but the node can't be keyed into. `undefined`/
      // missing parents upstream already returned { found: false } below;
      // reaching here means a VALUE sits in the way — unwalkable.
      return { found: false, unwalkable: true };
    }
    const rec = cur as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(rec, segs[i])) {
      return { found: false };
    }
    cur = rec[segs[i]];
  }
  return { found: true, value: cur };
};

/** D-177 N.11 rule 5 (slice D, 5.d/5.i.3) — extract the held dispatch's
 *  CANONICAL destination email tokens from its authority-bearing args.
 *
 *  v1 defines containment equality for the EMAIL destination shape ONLY
 *  (5.i.3 — implementers must NOT invent ad-hoc containment for ids / urls /
 *  risk selectors). So the contract here is strictly fail-closed:
 *
 *  - every authority path PRESENT in the resolved args (absent / null /
 *    empty-string / empty-array values are "not dispatched on that path" and
 *    skip) must be either
 *      (a) a structural connection selector
 *        ({@link SCOPED_STRUCTURAL_AUTHORITY_PATHS} — bound by the grant's
 *        connection axis), or
 *      (b) email-shaped: a string `canonicalizeEmail` accepts, or an array
 *        of such strings (arrays check element-wise, 5.d);
 *  - ANY other authority value — a url, a record id, a message-id list, a
 *    non-string — means the dispatch carries authority v1 defines no
 *    equality for ⇒ return `undefined` (no `destination_emails` ⇒ the
 *    scoped arm never matches ⇒ ask);
 *  - zero collected emails also returns `undefined` (a dispatch with no
 *    email destination has nothing for a scoped grant to contain).
 *
 *  Deliberately PATH-INSENSITIVE (codex MEDIUM, disposition recorded): an
 *  email-shaped value on a non-recipient authority path (e.g. an
 *  `in_reply_to` message-id that parses as `local@domain`) is INCLUDED, so
 *  it too must EQUAL a forwarded-sender candidate — the literal 5.d clause
 *  ("every authority-bearing arg … must EQUAL"). Inclusion only ever
 *  NARROWS admission (one more equality to satisfy); distinguishing
 *  "destination" from "id that looks like an email" would need a per-path
 *  shape vocabulary v1 deliberately avoids.
 *
 *  Pure. The result feeds `SessionGrantMatchContext.destination_emails` at
 *  the gate's match AND the store-side consume re-verify (5.a). */
export const extractScopedDestinationEmails = (
  args: Readonly<Record<string, unknown>>,
  authorityPaths: readonly string[],
): string[] | undefined => {
  const found = new Set<string>();
  for (const path of authorityPaths) {
    if (SCOPED_STRUCTURAL_AUTHORITY_PATHS.includes(path)) continue;
    // codex HIGH fold — a dotted authority path may ALSO be a literal flat
    // wire key (`"body.cc"` as an own key of args). Evaluate BOTH readings;
    // each present value must independently pass the email-shape gate, so a
    // real authority value can never hide behind the other reading.
    const readings: unknown[] = [];
    const nested = getAtPath(args, path);
    if (nested.unwalkable === true) return undefined; // present-but-unwalkable — fail closed
    if (nested.found) readings.push(nested.value);
    if (
      path.includes('.')
      && Object.prototype.hasOwnProperty.call(args, path)
    ) {
      readings.push((args as Record<string, unknown>)[path]);
    }
    for (const value of readings) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value) && value.length === 0) continue;
      const elements = Array.isArray(value) ? value : [value];
      for (const el of elements) {
        if (typeof el !== 'string') return undefined; // non-email shape — fail closed
        if (el.trim().length === 0) continue; // empty slot ≙ not dispatched
        const email = canonicalizeEmail(el);
        if (email.length === 0) return undefined; // non-email authority value — fail closed
        found.add(email);
      }
    }
  }
  return found.size > 0 ? [...found] : undefined;
};

const matchesGateGrant = (
  grant: ContractDefinition,
  ctx: SessionGrantMatchContext,
  nowMs: number,
  variant: GateGrantVariant,
): boolean => {
  // ── Common predicate (N.4 step 3) ──────────────────────────────
  // The variant's explicit literal only — absent (= standing), the OTHER
  // gate-grant literal, and any future grant_kind vocabulary fail closed.
  if (variant === 'session') {
    if (grant.grant_kind !== 'session') return false;
  } else if (grant.grant_kind !== 'delegation') {
    return false;
  }
  // Live: not revoked, not past expiry_at, uses_remaining > 0 — the same
  // lifecycle every standing contract runs (N.3 "reuse verbatim").
  if (!isContractActive(grant, nowMs)) return false;
  // Bounded by construction (codex HIGH fold): every gate grant carries a
  // TTL and a use budget (the N.5 / N.13 mints require both — the N.11
  // confirm sentence's "for [TTL], up to [N] times" each map onto an
  // enforced bound). `isContractActive` treats ABSENT bounds as
  // unbounded-active, which is right for standing contracts but would let a
  // malformed/hand-shaped grant row auto-approve indefinitely — so require
  // both bounds present.
  if (grant.expiry_at === undefined || grant.expiry_at === null) return false;
  if (grant.uses_remaining === undefined || grant.uses_remaining === null) {
    return false;
  }
  if (variant === 'session') {
    // Session binding (D6) — the row must NAME this channel session.
    if (
      !nonEmptyString(grant.channel_session_id)
      || grant.channel_session_id !== ctx.channel_session_id
    ) {
      return false;
    }
  } else if (
    grant.channel_session_id !== undefined
    && grant.channel_session_id !== null
  ) {
    // N.13 — scope REPLACES the session binding on a delegation rule. A
    // delegation row carrying a session binding is malformed/hand-shaped —
    // inert, never "session-bound delegation" (that's what session grants
    // are; the vocabulary stays disjoint).
    return false;
  }
  // D7 + D-211 Slice 3 — grants absorb asks only within the variant's tier
  // ceiling: session grants read/write/admin; delegation rules write ONLY in
  // v1 (N.13 fork 2 — `admin` delegation stays a deliberate hand-mint).
  // `destructive` never session-grants; provenance separately blocks `always`.
  const tierCeiling: readonly string[] =
    variant === 'session' ? SESSION_GRANT_RISK_TIERS : DELEGATION_RULE_RISK_TIERS;
  if (!tierCeiling.includes(ctx.risk_tier)) {
    return false;
  }
  // D-177 P3 (codex HIGH fold) — the grant must pin the APPROVED tier and the
  // envelope must dispatch at exactly that tier. Set-membership alone would
  // let a grant minted for a `write` envelope absorb a later `admin`-tier ask
  // for the same call (same slug/args/recipe — the hashes don't move when a
  // MANIFEST re-classifies the tool's tier). A session row missing the tier
  // is malformed (the mint stamps it) — fail closed.
  if (!nonEmptyString(grant.risk_tier) || grant.risk_tier !== ctx.risk_tier) {
    return false;
  }
  // codex HIGH fold (N.3) — the ingredient axis is NEVER a wildcard for
  // session grants: the scope must explicitly name the dispatched slug.
  if (!grant.scope.ingredient_ids?.includes(ctx.ingredient_slug)) return false;
  // The remaining axes run the standard scope match: empty = wildcard, a
  // restricted axis the ctx can't supply fails closed (`contractScopeMatches`).
  if (
    !contractScopeMatches(grant.scope, {
      channel: ctx.channel,
      actor: ctx.actor,
      ingredient_id: ctx.ingredient_slug,
      ...(ctx.operation_id !== undefined
        ? { operation_id: ctx.operation_id }
        : {}),
      ...(ctx.connection_name !== undefined
        ? { connection_name: ctx.connection_name }
        : {}),
    })
  ) {
    return false;
  }
  // ── N.14 — the door binding (both directions, fail closed) ─────
  // 1. A grant CARRYING `bound_contract_id` matches ONLY a ctx supplying the
  //    same id — a door grant can never absorb another door's (or the
  //    owner's) dispatch. An owner ctx supplies no `source_contract_id`, so
  //    a bound grant is inert against it by this same clause.
  // 2. A DOOR ctx NEVER matches a grant that LACKS the binding — an unbound
  //    rule fanning onto doors by scope alone is the exact habituation hazard
  //    the N.13 owner-only pin guarded before this dimension existed
  //    (`delegation-suggestion.ts` rationale). Keyed on a door-CLASSIFIED
  //    source (N.14.6), never on field presence: a self-restricted
  //    `user_self` and a contracted chat both carry a `contract_id` and are
  //    NOT doors, so presence-keying would silently invalidate owner grants —
  //    the hazard the actor-keyed v1 deferred this clause to avoid.
  const boundContract = grant.bound_contract_id ?? undefined;
  if (boundContract !== undefined) {
    if (
      !nonEmptyString(boundContract)
      || boundContract !== ctx.source_contract_id
    ) {
      return false;
    }
  } else if (isDoorMatchContext(ctx)) {
    return false;
  }
  const mode = grant.grant_mode ?? 'exact';
  // Recipe identity binds every mode EXCEPT the two RECIPE-LESS modes —
  // `'scoped'` (N.11 rule 5, utterance-derived) and `'raw_op'` (D-182 §8, a raw
  // op the LLM calls without a recipe). Neither has a minting recipe to pin, so
  // both bind on op + connection scope (the per-mode arms below) instead.
  if (mode !== 'scoped' && mode !== 'raw_op') {
    // Recipe identity — both halves equal. Content drift (recipe_hash) re-asks.
    // A recipe-less dispatch (ctx.recipe_id/recipe_hash absent) never matches a
    // recipe-bound grant: the inequality against the grant's non-empty ids holds
    // (fail closed).
    if (
      grant.bound_recipe === undefined
      || grant.bound_recipe === null
      || !nonEmptyString(grant.bound_recipe.recipe_id)
      || !nonEmptyString(grant.bound_recipe.recipe_hash)
      || grant.bound_recipe.recipe_id !== ctx.recipe_id
      || grant.bound_recipe.recipe_hash !== ctx.recipe_hash
    ) {
      return false;
    }
  }
  // Arg key-shape binds every mode EXCEPT `'scoped'` (utterance-derived — no
  // minting dispatch, so no arg shape to pin). `'raw_op'` HAS a minting dispatch
  // (the approved raw-op call) and KEEPS the key-shape pin — a reshaped payload
  // (new/renamed/retyped keys) re-asks.
  if (mode !== 'scoped') {
    if (
      !nonEmptyString(grant.arg_shape_hash)
      || grant.arg_shape_hash !== ctx.arg_shape_hash
    ) {
      return false;
    }
  }
  // (N.11 rule 5, 5.a/5.d) — a `'scoped'` grant is UTTERANCE-derived: there
  // is no minting dispatch, so no recipe identity / arg key-shape / payload
  // hash exists to pin — its enforcement axes are op + connection binding +
  // TTL/session/max_uses + structured-field equality, all checked in the
  // scoped clauses below. The recipe/arg-shape clauses above are therefore
  // per-mode, not common; every OTHER mode keeps them verbatim.
  //
  // Entity scope — both-absent-or-equal (N.4). `null` on the row reads as
  // absent (the `string?` value_shape admits it). Scoped rows mint without
  // one, so a dispatch carrying an entity binding fails closed against them.
  const grantEntity = grant.entity_scope ?? undefined;
  if (grantEntity !== (ctx.entity_scope ?? undefined)) return false;

  // ── Per-mode (N.4 step 3, codex MEDIUM fold — modes do NOT share the
  // exact-hash check) ─────────────────────────────────────────────
  switch (mode) {
    case 'exact':
      return (
        nonEmptyString(grant.canonical_payload_hash)
        && grant.canonical_payload_hash === ctx.canonical_payload_hash
      );
    case 'raw_op':
      // D-182 §8 — the recipe-less raw-op door grant: a SESSION grant minted
      // from a human's per-call approval of a door's raw catalog op
      // (`allow_session` on a write-tier raw op). SESSION-ONLY in v1 (like
      // `'scoped'`) — a `'raw_op'` delegation row is malformed → inert.
      if (variant !== 'session') return false;
      // Recipe-less by construction (codex MEDIUM fold) — a raw_op grant is
      // minted from a recipe-LESS door dispatch and must ONLY absorb recipe-less
      // dispatches: the clean partition with the recipe-BOUND modes
      // (exact/batch/open, which require `bound_recipe` equality a recipe-less
      // ctx can never satisfy). A dispatch carrying a recipe identity fails
      // closed here, and a malformed raw_op row carrying a `bound_recipe` is
      // inert — so the recipe-less ⇔ recipe-bound split is symmetric both ways.
      if (ctx.recipe_id !== undefined || ctx.recipe_hash !== undefined) return false;
      if (grant.bound_recipe !== undefined && grant.bound_recipe !== null) return false;
      // Op-bound: the operation axis is NEVER a wildcard (the ingredient axis is
      // already explicit per the common clause), and the dispatch must carry the
      // TRUSTED operation key — a raw op IS an op, so no operation ⇒ no match.
      if (
        ctx.operation_id === undefined
        || !grant.scope.operation_ids?.includes(ctx.operation_id)
      ) {
        return false;
      }
      // Connection-bound when the op resolves one (http / connection / mcp): the
      // grant must EXPLICITLY name it — never a wildcard, so a grant minted for
      // connection A can't absorb a call to connection B (the same can't-be-
      // wildcard strictness the ingredient axis carries). `ai` / `entity` ops
      // carry no connection; the grant names none and this is a no-op for them.
      if (
        ctx.connection_name !== undefined
        && !grant.scope.connection_names?.includes(ctx.connection_name)
      ) {
        return false;
      }
      // Exact payload identity (recipe-less): the conservative v1 binds the
      // EXACT approved call — a different payload re-asks (the common arg-shape
      // clause above already pinned the key shape). The op-scoped widening
      // (absorb any args to this op) is a deliberate future change, not v1.
      return (
        nonEmptyString(grant.canonical_payload_hash)
        && grant.canonical_payload_hash === ctx.canonical_payload_hash
      );
    case 'batch':
      // P5a (N.10) — a batch row CANDIDATE-matches when an UNCONSUMED
      // member's payload hash equals the envelope's. Matching stays pure
      // (no claim here); the atomic claim-one-member + `uses_remaining`
      // decrement is the proceed-point consumption (`consumeSessionGrant`
      // with the envelope hash — claim + decrement in one synchronous
      // write), and a dispatch whose claim then loses the race falls back
      // to hold (N.4 step 4, fail closed). A consumed member never
      // matches again (codex HIGH fold — replay of a claimed member
      // re-asks); duplicate hashes are distinct members, so N approved
      // duplicates admit exactly N dispatches.
      //
      // SESSION-ONLY (N.13): a member set is one approval's enumeration,
      // inherently bound to the session that approved it — a `'batch'`
      // delegation row is malformed/hand-shaped and inert (the store's
      // consumption refuses it too, defense in depth).
      if (variant !== 'session') return false;
      return (
        grant.batch_members?.some(
          (m) =>
            (m.consumed_at === undefined || m.consumed_at === null)
            && nonEmptyString(m.canonical_payload_hash)
            && m.canonical_payload_hash === ctx.canonical_payload_hash,
        ) ?? false
      );
    case 'open':
      // P5b (N.11) — `pinned_projection_hash` equality plus the stored
      // `open_projection` well-formedness check (rule 6: "every
      // authority-bearing arg classified — else fail closed").
      //
      // The hash equality IS the provenance verification: the fire side
      // (`ctx.open_pinned_projection_hash`) is recomputed per dispatch by
      // the SAME walk that minted the grant — over the same recipe JSON
      // (`bound_recipe.recipe_hash` equality above pins the ref structure)
      // and the fire's live stores — and the canonical basis covers the
      // authority paths, skeletons, root refs, origin classes, AND every
      // pinned root's resolved value. So equality ⟺ every tainted root
      // resolves to exactly its approved value while clean roots
      // (trigger payload / connection fields) vary freely — rule 3. A
      // dispatch whose walk REFUSED carries no fire hash and never
      // matches (rule 2 fail-closed); a manifest edit that changes the
      // authority set, a re-classified root, or a drifted pinned value
      // all change the fire hash and re-ask.
      //
      // The stored-structure check guards the row itself: a hand-shaped /
      // future-vocabulary `open_projection` (unknown origin class, missing
      // pin, empty args) reads as not-well-formed and the grant is inert
      // (same JSON-row posture as every other fail-closed clause here).
      return (
        nonEmptyString(grant.pinned_projection_hash)
        && ctx.open_pinned_projection_hash !== undefined
        && grant.pinned_projection_hash === ctx.open_pinned_projection_hash
        && isWellFormedOpenProjection(grant.open_projection)
      );
    case 'scoped':
      // N.11 rule 5 (rev 10) — the utterance-derived session-scope overlay.
      // SESSION-ONLY (5.c/5.i.2): a scoped grant is "this afternoon in this
      // chat"; a `'scoped'` delegation row is malformed/hand-shaped → inert
      // (the N.13 learner never derives a key for it either).
      if (variant !== 'session') return false;
      // 5.b — entity+action resolve to a catalog (ingredient × operation):
      // the OPERATION axis is never a wildcard for scoped rows (the
      // ingredient axis is already explicit per the common clause above),
      // and the dispatch must carry the TRUSTED operation key.
      if (
        ctx.operation_id === undefined
        || !grant.scope.operation_ids?.includes(ctx.operation_id)
      ) {
        return false;
      }
      // 5.d — connection binding: explicitly named at mint (5.c — the card
      // names the connection; none enrolled ⇒ unmintable), never a wildcard.
      if (
        ctx.connection_name === undefined
        || !grant.scope.connection_names?.includes(ctx.connection_name)
      ) {
        return false;
      }
      // 5.d — structured-field equality over the time-bounded candidate
      // index. Shared verbatim with the consume arm (5.a: containment is
      // checked at match AND consume).
      return scopedContainmentAdmits(grant, ctx);
    default:
      // Unknown future vocabulary on a JSON row — fail closed (N.4).
      return false;
  }
};

/** The N.4 SESSION-grant match predicate: true iff `grant` is a live
 *  `grant_kind: 'session'` row admitting the dispatch described by `ctx` at
 *  `nowMs` — the {@link matchesGateGrant} common predicate with the
 *  `'session'` binding clause (`channel_session_id` equal, D6) and tier
 *  ceiling ({@link SESSION_GRANT_RISK_TIERS}), then per-mode
 *  (exact / batch / open). Pure; consumption is the caller's separate
 *  proceed-point write. */
export const matchesSessionGrant = (
  grant: ContractDefinition,
  ctx: SessionGrantMatchContext,
  nowMs: number,
): boolean => {
  // D-209 §1.7 — fail closed on `always` AND on malformed/missing runtime
  // provenance. This guard is session-specific: the standing delegation pass
  // below remains the deliberate sanctioned escape for an `always` ruling.
  if (ctx.pre_lift_approval !== 'never' && ctx.pre_lift_approval !== 'ask') {
    return false;
  }
  return matchesGateGrant(grant, ctx, nowMs, 'session');
};

/** D-177 N.13 (P6a) — the DELEGATION-RULE match predicate: true iff `grant`
 *  is a live `grant_kind: 'delegation'` row admitting the dispatch described
 *  by `ctx` at `nowMs`. The {@link matchesGateGrant} common predicate with
 *  the deltas the N.13 vocabulary pins (everything else — explicit
 *  ingredient, scope, `bound_recipe`, `arg_shape_hash`, `entity_scope`,
 *  pinned-tier equality, required bounds — is shared verbatim with the
 *  session predicate):
 *
 *  1. `grant_kind === 'delegation'` (each literal fails closed on the other).
 *  2. NO session binding — scope replaces it; a delegation row CARRYING
 *     `channel_session_id` is malformed → inert. `ctx.channel_session_id` is
 *     deliberately not compared: the rule admits the same bounded action
 *     across sessions (that is its purpose — ladder 6/7).
 *  3. Tier ceiling {@link DELEGATION_RULE_RISK_TIERS} (`write` only, v1 —
 *     ratified fork 2: `admin` delegation is a hand-mint, never suggested).
 *  4. Per-mode `'exact'` / `'open'` only — `'batch'` is session-only (a
 *     member set is one approval's enumeration).
 *
 *  Inert by construction until P6c mints delegation rows (the suggestion
 *  accept — N.9.7: background learning suggests, only the human mints). */
export const matchesDelegationRule = (
  grant: ContractDefinition,
  ctx: SessionGrantMatchContext,
  nowMs: number,
): boolean => matchesGateGrant(grant, ctx, nowMs, 'delegation');
