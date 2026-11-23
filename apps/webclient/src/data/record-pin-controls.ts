import { e } from '@recued/ui-shared';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';
import { recentRecordNoun, type RecentWorkRecord } from './recent-work-records.js';
import { PINNED_RECORD_LIMIT, pinnedRecordIdentity, type PinnedRecords } from './pinned-records.js';

export const RECORD_PIN_ACTION = 'record-pin-toggle';
export const RECORD_PIN_KEY = 'data-record-pin-key';
export interface RecordPinCandidate {
  kind: RecentWorkRecord['kind']; id: string; title: string;
  identity?: string;
  read: () => Promise<RecentWorkRecord>;
}
/** The route registers only currently visible, known records. Search hits must
 * resolve to a fresh canonical reference before they can become a shortcut. */
export const createRecordPinControls = (deps: {
  pins?: PinnedRecords; scope: () => string | null; blocked: () => boolean; changed: () => void;
}) => {
  let candidates = new Map<string, RecordPinCandidate>();
  let scope: string | null = null;
  let operation: { scope: string; key: string } | null = null;
  let notice: { key: string; error: boolean; text: string } | null = null;
  let saved: readonly RecentWorkRecord[] = [];
  const contains = (candidate: RecordPinCandidate, rows: readonly RecentWorkRecord[]) => rows.some(row => row.kind === candidate.kind && row.id === candidate.id
    && (candidate.identity === undefined || candidate.identity === pinnedRecordIdentity(row)));
  const current = () => {
    const next = deps.scope();
    if (next !== scope) { scope = next; operation = null; notice = null; candidates.clear(); }
    return next;
  };
  const toggle = async (key: string | null): Promise<void> => {
    const active = current(), candidate = key ? candidates.get(key) : undefined;
    if (!deps.pins || active === null || !candidate || !key || operation || deps.blocked()) return;
    if (contains(candidate, deps.pins.list())) {
      const ok = deps.pins.remove(candidate.kind, candidate.id);
      notice = { key, error: !ok, text: ok ? 'Unpinned.' : 'Could not remove this pin. Try again.' }; deps.changed(); return;
    }
    const op = { scope: active, key }; operation = op; notice = null; deps.changed();
    const alive = () => operation === op && deps.scope() === op.scope && candidates.has(key);
    try {
      const record = await candidate.read();
      if (!alive() || deps.blocked()) return;
      if (record.kind !== candidate.kind || record.id !== candidate.id) throw new Error('This record changed identity. Open it to review it before pinning.');
      const full = deps.pins.list().length >= PINNED_RECORD_LIMIT, ok = deps.pins.pin(record);
      notice = { key, error: !ok, text: ok ? 'Pinned in universal search.' : full
        ? `You can pin up to ${PINNED_RECORD_LIMIT} records. Unpin one to make room.` : 'Could not save this pin. Try again.' };
    } catch (error) {
      if (alive()) notice = { key, error: true, text: humanizeRpcError(error).replace('Your draft is still here.', 'The record was not pinned.') };
    } finally { if (operation === op) { operation = null; if (deps.scope() === op.scope) deps.changed(); } }
  };
  return {
    toggle,
    begin() { current(); saved = deps.pins?.list() ?? []; candidates = new Map(); },
    mount(host: HTMLElement | null, candidate: RecordPinCandidate, actionAttr: string) {
      if (!host || !deps.pins || current() === null || !host.insertAdjacentHTML) return;
      const key = JSON.stringify([candidate.kind, candidate.id]); candidates.set(key, candidate);
      const pinned = contains(candidate, saved), busy = operation?.key === key;
      host.insertAdjacentHTML('beforeend', `<button type="button" class="data-button rq-record-pin" ${actionAttr}="${RECORD_PIN_ACTION}" ${RECORD_PIN_KEY}="${e(key)}" aria-pressed="${pinned}" aria-label="${e(`${pinned ? 'Unpin' : 'Pin'} ${recentRecordNoun(candidate.kind)} ${candidate.title}`)}"${operation || deps.blocked() ? ' aria-disabled="true"' : ''}${busy ? ' aria-busy="true"' : ''}>${busy ? 'Pinning…' : pinned ? 'Unpin' : 'Pin'}</button>${notice?.key === key ? `<span class="rq-record-pin-notice" role="${notice.error ? 'alert' : 'status'}">${e(notice.text)}</span>` : ''}`);
      if (host.classList.contains('rq-row')) host.classList.add('rq-pinnable');
    },
    captureFocus(active: Element | null) {
      const key = active?.getAttribute(RECORD_PIN_KEY); return key ? { key, scope: deps.scope() } : null;
    },
    restoreFocus(root: HTMLElement, previous: { key: string; scope: string | null } | null) {
      if (previous && previous.scope === deps.scope()) [...root.querySelectorAll<HTMLElement>(`[${RECORD_PIN_KEY}]`)]
        .find(node => node.getAttribute(RECORD_PIN_KEY) === previous.key)?.focus({ preventScroll: true });
    },
    reset() { candidates.clear(); scope = null; operation = null; notice = null; },
  };
};
