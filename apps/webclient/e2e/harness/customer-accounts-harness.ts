import {mountCustomerWorkHarness} from './customer-work-harness.js';
import { createAccountContactFixture,type AccountContactFixtureControls } from './customer-account-contacts-fixture.js';
import type { CustomerAccountContactDefaultsSetInput } from '@recued/contracts';
/** Production jobs, account editor, statement viewer and Mail composer. Server
 * tests cover real SQLite, encrypted selections and final dispatch validation. */
import { customerAccountPaymentReminderLines,type CustomerAccountPaymentReminder,type CustomerAccountPaymentReminderSetInput,customerAccountStatementLines,type CustomerAccount,type CustomerAccountSaveInput,type CustomerAccountStatement,
  type CustomerJob,type CustomerJobPaymentStatement,type QuoteSignoffSummary,type MailDraft,type MailDraftContent } from '@recued/contracts';
import { mountCustomerJobsPanel,type CustomerJobsConn } from '../../src/reception/customer-jobs-panel.js';
import type { MailComposeDeps } from '../../src/mail/mail-compose-host.js';
const NOW = Date.parse('2026-10-15T12:00:00Z');
const id = (n: number) => `aaaaaaaa-aaaa-aaaa-aaaa-${String(n).padStart(12,'0')}`;
const clone = <T>(value: T): T => structuredClone(value);
const calls: Array<{ method: string;payload: unknown }> = [];
const record = (method: string,payload: unknown) => { calls.push({ method,payload: clone(payload) }); };
const job = (n: number): CustomerJob => {
  const offer: QuoteSignoffSummary = { signoff_id: id(n),quote_id: 'Q'+n,quote_version: 2,quote_revision: 1,quote_label: 'Job '+n,quote_reference: 'Q-'+n,
    customer: 'Morgan',amount: '120.0000',currency: n === 2 ? 'EUR' : 'GBP',net: '100.0000',vat_amount: '20.0000',scope: 'Agreed work.',task_title: 'PRIVATE task',
    invoice_ref: 'INV-'+n,issued_on: '2026-10-11',due_on: '2026-10-31',state: 'released',availability: 'current',created_at: NOW,expires_at: NOW+86400000,
    endpoint_id: 'ep-'+n,responded_at: NOW,released_at: NOW,task_id: 'task-'+n,invoice_id: 'invoice-'+n,can_request_completion: true,
    follow_up: { checked_at: NOW,task: { availability: 'current',title: 'PRIVATE task',done: false },
      invoice: { availability: 'current',status: 'open',amount_paid: '30.0000',outstanding: '90.0000',due_on: '2026-10-31',overdue: false } } };
  return { job_id: id(n),created_at: NOW,customer: offer.customer,quote_label: offer.quote_label,quote_reference: offer.quote_reference,currency: offer.currency,
    agreed_scope: offer.scope,agreed_total: offer.amount,offer,agreement: offer,invoices: [offer],work: 'in_progress',
    payment: { status: 'part_paid',amount_paid: '30.0000',outstanding: '90.0000',has_unpaid_balance: true,overdue: false },
    completion: null,completion_matches_agreement: false,offer_reply: 'received',waiting_customer: false,needs_owner_review: false,corrections: false,needs_attention: false,can_request_completion: true };
};
const jobs = [1,2,3].map(job);
const accounts: CustomerAccount[] = [{ account_id: id(100),revision: 1,customer: 'Morgan <img src=x onerror=alert(1)>',job_ids: [id(1),id(2)],created_at: NOW,updated_at: NOW },
  { account_id: id(101),revision: 1,customer: 'Other customer',job_ids: [],created_at: NOW,updated_at: NOW }];
const reminders = new Map<string,CustomerAccountPaymentReminder>();const reminderBindings = new Map<string,number>();let settled = false;let reminderFails = false;
let revision = 1;let failSave = false;let failList = false;let failStatement = false;let invalidStatement = false;let failMail = false;let sendSuccess = false;
let hold = '';let pending: (() => void) | undefined;let savedRevision = 0;let draft: MailDraft | undefined;let savedCore = '';
const digest = () => revision.toString(16).padStart(64,'0');
const defer = async (kind: string) => { if (hold === kind) { hold = '';await new Promise<void>(resolve => { pending = resolve; }); } };
const jobStatement = (job: CustomerJob): CustomerJobPaymentStatement => ({ format: 'recued.customer-job-payment-statement',version: 3,captured_at: NOW,statement_hash: digest(),
  job_id: job.job_id,business_name: 'Studio',customer: job.customer,quote_label: job.quote_label,quote_reference: job.quote_reference,currency: job.currency,
  invoiced_total: '120.0000',amount_paid: '30.0000',outstanding: '90.0000',amount_refund_credited: '10.0000',amount_refunded: '2.0000',refund_due: '8.0000',net_received: '28.0000',net_invoice_total: '110.0000',
  invoices: [{ signoff_id: job.job_id,invoice_id: job.offer.invoice_id!,invoice_ref: job.offer.invoice_ref,revision: 0,issued_on: '2026-10-11',due_on: '2026-10-31',
    total: '120.0000',amount_paid: '30.0000',outstanding: '90.0000',payments: [{ payment_id: 'P'+job.job_id,amount: '30.0000',received_on: '2026-10-12',reference: '<script>alert(1)</script>' }] }] });
const statement = (account: CustomerAccount): CustomerAccountStatement => {
  if (failStatement) throw new Error('Invoice INV-2 needs review in Records before preparing a complete job statement.');
  const selected = jobs.filter(job => account.job_ids.includes(job.job_id)).map(jobStatement);
  const money = (n: number) => `${n}.0000`;
  return { format: 'recued.customer-account-statement',version: 1,captured_at: NOW,statement_hash: digest(),account_id: invalidStatement ? id(999) : account.account_id,
    account_revision: account.revision,customer: account.customer,business_name: 'Studio',jobs: selected,
    balances: [...new Set(selected.map(job => job.currency))].sort().map(currency => { const n = selected.filter(job => job.currency === currency).length;
      return { currency,invoiced_total: money(120*n),amount_paid: money(30*n),amount_credited: '0.0000',amount_refund_credited: money(10*n),amount_refunded: money(2*n),outstanding: money(90*n),refund_due: money(8*n),net_received: money(28*n) };
    }) };
};
const describeReminder = (account_id: string): CustomerAccountPaymentReminder => {
  const row = reminders.get(account_id) ?? { account_id,revision: 0,due_at: null,status: 'unscheduled',draft_stale: false,notified_at: null,drafted_at: null,delivery: 'not_prepared' };
  return { ...clone(row),status: !row.revision ? 'unscheduled' : row.due_at === null ? 'paused' : settled || row.delivery === 'sent' ? 'stopped' : row.due_at <= NOW ? 'due' : 'scheduled',
    draft_stale: row.drafted_at !== null && reminderBindings.get(account_id) !== revision };
};
const dueReminder = () => {
  reminders.set(id(100),{ account_id: id(100),revision: 1,due_at: NOW,status: 'due',draft_stale: false,
    sender_mail_instance: 'work',recipient_email: 'morgan@example.test',notified_at: null,drafted_at: null,delivery: 'not_prepared' });board.update();
};
let contactSenderMode = 'normal';
const contacts = createAccountContactFixture(NOW,id(100),account_id => accounts.some(account => account.account_id === account_id));
const conn = (async (method: string,payload?: unknown) => {
  record(method,payload);await defer(method);
  const input = payload as { account_id?: string;job_id?: string;cursor?: string;limit?: number;search?: string;sender_mail_instance?: string;recipient_email?: string;expected_statement_hash?: string };
  if (method === 'reception.jobs.list') {
    const rows = jobs.filter(job => !input.search || (job.customer+job.quote_label+job.quote_reference).toLowerCase().includes(input.search.toLowerCase()));
    const start = Number(input.cursor ?? 0);return { captured_at: NOW,jobs: clone(rows.slice(start,start+2)),...(start+2 < rows.length ? { next_cursor: String(start+2) } : {}) };
  }
  if (method === 'reception.accounts.payment.reminders.get') return describeReminder(input.account_id!);
  if (method === 'reception.accounts.payment.reminders.set') {
    if (reminderFails) throw new Error('The follow-up changed. Refresh and review it again.');
    const fields = payload as CustomerAccountPaymentReminderSetInput;const before = describeReminder(fields.account_id);
    if (before.revision !== fields.expected_revision) throw new Error('The follow-up changed. Refresh and review it again.');
    if (before.delivery === 'uncertain' && fields.due_at !== null) throw new Error('Check the previous email outcome in Mail.');
    const saved: CustomerAccountPaymentReminder = { ...before,revision: before.revision+1,due_at: fields.due_at,
      ...(fields.sender_mail_instance !== undefined ? { sender_mail_instance: fields.sender_mail_instance } : {}),
      ...(fields.recipient_email !== undefined ? { recipient_email: fields.recipient_email } : {}),draft_stale: false,drafted_at: null,notified_at: null,delivery: 'not_prepared' };
    reminders.set(fields.account_id,saved);return describeReminder(fields.account_id);
  }
  if (method === 'reception.accounts.payment.reminders.list') {
    const rows = [...reminders.keys()].map(account_id => ({ account: accounts.find(account => account.account_id === account_id)!,reminder: describeReminder(account_id) }))
      .filter(row => row.reminder.status === 'due' || row.reminder.status === 'scheduled');
    const start = Number(input.cursor ?? 0);const limit = input.limit ?? 50;
    return { reminders: rows.slice(start,start+limit).map(({ account,reminder }) => ({ reminder,account: { account_id: account.account_id,customer: account.customer,
      job_count: account.job_ids.length,balances: [{ currency: 'GBP',outstanding: '90.0000' },{ currency: 'EUR',outstanding: '90.0000' }] } })),
      ...(start+limit < rows.length ? { next_cursor: String(start+limit) } : {}) };
  }
  if (method === 'reception.accounts.payment.reminders.draft') {
    const reminder = describeReminder(input.account_id!);const fields = payload as { expected_revision: number };
    if (reminder.status !== 'due') throw new Error('This account has no available unpaid invoices.');
    if (reminder.revision !== fields.expected_revision || reminder.draft_stale) throw new Error('The account or billing records changed. Save the follow-up again.');
    if (reminder.delivery === 'uncertain') throw new Error('Check the previous email outcome in Mail.');
    const copy = statement(accounts.find(account => account.account_id === input.account_id)!);
    savedCore = customerAccountPaymentReminderLines(copy).join('\n');savedRevision = revision;
    reminderBindings.set(input.account_id!,revision);reminders.set(input.account_id!,{ ...reminder,drafted_at: NOW,delivery: 'draft_ready' });
    const reference = `qapr_${input.account_id}_${reminder.revision}`;
    return { idempotency_key: reference,content: { sender_mail_instance: reminder.sender_mail_instance,to: [reminder.recipient_email],
      subject: `Account payment reminder: ${copy.customer}`,body_format: 'text',body: savedCore,reconciliation_id: reference } };
  }
  if (method.endsWith('.reminders.list')) return { reminders: [],next_cursor: '' };
  if (method === 'reception.accounts.list') {
    if (failList) throw new Error('Accounts unavailable. Try again.');
    const rows = accounts.filter(row => !input.cursor || row.account_id > input.cursor).sort((a,b) => a.account_id < b.account_id ? -1 : 1);
    const limit = input.limit ?? 25;return { accounts: clone(rows.slice(0,limit)),...(rows.length > limit ? { next_cursor: rows[limit-1]!.account_id } : {}) };
  }
  if (method === 'reception.accounts.contact.get') return contacts.get(String(input.account_id));
  if (method === 'reception.accounts.contact.set') return contacts.set(payload as CustomerAccountContactDefaultsSetInput);
  if (method === 'reception.accounts.get') return clone(accounts.find(row => row.account_id === input.account_id)!);
  if (method === 'reception.accounts.save') {
    if (failSave) throw new Error('The account changed. Refresh and review its saved selection.');const fields = payload as CustomerAccountSaveInput;
    const current = accounts.find(row => row.account_id === fields.account_id);if ((current?.revision ?? 0) !== fields.expected_revision) throw new Error('The account changed. Refresh its saved selection.');
    if (accounts.some(row => row.account_id !== fields.account_id && fields.job_ids.some(id => row.job_ids.includes(id)))) throw new Error('A selected job belongs to another account.');
    const saved: CustomerAccount = { account_id: fields.account_id,revision: fields.expected_revision+1,customer: fields.customer,job_ids: fields.job_ids,created_at: current?.created_at ?? NOW,updated_at: NOW };
    if (current) Object.assign(current,saved);else accounts.push(saved);revision++;return clone(saved);
  }
  if (method === 'reception.accounts.statement') return statement(accounts.find(row => row.account_id === input.account_id)!);
  if (method === 'reception.jobs.payment.statement') return jobStatement(jobs.find(row => row.job_id === input.job_id)!);
  if (method === 'reception.accounts.statement.draft') {
    if (input.expected_statement_hash !== digest()) throw new Error('The account or billing records changed. Refresh and review a new account statement.');
    const copy = statement(accounts.find(row => row.account_id === input.account_id)!);savedCore = customerAccountStatementLines(copy).join('\n');savedRevision = revision;
    const reference = 'qac_'+digest();const content: MailDraftContent = { sender_mail_instance: input.sender_mail_instance!,to: [input.recipient_email!],subject: 'Customer account statement: '+copy.customer,body_format: 'text',body: savedCore,reconciliation_id: reference };
    return { idempotency_key: reference,content };
  }
  throw new Error('Unexpected fixture RPC '+method);
}) as CustomerJobsConn;
const mail: MailComposeDeps = {
  listMailInstances: async () => { await defer('mail.accounts');if (failMail) throw new Error('Mail unavailable');return { instances: [...(contactSenderMode === 'missing' ? [] : [{ slug: 'work',adapter_type: 'imap',send_capable: contactSenderMode !== 'read_only',draft_capable: true,account_email: 'owner@example.test' }]),{ slug: 'other',adapter_type: 'imap',send_capable: true,draft_capable: true,account_email: 'other-owner@example.test' }] }; },
  runExecute: async args => { record('execute',args);if (savedRevision !== revision) throw new Error('The account or billing records changed. Refresh the account statement.');
    const body = args.config?.body ?? args.config?.body_text;if (typeof body !== 'string' || !body.includes(savedCore)) throw new Error('Keep the complete account statement.');
    return sendSuccess ? { success: true,output: { message_id: '<fixture@example.test>' } } : { success: false,awaiting_approval: true }; },
  drafts: {
    create: async args => { record('mail.drafts.create',args);await defer('mail.drafts.create');draft = { draft_id: 'mad_cccccccc-cccc-cccc-cccc-cccccccccccc',incarnation: 'fixture',revision: 1,content: clone(args.content),origin_contract_id: null,created_at: NOW,updated_at: NOW };return clone(draft); },
    get: async () => { if (!draft) throw new Error('Missing draft');return clone(draft); },
    list: async () => ({ drafts: draft ? [{ draft_id: draft.draft_id,incarnation: draft.incarnation,revision: draft.revision,origin_contract_id: null,created_at: NOW,updated_at: NOW,subject: draft.content.subject,sender_mail_instance: draft.content.sender_mail_instance }] : [],next_cursor: '' }),
    update: async args => { if (!draft) throw new Error('Missing draft');draft = { ...draft,content: clone(args.content),revision: draft.revision+1 };return clone(draft); },
    delete: async () => { draft = undefined;return { deleted: true }; },
    prepare: async args => { record('mail.drafts.prepare',args);return { proposal_id: 'fixture-review',revision: 1,future_execution_ref: 'fixture-execution',status: 'awaiting_owner',coverage: 'complete',eligible_members: 1,uncovered_calls: 0 }; },
    openReview: proposal_id => record('preapproval.open',proposal_id),
  },
};
const board = mountCustomerWorkHarness({ host: document.getElementById('root')!,document,conn,reminders: { mail,now: () => NOW } });
export interface CustomerAccountsFixture extends AccountContactFixtureControls {
  contactSenderMode(mode: 'normal' | 'missing' | 'read_only'): void;
  otherStatement(): void;
  calls: typeof calls;update(): void;dispose(): void;hasUnsavedChanges(): boolean;hasInFlightWork(): boolean;
  reminderDue(): void;reminderFail(): void;settle(): void;uncertainReminder(): void;manyReminders(): void;
  hold(method: string): void;pending(): boolean;release(): void;change(): void;failSave(): void;failList(value: boolean): void;failStatement(): void;invalid(): void;failMail(): void;sendSuccess(): void;many(): void;
}
declare global { interface Window { __customerAccounts: CustomerAccountsFixture } }
window.__customerAccounts = { calls,...contacts.controls,contactSenderMode: mode => { contactSenderMode = mode; },otherStatement: () => { accounts[1]!.job_ids=[id(3)];revision++; },reminderDue: dueReminder,reminderFail: () => { reminderFails = true; },settle: () => { settled = true;revision++;board.update(); },uncertainReminder: () => { dueReminder();reminders.get(id(100))!.delivery = 'uncertain';board.update(); },
  manyReminders: () => { dueReminder();for (let n = 102;n < 162;n++) { const account = { ...clone(accounts[0]!),account_id: id(n),customer: 'Account '+n };accounts.push(account);reminders.set(account.account_id,{ ...describeReminder(id(100)),account_id: account.account_id }); }board.update(); },update: board.update,dispose: board.dispose,hasUnsavedChanges: board.hasUnsavedChanges,hasInFlightWork: board.hasInFlightWork,
  hold: method => { hold = method; },pending: () => !!pending,release: () => { pending?.();pending = undefined; },change: () => { revision++; },
  failSave: () => { failSave = true; },failList: value => { failList = value; },failStatement: () => { failStatement = true; },invalid: () => { invalidStatement = true; },
  failMail: () => { failMail = true; },sendSuccess: () => { sendSuccess = true; },many: () => { for (let n = 102;n < 130;n++) accounts.push({ ...clone(accounts[1]!),account_id: id(n),customer: 'Account '+n }); },
};
