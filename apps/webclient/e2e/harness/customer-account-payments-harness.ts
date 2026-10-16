import { createAccountContactFixture,type AccountContactFixtureControls } from './customer-account-contacts-fixture.js';
import type { CustomerAccountContactDefaultsSetInput } from '@recued/contracts';
import { customerAccountPaymentReceiptLines,CUSTOMER_ACCOUNT_PAYMENT_RECIPE,CUSTOMER_ACCOUNT_PAYMENT_CORRECTION_RECIPE,
  type CustomerAccountPaymentCorrectionPrepareInput,type CustomerAccountPaymentCorrectionPreview,type CustomerAccountPaymentCorrectionRecord,type CustomerPaymentEntry,type CustomerAccount,type CustomerAccountStatement,
  type CustomerJobPaymentStatement,type CustomerAccountPaymentPrepareInput,type CustomerAccountPaymentPreview,type CustomerAccountPaymentReceipt,
  type CustomerAccountPaymentRecord,type MailDraft,type MailDraftContent,type Recipe } from '@recued/contracts';
import { mountCustomerAccountsPanel,type CustomerAccountsConn } from '../../src/reception/customer-accounts-panel.js';
import type { MailComposeDeps } from '../../src/mail/mail-compose-host.js';
const NOW = Date.parse('2026-10-15T10:00:00Z');const id = (n: number) => `aaaaaaaa-aaaa-aaaa-aaaa-${String(n).padStart(12,'0')}`;
const clone = <T>(v: T): T => structuredClone(v);const calls: Array<{ method: string;payload?: unknown }> = [];
let revision = 1;let hold = '';let pending: (() => void) | undefined;let mode = 'approval';let mailFails = false;let failPrepare = false;
let prepared: CustomerAccountPaymentPreview | null = null;let draft: MailDraft | undefined;let reservedRevision = 0;let core = '';let many = false;let hasRefund = false;let otherAccount = false;let billingFails = false;let receiptFails = false;
const account: CustomerAccount = { account_id: id(100),revision: 1,customer: 'Morgan <studio>',job_ids: [id(1),id(2),id(3)],created_at: NOW,updated_at: NOW };
const payments: CustomerAccountPaymentRecord[] = [];
let correction: CustomerAccountPaymentCorrectionPreview | null = null;
const corrections: CustomerAccountPaymentCorrectionRecord[] = [];const currentEntries = new Map<string,CustomerPaymentEntry | null>();let manyCorrections = false;
const units = (v: string) => { if (!/^\d+(\.\d{1,4})?$/.test(v)) throw new Error('Enter an amount with up to four decimal places.');const [w,f = ''] = v.split('.');return BigInt(w!)*10000n+BigInt(f.padEnd(4,'0')); };
const decimal = (n: bigint) => `${n/10000n}.${String(n%10000n).padStart(4,'0')}`;
const digest = () => revision.toString(16).padStart(64,'0');
const record = (method: string,payload?: unknown) => { calls.push({ method,...(payload === undefined ? {} : { payload: clone(payload) }) }); };
const defer = async (method: string) => { if (hold === method) { hold = '';await new Promise<void>(resolve => { pending = resolve; }); } };
const jobs = (): CustomerJobPaymentStatement[] => [1,2,3].map(n => ({
  format: 'recued.customer-job-payment-statement',version: 2,captured_at: NOW,statement_hash: digest(),job_id: id(n),business_name: 'Studio',customer: 'Morgan',quote_label: `Job ${n}`,
  currency: n === 3 ? 'EUR' : 'GBP',invoiced_total: '120.0000',amount_paid: '0.0000',outstanding: '120.0000',
  invoices: [{ signoff_id: id(n),invoice_id: 'invoice-'+n,invoice_ref: 'INV-'+n,revision: 1,issued_on: '2026-10-01',due_on: '2026-10-30',total: '120.0000',amount_paid: '0.0000',outstanding: '120.0000',payments: [] }],
}));
const statement = (): CustomerAccountStatement => ({ format: 'recued.customer-account-statement',version: 1,captured_at: NOW,statement_hash: digest(),account_id: account.account_id,account_revision: account.revision,
  business_name: 'Studio',customer: account.customer,jobs: jobs(),balances: ['EUR','GBP'].map(currency => ({ currency,invoiced_total: currency === 'GBP' ? '240.0000' : '120.0000',amount_paid: '0.0000',amount_credited: '0.0000',amount_refund_credited: '0.0000',amount_refunded: '0.0000',outstanding: currency === 'GBP' ? '240.0000' : '120.0000',refund_due: '0.0000',net_received: '0.0000' })) });
const receipt = (payment: CustomerAccountPaymentRecord): CustomerAccountPaymentReceipt => {
  const allocations = payment.allocations.map((a,n) => {
    const entry = currentEntries.has(a.payment_id) ? currentEntries.get(a.payment_id)! : { payment_id: a.payment_id,amount: a.amount,received_on: payment.received_on,...(payment.method ? { method: payment.method } : {}),...(payment.reference ? { reference: payment.reference } : {}) };
    return { ...a,...(hasRefund && n === 0 ? { amount_refund_credited: '10.0001',amount_refunded: '7.0001',refund_due: '3.0000',net_received: '23.0000',net_invoice_total: '109.9999' } : {}),
      state: !entry ? 'removed' as const : JSON.stringify(entry) === JSON.stringify({ payment_id: a.payment_id,amount: a.amount,received_on: payment.received_on,...(payment.method ? { method: payment.method } : {}),...(payment.reference ? { reference: payment.reference } : {}) }) ? 'unchanged' as const : 'changed' as const,
      current_payment: entry,current_paid: entry?.amount ?? '0.0000',current_outstanding: decimal(1200000n-units(entry?.amount ?? '0')) };
  });
  return { format: 'recued.customer-account-payment-receipt',version: 1,statement_hash: digest(),captured_at: NOW,payment: clone(payment),
    current_allocated: decimal(allocations.reduce((n,a)=>n+units(a.current_payment?.amount ?? '0'),0n)),allocations };
};
let contactSenderMode = 'normal';
const contacts = createAccountContactFixture(NOW,id(100),account_id => account_id === account.account_id || otherAccount && account_id === id(101));
const conn = (async (method: string,payload?: unknown) => {
  record(method,payload);await defer(method);const input = payload as Record<string,unknown>;
  if (method === 'reception.accounts.payment.reminders.list') return { reminders: [] };
  if (method === 'reception.accounts.payment.reminders.get') return { account_id: input.account_id,revision: 0,due_at: null,status: 'unscheduled',draft_stale: false,notified_at: null,drafted_at: null,delivery: 'not_prepared' };
  if (method === 'reception.accounts.list') return { accounts: [clone(account),...(otherAccount ? [{ ...clone(account),account_id: id(101),customer: 'Casey',job_ids: [] }] : [])] };
  if (method === 'reception.accounts.contact.get') return contacts.get(String(input.account_id));
  if (method === 'reception.accounts.contact.set') return contacts.set(payload as CustomerAccountContactDefaultsSetInput);
  if (method === 'reception.accounts.get') return input.account_id === id(101) ? { ...clone(account),account_id: id(101),customer: 'Casey',job_ids: [] } : clone(account);
  if (method === 'reception.accounts.statement') { if (billingFails || input.account_id === id(101)) throw new Error('The selected account billing records are unavailable. Review Records.');return statement(); }
  if (method === 'reception.accounts.payment.history') {
    if (input.account_id === id(101)) return { payments: [] };
    const rows = many ? Array.from({ length: 27 },(_,n) => ({ ...payments[0]!,account_payment_id: id(200+n) })) : payments;
    const start = Number(input.cursor ?? 0);return { payments: clone(rows.slice(start,start+25)),...(start+25 < rows.length ? { next_cursor: String(start+25) } : {}) };
  }
  if (method === 'reception.accounts.payment.correction.history') {
    const list = manyCorrections && corrections[0] ? Array.from({length:27},(_,n)=>({...corrections[0]!,correction_id:id(800+n)})) : corrections;
    const start = Number(input.cursor ?? 0);return { corrections: clone(list.slice(start,start+25)),...(start+25 < list.length ? {next_cursor:String(start+25)} : {}) };
  }
  if (method === 'reception.accounts.payment.correction.prepare') {
    if (failPrepare) throw new Error('The correction could not be prepared. Try again.');const p = payload as CustomerAccountPaymentCorrectionPrepareInput;
    if (p.expected_receipt_hash !== digest()) throw new Error('The payment or invoice entries changed. Refresh the correction.');
    const original = payments.find(a=>a.account_payment_id===p.account_payment_id)!;const copy = receipt(original);const active = copy.allocations.filter(a=>a.current_payment);
    if (!p.reason.trim()) throw new Error('Give a correction reason.');
    if (p.action==='correct' && p.allocations!.reduce((n,a)=>n+units(a.amount),0n)!==units(p.amount!)) throw new Error('Allocate the exact corrected total.');
    const c: CustomerAccountPaymentCorrectionRecord = { correction_id:id(700),account_payment_id:original.account_payment_id,account_id:original.account_id,customer:original.customer,currency:original.currency,
      action:p.action,reason:p.reason,before_amount:copy.current_allocated,after_amount:p.action==='void'?'0.0000':decimal(units(p.amount!)),prepared_at:NOW,prepared_by:'owner',applied_at:null,
      allocations:active.map((a,n)=>{const amount=p.action==='void'?'0.0000':decimal(units(p.allocations!.find(b=>b.payment_id===a.payment_id)!.amount));const removed=units(amount)===0n;
        return { correction_id:id(710+n),signoff_id:a.signoff_id,payment_id:a.payment_id,invoice_id:a.invoice_id,invoice_ref:a.invoice_ref,currency:original.currency,action:removed?'void':'correct',reason:p.reason,
          before:clone(a.current_payment!),after:removed?null:{payment_id:a.payment_id,amount,received_on:p.received_on!,...(p.method?{method:p.method}:{}),...(p.reference?{reference:p.reference}:{})},
          before_balance:{amount_paid:a.current_paid,outstanding:a.current_outstanding,status:'open'},after_balance:{amount_paid:amount,outstanding:decimal(1200000n-units(amount)),status:'open'},prepared_at:NOW,prepared_by:'owner',applied_at:null };
      }) };
    correction={correction:c,review:{correction_id:c.correction_id,expected_plan_hash:digest(),summary:`${p.action==='void'?'Void':'Correct'} account payment ${original.account_payment_id}.\n`+c.allocations.map(a=>`${a.invoice_ref}: ${a.before.amount} → ${a.after?.amount ?? 'removed'}`).join('\n')+'\nReason: '+p.reason}};
    corrections.splice(0,corrections.length,clone(c));return clone(correction);
  }
  if (method === 'reception.accounts.payment.prepare') {
    if (failPrepare) throw new Error('The payment could not be prepared. Try again.');const p = payload as CustomerAccountPaymentPrepareInput;
    if (p.expected_statement_hash !== digest()) throw new Error('The account or invoice balances changed. Refresh and preview again.');
    const units = (v: string) => { if (!/^\d+(\.\d{1,4})?$/.test(v)) throw new Error('Enter a positive amount with up to four decimal places.');const [w,f = ''] = v.split('.');return BigInt(w!)*10000n+BigInt(f.padEnd(4,'0')); };
    const decimal = (v: bigint) => `${v/10000n}.${String(v%10000n).padStart(4,'0')}`;
    if (!p.allocations.length || p.allocations.reduce((n,a) => n+units(a.amount),0n) !== units(p.amount)) throw new Error('The allocation amounts must add up exactly to the payment received.');
    const payment: CustomerAccountPaymentRecord = { account_payment_id: id(500),account_id: account.account_id,customer: account.customer,business_name: 'Studio',currency: p.currency,
      amount: decimal(units(p.amount)),received_on: p.received_on,method: p.method,reference: p.reference,prepared_at: NOW,prepared_by: 'owner',applied_at: null,
      allocations: p.allocations.map((a,n) => ({ job_id: a.signoff_id,signoff_id: a.signoff_id,invoice_id: 'invoice-'+Number(a.signoff_id.slice(-12)),invoice_ref: 'INV-'+Number(a.signoff_id.slice(-12)),payment_id: id(600+n),
        amount: decimal(units(a.amount)),before_paid: '0.0000',after_paid: decimal(units(a.amount)),before_outstanding: '120.0000',after_outstanding: decimal(1200000n-units(a.amount)) })) };
    prepared = { payment,review: { account_payment_id: payment.account_payment_id,expected_plan_hash: digest(),summary: `Record ${payment.amount} ${payment.currency} for ${payment.customer}.\n`+payment.allocations.map(a => `${a.invoice_ref}: ${a.amount}; outstanding ${a.after_outstanding}`).join('\n') } };
    payments.splice(0,payments.length,clone(payment));return clone(prepared);
  }
  if (method === 'reception.accounts.payment.receipt') {
    if (receiptFails) throw new Error('The selected payment receipt is unavailable.');
    const p = payments.find(p => p.account_payment_id === input.account_payment_id);if (!p || p.applied_at === null) throw new Error('Approve this account payment before preparing a receipt.');return receipt(p);
  }
  if (method === 'reception.accounts.payment.receipt.draft') {
    if (input.expected_receipt_hash !== digest()) throw new Error('The payment entries changed. Refresh the receipt.');const p = payments.find(p => p.account_payment_id === input.account_payment_id)!;
    core = customerAccountPaymentReceiptLines(receipt(p)).join('\n');reservedRevision = revision;
    const content: MailDraftContent = { sender_mail_instance: String(input.sender_mail_instance),to: [String(input.recipient_email)],subject: 'Customer account payment receipt: '+p.customer,body_format: 'text',body: core,reconciliation_id: 'qap_'+digest() };
    return { idempotency_key: content.reconciliation_id,content };
  }
  throw new Error('Unexpected fixture RPC '+method);
}) as CustomerAccountsConn;
const mail: MailComposeDeps = {
  listMailInstances: async () => { await defer('mail.accounts');if (mailFails) throw new Error('Mail unavailable');return { instances: [...(contactSenderMode === 'missing' ? [] : [{ slug: 'work',adapter_type: 'imap',send_capable: contactSenderMode !== 'read_only',draft_capable: true,account_email: 'owner@example.test' }]),{ slug: 'other',adapter_type: 'imap',send_capable: true,draft_capable: true,account_email: 'other-owner@example.test' }] }; },
  runExecute: async args => { record('mail.execute',args);if (reservedRevision !== revision) throw new Error('The payment entries changed. Refresh the receipt.');
    const body = args.config?.body ?? args.config?.body_text;if (typeof body !== 'string' || !body.includes(core)) throw new Error('Keep the complete receipt.');return { success: false,awaiting_approval: true }; },
  drafts: {
    create: async args => { record('mail.drafts.create',args);draft = { draft_id: 'mad_cccccccc-cccc-cccc-cccc-cccccccccccc',incarnation: 'fixture',revision: 1,content: clone(args.content),origin_contract_id: null,created_at: NOW,updated_at: NOW };return clone(draft); },
    get: async () => { if (!draft) throw new Error('Missing draft');return clone(draft); },
    list: async () => ({ drafts: draft ? [{ draft_id: draft.draft_id,incarnation: draft.incarnation,revision: draft.revision,origin_contract_id: null,created_at: NOW,updated_at: NOW,subject: draft.content.subject,sender_mail_instance: draft.content.sender_mail_instance }] : [],next_cursor: '' }),
    update: async args => { if (!draft) throw new Error('Missing draft');draft = { ...draft,content: clone(args.content),revision: draft.revision+1 };return clone(draft); },
    delete: async () => { draft = undefined;return { deleted: true }; },
    prepare: async args => { record('mail.drafts.prepare',args);return { proposal_id: 'fixture-review',revision: 1,future_execution_ref: 'fixture-execution',status: 'awaiting_owner',coverage: 'complete',eligible_members: 1,uncovered_calls: 0 }; },openReview: proposal_id => record('preapproval.open',proposal_id),
  },
};
const panel = mountCustomerAccountsPanel({ host: document.getElementById('root')!,document,conn,mail,
  payment: { listRecipes: async () => { record('recipe.list');await defer('recipe.list');return { recipes: mode === 'missing' ? [] : [CUSTOMER_ACCOUNT_PAYMENT_RECIPE,CUSTOMER_ACCOUNT_PAYMENT_CORRECTION_RECIPE].map(recipe_id => ({ recipe_id,publisher_id: 'recued-core',recipe_hash: 'fixture',source: 'pair-sync' as const,installed_at: NOW,version: 1,recipe: { recipe_id,version: 1,metadata: { recipe_bundle: 'recued-core/reception-approval' } } as Recipe })) }; },
    execute: async args => { record('execute',args);await defer('execute');
      if (args.recipe_id===CUSTOMER_ACCOUNT_PAYMENT_CORRECTION_RECIPE) {
        if (!correction || args.config?.expected_plan_hash!==digest()) throw new Error('The payment or invoice entries changed. Preview again.');
        if (mode==='success') { for(const a of correction.correction.allocations) currentEntries.set(a.payment_id,clone(a.after));corrections[0]!.applied_at=NOW;revision++;return {recipe_id:args.recipe_id,recipe_hash:'fixture',success:true,output:{render:[],sidebar:[]},steps:[],errors:[],duration_ms:1}; }
        return {run_id:'fixture-account-correction-run',recipe_id:args.recipe_id,recipe_hash:'fixture',success:false,awaiting_approval:true,output:{render:[],sidebar:[]},steps:[],errors:[],duration_ms:1};
      }
      if (!prepared || args.config?.expected_plan_hash !== digest()) throw new Error('The account or invoice balances changed. Preview again.');
      if (mode === 'success') { payments[0]!.applied_at = NOW;revision++;return { recipe_id: args.recipe_id,recipe_hash: 'fixture',success: true,output: { render: [],sidebar: [] },steps: [],errors: [],duration_ms: 1 }; }return { run_id:'fixture-account-payment-run',recipe_id: args.recipe_id,recipe_hash: 'fixture',success: false,awaiting_approval: true,output: { render: [],sidebar: [] },steps: [],errors: [],duration_ms: 1 }; },
  },
});
void panel.open();
export interface AccountPaymentsFixture extends AccountContactFixtureControls {
  contactSenderMode(mode: 'normal' | 'missing' | 'read_only'): void;
  calls: typeof calls;hold(method: string): void;release(): void;pending(): boolean;mode(value: string): void;change(): void;fail(): void;
  dispose(): void;dirty(): boolean;busy(): boolean;failMail(): void;many(): void;refund(): void;otherAccount(): void;failBilling(value: boolean): void;manyCorrections(): void;failReceipt(value: boolean): void;
}
declare global { interface Window { __accountPayments: AccountPaymentsFixture } }
window.__accountPayments = { calls,...contacts.controls,contactSenderMode: mode => { contactSenderMode = mode; },hold: method => { hold = method; },release: () => { pending?.();pending = undefined; },pending: () => !!pending,
  mode: value => { mode = value; },change: () => { revision++; },fail: () => { failPrepare = true; },dispose: panel.dispose,dirty: panel.hasUnsavedChanges,busy: panel.hasInFlightWork,
  failReceipt: value => { receiptFails=value; },manyCorrections: () => { manyCorrections=true; },otherAccount: () => { otherAccount = true; },failBilling: value => { billingFails = value; },failMail: () => { mailFails = true; },many: () => { many = true; },refund: () => { hasRefund = true;revision++; },
};
