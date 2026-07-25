/** D-145 PA8 follow-on — `contact.search` phone/alias fan-out tests. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canonicalizeEmail,
  type ChatDispatchContext,
  type ContactRecord,
} from '@recued/contracts';

import {
  buildChatTier1Handlers,
  type ChatToolHandlerDeps,
} from '../chat-tool-handlers.js';
import {
  createContactStore,
  type ContactStore,
} from '../storage/contact-store.js';

let db: Database.Database;
let store: ContactStore;
let now = 1_800_000_300_000;

const ctxInternal = (session_id = 'sess-pa8', turn_id = 'turn-pa8'): ChatDispatchContext => ({
  channel: 'internal_function_call',
  session_id,
  turn_id,
});

const seedContact = (
  email: string,
  fields: Partial<{
    name: string;
    phone: string;
    last_interaction: number;
  }> = {},
): ContactRecord => {
  const canonical = canonicalizeEmail(email);
  if (!canonical) throw new Error(`bad test email: ${email}`);
  store.upsertManual(
    {
      email: canonical,
      ...(fields.name !== undefined ? { name: fields.name } : {}),
      ...(fields.phone !== undefined ? { phone: fields.phone } : {}),
      ...(fields.last_interaction !== undefined
        ? { last_interaction: fields.last_interaction }
        : {}),
    },
    now++,
  );
  // D-192 C-2 slice 4 — the fixture used to RE-KEY `contacts.contact_id` here to a
  // readable literal. That is now a data-corrupting operation and the substrate
  // ABORTS on it (`contact_id_immutable`): `contact_id` is the storage identity,
  // every contribution keys on it with no SQL FK, so rewriting it orphans them all
  // and the next projection blanks the contact. Tests read the store-minted id off
  // the returned record — which is all they ever did with it.
  const seeded = store.get(canonical);
  if (!seeded) throw new Error(`failed to seed ${canonical}`);
  return seeded;
};

const buildDepsStub = (
  overrides: Partial<ChatToolHandlerDeps> = {},
): ChatToolHandlerDeps => {
  const deps: ChatToolHandlerDeps = {
    getContactStore: () => store,
    getCollectionRegistry: () => undefined,
    getAuditLog: () => undefined,
    getEnrichmentStore: () => undefined,
    getRecipeStore: () =>
      ({
        ids: () => [],
        get: () => null,
        getStored: () => null,
        listStored: () => [],
      }) as never,
    getExecutorConfig: () => ({ manifests: { get: () => null } }) as never,
    getExecuteRecipe: () => undefined,
    // D-190 — contact.search fans out over the bound CRM contact connections; the
    // stub returns the two built-ins (the old hardcoded set).
    getBoundCrmMirrorSources: (crmAlias) =>
      crmAlias === 'contact'
        ? [
            { source_id: 'hubspot', scope: 'connection.api.hubspot.contact' },
            { source_id: 'salesforce', scope: 'connection.api.salesforce.contact' },
          ]
        : [],
    ...overrides,
  };
  // D-190 — contact.search reads getCrmRecordMirror().list (the MS3 mirror repoint);
  // `list` is the drop-in for `listScopeMeta`, so route the platform fixtures (still
  // expressed as a getEnrichmentStore().listScopeMeta fake) into the mirror getter.
  if (deps.getCrmRecordMirror === undefined) {
    deps.getCrmRecordMirror = () => {
      const es = deps.getEnrichmentStore() as
        | { listScopeMeta: (scope: string, opts?: unknown) => unknown }
        | undefined;
      return es
        ? ({ list: (scope: string, opts?: unknown) => es.listScopeMeta(scope, opts) } as never)
        : undefined;
    };
  }
  return deps;
};

beforeEach(() => {
  now = 1_800_000_300_000;
  db = new Database(':memory:');
  store = createContactStore(db, { now: () => now++ });
});

afterEach(() => {
  db.close();
});

describe('contact.search — phone and alias local-only fan-out', () => {
  it('routes phone-only args to the local source and skips platform mirrors cleanly', async () => {
    seedContact('alice@example.com', {
      name: 'Alice',
      phone: '+15550004001',
    });
    const listScopeMeta = vi.fn(() => {
      throw new Error('platform source should have been skipped');
    });
    const handlers = buildChatTier1Handlers(
      buildDepsStub({
        getEnrichmentStore: () => ({ listScopeMeta }) as never,
      }),
    );

    const result = await handlers['contact.search']!(
      { phone: '+15550004001', limit: 5 },
      ctxInternal(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const r = result.result as {
      candidates: Array<{ source: string; record: { email: string | null } }>;
      partial?: boolean;
      partial_failures?: unknown;
    };
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({
      source: 'local',
      record: { email: 'alice@example.com' },
    });
    expect(listScopeMeta).not.toHaveBeenCalled();
    expect(r.partial).toBeUndefined();
    expect(r.partial_failures).toBeUndefined();
  });

  it('routes bare alias args to the local source and skips platform mirrors cleanly', async () => {
    const alice = seedContact('alice@example.com', {
      name: 'Alice',
    });
    store.upsertContactAlias({
      contact_id: alice.contact_id!,
      kind: 'chat_alias',
      alias_pattern: 'Mom',
      source: 'manual',
    });
    const listScopeMeta = vi.fn(() => {
      throw new Error('platform source should have been skipped');
    });
    const handlers = buildChatTier1Handlers(
      buildDepsStub({
        getEnrichmentStore: () => ({ listScopeMeta }) as never,
      }),
    );

    const result = await handlers['contact.search']!({ alias: 'mom', limit: 5 }, ctxInternal());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const r = result.result as {
      candidates: Array<{ source: string; record: { email: string | null } }>;
      partial?: boolean;
      partial_failures?: unknown;
    };
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({
      source: 'local',
      record: { email: 'alice@example.com' },
    });
    expect(listScopeMeta).not.toHaveBeenCalled();
    expect(r.partial).toBeUndefined();
    expect(r.partial_failures).toBeUndefined();
  });

  it('surfaces ambiguous chat_alias alternatives at fuzzy score, not exact score', async () => {
    const alice = seedContact('alice@example.com', {
      name: 'Alice',
      last_interaction: 1,
    });
    const bob = seedContact('bob@example.com', {
      name: 'Bob',
      last_interaction: 2,
    });
    for (const contact of [alice, bob]) {
      store.upsertContactAlias({
        contact_id: contact.contact_id!,
        kind: 'chat_alias',
        alias_pattern: 'Sam',
        source: 'manual',
      });
    }
    const handlers = buildChatTier1Handlers(buildDepsStub());

    const result = await handlers['contact.search']!({ alias: 'sam', limit: 5 }, ctxInternal());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const r = result.result as {
      candidates: Array<{
        source: string;
        score?: number;
        record: { email: string | null };
      }>;
      envelope: { shape: { pattern: number } };
    };
    expect(r.candidates.map((c) => c.source)).toEqual(['local', 'local']);
    expect(r.candidates.map((c) => c.score)).toEqual([0.75, 0.75]);
    expect(r.envelope.shape.pattern).not.toBe(1);
    expect(r.candidates.map((c) => c.record.email).sort()).toEqual([
      'alice@example.com',
      'bob@example.com',
    ]);
  });

  it('uses the local platform_id alias branch while platform mirrors skip without email/query', async () => {
    const alice = seedContact('alice@example.com', {
      name: 'Alice',
    });
    store.upsertContactAlias({
      contact_id: alice.contact_id!,
      kind: 'platform_id',
      platform: 'github',
      alias_pattern: 'alice-gh',
      source: 'manual',
    });
    const listScopeMeta = vi.fn(() => {
      throw new Error('platform source should have been skipped');
    });
    const handlers = buildChatTier1Handlers(
      buildDepsStub({
        getEnrichmentStore: () => ({ listScopeMeta }) as never,
      }),
    );

    const result = await handlers['contact.search']!(
      { alias: 'alice-gh', platform: 'github', limit: 5 },
      ctxInternal(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const r = result.result as {
      candidates: Array<{ source: string; record: { email: string | null } }>;
      partial?: boolean;
      partial_failures?: unknown;
    };
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({
      source: 'local',
      record: { email: 'alice@example.com' },
    });
    expect(listScopeMeta).not.toHaveBeenCalled();
    expect(r.partial).toBeUndefined();
    expect(r.partial_failures).toBeUndefined();
  });
});

describe('contact.search — validation and platform fan-out', () => {
  it('returns an invalid_args envelope for an unsupported platform value', async () => {
    const handlers = buildChatTier1Handlers(buildDepsStub());

    const result = await handlers['contact.search']!(
      { alias: 'alice', platform: 'tiktok' },
      ctxInternal(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid_args');
      expect(result.detail).toContain('not a supported contact alias platform');
    }
  });

  it('still fans out to platform sources when email and query are present', async () => {
    seedContact('alice@example.com', {
      name: 'Alice Local',
    });
    const listScopeMeta = vi.fn((scope: string) => {
      if (scope === 'connection.api.hubspot.contact') {
        return [{
          scope,
          target_id: 'hubspot_contact_alice',
          meta: {
            email: 'alice@example.com',
            name: 'Alice HubSpot',
            recent_activity_at: 1_800_000_300_500,
          },
        }];
      }
      if (scope === 'connection.api.salesforce.contact') {
        return [{
          scope,
          target_id: 'salesforce_contact_alice',
          meta: {
            email: 'alice@example.com',
            name: 'Alice Salesforce',
            recent_activity_at: 1_800_000_300_600,
          },
        }];
      }
      return [];
    });
    const handlers = buildChatTier1Handlers(
      buildDepsStub({
        getEnrichmentStore: () => ({ listScopeMeta }) as never,
      }),
    );

    const result = await handlers['contact.search']!(
      { email: 'alice@example.com', query: 'Alice', limit: 10 },
      ctxInternal(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(listScopeMeta).toHaveBeenCalledWith(
      'connection.api.hubspot.contact',
      { name_contains: 'Alice', email_exact: 'alice@example.com', limit: 10 },
    );
    expect(listScopeMeta).toHaveBeenCalledWith(
      'connection.api.salesforce.contact',
      { name_contains: 'Alice', email_exact: 'alice@example.com', limit: 10 },
    );
    const r = result.result as {
      candidates: Array<{ source: string; record: { name?: string } }>;
    };
    expect(r.candidates.map((c) => c.source).sort()).toEqual([
      'hubspot',
      'local',
      'salesforce',
    ]);
    expect(r.candidates.find((c) => c.source === 'hubspot')?.record.name)
      .toBe('Alice HubSpot');
    expect(r.candidates.find((c) => c.source === 'salesforce')?.record.name)
      .toBe('Alice Salesforce');
  });
});
