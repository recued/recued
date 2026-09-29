/** D-315 slice 2 — what the standards pass reads from HTML (schema.org in JSON-LD
 *  and microdata, links) and carrier tracking numbers, only with context (§7.1). */

import { describe, expect, it } from 'vitest';

import { htmlLinks, htmlTags, jsonLdNodes, microdataNodes } from '../mail-facts/html-scan.js';
import { schemaOrgReads } from '../mail-facts/standards-pass.js';
import {
  canonicalCarrierName,
  dhlCheckDigitHolds,
  fedexCheckDigitHolds,
  findTrackingNumbers,
  type TrackingNumberSource,
} from '../mail-facts/tracking-numbers.js';

describe('JSON-LD', () => {
  it('reads every node, `@graph` and arrays flattened', () => {
    const html = `
      <html><head>
      <script type="application/ld+json">{"@context":"http://schema.org","@type":"Order","orderNumber":"A1"}</script>
      <script type='application/ld+json'>
        {"@context":"https://schema.org","@graph":[{"@type":"Invoice","confirmationNumber":"I1"},{"@type":"Person","name":"x"}]}
      </script>
      <script type="application/ld+json">[{"@type":"ParcelDelivery","trackingNumber":"T1"}]</script>
      </head></html>`;
    expect(jsonLdNodes(html).map((node) => node['@type'])).toEqual(['Order', 'Invoice', 'Person', 'ParcelDelivery']);
  });

  it('reads a block after letters that grow when lowered: İstanbul Shop is read as Istanbul Shop is', () => {
    for (const merchant of ['Istanbul Shop', 'İstanbul Shop', 'İİİ Market']) {
      const html = `<p>${merchant}</p><script type="application/ld+json">${JSON.stringify({ '@type': 'Order', merchant: { name: merchant }, orderNumber: 'A1' })}</script><p>after</p>`;
      expect(jsonLdNodes(html)).toEqual([{ '@type': 'Order', merchant: { name: merchant }, orderNumber: 'A1' }]);
      // A script ends where its own end tag begins, in the text as written.
      const script = htmlTags(html).tags.find((tag) => tag.name === 'script')!;
      expect(script.rawEnd).toBe(html.indexOf('</script>'));
    }
  });

  it('reads a block a mailer HTML-escaped, and skips one that is not JSON', () => {
    const html = `<script type="application/ld+json">{&quot;@type&quot;:&quot;Order&quot;,&quot;orderNumber&quot;:&quot;B2&quot;}</script>
      <script type="application/ld+json">{ not json</script>`;
    expect(jsonLdNodes(html)).toEqual([{ '@type': 'Order', orderNumber: 'B2' }]);
  });
});

describe('microdata', () => {
  it('reads nested items, attribute values by element, and text values', () => {
    const html = `
      <div itemscope itemtype="http://schema.org/FlightReservation">
        <meta itemprop="reservationNumber" content="RXJ34P"/>
        <link itemprop="reservationStatus" href="http://schema.org/ReservationConfirmed">
        <div itemprop="reservationFor" itemscope itemtype="http://schema.org/Flight">
          <div itemprop="airline" itemscope itemtype="http://schema.org/Airline">
            <span itemprop="name">United <b>Airlines</b></span>
          </div>
          <time itemprop="departureTime" datetime="2027-03-04T20:15:00-08:00">March 4, 8:15 PM</time>
          <script>var x = "<div itemscope>";</script>
        </div>
      </div>`;
    expect(microdataNodes(html)).toEqual([
      {
        '@type': 'FlightReservation',
        reservationNumber: 'RXJ34P',
        reservationStatus: 'http://schema.org/ReservationConfirmed',
        reservationFor: {
          '@type': 'Flight',
          airline: { '@type': 'Airline', name: 'United Airlines' },
          departureTime: '2027-03-04T20:15:00-08:00',
        },
      },
    ]);
  });

  it('closes elements a sender left open, and repeats a property as a list', () => {
    const html = `<div itemscope itemtype="https://schema.org/Order">
      <p><span itemprop="orderNumber">O-9</span>
      <li itemprop="acceptedOffer">first
      <li itemprop="acceptedOffer">second
      </div>`;
    expect(microdataNodes(html)).toEqual([
      { '@type': 'Order', orderNumber: 'O-9', acceptedOffer: ['first', 'second'] },
    ]);
  });
});

describe('links', () => {
  it('reads each anchor’s target and text, entities decoded', () => {
    expect(htmlLinks('<p><a class="b" href="https://x.example/t?a=1&amp;b=2"><span>Track</span> it</a></p>')).toEqual([
      { href: 'https://x.example/t?a=1&b=2', text: 'Track it' },
    ]);
  });

  it('closes an anchor another one opens inside, as a browser does, and drops one never closed', () => {
    expect(htmlLinks('<a href="/1">one <a href="/2">two</a> <a href="/3">three')).toEqual([
      { href: '/1', text: 'one' },
      { href: '/2', text: 'two' },
    ]);
  });
});

describe('the tags (one linear pass)', () => {
  const names = (html: string): string[] => htmlTags(html).tags.map((tag) => `${tag.closing ? '/' : ''}${tag.name}`);

  it('ends a tag at a `>` outside quotes, ignores a quote never closed, and reads a `<` that starts no tag as text', () => {
    expect(names('<a title="1 > 0" href=x>a < b</a>')).toEqual(['a', '/a']);
    expect(htmlTags('<a title="1 > 0" href=x>').tags[0]!.attributes).toBe(' title="1 > 0" href=x');
    expect(names('<a title="never closed>text<b>bold</b>')).toEqual(['a', 'b', '/b']);
    expect(names('1 < 2 and <p>para</p>')).toEqual(['p', '/p']);
  });

  it('skips a comment and a script’s content, and runs one never closed to the end', () => {
    expect(names('<!-- <a href=x> --><p>x</p><script>if (a<b) {}</script><i>y</i>')).toEqual(['!--', 'p', '/p', 'script', '/script', 'i', '/i']);
    expect(names('<p>x</p><!-- <a href=y>')).toEqual(['p', '/p', '!--']);
    expect(names('<script>var s = "<p>";')).toEqual(['script']);
  });

  it('stays linear on HTML broken every way there is', () => {
    const shapes = [
      '<a href="https://x.example/1">text '.repeat(15_000),
      '<a title="x>y '.repeat(36_000),
      '<div itemscope itemtype="http://schema.org/Order"><span itemprop="name">x'.repeat(7_000) + '</p>'.repeat(10_000),
      '< a b c d '.repeat(50_000),
      '<!-- '.repeat(100_000),
    ];
    for (const html of shapes) {
      const started = performance.now();
      jsonLdNodes(html);
      microdataNodes(html);
      htmlLinks(html);
      findTrackingNumbers({ subject: '', body_text: html.replace(/<[^<>]*>/g, ' '), html, from_address: 'x@shop.example' });
      // Measured ~10 ms each; the quadratic scans took seconds.
      expect(performance.now() - started).toBeLessThan(1_500);
    }
  });
});

describe('check digits (published sample numbers)', () => {
  it('FedEx 12-digit: mod 11 over weights 3, 1, 7', () => {
    expect(fedexCheckDigitHolds('986578788855')).toBe(true);
    expect(fedexCheckDigitHolds('477179081230')).toBe(true);
    expect(fedexCheckDigitHolds('986578788856')).toBe(false);
  });

  it('DHL Express 10-digit: mod 7', () => {
    expect(dhlCheckDigitHolds('3318810025')).toBe(true);
    expect(dhlCheckDigitHolds('8487135506')).toBe(true);
    expect(dhlCheckDigitHolds('3318810024')).toBe(false);
  });
});

const email = (over: Partial<TrackingNumberSource> = {}): TrackingNumberSource => ({
  subject: 'Your order',
  body_text: '',
  html: null,
  from_address: 'orders@shop.example',
  ...over,
});

describe('tracking numbers, only with context', () => {
  it('reads a text with thousands of number-shaped words and no blank line in linear time', () => {
    const body = 'Ref 1234567890 more text here '.repeat(20_000);
    const started = performance.now();
    expect(findTrackingNumbers({ subject: 'Report', body_text: body, html: null, from_address: 'x@shop.example' })).toEqual([]);
    // Measured ~5 ms; one pass per match over the whole text took seconds.
    expect(performance.now() - started).toBeLessThan(1_500);
  });

  it('reads UPS and USPS on their own, spaced or not', () => {
    const found = findTrackingNumbers(email({
      body_text: 'Shipped! 1Z 999 AA1 01 2345 6784.\nAlso on its way: 9400 1000 0000 0000 0000 00',
    }));
    expect(found).toEqual([
      { carrier: 'UPS', tracking_number: '1Z999AA10123456784' },
      { carrier: 'USPS', tracking_number: '9400100000000000000000' },
    ]);
  });

  it('never reads part of a USPS number as a FedEx one', () => {
    const found = findTrackingNumbers(email({ body_text: 'FedEx or not: 9400 1000 0000 0000 0000 00' }));
    expect(found.map((f) => f.carrier)).toEqual(['USPS']);
  });

  it('does not read a bare FedEx- or DHL-shaped number — an order number in ten passes the check', () => {
    // No label of any kind: the only thing that could admit them is their shape.
    expect(findTrackingNumbers(email({ body_text: 'We noted 986578788855 and 3318810025 today.' }))).toEqual([]);
  });

  it('reads one beside the carrier’s name, from the carrier itself, or in its tracking link', () => {
    expect(findTrackingNumbers(email({ body_text: 'Your FedEx tracking number is 986578788855.' })))
      .toEqual([{ carrier: 'FedEx', tracking_number: '986578788855' }]);
    expect(findTrackingNumbers(email({ from_address: 'TrackingUpdates@fedex.com', body_text: 'Shipment 477179081230 is on its way.' })))
      .toEqual([{ carrier: 'FedEx', tracking_number: '477179081230' }]);
    const wrapped = 'https://click.esp.example/c?u=https%3A%2F%2Fwww.dhl.com%2Fen%2Fexpress%2Ftracking.html%3FAWB%3D3318810025';
    expect(findTrackingNumbers(email({ html: `<a href="${wrapped}">Track your parcel</a>` }))).toEqual([{
      carrier: 'DHL',
      tracking_number: '3318810025',
      tracking_url: 'https://www.dhl.com/en/express/tracking.html?AWB=3318810025',
    }]);
  });

  it('reads one beside a tracking label only in mail that names one carrier', () => {
    const body = 'Tracking number: 986578788855\n\nThanks for shopping.\n\nShipped with FedEx.';
    expect(findTrackingNumbers(email({ body_text: body }))).toEqual([{ carrier: 'FedEx', tracking_number: '986578788855' }]);
    expect(findTrackingNumbers(email({ body_text: `${body} Returns go by DHL.` }))).toEqual([]);
  });

  it('refuses a failed check digit, and a number an order or invoice label introduces', () => {
    expect(findTrackingNumbers(email({ body_text: 'FedEx tracking number: 986578788856' }))).toEqual([]);
    expect(findTrackingNumbers(email({ body_text: 'Your FedEx order 986578788855 has shipped.' }))).toEqual([]);
    expect(findTrackingNumbers(email({ body_text: 'FedEx: order tracking number 986578788855' })))
      .toEqual([{ carrier: 'FedEx', tracking_number: '986578788855' }]);
  });

  it('names a carrier the way every pass does, so one parcel has one identity', () => {
    expect(canonicalCarrierName('Federal Express Corporation')).toBe('FedEx');
    expect(canonicalCarrierName('united parcel service')).toBe('UPS');
    expect(canonicalCarrierName('DHL Express')).toBe('DHL');
    expect(canonicalCarrierName('Royal Mail')).toBe('Royal Mail');
    // Named anywhere, as a whole word — and only when one carrier is named.
    expect(canonicalCarrierName('The UPS Store #1234')).toBe('UPS');
    expect(canonicalCarrierName('Deutsche Post DHL')).toBe('DHL');
    expect(canonicalCarrierName('FedEx via UPS')).toBe('FedEx via UPS');
    expect(canonicalCarrierName('Groupsale Logistics')).toBe('Groupsale Logistics');
  });
});

describe('markup a sender can shape any way (§9)', () => {
  it('reads microdata around a tag named as an object’s own properties are', () => {
    const html = '<div itemscope itemtype="https://schema.org/Order"><constructor><tostring>x</tostring></constructor>'
      + '<span itemprop="orderNumber">A-1</span></div>';
    expect(microdataNodes(html)).toEqual([{ '@type': 'Order', orderNumber: 'A-1' }]);
  });

  it('keeps an itemprop named as an object’s own properties as a property of the item, never its prototype', () => {
    const html = '<div itemscope itemtype="https://schema.org/Order"><span itemprop="constructor">c</span>'
      + '<span itemprop="__proto__">p</span><span itemprop="toString">t</span><span itemprop="orderNumber">A-1</span></div>';
    const [item] = microdataNodes(html);
    expect(Object.getPrototypeOf(item)).toBe(Object.prototype);
    expect(Object.entries(item!)).toEqual([
      ['@type', 'Order'], ['constructor', 'c'], ['__proto__', 'p'], ['toString', 't'], ['orderNumber', 'A-1'],
    ]);
  });

  it('reads nothing nested past what a sender writes, and the rest of the markup still', () => {
    const deep = `<script type="application/ld+json">${'['.repeat(7_000)}{"@type":"Order","orderNumber":"DEEP"}${']'.repeat(7_000)}</script>`;
    const order = '<script type="application/ld+json">{"@type":"Order","orderNumber":"A-1"}</script>';
    expect(jsonLdNodes(deep + order).map((node) => node.orderNumber)).toEqual(['A-1']);
    // Forty levels down is past any a sender writes: not read.
    expect(jsonLdNodes(`<script type="application/ld+json">${'['.repeat(40)}{"@type":"Order","orderNumber":"A-9"}${']'.repeat(40)}</script>`))
      .toEqual([]);
    // Deep inside an item as well: its values are read, the depths are not.
    const inside = `<script type="application/ld+json">{"@type":"Order","orderNumber":"A-2","x":${'['.repeat(7_000)}1${']'.repeat(7_000)}}</script>`;
    expect(schemaOrgReads(jsonLdNodes(inside)).map((read) => read.values.order_id)).toEqual(['A-2']);
  });

  it('reads a value no deeper than it reads markup: a name or a price ten thousand levels down costs the rest nothing', () => {
    const deepName = `{"@type":"Order","orderNumber":"A-3","merchant":${'{"name":'.repeat(10_000)}"Shop"${'}'.repeat(10_000)}}`;
    const deepPrice = `{"@type":"Order","orderNumber":"A-5","price":${'{"value":'.repeat(10_000)}"10"${'}'.repeat(10_000)},"priceCurrency":"EUR"}`;
    const microdata = '<div itemscope itemtype="https://schema.org/Order"><span itemprop="orderNumber">A-4</span><span itemprop="merchant">Shop</span></div>';
    const html = `<script type="application/ld+json">${deepName}</script><script type="application/ld+json">${deepPrice}</script>${microdata}`;
    const reads = schemaOrgReads([...jsonLdNodes(html), ...microdataNodes(html)]);
    expect(reads.map((read) => read.values.order_id)).toEqual(['A-3', 'A-5', 'A-4']);
    // Deeper than any sender writes one: not read.
    expect(reads[0]!.values.merchant).toBeUndefined();
    expect(reads[1]!.values.total).toBeUndefined();
    expect(reads[2]!.values.merchant).toBe('Shop');
  });

  it('reads each item on its own: one that cannot be read costs the others nothing', () => {
    const unreadable = { '@type': 'Order', get orderNumber(): string { throw new Error('unreadable'); } };
    const reads = schemaOrgReads([unreadable, { '@type': 'Order', orderNumber: 'A-6' }]);
    expect(reads.map((read) => read.values.order_id)).toEqual(['A-6']);
  });

  it('knows no type or status named as an object’s own properties are', () => {
    const odd = '<script type="application/ld+json">[{"@type":"constructor","reservationFor":{"name":"X"}},'
      + '{"@type":"Order","orderNumber":"A-1","orderStatus":"toString"}]</script>';
    const reads = schemaOrgReads(jsonLdNodes(odd));
    expect(reads.map((read) => read.type)).toEqual(['purchase']);
    expect(reads[0]!.values.state).toBeUndefined();
  });
});
