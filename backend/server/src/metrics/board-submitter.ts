/** D-250 § B3.3 / § B4.2 — the daily board submission: build, sign, send, reconcile.
 *
 *  ⛔⛔ NOT A HOUSEKEEPING TASK, AND THAT IS AN AUTHORIZATION BOUNDARY. § D4:
 *  `resolveTrustCeiling` gives `housekeeping` the `admin` ceiling as "the server's own
 *  maintenance, outside the user-approval model" — recomputing a local number IS that,
 *  but **publishing an owner's activity to a public board is not**. This is invoked
 *  explicitly; it must never be registered in `STANDALONE_TASKS`, where it would
 *  silently inherit an exemption written for something else.
 *
 *  🔑 EVERY PUBLICATION RIDES EVERY BATCH — § B3.3's "always send; let the board
 *  discard". An active one carries its score; a withdrawing one carries § C4's
 *  `{unpublish: true}` and KEEPS carrying it until the ack confirms deletion. That
 *  repetition is what makes a late resurrection self-heal without any cloud-side grant or
 *  revocation state.
 *
 *  ⚠ THE WHOLE BATCH IS ONE SIGNATURE over `{publisher_id, handle, entries, timestamp}`,
 *  canonicalised with the SAME `@recued/crypto/canonical-json` the cloud verifies with.
 *  Both sides must produce byte-identical input; that is why the entries are signed
 *  WHOLE rather than summarised — a signature over a description of the batch would let
 *  the batch change after signing.
 */

import { canonicalJSONStringify } from '@recued/crypto';

import type { BoardPublicationStore } from './publication-store.js';
import type { MetricSnapshotStore } from './snapshot-store.js';

/** One tag's entry. Mirrors the cloud's `BoardEntry`. */
export type SubmissionEntry =
  /** ⛔⛔ CARRIES THE BOARD KEY, NOT JUST THE VALUE. § D3.1a keys a board on
   *  `(tag, metric_id, season_id)` and the entry is keyed by TAG alone, so one tag can
   *  hold several boards. A live drive caught the omission: the cloud could not resolve
   *  which board and answered `unknown_board` for every submission, while both sides'
   *  suites stayed green because each used its own convention. */
  | { value: string; definition_version: number; metric_id: string; season_id: string }
  /** ⚠ NO KEY, DELIBERATELY. § C4's erase spans ALL SEASONS — "a partial exit that
   *  leaves last season's rank standing is not leaving" — so a withdrawal is tag-scoped
   *  and narrowing it would leave older seasons standing. */
  | { unpublish: true };

export interface BoardSubmissionResult {
  readonly kind: 'ranked' | 'withdrawn' | 'rejected';
  readonly board_id: string;
  readonly rank?: number;
  readonly participants?: number;
  readonly reason?: string;
}

export interface BoardSubmitterDeps {
  publications: BoardPublicationStore;
  snapshot: MetricSnapshotStore;
  /** ⛔ A SIGN FUNCTION, NOT THE KEYPAIR. `ServerIdentity` already exposes
   *  `signWithServerIdentity`, so handing this module the private key would widen the
   *  key's reach for no gain — it needs a signature, not a secret. */
  sign: (payload: string) => string;
  /** ⚠ ASYNC AND NULLABLE, mirroring `ddns-handler`'s `resolveTarget`. A server with no
   *  reserved handle CANNOT publish — `publisher_id === server_fingerprint` is the
   *  ratified contract the cloud's authority record is keyed on, and both live in handle
   *  state, which is a store read. Null means "not set up", which is the DEFAULT. */
  resolveTarget: () => Promise<{ publisher_id: string; handle: string } | null>;
  endpoint: string;
  now: () => number;
  post: (url: string, body: string) => Promise<{ ok: boolean; text: () => Promise<string> }>;
}

/** § B3.6 — a canonical decimal STRING, four places. ⛔ NOT a JSON number: JSON has no
 *  decimal type, so a number literal is an IEEE double and the exactness promise dies in
 *  transit, before Postgres' `numeric(20,4)` column ever sees it. */
export const toWireDecimal = (value: number): string => value.toFixed(4);

/** Build the batch. ⛔ EXPORTED SO IT CAN BE TESTED WITHOUT A NETWORK, and so the publish
 *  dialog and this path can be checked against each other — a dialog that promises
 *  different bytes than the submitter sends is worse than no dialog. */
export const buildBatch = (
  deps: Pick<BoardSubmitterDeps, 'publications' | 'snapshot'>,
): Record<string, SubmissionEntry> => {
  const snap = deps.snapshot.read();
  const byId = new Map((snap?.metrics ?? []).map((m) => [m.metric_id, m]));
  const entries: Record<string, SubmissionEntry> = {};

  for (const p of deps.publications.pending()) {
    if (p.state === 'withdrawing') {
      entries[p.tag] = { unpublish: true };
      continue;
    }
    const m = byId.get(p.metric_id);
    // ⛔ AN UNMEASURED METRIC SENDS NOTHING FOR THAT TAG — it does not send 0, and it does
    // not withdraw. Sending 0 would publish a lie about a quiet window; withdrawing would
    // remove the owner from a board they never asked to leave. § B3's retention keeps
    // yesterday's value, which is the honest outcome of saying nothing.
    if (m === undefined || m.reading.kind !== 'value') continue;
    entries[p.tag] = {
      value: toWireDecimal(m.reading.value),
      definition_version: m.metric_version,
      metric_id: p.metric_id,
      season_id: p.season_id,
    };
  }
  return entries;
};

export const submitBoards = async (
  deps: BoardSubmitterDeps,
): Promise<{ sent: boolean; results: readonly BoardSubmissionResult[] }> => {
  const target = await deps.resolveTarget();
  // ⚠ NO HANDLE ⇒ NOTHING TO PUBLISH AS. Reported as not-sent rather than thrown: a
  // server without a reserved handle has simply not set publishing up, which is the
  // default state and not a fault.
  if (target === null) return { sent: false, results: [] };

  const entries = buildBatch(deps);
  // ⚠ NOTHING TO SEND IS NOT AN ERROR, and it must not post an empty batch — the cloud
  // rejects one (`MAX_ENTRIES_PER_BATCH` has a floor of 1), and a server that publishes
  // nothing is the DEFAULT state, not a broken one.
  if (Object.keys(entries).length === 0) return { sent: false, results: [] };

  const payload = {
    publisher_id: target.publisher_id,
    handle: target.handle,
    entries,
    timestamp: deps.now(),
  };
  const signature = deps.sign(canonicalJSONStringify(payload));

  const res = await deps.post(deps.endpoint, JSON.stringify({ ...payload, signature }));
  if (!res.ok) return { sent: false, results: [] };

  const body = JSON.parse(await res.text()) as { results?: BoardSubmissionResult[] };
  const results = body.results ?? [];

  for (const r of results) {
    // ⛔⛔ ONLY A CONFIRMED WITHDRAWAL DELETES THE PUBLICATION. § C4's withdrawal keeps
    // riding the batch until this ack arrives; clearing it on send instead would leave a
    // late resurrection permanent, because nothing would carry the withdrawal again.
    if (r.kind === 'withdrawn') deps.publications.confirmWithdrawn(r.board_id);
  }
  return { sent: true, results };
};
