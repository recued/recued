import { createHash } from 'node:crypto';

import {
  getMessengerVendorDeclaration,
  resolveMessengerConnectionIngressMode,
  type ConnectionAuth,
  type ConnectionRow,
  type MessengerIngressMode,
} from '@recued/contracts';

import type { ConnectionStoreSqlite } from '../storage/connection-store.js';
import type { MessengerIngressStateStore } from '../storage/messenger-ingress-state-store.js';
import type { VaultState } from '../vault-state-bus.js';
import type { MessengerWebhookDispatch } from '../composition/bin/wire-inbound-answer-dispatcher.js';
import {
  createIdempotencyLedger,
  type IdempotencyLedger,
} from '../ports/webhook/idempotency-ledger.js';
import {
  createDiscordGatewayRunner,
  createSlackSocketRunner,
  createTelegramPollRunner,
  type DiscordGatewayRunnerOptions,
  type MessengerIngressRunnerState,
  type MessengerLocalIngressRunner,
  type SlackSocketRunnerOptions,
  type TelegramPollRunnerOptions,
} from './local-runners.js';

export type MessengerIngressSupervisorState =
  | MessengerIngressRunnerState
  | 'webhook'
  | 'locked'
  | 'invalid';

export interface MessengerIngressSupervisorStatus {
  vendor: string;
  connection_name: string;
  mode: MessengerIngressMode | null;
  state: MessengerIngressSupervisorState;
  detail?: string;
}

export interface MessengerIngressRunnerFactory {
  telegram(options: TelegramPollRunnerOptions): MessengerLocalIngressRunner;
  slack(options: SlackSocketRunnerOptions): MessengerLocalIngressRunner;
  discord(options: DiscordGatewayRunnerOptions): MessengerLocalIngressRunner;
}

export interface MessengerIngressSupervisor {
  start(): Promise<void>;
  stop(): Promise<void>;
  reconcile(): Promise<void>;
  status(vendor: string, connectionName: string): MessengerIngressSupervisorStatus | null;
}

export interface MessengerIngressSupervisorOptions {
  connectionStore: ConnectionStoreSqlite;
  stateStore: MessengerIngressStateStore;
  dispatchers: Readonly<Record<string, MessengerWebhookDispatch>>;
  decodeAuth: (row: ConnectionRow) => Promise<ConnectionAuth>;
  isPaused?: () => boolean;
  isVaultUnlocked?: () => boolean;
  subscribeVault?: (listener: (state: VaultState, previous: VaultState) => void) => () => void;
  runnerFactory?: MessengerIngressRunnerFactory;
  /** Replay fence for local ingress. Defaults to a fresh ledger with the
   *  same 24-hour window the webhook port uses. Injectable for tests. */
  ledger?: IdempotencyLedger;
  log?: (level: 'info' | 'warn', message: string, data?: Record<string, unknown>) => void;
}

interface ActiveRunner {
  rowName: string;
  fingerprint: string;
  generation: symbol;
  runner: MessengerLocalIngressRunner;
}

const defaultRunnerFactory: MessengerIngressRunnerFactory = {
  telegram: createTelegramPollRunner,
  slack: createSlackSocketRunner,
  discord: createDiscordGatewayRunner,
};

const keyOf = (vendor: string, connectionName: string): string =>
  `${vendor}\u0000${connectionName}`;

const splitKey = (key: string): { vendor: string; connectionName: string } => {
  const separator = key.indexOf('\u0000');
  return separator < 0
    ? { vendor: key, connectionName: '' }
    : { vendor: key.slice(0, separator), connectionName: key.slice(separator + 1) };
};

const parseConfig = (row: ConnectionRow): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(row.config_json) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
};

export const createMessengerIngressSupervisor = (
  options: MessengerIngressSupervisorOptions,
): MessengerIngressSupervisor => {
  const factory = options.runnerFactory ?? defaultRunnerFactory;
  const ledger = options.ledger ?? createIdempotencyLedger();
  const active = new Map<string, ActiveRunner>();
  const statuses = new Map<string, MessengerIngressSupervisorStatus>();
  const chains = new Map<string, Promise<void>>();
  let unsubscribeUpsert: (() => void) | null = null;
  let unsubscribeDelete: (() => void) | null = null;
  let unsubscribeVault: (() => void) | null = null;
  let started = false;
  let stopped = false;
  let stopPromise: Promise<void> | undefined;

  const setStatus = (
    vendor: string,
    connectionName: string,
    mode: MessengerIngressMode | null,
    state: MessengerIngressSupervisorState,
    detail?: string,
  ): void => {
    statuses.set(keyOf(vendor, connectionName), {
      vendor,
      connection_name: connectionName,
      mode,
      state,
      ...(detail ? { detail } : {}),
    });
  };

  const stopKey = async (key: string): Promise<void> => {
    const current = active.get(key);
    if (current === undefined) return;
    active.delete(key);
    await current.runner.stop();
  };

  const applyRow = async (row: ConnectionRow): Promise<void> => {
    if (stopped || row.kind !== 'notification' || row.subtype === undefined) return;
    const declaration = getMessengerVendorDeclaration(row.subtype);
    if (declaration === null) return;
    const vendor = declaration.vendor;
    const key = keyOf(vendor, row.name);
    const config = parseConfig(row);
    if (config === null) {
      await stopKey(key);
      setStatus(vendor, row.name, null, 'invalid', 'connection config is not valid JSON');
      return;
    }
    const mode = resolveMessengerConnectionIngressMode(declaration, config);
    if (mode === null) {
      await stopKey(key);
      setStatus(vendor, row.name, null, 'invalid', 'unsupported connection ingress mode');
      return;
    }
    if (mode === 'webhook') {
      await stopKey(key);
      options.stateStore.delete(vendor, row.name);
      const secretField = declaration.ingress.secret_field;
      if (
        secretField === undefined
        || typeof config[secretField] !== 'string'
        || (config[secretField] as string).trim().length === 0
      ) {
        setStatus(
          vendor,
          row.name,
          mode,
          'invalid',
          `${secretField ?? 'webhook verification material'} is missing`,
        );
        return;
      }
      setStatus(vendor, row.name, mode, 'webhook');
      return;
    }

    const dispatch = options.dispatchers[vendor];
    if (dispatch === undefined) {
      await stopKey(key);
      setStatus(vendor, row.name, mode, 'invalid', 'no inbound dispatcher is wired');
      return;
    }
    if (options.isVaultUnlocked?.() === false) {
      await stopKey(key);
      setStatus(vendor, row.name, mode, 'locked', 'server vault is locked');
      return;
    }

    const fingerprint = `${mode}\u0000${row.config_json}\u0000${row.auth_ciphertext}`;
    if (active.get(key)?.fingerprint === fingerprint) return;
    await stopKey(key);

    let auth: ConnectionAuth;
    try {
      auth = await options.decodeAuth(row);
    } catch (error) {
      setStatus(
        vendor,
        row.name,
        mode,
        options.isVaultUnlocked?.() === false ? 'locked' : 'error',
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    // `stop()` can race an in-flight vault decode from an upsert reconcile.
    // Recheck after the last await before publishing/starting a runner; otherwise
    // shutdown can observe no active runner, wait for this chain, and return just
    // after the chain creates a network loop that nobody owns anymore.
    if (stopped) return;
    if (auth.type !== 'bearer' || auth.token.trim().length === 0) {
      setStatus(vendor, row.name, mode, 'invalid', 'messenger bot token is missing');
      return;
    }
    const credentialFingerprint = createHash('sha256')
      .update(row.auth_ciphertext)
      .digest('hex');
    const savedState = options.stateStore.get(vendor, row.name);
    if (
      savedState !== null
      && (
        savedState.mode !== mode
        || savedState.credential_fingerprint !== credentialFingerprint
      )
    ) {
      options.stateStore.delete(vendor, row.name);
    }

    const generation = Symbol(key);
    const onState = (state: MessengerIngressRunnerState, detail?: string): void => {
      if (active.get(key)?.generation !== generation) return;
      setStatus(vendor, row.name, mode, state, detail);
    };
    // The webhook port fences replays inside its request handler, which local
    // ingress never enters — so the fence lives here, on the one seam every
    // runner dispatches through. `wire-messenger-turn.ts` states the invariant
    // it depends on: a redelivery of the same event must not re-run a turn.
    // Every local transport CAN redeliver by design (Telegram re-fetches an
    // update whose cursor write failed, Slack re-sends an unacked envelope, a
    // Discord RESUME replays past the last persisted sequence), so without this
    // the same message drives a second LLM run.
    //
    // Keyed per connection, not per vendor: a native id is only unique within
    // the credential that issued it (two Telegram bots each number their own
    // `update_id` from 1), and the supervisor does not require name === vendor.
    const replayScope = `${vendor}:${row.name}`;
    const idField = declaration.ingress.id_field;
    const common = {
      connectionName: row.name,
      credentialFingerprint,
      dispatch: async (event: Parameters<MessengerWebhookDispatch>[0]) => {
        if (options.isPaused?.() === true) {
          throw new Error('server is paused — messenger ingress is closed');
        }
        if (options.isVaultUnlocked?.() === false) {
          throw new Error('server vault is locked — messenger ingress is closed');
        }
        const rawId = (event as unknown as Record<string, unknown>)[idField];
        const eventId = typeof rawId === 'string' && rawId.length > 0 ? rawId : null;
        if (eventId !== null && ledger.seen(replayScope, eventId)) {
          options.log?.('info', 'messenger ingress dropped a replayed delivery', {
            connection_name: row.name,
            vendor,
            [idField]: eventId,
          });
          // Resolve rather than throw: the delivery IS handled, so the runner
          // should advance its cursor / acknowledge instead of retrying.
          return;
        }
        await dispatch(event);
        // Record only after the dispatch resolves. Recording on the attempt
        // would convert a failed dispatch — the case every runner deliberately
        // retries — into a silent drop on the retry.
        if (eventId !== null) ledger.record(replayScope, eventId);
      },
      stateStore: options.stateStore,
      onState,
      ...(options.log ? { log: options.log } : {}),
    };

    let runner: MessengerLocalIngressRunner | null = null;
    if (vendor === 'telegram' && mode === 'poll') {
      runner = factory.telegram({ ...common, botToken: auth.token });
    } else if (vendor === 'slack' && mode === 'socket') {
      if (typeof auth.app_token !== 'string' || auth.app_token.trim().length === 0) {
        setStatus(vendor, row.name, mode, 'invalid', 'Slack app-level token is missing');
        return;
      }
      runner = factory.slack({ ...common, appToken: auth.app_token });
    } else if (vendor === 'discord' && mode === 'socket') {
      // The declared recipient field IS the bound conversation the rest of the
      // messenger layer gates on — read it from the same row so a rebind moves
      // the filter with it (an upsert re-runs applyRow with a new fingerprint).
      const boundChannel = config[declaration.recipient.field];
      runner = factory.discord({
        ...common,
        botToken: auth.token,
        ...(typeof boundChannel === 'string' && boundChannel.trim().length > 0
          ? { boundChannelId: boundChannel.trim() }
          : {}),
      });
    }
    if (runner === null) {
      setStatus(vendor, row.name, mode, 'invalid', 'local ingress runner is not implemented');
      return;
    }

    active.set(key, { rowName: row.name, fingerprint, generation, runner });
    setStatus(vendor, row.name, mode, 'connecting');
    runner.start();
  };

  const enqueue = (key: string, work: () => Promise<void>): Promise<void> => {
    const previous = chains.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    chains.set(key, next);
    const release = (): void => {
      if (chains.get(key) === next) chains.delete(key);
    };
    void next.then(release, release);
    return next;
  };

  const reconcileRow = (row: ConnectionRow): Promise<void> => {
    const vendor = row.subtype ?? 'unknown';
    return enqueue(keyOf(vendor, row.name), () => applyRow(row));
  };

  const reconcile = async (): Promise<void> => {
    if (stopped) return;
    const rows = options.connectionStore.list({ kind: 'notification' });
    const expected = new Set<string>();
    const jobs: Promise<void>[] = [];
    for (const row of rows) {
      if (row.subtype === undefined || getMessengerVendorDeclaration(row.subtype) === null) continue;
      expected.add(keyOf(row.subtype, row.name));
      jobs.push(reconcileRow(row));
    }
    const staleKeys = new Set([...active.keys(), ...statuses.keys()]);
    for (const key of staleKeys) {
      if (expected.has(key)) continue;
      jobs.push(enqueue(key, async () => {
        await stopKey(key);
        statuses.delete(key);
        const { vendor, connectionName } = splitKey(key);
        options.stateStore.delete(vendor, connectionName);
      }));
    }
    await Promise.all(jobs);
  };

  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopped = true;
    unsubscribeUpsert?.();
    unsubscribeDelete?.();
    unsubscribeVault?.();
    unsubscribeUpsert = null;
    unsubscribeDelete = null;
    unsubscribeVault = null;
    // Capture already-admitted reconciles before appending per-runner stops.
    // enqueue() chains each stop behind any in-flight decode/update for that
    // key, and stopped=true prevents those earlier jobs from publishing a new
    // runner after their final await.
    const pending = new Set<Promise<void>>([...chains.values()]);
    for (const key of active.keys()) {
      pending.add(enqueue(key, () => stopKey(key)));
    }
    stopPromise = Promise.allSettled([...pending]).then((results) => {
      const errors = results
        .filter((result): result is PromiseRejectedResult =>
          result.status === 'rejected')
        .map((result) => result.reason);
      if (errors.length > 0) {
        throw new AggregateError(
          errors,
          'one or more messenger ingress runners failed to stop',
        );
      }
    });
    return stopPromise;
  };

  return {
    async start() {
      if (started) return;
      started = true;
      stopped = false;
      unsubscribeUpsert = options.connectionStore.addOnUpsert((row) => {
        // A re-enroll can replace the subtype at the same row key. A full scan
        // starts the new runner and retires any old vendor status/session;
        // per-key queues still prevent churn for ordinary health restamps.
        void reconcile().catch((error) => {
          options.log?.('warn', 'Messenger ingress reconcile failed', {
            connection_name: row.name,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      });
      unsubscribeDelete = options.connectionStore.addOnDelete((kind, name) => {
        if (kind !== 'notification') return;
        const affected = new Set<string>();
        for (const [key, current] of active) {
          if (current.rowName === name) affected.add(key);
        }
        for (const key of statuses.keys()) {
          if (splitKey(key).connectionName === name) affected.add(key);
        }
        for (const key of affected) {
          void enqueue(key, async () => {
            await stopKey(key);
            statuses.delete(key);
            options.stateStore.delete(splitKey(key).vendor, name);
          });
        }
      });
      unsubscribeVault = options.subscribeVault?.(() => {
        void reconcile().catch((error) => {
          options.log?.('warn', 'Messenger ingress vault reconcile failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }) ?? null;
      try {
        await reconcile();
      } catch (error) {
        await stop();
        throw error;
      }
    },

    stop,

    reconcile,

    status(vendor, connectionName) {
      return statuses.get(keyOf(vendor, connectionName)) ?? null;
    },
  };
};
