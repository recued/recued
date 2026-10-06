import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { createMailWorkService, MAIL_WORK_MANIFEST } from '../mail-work-service.js';
import { mailFactAiCallThrough } from '../mail-facts/ai-pass.js';
import { createPrivateAiCall } from '../private-ai-call.js';
import { createMailWorkStore } from '../storage/mail-work-store.js';
import { createPreapprovalCodec } from '../storage/preapproval-codec.js';
import { createContactStore } from '../storage/contact-store.js';
import { createContactKnownValueIndexBuilder } from '../chat-recall-index.js';
import { createMetaFieldPrivacyResolverFromLocalManifestStore } from '../meta-field-privacy-resolver.js';
import { createLocalManifestStore } from '../ingredient-authoring/local-manifest-store.js';
import { CANONICAL_PII_CATALOG_MANIFESTS, CANONICAL_PII_ENTITY_PRIVACY_TAGS, CANONICAL_PII_ENTITY_SCHEMAS } from '../canonical-pii-schemas.js';
import type { CollectionRecord } from '@recued/contracts';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
it.each([undefined, null, '2026-10-01T10:00:00.000Z'])('keeps owner-context protocol keys through privacy processing with note time %s', async recorded => {
  const db = new Database(':memory:'); databases.push(db);
  const contacts = createContactStore(db);
  contacts.upsertManual({ email: 'owner@private.example', name: 'owner' }, 1);
  const resolver = createMetaFieldPrivacyResolverFromLocalManifestStore(createLocalManifestStore(db),
    CANONICAL_PII_ENTITY_SCHEMAS, CANONICAL_PII_CATALOG_MANIFESTS, CANONICAL_PII_ENTITY_PRIVACY_TAGS);
  const context = { title: 'Handover', desired_outcome: 'Explore', owner_notes: 'Ask owner first.', resolution_note: '',
    ...(recorded === undefined ? {} : { owner_notes_recorded_at_iso: recorded }) };
  const privateCall = createPrivateAiCall({ resolver, getContactKnownValueIndex: createContactKnownValueIndexBuilder(() => contacts),
    execute: async (_manifest, input) => {
      const packet = JSON.parse(String(input['llm.prompt']));
      const actual = packet.prior_tool_calls[0].result;
      expect(Object.keys(actual).sort()).toEqual(Object.keys(context).sort());
      expect(actual.owner_notes_recorded_at_iso).toBe(recorded);
      expect(actual.owner_notes).not.toContain('Ask owner');
      expect(actual.owner_notes).toContain('pii.Person');
      return { body: {} };
    },
  });
  await mailFactAiCallThrough(privateCall, MAIL_WORK_MANIFEST)({
    'llm.system_prompt': 'Read the source.', 'llm.output_format': 'json',
    'llm.prompt': JSON.stringify({ user_message: 'Review.', prior_tool_calls: [{
      tool_name: 'mail.work.owner_context', status: 'ok', args: {}, result: context, started_at: 1, completed_at: 2,
    }] }),
  }, { timeout_ms: 120_000 });
});
it('aliases attachment prose in document.read results while retaining the original file reference', async () => {
  const db = new Database(':memory:'); databases.push(db);
  const contacts = createContactStore(db);
  contacts.upsertManual({ email: 'sarah.chen@acme.example', name: 'Sarah Chen', company: 'Acme Example' }, 1);
  const resolver = createMetaFieldPrivacyResolverFromLocalManifestStore(createLocalManifestStore(db),
    CANONICAL_PII_ENTITY_SCHEMAS, CANONICAL_PII_CATALOG_MANIFESTS, CANONICAL_PII_ENTITY_PRIVACY_TAGS);
  const privateCall = createPrivateAiCall({ resolver, getContactKnownValueIndex: createContactKnownValueIndexBuilder(() => contacts),
    execute: async (_manifest, input) => {
      const packet = JSON.parse(String(input['llm.prompt']));
      const document = packet.prior_tool_calls[0].result;
      expect(JSON.stringify(packet)).not.toContain('sarah.chen@acme.example');
      expect(document.body).not.toContain('Sarah Chen');
      expect(document.file_ref).toBe('file:specification');
      return { body: { quote: document.body } };
    },
  });
  const result = await mailFactAiCallThrough(privateCall, MAIL_WORK_MANIFEST)({
    'llm.system_prompt': 'Read the attachment as evidence.',
    'llm.prompt': JSON.stringify({ user_message: 'Follow this work.', prior_tool_calls: [{
      tool_name: 'document.read', status: 'ok', args: { file_ref: 'file:specification' },
      result: { file_ref: 'file:specification', content_hash: 'source-hash', body: 'Sarah Chen withdrew the date. Contact sarah.chen@acme.example.', extraction_complete: false },
      started_at: 1, completed_at: 2,
    }] }), 'llm.output_format': 'json',
  }, { timeout_ms: 120_000 });
  expect(result).toEqual({ quote: 'Sarah Chen withdrew the date. Contact sarah.chen@acme.example.' });
});
it('restores echoed mail participants when a contact name matches the email local part', async () => {
  const db = new Database(':memory:'); databases.push(db);
  const contacts = createContactStore(db);
  contacts.upsertManual({ email: 'maya@client.test', name: 'Maya' }, 1);
  contacts.upsertManual({ email: 'owner@recued-bench.test', name: 'Owner' }, 1);
  const resolver = createMetaFieldPrivacyResolverFromLocalManifestStore(createLocalManifestStore(db),
    CANONICAL_PII_ENTITY_SCHEMAS, CANONICAL_PII_CATALOG_MANIFESTS, CANONICAL_PII_ENTITY_PRIVACY_TAGS);
  const body = 'Maya at maya@client.test asked owner@recued-bench.test for a feasibility review. No order is agreed.';
  const mail: CollectionRecord = { record_id: 'seed', source_id: 'rfc-seed', body_inline: body, size_bytes: body.length, received_at: 1, modified_at: 1,
    hot_fields: { from: 'maya@client.test', to: ['owner@recued-bench.test'], cc: [], subject: 'Pilot request', thread_id: 'thread', date: '2026-09-29T00:00:00Z' } };
  const privateCall = createPrivateAiCall({ resolver, getContactKnownValueIndex: createContactKnownValueIndexBuilder(() => contacts),
    execute: async (_manifest, input) => {
      const sent = JSON.stringify(input);
      expect(sent).not.toMatch(/maya|owner@recued-bench\.test|client\.test/iu);
      const packet = JSON.parse(String(input['llm.prompt']));
      const email = packet.prior_tool_calls.find((call: { tool_name: string }) => call.tool_name === 'core.mail.get').result;
      return { body: { review_format: 'source_actions_v2', claims: [{ id: 'f1', kind: 'request', basis: 'email', sources: [email.source], excerpt: { source: email.source, quote: email.body_text, state: 'current' } }], search_queries: [] } };
    },
  });
  const store = createMailWorkStore(db, createPreapprovalCodec(() => new Uint8Array(32).fill(19)));
  const service = createMailWorkService({ store, body: async () => body,
    registry: { get: () => ({ get: () => mail, list: () => [mail] }), list: () => [] },
    ai: mailFactAiCallThrough(privateCall, MAIL_WORK_MANIFEST),
  });
  const created = await service.create({ request_id: 'privacy-address-1234', email: { slug: 'work', record_id: 'seed' } });
  const reviewed = await service.review(created.work.id, created.work.revision);
  expect(reviewed.work.brief?.claims[0]?.text).toContain(body);
});
it('protects a known contact written as a non-ASCII address in the body and restores it exactly', async () => {
  const db = new Database(':memory:'); databases.push(db);
  const contacts = createContactStore(db);
  contacts.upsertManual({ email: 'jose@client.test', name: 'José' }, 1);
  contacts.upsertManual({ email: 'owner@recued-bench.test', name: 'Owner' }, 1);
  const resolver = createMetaFieldPrivacyResolverFromLocalManifestStore(createLocalManifestStore(db),
    CANONICAL_PII_ENTITY_SCHEMAS, CANONICAL_PII_CATALOG_MANIFESTS, CANONICAL_PII_ENTITY_PRIVACY_TAGS);
  const body = 'Please reply to josé@client.test with the revised scope.';
  const mail: CollectionRecord = { record_id: 'seed', source_id: 'rfc-seed', body_inline: body, size_bytes: body.length, received_at: 1, modified_at: 1,
    hot_fields: { from: 'jose@client.test', to: ['owner@recued-bench.test'], cc: [], subject: 'Scope', thread_id: 'thread', date: '2026-09-29T00:00:00Z' } };
  const privateCall = createPrivateAiCall({ resolver, getContactKnownValueIndex: createContactKnownValueIndexBuilder(() => contacts),
    execute: async (_manifest, input) => {
      expect(JSON.stringify(input)).not.toMatch(/jos[eé]|client\.test/iu);
      const packet = JSON.parse(String(input['llm.prompt']));
      const email = packet.prior_tool_calls.find((call: { tool_name: string }) => call.tool_name === 'core.mail.get').result;
      return { body: { review_format: 'source_actions_v2', claims: [{ id: 'f1', kind: 'request', basis: 'email', sources: [email.source], excerpt: { source: email.source, quote: email.body_text, state: 'current' } }], search_queries: [] } };
    },
  });
  const store = createMailWorkStore(db, createPreapprovalCodec(() => new Uint8Array(32).fill(19)));
  const service = createMailWorkService({ store, body: async () => body,
    registry: { get: () => ({ get: () => mail, list: () => [mail] }), list: () => [] },
    ai: mailFactAiCallThrough(privateCall, MAIL_WORK_MANIFEST),
  });
  const created = await service.create({ request_id: 'privacy-non-ascii-1234', email: { slug: 'work', record_id: 'seed' } });
  const reviewed = await service.review(created.work.id, created.work.revision);
  expect(reviewed.work.brief?.claims[0]?.text).toContain(body);
});
it('reconstructs from private current evidence after an owner correction, without recycling the previous AI claims', async () => {
  const db = new Database(':memory:'); databases.push(db);
  const contacts = createContactStore(db);
  contacts.upsertManual({ email: 'sarah.chen@acme.example', name: 'Sarah Chen', company: 'Acme Example' }, 1);
  const resolver = createMetaFieldPrivacyResolverFromLocalManifestStore(createLocalManifestStore(db),
    CANONICAL_PII_ENTITY_SCHEMAS, CANONICAL_PII_CATALOG_MANIFESTS, CANONICAL_PII_ENTITY_PRIVACY_TAGS);
  const body = 'Sarah Chen requests a quote. Contact sarah.chen@acme.example.';
  const mail: CollectionRecord = { record_id: 'seed', source_id: 'rfc-seed', body_inline: body, size_bytes: body.length, received_at: 1, modified_at: 1,
    hot_fields: { from: 'sarah.chen@acme.example', to: ['owner@example.com'], cc: [], subject: 'Sarah Chen quote', thread_id: 'thread', date: '2026-09-29T00:00:00Z' } };
  const sent: string[] = [];
  let clock = Date.parse('2026-10-01T10:00:00Z');
  const privateCall = createPrivateAiCall({ resolver, getContactKnownValueIndex: createContactKnownValueIndexBuilder(() => contacts),
    execute: async (_manifest, input) => {
      sent.push(JSON.stringify(input));
      const packet = JSON.parse(String(input['llm.prompt']));
      const email = packet.prior_tool_calls.find((call: { tool_name: string }) => call.tool_name === 'core.mail.get').result;
      return { body: { review_format: 'source_actions_v2', claims: [{ id: 'f1', kind: 'request', basis: 'email', sources: [email.source], excerpt: { source: email.source, quote: email.body_text, state: 'current' } }, ...(sent.length === 1 ? [{ id: 'q1', kind: 'question', text: 'Model-only unconfirmed hypothesis.', basis: 'inference', sources: [], targets: ['f1'] }] : [])], search_queries: [] } };
    },
  });
  const store = createMailWorkStore(db, createPreapprovalCodec(() => new Uint8Array(32).fill(19)));
  const service = createMailWorkService({ store, body: async () => body, now: () => clock,
    registry: { get: () => ({ get: () => mail, list: () => [mail] }), list: () => [] },
    ai: mailFactAiCallThrough(privateCall, MAIL_WORK_MANIFEST),
  });
  const created = await service.create({ request_id: 'privacy-review-1234', email: { slug: 'work', record_id: 'seed' }, goal: 'Prepare the quote.' });
  const noted = await service.update({ id: created.work.id, expected_revision: 1,
    owner_notes: 'Discuss scope with Sarah Chen at sarah.chen@acme.example.',
    resolution_note: 'Sarah Chen declined the earlier offer; the work is open again.' });
  const first = await service.review(noted.work.id, noted.work.revision);
  clock += 60_000;
  const correction = await service.update({ id: first.work.id, expected_revision: first.work.revision, owner_notes: 'Sarah Chen withdrew the quote request by phone.' });
  expect(correction.work.brief).toEqual(first.work.brief);
  const second = await service.review(correction.work.id, correction.work.revision);
  for (const [index, text] of sent.entries()) {
    const packet = JSON.parse(JSON.parse(text)['llm.prompt']);
    const owner = packet.prior_tool_calls.find((call: { tool_name: string }) => call.tool_name === 'mail.work.owner_context');
    expect(owner.result.owner_notes_recorded_at_iso).toBe(index === 0 ? '2026-10-01T10:00:00.000Z' : '2026-10-01T10:01:00.000Z');
  }
  expect(sent).toHaveLength(2);
  for (const packet of sent) {
    expect(packet).not.toContain('Sarah Chen'); expect(packet).not.toContain('sarah.chen@acme.example');
    expect(packet).toMatch(/pii\.Person\d+/);
  }
  expect(sent[1]).not.toContain('mail.work.previous_review');
  expect(first.work.brief?.claims[1]?.text).toContain('Model-only unconfirmed hypothesis');
  expect(sent[1]).not.toContain('Model-only unconfirmed hypothesis');
  expect(sent[1]).toContain('withdrew the quote request by phone');
  expect(sent[1]).toContain('mail_source_1');
  expect(second.work.brief?.claims[0]?.text).toContain('Sarah Chen');
  expect(second.work.brief?.claims[0]?.text).toContain('sarah.chen@acme.example');
});
