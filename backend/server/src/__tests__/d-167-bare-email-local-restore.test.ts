/** D-167 — an address alias the model writes without its domain half still reaches the owner as the address,
 *  through the real egress seam: the plan, resolver, contact index and store the composition root wires.
 *
 *  ⛔ Found live (2026-11-19, D-406's thread check): 5 of 154 answers named the people "m1" and "m2" ("from m1 to
 *  m2"), and nothing restored them. A bare form the request itself holds as text, or a measure, stays as written. */

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

const DANA = 'dana.ortiz@harborline.example';
const ME = 'me@recued.example';
/** A `mail.read` result as the handler returns it: the headers marked as mail, so their addresses are aliased. */
const mailRead = { tool_name: 'mail.read', tier: 1, args: {}, status: 'ok',
  result: { status: 'read', hot_fields: { __entity: 'mail', from: DANA, to: [ME], subject: 'Dock 4 lease renewal' }, body: 'Can you confirm?' } };

/** One turn over that email: the model reads the address aliases it was sent and answers with `answer(from, to)`;
 *  returns what it was sent and the body the seam hands back. */
const turn = async (userMessage: string, answer: (from: string, to: string) => AIOutput) => {
  const db = new Database(':memory:');
  dbs.push(db);
  const store = createContactStore(db);
  const plan = createPiiEgressPlanForSession({
    ledgerStore: piiEgress.createSessionLedgerStore(),
    resolver: createMetaFieldPrivacyResolver({ getEntitySchemas: () => [], getEntityPrivacyTags: () => CANONICAL_PII_ENTITY_PRIVACY_TAGS }),
    getContactKnownValueIndex: createContactKnownValueIndexBuilder(() => store),
  }, 'bare-email-local-session', 'chat');
  let sent = '';
  const model: ExecuteChatAiCall = async (_manifest, input) => {
    sent = String(input['llm.prompt']);
    const headers = (JSON.parse(sent) as { prior_tool_calls: Array<{ result: { hot_fields: { from: string; to: string[] } } }> })
      .prior_tool_calls[0]!.result.hot_fields;
    return { body: answer(headers.from, headers.to[0]!) };
  };
  const out = await wrapExecuteAiCallForPii(model, plan)({} as IngredientManifest, {
    'llm.prompt': JSON.stringify({ user_message: userMessage, prior_tool_calls: [mailRead] }),
  });
  return { sent, out: out.body as AIOutput };
};

/** What the model wrote: the alias's local half alone. */
const bare = (alias: string): string => alias.split('@')[0]!;

describe('D-167 — an address alias written without its domain half', () => {
  it('⛔ reaches the owner as the address, in the reply and in a tool call', async () => {
    const { sent, out } = await turn('What came before this email in its thread?', (from, to) => ({
      response: `Nov 3 (from ${bare(from)} to ${bare(to)}): they asked to renew, and ${bare(to)} replied with 6%.`,
      events: [],
      tool_calls: [{ tool: 'mail.search', args: { query: `from ${bare(from)}` } }],
    }));
    // The model was shown aliases only.
    expect(sent).not.toContain(DANA);
    expect(sent).not.toContain(ME);
    expect(sent).toContain('m1@d1.invalid');
    expect(out.response).toBe(`Nov 3 (from ${DANA} to ${ME}): they asked to renew, and ${ME} replied with 6%.`);
    expect(out.tool_calls).toEqual([{ tool: 'mail.search', args: { query: `from ${DANA}` } }]);
  });

  it('⛔ stays as written when the owner wrote that bare form, and in a measure', async () => {
    // The owner's "M1" holds `m1` back in any case, so its use stays as written; "80 m2" is a measure, never an
    // address, and holds `m2` back too.
    const { out } = await turn('Is the M1 order in? The room is 80 m2.', (from, to) => ({
      response: `${bare(from)} wrote about it and ${bare(to)} replied; the M1 order is in, for the 80 m2 room.`, events: [], tool_calls: [],
    }));
    expect(out.response).toBe('m1 wrote about it and m2 replied; the M1 order is in, for the 80 m2 room.');
  });
});
