import { isMentionOnlyEmail, type SourceRegistration, type ContactRecord, type WorkEntityGetRpcResponse } from '@recued/contracts';
import { taskDeadlineLabel, RefPicker } from '@recued/ui-shared';
import type { DataContactGetCaller, DataWorkEntityGetCaller } from './bootstrap-data-route.js';
import { contactRefOption, readContactReference } from './contact-reference-picker.js';
import { projectReferenceLabel, taskReferenceLabel } from './work-reference-picker.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

type Kind = 'contact' | 'project' | 'task';
export type ReferencePreview = { state: 'ready' | 'missing'; title: string; fields: Array<[string, string]>; notice: string };
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const excerpt = (value: unknown): string => { const chars = Array.from(text(value)); return chars.slice(0, 1200).join('') + (chars.length > 1200 ? '…' : ''); };

export const contactReferencePreview = (contact: ContactRecord | null, merged = false): ReferencePreview => {
  if (!contact) return { state: 'missing', title: 'Unavailable contact', fields: [], notice: 'This contact is no longer available. Its saved reference is kept.' };
  return { state: 'ready', title: contactRefOption(contact).label,
    fields: [['Email', isMentionOnlyEmail(contact.email) ? 'No email address' : contact.email],
      ...(['company', 'phone'] as const).flatMap(key => text(contact[key]) ? [[key === 'company' ? 'Company' : 'Phone', text(contact[key])] as [string, string]] : [])],
    notice: merged ? 'Merged contact. The saved reference is unchanged.' : '' };
};
export const loadContactReferencePreview = async (get: DataContactGetCaller | undefined, id: string, current?: () => boolean): Promise<ReferencePreview> => {
  const { contact, merged } = await readContactReference(get, id, current);
  return contactReferencePreview(contact, merged);
};

export const workReferencePreview = (kind: 'project' | 'task', id: string, response: WorkEntityGetRpcResponse,
  sources: readonly SourceRegistration[]): ReferencePreview => {
  const lookup = (kind === 'task' ? taskReferenceLabel : projectReferenceLabel)(id, response, sources);
  const entity = response.entity;
  if (lookup.state !== 'ready' || !entity) return { state: 'missing', title: lookup.label, fields: [], notice: lookup.message };
  const source = sources.find(row => row.id === entity.source_id)?.source_label || 'Source unavailable';
  if (entity._kind === 'task') {
    if (entity.due_at !== undefined && !Number.isFinite(entity.due_at)) throw new Error('The task due date could not be confirmed.');
    return { state: 'ready', title: text(entity.title) || 'Untitled task', fields: [['Status', entity.done ? 'Completed' : 'Open'],
      ['Due', taskDeadlineLabel(entity)], ...(entity.priority ? [['Priority', entity.priority] as [string, string]] : []),
      ['Source', source], ...(text(entity.body) ? [['Notes', excerpt(entity.body)] as [string, string]] : [])], notice: lookup.message };
  }
  if (entity._kind !== 'project' || typeof entity.state !== 'string') throw new Error('The linked project could not be confirmed.');
  return { state: 'ready', title: text(entity.title) || 'Untitled project', fields: [['Status', entity.state], ['Source', source],
    ...(text(entity.description) ? [['Summary', excerpt(entity.description)] as [string, string]] : [])], notice: lookup.message };
};
export const loadWorkReferencePreview = async (get: DataWorkEntityGetCaller | undefined, kind: 'project' | 'task', id: string,
  sources: readonly SourceRegistration[]): Promise<ReferencePreview> => {
  if (!get) throw new Error('Record previews are unavailable on this server.');
  return workReferencePreview(kind, id, await get({ kind, id }), sources);
};

/** One read-only preview belongs to this editor visit and its committed
 * picker selection. Results only repaint the preview's body. */
export const createWorkReferencePreviews = (deps: {
  contactGet?: DataContactGetCaller; workGet?: DataWorkEntityGetCaller; sources: () => readonly SourceRegistration[];
  handle: (key: string) => RefPicker.RefPickerHandle | undefined;
}) => {
  type Slot = { shell: HTMLElement; kind: Kind; trigger: HTMLButtonElement };
  type Active = { key: string; id: string; kind: Kind; token: number; phase: 'loading' | 'ready' | 'missing' | 'error';
    preview?: ReferencePreview; error?: string; caret?: { query: string; start: number | null; end: number | null; direction: 'forward' | 'backward' | 'none' | null } };
  const slots = new Map<string, Slot>();
  let form: HTMLElement | null = null, binding = '', generation = 0, active: Active | undefined;
  let restore: { key: string; control: string } | undefined;
  const current = (ticket: Active): boolean => active === ticket && ticket.token === generation
    && deps.handle(ticket.key)?.getValue()?.id === ticket.id && slots.has(ticket.key);
  const close = (focus: boolean) => {
    const old = active; active = undefined; generation++;
    if (focus && old) {
      const input = slots.get(old.key)?.shell.querySelector<HTMLInputElement>('[data-ref-picker-input]');
      if (input) {
        // Focus before removing the panel, so the picker sees an internal
        // focus move and keeps the query instead of treating it as a blur.
        input.focus({ preventScroll: true });
        if (old.caret && deps.handle(old.key)?.getQuery() === old.caret.query && old.caret.start !== null && old.caret.end !== null)
          input.setSelectionRange(old.caret.start, old.caret.end, old.caret.direction ?? undefined);
      }
    }
    paint();
  };
  const read = async (ticket: Active) => {
    ticket.token = ++generation; ticket.phase = 'loading'; ticket.preview = undefined; ticket.error = undefined; paint();
    const token = ticket.token, ownsRead = () => current(ticket) && ticket.token === token;
    try {
      const preview = ticket.kind === 'contact' ? await loadContactReferencePreview(deps.contactGet, ticket.id, ownsRead)
        : await loadWorkReferencePreview(deps.workGet, ticket.kind, ticket.id, deps.sources());
      if (!ownsRead()) return;
      ticket.preview = preview; ticket.phase = preview.state;
    } catch (error) {
      if (!ownsRead()) return;
      ticket.phase = 'error'; ticket.error = humanizeRpcError(error);
    }
    paint();
  };
  const open = (key: string) => {
    const slot = slots.get(key), handle = deps.handle(key), selection = handle?.getValue();
    if (!slot || !selection) return;
    if (active?.key === key && active.id === selection.id) { close(true); return; }
    const input = slot.shell.querySelector<HTMLInputElement>('[data-ref-picker-input]');
    active = { key, id: selection.id, kind: slot.kind, token: generation, phase: 'loading',
      ...(input ? { caret: { query: handle!.getQuery(), start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection } } : {}) };
    void read(active);
    const closeButton = slot.shell.querySelector<HTMLButtonElement>('[data-reference-preview-control="close"]');
    closeButton?.focus({ preventScroll: true }); closeButton?.closest('[data-reference-preview]')?.scrollIntoView({ block: 'nearest' });
  };
  const paint = () => {
    for (const [key, slot] of slots) {
      slot.trigger.hidden = !deps.handle(key)?.getValue();
      const shown = active?.key === key && current(active);
      slot.trigger.setAttribute('aria-expanded', String(Boolean(shown)));
      let panel = slot.shell.querySelector<HTMLElement>('[data-reference-preview]');
      if (!shown || !active) { panel?.remove(); continue; }
      const doc = slot.shell.ownerDocument;
      if (!panel) {
        panel = doc.createElement('section'); panel.setAttribute('data-reference-preview', ''); panel.setAttribute('role', 'region');
        panel.setAttribute(RefPicker.REF_PICKER_KEEP_QUERY_ATTR, '');
        panel.setAttribute('aria-label', `${slot.kind === 'task' ? 'Task' : slot.kind === 'project' ? 'Project' : 'Contact'} preview`);
        panel.id = `reference-preview-${key}`;
        const closeButton = doc.createElement('button'); closeButton.type = 'button'; closeButton.className = 'data-button';
        closeButton.setAttribute('data-reference-preview-control', 'close'); closeButton.textContent = 'Close preview';
        closeButton.addEventListener('click', () => { if (form?.contains(closeButton) && active?.key === key) close(true); });
        const body = doc.createElement('div'); body.setAttribute('data-reference-preview-body', ''); body.setAttribute('aria-live', 'polite');
        const retry = doc.createElement('button'); retry.type = 'button'; retry.className = 'data-button'; retry.textContent = 'Retry preview';
        retry.setAttribute('data-reference-preview-control', 'retry'); retry.addEventListener('click', () => { if (form?.contains(retry) && active?.key === key && current(active)) void read(active); });
        panel.append(closeButton, body, retry); slot.shell.append(panel);
      }
      const body = panel.querySelector<HTMLElement>('[data-reference-preview-body]')!;
      body.setAttribute('aria-busy', String(active.phase === 'loading')); body.replaceChildren();
      const heading = doc.createElement('h4'); heading.textContent = active.preview?.title ?? `${slot.kind === 'task' ? 'Task' : slot.kind === 'project' ? 'Project' : 'Contact'} preview`; body.append(heading);
      if (active.preview) {
        const list = doc.createElement('dl');
        for (const [label, value] of active.preview.fields) { const dt = doc.createElement('dt'), dd = doc.createElement('dd'); dt.textContent = label; dd.textContent = value; list.append(dt, dd); }
        body.append(list);
      }
      const message = active.phase === 'loading' ? `Loading ${slot.kind} preview…` : active.error ?? active.preview?.notice;
      if (message) { const note = doc.createElement('p'); note.setAttribute('role', active.phase === 'error' ? 'alert' : 'status'); note.textContent = message; body.append(note); }
      panel.querySelector<HTMLButtonElement>('[data-reference-preview-control="retry"]')!.hidden = active.phase !== 'error' && active.phase !== 'missing';
    }
  };
  const keydown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.isComposing || !active) return;
    event.preventDefault(); event.stopPropagation(); close(true);
  };
  const reset = () => {
    generation++; active = undefined; restore = undefined; form?.removeEventListener('keydown', keydown, true); form = null; binding = ''; slots.clear();
  };
  return { reset,
    selectionChanged() { if (active && !current(active)) close(false); else paint(); },
    beforeRender() {
      restore = undefined;
      const node = form?.ownerDocument.activeElement as HTMLElement | null;
      const control = node?.getAttribute('data-reference-preview-control'), key = node?.closest('[data-ref-picker]')?.getAttribute('data-ref-picker');
      if (control && key) restore = { key, control };
    },
    mount(next: HTMLElement | null, nextBinding: string) {
      if (binding !== nextBinding || !next) { reset(); binding = nextBinding; }
      if (!next || typeof next.addEventListener !== 'function') return;
      if (form !== next) { form?.removeEventListener('keydown', keydown, true); form = next; form.addEventListener('keydown', keydown, true); }
      slots.clear();
      next.querySelectorAll<HTMLElement>('[data-ref-picker]').forEach(shell => {
        const target = shell.querySelector('[data-ref-picker-value]')?.getAttribute('data-form-ref-target');
        const kind = target === 'data.contact' ? 'contact' : target === 'data.project' ? 'project' : target === 'data.task' ? 'task' : undefined;
        const key = shell.getAttribute('data-ref-picker');
        if (!kind || !key || !deps.handle(key) || !(kind === 'contact' ? deps.contactGet : deps.workGet)) return;
        let trigger = shell.querySelector<HTMLButtonElement>('[data-reference-preview-control="trigger"]');
        if (!trigger) {
          trigger = shell.ownerDocument.createElement('button'); trigger.type = 'button'; trigger.className = 'data-button work-reference-preview-trigger';
          trigger.textContent = 'Preview'; trigger.setAttribute('data-reference-preview-control', 'trigger'); trigger.setAttribute('aria-label', `Preview selected ${kind}`);
          trigger.setAttribute('aria-controls', `reference-preview-${key}`); trigger.addEventListener('click', () => { if (form?.contains(trigger!)) open(key); });
          trigger.setAttribute(RefPicker.REF_PICKER_KEEP_QUERY_ATTR, '');
          const field = shell.querySelector('.ref-picker-field'); field?.classList.add('work-reference-preview-field'); field?.append(trigger);
        }
        slots.set(key, { shell, kind, trigger });
      });
      if (active && !current(active)) { active = undefined; generation++; }
      paint();
      const focus = restore; restore = undefined;
      if (focus) {
        const control = slots.get(focus.key)?.shell.querySelector<HTMLButtonElement>(`[data-reference-preview-control="${focus.control}"]`);
        control?.focus({ preventScroll: true }); (control?.closest('[data-reference-preview]') ?? control)?.scrollIntoView({ block: 'nearest' });
      }
    },
  };
};
