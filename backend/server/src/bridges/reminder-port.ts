import { createHash, randomUUID } from 'node:crypto';
import type { BridgeNotificationReceipt, BridgeWireEnvelope } from '@recued/contracts';
import type { AskDeliveryDestination, AskDeliveryEnvelope, BridgeReminderPort } from '@recued/notification';
import type { BridgeRegistry } from './registry.js';
import type { ClientTokenRecord } from '../pairing/client-tokens.js';
import type { BridgeSendResult } from './dispatcher.js';

export interface BridgeReminderPortDeps {
  registry: BridgeRegistry;
  tokens(): readonly ClientTokenRecord[];
  send(id: string, message: BridgeWireEnvelope): BridgeSendResult;
  timeoutMs?: number; now?(): number;
}
/** Bridge releases from before notification receipts. 0.0.2, the first Chrome
 * Web Store build, drops `notification.probe` unanswered, so no probe can find it
 * ready, yet it shows plain notifications. Every later release answers the probe. */
const PRE_RECEIPT_BRIDGE_VERSIONS: ReadonlySet<string> = new Set(['0.0.1', '0.0.2']);
/** OS acceptance is acknowledged by the paired bridge, not inferred from
 * pair presence or a WebSocket send. No content is retained in this port. */
export const createBridgeReminderPort = (deps: BridgeReminderPortDeps): BridgeReminderPort & {
  receive(id: string, session: string, value: unknown): void; close(): void;
} => {
  const now = deps.now ?? Date.now;
  const pending = new Map<string, { id: string; session: string; kind: 'probe' | 'show' | 'clear'; notification_id?: string;
    resolve(value: BridgeNotificationReceipt | null): void; timer: ReturnType<typeof setTimeout> }>();
  const probes = new Map<string, { session: string; at: number; ready: boolean }>();
  const token = (id: string) => deps.tokens().find(row => row.token_id === id && row.client_kind === 'bridge' && row.revoked_at === null);
  const current = (destination: AskDeliveryDestination) => {
    const id = destination.connection_name; const row = id ? token(id) : undefined;
    return destination.channel === 'bridge' && row && row.issued_at === destination.connection_enrolled_at
      && destination.recipient === id && destination.expected_sender === id ? deps.registry.get(id!) : null;
  };
  const ask = (id: string, kind: 'probe' | 'show' | 'clear', notification_id?: string, envelope?: Extract<BridgeWireEnvelope, { kind: 'notification' }>) => {
    const record = deps.registry.get(id); if (!record || !token(id)) return Promise.resolve(null);
    const request_id = randomUUID();
    return new Promise<BridgeNotificationReceipt | null>(resolve => {
      const settle = (result: BridgeNotificationReceipt | null) => { const entry = pending.get(request_id); if (!entry) return;
        clearTimeout(entry.timer); pending.delete(request_id); resolve(result); };
      const timer = setTimeout(() => settle(null), deps.timeoutMs ?? 2500);
      pending.set(request_id, { id, session: record.session_id, kind, notification_id, resolve: settle, timer });
      const message: BridgeWireEnvelope = kind === 'probe' ? { kind: 'notification.probe', request_id }
        : kind === 'clear' ? { kind: 'notification.clear', request_id, notification_id: notification_id! }
          : { ...envelope!, receipt_request_id: request_id };
      try { const sent = deps.send(id, message); if (!sent.ok) settle(sent.reason === 'bridge_offline'
        ? { request_id, outcome: 'failed', ...(notification_id ? { notification_id } : {}) } : null); }
      catch { settle(null); }
    });
  };
  const probe = async (id: string) => {
    const record = deps.registry.get(id); if (!record || !token(id)) return false;
    const prior = probes.get(id); if (prior?.session === record.session_id && now() - prior.at < 30_000) return prior.ready;
    const result = await ask(id, 'probe'); const same = deps.registry.get(id)?.session_id === record.session_id && !!token(id);
    const ready = same && result?.outcome === 'ready';
    if (same) probes.set(id, { session: record.session_id, at: now(), ready });
    return ready;
  };
  const notificationId = (envelope: Pick<AskDeliveryEnvelope, 'group_id' | 'destination'>) =>
    `recued-reminder-${createHash('sha256').update(JSON.stringify([envelope.group_id, envelope.destination.id])).digest('hex')}`;
  return {
    async ready() { return (await Promise.all(deps.registry.list().map(row => probe(row.client_token_id)))).some(Boolean); },
    legacyConnected() {
      return deps.registry.list().some(row => !!token(row.client_token_id) && PRE_RECEIPT_BRIDGE_VERSIONS.has(row.capabilities.software_version));
    },
    connectedIds() { return new Set(deps.registry.list().map(row => row.client_token_id)); },
    async destinations(settings) {
      const candidates = deps.tokens().filter(row => row.client_kind === 'bridge' && row.revoked_at === null
        && settings.bridges?.[row.token_id]?.notification !== false);
      // Keep offline destinations pinned so a pending clock can reach its
      // original bridge on reconnect. Only a display receipt counts as sent.
      return candidates.map(row => ({ id: `owner:bridge:${row.token_id}:${row.issued_at}`, channel: 'bridge' as const,
        connection_name: row.token_id, connection_enrolled_at: row.issued_at, recipient: row.token_id, expected_sender: row.token_id }));
    },
    async deliver(envelope) {
      const connection = current(envelope.destination); if (!connection || !await probe(connection.client_token_id) || !current(envelope.destination))
        return { outcome: 'not_delivered', error: 'The pinned bridge cannot currently display notifications' };
      const notification_id = notificationId(envelope);
      const result = await ask(connection.client_token_id, 'show', notification_id, { kind: 'notification', notification: {
        notification_id, title: envelope.repeat ? 'Recued reminder · repeat' : 'Recued reminder',
        body: 'Open Recued for the current reminders.', tag: envelope.group_id,
        click_action: { kind: 'open_webclient', path: '/#yours/occurrences' },
      } });
      if (result?.outcome === 'displayed') return { outcome: 'delivered', provider_message_id: notification_id, presentation: 'text' };
      return { outcome: result?.outcome === 'failed' || result?.outcome === 'denied' ? 'not_delivered' : 'unknown', error: 'OS notification acceptance was not confirmed' };
    },
    async withdraw(receipt, closed) {
      if (receipt.asks.some(ask => !closed.includes(ask.ask_id))) return true;
      const connection = current(receipt.destination); if (!connection) return false;
      const id = receipt.provider_message_id ?? notificationId(receipt);
      return (await ask(connection.client_token_id, 'clear', id))?.outcome === 'cleared';
    },
    receive(id, session, value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      const receipt = value as BridgeNotificationReceipt;
      if (typeof receipt.request_id !== 'string') return;
      const entry = pending.get(receipt.request_id);
      if (!entry || entry.id !== id || entry.session !== session || deps.registry.get(id)?.session_id !== session || !token(id)) return;
      if (entry.notification_id !== receipt.notification_id) return;
      const outcomes = entry.kind === 'probe' ? ['ready', 'denied', 'failed'] : entry.kind === 'show' ? ['displayed', 'denied', 'failed'] : ['cleared', 'failed'];
      if (!outcomes.includes(receipt.outcome)) return;
      entry.resolve(receipt);
    },
    close() { for (const entry of pending.values()) entry.resolve(null); probes.clear(); },
  };
};
