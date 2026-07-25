/** Signal listener (Phase C).
 *
 *  Maps process signals to lifecycle events. Replaces the ad-hoc
 *  SIGINT/SIGTERM handlers currently registered in `bin.ts` — the
 *  composition root installs one listener and everything flows
 *  through it.
 *
 *  Mapping:
 *    SIGTERM / SIGINT  → graceful drain with intent=shutdown
 *    SIGHUP            → hot-reload runtime config (no drain)
 *    SIGUSR1           → dump lifecycle snapshot (debug)
 *    uncaughtException → record last_crash, exit 1 (no drain —
 *                         process state is unreliable)
 *
 *  The listener is a thin dispatcher: each event invokes a
 *  caller-provided callback. Idempotency and error-swallow live in
 *  the callback (e.g. drain coalesces; uncaughtException handler
 *  calls process.exit after best-effort write).
 */

export type SignalLogger = (
  level: 'info' | 'warn' | 'error',
  msg: string,
  data?: Record<string, unknown>,
) => void;

export interface SignalListenerDeps {
  /** Called for SIGTERM / SIGINT. Should kick off the drain pipeline.
   *  The callback returns a Promise the listener awaits before
   *  calling process.exit (with the code supplied by the callback). */
  onShutdown: (reason: string) => Promise<void>;
  /** Called for SIGHUP. Should re-read config.toml and apply live
   *  runtime deltas. Absent → SIGHUP logs only. */
  onReload?: (reason: string) => Promise<void>;
  /** Called for SIGUSR1. Should log the current lifecycle snapshot.
   *  Absent → SIGUSR1 logs a default "received" line. */
  onDumpSnapshot?: () => void;
  /** Called on uncaughtException / unhandledRejection. Should write
   *  a `last_crash` entry and persist audit. Listener exits 1 after
   *  the callback resolves (or rejects — we exit regardless). */
  onUncaughtException: (err: Error, origin: string) => Promise<void>;
  /** Emit logs for every handled signal. */
  log?: SignalLogger;
  /** process.exit wrapper — injected for tests. */
  exit?: (code: number) => void;
  /** process object wrapper — injected for tests. */
  processRef?: NodeJS.Process;
}

export interface SignalListener {
  /** Register every handler on `process`. Calling `install` twice is
   *  a no-op. */
  install(): void;
  /** Unregister every handler this listener installed. Safe to call
   *  when not installed. */
  uninstall(): void;
  /** True between `install()` and `uninstall()`. */
  readonly installed: boolean;
}

const noopLog: SignalLogger = () => { /* silence */ };

export const createSignalListener = (
  deps: SignalListenerDeps,
): SignalListener => {
  const log = deps.log ?? noopLog;
  const exit = deps.exit ?? ((c: number) => process.exit(c));
  const proc = deps.processRef ?? process;

  let installed = false;

  // Track handlers so we can deregister cleanly.
  type HandlerEntry = { event: string; handler: (...args: unknown[]) => void };
  const registered: HandlerEntry[] = [];

  const register = (
    event: 'SIGTERM' | 'SIGINT' | 'SIGHUP' | 'SIGUSR1' | 'uncaughtException' | 'unhandledRejection',
    handler: (...args: unknown[]) => void,
  ): void => {
    proc.on(event, handler);
    registered.push({ event, handler });
  };

  const handleShutdownSignal = (signal: 'SIGTERM' | 'SIGINT') => {
    log('info', 'shutdown signal received', { signal });
    void deps
      .onShutdown(signal)
      .catch((err) => {
        log('error', 'onShutdown callback rejected', { err: errShape(err) });
      });
    // We DO NOT exit here — the drain path calls process.exit via the
    // supervisor handoff. This keeps the listener generic: shutdown
    // mode decides its own exit code.
  };

  const handleReloadSignal = () => {
    log('info', 'reload signal received', { signal: 'SIGHUP' });
    if (deps.onReload) {
      void deps
        .onReload('SIGHUP')
        .catch((err) => {
          log('error', 'onReload callback rejected', { err: errShape(err) });
        });
    }
  };

  const handleDumpSignal = () => {
    log('info', 'dump signal received', { signal: 'SIGUSR1' });
    try {
      deps.onDumpSnapshot?.();
    } catch (err) {
      log('error', 'onDumpSnapshot callback threw', { err: errShape(err) });
    }
  };

  const handleFatal = async (err: Error, origin: string) => {
    log('error', 'uncaught exception — exiting 1', {
      origin,
      err: errShape(err),
    });
    try {
      await deps.onUncaughtException(err, origin);
    } catch (cbErr) {
      log('error', 'onUncaughtException callback rejected', {
        err: errShape(cbErr),
      });
    }
    exit(1);
  };

  return {
    get installed() {
      return installed;
    },

    install() {
      if (installed) return;
      installed = true;

      register('SIGTERM', () => handleShutdownSignal('SIGTERM'));
      register('SIGINT', () => handleShutdownSignal('SIGINT'));
      register('SIGHUP', () => handleReloadSignal());
      register('SIGUSR1', () => handleDumpSignal());

      register('uncaughtException', ((err: Error, origin: string) => {
        void handleFatal(err, origin);
      }) as (...args: unknown[]) => void);
      register('unhandledRejection', ((reason: unknown) => {
        const err = reason instanceof Error
          ? reason
          : new Error(`unhandledRejection: ${String(reason)}`);
        void handleFatal(err, 'unhandledRejection');
      }) as (...args: unknown[]) => void);
    },

    uninstall() {
      if (!installed) return;
      installed = false;
      for (const { event, handler } of registered) {
        proc.off(event as Parameters<NodeJS.Process['off']>[0], handler);
      }
      registered.length = 0;
    },
  };
};

const errShape = (err: unknown): unknown => {
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  return err;
};
