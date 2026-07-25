/** D-172 P4 — messenger media lands in data.file.received and is recorded
 *  as a chat turn attachment ref. */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { createInMemorySessionStore } from '@recued/chat';
import type {
  AIOutput,
  InternalToolRegistry,
  RecuedServerSignature,
} from '@recued/contracts';
import type {
  FetchedMedia,
  MediaRef,
  OutboundMessage,
  Transport,
} from '@recued/transport';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';

import {
  createChatOrchestrator,
  type ExecuteChatAiCall,
} from '../chat-orchestrator.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createBlobStore } from '../storage/blob-store.js';
import {
  createInboundFileCollection,
  inboundFileRecordId,
  type InboundFileCollection,
} from '../collections/file/inbound-file-collection.js';

const NOW = Date.UTC(2030, 1, 1, 9, 0, 0);
const SESSION = 'sess-d172-p4-media';

const selfSignature: RecuedServerSignature = {
  server_kind: 'recued',
  version: '1.0.0',
  instance_id: 'inst-test',
};

const internalRegistry = (): InternalToolRegistry => ({
  list: () => [],
  listByTier: () => [],
  getByName: () => null,
  dispatch: vi.fn(async () => ({ ok: true, result: {} }) as const),
  subscribeRefresh: () => () => undefined,
});

describe('D-172 P4 messenger media capstone', () => {
  it('fetches messenger media into data.file.received and stores the chat turn attachment ref', async () => {
    const root = mkdtempSync(join(tmpdir(), 'd172-p4-messenger-media-'));
    const db = new Database(':memory:');
    const fileBytes = Buffer.from('voice bytes');
    const mediaRef: MediaRef = {
      type: 'voice',
      mime: 'audio/ogg',
      size: fileBytes.length,
      remote_id: 'F-voice-1',
    };
    let collection: InboundFileCollection | undefined;
    try {
      ensureChatSchema(db);
      const chatStore = createChatStore(db);
      chatStore.createSession({ id: SESSION, now: NOW - 1_000 });
      collection = createInboundFileCollection({
        db,
        blobs: createBlobStore(join(root, 'blobs')),
        gate: createStorageGate({
          quota: 100 * 1024 * 1024,
          reservePct: 10,
          surface: 'collection:file:received',
        }),
        bus: createWarehouseEventBus(),
        slug: 'received',
        now: () => NOW,
      });
      const fileCollection = collection;
      const executeAiCall = vi.fn<ExecuteChatAiCall>(async () => ({
        body: {
          response: 'should not run',
          events: [],
          tool_calls: [],
        } satisfies AIOutput,
      }));
      const orchestrator = createChatOrchestrator({
        chatStore,
        registry: internalRegistry(),
        selfSignature,
        executeAiCall,
        now: () => NOW,
      });
      const sends: OutboundMessage[] = [];
      const mediaTmp = join(root, 'incoming-voice.ogg');
      const fetchMedia = vi.fn<
        (ref: MediaRef, token: string) => Promise<FetchedMedia>
      >(async () => {
        // The transport streams the download to a temp file (never an
        // in-memory Buffer); mirror that here.
        writeFileSync(mediaTmp, fileBytes);
        return {
          temp_path: mediaTmp,
          size: fileBytes.length,
          head_bytes: fileBytes.subarray(0, 16),
          filename: 'voice.ogg',
          mime_type: 'audio/ogg',
        };
      });
      const transport: Transport = {
        vendor: 'slack',
        parseConversationId: () => null,
        async send(message) {
          sends.push(message);
          return { ok: true, vendor_message_id: 'out-1' };
        },
        parseInbound() {
          return {
            from: 'U123',
            text: '',
            vendor_message_id: 'slack-msg-1',
            media: [mediaRef],
          };
        },
        fetchMedia,
      };
      const { createMessengerChannel } = await import('@recued/messenger');
      const sessionStore = createInMemorySessionStore();
      const channel = createMessengerChannel({
        transport,
        sessionStore,
        token: 'xoxb-test-token',
        recipient: 'C123',
        sessionId: SESSION,
        now: () => NOW,
        fileSink: {
          async ingest(input) {
            const record = await fileCollection.ingest({
              src_path: input.temp_path,
              size_bytes: input.size,
              filename: input.filename,
              mime_type: input.mime_type,
              origin: 'messenger_media',
              source_id: input.source_id,
              scan_status: 'pending',
              now: NOW,
            });
            return {
              file_id: record.record_id,
              media_class: record.hot_fields.media_class,
            };
          },
        },
      });

      let turnPromise: Promise<unknown> | undefined;
      channel.onInbound((inbound) => {
        turnPromise = orchestrator.runMessengerTurn({
          channel,
          sessionStore,
          inbound,
        });
      });

      await channel.ingest({ type: 'slack-event' });
      await turnPromise;

      const sourceId = 'slack-msg-1:0';
      const fileId = inboundFileRecordId('messenger_media', sourceId);
      const record = fileCollection.get(fileId);
      expect(record?.hot_fields).toMatchObject({
        filename: 'voice.ogg',
        mime_type: 'audio/ogg',
        origin: 'messenger_media',
        scan_status: 'pending',
        media_class: 'voice',
      });
      expect(fetchMedia).toHaveBeenCalledWith(mediaRef, 'xoxb-test-token');
      const messages = await chatStore.listMessages(SESSION);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        role: 'user',
        content: '',
        attachments: [{ file_id: fileId, media_class: 'voice' }],
      });
      const row = db
        .prepare(`SELECT attachments_blob FROM chat_messages WHERE message_id = ?`)
        .get(messages[0].id) as { attachments_blob: string };
      expect(JSON.parse(row.attachments_blob)).toEqual([
        { file_id: fileId, media_class: 'voice' },
      ]);
      expect(executeAiCall).not.toHaveBeenCalled();
      expect(sends.map((send) => send.text)).toEqual([
        'Voice message received. Transcription is not configured yet.',
      ]);
    } finally {
      await collection?.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
