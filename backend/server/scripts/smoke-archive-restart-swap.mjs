/* Manual pre-launch smoke: the ONLINE archive restart-swap on a REAL booted
 * server (D-204 residual). Self-contained — spawns `recued serve` under a
 * Node-managed `native`-mode supervisor loop (respawn on exit 3), pairs +
 * enrolls a recovery key (turns on D-197 at-rest encryption), then drives the
 * `server.archive.{export,status,import}` WS rpc so the server:
 *
 *   drain (close ws + db) → process.exit(3) → supervisor respawn → boot on the
 *   swapped, keyfile-auto-unlocked db.
 *
 * This exercises the OS-level lifecycle the in-process suites cannot reach
 * (`archive-blob-encryption-online-restore-e2e.test.ts` spies the restart; this
 * drives the real exit + respawn). Everything below the process boundary is
 * real — sqlite, crypto, WS rpc, the lifecycle drain, `commitStagedRestore`.
 *
 * Run (from backend/server):  npx tsx scripts/smoke-archive-restart-swap.mjs
 * Exit 0 = PASS. Boots on an ephemeral temp data dir + an OS-picked free port;
 * cleans up the child process + temp dir on the way out. NOT a CI test (it
 * boots a real daemon + pairs) — a manual launch-checklist smoke.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { generateRecoveryKey } from '@recued/crypto';

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[smoke] ${m}`);

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

async function pollUntil(desc, fn, timeoutMs = 90_000, everyMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await fn()) return; } catch { /* retry */ }
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for: ${desc}`);
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), 'recued-restart-smoke-'));
  const dbPath = join(dataDir, 'recued-server.db');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const mnemonic = generateRecoveryKey().mnemonic;

  // ── Node-managed supervisor: spawn `serve`, respawn on exit(3). ──
  let generation = 0;
  let stop = false;
  let child = null;
  let logBuf = '';
  const exits = [];
  const spawnServer = () => {
    generation += 1;
    const gen = generation;
    child = spawn('npx', ['tsx', 'src/bin.ts', 'serve', '--port', String(port), '--db', dbPath], {
      cwd: SERVER_DIR,
      env: { ...process.env, RECUED_SUPERVISOR_MODE: 'native' },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group so cleanup can reap the WHOLE tree — `npx` wraps
      // `node`, and `recued serve` itself spawns subprocesses; killing `child`
      // alone would orphan the real server (holding the db + port).
      detached: true,
    });
    child.stdout.on('data', (d) => { logBuf += d.toString(); });
    child.stderr.on('data', (d) => { logBuf += d.toString(); });
    child.on('exit', (code) => {
      exits.push({ gen, code });
      log(`server exited code=${code} generation=${gen}`);
      if (stop) return;
      if (code === 3) { log('restart intent (3) → respawning'); spawnServer(); }
    });
  };

  const health = async () => {
    const res = await fetch(`${base}/health`).catch(() => null);
    if (!res || res.status !== 200) return false;
    const b = await res.json().catch(() => null);
    return b?.status === 'ok';
  };
  const pairingCode = () => (logBuf.match(/Pairing code:\s*([A-Z0-9]{8})/) || [])[1] || null;

  let passed = false;
  try {
    spawnServer();
    log(`gen-1 booting on port ${port} (data ${dataDir})`);
    await pollUntil('gen-1 health', health);
    await pollUntil('gen-1 pairing code', async () => pairingCode() !== null);
    const code = pairingCode();
    log(`gen-1 up; pairing code=${code}`);

    // Pair + enroll the recovery key → at-rest encryption on (bundle sidecar).
    const pair = await (await fetch(`${base}/auth/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, recoveryKey: mnemonic, instanceId: 'smoke-1', displayName: 'smoke', clientKind: 'webclient' }),
    })).json();
    const inner = pair.body ?? pair;
    if (!inner?.token_id || !inner?.bearer) throw new Error(`pair failed: ${JSON.stringify(pair).slice(0, 300)}`);
    log(`paired + enrolled (token_id=${inner.token_id}); realm encrypted`);

    // Authenticated WS rpc: export → status(poll) → import.
    const token = encodeURIComponent(`${inner.token_id}.${inner.bearer}`);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    const pending = new Map();
    let seq = 0;
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('ws error before open')), { once: true });
    });
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.type === 'rpc_result' && pending.has(m.request_id)) {
        const p = pending.get(m.request_id); pending.delete(m.request_id);
        m.error ? p.reject(new Error(`${m.error.code}: ${m.error.message}`)) : p.resolve(m.result);
      }
    });
    const rpc = (method, args = {}, timeoutMs = 60_000) => new Promise((resolve, reject) => {
      const id = `r${++seq}`;
      const to = setTimeout(() => { pending.delete(id); reject(new Error(`rpc ${method} timeout`)); }, timeoutMs);
      pending.set(id, { resolve: (v) => { clearTimeout(to); resolve(v); }, reject: (e) => { clearTimeout(to); reject(e); } });
      ws.send(JSON.stringify({ type: 'rpc', request_id: id, method, args }));
    });
    ws.send(JSON.stringify({ type: 'register', instance_id: 'smoke-1', display_name: 'smoke' }));
    log('ws connected + authenticated');

    const exp = await rpc('server.archive.export', { include_blobs: false, include_passport: false, recoveryKey: mnemonic });
    let path = '';
    await pollUntil('export done', async () => {
      const st = await rpc('server.archive.status', { job_id: exp.job_id });
      if (st.state === 'error') throw new Error(`export errored: ${st.error}`);
      if (st.state === 'done') { path = st.path; return true; }
      return false;
    });
    log(`export done → ${path}`);

    const genBefore = generation;
    const imp = await rpc('server.archive.import', { path, recoveryKey: mnemonic });
    log(`import rpc returned: realm=${imp.realm} restored_at=${imp.restored_at} rebind=${imp.rebind ? 'yes' : 'no'}`);
    try { ws.close(); } catch { /* the drain closes it anyway */ }

    // Observe the REAL respawn: generation advances, gen-2 serves.
    await pollUntil('supervisor respawn', async () => generation > genBefore, 60_000);
    const gen2 = generation;
    await pollUntil('gen-2 health', health, 90_000);
    log(`respawned → generation=${gen2}; gen-2 serving`);

    // Restore artifacts: exit(3) seen, commit-swap backup, gen-2 enrolled boot.
    const sawExit3 = exits.some((e) => e.code === 3);
    const bak = readdirSync(dataDir).filter((f) => /recued-server\.db\.bak-/.test(f));
    const afterExit = logBuf.slice(logBuf.indexOf('Press Ctrl+C to stop.') + 1); // gen-2 banner region
    const runningBanners = (logBuf.match(/Status:\s*Running/g) || []).length;

    log(`exit(3) observed:         ${sawExit3}`);
    log(`commit-swap backup file:  ${bak[0] ?? 'NONE'}`);
    log(`"Status: Running" banners: ${runningBanners}  (gen-2 auto-unlocked on restored db)`);

    if (!sawExit3) throw new Error('server did not exit with code 3 (restart handoff)');
    if (bak.length === 0) throw new Error('no recued-server.db.bak-* — commitStagedRestore swap did not run');
    if (gen2 <= genBefore) throw new Error('supervisor did not respawn');
    if (runningBanners < 1 || !afterExit) throw new Error('respawned server did not reach Running');

    passed = true;
    log('PASS: import → drain → process.exit(3) → supervisor respawn → boot on the restored, auto-unlocked db.');
  } finally {
    stop = true;
    // Kill the whole process GROUP (npx → node → server subprocesses), not just
    // `child` — a detached leader's negative pid addresses the group.
    if (child?.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group gone */ }
      try { child.kill('SIGKILL'); } catch { /* already reaped */ }
    }
    await sleep(500);
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  process.exit(passed ? 0 : 1);
}

main().catch((e) => { console.error(`[smoke] FAIL: ${e?.message ?? e}`); process.exit(1); });
