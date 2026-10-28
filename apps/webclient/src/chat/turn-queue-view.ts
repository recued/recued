import type { ChatQueuedTurn, ChatTurnAcceptance, ChatTurnQueueSnapshot, ChatWithdrawnDraft } from '@recued/contracts';
import { readAssetChatMessage } from './asset-context.js';

export const CHAT_QUEUE_STYLES = `
[data-recued-chat-turn-queue] { display:grid; gap:8px; margin:8px 0; font-size:.875rem; }
[data-chat-queued-turn] { display:flex; align-items:center; flex-wrap:wrap; gap:6px 10px;
  padding:8px 12px; border:1px solid var(--border-subtle,#7775); border-radius:8px; min-width:0; }
[data-chat-queued-turn] > span:first-child { flex:1 1 220px; overflow-wrap:anywhere; }
[data-chat-turn-status="withdrawn"] > span { color:var(--fg-muted,#888); }
[data-recued-chat-turn-queue] button { width:fit-content; min-height:32px; padding:4px 10px;
  border:1px solid var(--border-subtle,#7775); border-radius:16px; background:transparent;
  color:inherit; font:inherit; cursor:pointer; }
[data-recued-chat-turn-queue] button:disabled,
[data-recued-chat-turn-queue] button[aria-disabled="true"] { opacity:.6; cursor:wait; }
[data-recued-chat-turn-queue] [role="alert"] { margin:0; }
`;

export interface ChatQueueClient {
  (method: 'chat.turns.list', payload: { session_id: string }): Promise<ChatTurnQueueSnapshot>;
  (method: 'chat.turn.cancel', payload: { session_id: string; turn_id: string }): Promise<{ ok: true }>;
  (method: 'chat.turn.withdraw', payload: { session_id: string; turn_id: string }): Promise<ChatWithdrawnDraft>;
  (method: 'chat.turn.retry', payload: { session_id: string; turn_id: string; submission_id: string }): Promise<ChatTurnAcceptance>;
}

type QueueAction = 'cancel' | 'retry' | 'withdraw';
interface QueueFocus {
  readonly element: HTMLElement;
  readonly session: string;
  readonly turn: string | null;
  readonly control: string | null;
}
const pendingTurn = (turn: ChatQueuedTurn): boolean =>
  ['queued', 'running', 'cancelling', 'withdrawn'].includes(turn.status) || turn.failure_reason === 'attachment_deleted';
const needsRetry = (turn: ChatQueuedTurn): boolean =>
  ['failed', 'cancelled', 'interrupted'].includes(turn.status) || (turn.status === 'completed' && turn.duplicate_count > 0);

/** Queue snapshots are durable; events only invalidate them. Old servers can
 * omit this capability without breaking ordinary history or sending. */
export const createChatQueueView = (conn: ChatQueueClient, changed: () => void,
  restore?: (draft: ChatWithdrawnDraft, current: () => boolean) => Promise<boolean>,
  updated?: (session: string, snapshot: ChatTurnQueueSnapshot) => void) => {
  const snapshots = new Map<string, ChatTurnQueueSnapshot>();
  const loading = new Map<string, Promise<boolean>>();
  const dirty = new Set<string>();
  const attempts = new Map<string, string>();
  const errors = new Map<string, { key: string; message: string }>();
  const actions = new Map<string, QueueAction>();
  let selected: string | null = null;
  let disposed = false;
  const refresh = (session: string): Promise<boolean> => {
    if (disposed) return Promise.resolve(false);
    const existing = loading.get(session);
    if (existing) { dirty.add(session); return existing; }
    // An action may finish during a read started before it. Its caller waits
    // for the invalidated read as well, so that older reply cannot unlock it.
    const pending = Promise.resolve().then(async () => {
      let available = false;
      try {
        do {
          dirty.delete(session);
          available = false;
          try {
            const snapshot = await conn('chat.turns.list', { session_id: session });
            if (disposed) break;
            if (snapshot && Array.isArray(snapshot.turns) && Number.isSafeInteger(snapshot.revision)
              && typeof snapshot.generation === 'string'
              && (snapshot.generation !== snapshots.get(session)?.generation
                || snapshot.revision >= (snapshots.get(session)?.revision ?? -1))) {
              if (snapshots.get(session)?.generation !== snapshot.generation) errors.delete(session);
              snapshots.set(session, snapshot);
              available = true;
              updated?.(session, snapshot);
            }
          } catch { /* Old servers lack the queue RPC; sending remains compatible. */ }
          if (!disposed && selected === session) changed();
        } while (!disposed && dirty.has(session));
        return available;
      } finally {
        loading.delete(session);
      }
    });
    loading.set(session, pending);
    return pending;
  };
  const actionKey = (session: string, generation: string, turn: string): string => JSON.stringify([session, generation, turn]);
  const notify = (session: string): void => { if (!disposed && selected === session) changed(); };
  const act = (session: string, generation: string, turnId: string, kind: QueueAction,
    perform: (key: string) => Promise<{ warning?: string; retryTurn?: string; statusAvailable?: boolean } | undefined>, failure: string): void => {
    const snapshot = snapshots.get(session);
    const turn = snapshot?.turns.find(candidate => candidate.turn_id === turnId);
    const key = actionKey(session, generation, turnId);
    if (disposed || snapshot?.generation !== generation || !turn || actions.has(key)) return;
    if (kind === 'cancel' && !['queued', 'running'].includes(turn.status)
      || kind === 'withdraw' && (!turn.withdraw_to_edit_available || !['queued', 'withdrawn'].includes(turn.status))
      || kind === 'retry' && (snapshot.turns.at(-1)?.turn_id !== turnId || !needsRetry(turn) || snapshot.turns.some(pendingTurn))) return;
    actions.set(key, kind);
    if (errors.get(session)?.key === key) errors.delete(session);
    notify(session);
    const current = (): boolean => !disposed && snapshots.get(session)?.generation === generation;
    void (async () => {
      try {
        const result = await perform(key);
        if (!current()) return;
        const available = result?.statusAvailable ?? await refresh(session);
        if (!current()) return;
        if (available && result?.retryTurn && snapshots.get(session)?.turns.some(candidate => candidate.turn_id === result.retryTurn)) {
          attempts.delete(key);
        }
        const warning = result?.warning ?? (available ? undefined
          : 'The request was accepted, but Recued could not refresh this turn’s status. Try again to check it.');
        if (warning) errors.set(session, { key, message: warning });
      } catch {
        // A lost acknowledgement may also lose the invalidation event. Read
        // the durable outcome before offering another action on an old row.
        if (current()) {
          await refresh(session);
          if (current()) errors.set(session, { key, message: failure });
        }
      } finally {
        actions.delete(key);
        if (current()) notify(session);
      }
    })();
  };
  const control = (button: HTMLButtonElement, key: string, kind: QueueAction): void => {
    button.type = 'button';
    button.setAttribute('data-chat-queue-control', `${kind}:${key}`);
    // aria-disabled keeps keyboard focus on the progress label. The action
    // guard also rejects synthetic and repeated activation across redraws.
    if (actions.has(key)) button.setAttribute('aria-disabled', 'true');
    if (actions.get(key) === kind) button.setAttribute('aria-busy', 'true');
  };
  const render = (doc: Document, session: string): HTMLElement | null => {
    if (selected !== session) { selected = session; void refresh(session); }
    const snapshot = snapshots.get(session);
    if (!snapshot || snapshot.turns.length === 0) return null;
    const root = doc.createElement('section');
    root.setAttribute('data-recued-chat-turn-queue', '');
    root.setAttribute('data-chat-queue-session', session);
    root.setAttribute('aria-label', 'Conversation queue');
    const pending = snapshot.turns.filter(pendingTurn);
    const latest = snapshot.turns[snapshot.turns.length - 1]!;
    // ⛔ A turn that simply finished is not news: its answer is in the
    // conversation. This strip echoed it after every reply ("Completed: …",
    // with "Run last message again" beside it), two rows the owner could not
    // place, which also pushed Send below the window. The latest turn is shown
    // only when it asks for something: it did not finish, or a repeated
    // message was folded into it — D-265 runs A/A once, so running it again is
    // the one way to get a second answer to the same words.
    const shown = pending.length > 0 ? pending : needsRetry(latest) ? [latest] : [];
    if (shown.length === 0 && !errors.has(session)) return null;
    for (const turn of shown) {
      const key = actionKey(session, snapshot.generation, turn.turn_id);
      const row = doc.createElement('div');
      row.setAttribute('data-chat-queued-turn', turn.turn_id);
      row.setAttribute('data-chat-turn-status', turn.status);
      const text = doc.createElement('span');
      const labels = { queued: 'Queued', running: 'Working', cancelling: 'Stopping after the current operation',
        completed: 'Already answered', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted by a restart', withdrawn: 'Withdrawn' };
      const preview = readAssetChatMessage(turn.message)?.question ?? turn.message;
      text.textContent = `${labels[turn.status]}: ${preview.slice(0, 160)}${preview.length > 160 ? '…' : ''}`;
      if (turn.failure_reason === 'attachment_deleted') text.textContent += ' — required attachment permanently deleted';
      row.appendChild(text);
      if (turn.duplicate_count > 0) {
        const duplicate = doc.createElement('span');
        duplicate.textContent = ` · ${turn.duplicate_count} repeated ${turn.duplicate_count === 1 ? 'message uses' : 'messages use'} this turn`;
        row.appendChild(duplicate);
      }
      if (turn.status === 'queued' || turn.status === 'running') {
        const cancel = doc.createElement('button');
        control(cancel, key, 'cancel');
        cancel.textContent = actions.get(key) === 'cancel' ? turn.status === 'queued' ? 'Cancelling…' : 'Stopping…'
          : turn.status === 'queued' ? 'Cancel queued message' : 'Stop turn';
        cancel.addEventListener('click', () => act(session, snapshot.generation, turn.turn_id, 'cancel', async () => {
          await conn('chat.turn.cancel', { session_id: session, turn_id: turn.turn_id });
          return undefined;
        }, 'Could not confirm cancellation. Check the current turn status before trying again.'));
        row.appendChild(cancel);
      }
      if (restore && turn.withdraw_to_edit_available === true && (turn.status === 'queued' || turn.status === 'withdrawn')) {
        const withdraw = doc.createElement('button');
        control(withdraw, key, 'withdraw');
        withdraw.textContent = actions.get(key) === 'withdraw' ? 'Confirming withdrawal…'
          : turn.status === 'withdrawn' ? 'Restore withdrawn draft' : 'Withdraw to edit';
        withdraw.setAttribute('data-chat-withdraw', turn.turn_id);
        withdraw.addEventListener('click', () => act(session, snapshot.generation, turn.turn_id, 'withdraw', async () => {
          const draft = await conn('chat.turn.withdraw', { session_id: session, turn_id: turn.turn_id });
          const current = (): boolean => !disposed && snapshots.get(session)?.generation === snapshot.generation;
          if (!current()) return undefined;
          if (draft.turn_id !== turn.turn_id || draft.session_id !== session) throw new Error('Mismatched withdrawal');
          // Check the canonical generation before applying the draft, then
          // let asynchronous quote resolution recheck it at the write boundary.
          const statusAvailable = await refresh(session);
          if (!current() || !statusAvailable) return { statusAvailable };
          return {
            statusAvailable,
            warning: await restore(draft, current) ? undefined
              : 'Message withdrawn. Send or clear your current draft, then restore it in this conversation.',
          };
        }, 'Could not confirm withdrawal. Only queued messages can be withdrawn. Refresh or try again; your draft has not changed.'));
        row.appendChild(withdraw);
      }
      root.appendChild(row);
    }
    const repeat = doc.createElement('button');
    // Named for what it does to THIS turn: one that did not finish is tried
    // again; one already answered is run a second time.
    const key = actionKey(session, snapshot.generation, latest.turn_id);
    control(repeat, key, 'retry');
    repeat.textContent = actions.get(key) === 'retry' ? 'Trying again…' : latest.status === 'completed' ? 'Run it again' : 'Try again';
    repeat.addEventListener('click', () => act(session, snapshot.generation, latest.turn_id, 'retry', async key => {
      const submission_id = attempts.get(key) ?? crypto.randomUUID();
      attempts.set(key, submission_id);
      const accepted = await conn('chat.turn.retry', { session_id: session, turn_id: latest.turn_id, submission_id });
      return { retryTurn: accepted.turn_id };
    }, 'Could not confirm the new attempt. Try again.'));
    // Not while anything is pending: a second run of the message being worked
    // on would only queue behind it.
    if (pending.length === 0 && shown.length > 0) root.appendChild(repeat);
    if (errors.has(session)) {
      const error = doc.createElement('p'); error.setAttribute('role', 'alert');
      error.textContent = errors.get(session)!.message; root.appendChild(error);
    }
    return root;
  };
  const captureFocus = (doc: Document, host: HTMLElement): QueueFocus | null => {
    const element = doc.activeElement as HTMLElement | null;
    if (!element || !host.contains?.(element)) return null;
    const session = element?.closest?.('[data-chat-queue-session]')?.getAttribute('data-chat-queue-session');
    return element && session ? { element, session, control: element.getAttribute('data-chat-queue-control'),
      turn: element.closest?.('[data-chat-queued-turn]')?.getAttribute('data-chat-queued-turn') ?? null } : null;
  };
  const restoreFocus = (doc: Document, host: HTMLElement, saved: QueueFocus | null, fallback: () => void): void => {
    if (!saved || disposed || selected !== saved.session) return;
    const active = doc.activeElement;
    if (active && active !== saved.element && active !== doc.body && active.isConnected) return;
    const root = Array.from(host.querySelectorAll?.<HTMLElement>('[data-chat-queue-session]') ?? [])
      .find(candidate => candidate.getAttribute('data-chat-queue-session') === saved.session);
    const button = saved.control ? Array.from(root?.querySelectorAll<HTMLElement>('[data-chat-queue-control]') ?? [])
      .find(candidate => candidate.getAttribute('data-chat-queue-control') === saved.control) : undefined;
    if (button) { button.focus({ preventScroll: true }); return; }
    const row = saved.turn ? Array.from(root?.querySelectorAll<HTMLElement>('[data-chat-queued-turn]') ?? [])
      .find(candidate => candidate.getAttribute('data-chat-queued-turn') === saved.turn) : undefined;
    const target = row ?? root;
    if (target) { target.setAttribute('tabindex', '-1'); target.focus({ preventScroll: true }); }
    else fallback();
  };
  return { render, refresh, captureFocus, restoreFocus,
    generation: async (session: string): Promise<string | undefined> => {
      // A consumer of the pending read does not invalidate it. Re-requesting
      // here made first Send wait for a second whole-queue read.
      if (!snapshots.has(session)) await (loading.get(session) ?? refresh(session));
      return snapshots.get(session)?.generation;
    },
    dispose: () => { disposed = true; } };
};
