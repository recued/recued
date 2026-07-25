/** M4b.2 — archive upload protocol core (`createArchiveUpload`).
 *
 *  Drives the driver end-to-end through the REAL shared upload engine +
 *  ws-transport with a fake binary socket (decodes each chunk frame + acks it)
 *  and fake `server.archive.upload.*` callers. Covers the happy path (create →
 *  chunked bytes in order → finalize → onDone with the server `staged_name`),
 *  that `mime_reported` is dropped on create, friendly error mapping, cancel
 *  reaping the server scratch, and — pinned as the deferred limitation Codex
 *  flagged — that a finalize-response loss surfaces an error (the `staged_name`
 *  is not yet client-recoverable; the fix is server-side + out of M4b.2 scope).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decodeUploadChunkFrame,
  type ArchiveUploadCreateRpcResponse,
  type ArchiveUploadFinalizeRpcResponse,
} from '@recued/contracts';
import { Upload } from '@recued/ui-shared';
import {
  createArchiveUpload,
  type ArchiveUploadCallers,
} from '../settings/archive-upload.js';
import type { ArchiveUploadFile } from '../settings/archive-backup-panel.js';

// ──────────────────────────────────────────────────────────────────
// Fakes
// ──────────────────────────────────────────────────────────────────

/** A fake binary upload socket: on `send(frame)` it decodes the chunk, appends
 *  the bytes, and synchronously acks `{ ok, offset, complete }` over a `message`
 *  text frame (the ws-transport registers its pending settle BEFORE `send`, so a
 *  synchronous ack resolves it). `total` decides when `complete` flips. */
const makeFakeSocket = (total: number) => {
  const listeners = new Map<string, Array<(ev: unknown) => void>>();
  const received: number[] = [];
  let offset = 0;
  const fire = (type: string, ev: unknown): void => {
    for (const fn of listeners.get(type) ?? []) fn(ev);
  };
  const socket: Upload.UploadSocket = {
    send: (data) => {
      const buf = new Uint8Array(data as ArrayBuffer);
      const res = decodeUploadChunkFrame(buf);
      if (!res.ok) {
        fire('message', { data: JSON.stringify({ type: 'upload_error', reason: res.reason }) });
        return;
      }
      const { req_id, bytes } = res.frame;
      for (const b of bytes) received.push(b);
      offset += bytes.length;
      fire('message', {
        data: JSON.stringify({
          type: 'upload_ack',
          req_id,
          ok: true,
          offset,
          complete: offset >= total,
        }),
      });
    },
    close: () => {},
    addEventListener: (type, listener) => {
      const arr = listeners.get(type) ?? [];
      arr.push(listener);
      listeners.set(type, arr);
    },
    removeEventListener: (type, listener) => {
      const arr = listeners.get(type);
      if (arr) arr.splice(arr.indexOf(listener), 1);
    },
  };
  return { socket, received };
};

const makeFile = (bytes: number[], name = 'my-backup.recued.archive'): ArchiveUploadFile => {
  const buf = Uint8Array.from(bytes);
  return {
    name,
    size: buf.length,
    type: '',
    lastModified: 0,
    slice: (start, end) => ({ arrayBuffer: async () => buf.slice(start, end).buffer }),
  };
};

const STAGED = 'recued-upload-0123456789abcdef0123456789abcdef.recued.archive';

interface CallerLog {
  create: Array<Record<string, unknown>>;
  finalize: string[];
  delete: string[];
}

/** Default happy-path callers + a log; overridable per test. */
const makeCallers = (over: Partial<ArchiveUploadCallers> = {}): {
  callers: ArchiveUploadCallers;
  log: CallerLog;
} => {
  const log: CallerLog = { create: [], finalize: [], delete: [] };
  const callers: ArchiveUploadCallers = {
    create: async (req) => {
      log.create.push({ ...req });
      return { status: 'created', upload_id: 'up-1' };
    },
    probe: async () => ({ resumable: false, reason: 'not_found' }),
    finalize: async (req) => {
      log.finalize.push(req.upload_id);
      return { status: 'finalized', staged_name: STAGED, size_bytes: 5 };
    },
    delete: async (req) => {
      log.delete.push(req.upload_id);
      return { deleted: true };
    },
    ...over,
  };
  return { callers, log };
};

interface Outcome {
  progress: Array<[number, number]>;
  done: Array<{ staged_name: string; size_bytes: number }>;
  error: string[];
}

/** A coded rpc-style rejection (mirrors the webclient rpc-conn errors). */
const rpcError = (code: string, message = code): Error =>
  Object.assign(new Error(message), { code });

const run = (opts: {
  file: ArchiveUploadFile;
  callers: ArchiveUploadCallers;
  socket?: Upload.UploadSocket;
  chunkBytes?: number;
  finalizeMaxAttempts?: number;
}): { outcome: Outcome; cancel: () => void } => {
  const outcome: Outcome = { progress: [], done: [], error: [] };
  const fn = createArchiveUpload({
    connect: async () => opts.socket ?? makeFakeSocket(opts.file.size).socket,
    callers: opts.callers,
    // Deterministic, node-safe digest (the fake server ignores the checksum).
    digest: async () => 'deadbeef',
    chunkBytes: opts.chunkBytes ?? 2,
    // Instant retries in tests (no real timers).
    sleep: async () => {},
    ...(opts.finalizeMaxAttempts !== undefined
      ? { finalizeMaxAttempts: opts.finalizeMaxAttempts }
      : {}),
  });
  const cancel = fn({
    file: opts.file,
    onProgress: (sent, total) => outcome.progress.push([sent, total]),
    onDone: (r) => outcome.done.push(r),
    onError: (m) => outcome.error.push(m),
  });
  return { outcome, cancel };
};

/** Flush the engine's async loop (create/probe/digest/finalize are all async). */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createArchiveUpload', () => {
  it('creates, streams the bytes in order, finalizes, and reports the staged name', async () => {
    const file = makeFile([1, 2, 3, 4, 5]);
    const fake = makeFakeSocket(file.size);
    const { callers, log } = makeCallers();
    const { outcome } = run({ file, callers, socket: fake.socket, chunkBytes: 2 });
    await settle();

    // All bytes arrived server-side in order (chunked at 2 bytes → 3 chunks).
    expect(fake.received).toEqual([1, 2, 3, 4, 5]);
    // create dropped `mime_reported` (the archive create has no such field) and
    // carried the declared size + filename.
    expect(log.create).toHaveLength(1);
    expect(log.create[0]).toEqual({ filename: 'my-backup.recued.archive', declared_size: 5 });
    expect(log.create[0]).not.toHaveProperty('mime_reported');
    expect(log.finalize).toEqual(['up-1']);
    // onDone carries the server staged_name + size — NOT a record_id.
    expect(outcome.done).toEqual([{ staged_name: STAGED, size_bytes: 5 }]);
    expect(outcome.error).toEqual([]);
    // Progress advanced monotonically to the full size.
    expect(outcome.progress.at(-1)).toEqual([5, 5]);
  });

  it('maps a create rejection to a friendly message (no chunks sent)', async () => {
    const file = makeFile([9, 9, 9]);
    const fake = makeFakeSocket(file.size);
    const { callers } = makeCallers({
      create: async (): Promise<ArchiveUploadCreateRpcResponse> => ({
        status: 'rejected',
        reason: 'size_cap_exceeded',
      }),
    });
    const { outcome } = run({ file, callers, socket: fake.socket });
    await settle();
    expect(outcome.done).toEqual([]);
    expect(outcome.error).toHaveLength(1);
    expect(outcome.error[0]).toMatch(/too large/i);
    expect(fake.received).toEqual([]);
  });

  it('maps too_many_sessions to a "server is busy" message', async () => {
    const file = makeFile([1]);
    const { callers } = makeCallers({
      create: async (): Promise<ArchiveUploadCreateRpcResponse> => ({
        status: 'rejected',
        reason: 'too_many_sessions',
      }),
    });
    const { outcome } = run({ file, callers });
    await settle();
    expect(outcome.error[0]).toMatch(/busy/i);
  });

  it('cancel reaps the server scratch and fires no outcome', async () => {
    const file = makeFile([1, 2, 3, 4, 5, 6]);
    // A socket that never acks → the upload hangs at the first chunk so cancel
    // lands mid-flight.
    const listeners = new Map<string, Array<(ev: unknown) => void>>();
    const silent: Upload.UploadSocket = {
      send: () => {},
      close: () => {},
      addEventListener: (t, l) => {
        const a = listeners.get(t) ?? [];
        a.push(l);
        listeners.set(t, a);
      },
      removeEventListener: () => {},
    };
    const { callers, log } = makeCallers();
    const { outcome, cancel } = run({ file, callers, socket: silent, chunkBytes: 2 });
    await settle();
    cancel();
    await settle();
    // The engine reaped the created session (best-effort delete) ...
    expect(log.delete).toEqual(['up-1']);
    // ... and no terminal outcome fired (the caller drove the cancel).
    expect(outcome.done).toEqual([]);
    expect(outcome.error).toEqual([]);
  });

  // Lost-finalize-RESPONSE recovery: a transport drop can lose the finalize
  // reply after the server already staged the archive. The driver re-calls
  // finalize (the server is idempotent), recovering staged_name without a
  // re-upload.
  it('retries finalize on a transport drop and recovers the staged name', async () => {
    const file = makeFile([1, 2, 3, 4, 5]);
    const fake = makeFakeSocket(file.size);
    let calls = 0;
    const { callers } = makeCallers({
      finalize: async (): Promise<ArchiveUploadFinalizeRpcResponse> => {
        calls += 1;
        // The first two responses are "lost" (transport drop); the third (the
        // idempotent server recovery) returns the staged name.
        if (calls < 3) throw rpcError('timeout', 'finalize ack lost');
        return { status: 'finalized', staged_name: STAGED, size_bytes: 5 };
      },
    });
    const { outcome } = run({ file, callers, socket: fake.socket, chunkBytes: 2 });
    await settle();
    expect(calls).toBe(3);
    expect(outcome.error).toEqual([]);
    expect(outcome.done).toEqual([{ staged_name: STAGED, size_bytes: 5 }]);
    expect(fake.received).toEqual([1, 2, 3, 4, 5]); // the whole archive reached the server
  });

  it('errors after exhausting finalize transport retries (connection lost)', async () => {
    const file = makeFile([1, 2, 3, 4, 5]);
    const fake = makeFakeSocket(file.size);
    let calls = 0;
    const { callers } = makeCallers({
      finalize: async (): Promise<ArchiveUploadFinalizeRpcResponse> => {
        calls += 1;
        throw rpcError('timeout', 'still down');
      },
    });
    const { outcome } = run({ file, callers, socket: fake.socket, chunkBytes: 2, finalizeMaxAttempts: 3 });
    await settle();
    expect(calls).toBe(3); // bounded
    expect(outcome.done).toEqual([]);
    expect(outcome.error).toHaveLength(1);
    expect(outcome.error[0]).toMatch(/connection was lost/i);
  });

  it('does NOT retry a non-transport finalize error (a real server error surfaces)', async () => {
    const file = makeFile([1, 2, 3, 4, 5]);
    const fake = makeFakeSocket(file.size);
    let calls = 0;
    const { callers } = makeCallers({
      finalize: async (): Promise<ArchiveUploadFinalizeRpcResponse> => {
        calls += 1;
        throw rpcError('internal', 'boom');
      },
    });
    const { outcome } = run({ file, callers, socket: fake.socket, chunkBytes: 2 });
    await settle();
    expect(calls).toBe(1); // a non-transport error is terminal — no retry
    expect(outcome.done).toEqual([]);
    expect(outcome.error).toHaveLength(1);
  });
});
