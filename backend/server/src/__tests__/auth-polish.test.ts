/** Rotation + auto-lock tests.
 *
 *  Two independent pieces: password/recovery key rotation rpc, and the
 *  idle-lock timer inside KeyManager.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createKeyManager } from '../key-manager.js';
import { createBundleStore } from '../bundle-store.js';
import {
  handleAuthInit,
  handleAuthLock,
  handleAuthUnlock,
  handleAuthRotatePassword,
  type AuthDeps,
} from '../auth-handler.js';

const FAST = { t: 1, m: 1024, p: 1 };

let workDir: string;
let db: Database.Database;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'recued-polish-'));
  db = new Database(join(workDir, 'test.db'));
});

afterEach(() => {
  db.close();
  rmSync(workDir, { recursive: true, force: true });
});

const mkDeps = (overrides: {
  idleTimeoutMs?: number;
  setTimer?: KeyManagerTimer;
  clearTimer?: (h: unknown) => void;
} = {}): AuthDeps => {
  const bundleStore = createBundleStore(db);
  const keys = createKeyManager({
    loadBundle: () => bundleStore.load(),
    saveBundle: (b) => bundleStore.save(b),
    argon2Params: FAST,
    idleTimeoutMs: overrides.idleTimeoutMs,
    setTimer: overrides.setTimer,
    clearTimer: overrides.clearTimer,
  });
  return { keys };
};

type KeyManagerTimer = (fn: () => void, ms: number) => unknown;

// ────────────────────────────────────────────────────────────────
// rotatePassword
// ────────────────────────────────────────────────────────────────

describe('auth.rotatePassword', () => {
  it('happy path: old pw stops, new pw works, recovery intact', async () => {
    const deps = mkDeps();
    const init = await handleAuthInit(deps, { password: 'old-pw' });
    const recoveryKey = init.recoveryKey;

    const r = await handleAuthRotatePassword(deps, {
      oldPassword: 'old-pw',
      newPassword: 'new-pw',
    });
    expect(r.ok).toBe(true);

    // Lock and try old pw
    deps.keys.lock();
    await expect(deps.keys.unlock({ password: 'old-pw' })).rejects.toThrow();

    // New pw works
    await deps.keys.unlock({ password: 'new-pw' });
    expect(deps.keys.state()).toBe('unlocked');

    // Recovery key still works
    deps.keys.lock();
    await deps.keys.unlock({ recoveryKey });
    expect(deps.keys.state()).toBe('unlocked');
  });

  it('wrong old password → 401', async () => {
    const deps = mkDeps();
    await handleAuthInit(deps, { password: 'real-pw' });
    await expect(handleAuthRotatePassword(deps, {
      oldPassword: 'WRONG',
      newPassword: 'new-pw',
    })).rejects.toMatchObject({ code: 'unauthorized', status: 401 });
  });

  it('while locked → 409 not_unlocked', async () => {
    const deps = mkDeps();
    await handleAuthInit(deps, { password: 'pw' });
    await handleAuthLock(deps);

    await expect(handleAuthRotatePassword(deps, {
      oldPassword: 'pw',
      newPassword: 'new-pw',
    })).rejects.toMatchObject({ code: 'not_unlocked', status: 409 });
  });

  it('rejects missing fields', async () => {
    const deps = mkDeps();
    await handleAuthInit(deps, { password: 'pw' });
    await expect(handleAuthRotatePassword(deps, { oldPassword: 'pw' }))
      .rejects.toMatchObject({ code: 'bad_request', status: 400 });
  });
});

// Recovery-key rotation is deliberately NOT exposed via rpc — it would
// create a way for operators to lock themselves out (new key, forgot
// to update written copy, then lost password = irrecoverable). The
// @recued/crypto primitive `rotateRecoveryKey` exists for admin tools
// but the default server surface leaves the recovery key immutable
// for the lifetime of the bundle.

// ────────────────────────────────────────────────────────────────
// Auto-lock timer
// ────────────────────────────────────────────────────────────────

/** Fake scheduler — tracks armed callbacks; tests call fire() manually. */
const mkFakeTimer = () => {
  let armed: { fn: () => void; ms: number } | null = null;
  let nextHandle = 1;
  return {
    setTimer: ((fn, ms) => { armed = { fn, ms }; return nextHandle++; }) as KeyManagerTimer,
    clearTimer: (() => { armed = null; }) as (h: unknown) => void,
    fire() {
      if (armed) {
        const fn = armed.fn;
        armed = null;
        fn();
      }
    },
    isArmed() { return armed !== null; },
    armedMs() { return armed?.ms ?? 0; },
  };
};

describe('auto-lock — basic behavior', () => {
  it('disabled by default (no idle timeout)', async () => {
    const timer = mkFakeTimer();
    const deps = mkDeps({ setTimer: timer.setTimer, clearTimer: timer.clearTimer });
    await handleAuthInit(deps, { password: 'pw' });
    expect(timer.isArmed()).toBe(false);
  });

  it('arms on unlock when enabled', async () => {
    const timer = mkFakeTimer();
    const deps = mkDeps({ idleTimeoutMs: 60_000, setTimer: timer.setTimer, clearTimer: timer.clearTimer });
    await handleAuthInit(deps, { password: 'pw' });
    expect(timer.isArmed()).toBe(true);
    expect(timer.armedMs()).toBe(60_000);
  });

  it('fires lock when timer elapses', async () => {
    const timer = mkFakeTimer();
    const deps = mkDeps({ idleTimeoutMs: 60_000, setTimer: timer.setTimer, clearTimer: timer.clearTimer });
    await handleAuthInit(deps, { password: 'pw' });
    expect(deps.keys.state()).toBe('unlocked');

    timer.fire();
    expect(deps.keys.state()).toBe('locked');
  });

  it('touch() resets the timer', async () => {
    const timer = mkFakeTimer();
    const deps = mkDeps({ idleTimeoutMs: 60_000, setTimer: timer.setTimer, clearTimer: timer.clearTimer });
    await handleAuthInit(deps, { password: 'pw' });

    // Arm → touch should clear and re-arm (single-timer pattern)
    expect(timer.isArmed()).toBe(true);
    deps.keys.touch();
    expect(timer.isArmed()).toBe(true); // re-armed

    // After firing the CURRENT timer, state locks
    timer.fire();
    expect(deps.keys.state()).toBe('locked');
  });

  it('touch() in locked state is a no-op', async () => {
    const timer = mkFakeTimer();
    const deps = mkDeps({ idleTimeoutMs: 60_000, setTimer: timer.setTimer, clearTimer: timer.clearTimer });
    await handleAuthInit(deps, { password: 'pw' });
    deps.keys.lock();
    expect(timer.isArmed()).toBe(false);
    deps.keys.touch();
    expect(timer.isArmed()).toBe(false); // still disarmed
  });

  it('explicit lock() clears the timer', async () => {
    const timer = mkFakeTimer();
    const deps = mkDeps({ idleTimeoutMs: 60_000, setTimer: timer.setTimer, clearTimer: timer.clearTimer });
    await handleAuthInit(deps, { password: 'pw' });
    expect(timer.isArmed()).toBe(true);
    deps.keys.lock();
    expect(timer.isArmed()).toBe(false);
  });

  it('rotatePassword resets the timer', async () => {
    const timer = mkFakeTimer();
    const deps = mkDeps({ idleTimeoutMs: 60_000, setTimer: timer.setTimer, clearTimer: timer.clearTimer });
    await handleAuthInit(deps, { password: 'pw' });
    expect(timer.isArmed()).toBe(true);

    await handleAuthRotatePassword(deps, { oldPassword: 'pw', newPassword: 'new' });
    // Timer re-armed by rotation (not asserting count, just that it's still active)
    expect(timer.isArmed()).toBe(true);
  });
});

describe('auto-lock — unlock re-arms after idle lock', () => {
  it('auto-lock → unlock → timer re-armed', async () => {
    const timer = mkFakeTimer();
    const deps = mkDeps({ idleTimeoutMs: 60_000, setTimer: timer.setTimer, clearTimer: timer.clearTimer });

    await handleAuthInit(deps, { password: 'pw' });
    timer.fire(); // auto-lock
    expect(deps.keys.state()).toBe('locked');
    expect(timer.isArmed()).toBe(false);

    await handleAuthUnlock(deps, { password: 'pw' });
    expect(deps.keys.state()).toBe('unlocked');
    expect(timer.isArmed()).toBe(true);
  });
});
