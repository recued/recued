import { UNIVERSAL_SEARCH_RESULT_TYPES, type UniversalSearchResultType } from '@recued/contracts';
import { e } from '@recued/ui-shared';
import type { UniversalSearchProps } from './universal-search.js';

export const SEARCH_TYPE_ATTR = 'data-recued-universal-search-type';
export const SEARCH_CLEAR_TYPE_ACTION = 'universal-search-clear-type';
export const SEARCH_TYPE_LABELS: Record<UniversalSearchResultType, string> = {
  all: 'All types', chat: 'Chats', mail: 'Mail', draft: 'Drafts', file: 'Files', contact: 'Contacts',
  task: 'Tasks', note: 'Notes', project: 'Projects', commitment: 'Commitments', booking: 'Bookings', calendar: 'Calendar',
  reminder: 'Reminders', scheduled_prompt: 'Scheduled prompts', decision: 'Pending decisions', asset: 'Assets', capability: 'Recipes & packs',
};
export interface SearchTypeCount { loaded: number; more: boolean; pending: boolean; unavailable: boolean }
const count = (loaded = 0, more = false, pending = false, unavailable = false): SearchTypeCount => ({ loaded, more, pending, unavailable });

/** Counts describe materialized rows, never an invented cross-store total. */
export const searchTypeCounts = (props: UniversalSearchProps): Record<UniversalSearchResultType, SearchTypeCount> => {
  const result = {} as Record<UniversalSearchResultType, SearchTypeCount>;
  for (const type of ['mail', 'calendar', 'file'] as const) {
    const groups = props.groups?.filter(group => group.platform === type) ?? [];
    result[type] = count(groups.reduce((total, group) => total + group.matches.length, 0), groups.some(group => group.more),
      props.recordSearchAvailable !== false && (props.loading === true || props.groups === undefined && !props.error),
      props.recordSearchAvailable === false || props.error !== undefined);
  }
  for (const type of ['task', 'note', 'project', 'commitment', 'booking'] as const) {
    const group = props.workGroups?.find(group => group.kind === type);
    result[type] = count(group?.matches.length ?? 0, group?.more === true,
      props.workSearchAvailable !== false && !props.workUnsupported && (props.workLoading === true || props.workLoadingKinds?.has(type) === true || props.workGroups === undefined && !props.workError),
      props.workSearchAvailable === false || props.workUnsupported === true || props.workError !== undefined || group?.error !== undefined);
  }
  result.chat = count(props.chatSearch?.matches.length ?? 0, !!props.chatSearch?.next_cursor || props.chatSearch?.incomplete === true,
    props.chatSearch?.loading === true, !props.chatSearch || props.chatSearch.unsupported === true || props.chatSearch.error !== undefined);
  result.reminder = count(props.reminderSearch?.matches.length ?? 0, !!props.reminderSearch?.next_cursor,
    props.reminderSearch?.loading === true, !props.reminderSearch || props.reminderSearch.unsupported === true || props.reminderSearch.error !== undefined);
  result.scheduled_prompt = count(props.promptSearch?.matches.length ?? 0, false, props.promptSearch?.loading === true,
    !props.promptSearch || props.promptSearch.unsupported === true || props.promptSearch.error !== undefined);
  result.decision = count(props.decisionSearch?.matches.length ?? 0, false, props.decisionSearch?.loading === true,
    !props.decisionSearch || props.decisionSearch.incomplete === true);
  result.draft = count((props.draftSearch?.matches.length ?? 0) + (props.recoveryDraftSearch?.matches.length ?? 0), !!props.draftSearch?.next_cursor,
    props.draftSearch?.loading === true || props.recoveryDraftSearch?.loading === true,
    (!props.draftSearch && !props.recoveryDraftSearch?.available) || props.draftSearch?.unsupported === true || props.draftSearch?.error !== undefined || !!props.recoveryDraftSearch?.issues.length);
  result.asset = count(props.assetSearch?.matches.length ?? 0, props.assetSearch?.more === true,
    props.assetSearch?.loading === true, !props.assetSearch || props.assetSearch.unsupported === true || props.assetSearch.error !== undefined);
  result.contact = count(props.contactSearch?.contacts.length ?? 0, props.contactSearch?.more === true,
    props.contactSearch?.loading === true, !props.contactSearch || props.contactSearch.unsupported === true || props.contactSearch.error !== undefined);
  result.capability = count((props.recipes?.length ?? 0) + (props.packs?.length ?? 0), false,
    props.capabilitiesLoading === true, props.capabilitiesError !== undefined);
  const document = props.documentSearch;
  if (document && document.phase !== 'idle') {
    result.file.loaded += document.matches.length;
    result.file.more ||= !!document.result?.next_cursor || document.result?.next_offset !== undefined || document.result?.partial === true;
    result.file.pending ||= document.phase === 'searching' || document.phase === 'held';
    result.file.unavailable ||= document.phase === 'error' || document.phase === 'changed' || document.unsupported === true;
  }
  if (props.debouncing) for (const value of Object.values(result)) { value.loaded = 0; value.more = false; value.pending = !value.unavailable; }
  const values = Object.values(result);
  result.all = count(values.reduce((total, value) => total + value.loaded, 0), values.some(value => value.more),
    values.some(value => value.pending), values.some(value => value.unavailable));
  return result;
};

/** A type choice changes presentation. Existing queries and page cursors keep
 * running so switching back cannot discard confirmed results. */
export const filterUniversalSearch = (props: UniversalSearchProps, type: UniversalSearchResultType): UniversalSearchProps => {
  if (type === 'all') return props;
  const records = type === 'mail' || type === 'file' || type === 'calendar';
  const work = type === 'task' || type === 'note' || type === 'project' || type === 'commitment' || type === 'booking';
  return { ...props,
    groups: records ? props.groups?.filter(group => group.platform === type) : [],
    loading: records && props.loading === true, error: records ? props.error : undefined,
    workGroups: work ? props.workGroups?.filter(group => group.kind === type) : [],
    workLoading: work && props.workLoading === true, workLoadingKinds: work ? props.workLoadingKinds : undefined,
    workError: work ? props.workError : undefined, workUnsupported: work && props.workUnsupported === true,
    contactSearch: type === 'contact' ? props.contactSearch : undefined,
    assetSearch: type === 'asset' ? props.assetSearch : undefined,
    draftSearch: type === 'draft' ? props.draftSearch : undefined,
    recoveryDraftSearch: type === 'draft' ? props.recoveryDraftSearch : undefined,
    recoveryDraftOpening: type === 'draft' ? props.recoveryDraftOpening : undefined,
    recoveryDraftError: type === 'draft' ? props.recoveryDraftError : undefined,
    draftOpeningId: type === 'draft' ? props.draftOpeningId : undefined, draftOpenError: type === 'draft' ? props.draftOpenError : undefined,
    chatSearch: type === 'chat' ? props.chatSearch : undefined,
    reminderSearch: type === 'reminder' ? props.reminderSearch : undefined,
    promptSearch: type === 'scheduled_prompt' ? props.promptSearch : undefined,
    promptOpening: type === 'scheduled_prompt' ? props.promptOpening : undefined,
    promptOpenError: type === 'scheduled_prompt' ? props.promptOpenError : undefined,
    decisionSearch: type === 'decision' ? props.decisionSearch : undefined,
    decisionOpening: type === 'decision' ? props.decisionOpening : undefined,
    decisionOpenError: type === 'decision' ? props.decisionOpenError : undefined,
    documentSearch: type === 'file' ? props.documentSearch : undefined,
    recipes: type === 'capability' ? props.recipes : [], packs: type === 'capability' ? props.packs : [],
    capabilitiesLoading: type === 'capability' && props.capabilitiesLoading === true,
    capabilitiesError: type === 'capability' ? props.capabilitiesError : undefined,
    // Collection-wide corrections and a cloud offer cannot establish an empty
    // result in a narrower type. Preserve the existing All-types policy.
    didYouMean: undefined, absentWords: undefined, marketplace: [], marketplaceOffered: false,
    marketplaceLoading: false, marketplaceError: undefined,
  };
};

export const renderSearchTypeFilter = (props: UniversalSearchProps): string => {
  const selected = props.resultType ?? 'all', counts = searchTypeCounts(props), searching = props.query.trim().length > 0;
  return `<div class="rq-type-controls">
    <label for="rq-result-type">Result type</label><select id="rq-result-type" ${SEARCH_TYPE_ATTR} aria-describedby="rq-type-counts"${props.searchWriting || props.reminderTriage?.writing ? ' disabled' : ''}>${UNIVERSAL_SEARCH_RESULT_TYPES.map(type => {
      const value = counts[type];
      const number = `${value.loaded}${value.more ? '+' : ''} loaded`;
      const state = value.pending ? 'Searching…' : value.unavailable ? 'Unavailable' : '';
      const suffix = searching ? ` · ${value.loaded || !state ? number : ''}${value.loaded && state ? ' · ' : ''}${state}` : '';
      return `<option value="${type}"${type === selected ? ' selected' : ''}>${e(SEARCH_TYPE_LABELS[type] + suffix)}</option>`;
    }).join('')}</select>
    ${selected !== 'all' ? `<button type="button" class="rq-retry" ${e(props.actionAttr)}="${SEARCH_CLEAR_TYPE_ACTION}"${props.searchWriting || props.reminderTriage?.writing ? ' disabled' : ''}>Clear type filter</button>` : ''}
  </div><p class="rq-subtle" id="rq-type-counts">Counts show loaded results. + means more may be available.</p>`;
};

/** Retire old numbers at the edit boundary without replacing the search input
 * or disturbing native typing/selection while the next query is debounced. */
export const retireSearchTypeCounts = (root: HTMLElement): void => {
  const select = root.querySelector<HTMLSelectElement>(`[${SEARCH_TYPE_ATTR}]`);
  if (select) for (const option of Array.from(select.querySelectorAll<HTMLOptionElement>('option'))) {
    const label = SEARCH_TYPE_LABELS[option.value as UniversalSearchResultType];
    if (label) option.textContent = label;
  }
  const note = root.querySelector<HTMLElement>('#rq-type-counts');
  if (note) note.textContent = 'Counts will update for this search.';
};
