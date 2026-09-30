/** Real storage, mail table, work service and RPC handlers; deterministic AI only. */
import type { CollectionRecord } from '@recued/contracts';
import { createCollectionTable } from '../../../../backend/server/src/collections/table.js';
import { createMailWorkStore } from '../../../../backend/server/src/storage/mail-work-store.js';
import { createPreapprovalCodec } from '../../../../backend/server/src/storage/preapproval-codec.js';
import { createMailWorkService } from '../../../../backend/server/src/mail-work-service.js';
import { makeMailWorkRpcHandlers } from '../../../../backend/server/src/mail-work-rpc-handler.js';
import type { WsClient } from '../../../../backend/server/src/ws-server.js';
import { createQueueFixture } from './chat-queue-backend.js';

export const createMailWorkFixture = () => {
  const chat = createQueueFixture({ emit() {} });
  chat.release();
  const table = createCollectionTable({ db: chat.db, platform: 'mail', slug: 'work',
    ftsTextFor: row => `${row.hot_fields.subject} ${row.hot_fields.from} ${row.body_inline ?? ''}` });
  const addMail = (id: string, thread_id: string, body: string, subject = 'Acme revised offer'): CollectionRecord => {
    const record: CollectionRecord = { record_id: id, source_id: `rfc-${id}`, received_at: Date.now(), modified_at: Date.now(),
      size_bytes: body.length, body_inline: body, hot_fields: { from: 'client@example.test', to: ['owner@example.test'],
        subject, date: new Date().toISOString(), thread_id, direction: 'inbound' } };
    table.upsert(record); return record;
  };
  addMail('seed', 'client', 'Please prepare a revised offer for Acme.');
  addMail('coworker', 'internal', 'Acme pricing needs approval. Capacity is available.', 'Acme pricing');
  let reviewGate: (() => Promise<void>) | undefined;
  const store = createMailWorkStore(chat.db, createPreapprovalCodec(() => new Uint8Array(32).fill(21)));
  const service = createMailWorkService({ store,
    registry: { get: (platform, slug) => platform === 'mail' && slug === 'work' ? table : undefined,
      list: () => [{ platform: 'mail', slug: 'work', search: table.search }] },
    body: async record => record.body_inline ?? null,
    hasInvestigation: async sessionId => Boolean(chat.db.prepare("SELECT 1 FROM chat_messages WHERE session_id=? AND role IN ('user','assistant') LIMIT 1").get(sessionId)),
    ai: async input => {
      await reviewGate?.();
      const packet = JSON.parse(String(input['llm.prompt']));
      const seed = packet.prior_tool_calls.find((call: { result: { subject: string } }) => call.result.subject === 'Acme revised offer');
      return { claims: [
        { kind: 'request', text: 'The client requested a revised offer.', basis: 'email', sources: [seed.result.source] },
        { kind: 'question', text: 'Confirm the approval needed before making a new promise.', basis: 'inference', sources: [] },
        { kind: 'next_action', text: 'Prepare pricing options and ask for approval.', basis: 'inference', sources: [] },
      ], search_queries: ['Acme pricing'] };
    },
  });
  const handlers = makeMailWorkRpcHandlers(service)!.handlers;
  const client: WsClient = { ws: null, realm: 'mail-work-test', instance_id: 'browser', display_name: 'Browser', connected_at: 0, client_kind: 'webclient' };
  return { service, store, addMail, close: chat.close,
    delayReview: (gate?: () => Promise<void>) => { reviewGate = gate; },
    async rpc(method: string, args: Record<string, unknown>): Promise<unknown> {
      if (Object.hasOwn(handlers, method)) return handlers[method as keyof typeof handlers](args as never, client);
      if (method === 'collection.listInstances') return { instances: [{ platform: 'mail', slug: 'work', adapter_type: 'gmail',
        auth_state: 'healthy', last_synced_at: Date.now(), caps: { read: 'yes', write: 'no', delete: 'no', watch: 'none', mirror: 'full', auth: 'none', path_style: 'posix' } }] };
      if (method === 'collection.get') return { record: table.get(String(args.record_id)) };
      if (method === 'collection.list') return { records: table.list({ platform: 'mail', slug: 'work', limit: 100 }) };
      if (method === 'mail_fact.email.get') return { fact_count: 0, security_notice: false };
      if (method === 'data.timeline') return { entries: [], timeline: [] };
      if (method === 'collection.mail.list') return { instances: [] };
      if (method === 'collection.contract.session_grant.list') return { grants: [] };
      if (method === 'mail.drafts.list') return { drafts: [], next_cursor: null };
      return chat.rpc(method, args);
    },
  };
};
