import { afterEach, describe, expect, it, vi } from 'vitest';
import { initialMailComposeState, type MailDraft, type QuoteSignoffReminder, type QuoteSignoffSummary } from '@recued/contracts';
import { mountQuoteSignoffReminders, type QuoteSignoffReminderConn } from './quote-signoff-reminders.js';
import type { MailComposeDeps } from '../mail/mail-compose-host.js';

const composer = vi.hoisted(() => ({ openSaved: vi.fn(async (_id: string) => true), refresh: vi.fn(async () => ({})),
  hasUnsavedChanges: vi.fn(() => false), hasInFlightWork: vi.fn(() => false), destroy: vi.fn() }));
vi.mock('../mail/mail-compose-host.js', () => ({ mountMailCompose: () => ({ ...composer, state: () => initialMailComposeState() }) }));

class Node {
  textContent = ''; value = ''; hidden = false; disabled = false; children: Node[] = []; parent: Node | null = null;
  attrs = new Map<string, string>(); listeners = new Map<string, Array<(event: { preventDefault(): void }) => void>>();
  constructor(readonly tag: string) {}
  appendChild(node: Node) { node.parent = this; this.children.push(node); return node; }
  replaceChildren() { this.children.forEach(node => { node.parent = null; }); this.children = []; }
  setAttribute(key: string, value: string) { this.attrs.set(key, value); }
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
const NOW = Date.parse('2026-10-13T12:00:00Z');
const offer: QuoteSignoffSummary = { signoff_id: 'a'.repeat(8) + '-aaaa-aaaa-aaaa-' + 'a'.repeat(12), quote_id: 'Q1', quote_version: 2,
  quote_revision: 1, quote_label: 'Drawings', quote_reference: 'Q-1', customer: 'Morgan', amount: '120.0000', currency: 'GBP', net: '100.0000',
  vat_amount: '20.0000', scope: 'Three drawings.', task_title: 'Drawings', invoice_ref: 'INV-1', issued_on: '2026-10-13', due_on: '2026-11-13',
  state: 'waiting', availability: 'current', created_at: NOW, expires_at: NOW + 7 * 86_400_000, endpoint_id: 'endpoint-1',
  responded_at: null, released_at: null, task_id: null, invoice_id: null };
const initial: QuoteSignoffReminder = { signoff_id: offer.signoff_id, revision: 1, due_at: NOW, status: 'due', has_saved_link: true,
  sender_mail_instance: 'work', recipient_email: 'morgan@example.test', notified_at: null, drafted_at: null, delivery: 'not_prepared' };
const handles: Array<{ dispose(): void }> = [];
afterEach(() => { handles.splice(0).forEach(handle => handle.dispose()); vi.clearAllMocks(); });
const fixture = () => {
  const host = new Node('main'); let reminder = { ...initial }; let failMail = false; let next: string | undefined = 'later';
  const requests: Array<{ method: string; input: unknown }> = [];
  let list = async (_input: unknown) => ({ reminders: [{ signoff: offer, reminder }], ...(next ? { next_cursor: next } : {}) });
  const content = { sender_mail_instance: 'work', to: ['morgan@example.test'], subject: 'Review Q-1', body: 'Please review the saved link.', body_format: 'text' as const, reconciliation_id: 'qsr_fixture' };
  const draft: MailDraft = { draft_id: 'mad_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', incarnation: 'draft-generation', revision: 1,
    content, origin_contract_id: null, created_at: NOW, updated_at: NOW };
  const create = vi.fn(async () => draft); const execute = vi.fn(async () => { throw new Error('No send should be dispatched by preparing a draft.'); });
  const mail: MailComposeDeps = { listMailInstances: async () => {
    if (failMail) throw new Error('mail unavailable');
    return { instances: [{ slug: 'work', adapter_type: 'imap', send_capable: true, draft_capable: true, account_email: 'owner@example.test' }] };
  }, runExecute: execute, drafts: {
    create, get: async () => draft, list: async () => ({ drafts: [], next_cursor: '' }),
    update: async () => draft, delete: async () => { throw new Error('unused'); },
    prepare: async () => { throw new Error('unused'); }, openReview: () => {},
  } };
  const conn = (async (method: string, input: unknown) => {
    requests.push({ method, input });
    if (method === 'reception.signoff.reminders.list') return list(input);
    if (method === 'reception.signoff.reminders.get') return reminder;
    if (method === 'reception.signoff.reminders.draft') return { idempotency_key: 'qsr_fixture', content };
    if (method === 'reception.signoff.reminders.set') return { ...reminder, revision: reminder.revision + 1 };
    throw new Error('Unexpected RPC');
  }) as QuoteSignoffReminderConn;
  const document = { createElement: (tag: string) => new Node(tag) } as unknown as Document;
  const panel = mountQuoteSignoffReminders({ host: host as unknown as HTMLElement, document, conn, mail, now: () => NOW }); handles.push(panel);
  return { host, panel, requests, create, execute, setReminder: (value: QuoteSignoffReminder) => { reminder = value; },
    failMail: () => { failMail = true; }, setList: (value: typeof list) => { list = value; }, next: (value?: string) => { next = value; } };
};

describe('customer sign-off reminder owner flows', () => {
  it('saves a private draft and opens the ordinary composer without executing or sending', async () => {
    const h = fixture(); await flush(); button(h.host, 'Review reminder email').click(); await flush();
    expect(h.requests.some(request => request.method === 'reception.signoff.reminders.draft')).toBe(true);
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ idempotency_key: 'qsr_fixture' }));
    expect(composer.openSaved).toHaveBeenCalledWith('mad_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    expect(h.execute).not.toHaveBeenCalled(); expect(text(h.host)).not.toContain('Email sent');
  });
  it('snoozes and pauses the exact displayed occurrence with its expected revision', async () => {
    const h = fixture(); await flush(); button(h.host, 'Snooze 1 day').click(); await flush();
    expect(h.requests.at(-2)).toEqual({ method: 'reception.signoff.reminders.set', input: { signoff_id: offer.signoff_id, expected_revision: 1, due_at: NOW + 86_400_000 } });
    button(h.host, 'Pause follow-up').click(); await flush();
    expect(h.requests.some(request => request.method.endsWith('.set') && (request.input as { due_at: unknown }).due_at === null)).toBe(true);
  });
  it('keeps owner edits and the leave guard through polling, then clears dirty state after save', async () => {
    const h = fixture(); await flush(); await h.panel.open(offer);
    const email = field(h.host, 'reminder_recipient'); email.value = 'chosen@example.test';
    nodes(h.host).find(node => node.tag === 'form')!.fire('input');
    expect(h.panel.hasUnsavedChanges()).toBe(true); h.panel.update(); await flush();
    expect(email.value).toBe('chosen@example.test');
    nodes(h.host).find(node => node.tag === 'form')!.fire('submit'); await flush();
    expect(h.requests.some(request => request.method.endsWith('.set') && (request.input as { recipient_email?: string }).recipient_email === 'chosen@example.test')).toBe(true);
    expect(h.panel.hasUnsavedChanges()).toBe(false);
  });
  it('returns to the first follow-up page without retaining the older-page cursor', async () => {
    const h = fixture(); h.next('later'); await flush(); button(h.host, 'More follow-ups').click(); await flush();
    button(h.host, 'Earlier follow-ups').click(); await flush();
    expect(h.requests.at(-1)).toEqual({ method: 'reception.signoff.reminders.list', input: { limit: 50 } });
  });
  it('preserves dirty fields when another editor is requested', async () => {
    const h = fixture(); await flush(); await h.panel.open(offer); field(h.host, 'reminder_recipient').value = 'changed@example.test';
    nodes(h.host).find(node => node.tag === 'form')!.fire('input'); await h.panel.open({ ...offer, signoff_id: 'other' });
    expect(field(h.host, 'reminder_recipient').value).toBe('changed@example.test');
    expect(text(h.host)).toContain('Save or close this follow-up');
  });
  it('keeps owner scheduling available during a mail-account outage', async () => {
    const h = fixture(); h.failMail(); await flush(); await h.panel.open(offer);
    expect(text(h.host)).toContain('owner reminders remain available');
    expect(button(h.host, 'Save follow-up').disabled).toBe(false);
    field(h.host, 'reminder_recipient').value = ''; field(h.host, 'reminder_account').value = '';
    nodes(h.host).find(node => node.tag === 'form')!.fire('submit'); await flush();
    expect(h.requests.some(request => request.method.endsWith('.set'))).toBe(true);
  });
  it('hides email review for future, uncertain or unconfigured reminders', async () => {
    const h = fixture();
    for (const change of [{ status: 'scheduled' as const }, { delivery: 'uncertain' as const }, { recipient_email: undefined }]) {
      h.setReminder({ ...initial, ...change }); h.panel.update(); await flush();
      expect(nodes(h.host).find(node => node.textContent === 'Review reminder email')).toBeUndefined();
    }
  });
  it('retains a failed page and cursor for retry, and discards stale replies', async () => {
    const h = fixture(); h.next('later'); await flush();
    h.setList(async () => { throw new Error('offline'); }); button(h.host, 'More follow-ups').click(); await flush();
    expect(text(h.host)).toContain('Morgan'); expect(text(h.host)).toContain('offline');
    let resolve!: (value: Awaited<ReturnType<Parameters<typeof h.setList>[0]>>) => void;
    h.setList(() => new Promise(done => { resolve = done; })); button(h.host, 'More follow-ups').click(); await flush();
    h.setList(async () => ({ reminders: [{ signoff: { ...offer, customer: 'Current' }, reminder: initial }], next_cursor: undefined }));
    h.panel.update(); await flush(); resolve({ reminders: [{ signoff: { ...offer, customer: 'Stale' }, reminder: initial }] }); await flush();
    expect(text(h.host)).toContain('Current'); expect(text(h.host)).not.toContain('Stale');
    expect(h.requests.at(-1)).toEqual({ method: 'reception.signoff.reminders.list', input: { limit: 50, cursor: 'later' } });
  });
  it('cannot save or open a delayed draft after the route has disposed', async () => {
    const h = fixture(); await flush();
    let resolve!: (draft: MailDraft) => void; h.create.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    button(h.host, 'Review reminder email').click(); await flush(); h.panel.dispose();
    resolve({ draft_id: 'mad_late', content: { sender_mail_instance: 'work', to: ['morgan@example.test'], subject: '', body: '', body_format: 'text' },
      incarnation: 'late', revision: 1, created_at: NOW, updated_at: NOW, origin_contract_id: null }); await flush();
    expect(composer.openSaved).not.toHaveBeenCalled(); expect(h.host.children).toHaveLength(0);
  });
});
