/** Which of a recipe's settings name one of the owner's mailboxes or calendars,
 *  from how its steps use them (`recipeMailboxSettings`). The shipped recipes
 *  are measured in `mailbox-settings-corpus.test.ts`. */

import { describe, expect, it } from 'vitest';

import { KERNEL_OP_REGISTRY } from '../kernel-op-registry.js';
import { MAILBOX_ARGUMENT_OPS, recipeMailboxSettings } from '../mailbox-settings.js';

const text = (label: string): Record<string, unknown> => ({ label, type: 'string', default: '' });

const send = (sender: string): Record<string, unknown> => ({
  id: 'send',
  op: 'core.mail.send',
  args: { sender_mail_instance: sender, to: ['a@example.test'], subject: 'Hi', body: 'Hi' },
});

describe('a setting a mail send takes its mailbox from', () => {
  it('straight from the setting: a mailbox that sends', () => {
    expect(recipeMailboxSettings({
      variables: { sender_mail_instance: text('Mail account slug') },
      steps: [send('{{config.sender_mail_instance}}')],
    })).toEqual([{ key: 'sender_mail_instance', collection: 'mail', sends: true }]);
  });

  it('through a trim, a default, a defaults field or a coalesce: each hands the setting on', () => {
    const through = (hop: Record<string, unknown>, ref: string) => recipeMailboxSettings({
      variables: { sender: text('Send from') },
      steps: [{ id: 'hop', ...hop }, send(ref)],
    });
    const found = [{ key: 'sender', collection: 'mail', sends: true }];
    expect(through({ transform: 'trim', input: '{{config.sender}}' }, '{{step.hop}}')).toEqual(found);
    expect(through({ transform: 'default', value: '{{config.sender}}', fallback: '' }, '{{step.hop}}')).toEqual(found);
    expect(through({ transform: 'default', value: '{{step.other}}', fallback: '{{config.sender}}' }, '{{step.hop}}'))
      .toEqual(found);
    expect(through({ transform: 'defaults', fields: { from: { value: '{{config.sender}}', fallback: '' } } },
      '{{step.hop.from}}')).toEqual(found);
    expect(through({ transform: 'coalesce', values: ['{{step.record.sender}}', '{{config.sender}}'] }, '{{step.hop}}'))
      .toEqual(found);
  });

  it('the seller recipes: declared as a notification connection, handed to the send as a mailbox', () => {
    expect(recipeMailboxSettings({
      variables: {
        sender_mail: { label: 'Sender mail connection', type: 'connection', connection_kind: 'notification', default: '' },
      },
      steps: [
        { id: 'sender_name', transform: 'default', value: '{{config.sender_mail}}', fallback: '' },
        send('{{step.sender_name}}'),
      ],
    })).toEqual([{ key: 'sender_mail', collection: 'mail', sends: true }]);
  });

  it('a kernel step lowered onto its ingredient, as an installed recipe may hold it', () => {
    expect(recipeMailboxSettings({
      variables: { sender: text('Send from') },
      steps: [{ id: 'send', ingredient: 'mail-send', input: { sender_mail_instance: '{{config.sender}}' } }],
    })).toEqual([{ key: 'sender', collection: 'mail', sends: true }]);
  });
});

describe('a setting a step reads a mailbox or a calendar from', () => {
  it('a mailbox to read, and a calendar', () => {
    expect(recipeMailboxSettings({
      variables: { mail_slug: text('Mailbox to read'), calendar_slug: { ...text('Calendar'), optional: true } },
      prefetch_steps: [
        { id: 'mail', op: 'core.mail.email.list', args: { slug: '{{config.mail_slug}}', limit: 10 } },
        { id: 'events', op: 'core.data.calendar.list', args: { slug: '{{config.calendar_slug}}' } },
      ],
    })).toEqual([
      { key: 'mail_slug', collection: 'mail', sends: false },
      { key: 'calendar_slug', collection: 'calendar', sends: false },
    ]);
  });

  it('a calendar the time watcher watches, from the trigger steps', () => {
    expect(recipeMailboxSettings({
      variables: { calendar_slug: text('Calendar') },
      trigger_steps: [{
        id: 'upcoming',
        op: 'core.watch.time-relative',
        args: { collection: 'data.calendar', instance: '{{config.calendar_slug}}', anchor_field: 'start_at' },
      }],
      steps: [],
    })).toEqual([{ key: 'calendar_slug', collection: 'calendar', sends: false }]);
  });

  it('one read from and sent from is a mailbox that sends', () => {
    expect(recipeMailboxSettings({
      variables: { sender_mail_instance: text('Mail account slug') },
      // The send first: a later read must not undo it.
      steps: [
        send('{{config.sender_mail_instance}}'),
        { id: 'mail', op: 'core.mail.get', args: { slug: '{{config.sender_mail_instance}}', record_id: '{{context.entity_id}}' } },
      ],
    })).toEqual([{ key: 'sender_mail_instance', collection: 'mail', sends: true }]);
  });
});

describe('what is left alone', () => {
  it('a setting naming a mailbox in one step and a calendar in another names neither', () => {
    expect(recipeMailboxSettings({
      variables: { source: text('Source') },
      steps: [
        { id: 'mail', op: 'core.mail.email.list', args: { slug: '{{config.source}}' } },
        { id: 'events', op: 'core.data.calendar.list', args: { slug: '{{config.source}}' } },
      ],
    })).toEqual([]);
  });

  it('a value made from the setting, a record, an event, or a step that is no hand-on', () => {
    const one = (value: string, extra: Record<string, unknown>[] = []) => recipeMailboxSettings({
      variables: { sender: text('Send from') },
      steps: [...extra, send(value)],
    });
    expect(one('{{config.sender}}-work')).toEqual([]);
    expect(one('{{step.job.record.sender_mail_instance}}')).toEqual([]);
    expect(one('{{context.event.payload.slug}}')).toEqual([]);
    expect(one('{{step.hop}}', [{ id: 'hop', transform: 'template', template: '{{config.sender}}' }])).toEqual([]);
    expect(one('{{step.hop.value}}', [{ id: 'hop', transform: 'trim', input: '{{config.sender}}' }])).toEqual([]);
  });

  it('a setting the recipe does not declare, or declares as something other than text', () => {
    expect(recipeMailboxSettings({ variables: {}, steps: [send('{{config.sender}}')] })).toEqual([]);
    expect(recipeMailboxSettings({
      variables: { sender: { label: 'Send from', type: 'enum', options: ['work', 'home'] } },
      steps: [send('{{config.sender}}')],
    })).toEqual([]);
  });

  it('a chain of hand-ons longer than three steps is not followed', () => {
    expect(recipeMailboxSettings({
      variables: { sender: text('Send from') },
      steps: [
        { id: 'a', transform: 'trim', input: '{{config.sender}}' },
        { id: 'b', transform: 'trim', input: '{{step.a}}' },
        { id: 'c', transform: 'trim', input: '{{step.b}}' },
        { id: 'd', transform: 'trim', input: '{{step.c}}' },
        send('{{step.d}}'),
      ],
    })).toEqual([]);
  });

  it('anything that is not a recipe', () => {
    expect(recipeMailboxSettings(null)).toEqual([]);
    expect(recipeMailboxSettings('recipe')).toEqual([]);
    expect(recipeMailboxSettings({ steps: 'none' })).toEqual([]);
  });
});

describe('the operations it knows', () => {
  it('each is a kernel operation with a backing ingredient, so a rename fails here', () => {
    const known = new Map(KERNEL_OP_REGISTRY.map((entry) => [entry.op, entry]));
    for (const op of Object.keys(MAILBOX_ARGUMENT_OPS)) {
      expect(known.get(op)?.backing_slug, op).toEqual(expect.any(String));
    }
    expect(known.get('core.watch.time-relative')?.backing_slug).toEqual(expect.any(String));
  });

  it('every mail or calendar kernel operation is in the list, or names no mailbox', () => {
    const namesNone = new Set([
      'core.mail.fact.get', 'core.mail.fact.list', 'core.mail.sent.reconcile',
      'core.mail.draft.create', 'core.mail.draft.read', 'core.mail.draft.update',
      'core.mail.draft.delete', 'core.mail.draft.save-to-mailbox',
    ]);
    const unlisted = KERNEL_OP_REGISTRY
      .map((entry) => entry.op)
      .filter((op) => (op.startsWith('core.mail.') || op.startsWith('core.data.calendar.'))
        && !(op in MAILBOX_ARGUMENT_OPS) && !namesNone.has(op));
    expect(unlisted).toEqual([]);
  });
});
