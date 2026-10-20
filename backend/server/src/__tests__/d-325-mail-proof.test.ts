import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssetRule, ExecutionSource, MailFact } from '@recued/contracts';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createAssetOccurrenceService, type AssetOccurrenceService } from '../situations/asset-occurrence-service.js';
import { createYoursService } from '../situations/yours-service.js';
import { createSituationStore } from '../storage/situation-store.js';
import { createMailFactStore } from '../storage/mail-fact-store.js';
import { createContactStore } from '../storage/contact-store.js';
import { datesIn, proofDate } from '../situations/mail-proof.js';

const owner: ExecutionSource = { channel: 'user', actor: 'user_self', user_id: 'owner', client_token_id: 'paired' };
const renew: AssetRule = { id: 'renew', title: 'Renew', enabled: true, muted: false, pinned: false, consequence: 'floor', expiry_policy: 'escalate_overdue',
  when: { kind: 'expiry', field: 'expires_on' }, reaction: { notify: true, occurrence: 'action', emit: false }, schedule: { before: [{ amount: 6, unit: 'months' }], on_day: true } };
const service: AssetRule = { ...renew, id: 'service', title: 'Annual service', consequence: 'routine',
  when: { kind: 'interval', field: 'serviced_on', every: { amount: 12, unit: 'months' } } };
const disposals: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose(); });
const fixture = (opts: { mailboxes?: () => Array<{ slug: string; address: string }> } = {}) => {
  const db = new Database(':memory:'); ensureWorkEntitySchema(db); const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  let time = Date.parse('2026-10-17T12:00Z'); let occurrences: AssetOccurrenceService;
  const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work), now: () => time,
    onAssetChanged: async asset => { await occurrences.reconcileAsset(asset.id); } });
  occurrences = createAssetOccurrenceService({ db, work, dispatchers, timeZone: () => 'UTC', now: () => time });
  const mail = createMailFactStore(db); const contacts = createContactStore(db);
  const yours = createYoursService({ db, work, dispatchers, occurrences, situations: createSituationStore(db), mailFacts: mail,
    now: () => time, timeZone: () => 'UTC', isVaultUnlocked: () => true, ...(opts.mailboxes ? { mailboxes: opts.mailboxes } : {}) });
  disposals.push(async () => { await yours.stop(); db.close(); });
  const command = (input: Parameters<typeof yours.command>[0]) => yours.command(input, owner);
  const person = (email: string, name: string) => { contacts.upsertManual({ email, name }, time); return contacts.get(email)!.contact_id!; };
  const asset = async (name: string, dates: Record<string, string | null>, rule: AssetRule, holder?: string) => (await command({ action: 'asset.create',
    input: { name, dates, rules: [rule], ...(holder ? { holder_contact: holder } : {}) } })).id!;
  let seq = 0;
  /** What the D-315 recognizer writes for mail the account sent to its own +tag address. */
  const forward = (subject: string, request: string, tag = 'done') => {
    const id = `forward-${++seq}`;
    const fact: MailFact = { fact_id: `fact-${id}`, type: 'owner_request', template_id: null, email: { slug: 'personal', record_id: `email-${id}` },
      email_at: time, position: 0, identity_keys: [`message_id:${id}`], thing_id: null, variables: { tag, message_id: `${id}@fixture.test` },
      passes: {}, data: { subject, request }, missing: [], refused: [], complete: true, source_hash: `hash-${id}`, revision: 1, created_at: time };
    mail.insertFact(fact); return fact;
  };
  const closes = async () => (await yours.snapshot()).proposals.filter(row => row.kind === 'close');
  return { work, command, person, asset, forward, closes, read: yours.snapshot, advance: (ms: number) => { time += ms; } };
};

describe('D-325 §5.3 proof forwarded to the +done address', () => {
  it('proposes the close with the new expiry, and accepting it renews the passport and closes its clock', async () => {
    const f = fixture(); const ana = f.person('ana@fixture.test', 'Ana Fixture');
    const id = await f.asset('Passport', { expires_on: '2027-01-10' }, renew, ana);
    const fact = f.forward('Fwd: Your new passport', 'Dear Ana Fixture,\nYour new passport has been issued.\nDate of issue: 15 October 2026\nValid until: 14 October 2036\n');
    const [proposal, ...rest] = await f.closes(); expect(rest).toEqual([]);
    expect(proposal).toMatchObject({ title: 'Renew · proof for Passport', confidence: 'high', subject: { collection: 'asset', id },
      payload: { asset_id: id, rule_id: 'renew', on: '2036-10-14', evidence_mail: `personal:${fact.email.record_id}`, proposal_class: 'mail-close' },
      sources: [{ collection: 'mail', id: `personal:${fact.email.record_id}` }, expect.anything()] });
    const pending = f.work.listCommitments().find(row => row.lifecycle_state === 'pending')!;
    expect((await f.command({ action: 'proposal.accept', ids: [proposal!.id] })).failed).toBeUndefined();
    expect(f.work.readCommitment(pending.id)!.lifecycle_state).toBe('fulfilled');
    expect(f.work.readAsset(id)!.dates.expires_on).toBe('2036-10-14');
    expect(f.work.readAsset(id)!.field_sources['dates.expires_on']).toMatchObject({ kind: 'owner', ref: `proposal:${proposal!.id}` });
    expect(await f.closes()).toEqual([]);
    // Closed, it is nothing proof could close.
    const closed = (await f.read({ asset_id: id, include_closed: true })).occurrences;
    expect(closed.map(item => [item.commitment?.lifecycle_state, item.closes_by_proof])).toEqual([['fulfilled', undefined]]);
  });
  it('ignores other tags and forwards that name no open item', async () => {
    const f = fixture(); await f.asset('Passport', { expires_on: '2027-01-10' }, renew);
    f.forward('Fwd: Your new passport', 'Valid until 14 October 2036', 'task');
    f.forward('Fwd: lunch', 'See you on 14 October 2036');
    expect(await f.closes()).toEqual([]);
  });
  it('picks the holder the forward names, and offers each passport when it names none', async () => {
    const f = fixture();
    const ana = await f.asset('Passport', { expires_on: '2027-01-10' }, renew, f.person('ana@fixture.test', 'Ana Fixture'));
    const ben = await f.asset('Passport', { expires_on: '2027-02-10' }, renew, f.person('ben@fixture.test', 'Ben Fixture'));
    f.forward('Fwd: passport renewed', 'Dear Ben,\nValid until 14 October 2036');
    expect((await f.closes()).map(row => row.payload.asset_id)).toEqual([ben]);
    f.forward('Fwd: passport renewed', 'Valid until 20 October 2036');
    const offered = (await f.closes()).filter(row => row.payload.on === '2036-10-20');
    expect(offered.map(row => row.payload.asset_id).sort()).toEqual([ana, ben].sort());
    expect(offered.every(row => row.confidence === 'low')).toBe(true);
  });
  it('leaves an unclear date for the owner to enter before anything closes', async () => {
    const f = fixture(); const id = await f.asset('Passport', { expires_on: '2027-01-10' }, renew);
    f.forward('Fwd: passport', 'Passport documents: 1 March 2031 and 1 March 2036');
    const [proposal] = await f.closes(); expect(proposal).toMatchObject({ confidence: 'medium', payload: { on: '' } });
    expect((await f.command({ action: 'proposal.accept', ids: [proposal!.id] })).failed?.[0]?.reason).toMatch(/actual evidence date/u);
    expect(f.work.readAsset(id)!.dates.expires_on).toBe('2027-01-10');
    await f.command({ action: 'proposal.edit', id: proposal!.id, payload: { ...proposal!.payload, on: '2036-03-01' } });
    expect((await f.command({ action: 'proposal.accept', ids: [proposal!.id] })).failed).toBeUndefined();
    expect(f.work.readAsset(id)!.dates.expires_on).toBe('2036-03-01');
  });
  it('records a forwarded service date as the last service', async () => {
    const f = fixture(); const id = await f.asset('Boiler', { serviced_on: '2025-10-17' }, service);
    f.forward('Fwd: boiler invoice', 'Boiler service completed on 16 October 2026. Next visit due 16 October 2027.');
    const [proposal] = await f.closes(); expect(proposal).toMatchObject({ payload: { rule_id: 'service', on: '2026-10-16' } });
    await f.command({ action: 'proposal.accept', ids: [proposal!.id] });
    expect(f.work.readAsset(id)!.dates.serviced_on).toBe('2026-10-16');
  });
  it('offers nothing when a forward fits more than three items equally', async () => {
    const f = fixture();
    for (const month of ['01', '02', '03', '04']) await f.asset('Passport', { expires_on: `2027-${month}-10` }, renew);
    f.forward('Fwd: passport renewed', 'Valid until 14 October 2036');
    expect(await f.closes()).toEqual([]);
  });
  it('never offers a forward sent before Forget, even for an item added after it', async () => {
    const f = fixture(); f.forward('Fwd: passport', 'Valid until 14 October 2036');
    f.advance(1000); await f.command({ action: 'intake.forget', confirmed: true });
    f.advance(1000); await f.asset('Passport', { expires_on: '2027-01-10' }, renew);
    expect(await f.closes()).toEqual([]);
  });
  it('shows where to forward it: each mailbox that can propose, at its +done address, beside what proof can close', async () => {
    const f = fixture({ mailboxes: () => [{ slug: 'personal', address: 'Ana@Fixture.test' },
      { slug: 'work', address: 'ana+work@fixture.test' }, { slug: 'family', address: 'family@fixture.test' }, { slug: 'odd', address: 'odd@' }] });
    const passport = await f.asset('Passport', { expires_on: '2027-01-10' }, renew);
    const boiler = await f.asset('Boiler', { serviced_on: null }, service);
    await f.command({ action: 'source.set', id: 'mail:family', enabled: false });
    // A tagged address takes no second tag, nor one with no domain; a mailbox whose proposals are stopped proposes nothing.
    expect((await f.read({ asset_id: passport })).proof_addresses).toEqual(['Ana+done@Fixture.test']);
    expect((await f.read({ asset_id: passport })).occurrences.map(item => item.closes_by_proof)).toEqual([true]);
    // An interval with no last date first asks for one: proof has nothing to close yet.
    expect((await f.read({ asset_id: boiler })).occurrences.map(item => [item.question, item.closes_by_proof])).toEqual([[true, undefined]]);
    expect((await fixture().read({})).proof_addresses).toBeUndefined();
  });
  it('forgets with the other extractions, and an old forward is not offered again', async () => {
    const f = fixture(); await f.asset('Passport', { expires_on: '2027-01-10' }, renew);
    f.forward('Fwd: passport', 'Valid until 14 October 2036');
    expect(await f.closes()).toHaveLength(1);
    f.advance(1000); await f.command({ action: 'intake.forget', confirmed: true });
    expect(await f.closes()).toEqual([]);
    f.advance(1000); f.forward('Fwd: passport again', 'Valid until 15 October 2036');
    expect((await f.closes()).map(row => row.payload.on)).toEqual(['2036-10-15']);
  });
});

describe('proof dates', () => {
  it('reads written dates only, and takes the one its cue names when several fit', () => {
    expect(datesIn('2036-10-14, 14th Oct 2036, October 14, 2036, 03/04/2036').map(row => row.date)).toEqual(['2036-10-14', '2036-10-14', '2036-10-14']);
    expect(proofDate('Issued 15 October 2026. Expires 14 October 2036.', renew, '2026-01-01', '2026-10-17')).toBe('2036-10-14');
    expect(proofDate('Renewal options: 1 March 2031 or 1 March 2036', renew, '2027-01-10', '2026-10-17')).toBeNull();
    expect(proofDate('Serviced on 16 October 2026; next 16 October 2027', service, '2025-10-17', '2026-10-17')).toBe('2026-10-16');
    // A service cannot have been done in the future, whatever the email says next.
    expect(proofDate('Invoice 16 October 2026. Next service due 16 October 2027.', service, '2025-10-17', '2026-10-17')).toBe('2026-10-16');
  });
});
