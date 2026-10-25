/** D-224 amendment (2026-10-24) — everything the egress derives from the owner's
 *  words reveals no more than the owner's message AS SENT, through the real seam:
 *  plan, resolver, whole-warehouse index and contact store as the composition root
 *  wires them.
 *
 *  ⛔ The three leaks this pins, all measured on the substrate bench while the
 *  message itself read `pii.Person1 at pii.Org1`:
 *    · the overlap tails on tool results were derived from the RAW message —
 *      `pii.Person1.sarah.chen`, `pii.Person1.sarah.chen.northwind@d1.invalid`
 *      (bench 175: 76 of 136 packets);
 *    · the pre-seed index listed the message word by word, and its ledger scan
 *      matched only whole values — `sarah: contact.search` (136 of 136);
 *    · a situation item's composed value (`Ilsa Varga · birthday`) went out raw in
 *      a turn's first packet, its part rendered before the contact part that
 *      taught the ledger the name (bench 391).
 *  And two found by the bench tasks written for the fix (2026-10-24):
 *    · a turn the prompt cache answered never crossed the egress, so the next
 *      turn's `chat_tail` carried its answer — the contact's address — raw (399);
 *    · a search hint quoted a word of the restored query (`No email holds
 *      "Quellmoor"`) the model had only ever seen as `pii.Org1` (398). */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import type { IngredientManifest } from '@recued/contracts';
import { piiEgress } from '@recued/gateway';
import type { EntityPromptPart } from '@recued/middleware';

import { CANONICAL_PII_ENTITY_PRIVACY_TAGS } from '../canonical-pii-schemas.js';
import type { ExecuteChatAiCall } from '../chat-orchestrator.js';
import { createPiiEgressPlanForSession, indexContextAsSent, wrapExecuteAiCallForPii } from '../chat-pii-egress.js';
import { createContactKnownValueIndexBuilder } from '../chat-recall-index.js';
import { createMetaFieldPrivacyResolver } from '../meta-field-privacy-resolver.js';
import { renderSituationPrefetch, SITUATION_PREFETCH_MIDDLEWARE_ID } from '../situations/prefetch.js';
import { createContactStore, type ManualUpsertInput } from '../storage/contact-store.js';

const dbs: Database.Database[] = [];
afterEach(() => { while (dbs.length > 0) dbs.pop()!.close(); });

const AT = Date.parse('2026-10-24T12:00:00.000Z');
const SARAH = { email: 'sarah.chen@northwind-traders.example', name: 'Sarah Chen', company: 'Northwind Traders' };
const DANA = { email: 'dana.reyes.bench9q2@northwind-bench-corp.example', name: 'Dana Reyes' };
const ILSA = { email: 'ilsa.varga@fernwick.example', name: 'Ilsa Varga' };

/** One request through the chat's egress seam over one contact store. Returns the
 *  packet the model was sent. `degraded`: the warehouse read throws. */
const world = (contacts: readonly ManualUpsertInput[], opts: { degraded?: boolean } = {}) => {
  const db = new Database(':memory:');
  dbs.push(db);
  const store = createContactStore(db);
  for (const contact of contacts) store.upsertManual(contact, AT);
  const shown = opts.degraded !== true ? store : new Proxy(store, {
    get: (target, key) => (key === 'listAllNamesAndCompanies'
      ? () => { throw new Error('vault locked'); }
      : Reflect.get(target, key)),
  });
  const send = async (packet: Record<string, unknown>, parts: readonly EntityPromptPart[] = []) => {
    const plan = createPiiEgressPlanForSession({
      ledgerStore: piiEgress.createSessionLedgerStore(),
      resolver: createMetaFieldPrivacyResolver({
        getEntitySchemas: () => [],
        getEntityPrivacyTags: () => CANONICAL_PII_ENTITY_PRIVACY_TAGS,
      }),
      getContactKnownValueIndex: createContactKnownValueIndexBuilder(() => shown),
    }, 'd-224-owner-words', 'chat');
    let sent = '';
    const model: ExecuteChatAiCall = async (_manifest, input) => {
      sent = String(input['llm.prompt']);
      return { body: { response: 'ok', events: [], tool_calls: [] } };
    };
    await wrapExecuteAiCallForPii(model, plan, undefined, parts)({} as IngredientManifest, {
      'llm.prompt': JSON.stringify(packet),
    });
    return { packet: JSON.parse(sent) as Record<string, unknown>, sent };
  };
  return { send };
};

const call = (tool_name: string, args: Record<string, unknown>, result: unknown) =>
  ({ tool_name, tier: 1, status: 'ok', args, result });
const mailFrom = (from: string) =>
  call('mail.search', { query: 'budget' }, { matches: [{ __entity: 'mail', from, to: ['owner@home.example'], subject: 'Q3 budget figures' }] });
const contactRecord = (contact: { email: string; name: string; company?: string }) =>
  call('contact.search', { query: 'budget' }, { candidates: [{ source: 'local', record: {
    __entity: 'contact', email: contact.email, target_id: contact.email, name: contact.name,
    ...(contact.company ? { company: contact.company } : {}),
  } }] });
/** The prompt-cache prefetch's contact block, as it renders. */
const contactPart = (contact: { email: string; name: string }): EntityPromptPart => ({
  source: 'prefetch', role: 'entity', entity: 'contact',
  payload: [{ name: contact.name, email: contact.email }],
  render: (payload) => payload.map((r) => `- ${String(r['name'])} (contact, ref: ${String(r['email'])})`).join('\n'),
});
/** The situation lookup's block for a contact's birthday, as `declaredOccasions`
 *  builds the item: titled by the contact's name, its people the contact's id. */
const birthdayPart = (contact: { email: string; name: string }): EntityPromptPart => {
  const evidence = [{ collection: 'contact', id: contact.email, field: 'birthday' }];
  const row = {
    ref: evidence[0], kind: 'birthday', cluster_id: 'c1',
    what: { value: `${contact.name} · birthday`, verdict: 'match', basis: 'declared', evidence },
    when: { value: { from: AT, to: AT + 86_400_000 }, verdict: 'match', basis: 'declared', evidence },
    where: { value: null, verdict: 'unknown', basis: 'declared', evidence },
    who: { value: [contact.email], verdict: 'unknown', basis: 'declared', evidence },
    reasons: [], basis: 'declared', evidence, consequence: 'routine', sphere: 'personal', updated_at: AT,
  };
  return {
    source: SITUATION_PREFETCH_MIDDLEWARE_ID, role: 'entity', entity: 'situation_item',
    payload: [row], render: (rows) => renderSituationPrefetch(rows, rows.length, false),
  };
};

describe('an overlap tail carries only words the owner\'s message still shows', () => {
  it('⛔ gives no tail for a name and company the message hides', async () => {
    const { send } = world([SARAH]);
    const { packet, sent } = await send({
      user_message: 'Sarah Chen at Northwind Traders emailed me the Q3 budget figures. Find that message.',
      prior_tool_calls: [mailFrom(SARAH.email), contactRecord(SARAH)],
    });
    expect(packet['user_message']).toBe('pii.Person1 at pii.Org1 emailed me the Q3 budget figures. Find that message.');
    // Was `pii.Person1.sarah.chen.northwind@d1.invalid` / `pii.Person1.sarah.chen` /
    // `pii.Org1.northwind.traders`.
    expect(sent).not.toMatch(/sarah|chen|northwind|traders/iu);
    expect(sent).toContain('"from":"pii.Person1@d1.invalid"');
    expect(sent).toContain('"name":"pii.Person1"');
    expect(sent).toContain('"company":"pii.Org1"');
  });

  it('⛔ gives no tail for an address the owner typed, so it has one spelling', async () => {
    const { send } = world([SARAH]);
    const { packet, sent } = await send({
      user_message: `What did ${SARAH.email} send me?`,
      prior_tool_calls: [contactRecord(SARAH), mailFrom(SARAH.email)],
    });
    expect(packet['user_message']).toBe('What did pii.Person1@d1.invalid send me?');
    expect(sent).not.toMatch(/sarah|chen|northwind|traders/iu);
    expect([...new Set(sent.match(/pii\.Person1[\w.-]*@d\d+\.invalid/gu))]).toEqual(['pii.Person1@d1.invalid']);
  });

  it('keeps the tail for a fragment the owner sent as typed (D-167)', async () => {
    const { send } = world([SARAH]);
    const { packet, sent } = await send({
      user_message: 'Did Sarah send the figures?',
      prior_tool_calls: [contactRecord(SARAH)],
    });
    expect(packet['user_message']).toBe('Did Sarah send the figures?');
    expect(sent).toContain('"name":"pii.Person1.sarah"');
    expect(sent).not.toMatch(/chen/iu);
  });

  it('keeps an address\'s tail for a company typed in the clear (D-224)', async () => {
    // No contact owns the address, so nothing aliases "Northwind" in the message.
    const { send } = world([]);
    const { packet, sent } = await send({
      user_message: 'Anything from Northwind this week?',
      prior_tool_calls: [mailFrom('orders@northwind-traders.example')],
    });
    expect(packet['user_message']).toBe('Anything from Northwind this week?');
    expect(sent).toContain('"from":"m1.northwind@d1.invalid"');
    expect(sent).not.toMatch(/orders|traders/iu);
  });
});

describe('the pre-seed index speaks the message\'s words as sent', () => {
  it('⛔ names a hidden name and address by the alias the message shows', async () => {
    const { send } = world([DANA]);
    const { packet, sent } = await send({
      user_message: `Did Dana Reyes send the budget? Her address is ${DANA.email}.`,
      index_context: 'dana reyes budget: mail.search; dana: contact.search; reyes: contact.search, recall.search; '
        + 'bench9q2: contact.search; northwind-bench-corp: mail.search; budget: memory.search',
    }, [contactPart(DANA)]);
    expect(packet['user_message']).toBe('Did pii.Person1 send the budget? Her address is pii.Person1@d1.invalid.');
    expect(packet['index_context']).toBe('pii.Person1 budget: mail.search; '
      + 'pii.Person1: contact.search, recall.search; pii.Person1@d1.invalid: contact.search, mail.search; '
      + 'budget: memory.search');
    expect(sent).not.toMatch(/dana|reyes|bench9q2|northwind/iu);
  });

  it('leaves a line whose words the message still shows exactly as it was', async () => {
    const { send } = world([DANA]);
    const line = 'thornfield renewal: mail.search; thornfield: contact.search';
    const { packet } = await send({ user_message: 'When is the Thornfield renewal?', index_context: line }, [contactPart(DANA)]);
    expect(packet['index_context']).toBe(line);
  });

  it('drops a term with no alias to stand for it, and a line left with nothing', () => {
    const hidden = { readable: 'Did            send it?', aliases: [] };
    expect(indexContextAsSent('dana: contact.search; send: mail.search', [hidden])).toBe('send: mail.search');
    expect(indexContextAsSent('dana: contact.search', [hidden])).toBeUndefined();
    // An entry that does not parse cannot be checked, so it is not sent.
    expect(indexContextAsSent('send mail.search', [hidden])).toBeUndefined();
  });

  it('keeps the framing and a coverage note as they were', () => {
    const owner = [{ readable: '           budget', aliases: [{ token: 'pii.Person1', real: 'Dana Reyes' }] }];
    expect(indexContextAsSent(
      'dana: contact.search (checked, not in: mail.search); reyes: contact.search; budget: mail.search'
        + ' — partial: only some stores are indexed.',
      owner,
    )).toBe('pii.Person1: contact.search (checked, not in: mail.search); budget: mail.search'
      + ' — partial: only some stores are indexed.');
  });
});

describe('a situation block is aliased against every contact before the owner\'s words are', () => {
  it('⛔ hides a birthday\'s name in the first packet, by the alias the contact block uses', async () => {
    const { send } = world([ILSA]);
    // The situation part renders first, as the chat contributes it.
    const { packet, sent } = await send(
      { user_message: 'Draft a short birthday note for Ilsa Varga.' },
      [birthdayPart(ILSA), contactPart(ILSA)],
    );
    expect(sent).not.toMatch(/ilsa|varga|fernwick/iu);
    const blocks = (packet['prefetch_context'] as string[]).join('\n');
    const person = /- (pii\.Person\d+) \(contact/u.exec(blocks)?.[1];
    expect(person).toBeDefined();
    expect(blocks).toContain(`"value":"${person} · birthday"`);
    expect(packet['user_message']).toBe(`Draft a short birthday note for ${person}.`);
  });

  it('⛔ hides a contact the owner never named', async () => {
    const { send } = world([ILSA]);
    const { packet, sent } = await send({ user_message: 'Any birthdays coming up?' }, [birthdayPart(ILSA)]);
    expect(sent).not.toMatch(/ilsa|varga|fernwick/iu);
    expect((packet['prefetch_context'] as string[]).join('\n')).toMatch(/"value":"pii\.Person\d+ · birthday"/u);
    expect(packet['user_message']).toBe('Any birthdays coming up?');
  });

  it('drops the block when the warehouse cannot be read', async () => {
    const { send } = world([ILSA], { degraded: true });
    const { packet, sent } = await send({ user_message: 'Any birthdays coming up?' }, [birthdayPart(ILSA)]);
    expect(packet['prefetch_context']).toBeUndefined();
    expect(sent).not.toMatch(/ilsa|varga|fernwick/iu);
  });
});

describe('an earlier assistant turn is aliased against every contact', () => {
  const JUNO = { email: 'juno.farrell@pellmarsh.example', name: 'Juno Farrell' };
  /** A first turn the prompt cache answered from the warehouse: no model call, so
   *  nothing in it ever reached the egress or the ledger. */
  const cacheAnswered = [
    { role: 'user', content: "What is Juno Farrell's email address?" },
    { role: 'assistant', content: "Juno Farrell's email address is juno.farrell@pellmarsh.example." },
  ];
  const tailOf = (packet: Record<string, unknown>) => packet['chat_tail'] as Array<{ content: string }>;

  it('⛔ hides a cache answer in the next turn, when nothing else teaches the ledger', async () => {
    const { send } = world([JUNO]);
    const { packet, sent } = await send({ chat_tail: cacheAnswered, user_message: 'Draft a short thank-you note to her.' });
    expect(sent).not.toMatch(/juno|farrell|pellmarsh/iu);
    expect(tailOf(packet)[1]!.content).toBe("pii.Person1's email address is pii.Person1@d1.invalid.");
    // The name the answer taught is hidden in the owner's own words too.
    expect(tailOf(packet)[0]!.content).toBe("What is pii.Person1's email address?");
    expect(packet['pii_notice']).toBeDefined();
  });

  it('aliases an address no contact owns', async () => {
    const { send } = world([]);
    const { packet } = await send({
      chat_tail: [{ role: 'assistant', content: 'It came from orders@quarry-bench.example.' }],
      user_message: 'Thanks.',
    });
    expect(tailOf(packet)[0]!.content).toBe('It came from m1@d1.invalid.');
  });

  it('withholds the turn when the warehouse cannot be read', async () => {
    const { send } = world([JUNO], { degraded: true });
    const { packet, sent } = await send({ chat_tail: cacheAnswered, user_message: 'Draft a short thank-you note to her.' });
    expect(tailOf(packet)[1]!.content).toMatch(/^withheld:/u);
    expect(sent).not.toMatch(/pellmarsh/iu);
  });

  it('leaves the owner\'s own turns to the content pass', async () => {
    // Nothing the assistant said names anyone, so the ledger learns nothing and the
    // owner's typed name goes as written, as their message would (D-167 N.10.2 ②).
    const { send } = world([JUNO]);
    const { packet } = await send({
      chat_tail: [{ role: 'user', content: 'Tell me about Juno Farrell.' }, { role: 'assistant', content: 'Looking into it.' }],
      user_message: 'Thanks.',
    });
    expect(tailOf(packet)[0]!.content).toBe('Tell me about Juno Farrell.');
  });
});

describe('a quoted word of a hidden value in a tool\'s own words reads as its alias', () => {
  const ORRIN = { email: 'orrin.vass@quellmoor-bench.example', name: 'Orrin Vass', company: 'Quellmoor Renewal' };
  const ORLA = { email: 'orla.pennwick@cardglen-bench.example', name: 'Orla Pennwick' };
  const mailHint = (query: string, hint: string) =>
    call('mail.search', { query }, { matches: [{ __entity: 'mail', from: 'news@elsewhere.example', subject: 'Renewal dates' }], hint });

  it('⛔ names the word of an aliased query by the alias the model searched by', async () => {
    // The handler was given the restored company and quoted the word no email holds.
    const { send } = world([ORRIN]);
    const { sent } = await send({
      user_message: 'Find Orrin Vass, then check for mail from their company about the renewal.',
      prior_tool_calls: [contactRecord(ORRIN), mailHint('Quellmoor Renewal',
        'No email holds "Quellmoor", so the results below match only the other words in the query. '
        + 'Do not answer as if they were about "Quellmoor".')],
    });
    expect(sent).not.toMatch(/quellmoor/iu);
    expect(sent).toMatch(/No email holds \\"pii\.Org1/u);
  });

  it('keeps a quoted word the owner\'s message still shows', async () => {
    const { send } = world([ORRIN]);
    const { sent } = await send({
      user_message: 'Find Orrin Vass, then check for mail from their company about the renewal.',
      prior_tool_calls: [contactRecord(ORRIN), mailHint('renewal', 'No email holds "renewal".')],
    });
    expect(sent).toContain('No email holds \\"renewal\\".');
  });

  it('names a closest spelling that is a word of a known name, and keeps what the owner typed', async () => {
    const { send } = world([ORLA]);
    const { sent } = await send({
      user_message: 'Any mail from Penwick?',
      prior_tool_calls: [contactRecord(ORLA), mailHint('Penwick',
        'No email holds "Penwick". "Pennwick" is in 3 emails. If that is who or what the owner meant, '
        + 'search again for "Pennwick", and begin your answer by telling the owner you read "Penwick" '
        + 'as "Pennwick": it may be a different name.')],
    });
    expect(sent).not.toMatch(/pennwick/iu);
    expect(sent).toContain('\\"pii.Person1\\" is in 3 emails');
    expect(sent).toContain('you read \\"Penwick\\" as \\"pii.Person1\\"');
  });
});
