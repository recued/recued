import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { makeUpdateHandlers, type UpdateApplyDeps, type UpdateModeDeps } from '../update-handler.js';
import type { ReleaseCheckDeps, ResolveForApplyResult } from '../update/release-check.js';
import type { ApplyOrchestratorPorts, RollbackContext } from '../update/apply-orchestrator.js';
import { createUpdateModeStore } from '../update/update-mode-store.js';

const stubDeps = (over: Partial<ReleaseCheckDeps> = {}): ReleaseCheckDeps => ({
  trustedPubkey: '', // not-configured → no fetch
  manifestUrl: 'https://x/manifest.json',
  fetchText: async () => { throw new Error('should not fetch'); },
  channel: 'stable',
  currentVersion: '1.3.0',
  platform: 'linux-x64',
  loadState: () => ({ salt: 's', highest_accepted_sequence: 0 }),
  saveState: () => { /* no-op */ },
  now: () => 0,
  ...over,
});

const stubModeDeps = (over: Partial<UpdateModeDeps> = {}): UpdateModeDeps => ({
  store: createUpdateModeStore(new Database(':memory:')),
  channel: 'binary',
  ...over,
});

const handlerDeps = (over: { releaseCheckDeps?: ReleaseCheckDeps; modeDeps?: UpdateModeDeps } = {}) => ({
  releaseCheckDeps: over.releaseCheckDeps ?? stubDeps(),
  modeDeps: over.modeDeps ?? stubModeDeps(),
});

// ── apply/rollback orchestrator stubs ───────────────────────────────
// An in-memory ledger + IO-success ports so the handler drives the REAL
// runApply / runRollback to a terminal; we assert the wire MAPPING (runApply
// itself has its own suite).
const memLedger = () => {
  const rows: import('../update/update-ledger.js').UpdateLedgerEntry[] = [];
  return {
    append: (e: import('../update/update-ledger.js').UpdateLedgerEntry) => rows.push(e),
    readAll: () => rows.slice(),
    tail: (n: number) => rows.slice(-n),
  };
};

const okPorts = (over: Partial<ApplyOrchestratorPorts> = {}): ApplyOrchestratorPorts => ({
  ledger: memLedger(),
  bootFailureCounter: { read: () => 0, increment: () => 1, reset: () => {} },
  download: async () => {},
  verifyArtifact: () => ({ ok: true }),
  preserveAndSwap: () => {},
  rollbackSwap: () => {},
  discardStaged: () => {},
  takeSnapshot: async () => {},
  restoreSnapshot: () => {},
  hasPreviousBinary: () => true,
  hasSnapshot: () => true,
  isQuiesced: () => true,
  requestRestart: vi.fn(),
  newEntryId: (() => { let n = 0; return () => `e${n++}`; })(),
  now: () => 1,
  trustedPubkey: 'pk',
  stagedPath: '/tmp/recued.staged',
  ...over,
});

const applyableResolution = (over: Partial<Extract<ResolveForApplyResult, { status: 'applyable' }>> = {}): ResolveForApplyResult => ({
  status: 'applyable',
  releaseIdentity: 'stable:1.4.0',
  fromVersion: '1.3.0',
  toVersion: '1.4.0',
  channel: 'stable',
  migration: false,
  isMajor: false,
  autoApplyEligible: true,
  artifact: { url: 'https://x/recued', sha256: 'abc', sig: 'RWS' },
  // An `applyable` resolution now always carries its native addon — a release
  // without one is refused as `no-artifact` upstream (D-178 item 4).
  libArtifact: { url: 'https://x/lib.node', sha256: 'def', sig: 'RWSlib' },
  webclientArtifact: null,
  ...over,
});

const stubApplyDeps = (over: Partial<UpdateApplyDeps> = {}): UpdateApplyDeps => ({
  ports: okPorts(),
  resolveForApply: async () => applyableResolution(),
  rollbackContext: (): RollbackContext | null => ({
    releaseIdentity: 'stable:1.3.0',
    fromVersion: '1.2.0',
    toVersion: '1.3.0',
    channel: 'stable',
    appliedMigration: false,
  }),
  ...over,
});

type Slice = NonNullable<ReturnType<typeof makeUpdateHandlers>>;
const call = <M extends keyof Slice['handlers']>(slice: Slice, method: M, args: unknown, client: unknown) =>
  (slice.handlers[method] as (a: unknown, c: unknown) => Promise<unknown>)(args, client);

const REG = { instance_id: 'web-1' };

describe('makeUpdateHandlers', () => {
  it('drops (undefined) when deps are absent → not_configured at the dispatcher', () => {
    expect(makeUpdateHandlers(undefined)).toBeUndefined();
  });

  it('rejects an unregistered client (no instance_id)', async () => {
    const slice = makeUpdateHandlers(handlerDeps());
    if (!slice) throw new Error('expected slice');
    await expect(call(slice, 'update.check', undefined, { instance_id: null })).rejects.toThrow(/registered paired client/);
  });

  it('delegates update.check to the orchestrator for a registered client', async () => {
    const slice = makeUpdateHandlers(handlerDeps());
    if (!slice) throw new Error('expected slice');
    const res = (await call(slice, 'update.check', undefined, REG)) as { status: string; current_version: string; channel: string };
    expect(res.status).toBe('not-configured');
    expect(res.current_version).toBe('1.3.0');
    expect(res.channel).toBe('stable');
  });

  it('update.mode reports the channel default when no override', async () => {
    const slice = makeUpdateHandlers(handlerDeps());
    if (!slice) throw new Error('expected slice');
    const res = (await call(slice, 'update.mode', undefined, REG)) as { mode: string; source: string };
    // `stubModeDeps` installs as `binary`, and D-178 moved every channel except
    // `docker-thin` to `notify` — a binary install stages a new server and runs
    // migrations against the owner's warehouse, so it asks rather than decides.
    // This asserted `auto`, which was the pre-D-178 default; the sibling
    // `update-mode-store.test.ts` was re-pinned at the time and this was missed.
    expect(res).toMatchObject({ mode: 'notify', source: 'default' });
  });

  it('update.set_mode persists a valid override', async () => {
    const slice = makeUpdateHandlers(handlerDeps());
    if (!slice) throw new Error('expected slice');
    const res = (await call(slice, 'update.set_mode', { mode: 'off' }, REG)) as { mode: string; source: string };
    expect(res).toMatchObject({ mode: 'off', source: 'user' });
  });

  it('update.set_mode rejects an invalid mode', async () => {
    const slice = makeUpdateHandlers(handlerDeps());
    if (!slice) throw new Error('expected slice');
    await expect(call(slice, 'update.set_mode', { mode: 'bogus' }, REG)).rejects.toThrow(/auto \| notify \| off/);
  });

  it('update.set_mode refuses an override when env pins the mode', async () => {
    const slice = makeUpdateHandlers(handlerDeps({ modeDeps: stubModeDeps({ envMode: 'notify' }) }));
    if (!slice) throw new Error('expected slice');
    await expect(call(slice, 'update.set_mode', { mode: 'off' }, REG)).rejects.toThrow(/pinned by RECUED_SELF_UPDATE/);
  });

  // ── update.apply / update.rollback ────────────────────────────────
  const applyHandler = (
    applyDeps?: UpdateApplyDeps,
    releaseCheckDeps: ReleaseCheckDeps = stubDeps(),
  ) => {
    const slice = makeUpdateHandlers({
      ...handlerDeps({ releaseCheckDeps }),
      ...(applyDeps ? { applyDeps } : {}),
    });
    if (!slice) throw new Error('expected slice');
    return slice;
  };

  it('update.apply requires a registered client', async () => {
    await expect(call(applyHandler(stubApplyDeps()), 'update.apply', {}, { instance_id: null })).rejects.toThrow(/registered/);
  });

  it('update.apply → not-applicable on a delegated channel (no applyDeps)', async () => {
    const res = (await call(applyHandler(undefined), 'update.apply', {}, REG)) as { status: string };
    expect(res.status).toBe('not-applicable');
  });

  it('update.apply stages + restarts on an applyable, non-major release', async () => {
    const restart = vi.fn();
    const deps = stubApplyDeps({ ports: okPorts({ requestRestart: restart }) });
    const res = (await call(applyHandler(deps), 'update.apply', {}, REG)) as {
      status: string;
      operation_id?: string;
      to_version?: string;
    };
    expect(res.status).toBe('restarting');
    expect(res.operation_id).toBe('e0');
    expect(res.to_version).toBe('1.4.0');
    expect(restart).toHaveBeenCalledOnce();
  });

  it('update.apply blocks a major bump unless forced (I-4)', async () => {
    const deps = stubApplyDeps({ resolveForApply: async () => applyableResolution({ isMajor: true }) });
    const blocked = (await call(applyHandler(deps), 'update.apply', {}, REG)) as { status: string };
    expect(blocked.status).toBe('major-blocked');
    const forced = (await call(applyHandler(deps), 'update.apply', { force: true }, REG)) as { status: string };
    expect(forced.status).toBe('restarting');
  });

  it('update.apply maps a non-applyable resolve to not-available', async () => {
    const deps = stubApplyDeps({ resolveForApply: async () => ({ status: 'up-to-date' }) });
    const res = (await call(applyHandler(deps), 'update.apply', {}, REG)) as { status: string };
    expect(res.status).toBe('not-available');
  });

  it('update.apply surfaces a verify failure (fail-closed)', async () => {
    const deps = stubApplyDeps({ ports: okPorts({ verifyArtifact: () => ({ ok: false, reason: 'sha256 mismatch' }) }) });
    const res = (await call(applyHandler(deps), 'update.apply', {}, REG)) as { status: string; detail?: string };
    expect(res.status).toBe('verify-failed');
    expect(res.detail).toMatch(/sha256/);
  });

  it('update.rollback → not-applicable without applyDeps', async () => {
    const res = (await call(applyHandler(undefined), 'update.rollback', undefined, REG)) as { status: string };
    expect(res.status).toBe('not-applicable');
  });

  it('update.rollback refuses when there is no prior committed release', async () => {
    const deps = stubApplyDeps({ rollbackContext: () => null });
    const res = (await call(applyHandler(deps), 'update.rollback', undefined, REG)) as { status: string };
    expect(res.status).toBe('refused');
  });

  it('update.rollback swaps back + restarts on a committed release', async () => {
    const restart = vi.fn();
    const deps = stubApplyDeps({ ports: okPorts({ requestRestart: restart }) });
    const res = (await call(applyHandler(deps), 'update.rollback', undefined, REG)) as {
      status: string;
      operation_id?: string;
    };
    expect(res.status).toBe('rolled-back');
    expect(res.operation_id).toBe('e0');
    expect(restart).toHaveBeenCalledOnce();
  });

  it('resolves an accepted operation receipt only for a registered owner', async () => {
    const deps = stubApplyDeps();
    const slice = applyHandler(deps);
    const applied = (await call(
      slice,
      'update.apply',
      {},
      REG,
    )) as { operation_id?: string };
    expect(applied.operation_id).toBe('e0');

    await expect(call(
      slice,
      'update.operation_status',
      { operation_id: 'e0' },
      { instance_id: null },
    )).rejects.toThrow(/registered/);
    await expect(call(
      slice,
      'update.operation_status',
      { operation_id: '../updates.log' },
      REG,
    )).rejects.toThrow(/opaque update receipt/);
    await expect(call(
      slice,
      'update.operation_status',
      { operation_id: 'e0', include_closed: 'yes' },
      REG,
    )).rejects.toThrow(/include_closed must be boolean/);

    expect(await call(
      slice,
      'update.operation_status',
      { operation_id: 'e0' },
      REG,
    )).toEqual({
      status: 'waiting_for_restart',
      operation: 'update',
    });
    expect(await call(
      applyHandler(
        deps,
        stubDeps({ currentVersion: '1.4.0' }),
      ),
      'update.operation_status',
      { operation_id: 'e0' },
      REG,
    )).toEqual({ status: 'completed', operation: 'update' });
    expect(await call(
      slice,
      'update.operation_status',
      { operation_id: 'missing' },
      REG,
    )).toEqual({ status: 'unknown' });
  });

  it('closes an unknown receipt in the server ledger and restores that closure', async () => {
    const deps = stubApplyDeps();
    const slice = applyHandler(deps);

    await expect(call(
      slice,
      'update.operation_close',
      {
        operation_id: 'lost-receipt',
        expected_operation: 'rollback',
      },
      { instance_id: null },
    )).rejects.toThrow(/registered/);
    await expect(call(
      slice,
      'update.operation_close',
      {
        operation_id: '../updates.log',
        expected_operation: 'rollback',
      },
      REG,
    )).rejects.toThrow(/opaque update receipt/);

    expect(await call(
      slice,
      'update.operation_close',
      {
        operation_id: 'lost-receipt',
        expected_operation: 'rollback',
      },
      REG,
    )).toEqual({
      status: 'closed_unresolved',
      operation: 'rollback',
    });
    expect(await call(
      slice,
      'update.operation_status',
      { operation_id: 'lost-receipt' },
      REG,
    )).toEqual({ status: 'unknown' });
    expect(await call(
      slice,
      'update.operation_status',
      {
        operation_id: 'lost-receipt',
        include_closed: true,
      },
      REG,
    )).toEqual({
      status: 'closed_unresolved',
      operation: 'rollback',
    });
  });

  it('refuses unresolved closure while an update is in flight', async () => {
    const deps = stubApplyDeps();
    const slice = applyHandler(deps);
    await call(slice, 'update.apply', {}, REG);

    expect(await call(
      slice,
      'update.operation_close',
      {
        operation_id: 'other-receipt',
        expected_operation: 'update',
      },
      REG,
    )).toEqual({
      status: 'refused',
      reason: 'operation_in_flight',
    });
  });

  it('reports unresolved closure unsupported without a self-apply ledger', async () => {
    expect(await call(
      applyHandler(undefined),
      'update.operation_close',
      {
        operation_id: 'lost-receipt',
        expected_operation: 'update',
      },
      REG,
    )).toEqual({
      status: 'refused',
      reason: 'not_supported',
    });
  });
});
