import { describe, expect, it } from 'vitest';
import type { ConnectionRow } from '@recued/contracts';
import { DEFAULT_NOTIFICATION_SETTINGS, type NotificationSettings } from '@recued/notification';
import { authorizeReminderOrigin, resolveOwnerReminderDestinations } from '../situations/reminder-destinations.js';
import type { HouseholdDeliveryStore } from '../storage/household-delivery-store.js';

const row = (name: string, enrolled_at: number, config = { chat_id: 'private-chat', principal_id: 'owner' }): ConnectionRow => ({
  pk: `notification:${name}`, name, kind: 'notification', subtype: 'telegram', display_name: name,
  enrolled_at, updated_at: enrolled_at, config_json: JSON.stringify(config), auth_ciphertext: 'never-read-here',
});
const settings = (): NotificationSettings => ({ ...structuredClone(DEFAULT_NOTIFICATION_SETTINGS),
  telegram: { notification: true, approval: false, messenger: false, connection: { name: 'private', enrolled_at: 10 } } });

describe('D-325 owner reminder destination snapshot', () => {
  it('pins the chosen private connection and never adds the enrolled household connection', () => {
    const result = resolveOwnerReminderDestinations({ settings: settings(), available_channels: ['ui', 'telegram'],
      connections: [row('household', 20, { chat_id: 'family-group', principal_id: 'owner' }), row('private', 10)] });
    expect(result.issues).toEqual([]);
    expect(result.destinations).toEqual([{ id: 'owner:ui', channel: 'ui' }, {
      id: 'owner:telegram:private:10', channel: 'telegram', connection_name: 'private', connection_enrolled_at: 10,
      recipient: 'private-chat', expected_sender: 'owner',
    }]);
    expect(JSON.stringify(result)).not.toContain('never-read-here');
  });

  it('never follows a deleted or recreated name to the only remaining connection', () => {
    for (const connections of [[row('household', 20)], [row('private', 30)]]) {
      const result = resolveOwnerReminderDestinations({ settings: settings(), available_channels: ['ui', 'telegram'], connections });
      expect(result.destinations).toEqual([{ id: 'owner:ui', channel: 'ui' }]);
      expect(result.issues).toEqual([{ channel: 'telegram', reason: 'connection_missing' }]);
    }
  });

  it('resolves a sole legacy connection and asks for a choice when two exist', () => {
    const configured = settings(); delete configured.telegram.connection;
    const resolve = (connections: ConnectionRow[]) => resolveOwnerReminderDestinations({ settings: configured,
      available_channels: ['ui', 'telegram'], connections });
    expect(resolve([row('private', 10)]).destinations).toHaveLength(2);
    expect(resolve([row('private', 10), row('family', 20)]).issues).toEqual([{ channel: 'telegram', reason: 'choice_required' }]);
  });

  it('reaches the owner’s own chat with no principal named, answered only from that chat (D-325 §15.7, 2026-10-24)', () => {
    // As the app enrols a Telegram connection: no principal (only Teams resolves one, D-238).
    const noPrincipal = row('private', 10);
    noPrincipal.config_json = JSON.stringify({ chat_id: 'private-chat' });
    const result = resolveOwnerReminderDestinations({ settings: settings(), connections: [noPrincipal], available_channels: ['ui', 'telegram'] });
    expect(result.issues).toEqual([]);
    const destination = result.destinations[1]!;
    expect(destination).toEqual({ id: 'owner:telegram:private:10', channel: 'telegram', connection_name: 'private',
      connection_enrolled_at: 10, recipient: 'private-chat' });
    const household: Pick<HouseholdDeliveryStore, 'isHousehold'> = { isHousehold: () => false };
    const origin = { connection_name: 'private', connection_enrolled_at: 10, recipient: 'private-chat', sender: 'anyone-in-the-chat' };
    expect(authorizeReminderOrigin(destination, origin, [noPrincipal], household)).toBe(true);
    expect(authorizeReminderOrigin(destination, { ...origin, recipient: 'another-chat' }, [noPrincipal], household)).toBe(false);
    // A principal named since the reminder went out answers nothing that went without one.
    const named = { ...noPrincipal, config_json: JSON.stringify({ chat_id: 'private-chat', principal_id: 'owner' }) };
    expect(authorizeReminderOrigin(destination, { ...origin, sender: 'owner' }, [named], household)).toBe(false);
    // With a principal, only it answers.
    const pinned = resolveOwnerReminderDestinations({ settings: settings(), connections: [named], available_channels: ['ui', 'telegram'] }).destinations[1]!;
    expect(pinned.expected_sender).toBe('owner');
    expect(authorizeReminderOrigin(pinned, { ...origin, sender: 'owner' }, [named], household)).toBe(true);
    expect(authorizeReminderOrigin(pinned, origin, [named], household)).toBe(false);
    // ⛔ Nothing from the household answers, whichever way it is marked.
    expect(authorizeReminderOrigin({ ...destination, audience: 'household' }, origin, [noPrincipal], household)).toBe(false);
    expect(authorizeReminderOrigin(destination, origin, [noPrincipal], { isHousehold: () => true })).toBe(false);
    expect(resolveOwnerReminderDestinations({ settings: settings(), connections: [row('private', 10)],
      available_channels: ['ui'] }).issues).toEqual([{ channel: 'telegram', reason: 'adapter_unavailable' }]);
  });
});

describe('D-158 amendment 2026-10-18 — an email connection naming no recipient', () => {
  const email = (config: Record<string, unknown>): ConnectionRow => ({ pk: 'notification:owner-mail', name: 'owner-mail', kind: 'notification',
    subtype: 'email', display_name: 'Owner mail', enrolled_at: 40, updated_at: 40, config_json: JSON.stringify(config), auth_ciphertext: '' });
  const on = (): NotificationSettings => ({ ...structuredClone(DEFAULT_NOTIFICATION_SETTINGS),
    email: { ...structuredClone(DEFAULT_NOTIFICATION_SETTINGS.email), notification: true } });
  const mailboxAddress = (slug: string) => slug === 'personal' ? ' Owner@Fixture.test ' : undefined;
  const household: Pick<HouseholdDeliveryStore, 'isHousehold'> = { isHousehold: () => false };

  it('reminds the sending mailbox itself, and answers only from it', () => {
    const row = email({ sender_mail_instance: 'personal' });
    const resolve = (lookup?: typeof mailboxAddress) => resolveOwnerReminderDestinations({ settings: on(), connections: [row],
      available_channels: ['ui', 'email'], ...(lookup ? { mailboxAddress: lookup } : {}) });
    const destination = resolve(mailboxAddress).destinations[1]!;
    expect(destination).toEqual({ id: 'owner:email:owner-mail:40', channel: 'email', connection_name: 'owner-mail', connection_enrolled_at: 40,
      recipient: 'owner@fixture.test', expected_sender: 'owner@fixture.test', sender_source: 'personal' });
    // A mailbox whose address is unknown gives no destination rather than a guess.
    expect(resolve().issues).toEqual([{ channel: 'email', reason: 'configuration_invalid' }]);
    const origin = { connection_name: 'owner-mail', connection_enrolled_at: 40, recipient: 'owner@fixture.test', sender: 'owner@fixture.test' };
    expect(authorizeReminderOrigin(destination, origin, [row], household, mailboxAddress)).toBe(true);
    expect(authorizeReminderOrigin(destination, { ...origin, sender: 'someone@fixture.test' }, [row], household, mailboxAddress)).toBe(false);
    expect(authorizeReminderOrigin(destination, origin, [row], household)).toBe(false);
  });

  it('keeps a recipient the connection names, even beside a known mailbox', () => {
    const result = resolveOwnerReminderDestinations({ settings: on(), connections: [email({ sender_mail_instance: 'personal', default_recipient: 'phone@fixture.test' })],
      available_channels: ['ui', 'email'], mailboxAddress });
    expect(result.destinations[1]).toMatchObject({ recipient: 'phone@fixture.test', expected_sender: 'phone@fixture.test' });
  });
});
