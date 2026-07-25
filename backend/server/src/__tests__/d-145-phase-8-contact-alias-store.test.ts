/** D-145 PA8 — contact_alias storage substrate tests.
 *
 *  Covers:
 *    - schema install: contact_id column + identity_status column +
 *      network_domain column + contact_alias table + partial unique
 *      indexes (chat per-contact / platform per-contact / platform
 *      global)
 *    - default identity_status = 'verified' on existing observe path
 *    - mention_only contact creation with synthetic placeholder email
 *    - alias upsert (chat + platform) idempotency on the partial unique
 *      indexes
 *    - cross-contact platform_id silent-dual-attach refusal
 *    - delete + list + kind-filtered list
 *    - resolveContactReference end-to-end through the storage closure
 *      pack (chat single, chat ambiguous + recent_contacts narrowing,
 *      platform_id exact-match)
 *    - last_resolved_at bookkeeping bumps on resolve
 *    - network_domain set / replace
 *
 *  Spec: D-145 § A.4. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONTACT_ALIAS_TABLE,
  MENTION_ONLY_EMAIL_DOMAIN,
  MENTION_ONLY_EMAIL_PREFIX,
  createContactStore,
  ensureContactSchema,
  isMentionOnlyEmail,
  type ContactStore,
} from '../storage/contact-store.js';

let dir: string;
let db: Database.Database;
let store: ContactStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa8-alias-store-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  store = createContactStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('D-145 PA8 — schema (§ A.4 + § A.4.3)', () => {
  it('contacts table gains contact_id + identity_status + network_domain', () => {
    ensureContactSchema(db);
    const cols = (db.prepare(`PRAGMA table_info(contacts)`).all() as { name: string }[])
      .map((r) => r.name);
    expect(cols).toContain('contact_id');
    expect(cols).toContain('identity_status');
    expect(cols).toContain('network_domain');
  });

  it('contact_alias table is born with the partial unique indexes', () => {
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
      .all(CONTACT_ALIAS_TABLE) as { name: string }[];
    expect(tables.length).toBe(1);
    const idx = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?`)
      .all(CONTACT_ALIAS_TABLE) as { name: string }[];
    const names = idx.map((r) => r.name);
    expect(names).toContain('uq_contact_alias_chat');
    expect(names).toContain('uq_contact_alias_platform_per_contact');
    expect(names).toContain('uq_contact_alias_platform_global');
    expect(names).toContain('idx_chat_alias_pattern');
    expect(names).toContain('idx_platform_id_lookup');
  });

  it('contact_id index uniqueness — no two contacts share the id', () => {
    const c1 = store.observe({ email: 'a@x.com', source: 'manual', event_at: 1 });
    const c2 = store.observe({ email: 'b@x.com', source: 'manual', event_at: 1 });
    expect(c1.contact_id).toBeTypeOf('string');
    expect(c2.contact_id).toBeTypeOf('string');
    expect(c1.contact_id).not.toBe(c2.contact_id);
  });

  it('observe path defaults identity_status to verified', () => {
    const c = store.observe({ email: 'a@x.com', source: 'manual', event_at: 1 });
    expect(c.identity_status).toBe('verified');
    expect(c.network_domain).toEqual([]);
  });

  it('schema is idempotent on repeated ensure', () => {
    ensureContactSchema(db);
    ensureContactSchema(db);
    ensureContactSchema(db);
    // No-op: still single contacts table; still single contact_alias.
    const t = db
      .prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='contacts'`)
      .get() as { n: number };
    expect(t.n).toBe(1);
  });
});

describe('D-145 PA8 — mention_only contact creation (§ A.4.6)', () => {
  it('synthetic placeholder email follows mention-only-{id}@_recued.invalid', () => {
    const c = store.createMentionOnlyContact({ name: 'Mom' });
    expect(c.identity_status).toBe('mention_only');
    expect(isMentionOnlyEmail(c.email)).toBe(true);
    expect(c.email.startsWith(MENTION_ONLY_EMAIL_PREFIX)).toBe(true);
    expect(c.email.endsWith(`@${MENTION_ONLY_EMAIL_DOMAIN}`)).toBe(true);
    expect(c.contact_id).toBeTypeOf('string');
    expect(c.contact_id!.length).toBeGreaterThan(0);
    expect(c.name).toBe('Mom');
  });

  it('multiple mention_only stubs each get unique contact_ids + emails', () => {
    const a = store.createMentionOnlyContact({ name: 'Mom' });
    const b = store.createMentionOnlyContact({ name: 'Sister' });
    expect(a.contact_id).not.toBe(b.contact_id);
    expect(a.email).not.toBe(b.email);
  });

  it('initial network_domain is validated + persisted', () => {
    const c = store.createMentionOnlyContact({
      name: 'Mom',
      network_domain: ['family'],
    });
    expect(c.network_domain).toEqual(['family']);
  });

  it('rejects unknown network_domain values', () => {
    expect(() =>
      store.createMentionOnlyContact({
        name: 'X',
        network_domain: ['hobby'] as unknown as readonly ('family' | 'work')[],
      }),
    ).toThrow(/network_domain_unknown/);
  });

  it('rejects empty / whitespace-only name (Codex P1 fold — § A.4.1 validator gate)', () => {
    expect(() =>
      store.createMentionOnlyContact({ name: '' }),
    ).toThrow(/mention_only_name_required/);
    expect(() =>
      store.createMentionOnlyContact({ name: '   ' }),
    ).toThrow(/mention_only_name_required/);
    expect(() =>
      store.createMentionOnlyContact({} as unknown as { name: string }),
    ).toThrow(/mention_only_name_required/);
  });

  it('getByContactId retrieves the row', () => {
    const c = store.createMentionOnlyContact({ name: 'Mom' });
    const fetched = store.getByContactId(c.contact_id!);
    expect(fetched?.contact_id).toBe(c.contact_id);
    expect(fetched?.identity_status).toBe('mention_only');
  });
});

describe('D-145 PA8 — promoteMentionOnlyToVerified (§ A.4.6)', () => {
  it('rewrites the synthetic email to the real value + flips identity_status', () => {
    const stub = store.createMentionOnlyContact({ name: 'Mom' });
    const promoted = store.promoteMentionOnlyToVerified({
      contact_id: stub.contact_id!,
      email: 'mary@gmail.com',
      name: 'Mary',
    });
    expect(promoted.contact_id).toBe(stub.contact_id);
    expect(promoted.identity_status).toBe('verified');
    expect(promoted.email).toBe('mary@gmail.com');
    expect(promoted.name).toBe('Mary');
    expect(isMentionOnlyEmail(promoted.email)).toBe(false);
  });

  it('canonicalizes the supplied email at write', () => {
    const stub = store.createMentionOnlyContact({ name: 'Bob' });
    const promoted = store.promoteMentionOnlyToVerified({
      contact_id: stub.contact_id!,
      email: '<Bob@Acme.COM>',
    });
    expect(promoted.email).toBe('bob@acme.com');
  });

  it('preserves the name when none supplied (idempotent rename guard)', () => {
    const stub = store.createMentionOnlyContact({ name: 'Mom' });
    const promoted = store.promoteMentionOnlyToVerified({
      contact_id: stub.contact_id!,
      email: 'mary@gmail.com',
    });
    expect(promoted.name).toBe('Mom');
  });

  it('throws on unknown contact_id', () => {
    expect(() =>
      store.promoteMentionOnlyToVerified({
        contact_id: 'no-such-id',
        email: 'a@x.com',
      }),
    ).toThrow(/promote_contact_unknown/);
  });

  it('throws when email collides with an existing other contact (caller routes to merge)', () => {
    store.observe({ email: 'mary@gmail.com', source: 'manual', event_at: 1 });
    const stub = store.createMentionOnlyContact({ name: 'Mom' });
    expect(() =>
      store.promoteMentionOnlyToVerified({
        contact_id: stub.contact_id!,
        email: 'mary@gmail.com',
      }),
    ).toThrow(/promote_email_already_attached/);
  });

  it('idempotent on already-verified contacts (no-op identity flip; email patch allowed)', () => {
    const c = store.observe({ email: 'a@x.com', source: 'manual', event_at: 1 });
    const promoted = store.promoteMentionOnlyToVerified({
      contact_id: c.contact_id!,
      email: 'a@x.com', // same email
    });
    expect(promoted.identity_status).toBe('verified');
    expect(promoted.email).toBe('a@x.com');
  });

  it('empty-string name patch is treated as no-op (preserves prior display name)', () => {
    const stub = store.createMentionOnlyContact({ name: 'Mom' });
    const promoted = store.promoteMentionOnlyToVerified({
      contact_id: stub.contact_id!,
      email: 'mary@gmail.com',
      name: '   ', // whitespace-only — treat as no patch
    });
    expect(promoted.name).toBe('Mom');
  });

  it('refuses to rekey an already-verified contact via the promotion path (Codex P1 fold)', () => {
    const c = store.observe({ email: 'a@x.com', source: 'manual', event_at: 1 });
    expect(() =>
      store.promoteMentionOnlyToVerified({
        contact_id: c.contact_id!,
        email: 'b@x.com', // different email
      }),
    ).toThrow(/promote_already_verified/);
  });

  it('refuses to promote to a synthetic mention-only placeholder email', () => {
    const a = store.createMentionOnlyContact({ name: 'Alice' });
    const b = store.createMentionOnlyContact({ name: 'Bob' });
    expect(() =>
      store.promoteMentionOnlyToVerified({
        contact_id: a.contact_id!,
        email: b.email, // synthetic placeholder of another mention_only
      }),
    ).toThrow(/promote_synthetic_email_forbidden/);
  });

  it('aliases attached pre-promotion survive the email rewrite (contact_id stable)', () => {
    const stub = store.createMentionOnlyContact({ name: 'Mom' });
    store.upsertContactAlias({
      contact_id: stub.contact_id!,
      kind: 'chat_alias',
      alias_pattern: 'mom',
      source: 'manual',
    });
    const promoted = store.promoteMentionOnlyToVerified({
      contact_id: stub.contact_id!,
      email: 'mary@gmail.com',
    });
    const aliases = store.listContactAliases(promoted.contact_id!);
    // THREE now, and each one is here for a different reason:
    //   1. `chat_alias` ('mom')       — survived the email rewrite. THE POINT OF THIS TEST:
    //                                   aliases key on `contact_id`, which is stable across
    //                                   the re-key.
    //   2. `email_alias` (real)       — D-192 C-2 slice 3. Promotion is where a mention_only
    //                                   contact finally HAS a real address, so it is where
    //                                   the address-space row gets contributed.
    //   3. `email_alias` (synthetic)  — 🔑 D-205, the REDIRECT. Promotion is an email RE-KEY,
    //                                   and it used to make the outgoing synthetic VANISH —
    //                                   no row, no tombstone, no alias — so every stored
    //                                   reference still holding it (and they hold EMAILS,
    //                                   whatever their names say) pointed at nothing. The
    //                                   merge's equivalent is its `merged_into` tombstone,
    //                                   which its own handler calls "the safety net for any
    //                                   reference that bypassed rewrite". This is that net.
    //
    // ⚠ `createMentionOnlyContact` still withholds the alias at CREATION — a synthetic that
    // was never anyone's address has no business in the address space. It earns its row only
    // once it has actually BEEN the contact's address of record and is being retired.
    expect(aliases.every((a) => a.contact_id === promoted.contact_id)).toBe(true);
    expect(aliases.map((a) => a.kind).sort()).toEqual([
      'chat_alias',
      'email_alias',
      'email_alias',
    ]);
    // The REAL address is the non-placeholder one. ⚠ Any surface listing a contact's email
    // addresses MUST filter with `isMentionOnlyEmail` — that is what the predicate is for.
    const realEmails = aliases.filter(
      (a) => a.kind === 'email_alias' && !isMentionOnlyEmail(a.alias_pattern),
    );
    expect(realEmails).toHaveLength(1);
    expect(realEmails[0]?.alias_pattern).toBe('mary@gmail.com');
    // …and the retired address still resolves to her. That is the whole fix.
    expect(store.resolveCanonicalEmail(stub.email).canonical_email).toBe('mary@gmail.com');
  });
});

describe('D-145 PA8 — upsertContactAlias (§ A.4.3)', () => {
  it('inserts a chat_alias row + materializes normalized form', () => {
    const c = store.createMentionOnlyContact({ name: 'Mom' });
    const alias = store.upsertContactAlias({
      contact_id: c.contact_id!,
      kind: 'chat_alias',
      alias_pattern: 'Mom',
      source: 'manual',
    });
    expect(alias.kind).toBe('chat_alias');
    expect(alias.alias_pattern).toBe('Mom');
    expect(alias.alias_pattern_normalized).toBe('mom');
    expect(alias.confidence).toBe(1.0);
    expect(alias.platform).toBeUndefined();
  });

  it('chat_alias unique-per-(contact, normalized) — lower-rank source does NOT override user_set (Codex P2 fold)', () => {
    const c = store.createMentionOnlyContact({ name: 'Mom' });
    const a = store.upsertContactAlias({
      contact_id: c.contact_id!,
      kind: 'chat_alias',
      alias_pattern: 'Mom',
      source: 'manual',
    });
    const b = store.upsertContactAlias({
      contact_id: c.contact_id!,
      kind: 'chat_alias',
      alias_pattern: 'mom', // case-different but same normalized
      source: 'ai_inferred',
      confidence: 0.7,
    });
    expect(b.id).toBe(a.id);
    expect(b.source).toBe('manual'); // existing user_set wins
    expect(b.confidence).toBe(1.0);
  });

  it('chat_alias higher-rank source DOES override (Codex P2 fold — confidence promotion)', () => {
    const c = store.createMentionOnlyContact({ name: 'Mom' });
    const a = store.upsertContactAlias({
      contact_id: c.contact_id!,
      kind: 'chat_alias',
      alias_pattern: 'mom',
      source: 'ai_inferred',
      confidence: 0.6,
    });
    const b = store.upsertContactAlias({
      contact_id: c.contact_id!,
      kind: 'chat_alias',
      alias_pattern: 'Mom', // user-set casing
      source: 'manual',
    });
    expect(b.id).toBe(a.id); // same row updated in place
    expect(b.source).toBe('manual');
    expect(b.confidence).toBe(1.0);
    expect(b.alias_pattern).toBe('Mom'); // user-visible casing matches latest writer
  });

  it('alias confidence rank — chat_confirmed beats tag_button beats ai_inferred', () => {
    const c = store.createMentionOnlyContact({ name: 'Bob' });
    const a = store.upsertContactAlias({
      contact_id: c.contact_id!,
      kind: 'chat_alias',
      alias_pattern: 'bob',
      source: 'ai_inferred',
      confidence: 0.5,
    });
    const b = store.upsertContactAlias({
      contact_id: c.contact_id!,
      kind: 'chat_alias',
      alias_pattern: 'bob',
      source: 'user_confirmed',
      confidence: 0.7,
    });
    expect(b.id).toBe(a.id);
    expect(b.source).toBe('user_confirmed');
    const cresult = store.upsertContactAlias({
      contact_id: c.contact_id!,
      kind: 'chat_alias',
      alias_pattern: 'bob',
      source: 'user_confirmed',
      confidence: 0.9,
    });
    expect(cresult.id).toBe(a.id);
    expect(cresult.source).toBe('user_confirmed');
  });

  // RETIRED (D-192 C-2) — the "only the user may claim confidence 1.0" rule is
  // gone. It guarded a world where rank and confidence COMPETED; under the C-2a
  // ladder the rung is settled first and confidence only breaks ties WITHIN a
  // rung, so the invariant is structural. Keeping the rule would have forced
  // every imported alias (`vendor_meta` / `contact_book`) to fake a sub-1.0
  // confidence — punishing a source that IS the system of record for the value.
  // The structural guarantee is pinned in `d-145-phase-8-contact-identity-types`
  // ("the LADDER dominates confidence").
  it('a confident non-user source is ACCEPTED — and still loses to the user', () => {
    const c = store.observe({ email: 'bob@x.com', source: 'manual', event_at: 1 });
    expect(() =>
      store.upsertContactAlias({
        contact_id: c.contact_id!,
        kind: 'chat_alias',
        alias_pattern: 'bob',
        source: 'ai_inferred',
        confidence: 1.0,
      }),
    ).not.toThrow();

    // The user overrides it anyway — rank beats confidence, always.
    const overridden = store.upsertContactAlias({
      contact_id: c.contact_id!,
      kind: 'chat_alias',
      alias_pattern: 'bob',
      source: 'manual',
    });
    expect(overridden.source).toBe('manual');
    expect(overridden.confidence).toBe(1.0);
  });

  it('inserts a platform_id row with platform discriminator', () => {
    const c = store.observe({ email: 'bob@x.com', source: 'manual', event_at: 1 });
    const alias = store.upsertContactAlias({
      contact_id: c.contact_id!,
      kind: 'platform_id',
      platform: 'facebook',
      alias_pattern: 'bob.smith.42',
      source: 'user_confirmed',
      confidence: 0.9,
    });
    expect(alias.kind).toBe('platform_id');
    expect(alias.platform).toBe('facebook');
    expect(alias.alias_pattern_normalized).toBe('bob.smith.42');
  });

  it('cross-contact platform_id silent-dual-attach is refused', () => {
    const bob = store.observe({ email: 'bob@x.com', source: 'manual', event_at: 1 });
    const robert = store.observe({ email: 'robert@x.com', source: 'manual', event_at: 1 });
    store.upsertContactAlias({
      contact_id: bob.contact_id!,
      kind: 'platform_id',
      platform: 'facebook',
      alias_pattern: 'bob.smith.42',
      source: 'manual',
    });
    expect(() =>
      store.upsertContactAlias({
        contact_id: robert.contact_id!,
        kind: 'platform_id',
        platform: 'facebook',
        alias_pattern: 'bob.smith.42',
        source: 'manual',
      }),
    ).toThrow(/platform_id_already_attached/);
  });

  it('platform_id idempotent on the same contact (returns existing row)', () => {
    const c = store.observe({ email: 'bob@x.com', source: 'manual', event_at: 1 });
    const a = store.upsertContactAlias({
      contact_id: c.contact_id!,
      kind: 'platform_id',
      platform: 'facebook',
      alias_pattern: 'bob.smith.42',
      source: 'manual',
    });
    const b = store.upsertContactAlias({
      contact_id: c.contact_id!,
      kind: 'platform_id',
      platform: 'facebook',
      alias_pattern: 'BOB.SMITH.42',
      source: 'user_confirmed',
    });
    expect(b.id).toBe(a.id);
  });

  it('rejects alias for unknown contact_id', () => {
    expect(() =>
      store.upsertContactAlias({
        contact_id: 'no-such-id',
        kind: 'chat_alias',
        alias_pattern: 'mom',
        source: 'manual',
      }),
    ).toThrow(/contact_alias_contact_unknown/);
  });

  it('rejects malformed inputs at validateContactAliasInput', () => {
    const c = store.observe({ email: 'a@x.com', source: 'manual', event_at: 1 });
    expect(() =>
      store.upsertContactAlias({
        contact_id: c.contact_id!,
        kind: 'platform_id',
        // missing platform
        alias_pattern: 'someone',
        source: 'manual',
      }),
    ).toThrow(/platform_required_for_platform_id/);

    // Only `platform_id` carries a platform. Every other kind must leave it
    // NULL — their partial unique indexes are defined without it, so a stray
    // platform would silently ESCAPE dedup rather than error.
    for (const kind of ['chat_alias', 'email_alias', 'phone_alias'] as const) {
      expect(() =>
        store.upsertContactAlias({
          contact_id: c.contact_id!,
          kind,
          platform: 'facebook',
          alias_pattern: kind === 'email_alias' ? 'x@y.com' : 'mom',
          source: 'manual',
        }),
      ).toThrow(/platform_forbidden_for_kind/);
    }
  });
});

describe('D-145 PA8 — list + delete contact_alias', () => {
  it('listContactAliases returns both rows', () => {
    const c = store.observe({ email: 'a@x.com', source: 'manual', event_at: 1 });
    const a1 = store.upsertContactAlias({
      contact_id: c.contact_id!,
      kind: 'chat_alias',
      alias_pattern: 'mom',
      source: 'manual',
      created_at: 1_000,
    });
    const a2 = store.upsertContactAlias({
      contact_id: c.contact_id!,
      kind: 'platform_id',
      platform: 'facebook',
      alias_pattern: 'a.b.c',
      source: 'manual',
      created_at: 2_000,
    });
    // `observe` now contributes the contact's own `email_alias` too (D-192 C-2
    // slice 3), so scope to the two rows this test actually wrote.
    const list = store
      .listContactAliases(c.contact_id!)
      .filter((r) => r.kind !== 'email_alias');
    expect(list.length).toBe(2);
    expect(list.map((r) => r.id).sort()).toEqual([a1.id, a2.id].sort());
    // With distinct created_at the order is deterministic — a1 (1000) < a2 (2000).
    expect(list[0]?.id).toBe(a1.id);
    expect(list[1]?.id).toBe(a2.id);
  });

  it('listContactAliases filters by kind', () => {
    const c = store.observe({ email: 'a@x.com', source: 'manual', event_at: 1 });
    store.upsertContactAlias({
      contact_id: c.contact_id!,
      kind: 'chat_alias',
      alias_pattern: 'mom',
      source: 'manual',
    });
    store.upsertContactAlias({
      contact_id: c.contact_id!,
      kind: 'platform_id',
      platform: 'facebook',
      alias_pattern: 'a.b',
      source: 'manual',
    });
    expect(store.listContactAliases(c.contact_id!, 'chat_alias').length).toBe(1);
    expect(store.listContactAliases(c.contact_id!, 'platform_id').length).toBe(1);
  });

  it('deleteContactAlias removes the row', () => {
    const c = store.observe({ email: 'a@x.com', source: 'manual', event_at: 1 });
    const alias = store.upsertContactAlias({
      contact_id: c.contact_id!,
      kind: 'chat_alias',
      alias_pattern: 'mom',
      source: 'manual',
    });
    expect(store.deleteContactAlias(alias.id)).toBe(true);
    // Scoped to the kind under test — the contact's own `email_alias` (D-192 C-2
    // slice 3) is not what this delete was aimed at, and must survive it.
    expect(store.listContactAliases(c.contact_id!, 'chat_alias').length).toBe(0);
    expect(store.listContactAliases(c.contact_id!, 'email_alias').length).toBe(1);
  });

  it('deleteContactAlias on unknown id returns false', () => {
    expect(store.deleteContactAlias('no-such-alias')).toBe(false);
  });

  it('deleting a contact cascades alias rows (Codex P1 fold — no orphaned aliases)', () => {
    const c = store.observe({ email: 'mary@x.com', source: 'manual', event_at: 1 });
    store.upsertContactAlias({
      contact_id: c.contact_id!,
      kind: 'chat_alias',
      alias_pattern: 'mom',
      source: 'manual',
    });
    store.upsertContactAlias({
      contact_id: c.contact_id!,
      kind: 'platform_id',
      platform: 'facebook',
      alias_pattern: 'mary.x',
      source: 'manual',
    });
    // Three: the two written above plus the contact's own `email_alias`, which
    // `observe` contributes (D-192 C-2 slice 3).
    expect(store.listContactAliases(c.contact_id!).length).toBe(3);

    expect(store.delete(c.email)).toBe(true);

    // Aliases gone — no orphan rows survive contact deletion. ALL of them,
    // including the contributed email_alias: a delete that retained the person's
    // address would be the same orphan leak, just under a newer name.
    expect(store.listContactAliases(c.contact_id!).length).toBe(0);
    // Resolver no longer returns the dead contact_id.
    const out = store.resolveContactReference('mom', { recent_contacts: [] });
    expect(out.contact_id).toBeNull();
  });
});

describe('D-145 PA8 — resolveContactReference end-to-end', () => {
  it('chat_alias single match', () => {
    const c = store.observe({ email: 'mary@gmail.com', source: 'manual', event_at: 1 });
    store.upsertContactAlias({
      contact_id: c.contact_id!,
      kind: 'chat_alias',
      alias_pattern: 'Mom',
      source: 'manual',
    });
    const out = store.resolveContactReference('mom', { recent_contacts: [] });
    expect(out.contact_id).toBe(c.contact_id);
    expect(out.confidence).toBe(1.0);
    expect(out.alternatives).toEqual([]);
  });

  it('chat_alias ambiguous → alternatives surfaced', () => {
    const a = store.observe({ email: 'a@x.com', source: 'manual', event_at: 1 });
    const b = store.observe({ email: 'b@x.com', source: 'manual', event_at: 1 });
    store.upsertContactAlias({
      contact_id: a.contact_id!,
      kind: 'chat_alias',
      alias_pattern: 'Bob',
      source: 'manual',
    });
    store.upsertContactAlias({
      contact_id: b.contact_id!,
      kind: 'chat_alias',
      alias_pattern: 'Bob',
      source: 'manual',
    });
    const out = store.resolveContactReference('bob', { recent_contacts: [] });
    expect(out.contact_id).toBeNull();
    expect(out.alternatives).toContain(a.contact_id);
    expect(out.alternatives).toContain(b.contact_id);
  });

  it('chat_alias narrows via recent_contacts', () => {
    const a = store.observe({ email: 'a@x.com', source: 'manual', event_at: 1 });
    const b = store.observe({ email: 'b@x.com', source: 'manual', event_at: 1 });
    store.upsertContactAlias({
      contact_id: a.contact_id!,
      kind: 'chat_alias',
      alias_pattern: 'Bob',
      source: 'manual',
    });
    store.upsertContactAlias({
      contact_id: b.contact_id!,
      kind: 'chat_alias',
      alias_pattern: 'Bob',
      source: 'manual',
    });
    const out = store.resolveContactReference('bob', { recent_contacts: [b.contact_id!] });
    expect(out.contact_id).toBe(b.contact_id);
  });

  it('platform_id exact-match', () => {
    const c = store.observe({ email: 'bob@x.com', source: 'manual', event_at: 1 });
    store.upsertContactAlias({
      contact_id: c.contact_id!,
      kind: 'platform_id',
      platform: 'facebook',
      alias_pattern: 'bob.smith.42',
      source: 'manual',
    });
    const out = store.resolveContactReference(
      { platform: 'facebook', id: 'BOB.SMITH.42' },
      { recent_contacts: [] },
    );
    expect(out.contact_id).toBe(c.contact_id);
  });

  it('platform_id no match returns null + empty alternatives', () => {
    const out = store.resolveContactReference(
      { platform: 'facebook', id: 'unknown' },
      { recent_contacts: [] },
    );
    expect(out.contact_id).toBeNull();
    expect(out.alternatives).toEqual([]);
  });

  it('chat_alias narrows via network_domain_hint', () => {
    const work = store.observe({ email: 'work@a.com', source: 'manual', event_at: 1 });
    const social = store.observe({ email: 'social@a.com', source: 'manual', event_at: 1 });
    store.setNetworkDomain(work.contact_id!, ['work']);
    store.setNetworkDomain(social.contact_id!, ['social']);
    store.upsertContactAlias({
      contact_id: work.contact_id!,
      kind: 'chat_alias',
      alias_pattern: 'Bob',
      source: 'manual',
    });
    store.upsertContactAlias({
      contact_id: social.contact_id!,
      kind: 'chat_alias',
      alias_pattern: 'Bob',
      source: 'manual',
    });
    const out = store.resolveContactReference(
      'bob',
      { recent_contacts: [], network_domain_hint: 'work' },
    );
    expect(out.contact_id).toBe(work.contact_id);
  });

  it('bumps last_resolved_at on the matched alias', () => {
    const c = store.observe({ email: 'mary@a.com', source: 'manual', event_at: 1 });
    const alias = store.upsertContactAlias({
      contact_id: c.contact_id!,
      kind: 'chat_alias',
      alias_pattern: 'Mom',
      source: 'manual',
    });
    expect(alias.last_resolved_at).toBeUndefined();
    store.resolveContactReference('mom', { recent_contacts: [] });
    // By ID, not by position: the contact now carries its own `email_alias` too
    // (D-192 C-2 slice 3), so index 0 is no longer necessarily the alias that was
    // resolved — and a positional read would have quietly started asserting about
    // the wrong row.
    const refreshed = store
      .listContactAliases(c.contact_id!)
      .find((r) => r.id === alias.id)!;
    expect(refreshed.last_resolved_at).toBeTypeOf('number');
  });
});

describe('D-145 PA8 — setNetworkDomain (§ A.4.2)', () => {
  it('sets + replaces network_domain on a contact', () => {
    const c = store.observe({ email: 'a@x.com', source: 'manual', event_at: 1 });
    expect(c.network_domain).toEqual([]);
    const updated = store.setNetworkDomain(c.contact_id!, ['work']);
    expect(updated.network_domain).toEqual(['work']);
    const replaced = store.setNetworkDomain(c.contact_id!, ['family', 'social']);
    expect(replaced.network_domain).toEqual(['family', 'social']);
  });

  it('empty array clears the assignment', () => {
    const c = store.observe({ email: 'a@x.com', source: 'manual', event_at: 1 });
    store.setNetworkDomain(c.contact_id!, ['work']);
    const cleared = store.setNetworkDomain(c.contact_id!, []);
    expect(cleared.network_domain).toEqual([]);
  });

  it('rejects unknown domain values', () => {
    const c = store.observe({ email: 'a@x.com', source: 'manual', event_at: 1 });
    expect(() =>
      store.setNetworkDomain(c.contact_id!, ['hobby'] as unknown as readonly ('work')[]),
    ).toThrow(/network_domain_unknown/);
  });

  it('throws on unknown contact_id', () => {
    expect(() =>
      store.setNetworkDomain('no-such-id', ['work']),
    ).toThrow(/network_domain_contact_unknown/);
  });

  it('dedupes', () => {
    const c = store.observe({ email: 'a@x.com', source: 'manual', event_at: 1 });
    const r = store.setNetworkDomain(c.contact_id!, ['work', 'social', 'work']);
    expect(r.network_domain).toEqual(['work', 'social']);
  });
});
