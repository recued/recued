/** D-138 Phase 1 — `contact.merge.*` rpc handlers.
 *
 *  Six methods covering the cross-platform reconciliation flow.
 *  All are local-UI / user-action only — registered here as normal
 *  WS-rpc handlers, but excluded from the MCP catalog by construction
 *  (see `packages/contracts/src/mcp-tool-catalog.ts` ratchet).
 *
 *  - `contact.merge.list` — read pending / merged / rejected
 *    candidates with pagination
 *  - `contact.merge.confirm` — survivor absorbs loser(s); annotations
 *    + links rewrite; cascade fires
 *  - `contact.merge.reject` — write rejection rows for the surfaced
 *    candidate edges
 *  - `contact.merge.split` — reverse a merge, redistribute platform
 *    ids, write durable rejection
 *  - `contact.merge.undo_rejection` — power-user rejection removal
 *    (Settings → Contacts → Rejected pairs)
 *  - `contact.merge.resolve_remerge_prompt` — A.10 follow-up; the
 *    prompt store is wired via housekeeping (P3) so the handler
 *    surfaces `not_configured` when the cycle hasn't run yet
 *
 *  Spec: D-138 § A.6, § A.8, § Contract Tightening. */

import { randomUUID } from 'node:crypto';

import {
  RpcError,
  canonicalizeEmail,
  type ContactMergeCandidate,
  type ContactMergeScanMode,
  type ContactRecord,
  type HandlerSlice,
  type PlatformIdEntry,
  type RemergePromptResolution,
  type ServerRpcRegistry,
} from '@recued/contracts';
import type { WsClient } from './ws-server.js';
import type { AnnotationStore } from './storage/annotation-store.js';
import type { ContactStore } from './storage/contact-store.js';

/** A.10 prompt store — substrate placeholder at P1; the concrete
 *  implementation lands in `contact-merge-prompt-store.ts` at P3
 *  (`createRemergePromptStore` returns a store satisfying this
 *  interface plus a `record` + `pending` extension on the
 *  `ServerRemergePromptStore` shape). The handler surface here
 *  consumes only the read+resolve subset so tests can inject mocks
 *  without taking the SQLite dependency. */
export interface RemergePromptStore {
  /** Resolve a prompt by id. Returns null when the id is unknown. */
  get(id: string): RemergePromptRow | null;
  /** Mark a prompt resolved + record the user's choice. */
  resolve(id: string, resolution: RemergePromptResolution, resolved_at: number): void;
}

export interface RemergePromptRow {
  id: string;
  affected_email: string;
  partner_email: string;
  vendor: string;
  fired_at: number;
}

/** D-138 P3 — bag of stats returned from the housekeeping scheduler
 *  to the rpc handler. The handler synthesises an `iterated` /
 *  `surfaced_count` / `yield_reason` triple from this for the rpc
 *  response. The cycle observer + scan-progress bus emits already
 *  cover real-time updates; this struct is just the post-cycle
 *  summary the rpc closes the round-trip with. */
export interface ContactMergeScanRunResult {
  iterated: number;
  surfaced_count: number;
  yield_reason?: 'budget_exhausted' | 'no_work';
}

/** D-138 P3 — closure handed to the rpc handler that runs the scan
 *  task on the live housekeeping scheduler. The boot wire late-binds
 *  the closure against the scheduler ref + the contact-store cursor
 *  reset path; tests pass a stub.
 *
 *  The closure is responsible for:
 *    - Resetting `housekeeping_state` cursor for the scan task to 0
 *      when `mode === 'full'`.
 *    - Calling `housekeepingScheduler.runOnce({ task_id: ... })`.
 *    - Returning the scan's iteration / surfaced counts. */
export type RunContactMergeScan = (input: {
  mode: ContactMergeScanMode;
}) => Promise<ContactMergeScanRunResult>;

export interface ContactMergeRpcDeps {
  contactStore: ContactStore;
  annotationStore?: AnnotationStore;
  promptStore?: RemergePromptStore;
  /** Optional D-136 cascade hook fired after every confirmed merge
   *  (and reverse-fired on split). The boot wire injects the real
   *  cascade engine; tests pass a no-op or recorder. */
  onIdentityChanged?: (input: {
    survivor_email: string;
    loser_emails: string[];
  }) => void;
  /** Optional broadcast bus emit for queue mutations + A.10 prompts.
   *  Boot wire passes the real bus; tests pass a recorder. */
  emitMergeCandidate?: (subkind: 'inserted' | 'resolved', candidate: ContactMergeCandidate) => void;
  /** D-138 P3 — `contact.merge.scan_now` rpc backend. Optional —
   *  absent → the rpc surfaces `not_configured` (e.g. dbless harness
   *  without a housekeeping scheduler). */
  runScanNow?: RunContactMergeScan;
  now?: () => number;
  /** ULID factory — defaults to `randomUUID`. */
  newId?: () => string;
}

const requireResolved = (deps: ContactMergeRpcDeps, email: string): ContactRecord => {
  const { canonical_email } = deps.contactStore.resolveCanonicalEmail(email);
  const row = deps.contactStore.get(canonical_email);
  if (!row) {
    throw new RpcError('not_found', `contact.merge: contact ${email} (canonical ${canonical_email}) not found`);
  }
  return row;
};

export const handleContactMergeList = async (
  deps: ContactMergeRpcDeps,
  args: { status?: 'pending' | 'merged' | 'rejected'; limit?: number; cursor?: string } | undefined,
): Promise<{ candidates: ContactMergeCandidate[]; next_cursor?: string }> => {
  const query: Parameters<ContactStore['listMergeCandidates']>[0] = {};
  if (args?.status !== undefined) query.status = args.status;
  if (args?.limit !== undefined) query.limit = args.limit;
  if (args?.cursor !== undefined) query.cursor = args.cursor;
  return deps.contactStore.listMergeCandidates(query);
};

export const handleContactMergeConfirm = async (
  deps: ContactMergeRpcDeps,
  args: { candidate_ids: string[]; survivor_email: string },
): Promise<{ survivor: ContactRecord; losers: ContactRecord[] }> => {
  if (!Array.isArray(args.candidate_ids) || args.candidate_ids.length === 0) {
    throw new RpcError('bad_request', 'contact.merge.confirm: candidate_ids must be a non-empty array');
  }
  const survivorCanonical = canonicalizeEmail(args.survivor_email);
  if (!survivorCanonical) {
    throw new RpcError('bad_request', `contact.merge.confirm: invalid survivor_email '${args.survivor_email}'`);
  }
  const survivor = deps.contactStore.get(survivorCanonical);
  if (!survivor) {
    throw new RpcError('not_found', `contact.merge.confirm: survivor ${survivorCanonical} not found`);
  }
  if (survivor.merged_into) {
    throw new RpcError(
      'bad_request',
      `contact.merge.confirm: survivor ${survivorCanonical} is itself merged into ${survivor.merged_into}; resolve identity first`,
    );
  }

  // Load every candidate row + assert pending.
  const candidates: ContactMergeCandidate[] = [];
  for (const id of args.candidate_ids) {
    const cand = deps.contactStore.getMergeCandidate(id);
    if (!cand) {
      throw new RpcError('not_found', `contact.merge.confirm: candidate ${id} not found`);
    }
    if (cand.status !== 'pending') {
      throw new RpcError(
        'conflict',
        `contact.merge.confirm: candidate ${id} status=${cand.status}; only pending candidates may merge`,
      );
    }
    candidates.push(cand);
  }

  // D-138 P1 (codex review fix) — verify the candidate-graph
  // connected component anchored on `survivor_email` covers every
  // candidate edge. A buggy / stale client could otherwise pass
  // `candidate_ids` whose pairs don't touch the survivor (e.g. a
  // candidate over `(b, c)` while choosing `a` as survivor) and the
  // handler would silently merge unrelated contacts. We BFS over
  // the candidate edges starting from the survivor — every loser
  // discovered through the walk is a legitimate part of the merge;
  // any candidate edge that doesn't reach the survivor through the
  // walk is rejected.
  const adjacency = new Map<string, ContactMergeCandidate[]>();
  for (const cand of candidates) {
    if (!adjacency.has(cand.email_a)) adjacency.set(cand.email_a, []);
    if (!adjacency.has(cand.email_b)) adjacency.set(cand.email_b, []);
    adjacency.get(cand.email_a)!.push(cand);
    adjacency.get(cand.email_b)!.push(cand);
  }
  if (!adjacency.has(survivorCanonical)) {
    throw new RpcError(
      'bad_request',
      `contact.merge.confirm: survivor_email ${survivorCanonical} is not present in any of the supplied candidate edges`,
    );
  }
  const reachableEmails = new Set<string>([survivorCanonical]);
  const reachableCandidateIds = new Set<string>();
  const queue: string[] = [survivorCanonical];
  while (queue.length > 0) {
    const node = queue.shift()!;
    const edges = adjacency.get(node) ?? [];
    for (const edge of edges) {
      if (reachableCandidateIds.has(edge.id)) continue;
      reachableCandidateIds.add(edge.id);
      const partner = edge.email_a === node ? edge.email_b : edge.email_a;
      if (!reachableEmails.has(partner)) {
        reachableEmails.add(partner);
        queue.push(partner);
      }
    }
  }
  for (const cand of candidates) {
    if (!reachableCandidateIds.has(cand.id)) {
      throw new RpcError(
        'bad_request',
        `contact.merge.confirm: candidate ${cand.id} (${cand.email_a} ↔ ${cand.email_b}) is not connected to survivor ${survivorCanonical} via the supplied candidate graph`,
      );
    }
  }
  const loserEmails = new Set<string>(reachableEmails);
  loserEmails.delete(survivorCanonical);
  if (loserEmails.size === 0) {
    throw new RpcError(
      'bad_request',
      'contact.merge.confirm: candidate_ids contained no loser distinct from survivor_email',
    );
  }

  const now = (deps.now ?? Date.now)();
  const losers: ContactRecord[] = [];

  for (const loserEmail of loserEmails) {
    const loserRow = deps.contactStore.get(loserEmail);
    if (!loserRow) continue; // already gone — substrate stays idempotent
    if (loserRow.merged_into) continue; // already merged into something — skip
    losers.push(loserRow);

    // Move every loser-side `(vendor, platform_id)` link onto the
    // survivor canonical. The platform-link table has a UNIQUE
    // `(vendor, platform_id)` constraint so the upsert with
    // `canonical_email = survivor` simply re-keys the row.
    const loserPlatformIds = loserRow.platform_ids ?? [];
    for (const entry of loserPlatformIds) {
      deps.contactStore.linkPlatformId({
        canonical_email: survivorCanonical,
        vendor: entry.vendor,
        platform_id: entry.platform_id,
        state: entry.state,
        // Preserve the older `linked_at` (first-link provenance) — the
        // store's MIN(linked_at, excluded.linked_at) semantics already
        // do this.
        linked_at: entry.linked_at,
        linked_by: entry.linked_by,
      });
    }

    // Annotation + link rewrite at merge time. Survivor wins on
    // `(collection, target_id, key)` collision; the loser's value is
    // preserved in the survivor annotation's `extras` keyed by the loser
    // email (D-138 § A.8). Awaited — the primitive resolves a blob-stored
    // loser value (CAS) before the sync transaction stashes it.
    if (deps.annotationStore) {
      try {
        await deps.annotationStore.rewriteRecordId('contact', loserEmail, survivorCanonical);
      } catch {
        // Best-effort — substrate prefers a partial rewrite over a
        // full transaction abort. The redirect chain
        // (`merged_into`) is the safety net for any reference that
        // bypassed rewrite.
      }
    }

  }

  // Set tombstones (`merged_into`) for every loser via the
  // contact-store primitive. The store also clears the loser row's
  // identity-bearing columns so the tombstone carries only the
  // redirect (per spec § A.8).
  deps.contactStore.setMergedInto(losers, survivorCanonical, now);

  // Mark every candidate row resolved.
  const resolvedCandidates: ContactMergeCandidate[] = [];
  for (const cand of candidates) {
    const updated = deps.contactStore.setMergeCandidateStatus(
      cand.id,
      'merged',
      now,
      survivorCanonical,
    );
    if (updated) {
      resolvedCandidates.push(updated);
      deps.emitMergeCandidate?.('resolved', updated);
    }
  }

  if (deps.onIdentityChanged) {
    try {
      deps.onIdentityChanged({
        survivor_email: survivorCanonical,
        loser_emails: losers.map((l) => l.email),
      });
    } catch { /* cascade is best-effort from the rpc layer */ }
  }

  const survivorAfter = deps.contactStore.get(survivorCanonical);
  if (!survivorAfter) {
    throw new RpcError('internal_error', `contact.merge.confirm: survivor ${survivorCanonical} disappeared after merge`);
  }
  // Re-read losers to surface the updated `merged_into` redirect.
  const losersAfter = losers
    .map((l) => deps.contactStore.get(l.email))
    .filter((row): row is ContactRecord => row !== null);
  return { survivor: survivorAfter, losers: losersAfter };
};

export const handleContactMergeReject = async (
  deps: ContactMergeRpcDeps,
  args: { candidate_ids: string[]; rejected_by?: string },
): Promise<{ candidates: ContactMergeCandidate[]; rejection_rows_written: number }> => {
  if (!Array.isArray(args.candidate_ids) || args.candidate_ids.length === 0) {
    throw new RpcError('bad_request', 'contact.merge.reject: candidate_ids must be a non-empty array');
  }
  const now = (deps.now ?? Date.now)();
  const updated: ContactMergeCandidate[] = [];
  let rejectionsWritten = 0;
  for (const id of args.candidate_ids) {
    const cand = deps.contactStore.getMergeCandidate(id);
    if (!cand) {
      throw new RpcError('not_found', `contact.merge.reject: candidate ${id} not found`);
    }
    if (cand.status !== 'pending') {
      throw new RpcError(
        'conflict',
        `contact.merge.reject: candidate ${id} status=${cand.status}; only pending candidates may be rejected`,
      );
    }
    deps.contactStore.addRejection({
      email_a: cand.email_a,
      email_b: cand.email_b,
      rejected_at: now,
      ...(args.rejected_by !== undefined ? { rejected_by: args.rejected_by } : {}),
      source_candidate_id: cand.id,
    });
    rejectionsWritten++;
    const after = deps.contactStore.setMergeCandidateStatus(
      cand.id,
      'rejected',
      now,
      args.rejected_by,
    );
    if (after) {
      updated.push(after);
      deps.emitMergeCandidate?.('resolved', after);
    }
  }
  return { candidates: updated, rejection_rows_written: rejectionsWritten };
};

export const handleContactMergeSplit = async (
  deps: ContactMergeRpcDeps,
  args: {
    merged_email: string;
    platform_id_redistribution: Array<{
      platform_id_entry: PlatformIdEntry;
      target_canonical_email: string;
    }>;
    rejected_by?: string;
  },
): Promise<{ canonicals: ContactRecord[] }> => {
  const losing = canonicalizeEmail(args.merged_email);
  if (!losing) {
    throw new RpcError('bad_request', `contact.merge.split: invalid merged_email '${args.merged_email}'`);
  }
  const tombstone = deps.contactStore.get(losing);
  if (!tombstone) {
    throw new RpcError('not_found', `contact.merge.split: ${losing} not found`);
  }
  if (!tombstone.merged_into) {
    throw new RpcError(
      'bad_request',
      `contact.merge.split: ${losing} is not currently merged (no merged_into); split only applies to merged rows`,
    );
  }
  const survivor = tombstone.merged_into;
  const now = (deps.now ?? Date.now)();

  // Clear merged_into on the loser row to bring it back from
  // tombstone to standalone.
  deps.contactStore.setMergedInto([tombstone], null, now);

  // Redistribute platform_ids. Each entry routes to whichever
  // canonical email the user picked at the split UI. Substrate
  // applies the redistribution via linkPlatformId (which is
  // idempotent on UNIQUE (vendor, platform_id)).
  for (const item of args.platform_id_redistribution) {
    const target = canonicalizeEmail(item.target_canonical_email);
    if (!target) continue;
    deps.contactStore.linkPlatformId({
      canonical_email: target,
      vendor: item.platform_id_entry.vendor,
      platform_id: item.platform_id_entry.platform_id,
      state: 'confirmed',
      linked_at: item.platform_id_entry.linked_at,
      linked_by: `user_split:${args.rejected_by ?? 'unknown'}`,
    });
  }

  // Add the split pair to rejected_pairs (durable rejection — same
  // semantics as `reject`, just driven by the split action).
  deps.contactStore.addRejection({
    email_a: losing,
    email_b: survivor,
    rejected_at: now,
    ...(args.rejected_by !== undefined ? { rejected_by: args.rejected_by } : {}),
  });

  // Reverse cascade — fire identity-change so any aggregate enrichments
  // bisect back to per-canonical rows.
  if (deps.onIdentityChanged) {
    try {
      deps.onIdentityChanged({
        survivor_email: survivor,
        loser_emails: [losing],
      });
    } catch { /* best-effort */ }
  }

  const canonicals: ContactRecord[] = [];
  for (const email of [survivor, losing]) {
    const row = deps.contactStore.get(email);
    if (row) canonicals.push(row);
  }
  return { canonicals };
};

export const handleContactMergeUndoRejection = async (
  deps: ContactMergeRpcDeps,
  args: { email_a: string; email_b: string },
): Promise<{ contact_a: ContactRecord | null; contact_b: ContactRecord | null }> => {
  const a = canonicalizeEmail(args.email_a);
  const b = canonicalizeEmail(args.email_b);
  if (!a || !b) {
    throw new RpcError('bad_request', 'contact.merge.undo_rejection: both email_a and email_b are required');
  }
  if (a === b) {
    throw new RpcError('bad_request', 'contact.merge.undo_rejection: email_a and email_b must differ');
  }
  deps.contactStore.removeRejection(a, b);
  return {
    contact_a: deps.contactStore.get(a),
    contact_b: deps.contactStore.get(b),
  };
};

export const handleContactMergeResolveRemergePrompt = async (
  deps: ContactMergeRpcDeps,
  args: { prompt_id: string; resolution: RemergePromptResolution },
): Promise<{ result: 'queued_merge_candidate' | 'deletion_acknowledged' }> => {
  if (typeof args.prompt_id !== 'string' || !args.prompt_id) {
    throw new RpcError('bad_request', 'contact.merge.resolve_remerge_prompt: prompt_id is required');
  }
  if (args.resolution !== 'remerge' && args.resolution !== 'treat_as_deletion') {
    throw new RpcError(
      'bad_request',
      `contact.merge.resolve_remerge_prompt: unknown resolution '${args.resolution}'`,
    );
  }
  if (!deps.promptStore) {
    // In production the prompt store is wired (`createRemergePromptStore` in
    // `wire-contact-store`; the housekeeping cycle's A.10 pass populates the
    // prompt table). This branch is the dbless-harness fallback: with no db
    // there is no store, so the rpc fails closed with `not_configured` rather
    // than silently no-op.
    throw new RpcError(
      'not_configured',
      'contact.merge.resolve_remerge_prompt: A.10 prompt store unavailable (no db; dbless harness)',
    );
  }
  const prompt = deps.promptStore.get(args.prompt_id);
  if (!prompt) {
    throw new RpcError('not_found', `contact.merge.resolve_remerge_prompt: prompt ${args.prompt_id} not found`);
  }
  const now = (deps.now ?? Date.now)();
  deps.promptStore.resolve(args.prompt_id, args.resolution, now);
  if (args.resolution === 'remerge') {
    deps.contactStore.removeRejection(prompt.affected_email, prompt.partner_email);
    const id = (deps.newId ?? randomUUID)();
    deps.contactStore.enqueueMergeCandidate({
      id,
      email_a: prompt.affected_email,
      email_b: prompt.partner_email,
      // Surface the prompt's vendor as the source of the candidate
      // so the review UI can show "matched via upstream re-merge"
      // hint. Predicate-match metadata is empty since the candidate
      // is system-generated.
      matched_fields: [],
      detected_at: now,
      detected_by: 'inline',
    });
    return { result: 'queued_merge_candidate' };
  }
  return { result: 'deletion_acknowledged' };
};

export const handleContactMergeScanNow = async (
  deps: ContactMergeRpcDeps,
  args: { mode?: ContactMergeScanMode } | undefined,
): Promise<{
  mode: ContactMergeScanMode;
  iterated: number;
  surfaced_count: number;
  yield_reason?: 'budget_exhausted' | 'no_work';
}> => {
  if (!deps.runScanNow) {
    throw new RpcError(
      'not_configured',
      'contact.merge.scan_now: scan runner not wired (housekeeping scheduler absent)',
    );
  }
  const mode: ContactMergeScanMode = args?.mode === 'full' ? 'full' : 'delta';
  const result = await deps.runScanNow({ mode });
  return {
    mode,
    iterated: result.iterated,
    surfaced_count: result.surfaced_count,
    ...(result.yield_reason !== undefined ? { yield_reason: result.yield_reason } : {}),
  };
};

type ContactMergeMethods =
  | 'contact.merge.list'
  | 'contact.merge.confirm'
  | 'contact.merge.reject'
  | 'contact.merge.split'
  | 'contact.merge.undo_rejection'
  | 'contact.merge.resolve_remerge_prompt'
  | 'contact.merge.scan_now';

export const makeContactMergeHandlers = (
  deps: ContactMergeRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, ContactMergeMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: [
      'contact.merge.list',
      'contact.merge.confirm',
      'contact.merge.reject',
      'contact.merge.split',
      'contact.merge.undo_rejection',
      'contact.merge.resolve_remerge_prompt',
      'contact.merge.scan_now',
    ],
    handlers: {
      'contact.merge.list': async (args) =>
        handleContactMergeList(deps, args as Parameters<typeof handleContactMergeList>[1]),
      'contact.merge.confirm': async (args) =>
        handleContactMergeConfirm(deps, args as Parameters<typeof handleContactMergeConfirm>[1]),
      'contact.merge.reject': async (args) =>
        handleContactMergeReject(deps, args as Parameters<typeof handleContactMergeReject>[1]),
      'contact.merge.split': async (args) =>
        handleContactMergeSplit(deps, args as Parameters<typeof handleContactMergeSplit>[1]),
      'contact.merge.undo_rejection': async (args) =>
        handleContactMergeUndoRejection(deps, args as Parameters<typeof handleContactMergeUndoRejection>[1]),
      'contact.merge.resolve_remerge_prompt': async (args) =>
        handleContactMergeResolveRemergePrompt(deps, args as Parameters<typeof handleContactMergeResolveRemergePrompt>[1]),
      'contact.merge.scan_now': async (args) =>
        handleContactMergeScanNow(deps, args as Parameters<typeof handleContactMergeScanNow>[1]),
    },
  };
};

// Avoid unused-import lint when not invoked via newId default.
void requireResolved;
