/** Immutable, content-free evidence committed by a local store alongside its
 * mutation. Owners bind an attempt to their own sealed authorization material. */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { canonicalJSONStringifyStrict, sha256Hex } from '@recued/crypto';
import { RpcError, type LocalMutationReceiptSummary } from '@recued/contracts';
import { recordLocalUpdateInverse } from '../local-update-undo-context.js';

export interface LocalMutationReceiptBinding {
  owner: string;
  owner_ref: string;
  attempt_id: string;
  identity_hash: string;
  operation: string;
  kind: LocalMutationReceiptSummary['kind'];
  review_hash: string;
}
export interface LocalMutationReceipt extends LocalMutationReceiptBinding, LocalMutationReceiptSummary {
  schema_version: 1;
  digest: string;
}
const digest = (value: unknown): string => 'sha256:' + sha256Hex(canonicalJSONStringifyStrict(value));
const hash = (value: unknown): value is string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;
const receiptBinding = (value: LocalMutationReceiptBinding): LocalMutationReceiptBinding => ({
  owner: value.owner, owner_ref: value.owner_ref, attempt_id: value.attempt_id, identity_hash: value.identity_hash,
  operation: value.operation, kind: value.kind, review_hash: value.review_hash,
});

export const createLocalMutationReceipts = (db: Database.Database, now: () => number = Date.now) => {
  db.exec(`CREATE TABLE IF NOT EXISTS local_mutation_receipts (
    attempt_id TEXT PRIMARY KEY, owner TEXT NOT NULL, owner_ref TEXT NOT NULL, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS local_mutation_receipts_owner ON local_mutation_receipts(owner,owner_ref);`);
  return {
    hasAttempt(attemptId: string): boolean {
      return Boolean(db.prepare('SELECT 1 FROM local_mutation_receipts WHERE attempt_id=?').get(attemptId));
    },
    record(binding: LocalMutationReceiptBinding): LocalMutationReceipt {
      if (!db.inTransaction) throw new Error('A local receipt must share its mutation transaction.');
      // Structural typing permits extra fields on a host object. Select the
      // metadata explicitly so a new adapter cannot persist private payloads.
      binding = receiptBinding(binding);
      if (![binding.owner, binding.owner_ref, binding.attempt_id, binding.operation].every(text)
        || !hash(binding.identity_hash) || !hash(binding.review_hash)
        || !['records', 'local_calendar'].includes(binding.kind)) throw new Error('Invalid local mutation receipt binding.');
      // A repeated attempt must roll back, even when its arguments match. The
      // receipt can explain a prior write; it cannot authorize another one.
      if (db.prepare('SELECT 1 FROM local_mutation_receipts WHERE attempt_id=?').get(binding.attempt_id)) {
        throw new RpcError('local_mutation_already_recorded', 'This local mutation attempt already has a receipt.', 409);
      }
      const committed_at = now();
      if (!Number.isSafeInteger(committed_at) || committed_at < 0) throw new Error('Invalid local mutation receipt time.');
      const body = { ...binding, schema_version: 1 as const, receipt_id: 'lmr_' + randomUUID(), committed_at };
      const receipt = { ...body, digest: digest(body) };
      db.prepare('INSERT INTO local_mutation_receipts(attempt_id,owner,owner_ref,data) VALUES(?,?,?,?)')
        .run(binding.attempt_id, binding.owner, binding.owner_ref, JSON.stringify(receipt));
      recordLocalUpdateInverse(db, receipt);
      return receipt;
    },
    find(binding: LocalMutationReceiptBinding): LocalMutationReceipt | null {
      const row = db.prepare('SELECT owner,owner_ref,data FROM local_mutation_receipts WHERE attempt_id=?')
        .get(binding.attempt_id) as { owner: string; owner_ref: string; data: string } | undefined;
      if (!row || row.owner !== binding.owner || row.owner_ref !== binding.owner_ref) return null;
      try {
        const receipt = JSON.parse(row.data) as LocalMutationReceipt;
        const { digest: stored, receipt_id, committed_at, schema_version, ...saved } = receipt;
        if (schema_version !== 1 || !/^lmr_[a-f0-9-]{36}$/.test(receipt_id)
          || !Number.isSafeInteger(committed_at) || committed_at < 0
          || digest(saved) !== digest(receiptBinding(binding))
          || !hash(stored) || stored !== digest({ ...saved, schema_version, receipt_id, committed_at })) return null;
        return receipt;
      } catch { return null; }
    },
  };
};
