import { e } from '@recued/ui-shared';
import { workReaderLink, type WorkReaderLink } from './task-note-source.js';
import { createWorkLinkPreview, readWorkLinkPreview, type WorkLinkPreviewReaders, type WorkLinkPreviewView } from './work-link-preview.js';

type Owner = { kind: 'note' | 'task'; binding: string };
type Focus = { owner: string; key: string; control: string; top: number };
const TRIGGER = 'data-work-link-preview-trigger', FOCUS = 'data-work-link-preview-focus';
const recordNoun = (tab: WorkReaderLink['tab']) => tab === 'mail' ? 'email' : tab === 'calendar' ? 'event' : tab;
const panelHtml = (view: WorkLinkPreviewView): string => {
  const kind = recordNoun(view.target.tab), title = view.state === 'ready' ? view.title : kind[0]!.toUpperCase() + kind.slice(1) + ' preview';
  const button = (action: string, text: string) => '<button type="button" data-work-link-preview-action="' + action + '" ' + FOCUS + '="' + action + '">' + text + '</button>';
  return '<header><div><p class="work-link-preview-kind">' + kind[0]!.toUpperCase() + kind.slice(1) + ' preview</p><h3 tabindex="-1" ' + FOCUS + '="title">' + e(title) + '</h3></div>' + button('close', 'Close preview') + '</header>'
    + (view.state === 'loading' ? '<p role="status">Loading preview…</p>'
      : view.state === 'ready' ? view.details.map(text => '<p>' + e(text) + '</p>').join('')
        + (view.excerpt ? '<p class="work-link-preview-excerpt">' + e(view.excerpt) + '</p>' : '')
        + (view.warning ? '<p role="status">' + e(view.warning) + '</p>' : '')
      : '<p role="' + (view.state === 'error' ? 'alert' : 'status') + '">' + e(view.message) + '</p>')
    + '<footer>' + (view.state === 'ready' ? button('open', 'Open ' + kind) : view.state !== 'loading' ? button('retry', 'Try again') : '') + '</footer>';
};

/** The card lives outside the saved body and never repaints the reader when a
 * read settles. A native dialog keeps it visible without moving reader scroll. */
export const createWorkLinkPreviewSurface = (deps: {
  root: HTMLElement; document: Document; owner: () => Owner | null; href: () => string;
  readers: WorkLinkPreviewReaders; blocked: () => boolean;
  find: (kind: Owner['kind']) => void;
  open: (kind: Owner['kind'], trigger: HTMLElement, target: WorkReaderLink) => void;
}) => {
  let host: HTMLElement | null = null, dialog: HTMLDialogElement | null = null, supported: boolean | undefined;
  const buttons = new Map<string, HTMLButtonElement>();
  const model = createWorkLinkPreview({ owner: () => deps.owner()?.binding ?? null,
    read: target => readWorkLinkPreview(target, deps.readers), changed: () => paint() });
  const canRead = (target: WorkReaderLink) => target.tab === 'contact' ? !!deps.readers.contact : target.tab === 'mail' || target.tab === 'calendar' ? !!deps.readers.source : !!deps.readers.work;
  const removeDialog = () => {
    const old = dialog; dialog = null;
    if (old) { try { if (old.open) old.close(); } catch { /* A removed reader already closed it. */ } old.remove(); }
  };
  const focus = (key: string) => {
    const node = [...(dialog?.querySelectorAll<HTMLElement>('[' + FOCUS + ']') ?? [])].find(node => node.getAttribute(FOCUS) === key);
    node?.focus({ preventScroll: true });
  };
  const close = (restore = true) => {
    const view = model.state(), button = view && buttons.get(view.key), owner = deps.owner();
    model.close(); removeDialog();
    if (restore && view && owner?.binding === view.owner && button?.isConnected) button.focus({ preventScroll: true });
  };
  const act = (action: string) => {
    const view = model.state();
    if (!view) return;
    if (action === 'close') { close(); return; }
    if (action === 'retry') { void model.open(view.key); return; }
    if (action === 'open' && view.state === 'ready' && !deps.blocked()) {
      const owner = deps.owner(), trigger = buttons.get(view.key);
      if (!owner || owner.binding !== view.owner || !trigger?.isConnected) return;
      const target = view.target; close(false); deps.open(owner.kind, trigger, target);
    }
  };
  const makeDialog = (): HTMLDialogElement | null => {
    if (!host || !host.isConnected) return null;
    const node = deps.document.createElement('dialog');
    node.className = 'work-link-preview'; node.setAttribute('data-work-link-preview', '');
    node.setAttribute('aria-label', 'Linked record preview');
    node.addEventListener('cancel', event => { event.preventDefault(); if (dialog === node) close(); });
    node.addEventListener('close', () => { if (dialog === node && model.state()) close(); });
    node.addEventListener('click', event => {
      event.stopPropagation();
      const action = (event.target as HTMLElement | null)?.closest?.<HTMLElement>('[data-work-link-preview-action]')?.getAttribute('data-work-link-preview-action');
      if (action) { act(action); return; }
      const at = node.getBoundingClientRect();
      if (event.target === node && (event.clientX < at.left || event.clientX > at.right || event.clientY < at.top || event.clientY > at.bottom)) close();
    });
    node.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      else if (event.key === 'Tab') {
        event.preventDefault(); event.stopPropagation();
        const controls = [...node.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
        const index = controls.indexOf(deps.document.activeElement as HTMLButtonElement);
        const next = index < 0 ? event.shiftKey ? controls.length - 1 : 0
          : (index + (event.shiftKey ? controls.length - 1 : 1)) % controls.length;
        controls[next]?.focus({ preventScroll: true });
      } else if (event.key.toLowerCase() === 'f' && (event.ctrlKey || event.metaKey) && !event.altKey) {
        event.preventDefault(); event.stopPropagation();
        const owner = deps.owner(); close(false); if (owner) deps.find(owner.kind);
      }
    });
    host.appendChild(node); return node;
  };
  const paint = () => {
    const view = model.state();
    for (const [key, button] of buttons) {
      button.setAttribute('aria-expanded', String(view?.key === key));
      // Keep the return target focusable during a background reader refresh.
      button.setAttribute('aria-disabled', String(deps.blocked()));
    }
    if (!view) { removeDialog(); return; }
    if (!dialog?.isConnected) { removeDialog(); dialog = makeDialog(); }
    if (!dialog) return;
    const oldFocus = dialog.contains(deps.document.activeElement)
      ? (deps.document.activeElement as HTMLElement)?.getAttribute(FOCUS) : null;
    const wasOpen = dialog.open, top = dialog.scrollTop;
    dialog.innerHTML = panelHtml(view); dialog.setAttribute('aria-busy', String(view.state === 'loading'));
    const open = dialog.querySelector<HTMLButtonElement>('[data-work-link-preview-action="open"]');
    if (open) open.disabled = deps.blocked();
    try { if (!dialog.open) dialog.showModal(); } catch { close(false); return; }
    if (!wasOpen) focus('title'); else if (oldFocus) focus(oldFocus);
    dialog.scrollTop = top;
  };
  return {
    captureFocus(): Focus | null {
      const view = model.state(), active = deps.document.activeElement as HTMLElement | null;
      return view && dialog?.contains(active) ? { owner: view.owner, key: view.key,
        control: active?.getAttribute(FOCUS) ?? 'title', top: dialog.scrollTop } : null;
    },
    restoreFocus(saved: Focus | null) {
      const view = model.state();
      if (saved && view?.owner === saved.owner && view.key === saved.key && dialog) {
        focus(saved.control); dialog.scrollTop = saved.top;
      }
    },
    mount() {
      const owner = deps.owner();
      host = owner ? deps.root.querySelector<HTMLElement>('.work-entity-' + owner.kind + '-reader') : null;
      buttons.clear();
      if (supported === undefined) supported = typeof deps.document.createElement?.('dialog')?.showModal === 'function';
      const targets = new Map<string, WorkReaderLink>(), occurrences = new Map<string, number>();
      if (owner && host?.querySelectorAll && supported) {
        host.querySelectorAll('[' + TRIGGER + ']').forEach(node => node.remove());
        for (const anchor of host.querySelectorAll<HTMLAnchorElement>('a[data-note-note-link],a[data-task-note-link]')) {
          const target = workReaderLink(anchor.getAttribute('href') ?? '', deps.href());
          if (!target || !canRead(target) || typeof anchor.insertAdjacentElement !== 'function') continue;
          const occurrence = occurrences.get(target.hash) ?? 0; occurrences.set(target.hash, occurrence + 1);
          const key = JSON.stringify([target.hash, occurrence]), button = deps.document.createElement('button');
          button.type = 'button'; button.textContent = 'Preview'; button.className = 'work-link-preview-trigger';
          button.setAttribute(TRIGGER, key); button.setAttribute('aria-label', 'Preview linked ' + recordNoun(target.tab));
          button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('data-' + owner.kind + '-focus', 'link-preview:' + key);
          anchor.insertAdjacentElement('afterend', button); buttons.set(key, button); targets.set(key, target);
        }
      }
      model.bind(owner?.binding ?? null, targets); paint();
    },
    handleClick(event: Event): boolean {
      const button = (event.target as HTMLElement | null)?.closest?.<HTMLButtonElement>('button[' + TRIGGER + ']');
      if (!button || !host?.contains(button)) return false;
      event.preventDefault();
      const key = button.getAttribute(TRIGGER);
      if (key && buttons.get(key) === button && !deps.blocked()) {
        button.focus({ preventScroll: true }); void model.open(key);
      }
      return true;
    },
    dispose() { model.dispose(); removeDialog(); buttons.clear(); host = null; },
  };
};

export const WORK_LINK_PREVIEW_STYLES = [
  '.work-link-preview-trigger { margin-inline-start:.35rem; padding:.1rem .4rem; border:1px solid var(--border,#d1d5db); border-radius:4px; background:var(--rx-input-bg,var(--surface,#fff)); color:var(--fg,#111); font:inherit; font-size:.8em; cursor:pointer; }',
  'dialog.work-link-preview { box-sizing:border-box; position:fixed; inset:0; margin:auto; width:min(26rem,calc(100vw - 2rem)); max-height:min(70dvh,32rem); padding:1rem; overflow:auto; color:var(--fg,#111); background:var(--rx-input-bg,var(--surface,#fff)); border:1px solid var(--border,#d1d5db); border-radius:12px; box-shadow:0 12px 40px #0004; overflow-wrap:anywhere; }',
  '.work-link-preview::backdrop { background:#0003; }',
  '.work-link-preview header { display:flex; align-items:start; justify-content:space-between; gap:1rem; }',
  '.work-link-preview h3 { margin:0; font-size:1.1rem; }',
  '.work-link-preview-kind { margin:0 0 .3rem; font-size:.85rem; opacity:.75; }',
  '.work-link-preview footer { display:flex; gap:.5rem; margin-top:1rem; }',
  '.work-link-preview button { padding:.45rem .65rem; border:1px solid var(--border,#d1d5db); border-radius:6px; background:var(--rx-input-bg,var(--surface,#fff)); color:var(--fg,#111); font:inherit; cursor:pointer; }',
].join('\n');
