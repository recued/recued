/** D-234 § 234.4 — THE ASKER'S SIDE OF AN OPEN CONVERSATION.
 *
 *  One row per question this server has sent and not yet had answered. It exists
 *  because an answer arriving from a peer has to be checked against something,
 *  and until now there was nothing on this side to check it against: the run was
 *  held, the checkpoint held `step_state`, and the ref existed only inside the
 *  hash that minted it.
 *
 *  🔑🔑 IT IS THE `offered` LIST THAT MAKES THIS NOT-OPTIONAL. `parsePeerAnswer`
 *  refuses an option we never offered — that is its whole point, because a peer
 *  that could name its own option would be choosing an outcome we never put in
 *  front of their owner. But the check needs the offered set, and the offered set
 *  lives in the authored step, behind a resolve. Recovering it from the
 *  checkpoint's recipe snapshot at answer time would re-derive authored args in a
 *  second place, differently — so it is recorded once, at the moment the question
 *  goes out, from the SAME resolved spec the wire payload was built from.
 *
 *  ⛔ AND IT IS WHAT MAKES "SOLICITED" DECIDABLE. No row ⇒ nobody here asked that
 *  question, and the answer is refused before it can resume anything. § 234.2
 *  already ruled the ref is a lookup key and never a credential; this is the
 *  lookup it is a key FOR.
 *
 *  ⚠ Not an audit surface. `ActivityEntry` (`peer_ask_*`, reserve-class) is the
 *  record of what happened; this is live state, deleted when the conversation
 *  closes. A row here means "still waiting" and nothing else — which is also what
 *  makes it the natural backing for § 234.4's "what am I waiting on, from whom,
 *  how long" surface. */
import type { PeerAskSpec } from '@recued/contracts';
import { validatePeerAskSpec } from '@recued/contracts';
import type Database from 'better-sqlite3';

import {
  ensurePeerAnswerTable,
  PEER_ANSWER_TABLE,
} from './peer-answer-store.js';

const TABLE = 'peer_ask_outbox';

interface PeerAskOutboxBaseRow {
  /** The conversation id — derived, and the primary key. */
  readonly exchange_ref: string;
  /** The held run, so an answer can find the checkpoint to resume. */
  readonly run_id: string;
  /** The paused step. Re-instantiation starts here and the op re-runs. */
  readonly gated_step_id: string;
  /** The asker's own name for the peer connection. The answer must arrive from
   *  the contract THIS connection is bound to — that is the authentication. */
  readonly connection: string;
  readonly label: string;
  /** Exactly the option ids we put in front of their owner. */
  readonly offered: readonly string[];
  readonly deadline_at?: number;
  readonly created_at: number;
}

/** Delivery is journalled separately from the conversation being answerable.
 *
 * `staged` is durable before the awaiting-peer audit anchor and MUST NOT admit
 * an answer or leave the host. `pending` means the exact anchor exists and the
 * answer route is open while an at-least-once send is in progress/retryable.
 * `delivered` means the receiver returned its durable ask receipt. `refused`
 * closes the answer route while local receipt/anchor terminalization catches
 * up after a crash. */
export type PeerAskDeliveryState =
  | 'staged'
  | 'pending'
  | 'delivered'
  | 'refused';

export interface PeerAskDeliveryRefusal {
  readonly refusal: string;
  readonly reason: string;
}

export type PeerAskRefusalTransition =
  | 'refused'
  | 'answered'
  | 'not_pending';

export type PeerAskContinuationClaim =
  | 'claimed'
  | 'already_claimed'
  | 'not_open';

export interface PeerAskResolvedCarrier {
  readonly slug: string;
  readonly operation_key: string;
  /** Exact installed mcp binding selected when the owner-approved operation
   * paused. Recovery refuses rather than route through drifted pack metadata. */
  readonly binding_fingerprint: string;
}

export interface PeerAskDeliveryPlan {
  readonly spec: PeerAskSpec;
  /** Hash of the enrolled mcp relationship record excluding rotating secrets
   * and health. A connection name alone is not a recipient identity. */
  readonly recipient_fingerprint: string;
  /** Frozen only for `via: recipe`; direct delivery has a literal native door. */
  readonly carrier?: PeerAskResolvedCarrier;
}

/** The retirement decision, resolved ONCE from pre-write state and recorded
 *  BEFORE the first durable write of `retireUnsendableStaged`.
 *
 *  ⛔⛔ WHY IT IS PERSISTED RATHER THAN RECOMPUTED. Retirement makes two guarded
 *  durable writes — the terminal audit anchor, then the gated-action receipt —
 *  and the FIRST one mutates state the SECOND one's guard reads (it sets
 *  `commit_status: 'in_doubt'` and clears `checkpoint_id`, which is exactly what
 *  the action-ownership test consults). Re-deriving the decision on re-entry
 *  therefore answers differently than it did before the first write, so a
 *  retirement interrupted between them settled the anchor and then declined to
 *  settle the action — leaving a live `dispatching` receipt with its checkpoint
 *  deleted and its journal row closed, which nothing afterwards can find.
 *
 *  🔑 The claim makes the stopping point a RECORDED FACT instead of an inference
 *  over mutable records. The send leg already had that property (`delivery_state`
 *  + `continuation_claimed`); the settle leg did not.
 *
 *  ⚠ It records AUTHORITY ("may this pass settle each half"), never completion.
 *  Whether a half is already done stays a fresh read — the anchor's own
 *  `commit_status` and `isGatedActionTerminal` — so replaying a claim cannot
 *  double-write. */
export interface PeerAskRetireClaim {
  /** May this pass write the terminal audit anchor? */
  readonly settle_anchor: boolean;
  /** May this pass settle the gated-action receipt? */
  readonly settle_action: boolean;
  /** The diagnosis that opened the retirement. First write wins, so a re-entry
   *  reports the reason that actually matched rather than one re-derived from
   *  state the first pass already changed. */
  readonly reason: string;
}

/** One exact peer question plus its crash-recovery state. */
export interface PeerAskOutboxRow extends PeerAskOutboxBaseRow {
  /** Exact peer-pause checkpoint this delivery may activate against. */
  readonly checkpoint_id?: string;
  /** Exact approved action this handoff settles. Absent on pre-journal rows and
   * on ungated legacy peer holds. */
  readonly action_ref?: string;
  readonly delivery_state: PeerAskDeliveryState;
  /** Exact resolved wire plan. Absent only on rows written before delivery
   * journalling existed (those migrate as already delivered). */
  readonly delivery?: PeerAskDeliveryPlan;
  readonly refusal?: PeerAskDeliveryRefusal;
  /** Durable no-replay fence for the answer continuation. Once true, a process
   * may repair/verify its audit outcome but must never re-run post-peer effects. */
  readonly continuation_claimed?: boolean;
  /** Present once boot retirement has resolved what it is allowed to settle. */
  readonly retire_claim?: PeerAskRetireClaim;
}

export type PeerAskOutboxOpenRow = PeerAskOutboxBaseRow;
export type PeerAskOutboxStageRow = PeerAskOutboxBaseRow & {
  readonly checkpoint_id: string;
  readonly action_ref?: string;
  readonly delivery: PeerAskDeliveryPlan;
};

export interface PeerAskOutboxStore {
  /** Legacy/already-delivered open. Kept for migrations and narrow harnesses;
   * new sends must use `stage` so their exact plan survives a power cut. */
  open(row: PeerAskOutboxOpenRow): boolean;
  /** Persist the exact send plan before the awaiting-peer anchor. First write
   * wins, so a replay cannot widen the question/options under one ref. */
  stage(row: PeerAskOutboxStageRow): boolean;
  /** Open the answer route only after the exact awaiting-peer anchor exists. */
  activate(exchange_ref: string): boolean;
  /** Receiver returned an explicit durable-ask acceptance. */
  markDelivered(exchange_ref: string): boolean;
  /** Receiver explicitly refused. This closes `get`/`list` while preserving a
   * recovery marker until local terminalization completes. */
  /** Atomically loses to an already-recorded answer, including one inserted by
   * another process sharing the SQLite WAL. */
  markRefused(
    exchange_ref: string,
    refusal: PeerAskDeliveryRefusal,
  ): PeerAskRefusalTransition;
  claimContinuation(
    exchange_ref: string,
    checkpoint_id: string,
  ): PeerAskContinuationClaim;
  /** Record what boot retirement is allowed to settle, BEFORE it settles any of
   *  it. FIRST WRITE WINS and the EFFECTIVE claim is returned — the stored one
   *  when a previous pass already decided, otherwise the one just written — so a
   *  pass that re-enters after settling only half acts on the original decision
   *  instead of re-deriving it from state that half already changed.
   *  `null` when the row is gone (nothing left to retire). */
  claimRetirement(
    exchange_ref: string,
    claim: PeerAskRetireClaim,
  ): PeerAskRetireClaim | null;
  get(exchange_ref: string): PeerAskOutboxRow | null;
  /** Includes staged/refused delivery journal rows hidden from the live
   * conversation API. */
  getDelivery(exchange_ref: string): PeerAskOutboxRow | null;
  /** Close the conversation. Returns false when nothing was open. */
  close(exchange_ref: string): boolean;
  /** Answerable conversations, oldest first. Staged/refused rows are recovery
   * state, not something a peer may answer or a timeout may consume. */
  list(): PeerAskOutboxRow[];
  /** Every journalled plan, including staged/refused recovery states. */
  listDeliveries(): PeerAskOutboxRow[];
}

interface Raw {
  exchange_ref: string;
  run_id: string;
  gated_step_id: string;
  connection: string;
  label: string;
  offered_json: string;
  deadline_at: number | null;
  created_at: number;
  action_ref: string | null;
  checkpoint_id: string | null;
  delivery_state: string;
  delivery_json: string | null;
  refusal_json: string | null;
  continuation_claimed: number;
  retire_claim_json: string | null;
}

const DELIVERY_STATES: ReadonlySet<string> = new Set([
  'staged',
  'pending',
  'delivered',
  'refused',
]);

const parseDelivery = (raw: string | null): PeerAskDeliveryPlan | undefined => {
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    const row = parsed as Record<string, unknown>;
    const spec = row.spec as PeerAskSpec;
    if (validatePeerAskSpec(spec).length > 0
      || typeof row.recipient_fingerprint !== 'string'
      || row.recipient_fingerprint.length === 0) return undefined;
    let carrier: PeerAskResolvedCarrier | undefined;
    if (row.carrier !== undefined) {
      if (row.carrier === null || typeof row.carrier !== 'object'
        || Array.isArray(row.carrier)) return undefined;
      const candidate = row.carrier as Record<string, unknown>;
      if (typeof candidate.slug !== 'string' || candidate.slug.length === 0
        || typeof candidate.operation_key !== 'string' || candidate.operation_key.length === 0
        || typeof candidate.binding_fingerprint !== 'string'
        || candidate.binding_fingerprint.length === 0) return undefined;
      carrier = {
        slug: candidate.slug,
        operation_key: candidate.operation_key,
        binding_fingerprint: candidate.binding_fingerprint,
      };
    }
    if ((spec.via === 'recipe') !== (carrier !== undefined)) return undefined;
    return {
      spec,
      recipient_fingerprint: row.recipient_fingerprint,
      ...(carrier !== undefined ? { carrier } : {}),
    };
  } catch {
    return undefined;
  }
};

const parseRefusal = (raw: string | null): PeerAskDeliveryRefusal | undefined => {
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    const row = parsed as Record<string, unknown>;
    if (typeof row.refusal !== 'string' || row.refusal.length === 0
      || typeof row.reason !== 'string' || row.reason.length === 0) return undefined;
    return { refusal: row.refusal, reason: row.reason };
  } catch {
    return undefined;
  }
};

/** ⚠ STRICT, unlike `offered_json`'s tolerant read. A half-parsed claim would
 *  grant authority nobody decided; `undefined` falls back to recomputing, which
 *  is exactly the pre-claim behaviour and never widens what may be settled. */
const parseRetireClaim = (raw: string | null): PeerAskRetireClaim | undefined => {
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    const row = parsed as Record<string, unknown>;
    if (typeof row.settle_anchor !== 'boolean'
      || typeof row.settle_action !== 'boolean'
      || typeof row.reason !== 'string' || row.reason.length === 0) return undefined;
    return {
      settle_anchor: row.settle_anchor,
      settle_action: row.settle_action,
      reason: row.reason,
    };
  } catch {
    return undefined;
  }
};

const hydrate = (r: Raw): PeerAskOutboxRow => {
  // ⚠ TOLERANT ON READ. A row whose `offered_json` cannot be parsed yields an
  // EMPTY offered set, which makes `parsePeerAnswer` refuse every option rather
  // than accept any — the safe direction for a corrupted row.
  let offered: string[] = [];
  try {
    const parsed: unknown = JSON.parse(r.offered_json);
    if (Array.isArray(parsed)) offered = parsed.filter((o): o is string => typeof o === 'string');
  } catch { /* refuse-everything is the right failure here */ }
  const deliveryState = DELIVERY_STATES.has(r.delivery_state)
    ? r.delivery_state as PeerAskDeliveryState
    : 'delivered';
  const delivery = parseDelivery(r.delivery_json);
  const refusal = parseRefusal(r.refusal_json);
  const retireClaim = parseRetireClaim(r.retire_claim_json);
  return {
    exchange_ref: r.exchange_ref,
    run_id: r.run_id,
    gated_step_id: r.gated_step_id,
    connection: r.connection,
    label: r.label,
    offered,
    ...(r.deadline_at !== null ? { deadline_at: r.deadline_at } : {}),
    created_at: r.created_at,
    ...(r.action_ref !== null && r.action_ref.length > 0
      ? { action_ref: r.action_ref }
      : {}),
    ...(r.checkpoint_id !== null && r.checkpoint_id.length > 0
      ? { checkpoint_id: r.checkpoint_id }
      : {}),
    delivery_state: deliveryState,
    ...(delivery !== undefined ? { delivery } : {}),
    ...(refusal !== undefined ? { refusal } : {}),
    continuation_claimed: r.continuation_claimed === 1,
    ...(retireClaim !== undefined ? { retire_claim: retireClaim } : {}),
  };
};

export const createPeerAskOutboxStore = (db: Database.Database): PeerAskOutboxStore => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      exchange_ref   TEXT PRIMARY KEY,
      run_id         TEXT NOT NULL,
      gated_step_id  TEXT NOT NULL,
      connection     TEXT NOT NULL,
      label          TEXT NOT NULL,
      offered_json   TEXT NOT NULL,
      deadline_at    INTEGER,
      created_at     INTEGER NOT NULL,
      action_ref     TEXT,
      checkpoint_id TEXT,
      delivery_state TEXT NOT NULL DEFAULT 'delivered',
      delivery_json  TEXT,
      refusal_json   TEXT,
      continuation_claimed INTEGER NOT NULL DEFAULT 0
    );
  `);
  // Refusal's compare-and-set statement reads this table. Ensuring it here is
  // harmless DDL and avoids a first-send path depending on whether an inbound
  // answer store happened to have been opened earlier in this process.
  ensurePeerAnswerTable(db);

  // This table predates the delivery journal. Existing rows are known-live
  // conversations, so migrate them as `delivered`; treating them as pending
  // would re-send old questions after the first upgraded boot.
  const columns = new Set(
    (db.prepare(`PRAGMA table_info(${TABLE})`).all() as Array<{ name?: unknown }>)
      .map((column) => column.name)
      .filter((name): name is string => typeof name === 'string'),
  );
  const ensureColumn = (name: string, sql: string): void => {
    if (columns.has(name)) return;
    try {
      db.exec(sql);
    } catch (error) {
      // Daemon + stdio processes can open the same upgraded WAL together. If
      // the peer added this exact column after our PRAGMA snapshot, its
      // duplicate-column error is a successful migration postcondition.
      const present = (db.prepare(`PRAGMA table_info(${TABLE})`).all() as Array<{
        name?: unknown;
      }>).some((column) => column.name === name);
      if (!present) throw error;
    }
    columns.add(name);
  };
  ensureColumn('action_ref', `ALTER TABLE ${TABLE} ADD COLUMN action_ref TEXT`);
  ensureColumn('checkpoint_id', `ALTER TABLE ${TABLE} ADD COLUMN checkpoint_id TEXT`);
  ensureColumn(
    'delivery_state',
    `ALTER TABLE ${TABLE} ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'delivered'`,
  );
  ensureColumn('delivery_json', `ALTER TABLE ${TABLE} ADD COLUMN delivery_json TEXT`);
  ensureColumn('refusal_json', `ALTER TABLE ${TABLE} ADD COLUMN refusal_json TEXT`);
  ensureColumn(
    'continuation_claimed',
    `ALTER TABLE ${TABLE} ADD COLUMN continuation_claimed INTEGER NOT NULL DEFAULT 0`,
  );
  ensureColumn('retire_claim_json', `ALTER TABLE ${TABLE} ADD COLUMN retire_claim_json TEXT`);

  const insert = db.prepare(
    `INSERT OR IGNORE INTO ${TABLE}
       (exchange_ref, run_id, gated_step_id, connection, label,
        offered_json, deadline_at, created_at, action_ref, checkpoint_id, delivery_state,
        delivery_json, refusal_json, continuation_claimed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)`,
  );

  const write = (
    row: PeerAskOutboxOpenRow | PeerAskOutboxStageRow,
    state: 'staged' | 'delivered',
    delivery?: PeerAskDeliveryPlan,
  ): boolean => insert.run(
    row.exchange_ref,
    row.run_id,
    row.gated_step_id,
    row.connection,
    row.label,
    JSON.stringify(row.offered),
    row.deadline_at ?? null,
    row.created_at,
    'action_ref' in row ? row.action_ref ?? null : null,
    'checkpoint_id' in row ? row.checkpoint_id : null,
    state,
    delivery === undefined ? null : JSON.stringify(delivery),
  ).changes > 0;

  return {
    open(row) {
      // ⚠ `INSERT OR IGNORE`, matching `PeerAnswerStore`: first write wins in ONE
      // statement, so a re-delivery cannot race a second row in beside the first.
      return write(row, 'delivered');
    },
    stage(row) {
      if (validatePeerAskSpec(row.delivery.spec).length > 0
        || row.checkpoint_id.length === 0
        || row.delivery.recipient_fingerprint.length === 0) {
        throw new Error('peer ask delivery plan is invalid');
      }
      if (row.connection !== row.delivery.spec.connection
        || row.label !== row.delivery.spec.label
        || row.deadline_at !== row.delivery.spec.deadline_at
        || row.offered.length !== row.delivery.spec.options.length
        || !row.offered.every((id, index) => id === row.delivery.spec.options[index]?.id)
        || (row.delivery.spec.via === 'recipe') !== (row.delivery.carrier !== undefined)) {
        throw new Error('peer ask delivery plan disagrees with its outbox envelope');
      }
      return write(row, 'staged', row.delivery);
    },
    activate(exchange_ref) {
      if (exchange_ref === '') return false;
      return db.prepare(
        `UPDATE ${TABLE} SET delivery_state = 'pending'
          WHERE exchange_ref = ? AND delivery_state = 'staged'
            AND delivery_json IS NOT NULL`,
      ).run(exchange_ref).changes > 0;
    },
    markDelivered(exchange_ref) {
      if (exchange_ref === '') return false;
      return db.prepare(
        `UPDATE ${TABLE} SET delivery_state = 'delivered', refusal_json = NULL
          WHERE exchange_ref = ? AND delivery_state = 'pending'`,
      ).run(exchange_ref).changes > 0;
    },
    markRefused(exchange_ref, refusal) {
      if (exchange_ref === '' || refusal.refusal.length === 0 || refusal.reason.length === 0) {
        return 'not_pending';
      }
      const changed = db.prepare(
        `UPDATE ${TABLE} SET delivery_state = 'refused', refusal_json = ?
          WHERE exchange_ref = ? AND delivery_state = 'pending'
            AND NOT EXISTS (
              SELECT 1 FROM ${PEER_ANSWER_TABLE}
               WHERE exchange_ref = ${TABLE}.exchange_ref
            )`,
      ).run(JSON.stringify(refusal), exchange_ref).changes > 0;
      if (changed) return 'refused';
      const answered = db.prepare(
        `SELECT 1 FROM ${PEER_ANSWER_TABLE} WHERE exchange_ref = ?`,
      ).get(exchange_ref) !== undefined;
      return answered ? 'answered' : 'not_pending';
    },
    claimContinuation(exchange_ref, checkpoint_id) {
      if (exchange_ref === '' || checkpoint_id === '') return 'not_open';
      const changed = db.prepare(
        `UPDATE ${TABLE} SET continuation_claimed = 1
          WHERE exchange_ref = ? AND checkpoint_id = ?
            AND delivery_state IN ('pending', 'delivered')
            AND continuation_claimed = 0
            AND EXISTS (
              SELECT 1 FROM ${PEER_ANSWER_TABLE}
               WHERE exchange_ref = ${TABLE}.exchange_ref
            )`,
      ).run(exchange_ref, checkpoint_id).changes > 0;
      if (changed) return 'claimed';
      const row = db.prepare(
        `SELECT continuation_claimed FROM ${TABLE}
          WHERE exchange_ref = ? AND checkpoint_id = ?
            AND delivery_state IN ('pending', 'delivered')`,
      ).get(exchange_ref, checkpoint_id) as { continuation_claimed: number } | undefined;
      return row?.continuation_claimed === 1 ? 'already_claimed' : 'not_open';
    },
    claimRetirement(exchange_ref, claim) {
      if (exchange_ref === '') return null;
      // ⚠ `retire_claim_json IS NULL` is the whole fence: the second caller's
      // UPDATE matches nothing and it reads back the first caller's decision.
      // Deliberately NOT scoped by `delivery_state` — the states this runs over
      // (`staged` / `pending`) are exactly what the first half of retirement may
      // leave behind, so narrowing it would drop the claim on re-entry.
      db.prepare(
        `UPDATE ${TABLE} SET retire_claim_json = ?
          WHERE exchange_ref = ? AND retire_claim_json IS NULL`,
      ).run(JSON.stringify(claim), exchange_ref);
      const stored = db.prepare(
        `SELECT retire_claim_json FROM ${TABLE} WHERE exchange_ref = ?`,
      ).get(exchange_ref) as { retire_claim_json: string | null } | undefined;
      if (stored === undefined) return null;
      return parseRetireClaim(stored.retire_claim_json) ?? null;
    },
    get(exchange_ref) {
      if (exchange_ref === '') return null;
      const r = db
        .prepare(`SELECT * FROM ${TABLE}
                   WHERE exchange_ref = ? AND delivery_state IN ('pending', 'delivered')`)
        .get(exchange_ref) as Raw | undefined;
      if (r === undefined) return null;
      const row = hydrate(r);
      // A pending row is answerable only because its exact send plan can prove
      // what was offered. Corruption fails closed as unsolicited and is retired
      // by boot recovery; a pre-journal delivered row remains readable.
      return row.delivery_state === 'pending' && row.delivery === undefined
        ? null
        : row;
    },
    getDelivery(exchange_ref) {
      if (exchange_ref === '') return null;
      const r = db.prepare(`SELECT * FROM ${TABLE} WHERE exchange_ref = ?`)
        .get(exchange_ref) as Raw | undefined;
      return r === undefined ? null : hydrate(r);
    },
    close(exchange_ref) {
      if (exchange_ref === '') return false;
      return db.prepare(`DELETE FROM ${TABLE} WHERE exchange_ref = ?`)
        .run(exchange_ref).changes > 0;
    },
    list() {
      return (db.prepare(`SELECT * FROM ${TABLE}
                           WHERE delivery_state IN ('pending', 'delivered')
                           ORDER BY created_at ASC`).all() as Raw[])
        .map(hydrate)
        .filter((row) => row.delivery_state !== 'pending' || row.delivery !== undefined);
    },
    listDeliveries() {
      return (db.prepare(`SELECT * FROM ${TABLE}
                           WHERE delivery_json IS NOT NULL
                           ORDER BY created_at ASC`).all() as Raw[])
        .map(hydrate);
    },
  };
};
