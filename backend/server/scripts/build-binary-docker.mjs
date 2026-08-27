#!/usr/bin/env node
/**
 * D-178 S1 — cross-platform binary build via Docker.
 *
 * `build-binary.mjs` cannot cross-compile: Node's SEA facility always targets
 * the RUNNING host, so each triple must be built on that triple. This script
 * supplies the hosts for the two linux triples from any machine with Docker —
 * on Apple Silicon, `linux/arm64` runs natively and `linux/amd64` under
 * emulation. macOS and Windows still need their own real hosts (and their own
 * platform signing); linux does not, which is why the linux channel is the one
 * that does not wait on Apple or Microsoft.
 *
 * Produces a PAIR per triple: `recued-<triple>` and its native sidecar
 * `better_sqlite3-<triple>.node`. The SEA binary cannot embed a `.node`
 * (`dlopen` needs a real path), so the addon ships beside it and
 * `open-database.ts` loads it via `createRequire`. Both come out of the SAME
 * container because the addon's ABI must match the Node embedded in the binary
 * — split them across containers or Node majors and you get a binary that
 * starts and then dies at the first database open.
 *
 * ── The footgun this is shaped around ────────────────────────────────────
 * The obvious implementation — bind-mount the repo and run `npm ci` in the
 * container — DESTROYS the host's dev environment: the install replaces
 * `better_sqlite3.node` with a linux build, and every subsequent `vitest` on
 * the host fails to load it until someone reinstalls. So the repo is mounted
 * READ-ONLY, copied to a container-local path (minus node_modules/.git/dist),
 * and only an output directory is writable.
 *
 * `npm ci --ignore-scripts` then a targeted `npm rebuild` is deliberate, not a
 * speedup: the esbuild/SEA steps need no addon at all, so the expensive
 * platform install is deferred to one package. `prebuild-install` then fetches
 * a prebuilt matching this container's ABI, so the `-slim` image needs no
 * toolchain — and a MISSING prebuild fails loudly here rather than yielding a
 * binary with nothing to load.
 *
 * Usage:
 *   node scripts/build-binary-docker.mjs                     # both linux triples
 *   node scripts/build-binary-docker.mjs --platform linux-x64
 *   node scripts/build-binary-docker.mjs --serial --out /tmp/art
 */

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = resolve(HERE, '..');
const REPO_ROOT = resolve(SERVER_DIR, '..', '..');

/** The version the built binary MUST self-report. `build.mjs` bakes it from
 *  package.json via an esbuild define, so a mismatch means the artifact came
 *  from a different tree than the one about to be signed — and a release whose
 *  servers self-report a version the manifest does not name is offered the same
 *  update forever (release.config.json's own `_note_version` warns of this). */
const EXPECTED_VERSION = JSON.parse(
  readFileSync(join(SERVER_DIR, 'package.json'), 'utf8'),
).version;

/** triple -> docker --platform value. Only linux is buildable this way. */
const TARGETS = {
  'linux-x64': 'linux/amd64',
  'linux-arm64': 'linux/arm64',
};

/** Default base image. NOT `-alpine`: the prebuilt native addons are glibc
 *  builds, and while this script skips them, the produced binary embeds a glibc
 *  Node — a musl host would need a musl build, which is a separate triple. */
const DEFAULT_IMAGE = 'node:24-slim';

const fail = (msg) => {
  console.error(`[build-binary-docker] ${msg}`);
  process.exit(1);
};

// ── Args ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : (argv[i + 1] ?? dflt);
};
const has = (name) => argv.includes(`--${name}`);

const requested = flag('platform', 'all');
const triples = requested === 'all' ? Object.keys(TARGETS) : [requested];
for (const t of triples) {
  if (!TARGETS[t]) fail(`unknown platform '${t}' — expected one of: ${Object.keys(TARGETS).join(', ')}, or 'all'`);
}
const OUT = resolve(flag('out', join(SERVER_DIR, 'dist', 'binary-docker')));
const IMAGE = flag('image', DEFAULT_IMAGE);
const SERIAL = has('serial');

// ── Preflight ───────────────────────────────────────────────────────────
try {
  execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'pipe' });
} catch {
  fail('docker is not available (is the daemon running?)');
}
if (!existsSync(join(REPO_ROOT, 'package-lock.json'))) {
  fail(`no package-lock.json at ${REPO_ROOT} — repo root misresolved, refusing to run npm ci`);
}

mkdirSync(OUT, { recursive: true });

/** The in-container build. Kept as one shell string so the whole thing is
 *  visible in one place, and `set -e` makes any step's failure the run's. */
const containerScript = [
  'set -eu',
  // Copy the source OUT of the read-only mount. tar (not cp -a) so the
  // excludes are honoured: node_modules would be the wrong architecture and
  // dist/ would let a stale host build masquerade as a fresh container one.
  'mkdir -p /build',
  'tar -C /src -cf - --exclude=node_modules --exclude=.git --exclude=dist --exclude=.claude . | tar -C /build -xf -',
  'cd /build',
  'echo "[container] npm ci (scripts skipped — the SEA step needs no native addon)"',
  'npm ci --ignore-scripts --no-audit --no-fund',
  'cd /build/backend/server',
  'echo "[container] esbuild bundle"',
  'npm run build',
  'echo "[container] SEA binary"',
  'npm run build:binary',
  // ── D-178 S1 rev 2 item 2 — the native sidecar, from THIS container ──────
  // `npm ci` above ran with --ignore-scripts, so no addon was fetched (the SEA
  // step does not need one). Fetch it now, with scripts, for exactly this
  // platform. `prebuild-install` pulls a prebuilt matching the container's Node
  // ABI; there is no compiler in the -slim image, so a missing prebuild fails
  // loudly here rather than producing a binary with no addon to load.
  //
  // ⛔ SAME CONTAINER ON PURPOSE. The addon must match the Node ABI embedded in
  // the SEA binary. Building them in different containers — or at different
  // Node majors — yields a binary that starts and then dies at the first
  // database open, which is far past where anyone is still watching the build.
  'echo "[container] native sidecar (prebuilt addon for this platform + ABI)"',
  'cd /build && npm rebuild better-sqlite3-multiple-ciphers --foreground-scripts',
  'ADDON=/build/node_modules/better-sqlite3-multiple-ciphers/build/Release/better_sqlite3.node',
  'test -f "$ADDON" || { echo "FATAL: no addon at $ADDON (no prebuild for node ABI $(node -p process.versions.modules)?)" >&2; exit 1; }',
  'node -e "console.log(\'[container] addon ABI\', process.versions.modules)"',
  'cp -v "$ADDON" "/out/better_sqlite3-$TRIPLE.node"',
  'cd /build/backend/server',
  // Hand the artifacts back through the ONLY writable mount. Named
  // explicitly, not `dist/binary/*`: the glob also drags `recued.blob` (a
  // ~17 MB build intermediate) and `sea-config.json` into what is supposed to
  // be a staging dir, and `release-publish` would then warn about unreferenced
  // files it is refusing to upload.
  'cp -v "dist/binary/recued-$TRIPLE" /out/',
  'cp -v "dist/binary/recued-$TRIPLE.sha256" /out/',
].join('\n');

const runOne = (triple) =>
  new Promise((res) => {
    const platform = TARGETS[triple];
    const args = [
      'run', '--rm',
      '--platform', platform,
      // ⛔ read-only source mount. The whole point: a container `npm ci` must
      // never be able to write the host's node_modules.
      '-v', `${REPO_ROOT}:/src:ro`,
      '-v', `${OUT}:/out`,
      // npx fetches postject at build time, so the container needs network.
      // Not hermetic — noted in the spec's item-2 follow-up.
      '-w', '/',
      '-e', `TRIPLE=${triple}`,
      IMAGE,
      'bash', '-lc', containerScript,
    ];
    console.log(`[build-binary-docker] ${triple} (${platform}) starting…`);
    const t0 = Date.now();
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const tag = (line) => `  ${triple} | ${line}`;
    let tail = '';
    const onData = (buf) => {
      const text = buf.toString();
      tail = (tail + text).slice(-4000);
      for (const line of text.split('\n')) if (line.trim()) console.log(tag(line.trimEnd()));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => {
      const secs = Math.round((Date.now() - t0) / 1000);
      res({ triple, platform, code, secs, tail });
    });
  });

/** Run the produced binary on a CLEAN image of its own platform.
 *
 *  ⛔ This exists because the first real run of this script produced a 132 MB
 *  binary, exited 0, and the artifact could not start AT ALL: Node's SEA
 *  embedder runs the blob through `embedderRunCjs`, and the bundle is ESM, so
 *  the very first line threw `Cannot use import statement outside a module`.
 *  Nothing that checks only the exit code or the file's existence sees that.
 *
 *  Deliberately a DIFFERENT image from the builder (`debian:stable-slim`, no
 *  node installed): running it under `node:24-slim` would prove nothing about a
 *  self-contained binary, since a working Node would be sitting right there.
 *
 *  ⚠ `--version` is the deepest probe available that needs no database. It
 *  proves the runtime starts and the entrypoint parses — NOT that the server
 *  runs, which additionally needs the `lib/` sidecar (item 2). */
const smokeTest = (triple, outDir) =>
  new Promise((res) => {
    const binName = `recued-${triple}`;
    const args = [
      'run', '--rm', '--platform', TARGETS[triple],
      '-v', `${outDir}:/a:ro`,
      'debian:stable-slim',
      `/a/${binName}`, '--version',
    ];
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.stderr.on('data', (b) => { out += b.toString(); });
    child.on('close', (code) => res({ code, out: out.trim() }));
  });

/** ⛔⛔ THE WEBSOCKET PROBE — WITHOUT IT, "IT RUNS" MEANS "IT PRINTED A VERSION".
 *
 *  `smokeTest` above runs `--version`, and its own comment admits that proves
 *  the runtime starts, NOT that the server works. That gap shipped: `ws-server`
 *  reached the socket library through a `createRequire()` shadow the bundler
 *  cannot see, so the SEA had no `ws` at runtime, a stub handle took over, and
 *  its upgrade callback destroyed every socket without writing a byte. The
 *  binary booted, printed a healthy banner and a pairing code, served
 *  `/health` 200 — and could not be paired to by anything. Four weeks of
 *  releases. Found 2026-08-27 by driving a signed macOS binary by hand.
 *
 *  🔑 THE ARTIFACT IS THE ONLY PLACE THE BUG EXISTS. Every unit suite runs from
 *  source, where `node_modules/ws` is present and the require succeeds. So the
 *  check has to boot the actual binary and speak to its socket.
 *
 *  Needs the sidecar at `lib/better_sqlite3.node` beside the executable — the
 *  same layout the installer creates — because the server opens its database
 *  before it listens. That is why this cannot reuse the read-only mount above. */
const wsUpgradeSmoke = async (triple, outDir, port) => {
  const stage = mkdtempSync(join(tmpdir(), `recued-wssmoke-${triple}-`));
  const name = `recued-wssmoke-${triple}-${process.pid}`;
  const cleanup = () => {
    try { execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' }); } catch { /* already gone */ }
    rmSync(stage, { recursive: true, force: true });
  };
  try {
    mkdirSync(join(stage, 'lib'), { recursive: true });
    copyFileSync(join(outDir, `recued-${triple}`), join(stage, 'recued'));
    copyFileSync(join(outDir, `better_sqlite3-${triple}.node`), join(stage, 'lib/better_sqlite3.node'));
    execFileSync('docker', [
      'run', '-d', '--rm', '--name', name, '--platform', TARGETS[triple],
      '-v', `${stage}:/opt/recued`, '-p', `127.0.0.1:${port}:${port}`, '-w', '/tmp',
      'debian:stable-slim',
      '/opt/recued/recued', 'serve', '--port', String(port),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    // Wait for the banner rather than a fixed sleep: an emulated cross-arch
    // container is several times slower than a native one.
    const deadline = Date.now() + 120_000;
    let booted = false;
    while (Date.now() < deadline) {
      let logs = '';
      try { logs = execFileSync('docker', ['logs', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch { /* container not up yet */ }
      if (logs.includes('Recued Server')) { booted = true; break; }
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!booted) return { ok: false, why: 'server never printed its banner within 120s' };

    const reply = await new Promise((resolve) => {
      const sock = connect(port, '127.0.0.1', () => {
        sock.write('GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\n'
          + 'Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\n'
          + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
      });
      let buf = '';
      const settle = () => { try { sock.destroy(); } catch { /* closed */ } resolve(buf); };
      const timer = setTimeout(settle, 15_000);
      sock.on('data', (d) => { buf += d.toString(); clearTimeout(timer); settle(); });
      sock.on('close', () => { clearTimeout(timer); resolve(buf); });
      sock.on('error', () => { clearTimeout(timer); resolve(buf); });
    });

    const statusLine = reply.split('\r\n')[0] ?? '';
    // Two fatal shapes. EMPTY is the original defect (stub destroys the socket
    // in silence); 503 is that same dead layer after it was taught to answer.
    // A live handler refuses an unauthenticated upgrade with 401.
    if (!reply.startsWith('HTTP/') || statusLine.includes('503')) {
      return {
        ok: false,
        why: reply.length === 0
          ? 'no reply at all — the socket was destroyed with no response'
          : `answered by the stub handle: ${JSON.stringify(statusLine)}`,
      };
    }
    return { ok: true, statusLine };
  } catch (e) {
    return { ok: false, why: e instanceof Error ? e.message : String(e) };
  } finally {
    cleanup();
  }
};

const sha256 = (p) =>
  new Promise((res, rej) => {
    const h = createHash('sha256');
    createReadStream(p).on('data', (c) => h.update(c)).on('end', () => res(h.digest('hex'))).on('error', rej);
  });

// ── Run ─────────────────────────────────────────────────────────────────
console.log(`[build-binary-docker] repo   : ${REPO_ROOT}`);
console.log(`[build-binary-docker] image  : ${IMAGE}`);
console.log(`[build-binary-docker] out    : ${OUT}`);
console.log(`[build-binary-docker] targets: ${triples.join(', ')}${SERIAL ? ' (serial)' : ''}`);
if (triples.includes('linux-x64') && process.arch === 'arm64') {
  console.log('[build-binary-docker] NOTE: linux-x64 runs under emulation on this host — expect it to be several times slower than linux-arm64.');
}

const results = [];
if (SERIAL) {
  for (const t of triples) results.push(await runOne(t));
} else {
  results.push(...(await Promise.all(triples.map(runOne))));
}

// ── Report ──────────────────────────────────────────────────────────────
console.log('');
let failed = 0;
for (const r of results) {
  if (r.code !== 0) {
    failed += 1;
    console.error(`[build-binary-docker] FAILED ${r.triple} (exit ${r.code}, ${r.secs}s)`);
    continue;
  }
  const binName = r.triple.startsWith('windows') ? `recued-${r.triple}.exe` : `recued-${r.triple}`;
  const p = join(OUT, binName);
  if (!existsSync(p)) {
    failed += 1;
    // A zero exit with no artifact is the dangerous outcome — it reads as
    // success to any caller that only checks the code.
    console.error(`[build-binary-docker] FAILED ${r.triple} — container exited 0 but produced no ${binName}`);
    continue;
  }
  const size = (statSync(p).size / (1024 * 1024)).toFixed(1);
  console.log(`[build-binary-docker] built ${r.triple}  ${size} MB  sha256 ${(await sha256(p)).slice(0, 16)}…  (${r.secs}s)`);

  if (has('skip-smoke')) {
    console.log(`[build-binary-docker]   smoke: SKIPPED (--skip-smoke) — "it built" is not "it runs"`);
    continue;
  }
  const smoke = await smokeTest(r.triple, OUT);
  if (smoke.code === 0) {
    // ⚠ Report the VERSION THE BINARY PRINTED, not `out[0]`. Docker writes its
    // image-pull chatter ("Unable to find image 'debian:stable-slim' locally")
    // to stderr, which lands first — so the success line used to show a pull
    // message where the reader expects the binary's own output, and there was
    // no way to tell a real run from a coincidence.
    const reported = smoke.out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^\d+\.\d+\.\d+/.test(l))
      .pop();
    if (reported !== EXPECTED_VERSION) {
      // Exit 0 only proves it STARTED. A mismatch means the artifact was built
      // from a different tree than the one about to be signed — which would
      // ship a release whose servers self-report a version the manifest does
      // not name, and are therefore offered the same update forever.
      failed += 1;
      console.error(
        `[build-binary-docker]   ⛔ smoke FAILED — binary reports `
          + `${reported ?? '(no version line)'} but package.json says ${EXPECTED_VERSION}. `
          + `Rebuild: the artifact is from a different tree.`,
      );
      continue;
    }
    console.log(`[build-binary-docker]   smoke: starts on a clean image, reports v${reported}`);

    // ⛔ AND THE ONE THAT MATTERS: does its WebSocket layer actually answer?
    // `--version` above proves the runtime starts; it cannot see a server that
    // boots healthy and silently drops every upgrade. See `wsUpgradeSmoke`.
    const wsPort = Number(flag('smoke-port', '7899'));
    const wsSmoke = await wsUpgradeSmoke(r.triple, OUT, wsPort);
    if (!wsSmoke.ok) {
      failed += 1;
      console.error(
        `[build-binary-docker]   ⛔ WEBSOCKET SMOKE FAILED — ${wsSmoke.why}\n`
        + `      The socket layer is dead in this binary. A server built from it boots,\n`
        + `      prints a pairing code, serves /health — and cannot be paired to at all.\n`
        + `      Usual cause: a package reached through a createRequire() shadow, which\n`
        + `      the bundler cannot see, so the SEA has no such module at runtime.`,
      );
      continue;
    }
    console.log(`[build-binary-docker]   ws upgrade answered: ${wsSmoke.statusLine}`);
  } else {
    failed += 1;
    console.error(`[build-binary-docker]   ⛔ smoke FAILED (exit ${smoke.code}) — the binary does not start:`);
    for (const line of smoke.out.split('\n').slice(0, 8)) console.error(`      ${line}`);
  }
}

console.log('');
console.log(`[build-binary-docker] artifacts in ${OUT}:`);
for (const f of readdirSync(OUT).sort()) console.log(`    ${f}`);

console.log('');
console.log('Each binary is paired with `better_sqlite3-<triple>.node` — its native');
console.log('sidecar, built in the SAME container so the addon ABI matches the Node');
console.log('embedded in the binary. Both must reach the release staging dir:');
console.log('`release-build.mjs` REFUSES a binary whose sidecar is missing, because');
console.log('that pair installs cleanly and then dies at the first database open.');
console.log('');
console.log('⚠ The smoke test above proves the binary STARTS. It does not open a');
console.log('   database — that needs the sidecar placed at lib/better_sqlite3.node');
console.log('   beside the executable, which is the installer\'s job (item 5).');

process.exit(failed === 0 ? 0 : 1);
