import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionSource } from '@recued/contracts';
import { createKernelAdapter } from '@recued/ingredients';
import { assetKernelReadGates } from '../asset-kernel-read-gates.js';
import { createReadScope, assertKernelReadScope } from '../situations/read-scope.js';
import type { SituationAccess } from '../situations/access.js';
import { createSphereStore } from '../storage/sphere-store.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { buildChatTier1Handlers, type ChatToolHandlerDeps } from '../chat-tool-handlers.js';
import { runWorkEntityReadTool, runWorkEntitySearchTool, type WorkEntityReadToolsDeps } from '../work-entity-read-tools.js';
import { createSituationQuery } from '../situations/query.js';
import { buildSituationSources, situationSourceAccess } from '../situations/sources.js';
import { createReminderStore } from '../storage/reminder-store.js';
import { createContactStore } from '../storage/contact-store.js';
import { situationPersonName } from '../situations/model-projection.js';

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); ensureWorkEntitySchema(db); }); afterEach(() => db.close());
const source: ExecutionSource = { channel: 'reactive', actor: 'system', event_kind: 'fixture', source_recipe: 'fixture', contract_id: 'scoped' };
const ctx = { execution_source: source, channel: 'mcp_wire', mcp_token_id: 'fixture' } as never;
const grants = { isVerbOpGranted: () => true, isCollectionReadGranted: () => true, isTopicReadGranted: () => true };
const fixture = async () => {
  const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const resolver = createWorkEntityResolver(work); const dispatchers = createWorkEntityDispatchers({ store: work, resolver });
  const spheres = createSphereStore(db, work);
  const scoped = () => ({ owner: false, spheres: ['professional' as const], grants, referenceSphere: (ref: { collection: string; id: string }) => spheres.resolve(ref).sphere });
  const access = { context: scoped, fence: scoped,
    fieldVersion: async () => { throw new Error('Unexpected field probe'); },
    read: async () => { throw new Error('Unexpected situation read'); }, prefetch: async () => { throw new Error('Unexpected prefetch'); } } as SituationAccess;
  const home = (await dispatchers.commitmentCreate({ statement: 'Family-only secret', direction: 'outbound', derivation: 'user_declared', counterparty_contact_id: 'private-person' })).commitment;
  const business = (await dispatchers.commitmentCreate({ statement: 'Business delivery', direction: 'outbound', derivation: 'user_declared', counterparty_contact_id: 'private-person' })).commitment;
  const unknown = (await dispatchers.commitmentCreate({ statement: 'Unsorted secret', direction: 'outbound', derivation: 'user_declared' })).commitment;
  spheres.setItem({ collection: 'commitment', id: home.id }, 'personal'); spheres.setItem({ collection: 'commitment', id: business.id }, 'professional');
  const deps: WorkEntityReadToolsDeps = { isVerbOpGranted: () => true, isCollectionReadGranted: () => true,
    getResolver: () => resolver, getTargetedReadDeps: () => undefined, getReadScope: () => createReadScope(access, source) };
  return { work, resolver, dispatchers, spheres, access, home, business, unknown, deps };
};
describe('D-325 scopes at the other read boundaries', () => {
  it('applies the same contact sphere fence through the production situation adapter', async () => {
    const f = await fixture(); f.spheres.setItem({ collection: 'contact', id: 'private-person' }, 'personal');
    const query = createSituationQuery({ sources: buildSituationSources({ db, work: f.work, reminders: createReminderStore(db), calendars: () => [],
      timeZone: () => 'UTC', sphere: ref => f.spheres.resolve(ref).sphere }), sourceForCollection: situationSourceAccess });
    const result = await query({ time: Date.now(), text: 'Business delivery', surface: 'tool' }, f.access.context(source, null));
    expect(result.clusters.flatMap(cluster => cluster.items).map(item => item.ref.id)).toEqual([f.business.id]);
    expect(JSON.stringify(result)).not.toContain('private-person');
  });
  it('pages and counts generic work only after item placement and strips an out-of-sphere contact', async () => {
    const f = await fixture(); const gates = assetKernelReadGates(f.dispatchers, { resolveForSource: () => grants, resolveForContract: () => grants }, f.access);
    const result = await gates.workEntityList!({ kind: 'commitment', limit: 1, origin_execution_source: source });
    expect(result.total).toBe(1); expect(result.entities.map(row => row.id)).toEqual([f.business.id]);
    expect(JSON.stringify(result)).not.toMatch(/Family-only|Unsorted secret|private-person/);
    await expect(gates.workEntityGet!({ kind: 'commitment', id: f.home.id, origin_execution_source: source })).rejects.toThrow(/permission refusal/);
  });
  it('returns only the verified local sphere through native work search and read', async () => {
    const f = await fixture(); const result = await runWorkEntitySearchTool(f.deps, { kind: 'commitment' }, ctx);
    expect(result.ok).toBe(true); expect((result as { result: { total: number } }).result.total).toBe(1);
    expect(JSON.stringify(result)).toContain('Business delivery'); expect(JSON.stringify(result)).not.toMatch(/Family-only|Unsorted secret|private-person/);
    const denied = await runWorkEntityReadTool(f.deps, { kind: 'commitment', id: f.home.id }, ctx);
    expect(JSON.stringify(denied)).toContain('permission refusal'); expect(JSON.stringify(denied)).not.toContain('Family-only');
    const allowed = await runWorkEntityReadTool(f.deps, { kind: 'commitment', id: f.business.id, include_related: true }, ctx);
    expect(JSON.stringify(allowed)).toContain('Business delivery'); expect(JSON.stringify(allowed)).not.toContain('private-person');
  });
  it('names an asset\'s holder to a scoped door only when the holder is in its spheres', async () => {
    // An AI app's door reads `work.read` through the chat's own handler, unaliased: the
    // holder's name is a contact read, so it follows the contact's sphere, not the asset's.
    const f = await fixture(); const contacts = createContactStore(db);
    const colleague = contacts.upsertManual({ email: 'cam@example.test', name: 'Cam Colleague' }, 1);
    const family = contacts.upsertManual({ email: 'fay@example.test', name: 'Fay Family' }, 1);
    f.spheres.setItem({ collection: 'contact', id: colleague.contact_id! }, 'professional');
    f.spheres.setItem({ collection: 'contact', id: family.contact_id! }, 'personal');
    const laptop = (holder: string) => {
      const row = f.work.writeAsset({ source_id: 'recued.asset', source: { kind: 'owner', ref: 'fixture' }, name: 'Laptop', holder_contact: holder });
      f.spheres.setItem({ collection: 'asset', id: row.id }, 'professional'); return row;
    };
    const read = async (id: string) => JSON.stringify(await runWorkEntityReadTool({ ...f.deps, personName: situationPersonName(contacts) }, { kind: 'asset', id }, ctx));
    expect(await read(laptop(colleague.contact_id!).id)).toContain('"holder_name":"Cam Colleague"');
    const outside = await read(laptop(family.contact_id!).id);
    expect(outside).toContain('Laptop'); expect(outside).not.toContain('Fay Family');
    // A search finds an asset by its holder's name by the same rule: a match would say
    // who holds it as plainly as the name.
    const search = async (query: string) => JSON.stringify(await runWorkEntitySearchTool({ ...f.deps, personName: situationPersonName(contacts) },
      { kind: 'asset', query }, ctx));
    const cam = await search('Cam laptop'); expect(cam).toContain('"total":1'); expect(cam).toContain('"holder_name":"Cam Colleague"');
    const fay = await search('Fay laptop'); expect(fay).toContain('"total":0'); expect(fay).not.toContain('Fay Family');
    const both = await search('laptop'); expect(both).toContain('"total":2'); expect(both).toContain('"holder_name":"Cam Colleague"');
    expect(both).not.toContain('Fay Family');
  });

  it('refuses a raw calendar read before the dispatcher when it cannot apply item scopes', async () => {
    const f = await fixture(); const calendarList = vi.fn(async () => ({ records: [] }));
    const adapter = createKernelAdapter({ calendarList, assertReadScope: (slug, origin) => assertKernelReadScope(f.access, slug, origin) });
    await expect(adapter({ slug: 'calendar-list', input: {}, stepMeta: { execution_source: source } } as never)).rejects.toThrow(/permission refusal/);
    expect(calendarList).not.toHaveBeenCalled();
  });
  it('refuses native mail/contact/calendar reads before touching their stores', async () => {
    const f = await fixture(); const getContactStore = vi.fn(); const getCollectionRegistry = vi.fn();
    const handlers = buildChatTier1Handlers({ getSituationAccess: () => f.access, getContactStore, getCollectionRegistry } as unknown as ChatToolHandlerDeps);
    for (const tool of ['mail.search', 'mail.read', 'contact.search', 'contact.read', 'calendar.search']) {
      // A real target, so an unfenced read would reach the store.
      const args = tool === 'contact.read' ? { target_id: 'ana@castellanos.test' } : {};
      const result = await handlers[tool]!(args, ctx); expect(JSON.stringify(result)).toContain('permission refusal');
    }
    expect(getContactStore).not.toHaveBeenCalled(); expect(getCollectionRegistry).not.toHaveBeenCalled();
  });
});
