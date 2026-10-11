/** Holds a realm's write lock from ANOTHER PROCESS, the way the server and each
 *  `recued --mcp` contend for one realm file.
 *
 *  A separate process on purpose: better-sqlite3 is synchronous, so a holder on
 *  the test's own thread could never release while the code under test sits in
 *  the busy handler. */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { expect } from 'vitest';

import { openDatabase } from '../../open-database.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

/** Runs in the child: take the write lock, say so, keep it for `holdMs`, then
 *  commit. */
const HOLDER = `
  const Database = require('better-sqlite3-multiple-ciphers');
  const [file, holdMs] = process.argv.slice(1);
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec('BEGIN IMMEDIATE');
  process.stdout.write('locked\\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdMs));
  db.exec('COMMIT');
  db.close();
`;

export interface WriteLockHolder {
  readonly released: Promise<void>;
}

/** Resolves once the other process holds the lock; `released` settles when it
 *  has let go. */
export const holdWriteLock = async (file: string, holdMs: number): Promise<WriteLockHolder> => {
  const child = spawn(process.execPath, ['-e', HOLDER, file, String(holdMs)], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (bytes) => { stderr += String(bytes); });
  const released = new Promise<void>((done, fail) => {
    child.once('exit', (code) => (code === 0
      ? done()
      : fail(new Error(`lock holder exited ${String(code)}: ${stderr}`))));
  });
  await new Promise<void>((locked, fail) => {
    let out = '';
    child.stdout.on('data', (bytes) => {
      out += String(bytes);
      if (out.includes('locked\n')) locked();
    });
    child.once('exit', () => fail(new Error(`lock holder never locked: ${stderr}`)));
  });
  return { released };
};

/** Fails unless ANOTHER connection holds the write lock right now: a
 *  zero-timeout BEGIN IMMEDIATE must be refused. Without this, a holder that had
 *  already let go would make a waiting case pass for the wrong reason. */
export const expectWriteLockHeldElsewhere = async (file: string): Promise<void> => {
  const probe = await openDatabase(file, { databaseKey: null, timeout: 0 });
  try {
    expect(() => probe.exec('BEGIN IMMEDIATE')).toThrow(/database is locked/);
  } finally {
    probe.close();
  }
};
