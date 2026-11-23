import { isMentionOnlyEmail, type ContactRecord, type WorkEntity } from '@recued/contracts';
import { RefPicker } from '@recued/ui-shared';
import type { DataContactGetCaller, DataContactListCaller } from './bootstrap-data-route.js';

type Task = Extract<WorkEntity, { _kind: 'task' }>;
export type TaskContactChange = { from: string; to: string };

const availableContact = (contact: ContactRecord | null): contact is ContactRecord =>
  !!contact?.contact_id && !!contact.email && contact.merged_into === undefined;

export const sameTaskContact = (contact: ContactRecord | null, target: ContactRecord): boolean =>
  availableContact(contact) && contact.contact_id === target.contact_id && contact.email === target.email
  && contact.created_at === target.created_at;

export const taskHasContact = (task: Task, target: ContactRecord | null): boolean => target
  ? task.assigned_contact_id === target.email || task.assigned_contact_id === target.contact_id
  : !task.assigned_contact_id;

const contactLabel = (contact: ContactRecord): string => isMentionOnlyEmail(contact.email)
  ? contact.name?.trim() || 'Unnamed contact'
  : contact.name?.trim() ? `${contact.name.trim()} · ${contact.email}` : contact.email;

/** The review pins the actual contact identity, never a name returned by search.
 * Missing old references remain visible as unavailable contacts, not unassigned. */
export const loadTaskContactPreview = async (deps: {
  tasks: readonly Task[]; targetId?: string; get: DataContactGetCaller;
  current: () => boolean; unavailable: (task: Task) => string | undefined;
}) => {
  if (!deps.current()) return null;
  let target: ContactRecord | null = null;
  const names = new Map<string, string>();
  if (deps.targetId !== undefined) {
    const { contact } = await deps.get({ email: deps.targetId });
    if (!deps.current()) return null;
    if (!availableContact(contact) || contact.email !== deps.targetId) {
      throw new Error('This contact is unavailable or changed identity. Search for the contact again.');
    }
    target = { ...contact };
    names.set(target.email, contactLabel(target)); names.set(target.contact_id!, contactLabel(target));
  }
  const ids = [...new Set(deps.tasks.map(task => task.assigned_contact_id).filter((id): id is string => !!id))].filter(id => !names.has(id));
  for (let index = 0; index < ids.length; index += 8) {
    if (!deps.current()) return null;
    await Promise.all(ids.slice(index, index + 8).map(async id => {
      try {
        const { contact } = await deps.get({ email: id });
        names.set(id, availableContact(contact) ? contactLabel(contact) : 'Unavailable contact');
      } catch { names.set(id, 'Contact name unavailable'); }
    }));
  }
  if (!deps.current()) return null;
  const to = target ? contactLabel(target) : 'No assigned contact';
  return { target, rows: deps.tasks.map(task => ({ task,
    contactChange: { from: task.assigned_contact_id ? names.get(task.assigned_contact_id)! : 'No assigned contact', to },
    message: deps.unavailable(task) ?? (taskHasContact(task, target)
      ? target ? 'Already assigned to this contact.' : 'Already has no assigned contact.' : undefined),
  })) };
};

/** Share the existing contact search and combobox, retaining its query across
 * host renders. No free-text address becomes a committed assignment. */
export const createTaskBulkContactPicker = (deps: {
  search?: DataContactListCaller; choose: (value: RefPicker.RefPickerSelection | null) => void;
  picker?: { id: string; label: string; focusAttr: string };
}) => {
  const config: RefPicker.RefPickerRenderConfig = { pickerId: deps.picker?.id ?? 'task-bulk-contact', ariaLabel: deps.picker?.label ?? 'Assigned contact for selected tasks',
    placeholder: 'Search contacts by name or email', emptyText: 'No matching contacts.', truncatedText: 'More contacts match. Type a more specific name or email.' };
  let handle: RefPicker.RefPickerHandle | undefined;
  const queries = new Map<string, string>();
  const detach = () => { handle?.destroy(); handle = undefined; };
  const reset = () => { detach(); queries.clear(); };
  return { reset,
    render: (selection: RefPicker.RefPickerSelection | null) => RefPicker.renderRefPicker(RefPicker.initialRefPickerState(selection), config),
    mount(root: ParentNode, selection: RefPicker.RefPickerSelection | null) {
      const shell = root.querySelector?.<HTMLElement>(`[data-ref-picker="${config.pickerId}"]`);
      if (!shell) { detach(); return; }
      if (handle) handle.rewire(root);
      else handle = RefPicker.wireRefPicker(root, { config, initialValue: selection,
        search: async query => {
          if (!deps.search) return { options: [], retryableError: 'Contact search is unavailable on this server.' };
          const selected = handle?.getValue();
          const actual = selected && query === selected.label ? queries.get(selected.id) ?? query : query;
          if (!actual.trim()) return { options: [] };
          try {
            const page = await deps.search({ query: actual.trim(), limit: 20, offset: 0 });
            if (!Array.isArray(page.contacts) || page.contacts.length > 20 || !Number.isSafeInteger(page.total) || page.total < page.contacts.length
              || page.contacts.some(contact => !availableContact(contact)) || new Set(page.contacts.map(contact => contact.email)).size !== page.contacts.length) {
              throw new Error('The contact search could not be confirmed. Try again.');
            }
            for (const contact of page.contacts) queries.set(contact.email, actual);
            return { options: page.contacts.map(contact => ({ id: contact.email, label: contactLabel(contact) })), truncated: page.total > page.contacts.length };
          } catch (failure) {
            return { options: [], retryableError: failure instanceof Error ? failure.message : 'Contacts could not be searched. Try again.' };
          }
        }, onChange: deps.choose });
      shell.querySelector('[data-ref-picker-input]')?.setAttribute(deps.picker?.focusAttr ?? 'data-task-bulk-focus', 'contact-search');
    },
  };
};
