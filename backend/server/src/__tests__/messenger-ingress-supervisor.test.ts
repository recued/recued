import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import { createMessengerIngressSupervisor } from '../messenger-ingress/supervisor.js';
import type {
  MessengerLocalIngressRunner,
  TelegramPollRunnerOptions,
} from '../messenger-ingress/local-runners.js';
import { createConnectionStore } from '../storage/connection-store.js';
import { createMessengerIngressStateStore } from '../storage/messenger-ingress-state-store.js';
import type { VaultState, VaultStateListener } from '../vault-state-bus.js';
import type { MessengerWebhookDispatch } from '../composition/bin/wire-inbound-answer-dispatcher.js';

const eventually = async (predicate: () => boolean): Promise<void> => {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('condition was not reached');
};

describe('messenger ingress supervisor', () => {
  it('preserves legacy webhook rows and starts/stops one explicit local runner on changes', async () => {
    const db = new Database(':memory:');
    const connectionStore = createConnectionStore(db);
    const stateStore = createMessengerIngressStateStore(db);
    const localStart = vi.fn();
    const localStop = vi.fn(async () => undefined);
    const runner: MessengerLocalIngressRunner = { start: localStart, stop: localStop };
    let telegramOptions: TelegramPollRunnerOptions | null = null;
    let vaultState: VaultState = 'unlocked';
    let vaultListener: VaultStateListener = () => undefined;
    let paused = false;
    const dispatch = vi.fn(async (_event: Parameters<MessengerWebhookDispatch>[0]) => undefined);
    const supervisor = createMessengerIngressSupervisor({
      connectionStore,
      stateStore,
      dispatchers: { telegram: dispatch },
      decodeAuth: async () => ({ type: 'bearer', token: 'bot-token' }),
      isPaused: () => paused,
      isVaultUnlocked: () => vaultState === 'unlocked',
      subscribeVault: (listener) => {
        vaultListener = listener;
        return () => { vaultListener = () => undefined; };
      },
      runnerFactory: {
        telegram(options) { telegramOptions = options; return runner; },
        slack() { throw new Error('unexpected Slack runner'); },
        discord() { throw new Error('unexpected Discord runner'); },
        teams() { throw new Error('unexpected Teams runner'); },
      },
    });

    connectionStore.upsert({
      kind: 'notification',
      name: 'telegram',
      subtype: 'telegram',
      display_name: 'Telegram',
      // No ingress_mode: this is a pre-upgrade row and must stay webhook.
      config_json: JSON.stringify({ chat_id: '1', webhook_secret: 'secret' }),
      auth_ciphertext: 'cipher-a',
      enrolled_at: 1,
      updated_at: 1,
    });
    await supervisor.start();
    expect(localStart).not.toHaveBeenCalled();
    expect(supervisor.status('telegram', 'telegram')).toMatchObject({
      mode: 'webhook',
      state: 'webhook',
    });

    connectionStore.upsert({
      ...connectionStore.get('notification', 'telegram')!,
      config_json: JSON.stringify({ chat_id: '1', ingress_mode: 'poll' }),
      updated_at: 2,
    });
    await eventually(() => localStart.mock.calls.length === 1);
    expect(supervisor.status('telegram', 'telegram')).toMatchObject({
      mode: 'poll',
      state: 'connecting',
    });

    // Health-only restamps do not churn a healthy network connection.
    connectionStore.upsert({
      ...connectionStore.get('notification', 'telegram')!,
      health_json: JSON.stringify({ status: 'ok' }),
      updated_at: 3,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(localStart).toHaveBeenCalledTimes(1);
    expect(localStop).not.toHaveBeenCalled();

    paused = true;
    await expect(telegramOptions!.dispatch({ connection_name: 'telegram', payload: {} }))
      .rejects.toThrow(/paused/);

    vaultState = 'locked';
    vaultListener('locked', 'unlocked');
    await eventually(() => localStop.mock.calls.length === 1);
    expect(supervisor.status('telegram', 'telegram')?.state).toBe('locked');

    vaultState = 'unlocked';
    vaultListener('unlocked', 'locked');
    await eventually(() => localStart.mock.calls.length === 2);

    connectionStore.upsert({
      ...connectionStore.get('notification', 'telegram')!,
      config_json: JSON.stringify({
        chat_id: '1',
        ingress_mode: 'webhook',
        webhook_secret: 'secret',
      }),
      updated_at: 4,
    });
    await eventually(() => localStop.mock.calls.length === 2);
    expect(supervisor.status('telegram', 'telegram')?.state).toBe('webhook');

    // Re-enroll can replace the subtype at the same (kind, name) key. The old
    // vendor's webhook-only status must disappear even though no runner is
    // active for it.
    connectionStore.upsert({
      ...connectionStore.get('notification', 'telegram')!,
      subtype: 'slack',
      config_json: JSON.stringify({
        channel_id: 'C1',
        ingress_mode: 'webhook',
        signing_secret: 'secret',
      }),
      updated_at: 5,
    });
    await eventually(() => supervisor.status('slack', 'telegram')?.state === 'webhook');
    expect(supervisor.status('telegram', 'telegram')).toBeNull();

    connectionStore.delete('notification', 'telegram');
    await eventually(() => supervisor.status('slack', 'telegram') === null);

    await supervisor.stop();
    db.close();
  });

  it('reports webhook mode inactive when its verification material is absent', async () => {
    const db = new Database(':memory:');
    const connectionStore = createConnectionStore(db);
    const stateStore = createMessengerIngressStateStore(db);
    connectionStore.upsert({
      kind: 'notification',
      name: 'telegram',
      subtype: 'telegram',
      display_name: 'Telegram',
      config_json: JSON.stringify({ chat_id: '1', ingress_mode: 'webhook' }),
      auth_ciphertext: 'cipher-a',
      enrolled_at: 1,
      updated_at: 1,
    });
    const supervisor = createMessengerIngressSupervisor({
      connectionStore,
      stateStore,
      dispatchers: { telegram: vi.fn(async () => undefined) },
      decodeAuth: async () => ({ type: 'bearer', token: 'bot-token' }),
    });

    await supervisor.start();
    expect(supervisor.status('telegram', 'telegram')).toMatchObject({
      mode: 'webhook',
      state: 'invalid',
      detail: 'webhook_secret is missing',
    });
    await supervisor.stop();
    db.close();
  });

  it('fences a replayed delivery without swallowing the retry of a failed one', async () => {
    const db = new Database(':memory:');
    const connectionStore = createConnectionStore(db);
    const stateStore = createMessengerIngressStateStore(db);
    let telegramOptions: TelegramPollRunnerOptions | null = null;
    let failNext = false;
    const dispatch = vi.fn(async (_event: Parameters<MessengerWebhookDispatch>[0]) => {
      if (failNext) throw new Error('warehouse write failed');
    });
    const supervisor = createMessengerIngressSupervisor({
      connectionStore,
      stateStore,
      dispatchers: { telegram: dispatch },
      decodeAuth: async () => ({ type: 'bearer', token: 'bot-token' }),
      runnerFactory: {
        telegram(options) {
          telegramOptions = options;
          return { start: () => undefined, stop: async () => undefined };
        },
        slack() { throw new Error('unexpected Slack runner'); },
        discord() { throw new Error('unexpected Discord runner'); },
        teams() { throw new Error('unexpected Teams runner'); },
      },
    });
    connectionStore.upsert({
      kind: 'notification',
      name: 'telegram',
      subtype: 'telegram',
      display_name: 'Telegram',
      config_json: JSON.stringify({ chat_id: '1', ingress_mode: 'poll' }),
      auth_ciphertext: 'cipher-a',
      enrolled_at: 1,
      updated_at: 1,
    });
    await supervisor.start();
    await eventually(() => telegramOptions !== null);
    const deliver = (update_id: string): Promise<void> =>
      telegramOptions!.dispatch({ connection_name: 'telegram', payload: {}, update_id } as
        Parameters<MessengerWebhookDispatch>[0]);

    await deliver('7');
    expect(dispatch).toHaveBeenCalledTimes(1);
    // The redelivery every local transport can produce — a re-fetched update, a
    // re-sent envelope, a replayed sequence. It must not re-run the turn.
    await deliver('7');
    expect(dispatch).toHaveBeenCalledTimes(1);

    // The control that decides WHERE the fence records. A dispatch that threw
    // is the case the runners deliberately retry (that is what keeps a cursor
    // honest), so recording on the attempt would turn the retry into a silent
    // drop — the message would be lost, not deduplicated.
    failNext = true;
    await expect(deliver('8')).rejects.toThrow(/warehouse write failed/);
    failNext = false;
    await deliver('8');
    expect(dispatch).toHaveBeenCalledTimes(3);
    // ...and having now succeeded, 8 is fenced like any other.
    await deliver('8');
    expect(dispatch).toHaveBeenCalledTimes(3);

    await supervisor.stop();
    db.close();
  });

  it('does not start a runner when shutdown races an in-flight credential decode', async () => {
    const db = new Database(':memory:');
    const connectionStore = createConnectionStore(db);
    const stateStore = createMessengerIngressStateStore(db);
    connectionStore.upsert({
      kind: 'notification',
      name: 'telegram',
      subtype: 'telegram',
      display_name: 'Telegram',
      config_json: JSON.stringify({ chat_id: '1', ingress_mode: 'poll' }),
      auth_ciphertext: 'cipher-a',
      enrolled_at: 1,
      updated_at: 1,
    });
    let releaseDecode!: (auth: { type: 'bearer'; token: string }) => void;
    const decode = new Promise<{ type: 'bearer'; token: string }>((resolve) => {
      releaseDecode = resolve;
    });
    const localStart = vi.fn();
    const localStop = vi.fn(async () => undefined);
    const supervisor = createMessengerIngressSupervisor({
      connectionStore,
      stateStore,
      dispatchers: { telegram: vi.fn(async () => undefined) },
      decodeAuth: async () => decode,
      runnerFactory: {
        telegram() { return { start: localStart, stop: localStop }; },
        slack() { throw new Error('unexpected Slack runner'); },
        discord() { throw new Error('unexpected Discord runner'); },
        teams() { throw new Error('unexpected Teams runner'); },
      },
    });

    const starting = supervisor.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const stopping = supervisor.stop();
    releaseDecode({ type: 'bearer', token: 'bot-token' });
    await Promise.all([starting, stopping]);

    expect(localStart).not.toHaveBeenCalled();
    expect(localStop).not.toHaveBeenCalled();
    db.close();
  });

  it('waits for every runner before surfacing a sibling stop failure', async () => {
    const db = new Database(':memory:');
    const connectionStore = createConnectionStore(db);
    const stateStore = createMessengerIngressStateStore(db);
    for (const subtype of ['telegram', 'slack'] as const) {
      connectionStore.upsert({
        kind: 'notification',
        name: subtype,
        subtype,
        display_name: subtype,
        config_json: JSON.stringify({
          ingress_mode: subtype === 'telegram' ? 'poll' : 'socket',
        }),
        auth_ciphertext: `cipher-${subtype}`,
        enrolled_at: 1,
        updated_at: 1,
      });
    }

    let releaseSlowStop!: () => void;
    const failedStop = vi.fn(async () => {
      throw new Error('telegram stop failed');
    });
    const slowStop = vi.fn(() =>
      new Promise<void>((resolve) => {
        releaseSlowStop = resolve;
      }));
    const supervisor = createMessengerIngressSupervisor({
      connectionStore,
      stateStore,
      dispatchers: {
        telegram: vi.fn(async () => undefined),
        slack: vi.fn(async () => undefined),
      },
      decodeAuth: async () => ({
        type: 'bearer',
        token: 'bot-token',
        app_token: 'app-token',
      }),
      runnerFactory: {
        telegram() { return { start: vi.fn(), stop: failedStop }; },
        slack() { return { start: vi.fn(), stop: slowStop }; },
        discord() { throw new Error('unexpected Discord runner'); },
        teams() { throw new Error('unexpected Teams runner'); },
      },
    });
    await supervisor.start();

    let settled = false;
    let stopError: unknown;
    const rawStop = supervisor.stop();
    expect(supervisor.stop()).toBe(rawStop);
    const firstStop = rawStop.catch((error) => {
      stopError = error;
    }).finally(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(failedStop).toHaveBeenCalledTimes(1);
    expect(slowStop).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    releaseSlowStop();
    await firstStop;
    expect(stopError).toBeInstanceOf(AggregateError);
    expect((stopError as Error).message).toContain(
      'one or more messenger ingress runners failed to stop',
    );
    db.close();
  });
});
