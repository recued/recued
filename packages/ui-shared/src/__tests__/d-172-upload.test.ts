/** D-172 resumable uploads — shared CLIENT engine + widget tests.
 *
 *  Two layers, matching the source split:
 *   1. `engine.ts` — the pure network state machine, driven headless against a
 *      fake `/ws/upload` socket (records sent frames, lets the test push
 *      `upload_ack` text frames + close/error) + fake `upload.*` callers + an
 *      injected deterministic digest. Covers create→chunk→finalize, multi-
 *      chunk, resume-via-probe, offset_conflict resync, checksum_mismatch
 *      re-send + cap, reconnect-on-close + probe resync, the reconnect budget
 *      (incl. the lost-ack-still-made-progress refill), finalize-pending
 *      resume, cancel/destroy reaping (incl. the in-flight-create race).
 *   2. `wire.ts` — DOM glue over a compact fake DOM (attribute-selector
 *      `querySelector` + bubbling dispatch + string `innerHTML`), incl. the
 *      string-only-DOM degrade guard.
 *
 *  The real server wire is proven separately in
 *  `backend/server/src/__tests__/d-172-webclient-upload-ws.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';

import { decodeUploadChunkFrame } from '@recued/contracts';
import type {
  UploadCreateRpcResponse,
  UploadFinalizeRpcResponse,
  UploadProbeRpcResponse,
} from '@recued/contracts';

import { createUploadEngine } from '../upload/engine.js';
import { createWsUploadTransport } from '../upload/ws-transport.js';
import {
  UPLOAD_CANCEL_ATTR,
  UPLOAD_DROPZONE_ATTR,
  UPLOAD_INPUT_ATTR,
  UPLOAD_PROGRESS_ATTR,
  UPLOAD_SHELL_ATTR,
} from '../upload/render.js';
import { wireUploadWidget } from '../upload/wire.js';
import type {
  UploadCallers,
  UploadConnectFactory,
  UploadDigest,
  UploadEngine,
  UploadEngineOptions,
  UploadFile,
  UploadProgress,
  UploadResumeStore,
  UploadSocket,
} from '../upload/types.js';

/** The engine now drives the abstract `UploadTransport` seam; the webclient
 *  path is the WS transport. This helper preserves the original `{ connect }`
 *  construction so every engine test below stays byte-identical — it routes
 *  `connect` through the REAL `createWsUploadTransport`, so these tests remain
 *  the regression net for the webclient (binary-frame) path after the seam
 *  extraction (D-172 step 5b). */
const createTestEngine = (opts: {
  callers: UploadCallers;
  connect: UploadConnectFactory;
  digest?: UploadDigest;
  chunkBytes?: number;
  store?: UploadResumeStore;
  maxReconnects?: number;
}): UploadEngine => {
  const engineOpts: UploadEngineOptions = {
    callers: opts.callers,
    transport: createWsUploadTransport({ connect: opts.connect }),
    ...(opts.digest !== undefined ? { digest: opts.digest } : {}),
    ...(opts.chunkBytes !== undefined ? { chunkBytes: opts.chunkBytes } : {}),
    ...(opts.store !== undefined ? { store: opts.store } : {}),
    ...(opts.maxReconnects !== undefined ? { maxReconnects: opts.maxReconnects } : {}),
  };
  return createUploadEngine(engineOpts);
};

// ════════════════════════════════════════════════════════════════════
// Fakes — socket, callers, file, timing.
// ════════════════════════════════════════════════════════════════════

interface FakeSocket extends UploadSocket {
  sent: Uint8Array[];
  closed: boolean;
  pushAckOk(opts: { total: number; complete?: boolean }): {
    offset: number;
    newOffset: number;
    length: number;
  };
  pushAckBad(reason: string, offset?: number): void;
  pushClose(): void;
  pushError(): void;
}

const makeSocket = (): FakeSocket => {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const fire = (type: string, event: unknown): void => {
    for (const fn of listeners.get(type) ?? []) fn(event);
  };
  const lastFrame = (): ReturnType<typeof decodeUploadChunkFrame> => {
    const raw = socket.sent[socket.sent.length - 1];
    if (raw === undefined) throw new Error('no frame sent yet');
    return decodeUploadChunkFrame(raw);
  };
  const socket: FakeSocket = {
    sent: [],
    closed: false,
    send: (data) => {
      socket.sent.push(data as Uint8Array);
    },
    close: () => {
      socket.closed = true;
    },
    addEventListener: (type, fn) => {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    removeEventListener: (type, fn) => {
      const list = listeners.get(type);
      if (list !== undefined) listeners.set(type, list.filter((f) => f !== fn));
    },
    pushAckOk: ({ total, complete }) => {
      const dec = lastFrame();
      if (!dec.ok) throw new Error('bad frame');
      const newOffset = dec.frame.offset + dec.frame.bytes.length;
      fire('message', {
        data: JSON.stringify({
          type: 'upload_ack',
          req_id: dec.frame.req_id,
          ok: true,
          offset: newOffset,
          complete: complete ?? newOffset >= total,
        }),
      });
      return { offset: dec.frame.offset, newOffset, length: dec.frame.bytes.length };
    },
    pushAckBad: (reason, offset) => {
      const dec = lastFrame();
      if (!dec.ok) throw new Error('bad frame');
      fire('message', {
        data: JSON.stringify({
          type: 'upload_ack',
          req_id: dec.frame.req_id,
          ok: false,
          reason,
          ...(offset !== undefined ? { offset } : {}),
        }),
      });
    },
    pushClose: () => {
      socket.closed = true;
      fire('close', {});
    },
    pushError: () => fire('error', {}),
  };
  return socket;
};

/** Decode every frame the engine sent, in order — for offset/length asserts. */
const sentOffsets = (socket: FakeSocket): number[] =>
  socket.sent.map((raw) => {
    const dec = decodeUploadChunkFrame(raw);
    if (!dec.ok) throw new Error('bad frame');
    return dec.frame.offset;
  });

const makeFile = (
  bytes: Uint8Array,
  over: Partial<Pick<UploadFile, 'name' | 'type' | 'lastModified'>> = {},
): UploadFile => ({
  name: over.name ?? 'photo.bin',
  size: bytes.length,
  type: over.type ?? 'application/octet-stream',
  lastModified: over.lastModified ?? 1234,
  slice: (start, end) => ({
    arrayBuffer: async () => bytes.slice(start, end).buffer,
  }),
});

const bytesOf = (n: number): Uint8Array =>
  Uint8Array.from({ length: n }, (_unused, i) => i % 251);

/** A digest that doesn't touch `crypto.subtle` — keeps tests deterministic. */
const fakeDigest = async (b: Uint8Array): Promise<string> => `cs${b.length}`;

const CREATED: UploadCreateRpcResponse = { status: 'created', upload_id: 'up-1' };
const FINALIZED: UploadFinalizeRpcResponse = {
  status: 'finalized',
  record_id: 'file:received:rec-1',
  content_hash: 'sha256:abc',
  size_bytes: 0,
};

const makeCallers = (over: Partial<UploadCallers> = {}): UploadCallers => ({
  create: over.create ?? vi.fn(async () => CREATED),
  probe:
    over.probe ??
    vi.fn(async () => ({ resumable: false, reason: 'not_found' }) as UploadProbeRpcResponse),
  finalize: over.finalize ?? vi.fn(async () => FINALIZED),
  delete: over.delete ?? vi.fn(async () => ({ deleted: true })),
});

/** One macro-task round drains the engine's already-resolved await chain up to
 *  its next external wait (an ack / close). Three rounds is ample slack. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 3; i += 1) await new Promise((r) => setTimeout(r, 0));
};

const waitFor = async (pred: () => boolean, label = 'condition'): Promise<void> => {
  for (let i = 0; i < 200; i += 1) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`waitFor timed out: ${label}`);
};

/** Collect every progress emit; `last()` is the most recent. */
const collector = () => {
  const all: UploadProgress[] = [];
  return { on: (p: UploadProgress) => all.push(p), all, last: () => all.at(-1) };
};

// ════════════════════════════════════════════════════════════════════
// 1. engine.ts — the network state machine
// ════════════════════════════════════════════════════════════════════

describe('upload engine — happy paths', () => {
  it('single chunk: create → chunk → finalize → done', async () => {
    const socket = makeSocket();
    const callers = makeCallers();
    const file = makeFile(bytesOf(6), { type: 'image/png' });
    const sink = collector();
    const engine = createTestEngine({
      callers,
      connect: async () => socket,
      digest: fakeDigest,
    });
    engine.on('progress', sink.on);

    engine.start(file);
    await flush();
    // create called with the file's declared identity (no scope_key).
    expect(callers.create).toHaveBeenCalledWith({
      filename: 'photo.bin',
      declared_size: 6,
      mime_reported: 'image/png',
    });
    expect(socket.sent).toHaveLength(1);
    const decoded = decodeUploadChunkFrame(socket.sent[0]!);
    expect(decoded.ok && decoded.frame.upload_id).toBe('up-1');
    expect(decoded.ok && decoded.frame.offset).toBe(0);
    expect(decoded.ok && decoded.frame.bytes.length).toBe(6);

    socket.pushAckOk({ total: 6 }); // newOffset 6 == size → complete
    await flush();
    expect(callers.finalize).toHaveBeenCalledWith({ upload_id: 'up-1' });
    const done = sink.last()!;
    expect(done.phase).toBe('done');
    expect(done.sent).toBe(6);
    expect(done.total).toBe(6);
    expect(done.recordId).toBe('file:received:rec-1');
  });

  it('multi-chunk: advances through each server offset then finalizes once', async () => {
    const socket = makeSocket();
    const callers = makeCallers();
    const engine = createTestEngine({
      callers,
      connect: async () => socket,
      digest: fakeDigest,
      chunkBytes: 4,
    });
    const sink = collector();
    engine.on('progress', sink.on);

    engine.start(makeFile(bytesOf(10))); // 4 + 4 + 2
    await flush();
    socket.pushAckOk({ total: 10 });
    await flush();
    socket.pushAckOk({ total: 10 });
    await flush();
    socket.pushAckOk({ total: 10 }); // newOffset 10 → complete
    await flush();

    expect(sentOffsets(socket)).toEqual([0, 4, 8]);
    expect(callers.finalize).toHaveBeenCalledTimes(1);
    expect(sink.last()!.phase).toBe('done');
  });
});

describe('upload engine — resume', () => {
  it('a stored upload_id for the SAME file probes + resumes (no create)', async () => {
    const socket = makeSocket();
    const probe = vi.fn(
      async () => ({ resumable: true, offset: 4, complete: false }) as UploadProbeRpcResponse,
    );
    const callers = makeCallers({ probe });
    const store = { get: () => 'up-stored', set: vi.fn(), delete: vi.fn() };
    const engine = createTestEngine({
      callers,
      connect: async () => socket,
      digest: fakeDigest,
      chunkBytes: 4,
      store,
    });
    const sink = collector();
    engine.on('progress', sink.on);

    engine.start(makeFile(bytesOf(8))); // resumes at 4 → one 4-byte chunk left
    await flush();
    expect(callers.create).not.toHaveBeenCalled();
    expect(probe).toHaveBeenCalledWith({
      upload_id: 'up-stored',
      filename: 'photo.bin',
      declared_size: 8,
    });
    expect(sentOffsets(socket)).toEqual([4]);
    socket.pushAckOk({ total: 8 });
    await flush();
    expect(sink.last()!.phase).toBe('done');
  });

  it('probe complete → straight to finalize (no chunks sent)', async () => {
    const socket = makeSocket();
    const probe = vi.fn(
      async () => ({ resumable: true, offset: 8, complete: true }) as UploadProbeRpcResponse,
    );
    const callers = makeCallers({ probe });
    const store = { get: () => 'up-stored', set: vi.fn(), delete: vi.fn() };
    const engine = createTestEngine({
      callers,
      connect: async () => socket,
      digest: fakeDigest,
      store,
    });
    const sink = collector();
    engine.on('progress', sink.on);

    engine.start(makeFile(bytesOf(8)));
    await flush();
    expect(socket.sent).toHaveLength(0);
    expect(callers.finalize).toHaveBeenCalledTimes(1);
    expect(sink.last()!.phase).toBe('done');
  });

  it('probe not_found → discards the stale id + creates fresh', async () => {
    const socket = makeSocket();
    const probe = vi.fn(
      async () => ({ resumable: false, reason: 'file_mismatch' }) as UploadProbeRpcResponse,
    );
    const callers = makeCallers({ probe });
    const store = { get: () => 'up-stale', set: vi.fn(), delete: vi.fn() };
    const engine = createTestEngine({
      callers,
      connect: async () => socket,
      digest: fakeDigest,
      store,
    });
    engine.start(makeFile(bytesOf(4)));
    await flush();
    expect(store.delete).toHaveBeenCalled(); // stale entry dropped
    expect(callers.create).toHaveBeenCalledTimes(1);
    expect(store.set).toHaveBeenCalledWith(expect.any(String), 'up-1');
  });
});

describe('upload engine — recoverable acks', () => {
  it('offset_conflict re-syncs to the server offset and skips ahead', async () => {
    const socket = makeSocket();
    const callers = makeCallers();
    const engine = createTestEngine({
      callers,
      connect: async () => socket,
      digest: fakeDigest,
      chunkBytes: 4,
    });
    const sink = collector();
    engine.on('progress', sink.on);

    engine.start(makeFile(bytesOf(10)));
    await flush();
    socket.pushAckOk({ total: 10 }); // 0 → 4
    await flush();
    // server is already at 8 (a prior chunk landed twice) — jump, don't re-send @4
    socket.pushAckBad('offset_conflict', 8);
    await flush();
    socket.pushAckOk({ total: 10 }); // 8 → 10 complete
    await flush();

    expect(sentOffsets(socket)).toEqual([0, 4, 8]);
    expect(sink.last()!.phase).toBe('done');
  });

  it('offset_conflict WITHOUT an offset is terminal (nothing to resync to)', async () => {
    const socket = makeSocket();
    const engine = createTestEngine({
      callers: makeCallers(),
      connect: async () => socket,
      digest: fakeDigest,
    });
    const sink = collector();
    engine.on('progress', sink.on);
    engine.start(makeFile(bytesOf(4)));
    await flush();
    socket.pushAckBad('offset_conflict'); // no offset
    await flush();
    expect(sink.last()!.phase).toBe('error');
    expect(sink.last()!.error).toBe('offset_conflict');
  });

  it('checksum_mismatch re-sends the SAME slice in place', async () => {
    const socket = makeSocket();
    const engine = createTestEngine({
      callers: makeCallers(),
      connect: async () => socket,
      digest: fakeDigest,
    });
    const sink = collector();
    engine.on('progress', sink.on);
    engine.start(makeFile(bytesOf(4)));
    await flush();
    socket.pushAckBad('checksum_mismatch');
    await flush();
    socket.pushAckOk({ total: 4 });
    await flush();
    expect(sentOffsets(socket)).toEqual([0, 0]); // re-sent at 0, then accepted
    expect(sink.last()!.phase).toBe('done');
  });

  it('a stuck checksum_mismatch loop is bounded (fails after the retry cap)', async () => {
    const socket = makeSocket();
    const engine = createTestEngine({
      callers: makeCallers(),
      connect: async () => socket,
      digest: fakeDigest,
    });
    const sink = collector();
    engine.on('progress', sink.on);
    engine.start(makeFile(bytesOf(4)));
    await flush();
    for (let i = 0; i < 4; i += 1) {
      socket.pushAckBad('checksum_mismatch');
      await flush();
    }
    // initial send + 3 re-sends, then the 4th mismatch trips the cap.
    expect(socket.sent).toHaveLength(4);
    expect(sink.last()!.phase).toBe('error');
    expect(sink.last()!.error).toBe('checksum_mismatch');
  });
});

describe('upload engine — reconnect + budget', () => {
  it('a dropped socket reconnects, probes the real offset, and resumes', async () => {
    const sockets: FakeSocket[] = [];
    const connect = vi.fn(async () => {
      const s = makeSocket();
      sockets.push(s);
      return s;
    });
    const probe = vi.fn(
      async () => ({ resumable: true, offset: 4, complete: false }) as UploadProbeRpcResponse,
    );
    const callers = makeCallers({ probe });
    const engine = createTestEngine({ callers, connect, digest: fakeDigest, chunkBytes: 4 });
    const sink = collector();
    engine.on('progress', sink.on);

    engine.start(makeFile(bytesOf(8)));
    await flush(); // socket[0] has frame@0
    expect(sockets).toHaveLength(1);
    sockets[0]!.pushClose(); // ack lost; server actually persisted @0..4
    await flush(); // reconnect → probe → socket[1] frame@4
    expect(connect).toHaveBeenCalledTimes(2);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(sentOffsets(sockets[1]!)).toEqual([4]);
    sockets[1]!.pushAckOk({ total: 8 });
    await flush();
    expect(sink.last()!.phase).toBe('done');
  });

  it('lost-ack progress refills the reconnect budget (a flaky-but-advancing link succeeds)', async () => {
    // maxReconnects=1: WITHOUT the progress-refill, the 2nd drop fails. WITH it,
    // each probe-confirmed advance resets the budget, so the upload completes.
    const sockets: FakeSocket[] = [];
    const connect = vi.fn(async () => {
      const s = makeSocket();
      sockets.push(s);
      return s;
    });
    let probed = 0;
    const probe = vi.fn(async () => {
      probed += 1;
      return { resumable: true, offset: probed * 4, complete: false } as UploadProbeRpcResponse;
    });
    const engine = createTestEngine({
      callers: makeCallers({ probe }),
      connect,
      digest: fakeDigest,
      chunkBytes: 4,
      maxReconnects: 1,
    });
    const sink = collector();
    engine.on('progress', sink.on);

    engine.start(makeFile(bytesOf(12))); // 4 + 4 + 4
    await flush();
    sockets[0]!.pushClose(); // drop #1 → probe → offset 4 (progress) → budget reset
    await flush();
    sockets[1]!.pushClose(); // drop #2 → probe → offset 8 (progress) → budget reset
    await flush();
    sockets[2]!.pushAckOk({ total: 12 }); // 8 → 12 complete
    await flush();
    expect(sink.last()!.phase).toBe('done');
  });

  it('exhausting the reconnect budget on a dead link fails with connection_lost', async () => {
    const connect = vi.fn(async () => {
      throw new Error('no route to host');
    });
    const probe = vi.fn(
      async () => ({ resumable: true, offset: 0, complete: false }) as UploadProbeRpcResponse,
    );
    const engine = createTestEngine({
      callers: makeCallers({ probe }),
      connect,
      digest: fakeDigest,
      maxReconnects: 2,
    });
    const sink = collector();
    engine.on('progress', sink.on);
    engine.start(makeFile(bytesOf(4)));
    await waitFor(() => sink.last()?.phase === 'error', 'error');
    expect(sink.last()!.error).toBe('connection_lost');
  });
});

describe('upload engine — finalize + create outcomes', () => {
  it('finalize pending (incomplete) resumes from the server offset then finalizes', async () => {
    const socket = makeSocket();
    let finalizeCalls = 0;
    const finalize = vi.fn(async () => {
      finalizeCalls += 1;
      return finalizeCalls === 1
        ? ({ status: 'pending', reason: 'incomplete', offset: 6 } as UploadFinalizeRpcResponse)
        : FINALIZED;
    });
    const callers = makeCallers({ finalize });
    const engine = createTestEngine({
      callers,
      connect: async () => socket,
      digest: fakeDigest,
      chunkBytes: 10,
    });
    const sink = collector();
    engine.on('progress', sink.on);

    engine.start(makeFile(bytesOf(10)));
    await flush();
    socket.pushAckOk({ total: 10 }); // chunk@0 complete → finalize#1 → pending @6
    await flush();
    socket.pushAckOk({ total: 10 }); // resumed chunk@6 complete → finalize#2 → done
    await flush();

    expect(sentOffsets(socket)).toEqual([0, 6]);
    expect(finalize).toHaveBeenCalledTimes(2);
    expect(sink.last()!.phase).toBe('done');
  });

  it('create rejected → error, no socket opened', async () => {
    const connect = vi.fn(async () => makeSocket());
    const create = vi.fn(
      async () =>
        ({ status: 'rejected', reason: 'size_cap_exceeded', detail: 'too big' }) as UploadCreateRpcResponse,
    );
    const engine = createTestEngine({
      callers: makeCallers({ create }),
      connect,
      digest: fakeDigest,
    });
    const sink = collector();
    engine.on('progress', sink.on);
    engine.start(makeFile(bytesOf(4)));
    await flush();
    expect(connect).not.toHaveBeenCalled();
    expect(sink.last()!.phase).toBe('error');
    expect(sink.last()!.error).toBe('size_cap_exceeded');
  });

  it('finalize gone → error', async () => {
    const socket = makeSocket();
    const finalize = vi.fn(
      async () => ({ status: 'gone', reason: 'expired' }) as UploadFinalizeRpcResponse,
    );
    const engine = createTestEngine({
      callers: makeCallers({ finalize }),
      connect: async () => socket,
      digest: fakeDigest,
    });
    const sink = collector();
    engine.on('progress', sink.on);
    engine.start(makeFile(bytesOf(4)));
    await flush();
    socket.pushAckOk({ total: 4 });
    await flush();
    expect(sink.last()!.phase).toBe('error');
    expect(sink.last()!.error).toBe('expired');
  });
});

describe('upload engine — cancel / destroy reaping', () => {
  it('cancel mid-upload closes the socket, reaps the server scratch + store, emits nothing', async () => {
    const socket = makeSocket();
    const store = { get: () => null, set: vi.fn(), delete: vi.fn() };
    const callers = makeCallers();
    const engine = createTestEngine({
      callers,
      connect: async () => socket,
      digest: fakeDigest,
      store,
    });
    const sink = collector();
    engine.on('progress', sink.on);
    engine.start(makeFile(bytesOf(8), { name: 'doc.bin', lastModified: 9 }));
    await flush();
    const before = sink.all.length;

    engine.cancel();
    await flush();
    expect(socket.closed).toBe(true);
    expect(callers.delete).toHaveBeenCalledWith({ upload_id: 'up-1' });
    expect(store.delete).toHaveBeenCalledWith('doc.bin:8:9');
    // No terminal progress — the widget that initiated cancel resets its own UI.
    expect(sink.all.length).toBe(before);
    expect(sink.all.some((p) => p.phase === 'done' || p.phase === 'error')).toBe(false);
  });

  it('cancel WHILE create is in-flight still reaps the late-created session', async () => {
    // The codex-flagged race: at cancel time uploadId is still '' (create
    // pending), so cancel can't delete; the post-resolve guard reaps instead.
    const socket = makeSocket();
    let releaseCreate: (v: UploadCreateRpcResponse) => void = () => {};
    const create = vi.fn(
      () => new Promise<UploadCreateRpcResponse>((res) => (releaseCreate = res)),
    );
    const store = { get: () => null, set: vi.fn(), delete: vi.fn() };
    const callers = makeCallers({ create });
    const engine = createTestEngine({
      callers,
      connect: async () => socket,
      digest: fakeDigest,
      store,
    });
    engine.start(makeFile(bytesOf(8)));
    await flush(); // create is pending (never resolved yet)
    engine.cancel(); // uploadId still '' here
    expect(callers.delete).not.toHaveBeenCalled();

    releaseCreate(CREATED); // create resolves AFTER cancel
    await flush();
    expect(callers.delete).toHaveBeenCalledWith({ upload_id: 'up-1' });
    expect(socket.sent).toHaveLength(0); // never started chunking
  });

  it('destroy reaps the in-flight session like cancel', async () => {
    const socket = makeSocket();
    const store = { get: () => null, set: vi.fn(), delete: vi.fn() };
    const callers = makeCallers();
    const engine = createTestEngine({
      callers,
      connect: async () => socket,
      digest: fakeDigest,
      store,
    });
    engine.start(makeFile(bytesOf(8), { name: 'big.bin', lastModified: 7 }));
    await flush();
    engine.destroy();
    expect(socket.closed).toBe(true);
    expect(callers.delete).toHaveBeenCalledWith({ upload_id: 'up-1' });
    expect(store.delete).toHaveBeenCalledWith('big.bin:8:7');
  });

  it('start is a no-op while a run is already in flight', async () => {
    const socket = makeSocket();
    const callers = makeCallers();
    const engine = createTestEngine({
      callers,
      connect: async () => socket,
      digest: fakeDigest,
    });
    const file = makeFile(bytesOf(6));
    engine.start(file);
    engine.start(file); // ignored
    await flush();
    expect(callers.create).toHaveBeenCalledTimes(1);
  });
});

// ════════════════════════════════════════════════════════════════════
// 2. wire.ts — DOM glue over a fake DOM
// ════════════════════════════════════════════════════════════════════

describe('upload widget — wire', () => {
  it('a file-input change drives the engine to done and paints the progress region', async () => {
    const { root, input, progress } = buildShell();
    const socket = makeSocket();
    // Auto-ack each (single-chunk) send as complete so the engine reaches done.
    const realSend = socket.send;
    socket.send = (data) => {
      realSend(data);
      setTimeout(() => socket.pushAckOk({ total: 0, complete: true }), 0);
    };
    const onDone = vi.fn();
    const handle = wireUploadWidget(asParent(root), {
      callers: makeCallers(),
      connect: async () => socket,
      config: { widgetId: 'w1' },
      digest: fakeDigest,
      onDone,
    });

    setFiles(input, [makeFile(bytesOf(6))]);
    dispatch(input, 'change', {});
    await waitFor(() => progress.innerHTML.includes('Uploaded'), 'done paint');
    expect(progress.innerHTML).toContain('photo.bin');
    expect(onDone).toHaveBeenCalledTimes(1);
    handle.destroy();
  });

  it('the cancel button cancels the engine and clears the progress region', async () => {
    const { root, input, progress, shell } = buildShell();
    const socket = makeSocket();
    const callers = makeCallers();
    const handle = wireUploadWidget(asParent(root), {
      callers,
      connect: async () => socket,
      config: { widgetId: 'w1' },
      digest: fakeDigest,
    });
    setFiles(input, [makeFile(bytesOf(8))]);
    dispatch(input, 'change', {});
    await waitFor(() => progress.innerHTML.includes('Cancel'), 'uploading paint');
    // Materialize the rendered cancel button (the fake DOM can't parse innerHTML).
    const cancel = makeNode('button', { [UPLOAD_CANCEL_ATTR]: '' });
    shell.appendChild(cancel);
    dispatch(cancel, 'click', {});
    await flush();
    expect(callers.delete).toHaveBeenCalledWith({ upload_id: 'up-1' });
    expect(progress.innerHTML).toBe('');
    handle.destroy();
  });

  it('a drop dispatches the dropped file to the engine', async () => {
    const { root, dropzone, progress } = buildShell();
    const socket = makeSocket();
    const realSend = socket.send;
    socket.send = (data) => {
      realSend(data);
      setTimeout(() => socket.pushAckOk({ total: 0, complete: true }), 0);
    };
    const handle = wireUploadWidget(asParent(root), {
      callers: makeCallers(),
      connect: async () => socket,
      config: { widgetId: 'w1' },
      digest: fakeDigest,
    });
    dispatch(dropzone, 'drop', { dataTransfer: { files: [makeFile(bytesOf(5))] } });
    await waitFor(() => progress.innerHTML.includes('Uploaded'), 'drop done');
    handle.destroy();
  });

  it('degrades to a no-op on a string-only fake DOM (no querySelector)', () => {
    const stringOnly = {} as unknown as ParentNode;
    const handle = wireUploadWidget(stringOnly, {
      callers: makeCallers(),
      connect: async () => makeSocket(),
      config: { widgetId: 'w1' },
      digest: fakeDigest,
    });
    expect(() => handle.rewire(stringOnly)).not.toThrow();
    expect(() => handle.destroy()).not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════
// Fake DOM — attribute-selector querySelector + bubbling dispatch.
// ════════════════════════════════════════════════════════════════════

interface FakeNode {
  tag: string;
  attrs: Map<string, string>;
  children: FakeNode[];
  parent: FakeNode | null;
  listeners: Map<string, Array<(event: unknown) => void>>;
  innerHTML: string;
  files?: unknown;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  querySelector(selector: string): FakeNode | null;
  addEventListener(type: string, fn: (event: unknown) => void): void;
  removeEventListener(type: string, fn: (event: unknown) => void): void;
  appendChild(child: FakeNode): FakeNode;
  readonly parentElement: FakeNode | null;
}

const asParent = (node: FakeNode): ParentNode => node as unknown as ParentNode;

const makeNode = (tag: string, attrs: Record<string, string> = {}): FakeNode => {
  const node: FakeNode = {
    tag,
    attrs: new Map(Object.entries(attrs)),
    children: [],
    parent: null,
    listeners: new Map(),
    innerHTML: '',
    getAttribute: (name) => node.attrs.get(name) ?? null,
    setAttribute: (name, value) => {
      node.attrs.set(name, value);
    },
    removeAttribute: (name) => {
      node.attrs.delete(name);
    },
    querySelector: (selector) => querySelector(node, selector),
    addEventListener: (type, fn) => {
      const list = node.listeners.get(type) ?? [];
      list.push(fn);
      node.listeners.set(type, list);
    },
    removeEventListener: (type, fn) => {
      const list = node.listeners.get(type);
      if (list !== undefined) node.listeners.set(type, list.filter((f) => f !== fn));
    },
    appendChild: (child) => {
      child.parent = node;
      node.children.push(child);
      return child;
    },
    get parentElement() {
      return node.parent;
    },
  };
  return node;
};

const SELECTOR = /^\[([a-z0-9-]+)(?:="([^"]*)")?\]$/;

const matches = (node: FakeNode, selector: string): boolean => {
  const m = SELECTOR.exec(selector);
  if (m === null) return false;
  const [, name, value] = m;
  const have = node.attrs.get(name!);
  if (have === undefined) return false;
  return value === undefined ? true : have === value;
};

const querySelector = (root: FakeNode, selector: string): FakeNode | null => {
  for (const child of root.children) {
    if (matches(child, selector)) return child;
    const nested = querySelector(child, selector);
    if (nested !== null) return nested;
  }
  return null;
};

const dispatch = (
  target: FakeNode,
  type: string,
  props: Record<string, unknown>,
): void => {
  const event = {
    target,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    ...props,
  };
  let node: FakeNode | null = target;
  while (node !== null) {
    for (const fn of node.listeners.get(type) ?? []) fn(event);
    node = node.parent;
  }
};

const setFiles = (input: FakeNode, files: UploadFile[]): void => {
  input.files = files;
};

/** Build a resting shell matching `renderUploadWidget`'s structure (the fake
 *  DOM can't parse `innerHTML`, so hand-build the nodes wire queries). */
const buildShell = (
  widgetId = 'w1',
): { root: FakeNode; shell: FakeNode; dropzone: FakeNode; input: FakeNode; progress: FakeNode } => {
  const root = makeNode('div');
  const shell = makeNode('div', { [UPLOAD_SHELL_ATTR]: widgetId });
  const dropzone = makeNode('label', { [UPLOAD_DROPZONE_ATTR]: '' });
  const input = makeNode('input', { [UPLOAD_INPUT_ATTR]: '' });
  const progress = makeNode('div', { [UPLOAD_PROGRESS_ATTR]: '' });
  dropzone.appendChild(input);
  shell.appendChild(dropzone);
  shell.appendChild(progress);
  root.appendChild(shell);
  return { root, shell, dropzone, input, progress };
};
