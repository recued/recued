import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalJSONStringify, type ConnectionKind, type ConnectionRow, type IngredientManifest, type StepMeta } from '@recued/contracts';
import { describeConnectionMcpRequest, IngredientError, type ConnectionAdapterDeps,
  type ConnectionAdapterStore, type ConnectionKindHandler, type IngredientCacheOptions, type IngredientCacheScope, type ResolvedCall, type StdioMcpLaunchSpec } from '@recued/ingredients';
import { connectionIdentity, connectionRevision } from './connection-revision.js';
import { currentRunAbortContext } from './execution/run-abort-context.js';
import { assertProviderHandoffActive } from './execution/provider-handoff.js';

export type ConnectionCacheStore = ConnectionAdapterStore & {
  /** Trusted token renewal preserves this identity. */
  getAuthSourceId?(kind: ConnectionKind, name: string): string | undefined;
  getReadCacheRevision?(kind: ConnectionKind, name: string): string | undefined;
  beginReadCacheWrite?(kind: ConnectionKind, name: string): (changed: boolean) => void;
};

// Custom adapters without durable freshness use a private per-store namespace.
// Recreating one cannot revive persisted entries from an earlier instance.
const volatileRevisions = new WeakMap<ConnectionCacheStore, Map<string, { revision: string; pending: number }>>();
const volatileState = (store: ConnectionCacheStore, kind: ConnectionKind, name: string) => {
  let accounts = volatileRevisions.get(store);
  if (!accounts) { accounts = new Map(); volatileRevisions.set(store, accounts); }
  const key = canonicalJSONStringify([kind, name]);
  let state = accounts.get(key);
  if (!state) { state = { revision: randomUUID(), pending: 0 }; accounts.set(key, state); }
  return state;
};
const activeWrites = new AsyncLocalStorage<{ admitted: boolean }>();
/** Only the host's provider boundary calls this, after all admission checks.
 * A later error cannot prove that earlier requests left the account unchanged. */
export const markConnectionWriteAdmitted = (): void => {
  const write = activeWrites.getStore();
  if (write) write.admitted = true;
};
const durableFreshness = (store: ConnectionCacheStore) => !!store.getReadCacheRevision && !!store.beginReadCacheWrite;
const readCacheRevision = (store: ConnectionCacheStore, kind: ConnectionKind, name: string) => {
  if (durableFreshness(store)) return store.getReadCacheRevision!(kind, name);
  const state = volatileState(store, kind, name);
  return state.pending === 0 ? state.revision : undefined;
};

// Adapter transports preserve IngredientError through their network-error
// mapping. Cancellation remains a host refusal at every recovery boundary.
const recoveryCancelled = () => new IngredientError('run_killed', 'The run stopped before the read could be refreshed.');
const RECOVERY_WAIT_MS = 250;
const RECOVERY_POLL_MS = 25;

const recoveryTransport = new AsyncLocalStorage<() => void>();
const recoveryFetches = new WeakMap<typeof fetch, typeof fetch>();
/** Legacy OAuth refresh coalescing keys by fetch identity. Share this wrapper
 * across executors while consulting only the dispatching call's host fence. */
export const withConnectionRecoveryFetch = (fetchImpl: typeof fetch): typeof fetch => {
  const existing = recoveryFetches.get(fetchImpl);
  if (existing) return existing;
  const wrapped: typeof fetch = (...args) => {
    recoveryTransport.getStore()?.();
    assertProviderHandoffActive();
    return fetchImpl(...args);
  };
  recoveryFetches.set(fetchImpl, wrapped);
  return wrapped;
};

/** The durable journal also covers writers in other processes, so poll it
 * rather than relying on a process-local completion notification. One deadline
 * bounds the whole recovery preparation, including asynchronous custom stores.
 * A late probe can neither schedule another timer nor authorize a retry. */
const waitForReadRevision = (probe: () => Promise<string | undefined>, signal?: AbortSignal): Promise<string | undefined> =>
  new Promise((resolve, reject) => {
    let settled = false;
    const expiresAt = performance.now() + RECOVERY_WAIT_MS;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (pollTimer !== undefined) clearTimeout(pollTimer);
      signal?.removeEventListener('abort', onAbort);
      settle();
    };
    const onAbort = () => finish(() => reject(recoveryCancelled()));
    const deadline = setTimeout(() => finish(() => resolve(undefined)), RECOVERY_WAIT_MS);
    const expired = () => {
      if (performance.now() < expiresAt) return false;
      finish(() => resolve(undefined));
      return true;
    };
    const poll = async () => {
      try {
        if (expired()) return;
        const revision = await probe();
        if (settled || expired()) return;
        if (revision !== undefined) finish(() => resolve(revision));
        else pollTimer = setTimeout(() => { void poll(); }, RECOVERY_POLL_MS);
      } catch (error) { finish(() => reject(error)); }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    else void poll();
  });

/** Cover raw, cached, catalog, and reviewed dispatches at the handler boundary.
 * A durable pending marker prevents caching until completion, including if the
 * process stops or completion persistence fails after the provider responds. */
export const withConnectionWriteCache = (store: ConnectionCacheStore, handler: ConnectionKindHandler): ConnectionKindHandler =>
  async (row, params, call, ctx) => {
    const writes = ['write', 'admin', 'destructive'].includes(call.risk_tier)
      && (row.kind === 'api' || row.kind === 'mcp'
        && describeConnectionMcpRequest(row, params, call.slug).operation.mode === 'tool');
    if (!writes) return handler(row, params, call, ctx);
    const state = durableFreshness(store) ? undefined : volatileState(store, row.kind, row.name);
    if (state) state.pending += 1;
    const finish = state ? (changed: boolean) => {
      if (changed) state.revision = randomUUID();
      state.pending -= 1;
    } : store.beginReadCacheWrite!(row.kind, row.name);
    const write = { admitted: false };
    return activeWrites.run(write, async () => {
      let changed = false;
      try {
        const result = await handler(row, params, call, ctx);
        // A tool error can follow partial effects, just as a successful result
        // can. Both retire reads; the original result still reaches the caller.
        changed = true;
        return result;
      } catch (error) {
        changed = write.admitted || error instanceof IngredientError && error.code === 'ACTION_DELIVERY_UNCERTAIN';
        throw error;
      } finally {
        // Failure leaves the durable marker in place, so reads bypass the cache.
        // Never turn an acknowledged write into a retryable cache-maintenance error.
        try { finish(changed); } catch { /* recovered conservatively on restart */ }
      }
    });
  };

const mcpIdentity = (row: ConnectionRow, authSource?: string) => ({
  enrolled_at: row.enrolled_at, auth: authSource ?? row.auth_ciphertext,
  config: row.config_json, subtype: row.subtype ?? null,
  scope: row.subresource_path ?? null, granted_scopes: row.granted_scopes_json ?? null,
});

/** Per-call host context, separate from authored inputs and peer cache values. */
export const createConnectionCacheScopes = (store: ConnectionCacheStore | undefined, options: {
  gateDispatch?: ConnectionAdapterDeps['gateDispatch'];
  manifest?: (slug: string) => IngredientManifest | null;
  processIdentity?: (spec: StdioMcpLaunchSpec) => string;
  /** Host-owned run cancellation and live authority/account fences. */
  recoverySignal?: AbortSignal;
  checkRecovery?(): void;
} = {}) => {
  const active = new AsyncLocalStorage<{
    processIdentity: string | undefined;
    assertRecoveryActive(): void;
    validate(): Promise<void>;
    validateRecord(row: ConnectionRow): Promise<void>;
    validateInput(input: Record<string, unknown>): void;
    validateManifest(manifest: IngredientManifest | null): void;
    validateCall(call: ResolvedCall): void;
  }>();
  const changed = () => new IngredientError('CONNECTION_REFUSED',
    'The account changed while reading cached data. Review the account and try again.',
    { reason: 'connection_changed' });

  const cacheScope: NonNullable<IngredientCacheOptions['cacheScope']> = async ({ input, manifest, stepMeta }) => {
    if (manifest.kind !== 'connection') return undefined;
    const kind = input.connection_kind;
    if (kind === 'notification') return undefined;
    if (kind !== 'api' && kind !== 'mcp') return null;
    if (!store || typeof input.connection !== 'string') return null;
    // Capture the calling run, even if this scope's retry is invoked after its
    // asynchronous context has returned. Retain the bound owner's kill fence.
    const runSignal = currentRunAbortContext()?.signal;
    const recoverySignal = runSignal && options.recoverySignal && runSignal !== options.recoverySignal
      ? AbortSignal.any([runSignal, options.recoverySignal])
      : runSignal ?? options.recoverySignal;
    const name = input.connection;
    const requestIdentity = canonicalJSONStringify(input);
    const manifestIdentity = canonicalJSONStringify(manifest);
    const dispatchIdentity = (meta: StepMeta | undefined) => canonicalJSONStringify([
      meta?.surface_dispatch ?? false, meta?.surface_risk_tier ?? null,
      meta?.surface_operation_key ?? null, meta?.surface_dispatch_sensitive ?? false,
    ]);
    const capturedDispatch = dispatchIdentity(stepMeta);
    const operationChanged = () => new IngredientError('CONNECTION_REFUSED',
      'The read operation changed while refreshing cached data. Review it and try again.',
      { reason: 'cache_operation_changed' });
    const validateManifest = (value: IngredientManifest | null) => {
      if (canonicalJSONStringify(value) !== manifestIdentity) throw operationChanged();
    };
    const validateOperation = () => {
      validateManifest(options.manifest ? options.manifest(manifest.slug) : manifest);
      if (dispatchIdentity(stepMeta) !== capturedDispatch) throw operationChanged();
    };
    const validateInput = (resolved: Record<string, unknown>) => {
      validateOperation();
      if (canonicalJSONStringify(resolved) !== requestIdentity) {
        throw new IngredientError('CONNECTION_REFUSED',
          'The request changed while reading cached data. Review the arguments and try again.',
          { reason: 'cache_input_changed' });
      }
    };
    const { connection_kind: _kind, connection: _name, ...params } = input;
    const call = { slug: manifest.slug, input, output: manifest.output ?? {},
      risk_tier: stepMeta?.surface_dispatch === true && stepMeta.surface_risk_tier !== undefined
        ? stepMeta.surface_risk_tier : manifest.risk_tier,
      ...(stepMeta ? { stepMeta } : {}) };
    const read = () => {
      const row = store.get(kind, name);
      const snapshot = (value: ConnectionRow | null, authSource?: string): {
        row: ConnectionRow | null; revision: string | undefined; processIdentity?: string;
      } => {
        if (!value || value.kind !== kind || value.name !== name) return { row: value, revision: undefined };
        if (kind === 'api') return { row: value,
          revision: connectionRevision(connectionIdentity(value, authSource)) };
        // Cache reuse must cross the same live tier and tool-definition checks
        // as dispatch. Health timestamps and display changes do not affect keys.
        options.gateDispatch?.({ kind, record: value, params, call });
        const description = describeConnectionMcpRequest(value, params, call.slug);
        const process = description.launch ? options.processIdentity?.(description.launch) : null;
        if (description.launch && process === undefined) throw new Error('The MCP process identity is unavailable.');
        const revision = createHash('sha256').update(canonicalJSONStringify([
          'mcp-account-v1', mcpIdentity(value, authSource), description, process,
        ])).digest('hex');
        return { row: value, revision, ...(process ? { processIdentity: process } : {}) };
      };
      // Capture synchronous enrollment and lineage together, before yielding.
      // Async adapters retain the credential fingerprint carried by their row.
      if (row && 'then' in row) return row.then(value => snapshot(value));
      return snapshot(row, row ? store.getAuthSourceId?.(kind, name) : undefined);
    };
    const { revision, processIdentity } = await read();
    if (!revision) return null;
    const dataRevision = readCacheRevision(store, kind, name);
    if (dataRevision === undefined) return null;
    const assertRecoveryActive = () => {
      if (recoverySignal?.aborted) throw recoveryCancelled();
      options.checkRecovery?.();
    };
    const bind = (dataRevision: string, recovering = false): IngredientCacheScope => {
      const invalidations = new WeakSet<Error>();
      const dataChanged = () => {
        const error = new IngredientError('CONNECTION_REFUSED',
          'The account data changed while reading cached data. Read it again to see the latest state.',
          { reason: 'connection_data_changed' });
        invalidations.add(error); return error;
      };
      const validate = async () => {
        if (recovering) assertRecoveryActive();
        validateInput(input);
        if ((await read()).revision !== revision) throw changed();
        if (recovering) assertRecoveryActive();
        validateOperation();
        if (readCacheRevision(store, kind, name) !== dataRevision) throw dataChanged();
      };
      const binding = {
        processIdentity,
        assertRecoveryActive: () => { if (recovering) assertRecoveryActive(); },
        validate,
        validateInput: (resolved: Record<string, unknown>) => {
          if (recovering) assertRecoveryActive();
          validateInput(resolved);
        },
        validateManifest: (value: IngredientManifest | null) => {
          if (recovering) assertRecoveryActive();
          validateManifest(value);
        },
        validateCall: (actual: ResolvedCall) => {
          if (recovering) assertRecoveryActive();
          validateOperation();
          if (actual.slug !== call.slug || actual.risk_tier !== call.risk_tier) throw operationChanged();
        },
        validateRecord: async (row: ConnectionRow) => {
          if (recovering) assertRecoveryActive();
          const current = await read();
          if (recovering) assertRecoveryActive();
          validateOperation();
          if (readCacheRevision(store, kind, name) !== dataRevision) throw dataChanged();
          const identity = kind === 'api' ? connectionIdentity : mcpIdentity;
          if (row.kind !== kind || row.name !== name || !current.row || current.revision !== revision
            || canonicalJSONStringify(identity(row)) !== canonicalJSONStringify(identity(current.row))) throw changed();
          if (kind === 'mcp' && canonicalJSONStringify(describeConnectionMcpRequest(row, params, call.slug))
            !== canonicalJSONStringify(describeConnectionMcpRequest(current.row, params, call.slug))) throw changed();
        },
      };
      const key = createHash('sha256').update(canonicalJSONStringify([
        'connection-read-cache-v1', revision, dataRevision,
      ])).digest('hex');
      return { key, validate,
        run: dispatch => active.run(binding, () => recoveryTransport.run(binding.assertRecoveryActive, dispatch)),
        retry: error => {
          // Provider payloads and errors cannot manufacture a recovery ticket.
          if (!(error instanceof Error) || !invalidations.has(error) || call.risk_tier !== 'read') return undefined;
          return async current => {
            const next = await waitForReadRevision(async () => {
              assertRecoveryActive();
              validateManifest(current.manifest);
              if (dispatchIdentity(current.stepMeta) !== capturedDispatch) throw operationChanged();
              validateInput(current.input);
              if ((await read()).revision !== revision) throw changed();
              assertRecoveryActive();
              validateOperation();
              return readCacheRevision(store, kind, name);
            }, recoverySignal);
            // A timed-out or interrupted writer never supplies a generation.
            if (next === undefined) return undefined;
            return bind(next, true);
          };
        },
      };
    };
    return bind(dataRevision);
  };
  return {
    cacheScope,
    /** Synchronous last fence immediately before a fresh transport operation. */
    assertRecoveryActive: () => active.getStore()?.assertRecoveryActive(),
    currentProcessIdentity: (spec: StdioMcpLaunchSpec) => {
      const captured = active.getStore()?.processIdentity;
      if (captured !== undefined) return captured;
      // Writes and explicitly fresh reads have no cache context. Use the same
      // physical identity so they can reuse a cached read's unchanged process.
      try { return options.processIdentity?.(spec); } catch { return undefined; }
    },
    validate: () => active.getStore()?.validate(),
    validateInput: (input: Record<string, unknown>) => active.getStore()?.validateInput(input),
    validateManifest: (manifest: IngredientManifest | null) => active.getStore()?.validateManifest(manifest),
    validateCall: (call: ResolvedCall) => active.getStore()?.validateCall(call),
    validateRecord: (row: ConnectionRow) => active.getStore()?.validateRecord(row),
  };
};
