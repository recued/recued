import { packMailWorkEnvelopes } from './mail-work-egress-envelope.js';
/** D-167 P5 S4 — chat-mode PII egress: the bookend hooks + the wire-seam
 *  enactment.
 *
 *  S4 is the keystone payoff. The chat turn now runs THROUGH `runStream`
 *  (D-160 S2/S3), so the P1 gateway `piiEgress` substrate finally FIRES on
 *  real turns. Two always-on, position-pinned adapters bookend the three
 *  source adapters in `createChatStreamMiddlewares`:
 *
 *    · `pii-protect` — the FIRST `prompt` hook. DECIDE (N.9): gate on
 *      `owns_llm_egress` (D-163), get-or-create the session alias ledger,
 *      and write the `PiiEgressPlan` to `ctx.state`. It contributes NO
 *      prompt part — the per-call aliasing is enacted downstream at the
 *      wire seam.
 *    · `pii-restore` — the LAST `update` hook. The zero-failure total-restore
 *      backstop (the load-bearing D-167 invariant — aliasing may miss,
 *      restore may not): read the plan + ledger from `ctx.state` and restore
 *      any alias that survived in the assistant text. Idempotent — the wire
 *      seam already restored the returned body, so this is the final
 *      guarantee that no alias bleeds into the user-facing surface (spec
 *      §"Product stance" Hard invariant). Writes the verified-restored text +
 *      the finalized redaction summary to `ctx.state` for the shell.
 *
 *  ENACTMENT (N.9 "the executor/shell ENACT → read `state` + apply at the
 *  mechanical / I/O point"): the orchestrator's `TurnExecutor` closure reads
 *  the plan and WRAPS its `executeAiCall` with `wrapExecuteAiCallForPii`.
 *  Every outbound AI packet is aliased — including chat-tail history AND the
 *  tool-loop's accumulated `prior_tool_calls`, which carry fresh warehouse
 *  PII on every reinvoke (a single before-turn alias pass could never cover
 *  the reinvokes — only a per-AI-call wire seam can). Every returned body is
 *  restored (response + tool-call args + events) before `runChatTurn` sees
 *  it, so the tool loop dispatches real args, the warehouse-write boundary
 *  sees real values, and storage / streaming / display are all real. Only
 *  the cloud LLM ever sees aliases. `runChatTurn` stays 100% PII-unaware.
 *
 *  Both adapters are ALWAYS enabled + position-pinned — NOT gated on the
 *  D-160 registry's per-middleware enabled-state the way the three source
 *  adapters are: the comfort default is always-on (spec §P5 — "no UI opt-in
 *  needed"), and the restore guarantee must hold unconditionally.
 *
 *  Settings egress toggles (P5, D-174 R28): the cloud-egress routing decision
 *  (`cloud_egress_opt_out` / `local_llm_first` → local-only) is RE-DERIVED at
 *  the bound executor (`wire-chat-orchestrator.ts` `turnMustStayLocal`) from the
 *  LIVE config the call routes with — scanning every candidate provider that
 *  layer could route to (both BYOK slots, all free-pool API entries, plus any
 *  explicit pin) and masking to local-only when any carries an opt-out row. This
 *  hook NO LONGER computes that posture or the retired `require_local` flag; it
 *  is aliasing-only. Co-locating the decision with the route (vs the prior
 *  precomputed flag) removes the config-change TOCTOU window. The
 *  `local_llm_first` two-stage local-extract-then-cloud flow is still a deferred
 *  follow-on, so "local-first" stays enforced as the strictly-safer local-only.
 *
 *  The `FieldPrivacyResolver` is wired in production (D-167 activation
 *  `93fa73ba`): `createMetaFieldPrivacyResolverFromLocalManifestStore` reads
 *  `MetaField.privacy` off installed local-manifest entity schemas, replacing
 *  `noopFieldPrivacyResolver`. It returns `[]` (every packet round-trips
 *  byte-identical) for any scope with no privacy-tagged fields installed, so
 *  the no-op invariant holds until a D-170-authored schema tags fields; the
 *  middleware still falls back to the noop resolver only when none is injected.
 *
 *  Spec: D-167 §"Runtime flow", §"Policy modes", §P5; D-160 §N.9.
 */

import type { SurfaceTag } from '@recued/chat';
import { piiEgress } from '@recued/gateway';
import type { EntityPromptPart, Middleware, TurnContext, TurnResult } from '@recued/middleware';
import {
  PII_ENTITY_MARKER_KEY,
  type ChatModelRoutingLayer,
  type LedgerKind,
  type PiiAliasableData,
  type PiiFieldTag,
  type RedactionSummary,
  PII_ALIAS_NOTICE,
} from '@recued/contracts';

import type {
  ChatAiCallResult,
  ExecuteChatAiCall,
} from './chat-orchestrator.js';
import { RECALL_WITHHELD_MESSAGE, type RecallResolver } from './chat-recall-index.js';
import { projectToolDispatchCandidates } from './chat-pii-source.js';
import type { CandidateContributor } from './chat-pii-candidate-contributor.js';
import type { RecallJoinRef } from './chat-recall-search-tool.js';
import { normalizeExecutionCaseText } from './execution-case-core.js';
import type { RetainedAliasCandidate } from './storage/chat-store.js';

/** The session alias-ledger handle — inferred off the gateway store so the
 *  backend stays on the `piiEgress` consumer surface (no direct
 *  `@recued/transforms` dependency edge). */
type SessionLedger = ReturnType<piiEgress.SessionLedgerStore['getOrCreate']>;

export const PII_PROTECT_MIDDLEWARE_ID = 'pii-protect';
export const PII_RESTORE_MIDDLEWARE_ID = 'pii-restore';

/** `ctx.state` key — the `PiiEgressPlan` `pii-protect` writes in the
 *  before-turn phase. The orchestrator's TurnExecutor closure reads it to
 *  wrap `executeAiCall`; `pii-restore` reads it in the after-turn phase; the
 *  shell reads its finalized summary on finalize. */
export const CHAT_PII_EGRESS_PLAN_STATE_KEY = 'chat:pii_egress_plan';

/** `ctx.state` key — the verified-restored assistant text `pii-restore`
 *  writes. The shell prefers it for the persisted + broadcast message (so the
 *  zero-failure-restore guarantee is enacted on the durable surface), falling
 *  back to the turn's own assistant content when absent (PII unwired). */
export const CHAT_PII_RESTORED_TEXT_STATE_KEY = 'chat:pii_restored_text';

/** The per-turn egress plan `pii-protect` DECIDES and writes to `ctx.state`.
 *  The wire seam (`wrapExecuteAiCallForPii`) + `pii-restore` read it. */
export interface PiiEgressPlan {
  /** `shouldAliasForEgress` result — false on external-egress surfaces
   *  (a messenger an external app renders); the wrapper is then a faithful
   *  pass-through and `pii-restore` no-ops. */
  readonly active: boolean;
  /** The session-scoped alias ledger — reused across packets AND tool-loop
   *  rounds so the same real value renders as the same alias every time
   *  (spec §"Ledger persistence across packets"). */
  readonly ledger: SessionLedger;
  /** D-167 — awaited ONCE inside the per-ledger request lease, before staging.
   *  Nullary so the plan carries no session/store knowledge. Absent → unseeded
   *  (today's behaviour). */
  readonly seedSlotOrdering?: () => Promise<void>;
  /** Resolves which packet fields carry a `MetaField.privacy` tag — the
   *  `noopFieldPrivacyResolver` default until D-165 supplies a real one. */
  readonly resolver: piiEgress.FieldPrivacyResolver;
  /** Mutable per-turn redaction-summary accumulator — the wire seam merges
   *  each egress packet's counts in; the shell stamps `value` on the audit
   *  row. Held behind a 1-field box so the by-reference plan in `state` keeps
   *  accumulating across the tool loop's rounds. */
  readonly summary: { value: RedactionSummary };
  /** D-167 P3 — reverse authority from the most recent successfully sent
   * provider request. The update-hook backstop must never use the wider
   * session ledger for restore. */
  readonly restoreAuthority?: {
    value?: piiEgress.RequestRestoreAuthority;
  };
  /** Exact response text already restored by the most recent successful wire
   * call. The final update hook uses this provenance to avoid a second restore
   * pass over an escaped alias literal. */
  readonly restoredAssistantText?: {
    value?: string;
    /** EVERY response restored at the wire seam this turn. ⛔ The latest call
     * is not always the answer: the turn-end brief runs after it (no
     * `response`), and matching `value` alone sent the answer the owner had
     * already seen through a second restore — saved text ≠ shown text. */
    responses?: Set<string>;
  };
  /** Flat schema-attested values from tool feedback in this staged request.
   * They are published to the assistant source only after send success. */
  readonly retainedCandidates?: {
    value: readonly RetainedAliasCandidate[];
  };
  /** D-213 §3.8 — the recalling session's own source read, plus the SCOPED JOIN
   * of each piece recall returned. It has no store-discovery API of its own:
   * X1 hands it the returned pieces, never a session id it could widen. */
  readonly candidateReharvest?: {
    readonly contributor: CandidateContributor;
    readonly getJoinedPieces: () => readonly RecallJoinRef[];
    readonly hasRegisteredRecall: () => boolean;
  };
  /** D-167 (recall path) — per-turn memoized contact recall RESOLVER provider. The
   *  egress aliases a `memory.*` result against the resolver's whole-warehouse
   *  name/org automaton + text-resolved identifiers so a contact recalled from a
   *  PRIOR session (absent from the session ledger) is still aliased — closing the
   *  cross-session memory-recall leak. `getIndex` builds LAZILY (only when a
   *  `recall_context` field is present) and at most ONCE per turn (the plan object is
   *  reused across the tool loop), so the whole-warehouse A-C build is paid at most
   *  once per recalling turn. Absent when no recall builder is wired — recall aliasing
   *  is then off and the ledger-only scan still runs (behaviour-preserving). */
  readonly recall?: { getIndex: () => RecallResolver | undefined };
}

/** A fresh empty redaction summary (comfort `'alias'` mode, session scope). */
const emptyRedactionSummary = (): RedactionSummary => ({
  mode: 'alias',
  scope_kind: 'session',
  counts: {},
});

/** The closed list of `RedactionSummary.counts` keys — summed when merging a
 *  round's summary into the per-turn accumulator. */
const REDACTION_COUNT_KEYS = [
  'email',
  'name',
  'org',
  'phone',
  'address',
  'url',
  'external_id',
  'account_id',
  'content_text_replacements',
] as const;

const CHAT_USER_MESSAGE_PATH = 'user_message';

const isFreeTextChatUserMessage = (value: string): boolean =>
  /\s/.test(value.trim());

/** Chat `user_message` is user-authored prose, not a schema field. A future
 *  resolver may still conservatively tag it as an identifier, but a prose
 *  value like "contact alice@acme.com" must run through the ledger-anchored
 *  content pass rather than being allocated as one malformed email value.
 *  The exact single-token identifier case stays whole-value tagged so the
 *  existing explicit resolver tests keep their narrow mechanics coverage. */
const normalizeChatUserMessagePiiFields = (
  packet: PiiAliasableData,
  fields: readonly PiiFieldTag[],
  /** D-167 N.10.2 ② — force a `user_message` content tag even when the resolver
   *  tagged no structural field this packet, so a name the user typed is scanned
   *  against a ledger seeded elsewhere this turn (the prefetch entity-part
   *  gather). The caller passes `true` only when the ledger already holds
   *  aliases, so the byte-identical empty-ledger path is preserved. */
  forceContentScan: boolean,
): readonly PiiFieldTag[] => {
  const userMessage = (packet as Record<string, unknown>)[CHAT_USER_MESSAGE_PATH];
  if (typeof userMessage !== 'string' || userMessage.length === 0) return fields;
  if (fields.length === 0 && !forceContentScan) return fields;

  let hasUserMessageContentField = false;
  const normalized: PiiFieldTag[] = [];
  for (const field of fields) {
    if (field.path !== CHAT_USER_MESSAGE_PATH) {
      normalized.push(field);
      continue;
    }
    if (field.kind === 'content') {
      if (!hasUserMessageContentField) {
        normalized.push(field);
        hasUserMessageContentField = true;
      }
      continue;
    }
    if (!isFreeTextChatUserMessage(userMessage)) {
      normalized.push(field);
    }
  }

  if (!hasUserMessageContentField) {
    normalized.push({ path: CHAT_USER_MESSAGE_PATH, kind: 'content' });
  }

  return normalized;
};

/** D-167 N.10.2 ② — content-field tags for each `chat_tail` message so the
 *  ledger-anchored content pass aliases any already-known entity a prior
 *  message names, consistent with the rest of the turn. Only the string
 *  `content` of each `{ role, content }` tail entry is scanned (the role is not
 *  PII). The caller includes these only when the content pass is active (the
 *  ledger holds aliases or the resolver tagged a structural field) — an empty
 *  ledger keeps the byte-identical early path. */
const chatTailContentFieldTags = (packet: PiiAliasableData): PiiFieldTag[] => {
  const tail = (packet as Record<string, unknown>)['chat_tail'];
  if (!Array.isArray(tail)) return [];
  const tags: PiiFieldTag[] = [];
  tail.forEach((message, index) => {
    if (
      message !== null
      && typeof message === 'object'
      && typeof (message as Record<string, unknown>)['content'] === 'string'
    ) {
      tags.push({ path: `chat_tail.${index}.content`, kind: 'content' });
    }
  });
  return tags;
};

/** Merge one egress packet's redaction summary into the turn accumulator.
 *  Sums per-kind counts. A value re-sent across the tool loop's reinvokes is
 *  counted per egress packet (each reinvoke is a distinct cloud egress) —
 *  observability semantics, not a unique-alias count. */
const mergeRedactionSummary = (
  acc: RedactionSummary,
  next: RedactionSummary,
): RedactionSummary => {
  const counts: RedactionSummary['counts'] = { ...acc.counts };
  for (const key of REDACTION_COUNT_KEYS) {
    const add = next.counts[key];
    if (add) counts[key] = (counts[key] ?? 0) + add;
  }
  return { mode: acc.mode, scope_kind: acc.scope_kind, counts };
};

/** Read the `PiiEgressPlan` off `ctx.state`. Returns `undefined` when PII is
 *  unwired (no `pii-protect` hook ran) or the key holds a malformed value —
 *  either way the reader (wrap seam / `pii-restore` / shell) falls back to the
 *  PII-unaware path (behavior-preserving). */
export const readPiiEgressPlan = (
  state: TurnContext['state'],
): PiiEgressPlan | undefined => {
  const raw = state.get(CHAT_PII_EGRESS_PLAN_STATE_KEY);
  if (raw === null || typeof raw !== 'object') return undefined;
  const plan = raw as Partial<PiiEgressPlan>;
  // Validate the nested shapes the downstream enactment derefs
  // (`ledger.byKindBaseAlias.size`, `summary.value.counts`, the resolver),
  // not just the top-level keys — a half-shaped plan must fail open to the
  // PII-unaware path, never throw mid-turn.
  const ledger = plan.ledger as { byKindBaseAlias?: unknown } | undefined;
  const summary = plan.summary as { value?: unknown } | undefined;
  if (
    typeof plan.active !== 'boolean'
    || typeof plan.resolver !== 'function'
    || ledger === null
    || typeof ledger !== 'object'
    || !(ledger.byKindBaseAlias instanceof Map)
    || summary === null
    || typeof summary !== 'object'
    || summary.value === null
    || typeof summary.value !== 'object'
  ) {
    return undefined;
  }
  return raw as PiiEgressPlan;
};

/** The source bindings the PII bookend hooks need. Every field is optional so
 *  a harness without a PII substrate composes the two adapters as faithful
 *  no-ops (the gate falls open to comfort; the noop resolver tags nothing). */
export interface PiiEgressHookDeps {
  /** The per-orchestrator session alias-ledger store (one per chat
   *  substrate). Absent → the bookends are not built (see
   *  `createChatStreamMiddlewares`). */
  readonly ledgerStore: piiEgress.SessionLedgerStore;
  /** Resolves privacy-tagged fields. Defaults to `noopFieldPrivacyResolver`
   *  (inert until D-165's runtime `MetaField.privacy` source lands). */
  readonly resolver?: piiEgress.FieldPrivacyResolver;
  /** Whether Recued owns the LLM↔user boundary on this surface (D-163
   *  `owns_llm_egress`). Defaults to `surface === 'chat'` — the chat
   *  orchestrator owns egress; a messenger surface an external app renders
   *  does not. */
  readonly ownsLlmEgress?: (surface: SurfaceTag) => boolean;
  /** D-167 (recall path) — builds the contact recall RESOLVER (the whole-warehouse
   *  name/org automaton + a text-driven identifier resolver) the egress aliases a
   *  `memory.*` result against. Called lazily by the per-turn plan (only when a
   *  `recall_context` field is present), so the whole-warehouse A-C build is paid at
   *  most once per recalling turn. Absent → recall aliasing off (the ledger-only scan
   *  still runs); returns undefined for an empty / unwired warehouse. */
  readonly getContactKnownValueIndex?: () => RecallResolver | undefined;
  readonly createCandidateContributor?: (
    session_id: string,
  ) => CandidateContributor;
  readonly getRecallJoinedPieces?: (
    state: TurnContext['state'],
  ) => readonly RecallJoinRef[];
  readonly hasRegisteredRecall?: (
    state: TurnContext['state'],
  ) => boolean;
  /** D-167 — fix this session's alias slot ordering from its durable rows before
   *  the turn allocates anything, so a restart cannot renumber `pii.Person1`
   *  onto a different person (`chat-pii-slot-ordering.ts`). Absent → today's
   *  allocation-order numbering. */
  readonly seedAliasSlotOrdering?: (
    ledger: SessionLedger,
    session_id: string,
  ) => Promise<void>;
}

const defaultOwnsLlmEgress = (surface: SurfaceTag): boolean =>
  surface === 'chat';

/** D-167 (recall path) — wrap the raw contact-index builder in a per-turn memo.
 *  The PII egress plan is built ONCE per turn (by `pii-protect`) and reused
 *  across the tool loop's reinvokes, so memoizing here builds the index at most
 *  once per turn — and lazily, since `aliasChatAiInput` only calls `getIndex`
 *  when a `memory.*` result is actually present. `undefined` (no builder wired)
 *  leaves the plan's `recall` absent → recall aliasing off. The build result
 *  (including `undefined` for an empty warehouse) is cached so a turn with a
 *  memory result over an empty warehouse doesn't re-scan on every reinvoke. */
const buildRecallProvider = (
  getContactKnownValueIndex?: () => RecallResolver | undefined,
): PiiEgressPlan['recall'] | undefined => {
  if (getContactKnownValueIndex === undefined) return undefined;
  let cache: RecallResolver | undefined | 'unbuilt' = 'unbuilt';
  return {
    getIndex: (): RecallResolver | undefined => {
      if (cache === 'unbuilt') cache = getContactKnownValueIndex();
      return cache;
    },
  };
};

/** Build the same per-turn PII egress plan without requiring a framework
 * `TurnContext`. Stateless surface adapters (currently `llm_gateway`) use this
 * to share chat's wire-level alias/restore bookend while keeping owner-history
 * and owner-private middleware out of their turn. */
export const createPiiEgressPlanForSession = (
  deps: PiiEgressHookDeps,
  sessionId: string,
  surface: SurfaceTag = 'chat',
  state?: TurnContext['state'],
): PiiEgressPlan => {
  const resolver = deps.resolver ?? piiEgress.noopFieldPrivacyResolver;
  const ownsLlmEgress = (deps.ownsLlmEgress ?? defaultOwnsLlmEgress)(surface);
  const ledger = deps.ledgerStore.getOrCreate(sessionId);
  let slotOrderingAttempted = false;
  const recall = buildRecallProvider(deps.getContactKnownValueIndex);
  const candidateReharvest =
    state !== undefined
    && deps.createCandidateContributor !== undefined
    && deps.getRecallJoinedPieces !== undefined
    && deps.hasRegisteredRecall !== undefined
      ? {
          contributor: deps.createCandidateContributor(sessionId),
          getJoinedPieces: () => deps.getRecallJoinedPieces!(state),
          hasRegisteredRecall: () => deps.hasRegisteredRecall!(state),
        }
      : undefined;
  return {
    active: piiEgress.shouldAliasForEgress({
      owns_llm_egress: ownsLlmEgress,
    }),
    ledger: ledger,
    ...(deps.seedAliasSlotOrdering !== undefined
      ? {
          seedSlotOrdering: async (): Promise<void> => {
            // At most once per TURN even when the harvest fails (the plan is
            // per-turn); at most once per SESSION on the happy path, because a
            // seeded ledger keeps its reservation entries as the marker.
            if (slotOrderingAttempted) return;
            slotOrderingAttempted = true;
            await deps.seedAliasSlotOrdering!(ledger, sessionId);
          },
        }
      : {}),
    resolver,
    summary: { value: emptyRedactionSummary() },
    restoreAuthority: {},
    restoredAssistantText: {},
    retainedCandidates: { value: [] },
    ...(recall ? { recall } : {}),
    ...(candidateReharvest ? { candidateReharvest } : {}),
  };
};

/** The `pii-protect` source-binding adapter — the FIRST `prompt` hook.
 *  DECIDE the egress plan and write it to `ctx.state`; contributes no prompt
 *  part (the aliasing is enacted at the wire seam). */
export const createPiiProtectMiddleware = (
  deps: PiiEgressHookDeps,
): Middleware => ({
  id: PII_PROTECT_MIDDLEWARE_ID,
  prompt(ctx: TurnContext): void {
    ctx.state.set(
      CHAT_PII_EGRESS_PLAN_STATE_KEY,
      createPiiEgressPlanForSession(
        deps,
        ctx.session_id,
        ctx.surface,
        ctx.state,
      ),
    );
  },
});

/** The `pii-restore` source-binding adapter — the LAST `update` hook. It
 * stashes the exact response already verified/restored at the wire seam. If an
 * unverified output reaches this point, it applies one request-authorized
 * restore pass as the final backstop. */
export const createPiiRestoreMiddleware = (): Middleware => ({
  id: PII_RESTORE_MIDDLEWARE_ID,
  update(ctx: TurnResult): void {
    const plan = readPiiEgressPlan(ctx.state);
    if (plan === undefined || !plan.active) return;
    // A restore is not generally idempotent: an escaped Person2 may restore to
    // the user's literal "pii.Person1", and a second pass would turn that into
    // Person1's real mapping. Exact response provenance distinguishes the
    // already-restored wire result from an unverified output that still needs
    // the backstop.
    const authority = plan.restoreAuthority?.value;
    const verified = plan.restoredAssistantText;
    const alreadyRestored =
      (verified?.value !== undefined && verified.value === ctx.output.text)
      || verified?.responses?.has(ctx.output.text) === true;
    const restored =
      alreadyRestored
        ? ctx.output.text
        : authority === undefined
          ? ctx.output.text
          : piiEgress.restoreForDisplayWithAuthority(
              authority,
              ctx.output.text,
            );
    ctx.state.set(CHAT_PII_RESTORED_TEXT_STATE_KEY, restored);
  },
});

/** Read the verified-restored assistant text `pii-restore` stashed, or
 *  `undefined` when PII was unwired / inactive (the shell then uses the
 *  turn's own assistant content). */
export const readPiiRestoredText = (
  state: TurnContext['state'],
): string | undefined => {
  const raw = state.get(CHAT_PII_RESTORED_TEXT_STATE_KEY);
  return typeof raw === 'string' ? raw : undefined;
};

/** The finalized per-turn redaction summary, or `undefined` when PII was
 *  unwired / nothing was redacted. The shell stamps it on the assistant audit
 *  row. */
export const readPiiRedactionSummary = (
  plan: PiiEgressPlan | undefined,
): RedactionSummary | undefined => {
  if (plan === undefined) return undefined;
  const summary = plan.summary.value;
  // Total against a malformed summary (a foreign write to the state key):
  // never deref `counts` without confirming it is an object.
  if (summary === null || typeof summary !== 'object') return undefined;
  const counts = (summary as { counts?: unknown }).counts;
  if (counts === null || typeof counts !== 'object') return undefined;
  const countMap = counts as Record<string, number | undefined>;
  // Omit an all-zero summary so the audit row stays clean on the common
  // (comfort / noop-resolver) path — only a turn that actually redacted
  // something carries the field.
  const redacted = REDACTION_COUNT_KEYS.some((key) => (countMap[key] ?? 0) > 0);
  return redacted ? (summary as RedactionSummary) : undefined;
};

/** D-167 E.1 — the hard egress invariant: strip EVERY inline `__entity` marker
 *  from a packet so NONE ever reaches the model. `aliasPacketForEgress` aliases
 *  tagged fields but returns the clone with all OTHER keys intact
 *  (`egress-aliasing.ts`), so the marker survives the alias pass; this is the
 *  one canonical removal, pinned at the model-bound seam.
 *
 *  Iterative (explicit stack), NOT recursive with a depth bound: a depth cap
 *  would be an escape hatch — a marker stamped deeper than the cap would survive
 *  to the model (codex review P2). The traversal therefore has no depth limit
 *  and removes a marker at ANY nesting depth — fail-closed. The packet is a
 *  parsed / deep-cloned JSON tree (no cycles), so the stack terminates without a
 *  visited-set. Mutates in place (callers own a fresh clone / a `JSON.parse`
 *  result) and returns whether any marker was removed — so the no-alias path can
 *  skip a needless re-serialize when nothing changed (byte-identity). */
const stripEntityMarkers = (root: unknown): boolean => {
  if (root === null || typeof root !== 'object') return false;
  let stripped = false;
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const element of node) {
        if (element !== null && typeof element === 'object') stack.push(element);
      }
      continue;
    }
    const record = node as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key === PII_ENTITY_MARKER_KEY) {
        delete record[key];
        stripped = true;
        continue;
      }
      const value = record[key];
      if (value !== null && typeof value === 'object') stack.push(value);
    }
  }
  return stripped;
};

/** D-167 N.10.2 — alias an entity PromptPart's payload at the egress GATHER.
 *  A producer (the prompt-cache prefetch) surfaces raw warehouse records as a
 *  STRUCTURED `entity` part rather than pre-rendered text — a rendered line
 *  carries no entity label the resolver could see. This stamps each record with
 *  the part's `__entity` marker, runs the egress alias pass over them against
 *  the turn's SHARED session ledger (so the same record renders to the same
 *  alias every tool result / the user-message content pass already use), merges
 *  the redaction counts, and returns the aliased records for the part's
 *  `render`. Marker-stamping lives HERE — not in the generic producer — so the
 *  prompt-cache package stays free of the privacy-substrate constant
 *  (D-160 N.10.2 ①).
 *
 *  The returned records still carry the `__entity` marker, but `render` reads
 *  them by field name and drops it, so only aliased text — never the marker key
 *  — reaches the model. An inactive plan (external-egress surface) or empty
 *  payload returns the input unchanged, so the caller renders the raw payload
 *  (behaviour-preserving). */
/** D-224 — attach {@link PII_ALIAS_NOTICE} when this packet actually carries an
 *  alias. Returns whether the packet changed, so the caller re-serializes.
 *
 *  ⚠ A separate top-level field, NOT prose folded into an existing block: the
 *  aliases it explains appear in `prefetch_context`, in tool results and in the
 *  user's own message, so it belongs to none of them. A named field is also what
 *  lets an egress-history replay show the owner exactly what the model was told.
 */
const injectPiiAliasNotice = (
  packet: unknown,
  plan: PiiEgressPlan,
): boolean => {
  if (!plan.active || plan.ledger.byKindRealValue.size === 0) return false;
  if (packet === null || typeof packet !== 'object' || Array.isArray(packet)) {
    return false;
  }
  const target = packet as Record<string, unknown>;
  if (target['pii_notice'] === PII_ALIAS_NOTICE) return false;  // idempotent
  target['pii_notice'] = PII_ALIAS_NOTICE;
  return true;
};

export const aliasEntityPayloadForEgress = (
  payload: readonly Record<string, unknown>[],
  entity: string,
  plan: PiiEgressPlan,
  /** D-224 — raw USER-authored strings this turn, for overlap-reveal. Optional
   *  with an empty default so every existing caller stays byte-identical: with
   *  no disclosures there is no overlap and the decoration is a no-op. */
  disclosedTexts: readonly string[] = [],
): readonly Record<string, unknown>[] => {
  if (!plan.active || payload.length === 0) return payload;
  const marked = payload.map((record) => ({
    ...record,
    [PII_ENTITY_MARKER_KEY]: entity,
  }));
  const { aliased, summary } = piiEgress.aliasPacketForEgress({
    ledger: plan.ledger,
    packet: marked as PiiAliasableData,
    resolver: plan.resolver,
    mode: 'alias',
  });
  plan.summary.value = mergeRedactionSummary(plan.summary.value, summary);
  if (!Array.isArray(aliased)) return payload;
  // ⛔⛔ THE PREFETCH BLOCK IS NOT OVERLAP-DECORATED. D-224 wired it and that was
  // WRONG, for a reason its own justification hid: overlap-reveal argues it
  // "leaks nothing new — the user typed it", and that holds only while the
  // user's text is still RAW in the packet. On this path it is NOT — the content
  // pass aliases `user_message` too, so "Sarah Chen" is already `pii.Person1`
  // by the time this renders, and a `pii.Person1.sarah.chen` tail was the ONLY
  // place the name appeared. Verified in a live packet: raw name absent, tail
  // present, and the model read the name off the tail and printed it.
  //
  // ⚠ The join the tail was meant to restore does NOT need it here: the
  // `user_message` and this block both carry the SAME `pii.Person1` token, so
  // the coreference is already intact. The recall path keeps decoration — there
  // the recalled value is aliased against text the user really did send raw,
  // which is the case D-167 was written for.
  //
  // `disclosedTexts` stays on the signature: the recall path needs it, and a
  // future caller that CAN honour the raw-text premise should not have to
  // re-thread it.
  void disclosedTexts;
  return aliased as readonly Record<string, unknown>[];
};

/** D-167 N.10.2 — gather the SPECULATIVE prompt-cache prefetch's `entity` parts
 *  into rendered prompt blocks, each aliased against the plan's shared session
 *  ledger (`aliasEntityPayloadForEgress`). The records are warehouse data the
 *  user did NOT explicitly request, so their ONLY egress safety is that alias
 *  pass — they are therefore contributed ONLY when aliasing is both ACTIVE AND
 *  EFFECTIVE:
 *    · INACTIVE plan — external-egress (e.g. a `messenger-*` surface where D-163
 *      `owns_llm_egress` makes `shouldAliasForEgress` false) or no plan (PII
 *      unwired): the alias no-ops, so the speculative pull is dropped.
 *    · NOOP resolver — a plan wired with the default `noopFieldPrivacyResolver`
 *      (no canonical privacy tags injected — a partial composition) passes
 *      `active` yet `aliasEntityPayloadForEgress` returns the records UNCHANGED,
 *      so rendering would leak raw names/emails. Require a REAL resolver.
 *  Dropped, the pre-wiring behaviour holds (no prefetch off the aliased chat
 *  path); explicit tool-call results still flow under the surface's own egress
 *  rule. The caller pre-filters `parts` to the prompt-cache source. */
export const renderEntityPartsForEgress = (
  parts: readonly EntityPromptPart[],
  plan: PiiEgressPlan | undefined,
  /** D-224 — threaded to overlap-reveal the prefetch block. MUST be the RAW
   *  owner-authored text, captured before any alias pass rewrites the packet. */
  disclosedTexts: readonly string[] = [],
): readonly string[] => {
  if (plan?.active !== true || plan.resolver === piiEgress.noopFieldPrivacyResolver) {
    return [];
  }
  return parts
    .map((part) => part.render(
      aliasEntityPayloadForEgress(part.payload, part.entity, plan, disclosedTexts),
    ))
    .filter((block) => block.length > 0);
};

/** D-167 (recall path) — the resolved per-call recall context: the per-turn recall
 *  RESOLVER (whole-warehouse name/org automaton + text-driven identifier resolver) +
 *  the raw USER-disclosed texts this turn (for overlap-reveal). Resolved ONCE per
 *  `aliasChatAiInput` call, only when a `recall_context` field is present. */
interface RecallScanContext {
  readonly resolver: RecallResolver;
  /** Raw USER-authored strings this turn (`user_message` + user-role `chat_tail`)
   *  — the gateway tokenizes them for the overlap suffix. ASSISTANT text is
   *  excluded: it is aliased on egress (the model generated it from aliases), so
   *  treating it as "disclosed" would over-reveal a fragment the user never typed. */
  readonly disclosedTexts: readonly string[];
}

/** True iff the packet carries a non-empty typed `recall_context` field — the
 *  memory RECALL results the composer routed out of `prior_tool_calls`
 *  (`partitionPriorToolCalls`). Cheap (no index build) — gates the lazy index
 *  build so a non-recall turn never pays the whole-warehouse scan. The egress no
 *  longer sniffs tool names: recall-ness is decided once, at compose time. */
/** True iff the packet carries tool RESULTS — the `prior_tool_calls` the composer
 *  threaded back after a dispatch round. Cheap (no index build), and it gates the
 *  lazy whole-warehouse build exactly as `hasRecallContext` does: a FIRST round
 *  has no tool results, so it still pays nothing. */
const hasPriorToolCalls = (packet: unknown): boolean => {
  if (packet === null || typeof packet !== 'object') return false;
  const entries = (packet as Record<string, unknown>).prior_tool_calls;
  return Array.isArray(entries) && entries.length > 0;
};

const hasRecallContext = (packet: unknown): boolean => {
  if (packet === null || typeof packet !== 'object') return false;
  const entries = (packet as Record<string, unknown>).recall_context;
  return Array.isArray(entries) && entries.length > 0;
};

export class ChatPiiPrivacyError extends Error {
  readonly code = 'chat_pii_privacy_failed';
  readonly retryable = false;

  constructor(detail: string) {
    super(`chat privacy protection failed: ${detail}`);
    this.name = 'ChatPiiPrivacyError';
  }
}

const REHARVEST_STATIC_FIELDS: ReadonlySet<string> = new Set([
  // The byte-stable prompt-cache head. Candidate protection is deliberately
  // confined to the per-turn suffix so the reusable catalog prefix cannot
  // drift based on recalled history.
  'available_tools',
  'commitment_context',
  // A control value, not owner/provider prose. Excluding it also prevents an
  // identifier-shaped date from colliding with a retained external id.
  'current_date',
]);

const aliasReharvestCandidatesInPlace = (
  packet: Record<string, unknown>,
  plan: PiiEgressPlan,
  candidates: readonly piiEgress.CandidateValueSeed[],
  disclosedTexts: readonly string[],
): boolean => {
  if (candidates.length === 0) return false;
  const dynamic: Array<readonly [string, unknown]> = [];
  for (const [key, value] of Object.entries(packet)) {
    if (!REHARVEST_STATIC_FIELDS.has(key)) dynamic.push([key, value]);
  }
  const values = dynamic.map(([, value]) => value);
  const original = JSON.stringify(values);
  const { aliased, summary } = piiEgress.aliasCandidateValuesForEgress(
    plan.ledger,
    values,
    candidates,
    disclosedTexts,
  );
  const changed = JSON.stringify(aliased) !== original;
  if (!changed) return false;
  // The array root above deliberately keeps protocol field names stable while
  // the candidate pass remains key-aware inside each dynamic data value. No
  // field may disappear merely because its value came back `undefined` —
  // `JSON.stringify` drops such a key from the wire even though the object
  // still has it.
  //
  // ⛔ CHECK BEFORE THE WRITE-BACK. The earlier version asserted
  // `Object.hasOwn` AFTER assigning, and an assignment always establishes an
  // own property — including for `undefined` — so the guard could never fire
  // while the loss it names sailed through re-serialization. Measured:
  // `hasOwnProperty('correction_context')` true, `JSON.stringify` → the key
  // gone. Assert on the VALUE, and assert it before mutating anything.
  if (aliased.length !== dynamic.length) {
    throw new ChatPiiPrivacyError('candidate pass lost a dynamic field');
  }
  dynamic.forEach(([key, original], index) => {
    if (aliased[index] === undefined && original !== undefined) {
      throw new ChatPiiPrivacyError(
        `candidate pass lost the dynamic field ${key}`,
      );
    }
  });
  dynamic.forEach(([key], index) => {
    packet[key] = aliased[index];
  });
  plan.summary.value = mergeRedactionSummary(plan.summary.value, summary);
  return true;
};

/** Collect the raw USER-authored disclosure texts from the packet — the current
 *  `user_message` + each user-role `chat_tail` entry. Assistant entries are
 *  excluded (see `RecallScanContext.disclosedTexts`). */
const disclosedTextsFromPacket = (packet: unknown): string[] => {
  if (packet === null || typeof packet !== 'object') return [];
  const record = packet as Record<string, unknown>;
  const out: string[] = [];
  if (typeof record.user_message === 'string') out.push(record.user_message);
  const tail = record.chat_tail;
  if (Array.isArray(tail)) {
    for (const message of tail) {
      if (
        message !== null
        && typeof message === 'object'
        && (message as Record<string, unknown>).role === 'user'
        && typeof (message as Record<string, unknown>).content === 'string'
      ) {
        out.push((message as Record<string, unknown>).content as string);
      }
    }
  }
  return out;
};

/** Resolve the recall context for a packet, or undefined when recall aliasing
 *  doesn't apply: no recall provider wired, no `recall_context` field this packet,
 *  or an empty / unwired warehouse (the index builds to undefined). Builds the
 *  index LAZILY — only after `hasRecallContext` confirms there is recall content to
 *  protect — so a non-recall turn keeps the byte-identity fast path. */
const resolveRecallScanContext = (
  packet: unknown,
  plan: PiiEgressPlan,
  disclosedTexts: readonly string[] = disclosedTextsFromPacket(packet),
): RecallScanContext | undefined => {
  if (typeof plan.recall?.getIndex !== 'function') return undefined;
  // ⛔⛔ NOT `hasRecallContext` ALONE — that scoped the WHOLE-WAREHOUSE resolver to
  // `memory.*` recall, so aliasing engaged only when the turn NAMED a contact or
  // READ one via `contact.search`. Warehouse membership alone did not alias, and a
  // `mail.search` result carrying a known contact's name / org / street / email /
  // phone / domain reached the model RAW whenever nothing in that turn surfaced
  // them. Measured: bench 183 aliased the same registered contact in 67 packets
  // and sent it raw in 63 — of the SAME run, the raw ones preceding its first
  // `contact.search`.
  // ⚠ A FIRST ROUND STILL PAYS NOTHING: no tool results, no recall context, no
  //   index build, byte-identity fast path intact.
  if (!hasRecallContext(packet) && !hasPriorToolCalls(packet)) return undefined;
  const resolver = plan.recall.getIndex();
  if (resolver === undefined) return undefined;
  return { resolver, disclosedTexts };
};

/** The `prior_tool_calls[]` entry subfields the uniform content pass substring-scans
 *  — the PII-bearing DATA fields fed back to the model on reinvoke. The control
 *  fields (`tool_name` / `reason` / `status` / `tier` / timestamps) are NOT
 *  scanned: closed-list slugs / `ChatDispatchReason` enums / numbers, never PII. */
const PRIOR_TOOL_CALL_DATA_FIELDS = ['args', 'result', 'detail'] as const;

/** D-167 N.10 (uniform boundary) — alias ONE container field's value against the
 *  session ledger in place. Ledger-anchored: a value never aliased this session
 *  rides through (the untagged-result / brand-new-value residual). Rebinds whenever
 *  the sanitized + aliased copy DIFFERS from the original — a replaced PII value OR
 *  a dropped prototype-unsafe key. The value walk strips `__proto__` / `constructor`
 *  / `prototype` (prototype-pollution defence) but that drop produces NO redaction
 *  count, so a count-based predicate would skip the rebind and forward the raw value
 *  still on the un-cloned early-path packet (e.g. `{"constructor":"alice@acme.com"}`
 *  — codex adversarial-review). A structural compare catches both; an unchanged
 *  value serializes identically, so the early path's `return input` byte-identity
 *  fast-path is preserved. Merges the summary; returns whether it changed. */
const aliasLedgerFieldInPlace = (
  container: Record<string, unknown>,
  key: string,
  plan: PiiEgressPlan,
): boolean => {
  if (!(key in container)) return false;
  const original = container[key];
  const { aliased, summary } = piiEgress.aliasArgsForEgress(plan.ledger, original);
  if (JSON.stringify(aliased) !== JSON.stringify(original)) {
    container[key] = aliased;
    plan.summary.value = mergeRedactionSummary(plan.summary.value, summary);
    return true;
  }
  return false;
};

interface NormalizedExecutionCaseAlias {
  readonly phrase: string;
  readonly replacement: string;
}

const escapeExecutionCaseAliasPattern = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** D-214 request shapes are normalized derivatives, not verbatim source text.
 *  A ledger entry such as `Delphine Rowntree` therefore reaches a historical
 *  card as the split leaves `['delphine', 'rowntree']`; the ordinary content
 *  walk cannot match either leaf to the full stored value. Build a bounded
 *  mapping from the ledger's already-authorized real values to the exact
 *  normalization D-214 used, preserving the existing alias/restore identity.
 *
 *  Casing siblings collapse onto their canonical relationship. If two
 *  unrelated ledger identities normalize to the same phrase, emit a plain
 *  non-restorable redaction marker instead of choosing the wrong identity. */
const normalizedExecutionCaseAliases = (
  plan: PiiEgressPlan,
): NormalizedExecutionCaseAlias[] => {
  const grouped = new Map<string, Array<{
    readonly identity: string;
    readonly replacement: string;
  }>>();
  for (const entry of [...plan.ledger.byKindRealValue.values()]) {
    const phrase = normalizeExecutionCaseText(entry.real_value);
    if (phrase.length === 0) continue;
    const probed = piiEgress.aliasArgsForEgress(
      plan.ledger,
      entry.real_value,
    ).aliased;
    const replacement =
      typeof probed === 'string' && probed !== entry.real_value
        ? probed
        : entry.alias_value;
    const canonical = entry.relationship_refs?.[0] ?? entry.alias_value;
    const candidates = grouped.get(phrase) ?? [];
    candidates.push({
      identity: `${entry.kind}\u0000${canonical}`,
      replacement,
    });
    grouped.set(phrase, candidates);
  }
  return [...grouped.entries()]
    .map(([phrase, candidates]) => {
      const identities = new Set(candidates.map(({ identity }) => identity));
      return {
        phrase,
        replacement:
          identities.size === 1
            ? candidates[0]!.replacement
            : 'redacted',
      };
    })
    .sort((left, right) =>
      right.phrase.length - left.phrase.length
      || left.phrase.localeCompare(right.phrase));
};

const replaceNormalizedExecutionCaseAliases = (
  value: string,
  aliases: readonly NormalizedExecutionCaseAlias[],
): { value: string; replacements: number } => {
  let next = value;
  let replacements = 0;
  for (const alias of aliases) {
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}_])${escapeExecutionCaseAliasPattern(alias.phrase)
        .replace(/ /gu, '\\s+')}(?![\\p{L}\\p{N}_])`,
      'gu',
    );
    next = next.replace(pattern, () => {
      replacements += 1;
      return alias.replacement;
    });
  }
  return { value: next, replacements };
};

/** Alias every D-214 model-facing request-shape projection nested in one
 *  packet field, including its two token arrays. This covers both the S4
 *  augmentation context and proposal-critic cards carried in a prior result. */
const aliasNormalizedExecutionCaseShapesInPlace = (
  value: unknown,
  aliases: readonly NormalizedExecutionCaseAlias[],
): number => {
  if (aliases.length === 0) return 0;
  const normalizedComponents = new Set(
    aliases.flatMap(({ phrase }) => phrase.split(' ').filter(Boolean)),
  );
  let replacements = 0;
  const replaceString = (value: string): string => {
    const replaced = replaceNormalizedExecutionCaseAliases(value, aliases);
    replacements += replaced.replacements;
    return replaced.value;
  };
  const aliasShape = (shape: unknown): void => {
    if (shape === null || typeof shape !== 'object' || Array.isArray(shape)) return;
    const record = shape as Record<string, unknown>;
    for (const key of ['surface_terms', 'segmented_terms'] as const) {
      const terms = record[key];
      if (!Array.isArray(terms) || !terms.every((term) => typeof term === 'string')) {
        continue;
      }
      const joined = (terms as string[]).join(' ');
      const replaced = replaceString(joined);
      const scrubbedTerms = replaced
        .split(/\s+/u)
        .filter(Boolean)
        .map((term) => {
          if (!normalizedComponents.has(term)) return term;
          replacements += 1;
          return 'redacted';
        });
      if (
        replaced !== joined
        || scrubbedTerms.some((term, index) => term !== terms[index])
      ) {
        // `segmentExecutionCaseText` emits unique terms. Preserve that shape
        // after several ambiguous fragments collapse to the same marker.
        record[key] = [...new Set(scrubbedTerms)];
      }
    }
    const intentFacets = record.intent_facets;
    if (Array.isArray(intentFacets)) {
      record.intent_facets = intentFacets.map((facet) =>
        typeof facet === 'string' ? replaceString(facet) : facet);
    }
    const entitySlots = record.entity_slots;
    if (Array.isArray(entitySlots)) {
      for (const slot of entitySlots) {
        if (slot === null || typeof slot !== 'object' || Array.isArray(slot)) continue;
        const slotRecord = slot as Record<string, unknown>;
        for (const key of ['role', 'kind'] as const) {
          if (typeof slotRecord[key] === 'string') {
            slotRecord[key] = replaceString(slotRecord[key] as string);
          }
        }
      }
    }
  };
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    if (current === null || typeof current !== 'object') return;
    for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
      if (key === 'request_shape') aliasShape(child);
      else visit(child);
    }
  };
  visit(value);
  return replacements;
};

const aliasExecutionCaseDerivedFieldInPlace = (
  container: Record<string, unknown>,
  key: string,
  plan: PiiEgressPlan,
  aliases: readonly NormalizedExecutionCaseAlias[],
): boolean => {
  if (!(key in container)) return false;
  const original = container[key];
  const originalJson = JSON.stringify(original);
  const normalizedReplacements = aliasNormalizedExecutionCaseShapesInPlace(
    original,
    aliases,
  );
  const { aliased, summary } = piiEgress.aliasArgsForEgress(
    plan.ledger,
    original,
  );
  if (normalizedReplacements > 0) {
    plan.summary.value = mergeRedactionSummary(plan.summary.value, {
      mode: 'alias',
      scope_kind: 'session',
      counts: { content_text_replacements: normalizedReplacements },
    });
  }
  if (JSON.stringify(aliased) !== originalJson) {
    container[key] = aliased;
    plan.summary.value = mergeRedactionSummary(plan.summary.value, summary);
    return true;
  }
  return false;
};

/** D-167 (recall path, off-cap) — alias ONE container field's value against the
 *  CONTACT recall surface (seed ⊇ scan) + overlap-reveal, instead of the ledger-only
 *  scan. Composes the per-result `RecallIndex` store-wide: the per-turn whole-warehouse
 *  name/org automaton + the identifiers TEXT-RESOLVED from THIS field (only the
 *  email/phone candidates actually present, looked up exact + store-wide). So the seed
 *  set is bounded by the (small) recalled text, never the warehouse — no cap, no leak,
 *  no ledger blow-up. SEEDS the ledger as a side effect, so a ledger-anchored scan over
 *  a sibling field afterwards picks up the same contacts. Same structural-compare
 *  rebind + summary-merge contract as `aliasLedgerFieldInPlace`. */
const aliasRecallFieldInPlace = (
  container: Record<string, unknown>,
  key: string,
  plan: PiiEgressPlan,
  recall: RecallScanContext,
): boolean => {
  if (!(key in container)) return false;
  const original = container[key];
  // Serialize once — used both to extract this result's identifier candidates and as
  // the byte-identity compare baseline. JSON.stringify covers every nested string in
  // the result; a candidate that isn't a real contact resolves to nothing (no false
  // alias). `?? ''` guards the degenerate non-serializable / undefined result.
  const originalJson = JSON.stringify(original);
  const identifierSeeds = recall.resolver.resolveIdentifiers(originalJson ?? '');

  // FAIL CLOSED ON THE VALUE. A seed source THREW, so the shield is incomplete and we cannot
  // know what it failed to cover — every unseeded name / phone / street in this memory body
  // would go to the cloud LLM raw, and nothing would fail or log. Withholding the result costs
  // the model one recall; failing open costs the user their PII. Checked AFTER
  // `resolveIdentifiers` because its phone lookup is a per-result store read that can fail on
  // its own.
  //
  // ⚠ ABSENCE IS NOT FAILURE: an empty warehouse (or no store wired) is a COMPLETE shield over
  // an empty set and does NOT reach here — it aliases nothing and egresses normally. Only a
  // THROWN read degrades.
  if (recall.resolver.isDegraded()) {
    container[key] = RECALL_WITHHELD_MESSAGE;
    return true;
  }

  const recallIndex: piiEgress.RecallIndex = {
    index: recall.resolver.nameOrgIndex.index,
    identifierSeeds,
  };
  const { aliased, summary } = piiEgress.aliasRecallArgsForEgress(
    plan.ledger,
    original,
    recallIndex,
    recall.disclosedTexts,
  );
  if (JSON.stringify(aliased) !== originalJson) {
    container[key] = aliased;
    plan.summary.value = mergeRedactionSummary(plan.summary.value, summary);
    return true;
  }
  return false;
};

/** D-167 N.10 (uniform boundary) — substring-scan the NON-recall data fields the
 *  identifier + `user_message` / `chat_tail` content pass does not already cover,
 *  so EVERY ledger-known value is aliased consistently wherever the model sees it.
 *  The chat boundary is the single PII enforcement point; the tool loop
 *  (`runChatTurn`) threads real values and stays 100% PII-unaware. Covers:
 *    - `prior_tool_calls[].{args, result, detail}` — the model's prior NON-recall
 *      dispatches. Memory RECALL results travel in the typed `recall_context` field
 *      (`aliasRecallContextField`), so they never reach this uniform scan. `args`
 *      (restored real, threaded by the PII-unaware loop), `result` (the dispatch
 *      payload — the substring scan ALSO catches a ledger value the markers left
 *      embedded in an otherwise-real field, e.g. a contact org inside a deal title,
 *      which the per-field marker pass leaves raw; under the uniform boundary that
 *      is consistent aliasing, not corruption — the model only ever sees the aliased
 *      form), and `detail` (a raw dispatch `Error.message`).
 *    - `correction_context` — the correction-learning summary strings.
 *    - D-214 `request_shape` objects in top-level augmentation and nested critic
 *      results — normalized phrases are reconstructed before the ordinary walk.
 *  Ledger-anchored throughout. Mutates the owned packet in place; returns
 *  whether anything changed so the early no-field path stays byte-identical
 *  when nothing did. */
const uniformContentScanDataFields = (
  packet: unknown,
  plan: PiiEgressPlan,
): boolean => {
  if (packet === null || typeof packet !== 'object' || Array.isArray(packet)) return false;
  const record = packet as Record<string, unknown>;
  // Deriving a composite alias may itself walk the ledger. Build this bounded
  // phrase map once per provider packet, not once per prior-call data field.
  const normalizedAliases = normalizedExecutionCaseAliases(plan);
  let changed = false;
  const calls = record.prior_tool_calls;
  if (Array.isArray(calls)) {
    for (const call of calls) {
      if (call === null || typeof call !== 'object' || Array.isArray(call)) continue;
      const entry = call as Record<string, unknown>;
      for (const field of PRIOR_TOOL_CALL_DATA_FIELDS) {
        if (aliasExecutionCaseDerivedFieldInPlace(
          entry,
          field,
          plan,
          normalizedAliases,
        )) {
          changed = true;
        }
      }
    }
  }
  if (aliasLedgerFieldInPlace(record, 'correction_context', plan)) changed = true;
  // ⛔⛔⛔ THE ROLLING BRIEF'S OWN PACKET FIELDS — ABSENT FROM THIS ENUMERATION
  //   SINCE THE FEATURE SHIPPED, SO THEY REACHED THE PROVIDER RAW.
  //
  //   🔑 MEASURED 2026-09-09 over 2,865 outbound packets: 144 (5.0%) carried the
  //   seed contact's REAL NAME. Every one was a BRIEF packet, and the field
  //   census is exact — `carried_forward` 88, `user_request` 70,
  //   `tool_results_since` 43. The MAIN packet for the same turn carried
  //   `pii.Person1` and NO raw name, so the ledger was live and working the
  //   whole time; the brief simply named fields nobody had enumerated.
  //
  //   ⇒ THIS FILE PREDICTED IT, in the note on `execution_precedent` below:
  //   "this scan is an ENUMERATION: a new model-bound field is silently absent
  //   from it and reaches the provider unaliased, WITH NOTHING FAILING." The
  //   brief added four such fields and none were added here.
  //
  //   ⚠ `pending_user_statements` is the newest of them and the worst-shaped:
  //   it carries the user's messages VERBATIM, which is the highest-density PII
  //   surface in the packet.
  for (const briefField of [
    'user_request',
    'carried_forward',
    'tool_results_since',
    'pending_user_statements',
  ]) {
    if (aliasLedgerFieldInPlace(record, briefField, plan)) changed = true;
  }
  // This host-validated edit target has only one free-text field: action
  // targets. All other values are host IDs, passage handles or fixed enums.
  // Keep those bindings stable if a contact happens to share an enum's name.
  const editTarget = record['mail_work_edit_target'];
  if (editTarget && typeof editTarget === 'object' && !Array.isArray(editTarget)) {
    const actions = (editTarget as Record<string, unknown>)['actions'];
    if (Array.isArray(actions)) for (const action of actions) {
      if (action && typeof action === 'object' && !Array.isArray(action)
        && aliasLedgerFieldInPlace(action as Record<string, unknown>, 'target', plan)) changed = true;
    }
  }
  // The pre-seed INDEX rides the same boundary. It is built from the owner's own
  // prompt terms, so every token in it is one the ledger may already alias from
  // `user_message` — and an index naming the raw name beside an aliased message
  // would BOTH leak the value and break the model's ability to join the two.
  // Named here per this scan's enumeration rule, not left to a walker.
  if (aliasLedgerFieldInPlace(record, 'index_context', plan)) changed = true;
  // D-259 intent is host-derived from a recipe declaration, but user-authored
  // recipe names can still contain personal values. Keep this newly enumerated
  // model field on the same one-way alias boundary as every dynamic context.
  if (aliasLedgerFieldInPlace(record, 'in_flight_context', plan)) changed = true;
  // D-214 cards are scope-checked typed projections, but their request-shape
  // facets can still echo the owner's own entity tokens. Keep them on the same
  // single egress boundary as every other dynamic context field.
  if (aliasExecutionCaseDerivedFieldInPlace(
    record,
    'execution_case_context',
    plan,
    normalizedAliases,
  )) {
    changed = true;
  }
  // ⛔ D-219's ordinary-path precedent block rides the SAME boundary, and it is
  // named here because this scan is an ENUMERATION: a new model-bound field is
  // silently absent from it and reaches the provider unaliased, with nothing
  // failing. Its `request` facets are normalized derivatives of the owner's own
  // prompt — the same class of value as the D-214 card's request shape — so it
  // gets the same treatment rather than an argument about whether facets can
  // carry a name.
  if (aliasExecutionCaseDerivedFieldInPlace(
    record,
    'execution_precedent',
    plan,
    normalizedAliases,
  )) {
    changed = true;
  }
  return changed;
};

/** D-167 (recall path) — alias the typed `recall_context` packet field: the memory
 *  RECALL dispatches the composer routed out of `prior_tool_calls`
 *  (`partitionPriorToolCalls`). Each entry's `result` is aliased against the CONTACT
 *  recall index (seed ⊇ scan) + overlap-reveal — so a contact recalled from a PRIOR
 *  session (absent from the session ledger, the cross-session leak) is aliased
 *  before egress. `result` FIRST: it SEEDS the ledger from the contact index, so the
 *  ledger-anchored `args` / `detail` scans below pick up the same contacts (and the
 *  caller's subsequent uniform scan over `prior_tool_calls` benefits too). `args`
 *  (the query shape) / `detail` (an error string) rarely carry contact PII, but
 *  staying on the uniform boundary keeps coverage complete. Mutates the owned packet
 *  in place; returns whether anything changed. */
const aliasRecallContextField = (
  packet: unknown,
  plan: PiiEgressPlan,
  recall: RecallScanContext,
): boolean => {
  if (packet === null || typeof packet !== 'object' || Array.isArray(packet)) return false;
  const entries = (packet as Record<string, unknown>).recall_context;
  if (!Array.isArray(entries)) return false;
  let changed = false;
  for (const raw of entries) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    if (aliasRecallFieldInPlace(entry, 'result', plan, recall)) changed = true;
    if (aliasLedgerFieldInPlace(entry, 'args', plan)) changed = true;
    if (aliasLedgerFieldInPlace(entry, 'detail', plan)) changed = true;
  }
  return changed;
};

/** Alias the outbound chat AI-call input (spec §"Runtime flow" steps 2-5).
 *  The orchestrator composed `input['llm.prompt']` as a JSON packet
 *  (`composeChatMainTurnPromptParts(...).body`); parse it, run the gateway
 *  egress alias pass over its privacy-tagged fields against the session ledger,
 *  strip any `__entity` markers, and re-serialize. A non-string / non-JSON
 *  prompt (never produced by the composer) preserves the legacy unchanged-input
 *  path only when no recall result was registered. Recall-bearing packets fail
 *  closed before provider egress. With the noop resolver and no markers the
 *  parse→re-serialize round-trips the prompt unchanged.
 *
 *  D-164 prompt-cache restructure — every return spreads `...input`, so the
 *  sibling `input['llm.cache_prefix']` (the byte-stable catalog prefix) rides
 *  through untouched. The egress only ever aliases per-turn fields (in the
 *  SUFFIX) and injects `prefetch_context` AFTER `commitment_context`, never the
 *  `available_tools`/`commitment_context` head — so the re-serialized body still
 *  starts with `cache_prefix`, and the LLM layer's `buildUserTurn` split holds.
 *  (A `pii.`-literal pre-scan that rewrote the catalog would drift the head;
 *  `buildUserTurn` fails open to a single unsplit block in that case.) */
const aliasChatAiInputData = async (
  input: Record<string, unknown>,
  plan: PiiEgressPlan,
  /** D-167 — the prompt-cache prefetch's STRUCTURED entity parts, threaded from
   *  the orchestrator via the executor wrapper (NOT the JSON packet — raw
   *  warehouse records must never sit in `llm.prompt`, where an inactive plan
   *  would ship them raw). Aliased + rendered + injected HERE so the SINGLE wire
   *  seam is the one PII enforcement point: the prefetch seeds the shared ledger
   *  before the user_message scan + recall, and one contact renders to one alias
   *  everywhere. Absent / empty → no prefetch block (pre-wiring behaviour). */
  entityParts?: readonly EntityPromptPart[],
): Promise<Record<string, unknown>> => {
  // ── D-208 — COLLISION-PROOF THE SYSTEM PROMPT TOO ────────────────────────
  // Until D-208 `llm.system_prompt` was Recued-authored static text, so the
  // Slice-3 pre-scan only ever needed to cover the packet. It now carries the
  // owner's role block AND — on an llm_gateway door whose owner chose the
  // `append` / `replace` caller policy — TEXT WRITTEN BY AN EXTERNAL CALLER.
  //
  // 🔴 Without this pass that is a live PII EXFILTRATION: a caller writes
  // `pii.Person1` into their system prompt, the slot is never reserved, a real
  // contact in the same turn aliases INTO that slot, the model echoes the token
  // it was instructed to, and `restoreForDisplay` hands the caller back the real
  // name. (Proven end-to-end, then pinned:
  // `d-208-pii-system-prompt-collision.test.ts`.) The `context` / `ignore`
  // policies were never exposed — their caller text rides `llm.prompt`, which
  // this function has always scanned.
  //
  // Runs FIRST, before the alias pass below can hand a real value that slot, and
  // before the `llm.prompt` early-returns — a malformed packet must not become a
  // way to skip it. The cheap conservative gate covers readable aliases plus
  // email/domain `.invalid` surfaces; Recued's own blocks ordinarily carry none,
  // so they stay byte-identical and the prompt-cache is untouched. Reserving
  // leaves the text as-is; only an ESCAPE rewrites it.
  const systemPromptRaw = input['llm.system_prompt'];
  let systemPatch: Record<string, unknown> | undefined;
  if (
    typeof systemPromptRaw === 'string'
    && piiEgress.hasPotentialPiiAliasLiteral(systemPromptRaw)
  ) {
    const pre = piiEgress.preScanPacketForEgress(plan.ledger, { s: systemPromptRaw });
    if (pre.escaped) {
      systemPatch = { 'llm.system_prompt': (pre.value as { s: string }).s };
    }
  }
  const withSystem = (next: Record<string, unknown>): Record<string, unknown> =>
    systemPatch ? { ...next, ...systemPatch } : next;

  const prompt = input['llm.prompt'];
  const recallRegistered =
    plan.candidateReharvest?.hasRegisteredRecall() === true;
  if (typeof prompt !== 'string') {
    if (recallRegistered) {
      throw new ChatPiiPrivacyError('recall-bearing llm.prompt is missing');
    }
    return withSystem(input);
  }
  let packet: unknown;
  try {
    packet = JSON.parse(prompt);
  } catch {
    if (recallRegistered) {
      throw new ChatPiiPrivacyError('recall-bearing llm.prompt is malformed');
    }
    return withSystem(input);
  }
  if (packet === null || typeof packet !== 'object' || Array.isArray(packet)) {
    if (recallRegistered) {
      throw new ChatPiiPrivacyError('recall-bearing llm.prompt is not an object');
    }
    return withSystem(input);
  }
  // Preserve the actual owner-authored disclosure before any exact-path or
  // candidate alias pass rewrites it. Overlap suffixes are a local
  // coreference aid; deriving them from an already-aliased packet silently
  // loses what the owner really typed.
  const rawDisclosedTexts = disclosedTextsFromPacket(packet);
  // D-167 Slice 3 — collision-proof the WHOLE packet against any user-typed
  // `pii.*` literal (e.g. a note anonymizing a friend as "pii.Person1") BEFORE
  // the alias pass: reserve a free slot (self-map) or escape a colliding one so
  // the literal round-trips through restore instead of un-aliasing into whatever
  // real value holds that slot. Run ONCE here on the whole packet — never inside
  // the per-field aliasers, which the path below invokes more than once (a second
  // pass would re-escape an escaped token). The conservative gate covers both
  // readable and `.invalid` alias families so a packet with no possible literal
  // keeps the byte-identity fast path; an ESCAPE rewrites a token (packet changed
  // → re-serialize), while a reserve only updates the ledger (slot-claim +
  // restore self-map), leaving the packet text identical.
  let preScanEscaped = false;
  if (piiEgress.hasPotentialPiiAliasLiteral(prompt)) {
    const pre = piiEgress.preScanPacketForEgress(plan.ledger, packet);
    packet = pre.value;
    preScanEscaped = pre.escaped;
  }
  // Structured entity payloads enter the provider packet only after their
  // local renderer runs, so they are not present in `llm.prompt` above. Scan
  // their JSON data separately before any identifier allocation; otherwise a
  // source value literally equal to `pii.Person1` could collide with a real
  // Person1 allocated by this request and become restorable as that person.
  let protectedEntityParts = entityParts;
  if (entityParts && entityParts.length > 0) {
    const payloads = entityParts.map((part) => part.payload);
    const serializedPayloads = JSON.stringify(payloads);
    if (piiEgress.hasPotentialPiiAliasLiteral(serializedPayloads)) {
      const pre = piiEgress.preScanPacketForEgress(plan.ledger, payloads);
      protectedEntityParts = entityParts.map((part, index) => ({
        ...part,
        payload: pre.value[index] ?? [],
      }));
      if (pre.escaped) preScanEscaped = true;
    }
  }
  const recallContext = (packet as Record<string, unknown>).recall_context;
  if (
    recallRegistered
    && (
      !Array.isArray(recallContext)
      || recallContext.length === 0
      || !recallContext.every(
        (entry: unknown) =>
          entry !== null
          && typeof entry === 'object'
          && !Array.isArray(entry),
      )
    )
  ) {
    throw new ChatPiiPrivacyError(
      'recall-bearing packet has invalid recall_context',
    );
  }
  // D-167 — ENACT the prompt-cache prefetch at the SINGLE seam (was an eager
  // SECOND alias pass at the orchestrator gather, which raced the seam over the
  // shared ledger and could mint a redundant alias for a contact the seam also
  // aliased). Alias the entity payload + render + inject FIRST, so it seeds the
  // ledger BEFORE the user_message/chat_tail scan + recall below — one contact
  // then renders to one alias in the prefetch block, the tool results, AND the
  // user's message. `renderEntityPartsForEgress` self-gates on active-plan + a
  // real resolver (inactive/noop → renders nothing → no raw PII), and the raw
  // records arrive via the wrapper closure, NEVER the JSON packet, so an inactive
  // plan (wrapper returns `real`, never reaching here) can't ship them raw.
  let prefetchInjected = false;
  if (protectedEntityParts && protectedEntityParts.length > 0) {
    const blocks = renderEntityPartsForEgress(
      protectedEntityParts, plan, rawDisclosedTexts,
    );
    if (blocks.length > 0) {
      (packet as Record<string, unknown>).prefetch_context = blocks;
      prefetchInjected = true;
    }
  }
  // Resolve the main packet's structural tags once, before any candidate pass
  // replaces raw tool-feedback values. The same resolved paths drive final
  // direct protection and the flat assistant-source projection.
  const rawFields = plan.resolver(packet as PiiAliasableData);
  if (plan.retainedCandidates !== undefined) {
    try {
      plan.retainedCandidates.value = projectToolDispatchCandidates(
        packet as PiiAliasableData,
        () => rawFields,
      );
    } catch {
      plan.retainedCandidates.value = [];
    }
  }
  // Mandatory exact-path protection runs while the resolver's paths still
  // address the raw structure. The candidate pass below is intentionally
  // key-aware inside dynamic data; running it first could rename a nested key
  // and make a schema path miss its value. User prose is normalized to a
  // content field here so a resolver cannot allocate one malformed whole-value
  // identifier for a sentence.
  const directFields = normalizeChatUserMessagePiiFields(
    packet as PiiAliasableData,
    rawFields,
    false,
  );
  let directlyProtected = false;
  if (directFields.length > 0) {
    const direct = piiEgress.aliasPacketForEgress({
      ledger: plan.ledger,
      packet: packet as PiiAliasableData,
      resolver: () => directFields,
      mode: 'alias',
    });
    packet = direct.aliased;
    plan.summary.value = mergeRedactionSummary(
      plan.summary.value,
      direct.summary,
    );
    directlyProtected = true;
  }
  let reharvestChanged = false;
  if (hasRecallContext(packet) && plan.candidateReharvest !== undefined) {
    try {
      const contribution = await plan.candidateReharvest.contributor.contribute({
        joined_pieces: plan.candidateReharvest.getJoinedPieces(),
      });
      reharvestChanged = aliasReharvestCandidatesInPlace(
        packet as Record<string, unknown>,
        plan,
        contribution.candidates,
        rawDisclosedTexts,
      );
    } catch (error) {
      // ⛔ An integrity failure is NOT a coverage miss. This catch exists for
      // the CONTRIBUTOR's bounded source reads, but its scope also covers the
      // alias pass — so the pass's own "lost a dynamic field" guard was being
      // swallowed even once it could fire. A privacy failure keeps its
      // fail-closed contract; the wire wrapper turns it into a non-retry local
      // failure rather than sending the packet.
      if (error instanceof ChatPiiPrivacyError) throw error;
      // Candidate reharvest is additive over the existing mandatory D-167
      // baseline. A bounded read miss weakens enhancement coverage but cannot
      // make direct protection fail open.
    }
  }
  // D-167 (recall path) — resolve the recall context ONCE: undefined unless the
  // packet carries a typed `recall_context` field AND a contact recall index is
  // available. When set, `aliasRecallContextField` aliases those results against
  // the contact index (seed ⊇ scan) + overlap-reveals them, so a contact recalled
  // from a PRIOR session is aliased even though the session ledger has never seen
  // it (the cross-session leak). Resolved AFTER the pre-scan reassigns `packet`.
  // The index builds lazily (only because there IS a `recall_context` field), so a
  // non-recall turn pays nothing and keeps the byte-identity fast path below.
  const recallCtx = resolveRecallScanContext(
    packet,
    plan,
    rawDisclosedTexts,
  );
  // D-167 — the data-field aliasing for one packet (the owned parsed packet, or its
  // aliased clone): recall FIRST (the typed `recall_context` field, aliased against
  // the contact index — this SEEDS the ledger), THEN the uniform ledger scan over
  // the remaining `prior_tool_calls` / `correction_context` data fields (now
  // benefiting from the recall seed + this packet's own tagged fields). Each leg
  // self-gates, so a non-recall empty-ledger packet changes nothing and the
  // byte-identity fast path holds.
  const applyDataScans = (target: unknown): boolean => {
    let changed = false;
    if (recallCtx !== undefined && aliasRecallContextField(target, plan, recallCtx)) {
      changed = true;
    }
    // The same whole-warehouse resolver over TOOL RESULTS. `aliasRecallFieldInPlace`
    // was always generic over (container, key); only `recall_context` was ever
    // passed to it. Six field families ride one call: name / organization /
    // street via the automaton, and email / phone / domain text-driven.
    // ⚠ It SEEDS the ledger, so the uniform ledger scan below then covers sibling
    // fields — intended compounding, not double-aliasing: the helper is
    // byte-identity guarded and a no-op when it changes nothing.
    // ⛔⛔ PER-ENTRY, AND `args` TAKES THE PLAIN LEDGER PASS — NOT THE RECALL ONE.
    //   This passed the WHOLE `prior_tool_calls` array to the recall pass, which
    //   runs `decorateOverlapReveal` on every string leaf. The whole-warehouse
    //   resolver is right for a tool RESULT (that is why the call was widened);
    //   the overlap DECORATION rode along, and it landed on the model's own
    //   echoed ARGUMENTS.
    //
    //   🔑 MEASURED (bench 343, run z-343-r4, turn 1). One packet, one contact,
    //   two surface forms: `user_message` + `prefetch_context` carried the plain
    //   `pii.Person1` / `m1@d1.invalid`, while `prior_tool_calls` carried the
    //   decorated `pii.Person1.dana.reyes` / `m1.dana.reyes@d1.invalid`. The
    //   model wrote the ONLY email form it was ever shown (`m1@d1.invalid`, from
    //   `prefetch_context`); its echoed args came back wearing a form that
    //   appears NOWHERE in what it read. The grounding corpus excludes
    //   `prior_tool_calls` by design, so the decorated identifier is
    //   unattributable — the call was refused, the model re-sent the same
    //   correct value, and the turn livelocked for 9 rounds until it timed out.
    //
    //   ⛔ AN EMAIL IS AN EXACT-MATCH FIELD. A coreference tail is a harmless
    //   hint on a NAME; on an ADDRESS one extra character is a different
    //   address, so a second surface form is a correctness bug, not cosmetics.
    //   The name alias already carries the coreference.
    //
    //   ⇒ `aliasRecallContextField` (above) ALREADY draws this line for the
    //   identical shape: `result` takes the recall pass, `args` / `detail` take
    //   `aliasLedgerFieldInPlace`. Results are CONTENT; args are a RECORD of
    //   what the model sent. This mirrors it instead of inventing a rule.
    if (recallCtx !== undefined) {
      // Closing summaries carry the same tool records under another top-level
      // field. They need the same warehouse scan and degraded withholding.
      const calls = ['prior_tool_calls', 'tool_results_since'].flatMap(lane => {
        const entries = (target as Record<string, unknown>)[lane];
        return Array.isArray(entries) ? entries : [];
      });
      if (Array.isArray(calls)) {
        for (const raw of calls) {
          if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
          const entry = raw as Record<string, unknown>;
          if (aliasRecallFieldInPlace(entry, 'result', plan, recallCtx)) changed = true;
          // ⛔⛔ SAME WHOLE-WAREHOUSE ALIASING, NO OVERLAP DECORATION. The first
          //   attempt at this fix sent `args` through the plain ledger pass and
          //   its own test caught the regression immediately: a contact email
          //   the session ledger had never seen EGRESSED RAW. Whole-warehouse
          //   seeding is exactly why this call was widened to `prior_tool_calls`
          //   — dropping it trades a livelock for a leak, which is worse.
          //   Passing an EMPTY disclosed set keeps the resolver and makes
          //   `decorateOverlapReveal` a no-op (it reveals nothing when nothing
          //   was disclosed), so args are aliased identically to every other
          //   field and carry no coreference tail.
          const recordCtx = { ...recallCtx, disclosedTexts: [] };
          if (aliasRecallFieldInPlace(entry, 'args', plan, recordCtx)) changed = true;
          if (aliasRecallFieldInPlace(entry, 'detail', plan, recordCtx)) changed = true;
        }
      }
    }
    if (plan.ledger.byKindRealValue.size > 0 && uniformContentScanDataFields(target, plan)) {
      changed = true;
    }
    return changed;
  };
  // Mandatory structural fields were protected above, before candidate
  // key-rewriting could invalidate their paths. This final pass handles the
  // whole-packet free-text surfaces against the now-complete staged ledger.
  // With no direct fields, no ledger seeds, and no markers, the original input
  // still takes the byte-identity fast path.
  // D-167 N.10.2 ② — run the ledger-anchored content pass over the free-text
  // chat fields (`user_message` + `chat_tail`) whenever the session ledger
  // ALREADY holds aliases (seeded earlier this turn — e.g. by the prefetch
  // entity-part gather, or a prior tool-loop round) OR the resolver tagged a
  // structural field in this packet. Without this, a prefetch-only first turn
  // (no structural markers — the gather already rendered them to strings) would
  // alias the prefetch block yet send the same contact's name RAW in
  // `user_message`/`chat_tail`. An empty ledger with no structural field keeps
  // the byte-identical early path below (no deep-clone, no re-serialize).
  // Gated on `byKindRealValue` (REAL aliases to find in free text), NOT
  // `byKindBaseAlias` — the latter also holds D-167 Slice 3 pre-scan reservations
  // (a user-typed `pii.*` literal that claimed a free slot, self-mapped). A
  // reserve seeds no real value to scan for, so it must NOT pull a reserve-only
  // packet off the byte-identity fast path (a deep-clone there would drop a
  // legitimate `__proto__`/`constructor` arg key). An escape forces re-serialize
  // via `preScanEscaped` instead.
  const scanContent =
    directlyProtected || plan.ledger.byKindRealValue.size > 0;
  const userMessageFields = normalizeChatUserMessagePiiFields(
    packet as PiiAliasableData,
    [],
    scanContent,
  );
  const fields = scanContent
    ? [...userMessageFields, ...chatTailContentFieldTags(packet as PiiAliasableData)]
    : userMessageFields;
  // D-167 N.10 (uniform boundary) — after the identifier + user_message/chat_tail
  // content pass, run ONE ledger-anchored substring scan over the remaining data
  // fields (`prior_tool_calls[].{args,result,detail}` + `correction_context`) so
  // every ledger-known value is aliased consistently wherever the model sees it.
  // The chat boundary is the single PII enforcement point; `runChatTurn` threads
  // real values and stays 100% PII-unaware. Gated on a non-empty ledger so an
  // empty-ledger packet stays byte-identical. See `uniformContentScanDataFields`.
  if (fields.length === 0) {
    // No structural / content field this packet ⇒ no result fields seed the ledger
    // here; it holds only what PRIOR turns aliased. `applyDataScans` runs the recall
    // gather (which can seed an EMPTY ledger from the contact index — exactly the
    // cross-session leak case: a fresh session recalling a prior-session contact has
    // nothing in the ledger) then the uniform ledger scan, then we strip markers. A
    // non-recall empty-ledger packet keeps the byte-identity fast path (both legs
    // self-gate to no-ops → `scanned` false).
    const scanned = applyDataScans(packet);
    const removed = stripEntityMarkers(packet);
    // D-224 — tell the model what an alias IS, on turns that carry one.
    //
    // ⛔ GATED ON `byKindRealValue`, the same predicate the content scan uses:
    // it means a REAL value was aliased, so the model will actually meet a token.
    // A pre-scan RESERVATION lives in `byKindBaseAlias` only and produces no
    // model-visible alias, so gating on that would emit the notice into packets
    // with nothing to explain — and, being turn-varying, cost the D-164 cacheable
    // prefix for nothing.
    const noticeAdded = injectPiiAliasNotice(packet, plan);
    // `preScanEscaped` ⇒ a user-typed `pii.*` literal was rewritten in `packet`,
    // so it must be re-serialized even on the no-tagged-field path (a reserve
    // leaves the text identical and stays on the `input` fast path).
    // `prefetchInjected` ⇒ the prefetch block was added to `packet` above (an
    // empty user_message + chat_tail can leave `fields` empty even with prefetch
    // seeding), so it too forces the re-serialize.
    return withSystem(
      removed
        || scanned
        || noticeAdded
        || preScanEscaped
        || prefetchInjected
        || directlyProtected
        || reharvestChanged
        ? { ...input, 'llm.prompt': JSON.stringify(packet) }
        : input,
    );
  }
  const { aliased, summary } = piiEgress.aliasPacketForEgress({
    ledger: plan.ledger,
    packet: packet as PiiAliasableData,
    // Reuse the already-resolved fields so a real (non-noop) resolver runs
    // exactly once per packet.
    resolver: () => fields,
    mode: 'alias',
  });
  plan.summary.value = mergeRedactionSummary(plan.summary.value, summary);
  // Data-field aliasing AFTER the identifier pass seeded the ledger from this
  // packet's tagged result fields, so a first reinvoke whose own round-0 result
  // anchors a value the data fields carry still aliases them. Run on the aliased
  // CLONE against the now-seeded ledger: recall gather (typed `recall_context`,
  // seeds further) then the uniform ledger scan. See `applyDataScans`.
  applyDataScans(aliased);
  // Strip every `__entity` marker AFTER aliasing, BEFORE re-serializing the
  // model-bound prompt (E.1 hard egress invariant). `aliased` is a fresh deep
  // clone we own, so the in-place strip is safe; the path always re-serializes
  // regardless, so a no-marker packet stays byte-identical to before.
  stripEntityMarkers(aliased);
  // ⛔ THE SECOND RETURN PATH NEEDS IT TOO. The notice was first added only to
  // the no-tagged-field branch above, and a packet WITH tagged fields — the
  // common case, and the one that aliases most — silently never got it. A
  // control placed inside one branch is exempt from every sibling; this path
  // re-serializes unconditionally, so the return value is discarded.
  injectPiiAliasNotice(aliased, plan);
  return withSystem({ ...input, 'llm.prompt': JSON.stringify(aliased) });
};

/** Keep host schema out of key-aware content scans without exempting data. */
const aliasChatAiInput = async (
  input: Record<string, unknown>, plan: PiiEgressPlan, entityParts?: readonly EntityPromptPart[],
): Promise<Record<string, unknown>> => {
  let packet: unknown;
  try { packet = typeof input['llm.prompt'] === 'string' ? JSON.parse(input['llm.prompt']) : null; }
  catch { packet = null; }
  const restore = packet !== null && typeof packet === 'object' && !Array.isArray(packet)
    ? packMailWorkEnvelopes(packet as Record<string, unknown>) : null;
  if (restore === null) return aliasChatAiInputData(input, plan, entityParts);
  const aliased = await aliasChatAiInputData({ ...input, 'llm.prompt': JSON.stringify(packet) }, plan, entityParts);
  try {
    const result = JSON.parse(String(aliased['llm.prompt'])) as Record<string, unknown>;
    restore(result);
    return { ...aliased, 'llm.prompt': JSON.stringify(result) };
  } catch {
    throw new ChatPiiPrivacyError('mail work source envelope lost data');
  }
};

/** D-164 — drop a now-stale `llm.cache_prefix` when egress drifted the body's
 *  head. The catalog head carries no PII so aliasing leaves it byte-identical in
 *  the common case, but the `pii.*`-literal pre-scan runs over the WHOLE packet:
 *  an alias-shaped literal inside a tool schema (e.g. `pii.Person1`) could be
 *  escaped, shifting the head so the aliased body no longer starts with
 *  `cache_prefix`. The LLM layer's `buildUserTurn` already fails open (one
 *  unsplit block) on a non-prefix, but a stranded hint is misleading — drop it
 *  here so a drifted turn is EXPLICITLY uncached (correct prompt, no caching that
 *  turn) rather than silently relying on the downstream guard. Returns a fresh
 *  object only when it drops the key; otherwise the input is unchanged. */
export const dropStaleCachePrefix = (
  input: Record<string, unknown>,
): Record<string, unknown> => {
  const prefix = input['llm.cache_prefix'];
  const prompt = input['llm.prompt'];
  if (typeof prefix !== 'string' || typeof prompt !== 'string' || prompt.startsWith(prefix)) {
    return input;
  }
  const { ['llm.cache_prefix']: _stale, ...rest } = input;
  return rest;
};

/** D-167 B3 — the entity-ref search tools whose aliased args FIELD-SCOPE by the
 *  alias's kind at the dispatch boundary (D6). Only `contact.search` today; a
 *  future `deal.search`-style entity-ref tool joins this set + the arg map. */
const ENTITY_REF_SEARCH_TOOLS: ReadonlySet<string> = new Set(['contact.search']);

/** D-167 B3 — the `contact.search` arg an aliased value of each ledger kind
 *  belongs in: name → the free-text `query` (name column), org → `company`,
 *  email/email_local → `email` (exact), phone → `phone` (exact). Address / url /
 *  id / domain aliases have NO contact-search field → absent → never routed (the
 *  value stays where the model put it, fail-safe — a name search that misses, no
 *  wrong match). */
const CONTACT_SEARCH_ARG_FOR_LEDGER_KIND: Partial<
  Record<LedgerKind, 'query' | 'company' | 'email' | 'phone'>
> = {
  name: 'query',
  org: 'company',
  email: 'email',
  email_local: 'email',
  phone: 'phone',
};

/** The `contact.search` args whose value may be an entity-ref alias the boundary
 *  re-scopes. `alias` (the chat-alias substrate), `platform`, and `limit` are NOT
 *  routed — only the kind-bearing identifier fields. */
const ROUTABLE_CONTACT_SEARCH_ARGS = ['query', 'email', 'phone', 'company'] as const;

/** D-167 B3 — field-scope an entity-ref search tool call by the KIND of its
 *  aliased value, BEFORE the value-restore turns the alias into a bare value and
 *  loses the field it came from (design D6). For each routable arg holding a
 *  genuine alias surface (`ledgerKindForAlias` — `pii.`-prefixed / `.invalid`
 *  only, so a RAW string the model typed is never touched), derive the kind and,
 *  when the kind's target arg differs from where the model placed it AND that
 *  target is free, MOVE the value there. So `contact.search({ query: 'pii.Org1' })`
 *  becomes `{ company: 'pii.Org1' }` → org-scoped after restore, instead of a
 *  NAME search for the restored "Acme Corp". So the routing does not depend on
 *  the model passing the right arg/kind: an aliased query SELF-ROUTES.
 *
 *  Fail-safe by construction: an occupied target arg, an unknown / non-routable
 *  alias kind, or a raw (non-alias) value is left EXACTLY as the model sent it
 *  (worst case a name search that finds nothing — never a wrong match). Moves are
 *  planned read-only then applied so two args resolving to the same free target
 *  can't both claim it. Mutates `tool_calls[].args` in place on the freshly-
 *  received result body (a local the caller discards) — the same mutate-via-cast
 *  pattern as `restoreToolCallArgKeys`; the subsequent value-restore reads the
 *  routed args. Runs BEFORE restore (the only point the value is still an alias). */
const routeEntityRefSearchArgs = (
  authority: piiEgress.RequestRestoreAuthority,
  body: unknown,
): void => {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return;
  const toolCalls = (body as Record<string, unknown>).tool_calls;
  if (!Array.isArray(toolCalls)) return;
  for (const tc of toolCalls) {
    if (tc === null || typeof tc !== 'object' || Array.isArray(tc)) continue;
    const call = tc as Record<string, unknown>;
    if (typeof call['tool'] !== 'string' || !ENTITY_REF_SEARCH_TOOLS.has(call['tool'])) continue;
    const args = call['args'];
    if (args === null || typeof args !== 'object' || Array.isArray(args)) continue;
    const a = args as Record<string, unknown>;
    const moves: Array<{ from: string; to: string; value: string }> = [];
    for (const arg of ROUTABLE_CONTACT_SEARCH_ARGS) {
      const value = a[arg];
      if (typeof value !== 'string' || value.length === 0) continue;
      // Route only a request-authorized alias that restores to real data.
      // A hallucinated session alias is not authority, while a Slice-3 escape
      // restores to the user's alias-shaped literal; neither may change fields.
      const restored = piiEgress.restoreForDisplayWithAuthority(
        authority,
        value,
      );
      if (
        restored === value
        || piiEgress.hasPotentialPiiAliasLiteral(restored)
      ) continue;
      const kind = piiEgress.ledgerKindForAlias(value);
      if (kind === undefined) continue;                       // raw / non-alias → leave
      const target = CONTACT_SEARCH_ARG_FOR_LEDGER_KIND[kind];
      if (target === undefined || target === arg) continue;   // no field / already correct
      moves.push({ from: arg, to: target, value });
    }
    for (const { from, to, value } of moves) {
      // Only into a FREE target — never clobber another arg the model set.
      if (a[to] !== undefined && a[to] !== '') continue;
      a[to] = value;
      delete a[from];
    }
  }
};

/** D-167 N.10 — key-restore the model's `tool_calls[].args` maps ONLY. The uniform
 *  egress aliases result-map KEYS, so the model can copy an aliased key into a tool
 *  call's args; restore those KEYS so dispatch + the approval preview see the
 *  real key. Values have already been restored by the enclosing body pass and
 *  MUST NOT be scanned again: an escaped literal could otherwise cascade into
 *  the real mapping it collided with. Scoped here, NOT in the shared value-only
 *  body restore, so a legitimate alias-shaped key elsewhere is never rewritten.
 *  Mutates the OWNED (already deep-copied) restored body in place. */
const restoreToolCallArgKeys = (
  authority: piiEgress.RequestRestoreAuthority,
  body: unknown,
): void => {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return;
  const toolCalls = (body as Record<string, unknown>).tool_calls;
  if (!Array.isArray(toolCalls)) return;
  for (const tc of toolCalls) {
    if (tc === null || typeof tc !== 'object' || Array.isArray(tc)) continue;
    const entry = tc as Record<string, unknown>;
    if (!('args' in entry)) continue;
    entry.args = piiEgress.restoreArgKeysForApprovalWithAuthority(
      authority,
      entry.args,
    );
  }
};

/** Restore the inbound chat AI-call result (spec §"Runtime flow" steps 6-7).
 *  Walk the whole returned body (the `AIOutput` — `response` + each
 *  `tool_call.args` + `events`) and restore alias tokens to their real values
 *  so the tool loop dispatches real args, `personal-recipes` matches real
 *  events, and storage / streaming / display see real values. Skipped (body
 *  reference preserved) when nothing aliased this session — behavior-
 *  preserving for the noop-resolver path. `runChatTurn` then threads the restored
 *  real args into `prior_tool_calls`; the model-facing re-egress of those is
 *  aliased uniformly at the chat boundary by `aliasChatAiInput` on the next call,
 *  so the tool loop stays 100% PII-unaware.
 *
 *  The whole-body restore is VALUE-only; `tool_calls[].args` get an ADDITIONAL
 *  key-restore (`restoreToolCallArgKeys`) because the uniform egress aliases result
 *  map keys — the one surface where the model could feed an aliased key back.
 *
 *  D-167 B3 — BEFORE the value-restore, `routeEntityRefSearchArgs` field-scopes an
 *  entity-ref search (`contact.search`) by the kind of its aliased value (D6): the
 *  alias is still visible here, so an aliased `query` self-routes to `company` /
 *  `email` / `phone` and the restored bare value lands in the right column. Must
 *  run pre-restore (restore erases the alias shape). */
const restoreChatAiResult = (
  result: ChatAiCallResult,
  authority: piiEgress.RequestRestoreAuthority,
): ChatAiCallResult => {
  if (authority.ledger.byKindBaseAlias.size === 0) return result;
  routeEntityRefSearchArgs(authority, result.body);
  const body = piiEgress.restoreArgsForApprovalWithAuthority(
    authority,
    result.body,
  );
  restoreToolCallArgKeys(authority, body);
  return { ...result, body };
};

/** A session ledger is shared by concurrent chat turns. Staging prevents a
 * failed request from publishing unseen aliases, but two overlapping clones
 * could otherwise allocate the same next alias to different people and then
 * overwrite one another at commit. Serialize the complete provider-request
 * lease per live ledger; different sessions remain fully concurrent. */
const LEDGER_REQUEST_TAILS = new WeakMap<
  PiiEgressPlan['ledger'],
  Promise<unknown>
>();

const withSerializedLedgerRequest = async <T>(
  ledger: PiiEgressPlan['ledger'],
  work: () => Promise<T>,
): Promise<T> => {
  const previous = LEDGER_REQUEST_TAILS.get(ledger) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(work);
  LEDGER_REQUEST_TAILS.set(ledger, current);
  try {
    return await current;
  } finally {
    if (LEDGER_REQUEST_TAILS.get(ledger) === current) {
      LEDGER_REQUEST_TAILS.delete(ledger);
    }
  }
};

/** Wrap the orchestrator's `executeAiCall` with the per-call PII enactment
 *  (N.9). Every outbound packet is aliased and every returned body is restored —
 *  aliasing is the SOLE PII protection (D-191 retired force-local routing; the
 *  reversible alias travels with the data whichever way the turn routes). An
 *  inactive plan (external-egress surface) returns the real executor untouched. */
export const wrapExecuteAiCallForPii = (
  real: ExecuteChatAiCall,
  plan: PiiEgressPlan,
  /** Egress-history sink — receives the ALIASED model-bound packet (exactly
   *  what crossed to the cloud) once per AI call, for the "what we sent"
   *  transparency surface. Fires only on the active-plan path (the aliased
   *  cloud-chat case); an inactive external-egress plan returns the raw executor
   *  untouched and is not captured. Best-effort: a throwing sink must not break
   *  the turn (the caller guards it). */
  onEgress?: (aliasedPrompt: string) => void,
  /** D-167 — the prompt-cache prefetch's structured entity parts (see
   *  `aliasChatAiInput`). Threaded from the orchestrator + forwarded into the
   *  seam so the prefetch aliases at the SINGLE enforcement point. An inactive
   *  plan returns `real` above, so the parts (+ their raw records) are never
  *  rendered → the speculative pull is dropped, leak-free. */
  entityParts?: readonly EntityPromptPart[],
  /** Optional hard check over the exact ALIASED provider-bound input. Unlike
   * `onEgress`, this is an enforcement callback and may throw to stop the call.
   * The llm_gateway uses it for final context-window validation because short
   * real values can expand into longer aliases after ordinary prompt packing. */
  validateEgress?: (aliasedInput: Record<string, unknown>) => void,
  /** Receives only candidates from tool feedback in a successfully sent
   * request. The caller unions them into the eventual assistant source. */
  onRetainedCandidates?: (
    candidates: readonly RetainedAliasCandidate[],
  ) => void,
): ExecuteChatAiCall => {
  if (!plan.active) return real;
  // ⚠ `opts` IS FORWARDED, AND TYPESCRIPT CANNOT CHECK THAT IT IS. A 2-arg
  //   function is assignable to a 3-arg type, so a wrapper that drops the
  //   per-call options compiles clean and the option silently never arrives.
  return (manifest, input, opts) => withSerializedLedgerRequest(
    plan.ledger,
    async () => {
    // D-167 — fix the slot ordering BEFORE anything in this request allocates:
    // the pre-scan, the prefetch entity parts, the recall seed and the packet
    // pass all allocate below, and whichever runs first would otherwise own slot
    // 1. Inside the lease, so two concurrent turns cannot both seed. Writes to
    // the LIVE ledger, not the staged clone — a reservation is not an allocation
    // and must survive a request that never commits.
    if (plan.seedSlotOrdering !== undefined) await plan.seedSlotOrdering();
    const stagedLedger = piiEgress.stageLedgerForRequest(plan.ledger);
    const stagedPlan: PiiEgressPlan = {
      ...plan,
      ledger: stagedLedger,
      summary: { value: emptyRedactionSummary() },
      restoreAuthority: {},
      restoredAssistantText: {},
      retainedCandidates: { value: [] },
    };
    let aliasedInput: Record<string, unknown>;
    let serializedAliasedInput: string;
    let authority: piiEgress.RequestRestoreAuthority;
    try {
      aliasedInput = dropStaleCachePrefix(
        await aliasChatAiInput(input, stagedPlan, entityParts),
      );
    } catch (error) {
      if (error instanceof ChatPiiPrivacyError) throw error;
      if (plan.candidateReharvest?.hasRegisteredRecall() === true) {
        throw new ChatPiiPrivacyError(
          'recall-bearing packet could not be protected',
        );
      }
      throw error;
    }
    try {
      serializedAliasedInput = JSON.stringify(aliasedInput);
    } catch (error) {
      if (error instanceof ChatPiiPrivacyError) throw error;
      if (plan.candidateReharvest?.hasRegisteredRecall() === true) {
        throw new ChatPiiPrivacyError(
          'recall-bearing packet could not be protected',
        );
      }
      throw error;
    }
    // Validation errors preserve their own public contract. The callback is an
    // enforcement observer, not a packet transformer.
    validateEgress?.(aliasedInput);
    try {
      const afterValidation = JSON.stringify(aliasedInput);
      if (afterValidation !== serializedAliasedInput) {
        throw new Error('egress validator mutated the protected packet');
      }
      // This exact byte projection is both what transparency captures and what
      // grants reverse authority.
      serializedAliasedInput = afterValidation;
      authority = piiEgress.deriveRequestRestoreAuthority(
        stagedLedger,
        serializedAliasedInput,
      );
      piiEgress.restrictStagedLedgerForRequest(
        plan.ledger,
        stagedLedger,
        authority,
      );
    } catch (error) {
      if (error instanceof ChatPiiPrivacyError) throw error;
      if (plan.candidateReharvest?.hasRegisteredRecall() === true) {
        throw new ChatPiiPrivacyError(
          'recall-bearing packet could not be protected',
        );
      }
      throw error;
    }
    // D-191 — aliasing-only: the wrap aliases the outbound packet + restores the
    // returned body. Force-local routing is retired — aliasing is the sole PII
    // protection; routing is the user's slot_1/slot_2/free_pool choice.
    const result = await real(manifest, aliasedInput, opts);
    piiEgress.commitLedgerForRequest(plan.ledger, stagedLedger);
    plan.summary.value = mergeRedactionSummary(
      plan.summary.value,
      stagedPlan.summary.value,
    );
    if (plan.restoreAuthority !== undefined) {
      plan.restoreAuthority.value = authority;
    }
    if (plan.retainedCandidates !== undefined) {
      plan.retainedCandidates.value = stagedPlan.retainedCandidates?.value ?? [];
    }
    if (onRetainedCandidates) {
      try {
        onRetainedCandidates(stagedPlan.retainedCandidates?.value ?? []);
      } catch {
        // Source projection capture is best-effort after a successful send;
        // source finalization will honestly retain fewer candidates.
      }
    }
    if (onEgress) {
      try {
        onEgress(serializedAliasedInput);
      } catch {
        // A transparency sink cannot invalidate a provider send that already
        // succeeded.
      }
    }
    const restoredResult = restoreChatAiResult(result, authority);
    if (plan.restoredAssistantText !== undefined) {
      const body = restoredResult.body;
      const response =
        body !== null
        && typeof body === 'object'
        && !Array.isArray(body)
        && typeof (body as Record<string, unknown>).response === 'string'
          ? (body as Record<string, unknown>).response as string
          : undefined;
      plan.restoredAssistantText.value = response;
      if (response !== undefined) {
        (plan.restoredAssistantText.responses ??= new Set()).add(response);
      }
    }
    return restoredResult;
    },
  );
};
