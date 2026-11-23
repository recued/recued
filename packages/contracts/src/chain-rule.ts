/** D-348 — L3 learns chains: the PURE vocabulary.
 *
 *  A chain is the owner's request and the calls it led to. When the same request leads to the
 *  same held calls on 3 occasions in 30 days, each approved as proposed and each run, with
 *  nothing spoiled since (a refusal, an undo, a failure, "not sure it finished"), Recued suggests
 *  a standing rule over the chain. Accepted, those calls run without asking the next time that
 *  request leads to them, for up to 30 days and 100 uses. A delete is learned on its own, after 5
 *  such occasions, and only over records the same run found itself. Spec: D-348.
 *
 *  🔑 THE REQUEST IS THE OWNER'S OWN WORDS (Q2), not a model's reading of them: permission rests on
 *  what the owner typed, which a reading, or one injected into it, cannot widen. Case, spacing and
 *  punctuation aside, nothing else is folded: "run my routine" is not "run my morning routine".
 *
 *  🔑 A CALL IS WHAT IT DOES AND TO WHOM (Q3): its operation, plus the values that say whom it
 *  reaches and what it changes. A create that stays in Recued pins nothing; a delete pins nothing
 *  either, because its record is checked when it runs: it must be one the same run found (Q7).
 *
 *  Everything here is pure: no I/O, no clock (callers pass `now`). */

import { canonicalJSONStringify } from '@recued/crypto/canonical-json';
import { sha256Hex } from '@recued/crypto/hash';

import { browserActCallUploads } from './browser-act.js';
import { stripCorePrefix } from './core-pack.js';
import type { AuthorizationProvenance } from './ingredient-catalog.js';
import { readTriggerPreapprovalTier1Op } from './trigger-preapproval.js';

/** Clean occasions before a call is on a chain (Q4), and before a delete is (Q7). */
export const CHAIN_SUGGEST_THRESHOLD = 3;
export const CHAIN_DELETE_SUGGEST_THRESHOLD = 5;
/** The window occasions count in. */
export const CHAIN_LOOKBACK_MS = 30 * 86_400_000;
/** A minted rule's ceilings; the owner may tighten both, never widen them. */
export const CHAIN_RULE_TTL_MS = 30 * 86_400_000;
export const CHAIN_RULE_MAX_USES = 100;

/** Q2 — the words a request is known by: compatibility forms folded (a full-width letter is its
 *  letter), lower case, punctuation dropped, spaces collapsed. "Run my morning routine." and
 *  "run my  morning routine" are one request; "Don't" and "dont" are one too. Empty when nothing
 *  is left, and an empty request is no request. */
export const normalizeChainRequestWords = (text: string): string =>
  text.normalize('NFKC').toLowerCase().replace(/\p{P}+/gu, '').replace(/\s+/gu, ' ').trim();

/** The key a request is learned under. Only the owner's chats learn chains (Q5), so the key names
 *  them; a request from anywhere else derives no key. */
export const chainRequestKeyHash = (normalized: string): string =>
  sha256Hex(canonicalJSONStringify({ kind: 'd348.request', principal: 'owner_chat', words: normalized }));

/** Q3 — one call of a chain: what it does, and whom it reaches or what it changes. */
export interface ChainCallSignature {
  /** The operation. A chat write by the kind its "Allow in this chat" names
   *  (`tier1:work.create:task`); a recipe's held step by the recipe, its version and its call
   *  (`step:<recipe>@<hash>|<ingredient>|<operation>|<connection>`); a pack action by its catalog,
   *  operation and connection (`op:<catalog>|<operation>|<connection>`). */
  readonly op: string;
  /** Each identifying field's values (recipients, record ids), sorted, by the field's path with
   *  list positions dropped (`to`, `attendees.email`). Empty for a create that stays in Recued and
   *  for a delete. */
  readonly pins: Readonly<Record<string, readonly string[]>>;
  /** A delete (`destructive`): learned after 5 occasions, over records the run found (Q7). */
  readonly delete?: true;
}

/** A chat write's call as its pins name it, for what its approval names it by: its tool and scope
 *  (`readTriggerPreapprovalTier1Op`: `tier1:calendar.update:local`), and an argument per pinned
 *  field at the top of the call (a list for several values), with a work record's kind, which the
 *  scope holds. Its values' labels are looked up from these (`askValueLabels`), and its fields
 *  named as its card names them (`tier1CallDetails`). Undefined for any other call. */
export const chainTier1CallArgs = (
  signature: Pick<ChainCallSignature, 'op' | 'pins'>,
): { readonly tool: string; readonly scope: string; readonly args: Readonly<Record<string, unknown>> } | undefined => {
  if (!signature.op.startsWith('tier1:')) return undefined;
  const named = readTriggerPreapprovalTier1Op(signature.op.slice('tier1:'.length));
  if (named === undefined) return undefined;
  const args: Record<string, unknown> = {};
  for (const [field, values] of Object.entries(signature.pins)) {
    // A value inside the call (a guest's address) is shown as it is.
    if (field.includes('.') || values.length === 0) continue;
    args[field] = values.length === 1 ? values[0] : [...values];
  }
  // An asset made of a type is scoped `asset:<type>`.
  if (named.tool === 'work.create' || named.tool === 'work.update') args.kind = named.scope.split(':')[0];
  return { tool: named.tool, scope: named.scope, args };
};

export const chainCallSignatureHash = (signature: ChainCallSignature): string =>
  sha256Hex(canonicalJSONStringify({
    kind: 'd348.call',
    op: signature.op,
    pins: signature.pins,
    delete: signature.delete === true,
  }));

/** The owner's answer to one held call of a request. A change before approving says the proposal
 *  was not right, so it counts for nothing, as in D-329; a refusal spoils the occasion. */
export type ChainCallAnswer = 'approved' | 'approved_changed' | 'refused';
/** How an approved call ended. Anything but `ran` spoils the occasion (Q4). An undo is not one of
 *  them: it comes later, up to 30 days after, and is read with its own time
 *  (`evaluateChainEvidence`'s `undone_at`). */
export type ChainCallOutcome = 'ran' | 'failed' | 'unknown';

export const isChainCallAnswer = (value: unknown): value is ChainCallAnswer =>
  value === 'approved' || value === 'approved_changed' || value === 'refused';
export const isChainCallOutcome = (value: unknown): value is ChainCallOutcome =>
  value === 'ran' || value === 'failed' || value === 'unknown';

/** One answered call of a request, as the learner reads it. */
export interface ChainEvidenceCall {
  /** Absent for a call that could not be named: it is on no chain, but its refusal spoils. */
  readonly signature_hash: string | null;
  readonly delete: boolean;
  readonly answer: ChainCallAnswer;
  readonly outcome: ChainCallOutcome | null;
}

/** One request of a key, as the learner reads it: its occasion and time, the runs it held, how
 *  many of them the owner answered, and the calls answered. */
export interface ChainEvidenceRequest {
  readonly occasion: string;
  readonly at: number;
  readonly held_runs: number;
  readonly answered_runs: number;
  readonly calls: readonly ChainEvidenceCall[];
}

/** What a key's requests teach. */
export interface ChainEvidence {
  /** Clean occasions in the window since the latest spoiled request. */
  readonly occasions: number;
  /** The calls on the chain: each asked, approved as proposed and run on 3 of them (Q4). */
  readonly members: readonly string[];
  /** The deletes on it: each on 5 of them (Q7). */
  readonly deletes: readonly string[];
  /** The latest spoil: a spoiled request's time, or the latest undo's. Nothing at or before it
   *  counts (Q4 "resets"). */
  readonly spoiled_at?: number;
  readonly first_at?: number;
  readonly last_at?: number;
}

const spoils = (call: ChainEvidenceCall): boolean =>
  call.answer === 'refused' || (call.outcome !== null && call.outcome !== 'ran');
const ranAsProposed = (call: ChainEvidenceCall): boolean => call.answer === 'approved' && call.outcome === 'ran';

/** Q4, Q7 — a key's evidence. A request is SPOILED by a refusal or by a call that failed or may
 *  not have finished; nothing before the latest spoiled one counts. An undo resets too, as of when
 *  the owner undid the change (`undone_at`, the key's latest): nothing before then counts, however
 *  recent the occasions it undid. It is CLEAN when every run it held was answered and every call of
 *  them was approved as proposed and ran. Anything else (one still waiting, one that expired, one
 *  the owner changed first) counts for nothing and spoils nothing. A call is on the chain once it
 *  ran in clean requests on 3 occasions; a delete, on 5. */
export const evaluateChainEvidence = (
  requests: readonly ChainEvidenceRequest[],
  now: number,
  undone_at?: number,
): ChainEvidence => {
  const since = now - CHAIN_LOOKBACK_MS;
  const recent = requests.filter((request) => request.at >= since && request.at <= now);
  const spoiledAts = recent.filter((request) => request.calls.some(spoils)).map((request) => request.at);
  // An undo older than the window resets nothing the window holds, as an older spoil does not.
  if (undone_at !== undefined && undone_at >= since) spoiledAts.push(undone_at);
  const spoiled_at = spoiledAts.length > 0 ? Math.max(...spoiledAts) : undefined;
  const clean = recent.filter((request) => (spoiled_at === undefined || request.at > spoiled_at)
    && request.held_runs > 0 && request.answered_runs >= request.held_runs
    && request.calls.length > 0 && request.calls.every(ranAsProposed));
  const support = new Map<string, { readonly occasions: Set<string>; readonly delete: boolean }>();
  for (const request of clean) {
    for (const call of request.calls) {
      if (call.signature_hash === null) continue;
      const entry = support.get(call.signature_hash) ?? { occasions: new Set<string>(), delete: call.delete };
      entry.occasions.add(request.occasion);
      support.set(call.signature_hash, entry);
    }
  }
  const supported = (wantDelete: boolean, threshold: number): string[] => [...support.entries()]
    .filter(([, entry]) => entry.delete === wantDelete && entry.occasions.size >= threshold)
    .map(([hash]) => hash)
    .sort();
  const times = clean.map((request) => request.at);
  return {
    occasions: new Set(clean.map((request) => request.occasion)).size,
    members: supported(false, CHAIN_SUGGEST_THRESHOLD),
    deletes: supported(true, CHAIN_DELETE_SUGGEST_THRESHOLD),
    ...(spoiled_at !== undefined ? { spoiled_at } : {}),
    ...(times.length > 0 ? { first_at: Math.min(...times), last_at: Math.max(...times) } : {}),
  };
};

/** One call of a suggestion or a rule, as the owner reads it. */
export interface ChainCallView {
  readonly signature_hash: string;
  /** Absent when it could not be opened (the vault locked, or its row gone). */
  readonly signature?: ChainCallSignature;
  /** The call's name as the owner knows it ("Add a task", "Send mail", "Update deal · HubSpot"),
   *  given by the server; absent when it has none. */
  readonly title?: string;
  /** How the owner knows the values the call names: an event by its title and when it is, a
   *  record by its title, as its approval card names them (`ApprovalValueLabels`), given by the
   *  server as the list is read. A suggestion read "Source ID: 54d0ecc0-…" (live, 2026-11-13).
   *  Display only; absent where none is known, and the value reads as it is. */
  readonly pin_labels?: import('./ask-detail-label.js').ApprovalValueLabels;
}

/** An open suggestion, as Contracts lists it. With a live rule for the key it is a longer chain
 *  (Q6) or its delete (Q7), and `rule_id` names the rule it would replace. */
export interface ChainSuggestionRow {
  readonly key_hash: string;
  /** The words the owner asked in, the latest time; absent when they could not be opened. */
  readonly words?: string;
  /** The calls the rule lets happen without asking: the rule's, and those learned since. */
  readonly members: readonly ChainCallView[];
  /** The deletes it would also let happen, offered on their own (Q7): only if the owner says so. */
  readonly deletes: readonly ChainCallView[];
  readonly evidence: ChainEvidence;
  readonly suggested_at: number;
  readonly rule_id?: string;
}

/** A minted rule. `uses_remaining` reaches 0, `expires_at` passes, or `revoked_at` is set: any of
 *  the three ends it. */
export interface ChainRuleRow {
  readonly rule_id: string;
  readonly key_hash: string;
  readonly words?: string;
  readonly members: readonly ChainCallView[];
  readonly deletes: readonly ChainCallView[];
  readonly created_at: number;
  readonly expires_at: number;
  readonly max_uses: number;
  readonly uses_remaining: number;
  readonly revoked_at?: number;
}

export const isChainRuleLive = (rule: Pick<ChainRuleRow, 'revoked_at' | 'uses_remaining' | 'expires_at'>, now: number): boolean =>
  rule.revoked_at === undefined && rule.uses_remaining > 0 && rule.expires_at > now;

/** D-348 §5.1 — whether a chain may ever stand in for the owner's answer to a held call. One check
 *  for the gates that consult a rule and for the evidence that builds one, so a call the gate would
 *  still ask about is never offered on a chain. Never past an action set to "always ask" (its
 *  approval before any lift), never in place of a review given each time or any other lift, never a
 *  browser batch that puts one of the owner's files into a page (asked about every time), and never
 *  a hold that does not say why it asked. A delete's `always` is its tier's floor, not a setting:
 *  Q7's own rule decides it (5 occasions, over records its run found). */
export const chainMayStandIn = (call: {
  readonly slug: string;
  readonly risk_tier?: string;
  readonly provenance?: AuthorizationProvenance;
  readonly args: unknown;
}): boolean => {
  const { provenance } = call;
  if (provenance === undefined || provenance.lift_reason !== undefined) return false;
  if (stripCorePrefix(call.slug) === 'dom-act' && browserActCallUploads(call.args)) return false;
  return call.risk_tier === 'destructive'
    || provenance.pre_lift_approval === 'never' || provenance.pre_lift_approval === 'ask';
};

/** D-348 slice 5 — what a gate hands the host about a call it would hold, for the host to ask
 *  whether the rule for the request its run was made for holds it. */
export interface ChainRuleAdmission {
  readonly slug: string;
  /** A catalog op's qualified id, as the catalog gate resolved it. Absent at the commit gateway. */
  readonly operation_id?: string;
  /** D-348 slice 6 — a catalog op's own name in its pack (`deal.delete`): its record's kind is its
   *  first part. Absent at the commit gateway. */
  readonly operation_key?: string;
  /** The account the call goes out on, as the gate records it on the call's hold. */
  readonly connection_name?: string;
  readonly risk_tier: import('./ingredient.js').RiskTier;
  /** The call's arguments as the gate resolved them: what its pins are read from. */
  readonly args: Readonly<Record<string, unknown>>;
  /** D-348 slice 6 — the record a delete deletes: its argument its operation declares as the
   *  record's (D-254 `record_id_arg`), as the gate resolved it. Absent when it declares none, and
   *  then no rule lets the delete through (Q7). */
  readonly record_id?: string;
}

/** D-348 slice 6 — a read the catalog gate made for a run a rule may stand in for, and the records
 *  it returned: the only ones a delete on the rule may name (Q7, "a record the chain's own reads
 *  returned in that run; never one named another way"). */
export interface ChainRuleRead {
  readonly slug: string;
  /** The read's own name in its pack (`deal.search`): its records' kind is its first part. */
  readonly operation_key: string;
  readonly connection_name?: string;
  /** The arguments it was sent with: a record they named, it did not find. */
  readonly args: Readonly<Record<string, unknown>>;
  /** The ids of the records it returned, read where the gate reads them for its caller (the
   *  records at the operation's records path, each by its `id`). */
  readonly record_ids: readonly string[];
}

/** D-348 slice 6b — a call the commit gateway dispatched for a run a rule may stand in for, and
 *  what it returned. Recued's own reads go through it, and declare no records path: the host reads
 *  the records of the ones on its closed list (`ownReadRecords`). */
export interface ChainRuleReturn {
  readonly slug: string;
  /** The arguments it was sent with, as the gate resolved them. */
  readonly args: Readonly<Record<string, unknown>>;
  readonly result: unknown;
}

/** The host's answer: the rule that stood in for the ask (a use spent), or null to ask. */
export interface ChainRuleHooks {
  admit: (call: ChainRuleAdmission) => string | null;
  /** D-348 slice 6 — told of each read the catalog gate made and the records it returned; the host
   *  keeps them as found. Never fails the read. */
  found?: (read: ChainRuleRead) => void;
  /** D-348 slice 6b — told what each call the commit gateway dispatched returned; the host keeps
   *  the records a read on its closed list found. Never fails the call. */
  returned?: (call: ChainRuleReturn) => void;
}
