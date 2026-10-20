/** Real server → WS dispatcher → contact import → warehouse, and reminder
 * routing through the real fanout. No provider or real mailbox is used. */
import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import type { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import Database from 'better-sqlite3';
import WebSocket from 'ws';
import { describe, expect, it } from 'vitest';
import { createServerHandlerSet } from '../index.js';
import type { ServerConfig } from '../server.js';
import { createContactStore } from '../storage/contact-store.js';
import { createCrmRecordMirrorStore, ensureCrmRecordMirrorSchema } from '../storage/crm-record-mirror-store.js';
import { createReminderStore } from '../storage/reminder-store.js';
import { createReminderDelivery } from '../reminders/reminder-delivery.js';
import { handleNotificationSend, type NotificationPayload } from '../notification-handler.js';

class MemorySocket extends Duplex {
  peer?: MemorySocket;
  remoteAddress = '127.0.0.1';
  remotePort = 12345;
  localAddress = '127.0.0.1';
  localPort = 80;
  _read(): void {}
  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.peer && !this.peer.destroyed) this.peer.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    callback();
  }
  _final(callback: (error?: Error | null) => void): void { this.peer?.push(null); callback(); }
  setTimeout(): this { return this; }
  setNoDelay(): this { return this; }
  setKeepAlive(): this { return this; }
}

describe('D-325 day-one production paths', () => {
  it('registers contact import through server.ts and keeps a birthday from a vCard', async () => {
    const db = new Database(':memory:');
    const store = createContactStore(db);
    ensureCrmRecordMirrorSchema(db);
    const handlers = createServerHandlerSet({ contactImportDeps: { store, mirror: createCrmRecordMirrorStore(db) } } as ServerConfig);
    const server = createHttpServer();
    server.on('upgrade', handlers.upgradeHandlers.ws!);
    handlers.wsHandle.maxInstances = 0;
    const ws = new WebSocket('ws://127.0.0.1/ws?token=test-realm', { createConnection: () => {
      const client = new MemorySocket(); const peer = new MemorySocket();
      client.peer = peer; peer.peer = client;
      process.nextTick(() => server.emit('connection', peer as unknown as Socket));
      return client as unknown as Socket;
    } });
    try {
      await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      const call = (method: string, args: unknown) => new Promise<{ result?: unknown; error?: unknown }>((resolve, reject) => {
        const request_id = randomUUID();
        const timeout = setTimeout(() => { ws.off('message', onMessage); reject(new Error('RPC timeout')); }, 5000);
        const onMessage = (data: WebSocket.RawData): void => {
          const message = JSON.parse(data.toString());
          if (message.type !== 'rpc_result' || message.request_id !== request_id) return;
          clearTimeout(timeout); ws.off('message', onMessage); resolve(message);
        };
        ws.on('message', onMessage); ws.send(JSON.stringify({ type: 'rpc', request_id, method, args }));
      });
      const text = 'BEGIN:VCARD\nVERSION:4.0\nFN:Ana\nEMAIL:ana@example.test\nBDAY:--03-04\nEND:VCARD';
      expect(await call('contact.import.file_preview', { text })).toMatchObject({ result: { format: 'vcard', adds: 1, errors: [] } });
      expect(store.get('ana@example.test')).toBeNull();
      expect(await call('contact.import.file_apply', { text, apply_changes: false })).toMatchObject({ result: { added: 1, failures: [] } });
      expect(store.get('ana@example.test')).toMatchObject({ name: 'Ana', birthday: '--03-04' });
    } finally { ws.terminate(); handlers.close(); server.removeAllListeners(); db.close(); }
  });

  it.each([null, 'https://recued.example.test'])('routes a reminder link with public address %s', async publicBaseUrl => {
    const db = new Database(':memory:');
    try {
      const store = createReminderStore(db);
      store.create({ text: 'Call Ana', at: 1000, time_zone: 'UTC', origin: {} }, 1000);
      const delivered: NotificationPayload[] = [];
      const take = async (message: NotificationPayload) => { delivered.push(message); return { ok: true }; };
      const delivery = createReminderDelivery({ store, now: () => 1000, isQuiet: () => false, publicBaseUrl: () => publicBaseUrl,
        send: message => handleNotificationSend({ dispatchers: { in_app: take, telegram: take, email: take } }, message) });
      expect(await delivery.tick()).toMatchObject({ delivered: 1 });
      expect(delivered.find(message => message.channel === 'in_app')?.link_url).toBe('#data/reminder');
      for (const channel of ['telegram', 'email']) {
        expect(delivered.find(message => message.channel === channel)?.link_url).toBe(publicBaseUrl ? `${publicBaseUrl}/#data/reminder` : undefined);
      }
    } finally { db.close(); }
  });
});
