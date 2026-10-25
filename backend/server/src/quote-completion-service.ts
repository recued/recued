import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { QUOTE_COMPLETION_SCOPE_MAX, QUOTE_COMPLETION_STATES, QUOTE_SIGNOFF_CONTEXT_MAX,
  validateApprovalLinkConfig, type ApprovalLinkConfig, type QuoteCompletionSummary,
  type QuoteCompletionPrepareInput, type QuoteCompletionListInput, type QuoteCompletionListResult,
  type QuoteCompletionReviewInput, type QuoteCompletionReviewResult,
  type QuoteCompletionReceiptEntry } from '@recued/contracts';
import { QuoteSignoffError, type QuoteSignoffService } from './quote-signoff-service.js';
import type { WorkEntityStore } from './storage/work-entity-store.js';

type Base = ReturnType<QuoteSignoffService['completionBase']>;
interface Plan extends Base { delivery_summary: string; customer_preview: string; expiry_days: number }
interface Row {
  completion_id: string; signoff_id: string; root_signoff_id: string;
  plan_json: string; plan_hash: string; state: QuoteCompletionSummary['state'];
  created_at: number; expires_at: number; endpoint_id: string | null;
  intent_id: string | null; responded_at: number | null; received_at: number | null;
  response_hash: string | null; reviewed_at: number | null;
}
const TABLE = 'quote_completion_signoffs';
const DAY = 86_400_000;
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const invalid = (message: string) => new QuoteSignoffError('quote_completion_invalid', message, 400);
const idValid = (value: unknown): value is string => typeof value === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);

export const createQuoteCompletionService = (deps: {
  db: Database.Database; signoffs: QuoteSignoffService;
  work: Pick<WorkEntityStore, 'readTask' | 'writeTask'>; now: () => number;
}) => {
  deps.db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    completion_id TEXT PRIMARY KEY, signoff_id TEXT NOT NULL, root_signoff_id TEXT NOT NULL,
    plan_json TEXT NOT NULL, plan_hash TEXT NOT NULL, state TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, endpoint_id TEXT UNIQUE,
    intent_id TEXT UNIQUE, responded_at INTEGER, received_at INTEGER, response_hash TEXT, reviewed_at INTEGER
  ); CREATE INDEX IF NOT EXISTS quote_completion_created ON ${TABLE}(created_at DESC,completion_id);
  CREATE INDEX IF NOT EXISTS quote_completion_agreement ON ${TABLE}(root_signoff_id,state);`);
  const load = (id: string): Row => {
    const row = deps.db.prepare(`SELECT * FROM ${TABLE} WHERE completion_id=?`).get(id) as Row | undefined;
    if (!row) throw new QuoteSignoffError('quote_completion_not_found', 'This completion request no longer exists.', 404);
    return row;
  };
  const planOf = (row: Row): Plan => {
    const plan = JSON.parse(row.plan_json) as Plan;
    const processed = row.responded_at !== null;
    if (digest(plan) !== row.plan_hash || plan.signoff_id !== row.signoff_id || plan.root_signoff_id !== row.root_signoff_id
      || !QUOTE_COMPLETION_STATES.includes(row.state)
      || [row.created_at, row.expires_at, row.responded_at, row.received_at, row.reviewed_at]
        .some(value => value !== null && (!Number.isSafeInteger(value) || value < 0))
      || !Number.isSafeInteger(plan.expiry_days) || plan.expiry_days < 1 || plan.expiry_days > 30
      || row.expires_at !== row.created_at + plan.expiry_days * DAY
      || processed !== (row.received_at !== null) || processed !== (row.intent_id !== null) || processed !== (row.response_hash !== null)
      || processed && (row.intent_id !== row.endpoint_id || !/^[a-f0-9]{64}$/.test(row.response_hash!)
        || row.received_at! < row.created_at || row.received_at! >= row.expires_at || row.responded_at! < row.received_at!)
      || !processed && ['accepted','corrections_requested','closed','reopened'].includes(row.state)
      || processed && ['draft','publishing','waiting'].includes(row.state)
      || row.reviewed_at !== null && row.reviewed_at < row.responded_at!
      || ((row.state === 'closed' || row.state === 'reopened') !== (row.reviewed_at !== null))) {
      throw new QuoteSignoffError('quote_completion_history_unavailable', 'The saved completion request no longer matches its original terms.');
    }
    return plan;
  };
  const availability = (row: Row, receivedAt?: number): QuoteCompletionSummary['availability'] => {
    if (row.state === 'superseded') return 'superseded';
    if (row.state === 'closed' || row.state === 'reopened' || row.state === 'cancelled') return 'current';
    if (row.responded_at === null && (receivedAt ?? deps.now()) >= row.expires_at) return 'expired';
    try {
      const plan = planOf(row); const base = deps.signoffs.completionBase(row.signoff_id);
      return plan.agreement_hash !== base.agreement_hash || plan.task_revision !== base.task_revision
        || digest(plan.task) !== digest(base.task) ? 'superseded' : 'current';
    } catch (error) { return error instanceof QuoteSignoffError && error.code === 'quote_signoff_superseded' ? 'superseded' : 'unavailable'; }
  };
  const requireCurrent = (row: Row, receivedAt?: number): void => {
    const current = availability(row, receivedAt);
    if (current !== 'current') throw new QuoteSignoffError(`quote_completion_${current}`,
      'The agreement, task or completion request has changed or expired. Preview a new completion request.');
  };
  const summary = (row: Row): QuoteCompletionSummary => {
    const plan = planOf(row);
    return { completion_id: row.completion_id, signoff_id: row.signoff_id, root_signoff_id: row.root_signoff_id,
      business_name: plan.business_name, customer: plan.customer, quote_label: plan.quote_label,
      agreed_scope: plan.agreed_scope, delivery_summary: plan.delivery_summary, customer_preview: plan.customer_preview,
      state: row.state, availability: availability(row), created_at: row.created_at, expires_at: row.expires_at,
      endpoint_id: row.endpoint_id,
      response: { decision: row.responded_at === null ? 'not_recorded' : 'unavailable',
        received_at: row.received_at, recorded_at: row.responded_at },
      owner_action: row.reviewed_at === null ? null : { action: row.state === 'closed' ? 'close' : 'reopen', recorded_at: row.reviewed_at } };
  };
  const approvalConfig = (id: string): ApprovalLinkConfig => {
    const row = load(id); const plan = planOf(row);
    const config: ApprovalLinkConfig = { display_name: plan.business_name, action_kind: 'approve_wording',
      prompt: 'Do you accept completion of the work described below, or request corrections?',
      context_raw: { summary: plan.customer_preview }, visitor_field_constraints: { name: 'optional', email: 'optional' },
      expiry_days: plan.expiry_days, on_action: { target_id: id, on_approve_action: 'quote_completion' },
      success_message: 'Your completion response has been recorded. The business will review it before closing or reopening the work.' };
    const failures = validateApprovalLinkConfig(config);
    if (failures.length) throw invalid(failures[0]!.detail);
    return config;
  };
  const reviewInput = (row: Row): QuoteCompletionReviewInput => {
    const plan = planOf(row);
    const close = row.state === 'accepted' || row.state === 'closed';
    return { completion_id: row.completion_id, expected_plan_hash: digest({ plan_hash: row.plan_hash, response_hash: row.response_hash }),
      summary: `${plan.customer_preview}\n\nCustomer ${close ? 'accepted completion' : 'requested corrections'}.\n`
        + `${close ? 'Close' : 'Reopen'} local task: ${plan.task.title}.\n`
        + (close ? '' : 'Read the customer’s corrections in Customer sign-offs before approving this review.\n')
        + 'This review records the owner action. Payment and invoice balances are recorded separately.' };
  };
  return {
    resumeDraft(id: string) {
      const row = load(id); requireCurrent(row);
      if (row.state !== 'draft') throw new QuoteSignoffError('quote_completion_not_draft', 'Only a saved draft can resume its preview.');
      return { completion: summary(row), expiry_days: planOf(row).expiry_days };
    },
    prepare(input: QuoteCompletionPrepareInput): QuoteCompletionSummary {
      if (!idValid(input.signoff_id)) throw invalid('Choose a released customer agreement.');
      if (typeof input.delivery_summary !== 'string' || !input.delivery_summary.trim()
        || input.delivery_summary.trim().length > QUOTE_COMPLETION_SCOPE_MAX || input.delivery_summary.includes('\0')) {
        throw invalid(`Describe the delivery in 1–${QUOTE_COMPLETION_SCOPE_MAX} characters.`);
      }
      const expiry = input.expiry_days ?? 7;
      if (!Number.isSafeInteger(expiry) || expiry < 1 || expiry > 30) throw invalid('Link lifetime must be 1–30 days.');
      return deps.db.transaction(() => {
        const base = deps.signoffs.completionBase(input.signoff_id);
        const delivery = input.delivery_summary.trim();
        const preview = `Completion for quote ${base.quote_reference || base.quote_label} — ${base.customer}\n\n`
          + `Agreed scope:\n${base.agreed_scope}\n\nDelivered work:\n${delivery}\n\n`
          + 'Accepting confirms the described delivery. Payment is recorded separately.';
        if (preview.length > QUOTE_SIGNOFF_CONTEXT_MAX) throw invalid('The agreement and delivery summary are too long to show completely.');
        const plan: Plan = { ...base, delivery_summary: delivery, customer_preview: preview, expiry_days: expiry };
        // A newer attempt replaces pending requests only; completed attempts remain historical evidence.
        deps.db.prepare(`UPDATE ${TABLE} SET state='superseded' WHERE root_signoff_id=?
          AND state IN ('draft','publishing','waiting','accepted','corrections_requested')`).run(base.root_signoff_id);
        const createdAt = deps.now();
        const row: Row = { completion_id: randomUUID(), signoff_id: input.signoff_id, root_signoff_id: base.root_signoff_id,
          plan_json: JSON.stringify(plan), plan_hash: digest(plan), state: 'draft', created_at: createdAt, expires_at: createdAt + expiry * DAY,
          endpoint_id: null, intent_id: null, responded_at: null, received_at: null, response_hash: null, reviewed_at: null };
        deps.db.prepare(`INSERT INTO ${TABLE} (completion_id,signoff_id,root_signoff_id,plan_json,plan_hash,state,created_at,expires_at)
          VALUES (?,?,?,?,?,'draft',?,?)`).run(row.completion_id,row.signoff_id,row.root_signoff_id,row.plan_json,row.plan_hash,row.created_at,row.expires_at);
        return summary(row);
      }).immediate();
    },
    get: (id: string) => summary(load(id)),
    latestForJob<T>(root: string, readResponse: (endpoint: string | null) => T) {
      const row = deps.db.prepare(`SELECT * FROM ${TABLE} WHERE root_signoff_id=?
        ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(root) as Row | undefined;
      return row ? { completion: summary(row), expected_hash: row.response_hash,
        snapshot: readResponse(row.endpoint_id) } : null;
    },
    approvalConfig,
    reservePublish(id: string): void {
      deps.db.transaction(() => {
        const row = load(id); requireCurrent(row);
        if (row.state !== 'draft') throw new QuoteSignoffError('quote_completion_already_published', 'Preview a new completion request before publishing again.');
        deps.db.prepare(`UPDATE ${TABLE} SET state='publishing' WHERE completion_id=?`).run(id);
      }).immediate();
    },
    attachEndpoint(id: string, endpoint: string): void {
      deps.db.transaction(() => {
        const row = load(id); requireCurrent(row);
        if (row.state !== 'publishing') throw new QuoteSignoffError('quote_completion_superseded', 'The completion changed while publishing.');
        deps.db.prepare(`UPDATE ${TABLE} SET endpoint_id=?,state='waiting' WHERE completion_id=?`).run(endpoint,id);
      }).immediate();
    },
    resetPublish(id: string): void {
      deps.db.prepare(`UPDATE ${TABLE} SET state='draft',endpoint_id=NULL WHERE completion_id=?
        AND state IN ('publishing','waiting') AND responded_at IS NULL`).run(id);
    },
    cancel(id: string): QuoteCompletionSummary {
      return deps.db.transaction(() => {
        const row = load(id);
        if (row.reviewed_at !== null) throw new QuoteSignoffError('quote_completion_already_reviewed', 'The owner action is already recorded. Reopen the task explicitly for further work.');
        deps.db.prepare(`UPDATE ${TABLE} SET state='cancelled' WHERE completion_id=?`).run(id); return summary(load(id));
      }).immediate();
    },
    checkLink(id: string, endpoint: string, config?: ApprovalLinkConfig): string | null {
      try {
        const row = load(id);
        if (row.state !== 'waiting' || row.endpoint_id !== endpoint) return 'This completion request is no longer available. Ask the business for a new link.';
        if (config && JSON.stringify(config) !== JSON.stringify(approvalConfig(id))) return 'The completion request no longer matches its saved delivery summary.';
        requireCurrent(row); return null;
      } catch { return 'The work or completion request has changed or expired. Ask the business for a new link.'; }
    },
    recordResponse(id: string, endpoint: string, intent: string, outcome: string, receivedAt: number): QuoteCompletionReviewInput | null {
      if (outcome !== 'approve' && !/^reject:.+$/s.test(outcome)) throw invalid('A corrections request must describe what needs changing.');
      if (outcome.startsWith('reject:') && !outcome.slice(7).trim()) throw invalid('Describe the corrections you need.');
      return deps.db.transaction(() => {
        const row = load(id);
        if (row.endpoint_id !== endpoint || intent !== endpoint) throw new QuoteSignoffError('quote_completion_wrong_link', 'The response belongs to another completion request.');
        if (!Number.isSafeInteger(receivedAt) || receivedAt < row.created_at || receivedAt >= row.expires_at || receivedAt > deps.now()) throw invalid('The recorded completion response date is invalid.');
        const responseHash = digest(outcome);
        if (row.intent_id !== null) {
          if (row.intent_id !== intent || row.response_hash !== responseHash) throw invalid('The recorded completion response has changed.');
          return row.state === 'accepted' || row.state === 'corrections_requested' ? reviewInput(row) : null;
        }
        if (row.state !== 'waiting' || availability(row, receivedAt) !== 'current') {
          if (row.state !== 'cancelled' && row.state !== 'superseded') deps.db.prepare(`UPDATE ${TABLE} SET state='superseded' WHERE completion_id=?`).run(id);
          return null;
        }
        deps.db.prepare(`UPDATE ${TABLE} SET state=?,intent_id=?,response_hash=?,received_at=?,responded_at=? WHERE completion_id=?`)
          .run(outcome === 'approve' ? 'accepted' : 'corrections_requested',intent,responseHash,receivedAt,deps.now(),id);
        return reviewInput(load(id));
      }).immediate();
    },
    review(input: QuoteCompletionReviewInput): QuoteCompletionReviewResult {
      return deps.db.transaction(() => {
        const row = load(input.completion_id); const expected = reviewInput(row); const plan = planOf(row);
        if (input.expected_plan_hash !== expected.expected_plan_hash || input.summary !== expected.summary) throw new QuoteSignoffError('quote_completion_plan_changed', 'The approved review no longer matches the saved delivery and customer response.');
        const action = row.state === 'accepted' || row.state === 'closed' ? 'close' as const : 'reopen' as const;
        if (row.reviewed_at !== null) return { completion_id: row.completion_id, task_id: plan.task.id, action, already_reviewed: true };
        if (row.state !== 'accepted' && row.state !== 'corrections_requested' || row.intent_id === null) throw new QuoteSignoffError('quote_completion_not_answered', 'This completion has no current customer response to review.');
        requireCurrent(row);
        deps.work.writeTask({ ...plan.task, done: action === 'close', state: action === 'close' ? 'done' : 'open',
          updated_at: deps.now(), source_extension_blob: { ...plan.task.source_extension_blob,
            quote_completion_id: row.completion_id } },deps.now());
        deps.db.prepare(`UPDATE ${TABLE} SET state=?,reviewed_at=? WHERE completion_id=?`).run(action === 'close' ? 'closed' : 'reopened',deps.now(),row.completion_id);
        return { completion_id: row.completion_id, task_id: plan.task.id, action, already_reviewed: false };
      }).immediate();
    },
    list<T>(input: QuoteCompletionListInput, readResponse: (endpoint: string | null) => T): {
      result: QuoteCompletionListResult; responses: Array<{ expected_hash: string | null; snapshot: T }>;
    } {
      if (input.signoff_id !== undefined && !idValid(input.signoff_id)) throw invalid('Choose a released agreement.');
      if (input.review_only !== undefined && typeof input.review_only !== 'boolean') throw invalid('Choose whether to show requests needing review.');
      const limit = input.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw invalid('Limit must be 1–100.');
      const query = digest({ signoff_id: input.signoff_id ?? null, review_only: input.review_only ?? false });
      let anchor: { at: number; id: string } | undefined;
      if (input.cursor !== undefined) {
        try {
          if (typeof input.cursor !== 'string' || input.cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) throw invalid('Invalid completion page.');
          const parsed: unknown = JSON.parse(Buffer.from(input.cursor,'base64url').toString('utf8'));
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !('query' in parsed) || parsed.query !== query
            || !('at' in parsed) || typeof parsed.at !== 'number' || !Number.isSafeInteger(parsed.at) || parsed.at < 0
            || !('id' in parsed) || !idValid(parsed.id) || Object.keys(parsed).some(key => !['query','at','id'].includes(key))) throw invalid('Invalid completion page.');
          anchor = { at: parsed.at, id: parsed.id };
        } catch { throw invalid('This completion page is invalid. Start from the newest requests.'); }
      }
      const where: string[] = []; const values: Array<string | number> = [];
      if (input.signoff_id) { where.push('signoff_id=?'); values.push(input.signoff_id); }
      if (input.review_only) where.push("state IN ('accepted','corrections_requested')");
      if (anchor) { where.push('(created_at<? OR (created_at=? AND completion_id>?))'); values.push(anchor.at,anchor.at,anchor.id); }
      return deps.db.transaction(() => {
        const rows = deps.db.prepare(`SELECT * FROM ${TABLE} ${where.length ? 'WHERE '+where.join(' AND ') : ''}
          ORDER BY created_at DESC,completion_id LIMIT ?`).all(...values,limit+1) as Row[];
        const page = rows.slice(0,limit); const last = page.at(-1);
        return { result: { completions: page.map(summary), ...(rows.length > limit && last ? {
          next_cursor: Buffer.from(JSON.stringify({ query,at: last.created_at,id: last.completion_id })).toString('base64url') } : {}) },
          responses: page.map(row => ({ expected_hash: row.response_hash,snapshot: readResponse(row.endpoint_id) })) };
      })();
    },
    receipt<T>(signoffIds: string[], readResponse: (endpoint: string | null) => T): {
      entries: QuoteCompletionReceiptEntry[]; responses: Array<{ endpoint_id: string | null; expected_hash: string | null; snapshot: T }>;
    } {
      return deps.db.transaction(() => {
        const rows = deps.db.prepare(`SELECT * FROM ${TABLE} WHERE signoff_id IN (${signoffIds.map(() => '?').join(',')})
          ORDER BY created_at,completion_id LIMIT 101`).all(...signoffIds) as Row[];
        if (rows.length > 100) throw new QuoteSignoffError('quote_completion_history_unavailable', 'The completion history is too long to export completely.');
        return { entries: rows.map(row => {
          const entry = summary(row);
          const { availability: _availability, review: _review, endpoint_id: _endpoint, ...saved } = entry;
          return saved;
        }), responses: rows.map(row => ({ endpoint_id: row.endpoint_id,expected_hash: row.response_hash,snapshot: readResponse(row.endpoint_id) })) };
      })();
    },
  };
};
export type QuoteCompletionService = ReturnType<typeof createQuoteCompletionService>;
