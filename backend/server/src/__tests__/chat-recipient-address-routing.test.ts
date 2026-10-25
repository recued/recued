/** A person alias in an address argument is sent to that person's address.
 *
 *  ⛔ Bench 70 (2026-10-24, qwen3.7-plus): asked to email one of two contacts it
 *  saw as `pii.Person2 (contact, ref: pii.Person2@d2.invalid)`, the model sent
 *  `to: "pii.Person2"` — the person, not the address beside it — in 2 of 10 runs.
 *  Restored that is `to: Quinn Rivera`: the owner was asked to approve a send to a
 *  name, and it failed after they approved. The boundary now routes it to the one
 *  address the request showed for that person, before restore.
 *
 *  Through the real restore seam (`wrapExecuteAiCallForPii`): the packet the model
 *  is shown is aliased from real values, the model's tool call is restored. */

import {
  type AIOutput,
  type IngredientManifest,
} from '@recued/contracts';
import { piiEgress } from '@recued/gateway';
import { describe, expect, it } from 'vitest';

import { CANONICAL_PII_ENTITY_PRIVACY_TAGS } from '../canonical-pii-schemas.js';
import { createMetaFieldPrivacyResolver } from '../meta-field-privacy-resolver.js';
import {
  aliasEntityPayloadForEgress,
  wrapExecuteAiCallForPii,
  type PiiEgressPlan,
} from '../chat-pii-egress.js';
import type { ExecuteChatAiCall } from '../chat-orchestrator.js';

const MANIFEST = {} as IngredientManifest;
const QUINN = { name: 'Quinn Rivera', email: 'quinn.rivera@meridian.example' };
const DANA = { name: 'Dana Okonkwo', email: 'dana.okonkwo@okonkwo.example' };

const makePlan = (): PiiEgressPlan => ({
  active: true,
  ledger: piiEgress.createSessionLedgerStore().getOrCreate('s'),
  resolver: createMetaFieldPrivacyResolver({
    getEntitySchemas: () => [],
    getEntityPrivacyTags: () => CANONICAL_PII_ENTITY_PRIVACY_TAGS,
  }),
  summary: { value: { mode: 'alias', scope_kind: 'session', counts: {} } },
});

/** Seed `contacts`, show the model `message` (aliased on the way out), and
 *  return what the packet said and the args its one tool call dispatches with. */
const turn = async (
  contacts: ReadonlyArray<{ name: string; email: string }>,
  message: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ packet: string; args: Record<string, unknown> }> => {
  const plan = makePlan();
  aliasEntityPayloadForEgress(
    contacts.map((c) => ({ ...c, target_id: c.email, kind: 'contact' })),
    'contact',
    plan,
  );
  let packet = '';
  const real: ExecuteChatAiCall = async (_manifest, input) => {
    packet = String(input['llm.prompt']);
    return { body: { response: '', events: [], tool_calls: [{ tool, args }] } satisfies AIOutput };
  };
  const restored = await wrapExecuteAiCallForPii(real, plan)(
    MANIFEST,
    { 'llm.prompt': JSON.stringify({ user_message: message }) },
  );
  return {
    packet,
    args: (restored.body as AIOutput).tool_calls[0]!.args as Record<string, unknown>,
  };
};

describe('a person alias in an address argument', () => {
  it('⛔ is sent to the one address the request showed for that person', async () => {
    const r = await turn([QUINN], `Email Quinn Rivera at ${QUINN.email}.`, 'bench/send-email',
      { to: 'pii.Person1', subject: 'Canary test', body: 'It works.' });
    // The model was shown the person AND the address beside it.
    expect(r.packet).toContain('pii.Person1@d1.invalid');
    expect(r.packet).not.toContain(QUINN.email);
    expect(r.args).toEqual({ to: QUINN.email, subject: 'Canary test', body: 'It works.' });
  });

  it('routes each entry of a list, and leaves an address alias as the address it is', async () => {
    const r = await turn([QUINN, DANA], `Quinn Rivera (${QUINN.email}) and Dana Okonkwo (${DANA.email}).`,
      'bench/send-email', { to: 'pii.Person1', cc: ['PII.PERSON2', 'pii.Person1@d1.invalid'], body: 'Hi.' });
    expect(r.args['to']).toBe(QUINN.email);
    expect(r.args['cc']).toEqual([DANA.email, QUINN.email]);
  });

  it('routes a field named for an email, and leaves a name field the name', async () => {
    const r = await turn([QUINN], `Thank Quinn Rivera, ${QUINN.email}.`, 'recued-core/send-thank-you-email',
      { recipient_name: 'pii.Person1', recipient_email: 'pii.Person1', occasion: 'the canary' });
    expect(r.args).toEqual({ recipient_name: 'Quinn Rivera', recipient_email: QUINN.email, occasion: 'the canary' });
  });

  it('⛔ is left as sent when the request showed that person two addresses — the model must choose', async () => {
    const home = { name: QUINN.name, email: 'quinn.rivera@home.example' };
    const r = await turn([QUINN, home], `Quinn Rivera: ${QUINN.email} or ${home.email}.`, 'bench/send-email',
      { to: 'pii.Person1', body: 'Hi.' });
    expect(r.packet).toContain('pii.Person1@d1.invalid');
    expect(r.packet).toMatch(/pii\.Person1\.m\d+@d\d+\.invalid/);
    expect(r.args['to']).toBe('Quinn Rivera');
  });

  it('is left as sent when the request showed no address for that person', async () => {
    const r = await turn([QUINN], 'Email Quinn Rivera.', 'bench/send-email', { to: 'pii.Person1', body: 'Hi.' });
    expect(r.packet).not.toMatch(/@d\d+\.invalid/);
    expect(r.args['to']).toBe('Quinn Rivera');
  });

  it('touches no other argument: the person stays a name in the body', async () => {
    const r = await turn([QUINN], `Email Quinn Rivera at ${QUINN.email}.`, 'bench/send-email',
      { to: 'pii.Person1@d1.invalid', body: 'Hi pii.Person1, it works.' });
    expect(r.args).toEqual({ to: QUINN.email, body: 'Hi Quinn Rivera, it works.' });
  });

  it('leaves contact.search to its own routing (a name alias searches by name)', async () => {
    const r = await turn([QUINN], `Find Quinn Rivera, ${QUINN.email}.`, 'contact.search', { email: 'pii.Person1' });
    expect(r.args).toEqual({ query: 'Quinn Rivera' });
  });
});
