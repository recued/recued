/** D-227 — an address whose local part spells the contact's name keeps ONE
 *  person-linked alias through both passes of a packet and every round of a turn,
 *  and a tool call naming that alias restores to the address.
 *
 *  ⛔ The bug this pins (found driving `contact.read`): the entity-tag pass aliased
 *  `leo.marsh@gmail.com` to `pii.Person1@d1.invalid`; the recall pass then read
 *  that string LOWERCASED (`extractEmailRuns` canonicalizes), missed the
 *  case-sensitive already-alias guard, and aliased it again as a fresh address
 *  (`m2@d2.invalid`). The restore authority pruned the first pass's rows as
 *  unexposed, so every round minted new numbers, and a follow-up by the alias the
 *  model was shown was refused as "not in anything you have been given" until the
 *  tool budget ran out. Through the real plan, resolver, recall index and store. */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import type { AIOutput, IngredientManifest } from '@recued/contracts';
import { piiEgress } from '@recued/gateway';
import type { EntityPromptPart } from '@recued/middleware';

import { CANONICAL_PII_ENTITY_PRIVACY_TAGS } from '../canonical-pii-schemas.js';
import type { ExecuteChatAiCall } from '../chat-orchestrator.js';
import { createPiiEgressPlanForSession, wrapExecuteAiCallForPii } from '../chat-pii-egress.js';
import { createContactKnownValueIndexBuilder } from '../chat-recall-index.js';
import { createMetaFieldPrivacyResolver } from '../meta-field-privacy-resolver.js';
import { createContactStore } from '../storage/contact-store.js';

const dbs: Database.Database[] = [];
afterEach(() => { while (dbs.length > 0) dbs.pop()!.close(); });

/** One turn's egress seam, as the composition root wires it, over one person who
 *  may own several addresses. `typed`: the owner typed the name, so the prompt-cache
 *  prefetch registered the contact (by its first address) before any tool ran.
 *  `unowned`: no contact in the store owns the addresses. */
const turn = (emails: string | readonly string[], opts: { typed?: boolean; unowned?: boolean } = {}) => {
  const addresses = typeof emails === 'string' ? [emails] : emails;
  const db = new Database(':memory:');
  dbs.push(db);
  const store = createContactStore(db);
  if (opts.unowned !== true) {
    for (const email of addresses) store.upsertManual({ email, name: 'Leo Marsh' }, Date.parse('2026-10-23T12:00:00.000Z'));
  }
  const plan = createPiiEgressPlanForSession({
    ledgerStore: piiEgress.createSessionLedgerStore(),
    resolver: createMetaFieldPrivacyResolver({
      getEntitySchemas: () => [],
      getEntityPrivacyTags: () => CANONICAL_PII_ENTITY_PRIVACY_TAGS,
    }),
    getContactKnownValueIndex: createContactKnownValueIndexBuilder(() => store),
  }, 'd-227-recall-pass', 'chat');
  const shown: string[] = [];
  let reply: AIOutput = { response: 'ok', events: [], tool_calls: [] };
  const model: ExecuteChatAiCall = async (_manifest, input) => {
    shown.push(String(input['llm.prompt']));
    return { body: reply };
  };
  const prefetch: EntityPromptPart[] = opts.typed === true ? [{
    source: 'prefetch', role: 'entity', entity: 'contact',
    payload: [{ name: 'Leo Marsh', email: addresses[0] }],
    render: (payload) => payload.map((r) => `- ${String(r['name'])} (contact, ref: ${String(r['email'])})`).join('\n'),
  }] : [];
  const wrapped = wrapExecuteAiCallForPii(model, plan, undefined, prefetch);
  // A round of the tool loop: the search result the model reads, and what it answers.
  const round = async (answer?: AIOutput) => {
    if (answer !== undefined) reply = answer;
    const out = await wrapped({} as IngredientManifest, {
      'llm.prompt': JSON.stringify({
        user_message: opts.typed === true ? 'What is Leo Marsh\'s email?' : 'What is my uncle\'s email?',
        prior_tool_calls: [{
          tool_name: 'contact.search', tier: 1, args: { query: 'Leo Marsh' }, status: 'ok',
          result: { candidates: addresses.map((email) => ({ source: 'local', record: { __entity: 'contact', email, target_id: email, name: 'Leo Marsh' } })) },
        }],
      }),
    });
    const packet = JSON.parse(shown.at(-1)!) as {
      prefetch_context?: string;
      prior_tool_calls: Array<{ result: { candidates: Array<{ record: { email: string; target_id: string; name: string } }> } }>;
    };
    const records = packet.prior_tool_calls[0]!.result.candidates.map((c) => c.record);
    const ref = /ref: ([^)\s]+)/u.exec(packet.prefetch_context ?? '')?.[1];
    return { record: records[0]!, records, ref, out: out.body as AIOutput };
  };
  return { round };
};

const callWith = (target_id: string): AIOutput =>
  ({ response: '', events: [], tool_calls: [{ tool: 'contact.read', args: { target_id } }] });

describe('D-227 — a name-shaped address through the tag pass, the recall pass and the rounds', () => {
  it('⛔ keeps one person-linked alias across rounds', async () => {
    const { round } = turn('leo.marsh@gmail.com');
    const first = (await round()).record;
    const second = (await round()).record;
    expect(first).toEqual({ email: 'pii.Person1@d1.invalid', target_id: 'pii.Person1@d1.invalid', name: 'pii.Person1' });
    expect(second).toEqual(first);
  });

  it('⛔ restores a tool call naming it, as shown or lowercased', async () => {
    const { round } = turn('leo.marsh@gmail.com');
    const { record } = await round();
    for (const target_id of [record.target_id, record.target_id.toLowerCase()]) {
      const { out } = await round(callWith(target_id));
      expect(out.tool_calls).toEqual([{ tool: 'contact.read', args: { target_id: 'leo.marsh@gmail.com' } }]);
    }
  });

  it('⛔ restores the address in the answer the owner reads', async () => {
    // Before the fix the owner read "Leo's email is pii.person1@d1.invalid".
    const { round } = turn('leo.marsh@gmail.com');
    const { record } = await round();
    const { out } = await round({ response: `Leo's email is ${record.target_id}.`, events: [], tool_calls: [] });
    expect(out.response).toBe('Leo\'s email is leo.marsh@gmail.com.');
  });

  it('⛔ with the name typed, the prefetch and the search show one person in one spelling, and a tail still restores', async () => {
    // The owner's message reads `pii.Person1` too, so the search result takes no
    // overlap tail: until 2026-10-24 it read `pii.Person1.leo.marsh@d1.invalid`, the
    // name the message hid (D-224 amendment). Before D-227 the search showed
    // `m2@d2.invalid` beside the prefetch's `pii.Person1@d1.invalid`: two
    // placeholders for one address.
    const { round } = turn('leo.marsh@gmail.com', { typed: true });
    const { record, ref } = await round();
    expect(ref).toBe('pii.Person1@d1.invalid');
    expect(record.target_id).toBe('pii.Person1@d1.invalid');
    // A model may still write a tail; the base restores either way.
    for (const target_id of [ref!, 'pii.Person1.leo.marsh@d1.invalid']) {
      const { out } = await round(callWith(target_id));
      expect(out.tool_calls).toEqual([{ tool: 'contact.read', args: { target_id: 'leo.marsh@gmail.com' } }]);
    }
  });

  it('⛔ keeps the person on both addresses of one contact, and each holds and restores to itself', async () => {
    // Two addresses sharing `pii.Person1` would collapse to one ledger row; the later
    // one keeps the person by its own slot (D-326). Before the fix the link was
    // pruned every round, so it never held.
    const { round } = turn(['leo.marsh@gmail.com', 'leo.marsh@work.test']);
    const first = (await round()).records.map((r) => r.target_id);
    expect(first).toEqual(['pii.Person1@d1.invalid', 'pii.Person1.m2@d2.invalid']);
    expect((await round()).records.map((r) => r.target_id)).toEqual(first);
    for (const [shown, real] of [[first[0]!, 'leo.marsh@gmail.com'], [first[1]!, 'leo.marsh@work.test']]) {
      const { out } = await round(callWith(shown));
      expect(out.tool_calls).toEqual([{ tool: 'contact.read', args: { target_id: real } }]);
    }
  });

  it('links an address that spells no name by the contact it belongs to (D-326)', async () => {
    const { round } = turn('marsh.leo@gmail.com');
    const { record } = await round();
    expect(record.target_id).toBe('pii.Person1@d1.invalid');
    const { out } = await round(callWith(record.target_id));
    expect(out.tool_calls).toEqual([{ tool: 'contact.read', args: { target_id: 'marsh.leo@gmail.com' } }]);
  });

  it('leaves an address no contact owns, and whose spelling earns no one, as mN', async () => {
    const { round } = turn('marsh.leo@gmail.com', { unowned: true });
    const { record } = await round();
    expect(record.target_id).toBe('m1@d1.invalid');
    const { out } = await round(callWith(record.target_id));
    expect(out.tool_calls).toEqual([{ tool: 'contact.read', args: { target_id: 'marsh.leo@gmail.com' } }]);
  });
});
