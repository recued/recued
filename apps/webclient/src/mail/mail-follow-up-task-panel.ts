import { calendarDayMs, TASK_TITLE_MAX, type MailFollowUp, type MailFollowUpTaskView, type MailFollowUpTaskSet, type MailFollowUpTaskCreate } from '@recued/contracts';
import { e, RefPicker } from '@recued/ui-shared';
import { searchTaskReferences } from '../data/work-reference-picker.js';
import { classifyRpcError, humanizeRpcError } from '../shell/rpc-error-copy.js';
import { serializeShellRoute } from '../shell/route.js';
import type { MailFollowUpCallers } from './mail-follow-up-surface.js';

export const createMailFollowUpTaskPanel = (options: {
  parent: HTMLElement; watch: MailFollowUp; callers: NonNullable<MailFollowUpCallers['tasks']>;
  current(): boolean; busy(): boolean; editing(value: boolean, dirty: boolean): void;
  run(task: () => Promise<void>): Promise<void>; updated(watch: MailFollowUp): void; navigate(href: string): void;
}) => {
  const doc = options.parent.ownerDocument, section = doc.createElement('section'); section.hidden = true;
  section.setAttribute('aria-label', 'Linked task'); options.parent.append(section);
  let disposed = false, view: MailFollowUpTaskView | null = null, picker: RefPicker.RefPickerHandle | undefined;
  type Pending = { kind: 'set'; args: MailFollowUpTaskSet } | { kind: 'create'; args: MailFollowUpTaskCreate };
  let pending: Pending | undefined, editor = false, creating = false, readSequence = 0;
  const current = () => !disposed && options.current() && section.isConnected;
  const button = (label: string, click: () => void) => {
    const b = doc.createElement('button'); b.type = 'button'; b.className = 'data-button'; b.textContent = label;
    b.addEventListener('click', () => { if (current() && !options.busy()) click(); }); return b;
  };
  const error = (cause: unknown) => {
    if (!current()) return;
    let node = section.querySelector<HTMLElement>('[data-task-link-error]');
    if (!node) { node = doc.createElement('p'); node.dataset.taskLinkError = ''; node.setAttribute('role', 'alert'); section.append(node); }
    node.textContent = humanizeRpcError(cause);
  };
  const persist = (make?: () => Pending) => {
    if (!view || options.busy()) return;
    readSequence++;
    pending ??= make?.(); if (!pending) return;
    options.editing(true, true);
    void options.run(async () => {
      try {
        const updated = pending!.kind === 'set' ? await options.callers.set(pending!.args)
          : await options.callers.create!(pending!.args);
        if (current()) { pending = undefined; options.editing(false, false); options.updated(updated); }
      } catch (cause) {
        if (current()) {
          if (['conflict', 'bad_request', 'resource_changed', 'forbidden'].includes(classifyRpcError(cause).code ?? '')) {
            pending = undefined; options.editing(editor, editor);
            for (const field of section.querySelectorAll<HTMLElement>('[data-ref-picker],[data-task-create-fields],[data-task-link-choice]')) field.inert = false;
            section.querySelector('[data-task-link-uncertain]')?.remove();
            const save = section.querySelector<HTMLButtonElement>('[data-task-link-save]'); if (save) save.textContent = creating ? 'Create and link task' : editor ? 'Save task link' : 'Unlink task';
            if (!editor && !section.querySelector('[data-task-link-retry]')) {
              const retry = button('Retry linked task', () => void load()); retry.dataset.taskLinkRetry = ''; section.append(retry);
            }
          }
          else {
            if (!section.querySelector('[data-task-link-uncertain]')) {
              const note = doc.createElement('p'); note.dataset.taskLinkUncertain = ''; note.textContent = 'The save outcome is not confirmed. Check save retries the same request.'; section.append(note);
            }
            for (const field of section.querySelectorAll<HTMLElement>('[data-ref-picker],[data-task-create-fields],[data-task-link-choice]')) field.inert = true;
          }
          const save = section.querySelector<HTMLButtonElement>('[data-task-link-save]'); if (save && pending) save.textContent = 'Check save';
          error(cause);
        }
      }
    });
  };
  const set = (taskId: string | null) => persist(() => ({ kind: 'set', args: {
    id: view!.watch.id, expected_revision: view!.watch.revision, task_id: taskId, request_id: doc.defaultView!.crypto.randomUUID(),
  } }));
  const cancelEditor = () => { pending = undefined; picker?.destroy(); picker = undefined; options.editing(false, false); void load(); };
  const renderEditor = () => {
    if (!view || !current()) return;
    readSequence++;
    picker?.destroy(); picker = undefined; editor = true; creating = false; options.editing(true, false);
    const initial = view.task && !view.task.done ? { id: view.task.ref.id, label: view.task.title } : null;
    section.innerHTML = `<h3>Link an existing task</h3><p>This adds a link to the reply watch. It does not change or complete the task.</p>${RefPicker.renderRefPicker(RefPicker.initialRefPickerState(initial), {
      pickerId: 'reply-watch-task', ariaLabel: 'Find an existing task', placeholder: 'Search tasks by name',
    })}`;
    const save = button('Save task link', () => { const selected = picker?.getValue(); if (pending) persist(); else if (selected) set(selected.id); });
    save.dataset.taskLinkSave = ''; save.disabled = !initial;
    const cancel = button('Cancel', cancelEditor);
    section.append(save, cancel);
    picker = RefPicker.wireRefPicker(section, { config: { pickerId: 'reply-watch-task', ariaLabel: 'Find an existing task' }, initialValue: initial,
      search: query => searchTaskReferences(options.callers.search, query),
      onChange: selection => { options.editing(true, true); save.disabled = !selection && !pending; },
    });
    section.querySelector<HTMLInputElement>('[data-ref-picker-input]')?.focus();
  };
  const renderCreate = () => {
    if (!view?.can_create || !options.callers.create || !current() || pending) return;
    readSequence++; picker?.destroy(); picker = undefined; editor = true; creating = true; options.editing(true, false);
    section.innerHTML = `<h3>Create a linked task</h3><p>The task will be saved in Recued with a link to the watched email.</p>
      <div data-task-create-fields><p><label>Task title<input type="text" data-task-create-title required maxlength="${TASK_TITLE_MAX}" value="${e(('Follow up: ' + (view.watch.subject.trim() || 'email')).slice(0, TASK_TITLE_MAX))}"></label></p>
      <p><label>Due date (optional)<input type="date" data-task-create-due></label></p></div>`;
    const title = section.querySelector<HTMLInputElement>('[data-task-create-title]')!, due = section.querySelector<HTMLInputElement>('[data-task-create-due]')!;
    for (const field of [title, due]) field.addEventListener('input', () => options.editing(true, true));
    const save = button('Create and link task', () => {
      if (pending) { persist(); return; }
      if (!title.reportValidity() || !due.reportValidity()) return;
      if (!title.value.trim() || due.value && calendarDayMs(due.value) === null) { error(Error('Enter a task title and a valid due date.')); return; }
      const url = new URL(doc.defaultView!.location.href); url.search = ''; url.hash = ''; url.username = ''; url.password = '';
      persist(() => ({ kind: 'create', args: { id: view!.watch.id, expected_revision: view!.watch.revision,
        request_id: doc.defaultView!.crypto.randomUUID(), title: title.value.trim(), ...(due.value ? { due_on: due.value } : {}), client_url: url.href } }));
    });
    save.dataset.taskLinkSave = ''; section.append(save, button('Cancel', cancelEditor)); title.focus();
  };
  const render = () => {
    if (!view || !current()) return;
    picker?.destroy(); picker = undefined; editor = false; creating = false;
    section.hidden = !view.available && !view.watch.task_ref;
    if (section.hidden) return;
    section.innerHTML = `<h3>Linked task</h3>${view.task ? `<p><a href="${e(serializeShellRoute('data', 'task', view.task.ref.id))}" data-linked-task>${e(view.task.title)}</a> · ${view.task.done ? 'Completed' : 'Open'}</p>`
      : `<p>${e(view.reason ?? (view.watch.task_ref ? 'The linked task cannot be checked on this server.' : 'Link the work you are waiting on to this reply watch.'))}</p>`}`;
    section.querySelector<HTMLAnchorElement>('[data-linked-task]')?.addEventListener('click', event => {
      if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); if (!options.busy() && current()) options.navigate((event.currentTarget as HTMLAnchorElement).hash);
    });
    if (view.available) { const choose = button(view.watch.task_ref ? 'Change linked task' : 'Link a task', renderEditor); choose.dataset.taskLinkChoice = ''; section.append(choose); }
    if (view.can_create && options.callers.create) { const create = button('Create task', renderCreate); create.dataset.taskLinkChoice = ''; section.append(create); }
    if (view.watch.task_ref) { const unlink = button('Unlink task', () => set(null)); unlink.dataset.taskLinkSave = ''; section.append(unlink); }
    if (view.reason) section.append(button('Retry linked task', () => void load()));
  };
  const load = async () => {
    const sequence = ++readSequence;
    try {
      const result = await options.callers.get({ id: options.watch.id });
      if (!current() || sequence !== readSequence) return;
      if (result.watch.id !== options.watch.id) throw Error('The linked task could not be confirmed.');
      view = result; render();
    } catch (cause) {
      if (!current() || sequence !== readSequence || classifyRpcError(cause).code === 'unknown_method') return;
      section.hidden = false; section.innerHTML = '<h3>Linked task</h3>'; error(cause); section.append(button('Retry linked task', () => void load()));
    }
  };
  void load();
  return { dispose() { disposed = true; picker?.destroy(); section.remove(); } };
};
