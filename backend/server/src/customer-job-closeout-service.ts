import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { customerJobCloseoutBlockers,type CustomerJob,type CustomerJobArchiveInput,type CustomerJobRestoreInput,
  type CustomerJobCloseoutReport,type CustomerJobArchiveState } from '@recued/contracts';
import { QuoteSignoffError,type QuoteSignoffService } from './quote-signoff-service.js';
import type { PreapprovalCodec } from './storage/preapproval-codec.js';
import { createMailSendClaimStore } from './storage/mail-send-claim-store.js';
import { createCustomerJobArchiveStore,jobArchiveTableExists } from './storage/customer-job-archive-store.js';
import { customerJobRootSql } from './storage/customer-job-read-index.js';
import type { captureCustomerJobs } from './customer-jobs-rpc-handler.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const invalid = (message: string): never => { throw new QuoteSignoffError('customer_job_closeout_invalid',message,400); };
const stale = (): never => { throw new QuoteSignoffError('customer_job_closeout_stale','This job changed. Refresh and review its closeout again.'); };
const id = (value: unknown): string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)
  ? value : invalid('Choose an original customer job.');
const revision = (value: unknown) => { if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 0 || value >= Number.MAX_SAFE_INTEGER) invalid('Refresh the current archive revision.'); };

/** Archive is owner metadata. All ledgers, tasks, customer replies and account selections survive it. */
export const createCustomerJobCloseoutService = (deps: {
  db: Database.Database;signoffs: QuoteSignoffService;codec: PreapprovalCodec;now: () => number;
  capture: (jobId: string) => ReturnType<typeof captureCustomerJobs>;
}) => {
  const store = createCustomerJobArchiveStore(deps.db);const claims = createMailSendClaimStore(deps.db);
  const financial = (job: CustomerJob) => job.agreement ? deps.signoffs.jobPaymentStatementSnapshot(job.job_id).statement_hash : null;
  const fingerprint = (job: CustomerJob,sourceHash: string) => hash({ sourceHash,financial: financial(job),work: deps.signoffs.jobCloseoutFingerprint(job.job_id) });
  const reminders = (jobId: string) => {
    const signoffs = deps.db.prepare(`SELECT signoff_id FROM quote_signoffs WHERE ${customerJobRootSql()}=? ORDER BY signoff_id`)
      .all(jobId) as Array<{ signoff_id: string }>;
    const ids = signoffs.map(row => row.signoff_id);const marks = ids.map(() => '?').join(',');
    const rows: Array<{ kind: string;request_id: string;revision: number;due_at: number | null;settings_ciphertext: string;last_draft_reference: string | null }> = [];
    if (ids.length) for (const table of ['quote_signoff_reminders','quote_payment_reminders']) {
      if (jobArchiveTableExists(deps.db,table)) rows.push(...deps.db.prepare(`SELECT ? AS kind,signoff_id AS request_id,revision,due_at,settings_ciphertext,last_draft_reference FROM ${table} WHERE signoff_id IN (${marks}) ORDER BY signoff_id`).all(table,...ids) as typeof rows);
    }
    if (jobArchiveTableExists(deps.db,'quote_completion_reminders')) rows.push(...deps.db.prepare(`SELECT 'completion' AS kind,r.completion_id AS request_id,r.revision,r.due_at,r.settings_ciphertext,r.last_draft_reference
      FROM quote_completion_reminders r JOIN quote_completion_signoffs c USING(completion_id) WHERE c.root_signoff_id=? ORDER BY r.completion_id`).all(jobId) as typeof rows);
    const references = new Set(rows.flatMap(row => row.last_draft_reference ? [row.last_draft_reference] : []));
    if (ids.length && jobArchiveTableExists(deps.db,'customer_account_payment_reminder_invoices')) {
      const reserved = deps.db.prepare(`SELECT DISTINCT reference FROM customer_account_payment_reminder_invoices WHERE signoff_id IN (${marks}) ORDER BY reference`).all(...ids) as Array<{ reference: string }>;
      reserved.forEach(row => references.add(row.reference));
    }
    const outcomes = [...references].sort().map(reference => ({ reference,claim: claims.get(reference) }));
    return { rows,outcomes,saved_schedules: rows.filter(row => row.due_at !== null).length,
      uncertain_sends: outcomes.filter(row => row.claim && !['sent','confirmed','reconciled','not_sent','released'].includes(row.claim.status)).length };
  };
  const prepare = async (jobId: string) => {
    deps.codec.assertUnlocked();const captured = await deps.capture(jobId);deps.codec.assertUnlocked();captured.assertCurrent();
    const job = captured.jobs[0];if (!job) throw new QuoteSignoffError('customer_job_unavailable','This original customer job is unavailable. Review its saved requests.',404);
    const blockers = customerJobCloseoutBlockers(job);let businessHash: string | null = null;
    try { businessHash = fingerprint(job,captured.sources.get(jobId)!); }
    catch (error) { if (!(error instanceof QuoteSignoffError)) throw error;blockers.push('Review the complete job billing history in Records.'); }
    const followups = reminders(jobId);if (followups.uncertain_sends) blockers.push('Resolve unknown reminder email outcomes in Mail.');
    const archive = store.state(jobId);const snapshotHash = hash({ businessHash,archive,followups });
    return { job,archive,blockers,businessHash,followups,snapshotHash,assertCurrent: () => {
      deps.codec.assertUnlocked();captured.assertCurrent();
      if (hash(store.state(jobId)) !== hash(archive) || fingerprint(job,captured.sources.get(jobId)!) !== businessHash
        || hash(reminders(jobId)) !== hash(followups)) stale();
    } };
  };
  return {
    hasArchive: (jobId: string) => store.read(jobId)?.archived_at != null,
    project(job: CustomerJob,sourceHash?: string): CustomerJobArchiveState {
      const saved = store.read(job.job_id);let changed = false;
      if (saved?.archived_at !== null && saved?.archived_at !== undefined) {
        try { changed = !sourceHash || saved.fingerprint !== fingerprint(job,sourceHash); } catch (error) { if (!(error instanceof QuoteSignoffError)) throw error;changed = true; }
      }
      return { ...store.state(job.job_id),needs_review: changed };
    },
    async get(jobId: string): Promise<CustomerJobCloseoutReport> {
      id(jobId);deps.codec.assertUnlocked();
      try {
        const p = await prepare(jobId);
        return { job_id: jobId,captured_at: deps.now(),job: p.job,archive: p.archive,...store.history(jobId),
          can_archive: p.archive.archived_at === null && p.blockers.length === 0 && p.businessHash !== null,
          blockers: p.blockers,snapshot_hash: p.businessHash ? p.snapshotHash : null,
          reminders: { saved_schedules: p.followups.saved_schedules,uncertain_sends: p.followups.uncertain_sends } };
      } catch (error) {
        if (!(error instanceof QuoteSignoffError) || !store.read(jobId)) throw error;
        return { job_id: jobId,captured_at: deps.now(),job: null,archive: store.state(jobId),...store.history(jobId),can_archive: false,
          blockers: ['The job could not be read completely. Review Records. You can still restore its archive.'],snapshot_hash: null,
          reminders: { saved_schedules: 0,uncertain_sends: 0 } };
      }
    },
    async archive(input: CustomerJobArchiveInput,actor: string) {
      id(input.job_id);revision(input.expected_revision);deps.codec.assertUnlocked();
      if (input.confirmed !== true || typeof input.expected_snapshot_hash !== 'string' || !/^[a-f0-9]{64}$/.test(input.expected_snapshot_hash)) invalid('Review and confirm the current closeout before archiving.');
      const previous = store.read(input.job_id);
      if (previous?.revision === input.expected_revision+1 && previous.archived_at !== null && previous.review_hash === input.expected_snapshot_hash) return store.state(input.job_id);
      if ((previous?.revision ?? 0) !== input.expected_revision || previous?.archived_at != null) stale();
      const p = await prepare(input.job_id);
      if (p.snapshotHash !== input.expected_snapshot_hash) stale();
      if (p.blockers.length || !p.businessHash) throw new QuoteSignoffError('customer_job_closeout_blocked','Finish the closeout items before archiving this job.');
      return deps.db.transaction(() => {
        p.assertCurrent();return store.write(input.job_id,input.expected_revision+1,'archive',deps.now(),actor,p.businessHash,input.expected_snapshot_hash);
      }).immediate();
    },
    async restore(input: CustomerJobRestoreInput,actor: string) {
      id(input.job_id);revision(input.expected_revision);deps.codec.assertUnlocked();
      return deps.db.transaction(() => {
        deps.codec.assertUnlocked();const row = store.read(input.job_id);
        if (row?.revision === input.expected_revision+1 && row.archived_at === null) return store.state(input.job_id);
        if (!row || row.revision !== input.expected_revision || row.archived_at === null) stale();
        return store.write(input.job_id,input.expected_revision+1,'restore',deps.now(),actor,null,null);
      }).immediate();
    },
  };
};
export type CustomerJobCloseoutService = ReturnType<typeof createCustomerJobCloseoutService>;
