/** The busy registry — which sessions are running a turn.
 *
 *  The behaviour worth protecting is the refcount and the transition-only
 *  broadcast; the behaviour worth protecting HARDEST is that a thrown turn
 *  releases, because a session stuck busy forever is worse than no busy state
 *  at all.
 */

import { describe, expect, it } from 'vitest';

import {
  createChatSessionBusyRegistry,
  withChatSessionBusy,
} from '../chat-session-busy.js';

const emitterSpy = () => {
  const events: Array<{ session_id: string; field: string; value: unknown }> = [];
  return {
    events,
    emitter: {
      emit: (event: unknown) => {
        const e = event as { session_id: string; field: string; value: unknown };
        events.push({ session_id: e.session_id, field: e.field, value: e.value });
      },
    },
  };
};

describe('chat session busy registry', () => {
  it('reports the complete set, and an empty one when nothing runs', () => {
    const registry = createChatSessionBusyRegistry();
    expect(registry.busySessionIds()).toEqual([]);
    const release = registry.enter('sess-1');
    expect(registry.busySessionIds()).toEqual(['sess-1']);
    expect(registry.isBusy('sess-1')).toBe(true);
    release();
    expect(registry.busySessionIds()).toEqual([]);
    expect(registry.isBusy('sess-1')).toBe(false);
  });

  it('broadcasts only on the transition, not once per turn', () => {
    const { events, emitter } = emitterSpy();
    const registry = createChatSessionBusyRegistry(emitter);
    const first = registry.enter('sess-1');
    const second = registry.enter('sess-1');
    expect(events).toEqual([
      { session_id: 'sess-1', field: 'busy', value: true },
    ]);

    // ⛔ The FIRST of two concurrent turns finishing must not declare the
    // session idle — a plain boolean would, which is why this is refcounted.
    first();
    expect(registry.isBusy('sess-1')).toBe(true);
    expect(events).toHaveLength(1);

    second();
    expect(registry.isBusy('sess-1')).toBe(false);
    expect(events).toEqual([
      { session_id: 'sess-1', field: 'busy', value: true },
      { session_id: 'sess-1', field: 'busy', value: false },
    ]);
  });

  it('ignores a release called twice rather than dropping below the live count', () => {
    const registry = createChatSessionBusyRegistry();
    const release = registry.enter('sess-1');
    const other = registry.enter('sess-1');
    release();
    release();
    release();
    // Still busy: `other` has not released, and no amount of over-releasing
    // the first turn may say otherwise.
    expect(registry.isBusy('sess-1')).toBe(true);
    other();
    expect(registry.isBusy('sess-1')).toBe(false);
  });

  it('a broadcast that throws never takes the turn down with it', () => {
    const registry = createChatSessionBusyRegistry({
      emit: () => {
        throw new Error('bus is down');
      },
    });
    expect(() => registry.enter('sess-1')()).not.toThrow();
    expect(registry.isBusy('sess-1')).toBe(false);
  });
});

describe('withChatSessionBusy', () => {
  const orchestratorDouble = (
    runTurn: () => Promise<unknown>,
    runMessengerTurn: () => Promise<unknown> = async () => ({}),
  ) => ({
    runTurn,
    runMessengerTurn,
    sessionStore: {} as never,
    dispatch: {} as never,
  });

  it('marks the session for the life of the turn and releases on return', async () => {
    const registry = createChatSessionBusyRegistry();
    let observedDuringTurn: boolean | null = null;
    const wrapped = withChatSessionBusy(
      orchestratorDouble(async () => {
        observedDuringTurn = registry.isBusy('sess-1');
        return { turn_id: 't1' };
      }) as never,
      registry,
    );
    await wrapped.runTurn({ session_id: 'sess-1' } as never);
    expect(observedDuringTurn).toBe(true);
    expect(registry.isBusy('sess-1')).toBe(false);
  });

  /** ⛔ THE ONE THAT MATTERS. A turn that throws still has to release: a
   *  session left busy forever locks its composer on every client, and no
   *  later event exists to correct it. */
  it('releases when the turn throws', async () => {
    const registry = createChatSessionBusyRegistry();
    const wrapped = withChatSessionBusy(
      orchestratorDouble(async () => {
        throw new Error('turn died');
      }) as never,
      registry,
    );
    await expect(
      wrapped.runTurn({ session_id: 'sess-1' } as never),
    ).rejects.toThrow('turn died');
    expect(registry.isBusy('sess-1')).toBe(false);
  });

  it('marks the messenger turn against the session its inbound names', async () => {
    const registry = createChatSessionBusyRegistry();
    const seen: boolean[] = [];
    const wrapped = withChatSessionBusy(
      orchestratorDouble(
        async () => ({}),
        async () => {
          seen.push(registry.isBusy('sess-msg'));
          return { turn_id: 't1' };
        },
      ) as never,
      registry,
    );
    await wrapped.runMessengerTurn({
      inbound: { session_id: 'sess-msg' },
    } as never);
    expect(seen).toEqual([true]);
    expect(registry.isBusy('sess-msg')).toBe(false);
  });

  it('leaves the rest of the orchestrator surface intact', () => {
    const registry = createChatSessionBusyRegistry();
    const marker = { marker: true };
    const wrapped = withChatSessionBusy(
      { ...orchestratorDouble(async () => ({})), sessionStore: marker } as never,
      registry,
    );
    expect((wrapped as unknown as { sessionStore: unknown }).sessionStore)
      .toBe(marker);
  });
});
