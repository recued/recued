import { isMentionOnlyEmail, type ContactRecord, type SourceRegistration, type WorkEntity, type WorkEntityGetRpcResponse } from '@recued/contracts';
import { e, type RefPicker } from '@recued/ui-shared';
import type { DataContactGetCaller, DataContactListCaller, DataWorkEntityGetCaller, DataWorkEntitySearchCaller, DataWorkEntityUpsertCaller, WorkEntitySourceListCaller } from './bootstrap-data-route.js';
import { createTaskBulkProjectPicker, sameTaskProject, availableTaskProject } from './task-bulk-projects.js';
import { createTaskBulkContactPicker, sameTaskContact } from './task-bulk-contacts.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

type Note = Extract<WorkEntity, { _kind: 'note' }>;
type Target = { kind: 'project'; value: Extract<WorkEntity, { _kind: 'project' }>; label: string }
  | { kind: 'contact'; value: ContactRecord & { contact_id: string }; label: string };
type Row = { note: Note; revision?: string; state: 'ready' | 'running' | 'confirmed' | 'unchanged' | 'failed' | 'unconfirmed' | 'skipped';
  attempted: boolean; message?: string; before?: number; after?: number };
type Review = { kind: 'project' | 'contact'; remove: boolean; loading: boolean; error?: string; target?: Target; rows: Row[]; attempted: boolean };
export const NOTE_BULK_FOCUS = 'data-note-bulk-focus';
export const NOTE_BULK_LIMIT = 100;
const sameNote = (entity: WorkEntity | null, note: Note): entity is Note => entity?._kind === 'note'
  && entity.id === note.id && entity.source_id === note.source_id && entity.source_record_id === note.source_record_id
  && entity.created_at === note.created_at && entity.deleted_at == null && entity.sync_state === 'live';
const unavailable = (note: Note, sources: readonly SourceRegistration[]): string | undefined => {
  const source = sources.find(s => s.id === note.source_id && s.top_tier_kind === 'note');
  return note.deleted_at != null || note.sync_state !== 'live' ? 'This note is unavailable.'
    : !source?.write_capable || source.sync_posture === 'read_through' ? 'This note source is read-only or unavailable.'
      : note.pending_write ? 'A change is waiting for source confirmation.' : undefined;
};
const links = (note: Note, target: Target): readonly string[] => target.kind === 'project' ? note.related_project_ids : note.related_contact_ids;
const matchesLink = (id: string, target: Target): boolean => target.kind === 'project' ? id === target.value.id
  : id === target.value.contact_id || id === target.value.email;
const achieved = (note: Note, target: Target, remove: boolean) => links(note, target).some(id => matchesLink(id, target)) !== remove;
/** A one-target set operation. Other relationships retain their exact order and values. */
export const noteLinkChange = (note: Note, target: Target, remove: boolean): readonly string[] => {
  const current = links(note, target);
  return remove ? current.filter(id => !matchesLink(id, target)) : achieved(note, target, false) ? [...current]
    : [...current, target.kind === 'project' ? target.value.id : target.value.contact_id];
};
const revision = (reply: WorkEntityGetRpcResponse) => typeof reply.note_edit_revision === 'string' && /^[a-f0-9]{64}$/.test(reply.note_edit_revision) ? reply.note_edit_revision : undefined;

/** Scoped to loaded filtered notes. Every write is conditional on the reviewed
 * note revision; an uncertain acknowledgement is reconciled before any retry. */
export const createNoteBulkActions = (deps: {
  rows: () => readonly WorkEntity[]; sources: () => readonly SourceRegistration[]; ready: () => boolean;
  get?: DataWorkEntityGetCaller; listSources?: WorkEntitySourceListCaller; update?: DataWorkEntityUpsertCaller;
  search?: DataWorkEntitySearchCaller; contactList?: DataContactListCaller; contactGet?: DataContactGetCaller;
  render: () => void; begin: () => void; confirmed: (note: Note) => void; settled: () => void;
}) => {
  const selected = new Map<string, Note>();
  let review: Review | null = null, project: RefPicker.RefPickerSelection | null = null, contact: RefPicker.RefPickerSelection | null = null;
  let busy = false, disposed = false, sequence = 0, error = '';
  let pending: Promise<void> = Promise.resolve();
  let focusRequest: { key: string; direct?: true } | null = null;
  const enabled = () => !!deps.get && !!deps.listSources && !!deps.update;
  const rows = () => deps.rows().filter((r): r is Note => r._kind === 'note');
  const paint = () => { if (!disposed) deps.render(); };
  const choose = (kind: 'project' | 'contact', value: RefPicker.RefPickerSelection | null) => {
    if (busy || review || disposed) return;
    if (kind === 'project') project = value ? { ...value } : null; else contact = value ? { ...value } : null;
    error = ''; paint();
  };
  const projectPicker = createTaskBulkProjectPicker({ search: deps.search, choose: value => choose('project', value),
    picker: { id: 'note-bulk-project', label: 'Project for selected notes', focusAttr: NOTE_BULK_FOCUS } });
  const contactPicker = createTaskBulkContactPicker({ search: deps.contactList, choose: value => choose('contact', value),
    picker: { id: 'note-bulk-contact', label: 'Contact for selected notes', focusAttr: NOTE_BULK_FOCUS } });
  const reset = () => {
    if (busy) return;
    sequence++; selected.clear(); review = null; error = ''; project = null; contact = null; focusRequest = null;
    projectPicker.reset(); contactPicker.reset();
  };
  const readTarget = async (kind: 'project' | 'contact', id: string, sources: readonly SourceRegistration[]): Promise<Target> => {
    if (kind === 'project') {
      const { entity } = await deps.get!({ kind: 'project', id });
      if (!availableTaskProject(entity, sources) || entity.id !== id
        || sources.find(s => s.id === entity.source_id)?.sync_posture === 'read_through') throw new Error('This saved project is unavailable. Choose an available project.');
      return { kind, value: { ...entity }, label: `${entity.title.trim() || 'Untitled project'} · ${sources.find(s => s.id === entity.source_id)?.source_label ?? 'Source unavailable'}` };
    }
    const { contact: person } = await deps.contactGet!({ email: id });
    if (!person?.contact_id || person.merged_into !== undefined || person.email !== id && person.contact_id !== id)
      throw new Error('This contact was removed, merged, or replaced. Choose the contact again.');
    return { kind, value: { ...person, contact_id: person.contact_id }, label: isMentionOnlyEmail(person.email)
      ? person.name?.trim() || 'Unnamed contact' : person.name?.trim() ? `${person.name.trim()} · ${person.email}` : person.email };
  };
  const sameTarget = (current: Target, original: Target, sources: readonly SourceRegistration[]) => current.kind === 'project' && original.kind === 'project'
    ? sameTaskProject(current.value, original.value, sources) : current.kind === 'contact' && original.kind === 'contact'
      && sameTaskContact(current.value, original.value);
  const preview = (kind: 'project' | 'contact', remove: boolean): void => {
    const choice = kind === 'project' ? project : contact;
    if (!choice || busy || review || disposed || !enabled() || !selected.size || !deps.ready() || kind === 'contact' && !deps.contactGet) return;
    const mine = ++sequence;
    const next: Review = { kind, remove, loading: true, rows: [], attempted: false };
    review = next; error = ''; focusRequest = { key: 'preview', direct: true }; paint();
    const current = () => !disposed && sequence === mine && review === next;
    pending = (async () => {
      try {
        const { sources } = await deps.listSources!(); if (!current()) return;
        const target = await readTarget(kind, choice.id, sources); if (!current()) return;
        next.target = target;
        // Bounded reads; retain the exact snapshots and tokens shown in review.
        const snapshots = [...selected.values()];
        for (let at = 0; at < snapshots.length; at += 4) {
          if (!current()) return;
          const batch = await Promise.all(snapshots.slice(at, at + 4).map(async (original: Note) => {
            try {
              const reply = await deps.get!({ kind: 'note', id: original.id });
              if (!sameNote(reply.entity, original)) throw new Error('This note was removed or replaced. Refresh the list.');
              const note = reply.entity, why = unavailable(note, sources), token = revision(reply);
              const message = why ?? (!token ? 'Update the server to change note links safely.' : undefined);
              const before = links(note, target).length, after = noteLinkChange(note, target, remove).length;
              return { note, ...(token ? { revision: token } : {}), state: message ? 'skipped' as const : achieved(note, target, remove) ? 'unchanged' as const : 'ready' as const,
                attempted: false, before, after, ...(message ? { message } : {}) };
            } catch (cause) { return { note: original, state: 'skipped' as const, attempted: false, message: humanizeRpcError(cause) }; }
          }));
          if (!current()) return; next.rows.push(...batch);
        }
      } catch (cause) { if (current()) next.error = humanizeRpcError(cause); }
      finally { if (current()) { next.loading = false; focusRequest = { key: 'preview' }; paint(); } }
    })();
  };
  const run = (retry: boolean, checkOnly = false): void => {
    const current = review;
    if (!current?.target || current.loading || current.error || busy || disposed || !deps.ready()) return;
    const target = current.target;
    const targets = current.rows.filter(row => retry ? row.state === (checkOnly ? 'unconfirmed' : 'failed') : row.state === 'ready');
    if (!targets.length || !retry && current.attempted) return;
    for (const row of current.rows) if (row.state === 'unchanged') selected.delete(row.note.id);
    busy = true; current.attempted = true; deps.begin(); focusRequest = { key: 'results', direct: true }; paint();
    pending = (async () => {
      for (const row of targets) {
        if (disposed) break;
        row.state = 'running'; row.message = undefined; paint();
        try {
          const [reply, { sources }] = await Promise.all([deps.get!({ kind: 'note', id: row.note.id }), deps.listSources!()]);
          if (disposed) break;
          const latest = await readTarget(target.kind, target.kind === 'project' ? target.value.id : target.value.contact_id, sources);
          if (disposed) break;
          if (!sameTarget(latest, target, sources)) { row.state = 'skipped'; row.message = 'The chosen relationship changed identity. Review this selection again.'; continue; }
          if (!sameNote(reply.entity, row.note)) { row.state = 'skipped'; row.message = 'This note was removed or replaced. Review it again.'; continue; }
          const note = reply.entity, why = unavailable(note, sources);
          if (note.pending_write && row.attempted) { row.state = 'unconfirmed'; row.message = 'Waiting for source confirmation. Check again later.'; continue; }
          if (why) { row.state = 'skipped'; row.message = why; continue; }
          if (achieved(note, target, current.remove)) { row.state = 'confirmed'; row.message = 'The requested link state is confirmed.'; selected.delete(row.note.id); deps.confirmed(note); continue; }
          if (checkOnly) { row.state = 'unconfirmed'; row.message = 'The requested link state is not confirmed. Review this note before another change.'; continue; }
          if (revision(reply) !== row.revision) { row.state = 'skipped'; row.message = 'This note changed since review. Review it again before saving.'; continue; }
          row.attempted = true;
          const patch = noteLinkChange(row.note, target, current.remove);
          const out = await deps.update!({ kind: 'note', id: note.id, expected_revision: row.revision!,
            ...(target.kind === 'project' ? { related_project_ids: patch } : { related_contact_ids: patch }) });
          if (disposed) break;
          if (!sameNote(out.entity, row.note) || !achieved(out.entity, target, current.remove) || out.entity.pending_write) {
            row.state = 'unconfirmed'; row.message = 'The requested link change is not confirmed. Check the note before retrying.';
          } else { row.state = 'confirmed'; row.message = 'Link change confirmed.'; selected.delete(row.note.id); deps.confirmed(out.entity); }
        } catch (cause) {
          if (disposed) break;
          row.state = 'failed'; row.message = humanizeRpcError(cause);
        }
      }
      busy = false;
      if (!disposed) { deps.settled(); focusRequest = { key: 'results' }; paint(); }
    })();
  };
  const selection = () => {
    const visible = rows(), reasons = new Map<string, string>();
    for (const note of visible) { const why = unavailable(note, deps.sources()); if (why) reasons.set(note.id, why); }
    if (!review && !busy && deps.ready()) for (const id of selected.keys()) if (!visible.some(n => n.id === id) || reasons.has(id)) selected.delete(id);
    return { selected_ids: new Set(selected.keys()), unavailable: reasons, busy: busy || review !== null || !deps.ready() };
  };
  const toggle = (id: string, checked: boolean) => {
    if (busy || review || disposed || !enabled() || !deps.ready()) return;
    const note = rows().find(n => n.id === id); if (!note || unavailable(note, deps.sources())) return;
    if (!checked) selected.delete(id); else if (selected.size < NOTE_BULK_LIMIT) selected.set(id, { ...note }); else error = `Select up to ${NOTE_BULK_LIMIT} notes at once.`;
    if (selected.size) deps.begin(); paint();
  };
  const focusAttr = (key: string) => `${NOTE_BULK_FOCUS}="${e(key)}"`;
  const button = (action: string, label: string, disabled = false, primary = false) => `<button type="button" class="data-button${primary ? ' data-button--primary' : ''}" data-action="note-bulk-${action}" ${focusAttr(action)}${disabled ? ' disabled' : ''}>${e(label)}</button>`;
  const render = () => {
    if (!enabled()) return '';
    const count = selected.size;
    if (review) {
      const changing = review.rows.filter(r => r.state === 'ready').length, failed = review.rows.filter(r => r.state === 'failed').length,
        unconfirmed = review.rows.filter(r => r.state === 'unconfirmed').length;
      return `<section class="note-bulk" aria-label="${review.attempted ? 'Note link results' : 'Note link review'}" tabindex="-1" ${focusAttr(review.attempted ? 'results' : 'preview')}${review.loading || busy ? ' aria-busy="true"' : ''}>
        <h3>${review.attempted ? 'Note link results' : `${review.remove ? 'Remove' : 'Add'} ${review.kind} links`}</h3>
        ${review.loading ? '<p role="status">Checking selected notes…</p>' : review.error ? `<p role="alert">${e(review.error)}</p>` : `
          <p>${e(review.target?.label ?? '')}</p>
          <p role="status" aria-live="polite">${review.attempted ? `${review.rows.filter(r => r.state === 'confirmed').length} confirmed · ${count} remaining selected`
            : `${changing} will change · ${review.rows.length - changing} unchanged or skipped`}</p>
          <p>Only this ${review.kind} link changes. The note text and other links are kept.</p>
          <ul aria-label="Selected notes">${review.rows.map(row => `<li data-note-bulk-result="${e(row.note.id)}" data-state="${row.state}">
            <div><strong>${e(row.note.title?.trim() || 'Untitled note')}</strong><p>${e(deps.sources().find(s => s.id === row.note.source_id)?.source_label ?? 'Source unavailable')}</p></div>
            <div>${row.before !== undefined ? `<p>${row.before} → ${row.after} linked ${review!.kind === 'project' ? 'projects' : 'contacts'}</p>` : ''}
            <strong>${({ ready: 'Ready', running: 'Saving…', confirmed: 'Confirmed', unchanged: 'Unchanged', failed: 'Failed', unconfirmed: 'Not confirmed', skipped: 'Skipped' } as const)[row.state]}</strong>
            ${row.message ? `<p>${e(row.message)}</p>` : ''}</div></li>`).join('')}</ul>`}
        <div class="note-bulk-buttons">${!review.attempted ? `${button('apply', 'Apply link changes', !changing || review.loading || !!review.error || !deps.ready(), true)}`
          : `${failed ? button('retry', 'Retry failed', busy || !deps.ready(), true) : ''}${unconfirmed ? button('check', 'Check unconfirmed', busy || !deps.ready()) : ''}`}
          ${button('back', 'Back to selection', busy)}${button('reset', 'Clear selection', busy)}</div>
      </section>`;
    }
    return `<section class="note-bulk${count ? '' : ' note-bulk--idle'}" aria-label="Note selection" tabindex="-1" ${focusAttr('selection')}>
      <div class="note-bulk-buttons"><strong role="status" aria-live="polite">${count} note${count === 1 ? '' : 's'} selected</strong>${button('all', 'Select shown', !deps.ready() || !rows().some(n => !unavailable(n, deps.sources())))}${count ? button('reset', 'Clear selection') : ''}</div>
      <p>Choose up to ${NOTE_BULK_LIMIT} available notes from the loaded results.</p>
      ${count ? `<div class="note-bulk-choices">
        <fieldset><legend>Project links</legend>${projectPicker.render(project)}<div class="note-bulk-buttons">${button('project-add', 'Preview adding project', !project || !deps.ready())}${button('project-remove', 'Preview removing project', !project || !deps.ready())}</div></fieldset>
        ${deps.contactGet && deps.contactList ? `<fieldset><legend>Contact links</legend>${contactPicker.render(contact)}<div class="note-bulk-buttons">${button('contact-add', 'Preview adding contact', !contact || !deps.ready())}${button('contact-remove', 'Preview removing contact', !contact || !deps.ready())}</div></fieldset>` : ''}</div>` : ''}
      ${error ? `<p role="alert">${e(error)}</p>` : ''}</section>`;
  };
  return { enabled, selection, render, toggle, reset,
    setProject: (value: RefPicker.RefPickerSelection | null) => choose('project', value),
    setContact: (value: RefPicker.RefPickerSelection | null) => choose('contact', value),
    snapshot: () => review?.rows.map(row => ({ ...row })) ?? [],
    handleAction(action: string) {
      if (!action.startsWith('note-bulk-')) return false;
      const key = action.slice('note-bulk-'.length); if (disposed || busy) return true;
      if (key === 'all' && !review && deps.ready()) {
        for (const note of rows()) if (!unavailable(note, deps.sources()) && selected.size < NOTE_BULK_LIMIT) selected.set(note.id, { ...note });
        if (selected.size) deps.begin(); paint();
      } else if (key === 'reset') { reset(); focusRequest = { key: 'all', direct: true }; paint(); }
      else if (key === 'back' && review) {
        sequence++; review = null; focusRequest = { key: 'selection', direct: true }; paint();
      } else if (key === 'apply') run(false);
      else if (key === 'retry') run(true);
      else if (key === 'check') run(true, true);
      else if (key === 'project-add' || key === 'project-remove') preview('project', key.endsWith('remove'));
      else if (key === 'contact-add' || key === 'contact-remove') preview('contact', key.endsWith('remove'));
      return true;
    },
    mount: (root: ParentNode) => { projectPicker.mount(root, project); contactPicker.mount(root, contact); },
    restoreFocus(root: ParentNode, key: string | null) {
      const request = focusRequest; focusRequest = null;
      if (disposed) return;
      const owned = request && (request.direct || key !== null), wanted = owned ? request.key : key;
      if (!wanted) return;
      const control = (wanted === 'project-search' || wanted === 'contact-search' ? root.querySelector<HTMLElement>(`[data-ref-picker="note-bulk-${wanted === 'project-search' ? 'project' : 'contact'}"] [data-ref-picker-input]`) : null)
        ?? root.querySelector<HTMLElement>(`[${NOTE_BULK_FOCUS}="${wanted.replace(/["\\]/g, '\\$&')}"]:not(:disabled)`);
      control?.focus({ preventScroll: !owned || wanted === key });
    },
    busy: () => busy, holdsList: () => selected.size > 0 || review !== null,
    whenSettled: () => pending,
    dispose() { disposed = true; sequence++; projectPicker.reset(); contactPicker.reset(); selected.clear(); },
  };
};
export type NoteBulkActions = ReturnType<typeof createNoteBulkActions>;
export const NOTE_BULK_STYLES = `
.note-bulk { display:grid; gap:12px; min-width:0; margin:16px 0; padding:16px; border:1px solid var(--border); border-radius:10px; }
.note-bulk :is(h3,p) { margin:0; overflow-wrap:anywhere; }
.note-bulk p { color:var(--muted); font-size:13px; }
.note-bulk .note-bulk-buttons { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
.note-bulk button { min-height:44px; }
.note-bulk .note-bulk-choices { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; min-width:0; }
.note-bulk fieldset { display:grid; gap:12px; min-width:0; border:1px solid var(--border); border-radius:8px; padding:12px; }
.note-bulk ul { list-style:none; display:grid; gap:12px; margin:0; padding:0; min-width:0; }
.note-bulk li { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; padding-top:12px; border-top:1px solid var(--border); min-width:0; overflow-wrap:anywhere; }
.note-bulk [role=alert],.note-bulk li[data-state=failed],.note-bulk li[data-state=skipped] { color:var(--danger); }
.work-entity-list-row:has(.work-entity-note-select) { display:grid; grid-template-columns:auto minmax(0,1fr); align-items:center; }
.work-entity-note-select { display:flex; align-items:center; justify-content:center; min-width:44px; min-height:44px; padding:8px; box-sizing:border-box; }
.work-entity-note-select input { width:20px; height:20px; accent-color:var(--accent); }
.work-entity-note-select span { position:absolute; width:1px; height:1px; padding:0; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
@media(max-width:600px) { .note-bulk .note-bulk-choices,.note-bulk li { grid-template-columns:minmax(0,1fr); } }
`;
