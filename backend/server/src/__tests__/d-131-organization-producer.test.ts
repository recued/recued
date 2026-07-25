/** D-131 A.16 — `organization` producer tests.
 *
 *  Drives the standalone `organizationTask` against a real in-memory
 *  `data_enrichment` table + `contacts` fixture. Verifies:
 *   - Surface contract (topic / kind / is_ai_surface=false / token=0)
 *   - Pure helpers (id derivation / domain grouping / filter+cap /
 *     org assembly)
 *   - Contact scan + look-back window + free-mail filter + cap
 *   - Whole-cycle orchestration — happy path, min-contacts filter,
 *     cap enforcement
 *   - Stable derived_entity_id across runs
 *   - Sweep stale rows on cycle drift
 *   - Registry value_schema accept / reject
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ENRICHMENT_REGISTRY,
  type OrganizationValue,
} from '@recued/contracts';

import {
  ORGANIZATION_AUTHORED_BY,
  ORGANIZATION_TOPIC,
  ORGANIZATION_CONTACT_LOOKBACK_MS,
  ORGANIZATION_MAX_ORGS,
  ORGANIZATION_MIN_CONTACTS_PER_ORG,
  ORGANIZATION_TOKEN_ESTIMATE,
  assembleOrganization,
  deriveOrganizationId,
  filterAndCapOrgs,
  groupContactsByDomain,
  organizationScopeReadDeclaration,
  organizationTask,
  organizationTokenEstimate,
  runOrganizationCycle,
  scanRecentContactsForOrganization,
  sweepStaleOrganizations,
} from '../housekeeping/index.js';

import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';

// ────────────────────────────────────────────────────────────────
// Fixture infrastructure
// ────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;
const ONE_HOUR = 60 * 60 * 1000;
const ONE_DAY = 24 * ONE_HOUR;

let dir: string;
let db: Database.Database;
let store: EnrichmentStore;

const installContactsTable = (): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      email             TEXT PRIMARY KEY,
      name              TEXT,
      first_seen        INTEGER NOT NULL,
      last_interaction  INTEGER NOT NULL,
      interaction_count INTEGER NOT NULL DEFAULT 0,
      source            TEXT NOT NULL,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    );
  `);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-131-organization-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  installContactsTable();
  store = createEnrichmentStore(db);
});

afterEach(() => {
  store.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface InsertedContact {
  email: string;
  name?: string;
  first_seen?: number;
  last_interaction?: number;
  interaction_count?: number;
  source?: string;
}

const insertContact = (c: InsertedContact): void => {
  db.prepare(
    `INSERT INTO contacts (
       email, name, first_seen, last_interaction,
       interaction_count, source, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    c.email,
    c.name ?? null,
    c.first_seen ?? NOW - 30 * ONE_DAY,
    c.last_interaction ?? NOW,
    c.interaction_count ?? 1,
    c.source ?? 'mail',
    NOW,
    NOW,
  );
};

const buildCtx = (now: number = NOW): HousekeepingContext => ({
  db,
  bus: {
    emit: () => undefined,
    subscribe: () => () => undefined,
    dispose: () => undefined,
  } as never,
  enrichmentStore: store,
  recipeStore: {} as never,
  now: () => now,
  emitAuditRow: () => undefined,
});

// ────────────────────────────────────────────────────────────────
// Surface contract
// ────────────────────────────────────────────────────────────────

describe('organizationTask surface contract', () => {
  it('targets the organization registry topic', () => {
    expect(organizationTask.topic).toBe('organization');
  });

  it('declares is_ai_surface=false (deterministic)', () => {
    expect(organizationTask.is_ai_surface).toBe(false);
  });

  it('declares meta.kind=enrichment', () => {
    expect(organizationTask.meta.kind).toBe('enrichment');
  });

  it('declares meta.id=enrichment.organization', () => {
    expect(organizationTask.meta.id).toBe('enrichment.organization');
  });

  it('declares meta.interruptible=true', () => {
    expect(organizationTask.meta.interruptible).toBe(true);
  });

  it('does NOT stamp idle_eligible (D-132 trust gate resolves at runtime)', () => {
    expect(organizationTask.meta.idle_eligible).toBeUndefined();
  });

  it('exposes a zero-token cycle estimate (deterministic)', () => {
    expect(organizationTokenEstimate()).toBe(0);
    expect(organizationTokenEstimate()).toBe(ORGANIZATION_TOKEN_ESTIMATE);
  });

  it('declares non-empty scope_read_declaration over data.contact', () => {
    expect(organizationScopeReadDeclaration.length).toBeGreaterThan(0);
    const contact = organizationScopeReadDeclaration.find(
      (e) => e.collection === 'data.contact',
    );
    expect(contact).toBeDefined();
    expect((contact!.sample_field_paths as ReadonlyArray<string>).length).toBeGreaterThan(0);
  });
});

describe('organization registry entry', () => {
  it('is shape: derived_entity', () => {
    expect(ENRICHMENT_REGISTRY.organization.shape).toBe('derived_entity');
  });

  it('uses policy: independent (no cascade-watched member array)', () => {
    expect(ENRICHMENT_REGISTRY.organization.policy).toBe('independent');
  });

  it('does NOT declare members_field / members_scope (independent policy)', () => {
    const def = ENRICHMENT_REGISTRY.organization as {
      members_field?: string;
      members_scope?: string;
    };
    expect(def.members_field).toBeUndefined();
    expect(def.members_scope).toBeUndefined();
  });

  it('uses producer_kind=housekeeping', () => {
    expect(ENRICHMENT_REGISTRY.organization.producer_kind).toBe('housekeeping');
  });

  it('does NOT declare emits_confidence (deterministic, no LLM)', () => {
    const def = ENRICHMENT_REGISTRY.organization as { emits_confidence?: boolean };
    expect(def.emits_confidence).toBeUndefined();
  });

  it('does NOT declare default_trust_state (resolver returns "auto" for non-AI)', () => {
    const def = ENRICHMENT_REGISTRY.organization as { default_trust_state?: string };
    expect(def.default_trust_state).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// Pure helpers — id derivation
// ────────────────────────────────────────────────────────────────

describe('deriveOrganizationId', () => {
  it('produces an organization_<hash> id', () => {
    expect(deriveOrganizationId('acme.com')).toMatch(/^organization_[a-f0-9]+$/);
  });

  it('is stable for the same domain', () => {
    const a = deriveOrganizationId('acme.com');
    const b = deriveOrganizationId('acme.com');
    expect(a).toBe(b);
  });

  it('differs for different domains', () => {
    expect(deriveOrganizationId('acme.com')).not.toBe(
      deriveOrganizationId('beta.com'),
    );
  });
});

// ────────────────────────────────────────────────────────────────
// Pure helpers — grouping + filtering
// ────────────────────────────────────────────────────────────────

const buildScannedContact = (
  email: string,
  domain: string,
  last_interaction: number = NOW,
  first_seen: number = NOW - 30 * ONE_DAY,
) => ({
  email,
  domain,
  first_seen,
  last_interaction,
});

describe('groupContactsByDomain', () => {
  it('groups contacts that share the same business domain', () => {
    const contacts = [
      buildScannedContact('alice@acme.com', 'acme.com'),
      buildScannedContact('bob@acme.com', 'acme.com'),
      buildScannedContact('carol@acme.com', 'acme.com'),
    ];
    const orgs = groupContactsByDomain(contacts);
    expect(orgs).toHaveLength(1);
    expect(orgs[0]!.contacts.sort()).toEqual([
      'alice@acme.com',
      'bob@acme.com',
      'carol@acme.com',
    ]);
    expect(orgs[0]!.domain).toBe('acme.com');
  });

  it('separates groups with different domains', () => {
    const contacts = [
      buildScannedContact('a@acme.com', 'acme.com'),
      buildScannedContact('b@beta.com', 'beta.com'),
    ];
    const orgs = groupContactsByDomain(contacts);
    expect(orgs).toHaveLength(2);
  });

  it('tracks newest last_interaction + oldest first_seen per group', () => {
    const contacts = [
      buildScannedContact('a@acme.com', 'acme.com', NOW, NOW - 5 * ONE_DAY),
      buildScannedContact('b@acme.com', 'acme.com', NOW - 60 * ONE_DAY, NOW - 90 * ONE_DAY),
      buildScannedContact('c@acme.com', 'acme.com', NOW - 30 * ONE_DAY, NOW - 30 * ONE_DAY),
    ];
    const orgs = groupContactsByDomain(contacts);
    expect(orgs[0]!.last_interaction_at).toBe(NOW);
    expect(orgs[0]!.first_seen_at).toBe(NOW - 90 * ONE_DAY);
  });

  it('handles empty input', () => {
    expect(groupContactsByDomain([])).toEqual([]);
  });
});

describe('filterAndCapOrgs', () => {
  const buildCandidate = (count: number, last_interaction = NOW) => ({
    domain: `domain-${count}-${last_interaction}.com`,
    contacts: Array.from({ length: count }, (_, i) => `c${count}-${i}@x.com`),
    first_seen_at: last_interaction - count * ONE_DAY,
    last_interaction_at: last_interaction,
  });

  it('drops orgs below the contacts floor', () => {
    const orgs = [buildCandidate(1), buildCandidate(2), buildCandidate(3)];
    const out = filterAndCapOrgs(orgs, 2);
    expect(out).toHaveLength(2);
    expect(out.every((o) => o.contacts.length >= 2)).toBe(true);
  });

  it('caps at MAX_ORGS keeping largest by contact count', () => {
    const orgs = [
      buildCandidate(2),
      buildCandidate(5),
      buildCandidate(3),
      buildCandidate(7),
      buildCandidate(4),
    ];
    const out = filterAndCapOrgs(orgs, 2, 2);
    expect(out).toHaveLength(2);
    expect(out.map((o) => o.contacts.length).sort((a, b) => b - a)).toEqual([7, 5]);
  });

  it('breaks contact-count ties on last_interaction_at desc', () => {
    const orgs = [
      buildCandidate(3, NOW - 5 * ONE_DAY),
      buildCandidate(3, NOW),
    ];
    const out = filterAndCapOrgs(orgs, 2, 1);
    expect(out).toHaveLength(1);
    expect(out[0]!.last_interaction_at).toBe(NOW);
  });

  it('returns empty array when nothing meets the floor', () => {
    expect(filterAndCapOrgs([buildCandidate(1)], 2)).toEqual([]);
  });

  it('default thresholds match the exported constants', () => {
    expect(ORGANIZATION_MIN_CONTACTS_PER_ORG).toBe(2);
    expect(ORGANIZATION_MAX_ORGS).toBe(50);
  });
});

// ────────────────────────────────────────────────────────────────
// assembleOrganization
// ────────────────────────────────────────────────────────────────

describe('assembleOrganization', () => {
  it('produces an OrganizationValue with deduped sorted contacts', () => {
    const candidate = {
      domain: 'acme.com',
      contacts: ['carol@acme.com', 'alice@acme.com', 'bob@acme.com', 'alice@acme.com'],
      first_seen_at: NOW - 60 * ONE_DAY,
      last_interaction_at: NOW,
    };
    const { value, derived_entity_id } = assembleOrganization(candidate, NOW);
    expect(value.contacts).toEqual([
      'alice@acme.com',
      'bob@acme.com',
      'carol@acme.com',
    ]);
    expect(value.contact_count).toBe(3);
    expect(value.domain).toBe('acme.com');
    expect(value.organization_name).toBe('Acme');
    expect(value.first_seen_at).toBe(NOW - 60 * ONE_DAY);
    expect(value.last_interaction_at).toBe(NOW);
    expect(value.computed_at).toBe(NOW);
    expect(derived_entity_id).toMatch(/^organization_[a-f0-9]+$/);
  });

  it('derives multi-token names from hyphenated domains', () => {
    const candidate = {
      domain: 'acme-corp.com',
      contacts: ['a@acme-corp.com', 'b@acme-corp.com'],
      first_seen_at: NOW,
      last_interaction_at: NOW,
    };
    const { value } = assembleOrganization(candidate, NOW);
    expect(value.organization_name).toBe('Acme Corp');
  });

  it('returns null organization_name when domain has no derivable name', () => {
    const candidate = {
      domain: '123.example.com',
      contacts: ['a@123.example.com', 'b@123.example.com'],
      first_seen_at: NOW,
      last_interaction_at: NOW,
    };
    const { value } = assembleOrganization(candidate, NOW);
    expect(value.organization_name).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// Contact scan
// ────────────────────────────────────────────────────────────────

describe('scanRecentContactsForOrganization', () => {
  it('returns contacts in newest-first order (last_interaction desc)', () => {
    insertContact({ email: 'old@acme.com', last_interaction: NOW - 30 * ONE_DAY });
    insertContact({ email: 'new@acme.com', last_interaction: NOW });
    const contacts = scanRecentContactsForOrganization(buildCtx(), NOW);
    expect(contacts.map((c) => c.email)).toEqual(['new@acme.com', 'old@acme.com']);
  });

  it('drops contacts older than the look-back window', () => {
    insertContact({
      email: 'too-old@acme.com',
      last_interaction: NOW - ORGANIZATION_CONTACT_LOOKBACK_MS - ONE_DAY,
    });
    insertContact({ email: 'in-window@acme.com', last_interaction: NOW });
    const contacts = scanRecentContactsForOrganization(buildCtx(), NOW);
    expect(contacts.map((c) => c.email)).toEqual(['in-window@acme.com']);
  });

  it('drops free-mail provider contacts', () => {
    insertContact({ email: 'a@gmail.com' });
    insertContact({ email: 'b@yahoo.com' });
    insertContact({ email: 'c@hotmail.com' });
    insertContact({ email: 'd@outlook.com' });
    insertContact({ email: 'e@protonmail.com' });
    insertContact({ email: 'business@acme.com' });
    const contacts = scanRecentContactsForOrganization(buildCtx(), NOW);
    expect(contacts.map((c) => c.email)).toEqual(['business@acme.com']);
  });

  it('drops contacts without an @ in the email', () => {
    insertContact({ email: 'malformed' });
    insertContact({ email: 'good@acme.com' });
    const contacts = scanRecentContactsForOrganization(buildCtx(), NOW);
    expect(contacts.map((c) => c.email)).toEqual(['good@acme.com']);
  });

  it('respects the limit parameter', () => {
    for (let i = 0; i < 5; i += 1) {
      insertContact({
        email: `a${i}@acme.com`,
        last_interaction: NOW - i * ONE_HOUR,
      });
    }
    const contacts = scanRecentContactsForOrganization(buildCtx(), NOW, 3);
    expect(contacts).toHaveLength(3);
  });

  it('returns empty array when contacts table is missing', () => {
    db.exec('DROP TABLE contacts');
    const contacts = scanRecentContactsForOrganization(buildCtx(), NOW);
    expect(contacts).toEqual([]);
  });

  it('extracts domain into the scanned shape', () => {
    insertContact({ email: 'alice@acme.com' });
    const [contact] = scanRecentContactsForOrganization(buildCtx(), NOW);
    expect(contact!.domain).toBe('acme.com');
    expect(contact!.email).toBe('alice@acme.com');
  });
});

// ────────────────────────────────────────────────────────────────
// runOrganizationCycle — end-to-end orchestration
// ────────────────────────────────────────────────────────────────

const seedOrgCorpus = (): void => {
  // Acme Corp: 4 contacts
  insertContact({ email: 'alice@acme.com', last_interaction: NOW - ONE_DAY });
  insertContact({ email: 'bob@acme.com', last_interaction: NOW - 2 * ONE_DAY });
  insertContact({ email: 'carol@acme.com', last_interaction: NOW });
  insertContact({ email: 'dave@acme.com', last_interaction: NOW - 5 * ONE_DAY });
  // Beta Inc: 3 contacts
  insertContact({ email: 'eve@beta.com', last_interaction: NOW - 7 * ONE_DAY });
  insertContact({ email: 'frank@beta.com', last_interaction: NOW - ONE_DAY });
  insertContact({ email: 'grace@beta.com', last_interaction: NOW - 14 * ONE_DAY });
  // Singleton (gets dropped by min-contacts filter)
  insertContact({ email: 'henry@gamma.com', last_interaction: NOW });
  // Free-mail (gets dropped at scan)
  insertContact({ email: 'ivan@gmail.com' });
  insertContact({ email: 'judy@yahoo.com' });
};

describe('runOrganizationCycle', () => {
  it('produces zero rows on empty contacts corpus', () => {
    const out = runOrganizationCycle(buildCtx());
    expect(out.produced).toBe(0);
  });

  it('produces zero rows when no group meets contacts floor', () => {
    insertContact({ email: 'a@acme.com' });
    insertContact({ email: 'b@beta.com' });
    insertContact({ email: 'c@gamma.com' });
    const out = runOrganizationCycle(buildCtx());
    expect(out.produced).toBe(0);
  });

  it('happy path — emits one row per business domain', () => {
    seedOrgCorpus();
    const out = runOrganizationCycle(buildCtx());
    expect(out.produced).toBe(2);

    const rows = store.list({ topic: ORGANIZATION_TOPIC, fresh_only: false });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.scope).toBeNull();
      expect(row.target_id).toBeNull();
      expect(row.authored_by).toBe(ORGANIZATION_AUTHORED_BY);
      const v = row.value as OrganizationValue;
      expect(v.contact_count).toBeGreaterThanOrEqual(ORGANIZATION_MIN_CONTACTS_PER_ORG);
      expect(v.contacts.length).toBe(v.contact_count);
      expect(v.last_interaction_at).toBeGreaterThanOrEqual(v.first_seen_at);
    }
  });

  it('Acme org has all four contacts + Acme name', () => {
    seedOrgCorpus();
    runOrganizationCycle(buildCtx());
    const rows = store.list({ topic: ORGANIZATION_TOPIC, fresh_only: false });
    const acme = rows
      .map((r) => r.value as OrganizationValue)
      .find((v) => v.domain === 'acme.com');
    expect(acme).toBeDefined();
    expect(acme!.contacts.length).toBe(4);
    expect(Array.from(acme!.contacts).sort()).toEqual([
      'alice@acme.com',
      'bob@acme.com',
      'carol@acme.com',
      'dave@acme.com',
    ]);
    expect(acme!.organization_name).toBe('Acme');
    expect(acme!.last_interaction_at).toBe(NOW);
  });

  it('denormalizes contacts_resolved from directory names (bench harvest)', () => {
    insertContact({ email: 'alice@initech.com', name: 'Alice Njoku' });
    insertContact({ email: 'bob@initech.com', name: 'Bob Okafor' });
    insertContact({ email: 'carol@initech.com' }); // unnamed — raw list only

    runOrganizationCycle(buildCtx());
    const rows = store.list({ topic: ORGANIZATION_TOPIC, fresh_only: false });
    const initech = rows
      .map((r) => r.value as OrganizationValue)
      .find((v) => v.domain === 'initech.com');
    expect(initech).toBeDefined();
    expect(initech!.contacts).toContain('carol@initech.com');
    // Only the directory-NAMED contacts appear, sorted by entity; carol
    // stays in the raw `contacts` list but earns no fabricated pair.
    expect(initech!.contacts_resolved).toEqual([
      { entity: 'alice@initech.com', name: 'Alice Njoku' },
      { entity: 'bob@initech.com', name: 'Bob Okafor' },
    ]);
  });

  it('drops singletons + free-mail before emit', () => {
    seedOrgCorpus();
    runOrganizationCycle(buildCtx());
    const rows = store.list({ topic: ORGANIZATION_TOPIC, fresh_only: false });
    const domains = rows.map((r) => (r.value as OrganizationValue).domain);
    expect(domains).not.toContain('gamma.com');
    expect(domains).not.toContain('gmail.com');
    expect(domains).not.toContain('yahoo.com');
  });

  it('produces stable derived_entity_id across runs with the same corpus', () => {
    seedOrgCorpus();
    runOrganizationCycle(buildCtx());
    const firstIds = store
      .list({ topic: ORGANIZATION_TOPIC, fresh_only: false })
      .map((r) => r._id)
      .sort();

    runOrganizationCycle(buildCtx());
    const secondIds = store
      .list({ topic: ORGANIZATION_TOPIC, fresh_only: false })
      .map((r) => r._id)
      .sort();

    expect(firstIds).toEqual(secondIds);
    expect(secondIds).toHaveLength(2);
  });

  it('cap is enforced on emitted orgs', () => {
    // Build many distinct business domains, each with 2+ contacts.
    for (let g = 0; g < ORGANIZATION_MAX_ORGS + 5; g += 1) {
      for (let i = 0; i < 2; i += 1) {
        insertContact({ email: `c${i}@org-${g}.com` });
      }
    }
    const out = runOrganizationCycle(buildCtx());
    expect(out.produced).toBeLessThanOrEqual(ORGANIZATION_MAX_ORGS);
  });

  it('organizationTask.step returns complete + zero-cost cursor', async () => {
    seedOrgCorpus();
    const result = await organizationTask.step(
      buildCtx(),
      { kind: 'complete' },
      60_000,
    );
    expect(result.status).toBe('complete');
    expect(result.cursor).toEqual({ kind: 'complete' });
  });

  it('round-trips through the registry value_schema', () => {
    seedOrgCorpus();
    expect(() => runOrganizationCycle(buildCtx())).not.toThrow();
  });
});

// ────────────────────────────────────────────────────────────────
// Sweep stale rows
// ────────────────────────────────────────────────────────────────

describe('sweepStaleOrganizations', () => {
  const insertOrg = (id: string): void => {
    store.upsert({
      topic: 'organization',
      derived_entity_id: id,
      value: {
        domain: 'placeholder.com',
        organization_name: 'Placeholder',
        contacts: ['a@placeholder.com', 'b@placeholder.com'],
        contact_count: 2,
        first_seen_at: NOW - 14 * ONE_DAY,
        last_interaction_at: NOW,
        computed_at: NOW,
      },
      authored_by: ORGANIZATION_AUTHORED_BY,
    });
  };

  it('deletes rows whose id is not in the fresh set', () => {
    insertOrg('organization_kept');
    insertOrg('organization_orphan');
    const result = sweepStaleOrganizations(buildCtx(), new Set(['organization_kept']));
    expect(result.deleted).toBe(1);
    const remaining = store.list({ topic: ORGANIZATION_TOPIC, fresh_only: false });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!._id).toBe('organization_kept');
  });

  it('deletes every row when fresh set is empty', () => {
    insertOrg('organization_x');
    const result = sweepStaleOrganizations(buildCtx(), new Set());
    expect(result.deleted).toBe(1);
  });

  it('no-op when fresh set covers every row', () => {
    insertOrg('organization_kept');
    const result = sweepStaleOrganizations(buildCtx(), new Set(['organization_kept']));
    expect(result.deleted).toBe(0);
    expect(store.list({ topic: ORGANIZATION_TOPIC, fresh_only: false })).toHaveLength(1);
  });

  it('cycle 2 sweeps an org that vanished from the corpus', () => {
    seedOrgCorpus();
    runOrganizationCycle(buildCtx());
    expect(store.list({ topic: ORGANIZATION_TOPIC, fresh_only: false })).toHaveLength(2);

    // Delete every beta.com contact. Cycle 2 should drop that org.
    db.prepare(`DELETE FROM contacts WHERE email LIKE '%@beta.com'`).run();
    runOrganizationCycle(buildCtx());
    const rows = store.list({ topic: ORGANIZATION_TOPIC, fresh_only: false });
    expect(rows).toHaveLength(1);
    const surviving = rows[0]!.value as OrganizationValue;
    expect(surviving.domain).toBe('acme.com');
  });
});

// ────────────────────────────────────────────────────────────────
// Registry value_schema
// ────────────────────────────────────────────────────────────────

describe('organization value_schema', () => {
  const validate = ENRICHMENT_REGISTRY.organization.value_schema;

  const goodValue: OrganizationValue = {
    domain: 'acme.com',
    organization_name: 'Acme',
    contacts: ['alice@acme.com', 'bob@acme.com', 'carol@acme.com'],
    contact_count: 3,
    first_seen_at: NOW - 60 * ONE_DAY,
    last_interaction_at: NOW,
    computed_at: NOW,
  };

  it('accepts a well-formed value', () => {
    expect(validate(goodValue).ok).toBe(true);
  });

  it('accepts null organization_name', () => {
    expect(validate({ ...goodValue, organization_name: null }).ok).toBe(true);
  });

  it('rejects non-object values', () => {
    expect(validate('not an object').ok).toBe(false);
    expect(validate(null).ok).toBe(false);
    expect(validate([]).ok).toBe(false);
  });

  it('rejects empty domain', () => {
    expect(validate({ ...goodValue, domain: '' }).ok).toBe(false);
  });

  it('rejects non-string domain', () => {
    expect(validate({ ...goodValue, domain: 123 }).ok).toBe(false);
  });

  it('rejects non-string-or-null organization_name', () => {
    expect(validate({ ...goodValue, organization_name: 42 }).ok).toBe(false);
  });

  it('rejects empty contacts array', () => {
    expect(validate({ ...goodValue, contacts: [] }).ok).toBe(false);
  });

  it('rejects non-string contact entries', () => {
    expect(validate({ ...goodValue, contacts: ['a@x.com', 42] }).ok).toBe(false);
  });

  it('rejects non-finite contact_count', () => {
    expect(validate({ ...goodValue, contact_count: NaN }).ok).toBe(false);
  });

  it('rejects missing computed_at', () => {
    const { computed_at: _ts, ...rest } = goodValue;
    void _ts;
    expect(validate(rest).ok).toBe(false);
  });

  it('rejects missing last_interaction_at', () => {
    const { last_interaction_at: _ts, ...rest } = goodValue;
    void _ts;
    expect(validate(rest).ok).toBe(false);
  });

  it('rejects missing first_seen_at', () => {
    const { first_seen_at: _ts, ...rest } = goodValue;
    void _ts;
    expect(validate(rest).ok).toBe(false);
  });
});
