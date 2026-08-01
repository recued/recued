/** The `record_ref` picker's inventory read.
 *
 *  ⛔⛔ NONE OF THIS WAS TESTABLE BEFORE. The caller was a closure inside
 *  `webclient-bootstrap`, so the picker's own tests saw a stub and the real
 *  reader was unreachable from anywhere — which is how it shipped reading 50
 *  rows and reporting a truncated answer as an empty one.
 *
 *  ⛔ These assert the REQUEST and the DISCLOSURE, not just that something came
 *  back: the defect was entirely in what was asked for and what was said about
 *  the answer, both of which a "returns options" test would have passed.
 */
import { describe, expect, it, vi } from 'vitest';

import { RECORDS_MAX_PAGE_SIZE } from '@recued/contracts';

import {
  bindRecordRefSearchToRecipe,
  createRecordRefSearchCaller,
} from '../record-ref-search.js';

const OWNER = { publisher: 'recued-core', pack_slug: 'ledger-book' } as const;
const row = (id: string, name?: string) => ({ id, ...(name === undefined ? {} : { name }) });

/** ⚠ A stub that IGNORES `filters` models a server that does not exist, and the
 *  code under test would pass while asking for something the real store refuses
 *  or answers differently. This applies `prefix` the way the store does —
 *  byte-exact and CASE-SENSITIVE (it compiles to a COLLATE BINARY range). */
const prefixAwareStub = (records: Array<Record<string, unknown>>) =>
  async (args: { filters?: Record<string, { op: string; value: string }> }) => {
    if (args.filters === undefined) return { records };
    const [[field, pred]] = Object.entries(args.filters);
    return { records: records.filter((r) => typeof r[field] === 'string'
      && (r[field] as string).startsWith(pred!.value)) };
  };

describe('record_ref search — recipe owner binding', () => {
  it('binds entity + scope to the exact publisher/pack bundle', () => {
    const caller = vi.fn(async () => []);
    const build = vi.fn(() => caller);
    const bound = bindRecordRefSearchToRecipe(build, {
      metadata: { recipe_bundle: 'recued-core/ledger-book' },
    });
    expect(bound).toBeDefined();
    expect(bound!('tag', { root_ref: 'tag/departments' })).toBe(caller);
    expect(build).toHaveBeenCalledWith(
      OWNER,
      'tag',
      { root_ref: 'tag/departments' },
    );
  });

  it('keeps standalone and malformed bundles on the raw-id fallback', () => {
    const build = vi.fn(() => vi.fn(async () => []));
    expect(bindRecordRefSearchToRecipe(build, undefined)).toBeUndefined();
    expect(bindRecordRefSearchToRecipe(build, { metadata: {} })).toBeUndefined();
    expect(bindRecordRefSearchToRecipe(build, {
      metadata: { recipe_bundle: 'publisher/pack/extra' },
    })).toBeUndefined();
    expect(build).not.toHaveBeenCalled();
  });
});

describe('record_ref search — what it asks for', () => {
  it('⛔⛔ asks for a FULL page, not the 50 it used to', async () => {
    const search = vi.fn().mockResolvedValue({ records: [row('a', 'Alpha')] });
    await createRecordRefSearchCaller({ search })(OWNER, 'account')('');
    expect(search).toHaveBeenCalledWith({
      owner: OWNER, entity: 'account', limit: RECORDS_MAX_PAGE_SIZE,
    });
    // pinned against the shipped value, so a silent shrink back is a red
    expect(search.mock.calls[0]![0].limit).toBe(200);
  });

  it('⛔ reads ONCE per picker, not once per keystroke', async () => {
    const search = vi.fn().mockResolvedValue({ records: [row('a', 'Alpha'), row('b', 'Beta')] });
    const caller = createRecordRefSearchCaller({ search })(OWNER, 'account');
    await caller('a'); await caller('al'); await caller('alp');
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('⚠ a FAILED read is not latched — the next keystroke retries', async () => {
    const search = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ records: [row('a', 'Alpha')] });
    const caller = createRecordRefSearchCaller({ search })(OWNER, 'account');
    await expect(caller('a')).rejects.toThrow('offline');
    expect((await caller('a')).options).toHaveLength(1);
    expect(search).toHaveBeenCalledTimes(2);
  });
});

describe('record_ref search — what it says about the answer', () => {
  const callerFor = (records: Array<Record<string, unknown>>) =>
    createRecordRefSearchCaller({ search: prefixAwareStub(records) })(OWNER, 'account');

  it('⛔⛔ a FULL page reports truncated — even when the filter matches nothing', async () => {
    // The case the whole change exists for: "no matches" over a capped read is
    // the reading that misleads, because it reads as a fact about the data.
    const full = Array.from({ length: RECORDS_MAX_PAGE_SIZE }, (_, i) => row(`r${i}`, `Row ${i}`));
    const out = await callerFor(full)('nothing-matches-this');
    expect(out.options).toHaveLength(0);
    expect(out.truncated).toBe(true);
  });

  it('⛔ a SHORT page reports complete — or the disclosure means nothing', async () => {
    const out = await callerFor([row('a', 'Alpha'), row('b', 'Beta')])('zzz');
    expect(out.options).toHaveLength(0);
    expect(out.truncated).toBe(false);
  });

  it('⛔ one row short of the cap is still complete', async () => {
    const nearly = Array.from({ length: RECORDS_MAX_PAGE_SIZE - 1 }, (_, i) => row(`r${i}`));
    expect((await callerFor(nearly)('')).truncated).toBe(false);
  });
});

describe('record_ref search — how it labels and filters', () => {
  const callerFor = (records: Array<Record<string, unknown>>) =>
    createRecordRefSearchCaller({ search: prefixAwareStub(records) })(OWNER, 'account');

  it('prefers a name field, falls back to another string, then to the id', async () => {
    const out = await callerFor([
      row('a', 'Alpha'),
      { id: 'b', kind: 'asset' },
      { id: 'c' },
    ])('');
    expect(out.options.map(o => o.label)).toEqual(['Alpha', 'asset', 'c']);
    // the id rides along so two rows sharing a label stay distinguishable —
    // except where the label IS the id, which would just print it twice
    expect(out.options.map(o => o.sublabel)).toEqual(['a', 'b', undefined]);
  });

  /** ⛔⛔ A REF IS NOT A LABEL. The fallback took the first non-id string, and
   *  refs are declared first in most warehouse schemas — so 13 of 21
   *  label-less entities would have shown `contract/abc` as the row's NAME. */
  it('⛔⛔ skips a `_ref` field and labels with the real string behind it', async () => {
    // expense-ledger.expense, exactly as it ships: source_ref first, merchant real
    const out = await callerFor([
      { id: 'e1', source_ref: 'receipt/xyz', filename: 'aldi.pdf', merchant: 'Aldi' },
    ])('');
    expect(out.options[0]!.label).toBe('aldi.pdf');
  });

  it('⛔ skips a `_ref` field holding a BARE id — no slash to recognise', async () => {
    // The discriminator the value-shape test alone cannot see. A `_ref` field in
    // a STRING slot (not a ref slot) is unconstrained: `expense.source_ref` is
    // declared s-family, so it can hold `xyz` with no `kind/` prefix at all.
    const out = await callerFor([{ id: 'e1', source_ref: 'xyz', merchant: 'Aldi' }])('');
    expect(out.options[0]!.label).toBe('Aldi');
  });

  it('⛔ skips a ref-SHAPED value even when the key says nothing', async () => {
    // ledger-book.tag_closure: `ancestor`/`descendant` carry `tag/x` and do not
    // end in _ref, so the name test alone would have missed them.
    const out = await callerFor([{ id: 'c1', ancestor: 'tag/home', descendant: 'tag/kitchen' }])('');
    expect(out.options[0]!.label).toBe('c1');
    expect(out.options[0]!.sublabel).toBeUndefined();
  });

  it('⛔ falls back to the row OWN id, never to a ref pointing elsewhere', async () => {
    const out = await callerFor([{ id: 'r1', contract_ref: 'contract/abc', unit_ref: 'unit/9' }])('');
    // `contract/abc` reads as this row's identity and is not
    expect(out.options[0]!.label).toBe('r1');
  });

  it('⚠ a real string wins over a ref even when the ref is declared first', async () => {
    const out = await callerFor([{ id: 'l1', batch_ref: 'batch/J-1', memo: 'August rent' }])('');
    expect(out.options[0]!.label).toBe('August rent');
  });

  it('⛔ drops a row with no usable id rather than offering an unselectable option', async () => {
    const out = await callerFor([row('a', 'Alpha'), { name: 'no id here' }])('');
    expect(out.options.map(o => o.id)).toEqual(['a']);
  });

  it('matches on the label OR the id, case-insensitively', async () => {
    const caller = callerFor([row('bank-01', 'Business bank'), row('card-02', 'Company card')]);
    expect((await caller('BUSINESS')).options.map(o => o.id)).toEqual(['bank-01']);
    expect((await caller('card-0')).options.map(o => o.id)).toEqual(['card-02']);
    // ⚠ substring, because the filter runs HERE. A server-side `prefix` filter
    // would NOT find 'Business bank' from 'bank' — the day the query is pushed
    // down, this assertion is the one that has to be re-decided.
    expect((await caller('bank')).options.map(o => o.id)).toEqual(['bank-01']);
  });
});

/** ⛔⛔ THE SERVER READ ADDS REACH; IT DOES NOT REPLACE THE LOCAL FILTER.
 *
 *  `prefix` is the only text predicate and compiles to a COLLATE BINARY range,
 *  so it is byte-exact and case-SENSITIVE. Swapping the local filter for it
 *  would lose matches the user can already see. These pin the union. */
describe('record_ref search — reaching past the page', () => {
  const full = (n: number) => Array.from({ length: n }, (_, i) => row(`r${i}`, `Row ${i}`));

  it('⛔⛔ finds a record BEYOND the page — the whole point of the widening', async () => {
    const search = vi.fn(async (args: { filters?: Record<string, unknown> }) =>
      args.filters === undefined
        ? { records: full(RECORDS_MAX_PAGE_SIZE) }               // the capped page
        : { records: [row('zz-late', 'Zebra Ltd')] });           // only the server has it
    const out = await createRecordRefSearchCaller({ search: search as never })(OWNER, 'account')('Zebra');
    expect(out.options.map(o => o.id)).toContain('zz-late');
    // and it asked with a PREFIX filter on the label the rows actually carry
    expect(search.mock.calls[1]![0]).toMatchObject({
      entity: 'account', filters: { name: { op: 'prefix', value: 'Zebra' } },
    });
  });

  it('⛔ keeps LOCAL matches the server-side prefix would have lost', async () => {
    // 'bank' is mid-string, so a prefix query cannot find it — but it is on the
    // page and the user can see it. Replacing the local filter would drop it.
    const search = vi.fn(async (args: { filters?: Record<string, unknown> }) =>
      args.filters === undefined
        ? { records: [row('a', 'Business bank'), ...full(RECORDS_MAX_PAGE_SIZE - 1)] }
        : { records: [] });
    const out = await createRecordRefSearchCaller({ search: search as never })(OWNER, 'account')('bank');
    expect(out.options.map(o => o.id)).toEqual(['a']);
  });

  it('⛔⛔ UNIONS both reads — each finds a record the other cannot', async () => {
    // The discriminator the previous test lacked: BOTH sides must return a
    // DIFFERENT match, or "replace the local with the remote" passes unnoticed.
    //   'My Zebra'   — substring, on the page, invisible to a prefix query
    //   'Zebra Corp' — prefix, past the page, invisible to the local filter
    const search = vi.fn(async (args: { filters?: Record<string, unknown> }) =>
      args.filters === undefined
        ? { records: [row('on-page', 'My Zebra'), ...full(RECORDS_MAX_PAGE_SIZE - 1)] }
        : { records: [row('past-page', 'Zebra Corp')] });
    const out = await createRecordRefSearchCaller({ search: search as never })(OWNER, 'account')('Zebra');
    expect(out.options.map(o => o.id)).toEqual(['on-page', 'past-page']);
  });

  it('⛔ does not double-list a record both reads returned', async () => {
    const search = vi.fn(async (args: { filters?: Record<string, unknown> }) =>
      args.filters === undefined
        ? { records: [row('dup', 'Zebra Ltd'), ...full(RECORDS_MAX_PAGE_SIZE - 1)] }
        : { records: [row('dup', 'Zebra Ltd')] });
    const out = await createRecordRefSearchCaller({ search: search as never })(OWNER, 'account')('Zebra');
    expect(out.options.filter(o => o.id === 'dup')).toHaveLength(1);
  });

  it('⛔⛔ a binding that REFUSES the filter degrades to the local answer, once', async () => {
    // 21 of 37 search bindings have no label to declare. An unusable server read
    // must not surface as an error, and must not be retried every keystroke.
    const search = vi.fn(async (args: { filters?: Record<string, unknown> }) => {
      if (args.filters !== undefined) throw new Error("filter field 'name' is not admitted");
      return { records: [row('a', 'Alpha'), ...full(RECORDS_MAX_PAGE_SIZE - 1)] };
    });
    const caller = createRecordRefSearchCaller({ search: search as never })(OWNER, 'account');
    expect((await caller('Alpha')).options.map(o => o.id)).toEqual(['a']);
    await caller('Alph'); await caller('Al');
    // one page read + exactly ONE failed probe, never repeated
    expect(search.mock.calls.filter(c => c[0].filters !== undefined)).toHaveLength(1);
  });

  it('⛔⛔ asks the server about the field it DISPLAYS, not literally `name`', async () => {
    // ledger-book.leg is found by its memo. Asking about `name` would answer a
    // question nobody asked — and leave every entity whose handle is not
    // called "name" unsearchable, which is most of them.
    const search = vi.fn(async (args: { filters?: Record<string, unknown> }) =>
      args.filters === undefined
        ? { records: Array.from({ length: RECORDS_MAX_PAGE_SIZE }, (_, i) =>
            ({ id: `l${i}`, batch_ref: 'batch/J-1', memo: `Line ${i}` })) }
        : { records: [{ id: 'late', batch_ref: 'batch/J-9', memo: 'August rent' }] });
    const out = await createRecordRefSearchCaller({ search: search as never })(OWNER, 'leg')('August');
    expect(search.mock.calls[1]![0]).toMatchObject({
      filters: { memo: { op: 'prefix', value: 'August' } },
    });
    expect(out.options.map(o => o.id)).toContain('late');
  });

  it('⛔ an entity with only REF strings gets no server reach at all', async () => {
    // tag_closure: ancestor/descendant are refs, so there is nothing to ask about.
    const search = vi.fn(async () => ({ records: Array.from(
      { length: RECORDS_MAX_PAGE_SIZE }, (_, i) => ({ id: `c${i}`, ancestor: 'tag/a', descendant: `tag/d${i}` })) }));
    await createRecordRefSearchCaller({ search: search as never })(OWNER, 'tag_closure')('tag');
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('⛔ an entity with NO label field never attempts a server read', async () => {
    const search = vi.fn(async () => ({ records: [{ id: 'x', amount: '1.00' }] }));
    const out = await createRecordRefSearchCaller({ search: search as never })(OWNER, 'leg')('x');
    expect(search).toHaveBeenCalledTimes(1);
    expect(out.options.map(o => o.id)).toEqual(['x']);
  });

  it('⚠ an EMPTY query never reaches the server — that is the page, by definition', async () => {
    const search = vi.fn(async () => ({ records: full(RECORDS_MAX_PAGE_SIZE) }));
    await createRecordRefSearchCaller({ search: search as never })(OWNER, 'account')('');
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('applies an editable-cell equality scope to both the page and server reach', async () => {
    const search = vi.fn(async (args: { filters?: Record<string, unknown> }) =>
      args.filters?.name === undefined
        ? { records: full(RECORDS_MAX_PAGE_SIZE) }
        : { records: [row('late', 'Zebra')] });
    const caller = createRecordRefSearchCaller({ search: search as never })(
      OWNER,
      'tag',
      { root_ref: 'tag/department' },
    );
    await caller('Zebra');
    expect(search).toHaveBeenNthCalledWith(1, expect.objectContaining({
      filters: { root_ref: { op: 'eq', value: 'tag/department' } },
    }));
    expect(search).toHaveBeenNthCalledWith(2, expect.objectContaining({
      filters: {
        root_ref: { op: 'eq', value: 'tag/department' },
        name: { op: 'prefix', value: 'Zebra' },
      },
    }));
  });

  it('⛔ truncated STAYS true after a successful server read — misses remain possible', async () => {
    // The server read is prefix + case-sensitive, so a case-variant or
    // mid-string match beyond the page is still unreachable. Clearing the flag
    // here would be the original bug wearing a new hat.
    const search = vi.fn(async (args: { filters?: Record<string, unknown> }) =>
      args.filters === undefined ? { records: full(RECORDS_MAX_PAGE_SIZE) }
        : { records: [row('zz', 'Zebra')] });
    const out = await createRecordRefSearchCaller({ search: search as never })(OWNER, 'account')('Zebra');
    expect(out.options.map(o => o.id)).toContain('zz');
    expect(out.truncated).toBe(true);
  });
});
