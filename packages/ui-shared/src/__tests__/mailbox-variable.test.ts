/** A setting that names one of the owner's mailboxes or calendars: the row the
 *  settings forms draw for it, what its list offers, and the one it starts on.
 *  The DOM wiring (`wireMailboxVariables`) is driven in Chrome; what it decides
 *  is here. */

import { describe, expect, it, vi } from 'vitest';

import type { MailboxSetting, ServerRecipeListEntry, VariableDefault } from '@recued/contracts';

import {
  eligibleMailboxes,
  mailboxOptions,
  mailboxPrefill,
  memoMailboxCallers,
  type MailboxChoice,
} from '../mailbox-variable.js';
import { initialRunModalState } from '../run-modal/model.js';
import { renderRunModal } from '../run-modal/render.js';
import {
  asMailboxWidget,
  MAILBOX_COLLECTION_ATTR,
  MAILBOX_OPTIONAL_ATTR,
  MAILBOX_SENDS_ATTR,
  MAILBOX_VARIABLE_ATTR,
  renderVariableWidget,
  toWidgetShape,
  validateWidgetValue,
} from '../variable-widgets.js';

const sendFrom = { label: 'Mail account slug', type: 'string', default: '' } as unknown as VariableDefault;
const calendar = { label: 'Calendar', type: 'string', default: '', optional: true } as unknown as VariableDefault;
const settings: MailboxSetting[] = [
  { key: 'sender_mail_instance', collection: 'mail', sends: true },
  { key: 'calendar_slug', collection: 'calendar', sends: false },
];

const choices: MailboxChoice[] = [
  { name: 'work', collection: 'mail', can_send: true, detail: 'me@work.test' },
  { name: 'archive', collection: 'mail', can_send: false, detail: 'me@archive.test' },
  { name: 'home', collection: 'mail', can_send: true, detail: 'me@home.test' },
  { name: 'family', collection: 'calendar', can_send: false },
];

const row = (key: string, def: VariableDefault, value?: unknown) =>
  asMailboxWidget(toWidgetShape(key, def, value), settings);

describe('the row', () => {
  it('is a list holding the saved name until the owner’s mailboxes load: never a lost value', () => {
    const html = renderVariableWidget(row('sender_mail_instance', sendFrom, 'work'), { mailboxPicker: true });
    expect(html).toContain(`${MAILBOX_VARIABLE_ATTR}="sender_mail_instance"`);
    expect(html).toContain(`${MAILBOX_COLLECTION_ATTR}="mail"`);
    expect(html).toContain(`${MAILBOX_SENDS_ATTR}=""`);
    expect(html).not.toContain(MAILBOX_OPTIONAL_ATTR);
    expect(html).toMatch(/<select[^>]*data-var-key="sender_mail_instance"[^>]*data-var-type="mailbox"/);
    expect(html).toContain('<option value="work" selected>work</option>');
  });

  it('asks with nothing saved: a mailbox, a calendar, or Not set where it may stay empty', () => {
    expect(renderVariableWidget(row('sender_mail_instance', sendFrom), { mailboxPicker: true }))
      .toContain('<option value="" selected>Choose a mailbox</option>');
    const optional = renderVariableWidget(row('calendar_slug', calendar), { mailboxPicker: true });
    expect(optional).toContain('<option value="" selected>Not set</option>');
    expect(optional).toContain(`${MAILBOX_OPTIONAL_ATTR}=""`);
    expect(optional).toContain(`${MAILBOX_COLLECTION_ATTR}="calendar"`);
    expect(optional).not.toContain(MAILBOX_SENDS_ATTR);
  });

  it('is the text box it was where the host has no list to offer', () => {
    const html = renderVariableWidget(row('sender_mail_instance', sendFrom, 'work'));
    expect(html).toMatch(/<input[^>]*type="text"[^>]*data-var-key="sender_mail_instance"[^>]*data-var-type="mailbox"[^>]*value="work"/s);
    expect(html).not.toContain('<select');
  });

  it('only a text setting the server named becomes a list', () => {
    expect(row('tone', { label: 'Tone', type: 'string' } as unknown as VariableDefault).type).toBe('text');
    const choice = asMailboxWidget(
      toWidgetShape('sender_mail_instance', { label: 'From', type: 'enum', options: ['a', 'b'] } as unknown as VariableDefault),
      settings,
    );
    expect(choice.type).toBe('select');
    expect(asMailboxWidget(toWidgetShape('sender_mail_instance', sendFrom), undefined).type).toBe('text');
  });

  it('must be chosen unless optional', () => {
    const shape = row('sender_mail_instance', sendFrom);
    expect(validateWidgetValue(shape, '')).toBe('Required');
    expect(validateWidgetValue(shape, 'work')).toBeNull();
    expect(validateWidgetValue(row('calendar_slug', calendar), '')).toBeNull();
  });
});

describe('what the list offers', () => {
  const send = { collection: 'mail', sends: true, optional: false } as const;

  it('to send from: the mailboxes that can send, by name, each with its address', () => {
    expect(eligibleMailboxes(choices, send).map((choice) => choice.name)).toEqual(['home', 'work']);
    expect(mailboxOptions(choices, { ...send, value: 'work' })).toEqual([
      { value: 'home', label: 'home — me@home.test', selected: false },
      { value: 'work', label: 'work — me@work.test', selected: true },
    ]);
  });

  it('to read: every mailbox; a calendar setting: the calendars', () => {
    expect(eligibleMailboxes(choices, { collection: 'mail', sends: false }).map((choice) => choice.name))
      .toEqual(['archive', 'home', 'work']);
    expect(mailboxOptions(choices, { collection: 'calendar', sends: false, optional: true, value: '' })).toEqual([
      { value: '', label: 'Not set', selected: true },
      { value: 'family', label: 'family', selected: false },
    ]);
  });

  it('⛔ keeps a held name it would not offer, saying why: a save must not drop it', () => {
    expect(mailboxOptions(choices, { ...send, value: 'archive' })[0])
      .toEqual({ value: 'archive', label: 'archive — cannot send', selected: true });
    expect(mailboxOptions(choices, { ...send, value: 'old-work' })[0])
      .toEqual({ value: 'old-work', label: 'Missing mailbox — old-work', selected: true });
    expect(mailboxOptions(choices, { collection: 'calendar', sends: false, optional: false, value: 'gone' })[0])
      .toEqual({ value: 'gone', label: 'Missing calendar — gone', selected: true });
  });

  it('with nothing to offer, says where to add one', () => {
    expect(mailboxOptions([], { ...send, value: '' }))
      .toEqual([{ value: '', label: 'No mailbox that can send yet. Add one under Connections → Mail.', selected: true }]);
    expect(mailboxOptions([], { collection: 'mail', sends: false, optional: false, value: '' })[0]!.label)
      .toBe('No mailbox yet. Add one under Connections → Mail.');
    expect(mailboxOptions([], { collection: 'calendar', sends: false, optional: false, value: '' })[0]!.label)
      .toBe('No calendar yet. Add one under Connections → Calendar.');
  });

  it('an optional setting holding a name can still be emptied', () => {
    expect(mailboxOptions(choices, { collection: 'calendar', sends: false, optional: true, value: 'family' })[0])
      .toEqual({ value: '', label: 'Not set', selected: false });
  });
});

describe('the one it starts on', () => {
  const send = { collection: 'mail', sends: true, optional: false, value: '' } as const;
  const one = choices.filter((choice) => choice.name !== 'home');

  it('the only mailbox that can send, for a setting that must be set and holds none', () => {
    expect(mailboxPrefill(one, send)).toBe('work');
  });

  it('nothing when there is a choice to make, nothing to choose, or nothing needed', () => {
    expect(mailboxPrefill(choices, send)).toBeNull();
    expect(mailboxPrefill(choices.filter((choice) => !choice.can_send), send)).toBeNull();
    expect(mailboxPrefill(one, { ...send, optional: true })).toBeNull();
    expect(mailboxPrefill(one, { ...send, value: 'old-work' })).toBeNull();
  });

  it('a mailbox to read counts the ones that cannot send', () => {
    expect(mailboxPrefill(one, { ...send, sends: false })).toBeNull();
    expect(mailboxPrefill(one.filter((choice) => choice.name === 'archive'), { ...send, sends: false })).toBe('archive');
  });
});

describe('each list is read once', () => {
  it('per collection, for a surface that repaints', async () => {
    const list = vi.fn(async (collection: string) => choices.filter((choice) => choice.collection === collection));
    const callers = memoMailboxCallers({ list });
    await callers.list('mail');
    await callers.list('mail');
    await callers.list('calendar');
    expect(list.mock.calls.map(([collection]) => collection)).toEqual(['mail', 'calendar']);
  });
});

describe('the run dialog', () => {
  const entry = {
    recipe_id: 'reply-from-mail',
    publisher_id: 'recued-core',
    version: 1,
    recipe_hash: 'h',
    recipe: {
      recipe_id: 'reply-from-mail',
      version: 1,
      metadata: { name: 'Reply from mail', description: 'x', author: 'test', supported_platforms: [] },
      variables: { sender_mail_instance: sendFrom },
      output: { sidebar: [] },
    },
    mailbox_settings: settings,
    source: 'bundled',
    installed_at: 0,
  } as unknown as ServerRecipeListEntry;
  const state = { ...initialRunModalState('run', '0 9 * * *'), schedules: [], triggers: [] } as never;

  it('offers the list where the host can list mailboxes, and the text box where it cannot', () => {
    const caps = { canExecute: true, canSchedule: true, canTrigger: true };
    expect(renderRunModal(state, entry, { ...caps, canPickMailboxes: true }))
      .toMatch(/<select[^>]*data-var-key="sender_mail_instance"[^>]*data-var-type="mailbox"/);
    expect(renderRunModal(state, entry, caps))
      .toMatch(/<input[^>]*data-var-key="sender_mail_instance"[^>]*data-var-type="mailbox"/s);
  });
});
