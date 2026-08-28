#!/usr/bin/env node
/** Generate a durable, reproducible ENROLLED realm for the live drive.
 *
 *  The release gate needs a server that is already enrolled — an un-enrolled
 *  realm refuses the pairing the drive performs — and until now it borrowed one
 *  from a sibling lab repository that has no git, no schema guarantee, and a
 *  file called `seed-recovery-key.txt` that everything downstream had to treat
 *  as a secret. A gate whose fixture can be regenerated out from under it is a
 *  gate that fails for reasons unrelated to the release.
 *
 *  ⛔ THE KEY IS FIXED AND IT IS NOT A SECRET. It is the canonical BIP39
 *  all-zero-entropy test vector — `abandon` ×23 + `art` — the same
 *  DEFAULT_MNEMONIC `export-recued-archive.mts` already mints fixtures under,
 *  and a value published in the BIP39 specification itself. Nothing this seeds
 *  is private, nothing it protects is real, and writing it down here is what
 *  makes the fixture reproducible on any machine. ⚠ THE COROLLARY: a realm
 *  sealed under a published key is a TEST realm and nothing else. Never point
 *  this at a directory that holds anything you care about, and never enrol a
 *  real server with this key.
 *
 *  ⛔ SEED WITH THE BINARY UNDER TEST WHEN THERE IS ONE. Servers migrate
 *  schemas forward, never back, so a realm minted by HEAD and handed to an
 *  older release binary can be refused for reasons that have nothing to do with
 *  the defect being hunted. `--binary` makes the fixture self-consistent with
 *  the artifact it is about to exercise; without it the seed comes from source.
 *
 *  Usage:
 *    node scripts/make-e2e-seed.mjs [--out <dir>] [--binary <path>]
 *                                   [--sidecar <path>] [--force] [--port N]
 *
 *  Emits the trio the drive's harness expects:
 *    seed-test.db  seed-identity.json  seed-recovery-key.txt
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync,
  readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

import Database from 'better-sqlite3';
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const say = (m) => console.log(`[make-e2e-seed] ${m}`);
const fail = (m) => { console.error(`[make-e2e-seed] ${m}`); process.exit(1); };

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : (argv[i + 1] ?? d); };
const has = (n) => argv.includes(`--${n}`);

const OUT = resolve(flag('out', join(SERVER_DIR, 'dist', 'e2e-seed')));
/** ⛔ THE IDENTITY MUST BE SEALED BY SOMETHING THAT TRAVELS. Left to itself the
 *  server seals the keyfile with the best rung the machine offers — on macOS
 *  that is `os-keyring`, and a keyfile sealed that way is bound to the keychain
 *  entry of the machine that made it. Copy the realm anywhere else and boot
 *  dies with "sealed by 'os-keyring', which cannot produce its secret right
 *  now". A fixture that only opens on the laptop that minted it is not a
 *  fixture. `RECUED_IDENTITY_PASSPHRASE` outranks every rung, so the passphrase
 *  is what makes the seed portable — and it is written NEXT TO the seed rather
 *  than hardcoded in the harness, so a seed sealed under a different one still
 *  opens. Same disclaimer as the recovery key: published, therefore a TEST
 *  realm and nothing else. */

const PASSPHRASE_FILE = 'seed-identity-passphrase.txt';
const FIXED_IDENTITY_PASSPHRASE = 'recued-e2e-seed-passphrase';
const BINARY = flag('binary', '');
const PASSPHRASE = flag('passphrase', FIXED_IDENTITY_PASSPHRASE);
const SIDECAR = flag('sidecar', '');
const FORCE = has('force');

/** The published all-zero BIP39 vector. Derived, not pasted, so it cannot drift
 *  from what every other fixture in this repo means by "the test key". */
export const FIXED_RECOVERY_KEY = entropyToMnemonic(new Uint8Array(32), wordlist);

const TRIO = ['seed-test.db', 'seed-identity.json', 'seed-recovery-key.txt'];

const freePort = async () => new Promise((done, no) => {
  const s = createServer();
  s.on('error', no);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); });
});

/** Boot the server, wait for the banner, return everything it printed.
 *  Resolving without ever seeing `Status:` is the failure — a seed generator
 *  that cannot tell "slow" from "dead" produces a fixture nobody can trust. */
const bootOnce = async (exe, dbPath, cwd, port, timeoutMs = 120_000) => {
  const opts = {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, RECUED_IDENTITY_PASSPHRASE: PASSPHRASE },
  };
  const child = exe.kind === 'binary'
    ? spawn(exe.path, ['--db', dbPath, '--port', String(port)], opts)
    : spawn('npx', ['tsx', join(SERVER_DIR, 'src/bin.ts'), '--db', dbPath, '--port', String(port)], opts);
  let out = '';
  child.stdout.on('data', (b) => { out += String(b); });
  child.stderr.on('data', (b) => { out += String(b); });
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (/Status:/.test(out)) break;
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
  await new Promise((r) => setTimeout(r, 800));
  return out;
};

const main = async () => {
  if (!FORCE && [...TRIO, PASSPHRASE_FILE].every((f) => existsSync(join(OUT, f)))) {
    const key = readFileSync(join(OUT, 'seed-recovery-key.txt'), 'utf8').trim();
    if (key === FIXED_RECOVERY_KEY) {
      say(`reusing the seed already in ${OUT} (pass --force to regenerate)`);
      return;
    }
    say('the seed on disk was sealed under a DIFFERENT key — regenerating');
  }

  let exe = { kind: 'source' };
  if (BINARY) {
    if (!existsSync(BINARY)) fail(`--binary points at nothing: ${BINARY}`);
    exe = { kind: 'binary', path: BINARY };
  }

  const work = mkdtempSync(join(tmpdir(), 'recued-e2e-seedgen-'));
  const dbPath = join(work, 'seed-test.db');
  try {
    // The binary ships as TWO files; a copy without its addon cannot open a db.
    if (exe.kind === 'binary') {
      const staged = join(work, 'bin');
      mkdirSync(join(staged, 'lib'), { recursive: true });
      const exeName = process.platform === 'win32' ? 'recued.exe' : 'recued';
      copyFileSync(BINARY, join(staged, exeName));
      const sidecar = SIDECAR || join(dirname(BINARY), 'lib', 'better_sqlite3.node');
      const alt = join(dirname(BINARY), `better_sqlite3-${process.platform === 'darwin' ? 'macos'
        : process.platform === 'win32' ? 'windows' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}.node`);
      const from = existsSync(sidecar) ? sidecar : alt;
      if (!existsSync(from)) fail(`no native SQLite addon beside ${BINARY} — pass --sidecar`);
      copyFileSync(from, join(staged, 'lib', 'better_sqlite3.node'));
      if (process.platform !== 'win32') chmodSync(join(staged, exeName), 0o755);
      exe = { kind: 'binary', path: join(staged, exeName) };
    }

    say(`minting a realm with ${exe.kind === 'binary' ? BINARY : 'the source tree'} …`);
    const first = await bootOnce(exe, dbPath, work, await freePort());
    if (!existsSync(dbPath)) fail(`the server never created a database:\n${first.slice(-1500)}`);
    if (!existsSync(join(work, 'recued-server-identity.json'))) {
      fail(`the server never minted an identity:\n${first.slice(-1500)}`);
    }

    // Enrollment is pure db I/O — `processRecoveryKey` seals a sentinel into
    // `server_config`; the key itself is never persisted. Reusing the existing
    // enroller rather than reimplementing it keeps one definition of "enrolled".
    say('enrolling the recovery key …');
    const enrolled = spawnSync('npx', [
      'tsx', join(SERVER_DIR, 'scripts/enroll-bench-recovery-key.ts'), dbPath, FIXED_RECOVERY_KEY,
    ], { cwd: SERVER_DIR, encoding: 'utf8' });
    if (enrolled.status !== 0) {
      fail(`enrollment failed:\n${enrolled.stdout ?? ''}${enrolled.stderr ?? ''}`);
    }

    // ⛔ PROVE IT, DO NOT ASSUME IT. The whole value of this fixture is that the
    // realm comes up ENROLLED — an un-enrolled one fails the drive at pairing
    // with an error that reads like a product defect. Boot it again and require
    // the banner to say so.
    say('verifying the realm boots enrolled …');
    const second = await bootOnce(exe, dbPath, work, await freePort());
    if (!/Status:\s*Running/.test(second)) {
      fail('the realm did not boot ENROLLED after enrollment — the seed would fail '
        + `the drive at pairing, not at boot:\n${second.slice(-1500)}`);
    }

    // Fold the WAL back in so a single-file copy carries everything.
    const db = new Database(dbPath);
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();

    mkdirSync(OUT, { recursive: true });
    copyFileSync(dbPath, join(OUT, 'seed-test.db'));
    copyFileSync(join(work, 'recued-server-identity.json'), join(OUT, 'seed-identity.json'));
    writeFileSync(join(OUT, 'seed-recovery-key.txt'), `${FIXED_RECOVERY_KEY}\n`);
    writeFileSync(join(OUT, PASSPHRASE_FILE), `${PASSPHRASE}\n`);
    say(`seed written to ${OUT}`);
    say(`  ${TRIO.join('  ')}  ${PASSPHRASE_FILE}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
};

await main();
