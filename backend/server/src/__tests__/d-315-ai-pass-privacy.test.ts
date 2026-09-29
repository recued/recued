/** D-315 §4.3, §9 — the AI pass is held to the chat's privacy standard (ruling
 *  30). The request the AI pass builds goes through the same private call the
 *  server composes, over the live resolver and a real contact store: it reaches
 *  the model aliased, the answer comes back mapped to real values, an alias the
 *  ledger never issued is refused, and an aliasing failure makes no call. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getMailFactBuiltinType, type MailFact, type MailTemplate } from '@recued/contracts';

import { CANONICAL_PII_CATALOG_MANIFESTS, CANONICAL_PII_ENTITY_PRIVACY_TAGS, CANONICAL_PII_ENTITY_SCHEMAS } from '../canonical-pii-schemas.js';
import type { ExecuteChatAiCall } from '../chat-orchestrator.js';
import { createContactKnownValueIndexBuilder } from '../chat-recall-index.js';
import { createLocalManifestStore } from '../ingredient-authoring/local-manifest-store.js';
import {
  answerValues,
  buildMailFactAiInput,
  fillFromAi,
  MAIL_FACT_AI_MANIFEST,
  mailFactAiFailure,
  type MailFactAiEmail,
} from '../mail-facts/ai-pass.js';
import { createMetaFieldPrivacyResolverFromLocalManifestStore } from '../meta-field-privacy-resolver.js';
import { createPrivateAiCall } from '../private-ai-call.js';
import { createContactStore, type ContactStore } from '../storage/contact-store.js';

let db: Database.Database;
let contacts: ContactStore;

beforeEach(() => {
  db = new Database(':memory:');
  contacts = createContactStore(db);
  contacts.upsertManual({ email: 'sarah.chen@acme.example', name: 'Sarah Chen', company: 'Acme Example' }, 1);
});

afterEach(() => {
  db.close();
});

const resolver = () => createMetaFieldPrivacyResolverFromLocalManifestStore(
  createLocalManifestStore(db),
  CANONICAL_PII_ENTITY_SCHEMAS,
  CANONICAL_PII_CATALOG_MANIFESTS,
  CANONICAL_PII_ENTITY_PRIVACY_TAGS,
);

const spec = getMailFactBuiltinType('lead')!;

const template = {
  template_id: 'mtpl_1',
  name: 'Website leads',
  type: 'lead',
  entrance: { conditions: [{ field: 'from', op: 'is', value: 'forms@site.example' }], variables: [] },
  rules: [],
  html: false,
  ai: { enabled: true, prompt: 'Leads from the website.', slots: ['name', 'data.company'], pool: 'free_only' },
  origin: { kind: 'owner' },
  active: true,
  revision: 1,
  health: { matched: 0, entered: 0, not_entered: 0 },
  created_at: 1,
  updated_at: 1,
} as unknown as MailTemplate;

const email: MailFactAiEmail = {
  from: 'forms@site.example',
  to: ['me@example.com'],
  cc: ['sarah.chen@acme.example'],
  subject: 'New lead',
  date: '2026-09-20T10:00:00.000Z',
  body_text: 'Sarah Chen of Acme Example asked for a quote. Write to sarah.chen@acme.example.',
};

const fact: MailFact = {
  fact_id: 'mfact_1',
  type: 'lead',
  template_id: 'mtpl_1',
  email: { slug: 'work', record_id: 'mail:1' },
  email_at: 1,
  position: 0,
  identity_keys: [],
  thing_id: null,
  variables: Object.fromEntries(spec.variables.map((variable) => [variable.name, null])),
  passes: {},
  data: null,
  missing: [],
  refused: [],
  complete: false,
  source_hash: 'h',
  revision: 1,
  created_at: 1,
  ai: { state: 'waiting', since: 1 },
};

/** The system prompt of the first call. */
const input0 = (sent: readonly string[]): string => JSON.parse(sent[0]!)['llm.system_prompt'] as string;

const request = (prompt = 'Leads from the website.') => buildMailFactAiInput(
  { ...template, ai: { ...template.ai, prompt } } as MailTemplate,
  spec,
  fact.email,
  email,
  [{ fact, fill: ['name', 'data.company'] }],
  'free',
  1,
);

describe('the AI pass through the chat’s privacy layer', () => {
  it('sends the email aliased, and maps the answer back before it is read', async () => {
    const sent: string[] = [];
    const execute: ExecuteChatAiCall = async (_manifest, input) => {
      const packet = JSON.stringify(input);
      sent.push(packet);
      // The model answers with what it was shown for her.
      const shown = JSON.parse(input['llm.prompt'] as string).prior_tool_calls[0].result.body_text as string;
      const person = /pii\.Person\d+/.exec(shown)?.[0];
      return { body: { facts: [{ position: 0, values: { name: person, 'data.company': 'Acme Example' } }] } };
    };
    const call = createPrivateAiCall({
      execute,
      resolver: resolver(),
      getContactKnownValueIndex: createContactKnownValueIndexBuilder(() => contacts),
    });

    const result = await call(MAIL_FACT_AI_MANIFEST, request(), { timeout_ms: 1_000 });

    expect(sent).toHaveLength(1);
    const packet = sent[0]!;
    // The contact's name and her address, wherever the email has them, never
    // reach the model; the aliases do.
    expect(packet).not.toContain('Sarah Chen');
    expect(packet).not.toContain('sarah.chen@acme.example');
    expect(packet).toMatch(/pii\.Person\d+/);
    // No alias-shaped literal of ours shares the numbering with real people.
    expect(input0(sent)).not.toMatch(/pii\.Person\d+|m\d+@d\d+\.invalid/);
    // The answer is mapped back: the real name, which the pass then stores.
    const values = answerValues(result.body)!;
    expect(values.get(0)).toMatchObject({ name: 'Sarah Chen' });
    const read = fillFromAi(spec, fact, ['name', 'data.company'], values.get(0), 5);
    expect(read.reading.variables.name).toBe('Sarah Chen');
    expect(read.ai).toMatchObject({ state: 'read', filled: ['name', 'data.company'] });
  });

  it('sends the people a template read aliased, and every copy of them in the email — a stranger too', async () => {
    const sent: string[] = [];
    const execute: ExecuteChatAiCall = async (_manifest, input) => {
      sent.push(JSON.stringify(input));
      return { body: { facts: [] } };
    };
    const call = createPrivateAiCall({
      execute,
      resolver: resolver(),
      getContactKnownValueIndex: createContactKnownValueIndexBuilder(() => contacts),
    });
    // Nobody the warehouse knows: only the template's reading makes her known.
    const read: MailFact = {
      ...fact,
      variables: { ...fact.variables, source: 'website', name: 'Priya Raman', email: 'priya.raman@mail.example', phone: '+14155550199' },
    };
    const body = 'Priya Raman asked for a quote. Call +14155550199 or write to priya.raman@mail.example.';
    await call(
      MAIL_FACT_AI_MANIFEST,
      buildMailFactAiInput(template, spec, fact.email, { ...email, cc: [], body_text: body }, [{ fact: read, fill: ['data.company'] }], 'free', 1),
      { timeout_ms: 1_000 },
    );
    const packet = sent[0]!;
    expect(packet).not.toContain('Priya Raman');
    expect(packet).not.toContain('priya.raman@mail.example');
    expect(packet).not.toContain('4155550199');
    // What names no person goes as it is, and the marker never reaches the model.
    expect(packet).toContain('website');
    expect(packet).not.toContain('__entity');
  });

  it('sends the owner’s own prompt as written, as the chat sends a message the owner typed', async () => {
    const sent: string[] = [];
    const execute: ExecuteChatAiCall = async (_manifest, input) => {
      sent.push(input['llm.prompt'] as string);
      return { body: { facts: [] } };
    };
    const call = createPrivateAiCall({
      execute,
      resolver: resolver(),
      getContactKnownValueIndex: createContactKnownValueIndexBuilder(() => contacts),
    });
    await call(MAIL_FACT_AI_MANIFEST, request('Sarah Chen answers these.'), { timeout_ms: 1_000 });
    const packet = JSON.parse(sent[0]!);
    expect(packet.user_message).toBe('Sarah Chen answers these.');
    // The email itself still goes aliased.
    const mail = packet.prior_tool_calls[0].result;
    expect(mail.body_text).not.toContain('Sarah Chen');
    expect(JSON.stringify(mail)).not.toContain('sarah.chen@acme.example');
  });

  it('refuses an alias the ledger never issued: mapping back leaves it, the guard catches it', async () => {
    const execute: ExecuteChatAiCall = async () => ({
      body: { facts: [{ position: 0, values: { name: 'pii.Person9', 'data.company': 'Acme Example' } }] },
    });
    const call = createPrivateAiCall({
      execute,
      resolver: resolver(),
      getContactKnownValueIndex: createContactKnownValueIndexBuilder(() => contacts),
    });
    const result = await call(MAIL_FACT_AI_MANIFEST, request(), { timeout_ms: 1_000 });
    const read = fillFromAi(spec, fact, ['name', 'data.company'], answerValues(result.body)!.get(0), 5);
    expect(read.reading.variables.name).toBeNull();
    expect(read.reading.refused).toContainEqual({ variable: 'name', reason: 'alias not restored' });
    expect(read.ai).toMatchObject({ filled: ['data.company'] });
  });

  it('makes no call when aliasing fails, and says so', async () => {
    let called = false;
    const execute: ExecuteChatAiCall = async () => {
      called = true;
      return { body: {} };
    };
    const call = createPrivateAiCall({
      execute,
      resolver: () => {
        throw new Error('the privacy tags could not be read');
      },
    });
    const error = await call(MAIL_FACT_AI_MANIFEST, request(), { timeout_ms: 1_000 }).catch((caught: unknown) => caught);
    expect(called).toBe(false);
    expect(error).toMatchObject({ code: 'chat_pii_privacy_failed' });
    expect(mailFactAiFailure(error)).toBe('the privacy layer could not protect this email, so no call was made');
  });
});
