import { createInMemoryCollection } from '@recued/storage';
import { describe, expect, it, vi } from 'vitest';
import {
  createAskStore,
  type NewPendingAsk,
  type PendingAsk,
} from '../index.js';
import {
  createHandlerRegistry,
  dispatchAnswer,
} from '../handler-registry.js';

const makeAsk = (
  ask_id: string,
  handler_kind = 'gateway.preflight',
): NewPendingAsk => ({
  ask_id,
  message: { text: 'Approve this action?' },
  options: [
    { id: 'approve', label: 'Approve' },
    { id: 'reject', label: 'Reject' },
  ],
  handler_kind,
  handler_payload: { checkpoint_id: ask_id },
  fanout_channels: ['ui'],
  created_at: 1000,
});

describe('D-158 P0 handler registry', () => {
  it('registers and retrieves a handler by stable kind', () => {
    const registry = createHandlerRegistry();
    const handler = vi.fn();

    registry.register('gateway.preflight', handler);

    expect(registry.get('gateway.preflight')).toBe(handler);
    expect(registry.get('gateway.in_doubt')).toBeUndefined();
  });

  it('throws on duplicate handler kind registration', () => {
    const registry = createHandlerRegistry();
    registry.register('gateway.preflight', vi.fn());

    expect(() => {
      registry.register('gateway.preflight', vi.fn());
    }).toThrow(/already registered/);
  });
});

describe('D-158 P0 dispatchAnswer', () => {
  it('returns false without side effects when the ask is not answered', async () => {
    const store = createAskStore(createInMemoryCollection<PendingAsk>());
    const registry = createHandlerRegistry();
    const handler = vi.fn();
    registry.register('gateway.preflight', handler);
    await store.create(makeAsk('ask-open'));
    const ask = await store.get('ask-open');
    expect(ask).not.toBeNull();

    await expect(
      dispatchAnswer({ registry, store, ask: ask as PendingAsk }),
    ).resolves.toBe(false);

    expect(handler).not.toHaveBeenCalled();
    expect(await store.get('ask-open')).toMatchObject({ status: 'open' });
  });

  it('returns false and leaves an answered ask durable when no handler is registered', async () => {
    const store = createAskStore(createInMemoryCollection<PendingAsk>());
    const registry = createHandlerRegistry();
    await store.create(makeAsk('ask-unregistered', 'gateway.in_doubt'));
    await store.recordAnswer(
      'ask-unregistered',
      { option: 'reject', answered_at: 2000 },
      'ui',
    );
    const ask = await store.get('ask-unregistered');
    expect(ask).not.toBeNull();

    await expect(
      dispatchAnswer({ registry, store, ask: ask as PendingAsk }),
    ).resolves.toBe(false);

    expect(await store.get('ask-unregistered')).toMatchObject({
      status: 'answered',
      answer: { option: 'reject', answered_at: 2000 },
    });
  });

  it('invokes the handler with payload plus stripped answer and marks handled', async () => {
    const store = createAskStore(createInMemoryCollection<PendingAsk>());
    const registry = createHandlerRegistry();
    const handler = vi.fn();
    registry.register('gateway.preflight', handler);
    await store.create(makeAsk('ask-dispatch'));
    await store.recordAnswer(
      'ask-dispatch',
      { option: 'approve', answered_at: 2000 },
      'ui',
    );
    const ask = await store.get('ask-dispatch');
    expect(ask).not.toBeNull();

    await expect(
      dispatchAnswer({ registry, store, ask: ask as PendingAsk }),
    ).resolves.toBe(true);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      { checkpoint_id: 'ask-dispatch' },
      { option: 'approve', answered_at: 2000 },
    );
    expect(Object.keys(handler.mock.calls[0]?.[1] ?? {}).sort()).toEqual([
      'answered_at',
      'option',
    ]);
    expect(await store.get('ask-dispatch')).toMatchObject({
      status: 'handled',
    });
  });

  it('propagates handler failures and leaves the ask answered for boot retry', async () => {
    const store = createAskStore(createInMemoryCollection<PendingAsk>());
    const registry = createHandlerRegistry();
    registry.register('gateway.preflight', async () => {
      throw new Error('handler unavailable');
    });
    await store.create(makeAsk('ask-handler-fails'));
    await store.recordAnswer(
      'ask-handler-fails',
      { option: 'approve', answered_at: 2000 },
      'ui',
    );
    const ask = await store.get('ask-handler-fails');
    expect(ask).not.toBeNull();

    await expect(
      dispatchAnswer({ registry, store, ask: ask as PendingAsk }),
    ).rejects.toThrow('handler unavailable');

    expect(await store.get('ask-handler-fails')).toMatchObject({
      status: 'answered',
      answer: { option: 'approve', answered_at: 2000 },
    });
  });
});
