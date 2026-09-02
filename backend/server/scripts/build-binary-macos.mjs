#!/usr/bin/env node
/** D-178 S4 — the macOS leg of the release binary chain.
 *
 *  The other two triples have a host that isolates them: linux builds inside
 *  `node:24-slim`, windows builds on the ARM64 VM. macOS has neither — it
 *  builds on the machine running the release — so everything the container
 *  gave us for free has to be done explicitly here.
 *
 *  Usage (normally invoked by release.mjs step 7):
 *    node scripts/build-binary-macos.mjs --out <staging-dir> \
 *      --identity "Developer ID Application: … (TEAM)" --node <path to arm64 node> \
 *      [--node-x64 <path to darwin-x64 node of the SAME version>] [--smoke-port N]
 *
 *  ⚠ x64 IS OPT-IN AND ITS ABSENCE IS PRINTED, like windows. It needs a
 *  darwin-x64 node of the same version — `process.arch` is what decides the
 *  triple, so running the x64 node (transparently, under Rosetta) is the whole
 *  trick, exactly as an x64 node on the ARM64 Windows VM yields windows-x64.
 *
 *  ⛔ ROSETTA IS A VERIFICATION DEPENDENCY, NOT A BUILD ONE, AND IT IS SUNSETTING.
 *  Producing the artifact needs no translation: the addon comes from
 *  `npm_config_arch=x64` (measured — a real Mach-O x86_64) and postject rewrites
 *  a file rather than running it. What needs Rosetta is EXECUTING the result to
 *  smoke it. Apple carries Rosetta through macOS 26 and 27 and then narrows it,
 *  so when it goes, x64 becomes a triple this machine can build and cannot
 *  verify — and today's ABI mismatch proves an unverified triple survives
 *  signing, notarization and Gatekeeper before dying at the first query. Drop
 *  the triple rather than ship one nothing can start.
 *
 *  ⛔ THE ADDON'S ABI IS THE TRAP, AND IT IS SILENT UNTIL FIRST DB OPEN.
 *  `build-binary.mjs` embeds the node that RUNS it, while `npm ci` builds
 *  better-sqlite3 against whatever node ran npm. This repo's tooling runs node
 *  25 and the release line embeds node 24, so a straight `npm ci` + SEA build
 *  pairs a 141 addon with a 137 runtime. The binary builds, signs, notarizes
 *  and passes Gatekeeper — then dies at the first query with
 *  D178_SIDECAR_MISSING. Measured 2026-08-26, exactly that way.
 *
 *  ⛔ AND `npm rebuild` LIES ABOUT FIXING IT. It prints gyp output and
 *  "rebuilt dependencies successfully" while leaving the old binary in place
 *  when `build/Release/` is already populated — and npm resolves `node` from
 *  PATH when it spawns gyp, so even an explicit interpreter is not enough.
 *  Measured: the first rebuild reported success and produced an addon that
 *  loaded under 25 and was REFUSED by 24, the exact inverse of what was needed.
 *  ⇒ delete `build/` first, put the target node FIRST on PATH, and then ASSERT
 *  by dlopen'ing under the target node. Never trust the success string.
 *
 *  ⛔ SIGN, DO NOT NOTARIZE, HERE. Notarization took 2h53m on 2026-08-26 and
 *  is byte-neutral (the ticket lives on Apple's servers; only stapling writes
 *  to the file, and stapling a bare executable is impossible). So it does not
 *  belong on a release's critical path, and leaving it out does not violate
 *  D-178's platform-sign → notarize → minisign ordering: that invariant exists
 *  because each stage mutates what the next one signs, and this one does not.
 *  Notarize out of band; see sign-macos.mjs for the evidence.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, copyFileSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { connect } from 'node:net';
import {
  assertSourceTreeClean,
  removeNativeBuildAttestation,
  resolveSourceRevision,
  writeNativeBuildAttestation,
} from './release-native-attestation.mjs';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(PKG_ROOT, '../..');
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const say = (m) => console.log(`[build-binary-macos] ${m}`);
const fail = (m) => { console.error(`[build-binary-macos] ${m}`); process.exit(1); };

if (process.platform !== 'darwin') fail(`must run on macOS (host is ${process.platform}).`);

const OUT = resolve(flag('out', join(PKG_ROOT, 'dist/binary-docker')));
const IDENTITY = flag('identity', '');
/** The node whose ABI everything must agree on. Defaults to the one running
 *  this script, which is what a bare `node scripts/…` invocation means. */
const NODE = resolve(flag('node', process.execPath));
/** Optional darwin-x64 node of the SAME version. Its presence is what adds the
 *  macos-x64 triple; its absence is printed rather than silently assumed. */
const NODE_X64_RAW = flag('node-x64', '');
const NODE_X64 = NODE_X64_RAW ? resolve(NODE_X64_RAW) : '';
const SMOKE_PORT = Number(flag('smoke-port', '7899'));
assertSourceTreeClean({ repoRoot: REPO_ROOT });
const EXPECTED_VERSION = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')).version;
const SOURCE_REVISION = resolveSourceRevision({ repoRoot: REPO_ROOT });

/** Notarization profile — a `notarytool store-credentials` keychain profile
 *  NAME (not a credential). Also read from `RECUED_MACOS_NOTARY_PROFILE` so the
 *  release driver can pass it without putting anything on a command line.
 *
 *  ⛔ ABSENT MEANS SKIP, AND THE BUILD SAYS SO LOUDLY. Signed-but-unnotarized
 *  is exactly what shipped before: `spctl` reports
 *  `source=Unnotarized Developer ID` and Gatekeeper refuses on any path that
 *  carries a quarantine bit. A silent skip is how that happens twice, so the
 *  end-of-build banner states the status either way. */
const NOTARY_PROFILE = flag('notary-profile', process.env.RECUED_MACOS_NOTARY_PROFILE ?? '');

if (!existsSync(NODE)) fail(`no node at ${NODE}`);
if (!IDENTITY) {
  fail('--identity is required.\n'
    + '  A release binary must carry a Developer ID: ad-hoc signing produces a binary\n'
    + '  that runs locally and is refused once downloaded. Pass the identity from\n'
    + '  `security find-identity -v -p codesigning`.');
}

/** ⛔ THE WHOLE RELEASE MUST EMBED ONE NODE MAJOR, and macOS is the only triple
 *  whose runtime is whatever happens to be on the operator's PATH — linux gets
 *  it from the container image, windows from the VM. So derive the expected
 *  major from the docker image rather than restating it here: a second copy of
 *  "24" is exactly the kind of duplicated constant that goes stale in place. */
const dockerScript = readFileSync(join(PKG_ROOT, 'scripts/build-binary-docker.mjs'), 'utf8');
const imageMajor = /node:(\d+)-slim/.exec(dockerScript)?.[1];
if (!imageMajor) fail('could not read the node major from build-binary-docker.mjs — the image pin moved');

const run = (cmd, argv, cwd, extraPath, extraEnv) => {
  const env = { ...process.env, ...(extraEnv ?? {}) };
  if (extraPath) env.PATH = `${extraPath}:${env.PATH}`;
  return execFileSync(cmd, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
};

/** Describe a node we were handed: version, arch, and whether it agrees with
 *  the release line. Runs the binary, so an x64 node is translated here. */
const describeNode = (nodePath, label) => {
  if (!existsSync(nodePath)) fail(`${label}: no node at ${nodePath}`);
  let version; let arch;
  try {
    version = execFileSync(nodePath, ['-v'], { encoding: 'utf8' }).trim();
    arch = execFileSync(nodePath, ['-p', 'process.arch'], { encoding: 'utf8' }).trim();
  } catch (e) {
    fail(`${label}: could not run ${nodePath}. If this is a darwin-x64 node, Rosetta must be\n`
      + `  installed to execute it: softwareupdate --install-rosetta\n  ${(e.stderr || e.message || '').toString().trim()}`);
  }
  if (version.replace(/^v/, '').split('.')[0] !== imageMajor) {
    fail(`${label}: node ${version} does not match the release line (node ${imageMajor}, from the docker image).\n`
      + '  Every triple must embed the same major or the artifacts differ by more than architecture.');
  }
  return { path: nodePath, version, arch, triple: `macos-${arch}` };
};

const targets = [describeNode(NODE, '--node')];
if (NODE_X64) targets.push(describeNode(NODE_X64, '--node-x64'));
for (const target of targets) removeNativeBuildAttestation({ stagingDir: OUT, triple: target.triple });

/** ⚠ A MISSING TRIPLE IS A SKIP; A DIFFERENTLY-SUPPLIED ONE IS NOT. Passing an
 *  x64 node as `--node` is a legitimate way to build macos-x64 on its own —
 *  that is how it was built for 26.8.26 — and the old wording announced
 *  "x64: SKIPPED" immediately before building exactly that. The absence of a
 *  platform must be printed (a release that quietly omits one looks like a
 *  release that never supported it), but so must its PRESENCE, and neither
 *  should be inferred from which flag happened to carry the node. */
if (!targets.some((t) => t.arch === 'x64')) {
  say('x64: SKIPPED — pass --node-x64 <darwin-x64 node> to include macos-x64');
}
say(`building: ${targets.map((t) => t.triple).join(', ')}`);

// Both nodes must be the SAME version, not merely the same major: two builds
// that differ by a patch release differ by more than architecture.
if (targets.length === 2 && targets[0].version !== targets[1].version) {
  fail(`the two nodes are different versions (${targets[0].version} vs ${targets[1].version}).\n`
    + '  Install the darwin-x64 build of the SAME version.');
}
if (targets.length === 2 && targets[0].arch === targets[1].arch) {
  fail(`--node and --node-x64 are both ${targets[0].arch}. The x64 one must be a darwin-x64 build.`);
}

/** ⛔ REBUILD IN PLACE, THEN PUT IT BACK. Two failed approaches got us here and
 *  both are worth recording, because each looked right.
 *
 *  1. Rebuilding in the caller's node_modules and leaving it: correct binary,
 *     but it retargets the tree. This repo's tests run node 25 and the release
 *     line is node 24, so it leaves every peer's suite unable to load SQLite.
 *     Did exactly that on 2026-08-26 and had to restore it.
 *  2. Rebuilding an isolated COPY of the package: leaves the tree alone, and
 *     produces a binary that loads, passes every arch and ABI assertion, signs,
 *     and then CRASHES on first use —
 *         node::RemoveEnvironmentCleanupHook … Assertion failed: (env) != nullptr
 *         Statement::~Statement() [better_sqlite3.node]
 *     …because the package declares `bindings` + `prebuild-install`, both
 *     HOISTED in a real tree and absent from a bare copy. Without
 *     prebuild-install the install script falls through to `node-gyp rebuild`
 *     and compiles from source, and the source build is not what ships. Every
 *     working recued binary uses the PUBLISHED PREBUILT.
 *
 *  🔑 So the addon must be built where its own dependencies are resolvable —
 *  the same condition docker and the windows VM give it for free. Snapshot the
 *  tree's addon, rebuild in place per triple, restore in a finally. */
const addonPkg = join(REPO_ROOT, 'node_modules/better-sqlite3-multiple-ciphers');
if (!existsSync(addonPkg)) fail(`no better-sqlite3-multiple-ciphers at ${addonPkg} — run npm ci first`);
const builtAddon = join(addonPkg, 'build/Release/better_sqlite3.node');
const addonBackupDir = mkdtempSync(join(tmpdir(), 'recued-addon-backup-'));
const addonBackup = existsSync(builtAddon) ? join(addonBackupDir, 'better_sqlite3.node') : '';
if (addonBackup) copyFileSync(builtAddon, addonBackup);
const restoreAddon = () => {
  try {
    if (addonBackup) {
      mkdirSync(dirname(builtAddon), { recursive: true });
      copyFileSync(addonBackup, builtAddon);
    } else {
      rmSync(join(addonPkg, 'build'), { recursive: true, force: true });
    }
  } catch { /* best effort — the message below is what matters */ }
  rmSync(addonBackupDir, { recursive: true, force: true });
};
process.on('exit', restoreAddon);

const BIN_DIR = join(PKG_ROOT, 'dist/binary');

/** ⛔ ASSERT THE MACH-O ARCH, never the tool's success string. This is the
 *  macOS twin of the windows leg's PE-machine check, and it exists for the
 *  same reason: `npm rebuild` reports success while leaving the wrong binary
 *  in place. Measured 2026-08-26. */
const assertArch = (file, wantArch, what) => {
  const archs = execFileSync('/usr/bin/lipo', ['-archs', file], { encoding: 'utf8' }).trim();
  const want = wantArch === 'x64' ? 'x86_64' : 'arm64';
  if (archs.split(/\s+/).includes(want)) return;
  fail(`${what} is ${archs}, expected ${want} — the rebuild did not target this triple`);
};

// ── 1. the esbuild bundle build-binary.mjs consumes ─────────────────────
say('bundling (npm run build) …');
try { run('npm', ['run', 'build'], PKG_ROOT); }
catch (e) { fail(`bundle failed:\n${(e.stdout || '') + (e.stderr || '')}`); }
if (!existsSync(join(PKG_ROOT, 'dist/bin.cjs'))) fail('no dist/bin.cjs after the bundle step');

const staged = [];
for (const t of targets) {
  say(`── ${t.triple} — node ${t.version} (${t.arch}) ──`);
  const nodeBinDir = dirname(t.path);

  // ── 2. an addon whose ABI *and* arch match what we are about to embed ──
  say('  rebuilding the native addon (deleting build/ first — rebuild is a no-op otherwise) …');
  rmSync(join(addonPkg, 'build'), { recursive: true, force: true });
  try {
    run('npm', ['rebuild', 'better-sqlite3-multiple-ciphers'], REPO_ROOT, nodeBinDir,
      { npm_config_arch: t.arch, npm_config_target_arch: t.arch });
  } catch (e) { fail(`addon rebuild failed:\n${(e.stdout || '') + (e.stderr || '')}`); }
  if (!existsSync(builtAddon)) fail(`no addon at ${builtAddon} after rebuild`);
  assertArch(builtAddon, t.arch, 'the rebuilt addon');

  // dlopen under the TARGET node — the check that caught a rebuild which
  // reported success and changed nothing.
  try {
    execFileSync(t.path, ['-e', 'process.dlopen({exports:{}}, process.argv[1])', builtAddon],
      { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    fail(`the rebuilt addon does not load under ${t.version} ${t.arch}.\n`
      + '  That is the ABI mismatch this step exists to prevent — the binary would build,\n'
      + '  sign and notarize, then die at the first database open.');
  }
  say(`  addon: ${t.arch} Mach-O, loads under ${t.version} ✓`);

  // ── 3. the SEA, built BY that node (process.arch decides the triple) ───
  say('  building the SEA …');
  try { run('npm', ['run', 'build:binary'], PKG_ROOT, nodeBinDir); }
  catch (e) { fail(`SEA build failed:\n${(e.stdout || '') + (e.stderr || '')}`); }
  const exeName = `recued-${t.triple}`;
  if (!existsSync(join(BIN_DIR, exeName))) {
    fail(`no ${exeName} in ${BIN_DIR} — build-binary.mjs derived a different triple than ${t.triple}`);
  }
  assertArch(join(BIN_DIR, exeName), t.arch, exeName);

  // ── 4. the sidecar the signer and the runtime both expect ─────────────
  mkdirSync(join(BIN_DIR, 'lib'), { recursive: true });
  copyFileSync(builtAddon, join(BIN_DIR, 'lib/better_sqlite3.node'));

  // ── 5. sign BOTH, same identity — see sign-macos.mjs for why both ─────
  say('  signing …');
  try {
    execFileSync(process.execPath, [join(PKG_ROOT, 'scripts/sign-macos.mjs'),
      '--dir', BIN_DIR, '--identity', IDENTITY], { stdio: 'inherit' });
  } catch { fail('signing failed'); }

  // ── 6. boot smoke. A signed binary is not a working one ───────────────
  let reportedVersion = '';
  try {
    reportedVersion = execFileSync(join(BIN_DIR, exeName), ['--version'], { encoding: 'utf8' }).trim();
  } catch (e) {
    fail(`${t.triple}: signed binary could not execute --version:\n  ${(e.stderr || e.message || '').toString().trim()}`);
  }
  if (reportedVersion !== EXPECTED_VERSION) {
    fail(`${t.triple}: signed binary reports ${JSON.stringify(reportedVersion)}, package.json is ${EXPECTED_VERSION}`);
  }
  say(`  version smoke: ${reportedVersion} ✓`);
  const smokeDb = join(tmpdir(), `recued-${t.triple}-smoke-${process.pid}.db`);
  say(`  boot smoke on port ${SMOKE_PORT} …`);
  const smoke = await new Promise((done) => {
    const child = spawn(join(BIN_DIR, exeName), ['serve', '--db', smokeDb, '--port', String(SMOKE_PORT)],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const kill = () => { try { child.kill('SIGTERM'); } catch { /* already gone */ } };
    const finish = (ok, why) => { kill(); done({ ok, why, out }); };
    const timer = setTimeout(() => finish(false, 'no banner within 90s'), 90_000);
    const onData = (b) => {
      out += b.toString();
      // Banner reached: hand the LIVE child back so the ws probe below can talk
      // to it. Killing here is what made this smoke unable to see the defect it
      // now checks for.
      if (out.includes('Recued Server')) { clearTimeout(timer); done({ ok: true, why: 'banner', out, child, kill }); }
      if (out.includes('D178_SIDECAR_MISSING')) { clearTimeout(timer); finish(false, 'sidecar/ABI'); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => { clearTimeout(timer); finish(false, e.message); });
  });
  if (!smoke.ok) {
    rmSync(smokeDb, { force: true });
    fail(`${t.triple} boot smoke failed (${smoke.why}).\n`
      + (t.arch === 'x64' ? '  An x64 binary needs Rosetta to run on Apple Silicon.\n' : '')
      + smoke.out.slice(-1200));
  }

  // ⛔⛔ THE WEBSOCKET PROBE IS NOT OPTIONAL POLISH — IT IS THE ONE CHECK THAT
  // WOULD HAVE CAUGHT A SHIPPED, TOTALLY BROKEN RELEASE. `ws-server.ts` loaded
  // the `ws` package through a `createRequire` shadow, which the bundler cannot
  // see, so the SEA had no `ws` at runtime: `require('ws')` threw, a stub handle
  // took over, and its upgrade callback DESTROYED every socket without writing
  // a byte. The binary booted, printed a healthy banner, served `/health` 200
  // and `/webclient/` 200, answered an unknown-path upgrade with a correct 404,
  // and could not be paired to by anything. Measured 2026-08-27.
  //
  // 🔑 NO UNIT TEST CAN COVER THIS. Every suite runs from source, where
  // `node_modules/ws` is present and the require succeeds. The defect exists
  // ONLY in the artifact — so the artifact is where it has to be checked, while
  // the process is still alive and before we call the build good.
  const wsReply = await new Promise((resolve) => {
    const sock = connect(SMOKE_PORT, '127.0.0.1', () => {
      sock.write('GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\n'
        + 'Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\n'
        + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
    });
    let buf = '';
    const settle = () => { try { sock.destroy(); } catch { /* already closed */ } resolve(buf); };
    const timer = setTimeout(settle, 10_000);
    sock.on('data', (d) => { buf += d.toString(); clearTimeout(timer); settle(); });
    sock.on('close', () => { clearTimeout(timer); resolve(buf); });
    sock.on('error', () => { clearTimeout(timer); resolve(buf); });
  });
  smoke.kill();
  rmSync(smokeDb, { force: true });
  // An unauthenticated upgrade must be REFUSED with a status line (401 today).
  // What must never happen is silence: no bytes means the socket was destroyed
  // without a reply, which every client above reports as "server unreachable".
  // Two failure shapes, both fatal. EMPTY is the original defect (stub destroys
  // the socket in silence). 503 is that same dead layer after it was taught to
  // answer — still a binary whose WebSocket server never loaded, and shipping it
  // would be the identical outage with a politer symptom. A real handler refuses
  // an unauthenticated upgrade with 401.
  const statusLine = wsReply.split('\r\n')[0] ?? '';
  if (!wsReply.startsWith('HTTP/') || statusLine.includes('503')) {
    fail(`${t.triple}: the WebSocket layer is DEAD in this binary — a /ws upgrade `
      + `${wsReply.length === 0 ? 'got no reply at all' : 'was answered by the stub handle'}.\n`
      + `  Got: ${wsReply.length === 0 ? '(empty reply — socket destroyed with no response)' : JSON.stringify(statusLine)}\n`
      + '  This is what a `createRequire`-shadowed `require(\'ws\')` produces: the bundler\n'
      + '  cannot see it, the SEA has no such module, and the stub handle silently drops\n'
      + '  every upgrade. Import the package statically so the bundle carries it.');
  }
  say(`  ws upgrade answered: ${wsReply.split('\r\n')[0]} ✓`);

  // ── 6b. daemon smoke: `recued start` must produce a server `status` sees ──
  //
  // ⛔⛔ SAME DEFECT CLASS AS THE ws PROBE ABOVE, AND IT SHIPPED THE SAME WAY.
  // `daemon.ts` built its child command one way only — `npx tsx <dir>/bin.ts` —
  // which is correct from a source checkout and impossible in a SEA: there is no
  // `bin.ts` on disk, `import.meta.dirname` is not a directory, so the path fell
  // back to the process CWD and the daemon spawned somebody else's node and tsx.
  // It died on ERR_MODULE_NOT_FOUND, and `recued status` then said "stopped" —
  // accurately, which is why this looked like a status bug for weeks. On a
  // machine with no Node installed, `npx` is not even spawnable.
  //
  // 🔑 Foreground `serve` cannot see it. The whole defect lives in the step
  // where the process re-launches ITSELF, so the check has to go through
  // `start` and ask `status`, exactly as an owner would. The installer prints
  // `recued start` as the way to run in the background.
  // ⛔ ITS OWN DIRECTORY. The realm lock is `{data_path}/recued-server.lock`,
  // keyed on the DIRECTORY rather than the db file, so a daemon sharing a
  // directory with any other server — including the boot smoke above, whose
  // lock outlives a SIGTERM — is refused with "already running against this
  // data folder" and the gate reports a defect that is not there.
  const dmnDir = mkdtempSync(join(tmpdir(), `recued-${t.triple}-daemon-`));
  const dmnDb = join(dmnDir, 'daemon-smoke.db');
  const dmnPort = SMOKE_PORT + 1;
  const exePath = join(BIN_DIR, exeName);
  const runCli = (args) => spawnSync(exePath, args, { encoding: 'utf8', timeout: 90_000 });
  say(`  daemon smoke on port ${dmnPort} …`);
  const started = runCli(['start', '--db', dmnDb, '--port', String(dmnPort)]);
  const status = runCli(['status', '--db', dmnDb, '--port', String(dmnPort)]);
  // ⚠ CASE MATTERS AND IT BIT ME. The boot BANNER prints `Status:    Running`;
  // the `status` VERB prints `Status:  running`. Matching the banner's spelling
  // made this gate fail on a binary that was working correctly — a false red is
  // as expensive as a false green when it blocks a release.
  const running = /Status:\s*running/i.test(`${status.stdout ?? ''}${status.stderr ?? ''}`);
  runCli(['stop', '--db', dmnDb]);
  let dmnLog = '';
  try { dmnLog = readFileSync(join(dirname(dmnDb), 'recued-server.log'), 'utf8').slice(-1200); } catch { /* none */ }
  rmSync(dmnDir, { recursive: true, force: true });
  if (!running) {
    fail(`${t.triple}: \`recued start\` did not produce a server that \`recued status\` can see.\n`
      + `  start said: ${(started.stdout ?? '').trim() || '(nothing)'}\n`
      + `  status said: ${(status.stdout ?? '').trim().split('\n')[0] || '(nothing)'}\n`
      + (dmnLog ? `  daemon log tail:\n${dmnLog}\n` : '')
      + '  A packaged binary must re-execute ITSELF (process.execPath) to daemonize;\n'
      + '  spawning `npx tsx bin.ts` only works in a source checkout.');
  }
  say(`  daemon smoke ok — start → status: Running ✓`);

  say(`  boot smoke ok — starts, loads the addon, serves websockets, daemonizes ✓`);

  // ── 7. into the staging dir under the canonical names ─────────────────
  // release-build discovers triples by LISTING this directory, so the names
  // are the entire interface. A wrong name yields a valid manifest that simply
  // never offers this platform an update.
  mkdirSync(OUT, { recursive: true });
  const outExe = join(OUT, exeName);
  const outAddon = join(OUT, `better_sqlite3-${t.triple}.node`);
  copyFileSync(join(BIN_DIR, exeName), outExe);
  copyFileSync(join(BIN_DIR, 'lib/better_sqlite3.node'), outAddon);
  for (const f of [outExe, outAddon]) {
    try { execFileSync('/usr/bin/codesign', ['--verify', '--strict', f], { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { fail(`signature does not verify after staging ${f}:\n  ${(e.stderr || '').toString().trim()}`); }
  }
  staged.push(exeName, `better_sqlite3-${t.triple}.node`);
  say(`  staged ${t.triple} ✓`);
}

say(`staged → ${OUT}`);
for (const f of staged) say(`  ${f}`);

// ── notarize ──────────────────────────────────────────────────────────────
//
// ⛔ SIGNING IS NOT NOTARIZING, AND ONLY ONE OF THEM GATEKEEPER CHECKS. A
// Developer ID signature with the hardened runtime still assesses as
// `source=Unnotarized Developer ID`, and macOS refuses to run it on any path
// that sets a quarantine bit. Measured on the 26.8.27 artifacts before this
// step existed: both triples signed, both rejected by `spctl`.
//
// 🔑 ONE SUBMISSION FOR EVERY ARTIFACT, and it must be the FINAL bytes. A
// notarization ticket is keyed to the hash, so anything that rebuilds after
// this — another triple, a re-sign — voids it silently. That is why this runs
// last, after every triple is staged, over the staging directory itself.
//
// ⚠ DELIBERATELY NOT STAPLED. `stapler` cannot attach a ticket to a bare
// Mach-O executable (only to bundles, disk images and packages), so the ticket
// stays server-side and Gatekeeper looks it up online. See the header of
// `sign-macos.mjs` for why that is sufficient on every path recued ships
// through — `curl` sets no quarantine attribute, measured.
let notarizationProof = null;
if (!NOTARY_PROFILE) {
  say('notarize: SKIPPED — no --notary-profile / RECUED_MACOS_NOTARY_PROFILE.');
  say('  ⚠ These binaries are SIGNED but NOT NOTARIZED. `spctl` reports');
  say('    "Unnotarized Developer ID" and Gatekeeper refuses them on any path');
  say('    that sets a quarantine bit. Do not publish them like this.');
  say('  Create the profile ONCE (the key never reaches this script):');
  say('    xcrun notarytool store-credentials recued-notary \\');
  say('      --key <path to AuthKey_XXXXXXXXXX.p8> --key-id <XXXXXXXXXX> \\');
  say('      --issuer <issuer-uuid from App Store Connect > Users and Access > Keys>');
  say('  then re-run with RECUED_MACOS_NOTARY_PROFILE=recued-notary.');
} else {
  // ⚠ SUBMIT ONLY WHAT THIS SCRIPT STAGED. `OUT` is the SHARED staging dir —
  // by the time this runs it also holds the linux and windows binaries from
  // the other builders, and archiving the directory shipped ~500 MB of
  // unrelated executables to Apple's notary service on every run. Collect the
  // macOS artifacts into a temp dir and submit that.
  const subDir = mkdtempSync(join(tmpdir(), 'recued-notarize-'));
  const zip = join(subDir, 'notarize-submission.zip');
  say(`notarize: submitting ${staged.length} artifact(s) as ${basename(zip)} …`);
  // `--sequesterRsrc` keeps resource forks out of the archive; `--keepParent`
  // is deliberately NOT used — the submission is the files themselves.
  const zipSrc = mkdtempSync(join(tmpdir(), 'recued-notarize-src-'));
  for (const f of staged) copyFileSync(join(OUT, f), join(zipSrc, f));
  try {
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', zipSrc, zip], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    rmSync(subDir, { recursive: true, force: true });
    rmSync(zipSrc, { recursive: true, force: true });
    fail(`could not archive for notarization:\n  ${(e.stderr || '').toString().trim()}`);
  }
  rmSync(zipSrc, { recursive: true, force: true });
  let out = '';
  try {
    out = execFileSync('/usr/bin/xcrun', [
      'notarytool', 'submit', zip,
      '--keychain-profile', NOTARY_PROFILE,
      '--wait', '--timeout', '30m',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    rmSync(subDir, { recursive: true, force: true });
    fail('notarytool submit FAILED:\n'
      + `  ${((e.stdout || '') + (e.stderr || '')).toString().trim().slice(-1500)}\n`
      + `  If the profile name is wrong: xcrun notarytool store-credentials ${NOTARY_PROFILE}`);
  }
  rmSync(subDir, { recursive: true, force: true });
  // ⛔ ASSERT THE STATUS, NEVER THE EXIT CODE. `notarytool submit --wait`
  // exits 0 for a submission that completed and was REJECTED — the request
  // succeeded, the notarization did not. Reading the exit code would report a
  // rejected build as notarized.
  //
  // ⛔⛔ AND TAKE THE **LAST** MATCH, NOT THE FIRST. This failed a build whose
  // notarization had SUCCEEDED: `--wait` streams progress as
  // `Current status: In Progress...` long before the final `status: Accepted`,
  // so a first-match regex captured the word "In" and refused an Accepted
  // submission. The authoritative value is the last one printed.
  const statuses = [...out.matchAll(/status:\s*(\w+)/gi)].map((m) => m[1]);
  const status = statuses.length > 0 ? statuses[statuses.length - 1] : '(none)';
  if (status.toLowerCase() !== 'accepted') {
    fail(`notarization status is ${status}, not Accepted.\n`
      + `  ${out.trim().slice(-1200)}\n`
      + '  Fetch the detail: xcrun notarytool log <submission-id> --keychain-profile '
      + NOTARY_PROFILE);
  }
  const submissionId = /id:\s*([0-9a-f-]{36})/i.exec(out)?.[1];
  say(`notarize: Accepted ✓ (${submissionId ?? 'submission'})`);
  // ⛔⛔ ASK APPLE WHAT IT TICKETED; DO NOT ASK GATEKEEPER WHETHER IT HAS HEARD.
  // The question worth answering is "does a ticket exist for EXACTLY these
  // bytes" — that is what catches a re-sign or a rebuild after submission, the
  // only way an Accepted status can stop applying. `notarytool log` answers it
  // immediately and authoritatively: `ticketContents` lists one cdhash per
  // artifact, and comparing those against the cdhash on disk is a strictly
  // stronger check than the one this used to make.
  //
  // ⛔ THE OLD CHECK FAILED THE 26.8.28 BUILD ON A CORRECTLY NOTARIZED SET.
  // `codesign --test-requirement==notarized` performs an ONLINE ticket lookup,
  // and that distribution is EVENTUALLY CONSISTENT. Measured on this release:
  // Apple returned Accepted with all four cdhashes ticketed, both `.node`
  // addons satisfied the requirement within seconds, and both 140 MB binaries
  // still did not 17 minutes later — same submission, same machine, same
  // network, identical signatures (CodeDirectory v=20500, hardened runtime,
  // secure timestamp) to the 26.8.27 binaries that satisfy it today. Nothing
  // was wrong with the artifacts; the gate was reading a replica that had not
  // caught up, and failing the release closed on it.
  //
  // 🔑 So: the ticket match is the GATE, and the Gatekeeper lookup is a
  // best-effort confirmation that may lag. A build must not be blocked by a
  // read that is allowed to be stale.
  const cdhashOf = (path) => {
    const r = spawnSync('/usr/bin/codesign', ['-dvvv', path], { encoding: 'utf8' });
    return /^CDHash=([0-9a-f]+)$/mi.exec(`${r.stdout ?? ''}${r.stderr ?? ''}`)?.[1]?.toLowerCase();
  };

  let ticketed = null;
  if (submissionId) {
    const logOut = spawnSync('xcrun',
      ['notarytool', 'log', submissionId, '--keychain-profile', NOTARY_PROFILE],
      { encoding: 'utf8' });
    try {
      const doc = JSON.parse(`${logOut.stdout ?? ''}`.slice(`${logOut.stdout ?? ''}`.indexOf('{')));
      if (Array.isArray(doc.ticketContents)) {
        ticketed = new Set(doc.ticketContents.map((t) => String(t.cdhash ?? '').toLowerCase()));
      }
      if (doc.issues) say(`  notarize: Apple reported issues: ${JSON.stringify(doc.issues).slice(0, 400)}`);
    } catch { /* fall through to the lookup-only path below */ }
  }
  if (!ticketed) {
    fail('notarize: could not read the submission log, so there is no proof the ticket\n'
      + '  covers these exact bytes. Fetch it by hand:\n'
      + `    xcrun notarytool log ${submissionId ?? '<submission-id>'} --keychain-profile ${NOTARY_PROFILE}`);
  }

  for (const f of staged) {
    const path = join(OUT, f);
    const cd = cdhashOf(path);
    if (!cd) fail(`${f}: could not read a cdhash — it is not a signed Mach-O.`);
    if (!ticketed.has(cd)) {
      fail(`${f} is NOT covered by the notarization ticket (cdhash ${cd}).\n`
        + '  The ticket is keyed to the bytes, so something re-signed or rebuilt this\n'
        + '  artifact after the submission and it must not ship.');
    }
    // Best effort, and explicitly allowed to be behind. `codesign` reports on
    // STDERR and `execFileSync` returns only stdout, which is why this uses
    // `spawnSync` — reading a return value here once called every notarized
    // artifact unnotarized.
    const r = spawnSync('/usr/bin/codesign',
      ['--test-requirement==notarized', '--verify', '-vv', path],
      { encoding: 'utf8' });
    const live = r.status === 0
      && /explicit requirement satisfied/.test(`${r.stdout ?? ''}${r.stderr ?? ''}`);
    say(`  ${f}: ticketed ✓${live ? ' + Gatekeeper agrees ✓' : ' (Gatekeeper lookup has not caught up yet — expected)'}`);
  }
  notarizationProof = {
    kind: 'apple-notarization',
    status: 'accepted',
    submission_id: submissionId,
    ticket_coverage: 'passed',
  };
}

// A signed-but-unnotarized build remains useful for local diagnosis, but it
// receives no custody-admissible receipt. release-build therefore refuses it
// even if somebody overlooks the warning above and points staging at it.
if (notarizationProof === null) {
  say('receipt: SKIPPED — unnotarized macOS artifacts are diagnostic-only and cannot be published.');
} else {
  for (const target of targets) {
    writeNativeBuildAttestation({
      stagingDir: OUT,
      triple: target.triple,
      version: EXPECTED_VERSION,
      sourceRevision: SOURCE_REVISION,
      producer: 'build-binary-macos',
      platformTrust: notarizationProof,
    });
    say(`receipt: ${target.triple} exact pair + functional smoke + Apple ticket bound to ${SOURCE_REVISION.slice(0, 12)} ✓`);
  }
}

say('MACOSBUILD-OK');
