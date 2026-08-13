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
  /** D-172 P2 — wire the tail/turn attachment-marker's name resolver. Absent
   *  (the default, and what every pre-existing case here uses) means the
   *  marker degrades to empty, which is why those cases still pin a bare
   *  `user_message`. */
  fileNames?: ReadonlyMap<string, string>;
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
      ...(input.fileNames
        ? { resolveFileNames: () => input.fileNames! }
        : {}),
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

  // ⛔⛔ THE CURRENT TURN, NOT THE TAIL. `buildChatTail` runs BEFORE the user
  // row is appended (so the message does not appear twice in the packet), which
  // means the file the person JUST dropped is NOT in the tail. Marking only the
  // tail shipped a discovery guarantee that fired one turn LATE — the
  // motivating case, drop a file and say "send this to Bob", reached the model
  // with no marker at all. The seam tests over `buildChatTail` all passed
  // throughout; only driving a real messenger turn shows it.
  it('names the file on the SAME turn it arrived on, not one turn later', async () => {
    const bytes = Buffer.from('voice bytes');
    const result = await runScenario({
      mediaRef: {
        type: 'voice',
        mime: 'audio/ogg',
        size: bytes.length,
        remote_id: 'F-voice-marked',
      },
      bytes,
      transcript: 'send this to Bob',
      fileNames: new Map([
        // The scenario's own ingest mints this id; resolve ANY id to a name so
        // the assertion does not have to predict it.
      ]),
    });
    const marked = promptBody<{ user_message: string }>(result.aiInputs[0]).user_message;
    // With an empty resolver nothing resolves, so the marker is empty — REAL
    // FILENAMES OR NOTHING. This half pins the safe degradation.
    expect(marked).toBe('send this to Bob');
  });

  it('marks the current turn once the name resolves', async () => {
    const bytes = Buffer.from('voice bytes');
    let capturedId = '';
    const result = await runScenario({
      mediaRef: {
        type: 'voice',
        mime: 'audio/ogg',
        size: bytes.length,
        remote_id: 'F-voice-named',
      },
      bytes,
      transcript: 'send this to Bob',
      // Resolve whatever id the ingest minted — the harness hands the resolver
      // the real ids, so echoing a fixed name proves the wiring without
      // predicting the hash.
      fileNames: new Proxy(new Map<string, string>(), {
        get(target, prop) {
          if (prop === 'get') {
            return (id: string) => { capturedId = id; return 'voice.ogg'; };
          }
          return Reflect.get(target, prop);
        },
      }) as ReadonlyMap<string, string>,
    });
    const marked = promptBody<{ user_message: string }>(result.aiInputs[0]).user_message;
    expect(marked).toBe(
      `send this to Bob\n[files attached to this message: voice.ogg (${capturedId})]`,
    );
    // ⚠ The STORED message keeps what the person sent — the marker is on the
    // model's copy only.
    expect(result.userMessage).toMatchObject({ content: 'send this to Bob' });
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
    // ⛔ ZERO AI CALLS ON A WORDLESS DROP, and this is the assertion that keeps
    // it that way. A file arriving is not a question; running a turn would
    // spend a provider call guessing an intent nobody has stated.
    expect(result.executeAiCall).not.toHaveBeenCalled();
    // ⚠ Was "Attachment received." — a dead end that reports an event and
    // invites nothing. The reply now ASKS, so the person's next message carries
    // the intent and the model gets `{file_refs, user_prompt}` on ONE call.
    expect(result.sends.map((send) => send.text)).toEqual([
      'Stored your file. What would you like me to do with it?',
    ]);
  });

  it('names the stored file in the ask when the name resolves', async () => {
    const bytes = Buffer.from('image bytes');
    const result = await runScenario({
      mediaRef: {
        type: 'image',
        mime: 'image/png',
        size: bytes.length,
        remote_id: 'F-image-named',
      },
      bytes,
      fileNames: new Proxy(new Map<string, string>(), {
        get(target, prop) {
          if (prop === 'get') return () => 'site-photo.png';
          return Reflect.get(target, prop);
        },
      }) as ReadonlyMap<string, string>,
    });
    expect(result.sends.map((send) => send.text)).toEqual([
      'Stored site-photo.png. What would you like me to do with it?',
    ]);
    // Still free.
    expect(result.executeAiCall).not.toHaveBeenCalled();
  });
});
