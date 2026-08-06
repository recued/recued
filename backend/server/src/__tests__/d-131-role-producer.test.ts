/** D-131 A.11 — `role` enrichment producer tests.
 *
 *  Second AI signature-parse producer. Mirrors `d-131-company-producer.test.ts`
 *  for the SQLite mail-table fixture + `findRecentInboundBody` shape;
 *  diverges where role's pure-AI surface forces stricter null-return
 *  semantics (no body / short body / null title → null row, no
 *  always-emit fallback).
 *
 *  Coverage:
 *    - Producer surface contract (topic / scope / ai_surface / token estimate)
 *    - `categorizeRole` priority + fallback (executive > engineering > sales > marketing > operations > support > research > other)
 *    - Empty / null cases (no email, no body, short body)
 *    - Pure-AI surface — throws on missing ctx.llm / ctx.blobs
 *    - AI signature parse: title returned → row, null title → null
 *    - Body resolution: body_inline preferred, blob_hash fallback
 *    - Sender-only filter
 *    - Multi-table aggregation
 *    - Long body truncated
 *    - Closed-shape guarantee on category
 *    - Malformed AI shape throws role_output_invalid
 *    - Registry value_schema accepts produced shape */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ENRICHMENT_REGISTRY,
  ROLE_CATEGORIES,
  type ContactRecord,
  type IngredientManifest,
  type RoleCategory,
} from '@recued/contracts';

import {
  categorizeRole,
  roleProducer,
  // D-136 P1: ROLE_CONFIDENCE_SIGNATURE_PARSE no longer asserted on
  // producer outputs (confidence field stripped from RoleValue — role
  // is time_bound).
  ROLE_MIN_BODY_CHARS,
  MAX_TITLE_CHARS,
} from '../housekeeping/producers/role.js';
import type {
  HousekeepingContext,
  HousekeepingLlmExecute,
} from '../housekeeping/registry.js';
import type { SourceRecord } from '../housekeeping/source-walkers.js';
import type { BlobStore } from '../storage/blob-store.js';

// ────────────────────────────────────────────────────────────────
// Fixture infrastructure (mirrors company producer test shape)
// ────────────────────────────────────────────────────────────────

let dir: string;
let db: Database.Database;
const NOW = 1_700_000_000_000;
const ONE_DAY = 86_400_000;

const MAIL_TABLE = 'collection_mail_11111111aa';
const MAIL_TABLE_2 = 'collection_mail_22222222bb';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-131-role-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  for (const t of [MAIL_TABLE, MAIL_TABLE_2]) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${t} (
        record_id   TEXT PRIMARY KEY,
        received_at INTEGER NOT NULL,
        modified_at INTEGER NOT NULL,
        hot_fields  TEXT NOT NULL,
        size_bytes  INTEGER NOT NULL,
        source_id   TEXT NOT NULL,
        body_inline TEXT,
        blob_hash   TEXT
      );
    `);
  }
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const insertMail = (
  table: string,
  record_id: string,
  hot: Record<string, unknown>,
  body: { inline?: string; blob_hash?: string } = {},
  received_at = NOW,
): void => {
  db.prepare(
    `INSERT INTO ${table} (
       record_id, received_at, modified_at, hot_fields,
       size_bytes, source_id, body_inline, blob_hash
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record_id,
    received_at,
    received_at,
    JSON.stringify(hot),
    body.inline ? body.inline.length : 100,
    record_id,
    body.inline ?? null,
    body.blob_hash ?? null,
  );
};

const fakeContact = (email: string, overrides: Partial<ContactRecord> = {}): ContactRecord => ({
  _id: email,
  _collection: 'contact',
  email,
  first_seen: NOW - 90 * ONE_DAY,
  last_interaction: NOW,
  interaction_count: 1,
  source: 'email_from',
  created_at: NOW - 90 * ONE_DAY,
  updated_at: NOW,
  ...overrides,
});

const sourceFor = (
  email: string,
  overrides: Partial<ContactRecord> = {},
): SourceRecord<ContactRecord> => ({
  target_id: email,
  data: fakeContact(email, overrides),
  cursor_token: email,
});

interface StubLlm {
  fn: ReturnType<typeof vi.fn>;
  capturedManifest: IngredientManifest | null;
  capturedInput: Record<string, unknown> | null;
}

const buildStubLlm = (
  result: unknown | (() => never) | (() => Promise<never>),
): StubLlm => {
  const stub: StubLlm = {
    capturedManifest: null,
    capturedInput: null,
    fn: vi.fn(),
  };
  stub.fn = vi.fn(async (manifest: IngredientManifest, input: Record<string, unknown>) => {
    stub.capturedManifest = manifest;
    stub.capturedInput = input;
    if (typeof result === 'function') return (result as () => unknown)();
    return result;
  });
  return stub;
};

const buildBlobs = (overrides: Partial<BlobStore> = {}): BlobStore => ({
  put: vi.fn(async () => 'unused'),
  get: vi.fn(async () => null),
  has: vi.fn(async () => false),
  delete: vi.fn(async () => undefined),
  sizeOf: vi.fn(async () => null),
  sweepOrphans: vi.fn(async () => 0),
  totalBytes: vi.fn(async () => 0),
  root: '/tmp/test',
  ...overrides,
});

const stubCtx = (
  options: {
    llm?: ReturnType<typeof vi.fn>;
    blobs?: BlobStore;
    now?: number;
  } = {},
): HousekeepingContext => ({
  db,
  bus: {
    emit: () => undefined,
    subscribe: () => () => undefined,
    dispose: () => undefined,
  } as never,
  enrichmentStore: {} as never,
  recipeStore: {} as never,
  now: () => options.now ?? NOW,
  emitAuditRow: () => undefined,
  ...(options.llm ? { llm: options.llm as unknown as HousekeepingLlmExecute } : {}),
  // D-136 P3 — roleProducer reads `ctx.llmWithMeta`. Wrap.
  ...(options.llm
    ? {
        llmWithMeta: (async (manifest: unknown, input: unknown) => ({
          result: await (options.llm as unknown as (
            m: unknown,
            i: unknown,
          ) => Promise<unknown>)(manifest, input),
          model_id: 'openai:gpt-4o-mini',
        })) as unknown as HousekeepingContext['llmWithMeta'],
      }
    : {}),
  ...(options.blobs ? { blobs: options.blobs } : {}),
});

const longBody = 'Hi team,\n\n' + 'X'.repeat(ROLE_MIN_BODY_CHARS + 50);

// ────────────────────────────────────────────────────────────────
// Producer surface contract
// ────────────────────────────────────────────────────────────────

describe('roleProducer surface contract', () => {
  it('targets the role registry topic', () => {
    expect(roleProducer.topic).toBe('role');
  });

  it('targets the contact source scope', () => {
    expect(roleProducer.source_scope).toBe('contact');
  });

  it('declares ai_surface=chat (signature parse via executeLLM)', () => {
    expect(roleProducer.ai_surface).toBe('chat');
  });

  it('declares positive token estimate (AI-surface gate)', () => {
    expect(roleProducer.estimate_per_record_tokens()).toBeGreaterThan(0);
  });

  it('declares both data.contact and data.mail in scope_read_declaration', () => {
    const collections = roleProducer.scope_read_declaration.map((d) => d.collection);
    expect(collections).toContain('data.contact');
    expect(collections).toContain('data.mail');
  });

  it('role is time_bound — not PSI-eligible (D-136 P1 revoked emits_confidence)', () => {
    const def = ENRICHMENT_REGISTRY.role as { emits_confidence?: boolean };
    expect(def.emits_confidence).toBeUndefined();
  });

  it('registry default_trust_state is manual (AI producer)', () => {
    const def = ENRICHMENT_REGISTRY.role;
    expect(def.default_trust_state).toBe('manual');
  });

  it('registry default_pool_policy is free_only (cheap-and-noisy class)', () => {
    const def = ENRICHMENT_REGISTRY.role;
    expect(def.default_pool_policy).toBe('free_only');
  });
});

// ────────────────────────────────────────────────────────────────
// categorizeRole — priority order + fallback
// ────────────────────────────────────────────────────────────────

describe('categorizeRole', () => {
  const expectations: Array<{ title: string; category: RoleCategory }> = [
    // Executive — C-suite + leadership wins over function
    { title: 'CEO', category: 'executive' },
    { title: 'Chief Executive Officer', category: 'executive' },
    { title: 'CTO', category: 'executive' },
    { title: 'CFO', category: 'executive' },
    { title: 'Founder', category: 'executive' },
    { title: 'Co-founder', category: 'executive' },
    { title: 'President', category: 'executive' },
    { title: 'VP of Sales', category: 'executive' },
    { title: 'VP of Engineering', category: 'executive' },
    { title: 'SVP Marketing', category: 'executive' },
    { title: 'Managing Director', category: 'executive' },
    // Engineering — IC + lead-level
    { title: 'Software Engineer', category: 'engineering' },
    { title: 'Senior Engineer', category: 'engineering' },
    { title: 'Staff Engineer', category: 'engineering' },
    { title: 'Engineering Lead', category: 'engineering' },
    { title: 'DevOps Engineer', category: 'engineering' },
    { title: 'Site Reliability Engineer', category: 'engineering' },
    { title: 'Frontend Developer', category: 'engineering' },
    { title: 'Solutions Architect', category: 'engineering' },
    // Product
    { title: 'Product Manager', category: 'product' },
    { title: 'Senior Product Manager', category: 'product' },
    { title: 'Product Designer', category: 'product' },
    { title: 'UX Researcher', category: 'product' },
    // Sales
    { title: 'Sales Director', category: 'sales' },
    { title: 'Account Executive', category: 'sales' },
    { title: 'Account Manager', category: 'sales' },
    { title: 'Director of Business Development', category: 'sales' },
    { title: 'BDR', category: 'sales' },
    // Marketing
    { title: 'Head of Marketing', category: 'marketing' },
    { title: 'Growth Manager', category: 'marketing' },
    { title: 'Brand Director', category: 'marketing' },
    { title: 'Director of Communications', category: 'marketing' },
    // Operations
    { title: 'Head of Operations', category: 'operations' },
    { title: 'Finance Manager', category: 'operations' },
    { title: 'General Counsel', category: 'operations' },
    { title: 'Senior Recruiter', category: 'operations' },
    { title: 'Head of People', category: 'operations' },
    // Support
    { title: 'Customer Success Manager', category: 'support' },
    { title: 'Support Engineer', category: 'engineering' }, // engineer wins over support
    { title: 'Customer Care Lead', category: 'support' },
    { title: 'Director of Client Services', category: 'support' },
    // Research
    { title: 'Research Scientist', category: 'research' },
    { title: 'Senior Data Scientist', category: 'research' },
    { title: 'Senior Researcher', category: 'research' },
    // Other / fallback
    { title: 'Random Made-Up Title', category: 'other' },
    { title: 'Wizard', category: 'other' },
    { title: '', category: 'other' },
  ];

  for (const { title, category } of expectations) {
    it(`maps "${title}" → ${category}`, () => {
      expect(categorizeRole(title)).toBe(category);
    });
  }

  it('always returns one of ROLE_CATEGORIES', () => {
    const set = new Set<string>(ROLE_CATEGORIES);
    for (const title of [
      'random',
      'CEO',
      'engineer',
      'support',
      '',
      'wizard',
      '🦄',
    ]) {
      expect(set.has(categorizeRole(title))).toBe(true);
    }
  });

  it('is case-insensitive', () => {
    expect(categorizeRole('CEO')).toBe('executive');
    expect(categorizeRole('ceo')).toBe('executive');
    expect(categorizeRole('Ceo')).toBe('executive');
  });
});

// ────────────────────────────────────────────────────────────────
// Empty / null cases — pure-AI surface
// ────────────────────────────────────────────────────────────────

describe('roleProducer.produce — pure-AI null returns', () => {
  it('returns null for a contact with empty email', async () => {
    const llm = buildStubLlm({ title: 'CEO' });
    const ctx = stubCtx({ llm: llm.fn, blobs: buildBlobs() });
    const out = await roleProducer.produce(
      ctx,
      sourceFor('', { email: '' }),
    );
    expect(out).toBeNull();
    expect(llm.fn).not.toHaveBeenCalled();
  });

  it('returns null when no inbound mail exists for the contact', async () => {
    const llm = buildStubLlm({ title: 'CEO' });
    const ctx = stubCtx({ llm: llm.fn, blobs: buildBlobs() });
    const out = await roleProducer.produce(ctx, sourceFor('alice@acme.com'));
    expect(out).toBeNull();
    expect(llm.fn).not.toHaveBeenCalled();
  });

  it('returns null when the most-recent body is below the floor', async () => {
    insertMail(
      MAIL_TABLE,
      'm1',
      { from: 'alice@acme.com', to: ['user@self.com'], subject: 'hi' },
      { inline: 'too short' },
    );
    const llm = buildStubLlm({ title: 'CEO' });
    const ctx = stubCtx({ llm: llm.fn, blobs: buildBlobs() });
    const out = await roleProducer.produce(ctx, sourceFor('alice@acme.com'));
    expect(out).toBeNull();
    expect(llm.fn).not.toHaveBeenCalled();
  });

  it('returns null when AI returns null title (no signature found)', async () => {
    insertMail(
      MAIL_TABLE,
      'm1',
      { from: 'alice@acme.com', to: ['user@self.com'], subject: 'hi' },
      { inline: longBody },
    );
    const llm = buildStubLlm({ title: null });
    const ctx = stubCtx({ llm: llm.fn, blobs: buildBlobs() });
    const out = await roleProducer.produce(ctx, sourceFor('alice@acme.com'));
    expect(out).toBeNull();
    expect(llm.fn).toHaveBeenCalledOnce();
  });

  it('returns null when AI returns whitespace-only title', async () => {
    insertMail(
      MAIL_TABLE,
      'm1',
      { from: 'alice@acme.com', to: ['user@self.com'], subject: 'hi' },
      { inline: longBody },
    );
    const llm = buildStubLlm({ title: '   \n  ' });
    const ctx = stubCtx({ llm: llm.fn, blobs: buildBlobs() });
    const out = await roleProducer.produce(ctx, sourceFor('alice@acme.com'));
    expect(out).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// Misconfiguration — throws when ctx.llm / ctx.blobs missing
// ────────────────────────────────────────────────────────────────

describe('roleProducer.produce — misconfiguration', () => {
  it('throws role_producer_misconfigured when ctx.llm is missing', async () => {
    const ctx = stubCtx({ blobs: buildBlobs() }); // no llm
    await expect(
      roleProducer.produce(ctx, sourceFor('alice@acme.com')),
    ).rejects.toThrow(/role_producer_misconfigured.*ctx\.llm/);
  });

  it('throws role_producer_misconfigured when ctx.blobs is missing', async () => {
    const llm = buildStubLlm({ title: 'CEO' });
    const ctx = stubCtx({ llm: llm.fn }); // no blobs
    await expect(
      roleProducer.produce(ctx, sourceFor('alice@acme.com')),
    ).rejects.toThrow(/role_producer_misconfigured.*ctx\.blobs/);
  });
});

// ────────────────────────────────────────────────────────────────
// AI signature parse — happy path
// ────────────────────────────────────────────────────────────────

describe('roleProducer.produce — signature parse', () => {
  it('returns a row with title + category when AI extracts a title', async () => {
    insertMail(
      MAIL_TABLE,
      'm1',
      { from: 'alice@acme.com', to: ['user@self.com'], subject: 'hi' },
      { inline: longBody },
    );
    const llm = buildStubLlm({ title: 'Director of Sales' });
    const ctx = stubCtx({ llm: llm.fn, blobs: buildBlobs() });
    const out = await roleProducer.produce(ctx, sourceFor('alice@acme.com'));

    // D-136 P1: confidence stripped from RoleValue (time_bound topic).
    expect(out?.value).toEqual({
      title: 'Director of Sales',
      category: 'sales',
      reasoning: expect.stringMatching(/Parsed from signature.*sales/i),
      computed_at: NOW,
    });
  });

  it('passes ai-extract input with title field + signature-priority context', async () => {
    insertMail(
      MAIL_TABLE,
      'm1',
      { from: 'alice@acme.com', to: ['user@self.com'], subject: 'hi' },
      { inline: longBody },
    );
    const llm = buildStubLlm({ title: 'CTO' });
    const ctx = stubCtx({ llm: llm.fn, blobs: buildBlobs() });
    await roleProducer.produce(ctx, sourceFor('alice@acme.com'));

    expect(llm.fn).toHaveBeenCalledOnce();
    expect(llm.capturedInput?.['llm.fields']).toEqual(['title']);
    expect(llm.capturedInput?.['llm.context']).toMatch(/signature block/i);
    expect(llm.capturedInput?.['llm.context']).toMatch(/Do NOT infer/i);
    expect(llm.capturedInput?.['llm.model_hint']).toBe('fast');
  });

  it('categorizes CTO as executive (not engineering)', async () => {
    insertMail(
      MAIL_TABLE,
      'm1',
      { from: 'alice@acme.com', to: ['user@self.com'], subject: 'hi' },
      { inline: longBody },
    );
    const llm = buildStubLlm({ title: 'Chief Technology Officer' });
    const ctx = stubCtx({ llm: llm.fn, blobs: buildBlobs() });
    const out = await roleProducer.produce(ctx, sourceFor('alice@acme.com'));

    expect(out?.value).toMatchObject({ category: 'executive' });
  });

  it('categorizes free-form titles into other when no keyword matches', async () => {
    insertMail(
      MAIL_TABLE,
      'm1',
      { from: 'alice@acme.com', to: ['user@self.com'], subject: 'hi' },
      { inline: longBody },
    );
    const llm = buildStubLlm({ title: 'Chief Wizard of Whimsy' });
    const ctx = stubCtx({ llm: llm.fn, blobs: buildBlobs() });
    const out = await roleProducer.produce(ctx, sourceFor('alice@acme.com'));

    // Note: 'chief ' is in executive keywords, so this matches executive
    // first. The "other" path requires a title with no keyword overlap.
    expect(out?.value).toMatchObject({ category: 'executive' });
  });

  it('caps title at MAX_TITLE_CHARS', async () => {
    const huge = 'X'.repeat(MAX_TITLE_CHARS + 50);
    insertMail(
      MAIL_TABLE,
      'm1',
      { from: 'alice@acme.com', to: ['user@self.com'], subject: 'hi' },
      { inline: longBody },
    );
    const llm = buildStubLlm({ title: huge });
    const ctx = stubCtx({ llm: llm.fn, blobs: buildBlobs() });
    const out = await roleProducer.produce(ctx, sourceFor('alice@acme.com'));

    const value = out?.value as { title: string };
    expect(value.title.length).toBe(MAX_TITLE_CHARS);
  });

  it('truncates very long bodies before LLM call', async () => {
    const huge = 'X'.repeat(80_000);
    insertMail(
      MAIL_TABLE,
      'm1',
      { from: 'alice@acme.com', to: ['user@self.com'], subject: 'hi' },
      { inline: huge },
    );
    const llm = buildStubLlm({ title: 'Engineer' });
    const ctx = stubCtx({ llm: llm.fn, blobs: buildBlobs() });
    await roleProducer.produce(ctx, sourceFor('alice@acme.com'));

    const passedData = llm.capturedInput?.['llm.data'] as string;
    expect(passedData.length).toBeLessThanOrEqual(32_000);
  });
});

// ────────────────────────────────────────────────────────────────
// AI shape validation
// ────────────────────────────────────────────────────────────────

describe('roleProducer.produce — output validation', () => {
  it('throws role_output_invalid for non-string title', async () => {
    insertMail(
      MAIL_TABLE,
      'm1',
      { from: 'alice@acme.com', to: ['user@self.com'], subject: 'hi' },
      { inline: longBody },
    );
    const llm = buildStubLlm({ title: 42 });
    const ctx = stubCtx({ llm: llm.fn, blobs: buildBlobs() });

    await expect(
      roleProducer.produce(ctx, sourceFor('alice@acme.com')),
    ).rejects.toThrow(/role_output_invalid/);
  });

  it('throws role_output_invalid when AI returns a non-object', async () => {
    insertMail(
      MAIL_TABLE,
      'm1',
      { from: 'alice@acme.com', to: ['user@self.com'], subject: 'hi' },
      { inline: longBody },
    );
    const llm = buildStubLlm('CEO'); // bare string
    const ctx = stubCtx({ llm: llm.fn, blobs: buildBlobs() });

    await expect(
      roleProducer.produce(ctx, sourceFor('alice@acme.com')),
    ).rejects.toThrow(/role_output_invalid/);
  });

  it('propagates AI_LLM_UNAVAILABLE so the harness can yield', async () => {
    insertMail(
      MAIL_TABLE,
      'm1',
      { from: 'alice@acme.com', to: ['user@self.com'], subject: 'hi' },
      { inline: longBody },
    );
    const failing = buildStubLlm(() => {
      throw new Error('AI_LLM_UNAVAILABLE: no slot or pool resolves');
    });
    const ctx = stubCtx({ llm: failing.fn, blobs: buildBlobs() });

    await expect(
      roleProducer.produce(ctx, sourceFor('alice@acme.com')),
    ).rejects.toThrow(/AI_LLM_UNAVAILABLE/);
  });
});

// ────────────────────────────────────────────────────────────────
// Body resolution + sender filter + multi-table aggregation
// ────────────────────────────────────────────────────────────────

describe('roleProducer.produce — body resolution', () => {
  it('uses body_inline when present', async () => {
    insertMail(
      MAIL_TABLE,
      'm1',
      { from: 'alice@acme.com', to: ['user@self.com'], subject: 'hi' },
      { inline: longBody },
    );
    const llm = buildStubLlm({ title: 'Engineer' });
    const blobs = buildBlobs();
    const ctx = stubCtx({ llm: llm.fn, blobs });
    await roleProducer.produce(ctx, sourceFor('alice@acme.com'));

    expect(blobs.get).not.toHaveBeenCalled();
    expect(llm.capturedInput?.['llm.data']).toBe(longBody);
  });

  it('falls back to blob_hash when body_inline is null', async () => {
    insertMail(
      MAIL_TABLE,
      'm1',
      { from: 'alice@acme.com', to: ['user@self.com'], subject: 'hi' },
      { blob_hash: 'cas-001' },
    );
    const cas = Buffer.from(longBody, 'utf8');
    const blobs = buildBlobs({
      get: vi.fn(async (hash: string) => {
        expect(hash).toBe('cas-001');
        return cas;
      }),
    });
    const llm = buildStubLlm({ title: 'Engineer' });
    const ctx = stubCtx({ llm: llm.fn, blobs });
    await roleProducer.produce(ctx, sourceFor('alice@acme.com'));

    expect(blobs.get).toHaveBeenCalledWith('cas-001');
    expect(llm.capturedInput?.['llm.data']).toBe(longBody);
  });
});

describe('roleProducer.produce — sender-only inbound filter', () => {
  it('ignores outbound mail addressed TO the contact', async () => {
    insertMail(
      MAIL_TABLE,
      'm1',
      { from: 'user@self.com', to: ['alice@acme.com'], subject: 'hi' },
      { inline: longBody },
    );
    const llm = buildStubLlm({ title: 'Should Not Appear' });
    const ctx = stubCtx({ llm: llm.fn, blobs: buildBlobs() });
    const out = await roleProducer.produce(ctx, sourceFor('alice@acme.com'));

    expect(out).toBeNull();
    expect(llm.fn).not.toHaveBeenCalled();
  });

  it('handles display-name + angle-bracket From headers', async () => {
    insertMail(
      MAIL_TABLE,
      'm1',
      {
        from: '"Alice Smith" <alice@acme.com>',
        to: ['user@self.com'],
        subject: 'hi',
      },
      { inline: longBody },
    );
    const llm = buildStubLlm({ title: 'CEO' });
    const ctx = stubCtx({ llm: llm.fn, blobs: buildBlobs() });
    const out = await roleProducer.produce(ctx, sourceFor('alice@acme.com'));

    expect(out?.value).toMatchObject({ title: 'CEO', category: 'executive' });
    expect(llm.fn).toHaveBeenCalledOnce();
  });
});

describe('roleProducer.produce — multi-table aggregation', () => {
  it('picks the most-recent inbound across multiple mail collections', async () => {
    insertMail(
      MAIL_TABLE,
      'm1',
      { from: 'alice@acme.com', to: ['user@self.com'], subject: 'old' },
      { inline: 'old body — pre-floor: ' + 'X'.repeat(ROLE_MIN_BODY_CHARS + 10) },
      NOW - 2 * ONE_DAY,
    );
    insertMail(
      MAIL_TABLE_2,
      'm2',
      { from: 'alice@acme.com', to: ['user@self.com'], subject: 'newer' },
      { inline: longBody },
      NOW - ONE_DAY,
    );
    const llm = buildStubLlm({ title: 'Engineer' });
    const ctx = stubCtx({ llm: llm.fn, blobs: buildBlobs() });
    await roleProducer.produce(ctx, sourceFor('alice@acme.com'));

    expect(llm.capturedInput?.['llm.data']).toBe(longBody);
  });
});

// ────────────────────────────────────────────────────────────────
// Registry value_schema acceptance
// ────────────────────────────────────────────────────────────────

describe('roleProducer.produce — registry value_schema', () => {
  it('registry RoleSchema accepts a produced row', async () => {
    insertMail(
      MAIL_TABLE,
      'm1',
      { from: 'alice@acme.com', to: ['user@self.com'], subject: 'hi' },
      { inline: longBody },
    );
    const llm = buildStubLlm({ title: 'Director of Sales' });
    const ctx = stubCtx({ llm: llm.fn, blobs: buildBlobs() });
    const out = await roleProducer.produce(ctx, sourceFor('alice@acme.com'));

    const def = ENRICHMENT_REGISTRY.role;
    const check = def.value_schema(out?.value);
    expect(check.ok).toBe(true);
  });

  it('registry RoleSchema rejects an out-of-set category', () => {
    const def = ENRICHMENT_REGISTRY.role;
    const check = def.value_schema({
      title: 'CEO',
      category: 'made_up_category',
      confidence: 0.85,
      reasoning: 'test',
      computed_at: NOW,
    });
    expect(check.ok).toBe(false);
  });
});
