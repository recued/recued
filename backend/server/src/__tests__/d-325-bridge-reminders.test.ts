import { describe, expect, it } from 'vitest';
import type { BridgeWireEnvelope } from '@recued/contracts';
import { DEFAULT_NOTIFICATION_SETTINGS, type AskDeliveryEnvelope } from '@recued/notification';
import { createBridgeRegistry } from '../bridges/registry.js';
import { createBridgeReminderPort } from '../bridges/reminder-port.js';
import type { ClientTokenRecord } from '../pairing/client-tokens.js';

const fixture = () => {
  const registry = createBridgeRegistry();
  const profile = { software_version: 'test', chrome_version: '130', permissions_granted: ['notifications'], granted_origins: [], offscreen_supported: true, alarms_supported: true };
  registry.attach({ client_token_id: 'bridge-a', session_id: 'session-a', online_since: 100, last_seen_at: 100, capabilities: profile });
  const tokens: ClientTokenRecord[] = [{ token_id: 'bridge-a', client_kind: 'bridge', client_label: 'Laptop', issued_at: 90, last_used_at: null, revoked_at: null, revocation_reason: null, metadata: null }];
  const sent: Array<{ id: string; frame: BridgeWireEnvelope }> = []; let permission = true; let acknowledge = true; let answersProbe = true;
  const port = createBridgeReminderPort({ registry, tokens: () => tokens, timeoutMs: 15,
    send(id, frame) { sent.push({ id, frame }); queueMicrotask(() => {
      const session = registry.get(id)?.session_id ?? 'offline';
      if (answersProbe && frame.kind === 'notification.probe') port.receive(id, session, { request_id: frame.request_id, outcome: permission ? 'ready' : 'denied' });
      if (acknowledge && frame.kind === 'notification') port.receive(id, session, { request_id: frame.receipt_request_id, outcome: 'displayed', notification_id: frame.notification.notification_id });
      if (acknowledge && frame.kind === 'notification.clear') port.receive(id, session, { request_id: frame.request_id, outcome: 'cleared', notification_id: frame.notification_id });
    }); return { ok: true }; } });
  const envelope = async (): Promise<AskDeliveryEnvelope> => ({ group_id: 'one-day-owner', attempt_id: 'first', repeat: false,
    destination: (await port.destinations(structuredClone(DEFAULT_NOTIFICATION_SETTINGS)))[0]!, asks: [{ ask_id: 'ask-1', message: { title: 'Private passport', text: 'Number 12345' },
      options: [{ id: 'done', label: 'Done' }], handler_kind: 'clock', handler_payload: {}, created_at: 100, fanout_channels: ['bridge', 'ui'] }] });
  return { registry, tokens, port, sent, envelope, deny: () => { permission = false; }, loseAck: () => { acknowledge = false; }, ack: () => { acknowledge = true; },
    // What Bridge 0.0.2 does: it drops `notification.probe` unanswered.
    ignoreProbes: () => { answersProbe = false; },
    reportVersion: (software_version: string) => { const record = registry.get('bridge-a')!;
      registry.attach({ ...record, capabilities: { ...record.capabilities, software_version } }); } };
};

describe('D-325 extension reminder receipts', () => {
  it('keeps an offline destination bound to its token and reaches it after reconnect', async () => {
    const f = fixture(); const record = f.registry.get('bridge-a')!; f.registry.detach('bridge-a');
    const envelope = await f.envelope(); expect(envelope.destination.connection_name).toBe('bridge-a');
    expect((await f.port.deliver(envelope)).outcome).toBe('not_delivered');
    f.registry.attach({ ...record, session_id: 'session-reconnected' });
    expect((await f.port.deliver(envelope)).outcome).toBe('delivered'); f.port.close();
  });
  it('requires a live permission response, not just a paired bridge or notifications permission in a profile', async () => {
    const f = fixture(); f.deny(); expect(await f.port.ready()).toBe(false);
    expect((await f.port.deliver(await f.envelope())).outcome).toBe('not_delivered'); f.port.close();
  });
  it('names a connected 0.0.2 bridge as legacy, but never lets it confirm a reminder', async () => {
    const f = fixture(); f.ignoreProbes(); expect(f.port.legacyConnected()).toBe(false);
    f.reportVersion('0.0.3'); expect(f.port.legacyConnected()).toBe(false);
    f.reportVersion('0.0.2'); expect(f.port.legacyConnected()).toBe(true);
    expect(await f.port.ready()).toBe(false);
    expect((await f.port.deliver(await f.envelope())).outcome).toBe('not_delivered');
    f.tokens[0]!.revoked_at = 200; expect(f.port.legacyConnected()).toBe(false);
    f.tokens[0]!.revoked_at = null; f.registry.detach('bridge-a'); expect(f.port.legacyConnected()).toBe(false); f.port.close();
  });
  it('reports which bridges hold a live connection', async () => {
    const f = fixture(); const record = f.registry.get('bridge-a')!;
    expect([...f.port.connectedIds()]).toEqual(['bridge-a']);
    f.registry.detach('bridge-a'); expect(f.port.connectedIds().size).toBe(0);
    f.registry.attach({ ...record, session_id: 'session-reconnected' }); expect([...f.port.connectedIds()]).toEqual(['bridge-a']); f.port.close();
  });
  it('pins the bridge enrollment and sends generic click-only text without private asset fields', async () => {
    const f = fixture(); const envelope = await f.envelope(); expect(await f.port.deliver(envelope)).toMatchObject({ outcome: 'delivered', presentation: 'text' });
    const wire = f.sent.find(row => row.frame.kind === 'notification')!.frame;
    expect(JSON.stringify(wire)).not.toContain('passport'); expect(JSON.stringify(wire)).not.toContain('12345');
    expect(wire).toMatchObject({ notification: { title: 'Recued reminder', click_action: { kind: 'open_webclient', path: '/#yours/occurrences' } } });
    f.tokens[0]!.issued_at = 91; expect((await f.port.deliver(envelope)).outcome).toBe('not_delivered'); f.port.close();
  });
  it('keeps a lost receipt unknown, replaces the same OS id on the marked repeat, and clears only after all bundled items close', async () => {
    const f = fixture(); const envelope = await f.envelope(); f.loseAck(); expect((await f.port.deliver(envelope)).outcome).toBe('unknown');
    f.ack(); const delivered = await f.port.deliver({ ...envelope, attempt_id: 'repeat', repeat: true }); expect(delivered.outcome).toBe('delivered');
    const shows = f.sent.flatMap(row => row.frame.kind === 'notification' ? [row.frame.notification] : []);
    expect(shows[0]!.notification_id).toBe(shows[1]!.notification_id); expect(shows[1]!.title).toContain('repeat');
    expect(await f.port.withdraw({ ...envelope, asks: [...envelope.asks, { ...envelope.asks[0]!, ask_id: 'ask-2' }] }, ['ask-1'])).toBe(true);
    expect(f.sent.filter(row => row.frame.kind === 'notification.clear')).toEqual([]);
    expect(await f.port.withdraw(envelope, ['ask-1'])).toBe(true); expect(f.sent.filter(row => row.frame.kind === 'notification.clear')).toHaveLength(1); f.port.close();
  });
  it('rejects another bridge or stale session receipt and respects each bridge notification choice', async () => {
    const f = fixture(); const envelope = await f.envelope(); f.loseAck();
    const waiting = f.port.deliver(envelope); await new Promise(resolve => setTimeout(resolve, 0));
    const frame = [...f.sent].reverse().find(row => row.frame.kind === 'notification')!.frame;
    if (frame.kind !== 'notification') throw new Error('No notification frame');
    const receipt = { request_id: frame.receipt_request_id, outcome: 'displayed', notification_id: frame.notification.notification_id };
    f.port.receive('bridge-b', 'session-a', receipt); f.port.receive('bridge-a', 'previous-session', receipt);
    expect((await waiting).outcome).toBe('unknown');
    const settings = structuredClone(DEFAULT_NOTIFICATION_SETTINGS); settings.bridges = { 'bridge-a': { notification: false, approval: false } };
    expect(await f.port.destinations(settings)).toEqual([]);
    f.tokens[0]!.revoked_at = 200; expect((await f.port.deliver(envelope)).outcome).toBe('not_delivered'); f.port.close();
  });
});
