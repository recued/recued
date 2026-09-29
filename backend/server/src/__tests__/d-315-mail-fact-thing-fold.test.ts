/** D-315 slice 1 — a thing is a fold of its facts, and its events are a diff
 *  (§3.1, §5, §5.1). */

import { describe, expect, it } from 'vitest';

import { getMailFactBuiltinType, type MailFactValue } from '@recued/contracts';

import { diffThing, foldThing, identityKeysOf, type ThingFoldFact } from '../mail-facts/thing-fold.js';

const shipment = getMailFactBuiltinType('shipment')!;
const bill = getMailFactBuiltinType('bill')!;
const returnRefund = getMailFactBuiltinType('return_refund')!;

let seq = 0;
const fact = (
  email_at: number,
  variables: Record<string, MailFactValue | null>,
  id = `f${(seq += 1)}`,
): ThingFoldFact => ({
  fact_id: id,
  email_at,
  created_at: 1_000 + seq,
  variables,
  passes: Object.fromEntries(Object.keys(variables).map((name) => [name, 'rule' as const])),
});

const UPS = { carrier: 'UPS', tracking_number: '1Z999AA10123456784' };

describe('identity keys (§3.1)', () => {
  it('forms one key per alternative whose variables were all read', () => {
    expect(identityKeysOf(shipment, { ...UPS })).toEqual(['carrier+tracking_number=ups|1z999aa10123456784']);
    expect(identityKeysOf(shipment, { carrier: 'UPS', tracking_number: null })).toEqual([]);
    // merchant + (return_id or order_id): an email with both forms two keys.
    expect(
      identityKeysOf(returnRefund, { merchant: 'Shop', return_id: 'R1', order_id: 'O1' }),
    ).toEqual(['merchant+return_id=shop|r1', 'merchant+order_id=shop|o1']);
  });

  it('reads a name without its company or web ending, and an id without its punctuation', () => {
    const purchase = getMailFactBuiltinType('purchase')!;
    expect(identityKeysOf(purchase, { merchant: 'Amazon.com, Inc.', order_id: '112-1234567-1234567' }))
      .toEqual(identityKeysOf(purchase, { merchant: 'Amazon', order_id: '1121234567 1234567' }));
    expect(identityKeysOf(purchase, { merchant: 'Shop', order_id: 'A-1' })).not.toEqual(identityKeysOf(purchase, { merchant: 'Shop', order_id: 'A-2' }));
    // Nothing left to compare is no identity.
    expect(identityKeysOf(purchase, { merchant: '—', order_id: 'A-1' })).toEqual([]);
  });

  it('reads only a name without its company or web ending: an address is the address, and another text is its own', () => {
    const lead = getMailFactBuiltinType('lead')!;
    const leadOf = (email: string) => identityKeysOf(lead, { source: 'Contact form', reference: 'quote', email });
    // Two domains, two people.
    expect(leadOf('alex@acme.com')).not.toEqual(leadOf('alex@acme.net'));
    // An address's dots and dashes tell it apart; its case does not.
    expect(leadOf('alex.smith@acme.com')).not.toEqual(leadOf('alexsmith@acme.com'));
    expect(leadOf('Alex@Acme.COM')).toEqual(leadOf('alex@acme.com'));
    // The source is a name: its company ending is not what tells it apart.
    expect(identityKeysOf(lead, { source: 'Acme Inc.', reference: 'quote', email: 'alex@acme.com' }))
      .toEqual(identityKeysOf(lead, { source: 'Acme', reference: 'quote', email: 'alex@acme.com' }));
  });

  it('compares case- and space-insensitively', () => {
    expect(identityKeysOf(shipment, { carrier: 'ups', tracking_number: '1z 999 aa1 0123456784' })).toEqual(
      identityKeysOf(shipment, UPS),
    );
  });
});

describe('the fold (§3.1)', () => {
  it('takes each variable from the newest fact that read it, filling from older ones', () => {
    const thing = foldThing(shipment, [
      fact(100, { ...UPS, order_id: 'O-1', state: 'in_transit' }),
      fact(200, { ...UPS, state: 'delivered', delivered_at: '2026-09-26T15:00:00Z' }),
    ]);
    expect(thing.variables.state).toBe('delivered');
    expect(thing.variables.order_id).toBe('O-1'); // a later email lacking it does not erase it
    expect(thing.variables.delivered_at).toBe('2026-09-26T15:00:00Z');
    expect(thing.variables.merchant).toBeNull();
    expect(thing.complete).toBe(true);
  });

  it('orders by the email date, so older mail arriving late never moves the state back', () => {
    const delivered = fact(200, { ...UPS, state: 'delivered' });
    const olderArrivingLate = fact(100, { ...UPS, state: 'in_transit' });
    expect(foldThing(shipment, [delivered, olderArrivingLate]).variables.state).toBe('delivered');
  });

  it('keeps notice apart from state: a reminder after paid leaves the bill paid', () => {
    const base = { issuer: 'Power Co', invoice_number: 'INV-9' };
    const thing = foldThing(bill, [
      fact(100, { ...base, state: 'issued' }),
      fact(200, { ...base, state: 'paid' }),
      fact(300, { ...base, notice: 'reminder' }),
    ]);
    expect(thing.variables.state).toBe('paid');
    expect(thing.variables.notice).toBe('reminder');
  });

  it('takes the notice from the newest email alone: a payment after a reminder leaves none', () => {
    const base = { issuer: 'Power Co', invoice_number: 'INV-9' };
    const reminder = fact(100, { ...base, state: 'issued', notice: 'reminder' });
    const payment = fact(200, { ...base, state: 'paid' });
    const thing = foldThing(bill, [reminder, payment]);
    expect(thing.variables).toMatchObject({ state: 'paid', notice: null });
    // The notice going is not a notice arriving.
    expect(diffThing(bill, foldThing(bill, [reminder]), thing, payment.fact_id)).toEqual({
      kind: 'updated',
      changed_fields: ['state', 'last_email_at'],
    });
  });
});

describe('the newest email, by the fold’s own order (§3.1)', () => {
  const base = { issuer: 'Power Co', invoice_number: 'INV-9' };
  const at = (record_id: string, created_at: number, variables: Record<string, MailFactValue | null>, fact_id = `f-${record_id}`): ThingFoldFact => ({
    fact_id, email: { slug: 'work', record_id }, email_at: 100, created_at, variables,
    passes: Object.fromEntries(Object.keys(variables).map((name) => [name, 'rule' as const])),
  });

  it('takes the notice from the email read last when two share a date: a payment after a reminder leaves none', () => {
    const reminder = at('mail:1', 1_000, { ...base, state: 'issued', notice: 'reminder' });
    const payment = at('mail:2', 2_000, { ...base, state: 'paid' });
    expect(foldThing(bill, [reminder, payment]).variables).toMatchObject({ state: 'paid', notice: null });
    // Either way round.
    expect(foldThing(bill, [payment, reminder]).variables).toMatchObject({ state: 'paid', notice: null });
  });

  it('takes a notice from any block of the newest email', () => {
    const payment = at('mail:2', 2_000, { ...base, state: 'paid' }, 'f-b');
    const block = at('mail:2', 2_000, { ...base, notice: 'reminder' }, 'f-a');
    expect(foldThing(bill, [at('mail:1', 1_000, { ...base, state: 'issued' }), payment, block]).variables)
      .toMatchObject({ state: 'paid', notice: 'reminder' });
  });
});

describe('events are a diff (§5, §5.1)', () => {
  it('creation lists every variable read, and when its email arrived', () => {
    const first = fact(100, { ...UPS, state: 'delivered' });
    const change = diffThing(shipment, null, foldThing(shipment, [first]), first.fact_id);
    expect(change?.kind).toBe('created');
    expect([...change!.changed_fields].sort()).toEqual(['carrier', 'last_email_at', 'state', 'tracking_number']);
  });

  it('an update lists only what changed; a newer email always changes when its newest email arrived (ruling 44)', () => {
    const a = fact(100, { ...UPS, state: 'in_transit' });
    const b = fact(200, { ...UPS, state: 'delivered' });
    const repeat = fact(300, { ...UPS, state: 'delivered' });
    const older = fact(50, { ...UPS, state: 'in_transit' });
    const before = foldThing(shipment, [a]);
    const afterB = foldThing(shipment, [a, b]);
    expect(diffThing(shipment, before, afterB, b.fact_id)).toEqual({ kind: 'updated', changed_fields: ['state', 'last_email_at'] });
    // A repeat says nothing new but is newer: its time alone changed.
    const afterRepeat = foldThing(shipment, [a, b, repeat]);
    expect(afterRepeat.last_email_at).toBe(300);
    expect(diffThing(shipment, afterB, afterRepeat, repeat.fact_id)).toEqual({ kind: 'updated', changed_fields: ['last_email_at'] });
    // An older email changes nothing at all.
    expect(diffThing(shipment, afterRepeat, foldThing(shipment, [a, b, repeat, older]), older.fact_id)).toBeNull();
  });

  it('a newer email of the same date is news to a recipe on every email, though it says nothing new', () => {
    const email = (record_id: string) => ({ slug: 'work', record_id });
    const one: ThingFoldFact = { ...fact(100, { ...UPS, state: 'in_transit' }), email: email('mail:1') };
    const two: ThingFoldFact = { ...fact(100, { ...UPS, state: 'in_transit' }), email: email('mail:2') };
    expect(diffThing(shipment, foldThing(shipment, [one]), foldThing(shipment, [one, two]), two.fact_id))
      .toEqual({ kind: 'updated', changed_fields: ['last_email_at'] });
    // Another block of the same email is not another email.
    const block: ThingFoldFact = { ...fact(100, { ...UPS, state: 'in_transit' }), email: email('mail:2') };
    expect(diffThing(shipment, foldThing(shipment, [one, two]), foldThing(shipment, [one, two, block]), block.fact_id)).toBeNull();
  });

  it('a time written again at another offset is no change: 10:00+01:00, then 09:00Z', () => {
    const first = fact(100, { ...UPS, delivered_at: '2026-09-27T10:00:00+01:00' });
    const again = fact(200, { ...UPS, delivered_at: '2026-09-27T09:00:00Z' });
    const later = fact(300, { ...UPS, delivered_at: '2026-09-27T10:00:00Z' });
    const afterAgain = foldThing(shipment, [first, again]);
    expect(diffThing(shipment, foldThing(shipment, [first]), afterAgain, again.fact_id))
      .toEqual({ kind: 'updated', changed_fields: ['last_email_at'] });
    expect(diffThing(shipment, afterAgain, foldThing(shipment, [first, again, later]), later.fact_id))
      .toEqual({ kind: 'updated', changed_fields: ['delivered_at', 'last_email_at'] });
  });

  it('an amount written again another way is no change: 12.50, then 12.5', () => {
    const base = { issuer: 'Power Co', invoice_number: 'INV-9' };
    const first = fact(100, { ...base, amount_due: { amount: '12.50', currency: 'EUR' } });
    const again = fact(200, { ...base, amount_due: { amount: '12.5', currency: 'EUR' } });
    const raised = fact(300, { ...base, amount_due: { amount: '12.75', currency: 'EUR' } });
    const afterAgain = foldThing(bill, [first, again]);
    expect(diffThing(bill, foldThing(bill, [first]), afterAgain, again.fact_id)).toEqual({ kind: 'updated', changed_fields: ['last_email_at'] });
    expect(diffThing(bill, afterAgain, foldThing(bill, [first, again, raised]), raised.fact_id))
      .toEqual({ kind: 'updated', changed_fields: ['amount_due', 'last_email_at'] });
  });

  it('a notice counts every time, even when it repeats', () => {
    const base = { issuer: 'Power Co', invoice_number: 'INV-9' };
    const first = fact(100, { ...base, notice: 'reminder' });
    const second = fact(200, { ...base, notice: 'reminder' });
    const before = foldThing(bill, [first]);
    expect(diffThing(bill, before, foldThing(bill, [first, second]), second.fact_id)).toEqual({
      kind: 'updated',
      changed_fields: ['last_email_at', 'notice'],
    });
  });

  it('an older notice arriving late does not count', () => {
    const base = { issuer: 'Power Co', invoice_number: 'INV-9' };
    const newer = fact(200, { ...base, notice: 'reminder' });
    const older = fact(100, { ...base, notice: 'reminder' });
    expect(diffThing(bill, foldThing(bill, [newer]), foldThing(bill, [newer, older]), older.fact_id)).toBeNull();
  });

  it('a deletion recomputes silently', () => {
    const a = fact(100, { ...UPS, state: 'in_transit' });
    const b = fact(200, { ...UPS, state: 'delivered' });
    expect(diffThing(shipment, foldThing(shipment, [a, b]), foldThing(shipment, [a]), null)).toBeNull();
  });
});
