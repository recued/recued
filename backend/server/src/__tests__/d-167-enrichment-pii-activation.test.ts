/** D-167 activation — the enrichment-producer PII tag source wired off the
 *  per-pair `local_manifest` table, driven end-to-end through the real seam.
 *
 *  Two slices already exist:
 *    - `enrichment-pii-egress.ts` (`485c6d6c`) — the per-record alias SEAM
 *      (`wrapHousekeepingCtxForRecord`), proven inert/no-op until a tag source
 *      is wired (`d-167-enrichment-pii-egress.test.ts`).
 *    - the chat resolver (`93fa73ba`) — proved a table-backed
 *      `MetaField.privacy` resolver reads installed schemas.
 *
 *  This file proves the LAST seam — the enrichment ACTIVATION:
 *  `createEnrichmentPiiTagSourceFromLocalManifestStore` maps a producer's
 *  `source_scope` to an installed entity schema's privacy-tagged fields, and the
 *  seam aliases the producer's LLM packet using the PRODUCTION resolver + a real
 *  `local_manifest` store (not a stub tag source). Coverage:
 *    - scope mapping (`data.<collection>` → `<collection>`, platform-reference
 *      verbatim, publisher-scoped `data.entity.*` skipped);
 *    - the flat-record path (contact / `ContactRecord`);
 *    - the `hot_fields`-enveloped path (mail / `CollectionRecord`) — the seam's
 *      `hot_fields.` fallback is what makes a canonical-mail schema actually fire;
 *    - the no-op invariant (empty table → `[]` → byte-identical) + memo refresh
 *      on install. */

import Database from 'better-sqlite3';
import type {
  EnrichmentScope,
  EntitySchemaIngredientInput,
  IngredientManifest,
} from '@recued/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLocalManifestStore } from '../ingredient-authoring/local-manifest-store.js';
import { createEnrichmentPiiTagSourceFromLocalManifestStore } from '../housekeeping/enrichment-pii-tag-source.js';
import { wrapHousekeepingCtxForRecord } from '../housekeeping/enrichment-pii-egress.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';

const MANIFEST = {} as IngredientManifest;

const cleanups: Array<() => void> = [];
const makeDb = (): Database.Database => {
  const db = new Database(':memory:');
  cleanups.push(() => db.close());
  return db;
};
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

// ── Installed privacy-tagged schemas (one row per composition) ──────────────

const manifest = (slug: string): IngredientManifest =>
  ({ slug, version: 1, name: slug, description: '', author: 'recued-core' }) as IngredientManifest;

/** Google-Contacts → `data.contact` (contributing_source). ContactRecord is
 *  flat (`email` / `name`), so the canonical `key` paths hit directly. */
const contactSchema = (): EntitySchemaIngredientInput => ({
  ingredient_id: 'google-contacts',
  wraps_vendor: 'google-contacts',
  entity_id: 'contact',
  scope: 'data.contact',
  projection_mode: 'contributing_source',
  schema_mode: 'static',
  target_id: { fields: ['email'], template: '{email}' },
  meta_fields: [
    { key: 'email', type: 'string', source_path: 'emailAddresses[0].value', privacy: 'email' },
    { key: 'name', type: 'string', source_path: 'names[0].displayName', privacy: 'name' },
    { key: 'interaction_count', type: 'number', source_path: 'meta.count' },
  ],
  source_operations: { read: { catalog: 'google-contacts', operation: 'contact.list' } },
});

/** Gmail → `data.mail` (canonical_mirror). The warehouse stores mail as a
 *  `CollectionRecord` with the canonical fields under a `hot_fields` envelope,
 *  so the seam's `hot_fields.` fallback is what resolves the `from` tag. */
const mailSchema = (): EntitySchemaIngredientInput => ({
  ingredient_id: 'gmail',
  wraps_vendor: 'gmail',
  entity_id: 'message',
  scope: 'data.mail',
  projection_mode: 'canonical_mirror',
  schema_mode: 'static',
  target_id: { fields: ['record_id'], template: '{record_id}' },
  meta_fields: [
    { key: 'from', type: 'string', source_path: 'headers.from', privacy: 'email' },
    { key: 'subject', type: 'string', source_path: 'headers.subject', privacy: 'content' },
  ],
  source_operations: { read: { catalog: 'gmail', operation: 'message.get' } },
});

/** HubSpot contact → `connection.api.hubspot.contact` (platform_reference). */
const hubspotContactSchema = (): EntitySchemaIngredientInput => ({
  ingredient_id: 'hubspot',
  wraps_vendor: 'hubspot',
  entity_id: 'contact',
  scope: 'connection.api.hubspot.contact',
  projection_mode: 'platform_reference',
  schema_mode: 'static',
  target_id: { fields: ['id'], template: 'contact_{id}' },
  meta_fields: [
    { key: 'email', type: 'string', source_path: 'properties.email', privacy: 'email' },
  ],
  source_operations: { read: { catalog: 'hubspot', operation: 'contact.read' } },
});

/** Publisher-scoped `data.entity.*` — NOT a canonical-collection enrichment
 *  scope; the resolver must skip it. */
const publisherScopedSchema = (): EntitySchemaIngredientInput => ({
  ingredient_id: 'acme/crm',
  wraps_vendor: 'acme',
  entity_id: 'lead',
  scope: 'data.entity.acme.crm.lead',
  projection_mode: 'platform_reference',
  schema_mode: 'static',
  target_id: { fields: ['id'], template: 'lead_{id}' },
  meta_fields: [{ key: 'email', type: 'string', source_path: 'email', privacy: 'email' }],
  source_operations: { read: { catalog: 'acme/crm', operation: 'lead.get' } },
});

const install = (db: Database.Database, slug: string, schema: EntitySchemaIngredientInput): void => {
  createLocalManifestStore(db).put({ manifest: manifest(slug), entity_schemas: [schema] });
};

const tagSourceOver = (db: Database.Database) =>
  createEnrichmentPiiTagSourceFromLocalManifestStore(createLocalManifestStore(db));

const makeCtx = (over: Partial<HousekeepingContext>): HousekeepingContext =>
  ({ ...over }) as unknown as HousekeepingContext;

// ── Scope mapping ───────────────────────────────────────────────────────────

describe('D-167 activation — createEnrichmentPiiTagSourceFromLocalManifestStore scope mapping', () => {
  it('maps a `data.contact` schema onto the `contact` enrichment scope', () => {
    const db = makeDb();
    install(db, 'google-contacts', contactSchema());
    const tags = tagSourceOver(db)('contact');

    // The canonical `key` paths are present for both privacy-tagged fields…
    expect(tags).toEqual(expect.arrayContaining([
      { path: 'email', kind: 'email' },
      { path: 'name', kind: 'name' },
    ]));
    // …the untagged `interaction_count` field contributes nothing.
    expect(tags.some((t) => t.path === 'interaction_count')).toBe(false);
  });

  it('strips the `data.` prefix: a `data.mail` schema maps onto `mail`', () => {
    const db = makeDb();
    install(db, 'gmail', mailSchema());
    const tags = tagSourceOver(db)('mail');

    expect(tags).toEqual(expect.arrayContaining([{ path: 'from', kind: 'email' }]));
    // `subject` is privacy `content` — it carries the canonical key path but its
    // role is text-to-scan, not a seed identifier (the seam skips content kinds).
    expect(tags).toEqual(expect.arrayContaining([{ path: 'subject', kind: 'content' }]));
  });

  it('keeps a platform-reference `connection.api.*` scope verbatim', () => {
    const db = makeDb();
    install(db, 'hubspot', hubspotContactSchema());
    const tags = tagSourceOver(db)('connection.api.hubspot.contact' as EnrichmentScope);

    // Both the vendor `source_path` and the canonical `key` are emitted (the
    // record shape decides which resolves at seed time).
    expect(tags).toEqual(expect.arrayContaining([
      { path: 'properties.email', kind: 'email' },
      { path: 'email', kind: 'email' },
    ]));
  });

  it('skips a publisher-scoped `data.entity.*` schema (no enrichment scope)', () => {
    const db = makeDb();
    install(db, 'acme/crm', publisherScopedSchema());
    const source = tagSourceOver(db);

    // It maps onto no closed enrichment-collection scope, so nothing leaks.
    expect(source('contact')).toEqual([]);
    expect(source('mail')).toEqual([]);
  });

  it('does not leak one scope’s tags into another', () => {
    const db = makeDb();
    install(db, 'google-contacts', contactSchema());
    const source = tagSourceOver(db);

    expect(source('contact').length).toBeGreaterThan(0);
    expect(source('mail')).toEqual([]);
    expect(source('calendar')).toEqual([]);
  });

  it('returns [] for every scope when the table is empty (no-op invariant)', () => {
    const db = makeDb();
    const source = tagSourceOver(db);

    expect(source('mail')).toEqual([]);
    expect(source('contact')).toEqual([]);
    expect(source('connection.api.hubspot.contact' as EnrichmentScope)).toEqual([]);
  });

  it('reads live: a fresh install (and an in-place tag change) reflects on the next call', () => {
    const db = makeDb();
    const source = tagSourceOver(db);
    expect(source('contact')).toEqual([]); // empty table

    // Install → reflected immediately (no cache to invalidate).
    install(db, 'google-contacts', contactSchema());
    expect(source('contact')).toEqual(expect.arrayContaining([{ path: 'email', kind: 'email' }]));

    // In-place overwrite of the SAME slug+version with a changed tag set (no
    // slug-set change) also reflects — the resolver reads live, so there is no
    // stale-tag window a slug-keyed memo would leave open.
    createLocalManifestStore(db).put({
      manifest: manifest('google-contacts'),
      entity_schemas: [
        {
          ...contactSchema(),
          meta_fields: [{ key: 'email', type: 'string', source_path: 'e', privacy: 'email' }],
        },
      ],
    });
    expect(source('contact').some((t) => t.kind === 'name')).toBe(false);
  });
});

// ── End-to-end through the real seam ────────────────────────────────────────

describe('D-167 activation — the wired tag source drives the per-record seam', () => {
  it('aliases a flat ContactRecord’s name + email in the producer’s LLM packet, restores the output', async () => {
    const db = makeDb();
    install(db, 'google-contacts', contactSchema());

    let egress: string | undefined;
    const llm = vi.fn(async (_m: IngredientManifest, input: Record<string, unknown>) => {
      egress = String(input['llm.data']);
      return { note: `re: ${egress}` }; // model echoes the (aliased) blob
    });
    const ctx = makeCtx({ enrichmentPiiTagSource: tagSourceOver(db), llm });

    // ContactRecord is flat — canonical `key` paths resolve directly.
    const record = { email: 'alice@acme.com', name: 'Alice Chen', interaction_count: 3 };
    const wrapped = wrapHousekeepingCtxForRecord(ctx, 'contact', record);
    const result = (await wrapped.llm!(MANIFEST, {
      'llm.data': 'note from Alice Chen <alice@acme.com> re: renewal',
    })) as { note: string };

    // Egress: the model saw only aliases.
    expect(egress).toContain('pii.Person1');
    expect(egress).toContain('m1@d1.invalid');
    expect(egress).not.toContain('Alice Chen');
    expect(egress).not.toContain('alice@acme.com');
    // Restore: the producer-visible output carries the real values again.
    expect(result.note).toContain('Alice Chen');
    expect(result.note).toContain('alice@acme.com');
    expect(result.note).not.toContain('pii.Person1');
  });

  it('aliases a CollectionRecord mail body via the hot_fields envelope fallback', async () => {
    const db = makeDb();
    install(db, 'gmail', mailSchema());

    let egress: string | undefined;
    const llm = vi.fn(async (_m: IngredientManifest, input: Record<string, unknown>) => {
      egress = String(input['llm.data']);
      return { summary: egress };
    });
    const ctx = makeCtx({ enrichmentPiiTagSource: tagSourceOver(db), llm });

    // Mail is stored as a CollectionRecord — `from` lives under `hot_fields`, so
    // the seed only resolves through the seam's `hot_fields.` fallback.
    const record = {
      record_id: 'm1',
      received_at: 0,
      hot_fields: { from: 'alice@acme.com', subject: 'Renewal' },
    };
    const wrapped = wrapHousekeepingCtxForRecord(ctx, 'mail', record);
    await wrapped.llm!(MANIFEST, {
      'llm.data': 'body: please contact alice@acme.com about the renewal',
    });

    // The sender email — read from `hot_fields.from` — is aliased in the body.
    expect(egress).toContain('m1@d1.invalid');
    expect(egress).not.toContain('alice@acme.com');
  });

  it('is a byte-identical no-op when nothing privacy-tagged is installed', () => {
    const db = makeDb(); // empty table
    const llm = vi.fn();
    const ctx = makeCtx({ enrichmentPiiTagSource: tagSourceOver(db), llm });

    // Empty table → tag source returns [] → the seam returns the ctx unchanged.
    expect(wrapHousekeepingCtxForRecord(ctx, 'mail', { hot_fields: { from: 'a@b.com' } })).toBe(ctx);
    expect(wrapHousekeepingCtxForRecord(ctx, 'contact', { email: 'a@b.com' })).toBe(ctx);
  });
});
