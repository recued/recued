import { describe, expect, it, vi } from 'vitest';

import type { ReleaseCheckResponse } from '@recued/contracts';

import type { WebclientConnectionStatus } from '../realtime/connection-status.js';
import {
  CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
  classifyCredentialRotationServerUpdateTriage,
  createCredentialRotationServerUpdateContinuity,
  type CredentialRotationServerUpdateContinuityStorage,
} from './credential-rotation-server-update-continuity.js';

const storageHarness = (): {
  storage: CredentialRotationServerUpdateContinuityStorage;
  values: Map<string, string>;
} => {
  const values = new Map<string, string>();
  return {
    values,
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => {
        values.delete(key);
      },
    },
  };
};

const statusHarness = (initial: WebclientConnectionStatus) => {
  let current = initial;
  const listeners = new Set<(status: WebclientConnectionStatus) => void>();
  return {
    status: () => current,
    onStatus: (listener: (status: WebclientConnectionStatus) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next: WebclientConnectionStatus) {
      current = next;
      for (const listener of [...listeners]) listener(next);
    },
    listenerCount: () => listeners.size,
  };
};

describe('credential-rotation server-update continuity', () => {
  it('persists only the secret-free scope, identity, and evidence envelope through reload', () => {
    const persisted = storageHarness();
    const firstStatus = statusHarness('connected');
    const first = createCredentialRotationServerUpdateContinuity({
      storage: persisted.storage,
      scopeId: 'profile-a',
      status: firstStatus.status,
      onStatus: firstStatus.onStatus,
      now: () => 100,
    });

    first.begin({ kind: 'api', name: 'github-main' });
    expect(first.isDurable()).toBe(true);
    const raw = persisted.values.get(
      CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
    );
    expect(raw).toBeDefined();
    expect(JSON.parse(raw!)).toEqual({
      version: 2,
      scope_id: 'profile-a',
      kind: 'api',
      name: 'github-main',
      phase: 'guide',
      started_at: 100,
      baseline_version: null,
      triage_reason: null,
      triage_check_status: null,
      triage_current_version: null,
      triage_channel: null,
      triage_available_version: null,
    });
    expect(raw).not.toMatch(/credential|secret|token|form/i);
    first.dispose();

    // A fresh boot starts non-connected. Its first healthy connection proves
    // the update/restart boundary and unlocks the exact retry.
    const restoredStatus = statusHarness('connecting');
    const restored = createCredentialRotationServerUpdateContinuity({
      storage: persisted.storage,
      scopeId: 'profile-a',
      status: restoredStatus.status,
      onStatus: restoredStatus.onStatus,
      now: () => 101,
    });
    expect(restored.read()).toEqual({
      kind: 'api',
      name: 'github-main',
      phase: 'guide',
      startedAt: 100,
    });
    expect(restored.isDurable()).toBe(true);
    restoredStatus.set('connected');
    expect(restored.read()?.phase).toBe('ready');
    expect(JSON.parse(persisted.values.get(
      CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
    )!)).toMatchObject({ phase: 'ready' });
    restored.dispose();
  });

  it('persists running-version evidence and turns a repeated miss into durable triage', () => {
    const persisted = storageHarness();
    const status = statusHarness('connected');
    const continuity = createCredentialRotationServerUpdateContinuity({
      storage: persisted.storage,
      scopeId: 'profile-a',
      status: status.status,
      onStatus: status.onStatus,
      now: () => 100,
    });
    const target = { kind: 'api' as const, name: 'github-main' };
    continuity.begin(target);
    continuity.recordServerCheck(target, {
      status: 'update-available',
      current_version: '26.7.3',
      channel: 'stable',
      available: {
        version: '26.8.0',
        migration: false,
        is_major: false,
        below_min_supported: false,
        in_rollout_cohort: true,
        auto_apply_eligible: true,
        notes_url: '',
      },
    });
    expect(continuity.read()?.baselineVersion).toBe('26.7.3');

    const triage = continuity.markStillUnsupported(target, {
      status: 'up-to-date',
      current_version: '26.7.3',
      channel: 'stable',
      detail: 'server_url=wss://private.example token=must-not-persist',
    });
    expect(triage).toEqual({
      reason: 'running_version_unchanged',
      checkStatus: 'up-to-date',
      baselineVersion: '26.7.3',
      currentVersion: '26.7.3',
      channel: 'stable',
    });
    expect(continuity.read()?.phase).toBe('triage');
    const raw = persisted.values.get(
      CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
    )!;
    expect(JSON.parse(raw)).toMatchObject({
      version: 2,
      phase: 'triage',
      baseline_version: '26.7.3',
      triage_reason: 'running_version_unchanged',
      triage_check_status: 'up-to-date',
      triage_current_version: '26.7.3',
      triage_channel: 'stable',
    });
    expect(raw).not.toMatch(/credential|secret|token|server_url/i);
    continuity.dispose();

    const restoredStatus = statusHarness('reconnecting');
    const restored = createCredentialRotationServerUpdateContinuity({
      storage: persisted.storage,
      scopeId: 'profile-a',
      status: restoredStatus.status,
      onStatus: restoredStatus.onStatus,
      now: () => 101,
    });
    expect(restored.read()?.serverUpdateTriage).toEqual(triage);
    restoredStatus.set('connected');
    expect(restored.read()?.phase).toBe('triage');
    restored.dispose();
  });

  it('restores v1 continuity without inventing a post-restart baseline', () => {
    const persisted = storageHarness();
    persisted.values.set(
      CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
      JSON.stringify({
        version: 1,
        scope_id: 'profile-a',
        kind: 'api',
        name: 'github-main',
        phase: 'ready',
        started_at: 100,
      }),
    );
    const status = statusHarness('connected');
    const continuity = createCredentialRotationServerUpdateContinuity({
      storage: persisted.storage,
      scopeId: 'profile-a',
      status: status.status,
      onStatus: status.onStatus,
      now: () => 101,
    });
    const target = { kind: 'api' as const, name: 'github-main' };

    continuity.recordServerCheck(target, {
      status: 'up-to-date',
      current_version: '26.8.0',
      channel: 'stable',
    });
    expect(continuity.read()).toEqual({
      ...target,
      phase: 'ready',
      startedAt: 100,
    });
    expect(JSON.parse(persisted.values.get(
      CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
    )!)).toMatchObject({ version: 1, phase: 'ready' });

    expect(continuity.markStillUnsupported(target, {
      status: 'up-to-date',
      current_version: '26.8.0',
      channel: 'stable',
    })).toMatchObject({
      reason: 'current_build_missing_capability',
      currentVersion: '26.8.0',
    });
    expect(JSON.parse(persisted.values.get(
      CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
    )!)).toMatchObject({ version: 2, phase: 'triage' });
    continuity.dispose();
  });

  it('classifies changed, still-available, delegated, and inconclusive servers without guessing', () => {
    const check = (
      over: Partial<ReleaseCheckResponse>,
    ): ReleaseCheckResponse => ({
      status: 'up-to-date',
      current_version: '26.8.0',
      channel: 'stable',
      ...over,
    });
    expect(classifyCredentialRotationServerUpdateTriage(
      '26.7.3',
      check({}),
    ).reason).toBe('running_version_changed');
    expect(classifyCredentialRotationServerUpdateTriage(
      '26.7.3',
      check({
        status: 'update-available',
        available: {
          version: '26.9.0',
          migration: false,
          is_major: false,
          below_min_supported: false,
          in_rollout_cohort: true,
          auto_apply_eligible: true,
          notes_url: '',
        },
      }),
    )).toMatchObject({
      reason: 'update_still_available',
      availableVersion: '26.9.0',
    });
    expect(classifyCredentialRotationServerUpdateTriage(
      undefined,
      check({ status: 'not-configured' }),
    ).reason).toBe('self_update_unavailable');
    expect(classifyCredentialRotationServerUpdateTriage(
      undefined,
      null,
    )).toEqual({
      reason: 'release_check_inconclusive',
      checkStatus: 'unavailable',
    });
    for (const status of [
      'stale-feed',
      'replay',
      'fetch-failed',
      'bad-signature',
    ] as const) {
      expect(classifyCredentialRotationServerUpdateTriage(
        '26.7.3',
        check({ status, current_version: '26.7.3' }),
      )).toMatchObject({
        reason: 'release_check_inconclusive',
        checkStatus: status,
        currentVersion: '26.7.3',
      });
    }
  });

  it('does not claim a newer in-memory phase is reload-safe after persistence fails', () => {
    const values = new Map<string, string>();
    let writeCount = 0;
    const storage: CredentialRotationServerUpdateContinuityStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        writeCount += 1;
        if (writeCount > 1) throw new Error('storage became unavailable');
        values.set(key, value);
      },
      removeItem: (key) => {
        values.delete(key);
      },
    };
    const status = statusHarness('connected');
    const target = { kind: 'api' as const, name: 'github-main' };
    const continuity = createCredentialRotationServerUpdateContinuity({
      storage,
      scopeId: 'profile-a',
      status: status.status,
      onStatus: status.onStatus,
      now: () => 100,
    });

    continuity.begin(target);
    expect(continuity.isDurable()).toBe(true);
    continuity.markStillUnsupported(target, {
      status: 'up-to-date',
      current_version: '26.8.0',
      channel: 'stable',
    });

    expect(continuity.read()?.phase).toBe('triage');
    expect(continuity.isDurable()).toBe(false);
    expect(values.has(
      CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
    )).toBe(false);
    continuity.dispose();
  });

  it('waits for the accepted update to disconnect and reconnect before retry', () => {
    const persisted = storageHarness();
    const status = statusHarness('connected');
    const continuity = createCredentialRotationServerUpdateContinuity({
      storage: persisted.storage,
      scopeId: 'profile-a',
      status: status.status,
      onStatus: status.onStatus,
      now: () => 100,
    });
    const changes = vi.fn();
    continuity.subscribe(changes);
    continuity.begin({ kind: 'mcp', name: 'notion' });
    continuity.markAwaitingReconnect({ kind: 'mcp', name: 'notion' });
    expect(continuity.read()?.phase).toBe('awaiting_reconnect');

    // A stale result from another card cannot claim or clear this target.
    continuity.markAwaitingReconnect({ kind: 'api', name: 'github-main' });
    continuity.retire({ kind: 'api', name: 'github-main' });
    expect(continuity.read()?.name).toBe('notion');

    status.set('reconnecting');
    expect(continuity.read()?.phase).toBe('awaiting_reconnect');
    status.set('connected');
    expect(continuity.read()?.phase).toBe('ready');
    // A late apply receipt cannot move a connection that already crossed the
    // restart boundary back into a permanent waiting state.
    continuity.markAwaitingReconnect({ kind: 'mcp', name: 'notion' });
    expect(continuity.read()?.phase).toBe('ready');
    expect(changes).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'mcp',
      name: 'notion',
      phase: 'ready',
    }));
    continuity.retire({ kind: 'mcp', name: 'notion' });
    expect(continuity.read()).toBeNull();
    expect(persisted.values.has(
      CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
    )).toBe(false);
    continuity.dispose();
  });

  it('keeps route continuity honest when session storage is unavailable', () => {
    const status = statusHarness('connected');
    const continuity = createCredentialRotationServerUpdateContinuity({
      storage: null,
      scopeId: 'profile-a',
      status: status.status,
      onStatus: status.onStatus,
      now: () => 100,
    });
    continuity.begin({ kind: 'api', name: 'github-main' });

    expect(continuity.read()?.name).toBe('github-main');
    expect(continuity.isDurable()).toBe(false);
    continuity.dispose();
  });

  it('does not expose or erase another profile\'s exact retry', () => {
    const persisted = storageHarness();
    const status = statusHarness('connected');
    const profileA = createCredentialRotationServerUpdateContinuity({
      storage: persisted.storage,
      scopeId: 'profile-a',
      status: status.status,
      onStatus: status.onStatus,
      now: () => 100,
    });
    profileA.begin({ kind: 'notification', name: 'pagerduty' });
    profileA.dispose();

    const profileB = createCredentialRotationServerUpdateContinuity({
      storage: persisted.storage,
      scopeId: 'profile-b',
      status: status.status,
      onStatus: status.onStatus,
      now: () => 101,
    });
    expect(profileB.read()).toBeNull();
    expect(persisted.values.has(
      CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
    )).toBe(true);
    profileB.dispose();

    const profileARestored = createCredentialRotationServerUpdateContinuity({
      storage: persisted.storage,
      scopeId: 'profile-a',
      status: status.status,
      onStatus: status.onStatus,
      now: () => 102,
    });
    expect(profileARestored.read()?.name).toBe('pagerduty');
    profileARestored.dispose();
  });

  it('replaces only matching triage with a one-shot result that cannot replay or be overwritten late', () => {
    const persisted = storageHarness();
    const status = statusHarness('connected');
    const continuity = createCredentialRotationServerUpdateContinuity({
      storage: persisted.storage,
      scopeId: 'profile-a',
      status: status.status,
      onStatus: status.onStatus,
      now: () => 100,
    });
    const target = { kind: 'api' as const, name: 'github-main' };
    continuity.begin(target);
    continuity.recordServerCheck(target, {
      status: 'up-to-date',
      current_version: '26.7.3',
      channel: 'stable',
    });
    continuity.markStillUnsupported(target, null);
    const listener = vi.fn();
    continuity.subscribe(listener);

    expect(continuity.markCapabilityResolvedElsewhere({
      kind: 'api',
      name: 'other-connection',
    })).toBe(false);
    expect(continuity.read()?.phase).toBe('triage');

    expect(continuity.markCapabilityResolvedElsewhere(target)).toBe(true);
    expect(continuity.read()).toEqual({
      ...target,
      phase: 'resolved_elsewhere',
      startedAt: 100,
    });
    expect(continuity.isDurable()).toBe(false);
    expect(persisted.values.has(
      CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
    )).toBe(false);
    expect(listener).toHaveBeenLastCalledWith({
      ...target,
      phase: 'resolved_elsewhere',
      startedAt: 100,
    });

    // An older update check, apply result, or reconnect cannot replace the
    // newer sibling-confirmed receipt after its await settles.
    expect(continuity.markStillUnsupported(target, null)).toBeNull();
    continuity.markAwaitingReconnect(target, '26.7.3');
    status.set('reconnecting');
    status.set('connected');
    expect(continuity.read()?.phase).toBe('resolved_elsewhere');
    continuity.dispose();

    const reloaded = createCredentialRotationServerUpdateContinuity({
      storage: persisted.storage,
      scopeId: 'profile-a',
      status: status.status,
      onStatus: status.onStatus,
      now: () => 101,
    });
    expect(reloaded.read()).toBeNull();
    reloaded.dispose();
  });

  it('re-arms an explicitly resumed sibling result as a durable exact retry', () => {
    const persisted = storageHarness();
    const status = statusHarness('connected');
    const target = { kind: 'api' as const, name: 'github-main' };
    const continuity = createCredentialRotationServerUpdateContinuity({
      storage: persisted.storage,
      scopeId: 'profile-a',
      status: status.status,
      onStatus: status.onStatus,
      now: () => 100,
    });
    continuity.begin(target);
    continuity.markStillUnsupported(target, null);
    expect(continuity.markCapabilityResolvedElsewhere(target)).toBe(true);

    expect(continuity.resumeResolvedRetry({
      kind: 'api',
      name: 'other-connection',
    })).toBe(false);
    expect(continuity.resumeResolvedRetry(target)).toBe(true);
    expect(continuity.read()).toEqual({
      ...target,
      phase: 'ready',
      startedAt: 100,
    });
    expect(continuity.isDurable()).toBe(true);
    expect(JSON.parse(persisted.values.get(
      CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
    )!)).toMatchObject({
      version: 2,
      scope_id: 'profile-a',
      ...target,
      phase: 'ready',
      started_at: 100,
    });
    continuity.dispose();

    const reloaded = createCredentialRotationServerUpdateContinuity({
      storage: persisted.storage,
      scopeId: 'profile-a',
      status: status.status,
      onStatus: status.onStatus,
      now: () => 101,
    });
    expect(reloaded.read()).toEqual({
      ...target,
      phase: 'ready',
      startedAt: 100,
    });
    reloaded.dispose();
  });

  it('overlays tab progress in memory without widening the durable exact-retry envelope', () => {
    const persisted = storageHarness();
    const status = statusHarness('connected');
    const target = { kind: 'api' as const, name: 'github-main' };
    const continuity = createCredentialRotationServerUpdateContinuity({
      storage: persisted.storage,
      scopeId: 'profile-a',
      status: status.status,
      onStatus: status.onStatus,
      now: () => 100,
    });
    continuity.begin(target);
    continuity.markStillUnsupported(target, {
      status: 'up-to-date',
      current_version: '26.7.3',
      channel: 'stable',
    });
    const before = persisted.values.get(
      CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
    )!;

    continuity.observeServerUpdateProgress({
      phase: 'applying',
      operation: 'update',
      startedAt: 101,
    });
    expect(continuity.read()).toMatchObject({
      ...target,
      phase: 'triage',
      serverUpdateProgress: {
        phase: 'applying',
        operation: 'update',
        startedAt: 101,
      },
    });
    expect(persisted.values.get(
      CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
    )).toBe(before);
    expect(before).not.toMatch(
      /server-update-progress|applying|awaiting_reconnect|operation|startedAt/i,
    );

    continuity.observeServerUpdateProgress({
      phase: 'awaiting_reconnect',
      operation: 'update',
      startedAt: 101,
    });
    expect(continuity.read()?.serverUpdateProgress?.operationId)
      .toBeUndefined();
    // Acceptance may attach the receipt without changing phase/operation/time.
    // That exact lineage change must still reach every mounted surface.
    continuity.observeServerUpdateProgress({
      phase: 'awaiting_reconnect',
      operation: 'update',
      startedAt: 101,
      operationId: 'server-ledger-receipt',
    });
    expect(continuity.read()?.serverUpdateProgress?.phase)
      .toBe('awaiting_reconnect');
    expect(continuity.read()?.serverUpdateProgress?.operationId)
      .toBe('server-ledger-receipt');
    expect(persisted.values.get(
      CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
    )).toBe(before);
    expect(before).not.toContain('server-ledger-receipt');
    continuity.observeServerUpdateVerification({
      phase: 'unknown',
      operation: 'update',
      startedAt: 101,
      reason: 'unknown_receipt',
    });
    expect(continuity.read()?.serverUpdateVerification).toEqual({
      phase: 'unknown',
      operation: 'update',
      startedAt: 101,
      reason: 'unknown_receipt',
    });
    expect(persisted.values.get(
      CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
    )).toBe(before);
    continuity.observeServerUpdateVerification({
      phase: 'baseline_confirmed',
      operation: 'update',
      startedAt: 101,
      reason: 'server_closed_unresolved',
      baseline: {
        currentVersion: '26.8.1',
        channel: 'stable',
        updateStatus: 'up-to-date',
        affectedConnection: {
          kind: 'api',
          name: 'github-main',
          activity: 'idle',
        },
      },
    });
    const baselineSnapshot = continuity.read()?.serverUpdateVerification;
    expect(baselineSnapshot?.baseline).toMatchObject({
      currentVersion: '26.8.1',
      affectedConnection: { name: 'github-main', activity: 'idle' },
    });
    if (baselineSnapshot?.baseline?.affectedConnection !== undefined) {
      (baselineSnapshot.baseline.affectedConnection as { name: string }).name =
        'mutated-outside';
    }
    expect(
      continuity.read()?.serverUpdateVerification?.baseline?.affectedConnection
        ?.name,
    ).toBe('github-main');
    expect(persisted.values.get(
      CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
    )).toBe(before);
    expect(before).not.toMatch(/26\.8\.1|baseline_confirmed/);
    continuity.observeServerUpdateProgress(null);
    expect(continuity.read()?.serverUpdateProgress).toBeUndefined();
    expect(continuity.read()?.serverUpdateVerification).toBeUndefined();
    expect(continuity.read()?.phase).toBe('triage');
    continuity.dispose();

    const reloaded = createCredentialRotationServerUpdateContinuity({
      storage: persisted.storage,
      scopeId: 'profile-a',
      status: status.status,
      onStatus: status.onStatus,
      now: () => 102,
    });
    expect(reloaded.read()?.phase).toBe('triage');
    expect(reloaded.read()?.serverUpdateProgress).toBeUndefined();
    reloaded.dispose();
  });

  it('turns an exact one-shot completion into a durable clean retry without persisting its baseline', () => {
    const persisted = storageHarness();
    const status = statusHarness('connected');
    const target = { kind: 'api' as const, name: 'github-main' };
    const continuity = createCredentialRotationServerUpdateContinuity({
      storage: persisted.storage,
      scopeId: 'profile-a',
      status: status.status,
      onStatus: status.onStatus,
      now: () => 100,
    });
    continuity.begin(target);
    continuity.observeServerUpdateProgress({
      phase: 'awaiting_reconnect',
      operation: 'update',
      startedAt: 101,
      operationId: 'opaque-receipt-never-persist',
    });
    continuity.observeServerUpdateVerification({
      phase: 'baseline_confirmed',
      operation: 'update',
      startedAt: 101,
      reason: 'server_closed_unresolved',
      baseline: {
        currentVersion: '26.8.1',
        channel: 'stable',
        updateStatus: 'up-to-date',
        affectedConnection: {
          kind: 'api',
          name: 'github-main',
          activity: 'idle',
        },
      },
    });

    // Production observes the shared latch clear before the finishing
    // controller publishes its local completion.
    continuity.observeServerUpdateProgress(null);
    expect(continuity.read()?.serverUpdateVerification).toBeUndefined();
    continuity.observeServerUpdateVerification({
      phase: 'completed',
      operation: 'update',
      startedAt: 101,
      reason: 'server_closed_unresolved',
      baseline: {
        currentVersion: '26.8.1',
        channel: 'stable',
        updateStatus: 'up-to-date',
        affectedConnection: {
          kind: 'api',
          name: 'github-main',
          activity: 'idle',
        },
      },
    });

    expect(continuity.read()).toMatchObject({
      ...target,
      phase: 'ready',
      serverUpdateVerification: {
        phase: 'completed',
        baseline: {
          currentVersion: '26.8.1',
          affectedConnection: target,
        },
      },
    });
    const raw = persisted.values.get(
      CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
    )!;
    expect(JSON.parse(raw)).toMatchObject({
      version: 2,
      scope_id: 'profile-a',
      ...target,
      phase: 'ready',
    });
    expect(raw).not.toMatch(
      /26\.8\.1|completed|opaque-receipt|activity|updateStatus/i,
    );

    continuity.dispose();
    const reloaded = createCredentialRotationServerUpdateContinuity({
      storage: persisted.storage,
      scopeId: 'profile-a',
      status: status.status,
      onStatus: status.onStatus,
      now: () => 102,
    });
    expect(reloaded.read()).toEqual({
      ...target,
      phase: 'ready',
      startedAt: 100,
    });
    reloaded.dispose();
  });

  it('persists an interrupted exact return without replaying completion or route ownership', () => {
    const persisted = storageHarness();
    const status = statusHarness('connected');
    const target = { kind: 'api' as const, name: 'github-main' };
    const completion = {
      phase: 'completed',
      operation: 'update',
      startedAt: 101,
      reason: 'server_closed_unresolved',
      baseline: {
        currentVersion: '26.8.1',
        channel: 'stable',
        updateStatus: 'up-to-date',
        affectedConnection: {
          ...target,
          activity: 'idle',
        },
      },
    } as const;
    const continuity = createCredentialRotationServerUpdateContinuity({
      storage: persisted.storage,
      scopeId: 'profile-a',
      status: status.status,
      onStatus: status.onStatus,
      now: () => 100,
    });
    continuity.begin(target);
    continuity.observeServerUpdateVerification(completion);

    expect(continuity.beginExactReturn({
      kind: 'api',
      name: 'another-connection',
    })).toBe(false);
    expect(continuity.beginExactReturn(target)).toBe(true);
    expect(continuity.read()).toEqual({
      ...target,
      phase: 'checking_return',
      startedAt: 100,
      exactReturnActive: true,
    });
    const raw = persisted.values.get(
      CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
    )!;
    expect(JSON.parse(raw)).toEqual({
      version: 2,
      scope_id: 'profile-a',
      ...target,
      phase: 'checking_return',
      started_at: 100,
      baseline_version: null,
      triage_reason: null,
      triage_check_status: null,
      triage_current_version: null,
      triage_channel: null,
      triage_available_version: null,
    });
    expect(raw).not.toMatch(
      /completed|26\.8\.1|activity|updateStatus|exactReturnActive/i,
    );

    // A late controller publication cannot turn the consumed handoff back
    // into a replayable success receipt.
    continuity.observeServerUpdateVerification(completion);
    expect(continuity.read()?.serverUpdateVerification).toBeUndefined();
    status.set('reconnecting');
    status.set('connected');
    expect(continuity.read()?.phase).toBe('checking_return');

    continuity.interruptExactReturn({
      kind: 'api',
      name: 'another-connection',
    });
    expect(continuity.read()?.exactReturnActive).toBe(true);
    continuity.interruptExactReturn(target);
    expect(continuity.read()).toEqual({
      ...target,
      phase: 'checking_return',
      startedAt: 100,
    });
    continuity.dispose();

    const restored = createCredentialRotationServerUpdateContinuity({
      storage: persisted.storage,
      scopeId: 'profile-a',
      status: status.status,
      onStatus: status.onStatus,
      now: () => 102,
    });
    expect(restored.read()).toEqual({
      ...target,
      phase: 'checking_return',
      startedAt: 100,
    });
    expect(restored.isDurable()).toBe(true);
    expect(restored.beginExactReturn(target)).toBe(true);
    expect(restored.read()?.exactReturnActive).toBe(true);
    restored.dispose();
  });

  it('persists only a target-ready clean editor and repeats the exact check after reload', () => {
    const persisted = storageHarness();
    const status = statusHarness('connected');
    const target = { kind: 'api' as const, name: 'github-main' };
    const continuity = createCredentialRotationServerUpdateContinuity({
      storage: persisted.storage,
      scopeId: 'profile-a',
      status: status.status,
      onStatus: status.onStatus,
      now: () => 100,
    });
    continuity.begin(target);
    continuity.recordServerCheck(target, {
      status: 'up-to-date',
      current_version: '26.8.1',
      channel: 'stable',
    });
    expect(continuity.beginExactReturn(target)).toBe(true);
    expect(continuity.markExactEditorReady({
      kind: 'api',
      name: 'another-connection',
    })).toBe(false);
    expect(continuity.markExactEditorReady(target)).toBe(true);
    expect(continuity.read()).toEqual({
      ...target,
      phase: 'editor_ready',
      startedAt: 100,
    });

    const raw = persisted.values.get(
      CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
    )!;
    expect(JSON.parse(raw)).toEqual({
      version: 2,
      scope_id: 'profile-a',
      ...target,
      phase: 'editor_ready',
      started_at: 100,
      baseline_version: null,
      triage_reason: null,
      triage_check_status: null,
      triage_current_version: null,
      triage_channel: null,
      triage_available_version: null,
    });
    expect(raw).not.toMatch(
      /credential|field|form|completed|26\.8\.1|activity|exactReturnActive/i,
    );

    continuity.observeServerUpdateVerification({
      phase: 'completed',
      operation: 'update',
      startedAt: 101,
      reason: 'server_closed_unresolved',
      baseline: {
        currentVersion: '26.9.0',
        channel: 'stable',
        updateStatus: 'up-to-date',
        affectedConnection: {
          ...target,
          activity: 'idle',
        },
      },
    });
    expect(continuity.read()?.serverUpdateVerification).toBeUndefined();
    status.set('reconnecting');
    status.set('connected');
    expect(continuity.read()?.phase).toBe('editor_ready');
    continuity.dispose();

    const restored = createCredentialRotationServerUpdateContinuity({
      storage: persisted.storage,
      scopeId: 'profile-a',
      status: status.status,
      onStatus: status.onStatus,
      now: () => 102,
    });
    expect(restored.read()).toEqual({
      ...target,
      phase: 'editor_ready',
      startedAt: 100,
    });
    expect(restored.beginExactReturn(target)).toBe(true);
    expect(restored.read()).toEqual({
      ...target,
      phase: 'checking_return',
      startedAt: 100,
      exactReturnActive: true,
    });
    restored.retire(target);
    expect(restored.read()).toBeNull();
    restored.dispose();
  });

  it('keeps an exact completion through late progress cleanup and rejects another connection', () => {
    const status = statusHarness('connected');
    const target = { kind: 'api' as const, name: 'github-main' };
    const continuity = createCredentialRotationServerUpdateContinuity({
      storage: null,
      scopeId: 'profile-a',
      status: status.status,
      onStatus: status.onStatus,
      now: () => 100,
    });
    continuity.begin(target);
    continuity.observeServerUpdateProgress({
      phase: 'awaiting_reconnect',
      operation: 'rollback',
      startedAt: 101,
      operationId: 'opaque',
    });
    const completion = {
      phase: 'completed',
      operation: 'rollback',
      startedAt: 101,
      reason: 'server_closed_unresolved',
      baseline: {
        currentVersion: '26.8.1',
        channel: 'stable',
        updateStatus: 'up-to-date',
        affectedConnection: {
          kind: 'api',
          name: 'github-main',
          activity: 'idle',
        },
      },
    } as const;
    continuity.observeServerUpdateVerification({
      ...completion,
      baseline: {
        ...completion.baseline,
        affectedConnection: {
          ...completion.baseline.affectedConnection,
          name: 'another-connection',
        },
      },
    });
    expect(continuity.read()?.serverUpdateVerification).toBeUndefined();

    continuity.observeServerUpdateVerification({
      phase: 'finishing',
      operation: 'rollback',
      startedAt: 101,
      reason: 'server_closed_unresolved',
    });
    continuity.observeServerUpdateVerification(completion);
    expect(continuity.read()?.serverUpdateProgress).toBeUndefined();
    continuity.observeServerUpdateProgress(null);
    expect(continuity.read()).toMatchObject({
      ...target,
      phase: 'ready',
      serverUpdateVerification: {
        phase: 'completed',
        operation: 'rollback',
      },
    });
    continuity.observeServerUpdateVerification(null);
    expect(continuity.read()?.phase).toBe('ready');
    expect(continuity.read()?.serverUpdateVerification).toBeUndefined();
    continuity.observeServerUpdateVerification(completion);
    expect(continuity.markStillUnsupported(target, {
      status: 'not-configured',
      current_version: '26.8.1',
      channel: 'stable',
    })).toMatchObject({
      reason: 'self_update_unavailable',
    });
    expect(continuity.read()?.phase).toBe('triage');
    expect(continuity.read()?.serverUpdateVerification).toBeUndefined();
    continuity.dispose();
  });

  it('keeps a later server action visible over a one-shot resolved retry', () => {
    const status = statusHarness('connected');
    const target = { kind: 'api' as const, name: 'github-main' };
    const continuity = createCredentialRotationServerUpdateContinuity({
      storage: null,
      scopeId: 'profile-a',
      status: status.status,
      onStatus: status.onStatus,
      now: () => 100,
    });
    continuity.begin(target);
    continuity.markStillUnsupported(target, {
      status: 'up-to-date',
      current_version: '26.7.3',
      channel: 'stable',
    });
    expect(continuity.markCapabilityResolvedElsewhere(target)).toBe(true);

    continuity.observeServerUpdateProgress({
      phase: 'applying',
      operation: 'rollback',
      startedAt: 101,
    });
    expect(continuity.read()).toMatchObject({
      ...target,
      phase: 'resolved_elsewhere',
      serverUpdateProgress: {
        phase: 'applying',
        operation: 'rollback',
        startedAt: 101,
      },
    });
    continuity.observeServerUpdateProgress(null);
    expect(continuity.read()?.phase).toBe('resolved_elsewhere');
    expect(continuity.read()?.serverUpdateProgress).toBeUndefined();
    continuity.dispose();
  });

  it('emits a replacement marker even when two begins share a timestamp', () => {
    const status = statusHarness('connected');
    const continuity = createCredentialRotationServerUpdateContinuity({
      storage: null,
      scopeId: 'profile-a',
      status: status.status,
      onStatus: status.onStatus,
      now: () => 100,
    });
    const target = { kind: 'api' as const, name: 'github-main' };
    const listener = vi.fn();
    continuity.subscribe(listener);

    continuity.begin(target);
    continuity.begin(target);

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenNthCalledWith(1, {
      ...target,
      phase: 'guide',
      startedAt: 100,
    });
    expect(listener).toHaveBeenNthCalledWith(2, {
      ...target,
      phase: 'guide',
      startedAt: 100,
    });
    continuity.dispose();
  });

  it('fails closed on widened or expired stored envelopes and detaches status', () => {
    const persisted = storageHarness();
    persisted.values.set(
      CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
      JSON.stringify({
        version: 1,
        scope_id: 'profile-a',
        kind: 'api',
        name: 'github-main',
        phase: 'guide',
        started_at: 100,
        client_secret: 'must-not-survive',
      }),
    );
    const status = statusHarness('connected');
    const malformed = createCredentialRotationServerUpdateContinuity({
      storage: persisted.storage,
      scopeId: 'profile-a',
      status: status.status,
      onStatus: status.onStatus,
      now: () => 101,
    });
    expect(malformed.read()).toBeNull();
    expect(persisted.values.has(
      CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
    )).toBe(false);
    expect(status.listenerCount()).toBe(1);
    malformed.dispose();
    expect(status.listenerCount()).toBe(0);

    persisted.values.set(
      CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
      JSON.stringify({
        version: 1,
        scope_id: 'profile-a',
        kind: 'api',
        name: 'github-main',
        phase: 'guide',
        started_at: 100,
      }),
    );
    const expired = createCredentialRotationServerUpdateContinuity({
      storage: persisted.storage,
      scopeId: 'profile-a',
      status: status.status,
      onStatus: status.onStatus,
      now: () => 200,
      maxAgeMs: 50,
    });
    expect(expired.read()).toBeNull();
    expect(persisted.values.has(
      CREDENTIAL_ROTATION_SERVER_UPDATE_CONTINUITY_SESSION_KEY,
    )).toBe(false);
    expired.dispose();
  });
});
