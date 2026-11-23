/** D-343 slice 1 (ruling 14) — the chat changes a booking, as the owner's booking dialog does:
 *  how it went (`state`: completed, no_show, cancelled, confirmed), its time (`starts_at`, and
 *  `ends_at` or its kept length) or its title, through `work.update`. Before this, `work.update`
 *  took no booking at all. Nothing tells a booking's visitor, as the dialog does not, so a
 *  booking made from the reception page answers that its visitor was not told.
 *
 *  ⛔ DRIVEN ON THE REAL STORE, DISPATCHERS AND HANDLERS: the times are the store's. */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tier1CallTitle, type Booking, type ExecutionSource } from '@recued/contracts';
import { BOOKING_UPDATE_OP_ID, buildChatTier1Handlers, checkWorkUpdate, type ChatToolHandlerDeps } from '../chat-tool-handlers.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { runWorkEntitySearchTool } from '../work-entity-read-tools.js';

const owner: ExecutionSource = { channel: 'chat', actor: 'user_self', chat_session_id: 'chat-1', user_id: 'user-1' };
/** The owner's chat before they are asked (the check), and once they approved the call. */
const inChat = { channel: 'internal_function_call', session_id: 'sess-1', execution_source: owner, time_zone: 'Europe/Dublin' } as never;
const approved = { channel: 'internal_function_call', session_id: 'sess-1', execution_source: owner, owner_approved: true, time_zone: 'Europe/Dublin' } as never;
type Ok = { ok: true; result: Record<string, unknown> };
type Refused = { ok: false; reason: string; detail: string };
const NOW = Date.parse('2026-11-06T18:00:00Z');
const HOUR = 3_600_000;
/** 3 pm on 9 November 2026, an hour long. */
const AT = Date.parse('2026-11-09T15:00:00Z');

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); });
afterEach(() => db.close());

const harness = (granted: (op: string) => boolean = () => true) => {
  ensureWorkEntitySchema(db); const store = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(store);
  const resolver = createWorkEntityResolver(store);
  const dispatchers = createWorkEntityDispatchers({ store, resolver, now: () => NOW });
  const deps = {
    getWorkEntityCrudDeps: () => ({ store, resolver, dispatchers }),
    getOpAdmissionGate: () => ({ isFrozenByPause: () => false, isOpGranted: (_source: ExecutionSource, op?: string) => op === undefined || granted(op) }),
    now: () => NOW,
  } as unknown as ChatToolHandlerDeps;
  const update = buildChatTier1Handlers(deps)['work.update']!;
  const book = async (title: string, patch: Partial<Booking> = {}): Promise<Booking> => (await dispatchers.bookingCreate({
    title, slot_start_at: AT, slot_end_at: AT + HOUR, ...patch } as never)).booking;
  return { store, dispatchers, deps, update, book };
};

describe('D-343 slice 1 — the chat changes a booking', () => {
  it('records how a booking went, asked before the owner is, under a title in their words', async () => {
    const f = harness();
    for (const [state, title] of [['completed', 'Mark a booking completed'], ['no_show', 'Mark a booking a no-show'],
      ['cancelled', 'Cancel a booking']] as const) {
      const haircut = await f.book(`Haircut (${state})`);
      const call = { kind: 'booking', id: haircut.id, state };
      expect(tier1CallTitle('work.update', call)).toBe(title);
      expect(await checkWorkUpdate(f.deps, call, inChat)).toBeNull();
      expect(f.store.readBooking(haircut.id)!.lifecycle_state).toBe('confirmed');
      expect(await f.update(call, approved)).toEqual({ ok: true, result: { updated: true, kind: 'booking', id: haircut.id, fields: ['state'] } });
      expect(f.store.readBooking(haircut.id)).toMatchObject({ lifecycle_state: state, state_changed_at: NOW });
    }
    // A pending one, confirmed.
    const enquiry = await f.book('Consultation', { lifecycle_state: 'pending' });
    expect(await f.update({ kind: 'booking', id: enquiry.id, state: 'confirmed' }, approved)).toMatchObject({ ok: true });
    expect(f.store.readBooking(enquiry.id)!.lifecycle_state).toBe('confirmed');
  });
  it('moves a booking to the instant named, keeping its length unless an end is given', async () => {
    const f = harness();
    const haircut = await f.book('Haircut');
    const move = { kind: 'booking', id: haircut.id, starts_at: '2026-11-12T10:00+00:00' };
    expect(tier1CallTitle('work.update', move)).toBe('Move a booking');
    expect(await checkWorkUpdate(f.deps, move, inChat)).toBeNull();
    expect(await f.update(move, approved)).toEqual({ ok: true, result: { updated: true, kind: 'booking', id: haircut.id, fields: ['starts_at'] } });
    expect(f.store.readBooking(haircut.id)).toMatchObject({ slot_start_at: Date.parse('2026-11-12T10:00:00Z'), slot_end_at: Date.parse('2026-11-12T11:00:00Z'),
      lifecycle_state: 'confirmed' });
    // An end of its own, and an offset honoured: 9 am in Paris is 8 am UTC.
    expect(await f.update({ kind: 'booking', id: haircut.id, starts_at: '2026-11-13T09:00+01:00', ends_at: '2026-11-13T09:30+01:00' }, approved))
      .toMatchObject({ ok: true, result: { fields: ['starts_at', 'ends_at'] } });
    expect(f.store.readBooking(haircut.id)).toMatchObject({ slot_start_at: Date.parse('2026-11-13T08:00:00Z'), slot_end_at: Date.parse('2026-11-13T08:30:00Z') });
  });
  it('finds it by the id work.search gives', async () => {
    const f = harness();
    const ryokan = await f.book('Kyoto ryokan');
    const found = await runWorkEntitySearchTool({ getResolver: () => createWorkEntityResolver(f.store), getTargetedReadDeps: () => undefined,
      isCollectionReadGranted: () => true, isVerbOpGranted: () => true }, { kind: 'booking', query: 'ryokan' }, inChat) as Ok;
    const id = (found.result.entities as Array<{ id: string }>)[0]!.id;
    expect(id).not.toBe(ryokan.id);
    expect(await f.update({ kind: 'booking', id, state: 'cancelled' }, approved)).toMatchObject({ ok: true, result: { id } });
    expect(f.store.readBooking(ryokan.id)!.lifecycle_state).toBe('cancelled');
  });
  it('says the visitor was not told when a reception booking is moved or cancelled, and only then', async () => {
    const f = harness();
    const NOTE = 'Its visitor booked it through the user\'s reception page and has not been told. Say so, and ask the user whether '
      + 'to tell them. If they want to, call "tools.search" for "tell a booking\'s visitor about a change" and run it with this '
      + 'booking\'s id and a short message for the visitor; it asks the user before it sends.';
    const visit = await f.book('Consultation', { reception_record_id: 'submission-1' });
    expect(await f.update({ kind: 'booking', id: visit.id, starts_at: '2026-11-12T10:00+00:00' }, approved)).toMatchObject({ result: { note: NOTE } });
    expect(await f.update({ kind: 'booking', id: visit.id, state: 'cancelled' }, approved)).toMatchObject({ result: { note: NOTE } });
    const other = await f.book('Second consultation', { reception_record_id: 'submission-2' });
    expect((await f.update({ kind: 'booking', id: other.id, state: 'completed' }, approved) as Ok).result).not.toHaveProperty('note');
    const own = await f.book('Haircut');
    expect((await f.update({ kind: 'booking', id: own.id, starts_at: '2026-11-12T10:00+00:00' }, approved) as Ok).result).not.toHaveProperty('note');
  });
});

describe('D-343 slice 1 — what a booking’s change refuses, each before the owner is asked', () => {
  it('refuses what a booking cannot take, and writes nothing', async () => {
    const f = harness();
    const haircut = await f.book('Haircut');
    const untimed = await f.book('Enquiry', { slot_start_at: undefined, slot_end_at: undefined } as never);
    for (const [call, words] of [
      [{ id: haircut.id, done: true }, 'a booking takes `state`, `starts_at`, `ends_at` and `title`, not `done`; how it went is its `state`, `completed` or `no_show`'],
      [{ id: haircut.id, body: 'Bring the voucher' }, 'not `body`'],
      [{ id: haircut.id, state: 'pending' }, "a booking's `state` is `completed`, `no_show`, `cancelled` or `confirmed`"],
      [{ id: haircut.id, state: 'done' }, "a booking's `state` is"],
      [{ id: haircut.id, starts_at: '2026-11-12T10:00' }, '`starts_at` is a time with its offset'],
      [{ id: haircut.id, starts_at: '2026-11-12' }, '`starts_at` is a time with its offset'],
      [{ id: haircut.id, starts_at: String(AT) }, '`starts_at` is a time with its offset'],
      [{ id: haircut.id, ends_at: '2026-11-12T11:00+00:00' }, 'send `ends_at` with `starts_at`'],
      [{ id: haircut.id, starts_at: '2026-11-12T10:00+00:00', ends_at: '2026-11-12T09:00+00:00' }, '`ends_at` is after `starts_at`'],
      [{ id: untimed.id, starts_at: '2026-11-12T10:00+00:00' }, '“Enquiry” has no time yet, so send `ends_at` with `starts_at`'],
      [{ id: haircut.id, title: 'x'.repeat(201) }, "a booking's `title` is what was booked, at most 200 characters"],
      [{ id: haircut.id, state: 'confirmed' }, '“Haircut” already says that, so nothing would change'],
      [{ id: haircut.id }, "send a booking's new `state`, `starts_at` or `title`"],
      [{ id: 'no-such-booking', state: 'completed' }, "booking 'no-such-booking' not found"],
    ] as const) {
      const refused = await checkWorkUpdate(f.deps, { kind: 'booking', ...call }, inChat) as Refused;
      expect(refused, JSON.stringify(call)).toMatchObject({ ok: false, reason: 'invalid_args' });
      expect(refused.detail, JSON.stringify(call)).toContain(words);
    }
    expect(f.store.readBooking(haircut.id)).toEqual(haircut);
    // A booking's time on another kind.
    const task = (await f.dispatchers.taskCreate({ title: 'Book the dentist' } as never)).task;
    expect((await checkWorkUpdate(f.deps, { kind: 'task', id: task.id, starts_at: '2026-11-12T10:00+00:00' }, inChat) as Refused).detail)
      .toBe('work.update: `starts_at` applies to a booking only');
  });
  it('keeps to the contract’s grants', async () => {
    const f = harness((op) => op !== BOOKING_UPDATE_OP_ID);
    const haircut = await f.book('Haircut');
    expect(await f.update({ kind: 'booking', id: haircut.id, state: 'completed' }, approved)).toMatchObject({ ok: false, reason: 'classification_blocked' });
    expect(f.store.readBooking(haircut.id)!.lifecycle_state).toBe('confirmed');
  });
});
