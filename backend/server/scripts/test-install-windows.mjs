#!/usr/bin/env node
/**
 * Drive `distribution/install/install.ps1` end to end on a REAL Windows host,
 * against a locally built and locally signed release feed.
 *
 * WHY THIS EXISTS. install.ps1 is the Windows half of the installer, and it once
 * shipped in a state where it could not be PARSED at all -- PS 5.1 reads a .ps1
 * file as ANSI, and an em-dash's UTF-8 bytes end in U+201D, a string delimiter.
 * Nothing caught it because the documented path (`irm | iex`) decodes UTF-8 into
 * a string first and hides the defect entirely. A test that never runs the file
 * on Windows cannot see any of that.
 *
 * WHY IT NEEDS NO RELEASE. install.ps1's feed is `RECUED_BASE_URL` and its trust
 * anchor is `RECUED_RELEASE_PUBKEY` (an override that exists for staging feeds).
 * A throwaway minisign key plus a hand-built manifest exercises the real script,
 * unmodified, including the signature gate -- which is stronger than the `sh`
 * side's default arm, because PowerShell has no `RECUED_INSECURE` env seam.
 *
 * !!! NOT PART OF THE VITEST SUITE, DELIBERATELY. It needs a Windows VM that
 * most machines do not have, and a test that silently skips reads exactly like a
 * test that passes. Run it by hand before shipping a change to install.ps1:
 *
 *     node backend/server/scripts/test-install-windows.mjs
 *
 * Config, from the environment or the repository rootdev.env` (outside the repo):
 *   WIN_VM_SSH_HOST  WIN_VM_SSH_PORT  WIN_VM_USER  WIN_VM_PASS
 *   WIN_VM_REACHBACK_HOST  (default 10.0.2.2 -- QEMU/UTM SLIRP maps it to the
 *   host's loopback; verified working on this VM 2026-08-31, with and without an
 *   ssh -R tunnel)
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import {
  copyFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = resolve(HERE, '..');
const REPO_ROOT = resolve(SERVER_DIR, '..', '..');
const INSTALL_PS1 = join(REPO_ROOT, 'distribution', 'install', 'install.ps1');
const PAYLOAD = join(HERE, 'windows', 'install-test.ps1');

const fail = (m) => { console.error(`\n[install-ps1-test] ${m}\n`); process.exit(1); };
const say = (m) => console.log(`[install-ps1-test] ${m}`);

/** dev.env lives OUTSIDE the repo (the wrapper folder) so it is never committed. */
const loadDevEnv = () => {
  const p = resolve(REPO_ROOT, '..', 'dev.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?(WIN_VM_[A-Z_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
};
loadDevEnv();

const VM = {
  host: process.env.WIN_VM_SSH_HOST,
  port: process.env.WIN_VM_SSH_PORT ?? '22',
  user: process.env.WIN_VM_USER,
  pass: process.env.WIN_VM_PASS,
};
for (const [k, v] of Object.entries(VM)) if (!v) fail(`WIN_VM_${k.toUpperCase()} is not set (env or dev.env)`);
const REACHBACK = process.env.WIN_VM_REACHBACK_HOST ?? '10.0.2.2';

/** !! ASYNC, NEVER spawnSync -- THE FEED SERVER MUST STAY ANSWERABLE.
 *  spawnSync blocks the event loop for the whole remote command, so the guest's
 *  very first Invoke-WebRequest against the server below would never be answered
 *  and nothing on either side would time out. The same mistake cost a full cycle
 *  on the `sh` side of this test and is documented in build-binary-windows.mjs. */
const run = (cmd, args, extraEnv = {}) => new Promise((res, rej) => {
  const child = spawn(cmd, args, { env: { ...process.env, ...extraEnv } });
  let out = '';
  for (const s of [child.stdout, child.stderr]) s.on('data', (b) => { out += b.toString('utf8'); });
  child.on('error', rej);
  child.on('close', (code) => res({ code, out }));
});

const sha256Bytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha256 = (p) => sha256Bytes(readFileSync(p));

// ── the feed ────────────────────────────────────────────────────────────────
const TRIPLES = ['windows-arm64', 'windows-x64'];
const work = mkdtempSync(join(tmpdir(), 'recued-ps1-feed-'));
const feedRoot = join(work, 'feed');
const fixtureRoot = join(work, 'fixtures');
mkdirSync(feedRoot, { recursive: true });
mkdirSync(fixtureRoot, { recursive: true });

say(`workspace ${work}`);

// A throwaway signing key. `-W` = no password, so nothing prompts.
const keyDir = join(work, 'key');
mkdirSync(keyDir);
const secKey = join(keyDir, 'test.key');
const pubKeyFile = join(keyDir, 'test.pub');
const minisign = async (...args) => {
  const r = await run('minisign', args);
  if (r.code !== 0) fail(`minisign ${args[0]} failed:\n${r.out}`);
  return r.out;
};

/** One feed variant. `mutate` runs against the manifest object; when it returns
 *  'after-signing' the manifest is edited AFTER the signature is made, which is
 *  the only way to test that the signature is actually checked. `webclientMode`
 *  selects a valid bundle, deliberate absence, traversal, or lying inner
 *  manifest while keeping the outer manifest and archive correctly signed. */
const buildFeed = async (name, version, mutate, webclientMode = 'good') => {
  const dir = join(feedRoot, name);
  mkdirSync(dir, { recursive: true });
  const base = `http://${REACHBACK}:${PORT}/${name}`;
  const artifacts = {};
  for (const triple of TRIPLES) {
    const bin = join(dir, `recued-${triple}`);
    const lib = join(dir, `better_sqlite3-${triple}.node`);
    // A real, executable AnyCPU PE compiled on the guest. The installer now
    // requires exact --version, self-test, update-lease and release-floor
    // behavior before it commits, so the old text-file fixture could exercise
    // only refusal. The stub implements those narrow verbs and makes self-test
    // require the installed addon path; it is not a server substitute.
    const fixtureVersion = version === '9.9.10' ? '9.9.10'
      : version === '9.9.8' ? '9.9.8'
        : version === '26.9.2' ? '26.9.2' : '9.9.9';
    copyFileSync(join(fixtureRoot, `recued-${fixtureVersion}.exe`), bin);
    writeFileSync(lib, `stub native addon ${version} ${triple}\n`);
    await minisign('-Sm', bin, '-s', secKey);
    await minisign('-Sm', lib, '-s', secKey);
    artifacts[triple] = {
      url: `${base}/recued-${triple}`,
      sha256: sha256(bin),
      sig: readFileSync(`${bin}.minisig`, 'utf8'),
    };
    artifacts[`lib-${triple}`] = {
      url: `${base}/better_sqlite3-${triple}.node`,
      sha256: sha256(lib),
      sig: readFileSync(`${lib}.minisig`, 'utf8'),
    };
  }
  if (webclientMode !== 'absent') {
    const indexBytes = Buffer.from(`<!doctype html><title>Recued ${version}</title>\n`);
    const innerIndexSha = webclientMode === 'bad-inner' ? '0'.repeat(64) : sha256Bytes(indexBytes);
    const innerBytes = Buffer.from(`${JSON.stringify({
      files: [{ path: 'index.html', sha256: innerIndexSha }],
    })}\n`);
    const archiveEntries = [
      {
        path: 'webclient-bundle-manifest.json',
        sha256: sha256Bytes(innerBytes),
        base64: innerBytes.toString('base64'),
      },
      {
        path: webclientMode === 'unsafe' ? '../escape.html' : 'index.html',
        sha256: sha256Bytes(indexBytes),
        base64: indexBytes.toString('base64'),
      },
    ];
    const webclientName = `webclient-${version}.bundle.json`;
    const webclientPath = join(dir, webclientName);
    writeFileSync(webclientPath, `${JSON.stringify({
      schema: 1,
      version,
      files: archiveEntries,
    })}\n`);
    await minisign('-Sm', webclientPath, '-s', secKey);
    artifacts.webclient = {
      url: `${base}/${webclientName}`,
      sha256: sha256(webclientPath),
      sig: readFileSync(`${webclientPath}.minisig`, 'utf8'),
    };
  }
  // ⛔ A REALISTIC MANIFEST, NOT THE MINIMUM install.ps1 HAPPENED TO READ. This
  // built `{channels:{stable:{version,artifacts}}}` and nothing else — no
  // `schema_version`, no `sequence`, no `expires_at`. The canonical parser
  // REQUIRES all three, so every fixture here was a manifest no server would
  // accept, and the installer's new manifest-level gates (replay / freshness /
  // schema) had nothing to bite on. A harness whose fixtures are shaped unlike
  // production tests the harness.
  const manifest = {
    schema_version: 1,
    sequence: 100,
    // Comfortably fresh: the freshness gate refuses a feed >7d past expiry.
    expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    min_launcher_version: 1,
    channels: {
      stable: {
        version,
        released_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        min_supported: '0.2.0',
        migration: false,
        rollout_pct: 100,
        notes_url: '',
        artifacts,
      },
    },
  };
  const when = mutate ? mutate(manifest) : null;
  const mPath = join(dir, 'manifest.json');
  writeFileSync(mPath, JSON.stringify(manifest, null, 2));
  await minisign('-Sm', mPath, '-s', secKey);
  if (when === 'after-signing') {
    manifest.channels.stable.version = '6.6.6';
    writeFileSync(mPath, JSON.stringify(manifest, null, 2));   // signature now stale
  }
  // The production installer fetches the channel path. Keep the legacy root
  // pair too because some harness diagnostics inspect a feed directory by hand,
  // but drive the real request through /stable/manifest.json exactly as release
  // publication and the Cloudflare fleet split do.
  const stableDir = join(dir, 'stable');
  mkdirSync(stableDir, { recursive: true });
  copyFileSync(mPath, join(stableDir, 'manifest.json'));
  copyFileSync(`${mPath}.minisig`, join(stableDir, 'manifest.json.minisig'));
};

// ── serve it ────────────────────────────────────────────────────────────────
/** !! BIND LOOPBACK ONLY. The guest reaches the host through SLIRP, so binding
 *  wider would expose a private tree to the network for nothing. */
const manifestRequests = [];
const srv = createServer((req, rep) => {
  if (req.method === 'PUT' && req.url?.startsWith('/__fixture/')) {
    const raw = decodeURIComponent(req.url.slice('/__fixture/'.length));
    const safe = raw.replace(/[^A-Za-z0-9._-]/g, '_');
    if (!safe) { rep.statusCode = 400; rep.end('bad fixture name'); return; }
    const dest = join(fixtureRoot, safe);
    const out = createWriteStream(dest);
    req.pipe(out);
    out.on('finish', () => { rep.statusCode = 200; rep.end('ok'); });
    out.on('error', () => { rep.statusCode = 500; rep.end('write failed'); });
    return;
  }
  if (req.method === 'GET' && req.url?.startsWith('/__src/')) {
    const safe = decodeURIComponent(req.url.slice('/__src/'.length)).replace(/[^A-Za-z0-9._-]/g, '_');
    const dest = join(fixtureRoot, safe);
    if (!safe || !existsSync(dest)) { rep.statusCode = 404; rep.end('no such source'); return; }
    rep.end(readFileSync(dest));
    return;
  }
  const requestPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  if (/\/manifest\.json(?:\.minisig)?$/.test(requestPath)) {
    manifestRequests.push(requestPath);
  }
  // Exercise the header-side byte refusal without sending 512 MiB through the
  // VM. The installer must reject this response before it asks for a signature.
  if (requestPath === '/oversize/stable/manifest.json') {
    rep.setHeader('content-length', '536870913');
    rep.setHeader('connection', 'close');
    rep.end();
    return;
  }
  const name = requestPath.replace(/^\/+/, '');
  const file = name === 'install.ps1' ? INSTALL_PS1 : join(feedRoot, name);
  if (!name || !existsSync(file) || !resolve(file).startsWith(resolve(name === 'install.ps1' ? INSTALL_PS1 : feedRoot))) {
    rep.statusCode = 404; rep.end('no such artifact'); return;
  }
  // Hold the candidate body long enough for the guest arm to plant a healthy
  // current native pair after the installer's initial read but before its late
  // lease/recheck. HEAD stays immediate, so the "downloading" progress line is
  // the deterministic signal that the GET is now parked here.
  if (req.method === 'GET' && /^latecurrent\/recued-windows-(?:arm64|x64)$/.test(name)) {
    setTimeout(() => rep.end(readFileSync(file)), 3_000);
    return;
  }
  rep.end(readFileSync(file));
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;
const BASE = `http://${REACHBACK}:${PORT}`;
say(`serving on 127.0.0.1:${PORT} (guest reaches ${BASE})`);

const sshBase = ['-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
  '-o', 'LogLevel=ERROR', '-o', 'NumberOfPasswordPrompts=1'];

/** Compile the minimum executable contract the installer itself calls. Add-Type
 * runs on the Windows guest, so this is a genuine PE that both ARM64 and x64
 * Windows can execute as an AnyCPU .NET Framework console application.
 *
 * !!! EVERY BYTE OF `source` RIDES AN EncodedCommand, which is base64 of UTF-16LE
 * -- so one line of C# costs ~2.7x its length against the ~8191-char Windows
 * command-line ceiling. A ten-line comment pushed it over and the guest answered
 * "The command line is too long." Explain things HERE, in JS, which never leaves
 * this machine. `assertFixtureFits` keeps the failure legible if it happens again.
 *
 * !!! `update-lease claim` MUST NOT CREATE --bin-dir, AND THE VERSION THAT DID
 * HID A DEFECT THAT BROKE EVERY FRESH WINDOWS INSTALL. The real payload writes
 * its lease staging file straight into --bin-dir (`acquireUpdateLease`), so an
 * absent directory is an ENOENT that `runUpdateLeaseProfile` reports as
 * LEASE_UNAVAILABLE (20). install.ps1 created $Prefix two steps AFTER the claim,
 * so on a fresh host the real binary exited 20 and the install died -- while this
 * stand-in, being MORE CAPABLE than the thing it stands in for, silently made the
 * directory and returned 0. Arm 1 installs into a prefix that does not exist and
 * was green throughout, on every run, while the shipped installer could not
 * complete a single fresh install. A double may be SIMPLER than what it replaces;
 * it may never be STRONGER. */
const compileFixture = async (version, legacyRouter = false, startFailsOnce = false) => {
  const capabilityVerbs = legacyRouter ? '' : `
    if (args.Length == 1 && args[0] == "self-test") {
      string exe = Process.GetCurrentProcess().MainModule.FileName;
      string addon = Path.Combine(Path.GetDirectoryName(exe), "lib", "better_sqlite3.node");
      return File.Exists(addon) ? 0 : 21;
    }
    if (args.Length >= 2 && args[0] == "update-lease" && args[1] == "claim") {
      string dir = Value(args, "--bin-dir");
      string pid = Value(args, "--pid");
      // No CreateDirectory here -- the real payload has no such capability.
      if (!Directory.Exists(dir)) {
        Console.Error.WriteLine("update-lease: cannot take the lease at " + Path.Combine(dir, "recued-update.lock") + ": ENOENT: no such file or directory");
        return 20;
      }
      string token = Guid.NewGuid().ToString("N");
      File.WriteAllText(Path.Combine(dir, "recued-update.lock"), "{\\\"pid\\\":" + pid + ",\\\"token\\\":\\\"" + token + "\\\"}");
      Console.WriteLine(token);
      return 0;
    }
    if (args.Length >= 2 && args[0] == "update-lease" && args[1] == "release") {
      string path = Path.Combine(Value(args, "--bin-dir"), "recued-update.lock");
      if (File.Exists(path)) File.Delete(path);
      return 0;
    }
    if (args.Length >= 2 && args[0] == "release-floor" && args[1] == "raise") {
      string dir = Value(args, "--bin-dir");
      string sequence = Value(args, "--sequence");
      File.WriteAllText(Path.Combine(dir, ".release-sequence"), sequence + Environment.NewLine);
      return 0;
    }`;
  const startBehavior = startFailsOnce ? `
    if (args.Length >= 1 && args[0] == "start") {
      string exe = Process.GetCurrentProcess().MainModule.FileName;
      string counter = Path.Combine(Path.GetDirectoryName(exe), ".start-attempts");
      int attempts = 0;
      if (File.Exists(counter)) Int32.TryParse(File.ReadAllText(counter), out attempts);
      attempts += 1;
      File.WriteAllText(counter, attempts.ToString());
      return attempts == 1 ? 1 : 0;
    }` : '';
  const source = `using System;
using System.Diagnostics;
using System.IO;

public static class RecuedInstallerFixture {
  private const string Version = "${version}";
  private static string Value(string[] args, string name) {
    for (int i = 0; i + 1 < args.Length; i++) if (args[i] == name) return args[i + 1];
    return "";
  }
  public static int Main(string[] args) {
    if (args.Length == 1 && args[0] == "--version") { Console.WriteLine(Version); return 0; }
${capabilityVerbs}
${startBehavior}
    // Legacy routers print help and return success for every unknown verb. The
    // installer must verify effects instead of treating this zero as support.
    return 0;
  }
}`;
  // !!! THE C# DOES NOT RIDE THE COMMAND LINE. It used to be interpolated into
  // this script, which is base64-of-UTF-16LE'd into one `powershell
  // -EncodedCommand` argument: the 26.9.2 fixture reached 8056 of the ~8191-char
  // Windows ceiling, so the harness was ~130 characters from breaking and a
  // ten-line comment did break it ("The command line is too long", which names
  // nothing). The guest already reaches the feed server; let it fetch the source.
  const sourceName = `fixture-${version}.cs`;
  if (!/^[\x00-\x7F]*$/.test(source)) fail(`the ${version} fixture source is not ASCII`);
  writeFileSync(join(fixtureRoot, sourceName), source, 'ascii');
  const script = `$ErrorActionPreference = 'Stop'
$srcFile = Join-Path $env:TEMP '${sourceName}'
Invoke-WebRequest ${BASE}/__src/${sourceName} -OutFile $srcFile -UseBasicParsing
$source = Get-Content -Raw $srcFile
$guestOut = Join-Path $env:TEMP 'recued-${version}.exe'
Remove-Item -Force $guestOut -ErrorAction SilentlyContinue
Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly $guestOut -OutputType ConsoleApplication
[IO.File]::AppendAllText($guestOut, '"${version}"', [Text.Encoding]::ASCII)
Invoke-WebRequest -Method Put -InFile $guestOut -Uri ${BASE}/__fixture/recued-${version}.exe -UseBasicParsing
Write-Output FIXTURE-OK`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  // `ssh host "powershell -EncodedCommand <b64>"` is one Windows command line.
  // Overflowing it fails as "The command line is too long", which names neither
  // this file nor the line that grew.
  if (encoded.length > 7600) {
    fail(`the ${version} fixture EncodedCommand is ${encoded.length} chars, over the ~8191 `
      + 'Windows command-line ceiling. Shorten the C# source (comments belong in this file, '
      + 'not in `source` -- UTF-16 + base64 makes each C# byte cost ~2.7 here).');
  }
  const result = await run('sshpass', ['-e', 'ssh', ...sshBase, '-p', VM.port,
    `${VM.user}@${VM.host}`, `powershell -NoProfile -EncodedCommand ${encoded}`], { SSHPASS: VM.pass });
  if (result.code !== 0 || !result.out.includes('FIXTURE-OK')) {
    fail(`could not compile Windows ${version} installer fixture:\n${result.out}`);
  }
};

// !!! THE DEFECT THAT SHIPPED. A .ps1 with any non-ASCII byte cannot be parsed
// by PS 5.1 when saved and run. Assert it here rather than discovering it as six
// confusing arm failures. A bare grep for [^\x00-\x7F] UNDER-REPORTS.
{
  const text = readFileSync(INSTALL_PS1, 'utf8');
  // eslint-disable-next-line no-control-regex
  const bad = [...text].filter((c) => c.charCodeAt(0) > 127);
  if (bad.length) fail(`install.ps1 has ${bad.length} non-ASCII character(s) (first: ${JSON.stringify(bad[0])}) -- PS 5.1 cannot parse it from a file`);
  say('install.ps1 is pure ASCII');
}

await minisign('-G', '-W', '-f', '-p', pubKeyFile, '-s', secKey);
const PUB = readFileSync(pubKeyFile, 'utf8').split('\n')[1]?.trim();
if (!PUB) fail('could not read the generated public key body');

say('compiling runtime-capable installer fixtures on the Windows guest');
await compileFixture('9.9.9');
await compileFixture('9.9.10');
await compileFixture('9.9.8', true);
await compileFixture('26.9.2', false, true);

await buildFeed('good', '9.9.9', null);
await buildFeed('v2', '9.9.10', null);
await buildFeed('latecurrent', '9.9.10', null);
await buildFeed('legacy', '9.9.8', null);
await buildFeed('startretry', '26.9.2', null);
await buildFeed('badsha', '9.9.9', (m) => {
  for (const t of TRIPLES) m.channels.stable.artifacts[t].sha256 = '0'.repeat(64);
});
await buildFeed('noaddon', '9.9.9', (m) => {
  for (const t of TRIPLES) delete m.channels.stable.artifacts[`lib-${t}`];
});
await buildFeed('tampered', '9.9.9', () => 'after-signing');
// ⛔ THE MANIFEST-LEVEL GATES (I-10 / I-9), which Windows enforced NONE of until
// now: a valid signature is not a fresh one. Each of these is VALIDLY SIGNED and
// must still be refused.
await buildFeed('replay', '9.9.9', (m) => { m.sequence = 1; });
await buildFeed('stale', '9.9.9', (m) => { m.expires_at = '2020-01-01T00:00:00Z'; });
await buildFeed('noseq', '9.9.9', (m) => { delete m.sequence; });
await buildFeed('newschema', '9.9.9', (m) => { m.schema_version = 99; });
// ⛔ THE LABEL AGAINST THE BYTES. The stub is written carrying "9.9.9" and its
// sha256 recorded; `mutate` then relabels the manifest 9.9.11 BEFORE signing, so
// the signature and the hash are both VALID and only the version is a lie. That
// is exactly what a staging dir of stale base binaries publishes as a `.n`
// hotfix, and every other gate here waves it through.
await buildFeed('mislabel', '9.9.9', (m) => { m.channels.stable.version = '9.9.11'; });
await buildFeed('nowebclient', '9.9.9', null, 'absent');
await buildFeed('unsafewebclient', '9.9.9', null, 'unsafe');
await buildFeed('badinnerwebclient', '9.9.9', null, 'bad-inner');
say(`feeds: ${readdirSync(feedRoot).join(', ')}`);

// ── drive the guest ─────────────────────────────────────────────────────────
const remotePs1 = `C:/Users/${VM.user}/recued-install-test.ps1`;

say('copying the payload to the guest');
const scp = await run('sshpass', ['-e', 'scp', ...sshBase, '-P', VM.port, PAYLOAD,
  `${VM.user}@${VM.host}:${remotePs1}`], { SSHPASS: VM.pass });
if (scp.code !== 0) fail(`scp failed (is sshpass installed? brew install sshpass):\n${scp.out}`);

// !! `powershell -File` passes arguments LITERALLY -- no quote processing -- so
// both values below are deliberately quote-free tokens.
const remoteCmd = `powershell -NoProfile -ExecutionPolicy Bypass -File ${remotePs1.replace(/\//g, '\\')} -Base ${BASE} -PubKey ${PUB}`;
say('running the arms on the guest');
const r = await run('sshpass', ['-e', 'ssh', ...sshBase, '-p', VM.port,
  `${VM.user}@${VM.host}`, remoteCmd], { SSHPASS: VM.pass });

srv.close();
console.log('');
console.log(r.out.trimEnd());
console.log('');

// ── verdict ─────────────────────────────────────────────────────────────────
const arms = [...r.out.matchAll(/^ARM (\S+) (PASS|FAIL) ?(.*)$/gm)]
  .map(([, name, verdict, detail]) => ({ name, verdict, detail: detail.trim() }));
const failed = arms.filter((a) => a.verdict === 'FAIL');

// !!! AN EMPTY RESULT IS A FAILURE, NOT A PASS. A payload that dies before its
// first Report prints no ARM lines at all, and "no failures" would read as green.
if (!r.out.includes('ARMS-DONE') || arms.length === 0) {
  fail(`the payload did not complete (${arms.length} arm(s) reported, ARMS-DONE ${r.out.includes('ARMS-DONE') ? 'seen' : 'MISSING'}). ssh exit ${r.code}`);
}
const flatManifestRequests = manifestRequests.filter((path) =>
  !/^\/[^/]+\/(?:stable|edge)\/manifest\.json(?:\.minisig)?$/.test(path));
if (flatManifestRequests.length > 0 || manifestRequests.length === 0) {
  fail(
    `manifest requests did not stay on per-channel paths: ${
      manifestRequests.length === 0 ? 'none observed' : flatManifestRequests.join(', ')
    }`,
  );
}
say(`all ${manifestRequests.length} manifest request(s) used a per-channel path`);
for (const a of arms) say(`${a.verdict === 'PASS' ? 'ok  ' : 'FAIL'} ${a.name}  ${a.detail}`);
rmSync(work, { recursive: true, force: true });
if (failed.length) fail(`${failed.length} of ${arms.length} arm(s) failed`);
say(`all ${arms.length} arms passed on ${VM.user}@${VM.host}:${VM.port}`);
