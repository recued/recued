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

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, copyFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

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
else say('x64: SKIPPED — pass --node-x64 <darwin-x64 node> to include macos-x64');

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
  const smokeDb = join(tmpdir(), `recued-${t.triple}-smoke-${process.pid}.db`);
  say(`  boot smoke on port ${SMOKE_PORT} …`);
  const smoke = await new Promise((done) => {
    const child = spawn(join(BIN_DIR, exeName), ['serve', '--db', smokeDb, '--port', String(SMOKE_PORT)],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const finish = (ok, why) => { try { child.kill('SIGTERM'); } catch { /* already gone */ } done({ ok, why, out }); };
    const timer = setTimeout(() => finish(false, 'no banner within 90s'), 90_000);
    const onData = (b) => {
      out += b.toString();
      if (out.includes('Recued Server')) { clearTimeout(timer); finish(true, 'banner'); }
      if (out.includes('D178_SIDECAR_MISSING')) { clearTimeout(timer); finish(false, 'sidecar/ABI'); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => { clearTimeout(timer); finish(false, e.message); });
  });
  rmSync(smokeDb, { force: true });
  if (!smoke.ok) {
    fail(`${t.triple} boot smoke failed (${smoke.why}).\n`
      + (t.arch === 'x64' ? '  An x64 binary needs Rosetta to run on Apple Silicon.\n' : '')
      + smoke.out.slice(-1200));
  }
  say(`  boot smoke ok — starts and loads the addon ✓`);

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
say('MACOSBUILD-OK');
