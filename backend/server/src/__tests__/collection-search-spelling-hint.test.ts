/** `mail.search` and `calendar.search` say what they did with a word no record
 *  holds — and name the spelling on file when one is close.
 *
 *  ⛔ These stores RELAX a miss: a word their index does not hold is dropped and
 *  the rest is searched, so "Castelanos invoice" came back as every invoice, from
 *  every sender, looking like an answer. The hint is the only place that says the
 *  name was dropped. Through real mail and calendar collections and the handlers'
 *  own wrappers. */

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import type { CalendarCollectionCaps } from '@recued/contracts';

import { buildChatTier1Handlers } from '../chat-tool-handlers.js';
import { createCalendarCollection } from '../collections/calendar/calendar-collection.js';
import { createLocalCalendarProvider } from '../collections/calendar/local-provider.js';
import { createInstanceStore } from '../collections/instance-store.js';
import { createMailCollection } from '../collections/mail/mail-collection.js';
import { createCollectionRegistry } from '../collections/registry.js';
import type { Collection } from '../collections/types.js';
import { createBlobStore } from '../storage/blob-store.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const done of cleanups.splice(0).reverse()) await done(); });

const NOW = 1_800_000_000_000;
const QUOTA = 1 << 26;

const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'spelling-hint-'));
  const db = new Database(':memory:');
  cleanups.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { db, dir };
};

const mailbox = (slug: string, mails: Record<string, string>): Collection => {
  const { db, dir } = scratch();
  const mail = createMailCollection({
    db, blobs: createBlobStore(dir),
    gate: { addUsed: () => {}, getUsed: () => 0 } as never,
    bus: createWarehouseEventBus(), slug,
    provider: { start: async () => {}, stop: async () => {} } as never,
    config: () => ({ backfill_days: 3650, retention_days: 3650, quota_bytes: QUOTA }),
  });
  Object.entries(mails).forEach(([id, body], i) => {
    mail.upsert({
      record_id: `mail:${slug}-${id}`,
      hot_fields: { subject: id, from: `${id}@sender.test`, to: ['me@e.com'], cc: [], thread_id: `T-${id}` },
      received_at: NOW - i * 3_600_000, modified_at: NOW - i * 3_600_000,
      body_inline: body, size_bytes: body.length, source_id: slug,
    } as never);
  });
  return mail as unknown as Collection;
};

const calendar = (slug: string, summaries: string[]): Collection => {
  const { db, dir } = scratch();
  const instances = createInstanceStore({ db });
  instances.upsert({
    platform: 'calendar', slug, adapter_type: 'local', config: {},
    caps: { read: 'yes', search: 'local' } as CalendarCollectionCaps,
    auth_state: 'healthy', last_synced_at: null,
  });
  const collection = createCalendarCollection({
    db, blobs: createBlobStore(dir),
    gate: createStorageGate({ quota: QUOTA, reservePct: 10, surface: `collection:calendar:${slug}` }),
    bus: createWarehouseEventBus(), slug,
    provider: createLocalCalendarProvider({ slug, now: () => NOW, readEvent: () => null }),
    config: () => ({ backfill_days: 30, retention_days: 365, quota_bytes: QUOTA, expansion_past_days: 30, expansion_future_days: 90 }),
    instances,
  });
  cleanups.push(() => collection.close());
  summaries.forEach((summary, i) => {
    collection.table.upsert({
      event: {
        source_id: `ev${i}`, ical_uid: `ev${i}@x`, calendar_id: 'primary', summary,
        start_at: NOW + i * 86_400_000, end_at: NOW + i * 86_400_000 + 3_600_000, timezone: 'UTC',
        is_all_day: false, status: 'confirmed', attendees: [], created_at: NOW, updated_at: NOW,
      },
      size_bytes: 20, body_inline: `${summary}.`, now: NOW,
    } as never);
  });
  return collection as unknown as Collection;
};

const tools = (...collections: Collection[]) => {
  const registry = createCollectionRegistry();
  for (const c of collections) registry.register(c as never);
  const handlers = buildChatTier1Handlers({
    getContactStore: () => undefined,
    getCollectionRegistry: () => registry,
    getAuditLog: () => undefined,
    getEnrichmentStore: () => undefined,
    getRecipeStore: () => ({ ids: () => [], get: () => null, getStored: () => null, listStored: () => [] }) as never,
    getExecutorConfig: () => ({ manifests: { get: () => null } }) as never,
    getExecuteRecipe: () => undefined,
  } as never) as Record<string, (a: unknown, c: unknown) => Promise<unknown>>;
  const ctx = { channel: 'internal_function_call', session_id: 'S', turn_id: 'T' } as never;
  const call = async (tool: string, args: Record<string, unknown>) => {
    const r = await handlers[tool]!({ limit: 20, ...args }, ctx) as { ok: boolean; result: { matches: unknown[]; hint?: string } };
    expect(r.ok).toBe(true);
    return r.result;
  };
  return { mail: (args: Record<string, unknown>) => call('mail.search', args), calendar: (args: Record<string, unknown>) => call('calendar.search', args) };
};

const INBOX = {
  castellanos: 'Invoice for the March lease. Regards, Ana Castellanos',
  carlease: 'Invoice 2026-118 for your car lease, due on the 1st.',
  acme: 'Acme invoice for the printer cartridges.',
};

describe('mail.search — a word no email holds', () => {
  it('⛔ says the results match only the other words, and names the spelling on file', async () => {
    const { mail } = tools(mailbox('inbox', INBOX));
    const result = await mail({ query: 'Castelanos invoice' });
    // The store dropped the name and answered with every invoice.
    expect(result.matches.length).toBe(3);
    expect(result.hint).toBe('No email holds "Castelanos", so the results below match only the other '
      + 'words in the query. "Castellanos" is in 1 email. If that is who or what the owner meant, '
      + 'search again for "Castellanos", and begin your answer by telling the owner you read '
      + '"Castelanos" as "Castellanos": it may be a different name.');
  });

  it('⛔ with nothing close on file, still says the rows are not about that word', async () => {
    const { mail } = tools(mailbox('inbox', INBOX));
    const result = await mail({ query: 'Zylberstein invoice' });
    expect(result.matches.length).toBe(3);
    expect(result.hint).toBe('No email holds "Zylberstein", so the results below match only the other '
      + 'words in the query. Do not answer as if they were about "Zylberstein".');
  });

  it('names the spelling on file when nothing matched at all', async () => {
    const { mail } = tools(mailbox('inbox', INBOX));
    const result = await mail({ query: 'Castelanos' });
    expect(result.matches).toEqual([]);
    expect(result.hint).toMatch(/^No email holds "Castelanos"\. "Castellanos" is in 1 email\. If that is who or what the owner meant/u);
  });

  it('leaves the explicit empty alone when nothing matched and nothing is close', async () => {
    const { mail } = tools(mailbox('inbox', INBOX));
    const result = await mail({ query: 'Zylberstein' });
    expect(result.matches).toEqual([]);
    expect(result.hint).toMatch(/^mail\.search found nothing/u);
  });

  it('says nothing when every word is on file', async () => {
    const { mail } = tools(mailbox('inbox', INBOX));
    expect((await mail({ query: 'Castellanos invoice' })).hint).toBeUndefined();
  });

  it('⛔ leaves a word that another mailbox holds', async () => {
    const { mail } = tools(mailbox('inbox', INBOX), mailbox('work', { kestral: 'Kestral invoice for the offsite.' }));
    const result = await mail({ query: 'Kestral invoice' });
    expect(result.hint ?? '').not.toContain('No email holds');
  });

  it('says nothing for a search narrowed to one mailbox — the word may be in another', async () => {
    const { mail } = tools(mailbox('inbox', INBOX), mailbox('work', { castellanos: 'Castellanos lease renewal' }));
    const result = await mail({ query: 'Castelanos invoice', slug: 'inbox' });
    expect(result.hint ?? '').not.toContain('No email holds');
  });

  it('⛔ fails closed: a mailbox that cannot check its words means no hint at all', async () => {
    const real = mailbox('inbox', INBOX);
    const legacy = { ...real, slug: 'legacy', search: () => [], checkSpelling: undefined } as unknown as Collection;
    const { mail } = tools(real, legacy);
    const result = await mail({ query: 'Castelanos invoice' });
    expect(result.hint ?? '').not.toContain('No email holds');
  });
});

describe('calendar.search — a word no event holds', () => {
  it('names the spelling on file when nothing matched', async () => {
    const { calendar: search } = tools(calendar('default', ['Thornbury allotment visit', 'Dentist']));
    const result = await search({ query: 'Thornbry' });
    expect(result.matches).toEqual([]);
    expect(result.hint).toBe('No calendar event holds "Thornbry". "Thornbury" is in 1 calendar event. '
      + 'If that is who or what the owner meant, search again for "Thornbury", and begin your answer by '
      + 'telling the owner you read "Thornbry" as "Thornbury": it may be a different name.');
  });

  it('⛔ says the results match only the other words when the store relaxed the miss', async () => {
    const { calendar: search } = tools(calendar('default', ['Thornbury allotment visit', 'Site visit with the builder']));
    const result = await search({ query: 'Thornbry visit' });
    expect(result.matches.length).toBe(2);
    expect(result.hint).toMatch(/^No calendar event holds "Thornbry", so the results below match only the other words in the query\. "Thornbury" is in 1 calendar event\./u);
  });
});
