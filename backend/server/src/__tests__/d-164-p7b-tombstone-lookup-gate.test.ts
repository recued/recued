/** D-164 P7/P8 follow-up — `contactLookup` tombstone semantics over a REAL
 *  ContactStore (real D-138 merges via `setMergedInto`), end-to-end through
 *  `createPromptCacheGateDeps`.
 *
 *  Pins the person-level identity rules the multi-address count + the
 *  CRM-gated "no" both lean on:
 *    - a SAME-named tombstone is dropped (the survivor stands in) and its
 *      address joins the survivor's complete linked set → the mail count
 *      fires person-scoped across BOTH addresses;
 *    - a DIFFERENTLY-named tombstone stays as a name-only sentinel: it still
 *      breaks uniqueness against a live same-named contact, and when it is
 *      the SOLE match it can never render — not the P5 attribute, not the
 *      mail count, and (the round-1 Codex HIGH) not the has-email negative;
 *    - at-cap merged enumeration omits `emails` → the count defers;
 *    - a real-store mention-only contact renders the gated "no" (its
 *      complete linked set is provably empty) under no-CRM wiring. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CONTACT_ATTRIBUTE_TEMPLATES,
  CONTACT_HAS_EMAIL_TEMPLATE,
  CONTACT_HAS_NO_EMAIL_TEMPLATE,
  MAIL_FROM_COUNT_TEMPLATE,
} from '@recued/middleware-prompt-cache';

import { createPromptCacheGateDeps } from '../chat-prompt-cache-gate.js';
import { createContactStore, type ContactStore } from '../storage/contact-store.js';
import type { ConnectionStoreSqlite } from '../storage/connection-store.js';
import type { EnrichmentStore } from '../storage/enrichment-store.js';
import type { Collection } from '../collections/types.js';
import type { CollectionRegistry } from '../collections/registry.js';
import type { MailCollection } from '../collections/mail/mail-collection.js';

let dir: string;
let db: Database.Database;
let store: ContactStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tombstone-lookup-gate-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  store = createContactStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const seed = (email: string, name: string): void => {
  store.observe({ email, name, source: 'email_from', event_at: 1_000 }, 1_000);
};

const mergeInto = (loser: string, survivor: string): void => {
  const row = store.get(loser);
  expect(row).not.toBeNull();
  store.setMergedInto([row!], survivor, 2_000);
};

const slot = (value: string) =>
  ({ kind: 'entity.name', value, raw: value, position: 0 }) as const;

/** Fake mail registry: `countFrom` returns `counts[email] ?? 0`. */
const mailRegistry = (
  counts: Readonly<Record<string, number>>,
): { registry: CollectionRegistry; countFrom: ReturnType<typeof vi.fn> } => {
  const countFrom = vi.fn((email: string) => counts[email] ?? 0);
  const collection = {
    platform: 'mail',
    slug: 'work',
    countFrom,
  } as unknown as MailCollection as Collection;
  return {
    registry: { list: () => [collection] } as unknown as CollectionRegistry,
    countFrom,
  };
};

/** No CRM anywhere — the has-email negative may fire. */
const noCrm = {
  connections: { list: () => [] } as unknown as ConnectionStoreSqlite,
  enrichments: { listScopeMeta: () => [] } as unknown as EnrichmentStore,
};

const gateDeps = (registry?: CollectionRegistry) =>
  createPromptCacheGateDeps(
    () => store,
    () => registry,
    () => noCrm.connections,
    () => noCrm.enrichments,
  );

describe('same-named tombstone — survivor stands in, addresses union', () => {
  it('fires the mail count person-scoped across canonical + merged-away addresses', async () => {
    seed('pat@x.com', 'Pat Lee');
    seed('pat-old@x.com', 'Pat Lee');
    mergeInto('pat-old@x.com', 'pat@x.com');

    const { registry, countFrom } = mailRegistry({ 'pat@x.com': 3, 'pat-old@x.com': 2 });
    const snap = await gateDeps(registry).probeData({
      template: MAIL_FROM_COUNT_TEMPLATE,
      slots: [slot('Pat Lee')],
    });
    expect(snap?.data).toEqual({ name: 'Pat Lee', count: '5', count_phrase: '5 emails' });
    expect(countFrom.mock.calls.map((c) => c[0]).sort()).toEqual([
      'pat-old@x.com',
      'pat@x.com',
    ]);
  });

  it('two same-named tombstones into one survivor still resolve uniquely (all counted)', async () => {
    seed('pat@x.com', 'Pat Lee');
    seed('old-1@x.com', 'Pat Lee');
    seed('old-2@x.com', 'Pat Lee');
    mergeInto('old-1@x.com', 'pat@x.com');
    mergeInto('old-2@x.com', 'pat@x.com');

    const { registry } = mailRegistry({ 'pat@x.com': 1, 'old-1@x.com': 1, 'old-2@x.com': 1 });
    const snap = await gateDeps(registry).probeData({
      template: MAIL_FROM_COUNT_TEMPLATE,
      slots: [slot('Pat Lee')],
    });
    expect(snap?.data).toEqual({ name: 'Pat Lee', count: '3', count_phrase: '3 emails' });
  });
});

describe('differently-named tombstone — non-renderable ambiguity sentinel', () => {
  beforeEach(() => {
    // "Pat Old" was merged into the differently-named survivor "Patricia New".
    seed('patricia@x.com', 'Patricia New');
    seed('pat-old@x.com', 'Pat Old');
    mergeInto('pat-old@x.com', 'patricia@x.com');
  });

  it('never renders the has-email NEGATIVE for the former name (round-1 HIGH)', async () => {
    const snap = await gateDeps().probeData({
      template: CONTACT_HAS_EMAIL_TEMPLATE,
      slots: [slot('Pat Old')],
    });
    // The person behind "Pat Old" (now Patricia New) HAS an email — a
    // deterministic "no email on file for Pat Old" would be flatly wrong.
    expect(snap).toBeNull();
  });

  it('never renders the P5 attribute for the former name (no stale identity)', async () => {
    const deps = gateDeps();
    const snap = await deps.probeData({
      template: CONTACT_ATTRIBUTE_TEMPLATES.email,
      slots: [slot('Pat Old')],
    });
    // The sentinel resolves (it is the unique exact "Pat Old") but carries
    // no renderable fields → the email body empty-renders → pass-through.
    if (snap !== null) {
      expect(deps.renderTemplate(CONTACT_ATTRIBUTE_TEMPLATES.email, snap)).toBe('');
    }
  });

  it('defers the mail count for the former name (no emails claim on the sentinel)', async () => {
    const { registry, countFrom } = mailRegistry({ 'pat-old@x.com': 7 });
    const snap = await gateDeps(registry).probeData({
      template: MAIL_FROM_COUNT_TEMPLATE,
      slots: [slot('Pat Old')],
    });
    expect(snap).toBeNull();
    expect(countFrom).not.toHaveBeenCalled();
  });

  it('still breaks uniqueness against a LIVE contact with the same former name', async () => {
    seed('other-pat@x.com', 'Pat Old'); // an unrelated live "Pat Old"
    const { registry } = mailRegistry({ 'other-pat@x.com': 4 });
    const snap = await gateDeps(registry).probeData({
      template: MAIL_FROM_COUNT_TEMPLATE,
      slots: [slot('Pat Old')],
    });
    // Two candidates answer to "Pat Old" (the live one + the person formerly
    // known by it) → ambiguous → defer, never a guess.
    expect(snap).toBeNull();
  });

  it('the SURVIVOR still resolves and counts its merged-away address', async () => {
    const { registry } = mailRegistry({ 'patricia@x.com': 1, 'pat-old@x.com': 2 });
    const snap = await gateDeps(registry).probeData({
      template: MAIL_FROM_COUNT_TEMPLATE,
      slots: [slot('Patricia New')],
    });
    expect(snap?.data).toEqual({ name: 'Patricia New', count: '3', count_phrase: '3 emails' });
  });
});

describe('at-cap merged enumeration — completeness not provable', () => {
  it('omits the address set and defers the count when >= 64 sources merged in', async () => {
    seed('pat@x.com', 'Pat Lee');
    const losers = Array.from({ length: 64 }, (_, i) => `old-${i}@x.com`);
    for (const email of losers) seed(email, `Old Alias ${email}`);
    const rows = losers.map((e) => store.get(e)!);
    store.setMergedInto(rows, 'pat@x.com', 2_000);

    const { registry, countFrom } = mailRegistry({ 'pat@x.com': 9 });
    const snap = await gateDeps(registry).probeData({
      template: MAIL_FROM_COUNT_TEMPLATE,
      slots: [slot('Pat Lee')],
    });
    expect(snap).toBeNull();
    expect(countFrom).not.toHaveBeenCalled();
  });
});

describe('mention-only contact over the REAL store — the gated "no"', () => {
  it('renders the negative under no-CRM wiring (complete linked set provably empty)', async () => {
    store.createMentionOnlyContact({ name: 'Pat Lee' }, 1_500);
    const deps = gateDeps();
    const snap = await deps.probeData({
      template: CONTACT_HAS_EMAIL_TEMPLATE,
      slots: [slot('Pat Lee')],
    });
    expect(snap?.render_template_override?.template_hash).toBe(
      CONTACT_HAS_NO_EMAIL_TEMPLATE.template_hash,
    );
    const rendered = await deps.renderTemplate(
      snap!.render_template_override!,
      snap!,
    );
    expect(rendered).toBe("No, there's no email address on file for Pat Lee.");
  });

  it('a mention-only contact that ABSORBED a real-address merge defers instead (set not empty)', async () => {
    const stub = store.createMentionOnlyContact({ name: 'Pat Lee' }, 1_500);
    seed('pat-old@x.com', 'Pat Lee Old');
    mergeInto('pat-old@x.com', stub.email);

    const snap = await gateDeps().probeData({
      template: CONTACT_HAS_EMAIL_TEMPLATE,
      slots: [slot('Pat Lee')],
    });
    // A former real address is on file — a flat "no" would over-claim.
    expect(snap).toBeNull();
  });
});
