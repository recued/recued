import Database from 'better-sqlite3';
import type { Page } from '@playwright/test';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../../../../backend/server/src/storage/work-entity-store.js';
import { createWorkEntityResolver } from '../../../../backend/server/src/work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../../../../backend/server/src/work-entity-ingredients.js';
import { handleWorkEntityGet, handleWorkEntityList, handleWorkEntityUpsert, handleWorkEntityCommitmentClose } from '../../../../backend/server/src/work-entity-crud-handler.js';
import type { WorkEntityListRpcRequest } from '@recued/contracts';

export const COMMITMENT_FIXTURE_NOW = Date.parse('2026-10-29T19:00:00Z');
export const installCommitmentWorkspaceFixture = async (page: Page) => {
  const now = COMMITMENT_FIXTURE_NOW, day = 86_400_000;
  const db = new Database(':memory:'); ensureWorkEntitySchema(db); const store = createWorkEntityStore(db);
  for (const [id, write_capable, source_label] of [['recued.commitment', true, 'Recued'], ['readonly.commitment', false, 'Imported promises']] as const) {
    store.registerSource({ id, top_tier_kind: 'commitment', source_kind: 'builtin', source_label, write_capable });
  }
  const write = (id: string, extra: Partial<Parameters<typeof store.writeCommitment>[0]> = {}) => store.writeCommitment({
    id, statement: `Review promise ${id}`, direction: 'outbound', promised_at: now - day,
    promised_for_at: now + day, source_id: 'recued.commitment', derivation: 'user_declared', ...extra,
  }, now);
  for (let i = 0; i < 205; i++) write(`ordinary-${String(i).padStart(3, '0')}`);
  write('maya-outbound', { statement: 'Send Maya the revised proposal', promised_for_at: now - day, due_status: 'overdue', counterparty_contact_id: 'maya-contact' });
  write('maya-inbound', { statement: 'Maya will send the signed agreement', direction: 'inbound', promised_for_at: now - day, due_status: 'overdue', counterparty_contact_id: 'maya-contact' });
  write('search-target', { statement: 'Prepare École_100% release', promised_for_at: now + 365 * day });
  write('old-fulfilled', { statement: 'Send the original proposal', lifecycle_state: 'fulfilled', due_status: 'overdue' });
  write('readonly-promise', { statement: 'Imported promise', source_id: 'readonly.commitment', direction: 'inbound' });
  const resolver = createWorkEntityResolver(store);
  const deps = { store, resolver, dispatchers: createWorkEntityDispatchers({ store, resolver, bus: createWarehouseEventBus() }),
    contactDisplay: { getByContactIdResolved: (id: string) => id === 'maya-contact' ? { contact_id: id, name: 'Maya Chen', email: 'maya@example.test' } : null } };
  const reads: WorkEntityListRpcRequest[] = [], writes: Array<{ method: string; args: unknown }> = [];
  await page.exposeFunction('__commitmentWorkspaceRpc', async (method: string, raw: unknown) => {
    try {
      let result: unknown;
      if (method === 'work_entity.source.list') result = { sources: store.listSources() };
      else if (method === 'work_entity.list') {
        const args = raw as WorkEntityListRpcRequest; reads.push(structuredClone(args));
        result = await handleWorkEntityList(deps, args);
      } else if (method === 'work_entity.get') result = await handleWorkEntityGet(deps, raw as never);
      else if (method === 'work_entity.upsert') { writes.push({ method, args: raw }); result = await handleWorkEntityUpsert(deps, raw as never); }
      else if (method === 'work_entity.commitment.fulfill' || method === 'work_entity.commitment.cancel') {
        writes.push({ method, args: raw }); result = await handleWorkEntityCommitmentClose(deps, raw as never,
          method.endsWith('fulfill') ? 'fulfilled' : 'cancelled', method.endsWith('fulfill'));
      } else return undefined;
      return { result };
    } catch (error) {
      const err = error as { code?: string; message?: string };
      return { error: { code: err.code ?? 'unavailable', message: err.message ?? 'Fixture request failed.' } };
    }
  });
  await page.addInitScript(() => {
    const methods = new Set(['work_entity.source.list', 'work_entity.list', 'work_entity.get', 'work_entity.upsert', 'work_entity.commitment.fulfill', 'work_entity.commitment.cancel']);
    Object.assign(window, { __connectionsFixture: async (method: string, raw: unknown) => methods.has(method)
      ? (window as unknown as { __commitmentWorkspaceRpc(method: string, raw: unknown): Promise<unknown> }).__commitmentWorkspaceRpc(method, raw) : undefined });
  });
  return { reads, writes, store, close() { db.close(); } };
};
