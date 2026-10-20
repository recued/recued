/** Encrypted inverses live separately from the content-free receipt journal.
 * Both insertions share the data transaction. Ciphertext carries its complete
 * lookup identity so moving an envelope to another row cannot rebind it. */
import type Database from 'better-sqlite3';
import { RpcError } from '@recued/contracts';
import { createSqliteGatedActionChangeClock } from '../gated-action-store.js';
import { registerLocalUpdateInverseRecorder, type LocalUpdateInverse } from '../local-update-undo-context.js';
import { createLocalMutationReceipts, type LocalMutationReceipt } from './local-mutation-receipts.js';
import type { PreapprovalCodec } from './preapproval-codec.js';

export const LOCAL_UPDATE_UNDO_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const createLocalUpdateUndoStore = (db: Database.Database, codec: PreapprovalCodec, now: () => number = Date.now) => {
  const clock = createSqliteGatedActionChangeClock(db);
  const journal = createLocalMutationReceipts(db, now);
  db.exec(`CREATE TABLE IF NOT EXISTS local_update_inverses (
    receipt_id TEXT PRIMARY KEY, receipt_digest TEXT NOT NULL, epoch TEXT NOT NULL,
    expires_at INTEGER NOT NULL, encrypted TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS local_update_inverse_expiry ON local_update_inverses(expires_at);
    CREATE INDEX IF NOT EXISTS local_mutation_receipt_id ON local_mutation_receipts(json_extract(data,'$.receipt_id'));`);
  const prune = (): void => { db.prepare('DELETE FROM local_update_inverses WHERE expires_at<=? OR epoch<>?')
    .run(now(), clock.snapshot().epoch); };
  const unavailable = (): never => { throw new RpcError('local_undo_unavailable',
    'This change has no available undo. Prior values are retained for 30 days for supported local updates.', 409); };
  registerLocalUpdateInverseRecorder(db, (receipt, inverse) => {
    if (!db.inTransaction || inverse.kind !== receipt.kind) throw new Error('Undo material must share its mutation transaction.');
    const epoch = clock.snapshot().epoch;
    const expires_at = now() + LOCAL_UPDATE_UNDO_RETENTION_MS;
    const value = { schema_version: 1, receipt_id: receipt.receipt_id, receipt_digest: receipt.digest, epoch, expires_at, inverse };
    // Large updates remain valid writes; they do not promise a bounded undo.
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 256 * 1024) return;
    let encrypted: string;
    try { encrypted = codec.sealSync(value); }
    catch (error) {
      // Undo must not add an unlock requirement to existing ordinary writes.
      // A locked/keyless host retains no inverse; it never falls back to text.
      if (error instanceof RpcError && error.code === 'server_locked') return;
      throw error;
    }
    prune();
    db.prepare('INSERT INTO local_update_inverses VALUES(?,?,?,?,?)')
      .run(receipt.receipt_id, receipt.digest, epoch, expires_at, encrypted);
  });
  return {
    codec, clock, journal, prune,
    async load(receiptId: string): Promise<{ receipt: LocalMutationReceipt; inverse: LocalUpdateInverse; retained_until: number }> {
      codec.assertUnlocked(); prune();
      const row = db.prepare('SELECT * FROM local_update_inverses WHERE receipt_id=?').get(receiptId) as {
        receipt_id: string; receipt_digest: string; epoch: string; expires_at: number; encrypted: string;
      } | undefined;
      if (!row) return unavailable();
      const saved = db.prepare("SELECT data FROM local_mutation_receipts WHERE json_extract(data,'$.receipt_id')=?")
        .get(receiptId) as { data: string } | undefined;
      if (!saved) return unavailable();
      let receipt: LocalMutationReceipt | null;
      try { receipt = journal.find(JSON.parse(saved.data) as LocalMutationReceipt); }
      catch { return unavailable(); }
      if (!receipt || receipt.receipt_id !== receiptId || receipt.digest !== row.receipt_digest) return unavailable();
      const material = await codec.open(row.encrypted) as {
        schema_version: number; receipt_id: string; receipt_digest: string; epoch: string; expires_at: number; inverse: LocalUpdateInverse;
      };
      codec.assertUnlocked();
      if (material.schema_version !== 1 || material.receipt_id !== row.receipt_id || material.receipt_digest !== row.receipt_digest
        || material.epoch !== row.epoch || row.epoch !== clock.snapshot().epoch || material.expires_at !== row.expires_at
        || row.expires_at <= now() || material.inverse.kind !== receipt.kind) return unavailable();
      return { receipt, inverse: material.inverse, retained_until: row.expires_at };
    },
    assertAvailable(receipt: LocalMutationReceipt): void {
      codec.assertUnlocked();
      const row = db.prepare('SELECT receipt_digest,epoch,expires_at FROM local_update_inverses WHERE receipt_id=?')
        .get(receipt.receipt_id) as { receipt_digest: string; epoch: string; expires_at: number } | undefined;
      if (!row || row.receipt_digest !== receipt.digest || row.epoch !== clock.snapshot().epoch || row.expires_at <= now()
        || !journal.find(receipt)) unavailable();
    },
  };
};
export type LocalUpdateUndoStore = ReturnType<typeof createLocalUpdateUndoStore>;
