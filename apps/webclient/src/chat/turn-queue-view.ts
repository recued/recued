import type { ChatTurnAcceptance, ChatTurnQueueSnapshot, ChatWithdrawnDraft } from '@recued/contracts';

export const CHAT_QUEUE_STYLES = `
[data-recued-chat-turn-queue] { display:grid; gap:8px; margin:8px 0; font-size:.875rem; }
[data-chat-queued-turn] { display:flex; align-items:center; flex-wrap:wrap; gap:6px 10px;
  padding:8px 12px; border:1px solid var(--border-subtle,#7775); border-radius:8px; min-width:0; }
[data-chat-queued-turn] > span:first-child { flex:1 1 220px; overflow-wrap:anywhere; }
[data-chat-turn-status="withdrawn"] > span { color:var(--fg-muted,#888); }
[data-recued-chat-turn-queue] button { width:fit-content; min-height:32px; padding:4px 10px;
  border:1px solid var(--border-subtle,#7775); border-radius:16px; background:transparent;
  color:inherit; font:inherit; cursor:pointer; }
[data-recued-chat-turn-queue] button:disabled { opacity:.6; cursor:wait; }
[data-recued-chat-turn-queue] [role="alert"] { margin:0; }
`;

export interface ChatQueueClient {
  (method: 'chat.turns.list', payload: { session_id: string }): Promise<ChatTurnQueueSnapshot>;
  (method: 'chat.turn.cancel', payload: { session_id: string; turn_id: string }): Promise<{ ok: true }>;
  (method: 'chat.turn.withdraw', payload: { session_id: string; turn_id: string }): Promise<ChatWithdrawnDraft>;
  (method: 'chat.turn.retry', payload: { session_id: string; turn_id: string; submission_id: string }): Promise<ChatTurnAcceptance>;
}

/** Queue snapshots are durable; events only invalidate them. Old servers can
 * omit this capability without breaking ordinary history or sending. */
export const createChatQueueView = (conn: ChatQueueClient, changed: () => void,
  restore?: (draft: ChatWithdrawnDraft) => Promise<boolean>,
  updated?: (session: string, snapshot: ChatTurnQueueSnapshot) => void) => {
  const snapshots = new Map<string, ChatTurnQueueSnapshot>();
  const loading = new Map<string, Promise<void>>();
  const dirty = new Set<string>();
  const attempts = new Map<string, string>();
  const errors = new Map<string, string>();
  const withdrawing = new Set<string>();
  let selected: string | null = null;
  let disposed = false;
  const refresh = async (session: string): Promise<void> => {
    if (disposed) return;
    if (loading.has(session)) { dirty.add(session); return loading.get(session); }
    const pending = (async () => {
    try {
      const snapshot = await conn('chat.turns.list', { session_id: session });
      if (disposed || !snapshot || !Array.isArray(snapshot.turns) || !Number.isSafeInteger(snapshot.revision)) return;
      if (snapshot.generation !== snapshots.get(session)?.generation || snapshot.revision >= (snapshots.get(session)?.revision ?? -1)) {
        snapshots.set(session, snapshot);
        updated?.(session, snapshot);
      }
    } catch { /* Old servers lack the queue RPC; sending remains compatible. */ }
    finally {
      loading.delete(session);
      if (!disposed && selected === session) changed();
      if (dirty.delete(session)) void refresh(session);
    }
    })();
    loading.set(session, pending);
    return pending;
  };
  const render = (doc: Document, session: string): HTMLElement | null => {
    if (selected !== session) { selected = session; void refresh(session); }
    const snapshot = snapshots.get(session);
    if (!snapshot || snapshot.turns.length === 0) return null;
    const root = doc.createElement('section');
    root.setAttribute('data-recued-chat-turn-queue', '');
    root.setAttribute('aria-label', 'Conversation queue');
    const pending = snapshot.turns.filter((turn) => ['queued', 'running', 'cancelling', 'withdrawn'].includes(turn.status) || turn.failure_reason === 'attachment_deleted');
    const latest = snapshot.turns[snapshot.turns.length - 1]!;
    const shown = pending.length > 0 ? pending : [latest];
    for (const turn of shown) {
      const row = doc.createElement('div');
      row.setAttribute('data-chat-queued-turn', turn.turn_id);
      row.setAttribute('data-chat-turn-status', turn.status);
      const text = doc.createElement('span');
      const labels = { queued: 'Queued', running: 'Working', cancelling: 'Stopping after the current operation',
        completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted by a restart', withdrawn: 'Withdrawn' };
      text.textContent = `${labels[turn.status]}: ${turn.message.slice(0, 160)}${turn.message.length > 160 ? '…' : ''}`;
      if (turn.failure_reason === 'attachment_deleted') text.textContent += ' — required attachment permanently deleted';
      row.appendChild(text);
      if (turn.duplicate_count > 0) {
        const duplicate = doc.createElement('span');
        duplicate.textContent = ` · ${turn.duplicate_count} repeated ${turn.duplicate_count === 1 ? 'message uses' : 'messages use'} this turn`;
        row.appendChild(duplicate);
      }
      if (turn.status === 'queued' || turn.status === 'running') {
        const cancel = doc.createElement('button');
        cancel.type = 'button'; cancel.textContent = turn.status === 'queued' ? 'Cancel queued message' : 'Stop turn';
        cancel.addEventListener('click', () => {
          cancel.disabled = true;
          void conn('chat.turn.cancel', { session_id: session, turn_id: turn.turn_id }).then(() => {
            errors.delete(session); return refresh(session);
          }).catch(() => { errors.set(session, 'Could not cancel this turn. Try again.'); changed(); });
        });
        row.appendChild(cancel);
      }
      if (restore && turn.withdraw_to_edit_available === true && (turn.status === 'queued' || turn.status === 'withdrawn')) {
        const withdraw = doc.createElement('button'); withdraw.type = 'button';
        withdraw.textContent = withdrawing.has(turn.turn_id) ? 'Confirming withdrawal…'
          : turn.status === 'withdrawn' ? 'Restore withdrawn draft' : 'Withdraw to edit';
        withdraw.setAttribute('data-chat-withdraw', turn.turn_id);
        withdraw.disabled = withdrawing.has(turn.turn_id);
        withdraw.addEventListener('click', () => {
          if (withdrawing.has(turn.turn_id)) return;
          withdrawing.add(turn.turn_id); changed();
          void (async () => {
            try {
              const draft = await conn('chat.turn.withdraw', { session_id: session, turn_id: turn.turn_id });
              if (disposed) return;
              if (draft.turn_id !== turn.turn_id || draft.session_id !== session) throw new Error('Mismatched withdrawal');
              const restored = await restore(draft);
              if (restored) errors.delete(session);
              else errors.set(session, 'Message withdrawn. Send or clear your current draft, then restore it in this conversation.');
            } catch {
              if (!disposed) errors.set(session, 'Could not confirm withdrawal. Only queued messages can be withdrawn. Refresh or try again; your draft has not changed.');
            } finally {
              withdrawing.delete(turn.turn_id);
              if (!disposed) await refresh(session);
            }
          })();
        });
        row.appendChild(withdraw);
      }
      root.appendChild(row);
    }
    const repeat = doc.createElement('button');
    repeat.type = 'button'; repeat.textContent = 'Run last message again';
    repeat.addEventListener('click', () => {
      repeat.disabled = true;
      const submission_id = attempts.get(latest.turn_id) ?? crypto.randomUUID();
      attempts.set(latest.turn_id, submission_id);
      void conn('chat.turn.retry', { session_id: session, turn_id: latest.turn_id, submission_id }).then(() => {
        attempts.delete(latest.turn_id); errors.delete(session); return refresh(session);
      }).catch(() => { errors.set(session, 'Could not confirm the new attempt. Try again.'); changed(); });
    });
    if (latest.status !== 'withdrawn') root.appendChild(repeat);
    if (errors.has(session)) {
      const error = doc.createElement('p'); error.setAttribute('role', 'alert');
      error.textContent = errors.get(session)!; root.appendChild(error);
    }
    return root;
  };
  return { render, refresh,
    generation: async (session: string): Promise<string | undefined> => {
      if (!snapshots.has(session)) await refresh(session);
      return snapshots.get(session)?.generation;
    },
    dispose: () => { disposed = true; } };
};
