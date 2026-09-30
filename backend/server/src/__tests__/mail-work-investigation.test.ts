/** Mechanical integration only: scripted model decisions, real Chat loop,
 * mail search/adjacency, SQLite and saved work. This does not score AI judgment. */
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createStorageGate } from '@recued/storage-gate';
import { CHAT_MAIN_TURN_INGREDIENT_SLUG, TIER1_TOOL_DESCRIPTORS, type InternalToolRegistry, type ToolEntry } from '@recued/contracts';
import { mailWorkChatPrompt, type MailWorkIntent } from '../../../../apps/webclient/src/mail/mail-work-investigation.js';
import { createCollectionTable } from '../collections/table.js';
import { createCollectionRegistry } from '../collections/registry.js';
import type { Collection } from '../collections/types.js';
import { buildRecord, mailFtsText } from '../collections/mail/mail-collection.js';
import { buildChatTier1Handlers } from '../chat-tool-handlers.js';
import { createChatOrchestrator } from '../chat-orchestrator.js';
import { handleSessionCreate } from '../chat-handler.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createMailWorkStore } from '../storage/mail-work-store.js';
import { createPreapprovalCodec } from '../storage/preapproval-codec.js';
import { createMailWorkService } from '../mail-work-service.js';

const NOW = Date.parse('2026-09-29T12:00:00Z');
const histories = {
  first_contact: ['Could you explore a Juniper handover? The outcome is still open.'],
  in_progress: ['Please deliver the Juniper kit on Friday.', 'The sample is accepted; Friday is withdrawn. A date is still open.'],
  done: ['Please deliver the Juniper kit on Friday.', 'The sample is accepted; Friday is withdrawn. A date is still open.',
    'Everything is received and paid. Thank you. No further work is needed.'],
  mixed: ['Please deliver the Juniper kit on Friday.', 'The sample is accepted; Friday is withdrawn. A date is still open.',
    'Delivery is accepted. The invoice is still awaiting payment.'],
} as const;
const cases: Array<{ stage: keyof typeof histories; seed: number; intent: MailWorkIntent; tied?: boolean }> = [
  { stage: 'first_contact', seed: 0, intent: 'plan' },
  { stage: 'in_progress', seed: 0, intent: 'catch_up' },
  { stage: 'in_progress', seed: 1, intent: 'orient' },
  ...([0, 1, 2] as const).map(seed => ({ stage: 'done' as const, seed, intent: 'wrap_up' as const })),
  { stage: 'done', seed: 2, intent: 'revisit' },
  { stage: 'mixed', seed: 0, intent: 'orient' },
  ...([0, 1, 2] as const).map(seed => ({ stage: 'done' as const, seed, intent: 'wrap_up' as const, tied: true })),
];

describe('work entry into the Chat investigation loop', () => {
  it.each(cases)('$stage from message $seed with intent $intent (tied dates: $tied) reaches current evidence', async ({ stage, seed, intent, tied }) => {
    const db = new Database(':memory:');
    try {
      ensureChatSchema(db);
      const chatStore = createChatStore(db);
      const table = createCollectionTable({ db, platform: 'mail', slug: 'work', ftsTextFor: mailFtsText });
      const collection: Collection & { neighbours: typeof table.neighbours } = {
        platform: 'mail', slug: 'work', gate: createStorageGate({ quota: 1_000_000, reservePct: 0, surface: 'test:mail' }),
        upsert: table.upsert, delete: id => table.delete(id) !== null, get: table.get, list: table.list, search: table.search, neighbours: table.neighbours,
        health: () => ({ platform: 'mail', slug: 'work', last_indexed_at: NOW, pending_queue_size: 0, error_count_24h: 0, state: 'idle' }),
        sync: { start: async () => {}, stop: async () => {} }, close: async () => {},
        runRetention: async () => { throw new Error('Investigation must not prune mail.'); },
      };
      const registry = createCollectionRegistry(); registry.register(collection);
      histories[stage].forEach((body, index) => {
        // Each reply breaks the provider's thread and omits the project name.
        // FTS alone cannot find the decisive closing message.
        const { record } = buildRecord({ source_id: `message-${index}`, rfc_message_id: `<message-${index}@fixture.test>`,
          thread_id: `broken-${index}`, subject: index === 0 ? 'Juniper request' : 'Re: your message',
          from: 'client@fixture.test', to: ['owner@fixture.test'], cc: [], direction: 'inbound', folder_or_label: 'INBOX',
          is_read: true, is_flagged: false, has_attachments: false, received_at: NOW - 10_000 + (tied ? 0 : index * 1000), body_text: body }, () => NOW);
        table.upsert({ ...record, record_id: `mail:${index}`, body_inline: body });
      });
      const service = createMailWorkService({ store: createMailWorkStore(db, createPreapprovalCodec(() => new Uint8Array(32).fill(17))),
        registry, body: async record => record.body_inline ?? null, now: () => NOW });
      let detail = await service.create({ request_id: randomUUID(), email: { slug: 'work', record_id: `mail:${seed}` } });
      if (intent === 'revisit') detail = await service.update({ id: detail.work.id, expected_revision: detail.work.revision,
        status: 'resolved', resolution_note: 'Delivery and payment confirmed. I want to learn from this work.' });
      const before = detail.work;
      const handlers = buildChatTier1Handlers({ getCollectionRegistry: () => registry, now: () => NOW,
        getContactStore: () => undefined, getAuditLog: () => undefined, getEnrichmentStore: () => undefined,
        getRecipeStore: () => { throw new Error('No recipe dispatch expected.'); },
        getExecutorConfig: () => { throw new Error('No execution expected.'); }, getExecuteRecipe: () => undefined });
      const catalog: ToolEntry[] = (['mail.search', 'mail.read'] as const).map(name => ({ ...TIER1_TOOL_DESCRIPTORS[name], tier: 1 }));
      const dispatched: Array<Record<string, unknown>> = [];
      const tools: InternalToolRegistry = { list: () => catalog, listByTier: tier => tier === 1 ? catalog : [],
        getByName: name => catalog.find(tool => tool.name === name) ?? null, subscribeRefresh: () => () => {},
        dispatch: async (name, args, context) => {
          expect(['mail.search', 'mail.read']).toContain(name); dispatched.push(args as Record<string, unknown>);
          return handlers[name as 'mail.search' | 'mail.read']!(args, context);
        },
      };
      let rounds = 0;
      let providedEvidence = '';
      const seen = new Set<string>();
      const selfSignature = { server_kind: 'recued' as const, version: 'test', instance_id: 'work-test' };
      const orchestrator = createChatOrchestrator({ chatStore, registry: tools, now: () => NOW,
        selfSignature, broadcast: { emit() {} },
        executeAiCall: async (manifest, input) => {
          if (manifest.slug !== CHAT_MAIN_TURN_INGREDIENT_SLUG) return { body: {
            intent: 'Investigate the selected work', constraints: [], pending: [], findings: [], completed: [],
          } };
          const packet = JSON.parse(String(input['llm.prompt']));
          // The real entry sends locators and owner context, not a preloaded
          // conversation or a prior AI brief. Discover the anchor from it.
          const message = String(packet.user_message);
          const context = JSON.parse(message.slice(message.indexOf('{\n'), message.lastIndexOf('}') + 1));
          const anchor = context.conversations[0];
          // Locators only: a subject or thread id is mail text, and the tools supply it privately.
          expect(Object.keys(anchor).sort()).toEqual(['seed_record_id', 'slug']);
          providedEvidence += JSON.stringify(packet.prior_tool_calls ?? []);
          for (const call of packet.prior_tool_calls ?? []) {
            if (call.tool_name === 'mail.read' && typeof call.result?.record_id === 'string') seen.add(call.result.record_id);
            for (const match of call.result?.matches ?? []) {
              seen.add(match.record_id);
              expect(match.received_at_iso).toMatch(/^2026-09-29T/);
              expect(match.source_url).toBe(`#data/mail/record/work/${encodeURIComponent(match.record_id)}`);
            }
          }
          // The prompt's first step: read the seed and its neighbours, batched.
          const calls = rounds++ === 0
            ? [{ tool: 'mail.read', args: { slug: anchor.slug, record_id: anchor.seed_record_id } },
              { tool: 'mail.search', args: { near_id: anchor.seed_record_id, slug: anchor.slug, prev: 5, next: 5 } }]
            : rounds === 2 ? [{ tool: 'mail.search', args: { near_id: anchor.seed_record_id, slug: anchor.slug, prev: 10, next: 10 } },
              { tool: 'mail.search', args: { query: 'Juniper' } }] : [];
          return { body: { response: calls.length ? 'Reading relevant messages.' : `Located ${[...seen].sort().join(', ')}.`, events: [], tool_calls: calls } };
        },
      });
      const chatDeps = { store: chatStore, orchestrator, selfSignature };
      const opened = await handleSessionCreate(chatDeps, { creation_id: detail.chat_session_id, title: detail.work.title });
      expect(await handleSessionCreate(chatDeps, { creation_id: detail.chat_session_id })).toEqual(opened);
      await orchestrator.runTurn({ session_id: opened.session_id, message: mailWorkChatPrompt(detail, intent), picker_state: { current: 'self' } });
      expect(rounds).toBe(3);
      expect([...seen].sort()).toEqual(histories[stage].map((_, index) => `mail:${index}`));
      expect(providedEvidence).toContain(histories[stage].at(-1));
      expect(dispatched.some(args => args.prev === 10 && args.next === 10)).toBe(true);
      const messages = await chatStore.listMessages(opened.session_id);
      const answer = messages.find(message => message.role === 'assistant');
      expect(answer?.content).toContain('Located');
      expect(answer?.tool_calls).toHaveLength(4);
      expect(answer?.tool_calls?.every(call => call.status === 'ok')).toBe(true);
      expect((await service.get(detail.work.id)).work).toEqual(before);
    } finally { db.close(); }
  });
});
