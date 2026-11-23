/** 2026-11-20 (the owner: "go ahead") — the lowest and highest of each numeric field of the collection a read found. On
 *  task I (the cheapest of Books to Scrape's 11 Travel books) the model comparing prices by eye answered right 3 times in
 *  6, and 3 times in 3 when it asked for a computation. */
import { describe, expect, it, vi } from 'vitest';
import { browserCollectHint, browserCollectionFacts } from '../bridges/browser-collect.js';
import { createBridgeDomAdapter } from '../bridges/dom-adapter.js';
import { createPageReadStore } from '../bridges/page-outline.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import type { DispatchOutcome, DispatchRequest } from '../bridges/dispatcher.js';

const URL_ = 'https://books.example/catalogue/travel/index.html';
const shop = (prices: string[], next = false) => '<html><body><nav><a href="/">Home</a></nav><section><ol class="row">'
  + prices.map((price, i) => `<li class="col"><article class="product_pod"><h3><a href="/b${String(i)}" title="Book ${String(i + 1)}">`
    + `Book ${String(i + 1)}</a></h3><p class="price_color">${price}</p><p class="instock">In stock</p></article></li>`).join('')
  + `</ol>${next ? '<ul class="pager"><li class="next"><a href="page-2.html">next</a></li></ul>' : ''}</section></body></html>`;
const facts = (prices: string[], next = false) => {
  const html = shop(prices, next);
  const hint = browserCollectHint(html, URL_);
  expect(hint).toBeDefined();
  return browserCollectionFacts(html, hint!);
};

describe('browserCollectionFacts — the lowest and highest of a numeric field, with its row', () => {
  it('names the cheapest and the dearest row of a price list, and how many rows that covers', () => {
    const found = facts(['£45.17', '£49.43', '£30.54', '£56.88', '£23.21', '£26.08']);
    expect(found).toMatchObject({ rows: 6, fields: { price_color: {
      lowest: { value: '£23.21', row: 5, name: 'Book 5' }, highest: { value: '£56.88', row: 4, name: 'Book 4' } } } });
    expect(found!.note).toContain('6 rows of this read');
    expect(found).not.toHaveProperty('more_pages');
    expect(found!.fields).not.toHaveProperty('instock');
  });

  it('says how many rows share a lowest value, naming the first', () => {
    expect(facts(['£12.00', '£9.50', '£9.50', '£20.00'])!.fields.price_color!.lowest).toEqual({ value: '£9.50', row: 2, name: 'Book 2', rows_with_value: 2 });
  });

  it('reads thousands and plain numbers, and gives none for mixed units or another locale', () => {
    expect(facts(['$1,250.00', '$980.50', '$12,000.00'])!.fields.price_color!.highest.value).toBe('$12,000.00');
    expect(facts(['£12.00', '$9.50', '£20.00'])).toBeUndefined();
    expect(facts(['1.250,00 €', '980,50 €', '12,00 €'])).toBeUndefined();
    // A dot before three digits is a thousands dot in much of Europe: 1.250 € is 1,250 €, not 1.25.
    expect(facts(['1.250 €', '980 €', '2.500 €'])).toBeUndefined();
  });

  it('says a list goes on to further pages, whose rows it does not count', () => {
    const found = facts(['£12.00', '£9.50', '£20.00'], true);
    expect(found).toMatchObject({ rows: 3, more_pages: true });
    expect(found!.note).toContain('further pages');
  });
});

describe('a complete read of a page with a collection', () => {
  it('answers the facts beside the collect hint', async () => {
    const html = shop(['£45.17', '£23.21', '£30.54', '£26.08']);
    const dispatch = vi.fn(async (_request: DispatchRequest): Promise<DispatchOutcome> => ({ kind: 'completed', bridge_client_token_id: 'b', attempts: 1,
      result: { command_id: 'c', duration_ms: 1, bridge_version: '0.0.14', idempotency_key_seen: false, status: 'ok',
        outputs: { page: '7:DOC1', url: URL_, title: 'Travel', html, truncated: false, loading: false } } }));
    const adapter = createBridgeDomAdapter({ pageReads: createPageReadStore(),
      manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null },
      getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: () => true }) });
    const read = await adapter({ slug: 'dom-inspect', output: {}, risk_tier: 'read', input: { target: '*://*/*', page: '7:DOC1', form: 'outline' } }) as Record<string, unknown>;
    expect(read.collection_hint).toBeDefined();
    expect(read.collection_facts).toMatchObject({ rows: 4, fields: { price_color: { lowest: { value: '£23.21', name: 'Book 2' } } } });
  });
});
