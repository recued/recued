/** D-315 §6.1 — Draft with AI (ruling 21): one owner-started call on the email
 *  chosen. What it proposes is rules, checked as any template is, rule by rule;
 *  what cannot be used is dropped and named. The call itself goes through the
 *  chat's privacy layer (`d-315-ai-pass-privacy.test.ts` proves that seam). */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getMailFactBuiltinType, validateMailTemplateDefinition } from '@recued/contracts';

import { MAIL_FACT_AI_BODY_MAX_CHARS, type MailFactAiCall } from '../mail-facts/ai-pass.js';
import { makeMailFactRpcHandlers } from '../mail-facts/mail-fact-rpc-handler.js';
import type { MailFactSourceEmail } from '../mail-facts/rules-pass.js';
import { runRulesPass } from '../mail-facts/rules-pass.js';
import { draftFromAnswer, MAIL_TEMPLATE_DRAFT_SYSTEM_PROMPT, MailTemplateDraftError } from '../mail-facts/template-draft.js';
import type { BlobStore } from '../storage/blob-store.js';
import { createMailFactStore, type MailFactStore } from '../storage/mail-fact-store.js';
import type { WsClient } from '../ws-server.js';

const owner = { instance_id: 'webclient-1', client_kind: 'webclient' } as WsClient;
const shipment = getMailFactBuiltinType('shipment')!;
const specOf = (type: string) => getMailFactBuiltinType(type);

const ups: MailFactSourceEmail = {
  subject: 'UPS Update: On the way',
  body_text: 'Your parcel is on the way.\nTracking Number: 1Z999AA10123456784\nExpected: Oct 2, 2026',
  html: null,
  from_address: 'pkginfo@ups.com',
  from_name: 'UPS',
  headers: {},
  labels: [],
  relationships: [],
  attachments: [],
};

/** What a model answering well proposes for the UPS notice. */
const goodAnswer = () => ({
  type: 'shipment',
  name: 'UPS notices',
  entrance: {
    conditions: [{ field: 'from', op: 'is', value: 'pkginfo@ups.com' }, { field: 'subject', op: 'contains', value: 'UPS Update' }],
    variables: ['tracking_number'],
  },
  rules: [
    { target: { variable: 'carrier' }, source: 'from_name', find: { kind: 'whole' } },
    { target: { variable: 'tracking_number' }, source: 'body', find: { kind: 'after_label', label: 'Tracking Number:' } },
    { target: { variable: 'expected_at' }, source: 'body', find: { kind: 'after_label', label: 'Expected:' } },
    {
      target: { variable: 'state' },
      source: 'subject',
      find: { kind: 'keyword_map', cases: [{ contains: 'On the way', value: 'in_transit' }, { contains: 'Delivered', value: 'delivered' }] },
    },
  ],
});

describe('a draft from the AI’s answer', () => {
  it('is a whole template with the AI off, that reads the email it was drafted from', () => {
    const { definition, dropped } = draftFromAnswer(goodAnswer(), ups, undefined, specOf);
    expect(dropped).toEqual([]);
    expect(definition).toMatchObject({ type: 'shipment', name: 'UPS notices', html: false, ai: { enabled: false } });
    expect(validateMailTemplateDefinition(definition, shipment)).toEqual([]);
    const read = runRulesPass(definition, shipment, ups);
    expect(read.kind).toBe('facts');
    expect(read.kind === 'facts' && read.facts[0]!.variables).toMatchObject({
      carrier: 'UPS', tracking_number: '1Z999AA10123456784', expected_at: '2026-10-02', state: 'in_transit',
    });
  });

  it('drops what cannot be used, rule by rule, and names each', () => {
    const answer = goodAnswer();
    answer.entrance.conditions.push({ field: 'subject', op: 'domain_is', value: 'x' });
    answer.rules.push(
      { target: { variable: 'order_id' }, source: 'body', find: { kind: 'pattern', pattern: '(\\w+)-(\\d+)' } } as never,
      { target: { variable: 'parcel_colour' }, source: 'body', find: { kind: 'whole' } } as never,
      { target: { variable: 'merchant' }, source: 'body', find: { kind: 'after_label', label: 'Sold by pii.Org1' } } as never,
    );
    const { definition, dropped } = draftFromAnswer(answer, ups, undefined, specOf);
    expect(definition.rules).toHaveLength(4);
    expect(definition.entrance.conditions).toHaveLength(2);
    expect(dropped).toEqual(expect.arrayContaining([
      'the rule for merchant: it held a privacy alias, not a real value',
      expect.stringMatching(/^the rule for order id: .*exactly one capture group/),
      expect.stringMatching(/^the rule for parcel colour: .*not a variable of shipment/),
      expect.stringMatching(/^the subject condition: .*does not apply to subject/),
    ]));
  });

  it('drops a rule or a condition in a shape it cannot read, and keeps the rest', () => {
    const answer = goodAnswer();
    answer.entrance.conditions.push({ field: 'subject', op: 'contains' } as never);
    answer.rules.push(
      // A finder missing what it finds by.
      { target: { variable: 'order_id' }, source: 'body', find: { kind: 'after_label' } } as never,
      // No finder at all.
      { target: { variable: 'merchant' }, source: 'body' } as never,
    );
    const { definition, dropped } = draftFromAnswer(answer, ups, undefined, specOf);
    expect(definition.rules).toHaveLength(4);
    expect(definition.entrance.conditions).toHaveLength(2);
    expect(validateMailTemplateDefinition(definition, shipment)).toEqual([]);
    expect(dropped).toEqual(expect.arrayContaining([
      'the rule for order id: find is not a finder Recued knows, in the shape it takes',
      'the rule for merchant: written in a shape Recued cannot read',
      'a condition the AI wrote in a shape Recued cannot read',
    ]));
  });

  it('keeps an entrance the rules can meet: the sender’s address when no condition holds, the read variables', () => {
    const answer = goodAnswer();
    answer.entrance = { conditions: [{ field: 'from', op: 'is', value: 'pii.Person1@d1.invalid' }], variables: ['order_id'] };
    const { definition, dropped } = draftFromAnswer(answer, ups, undefined, specOf);
    expect(definition.entrance.conditions).toEqual([{ field: 'from', op: 'is', value: 'pkginfo@ups.com' }]);
    // order_id has no rule; the type's required variables a rule reads stand in.
    expect(definition.entrance.variables).toEqual(['carrier', 'tracking_number']);
    expect(dropped).toContain("the entrance's order id: has no rule that reads it from the email");
  });

  it('starts from the sender’s address when the AI names no condition, as the editor does', () => {
    const answer = goodAnswer();
    answer.entrance.conditions = [];
    const { definition } = draftFromAnswer(answer, ups, undefined, specOf);
    expect(definition.entrance.conditions).toEqual([{ field: 'from', op: 'is', value: 'pkginfo@ups.com' }]);
  });

  it('drops a pattern or condition that holds an alias escaped for a regex, and names each entrance variable it leaves out', () => {
    const answer = goodAnswer();
    answer.entrance.conditions.push({ field: 'from', op: 'matches', value: '^m1@d1\\.invalid$' } as never);
    answer.entrance.variables.push('parcel_colour', 'expected_at');
    answer.rules.push({ target: { data: 'buyer' }, source: 'body', find: { kind: 'pattern', pattern: 'pii\\.Person1 (\\w+)' } } as never);
    const { definition, dropped } = draftFromAnswer(answer, ups, undefined, specOf);
    expect(definition.entrance.conditions).toHaveLength(2);
    expect(definition.rules).toHaveLength(4);
    expect(dropped).toEqual(expect.arrayContaining([
      'the from condition: it held a privacy alias, not a real value',
      'the rule for data buyer: it held a privacy alias, not a real value',
      'the entrance\'s parcel colour: not a variable of shipment',
    ]));
    // A variable some rule reads stays; one left without a reading rule is named.
    expect(definition.entrance.variables).toEqual(['tracking_number', 'expected_at']);
  });

  it('takes the kind of email the owner picked, and refuses an answer it cannot use', () => {
    const answer = { ...goodAnswer(), type: 'bill' };
    expect(draftFromAnswer(answer, ups, shipment, specOf).definition.type).toBe('shipment');
    expect(() => draftFromAnswer({ ...goodAnswer(), type: 'parcel' }, ups, undefined, specOf)).toThrow(MailTemplateDraftError);
    expect(() => draftFromAnswer('not json', ups, undefined, specOf)).toThrow(MailTemplateDraftError);
  });
});

describe('mail_fact.template.draft', () => {
  let db: Database.Database;
  let store: MailFactStore;
  beforeEach(() => {
    db = new Database(':memory:');
    store = createMailFactStore(db);
  });
  afterEach(() => db.close());

  const handlers = (draftCall?: MailFactAiCall) => makeMailFactRpcHandlers({
    store,
    editor: { mailboxes: () => [], blobs: {} as BlobStore, standardsOff: () => new Set() },
    ...(draftCall !== undefined ? { draftCall } : {}),
  })!.handlers;

  const sample = {
    from: 'UPS <pkginfo@ups.com>',
    subject: ups.subject,
    body: ups.body_text,
  };

  it('drafts from a pasted email in one call, the email a tool result, and saves nothing', async () => {
    // §4.5 — a kind the owner made is one it may choose, with the data it names (§3.2).
    store.saveCustomType({
      id: 'custom_wine_club', name: 'Wine club box', description: 'A box from the wine club.',
      variables: [{ name: 'box_id', kind: 'id', required: true }], states: [], notices: [], identity: [['box_id']],
      data_fields: [{ path: 'bottles', kind: 'list', description: 'Each bottle in the box' }],
    });
    const call = vi.fn<MailFactAiCall>(async () => goodAnswer());
    const result = await handlers(call)['mail_fact.template.draft']({ source: { sample } }, owner);
    expect(call).toHaveBeenCalledTimes(1);
    const packet = JSON.parse(call.mock.calls[0]![0]['llm.prompt'] as string);
    expect(packet.prior_tool_calls[0]).toMatchObject({
      tool_name: 'core.mail.get',
      result: { __entity: 'mail', from: 'pkginfo@ups.com', subject: ups.subject },
    });
    const { types } = packet.prior_tool_calls[1].result;
    expect(types).toContainEqual(expect.objectContaining({
      type: 'custom_wine_club', name: 'Wine club box', data_fields: [{ path: 'bottles', kind: 'list', description: 'Each bottle in the box' }],
    }));
    expect(types).toContainEqual(expect.objectContaining({ type: 'purchase', data_fields: [{ path: 'items', kind: 'list', description: 'Line items.' }] }));
    expect(result.definition).toMatchObject({ type: 'shipment', ai: { enabled: false } });
    expect(store.listTemplates()).toEqual([]);
  });

  it('sends the model at most the capped body, and says it was cut', async () => {
    const call = vi.fn<MailFactAiCall>(async () => goodAnswer());
    const long = `${sample.body}\n${'Your parcel is on its way. '.repeat(2_500)}`;
    expect(long.length).toBeGreaterThan(MAIL_FACT_AI_BODY_MAX_CHARS);
    await handlers(call)['mail_fact.template.draft']({ source: { sample: { ...sample, body: long } } }, owner);
    const sent = JSON.parse(call.mock.calls[0]![0]['llm.prompt'] as string).prior_tool_calls[0].result;
    expect(sent.body_text).toHaveLength(MAIL_FACT_AI_BODY_MAX_CHARS);
    expect(sent.body_truncated).toBe(true);
    // A body within the cap goes whole, and is not marked.
    await handlers(call)['mail_fact.template.draft']({ source: { sample } }, owner);
    const whole = JSON.parse(call.mock.calls[1]![0]['llm.prompt'] as string).prior_tool_calls[0].result;
    expect(whole.body_text).toBe(sample.body);
    expect(whole).not.toHaveProperty('body_truncated');
  });

  it('sends the model the email read canonical, as every reader reads it (§9)', async () => {
    const call = vi.fn<MailFactAiCall>(async () => goodAnswer());
    await handlers(call)['mail_fact.template.draft']({
      source: { sample: { ...sample, from: '\uFF35\uFF30\uFF33 <pkginfo@ups.com>', subject: `\u200B${sample.subject}`, body: `\uFF34racking${sample.body}` } },
    }, owner);
    const sent = JSON.parse(call.mock.calls[0]![0]['llm.prompt'] as string).prior_tool_calls[0].result;
    expect(sent).toMatchObject({ from_name: 'UPS', subject: sample.subject, body_text: `Tracking${sample.body}` });
  });

  it('shows no alias-shaped example: the privacy layer would reserve it, and a real person would take the next slot (D-208)', () => {
    expect(MAIL_TEMPLATE_DRAFT_SYSTEM_PROMPT).not.toMatch(/pii\.Person\d+|m\d+@d\d+\.invalid/);
  });

  it('is refused on a security notice, and makes no call', async () => {
    const call = vi.fn<MailFactAiCall>(async () => goodAnswer());
    await expect(handlers(call)['mail_fact.template.draft']({
      source: { sample: { from: 'Shop <no-reply@shop.example>', subject: 'Your sign-in code', body: 'Your verification code is 123456.' } },
    }, owner)).rejects.toMatchObject({ code: 'forbidden' });
    expect(call).not.toHaveBeenCalled();
  });

  it('says why the AI could not draft it, and needs a model to call', async () => {
    const failing = vi.fn<MailFactAiCall>(async () => {
      throw Object.assign(new Error('x'), { code: 'AI_LLM_UNAVAILABLE' });
    });
    await expect(handlers(failing)['mail_fact.template.draft']({ source: { sample } }, owner))
      .rejects.toMatchObject({ code: 'unavailable', message: 'The AI could not draft it: no model was available in its pool.' });
    await expect(handlers()['mail_fact.template.draft']({ source: { sample } }, owner))
      .rejects.toMatchObject({ code: 'not_configured' });
    await expect(handlers(failing)['mail_fact.template.draft']({ source: { sample }, type: 'parcel' }, owner))
      .rejects.toMatchObject({ code: 'bad_request' });
  });
});
