/** Universal search over saved contacts, work, collections and installed
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

import { EXACT_LINK_OPEN_ACTION, EXACT_LINK_RETRY_ACTION, EXACT_LINK_KEY_ATTR, exactRecordNoun, type ExactRecordLinkState } from './exact-record-link.js';

import type {
  CollectionSearchDidYouMean,
  ContactRecord,
  CollectionSearchGroup,
  CollectionSearchMatch,
  WorkEntitySearchGroup,
  WorkEntitySearchKind,
  UniversalSearchResultType,
  ReminderSearchStatus,
} from '@recued/contracts';
import { filterUniversalSearch, renderSearchTypeFilter, searchTypeCounts, SEARCH_TYPE_LABELS } from './universal-search-filter.js';

import type { AssetSearchState } from './asset-search.js';
import type { ChatSearchState } from './chat-search.js';
import type { ReminderSearchState } from '../reminders/reminder-search.js';
import type { PromptSearchState } from '../automation/prompt-search.js';
import { renderPromptSearch } from '../automation/prompt-search-view.js';
import { renderDecisionSearch } from '../approvals/decision-search-view.js';
import type { PendingDecisionSearchState } from '../approvals/pending-decision-search.js';
import { renderReminderSearch, type ReminderSearchTriageView } from '../reminders/reminder-search-view.js';
import { serializeChatAnswerAddress } from '../shell/route.js';
import { mailDraftRecipients, type MailDraftSearchState } from '../mail/mail-draft-search.js';
import { mailRecoveryStatusText } from '../mail/compose-recovery.js';
import { recoveryDraftLabel, SEARCH_OPEN_RECOVERY_DRAFT, SEARCH_REFRESH_RECOVERY_DRAFTS, SEARCH_RECOVERY_DRAFT_KEY, SEARCH_RECOVERY_DRAFT_TOKEN, type RecoveryDraftSearchState } from './recovery-draft-search.js';
import { formatClientDateTime } from '@recued/ui-shared';
import { renderDocumentContentSearch, type DocumentSearchState } from './document-content-search.js';
import { ASSET_STATUS_WORDS } from '../yours/asset-status.js';
import { renderSearchExcerpt, renderSearchHighlights } from './search-excerpt.js';

/** Click-dispatch contract with the route's `onClick`. */
export const SEARCH_OPEN_RECORD_ACTION = 'universal-search-open-record';
export const SEARCH_OPEN_GROUP_ACTION = 'universal-search-open-group';
export const SEARCH_RETRY_ACTION = 'universal-search-retry';
export const SEARCH_RECORD_ID_ATTR = 'data-search-record';
export const SEARCH_GROUP_SLUG_ATTR = 'data-search-slug';
export const SEARCH_GROUP_PLATFORM_ATTR = 'data-search-platform';
export const SEARCH_INPUT_ATTR = 'data-recued-universal-search-input';
export const SEARCH_RECENT_RUN_ACTION = 'universal-search-recent-run';
export const SEARCH_RECENT_REMOVE_ACTION = 'universal-search-recent-remove';
export const SEARCH_RECENT_CLEAR_ACTION = 'universal-search-recent-clear';
export const SEARCH_RECENT_QUERY_ATTR = 'data-search-recent-query';
export const SEARCH_RECENT_FOCUS_ATTR = 'data-search-recent-focus';
export const SEARCH_OPEN_WORK_ACTION = 'universal-search-open-work';
export const SEARCH_MORE_WORK_ACTION = 'universal-search-more-work';
export const SEARCH_WORK_KIND_ATTR = 'data-search-work-kind';
export const SEARCH_WORK_ID_ATTR = 'data-search-work-id';
export const SEARCH_OPEN_ASSET_ACTION = 'universal-search-open-asset';
export const SEARCH_MORE_ASSETS_ACTION = 'universal-search-more-assets';
export const SEARCH_ASSET_ID_ATTR = 'data-search-asset-id';
export const SEARCH_OPEN_DRAFT_ACTION = 'universal-search-open-draft';
export const SEARCH_MORE_DRAFTS_ACTION = 'universal-search-more-drafts';
export const SEARCH_DRAFT_ID_ATTR = 'data-search-draft-id';
export const SEARCH_OPEN_CHAT_ACTION = 'universal-search-open-chat';
export const SEARCH_MORE_CHATS_ACTION = 'universal-search-more-chats';
export const SEARCH_CHAT_SESSION_ATTR = 'data-search-chat-session';
export const SEARCH_CHAT_MESSAGE_ATTR = 'data-search-chat-message';
export const SEARCH_OPEN_CONTACT_ACTION = 'universal-search-open-contact';
export const SEARCH_MORE_CONTACTS_ACTION = 'universal-search-more-contacts';
export const SEARCH_CONTACT_EMAIL_ATTR = 'data-search-contact-email';
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

export interface UniversalContactSearch {
  contacts: readonly ContactRecord[];
  total: number;
  loading: boolean;
  more: boolean;
  error?: string;
  unsupported?: boolean;
}

export interface UniversalSearchProps {
  exactLink?: ExactRecordLinkState;
  exactLinkOpening?: boolean;
  exactLinkError?: string;
  documentSearch?: DocumentSearchState;
  /** What the owner typed. */
  query: string;
  resultType?: UniversalSearchResultType;
  debouncing?: boolean;
  recordSearchAvailable?: boolean;
  workSearchAvailable?: boolean;
  recentSearches?: readonly string[];
  recentSearchNotice?: { error: boolean; text: string };
  recentWorkHtml?: string;
  /** In flight — a query is running. */
  loading?: boolean;
  /** Installed recipes and packs are independent of the record search. */
  capabilitiesLoading?: boolean;
  capabilitiesError?: string;
  /** `collection.searchAll` groups, server-ordered by hit count. */
  groups?: ReadonlyArray<CollectionSearchGroup>;
  workGroups?: ReadonlyArray<WorkEntitySearchGroup>;
  contactSearch?: UniversalContactSearch;
  assetSearch?: AssetSearchState;
  draftSearch?: MailDraftSearchState;
  recoveryDraftSearch?: RecoveryDraftSearchState;
  recoveryDraftOpening?: string;
  recoveryDraftError?: string;
  chatSearch?: ChatSearchState;
  reminderSearch?: ReminderSearchState;
  reminderStatus?: ReminderSearchStatus;
  reminderDatesHtml?: string;
  reminderTriage?: ReminderSearchTriageView;
  searchWriting?: boolean;
  promptSearch?: PromptSearchState;
  decisionSearch?: PendingDecisionSearchState;
  decisionOpening?: string;
  decisionOpenError?: string;
  promptOpening?: string;
  promptOpenError?: string;
  draftOpeningId?: string;
  draftOpenError?: string;
  workLoading?: boolean;
  workLoadingKinds?: ReadonlySet<WorkEntitySearchKind>;
  workError?: string;
  /** The server cannot search tasks, notes, projects, commitments and bookings: one before 26.10.28
   *  answers `work_entity.search` with `unknown_method`. Not a failure, since a retry cannot
   *  help: the rest completes the search, and the box says what it searched. */
  workUnsupported?: boolean;
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
  query: string,
): string => {
  const ex = typeof m.body === 'string'
    ? renderSearchExcerpt(m.body, m.thread_context ? '' : query, m.body_truncated)
    : '';
  // An event's `received_at` is when the warehouse first stored it, not its date, and an age from it would read
  // as one ("today" on an event next month). Calendar rows carried none until 2026-11-20 (it is the identity
  // "Add records" checks) and still show none.
  const ts = g.platform === 'calendar' ? '' : when(m, now);
  const badges = rowBadges(m);
  return `<li class="rq-row">
  <button type="button" class="rq-row-btn"
    ${e(actionAttr)}="${SEARCH_OPEN_RECORD_ACTION}"
    ${SEARCH_RECORD_ID_ATTR}="${e(m.record_id)}"
    ${SEARCH_GROUP_SLUG_ATTR}="${e(g.slug)}"
    ${SEARCH_GROUP_PLATFORM_ATTR}="${e(g.platform)}">
    <span class="rq-row-title">${e(rowTitle(m))}</span>
    ${ts ? `<span class="rq-row-when">${e(ts)}</span>` : ''}
    ${ex ? `<span class="rq-row-excerpt">${ex}</span>` : ''}
    ${badges ? `<span class="rq-row-badges">${badges}</span>` : ''}
  </button>
</li>`;
};

const renderGroup = (g: CollectionSearchGroup, actionAttr: string, now: number, query: string): string => {
  const stale = g.source_freshness?.stale === true;
  return `<section class="rq-group">
  <h3 class="rq-group-head">
    <span class="rq-group-name">${e(g.slug)}</span>
    <span class="rq-group-platform">${e(g.platform)}</span>
    <span class="rq-group-count">${g.matches.length}${g.more ? '+' : ''}</span>
    ${stale ? '<span class="rq-badge rq-badge-stale" title="This source has not synced recently — there may be newer records">may be out of date</span>' : ''}
  </h3>
  <ul class="rq-rows">${g.matches.map((m) => renderRow(m, g, actionAttr, now, query)).join('')}</ul>
  ${g.more ? `<button type="button" class="rq-more"
      ${e(actionAttr)}="${SEARCH_OPEN_GROUP_ACTION}"
      ${SEARCH_GROUP_SLUG_ATTR}="${e(g.slug)}"
      ${SEARCH_GROUP_PLATFORM_ATTR}="${e(g.platform)}">More in ${e(g.slug)}</button>` : ''}
</section>`;
};

const renderChatGroup = (props: UniversalSearchProps): string => {
  const search = props.chatSearch;
  if (!search || !search.loading && !search.error && !search.unsupported && !search.matches.length && !search.next_cursor && !search.incomplete) return '';
  return `<section class="rq-group rq-chat-group" aria-label="Chat message search results" aria-busy="${search.loading}">
    <h3 class="rq-group-head"><span class="rq-group-name">Chat messages</span><span class="rq-group-count" role="status">${search.unsupported ? 'Update required' : search.loading && !search.matches.length ? 'Searching' : search.error && !search.matches.length ? 'Unavailable' : `${search.matches.length}${search.next_cursor || search.incomplete ? '+' : ''}`}</span></h3>
    ${search.unsupported ? '<p class="rq-subtle">Update your Recued server to search chat messages here.</p>' : ''}
    ${search.error ? `<p class="rq-error" role="alert">${e(search.error)}</p>` : ''}
    ${search.loading ? '<p class="rq-hint" role="status">Searching chat messages…</p>' : ''}
    ${search.incomplete ? '<p class="rq-subtle" role="status">Some saved chat messages couldn’t be read. Results may be incomplete.</p>' : ''}
    ${search.next_cursor && !search.matches.length && !search.loading && !search.error ? '<p class="rq-subtle">No matches in the messages searched so far. Older messages remain to search.</p>' : ''}
    <ul class="rq-rows">${search.matches.map(match => `<li class="rq-row"><a class="rq-row-btn" href="${e(serializeChatAnswerAddress({ sessionId: match.session_id, messageId: match.message_id }))}"
      ${e(props.actionAttr)}="${SEARCH_OPEN_CHAT_ACTION}" ${SEARCH_CHAT_SESSION_ATTR}="${e(match.session_id)}" ${SEARCH_CHAT_MESSAGE_ATTR}="${e(match.message_id)}">
      <span class="rq-row-title">${renderSearchHighlights(match.title || 'Untitled chat', props.query)}</span>
      <span class="rq-row-when">${match.role === 'user' ? 'You' : 'Assistant'} · ${e(formatClientDateTime(match.ts, { includeSeconds: false }))}</span>
      <span class="rq-row-excerpt">${renderSearchHighlights(match.snippet, props.query)}</span>
    </a></li>`).join('')}</ul>
    ${!search.unsupported && (search.next_cursor || search.error || search.incomplete) ? `<button type="button" class="rq-more" ${e(props.actionAttr)}="${SEARCH_MORE_CHATS_ACTION}"${search.loading ? ' aria-disabled="true"' : ''}>${search.error || !search.next_cursor ? 'Retry chat messages' : 'More chat messages'}</button>` : ''}
  </section>`;
};

const renderRecoveryDraftGroup = (props: UniversalSearchProps): string => {
  const search = props.recoveryDraftSearch;
  if (!search?.available || !search.matches.length && !search.issues.length && !search.loading && !props.recoveryDraftError && props.query.trim()) return '';
  return `<section class="rq-group rq-draft-group" aria-label="Unfinished work search results" aria-busy="${search.loading || !!props.recoveryDraftOpening}">
    <h3 class="rq-group-head"><span class="rq-group-name">Unfinished work in this tab</span><span class="rq-group-count" role="status">${search.loading ? 'Searching' : search.matches.length}</span></h3>
    <p class="rq-subtle">Recovery copies from this server and this browser tab.</p>
    ${search.issues.map(issue => `<p class="rq-error" role="alert">${e(issue)}</p>`).join('')}
    ${props.recoveryDraftError ? `<p class="rq-error" role="alert">${e(props.recoveryDraftError)}</p>` : ''}
    ${search.loading ? '<p class="rq-hint" role="status">Waiting for this search…</p>' : ''}
    <ul class="rq-rows">${search.matches.map(draft => `<li class="rq-row"><button type="button" class="rq-row-btn" ${e(props.actionAttr)}="${SEARCH_OPEN_RECOVERY_DRAFT}" ${SEARCH_RECOVERY_DRAFT_KEY}="${e(draft.key)}" ${SEARCH_RECOVERY_DRAFT_TOKEN}="${draft.token}"${props.recoveryDraftOpening ? ' aria-disabled="true"' : ''}
      aria-label="${e((draft.kind === 'mail' && draft.status !== 'editing' ? 'Review submitted ' : draft.status === 'editing' ? 'Resume ' : 'Review unconfirmed ') + recoveryDraftLabel(draft).toLowerCase() + ' draft ' + draft.title)}">
      <span class="rq-row-title">${renderSearchHighlights(draft.title, props.query)}</span>
      <span class="rq-row-when">${recoveryDraftLabel(draft)} · ${draft.editingExisting ? 'Edits' : 'New'} · Edited ${e(formatClientDateTime(draft.updatedAt, { includeSeconds: false }))}</span>
      <span class="rq-row-excerpt">${renderSearchHighlights(draft.excerpt, props.query)}</span>
      <span class="rq-row-when">${e(props.recoveryDraftOpening === draft.key ? 'Opening…' : draft.mailStatus ? mailRecoveryStatusText(draft.mailStatus) + (draft.mailStatus === 'editing' ? ' · Resume' : ' · Review') : draft.status === 'editing' ? 'Unsaved draft · Resume' : 'Save not confirmed · Review')}</span>
    </button></li>`).join('')}</ul>
    ${!search.loading && !search.matches.length && !search.issues.length && !props.query.trim() ? '<p class="rq-subtle">No unfinished recovery copies are available in this tab.</p>' : ''}
    <button type="button" class="rq-more" ${e(props.actionAttr)}="${SEARCH_REFRESH_RECOVERY_DRAFTS}"${props.recoveryDraftOpening ? ' aria-disabled="true"' : ''}>Refresh drafts</button>
  </section>`;
};

const renderDraftGroup = (props: UniversalSearchProps): string => {
  const search = props.draftSearch;
  if (!search || !search.loading && !search.error && !search.unsupported && !search.matches.length && !props.draftOpenError) return '';
  return `<section class="rq-group rq-draft-group" aria-label="Saved draft search results" aria-busy="${search.loading || !!props.draftOpeningId}">
    <h3 class="rq-group-head"><span class="rq-group-name">Saved mail drafts</span><span class="rq-group-count" role="status">${search.unsupported ? 'Update required' : search.loading ? 'Searching' : search.error && !search.matches.length ? 'Unavailable' : `${search.matches.length}${search.next_cursor ? '+' : ''}`}</span></h3>
    ${search.unsupported ? '<p class="rq-subtle">Update your Recued server to search saved mail drafts here.</p>' : ''}
    ${search.error || props.draftOpenError ? `<p class="rq-error" role="alert">${e(search.error ?? props.draftOpenError!)}</p>` : ''}
    <ul class="rq-rows">${search.matches.map(draft => `<li class="rq-row"><button type="button" class="rq-row-btn"
      ${e(props.actionAttr)}="${SEARCH_OPEN_DRAFT_ACTION}" ${SEARCH_DRAFT_ID_ATTR}="${e(draft.draft_id)}"${props.draftOpeningId ? ' aria-disabled="true"' : ''}>
      <span class="rq-row-title">${renderSearchHighlights(draft.subject || 'Untitled draft', props.query)}</span>
      <span class="rq-row-when">From ${e(draft.sender_mail_instance)} · Edited ${e(formatClientDateTime(draft.updated_at, { includeSeconds: false }))}</span>
      <span class="rq-row-excerpt">${renderSearchHighlights(mailDraftRecipients(draft), props.query)}</span>
      ${props.draftOpeningId === draft.draft_id ? '<span role="status">Opening draft…</span>' : ''}
    </button></li>`).join('')}</ul>
    ${!search.unsupported && (search.next_cursor || search.error) ? `<button type="button" class="rq-more" ${e(props.actionAttr)}="${SEARCH_MORE_DRAFTS_ACTION}"${search.loading ? ' aria-disabled="true"' : ''}>${search.error ? 'Retry drafts' : 'More drafts'}</button>` : ''}
  </section>`;
};

const renderContactGroup = (search: UniversalContactSearch | undefined, actionAttr: string): string => {
  if (!search || !search.loading && !search.error && !search.unsupported && search.contacts.length === 0) return '';
  return `<section class="rq-group rq-contact-group" aria-label="Contact search results">
    <h3 class="rq-group-head"><span class="rq-group-name">Contacts</span><span class="rq-group-count">${search.unsupported ? 'Update required' : search.loading && !search.contacts.length ? 'Searching' : search.error && !search.contacts.length ? 'Unavailable' : `${search.contacts.length} of ${search.total}`}</span></h3>
    ${search.unsupported ? '<p class="rq-subtle">Update your Recued server to search saved contacts here.</p>' : ''}
    ${search.error ? `<p class="rq-error" role="alert">${e(search.error)}</p>` : ''}
    ${search.loading ? '<p class="rq-hint" role="status">Searching contacts…</p>' : ''}
    <ul class="rq-rows">${search.contacts.map(contact => `<li class="rq-row"><button type="button" class="rq-row-btn" ${e(actionAttr)}="${SEARCH_OPEN_CONTACT_ACTION}" ${SEARCH_CONTACT_EMAIL_ATTR}="${e(contact.email)}">
      <span class="rq-row-title">${e(contact.name || contact.email)}</span>
      <span class="rq-row-excerpt">${e([contact.email, contact.phone, contact.company].filter(Boolean).join(' · '))}</span>
    </button></li>`).join('')}</ul>
    ${!search.unsupported && (search.more || search.error) ? `<button type="button" class="rq-more" ${e(actionAttr)}="${SEARCH_MORE_CONTACTS_ACTION}"${search.loading ? ' aria-disabled="true" aria-busy="true"' : ''}>${search.error ? 'Retry contacts' : 'More contacts'}</button>` : ''}
  </section>`;
};

const renderAssetGroup = (search: AssetSearchState | undefined, actionAttr: string): string => {
  if (!search || !search.loading && !search.error && !search.unsupported && search.matches.length === 0) return '';
  return `<section class="rq-group rq-asset-group" aria-label="Asset search results">
    <h3 class="rq-group-head"><span class="rq-group-name">Assets</span><span class="rq-group-count" role="status">${search.unsupported ? 'Update required' : search.loading && !search.matches.length ? 'Searching' : search.error && !search.matches.length ? 'Unavailable' : `${search.matches.length} of ${search.total}${search.loading ? ' · Loading…' : ''}`}</span></h3>
    ${search.unsupported ? '<p class="rq-subtle">Update your Recued server to search assets here.</p>' : ''}
    ${search.error ? `<p class="rq-error" role="alert">${e(search.error)}</p>` : ''}
    <ul class="rq-rows">${search.matches.map(asset => `<li class="rq-row"><a class="rq-row-btn" href="#yours/asset/${e(encodeURIComponent(asset.id))}"
      ${e(actionAttr)}="${SEARCH_OPEN_ASSET_ACTION}" ${SEARCH_ASSET_ID_ATTR}="${e(asset.id)}">
      <span class="rq-row-title">${e(asset.name)}</span>
      <span class="rq-row-when">${e(asset.class_name)} · ${ASSET_STATUS_WORDS[asset.status]}</span>
      ${asset.stale || asset.pending_write ? `<span class="rq-row-badges">${asset.stale ? '<span class="rq-badge rq-badge-stale">may be out of date</span>' : ''}${asset.pending_write ? '<span class="rq-badge rq-badge-stale">waiting for source confirmation</span>' : ''}</span>` : ''}
    </a></li>`).join('')}</ul>
    ${!search.unsupported && (search.more || search.error) ? `<button type="button" class="rq-more" ${e(actionAttr)}="${SEARCH_MORE_ASSETS_ACTION}"${search.loading ? ' aria-disabled="true" aria-busy="true"' : ''}>${search.loading ? 'Loading…' : search.error ? 'Retry assets' : 'More assets'}</button>` : ''}
  </section>`;
};

const WORK_LABELS: Record<WorkEntitySearchKind, string> = {
  task: 'Tasks', note: 'Notes', project: 'Projects', commitment: 'Commitments', booking: 'Bookings',
};
const renderWorkGroup = (group: WorkEntitySearchGroup, actionAttr: string, loading: boolean, query: string): string => `
<section class="rq-group rq-work-group" data-work-search-group="${e(group.kind)}">
  <h3 class="rq-group-head"><span class="rq-group-name">${WORK_LABELS[group.kind]}</span>
    <span class="rq-group-count">${group.error && group.matches.length === 0 ? 'Unavailable' : `${group.matches.length}${group.more ? '+' : ''}`}</span></h3>
  ${group.error ? `<p class="rq-error" role="alert">${e(group.error)}</p>` : ''}
  <ul class="rq-rows">${group.matches.map(match => `<li class="rq-row">
    <button type="button" class="rq-row-btn" ${e(actionAttr)}="${SEARCH_OPEN_WORK_ACTION}"
      ${SEARCH_WORK_KIND_ATTR}="${e(group.kind)}" ${SEARCH_WORK_ID_ATTR}="${e(match.id)}">
      <span class="rq-row-title">${renderSearchHighlights(match.title, query)}</span>
      <span class="rq-row-when">${e(match.source_label)} · Updated ${e(new Date(match.updated_at).toLocaleDateString())}</span>
      ${match.excerpt ? `<span class="rq-row-excerpt">${renderSearchHighlights(match.excerpt, query)}</span>` : ''}
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
  const input = `<div class="rq-query-field"><label class="rq-search-label" for="rq-search-input">Search everything</label>
<input id="rq-search-input" class="rq-search-input" type="search" autocomplete="off" aria-describedby="rq-search-scope"
  ${SEARCH_INPUT_ATTR} value="${e(props.query)}"${props.searchWriting || props.reminderTriage?.writing ? ' readonly' : ''} placeholder="Search your saved data or paste a record link…"></div>`;
  if (props.exactLink) {
    const exact = props.exactLink;
    const content = exact.state === 'ready' ? `<h3 class="rq-row-title">${e(exact.match.title)}</h3><p class="rq-subtle">${e(exact.match.details.join(' · '))}</p>
      ${exact.match.warning ? `<p role="status">${e(exact.match.warning)}</p>` : ''}
      <a class="data-button" href="${e(exact.match.href)}" ${props.actionAttr}="${EXACT_LINK_OPEN_ACTION}" ${EXACT_LINK_KEY_ATTR}="${e(exact.match.key)}"${props.exactLinkOpening ? ' aria-disabled="true" aria-busy="true"' : ''}>Open ${e(exactRecordNoun(exact.match.target))} ${e(exact.match.title)}</a>
      ${props.exactLinkOpening ? '<p role="status">Checking selected record…</p>' : ''}${props.exactLinkError ? `<p role="alert">${e(props.exactLinkError)}</p>` : ''}`
      : `<p role="status">${e(exact.state === 'loading' ? 'Checking record link…' : exact.message)}</p>${exact.state === 'error' ? `<button type="button" ${props.actionAttr}="${EXACT_LINK_RETRY_ACTION}">Try again</button>` : ''}`;
    return `<div class="rq-search">${input}<p id="rq-search-scope" class="rq-subtle">Find the saved record for this link.</p><section class="rq-group" aria-label="Record link" data-exact-record-link><h2 class="rq-group-head">Record link</h2>${content}</section></div>`;
  }
  const selectedType = props.resultType ?? 'all';
  const typeCounts = searchTypeCounts(props)[selectedType];
  const typeControls = renderSearchTypeFilter(props);
  props = filterUniversalSearch(props, selectedType);
  const typeUncertain = selectedType !== 'all' && (typeCounts.pending || typeCounts.unavailable || typeCounts.more);
  const typeFeedback = selectedType === 'all' ? '' : typeCounts.pending
    ? `<p class="rq-hint" role="status">Searching ${e(SEARCH_TYPE_LABELS[selectedType])}…</p>`
    : typeCounts.unavailable ? `<p class="rq-subtle" role="status">${e(SEARCH_TYPE_LABELS[selectedType])} results could not all be confirmed.</p>`
      : typeCounts.more && !typeCounts.loaded ? `<p class="rq-subtle">More ${e(SEARCH_TYPE_LABELS[selectedType])} results may be available.</p>` : '';
  const q = props.query.trim();
  const contactScope = props.contactSearch?.unsupported ? ' Update your Recued server to search contacts too.' : '';
  let scope = props.workUnsupported === true
    ? 'Mail, calendar, files, installed recipes and packs. Update your Recued server to search tasks, notes, projects, commitments and bookings too.'
    : 'Tasks, notes, projects, commitments, bookings, mail, calendar, files, installed recipes and packs.';
  if (props.contactSearch && !props.contactSearch.unsupported)
    scope = `Contacts, ${scope.charAt(0).toLowerCase()}${scope.slice(1)}`;
  if (props.assetSearch && !props.assetSearch.unsupported)
    scope = `Assets, ${scope.charAt(0).toLowerCase()}${scope.slice(1)}`;
  if (props.assetSearch?.unsupported) scope += ' Update your Recued server to search assets too.';
  if (props.draftSearch && !props.draftSearch.unsupported) scope = `Saved mail drafts, ${scope.charAt(0).toLowerCase()}${scope.slice(1)}`;
  if (props.recoveryDraftSearch?.available) scope = `Drafts kept in this tab, ${scope.charAt(0).toLowerCase()}${scope.slice(1)}`;
  if (props.reminderSearch && !props.reminderSearch.unsupported) scope = `Reminders, ${scope.charAt(0).toLowerCase()}${scope.slice(1)}`;
  if (props.promptSearch && !props.promptSearch.unsupported) scope = `Scheduled prompts, ${scope.charAt(0).toLowerCase()}${scope.slice(1)}`;
  if (props.decisionSearch) scope = `Pending decisions, ${scope.charAt(0).toLowerCase()}${scope.slice(1)}`;
  if (props.chatSearch && !props.chatSearch.unsupported) scope = `Chat messages, ${scope.charAt(0).toLowerCase()}${scope.slice(1)}`;
  if (selectedType !== 'all') scope = `Showing only ${SEARCH_TYPE_LABELS[selectedType]} results.`;
  const box = `<div class="rq-search-tools">${input}
${typeControls}</div><p id="rq-search-scope" class="rq-subtle"${selectedType !== 'all' ? ' role="status"' : ''}>${scope}${contactScope}${props.documentSearch ? ' Document contents are searched separately when you choose Search file contents.' : ''}</p>${renderDocumentContentSearch(props.documentSearch, props.actionAttr)}`;
  if (q === '') {
    return `<div class="rq-search">${box}
${selectedType === 'draft' ? renderRecoveryDraftGroup(props) : selectedType === 'scheduled_prompt' ? renderPromptSearch(props.promptSearch, props.actionAttr, props.promptOpening, props.promptOpenError, props.debouncing, props.searchWriting) : selectedType === 'decision' ? renderDecisionSearch(props.decisionSearch, props.actionAttr, props.decisionOpening, props.decisionOpenError, props.debouncing, props.searchWriting) : selectedType === 'reminder' ? renderReminderSearch(props.reminderSearch, props.actionAttr, props.reminderStatus, props.reminderDatesHtml, props.reminderTriage) : ''}
${props.recentWorkHtml ?? ''}
${props.recentSearches?.length ? `<section class="rq-recent" aria-labelledby="rq-recent-title">
  <div class="rq-recent-head"><h2 id="rq-recent-title">Recent searches</h2><button type="button" class="rq-recent-clear" ${props.actionAttr}="${SEARCH_RECENT_CLEAR_ACTION}" ${SEARCH_RECENT_FOCUS_ATTR}="clear">Clear history</button></div>
  <p class="rq-subtle">In this tab</p>
  <ul class="rq-recent-list">${props.recentSearches.map(query => `<li>
    <button type="button" class="rq-recent-run" ${props.actionAttr}="${SEARCH_RECENT_RUN_ACTION}" ${SEARCH_RECENT_QUERY_ATTR}="${e(query)}" ${SEARCH_RECENT_FOCUS_ATTR}="run" aria-label="${e(`Search again for ${query}`)}">${e(query)}</button>
    <button type="button" class="rq-recent-remove" ${props.actionAttr}="${SEARCH_RECENT_REMOVE_ACTION}" ${SEARCH_RECENT_QUERY_ATTR}="${e(query)}" ${SEARCH_RECENT_FOCUS_ATTR}="remove" aria-label="${e(`Remove ${query} from recent searches`)}">Remove</button>
  </li>`).join('')}</ul>
</section>` : ''}
${props.recentSearchNotice ? `<p class="${props.recentSearchNotice.error ? 'rq-error' : 'rq-subtle'}" role="${props.recentSearchNotice.error ? 'alert' : 'status'}">${e(props.recentSearchNotice.text)}</p>` : ''}
<p class="rq-hint">${props.recentSearches?.length ? 'Choose a recent search or type to search saved data on this server.' : 'Type to search saved data on this server.'}</p></div>`;
  }
  const groups = props.groups ?? [];
  const documentCount = props.documentSearch?.matches.length ?? 0;
  const documentActive = props.documentSearch && props.documentSearch.phase !== 'idle';
  const documentUncertain = documentActive && (props.documentSearch?.phase !== 'ready' || props.documentSearch.result?.partial);
  const workGroups = props.workGroups ?? [];
  const visibleWork = workGroups.filter(group => group.matches.length > 0 || group.error);
  const workCount = workGroups.reduce((count, group) => count + group.matches.length, 0);
  const promptCount = props.promptSearch?.matches.length ?? 0;
  const decisionCount = props.decisionSearch?.matches.length ?? 0;
  const decisionGroup = renderDecisionSearch(props.decisionSearch, props.actionAttr, props.decisionOpening, props.decisionOpenError, props.debouncing, props.searchWriting);
  const decisionsUncertain = props.decisionSearch && (!props.decisionSearch.loaded || props.decisionSearch.loading || props.decisionSearch.incomplete) || props.decisionOpenError;
  const promptGroup = renderPromptSearch(props.promptSearch, props.actionAttr, props.promptOpening, props.promptOpenError, props.debouncing, props.searchWriting);
  const promptsUncertain = props.promptSearch?.loading || props.promptSearch?.error || props.promptSearch?.unsupported || props.promptOpenError;
  const reminderCount = props.reminderSearch?.matches.length ?? 0;
  const reminderGroup = renderReminderSearch(props.reminderSearch, props.actionAttr, props.reminderStatus, props.reminderDatesHtml, props.reminderTriage);
  const remindersUncertain = props.reminderSearch?.loading || props.reminderSearch?.error || props.reminderSearch?.unsupported || props.reminderSearch?.next_cursor;
  const chatCount = props.chatSearch?.matches.length ?? 0;
  const chatGroup = renderChatGroup(props);
  const chatsUncertain = props.chatSearch?.loading || props.chatSearch?.error || props.chatSearch?.unsupported || props.chatSearch?.incomplete || props.chatSearch?.next_cursor;
  const draftCount = (props.draftSearch?.matches.length ?? 0) + (props.recoveryDraftSearch?.matches.length ?? 0);
  const draftGroup = renderDraftGroup(props) + renderRecoveryDraftGroup(props);
  const draftsUncertain = props.draftSearch?.loading || props.draftSearch?.error || props.draftSearch?.unsupported
    || props.recoveryDraftSearch?.loading || props.recoveryDraftSearch?.issues.length || props.recoveryDraftError;
  const assetCount = props.assetSearch?.matches.length ?? 0;
  const assetGroup = renderAssetGroup(props.assetSearch, props.actionAttr);
  const assetsUncertain = props.assetSearch?.loading || props.assetSearch?.error || props.assetSearch?.unsupported;
  const contactCount = props.contactSearch?.contacts.length ?? 0;
  const contactGroup = renderContactGroup(props.contactSearch, props.actionAttr);
  const recipes = props.recipes ?? [];
  const packs = props.packs ?? [];
  const market = props.marketplace ?? [];
  const pending = props.loading === true
    ? props.capabilitiesLoading === true ? 'Searching…' : 'Searching records…'
    : props.capabilitiesLoading === true ? 'Searching installed recipes and packs…' : '';
  const progress = pending || props.workLoading || props.contactSearch?.loading ? `<p class="rq-hint" role="status">${pending || (props.workLoading ? 'Searching tasks, notes, projects, commitments and bookings…' : 'Searching contacts…')}</p>` : '';
  const failed = props.error !== undefined || props.workError !== undefined
    || props.capabilitiesError !== undefined || props.contactSearch?.error !== undefined || props.assetSearch?.error !== undefined || props.draftSearch?.error !== undefined || props.chatSearch?.error !== undefined || props.reminderSearch?.error !== undefined || workGroups.some(group => group.error)
    || !!props.recoveryDraftSearch?.issues.length || props.recoveryDraftError !== undefined || !!promptsUncertain || !!decisionsUncertain;
  const searchErrors = [props.error ? `Mail, calendar and files: ${props.error}` : undefined,
    props.workError, props.capabilitiesError].filter((error): error is string => error !== undefined);
  const errors = searchErrors.map(error => `<p class="rq-error" role="alert">${e(error)}</p>`).join('')
    + (searchErrors.length > 0 ? `<button type="button" class="rq-retry" ${e(props.actionAttr)}="${SEARCH_RETRY_ACTION}">Try again</button>` : '');
  const didYouMean = props.didYouMean !== undefined
    && !documentActive
    && decisionCount === 0 && !decisionsUncertain && promptCount === 0 && !promptsUncertain && reminderCount === 0 && !remindersUncertain && workCount === 0 && chatCount === 0 && !chatsUncertain && draftCount === 0 && !draftsUncertain && assetCount === 0 && !assetsUncertain && contactCount === 0 && !props.contactSearch?.loading && !props.contactSearch?.error && !props.contactSearch?.unsupported ? renderDidYouMean(props.didYouMean, props.actionAttr)
    : '';
  if (groups.length === 0 && decisionCount === 0 && promptCount === 0 && reminderCount === 0 && workCount === 0 && chatCount === 0 && draftCount === 0 && assetCount === 0 && contactCount === 0 && documentCount === 0 && recipes.length === 0 && packs.length === 0) {
    // An unfinished local read cannot establish an empty result or justify
    // offering a cloud search. Completed groups remain usable while it runs.
    if (progress || failed || typeUncertain || decisionsUncertain || promptsUncertain || remindersUncertain || props.assetSearch?.loading || props.draftSearch?.loading || props.chatSearch?.loading || props.chatSearch?.next_cursor || props.chatSearch?.incomplete || documentUncertain) return `<div class="rq-search">${box}${errors}${didYouMean}${progress}${typeFeedback}${decisionGroup}${promptGroup}${reminderGroup}${chatGroup}${draftGroup}${assetGroup}${contactGroup}
      ${visibleWork.map(group => renderWorkGroup(group, props.actionAttr, props.workLoadingKinds?.has(group.kind) === true, props.query)).join('')}</div>`;
    // ⛔ NAMES THE SCOPE IT SEARCHED. "No results" alone cannot be told apart
    // from "the search did not run", and an owner reading the shorter sentence
    // concludes their data is not there when it may simply not be synced.
    return `<div class="rq-search">${box}
${didYouMean}
${decisionGroup}${promptGroup}${reminderGroup}${chatGroup}${draftGroup}${assetGroup}
${contactGroup}
<p class="rq-empty">${selectedType === 'all' ? `No matches in the searched sources for “${e(q)}”. Sources still syncing will not appear yet.` : `No ${e(SEARCH_TYPE_LABELS[selectedType])} results loaded for “${e(q)}”.`}</p>
${props.marketplaceError !== undefined
  ? `<p class="rq-error" role="alert">${e(props.marketplaceError)}</p>`
  : ''}
${market.length > 0 ? renderMarketGroup(market, props.actionAttr) : ''}
${market.length === 0 && props.marketplaceOffered === true && !props.contactSearch?.unsupported && !decisionsUncertain && !promptsUncertain && !remindersUncertain && !assetsUncertain && !draftsUncertain && !chatsUncertain
  ? renderMarketOffer(q, props.actionAttr, props.marketplaceLoading === true)
  : ''}</div>`;
  }
  const total = groups.reduce((n, g) => n + g.matches.length, 0);
  const places = Number(decisionCount > 0) + Number(promptCount > 0) + Number(reminderCount > 0) + groups.length + workGroups.filter(group => group.matches.length > 0).length
    + (chatCount > 0 ? 1 : 0) + (props.draftSearch?.matches.length ? 1 : 0) + (props.recoveryDraftSearch?.matches.length ? 1 : 0) + (assetCount > 0 ? 1 : 0) + (contactCount > 0 ? 1 : 0) + (documentCount > 0 ? 1 : 0) + (recipes.length > 0 ? 1 : 0) + (packs.length > 0 ? 1 : 0);
  const absent = groups.length > 0 && decisionCount === 0 && !decisionsUncertain && promptCount === 0 && !promptsUncertain && reminderCount === 0 && !remindersUncertain && chatCount === 0 && !chatsUncertain && draftCount === 0 && !draftsUncertain && assetCount === 0 && !assetsUncertain && contactCount === 0 && props.absentWords !== undefined && props.absentWords.length > 0
    && !documentActive
    ? renderAbsentWords(props.absentWords)
    : '';
  return `<div class="rq-search">${box}
${errors}
${absent}
${didYouMean}
<p class="rq-summary" role="status">${total + decisionCount + promptCount + reminderCount + workCount + chatCount + draftCount + assetCount + contactCount + documentCount + recipes.length + packs.length}${groups.some((g) => g.more) || workGroups.some(group => group.more) || props.contactSearch?.more || props.assetSearch?.more || props.draftSearch?.next_cursor || props.chatSearch?.next_cursor || props.chatSearch?.incomplete || props.reminderSearch?.next_cursor || props.documentSearch?.result?.next_cursor || props.documentSearch?.result?.next_offset !== undefined ? '+' : ''} in ${places} ${places === 1 ? 'place' : 'places'}</p>
${progress}
${decisionGroup}${promptGroup}${reminderGroup}${chatGroup}${draftGroup}${assetGroup}
${contactGroup}
${visibleWork.map(group => renderWorkGroup(group, props.actionAttr, props.workLoadingKinds?.has(group.kind) === true, props.query)).join('')}
${groups.map((g) => renderGroup(g, props.actionAttr, now, q)).join('')}
${packs.length > 0 ? renderPackGroup(packs, props.actionAttr) : ''}
${recipes.length > 0 ? renderRecipeGroup(recipes, props.actionAttr) : ''}
</div>`;
};

export const UNIVERSAL_SEARCH_STYLES = `
.rq-search { display: flex; flex-direction: column; gap: 0.75rem; min-width:0; }
.rq-search [data-search-prompt-bulk-slot]:empty, .rq-search [data-search-prompt-select-slot]:empty { display:none; }
.rq-search .prompt-bulk-toolbar { display:grid; gap:12px; padding:16px; margin:12px 0; border:1px solid var(--border); border-radius:10px; min-width:0; }
.rq-search .prompt-bulk-toolbar :is(p,h3) { margin:0; overflow-wrap:anywhere; }
.rq-search [data-prompt-schedule-actions] { display:flex; flex-wrap:wrap; gap:8px; }
.rq-search .prompt-bulk-toolbar button { padding:8px 12px; font:inherit; color:var(--fg); background:var(--surface); border:1px solid var(--border-strong); border-radius:var(--wc-radius,9px); min-height:44px; cursor:pointer; }
.rq-search .prompt-bulk-toolbar button:disabled { opacity:0.6; cursor:default; }
.rq-search .prompt-bulk-review { display:grid; gap:12px; min-width:0; overflow-wrap:anywhere; }
.rq-search .prompt-bulk-review ol { margin:0; padding-left:20px; }
.rq-search .prompt-bulk-review li { display:grid; gap:8px; padding:12px 0; border-top:1px solid var(--border); }
.rq-search .prompt-bulk-review input { display:block; box-sizing:border-box; width:100%; max-width:360px; min-height:44px; margin:8px 0; padding:8px; font:inherit; color:var(--fg); background:var(--surface); border:1px solid var(--border-strong); border-radius:var(--wc-radius,9px); }
.rq-search .prompt-bulk-select { display:flex; align-items:center; gap:8px; min-height:44px; cursor:pointer; }
.rq-search .prompt-bulk-select input { width:20px; height:20px; margin:0; }
.rq-search .reminders-triage { display:grid; gap:12px; padding:16px; border:1px solid var(--border); border-radius:10px; min-width:0; }
.rq-search .reminders-triage :is(p,h3) { margin:0; overflow-wrap:anywhere; }
.rq-search .reminders-triage :is(.reminders-triage-review,.reminders-triage-time) { display:grid; gap:12px; min-width:0; }
.rq-search .reminders-buttons { display:flex; flex-wrap:wrap; gap:8px; }
.rq-search .reminders-field { display:grid; gap:8px; min-width:0; }
.rq-search .reminders-triage :is(button,input) { min-height:44px; max-width:100%; box-sizing:border-box; }
.rq-search .reminders-subtle { color:var(--fg-muted); font-size:0.85rem; }
.rq-search .reminders-triage ul { display:grid; gap:12px; padding-left:20px; min-width:0; overflow-wrap:anywhere; }
.rq-search .reminders-triage :is(.reminders-error,[data-outcome="failed"],[data-outcome="needs_review"]) { color:var(--danger); }
.rq-search .reminders-triage-select { display:flex; align-items:center; gap:8px; min-height:44px; cursor:pointer; }
.rq-search .reminders-triage-select input { width:20px; height:20px; margin:0; }
.rq-search-tools { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,20rem); align-items:start; gap:12px; min-width:0; }
.rq-query-field { display:grid; gap:6px; min-width:0; }
.rq-type-controls { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:end; gap:6px 8px; min-width:0; }
.rq-type-controls label { grid-column:1 / -1; }
.rq-search-label, .rq-type-controls label { font-size:12px; font-weight:600; line-height:1.4; color:var(--fg-muted); }
.rq-type-controls select { box-sizing:border-box; width:100%; min-width:0; max-width:100%; min-height:var(--wc-control-h,44px); padding:0 10px; font:inherit; color:var(--fg); background:var(--surface); border:1px solid var(--border-strong); border-radius:var(--wc-radius,9px); }
.rq-type-controls .rq-retry { align-self:stretch; min-height:var(--wc-control-h,44px); padding:0 12px; border-radius:var(--wc-radius,9px); font-weight:600; }
.rq-reminder-dates { display:grid; gap:10px; min-width:0; margin:12px 0; }
.rq-reminder-date-controls { display:grid; gap:10px; min-width:0; margin:0; padding:0; border:0; }
.rq-reminder-date-fields { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; }
.rq-reminder-date-fields label { display:grid; gap:6px; min-width:0; font-size:12px; }
.rq-reminder-date-fields input { box-sizing:border-box; width:100%; min-width:0; max-width:100%; min-height:var(--wc-control-h,44px); padding:0 8px; font:inherit; color:var(--fg); background:var(--surface); border:1px solid var(--border-strong); border-radius:var(--wc-radius,9px); }
.rq-reminder-date-actions { display:flex; flex-wrap:wrap; gap:8px; }
.rq-reminder-date-actions .rq-retry { min-height:var(--wc-control-h,44px); }
.rq-search-tools > #rq-type-counts { grid-column:1 / -1; }
@media (max-width:800px) { .rq-search-tools { grid-template-columns:minmax(0,1fr); } }
@media (max-width:600px) {
  .rq-type-controls { grid-template-columns:minmax(0,1fr); }
  .rq-type-controls .rq-retry { width:100%; }
}
.rq-recent { min-width:0; }
.rq-recent-head { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:.5rem; }
.rq-recent-head h2 { margin:0; font-size:1rem; }
.rq-recent-list { display:grid; gap:.5rem; list-style:none; margin:.5rem 0 0; padding:0; }
.rq-recent-list li { display:flex; gap:.5rem; min-width:0; }
.rq-recent button { min-height:44px; padding:.5rem .75rem; font:inherit; color:var(--fg); background:var(--surface); border:1px solid var(--border); border-radius:.5rem; cursor:pointer; }
.rq-recent button:hover { background:var(--surface-sunk); border-color:var(--border-strong); }
.rq-recent button:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.rq-recent-run { flex:1; min-width:0; text-align:left; overflow-wrap:anywhere; }
.rq-recent-remove, .rq-recent-clear { flex:none; }
.rq-recent-work { margin-block:1rem; }
.rq-recent-record { display:grid; gap:.25rem; }
.rq-recent-record small { color:var(--fg-muted); font-size:.8rem; }
.rq-recent-work button[aria-disabled="true"] { opacity:.6; cursor:default; }
.rq-search-input { padding:0 12px; min-height:var(--wc-control-h,44px); font:inherit; width:100%; min-width:0; box-sizing:border-box;
  border:1px solid var(--border-strong); border-radius:var(--wc-radius,9px); background:var(--surface); color:var(--fg); }
.rq-hint, .rq-empty { color: var(--fg-muted); margin: 0.25rem 0; }
.rq-summary { font-size: 0.85rem; color: var(--fg-muted); margin: 0; }
.rq-group { display: flex; flex-direction: column; gap: 0.5rem; min-width: 0; }
.rq-group-head { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; font-size: 0.9rem; margin: 0.75rem 0 0; }
.rq-group-name { overflow-wrap: anywhere; min-width: 0; }
.rq-group-platform { font-size: 0.75rem; color: var(--fg-muted); }
.rq-group-count { margin-left: auto; padding: 0.125rem 0.5rem; border-radius: 1rem; background: var(--surface-sunk);
  color: var(--fg-muted); font-size: 0.75rem; font-weight: 500; font-variant-numeric: tabular-nums; }
.rq-rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
.rq-pinnable { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:.5rem; align-items:start; }
.rq-pinnable .rq-row-btn { min-width:0; }
.rq-record-pin { align-self:start; }
.rq-record-pin-notice { grid-column:1 / -1; font-size:.875rem; overflow-wrap:anywhere; }
.rq-row-btn { display: grid; gap: 0.3rem; width: 100%; min-height: 44px; box-sizing: border-box; text-align: left;
  padding: 0.75rem; font: inherit; cursor: pointer; border: 1px solid var(--border); border-radius: 0.5rem;
  background: var(--surface); color: var(--fg); text-decoration: none; }
.rq-row-btn:hover { background: var(--surface-sunk); border-color: var(--border-strong); }
.rq-row-title, .rq-row-excerpt, .rq-row-when { min-width: 0; overflow-wrap: anywhere; }
.rq-row-title { font-weight: 600; line-height: 1.4; }
.rq-row-when { font-size: 0.75rem; color: var(--fg-muted); }
.rq-row-excerpt { font-size: 0.85rem; line-height: 1.5; color: var(--fg-muted); }
.rq-row-title mark, .rq-row-excerpt mark { color: var(--fg); background: color-mix(in srgb, var(--accent) 22%, var(--surface)); font-weight: 600; }
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
.rq-search :is(button, a):focus-visible, .rq-search-input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.rq-subtle { font-size: 0.75rem; line-height: 1.5; color: var(--fg-muted); margin: 0; }
.rq-error { margin: 0.25rem 0; font-size: 0.875rem; }
.rq-did-you-mean { margin: 0.25rem 0; }
.rq-absent { margin: 0.25rem 0; }
.rq-did-you-mean-btn { font: inherit; color: inherit; background: none; border: 0; padding: 0;
  text-decoration: underline; cursor: pointer; }
`;
