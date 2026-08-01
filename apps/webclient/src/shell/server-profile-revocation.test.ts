import { describe, expect, it, vi } from 'vitest';

import {
  isInstanceRevokedReceiptFor,
  runSelfPairRevocation,
} from './server-profile-revocation.js';

const messageHarness = () => {
  const listeners = new Set<(message: unknown) => void>();
  const detach = vi.fn();
  return {
    onMessage(listener: (message: unknown) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        detach();
      };
    },
    fire(message: unknown): void {
      for (const listener of [...listeners]) listener(message);
    },
    listenerCount: (): number => listeners.size,
    detach,
  };
};

describe('runSelfPairRevocation', () => {
  it('accepts the ordinary pair.revoke reply and detaches its receipt listener', async () => {
    const messages = messageHarness();
    const runRevoke = vi.fn(async () => ({ revoked: true }));

    await runSelfPairRevocation({
      instanceId: 'instance-a',
      runRevoke,
      onMessage: messages.onMessage,
    });

    expect(runRevoke).toHaveBeenCalledOnce();
    expect(messages.listenerCount()).toBe(0);
    expect(messages.detach).toHaveBeenCalledOnce();
  });

  it('treats the matching instance_revoked frame as an authoritative receipt', async () => {
    const messages = messageHarness();
    let signal: AbortSignal | undefined;
    const runRevoke = vi.fn((nextSignal: AbortSignal) => {
      signal = nextSignal;
      return new Promise<never>(() => undefined);
    });
    const result = runSelfPairRevocation({
      instanceId: 'instance-a',
      runRevoke,
      onMessage: messages.onMessage,
    });

    await Promise.resolve();
    messages.fire({ type: 'instance_revoked', instance_id: 'instance-b' });
    expect(signal?.aborted).toBe(false);
    messages.fire({ type: 'instance_revoked', instance_id: 'instance-a' });
    await result;

    expect(signal?.aborted).toBe(true);
    expect(messages.listenerCount()).toBe(0);
  });

  it('allows the final matching frame to arrive just after the rpc rejects', async () => {
    const messages = messageHarness();
    let expireGrace: (() => void) | undefined;
    const result = runSelfPairRevocation({
      instanceId: 'instance-a',
      runRevoke: async () => {
        throw new Error('connection lost');
      },
      onMessage: messages.onMessage,
      setTimer: (handler) => {
        expireGrace = handler;
        return { cancel: vi.fn() };
      },
    });

    await vi.waitFor(() => {
      expect(expireGrace).toEqual(expect.any(Function));
    });
    messages.fire({ type: 'instance_revoked', instance_id: 'instance-a' });

    await expect(result).resolves.toBeUndefined();
  });

  it('rejects after grace when neither a reply nor a matching receipt exists', async () => {
    const messages = messageHarness();
    let expireGrace: (() => void) | undefined;
    const failure = new Error('server refused revoke');
    const result = runSelfPairRevocation({
      instanceId: 'instance-a',
      runRevoke: async () => {
        throw failure;
      },
      onMessage: messages.onMessage,
      setTimer: (handler) => {
        expireGrace = handler;
        return { cancel: vi.fn() };
      },
    });

    await vi.waitFor(() => {
      expect(expireGrace).toEqual(expect.any(Function));
    });
    messages.fire({ type: 'instance_revoked', instance_id: 'instance-b' });
    expireGrace!();

    await expect(result).rejects.toBe(failure);
    expect(messages.listenerCount()).toBe(0);
  });
});

describe('isInstanceRevokedReceiptFor', () => {
  it('requires both the direct-frame type and the exact instance id', () => {
    expect(isInstanceRevokedReceiptFor(
      { type: 'instance_revoked', instance_id: 'instance-a' },
      'instance-a',
    )).toBe(true);
    expect(isInstanceRevokedReceiptFor(
      { type: 'instance_revoked', instance_id: 'instance-b' },
      'instance-a',
    )).toBe(false);
    expect(isInstanceRevokedReceiptFor(
      { type: 'server_event', instance_id: 'instance-a' },
      'instance-a',
    )).toBe(false);
  });
});
