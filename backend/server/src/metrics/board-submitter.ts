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
import type { MetricSubmitSkipReason } from '@recued/contracts';

import type { BoardPublicationStore } from './publication-store.js';
import type { MetricSnapshotStore } from './snapshot-store.js';

/** One tag's entry. Mirrors the cloud's `BoardEntry`. */
export type SubmissionEntry =
  /** ⛔⛔ CARRIES THE BOARD KEY, NOT JUST THE VALUE. § D3.1a keys a board on
   *  `(tag, metric_id, season_id)` and the entry is keyed by TAG alone, so one tag can
   *  hold several boards. A live drive caught the omission: the cloud could not resolve
   *  which board and answered `unknown_board` for every submission, while both sides'
   *  suites stayed green because each used its own convention. */
  | { value: string; definition_version: number; recipe_id: string; season_id: string;
      subject?: Record<string, unknown>; observations?: readonly string[]; answer?: string;
      /** ⛔⛔ THE BOARD'S DECLARATION, CARRIED ON EVERY SUBMIT — the owner's 2026-09-13
       *  ruling: a board is CREATED BY ITS FIRST SUBMISSION, so the shape rides every
       *  batch rather than a handshake that has no moment to happen in. Absent for a
       *  board that already exists, and absent is also what the cloud answers
       *  `unknown_board` to, which is the honest reply to "submit to a board that does
       *  not exist and do not say what it is". */
      kind?: BoardKind; min_reviews?: number;
      direction?: BoardDirection; retention?: BoardRetention;
      set_key: string }
  | { value: string; definition_version: number; metric_id: string; season_id: string;
      /** 045 — the submission CONTRACT this entry was produced under. See
       *  `METRIC_SUBMISSION_SET_KEY` for what it must and must not encode. */
      set_key: string }
  /** ⚠ NO KEY, DELIBERATELY. § C4's erase spans ALL SEASONS — "a partial exit that
   *  leaves last season's rank standing is not leaving" — so a withdrawal is tag-scoped
   *  and narrowing it would leave older seasons standing. */
  | { unpublish: true };

export interface BoardSubmissionResult {
  /** ⚠ `'recorded'` is 041's unranked answer — the score landed on a board that does not
   *  rank, so there is no position to report. Listed here so a current server type-checks
   *  against it; an OLDER server needs no change, because the body is cast without
   *  validation and the loop below acts on `'withdrawn'` alone. */
  readonly kind: 'ranked' | 'recorded' | 'withdrawn' | 'rejected';
  readonly board_id: string;
  readonly rank?: number;
  readonly participants?: number;
  readonly reason?: string;
}

export interface BoardSubmitterDeps {
  publications: BoardPublicationStore;
  snapshot: MetricSnapshotStore;
  /** 🔑 A READ FUNCTION, NOT THE STORE — the same call `sign` makes one field up. This module
   *  needs one value by key; handing it a whole `SharedStore` would widen its reach to every
   *  write, delete and search on the owner's durable tier for no gain.
   *  ⚠ OPTIONAL, because a db-less or harness boot has no shared store and an eval board is
   *  simply not submittable there — which is a degrade, not a fault. Absent behaves exactly
   *  like "no result yet": silence, never a withdrawal. */
  readPending?: (key: string) => Promise<unknown>;
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
/** 045 — THE SHAPE THIS SERVER'S METRIC SUBMISSIONS TAKE. A board adopts the first key it is
 *  offered and refuses every later mismatch, so this string is the promise that two
 *  participants' rows were produced under the same contract.
 *
 *  ⛔⛔ IT ENCODES THE ENTRY SHAPE AND NOTHING ELSE. Two things must stay OUT of it, and both
 *  would look natural going in:
 *
 *  · `definition_version` — § D3.1a deliberately leaves the version OUT of the board key so
 *    participants on different definitions share one board, with the per-row marker being
 *    "the entire reason that is honest rather than misleading". Folding it in here would
 *    split that board after all — and worse, under 045's immutability rule a version bump
 *    would refuse every submission to that board FOREVER, with no way back.
 *  · `metric_id` — the board is already keyed on it, so it would be a per-board constant
 *    that discriminates nothing.
 *
 *  🔑 WHAT IS LEFT IS THE THING WORTH GUARDING: if a future release changes what an entry
 *  CARRIES — a field added, renamed, or given a new meaning — that release bumps this, and a
 *  board that agreed to the old shape refuses the new one by name instead of silently mixing
 *  two contracts in one column.
 *  ⚠ A CONSTANT, WHICH IS THE MOST STABLE THING IT CAN BE. An unstable key makes every
 *  submission its own cell and the cloud cannot tell that from real diversity. */
export const METRIC_SUBMISSION_SET_KEY = 'metric.v1';

/** 045 — the contract an EVAL entry is produced under. Separate from the metric one because
 *  the two carry different fields; a board that agreed to one refuses the other, which is the
 *  guarantee working rather than a problem. */
export const EVAL_SUBMISSION_SET_KEY = 'eval.v1';

/** ⛔⛔ DOT SEGMENTS, AND THIS IS THE ONE DETAIL THAT SILENTLY BREAKS EVERYTHING.
 *  `shared-store.ts:749` matches `list(prefix)` as `key = prefix` PLUS the half-open range
 *  over `<prefix>.` — descendants only. A key built as `board_pending_<tag>` is matched by
 *  NOTHING: the list returns empty, nothing is ever found, and the batch reports "nothing
 *  measured" forever while the recipe writes happily every run. Each half reads as correct;
 *  only the PAIR is wrong, which is why the test asserts the COMPOSITION rather than the two
 *  shapes separately.
 *  ⚠ A tag cannot introduce a segment of its own — the cloud's route regex admits only
 *  `[A-Za-z0-9_-]`, so no tag contains a dot. */
export const EVAL_PENDING_PREFIX = 'board.pending';
export const evalPendingKey = (tag: string): string => `${EVAL_PENDING_PREFIX}.${tag}`;

/** What a recipe leaves for the next batch. */
/** ⛔ THE SERVER CHECKS SHAPES IT CAN KNOW; THE CLOUD OWNS BOARD POLICY. `boards.ts`
 *  already draws this line for evidence — "identity here, board policy there" — and the
 *  same split applies to the declaration. A vocabulary is checkable from a string alone,
 *  so a typo is refused here rather than travelling a day to be rejected. The CROSS-FIELD
 *  rules (`free_answer` needs a review bar; ranking belongs only to a board that ranks)
 *  are 041 CHECK constraints: the cloud validates them at the wire and Postgres enforces
 *  them, and re-stating them here would be one rule in two places with no shared source.
 *  ⇒ if a third caller ever needs them, the answer is a `@recued/contracts` module both
 *  sides import, NOT a second copy. */
export type BoardKind = 'score' | 'contribution' | 'free_answer';
export type BoardDirection = 'higher' | 'lower';
export type BoardRetention = 'latest' | 'highest' | 'lowest';

const BOARD_KINDS: readonly string[] = ['score', 'contribution', 'free_answer'];
const BOARD_DIRECTIONS: readonly string[] = ['higher', 'lower'];
const BOARD_RETENTIONS: readonly string[] = ['latest', 'highest', 'lowest'];

export interface PendingBoardResult {
  readonly value: string;
  readonly definition_version: number;
  readonly subject?: Record<string, unknown>;
  readonly observations?: readonly string[];
  readonly answer?: string;
  readonly kind?: BoardKind;
  readonly min_reviews?: number;
  readonly direction?: BoardDirection;
  readonly retention?: BoardRetention;
}

/** ⛔ MIRRORS THE CLOUD'S `DECIMAL_RE`. § B3.6 promises an exact four-place decimal, and a
 *  value that fails there is refused at the far end of a once-daily batch — a day late, for
 *  something checkable here in a microsecond. */
const DECIMAL = /^-?\d{1,15}(\.\d{1,4})?$/;

/** ⛔⛔ THIS PARSES USER-WRITABLE JSON AND MUST TRUST NONE OF IT. The shared store is written
 *  by recipes — `core.storage.shared.write` is an ordinary recipe op — so the value here is
 *  whatever the owner's recipe last put there, including whatever a half-finished or edited
 *  recipe put there. A malformed result must produce NO ENTRY, never a partial one: sending
 *  a submission the cloud then refuses costs a day and tells the owner nothing, and sending
 *  one it ACCEPTS with a junk value is worse.
 *  ⚠ Returns null rather than throwing — one bad tag must not take the whole batch with it,
 *  the same call `buildBatch` already makes for an unmeasured metric. */
export const parsePendingResult = (v: unknown): PendingBoardResult | null => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.value !== 'string' || !DECIMAL.test(r.value)) return null;
  if (!Number.isInteger(r.definition_version) || (r.definition_version as number) < 0) return null;
  if (r.subject !== undefined
    && (typeof r.subject !== 'object' || r.subject === null || Array.isArray(r.subject))) return null;
  if (r.observations !== undefined) {
    if (!Array.isArray(r.observations)) return null;
    if (!r.observations.every((o) => typeof o === 'string' && DECIMAL.test(o))) return null;
  }
  if (r.answer !== undefined && (typeof r.answer !== 'string' || r.answer.trim().length === 0)) return null;
  // ⚠ A MALFORMED DECLARATION SKIPS THE WHOLE ENTRY, it does not drop the field and send
  // the rest. Sending the reading without the declaration would ask the cloud to create a
  // board on `boards.kind`'s schema DEFAULT of `'score'` — silently turning an artifact
  // board into a ladder — which is exactly why the cloud demands the field instead of
  // defaulting it. Skipping is the same idiom the rest of this parser uses: say nothing
  // about the tag, and `submitBoards` reports `nothing_measured`, which stays true.
  if (r.kind !== undefined && !BOARD_KINDS.includes(r.kind as string)) return null;
  if (r.min_reviews !== undefined
    && (!Number.isInteger(r.min_reviews) || (r.min_reviews as number) < 1)) return null;
  if (r.direction !== undefined && !BOARD_DIRECTIONS.includes(r.direction as string)) return null;
  if (r.retention !== undefined && !BOARD_RETENTIONS.includes(r.retention as string)) return null;
  return {
    value: r.value,
    definition_version: r.definition_version as number,
    ...(r.subject === undefined ? {} : { subject: r.subject as Record<string, unknown> }),
    ...(r.observations === undefined ? {} : { observations: r.observations as string[] }),
    ...(r.answer === undefined ? {} : { answer: r.answer as string }),
    ...(r.kind === undefined ? {} : { kind: r.kind as BoardKind }),
    ...(r.min_reviews === undefined ? {} : { min_reviews: r.min_reviews as number }),
    ...(r.direction === undefined ? {} : { direction: r.direction as BoardDirection }),
    ...(r.retention === undefined ? {} : { retention: r.retention as BoardRetention }),
  };
};

export const buildBatch = (
  deps: Pick<BoardSubmitterDeps, 'publications' | 'snapshot'>,
  /** 🔑 PASSED IN, NOT READ HERE, AND THAT IS THE DESIGN NOT A SHORTCUT. `SharedStore.read`
   *  is async and this function is a pure, heavily-tested transformation of stores into a
   *  batch; making it async to fetch its own inputs would push IO into every one of those
   *  tests. The caller reads the pending results — it already knows which tags are
   *  recipe-defined, from `publications.pending()` — and hands them over.
   *  ⚠ Keyed by TAG because the batch is: one pending result per tag, which is exactly what
   *  `entries[p.tag]` can carry. */
  pending: ReadonlyMap<string, unknown> = new Map(),
): Record<string, SubmissionEntry> => {
  const snap = deps.snapshot.read();
  const byId = new Map((snap?.metrics ?? []).map((m) => [m.metric_id, m]));
  const entries: Record<string, SubmissionEntry> = {};

  for (const p of deps.publications.pending()) {
    if (p.state === 'withdrawing') {
      entries[p.tag] = { unpublish: true };
      continue;
    }
    // ⛔⛔ THE HALF THAT IS STILL MISSING, AND THIS IS WHERE IT GOES. A RECIPE-defined
    // publication — an eval board (§ 9 answer 1) — has no metric snapshot to read, because
    // its numbers come from a RECIPE RUN rather than from housekeeping's metric computation.
    // The source is decided but unbuilt: a recipe already writes durable state through
    // `core.storage.shared.write` (225 shipped recipes do), so the submitter reads the
    // pending result from the shared store rather than needing a new kernel op.
    // ⚠ SKIPPED, NOT FAILED, which is the idiom three lines down: saying nothing about a tag
    // is how this function already handles "granted, nothing measured this window", and a
    // recipe board with no run yet is exactly that state. `submitBoards` reports
    // `nothing_measured`, which is true rather than a euphemism.
    // ⛔ IT ALSO MUST NOT WITHDRAW. Sending `{unpublish: true}` here would remove the owner
    // from a board they never asked to leave — the same trap the unmeasured-metric rule below
    // exists for.
    if (p.recipe_id !== null) {
      // ⚠ ABSENT IS THE NORMAL STATE, NOT A FAULT — an eval board's numbers come from a
      // recipe RUN, and a board granted before its recipe has ever run has nothing to send.
      // ⛔ AND A MALFORMED RESULT IS TREATED THE SAME: skipped, never partially sent. It also
      // must not WITHDRAW — that would remove the owner from a board they never asked to
      // leave, the trap the unmeasured-metric rule below exists for.
      const result = parsePendingResult(pending.get(p.tag));
      if (result === null) continue;
      entries[p.tag] = {
        value: result.value,
        definition_version: result.definition_version,
        recipe_id: p.recipe_id,
        season_id: p.season_id,
        ...(result.subject === undefined ? {} : { subject: result.subject }),
        ...(result.observations === undefined ? {} : { observations: result.observations }),
        ...(result.answer === undefined ? {} : { answer: result.answer }),
        ...(result.kind === undefined ? {} : { kind: result.kind }),
        ...(result.min_reviews === undefined ? {} : { min_reviews: result.min_reviews }),
        ...(result.direction === undefined ? {} : { direction: result.direction }),
        ...(result.retention === undefined ? {} : { retention: result.retention }),
        set_key: EVAL_SUBMISSION_SET_KEY,
      };
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
      // ⚠ ON READINGS ONLY. A withdrawal is tag-scoped across every season (§ C4) and the
      // cloud resolves it before the board is even looked up, so it carries no shape and
      // must not be refused for lacking one — leaving a board would otherwise depend on
      // agreeing with it first.
      set_key: METRIC_SUBMISSION_SET_KEY,
    };
  }
  return entries;
};

/** ⛔ `sent: false` CARRIES A REASON, ALWAYS. Four unrelated states used to collapse into
 *  the bare boolean and the owner-facing surface could only say "nothing happened" — see
 *  `MetricSubmitSkipReason`. The reason is REQUIRED on the not-sent arm and ABSENT on the
 *  sent arm, so a caller cannot read one without having handled the other. */
export type BoardSubmitOutcome =
  | { sent: true; results: readonly BoardSubmissionResult[] }
  | {
      sent: false;
      results: readonly BoardSubmissionResult[];
      reason: MetricSubmitSkipReason;
    };

export const submitBoards = async (
  deps: BoardSubmitterDeps,
): Promise<BoardSubmitOutcome> => {
  const target = await deps.resolveTarget();
  // ⚠ NO HANDLE ⇒ NOTHING TO PUBLISH AS. Reported as not-sent rather than thrown: a
  // server without a reserved handle has simply not set publishing up, which is the
  // default state and not a fault.
  if (target === null) return { sent: false, results: [], reason: 'no_handle' };

  // ⛔⛔ THE READ HAPPENS HERE, NOT IN `buildBatch`, AND ONLY FOR THE TAGS THAT NEED IT.
  // `buildBatch` is a pure, heavily-tested transformation; making it async to fetch its own
  // inputs would push IO into every one of those tests. Reading only recipe publications also
  // means a server with no eval boards — every server today — touches the shared store zero
  // times on its daily batch.
  // ⚠ ONE BAD READ MUST NOT TAKE THE BATCH WITH IT. A store error for one tag degrades to "no
  // result yet" for that tag, which is a state the batch already handles; throwing would drop
  // every OTHER publication's submission for the day, and § B3.3 only comes round once.
  const pending = new Map<string, unknown>();
  if (deps.readPending !== undefined) {
    for (const p of deps.publications.pending()) {
      if (p.recipe_id === null || p.state !== 'active') continue;
      try {
        pending.set(p.tag, await deps.readPending(evalPendingKey(p.tag)));
      } catch {
        // left absent on purpose — see above
      }
    }
  }
  const entries = buildBatch(deps, pending);
  // ⚠ NOTHING TO SEND IS NOT AN ERROR, and it must not post an empty batch — the cloud
  // rejects one (`MAX_ENTRIES_PER_BATCH` has a floor of 1), and a server that publishes
  // nothing is the DEFAULT state, not a broken one.
  // ⛔ WHICH KIND OF NOTHING. "Granted nothing" and "granted something with no number
  // this window" are different facts about the owner's server, and only the second one
  // means their board entry is quietly keeping yesterday's value (§ B3 retention).
  if (Object.keys(entries).length === 0) {
    return {
      sent: false,
      results: [],
      reason: deps.publications.pending().length === 0 ? 'no_publications' : 'nothing_measured',
    };
  }

  const payload = {
    publisher_id: target.publisher_id,
    handle: target.handle,
    entries,
    timestamp: deps.now(),
  };
  const signature = deps.sign(canonicalJSONStringify(payload));

  const res = await deps.post(deps.endpoint, JSON.stringify({ ...payload, signature }));
  // ⚠ THE ONLY FAULT IN THE UNION. § C4's withdrawals keep riding the next batch, so
  // this is recoverable and must not read like a lost withdrawal.
  if (!res.ok) return { sent: false, results: [], reason: 'send_failed' };

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
