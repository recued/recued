import { describe, expect, it, vi } from 'vitest';
import type { QuoteSignoffFollowUp, QuoteSignoffListInput, QuoteSignoffListResult, QuoteSignoffSummary, QuoteCompletionSummary, QuoteCompletionListInput } from '@recued/contracts';
import { mountQuoteCompletionPanel } from './quote-completion-panel.js';
import { mountQuoteSignoffPanel, type QuoteSignoffConn } from './quote-signoff-panel.js';

vi.mock('./quote-signoff-payment.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./quote-signoff-payment.js')>();
  return { ...actual, createQuoteSignoffPayment: (options: Parameters<typeof actual.createQuoteSignoffPayment>[0]) => ({
    open: async (offer: QuoteSignoffSummary) => { await options.readOffer(offer.signoff_id); },
    hasInFlightWork: () => false, dispose: () => {},
  }) };
});

class Node {
  textContent = ''; value = ''; hidden = false; disabled = false;
  children: Node[] = []; parent: Node | null = null;
  attrs = new Map<string, string>(); listeners = new Map<string, Array<(event: { preventDefault: () => void }) => void>>();
  constructor(readonly tag: string) {}
  querySelectorAll(selector: string): Node[] { return this.children.flatMap(child => [
    ...(selector === '[data-completion-action]' && child.attrs.has('data-completion-action') ? [child] : []),...child.querySelectorAll(selector)]); }
  appendChild(node: Node) { node.remove();node.parent = this;this.children.push(node);return node; }
  insertBefore(node: Node,reference: Node | null) { node.remove();const index=reference===null ? this.children.length : this.children.indexOf(reference);if(index<0)throw new Error('Reference is not a child');node.parent=this;this.children.splice(index,0,node);return node; }
  replaceChildren() { this.children.forEach(n => { n.parent = null; }); this.children = []; }
  setAttribute(key: string, value: string) { this.attrs.set(key, value); }
  addEventListener(event: string, listener: (event: { preventDefault: () => void }) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }
  fire(event: string) { this.listeners.get(event)?.forEach(listener => listener({ preventDefault: () => {} })); }
  click() { if (!this.disabled) this.fire('click'); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(n => n !== this);this.parent=null; }
}
const nodes = (root: Node): Node[] => [root, ...root.children.flatMap(nodes)];
const content = (root: Node) => nodes(root).map(n => n.textContent).join('\n');
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const initial: QuoteSignoffFollowUp = { checked_at: 1,
  task: { availability: 'current', title: 'Deliver drawings', done: false, state: 'success', progress: 100 },
  invoice: { availability: 'current', status: 'open', amount_paid: '20.1234', outstanding: '99.8766', due_on: '2026-10-01', overdue: true } };
const signoff = (follow_up: QuoteSignoffFollowUp): QuoteSignoffSummary => ({
  signoff_id: 'agreement-1', quote_id: 'Q1', quote_version: 2, quote_revision: 1, quote_label: 'Drawings', customer: 'Morgan',
  amount: '120.0000', currency: 'GBP', scope: 'Three drawings.', task_title: 'Deliver drawings',
  net: '100.0000', vat_amount: '20.0000', invoice_ref: 'INV-101', issued_on: '2026-10-01', due_on: '2026-10-31',
  state: 'released', availability: 'current', created_at: 1, expires_at: 2, endpoint_id: 'ep-1', responded_at: 1,
  released_at: 1, task_id: 'quote_signoff_agreement-1', invoice_id: 'quote_signoff_agreement-1', follow_up,
});
const setup = (withPayments = false) => {
  let offer = signoff(initial);
  let pending: Promise<QuoteSignoffListResult> | null = null;
  let quoteError: Error | undefined;
  let respond: ((input: QuoteSignoffListInput) => QuoteSignoffListResult | Promise<QuoteSignoffListResult>) | undefined;
  const requests: QuoteSignoffListInput[] = [];
  const host = new Node('main');
  const conn = (async (method: string, input?: QuoteSignoffListInput) => {
    if (method === 'reception.signoff.completion.list') return { completions: [] };
    if (method === 'reception.signoff.quotes') {
      if (quoteError) throw quoteError;
      return { quotes: [], truncated: false };
    }
    if (method === 'reception.signoff.list') {
      const query = input ?? {}; requests.push({ ...query });
      if (pending) { const wait = pending; pending = null; return wait; }
      if (respond) return respond(query);
      return { signoffs: [offer], truncated: false };
    }
    throw new Error(`Unexpected mutating call: ${method}`);
  }) as QuoteSignoffConn;
  const panel = mountQuoteSignoffPanel({ host: host as unknown as HTMLElement, conn,
    ...(withPayments ? { payment: { listRecipes: async () => ({ recipes: [] }),
      execute: async () => { throw new Error('A list-only test must not record payment'); } } } : {}),
    document: { createElement: (tag: string) => new Node(tag) } as unknown as Document });
  return { host, panel, set: (follow: QuoteSignoffFollowUp) => { offer = signoff(follow); },
    setOffer: (value: QuoteSignoffSummary) => { offer = value; }, requests,
    respond: (handler: NonNullable<typeof respond>) => { respond = handler; },
    delay: (wait: NonNullable<typeof pending>) => { pending = wait; },
    quoteError: (error?: Error) => { quoteError = error; } };
};

describe('sign-off panel — owner follow-up', () => {
  it('offers Record payment only for its current open invoice', async () => {
    const h = setup(true);
    try {
      await flush();
      expect(nodes(h.host).filter(n => n.textContent === 'Record payment')).toHaveLength(1);
      for (const invoice of [
        { availability: 'missing' }, { availability: 'changed' }, { availability: 'unavailable' },
        { availability: 'current', status: 'settled', amount_paid: '120.0000', outstanding: '0.0000', due_on: '2026-10-01', overdue: false },
        { availability: 'current', status: 'carried_forward', amount_paid: '20.0000', outstanding: '100.0000', due_on: '2026-10-01', overdue: false, carried_to: 'INV-202' },
      ] satisfies QuoteSignoffFollowUp['invoice'][]) {
        h.set({ ...initial, invoice }); h.panel.update(); await flush();
        expect(nodes(h.host).filter(n => n.textContent === 'Record payment')).toHaveLength(0);
      }
    } finally { h.panel.dispose(); }
  });

  it('shows exact recorded balances and a task link without treating progress as completion', async () => {
    const h = setup();
    try {
      await flush();
      expect(content(h.host)).toContain('Work unfinished: Deliver drawings. State: success. Progress: 100%.');
      expect(content(h.host)).toContain('99.8766 GBP outstanding · overdue. Due 2026-10-01.');
      expect(content(h.host)).toContain('Recorded paid: 20.1234 GBP.');
      expect(nodes(h.host).find(n => n.textContent === 'Open task')?.attrs.get('href')).toBe('#data/task/quote_signoff_agreement-1');
      expect(nodes(h.host).find(n => n.textContent === 'Browse Records')?.attrs.get('href')).toBe('#data/records/recued-core/invoice-book/invoice/quote_signoff_agreement-1');
      expect(nodes(h.host).some(n => n.textContent === 'Add work')).toBe(true);
      h.set({ ...initial, task: { availability: 'current', title: 'Drawings delivered', done: true },
        invoice: { availability: 'current', status: 'settled', amount_paid: '120.0000', outstanding: '0.0000', due_on: '2026-10-01', overdue: false } });
      nodes(h.host).find(n => n.textContent === 'Refresh')!.click(); await flush();
      expect(content(h.host)).toContain('Work complete: Drawings delivered.');
      expect(content(h.host)).toContain('Invoice INV-101: recorded paid in full.');
      expect(content(h.host)).not.toContain('99.8766');
      expect(nodes(h.host).some(n => n.textContent === 'Add work')).toBe(false);
    } finally { h.panel.dispose(); }
  });

  it('keeps carried and unavailable records distinct from completed or paid records', async () => {
    const h = setup();
    try {
      h.set({ ...initial, task: { availability: 'missing' }, invoice: { availability: 'current',
        status: 'carried_forward', amount_paid: '20.0000', outstanding: '100.0000', due_on: '2026-10-01', overdue: false, carried_to: 'INV-202' } });
      h.panel.update(); await flush();
      expect(content(h.host)).toContain('Linked task is missing.');
      expect(content(h.host)).toContain('balance carried to INV-202. Follow that invoice in Records.');
      expect(content(h.host)).not.toContain('paid in full');
      expect(nodes(h.host).some(n => n.textContent === 'Open task' || n.textContent === 'Add work')).toBe(false);
      h.set({ ...initial, task: { availability: 'unavailable' }, invoice: { availability: 'changed' } });
      h.panel.update(); await flush();
      expect(content(h.host)).toContain('Task status is unavailable.');
      expect(content(h.host)).toContain('terms or balance changed. Review it in Records.');
      expect(content(h.host)).not.toContain('Recorded paid:');
    } finally { h.panel.dispose(); }
  });

  it('cannot replace a fresh settlement with an older delayed list response', async () => {
    const h = setup();
    try {
      await flush();
      let resolve!: (value: { signoffs: QuoteSignoffSummary[]; truncated: boolean }) => void;
      h.delay(new Promise(r => { resolve = r; })); h.panel.update();
      h.set({ ...initial, invoice: { availability: 'current', status: 'settled', amount_paid: '120.0000',
        outstanding: '0.0000', due_on: '2026-10-01', overdue: false } });
      h.panel.update(); await flush();
      resolve({ signoffs: [signoff(initial)], truncated: false }); await flush();
      expect(content(h.host)).toContain('recorded paid in full');
      expect(content(h.host)).not.toContain('99.8766');
    } finally { h.panel.dispose(); }
  });
});


describe('sign-off panel — search and older requests', () => {
  const button = (root: Node, label: string) => nodes(root).find(n => n.tag === 'button' && n.textContent === label)!;
  const titles = (root: Node) => nodes(root).filter(n => n.tag === 'article')
    .map(card => card.children.find(n => n.tag === 'h3')?.textContent);
  const search = (root: Node) => nodes(root).find(n => n.attrs.get('name') === 'signoff_search')!;
  const state = (root: Node) => nodes(root).find(n => n.attrs.get('name') === 'signoff_state')!;
  const submit = (root: Node) => nodes(root).find(n => n.attrs.get('role') === 'search')!.fire('submit');
  const newest = { ...signoff(initial), signoff_id: 'newest', quote_label: 'Newest request' };
  const previous = { ...signoff(initial), signoff_id: 'older', quote_label: 'Older request' };
  const first = { signoffs: [newest], truncated: true, next_cursor: 'older-page' };
  const second = { signoffs: [previous], truncated: false };

  it('browses older and newer pages and preserves the current page during polling', async () => {
    vi.useFakeTimers();
    const h = setup();
    try {
      h.respond(input => input.cursor ? second : first); h.panel.update(); await flush();
      expect(button(h.host, 'Newer requests').disabled).toBe(true);
      button(h.host, 'Older requests').click(); await flush();
      expect(titles(h.host)).toEqual(['Older request — Morgan']);
      expect(content(h.host)).toContain('Page 2');
      await vi.advanceTimersByTimeAsync(20_000); await flush();
      expect(h.requests.at(-1)).toEqual({ limit: 50, cursor: 'older-page' });
      expect(titles(h.host)).toEqual(['Older request — Morgan']); expect(content(h.host)).toContain('Page 2');
      button(h.host, 'Newer requests').click(); await flush();
      expect(h.requests.at(-1)).toEqual({ limit: 50 });
      expect(titles(h.host)).toEqual(['Newest request — Morgan']); expect(button(h.host, 'Newer requests').disabled).toBe(true);
    } finally { h.panel.dispose(); vi.useRealTimers(); }
  });

  it('resets paging on search or status changes and keeps the filters when refreshed', async () => {
    const h = setup();
    try {
      h.respond(input => input.cursor ? second : first); h.panel.update(); await flush();
      button(h.host, 'Older requests').click(); await flush();
      search(h.host).value = ' Morgan '; state(h.host).value = 'waiting'; submit(h.host); await flush();
      expect(h.requests.at(-1)).toEqual({ limit: 50, search: 'Morgan', state: 'waiting' });
      expect(content(h.host)).toContain('Page 1');
      button(h.host, 'Older requests').click(); await flush();
      button(h.host, 'Refresh').click(); await flush();
      expect(h.requests.at(-1)).toEqual({ limit: 50, search: 'Morgan', state: 'waiting', cursor: 'older-page' });
      state(h.host).value = 'released'; state(h.host).fire('change'); await flush();
      expect(h.requests.at(-1)).toEqual({ limit: 50, search: 'Morgan', state: 'released' });
      button(h.host, 'Clear search').click(); await flush();
      expect(h.requests.at(-1)).toEqual({ limit: 50 });
      expect(search(h.host).value).toBe(''); expect(state(h.host).value).toBe('');
    } finally { h.panel.dispose(); }
  });

  it('cannot replace a new search with an older page response still in flight', async () => {
    const h = setup();
    try {
      h.respond(() => first); h.panel.update(); await flush();
      let resolve!: (value: QuoteSignoffListResult) => void;
      h.delay(new Promise(done => { resolve = done; }));
      button(h.host, 'Older requests').click();
      h.respond(() => ({ signoffs: [{ ...newest, quote_label: 'Filtered result' }], truncated: false }));
      search(h.host).value = 'Filtered'; submit(h.host); await flush();
      resolve(second); await flush();
      expect(titles(h.host)).toEqual(['Filtered result — Morgan']);
      expect(content(h.host)).toContain('Page 1'); expect(button(h.host, 'Newer requests').disabled).toBe(true);
    } finally { h.panel.dispose(); }
  });

  it('retains the requested older page when a route update arrives during navigation', async () => {
    const h = setup();
    try {
      h.respond(input => input.cursor ? second : first); h.panel.update(); await flush();
      let resolve!: (value: QuoteSignoffListResult) => void;
      h.delay(new Promise(done => { resolve = done; }));
      button(h.host, 'Older requests').click(); h.panel.update(); await flush();
      expect(h.requests.at(-1)).toEqual({ limit: 50, cursor: 'older-page' });
      expect(titles(h.host)).toEqual(['Older request — Morgan']);
      expect(content(h.host)).toContain('Page 2');
      resolve(first); await flush();
      expect(titles(h.host)).toEqual(['Older request — Morgan']);
      button(h.host, 'Newer requests').click(); await flush();
      expect(h.requests.at(-1)).toEqual({ limit: 50 });
      expect(titles(h.host)).toEqual(['Newest request — Morgan']);
    } finally { h.panel.dispose(); }
  });

  it('keeps search and pagination available when open quotes fail to load, then clears the error on recovery', async () => {
    const h = setup();
    try {
      h.respond(input => input.cursor ? second : first);
      h.quoteError(new Error('Quote pack unavailable')); h.panel.update(); await flush();
      expect(titles(h.host)).toEqual(['Newest request — Morgan']);
      expect(content(h.host)).toContain('Could not load open quotes. Quote pack unavailable');
      expect(content(h.host)).not.toContain('Loading quotes…');
      button(h.host, 'Older requests').click(); await flush();
      expect(titles(h.host)).toEqual(['Older request — Morgan']);
      expect(content(h.host)).toContain('Page 2');
      h.quoteError(); button(h.host, 'Refresh').click(); await flush();
      expect(h.requests.at(-1)).toEqual({ limit: 50, cursor: 'older-page' });
      expect(titles(h.host)).toEqual(['Older request — Morgan']);
      expect(content(h.host)).not.toContain('Could not load open quotes');
      expect(content(h.host)).toContain('Record an open quote in Quote Pipeline to prepare a sign-off.');
    } finally { h.panel.dispose(); }
  });

  it('keeps the successful page and its cursor after a failed navigation, then permits retry', async () => {
    const h = setup();
    try {
      h.respond(() => first); h.panel.update(); await flush();
      h.respond(input => { if (input.cursor) throw new Error('Connection lost'); return first; });
      button(h.host, 'Older requests').click(); await flush();
      expect(content(h.host)).toContain('Could not load requests. Connection lost');
      expect(titles(h.host)).toEqual(['Newest request — Morgan']);
      expect(button(h.host, 'Newer requests').disabled).toBe(true);
      h.respond(input => input.cursor ? second : first);
      button(h.host, 'Older requests').click(); await flush();
      expect(h.requests.at(-1)).toEqual({ limit: 50, cursor: 'older-page' });
      expect(titles(h.host)).toEqual(['Older request — Morgan']); expect(content(h.host)).toContain('Page 2');
    } finally { h.panel.dispose(); }
  });

  it('uses server amendment eligibility when a newer amendment is outside the result page', async () => {
    const h = setup();
    try {
      h.setOffer({ ...signoff(initial), can_add_work: false }); h.panel.update(); await flush();
      expect(nodes(h.host).some(n => n.textContent === 'Add work')).toBe(false);
    } finally { h.panel.dispose(); }
  });

  it('rechecks a paged payment target by its exact ID without applying the history search', async () => {
    const h = setup(true);
    try {
      h.respond(input => input.signoff_id ? { signoffs: [previous], truncated: false } : input.cursor ? second : first);
      h.panel.update(); await flush();
      search(h.host).value = 'Morgan'; state(h.host).value = 'released'; submit(h.host); await flush();
      button(h.host, 'Older requests').click(); await flush();
      button(h.host, 'Record payment').click(); await flush();
      expect(h.requests.at(-1)).toEqual({ signoff_id: previous.signoff_id, limit: 1 });
    } finally { h.panel.dispose(); }
  });

  it('reports an empty filtered result and keeps paging disabled', async () => {
    const h = setup();
    try {
      h.respond(() => ({ signoffs: [], truncated: false }));
      search(h.host).value = 'Nobody'; submit(h.host); await flush();
      expect(content(h.host)).toContain('No requests match this search.');
      expect(button(h.host, 'Older requests').disabled).toBe(true);
      expect(button(h.host, 'Newer requests').disabled).toBe(true);
    } finally { h.panel.dispose(); }
  });
});


describe('completion queue audit regressions',() => {
  it('keeps the global completion queue visible when the current sign-off page has no released work',async () => {
    const h = setup();
    try {
      h.respond(() => ({ signoffs: [],truncated: false }));h.panel.update();await flush();
      expect(nodes(h.host).find(node => node.attrs.has('data-signoff-completions'))?.hidden).toBe(false);
    } finally { h.panel.dispose(); }
  });
  it('does not advance the page history twice after a failed older page load',async () => {
    const host = new Node('main');const calls: QuoteCompletionListInput[] = [];let fail = true;
    const entry: QuoteCompletionSummary = { completion_id: 'c',signoff_id: 's',root_signoff_id: 's',customer: 'Morgan',quote_label: 'Drawings',business_name: 'Studio',
      agreed_scope: 'Scope',delivery_summary: 'Delivery',customer_preview: 'Delivery',state: 'waiting',availability: 'current',created_at: 1,expires_at: 2,
      endpoint_id: 'ep',response: { decision: 'not_recorded',received_at: null,recorded_at: null },owner_action: null };
    const conn = (async (_method: string,input?: QuoteCompletionListInput) => {
      calls.push(input ?? {});
      if (input?.cursor && fail) { fail = false;throw new Error('Page unavailable'); }
      return { completions: [entry],...(input?.cursor ? {} : { next_cursor: 'page-2' }) };
    }) as QuoteSignoffConn;
    const panel = mountQuoteCompletionPanel({ host: host as unknown as HTMLElement,document: { createElement: (tag: string) => new Node(tag) } as unknown as Document,conn,onChanged: () => {} });
    const button = (label: string) => nodes(host).find(node => node.tag === 'button' && node.textContent === label)!;
    try {
      panel.update();await flush();button('Older completions').click();await flush();
      expect(content(host)).toContain('Page unavailable');button('Older completions').click();await flush();
      button('Newer completions').click();await flush();expect(calls.map(call => call.cursor)).toEqual([undefined,'page-2','page-2',undefined]);
    } finally { panel.dispose(); }
  });
});
