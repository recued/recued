#!/usr/bin/env node
/**
 * Drive a REAL recued binary through the entire D-178 chain on Linux:
 * install -> `recued update apply` -> swap -> the outer supervisor -> auto-revert
 * -> the restored binary serving again.
 *
 * WHY THIS EXISTS. `test-install-linux.mjs` proves the INSTALLER, and its
 * "recued" is a shell script. Everything downstream of the installer -- the
 * server's manifest parser, its signature gate, staging, the swap, `recued.old`
 * preservation, the update ledger, and the supervisor's verdict -- had never run
 * against a real executable outside unit tests. The first time it did, it found
 * three things no unit test had: a manifest shape the server requires and the
 * installer does not, an apply that reported "signature verification failed" for
 * four different MISSING FIELDS, and a success message telling operators that
 * nothing would revert a bad release automatically.
 *
 * !!! IT BUILDS ITS OWN BINARY, PINNED TO A TEST KEY. The server's trust anchor
 * is compiled in, and `trusted-release-pubkey.ts` is explicit that it must never
 * come from runtime config -- so unlike install.sh (which has
 * RECUED_RELEASE_PUBKEY for staging feeds) the apply path CANNOT be aimed at a
 * local feed. The binary is therefore built from a DETACHED WORKTREE with a
 * throwaway key pinned; the only difference from a shipping binary is that one
 * constant. The worktree keeps the edit off the shared tree entirely, which
 * matters when another session may be committing.
 *
 * !!! NOT PART OF THE VITEST SUITE, DELIBERATELY. It needs Docker and builds a
 * ~140MB binary (several minutes), and a test that silently skips reads exactly
 * like a test that passes. Run it by hand before shipping a change to the update
 * chain:
 *
 *     node backend/server/scripts/test-update-swap-linux.mjs
 *     node backend/server/scripts/test-update-swap-linux.mjs --binary <dir>   # reuse a build
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = resolve(HERE, '..');
const REPO_ROOT = resolve(SERVER_DIR, '..', '..');
const INSTALL_SH = join(REPO_ROOT, 'distribution', 'install', 'install.sh');
const PAYLOAD = join(HERE, 'linux', 'update-swap-test.sh');
const PUBKEY_FILE = 'backend/server/src/update/trusted-release-pubkey.ts';

const fail = (m) => { console.error(`\n[update-swap-linux] ${m}\n`); process.exit(1); };
const say = (m) => console.log(`[update-swap-linux] ${m}`);

const argv = process.argv.slice(2);
const flagValue = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const IMAGE = flagValue('--image', 'debian:12-slim');
// ⛔ `--binary` AND `--keys` TRAVEL TOGETHER. The binary has a key PINNED AT
// BUILD TIME, so reusing a build while minting a fresh key produces a binary
// that rejects its own feed — and the failure looks like a signing bug in the
// harness rather than a mismatched pair.
const PREBUILT = flagValue('--binary', null);
const PREBUILT_KEYS = flagValue('--keys', null);
if ((PREBUILT === null) !== (PREBUILT_KEYS === null)) {
  fail('--binary and --keys must be given together (the key is pinned into the binary at build time)');
}

for (const p of [INSTALL_SH, PAYLOAD]) if (!existsSync(p)) fail(`missing ${p}`);

const run = (cmd, args, opts = {}) => new Promise((res, rej) => {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  let out = '';
  for (const s of [child.stdout, child.stderr]) {
    s.on('data', (b) => {
      const t = b.toString('utf8');
      out += t;
      for (const line of t.split('\n')) if (line.startsWith('ARM ')) console.log(`  ${line}`);
    });
  }
  child.on('error', rej);
  child.on('close', (code) => res({ code, out }));
});

if ((await run('docker', ['info'])).code !== 0) fail('docker is not available or not running');
try { execFileSync('minisign', ['-v'], { stdio: 'pipe' }); }
catch { fail('minisign is not installed (brew install minisign)'); }

const arch = process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
const work = mkdtempSync(join(tmpdir(), 'recued-swap-'));
let worktree;
try {
  // A throwaway signing identity for this run only.
  let pub;
  if (PREBUILT_KEYS) {
    for (const f of ['test.key', 'pub.txt']) {
      const from = join(PREBUILT_KEYS, f);
      if (!existsSync(from)) fail(`missing ${f} in ${PREBUILT_KEYS}`);
      execFileSync('cp', [from, join(work, f)]);
    }
    pub = readFileSync(join(work, 'pub.txt'), 'utf8').trim();
  } else {
    execFileSync('minisign', ['-G', '-W', '-f', '-p', join(work, 'test.pub'), '-s', join(work, 'test.key')],
      { stdio: 'pipe' });
    pub = readFileSync(join(work, 'test.pub'), 'utf8').split('\n')[1].trim();
    execFileSync('sh', ['-c', `printf '%s' ${JSON.stringify(pub)} > ${JSON.stringify(join(work, 'pub.txt'))}`]);
  }

  let binDir = PREBUILT;
  if (!binDir) {
    worktree = join(REPO_ROOT, '..', `recued-swaptest-wt-${process.pid}`);
    // ⛔⛔ THE WORKTREE IS AT **HEAD**, NOT YOUR WORKING TREE. That is what makes
    // the build reproducible, and it is also how someone fixes the update path,
    // runs this, watches it pass, and concludes the fix works — while the binary
    // under test never contained it. Say so loudly rather than quietly.
    const dirty = execFileSync('git', ['-C', REPO_ROOT, 'status', '--porcelain',
      '--', 'backend/', 'packages/', 'distribution/'], { encoding: 'utf8' }).trim();
    if (dirty) {
      say('!! UNCOMMITTED CHANGES ARE NOT IN THIS BUILD — it is made from HEAD:');
      for (const l of dirty.split('\n').slice(0, 10)) say(`     ${l}`);
      say('!! commit them first if you meant to test them.');
    }
    say(`building ${arch} with a test key pinned, in a detached worktree`);
    execFileSync('git', ['-C', REPO_ROOT, 'worktree', 'add', '--detach', worktree, 'HEAD'], { stdio: 'pipe' });

    const pinPath = join(worktree, PUBKEY_FILE);
    const src = readFileSync(pinPath, 'utf8');
    const m = /export const TRUSTED_RELEASE_PUBKEY = '([^']+)';/.exec(src);
    if (!m) fail(`could not find the pinned key in ${PUBKEY_FILE}`);
    execFileSync('sh', ['-c',
      `cat > ${JSON.stringify(pinPath)}`], { input: src.replace(m[1], pub) });

    // Assert the ARTIFACT, never the build's success message: a pin that did not
    // take yields a binary that rejects the whole feed, and the failure would
    // look exactly like a signing bug in the harness.
    binDir = join(work, 'bin');
    const b = await run('node', [join(worktree, 'backend/server/scripts/build-binary-docker.mjs'),
      '--platform', arch, '--out', binDir], { cwd: worktree });
    if (b.code !== 0) { console.error(b.out.slice(-3000)); fail('the binary build failed'); }
    const bytes = readFileSync(join(binDir, `recued-${arch}`), 'latin1');
    if (!bytes.includes(pub)) fail('the test key is NOT in the built binary — the pin did not take');
    say('test key confirmed present in the built binary');
  }

  for (const f of [`recued-${arch}`, `better_sqlite3-${arch}.node`]) {
    if (!existsSync(join(binDir, f))) fail(`missing ${f} in ${binDir}`);
  }

  say(`image ${IMAGE} — install, apply, swap, revert (a couple of minutes)`);
  const r = await run('docker', [
    'run', '--rm',
    // ⛔ Every server boot in the payload is inside this container, where nothing
    // but a passphrase can seal the key file, so a first boot without one is
    // refused (`CONTAINER_UNSEALED_REFUSAL`) and `restored-binary-serves` would
    // never see a banner. One throwaway value, inherited by every step.
    '-e', 'RECUED_IDENTITY_PASSPHRASE=update-swap-harness-throwaway',
    '-v', `${resolve(binDir)}:/bin-src:ro`,
    '-v', `${dirname(INSTALL_SH)}:/src:ro`,
    '-v', `${work}:/keys:ro`,
    '-v', `${PAYLOAD}:/payload.sh:ro`,
    IMAGE, 'sh', '/payload.sh',
  ]);

  const arms = [...r.out.matchAll(/^ARM (\S+) (PASS|FAIL) ?(.*)$/gm)]
    .map(([, name, verdict, detail]) => ({ name, verdict, detail: detail.trim() }));

  // An empty result is a failure, not a pass — a payload that dies before its
  // first report prints no ARM lines, and "no failures" would read as green.
  if (!r.out.includes('ARMS-DONE') || arms.length === 0) {
    console.error(r.out.slice(-4000));
    fail(`the payload did not complete (${arms.length} arm(s), ARMS-DONE ${r.out.includes('ARMS-DONE') ? 'seen' : 'MISSING'}); docker exit ${r.code}`);
  }

  console.log('');
  for (const a of arms) say(`${a.verdict === 'PASS' ? 'ok  ' : 'FAIL'} ${a.name}  ${a.detail}`);
  const failed = arms.filter((a) => a.verdict === 'FAIL');
  if (failed.length) fail(`${failed.length} of ${arms.length} arm(s) failed on ${IMAGE}`);
  say(`all ${arms.length} arms passed on ${IMAGE}`);
} finally {
  if (worktree) {
    try { execFileSync('git', ['-C', REPO_ROOT, 'worktree', 'remove', '--force', worktree], { stdio: 'pipe' }); }
    catch { console.error(`[update-swap-linux] leftover worktree: ${worktree}`); }
  }
  rmSync(work, { recursive: true, force: true });
}
