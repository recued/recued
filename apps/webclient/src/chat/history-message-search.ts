import type {
  ChatHistoryCursor,
  ChatMessageSearchMatch,
  ChatMessageSearchRequest,
  ChatMessageSearchResult,
  ChatHistoryFilters,
} from '@recued/contracts';

export const HISTORY_MESSAGE_RESULT_ATTR = 'data-recued-chat-history-message';
export const HISTORY_MESSAGE_MORE_ATTR = 'data-recued-chat-history-message-more';
export const HISTORY_MESSAGE_SEARCH_ATTR = 'data-recued-chat-history-messages';

/** Search owns just its result region. A response must not rebuild the chat
 * composer, move the search caret, or resurrect a superseded query. */
export const createHistoryMessageSearch = (opts: {
  document: Document;
  search: (request: ChatMessageSearchRequest) => Promise<ChatMessageSearchResult>;
  open: (sessionId: string, messageId: string) => void;
  isOpening: (messageId: string) => boolean;
}) => {
  const doc = opts.document;
  let root: HTMLElement | null = null;
  let query = '';
  let scope: { filters?: ChatHistoryFilters; session_id?: string; unavailable?: string; membership?: string } = {};
  let scopeKey = '{}';
  let matches: ChatMessageSearchMatch[] = [];
  let cursor: ChatHistoryCursor | undefined;
  let incomplete = false;
  let loading = false;
  let error = '';
  let generation = 0;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const focusResult = (messageId: string): void => {
    const target = Array.from(root?.querySelectorAll<HTMLElement>(`[${HISTORY_MESSAGE_RESULT_ATTR}]`) ?? [])
      .find(element => element.getAttribute(HISTORY_MESSAGE_RESULT_ATTR) === messageId);
    target?.focus({ preventScroll: true });
  };

  const render = (pageStart = matches.length): void => {
    if (root === null) return;
    const focusedMessageId = doc.activeElement?.getAttribute(HISTORY_MESSAGE_RESULT_ATTR);
    const focusedMore = doc.activeElement?.getAttribute(HISTORY_MESSAGE_MORE_ATTR) === '';
    while (root.firstChild) root.removeChild(root.firstChild);
    root.hidden = query.length === 0;
    if (query.length === 0) return;
    const title = doc.createElement('h3');
    title.className = 'chat-history-group-title';
    title.textContent = 'Messages';
    root.appendChild(title);
    const status = doc.createElement('p');
    status.className = 'chat-history-result-count';
    status.setAttribute('role', 'status');
    status.tabIndex = -1;
    status.textContent = scope.unavailable || error || (loading
      ? `Searching messages…${matches.length > 0 ? ` ${matches.length} found so far.` : ''}`
      : matches.length === 0
        ? cursor !== undefined ? 'Nothing yet. There are older messages still to search.'
          : incomplete ? 'Nothing found in the messages Recued could read.' : 'No matching messages.'
        : `${matches.length} matching message${matches.length === 1 ? '' : 's'}${cursor !== undefined ? ' so far' : ''}.`);
    root.appendChild(status);
    for (const match of matches) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'chat-history-message-result';
      button.setAttribute(HISTORY_MESSAGE_RESULT_ATTR, match.message_id);
      if (opts.isOpening(match.message_id)) button.setAttribute('aria-busy', 'true');
      const heading = doc.createElement('span');
      heading.className = 'chat-session-title';
      heading.textContent = match.title || 'Untitled chat';
      button.appendChild(heading);
      const meta = doc.createElement('span');
      meta.className = 'chat-session-meta';
      meta.textContent = `${match.role === 'user' ? 'You' : 'Assistant'} · ${new Date(match.ts).toLocaleDateString()}`;
      button.appendChild(meta);
      if (opts.isOpening(match.message_id)) {
        const opening = doc.createElement('span');
        opening.className = 'chat-session-status';
        opening.textContent = 'Opening…';
        button.appendChild(opening);
      }
      const snippet = doc.createElement('span');
      snippet.className = 'chat-history-message-snippet';
      // Message text is untrusted content, never markup or executable links.
      snippet.textContent = match.snippet;
      button.appendChild(snippet);
      button.addEventListener('click', () => opts.open(match.session_id, match.message_id));
      root.appendChild(button);
    }
    if (incomplete) {
      const note = doc.createElement('p');
      note.className = 'chat-history-result-count';
      note.textContent = 'Recued could not read some saved messages, so this may be missing things.';
      root.appendChild(note);
    }
    if (!scope.unavailable && (cursor !== undefined || error.length > 0 || (loading && focusedMore))) {
      const more = doc.createElement('button');
      more.type = 'button';
      more.className = 'chat-session-action';
      more.setAttribute(HISTORY_MESSAGE_MORE_ATTR, '');
      more.textContent = loading ? 'Searching…' : error ? 'Retry message search' : 'Search older messages';
      // Keep keyboard focus while loading. The click guard provides the
      // disabled behavior without detaching the active element's replacement.
      more.setAttribute('aria-disabled', String(loading));
      more.addEventListener('click', () => { if (!loading) void run(); });
      root.appendChild(more);
      if (focusedMore) more.focus({ preventScroll: true });
    } else if (focusedMore) {
      const firstNewMatch = matches[pageStart];
      if (firstNewMatch !== undefined) focusResult(firstNewMatch.message_id);
      else status.focus({ preventScroll: true });
    }
    if (focusedMessageId) focusResult(focusedMessageId);
  };

  const run = async (): Promise<void> => {
    if (disposed || query.length === 0 || scope.unavailable) return;
    const ownGeneration = ++generation;
    const pageStart = matches.length;
    loading = true;
    error = '';
    render();
    try {
      const response = await opts.search({ query, ...(cursor ? { before: cursor } : {}),
        ...(scope.filters ? { filters: scope.filters } : {}),
        ...(scope.session_id ? { session_id: scope.session_id } : {}),
      });
      if (disposed || generation !== ownGeneration) return;
      const seen = new Set(matches.map((match) => match.message_id));
      matches = [...matches, ...response.matches.filter((match) => !seen.has(match.message_id))];
      cursor = response.next_cursor;
      incomplete ||= response.incomplete;
    } catch (err) {
      if (disposed || generation !== ownGeneration) return;
      const code = (err as { code?: string } | null)?.code;
      error = code === 'unknown_method' || code === 'not_configured'
        ? 'This server cannot search inside messages. You can still search chat names.'
        : code === 'bad_request'
          ? 'Recued could not use that. Try something shorter.'
          : 'Recued could not search your messages. Reconnect and try again.';
    } finally {
      if (!disposed && generation === ownGeneration) {
        loading = false;
        render(pageStart);
      }
    }
  };

  const reset = (): void => {
    generation += 1;
    clearTimeout(timer);
    matches = []; cursor = undefined; incomplete = false; error = '';
    loading = query.length > 0 && !scope.unavailable;
    render();
    if (loading) timer = setTimeout(() => { void run(); }, 250);
  };

  return {
    focusResult,
    mount(container: HTMLElement): void {
      root = container;
      root.setAttribute(HISTORY_MESSAGE_SEARCH_ATTR, '');
      render();
    },
    setQuery(value: string): void {
      const next = value.trim();
      if (next === query || disposed) return;
      query = next;
      reset();
    },
    setScope(next: typeof scope): void {
      const key = JSON.stringify(next);
      if (key === scopeKey || disposed) return;
      scope = next; scopeKey = key; reset();
    },
    removeSession(sessionId: string): void {
      // Invalidate an outstanding response that may still contain deleted rows.
      generation += 1;
      clearTimeout(timer);
      loading = false;
      matches = matches.filter((match) => match.session_id !== sessionId);
      render();
      if (query.length > 0) void run();
    },
    dispose(): void {
      disposed = true;
      generation += 1;
      clearTimeout(timer);
      root = null;
    },
  };
};
