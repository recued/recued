/** Local inspection only. Pair changes and newer reads invalidate old replies. */
import { BRIDGE_IN_FLIGHT_INSPECTION_LIMIT, BRIDGE_CONFIRMED_INSPECTION_LIMIT, confirmedErrorMetadata,
  isUncertainBridgeErrorCode, type BridgeIdempotencyScope,
  type BridgeConfirmedInspection, type BridgeConfirmedOutcome, type BridgeInFlightInspection } from '../idempotency/cache.js';
import { DEFAULT_DIAGNOSTIC_FRAME, type SidePanelDiagnosticFrame, type SidePanelStore } from './store/local-store.js';
import { createCoalescedTask } from '../coalesced-task.js';

const record = (raw: unknown): raw is Record<string, unknown> =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw);
const count = (raw: unknown): number | null =>
  typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? raw : null;

export const diagnosticScopeFromLocal = (raw: unknown): BridgeIdempotencyScope | null => {
  if (!record(raw) || typeof raw.server_public_key !== 'string' || !raw.server_public_key
    || !record(raw.webclient_token) || typeof raw.webclient_token.token_id !== 'string' || !raw.webclient_token.token_id) return null;
  return { server_public_key: raw.server_public_key, token_id: raw.webclient_token.token_id };
};
const sameScope = (a: BridgeIdempotencyScope, b: BridgeIdempotencyScope | null): boolean =>
  b !== null && a.server_public_key === b.server_public_key && a.token_id === b.token_id;

const parseInFlight = (raw: unknown): BridgeInFlightInspection | null => {
  if (!record(raw) || count(raw.count) === null || !Array.isArray(raw.entries)
    || raw.entries.length !== Math.min(raw.count as number, BRIDGE_IN_FLIGHT_INSPECTION_LIMIT)) return null;
  const entries: Array<{ command_id: string; started_at: number }> = [];
  for (const entry of raw.entries) {
    if (!record(entry) || typeof entry.command_id !== 'string' || !entry.command_id
      || typeof entry.started_at !== 'number' || !Number.isFinite(entry.started_at)
      || !Number.isFinite(new Date(entry.started_at).getTime())) return null;
    entries.push({ command_id: entry.command_id, started_at: entry.started_at });
  }
  return { count: raw.count as number, entries };
};

const parseConfirmed = (raw: unknown, receiptCount: number | null): BridgeConfirmedInspection | null => {
  if (!record(raw) || count(raw.count) === null || receiptCount === null || (raw.count as number) > receiptCount
    || !Array.isArray(raw.entries)
    || raw.entries.length !== Math.min(raw.count as number, BRIDGE_CONFIRMED_INSPECTION_LIMIT)) return null;
  const entries: BridgeConfirmedOutcome[] = [], identities = new Set<string>();
  for (const entry of raw.entries) {
    if (!record(entry) || typeof entry.command_id !== 'string' || !entry.command_id || identities.has(entry.command_id)
      || (entry.status !== 'ok' && entry.status !== 'error' && entry.status !== 'rejected')
      || isUncertainBridgeErrorCode(entry.error_code)
      || typeof entry.stored_at !== 'number' || !Number.isFinite(entry.stored_at)
      || !Number.isFinite(new Date(entry.stored_at).getTime())) return null;
    const previous = entries.at(-1);
    if (previous && (previous.stored_at < entry.stored_at
      || (previous.stored_at === entry.stored_at && previous.command_id <= entry.command_id))) return null;
    identities.add(entry.command_id);
    entries.push({ command_id: entry.command_id, status: entry.status, stored_at: entry.stored_at,
      ...confirmedErrorMetadata(entry.status, entry.error_code) });
  }
  return { count: raw.count as number, entries };
};

const unavailable = (): SidePanelDiagnosticFrame => ({ ...DEFAULT_DIAGNOSTIC_FRAME });

const parseQueue = (raw: unknown): Pick<SidePanelDiagnosticFrame,
  'current_command_id' | 'pending_command_count' | 'queue_paused'> => {
  if (!record(raw) || count(raw.pending_depth) === null || typeof raw.paused !== 'boolean'
    || (raw.current_command_id !== null && (typeof raw.current_command_id !== 'string' || !raw.current_command_id))) {
    return { current_command_id: null, pending_command_count: null, queue_paused: null };
  }
  return { current_command_id: raw.current_command_id, pending_command_count: raw.pending_depth as number,
    queue_paused: raw.paused };
};

const PAIR_READ_TIMEOUT_MS = 5_000;
const MAX_PENDING_PAIR_READS = 2;

/** A failed pair read remains dirty for the next diagnostic tick. Only the
 * newest read may apply, and a metadata event cannot erase an identity reset.
 * A hung storage call must neither block the coalesced refresh queue forever
 * nor accumulate open reads as subsequent events and polling ticks arrive. */
export const createPairStateRefresh = <T,>(deps: {
  read(): Promise<T>;
  apply(entry: T, identityChanged: boolean): void;
  invalidate(): void;
  initiallyInvalidated?: boolean;
}) => {
  let generation = 0;
  let pendingReads = 0;
  let dirty = deps.initiallyInvalidated ?? false;
  let identityChanged = dirty;
  const read = async (): Promise<T> => deps.read();
  return {
    needsRefresh: (): boolean => dirty,
    invalidateIdentity(): void {
      generation++; dirty = true; identityChanged = true; deps.invalidate();
    },
    async refresh(): Promise<boolean> {
      const request = ++generation;
      dirty = true;
      if (pendingReads >= MAX_PENDING_PAIR_READS) return false;
      pendingReads++;
      // A deadline releases the caller, but the underlying storage call has
      // no cancellation API and retains its slot until it actually settles.
      const reading = read().finally(() => { pendingReads--; });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let changed = false;
      try {
        const entry = await Promise.race([reading, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Local pairing read timed out')), PAIR_READ_TIMEOUT_MS);
        })]);
        if (request !== generation) return false;
        changed = identityChanged;
        dirty = false; identityChanged = false;
        deps.apply(entry, changed);
        return true;
      } catch {
        if (request === generation) { dirty = true; identityChanged ||= changed; }
        return false;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
};

const INSPECTION_TIMEOUT_MS = 5_000;
const MAX_PENDING_INSPECTIONS = 2;

export const createDiagnosticRefresh = (deps: {
  store: SidePanelStore;
  getScope(): BridgeIdempotencyScope | null;
  inspect(): Promise<unknown>;
  now?(): number;
}) => {
  let generation = 0;
  let pendingReads = 0;
  const inspect = async (): Promise<unknown> => deps.inspect();
  const now = deps.now ?? Date.now;
  const current = (request: number, scope: BridgeIdempotencyScope): boolean =>
    request === generation && deps.store.getState().pair.paired && sameScope(scope, deps.getScope());
  const failed = (message: string): void => {
    deps.store.applyDiagnosticFrame({ ...unavailable(),
      last_successful_refresh_at: deps.store.getState().diagnostic.last_successful_refresh_at,
      refresh_error: message });
  };
  return {
    invalidate(): void {
      generation++;
      deps.store.applyDiagnosticFrame(unavailable());
    },
    async refresh(): Promise<void> {
      const request = ++generation, scope = deps.getScope();
      if (!deps.store.getState().pair.paired) return;
      if (!scope) {
        failed('Pairing information could not be read. Try Refresh again.');
        return;
      }
      // sendMessage has no cancellation API. A timed-out read retains its
      // slot until it settles, so repeated ticks cannot pile up open ports.
      if (pendingReads >= MAX_PENDING_INSPECTIONS) {
        failed('Earlier diagnostic reads are still pending. Try Refresh again shortly.');
        return;
      }
      deps.store.applyDiagnosticFrame({ ...deps.store.getState().diagnostic, refreshing: true, refresh_error: null });
      pendingReads++;
      const read = inspect().finally(() => { pendingReads--; });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      try {
        const reply = await Promise.race([read, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new Error('Local inspection timed out'));
          }, INSPECTION_TIMEOUT_MS);
        })]);
        if (!current(request, scope)) return;
        if (!record(reply) || !sameScope(scope, diagnosticScopeFromLocal(reply.local))) {
          failed('A matching diagnostic snapshot could not be loaded. Try Refresh again.');
          return;
        }
        const receipts = record(reply.idempotency) ? reply.idempotency : {};
        const frame: SidePanelDiagnosticFrame = {
          ...unavailable(),
          idempotency_entry_count: count(receipts.entry_count),
          unresolved: parseInFlight(receipts.in_flight),
          recent_confirmed: parseConfirmed(receipts.recent_confirmed, count(receipts.entry_count)),
          ...parseQueue(reply.queue),
          grant_count: record(reply.grants) ? count(reply.grants.count) : null,
          last_successful_refresh_at: deps.store.getState().diagnostic.last_successful_refresh_at,
        };
        const complete = frame.idempotency_entry_count !== null && frame.unresolved !== null
          && frame.recent_confirmed !== null && frame.pending_command_count !== null && frame.grant_count !== null;
        if (complete) frame.last_successful_refresh_at = now();
        else frame.refresh_error = 'Some diagnostics could not be loaded. Unavailable values are marked below.';
        deps.store.applyDiagnosticFrame(frame);
      } catch {
        if (current(request, scope)) failed(timedOut
          ? 'Diagnostic refresh timed out. Try Refresh again.'
          : 'Could not refresh diagnostics. Try Refresh again.');
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
};

/** Loading includes the batching window and a pending pairing-state read.
 *  Keep requests usable while unpaired so polling can recover a failed
 *  initial pair read before inspecting the newly discovered namespace. */
export const createDiagnosticRefreshQueue = (deps: {
  store: SidePanelStore;
  prepare?(): Promise<void>;
  refresh(): Promise<void>;
}) => {
  const reads = createCoalescedTask(async () => {
    await deps.prepare?.();
    await deps.refresh();
  });
  return {
    request(): void {
      const state = deps.store.getState();
      if (state.pair.paired && !state.diagnostic.refreshing) {
        deps.store.applyDiagnosticFrame({ ...state.diagnostic, refreshing: true, refresh_error: null });
      }
      reads.request();
    },
    stop: (): void => reads.stop(),
  };
};
