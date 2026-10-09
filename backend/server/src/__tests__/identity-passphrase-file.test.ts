// The identity passphrase as a file (`RECUED_IDENTITY_PASSPHRASE_FILE`), and the container rule
// that a server's key file is never created unsealed there.
//
// ⛔ WHY IT MATTERS. Inside a container there is no keychain and no secret service, so the
// passphrase is the only seal. Without one the server used to write its key file unsealed into
// the data volume, with a warning: a copy of the volume, or a backup of it, then held the key
// that opens the realm. And the only way to give a container the passphrase was an environment
// variable, which `docker inspect` prints and a compose file carries in plain text.

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootServerIdentity, resolveIdentityKeysPath } from '../identity/boot.js';
import { createFileServerKeyStore } from '../keys/file-store.js';
import { readIdentityPassphrase } from '../identity/passphrase-env.js';
import { runningInContainer } from '../lifecycle/supervisor.js';

const FAST_ARGON2 = { t: 1, m: 1024, p: 1 };

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'recued-passphrase-file-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const secretFile = (contents: string | Buffer): string => {
  const path = join(dir, 'recued_identity_passphrase');
  writeFileSync(path, contents);
  chmodSync(path, 0o600);
  return path;
};

describe('readIdentityPassphrase', () => {
  it('reads the variable, and counts an empty one as unset', () => {
    expect(readIdentityPassphrase({ RECUED_IDENTITY_PASSPHRASE: 'p1' })).toBe('p1');
    expect(readIdentityPassphrase({ RECUED_IDENTITY_PASSPHRASE: '' })).toBeUndefined();
    expect(readIdentityPassphrase({})).toBeUndefined();
  });

  it("reads the named file without the line break `echo` leaves", () => {
    expect(readIdentityPassphrase({ RECUED_IDENTITY_PASSPHRASE_FILE: secretFile('p2\n') })).toBe('p2');
    expect(readIdentityPassphrase({ RECUED_IDENTITY_PASSPHRASE_FILE: secretFile('p 3\r\n') })).toBe('p 3');
    expect(readIdentityPassphrase({ RECUED_IDENTITY_PASSPHRASE_FILE: secretFile('p4') })).toBe('p4');
  });

  it('reads a file however an editor or shell saved it', () => {
    // Windows PowerShell 5.1's `"…" > file` writes UTF-16LE with a byte-order mark; read as UTF-8
    // it would seal the realm with garbage that only fails later, against the same passphrase.
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('p6\r\n', 'utf16le')]);
    expect(readIdentityPassphrase({ RECUED_IDENTITY_PASSPHRASE_FILE: secretFile(utf16) })).toBe('p6');
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('p5\r\n', 'utf8')]);
    expect(readIdentityPassphrase({ RECUED_IDENTITY_PASSPHRASE_FILE: secretFile(bom) })).toBe('p5');
    expect(readIdentityPassphrase({ RECUED_IDENTITY_PASSPHRASE_FILE: secretFile('p7\r') })).toBe('p7');
  });

  it('refuses a file that is not plain text, rather than sealing with what it decodes to', () => {
    const bigEndian = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('p8', 'utf16le').swap16()]);
    expect(() => readIdentityPassphrase({ RECUED_IDENTITY_PASSPHRASE_FILE: secretFile(bigEndian) }))
      .toThrow(/is not plain UTF-8 text/);
    expect(() => readIdentityPassphrase({ RECUED_IDENTITY_PASSPHRASE_FILE: secretFile(Buffer.from('p\0w')) }))
      .toThrow(/is not plain UTF-8 text/);
  });

  it('throws, never answers "none", when a named file yields nothing', () => {
    // Each of these would otherwise read as "no passphrase", which on a first boot means an
    // unsealed key file, for someone who named a file precisely to seal it.
    const missing = join(dir, 'not-there');
    expect(() => readIdentityPassphrase({ RECUED_IDENTITY_PASSPHRASE_FILE: missing }))
      .toThrow(new RegExp(`${missing}.*cannot be read \\(ENOENT\\)`));
    expect(() => readIdentityPassphrase({ RECUED_IDENTITY_PASSPHRASE_FILE: secretFile('\n') }))
      .toThrow(/is empty/);
    expect(() => readIdentityPassphrase({
      RECUED_IDENTITY_PASSPHRASE: 'p', RECUED_IDENTITY_PASSPHRASE_FILE: secretFile('p'),
    })).toThrow(/Both RECUED_IDENTITY_PASSPHRASE and RECUED_IDENTITY_PASSPHRASE_FILE are set/);
  });
});

describe('runningInContainer', () => {
  const nothing = (): boolean => false;
  it('sees our images, any container manager, and nothing on a plain host', () => {
    expect(runningInContainer({ RECUED_SUPERVISOR_MODE: 'docker' }, nothing)).toBe(true);
    expect(runningInContainer({ RECUED_SUPERVISOR_MODE: 'docker-thin' }, nothing)).toBe(true);
    expect(runningInContainer({ container: 'podman' }, nothing)).toBe(true);
    expect(runningInContainer({}, (p) => p === '/.dockerenv')).toBe(true);
    expect(runningInContainer({}, (p) => p === '/run/.containerenv')).toBe(true);
    expect(runningInContainer({}, nothing)).toBe(false);
  });

  it('is not fooled by the update channel tests set on the host', () => {
    // `RECUED_DISTRIBUTION_CHANNEL=docker-thin` gives a test boot its own update lease. Keyed on
    // the channel, every such boot would refuse to start.
    expect(runningInContainer({ RECUED_DISTRIBUTION_CHANNEL: 'docker-thin' }, nothing)).toBe(false);
  });
});

describe('a container never creates its key file unsealed', () => {
  const REFUSAL = 'refused: no passphrase in a container';
  // Under vitest no platform store is available (`keys/machine-secret.ts`), which is exactly the
  // container's situation: with no passphrase the store would choose UNSEALED.
  const boot = (env: NodeJS.ProcessEnv, refuse: boolean) => bootServerIdentity({
    dbPath: join(dir, 'recued.db'),
    machineSealing: true,
    ...(refuse ? { refuseUnsealed: REFUSAL } : {}),
    env,
    argon2_params: FAST_ARGON2,
  });

  it('refuses the first boot without a passphrase, and writes no key file', async () => {
    await expect(boot({}, true)).rejects.toThrow(REFUSAL);
    expect(existsSync(resolveIdentityKeysPath(join(dir, 'recued.db')))).toBe(false);
  });

  it('seals with a passphrase from a file, and reopens only with it', async () => {
    const env = { RECUED_IDENTITY_PASSPHRASE_FILE: secretFile('a long passphrase\n') };
    const first = await boot(env, true);
    const doc = JSON.parse(readFileSync(first.filePath, 'utf8')) as { encrypted?: boolean };
    expect(doc.encrypted).toBe(true);
    const fingerprint = first.identity.serverIdentityKey().public_key_fingerprint;

    const again = await boot(env, true);
    expect(again.identity.serverIdentityKey().public_key_fingerprint).toBe(fingerprint);
    // Same value through the variable opens it too: the file is a source, not a different seal.
    const viaVariable = await boot({ RECUED_IDENTITY_PASSPHRASE: 'a long passphrase' }, true);
    expect(viaVariable.identity.serverIdentityKey().public_key_fingerprint).toBe(fingerprint);
    await expect(boot({}, true)).rejects.toThrow(/RECUED_IDENTITY_PASSPHRASE is not set/);
  });

  it('never refuses a key file that already exists', async () => {
    await boot({}, false);   // created unsealed, outside the rule
    await expect(boot({}, true)).resolves.toBeDefined();
  });

  it('refuses a caller that skips machine sealing the same way (recovery, an offline restore)', async () => {
    const filePath = join(dir, 'direct.json');
    await expect(createFileServerKeyStore({ filePath, refuseUnsealed: REFUSAL })).rejects.toThrow(REFUSAL);
    expect(existsSync(filePath)).toBe(false);
    // An existing file is never refused: a boot outside the rule writes one, then it opens under it.
    await boot({}, false);
    await expect(createFileServerKeyStore({
      filePath: resolveIdentityKeysPath(join(dir, 'recued.db')), refuseUnsealed: REFUSAL,
    })).resolves.toBeDefined();
  });

  it('outside a container, an unsealed first boot still only warns', async () => {
    const booted = await boot({}, false);
    expect(existsSync(booted.filePath)).toBe(true);
  });
});
