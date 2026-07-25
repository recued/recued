/** D-131 A.10 — `company` enrichment producer tests.
 *
 *  First AI-driven contact-scope producer. Mirrors the structural
 *  shape of `d-131-behavioral-signature-producer.test.ts` (live
 *  SQLite stack with `collection_mail_*` tables) for the body-fetch
 *  path, and the LLM-stub shape from `d-123-purpose-producer.test.ts`
 *  for the AI-signature-parse path.
 *
 *  Coverage:
 *    - Producer surface contract (topic / scope / ai_surface / token estimate)
 *    - Domain extractor + crude domain → name fallback
 *    - Free-mail short-circuit (no LLM call)
 *    - Business domain, no LLM wired (deterministic fallback)
 *    - Business domain, no body (deterministic fallback)
 *    - Business domain, body too short (deterministic fallback, no LLM call)
 *    - Business domain, body present, AI returns name (signature_parse)
 *    - Business domain, body present, AI returns null (no_signature fallback)
 *    - Body resolution: body_inline preferred, blob_hash fallback
 *    - Sender-only filter — outbound mail to the contact does not count
 *    - Aggregation across multiple mail collections
 *    - Malformed AI output throws company_output_invalid
 *    - Long body truncated before LLM call
 *    - Registry value_schema accepts the produced shape
 *    - Producer errors propagate (LLM unavailable) */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ENRICHMENT_REGISTRY,
  type ContactRecord,
  type IngredientManifest,
} from '@recued/contracts';

import {
  companyProducer,
  domainToCompanyName,
  extractDomain,
  FREE_MAIL_DOMAINS,
  MAX_COMPANY_NAME_CHARS,
  MIN_BODY_CHARS,
  // D-136 P1: CONFIDENCE_* no longer asserted on producer outputs
  // (confidence field stripped from CompanyValue — company is time_bound).
} from '../housekeeping/producers/company.js';
import type {
  HousekeepingContext,
  HousekeepingLlmExecute,
} from '../housekeeping/registry.js';
import type { SourceRecord } from '../housekeeping/source-walkers.js';
import type { BlobStore } from '../storage/blob-store.js';

// ────────────────────────────────────────────────────────────────
// Fixture infrastructure
// ────────────────────────────────────────────────────────────────

let dir: string;
let db: Database.Database;
const NOW = 1_700_000_000_000;
const ONE_DAY = 86_400_000;

const MAIL_TABLE = 'collection_mail_test';
const MAIL_TABLE_2 = 'collection_mail_other';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-131-company-'));
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
  // D-136 P3 — companyProducer reads `ctx.llmWithMeta`. Wrap so the
  // existing `llm` mock pipeline keeps working unchanged.
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

// ────────────────────────────────────────────────────────────────
// Producer surface contract
// ────────────────────────────────────────────────────────────────

describe('companyProducer surface contract', () => {
  it('targets the company registry topic', () => {
    expect(companyProducer.topic).toBe('company');
  });

  it('targets the contact source scope', () => {
    expect(companyProducer.source_scope).toBe('contact');
  });

  it('declares ai_surface=chat (signature parse routes through executeLLM)', () => {
    expect(companyProducer.ai_surface).toBe('chat');
  });

  it('declares positive token estimate so the harness flips to AI-surface', () => {
    expect(companyProducer.estimate_per_record_tokens()).toBeGreaterThan(0);
  });

  it('declares both data.contact and data.mail in scope_read_declaration', () => {
    const collections = companyProducer.scope_read_declaration.map((d) => d.collection);
    expect(collections).toContain('data.contact');
    expect(collections).toContain('data.mail');
  });

  it('company is time_bound — not PSI-eligible (D-136 P1 revoked emits_confidence)', () => {
    const def = ENRICHMENT_REGISTRY.company as { emits_confidence?: boolean };
    expect(def.emits_confidence).toBeUndefined();
  });

  it('registry default_trust_state is manual (AI producer)', () => {
    const def = ENRICHMENT_REGISTRY.company;
    expect(def.default_trust_state).toBe('manual');
  });

  it('registry default_pool_policy is free_only (cheap-and-noisy class)', () => {
    const def = ENRICHMENT_REGISTRY.company;
    expect(def.default_pool_policy).toBe('free_only');
  });
});

// ────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────

describe('extractDomain', () => {
  it('returns the domain part of a canonical email', () => {
    expect(extractDomain('alice@acme.com')).toBe('acme.com');
  });

  it('returns empty string for an input lacking @', () => {
    expect(extractDomain('not-an-email')).toBe('');
  });

  it('handles subdomains', () => {
    expect(extractDomain('alice@mail.acme.co.uk')).toBe('mail.acme.co.uk');
  });
});

describe('domainToCompanyName', () => {
  it('capitalizes a single-token apex', () => {
    expect(domainToCompanyName('google.com')).toBe('Google');
  });

  it('splits hyphens + capitalizes per token', () => {
    expect(domainToCompanyName('acme-corp.com')).toBe('Acme Corp');
  });

  it('splits underscores too', () => {
    expect(domainToCompanyName('acme_corp.com')).toBe('Acme Corp');
  });

  it('handles multiple hyphens', () => {
    expect(domainToCompanyName('big-bad-corp.com')).toBe('Big Bad Corp');
  });

  it('rejects all-numeric labels', () => {
    expect(domainToCompanyName('192.168.1.1')).toBeNull();
  });

  it('returns null for empty domain', () => {
    expect(domainToCompanyName('')).toBeNull();
  });
});

describe('FREE_MAIL_DOMAINS', () => {
  it('contains the obvious consumer providers', () => {
    expect(FREE_MAIL_DOMAINS.has('gmail.com')).toBe(true);
    expect(FREE_MAIL_DOMAINS.has('yahoo.com')).toBe(true);
    expect(FREE_MAIL_DOMAINS.has('hotmail.com')).toBe(true);
    expect(FREE_MAIL_DOMAINS.has('outlook.com')).toBe(true);
    expect(FREE_MAIL_DOMAINS.has('icloud.com')).toBe(true);
    expect(FREE_MAIL_DOMAINS.has('proton.me')).toBe(true);
  });

  it('does not contain business domains', () => {
    expect(FREE_MAIL_DOMAINS.has('acme.com')).toBe(false);
    expect(FREE_MAIL_DOMAINS.has('anthropic.com')).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// Empty / null cases
// ────────────────────────────────────────────────────────────────

describe('companyProducer.produce — empty / invalid contact', () => {
  it('returns null for a contact with empty email', async () => {
    const llm = buildStubLlm(null);
    const ctx = stubCtx({ llm: llm.fn, blobs: buildBlobs() });
    const out = await companyProducer.produce(
      ctx,
      sourceFor('', { email: '' }),
    );
    expect(out).toBeNull();
    expect(llm.fn).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────
// Branch 1: free-mail short-circuit
// ────────────────────────────────────────────────────────────────

describe('companyProducer.produce — free-mail provider', () => {
  it('returns a free_mail row with null company_name (D-136 P1: confidence stripped)', async () => {
    const llm = buildStubLlm(null);
    const ctx = stubCtx({ llm: llm.fn, blobs: buildBlobs() });
    const out = await companyProducer.produce(ctx, sourceFor('alice@gmail.com'));

    expect(out).not.toBeNull();
    expect(out?.value).toEqual({
      domain: 'gmail.com',
      company_name: null,
      source: 'domain_only',
      domain_category: 'free_mail',
      reasoning: expect.stringMatching(/Free-mail provider/i),
      computed_at: NOW,
    });
  });

  it('does not call the LLM for free-mail providers', async () => {
    const llm = buildStubLlm(null);
    const ctx = stubCtx({ llm: llm.fn, blobs: buildBlobs() });
    await companyProducer.produce(ctx, sourceFor('alice@gmail.com'));
    expect(llm.fn).not.toHaveBeenCalled();
  });

  it('matches yahoo / icloud / proton.me too', async () => {
    const llm = buildStubLlm(null);
    const ctx = stubCtx({ llm: llm.fn, blobs: buildBlobs() });
    for (const email of ['bob@yahoo.com', 'carol@icloud.com', 'dave@proton.me']) {
      const out = await companyProducer.produce(ctx, sourceFor(email));
      const value = out?.value as { domain_category: string; company_name: string | null };
      expect(value?.domain_category).toBe('free_mail');
      expect(value?.company_name).toBeNull();
    }
    expect(llm.fn).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────
// Branch 2: business domain — deterministic fallback
// ────────────────────────────────────────────────────────────────

describe('companyProducer.produce — deterministic fallback', () => {
  it('falls back to domain-derived name when ctx.llm is missing', async () => {
    const ctx = stubCtx({ blobs: buildBlobs() }); // no llm
    const out = await companyProducer.produce(ctx, sourceFor('bob@acme-corp.com'));

    // D-136 P1: confidence stripped from CompanyValue (time_bound topic).
    expect(out?.value).toEqual({
      domain: 'acme-corp.com',
      company_name: 'Acme Corp',
      source: 'domain_only',
      domain_category: 'business',
      reasoning: expect.stringMatching(/AI signature parsing not available/i),
      computed_at: NOW,
    });
  });

  it('falls back to domain-derived name when no inbound mail exists', async () => {
    const llm = buildStubLlm(null);
    const ctx = stubCtx({ llm: llm.fn, blobs: buildBlobs() });
    const out = await companyProducer.produce(ctx, sourceFor('bob@acme-corp.com'));

    // D-136 P1: confidence stripped from CompanyValue (time_bound topic).
    expect(out?.value).toMatchObject({
      domain: 'acme-corp.com',
      company_name: 'Acme Corp',
      source: 'domain_only',
      domain_category: 'business',
    });
    expect(llm.fn).not.toHaveBeenCalled();
  });

  it('skips the LLM when the most-recent body is below the floor', async () => {
    insertMail(
      MAIL_TABLE,
      'm1',
      { from: 'bob@acme-corp.com', to: ['user@self.com'], subject: 'hi' },
      { inline: 'too short' },
    );
    const llm = buildStubLlm(null);
    const ctx = stubCtx({ llm: llm.fn, blobs: buildBlobs() });
    const out = await companyProducer.produce(ctx, sourceFor('bob@acme-corp.com'));

    // D-136 P1: confidence stripped — assert only on source.
    expect(out?.value).toMatchObject({
      source: 'domain_only',
    });
    expect(llm.fn).not.toHaveBeenCalled();
  });

  it('records a domain_only row when even the deterministic fallback fails (D-136 P1: confidence stripped)', async () => {
    // All-numeric apex label rejected by `domainToCompanyName`.
    const ctx = stubCtx({ blobs: buildBlobs() });
    const out = await companyProducer.produce(
      ctx,
      sourceFor('bob@123.example.com'),
    );

    expect(out?.value).toMatchObject({
      domain: '123.example.com',
      company_name: null,
      source: 'domain_only',
      domain_category: 'business',
    });
  });
});

// ────────────────────────────────────────────────────────────────
// Branch 3: AI signature parse
// ────────────────────────────────────────────────────────────────

describe('companyProducer.produce — AI signature parse', () => {
  const longBody =
    'Hi team,\n\nThanks for the call yesterday. Attaching the revised deck for the ' +
    'Q4 launch — please review by Friday and let me know if you spot anything off ' +
    'in the projections.\n\nBest,\nBob Smith\nDirector of Sales\nAcme Corporation\n' +
    'bob@acme-corp.com\n';

  it('returns a signature_parse row when AI extracts a company name', async () => {
    insertMail(
      MAIL_TABLE,
      'm1',
      { from: 'bob@acme-corp.com', to: ['user@self.com'], subject: 'Q4 launch' },
      { inline: longBody },
    );
    const llm = buildStubLlm({ company_name: 'Acme Corporation' });
    const ctx = stubCtx({ llm: llm.fn, blobs: buildBlobs() });
    const out = await companyProducer.produce(ctx, sourceFor('bob@acme-corp.com'));

    // D-136 P1: confidence stripped from CompanyValue (time_bound topic).
    expect(out?.value).toEqual({
      domain: 'acme-corp.com',
      company_name: 'Acme Corporation',
      source: 'signature_parse',
      domain_category: 'business',
      reasoning: expect.stringMatching(/Parsed from signature/i),
      computed_at: NOW,
    });
  });

  it('passes the body through truncateForLlm + signature-priority context', async () => {
    insertMail(
      MAIL_TABLE,
      'm1',
      { from: 'bob@acme-corp.com', to: ['user@self.com'], subject: 'Q4 launch' },
      { inline: longBody },
    );
    const llm = buildStubLlm({ company_name: 'Acme Corporation' });
    const ctx = stubCtx({ llm: llm.fn, blobs: buildBlobs() });
    await companyProducer.produce(ctx, sourceFor('bob@acme-corp.com'));

    expect(llm.fn).toHaveBeenCalledOnce();
    expect(llm.capturedInput?.['llm.fields']).toEqual(['company_name']);
    expect(llm.capturedInput?.['llm.context']).toMatch(/signature block/i);
    expect(llm.capturedInput?.['llm.context']).toMatch(/Do NOT guess/i);
    expect(llm.capturedInput?.['llm.model_hint']).toBe('fast');
  });

  it('falls through to deterministic when AI returns null company_name', async () => {
    insertMail(
      MAIL_TABLE,
      'm1',
      { from: 'bob@acme-corp.com', to: ['user@self.com'], subject: 'Q4 launch' },
      { inline: longBody },
    );
    const llm = buildStubLlm({ company_name: null });
    const ctx = stubCtx({ llm: llm.fn, blobs: buildBlobs() });
    const out = await companyProducer.produce(ctx, sourceFor('bob@acme-corp.com'));

    // D-136 P1: confidence stripped from CompanyValue (time_bound topic).
    expect(out?.value).toMatchObject({
      domain: 'acme-corp.com',
      company_name: 'Acme Corp',
      source: 'domain_only',
      reasoning: expect.stringMatching(/no extractable signature/i),
    });
    expect(llm.fn).toHaveBeenCalledOnce();
  });

  it('caps company_name at MAX_COMPANY_NAME_CHARS', async () => {
    const huge = 'X'.repeat(MAX_COMPANY_NAME_CHARS + 50);
    insertMail(
      MAIL_TABLE,
      'm1',
      { from: 'bob@acme-corp.com', to: ['user@self.com'], subject: 'Q4 launch' },
      { inline: longBody },
    );
    const llm = buildStubLlm({ company_name: huge });
    const ctx = stubCtx({ llm: llm.fn, blobs: buildBlobs() });
    const out = await companyProducer.produce(ctx, sourceFor('bob@acme-corp.com'));

    const value = out?.value as { company_name: string | null };
    expect(value.company_name?.length).toBe(MAX_COMPANY_NAME_CHARS);
  });

  it('truncates very long bodies before LLM call', async () => {
    const huge = 'X'.repeat(80_000);
    insertMail(
      MAIL_TABLE,
      'm1',
      { from: 'bob@acme-corp.com', to: ['user@self.com'], subject: 'Q4 launch' },
      { inline: huge },
    );
    const llm = buildStubLlm({ company_name: 'Acme Corp' });
    const ctx = stubCtx({ llm: llm.fn, blobs: buildBlobs() });
    await companyProducer.produce(ctx, sourceFor('bob@acme-corp.com'));

    const passedData = llm.capturedInput?.['llm.data'] as string;
    expect(passedData.length).toBeLessThanOrEqual(32_000);
  });

  it('throws company_output_invalid on malformed AI shape (non-string company_name)', async () => {
    insertMail(
      MAIL_TABLE,
      'm1',
      { from: 'bob@acme-corp.com', to: ['user@self.com'], subject: 'Q4 launch' },
      { inline: longBody },
    );
    const llm = buildStubLlm({ company_name: 42 });
    const ctx = stubCtx({ llm: llm.fn, blobs: buildBlobs() });

    await expect(
      companyProducer.produce(ctx, sourceFor('bob@acme-corp.com')),
    ).rejects.toThrow(/company_output_invalid/);
  });

  it('throws company_output_invalid when AI returns a non-object', async () => {
    insertMail(
      MAIL_TABLE,
      'm1',
      { from: 'bob@acme-corp.com', to: ['user@self.com'], subject: 'Q4 launch' },
      { inline: longBody },
    );
    const llm = buildStubLlm('Acme Corp'); // bare string, not { company_name: ... }
    const ctx = stubCtx({ llm: llm.fn, blobs: buildBlobs() });

    await expect(
      companyProducer.produce(ctx, sourceFor('bob@acme-corp.com')),
    ).rejects.toThrow(/company_output_invalid/);
  });

  it('propagates LLM errors so the harness records them', async () => {
    insertMail(
      MAIL_TABLE,
      'm1',
      { from: 'bob@acme-corp.com', to: ['user@self.com'], subject: 'Q4 launch' },
      { inline: longBody },
    );
    const failing = buildStubLlm(() => {
      throw new Error('AI_LLM_UNAVAILABLE: no slot or pool resolves');
    });
    const ctx = stubCtx({ llm: failing.fn, blobs: buildBlobs() });

    await expect(
      companyProducer.produce(ctx, sourceFor('bob@acme-corp.com')),
    ).rejects.toThrow(/AI_LLM_UNAVAILABLE/);
  });
});

// ────────────────────────────────────────────────────────────────
// Body resolution
// ────────────────────────────────────────────────────────────────

describe('companyProducer.produce — body resolution', () => {
  const longBody = 'Hi,\n\n' + 'X'.repeat(MIN_BODY_CHARS + 50);

  it('uses body_inline when present', async () => {
    insertMail(
      MAIL_TABLE,
      'm1',
      { from: 'bob@acme-corp.com', to: ['user@self.com'], subject: 'hi' },
      { inline: longBody },
    );
    const llm = buildStubLlm({ company_name: 'Acme Corp' });
    const blobs = buildBlobs();
    const ctx = stubCtx({ llm: llm.fn, blobs });
    await companyProducer.produce(ctx, sourceFor('bob@acme-corp.com'));

    expect(blobs.get).not.toHaveBeenCalled();
    expect(llm.capturedInput?.['llm.data']).toBe(longBody);
  });

  it('falls back to blob_hash when body_inline is null', async () => {
    insertMail(
      MAIL_TABLE,
      'm1',
      { from: 'bob@acme-corp.com', to: ['user@self.com'], subject: 'hi' },
      { blob_hash: 'cas-hash-001' },
    );
    const cas = Buffer.from(longBody, 'utf8');
    const blobs = buildBlobs({
      get: vi.fn(async (hash: string) => {
        expect(hash).toBe('cas-hash-001');
        return cas;
      }),
    });
    const llm = buildStubLlm({ company_name: 'Acme Corp' });
    const ctx = stubCtx({ llm: llm.fn, blobs });
    await companyProducer.produce(ctx, sourceFor('bob@acme-corp.com'));

    expect(blobs.get).toHaveBeenCalledWith('cas-hash-001');
    expect(llm.capturedInput?.['llm.data']).toBe(longBody);
  });

  it('skips rows with neither inline nor blob and uses next-most-recent', async () => {
    // Row 1 — newer, but no body
    insertMail(
      MAIL_TABLE,
      'm1',
      { from: 'bob@acme-corp.com', to: ['user@self.com'], subject: 'no body' },
      {},
      NOW,
    );
    // Row 2 — older, has body
    insertMail(
      MAIL_TABLE,
      'm2',
      { from: 'bob@acme-corp.com', to: ['user@self.com'], subject: 'old' },
      { inline: longBody },
      NOW - ONE_DAY,
    );
    const llm = buildStubLlm({ company_name: 'Acme Corp' });
    const ctx = stubCtx({ llm: llm.fn, blobs: buildBlobs() });
    const out = await companyProducer.produce(ctx, sourceFor('bob@acme-corp.com'));

    expect(out?.value).toMatchObject({ source: 'signature_parse' });
    expect(llm.capturedInput?.['llm.data']).toBe(longBody);
  });
});

// ────────────────────────────────────────────────────────────────
// Sender filtering
// ────────────────────────────────────────────────────────────────

describe('companyProducer.produce — sender-only inbound filter', () => {
  const longBody = 'Hi,\n\n' + 'X'.repeat(MIN_BODY_CHARS + 50);

  it('ignores outbound mail addressed TO the contact (different sender)', async () => {
    // Mail FROM the user TO the contact — has a body, but it's the
    // user's signature, not the contact's.
    insertMail(
      MAIL_TABLE,
      'm1',
      { from: 'user@self.com', to: ['bob@acme-corp.com'], subject: 'hello' },
      { inline: longBody },
    );
    const llm = buildStubLlm({ company_name: 'Should Not Appear' });
    const ctx = stubCtx({ llm: llm.fn, blobs: buildBlobs() });
    const out = await companyProducer.produce(ctx, sourceFor('bob@acme-corp.com'));

    // No inbound from the contact → deterministic fallback, no LLM.
    expect(out?.value).toMatchObject({
      source: 'domain_only',
      company_name: 'Acme Corp',
    });
    expect(llm.fn).not.toHaveBeenCalled();
  });

  it('handles display-name + angle-bracket From headers', async () => {
    insertMail(
      MAIL_TABLE,
      'm1',
      {
        from: '"Bob Smith" <bob@acme-corp.com>',
        to: ['user@self.com'],
        subject: 'hi',
      },
      { inline: longBody },
    );
    const llm = buildStubLlm({ company_name: 'Acme Corp' });
    const ctx = stubCtx({ llm: llm.fn, blobs: buildBlobs() });
    const out = await companyProducer.produce(ctx, sourceFor('bob@acme-corp.com'));

    expect(out?.value).toMatchObject({ source: 'signature_parse' });
    expect(llm.fn).toHaveBeenCalledOnce();
  });
});

// ────────────────────────────────────────────────────────────────
// Multi-table aggregation
// ────────────────────────────────────────────────────────────────

describe('companyProducer.produce — multi-table aggregation', () => {
  const longBody = 'Hi,\n\n' + 'X'.repeat(MIN_BODY_CHARS + 50);

  it('picks the most-recent inbound across multiple mail collections', async () => {
    insertMail(
      MAIL_TABLE,
      'm1',
      { from: 'bob@acme-corp.com', to: ['user@self.com'], subject: 'old' },
      { inline: 'old body — pre-floor: ' + 'X'.repeat(MIN_BODY_CHARS + 10) },
      NOW - 2 * ONE_DAY,
    );
    insertMail(
      MAIL_TABLE_2,
      'm2',
      { from: 'bob@acme-corp.com', to: ['user@self.com'], subject: 'newer' },
      { inline: longBody },
      NOW - ONE_DAY,
    );
    const llm = buildStubLlm({ company_name: 'Acme Corp from newer table' });
    const ctx = stubCtx({ llm: llm.fn, blobs: buildBlobs() });
    await companyProducer.produce(ctx, sourceFor('bob@acme-corp.com'));

    expect(llm.capturedInput?.['llm.data']).toBe(longBody);
  });
});

// ────────────────────────────────────────────────────────────────
// Registry value_schema acceptance
// ────────────────────────────────────────────────────────────────

describe('companyProducer.produce — registry value_schema', () => {
  const longBody = 'Hi,\n\n' + 'X'.repeat(MIN_BODY_CHARS + 50);

  it("registry CompanySchema accepts every branch's output", async () => {
    const def = ENRICHMENT_REGISTRY.company;

    // Free-mail
    const freeMailCtx = stubCtx({ blobs: buildBlobs() });
    const freeMailOut = await companyProducer.produce(
      freeMailCtx,
      sourceFor('alice@gmail.com'),
    );
    const freeMailCheck = def.value_schema(freeMailOut?.value);
    expect(freeMailCheck.ok).toBe(true);

    // Domain-only fallback
    const fallbackCtx = stubCtx({ blobs: buildBlobs() });
    const fallbackOut = await companyProducer.produce(
      fallbackCtx,
      sourceFor('bob@acme-corp.com'),
    );
    const fallbackCheck = def.value_schema(fallbackOut?.value);
    expect(fallbackCheck.ok).toBe(true);

    // Signature parse
    insertMail(
      MAIL_TABLE,
      'm1',
      { from: 'carol@delta-co.com', to: ['user@self.com'], subject: 'hi' },
      { inline: longBody },
    );
    const aiLlm = buildStubLlm({ company_name: 'Delta Co' });
    const aiCtx = stubCtx({ llm: aiLlm.fn, blobs: buildBlobs() });
    const aiOut = await companyProducer.produce(
      aiCtx,
      sourceFor('carol@delta-co.com'),
    );
    const aiCheck = def.value_schema(aiOut?.value);
    expect(aiCheck.ok).toBe(true);
  });
});
