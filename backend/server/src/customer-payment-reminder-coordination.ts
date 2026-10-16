import type Database from 'better-sqlite3';
import { createMailSendClaimStore } from './storage/mail-send-claim-store.js';
import { QuoteSignoffError } from './quote-signoff-service.js';

const exists = (db: Database.Database,table: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
const uncertain = (db: Database.Database,reference: string) => {
  const claim = createMailSendClaimStore(db).get(reference);
  return Boolean(claim && !['sent','confirmed','reconciled','not_sent','released'].includes(claim.status));
};
/** An account follow-up owns linked invoices until paused, including after Send.
 * Historical reservations also fence invoices while an email outcome is unknown. */
export const accountReminderOwnsInvoice = (db: Database.Database,signoffId: string): boolean => {
  if (!exists(db,'customer_account_payment_reminders')) return false;
  if (db.prepare(`SELECT 1 FROM quote_signoffs s
    JOIN customer_account_jobs j ON j.job_id=COALESCE(json_extract(s.plan_json,'$.addition.root_signoff_id'),s.signoff_id)
    JOIN customer_account_payment_reminders r ON r.account_id=j.account_id
    WHERE s.signoff_id=? AND r.due_at IS NOT NULL LIMIT 1`).get(signoffId)) return true;
  const reserved = db.prepare('SELECT reference FROM customer_account_payment_reminder_invoices WHERE signoff_id=?')
    .all(signoffId) as Array<{ reference: string }>;
  return reserved.some(row => uncertain(db,row.reference));
};
export const assertNoUncertainInvoiceReminders = (db: Database.Database,signoffIds: string[],except?: string): void => {
  if (!signoffIds.length) return;
  const marks = signoffIds.map(() => '?').join(',');
  const references: string[] = [];
  if (exists(db,'quote_payment_reminders')) {
    const rows = db.prepare(`SELECT last_draft_reference AS reference FROM quote_payment_reminders WHERE signoff_id IN (${marks}) AND last_draft_reference IS NOT NULL`)
      .all(...signoffIds) as Array<{ reference: string }>;
    references.push(...rows.map(row => row.reference));
  }
  const rows = db.prepare(`SELECT DISTINCT reference FROM customer_account_payment_reminder_invoices WHERE signoff_id IN (${marks})`)
    .all(...signoffIds) as Array<{ reference: string }>;
  references.push(...rows.map(row => row.reference));
  if (references.some(reference => reference !== except && uncertain(db,reference))) {
    throw new QuoteSignoffError('customer_account_payment_reminder_uncertain','Check the previous payment reminder email outcome in Mail before scheduling or sending another.');
  }
};
