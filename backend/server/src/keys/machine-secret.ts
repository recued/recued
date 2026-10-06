/** D-212 slice 5 — where the keyfile's sealing secret comes from.
 *
 *  The realm database, its bundle sidecar, and the server key that unwraps that
 *  sidecar all live in one directory. Sealing the keyfile is what stops a copied
 *  data volume or a backup blob from yielding the whole realm — but the secret
 *  that seals it must come from OUTSIDE that volume, or it travels with the
 *  thing it was protecting.
 *
 *  ⚠ Size the prize honestly. A secret sitting in a `docker-compose.yml` beside
 *  the data directory is captured along with it. What this defends is backup and
 *  snapshot leakage, where the environment config is not in the same blob. It is
 *  not "the disk is safe if stolen."
 *
 *  ⛔ The recovery key cannot be that secret, and recovery-key-as-salt does not
 *  rescue it. The keyfile exists so boot needs no human; sealing it under the
 *  recovery key means having that key at boot — either on disk, which puts the
 *  disaster-recovery anchor on the volume and is strictly worse than plaintext,
 *  or typed every boot, which ends headless operation. And it collapses: if the
 *  recovery key is available at boot, the keyfile is redundant, because you
 *  would open the bundle directly. A salt is public by construction and buys
 *  none of a secret's value. See D-212 §7.2 — this will otherwise
 *  be re-proposed.
 *
 *  The recovery key's role here is the one it already has: the escape hatch.
 *  Binding lost ⇒ the bundle's recovery wrap still opens ⇒ re-mint a keyfile.
 *  That backstop is what makes machine binding safe to adopt — a wrong provider
 *  choice costs a re-pair, never data.
 */

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { platform } from 'node:process';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';

const run = promisify(execFile);

/** Run a command and feed it `input` on STDIN.
 *
 *  ⛔ THIS EXISTS BECAUSE `run(cmd, args, { input })` SILENTLY DOES NOTHING.
 *  `input` is an option of `execFileSync`, NOT of the async `execFile` this
 *  promisifies — the async form exposes the child's stdin as a stream and never
 *  reads that option. Every call site here passed it inside an options object
 *  cast `as never`, which silenced the excess-property check that would have
 *  said so, so three of the four sealing rungs had never once worked:
 *
 *    - dpapi + systemd-creds probe on stdin, so `isAvailable` timed out and
 *      returned false — a SILENT downgrade to an unsealed keyfile.
 *    - secret-service probes without stdin, so it reported available and then
 *      threw from `provision` ten seconds later.
 *
 *  Measured on a live Windows arm64 boot: identical argv, `{ input }` was KILLED
 *  by the timeout at 4101ms while writing the same bytes to `p.stdin` returned in
 *  253ms. `cat` with `{ input }` takes SIGTERM at 3006ms rather than seeing EOF —
 *  execFile leaves the pipe open — so the failure was always a stall, never a
 *  child that proceeded with empty input. That is the one mercy here: no realm
 *  was ever sealed with an empty secret.
 *
 *  ⚠ `stdin` is null when the child could not be spawned; the callback reports
 *  that, so guard rather than assuming the stream.
 *
 *  Exported ONLY so a test can spawn a real child and assert the bytes arrive.
 *  Every d-212 test mocks the provider registry — correctly, since provisioning
 *  writes to the developer's own keychain — which is exactly why a suite of
 *  thousands stayed green over three rungs that could never work. The mock is
 *  the right call and the reason nothing caught this, so the seam that is NOT
 *  mocked has to be reachable. */
export const runWithInput = (
  cmd: string,
  args: readonly string[],
  input: string,
  options: { timeout: number },
): Promise<{ stdout: string }> =>
  new Promise((res, rej) => {
    const child = execFile(cmd, [...args], options, (err, stdout) => {
      if (err) rej(err);
      else res({ stdout });
    });
    if (!child.stdin) return;
    // A child that dies before draining stdin makes the pipe error; that failure
    // is already reported by the callback above, so do not reject twice.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });

/** Recorded in the keyfile so a later boot knows what sealed it. */
export const MACHINE_SECRET_PROVIDER_IDS = ['os-keyring', 'dpapi', 'secret-service', 'systemd-creds'] as const;

export type MachineSecretProviderId = (typeof MACHINE_SECRET_PROVIDER_IDS)[number];

export const isMachineSecretProviderId = (v: unknown): v is MachineSecretProviderId =>
  typeof v === 'string'
  && (MACHINE_SECRET_PROVIDER_IDS as readonly string[]).includes(v);

/** What a provider needs to answer for a specific realm. `keyfilePath` is here
 *  because availability is not a property of the host alone: `systemd-creds`
 *  only protects anything when its host key sits on a different filesystem than
 *  the data being protected. */
export interface MachineSecretContext {
  /** Absolute path of the keyfile being sealed. */
  keyfilePath: string;
  /** Stable per-realm identifier derived from that path. */
  realmId: string;
}

export interface MachineSecretProvider {
  readonly id: MachineSecretProviderId;
  /** Can this host serve a secret that will STILL be servable at the next
   *  start? Availability is a claim about the future, not the moment — a store
   *  that answers yes now and no at boot is worse than one that says no. */
  isAvailable(ctx: MachineSecretContext): Promise<boolean>;
  /** Mint and persist a fresh secret for this realm, returning it. */
  provision(ctx: MachineSecretContext): Promise<Uint8Array>;
  /** The previously provisioned secret, or null when this realm has none. */
  fetch(ctx: MachineSecretContext): Promise<Uint8Array | null>;
}

/** Two servers on one machine must not share a sealing secret. Derived from the
 *  resolved keyfile path rather than from realm content — the keyfile is what
 *  we are protecting, so it cannot also be the input. */
export const realmIdForKeyfile = (keyfilePath: string): string =>
  createHash('sha256').update(resolve(keyfilePath)).digest('hex').slice(0, 32);

export const MACHINE_SECRET_LEN = 32;
const SERVICE_NAME = 'recued-server-keyfile';

/** ⛔ Never provision from a test runner.
 *
 *  Provisioning writes to the developer's own OS keychain or systemd store —
 *  shared machine state that outlives the process and that nothing cleans up.
 *  The composition root opts into sealing, and the composition root is itself
 *  exercised by the suite, so "opt in at the top" is not on its own enough:
 *  measured, a full `backend/server` run took the keychain from 0 entries to 2.
 *
 *  Declining here is fail-safe — no provider is available, so a new keyfile
 *  stays plaintext exactly as it did before this feature, which is what those
 *  tests already assert. Tests that need to exercise sealing mock the registry
 *  (see `d-212-machine-sealed-keyfile.test.ts`); this guard is for the far
 *  larger set that merely boots storage and should never have been a keychain
 *  writer at all. */
const isTestRunner = (): boolean =>
  !!process.env.VITEST || !!process.env.VITEST_WORKER_ID || process.env.NODE_ENV === 'test';

// ────────────────────────────────────────────────────────────────
// os-keyring — macOS
// ────────────────────────────────────────────────────────────────

/** ⚠ This uses the LOGIN keychain, and that is a deliberate, measured choice.
 *
 *  The System keychain is boot-readable but needs root to write: measured
 *  `SecKeychainItemCreateFromContent (/Library/Keychains/System.keychain):
 *  Write permissions error` at uid 501. A self-hosted server on someone's own
 *  machine is not root.
 *
 *  The login keychain writes fine unprivileged, and is unlocked exactly when
 *  the user is logged in — which on a home rig is exactly when the server runs.
 *  It is NOT unlocked before login, so a boot-time daemon sealed this way would
 *  enrol successfully and then fail every subsequent start. That is the
 *  present-but-locked hazard, and it is why availability is gated on the
 *  session type below rather than on whether the keychain merely answers.
 *
 *  ⛔ Linux (libsecret) and Windows (DPAPI) rungs are NOT here. Shipping a
 *  provider unexercised on its own platform is a declared-not-backed seam whose
 *  failure mode is a realm nobody can boot. They belong in this file, added one
 *  at a time, each verified on its own OS. */
/** ⛔⛔ THE ONE QUESTION A SESSION-SCOPED RUNG MUST ASK: will this session EXIST
 *  AGAIN when the server next starts? Not "is there a session now" — that is the
 *  weaker question, and answering it is what sealed a headless droplet's keyfile
 *  to a root SSH keyring it could never reach again at boot.
 *
 *  🔑 LIFTED OUT OF THE PROVIDERS ON PURPOSE. `isAvailable()` returns false
 *  immediately under `isTestRunner()`, and again off-platform — so on any one dev
 *  box BOTH short-circuit and a test of the provider passes just as happily with
 *  every gate deleted. Two fixes to this decision were merged on source-shape
 *  assertions alone before it was worth admitting that is not a test. These are
 *  pure: hand them any combination of facts, on any OS, and they answer.
 *
 *  ⚠ Both fail CLOSED. An unrecognised session type, a missing probe, an
 *  unexpected manager name — all decline the rung. Declining costs protection
 *  (the realm falls to a lower rung, or to a passphrase); accepting wrongly locks
 *  the realm out of its own key at the next boot, which is unrecoverable without
 *  re-enrolling. */
export interface SessionFacts {
  platform: NodeJS.Platform;
  isTestRunner: boolean;
  /** Effective uid, or -1 where the platform has none. */
  uid: number;
  /** `launchctl managername`, trimmed. macOS. */
  launchdManagerName?: string | undefined;
  /** `DBUS_SESSION_BUS_ADDRESS`. Linux. */
  dbusSessionBusAddress?: string | undefined;
  /** `XDG_SESSION_TYPE`. Linux. */
  xdgSessionType?: string | undefined;
}

/** macOS login keychain. `Aqua` is a GUI login session — unlocked now and again
 *  at the next login. A LaunchDaemon reports `System`, an ssh login reports
 *  `Background`; in both the keychain is locked at start. */
export const osKeyringSessionIsSafe = (f: SessionFacts): boolean =>
  f.platform === 'darwin' && !f.isTestRunner && f.launchdManagerName === 'Aqua';

/** Linux Secret Service. Same question as `osKeyringSessionIsSafe`, asked with
 *  the facts Linux offers.
 *
 *  ⛔ ROOT NEVER. A server running as root is the thing that outlives a login,
 *  and `pam_systemd` hands root a user bus over plain SSH — which is what made
 *  "a bus exists" look like "a desktop is here".
 *
 *  ⛔ AND A GRAPHICAL SESSION, not merely a bus: a NON-root user unit with
 *  `loginctl enable-linger` boots with no login session at all, so the uid gate
 *  alone still mis-seals it. ssh reports `tty`; a desktop reports `x11` or
 *  `wayland`. */
export const secretServiceSessionIsSafe = (f: SessionFacts): boolean =>
  f.platform === 'linux'
  && !f.isTestRunner
  && f.uid !== 0
  && !!f.dbusSessionBusAddress
  && (f.xdgSessionType === 'x11' || f.xdgSessionType === 'wayland');

/** The live facts, gathered impurely so the predicates above never touch a
 *  global. `launchdManagerName` is filled in by the macOS rung, which must spawn
 *  to learn it. */
export const currentSessionFacts = (): SessionFacts => ({
  platform,
  isTestRunner: isTestRunner(),
  uid: typeof process.getuid === 'function' ? process.getuid() : -1,
  dbusSessionBusAddress: process.env.DBUS_SESSION_BUS_ADDRESS,
  xdgSessionType: process.env.XDG_SESSION_TYPE,
});

const macosKeyring: MachineSecretProvider = {
  id: 'os-keyring',

  async isAvailable() {
    if (platform !== 'darwin' || isTestRunner()) return false;
    try {
      // `Aqua` is a GUI login session — the keychain is unlocked now and will
      // be again next time the user logs in. A LaunchDaemon reports `System`
      // and an ssh login reports `Background`; in both the login keychain is
      // locked at start, so we must fall through rather than seal against it.
      //
      // Fail-closed by construction: only the value verified to be safe selects
      // this rung. Anything else — including values not exercised here, and a
      // `launchctl` that is missing or errors — falls through to a lower rung,
      // which costs protection but never locks a realm out.
      const { stdout } = await run('/bin/launchctl', ['managername'], { timeout: 5_000 });
      if (!osKeyringSessionIsSafe({
        ...currentSessionFacts(),
        launchdManagerName: stdout.trim(),
      })) return false;
      await run('/usr/bin/security', ['default-keychain'], { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  },

  async provision({ realmId }) {
    const secret = randomBytes(MACHINE_SECRET_LEN);
    // `-U` updates in place, so re-provisioning after a failed enrollment does
    // not wedge on a duplicate entry.
    await run('/usr/bin/security', [
      'add-generic-password',
      '-a', realmId,
      '-s', SERVICE_NAME,
      '-w', secret.toString('base64'),
      '-U',
    ], { timeout: 10_000 });
    return new Uint8Array(secret);
  },

  async fetch({ realmId }) {
    let raw: string;
    try {
      const { stdout } = await run('/usr/bin/security', [
        'find-generic-password',
        '-a', realmId,
        '-s', SERVICE_NAME,
        '-w',
      ], { timeout: 10_000 });
      raw = stdout.trim();
    } catch {
      // `security` exits non-zero for "not found" (44) and for "keychain
      // locked" alike. Both mean no secret right now; the caller tells them
      // apart by whether the keyfile says this provider sealed it, and says so.
      return null;
    }
    if (!raw) return null;
    const bytes = new Uint8Array(Buffer.from(raw, 'base64'));
    // A truncated or re-encoded entry must not silently derive a weaker key.
    return bytes.length === MACHINE_SECRET_LEN ? bytes : null;
  },
};

// ────────────────────────────────────────────────────────────────
// dpapi — Windows
// ────────────────────────────────────────────────────────────────

/** Run a short PowerShell snippet, handing it input on STDIN.
 *
 *  Never on the command line: argv is world-readable from the process list, and
 *  what passes through here is a 32-byte sealing secret. */
const powershell = async (script: string, input?: string): Promise<string> => {
  const args = ['-NoProfile', '-NonInteractive', '-Command', script];
  const { stdout } = input === undefined
    ? await run('powershell', args, { timeout: 20_000 })
    : await runWithInput('powershell', args, input, { timeout: 20_000 });
  return stdout.trim();
};

const PS_PROTECT =
  'Add-Type -AssemblyName System.Security;'
  + '$i=[Console]::In.ReadToEnd().Trim();'
  + '[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect('
  + '[Convert]::FromBase64String($i),$null,"CurrentUser"))';

const PS_UNPROTECT =
  'Add-Type -AssemblyName System.Security;'
  + '$i=[Console]::In.ReadToEnd().Trim();'
  + '[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Unprotect('
  + '[Convert]::FromBase64String($i),$null,"CurrentUser"))';

/** ⚠ `CurrentUser` scope, and unlike the other rungs there is no session gate.
 *
 *  Measured on Windows 11 24H2 ARM64: a `CurrentUser` blob reopens with exact
 *  bytes in a fresh logon AND across a full reboot (verified against a 46-second
 *  uptime). The master key is derived from the account's profile, which the SCM
 *  loads for a service running under that account — so unlike the macOS login
 *  keychain or a Secret Service session, nothing has to be unlocked by a human
 *  first. That is why this rung needs no `launchctl`-style probe.
 *
 *  `CurrentUser` over `LocalMachine` deliberately: a `LocalMachine` blob is
 *  decryptable by ANY process on the box, so it defends only the copied-volume
 *  threat. `CurrentUser` binds to the account as well, and both survive reboot
 *  equally, so the weaker scope buys nothing here.
 *
 *  ⚠ The scope argument to `Unprotect` is advisory — DPAPI blobs are
 *  self-describing, so a `CurrentUser` blob opens even when `LocalMachine` is
 *  passed. Measured. Never treat the scope flag on the read path as a check. */
const windowsDpapi: MachineSecretProvider = {
  id: 'dpapi',

  async isAvailable() {
    if (platform !== 'win32' || isTestRunner()) return false;
    try {
      // A real round-trip, not a version check: this rung is only available if
      // this account can actually protect and unprotect right now.
      const probe = Buffer.alloc(MACHINE_SECRET_LEN, 0x5a).toString('base64');
      const sealed = await powershell(PS_PROTECT, probe);
      return (await powershell(PS_UNPROTECT, sealed)) === probe;
    } catch {
      return false;
    }
  },

  async provision({ keyfilePath }) {
    const secret = randomBytes(MACHINE_SECRET_LEN);
    const sealed = await powershell(PS_PROTECT, secret.toString('base64'));
    if (!sealed) throw new Error('dpapi: Protect produced no output');
    writeFileSync(machineCredPath(keyfilePath), sealed, { mode: 0o600 });
    return new Uint8Array(secret);
  },

  async fetch({ keyfilePath }) {
    let raw: string;
    try {
      raw = readFileSync(machineCredPath(keyfilePath), { encoding: 'utf8' }).trim();
    } catch {
      return null;
    }
    if (!raw) return null;
    let plain: string;
    try {
      plain = await powershell(PS_UNPROTECT, raw);
    } catch {
      // Wrong account, a machine the blob was not sealed on, or a tampered
      // blob. All mean no secret here; the caller names the keyfile.
      return null;
    }
    const bytes = new Uint8Array(Buffer.from(plain, 'base64'));
    return bytes.length === MACHINE_SECRET_LEN ? bytes : null;
  },
};

// ────────────────────────────────────────────────────────────────
// secret-service — Linux desktop (libsecret / GNOME Keyring, KWallet)
// ────────────────────────────────────────────────────────────────

/** ⚠ A desktop rung, and its availability is a claim about the session.
 *
 *  The Secret Service is unlocked by PAM at login and lives in the user's
 *  session — the same lifecycle as the macOS login keychain, and the same
 *  hazard: a keyring reachable while someone is logged in is NOT reachable to a
 *  service that starts before they are. On a home rig the server runs in that
 *  session, which is exactly when the keyring is open.
 *
 *  `secret-tool search` is the probe. A live service answers 0 even with zero
 *  results; with no service it fails 1 ("Cannot spawn a message bus…"). A bare
 *  lookup cannot be used — "not found" and "no service at all" BOTH exit 1, so
 *  it would read an unreachable keyring as an empty one. Both measured. */
const secretService: MachineSecretProvider = {
  id: 'secret-service',

  async isAvailable() {
    // The entire gate is `secretServiceSessionIsSafe` — pure, and tested there
    // against every combination of uid, bus and session type. What is left here
    // is the one thing that must touch the host: does the daemon answer.
    if (!secretServiceSessionIsSafe(currentSessionFacts())) return false;
    try {
      await run('secret-tool', ['search', 'service', SERVICE_NAME], { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  },

  async provision({ realmId }) {
    const secret = randomBytes(MACHINE_SECRET_LEN);
    // `store` replaces an entry with the same attributes, so re-provisioning
    // after a failed enrollment overwrites rather than duplicating.
    await runWithInput('secret-tool', [
      'store', '--label=recued server keyfile', 'service', SERVICE_NAME, 'account', realmId,
    ], secret.toString('base64'), { timeout: 10_000 });
    return new Uint8Array(secret);
  },

  async fetch({ realmId }) {
    let raw: string;
    try {
      const { stdout } = await run('secret-tool', [
        'lookup', 'service', SERVICE_NAME, 'account', realmId,
      ], { timeout: 10_000 });
      raw = stdout.trim();
    } catch {
      // Absent entry and unreachable service both land here. The caller knows
      // which keyfile expected a secret and says so.
      return null;
    }
    if (!raw) return null;
    const bytes = new Uint8Array(Buffer.from(raw, 'base64'));
    return bytes.length === MACHINE_SECRET_LEN ? bytes : null;
  },
};

// ────────────────────────────────────────────────────────────────
// systemd-creds — Linux
// ────────────────────────────────────────────────────────────────

/** Where systemd keeps the host key that `--with-key=host` encrypts against. */
const SYSTEMD_HOST_KEY = '/var/lib/systemd/credential.secret';

/** The sealed blob for one realm, parked beside the keyfile it seals. Shared by
 *  every provider that produces a blob rather than storing the secret itself —
 *  only one provider ever seals a given keyfile, and its header records which.
 *
 *  Storing it in the data directory is correct and is the whole point: the blob
 *  is useless without the host key, which is NOT in the data directory. Copy the
 *  volume and you get an opaque blob; you do not get what opens it. */
const machineCredPath = (keyfilePath: string): string => `${keyfilePath}.machine-cred`;

/** True when this process is inside a container, so the root filesystem is a
 *  layer that a recreate throws away. `/.dockerenv` is Docker's marker and
 *  `/run/.containerenv` is Podman's; both are files the runtime plants. */
const inContainer = (): boolean =>
  existsSync('/.dockerenv') || existsSync('/run/.containerenv');

/** ⚠ Availability here is not "does systemd-creds work" — it is "does its host
 *  key live somewhere the data does not, AND somewhere that will still exist
 *  next start".
 *
 *  Measured in a container: `/var/lib/systemd/credential.secret` and a
 *  container-local path report the SAME `st_dev`, while a mounted volume reports
 *  a different one. That distinction is the entire protection:
 *
 *    - different device (bare metal / VM with data on its own mount, or Docker
 *      with a real volume) → a volume copy misses the key. Worth doing.
 *    - same device (host key inside the container layer, or persisted into the
 *      data volume) → either it is ephemeral and `--force-recreate` destroys the
 *      realm's only key, or it travels with the copy and protects nothing.
 *      Both are worse than not sealing, so decline.
 *
 *  Fail-closed: anything unreadable or unstattable declines. */
const systemdCreds: MachineSecretProvider = {
  id: 'systemd-creds',

  async isAvailable({ keyfilePath }) {
    if (platform !== 'linux' || isTestRunner()) return false;
    try {
      await run('systemd-creds', ['--version'], { timeout: 5_000 });
    } catch {
      return false;
    }
    try {
      // Encrypting once materializes the host key if systemd has not yet, so the
      // stat below describes the file that will actually be used.
      //
      // ⛔ OUTPUT TO STDOUT ('-'), NEVER /dev/null. systemd-creds writes an
      // output PATH atomically — a temp file beside it, then rename() over it —
      // and a rename replaces a device node like any other file. Measured
      // 2026-10-05 on Ubuntu 24.04 (systemd 255) as root: '/dev/null' here left
      // /dev/null a regular 0644 file holding the blob, and every first boot of
      // a root install broke apt on the host (it verifies signatures as `_apt`,
      // which could no longer write /dev/null). stdout lands in
      // `runWithInput`'s buffer and is dropped; the host key still materializes.
      await runWithInput(
        'systemd-creds',
        ['encrypt', '--name=recued-probe', '--with-key=host', '-', '-'],
        'probe',
        { timeout: 10_000 },
      );
    } catch {
      return false;
    }
    try {
      const keyDev = statSync(SYSTEMD_HOST_KEY).dev;
      const dataDev = statSync(dirname(resolve(keyfilePath))).dev;
      // The key must not travel with the data.
      if (keyDev === dataDev) return false;
      // …and it must not sit on a filesystem that a restart discards. In a
      // container the root layer is exactly that: measured, a Docker run has
      // keydev == rootdev != datadev, so the device test alone PASSES while the
      // key dies on `--force-recreate` and takes the realm with it. Sealing
      // against something ephemeral is worse than not sealing.
      //
      // A deployment that wants this rung in a container has to put the host's
      // credential secret on a filesystem this test can distinguish from the
      // data's. ⚠ That is not always achievable: measured on one storage
      // driver, two separate Docker volumes both report `st_dev` 41, so the
      // device test cannot tell them apart and declines. It errs toward
      // declining a workable setup rather than sealing an unworkable one, and
      // in a container the practical answer is usually
      // `RECUED_IDENTITY_PASSPHRASE`, which outranks every rung here.
      if (inContainer() && keyDev === statSync('/').dev) return false;
      return true;
    } catch {
      return false;
    }
  },

  async provision({ keyfilePath, realmId }) {
    const secret = randomBytes(MACHINE_SECRET_LEN);
    // `--name` is bound into the credential: decrypting under a different name
    // is refused outright ("Embedded credential name … does not match"), so a
    // blob lifted from another realm cannot be replayed into this one.
    await runWithInput('systemd-creds', [
      'encrypt', `--name=${realmId}`, '--with-key=host', '-', machineCredPath(keyfilePath),
    ], secret.toString('base64'), { timeout: 10_000 });
    return new Uint8Array(secret);
  },

  async fetch({ keyfilePath, realmId }) {
    let raw: string;
    try {
      const { stdout } = await run('systemd-creds', [
        'decrypt', `--name=${realmId}`, machineCredPath(keyfilePath), '-',
      ], { timeout: 10_000 });
      raw = stdout.trim();
    } catch {
      // Absent blob, wrong name, or a host key that has been rotated or lost.
      // All mean no secret right now; the caller says which keyfile expected it.
      return null;
    }
    if (!raw) return null;
    const bytes = new Uint8Array(Buffer.from(raw, 'base64'));
    return bytes.length === MACHINE_SECRET_LEN ? bytes : null;
  },
};

// ────────────────────────────────────────────────────────────────
// Registry + selection
// ────────────────────────────────────────────────────────────────

/** Strongest first. `selectMachineSecretProvider` walks in this order. */
/** Strongest first — and "strongest" here means most resistant to the volume
 *  being copied, which is the threat. A desktop keyring keeps the secret out of
 *  the data directory entirely; `systemd-creds` keeps it on a different
 *  filesystem. Both beat a passphrase the operator has to place somewhere. */
export const MACHINE_SECRET_PROVIDERS: readonly MachineSecretProvider[] = [
  macosKeyring,
  windowsDpapi,
  secretService,
  systemdCreds,
];

export const machineSecretProvider = (
  id: MachineSecretProviderId,
): MachineSecretProvider | undefined =>
  MACHINE_SECRET_PROVIDERS.find((p) => p.id === id);

/** The strongest provider this host can serve, or undefined when none can.
 *
 *  ⛔ Called at ENROLLMENT ONLY. A keychain-sealed keyfile cannot be opened with
 *  some other provider's secret, so falling back at OPEN time would not merely
 *  fail to help — it would treat a sealed realm as unsealed, the same silent
 *  downgrade the archive keyless-restore path was fixed to refuse. The winner is
 *  recorded in the keyfile; every later start uses exactly it and fails loudly
 *  when it is gone. */
export const selectMachineSecretProvider = async (
  ctx: MachineSecretContext,
): Promise<MachineSecretProvider | undefined> => {
  for (const provider of MACHINE_SECRET_PROVIDERS) {
    if (await provider.isAvailable(ctx)) return provider;
  }
  return undefined;
};

/** D-212 §7.10 — what this host COULD seal a keyfile with, reported without
 *  committing to any of it.
 *
 *  The model says the operator picks the factor that fits their machine and
 *  that the choice is permanent for the realm. That is only a choice they can
 *  make if they can see what is on offer — nothing surfaced it before, so the
 *  passphrase read as a punishment for having the wrong OS rather than the
 *  preference it is.
 *
 *  ⛔ This must never provision. `isAvailable` only probes — a real DPAPI
 *  round-trip, a `secret-tool search`, a `launchctl` query — while `provision`
 *  is what writes to the operator's keychain. Reporting is a question, not a
 *  decision, and asking it must not deposit shared machine state. (An early
 *  draft of the sealing feature left 28 stray keychain entries by blurring
 *  exactly this line.)
 *
 *  Returns every available rung in ladder order, so the report can name the
 *  winner AND what else was there. */
export const describeMachineSecretCapability = async (
  ctx: MachineSecretContext,
): Promise<MachineSecretProviderId[]> => {
  const available: MachineSecretProviderId[] = [];
  for (const provider of MACHINE_SECRET_PROVIDERS) {
    if (await provider.isAvailable(ctx)) available.push(provider.id);
  }
  return available;
};
