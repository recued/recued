/** D-184 Decision 2 — live CRM-email ↔ data.mail twin resolution.
 *
 *  Covers the three moving parts of the decision:
 *    1. Mail substrate capture — inbound providers populate the RFC822
 *       `rfc_message_id`; `buildRecord` stores it as a NORMALIZED hot
 *       field (the join key).
 *    2. `createMailTwinResolver` — the batched `data.mail` lookup over
 *       `rfc_message_id` (angle-bracket tolerant, deterministic pick).
 *    3. The engagements resolver flips email rows to `body_state:
 *       'mail_link'` + `mail_twin_id` LIVE at read time — so add/remove-
 *       mailbox-later is correct by construction, no re-ingest.
 *
 *  Spec: D-184
 *  § Decision 2; decisions-log § D-184. */

import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';

import type { CollectionRecord, EngagementRow } from '@recued/contracts';
import {
  createEngagementStore,
  type MailTwinResolver,
} from '../storage/engagement-store.js';
import { createCollectionTable } from '../collections/table.js';
import { createMailTwinResolver } from '../collections/mail/mail-twin-resolver.js';
import { buildRecord } from '../collections/mail/mail-collection.js';
import {
  normalizeRfcMessageId,
  type CanonicalMessage,
} from '../collections/mail/provider.js';
import { canonicalizeGraph } from '../collections/mail/graph-provider.js';
import { canonicalizeGmail } from '../collections/mail/gmail-provider.js';
import { canonicalizeImap } from '../collections/mail/imap-provider.js';

const NOW = 1_714_867_300_000;
const inMemoryDb = (): Database.Database => new Database(':memory:');

const emptyCoverage = () => ({
  sources_connected: [],
  sources_unavailable: [],
  sources_stale: [],
  sources_degraded: [],
  row_counts: {},
  last_source_event_at: 0,
});

const emailRow = (overrides: Partial<EngagementRow> = {}): EngagementRow => ({
  connection_id: 'acme-hubspot',
  target_id: 'hubspot_email_1',
  vendor: 'hubspot',
  entity: 'email',
  meta: { message_id: '<msg-1@example.com>' },
  mirror_blob_hash: null,
  authorship: 'user',
  direction: 'outbound',
  dedupe_confidence: 'none',
  lifecycle_state: 'point_in_time',
  event_at: 1_714_867_200_000,
  vendor_created_at: 1_714_867_200_000,
  vendor_modified_at: 1_714_867_200_500,
  ingested_at: 1_714_867_200_600,
  body_state: 'inline_body',
  body_inline: 'CRM-side inline copy',
  ...overrides,
});

const seedEmailEngagement = (
  store: ReturnType<typeof createEngagementStore>,
  row: EngagementRow,
  contactEmail = 'bob@acme.com',
): void => {
  store.upsert({ row });
  store.upsertEdge({
    connection_id: row.connection_id,
    engagement_target_id: row.target_id,
    edge_type: 'contact',
    resolveContactRedirect: () => null,
    target_kind: 'data.contact',
    target_id: contactEmail,
    created_at: 1,
  });
};

const resolveOne = (
  store: ReturnType<typeof createEngagementStore>,
  resolveMailTwins?: MailTwinResolver,
) =>
  store.resolveEngagementsForContact(
    { email: 'bob@acme.com', since: 0 },
    {
      resolveContactRedirect: () => null,
      expandContactIdentity: (s) => [s],
      now: () => NOW,
      coverage: emptyCoverage(),
      ...(resolveMailTwins ? { resolveMailTwins } : {}),
    },
  );

const mailMsg = (overrides: Partial<CanonicalMessage> = {}): CanonicalMessage => ({
  source_id: 'uid:1@INBOX',
  rfc_message_id: '<msg-1@example.com>',
  from: 'bob@acme.com',
  to: ['alice@recued.com'],
  cc: [],
  subject: 'Re: Quarterly review',
  thread_id: 'thread-1',
  folder_or_label: 'INBOX',
  is_read: true,
  has_attachments: false,
  received_at: 1_714_867_200_000,
  body_text: 'Full untruncated mail body lives here.',
  ...overrides,
});

// ────────────────────────────────────────────────────────────────
// 1. Mail substrate capture
// ────────────────────────────────────────────────────────────────

describe('D-184 Decision 2 — mail substrate captures RFC822 Message-ID', () => {
  const rfc822 = (messageId: string): string =>
    [
      `Message-ID: ${messageId}`,
      'From: bob@acme.com',
      'To: alice@recued.com',
      'Subject: Hi',
      'Date: Mon, 04 May 2026 08:00:00 +0000',
      '',
      'Body text.',
      '',
    ].join('\r\n');

  it('canonicalizeGraph carries internetMessageId → rfc_message_id', () => {
    const canonical = canonicalizeGraph({
      id: 'graph-native-id',
      internetMessageId: '<graph-msg-1@outlook.com>',
      subject: 'Hi',
      from: { emailAddress: { address: 'bob@acme.com' } },
      receivedDateTime: '2026-05-04T08:00:00Z',
    });
    expect(canonical.source_id).toBe('graph-native-id');
    expect(normalizeRfcMessageId(canonical.rfc_message_id)).toBe(
      'graph-msg-1@outlook.com',
    );
  });

  it('canonicalizeGmail parses the Message-ID off the raw RFC822', async () => {
    const canonical = await canonicalizeGmail({
      id: 'gmail-native-id',
      threadId: 'thread-1',
      raw: Buffer.from(rfc822('<gmail-msg-1@mail.gmail.com>'), 'utf8').toString(
        'base64url',
      ),
    });
    expect(canonical.source_id).toBe('gmail-native-id');
    expect(normalizeRfcMessageId(canonical.rfc_message_id)).toBe(
      'gmail-msg-1@mail.gmail.com',
    );
  });

  it('canonicalizeImap parses the Message-ID off the source', async () => {
    const canonical = await canonicalizeImap(
      Buffer.from(rfc822('<imap-msg-1@mail.example>'), 'utf8'),
      { uid: 7, folder: 'INBOX', flags: new Set(['\\Seen']), internalDate: undefined },
    );
    expect(canonical.source_id).toBe('7@INBOX');
    expect(normalizeRfcMessageId(canonical.rfc_message_id)).toBe(
      'imap-msg-1@mail.example',
    );
  });

  it('buildRecord stores a NORMALIZED rfc_message_id hot field, distinct from message_id (=source_id)', () => {
    const { record } = buildRecord(
      mailMsg({ source_id: 'uid:9@INBOX', rfc_message_id: '<x@host>' }),
      () => NOW,
    );
    // The provider-native id stays on the legacy `message_id` hot field…
    expect(record.hot_fields.message_id).toBe('uid:9@INBOX');
    // …and the normalized RFC822 id lands on the new join-key hot field.
    expect(record.hot_fields.rfc_message_id).toBe('x@host');
  });

  it('buildRecord omits rfc_message_id when the provider exposed none', () => {
    const { record } = buildRecord(
      mailMsg({ rfc_message_id: undefined }),
      () => NOW,
    );
    expect('rfc_message_id' in record.hot_fields).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// 2. createMailTwinResolver — the batched data.mail lookup
// ────────────────────────────────────────────────────────────────

describe('D-184 Decision 2 — createMailTwinResolver', () => {
  const mailTable = () => {
    const db = inMemoryDb();
    return createCollectionTable({ db, platform: 'mail', slug: 'work' });
  };

  it('matches an angle-bracketed engagement Message-ID to a bare stored rfc_message_id', () => {
    const table = mailTable();
    const { record } = buildRecord(
      mailMsg({ source_id: 'uid:1@INBOX', rfc_message_id: '<msg-1@example.com>' }),
      () => NOW,
    );
    table.upsert(record);
    const resolver = createMailTwinResolver(table);
    // Engagement carries the angle-bracketed form; stored hot field is bare.
    const map = resolver(['<msg-1@example.com>']);
    expect(map.get('<msg-1@example.com>')).toBe(record.record_id);
  });

  it('returns nothing for an unmatched Message-ID or empty input', () => {
    const table = mailTable();
    const resolver = createMailTwinResolver(table);
    expect(resolver(['<nope@example.com>']).size).toBe(0);
    expect(resolver([]).size).toBe(0);
  });

  it('deterministically picks the most-recent mail row when two share a Message-ID', () => {
    const table = mailTable();
    const older = buildRecord(
      mailMsg({
        source_id: 'uid:1@Sent',
        rfc_message_id: '<dup@example.com>',
        received_at: 1_000,
      }),
      () => NOW,
    ).record;
    const newer = buildRecord(
      mailMsg({
        source_id: 'uid:2@INBOX',
        rfc_message_id: '<dup@example.com>',
        received_at: 2_000,
      }),
      () => NOW,
    ).record;
    table.upsert(older);
    table.upsert(newer);
    const map = createMailTwinResolver(table)(['<dup@example.com>']);
    // received_at DESC → the newer (INBOX) copy wins.
    expect(map.get('<dup@example.com>')).toBe(newer.record_id);
  });
});

// ────────────────────────────────────────────────────────────────
// 3. Resolver flips body_state → mail_link LIVE at read time
// ────────────────────────────────────────────────────────────────

describe('D-184 Decision 2 — engagements resolver live mail-twin flip', () => {
  /** A static resolver that maps any of `ids` to a fixed mail id. */
  const fixedResolver = (
    map: Record<string, string>,
  ): MailTwinResolver => (ids) => {
    const out = new Map<string, string>();
    for (const id of ids) if (map[id]) out.set(id, map[id]!);
    return out;
  };

  it('Case 1 — twin exists → body_state mail_link, mail_twin_id set, CRM inline body dropped', () => {
    const store = createEngagementStore(inMemoryDb());
    seedEmailEngagement(
      store,
      emailRow({
        body_state: 'inline_body',
        body_inline: 'CRM-side inline copy',
        body_truncation_offset: 4096,
        meta: { message_id: '<msg-1@example.com>' },
      }),
    );
    const result = resolveOne(
      store,
      fixedResolver({ '<msg-1@example.com>': 'mail:42' }),
    );
    expect(result.engagements).toHaveLength(1);
    const row = result.engagements[0]!;
    expect(row.body_state).toBe('mail_link');
    expect(row.mail_twin_id).toBe('mail:42');
    // The local mail row is authoritative — no CRM body duplication.
    expect(row.body_inline).toBeUndefined();
    expect(row.body_truncation_offset).toBeUndefined();
  });

  it('Case 2 — no resolver dep wired → row keeps its as-ingested body_state', () => {
    const store = createEngagementStore(inMemoryDb());
    seedEmailEngagement(store, emailRow());
    const result = resolveOne(store); // no resolveMailTwins
    const row = result.engagements[0]!;
    expect(row.body_state).toBe('inline_body');
    expect(row.mail_twin_id).toBeUndefined();
    expect(row.body_inline).toBe('CRM-side inline copy');
  });

  it('Case 2 — resolver wired but no local twin → row keeps inline_body', () => {
    const store = createEngagementStore(inMemoryDb());
    seedEmailEngagement(store, emailRow());
    const result = resolveOne(store, fixedResolver({})); // matches nothing
    const row = result.engagements[0]!;
    expect(row.body_state).toBe('inline_body');
    expect(row.mail_twin_id).toBeUndefined();
  });

  it('Case 3 — add/remove mailbox later is correct BY CONSTRUCTION (same stored row, re-read)', () => {
    const store = createEngagementStore(inMemoryDb());
    seedEmailEngagement(store, emailRow());

    // Before the mailbox is connected: no twin.
    expect(resolveOne(store, fixedResolver({})).engagements[0]!.body_state).toBe(
      'inline_body',
    );
    // Mailbox connected → twin appears live, no re-ingest of the engagement.
    const added = resolveOne(
      store,
      fixedResolver({ '<msg-1@example.com>': 'mail:99' }),
    ).engagements[0]!;
    expect(added.body_state).toBe('mail_link');
    expect(added.mail_twin_id).toBe('mail:99');
    // Mailbox removed → the join no longer matches → back to inline_body.
    expect(resolveOne(store, fixedResolver({})).engagements[0]!.body_state).toBe(
      'inline_body',
    );
  });

  it('flips a Salesforce email_message row too', () => {
    const store = createEngagementStore(inMemoryDb());
    seedEmailEngagement(
      store,
      emailRow({
        connection_id: 'acme-sf',
        target_id: 'salesforce_email_message_02s1',
        vendor: 'salesforce',
        entity: 'email_message',
        meta: { message_id: '<sf-msg@acme.com>' },
      }),
    );
    const row = resolveOne(
      store,
      fixedResolver({ '<sf-msg@acme.com>': 'mail:7' }),
    ).engagements[0]!;
    expect(row.body_state).toBe('mail_link');
    expect(row.mail_twin_id).toBe('mail:7');
  });

  it('does NOT flip a non-email engagement even if its meta carries a message_id', () => {
    const store = createEngagementStore(inMemoryDb());
    seedEmailEngagement(
      store,
      emailRow({
        target_id: 'hubspot_note_1',
        entity: 'note',
        body_state: 'inline_body',
        meta: { message_id: '<msg-1@example.com>' },
      }),
    );
    const row = resolveOne(
      store,
      fixedResolver({ '<msg-1@example.com>': 'mail:42' }),
    ).engagements[0]!;
    expect(row.body_state).toBe('inline_body');
    expect(row.mail_twin_id).toBeUndefined();
  });

  it('end-to-end: createMailTwinResolver over data.mail flips the engagement row', () => {
    const store = createEngagementStore(inMemoryDb());
    seedEmailEngagement(
      store,
      emailRow({ meta: { message_id: '<e2e-msg@example.com>' } }),
    );
    const table = createCollectionTable({
      db: inMemoryDb(),
      platform: 'mail',
      slug: 'work',
    });
    const { record } = buildRecord(
      mailMsg({ source_id: 'uid:55@INBOX', rfc_message_id: '<e2e-msg@example.com>' }),
      () => NOW,
    );
    table.upsert(record);
    const row = resolveOne(store, createMailTwinResolver(table)).engagements[0]!;
    expect(row.body_state).toBe('mail_link');
    expect(row.mail_twin_id).toBe(record.record_id);
  });
});

// ────────────────────────────────────────────────────────────────
// normalizeRfcMessageId unit behavior
// ────────────────────────────────────────────────────────────────

describe('D-184 Decision 2 — normalizeRfcMessageId', () => {
  it('strips one pair of surrounding angle brackets + trims', () => {
    expect(normalizeRfcMessageId('  <id@host>  ')).toBe('id@host');
    expect(normalizeRfcMessageId('id@host')).toBe('id@host');
  });
  it('preserves case (Message-IDs are case-sensitive)', () => {
    expect(normalizeRfcMessageId('<Id@Host.COM>')).toBe('Id@Host.COM');
  });
  it('returns undefined for empty / missing / bracket-only', () => {
    expect(normalizeRfcMessageId('')).toBeUndefined();
    expect(normalizeRfcMessageId('   ')).toBeUndefined();
    expect(normalizeRfcMessageId(null)).toBeUndefined();
    expect(normalizeRfcMessageId(undefined)).toBeUndefined();
    expect(normalizeRfcMessageId('<>')).toBeUndefined();
  });
});
