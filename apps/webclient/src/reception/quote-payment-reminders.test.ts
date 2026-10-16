import { afterEach,describe,expect,it,vi } from 'vitest';
import { initialMailComposeState,type MailDraft,type QuoteSignoffSummary,type QuotePaymentReminder,type QuotePaymentReminderTarget } from '@recued/contracts';
import { mountQuotePaymentReminders,type QuotePaymentReminderConn } from './quote-payment-reminders.js';
import type { MailComposeDeps } from '../mail/mail-compose-host.js';
const composer=vi.hoisted(()=>({openSaved:vi.fn(async(_id:string)=>true),refresh:vi.fn(async()=>({})),hasUnsavedChanges:vi.fn(()=>false),hasInFlightWork:vi.fn(()=>false),destroy:vi.fn()}));
vi.mock('../mail/mail-compose-host.js',()=>({mountMailCompose:()=>({...composer,state:()=>initialMailComposeState()})}));
class Node {
  textContent = ''; value = ''; hidden = false; disabled = false; children: Node[] = []; parent: Node | null = null;
  attrs = new Map<string, string>(); listeners = new Map<string, Array<(event: { preventDefault(): void }) => void>>();
  constructor(readonly tag: string) {}
  appendChild(node: Node) { node.parent = this; this.children.push(node); return node; }
  replaceChildren() { this.children.forEach(node => { node.parent = null; }); this.children = []; }
  setAttribute(key: string, value: string) { this.attrs.set(key, value); }
  getAttribute(key: string) { return this.attrs.get(key) ?? null; }
  addEventListener(name: string, callback: (event: { preventDefault(): void }) => void) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback]); }
  fire(name: string) { this.listeners.get(name)?.forEach(callback => callback({ preventDefault() {} })); }
  click() { if (!this.disabled) this.fire('click'); }
  focus() {}
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
}
const nodes = (root: Node): Node[] => [root, ...root.children.flatMap(nodes)];
const text = (root: Node) => nodes(root).map(node => node.textContent).join('\n');
const field = (root: Node, name: string) => nodes(root).find(node => node.attrs.get('name') === name)!;
const button = (root: Node, label: string) => nodes(root).find(node => node.tag === 'button' && node.textContent === label)!;
const flush = async () => { for (let count = 0; count < 24; count++) await Promise.resolve(); };
const NOW=Date.parse('2026-10-14T12:00:00Z');
const invoice:QuoteSignoffSummary={signoff_id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',quote_id:'Q1',quote_version:2,quote_revision:1,quote_label:'Drawings',quote_reference:'Q-1',customer:'Morgan',amount:'120.0000',currency:'GBP',net:'100.0000',vat_amount:'20.0000',scope:'Drawings',task_title:'Deliver',invoice_ref:'INV-101',issued_on:'2026-10-01',due_on:'2026-11-01',state:'released',availability:'current',created_at:NOW-30*86_400_000,expires_at:NOW-20*86_400_000,endpoint_id:'old-expired-link',responded_at:NOW-25*86_400_000,released_at:NOW-25*86_400_000,task_id:'task-1',invoice_id:'invoice-1',follow_up:{checked_at:NOW,task:{availability:'current',title:'Delivered',done:true},invoice:{availability:'current',status:'open',amount_paid:'20.0000',outstanding:'100.0000',due_on:'2026-11-01',overdue:false}}};
const target:QuotePaymentReminderTarget={signoff_id:invoice.signoff_id,invoice_id:invoice.invoice_id,customer:invoice.customer,quote_label:invoice.quote_label,invoice_ref:invoice.invoice_ref,currency:invoice.currency,amount:invoice.amount,invoice:invoice.follow_up!.invoice};
const initial:QuotePaymentReminder={signoff_id:invoice.signoff_id,revision:1,due_at:NOW,status:'due',sender_mail_instance:'work',recipient_email:'morgan@example.test',notified_at:null,drafted_at:null,delivery:'not_prepared',draft_stale:false};
const handles:Array<{dispose():void}>=[];
afterEach(()=>{handles.splice(0).forEach(handle=>handle.dispose());vi.clearAllMocks();});
const fixture=()=>{
  const host=new Node('main');let reminder={...initial};let failMail=false;let otherEmail=false;let next:string|undefined='later';
  const requests:Array<{method:string;input:unknown}>=[];let list=async(_input:unknown)=>({reminders:[{invoice:target,reminder}],...(next?{next_cursor:next}:{})});
  const content={sender_mail_instance:'work',to:['morgan@example.test'],subject:'Payment reminder: INV-101',body:'Invoice INV-101: 100.0000 GBP recorded outstanding; due 2026-11-01.',body_format:'text' as const,reconciliation_id:'qpr_fixture'};
  const draft:MailDraft={draft_id:'mad_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',incarnation:'draft-generation',revision:1,content,origin_contract_id:null,created_at:NOW,updated_at:NOW};
  const create=vi.fn(async()=>draft);const execute=vi.fn(async()=>{throw new Error('Preparing must not send');});
  const mail:MailComposeDeps={listMailInstances:async()=>{if(failMail)throw new Error('mail unavailable');return{instances:[{slug:'work',adapter_type:'imap',send_capable:true,draft_capable:true,account_email:'owner@example.test'}]};},runExecute:execute,drafts:{create,get:async()=>draft,list:async()=>({drafts:[],next_cursor:''}),update:async()=>draft,delete:async()=>({deleted:true}),prepare:async()=>{throw new Error('unused');},openReview:()=>{}}};
  const conn=(async(method:string,input:unknown)=>{requests.push({method,input});if(method.endsWith('.list'))return list(input);if(method.endsWith('.get'))return reminder;if(method.endsWith('.draft'))return{idempotency_key:'qpr_fixture',content};if(method.endsWith('.set'))return{...reminder,revision:reminder.revision+1,draft_stale:false};throw new Error('Unexpected RPC');}) as QuotePaymentReminderConn;
  const document={createElement:(tag:string)=>new Node(tag)} as unknown as Document;
  const panel=mountQuotePaymentReminders({host:host as unknown as HTMLElement,document,conn,mail,now:()=>NOW,canReviewEmail:()=>!otherEmail});handles.push(panel);
  return{host,panel,requests,create,execute,setReminder:(value:Partial<QuotePaymentReminder>)=>{reminder={...reminder,...value};},failMail:()=>{failMail=true;},otherEmail:()=>{otherEmail=true;},next:(value:string|undefined)=>{next=value;},list:(value:typeof list)=>{list=value;}};
};
describe('payment reminder editor',()=>{
  it('keeps unsaved follow-up edits out of draft review until the owner saves or closes them',async()=>{
    const h=fixture();await flush();await h.panel.open(invoice);
    field(h.host,'reminder_recipient').value='new-recipient@example.test';nodes(h.host).find(node=>node.tag==='form')!.fire('input');
    button(h.host,'Review payment reminder email').click();await flush();
    expect(h.requests.some(row=>row.method.endsWith('.draft'))).toBe(false);expect(h.create).not.toHaveBeenCalled();
    expect(text(h.host)).toContain('Save or close this follow-up before reviewing its email.');
    expect(field(h.host,'reminder_recipient').value).toBe('new-recipient@example.test');expect(h.panel.hasUnsavedChanges()).toBe(true);
    button(h.host,'Close payment follow-up').click();button(h.host,'Review payment reminder email').click();await flush();
    expect(h.create).toHaveBeenCalledTimes(1);
  });

  it('shows the recorded balance and prepares a private draft without an approval link',async()=>{const h=fixture();await flush();expect(text(h.host)).toContain('100.0000 GBP recorded outstanding');expect(nodes(h.host).some(node=>node.attrs.get('name')==='reminder_link')).toBe(false);button(h.host,'Review payment reminder email').click();await flush();expect(h.create).toHaveBeenCalledWith(expect.objectContaining({idempotency_key:'qpr_fixture'}));expect(composer.openSaved).toHaveBeenCalled();expect(h.execute).not.toHaveBeenCalled();});
  it('opens a payment follow-up even after its old sign-off link expires',async()=>{const h=fixture();await flush();await h.panel.open(invoice);expect(field(h.host,'reminder_due_at').value).not.toBe('');expect(text(h.host)).toContain('current recorded invoice balance');});
  it('snoozes and pauses the displayed revision',async()=>{const h=fixture();await flush();button(h.host,'Snooze payment 1 day').click();await flush();expect(h.requests.find(row=>row.method.endsWith('.set'))?.input).toMatchObject({signoff_id:invoice.signoff_id,expected_revision:1,due_at:NOW+86_400_000});button(h.host,'Pause payment follow-up').click();await flush();expect(h.requests.filter(row=>row.method.endsWith('.set')).at(-1)?.input).toMatchObject({due_at:null});});
  it('keeps dirty payment edits through queue refresh',async()=>{const h=fixture();await flush();await h.panel.open(invoice);field(h.host,'reminder_recipient').value='edited@example.test';nodes(h.host).find(node=>node.tag==='form')!.fire('input');h.panel.update();await flush();expect(field(h.host,'reminder_recipient').value).toBe('edited@example.test');expect(h.panel.hasUnsavedChanges()).toBe(true);button(h.host,'Close payment follow-up').click();expect(h.panel.hasUnsavedChanges()).toBe(false);});
  it('hides draft review after the invoice changes and asks for a new occurrence',async()=>{const h=fixture();h.setReminder({delivery:'draft_ready',draft_stale:true});h.panel.update();await flush();expect(text(h.host)).toContain('invoice changed');expect(nodes(h.host).some(node=>node.textContent==='Review payment reminder email')).toBe(false);});
  it('keeps owner scheduling available during a mail outage',async()=>{const h=fixture();h.failMail();await flush();await h.panel.open(invoice);expect(text(h.host)).toContain('owner reminders remain available');});
  it('blocks a second composer while another reminder email is open',async()=>{const h=fixture();await flush();h.otherEmail();button(h.host,'Review payment reminder email').click();await flush();expect(h.create).not.toHaveBeenCalled();expect(h.requests.some(row=>row.method.endsWith('.draft'))).toBe(false);expect(text(h.host)).toContain('Close the email');});
  it('returns to the first page without retaining its old cursor',async()=>{const h=fixture();await flush();button(h.host,'More payment follow-ups').click();await flush();button(h.host,'Earlier payment follow-ups').click();await flush();expect(h.requests.at(-1)).toEqual({method:'reception.signoff.payment.reminders.list',input:{limit:50}});});
  it('ignores stale queue responses after disposal',async()=>{const h=fixture();await flush();let resolve:((value:Awaited<ReturnType<Parameters<typeof h.list>[0]>>)=>void)|undefined;h.list(()=>new Promise(done=>{resolve=done;}));h.panel.update();h.panel.dispose();resolve?.({reminders:[]});await flush();expect(h.host.children).toHaveLength(0);});
});
