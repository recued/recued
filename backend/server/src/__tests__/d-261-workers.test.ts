import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { hostname } from 'node:os';
import { createPreapprovalWorkers } from '../storage/preapproval-workers.js';

describe('D-261 durable process ownership', () => {
  it('requires a registered local worker and never treats an old heartbeat as proof of death', () => {
    const db = new Database(':memory:');
    try {
      const first = createPreapprovalWorkers(db);
      const second = createPreapprovalWorkers(db);
      first.assertCurrent(first.worker_id);
      expect(() => first.assertCurrent(second.worker_id)).toThrow(/does not own/);
      db.prepare('UPDATE preapproval_workers SET heartbeat_at = 0').run();
      expect(second.status(first.worker_id)).toBe('live');
      expect(second.status('unregistered')).toBe('unknown');
      db.prepare('UPDATE preapproval_workers SET host = ? WHERE worker_id = ?').run(`${hostname()}-other`, first.worker_id);
      expect(second.status(first.worker_id)).toBe('unknown');
    } finally { db.close(); }
  });

  it('recognizes a process that actually exited, while preserving a running process', async () => {
    const db = new Database(':memory:');
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready"); process.stdin.resume()']);
    try {
      await once(child.stdout, 'data');
      const workers = createPreapprovalWorkers(db);
      db.prepare('INSERT INTO preapproval_workers VALUES(?, ?, ?, ?, ?, ?)')
        .run('prior-boot-worker', hostname(), child.pid!, 'prior-boot', 0, 0);
      expect(workers.status('prior-boot-worker')).toBe('live');
      const exited = once(child, 'exit');
      child.stdin.end();
      await exited;
      expect(workers.status('prior-boot-worker')).toBe('gone');
    } finally { child.kill(); db.close(); }
  });
});
