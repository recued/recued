import { createRecordResultPreview, previewResultHtml, readRecordResultPreview, type RecordResultPreviewView } from '../data/record-result-preview.js';
import type { PreparedRecordLink, LinkOption } from '../data/record-link-insert.js';
import type { RecordLinkShortcutReaders } from '../data/record-link-shortcuts.js';
import { verifySelectedRecord } from './selected-records.js';

export const CHAT_RECORD_PREVIEW_ATTR = 'data-chat-record-preview';
const FOCUS = 'data-chat-record-preview-focus', ACTION = 'data-chat-record-preview-action';
interface Entry { option: LinkOption; trigger: HTMLButtonElement; link: HTMLAnchorElement; remove: HTMLButtonElement }
interface Snapshot {
  owner: string; key: string; value?: string; start?: number; end?: number; direction?: 'forward' | 'backward' | 'none';
  scrolls: Map<string, { top: number; left: number }>;
}
interface Focus { owner: string; key: string; control: string; top: number }

/** A draft's selected references authorize the explicit preview. Neither DOM
 * attributes nor preview contents become a new selection or Chat message. */
export const createChatRecordPreview = (deps: {
  root: HTMLElement; document: Document; owner: () => string | null; records: () => readonly PreparedRecordLink[];
  readers: RecordLinkShortcutReaders; href: () => string; blocked: () => boolean;
  input: () => HTMLTextAreaElement | null; scrollHosts: () => ReadonlyMap<string, HTMLElement>;
}) => {
  let entries = new Map<string, Entry>(), dialog: HTMLDialogElement | null = null, saved: Snapshot | null = null;
  const supported = typeof deps.document.createElement?.('dialog')?.showModal === 'function';
  let disposed = false, lastFocus = 'preview-title', dialogTop = 0;
  const hosts = () => { const nodes = new Map(deps.scrollHosts()), input = deps.input(); if (input) nodes.set('input', input); return nodes; };
  const restoreDraft = (snapshot: Snapshot | null) => {
    if (!snapshot || disposed || deps.owner() !== snapshot.owner) return;
    const input = deps.input(), sameText = input?.value === snapshot.value;
    if (input && sameText && snapshot.start !== undefined && snapshot.end !== undefined) input.setSelectionRange(snapshot.start, snapshot.end, snapshot.direction);
    for (const [key, node] of hosts()) {
      const at = snapshot.scrolls.get(key); if (!at || key === 'input' && !sameText) continue;
      node.scrollTop = at.top; node.scrollLeft = at.left;
    }
  };
  const removeDialog = () => {
    const old = dialog; dialog = null;
    if (old) { try { if (old.open) old.close(); } catch { /* Teardown may already have closed it. */ } old.remove(); }
  };
  const close = (restore = true) => {
    const snapshot = saved; saved = null; model.close(); removeDialog();
    if (restore && snapshot && deps.owner() === snapshot.owner) {
      entries.get(snapshot.key)?.trigger.focus({ preventScroll: true }); restoreDraft(snapshot);
    }
  };
  const model = createRecordResultPreview({ owner: deps.owner, blocked: deps.blocked,
    read: async option => {
      const result = await readRecordResultPreview(option, deps.readers, deps.href());
      return result.state === 'missing' ? { ...result, message: 'This record was removed or replaced. Remove it from this chat, then choose it again.' } : result;
    },
    verify: reference => {
      const entry = entries.get(reference.target.hash);
      return entry && entry.option.exact?.identity === reference.identity
        ? verifySelectedRecord({ reference, ...(entry.option.shortcut ? { shortcut: entry.option.shortcut } : {}) }, deps.readers, deps.href()) : Promise.resolve(false);
    },
    activate: key => {
      const entry = entries.get(key); saved = null;
      if (entry?.link.isConnected) entry.link.click();
    }, changed: () => paint(),
  });
  const focus = (control: string) => {
    const node = [...(dialog?.querySelectorAll<HTMLElement>('[' + FOCUS + ']') ?? [])].find(node => node.getAttribute(FOCUS) === control);
    node?.focus({ preventScroll: true }); return !!node;
  };
  const removeSelected = () => {
    const view = model.state(), snapshot = saved; if (!view || deps.blocked()) return;
    const entry = entries.get(view.key); if (!entry?.remove.isConnected || entry.remove.disabled) return;
    const keys = [...entries.keys()], at = keys.indexOf(view.key), neighbours = [...keys.slice(at + 1), ...keys.slice(0, at).reverse()];
    close(false); entry.remove.click();
    if (disposed || deps.owner() !== view.owner) return;
    (neighbours.map(key => entries.get(key)?.trigger).find(button => button?.isConnected)
      ?? deps.root.querySelector<HTMLElement>('[data-record-link-insert]') ?? deps.input())?.focus({ preventScroll: true });
    restoreDraft(snapshot);
  };
  const makeDialog = () => {
    const node = deps.document.createElement('dialog'); node.className = 'chat-record-preview'; node.id = 'chat-record-preview-dialog';
    node.setAttribute('aria-label', 'Record preview'); node.setAttribute('data-chat-record-preview-dialog', '');
    const current = () => dialog === node && node.isConnected;
    node.addEventListener('cancel', event => { event.preventDefault(); if (current()) close(); });
    node.addEventListener('close', () => { if (current() && !node.open) close(); });
    node.addEventListener('focusin', event => { if (current()) lastFocus = (event.target as HTMLElement)?.getAttribute(FOCUS) ?? lastFocus; });
    node.addEventListener('scroll', () => { if (current()) dialogTop = node.scrollTop; });
    node.addEventListener('click', event => {
      event.stopPropagation(); if (!current()) return;
      const action = (event.target as HTMLElement)?.closest<HTMLElement>('[' + ACTION + ']')?.getAttribute(ACTION);
      if (action === 'close') close();
      if (action === 'activate') void model.activate();
      if (action === 'retry') { const view = model.state(); if (view) void model.open(view.key); }
      if (action === 'remove') removeSelected();
      const box = node.getBoundingClientRect();
      if (event.target === node && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) close();
    });
    node.addEventListener('keydown', event => {
      event.stopPropagation(); if (!current() || event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key === 'Tab') {
        const controls = [...node.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')], at = controls.indexOf(deps.document.activeElement as HTMLButtonElement);
        if (at < 0 || event.shiftKey && at === 0 || !event.shiftKey && at === controls.length - 1) {
          event.preventDefault(); (event.shiftKey ? controls.at(-1) : controls[0])?.focus({ preventScroll: true });
        }
      }
    });
    deps.root.appendChild(node); return node;
  };
  const paint = () => {
    const view = model.state(); for (const [key, entry] of entries) entry.trigger.setAttribute('aria-expanded', String(view?.key === key));
    if (!view || disposed) { removeDialog(); return; }
    const oldFocus = dialog?.contains(deps.document.activeElement) ? (deps.document.activeElement as HTMLElement)?.getAttribute(FOCUS) : null;
    const top = dialog?.isConnected ? dialog.scrollTop : dialogTop;
    if (!dialog?.isConnected) { removeDialog(); dialog = makeDialog(); }
    const display: RecordResultPreviewView = view.state === 'error' ? { ...view, message: 'This record could not be previewed. Try again, or remove it and choose it again.' }
      : { ...view, ...(view.error ? { error: view.error.replace('Close the preview and refresh the results.', 'Remove it from this chat, then choose it again.') } : {}) };
    dialog.innerHTML = previewResultHtml(display, 'Open', FOCUS, ACTION, deps.blocked(), 'Open full record');
    const remove = deps.document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove from chat';
    remove.setAttribute(ACTION, 'remove'); remove.setAttribute(FOCUS, 'preview-remove'); remove.disabled = deps.blocked();
    dialog.querySelector('footer')!.appendChild(remove); dialog.setAttribute('aria-busy', String(view.state === 'loading' || !!view.checking));
    try { if (!dialog.open) dialog.showModal(); } catch { close(false); return; }
    if (!focus(view.checking ? 'preview-close' : oldFocus ?? lastFocus)) focus('preview-title');
    dialog.scrollTop = top;
  };
  const handleClick = (event: Event) => {
    const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('[' + CHAT_RECORD_PREVIEW_ATTR + ']');
    if (!button || !button.isConnected || !deps.root.contains(button)) return;
    const key = button.getAttribute(CHAT_RECORD_PREVIEW_ATTR), entry = key ? entries.get(key) : undefined, owner = deps.owner();
    if (!entry || entry.trigger !== button || !owner || deps.blocked()) return;
    event.preventDefault(); event.stopPropagation();
    const input = deps.input(); saved = { owner, key: key!, ...(input ? { value: input.value, start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection } : {}),
      scrolls: new Map([...hosts()].map(([name, node]) => [name, { top: node.scrollTop, left: node.scrollLeft }])) };
    lastFocus = 'preview-title'; dialogTop = 0; void model.open(key!);
  };
  if (supported) deps.root.addEventListener('click', handleClick);
  return { supported,
    mount() {
      if (disposed || !supported) return;
      const buttons = [...deps.root.querySelectorAll<HTMLButtonElement>('[' + CHAT_RECORD_PREVIEW_ATTR + ']')];
      entries = new Map();
      for (const selected of deps.owner() ? deps.records() : []) {
        const reference = selected.reference, key = reference.target.hash, trigger = buttons.find(button => button.getAttribute(CHAT_RECORD_PREVIEW_ATTR) === key);
        if (!trigger) continue; trigger.disabled = deps.blocked();
        const chip = trigger.closest('.chat-record-chip'), link = chip?.querySelector<HTMLAnchorElement>('a'), remove = chip?.querySelector<HTMLButtonElement>('[data-chat-record-remove]');
        if (!link || link.getAttribute('href') !== key || !remove || remove.getAttribute('data-chat-record-remove') !== key) continue;
        trigger.setAttribute('aria-controls', 'chat-record-preview-dialog');
        entries.set(key, { option: { key, target: reference.target, title: reference.title, detail: reference.details.join(' · '), exact: reference, ...(selected.shortcut ? { shortcut: selected.shortcut } : {}) }, trigger, link, remove });
      }
      model.bind([...entries.values()].map(entry => entry.option));
      if (!model.state()) saved = null;
      restoreDraft(saved); paint();
    },
    captureFocus(): Focus | null {
      const view = model.state(); if (!view || !dialog?.contains(deps.document.activeElement)) return null;
      lastFocus = (deps.document.activeElement as HTMLElement)?.getAttribute(FOCUS) ?? 'preview-title'; dialogTop = dialog.scrollTop;
      return { owner: view.owner, key: view.key, control: lastFocus, top: dialogTop };
    },
    restoreFocus(snapshot: Focus | null) {
      const view = model.state(); if (!snapshot || !view || view.owner !== snapshot.owner || view.key !== snapshot.key || !dialog) return;
      if (!focus(snapshot.control)) focus('preview-title'); dialog.scrollTop = snapshot.top;
    },
    reset: (restore = false) => close(restore),
    dispose() { disposed = true; saved = null; model.dispose(); removeDialog(); entries.clear(); if (supported) deps.root.removeEventListener?.('click', handleClick); },
  };
};

export const CHAT_RECORD_PREVIEW_STYLES = `
dialog.chat-record-preview { box-sizing:border-box; position:fixed; inset:0; margin:auto; width:min(30rem,calc(100vw - 2rem)); max-height:80dvh; overflow:auto; padding:1rem; color:var(--fg,#111); background:var(--rx-input-bg,var(--surface,#fff)); border:1px solid var(--border,#d1d5db); border-radius:12px; box-shadow:0 12px 40px #0004; overflow-wrap:anywhere; }
.chat-record-preview::backdrop { background:#0003; }
.chat-record-preview footer { display:flex; flex-wrap:wrap; gap:.5rem; align-items:center; }
`;
