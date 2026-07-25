/** M4 — archive download protocol core (`createArchiveDownload`).
 *
 *  Drives the state machine with a fake socket: the happy path assembles the
 *  ordered chunks + saves only after the size-checked `download_complete`, and
 *  every failure mode (size mismatch, server error frame, premature close,
 *  socket error, save throw, open failure, cancel) settles exactly once with the
 *  right outcome and never double-fires.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createArchiveDownload,
  type DownloadSocketLike,
} from '../settings/archive-download.js';

interface FakeSocket {
  sent: string[];
  closed: boolean;
  fireText(t: string): void;
  fireBinary(c: ArrayBuffer): void;
  fireClose(): void;
  fireError(): void;
  socket: DownloadSocketLike;
}

const makeFakeSocket = (): FakeSocket => {
  const sent: string[] = [];
  let textCb: ((t: string) => void) | null = null;
  let binCb: ((c: ArrayBuffer) => void) | null = null;
  let closeCb: (() => void) | null = null;
  let errCb: (() => void) | null = null;
  const f: FakeSocket = {
    sent,
    closed: false,
    fireText: (t) => textCb?.(t),
    fireBinary: (c) => binCb?.(c),
    fireClose: () => closeCb?.(),
    fireError: () => errCb?.(),
    socket: {
      send: (t) => sent.push(t),
      close: () => { f.closed = true; },
      onText: (cb) => { textCb = cb; },
      onBinary: (cb) => { binCb = cb; },
      onClose: (cb) => { closeCb = cb; },
      onError: (cb) => { errCb = cb; },
    },
  };
  return f;
};

const bytes = (...vals: number[]): ArrayBuffer => Uint8Array.from(vals).buffer;
const complete = (size: number): string => JSON.stringify({ type: 'download_complete', req_id: 'req-1', size_bytes: size });
const errorFrame = (reason: string): string => JSON.stringify({ type: 'download_error', req_id: 'req-1', reason });

/** Flush the microtask + macrotask queue so the async `openSocket` resolves and
 *  the socket listeners + start frame are registered before the test fires. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface Outcome { done: number; error: string[]; }

const run = (opts: {
  openSocket?: () => Promise<DownloadSocketLike>;
  saveBlob?: (name: string, parts: ArrayBuffer[]) => void;
  saved?: Array<{ name: string; parts: ArrayBuffer[] }>;
  fake: FakeSocket;
}): { outcome: Outcome; cancel: () => void } => {
  const outcome: Outcome = { done: 0, error: [] };
  const dl = createArchiveDownload({
    openSocket: opts.openSocket ?? (async () => opts.fake.socket),
    saveBlob: opts.saveBlob ?? ((name, parts) => opts.saved?.push({ name, parts })),
    newReqId: () => 'req-1',
  });
  const cancel = dl({
    name: 'recued-x.recued.archive',
    onDone: () => { outcome.done += 1; },
    onError: (m) => { outcome.error.push(m); },
  });
  return { outcome, cancel };
};

afterEach(() => { vi.restoreAllMocks(); });

describe('createArchiveDownload', () => {
  it('streams chunks in order, then saves + reports done on a size-matched complete', async () => {
    const fake = makeFakeSocket();
    const saved: Array<{ name: string; parts: ArrayBuffer[] }> = [];
    const { outcome } = run({ fake, saved });
    await tick();

    // Sent the start frame, named + correlated.
    expect(JSON.parse(fake.sent[0])).toEqual({ type: 'download_start', req_id: 'req-1', name: 'recued-x.recued.archive' });

    fake.fireBinary(bytes(1, 2, 3));
    fake.fireBinary(bytes(4, 5));
    fake.fireText(complete(5)); // 3 + 2 bytes

    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe('recued-x.recued.archive');
    expect(Buffer.concat(saved[0].parts.map((p) => Buffer.from(p)))).toEqual(Buffer.from([1, 2, 3, 4, 5]));
    expect(outcome).toEqual({ done: 1, error: [] });
    expect(fake.closed).toBe(true);
  });

  it('errors (no save) on a truncated transfer — received != size', async () => {
    const fake = makeFakeSocket();
    const saved: Array<{ name: string; parts: ArrayBuffer[] }> = [];
    const { outcome } = run({ fake, saved });
    await tick();
    fake.fireBinary(bytes(1, 2, 3));
    fake.fireText(complete(99)); // claims 99, only got 3

    expect(saved).toHaveLength(0);
    expect(outcome.done).toBe(0);
    expect(outcome.error).toHaveLength(1);
    expect(outcome.error[0]).toMatch(/incomplete/i);
  });

  it('maps a server download_error frame to a message', async () => {
    const fake = makeFakeSocket();
    const { outcome } = run({ fake });
    await tick();
    fake.fireText(errorFrame('not_found'));
    expect(outcome.error).toEqual(['That backup is no longer on the server.']);
    expect(fake.closed).toBe(true);
  });

  it('errors on a premature close + on a socket error', async () => {
    const a = makeFakeSocket();
    const ra = run({ fake: a });
    await tick();
    a.fireClose();
    expect(ra.outcome.error[0]).toMatch(/closed before finishing/i);

    const b = makeFakeSocket();
    const rb = run({ fake: b });
    await tick();
    b.fireError();
    expect(rb.outcome.error[0]).toMatch(/connection failed/i);
  });

  it('errors when saveBlob throws (does not report done)', async () => {
    const fake = makeFakeSocket();
    const { outcome } = run({
      fake,
      saveBlob: () => { throw new Error('disk full'); },
    });
    await tick();
    fake.fireBinary(bytes(7, 7));
    fake.fireText(complete(2));
    expect(outcome.done).toBe(0);
    expect(outcome.error[0]).toMatch(/could not save/i);
  });

  it('errors when the socket cannot be opened', async () => {
    const fake = makeFakeSocket();
    const { outcome } = run({ fake, openSocket: async () => { throw new Error('no socket'); } });
    await tick();
    expect(outcome.error[0]).toMatch(/could not open/i);
  });

  it('cancel settles silently + ignores later events', async () => {
    const fake = makeFakeSocket();
    const saved: Array<{ name: string; parts: ArrayBuffer[] }> = [];
    const { outcome, cancel } = run({ fake, saved });
    await tick();
    cancel();
    expect(fake.closed).toBe(true);
    // Late frames after cancel are ignored — no outcome fires.
    fake.fireBinary(bytes(1));
    fake.fireText(complete(1));
    fake.fireError();
    expect(outcome).toEqual({ done: 0, error: [] });
    expect(saved).toHaveLength(0);
  });

  it('does not double-fire when complete arrives after an error', async () => {
    const fake = makeFakeSocket();
    const { outcome } = run({ fake });
    await tick();
    fake.fireError();
    fake.fireText(complete(0)); // ignored — already settled
    expect(outcome.error).toHaveLength(1);
    expect(outcome.done).toBe(0);
  });
});
