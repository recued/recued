/** D-201 Slice 10AW (10AS finding 8) — a webhook's paired connection, looked up
 *  under the kind its profile's registration reads it
 *  (`webhookPairedConnectionKind`). Readiness looked every one up as an API
 *  connection, while Telegram's registration reads the bot as a notification
 *  connection: a managed Telegram webhook registered at Telegram and could
 *  never be switched on (`paired_connection_unavailable`), unless an API
 *  connection of the same name happened to stand. */

import {
  webhookPairedConnectionKind,
  webhookProfileRequiresPairedConnection,
  type WebhookIngressRecord,
  type WebhookPairedConnectionKind,
  type WebhookProfileDescriptor,
} from '@recued/contracts';

/** The one lookup a paired connection needs: by kind and name. */
export interface PairedConnectionLookup {
  get(kind: WebhookPairedConnectionKind, name: string): unknown;
}

/** Whether the connection a webhook pairs with stands: true when its mode
 *  pairs none. */
export const pairedConnectionStands = (
  connections: PairedConnectionLookup | undefined,
  ingress: Pick<WebhookIngressRecord, 'paired_connection_id' | 'registration_mode'>,
  profile: WebhookProfileDescriptor,
): boolean => {
  if (!webhookProfileRequiresPairedConnection(profile, ingress.registration_mode)) return true;
  if (ingress.paired_connection_id === null || connections === undefined) return false;
  return (connections.get(webhookPairedConnectionKind(profile), ingress.paired_connection_id) ?? null) !== null;
};
