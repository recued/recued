#!/usr/bin/env node
/**
 * Drive `distribution/install/install.sh` end to end on a REAL Linux host (a
 * container), against a locally built and locally SIGNED feed.
 *
 * WHY, GIVEN install-sh-local-feed.test.ts ALREADY EXISTS. That one runs wherever
 * the vitest suite runs, which is macOS, and macOS cannot reach:
 *   - `sha256_of`, which picks `sha256sum` on Linux and `shasum` on macOS
 *   - the entire `elif command -v systemctl` autostart tree
 *   - the root vs non-root split, and $PREFIX under /usr/local
 * The suite reported thousands of passing tests while every one of those paths
 * had never executed.
 *
 * THE ARM THAT MATTERS is root-with-a-user-bus. install.sh used to branch on
 * DBUS_SESSION_BUS_ADDRESS and call it "a desktop session", but pam_systemd sets
 * that variable for root over plain SSH on a headless server -- so root got a
 * USER unit that would die with the SSH session and never come back at boot.
 * Measured on a DigitalOcean droplet 2026-08-31 and fixed by testing `id -u`
 * first; nothing executed that fix until this file.
 *
 * !! systemd is NOT PID 1 in the container, and does not need to be. Branch
 * selection only needs `command -v systemctl`; daemon-reload and enable fail soft
 * by design. What is asserted is WHICH UNIT FILE LANDS WHERE, which is what was
 * wrong -- not that systemd accepted it.
 *
 * !!! NOT PART OF THE VITEST SUITE, DELIBERATELY -- it needs Docker, and a test
 * that silently skips reads exactly like one that passes. Run it by hand before
 * shipping a change to install.sh:
 *
 *     node backend/server/scripts/test-install-linux.mjs [--image debian:12-slim]
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const INSTALL_SH = join(REPO_ROOT, 'distribution', 'install', 'install.sh');
const PAYLOAD = join(HERE, 'linux', 'install-test.sh');

const fail = (m) => { console.error(`\n[install-sh-linux] ${m}\n`); process.exit(1); };
const say = (m) => console.log(`[install-sh-linux] ${m}`);

const argv = process.argv.slice(2);
const flagValue = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const IMAGE = flagValue('--image', 'debian:12-slim');

for (const p of [INSTALL_SH, PAYLOAD]) if (!existsSync(p)) fail(`missing ${p}`);

/** Streamed, not buffered-at-the-end: apt + five installs is a slow minute and a
 *  silent one reads as a hang. */
const run = (cmd, args) => new Promise((res, rej) => {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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

const probe = await run('docker', ['info']);
if (probe.code !== 0) fail('docker is not available or not running');

say(`image ${IMAGE}`);
say('running the arms (apt + five installs takes about a minute)');
const r = await run('docker', [
  'run', '--rm',
  '-v', `${INSTALL_SH}:/src/install.sh:ro`,
  '-v', `${PAYLOAD}:/payload.sh:ro`,
  IMAGE, 'sh', '/payload.sh',
]);

const arms = [...r.out.matchAll(/^ARM (\S+) (PASS|FAIL) ?(.*)$/gm)]
  .map(([, name, verdict, detail]) => ({ name, verdict, detail: detail.trim() }));

// !!! AN EMPTY RESULT IS A FAILURE, NOT A PASS. A payload that dies before its
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
