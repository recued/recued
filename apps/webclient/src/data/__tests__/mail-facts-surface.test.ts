/** D-315 §6.4 — Data → Received → Mail facts, the Facts view: what a row shows,
 *  how the filters become the query, paging, and the states around a read. */

import { describe, expect, it, vi } from 'vitest';

import type { MailFact, MailFactRow, MailFactRowsPage, MailFactRowsQuery, MailFactThing } from '@recued/contracts';

import {
  createMailFactsSurface,
  MAIL_FACTS_FILTER_ATTR,
  MAIL_FACTS_FOCUS_ATTR,
  type MailFactsSurfaceDeps,
} from '../mail-facts-surface.js';

const DAY = 86_400_000;
const ACTION = 'data-recued-data-action';

const fact = (fact_id: string, over: Partial<MailFact> = {}): MailFact => ({
  fact_id,
  type: 'shipment',
  template_id: 'mtpl_ups',
  email: { slug: 'work', record_id: `mail:${fact_id}` },
  email_at: 1_000,
  position: 0,
  identity_keys: [],
  thing_id: 'mthing_1',
  variables: { carrier: 'UPS', tracking_number: '1Z999', state: 'in_transit' },
  passes: { carrier: 'rule', tracking_number: 'standard', state: 'rule' },
  data: null,
  missing: [],
  refused: [],
  complete: true,
  source_hash: 'h',
  revision: 1,
  created_at: 1,
  ...over,
});

const thing = (variables: MailFactThing['variables']): MailFactThing => ({
  thing_id: 'mthing_1',
  type: 'shipment',
  identity_keys: [],
  variables,
  passes: {},
  variable_email_at: {},
  last_email_at: 1,
  missing: [],
  complete: true,
  created_at: 1,
  updated_at: 1,
});

const row = (fact_id: string, over: Partial<MailFactRow> = {}): MailFactRow => ({
  fact: fact(fact_id),
  email: {
    slug: 'work',
    record_id: `mail:${fact_id}`,
    from: 'pkginfo@ups.com',
    subject: `Parcel ${fact_id}`,
    at: Date.UTC(2026, 8, 20, 10),
    goes_at: Date.UTC(2026, 8, 20, 10) + 365 * DAY,
  },
  thing: thing({ state: 'delivered' }),
  of_email: { index: 1, count: 1 },
  runs: [],
  ...over,
});

const harness = (pages: MailFactRowsPage[] | ((q: MailFactRowsQuery) => Promise<MailFactRowsPage>)) => {
  const queries: MailFactRowsQuery[] = [];
  const renders = vi.fn();
  const listFacts = vi.fn(async (query: MailFactRowsQuery) => {
    queries.push(query);
    if (typeof pages === 'function') return pages(query);
    return pages.shift() ?? { rows: [] };
  });
  const deps: MailFactsSurfaceDeps = {
    callers: {
      listFacts,
      listTemplates: async () => ({
        templates: [{ template_id: 'mtpl_ups', name: 'UPS notices', type: 'shipment' } as never],
      }),
    },
    actionAttr: ACTION,
    render: renders,
    onAddressChange: vi.fn(),
  };
  const surface = createMailFactsSurface(deps);
  return { surface, queries, renders, deps };
};

const select = (key: string, value: string) =>
  ({ getAttribute: (name: string) => (name === MAIL_FACTS_FILTER_ATTR ? key : null), value }) as unknown as HTMLElement;

describe('a fact’s row (§6.4)', () => {
  it('shows the mail, the fact with each value’s pass, and the runs it started', async () => {
    const { surface } = harness([{
      rows: [row('a', {
        fact: fact('a', {
          missing: ['merchant'],
          refused: [{ variable: 'expected_at', reason: 'not a date' }],
          data: { items: [{ name: 'Mug' }] },
        }),
        of_email: { index: 1, count: 2 },
        runs: [
          { trigger_id: 't', recipe_id: 'r-alert', recipe_name: 'Parcel alert', run_id: 'run-1', outcome: 'held', status: 'succeeded', at: 5_000 },
          { trigger_id: 't', recipe_id: 'r-gone', outcome: 'failed', at: 6_000 },
        ],
      })],
    }]);
    await surface.refresh();
    const html = surface.render();
    // The mail opens the stored email.
    expect(html).toContain('href="#data/mail/record/work/mail%3Aa"');
    expect(html).toContain('Parcel a');
    expect(html).toContain('pkginfo@ups.com');
    expect(html).toContain('1 of 2 from this email');
    expect(html).toContain('Goes with its email after');
    // The thing's state now, and what this email said.
    expect(html).toContain('Delivered');
    expect(html).toContain('This email said: In transit');
    // Each value marked by its pass; a missing and a refused value marked too.
    expect(html).toMatch(/Tracking number<\/dt>\s*<dd><span class="mail-facts-value-text">1Z999<\/span> <span class="mail-facts-pass" data-pass="standard"/);
    expect(html).toMatch(/Carrier<\/dt>\s*<dd><span class="mail-facts-value-text">UPS<\/span> <span class="mail-facts-pass" data-pass="rule"/);
    expect(html).toMatch(/Merchant<\/dt>\s*<dd><span class="mail-facts-pass" data-pass="missing">Missing/);
    expect(html).toMatch(/Expected at<\/dt>\s*<dd><span class="mail-facts-pass" data-pass="refused">Refused<\/span> not a date/);
    expect(html).toContain('Read by UPS notices');
    expect(html).toContain('&quot;Mug&quot;');
    // A run: its status now wins over how the fire ended; one with no run id
    // cannot be opened.
    expect(html).toContain('href="#logs/run-1"');
    expect(html).toMatch(/Parcel alert<\/a>\s*<span class="mail-facts-run-state" data-tone="ok">Completed/);
    expect(html).toMatch(/<span>r-gone<\/span>\s*<span class="mail-facts-subtle">no longer installed<\/span>\s*<span class="mail-facts-run-state" data-tone="bad">Failed/);
  });

  it('marks an unpaired fact, and a fact whose email is gone', async () => {
    const { surface } = harness([{
      rows: [
        row('u', { fact: fact('u', { thing_id: null, template_id: null }), thing: null }),
        row('g', { email: null }),
        row('r', { email: null, mailbox_removed: true }),
      ],
    }]);
    await surface.refresh();
    const html = surface.render();
    expect(html).toContain('Its mailbox was removed from this server.');
    expect(html.match(/The email is no longer stored\./g)).toHaveLength(1);
    expect(html).toContain('data-unpaired="true"');
    expect(html).toContain('Unpaired');
    expect(html).toContain('An unpaired fact starts no recipe.');
    expect(html).toContain('Read from standard markup');
    expect(html).toContain('The email is no longer stored.');
  });

  it('shows a fact waiting for the AI as waiting, not unpaired, and says why the AI did not read one', async () => {
    const { surface } = harness([{
      rows: [
        row('w', { fact: fact('w', { thing_id: null, ai: { state: 'waiting', since: 1 } }), thing: null }),
        row('n', {
          fact: fact('n', {
            ai: { state: 'not_read', reason: 'no model was available in its pool', at: 2 },
            refused: [{ variable: 'merchant', reason: 'alias not restored' }],
          }),
        }),
        row('r', { fact: fact('r', { passes: { carrier: 'ai', tracking_number: 'rule' }, ai: { state: 'read', filled: ['carrier'], at: 2 } }) }),
      ],
    }]);
    await surface.refresh();
    const html = surface.render();
    expect(html).toMatch(/data-recued-mail-fact-row="w" data-ai="waiting"/);
    expect(html).not.toContain('data-unpaired="true"');
    expect(html).not.toContain('Unpaired: not joined');
    expect(html).toContain('Reading with AI… It joins its shipment, and can start recipes, once the AI has read it.');
    expect(html).toContain('Recipes wait until the AI has read it.');
    expect(html).toContain('The AI did not read it: no model was available in its pool. It went on with what the rules read.');
    expect(html).toMatch(/Merchant<\/dt>\s*<dd><span class="mail-facts-pass" data-pass="refused">Refused<\/span> alias not restored/);
    expect(html).toMatch(/Carrier<\/dt>\s*<dd><span class="mail-facts-value-text">UPS<\/span> <span class="mail-facts-pass" data-pass="ai" title="Filled in by AI">AI/);
  });

  it('escapes what the mail says', async () => {
    const { surface } = harness([{
      rows: [row('x', { email: { ...row('x').email!, subject: '<img src=x onerror=alert(1)>' } })],
    }]);
    await surface.refresh();
    const html = surface.render();
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('what a fact holds, as the owner left it', () => {
  it('shows data that was refused, as it shows a refused value', async () => {
    const { surface } = harness([{
      rows: [row('d', {
        fact: fact('d', {
          data: { items: [{ name: 'Mug', card: null }] },
          refused: [
            { variable: 'data.items[0].card', reason: 'holds a full card number' },
            { variable: 'data', reason: 'data over 16 KB' },
          ],
        }),
      })],
    }]);
    await surface.refresh();
    const html = surface.render();
    expect(html).toMatch(/<dt>Data items\[0\]\.card<\/dt>\s*<dd><span class="mail-facts-pass" data-pass="refused">Refused<\/span> holds a full card number<\/dd>/);
    expect(html).toMatch(/<dt>Data<\/dt>\s*<dd><span class="mail-facts-pass" data-pass="refused">Refused<\/span> data over 16 KB<\/dd>/);
  });

  it('keeps a fact’s Data open across a live refresh, and opening it repaints nothing', async () => {
    const { surface, renders } = harness(async () => ({
      rows: [row('a', { fact: fact('a', { data: { items: [{ name: 'Mug' }] } }) })],
    }));
    await surface.refresh();
    expect(surface.render()).toContain('<details class="mail-facts-data">');
    renders.mockClear();
    const summary = { getAttribute: (name: string) => (name === 'data-fact-id' ? 'a' : null) } as unknown as HTMLElement;
    expect(surface.handleAction('mail-facts-data-toggle', summary)).toBe(true);
    expect(renders).not.toHaveBeenCalled();
    await surface.refresh(true);
    expect(surface.render()).toContain('<details class="mail-facts-data" open>');
    surface.handleAction('mail-facts-data-toggle', summary);
    await surface.refresh(true);
    expect(surface.render()).toContain('<details class="mail-facts-data">');
  });
});

describe('the filters become the query', () => {
  it('maps each filter, the standard markup meaning no template', async () => {
    const { surface, queries } = harness(async () => ({ rows: [] }));
    await surface.refresh();
    for (const [key, value] of [
      ['type', 'shipment'], ['state', 'delivered'], ['template', '__standards__'],
      ['complete', 'no'], ['paired', 'unpaired'], ['runs', 'yes'],
    ] as const) {
      expect(surface.handleChange(select(key, value))).toBe(true);
    }
    await vi.waitFor(() => expect(queries).toHaveLength(7));
    expect(queries.at(-1)).toEqual({
      limit: 50,
      type: 'shipment',
      state: 'delivered',
      template_id: null,
      complete: false,
      unpaired: true,
      has_run: true,
    });
  });

  it('drops a state and a template of another type when the type changes', async () => {
    const { surface, queries } = harness(async () => ({ rows: [] }));
    await surface.refresh();
    surface.handleChange(select('template', 'mtpl_ups'));
    surface.handleChange(select('state', 'delivered'));
    surface.handleChange(select('type', 'bill'));
    await vi.waitFor(() => expect(queries).toHaveLength(4));
    expect(queries.at(-1)).toEqual({ limit: 50, type: 'bill' });
  });

  it('ignores a control that is not one of its filters', () => {
    const { surface } = harness([]);
    expect(surface.handleChange(select('nope', 'x'))).toBe(false);
  });
});

describe('paging and reads', () => {
  it('loads more after the last email, and does not repeat a row', async () => {
    const cursor = { email_at: 1_000, slug: 'work', record_id: 'mail:a' };
    const { surface, queries } = harness([
      { rows: [row('a')], next_cursor: cursor },
      { rows: [row('a'), row('b')] },
    ]);
    await surface.refresh();
    expect(surface.render()).toContain('Load more');
    surface.handleAction('mail-facts-load-more', {} as HTMLElement);
    await vi.waitFor(() => expect(queries).toHaveLength(2));
    expect(queries[1]).toEqual({ limit: 50, before: cursor });
    await vi.waitFor(() => expect(surface.render()).toContain('Parcel b'));
    const html = surface.render();
    expect(html.match(/data-recued-mail-fact-row="a"/g)).toHaveLength(1);
    expect(html).not.toContain('Load more');
    expect(surface.isBusy()).toBe(true); // a page walk: a broadcast must not reset it
  });

  it('keeps only the newest read when an older one lands late', async () => {
    let release: (page: MailFactRowsPage) => void = () => {};
    const slow = new Promise<MailFactRowsPage>((resolve) => { release = resolve; });
    let calls = 0;
    const { surface } = harness(async () => {
      calls += 1;
      return calls === 1 ? slow : { rows: [row('new')] };
    });
    const first = surface.refresh();
    await surface.refresh();
    release({ rows: [row('old')] });
    await first;
    expect(surface.render()).toContain('Parcel new');
    expect(surface.render()).not.toContain('Parcel old');
  });

  it('says so when a read fails, and tries again', async () => {
    let fail = true;
    const { surface } = harness(async () => {
      if (fail) throw Object.assign(new Error('boom'), { code: 'internal' });
      return { rows: [row('a')] };
    });
    await surface.refresh();
    expect(surface.render()).toContain('role="alert"');
    fail = false;
    surface.handleAction('mail-facts-retry', {} as HTMLElement);
    await vi.waitFor(() => expect(surface.render()).toContain('Parcel a'));
    expect(surface.render()).not.toContain('role="alert"');
  });

  it('shows loading before the first page, then the empty states', async () => {
    const { surface } = harness(async () => ({ rows: [] }));
    expect(surface.render()).toContain('Loading facts…');
    await surface.refresh();
    expect(surface.render()).toContain('No facts yet.');
    surface.handleChange(select('type', 'bill'));
    await vi.waitFor(() => expect(surface.render()).toContain('No facts match.'));
  });

  it('says the server cannot list facts when it has no caller', () => {
    const surface = createMailFactsSurface({ callers: {}, actionAttr: ACTION, render: () => {}, onAddressChange: () => {} });
    expect(surface.render()).toContain('This server cannot list mail facts.');
  });
});

describe('one email’s facts', () => {
  it('shows only that email’s, and back to all', async () => {
    const { surface, queries, deps } = harness(async () => ({ rows: [row('a')] }));
    await surface.showEmail({ slug: 'work', record_id: 'mail:a' }, 'Parcel a');
    expect(queries.at(-1)).toEqual({ limit: 50, email: { slug: 'work', record_id: 'mail:a' } });
    expect(deps.onAddressChange).toHaveBeenCalled();
    expect(surface.render()).toContain('Facts from one email: <strong>Parcel a</strong>');
    surface.handleAction('mail-facts-show-all', {} as HTMLElement);
    await vi.waitFor(() => expect(queries.at(-1)).toEqual({ limit: 50 }));
    expect(surface.render()).not.toContain('Facts from one email');
  });

  it('applies no filter its screen does not show, and gives them back with all facts', async () => {
    const { surface, queries } = harness(async () => ({ rows: [] }));
    await surface.refresh();
    surface.handleChange(select('type', 'bill'));
    await vi.waitFor(() => expect(queries.at(-1)).toEqual({ limit: 50, type: 'bill' }));
    // A parcel's email, opened from Mail while the list shows bills.
    await surface.showEmail({ slug: 'work', record_id: 'mail:a' }, 'Parcel a');
    expect(queries.at(-1)).toEqual({ limit: 50, email: { slug: 'work', record_id: 'mail:a' } });
    surface.handleAction('mail-facts-show-all', {} as HTMLElement);
    await vi.waitFor(() => expect(queries.at(-1)).toEqual({ limit: 50, type: 'bill' }));
  });
});

describe('address and focus', () => {
  it('addresses its view after the tab, and reads one back', () => {
    const { surface } = harness([]);
    expect(surface.addressSegments()).toEqual(['facts']);
    surface.openAddress(['nonsense']);
    expect(surface.addressSegments()).toEqual(['facts']);
  });

  it('puts focus back on the control that had it', () => {
    const { surface } = harness([]);
    const focus = vi.fn();
    const root = {
      querySelector: (selector: string) =>
        selector === `[${MAIL_FACTS_FOCUS_ATTR}="filter:type"]` ? { focus } : null,
    } as unknown as ParentNode;
    const key = surface.captureFocus({ getAttribute: () => 'filter:type' } as unknown as Element);
    surface.restoreFocus(root, key);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });
});

describe('a fact of a kind the owner made (§4.5)', () => {
  it('is named by the owner’s kind, and the kind can be filtered on', async () => {
    const wine = {
      // Its name is not what its id would read as: the list must use the kind.
      id: 'custom_wine_club_box', name: 'Monthly wine delivery', description: '',
      variables: [{ name: 'club', kind: 'text', required: true }], states: ['shipped'], notices: [], identity: [],
    };
    const { surface, deps } = harness([{
      rows: [row('c', { fact: fact('c', { type: 'custom_wine_club_box' as never, variables: { club: 'Vino', state: 'shipped' }, passes: { club: 'rule' } }), thing: null })],
    }]);
    (deps.callers as { listTypes?: unknown }).listTypes = async () => ({ types: [wine] });
    await surface.refresh();
    const html = surface.render();
    expect(html).toContain('<span class="data-pill">Monthly wine delivery</span>');
    expect(html).toContain('<option value="custom_wine_club_box">Monthly wine delivery</option>');
  });
});
