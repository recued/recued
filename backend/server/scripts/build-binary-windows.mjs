#!/usr/bin/env node
/**
 * D-178 S1 — Windows binary build, driven from the dev machine.
 *
 * The Windows counterpart to `build-binary-docker.mjs`. Node's SEA facility
 * always targets the RUNNING host, so a Windows binary needs a Windows host —
 * there is no container trick for it. What there IS: Windows-on-ARM executes
 * x64 under emulation, so ONE arm64 Windows box builds BOTH triples.
 * `build-binary.mjs` copies `process.execPath` as the SEA base and
 * `currentPlatformTriple()` reads `process.arch`, so the architecture of the
 * node driving the build is the architecture of the binary that comes out. An
 * x64 box can only produce windows-x64 — emulation runs down, not up.
 *
 * Produces the same PAIR per triple as the docker path: `recued-<triple>.exe`
 * and `better_sqlite3-<triple>.node`. The SEA cannot embed a `.node` (`dlopen`
 * needs a real path), so the addon ships beside it and both must reach the
 * release staging dir — `release-build.mjs` refuses a binary whose sidecar is
 * missing, because that pair installs cleanly and dies at the first database
 * open.
 *
 * ── Why this is an SSH driver and not a container ────────────────────────────
 * Everything the VM does lives in `scripts/windows/*.ps1`, which are readable on
 * their own. This file is the transport: stage the source, run them, bring the
 * artifacts back. The transport is where the traps are, so they are named at the
 * point that works around them rather than in a comment block up here.
 *
 * ⚠ WHAT THIS DOES NOT DO: sign. The binaries come back unsigned, and postject
 * warns "signature seems corrupted" during injection because Node's official
 * Windows build IS Authenticode-signed and injection invalidates it. That is
 * expected and is what D-178 S5 re-signing exists for. Do not ship these to a
 * channel without it.
 *
 * Config, from the environment or the repository rootdev.env`:
 *   WIN_VM_SSH_HOST  WIN_VM_SSH_PORT  WIN_VM_USER  WIN_VM_PASS
 *
 * Usage:
 *   node scripts/build-binary-windows.mjs                      # both triples, HEAD
 *   node scripts/build-binary-windows.mjs --source v26.8.2     # a tagged tree
 *   node scripts/build-binary-windows.mjs --triple windows-x64
 *   node scripts/build-binary-windows.mjs --reuse-source       # skip transfer, rebuild
 *   node scripts/build-binary-windows.mjs --out /tmp/art
 */

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = resolve(HERE, '..');
const REPO_ROOT = resolve(SERVER_DIR, '..', '..');
const PS_DIR = join(HERE, 'windows');

const TRIPLES = ['windows-x64', 'windows-arm64'];

const fail = (msg) => {
  console.error(`[build-binary-windows] ${msg}`);
  process.exit(1);
};

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes(`--${name}`);

const requested = flag('triple', 'all');
if (requested !== 'all' && !TRIPLES.includes(requested)) {
  fail(`unknown triple "${requested}" — expected one of ${TRIPLES.join(', ')}`);
}
const triples = requested === 'all' ? TRIPLES : [requested];
const SOURCE = flag('source', 'HEAD');
const OUT = resolve(flag('out', join(SERVER_DIR, 'dist', 'binary-windows')));
const REUSE = has('reuse-source');

// ── config ──────────────────────────────────────────────────────────────────
/** dev.env lives OUTSIDE the repo (the wrapper folder) so it is never in a
 *  commit. Read it only to fill gaps the environment left, so CI can supply the
 *  same names without a file. */
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
for (const [k, v] of Object.entries(VM)) {
  if (!v) fail(`WIN_VM_${k === 'pass' ? 'PASS' : k.toUpperCase()} is not set (env or dev.env)`);
}

// ── ssh ─────────────────────────────────────────────────────────────────────
/** ⛔ THE PASSWORD IS PASSED THROUGH THE ENVIRONMENT, NEVER argv. Anything on a
 *  command line is visible to every user on the machine via `ps`.
 *
 *  expect rather than a Node ssh library: it needs a pty for the password
 *  prompt, Node has no pty, and expect ships with macOS. The BUFFERED form is
 *  deliberate — `log_user 1` streaming HANGS against this sshd even though auth
 *  succeeds and the command runs, while this shape demonstrably returns.
 *
 *  `NumberOfPasswordPrompts=1` so a wrong password fails immediately instead of
 *  sitting in a retry loop until the timeout. */
const EXPECT = `#!/usr/bin/expect -f
set timeout [expr {[llength $argv] > 1 ? [lindex $argv 1] : 300}]
log_user 0
spawn ssh -p $env(WIN_VM_SSH_PORT) -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \\
          -o NumberOfPasswordPrompts=1 -o LogLevel=ERROR \\
          $env(WIN_VM_USER)@$env(WIN_VM_SSH_HOST) [lindex $argv 0]
expect {
  -re "(?i)password:" { send "$env(WIN_VM_PASS)\\r"; exp_continue }
  timeout { puts "\\[ssh] TIMEOUT"; puts $expect_out(buffer); exit 124 }
  eof
}
puts $expect_out(buffer)
`;

const tmpDir = join(SERVER_DIR, 'dist', '.winbuild');
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir, { recursive: true });
const expectPath = join(tmpDir, 'ssh.exp');
writeFileSync(expectPath, EXPECT, { mode: 0o700 });

/** ⛔ ASYNC, NOT execFileSync — THE HTTP SERVER MUST STAY ANSWERABLE.
 *
 *  The first cut used `execFileSync`, which blocks the event loop for the whole
 *  remote command. The guest's very first step is to fetch a .ps1 from the
 *  server started above, so the server could not accept the connection, the
 *  guest's `Invoke-WebRequest` hung, nothing on either side timed out, and the
 *  run sat there indefinitely. Every transfer in both directions goes over that
 *  same server, so this is not a detail — a synchronous call anywhere in this
 *  file deadlocks the whole design.
 *
 *  ⚠ SERIAL BY CONSTRUCTION, still. Parallel SSH sessions wedged this sshd hard
 *  enough to need a service restart, so callers await each step in turn; the
 *  concurrency this buys is between SSH and the HTTP server, not between SSH
 *  sessions. */
const ssh = (command, timeoutSec = 300) =>
  new Promise((res, rej) => {
    const child = spawn(expectPath, [command, String(timeoutSec)], { env: process.env });
    let out = '';
    let size = 0;
    const MAX = 64 * 1024 * 1024;
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (b) => {
        size += b.length;
        if (size <= MAX) out += b.toString('utf8');
      });
    }
    child.on('error', rej);
    child.on('close', (code) => {
      const text = out.replace(/\r/g, '');
      // expect exits 124 on its own timeout; anything non-zero means the step
      // did not complete, and the buffer is the only diagnostic there is.
      if (code !== 0) rej(new Error(`ssh step exited ${code}:\n${text.slice(-4000)}`));
      else res(text);
    });
  });

/** The remote default shell is POWERSHELL, not cmd. A `cmd /c "... & ..."` gets
 *  re-parsed by it — `&` is PowerShell's call operator and `2>nul` is not its
 *  syntax — so shipping a .ps1 and running it by path is the only reliable
 *  shape. Which is also why the real work lives in scripts/windows/. */
const runPs1 = async (name, args, timeoutSec) => {
  // ⛔ DO NOT QUOTE THESE. `powershell -File` passes arguments LITERALLY — it
  // does no quote processing, unlike -Command — so a value wrapped in '…'
  // arrives WITH the quotes attached. Measured: `-Triples 'windows-x64'` gave
  // the script the string `'windows-x64`, whose `-replace '^windows-'` then
  // matched nothing and produced `C:\node-'windows-x64\…`.
  //
  // Which means the values must be safe bare tokens. Asserted rather than
  // assumed, since the failure is a mangled path rather than a parse error.
  for (const [k, v] of Object.entries(args)) {
    if (!/^[A-Za-z0-9,._:/\\-]+$/.test(String(v))) {
      fail(`-${k} value ${JSON.stringify(String(v))} needs quoting, which \`-File\` cannot express`);
    }
  }
  const argStr = Object.entries(args).map(([k, v]) => `-${k} ${v}`).join(' ');
  return await ssh(
    `powershell -NoProfile -ExecutionPolicy Bypass -File C:\\recued-${name}.ps1 ${argStr}`,
    timeoutSec,
  );
};

// ── local http server: source out, artifacts back ───────────────────────────
/** ⛔ BIND LOOPBACK ONLY. QEMU/UTM's SLIRP maps guest 10.0.2.2 to the host's
 *  loopback, so the guest reaches this without it being on the network. Binding
 *  wider once served a `git archive` of the whole private tree, unauthenticated,
 *  to anything that could reach the host. */
const serveDir = join(tmpDir, 'serve');
mkdirSync(serveDir, { recursive: true });
mkdirSync(OUT, { recursive: true });

const startServer = () =>
  new Promise((res) => {
    const srv = createServer((req, rep) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'PUT' && url.pathname === '/upload') {
        // Flat, sanitised name: the guest supplies this string, and a traversal
        // in it would otherwise write anywhere the dev user can reach.
        const raw = url.searchParams.get('path') ?? '';
        const name = raw.replace(/[^A-Za-z0-9._/-]/g, '_').split('/').filter((s) => s && s !== '..').join('__');
        if (!name) { rep.writeHead(400).end('bad path'); return; }
        const dest = join(OUT, name);
        const ws = createWriteStream(dest);
        req.pipe(ws);
        ws.on('finish', () => rep.writeHead(200).end('ok'));
        ws.on('error', () => rep.writeHead(500).end('write failed'));
        return;
      }
      if (req.method === 'GET') {
        const f = join(serveDir, url.pathname.replace(/^\/+/, '').replace(/\.\./g, ''));
        if (!existsSync(f) || !statSync(f).isFile()) { rep.writeHead(404).end('no'); return; }
        rep.writeHead(200, { 'content-length': statSync(f).size });
        rep.end(readFileSync(f));
        return;
      }
      rep.writeHead(405).end('no');
    });
    srv.listen(0, '127.0.0.1', () => res(srv));
  });

// ── the .ps1 payloads ───────────────────────────────────────────────────────
/** ⛔ ASCII-ONLY, UTF-8 BOM. A single non-ASCII byte breaks the ANSI parse
 *  Windows applies to a downloaded .ps1, and the error points nowhere near the
 *  character. Asserted rather than trusted — an em dash in a comment cost a
 *  whole pass, and the check that would have caught it takes one line. */
const stagePs1 = (name) => {
  const src = join(PS_DIR, `${name}.ps1`);
  const text = readFileSync(src, 'utf8');
  const bad = text.split('\n').findIndex((l) => /[^\x09\x20-\x7e]/.test(l));
  if (bad >= 0) fail(`${src}:${bad + 1} contains a non-ASCII byte — Windows cannot parse it:\n  ${text.split('\n')[bad].slice(0, 100)}`);
  writeFileSync(join(serveDir, `${name}.ps1`), `\ufeff${text}`);
};

// ── go ──────────────────────────────────────────────────────────────────────
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

console.log(`[build-binary-windows] triples : ${triples.join(', ')}`);
console.log(`[build-binary-windows] source  : ${SOURCE}${REUSE ? ' (REUSING the VM tree)' : ''}`);
console.log(`[build-binary-windows] vm      : ${VM.user}@${VM.host}:${VM.port}`);
console.log(`[build-binary-windows] out     : ${OUT}`);
console.log('');

stagePs1('build');
stagePs1('smoke');

if (!REUSE) {
  // `git archive` rather than a copy: it takes exactly what is COMMITTED at the
  // ref, so the binary matches a reviewable tree and never picks up a dirty
  // working file. Building a release from an unclean tree is how a binary ends
  // up unattributable to any commit.
  console.log(`[build-binary-windows] packing ${SOURCE}…`);
  const tgz = join(serveDir, 'src.tgz');
  execFileSync('git', ['archive', '--format=tar.gz', '-o', tgz, SOURCE], { cwd: REPO_ROOT, stdio: 'inherit' });
  console.log(`[build-binary-windows]   src.tgz ${(statSync(tgz).size / 1e6).toFixed(1)} MB`);
}

const srv = await startServer();
const { port: httpPort } = srv.address();
// The guest's route back to the host's loopback under QEMU/UTM SLIRP.
const REACHBACK = process.env.WIN_VM_REACHBACK_HOST ?? '10.0.2.2';
const base = `http://${REACHBACK}:${httpPort}`;
console.log(`[build-binary-windows] serving on 127.0.0.1:${httpPort} (guest reaches ${base})`);

let failed = 0;
try {
  console.log('[build-binary-windows] staging scripts on the VM…');
  const fetches = ['build', 'smoke']
    .map((n) => `Invoke-WebRequest -Uri ${base}/${n}.ps1 -OutFile C:\\recued-${n}.ps1 -UseBasicParsing`)
    .join('; ');
  await ssh(`powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; ${fetches}; 'staged'"`, 180);

  if (!REUSE) {
    console.log('[build-binary-windows] transferring + extracting source…');
    const unpack = [
      "$ProgressPreference='SilentlyContinue'",
      `Invoke-WebRequest -Uri ${base}/src.tgz -OutFile C:\\src.tgz -UseBasicParsing`,
      'Remove-Item -Recurse -Force C:\\build -ErrorAction SilentlyContinue',
      'New-Item -ItemType Directory -Force -Path C:\\build | Out-Null',
      'tar -xzf C:\\src.tgz -C C:\\build',
      "'extracted ' + (Get-ChildItem C:\\build | Measure-Object).Count + ' top-level entries'",
    ].join('; ');
    console.log(`  ${(await ssh(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${unpack}"`, 900)).trim().split('\n').pop()}`);
  }

  console.log('[build-binary-windows] building (npm ci + bundle + per-triple SEA)…');
  // NodeVersion is deliberately NOT passed: build.ps1 reads it off the VM's own
  // node. Passing this machine's (`process.versions.node`) fetched a v25 runtime
  // for the foreign triple against a v24 host — two different ABIs, so the two
  // binaries would have embedded different Node majors and the addon built for
  // one could not load in the other.
  const buildOut = await runPs1('build', {
    Triples: triples.join(','),
    UploadTo: `${base}/upload`,
  }, 3600);
  for (const line of buildOut.split('\n')) if (line.trim()) console.log(`  ${line}`);
  if (!buildOut.includes('WINBUILD-OK')) fail('the VM build did not reach WINBUILD-OK — see above');

  console.log('');
  console.log('[build-binary-windows] boot smoke on the VM…');
  const smokeOut = await runPs1('smoke', { Triples: triples.join(',') }, 900);
  for (const line of smokeOut.split('\n')) if (line.trim()) console.log(`  ${line}`);
  if (!smokeOut.includes('SMOKE-OK')) { failed += 1; console.error('[build-binary-windows] ⛔ SMOKE FAILED — the binaries do not start'); }
} finally {
  srv.close();
}

// ── verify what actually landed ─────────────────────────────────────────────
// The upload is the last thing that can silently lose an artifact, so the pair
// is checked HERE rather than trusted from the VM's own report.
console.log('');
for (const t of triples) {
  const exe = join(OUT, `recued-${t}.exe`);
  const lib = join(OUT, `better_sqlite3-${t}.node`);
  if (!existsSync(exe) || !existsSync(lib)) {
    failed += 1;
    console.error(`[build-binary-windows] ⛔ ${t}: incomplete pair (exe:${existsSync(exe)} sidecar:${existsSync(lib)})`);
    continue;
  }
  console.log(`[build-binary-windows] ${t}`);
  console.log(`    ${statSync(exe).size} bytes  sha256 ${sha256(exe)}`);
  console.log(`    sidecar ${statSync(lib).size} bytes`);
}

console.log('');
console.log(`[build-binary-windows] artifacts in ${OUT}:`);
for (const f of readdirSync(OUT).sort()) console.log(`    ${f}`);
console.log('');
console.log('⚠ These are UNSIGNED. postject warns "signature seems corrupted" during');
console.log('   injection because Node\'s official Windows build is Authenticode-signed');
console.log('   and injection invalidates it — that is what S5 re-signing is for. Do not');
console.log('   publish to a channel until they are signed.');

process.exit(failed === 0 ? 0 : 1);
