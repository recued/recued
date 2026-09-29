/**
 * D-315 slice 2 — the standards pass (§7.1): the facts any sender's email
 * yields because the sender follows a published standard. No template, no AI,
 * local; on by default and switchable per type (ruling 10).
 *
 *   - schema.org markup in the HTML — `ParcelDelivery` → shipment, `Order` →
 *     purchase, `Invoice` → bill, the `Reservation` types → reservation — read
 *     from JSON-LD and microdata alike;
 *   - carrier tracking numbers, only with context (`tracking-numbers.ts`).
 *
 * Every value goes through the same kind check a rule's does, and is marked
 * `standard`. A standards fact exists only when it read its type's identity:
 * everything else about an email belongs to a template (§4). Two reads of one
 * thing — the same parcel in markup and in a tracking link — are one fact.
 *
 * Owner requests (§7.4) are recognized here too: they need no template either.
 *
 * Spec: D-315 §4, §7.1, §7.4.
 */

import {
  canonicalMailFactText,
  getMailFactBuiltinType,
  MAIL_TEMPLATE_LIMITS,
  mailFactTypeVariables,
  type MailFactBuiltinTypeId,
  type MailFactPass,
  type MailFactRefusal,
  type MailFactTypeSpec,
  type MailFactValue,
} from '@recued/contracts';

import { jsonLdNodes, MARKUP_MAX_DEPTH, microdataNodes, schemaTypeName, type SchemaNode } from './html-scan.js';
import { byWhatItSays, thingGroups } from './matching.js';
import { identityValueKey, normalizeValue } from './normalize.js';
import { readAsSent, recognizeOwnerRequest, type MailFactEnvelope } from './owner-request.js';
import { finishFact, setPath, type MailFactSourceEmail, type RulesPassFact } from './rules-pass.js';
import { identityKeysOf } from './thing-fold.js';
import { canonicalCarrierName, findTrackingNumbers } from './tracking-numbers.js';

export type { MailFactEnvelope } from './owner-request.js';

/** Bump when what this pass reads changes. Mail already read keeps its facts
 *  (ruling 13): a backfill reads it again, and then a standards fact read by an
 *  older version is read anew rather than kept as it was. 2: carriers named as
 *  one (`United Parcel Service` is `UPS`), sent mail read for requests alone.
 *  3: a reading two invoices could both take is neither's; a value no deeper
 *  than markup is read. 4: readings as undecided as one another are one fact;
 *  a value one thing's readings give two ways is none; facts in the order of
 *  what they say. 5: no fact joins readings that are not one another, however
 *  they chain. */
export const MAIL_FACT_STANDARDS_VERSION = 5;

export interface StandardsFact extends RulesPassFact {
  readonly type: MailFactBuiltinTypeId;
}

/** One reading, before its values are checked against their kinds. */
export interface StandardsRead {
  readonly type: MailFactBuiltinTypeId;
  readonly values: Readonly<Record<string, string | number | undefined>>;
  readonly data: Readonly<Record<string, unknown>>;
}

// ────────────────────────────────────────────────────────────────
// schema.org, read defensively: any property may be a string, a number, an
// object with a name, or an array of those.
// ────────────────────────────────────────────────────────────────

/** A table's entry for a name the markup gave, by the table's own entries: a
 *  sender's `constructor` or `toString` names nothing (§9). */
const entryOf = <T>(table: Readonly<Record<string, T>>, name: string | undefined): T | undefined =>
  name !== undefined && Object.prototype.hasOwnProperty.call(table, name) ? table[name] : undefined;

const typesOf = (node: SchemaNode): string[] => {
  const raw = node['@type'];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.filter((type): type is string => typeof type === 'string').map(schemaTypeName);
};

const first = (value: unknown): unknown => (Array.isArray(value) ? value[0] : value);

const at = (node: unknown, path: string): unknown => {
  let cursor: unknown = node;
  for (const key of path.split('.')) {
    cursor = first(cursor);
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return first(cursor);
};

/** A property as text: a string or number, or an object's `name` / `@value`
 *  — no deeper than markup is read (§9): a name ten thousand objects down
 *  overflowed the stack, and every reading of the email went with it. Read
 *  canonical (§9), as every reader reads text: a status, a date or an account
 *  in fullwidth, or with a zero-width space in it, is the one written plainly. */
const textOf = (value: unknown, depth = 0): string | undefined => {
  if (depth > MARKUP_MAX_DEPTH) return undefined;
  const one = first(value);
  if (typeof one === 'string') {
    const text = canonicalMailFactText(one).trim();
    return text.length > 0 ? text : undefined;
  }
  if (typeof one === 'number' && Number.isFinite(one)) return String(one);
  if (one !== null && typeof one === 'object') {
    const object = one as Record<string, unknown>;
    return textOf(object.name, depth + 1) ?? textOf(object['@value'], depth + 1) ?? textOf(object['@id'], depth + 1);
  }
  return undefined;
};

const firstText = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    const text = textOf(value);
    if (text !== undefined) return text;
  }
  return undefined;
};

/** An enumeration member's bare name: `http://schema.org/OrderDelivered` → `OrderDelivered`. */
const enumName = (value: unknown): string | undefined => {
  const text = textOf(value);
  return text === undefined ? undefined : schemaTypeName(text);
};

/** `2027-03-12T12:00:00-08:00` → `2027-03-12`, for a `date` variable. */
const dateOnly = (value: unknown): string | undefined => {
  const text = textOf(value);
  const match = text === undefined ? null : /^(\d{4}-\d{2}-\d{2})/.exec(text);
  return match?.[1] ?? text;
};

/** A price as `USD 29.99`: a MonetaryAmount, a PriceSpecification, or a
 *  number beside its currency. */
const moneyOf = (value: unknown, currency?: unknown, depth = 0): string | undefined => {
  if (depth > MARKUP_MAX_DEPTH) return undefined;
  const one = first(value);
  if (one !== null && typeof one === 'object') {
    const object = one as Record<string, unknown>;
    return moneyOf(object.value ?? object.price, object.currency ?? object.priceCurrency, depth + 1);
  }
  const amount = textOf(one);
  const code = textOf(currency);
  if (amount === undefined) return undefined;
  return code === undefined ? amount : `${code} ${amount}`;
};

/** A PostalAddress as one line; a plain string as it is. */
const placeOf = (value: unknown): string | undefined => {
  const one = first(value);
  if (one !== null && typeof one === 'object') {
    const object = one as Record<string, unknown>;
    const address = first(object.address) ?? object;
    if (address !== null && typeof address === 'object') {
      const parts = ['streetAddress', 'addressLocality', 'addressRegion', 'postalCode', 'addressCountry']
        .map((key) => textOf((address as Record<string, unknown>)[key]))
        .filter((part): part is string => part !== undefined);
      if (parts.length > 0) return parts.join(', ');
    }
    return textOf(object.name) ?? textOf(address);
  }
  return textOf(one);
};

/** The last four characters an account reference may keep (§3.1, bill). */
const lastFour = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const kept = value.replace(/[^0-9A-Za-z]/g, '');
  return kept.length === 0 ? undefined : kept.slice(-4);
};

const SHIPMENT_STATE: Readonly<Record<string, string>> = {
  OrderInTransit: 'in_transit',
  OrderDelivered: 'delivered',
  OrderReturned: 'returned',
  OrderProblem: 'exception',
};
/** Only the statuses that mean the same thing: a shipping notice saying the
 *  order is in transit says nothing about whether it was paid. */
const PURCHASE_STATE: Readonly<Record<string, string>> = {
  OrderProcessing: 'ordered',
  OrderPaymentDue: 'ordered',
  OrderCancelled: 'cancelled',
};
const BILL_STATE: Readonly<Record<string, string>> = {
  PaymentDue: 'issued',
  PaymentPastDue: 'overdue',
  PaymentComplete: 'paid',
  PaymentAutomaticallyApplied: 'paid',
};
const RESERVATION_STATE: Readonly<Record<string, string>> = {
  ReservationConfirmed: 'confirmed',
  ReservationCancelled: 'cancelled',
};
const RESERVATION_KIND: Readonly<Record<string, string>> = {
  LodgingReservation: 'lodging',
  FlightReservation: 'transport',
  TrainReservation: 'transport',
  BusReservation: 'transport',
  BoatReservation: 'transport',
  TaxiReservation: 'transport',
  EventReservation: 'event',
  FoodEstablishmentReservation: 'dining',
  RentalCarReservation: 'car',
};

const parcelRead = (node: SchemaNode, order: SchemaNode | undefined): StandardsRead => {
  const partOfOrder = at(node, 'partOfOrder') ?? order;
  const carrier = firstText(at(node, 'carrier'), at(node, 'provider'));
  return {
    type: 'shipment',
    values: {
      carrier: carrier === undefined ? undefined : canonicalCarrierName(carrier),
      tracking_number: textOf(node.trackingNumber),
      order_id: textOf(at(partOfOrder, 'orderNumber')),
      merchant: firstText(at(partOfOrder, 'merchant'), at(partOfOrder, 'seller')),
      expected_at: dateOnly(node.expectedArrivalUntil ?? node.expectedArrivalFrom),
      state: entryOf(SHIPMENT_STATE,
        enumName(node.deliveryStatus) ?? enumName(node.orderStatus) ?? enumName(at(partOfOrder, 'orderStatus'))),
    },
    data: { ...(textOf(node.trackingUrl) !== undefined ? { tracking_url: textOf(node.trackingUrl) } : {}) },
  };
};

const orderRead = (node: SchemaNode): StandardsRead => {
  const offers = Array.isArray(node.acceptedOffer) ? node.acceptedOffer : node.acceptedOffer !== undefined ? [node.acceptedOffer] : [];
  const items = offers
    .map((offer) => ({
      name: firstText(at(offer, 'itemOffered.name'), at(offer, 'itemOffered')),
      quantity: textOf(at(offer, 'eligibleQuantity.value')),
      price: moneyOf(at(offer, 'price'), at(offer, 'priceCurrency')),
    }))
    .filter((item) => item.name !== undefined);
  return {
    type: 'purchase',
    values: {
      merchant: firstText(node.merchant, node.seller, node.broker),
      order_id: textOf(node.orderNumber),
      total: moneyOf(node.price, node.priceCurrency) ?? moneyOf(node.totalPaymentDue) ?? moneyOf(node.priceSpecification),
      ordered_at: dateOnly(node.orderDate),
      state: entryOf(PURCHASE_STATE, enumName(node.orderStatus)),
    },
    data: {
      ...(items.length > 0 ? { items } : {}),
      ...(textOf(node.url) !== undefined ? { url: textOf(node.url) } : {}),
    },
  };
};

const invoiceRead = (node: SchemaNode): StandardsRead => ({
  type: 'bill',
  values: {
    issuer: firstText(node.provider, node.broker),
    amount_due: moneyOf(node.totalPaymentDue) ?? moneyOf(node.minimumPaymentDue),
    due_at: dateOnly(node.paymentDueDate ?? node.paymentDue),
    invoice_number: firstText(node.confirmationNumber, node.identifier),
    period: textOf(node.billingPeriod),
    account_ref: lastFour(textOf(node.accountId)),
    state: entryOf(BILL_STATE, enumName(node.paymentStatus)),
  },
  data: { ...(textOf(node.url) !== undefined ? { url: textOf(node.url) } : {}) },
});

const reservationRead = (node: SchemaNode, type: string): StandardsRead => {
  const kind = entryOf(RESERVATION_KIND, type);
  const reservedFor = at(node, 'reservationFor');
  let provider: string | undefined;
  let start: unknown;
  let end: unknown;
  let location: string | undefined;
  switch (type) {
    case 'LodgingReservation':
      provider = firstText(reservedFor);
      start = node.checkinTime ?? node.checkinDate;
      end = node.checkoutTime ?? node.checkoutDate;
      location = placeOf(reservedFor);
      break;
    case 'FlightReservation':
      provider = firstText(at(reservedFor, 'airline'), at(reservedFor, 'provider'));
      start = at(reservedFor, 'departureTime');
      end = at(reservedFor, 'arrivalTime');
      location = firstText(at(reservedFor, 'departureAirport.name'), at(reservedFor, 'departureAirport.iataCode'));
      break;
    case 'TrainReservation':
    case 'BusReservation':
    case 'BoatReservation':
      provider = firstText(at(reservedFor, 'provider'), at(reservedFor, 'busCompany'), at(reservedFor, 'trainCompany'));
      start = at(reservedFor, 'departureTime');
      end = at(reservedFor, 'arrivalTime');
      location = firstText(
        at(reservedFor, 'departureStation'),
        at(reservedFor, 'departureBusStop'),
        at(reservedFor, 'departureBoatTerminal'),
      );
      break;
    case 'EventReservation':
      provider = firstText(at(reservedFor, 'organizer'), at(reservedFor, 'name'));
      start = at(reservedFor, 'startDate');
      end = at(reservedFor, 'endDate');
      location = placeOf(at(reservedFor, 'location'));
      break;
    case 'FoodEstablishmentReservation':
      provider = firstText(reservedFor);
      start = node.startTime;
      end = node.endTime;
      location = placeOf(reservedFor);
      break;
    case 'RentalCarReservation':
      provider = firstText(at(reservedFor, 'rentalCompany'), at(reservedFor, 'provider'));
      start = node.pickupTime;
      end = node.dropoffTime;
      location = placeOf(node.pickupLocation);
      break;
    default:
      provider = firstText(reservedFor);
  }
  const startText = textOf(start);
  const endText = textOf(end);
  return {
    type: 'reservation',
    values: {
      kind,
      provider: firstText(node.provider) ?? provider ?? firstText(node.broker),
      confirmation_code: firstText(node.reservationNumber, node.reservationId),
      starts_at: startText,
      ends_at: endText,
      location,
      party_size: textOf(node.partySize),
      total: moneyOf(node.totalPrice, node.priceCurrency),
      state: entryOf(RESERVATION_STATE, enumName(node.reservationStatus)),
    },
    // The times as the sender wrote them: a date with no time is refused for a
    // `datetime` variable, and a recipe may still want the day.
    data: {
      ...(firstText(reservedFor) !== undefined ? { for: firstText(reservedFor) } : {}),
      ...(startText !== undefined ? { start: startText } : {}),
      ...(endText !== undefined ? { end: endText } : {}),
      ...(textOf(node.url) !== undefined ? { url: textOf(node.url) } : {}),
    },
  };
};

/** What the email's markup says, as far as it can be read: markup a sender
 *  shaped any way costs the email nothing else — the other scan, the
 *  tracking numbers and the templates read it still (§9). */
const markupReads = (html: string): StandardsRead[] => {
  const nodes: SchemaNode[] = [];
  for (const scan of [jsonLdNodes, microdataNodes]) {
    try {
      nodes.push(...scan(html));
    } catch {
      /* this scan's markup is not read */
    }
  }
  try {
    return schemaOrgReads(nodes);
  } catch {
    return [];
  }
};

/** Every recognized item, nested ones included (an Order's `orderDelivery`,
 *  a `@graph` member), with the Order a ParcelDelivery sits in. */
export const schemaOrgReads = (nodes: readonly SchemaNode[]): StandardsRead[] => {
  const reads: StandardsRead[] = [];
  const seen = new Set<object>();
  const visit = (value: unknown, order: SchemaNode | undefined, depth = 0): void => {
    // As deep as a sender writes schema.org, and no deeper (§9).
    if (depth > MARKUP_MAX_DEPTH) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, order, depth + 1);
      return;
    }
    if (value === null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    const node = value as SchemaNode;
    // Each item read on its own: one a sender shaped past reading costs the
    // other items nothing.
    try {
      const types = typesOf(node);
      let enclosingOrder = order;
      if (types.includes('ParcelDelivery')) reads.push(parcelRead(node, order));
      if (types.includes('Order')) {
        reads.push(orderRead(node));
        enclosingOrder = node;
      }
      if (types.includes('Invoice')) reads.push(invoiceRead(node));
      const reservation = types.find((type) => entryOf(RESERVATION_KIND, type) !== undefined || type === 'Reservation');
      if (reservation !== undefined) reads.push(reservationRead(node, reservation));
      for (const [key, child] of Object.entries(node)) {
        if (key !== '@type' && key !== '@context') visit(child, enclosingOrder, depth + 1);
      }
    } catch {
      /* this item is not read, nor what it holds */
    }
  };
  for (const node of nodes) visit(node, undefined);
  return reads;
};

// ────────────────────────────────────────────────────────────────
// From reads to facts
// ────────────────────────────────────────────────────────────────

const specOf = (type: MailFactBuiltinTypeId): MailFactTypeSpec => getMailFactBuiltinType(type)!;

/** One reading as a fact: each value checked against its variable's kind (a
 *  refusal is recorded, not dropped), every value marked `standard`. */
const toFact = (read: StandardsRead, position: number): RulesPassFact => {
  const spec = specOf(read.type);
  const variables: Record<string, MailFactValue | null> = {};
  const passes: Record<string, MailFactPass> = {};
  const refused: MailFactRefusal[] = [];
  for (const variable of mailFactTypeVariables(spec)) {
    variables[variable.name] = null;
    const raw = read.values[variable.name];
    if (raw === undefined) continue;
    const result = normalizeValue(String(raw), variable.kind, {
      ...(variable.values !== undefined ? { values: variable.values } : {}),
      variable: variable.name,
      // schema.org writes numbers with a decimal point (`"price": "1.500"`).
      decimalMark: '.',
    });
    if (!result.ok) {
      refused.push({ variable: variable.name, reason: result.reason });
      continue;
    }
    variables[variable.name] = result.value;
    passes[variable.name] = 'standard';
  }
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(read.data)) {
    if (value === undefined) continue;
    data[key] = value;
    passes[`data.${key}`] = 'standard';
  }
  return finishFact(spec, { position, variables, passes, data, refused });
};

/** The data paths a reading names — a rule's `data.url.label` as
 *  `url.label` — with the pass that read each. */
const dataPasses = (fact: RulesPassFact): Map<string, MailFactPass> => {
  const paths = new Map<string, MailFactPass>();
  for (const [name, pass] of Object.entries(fact.passes)) {
    if (name.startsWith('data.')) paths.set(name.slice('data.'.length), pass);
  }
  return paths;
};

/** One path is the other, or lies above or below it. */
const onOnePath = (x: string, y: string): boolean => x === y || x.startsWith(`${y}.`) || y.startsWith(`${x}.`);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The value at a dot path of a fact's data, or at the nearest place above it
 *  that holds one that is not an object; `undefined` where there is none. */
const valueOnPath = (data: Readonly<Record<string, unknown>>, path: string): unknown => {
  let cursor: unknown = data;
  for (const key of path.split('.')) {
    if (!isRecord(cursor)) return cursor;
    if (!Object.prototype.hasOwnProperty.call(cursor, key)) return undefined;
    cursor = cursor[key];
  }
  return cursor;
};

const removeAt = (data: Record<string, unknown>, path: string): void => {
  const segments = path.split('.');
  let cursor: unknown = data;
  for (const key of segments.slice(0, -1)) {
    if (!isRecord(cursor)) return;
    cursor = cursor[key];
  }
  if (isRecord(cursor)) delete cursor[segments[segments.length - 1]!];
};

/** `b`'s data into `a`'s, path by path down to a nested one (§4): a value
 *  `b` read goes in where nothing `a` read lies on its path — the same path,
 *  one above it or one below — or where `b` outranks every such reading,
 *  which then goes with its pass. A rule's `data.url.label` keeps its place
 *  under the markup's `data.url`: that decided at `url` alone, the markup's
 *  link replaced the rule's object and left the rule's pass on nothing. */
const mergeData = (
  a: RulesPassFact,
  b: RulesPassFact,
  bOutranks: (bPass: MailFactPass | undefined, aPass: MailFactPass | undefined) => boolean,
): { readonly data: Record<string, unknown>; readonly passes: Record<string, MailFactPass> } => {
  const data = structuredClone({ ...(a.data ?? {}) }) as Record<string, unknown>;
  const passes: Record<string, MailFactPass> = { ...a.passes };
  const read = dataPasses(a);
  const bRead = dataPasses(b);
  for (const [path, pass] of bRead) {
    const value = valueOnPath(b.data ?? {}, path);
    if (value === undefined) continue;
    const onPath = [...read].filter(([other]) => onOnePath(other, path));
    // A value of `a`'s that no pass names — read before passes were kept.
    const unnamed = onPath.length === 0 && valueOnPath(data, path) !== undefined;
    if (unnamed ? !bOutranks(pass, undefined) : onPath.some(([, other]) => !bOutranks(pass, other))) continue;
    for (const [other] of onPath) {
      removeAt(data, other);
      delete passes[`data.${other}`];
      read.delete(other);
    }
    setPath(data, path, structuredClone(value));
    if (valueOnPath(data, path) === undefined) continue;
    passes[`data.${path}`] = pass;
    read.set(path, pass);
  }
  // Data `b` holds that no pass names: it fills what `a` left empty.
  for (const [key, value] of Object.entries(b.data ?? {})) {
    if (Object.prototype.hasOwnProperty.call(data, key) || [...bRead.keys()].some((path) => onOnePath(path, key))) continue;
    data[key] = structuredClone(value);
  }
  return { data, passes };
};

/** Two facts of one thing, as one: the first read value stands, the second
 *  fills what the first left empty. The writer merges a template's fact with
 *  a standards one this way, the template's first — the owner's rule wins (§4). */
export const combineFacts = (spec: MailFactTypeSpec, a: RulesPassFact, b: RulesPassFact): RulesPassFact => {
  const variables = { ...a.variables };
  const passes = { ...a.passes };
  for (const [name, value] of Object.entries(b.variables)) {
    if ((variables[name] ?? null) === null && value !== null) {
      variables[name] = value;
      if (b.passes[name] !== undefined) passes[name] = b.passes[name]!;
    }
  }
  // The first reading stands wherever it read, down to a nested path.
  const merged = mergeData({ ...a, passes }, b, () => false);
  return finishFact(spec, {
    position: a.position,
    variables,
    passes: merged.passes,
    data: merged.data,
    refused: [...a.refused, ...b.refused],
  });
};

/** Which reading of a value wins where two readings of one thing meet: the
 *  rules the owner wrote, then the markup, then the AI (§4). */
const PASS_RANK: Readonly<Record<string, number>> = { rule: 0, standard: 1, ai: 2 };
const rankOf = (fact: RulesPassFact, name: string): number => PASS_RANK[fact.passes[name] ?? ''] ?? 3;

/** Two readings of one thing as one, each value from the pass that ranks
 *  first — for a fact the AI has filled in already, whose answers must not
 *  outrank what the markup read. Where they rank alike, `a` keeps its own. */
export const combineFactsByPass = (spec: MailFactTypeSpec, a: RulesPassFact, b: RulesPassFact): RulesPassFact => {
  const variables = { ...a.variables };
  const passes = { ...a.passes };
  for (const [name, value] of Object.entries(b.variables)) {
    if (value === null) continue;
    if ((variables[name] ?? null) === null || rankOf(b, name) < rankOf(a, name)) {
      variables[name] = value;
      if (b.passes[name] !== undefined) passes[name] = b.passes[name]!;
    }
  }
  const merged = mergeData({ ...a, passes }, b, (bPass, aPass) =>
    (PASS_RANK[bPass ?? ''] ?? 3) < (PASS_RANK[aPass ?? ''] ?? 3));
  return finishFact(spec, {
    position: a.position,
    variables,
    passes: merged.passes,
    data: merged.data,
    refused: [...a.refused, ...b.refused],
  });
};

export interface StandardsPassOptions {
  /** Whether the standards pass reads this type; the owner may switch a type off. */
  readonly isOn?: (type: MailFactBuiltinTypeId) => boolean;
}

/** Run the pass over one email. `envelope` carries what owner requests need;
 *  without it none is recognized. Mail the account SENT is read for owner
 *  requests alone: a tracking number the owner mails a buyer is not a parcel
 *  coming to them, and a reply quoting an old "shipped" is not news of it. */
export const runStandardsPass = (
  email: MailFactSourceEmail,
  envelope: MailFactEnvelope | null,
  options: StandardsPassOptions = {},
): StandardsFact[] => {
  const isOn = options.isOn ?? (() => true);
  const reads: StandardsRead[] = [];
  const sent = envelope !== null && readAsSent(envelope);
  if (email.html !== null && !sent) reads.push(...markupReads(email.html));
  if (isOn('shipment') && !sent) {
    for (const found of findTrackingNumbers(email)) {
      reads.push({
        type: 'shipment',
        values: { carrier: found.carrier, tracking_number: found.tracking_number },
        data: found.tracking_url !== undefined ? { tracking_url: found.tracking_url } : {},
      });
    }
  }
  if (envelope !== null) {
    const request = recognizeOwnerRequest(email, envelope);
    if (request !== null) reads.push(request);
  }

  const readings: { type: MailFactBuiltinTypeId; keys: string[]; fact: RulesPassFact }[] = [];
  // As many as a template's repeated blocks (§4.2): an email is not a catalog.
  // Counted among the types that are on: a hundred orders of a type switched
  // off took the room of the parcel's tracking number.
  for (const read of reads.filter((candidate) => isOn(candidate.type)).slice(0, MAIL_TEMPLATE_LIMITS.maxBlocks)) {
    const fact = toFact(read, 0);
    const keys = identityKeysOf(specOf(read.type), fact.variables);
    // A standards fact exists only once its identity is read.
    if (keys.length > 0) readings.push({ type: read.type, keys, fact });
  }
  const facts: StandardsFact[] = [];
  // Kind by kind, in the order of their names: not in the order the markup
  // gave the first of each.
  for (const type of [...new Set(readings.map((reading) => reading.type))].sort()) {
    const spec = specOf(type);
    // One thing read twice in the email is one fact; two that share a key but
    // disagree on another — two invoices of one issuer and period — are two.
    // A reading either of two such could be — the issuer and period alone —
    // is neither's (joined to the first it met, its amount went to whichever
    // invoice the markup gave first): a fact of its own, with any reading as
    // undecided as it that it could be. By the rule every matcher shares
    // (`thingGroups`), whatever the order the email gives them in; and so,
    // their facts in the order of what they say.
    const groups = thingGroups(readings
      .filter((reading) => reading.type === type)
      .map((reading) => ({ ...reading, identity_keys: reading.keys })))
      .map((group) => combineAsOne(spec, group.members.map((member) => member.fact)))
      .sort(byWhatItSays);
    for (const fact of groups) facts.push({ ...fact, position: facts.filter((other) => other.type === type).length, type });
  }
  return facts;
};

/** Readings of one thing in one email, as one fact — in no order: a value
 *  they read alike stands, and a value two read differently is none, and says
 *  so (§9: what cannot be told apart is refused rather than guessed). Taken in
 *  turn, the first stood, and the markup's order chose. A name written two
 *  ways is one name, and data two read differently, the first by what they
 *  say. */
const combineAsOne = (spec: MailFactTypeSpec, readings: readonly RulesPassFact[]): RulesPassFact => {
  const ordered = [...readings].sort(byWhatItSays);
  const combined = ordered.slice(1).reduce((merged, next) => combineFacts(spec, merged, next), ordered[0]!);
  const kinds = new Map(mailFactTypeVariables(spec).map((variable) => [variable.name, variable.kind]));
  const variables = { ...combined.variables };
  const passes = { ...combined.passes };
  const refused = [...combined.refused];
  for (const name of Object.keys(variables)) {
    // Compared as identities compare them: a name written two ways is one.
    const read = new Set(ordered
      .map((reading) => reading.variables[name] ?? null)
      .filter((value): value is MailFactValue => value !== null)
      .map((value) => identityValueKey(value, kinds.get(name), name)));
    if (read.size < 2) continue;
    variables[name] = null;
    delete passes[name];
    refused.push({ variable: name, reason: 'the markup reads it two ways' });
  }
  return finishFact(spec, { position: combined.position, variables, passes, data: { ...(combined.data ?? {}) }, refused });
};
