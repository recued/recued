/** D-325 §15.7 amendment (2026-11-02, later) — the Agenda over the pair rpc: its own read
 *  (`yours.agenda`), and its settings and Send now as Yours changes, through the real Yours
 *  service bound to the real scheduler. */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SERVER_RPC_METHOD_SET, type SituationFact } from '@recued/contracts';
import type { WsClient } from '../ws-server.js';
import { createSituationQuery } from '../situations/query.js';
import { createSituationAccess } from '../situations/access.js';
import { createScheduledSituations } from '../situations/scheduled-situations.js';
import { createYoursService } from '../situations/yours-service.js';
import { makeYoursHandlers } from '../situations/yours-handler.js';
import { createSituationStore } from '../storage/situation-store.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { createContractStore } from '../storage/contract-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createAssetOccurrenceService } from '../situations/asset-occurrence-service.js';

const at = Date.parse('2026-10-19T05:00:00Z');
const briefing: SituationFact = { ref: { collection: 'calendar', id: 'work:briefing' }, title: 'Morning briefing', kind: 'calendar', basis: 'declared',
  when: { from: Date.parse('2026-10-19T09:00:00Z'), to: Date.parse('2026-10-19T09:30:00Z') }, act_by: Date.parse('2026-10-19T09:00:00Z'),
  valid_until: Date.parse('2026-10-19T09:30:00Z'), people: [], subjects: [], related: [], evidence: [{ collection: 'calendar', id: 'work:briefing' }],
  updated_at: at, consequence: 'routine' };
const paired = { instance_id: 'wc_1', client_kind: 'webclient', user_id: 'owner', client_token_id: 'paired' } as unknown as WsClient;
const stops: Array<() => Promise<void>> = [];
afterEach(async () => { for (const stop of stops.splice(0)) await stop(); });
const fixture = () => {
  const db = new Database(':memory:'); ensureWorkEntitySchema(db); const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const store = createSituationStore(db);
  const query = createSituationQuery({ now: () => at, sourceForCollection: collection => ({ verb_op: 'core.work-entity.read', collection }),
    sources: [{ id: 'calendar', collection: 'calendar', verb_op: 'core.work-entity.read', read: vi.fn(() => [briefing]) }] });
  const send = vi.fn(async () => ({ delivered_to: ['in_app'] }));
  const scheduled = createScheduledSituations({ db, work, store, query, timeZone: () => 'UTC', isVaultUnlocked: () => true, isQuiet: () => false,
    now: () => at, overview: async () => ({ proposal_count: 0, newest_proposal: null, unmatched_replies: [], phone_ready: true }), send });
  scheduled.bindAccess(createSituationAccess({ contracts: createContractStore(db), query, now: () => at, isVaultUnlocked: () => true }));
  const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work), now: () => at });
  const occurrences = createAssetOccurrenceService({ db, work, dispatchers, timeZone: () => 'UTC', now: () => at });
  const yours = createYoursService({ db, work, dispatchers, occurrences, situations: store, now: () => at, timeZone: () => 'UTC', isVaultUnlocked: () => true });
  yours.bindScheduled(scheduled);
  stops.push(async () => { await yours.stop(); await scheduled.stop(); db.close(); });
  const handlers = makeYoursHandlers(yours)!;
  return { handlers, send };
};

describe('D-325 §15.7 amendment (2026-11-02, later) — the Agenda over the pair rpc', () => {
  it('is a method the server dispatches, read apart from the Digest', () => {
    expect(SERVER_RPC_METHOD_SET.has('yours.agenda')).toBe(true);
    expect(fixture().handlers.methods).toContain('yours.agenda');
  });

  it('saves its settings, sends now, and reads its own receipts, for the paired owner only', async () => {
    const { handlers, send } = fixture();
    expect(await handlers.handlers['yours.agenda']!(undefined, paired))
      .toMatchObject({ settings: { enabled: false, time: '07:00', day: 'today', frequency: 'daily', weekday: 1 }, last_run: null });
    expect(await handlers.handlers['yours.change']!({ action: 'agenda.update', settings: { enabled: true, time: '06:30' } }, paired))
      .toEqual({ message: 'Agenda saved.' });
    expect(await handlers.handlers['yours.change']!({ action: 'agenda.send_now' }, paired))
      .toEqual({ message: 'Agenda checked. It is sent only when something is on.' });
    expect(send).toHaveBeenCalledWith({ title: 'Agenda · Mon 19 Oct', text: '09:00 Morning briefing', ui_link_url: '#today' });
    const status = await handlers.handlers['yours.agenda']!(undefined, paired);
    expect(status).toMatchObject({ settings: { enabled: true, time: '06:30', day: 'today' }, last_sent: { mode: 'agenda_manual', text: '09:00 Morning briefing' } });
    // The Digest's own status does not carry the Agenda's run.
    expect(await handlers.handlers['yours.delivery']!(undefined, paired)).toMatchObject({ last_run: null });
    await expect(handlers.handlers['yours.change']!({ action: 'agenda.update', settings: { day: 'yesterday' as never } }, paired))
      .rejects.toThrow('Choose a valid agenda schedule');
    const stranger = { instance_id: 'br_1', client_kind: 'bridge' } as unknown as WsClient;
    await expect(handlers.handlers['yours.agenda']!(undefined, stranger)).rejects.toThrow('Yours requires a paired webclient.');
  });

  // §15.7 amendment (2026-11-03): the weekly choice travels in the same change and read.
  it('saves a weekly agenda, reads it back, and Send now lists the week a day at a time', async () => {
    const { handlers, send } = fixture();
    await handlers.handlers['yours.change']!({ action: 'agenda.update', settings: { enabled: true, frequency: 'weekly', weekday: 7, day: 'tomorrow' } }, paired);
    expect(await handlers.handlers['yours.agenda']!(undefined, paired))
      .toMatchObject({ settings: { enabled: true, time: '07:00', day: 'tomorrow', frequency: 'weekly', weekday: 7 } });
    // Monday 19 October: Send now lists the seven days from tomorrow, as if today were its weekday.
    await handlers.handlers['yours.change']!({ action: 'agenda.send_now' }, paired);
    expect(send).not.toHaveBeenCalled();
    await handlers.handlers['yours.change']!({ action: 'agenda.update', settings: { day: 'today' } }, paired);
    await handlers.handlers['yours.change']!({ action: 'agenda.send_now' }, paired);
    expect(send).toHaveBeenCalledWith({ title: 'Agenda · Mon 19 Oct to Sun 25 Oct', text: 'Mon 19 Oct\n09:00 Morning briefing', ui_link_url: '#today' });
    await expect(handlers.handlers['yours.change']!({ action: 'agenda.update', settings: { frequency: 'monthly' as never } }, paired))
      .rejects.toThrow('Choose a valid agenda schedule');
  });
});
