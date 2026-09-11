/** D-262 — a voice note sent from the OWNER'S OWN client is the utterance.
 *
 *  The messenger turn has transcribed voice-only notes since D-172 A.9. The
 *  webclient turn did not: a voice memo attached with no text fell into the P2
 *  wordless-drop branch and was answered "Stored memo.webm. What would you like
 *  me to do with it?" — correct for a spreadsheet, wrong for something a person
 *  said.
 *
 *  ⛔ THE LOAD-BEARING CASE IS THE SECOND ONE. `composer-attachments.ts` calls
 *  its `media_class` ADVISORY in as many words; if the server took the client's
 *  claim as the answer, a `media_class: 'voice'` label on a PDF would spend a
 *  transcription call on it. The claim narrows what is worth reading; the
 *  STORED mime decides. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
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
  type InboundFileCollection,
} from '../collections/file/inbound-file-collection.js';
import { createCollectionRegistry } from '../collections/registry.js';

const NOW = Date.UTC(2030, 3, 2, 10, 0, 0);
const SESSION = 'sess-d262-voice';

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

// D-262 § B1 — the DEDICATED source. ⚠ Note what is absent: no `slot_1`, no
// free pool, no `modalities.audio`. Transcription no longer routes through the
// chat pool, so a config with nothing but this slot must still transcribe —
// which is the structural guarantee that a voice turn can never silently
// replace the model the owner pinned for chat.
const audioConfig: LLMConfig = {
  transcription_slot: {
    provider: 'openai',
    model: 'whisper-1',
    api_key: 'sk-test',
  },
};

const promptBody = <T,>(input: Record<string, unknown> | undefined): T => {
  expect(input).toBeDefined();
  const raw = input?.['llm.prompt'];
  expect(typeof raw).toBe('string');
  return JSON.parse(raw as string) as T;
};

interface Upload {
  /** What the BROWSER reported at upload — `webclient_upload` stores it as-is
   *  ("that is the reception allowlist's job; the webclient owner is
   *  trusted"), so this is exactly how a mislabel reaches the record. */
  mime_type: string;
  filename: string;
  bytes: Buffer;
  /** What the CLIENT claims on `chat.send`. Advisory by contract. */
  claimed_class: string;
}

interface ScenarioInput {
  message: string;
  uploads: Upload[];
  transcript?: string;
  transcribeThrows?: boolean;
  /** Omit the whole capability, as a server with no audio-capable source has. */
  withoutTranscription?: boolean;
}

const runScenario = async (input: ScenarioInput) => {
  const root = mkdtempSync(join(tmpdir(), 'd262-voice-'));
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

    // The same ingest call `webclient-upload-service.finalize` makes, with the
    // same origin and the same browser-reported mime.
    const attachments: Array<{ file_id: string; media_class: string }> = [];
    const names = new Map<string, string>();
    for (const [index, upload] of input.uploads.entries()) {
      const record = await collection.ingest({
        bytes: upload.bytes,
        size_bytes: upload.bytes.length,
        filename: upload.filename,
        mime_type: upload.mime_type,
        origin: 'webclient_upload',
        source_id: `upload-${index}`,
        now: NOW,
      });
      attachments.push({
        file_id: record.record_id,
        media_class: upload.claimed_class,
      });
      names.set(record.record_id, upload.filename);
    }

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
        if (input.transcribeThrows) throw new Error('transcription failed');
        return { text: input.transcript ?? 'transcribed voice text' };
      },
    });

    const orchestrator = createChatOrchestrator({
      chatStore,
      registry: internalRegistry(),
      selfSignature,
      executeAiCall,
      resolveFileNames: () => names,
      ...(input.withoutTranscription
        ? {}
        : {
            voiceTranscription: {
              getFileReadDeps: () => ({ registry, blobs }),
              transcribeDeps: {
                config: audioConfig,
                adapters,
                quota: createQuotaTracker(),
                tabProbe: async () => new Set(),
                webChatSupported: false,
              },
            },
          }),
      now: () => NOW,
    } as never);

    await orchestrator.runTurn({
      session_id: SESSION,
      message: input.message,
      picker_state: { current: 'self' },
      ...(attachments.length > 0 ? { attachments } : {}),
    } as never);

    const messages = await chatStore.listMessages(SESSION);
    return {
      aiInputs,
      attachments,
      executeAiCall,
      messages,
      transcribeRequests,
      user: messages.find((m) => m.role === 'user'),
      assistant: messages.find((m) => m.role === 'assistant'),
    };
  } finally {
    await collection?.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
};

const voiceUpload = (over: Partial<Upload> = {}): Upload => ({
  mime_type: 'audio/webm',
  filename: 'voice-note-20300402-100000.webm',
  bytes: Buffer.from('opus bytes'),
  claimed_class: 'voice',
  ...over,
});

describe('D-262 — the owner\'s own voice note is the utterance', () => {
  it('transcribes a voice-only attachment into the turn text, and keeps the audio on the row', async () => {
    const result = await runScenario({
      message: '',
      uploads: [voiceUpload()],
      transcript: 'move the Thursday call to Friday',
    });

    // The durable user row IS the transcript — not an empty string with a
    // transcript rendered somewhere else. This is what a reconnect-replay
    // shows and what the recall cursor indexes.
    expect(result.user).toMatchObject({
      role: 'user',
      content: 'move the Thursday call to Friday',
      attachments: [{ file_id: result.attachments[0]!.file_id, media_class: 'voice' }],
    });
    // The model reasoned over the transcript, and it ran at all — a wordless
    // drop spends ZERO ai calls, so this distinguishes the two branches.
    expect(result.executeAiCall).toHaveBeenCalledTimes(1);
    expect(
      promptBody<{ user_message: string }>(result.aiInputs[0]).user_message,
    ).toContain('move the Thursday call to Friday');
    // The bytes that went to the provider are the ones that were stored.
    expect(Buffer.from(result.transcribeRequests[0]!.audio)).toEqual(
      Buffer.from('opus bytes'),
    );
    expect(result.transcribeRequests[0]).toMatchObject({ mime_type: 'audio/webm' });
    // ⛔ And the wordless-drop affordance did NOT also fire.
    expect(result.assistant?.content).not.toContain('What would you like me to do');
  });

  it('⛔ REFUSES a client that CLAIMS voice over a record whose stored mime is not audio', async () => {
    const result = await runScenario({
      message: '',
      uploads: [voiceUpload({
        mime_type: 'application/pdf',
        filename: 'quarterly.pdf',
        claimed_class: 'voice',
      })],
    });

    // Not one transcription call. If the claim decided, a PDF would have been
    // sent to an audio model on the say-so of the caller.
    expect(result.transcribeRequests).toHaveLength(0);
    expect(result.executeAiCall).not.toHaveBeenCalled();
    expect(result.user?.content).toBe('');
    expect(result.assistant?.content).toBe(
      'Stored quarterly.pdf. What would you like me to do with it?',
    );
  });

  it('⛔ SAYS TRANSCRIPTION FAILED when a CONFIGURED source fails — not "here is your file"', async () => {
    const result = await runScenario({
      message: '',
      uploads: [voiceUpload({ filename: 'memo.webm' })],
      transcribeThrows: true,
    });

    // It was attempted — the failure is the adapter's, not a missed branch.
    expect(result.transcribeRequests).toHaveLength(1);
    expect(result.user?.content).toBe('');
    // D-262 § B8 — the owner configured a transcription slot SPECIFICALLY so
    // this would work. Answering "Stored memo.webm. What would you like me to
    // do with it?" talks about a file as though they had dropped one, when in
    // fact they spoke and the thing they set up broke. It names the step that
    // failed so they look at the slot rather than at their microphone.
    expect(result.assistant?.content).toContain("couldn't transcribe");
    expect(result.assistant?.content).toContain('Settings');
    expect(result.assistant?.content).not.toContain('What would you like me to do with it?');
    expect(result.executeAiCall).not.toHaveBeenCalled();
  });

  it('⚠ but a MISLABELLED file is a file drop, not a transcription failure', async () => {
    const result = await runScenario({
      message: '',
      uploads: [voiceUpload({
        mime_type: 'application/pdf',
        filename: 'quarterly.pdf',
        claimed_class: 'voice',
      })],
    });

    // Nothing was transcribed and nothing broke — the claim was simply wrong.
    // Saying "I couldn't transcribe that" about a PDF names the wrong problem.
    expect(result.transcribeRequests).toHaveLength(0);
    expect(result.assistant?.content).toBe(
      'Stored quarterly.pdf. What would you like me to do with it?',
    );
  });

  it('⛔ says NOTHING about transcription when no source is configured at all', async () => {
    const result = await runScenario({
      message: '',
      uploads: [voiceUpload({ filename: 'memo.webm' })],
      withoutTranscription: true,
    });

    // Unconfigured is a SETUP state, not a breakage — and the webclient mic
    // never renders without a slot, so this arrives only from a surface where
    // the wordless-drop copy is already the right answer.
    expect(result.assistant?.content).toBe(
      'Stored memo.webm. What would you like me to do with it?',
    );
    expect(result.assistant?.content).not.toContain("couldn't transcribe");
  });

  it('degrades to the wordless drop when no transcription capability is wired at all', async () => {
    const result = await runScenario({
      message: '',
      uploads: [voiceUpload({ filename: 'memo.webm' })],
      withoutTranscription: true,
    });

    expect(result.assistant?.content).toBe(
      'Stored memo.webm. What would you like me to do with it?',
    );
    expect(result.executeAiCall).not.toHaveBeenCalled();
  });

  it('⚠ treats an EMPTY transcript as a failure, not as an utterance', async () => {
    const result = await runScenario({
      message: '',
      uploads: [voiceUpload({ filename: 'silence.webm' })],
      transcript: '   ',
    });

    // A silent recording must not become a wordless prompt to the model: the
    // turn would spend a call on nothing and the row would read as if the
    // person had said something.
    expect(result.executeAiCall).not.toHaveBeenCalled();
    expect(result.assistant?.content).toBe(
      'Stored silence.webm. What would you like me to do with it?',
    );
  });

  it('leaves a TYPED turn alone — speak-and-type is not a voice turn', async () => {
    const result = await runScenario({
      message: 'have a look at this',
      uploads: [voiceUpload()],
      transcript: 'should never be reached',
    });

    // Typed words are the utterance; the note is an attachment like any other.
    expect(result.transcribeRequests).toHaveLength(0);
    expect(result.user?.content).toBe('have a look at this');
    expect(result.executeAiCall).toHaveBeenCalledTimes(1);
  });

  it('⚠ does not transcribe when a SECOND file rides along', async () => {
    const result = await runScenario({
      message: '',
      uploads: [
        voiceUpload(),
        voiceUpload({ filename: 'notes.pdf', mime_type: 'application/pdf', claimed_class: 'document' }),
      ],
    });

    // Same rule the messenger path holds (`media.length === 1`): two files is a
    // drop, not an utterance — there is no single thing that was "said".
    expect(result.transcribeRequests).toHaveLength(0);
    expect(result.assistant?.content).toContain('What would you like me to do with them?');
  });
});
