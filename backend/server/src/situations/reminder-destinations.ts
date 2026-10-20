import {
  CHANNEL_ROLES, MESSENGER_PRINCIPAL_CONFIG_KEY, NOTIFICATION_CREDENTIAL_CHANNELS, getMessengerVendorDeclaration,
  type ConnectionRow,
} from '@recued/contracts';
import type { AskDestinationResolution, AskDeliveryDestination, ChannelName, NotificationSettings } from '@recued/notification';
import type { AskReplyOrigin } from '@recued/notification';
import type { InboundReply } from '@recued/notification';
import type { HouseholdDeliveryStore } from '../storage/household-delivery-store.js';

/** The one address an email connection notifies: its `default_recipient`, or,
 * when it names none, the sending mailbox's own address — the owner's
 * one-address setup (D-158 amendment 2026-10-18). Undefined for several
 * recipients, a malformed value, or a mailbox whose address is unknown. */
const emailRecipientOf = (config: Record<string, unknown>, mailboxAddress?: (slug: string) => string | undefined): unknown => {
  const configured = config.default_recipient;
  const blank = configured === undefined || configured === null || configured === ''
    || Array.isArray(configured) && configured.length === 0;
  if (!blank) return typeof configured === 'string' ? configured : Array.isArray(configured) && configured.length === 1 ? configured[0] : undefined;
  return typeof config.sender_mail_instance === 'string' ? mailboxAddress?.(config.sender_mail_instance)?.trim() || undefined : undefined;
};

/** An owner choice is not a "first enrolled connection" lookup. Resolve once
 * when a reminder is minted, then carry this secret-free snapshot everywhere. */
export const resolveOwnerReminderDestinations = (input: {
  settings: NotificationSettings;
  connections: readonly ConnectionRow[];
  available_channels: readonly ChannelName[];
  isHousehold?: (row: ConnectionRow) => boolean;
  /** A mailbox's own address: where an email connection naming no recipient
   *  sends (D-158 amendment 2026-10-18). */
  mailboxAddress?: (slug: string) => string | undefined;
}): AskDestinationResolution => {
  const destinations: AskDeliveryDestination[] = [{ id: 'owner:ui', channel: 'ui' }];
  const issues: AskDestinationResolution['issues'] = [];
  for (const channel of NOTIFICATION_CREDENTIAL_CHANNELS) {
    const mode = input.settings[channel];
    if (!mode.notification || !CHANNEL_ROLES[channel].notification) continue;
    const rows = input.connections.filter(row => row.kind === 'notification'
      && (row.subtype === channel || (!row.subtype && row.name === channel)));
    const selected = mode.connection;
    const row = selected === undefined ? rows.length === 1 ? rows[0] : undefined
      : selected === null ? undefined : rows.find(item => item.name === selected.name && item.enrolled_at === selected.enrolled_at);
    if (!row) {
      issues.push({ channel, reason: selected ? 'connection_missing' : 'choice_required' });
      continue;
    }
    if (!input.available_channels.includes(channel)) {
      issues.push({ channel, reason: 'adapter_unavailable' }); continue;
    }
    let config: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(row.config_json);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid connection config');
      config = value as Record<string, unknown>;
    } catch { issues.push({ channel, reason: 'configuration_invalid' }); continue; }
    let recipient: string | undefined;
    let expected_sender: string | undefined;
    if (channel === 'email') {
      if (typeof config.sender_mail_instance !== 'string' || !config.sender_mail_instance) {
        issues.push({ channel, reason: 'configuration_invalid' }); continue;
      }
      const value = emailRecipientOf(config, input.mailboxAddress);
      if (typeof value === 'string' && /^[^\s@<>]+@[^\s@<>]+$/.test(value)) recipient = value.toLowerCase();
      expected_sender = recipient;
    } else {
      const declaration = getMessengerVendorDeclaration(channel);
      const value = declaration ? config[declaration.recipient.field] : undefined;
      recipient = typeof value === 'string' && value.trim() ? value.trim()
        : declaration?.recipient.numeric_ok && typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;
      const principal = config[MESSENGER_PRINCIPAL_CONFIG_KEY];
      expected_sender = typeof principal === 'string' && principal.trim() ? principal.trim() : undefined;
    }
    if (!recipient) { issues.push({ channel, reason: 'configuration_invalid' }); continue; }
    if (input.isHousehold?.(row) || channel === 'telegram' && recipient.startsWith('-')) { issues.push({ channel, reason: 'configuration_invalid' }); continue; }
    if (!expected_sender) { issues.push({ channel, reason: 'principal_missing' }); continue; }
    destinations.push({ id: `owner:${channel}:${encodeURIComponent(row.name)}:${row.enrolled_at}`,
      channel, connection_name: row.name, connection_enrolled_at: row.enrolled_at, recipient, expected_sender,
      ...(channel === 'email' ? { sender_source: config.sender_mail_instance as string } : {}) });
  }
  return { destinations, issues };
};

/** The connection an owner notification (the brief, a day-of note, a plain
 * reminder) goes through: the one the owner named for the channel, else the only
 * one enrolled. Never whichever came first, and never a household destination.
 * Channels without connection credentials keep their single enrolled row.
 * `fallbackName` keeps a caller's old default when the owner chose none among several. */
export const selectOwnerNotificationConnection = (input: {
  settings: NotificationSettings;
  channel: string;
  rows: readonly ConnectionRow[];
  isHousehold: (row: ConnectionRow) => boolean;
  fallbackName?: string;
}): ConnectionRow | { reason: string } => {
  if (!(NOTIFICATION_CREDENTIAL_CHANNELS as readonly string[]).includes(input.channel)) return input.rows[0] ?? { reason: 'NO_CONNECTION_BOUND' };
  const selected = input.settings[input.channel as (typeof NOTIFICATION_CREDENTIAL_CHANNELS)[number]].connection;
  const row = selected === undefined ? input.rows.length === 1 ? input.rows[0] : input.rows.find(item => item.name === input.fallbackName)
    : selected === null ? undefined : input.rows.find(item => item.name === selected.name && item.enrolled_at === selected.enrolled_at);
  if (!row) return { reason: selected === null ? 'NOTIFICATION_CONNECTION_OFF' : selected ? 'NOTIFICATION_CONNECTION_MISSING' : 'NOTIFICATION_CONNECTION_CHOICE_REQUIRED' };
  if (input.isHousehold(row)) return { reason: 'NOTIFICATION_CONNECTION_IS_HOUSEHOLD' };
  return row;
};

/** Answer authority is public enrollment/configuration, so an authenticated
 * reply can be journaled while the vault is sealed. It never decrypts a token. */
export const authorizeReminderOrigin = (destination: AskDeliveryDestination, origin: AskReplyOrigin,
  connections: readonly ConnectionRow[], household: HouseholdDeliveryStore, reply?: Pick<InboundReply, 'option'>,
  mailboxAddress?: (slug: string) => string | undefined): boolean => {
  const row = connections.find(row => row.kind === 'notification' && row.name === destination.connection_name && row.enrolled_at === destination.connection_enrolled_at
    && (row.subtype ?? row.name) === destination.channel);
  if (!row || destination.connection_name !== origin.connection_name || destination.connection_enrolled_at !== origin.connection_enrolled_at || destination.recipient !== origin.recipient) return false;
  if (destination.audience === 'household') return household.permitsMember(destination, origin.sender, connections)
    && (origin.sender === destination.expected_sender || !!reply && ['done', 'later', 'not_needed', 'later_tomorrow', 'later_week', 'later_month', 'later_custom'].includes(reply.option));
  if (household.isHousehold(row)) return false;
  try {
    const config = JSON.parse(row.config_json) as Record<string, unknown>;
    if (destination.channel === 'email') {
      const recipient = emailRecipientOf(config, mailboxAddress);
      return typeof recipient === 'string' && recipient.toLowerCase() === destination.recipient && recipient.toLowerCase() === origin.sender.toLowerCase()
        && config.sender_mail_instance === destination.sender_source;
    }
    const declaration = getMessengerVendorDeclaration(destination.channel); const recipient = declaration ? config[declaration.recipient.field] : undefined;
    const principal = config[MESSENGER_PRINCIPAL_CONFIG_KEY];
    return (typeof recipient === 'string' || typeof recipient === 'number') && String(recipient).trim() === destination.recipient
      && !(destination.channel === 'telegram' && String(recipient).startsWith('-')) && typeof principal === 'string'
      && principal.trim() === destination.expected_sender && principal.trim() === origin.sender;
  } catch { return false; }
};
