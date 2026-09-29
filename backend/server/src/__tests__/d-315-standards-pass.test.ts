/** D-315 slice 2 — the standards pass (§7.1) and owner requests (§7.4): facts any
 *  sender's email yields because the sender follows a published standard, and
 *  the requests the owner mails to their own server. */

import { describe, expect, it } from 'vitest';

import { recognizeOwnerRequest, OWNER_REQUEST_TEXT_MAX } from '../mail-facts/owner-request.js';
import { runStandardsPass, type MailFactEnvelope, type StandardsFact } from '../mail-facts/standards-pass.js';
import type { MailFactSourceEmail } from '../mail-facts/rules-pass.js';

const email = (over: Partial<MailFactSourceEmail> = {}): MailFactSourceEmail => ({
  subject: 'Your order',
  body_text: '',
  html: null,
  from_address: 'orders@shop.example',
  from_name: 'Shop',
  headers: {},
  labels: ['INBOX'],
  relationships: [],
  attachments: [],
  ...over,
});

const jsonLd = (value: unknown): string => `<script type="application/ld+json">${JSON.stringify(value)}</script>`;

const only = (facts: StandardsFact[], type: string): StandardsFact[] => facts.filter((fact) => fact.type === type);

describe('schema.org markup', () => {
  it('reads a ParcelDelivery, and the Order it is part of', () => {
    const html = jsonLd({
      '@context': 'http://schema.org',
      '@type': 'ParcelDelivery',
      expectedArrivalUntil: '2027-03-12T12:00:00-08:00',
      carrier: { '@type': 'Organization', name: 'Federal Express' },
      partOfOrder: {
        '@type': 'Order',
        orderNumber: '176057',
        merchant: { '@type': 'Organization', name: 'Bob Dole' },
        orderStatus: 'http://schema.org/OrderInTransit',
      },
      trackingNumber: '986578788855',
      trackingUrl: 'https://www.fedex.com/fedextrack/?trknbr=986578788855',
    });
    const facts = runStandardsPass(email({ html }), null);
    const [shipment] = only(facts, 'shipment');
    expect(shipment?.variables).toMatchObject({
      carrier: 'FedEx', // one parcel, one identity: the canonical name
      tracking_number: '986578788855',
      order_id: '176057',
      merchant: 'Bob Dole',
      expected_at: '2027-03-12',
      state: 'in_transit',
    });
    expect(shipment?.passes.tracking_number).toBe('standard');
    expect(shipment?.data).toEqual({ tracking_url: 'https://www.fedex.com/fedextrack/?trknbr=986578788855' });
    // The enclosing order is a purchase fact of its own, with no status claim:
    // in transit says nothing about paid or cancelled.
    expect(only(facts, 'purchase')[0]?.variables).toMatchObject({ merchant: 'Bob Dole', order_id: '176057', state: null });
  });

  it('reads an Order with its items and total', () => {
    const html = jsonLd({
      '@context': 'http://schema.org',
      '@type': 'Order',
      merchant: { '@type': 'Organization', name: 'Example Books' },
      orderNumber: '123-4567890-1234567',
      orderStatus: 'http://schema.org/OrderProcessing',
      priceCurrency: 'USD',
      price: '29.99',
      orderDate: '2027-01-08T10:12:00-08:00',
      acceptedOffer: {
        '@type': 'Offer',
        itemOffered: { '@type': 'Product', name: 'A novel' },
        price: '29.99',
        priceCurrency: 'USD',
        eligibleQuantity: { '@type': 'QuantitativeValue', value: '1' },
      },
    });
    const [purchase] = runStandardsPass(email({ html }), null);
    expect(purchase?.type).toBe('purchase');
    expect(purchase?.variables).toMatchObject({
      merchant: 'Example Books',
      order_id: '123-4567890-1234567',
      total: { currency: 'USD', amount: '29.99' },
      ordered_at: '2027-01-08',
      state: 'ordered',
    });
    expect(purchase?.complete).toBe(true);
    expect(purchase?.data).toEqual({ items: [{ name: 'A novel', quantity: '1', price: 'USD 29.99' }] });
  });

  it('keeps two invoices of one issuer and period apart: their numbers disagree', () => {
    const invoice = (number: string, price: string) => `<div itemscope itemtype="https://schema.org/Invoice">
      <span itemprop="provider" itemscope itemtype="https://schema.org/Organization"><span itemprop="name">Acme Power</span></span>
      <span itemprop="confirmationNumber">${number}</span>
      <span itemprop="billingPeriod">2027-03</span>
      <div itemprop="totalPaymentDue" itemscope itemtype="https://schema.org/PriceSpecification">
        <meta itemprop="price" content="${price}"><meta itemprop="priceCurrency" content="USD">
      </div>
      <time itemprop="paymentDueDate" datetime="2027-04-01">April 1</time>
    </div>`;
    const bills = runStandardsPass(email({ html: invoice('INV-1', '10.00') + invoice('INV-2', '20.00') }), null);
    expect(bills.map((bill) => [bill.variables.invoice_number, bill.position])).toEqual([['INV-1', 0], ['INV-2', 1]]);
    // The same invoice written twice is still one.
    expect(runStandardsPass(email({ html: invoice('INV-1', '10.00') + invoice('INV-1', '10.00') }), null)).toHaveLength(1);
  });

  it('reads an Invoice from microdata, keeping only the account’s last four', () => {
    const html = `<div itemscope itemtype="https://schema.org/Invoice">
      <span itemprop="provider" itemscope itemtype="https://schema.org/Organization"><span itemprop="name">Acme Power</span></span>
      <span itemprop="confirmationNumber">INV-2027-044</span>
      <div itemprop="totalPaymentDue" itemscope itemtype="https://schema.org/PriceSpecification">
        <meta itemprop="price" content="84.20"><meta itemprop="priceCurrency" content="USD">
      </div>
      <time itemprop="paymentDueDate" datetime="2027-04-01">April 1</time>
      <span itemprop="accountId">xxxx-xxxx-1234-5678</span>
      <link itemprop="paymentStatus" href="http://schema.org/PaymentDue">
    </div>`;
    const [bill] = runStandardsPass(email({ html }), null);
    expect(bill?.type).toBe('bill');
    expect(bill?.variables).toMatchObject({
      issuer: 'Acme Power',
      invoice_number: 'INV-2027-044',
      amount_due: { currency: 'USD', amount: '84.20' },
      due_at: '2027-04-01',
      account_ref: '5678',
      state: 'issued',
    });
  });

  it('reads the reservation types, each with its own start, end and place', () => {
    const flight = `<div itemscope itemtype="http://schema.org/FlightReservation">
      <meta itemprop="reservationNumber" content="RXJ34P"/>
      <link itemprop="reservationStatus" href="http://schema.org/ReservationConfirmed"/>
      <div itemprop="reservationFor" itemscope itemtype="http://schema.org/Flight">
        <div itemprop="airline" itemscope itemtype="http://schema.org/Airline"><meta itemprop="name" content="United"/></div>
        <div itemprop="departureAirport" itemscope itemtype="http://schema.org/Airport"><meta itemprop="name" content="San Francisco Airport"/></div>
        <meta itemprop="departureTime" content="2027-03-04T20:15:00-08:00"/>
        <meta itemprop="arrivalTime" content="2027-03-05T06:30:00-05:00"/>
      </div>
    </div>`;
    const lodging = jsonLd({
      '@context': 'http://schema.org',
      '@type': 'LodgingReservation',
      reservationNumber: 'abc456',
      reservationStatus: 'http://schema.org/ReservationConfirmed',
      reservationFor: {
        '@type': 'LodgingBusiness',
        name: 'Hilton San Francisco',
        address: { '@type': 'PostalAddress', streetAddress: '333 O’Farrell St', addressLocality: 'San Francisco' },
      },
      checkinDate: '2027-04-11',
      checkoutDate: '2027-04-13',
    });
    const facts = only(runStandardsPass(email({ html: `${flight}${lodging}` }), null), 'reservation');
    expect(facts).toHaveLength(2);
    const byKind = (kind: string) => facts.find((fact) => fact.variables.kind === kind);
    expect(byKind('transport')?.variables).toMatchObject({
      kind: 'transport',
      provider: 'United',
      confirmation_code: 'RXJ34P',
      starts_at: '2027-03-04T20:15:00-08:00',
      ends_at: '2027-03-05T06:30:00-05:00',
      location: 'San Francisco Airport',
      state: 'confirmed',
    });
    // A date with no time is refused for a datetime variable — recorded, not
    // invented — and the day is kept in data for a recipe that wants it.
    const lodgingFact = byKind('lodging');
    expect(lodgingFact?.variables).toMatchObject({
      provider: 'Hilton San Francisco',
      confirmation_code: 'abc456',
      starts_at: null,
      location: '333 O’Farrell St, San Francisco',
    });
    expect(lodgingFact?.refused.map((r) => r.variable)).toEqual(['starts_at', 'ends_at']);
    expect(lodgingFact?.missing).toEqual(['starts_at']);
    expect(lodgingFact?.data).toMatchObject({ start: '2027-04-11', end: '2027-04-13' });
  });

  it('makes no fact when the identity is unread — the rest belongs to a template', () => {
    const html = jsonLd({ '@type': 'ParcelDelivery', carrier: { name: 'UPS' }, expectedArrivalUntil: '2027-03-12' });
    expect(runStandardsPass(email({ html }), null)).toEqual([]);
  });
});

describe('one thing read twice is one fact', () => {
  it('joins the markup and the tracking link for the same parcel', () => {
    const html = `${jsonLd({ '@type': 'ParcelDelivery', carrier: 'FedEx', trackingNumber: '986578788855',
      partOfOrder: { '@type': 'Order', orderNumber: '9' } })}
      <a href="https://www.fedex.com/fedextrack/?trknbr=986578788855">Track</a>`;
    const shipments = only(runStandardsPass(email({ html }), null), 'shipment');
    expect(shipments).toHaveLength(1);
    expect(shipments[0]?.variables).toMatchObject({ carrier: 'FedEx', tracking_number: '986578788855', order_id: '9' });
    expect(shipments[0]?.data).toEqual({ tracking_url: 'https://www.fedex.com/fedextrack/?trknbr=986578788855' });
  });

  it.each([
    [['I-1', 'I-2', 'X']],
    [['I-2', 'I-1', 'X']],
    [['X', 'I-1', 'I-2']],
    [['X', 'I-2', 'I-1']],
    [['I-1', 'X', 'I-2']],
  ])('merges a reading that names only the issuer and period into neither of two invoices of them (%j)', (order) => {
    const nodes: Record<string, object> = {
      'I-1': { '@type': 'Invoice', provider: { name: 'Acme Power' }, confirmationNumber: 'I-1', billingPeriod: '2027-03' },
      'I-2': { '@type': 'Invoice', provider: { name: 'Acme Power' }, confirmationNumber: 'I-2', billingPeriod: '2027-03' },
      // Which of the two its amount is, it does not say.
      X: { '@type': 'Invoice', provider: { name: 'Acme Power' }, billingPeriod: '2027-03', totalPaymentDue: { value: '99', currency: 'EUR' } },
    };
    const bills = only(runStandardsPass(email({ html: order.map((key) => jsonLd(nodes[key]!)).join('') }), null), 'bill');
    expect(bills.map((bill) => [bill.variables.invoice_number, (bill.variables.amount_due as { amount: string } | null)?.amount ?? null])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
      .toEqual([['I-1', null], ['I-2', null], [null, '99']]);
  });

  it('keeps two parcels apart, each at its own position', () => {
    const facts = runStandardsPass(email({ body_text: 'Parcels: 1Z999AA10123456784 and 1Z999AA10123456795' }), null);
    expect(facts.map((fact) => [fact.variables.tracking_number, fact.position])).toEqual([
      ['1Z999AA10123456784', 0],
      ['1Z999AA10123456795', 1],
    ]);
  });
});

describe('switched off per type (ruling 10)', () => {
  it('reads nothing of a type the owner switched off', () => {
    const html = `${jsonLd({ '@type': 'Order', merchant: 'M', orderNumber: '1' })}`;
    const body = 'UPS: 1Z999AA10123456784';
    const facts = runStandardsPass(email({ html, body_text: body }), null, { isOn: (type) => type !== 'shipment' });
    expect(facts.map((fact) => fact.type)).toEqual(['purchase']);
  });
});

const envelope = (over: Partial<MailFactEnvelope> = {}): MailFactEnvelope => ({
  slug: 'work',
  account_email: 'me@gmail.com',
  to: ['m.e+Remind@googlemail.com'],
  cc: [],
  sent_by_account: true,
  rfc_message_id: 'CAB123@mail.gmail.com',
  thread_id: 'thr-1',
  ...over,
});

describe('owner requests (§7.4)', () => {
  const request = email({ subject: 'call the plumber', body_text: '  Friday at 9, please.  ', labels: ['SENT', 'INBOX'] });

  it('reads a +tag the account sent, with the RFC message id as its identity', () => {
    const [fact] = runStandardsPass(request, envelope());
    expect(fact?.type).toBe('owner_request');
    expect(fact?.variables).toEqual({ tag: 'remind', message_id: 'CAB123@mail.gmail.com', state: null });
    expect(fact?.data).toEqual({ subject: 'call the plumber', request: 'Friday at 9, please.' });
  });

  it('points at the thread when the tag was CC’d onto one', () => {
    const read = recognizeOwnerRequest(request, envelope({ to: ['plumber@pipes.example'], cc: ['"Me" <me+task@gmail.com>'] }));
    expect(read?.values.tag).toBe('task');
    expect(read?.data).toMatchObject({ thread: { slug: 'work', thread_id: 'thr-1' } });
  });

  it('⛔ reads nothing the provider does not record as sent by this account — From proves nothing', () => {
    expect(recognizeOwnerRequest(request, envelope({ sent_by_account: false }))).toBeNull();
  });

  it('reads nothing without the account’s own +tag, or without a message id', () => {
    expect(recognizeOwnerRequest(request, envelope({ to: ['me@gmail.com'] }))).toBeNull();
    expect(recognizeOwnerRequest(request, envelope({ to: ['someone+remind@gmail.com'] }))).toBeNull();
    expect(recognizeOwnerRequest(request, envelope({ to: ['me+remind@other.example'] }))).toBeNull();
    expect(recognizeOwnerRequest(request, envelope({ to: ['me+!!@gmail.com'] }))).toBeNull();
    expect(recognizeOwnerRequest(request, envelope({ account_email: '' }))).toBeNull();
    expect(recognizeOwnerRequest(request, envelope({ rfc_message_id: null }))).toBeNull();
  });

  it('cuts a long request and says so, so the fact’s data never goes over its cap', () => {
    const read = recognizeOwnerRequest(email({ body_text: 'x'.repeat(OWNER_REQUEST_TEXT_MAX + 10) }), envelope());
    expect((read?.data.request as string).length).toBe(OWNER_REQUEST_TEXT_MAX);
    expect(read?.data.request_truncated).toBe(true);
  });

  it('is switched off like any standards type', () => {
    expect(runStandardsPass(request, envelope(), { isOn: (type) => type !== 'owner_request' })).toEqual([]);
  });
});
