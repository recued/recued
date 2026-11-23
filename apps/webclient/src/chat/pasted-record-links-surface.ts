import { exactRecordNoun, readExactRecordLink } from '../data/exact-record-link.js';
import type { PreparedRecordLink } from '../data/record-link-insert.js';
import type { WorkLinkPreviewReaders } from '../data/work-link-preview.js';
import { createPastedRecordLinks, type RecordLinkDraftOwner } from './pasted-record-links.js';

/** Inline suggestions leave native paste and the textarea's undo stack alone.
 * Only Attach reads a record; its result belongs to the same draft and link. */
export const createPastedRecordLinksSurface = (deps: {
  root: HTMLElement; document: Document; owner: () => RecordLinkDraftOwner | null;
  text: () => string; href: () => string; records: () => readonly PreparedRecordLink[];
  readers: WorkLinkPreviewReaders; blocked: () => boolean; commit: (records: readonly PreparedRecordLink[]) => string | null;
  input: () => HTMLTextAreaElement | null; host: () => HTMLElement | null; changed: () => void;
}) => {
  let banner: HTMLElement | null = null, disposed = false;
  const restore = (snapshot: { owner: string; scope: object; value: string; start: number; end: number; direction: 'forward' | 'backward' | 'none'; top: number; left: number; focus: boolean } | null) => {
    const owner = deps.owner(), field = deps.input();
    if (!snapshot || disposed || owner?.key !== snapshot.owner || owner.scope !== snapshot.scope || !field?.isConnected || field.value !== snapshot.value) return;
    if (snapshot.focus) field.focus({ preventScroll: true });
    field.setSelectionRange(snapshot.start, snapshot.end, snapshot.direction); field.scrollTop = snapshot.top; field.scrollLeft = snapshot.left;
  };
  const capture = (activated = false) => {
    const owner = deps.owner(), field = deps.input(), active = deps.document.activeElement;
    return owner && field ? { owner: owner.key, scope: owner.scope, value: field.value, start: field.selectionStart, end: field.selectionEnd,
      direction: field.selectionDirection, top: field.scrollTop, left: field.scrollLeft,
      focus: activated || active === field || !!banner?.contains(active) } : null;
  };
  type FocusSnapshot = { draft: NonNullable<ReturnType<typeof capture>>; key: string; control: 'attach' | 'dismiss' | null };
  const model = createPastedRecordLinks({ ...deps,
    read: target => readExactRecordLink(target, deps.readers, deps.href()),
    commit: records => { const saved = capture(); const error = deps.commit(records); if (!error) restore(saved); return error; },
    changed: () => { if (!disposed) { paint(); deps.changed(); } },
  });
  const removeBanner = () => { banner?.remove(); banner = null; };
  const makeBanner = (host: HTMLElement, field: HTMLTextAreaElement) => {
    const node = deps.document.createElement('section'); node.className = 'chat-record-link-suggestion';
    node.setAttribute('data-chat-record-link-suggestion', ''); node.setAttribute('aria-label', 'Record link in message');
    const label = deps.document.createElement('p'); label.setAttribute('data-record-link-suggestion-label', ''); label.setAttribute('role', 'status');
    const actions = deps.document.createElement('div');
    const attach = deps.document.createElement('button'); attach.type = 'button'; attach.textContent = 'Attach record'; attach.setAttribute('data-record-link-suggestion-attach', '');
    const dismiss = deps.document.createElement('button'); dismiss.type = 'button'; dismiss.textContent = 'Dismiss'; dismiss.setAttribute('data-record-link-suggestion-dismiss', '');
    const error = deps.document.createElement('p'); error.setAttribute('role', 'alert'); error.setAttribute('data-record-link-suggestion-error', ''); error.hidden = true;
    actions.append(attach, dismiss); node.append(label, actions, error);
    attach.addEventListener('click', () => {
      const view = model.state(); if (banner !== node || !node.isConnected || !view) return;
      // WebKit leaves pointer-activated buttons unfocused. Focus before the
      // checking repaint so Dismiss can own focus until the reader finishes.
      attach.focus({ preventScroll: true }); void model.attach(view.candidate.key);
    });
    dismiss.addEventListener('click', () => {
      const view = model.state(); if (banner !== node || !node.isConnected || !view) return;
      const saved = capture(true); model.dismiss(view.candidate.key); restore(saved);
    });
    host.insertBefore(node, field.closest('.chat-composer-input-row')); return node;
  };
  const paint = () => {
    if (disposed) return;
    const view = model.state(), field = deps.input(), host = deps.host();
    if (!view || !field || !host) { removeBanner(); return; }
    if (!banner?.isConnected || banner.parentElement !== host) { removeBanner(); banner = makeBanner(host, field); }
    const attach = banner.querySelector<HTMLButtonElement>('[data-record-link-suggestion-attach]')!;
    const wasFocused = deps.document.activeElement === attach;
    attach.disabled = deps.blocked() || view.checking; attach.textContent = view.error ? 'Try attaching again' : 'Attach record';
    attach.setAttribute('aria-busy', String(view.checking));
    const noun = exactRecordNoun(view.candidate.target);
    banner.querySelector<HTMLElement>('[data-record-link-suggestion-label]')!.textContent = view.checking ? 'Checking the linked ' + noun + '…'
      : 'Attach the ' + noun + ' linked in your message as context.';
    const error = banner.querySelector<HTMLElement>('[data-record-link-suggestion-error]')!; error.textContent = view.error ?? ''; error.hidden = !view.error;
    if (view.checking && wasFocused) banner.querySelector<HTMLButtonElement>('[data-record-link-suggestion-dismiss]')!.focus({ preventScroll: true });
  };
  const onInput = (event: Event) => {
    if (disposed || event.target !== deps.input() || !(event.target as HTMLElement).isConnected) return;
    paint(); deps.changed();
  };
  deps.root.addEventListener('input', onInput);
  return {
    mount: paint, hasPending: model.hasPending, reset: () => model.reset(),
    captureFocus(): FocusSnapshot | null {
      const view = model.state(), draft = capture(), active = deps.document.activeElement;
      return view && draft ? { draft, key: view.candidate.key, control: banner?.contains(active)
        ? active?.hasAttribute('data-record-link-suggestion-attach') ? 'attach' : 'dismiss' : null } : null;
    },
    restoreFocus(saved: FocusSnapshot | null) {
      if (!saved) return;
      restore({ ...saved.draft, focus: false });
      const view = model.state(), active = deps.document.activeElement;
      if (view?.owner.key !== saved.draft.owner || view.owner.scope !== saved.draft.scope || view.candidate.key !== saved.key
        || !saved.control || active && active !== deps.document.body && active.isConnected && !banner?.contains(active)) return;
      banner?.querySelector<HTMLElement>('[data-record-link-suggestion-' + saved.control + ']')?.focus({ preventScroll: true });
    },
    dispose() { disposed = true; model.dispose(); removeBanner(); deps.root.removeEventListener?.('input', onInput); },
  };
};

export const PASTED_RECORD_LINK_STYLES = `
.chat-record-link-suggestion { padding:.65rem; margin:.5rem 0; border:1px solid var(--border); border-radius:8px; overflow-wrap:anywhere; }
.chat-record-link-suggestion p { margin:0 0 .4rem; }
.chat-record-link-suggestion > div { display:flex; flex-wrap:wrap; gap:.5rem; }
.chat-record-link-suggestion button { min-height:44px; padding:.5rem .75rem; color:var(--fg); background:var(--surface); border:1px solid var(--border); border-radius:6px; font:inherit; cursor:pointer; }
`;
