/** D-148 § A.3.3 — bridge idempotency cache.
 *
 *  Stores completed `command_id → result` receipts with a 24-hour TTL
 *  so a server retry can replay a retained result instead of re-executing.
 *  Entry shape includes the server's `idempotency_key` so the bridge
 *  can detect drift if the server retries with a different command_id
 *  but the same idempotency_key.
 *
 *  Production injects the IndexedDB implementation in indexed-db-cache.ts.
 *  The in-memory implementation below remains available for local fixtures.
 *
 *  Admission first atomically checks completed receipts and unresolved markers,
 *  then persists a marker before granting permission to execute. Markers do not
 *  expire, and clearing completed receipts preserves them. A timeout/cancel
 *  receipt cannot confirm that the original executor stopped.
 *
 *  TTL discipline: completed entries expire 24h after `stored_at`. The
 *  background sweep runs at every alarm tick;
 *  expired entries return `not_found` even before the sweep, so the
 *  cache is never stale-positive.
 */

import { BRIDGE_IDEMPOTENCY_TTL_MS, BRIDGE_ERROR_CODES, type BridgeErrorCode, type BridgeResult } from '@recued/contracts';

/** Stable authenticated pair identity. A transport URL move keeps the same
 * namespace; a different server identity or client token gets a separate one. */
export interface BridgeIdempotencyScope {
  server_public_key: string;
  token_id: string;
}

export interface IdempotencyEntry {
  command_id: string;
  /** Server-issued idempotency key. Bridge uses this to detect
   *  command_id drift on retry: same idempotency_key + different
   *  command_id → likely server retry against stale state. */
  idempotency_key: string;
  result: BridgeResult;
  stored_at: number;
  /** Computed: `stored_at + BRIDGE_IDEMPOTENCY_TTL_MS`. */
  expires_at: number;
}

/** Admission evidence, without command args, outputs, or bearer material. */
export interface BridgeInFlightEntry {
  command_id: string;
  idempotency_key: string;
  started_at: number;
}

/** Read-only diagnostics omit retry keys and never load an unbounded list. */
export const BRIDGE_IN_FLIGHT_INSPECTION_LIMIT = 50;
export interface BridgeInFlightInspection {
  count: number;
  entries: ReadonlyArray<Pick<BridgeInFlightEntry, 'command_id' | 'started_at'>>;
}

export const BRIDGE_CONFIRMED_INSPECTION_LIMIT = 50;
export type BridgeConfirmedErrorCode = Exclude<BridgeErrorCode, 'delivery_uncertain' | 'mv3_lifecycle_killed'>;
/** Retained confirmation metadata, without retry keys, outputs or error text.
 *  stored_at is when the receipt was saved, not when an action took effect. */
export interface BridgeConfirmedOutcome {
  command_id: string;
  status: Exclude<BridgeResult['status'], 'cancelled' | 'timeout'>;
  stored_at: number;
  /** A known failure code only. Raw messages, details and outputs stay private. */
  error_code?: BridgeConfirmedErrorCode;
}
export interface BridgeConfirmedInspection {
  count: number;
  entries: ReadonlyArray<BridgeConfirmedOutcome>;
}
export interface BridgeReceiptInspection {
  count: number;
  confirmed: BridgeConfirmedInspection;
}
/** One storage snapshot. Null marks an independently unreadable section. */
export interface BridgeIdempotencyInspection {
  receipts: BridgeReceiptInspection | null;
  in_flight: BridgeInFlightInspection | null;
}

export type IdempotencyClaim =
  | { kind: 'claimed'; entry: BridgeInFlightEntry }
  | { kind: 'completed'; entry: IdempotencyEntry }
  | { kind: 'in_flight'; entry: BridgeInFlightEntry };

/** A deadline, cancel, or lifecycle interruption cannot confirm completion. */
export const isUncertainBridgeErrorCode = (code: unknown): boolean =>
  code === 'delivery_uncertain' || code === 'mv3_lifecycle_killed';

export const receiptResolvesInFlight = (result: BridgeResult): boolean =>
  result.status !== 'timeout' && result.status !== 'cancelled'
  && !isUncertainBridgeErrorCode(result.error?.code);

const confirmedErrorCodes = new Set<string>(BRIDGE_ERROR_CODES.filter(code => !isUncertainBridgeErrorCode(code)));

/** Reused at each diagnostic boundary so new fields cannot leak error text. */
export const confirmedErrorMetadata = (status: BridgeResult['status'], code: unknown): Pick<BridgeConfirmedOutcome, 'error_code'> =>
  (status === 'error' || status === 'rejected') && typeof code === 'string' && confirmedErrorCodes.has(code)
    ? { error_code: code as BridgeConfirmedErrorCode } : {};

export interface IdempotencyCache {
  /** Atomically replay, report an unresolved predecessor, or commit admission.
   *  Only `claimed` authorizes calling the executor. */
  claim(command_id: string, idempotency_key: string): Promise<IdempotencyClaim>;
  /** Commit a known result and retire its matching marker atomically when it
   *  confirms completion. Cannot finish another command's marker. Bare stores
   *  support fixture seeding and recording a separately verified outcome. */
  store(command_id: string, idempotency_key: string, result: BridgeResult): Promise<void>;
  /** Returns the prior result iff present + unexpired. */
  lookup(command_id: string): Promise<IdempotencyEntry | null>;
  /** Returns the prior entry iff this idempotency_key has been seen
   *  under any command_id. Used to set `idempotency_key_seen: true`
   *  on the result the bridge returns to a server retry. */
  lookupByIdempotencyKey(idempotency_key: string): Promise<IdempotencyEntry | null>;
  /** Sweep expired entries. Returns count removed. */
  sweepExpired(now: number): Promise<number>;
  /** Full receipts for fixtures and explicit cache operations. */
  list(): Promise<IdempotencyEntry[]>;
  /** Unexpired receipt count and at most 50 confirmed outcomes, newest saved
   *  first, with descending command ID for ties. Reads metadata only, without
   *  deleting receipts, releasing admissions or resetting write quarantine. */
  inspectReceipts(): Promise<BridgeReceiptInspection>;
  /** Exact namespace total and at most 50 markers, ordered by command id.
   *  Reading this does not release an admission or reset a write quarantine. */
  inspectInFlight(): Promise<BridgeInFlightInspection>;
  /** Read receipts and markers together so a completion cannot appear in both
   *  lists. Preserves the read-only, bounded and pair-scoped inspection rules. */
  inspectDiagnostics(): Promise<BridgeIdempotencyInspection>;
  /** Clear completed receipts in this namespace. Unresolved markers survive. */
  clear(): Promise<void>;
}

/** In-memory implementation. */
export const createInMemoryIdempotencyCache = (
  options: { now?: () => number } = {},
): IdempotencyCache => {
  const now = options.now ?? Date.now;
  const entries = new Map<string, IdempotencyEntry>();
  const byKey = new Map<string, string>(); // idempotency_key → command_id
  const inFlight = new Map<string, BridgeInFlightEntry>();
  const inFlightByKey = new Map<string, BridgeInFlightEntry>();
  const remove = (entry: IdempotencyEntry): void => {
    entries.delete(entry.command_id);
    if (byKey.get(entry.idempotency_key) === entry.command_id) byKey.delete(entry.idempotency_key);
  };
  const lookup = (command_id: string): IdempotencyEntry | null => {
    const entry = entries.get(command_id);
    if (!entry) return null;
    if (now() >= entry.expires_at) { remove(entry); return null; }
    return entry;
  };
  const lookupKey = (key: string): IdempotencyEntry | null => {
    const id = byKey.get(key);
    return id === undefined ? null : lookup(id);
  };
  const inspectReceipts = (): BridgeReceiptInspection => {
    const at = now();
    const live = [...entries.values()].filter(entry => entry.expires_at > at);
    const confirmed = live.filter(entry => receiptResolvesInFlight(entry.result));
    confirmed.sort((a, b) => b.stored_at - a.stored_at
      || (a.command_id < b.command_id ? 1 : a.command_id > b.command_id ? -1 : 0));
    return { count: live.length, confirmed: { count: confirmed.length,
      entries: confirmed.slice(0, BRIDGE_CONFIRMED_INSPECTION_LIMIT).map(entry => ({
        command_id: entry.command_id, stored_at: entry.stored_at,
        status: entry.result.status as BridgeConfirmedOutcome['status'],
        ...confirmedErrorMetadata(entry.result.status, entry.result.error?.code),
      })) } };
  };
  const inspectInFlight = (): BridgeInFlightInspection => ({
    count: inFlight.size, entries: [...inFlight.keys()].sort()
      .slice(0, BRIDGE_IN_FLIGHT_INSPECTION_LIMIT).map(id => {
        const entry = inFlight.get(id)!;
        return { command_id: entry.command_id, started_at: entry.started_at };
      }),
  });

  return {
    async claim(command_id, idempotency_key) {
      if (typeof command_id !== 'string' || !command_id || typeof idempotency_key !== 'string' || !idempotency_key) {
        throw new Error('bridge.receipts: command identity is required');
      }
      // All checks and insertion happen before this async function yields.
      const prior = lookup(command_id) ?? lookupKey(idempotency_key);
      if (prior) return { kind: 'completed', entry: prior };
      const pending = inFlight.get(command_id) ?? inFlightByKey.get(idempotency_key);
      if (pending) return { kind: 'in_flight', entry: pending };
      const entry = { command_id, idempotency_key, started_at: now() };
      inFlight.set(command_id, entry); inFlightByKey.set(idempotency_key, entry);
      return { kind: 'claimed', entry };
    },
    async store(command_id, idempotency_key, result) {
      const pending = inFlight.get(command_id) ?? inFlightByKey.get(idempotency_key);
      if (pending && (pending.command_id !== command_id || pending.idempotency_key !== idempotency_key)) {
        throw new Error('bridge.receipts: cannot finish another command\'s in-flight marker');
      }
      const ts = now();
      const entry: IdempotencyEntry = {
        command_id,
        idempotency_key,
        result,
        stored_at: ts,
        expires_at: ts + BRIDGE_IDEMPOTENCY_TTL_MS,
      };
      const previous = entries.get(command_id);
      if (previous) remove(previous);
      entries.set(command_id, entry);
      byKey.set(idempotency_key, command_id);
      if (pending && receiptResolvesInFlight(result)) {
        inFlight.delete(command_id); inFlightByKey.delete(idempotency_key);
      }
    },
    async lookup(command_id) {
      return lookup(command_id);
    },
    async lookupByIdempotencyKey(idempotency_key) {
      return lookupKey(idempotency_key);
    },
    async sweepExpired(at) {
      let removed = 0;
      for (const entry of entries.values()) {
        if (at >= entry.expires_at) {
          remove(entry);
          removed++;
        }
      }
      return removed;
    },
    async list() {
      return [...entries.values()];
    },
    async inspectReceipts() {
      return inspectReceipts();
    },
    async inspectInFlight() {
      return inspectInFlight();
    },
    async inspectDiagnostics() {
      // Neither synchronous projection yields to a completion in between.
      return { receipts: inspectReceipts(), in_flight: inspectInFlight() };
    },
    async clear() {
      entries.clear();
      byKey.clear();
    },
  };
};

/** Snapshot a server retry decision. Returns the `idempotency_key_seen`
 *  flag the bridge stamps onto its BridgeResult; helpful when the
 *  server is reconciling its own retry state vs. what the bridge has
 *  on disk. */
export const stampIdempotencyResult = (
  result: BridgeResult,
  prior: IdempotencyEntry | null,
): BridgeResult => {
  if (!prior) return { ...result, idempotency_key_seen: false };
  return {
    ...prior.result,
    idempotency_key_seen: true,
  };
};
