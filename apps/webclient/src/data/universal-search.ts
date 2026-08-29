/** UNIVERSAL SEARCH — one query across every collection the owner holds,
 *  rendered GROUPED BY COLLECTION.
 *
 *  🔑 WHY IT EXISTS: until this, the only way to search across mail / calendar /
 *  files / webhooks was to ASK THE AI. That is an odd shape for a product whose
 *  thesis is that the AI is optional and the owner is in control — the non-AI
 *  path to your own warehouse simply did not exist. The explorer next door
 *  browses ONE collection at a time and needs you to know which lens to open.
 *
 *  ⛔⛔ NO GLOBAL RANKING, AND THAT IS THE DESIGN. FTS5 `rank` is BM25 computed
 *  per index, so a mail rank of -3.8 and a file rank of -2.1 are scored against
 *  different corpora and are not comparable. Interleaving them yields an order
 *  that LOOKS authoritative and means nothing — the same class of lie as a
 *  snippet standing in for a record. Groups are ordered by hit count (server
 *  side), and this renderer does not reorder them.
 *
 *  ⚠ THE LABELS MUST SURVIVE TO THE SCREEN. `partial_match` marks a row that
 *  matched only SOME query terms, `thread_context` a row pulled in for adjacency
 *  that matched none. Unlabelled, either is indistinguishable from a row the
 *  owner asked for — which is the entire argument for carrying the labels on the
 *  wire. Rendering them flat would discard the honesty they exist to provide.
 *
 *  Pure render (HTML strings) + styles + click-dispatch constants the route
 *  wires — mirrors `collection-explorer.ts` and `memory-lens.ts`. */

import type { CollectionSearchGroup, CollectionSearchMatch } from '@recued/contracts';

/** Click-dispatch contract with the route's `onClick`. */
export const SEARCH_OPEN_RECORD_ACTION = 'universal-search-open-record';
export const SEARCH_OPEN_GROUP_ACTION = 'universal-search-open-group';
export const SEARCH_RETRY_ACTION = 'universal-search-retry';
export const SEARCH_RECORD_ID_ATTR = 'data-search-record';
export const SEARCH_GROUP_SLUG_ATTR = 'data-search-slug';
export const SEARCH_GROUP_PLATFORM_ATTR = 'data-search-platform';
export const SEARCH_INPUT_ATTR = 'data-recued-universal-search-input';
export const SEARCH_OPEN_RECIPE_ACTION = 'universal-search-open-recipe';
export const SEARCH_RECIPE_ID_ATTR = 'data-search-recipe';
export const SEARCH_OPEN_PACK_ACTION = 'universal-search-open-pack';
export const SEARCH_PACK_SLUG_ATTR = 'data-search-pack';
export const SEARCH_MARKETPLACE_ACTION = 'universal-search-marketplace';
export const SEARCH_OPEN_MARKET_PACK_ACTION = 'universal-search-open-market-pack';

/** An installed capability that matched. Deliberately NOT a
 *  `CollectionSearchGroup`: a recipe has no `record_id`, no `received_at` and no
 *  source to be stale — forcing it into that shape would mean inventing fields
 *  that mean nothing, which is the same fabrication as inventing a cross-store
 *  rank. Different kind of thing, different shape, its own group. */
export interface UniversalSearchRecipeMatch {
  recipe_id: string;
  name: string;
  description?: string;
  publisher_id?: string;
  /** The pack that carries this recipe, when its pack did NOT itself match.
   *  Shown so a member surfacing on its own still says where it came from. */
  bundle?: string;
}

/** An installed pack that matched — the coarser granularity of the same
 *  capability question. */
export interface UniversalSearchPackMatch {
  slug: string;
  name: string;
  description?: string;
  publisher?: string;
}

/** A marketplace pack the owner does NOT have. Kept a distinct type from
 *  `UniversalSearchPackMatch` on purpose: the only thing that matters about it
 *  is that it is NOT INSTALLED, and a shared shape would let that distinction be
 *  lost by a careless render. */
export interface UniversalSearchMarketMatch {
  slug: string;
  name: string;
  description?: string;
  publisher_id?: string;
}

export interface UniversalSearchProps {
  /** What the owner typed. */
  query: string;
  /** In flight — a query is running. */
  loading?: boolean;
  /** `collection.searchAll` groups, server-ordered by hit count. */
  groups?: ReadonlyArray<CollectionSearchGroup>;
  /** Installed recipes matching the same query — the owner's CAPABILITIES, as
   *  opposed to their records. Ranked by the shared `rankSearchable`, so this
   *  agrees with what `tools.search` finds for the AI. */
  recipes?: ReadonlyArray<UniversalSearchRecipeMatch>;
  /** Installed packs matching the same query. A pack whose MEMBER also matched
   *  absorbs that member — see the caller — so the same capability is not listed
   *  at two granularities. */
  packs?: ReadonlyArray<UniversalSearchPackMatch>;
  /** ⛔ OWNER-INITIATED ONLY. Searching the marketplace sends the query to the
   *  CLOUD, and this box is otherwise entirely local. Typing must never become a
   *  stream of cloud queries — the difference between "I opened Discover and
   *  searched" and "my private search silently left the machine" is the whole
   *  posture. Populated only after an explicit click. */
  marketplace?: ReadonlyArray<UniversalSearchMarketMatch>;
  /** True while that explicit marketplace call is in flight. */
  marketplaceLoading?: boolean;
  /** An offer to search the marketplace is shown only when a caller is wired
   *  AND the owner's own results are empty — never alongside their own hits. */
  marketplaceOffered?: boolean;
  marketplaceError?: string;
  error?: string;
  /** The route's action-attribute name. */
  actionAttr: string;
}

const e = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** ⛔ A row's title comes from hot fields, NOT from the body. Mail has a
 *  subject, calendar a summary, a file a path — and a record with none of them
 *  falls back to its id rather than to a slice of body text, because a body
 *  fragment reads as content the owner can act on when it is really just the
 *  first N characters of something else. */
const rowTitle = (m: CollectionSearchMatch): string => {
  const hot = m.hot_fields as Record<string, unknown>;
  for (const key of ['subject', 'summary', 'name', 'path', 'title']) {
    const v = hot[key];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return m.record_id;
};

/** A short, plain excerpt of the record's own text. `body` is the record (the
 *  snippet was retired 2026-08-28); this trims for display only and says so with
 *  an ellipsis rather than implying the record ends here. */
const excerpt = (m: CollectionSearchMatch, max = 160): string => {
  const body = typeof m.body === 'string' ? m.body.replace(/\s+/g, ' ').trim() : '';
  if (body.length === 0) return '';
  return body.length > max ? `${body.slice(0, max)}…` : body;
};

const when = (m: CollectionSearchMatch, now: number): string => {
  if (typeof m.received_at !== 'number') return '';
  const days = Math.floor((now - m.received_at) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return new Date(m.received_at).toISOString().slice(0, 10);
};

/** ⚠ RENDERED, NOT DROPPED. See the header: an unlabelled weak row is
 *  indistinguishable from one the owner asked for. */
const rowBadges = (m: CollectionSearchMatch): string => {
  const badges: string[] = [];
  if (m.partial_match) {
    badges.push('<span class="rq-badge rq-badge-partial" title="Matched only some of your search terms">some terms</span>');
  }
  if (m.thread_context) {
    badges.push('<span class="rq-badge rq-badge-thread" title="Matched no search term — included because it sits between messages that did">thread context</span>');
  }
  if (m.body_truncated) {
    badges.push('<span class="rq-badge rq-badge-trunc" title="This record has more content than is shown">more content</span>');
  }
  return badges.join('');
};

/** ⛔ THE ROW CARRIES ITS GROUP'S COORDINATES, not just the record id. Opening a
 *  record means handing off to the explorer for the collection that OWNS it, and
 *  the search tab is not that collection — a `record_id` alone leaves the
 *  receiver to guess the platform + instance from `activeTab`, which on this tab
 *  resolves to nothing and dies silently. Measured: the click was inert. */
const renderRow = (
  m: CollectionSearchMatch,
  g: Pick<CollectionSearchGroup, 'platform' | 'slug'>,
  actionAttr: string,
  now: number,
): string => {
  const ex = excerpt(m);
  const ts = when(m, now);
  return `<li class="rq-row">
  <button type="button" class="rq-row-btn"
    ${e(actionAttr)}="${SEARCH_OPEN_RECORD_ACTION}"
    ${SEARCH_RECORD_ID_ATTR}="${e(m.record_id)}"
    ${SEARCH_GROUP_SLUG_ATTR}="${e(g.slug)}"
    ${SEARCH_GROUP_PLATFORM_ATTR}="${e(g.platform)}">
    <span class="rq-row-title">${e(rowTitle(m))}</span>
    ${ts ? `<span class="rq-row-when">${e(ts)}</span>` : ''}
    ${ex ? `<span class="rq-row-excerpt">${e(ex)}</span>` : ''}
    ${rowBadges(m)}
  </button>
</li>`;
};

const renderGroup = (g: CollectionSearchGroup, actionAttr: string, now: number): string => {
  const stale = g.source_freshness?.stale === true;
  return `<section class="rq-group">
  <h3 class="rq-group-head">
    <span class="rq-group-name">${e(g.slug)}</span>
    <span class="rq-group-platform">${e(g.platform)}</span>
    <span class="rq-group-count">${g.matches.length}${g.more ? '+' : ''}</span>
    ${stale ? '<span class="rq-badge rq-badge-stale" title="This source has not synced recently — there may be newer records">may be out of date</span>' : ''}
  </h3>
  <ul class="rq-rows">${g.matches.map((m) => renderRow(m, g, actionAttr, now)).join('')}</ul>
  ${g.more ? `<button type="button" class="rq-more"
      ${e(actionAttr)}="${SEARCH_OPEN_GROUP_ACTION}"
      ${SEARCH_GROUP_SLUG_ATTR}="${e(g.slug)}"
      ${SEARCH_GROUP_PLATFORM_ATTR}="${e(g.platform)}">More in ${e(g.slug)}</button>` : ''}
</section>`;
};

/** ⚠ RENDERED LAST, and that ordering is a judgement worth stating. A search is
 *  usually for a THING the owner has (an email, a file), not for a capability;
 *  putting installed recipes above records would answer a question that was not
 *  asked. They are present because "what can this server already do about
 *  invoices?" has had no non-AI answer at all — not because they outrank mail. */
const renderRecipeGroup = (
  recipes: ReadonlyArray<UniversalSearchRecipeMatch>,
  actionAttr: string,
): string => `<section class="rq-group rq-group-recipes">
  <h3 class="rq-group-head">
    <span class="rq-group-name">Things this server can do</span>
    <span class="rq-group-platform">installed</span>
    <span class="rq-group-count">${recipes.length}</span>
  </h3>
  <ul class="rq-rows">${recipes.map((r) => `<li class="rq-row">
    <button type="button" class="rq-row-btn"
      ${e(actionAttr)}="${SEARCH_OPEN_RECIPE_ACTION}"
      ${SEARCH_RECIPE_ID_ATTR}="${e(r.recipe_id)}">
      <span class="rq-row-title">${e(r.name)}</span>
      ${r.bundle !== undefined
        ? `<span class="rq-row-when">from ${e(r.bundle)}</span>`
        : r.publisher_id !== undefined ? `<span class="rq-row-when">${e(r.publisher_id)}</span>` : ''}
      ${r.description !== undefined && r.description.length > 0
        ? `<span class="rq-row-excerpt">${e(
            r.description.length > 160 ? `${r.description.slice(0, 160)}…` : r.description,
          )}</span>`
        : ''}
    </button>
  </li>`).join('')}</ul>
</section>`;

const renderPackGroup = (
  packs: ReadonlyArray<UniversalSearchPackMatch>,
  actionAttr: string,
): string => `<section class="rq-group rq-group-packs">
  <h3 class="rq-group-head">
    <span class="rq-group-name">Installed packs</span>
    <span class="rq-group-platform">bundle</span>
    <span class="rq-group-count">${packs.length}</span>
  </h3>
  <ul class="rq-rows">${packs.map((p) => `<li class="rq-row">
    <button type="button" class="rq-row-btn"
      ${e(actionAttr)}="${SEARCH_OPEN_PACK_ACTION}"
      ${SEARCH_PACK_SLUG_ATTR}="${e(p.slug)}">
      <span class="rq-row-title">${e(p.name)}</span>
      ${p.publisher !== undefined ? `<span class="rq-row-when">${e(p.publisher)}</span>` : ''}
      ${p.description !== undefined && p.description.length > 0
        ? `<span class="rq-row-excerpt">${e(
            p.description.length > 160 ? `${p.description.slice(0, 160)}…` : p.description,
          )}</span>`
        : ''}
    </button>
  </li>`).join('')}</ul>
</section>`;

/** ⛔⛔ EVERY ROW SAYS "NOT INSTALLED". These are things the owner does NOT have,
 *  sitting in a surface that otherwise shows only what they DO have — and the
 *  one unforgivable outcome is an owner acting on a capability they believe is
 *  already theirs. The group heading, the per-row badge and the destination all
 *  carry it; any one alone would be a single point of failure for that meaning. */
const renderMarketGroup = (
  market: ReadonlyArray<UniversalSearchMarketMatch>,
  actionAttr: string,
): string => `<section class="rq-group rq-group-market">
  <h3 class="rq-group-head">
    <span class="rq-group-name">Available to install</span>
    <span class="rq-group-platform">not installed</span>
    <span class="rq-group-count">${market.length}</span>
  </h3>
  <ul class="rq-rows">${market.map((m) => `<li class="rq-row">
    <button type="button" class="rq-row-btn"
      ${e(actionAttr)}="${SEARCH_OPEN_MARKET_PACK_ACTION}"
      ${SEARCH_PACK_SLUG_ATTR}="${e(m.slug)}">
      <span class="rq-row-title">${e(m.name)}</span>
      <span class="rq-badge rq-badge-market">not installed</span>
      ${m.publisher_id !== undefined ? `<span class="rq-row-when">${e(m.publisher_id)}</span>` : ''}
      ${m.description !== undefined && m.description.length > 0
        ? `<span class="rq-row-excerpt">${e(
            m.description.length > 160 ? `${m.description.slice(0, 160)}…` : m.description,
          )}</span>`
        : ''}
    </button>
  </li>`).join('')}</ul>
</section>`;

/** The offer, shown only on an empty own-result. ⚠ It NAMES the cloud, because
 *  the owner is about to send their query off this machine and a button reading
 *  "search more" would hide that. */
const renderMarketOffer = (query: string, actionAttr: string, loading: boolean): string =>
  loading
    ? '<p class="rq-hint" role="status">Asking the marketplace…</p>'
    : `<button type="button" class="rq-market-offer" ${e(actionAttr)}="${SEARCH_MARKETPLACE_ACTION}">
  Look for “${e(query)}” in the marketplace
</button>
<p class="rq-subtle">This sends your search to the Recued marketplace. Nothing else on this page leaves your server.</p>`;

export const renderUniversalSearch = (
  props: UniversalSearchProps,
  now: number = Date.now(),
): string => {
  const q = props.query.trim();
  const box = `<label class="rq-search-label" for="rq-search-input">Search everything</label>
<input id="rq-search-input" class="rq-search-input" type="search" autocomplete="off"
  ${SEARCH_INPUT_ATTR} value="${e(props.query)}"
  placeholder="Search mail, calendar, files…">`;

  if (props.error !== undefined) {
    return `<div class="rq-search">${box}
<p class="rq-error" role="alert">${e(props.error)}</p>
<button type="button" class="rq-retry" ${e(props.actionAttr)}="${SEARCH_RETRY_ACTION}">Try again</button>
</div>`;
  }
  if (q === '') {
    return `<div class="rq-search">${box}
<p class="rq-hint">Type to search across everything on this server.</p></div>`;
  }
  if (props.loading === true) {
    return `<div class="rq-search">${box}
<p class="rq-hint" role="status">Searching…</p></div>`;
  }
  const groups = props.groups ?? [];
  const recipes = props.recipes ?? [];
  const packs = props.packs ?? [];
  const market = props.marketplace ?? [];
  if (groups.length === 0 && recipes.length === 0 && packs.length === 0) {
    // ⛔ NAMES THE SCOPE IT SEARCHED. "No results" alone cannot be told apart
    // from "the search did not run", and an owner reading the shorter sentence
    // concludes their data is not there when it may simply not be synced.
    return `<div class="rq-search">${box}
<p class="rq-empty">Nothing on this server matches “${e(q)}”. Sources still syncing will not appear yet.</p>
${props.marketplaceError !== undefined
  ? `<p class="rq-error" role="alert">${e(props.marketplaceError)}</p>`
  : ''}
${market.length > 0 ? renderMarketGroup(market, props.actionAttr) : ''}
${market.length === 0 && props.marketplaceOffered === true
  ? renderMarketOffer(q, props.actionAttr, props.marketplaceLoading === true)
  : ''}</div>`;
  }
  const total = groups.reduce((n, g) => n + g.matches.length, 0);
  const places = groups.length + (recipes.length > 0 ? 1 : 0) + (packs.length > 0 ? 1 : 0);
  return `<div class="rq-search">${box}
<p class="rq-summary" role="status">${total + recipes.length + packs.length}${groups.some((g) => g.more) ? '+' : ''} in ${places} ${places === 1 ? 'place' : 'places'}</p>
${groups.map((g) => renderGroup(g, props.actionAttr, now)).join('')}
${packs.length > 0 ? renderPackGroup(packs, props.actionAttr) : ''}
${recipes.length > 0 ? renderRecipeGroup(recipes, props.actionAttr) : ''}
</div>`;
};

export const UNIVERSAL_SEARCH_STYLES = `
.rq-search { display: flex; flex-direction: column; gap: 0.75rem; }
.rq-search-label { font-size: 0.8rem; opacity: 0.75; }
.rq-search-input { padding: 0.5rem 0.65rem; font: inherit; width: 100%; box-sizing: border-box; }
.rq-hint, .rq-empty { opacity: 0.75; margin: 0.25rem 0; }
.rq-summary { font-size: 0.85rem; opacity: 0.75; margin: 0; }
.rq-group { display: flex; flex-direction: column; gap: 0.35rem; }
.rq-group-head { display: flex; align-items: baseline; gap: 0.5rem; font-size: 0.9rem; margin: 0.5rem 0 0; }
.rq-group-platform { font-size: 0.75rem; opacity: 0.6; }
.rq-group-count { margin-left: auto; font-variant-numeric: tabular-nums; opacity: 0.7; }
.rq-rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.25rem; }
.rq-row-btn { display: grid; gap: 0.15rem; width: 100%; text-align: left; padding: 0.5rem; font: inherit; cursor: pointer; }
.rq-row-title { font-weight: 600; }
.rq-row-when { font-size: 0.75rem; opacity: 0.6; }
.rq-row-excerpt { font-size: 0.85rem; opacity: 0.8; }
.rq-badge { font-size: 0.7rem; padding: 0.05rem 0.35rem; border-radius: 0.6rem; opacity: 0.85; }
.rq-badge-partial { outline: 1px solid currentColor; }
.rq-badge-thread { outline: 1px dashed currentColor; }
.rq-badge-trunc, .rq-badge-stale { outline: 1px dotted currentColor; }
.rq-badge-market { outline: 1px solid currentColor; }
.rq-market-offer { align-self: flex-start; font: inherit; padding: 0.4rem 0.6rem; cursor: pointer; }
.rq-subtle { font-size: 0.75rem; opacity: 0.65; margin: 0.15rem 0 0; }
.rq-more { align-self: flex-start; font: inherit; padding: 0.25rem 0.5rem; cursor: pointer; }
`;
