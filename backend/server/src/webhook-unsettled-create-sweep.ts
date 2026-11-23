/** D-201 Slice 10Z (10V findings 8 and 9) — the timer behind the registration
 * service's sweep of creates that may still land.
 *
 * The owner's call (2026-11-19): an event edit or a rebind is never refused,
 * and a stray endpoint a create still running leaves is removed when it lands.
 * Nothing else searches for one once a pass has committed an endpoint, or once
 * the webhook was switched off, retired or moved to another connection, so this
 * runs the sweep every two minutes while it can: never two at once, never with
 * the vault locked, the server paused or stopping, and it stops between
 * ingresses when the server does.
 */

import type { WebhookManagedRegistrationService } from './webhook-registration-reconciler.js';

/** A stray is removed within about this long of landing. */
export const WEBHOOK_UNSETTLED_CREATE_SWEEP_INTERVAL_MS = 2 * 60 * 1000;

export interface WebhookUnsettledCreateSweepRuntime {
  start(): void;
  /** No sweep starts after this; the one running ends after its ingress. */
  stop(): Promise<void>;
  /** One sweep now, as the timer runs it: the one running, if there is one. */
  runOnce(): Promise<void>;
}

export const createWebhookUnsettledCreateSweepRuntime = (deps: {
  readonly service: Pick<WebhookManagedRegistrationService, 'sweepUnsettledCreates'>;
  /** The vault unlocked, the server neither paused nor stopping. */
  readonly canRun: () => boolean;
  readonly intervalMs?: number;
  readonly log?: (message: string, error: unknown) => void;
  /** D-201 Slice 10AN — run after each sweep, as long as the server is not
   *  stopping: the webhooks whose messages are refused set again with the
   *  secret Recued holds (`setRefusedSecretsAgain`). D-201 Slice 10AR (10AM
   *  finding 29) — and as long as it can run: `canRun` is read again before
   *  it, and handed to it to read before each webhook. Read once, before the
   *  sweep, the pass ran on after the vault locked. */
  readonly afterSweep?: (options: {
    readonly isStopping: () => boolean;
    readonly canRun: () => boolean;
  }) => Promise<unknown>;
}): WebhookUnsettledCreateSweepRuntime => {
  const intervalMs = deps.intervalMs ?? WEBHOOK_UNSETTLED_CREATE_SWEEP_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;
  let stopping = false;
  const runOnce = (): Promise<void> => {
    if (running !== undefined) return running;
    if (stopping || !deps.canRun()) return Promise.resolve();
    running = deps.service.sweepUnsettledCreates({ isStopping: () => stopping })
      .then(
        () => undefined,
        (error: unknown) => { deps.log?.('the sweep of unsettled webhook creates failed', error); },
      )
      .then(() => (stopping || !deps.canRun()
        ? undefined
        : deps.afterSweep?.({ isStopping: () => stopping, canRun: deps.canRun })))
      .then(
        () => undefined,
        (error: unknown) => { deps.log?.('the pass over webhooks whose messages are refused failed', error); },
      )
      .finally(() => { running = undefined; });
    return running;
  };
  return {
    start() {
      if (timer !== undefined || stopping) return;
      timer = setInterval(() => { void runOnce(); }, intervalMs);
      timer.unref?.();
    },
    async stop() {
      stopping = true;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      await running;
    },
    runOnce,
  };
};
