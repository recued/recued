import { expect, type Page } from '@playwright/test';
import type { InboxItem, ReceptionRecordOpenResult, ReceptionRecordSummary } from '@recued/contracts';
import { FIXED_NOW, HARNESS_URL } from './full-app.js';

export const RECORD_A = '11111111-1111-4111-8111-111111111111';
export const RECORD_B = '22222222-2222-4222-8222-222222222222';
export const RECORD_C = '33333333-3333-4333-8333-333333333333';
export const HOLD_A = 'hold-review-billing';
export const HOLD_B = 'hold-review-project';
export const RECORD_LIST = 'reception.record.list';
export const RECORD_OPEN = 'reception.record.open';
export const INBOX_LIST = 'reception.inbox.list';
export const INBOX_APPROVE = 'reception.inbox.approve';
export const INBOX_REJECT = 'reception.inbox.reject';
type Reply = { result?: unknown; error?: { code: string; message: string } };
export interface ReceptionReviewFixture {
  records: ReceptionRecordSummary[];
  opened: Record<string, ReceptionRecordOpenResult>;
  items: InboxItem[];
  calls: Array<{ method: string; args: Record<string, unknown> }>;
  replied: string[];
  held: string[];
  failing: string[];
  truncated: boolean;
  pending(method: string): number;
  release(method: string, failed?: boolean, index?: number): void;
}
declare global { interface Window { __receptionReview: ReceptionReviewFixture } }

export const reviewRecords = (): ReceptionRecordSummary[] => [
  { kind: 'scheduling_link', record_id: RECORD_A, endpoint_id: 'booking-page', form_name: 'Customer consultation',
    received_at: FIXED_NOW, outcome: 'pending', resolved: [], slot: { start_at: FIXED_NOW + 3_600_000, end_at: FIXED_NOW + 7_200_000, duration_minutes: 60 } },
  { kind: 'intake_form', record_id: RECORD_B, endpoint_id: 'customer-intake', form_name: 'Customer project requests',
    received_at: FIXED_NOW + 1000, outcome: 'processed', resolved: [{ kind: 'form_response', id: 'customer-response' }], form_definition_id: 'customer-form' },
  { kind: 'intake_form', record_id: RECORD_C, endpoint_id: 'removed-form', received_at: FIXED_NOW + 2000,
    outcome: 'spam', resolved: [], form_definition_id: 'removed-form' },
];
export const reviewInboxItem = (overrides: Partial<InboxItem> = {}): InboxItem => ({
  hold_id: HOLD_A, operation_id: 'crm.commitment.create', top_tier_kind: 'commitment',
  source: { kind: 'intake_form', endpoint_id: 'customer-intake', record_ref: RECORD_B },
  args: { title: 'Review customer billing request', note: 'Visitor note' },
  arg_schema: { fields: [{ key: 'title', type: 'string', label: 'Title', required: true },
    { key: 'note', type: 'string', label: 'Note', required: false }] },
  preview: { title: 'Review customer billing request', subtitle: 'Customer intake', when: FIXED_NOW },
  proposed_action: 'Create a commitment', status: 'requires_review',
  allow_offer: { ttl_ms: 86_400_000, max_uses: 20 }, ...overrides,
});
export const recordRow = (page: Page, id = RECORD_A) => page.locator(`[data-recued-reception-records-row="${id}"]`);
export const recordToggle = (page: Page, id = RECORD_A) => page.locator(`[data-recued-reception-records-details-toggle="${id}"]`);
export const recordDetails = (page: Page, id = RECORD_A) => page.locator(`[data-recued-reception-records-details="${id}"]`);
export const recordRetry = (page: Page, id = RECORD_A) => page.locator(`[data-recued-reception-records-details-retry="${id}"]`);
export const inboxRow = (page: Page, id = HOLD_A) => page.locator(`[data-recued-reception-inbox-row="${id}"]`);
export const inboxDecision = (page: Page, action: 'approve' | 'approve-allow' | 'reject') => page.locator(`[data-recued-reception-inbox-decision="${action}"]`);
export const receptionWrites = (page: Page) => page.evaluate(() => window.__receptionReview.calls.filter(call =>
  call.method === 'reception.inbox.approve' || call.method === 'reception.inbox.reject'));

export const openReceptionReview = async (page: Page, options: {
  section?: 'inbox' | 'records'; records?: ReceptionRecordSummary[]; items?: InboxItem[]; held?: string[]; failing?: string[];
  truncated?: boolean;
} = {}) => {
  const records = options.records ?? reviewRecords();
  const items = options.items ?? [reviewInboxItem(), reviewInboxItem({ hold_id: HOLD_B,
    args: { title: 'Prepare the customer project brief' }, preview: { title: 'Prepare the customer project brief', subtitle: 'Partner intake' } })];
  const opened = Object.fromEntries(records.map(record => [record.record_id, { record,
    form_name: record.form_name ?? null, visitor_email: 'morgan@example.test',
    answers: [{ label: 'Customer name', value: 'Morgan Lake' }, { label: 'Project brief', value: 'A project across several departments.' }],
  } satisfies ReceptionRecordOpenResult]));
  await page.addInitScript(({ records, opened, items, held, failing, truncated }) => {
    const waiting = new Map<string, Array<(failed: boolean) => void>>();
    const fixture: ReceptionReviewFixture = { records, opened, items, held, failing, truncated, calls: [], replied: [],
      pending: method => waiting.get(method)?.length ?? 0,
      release(method, failed = false, index = 0) {
        const queue = waiting.get(method) ?? [];
        const [finish] = queue.splice(index, 1);
        if (!finish) throw new Error(`No pending ${method} at ${index}`);
        finish(failed);
      },
    };
    Object.assign(window, { __receptionReview: fixture, __receptionFixture: async (method: string, input: unknown): Promise<Reply | undefined> => {
      if (!['reception.record.list', 'reception.record.open', 'reception.inbox.list', 'reception.inbox.approve', 'reception.inbox.reject'].includes(method)) return undefined;
      const args = (input ?? {}) as Record<string, unknown>;
      fixture.calls.push({ method, args });
      // Snapshot reads before holding the response: reopening the same record
      // must not let an older request publish into a newer pending read.
      const result = method === 'reception.record.list'
        ? { records: fixture.records.filter(row => (!args.kind || row.kind === args.kind) && (!args.outcome || row.outcome === args.outcome)), truncated: fixture.truncated }
        : method === 'reception.record.open' ? fixture.opened[String(args.record_id)]
          : method === 'reception.inbox.list' ? { items: fixture.items.filter(row =>
            args.view === 'subview' ? row.status === 'dismissed' || row.status === 'expired' : row.status === 'pending' || row.status === 'requires_review') } : null;
      const snapshot: unknown = structuredClone(result);
      const failed = fixture.failing.includes(method) || (fixture.held.includes(method)
        && await new Promise<boolean>(resolve => waiting.set(method, [...waiting.get(method) ?? [], resolve])));
      fixture.replied.push(method);
      if (failed) return { error: { code: 'UNAVAILABLE', message: 'Reception is temporarily unavailable. Try again.' } };
      if (method.endsWith('.approve') || method.endsWith('.reject')) {
        fixture.items = method.endsWith('.approve') ? fixture.items.filter(row => row.hold_id !== args.hold_id)
          : fixture.items.map(row => row.hold_id === args.hold_id ? { ...row, status: 'dismissed' } : row);
        return { result: method.endsWith('.approve') ? { hold_id: args.hold_id, released: true, edited_keys: Object.keys((args.edits ?? {}) as object) }
          : { hold_id: args.hold_id, status: 'dismissed' } };
      }
      return snapshot === undefined ? { error: { code: 'reception_record_not_found', message: 'Record no longer exists.' } } : { result: snapshot };
    } });
  }, { records, opened, items,
    held: options.held ?? [], failing: options.failing ?? [], truncated: options.truncated ?? false });
  // Own hold IDs are distinct from the default demo dispatcher. Its post-reply
  // hook cannot remove or alter these fixture-owned rows.
  await page.goto(`${HARNESS_URL}?reception=pending&settle_reads=1#reception/${options.section ?? 'records'}`);
  await page.waitForFunction(() => window.__app?.ready === true);
  if (options.section === 'inbox') {
    const first = items.find(item => item.status === 'pending' || item.status === 'requires_review');
    if (first && !options.held?.includes(INBOX_LIST) && !options.failing?.includes(INBOX_LIST)) await expect(inboxRow(page, first.hold_id)).toBeVisible();
  } else if (!options.held?.includes(RECORD_LIST) && !options.failing?.includes(RECORD_LIST) && records.length) await expect(recordRow(page, records[0]!.record_id)).toBeVisible();
};
