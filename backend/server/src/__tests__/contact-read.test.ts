/** `contact.read` reads one address-book contact's full record, and `contact.search`
 *  candidates carry the phone and company. Through a real contact store and the handler
 *  table's own wrappers.
 *
 *  ⛔ THE ADDRESS BOOK ONLY: a CRM record is never read here, and never resolved to the
 *  owner's contact through its link (D-205). ⛔ What the model reads carries no link, no
 *  contact id and no internal key, and the privacy layer aliases its PII. */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import type { AIOutput, IngredientManifest } from '@recued/contracts';
import { piiEgress } from '@recued/gateway';

import { CANONICAL_PII_ENTITY_PRIVACY_TAGS } from '../canonical-pii-schemas.js';
import type { ExecuteChatAiCall } from '../chat-orchestrator.js';
import { wrapExecuteAiCallForPii, type PiiEgressPlan } from '../chat-pii-egress.js';
import { buildChatTier1Handlers } from '../chat-tool-handlers.js';
import { createMetaFieldPrivacyResolver } from '../meta-field-privacy-resolver.js';
import { createContactStore } from '../storage/contact-store.js';

const dbs: Database.Database[] = [];
afterEach(() => { while (dbs.length > 0) dbs.pop()!.close(); });

const NOW = Date.parse('2026-10-23T12:00:00.000Z');
const DAY = 86_400_000;

const ANA = {
  email: 'ana@castellanos.test',
  name: 'Ana Castellanos',
  phone: '+34600123456',
  company: 'Castellanos Properties',
  title: 'Managing partner',
  birthday: '--03-14',
  anniversary: '2012-06-02',
  relationship: 'family' as const,
  mailing_address: { address1: '12 calle mayor', city: 'madrid', state: 'madrid', zip: '28013', country: 'ES' },
};

type Reply = { ok: boolean; result: Record<string, unknown> };
/** A relationship and privacy marks are owner controls: only the owner's own client writes them. */
const OWNER = { origin_actor: 'user_self', origin_surface: 'client_rpc' } as const;
type Contact = Record<string, unknown>;

const world = (opts: { breakStore?: boolean; mirror?: Array<{ name: string; email: string; phone: string; company: string }> } = {}) => {
  const db = new Database(':memory:');
  dbs.push(db);
  const store = createContactStore(db);
  store.upsertManual(ANA, NOW - 30 * DAY, OWNER);
  const reader = opts.breakStore === true
    ? { ...store, get: () => { throw new Error('database is locked'); } }
    : store;
  const mirrorRows = (opts.mirror ?? []).map((m, i) => ({ target_id: `hubspot_contact_hs_${i}`, meta: m }));
  const handlers = buildChatTier1Handlers({
    getContactStore: () => reader,
    getCollectionRegistry: () => undefined,
    getAuditLog: () => undefined,
    getEnrichmentStore: () => undefined,
    getRecipeStore: () => ({ ids: () => [], get: () => null, getStored: () => null, listStored: () => [] }) as never,
    getExecutorConfig: () => ({ manifests: { get: () => null } }) as never,
    getExecuteRecipe: () => undefined,
    ...(opts.mirror !== undefined ? {
      getBoundCrmMirrorSources: () => [{ source_id: 'hubspot', scope: 'connection.api.hubspot.contact' }],
      getCrmRecordMirror: () => ({
        list: (_scope: string, q: { name_contains?: string; limit?: number }) => mirrorRows
          .filter((r) => q.name_contains === undefined || r.meta.name.toLowerCase().includes(q.name_contains.toLowerCase()))
          .slice(0, q.limit ?? 20),
      }),
    } : {}),
  } as never) as Record<string, (a: unknown, c: unknown) => Promise<unknown>>;
  const ctx = { channel: 'internal_function_call', session_id: 'S', turn_id: 'T' } as never;
  const call = async (tool: string, args: Record<string, unknown>): Promise<Reply> =>
    (await handlers[tool]!(args, ctx)) as Reply;
  const read = async (target_id: string): Promise<Reply['result']> => (await call('contact.read', { target_id })).result;
  return { store, call, read };
};

const link = (store: ReturnType<typeof createContactStore>) => store.linkPlatformId({
  canonical_email: ANA.email, vendor: 'hubspot', platform_id: '47291',
  state: 'confirmed', linked_at: NOW, linked_by: 'user:owner',
}, NOW);

describe('contact.read — one address-book contact', () => {
  it('reads what contact.search does not return, and where each value came from', async () => {
    const { read } = world();
    const result = await read('Ana@Castellanos.test');
    const [ana] = result.contacts as Contact[];
    // Said here, not in the catalog: only a record with such a date needs it.
    expect(result.hint).toBe('A date written --MM-DD has no known year.');
    expect(ana).toMatchObject({
      target_id: ANA.email,
      email: ANA.email,
      name: ANA.name,
      phone: ANA.phone,
      company: ANA.company,
      title: ANA.title,
      birthday: '--03-14',
      anniversary: '2012-06-02',
      relationship: 'family',
      mailing_address: ANA.mailing_address,
      first_seen_at: new Date(NOW - 30 * DAY).toISOString(),
    });
    // The owner typed every one of them.
    expect(ana!.sources).toEqual({
      name: 'typed by the owner',
      phone: 'typed by the owner',
      company: 'typed by the owner',
      title: 'typed by the owner',
      birthday: 'typed by the owner',
      mailing_address: 'typed by the owner',
    });
  });

  it('⛔ follows a merge to the contact that survived it', async () => {
    const { store, read } = world();
    store.upsertManual({ email: 'ana.c@old-mail.test', name: 'Ana C' }, NOW - 60 * DAY);
    store.setMergedInto([store.get('ana.c@old-mail.test')!], ANA.email, NOW);
    const contacts = (await read('ana.c@old-mail.test')).contacts as Contact[];
    expect(contacts.map((c) => [c.target_id, c.name])).toEqual([[ANA.email, ANA.name]]);
  });

  it('⛔ never reads a CRM record, nor resolves one through its link to the contact', async () => {
    const { store, read } = world();
    link(store);
    for (const target_id of ['hubspot_contact_hs_47291', 'hubspot_contact_47291', '47291']) {
      const result = await read(target_id);
      expect(result.contacts).toEqual([]);
      expect(result.hint).toMatch(/A CRM record's target_id \(it starts with the CRM's name\) is not in the address book/u);
    }
  });

  it('⛔ carries no CRM link, contact id or internal key', async () => {
    const { store, read } = world();
    link(store);
    const contactId = store.get(ANA.email)!.contact_id;
    expect(contactId).toEqual(expect.any(String));
    const text = JSON.stringify(await read(ANA.email));
    for (const leak of ['47291', contactId!, 'platform_ids', 'contact_id', 'name_key', 'company_norm',
      'address_zip_country_key', 'rejected_pairs', 'personal_recipes', 'projection_provenance']) {
      expect(text).not.toContain(leak);
    }
  });

  it('reads a contact by its contact id, and a mention-only one with no email', async () => {
    const { store, read } = world();
    const mention = store.createMentionOnlyContact({ name: 'the cheese guy' }, NOW);
    const result = await read(mention.contact_id!);
    expect(result.contacts).toEqual([expect.objectContaining({ name: 'the cheese guy', email: null })]);
    // No mark and no partial date: nothing to add.
    expect(result.hint).toBeUndefined();
  });

  it('passes on the owner\'s privacy marks, and what they ask of the reader', async () => {
    const { store, read } = world();
    store.upsertManual({ email: 'leo@example.test', name: 'Leo Marsh', privacy_marks: ['deceased', 'former_partner'] }, NOW, OWNER);
    const result = await read('leo@example.test');
    expect(result.contacts).toEqual([
      expect.objectContaining({ name: 'Leo Marsh', privacy_marks: ['deceased', 'former_partner'] }),
    ]);
    expect(result.hint).toBe('The owner marked this contact deceased and former partner: do not suggest '
      + 'reaching out unless the owner asks.');
  });

  it('says when no contact has the target_id, and when the store could not be read', async () => {
    expect(await world().read('nobody@example.test')).toEqual({
      contacts: [],
      hint: expect.stringMatching(/^No contact in the owner's address book has this target_id\./u),
    });
    const broken = await world({ breakStore: true }).read(ANA.email);
    expect(broken.contacts).toEqual([]);
    expect(broken.partial).toBe(true);
    expect(broken.hint).toMatch(/^contact\.read did NOT finish/u);
  });

  it('refuses a call that names no target_id', async () => {
    expect((await world().call('contact.read', {})).ok).toBe(false);
  });
});

describe('contact.search — the phone and company come back', () => {
  it('from the address book and from a CRM mirror', async () => {
    const { call } = world({ mirror: [{ name: 'Thornbury Hale', email: 't@hale.test', phone: '+447700900123', company: 'Hale & Partners' }] });
    const local = (await call('contact.search', { query: 'Castellanos', limit: 5 })).result;
    expect((local.candidates as Array<{ record: Contact }>).map((c) => c.record)).toEqual([
      expect.objectContaining({ name: ANA.name, phone: ANA.phone, company: ANA.company }),
    ]);
    const crm = (await call('contact.search', { query: 'Thornbury', limit: 5 })).result;
    expect((crm.candidates as Array<{ record: Contact }>).map((c) => c.record)).toEqual([
      expect.objectContaining({ name: 'Thornbury Hale', phone: '+447700900123', company: 'Hale & Partners' }),
    ]);
  });
});

describe('what the model reads of a contact', () => {
  it('⛔ aliases the name, email, phone, company, street and postcode, and keeps the rest', async () => {
    const result = await world().read(ANA.email);
    const plan: PiiEgressPlan = {
      active: true,
      ledger: piiEgress.createSessionLedgerStore().getOrCreate('s'),
      resolver: createMetaFieldPrivacyResolver({
        getEntitySchemas: () => [],
        getEntityPrivacyTags: () => CANONICAL_PII_ENTITY_PRIVACY_TAGS,
      }),
      summary: { value: { mode: 'alias', scope_kind: 'session', counts: {} } },
    };
    let prompt = '';
    const model: ExecuteChatAiCall = async (_manifest, input) => {
      prompt = String(input['llm.prompt']);
      return { body: { response: 'ok', events: [], tool_calls: [] } satisfies AIOutput };
    };
    await wrapExecuteAiCallForPii(model, plan)({} as IngredientManifest, {
      'llm.prompt': JSON.stringify({
        user_message: 'When is her birthday?',
        prior_tool_calls: [{ tool_name: 'contact.read', args: { target_id: ANA.email }, result }],
      }),
    });
    expect(prompt).toContain('"birthday":"--03-14"');
    for (const raw of [ANA.email, ANA.name, ANA.phone, ANA.company, '12 calle mayor', '28013']) {
      expect(prompt).not.toContain(raw);
    }
    for (const kept of ['Managing partner', '"city":"madrid"', '"relationship":"family"']) {
      expect(prompt).toContain(kept);
    }
    expect(prompt).not.toContain('__entity');
  });
});
