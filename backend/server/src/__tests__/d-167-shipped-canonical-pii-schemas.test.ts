/** D-167 — shipped canonical/CRM schemas + entity privacy tags drive aliasing
 *  OUT OF THE BOX (the "PII lever ON by default" proof).
 *
 *  Before this, the chat-egress resolver and the enrichment-egress tag source
 *  only read `MetaField.privacy` tags from the per-pair `local_manifest` table,
 *  which is populated solely by a user installing a D-170 composition — so out
 *  of the box NOTHING was tagged and the alias pass was a byte-identical no-op.
 *  `CANONICAL_PII_ENTITY_SCHEMAS` plus `CANONICAL_PII_ENTITY_PRIVACY_TAGS` are
 *  the shipped default-on content; the boot wiring unions them into the
 *  resolvers. These tests prove SHIPPED (never installed) privacy declarations
 *  drive aliasing on enrichment, CRM chat operations, and entity-marked search
 *  fan-out over an EMPTY `local_manifest`, while the no-op invariant holds when
 *  the shipped set is omitted.
 */

import {
  assertEntitySchemaIngredientShape,
  type EnrichmentScope,
  type IngredientManifest,
  type PiiAliasableData,
} from '@recued/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  CANONICAL_PII_ENTITY_SCHEMAS,
  CANONICAL_PII_CATALOG_MANIFESTS,
  CANONICAL_PII_ENTITY_PRIVACY_TAGS,
} from '../canonical-pii-schemas.js';
import { createMetaFieldPrivacyResolverFromLocalManifestStore } from '../meta-field-privacy-resolver.js';
import { createEnrichmentPiiTagSourceFromLocalManifestStore } from '../housekeeping/enrichment-pii-tag-source.js';
import { wrapHousekeepingCtxForRecord } from '../housekeeping/enrichment-pii-egress.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';

const MANIFEST = {} as IngredientManifest;

/** An EMPTY local_manifest — the out-of-the-box state (no installed schemas). */
const emptyEnrichmentStore = { slugs: () => [], getEntitySchemas: () => [] };
const emptyChatStore = { slugs: () => [], getEntitySchemas: () => [], getManifest: () => null };

const makeCtx = (over: Partial<HousekeepingContext>): HousekeepingContext =>
  ({ enrichmentPiiTagSource: undefined, ...over }) as unknown as HousekeepingContext;

describe('D-167 shipped canonical/CRM PII schemas — default-on protection', () => {
  it('every shipped schema is structurally valid', () => {
    expect(CANONICAL_PII_ENTITY_SCHEMAS.length).toBeGreaterThanOrEqual(5);
    for (const schema of CANONICAL_PII_ENTITY_SCHEMAS) {
      expect(assertEntitySchemaIngredientShape(schema)).toEqual([]);
    }
    const shippedOperations = CANONICAL_PII_ENTITY_SCHEMAS.flatMap((schema) =>
      Object.values(schema.source_operations).map((operation) => operation.operation),
    );
    expect(shippedOperations).not.toContain('contact.search');
    expect(shippedOperations).not.toContain('deal.search');
  });

  // ── Enrichment egress (scope-keyed) — the always-on housekeeping path ──

  it('the enrichment tag source resolves email tags for every shipped scope WITHOUT an install', () => {
    const tagSource = createEnrichmentPiiTagSourceFromLocalManifestStore(
      emptyEnrichmentStore,
      CANONICAL_PII_ENTITY_SCHEMAS,
    );
    const scopes: EnrichmentScope[] = [
      'mail',
      'contact',
      'calendar',
      'connection.api.hubspot.contact',
      'connection.api.salesforce.contact',
    ];
    for (const scope of scopes) {
      const tags = tagSource(scope);
      expect(tags.some((t) => t.kind === 'email'), `scope ${scope} has an email tag`).toBe(true);
    }
    // Name coverage on the scopes that carry a person name (the enrichment
    // platform-reference snapshot projects a concatenated `name`). Proves the
    // CRM name fields are reachable on the enrichment path too, not just chat.
    for (const scope of ['contact', 'connection.api.hubspot.contact', 'connection.api.salesforce.contact'] as const) {
      expect(
        tagSource(scope).some((t) => t.kind === 'name' && t.path === 'name'),
        `scope ${scope} has a snapshot name tag`,
      ).toBe(true);
    }
    // Strong address identifiers — the structured `meta.mailing_address` snapshot
    // carries street + postal. Both CRM scopes must tag them `address` (the coarse
    // city/state/country stay visible per the accepted geo-reasoning tradeoff).
    for (const scope of ['connection.api.hubspot.contact', 'connection.api.salesforce.contact'] as const) {
      const tags = tagSource(scope);
      expect(
        tags.some((t) => t.kind === 'address' && t.path === 'mailing_address.address1'),
        `scope ${scope} tags the street (mailing_address.address1)`,
      ).toBe(true);
      expect(
        tags.some((t) => t.kind === 'address' && t.path === 'mailing_address.zip'),
        `scope ${scope} tags the postal code (mailing_address.zip)`,
      ).toBe(true);
    }
  });

  it('a shipped contact schema aliases a contact record on enrichment egress and restores the output', async () => {
    const egress: Array<Record<string, unknown>> = [];
    const llmWithMeta = vi.fn(async (_m: IngredientManifest, input: Record<string, unknown>) => {
      egress.push(input);
      return { result: { summary: `re: ${String(input['llm.data'])}` }, model_id: 'prov:m' };
    });
    const tagSource = createEnrichmentPiiTagSourceFromLocalManifestStore(
      emptyEnrichmentStore,
      CANONICAL_PII_ENTITY_SCHEMAS,
    );
    const ctx = makeCtx({ enrichmentPiiTagSource: tagSource, llmWithMeta });

    // A `data.contact` record (flat shape — email + name per canonical-shapes).
    const wrapped = wrapHousekeepingCtxForRecord(ctx, 'contact', {
      email: 'alice@acme.com',
      name: 'Alice Chen',
    });
    const out = await wrapped.llmWithMeta!(MANIFEST, {
      'llm.data': 'Alice Chen (alice@acme.com) asked about renewal',
      'llm.fields': ['summary'],
    });

    // Egress: the cloud model never saw the real identifiers.
    const sent = String(egress[0]['llm.data']);
    expect(sent).not.toContain('alice@acme.com');
    expect(sent).not.toContain('Alice Chen');
    expect(sent).toContain('m1@d1.invalid');
    expect(sent).toContain('pii.Person1');

    // Output: restored locally — the enrichment value sees real identifiers.
    expect((out.result as { summary: string }).summary).toContain('alice@acme.com');
    expect((out.result as { summary: string }).summary).toContain('Alice Chen');
  });

  it('a shipped mail schema aliases a hot_fields mail record on enrichment egress', async () => {
    const egress: Array<Record<string, unknown>> = [];
    const llm = vi.fn(async (_m: IngredientManifest, input: Record<string, unknown>) => {
      egress.push(input);
      return { category: String(input['llm.data']) };
    });
    const tagSource = createEnrichmentPiiTagSourceFromLocalManifestStore(
      emptyEnrichmentStore,
      CANONICAL_PII_ENTITY_SCHEMAS,
    );
    const ctx = makeCtx({ enrichmentPiiTagSource: tagSource, llm });

    // A `data.mail` CollectionRecord nests canonical fields under `hot_fields`.
    const wrapped = wrapHousekeepingCtxForRecord(ctx, 'mail', {
      hot_fields: { from: 'bob@acme.com', to: ['carol@acme.com'], subject: 'renewal' },
    });
    await wrapped.llm!(MANIFEST, {
      'llm.data': 'from bob@acme.com to carol@acme.com about renewal',
      'llm.fields': ['purpose'],
    });

    const sent = String(egress[0]['llm.data']);
    expect(sent).not.toContain('bob@acme.com');
    expect(sent).not.toContain('carol@acme.com');
    expect(sent).toContain('@d1.invalid'); // the addresses were aliased
  });

  // ── Chat egress — operation-keyed CRM ops + entity-keyed search fan-out ──

  const hasTag = (
    tags: readonly { path: string; kind: string }[],
    path: string,
    kind: string,
  ): boolean => tags.some((t) => t.path === path && t.kind === kind);

  const resolverWithEntityTags = () =>
    createMetaFieldPrivacyResolverFromLocalManifestStore(
      emptyChatStore,
      CANONICAL_PII_ENTITY_SCHEMAS,
      undefined,
      CANONICAL_PII_ENTITY_PRIVACY_TAGS,
    );

  it('a shipped HubSpot contact schema tags email AND both name fields of a real catalog-op result', () => {
    const resolver = createMetaFieldPrivacyResolverFromLocalManifestStore(
      emptyChatStore,
      CANONICAL_PII_ENTITY_SCHEMAS,
      CANONICAL_PII_CATALOG_MANIFESTS,
    );
    // The fully-qualified operation_id a connection MCP catalog actually surfaces
    // (per d-167-p5-resolver-index-e2e) — resolved via the shipped catalog
    // operation-id manifests, since hubspot-catalog isn't in local_manifest.
    const packet = {
      prior_tool_calls: [
        {
          tool_name: 'recued-core/hubspot.contact.read',
          result: {
            properties: {
              email: 'alice@acme.com',
              firstname: 'Alice',
              lastname: 'Chen',
              phone: '+14155550123',
              company: 'Acme',
            },
          },
        },
      ],
    } as unknown as PiiAliasableData;

    const tags = resolver(packet);
    const base = 'prior_tool_calls.0.result.properties';
    expect(hasTag(tags, `${base}.email`, 'email')).toBe(true);
    // The names the reviewer flagged — both must be tagged, not just email.
    expect(hasTag(tags, `${base}.firstname`, 'name')).toBe(true);
    expect(hasTag(tags, `${base}.lastname`, 'name')).toBe(true);
    expect(hasTag(tags, `${base}.phone`, 'phone')).toBe(true);
    expect(hasTag(tags, `${base}.company`, 'org')).toBe(true);
  });

  it('a shipped Salesforce contact schema tags email AND FirstName/LastName of a real catalog-op result', () => {
    const resolver = createMetaFieldPrivacyResolverFromLocalManifestStore(
      emptyChatStore,
      CANONICAL_PII_ENTITY_SCHEMAS,
      CANONICAL_PII_CATALOG_MANIFESTS,
    );
    // The fully-qualified Salesforce operation_id (resolved via shipped manifests).
    const packet = {
      prior_tool_calls: [
        {
          tool_name: 'recued-core/salesforce.contact.read',
          result: {
            Email: 'bob@acme.com',
            FirstName: 'Bob',
            LastName: 'Ng',
            Phone: '+14155550124',
            MobilePhone: '+14155550125',
          },
        },
      ],
    } as unknown as PiiAliasableData;

    const tags = resolver(packet);
    const base = 'prior_tool_calls.0.result';
    expect(hasTag(tags, `${base}.Email`, 'email')).toBe(true);
    expect(hasTag(tags, `${base}.FirstName`, 'name')).toBe(true);
    expect(hasTag(tags, `${base}.LastName`, 'name')).toBe(true);
    expect(hasTag(tags, `${base}.Phone`, 'phone')).toBe(true);
    expect(hasTag(tags, `${base}.MobilePhone`, 'phone')).toBe(true);
  });

  it('shipped contact entity tags cover EVERY candidate and confidence-shape contact.search re-embed', () => {
    const resolver = resolverWithEntityTags();
    // The chat surface's PRIMARY contact tool is the D-137 fan-out `contact.search`
    // (not `contact.list`/`read`), whose result is a `{ candidates: [{ record }] }`
    // envelope with confidence-shape re-embeds. P3 retires the per-operation
    // explicit paths; the P2 `__entity` marker now carries the bare contact tags
    // everywhere the same record appears.
    // `ChatContactCandidate` carries THREE identifiers: email, name, and
    // target_id — which IS the canonical email for local contacts.
    const alice = {
      __entity: 'contact',
      email: 'alice@acme.com',
      name: 'Alice Chen',
      target_id: 'alice@acme.com',
    };
    const bob = {
      __entity: 'contact',
      email: 'bob@acme.com',
      name: 'Bob Ng',
      target_id: 'bob@acme.com',
    };
    const packet = {
      prior_tool_calls: [
        {
          tool_name: 'contact.search',
          result: {
            candidates: [
              { record: alice },
              { record: bob },
            ],
            envelope: {
              shape: {
                top: alice,
                alternatives: [bob],
                close: [alice],
                candidates: [bob],
              },
            },
          },
        },
      ],
    } as unknown as PiiAliasableData;

    const tags = resolver(packet);
    const base = 'prior_tool_calls.0.result.candidates';
    expect(hasTag(tags, `${base}.0.record.email`, 'email')).toBe(true);
    expect(hasTag(tags, `${base}.0.record.name`, 'name')).toBe(true);
    // `target_id` IS the canonical email for local contacts — it must also be
    // tagged, else the same address egresses raw in a second field.
    expect(hasTag(tags, `${base}.0.record.target_id`, 'email')).toBe(true);
    // candidate[1] — proves the `[]` wildcard fans across ALL merged candidates
    // (the fan-out caps at MAX_LIMIT = 100), not just the first hit.
    expect(hasTag(tags, `${base}.1.record.email`, 'email')).toBe(true);
    expect(hasTag(tags, `${base}.1.record.name`, 'name')).toBe(true);
    expect(hasTag(tags, `${base}.1.record.target_id`, 'email')).toBe(true);
    const shapeBase = 'prior_tool_calls.0.result.envelope.shape';
    for (const path of [
      `${shapeBase}.top.email`,
      `${shapeBase}.top.name`,
      `${shapeBase}.top.target_id`,
      `${shapeBase}.alternatives.0.email`,
      `${shapeBase}.alternatives.0.name`,
      `${shapeBase}.alternatives.0.target_id`,
      `${shapeBase}.close.0.email`,
      `${shapeBase}.close.0.name`,
      `${shapeBase}.close.0.target_id`,
      `${shapeBase}.candidates.0.email`,
      `${shapeBase}.candidates.0.name`,
      `${shapeBase}.candidates.0.target_id`,
    ]) {
      expect(hasTag(tags, path, path.endsWith('.name') ? 'name' : 'email'), path).toBe(true);
    }
  });

  it('shipped deal entity tags cover deal.search owner re-embeds but NOT the deal title or vendor id', () => {
    const resolver = resolverWithEntityTags();
    // `ChatDealCandidate` carries no person email/name: `name` is the deal TITLE,
    // `target_id` a vendor id, and the only PII is `owner` (email when resolved).
    const deal = {
      __entity: 'deal',
      name: 'Acme Renewal Q3',
      target_id: 'hubspot_deal_42',
      owner: 'dana@acme.com',
      amount: 5000,
    };
    const packet = {
      prior_tool_calls: [
        {
          tool_name: 'deal.search',
          result: {
            candidates: [{ record: deal }],
            envelope: {
              shape: {
                top: deal,
                alternatives: [deal],
                close: [deal],
                candidates: [deal],
              },
            },
          },
        },
      ],
    } as unknown as PiiAliasableData;
    const tags = resolver(packet);
    const base = 'prior_tool_calls.0.result.candidates.0.record';
    expect(hasTag(tags, `${base}.owner`, 'email')).toBe(true);
    // The deal title + vendor target_id are NOT PII — they must stay untagged so
    // the agent still sees them (aliasing the title "Acme Renewal Q3" to "pii.Person1"
    // would corrupt a field the agent reasons over).
    expect(tags.some((t) => t.path === `${base}.name`)).toBe(false);
    expect(tags.some((t) => t.path === `${base}.target_id`)).toBe(false);
    const shapeBase = 'prior_tool_calls.0.result.envelope.shape';
    for (const path of [
      `${shapeBase}.top.owner`,
      `${shapeBase}.alternatives.0.owner`,
      `${shapeBase}.close.0.owner`,
      `${shapeBase}.candidates.0.owner`,
    ]) {
      expect(hasTag(tags, path, 'email'), path).toBe(true);
    }
    expect(tags.some((t) => t.path === `${shapeBase}.top.name`)).toBe(false);
    expect(tags.some((t) => t.path === `${shapeBase}.top.target_id`)).toBe(false);
  });

  it('unmarked contact.search candidates emit no operation-keyed tags after explicit paths are retired', () => {
    const resolver = resolverWithEntityTags();
    const packet = {
      prior_tool_calls: [
        {
          tool_name: 'contact.search',
          result: {
            candidates: [
              { record: { email: 'alice@acme.com', name: 'Alice Chen', target_id: 'alice@acme.com' } },
            ],
          },
        },
      ],
    } as unknown as PiiAliasableData;
    expect(resolver(packet).some((t) => t.path.includes('candidates'))).toBe(false);
  });

  it('the fully-qualified operation_id form requires the shipped catalog manifests (fallback is load-bearing)', () => {
    const packet = {
      prior_tool_calls: [
        {
          tool_name: 'recued-core/hubspot.contact.read',
          result: { properties: { email: 'alice@acme.com', firstname: 'Alice' } },
        },
      ],
    } as unknown as PiiAliasableData;

    // Shipped schemas but NO catalog manifests → operation_id not in the index → miss.
    const withoutManifests = createMetaFieldPrivacyResolverFromLocalManifestStore(
      emptyChatStore,
      CANONICAL_PII_ENTITY_SCHEMAS,
    );
    expect(withoutManifests(packet)).toEqual([]);

    // With the catalog manifests → the operation_id resolves → tags emitted.
    const withManifests = createMetaFieldPrivacyResolverFromLocalManifestStore(
      emptyChatStore,
      CANONICAL_PII_ENTITY_SCHEMAS,
      CANONICAL_PII_CATALOG_MANIFESTS,
    );
    expect(withManifests(packet).some((t) => t.kind === 'email')).toBe(true);
  });

  // ── No-op invariant — omitting the shipped set is byte-identical to before ──

  it('without the shipped set the enrichment tag source resolves no tags (no-op invariant)', () => {
    const tagSource = createEnrichmentPiiTagSourceFromLocalManifestStore(emptyEnrichmentStore);
    expect(tagSource('contact')).toEqual([]);
    expect(tagSource('connection.api.hubspot.contact')).toEqual([]);
  });

  it('without the shipped set the chat resolver tags nothing for the same catalog-op result', () => {
    const resolver = createMetaFieldPrivacyResolverFromLocalManifestStore(emptyChatStore);
    const packet = {
      prior_tool_calls: [
        {
          tool_name: 'hubspot-catalog.contact.read',
          result: { properties: { email: 'alice@acme.com' } },
        },
      ],
    } as unknown as PiiAliasableData;
    expect(resolver(packet)).toEqual([]);
  });
});
