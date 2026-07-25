/** D-172 A.9 — messenger voice-only intake transcribes to the turn text. */

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
import {
  createQuotaTracker,
  type LLMConfig,
  type TranscriptionAdapterRegistry,
  type TranscriptionRequest,
} from '@recued/llm';
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
import { createCollectionRegistry } from '../collections/registry.js';

const NOW = Date.UTC(2030, 1, 1, 9, 0, 0);
const SESSION = 'sess-d172-a9-voice';

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

const audioConfig: LLMConfig = {
  slot_1: {
    provider: 'openai',
    model: 'gpt-4.1-mini',
    api_key: 'sk-test',
    speed: 'fast',
    supports_json: true,
    modalities: { audio: true },
    transcription_model: 'whisper-1',
  },
};

const promptBody = <T,>(input: Record<string, unknown> | undefined): T => {
  expect(input).toBeDefined();
  const raw = input?.['llm.prompt'];
  expect(typeof raw).toBe('string');
  return JSON.parse(raw as string) as T;
};

interface ScenarioInput {
  mediaRef: MediaRef;
  bytes: Buffer;
  parsedText?: string;
  transcript?: string;
  transcribeThrows?: boolean;
}

const runScenario = async (input: ScenarioInput) => {
  const root = mkdtempSync(join(tmpdir(), 'd172-a9-voice-'));
  const db = new Database(':memory:');
  let collection: InboundFileCollection | undefined;
  try {
    ensureChatSchema(db);
    const chatStore = createChatStore(db);
    chatStore.createSession({ id: SESSION, now: NOW - 1_000 });
    const blobs = createBlobStore(join(root, 'blobs'));
    const registry = createCollectionRegistry();
    collection = createInboundFileCollection({
      db,
      blobs,
      gate: createStorageGate({
        quota: 100 * 1024 * 1024,
        reservePct: 10,
        surface: 'collection:file:received',
      }),
      bus: createWarehouseEventBus(),
      slug: 'received',
      now: () => NOW,
    });
    registry.register(collection);

    const aiInputs: Record<string, unknown>[] = [];
    const executeAiCall = vi.fn<ExecuteChatAiCall>(async (_manifest, aiInput) => {
      aiInputs.push(aiInput);
      return {
        body: {
          response: 'assistant heard it',
          events: [],
          tool_calls: [],
        } satisfies AIOutput,
      };
    });

    const transcribeRequests: TranscriptionRequest[] = [];
    const adapters: TranscriptionAdapterRegistry = (key) => ({
      provider: key,
      async transcribe(_slot, request) {
        transcribeRequests.push(request);
        if (input.transcribeThrows) {
          throw new Error('transcription failed');
        }
        return { text: input.transcript ?? 'transcribed voice text' };
      },
    });

    const orchestrator = createChatOrchestrator({
      chatStore,
      registry: internalRegistry(),
      selfSignature,
      executeAiCall,
      messengerVoiceTranscription: {
        getFileReadDeps: () => ({ registry, blobs }),
        transcribeDeps: {
          config: audioConfig,
          adapters,
          quota: createQuotaTracker(),
          tabProbe: async () => new Set(),
          webChatSupported: false,
        },
      },
      now: () => NOW,
    });

    const sends: OutboundMessage[] = [];
    const mediaTmp = join(root, 'incoming-media.bin');
    const fetchMedia = vi.fn<
      (ref: MediaRef, token: string) => Promise<FetchedMedia>
    >(async () => {
      writeFileSync(mediaTmp, input.bytes);
      return {
        temp_path: mediaTmp,
        size: input.bytes.length,
        head_bytes: input.bytes.subarray(0, 16),
        filename: input.mediaRef.type === 'voice' ? 'voice.ogg' : 'image.png',
        mime_type: input.mediaRef.mime,
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
          text: input.parsedText ?? '',
          vendor_message_id: 'slack-msg-1',
          media: [input.mediaRef],
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
        async ingest(fileInput) {
          const record = await collection!.ingest({
            src_path: fileInput.temp_path,
            size_bytes: fileInput.size,
            filename: fileInput.filename,
            mime_type: fileInput.mime_type,
            origin: 'messenger_media',
            source_id: fileInput.source_id,
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

    const fileId = inboundFileRecordId('messenger_media', 'slack-msg-1:0');
    const messages = await chatStore.listMessages(SESSION);
    const userMessage = messages.find((message) => message.role === 'user');
    const attachmentsBlob = userMessage
      ? (
          db
            .prepare(`SELECT attachments_blob FROM chat_messages WHERE message_id = ?`)
            .get(userMessage.id) as { attachments_blob: string | null }
        ).attachments_blob
      : null;

    return {
      aiInputs,
      executeAiCall,
      fileId,
      messages,
      sends,
      transcribeRequests,
      userMessage,
      attachmentsBlob,
    };
  } finally {
    await collection?.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
};

describe('D-172 A.9 messenger voice transcription', () => {
  it('turns a voice-only messenger note into transcript text and keeps the audio attachment', async () => {
    const bytes = Buffer.from('voice bytes');
    const result = await runScenario({
      mediaRef: {
        type: 'voice',
        mime: 'audio/ogg',
        size: bytes.length,
        remote_id: 'F-voice-1',
      },
      bytes,
      transcript: 'please schedule the 2 pm demo',
    });

    expect(result.userMessage).toMatchObject({
      role: 'user',
      content: 'please schedule the 2 pm demo',
      attachments: [{ file_id: result.fileId, media_class: 'voice' }],
    });
    expect(JSON.parse(result.attachmentsBlob ?? 'null')).toEqual([
      { file_id: result.fileId, media_class: 'voice' },
    ]);
    expect(Buffer.from(result.transcribeRequests[0]!.audio)).toEqual(bytes);
    expect(result.transcribeRequests[0]).toMatchObject({
      mime_type: 'audio/ogg',
      filename: 'voice.ogg',
    });
    expect(promptBody<{ user_message: string }>(result.aiInputs[0]).user_message).toBe(
      'please schedule the 2 pm demo',
    );
    expect(result.sends.map((send) => send.text)).toEqual(['assistant heard it']);
  });

  it('falls back to the pending affordance when transcription fails', async () => {
    const bytes = Buffer.from('voice bytes');
    const result = await runScenario({
      mediaRef: {
        type: 'voice',
        mime: 'audio/ogg',
        size: bytes.length,
        remote_id: 'F-voice-2',
      },
      bytes,
      transcribeThrows: true,
    });

    expect(result.userMessage).toMatchObject({
      role: 'user',
      content: '',
      attachments: [{ file_id: result.fileId, media_class: 'voice' }],
    });
    expect(result.executeAiCall).not.toHaveBeenCalled();
    expect(result.transcribeRequests).toHaveLength(1);
    expect(result.sends.map((send) => send.text)).toEqual([
      'Voice message received. Transcription is not configured yet.',
    ]);
  });

  it('keeps non-voice media on the existing pending path without transcription', async () => {
    const bytes = Buffer.from('image bytes');
    const result = await runScenario({
      mediaRef: {
        type: 'image',
        mime: 'image/png',
        size: bytes.length,
        remote_id: 'F-image-1',
      },
      bytes,
      transcript: 'should not be used',
    });

    expect(result.userMessage).toMatchObject({
      role: 'user',
      content: '',
      attachments: [{ file_id: result.fileId, media_class: 'image' }],
    });
    expect(result.transcribeRequests).toHaveLength(0);
    expect(result.executeAiCall).not.toHaveBeenCalled();
    expect(result.sends.map((send) => send.text)).toEqual([
      'Attachment received.',
    ]);
  });
});
