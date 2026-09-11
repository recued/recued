/** The ordinary checkpoint and its D-261 continuation fence share the realm
 * transaction. The ordinary store remains the reader/answer path. */
import type Database from 'better-sqlite3';
import { isCheckpoint, RpcError, type Checkpoint } from '@recued/contracts';
import { preapprovalHash } from '../preapproval-invocations.js';
import { createSQLiteCollection } from '../sqlite-collection.js';

export const preapprovalCheckpointHash = (checkpoint: Checkpoint): string => {
  // These are the existing owner-only editable-argument fields. Every other
  // value, including the saved step state and foreach progress, is immutable.
  const { arg_overrides: _args, approved_target: _target, ...immutable } = checkpoint;
  return preapprovalHash(immutable);
};

export const createPreapprovalCheckpointParticipant = (db: Database.Database) => {
  createSQLiteCollection<Checkpoint>(db, 'checkpoints');
  const read = (id: string): Checkpoint | null => {
    const row = db.prepare('SELECT data FROM checkpoints WHERE key = ?').get(id) as { data: string } | undefined;
    const value: unknown = row ? JSON.parse(row.data) : null;
    if (value !== null && !isCheckpoint(value)) throw new RpcError('preapproval_stale', 'The held checkpoint is invalid.', 409);
    return value as Checkpoint | null;
  };
  return {
    read,
    write(checkpoint: Checkpoint): void {
      if (!db.inTransaction) throw new Error('A pre-approved hold requires the realm transaction.');
      if (!isCheckpoint(checkpoint)) throw new RpcError('preapproval_stale', 'The held checkpoint is invalid.', 409);
      const previous = read(checkpoint.checkpoint_id);
      if (previous) {
        if (preapprovalHash(previous) !== preapprovalHash(checkpoint)) throw new RpcError('preapproval_stale', 'The checkpoint id was already used.', 409);
        return;
      }
      db.prepare('INSERT INTO checkpoints(key, data) VALUES(?, ?)').run(checkpoint.checkpoint_id, JSON.stringify(checkpoint));
    },
  };
};
