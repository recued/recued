/** An email address or URL the owner writes reaches the model aliased, whether
 *  or not it is on file, and comes back as written.
 *
 *  ⛔ D-167 step 3d aliased only values with a ledger anchor, so "email adam
 *  (adam-not-in-db@aaa.com) the doc https://docs.example.org/d/1AbC/edit" went to
 *  the model as typed: the address, and a document id in the URL's path. Owner
 *  decision 2026-10-24: both shapes are unambiguous, so both are aliased — the
 *  address as `mN@dN.invalid`, a URL on a host the ledger does not hold WHOLE as
 *  `pii.UrlN`.
 *
 *  Through the real egress and restore seam (`wrapExecuteAiCallForPii`). */

import { type AIOutput, type IngredientManifest } from '@recued/contracts';
import { piiEgress } from '@recued/gateway';
import { describe, expect, it } from 'vitest';

import { CANONICAL_PII_ENTITY_PRIVACY_TAGS } from '../canonical-pii-schemas.js';
import { createMetaFieldPrivacyResolver } from '../meta-field-privacy-resolver.js';
import { wrapExecuteAiCallForPii, type PiiEgressPlan } from '../chat-pii-egress.js';
import type { ExecuteChatAiCall } from '../chat-orchestrator.js';

const MANIFEST = {} as IngredientManifest;
const ADDRESS = 'adam-not-in-db@aaa.com';
const DOC = 'https://docs.example.org/d/1AbC9xYz/edit?usp=sharing';

const makePlan = (): PiiEgressPlan => ({
  active: true,
  ledger: piiEgress.createSessionLedgerStore().getOrCreate('s'),
  resolver: createMetaFieldPrivacyResolver({
    getEntitySchemas: () => [],
    getEntityPrivacyTags: () => CANONICAL_PII_ENTITY_PRIVACY_TAGS,
  }),
  summary: { value: { mode: 'alias', scope_kind: 'session', counts: {} } },
});

describe('an address or URL the owner writes, not on file', () => {
  it('⛔ reaches the model aliased, and the reply and the send restore to what the owner wrote', async () => {
    const plan = makePlan();
    const packets: string[] = [];
    const real: ExecuteChatAiCall = async (_manifest, input) => {
      const packet = String(input['llm.prompt']);
      packets.push(packet);
      // The model answers with the aliases it was shown, as it would.
      const { user_message } = JSON.parse(packet) as { user_message: string };
      const address = /m\d+@d\d+\.invalid/.exec(user_message)?.[0] ?? '';
      const link = /pii\.Url\d+/.exec(user_message)?.[0] ?? '';
      return {
        body: {
          response: `Sending ${link} to ${address}.`,
          events: [],
          tool_calls: [{ tool: 'bench/send-email', args: { to: address, body: `The doc: ${link}` } }],
        } satisfies AIOutput,
      };
    };
    const message = `Email adam (${ADDRESS}) the doc ${DOC}.`;
    const result = await wrapExecuteAiCallForPii(real, plan)(
      MANIFEST,
      { 'llm.prompt': JSON.stringify({ user_message: message }) },
    );
    const sent = JSON.parse(packets[0]!) as { user_message: string };
    expect(sent.user_message).toBe('Email adam (m1@d1.invalid) the doc pii.Url1.');
    for (const raw of [ADDRESS, 'aaa.com', 'docs.example.org', '1AbC9xYz']) {
      expect(packets[0]).not.toContain(raw);
    }
    const body = result.body as AIOutput;
    expect(body.response).toBe(`Sending ${DOC} to ${ADDRESS}.`);
    expect(body.tool_calls[0]!.args).toEqual({ to: ADDRESS, body: `The doc: ${DOC}` });
  });

  it('leaves a known person\'s name to the known-value passes, as before', async () => {
    const plan = makePlan();
    let packet = '';
    const real: ExecuteChatAiCall = async (_manifest, input) => {
      packet = String(input['llm.prompt']);
      return { body: { response: 'ok', events: [], tool_calls: [] } satisfies AIOutput };
    };
    // "adam" is no contact: a lone first name is not aliased by shape (no NER).
    await wrapExecuteAiCallForPii(real, plan)(MANIFEST, { 'llm.prompt': JSON.stringify({ user_message: 'Ask adam about it.' }) });
    expect(JSON.parse(packet).user_message).toBe('Ask adam about it.');
  });
});
