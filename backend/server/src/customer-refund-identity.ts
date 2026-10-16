import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { RecordsFriendlyRecord } from '@recued/contracts';
import type { RecordsStore } from './records/store.js';

const OWNER = { publisher: 'recued-core',pack_slug: 'invoice-book' };
export interface RefundIdentityDeps { db: Database.Database;records: RecordsStore }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const evidence = (deps: RefundIdentityDeps,entity: string,id: string) => ({
  record: deps.records.ownerGet(OWNER,entity,id),
  changes: deps.db.prepare('SELECT count(*) AS n,max(event_id) AS event_id FROM core_record_outbox WHERE publisher=? AND pack_slug=? AND kind=? AND pk=?')
    .get(OWNER.publisher,OWNER.pack_slug,entity,id),
});
export const customerRefundRecordIdentity = (deps: RefundIdentityDeps,entity: string,id: string) => hash(evidence(deps,entity,id));
/** Version 9 adds refund ancestry and a reversal entity. Keep the durable event
 * identity when comparing unchanged rows created under version 8. */
export const matchesCustomerRefundIdentity = (deps: RefundIdentityDeps,entity: string,id: string,expected: string | null) => {
  const current = evidence(deps,entity,id);
  if (hash(current) === expected) return true;
  if (!current.record || current.record._record.version !== 9 || !['payment','paid_credit','refund'].includes(entity)) return false;
  if (entity === 'refund' && current.record.replaces_refund_ref != null) return false;
  const record: RecordsFriendlyRecord = { ...current.record,_record: { ...current.record._record,version: 8 } };
  if (entity === 'refund') delete record.replaces_refund_ref;
  return hash({ record,changes: current.changes }) === expected;
};
export interface IssuedCustomerRefund {
  action_id: string;signoff_id: string;kind: 'credit' | 'refund';credit_id: string;payment_id: string;
  payment_identity: string;plan_hash: string;applied_record_hash: string | null;applied_at: number | null;
}
export const issuedCustomerRefund = (deps: RefundIdentityDeps,signoff_id: string,id: string): IssuedCustomerRefund | undefined => {
  const original = deps.db.prepare('SELECT action_id,signoff_id,kind,credit_id,payment_id,payment_identity,plan_hash,applied_record_hash,applied_at FROM customer_refund_actions WHERE action_id=? AND signoff_id=?')
    .get(id,signoff_id) as IssuedCustomerRefund | undefined;
  if (original) return original;
  if (!deps.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='customer_refund_corrections'").get()) return;
  const row = deps.db.prepare('SELECT replacement_id AS action_id,signoff_id,credit_id,payment_id,payment_identity,plan_hash,replacement_record_hash AS applied_record_hash,applied_at FROM customer_refund_corrections WHERE replacement_id=? AND signoff_id=? AND applied_at IS NOT NULL')
    .get(id,signoff_id) as Omit<IssuedCustomerRefund,'kind'> | undefined;
  return row ? { ...row,kind: 'refund' } : undefined;
};
