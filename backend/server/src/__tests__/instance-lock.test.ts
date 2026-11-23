import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createInstanceLock,
  LockHeldError,
  type InstanceLock,
} from '../lifecycle/instance-lock.js';

describe('instance-lock', () => {
  let dataPath: string;
  let lockPath: string;

  beforeEach(() => {
    dataPath = mkdtempSync(join(tmpdir(), 'recued-lock-'));
    lockPath = join(dataPath, 'recued-server.lock');
  });

  afterEach(() => {
    rmSync(dataPath, { recursive: true, force: true });
  });

  it('claims a fresh lock and writes the expected JSON', () => {
    const lock = createInstanceLock({
      lockPath,
      currentPid: () => 1234,
      isAlive: () => false,
      identify: () => null, // A synthetic PID must not identify a real host process.
    });
    const info = lock.claim({ boot_at: 1_700_000_000_000, bind_port: 7717 });
    expect(info).toEqual({
      pid: 1234,
      boot_at: 1_700_000_000_000,
      bind_port: 7717,
    });
    expect(existsSync(lockPath)).toBe(true);
    expect(lock.inspect()).toEqual(info);
  });

  // `recued status` names the version actually RUNNING from here, because an
  // update swaps the binary on disk before the server restarts onto it.
  it('records the holder\'s version when given one, and reads it back', () => {
    const lock = createInstanceLock({ lockPath, currentPid: () => 1234, isAlive: () => false, identify: () => null });
    const info = lock.claim({ boot_at: 1, bind_port: 7717, version: '26.10.17' });
    expect(info).toEqual({ pid: 1234, boot_at: 1, bind_port: 7717, version: '26.10.17' });
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(info);
    expect(lock.inspect()).toEqual(info);
  });

  // ⛔ AN OLDER READER MUST STILL SEE A LIVE HOLDER. Before `version`, the parse
  // checked only the three numbers and passed the rest through, so a lock that
  // also names a version is still a lock to an older `recued update apply` or
  // `recued stop`: they refuse or stop rather than reading "no server".
  it('a lock from before version recording reads without one, and a bad version is dropped', () => {
    writeFileSync(lockPath, JSON.stringify({ pid: 9999, boot_at: 123, bind_port: 7717 }));
    const lock = createInstanceLock({ lockPath, currentPid: () => 1234, isAlive: () => true });
    expect(lock.inspect()).toEqual({ pid: 9999, boot_at: 123, bind_port: 7717 });
    writeFileSync(lockPath, JSON.stringify({ pid: 9999, boot_at: 123, bind_port: 7717, version: 42 }));
    expect(lock.inspect()).toEqual({ pid: 9999, boot_at: 123, bind_port: 7717 });
    writeFileSync(lockPath, JSON.stringify({ pid: 9999, boot_at: 123, bind_port: 7717, version: '26.10.17' }));
    expect(() => lock.claim({ boot_at: 456, bind_port: 7717, version: '26.10.18' })).toThrow(LockHeldError);
  });

  it('creates the parent directory when missing', () => {
    const deep = join(dataPath, 'nested', 'subdir', 'recued-server.lock');
    const lock = createInstanceLock({
      lockPath: deep,
      currentPid: () => 1234,
      isAlive: () => false,
    });
    lock.claim({ boot_at: 1, bind_port: 7717 });
    expect(existsSync(deep)).toBe(true);
  });

  it('throws LockHeldError when a live process holds the same port', () => {
    // Simulate a prior holder by writing the lock file directly.
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 9999, boot_at: 123, bind_port: 7717 }),
    );
    const lock = createInstanceLock({
      lockPath,
      currentPid: () => 1234,
      isAlive: (pid) => pid === 9999, // holder "alive"
    });
    expect(() => lock.claim({ boot_at: 456, bind_port: 7717 })).toThrow(
      LockHeldError,
    );
    try {
      lock.claim({ boot_at: 456, bind_port: 7717 });
    } catch (err) {
      expect(err).toBeInstanceOf(LockHeldError);
      expect((err as LockHeldError).holder).toEqual({
        pid: 9999,
        boot_at: 123,
        bind_port: 7717,
      });
      expect((err as LockHeldError).code).toBe('LOCK_HELD');
    }
  });

  it('reclaims a lock held by a dead PID', () => {
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 9999, boot_at: 123, bind_port: 7717 }),
    );
    const lock = createInstanceLock({
      lockPath,
      currentPid: () => 1234,
      isAlive: () => false, // holder dead
    });
    const info = lock.claim({ boot_at: 456, bind_port: 7717 });
    expect(info.pid).toBe(1234);
    expect(info.boot_at).toBe(456);
    expect(lock.inspect()?.pid).toBe(1234);
  });

  it('reclaims a lock held by a live PID on a different port', () => {
    // A live process on port 7717 shouldn't block a new process binding
    // port 8080 — different-port = different server.
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 9999, boot_at: 123, bind_port: 7717 }),
    );
    const lock = createInstanceLock({
      lockPath,
      currentPid: () => 1234,
      isAlive: (pid) => pid === 9999,
    });
    const info = lock.claim({ boot_at: 456, bind_port: 8080 });
    expect(info.pid).toBe(1234);
    expect(info.bind_port).toBe(8080);
  });

  it('reclaims when the lock file exists but is malformed', () => {
    writeFileSync(lockPath, 'not json at all');
    const lock = createInstanceLock({
      lockPath,
      currentPid: () => 1234,
      isAlive: () => true,
    });
    const info = lock.claim({ boot_at: 1, bind_port: 7717 });
    expect(info.pid).toBe(1234);
  });

  it('release() deletes the lock file when we own it', () => {
    const lock = createInstanceLock({
      lockPath,
      currentPid: () => 1234,
      isAlive: () => false,
    });
    lock.claim({ boot_at: 1, bind_port: 7717 });
    expect(existsSync(lockPath)).toBe(true);
    lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('release() is a no-op when we never claimed (safety)', () => {
    const lock = createInstanceLock({
      lockPath,
      currentPid: () => 1234,
      isAlive: () => true,
    });
    // Pre-existing lock from another process — our release must NOT
    // delete it.
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 9999, boot_at: 123, bind_port: 7717 }),
    );
    lock.release();
    expect(existsSync(lockPath)).toBe(true);
    expect(lock.inspect()?.pid).toBe(9999);
  });

  it('release() after claim→release is a no-op (idempotent)', () => {
    const lock = createInstanceLock({
      lockPath,
      currentPid: () => 1234,
      isAlive: () => false,
    });
    lock.claim({ boot_at: 1, bind_port: 7717 });
    lock.release();
    expect(() => lock.release()).not.toThrow();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('inspect() returns null when no lock file exists', () => {
    const lock = createInstanceLock({
      lockPath,
      currentPid: () => 1234,
      isAlive: () => false,
    });
    expect(lock.inspect()).toBeNull();
  });

  it('inspect() returns null on malformed content (defensive)', () => {
    writeFileSync(lockPath, '{"pid":"not-a-number"}');
    const lock = createInstanceLock({
      lockPath,
      currentPid: () => 1234,
      isAlive: () => false,
    });
    expect(lock.inspect()).toBeNull();
  });

  it('claiming a lock that we ourselves wrote previously still reclaims', () => {
    // Edge case: same PID as recorded (e.g. crash + restart reusing
    // the same PID on a tiny system). Should reclaim — same-PID check
    // bypasses the liveness branch entirely.
    const lock = createInstanceLock({
      lockPath,
      currentPid: () => 1234,
      isAlive: () => true,
    });
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 1234, boot_at: 1, bind_port: 7717 }),
    );
    const info = lock.claim({ boot_at: 999, bind_port: 7717 });
    expect(info.boot_at).toBe(999);
  });

  it('default isAlive uses process.kill(pid, 0) semantics for self', () => {
    // Write a lock file claiming the current process owns it — self
    // liveness check should succeed, but we short-circuit the
    // same-PID branch before hitting isAlive, so reclaim wins.
    const lock: InstanceLock = createInstanceLock({ lockPath });
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, boot_at: 1, bind_port: 7717 }),
    );
    const info = lock.claim({ boot_at: 2, bind_port: 7717 });
    expect(info.pid).toBe(process.pid);
    expect(info.boot_at).toBe(2);
  });
});

/** A lock outlives an unclean exit, and its PID can then name an unrelated
 *  live process. `proc_start` is what tells the writer from a later process
 *  given its number; unknown on either side leaves the PID to decide. Real
 *  processes and the real identity: `stale-lock-reused-pid.test.ts`. */
describe('instance-lock — a PID reused after an unclean exit', () => {
  let dataPath: string;
  let lockPath: string;

  beforeEach(() => {
    dataPath = mkdtempSync(join(tmpdir(), 'recued-lock-'));
    lockPath = join(dataPath, 'recued-server.lock');
  });

  afterEach(() => {
    rmSync(dataPath, { recursive: true, force: true });
  });

  const heldBy9999 = (procStart?: string): void => writeFileSync(lockPath, JSON.stringify({
    pid: 9999, boot_at: 123, bind_port: 7717, ...(procStart !== undefined ? { proc_start: procStart } : {}),
  }));
  const lockSeeing = (starts: Record<number, string>): InstanceLock => createInstanceLock({
    lockPath,
    currentPid: () => 1234,
    isAlive: (pid) => pid === 9999,
    identify: (pid) => starts[pid] ?? null,
  });

  it('⛔ reclaims a lock whose live PID started at another time — it is not the writer', () => {
    heldBy9999('start-A');
    const info = lockSeeing({ 9999: 'start-B', 1234: 'start-mine' }).claim({ boot_at: 456, bind_port: 7717 });
    expect(info).toEqual({ pid: 1234, boot_at: 456, bind_port: 7717, proc_start: 'start-mine' });
  });

  it('still refuses when the live PID is the process that wrote the lock', () => {
    heldBy9999('start-A');
    expect(() => lockSeeing({ 9999: 'start-A' }).claim({ boot_at: 456, bind_port: 7717 }))
      .toThrow(LockHeldError);
  });

  it('⚠ refuses on the PID alone when the start cannot be read — unknown is not proof', () => {
    heldBy9999('start-A');
    expect(() => lockSeeing({}).claim({ boot_at: 456, bind_port: 7717 })).toThrow(LockHeldError);
  });

  it('judges a lock from before start identities were kept by its PID, as before', () => {
    heldBy9999();
    expect(() => lockSeeing({ 9999: 'start-B' }).claim({ boot_at: 456, bind_port: 7717 }))
      .toThrow(LockHeldError);
  });

  it('records the holder\'s supervisor, so `recued restart` can ask a supervised server to restart itself', () => {
    const lock = lockSeeing({});
    lock.claim({ boot_at: 456, bind_port: 7717, supervisor: 'launchd' });
    expect(JSON.parse(readFileSync(lockPath, 'utf-8')).supervisor).toBe('launchd');
    expect(lock.inspect()?.supervisor).toBe('launchd');
  });

  it("records the claimer's start and reads it back; none where the platform cannot say", () => {
    const lock = lockSeeing({ 1234: 'start-mine' });
    lock.claim({ boot_at: 456, bind_port: 7717 });
    expect(JSON.parse(readFileSync(lockPath, 'utf-8')).proc_start).toBe('start-mine');
    expect(lock.inspect()?.proc_start).toBe('start-mine');

    lock.release();
    lockSeeing({}).claim({ boot_at: 789, bind_port: 7717 });
    expect(JSON.parse(readFileSync(lockPath, 'utf-8'))).not.toHaveProperty('proc_start');
  });
});
