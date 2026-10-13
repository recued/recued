/** A setting that names one of the owner's mailboxes or calendars: the list of
 *  them the dish form and the run dialog offer, where they offered a text box
 *  the owner typed the name into (owner, 2026-10-12: each mailbox is already a
 *  connection, `data.mail.<name>`; what was missing was choosing one).
 *
 *  `renderVariableWidget` draws the row: a `<select>` holding the saved name
 *  until the list loads, so no value is lost to a slow list. This fills it.
 *  What is offered, and what a row starts on, are pure functions, so a test
 *  needs no DOM.
 *
 *  🔑 THE ONLY MAILBOX IS CHOSEN FOR THE OWNER, AND THE FORM SAVES IT. A setting
 *  that must hold a mailbox, holding none, starts on the only one that fits. It
 *  is saved like any value the owner chose, so a dish that runs on its own
 *  keeps sending from it after a second mailbox is added. A choice made when a
 *  run starts would move to "which one?" the day a second appears, and a
 *  scheduled run has nobody to ask. */

import type { MailboxCollection } from '@recued/contracts';

import { e } from './template.js';
import {
  MAILBOX_COLLECTION_ATTR,
  MAILBOX_OPTIONAL_ATTR,
  MAILBOX_SENDS_ATTR,
  MAILBOX_VARIABLE_ATTR,
  mailboxPlaceholder,
} from './variable-widgets.js';

/** One of the owner's mailboxes or calendars, as a setting offers it. */
export interface MailboxChoice {
  /** Its name under Connections: what `data.mail.<name>` reads, and what the
   *  setting holds. */
  readonly name: string;
  readonly collection: MailboxCollection;
  /** It can send mail now. Always false for a calendar. */
  readonly can_send: boolean;
  /** What tells it apart besides its name: a mailbox's address. */
  readonly detail?: string;
}

export interface MailboxVariableCallers {
  /** The owner's mailboxes, or calendars. */
  readonly list: (collection: MailboxCollection) => Promise<readonly MailboxChoice[]>;
}

/** What a row is: what it names, whether a step sends from it, whether it may
 *  be left empty, and the name it holds. */
export interface MailboxRow {
  readonly collection: MailboxCollection;
  readonly sends: boolean;
  readonly optional: boolean;
  readonly value: string;
}

export interface MailboxOption {
  readonly value: string;
  readonly label: string;
  readonly selected: boolean;
}

/** The owner's mailboxes (or calendars) a row may hold, by name: of what it
 *  names, and, where a step sends from it, able to send. */
export const eligibleMailboxes = (
  choices: readonly MailboxChoice[],
  row: Pick<MailboxRow, 'collection' | 'sends'>,
): MailboxChoice[] => choices
  .filter((choice) => choice.collection === row.collection && (!row.sends || choice.can_send))
  .sort((a, b) => a.name.localeCompare(b.name));

const noun = (collection: MailboxCollection): string => collection === 'calendar' ? 'calendar' : 'mailbox';

/** What a row's list offers. The held name stays, said as it is, when it is not
 *  one the row would offer (gone, or unable to send), and is never dropped: a
 *  save would lose it. With nothing held, the first line asks; with nothing to
 *  offer, it says where to add one. */
export const mailboxOptions = (
  choices: readonly MailboxChoice[],
  row: MailboxRow,
): MailboxOption[] => {
  const eligible = eligibleMailboxes(choices, row);
  const options: MailboxOption[] = eligible.map((choice) => ({
    value: choice.name,
    label: choice.detail !== undefined && choice.detail !== '' && choice.detail !== choice.name
      ? `${choice.name} — ${choice.detail}`
      : choice.name,
    selected: choice.name === row.value,
  }));
  if (row.value === '') {
    const first = row.optional || eligible.length > 0
      ? mailboxPlaceholder(row.collection, row.optional)
      : row.collection === 'calendar'
        ? 'No calendar yet. Add one under Connections → Calendar.'
        : row.sends
          ? 'No mailbox that can send yet. Add one under Connections → Mail.'
          : 'No mailbox yet. Add one under Connections → Mail.';
    return [{ value: '', label: first, selected: true }, ...options];
  }
  if (!options.some((option) => option.selected)) {
    const held = choices.find((choice) => choice.collection === row.collection && choice.name === row.value);
    options.unshift({
      value: row.value,
      label: held !== undefined ? `${row.value} — cannot send` : `Missing ${noun(row.collection)} — ${row.value}`,
      selected: true,
    });
  }
  return row.optional ? [{ value: '', label: mailboxPlaceholder(row.collection, true), selected: false }, ...options] : options;
};

/** The name a row starts on when it holds none: the only mailbox (or calendar)
 *  it may hold, when it must hold one. `null` otherwise: nothing to choose
 *  between is no reason to choose for the owner, and neither is a setting the
 *  recipe can run without. */
export const mailboxPrefill = (
  choices: readonly MailboxChoice[],
  row: MailboxRow,
): string | null => {
  if (row.value !== '' || row.optional) return null;
  const eligible = eligibleMailboxes(choices, row);
  return eligible.length === 1 ? eligible[0]!.name : null;
};

/** Each collection's list read once, for a surface that paints its rows more
 *  than once (the run dialog repaints on every change). */
export const memoMailboxCallers = (callers: MailboxVariableCallers): MailboxVariableCallers => {
  const lists = new Map<MailboxCollection, Promise<readonly MailboxChoice[]>>();
  return {
    list: (collection) => {
      let list = lists.get(collection);
      if (list === undefined) {
        list = callers.list(collection);
        lists.set(collection, list);
      }
      return list;
    },
  };
};

export interface MailboxVariablesHandle {
  destroy(): void;
}

/** Fill every mailbox row under `root` from the owner's mailboxes and
 *  calendars, and start a row that must hold one, holding none, on the only one
 *  that fits (`onChange`, so the form saves it). A list that cannot load turns
 *  its rows back into the text box they were, holding what they held: the owner
 *  can still type a name. */
export const wireMailboxVariables = (
  root: Element,
  opts: {
    readonly callers: MailboxVariableCallers;
    readonly onChange: (key: string, name: string) => void;
  },
): MailboxVariablesHandle => {
  if (typeof root.querySelectorAll !== 'function') return { destroy: () => undefined };
  const rows = Array.from(root.querySelectorAll<HTMLElement>(`[${MAILBOX_VARIABLE_ATTR}]`));
  if (rows.length === 0) return { destroy: () => undefined };
  let destroyed = false;

  const rowOf = (element: HTMLElement, select: HTMLSelectElement): MailboxRow => ({
    collection: element.getAttribute(MAILBOX_COLLECTION_ATTR) === 'calendar' ? 'calendar' : 'mail',
    sends: element.hasAttribute(MAILBOX_SENDS_ATTR),
    optional: element.hasAttribute(MAILBOX_OPTIONAL_ATTR),
    value: select.value,
  });
  const selectOf = (element: HTMLElement): HTMLSelectElement | null =>
    element.querySelector<HTMLSelectElement>('select[data-var-type="mailbox"]');

  const paint = (element: HTMLElement, choices: readonly MailboxChoice[]): void => {
    const select = selectOf(element);
    const key = element.getAttribute(MAILBOX_VARIABLE_ATTR);
    if (select === null || key === null) return;
    const row = rowOf(element, select);
    const start = mailboxPrefill(choices, row);
    const value = start ?? row.value;
    select.innerHTML = mailboxOptions(choices, { ...row, value })
      .map((option) => `<option value="${e(option.value)}"${option.selected ? ' selected' : ''}>${e(option.label)}</option>`)
      .join('');
    select.value = value;
    if (start !== null) opts.onChange(key, start);
  };

  const asTextBox = (element: HTMLElement): void => {
    const select = selectOf(element);
    if (select === null || typeof element.ownerDocument?.createElement !== 'function') return;
    const input = element.ownerDocument.createElement('input');
    input.type = 'text';
    input.id = select.id;
    input.value = select.value;
    input.setAttribute('data-var-key', select.getAttribute('data-var-key') ?? '');
    input.setAttribute('data-var-type', 'mailbox');
    select.replaceWith(input);
  };

  const collections = [...new Set(rows.map((element) =>
    element.getAttribute(MAILBOX_COLLECTION_ATTR) === 'calendar' ? 'calendar' as const : 'mail' as const))];
  for (const collection of collections) {
    const mine = rows.filter((element) =>
      (element.getAttribute(MAILBOX_COLLECTION_ATTR) === 'calendar' ? 'calendar' : 'mail') === collection);
    void opts.callers.list(collection).then(
      (choices) => { if (!destroyed) for (const element of mine) paint(element, choices); },
      () => { if (!destroyed) for (const element of mine) asTextBox(element); },
    );
  }
  return { destroy: () => { destroyed = true; } };
};
