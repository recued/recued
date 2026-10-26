/** D-167 — a person alias the model writes without its `pii.` prefix still reaches
 *  the owner as the person's name, through the real egress seam: the plan,
 *  resolver, contact index and store the composition root wires.
 *
 *  ⛔ Found live (2026-10-25, the family-trip run): 5 of 11 answers named a
 *  traveller as "Person3", and the owner read "Person3's passport expires
 *  January 10". A bare form the request itself holds as text stays as written. */

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

const FAMILY = [{ email: 'daniel.okafor@example.com', name: 'Daniel Okafor' }, { email: 'samuel.bello@example.com', name: 'Samuel Bello' }];
const contactHit = (person: { email: string; name: string }) => ({
  tool_name: 'contact.search', tier: 1, args: {}, status: 'ok',
  result: { candidates: [{ source: 'local', record: { __entity: 'contact', email: person.email, target_id: person.email, name: person.name } }] },
});

/** One turn over the family's contacts: the model reads the aliases it was sent
 *  and answers with `answer(aliases)`; returns the body the seam hands back. */
const turn = async (userMessage: string, answer: (aliases: string[]) => AIOutput) => {
  const db = new Database(':memory:');
  dbs.push(db);
  const store = createContactStore(db);
  for (const person of FAMILY) store.upsertManual(person, 1);
  const plan = createPiiEgressPlanForSession({
    ledgerStore: piiEgress.createSessionLedgerStore(),
    resolver: createMetaFieldPrivacyResolver({ getEntitySchemas: () => [], getEntityPrivacyTags: () => CANONICAL_PII_ENTITY_PRIVACY_TAGS }),
    getContactKnownValueIndex: createContactKnownValueIndexBuilder(() => store),
  }, 'unprefixed-person-session', 'chat');
  let sent = '';
  const model: ExecuteChatAiCall = async (_manifest, input) => {
    sent = String(input['llm.prompt']);
    const names = (JSON.parse(sent) as { prior_tool_calls: Array<{ result: { candidates: Array<{ record: { name: string } }> } }> })
      .prior_tool_calls.map((call) => call.result.candidates[0]!.record.name);
    return { body: answer(names) };
  };
  const out = await wrapExecuteAiCallForPii(model, plan)({} as IngredientManifest, {
    'llm.prompt': JSON.stringify({ user_message: userMessage, prior_tool_calls: FAMILY.map(contactHit) }),
  });
  return { sent, out: out.body as AIOutput };
};

describe('D-167 — a person alias written without its prefix', () => {
  it('⛔ reaches the owner as the name, in the reply and in a tool call', async () => {
    const { sent, out } = await turn('Is the family ready for the Lisbon trip?', ([daniel, samuel]) => ({
      response: `${daniel!.replace('pii.', '')}'s passport expires January 10, and ${samuel!.replace('pii.', '')}'s on February 5.`,
      events: [],
      tool_calls: [{ tool: 'situation.query', args: { people: [samuel!.replace('pii.', '')] } }],
    }));
    // The model was shown aliases only.
    expect(sent).not.toContain('Daniel Okafor');
    expect(sent).toContain('pii.Person1');
    expect(out.response).toBe("Daniel Okafor's passport expires January 10, and Samuel Bello's on February 5.");
    expect(out.tool_calls).toEqual([{ tool: 'situation.query', args: { people: ['Samuel Bello'] } }]);
  });

  it('⛔ stays as written when the owner wrote that bare form', async () => {
    const { out } = await turn('Is Person1 on the trip?', ([daniel]) => ({
      response: `Person1 is not a contact; ${daniel} is.`, events: [], tool_calls: [],
    }));
    expect(out.response).toBe('Person1 is not a contact; Daniel Okafor is.');
  });
});
