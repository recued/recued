/** D-177 N.11 rule 5 (5.c, slice C) — the "Scoped grant proposals" panel:
 *  the owner surface for utterance-derived session-scope-overlay proposals
 *  (the user asked, in their own chat turn, to auto-approve a bounded
 *  forwarded-sender action; the parse filed an inert proposal — only the
 *  human mints, N.9.7).
 *
 *  Mirrors the P6c "Suggested rules" panel's discipline over the SEPARATE
 *  scoped row kind (5.i.2). Each open card shows:
 *  - the rule-7 sentence rendered 1:1 from the enforced bounds (5.c),
 *  - **the triggering utterance excerpt, verbatim** (codex MEDIUM fold —
 *    the human must distinguish "I asked for this" from "this text was
 *    inside an email I forwarded"),
 *  - the CONNECTION the grant will bind: a single parse-time candidate is
 *    pre-selected, multiple render a picker, zero render the card
 *    unmintable (the accept rpc re-validates LIVE either way),
 *  - tighten-only TTL (minutes) + use-budget inputs.
 *
 *  Zero open proposals ⇒ the panel renders nothing (no noise). Live
 *  coherence off `contract.scoped_grant_suggested` / `…_resolved`.
 *  Proposals are never model-visible (N.9.1) — the rpc family is reserved
 *  out of MCP; this panel is the only consumer.
 *
 *  Spec: D-177 § N.11 rule 5 (5.c); slice C. */

import {
  SCOPED_GRANT_MAX_USES_DEFAULT,
  renderScopedGrantSentence,
  type ContractDefinitionView,
  type ScopedGrantSuggestionRow,
} from '@recued/contracts';

import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

/** The broadcast kinds this panel subscribes to (D-177 N.11 rule 5 scoped
 *  session-grant proposals). Exposed as a const so the panel's own test can
 *  assert they're in `WEBCLIENT_DEFAULT_SUBSCRIPTIONS` — the server fans only
 *  the kinds each client names (D-169 TR-10), so an un-listed kind would make
 *  this panel's listeners silently never fire. Single source of truth: the
 *  panel subscribes off this list. Mirrors `RECEPTION_PAGE_SHELL_BROADCAST_KINDS`. */
export const SCOPED_GRANT_PANEL_BROADCAST_KINDS = [
  'contract.scoped_grant_suggested',
  'contract.scoped_grant_suggestion_resolved',
] as const;

// ════════════════════════════════════════════════════════════════
// Caller seams + handle
// ════════════════════════════════════════════════════════════════

export type ScopedSuggestionsListCaller = () => Promise<{
  suggestions: ReadonlyArray<ScopedGrantSuggestionRow>;
}>;

export type ScopedSuggestionsAcceptCaller = (args: {
  key_hash: string;
  connection_name?: string;
  ttl_ms?: number;
  max_uses?: number;
}) => Promise<{
  grant: ContractDefinitionView;
  suggestion: ScopedGrantSuggestionRow;
  sentence: string;
}>;

export type ScopedSuggestionsDismissCaller = (args: {
  key_hash: string;
}) => Promise<{ suggestion: ScopedGrantSuggestionRow }>;

export type ScopedGrantPanelState = 'loading' | 'ready' | 'error';

export interface MountScopedGrantPanelOptions {
  host: HTMLElement;
  document?: Document;
  runListSuggestions: ScopedSuggestionsListCaller;
  runAcceptSuggestion: ScopedSuggestionsAcceptCaller;
  runDismissSuggestion: ScopedSuggestionsDismissCaller;
  subscribe?: BroadcastSubscriber['on'];
}

export interface ScopedGrantPanelMount {
  getState(): ScopedGrantPanelState;
  getOpenSuggestions(): ReadonlyArray<ScopedGrantSuggestionRow>;
  getListError(): string | null;
  refresh(): Promise<void>;
  whenLoaded(): Promise<void>;
  /** True while an accept or dismiss decision has no terminal result. */
  hasInFlightWork(): boolean;
  /** Test seam — accept with explicit args (connection/ttl/uses). */
  acceptSuggestion(
    keyHash: string,
    args?: { connection_name?: string; ttl_ms?: number; max_uses?: number },
  ): Promise<void>;
  /** Test seam — dismiss (the armed Confirm equivalent). */
  dismissSuggestion(keyHash: string): Promise<void>;
  dispose(): void;
}

// ════════════════════════════════════════════════════════════════
// Attribute constants — stable hooks for tests + the route shell
// ════════════════════════════════════════════════════════════════

export const SCOPED_GRANT_PANEL_HOST_ATTR = 'data-recued-scoped-grant-panel';
export const SCOPED_GRANT_HEADING_ATTR = 'data-recued-scoped-grant-heading';
export const SCOPED_GRANT_ERROR_ATTR = 'data-recued-scoped-grant-error';
export const SCOPED_GRANT_CARD_ATTR = 'data-recued-scoped-grant-card';
export const SCOPED_GRANT_SENTENCE_ATTR = 'data-recued-scoped-grant-sentence';
export const SCOPED_GRANT_EXCERPT_ATTR = 'data-recued-scoped-grant-excerpt';
export const SCOPED_GRANT_CONNECTION_SELECT_ATTR =
  'data-recued-scoped-grant-connection';
export const SCOPED_GRANT_TTL_INPUT_ATTR = 'data-recued-scoped-grant-ttl';
export const SCOPED_GRANT_USES_INPUT_ATTR = 'data-recued-scoped-grant-uses';
export const SCOPED_GRANT_ACCEPT_ATTR = 'data-recued-scoped-grant-accept';
export const SCOPED_GRANT_DISMISS_ATTR = 'data-recued-scoped-grant-dismiss';
export const SCOPED_GRANT_DISMISS_CONFIRM_ATTR =
  'data-recued-scoped-grant-dismiss-confirm';
export const SCOPED_GRANT_CANCEL_ATTR = 'data-recued-scoped-grant-cancel';
export const SCOPED_GRANT_CARD_ERROR_ATTR = 'data-recued-scoped-grant-card-error';
export const SCOPED_GRANT_UNMINTABLE_ATTR = 'data-recued-scoped-grant-unmintable';

// ════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════

const MINUTE_MS = 60_000;

type CardMode = 'idle' | 'dismiss-armed';

interface InternalState {
  phase: ScopedGrantPanelState;
  suggestions: ReadonlyArray<ScopedGrantSuggestionRow>;
  listError: string | null;
  cardErrors: ReadonlyMap<string, string>;
  activeKeyHash: string | null;
  activeMode: CardMode;
}

const errMessage = (err: unknown): string =>
  humanizeRpcError(err);

const parseBound = (raw: string, ceiling: number): number | null => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > ceiling) return null;
  return n;
};

// ════════════════════════════════════════════════════════════════
// Mount
// ════════════════════════════════════════════════════════════════

export const mountScopedGrantPanel = (
  opts: MountScopedGrantPanelOptions,
): ScopedGrantPanelMount => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'mountScopedGrantPanel: no document available — pass `opts.document` for non-browser environments',
    );
  }

  let state: InternalState = {
    phase: 'loading',
    suggestions: [],
    listError: null,
    cardErrors: new Map(),
    activeKeyHash: null,
    activeMode: 'idle',
  };
  let disposed = false;
  let loadGeneration = 0;
  let pendingLoad: Promise<void> = Promise.resolve();
  const pendingByKey = new Set<string>();

  const root = doc.createElement('div');
  root.setAttribute(SCOPED_GRANT_PANEL_HOST_ATTR, '');
  opts.host.appendChild(root);

  const clearChildren = (node: HTMLElement): void => {
    while (node.firstChild) node.removeChild(node.firstChild);
  };

  const makeButton = (
    attr: string,
    className: string,
    text: string,
    keyHash: string,
  ): HTMLElement => {
    const btn = doc.createElement('button');
    btn.setAttribute(attr, '');
    btn.setAttribute('type', 'button');
    btn.setAttribute('data-key-hash', keyHash);
    btn.className = className;
    btn.textContent = text;
    return btn;
  };

  const setActive = (keyHash: string | null, mode: CardMode): void => {
    state = {
      ...state,
      activeKeyHash: keyHash,
      activeMode: keyHash === null ? 'idle' : mode,
    };
    render();
  };

  const renderCard = (row: ScopedGrantSuggestionRow): void => {
    const key = row.key_hash;
    const ttlCeilingMinutes = Math.max(1, Math.floor(row.snapshot.ttl_ms / MINUTE_MS));

    const card = doc.createElement('div');
    card.setAttribute(SCOPED_GRANT_CARD_ATTR, '');
    card.setAttribute('data-key-hash', key);
    card.className = 'sg-card';

    // The rule-7 sentence — every clause maps onto an enforced bound. The
    // default rendering (snapshot TTL + default budget + sole/first
    // candidate); the actual accepted bounds re-render server-side in the
    // rpc response.
    // The sentence re-renders whenever the selected connection changes
    // (codex MEDIUM fold) — the human-readable authority check must always
    // name the connection the accept will actually bind.
    const sentence = doc.createElement('div');
    sentence.setAttribute(SCOPED_GRANT_SENTENCE_ATTR, '');
    sentence.className = 'sg-sentence';
    const renderSentence = (connection_name: string | undefined): void => {
      sentence.textContent = renderScopedGrantSentence({
        operation_id: row.snapshot.operation_id,
        ...(connection_name !== undefined ? { connection_name } : {}),
        ttl_ms: row.snapshot.ttl_ms,
        max_uses: SCOPED_GRANT_MAX_USES_DEFAULT,
      });
    };
    renderSentence(row.connection_candidates[0]);
    card.appendChild(sentence);

    // The session binding, explicit (codex MEDIUM fold) — this panel is a
    // global surface, so "in this chat" must say WHICH chat the grant binds.
    const sessionLine = doc.createElement('div');
    sessionLine.className = 'sg-session';
    sessionLine.textContent = `Only for this chat: ${row.snapshot.channel_session_id}`;
    card.appendChild(sessionLine);

    // The triggering excerpt, verbatim (codex MEDIUM fold) — the human's
    // only check that the request was THEIRS.
    const excerpt = doc.createElement('blockquote');
    excerpt.setAttribute(SCOPED_GRANT_EXCERPT_ATTR, '');
    excerpt.className = 'sg-excerpt';
    excerpt.textContent = `Started by: “${row.triggering_excerpt}”`;
    card.appendChild(excerpt);

    if (pendingByKey.has(key)) {
      const busy = makeButton(SCOPED_GRANT_ACCEPT_ATTR, 'sg-accept', 'Working…', key);
      busy.setAttribute('disabled', '');
      card.appendChild(busy);
    } else if (state.activeKeyHash === key && state.activeMode === 'dismiss-armed') {
      const controls = doc.createElement('div');
      controls.className = 'sg-confirm';
      const prompt = doc.createElement('span');
      prompt.className = 'sg-confirm-prompt';
      prompt.textContent =
        'Hide this? It will not come back in this chat.';
      controls.appendChild(prompt);
      const confirm = makeButton(
        SCOPED_GRANT_DISMISS_CONFIRM_ATTR,
        'sg-dismiss sg-confirm-yes',
        'Confirm',
        key,
      );
      confirm.addEventListener('click', () => {
        void runDismiss(row);
      });
      controls.appendChild(confirm);
      const cancel = makeButton(SCOPED_GRANT_CANCEL_ATTR, 'sg-cancel', 'Cancel', key);
      cancel.addEventListener('click', () => setActive(null, 'idle'));
      controls.appendChild(cancel);
      card.appendChild(controls);
    } else if (row.connection_candidates.length === 0) {
      // 5.c — none enrolled ⇒ unmintable. The card says so plainly; the
      // only resolution offered is Dismiss. (Enrolling a connection and
      // re-uttering the request raises a fresh card with candidates.)
      const note = doc.createElement('div');
      note.setAttribute(SCOPED_GRANT_UNMINTABLE_ATTR, '');
      note.className = 'sg-unmintable';
      note.textContent =
        'None of your Connections can do this. Set one up in Settings, then Connections, and ask again in the chat.';
      card.appendChild(note);
      const dismiss = makeButton(SCOPED_GRANT_DISMISS_ATTR, 'sg-dismiss', 'Dismiss', key);
      dismiss.addEventListener('click', () => setActive(key, 'dismiss-armed'));
      card.appendChild(dismiss);
    } else {
      // The inline editor IS the card body (unlike the delegation panel's
      // two-stage expand): a scoped proposal is session-scale, so the
      // connection + bounds sit in view before the single Approve.
      const editor = doc.createElement('div');
      editor.className = 'sg-editor';

      let connectionSelect: HTMLSelectElement | null = null;
      if (row.connection_candidates.length > 1) {
        const connLabel = doc.createElement('label');
        connLabel.className = 'sg-editor-label';
        connLabel.textContent = 'Connection';
        connectionSelect = doc.createElement('select');
        connectionSelect.setAttribute(SCOPED_GRANT_CONNECTION_SELECT_ATTR, '');
        connectionSelect.className = 'sg-editor-input';
        for (const name of row.connection_candidates) {
          const option = doc.createElement('option');
          option.setAttribute('value', name);
          option.textContent = name;
          connectionSelect.appendChild(option);
        }
        const select = connectionSelect;
        connectionSelect.addEventListener('change', () => {
          renderSentence(select.value);
        });
        connLabel.appendChild(connectionSelect);
        editor.appendChild(connLabel);
      } else {
        const connNote = doc.createElement('div');
        connNote.className = 'sg-editor-fixed';
        connNote.textContent = `Connection: ${row.connection_candidates[0]}`;
        editor.appendChild(connNote);
      }

      const ttlLabel = doc.createElement('label');
      ttlLabel.className = 'sg-editor-label';
      ttlLabel.textContent = 'Runs out after (minutes)';
      const ttlInput = doc.createElement('input');
      ttlInput.setAttribute(SCOPED_GRANT_TTL_INPUT_ATTR, '');
      ttlInput.setAttribute('type', 'number');
      ttlInput.setAttribute('min', '1');
      ttlInput.setAttribute('max', String(ttlCeilingMinutes));
      ttlInput.setAttribute('value', String(ttlCeilingMinutes));
      ttlInput.className = 'sg-editor-input';
      ttlLabel.appendChild(ttlInput);
      editor.appendChild(ttlLabel);

      const usesLabel = doc.createElement('label');
      usesLabel.className = 'sg-editor-label';
      usesLabel.textContent = 'How many times';
      const usesInput = doc.createElement('input');
      usesInput.setAttribute(SCOPED_GRANT_USES_INPUT_ATTR, '');
      usesInput.setAttribute('type', 'number');
      usesInput.setAttribute('min', '1');
      usesInput.setAttribute('max', String(SCOPED_GRANT_MAX_USES_DEFAULT));
      usesInput.setAttribute('value', String(SCOPED_GRANT_MAX_USES_DEFAULT));
      usesInput.className = 'sg-editor-input';
      usesLabel.appendChild(usesInput);
      editor.appendChild(usesLabel);

      const accept = makeButton(SCOPED_GRANT_ACCEPT_ATTR, 'sg-accept', 'Approve', key);
      accept.addEventListener('click', () => {
        const ttlMinutes = parseBound(
          (ttlInput as HTMLInputElement).value,
          ttlCeilingMinutes,
        );
        const maxUses = parseBound(
          (usesInput as HTMLInputElement).value,
          SCOPED_GRANT_MAX_USES_DEFAULT,
        );
        if (ttlMinutes === null || maxUses === null) {
          const next = new Map(state.cardErrors);
          next.set(
            key,
            `These have to be whole numbers — minutes 1–${ttlCeilingMinutes}, uses 1–${SCOPED_GRANT_MAX_USES_DEFAULT} (tighten-only).`,
          );
          state = { ...state, cardErrors: next };
          render();
          return;
        }
        void runAccept(row, {
          ...(connectionSelect !== null
            ? { connection_name: connectionSelect.value }
            : { connection_name: row.connection_candidates[0] }),
          ttl_ms: ttlMinutes * MINUTE_MS,
          max_uses: maxUses,
        });
      });
      editor.appendChild(accept);

      const dismiss = makeButton(SCOPED_GRANT_DISMISS_ATTR, 'sg-dismiss', 'Dismiss', key);
      dismiss.addEventListener('click', () => setActive(key, 'dismiss-armed'));
      editor.appendChild(dismiss);

      card.appendChild(editor);
    }

    const cardError = state.cardErrors.get(key);
    if (cardError !== undefined) {
      const line = doc.createElement('div');
      line.setAttribute(SCOPED_GRANT_CARD_ERROR_ATTR, '');
      line.className = 'sg-card-error';
      line.textContent = cardError;
      card.appendChild(line);
    }

    root.appendChild(card);
  };

  const render = (): void => {
    if (disposed) return;
    clearChildren(root);

    if (state.listError !== null) {
      const line = doc.createElement('div');
      line.setAttribute(SCOPED_GRANT_ERROR_ATTR, '');
      line.className = 'sg-error';
      line.textContent = `Recued could not load these: ${state.listError}`;
      root.appendChild(line);
    }

    if (state.suggestions.length === 0) return; // no heading, no noise

    const heading = doc.createElement('h2');
    heading.setAttribute(SCOPED_GRANT_HEADING_ATTR, '');
    heading.className = 'sg-heading';
    heading.textContent = 'Things Chat wants to be allowed to do';
    root.appendChild(heading);

    const copy = doc.createElement('p');
    copy.className = 'sg-copy';
    copy.textContent =
      'In a chat, you asked Recued to stop asking about one small thing for people who send you emails you forward on. Say yes and it holds only for this chat, and you can take it back at any time. Say no and Recued keeps asking you each time.';
    root.appendChild(copy);

    for (const row of state.suggestions) renderCard(row);
  };

  const doRefresh = (): Promise<void> => {
    const gen = ++loadGeneration;
    pendingLoad = (async () => {
      try {
        const { suggestions } = await opts.runListSuggestions();
        if (disposed || gen !== loadGeneration) return;
        state = {
          ...state,
          phase: 'ready',
          suggestions: suggestions.filter((s) => s.state === 'open'),
          listError: null,
          cardErrors: new Map(),
          activeKeyHash: null,
          activeMode: 'idle',
        };
        render();
      } catch (err) {
        if (disposed || gen !== loadGeneration) return;
        state = { ...state, phase: 'error', listError: errMessage(err) };
        render();
      }
    })();
    return pendingLoad;
  };

  const runResolution = async (
    row: ScopedGrantSuggestionRow,
    call: () => Promise<unknown>,
  ): Promise<void> => {
    const key = row.key_hash;
    if (pendingByKey.has(key)) return;
    pendingByKey.add(key);
    loadGeneration += 1;
    const startErrors = new Map(state.cardErrors);
    startErrors.delete(key);
    state = {
      ...state,
      cardErrors: startErrors,
      activeKeyHash: state.activeKeyHash === key ? null : state.activeKeyHash,
      activeMode: state.activeKeyHash === key ? 'idle' : state.activeMode,
    };
    render();
    try {
      await call();
      if (disposed) return;
      pendingByKey.delete(key);
      state = {
        ...state,
        suggestions: state.suggestions.filter((s) => s.key_hash !== key),
      };
      await doRefresh();
    } catch (err) {
      if (disposed) return;
      const next = new Map(state.cardErrors);
      next.set(key, errMessage(err));
      state = { ...state, cardErrors: next };
    } finally {
      pendingByKey.delete(key);
      if (!disposed) render();
    }
  };

  const runAccept = (
    row: ScopedGrantSuggestionRow,
    args?: { connection_name?: string; ttl_ms?: number; max_uses?: number },
  ): Promise<void> =>
    runResolution(row, () =>
      opts.runAcceptSuggestion({
        key_hash: row.key_hash,
        ...(args?.connection_name !== undefined
          ? { connection_name: args.connection_name }
          : {}),
        ...(args?.ttl_ms !== undefined ? { ttl_ms: args.ttl_ms } : {}),
        ...(args?.max_uses !== undefined ? { max_uses: args.max_uses } : {}),
      }),
    );

  const runDismiss = (row: ScopedGrantSuggestionRow): Promise<void> =>
    runResolution(row, () => opts.runDismissSuggestion({ key_hash: row.key_hash }));

  const broadcastUnsubscribers: Array<() => void> = [];
  const subscribe = opts.subscribe;
  if (subscribe) {
    const onSuggestionMutation = (): void => {
      if (disposed) return;
      void doRefresh();
    };
    for (const kind of SCOPED_GRANT_PANEL_BROADCAST_KINDS) {
      broadcastUnsubscribers.push(subscribe(kind, onSuggestionMutation));
    }
  }

  render();
  void doRefresh();

  return {
    getState: () => state.phase,
    getOpenSuggestions: () => state.suggestions,
    getListError: () => state.listError,
    refresh: () => doRefresh(),
    whenLoaded: () => pendingLoad,
    hasInFlightWork: () => pendingByKey.size > 0,
    acceptSuggestion: async (keyHash, args) => {
      const row = state.suggestions.find((s) => s.key_hash === keyHash);
      if (row === undefined) return;
      await runAccept(row, args);
    },
    dismissSuggestion: async (keyHash) => {
      const row = state.suggestions.find((s) => s.key_hash === keyHash);
      if (row === undefined) return;
      await runDismiss(row);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const unsubscribe of broadcastUnsubscribers) {
        try {
          unsubscribe();
        } catch {
          /* unsubscribe is best-effort */
        }
      }
      if (root.parentNode) root.parentNode.removeChild(root);
    },
  };
};
