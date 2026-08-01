import { describe, expect, it, vi } from 'vitest';

import {
  PAIR_RECOVERY_SUCCESSOR_LOCK_NAME,
  PAIR_TAB_CONVERGENCE_CHANNEL_NAME,
  createBrowserPairTabConvergence,
  type PairRecoverySuccessorLockProvider,
} from './pair-tab-convergence.js';

class FakeBroadcastChannel {
  static latest: FakeBroadcastChannel | null = null;

  readonly postMessage = vi.fn();
  readonly close = vi.fn();
  readonly name: string;
  private readonly listeners = new Set<(event: MessageEvent<unknown>) => void>();

  constructor(name: string) {
    this.name = name;
    FakeBroadcastChannel.latest = this;
  }

  addEventListener(
    _type: 'message',
    listener: (event: MessageEvent<unknown>) => void,
  ): void {
    this.listeners.add(listener);
  }

  removeEventListener(
    _type: 'message',
    listener: (event: MessageEvent<unknown>) => void,
  ): void {
    this.listeners.delete(listener);
  }

  emit(data: unknown): void {
    for (const listener of [...this.listeners]) {
      listener({ data } as MessageEvent<unknown>);
    }
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

const latestBroadcast = (): FakeBroadcastChannel | null =>
  FakeBroadcastChannel.latest;

const makeExclusiveRecoveryLock = () => {
  let held = false;
  const request = vi.fn<PairRecoverySuccessorLockProvider['request']>(
    async (name, _options, callback) => {
      if (held) {
        await callback(null);
        return;
      }
      held = true;
      try {
        await callback({ name });
      } finally {
        held = false;
      }
    },
  );
  return {
    provider: { request },
    request,
    isHeld: () => held,
  };
};

const makeBrowser = (withBroadcast = true) => {
  const pageListeners = new Map<string, Set<() => void>>();
  const documentListeners = new Map<string, Set<() => void>>();
  let intervalListener: (() => void) | null = null;
  const clearInterval = vi.fn();
  const view = {
    ...(withBroadcast ? { BroadcastChannel: FakeBroadcastChannel } : {}),
    setInterval: vi.fn((listener: () => void) => {
      intervalListener = listener;
      return 42;
    }),
    clearInterval,
    addEventListener: (type: string, listener: () => void) => {
      const listeners = pageListeners.get(type) ?? new Set();
      listeners.add(listener);
      pageListeners.set(type, listeners);
    },
    removeEventListener: (type: string, listener: () => void) => {
      pageListeners.get(type)?.delete(listener);
    },
  };
  const document = {
    defaultView: view,
    visibilityState: 'visible',
    addEventListener: (type: string, listener: () => void) => {
      const listeners = documentListeners.get(type) ?? new Set();
      listeners.add(listener);
      documentListeners.set(type, listeners);
    },
    removeEventListener: (type: string, listener: () => void) => {
      documentListeners.get(type)?.delete(listener);
    },
  } as unknown as Document;
  return {
    document,
    view,
    clearInterval,
    tick: () => intervalListener?.(),
    focus: () => {
      for (const listener of pageListeners.get('focus') ?? []) listener();
    },
    visibility: () => {
      for (const listener of documentListeners.get('visibilitychange') ?? []) {
        listener();
      }
    },
    pageListenerCount: (type: string) => pageListeners.get(type)?.size ?? 0,
    documentListenerCount: (type: string) =>
      documentListeners.get(type)?.size ?? 0,
  };
};

describe('pair-tab convergence signal', () => {
  it('broadcasts only credential-free pair/state hints and filters messages', () => {
    FakeBroadcastChannel.latest = null;
    const browser = makeBrowser();
    const recoveryLock = makeExclusiveRecoveryLock();
    const convergence = createBrowserPairTabConvergence({
      document: browser.document,
      recoverySuccessorLockProvider: recoveryLock.provider,
    });
    const listener = vi.fn();
    convergence?.subscribe(listener);
    const broadcast = latestBroadcast();

    expect(convergence?.supportsImmediateSignals).toBe(true);
    expect(convergence?.supportsRecoverySuccessorElection).toBe(true);
    expect(broadcast?.name).toBe(PAIR_TAB_CONVERGENCE_CHANNEL_NAME);
    convergence?.notifyPairComplete();
    expect(broadcast?.postMessage).toHaveBeenCalledWith({
      type: 'recued.webclient.pair-complete',
      version: 1,
    });
    convergence?.notifyCredentialStateChanged();
    expect(broadcast?.postMessage).toHaveBeenCalledWith({
      type: 'recued.webclient.credential-state-changed',
      version: 1,
    });
    convergence?.notifyActiveServerProfileChanged();
    expect(broadcast?.postMessage).toHaveBeenCalledWith({
      type: 'recued.webclient.active-server-profile-changed',
      version: 1,
    });
    convergence?.notifyPairTransitionStarted();
    expect(broadcast?.postMessage).toHaveBeenCalledWith({
      type: 'recued.webclient.pair-transition-started',
      version: 1,
    });
    convergence?.notifyPairTakeoverStarted();
    expect(broadcast?.postMessage).toHaveBeenCalledWith({
      type: 'recued.webclient.pair-takeover-started',
      version: 1,
    });
    convergence?.notifyPairTakeoverNeedsAttention();
    expect(broadcast?.postMessage).toHaveBeenCalledWith({
      type: 'recued.webclient.pair-takeover-needs-attention',
      version: 1,
    });
    convergence?.notifyPairRecoverySuccessorChosen();
    expect(broadcast?.postMessage.mock.calls.slice(-2).map(([message]) =>
      message
    )).toEqual([
      {
        type: 'recued.webclient.pair-recovery-successor-chosen',
        version: 1,
      },
      {
        type: 'recued.webclient.pair-takeover-needs-attention',
        version: 1,
      },
    ]);

    broadcast?.emit({ type: 'unrelated', version: 1 });
    expect(listener).not.toHaveBeenCalled();
    broadcast?.emit({
      type: 'recued.webclient.pair-complete',
      version: 1,
    });
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenLastCalledWith('pair_complete');
    broadcast?.emit({
      type: 'recued.webclient.credential-state-changed',
      version: 1,
    });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith('credential_state_changed');
    broadcast?.emit({
      type: 'recued.webclient.active-server-profile-changed',
      version: 1,
    });
    expect(listener).toHaveBeenCalledTimes(3);
    expect(listener).toHaveBeenLastCalledWith(
      'active_server_profile_changed',
    );
    broadcast?.emit({
      type: 'recued.webclient.pair-transition-started',
      version: 1,
    });
    expect(listener).toHaveBeenCalledTimes(4);
    expect(listener).toHaveBeenLastCalledWith('pair_transition_started');
    broadcast?.emit({
      type: 'recued.webclient.pair-takeover-started',
      version: 1,
    });
    expect(listener).toHaveBeenCalledTimes(5);
    expect(listener).toHaveBeenLastCalledWith('pair_takeover_started');
    broadcast?.emit({
      type: 'recued.webclient.pair-takeover-needs-attention',
      version: 1,
    });
    expect(listener).toHaveBeenCalledTimes(6);
    expect(listener).toHaveBeenLastCalledWith(
      'pair_takeover_needs_attention',
    );
    broadcast?.emit({
      type: 'recued.webclient.pair-recovery-successor-chosen',
      version: 1,
    });
    expect(listener).toHaveBeenCalledTimes(7);
    expect(listener).toHaveBeenLastCalledWith(
      'pair_recovery_successor_chosen',
    );
    convergence?.close();
  });

  it('holds one atomic recovery-successor lease until the winner yields', async () => {
    const recoveryLock = makeExclusiveRecoveryLock();
    const first = createBrowserPairTabConvergence({
      document: makeBrowser().document,
      recoverySuccessorLockProvider: recoveryLock.provider,
    });
    const second = createBrowserPairTabConvergence({
      document: makeBrowser().document,
      recoverySuccessorLockProvider: recoveryLock.provider,
    });

    const firstLease = await first?.claimPairRecoverySuccessor();
    expect(firstLease).not.toBeNull();
    expect(recoveryLock.isHeld()).toBe(true);
    expect(await second?.claimPairRecoverySuccessor()).toBeNull();
    expect(recoveryLock.request).toHaveBeenLastCalledWith(
      PAIR_RECOVERY_SUCCESSOR_LOCK_NAME,
      { mode: 'exclusive', ifAvailable: true },
      expect.any(Function),
    );

    firstLease?.release();
    await vi.waitFor(() => expect(recoveryLock.isHeld()).toBe(false));
    const successorLease = await second?.claimPairRecoverySuccessor();
    expect(successorLease).not.toBeNull();
    expect(recoveryLock.isHeld()).toBe(true);

    second?.close();
    await vi.waitFor(() => expect(recoveryLock.isHeld()).toBe(false));
    first?.close();
  });

  it('keeps mounted-session reconciliation event driven when polling is disabled', () => {
    FakeBroadcastChannel.latest = null;
    const browser = makeBrowser();
    const convergence = createBrowserPairTabConvergence({
      document: browser.document,
      pollMs: null,
    });
    const listener = vi.fn();
    convergence?.subscribe(listener);

    expect(browser.view.setInterval).not.toHaveBeenCalled();
    browser.tick();
    expect(listener).not.toHaveBeenCalled();
    browser.focus();
    expect(listener).toHaveBeenCalledOnce();

    convergence?.close();
  });

  it('reconciles by polling or focus without BroadcastChannel and tears down', () => {
    const browser = makeBrowser(false);
    const convergence = createBrowserPairTabConvergence({
      document: browser.document,
      pollMs: 25,
    });
    const listener = vi.fn();
    convergence?.subscribe(listener);

    expect(convergence?.supportsImmediateSignals).toBe(false);
    expect(convergence?.supportsRecoverySuccessorElection).toBe(false);
    browser.tick();
    browser.focus();
    browser.visibility();
    expect(listener).toHaveBeenCalledTimes(3);

    convergence?.close();
    browser.tick();
    expect(listener).toHaveBeenCalledTimes(3);
    expect(browser.clearInterval).toHaveBeenCalledWith(42);
    expect(browser.pageListenerCount('focus')).toBe(0);
    expect(browser.documentListenerCount('visibilitychange')).toBe(0);
  });

  it('closes the broadcast listener and makes later notification a no-op', () => {
    FakeBroadcastChannel.latest = null;
    const browser = makeBrowser();
    const convergence = createBrowserPairTabConvergence({
      document: browser.document,
    });
    const broadcast = latestBroadcast();
    const listener = vi.fn();
    convergence?.subscribe(listener);

    convergence?.close();
    convergence?.notifyPairComplete();
    convergence?.notifyCredentialStateChanged();
    convergence?.notifyPairTransitionStarted();
    convergence?.notifyPairTakeoverStarted();
    convergence?.notifyPairTakeoverNeedsAttention();
    convergence?.notifyPairRecoverySuccessorChosen();
    broadcast?.emit({
      type: 'recued.webclient.pair-complete',
      version: 1,
    });

    expect(listener).not.toHaveBeenCalled();
    expect(broadcast?.listenerCount()).toBe(0);
    expect(broadcast?.close).toHaveBeenCalledOnce();
    expect(broadcast?.postMessage).not.toHaveBeenCalled();
  });
});
