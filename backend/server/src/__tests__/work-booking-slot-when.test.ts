/** `work.read` and `work.search` write a booking's slot on the turn's clock.
 *
 *  ⛔ Found live (2026-10-25, the family-trip run): `work.read` gave a booking of
 *  November 14–21 only as `slot_start_at: 1794643200000`, and the model, converting
 *  it itself, answered "September 14–21" in one answer and "December 14–21, 2026"
 *  in another, of the 6 that read it. Each booking with a slot now carries
 *  `slot_when`, as `calendar.search` writes an event's `when`.
 *
 *  Through the real handlers over a real work store. */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { buildChatTier1Handlers, type ChatToolHandlerDeps } from '../chat-tool-handlers.js';
import { createReadGrantChecker } from '../read-grant-checker.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';

const NOW = Date.parse('2026-10-25T12:00:00Z');
const disposals: Array<() => void> = [];
afterEach(() => { disposals.splice(0).forEach(close => close()); });

type Item = { id: string; title?: string; slot_start_at?: number; slot_end_at?: number; slot_when?: string };

const fixture = () => {
  const db = new Database(':memory:'); disposals.push(() => db.close());
  ensureWorkEntitySchema(db);
  const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const trip = work.writeBooking({ source_id: 'recued.booking', title: 'Lisbon family trip', lifecycle_state: 'confirmed',
    slot_start_at: Date.parse('2026-11-14T08:00:00Z'), slot_end_at: Date.parse('2026-11-21T18:00:00Z') }, NOW);
  const untimed = work.writeBooking({ source_id: 'recued.booking', title: 'Lisbon dinner', lifecycle_state: 'confirmed' }, NOW);
  const checker = createReadGrantChecker({ isGranted: () => true }, 'owner');
  const deps: ChatToolHandlerDeps = { getCollectionRegistry: () => undefined, getContactStore: () => undefined,
    getAuditLog: () => undefined, getEnrichmentStore: () => undefined,
    getRecipeStore: () => { throw new Error('Unexpected recipe'); }, getExecutorConfig: () => { throw new Error('Unexpected execution'); },
    getExecuteRecipe: () => undefined, getWorkEntityResolver: () => createWorkEntityResolver(work),
    getReadGrantResolver: () => ({ resolveForSource: () => checker, resolveForContract: () => checker }),
    getOpAdmissionGate: () => ({ isOpGranted: () => true, isFrozenByPause: () => false, isOwnerRecipeGranted: () => false, isOwnerGoverned: () => true }),
    now: () => NOW };
  const handlers = buildChatTier1Handlers(deps) as Record<string, (args: unknown, ctx: unknown) => Promise<{ ok: boolean; result: Record<string, unknown> }>>;
  // The owner's own chat, as the orchestrator dispatches it.
  const execution_source = { channel: 'user', actor: 'user_self', user_id: 'owner', client_token_id: 'paired' };
  const ctx = (time_zone?: string) => ({ channel: 'internal_function_call', session_id: 'S', turn_id: 'T', execution_source, ...(time_zone ? { time_zone } : {}) });
  const read = async (id: string, time_zone?: string): Promise<Item> => {
    const r = await handlers['work.read']!({ kind: 'booking', id }, ctx(time_zone));
    expect(r.ok).toBe(true);
    return r.result.entity as Item;
  };
  const search = async (time_zone?: string): Promise<Item[]> => {
    const r = await handlers['work.search']!({ kind: 'booking', query: 'Lisbon' }, ctx(time_zone));
    expect(r.ok).toBe(true);
    return r.result.entities as Item[];
  };
  return { trip, untimed, read, search };
};

describe('work.read / work.search — a booking\'s slot on the turn\'s clock', () => {
  it('⛔ writes the slot as the owner lives it, beside the epoch-ms pair', async () => {
    const f = fixture();
    const lisbon = await f.read(f.trip.id, 'Europe/Lisbon');
    expect(lisbon.slot_when).toBe('2026-11-14 08:00 – 2026-11-21 18:00 (UTC+00:00)');
    expect(lisbon.slot_start_at).toBe(Date.parse('2026-11-14T08:00:00Z'));
    // West of UTC, on the offset of the booking's own dates (after the clocks change).
    expect((await f.read(f.trip.id, 'America/Los_Angeles')).slot_when).toBe('2026-11-14 00:00 – 2026-11-21 10:00 (UTC-08:00)');
    const found = await f.search('Europe/Lisbon');
    // A search names each record by its qualified id; the title is the booking's own.
    expect(found.find(item => item.title === 'Lisbon family trip')?.slot_when).toBe('2026-11-14 08:00 – 2026-11-21 18:00 (UTC+00:00)');
  });

  it('writes nothing for a booking with no time agreed, or when the dispatch names no clock', async () => {
    const f = fixture();
    expect('slot_when' in await f.read(f.untimed.id, 'Europe/Lisbon')).toBe(false);
    expect('slot_when' in await f.read(f.trip.id)).toBe(false);
    const listed = await f.search();
    expect(listed.map(item => item.title).sort()).toEqual(['Lisbon dinner', 'Lisbon family trip']);
    expect(listed.some(item => 'slot_when' in item)).toBe(false);
  });
});
