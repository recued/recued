import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
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
