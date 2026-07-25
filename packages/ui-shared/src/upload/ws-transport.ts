/** WebSocket upload transport — the webclient's binary `/ws/upload` DATA plane.
 *
 *  Extracted verbatim from the original engine (D-172 step 3): one binary frame
 *  per chunk on a dedicated socket, ack as a JSON TEXT frame correlated by
 *  `req_id`. The engine drives this through the `UploadTransport` seam
 *  (`open` / `send` / `reset`) and stays transport-agnostic; reception swaps in
 *  `createHttpUploadTransport` instead.
 *
 *  This is the ONLY upload module that imports the binary frame codec from
 *  `@recued/contracts` — so the reception bundle (engine + HTTP transport) never
 *  pulls the WS framing or the contracts barrel.
 *
 *  Faults vs outcomes: a server ack — even `ok:false` (offset_conflict /
 *  checksum_mismatch / a terminal reason) — resolves `send` to an
 *  `UploadChunkOutcome`. A timeout / dropped socket / send failure / un-
 *  correlatable decode error rejects with `UploadTransportFault`, which the
 *  engine reconnect+reprobes (budgeted).
 */

import { encodeUploadChunkFrame } from '@recued/contracts';
import type { UploadChunkAck } from '@recued/contracts';

import {
  UploadTransportFault,
  type UploadChunkOutcome,
  type UploadChunkSend,
  type UploadSocket,
  type UploadTransport,
  type WsUploadTransportOptions,
} from './types.js';

const DEFAULT_ACK_TIMEOUT_MS = 30_000;

/** The `upload_ack` variant of the server→client frame (the recoverable +
 *  terminal chunk outcomes; `upload_error` is the un-correlatable decode case). */
type UploadAckMessage = Extract<UploadChunkAck, { type: 'upload_ack' }>;

export const createWsUploadTransport = (
  options: WsUploadTransportOptions,
): UploadTransport => {
  const connect = options.connect;
  const ackTimeoutMs = options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;

  // ── socket + pending-ack correlation ───────────────────────────────
  let socket: UploadSocket | null = null;
  let socketAlive = false;
  let socketListeners: Array<[string, (event: unknown) => void]> = [];
  let reqCounter = 0;
  // req_id → settle(err|ack). The message handler resolves by req_id; a socket
  // fault rejects all outstanding so their `send` reconnects.
  const pending = new Map<
    string,
    (err: Error | null, ack?: UploadAckMessage) => void
  >();

  const nextReqId = (): string => `r${++reqCounter}`;

  const handleSocketMessage = (event: unknown): void => {
    const data = (event as { data?: unknown }).data;
    // Acks are JSON TEXT frames on this binary socket; ignore stray binary.
    if (typeof data !== 'string') return;
    let msg: unknown;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof msg !== 'object' || msg === null) return;
    const tagged = msg as { type?: unknown; req_id?: unknown };
    if (tagged.type === 'upload_ack' && typeof tagged.req_id === 'string') {
      const settle = pending.get(tagged.req_id);
      if (settle !== undefined) settle(null, msg as UploadAckMessage);
      return;
    }
    if (tagged.type === 'upload_error') {
      // Un-correlatable decode failure — our encoder is correct so this is not
      // expected; treat as a transient fault → resync + re-send (budgeted).
      failSocket('upload_error');
    }
  };

  /** Reject every outstanding ack so the awaiting chunk reconnects. */
  const failSocket = (why: string): void => {
    socketAlive = false;
    const settles = [...pending.values()];
    pending.clear();
    const err = new UploadTransportFault(why);
    for (const settle of settles) settle(err);
  };

  const reset = (): void => {
    if (socket !== null) {
      for (const [type, fn] of socketListeners) {
        try {
          socket.removeEventListener(type, fn);
        } catch {
          /* ignore */
        }
      }
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    }
    socket = null;
    socketAlive = false;
    socketListeners = [];
    // Reject any stragglers so no awaiter hangs after a manual close.
    const settles = [...pending.values()];
    pending.clear();
    for (const settle of settles) settle(new UploadTransportFault('socket_closed'));
  };

  const open = async (aborted: () => boolean): Promise<void> => {
    if (socket !== null && socketAlive) return;
    let next: UploadSocket;
    try {
      next = await connect();
    } catch (err) {
      throw new UploadTransportFault(err instanceof Error ? err.message : 'connect_failed');
    }
    if (aborted()) {
      try {
        next.close();
      } catch {
        /* ignore */
      }
      throw new UploadTransportFault('aborted');
    }
    const onMessage = (event: unknown): void => handleSocketMessage(event);
    const onClose = (): void => failSocket('closed');
    const onError = (): void => failSocket('error');
    next.addEventListener('message', onMessage);
    next.addEventListener('close', onClose);
    next.addEventListener('error', onError);
    socket = next;
    socketAlive = true;
    socketListeners = [
      ['message', onMessage],
      ['close', onClose],
      ['error', onError],
    ];
  };

  /** Send one chunk frame and await its ack — resolves to the chunk OUTCOME
   *  (ok OR a recoverable/terminal !ok), or rejects with `UploadTransportFault`
   *  on timeout / socket failure / send error. */
  const send = (chunk: UploadChunkSend): Promise<UploadChunkOutcome> =>
    new Promise((resolve, reject) => {
      if (socket === null) {
        reject(new UploadTransportFault('no_socket'));
        return;
      }
      const reqId = nextReqId();
      let settled = false;
      const finish = (err: Error | null, ack?: UploadAckMessage): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending.delete(reqId);
        if (err !== null) {
          reject(err);
          return;
        }
        const m = ack as UploadAckMessage;
        if (m.ok) {
          resolve({ ok: true, offset: m.offset, complete: m.complete });
        } else if (m.offset !== undefined) {
          resolve({ ok: false, reason: m.reason, offset: m.offset });
        } else {
          resolve({ ok: false, reason: m.reason });
        }
      };
      const timer = setTimeout(
        () => finish(new UploadTransportFault('ack_timeout')),
        ackTimeoutMs,
      );
      pending.set(reqId, finish);
      try {
        socket.send(
          encodeUploadChunkFrame(
            {
              req_id: reqId,
              upload_id: chunk.uploadId,
              offset: chunk.offset,
              checksum: chunk.checksum,
            },
            chunk.bytes,
          ),
        );
      } catch {
        finish(new UploadTransportFault('send_failed'));
      }
    });

  return { open, send, reset };
};
