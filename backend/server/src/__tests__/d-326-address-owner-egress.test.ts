/** D-326 — an address is aliased together with the contact it belongs to, at the
 *  moment it is first aliased (as its domain always was), through the real egress
 *  seam: the plan, resolver, whole-warehouse index and contact store the composition
 *  root wires, over a session's rounds and turns.
 *
 *  ⛔ Each case is one the spelling rule (D-227) could not link: the address came
 *  first, the name only in prose, an address of a merged contact — and a person
 *  shown only inside an address must restore on its own, as the domain half does. */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import type { AIOutput, IngredientManifest } from '@recued/contracts';
import { piiEgress } from '@recued/gateway';

import { CANONICAL_PII_ENTITY_PRIVACY_TAGS } from '../canonical-pii-schemas.js';
import type { ExecuteChatAiCall } from '../chat-orchestrator.js';
import { createPiiEgressPlanForSession, wrapExecuteAiCallForPii } from '../chat-pii-egress.js';
import { createContactKnownValueIndexBuilder } from '../chat-recall-index.js';
import { createMetaFieldPrivacyResolver } from '../meta-field-privacy-resolver.js';
import { createContactStore } from '../storage/contact-store.js';

const dbs: Database.Database[] = [];
afterEach(() => { while (dbs.length > 0) dbs.pop()!.close(); });

type Call = { tool_name: string; result: unknown };
const mailHit = (from: string, snippet?: string): Call => ({
  tool_name: 'mail.search',
  result: { matches: [{ __entity: 'mail', from, to: ['me@home.test'], subject: 'Saturday plans', ...(snippet ? { snippet } : {}) }] },
});
const contactHit = (email: string): Call => ({
  tool_name: 'contact.search',
  result: { candidates: [{ source: 'local', record: { __entity: 'contact', email, target_id: email, name: 'Leo Marsh' } }] },
});

/** One session over one contact store: each `turn` is a fresh plan on the session's
 *  ledger, each `send` a round of that turn's tool loop. */
const session = (setup: (store: ReturnType<typeof createContactStore>) => void) => {
  const db = new Database(':memory:');
  dbs.push(db);
  const store = createContactStore(db);
  setup(store);
  const ledgerStore = piiEgress.createSessionLedgerStore();
  const turn = () => {
    const plan = createPiiEgressPlanForSession({
      ledgerStore,
      resolver: createMetaFieldPrivacyResolver({
        getEntitySchemas: () => [],
        getEntityPrivacyTags: () => CANONICAL_PII_ENTITY_PRIVACY_TAGS,
      }),
      getContactKnownValueIndex: createContactKnownValueIndexBuilder(() => store),
    }, 'd-326-session', 'chat');
    const send = async (calls: Call[], answer: (sent: string) => AIOutput = () => ({ response: 'ok', events: [], tool_calls: [] })) => {
      let sent = '';
      const model: ExecuteChatAiCall = async (_manifest, input) => {
        sent = String(input['llm.prompt']);
        return { body: answer(sent) };
      };
      const out = await wrapExecuteAiCallForPii(model, plan)({} as IngredientManifest, {
        'llm.prompt': JSON.stringify({
          user_message: 'Who wrote about Saturday?',
          prior_tool_calls: calls.map((c) => ({ ...c, tier: 1, args: {}, status: 'ok' })),
        }),
      });
      const packet = JSON.parse(sent) as { prior_tool_calls: Array<{ result: {
        matches?: Array<{ from: string; to: string[]; snippet?: string }>;
        candidates?: Array<{ record: { target_id: string } }>;
      } }> };
      return { packet, out: out.body as AIOutput };
    };
    return { send };
  };
  return { turn };
};

const LEO = { email: 'leo.marsh@gmail.com', name: 'Leo Marsh' };

describe('D-326 — an address carries the contact it belongs to, whichever the model meets first', () => {
  it('⛔ a mail sender seen before the contact carries that contact from the first round', async () => {
    const { send } = session((store) => store.upsertManual(LEO, 1)).turn();
    const first = (await send([mailHit(LEO.email)])).packet.prior_tool_calls[0]!.result.matches![0]!;
    expect(first.from).toBe('pii.Person1@d1.invalid');
    // The owner's own address is no contact: it stays opaque.
    expect(first.to).toEqual(['m2@d2.invalid']);
    const second = (await send([mailHit(LEO.email), contactHit(LEO.email)])).packet.prior_tool_calls;
    expect(second[0]!.result.matches![0]!.from).toBe('pii.Person1@d1.invalid');
    expect(second[1]!.result.candidates![0]!.record.target_id).toBe('pii.Person1@d1.invalid');
  });

  it('⛔ links the sender when the name is only in the snippet', async () => {
    const { send } = session((store) => store.upsertManual(LEO, 1)).turn();
    const hit = (await send([mailHit(LEO.email, 'Hi, it is Leo Marsh here, about Saturday')]))
      .packet.prior_tool_calls[0]!.result.matches![0]!;
    expect(hit.from).toBe('pii.Person1@d1.invalid');
    expect(hit.snippet).toBe('Hi, it is pii.Person1 here, about Saturday');
  });

  it('links an address merged into a contact to that contact, beside the contact\'s own', async () => {
    const { send } = session((store) => {
      store.upsertManual(LEO, 1);
      store.upsertManual({ email: 'old.leo@corp.test', name: 'L. Marsh' }, 1);
      store.setMergedInto([store.get('old.leo@corp.test')!], LEO.email, 2);
    }).turn();
    const calls = (await send([mailHit('old.leo@corp.test'), contactHit(LEO.email)])).packet.prior_tool_calls;
    expect(calls[0]!.result.matches![0]!.from).toBe('pii.Person1@d1.invalid');
    expect(calls[1]!.result.candidates![0]!.record.target_id).toBe('pii.Person1.m3@d3.invalid');
  });

  it('⛔ gives no address to a placeholder name or one common word', async () => {
    // `sales` is only `sales@acme.test`'s own local part (a reconciler placeholder);
    // `Will` is a word the automaton never seeds (B4). Neither is a person to link.
    const { send } = session((store) => {
      store.upsertManual({ email: 'sales@acme.test', name: 'sales' }, 1);
      store.upsertManual({ email: 'wb@acme.test', name: 'Will' }, 1);
    }).turn();
    const froms = (await send([mailHit('sales@acme.test'), mailHit('wb@acme.test')]))
      .packet.prior_tool_calls.map((c) => c.result.matches![0]!.from);
    expect(froms).toEqual(['m1@d1.invalid', 'm3@d1.invalid']);
  });

  it('⛔ restores the person shown only inside an address, in a later turn', async () => {
    const { turn } = session((store) => store.upsertManual(LEO, 1));
    await turn().send([contactHit(LEO.email)]);
    const { out } = await turn().send([mailHit(LEO.email)], (sent) => {
      const from = /"from":"([^"]+)"/u.exec(sent)![1]!;
      return { response: `It is from ${from.split('@')[0]} (${from}).`, events: [], tool_calls: [] };
    });
    expect(out.response).toBe('It is from Leo Marsh (leo.marsh@gmail.com).');
  });
});
