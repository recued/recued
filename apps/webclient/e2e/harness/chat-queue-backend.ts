import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStorageGate } from '@recued/storage-gate';
import { TIER1_TOOL_DESCRIPTORS, type ToolEntry, type InternalToolRegistry } from '@recued/contracts';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { createInboundFileCollection } from '../../../../backend/server/src/collections/file/inbound-file-collection.js';
import { createEncryptedBlobStore } from '../../../../backend/server/src/storage/blob-store.js';
import { createMessengerAttachmentSource } from '../../../../backend/server/src/chat-messenger-attachments.js';
import { createChatStore, ensureChatSchema } from '../../../../backend/server/src/storage/chat-store.js';
import { createChatOrchestrator, type ChatBroadcastEmitter } from '../../../../backend/server/src/chat-orchestrator.js';
import { createChatMessengerBridge } from '../../../../backend/server/src/chat-messenger-bridge.js';
import { withQueuedChatTurns } from '../../../../backend/server/src/chat-turn-queue.js';
import { handleChatDelivery, handleChatQueue, handleClearSessionBrief, handleGetSessionBrief, handleSessionCreate, handleSend, handleSessionGet, handleSessionsList } from '../../../../backend/server/src/chat-handler.js';

export const createQueueFixture = (broadcast: ChatBroadcastEmitter, delivery = false, attachmentDelivery = false,
  options: { holdInModel?: boolean; holdClosingBrief?: boolean; answer?: string; beforeAnswer?: () => Promise<void>; registry?: InternalToolRegistry;
    modelResponse?: (packet: Record<string, unknown>) => unknown | Promise<unknown> } = {}) => {
  const db = new Database(':memory:'); ensureChatSchema(db); const store = createChatStore(db);
  store.createSession({ id: 's', title: 'Shared conversation' });
  if (options.holdClosingBrief) store.setRollingBriefEnabled(true);

  const selfSignature = { server_kind: 'recued' as const, version: '1', instance_id: 'test' };
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  if (options.holdClosingBrief) {
    const writeEvidence = store.writeMailWorkEvidence!;
    // Exercise the same preview/Stop/reentry boundary when a work turn can
    // retain exact sources instead of calling the closing summarizer.
    store.writeMailWorkEvidence = async (session, json, beforeCommit) => {
      await held;
      await writeEvidence(session, json, beforeCommit);
    };
  }
  const tools: ToolEntry[] = options.holdClosingBrief ? [{ ...TIER1_TOOL_DESCRIPTORS['mail.read'], tier: 1 }] : [];
  const modelInputs: Record<string, unknown>[] = [];
  const raw = createChatOrchestrator({ chatStore: store, selfSignature, broadcast,
    registry: options.registry ?? { list: () => tools, listByTier: () => tools, getByName: name => tools.find(tool => tool.name === name) ?? null,
      dispatch: async () => ({ ok: true, result: { body: 'Please prepare a revised offer for Acme.' } }), subscribeRefresh: () => () => {} },
    ...(options.holdInModel || options.holdClosingBrief || options.modelResponse ? { executeAiCall: async (_manifest, input) => {
      const packet = JSON.parse(String(input['llm.prompt']));
      modelInputs.push(structuredClone(packet));
      // Scripted UI responses use the production plan envelope on prepared
      // work turns. Malformed/error injections remain malformed/error inputs.
      const withWorkPlan = (body: unknown): unknown => {
        const taskShape = (input['llm.output_schema'] as any)?.properties.mail_work_plan.anyOf[0].properties.task;
        const task = taskShape?.const ?? taskShape?.enum?.[0];
        if (task !== 'propose' || !body || typeof body !== 'object' || Array.isArray(body)) return body;
        const answer = body as Record<string, unknown>;
        if (typeof answer.response !== 'string' || !Array.isArray(answer.tool_calls) || answer.tool_calls.length || answer.mail_work_plan) return body;
        const observations = (packet.prior_tool_calls ?? []).flatMap((c: any) => c.tool_name === 'context.mail_work_evidence' ? c.result?.observations ?? [] : [c]);
        const mail = observations.find((c: any) => c.tool_name === 'mail.read' && c.result?.body && c.result?.source_url);
        if (!mail) return body;
        const source = `mail_${createHash('sha256').update(mail.result.source_url).digest('hex').slice(0, 12)}`;
        const passage = packet.prior_tool_calls.find((c: any) => c.tool_name === 'context.mail_work_evidence')
          ?.result?.passage_catalog.find((row: any) => row.source === source)?.id;
        if (!passage) throw new Error('Scripted work answer has no current source passage');
        // Long scripted answers test scrolling/settlement using bounded plan
        // steps. Never truncate a fixture to conceal a production bound.
        const activities: string[] = [];
        for (const raw of answer.response.split('\n\n')) {
          const paragraph = raw.replace(/[\r\n]+/g, ' ');
          if (paragraph.length > 160) throw new Error('Scripted work target exceeds the production bound');
          const last = activities.at(-1);
          if (last && last.length + paragraph.length + 1 <= 160) activities[activities.length - 1] = `${last} ${paragraph}`;
          else activities.push(paragraph);
        }
        if (activities.length > 6) throw new Error('Scripted work answer exceeds the production step count');
        return { ...answer, mail_work_plan: { task, facts: [passage],
          actions: activities.map(target => ({ operation: 'draft', target,
            context: [passage], source_notes: [] })), questions: [] } };
      };
      if (options.modelResponse) return { body: withWorkPlan(await options.modelResponse(packet)) };
      if ('tool_results_since' in packet) {
        await held;
        return { body: { intent: 'Investigate work', constraints: [], pending: [], findings: [], completed: [] } };
      }
      if (options.holdInModel) await held;
      if (options.holdClosingBrief && !packet.prior_tool_calls?.length) {
        return { body: { response: 'Read the selected source.', events: [],
          tool_calls: [{ tool: 'mail.read', args: { slug: 'work', record_id: 'seed' } }] } };
      }
      await options.beforeAnswer?.();
      const observations = (packet.prior_tool_calls ?? []).flatMap((c: { tool_name: string; result?: { observations?: unknown[] } }) => c.tool_name === 'context.mail_work_evidence' ? c.result?.observations ?? [] : [c]);
      const mail = observations.find((c: { tool_name: string; result?: { body?: string } }) => c.tool_name === 'mail.read' && c.result?.body);
      return { body: withWorkPlan({ ...(mail?.result?.source_url ? { mail_work_recap: [{ source: mail.result.source_url, quote: mail.result.body, state: 'current' }] } : {}), response: options.answer ?? 'Start with the proposal due Friday.', events: [], tool_calls: [] }) };
    } } : {}) });
  const executions: string[] = [];
  let deliveries = 0;
  const dir = attachmentDelivery ? mkdtempSync(join(tmpdir(), 'chat-file-browser-')) : undefined;
  const blobs = dir ? createEncryptedBlobStore(join(dir, 'cas'), () => new Uint8Array(32).fill(68)) : undefined;
  const files = dir ? createInboundFileCollection({ db, slug: 'received',
    blobs: blobs!, bus: createWarehouseEventBus(),
    gate: createStorageGate({ quota: 100_000_000, reservePct: 10, surface: 'collection:file:received' }),
  }) : undefined;
  const uploads: Buffer[] = []; let fileId: string | undefined;
  const bridge = delivery ? createChatMessengerBridge({ db, store, broadcast, pollMs: 10, minSendIntervalMs: 0 }) : undefined;
  if (bridge) {
    bridge.bind('slack', 'C123', 'slack:T1:B1', 's');
    bridge.register('slack', { resolve: async () => ({ token: 'fixture', recipient: 'C123', account: 'slack:T1:B1' }),
      send: async () => ++deliveries === 1 && !attachmentDelivery ? { ok: false, error: { kind: 'network', detail: 'receipt lost' } }
        : { ok: true, vendor_message_id: 'confirmed' },
      ...(files ? { attachments: createMessengerAttachmentSource(files, dir),
        sendAttachment: async (file: import('@recued/transport').OutboundAttachment): Promise<import('@recued/transport').TransportSendResult> => {
          await file.beforeSend?.(); uploads.push(readFileSync(file.path));
          return uploads.length === 1 ? { ok: false, error: { kind: 'network', detail: 'lost file receipt' } }
            : { ok: true, vendor_file_id: 'F1' };
        },
      } : {}),
    });
  }
  const orchestrator = withQueuedChatTurns({ ...raw, runTurn: async input => {
    executions.push(input.message); if (executions.length === 1 && !options.holdInModel && !options.holdClosingBrief) await held; return raw.runTurn(input);
  } }, { db, store, broadcast, pollMs: 20, ...(bridge ? { messengerBridge: bridge } : {}) });
  const deps = { store, orchestrator, selfSignature };
  return { executions, release, modelInputs, deliveryCount: () => deliveries, snapshot: () => orchestrator.turnQueue!.snapshot('s'),
    uploads, files, blobs, db,
    messages: () => store.listMessages('s'),
    /** Store a running note, as a fold during a turn would. */
    writeBrief: (session: string, brief: Record<string, unknown>) => store.writeSessionBrief(session, JSON.stringify(brief)),
    removeMessage: (id: string) => { db.prepare('DELETE FROM chat_messages WHERE session_id = ? AND message_id = ?').run('s', id); },
    async addConversationFile(args: { id: string; name: string; source?: string; type?: 'image' | 'document'; ts?: number; session?: string; bytes?: string | Buffer; mime_type?: string }) {
      const file = await files!.ingest({ bytes: Buffer.from(args.bytes ?? args.name), filename: args.name,
        mime_type: args.mime_type ?? (args.type === 'image' ? 'image/png' : 'text/plain'), origin: 'messenger_media',
        source_id: args.source ?? args.id, scan_status: 'clean' });
      const message = await store.appendMessage({ id: args.id, session_id: args.session ?? 's', ts: args.ts ?? Date.now(),
        role: 'user', content: `Shared ${args.name} from Messenger`, attachments: [{ file_id: file.record_id, media_class: args.type ?? 'document' }],
        target_server: 'self', picker_at_send: { display_name: 'Self', signature: selfSignature }, model_used: { provider: 'fixture', model_id: 'fixture' } });
      return { source: file.record_id, version: message.attachments![0]!.file_id };
    },
    async seedReplyHistory() {
      store.createSession({ id: 'other', title: 'Another conversation' });
      const messages: Array<{ id: string; content: string; reply_to?: import('@recued/contracts').ChatReplyReference }> = [
        { id: 'question-1', content: '<img src=x onerror=alert(1)> Original question' },
        ...Array.from({ length: 120 }, (_, i) => ({ id: `middle-${i}`, content: `Middle message ${i}` })),
        { id: 'question-2', content: 'Second question' },
        { id: 'linked', content: 'Retained quoted response', reply_to: { message_id: 'question-1' } },
        { id: 'native-missing', content: 'Reply from Messenger', reply_to: { vendor: 'telegram', native_message_id: '999' } },
        { id: 'removed', content: 'Reply to a removed message', reply_to: { message_id: 'removed-target' } },
      ];
      let ts = Date.now() - messages.length;
      for (const message of messages) await store.appendMessage({ ...message, ts: ts++, session_id: 's', role: 'assistant',
        target_server: 'self', picker_at_send: { display_name: 'Self', signature: selfSignature },
        model_used: { provider: 'fixture', model_id: 'fixture' },
      });
    },
    // Retained historical receipts exercise paging without live vendor sends.
    async seedDeliveryHistory(count: number) {
      bridge!.close();
      for (let i = 0; i < count; i++) await store.appendMessage({ id: `history-${i}`, session_id: 's', role: 'assistant', content: `Retained answer ${i}`,
        target_server: 'self', picker_at_send: { display_name: 'Self', signature: selfSignature }, model_used: { provider: 'fixture', model_id: 'fixture' },
      });
      db.exec("UPDATE chat_deliveries SET state = CASE WHEN message_id = 'history-1' THEN 'skipped' ELSE 'sent' END");
    },
    async addBlockedAttachment() {
      const file = await files!.ingest({ filename: 'Attachment.pdf', bytes: Buffer.from('%PDF-original-file'), mime_type: 'application/pdf',
        origin: 'webclient_upload', source_id: 'browser-file', scan_status: 'pending',
      });
      fileId = file.record_id;
      await store.appendMessage({ id: 'file-message', session_id: 's', role: 'assistant', content: 'Attached document',
        target_server: 'self', picker_at_send: { display_name: 'Self', signature: selfSignature },
        model_used: { provider: 'fixture', model_id: 'fixture' }, attachments: [{ file_id: fileId, media_class: 'document' }],
      });
    },
    allowAttachment: () => { files!.setScanStatus(fileId!, 'clean'); },
    close: () => { orchestrator.turnQueue!.close(); db.close(); if (dir) rmSync(dir, { recursive: true, force: true }); },
    async rpc(method: string, args: unknown): Promise<unknown> {
      if (method === 'chat.session.create') return handleSessionCreate(deps, args as Parameters<typeof handleSessionCreate>[1]);
      if (method === 'chat.sessions.list') return handleSessionsList(deps);
      if (method === 'chat.session.get') return handleSessionGet(deps, args as Parameters<typeof handleSessionGet>[1]);
      if (method === 'chat.send') return handleSend(deps, args as Parameters<typeof handleSend>[1]);
      if (method === 'server.getLLMConfig') return { config: {
        slot_1: { provider: 'openai', model: 'test-model', has_key: true, speed: 'fast' },
      } };
      if (method === 'chat.deliveries.list') return handleChatDelivery(deps, 'list', args);
      if (method === 'chat.delivery.retry') return handleChatDelivery(deps, 'retry', args);
      if (method === 'chat.delivery.skip') return handleChatDelivery(deps, 'skip', args);
      if (method === 'chat.turns.list') return handleChatQueue(deps, 'list', args);
      if (method === 'chat.session.brief.get') return handleGetSessionBrief(deps as never, args as { session_id: string });
      if (method === 'chat.session.brief.clear') return handleClearSessionBrief(deps as never, args as { session_id: string });
      if (method === 'chat.turn.withdraw') return handleChatQueue(deps, 'withdraw', args);
      if (method === 'chat.turn.cancel') return handleChatQueue(deps, 'cancel', args);
      if (method === 'chat.turn.retry') return handleChatQueue(deps, 'retry', args);
      if (method === 'chat.default_model_pref.get') return { source_id: null };
      if (method === 'chat.picker.list') return { entries: [] };
      if (method === 'collection.connection.list') return { connections: [] };
      if (method === 'recipe.list') return { recipes: [] };
      return {};
    } };
};
