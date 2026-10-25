/** M4 — archive download protocol core (`createArchiveDownload`).
 *
 *  Drives the state machine with a fake socket: the happy path assembles the
 *  ordered chunks + requests a save after the size-checked `download_complete`.
 *  Every failure mode (size mismatch, server error frame, premature close,
 *  socket error, save throw, open failure, cancel) settles exactly once with
 *  the right outcome and never double-fires.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createArchiveDownload,
  type ArchiveDownloadDeps,
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
const complete = (size: number, req_id = 'req-1'): string => JSON.stringify({ type: 'download_complete', req_id, size_bytes: size });
const errorFrame = (reason: string, req_id = 'req-1'): string => JSON.stringify({ type: 'download_error', req_id, reason });

/** Flush the microtask + macrotask queue so the async `openSocket` resolves and
 *  the socket listeners + start frame are registered before the test fires. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface Outcome { done: number; error: string[]; }

const run = (opts: {
  openSocket?: ArchiveDownloadDeps['openSocket'];
  saveBlob?: (name: string, parts: ArrayBuffer[]) => void;
  saved?: Array<{ name: string; parts: ArrayBuffer[] }>;
  onProgress?: (received: number) => void;
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
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    onDone: () => { outcome.done += 1; },
    onError: (m) => { outcome.error.push(m); },
  });
  return { outcome, cancel };
};

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('createArchiveDownload', () => {
  it.each(['complete', 'error'] as const)('ignores a foreign %s frame without saving, failing, closing, or losing received bytes', async terminal => {
    vi.useFakeTimers(); const fake = makeFakeSocket(), close = vi.spyOn(fake.socket, 'close'), onProgress = vi.fn();
    const saved: Array<{ name: string; parts: ArrayBuffer[] }> = [], { outcome } = run({ fake, saved, onProgress });
    await vi.advanceTimersByTimeAsync(0); fake.fireBinary(bytes(1, 2));
    fake.fireText(terminal === 'complete' ? complete(2, 'another-request') : errorFrame('not_found', 'another-request'));
    expect(outcome).toEqual({ done: 0, error: [] }); expect(saved).toEqual([]); expect(close).not.toHaveBeenCalled();
    expect(onProgress.mock.calls).toEqual([[0], [2]]); fake.fireBinary(bytes(3)); fake.fireText(complete(3));
    expect(outcome).toEqual({ done: 1, error: [] }); expect(saved[0]!.parts).toEqual([bytes(1, 2), bytes(3)]);
    expect(close).toHaveBeenCalledOnce(); expect(fake.sent).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores terminal messages arriving before the start frame is issued', async () => {
    vi.useFakeTimers(); const fake = makeFakeSocket();
    const { outcome } = run({ fake, onProgress: () => {
      fake.fireText(complete(0)); fake.fireText(JSON.stringify({ type: 'download_error', reason: 'bad_request' }));
    } });
    await vi.advanceTimersByTimeAsync(0); expect(outcome).toEqual({ done: 0, error: [] }); expect(fake.sent).toHaveLength(1);
    fake.fireText(complete(0)); expect(outcome).toEqual({ done: 1, error: [] }); expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts the protocol error without an ID when the start could not be decoded', async () => {
    vi.useFakeTimers(); const fake = makeFakeSocket(), close = vi.spyOn(fake.socket, 'close'), saveBlob = vi.fn();
    const { outcome } = run({ fake, saveBlob }); await vi.advanceTimersByTimeAsync(0);
    fake.fireText(JSON.stringify({ type: 'download_error', reason: 'bad_request' }));
    expect(outcome).toEqual({ done: 0, error: ['Your server said no to the download.'] }); expect(saveBlob).not.toHaveBeenCalled();
    fake.fireText(complete(0)); expect(outcome.error).toHaveLength(1); expect(close).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['not_found', 'invalid_name', 'read_error', 'unrecognized'])('ignores an error without an ID for %s', async reason => {
    vi.useFakeTimers(); const fake = makeFakeSocket(), saveBlob = vi.fn(), { outcome } = run({ fake, saveBlob });
    await vi.advanceTimersByTimeAsync(0); fake.fireText(JSON.stringify({ type: 'download_error', reason }));
    expect(outcome).toEqual({ done: 0, error: [] }); expect(fake.closed).toBe(false); expect(saveBlob).not.toHaveBeenCalled();
    fake.fireText(complete(0)); expect(outcome).toEqual({ done: 1, error: [] }); expect(saveBlob).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it('does not turn a malformed error ID into an allowed uncorrelated error', async () => {
    vi.useFakeTimers(); const fake = makeFakeSocket(), { outcome } = run({ fake }); await vi.advanceTimersByTimeAsync(0);
    fake.fireText(JSON.stringify({ type: 'download_error', req_id: 42, reason: 'bad_request' }));
    expect(outcome).toEqual({ done: 0, error: [] }); fake.fireText(complete(0));
    expect(outcome).toEqual({ done: 1, error: [] }); expect(vi.getTimerCount()).toBe(0);
  });

  it('mints one ID per attempt and rejects the previous ID on a fresh retry socket', async () => {
    vi.useFakeTimers(); const first = makeFakeSocket(), second = makeFakeSocket(), saveBlob = vi.fn(), onDone = vi.fn(), onError = vi.fn();
    const newReqId = vi.fn().mockReturnValueOnce('first-request').mockReturnValueOnce('second-request');
    const driver = createArchiveDownload({ openSocket: vi.fn().mockResolvedValueOnce(first.socket).mockResolvedValueOnce(second.socket), saveBlob, newReqId });
    driver({ name: 'backup.recued.archive', onDone, onError }); await vi.advanceTimersByTimeAsync(0);
    first.fireText(errorFrame('read_error', 'first-request')); expect(onError).toHaveBeenCalledOnce();
    driver({ name: 'backup.recued.archive', onDone, onError }); await vi.advanceTimersByTimeAsync(0); second.fireBinary(bytes(1));
    second.fireText(complete(1, 'first-request')); second.fireText(errorFrame('read_error', 'first-request'));
    expect(saveBlob).not.toHaveBeenCalled(); expect(onDone).not.toHaveBeenCalled(); expect(onError).toHaveBeenCalledOnce(); expect(second.closed).toBe(false);
    second.fireText(complete(1, 'second-request')); expect(saveBlob).toHaveBeenCalledOnce(); expect(onDone).toHaveBeenCalledOnce();
    expect(newReqId).toHaveBeenCalledTimes(2); expect([first, second].map(socket => JSON.parse(socket.sent[0]!).req_id)).toEqual(['first-request', 'second-request']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports socket readiness and cumulative nonempty bytes without treating progress as completion', async () => {
    vi.useFakeTimers(); const fake = makeFakeSocket(), onProgress = vi.fn<(received: number) => void>();
    const saved: Array<{ name: string; parts: ArrayBuffer[] }> = []; let opened!: (socket: DownloadSocketLike) => void;
    const { outcome } = run({ fake, saved, onProgress, openSocket: () => new Promise(resolve => { opened = resolve; }) });
    await vi.advanceTimersByTimeAsync(30_000); expect(onProgress).not.toHaveBeenCalled();
    opened(fake.socket); await vi.advanceTimersByTimeAsync(0); expect(onProgress.mock.calls).toEqual([[0]]);
    fake.fireBinary(bytes(1, 2)); fake.fireBinary(bytes()); fake.fireText('{"type":"ping"}'); fake.fireBinary(bytes(3));
    expect(onProgress.mock.calls).toEqual([[0], [2], [3]]); expect(saved).toEqual([]); expect(outcome).toEqual({ done: 0, error: [] });
    fake.fireText(complete(3)); fake.fireBinary(bytes(4)); expect(onProgress.mock.calls).toEqual([[0], [2], [3]]);
    expect(outcome).toEqual({ done: 1, error: [] }); expect(saved).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps receiving and validating bytes when a progress observer throws', async () => {
    vi.useFakeTimers(); const fake = makeFakeSocket(), onProgress = vi.fn(() => { throw new Error('fixture observer'); });
    const { outcome } = run({ fake, onProgress }); await vi.advanceTimersByTimeAsync(0);
    fake.fireBinary(bytes(1, 2)); fake.fireText(complete(2));
    expect(onProgress.mock.calls).toHaveLength(2); expect(outcome).toEqual({ done: 1, error: [] }); expect(vi.getTimerCount()).toBe(0);
  });

  it('honors cancellation from the readiness observer before sending a start frame', async () => {
    vi.useFakeTimers(); const fake = makeFakeSocket(); let cancel!: () => void;
    ({ cancel } = run({ fake, onProgress: () => cancel() })); await vi.advanceTimersByTimeAsync(0);
    expect(fake.sent).toEqual([]); expect(fake.closed).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts 512 KiB chunks arriving 64 seconds apart on a slow link', async () => {
    vi.useFakeTimers(); const fake = makeFakeSocket(), saved: Array<{ name: string; parts: ArrayBuffer[] }> = [];
    const { outcome } = run({ fake, saved }); await vi.advanceTimersByTimeAsync(0);
    for (let index = 0; index < 2; index++) {
      await vi.advanceTimersByTimeAsync(64_000); expect(outcome.error).toEqual([]); expect(fake.closed).toBe(false);
      fake.fireBinary(new Uint8Array(512 * 1024).buffer);
    }
    fake.fireText(complete(1024 * 1024)); expect(outcome).toEqual({ done: 1, error: [] });
    expect(saved[0]!.parts.map(part => part.byteLength)).toEqual([512 * 1024, 512 * 1024]); expect(vi.getTimerCount()).toBe(0);
  });

  it('times out pending download connection setup instead of waiting indefinitely', async () => {
    vi.useFakeTimers(); const fake = makeFakeSocket();
    const { outcome } = run({ fake, openSocket: () => new Promise(() => {}) });
    await vi.advanceTimersByTimeAsync(59_999); expect(outcome.error).toEqual([]); await vi.advanceTimersByTimeAsync(1); expect(outcome.error).toHaveLength(1); expect(outcome.error[0]).toContain('connection took too long');
    expect(outcome.done).toBe(0); expect(fake.sent).toEqual([]); expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels pending download connection setup immediately', async () => {
    vi.useFakeTimers(); const fake = makeFakeSocket(), aborted = vi.fn();
    const { outcome, cancel } = run({ fake, openSocket: (signal?: AbortSignal) => {
      signal?.addEventListener('abort', aborted); return new Promise(() => {});
    } });
    cancel(); expect(aborted).toHaveBeenCalledOnce(); await vi.advanceTimersByTimeAsync(300_000);
    expect(outcome).toEqual({ done: 0, error: [] }); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['resolve', 'reject'] as const)('ignores a late setup %s after timeout without another outcome or transfer', async late => {
    vi.useFakeTimers(); const fake = makeFakeSocket(), close = vi.spyOn(fake.socket, 'close');
    const onProgress = vi.fn();
    let resolve!: (socket: DownloadSocketLike) => void, reject!: (error: Error) => void, signal!: AbortSignal;
    const { outcome } = run({ fake, onProgress, openSocket: current => { signal = current; return new Promise((yes, no) => { resolve = yes; reject = no; }); } });
    await vi.advanceTimersByTimeAsync(60_000); expect(signal.aborted).toBe(true); const before = structuredClone(outcome);
    if (late === 'resolve') resolve(fake.socket); else reject(new Error('private late credential failure'));
    await vi.advanceTimersByTimeAsync(600_000); expect(outcome).toEqual(before); expect(outcome.error).toHaveLength(1); expect(fake.sent).toEqual([]);
    expect(close).toHaveBeenCalledTimes(late === 'resolve' ? 1 : 0); expect(vi.getTimerCount()).toBe(0);
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('replaces the setup deadline with the full idle interval when a connection opens just before its deadline', async () => {
    vi.useFakeTimers(); const fake = makeFakeSocket(); let opened!: (socket: DownloadSocketLike) => void;
    const { outcome } = run({ fake, openSocket: () => new Promise(resolve => { opened = resolve; }) });
    await vi.advanceTimersByTimeAsync(59_999); opened(fake.socket); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(299_999); expect(outcome.error).toEqual([]); expect(fake.sent).toHaveLength(1);
    fake.fireText(complete(0)); await vi.advanceTimersByTimeAsync(300_000); expect(outcome).toEqual({ done: 1, error: [] }); expect(vi.getTimerCount()).toBe(0);
  });

  it('isolates an explicit retry from the cancelled setup and its late result', async () => {
    vi.useFakeTimers(); const first = makeFakeSocket(), second = makeFakeSocket(), signals: AbortSignal[] = [];
    let late!: (socket: DownloadSocketLike) => void; const saveBlob = vi.fn(), onDone = vi.fn(), onError = vi.fn();
    const openSocket = vi.fn((signal: AbortSignal) => { signals.push(signal); return signals.length === 1 ? new Promise<DownloadSocketLike>(resolve => { late = resolve; }) : Promise.resolve(second.socket); });
    const driver = createArchiveDownload({ openSocket, saveBlob, newReqId: () => 'req-1' });
    driver({ name: 'backup.recued.archive', onDone, onError }); await vi.advanceTimersByTimeAsync(60_000); expect(openSocket).toHaveBeenCalledOnce();
    driver({ name: 'backup.recued.archive', onDone, onError }); await vi.advanceTimersByTimeAsync(0); late(first.socket); await vi.advanceTimersByTimeAsync(0);
    expect(signals.map(signal => signal.aborted)).toEqual([true, false]); expect(first.sent).toEqual([]); expect(first.closed).toBe(true);
    second.fireBinary(bytes(4)); second.fireText(complete(1)); await vi.advanceTimersByTimeAsync(600_000);
    expect(onDone).toHaveBeenCalledOnce(); expect(onError).toHaveBeenCalledOnce(); expect(saveBlob).toHaveBeenCalledOnce(); expect(openSocket).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the setup deadline when the connection factory throws synchronously', async () => {
    vi.useFakeTimers(); const { outcome } = run({ fake: makeFakeSocket(), openSocket: () => { throw new Error('private connection failure'); } });
    await vi.advanceTimersByTimeAsync(600_000); expect(outcome).toEqual({ done: 0, error: ['Recued could not start the download.'] }); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['no bytes', 'partial bytes'] as const)('closes a silent opened download after five minutes with %s, without saving or replaying it', async mode => {
    vi.useFakeTimers(); const fake = makeFakeSocket(), saved: Array<{ name: string; parts: ArrayBuffer[] }> = [];
    const close = vi.spyOn(fake.socket, 'close'), { outcome } = run({ fake, saved }); await vi.advanceTimersByTimeAsync(0);
    if (mode === 'partial bytes') { await vi.advanceTimersByTimeAsync(150_000); fake.fireBinary(bytes(1, 2, 3)); }
    await vi.advanceTimersByTimeAsync(299_999); expect(outcome.error).toEqual([]); expect(close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(outcome.error).toHaveLength(1); expect(outcome.error[0]).toContain('stopped receiving data');
    expect(close).toHaveBeenCalledOnce(); expect(saved).toEqual([]); expect(outcome.done).toBe(0);
    fake.fireBinary(bytes(4)); fake.fireText(complete(mode === 'partial bytes' ? 4 : 1)); fake.fireClose(); fake.fireError();
    await vi.advanceTimersByTimeAsync(600_000); expect(outcome.error).toHaveLength(1); expect(saved).toEqual([]); expect(fake.sent).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a healthy long transfer running while bytes arrive and saves all chunks in order', async () => {
    vi.useFakeTimers(); const fake = makeFakeSocket(), saved: Array<{ name: string; parts: ArrayBuffer[] }> = [];
    const { outcome } = run({ fake, saved }); await vi.advanceTimersByTimeAsync(0);
    for (const value of [1, 2, 3, 4]) { await vi.advanceTimersByTimeAsync(299_000); fake.fireBinary(bytes(value)); expect(outcome.error).toEqual([]); expect(fake.closed).toBe(false); }
    fake.fireText(complete(4)); expect(outcome).toEqual({ done: 1, error: [] });
    expect(saved[0]!.parts.map(part => [...new Uint8Array(part)])).toEqual([[1], [2], [3], [4]]);
    await vi.advanceTimersByTimeAsync(600_000); expect(outcome).toEqual({ done: 1, error: [] }); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['empty chunk', 'unrecognized text', 'unrelated completion', 'unrelated error', 'error without an ID'] as const)('does not let an %s postpone the inactivity deadline', async noise => {
    vi.useFakeTimers(); const fake = makeFakeSocket(), { outcome } = run({ fake }); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(150_000);
    if (noise === 'empty chunk') fake.fireBinary(bytes());
    else if (noise === 'unrelated completion') fake.fireText(complete(0, 'other-request'));
    else if (noise === 'unrelated error') fake.fireText(errorFrame('read_error', 'other-request'));
    else if (noise === 'error without an ID') fake.fireText(JSON.stringify({ type: 'download_error', reason: 'not_found' }));
    else { fake.fireText('not-json'); fake.fireText('{"type":"ping"}'); }
    await vi.advanceTimersByTimeAsync(150_000); expect(outcome.error).toHaveLength(1); expect(outcome.error[0]).toContain('stopped receiving data'); expect(fake.closed).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['done', 'error frame', 'socket close', 'socket error', 'cancel', 'wrong size', 'save error', 'send error'] as const)('clears the watchdog on %s and ignores later events', async terminal => {
    vi.useFakeTimers(); const fake = makeFakeSocket(), close = vi.spyOn(fake.socket, 'close');
    const onProgress = vi.fn();
    if (terminal === 'send error') fake.socket.send = () => { throw new Error('fixture send failed'); };
    const { outcome, cancel } = run({ fake, onProgress, ...(terminal === 'save error' ? { saveBlob: () => { throw new Error('fixture save failed'); } } : {}) });
    await vi.advanceTimersByTimeAsync(0);
    if (terminal !== 'send error') {
      await vi.advanceTimersByTimeAsync(299_999); fake.fireBinary(bytes(1));
      if (terminal === 'done' || terminal === 'save error') fake.fireText(complete(1));
      else if (terminal === 'wrong size') fake.fireText(complete(2));
      else if (terminal === 'error frame') fake.fireText(errorFrame('read_error'));
      else if (terminal === 'socket close') fake.fireClose();
      else if (terminal === 'socket error') fake.fireError();
      else cancel();
    }
    expect(outcome.done).toBe(terminal === 'done' ? 1 : 0); expect(outcome.error).toHaveLength(terminal === 'done' || terminal === 'cancel' ? 0 : 1);
    expect(vi.getTimerCount()).toBe(0); const before = structuredClone(outcome);
    const progressBefore = [...onProgress.mock.calls];
    fake.fireBinary(bytes(2)); fake.fireText(complete(2)); fake.fireError(); fake.fireClose(); cancel(); await vi.advanceTimersByTimeAsync(600_000);
    expect(outcome).toEqual(before); expect(close).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    expect(onProgress.mock.calls).toEqual(progressBefore);
  });

  it('cancels before the socket opens and closes the eventual socket without arming a watchdog', async () => {
    vi.useFakeTimers(); const fake = makeFakeSocket(); let opened!: (socket: DownloadSocketLike) => void;
    const onProgress = vi.fn();
    const { outcome, cancel } = run({ fake, onProgress, openSocket: () => new Promise(resolve => { opened = resolve; }) });
    cancel(); opened(fake.socket); await vi.advanceTimersByTimeAsync(0); expect(fake.closed).toBe(true); expect(fake.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(600_000); expect(outcome).toEqual({ done: 0, error: [] }); expect(vi.getTimerCount()).toBe(0);
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('allows a fresh explicit retry while late frames from the timed-out socket cannot save or interrupt it', async () => {
    vi.useFakeTimers(); const first = makeFakeSocket(), second = makeFakeSocket(), saveBlob = vi.fn(), onDone = vi.fn(), onError = vi.fn();
    const openSocket = vi.fn().mockResolvedValueOnce(first.socket).mockResolvedValueOnce(second.socket);
    const driver = createArchiveDownload({ openSocket, saveBlob, newReqId: () => 'req-1' });
    driver({ name: 'backup.recued.archive', onDone, onError }); await vi.advanceTimersByTimeAsync(300_000); expect(onError).toHaveBeenCalledOnce(); expect(openSocket).toHaveBeenCalledOnce();
    driver({ name: 'backup.recued.archive', onDone, onError }); await vi.advanceTimersByTimeAsync(0);
    first.fireBinary(bytes(9)); first.fireText(complete(1)); first.fireError(); expect(saveBlob).not.toHaveBeenCalled(); expect(second.closed).toBe(false);
    second.fireBinary(bytes(5)); second.fireText(complete(1)); await vi.advanceTimersByTimeAsync(600_000);
    expect(openSocket).toHaveBeenCalledTimes(2); expect(saveBlob).toHaveBeenCalledExactlyOnceWith('backup.recued.archive', [bytes(5)]); expect(onDone).toHaveBeenCalledOnce(); expect(onError).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it('does not leave a watchdog behind when the socket completes synchronously during send', async () => {
    vi.useFakeTimers(); const fake = makeFakeSocket(), foreignOutcomes: Outcome[] = [];
    fake.socket.send = () => { fake.fireText(complete(0, 'other-request')); foreignOutcomes.push(structuredClone(outcome)); fake.fireText(complete(0)); };
    const onProgress = vi.fn();
    const { outcome } = run({ fake, onProgress }); await vi.advanceTimersByTimeAsync(0); expect(outcome).toEqual({ done: 1, error: [] });
    await vi.advanceTimersByTimeAsync(600_000); expect(outcome).toEqual({ done: 1, error: [] }); expect(vi.getTimerCount()).toBe(0);
    expect(onProgress.mock.calls).toEqual([[0]]);
    expect(foreignOutcomes).toEqual([{ done: 0, error: [] }]);
  });

  it('streams chunks in order, then requests a browser save on a size-matched complete', async () => {
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
    expect(outcome.error[0]).toMatch(/did not finish/i);
  });

  it.each([
    ['not_found', 'That backup is no longer on the server.'],
    ['invalid_name', 'That backup file name will not work.'],
    ['read_error', 'The server could not read the backup.'],
    ['bad_request', 'Your server said no to the download.'],
  ] as const)('maps a matching server %s frame to a message', async (reason, message) => {
    const fake = makeFakeSocket();
    const { outcome } = run({ fake });
    await tick();
    fake.fireText(errorFrame(reason));
    expect(outcome.error).toEqual([message]);
    expect(fake.closed).toBe(true);
  });

  it('errors on a premature close + on a socket error', async () => {
    const a = makeFakeSocket();
    const ra = run({ fake: a });
    await tick();
    a.fireClose();
    expect(ra.outcome.error[0]).toMatch(/stopped before it finished/i);

    const b = makeFakeSocket();
    const rb = run({ fake: b });
    await tick();
    b.fireError();
    expect(rb.outcome.error[0]).toMatch(/download went wrong/i);
  });

  it('errors when saveBlob throws (does not report done)', async () => {
    const fake = makeFakeSocket();
    const { outcome } = run({
      fake,
      saveBlob: () => { throw new Error('fixture browser save request failed'); },
    });
    await tick();
    fake.fireBinary(bytes(7, 7));
    fake.fireText(complete(2));
    expect(outcome.done).toBe(0);
    expect(outcome.error).toEqual(['Recued could not start the browser save. Please try again.']);
  });

  it('errors when the socket cannot be opened', async () => {
    const fake = makeFakeSocket();
    const { outcome } = run({ fake, openSocket: async () => { throw new Error('no socket'); } });
    await tick();
    expect(outcome.error[0]).toMatch(/could not start/i);
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
