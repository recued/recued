/** Universal search over locally available work, collections and installed
 *  capabilities. Work is grouped by kind, collections by source.
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

import type {
  CollectionSearchDidYouMean,
  CollectionSearchGroup,
  CollectionSearchMatch,
  WorkEntitySearchGroup,
  WorkEntitySearchKind,
} from '@recued/contracts';

/** Click-dispatch contract with the route's `onClick`. */
export const SEARCH_OPEN_RECORD_ACTION = 'universal-search-open-record';
export const SEARCH_OPEN_GROUP_ACTION = 'universal-search-open-group';
export const SEARCH_RETRY_ACTION = 'universal-search-retry';
export const SEARCH_RECORD_ID_ATTR = 'data-search-record';
export const SEARCH_GROUP_SLUG_ATTR = 'data-search-slug';
export const SEARCH_GROUP_PLATFORM_ATTR = 'data-search-platform';
export const SEARCH_INPUT_ATTR = 'data-recued-universal-search-input';
export const SEARCH_OPEN_WORK_ACTION = 'universal-search-open-work';
export const SEARCH_MORE_WORK_ACTION = 'universal-search-more-work';
export const SEARCH_WORK_KIND_ATTR = 'data-search-work-kind';
export const SEARCH_WORK_ID_ATTR = 'data-search-work-id';
export const SEARCH_OPEN_RECIPE_ACTION = 'universal-search-open-recipe';
export const SEARCH_RECIPE_ID_ATTR = 'data-search-recipe';
export const SEARCH_OPEN_PACK_ACTION = 'universal-search-open-pack';
export const SEARCH_PACK_SLUG_ATTR = 'data-search-pack';
export const SEARCH_MARKETPLACE_ACTION = 'universal-search-marketplace';
export const SEARCH_OPEN_MARKET_PACK_ACTION = 'universal-search-open-market-pack';
export const SEARCH_DID_YOU_MEAN_ACTION = 'universal-search-did-you-mean';
/** The corrected query the "did you mean" button runs. */
export const SEARCH_DID_YOU_MEAN_QUERY_ATTR = 'data-search-did-you-mean';

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
  /** Installed recipes and packs are independent of the record search. */
  capabilitiesLoading?: boolean;
  capabilitiesError?: string;
  /** `collection.searchAll` groups, server-ordered by hit count. */
  groups?: ReadonlyArray<CollectionSearchGroup>;
  workGroups?: ReadonlyArray<WorkEntitySearchGroup>;
  workLoading?: boolean;
  workLoadingKinds?: ReadonlySet<WorkEntitySearchKind>;
  workError?: string;
  /** The server's "did you mean": the query with each word NO store holds
   *  replaced by the closest word one does. Offered, never applied — the
   *  groups answer what was typed. */
  didYouMean?: CollectionSearchDidYouMean;
  /** The typed words no searched store holds. The stores dropped them and
   *  answered with the rest, so the groups match only the other words. */
  absentWords?: ReadonlyArray<string>;
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
  const badges = rowBadges(m);
  return `<li class="rq-row">
  <button type="button" class="rq-row-btn"
    ${e(actionAttr)}="${SEARCH_OPEN_RECORD_ACTION}"
    ${SEARCH_RECORD_ID_ATTR}="${e(m.record_id)}"
    ${SEARCH_GROUP_SLUG_ATTR}="${e(g.slug)}"
    ${SEARCH_GROUP_PLATFORM_ATTR}="${e(g.platform)}">
    <span class="rq-row-title">${e(rowTitle(m))}</span>
    ${ts ? `<span class="rq-row-when">${e(ts)}</span>` : ''}
    ${ex ? `<span class="rq-row-excerpt">${e(ex)}</span>` : ''}
    ${badges ? `<span class="rq-row-badges">${badges}</span>` : ''}
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

const WORK_LABELS: Record<WorkEntitySearchKind, string> = {
  task: 'Tasks', note: 'Notes', project: 'Projects', commitment: 'Commitments',
};
const renderWorkGroup = (group: WorkEntitySearchGroup, actionAttr: string, loading: boolean): string => `
<section class="rq-group rq-work-group" data-work-search-group="${e(group.kind)}">
  <h3 class="rq-group-head"><span class="rq-group-name">${WORK_LABELS[group.kind]}</span>
    <span class="rq-group-count">${group.error && group.matches.length === 0 ? 'Unavailable' : `${group.matches.length}${group.more ? '+' : ''}`}</span></h3>
  ${group.error ? `<p class="rq-error" role="alert">${e(group.error)}</p>` : ''}
  <ul class="rq-rows">${group.matches.map(match => `<li class="rq-row">
    <button type="button" class="rq-row-btn" ${e(actionAttr)}="${SEARCH_OPEN_WORK_ACTION}"
      ${SEARCH_WORK_KIND_ATTR}="${e(group.kind)}" ${SEARCH_WORK_ID_ATTR}="${e(match.id)}">
      <span class="rq-row-title">${e(match.title)}</span>
      <span class="rq-row-when">${e(match.source_label)} · Updated ${e(new Date(match.updated_at).toLocaleDateString())}</span>
      ${match.excerpt ? `<span class="rq-row-excerpt">${e(match.excerpt)}</span>` : ''}
      ${match.stale || match.source_incomplete || match.pending_write ? `<span class="rq-row-badges">
        ${match.stale ? '<span class="rq-badge rq-badge-stale">may be out of date</span>' : ''}
        ${match.source_incomplete ? '<span class="rq-badge rq-badge-stale">source partly synced</span>' : ''}
        ${match.pending_write ? '<span class="rq-badge rq-badge-stale">waiting for source confirmation</span>' : ''}
      </span>` : ''}
    </button></li>`).join('')}</ul>
  ${group.more || group.error || loading ? `<button type="button" class="rq-more" ${e(actionAttr)}="${SEARCH_MORE_WORK_ACTION}"
    ${SEARCH_WORK_KIND_ATTR}="${e(group.kind)}"${loading ? ' aria-disabled="true" aria-busy="true"' : ''}>
    ${loading ? 'Loading…' : group.error ? `Try ${WORK_LABELS[group.kind]} again` : `More ${WORK_LABELS[group.kind].toLowerCase()}`}</button>` : ''}
</section>`;

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

/** Google's "Did you mean", built from the owner's own words.
 *
 *  ⚠ A BUTTON THAT RUNS THE CORRECTED SEARCH, not a silent swap of the results:
 *  what is on the page answers what was typed, and a search that quietly
 *  answered a different question would be the same lie as an unlabelled
 *  partial match. Corrected words are bold, the rest is as typed.
 *
 *  ⛔ MARK, THEN ESCAPE. Bolding the escaped string would let a corrected word
 *  match inside an entity (`amp` in `&amp;`) and break the markup; the marks
 *  are placed on the raw text and survive escaping untouched. */
const renderDidYouMean = (d: CollectionSearchDidYouMean, actionAttr: string): string => {
  let marked = d.query;
  for (const c of d.corrections) {
    const word = c.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    marked = marked.replace(
      new RegExp(`(?<![\\p{L}\\p{N}\\p{M}])${word}(?![\\p{L}\\p{N}\\p{M}])`, 'gu'),
      (w) => `\u0001${w}\u0002`,
    );
  }
  const shown = e(marked).replace(/\u0001/g, '<strong>').replace(/\u0002/g, '</strong>');
  return `<p class="rq-did-you-mean">Did you mean
  <button type="button" class="rq-did-you-mean-btn"
    ${e(actionAttr)}="${SEARCH_DID_YOU_MEAN_ACTION}"
    ${SEARCH_DID_YOU_MEAN_QUERY_ATTR}="${e(d.query)}">${shown}</button>?</p>`;
};

/** “A”, “A” or “B”, “A”, “B” or “C” — escaped. */
const quotedWords = (words: ReadonlyArray<string>): string => {
  const q = words.map((w) => `“${e(w)}”`);
  return q.length < 2 ? (q[0] ?? '') : `${q.slice(0, -1).join(', ')} or ${q.at(-1)}`;
};

/** ⛔⛔ SAYS THE QUERY WAS NOT SEARCHED AS TYPED. A store that misses drops the
 *  word no record holds and answers with the rest, so "Castelanos invoice"
 *  listed every invoice, the Car Lease one first, under the owner's own words.
 *  Without this line those rows read as answers about Castelanos. Only beside
 *  record groups: the empty page already says nothing matched, and installed
 *  recipes and packs are matched by a different rule. */
const renderAbsentWords = (words: ReadonlyArray<string>): string =>
  `<p class="rq-absent" role="status">No searched mail, calendar or file record holds ${quotedWords(words)}, so those collection results match only your other words.</p>`;

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
<input id="rq-search-input" class="rq-search-input" type="search" autocomplete="off" aria-describedby="rq-search-scope"
  ${SEARCH_INPUT_ATTR} value="${e(props.query)}"
  placeholder="Search your saved data…">
<p id="rq-search-scope" class="rq-subtle">Tasks, notes, projects, commitments, mail, calendar, files, installed recipes and packs.</p>`;
  if (q === '') {
    return `<div class="rq-search">${box}
<p class="rq-hint">Type to search saved data on this server.</p></div>`;
  }
  const groups = props.groups ?? [];
  const workGroups = props.workGroups ?? [];
  const visibleWork = workGroups.filter(group => group.matches.length > 0 || group.error);
  const workCount = workGroups.reduce((count, group) => count + group.matches.length, 0);
  const recipes = props.recipes ?? [];
  const packs = props.packs ?? [];
  const market = props.marketplace ?? [];
  const pending = props.loading === true
    ? props.capabilitiesLoading === true ? 'Searching…' : 'Searching records…'
    : props.capabilitiesLoading === true ? 'Searching installed recipes and packs…' : '';
  const progress = pending || props.workLoading ? `<p class="rq-hint" role="status">${pending || 'Searching tasks, notes, projects and commitments…'}</p>` : '';
  const failed = props.error !== undefined || props.workError !== undefined
    || props.capabilitiesError !== undefined || workGroups.some(group => group.error);
  const searchErrors = [props.error ? `Mail, calendar and files: ${props.error}` : undefined,
    props.workError, props.capabilitiesError].filter((error): error is string => error !== undefined);
  const errors = searchErrors.map(error => `<p class="rq-error" role="alert">${e(error)}</p>`).join('')
    + (searchErrors.length > 0 ? `<button type="button" class="rq-retry" ${e(props.actionAttr)}="${SEARCH_RETRY_ACTION}">Try again</button>` : '');
  const didYouMean = props.didYouMean !== undefined
    && workCount === 0 ? renderDidYouMean(props.didYouMean, props.actionAttr)
    : '';
  if (groups.length === 0 && workCount === 0 && recipes.length === 0 && packs.length === 0) {
    // An unfinished local read cannot establish an empty result or justify
    // offering a cloud search. Completed groups remain usable while it runs.
    if (progress || failed) return `<div class="rq-search">${box}${errors}${didYouMean}${progress}
      ${visibleWork.map(group => renderWorkGroup(group, props.actionAttr, props.workLoadingKinds?.has(group.kind) === true)).join('')}</div>`;
    // ⛔ NAMES THE SCOPE IT SEARCHED. "No results" alone cannot be told apart
    // from "the search did not run", and an owner reading the shorter sentence
    // concludes their data is not there when it may simply not be synced.
    return `<div class="rq-search">${box}
${didYouMean}
<p class="rq-empty">No matches in the searched sources for “${e(q)}”. Sources still syncing will not appear yet.</p>
${props.marketplaceError !== undefined
  ? `<p class="rq-error" role="alert">${e(props.marketplaceError)}</p>`
  : ''}
${market.length > 0 ? renderMarketGroup(market, props.actionAttr) : ''}
${market.length === 0 && props.marketplaceOffered === true
  ? renderMarketOffer(q, props.actionAttr, props.marketplaceLoading === true)
  : ''}</div>`;
  }
  const total = groups.reduce((n, g) => n + g.matches.length, 0);
  const places = groups.length + workGroups.filter(group => group.matches.length > 0).length
    + (recipes.length > 0 ? 1 : 0) + (packs.length > 0 ? 1 : 0);
  const absent = groups.length > 0 && props.absentWords !== undefined && props.absentWords.length > 0
    ? renderAbsentWords(props.absentWords)
    : '';
  return `<div class="rq-search">${box}
${errors}
${absent}
${didYouMean}
<p class="rq-summary" role="status">${total + workCount + recipes.length + packs.length}${groups.some((g) => g.more) || workGroups.some(group => group.more) ? '+' : ''} in ${places} ${places === 1 ? 'place' : 'places'}</p>
${progress}
${visibleWork.map(group => renderWorkGroup(group, props.actionAttr, props.workLoadingKinds?.has(group.kind) === true)).join('')}
${groups.map((g) => renderGroup(g, props.actionAttr, now)).join('')}
${packs.length > 0 ? renderPackGroup(packs, props.actionAttr) : ''}
${recipes.length > 0 ? renderRecipeGroup(recipes, props.actionAttr) : ''}
</div>`;
};

export const UNIVERSAL_SEARCH_STYLES = `
.rq-search { display: flex; flex-direction: column; gap: 0.75rem; }
.rq-search-label { font-size: 0.875rem; font-weight: 600; }
.rq-search-input { padding: 0.625rem 0.75rem; font: inherit; width: 100%; box-sizing: border-box;
  border: 1px solid var(--border-strong); border-radius: 0.5rem; background: var(--surface); color: var(--fg); }
.rq-hint, .rq-empty { color: var(--fg-muted); margin: 0.25rem 0; }
.rq-summary { font-size: 0.85rem; color: var(--fg-muted); margin: 0; }
.rq-group { display: flex; flex-direction: column; gap: 0.5rem; min-width: 0; }
.rq-group-head { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; font-size: 0.9rem; margin: 0.75rem 0 0; }
.rq-group-name { overflow-wrap: anywhere; min-width: 0; }
.rq-group-platform { font-size: 0.75rem; color: var(--fg-muted); }
.rq-group-count { margin-left: auto; padding: 0.125rem 0.5rem; border-radius: 1rem; background: var(--surface-sunk);
  color: var(--fg-muted); font-size: 0.75rem; font-weight: 500; font-variant-numeric: tabular-nums; }
.rq-rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
.rq-row-btn { display: grid; gap: 0.3rem; width: 100%; min-height: 44px; box-sizing: border-box; text-align: left;
  padding: 0.75rem; font: inherit; cursor: pointer; border: 1px solid var(--border); border-radius: 0.5rem;
  background: var(--surface); color: var(--fg); }
.rq-row-btn:hover { background: var(--surface-sunk); border-color: var(--border-strong); }
.rq-row-title, .rq-row-excerpt, .rq-row-when { min-width: 0; overflow-wrap: anywhere; }
.rq-row-title { font-weight: 600; line-height: 1.4; }
.rq-row-when { font-size: 0.75rem; color: var(--fg-muted); }
.rq-row-excerpt { font-size: 0.85rem; line-height: 1.5; color: var(--fg-muted); }
.rq-row-badges { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-top: 0.15rem; }
.rq-badge { justify-self: start; width: fit-content; font-size: 0.7rem; padding: 0.125rem 0.4rem;
  border-radius: 0.6rem; color: var(--fg-muted); }
.rq-badge-partial { outline: 1px solid currentColor; }
.rq-badge-thread { outline: 1px dashed currentColor; }
.rq-badge-trunc, .rq-badge-stale { outline: 1px dotted currentColor; }
.rq-badge-market { outline: 1px solid currentColor; }
.rq-market-offer, .rq-more, .rq-retry { align-self: flex-start; min-height: 44px; font: inherit;
  padding: 0.5rem 0.75rem; cursor: pointer; border: 1px solid var(--border); border-radius: 0.5rem;
  background: var(--surface); color: var(--fg); }
.rq-market-offer:hover, .rq-more:hover, .rq-retry:hover { background: var(--surface-sunk); }
.rq-more[aria-disabled="true"] { cursor: progress; color: var(--fg-muted); }
.rq-search button:focus-visible, .rq-search-input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.rq-subtle { font-size: 0.75rem; line-height: 1.5; color: var(--fg-muted); margin: 0; }
.rq-error { margin: 0.25rem 0; font-size: 0.875rem; }
.rq-did-you-mean { margin: 0.25rem 0; }
.rq-absent { margin: 0.25rem 0; }
.rq-did-you-mean-btn { font: inherit; color: inherit; background: none; border: 0; padding: 0;
  text-decoration: underline; cursor: pointer; }
`;
