/** ⛔⛔ A SESSION-SCOPED RUNG MUST ASK WHETHER THE SESSION COMES BACK.
 *
 *  Sealing a realm's key to a login session that will not exist at the next boot
 *  locks the realm out of its own key, unrecoverably, because the winning rung is
 *  recorded in the keyfile and every later start uses exactly it. On a headless
 *  droplet 2026-08-31 `pam_systemd` handed root a user bus over plain SSH,
 *  `secret-service` read that as "a desktop is here", and the systemd unit could
 *  never unseal: `[pro-cert-enrollment] waiting: vault sealed`.
 *
 *  🔑 THIS FILE EXISTS BECAUSE THE PREVIOUS TWO FIXES COULD NOT BE TESTED.
 *  `isAvailable()` short-circuits on `isTestRunner()` and again off-platform, so
 *  on any one dev box both fire and a provider test passes just as happily with
 *  every gate deleted — two fixes shipped on source-shape assertions before that
 *  was worth admitting. The decision now lives in pure predicates, and these hand
 *  them the combinations that matter, on any OS. */

import { describe, expect, it } from 'vitest';

import {
  MACHINE_SECRET_PROVIDER_IDS,
  osKeyringSessionIsSafe,
  secretServiceSessionIsSafe,
  type SessionFacts,
} from '../keys/machine-secret.js';

const linux = (over: Partial<SessionFacts> = {}): SessionFacts => ({
  platform: 'linux',
  isTestRunner: false,
  uid: 1000,
  dbusSessionBusAddress: 'unix:path=/run/user/1000/bus',
  xdgSessionType: 'x11',
  ...over,
});

const darwin = (over: Partial<SessionFacts> = {}): SessionFacts => ({
  platform: 'darwin',
  isTestRunner: false,
  uid: 501,
  launchdManagerName: 'Aqua',
  ...over,
});

describe('secretServiceSessionIsSafe', () => {
  it('accepts a real desktop session', () => {
    expect(secretServiceSessionIsSafe(linux({ xdgSessionType: 'x11' }))).toBe(true);
    expect(secretServiceSessionIsSafe(linux({ xdgSessionType: 'wayland' }))).toBe(true);
  });

  it('⛔ rejects the droplet: root over ssh, with a bus pam_systemd handed it', () => {
    expect(secretServiceSessionIsSafe(linux({
      uid: 0,
      dbusSessionBusAddress: 'unix:path=/run/user/0/bus',
      xdgSessionType: 'tty',
    }))).toBe(false);
  });

  it('⛔ rejects root even when the session LOOKS graphical', () => {
    // Root on a desktop is still the account a supervised server runs as.
    expect(secretServiceSessionIsSafe(linux({ uid: 0, xdgSessionType: 'wayland' }))).toBe(false);
  });

  it('⛔ rejects a NON-root ssh session — the uid gate alone would not', () => {
    expect(secretServiceSessionIsSafe(linux({ xdgSessionType: 'tty' }))).toBe(false);
  });

  it('⛔ rejects a lingering user unit: no session at all', () => {
    // `loginctl enable-linger` boots a user unit with no login session, so the
    // keyring it would seal against is gone at every later start.
    expect(secretServiceSessionIsSafe(linux({
      dbusSessionBusAddress: undefined,
      xdgSessionType: undefined,
    }))).toBe(false);
  });

  it('fails CLOSED on an unrecognised session type', () => {
    for (const t of ['', 'unspecified', 'mir', 'X11', undefined]) {
      expect(secretServiceSessionIsSafe(linux({ xdgSessionType: t }))).toBe(false);
    }
  });

  it('never selects itself off-platform or under the test runner', () => {
    expect(secretServiceSessionIsSafe(linux({ platform: 'darwin' }))).toBe(false);
    expect(secretServiceSessionIsSafe(linux({ platform: 'win32' }))).toBe(false);
    expect(secretServiceSessionIsSafe(linux({ isTestRunner: true }))).toBe(false);
  });
});

describe('osKeyringSessionIsSafe — the rung that asked this correctly all along', () => {
  it('accepts a GUI login session', () => {
    expect(osKeyringSessionIsSafe(darwin())).toBe(true);
  });

  it('⛔ rejects an ssh login (Background) and a LaunchDaemon (System)', () => {
    expect(osKeyringSessionIsSafe(darwin({ launchdManagerName: 'Background' }))).toBe(false);
    expect(osKeyringSessionIsSafe(darwin({ launchdManagerName: 'System' }))).toBe(false);
  });

  it('fails CLOSED on anything else, including a missing probe', () => {
    for (const n of ['', 'aqua', 'StandardIO', undefined]) {
      expect(osKeyringSessionIsSafe(darwin({ launchdManagerName: n }))).toBe(false);
    }
  });

  it('never selects itself off-platform or under the test runner', () => {
    expect(osKeyringSessionIsSafe(darwin({ platform: 'linux' }))).toBe(false);
    expect(osKeyringSessionIsSafe(darwin({ isTestRunner: true }))).toBe(false);
  });
});

describe('the machine rung root falls through to', () => {
  it('systemd-creds is still in the ladder', () => {
    // Removing a session gate is one regression; dropping the rung it falls
    // through to is the other, and would leave root with NO machine rung.
    expect(MACHINE_SECRET_PROVIDER_IDS).toContain('systemd-creds');
  });
});
