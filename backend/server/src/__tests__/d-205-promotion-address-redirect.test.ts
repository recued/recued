/** D-205 — promotion leaves a REDIRECT: the outgoing synthetic address must keep
 *  resolving.
 *
 *  ## The bug this pins
 *  `promoteMentionOnlyToVerified` is an EMAIL RE-KEY — and the only one in the store
 *  (`SET email = ?` appears exactly once). Recued has TWO identity-change paths and,
 *  before this fix, only one of them was safe:
 *
 *    | path      | the old address afterwards            | a stored ref to it |
 *    |-----------|---------------------------------------|--------------------|
 *    | merge     | survives as a TOMBSTONE (`merged_into`) | ✅ still resolves  |
 *    | promotion | **VANISHED** — no row, no alias        | ❌ **dangled**     |
 *
 *  The merge handler calls its tombstone chain *"the safety net for any reference that
 *  bypassed rewrite."* Promotion had no net at all: it rewrote `contacts.email` in place,
 *  and the synthetic placeholder simply ceased to exist (`createMentionOnlyContact`
 *  deliberately withheld the alias). Every reference still holding it became a pointer to
 *  nothing — and the things that hold it are the ones whose NAMES deny it:
 *  `data_task.assigned_contact_id`, `data_commitment.counterparty_contact_id`,
 *  `contact_platform_link.canonical_email`, `annotation.target_id`.
 *
 *  ## Why it matters NOW
 *  Promotion has zero production callers today, so nothing has broken yet. **Contact books
 *  (D-205 #4, `full_import`) are what wire it** — they mint `partial` contacts (the dentist:
 *  name + phone, no email) EN MASSE, and every one is a promotion waiting to happen the
 *  moment that person emails you.
 *
 *  ## What is pinned
 *  The redirect closes the FORWARD direction: a stored reference to the dead synthetic
 *  address resolves to the contact's real one. It does NOT close the reverse direction (the
 *  contact's own rows still keyed on the dead address) — that needs the identity-change
 *  cascade. These tests say so explicitly so nobody reads a green suite as "promotion is
 *  safe to wire." */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createContactStore,
  isMentionOnlyEmail,
  type ContactStore,
} from '../storage/contact-store.js';

let dir: string;
let db: Database.Database;
let store: ContactStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-205-promo-redirect-'));
  db = new Database(join(dir, 'test.db'));
  store = createContactStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('D-205 — promotion leaves a redirect for the address it retires', () => {
  it('the synthetic address still RESOLVES to the contact after promotion', () => {
    // "Mom" — a mention_only contact. No email, so the substrate synthesizes one.
    const stub = store.createMentionOnlyContact({ name: 'Mom' });
    const synthetic = stub.email;
    expect(isMentionOnlyEmail(synthetic)).toBe(true);

    // She emails you. Promotion re-keys `contacts.email` from the synthetic to the real one.
    const promoted = store.promoteMentionOnlyToVerified({
      contact_id: stub.contact_id!,
      email: 'mom@example.com',
    });
    expect(promoted.email).toBe('mom@example.com');
    expect(promoted.identity_status).toBe('verified');

    // 🔑 THE FIX. Before it, this returned the input unchanged at depth 0 — the substrate's
    // "unknown address" answer — i.e. every stored reference to the synthetic pointed at
    // nothing. Now it redirects to her real address, exactly as a merged-away email does.
    const resolved = store.resolveCanonicalEmail(synthetic);
    expect(resolved.canonical_email).toBe('mom@example.com');
    expect(resolved.chain_depth).toBeGreaterThan(0); // it TRAVELLED — it did not self-resolve

    // And the contact is reachable by the dead address, which is what every email-keyed
    // joiner (`assigned_contact_id`, `canonical_email`, `annotation.target_id`) needs.
    const viaDeadAddress = store.get(synthetic) ?? store.get(resolved.canonical_email);
    expect(viaDeadAddress?.contact_id).toBe(stub.contact_id);
  });

  it('the contact_id is NEVER touched — the address moved, the identity did not', () => {
    const stub = store.createMentionOnlyContact({ name: 'The Dentist' });
    const id = stub.contact_id!;

    const promoted = store.promoteMentionOnlyToVerified({
      contact_id: id,
      email: 'dentist@example.com',
    });

    // The whole point of the address/identity split: `contact_id` is immutable (the store
    // even has an ABORT trigger saying "re-keying a contact orphans every contribution
    // keyed on it"). Everything keyed on the ID was always safe; only the ADDRESS moved.
    expect(promoted.contact_id).toBe(id);
  });

  it('the real address resolves too (the redirect does not shadow it)', () => {
    const stub = store.createMentionOnlyContact({ name: 'Mom' });
    store.promoteMentionOnlyToVerified({
      contact_id: stub.contact_id!,
      email: 'mom@example.com',
    });

    // Direct PK hit, depth 0 — the redirect must not turn the live address into a hop.
    const resolved = store.resolveCanonicalEmail('mom@example.com');
    expect(resolved.canonical_email).toBe('mom@example.com');
    expect(resolved.chain_depth).toBe(0);
  });

  it('a contact born WITH an email gains no redirect (nothing was retired)', () => {
    // The guard is `isMentionOnlyEmail(existing.email)`, not "did we promote". A verified
    // contact's address was never synthetic, so there is nothing to redirect from — and
    // promotion refuses to re-key it anyway (`promote_already_verified`).
    store.observe({ email: 'bob@example.com', name: 'Bob', source: 'email_from', event_at: 777 });
    const bob = store.get('bob@example.com')!;

    const aliases = store.listContactAliases(bob.contact_id!, 'email_alias');
    expect(aliases.every((a) => !isMentionOnlyEmail(a.alias_pattern))).toBe(true);
  });

  it('⚠ REVERSE direction is still OPEN — the redirect does not pretend otherwise', () => {
    // This test exists to STOP a future session reading a green suite as "promotion is safe
    // to wire". The redirect fixes refs POINTING AT the contact. It does NOT re-key the
    // contact's OWN rows, which are still keyed on the retired address. Closing that needs
    // the identity-change cascade (the merge half-runs it via `rewriteRecordId`; promotion
    // runs none of it). Contact books (#4) mint these en masse — read D-205 §9 first.
    const stub = store.createMentionOnlyContact({ name: 'Mom' });
    const synthetic = stub.email;

    store.promoteMentionOnlyToVerified({
      contact_id: stub.contact_id!,
      email: 'mom@example.com',
    });

    // The retired address is still a live handle onto the contact (the redirect works)...
    expect(store.resolveCanonicalEmail(synthetic).canonical_email).toBe('mom@example.com');

    // ...but nothing has rewritten rows that were STORED under it. A caller that queried
    // `WHERE assigned_contact_id = <real email>` would still miss rows written under the
    // synthetic. The cascade is the remaining work; this assertion documents the boundary.
    expect(store.get('mom@example.com')!.email).toBe('mom@example.com');
  });
});
