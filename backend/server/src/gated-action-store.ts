/** Durable, operation-scoped approval receipts for owner surfaces.
 *
 * This is intentionally separate from `mcp-action-store.ts`. The MCP store is
 * one continuation per caller invocation/run; this store is one receipt per
 * checkpointed approval segment, so one recipe (and, when a foreach target
 * changes, one step) may create many receipts while one batch approval may
 * group many receipts. */

import { createHash, randomUUID } from 'node:crypto';
import type {
  GatedActionApprovalGroup,
  GatedActionHandoff,
  GatedActionObserved,
  GatedActionReceipt,
  GatedActionSettlementMode,
  GatedActionStatus,
  GatedActionTerminalStatus,
} from '@recued/contracts';
import { GATED_ACTION_STATUSES, isGatedActionTerminal } from '@recued/contracts';
import type { Collection } from '@recued/storage';
import type Database from 'better-sqlite3';

export const GATED_ACTION_TABLE = 'gated_action_receipts';
export const GATED_ACTION_SEQUENCE_TABLE = 'gated_action_change_sequence';
export const GATED_ACTION_TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const GATED_ACTION_MAX_RESULT_BYTES = 1 * 1_024 * 1_024;

interface GatedActionRecordFields {
  schema_version: 1;
  action_ref: string;
  approval_ref: string;
  run_id: string;
  recipe_id?: string;
  gated_step_id: string;
  ingredient_slug?: string;
  operation_id?: string;
  connection_name?: string;
  status: GatedActionStatus;
  status_message: string;
  /** Private chain link between approval segments in the same run/step. The
   * unreferenced leaf is the current subject even if an older receipt receives
   * a later terminal write. */
  predecessor_action_ref?: string;
  current_ask_id?: string;
  /** Private, host-generated ownership token for the one process that won the
   * awaiting -> dispatching transition. It is deliberately omitted from the
   * public receipt projection. */
  dispatch_attempt_id?: string;
  /** Host-owned dispatch fact. Missing legacy rows fail safe to
   * `returned_result`. */
  settlement_mode?: GatedActionSettlementMode;
  approved_bound?: { requests: number; total_bytes: number };
  created_at: number;
  updated_at: number;
  change_seq: number;
  revision: number;
  terminal_at?: number;
  expires_at?: number;
  observed?: GatedActionObserved;
  result?: unknown;
  result_omitted_reason?: 'size_limit' | 'not_serializable';
  handoff?: GatedActionHandoff;
}

/** Legacy checkpoint receipts stay readable. D-261 members have an explicit
 * origin and never manufacture a checkpoint just to satisfy the old shape. */
export type GatedActionRecord = GatedActionRecordFields & (
  | { origin?: 'held_checkpoint'; current_checkpoint_id: string; preapproval?: never }
  | { origin: 'preapproval_member'; current_checkpoint_id?: never;
      preapproval: NonNullable<GatedActionReceipt['preapproval']> }
);

export interface CreateHeldGatedActionInput {
  run_id: string;
  recipe_id?: string;
  gated_step_id: string;
  checkpoint_id: string;
  /** The immediately preceding receipt when one foreach STEP advances into a
   * new approval segment. Presence forces a distinct action identity while
   * still making retries for this exact checkpoint converge. */
  predecessor_action_ref?: string;
  ingredient_slug?: string;
  operation_id?: string;
  connection_name?: string;
  approved_bound?: { requests: number; total_bytes: number };
  settlement_mode?: GatedActionSettlementMode;
  status_message?: string;
}

export interface FinishGatedActionInput {
  status: GatedActionTerminalStatus;
  status_message: string;
  result: unknown;
  observed?: GatedActionObserved;
  handoff?: GatedActionHandoff;
  /** A lifecycle sweep may cancel only this still-waiting checkpoint. The
   * predicate is rechecked inside the receipt CAS; a dispatch claim wins. */
  awaiting_checkpoint?: { run_id: string; checkpoint_id: string };
}

export interface ConfirmPeerHandoffInput {
  run_id: string;
  gated_step_id: string;
  exchange_ref: string;
  status_message?: string;
}

export interface ClaimGatedActionDispatchInput {
  checkpoint_id: string;
  attempt_id: string;
  status_message?: string;
}

export type ClaimGatedActionDispatchResult =
  | { kind: 'claimed'; record: GatedActionRecord }
  | { kind: 'not_claimed'; record: GatedActionRecord | null };

export type GatedActionStoreEvent =
  | { kind: 'created'; record: GatedActionRecord }
  | { kind: 'updated'; record: GatedActionRecord };

export interface GatedActionStore {
  createHeld(input: CreateHeldGatedActionInput): Promise<GatedActionRecord>;
  get(action_ref: string): Promise<GatedActionRecord | null>;
  getByCheckpoint(checkpoint_id: string): Promise<GatedActionRecord | null>;
  getBySubject(run_id: string, gated_step_id: string): Promise<GatedActionRecord | null>;
  list(): Promise<GatedActionRecord[]>;
  changeClock(): GatedActionChangeClockState;
  /** The load-bearing recipe dispatch claim. Only the exact current
   * awaiting checkpoint may win; dispatching and terminal rows never reopen. */
  claimDispatch(
    action_ref: string,
    input: ClaimGatedActionDispatchInput,
  ): Promise<ClaimGatedActionDispatchResult>;
  /** Rebind a claimed peer-send receipt to the peer-answer checkpoint after
   * that continuation is durable. Never opens or changes a terminal row. */
  bindDispatchCheckpoint(
    action_ref: string,
    checkpoint_id: string,
  ): Promise<GatedActionRecord | null>;
  markDispatching(action_ref: string, status_message?: string): Promise<GatedActionRecord | null>;
  markAwaiting(
    action_ref: string,
    checkpoint_id: string,
    status_message?: string,
  ): Promise<GatedActionRecord | null>;
  linkApproval(
    action_ref: string,
    approval_ref: string,
    /** undefined preserves the current render pointer; null clears it. */
    current_ask_id?: string | null,
  ): Promise<GatedActionRecord | null>;
  finish(action_ref: string, input: FinishGatedActionInput): Promise<GatedActionRecord | null>;
  confirmPeerHandoff(
    action_ref: string,
    input: ConfirmPeerHandoffInput,
  ): Promise<GatedActionRecord | null>;
  subscribe(listener: (event: GatedActionStoreEvent) => void): () => void;
}

export type GatedActionCompareAndSet = (
  actionRef: string,
  expectedRevision: number,
  next: GatedActionRecord,
) => Promise<boolean>;

export type GatedActionNextChangeSequence = () => Promise<number>;

export interface GatedActionChangeClockState {
  epoch: string;
  /** A reserved sequence value: inherited rows precede it and new writes follow it. */
  floor: number;
}

export interface SqliteGatedActionChangeClock {
  nextChangeSeq: GatedActionNextChangeSequence;
  /** For a receipt written inside the realm's existing authority transaction. */
  nextChangeSeqSync(): number;
  snapshot(): GatedActionChangeClockState;
  /** Rotate a staged restore into a fresh lineage before its database is made live. */
  rotateEpoch(): GatedActionChangeClockState;
}

export interface CreateGatedActionStoreOptions {
  now?: () => number;
  newActionRef?: (input: CreateHeldGatedActionInput) => string;
  maxResultBytes?: number;
  terminalRetentionMs?: number;
  compareAndSet?: GatedActionCompareAndSet;
  /** Durable store-wide allocator in production. The fallback derives a
   * process-local monotonic value for in-memory/test collections. */
  nextChangeSeq?: GatedActionNextChangeSequence;
  /** Clock paired with `nextChangeSeq`; production reads this from the same
   * SQLite singleton, while in-memory stores receive one process-local epoch. */
  changeClock?: () => GatedActionChangeClockState;
}

/** Recognize results whose local call returned only a durable handoff. The
 * approval receipt stops at `dispatched`; the referenced peer/job substrate
 * owns any later completion. */
export const gatedActionHandoffFromResult = (
  value: unknown,
  fallbackRef: string,
  settlementMode: GatedActionSettlementMode,
): GatedActionHandoff | undefined => {
  if (settlementMode !== 'durable_handoff') return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const row = value as Record<string, unknown>;
  const explicitRef = typeof row.continuation_ref === 'string'
    ? row.continuation_ref
    : typeof row.execution_ref === 'string'
      ? row.execution_ref
      : undefined;
  if (row.delivery === 'deferred'
    && explicitRef !== undefined
    && explicitRef.length > 0) {
    return { kind: 'deferred_execution', ref: explicitRef };
  }
  // The shipped CLI launcher returns after spawn with this receipt. The child
  // is deliberately still running, so "completed" would describe the wrapper,
  // not the approved operation. Use the action receipt itself as the stable
  // continuation when the legacy launcher exposes only pid/marker paths.
  if (row.mode === 'detached' && row.launched === true) {
    return {
      kind: 'deferred_execution',
      ref: explicitRef !== undefined && explicitRef.length > 0
        ? explicitRef
        : fallbackRef,
    };
  }
  return undefined;
};

/** A process restart destroys the only witness that could distinguish
 * "about to dispatch" from "provider accepted it but the receipt write did
 * not land". Never retry that state automatically: make the uncertainty
 * durable and let the owner inspect Logs before choosing another attempt. */
export const reconcileInterruptedGatedActionsAtBoot = async (
  store: GatedActionStore,
  options: {
    /** A separately durable, exactly replayable substrate (currently the peer
     * delivery journal) may retain dispatch ownership across restart. */
    preserve?: (record: GatedActionRecord) => boolean | Promise<boolean>;
  } = {},
): Promise<number> => {
  let reconciled = 0;
  for (const record of await store.list()) {
    // D-261 recovery owns its member state, receipt and commit together.
    if (record.origin === 'preapproval_member') continue;
    if (record.status !== 'dispatching') continue;
    if (await options.preserve?.(record)) continue;
    const settled = await store.finish(record.action_ref, {
      status: 'in_doubt',
      status_message: 'Recued restarted while this approved operation was dispatching. Inspect Logs before retrying.',
      result: { reason: 'server_restarted_while_dispatching' },
      observed: { items: 1, succeeded: 0, failed: 0 },
    });
    if (settled?.status === 'in_doubt') reconciled += 1;
  }
  return reconciled;
};

export const createSqliteGatedActionCompareAndSet = (
  db: Database.Database,
): GatedActionCompareAndSet => {
  const insert = db.prepare(`
    INSERT INTO ${GATED_ACTION_TABLE} (key, data)
    VALUES (?, ?)
    ON CONFLICT(key) DO NOTHING
  `);
  const update = db.prepare(`
    UPDATE ${GATED_ACTION_TABLE}
       SET data = ?
     WHERE key = ?
       AND json_extract(data, '$.revision') = ?
  `);
  return async (actionRef, expectedRevision, next) => expectedRevision === 0
    ? insert.run(actionRef, JSON.stringify(next)).changes === 1
    : update.run(JSON.stringify(next), actionRef, expectedRevision).changes === 1;
};

/** Allocate a crash-stable change order independently from wall-clock time.
 * Gaps are harmless (a CAS loser may consume one); values never move backward
 * across process restarts or after receipt retention prunes old rows. */
export const createSqliteGatedActionChangeClock = (
  db: Database.Database,
  options: { newEpoch?: () => string } = {},
): SqliteGatedActionChangeClock => {
  const newEpoch = options.newEpoch ?? randomUUID;
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${GATED_ACTION_SEQUENCE_TABLE} (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      value INTEGER NOT NULL CHECK (value >= 0),
      epoch TEXT NOT NULL,
      floor INTEGER NOT NULL CHECK (floor >= 0)
    );
  `);
  // This feature existed briefly in development with only `(singleton,value)`.
  // Make those databases readable without making the launch schema depend on a
  // one-off manual reset.
  const readColumns = (): Set<string> => new Set(
    (db.prepare(`PRAGMA table_info(${GATED_ACTION_SEQUENCE_TABLE})`).all() as Array<{
      name?: unknown;
    }>).map((column) => column.name).filter((name): name is string => typeof name === 'string'),
  );
  const columns = readColumns();
  const ensureColumn = (name: string, sql: string): void => {
    if (columns.has(name)) return;
    try {
      db.exec(sql);
    } catch (error) {
      // Multiple Recued processes can open the same older realm concurrently.
      // A peer process adding this exact column after our PRAGMA snapshot is a
      // successful migration even though SQLite reports our ALTER as duplicate.
      if (!readColumns().has(name)) throw error;
    }
    columns.add(name);
  };
  ensureColumn(
    'epoch',
    `ALTER TABLE ${GATED_ACTION_SEQUENCE_TABLE} ADD COLUMN epoch TEXT NOT NULL DEFAULT ''`,
  );
  ensureColumn(
    'floor',
    `ALTER TABLE ${GATED_ACTION_SEQUENCE_TABLE} ADD COLUMN floor INTEGER NOT NULL DEFAULT 0 CHECK (floor >= 0)`,
  );
  db.prepare(`
    INSERT INTO ${GATED_ACTION_SEQUENCE_TABLE} (singleton, value, epoch, floor)
    VALUES (1, 0, ?, 0)
    ON CONFLICT(singleton) DO NOTHING
  `).run(newEpoch());
  // A process may first create receipts with the in-memory allocator (for
  // example during a rolling development migration) and only then wire the
  // durable allocator. Seed from the highest persisted value before handing
  // out another sequence so the catch-up cursor can never move backward.
  const receiptTableExists = (): boolean => db.prepare(
    `SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(GATED_ACTION_TABLE) !== undefined;
  const maxReceiptChangeSeq = (): number => {
    if (!receiptTableExists()) return 0;
    const seeded = db.prepare(`
      SELECT COALESCE(MAX(CASE
        WHEN json_valid(data) = 1
         AND json_type(data, '$.change_seq') = 'integer'
        THEN CAST(json_extract(data, '$.change_seq') AS INTEGER)
        ELSE 0
      END), 0) AS value
      FROM ${GATED_ACTION_TABLE}
    `).get() as { value?: unknown } | undefined;
    return seeded !== undefined && Number.isInteger(seeded.value) && (seeded.value as number) > 0
      ? seeded.value as number
      : 0;
  };
  if (receiptTableExists()) {
    const seeded = maxReceiptChangeSeq();
    if (seeded > 0) {
      db.prepare(`
        UPDATE ${GATED_ACTION_SEQUENCE_TABLE}
           SET value = MAX(value, ?)
         WHERE singleton = 1
      `).run(seeded);
    }
  }
  const read = db.prepare(`
    SELECT value, epoch, floor
      FROM ${GATED_ACTION_SEQUENCE_TABLE}
     WHERE singleton = 1
  `);
  const normalize = db.transaction(() => {
    const row = read.get() as { value?: unknown; epoch?: unknown; floor?: unknown } | undefined;
    if (row === undefined || !Number.isInteger(row.value) || (row.value as number) < 0) {
      throw new Error('gated action change clock is missing or invalid');
    }
    if (typeof row.epoch === 'string' && row.epoch.length > 0
      && Number.isInteger(row.floor) && (row.floor as number) >= 0) return;
    const barrier = Math.max(row.value as number, maxReceiptChangeSeq()) + 1;
    db.prepare(`
      UPDATE ${GATED_ACTION_SEQUENCE_TABLE}
         SET value = ?, epoch = ?, floor = ?
       WHERE singleton = 1
    `).run(barrier, newEpoch(), barrier);
  });
  normalize();
  const advance = db.prepare(`
    UPDATE ${GATED_ACTION_SEQUENCE_TABLE}
       SET value = value + 1
     WHERE singleton = 1
    RETURNING value
  `);
  const snapshot = (): GatedActionChangeClockState => {
    const row = read.get() as { epoch?: unknown; floor?: unknown } | undefined;
    if (row === undefined
      || typeof row.epoch !== 'string'
      || row.epoch.length === 0
      || !Number.isInteger(row.floor)
      || (row.floor as number) < 0) {
      throw new Error('gated action change clock is missing or invalid');
    }
    return { epoch: row.epoch, floor: row.floor as number };
  };
  const nextChangeSeqSync = (): number => {
    const row = advance.get() as { value?: unknown } | undefined;
    if (row === undefined || !Number.isInteger(row.value) || (row.value as number) < 1) {
      throw new Error('gated action change sequence allocation failed');
    }
    return row.value as number;
  };
  const rotate = db.transaction((): GatedActionChangeClockState => {
    const row = read.get() as { value?: unknown } | undefined;
    if (row === undefined || !Number.isInteger(row.value) || (row.value as number) < 0) {
      throw new Error('gated action change clock is missing or invalid');
    }
    const barrier = Math.max(row.value as number, maxReceiptChangeSeq()) + 1;
    const epoch = newEpoch();
    if (epoch.length === 0) throw new Error('gated action change epoch generator returned empty');
    db.prepare(`
      UPDATE ${GATED_ACTION_SEQUENCE_TABLE}
         SET value = ?, epoch = ?, floor = ?
       WHERE singleton = 1
    `).run(barrier, epoch, barrier);
    return { epoch, floor: barrier };
  });
  return {
    nextChangeSeq: async () => nextChangeSeqSync(),
    nextChangeSeqSync,
    snapshot,
    rotateEpoch: () => rotate(),
  };
};

/** Backward-compatible allocator-only view used by older tests/composition. */
export const createSqliteGatedActionChangeSequence = (
  db: Database.Database,
): GatedActionNextChangeSequence =>
  createSqliteGatedActionChangeClock(db).nextChangeSeq;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const STATUS_SET: ReadonlySet<string> = new Set(GATED_ACTION_STATUSES);

const validOptionalText = (value: unknown): boolean =>
  value === undefined || (typeof value === 'string' && value.length > 0);

const validObserved = (value: unknown): value is GatedActionObserved => {
  if (!isPlainObject(value)) return false;
  const { items, succeeded, failed } = value;
  const dispatched = value.dispatched ?? 0;
  return Number.isInteger(items)
    && Number.isInteger(succeeded)
    && Number.isInteger(failed)
    && Number.isInteger(dispatched)
    && (items as number) >= 0
    && (succeeded as number) >= 0
    && (failed as number) >= 0
    && (dispatched as number) >= 0
    && (succeeded as number) + (failed as number) + (dispatched as number)
      <= (items as number);
};

export const isGatedActionRecord = (value: unknown): value is GatedActionRecord => {
  if (!isPlainObject(value) || value.schema_version !== 1) return false;
  const text = (key: string): boolean =>
    typeof value[key] === 'string' && (value[key] as string).length > 0;
  const finite = (key: string): boolean =>
    typeof value[key] === 'number' && Number.isFinite(value[key]);
  if (
    !text('action_ref')
    || !text('approval_ref')
    || !text('run_id')
    || !text('gated_step_id')
    || !text('status_message')
  ) return false;
  if (value.origin === 'preapproval_member') {
    const origin = value.preapproval;
    if (value.current_checkpoint_id !== undefined || !isPlainObject(origin)
      || !['future_execution_ref', 'proposal_id', 'grant_id', 'member_id', 'root_run_id']
        .every(key => typeof origin[key] === 'string' && (origin[key] as string).length > 0)
      || !(origin.parent_member_id === null || typeof origin.parent_member_id === 'string')
      || !text('dispatch_attempt_id') || value.approval_ref !== origin.grant_id
      || value.status === 'awaiting_approval') return false;
  } else if ((value.origin !== undefined && value.origin !== 'held_checkpoint')
    || value.preapproval !== undefined || !text('current_checkpoint_id')) return false;
  if (!validOptionalText(value.recipe_id)
    || !validOptionalText(value.predecessor_action_ref)
    || !validOptionalText(value.ingredient_slug)
    || !validOptionalText(value.operation_id)
    || !validOptionalText(value.connection_name)
    || !validOptionalText(value.current_ask_id)
    || !validOptionalText(value.dispatch_attempt_id)) return false;
  if (value.settlement_mode !== undefined
    && value.settlement_mode !== 'returned_result'
    && value.settlement_mode !== 'durable_handoff') return false;
  if (typeof value.status !== 'string' || !STATUS_SET.has(value.status)) return false;
  if (!finite('created_at') || !finite('updated_at') || !finite('revision')) return false;
  if (!Number.isInteger(value.change_seq) || (value.change_seq as number) < 1) return false;
  if ((value.revision as number) < 1) return false;
  if (value.terminal_at !== undefined && !finite('terminal_at')) return false;
  if (value.expires_at !== undefined && !finite('expires_at')) return false;
  if (value.observed !== undefined && !validObserved(value.observed)) return false;
  if (value.approved_bound !== undefined) {
    if (!isPlainObject(value.approved_bound)) return false;
    if (!Number.isInteger(value.approved_bound.requests)
      || (value.approved_bound.requests as number) < 1
      || !Number.isFinite(value.approved_bound.total_bytes)
      || (value.approved_bound.total_bytes as number) < 0) return false;
  }
  if (value.handoff !== undefined) {
    if (!isPlainObject(value.handoff)) return false;
    if (value.handoff.kind !== 'peer_exchange'
      && value.handoff.kind !== 'deferred_execution') return false;
    if (typeof value.handoff.ref !== 'string' || value.handoff.ref.length === 0) return false;
  }
  if (value.result_omitted_reason !== undefined
    && value.result_omitted_reason !== 'size_limit'
    && value.result_omitted_reason !== 'not_serializable') return false;
  const terminal = isGatedActionTerminal(value.status as GatedActionStatus);
  return terminal === (value.terminal_at !== undefined && value.expires_at !== undefined);
};

export const projectGatedActionReceipt = (
  record: GatedActionRecord,
  options: { includeResult?: boolean } = {},
): GatedActionReceipt => ({
  action_ref: record.action_ref,
  approval_ref: record.approval_ref,
  run_id: record.run_id,
  ...(record.recipe_id !== undefined ? { recipe_id: record.recipe_id } : {}),
  gated_step_id: record.gated_step_id,
  ...(record.ingredient_slug !== undefined
    ? { ingredient_slug: record.ingredient_slug }
    : {}),
  ...(record.operation_id !== undefined ? { operation_id: record.operation_id } : {}),
  ...(record.connection_name !== undefined
    ? { connection_name: record.connection_name }
    : {}),
  ...(record.origin === 'preapproval_member' ? { preapproval: record.preapproval } : {}),
  status: record.status,
  terminal: isGatedActionTerminal(record.status),
  status_message: record.status_message,
  created_at: record.created_at,
  updated_at: record.updated_at,
  change_seq: record.change_seq,
  revision: record.revision,
  ...(record.current_ask_id !== undefined
    ? { current_ask_id: record.current_ask_id }
    : {}),
  ...(record.approved_bound !== undefined
    ? { approved_bound: record.approved_bound }
    : {}),
  ...(record.observed !== undefined ? { observed: record.observed } : {}),
  ...(options.includeResult !== false && isGatedActionTerminal(record.status)
    ? { result: record.result }
    : {}),
  ...(record.result_omitted_reason !== undefined
    ? { result_omitted_reason: record.result_omitted_reason }
    : {}),
  ...(record.handoff !== undefined ? { handoff: record.handoff } : {}),
});

const receiptItems = (receipt: GatedActionReceipt): GatedActionObserved => {
  if (receipt.observed !== undefined) return receipt.observed;
  return {
    items: 1,
    succeeded: receipt.status === 'succeeded' ? 1 : 0,
    failed: receipt.status === 'failed' ? 1 : 0,
    ...(receipt.status === 'dispatched' ? { dispatched: 1 } : {}),
  };
};

/** Aggregate records that share one stable approval_ref. */
export const projectGatedActionApprovalGroup = (
  receipts: readonly GatedActionReceipt[],
): GatedActionApprovalGroup => {
  if (receipts.length === 0) throw new Error('cannot project an empty gated-action group');
  const approvalRef = receipts[0]!.approval_ref;
  if (receipts.some((receipt) => receipt.approval_ref !== approvalRef)) {
    throw new Error('gated-action group contains more than one approval_ref');
  }
  const counts = {
    items: 0,
    succeeded: 0,
    failed: 0,
    dispatched: 0,
    denied: 0,
    cancelled: 0,
    in_doubt: 0,
  };
  for (const receipt of receipts) {
    const observed = receiptItems(receipt);
    counts.items += observed.items;
    counts.succeeded += observed.succeeded;
    counts.failed += observed.failed;
    counts.dispatched += observed.dispatched
      ?? (receipt.status === 'dispatched' ? observed.items : 0);
    if (receipt.status === 'denied') counts.denied += 1;
    if (receipt.status === 'cancelled') counts.cancelled += 1;
    if (receipt.status === 'in_doubt') counts.in_doubt += 1;
  }

  const terminal = receipts.every((receipt) => receipt.terminal);
  const hasPartial = receipts.some((receipt) => receipt.status === 'partial');
  const hasSucceeded = receipts.some((receipt) => receipt.status === 'succeeded');
  const hasFailed = receipts.some((receipt) => receipt.status === 'failed');
  const hasDispatched = receipts.some((receipt) => receipt.status === 'dispatched');
  let status: GatedActionStatus;
  if (!terminal) {
    status = receipts.some((receipt) => receipt.status === 'dispatching')
      ? 'dispatching'
      : 'awaiting_approval';
  } else if (counts.in_doubt > 0) {
    status = 'in_doubt';
  } else if (hasPartial) {
    // `observed` is useful detail, not the authority for the terminal state. A
    // legacy/custom producer may omit it (or truthfully report zero provider
    // attempts after a partly-completed wrapper), and that must not turn an
    // explicit partial outcome into a success in the owner projection.
    status = 'partial';
  } else {
    // The receipt's terminal state is authoritative; `observed` is its exact
    // request partition, not a second status calculator. In particular a
    // committed upload may be `succeeded` while a non-essential status poll
    // remains in `observed.failed`. Mixed member STATES still project partial.
    const positiveMember = hasSucceeded || hasDispatched;
    const adverseMember = hasFailed || counts.denied > 0 || counts.cancelled > 0;
    if (positiveMember && adverseMember) status = 'partial';
    else if (hasFailed) status = 'failed';
    else if (counts.denied === receipts.length) status = 'denied';
    else if (counts.cancelled === receipts.length) status = 'cancelled';
    else if (adverseMember) status = 'cancelled';
    else if (hasDispatched || counts.dispatched > 0) status = 'dispatched';
    else status = 'succeeded';
  }

  const statusMessage = receipts.length === 1
    ? receipts[0]!.status_message
    : !terminal
      ? status === 'dispatching'
        ? `Approved actions are dispatching (${receipts.length} operation${receipts.length === 1 ? '' : 's'}).`
        : `Waiting for approval (${receipts.length} operation${receipts.length === 1 ? '' : 's'}).`
      : status === 'in_doubt'
        ? 'At least one approved operation has an uncertain outcome. Inspect Logs before retrying.'
        : status === 'partial'
          ? `${counts.succeeded + counts.dispatched} of ${counts.items} approved item${counts.items === 1 ? '' : 's'} completed or were handed off.`
          : status === 'dispatched'
            ? counts.succeeded > 0
              ? `${counts.succeeded} approved item${counts.succeeded === 1 ? '' : 's'} completed; ${counts.dispatched} operation${counts.dispatched === 1 ? '' : 's'} handed off.`
              : `${counts.dispatched} approved operation${counts.dispatched === 1 ? '' : 's'} handed off.`
            : status === 'succeeded'
              ? `${counts.succeeded} approved item${counts.succeeded === 1 ? '' : 's'} completed.`
              : status === 'denied'
                ? 'The owner denied the pending action.'
                : status === 'cancelled'
                  ? 'The pending action was cancelled.'
                  : 'The approved action failed.';

  return {
    approval_ref: approvalRef,
    status,
    terminal,
    status_message: statusMessage,
    action_refs: receipts.map((receipt) => receipt.action_ref),
    ...counts,
    updated_at: Math.max(...receipts.map((receipt) => receipt.updated_at)),
    change_seq: Math.max(...receipts.map((receipt) => receipt.change_seq)),
  };
};

interface RetainedResult {
  result: unknown;
  result_omitted_reason?: GatedActionRecord['result_omitted_reason'];
}

const retainResult = (result: unknown, maxBytes: number): RetainedResult => {
  let json: string | undefined;
  try {
    json = JSON.stringify(result);
  } catch {
    json = undefined;
  }
  if (json === undefined) {
    return {
      result: { result_available: false },
      result_omitted_reason: 'not_serializable',
    };
  }
  if (Buffer.byteLength(json, 'utf8') <= maxBytes) {
    return { result: JSON.parse(json) as unknown };
  }
  return {
    result: { result_available: false },
    result_omitted_reason: 'size_limit',
  };
};

export const createGatedActionStore = (
  backing: Collection<GatedActionRecord>,
  options: CreateGatedActionStoreOptions = {},
): GatedActionStore => {
  const now = options.now ?? Date.now;
  const newActionRef = options.newActionRef
    ?? ((input) => `act_${createHash('sha256')
      .update(JSON.stringify(input.predecessor_action_ref === undefined
        ? [input.run_id, input.gated_step_id]
        : [input.run_id, input.gated_step_id, input.checkpoint_id]))
      .digest('hex')}`);
  const maxResultBytes = Math.max(1, Math.floor(
    options.maxResultBytes ?? GATED_ACTION_MAX_RESULT_BYTES,
  ));
  const terminalRetentionMs = Math.max(1, Math.floor(
    options.terminalRetentionMs ?? GATED_ACTION_TERMINAL_RETENTION_MS,
  ));
  const compareAndSet = options.compareAndSet;
  let localChangeSeq = 0;
  const nextChangeSeq = options.nextChangeSeq ?? (async (): Promise<number> => {
    for (const row of await backing.list()) {
      const value = (row as { change_seq?: unknown }).change_seq;
      if (Number.isInteger(value)) localChangeSeq = Math.max(localChangeSeq, value as number);
    }
    localChangeSeq += 1;
    return localChangeSeq;
  });
  const localChangeEpoch = `local_${randomUUID()}`;
  const changeClock = options.changeClock
    ?? (() => ({ epoch: localChangeEpoch, floor: 0 }));
  const listeners = new Set<(event: GatedActionStoreEvent) => void>();
  let mutationTail: Promise<void> = Promise.resolve();

  const mutate = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = mutationTail.then(fn, fn);
    mutationTail = result.then(() => undefined, () => undefined);
    return result;
  };
  const publish = (event: GatedActionStoreEvent): void => {
    for (const listener of listeners) {
      try { listener(event); } catch { /* invalidations are best-effort */ }
    }
  };
  const allLive = async (): Promise<GatedActionRecord[]> => {
    const rows = await backing.list();
    const valid = rows.filter(isGatedActionRecord);
    const groups = new Map<string, GatedActionRecord[]>();
    for (const row of valid) {
      const group = groups.get(row.approval_ref);
      if (group === undefined) groups.set(row.approval_ref, [row]);
      else group.push(row);
    }
    const out: GatedActionRecord[] = [];
    const at = now();
    for (const group of groups.values()) {
      // Retain a terminal approval group until EVERY member has reached its
      // own retention horizon. Removing members independently would project a
      // smaller, apparently-new aggregate during the staggered expiry window.
      const expired = group.every((row) =>
        row.expires_at !== undefined && row.expires_at <= at);
      if (!expired) {
        out.push(...group);
        continue;
      }
      for (const row of group) await backing.delete(row.action_ref);
    }
    return out;
  };
  const live = async (record: GatedActionRecord | null): Promise<GatedActionRecord | null> => {
    if (record === null || !isGatedActionRecord(record)) return null;
    // Expiry is approval-group atomic, so even a point read goes through the
    // same snapshot/prune rule as list.
    return (await allLive()).find((row) => row.action_ref === record.action_ref) ?? null;
  };
  const findSubject = async (
    runId: string,
    gatedStepId: string,
  ): Promise<GatedActionRecord | null> => {
    const matches = (await allLive()).filter((row) =>
      row.origin !== 'preapproval_member' && row.run_id === runId && row.gated_step_id === gatedStepId);
    const referenced = new Set(matches
      .map((row) => row.predecessor_action_ref)
      .filter((ref): ref is string => ref !== undefined));
    const leaves = matches.filter((row) => !referenced.has(row.action_ref));
    const candidates = leaves.length > 0 ? leaves : matches;
    candidates.sort((a, b) =>
      b.change_seq - a.change_seq || b.action_ref.localeCompare(a.action_ref));
    return candidates[0] ?? null;
  };
  const findCheckpoint = async (
    checkpointId: string,
  ): Promise<GatedActionRecord | null> =>
    (await allLive()).find((row) =>
      row.origin !== 'preapproval_member' && row.current_checkpoint_id === checkpointId) ?? null;

  const writeUpdate = async (
    existing: GatedActionRecord,
    derivePatch: (current: GatedActionRecord) => Partial<GatedActionRecord> | null,
  ): Promise<GatedActionRecord> => {
    let current = existing;
    for (let attempt = 0; attempt < 16; attempt += 1) {
      // Ordinary checkpoint/notification settlement cannot mutate a D-261
      // receipt independently of its member/commit transaction.
      if (current.origin === 'preapproval_member') return current;
      const patch = derivePatch(current);
      if (patch === null) return current;
      const changeSeq = await nextChangeSeq();
      if (!Number.isInteger(changeSeq) || changeSeq <= current.change_seq) {
        throw new Error('gated action change sequence did not advance');
      }
      const updated = {
        ...current,
        ...patch,
        schema_version: 1,
        action_ref: current.action_ref,
        run_id: current.run_id,
        gated_step_id: current.gated_step_id,
        created_at: current.created_at,
        updated_at: Math.max(current.updated_at, now()),
        change_seq: changeSeq,
        revision: current.revision + 1,
      };
      if (patch.current_ask_id === undefined
        && Object.hasOwn(patch, 'current_ask_id')) {
        delete updated.current_ask_id;
      }
      if (patch.dispatch_attempt_id === undefined
        && Object.hasOwn(patch, 'dispatch_attempt_id')) {
        delete updated.dispatch_attempt_id;
      }
      if (!isGatedActionRecord(updated)) throw new Error('Invalid gated action transition.');
      const won = compareAndSet === undefined
        ? (await backing.set(updated.action_ref, updated), true)
        : await compareAndSet(updated.action_ref, current.revision, updated);
      if (won) {
        publish({ kind: 'updated', record: updated });
        return updated;
      }
      const observed = await live(await backing.get(current.action_ref));
      if (observed === null) {
        throw new Error('gated action disappeared during a state transition');
      }
      current = observed;
    }
    throw new Error('gated action transition exceeded its contention limit');
  };

  const renewHeld = (
    existing: GatedActionRecord,
    input: CreateHeldGatedActionInput,
  ): Promise<GatedActionRecord> => {
    if (isGatedActionTerminal(existing.status)) return Promise.resolve(existing);
    const settlementMode = input.settlement_mode ?? 'returned_result';
    return writeUpdate(existing, (current) => {
      // Another process may have terminalized the row after our initial read.
      // A stale create/rerender must never reopen the operation.
      if (isGatedActionTerminal(current.status)) return null;
      if (current.status === 'dispatching'
        && current.current_checkpoint_id === input.checkpoint_id) return null;
      if (current.status === 'awaiting_approval'
        && current.current_checkpoint_id === input.checkpoint_id
        && (current.settlement_mode ?? 'returned_result') === settlementMode) return null;
      const renewedDecision = current.current_checkpoint_id !== input.checkpoint_id;
      return {
        status: 'awaiting_approval',
        status_message: input.status_message ?? 'Waiting for owner approval.',
        current_checkpoint_id: input.checkpoint_id,
        settlement_mode: settlementMode,
        dispatch_attempt_id: undefined,
        // A new checkpoint for the same step is a new decision envelope. It
        // keeps the stable action identity but must not inherit a prior batch
        // or rendered ask.
        ...(renewedDecision
          ? { approval_ref: current.action_ref, current_ask_id: undefined }
          : {}),
        ...(input.ingredient_slug !== undefined
          ? { ingredient_slug: input.ingredient_slug }
          : {}),
        ...(input.operation_id !== undefined
          ? { operation_id: input.operation_id }
          : {}),
        ...(input.connection_name !== undefined
          ? { connection_name: input.connection_name }
          : {}),
        ...(input.approved_bound !== undefined
          ? { approved_bound: input.approved_bound }
          : {}),
      };
    });
  };

  return {
    createHeld(input) {
      return mutate(async () => {
        if (input.run_id.length === 0
          || input.gated_step_id.length === 0
          || input.checkpoint_id.length === 0
          || input.predecessor_action_ref === '') {
          throw new Error('gated action run, step, and checkpoint identities must be non-empty');
        }
        const checkpointMatch = await findCheckpoint(input.checkpoint_id);
        if (checkpointMatch !== null) {
          if (checkpointMatch.run_id !== input.run_id
            || checkpointMatch.gated_step_id !== input.gated_step_id) {
            throw new Error('gated action checkpoint collided with another subject');
          }
          return renewHeld(checkpointMatch, input);
        }
        const existing = await findSubject(input.run_id, input.gated_step_id);
        if (input.predecessor_action_ref === undefined && existing !== null) {
          return renewHeld(existing, input);
        }
        if (input.predecessor_action_ref !== undefined) {
          const predecessor = await live(
            await backing.get(input.predecessor_action_ref),
          );
          if (predecessor === null
            || predecessor.run_id !== input.run_id
            || predecessor.gated_step_id !== input.gated_step_id) {
            throw new Error('gated action segment predecessor is missing or mismatched');
          }
          if (existing?.action_ref !== predecessor.action_ref) {
            throw new Error('gated action segment predecessor is stale');
          }
        }
        const at = now();
        const changeSeq = await nextChangeSeq();
        const actionRef = newActionRef(input);
        if (actionRef.length === 0) {
          throw new Error('gated action reference generator returned an invalid value');
        }
        const record: GatedActionRecord = {
          schema_version: 1,
          action_ref: actionRef,
          approval_ref: actionRef,
          run_id: input.run_id,
          ...(input.recipe_id !== undefined ? { recipe_id: input.recipe_id } : {}),
          gated_step_id: input.gated_step_id,
          ...(input.ingredient_slug !== undefined
            ? { ingredient_slug: input.ingredient_slug }
            : {}),
          ...(input.operation_id !== undefined ? { operation_id: input.operation_id } : {}),
          ...(input.connection_name !== undefined
            ? { connection_name: input.connection_name }
            : {}),
          status: 'awaiting_approval',
          status_message: input.status_message ?? 'Waiting for owner approval.',
          current_checkpoint_id: input.checkpoint_id,
          ...(input.predecessor_action_ref !== undefined
            ? { predecessor_action_ref: input.predecessor_action_ref }
            : {}),
          settlement_mode: input.settlement_mode ?? 'returned_result',
          ...(input.approved_bound !== undefined
            ? { approved_bound: input.approved_bound }
            : {}),
          created_at: at,
          updated_at: at,
          change_seq: changeSeq,
          revision: 1,
        };
        if (compareAndSet !== undefined) {
          const inserted = await compareAndSet(actionRef, 0, record);
          if (!inserted) {
            const raced = await live(await backing.get(actionRef));
            if (raced === null) {
              throw new Error('gated action disappeared during subject creation');
            }
            if (raced.run_id !== input.run_id
              || raced.gated_step_id !== input.gated_step_id) {
              throw new Error('gated action reference collided with another subject');
            }
            if (input.predecessor_action_ref !== undefined
              && raced.current_checkpoint_id !== input.checkpoint_id) {
              throw new Error('gated action reference collided with another segment');
            }
            return renewHeld(raced, input);
          }
        } else {
          const collided = await live(await backing.get(actionRef));
          if (collided !== null) {
            if (collided.run_id !== input.run_id
              || collided.gated_step_id !== input.gated_step_id) {
              throw new Error('gated action reference collided with another subject');
            }
            if (input.predecessor_action_ref !== undefined
              && collided.current_checkpoint_id !== input.checkpoint_id) {
              throw new Error('gated action reference collided with another segment');
            }
            return renewHeld(collided, input);
          }
          await backing.set(actionRef, record);
        }
        publish({ kind: 'created', record });
        return record;
      });
    },

    get(action_ref) {
      return action_ref.length === 0
        ? Promise.resolve(null)
        : backing.get(action_ref).then(live);
    },

    async getByCheckpoint(checkpoint_id) {
      if (checkpoint_id.length === 0) return null;
      return findCheckpoint(checkpoint_id);
    },

    getBySubject(run_id, gated_step_id) {
      if (run_id.length === 0 || gated_step_id.length === 0) return Promise.resolve(null);
      return findSubject(run_id, gated_step_id);
    },

    async list() {
      return (await allLive()).sort((a, b) =>
        b.change_seq - a.change_seq || b.action_ref.localeCompare(a.action_ref));
    },

    changeClock() {
      const clock = changeClock();
      if (clock.epoch.length === 0
        || !Number.isInteger(clock.floor)
        || clock.floor < 0) {
        throw new Error('gated action change clock is invalid');
      }
      return clock;
    },

    claimDispatch(action_ref, input) {
      return mutate(async () => {
        if (action_ref.length === 0
          || input.checkpoint_id.length === 0
          || input.attempt_id.length === 0) {
          throw new Error('dispatch claim identifiers must be non-empty');
        }
        const existing = await live(await backing.get(action_ref));
        if (existing === null
          || existing.status !== 'awaiting_approval'
          || existing.current_checkpoint_id !== input.checkpoint_id) {
          return { kind: 'not_claimed', record: existing };
        }
        try {
          const updated = await writeUpdate(existing, (current) =>
            current.status !== 'awaiting_approval'
              || current.current_checkpoint_id !== input.checkpoint_id
              ? null
              : {
                  status: 'dispatching',
                  status_message:
                    input.status_message ?? 'Approved; dispatching the held operation.',
                  dispatch_attempt_id: input.attempt_id,
                });
          return updated.status === 'dispatching'
            && updated.current_checkpoint_id === input.checkpoint_id
            && updated.dispatch_attempt_id === input.attempt_id
            ? { kind: 'claimed', record: updated }
            : { kind: 'not_claimed', record: updated };
        } catch (error) {
          // A storage adapter may report failure after its CAS committed. The
          // unique attempt token is the durable witness that this caller owns
          // dispatch; without that exact readback, fail closed.
          let observed: GatedActionRecord | null;
          try {
            observed = await live(await backing.get(action_ref));
          } catch {
            throw error;
          }
          if (observed?.status === 'dispatching'
            && observed.current_checkpoint_id === input.checkpoint_id
            && observed.dispatch_attempt_id === input.attempt_id) {
            publish({ kind: 'updated', record: observed });
            return { kind: 'claimed', record: observed };
          }
          if (observed === null
            || observed.status !== 'awaiting_approval'
            || observed.current_checkpoint_id !== input.checkpoint_id) {
            return { kind: 'not_claimed', record: observed };
          }
          throw error;
        }
      });
    },

    bindDispatchCheckpoint(action_ref, checkpoint_id) {
      return mutate(async () => {
        if (action_ref.length === 0 || checkpoint_id.length === 0) {
          throw new Error('dispatch checkpoint identifiers must be non-empty');
        }
        const existing = await live(await backing.get(action_ref));
        if (existing === null || existing.status !== 'dispatching') return existing;
        if (existing.current_checkpoint_id === checkpoint_id) return existing;
        try {
          return await writeUpdate(existing, (current) =>
            current.status !== 'dispatching'
              ? null
              : { current_checkpoint_id: checkpoint_id });
        } catch (error) {
          let observed: GatedActionRecord | null;
          try {
            observed = await live(await backing.get(action_ref));
          } catch {
            throw error;
          }
          if (observed?.status === 'dispatching'
            && observed.current_checkpoint_id === checkpoint_id) return observed;
          throw error;
        }
      });
    },

    markDispatching(action_ref, status_message) {
      return mutate(async () => {
        const existing = await live(await backing.get(action_ref));
        if (existing === null || isGatedActionTerminal(existing.status)) return existing;
        if (existing.status === 'dispatching') return existing;
        return writeUpdate(existing, (current) =>
          isGatedActionTerminal(current.status)
            ? null
            : {
                status: 'dispatching',
                status_message:
                  status_message ?? 'Approved; dispatching the held operation.',
              });
      });
    },

    markAwaiting(action_ref, checkpoint_id, status_message) {
      return mutate(async () => {
        const existing = await live(await backing.get(action_ref));
        if (existing === null || isGatedActionTerminal(existing.status)) return existing;
        if (existing.status === 'awaiting_approval'
          && existing.current_checkpoint_id === checkpoint_id) return existing;
        return writeUpdate(existing, (current) =>
          isGatedActionTerminal(current.status)
            ? null
            : {
                status: 'awaiting_approval',
                status_message:
                  status_message ?? 'The operation requires renewed owner approval.',
                current_checkpoint_id: checkpoint_id,
                dispatch_attempt_id: undefined,
              });
      });
    },

    linkApproval(action_ref, approval_ref, current_ask_id) {
      return mutate(async () => {
        if (approval_ref.length === 0) throw new Error('approval_ref must be non-empty');
        const existing = await live(await backing.get(action_ref));
        if (existing === null || isGatedActionTerminal(existing.status)) return existing;
        const desiredAskId = current_ask_id === null ? undefined : current_ask_id;
        const alreadyLinked = (record: GatedActionRecord): boolean =>
          record.approval_ref === approval_ref
            && (current_ask_id === undefined
            || record.current_ask_id === desiredAskId);
        if (alreadyLinked(existing)) return existing;
        return writeUpdate(existing, (current) =>
          isGatedActionTerminal(current.status) || alreadyLinked(current)
            ? null
            : {
              approval_ref,
                ...(current_ask_id !== undefined
                  ? { current_ask_id: desiredAskId }
                  : {}),
              });
      });
    },

    finish(action_ref, input) {
      return mutate(async () => {
        const matches = (row: GatedActionRecord) => !input.awaiting_checkpoint
          || (row.origin !== 'preapproval_member' && row.status === 'awaiting_approval'
            && row.run_id === input.awaiting_checkpoint.run_id
            && row.current_checkpoint_id === input.awaiting_checkpoint.checkpoint_id);
        const existing = await live(await backing.get(action_ref));
        if (existing === null || isGatedActionTerminal(existing.status) || !matches(existing)) return existing;
        const at = now();
        const retained = retainResult(input.result, maxResultBytes);
        return writeUpdate(existing, (current) =>
          isGatedActionTerminal(current.status) || !matches(current)
            ? null
            : {
                status: input.status,
                status_message: input.status_message,
                terminal_at: at,
                expires_at: at + terminalRetentionMs,
                result: retained.result,
                ...(retained.result_omitted_reason !== undefined
                  ? { result_omitted_reason: retained.result_omitted_reason }
                  : {}),
                ...(input.observed !== undefined ? { observed: input.observed } : {}),
                ...(input.handoff !== undefined ? { handoff: input.handoff } : {}),
              });
      });
    },

    confirmPeerHandoff(action_ref, input) {
      return mutate(async () => {
        if (input.run_id.length === 0
          || input.gated_step_id.length === 0
          || input.exchange_ref.length === 0) return null;
        const existing = await live(await backing.get(action_ref));
        if (existing === null
          || existing.run_id !== input.run_id
          || existing.gated_step_id !== input.gated_step_id
          || existing.status !== 'dispatching') return existing;
        const at = now();
        return writeUpdate(existing, (current) => {
          if (current.run_id !== input.run_id
            || current.gated_step_id !== input.gated_step_id
            || current.status !== 'dispatching') return null;
          return {
            status: 'dispatched',
            status_message: input.status_message
              ?? 'The approved peer question was handed off; its authenticated answer has returned.',
            terminal_at: at,
            expires_at: at + terminalRetentionMs,
            result: {
              exchange_ref: input.exchange_ref,
              status: 'dispatched',
              confirmed_by: 'authenticated_peer_answer',
            },
            observed: { items: 1, succeeded: 0, failed: 0, dispatched: 1 },
            handoff: { kind: 'peer_exchange', ref: input.exchange_ref },
          };
        });
      });
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};
