import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { assertRestoreDrillWorkerStopped, restoreDrillWorkerCommand, runRestoreDrillWorker, RESTORE_DRILL_WORKER_TIMEOUT_MS } from '../archive/restore-drill-worker.js';
import { createRestoreDrills } from '../archive/restore-drills.js';
import { createRestoreDrillStore, restoreDrillScratchPath } from '../archive/restore-drill-store.js';
import { createArchiveOperationGate } from '../archive/unattended-backups.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'restore-worker-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const dataPath = join(root, 'server.db.restore-drills', randomUUID()); mkdirSync(dataPath, { recursive: true, mode: 0o700 });
  const controller = new AbortController(), entropy = randomBytes(32);
  const options = { archivePath: join(dataPath, 'backup.recued.archive'), dataPath, entropy, serverVersion: '0.2.0', signal: controller.signal, onChecking: vi.fn() };
  return { root, options, controller };
};
const checks = { version: 1, server_version: '0.2.0', database_integrity: 'ok', foreign_keys: 'ok', local_boot_key: 'ok',
  database_bytes: 400, restored_blob_records: 2, referenced_blobs: 2, blob_bytes: 500 };
const scripted = (body: string) => ({ command: process.execPath, args: ['-e', `
  const fs = require('node:fs'), path = require('node:path');
  process.on('disconnect',()=>process.exit(1));
  let request;
  process.on('message',m=>{
    if(m.kind==='restore'){request=m;process.send({kind:'checking'});}
    else if(m.kind==='continue'){${body}}
  });process.send({kind:'ready'});`] });

describe('recovery worker process boundary', () => {
  it('keeps HTTP requests moving during native SQLite work and kills that work before releasing ownership', async () => {
    const h = setup(), driver = createRequire(import.meta.url).resolve('better-sqlite3-multiple-ciphers');
    for (const key of ['RECUED_IDENTITY_PASSPHRASE', 'RECUED_IDENTITY_PASSPHRASE_FILE', 'RECUED_LLM_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'OPENAI_API_KEY']) vi.stubEnv(key, 'synthetic-parent-secret');
    vi.stubEnv('NODE_OPTIONS', '--inspect=127.0.0.1:0');
    const command = scripted(`
      fs.writeFileSync(path.join(request.dataPath,'proof.json'),JSON.stringify({pid:process.pid,env:Object.keys(process.env),args:process.argv,entropy_bytes:request.entropy.length}));
      const DB=require(${JSON.stringify(driver)}),db=new DB(':memory:');
      fs.writeFileSync(path.join(request.dataPath,'busy'),'native SQL');
      db.prepare('WITH RECURSIVE x(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM x WHERE n<1000000000) SELECT sum(n) FROM x').get();
      process.exit(2);`);
    const work = runRestoreDrillWorker(h.options, { command });
    const rejected = expect(work).rejects.toMatchObject({ issue: 'stopped' });
    try {
      await vi.waitFor(() => expect(existsSync(join(h.options.dataPath, 'busy'))).toBe(true), { timeout: 5000 });
      const proof = JSON.parse(readFileSync(join(h.options.dataPath, 'proof.json'), 'utf8'));
      expect(proof.pid).not.toBe(process.pid); expect(proof.entropy_bytes).toBe(32);
      for (const key of ['RECUED_IDENTITY_PASSPHRASE', 'RECUED_IDENTITY_PASSPHRASE_FILE', 'RECUED_LLM_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'OPENAI_API_KEY', 'NODE_OPTIONS']) expect(proof.env).not.toContain(key);
      expect(proof.args).not.toContain('synthetic-parent-secret'); expect(h.options.entropy.every(byte => byte === 0)).toBe(true);
      expect(() => assertRestoreDrillWorkerStopped(h.options.dataPath)).toThrow('still running');
      const server = createServer((_req, res) => { res.end('server responds'); });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      try {
        const addr = server.address(); if (!addr || typeof addr === 'string') throw new Error('fixture did not bind');
        expect(await (await fetch(`http://127.0.0.1:${addr.port}`, { signal: AbortSignal.timeout(2000) })).text()).toBe('server responds');
      } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    } finally { h.controller.abort(); await rejected; }
    expect(() => assertRestoreDrillWorkerStopped(h.options.dataPath)).not.toThrow();
  });

  it('accepts checked evidence only after the worker exits cleanly', async () => {
    const h = setup();
    const command = scripted(`process.send({kind:'result',checks:${JSON.stringify(checks)}},()=>setTimeout(()=>process.exit(0),200));`);
    let finished = false; const run = runRestoreDrillWorker(h.options, { command }).then(result => { finished = true; return result; });
    await vi.waitFor(() => expect(h.options.onChecking).toHaveBeenCalledOnce());
    expect(finished).toBe(false); expect(() => assertRestoreDrillWorkerStopped(h.options.dataPath)).toThrow('still running');
    expect(await run).toEqual(checks); expect(existsSync(join(h.options.dataPath, 'worker.json'))).toBe(false);
  });

  for (const [name, body] of [
    ['no result', 'process.exit(0);'],
    ['result followed by nonzero exit', `process.send({kind:'result',checks:${JSON.stringify(checks)}},()=>process.exit(1));`],
    ['malformed result', `process.send({kind:'result',checks:{...${JSON.stringify(checks)},unexpected:'secret'}});`],
    ['mismatched checker version', `process.send({kind:'result',checks:{...${JSON.stringify(checks)},server_version:'0.3.0'}});`],
    ['unknown message', 'process.send({kind:"unexpected",raw:"private input"});'],
    ['duplicate result', `process.send({kind:'result',checks:${JSON.stringify(checks)}});process.send({kind:'result',checks:${JSON.stringify(checks)}});`],
    ['a closed IPC channel', 'process.disconnect();setInterval(()=>{},100);'],
  ]) it(`fails closed on ${name}`, async () => {
    const h = setup();
    await expect(runRestoreDrillWorker(h.options, { command: scripted(body), timeoutMs: 3000 })).rejects.toMatchObject({ issue: 'worker_failed' });
    expect(h.options.entropy.every(byte => byte === 0)).toBe(true);
    expect(() => assertRestoreDrillWorkerStopped(h.options.dataPath)).not.toThrow();
  });

  it('terminates a hung worker after its deadline even if it already sent a plausible result', async () => {
    const h = setup();
    await expect(runRestoreDrillWorker(h.options, { command: scripted(`process.send({kind:'result',checks:${JSON.stringify(checks)}});setInterval(()=>{},100);`), timeoutMs: 500 })).rejects.toMatchObject({ issue: 'worker_timeout' });
    expect(h.options.entropy.every(byte => byte === 0)).toBe(true); expect(() => assertRestoreDrillWorkerStopped(h.options.dataPath)).not.toThrow();
  });

  it('kills a worker if the durable progress callback fails, and never forwards its error body', async () => {
    const h = setup(); h.options.onChecking.mockImplementation(() => { throw new Error('private fixture words'); });
    await expect(runRestoreDrillWorker(h.options, { command: scripted('process.exit(2);') })).rejects.toMatchObject({ issue: 'worker_failed', message: 'worker_failed' });
  });

  it('handles a spawn failure, pre-aborted request and invalid timeout without retaining entropy', async () => {
    const h = setup();
    await expect(runRestoreDrillWorker(h.options, { command: { command: join(h.root, 'missing'), args: [] } })).rejects.toMatchObject({ issue: 'worker_failed' });
    expect(h.options.entropy.every(byte => byte === 0)).toBe(true);
    const aborted = setup(); aborted.controller.abort();
    await expect(runRestoreDrillWorker(aborted.options)).rejects.toMatchObject({ issue: 'stopped' }); expect(aborted.options.entropy.every(byte => byte === 0)).toBe(true);
    const invalid = setup(); await expect(runRestoreDrillWorker(invalid.options, { timeoutMs: RESTORE_DRILL_WORKER_TIMEOUT_MS + 1 })).rejects.toMatchObject({ issue: 'worker_failed' });
    expect(invalid.options.entropy.every(byte => byte === 0)).toBe(true);
  });

  it('uses the installed binary directly and pins the source loader without inherited Node flags', () => {
    expect(restoreDrillWorkerCommand(true)).toEqual({ command: process.execPath, args: ['restore-drill-worker'] });
    const source = restoreDrillWorkerCommand(false);
    expect(source.command).toBe(process.execPath); expect(source.args.at(-1)).toBe('restore-drill-worker');
    expect(source.args).not.toContain('--inspect'); expect(source.args).not.toContain('npx');
    expect(source.tsconfigPath).toContain('tsconfig.base.json'); expect(source.args[0]).toBe('--import');
  });

  it('keeps crash debris while its worker PID lives, then reclaims it after that process has closed', async () => {
    const h = setup(), dbPath = join(h.root, 'server.db'), id = basename(h.options.dataPath);
    const store = createRestoreDrillStore(dbPath);
    store.reserve({ operation_id: id, backup_operation_id: randomUUID(), destination_id: 'a'.repeat(64), archive_sha256: 'b'.repeat(64), archive_bytes: 4, started_at: 1, state: 'restoring' });
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: {}, stdio: 'ignore' });
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    try {
      expect(child.pid).toBeDefined(); writeFileSync(join(h.options.dataPath, 'worker.json'), JSON.stringify({ v: 1, pid: child.pid }));
      writeFileSync(join(h.options.dataPath, 'partial'), 'partial recovery data');
      const options = { dbPath, remoteBackups: {} as never, gate: createArchiveOperationGate(), serverVersion: '0.2.0' };
      const reboot = createRestoreDrills(options); cleanups.push(() => reboot.stop());
      expect(reboot.list()[0]).toMatchObject({ state: 'failed', issue: 'cleanup_failed', cleanup_pending: true });
      expect(existsSync(join(h.options.dataPath, 'partial'))).toBe(true);
      child.kill('SIGKILL'); await closed;
      const retry = createRestoreDrills(options); cleanups.push(() => retry.stop());
      expect(retry.list()[0]?.cleanup_pending).toBeUndefined(); expect(existsSync(join(restoreDrillScratchPath(dbPath), id))).toBe(false);
    } finally { child.kill('SIGKILL'); await closed; }
  });

  it('does not turn malformed ownership metadata into cleanup permission', () => {
    const h = setup(); writeFileSync(join(h.options.dataPath, 'worker.json'), JSON.stringify({ v: 1, pid: process.pid, extra: 'unknown' }));
    expect(() => assertRestoreDrillWorkerStopped(h.options.dataPath)).toThrow('Invalid recovery worker marker');
  });

  it('rejects a real worker request that does not name an operation-owned directory', async () => {
    const h = setup(), foreign = join(h.root, 'foreign'); mkdirSync(foreign); writeFileSync(join(foreign, 'keep'), 'unrelated');
    await expect(runRestoreDrillWorker({ ...h.options, dataPath: foreign, archivePath: join(foreign, 'backup.recued.archive') })).rejects.toMatchObject({ issue: 'worker_failed' });
    expect(readFileSync(join(foreign, 'keep'), 'utf8')).toBe('unrelated'); expect(h.options.entropy.every(byte => byte === 0)).toBe(true);
  });

  it('cannot start a realm from a direct CLI call without its private IPC channel', async () => {
    const h = setup(), command = restoreDrillWorkerCommand(false);
    const child = spawn(command.command, command.args, { cwd: h.options.dataPath, stdio: 'ignore',
      env: { NODE_ENV: 'production', ...(command.tsconfigPath ? { TSX_TSCONFIG_PATH: command.tsconfigPath } : {}) } });
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    expect(code).toBe(1); expect(existsSync(join(h.options.dataPath, 'realm.db'))).toBe(false);
  });

  it('survives a peer closing the channel immediately after its ready message', async () => {
    const h = setup();
    const command = { command: process.execPath, args: ['-e', "process.send({kind:'ready'},()=>{process.disconnect();});setInterval(()=>{},100);"] };
    await expect(runRestoreDrillWorker(h.options, { command, timeoutMs: 3000 })).rejects.toMatchObject({ issue: 'worker_failed' });
  });
});
