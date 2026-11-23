import { expect, it, vi } from 'vitest';
import type { Booking, WorkEntityGetRpcResponse } from '@recued/contracts';
import { bookingCopyText, workRecordLink } from '../work-reader-copy.js';
import { parseRecordLinkQuery, readExactRecordLink, verifyExactRecordLink } from '../exact-record-link.js';
import { readWorkLinkPreview } from '../work-link-preview.js';
import { searchRecordLinks } from '../record-link-insert.js';
import { createWorkRecordChat } from '../commitment-chat.js';
import { selectedRecordsWire, readSelectedRecordsWire, verifySelectedRecord } from '../../chat/selected-records.js';
import { copyComposerRecoveryDraft } from '../../chat/draft-recovery.js';
import { serializeShellRoute } from '../../shell/route.js';

const booking: Booking & { _kind: 'booking' } = { _kind: 'booking', id: 'consult/二?', title: 'Consultation <team>', source_id: 'recued.booking', source_record_id: 'provider-one',
  lifecycle_state: 'no_show', state_changed_at: 100, created_at: 100, updated_at: 100, last_seen_at: 100, sync_state: 'live', conflict_policy: 'recued_wins',
  counterparty_contact_id: 'opaque-contact', monetary_value: { amount: '120', currency: 'USD' } };
const href = 'https://app.test/tools/client/?pair=secret#data/search', hash = serializeShellRoute('data', 'booking', booking.id);
const target = { tab: 'booking' as const, id: booking.id, hash };
const get = (entity: WorkEntityGetRpcResponse['entity'] = booking) => vi.fn(async (): Promise<WorkEntityGetRpcResponse> => ({ entity }));

it('copies displayed booking facts and a deployment-scoped exact link without leaking contact IDs or pairing context', () => {
  const copy = bookingCopyText(booking, 'Riley');
  expect(copy).toBe('Consultation <team>\nSaved status: no show\nCustomer: Riley\nStarts: Not set\nEnds: Not set\nValue: 120 USD');
  expect(copy).not.toContain('opaque-contact'); expect(bookingCopyText({ ...booking, sync_state: 'stale_unreachable' })).toContain('may be out of date');
  const url = workRecordLink(href, 'booking', booking.id)!;
  expect(url).toBe('https://app.test/tools/client/' + hash); expect(parseRecordLinkQuery(url, href)).toEqual({ kind: 'link', target });
  expect(parseRecordLinkQuery(url.replace('app.test', 'other.test'), href).kind).toBe('invalid');
  expect(parseRecordLinkQuery(url.replace('/tools/client/', '/other/'), href).kind).toBe('invalid');
});

it('previews only saved booking facts with honest unknown times and source warnings', async () => {
  const entity = { ...booking, reception_record_id: 'secret-reservation', reception_values: { password: 'secret-field' }, source_extension: { visitor: 'private@example.test' } };
  const preview = await readWorkLinkPreview(target, { work: get(entity) });
  expect(preview).toMatchObject({ state: 'ready', title: booking.title, details: ['Saved status: no show', 'Starts: Not set', 'Ends: Not set', 'Value: 120 USD'] });
  expect(JSON.stringify(preview)).not.toMatch(/opaque-contact|secret-reservation|secret-field|private@example/);
  expect(await readWorkLinkPreview(target, { work: get({ ...booking, sync_state: 'tombstoned' }) })).toMatchObject({ state: 'missing' });
  expect(await readWorkLinkPreview(target, { work: get({ ...booking, sync_state: 'stale_unreachable' }) })).toMatchObject({ warning: expect.stringContaining('may be out of date') });
  await expect(readWorkLinkPreview(target, { work: get({ ...booking, id: 'other' }) })).rejects.toThrow('could not be confirmed');
});

it('retains exact booking identity in Chat wire and recovery and refuses a reused ID or changed source row', async () => {
  const work = get(), checked = await readExactRecordLink(target, { work }, href); expect(checked.state).toBe('ready'); if (checked.state !== 'ready') throw new Error('missing reference');
  const selected = { reference: checked.match }, wire = selectedRecordsWire([selected]);
  const restored = readSelectedRecordsWire(wire)![0]!;
  expect(restored.reference.identity).toBe(JSON.stringify(['booking', booking.id, booking.source_id, booking.source_record_id, booking.created_at]));
  expect(JSON.parse(wire)[0].record).toEqual({ kind: 'booking', id: booking.id, source_id: booking.source_id, source_record_id: booking.source_record_id, created_at: booking.created_at });
  const recovery = copyComposerRecoveryDraft({ text: 'Prepare for this booking', protected: true, modelSourceId: null, selectedRecords: [selected] });
  expect(recovery.selectedRecords![0]!.reference.identity).toBe(restored.reference.identity);
  expect(wire).not.toMatch(/opaque-contact|pair=secret|no_show|120/);
  for (const changed of [{ ...booking, created_at: 101 }, { ...booking, source_record_id: 'replacement' }, null]) {
    expect(await verifySelectedRecord(restored, { work: get(changed) }, href)).toBe(false);
    expect(await verifyExactRecordLink(checked.match, { work: get(changed) }, href)).toBe(false);
  }
});

it('searches the booking index through Add records and preserves partial-page errors', async () => {
  const work = vi.fn(async () => ({ groups: [{ kind: 'booking' as const, offset: 0, more: true, matches: [{ id: booking.id, title: booking.title, excerpt: '', source_id: booking.source_id,
    source_label: 'Recued', updated_at: 100, stale: false, pending_write: false }] }] }));
  const page = await searchRecordLinks('booking', ' consultation ', { work });
  expect(work).toHaveBeenCalledExactlyOnceWith({ query: 'consultation', offset: 0, limit: 20, kind: 'booking' });
  expect(page).toMatchObject({ more: true, options: [{ title: booking.title, target }] });
  work.mockResolvedValueOnce({ groups: [] }); await expect(searchRecordLinks('booking', 'consultation', { work })).rejects.toThrow('Invalid page');
});

it('opens Chat with an exact booking reference and requires an explicit sender action', async () => {
  const work = get(), open = vi.fn(), beforeLeave = vi.fn(() => true);
  const chat = createWorkRecordChat({ get: work, open, beforeLeave, changed() {}, href: () => href });
  await chat.ask(booking, () => true); expect(work).toHaveBeenCalledExactlyOnceWith({ kind: 'booking', id: booking.id }); expect(open).toHaveBeenCalledOnce();
  expect(open.mock.calls[0]![0].reference.target).toEqual(target);
  work.mockResolvedValueOnce({ entity: { ...booking, created_at: 101 } }); await chat.ask(booking, () => true);
  expect(open).toHaveBeenCalledOnce(); expect(chat.view(booking).error).toContain('removed or replaced');
  beforeLeave.mockReturnValueOnce(false); await chat.ask(booking, () => true); expect(work).toHaveBeenCalledTimes(2);
});

it('retires a delayed booking Chat check and rechecks the draft guard after its read', async () => {
  let resolve!: (reply: WorkEntityGetRpcResponse) => void; const work = vi.fn(() => new Promise<WorkEntityGetRpcResponse>(done => { resolve = done; }));
  const open = vi.fn(), beforeLeave = vi.fn(() => true), chat = createWorkRecordChat({ get: work, open, beforeLeave, changed() {}, href: () => href });
  const retired = chat.ask(booking, () => true); chat.reset(); resolve({ entity: booking }); await retired; expect(open).not.toHaveBeenCalled();
  const blocked = chat.ask(booking, () => true); beforeLeave.mockReturnValue(false); resolve({ entity: booking }); await blocked; expect(open).not.toHaveBeenCalled();
});
