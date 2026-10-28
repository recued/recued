import { canonicalJSONStringify, type ServerPendingAsk } from '@recued/contracts';
import { ASK_CARD_ATTR, ASK_CARD_NOTE_ATTR } from '@recued/ui-shared/approval-card';

interface NoteDraft {
  readonly context: string;
  readonly field: HTMLTextAreaElement;
  readonly value: string;
  readonly start: number;
  readonly end: number;
  readonly direction: 'forward' | 'backward' | 'none';
  readonly top: number;
  readonly left: number;
}
interface NoteFocus {
  readonly id: string;
  readonly context: string;
  readonly field: HTMLTextAreaElement;
}

/** Page-local reasons, bound to the complete pending decision. Capture the
 * old fields before replacing their cards; a changed or closed ask retires
 * its draft. Nothing is persisted or sent until the owner answers. */
export const createAskNoteDrafts = (doc: Document, root: HTMLElement) => {
  let contexts = new Map<string, string>();
  const drafts = new Map<string, NoteDraft>();
  const fields = (): HTMLTextAreaElement[] =>
    Array.from(root.querySelectorAll?.<HTMLTextAreaElement>(`[${ASK_CARD_NOTE_ATTR}]`) ?? []);

  const capture = (asks: readonly ServerPendingAsk[]): NoteFocus | null => {
    let focused: NoteFocus | null = null;
    for (const field of fields()) {
      const id = field.getAttribute(ASK_CARD_NOTE_ATTR)!;
      const context = contexts.get(id);
      if (context === undefined) continue;
      drafts.set(id, { context, field, value: field.value, start: field.selectionStart, end: field.selectionEnd,
        direction: field.selectionDirection, top: field.scrollTop, left: field.scrollLeft });
      if (doc.activeElement === field) focused = { id, context, field };
    }
    // Include every review field, including future contract additions. A
    // different property order alone does not change the decision reviewed.
    contexts = new Map(asks.filter(ask => ask.note_prompt !== undefined && ask.owner_review === undefined)
      .map(ask => [ask.ask_id, canonicalJSONStringify(ask)]));
    for (const [id, draft] of drafts) if (contexts.get(id) !== draft.context) drafts.delete(id);
    return focused;
  };

  const restore = (focused: NoteFocus | null): boolean => {
    let restoredFocus = false;
    for (const field of fields()) {
      const id = field.getAttribute(ASK_CARD_NOTE_ATTR)!;
      const draft = drafts.get(id);
      if (!draft || contexts.get(id) !== draft.context) continue;
      if (field.value !== draft.value) field.value = draft.value;
      // A later focus owner wins. This runs synchronously after the old card
      // was removed, before the queue's ordinary card/successor fallback.
      if (focused?.id === id && focused.context === draft.context
        && (doc.activeElement === focused.field || doc.activeElement === doc.body || doc.activeElement == null)) {
        field.focus({ preventScroll: true }); restoredFocus = true;
      }
      field.setSelectionRange(draft.start, draft.end, draft.direction);
      field.scrollTop = draft.top; field.scrollLeft = draft.left;
    }
    return restoredFocus;
  };
  const render = (host: HTMLElement, nodes: readonly Node[]): void => {
    if (typeof host.insertBefore === 'function' && host.childNodes !== undefined) {
      const keep = new Set(nodes);
      for (const child of Array.from(host.childNodes)) if (!keep.has(child)) host.removeChild(child);
      let cursor = host.firstChild;
      for (const node of nodes) {
        if (cursor === node) cursor = cursor.nextSibling;
        else host.insertBefore(node, cursor);
      }
    } else {
      while (host.firstChild) host.removeChild(host.firstChild);
      for (const node of nodes) host.appendChild(node);
    }
  };
  return { capture, restore, render,
    cardFor: (id: string): HTMLElement | undefined => drafts.get(id)?.field.closest<HTMLElement>(`[${ASK_CARD_ATTR}]`) ?? undefined,
    dispose: () => { contexts.clear(); drafts.clear(); } };
};
