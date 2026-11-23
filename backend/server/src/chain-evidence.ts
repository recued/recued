/** D-348 — where the chain evidence meets the turns and the holds.
 *
 *  A turn of the owner's chats opens its request (`openChainRequest`), or joins the request of the
 *  turn it continues (D-337); a call the turn holds for approval is noted as the request's
 *  (`noteChainHeldRun`); the resumer keeps the owner's answer with the call's signature
 *  (`recordChainAnswer`) and its outcome when the run settles (`recordChainOutcome`); an undo of a
 *  change the run made is kept when the owner undoes it (`recordChainUndo`). The store is
 *  `storage/chain-evidence-store.ts`.
 *
 *  ⚠ LEARNING NEVER COSTS THE WORK. Each writer here is logged and swallowed when it fails: a
 *  chain not learned is friction (the next call asks), never harm. */

import {
  type ChainCallSignature,
  type ChainRuleAdmission,
  type ChainRuleHooks,
  type ChainRuleRead,
  chainCallSignatureHash,
  chainRequestKeyHash,
  normalizeChainRequestWords,
  writeRuleOccasionOf,
  writeRulePrincipalOf,
  type ChainCallOutcome,
  type Checkpoint,
  type ExecutionSource,
  type IngredientManifest,
} from '@recued/contracts';

import type { PreflightNotifier } from '@recued/gateway';
import type { AuditLogStore } from '@recued/storage';

import {
  chainCallSignatureOf, chainRawOpSignature, chainStepSignature, chainTier1Signature, type ChainSignatureContext,
} from './chain-signature.js';
import { namedIn, ownDeleteRecord, ownReadRecords } from './chain-own-records.js';
import { ownerEditsFor } from './chat-plan-edits.js';
import type { PreflightRunSettled } from './preflight-resumer.js';
import type { ChainEvidenceStore } from './storage/chain-evidence-store.js';
import type { ChainRuleStore } from './storage/chain-rule-store.js';

/** What the resumer's hooks read: the evidence, the learner, and where the owner is told. */
export interface ChainDeps {
  readonly chainEvidence?: ChainEvidenceStore;
  readonly chainRules?: ChainRuleStore;
  readonly preflightNotifier?: Pick<PreflightNotifier, 'notify'>;
  readonly now?: () => number;
  /** D-348 slice 6 — the installed manifests, for the record a pack action's delete names. */
  readonly executorConfig?: { readonly manifests: { get(slug: string): IngredientManifest | null | undefined } };
}

/** D-348 slice 6 — the record argument a pack action's delete declares (D-254 `record_id_arg`), from
 *  its installed catalog: by its operation's key, or by its qualified id as a recipe's hold names it. */
const chainSignatureContextOf = (deps: ChainDeps | undefined): ChainSignatureContext => ({
  deleteRecordArg: (slug, operation) => {
    const operations = deps?.executorConfig?.manifests.get(slug)?.operations;
    if (operations === undefined) return undefined;
    const op = operations[operation]
      ?? Object.values(operations).find((candidate) => candidate?.operation_id === operation);
    const arg = op?.record_id_arg;
    return typeof arg === 'string' && arg.length > 0 ? arg : undefined;
  },
});

/** The turn state key the turn's request is kept under, for its holds to find. */
export const CHAIN_REQUEST_STATE_KEY = 'd348.chain_request';

const warn = (what: string, error: unknown): void => {
  console.warn(`[chains] ${what}: ${error instanceof Error ? error.message : String(error)}`);
};

/** Q5 — only the owner's own chats teach: the app's chat and the messenger chats, as the owner
 *  (`user_self`, no contract). Not a scheduled prompt (`schedule`), not an AI app. */
export const teachesChains = (source: ExecutionSource): boolean =>
  writeRulePrincipalOf(source)?.kind === 'owner_chat';

/** The request a turn is part of, kept in its state. A request the owner's words open is written
 *  only once the turn holds a call (`pending`), so a turn that holds nothing leaves no row. */
export interface TurnChainRequest {
  readonly request_id: string;
  /** Its key (its words, normalized and hashed): what a chain rule is matched under (slice 4).
   *  Absent for a continuation of a request no row was kept for. */
  readonly key_hash?: string;
  pending?: { readonly session_id: string; readonly words: string; readonly occasion: string; readonly at: number };
}

/** The request a turn is part of: one the owner's words open, or, for a turn that continues another
 *  (a held call's conversation carried on, D-337, or the owner's own "carry on"), the request of
 *  the turn it continues, so a reply like "go ahead" is never a request of its own. Undefined when
 *  the turn is part of none: another source, words that normalize to nothing, a continuation of a
 *  turn that made no request. */
export const openChainRequest = (
  store: ChainEvidenceStore | undefined,
  turn: {
    readonly session_id: string;
    readonly turn_id: string;
    readonly source: ExecutionSource;
    /** The owner's words, for a turn they opened. */
    readonly words?: string;
    /** The turn this one continues. */
    readonly continuation_of_turn_id?: string;
    readonly at: number;
  },
): TurnChainRequest | undefined => {
  if (store === undefined || !teachesChains(turn.source)) return undefined;
  try {
    if (turn.continuation_of_turn_id !== undefined) {
      const request_id = store.requestOfTurn(turn.continuation_of_turn_id);
      if (request_id === undefined) return undefined;
      store.joinTurn(turn.turn_id, request_id);
      const key_hash = store.keyOfRequest(request_id);
      return key_hash !== undefined ? { request_id, key_hash } : { request_id };
    }
    const normalized = turn.words === undefined ? '' : normalizeChainRequestWords(turn.words);
    if (turn.words === undefined || normalized === '') return undefined;
    return {
      request_id: turn.turn_id,
      key_hash: chainRequestKeyHash(normalized),
      pending: {
        session_id: turn.session_id,
        words: turn.words,
        occasion: writeRuleOccasionOf(turn.source, turn.at),
        at: turn.at,
      },
    };
  } catch (error) {
    warn('a request was not opened', error);
    return undefined;
  }
};

/** A call of the turn's request was held for the owner's approval, as this run. The request is
 *  written first, if this is its first held call; its turn joins it at once, so a continuation of
 *  the turn finds it. */
export const noteChainHeldRun = (
  store: ChainEvidenceStore | undefined,
  turn_state: Map<string, unknown> | undefined,
  run_id: string | undefined,
  at: number,
): void => {
  const request = turn_state?.get(CHAIN_REQUEST_STATE_KEY) as TurnChainRequest | undefined;
  if (store === undefined || request === undefined || run_id === undefined) return;
  try {
    const pending = request.pending;
    if (pending !== undefined) {
      delete request.pending;
      void store.openRequest({ request_id: request.request_id, ...pending })
        .catch((error) => warn('a request was not kept', error));
    }
    store.heldRun({ run_id, request_id: request.request_id, at });
  } catch (error) {
    warn(`held run ${run_id} was not noted`, error);
  }
};

/** §7.8 — a call of the turn's request that a permission let through without asking (`ref`, its
 *  own row), or a run the turn started that held nothing (`ref`, its id): noted with the request's
 *  key, so an undo of a change it made resets the request (Q4), though no hold recorded it. */
export const noteChainUnheld = (
  store: ChainEvidenceStore | undefined,
  turn_state: Map<string, unknown> | undefined,
  input: { readonly ref: string | undefined; readonly session_id: string; readonly at: number },
): void => {
  const request = turn_state?.get(CHAIN_REQUEST_STATE_KEY) as TurnChainRequest | undefined;
  if (store === undefined || request?.key_hash === undefined || input.ref === undefined) return;
  try {
    store.unheldRef({ ref: input.ref, key_hash: request.key_hash, session_id: input.session_id, at: input.at });
  } catch (error) {
    warn(`${input.ref} was not noted`, error);
  }
};

/** Whether the owner changed a held call before approving it: a chat write by the fields its card
 *  lets the owner change (as D-329 reads it), any other call by any change at all. */
const changedBeforeApproving = (checkpoint: Checkpoint): boolean => {
  const tool = checkpoint.raw_op?.tier1_tool;
  if (tool !== undefined) return ownerEditsFor(tool, checkpoint.arg_overrides) !== undefined;
  const overrides = checkpoint.arg_overrides;
  return overrides !== null && typeof overrides === 'object' && Object.keys(overrides).length > 0;
};

/** The owner's words as a notice quotes them, cut at 80 characters. */
const quoted = (words: string | undefined): string => (words === undefined ? 'the same thing'
  : `"${words.length > 80 ? `${words.slice(0, 79).trimEnd()}…` : words}"`);

/** The owner, told once, when a request's suggestion opens or grows. */
export const chainRuleSuggestedNotice = (words: string | undefined): { title: string; text: string } => ({
  title: 'A rule Recued suggests: a request you repeat',
  text: `When you ask ${quoted(words)}, you have approved what it does again and again this month. You can `
    + 'let it happen without asking, for up to 30 days: see Rules Recued suggests, under Contracts. '
    + 'Until you do, it keeps asking.',
});

/** The owner, told once an undo ended the rule for a request they repeat. */
export const chainRuleEndedByUndoNotice = (words: string | undefined): { title: string; text: string } => ({
  title: 'A rule ended because you undid a change',
  text: `You undid a change made when you asked ${quoted(words)}. The rule that let that run without `
    + 'asking has ended, so Recued asks again. It may suggest the rule again after you approve it on '
    + 'three more days.',
});

/** Learn from the request a run was held for, and tell the owner when its suggestion opens. */
const learnForRun = (deps: ChainDeps, run_id: string, now: number): void => {
  const rules = deps.chainRules;
  if (rules === undefined) return;
  let learned: ReturnType<ChainRuleStore['learnForRun']>;
  try {
    learned = rules.learnForRun(run_id, now);
  } catch (error) {
    warn(`run ${run_id} taught nothing`, error);
    return;
  }
  const notifier = deps.preflightNotifier;
  if (!learned.suggested || learned.key_hash === undefined || notifier === undefined) return;
  const key_hash = learned.key_hash;
  void (async () => {
    const words = await rules.wordsOf(key_hash).catch(() => undefined);
    await notifier.notify(chainRuleSuggestedNotice(words));
  })().catch(() => undefined);
};

/** Keep the owner's answer to a held call, with what the call is. A call no request of the owner's
 *  chats held is not kept. Awaited by the resumer before the run settles, so the outcome that
 *  follows finds the answer. A refusal needs no learning of its own: the suggestions are listed
 *  and accepted from the evidence read again, and the next outcome learns from it. */
export const recordChainAnswer = async (
  deps: ChainDeps | undefined,
  checkpoint: Checkpoint,
  answer: 'approved' | 'refused',
): Promise<void> => {
  const store = deps?.chainEvidence;
  if (store === undefined) return;
  try {
    if (store.requestOfRun(checkpoint.run_id) === undefined) return;
    let signature: ReturnType<typeof chainCallSignatureOf>;
    try { signature = chainCallSignatureOf(checkpoint, chainSignatureContextOf(deps)); } catch { signature = undefined; }
    await store.recordAnswer({
      checkpoint_id: checkpoint.checkpoint_id,
      run_id: checkpoint.run_id,
      ...(signature !== undefined ? { signature } : {}),
      answer: answer === 'approved' && changedBeforeApproving(checkpoint) ? 'approved_changed' : answer,
      at: (deps?.now ?? Date.now)(),
    });
  } catch (error) {
    warn(`the answer to run ${checkpoint.run_id} was not kept`, error);
  }
};

/** How a settled run ended, for the calls of it the owner approved. A refusal is its answer and
 *  ends nothing here. ⛔ A run that stopped again for another approval (a later step's) has not
 *  ended, though it comes back `success: false`: its calls take the outcome it ends with. */
export const chainOutcomeOfSettled = (
  settled: Pick<PreflightRunSettled, 'result' | 'state'>,
): ChainCallOutcome | undefined => {
  const result = settled.result !== null && typeof settled.result === 'object'
    ? settled.result as { success?: unknown; denied?: unknown; awaiting_approval?: unknown; awaiting_peer?: unknown }
    : {};
  if (result.denied === true) return undefined;
  if (result.awaiting_approval === true || result.awaiting_peer === true) return undefined;
  if (settled.state === 'interrupted') return 'unknown';
  if (settled.state === 'succeeded') return 'ran';
  if (settled.state === 'failed') return 'failed';
  if (result.success === true) return 'ran';
  if (result.success === false) return 'failed';
  return 'unknown';
};

/** Keep how a held run ended, then learn from its request. */
export const recordChainOutcome = (
  deps: ChainDeps | undefined,
  settled: PreflightRunSettled,
): void => {
  const store = deps?.chainEvidence;
  if (store === undefined) return;
  const outcome = chainOutcomeOfSettled(settled);
  if (outcome === undefined) return;
  try {
    store.runSettled(settled.run_id, outcome, settled.ts);
  } catch (error) {
    warn(`the outcome of run ${settled.run_id} was not kept`, error);
    return;
  }
  // Judged on the server's clock, as the request was stamped: the settle stamp is the resumer's.
  learnForRun(deps!, settled.run_id, (deps!.now ?? Date.now)());
};

/** A live rule an undo ended (`recordChainUndo`), for the owner to be told once the undo is done. */
export interface ChainRuleEndedByUndo {
  readonly rule_id: string;
  readonly key_hash: string;
  readonly uses_remaining: number;
  readonly at: number;
}

/** Q4 — the owner undid a change a held run made: kept with when, on the server's clock, so
 *  nothing its request's key did before then counts. As a refusal, it needs no learning of its
 *  own: suggestions are listed and accepted from the evidence read again, and the key's next
 *  outcome learns from it. The request's live rule ends too when it holds the call that made the
 *  change (not for good: `endForUndo`), and is returned for the owner to be told
 *  (`tellChainRuleEndedByUndo`). A change no hold recorded resets its request all the same: the
 *  request's rule that made it ends (`endRuleForUndo`); one another permission let through is
 *  found by what made it (`noteChainUnheld`), and no rule ends, no hold having named its call.
 *  Called inside the undo's own transaction, so all are kept together. */
export const recordChainUndo = (
  deps: Pick<ChainDeps, 'chainEvidence' | 'chainRules' | 'now'> | undefined,
  input: {
    /** The run the change was made in; a chat's own write a permission let through has none. */
    readonly run_id?: string;
    readonly receipt_id: string;
    readonly checkpoint_id?: string;
    /** The rule that made the change without asking, when its commit names one. */
    readonly chain_rule_id?: string;
    /** A chat's own write a permission let through: its call. */
    readonly chat_call_id?: string;
  },
): ChainRuleEndedByUndo | undefined => {
  const store = deps?.chainEvidence;
  const rules = deps?.chainRules;
  const at = (deps?.now ?? Date.now)();
  let undone: ReturnType<ChainEvidenceStore['runUndone']>;
  try {
    undone = input.run_id === undefined ? undefined : store?.runUndone({ run_id: input.run_id, receipt_id: input.receipt_id,
      ...(input.checkpoint_id !== undefined ? { checkpoint_id: input.checkpoint_id } : {}), at });
  } catch (error) {
    warn(`the undo of run ${input.run_id} was not kept`, error);
    undone = undefined;
  }
  if (rules !== undefined) {
    try {
      // Made by a rule without asking: that rule, and its request though it held nothing. A chat's
      // own write names its rule by its call.
      const ruleId = input.chain_rule_id ?? (input.chat_call_id !== undefined ? rules.ruleOfCall(input.chat_call_id) : undefined);
      if (ruleId !== undefined) {
        const ended = rules.endRuleForUndo(ruleId, input.receipt_id, at);
        return ended === undefined ? undefined : { ...ended, at };
      }
      if (undone?.key_hash !== undefined) {
        const ended = rules.endForUndo(undone.key_hash, undone.signature_hashes, at);
        return ended === undefined ? undefined : { ...ended, key_hash: undone.key_hash, at };
      }
    } catch (error) {
      warn(`the rule for ${input.run_id ?? input.chat_call_id ?? 'a change'} was not ended`, error);
      return undefined;
    }
  }
  // Neither a held run's nor a rule's (each returned above): a change another permission let
  // through without asking. Its request, if a request of the owner's chats made it, is reset as
  // of the undo.
  const ref = input.chat_call_id ?? input.run_id;
  if (undone === undefined && ref !== undefined) {
    try {
      store?.unheldUndone({ ref, receipt_id: input.receipt_id, at });
    } catch (error) {
      warn(`the undo of ${ref} was not kept`, error);
    }
  }
  return undefined;
};

/** Once the undo is done: the owner told that it ended the rule for their request, and the end
 *  audited `chain_rule_revoked` as an End is, by its counts (`ended_by: 'undo'`). */
export const tellChainRuleEndedByUndo = (
  deps: (Pick<ChainDeps, 'chainRules' | 'preflightNotifier'>
    & { readonly auditLog?: Pick<AuditLogStore, 'logActivity'> }) | undefined,
  ended: ChainRuleEndedByUndo,
): void => {
  void deps?.auditLog?.logActivity({
    activity_id: '', timestamp: ended.at, action: 'chain_rule_revoked', target: ended.rule_id,
    detail: JSON.stringify({ key_hash: ended.key_hash, uses_remaining: ended.uses_remaining, ended_by: 'undo' }),
  }).catch(() => undefined);
  const rules = deps?.chainRules;
  const notifier = deps?.preflightNotifier;
  if (rules === undefined || notifier === undefined) return;
  void (async () => {
    const words = await rules.wordsOf(ended.key_hash).catch(() => undefined);
    await notifier.notify(chainRuleEndedByUndoNotice(words));
  })().catch(() => undefined);
};

/** D-348 slice 4 — spend one use of the chain rule a chat write is on, when the turn's request has
 *  one: the write then runs without asking. Undefined when none applies (no request, no live rule
 *  for its key, a write not on it, one the owner is asked about every time); a store that fails
 *  is "ask", never "allow". */
export const useChainRuleForTier1 = (
  rules: ChainRuleStore | undefined,
  turn_state: Map<string, unknown> | undefined,
  tool: string,
  args: unknown,
  now: number,
): ReturnType<ChainRuleStore['use']> => {
  const request = turn_state?.get(CHAIN_REQUEST_STATE_KEY) as TurnChainRequest | undefined;
  if (rules === undefined || request?.key_hash === undefined) return undefined;
  const signature = chainTier1Signature(tool, args);
  if (signature === undefined) return undefined;
  try {
    return rules.use(request.key_hash, chainCallSignatureHash(signature), now);
  } catch (error) {
    warn(`the chain rule for '${tool}' could not be read`, error);
    return undefined;
  }
};

/** D-348 slice 5 — the key of the request a turn is part of, for a run the turn starts to carry
 *  (`InternalExecuteOverrides.chain_request_key`). Undefined outside a request. */
export const chainRequestKeyOf = (turn_state: Map<string, unknown> | undefined): string | undefined =>
  (turn_state?.get(CHAIN_REQUEST_STATE_KEY) as TurnChainRequest | undefined)?.key_hash;

/** D-348 slice 6 — the request a turn is part of, with its key, for a pack action the turn calls
 *  directly: its reads and its deletes are the request's. Undefined outside a keyed request. */
export const chainRequestOf = (
  turn_state: Map<string, unknown> | undefined,
): { readonly key_hash: string; readonly request_id: string } | undefined => {
  const request = turn_state?.get(CHAIN_REQUEST_STATE_KEY) as TurnChainRequest | undefined;
  return request?.key_hash !== undefined ? { key_hash: request.key_hash, request_id: request.request_id } : undefined;
};

/** D-348 slice 6 — what a run's (or a request's) reads found: each record by its pack, account and
 *  kind (`deal`) as well as its id, since a vendor numbers each kind of record and each account
 *  apart. What a delete on a rule may name (Q7). */
export interface ChainFound {
  add(read: ChainRuleRead): void;
  has(call: Pick<ChainRuleAdmission, 'slug' | 'connection_name' | 'operation_key'>, record_id: string): boolean;
  /** Slice 6b — Recued's own records a read on the closed list found (`ownReadRecords`). */
  addOwn(records: readonly string[]): void;
  hasOwn(record: string): boolean;
}

/** Most records one run or request keeps as found; past it, nothing more is (a delete then asks). */
export const CHAIN_FOUND_MAX = 10_000;

const foundKindOf = (slug: string, connection_name: string | undefined, operation_key: string): string =>
  `${slug}\u0000${connection_name ?? ''}\u0000${operation_key.split('.')[0] ?? ''}`;

export const createChainFound = (): ChainFound => {
  const found = new Set<string>();
  const own = (record: string): string => `own\u0000${record}`;
  return {
    add(read) {
      // A record the read's own arguments named, it did not find: a read of deal 9001 finds nothing.
      const named = namedIn(read.args);
      const kind = foundKindOf(read.slug, read.connection_name, read.operation_key);
      for (const id of read.record_ids) {
        if (found.size >= CHAIN_FOUND_MAX) return;
        if (!named.has(id.trim().toLowerCase())) found.add(`${kind}\u0000${id}`);
      }
    },
    has: (call, record_id) => call.operation_key !== undefined
      && found.has(`${foundKindOf(call.slug, call.connection_name, call.operation_key)}\u0000${record_id}`),
    addOwn(records) {
      for (const record of records) {
        if (found.size >= CHAIN_FOUND_MAX) return;
        found.add(own(record));
      }
    },
    hasOwn: (record) => found.has(own(record)),
  };
};

/** Requests kept per rule store (one per server): a request's direct calls are each a dispatch of
 *  their own, so what its reads found is kept for the request, across its turns, in this process
 *  only. A server restarted between a read and its delete has none, and the delete asks. */
const FOUND_REQUESTS_MAX = 256;
const foundByRules = new WeakMap<object, Map<string, ChainFound>>();

/** D-348 slice 6 — what the reads of a request's direct calls found. */
export const chainFoundOfRequest = (rules: object, request_id: string): ChainFound => {
  let requests = foundByRules.get(rules);
  if (requests === undefined) {
    requests = new Map();
    foundByRules.set(rules, requests);
  }
  let found = requests.get(request_id);
  if (found === undefined) {
    found = createChainFound();
    requests.set(request_id, found);
    const oldest = requests.keys().next().value;
    if (requests.size > FOUND_REQUESTS_MAX && oldest !== undefined) requests.delete(oldest);
  }
  return found;
};

/** The gates' hook over one request's rule: a held call whose signature is on it goes ahead without
 *  asking, spending a use, audited `chain_rule_used` under `target`. A delete, only of the record
 *  its operation names when a read of the same run (or request) found it (Q7). A call it cannot
 *  name, or a store that fails, is "ask". */
const chainRuleAdmission = (deps: {
  readonly rules: ChainRuleStore;
  readonly key_hash: string;
  readonly signatureOf: (call: ChainRuleAdmission) => ChainCallSignature | undefined;
  readonly target: (call: ChainRuleAdmission) => string;
  readonly found: ChainFound;
  readonly auditLog?: Pick<AuditLogStore, 'logActivity'>;
  readonly now?: () => number;
}): ChainRuleHooks => ({
  admit(call) {
    const signature = deps.signatureOf(call);
    if (signature === undefined) return null;
    // ⛔ Checked before a use is spent: a delete that names no record, or one no read found, asks. A
    // pack's delete names its record (`record_id`); Recued's own, by the closed list (slice 6b).
    if (call.risk_tier === 'destructive') {
      const own = call.record_id === undefined ? ownDeleteRecord(call.slug, call.args) : undefined;
      const found = call.record_id !== undefined
        ? deps.found.has(call, call.record_id)
        : own !== undefined && deps.found.hasOwn(own);
      if (!found) return null;
    }
    const now = (deps.now ?? Date.now)();
    let used: ReturnType<ChainRuleStore['use']>;
    try {
      used = deps.rules.use(deps.key_hash, chainCallSignatureHash(signature), now);
    } catch (error) {
      warn(`the chain rule for '${call.slug}' could not be read`, error);
      return null;
    }
    if (used === undefined) return null;
    void deps.auditLog?.logActivity({
      activity_id: '', timestamp: now, action: 'chain_rule_used', target: deps.target(call),
      detail: JSON.stringify({ rule_id: used.rule_id, uses_remaining: used.uses_remaining, delete: used.delete }),
    }).catch(() => undefined);
    return used.rule_id;
  },
  found(read) {
    deps.found.add(read);
  },
  returned(call) {
    deps.found.addOwn(ownReadRecords(call.slug, call.args, call.result));
  },
});

/** D-348 slice 5 — the gates' hook for a run the owner's chat started: a held call on the rule for
 *  its request goes ahead without asking, spending a use, audited `chain_rule_used`
 *  (`<run>:<slug>`). The run carries its request's key from the turn that started it; a run resumed
 *  after an approval carries none and asks, as does any other caller's. */
export const createChainRuleAdmission = (deps: {
  readonly rules: ChainRuleStore;
  readonly key_hash: string;
  readonly run_id: string;
  readonly recipe_id: string;
  readonly recipe_source_hash: string;
  readonly auditLog?: Pick<AuditLogStore, 'logActivity'>;
  readonly now?: () => number;
}): ChainRuleHooks => chainRuleAdmission({
  ...deps,
  // The run's own reads: a delete of a record another run found asks.
  found: createChainFound(),
  signatureOf: (call) => chainStepSignature({
    recipe_id: deps.recipe_id,
    recipe_source_hash: deps.recipe_source_hash,
    ingredient: call.slug,
    ...(call.operation_id !== undefined ? { operation_id: call.operation_id } : {}),
    ...(call.connection_name !== undefined ? { connection_name: call.connection_name } : {}),
    destructive: call.risk_tier === 'destructive',
    args: call.args,
  }),
  target: (call) => `${deps.run_id}:${call.slug}`,
});

/** D-348 slice 5 — the same for a pack action the owner's chat called directly (a raw op), whose
 *  hold names it by its catalog, the pack's own name for the operation and its connection
 *  (`chainRawOpSignature`). The gate is asked about this one call only; a call it names otherwise
 *  (another catalog, another operation) is not this one, and asks. Audited under `target`
 *  (`<session>:<turn>:<tool>`, as a chat write is). */
export const createRawOpChainRuleAdmission = (deps: {
  readonly rules: ChainRuleStore;
  readonly key_hash: string;
  readonly catalog_slug: string;
  /** The pack's own name for the operation (`deal.update`), as the hold records it. */
  readonly operation: string;
  /** Its qualified id, as the gate resolves it (`recued-core/hubspot-catalog.deal.update`). */
  readonly operation_id: string;
  readonly connection_name: string;
  readonly target: string;
  /** What the request's direct calls' reads found (`chainFoundOfRequest`). */
  readonly found: ChainFound;
  readonly auditLog?: Pick<AuditLogStore, 'logActivity'>;
  readonly now?: () => number;
}): ChainRuleHooks => chainRuleAdmission({
  ...deps,
  signatureOf: (call) => (call.slug !== deps.catalog_slug || call.operation_id !== deps.operation_id
    || (call.connection_name ?? '') !== deps.connection_name
    ? undefined
    : chainRawOpSignature({
        catalog_slug: deps.catalog_slug,
        operation: deps.operation,
        connection_name: deps.connection_name,
        destructive: call.risk_tier === 'destructive',
        args: call.args,
      })),
  target: () => deps.target,
});
