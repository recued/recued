import { describe, expect, it } from 'vitest';

import type { CollectionSearchGroup } from '@recued/contracts';

import {
  renderUniversalSearch,
  SEARCH_DID_YOU_MEAN_ACTION,
  SEARCH_DID_YOU_MEAN_QUERY_ATTR,
  SEARCH_OPEN_RECIPE_ACTION,
  SEARCH_OPEN_PACK_ACTION,
  SEARCH_MARKETPLACE_ACTION,
  SEARCH_OPEN_MARKET_PACK_ACTION,
} from '../data/universal-search.js';

const NOW = 1_800_000_000_000;
const base = { actionAttr: 'data-act' };

const group = (
  slug: string, platform: string, matches: unknown[], over: Record<string, unknown> = {},
): CollectionSearchGroup => ({
  slug, platform, matches, more: false,
  source_freshness: { stale: false },
  ...over,
} as unknown as CollectionSearchGroup);

const row = (over: Record<string, unknown> = {}) => ({
  record_id: 'r1', hot_fields: { subject: 'Kestrel item A pricing' },
  rank: -1, body: 'We would take 200 units at 50 USD a piece.', received_at: NOW,
  ...over,
});

describe('universal search renders groups, never a merged ranking', () => {
  it('keeps the server order and does not interleave rows across groups', () => {
    const html = renderUniversalSearch({
      ...base, query: 'kestrel',
      groups: [group('docs', 'file', [row({ record_id: 'f1' })]),
               group('inbox', 'mail', [row({ record_id: 'm1' })])],
    }, NOW);
    // ⛔ Group order is the server's (hit count). A renderer that re-sorted, or
    // that flattened rows into one list, would be asserting a cross-store
    // relevance comparison the substrate cannot make.
    expect(html.indexOf('docs')).toBeLessThan(html.indexOf('inbox'));
    // ⚠ Count the SECTION class exactly — /rq-group\b/ also matches
    // rq-group-head and rq-group-name, because the hyphen is a word boundary.
    expect(html.match(/class="rq-group"/g)).toHaveLength(2);
  });

  it('summarises the spread rather than a single count', () => {
    const html = renderUniversalSearch({
      ...base, query: 'k',
      groups: [group('a', 'mail', [row(), row()]), group('b', 'file', [row()])],
    }, NOW);
    expect(html).toContain('3 in 2 places');
  });

  it('marks a group that has more, and offers a way in', () => {
    const html = renderUniversalSearch({
      ...base, query: 'k', groups: [group('inbox', 'mail', [row()], { more: true })],
    }, NOW);
    expect(html).toContain('universal-search-open-group');
    expect(html).toContain('More in inbox');
  });
});

/** ⚠ THE LABELS ARE THE HONESTY. An unlabelled weak row is indistinguishable
 *  from one the owner asked for — the entire argument for carrying
 *  `partial_match` / `thread_context` on the wire. */
describe('it surfaces why a weak row is on the page', () => {
  it('labels a partial-term match', () => {
    const html = renderUniversalSearch({
      ...base, query: 'k', groups: [group('inbox', 'mail', [row({ partial_match: true })])],
    }, NOW);
    expect(html).toContain('some terms');
  });

  it('labels a row that matched nothing and rode in on thread adjacency', () => {
    const html = renderUniversalSearch({
      ...base, query: 'k', groups: [group('inbox', 'mail', [row({ thread_context: true })])],
    }, NOW);
    expect(html).toContain('thread context');
  });

  it('says when a record has more content than is shown', () => {
    const html = renderUniversalSearch({
      ...base, query: 'k', groups: [group('inbox', 'mail', [row({ body_truncated: true })])],
    }, NOW);
    expect(html).toContain('more content');
  });

  it('flags a stale source, because absence may just be un-synced', () => {
    const html = renderUniversalSearch({
      ...base, query: 'k',
      groups: [group('inbox', 'mail', [row()], { source_freshness: { stale: true } })],
    }, NOW);
    expect(html).toContain('may be out of date');
  });
});

describe('its empty and error states', () => {
  it('keeps record hits visible while installed capabilities are still loading', () => {
    const html = renderUniversalSearch({
      ...base, query: 'kestrel', capabilitiesLoading: true,
      groups: [group('inbox', 'mail', [row()])],
    }, NOW);
    expect(html).toContain('Kestrel item A pricing');
    expect(html).toContain('Searching installed recipes and packs');
    expect(html).not.toContain('No matches in the searched sources');
  });

  it('keeps capability hits visible while records are still loading', () => {
    const html = renderUniversalSearch({
      ...base, query: 'kestrel', loading: true,
      recipes: [{ recipe_id: 'kestrel', name: 'Kestrel recipe' }],
      marketplaceOffered: true,
    }, NOW);
    expect(html).toContain('Kestrel recipe');
    expect(html).toContain('Searching records');
    expect(html).not.toContain(SEARCH_MARKETPLACE_ACTION);
  });

  it('waits for every local search before claiming nothing matches or offering the cloud', () => {
    for (const pending of [{ loading: true }, { workLoading: true }, { capabilitiesLoading: true }]) {
      const html = renderUniversalSearch({
        ...base, query: 'kestrel', groups: [], marketplaceOffered: true, ...pending,
      }, NOW);
      expect(html).toContain('role="status"');
      expect(html).not.toContain('No matches in the searched sources');
      expect(html).not.toContain(SEARCH_MARKETPLACE_ACTION);
    }
  });

  // ⛔ "No results" alone cannot be told apart from "the search did not run".
  it('names the scope it searched when nothing matched', () => {
    const html = renderUniversalSearch({ ...base, query: 'zzz', groups: [] }, NOW);
    expect(html).toContain('No matches in the searched sources');
    expect(html).toContain('still syncing');
  });

  it('prompts rather than searching on a blank query', () => {
    expect(renderUniversalSearch({ ...base, query: '   ' }, NOW)).toContain('Type to search');
  });

  it('keeps failed searches retryable without claiming an empty result or offering the cloud', () => {
    for (const error of [{ error: 'server unreachable' }, { workError: 'server unreachable' }, { capabilitiesError: 'server unreachable' }]) {
      const html = renderUniversalSearch({ ...base, query: 'k', ...error, marketplaceOffered: true }, NOW);
      expect(html).toContain('server unreachable');
      expect(html).toContain('universal-search-retry');
      expect(html).not.toContain('No matches in the searched sources');
      expect(html).not.toContain(SEARCH_MARKETPLACE_ACTION);
    }
  });
});

describe('it escapes what the warehouse holds', () => {
  it('escapes a hostile subject and query rather than rendering markup', () => {
    const html = renderUniversalSearch({
      ...base, query: '<img src=x onerror=alert(1)>',
      groups: [group('inbox', 'mail', [row({ hot_fields: { subject: '<script>alert(1)</script>' } })])],
    }, NOW);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
  });

  it('falls back to the record id, never to a body slice, for a title', () => {
    // ⛔ A body fragment as a title reads as content the owner can act on when
    // it is really the first N characters of something else.
    const html = renderUniversalSearch({
      ...base, query: 'k',
      groups: [group('inbox', 'mail', [row({ record_id: 'mail:xyz', hot_fields: {} })])],
    }, NOW);
    expect(html).toContain('mail:xyz');
  });
});

/** Installed recipes are the owner's CAPABILITIES, not their records. */
describe('the capabilities group', () => {
  const recipe = (over = {}) => ({
    recipe_id: 'recued-core/invoice-book',
    name: 'Invoice book',
    description: 'Track what customers owe you.',
    publisher_id: 'recued-core',
    ...over,
  });

  it('renders as its own group, not merged into a collection', () => {
    const html = renderUniversalSearch({
      ...base, query: 'invoice',
      groups: [group('inbox', 'mail', [row()])],
      recipes: [recipe()],
    }, NOW);
    expect(html).toContain('Things this server can do');
    expect(html).toContain('Invoice book');
    expect(html).toContain(SEARCH_OPEN_RECIPE_ACTION);
  });

  // ⚠ A search is usually for a THING the owner has. Capabilities above records
  // would answer a question that was not asked.
  it('renders AFTER the record groups', () => {
    const html = renderUniversalSearch({
      ...base, query: 'invoice',
      groups: [group('inbox', 'mail', [row()])],
      recipes: [recipe()],
    }, NOW);
    expect(html.indexOf('rq-group-recipes')).toBeGreaterThan(html.indexOf('class="rq-group"'));
  });

  it('counts capabilities as a place in the summary', () => {
    const html = renderUniversalSearch({
      ...base, query: 'invoice',
      groups: [group('inbox', 'mail', [row()])],
      recipes: [recipe()],
    }, NOW);
    expect(html).toContain('2 in 2 places');
  });

  it('is a result on its own when no record matched', () => {
    const html = renderUniversalSearch({
      ...base, query: 'invoice', groups: [], recipes: [recipe()],
    }, NOW);
    expect(html).not.toContain('No matches in the searched sources');
    expect(html).toContain('Invoice book');
  });

  it('escapes a hostile recipe name', () => {
    const html = renderUniversalSearch({
      ...base, query: 'x', groups: [],
      recipes: [recipe({ name: '<script>alert(1)</script>' })],
    }, NOW);
    expect(html).not.toContain('<script>');
  });
});

describe('the packs group', () => {
  const pack = (over = {}) => ({
    slug: 'fleet-money', name: 'Fleet money',
    description: 'Run assigned jobs and worker payments.',
    publisher: 'recued-core', ...over,
  });

  it('renders packs above loose recipes — the coarser answer first', () => {
    const html = renderUniversalSearch({
      ...base, query: 'money', groups: [],
      packs: [pack()],
      recipes: [{ recipe_id: 'r/x', name: 'Settlements' }],
    }, NOW);
    expect(html.indexOf('rq-group-packs')).toBeLessThan(html.indexOf('rq-group-recipes'));
  });

  it('opens the pack detail, which owns install and grants', () => {
    const html = renderUniversalSearch({ ...base, query: 'money', groups: [], packs: [pack()] }, NOW);
    expect(html).toContain(SEARCH_OPEN_PACK_ACTION);
    expect(html).toContain('Fleet money');
  });

  /** ⛔ THE ABSORPTION RULE. A member surfacing on its own must say where it came
   *  from — otherwise the owner sees a bare recipe name with no route back to the
   *  thing that installed it. Suppressing every bundled member instead would be
   *  tidier and would LOSE the hit entirely: measured on the shipped corpus,
   *  `fleet-money` carries "Settlements" and the pack's own text never says it. */
  it('attributes a member whose pack did NOT match', () => {
    const html = renderUniversalSearch({
      ...base, query: 'settlements', groups: [], packs: [],
      recipes: [{ recipe_id: 'r/s', name: 'Settlements', bundle: 'recued-core/fleet-money' }],
    }, NOW);
    expect(html).toContain('Settlements');
    expect(html).toContain('from recued-core/fleet-money');
  });

  it('counts packs as their own place in the summary', () => {
    const html = renderUniversalSearch({
      ...base, query: 'money', groups: [group('inbox', 'mail', [row()])],
      packs: [pack()], recipes: [{ recipe_id: 'r/x', name: 'Settlements' }],
    }, NOW);
    expect(html).toContain('3 in 3 places');
  });

  it('a pack alone is a result, not an empty state', () => {
    const html = renderUniversalSearch({ ...base, query: 'money', groups: [], packs: [pack()] }, NOW);
    expect(html).not.toContain('No matches in the searched sources');
  });
});

/** ⛔⛔ THE MARKETPLACE PATH IS THE ONLY THING HERE THAT LEAVES THE MACHINE.
 *  Everything else in this surface is local, so the tests that matter are about
 *  WHEN it appears and whether the owner can tell it apart from what they own. */
describe('the marketplace path (cold start)', () => {
  const market = (over = {}) => ({
    slug: 'invoice-book', name: 'Invoice book',
    description: 'Track what customers owe you.',
    publisher_id: 'recued-core', ...over,
  });

  it('offers nothing when the owner HAS results — never competes with their own', () => {
    const html = renderUniversalSearch({
      ...base, query: 'invoice',
      groups: [group('inbox', 'mail', [row()])],
      marketplaceOffered: true,
    }, NOW);
    expect(html).not.toContain(SEARCH_MARKETPLACE_ACTION);
  });

  it('offers only on an empty own-result, and NAMES the cloud', () => {
    const html = renderUniversalSearch({
      ...base, query: 'invoicing', groups: [], marketplaceOffered: true,
    }, NOW);
    expect(html).toContain(SEARCH_MARKETPLACE_ACTION);
    expect(html).toContain('marketplace');
    // ⚠ The owner is about to send their query off this machine. A button
    // reading "search more" would hide that; this must say so.
    expect(html).toContain('sends your search to the Recued marketplace');
  });

  it('does not offer at all when no marketplace caller is wired', () => {
    const html = renderUniversalSearch({ ...base, query: 'invoicing', groups: [] }, NOW);
    expect(html).not.toContain(SEARCH_MARKETPLACE_ACTION);
  });

  it('⛔ every marketplace row says NOT INSTALLED', () => {
    const html = renderUniversalSearch({
      ...base, query: 'invoicing', groups: [],
      marketplaceOffered: true, marketplace: [market()],
    }, NOW);
    // The one unforgivable outcome is an owner acting on a capability they
    // believe is already theirs — heading, badge and destination all carry it.
    expect(html).toContain('Available to install');
    expect(html).toContain('not installed');
    expect(html).toContain(SEARCH_OPEN_MARKET_PACK_ACTION);
  });

  it('replaces the offer once results are back', () => {
    const html = renderUniversalSearch({
      ...base, query: 'invoicing', groups: [],
      marketplaceOffered: true, marketplace: [market()],
    }, NOW);
    expect(html).not.toContain(SEARCH_MARKETPLACE_ACTION);
  });

  it('shows the call in flight, and an error if it fails', () => {
    expect(renderUniversalSearch({
      ...base, query: 'x', groups: [], marketplaceOffered: true, marketplaceLoading: true,
    }, NOW)).toContain('Asking the marketplace');
    expect(renderUniversalSearch({
      ...base, query: 'x', groups: [], marketplaceOffered: true,
      marketplaceError: 'marketplace unreachable',
    }, NOW)).toContain('marketplace unreachable');
  });

  it('escapes a hostile marketplace name', () => {
    const html = renderUniversalSearch({
      ...base, query: 'x', groups: [], marketplaceOffered: true,
      marketplace: [market({ name: '<script>alert(1)</script>' })],
    }, NOW);
    expect(html).not.toContain('<script>');
  });
});

describe('did you mean', () => {
  const dym = {
    query: 'Castellanos invoice',
    corrections: [{ typed: 'Castelanos', word: 'Castellanos', records: 2 }],
  };

  it('offers the corrected query as a button that runs it, the corrected word in bold', () => {
    const html = renderUniversalSearch({
      ...base, query: 'Castelanos invoice', groups: [], didYouMean: dym,
    }, NOW);
    expect(html).toContain(`data-act="${SEARCH_DID_YOU_MEAN_ACTION}"`);
    expect(html).toContain(`${SEARCH_DID_YOU_MEAN_QUERY_ATTR}="Castellanos invoice"`);
    expect(html).toContain('<strong>Castellanos</strong> invoice</button>?');
  });

  it('shows beside results as well as on an empty page — what is listed still answers what was typed', () => {
    const withRows = renderUniversalSearch({
      ...base, query: 'Castelanos invoice', groups: [group('inbox', 'mail', [row()])], didYouMean: dym,
    }, NOW);
    expect(withRows).toContain('Did you mean');
    expect(withRows).toContain('1 in 1 place');
    const empty = renderUniversalSearch({
      ...base, query: 'Castelanos invoice', groups: [], didYouMean: dym,
    }, NOW);
    expect(empty).toContain('Did you mean');
    expect(empty).toContain('No matches in the searched sources');
  });

  it('is absent without a suggestion', () => {
    expect(renderUniversalSearch({ ...base, query: 'Castellanos', groups: [] }, NOW))
      .not.toContain('Did you mean');
  });

  it('⛔ escapes the query, and a corrected word cannot land inside an entity', () => {
    const html = renderUniversalSearch({
      ...base, query: 'Tom & anp Jery <b>', groups: [],
      didYouMean: {
        query: 'Tom & amp Jerry <b>',
        corrections: [
          { typed: 'anp', word: 'amp', records: 1 },
          { typed: 'Jery', word: 'Jerry', records: 1 },
        ],
      },
    }, NOW);
    // `amp` is bold where it stands, never inside the `&amp;` the escape made.
    expect(html).toContain('Tom &amp; <strong>amp</strong> <strong>Jerry</strong> &lt;b&gt;</button>');
    expect(html).not.toContain('<b>');
  });
});

describe('words the stores dropped', () => {
  it('⛔ says beside the results that they match only the other words', () => {
    const html = renderUniversalSearch({
      ...base, query: 'Castelanos invoice', groups: [group('inbox', 'mail', [row()])], absentWords: ['Castelanos'],
    }, NOW);
    expect(html).toContain('No searched mail, calendar or file record holds “Castelanos”, so those collection results match only your other words.');
    // Before the count, which would otherwise read as an answer to the whole query.
    expect(html.indexOf('No searched mail, calendar or file record holds')).toBeLessThan(html.indexOf('1 in 1 place'));
  });

  it('lists several words, and escapes them', () => {
    const html = renderUniversalSearch({
      ...base, query: 'x', groups: [group('inbox', 'mail', [row()])], absentWords: ['Zylberstein', '<b>Kestral'],
    }, NOW);
    expect(html).toContain('No searched mail, calendar or file record holds “Zylberstein” or “&lt;b&gt;Kestral”, so those collection results');
    expect(html).not.toContain('<b>Kestral');
  });

  it('says nothing on an empty page, which already says nothing matched', () => {
    const html = renderUniversalSearch({ ...base, query: 'Zylberstein', groups: [], absentWords: ['Zylberstein'] }, NOW);
    expect(html).not.toContain('No searched mail, calendar or file record holds');
    expect(html).toContain('No matches in the searched sources');
  });

  it('says nothing beside installed recipes alone — they are matched by another rule', () => {
    const html = renderUniversalSearch({
      ...base, query: 'Zylberstein invoice', groups: [],
      recipes: [{ recipe_id: 'r', name: 'Invoice chaser' }], absentWords: ['Zylberstein'],
    }, NOW);
    expect(html).not.toContain('No searched mail, calendar or file record holds');
  });
});

