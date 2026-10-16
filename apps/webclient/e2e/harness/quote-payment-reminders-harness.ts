/** Production jobs, follow-up editor and mail composer; deterministic local RPCs. */
import type { CustomerJob,QuoteSignoffSummary,QuoteCompletionSummary,QuoteCompletionReminder,QuotePaymentReminder,MailDraft,MailDraftContent } from '@recued/contracts';
import { mountCustomerJobsPanel,type CustomerJobsConn } from '../../src/reception/customer-jobs-panel.js';
import type { MailComposeDeps } from '../../src/mail/mail-compose-host.js';
const NOW = Date.parse('2026-10-14T12:00:00Z');
const agreement: QuoteSignoffSummary = { signoff_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',quote_id: 'Q1',quote_version: 2,quote_revision: 1,
  quote_label: 'Drawings',quote_reference: 'Q-1',customer: 'Morgan',amount: '120.0000',currency: 'GBP',net: '100.0000',vat_amount: '20.0000',
  scope: 'Three drawings.',task_title: 'Deliver drawings',invoice_ref: 'INV-101',issued_on: '2026-10-11',due_on: '2026-10-31',state: 'released',availability: 'current',
  created_at: NOW,expires_at: NOW+7*86_400_000,endpoint_id: 'offer-endpoint',responded_at: NOW,released_at: NOW,task_id: 'task-1',invoice_id: 'invoice-1',
  can_request_completion: true,follow_up: { checked_at: NOW,task: { availability: 'current',title: 'Deliver drawings',done: false },
    invoice: { availability: 'current',status: 'open',amount_paid: '0.0000',outstanding: '120.0000',due_on: '2026-10-31',overdue: false } } };
const completion: QuoteCompletionSummary = { completion_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',signoff_id: agreement.signoff_id,root_signoff_id: agreement.signoff_id,
  quote_label: agreement.quote_label,customer: agreement.customer,business_name: 'Studio',agreed_scope: agreement.scope,delivery_summary: 'Delivered drawings.',customer_preview: 'Three drawings.\n\nDelivered drawings.',
  state: 'waiting',availability: 'current',created_at: NOW,expires_at: NOW+7*86_400_000,endpoint_id: 'completion-endpoint',
  response: { decision: 'not_recorded',received_at: null,recorded_at: null },owner_action: null };
const job: CustomerJob = { job_id: agreement.signoff_id,created_at: NOW,customer: agreement.customer,quote_label: agreement.quote_label,quote_reference: 'Q-1',currency: 'GBP',
  agreed_scope: agreement.scope,agreed_total: agreement.amount,offer: agreement,agreement,invoices: [agreement],work: 'in_progress',
  payment: { status: 'unpaid',amount_paid: '0.0000',outstanding: '120.0000',has_unpaid_balance: true,overdue: false },
  completion,completion_matches_agreement: true,offer_reply: 'received',waiting_customer: true,needs_owner_review: false,corrections: false,needs_attention: false,can_request_completion: true };
let reminder: QuoteCompletionReminder = { completion_id: completion.completion_id,revision: 0,due_at: null,status: 'unscheduled',has_saved_link: false,
  notified_at: null,drafted_at: null,delivery: 'not_prepared' };
let paymentReminder: QuotePaymentReminder = { signoff_id: agreement.signoff_id,revision: 0,due_at: null,status: 'unscheduled',notified_at: null,drafted_at: null,delivery: 'not_prepared',draft_stale: false };
let invoiceRevision = 1;let draftedInvoiceRevision: number | undefined;
const currentInvoice = () => { const invoice = agreement.follow_up!.invoice;if (invoice.availability !== 'current') throw new Error('Invoice unavailable');return invoice; };
const calls: Array<{ method: string;payload: unknown }> = [];
const record = (method: string,payload: unknown) => { calls.push({ method,payload: structuredClone(payload) }); };
let draft: MailDraft | undefined;let failMail = false;let deferred: (() => void) | undefined;let deferGet = false;
const clone = <T>(value: T): T => structuredClone(value);
const conn = (async (method: string,payload?: unknown) => {
  record(method,payload);
  const input = payload as { signoff_id?: string;completion_id?: string;expected_revision?: number;due_at?: number | null;sender_mail_instance?: string;recipient_email?: string;share_url?: string;remember_link_for_reminders?: boolean };
  if (method === 'reception.jobs.list') return { captured_at: NOW,jobs: [clone(job)] };
  if (method === 'reception.signoff.completion.reminders.list') return { reminders: ['due','scheduled'].includes(reminder.status) ? [{ completion: clone(completion),reminder: clone(reminder) }] : [] };
  if (method === 'reception.signoff.completion.reminders.get') {
    if (deferGet) { deferGet = false;await new Promise<void>(resolve => { deferred = resolve; }); }
    return clone(reminder);
  }
  if (method === 'reception.signoff.completion.reminders.set') {
    if (input.completion_id !== completion.completion_id || input.expected_revision !== reminder.revision) throw new Error('This follow-up changed. Refresh and review it again.');
    reminder = { ...reminder,revision: reminder.revision+1,due_at: input.due_at!,
      status: input.due_at === null ? 'paused' : input.due_at! <= NOW ? 'due' : 'scheduled',
      ...(input.sender_mail_instance !== undefined ? { sender_mail_instance: input.sender_mail_instance } : {}),
      ...(input.recipient_email !== undefined ? { recipient_email: input.recipient_email } : {}),has_saved_link: reminder.has_saved_link || !!input.share_url,delivery: 'not_prepared' };
    return clone(reminder);
  }
  if (method === 'reception.signoff.payment.reminders.list') return { reminders: ['due','scheduled'].includes(paymentReminder.status) ? [{ invoice: { signoff_id: agreement.signoff_id,invoice_id: agreement.invoice_id,customer: agreement.customer,quote_label: agreement.quote_label,invoice_ref: agreement.invoice_ref,currency: agreement.currency,amount: agreement.amount,invoice: clone(currentInvoice()) },reminder: clone(paymentReminder) }] : [] };
  if (method === 'reception.signoff.payment.reminders.get') {
    if (deferGet) { deferGet = false;await new Promise<void>(resolve => { deferred = resolve; }); }
    return clone(paymentReminder);
  }
  if (method === 'reception.signoff.payment.reminders.set') {
    if (input.signoff_id !== agreement.signoff_id || input.expected_revision !== paymentReminder.revision) throw new Error('This follow-up changed. Refresh and review it again.');
    paymentReminder = { ...paymentReminder,revision: paymentReminder.revision+1,due_at: input.due_at!,draft_stale: false,delivery: 'not_prepared',
      status: input.due_at === null ? 'paused' : input.due_at! <= NOW ? 'due' : 'scheduled',
      ...(input.sender_mail_instance !== undefined ? { sender_mail_instance: input.sender_mail_instance } : {}),
      ...(input.recipient_email !== undefined ? { recipient_email: input.recipient_email } : {}) };
    return clone(paymentReminder);
  }
  if (method === 'reception.signoff.payment.reminders.draft') {
    if (paymentReminder.draft_stale) throw new Error('The invoice changed. Save a new follow-up.');draftedInvoiceRevision = invoiceRevision;
    const invoice = currentInvoice();const ref = `qpr_${agreement.signoff_id}_${paymentReminder.revision}`;
    const content: MailDraftContent = { sender_mail_instance: paymentReminder.sender_mail_instance!,to: [paymentReminder.recipient_email!],subject: `Payment reminder: ${agreement.invoice_ref}`,
      body: `Hello Morgan,\n\nInvoice ${agreement.invoice_ref}: ${invoice.outstanding} GBP recorded outstanding; due ${invoice.due_on}.\n\nIf you already paid, please let us know.`,body_format: 'text',reconciliation_id: ref };
    return { idempotency_key: ref,content };
  };

  if (method === 'reception.signoff.completion.reminders.draft') {
    const ref = `qcr_${completion.completion_id}_${reminder.revision}`;
    const content: MailDraftContent = { sender_mail_instance: reminder.sender_mail_instance!,to: [reminder.recipient_email!],subject: 'Reminder: please confirm delivery for Drawings',
      body: 'Please review the delivered drawings.\n\nhttps://fixture.example.test/reception/approve/completion-endpoint?t=fixture-token',body_format: 'text',reconciliation_id: ref };
    return { idempotency_key: ref,content };
  }
  if (method === 'reception.signoff.completion.prepare') return { completion: { ...clone(completion),state: 'draft' },preview_hash: 'b'.repeat(64),customer_preview: completion.customer_preview };
  if (method === 'reception.signoff.completion.publish') {
    if (input.remember_link_for_reminders) reminder.has_saved_link = true;
    return { completion: clone(completion),share_url: 'https://fixture.example.test/reception/approve/completion-endpoint?t=fixture-token' };
  }
  throw new Error(`Unexpected fixture method: ${method}`);
}) as CustomerJobsConn;
const mail: MailComposeDeps = {
  listMailInstances: async () => { if (failMail) throw new Error('Mail unavailable');return { instances: [{ slug: 'work',adapter_type: 'imap',send_capable: true,draft_capable: true,account_email: 'owner@example.test' }] }; },
  runExecute: async args => { record('execute',args);
    if (String(args.config?.reconciliation_id).startsWith('qpr_')) {
      if (currentInvoice().status !== 'open') throw new Error('This invoice is no longer open for follow-up.');
      if (draftedInvoiceRevision !== invoiceRevision) throw new Error('The invoice changed after this draft was prepared.');
    } else if (reminder.status === 'stopped') throw new Error('The customer replied. This completion reminder is stopped.');
    return { success: true,awaiting_approval: true };
  },
  drafts: {
    create: async args => { record('mail.drafts.create',args);draft = { draft_id: 'mad_cccccccc-cccc-cccc-cccc-cccccccccccc',incarnation: 'fixture-generation',revision: 1,
      content: clone(args.content),origin_contract_id: null,created_at: NOW,updated_at: NOW };if (String(args.content.reconciliation_id).startsWith('qpr_')) paymentReminder.delivery = 'draft_ready';else reminder.delivery = 'draft_ready';return clone(draft); },
    get: async () => { if (!draft) throw new Error('Missing fixture draft');return clone(draft); },
    list: async () => ({ drafts: draft ? [{ draft_id: draft.draft_id,incarnation: draft.incarnation,revision: draft.revision,
      origin_contract_id: draft.origin_contract_id,created_at: draft.created_at,updated_at: draft.updated_at,subject: draft.content.subject,sender_mail_instance: draft.content.sender_mail_instance }] : [],next_cursor: '' }),
    update: async args => { if (!draft) throw new Error('Missing fixture draft');draft = { ...draft,content: clone(args.content),revision: draft.revision+1 };return clone(draft); },
    delete: async () => { draft = undefined;return { deleted: true }; },
    prepare: async args => { record('mail.drafts.prepare',args);return { proposal_id: 'fixture-proposal',revision: 1,future_execution_ref: 'fixture-execution',status: 'awaiting_owner',coverage: 'complete',eligible_members: 1,uncovered_calls: 0 }; },
    openReview: id => { record('preapproval.open',{ proposal_id: id }); },
  },
};
const board = mountCustomerJobsPanel({ host: document.getElementById('root')!,document,conn,reminders: { mail,now: () => NOW } });
export interface PaymentRemindersFixture {
  calls: typeof calls;update(): void;dispose(): void;due(): void;completionDue(): void;partial(): void;settle(): void;expireOffer(): void;reply(): void;failMail(): void;deferGet(): void;release(): void;hasUnsavedChanges(): boolean;hasInFlightWork(): boolean;
}
declare global { interface Window { __paymentReminders: PaymentRemindersFixture } }
window.__paymentReminders = { calls,update: board.update,dispose: board.dispose,hasUnsavedChanges: board.hasUnsavedChanges,hasInFlightWork: board.hasInFlightWork,
  completionDue: () => { reminder = { ...reminder,revision: 1,due_at: NOW,status: 'due',has_saved_link: true,sender_mail_instance: 'work',recipient_email: 'morgan@example.test' };board.update(); },
  reply: () => { completion.response.decision = 'accepted';completion.response.received_at = NOW;job.waiting_customer = false;reminder.status = 'stopped';board.update(); },
  due: () => { paymentReminder = { ...paymentReminder,revision: 1,due_at: NOW,status: 'due',sender_mail_instance: 'work',recipient_email: 'morgan@example.test' };board.update(); },
  partial: () => { const invoice = currentInvoice();invoice.amount_paid = '20.0000';invoice.outstanding = '100.0000';invoiceRevision++;
    paymentReminder.draft_stale = draftedInvoiceRevision !== undefined && draftedInvoiceRevision !== invoiceRevision;
    job.payment = { ...job.payment,status: 'part_paid',amount_paid: '20.0000',outstanding: '100.0000' };board.update(); },
  settle: () => { const invoice = currentInvoice();invoice.status = 'settled';invoice.amount_paid = '120.0000';invoice.outstanding = '0.0000';invoiceRevision++;
    paymentReminder.status = 'stopped';job.payment = { ...job.payment,status: 'paid',amount_paid: '120.0000',outstanding: '0.0000',has_unpaid_balance: false };board.update(); },
  expireOffer: () => { agreement.expires_at = NOW-86_400_000;board.update(); },
  failMail: () => { failMail = true; },deferGet: () => { deferGet = true; },release: () => { deferred?.();deferred = undefined; } };
