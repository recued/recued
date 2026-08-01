import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CREDENTIAL_ROTATION_TAB_CHANNEL_NAME,
  CREDENTIAL_ROTATION_TAB_PULSE_KEY,
  credentialRotationOwnershipLockName,
  createBrowserCredentialRotationTabConvergence,
  serverUpdateOwnershipLockName,
  serverUpdateProgressStorageKey,
  type CredentialRotationOwnershipLockProvider,
  type CredentialRotationTabStorage,
} from './credential-rotation-tab-convergence.js';

const exclusiveLocks = () => {
  const held = new Set<string>();
  const request = vi.fn<CredentialRotationOwnershipLockProvider['request']>(
    async (name, _options, callback) => {
      if (held.has(name)) {
        await callback(null);
        return;
      }
      held.add(name);
      try {
        await callback({ name });
      } finally {
        held.delete(name);
      }
    },
  );
  return {
    provider: { request } satisfies CredentialRotationOwnershipLockProvider,
    request,
    isHeld: (name: string) => held.has(name),
  };
};

type MessageListener = (event: MessageEvent<unknown>) => void;

class FakeBroadcastChannel {
  static rooms = new Map<string, Set<FakeBroadcastChannel>>();
  static posted: unknown[] = [];

  readonly listeners = new Set<MessageListener>();

  constructor(readonly name: string) {
    const room = FakeBroadcastChannel.rooms.get(name) ?? new Set();
    room.add(this);
    FakeBroadcastChannel.rooms.set(name, room);
  }

  postMessage(message: unknown): void {
    FakeBroadcastChannel.posted.push(message);
    for (const peer of FakeBroadcastChannel.rooms.get(this.name) ?? []) {
      if (peer === this) continue;
      for (const listener of [...peer.listeners]) {
        listener({ data: message } as MessageEvent<unknown>);
      }
    }
  }

  addEventListener(_type: 'message', listener: MessageListener): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'message', listener: MessageListener): void {
    this.listeners.delete(listener);
  }

  close(): void {
    FakeBroadcastChannel.rooms.get(this.name)?.delete(this);
    this.listeners.clear();
  }
}

const memoryStorage = () => {
  const values = new Map<string, string>();
  const storage: CredentialRotationTabStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
  return { storage, values };
};

const fakeDocument = (
  storage: CredentialRotationTabStorage,
  withBroadcast = true,
) => {
  const windowListeners = new Map<string, Set<(event?: unknown) => void>>();
  const documentListeners = new Map<string, Set<() => void>>();
  const view = {
    ...(withBroadcast ? { BroadcastChannel: FakeBroadcastChannel } : {}),
    localStorage: storage,
    addEventListener(type: string, listener: (event?: unknown) => void) {
      const listeners = windowListeners.get(type) ?? new Set();
      listeners.add(listener);
      windowListeners.set(type, listeners);
    },
    removeEventListener(type: string, listener: (event?: unknown) => void) {
      windowListeners.get(type)?.delete(listener);
    },
  };
  const doc = {
    defaultView: view,
    visibilityState: 'visible',
    addEventListener(type: string, listener: () => void) {
      const listeners = documentListeners.get(type) ?? new Set();
      listeners.add(listener);
      documentListeners.set(type, listeners);
    },
    removeEventListener(type: string, listener: () => void) {
      documentListeners.get(type)?.delete(listener);
    },
  };
  return {
    document: doc as unknown as Document,
    emitStorage(key: string, newValue: string | null) {
      for (const listener of windowListeners.get('storage') ?? []) {
        listener({ key, newValue } as StorageEvent);
      }
    },
    focus() {
      for (const listener of windowListeners.get('focus') ?? []) listener();
    },
  };
};

describe('credential rotation tab convergence', () => {
  beforeEach(() => {
    FakeBroadcastChannel.rooms.clear();
    FakeBroadcastChannel.posted = [];
  });

  it('sends exact identity ephemerally, scopes it to one profile, and persists only an opaque pulse', () => {
    const { storage, values } = memoryStorage();
    const sourceDoc = fakeDocument(storage);
    const siblingDoc = fakeDocument(storage);
    const otherProfileDoc = fakeDocument(storage);
    const source = createBrowserCredentialRotationTabConvergence({
      document: sourceDoc.document,
      scopeId: 'profile-a',
      storage,
      eventId: () => 'event-a',
    })!;
    const sibling = createBrowserCredentialRotationTabConvergence({
      document: siblingDoc.document,
      scopeId: 'profile-a',
      storage,
    })!;
    const otherProfile = createBrowserCredentialRotationTabConvergence({
      document: otherProfileDoc.document,
      scopeId: 'profile-b',
      storage,
    })!;
    const siblingHints = vi.fn();
    const otherHints = vi.fn();
    sibling.subscribe(siblingHints);
    otherProfile.subscribe(otherHints);

    source.notifyCredentialRotated({ kind: 'api', name: 'private-crm' });

    expect(siblingHints).toHaveBeenCalledWith({
      type: 'credential_rotated',
      kind: 'api',
      name: 'private-crm',
    });
    expect(otherHints).not.toHaveBeenCalled();
    expect(FakeBroadcastChannel.posted).toEqual([{
      type: 'recued.webclient.connection-credential-rotated',
      version: 1,
      scope_id: 'profile-a',
      event_id: 'event-a',
      kind: 'api',
      name: 'private-crm',
    }]);
    expect(FakeBroadcastChannel.rooms.has(
      CREDENTIAL_ROTATION_TAB_CHANNEL_NAME,
    )).toBe(true);

    const raw = values.get(CREDENTIAL_ROTATION_TAB_PULSE_KEY)!;
    expect(JSON.parse(raw)).toEqual({
      type: 'recued.webclient.connection-credential-rotation-pulse',
      version: 1,
      scope_id: 'profile-a',
      event_id: 'event-a',
    });
    expect(raw).not.toMatch(/private-crm|secret|token|attempt|internal-tools/i);

    source.close();
    sibling.close();
    otherProfile.close();
  });

  it('turns an identity-free storage pulse or focus into authoritative reconciliation', () => {
    const { storage, values } = memoryStorage();
    const sourceDoc = fakeDocument(storage, false);
    const siblingDoc = fakeDocument(storage, false);
    const source = createBrowserCredentialRotationTabConvergence({
      document: sourceDoc.document,
      scopeId: 'profile-a',
      storage,
      eventId: () => 'event-b',
    })!;
    const sibling = createBrowserCredentialRotationTabConvergence({
      document: siblingDoc.document,
      scopeId: 'profile-a',
      storage,
    })!;
    const hints = vi.fn();
    sibling.subscribe(hints);

    source.notifyCredentialRotated({ kind: 'mcp', name: 'internal-tools' });
    siblingDoc.emitStorage(
      CREDENTIAL_ROTATION_TAB_PULSE_KEY,
      values.get(CREDENTIAL_ROTATION_TAB_PULSE_KEY)!,
    );
    expect(hints).toHaveBeenCalledTimes(1);
    expect(hints).toHaveBeenLastCalledWith({ type: 'reconcile' });

    siblingDoc.focus();
    expect(hints).toHaveBeenCalledTimes(2);
    expect(hints).toHaveBeenLastCalledWith({ type: 'reconcile' });

    source.close();
    sibling.close();
  });

  it('wakes siblings for a safe stop without persisting its identity or recovery detail', () => {
    const { storage, values } = memoryStorage();
    const source = createBrowserCredentialRotationTabConvergence({
      document: fakeDocument(storage).document,
      scopeId: 'profile-a',
      storage,
      eventId: () => 'pulse-a',
    })!;
    const sibling = createBrowserCredentialRotationTabConvergence({
      document: fakeDocument(storage).document,
      scopeId: 'profile-a',
      storage,
    })!;
    const hints = vi.fn();
    sibling.subscribe(hints);

    source.notifyCredentialRotationSafeStopped({
      kind: 'api',
      name: 'private-crm',
    });

    expect(hints).toHaveBeenCalledWith({
      type: 'credential_rotation_safe_stopped',
      kind: 'api',
      name: 'private-crm',
    });
    expect(FakeBroadcastChannel.posted).toEqual([{
      type: 'recued.webclient.connection-credential-rotation-safe-stopped',
      version: 1,
      scope_id: 'profile-a',
      event_id: 'pulse-a',
      kind: 'api',
      name: 'private-crm',
    }]);
    const raw = values.get(CREDENTIAL_ROTATION_TAB_PULSE_KEY)!;
    expect(JSON.parse(raw)).toEqual({
      type: 'recued.webclient.connection-credential-rotation-pulse',
      version: 1,
      scope_id: 'profile-a',
      event_id: 'pulse-a',
    });
    expect(raw).not.toMatch(
      /private-crm|safe.stop|admin|secret|token|endpoint|attempt|correction/i,
    );

    source.close();
    sibling.close();
  });

  it('wakes exact siblings after server-resolved closure and persists only an opaque pulse', () => {
    const { storage, values } = memoryStorage();
    const source = createBrowserCredentialRotationTabConvergence({
      document: fakeDocument(storage).document,
      scopeId: 'profile-a',
      storage,
      eventId: () => 'closure-a',
    })!;
    const sibling = createBrowserCredentialRotationTabConvergence({
      document: fakeDocument(storage).document,
      scopeId: 'profile-a',
      storage,
    })!;
    const hints = vi.fn();
    sibling.subscribe(hints);

    source.notifyCredentialRotationSafeStopResolved({
      kind: 'api',
      name: 'private-crm',
    });

    expect(hints).toHaveBeenCalledWith({
      type: 'credential_rotation_safe_stop_resolved',
      kind: 'api',
      name: 'private-crm',
    });
    expect(FakeBroadcastChannel.posted).toEqual([{
      type: 'recued.webclient.connection-credential-safe-stop-resolved',
      version: 1,
      scope_id: 'profile-a',
      event_id: 'closure-a',
      kind: 'api',
      name: 'private-crm',
    }]);
    const raw = values.get(CREDENTIAL_ROTATION_TAB_PULSE_KEY)!;
    expect(JSON.parse(raw)).toEqual({
      type: 'recued.webclient.connection-credential-rotation-pulse',
      version: 1,
      scope_id: 'profile-a',
      event_id: 'closure-a',
    });
    expect(raw).not.toMatch(
      /private-crm|safe.stop|admin|secret|token|endpoint|attempt|correction/i,
    );

    source.close();
    sibling.close();
  });

  it('wakes sibling post-ack readers live and durably with only an identity-free pulse', () => {
    const { storage, values } = memoryStorage();
    const sourceDocument = fakeDocument(storage);
    const siblingDocument = fakeDocument(storage);
    const source = createBrowserCredentialRotationTabConvergence({
      document: sourceDocument.document,
      scopeId: 'profile-a',
      storage,
      eventId: () => 'post-ack-check-a',
    })!;
    const sibling = createBrowserCredentialRotationTabConvergence({
      document: siblingDocument.document,
      scopeId: 'profile-a',
      storage,
    })!;
    const hints = vi.fn();
    sibling.subscribe(hints);

    source.notifyPostSafeStopVerificationChanged();

    expect(hints).toHaveBeenCalledOnce();
    expect(hints).toHaveBeenCalledWith({ type: 'reconcile' });

    const raw = values.get(CREDENTIAL_ROTATION_TAB_PULSE_KEY)!;
    expect(JSON.parse(raw)).toEqual({
      type: 'recued.webclient.connection-credential-rotation-pulse',
      version: 1,
      scope_id: 'profile-a',
      event_id: 'post-ack-check-a',
    });
    expect(raw).not.toMatch(
      /connection.name|private-crm|auth.failed|provider.result|endpoint|attempt/i,
    );
    expect(FakeBroadcastChannel.posted).toEqual([JSON.parse(raw)]);

    hints.mockClear();
    siblingDocument.emitStorage(CREDENTIAL_ROTATION_TAB_PULSE_KEY, raw);
    expect(hints).not.toHaveBeenCalled();

    source.close();
    sibling.close();
  });

  it('announces a server-capability result exactly in memory and leaves only an opaque fallback pulse', () => {
    const { storage, values } = memoryStorage();
    const source = createBrowserCredentialRotationTabConvergence({
      document: fakeDocument(storage).document,
      scopeId: 'profile-a',
      storage,
      eventId: () => 'event-cap-a',
    })!;
    const sibling = createBrowserCredentialRotationTabConvergence({
      document: fakeDocument(storage).document,
      scopeId: 'profile-a',
      storage,
    })!;
    const hints = vi.fn();
    sibling.subscribe(hints);

    source.notifyServerCapabilityResolved({
      kind: 'api',
      name: 'private-crm',
    });

    expect(hints).toHaveBeenCalledWith({
      type: 'server_capability_resolved',
      kind: 'api',
      name: 'private-crm',
    });
    expect(FakeBroadcastChannel.posted).toEqual([{
      type: 'recued.webclient.connection-server-capability-resolved',
      version: 1,
      scope_id: 'profile-a',
      event_id: 'event-cap-a',
      kind: 'api',
      name: 'private-crm',
    }]);
    const raw = values.get(CREDENTIAL_ROTATION_TAB_PULSE_KEY)!;
    expect(JSON.parse(raw)).toEqual({
      type: 'recued.webclient.connection-credential-rotation-pulse',
      version: 1,
      scope_id: 'profile-a',
      event_id: 'event-cap-a',
    });
    expect(raw).not.toMatch(/private-crm|capability|secret|token|endpoint|form/i);

    source.close();
    sibling.close();
  });

  it('signals start/release only ephemerally and elects one owner per exact connection', async () => {
    const { storage, values } = memoryStorage();
    const locks = exclusiveLocks();
    const ids = ['start-a', 'release-a'];
    const source = createBrowserCredentialRotationTabConvergence({
      document: fakeDocument(storage).document,
      scopeId: 'profile-a',
      storage,
      eventId: () => ids.shift()!,
      ownershipLockProvider: locks.provider,
    })!;
    const sibling = createBrowserCredentialRotationTabConvergence({
      document: fakeDocument(storage).document,
      scopeId: 'profile-a',
      storage,
      ownershipLockProvider: locks.provider,
    })!;
    const hints = vi.fn();
    sibling.subscribe(hints);
    const identity = { kind: 'api' as const, name: 'private-crm' };

    const sourceLease = await source.claimCredentialRotationOwnership(identity);
    expect(source.supportsOwnershipLeases).toBe(true);
    expect(sourceLease).not.toBeNull();
    expect(await source.claimCredentialRotationOwnership(identity))
      .toBe(sourceLease);
    expect(await sibling.claimCredentialRotationOwnership(identity)).toBeNull();
    expect(locks.isHeld(credentialRotationOwnershipLockName(
      'profile-a',
      identity,
    ))).toBe(true);

    source.notifyCredentialRotationStarted(identity);
    expect(hints).toHaveBeenLastCalledWith({
      type: 'credential_rotation_started',
      ...identity,
    });
    expect(values.has(CREDENTIAL_ROTATION_TAB_PULSE_KEY)).toBe(false);

    sourceLease?.release();
    await vi.waitFor(() => expect(locks.isHeld(credentialRotationOwnershipLockName(
      'profile-a',
      identity,
    ))).toBe(false));
    source.notifyCredentialRotationReleased(identity);
    expect(hints).toHaveBeenLastCalledWith({
      type: 'credential_rotation_released',
      ...identity,
    });
    expect(values.has(CREDENTIAL_ROTATION_TAB_PULSE_KEY)).toBe(false);

    const siblingLease = await sibling.claimCredentialRotationOwnership(identity);
    expect(siblingLease).not.toBeNull();
    sibling.close();
    await vi.waitFor(() => expect(locks.isHeld(credentialRotationOwnershipLockName(
      'profile-a',
      identity,
    ))).toBe(false));
    source.close();
  });

  it('allows different connections to hold independent ownership leases', async () => {
    const { storage } = memoryStorage();
    const locks = exclusiveLocks();
    const convergence = createBrowserCredentialRotationTabConvergence({
      document: fakeDocument(storage).document,
      scopeId: 'profile-a',
      storage,
      ownershipLockProvider: locks.provider,
    })!;
    const otherProfile = createBrowserCredentialRotationTabConvergence({
      document: fakeDocument(storage).document,
      scopeId: 'profile-b',
      storage,
      ownershipLockProvider: locks.provider,
    })!;

    const first = await convergence.claimCredentialRotationOwnership({
      kind: 'api',
      name: 'crm-a',
    });
    const second = await convergence.claimCredentialRotationOwnership({
      kind: 'api',
      name: 'crm-b',
    });
    const sameIdentityOtherProfile = await otherProfile
      .claimCredentialRotationOwnership({ kind: 'api', name: 'crm-a' });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(sameIdentityOtherProfile).not.toBeNull();
    first?.release();
    second?.release();
    sameIdentityOtherProfile?.release();
    convergence.close();
    otherProfile.close();
  });

  it('shares only exact profile-scoped update progress and restores it for a mid-transition tab', async () => {
    const { storage, values } = memoryStorage();
    const ids = ['progress-applying', 'progress-waiting', 'progress-idle'];
    const source = createBrowserCredentialRotationTabConvergence({
      document: fakeDocument(storage).document,
      scopeId: 'profile-a',
      storage,
      now: () => 100,
      eventId: () => ids.shift()!,
    })!;
    const sibling = createBrowserCredentialRotationTabConvergence({
      document: fakeDocument(storage).document,
      scopeId: 'profile-a',
      storage,
      now: () => 100,
    })!;
    const otherProfile = createBrowserCredentialRotationTabConvergence({
      document: fakeDocument(storage).document,
      scopeId: 'profile-b',
      storage,
      now: () => 100,
    })!;
    const hints = vi.fn();
    sibling.subscribe(hints);

    source.notifyServerUpdateProgress({
      phase: 'applying',
      operation: 'update',
    });

    expect(hints).toHaveBeenLastCalledWith({
      type: 'server_update_progress',
      progress: {
        phase: 'applying',
        operation: 'update',
        startedAt: 100,
      },
    });
    const key = serverUpdateProgressStorageKey('profile-a');
    const raw = values.get(key)!;
    expect(JSON.parse(raw)).toEqual({
      type: 'recued.webclient.server-update-progress',
      version: 1,
      scope_id: 'profile-a',
      event_id: 'progress-applying',
      phase: 'applying',
      operation: 'update',
      started_at: 100,
    });
    expect(raw).not.toMatch(
      /github|connection|credential|secret|token|endpoint|server_url|form|error|26\./i,
    );
    expect(otherProfile.readServerUpdateProgress()).toBeNull();

    const arriving = createBrowserCredentialRotationTabConvergence({
      document: fakeDocument(storage).document,
      scopeId: 'profile-a',
      storage,
      now: () => 101,
    })!;
    expect(arriving.readServerUpdateProgress()).toEqual({
      phase: 'applying',
      operation: 'update',
      startedAt: 100,
    });

    source.notifyServerUpdateProgress({
      phase: 'awaiting_reconnect',
      operation: 'update',
      operationId: 'server-receipt-1',
    });
    expect(source.readServerUpdateProgress()).toEqual({
      phase: 'awaiting_reconnect',
      operation: 'update',
      startedAt: 100,
      operationId: 'server-receipt-1',
    });
    expect(JSON.parse(values.get(key)!)).toMatchObject({
      event_id: 'progress-waiting',
      phase: 'awaiting_reconnect',
      started_at: 100,
      operation_id: 'server-receipt-1',
    });
    expect(values.get(key)).not.toMatch(
      /github|connection|credential|secret|token|endpoint|server_url|form|error|26\./i,
    );

    expect(await source.clearServerUpdateProgress(
      source.readServerUpdateProgress()!,
    )).toBe(true);
    expect(JSON.parse(values.get(key)!)).toMatchObject({
      phase: 'idle',
      operation: 'update',
      started_at: 100,
    });
    expect(source.readServerUpdateProgress()).toBeNull();
    expect(sibling.readServerUpdateProgress()).toEqual({
      phase: 'awaiting_reconnect',
      operation: 'update',
      startedAt: 100,
      operationId: 'server-receipt-1',
    });
    expect(hints).toHaveBeenLastCalledWith(expect.objectContaining({
      progress: expect.objectContaining({ phase: 'awaiting_reconnect' }),
    }));

    // Each tab retires the accepted-restart latch only after its own boot
    // observes reconnect (or proves capability) and explicitly acknowledges.
    expect(await sibling.clearServerUpdateProgress(
      sibling.readServerUpdateProgress()!,
    )).toBe(true);
    expect(sibling.readServerUpdateProgress()).toBeNull();

    arriving.close();
    source.close();
    sibling.close();
    otherProfile.close();
  });

  it('isolates a stale progress subscriber from persistence and lock cleanup', async () => {
    const { storage, values } = memoryStorage();
    const locks = exclusiveLocks();
    const ids = ['apply-despite-listener', 'settle-despite-listener'];
    const convergence = createBrowserCredentialRotationTabConvergence({
      document: fakeDocument(storage).document,
      scopeId: 'profile-a',
      storage,
      ownershipLockProvider: locks.provider,
      now: () => 100,
      eventId: () => ids.shift()!,
    })!;
    const observed = vi.fn();
    convergence.subscribe(() => {
      throw new Error('stale route');
    });
    convergence.subscribe(observed);
    const lease = await convergence.claimServerUpdateOwnership();

    convergence.notifyServerUpdateProgress({
      phase: 'applying',
      operation: 'update',
    });
    expect(observed).toHaveBeenCalledWith({
      type: 'server_update_progress',
      progress: {
        phase: 'applying',
        operation: 'update',
        startedAt: 100,
      },
    });
    expect(JSON.parse(values.get(
      serverUpdateProgressStorageKey('profile-a'),
    )!)).toMatchObject({ phase: 'applying' });

    expect(await convergence.clearServerUpdateProgress(
      convergence.readServerUpdateProgress()!,
    )).toBe(true);
    lease?.release();
    await vi.waitFor(() => expect(
      locks.isHeld(serverUpdateOwnershipLockName('profile-a')),
    ).toBe(false));
    convergence.close();
  });

  it('elects one update owner per profile and clears only an orphaned applying marker', async () => {
    const { storage, values } = memoryStorage();
    const locks = exclusiveLocks();
    const owner = createBrowserCredentialRotationTabConvergence({
      document: fakeDocument(storage).document,
      scopeId: 'profile-a',
      storage,
      ownershipLockProvider: locks.provider,
      now: () => 100,
      eventId: () => 'owner-applying',
    })!;
    const sibling = createBrowserCredentialRotationTabConvergence({
      document: fakeDocument(storage).document,
      scopeId: 'profile-a',
      storage,
      ownershipLockProvider: locks.provider,
      now: () => 101,
      eventId: () => 'sibling-cleared',
    })!;
    const otherProfile = createBrowserCredentialRotationTabConvergence({
      document: fakeDocument(storage).document,
      scopeId: 'profile-b',
      storage,
      ownershipLockProvider: locks.provider,
      now: () => 101,
    })!;

    const ownerLease = await owner.claimServerUpdateOwnership();
    expect(owner.supportsServerUpdateOwnership).toBe(true);
    expect(ownerLease).not.toBeNull();
    expect(await sibling.claimServerUpdateOwnership()).toBeNull();
    const otherLease = await otherProfile.claimServerUpdateOwnership();
    expect(otherLease).not.toBeNull();
    expect(locks.isHeld(serverUpdateOwnershipLockName('profile-a'))).toBe(true);

    owner.notifyServerUpdateProgress({
      phase: 'applying',
      operation: 'rollback',
    });
    expect(await sibling.reconcileServerUpdateProgress()).toMatchObject({
      phase: 'applying',
      operation: 'rollback',
    });

    // Closing the owner releases its Web Lock but leaves a crash-safe marker.
    // The next visible sibling clears the ownerless browser latch; the server's
    // own in-flight gate remains authoritative if the RPC outlived the tab.
    owner.close();
    await vi.waitFor(() => expect(
      locks.isHeld(serverUpdateOwnershipLockName('profile-a')),
    ).toBe(false));
    expect(await sibling.reconcileServerUpdateProgress()).toBeNull();
    expect(JSON.parse(values.get(
      serverUpdateProgressStorageKey('profile-a'),
    )!)).toMatchObject({
      phase: 'idle',
      operation: 'rollback',
      started_at: 100,
    });

    otherLease?.release();
    sibling.close();
    otherProfile.close();
  });

  it('keeps accepted restart progress after the action lock is released', async () => {
    const { storage } = memoryStorage();
    const locks = exclusiveLocks();
    const source = createBrowserCredentialRotationTabConvergence({
      document: fakeDocument(storage).document,
      scopeId: 'profile-a',
      storage,
      ownershipLockProvider: locks.provider,
      now: () => 100,
      eventId: () => 'accepted-restart',
    })!;
    const sibling = createBrowserCredentialRotationTabConvergence({
      document: fakeDocument(storage).document,
      scopeId: 'profile-a',
      storage,
      ownershipLockProvider: locks.provider,
      now: () => 101,
    })!;
    const lease = await source.claimServerUpdateOwnership();
    source.notifyServerUpdateProgress({
      phase: 'awaiting_reconnect',
      operation: 'update',
    });
    lease?.release();

    expect(await sibling.reconcileServerUpdateProgress()).toEqual({
      phase: 'awaiting_reconnect',
      operation: 'update',
      startedAt: 100,
    });

    source.close();
    sibling.close();
  });

  it('rejects delayed lineages, phase regressions, and same-tick resurrection', async () => {
    const { storage } = memoryStorage();
    const doc = fakeDocument(storage, false);
    const ids = ['settled-current', 'next-apply'];
    const convergence = createBrowserCredentialRotationTabConvergence({
      document: doc.document,
      scopeId: 'profile-a',
      storage,
      ownershipLockProvider: null,
      now: () => 200,
      eventId: () => ids.shift()!,
    })!;
    const key = serverUpdateProgressStorageKey('profile-a');
    const envelope = (
      eventId: string,
      phase: 'applying' | 'awaiting_reconnect',
      startedAt: number,
      operation: 'update' | 'rollback' = 'update',
      operationId?: string,
    ): string => JSON.stringify({
      type: 'recued.webclient.server-update-progress',
      version: 1,
      scope_id: 'profile-a',
      event_id: eventId,
      phase,
      operation,
      started_at: startedAt,
      ...(operationId !== undefined ? { operation_id: operationId } : {}),
    });

    doc.emitStorage(key, envelope('current-apply', 'applying', 200));
    doc.emitStorage(key, envelope('older-wait', 'awaiting_reconnect', 100));
    expect(convergence.readServerUpdateProgress()).toEqual({
      phase: 'applying',
      operation: 'update',
      startedAt: 200,
    });

    // In the no-Web-Locks fallback, an accepted restart outranks a different
    // operation that only reached applying in the same millisecond.
    doc.emitStorage(
      key,
      envelope(
        'current-wait',
        'awaiting_reconnect',
        200,
        'rollback',
        'rollback-receipt',
      ),
    );
    // Neither a delayed legacy envelope nor a conflicting receipt may erase
    // the exact server-issued receipt for this lineage.
    doc.emitStorage(
      key,
      envelope('receipt-less-wait', 'awaiting_reconnect', 200, 'rollback'),
    );
    doc.emitStorage(
      key,
      envelope(
        'conflicting-receipt',
        'awaiting_reconnect',
        200,
        'rollback',
        'other-receipt',
      ),
    );
    doc.emitStorage(
      key,
      envelope('late-current-apply', 'applying', 200, 'rollback'),
    );
    expect(convergence.readServerUpdateProgress()).toEqual({
      phase: 'awaiting_reconnect',
      operation: 'rollback',
      startedAt: 200,
      operationId: 'rollback-receipt',
    });

    expect(await convergence.clearServerUpdateProgress(
      convergence.readServerUpdateProgress()!,
    )).toBe(true);
    doc.emitStorage(
      key,
      envelope('late-current-wait', 'awaiting_reconnect', 200, 'rollback'),
    );
    expect(convergence.readServerUpdateProgress()).toBeNull();

    // A second update started within the same clock tick receives a strictly
    // newer start marker, so it cannot be confused with the settled action.
    convergence.notifyServerUpdateProgress({
      phase: 'applying',
      operation: 'update',
    });
    expect(convergence.readServerUpdateProgress()).toEqual({
      phase: 'applying',
      operation: 'update',
      startedAt: 201,
    });
    convergence.close();
  });

  it('cannot let a late old-restart acknowledgment erase a newer applying owner', async () => {
    const { storage, values } = memoryStorage();
    const locks = exclusiveLocks();
    const ids = ['old-awaiting', 'old-idle', 'new-applying'];
    let observedAt = 100;
    const source = createBrowserCredentialRotationTabConvergence({
      document: fakeDocument(storage, false).document,
      scopeId: 'profile-a',
      storage,
      ownershipLockProvider: locks.provider,
      now: () => observedAt,
      eventId: () => ids.shift()!,
    })!;
    const oldLease = await source.claimServerUpdateOwnership();
    source.notifyServerUpdateProgress({
      phase: 'awaiting_reconnect',
      operation: 'update',
    });
    oldLease?.release();
    await vi.waitFor(() => expect(
      locks.isHeld(serverUpdateOwnershipLockName('profile-a')),
    ).toBe(false));

    // This suspended tab retains the old accepted-restart lineage and misses
    // the source tab's later storage/channel transitions.
    const stale = createBrowserCredentialRotationTabConvergence({
      document: fakeDocument(storage, false).document,
      scopeId: 'profile-a',
      storage,
      ownershipLockProvider: locks.provider,
      now: () => observedAt + 1,
    })!;
    const oldProgress = stale.readServerUpdateProgress()!;
    expect(await source.clearServerUpdateProgress(
      source.readServerUpdateProgress()!,
    )).toBe(true);

    observedAt = 200;
    const newLease = await source.claimServerUpdateOwnership();
    source.notifyServerUpdateProgress({
      phase: 'applying',
      operation: 'update',
    });
    expect(await stale.clearServerUpdateProgress(oldProgress)).toBe(false);
    expect(JSON.parse(values.get(
      serverUpdateProgressStorageKey('profile-a'),
    )!)).toMatchObject({
      event_id: 'new-applying',
      phase: 'applying',
      started_at: 200,
    });

    newLease?.release();
    await vi.waitFor(() => expect(
      locks.isHeld(serverUpdateOwnershipLockName('profile-a')),
    ).toBe(false));
    // Even after it can acquire the lock, the storage recheck adopts the newer
    // lineage instead of overwriting it with the old idle receipt.
    expect(await stale.clearServerUpdateProgress(oldProgress)).toBe(false);
    expect(stale.readServerUpdateProgress()).toEqual({
      phase: 'applying',
      operation: 'update',
      startedAt: 200,
    });
    expect(JSON.parse(values.get(
      serverUpdateProgressStorageKey('profile-a'),
    )!)).toMatchObject({
      event_id: 'new-applying',
      phase: 'applying',
    });

    source.close();
    stale.close();
  });

  it('expires an orphaned applying marker promptly when browser locks are unavailable', () => {
    const { storage, values } = memoryStorage();
    const key = serverUpdateProgressStorageKey('profile-a');
    values.set(key, JSON.stringify({
      type: 'recued.webclient.server-update-progress',
      version: 1,
      scope_id: 'profile-a',
      event_id: 'stale-applying',
      phase: 'applying',
      operation: 'update',
      started_at: 100,
    }));

    const convergence = createBrowserCredentialRotationTabConvergence({
      document: fakeDocument(storage).document,
      scopeId: 'profile-a',
      storage,
      ownershipLockProvider: null,
      now: () => 100 + (15 * 60 * 1000) + 1,
    })!;

    expect(convergence.readServerUpdateProgress()).toBeNull();
    expect(values.has(key)).toBe(false);
    convergence.close();
  });

  it('ignores malformed, over-specified, and foreign-profile channel messages', () => {
    const { storage } = memoryStorage();
    const sourceDoc = fakeDocument(storage);
    const siblingDoc = fakeDocument(storage);
    const source = createBrowserCredentialRotationTabConvergence({
      document: sourceDoc.document,
      scopeId: 'profile-a',
      storage,
    })!;
    const sibling = createBrowserCredentialRotationTabConvergence({
      document: siblingDoc.document,
      scopeId: 'profile-a',
      storage,
    })!;
    const hints = vi.fn();
    sibling.subscribe(hints);
    const sourceChannel = [...FakeBroadcastChannel.rooms.get(
      CREDENTIAL_ROTATION_TAB_CHANNEL_NAME,
    )!][0]!;

    sourceChannel.postMessage({
      type: 'recued.webclient.connection-credential-rotated',
      version: 1,
      scope_id: 'profile-b',
      event_id: 'foreign',
      kind: 'api',
      name: 'crm',
    });
    sourceChannel.postMessage({
      type: 'recued.webclient.connection-credential-rotated',
      version: 1,
      scope_id: 'profile-a',
      event_id: 'overspecified',
      kind: 'api',
      name: 'crm',
      credential: 'must-not-cross',
    });
    sourceChannel.postMessage({
      type: 'recued.webclient.connection-server-capability-resolved',
      version: 1,
      scope_id: 'profile-a',
      event_id: 'overspecified-capability',
      kind: 'api',
      name: 'crm',
      server_url: 'wss://must-not-cross.example/ws',
    });
    sourceChannel.postMessage({
      type: 'recued.webclient.server-update-progress',
      version: 1,
      scope_id: 'profile-a',
      event_id: 'overspecified-progress',
      phase: 'applying',
      operation: 'update',
      started_at: 100,
      credential: 'must-not-cross',
    });
    expect(hints).not.toHaveBeenCalled();

    source.close();
    sibling.close();
  });
});
