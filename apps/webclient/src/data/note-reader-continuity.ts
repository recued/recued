import type { ReadingFormat as NoteFormat, ReaderSnapshot } from './reader-state.js';
import type { Commitment } from '@recued/contracts';
interface ReadingPosition {
  top: number;
  anchor?: { id?: string; index: number; offset: number };
  sections: Map<string, boolean>;
  outlineTop: number;
  focus?: { attribute: string; value: string };
  summary?: string;
}

/** Reader state survives repaints and an edit round trip, but never leaks to
 * another note. Keep a place for each display format; neither changes the body. */
const createReaderContinuity = (kind: 'note' | 'task' | 'commitment') => {
  let id: string | null = null;
  let format: NoteFormat = 'plain';
  const positions = new Map<NoteFormat, ReadingPosition>();
  let awaitingPaint = false;
  let pendingLayout = false;
  let stableLayout = false;
  const reset = () => { id = null; format = 'plain'; positions.clear(); awaitingPaint = pendingLayout = stableLayout = false; };
  const open = (nextId: string) => { if (id !== nextId) { reset(); id = nextId; awaitingPaint = true; } };
  const capture = (root: HTMLElement): void => {
    const reader = root.querySelector?.<HTMLElement>(`.work-entity-${kind}-reader`);
    const content = reader?.querySelector<HTMLElement>(`.work-entity-${kind}-content`);
    if (awaitingPaint || !reader || !content || reader.getAttribute(`data-${kind}-id`) !== id) return;
    const renderedFormat: NoteFormat = reader.getAttribute(`data-${kind}-format`) === 'formatted' ? 'formatted' : 'plain';
    const retained = pendingLayout ? positions.get(renderedFormat) : undefined;
    const position: ReadingPosition = { top: retained?.top ?? content.scrollTop,
      sections: new Map(kind === 'commitment' ? positions.get(renderedFormat)?.sections : undefined),
      outlineTop: reader.querySelector<HTMLElement>(`.work-entity-${kind}-outline nav`)?.scrollTop ?? 0 };
    reader.querySelectorAll<HTMLDetailsElement>(`details[data-${kind}-section]`).forEach(section => {
      position.sections.set(section.getAttribute(`data-${kind}-section`)!, section.open);
    });
    if (retained) position.anchor = retained.anchor;
    else {
      const viewportTop = content.getBoundingClientRect().top;
      for (const [index, heading] of Array.from(reader.querySelectorAll<HTMLElement>(`[data-${kind}-heading]`)).entries()) {
        const offset = heading.getBoundingClientRect().top - viewportTop;
        if (offset > 24) break;
        position.anchor = { id: heading.getAttribute(`data-${kind}-heading`)!, index, offset };
      }
    }
    const active = root.ownerDocument.activeElement;
    if (active && reader.contains(active)) {
      if (active.tagName === 'SUMMARY') position.summary = active.parentElement?.getAttribute(`data-${kind}-section`) ?? undefined;
      else {
        for (const attribute of [`data-${kind}-focus`, 'data-action', `data-${kind}-notice`, 'id']) {
          const value = active.getAttribute(attribute);
          if (value !== null) { position.focus = { attribute, value }; break; }
        }
      }
    }
    positions.set(renderedFormat, position);
  };
  const restore = (root: HTMLElement, options: { pending?: boolean } = {}): void => {
    const reader = root.querySelector?.<HTMLElement>(`.work-entity-${kind}-reader`);
    const content = reader?.querySelector<HTMLElement>(`.work-entity-${kind}-content`);
    const position = positions.get(format);
    if (!reader || !content || reader.getAttribute(`data-${kind}-id`) !== id) return;
    awaitingPaint = false;
    // A temporary loading layout can clamp scrollTop. Keep the saved position
    // until the reader has its initial secondary data, rather than capturing
    // that automatic clamp as the owner's new reading position.
    pendingLayout = options.pending === true && stableLayout && position !== undefined;
    if (!options.pending) stableLayout = true;
    if (!position) return;
    let focusTarget: HTMLElement | null = null;
    reader.querySelectorAll<HTMLDetailsElement>(`details[data-${kind}-section]`).forEach(section => {
      const key = section.getAttribute(`data-${kind}-section`)!;
      if (position.sections.has(key)) section.open = position.sections.get(key)!;
      if (position.summary === key) focusTarget = section.querySelector('summary');
    });
    const outline = reader.querySelector<HTMLElement>(`.work-entity-${kind}-outline nav`);
    if (outline) outline.scrollTop = position.outlineTop;
    content.scrollTop = position.top;
    if (position.anchor) {
      const headings = Array.from(reader.querySelectorAll<HTMLElement>(`[data-${kind}-heading]`));
      const anchor = position.anchor.id ? headings.find(heading => heading.getAttribute(`data-${kind}-heading`) === position.anchor!.id) : headings[position.anchor.index];
      if (anchor) content.scrollTop += anchor.getBoundingClientRect().top - content.getBoundingClientRect().top - position.anchor.offset;
    }
    if (position.focus) {
      const { attribute, value } = position.focus;
      focusTarget = Array.from(reader.querySelectorAll<HTMLElement>(`[${attribute}]`))
        .find(control => control.getAttribute(attribute) === value) ?? null;
    }
    focusTarget?.focus({ preventScroll: true });
  };
  return { open, reset, capture, restore, id: () => id, format: () => format, setFormat: (next: NoteFormat) => { format = next; },
    interact(root: HTMLElement) {
      if (!pendingLayout) return;
      pendingLayout = false;
      capture(root);
    },
    snapshot: (): ReaderSnapshot => ({ format, positions: Object.fromEntries([...positions].map(([key, position]) => [key, {
      top: position.top, outlineTop: position.outlineTop, sections: [...position.sections],
      ...(position.anchor ? { anchor: { index: position.anchor.index, offset: position.anchor.offset } } : {}),
    }])) }),
    resume(snapshot: ReaderSnapshot) {
      format = snapshot.format; positions.clear(); awaitingPaint = true; pendingLayout = false; stableLayout = true;
      for (const key of ['plain', 'formatted'] as const) {
        const position = snapshot.positions[key];
        if (position) positions.set(key, { ...position, sections: new Map(position.sections) });
      }
    },
    startTop(root: HTMLElement) {
      for (const position of positions.values()) { position.top = 0; delete position.anchor; }
      const content = root.querySelector<HTMLElement>(`.work-entity-${kind}-reader[data-${kind}-id] .work-entity-${kind}-content`);
      if (content) content.scrollTop = 0;
    },
  };
};

export const createNoteReaderContinuity = () => createReaderContinuity('note');
export const createTaskReaderContinuity = () => createReaderContinuity('task');

/** Captured evidence belongs to this record's lifetime, even if an ID is reused. */
export const createCommitmentReaderContinuity = () => {
  const reader = createReaderContinuity('commitment');
  let identity = '';
  return { ...reader, open(entity: Pick<Commitment, 'id' | 'source_id' | 'source_record_id' | 'created_at'>) {
    const next = JSON.stringify([entity.id, entity.source_id, entity.source_record_id, entity.created_at]);
    if (next !== identity) { reader.reset(); identity = next; }
    reader.open(entity.id);
  } };
};
