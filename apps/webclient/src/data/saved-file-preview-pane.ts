import type { FileAttachmentSelection } from '@recued/contracts';
import { renderActionIcon } from '@recued/ui-shared';
import { renderFilePreviewBody, type FilePreviewCallers, type FilePreviewTarget } from '../files/file-preview.js';
import { COLLECTION_RECORD_ID_ATTR } from './collection-explorer.js';
import { FILE_BROWSER_DESKTOP_MEDIA } from './file-browser-toolbar.js';

const SLOT = 'data-saved-file-preview-slot';
const OPEN = 'data-saved-file-preview-open';
export const SAVED_FILE_PREVIEW_SLOT_SELECTOR = `[${SLOT}]`;
export const SAVED_FILE_PREVIEW_SLOT = `<div ${SLOT} hidden></div>`;

type Selection = { file: FileAttachmentSelection; abort: AbortController };
const previewTarget = (file: FileAttachmentSelection): FilePreviewTarget => ({
  record_id: file.file_id, filename: file.filename, selection_revision: file.selection_revision,
});
const sameFile = (file: FileAttachmentSelection, other: FileAttachmentSelection): boolean =>
  file.file_id === other.file_id && file.selection_revision === other.selection_revision && file.filename === other.filename;

export const createSavedFilePreviewPane = (opts: {
  root: HTMLElement;
  actionAttr: string;
  callers: FilePreviewCallers;
  openFullSize: (target: FilePreviewTarget, opener: HTMLElement) => void;
}) => {
  const doc = opts.root.ownerDocument;
  const media = doc.defaultView?.matchMedia?.(FILE_BROWSER_DESKTOP_MEDIA);
  const rowSelector = `[${opts.actionAttr}="file-open-preview"][${COLLECTION_RECORD_ID_ATTR}]`;
  const findRow = (id: string): HTMLElement | undefined => Array.from(opts.root.querySelectorAll<HTMLElement>(rowSelector))
    .find(row => row.getAttribute(COLLECTION_RECORD_ID_ATTR) === id);
  const findSlot = () => opts.root.querySelector<HTMLElement>(SAVED_FILE_PREVIEW_SLOT_SELECTOR);
  const pane = doc.createElement('aside');
  pane.className = 'saved-file-preview';
  pane.setAttribute('aria-label', 'File preview');
  pane.setAttribute('role', 'region');
  const header = doc.createElement('header');
  const heading = doc.createElement('h2');
  heading.tabIndex = -1;
  const expand = doc.createElement('button');
  expand.type = 'button';
  expand.className = 'data-button';
  expand.textContent = 'Open full size';
  const closeButton = doc.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'data-button saved-file-preview-close';
  closeButton.setAttribute('aria-label', 'Close preview');
  closeButton.title = 'Close preview';
  closeButton.innerHTML = renderActionIcon('close');
  header.append(heading, expand, closeButton);
  const scroll = doc.createElement('div');
  scroll.className = 'saved-file-preview-scroll';
  scroll.tabIndex = 0;
  scroll.setAttribute('role', 'group');
  scroll.setAttribute('aria-label', 'Preview content');
  const status = doc.createElement('p');
  status.setAttribute('role', 'status');
  const error = doc.createElement('p');
  error.setAttribute('role', 'alert');
  const body = doc.createElement('div');
  body.setAttribute('data-file-preview-body', '');
  scroll.append(status, error, body);
  pane.append(header, scroll);

  let selected: Selection | undefined;
  let markedRow: HTMLElement | undefined;
  const markRow = (row?: HTMLElement) => {
    if (row === markedRow) return;
    markedRow?.removeAttribute('aria-current');
    markedRow?.removeAttribute('aria-keyshortcuts');
    markedRow = row;
    markedRow?.setAttribute('aria-current', 'true');
    markedRow?.setAttribute('aria-keyshortcuts', 'ArrowRight');
  };
  const focusRow = (id: string) => {
    (findRow(id) ?? opts.root.querySelector<HTMLElement>(`[${opts.actionAttr}="file-saved-query"]`))
      ?.focus({ preventScroll: true });
  };
  const close = (restoreFocus = false) => {
    if (!selected) return;
    const owner = selected;
    selected = undefined;
    owner.abort.abort();
    markRow();
    const slot = pane.parentElement;
    slot?.parentElement?.removeAttribute(OPEN);
    if (slot) slot.hidden = true;
    pane.remove();
    body.replaceChildren();
    if (restoreFocus) focusRow(owner.file.file_id);
  };
  const mount = (slot: HTMLElement, row: HTMLElement) => {
    slot.hidden = false;
    slot.parentElement?.setAttribute(OPEN, '');
    if (pane.parentElement !== slot) slot.append(pane);
    markRow(row);
  };
  const load = (owner: Selection) => {
    const signal = owner.abort.signal;
    const isCurrent = () => selected === owner && !signal.aborted;
    const urls = new Set<string>();
    signal.addEventListener('abort', () => { for (const url of urls) URL.revokeObjectURL(url); }, { once: true });
    const failed = (cause: unknown) => {
      if (!isCurrent()) return;
      error.textContent = cause instanceof Error && cause.name === 'PasswordException'
        ? 'This PDF needs a password. Download it to open it.'
        : cause instanceof Error ? cause.message : 'Could not preview this file.';
      status.textContent = '';
    };
    void renderFilePreviewBody({
      doc, body, signal, isCurrent, onFailure: failed,
      status: message => { if (isCurrent()) status.textContent = message; },
      urlFor: (bytes, mime) => {
        const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }));
        urls.add(url);
        return url;
      },
    }, previewTarget(owner.file), { preview: opts.callers.preview, read: opts.callers.read }).catch(failed);
  };
  expand.addEventListener('click', () => {
    if (selected) opts.openFullSize(previewTarget(selected.file), expand);
  });
  closeButton.addEventListener('click', () => close(true));
  const onBreakpointChange = () => {
    if (!media?.matches) close(pane.contains(doc.activeElement));
  };
  media?.addEventListener?.('change', onBreakpointChange);

  return {
    open(file: FileAttachmentSelection, row: HTMLElement, keyboard: boolean): boolean {
      const slot = findSlot();
      if (!media?.matches || !slot) return false;
      if (!selected || !sameFile(file, selected.file)) {
        selected?.abort.abort();
        selected = { file, abort: new AbortController() };
        heading.textContent = heading.title = file.filename;
        status.textContent = 'Loading preview…';
        error.textContent = '';
        body.replaceChildren();
        mount(slot, row);
        scroll.scrollTop = 0;
        load(selected);
      }
      (keyboard ? heading : row).focus({ preventScroll: true });
      return true;
    },
    reconcile(files?: readonly FileAttachmentSelection[]): void {
      const file = selected?.file;
      if (file && !files?.some(candidate => sameFile(file, candidate))) {
        close(files !== undefined && pane.contains(doc.activeElement));
      }
    },
    preservedSlot: () => selected ? pane.parentElement : null,
    focusRow,
    restore(focused: Element | null): void {
      if (!selected) return;
      const slot = findSlot(), row = findRow(selected.file.file_id);
      if (!slot || !row) { close(pane.contains(doc.activeElement)); return; }
      mount(slot, row);
      if (focused !== doc.activeElement && pane.contains(focused)) (focused as HTMLElement).focus({ preventScroll: true });
    },
    handleKeyDown(event: KeyboardEvent): boolean {
      if (!selected || event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return false;
      const target = event.target as Element | null;
      if (event.key === 'Escape' && (target === markedRow || pane.contains(target))) close(true);
      else if (event.key === 'ArrowRight' && target === markedRow) heading.focus({ preventScroll: true });
      else if (event.key === 'ArrowLeft' && header.contains(target)) focusRow(selected.file.file_id);
      else return false;
      event.preventDefault();
      event.stopPropagation();
      return true;
    },
    dispose(): void { media?.removeEventListener?.('change', onBreakpointChange); close(); },
  };
};

export const SAVED_FILE_PREVIEW_STYLES = `
.saved-file-results, .saved-file-results-list { display:contents; }
@media ${FILE_BROWSER_DESKTOP_MEDIA} {
  .saved-file-results .col-explorer-row-summary {
    display:block; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  }
  .saved-file-results .col-explorer-field { display:inline; margin-inline-end:.75rem; }
  .saved-file-results .col-explorer-field-label { margin-inline-end:.3125rem; }
  .saved-file-results[${OPEN}] {
    display:grid; grid-template-columns:clamp(344px, 42%, 420px) minmax(0,1fr); gap:20px; align-items:start;
    margin-block-start:16px;
  }
  .saved-file-results[${OPEN}] .saved-file-results-list { display:flow-root; min-width:0; }
  .saved-file-results[${OPEN}] [data-saved-file-search] { margin-block-start:0; }
  .saved-file-results[${OPEN}] > [${SLOT}] { position:sticky; inset-block-start:16px; min-width:0; }
  .saved-file-results[${OPEN}] .col-explorer-row-btn[aria-current="true"] {
    border-color:color-mix(in srgb,var(--accent) 45%,var(--border));
    background:var(--accent-weak,var(--surface-sunk)); box-shadow:inset 3px 0 var(--accent);
  }
  .saved-file-preview {
    display:flex; flex-direction:column; min-block-size:min(36dvh,280px); max-block-size:clamp(220px,calc(100dvh - 128px),720px);
    border:1px solid var(--border); border-radius:var(--wc-radius-lg,12px); background:var(--surface); overflow:hidden;
  }
  .saved-file-preview header { display:flex; align-items:center; gap:8px; padding:12px; border-bottom:1px solid var(--border); }
  .saved-file-preview h2 { flex:1; min-width:0; margin:0; font-size:15px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
  .saved-file-preview header .data-button { flex:none; min-height:40px; white-space:nowrap; }
  .saved-file-preview header .saved-file-preview-close { display:grid; place-items:center; width:40px; padding:0; }
  .saved-file-preview-close svg { width:16px; height:16px; }
  .saved-file-preview-scroll { flex:1; min-height:0; min-width:0; overflow:auto; padding:16px; scrollbar-width:thin; }
  .saved-file-preview :is(h2,.saved-file-preview-scroll):focus-visible { outline:2px solid var(--accent); outline-offset:-2px; }
  .saved-file-preview-scroll > p { margin:0 0 10px; font-size:13px; color:var(--fg-muted); overflow-wrap:anywhere; }
  .saved-file-preview-scroll > [role="alert"] { color:var(--danger,var(--fg)); }
  .saved-file-preview-scroll > p:empty { margin:0; }
  .saved-file-preview [data-file-preview-body] img { display:block; max-width:100%; max-height:60dvh; object-fit:contain; margin:auto; }
  .saved-file-preview [data-file-preview-body] pre { margin:0; white-space:pre-wrap; overflow-wrap:anywhere; tab-size:4; font:13px/1.5 ui-monospace,monospace; }
  .saved-file-preview .pdf-preview { font-size:13px; }
  .saved-file-preview .pdf-preview .file-preview-controls { gap:6px; margin:0 0 8px; }
  .saved-file-preview .pdf-preview .pdf-find label { flex-basis:9rem; min-width:0; }
  .saved-file-preview .pdf-preview [data-pdf-find-status] { margin:0 0 8px; }
  .saved-file-preview .pdf-preview :is(button,input) { min-height:40px; }
  .saved-file-preview .pdf-preview button {
    padding:6px 10px; border:1px solid var(--border); border-radius:var(--wc-radius,9px);
    background:var(--surface); color:var(--fg); cursor:pointer;
  }
  .saved-file-preview .pdf-preview button:disabled { opacity:.55; cursor:default; }
  .saved-file-preview .file-preview-pdf-page { background:var(--surface-sunk); }
  .saved-file-preview canvas { display:block; }
}
`;
