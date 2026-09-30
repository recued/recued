/** D-315 §4.3 — the AI pass: the last pass, queued, one email per call. The real
 *  store, writer and runner; the model call stubbed (the privacy layer it goes
 *  through is proven in `d-315-ai-pass-privacy.test.ts`). */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getMailFactBuiltinType, mailFactEmptyAiSlots, type MailFact, type MailFactTypeSpec, type MailTemplateDefinition } from '@recued/contracts';
import { createWarehouseEventBus, type WarehouseEvent } from '@recued/warehouse-events';

import {
  buildMailFactAiInput,
  createMailFactAiRunner,
  fillFromAi,
  holdsAlias,
  MAIL_FACT_AI_SYSTEM_PROMPT,
  mailFactAiFailure,
  mailFactAiLayer,
  type MailFactAiCall,
  type MailFactAiDeps,
  type MailFactAiEmail,
  type MailFactAiRunner,
} from '../mail-facts/ai-pass.js';
import { createMailFactWriter, type MailFactWriteInput, type MailFactWriter } from '../mail-facts/fact-writer.js';
import type { MailFactSourceEmail } from '../mail-facts/rules-pass.js';
import { createMailFactStore, type MailFactStore } from '../storage/mail-fact-store.js';
import { createEventTriggerDispatcher } from '../triggers/dispatcher.js';
import { createEventTriggersStore } from '../triggers/store.js';

let dir: string;
let db: Database.Database;
let store: MailFactStore;
let writer: MailFactWriter;
let events: WarehouseEvent[];
let clock: number;
let ids: number;
let paused: boolean;
let byok: boolean;
let calls: Record<string, unknown>[];
let answer: MailFactAiCall;
let runner: MailFactAiRunner;

const shopEmail: MailFactAiEmail = {
  from: 'orders@shop.example',
  to: ['me@example.com'],
  cc: [],
  subject: 'Your order A-1',
  date: '2026-09-20T10:00:00.000Z',
  body_text: 'Thank you for your order A-1. Total: EUR 12,50.',
};

const makeRunner = (over: Partial<MailFactAiDeps> = {}): MailFactAiRunner =>
  createMailFactAiRunner({
    store,
    writer,
    readEmail: async () => shopEmail,
    call: (input, opts) => {
      calls.push(input);
      return answer(input, opts);
    },
    isPaused: () => paused,
    byokAllowed: () => byok,
    now: () => clock,
    ...over,
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-315-ai-'));
  db = new Database(join(dir, 'test.db'));
  clock = 10_000;
  ids = 0;
  events = [];
  calls = [];
  paused = false;
  byok = false;
  answer = async () => ({ facts: [] });
  store = createMailFactStore(db, { now: () => clock, mintId: (prefix) => `${prefix}_${(ids += 1)}` });
  writer = createMailFactWriter({
    store,
    emit: (event) => events.push(event),
    now: () => clock,
    onAiQueued: () => runner.kick(),
  });
  runner = makeRunner();
});

afterEach(() => {
  runner.dispose();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A shop's order email: the entrance is the exact address (more than a
 *  domain), and the order id — its identity — is left to the AI (ruling 39). */
const shopTemplate = (over: Partial<MailTemplateDefinition> = {}): MailTemplateDefinition => ({
  name: 'Shop orders',
  type: 'purchase',
  entrance: { conditions: [{ field: 'from', op: 'is', value: 'orders@shop.example' }], variables: [] },
  rules: [{ target: { variable: 'merchant' }, source: 'from_name', find: { kind: 'constant', value: 'Shop' } }],
  html: false,
  ai: { enabled: true, prompt: 'Order confirmations from Shop.', slots: ['order_id', 'total', 'data.items'], pool: 'free_only' },
  ...over,
});

const sourceEmail = (over: Partial<MailFactSourceEmail> = {}): MailFactSourceEmail => ({
  subject: shopEmail.subject,
  body_text: shopEmail.body_text,
  html: null,
  from_address: 'orders@shop.example',
  from_name: 'Shop',
  headers: {},
  labels: ['INBOX'],
  relationships: [],
  attachments: [],
  ...over,
});

const input = (record_id: string, over: Partial<MailFactWriteInput> = {}): MailFactWriteInput => ({
  ref: { slug: 'work', record_id },
  email: sourceEmail(),
  email_at: 1_000,
  content_fingerprint: `content-of-${record_id}`,
  may_trigger: true,
  count_health: true,
  ...over,
});

const onlyFact = (record_id: string): MailFact => {
  const facts = store.factsForEmail({ slug: 'work', record_id });
  expect(facts).toHaveLength(1);
  return facts[0]!;
};

describe('the pool (D-132 words, per template)', () => {
  it('asks for the layer the template chose, and free only without background BYOK', () => {
    expect(mailFactAiLayer('free_only', true)).toBe('free');
    expect(mailFactAiLayer('free_then_byok', true)).toBe('any');
    expect(mailFactAiLayer('free_then_byok', false)).toBe('free');
    expect(mailFactAiLayer('byok_only', true)).toBe('byok');
    expect(mailFactAiLayer('byok_only', false)).toBeNull();
  });
});

describe('the request', () => {
  it('has the chat’s shape: the owner’s prompt, the email as a mail read, the facts so far and what to fill', () => {
    const template = store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    writer.write(input('mail:1'));
    const fact = onlyFact('mail:1');
    const spec = getMailFactBuiltinType('purchase')!;
    const built = buildMailFactAiInput(template, spec, fact.email, shopEmail, [{ fact, fill: ['order_id'] }], 'free', 5);
    expect(built['llm.output_format']).toBe('json');
    expect(built['llm.force_layer']).toBe('free');
    const packet = JSON.parse(built['llm.prompt'] as string);
    expect(packet.user_message).toBe('Order confirmations from Shop.');
    const [mail, facts] = packet.prior_tool_calls;
    // The mail's marker names the record for the chat's resolver; no field of
    // a mail is tagged, and the warehouse's contacts are found in it by value.
    expect(mail).toMatchObject({ tool_name: 'core.mail.get', status: 'ok', result: { __entity: 'mail', from: 'orders@shop.example' } });
    expect(mail.result.body_text).toContain('order A-1');
    // The fact's marker tags the people a template read (§9).
    expect(facts.result.facts).toEqual([{ position: 0, read: { __entity: 'mail_fact', merchant: 'Shop' }, fill: ['order_id'] }]);
    expect(facts.result.variables).toContainEqual(expect.objectContaining({ name: 'order_id', kind: 'id' }));
    // §3.2 — what the data slots hold, as the type names it.
    expect(facts.result.data_fields).toEqual([{ path: 'items', kind: 'list', description: 'Line items.' }]);
  });
});

describe('the email as the model gets it', () => {
  it('is cut at 50,000 characters, and says so', () => {
    store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    runner.dispose();
    writer.write(input('mail:1'));
    const fact = onlyFact('mail:1');
    const built = buildMailFactAiInput(
      store.listTemplates()[0]!, getMailFactBuiltinType('purchase')!, fact.email,
      { ...shopEmail, body_text: 'x'.repeat(60_000) }, [{ fact, fill: ['order_id'] }], 'free', 5,
    );
    const mail = JSON.parse(built['llm.prompt'] as string).prior_tool_calls[0].result;
    expect(mail.body_text).toHaveLength(50_000);
    expect(mail.body_truncated).toBe(true);
  });

  it('is read canonical, as every reader reads it (§9)', () => {
    store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    runner.dispose();
    writer.write(input('mail:1'));
    const fact = onlyFact('mail:1');
    const built = buildMailFactAiInput(
      store.listTemplates()[0]!, getMailFactBuiltinType('purchase')!, fact.email,
      { ...shopEmail, subject: '\uFF39our order \uFF21\u2011\uFF11', body_text: 'Total\u200B: \uFF25\uFF35\uFF32 12.50' },
      [{ fact, fill: ['order_id'] }], 'free', 5,
    );
    const mail = JSON.parse(built['llm.prompt'] as string).prior_tool_calls[0].result;
    expect(mail.subject).toBe('Your order A-1');
    expect(mail.body_text).toBe('Total: EUR 12.50');
  });
});

describe('filling a fact', () => {
  const spec = getMailFactBuiltinType('purchase')!;
  const waiting = (over: Partial<MailFact> = {}): MailFact => ({
    fact_id: 'mfact_1',
    type: 'purchase',
    template_id: 'mtpl_1',
    email: { slug: 'work', record_id: 'mail:1' },
    email_at: 1_000,
    position: 0,
    identity_keys: [],
    thing_id: null,
    variables: { merchant: 'Shop', order_id: null, total: null, ordered_at: null, state: null },
    passes: { merchant: 'rule' },
    data: null,
    missing: ['order_id', 'total', 'ordered_at'],
    refused: [],
    complete: false,
    source_hash: 'h',
    revision: 1,
    created_at: 1,
    ai: { state: 'waiting', since: 1 },
    ...over,
  });

  it('never writes over data another pass read, even on the way to its slot', () => {
    const fact = waiting({ data: { order: 'A-1 (read by a rule)' }, passes: { merchant: 'rule', 'data.order': 'rule' } });
    // The slot counts as taken: nothing is asked for it.
    expect(mailFactEmptyAiSlots(['data.order.id', 'data.gift'], fact)).toEqual(['data.gift']);
    const read = fillFromAi(spec, fact, ['data.order.id'], { 'data.order.id': 'X' }, 5);
    expect(read.reading.data).toEqual({ order: 'A-1 (read by a rule)' });
    expect(read.reading.refused).toContainEqual({ variable: 'data.order.id', reason: 'its place holds a value another pass read' });
    expect(read.reading.passes['data.order']).toBe('rule');
  });

  it('keeps what the rules read when the AI’s data would take the fact over its cap', () => {
    const fact = waiting({ data: { note: 'read by a rule' }, passes: { merchant: 'rule', 'data.note': 'rule' } });
    const read = fillFromAi(spec, fact, ['data.page', 'order_id'], { 'data.page': 'x'.repeat(70 * 1024), order_id: 'A-1' }, 5);
    expect(read.reading.data).toEqual({ note: 'read by a rule' });
    expect(read.reading.variables.order_id).toBe('A-1');
    expect(read.ai).toMatchObject({ filled: ['order_id'] });
    expect(read.reading.refused).toContainEqual({ variable: 'data.page', reason: "the AI's data would take the fact over 64 KB" });
  });

  it('fills only the empty slots it was asked for, checks each value’s kind, and never overwrites', () => {
    const read = fillFromAi(spec, waiting(), ['order_id', 'total', 'data.items'], {
      order_id: ' A-1 ',
      total: 'EUR 12,50',
      merchant: 'Somebody else', // not asked: ignored
      ordered_at: '2026-09-20', // not asked: ignored
      'data.items': [{ name: 'Mug', qty: 1 }],
    }, 7);
    expect(read.reading.variables).toMatchObject({ merchant: 'Shop', order_id: 'A-1', ordered_at: null });
    expect(read.reading.variables.total).toEqual({ amount: '12.50', currency: 'EUR' });
    expect(read.reading.passes).toMatchObject({ merchant: 'rule', order_id: 'ai', total: 'ai', 'data.items': 'ai' });
    expect(read.reading.data).toEqual({ items: [{ name: 'Mug', qty: 1 }] });
    expect(read.reading.missing).toEqual(['ordered_at']);
    expect(read.ai).toEqual({ state: 'read', filled: ['order_id', 'total', 'data.items'], at: 7 });
  });

  it('takes a JSON number as the number it is: its point is a decimal point, never a thousands mark', () => {
    const meter: MailFactTypeSpec = {
      id: 'custom_meter', name: 'Meter', description: 'A meter reading.', states: [], notices: [],
      variables: [{ name: 'reading', kind: 'number', required: true }],
      identity: [['reading']],
    };
    const fact = waiting({ type: 'custom_meter', variables: { reading: null }, passes: {}, missing: ['reading'] });
    const read = fillFromAi(meter, fact, ['reading'], { reading: 1.125 }, 7);
    expect(read.reading.variables.reading).toBe(1.125);
    expect(read.reading.passes.reading).toBe('ai');
    expect(read.reading.refused).toEqual([]);
    // Whatever form JavaScript writes it in: 0.0000001 is written 1e-7.
    const reading = (value: number) => fillFromAi(meter, fact, ['reading'], { reading: value }, 7).reading;
    expect(reading(0.0000001).variables.reading).toBe(0.0000001);
    expect(reading(1e21).variables.reading).toBe(1e21);
    expect(reading(-2.5).variables.reading).toBe(-2.5);
    // A number is still refused as any is: one that is a full card number.
    expect(reading(4111111111111111).variables.reading).toBeNull();
    expect(reading(4111111111111111).refused).toEqual([{ variable: 'reading', reason: 'holds a full card number' }]);
    // A number past what one holds (JSON reads 1e400 as Infinity) is refused,
    // never stored as nothing.
    const huge = fillFromAi(meter, fact, ['reading'], { reading: JSON.parse('1e400') as number }, 7);
    expect(huge.reading.variables.reading).toBeNull();
    expect(huge.reading.refused).toEqual([{ variable: 'reading', reason: expect.stringMatching(/not a number|too large/) }]);
    // In data too: a number JSON could not hold is refused where it was.
    const inData = fillFromAi(spec, waiting(), ['data.items'], { 'data.items': [{ qty: JSON.parse('1e400') as number }] }, 7);
    expect(inData.reading.data).toEqual({ items: [{ qty: null }] });
    expect(inData.reading.refused).toContainEqual({ variable: 'data.items[0].qty', reason: 'is too large a number' });
  });

  it('takes an amount in the packet’s own shape, and a date as ISO', () => {
    const read = fillFromAi(spec, waiting(), ['total', 'ordered_at'], {
      total: { amount: '1.500', currency: 'KWD' },
      ordered_at: '2026-03-04',
    }, 7);
    expect(read.reading.variables.total).toEqual({ amount: '1.500', currency: 'KWD' });
    expect(read.reading.variables.ordered_at).toBe('2026-03-04');
    expect(read.reading.refused).toEqual([]);
    // What it asks for, in the words the model reads.
    expect(MAIL_FACT_AI_SYSTEM_PROMPT).toContain('a date as YYYY-MM-DD');
    expect(MAIL_FACT_AI_SYSTEM_PROMPT).toContain('{"amount":"12.50","currency":"EUR"}');
  });

  it('refuses a value in alias form, the wrong kind, or a card number — the slot stays empty, with why', () => {
    const read = fillFromAi(spec, waiting(), ['order_id', 'total', 'data.items', 'state'], {
      order_id: 'pii.Person9',
      total: 'about twelve euros',
      state: 'shipped',
      'data.items': [{ card: '4111 1111 1111 1111' }],
    }, 7);
    expect(read.reading.variables).toMatchObject({ order_id: null, total: null, state: null });
    const reasons = Object.fromEntries(read.reading.refused.map((refusal) => [refusal.variable, refusal.reason]));
    expect(reasons.order_id).toBe('alias not restored');
    expect(reasons.total).toBeDefined();
    expect(reasons.state).toContain('not one of');
    expect(reasons['data.items[0].card']).toBe('holds a full card number');
  });

  it('refuses an aliased key inside data', () => {
    expect(holdsAlias({ 'pii.Person1': 'x' })).toBe(true);
    expect(holdsAlias({ note: 'm1@d1.invalid' })).toBe(true);
    expect(holdsAlias({ note: 'Leave it with the neighbour' })).toBe(false);
    const read = fillFromAi(spec, waiting(), ['data.items'], { 'data.items': { 'pii.Person1': 'gift' } }, 7);
    expect(read.reading.refused).toEqual([{ variable: 'data.items', reason: 'alias not restored' }]);
    expect(read.ai).toMatchObject({ state: 'read', filled: [] });
  });

  it('keeps a value that only mentions PII — words are not an alias', () => {
    expect(holdsAlias({ note: 'The export must not contain any PII.' })).toBe(false);
    expect(holdsAlias('Attach the redacted pii.csv')).toBe(false);
    expect(holdsAlias({ note: 'Sent by cap_pii.Org2' })).toBe(true);
    expect(holdsAlias({ note: 'Reply to m7@d9.invalid' })).toBe(true);
    const read = fillFromAi(spec, waiting(), ['data.items'], { 'data.items': { note: 'No PII.' } }, 7);
    expect(read.reading.refused).toEqual([]);
    expect(read.ai).toMatchObject({ state: 'read', filled: ['data.items'] });
  });
});

describe('the AI pass on new mail', () => {
  it('holds the fact until it answers: then the identity it filled finds the thing, and the event fires', async () => {
    store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    answer = async () => ({ facts: [{ position: 0, values: { order_id: 'A-1', total: 'EUR 12,50' } }] });

    expect(writer.write(input('mail:1'))).toEqual({ facts: 1, events: 0 });
    // Waiting: stored, but on no thing, and nothing fired.
    expect(onlyFact('mail:1')).toMatchObject({ thing_id: null, ai: { state: 'waiting', since: 10_000 } });
    expect(events).toEqual([]);
    expect(store.countAiJobs()).toBe(1);

    await runner.settled();
    expect(calls).toHaveLength(1);
    const fact = onlyFact('mail:1');
    expect(fact.ai).toEqual({ state: 'read', filled: ['order_id', 'total'], at: 10_000 });
    expect(fact.thing_id).not.toBeNull();
    expect(fact.identity_keys.length).toBeGreaterThan(0);
    expect(store.countAiJobs()).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event_kind: 'created', record: { order_id: 'A-1', merchant: 'Shop' } });
    expect((events[0]!.record as { passes: Record<string, string> }).passes).toMatchObject({ order_id: 'ai', merchant: 'rule' });

    // The same order in a later email joins the same thing, and what it
    // changed — the total, as the AI read it — fires an update.
    answer = async () => ({ facts: [{ position: 0, values: { order_id: 'A-1', total: 'EUR 15,00' } }] });
    writer.write(input('mail:2', { email_at: 2_000 }));
    await runner.settled();
    expect(onlyFact('mail:2').thing_id).toBe(fact.thing_id);
    expect(events[1]).toMatchObject({ event_kind: 'updated', record_id: fact.thing_id, changed_fields: ['total', 'last_email_at'] });
  });

  it('is skipped when no slot is empty: nothing queued, nothing waits', () => {
    store.createTemplate({
      definition: shopTemplate({
        rules: [
          { target: { variable: 'merchant' }, source: 'from_name', find: { kind: 'constant', value: 'Shop' } },
          { target: { variable: 'order_id' }, source: 'subject', find: { kind: 'pattern', pattern: 'order (\\S+)' } },
        ],
        ai: { enabled: true, prompt: 'Orders.', slots: ['order_id'], pool: 'free_only' },
      }),
      origin: { kind: 'owner' },
    });
    writer.write(input('mail:1'));
    expect(onlyFact('mail:1')).toMatchObject({ thing_id: expect.any(String) });
    expect(onlyFact('mail:1').ai).toBeUndefined();
    expect(store.countAiJobs()).toBe(0);
    expect(events).toHaveLength(1);
  });

  it('places the fact on what the rules read when the AI cannot answer, and says why', async () => {
    store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    answer = async () => {
      throw Object.assign(new Error('timed out'), { code: 'AI_TIMEOUT' });
    };
    writer.write(input('mail:1'));
    await runner.settled();
    expect(onlyFact('mail:1')).toMatchObject({
      thing_id: expect.any(String),
      variables: expect.objectContaining({ merchant: 'Shop', order_id: null }),
      ai: { state: 'not_read', reason: 'the AI took too long', at: 10_000 },
    });
    expect(events).toHaveLength(1);
  });

  it('calls no model while background AI is paused, or when the pool cannot be honoured', async () => {
    store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    paused = true;
    writer.write(input('mail:1'));
    await runner.settled();
    expect(onlyFact('mail:1').ai).toMatchObject({ state: 'not_read', reason: 'background AI is paused' });

    paused = false;
    store.createTemplate({
      definition: shopTemplate({ name: 'Own keys', ai: { enabled: true, prompt: 'x', slots: ['order_id'], pool: 'byok_only' } }),
      origin: { kind: 'owner' },
    });
    // The older template wins at equal specificity; retire it for this email.
    store.updateTemplate('mtpl_1', { active: false });
    writer.write(input('mail:2'));
    await runner.settled();
    expect(onlyFact('mail:2').ai).toMatchObject({ state: 'not_read', reason: expect.stringContaining('background AI may not use them') });
    expect(calls).toEqual([]);
  });

  it('says why when the privacy layer could not protect the email: no call was made', async () => {
    store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    answer = async () => {
      throw Object.assign(new Error('chat privacy protection failed: x'), { code: 'chat_pii_privacy_failed' });
    };
    writer.write(input('mail:1'));
    await runner.settled();
    expect(onlyFact('mail:1').ai).toMatchObject({
      state: 'not_read',
      reason: 'the privacy layer could not protect this email, so no call was made',
    });
  });

  it('runs mail that can start recipes before a backfill’s', async () => {
    store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    const order: string[] = [];
    answer = async (built) => {
      order.push(JSON.parse(built['llm.prompt'] as string).prior_tool_calls[0].args.record_id);
      return { facts: [] };
    };
    runner.dispose();
    writer.write(input('mail:old', { origin: 'backfill', may_trigger: false }));
    clock += 1;
    writer.write(input('mail:new'));
    runner = makeRunner();
    runner.kick();
    await runner.settled();
    expect(order).toEqual(['mail:new', 'mail:old']);
  });

  it('runs live mail before a plain backfill’s, which starts nothing', async () => {
    store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    const order: string[] = [];
    answer = async (built) => {
      order.push(JSON.parse(built['llm.prompt'] as string).prior_tool_calls[0].args.record_id);
      return { facts: [] };
    };
    runner.dispose();
    writer.write(input('mail:old', { may_trigger: false }));
    clock += 1;
    writer.write(input('mail:new'));
    runner = makeRunner();
    runner.kick();
    await runner.settled();
    expect(order).toEqual(['mail:new', 'mail:old']);
  });

  it('stops where background work stops on the day’s budget: the facts go on with what the rules read', async () => {
    store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    runner.dispose();
    writer.write(input('mail:1'));
    runner = makeRunner({ budgetSpent: () => true });
    runner.kick();
    await runner.settled();
    expect(onlyFact('mail:1')).toMatchObject({ thing_id: expect.any(String), ai: { state: 'not_read', reason: expect.stringContaining('budget') } });
    expect(calls).toEqual([]);
  });
});

describe('news a queued call holds (§4.3, §5)', () => {
  const merchant = { target: { variable: 'merchant' }, source: 'from_name', find: { kind: 'constant', value: 'Shop' } } as const;
  const orderAfter = (label: string) =>
    ({ target: { variable: 'order_id' }, source: 'body', find: { kind: 'after_label', label } }) as const;
  const orders = (label: string): MailTemplateDefinition =>
    shopTemplate({ rules: [merchant, orderAfter(label)], ai: { enabled: true, prompt: 'Orders.', slots: ['order_id'], pool: 'free_only' } });
  const order = sourceEmail({ body_text: 'Order: A-1' });

  /** A live email whose order id the rules missed, waiting on its call — and
   *  the rule corrected before the call ran. No runner: the call stays queued. */
  const waitingThenCorrected = () => {
    const quiet = createMailFactWriter({ store, emit: (event) => events.push(event), now: () => clock });
    const template = store.createTemplate({ definition: orders('Old order label:'), origin: { kind: 'owner' } });
    quiet.write(input('mail:1', { email: order }));
    expect(store.aiJobsForEmail({ slug: 'work', record_id: 'mail:1' })).toMatchObject([{ may_trigger: true }]);
    expect(onlyFact('mail:1').ai?.state).toBe('waiting');
    expect(events).toEqual([]);
    store.updateTemplate(template.template_id, { definition: orders('Order:') });
    return { quiet, template };
  };

  it('is news still when the rules come to read what the call waited for: a backfill of past mail announces it', () => {
    const { quiet, template } = waitingThenCorrected();
    // Past mail read again, recipes not run: its own news would be none.
    quiet.write(input('mail:1', { email: order, force: true, backfill_template: template.template_id, may_trigger: false }));
    expect(store.countAiJobs()).toBe(0);
    expect(store.factRecordsForEmail({ slug: 'work', record_id: 'mail:1' })).toMatchObject([
      { announced: true, variables: expect.objectContaining({ order_id: 'A-1' }) },
    ]);
    expect(events).toEqual([expect.objectContaining({ event_kind: 'created', record: expect.objectContaining({ order_id: 'A-1' }) })]);
    // The email came live: so does its run.
    expect(events[0]).not.toHaveProperty('origin');
  });

  it('stays live news when a backfill that runs recipes reaches it', () => {
    const { quiet, template } = waitingThenCorrected();
    quiet.write(input('mail:1', { email: order, force: true, backfill_template: template.template_id, may_trigger: true, origin: 'backfill' }));
    expect(events).toHaveLength(1);
    expect(events[0]).not.toHaveProperty('origin');
  });
});

describe('a standards fact kept unpaired (§4)', () => {
  // Two orders in the markup, and a template fact that reads no identity: it
  // could be either, so both are kept apart until the AI names its order.
  const markup = `<script type="application/ld+json">${JSON.stringify(['A-1', 'C-3'].map((orderNumber) => ({
    '@context': 'https://schema.org', '@type': 'Order', orderNumber, seller: { '@type': 'Organization', name: 'Shop' },
  })))}</script>`;
  const facts = () => store.factsForEmail({ slug: 'work', record_id: 'mail:1' });

  it('joins the fact whose identity the AI filled; the other order is its own thing', async () => {
    store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    answer = async () => ({ facts: [{ position: 0, values: { order_id: 'A-1' } }] });
    runner.dispose();
    writer.write(input('mail:1', { email: sourceEmail({ html: markup }) }));
    expect(facts().map((fact) => [fact.template_id, fact.thing_id])).toEqual([['mtpl_1', null], [null, null], [null, null]]);
    runner = makeRunner();
    runner.kick();
    await runner.settled();
    expect(facts().map((fact) => [fact.template_id, fact.variables.order_id]).sort()).toEqual([[null, 'C-3'], ['mtpl_1', 'A-1']]);
    expect(facts().every((fact) => fact.thing_id !== null)).toBe(true);
    expect(store.listThings()).toHaveLength(2);
    expect(events.map((event) => event.event_kind)).toEqual(['created', 'created']);
  });

  it('keeps what the markup read over what the AI answered when they join: rules, then markup, then AI', async () => {
    store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    const priced = `<script type="application/ld+json">${JSON.stringify(['A-1', 'C-3'].map((orderNumber) => ({
      '@context': 'https://schema.org', '@type': 'Order', orderNumber, price: '10.00', priceCurrency: 'EUR',
      seller: { '@type': 'Organization', name: 'Shop' },
    })))}</script>`;
    answer = async () => ({ facts: [{ position: 0, values: { order_id: 'A-1', total: { amount: '999.00', currency: 'EUR' } } }] });
    runner.dispose();
    writer.write(input('mail:1', { email: sourceEmail({ html: priced }) }));
    runner = makeRunner();
    runner.kick();
    await runner.settled();
    const joined = facts().find((fact) => fact.template_id === 'mtpl_1')!;
    expect(joined.variables).toMatchObject({ order_id: 'A-1', total: { amount: '10.00', currency: 'EUR' } });
    expect(joined.passes.total).toBe('standard');
    // The markup's A-1 joined it; C-3 is its own.
    expect(facts().map((fact) => fact.variables.order_id).sort()).toEqual(['A-1', 'C-3']);
  });

  it('keeps a rule’s nested value when they join: the markup’s value above it does not replace it', async () => {
    store.createTemplate({
      definition: shopTemplate({
        rules: [
          ...shopTemplate().rules,
          { target: { data: 'url.label' }, source: 'body', find: { kind: 'after_label', label: 'Track:' } },
        ],
      }),
      origin: { kind: 'owner' },
    });
    const linked = `<script type="application/ld+json">${JSON.stringify(['A-1', 'C-3'].map((orderNumber) => ({
      '@context': 'https://schema.org', '@type': 'Order', orderNumber, url: `https://shop.example/orders/${orderNumber}`,
      seller: { '@type': 'Organization', name: 'Shop' },
    })))}</script>`;
    answer = async () => ({ facts: [{ position: 0, values: { order_id: 'A-1' } }] });
    runner.dispose();
    writer.write(input('mail:1', { email: sourceEmail({ body_text: `${shopEmail.body_text}\nTrack: Your order page\n`, html: linked }) }));
    runner = makeRunner();
    runner.kick();
    await runner.settled();
    const joined = facts().find((fact) => fact.template_id === 'mtpl_1')!;
    expect(joined.variables.order_id).toBe('A-1');
    expect(joined.data).toMatchObject({ url: { label: 'Your order page' } });
    // Each reading named by the pass that read it, and none left on nothing.
    expect(Object.entries(joined.passes).filter(([name]) => name.startsWith('data.'))).toEqual([['data.url.label', 'rule']]);
  });

  it('an unchanged backfill re-read keeps the join: the markup fact the AI joined is not made again', async () => {
    const template = store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    answer = async () => ({ facts: [{ position: 0, values: { order_id: 'A-1' } }] });
    runner.dispose();
    writer.write(input('mail:1', { email: sourceEmail({ html: markup }) }));
    runner = makeRunner();
    runner.kick();
    await runner.settled();
    const joined = facts().map((fact) => [fact.template_id, fact.variables.order_id, fact.thing_id !== null]).sort();
    expect(joined).toEqual([[null, 'C-3', true], ['mtpl_1', 'A-1', true]]);
    // Read again by a backfill: nothing it was read from changed.
    writer.write(input('mail:1', {
      email: sourceEmail({ html: markup }), force: true, backfill_template: template.template_id,
    }));
    expect(facts().map((fact) => [fact.template_id, fact.variables.order_id, fact.thing_id !== null]).sort()).toEqual(joined);
    expect(store.countAiJobs()).toBe(0);
  });

  it('joins neither markup order to the order the AI named when both share its number: the ids alone do not choose — and a re-read keeps it so', async () => {
    const template = store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    // Two vendors' orders of one number: the ids alone name either.
    const vendors = `<script type="application/ld+json">${JSON.stringify([['Vendor X', '10.00'], ['Vendor Y', '20.00']].map(([name, price]) => ({
      '@context': 'https://schema.org', '@type': 'Order', orderNumber: 'A-1', price, priceCurrency: 'EUR',
      seller: { '@type': 'Organization', name },
    })))}</script>`;
    answer = async () => ({ facts: [{ position: 0, values: { order_id: 'A-1' } }] });
    runner.dispose();
    writer.write(input('mail:1', { email: sourceEmail({ html: vendors }) }));
    runner = makeRunner();
    runner.kick();
    await runner.settled();
    const orders = () => facts().map((fact) => [fact.template_id, fact.variables.merchant, (fact.variables.total as { amount: string } | null)?.amount ?? null]).sort();
    const joined = orders();
    // Either could be the shop's: §4 does not guess. Each stays its own.
    expect(joined).toEqual([[null, 'Vendor X', '10.00'], [null, 'Vendor Y', '20.00'], ['mtpl_1', 'Shop', null]]);
    // Read again by a backfill: nothing is taken, and nothing made again.
    writer.write(input('mail:1', { email: sourceEmail({ html: vendors }), force: true, backfill_template: template.template_id }));
    expect(orders()).toEqual(joined);
  });

  it('joins the markup fact the AI’s answer proves, though another parcel of the email is still unknown', async () => {
    store.createTemplate({
      definition: {
        name: 'Parcels', type: 'shipment',
        entrance: { conditions: [{ field: 'from', op: 'is', value: 'orders@shop.example' }], variables: [] },
        rules: [{ target: { variable: 'carrier' }, source: 'body', find: { kind: 'constant', value: 'UPS' } }],
        repeat: { source: 'body', split: 'Parcel \\d+' },
        html: false,
        ai: { enabled: true, prompt: 'Parcels from the shop.', slots: ['tracking_number'], pool: 'free_only' },
      },
      origin: { kind: 'owner' },
    });
    const parcels = `<script type="application/ld+json">${JSON.stringify(['TRACK-1', 'TRACK-2'].map((trackingNumber, i) => ({
      '@context': 'https://schema.org', '@type': 'ParcelDelivery', trackingNumber,
      carrier: { '@type': 'Organization', name: 'UPS' }, expectedArrivalUntil: `2026-10-0${i + 1}`,
    })))}</script>`;
    // The AI knows the first parcel's number, not the second's.
    answer = async () => ({ facts: [{ position: 0, values: { tracking_number: 'TRACK-1' } }, { position: 1, values: { tracking_number: null } }] });
    runner.dispose();
    writer.write(input('mail:1', { email: sourceEmail({ body_text: 'Parcel 1\nYour first parcel.\nParcel 2\nYour second parcel.\n', html: parcels }) }));
    runner = makeRunner();
    runner.kick();
    await runner.settled();
    const byTemplate = facts().filter((fact) => fact.template_id !== null).sort((a, b) => a.position - b.position);
    // The first parcel took what the markup knew of it: its date.
    expect(byTemplate[0]!.variables).toMatchObject({ tracking_number: 'TRACK-1', expected_at: '2026-10-01' });
    expect(byTemplate[1]!.variables.tracking_number).toBeNull();
    // The second's markup waits, apart: it may be the parcel the AI did not know.
    expect(facts().filter((fact) => fact.template_id === null).map((fact) => [fact.variables.tracking_number, fact.thing_id]))
      .toEqual([['TRACK-2', null]]);
  });

  it('an unchanged re-read keeps a join the ids made, the names written differently: nothing is made again', async () => {
    const template = store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    // The template names the shop; the markup names the vendor behind it.
    const vendor = `<script type="application/ld+json">${JSON.stringify(['A-1', 'B-2'].map((orderNumber) => ({
      '@context': 'https://schema.org', '@type': 'Order', orderNumber, seller: { '@type': 'Organization', name: 'Legal Vendor' },
    })))}</script>`;
    answer = async () => ({ facts: [{ position: 0, values: { order_id: 'A-1' } }] });
    runner.dispose();
    writer.write(input('mail:1', { email: sourceEmail({ html: vendor }) }));
    runner = makeRunner();
    runner.kick();
    await runner.settled();
    const joined = facts().map((fact) => [fact.template_id, fact.variables.order_id, fact.thing_id !== null]).sort();
    expect(joined).toEqual([[null, 'B-2', true], ['mtpl_1', 'A-1', true]]);
    // Read again by a backfill: nothing it was read from changed.
    writer.write(input('mail:1', { email: sourceEmail({ html: vendor }), force: true, backfill_template: template.template_id }));
    expect(facts().map((fact) => [fact.template_id, fact.variables.order_id, fact.thing_id !== null]).sort()).toEqual(joined);
  });

  it('a switched-off template’s kept fact keeps a join the ids made: a re-read makes nothing again beside it', async () => {
    const template = store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    const vendor = `<script type="application/ld+json">${JSON.stringify(['A-1', 'B-2'].map((orderNumber) => ({
      '@context': 'https://schema.org', '@type': 'Order', orderNumber, seller: { '@type': 'Organization', name: 'Legal Vendor' },
    })))}</script>`;
    answer = async () => ({ facts: [{ position: 0, values: { order_id: 'A-1' } }] });
    runner.dispose();
    writer.write(input('mail:1', { email: sourceEmail({ html: vendor }) }));
    runner = makeRunner();
    runner.kick();
    await runner.settled();
    const joined = facts().map((fact) => [fact.template_id, fact.variables.order_id]).sort();
    expect(joined).toEqual([[null, 'B-2'], ['mtpl_1', 'A-1']]);
    // Switched off, it reads no mail; what it read stays with its email.
    store.updateTemplate(template.template_id, { active: false });
    writer.write(input('mail:1', { email: sourceEmail({ html: vendor }), force: true }));
    expect(facts().map((fact) => [fact.template_id, fact.variables.order_id]).sort()).toEqual(joined);
  });

  it('a backfill that runs recipes announces only its template’s facts: the markup’s other order stays silent', async () => {
    const template = store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    answer = async () => ({ facts: [{ position: 0, values: { order_id: 'A-1' } }] });
    runner.dispose();
    writer.write(input('mail:1', {
      email: sourceEmail({ html: markup }), force: true, origin: 'backfill', backfill_template: template.template_id,
    }));
    runner = makeRunner();
    runner.kick();
    await runner.settled();
    expect(facts().every((fact) => fact.thing_id !== null)).toBe(true);
    expect(events.map((event) => (event.record as { order_id?: string }).order_id)).toEqual(['A-1']);
  });

  it('never joins the AI’s invoice to the markup’s other invoice of the same period', async () => {
    store.createTemplate({
      definition: {
        name: 'Shop bills', type: 'bill',
        entrance: { conditions: [{ field: 'from', op: 'is', value: 'orders@shop.example' }], variables: [] },
        rules: [{ target: { variable: 'issuer' }, source: 'from_name', find: { kind: 'constant', value: 'Shop' } }],
        html: false,
        ai: { enabled: true, prompt: 'Bills from Shop.', slots: ['invoice_number', 'period'], pool: 'free_only' },
      },
      origin: { kind: 'owner' },
    });
    const invoices = `<script type="application/ld+json">${JSON.stringify(['I-1', 'I-2'].map((id) => ({
      '@type': 'Invoice', provider: { name: 'Shop' }, confirmationNumber: id, billingPeriod: '2026-09',
      totalPaymentDue: { value: id === 'I-1' ? '10' : '20', currency: 'EUR' },
    })))}</script>`;
    answer = async () => ({ facts: [{ position: 0, values: { invoice_number: 'I-2', period: '2026-09' } }] });
    runner.dispose();
    writer.write(input('mail:1', { email: sourceEmail({ html: invoices }) }));
    runner = makeRunner();
    runner.kick();
    await runner.settled();
    const things = store.listThings();
    expect(things.map((thing) => thing.variables.invoice_number).sort()).toEqual(['I-1', 'I-2']);
    expect(things.find((thing) => thing.variables.invoice_number === 'I-1')?.variables.amount_due).toMatchObject({ amount: '10' });
    expect(events).toHaveLength(2);
  });

  it('announces the markup’s other order too when the rules come to read what the call waited for', () => {
    // No runner: the call stays queued, with the live email's news.
    const quiet = createMailFactWriter({ store, emit: (event) => events.push(event), now: () => clock });
    const slots = { enabled: true, prompt: 'Orders.', slots: ['order_id'], pool: 'free_only' } as const;
    const template = store.createTemplate({ definition: shopTemplate({ ai: slots }), origin: { kind: 'owner' } });
    quiet.write(input('mail:1', { email: sourceEmail({ html: markup }) }));
    expect(facts().map((fact) => [fact.template_id, fact.thing_id])).toEqual([['mtpl_1', null], [null, null], [null, null]]);
    expect(events).toEqual([]);
    // The owner's rule now reads the order from the subject; past mail is
    // read again, recipes not run.
    store.updateTemplate(template.template_id, {
      definition: shopTemplate({
        rules: [
          { target: { variable: 'merchant' }, source: 'from_name', find: { kind: 'constant', value: 'Shop' } },
          { target: { variable: 'order_id' }, source: 'subject', find: { kind: 'pattern', pattern: 'order (\\S+)' } },
        ],
        ai: slots,
      }),
    });
    quiet.write(input('mail:1', {
      email: sourceEmail({ html: markup }), force: true, backfill_template: template.template_id, may_trigger: false,
    }));
    expect(store.countAiJobs()).toBe(0);
    // Nothing is left waiting on a call that will never come.
    expect(facts().every((fact) => fact.thing_id !== null)).toBe(true);
    // As the call would have: the joined order and the markup's other one.
    expect(events.map((event) => (event.record as { order_id?: string }).order_id).sort()).toEqual(['A-1', 'C-3']);
    expect(events.every((event) => event.origin === undefined)).toBe(true);
  });

  it('are each their own thing when the AI’s identity names another order', async () => {
    store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    answer = async () => ({ facts: [{ position: 0, values: { order_id: 'B-2' } }] });
    writer.write(input('mail:1', { email: sourceEmail({ html: markup }) }));
    await runner.settled();
    expect(facts().map((fact) => fact.variables.order_id).sort()).toEqual(['A-1', 'B-2', 'C-3']);
    expect(facts().every((fact) => fact.thing_id !== null)).toBe(true);
    expect(store.listThings()).toHaveLength(3);
  });
});

describe('what the queue survives', () => {
  it('a restart: the queued call is made by the next runner', async () => {
    store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    runner.dispose();
    writer.write(input('mail:1'));
    expect(store.countAiJobs()).toBe(1);
    answer = async () => ({ facts: [{ position: 0, values: { order_id: 'A-1' } }] });
    runner = makeRunner();
    runner.kick();
    await runner.settled();
    expect(onlyFact('mail:1')).toMatchObject({ ai: { state: 'read', filled: ['order_id'] }, thing_id: expect.any(String) });
  });

  it('a re-read while it waits: the late answer settles nothing the new reading queued', async () => {
    store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    answer = async () => {
      await gate;
      return { facts: [{ position: 0, values: { order_id: 'OLD-1' } }] };
    };
    writer.write(input('mail:1'));
    // The call is in flight; the email is read again (its content changed).
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    writer.write(input('mail:1', { content_fingerprint: 'changed' }));
    answer = async () => ({ facts: [{ position: 0, values: { order_id: 'NEW-1' } }] });
    release();
    await runner.settled();
    // The old answer's facts were gone; the new reading got its own call.
    expect(onlyFact('mail:1')).toMatchObject({ variables: expect.objectContaining({ order_id: 'NEW-1' }) });
    expect(store.countAiJobs()).toBe(0);
  });

  it('a re-read while it waits keeps its news: the recipes still start', async () => {
    store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    runner.dispose();
    writer.write(input('mail:1'));
    // Read again (an attachment arrived late): not news in itself.
    writer.write(input('mail:1', { content_fingerprint: 'changed', may_trigger: false, count_health: false }));
    expect(store.nextAiJob()).toMatchObject({ may_trigger: true });
    answer = async () => ({ facts: [{ position: 0, values: { order_id: 'A-1' } }] });
    runner = makeRunner();
    runner.kick();
    await runner.settled();
    expect(events).toHaveLength(1);
  });

  it('a move while it waits: the answer finds its facts under the new id', async () => {
    store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    answer = async () => {
      await gate;
      return { facts: [{ position: 0, values: { order_id: 'A-1' } }] };
    };
    writer.write(input('mail:1'));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    writer.rekeyEmail('work', 'mail:1', 'mail:9');
    release();
    await runner.settled();
    expect(onlyFact('mail:9')).toMatchObject({ thing_id: expect.any(String), ai: { state: 'read', filled: ['order_id'] } });
    expect(events).toHaveLength(1);
  });

  // The sync read the moved email under its new id before it heard of the
  // move: that reading found a copy of an email read already, and was silent.
  const copyOf = (record_id: string): MailFactWriteInput => input(record_id, {
    content_fingerprint: 'the-one-email',
    envelope: {
      slug: 'work', account_email: 'me@example.com', to: ['me@example.com'], cc: [], sent_by_account: false,
      rfc_message_id: '<a-1@shop.example>', thread_id: 't-a-1',
    },
  });

  it('a move to a copy read under its new id first: the news the old id’s call held goes with it', async () => {
    store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    answer = async () => ({ facts: [{ position: 0, values: { order_id: 'A-1' } }] });
    runner.dispose();
    writer.write(copyOf('mail:1'));
    writer.write(copyOf('mail:9'));
    expect(store.aiJobsForEmail({ slug: 'work', record_id: 'mail:1' })).toEqual([expect.objectContaining({ may_trigger: true })]);
    expect(store.aiJobsForEmail({ slug: 'work', record_id: 'mail:9' })).toEqual([expect.objectContaining({ may_trigger: false })]);
    writer.rekeyEmail('work', 'mail:1', 'mail:9');
    expect(store.aiJobsForEmail({ slug: 'work', record_id: 'mail:9' })).toEqual([
      expect.objectContaining({ may_trigger: true }),
    ]);
    expect(store.aiJobsForEmail({ slug: 'work', record_id: 'mail:9' })[0]!.origin).toBeUndefined();
    runner = makeRunner();
    runner.kick();
    await runner.settled();
    expect(onlyFact('mail:9')).toMatchObject({ thing_id: expect.any(String), ai: { state: 'read', filled: ['order_id'] } });
    expect(events.map((event) => [event.event_kind, event.origin ?? 'live'])).toEqual([['created', 'live']]);
  });

  it('a move to a copy whose own call answered already: its facts, never announced, are announced now', async () => {
    store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    runner.dispose();
    writer.write(copyOf('mail:1'));
    writer.write(copyOf('mail:9'));
    // The new id's call answered first, silently.
    const [job] = store.aiJobsForEmail({ slug: 'work', record_id: 'mail:9' });
    const fact = onlyFact('mail:9');
    writer.applyAi(job!, [fillFromAi(getMailFactBuiltinType('purchase')!, fact, ['order_id'], { order_id: 'A-1' }, clock)]);
    expect(onlyFact('mail:9').thing_id).not.toBeNull();
    expect(events).toEqual([]);
    writer.rekeyEmail('work', 'mail:1', 'mail:9');
    expect(events.map((event) => [event.event_kind, event.origin ?? 'live'])).toEqual([['created', 'live']]);
    expect(store.factsForEmail({ slug: 'work', record_id: 'mail:1' })).toEqual([]);
    expect(store.aiJobsForEmail({ slug: 'work', record_id: 'mail:1' })).toEqual([]);
    // Told once: moved again, nothing more.
    writer.rekeyEmail('work', 'mail:9', 'mail:12');
    expect(events).toHaveLength(1);
  });

  it('a move from an id whose reading was silent carries nothing: the copy stays silent', async () => {
    store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    answer = async () => ({ facts: [{ position: 0, values: { order_id: 'A-1' } }] });
    runner.dispose();
    writer.write({ ...copyOf('mail:1'), may_trigger: false });
    writer.write(copyOf('mail:9'));
    writer.rekeyEmail('work', 'mail:1', 'mail:9');
    runner = makeRunner();
    runner.kick();
    await runner.settled();
    expect(onlyFact('mail:9').thing_id).not.toBeNull();
    expect(events).toEqual([]);
  });

  it('a move to a copy whose call answered, its template switched off since: nothing is started', async () => {
    const template = store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    runner.dispose();
    writer.write(copyOf('mail:1'));
    writer.write(copyOf('mail:9'));
    const [job] = store.aiJobsForEmail({ slug: 'work', record_id: 'mail:9' });
    writer.applyAi(job!, [fillFromAi(getMailFactBuiltinType('purchase')!, onlyFact('mail:9'), ['order_id'], { order_id: 'A-1' }, clock)]);
    store.updateTemplate(template.template_id, { active: false });
    writer.rekeyEmail('work', 'mail:1', 'mail:9');
    expect(events).toEqual([]);
  });

  it('a move to a copy read first carries no news the old id no longer held', async () => {
    store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    answer = async () => ({ facts: [{ position: 0, values: { order_id: 'A-1' } }] });
    writer.write(copyOf('mail:1'));
    await runner.settled();
    expect(events).toHaveLength(1);
    runner.dispose();
    writer.write(copyOf('mail:9'));
    writer.rekeyEmail('work', 'mail:1', 'mail:9');
    runner = makeRunner();
    runner.kick();
    await runner.settled();
    // The old id announced it: the copy's reading stays silent.
    expect(events).toHaveLength(1);
  });

  it('a template deleted while it waits: its facts are placed, and start nothing', async () => {
    const template = store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    runner.dispose();
    writer.write(input('mail:1'));
    store.deleteTemplate(template.template_id);
    runner = makeRunner();
    runner.kick();
    await runner.settled();
    expect(onlyFact('mail:1')).toMatchObject({ thing_id: expect.any(String), ai: { state: 'not_read', reason: 'its template was deleted' } });
    expect(events).toEqual([]);
  });

  it('a job promoted while its call is in flight: the answer starts the recipes the backfill asked for', () => {
    const template = store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    runner.dispose();
    // Read silently (a restart's re-list): its call is queued, and starts nothing.
    writer.write(input('mail:1', { may_trigger: false }));
    const inFlight = store.nextAiJob()!;
    expect(inFlight.may_trigger).toBe(false);
    // While the call runs, a backfill that runs recipes reaches the email.
    writer.write(input('mail:1', {
      may_trigger: true, origin: 'backfill', force: true, backfill_template: template.template_id,
    }));
    const fact = onlyFact('mail:1');
    writer.applyAi(inFlight, [{
      fact_id: fact.fact_id,
      reading: { variables: { ...fact.variables, order_id: 'A-1' }, passes: { ...fact.passes, order_id: 'ai' }, data: null, refused: [], missing: [], complete: true },
      ai: { state: 'read', filled: ['order_id'], at: clock },
    }]);
    expect(events).toEqual([expect.objectContaining({ event_kind: 'created', origin: 'backfill' })]);
  });

  it('a template switched off while it waits: no call, its facts placed on the rules, and nothing started', async () => {
    const template = store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    runner.dispose();
    writer.write(input('mail:1'));
    store.updateTemplate(template.template_id, { active: false });
    runner = makeRunner();
    runner.kick();
    await runner.settled();
    expect(calls).toEqual([]);
    expect(onlyFact('mail:1')).toMatchObject({ thing_id: expect.any(String), ai: { state: 'not_read', reason: 'its template was switched off' } });
    expect(events).toEqual([]);
    expect(store.countAiJobs()).toBe(0);
  });

  it('a template switched off while its call runs: the answer is not taken, the fact settles on its rules', async () => {
    const template = store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    answer = async () => {
      store.updateTemplate(template.template_id, { active: false });
      return { facts: [{ position: 0, values: { order_id: 'A-1' } }] };
    };
    writer.write(input('mail:1'));
    await runner.settled();
    expect(calls).toHaveLength(1);
    expect(onlyFact('mail:1')).toMatchObject({
      variables: expect.objectContaining({ order_id: null }),
      ai: { state: 'not_read', reason: 'its template was switched off' },
    });
    expect(events).toEqual([]);
  });

  /** The shop's template with its AI changed: switched off, or the total taken from what it may fill. */
  const aiChanged = {
    off: () => shopTemplate({ ai: { enabled: false } }),
    narrowed: () => shopTemplate({ ai: { enabled: true, prompt: 'Order confirmations from Shop.', slots: ['order_id', 'data.items'], pool: 'free_only' } }),
  };

  it('its AI switched off while its call runs: the answer is not taken, and the fact settles on its rules', async () => {
    const template = store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    answer = async () => {
      store.updateTemplate(template.template_id, { definition: aiChanged.off() });
      return { facts: [{ position: 0, values: { order_id: 'A-1', total: 'EUR 99.00' } }] };
    };
    writer.write(input('mail:1'));
    await runner.settled();
    expect(calls).toHaveLength(1);
    expect(onlyFact('mail:1')).toMatchObject({
      variables: expect.objectContaining({ order_id: null, total: null }),
      ai: { state: 'not_read', reason: "its template's AI was switched off" },
    });
    expect(JSON.stringify(events)).not.toContain('99');
  });

  it('a slot taken from its AI while its call runs: the answer fills only what the AI may fill now', async () => {
    const template = store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    answer = async () => {
      store.updateTemplate(template.template_id, { definition: aiChanged.narrowed() });
      return { facts: [{ position: 0, values: { order_id: 'A-1', total: 'EUR 99.00' } }] };
    };
    writer.write(input('mail:1'));
    await runner.settled();
    expect(onlyFact('mail:1')).toMatchObject({
      variables: expect.objectContaining({ order_id: 'A-1', total: null }),
      ai: { state: 'read', filled: ['order_id'] },
    });
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('99');
  });

  it('a slot taken from its AI while the answer waits for room in the trigger queue: it fills what the AI may fill then', async () => {
    const template = store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    answer = async () => ({ facts: [{ position: 0, values: { order_id: 'A-1', total: 'EUR 99.00' } }] });
    runner.dispose();
    writer.write(input('mail:1'));
    let open: () => void = () => {};
    const room = vi.fn(() => new Promise<void>((resolve) => { open = resolve; }));
    runner = makeRunner({ triggerRoom: room });
    runner.kick();
    await vi.waitFor(() => expect(room).toHaveBeenCalledTimes(1));
    store.updateTemplate(template.template_id, { definition: aiChanged.narrowed() });
    open();
    await runner.settled();
    expect(onlyFact('mail:1')).toMatchObject({ variables: expect.objectContaining({ order_id: 'A-1', total: null }) });
    expect(JSON.stringify(events)).not.toContain('99');
  });

  it.each([
    ['its AI switched off', 'off', "its template's AI was switched off"],
    ['the total taken from its slots', 'narrowed', "its template's AI may no longer fill what it answered"],
  ] as const)('the writer takes no answer its template’s AI may no longer give — %s — whoever settles it', (_, change, reason) => {
    const template = store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    runner.dispose();
    writer.write(input('mail:1'));
    const job = store.nextAiJob()!;
    const fact = onlyFact('mail:1');
    // Read while the AI could fill the total.
    const stale = fillFromAi(getMailFactBuiltinType('purchase')!, fact, ['order_id', 'total'], { order_id: 'A-1', total: 'EUR 99.00' }, clock);
    expect(stale.reading.variables.total).not.toBeNull();
    store.updateTemplate(template.template_id, { definition: aiChanged[change]() });
    writer.applyAi(job, [stale]);
    expect(onlyFact('mail:1')).toMatchObject({
      variables: expect.objectContaining({ order_id: null, total: null }),
      ai: { state: 'not_read', reason },
    });
    expect(JSON.stringify(events)).not.toContain('99');
  });

  it('a template switched off, or AI paused, while its email is read: still no call', async () => {
    const template = store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    runner.dispose();
    writer.write(input('mail:1'));
    runner = makeRunner({
      readEmail: async () => {
        store.updateTemplate(template.template_id, { active: false });
        return shopEmail;
      },
    });
    runner.kick();
    await runner.settled();
    expect(calls).toEqual([]);
    expect(onlyFact('mail:1')).toMatchObject({ ai: { state: 'not_read', reason: 'its template was switched off' } });

    store.updateTemplate(template.template_id, { active: true });
    runner.dispose();
    writer.write(input('mail:2'));
    runner = makeRunner({
      readEmail: async () => {
        paused = true;
        return shopEmail;
      },
    });
    runner.kick();
    await runner.settled();
    expect(calls).toEqual([]);
    expect(onlyFact('mail:2')).toMatchObject({ ai: { state: 'not_read', reason: 'background AI is paused' } });
  });

  it('a newer reading while its email is read: this job sends nothing, the newer one does', async () => {
    store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    runner.dispose();
    writer.write(input('mail:1'));
    let reads = 0;
    runner = makeRunner({
      readEmail: async () => {
        reads += 1;
        // The email changed while the first job read it: a new job replaces it.
        if (reads === 1) writer.write(input('mail:1', { content_fingerprint: 'content-changed' }));
        return shopEmail;
      },
    });
    runner.kick();
    await runner.settled();
    // The first job sent nothing; the job that replaced it read the email and called.
    expect(reads).toBe(2);
    expect(calls).toHaveLength(1);
    expect(store.countAiJobs()).toBe(0);
  });

  it('an answer that may start recipes waits for room in the trigger queue; a silent one never waits', async () => {
    store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    answer = async () => ({ facts: [{ position: 0, values: { order_id: 'A-1' } }] });
    runner.dispose();
    writer.write(input('mail:1'));
    writer.write(input('mail:2', { may_trigger: false }));
    let open: () => void = () => {};
    const room = vi.fn(() => new Promise<void>((resolve) => { open = resolve; }));
    runner = makeRunner({ triggerRoom: room });
    runner.kick();
    await vi.waitFor(() => expect(room).toHaveBeenCalledTimes(1));
    // The answer is in, and waits: nothing placed yet, so nothing announced.
    expect(events).toEqual([]);
    expect(onlyFact('mail:1')).toMatchObject({ ai: { state: 'waiting' } });
    open();
    await runner.settled();
    expect(events.map((event) => event.event_kind)).toEqual(['created']);
    // The silent job's answer was placed without waiting.
    expect(room).toHaveBeenCalledTimes(1);
    expect(onlyFact('mail:2')).toMatchObject({ ai: { state: 'read' } });
  });

  it('a call nothing waits on any more waits for no room in the trigger queue: it goes', async () => {
    const template = store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    runner.dispose();
    // A call that carries news, for an email none of whose facts wait on it.
    store.enqueueAiJob({ job_id: 'maijob_x', email: { slug: 'work', record_id: 'mail:9' }, template_id: template.template_id, may_trigger: true, attempts: 0, queued_at: clock });
    const room = vi.fn(() => new Promise<void>(() => {}));
    runner = makeRunner({ triggerRoom: room });
    runner.kick();
    await runner.settled();
    expect(room).not.toHaveBeenCalled();
    expect(store.countAiJobs()).toBe(0);
  });

  it('a mailbox not live yet: its calls wait for it, and the others go on', async () => {
    store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    runner.dispose();
    writer.write(input('mail:2', { ref: { slug: 'home', record_id: 'mail:2' } }));
    writer.write(input('mail:1'));
    const live = new Set(['work']);
    runner = makeRunner({ mailboxLive: (slug) => live.has(slug) });
    runner.kick();
    await runner.settled();
    expect(onlyFact('mail:1').ai).toMatchObject({ state: 'read' });
    expect(store.aiJobsForEmail({ slug: 'home', record_id: 'mail:2' })).toHaveLength(1);
    live.add('home');
    runner.kick();
    await runner.settled();
    expect(store.countAiJobs()).toBe(0);
    expect(store.factsForEmail({ slug: 'home', record_id: 'mail:2' })[0]?.ai).toMatchObject({ state: 'read' });
  });

  it('an unexpected failure: the runner tries again by itself, not only when the next email comes', async () => {
    store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    runner.dispose();
    writer.write(input('mail:1'));
    let reads = 0;
    answer = async () => ({ facts: [{ position: 0, values: { order_id: 'A-1' } }] });
    runner = makeRunner({
      retryDelayMs: 5,
      readEmail: async () => {
        reads += 1;
        if (reads === 1) throw new Error('disk hiccup');
        return shopEmail;
      },
    });
    runner.kick();
    await vi.waitFor(() => expect(onlyFact('mail:1').ai).toMatchObject({ state: 'read' }));
    expect(reads).toBe(2);
  });

  it('names an email too long for the model, not a spent budget', () => {
    const tooLong = Object.assign(new Error('LLM input too large (413): prompt is too long'), {
      code: 'AI_TOKEN_BUDGET_EXCEEDED', details: { status: 413 },
    });
    expect(mailFactAiFailure(tooLong)).toBe('the email was too long for the model');
    expect(mailFactAiFailure(Object.assign(new Error('AI_TOKEN_BUDGET_EXCEEDED: Daily token budget exhausted.'), { code: 'AI_TOKEN_BUDGET_EXCEEDED' })))
      .toBe("the day's AI budget is spent");
  });

  it('the email’s deletion: its call goes with it', () => {
    store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    runner.dispose();
    writer.write(input('mail:1'));
    writer.removeEmails('work', ['mail:1']);
    expect(store.countAiJobs()).toBe(0);
    expect(store.factsForEmail({ slug: 'work', record_id: 'mail:1' })).toEqual([]);
  });

  it('a waiting fact is not an unpaired one in the facts list', () => {
    store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    runner.dispose();
    writer.write(input('mail:1'));
    expect(store.listFactPage({ unpaired: true, limit: 10 }).emails).toEqual([]);
    expect(store.listFactPage({ limit: 10 }).emails).toHaveLength(1);
  });
});

describe('waiting for an email’s news (§6.3)', () => {
  const ref = { slug: 'work', record_id: 'mail:1' };

  it('ends at once when no call holding news waits on the email', async () => {
    await expect(runner.untilSettled(ref)).resolves.toBe(0);
    store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    runner.dispose();
    runner = makeRunner();
    // A call that holds no news: nothing to wait for.
    writer.write(input('mail:1', { may_trigger: false }));
    await expect(runner.untilSettled(ref)).resolves.toBe(0);
  });

  it('ends once its call is answered, with the events the answer told', async () => {
    store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    answer = async () => {
      await gate;
      return { facts: [{ position: 0, values: { order_id: 'A-1' } }] };
    };
    writer.write(input('mail:1'));
    let told: number | undefined;
    void runner.untilSettled(ref).then((n) => { told = n; });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(told).toBeUndefined();
    release();
    await vi.waitFor(() => expect(told).toBe(1));
    expect(events).toHaveLength(1);
  });

  it('follows its email when it moves: it ends only once the call, now the new id’s, is answered', async () => {
    store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    runner.dispose();
    runner = makeRunner({ settleRecheckMs: 5 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    answer = async () => {
      await gate;
      return { facts: [{ position: 0, values: { order_id: 'A-1' } }] };
    };
    writer.write(input('mail:1'));
    let told: number | undefined;
    void runner.untilSettled(ref).then((n) => { told = n; });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    writer.rekeyEmail('work', 'mail:1', 'mail:9');
    // Looked again, many times: the call waits under the new id.
    await new Promise((resolve) => { setTimeout(resolve, 40); });
    expect(told).toBeUndefined();
    release();
    await vi.waitFor(() => expect(told).toBe(1));
    expect(onlyFact('mail:9').thing_id).not.toBeNull();
  });

  it('ends when the call goes another way: its email deleted while it waited', async () => {
    store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    runner.dispose();
    // Its mailbox is not live: the call waits, never made.
    runner = makeRunner({ mailboxLive: () => false, settleRecheckMs: 5 });
    writer.write(input('mail:1'));
    writer.write(input('mail:2'));
    let first: number | undefined;
    void runner.untilSettled(ref).then((n) => { first = n; });
    let second: number | undefined;
    void runner.untilSettled({ slug: 'work', record_id: 'mail:2' }).then((n) => { second = n; });
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect([first, second]).toEqual([undefined, undefined]);
    writer.removeEmails('work', ['mail:1']);
    await vi.waitFor(() => expect(first).toBe(0));
    expect(second).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('ends at once when the runner is disposed, before any look again', async () => {
    store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    runner.dispose();
    // The call waits, never made; nothing looks again for a minute.
    runner = makeRunner({ mailboxLive: () => false, settleRecheckMs: 60_000 });
    writer.write(input('mail:1'));
    let told: number | undefined;
    void runner.untilSettled(ref).then((n) => { told = n; });
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(told).toBeUndefined();
    runner.dispose();
    await vi.waitFor(() => expect(told).toBe(0), { timeout: 200 });
  });
});

describe('a kind grown while its fact waits on the AI (§4.5)', () => {
  const receipt: MailFactTypeSpec = {
    id: 'custom_receipt_box', name: 'Receipt box', description: 'A receipt.', states: [], notices: [],
    variables: [{ name: 'merchant', kind: 'text', required: true }, { name: 'reference', kind: 'id', required: false }],
    identity: [['merchant', 'reference']],
  };

  it.each([
    ['answered', false],
    ['not read, background AI paused', true],
  ])('settles with the kind as it is now: its new required variable is missing, the fact incomplete — %s', async (_how, pause) => {
    store.saveCustomType(receipt);
    store.createTemplate({
      definition: shopTemplate({ type: 'custom_receipt_box', ai: { enabled: true, prompt: 'Read its reference.', slots: ['reference'], pool: 'free_only' } }),
      origin: { kind: 'owner' },
    });
    runner.dispose();
    writer.write(input('mail:1'));
    // The owner grows the kind while the call waits.
    store.saveCustomType({ ...receipt, variables: [...receipt.variables, { name: 'count', kind: 'number', required: true }] });
    answer = async () => ({ facts: [{ position: 0, values: { reference: 'A-1' } }] });
    paused = pause;
    runner = makeRunner();
    runner.kick();
    await runner.settled();
    const fact = onlyFact('mail:1');
    expect(fact.variables.count).toBeNull();
    expect(fact.missing).toContain('count');
    expect(fact.complete).toBe(false);
    expect(store.listThings()[0]).toMatchObject({ complete: false, missing: ['count'] });
  });
});

describe('an answer’s news and a vault sealed as it is placed (§4.3)', () => {
  it('sealed after the answer got room in the trigger queue, the fact’s news waits for the vault and starts its recipe', async () => {
    const bus = createWarehouseEventBus();
    const vault = { unlocked: true };
    const triggers = createEventTriggersStore(db);
    triggers.create({
      trigger_id: 't-ai', recipe_id: 'r-ai', publisher_id: 'local', pattern: 'data.mail_fact.purchase.thing.*',
      enabled: true, origin: 'user', created_at: 1, last_fired_at: null, last_error: null,
    } as never);
    const runRecipe = vi.fn(async () => ({ run_id: 'run-ai' }));
    // The owned preapproval driver, as the server composes it.
    const dispatcher = createEventTriggerDispatcher({
      bus, store: triggers, runtime: { runRecipe }, isVaultUnlocked: () => vault.unlocked, vaultPollMs: 5,
      getPreapprovalDriver: () => ({ captureTrigger: () => ({ kind: 'candidate' }) }) as never,
    });
    dispatcher.rebuild();
    runner.dispose();
    writer = createMailFactWriter({ store, emit: (event) => bus.emit(event), now: () => clock });
    store.createTemplate({ definition: shopTemplate(), origin: { kind: 'owner' } });
    answer = async () => ({ facts: [{ position: 0, values: { order_id: 'A-1' } }] });
    writer.write(input('mail:1'));
    runner = makeRunner({
      triggerRoom: async () => {
        await dispatcher.room();
        // Sealed as the answer is placed.
        queueMicrotask(() => { vault.unlocked = false; });
      },
    });
    runner.kick();
    await runner.settled();
    expect(onlyFact('mail:1')).toMatchObject({ variables: expect.objectContaining({ order_id: 'A-1' }) });
    expect(runRecipe).not.toHaveBeenCalled();
    vault.unlocked = true;
    await dispatcher.drained();
    expect(runRecipe).toHaveBeenCalledTimes(1);
    dispatcher.dispose();
  });
});
