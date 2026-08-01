/** Self-revocation receipt handling for Account → server profiles.
 *
 * `pair.revoke` closes every socket belonging to the targeted instance. When
 * this browser revokes ITSELF, the server sends `instance_revoked` and closes
 * the same socket that carries the RPC result. Depending on transport timing,
 * the result may arrive or the rpc may surface `connection_lost` even though
 * revocation committed. The matching direct frame is therefore an equally
 * authoritative success receipt; unrelated closes remain failures.
 */

export const SELF_REVOKE_RECEIPT_GRACE_MS = 500;

export interface InstanceRevokedReceipt {
  readonly type: 'instance_revoked';
  readonly instance_id: string;
}

export const isInstanceRevokedReceiptFor = (
  value: unknown,
  instanceId: string,
): value is InstanceRevokedReceipt =>
  value !== null
  && typeof value === 'object'
  && (value as { type?: unknown }).type === 'instance_revoked'
  && (value as { instance_id?: unknown }).instance_id === instanceId;

export interface RunSelfPairRevocationOptions {
  readonly instanceId: string;
  /** Issue `pair.revoke`. The AbortSignal retires a reply that became
   *  irrelevant after the direct revocation receipt arrived. */
  readonly runRevoke: (signal: AbortSignal) => Promise<unknown>;
  /** Subscribe before sending so an immediate server close cannot outrun the
   *  receipt listener. */
  readonly onMessage: (listener: (message: unknown) => void) => () => void;
  readonly receiptGraceMs?: number;
  readonly setTimer?: (
    handler: () => void,
    delayMs: number,
  ) => { cancel(): void };
}

type RevokeOutcome =
  | { readonly kind: 'reply' }
  | { readonly kind: 'error'; readonly error: unknown };

/** Resolve only when the server replied OR emitted a receipt for this exact
 * instance. An rpc error gets a short grace window because the socket close
 * and its final message are separate browser events. */
export const runSelfPairRevocation = async (
  options: RunSelfPairRevocationOptions,
): Promise<void> => {
  let receiptObserved = false;
  let resolveReceipt!: () => void;
  const receipt = new Promise<void>((resolve) => {
    resolveReceipt = resolve;
  });
  const detach = options.onMessage((message) => {
    if (!isInstanceRevokedReceiptFor(message, options.instanceId)) return;
    receiptObserved = true;
    resolveReceipt();
  });
  const controller = new AbortController();
  let cancelGraceTimer = (): void => undefined;
  const setTimer = options.setTimer
    ?? ((handler: () => void, delayMs: number) => {
      const id = globalThis.setTimeout(handler, delayMs);
      return { cancel: () => globalThis.clearTimeout(id) };
    });

  const rpcOutcome: Promise<RevokeOutcome> = Promise.resolve()
    .then(() => options.runRevoke(controller.signal))
    .then(
      () => ({ kind: 'reply' as const }),
      (error: unknown) => ({ kind: 'error' as const, error }),
    );

  try {
    const first = await Promise.race([
      rpcOutcome,
      receipt.then(() => ({ kind: 'receipt' as const })),
    ]);
    if (first.kind === 'receipt' || first.kind === 'reply') return;
    if (!receiptObserved) {
      const arrivedDuringGrace = await Promise.race([
        receipt.then(() => true),
        new Promise<false>((resolve) => {
          const graceTimer = setTimer(
            () => resolve(false),
            options.receiptGraceMs ?? SELF_REVOKE_RECEIPT_GRACE_MS,
          );
          cancelGraceTimer = () => graceTimer.cancel();
        }),
      ]);
      if (arrivedDuringGrace) return;
    }
    throw first.error;
  } finally {
    controller.abort();
    cancelGraceTimer();
    detach();
  }
};
