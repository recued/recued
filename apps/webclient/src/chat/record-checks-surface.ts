import type { PreparedRecordLink } from '../data/record-link-insert.js';
import type { RecordLinkShortcutReaders } from '../data/record-link-shortcuts.js';
import { verifySelectedRecord } from './selected-records.js';
import { createRecordChecks, type RecordCheckOwner } from './record-checks.js';
import { renderActionLabel } from '@recued/ui-shared';

interface DraftSnapshot {
  owner: RecordCheckOwner; value: string; start: number; end: number; direction: 'forward' | 'backward' | 'none'; top: number; left: number;
}
interface Entry { key: string; chip: HTMLElement; copy: HTMLElement; remove: HTMLButtonElement; recheck?: HTMLButtonElement; message?: HTMLElement }
interface FocusSnapshot { draft: DraftSnapshot; hash?: string; control?: 'recheck' | 'remove' | 'cancel'; checkId?: number; top: number }
const RECHECK = 'data-chat-record-recheck', STATUS = 'data-chat-record-check-state';

/** Enhance the existing chips without rebuilding the composer on a read.
 * DOM controls only address registered selections; they cannot supply a record. */
export const createRecordChecksSurface = (deps: {
  root: HTMLElement; document: Document; owner: () => RecordCheckOwner | null;
  records: () => readonly PreparedRecordLink[]; readers: RecordLinkShortcutReaders; href: () => string;
  blocked: () => boolean; input: () => HTMLTextAreaElement | null; send: () => HTMLButtonElement | null; changed: () => void;
}) => {
  let disposed = false, entries = new Map<string, Entry>(), summary: HTMLElement | null = null, messageId = 0;
  let controls: HTMLElement | null = null, cancelButton: HTMLButtonElement | null = null, cancelId: number | null = null, cancelledOwner: RecordCheckOwner | null = null;
  const sendLabels = new WeakMap<HTMLButtonElement, { html: string; busy: string | null }>();
  const sameOwner = (owner: RecordCheckOwner) => { const current = deps.owner(); return current?.key === owner.key && current.scope === owner.scope; };
  const group = () => deps.root.querySelector<HTMLElement>('[data-chat-selected-records]');
  const captureDraft = (): DraftSnapshot | null => {
    const owner = deps.owner(), input = deps.input();
    return owner && input ? { owner, value: input.value, start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection, top: input.scrollTop, left: input.scrollLeft } : null;
  };
  const restoreDraft = (saved: DraftSnapshot | null) => {
    const input = deps.input();
    if (!saved || disposed || !sameOwner(saved.owner) || !input?.isConnected || input.value !== saved.value) return;
    input.setSelectionRange(saved.start, saved.end, saved.direction); input.scrollTop = saved.top; input.scrollLeft = saved.left;
  };
  const restoreComposer = () => { const saved = captureDraft(); deps.input()?.focus({ preventScroll: true }); restoreDraft(saved); };
  const removeCancel = (restoreFocus: boolean) => {
    if (restoreFocus && cancelButton && deps.document.activeElement === cancelButton) restoreComposer();
    cancelButton?.remove(); cancelButton = null; cancelId = null;
  };
  const checkingLabel = (checking: boolean) => {
    const send = deps.send(); if (!send) return;
    const original = sendLabels.get(send);
    if (checking && !original) {
      sendLabels.set(send, { html: send.innerHTML, busy: send.getAttribute('aria-busy') });
      send.innerHTML = renderActionLabel('send', 'Checking…'); send.setAttribute('aria-busy', 'true');
    } else if (!checking && original) {
      send.innerHTML = original.html; sendLabels.delete(send);
      if (original.busy === null) send.removeAttribute('aria-busy'); else send.setAttribute('aria-busy', original.busy);
    }
  };
  const model = createRecordChecks({
    ...deps, verify: record => verifySelectedRecord(record, deps.readers, deps.href()),
    changed: () => { if (!disposed) { paint(); deps.changed(); } },
  });
  const paint = () => {
    if (disposed) return;
    const rows = model.rows(), progress = model.progress(), host = group();
    checkingLabel(!!progress);
    if (!host) { removeCancel(false); summary = null; controls = null; return; }
    if (!controls?.isConnected || controls.parentElement !== host) {
      removeCancel(false); controls = deps.document.createElement('div'); controls.className = 'chat-record-check-controls';
      summary = deps.document.createElement('p'); summary.className = 'chat-record-check-summary';
      summary.setAttribute('data-chat-record-check-summary', ''); summary.setAttribute('role', 'status'); controls.appendChild(summary); host.prepend(controls);
    }
    if (progress) cancelledOwner = null;
    const cancelled = cancelledOwner !== null && sameOwner(cancelledOwner), issues = rows.filter(row => row.state === 'error' || row.state === 'missing').length;
    summary!.textContent = progress ? 'Checking records… ' + progress.completed + ' of ' + progress.total + ' checked.'
      : (cancelled ? 'Check cancelled. ' : '') + (issues ? issues + (issues === 1 ? ' record needs attention. ' : ' records need attention. ') + 'Recheck or remove the highlighted records before sending.'
        : cancelled ? 'Your draft is unchanged. Choose Send when you are ready.'
          : rows.some(row => row.state === 'ready') ? deps.blocked() ? 'Records checked.' : 'Records checked. Choose Send when you are ready.' : '');
    summary!.hidden = !summary!.textContent; controls.hidden = !summary!.textContent;
    if (progress && cancelId !== progress.id) {
      removeCancel(false);
      const owner = deps.owner(), button = deps.document.createElement('button');
      button.type = 'button'; button.textContent = 'Cancel check'; button.setAttribute('data-chat-record-check-cancel', '');
      button.addEventListener('click', () => {
        if (disposed || !owner || !sameOwner(owner) || cancelButton !== button || !button.isConnected || model.progress()?.id !== progress.id) return;
        button.focus({ preventScroll: true }); const saved = captureDraft(); cancelledOwner = owner;
        if (model.cancelPending(progress.id)) { deps.input()?.focus({ preventScroll: true }); restoreDraft(saved); }
      });
      cancelButton = button; cancelId = progress.id; controls.appendChild(button);
    } else if (!progress) removeCancel(true);
    for (const row of rows) {
      const hash = row.record.reference.target.hash, entry = entries.get(hash);
      if (!entry || entry.key !== row.key || !entry.chip.isConnected) continue;
      const needsControl = row.state && row.state !== 'ready';
      if (!needsControl) {
        if (entry.recheck && deps.document.activeElement === entry.recheck) entry.remove.focus({ preventScroll: true });
        entry.recheck?.remove(); entry.message?.remove(); entry.recheck = undefined; entry.message = undefined;
        entry.chip.removeAttribute(STATUS); continue;
      }
      entry.chip.setAttribute(STATUS, row.state!);
      if (!entry.message) {
        entry.message = deps.document.createElement('p'); entry.message.className = 'chat-record-check-message';
        entry.message.id = 'chat-record-check-' + ++messageId; entry.message.setAttribute('data-chat-record-check-message', ''); entry.copy.appendChild(entry.message);
      }
      entry.message.textContent = row.state === 'checking' ? 'Checking this record…'
        : row.state === 'missing' ? 'This record was removed or replaced. Remove it and choose it again before sending.'
          : 'This record could not be checked. Recheck it or remove it before sending.';
      if (!entry.recheck) {
        entry.recheck = deps.document.createElement('button'); entry.recheck.type = 'button'; entry.recheck.textContent = 'Recheck';
        entry.recheck.setAttribute(RECHECK, hash); entry.recheck.setAttribute('aria-label', 'Recheck ' + row.record.reference.title);
        entry.recheck.setAttribute('aria-describedby', entry.message.id); entry.chip.insertBefore(entry.recheck, entry.remove);
      }
      const hadFocus = deps.document.activeElement === entry.recheck;
      entry.recheck.disabled = deps.blocked() || row.state === 'checking'; entry.recheck.setAttribute('aria-busy', String(row.state === 'checking'));
      if (hadFocus && row.state === 'checking' && !entry.remove.disabled) entry.remove.focus({ preventScroll: true });
    }
  };
  const onClick = (event: Event) => {
    const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('[' + RECHECK + ']');
    const hash = button?.getAttribute(RECHECK), entry = hash ? entries.get(hash) : undefined, owner = deps.owner();
    if (!button || button.disabled || !hash || !entry || entry.recheck !== button || !button.isConnected || !deps.root.contains(button) || !owner || deps.blocked()) return;
    event.preventDefault(); event.stopPropagation(); button.focus({ preventScroll: true });
    void model.recheck(entry.key).then(current => {
      const latest = entries.get(hash), active = deps.document.activeElement;
      if (!current || disposed || !sameOwner(owner) || latest?.key !== entry.key || !latest.chip.isConnected) return;
      if (active === entry.remove || active === button || active === latest.remove || active === latest.recheck)
        (latest.recheck ?? latest.remove).focus({ preventScroll: true });
    });
  };
  deps.root.addEventListener('click', onClick);
  return {
    hasPending: model.hasPending, checkAll: model.checkAll, captureDraft, restoreDraft,
    cancel() { cancelledOwner = null; model.cancel(); },
    ownsFocus: () => !!deps.document.activeElement && (deps.document.activeElement === deps.input() || deps.document.activeElement === deps.send()),
    focusFirstIssue(owner: RecordCheckOwner) {
      if (disposed || !sameOwner(owner)) return;
      const row = model.rows().find(row => row.state === 'error' || row.state === 'missing'), entry = row ? entries.get(row.record.reference.target.hash) : undefined;
      if (!entry?.recheck || entry.recheck.disabled) return;
      entry.chip.scrollIntoView({ block: 'nearest', inline: 'nearest' }); entry.recheck.focus({ preventScroll: true });
    },
    mount() {
      if (disposed) return;
      entries = new Map();
      const chips = Array.from(deps.root.querySelectorAll<HTMLElement>('.chat-record-chip'));
      for (const row of model.rows()) {
        const hash = row.record.reference.target.hash, chip = chips.find(node => node.querySelector<HTMLButtonElement>('[data-chat-record-remove]')?.getAttribute('data-chat-record-remove') === hash);
        const remove = chip?.querySelector<HTMLButtonElement>('[data-chat-record-remove]'), link = chip?.querySelector<HTMLAnchorElement>('a'), copy = link?.parentElement;
        if (!chip || !remove || link?.getAttribute('href') !== hash || !copy) continue;
        entries.set(hash, { key: row.key, chip, copy, remove,
          recheck: chip.querySelector<HTMLButtonElement>('[' + RECHECK + ']') ?? undefined,
          message: chip.querySelector<HTMLElement>('[data-chat-record-check-message]') ?? undefined });
      }
      paint();
    },
    captureFocus(): FocusSnapshot | null {
      const draft = captureDraft(); if (!draft || !model.rows().length) return null;
      const active = deps.document.activeElement;
      if (active === cancelButton && cancelId !== null) return { draft, control: 'cancel', checkId: cancelId, top: group()?.scrollTop ?? 0 };
      for (const [hash, entry] of entries) if (active === entry.recheck || active === entry.remove)
        return { draft, hash, control: active === entry.recheck ? 'recheck' : 'remove', top: group()?.scrollTop ?? 0 };
      return { draft, top: group()?.scrollTop ?? 0 };
    },
    restoreFocus(saved: FocusSnapshot | null) {
      if (!saved || !sameOwner(saved.draft.owner)) return;
      restoreDraft(saved.draft);
      const host = group(); if (host) host.scrollTop = saved.top;
      const active = deps.document.activeElement, entry = saved.hash ? entries.get(saved.hash) : undefined;
      if (saved.control === 'cancel' && saved.checkId === cancelId && cancelButton && (!active || active === deps.document.body || !active.isConnected)) {
        cancelButton.focus({ preventScroll: true }); return;
      }
      if (saved.control && entry && (!active || active === deps.document.body || !active.isConnected))
        (saved.control === 'recheck' ? entry.recheck ?? entry.remove : entry.remove).focus({ preventScroll: true });
    },
    dispose() { disposed = true; model.dispose(); removeCancel(false); checkingLabel(false); entries.clear(); summary = null; controls = null; cancelledOwner = null; deps.root.removeEventListener?.('click', onClick); },
  };
};

export const RECORD_CHECK_STYLES = `
.chat-record-check-controls { display:flex; flex-basis:100%; flex-wrap:wrap; align-items:center; gap:.5rem; }
.chat-record-check-controls[hidden] { display:none; }
.chat-record-check-summary { flex:1 1 12rem; margin:0; font-size:.85rem; }
.chat-record-check-controls button { min-height:44px; padding:.5rem .75rem; border:1px solid var(--border); border-radius:6px; color:var(--fg); background:var(--surface); font:inherit; cursor:pointer; }
.chat-record-chip[data-chat-record-check-state="missing"], .chat-record-chip[data-chat-record-check-state="error"] { border-color:var(--danger,#b3261e); }
.chat-record-chip .chat-record-check-message { color:var(--danger,#b3261e); }
.chat-record-chip[data-chat-record-check-state="checking"] .chat-record-check-message { color:var(--muted); }
.chat-record-chip [data-chat-record-recheck] { min-height:44px; }
@media (max-width:600px) {
  .chat-record-chip[data-chat-record-check-state] { flex-wrap:wrap; }
  .chat-record-chip[data-chat-record-check-state] > div { flex-basis:100%; }
}
`;
