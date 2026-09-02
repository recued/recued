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
  // Supervised is the normal case; the un-supervised refusal is covered in
  // apply-orchestrator.test.ts, where the guard lives.
  supervisorWillRespawn: () => true,
  newEntryId: (() => { let n = 0; return () => `e${n++}`; })(),
  now: () => 1,
  trustedPubkey: 'pk',
  stagedPath: '/tmp/recued.staged',
  ...over,
});

const applyableResolution = (
  over: Partial<Extract<ResolveForApplyResult, { status: 'applyable' }>> = {},
): ResolveForApplyResult => {
  const result = {
    status: 'applyable' as const,
    releaseIdentity: 'stable:1.4.0',
    fromVersion: '1.3.0',
    toVersion: '1.4.0',
    channel: 'stable' as const,
    migration: false,
    isMajor: false,
    autoApplyEligible: true,
    inRolloutCohort: true,
    rolloutPct: 100,
    artifact: { url: 'https://x/recued', sha256: 'abc', sig: 'RWS' },
    libArtifact: { url: 'https://x/lib.node', sha256: 'def', sig: 'RWSlib' },
    webclientArtifact: null,
    ...over,
  };
  return {
    ...result,
    report: over.report ?? {
      status: 'update-available',
      current_version: result.fromVersion,
      channel: result.channel,
      sequence: 8,
      available: {
        version: result.toVersion,
        release_identity: result.releaseIdentity,
        migration: result.migration,
        is_major: result.isMajor,
        below_min_supported: false,
        in_rollout_cohort: result.inRolloutCohort,
        rollout_pct: result.rolloutPct,
        auto_apply_eligible: result.autoApplyEligible,
        notes_url: 'https://x/notes',
      },
    },
  };
};

const upToDateResolution = (): ResolveForApplyResult => ({
  status: 'up-to-date',
  report: { status: 'up-to-date', current_version: '1.3.0', channel: 'stable', sequence: 8 },
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

/** D-257 — `update.apply` no longer completes inside the rpc: it answers
 *  `applying` and reports the outcome on `update.progress`. Tests therefore have
 *  to let the backgrounded promise settle before asserting what happened, and
 *  read the RESULT off the bus rather than the response. */
const settle = (): Promise<void> => new Promise((r) => { setTimeout(r, 0); });
const terminalStatus = (events: { phase: string; status?: string }[]): string | undefined =>
  events.find((e) => e.phase === 'result')?.status;

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
  let emitted: { phase: string; status?: string; detail?: string; operation_id?: string }[] = [];
  const applyHandler = (
    applyDeps?: UpdateApplyDeps,
    releaseCheckDeps: ReleaseCheckDeps = stubDeps(),
  ) => {
    emitted = [];
    const slice = makeUpdateHandlers({
      ...handlerDeps({ releaseCheckDeps }),
      ...(applyDeps ? { applyDeps } : {}),
      broadcast: (event) => { emitted.push(event as typeof emitted[number]); },
    });
    if (!slice) throw new Error('expected slice');
    return slice;
  };

  /** ⛔⛔ RELEASE-BOUND CONSENT — enforced, not merely accepted.
   *
   *  Every consent field was checked ONLY WHEN SUPPLIED, so the hole was the
   *  ABSENCE of a claim rather than a wrong one: a caller could spend `force` on
   *  a release published after the one it reviewed, and an out-of-cohort apply
   *  needed no confirmation at all.
   *
   *  🔑 THE TWO HALVES ARE SCOPED DIFFERENTLY ON PURPOSE. `force` requires its
   *  binding from EVERY caller — it constrains only somebody already doing
   *  something deliberate. The rollout confirmation becomes a gate only under
   *  `strict`, and PERMANENTLY so: `rollout_pct: 0` is a standing decision, not
   *  a value waiting to move — whether a server applies an update by itself is
   *  the owner's preference. EVERY install is therefore out of cohort for good,
   *  and requiring it fleet-wide would refuse every update from every caller
   *  predating the field, forever. The opt-in is the long-term shape. */
  describe('release-bound consent', () => {
    const major = () => stubApplyDeps({
      resolveForApply: async () => applyableResolution({ isMajor: true }),
    });

    it('⛔ REFUSES `force` with no release binding, for any caller', async () => {
      await expect(call(applyHandler(major()), 'update.apply', { force: true }, REG))
        .rejects.toThrow(/force requires expected_release_identity/);
    });

    it('and accepts it when bound — the arm that proves the refusal is not blanket', async () => {
      const res = (await call(
        applyHandler(major()), 'update.apply',
        { force: true, expected_release_identity: 'stable:1.4.0' }, REG,
      )) as { status: string };
      await settle();
      expect(res.status).toBe('applying');
    });

    it('⛔ under `strict`, an out-of-cohort apply must carry the confirmation', async () => {
      const deps = stubApplyDeps({
        resolveForApply: async () => applyableResolution({ inRolloutCohort: false }),
      });
      await expect(call(
        applyHandler(deps), 'update.apply',
        { strict: true, expected_release_identity: 'stable:1.4.0' }, REG,
      )).rejects.toThrow(/requires confirm_rollout/);
    });

    it('...and passes once it does', async () => {
      const deps = stubApplyDeps({
        resolveForApply: async () => applyableResolution({ inRolloutCohort: false }),
      });
      const res = (await call(
        applyHandler(deps), 'update.apply',
        { strict: true, expected_release_identity: 'stable:1.4.0', confirm_rollout: true }, REG,
      )) as { status: string };
      await settle();
      expect(res.status).toBe('applying');
    });

    it('⛔⛔ but WITHOUT `strict` it is still audited, never refused', async () => {
      // The line that must not move, and not "until rollout_pct changes":
      // `rollout_pct: 0` is a standing decision, so every install is out of
      // cohort permanently and refusing here would block every owner from
      // updating at all, forever. That is why the confirmation is the client's
      // job and only the AUDIT is the server's.
      const deps = stubApplyDeps({
        resolveForApply: async () => applyableResolution({ inRolloutCohort: false }),
      });
      const res = (await call(applyHandler(deps), 'update.apply', {}, REG)) as { status: string };
      await settle();
      expect(res.status, 'an older caller must still be able to update').toBe('applying');
    });

    it('⛔ `strict` without a binding is refused rather than half-honoured', async () => {
      await expect(call(applyHandler(stubApplyDeps()), 'update.apply', { strict: true }, REG))
        .rejects.toThrow(/strict apply requires expected_release_identity/);
    });
  });

  /** ⛔⛔ THE RECEIPT MUST SURVIVE AN UNCERTAIN DELIVERY.
   *
   *  The server already RESERVED `operation_id` before starting work, precisely so
   *  a caller that goes away can ask `update.operation_status` what became of it —
   *  but it travelled only on the REPLY. A socket lost between acceptance and that
   *  reply left the update running and the caller with nothing to name it by,
   *  which is the one case the reservation exists for. A caller may now name its
   *  own receipt before the request leaves. */
  describe('a caller-supplied operation_id', () => {
    const CALLER_ID = '11111111-2222-4333-8444-555555555555';

    it('becomes the receipt the run is known by', async () => {
      const res = (await call(
        applyHandler(stubApplyDeps()), 'update.apply', { operation_id: CALLER_ID }, REG,
      )) as { status: string; operation_id?: string };
      await settle();
      expect(res.status).toBe('applying');
      expect(res.operation_id, 'the server must adopt it, not mint its own').toBe(CALLER_ID);
    });

    it('is durable and queryable before manifest resolution yields', async () => {
      let finishResolve!: (value: ResolveForApplyResult) => void;
      const pendingResolve = new Promise<ResolveForApplyResult>((resolve) => {
        finishResolve = resolve;
      });
      const deps = stubApplyDeps({ resolveForApply: () => pendingResolve });
      const slice = applyHandler(deps);
      const request = call(
        slice,
        'update.apply',
        { operation_id: CALLER_ID },
        REG,
      );
      await settle();

      expect(deps.ports.ledger.readAll()).toContainEqual(expect.objectContaining({
        kind: 'operation_reserved',
        reserved_operation_id: CALLER_ID,
      }));
      expect(await call(
        slice,
        'update.operation_status',
        { operation_id: CALLER_ID },
        REG,
      )).toEqual({ status: 'waiting_for_restart', operation: 'update' });

      finishResolve(upToDateResolution());
      expect(await request).toEqual({ status: 'not-available' });
      expect(await call(
        slice,
        'update.operation_status',
        { operation_id: CALLER_ID },
        REG,
      )).toEqual({ status: 'reverted', operation: 'update' });
    });

    it('still mints one when the caller names none — an older client is unchanged', async () => {
      const res = (await call(applyHandler(stubApplyDeps()), 'update.apply', {}, REG)) as {
        status: string; operation_id?: string;
      };
      await settle();
      expect(res.status).toBe('applying');
      // ⚠ NOT a UUID assertion — this harness's `newEntryId` counts (`e0`, `e1`).
      // What matters is that a receipt is still ISSUED, and that it is not the
      // caller's, since the caller named none.
      expect(res.operation_id, 'a receipt is always issued').toBeTruthy();
      expect(res.operation_id).not.toBe(CALLER_ID);
    });

    it('⛔ REFUSES a malformed id rather than quietly substituting its own', async () => {
      // Substituting would hand back an id the caller cannot match if the REPLY is
      // the thing that goes missing — the exact failure this field removes. It
      // would also put a non-UUID into the ledger's dedup key.
      const deps = stubApplyDeps();
      await expect(call(applyHandler(deps), 'update.apply', { operation_id: 'not-a-uuid' }, REG))
        .rejects.toThrow(/operation_id must be a UUID/);
      await settle();
      expect(deps.ports.ledger.readAll(), 'and no run may have started').toEqual([]);
    });

    it('⛔ REFUSES an id already in the ledger — a receipt names ONE run', async () => {
      const deps = stubApplyDeps();
      deps.ports.ledger.append({
        id: CALLER_ID, kind: 'apply_started', at: 1,
        from_version: '1.2.0', to_version: '1.3.0', channel: 'stable',
        trigger: 'manual', release_identity: 'stable:1.3.0',
      });
      await expect(call(applyHandler(deps), 'update.apply', { operation_id: CALLER_ID }, REG))
        .rejects.toThrow(/already in use/);
      await settle();
      // Two operations sharing a receipt would be indistinguishable to
      // `update.operation_status`, which is all a caller has after a restart.
      expect(deps.ports.ledger.readAll().filter((e) => e.id === CALLER_ID)).toHaveLength(1);
    });
  });

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
    // D-257 — the rpc ACCEPTS; it does not wait. `restarting` is now the
    // terminal status on the bus, not the response.
    expect(res.status).toBe('applying');
    expect(res.to_version).toBe('1.4.0');
    await settle();
    expect(restart).toHaveBeenCalledOnce();
    expect(terminalStatus(emitted)).toBe('restarting');
  });

  it('update.apply blocks a major bump unless forced (I-4)', async () => {
    const deps = stubApplyDeps({ resolveForApply: async () => applyableResolution({ isMajor: true }) });
    const blocked = (await call(applyHandler(deps), 'update.apply', {}, REG)) as { status: string };
    expect(blocked.status).toBe('major-blocked');
    // ⚠ THE FORCE NOW HAS TO NAME ITS RELEASE. `force` means "I have read the
    // notes for this MAJOR version", and the server resolves again after the
    // click, so an unbound one can answer for a release published in between.
    const forced = (await call(
      applyHandler(deps), 'update.apply', { force: true, expected_release_identity: 'stable:1.4.0' }, REG,
    )) as { status: string };
    expect(forced.status).toBe('applying');
    await settle();
    expect(terminalStatus(emitted)).toBe('restarting');
  });

  // ⛔⛔ THE RECEIPT REACHED ONLY THE CALLER THAT DID NOT NEED IT. `applying`
  // returns immediately and the id used to ride the TERMINAL bus event — so a
  // caller still listening got it, and a caller that navigated away, reloaded, or
  // never listened at all had no way to ask what became of its own operation.
  it('update.apply returns the operation id at ACCEPTANCE, and it names the ledger entry', async () => {
    const ports = okPorts();
    const deps = stubApplyDeps({ ports });
    const res = (await call(applyHandler(deps), 'update.apply', {}, REG)) as {
      status: string;
      operation_id?: string;
    };
    expect(res.status).toBe('applying');
    expect(res.operation_id).toEqual(expect.any(String));
    await settle();
    // The id is the `apply_started` entry's — the one `update.operation_status`
    // looks the operation up by. A different id would resolve to `unknown`.
    const started = ports.ledger.readAll().find((e) => e.kind === 'apply_started');
    expect(started?.id).toBe(res.operation_id);
  });

  // ⛔⛔ CONSENT BELONGS TO A RELEASE. The client reviewed one card; the server
  // re-fetches the feed and resolves again. A publish between the two would
  // otherwise answer the owner's "yes" — `force`, i.e. "I read the notes for THIS
  // major version", included — for a version they never saw.
  it('update.apply refuses review-stale when the feed moved under the reviewed release', async () => {
    const deps = stubApplyDeps({ resolveForApply: async () => applyableResolution({ isMajor: true }) });
    const res = (await call(
      applyHandler(deps),
      'update.apply',
      { force: true, expected_release_identity: 'stable:1.3.9' },
      REG,
    )) as { status: string; release_identity?: string; to_version?: string };
    expect(res.status).toBe('review-stale');
    // It names what IS offered, so the client can re-render and ask again.
    expect(res.release_identity).toBe('stable:1.4.0');
    expect(res.to_version).toBe('1.4.0');
  });

  it('update.apply proceeds when the binding matches the resolved release', async () => {
    const deps = stubApplyDeps();
    const res = (await call(
      applyHandler(deps),
      'update.apply',
      { expected_release_identity: 'stable:1.4.0' },
      REG,
    )) as { status: string };
    expect(res.status).toBe('applying');
  });

  // ⚠ An older client sends neither field. It must keep working exactly as it
  // did — there is no deploy order to rely on when the client is always-newest
  // and the server is whatever its owner installed.
  it('update.apply is unbound when no expectation is supplied', async () => {
    const deps = stubApplyDeps();
    const res = (await call(applyHandler(deps), 'update.apply', {}, REG)) as { status: string };
    expect(res.status).toBe('applying');
  });

  // The audit half of "an EXPLICIT, confirmed, AUDITED act". The server does not
  // gate on it (`rollout_pct: 0` is a standing decision, so a gate blocks every
  // owner permanently) — it records what the client reported, and says nothing
  // when it reported nothing.
  it('update.apply records a client-confirmed rollout bypass distinguishably', async () => {
    const confirmedPorts = okPorts();
    const resolution = async (): Promise<ResolveForApplyResult> =>
      applyableResolution({ inRolloutCohort: false, rolloutPct: 25 });

    await call(
      applyHandler(stubApplyDeps({ ports: confirmedPorts, resolveForApply: resolution })),
      'update.apply',
      { confirm_rollout: true },
      REG,
    );
    await settle();
    const confirmed = confirmedPorts.ledger.readAll().find((entry) => entry.kind === 'apply_started');
    expect(String(confirmed?.detail)).toContain('outside the 25% cohort');
    expect(String(confirmed?.detail)).toContain('confirmed by the client');

    const silentPorts = okPorts();
    await call(
      applyHandler(stubApplyDeps({ ports: silentPorts, resolveForApply: resolution })),
      'update.apply',
      {},
      REG,
    );
    await settle();
    const silent = silentPorts.ledger.readAll().find((entry) => entry.kind === 'apply_started');
    expect(String(silent?.detail)).toContain('outside the 25% cohort');
    // ⚠ SAYS NOTHING RATHER THAN ACCUSING. Absence means the client could not
    // report, not that nobody was asked.
    expect(String(silent?.detail)).not.toContain('confirmed');
  });

  it('update.apply maps a non-applyable resolve to not-available', async () => {
    const deps = stubApplyDeps({ resolveForApply: async () => upToDateResolution() });
    const res = (await call(applyHandler(deps), 'update.apply', {}, REG)) as { status: string };
    expect(res.status).toBe('not-available');
  });

  it('update.apply surfaces a verify failure (fail-closed)', async () => {
    const deps = stubApplyDeps({ ports: okPorts({ verifyArtifact: () => ({ ok: false, reason: 'sha256 mismatch' }) }) });
    const res = (await call(applyHandler(deps), 'update.apply', {}, REG)) as { status: string; detail?: string };
    expect(res.status).toBe('applying');
    await settle();
    expect(terminalStatus(emitted)).toBe('verify-failed');
    expect(emitted.find((e) => e.phase === 'result')?.detail).toMatch(/sha256/);
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
    await settle();
    expect(restart).toHaveBeenCalledOnce();
  });

  it('⛔ update.rollback uses the caller-reserved receipt as the rollback ledger id', async () => {
    const operationId = '7fe3a0b2-f0c9-4e3d-9a0c-2d58efc24d93';
    const ports = okPorts();
    const deps = stubApplyDeps({ ports });
    const res = (await call(
      applyHandler(deps),
      'update.rollback',
      { operation_id: operationId },
      REG,
    )) as { status: string; operation_id?: string };
    expect(res).toMatchObject({ status: 'rolled-back', operation_id: operationId });
    expect(ports.ledger.readAll().at(-1)?.id).toBe(operationId);
  });

  it('refuses before swapping when the write-ahead rollback receipt cannot commit', async () => {
    const operationId = '43d9d540-2fb9-43b0-84ae-c55a3f5bc8c1';
    const restart = vi.fn();
    const ports = okPorts({ requestRestart: restart });
    ports.ledger.append = (entry) => {
      if (entry.kind === 'rolled_back') throw new Error('receipt volume full');
    };
    const deps = stubApplyDeps({ ports });

    const res = (await call(
      applyHandler(deps),
      'update.rollback',
      { operation_id: operationId },
      REG,
    )) as { status: string; operation_id?: string; detail?: string };

    expect(res).toMatchObject({
      status: 'refused',
      detail: expect.stringMatching(/before swapping the binary/),
    });
    expect(restart).not.toHaveBeenCalled();
  });

  it('reports a committed rollback whose pair swap will finish during restart', async () => {
    const operationId = 'c6ec75b6-d52b-4ce8-b370-ad5863852d91';
    const restart = vi.fn();
    const ports = okPorts({
      requestRestart: restart,
      rollbackSwap: () => { throw new Error('rename failed'); },
    });
    const deps = stubApplyDeps({ ports });

    const res = (await call(
      applyHandler(deps),
      'update.rollback',
      { operation_id: operationId },
      REG,
    )) as { status: string; operation_id?: string; recovery_pending?: boolean; detail?: string };

    expect(res).toMatchObject({
      status: 'rolled-back',
      operation_id: operationId,
      recovery_pending: true,
      detail: expect.stringMatching(/completed before the restarted server opens/),
    });
    expect(restart).toHaveBeenCalledOnce();
  });

  it('update.rollback refuses malformed caller receipts before touching disk', async () => {
    const rollbackSwap = vi.fn();
    const deps = stubApplyDeps({ ports: okPorts({ rollbackSwap }) });
    await expect(call(
      applyHandler(deps),
      'update.rollback',
      { operation_id: 'not-a-uuid' },
      REG,
    )).rejects.toThrow(/operation_id must be a UUID/);
    expect(rollbackSwap).not.toHaveBeenCalled();
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
    // D-257 — the receipt arrives with the terminal emit, not the response.
    await settle();
    const receipt = emitted.find((e) => e.phase === 'result')?.operation_id;
    expect(receipt).toBe('e0');

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
