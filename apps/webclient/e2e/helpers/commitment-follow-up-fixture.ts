import Database from 'better-sqlite3';
import type { Page } from '@playwright/test';
import type { Commitment, ContactRecord, MailDraft, MailDraftContent } from '@recued/contracts';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../../../../backend/server/src/storage/work-entity-store.js';
import { createContactStore } from '../../../../backend/server/src/storage/contact-store.js';
import { handleContactGet, handleContactUpsert } from '../../../../backend/server/src/contact-handler.js';
import { createWorkEntityResolver } from '../../../../backend/server/src/work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../../../../backend/server/src/work-entity-ingredients.js';
import { makeWorkEntityCrudHandlers } from '../../../../backend/server/src/work-entity-crud-handler.js';

/** Real work/contact owners; mail transport and AI results stay controlled. */
export const installCommitmentFollowUpFixture = async (page: Page) => {
  const db = new Database(':memory:'); ensureWorkEntitySchema(db);
  const store = createWorkEntityStore(db), contacts = createContactStore(db), bus = createWarehouseEventBus();
  const now = Date.parse('2026-11-20T12:00:00Z'), contactDeps = { store: contacts, now: () => now };
  const person = (await handleContactUpsert(contactDeps, { email: 'riley@example.test', name: 'Riley <team>' })).contact;
  store.registerSource({ id: 'recued.commitment', top_tier_kind: 'commitment', source_kind: 'builtin', source_label: 'Recued', write_capable: true });
  store.writeCommitment({ id: 'promise-one', source_id: 'recued.commitment', statement: 'Send the revised proposal <team>',
    direction: 'outbound', derivation: 'user_declared', promised_at: now,
    promised_for_at: Date.parse('2026-11-21T00:00:00Z'), counterparty_contact_id: person.contact_id }, now);
  const resolver = createWorkEntityResolver(store);
  const handlers = makeWorkEntityCrudHandlers({ store, resolver,
    dispatchers: createWorkEntityDispatchers({ store, resolver, bus }), contactDisplay: contacts })!.handlers;
  const held = new Set<string>(), releases = new Map<string, () => void>(), completed: Record<string, number> = {};
  const executions: Array<{ recipe_id: string; config: Record<string, unknown> }> = [], writes: string[] = [];
  let contactOverride: ContactRecord | null | undefined, failContact = false;
  let mode: 'ready' | 'draft_only' | 'none' | 'unavailable' = 'ready', saved: MailDraft | null = null;
  const pause = async (method: string) => { if (held.delete(method)) await new Promise<void>(done => releases.set(method, done)); };
  await page.exposeFunction('__commitmentFollowUpRpc', async (method: string, raw: Record<string, unknown> = {}) => {
    try {
      let result: unknown;
      if (method === 'work_entity.source.list') result = { sources: store.listSources() };
      else if (method === 'contact.get') {
        if (failContact) throw new Error('Contact details interrupted.');
        result = contactOverride === undefined ? await handleContactGet(contactDeps, raw as { email: string }) : { contact: contactOverride };
      } else if (method === 'data.timeline') result = { entries: [] };
      else if (method === 'collection.mail.list') {
        if (mode === 'unavailable') throw new Error('Mail accounts interrupted.');
        result = { instances: mode === 'none' ? [] : [{ slug: 'work', adapter_type: 'gmail', account_email: 'owner@example.test',
          send_capable: mode === 'ready', draft_capable: true, receive_capable: true, auth_state: 'healthy', caps: {} }] };
      } else if (method === 'mail.drafts.create' || method === 'mail.drafts.update') {
        writes.push(method);
        saved = { draft_id: 'mad_00000000-0000-4000-8000-000000000001', incarnation: 'commitment-draft',
          revision: (saved?.revision ?? 0) + 1, content: structuredClone(raw.content) as MailDraftContent,
          origin_contract_id: null, created_at: now, updated_at: now + 1 };
        result = structuredClone(saved);
      } else if (method === 'mail.drafts.get') result = saved;
      else if (method === 'mail.drafts.list') result = { drafts: saved ? [saved] : [] };
      else if (method === 'execute') {
        executions.push(structuredClone(raw) as { recipe_id: string; config: Record<string, unknown> });
        result = raw.recipe_id === 'draft-composed-mail'
          ? { success: true, output: { render: [{ type: 'text', data: 'Hello Riley,\nHere is an update on the proposal.' }] } }
          : { success: false, awaiting_approval: true };
      } else {
        const handler = handlers[method as keyof typeof handlers]; if (!handler) return undefined;
        if (method === 'work_entity.upsert' || method.startsWith('work_entity.commitment.')) writes.push(method);
        result = await handler(raw as never, { instance_id: 'commitment-follow-up-browser', client_kind: 'webclient' } as never);
      }
      await pause(method); completed[method] = (completed[method] ?? 0) + 1;
      return { result };
    } catch (error) { return { error: { code: 'unavailable', message: error instanceof Error ? error.message : String(error) } }; }
  });
  await page.addInitScript(() => {
    Object.assign(window, { __connectionsFixture: (method: string, args: Record<string, unknown>) =>
      (window as unknown as { __commitmentFollowUpRpc(method: string, args: Record<string, unknown>): Promise<unknown> }).__commitmentFollowUpRpc(method, args) });
  });
  return { person, executions, writes, saved: () => structuredClone(saved),
    mode: (value: typeof mode) => { mode = value; }, failContact: (value: boolean) => { failContact = value; },
    replyContact: (value: ContactRecord | null | undefined) => { contactOverride = value; },
    change: (patch: Partial<Commitment>) => store.writeCommitment({ ...store.readCommitment('promise-one')!, ...patch }, now + 1),
    seed: (id: string, patch: Partial<Commitment> = {}) => store.writeCommitment({ ...store.readCommitment('promise-one')!, id, ...patch }, now + 2),
    hold: (method: string) => held.add(method), waiting: (method: string) => releases.has(method),
    completed: (method: string) => completed[method] ?? 0,
    release: (method: string) => { const done = releases.get(method); releases.delete(method); done?.(); },
    dispose() { for (const done of releases.values()) done(); bus.dispose(); db.close(); },
  };
};
