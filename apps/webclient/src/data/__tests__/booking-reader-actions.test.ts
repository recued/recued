import { expect, it, vi } from 'vitest';
import type { Booking, ContactRecord, WorkEntityGetRpcResponse } from '@recued/contracts';
import { renderBookingDetail } from '@recued/ui-shared/work-entity-page';
import { bookingEmailBrief, bookingHistoryKey, createBookingReaderActions } from '../booking-reader-actions.js';

type Deps = Parameters<typeof createBookingReaderActions>[0];
const customer: ContactRecord = { _id: 'riley@example.test', _collection: 'contact', contact_id: 'contact-one', email: 'riley@example.test',
  name: 'Riley <team>', source: 'manual', created_at: 1, updated_at: 1, first_seen: 1, last_interaction: 1, interaction_count: 0 };
const booking: Booking & { _kind: 'booking' } = { _kind: 'booking', id: 'booking-one', source_id: 'recued.booking', source_record_id: 'native-one',
  title: 'Consultation <team>', lifecycle_state: 'confirmed', created_at: 100, updated_at: 100, last_seen_at: 100, state_changed_at: 100,
  sync_state: 'live', conflict_policy: 'recued_wins', counterparty_contact_id: customer.contact_id,
  slot_start_at: Date.parse('2026-11-21T19:30:00Z'), slot_end_at: Date.parse('2026-11-21T20:30:00Z') };
const previous = { ...booking, id: 'previous/二?', created_at: 50, title: 'Previous consultation', lifecycle_state: 'completed' as const };
const entry = { id: previous.id, created_at: previous.created_at, title: previous.title, lifecycle_state: previous.lifecycle_state, state_changed_at: 70 };
const response: WorkEntityGetRpcResponse = { entity: booking, booking_history: { counterparty_contact_id: customer.contact_id!, entries: [entry], total: 1 } };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const setup = () => {
  const state: { active: boolean; response: WorkEntityGetRpcResponse; person: ContactRecord | null; previous: WorkEntityGetRpcResponse['entity'] } = {
    active: true, response, person: customer, previous };
  const get = vi.fn<NonNullable<Deps['get']>>(async ({ id }) => id === previous.id ? { entity: state.previous } : state.response);
  const contact = vi.fn<NonNullable<Deps['contact']>>(async () => ({ contact: state.person }));
  const openContact = vi.fn(), openHistory = vi.fn(), openMail = vi.fn<Deps['openMail']>(async () => ({ opened: true }));
  const changed = vi.fn(), beforeLeave = vi.fn(() => true), focus = vi.fn();
  const model = createBookingReaderActions({ get, contact, openContact, openHistory, openMail, changed, beforeLeave, focus });
  const bind = async (snapshot = response, key = 'visit-one') => {
    model.bind(snapshot, key, () => state.active); await vi.waitFor(() => expect(model.view()?.customer.state).not.toBe('loading'));
  };
  return { state, get, contact, openContact, openHistory, openMail, changed, beforeLeave, focus, model, bind };
};

it('resolves a customer once per reader visit without displaying its opaque ID or changing the booking', async () => {
  const f = setup(), saved = structuredClone(response); await f.bind(); await f.bind();
  expect(f.contact).toHaveBeenCalledExactlyOnceWith({ email: customer.contact_id }); expect(f.get).not.toHaveBeenCalled();
  expect(f.model.view()?.customer).toMatchObject({ state: 'ready', label: customer.name, can_open: true });
  const html = renderBookingDetail({ booking, history: response.booking_history, actions: f.model.view() });
  expect(html).toContain('Riley &lt;team&gt;'); expect(html).not.toContain(customer.contact_id); expect(html).not.toContain('<team>');
  expect(response).toEqual(saved);
});

it('uses the canonical customer returned by the owner for a merged ID without rewriting the booking', async () => {
  const f = setup(); f.state.person = { ...customer, contact_id: 'survivor', name: 'Surviving customer' };
  await f.bind(); expect(f.model.view()?.customer).toMatchObject({ label: 'Surviving customer', message: 'Merged contact.' });
  await f.model.contact(); expect(f.openContact).toHaveBeenCalledExactlyOnceWith(f.state.person);
  expect(booking.counterparty_contact_id).toBe(customer.contact_id);
});

it('keeps missing or interrupted customer reads retryable, and treats an unlinked booking honestly', async () => {
  const f = setup(); f.state.person = null; await f.bind(); expect(f.model.view()?.customer).toMatchObject({ label: 'Customer unavailable', state: 'missing' });
  expect(f.model.view()?.can_email).toBe(false);
  f.contact.mockRejectedValueOnce(new Error('Contact interrupted.')); f.model.retryCustomer();
  await vi.waitFor(() => expect(f.model.view()?.customer.state).toBe('error'));
  f.state.person = customer; f.model.retryCustomer(); await vi.waitFor(() => expect(f.model.view()?.customer.state).toBe('ready'));
  const count = f.contact.mock.calls.length; await f.bind({ entity: { ...booking, counterparty_contact_id: undefined } }, 'unlinked');
  expect(f.contact).toHaveBeenCalledTimes(count); expect(f.model.view()?.customer).toMatchObject({ state: 'none', label: 'Not linked', can_open: false });
});

it('rechecks the booking and the displayed customer before opening the profile', async () => {
  const f = setup(); await f.bind(); await f.model.contact();
  expect(f.get).toHaveBeenCalledExactlyOnceWith({ kind: 'booking', id: booking.id }); expect(f.contact).toHaveBeenCalledTimes(2);
  expect(f.openContact).toHaveBeenCalledExactlyOnceWith(customer); expect(f.openMail).not.toHaveBeenCalled();
  f.state.person = { ...customer, created_at: 900 }; await f.model.contact();
  expect(f.openContact).toHaveBeenCalledTimes(1); expect(f.model.view()?.error).toContain('same identity');
});

it('refuses a replaced booking or a changed customer before any navigation or composition', async () => {
  for (const patch of [{ created_at: 900 }, { source_record_id: 'replacement' }, { deleted_at: 900 }, { counterparty_contact_id: 'other-person' }]) {
    const f = setup(); await f.bind(); f.state.response = { entity: { ...booking, ...patch } }; await f.model.contact();
    expect(f.openContact).not.toHaveBeenCalled(); expect(f.openMail).not.toHaveBeenCalled(); expect(f.model.view()?.error).toBeTruthy();
  }
});

it('opens the existing email composer with a verified recipient and quoted booking facts', async () => {
  const f = setup(); await f.bind(); await f.model.draft();
  expect(f.openMail).toHaveBeenCalledOnce(); const request = f.openMail.mock.calls[0]![0];
  expect(request.to).toEqual([customer.email]); expect(request.contactContext).toMatchObject({ id: customer.contact_id }); expect(request.focusAi).toBe(true);
  expect(JSON.parse(request.brief!.split('Booking context:\n')[1]!)).toEqual({ customer: customer.name, email: customer.email,
    title: booking.title, saved_status: 'confirmed', starts_at: '2026-11-21T19:30:00.000Z', ends_at: '2026-11-21T20:30:00.000Z' });
  expect(request.isCurrent()).toBe(true); f.state.active = false; expect(request.isCurrent()).toBe(false);
  expect(bookingEmailBrief({ ...booking, slot_start_at: undefined, slot_end_at: undefined }, customer)).toContain('No time agreed');
  expect(bookingEmailBrief({ ...booking, reception_record_id: 'private-reception', source_extension_blob: { visitor_email: 'sealed-private@example.test' } }, customer)).not.toMatch(/private-reception|sealed-private/);
});

it('requires a new review when the booking facts or customer email changed, and blocks unconfirmed source changes', async () => {
  for (const patch of [{ title: 'Changed topic' }, { slot_start_at: booking.slot_start_at! + 1000 }, { lifecycle_state: 'cancelled' as const },
    { pending_write: { operation: 'update' as const, state: 'pending' as const, staged_at: 200, dirty_fields: ['title'] } }]) {
    const f = setup(); await f.bind(); f.state.response = { entity: { ...booking, ...patch } }; await f.model.draft(); expect(f.openMail).not.toHaveBeenCalled();
  }
  const f = setup(); await f.bind(); f.state.person = { ...customer, email: 'changed@example.test' }; await f.model.draft();
  expect(f.openMail).not.toHaveBeenCalled(); expect(f.model.view()?.error).toContain('email address changed');
  await f.bind({ entity: { ...booking, sync_state: 'stale_unreachable' } }, 'stale'); expect(f.model.view()?.can_email).toBe(false);
});

it('opens only a history entry from this snapshot after checking its lifetime and customer', async () => {
  const f = setup(); await f.bind(); await f.model.history('forged'); expect(f.get).not.toHaveBeenCalled();
  await f.model.history(bookingHistoryKey(entry)); expect(f.get.mock.calls).toEqual([[{ kind: 'booking', id: booking.id }], [{ kind: 'booking', id: previous.id }]]);
  expect(f.openHistory).toHaveBeenCalledExactlyOnceWith(entry, { entity: previous });
});

it('marks a missing, reused, reassigned or reopened history row unavailable and allows an explicit retry', async () => {
  for (const target of [null, { ...previous, created_at: 999 }, { ...previous, counterparty_contact_id: 'other' }, { ...previous, lifecycle_state: 'confirmed' as const }]) {
    const f = setup(); await f.bind(); f.state.previous = target; await f.model.history(bookingHistoryKey(entry));
    expect(f.openHistory).not.toHaveBeenCalled(); expect(f.model.view()?.history?.[0]?.error).toContain('no longer available');
    f.state.previous = previous; await f.model.history(bookingHistoryKey(entry)); expect(f.openHistory).toHaveBeenCalledOnce();
    expect(f.model.view()?.history?.[0]?.error).toBeUndefined();
  }
});

it('protects drafts before and after delayed reads and retires a check when its reader is replaced', async () => {
  const f = setup(); await f.bind(); f.beforeLeave.mockReturnValueOnce(false); await f.model.contact(); expect(f.get).not.toHaveBeenCalled();
  const held = deferred<WorkEntityGetRpcResponse>(); f.get.mockReturnValueOnce(held.promise); const pending = f.model.contact();
  await f.model.draft(); expect(f.get).toHaveBeenCalledTimes(1); f.beforeLeave.mockReturnValue(false); held.resolve(response); await pending;
  expect(f.openContact).not.toHaveBeenCalled(); expect(f.model.view()?.busy).toBeUndefined();
  f.beforeLeave.mockReturnValue(true); const stale = deferred<WorkEntityGetRpcResponse>(); f.get.mockReturnValueOnce(stale.promise); const old = f.model.contact();
  f.model.reset(); await f.bind({ entity: { ...booking, id: 'booking-two', counterparty_contact_id: undefined } }, 'visit-two');
  stale.resolve(response); await old; expect(f.openContact).not.toHaveBeenCalled(); expect(f.model.view()?.error).toBeUndefined();
});

it('escapes customer labels, history errors and opaque action keys in the booking reader', () => {
  const html = renderBookingDetail({ booking, history: { ...response.booking_history!, entries: [{ ...entry, id: '\" onfocus=alert(1)' }] },
    actions: { customer: { state: 'ready', label: '</dd><script>bad</script>', can_open: true, can_retry: true }, can_email: true, can_history: true,
      history: [{ key: bookingHistoryKey({ ...entry, id: '\" onfocus=alert(1)' }), error: '<img src=x>' }] } });
  expect(html).not.toContain('<script>'); expect(html).not.toContain('<img'); expect(html).not.toContain('" onfocus=');
  expect(html).toContain('&lt;script&gt;'); expect(html).toContain('&lt;img src=x&gt;');
});
