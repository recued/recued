/** Config hot-reload (Phase C).
 *
 *  Two trigger paths share one reloader:
 *    - SIGHUP (the durable, operator-controlled path)
 *    - Optional fs.watch on the config file (off by default because
 *      macOS double-fires and network filesystems don't emit events)
 *
 *  Reload behaviour:
 *    1. Re-load the TOML file via `@recued/config.loadConfig`.
 *    2. Diff against the currently-loaded bootstrap + runtime snapshot.
 *    3. For each `[runtime]` key that changed → `runtimeStore.set(key, value)`
 *       (the store's built-in `onChange` listeners propagate to live
 *       subsystems).
 *    4. Any `[bootstrap]` diff → `lifecycleStore.setRestartPending(true)`
 *       so heartbeat carries the signal; the operator decides when to
 *       actually restart.
 *
 *  Env + CLI overrides do NOT reload. They're applied at boot as a
 *  sealed layer on top of the file — reload replaying them would need
 *  to re-parse process.argv / process.env, and the typical case is
 *  "the operator edits the file; the sealed layer stays". Documented
 *  in the spec.
 */

import { loadConfig, type LoadedConfig } from '@recued/config';
import type {
  BootstrapConfig,
  Distribution,
  RuntimeConfig,
  RuntimeConfigStore,
  RuntimeValue,
} from '@recued/config';
import type { LifecycleStateStore } from './lifecycle-state.js';

export type ConfigWatcherLogger = (
  level: 'info' | 'warn' | 'error',
  msg: string,
  data?: Record<string, unknown>,
) => void;

export interface ReloadInfo {
  /** Runtime keys whose value changed on this reload. */
  runtime_changed: string[];
  /** Bootstrap keys whose value changed. These require a restart to
   *  take effect; the watcher sets `lifecycle.restart_pending`. */
  bootstrap_changed: string[];
  /** True iff any bootstrap key changed (i.e. restart_pending was
   *  set on this reload). */
  restart_required: boolean;
  /** Reason string the trigger supplied (e.g. `SIGHUP`, `fs.watch`). */
  reason: string;
}

export interface ConfigWatcherDeps {
  configPath: string | null;
  distribution: Distribution;
  initialBootstrap: BootstrapConfig;
  initialRuntime: RuntimeConfig;
  runtimeStore: RuntimeConfigStore;
  lifecycleStore: LifecycleStateStore;
  /** When true AND configPath is set, start fs.watch with a 500 ms
   *  debounce. Off by default. */
  watchFile?: boolean;
  /** Debounce window for fs.watch triggers (ms). Defaults to 500. */
  fsWatchDebounceMs?: number;
  /** Injected for tests: replace the real `loadConfig` call. */
  load?: (
    distribution: Distribution,
    configPath?: string,
  ) => Promise<LoadedConfig>;
  /** Injected for tests: replace fs.watch. */
  watchImpl?: (
    path: string,
    callback: () => void,
  ) => { close: () => void };
  log?: ConfigWatcherLogger;
  /** Called after each successful reload. Caller can use this to
   *  emit an audit entry. */
  onReloaded?: (info: ReloadInfo) => void;
}

export interface ConfigWatcher {
  /** Trigger a reload synchronously (from SIGHUP handler). */
  reload(reason: string): Promise<ReloadInfo>;
  /** Begin watching the file if `watchFile` is enabled. No-op when
   *  disabled or when configPath is null. */
  start(): void;
  /** Stop watching, reject new reload admission, and drain an admitted load.
   *  Safe to call when not started. */
  stop(): Promise<void>;
  /** True between start() and stop(). */
  readonly watching: boolean;
}

const noopLog: ConfigWatcherLogger = () => { /* silence */ };

/** Keys in BootstrapConfig used by the diff. Refreshing this list when
 *  BootstrapConfig evolves keeps the diff exhaustive. */
const BOOTSTRAP_KEYS: readonly (keyof BootstrapConfig)[] = [
  'data_path',
  'bind_host',
  'bind_port',
  'mcp_port',
  'webhook_port',
  'log_path',
];

export const createConfigWatcher = (
  deps: ConfigWatcherDeps,
): ConfigWatcher => {
  const log = deps.log ?? noopLog;
  const load = deps.load ?? ((d, p) => loadConfig({ distribution: d, configPath: p }));
  const debounceMs = deps.fsWatchDebounceMs ?? 500;

  // Mutate-in-place snapshots so we only report true deltas across
  // consecutive reloads.
  const currentBootstrap: BootstrapConfig = { ...deps.initialBootstrap };
  const currentRuntime: RuntimeConfig = { ...deps.initialRuntime };

  let watcher: { close: () => void } | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let accepting = true;
  let generation = 0;
  let reloadTail: Promise<void> = Promise.resolve();

  const skipped = (reason: string): ReloadInfo => ({
    runtime_changed: [],
    bootstrap_changed: [],
    restart_required: false,
    reason,
  });

  const diffBootstrap = (next: BootstrapConfig): string[] => {
    const changed: string[] = [];
    for (const k of BOOTSTRAP_KEYS) {
      if (currentBootstrap[k] !== next[k]) changed.push(k);
    }
    return changed;
  };

  const diffRuntime = (next: RuntimeConfig): string[] => {
    const changed: string[] = [];
    const keys = new Set([
      ...Object.keys(currentRuntime),
      ...Object.keys(next),
    ]);
    for (const k of keys) {
      if (currentRuntime[k] !== next[k]) changed.push(k);
    }
    return changed;
  };

  const applyRuntimeDelta = (
    next: RuntimeConfig,
    changed: string[],
  ): string[] => {
    const applied: string[] = [];
    for (const k of changed) {
      const value = next[k];
      if (value === undefined) {
        // Key removed from file — runtime store has no "unset" API;
        // skip silently. The schema default applies on next boot.
        continue;
      }
      try {
        deps.runtimeStore.set(k, value as RuntimeValue);
        currentRuntime[k] = value;
        applied.push(k);
      } catch (err) {
        log('warn', `reload: runtime key '${k}' rejected by schema`, {
          err: errShape(err),
          value,
        });
      }
    }
    return applied;
  };

  const doReload = async (reason: string, admittedGeneration: number): Promise<ReloadInfo> => {
    if (!deps.configPath) {
      log('warn', 'reload requested but no config file path — skipping', {
        reason,
      });
      return skipped(reason);
    }

    let loaded: LoadedConfig;
    try {
      loaded = await load(deps.distribution, deps.configPath);
    } catch (err) {
      log('error', 'reload: loadConfig failed — keeping current values', {
        err: errShape(err),
      });
      return skipped(reason);
    }

    // stop() closes admission synchronously. A load that was already awaiting
    // disk I/O must not apply runtime values or lifecycle-state writes after a
    // drain has begun; generation also prevents an old load from leaking into
    // a later stop/start cycle.
    if (!accepting || admittedGeneration !== generation) return skipped(reason);

    const bootstrapChanged = diffBootstrap(loaded.bootstrap);
    const runtimeChanged = diffRuntime(loaded.runtime);
    const applied = applyRuntimeDelta(loaded.runtime, runtimeChanged);

    // Bootstrap fields don't apply live — mark restart_pending so
    // heartbeat surfaces the signal. Don't apply to currentBootstrap
    // (it mirrors the boot-time view, unchanged until actual restart).
    if (bootstrapChanged.length > 0) {
      deps.lifecycleStore.setRestartPending(true);
    }

    const info: ReloadInfo = {
      runtime_changed: applied,
      bootstrap_changed: bootstrapChanged,
      restart_required: bootstrapChanged.length > 0,
      reason,
    };

    log('info', 'config reloaded', {
      reason,
      runtime_changed: info.runtime_changed,
      bootstrap_changed: info.bootstrap_changed,
      restart_required: info.restart_required,
    });

    deps.onReloaded?.(info);
    return info;
  };

  const enqueueReload = (reason: string): Promise<ReloadInfo> => {
    if (!accepting) return Promise.resolve(skipped(reason));
    const admittedGeneration = generation;
    const task = reloadTail.then(() => {
      if (!accepting || admittedGeneration !== generation) return skipped(reason);
      return doReload(reason, admittedGeneration);
    });
    // Keep the admission queue usable even if an unexpected callback throws;
    // the caller still receives the original rejection.
    reloadTail = task.then(() => undefined, () => undefined);
    return task;
  };

  const fsWatchTrigger = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void enqueueReload('fs.watch').catch((err) => {
        log('error', 'fs.watch reload failed', { err: errShape(err) });
      });
    }, debounceMs);
  };

  return {
    reload: enqueueReload,

    start() {
      if (!accepting) {
        accepting = true;
        generation += 1;
      }
      if (watcher || !deps.watchFile || !deps.configPath) return;
      const watchImpl = deps.watchImpl ?? defaultFsWatch;
      try {
        watcher = watchImpl(deps.configPath, fsWatchTrigger);
        log('info', 'config fs.watch started', { path: deps.configPath });
      } catch (err) {
        log('warn', 'config fs.watch failed to start', {
          err: errShape(err),
        });
      }
    },

    stop() {
      if (accepting) {
        accepting = false;
        generation += 1;
      }
      if (watcher) {
        try {
          watcher.close();
        } catch {
          /* best effort */
        }
        watcher = null;
      }
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      return reloadTail;
    },

    get watching() {
      return watcher !== null;
    },
  };
};

const defaultFsWatch = (
  path: string,
  callback: () => void,
): { close: () => void } => {
  // Lazy import to keep the module loadable in environments without
  // fs.watch (rare but deterministic).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs');
  const w = fs.watch(path, () => callback());
  return {
    close: () => w.close(),
  };
};

const errShape = (err: unknown): unknown =>
  err instanceof Error ? { name: err.name, message: err.message } : err;
