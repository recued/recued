import type Database from 'better-sqlite3';
import type { LocalChangeSetInspection, LocalChangeSetReview, RecordsExecutionBinding, ResourceReview } from '@recued/contracts';
import { LOCAL_CHANGE_SET_LIMITS } from '@recued/contracts';
import type { PreapprovalOrigin } from '../preapproval-model.js';
import type { LocalUpdateCall } from '../local-update-operation.js';
import type { LocalUpdateInverse } from '../local-update-undo-context.js';
import type { LocalMutationReceipt, LocalMutationReceiptBinding } from './local-mutation-receipts.js';
import type { LocalUpdateUndoStore } from './local-update-undo-store.js';

export interface LocalChangeMember {
  id: string; label: string; call: LocalUpdateCall; review: ResourceReview;
  kind: LocalMutationReceipt['kind']; binding?: RecordsExecutionBinding;
  inverse?: LocalUpdateInverse; predecessor?: LocalMutationReceipt;
}
export interface LocalChangeMaterial {
  schema_version: 1; request_id: string; request_hash: string; owner: Extract<PreapprovalOrigin, { mode: 'owner' }>; origin: PreapprovalOrigin;
  epoch: string; retained_until: number; public: LocalChangeSetReview; members: LocalChangeMember[];
  source?: { proposal_id: string; revision: number; snapshot_hash: string };
}
export interface LocalChangeProof { member_id: string; binding: LocalMutationReceiptBinding }
export interface LocalChangeRow {
  change_set_id: string; request_id: string; request_hash: string; owner_id: string; credential_id: string;
  source_proposal_id: string | null; undo_of: string | null; epoch: string; expires_at: number; retained_until: number;
  review_hash: string; encrypted: string; proof_json: string;
  status: 'pending' | 'dispatching' | 'completed' | 'denied' | 'failed' | 'unknown';
  decision: 'approve' | 'deny' | null; decision_credential_id: string | null; worker_id: string | null;
  created_at: number; decided_at: number | null;
}
export const createLocalChangeSetStore = (db: Database.Database, undo: LocalUpdateUndoStore, now: () => number) => {
  db.exec(`CREATE TABLE IF NOT EXISTS local_change_sets (
    change_set_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
    owner_id TEXT NOT NULL, credential_id TEXT NOT NULL, source_proposal_id TEXT, undo_of TEXT,
    epoch TEXT NOT NULL, expires_at INTEGER NOT NULL, retained_until INTEGER NOT NULL, review_hash TEXT NOT NULL,
    encrypted TEXT NOT NULL, proof_json TEXT NOT NULL, status TEXT NOT NULL, decision TEXT,
    decision_credential_id TEXT, worker_id TEXT, created_at INTEGER NOT NULL, decided_at INTEGER,
    UNIQUE(owner_id,credential_id,request_id));
    CREATE INDEX IF NOT EXISTS local_change_set_source ON local_change_sets(source_proposal_id);
    CREATE TABLE IF NOT EXISTS local_change_set_members (
      change_set_id TEXT NOT NULL,member_id TEXT NOT NULL,receipt_id TEXT NOT NULL UNIQUE,
      PRIMARY KEY(change_set_id,member_id));
    CREATE TABLE IF NOT EXISTS local_change_set_undos (
      original_set_id TEXT PRIMARY KEY,undo_set_id TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS local_update_undo_links (
      predecessor_receipt_id TEXT PRIMARY KEY,undo_receipt_id TEXT NOT NULL UNIQUE,undo_id TEXT NOT NULL UNIQUE);`);
  const row = (id: string): LocalChangeRow | undefined => db.prepare('SELECT * FROM local_change_sets WHERE change_set_id=?').get(id) as LocalChangeRow | undefined;
  const prune = (): void => {
    undo.prune();
    db.prepare("UPDATE local_change_sets SET encrypted='' WHERE encrypted<>'' AND (retained_until<=? OR epoch<>?)")
      .run(now(), undo.clock.snapshot().epoch);
  };
  const receipts = (value: LocalChangeRow): Array<{ member_id: string; receipt: LocalMutationReceipt }> | null => {
    try {
      const expected = JSON.parse(value.proof_json) as LocalChangeProof[];
      const links = db.prepare('SELECT member_id,receipt_id FROM local_change_set_members WHERE change_set_id=?')
        .all(value.change_set_id) as { member_id: string; receipt_id: string }[];
      if (!Array.isArray(expected) || !expected.length || expected.length > LOCAL_CHANGE_SET_LIMITS.members || links.length !== expected.length
        || new Set(expected.map(item => item.member_id)).size !== expected.length) return null;
      const result = expected.map(item => {
        if (item.binding.owner_ref !== value.change_set_id || item.binding.identity_hash !== value.review_hash
          || item.binding.attempt_id !== value.change_set_id + ':' + item.member_id
          || item.binding.owner !== (value.undo_of ? 'local_undo' : 'local_change_set')) throw new Error('Receipt binding changed');
        const receipt = undo.journal.find(item.binding);
        if (!receipt || !links.some(link => link.member_id === item.member_id && link.receipt_id === receipt.receipt_id)) throw new Error('Receipt proof is unavailable');
        return { member_id: item.member_id, receipt };
      });
      if (value.undo_of) {
        if (!db.prepare('SELECT 1 FROM local_change_set_undos WHERE original_set_id=? AND undo_set_id=?').get(value.undo_of,value.change_set_id)) return null;
        const parent = row(value.undo_of);
        if (!parent || parent.undo_of || parent.status !== 'completed') return null;
        const originals = receipts(parent);
        if (!originals || originals.length !== result.length) return null;
        for (const item of result) {
          const original = originals.find(member => member.member_id === item.member_id);
          if (!original || !db.prepare('SELECT 1 FROM local_update_undo_links WHERE predecessor_receipt_id=? AND undo_receipt_id=? AND undo_id=?')
            .get(original.receipt.receipt_id,item.receipt.receipt_id,value.change_set_id + ':' + item.member_id)) return null;
        }
      }
      return result;
    } catch { return null; }
  };
  const inspect = (value: LocalChangeRow): LocalChangeSetInspection => {
    const proof = value.status === 'completed' ? receipts(value) : null;
    const undoId = db.prepare('SELECT undo_set_id FROM local_change_set_undos WHERE original_set_id=?').pluck().get(value.change_set_id) as string | undefined;
    let available = value.status === 'completed' && proof !== null && !value.undo_of && !undoId;
    if (available) {
      try {
        for (const item of proof!) {
          undo.assertAvailable(item.receipt);
          if (db.prepare('SELECT 1 FROM local_update_undo_links WHERE predecessor_receipt_id=?').get(item.receipt.receipt_id)) available = false;
        }
      } catch { available = false; }
    }
    return { change_set_id: value.change_set_id, source_proposal_id: value.source_proposal_id, undo_of: value.undo_of,
      status: value.status === 'dispatching' || (value.status === 'completed' && !proof) ? 'unknown'
        : value.status === 'pending' && (value.expires_at <= now() || value.epoch !== undo.clock.snapshot().epoch) ? 'expired' : value.status,
      created_at: value.created_at, decided_at: value.decided_at,
      receipts: proof?.map(item => ({ member_id: item.member_id, local_receipt: { receipt_id: item.receipt.receipt_id,
        kind: item.receipt.kind, committed_at: item.receipt.committed_at } })) ?? [],
      undo_available: available, undo_change_set_id: undoId ?? null };
  };
  return { row, prune, receipts, inspect };
};
