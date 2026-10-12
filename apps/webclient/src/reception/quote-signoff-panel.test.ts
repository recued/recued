import { describe, expect, it } from 'vitest';
import type { QuoteSignoffFollowUp, QuoteSignoffSummary } from '@recued/contracts';
import { mountQuoteSignoffPanel, type QuoteSignoffConn } from './quote-signoff-panel.js';

class Node {
  textContent = ''; value = ''; hidden = false; disabled = false;
  children: Node[] = []; parent: Node | null = null;
  attrs = new Map<string, string>(); listeners = new Map<string, Array<() => void>>();
  constructor(readonly tag: string) {}
  appendChild(node: Node) { node.parent = this; this.children.push(node); return node; }
  replaceChildren() { this.children.forEach(n => { n.parent = null; }); this.children = []; }
  setAttribute(key: string, value: string) { this.attrs.set(key, value); }
  addEventListener(event: string, listener: () => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }
  click() { this.listeners.get('click')?.forEach(listener => listener()); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(n => n !== this); }
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
  let pending: Promise<{ signoffs: QuoteSignoffSummary[]; truncated: boolean }> | null = null;
  const host = new Node('main');
  const conn = (async (method: string) => {
    if (method === 'reception.signoff.quotes') return { quotes: [], truncated: false };
    if (method === 'reception.signoff.list') {
      if (pending) { const wait = pending; pending = null; return wait; }
      return { signoffs: [offer], truncated: false };
    }
    throw new Error(`Unexpected mutating call: ${method}`);
  }) as QuoteSignoffConn;
  const panel = mountQuoteSignoffPanel({ host: host as unknown as HTMLElement, conn,
    ...(withPayments ? { payment: { listRecipes: async () => ({ recipes: [] }),
      execute: async () => { throw new Error('A list-only test must not record payment'); } } } : {}),
    document: { createElement: (tag: string) => new Node(tag) } as unknown as Document });
  return { host, panel, set: (follow: QuoteSignoffFollowUp) => { offer = signoff(follow); },
    delay: (wait: NonNullable<typeof pending>) => { pending = wait; } };
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
      expect(nodes(h.host).find(n => n.textContent === 'Browse Records')?.attrs.get('href')).toBe('#data/records');
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
