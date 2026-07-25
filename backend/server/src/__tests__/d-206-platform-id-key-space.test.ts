/** D-206 step 1 — **THE KEY-SPACE PIN.** The single load-bearing fact under the whole
 *  relationship design, and the one the tree actively lies about.
 *
 *  ## The claim
 *
 *  A canonical `deal.contact_id` (Pipedrive `person_id`) holds the vendor's **RAW** record
 *  id — `'123'`. `ContactRecord.platform_ids[].platform_id` holds the **SAME** raw id.
 *  **Same key space** ⇒ one declaration resolves a deal to the CORE contact in ONE hop,
 *  and D-206 needs no stored edge at all.
 *
 *  ## Why it needs a test rather than a comment
 *
 *  🔴 **`PlatformIdEntry.platform_id`'s docstring used to give `'hubspot_contact_47291'`
 *  as its example — the PREFIXED form.** That is the `crm_record_mirror` / `data.crm.*`
 *  `target_id` shape: a DIFFERENT key space that happens to look plausible. A future
 *  author "fixing" the code to match that docstring would break the D-206 join — and it
 *  would break SILENTLY. No error, no exception: `json_extract(meta,'$.contact_id') = ?`
 *  simply matches nothing, and the relationship quietly is not there.
 *
 *  That is this family's signature failure mode (a confident absence rendered as fact), so
 *  the invariant is pinned against the REAL store rather than asserted in prose.
 *
 *  Spec: `docs/d-206-spec.md` §2.4. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createContactStore, type ContactStore } from '../storage/contact-store.js';

let dir: string;
let db: Database.Database;
let store: ContactStore;

/** The vendor's RAW record id, exactly as a Pipedrive deal's `meta.contact_id` carries it
 *  (`person_id`). Deliberately a bare numeric string: the prefixed form would be
 *  `pipedrive_person_123`, and the whole point is that we store neither that nor anything
 *  else derived — we store this, verbatim. */
const RAW_VENDOR_CONTACT_ID = '123';
const EMAIL = 'bob@acme.example';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd206-key-space-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  store = createContactStore(db);
  store.observe({ email: EMAIL, name: 'Bob', source: 'email_from', event_at: 1_000 });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('D-206 — platform_id is the vendor’s RAW record id (the join key space)', () => {
  it('stores the raw vendor id VERBATIM — never a <vendor>_<entity>_<id> prefix', () => {
    store.linkPlatformId({
      canonical_email: EMAIL,
      vendor: 'pipedrive',
      platform_id: RAW_VENDOR_CONTACT_ID,
      state: 'auto',
      linked_at: 1_700_000_000_000,
      linked_by: 'auto:email_match',
    });

    const entry = store.get(EMAIL)?.platform_ids?.[0];
    expect(entry).toBeDefined();
    expect(entry!.platform_id).toBe(RAW_VENDOR_CONTACT_ID);

    // ⛔ And explicitly NOT the prefixed form the old docstring advertised. If a writer ever
    // starts prefixing, the D-206 join silently no-matches — so this assertion is the
    // tripwire, not decoration.
    expect(entry!.platform_id).not.toContain('_');
    expect(entry!.platform_id).not.toContain('pipedrive');
  });

  it('🔑 THE D-206 JOIN COMPOSES: a deal’s canonical contact_id resolves to the CORE contact', () => {
    // The whole design in one assertion. A Pipedrive deal mirrors `meta.contact_id = '123'`
    // (its `person_id`). D-206 declares that field a ref to `contact`. Resolving it to the
    // user's OWN contact must be a single lookup against the identity link that already
    // exists — with NO stored relationship edge anywhere.
    store.linkPlatformId({
      canonical_email: EMAIL,
      vendor: 'pipedrive',
      platform_id: RAW_VENDOR_CONTACT_ID,
      state: 'auto',
      linked_at: 1_700_000_000_000,
      linked_by: 'auto:email_match',
    });

    // What a mirrored Pipedrive deal actually carries (canonical `contact_id` ← `person_id`).
    const dealMeta: Record<string, unknown> = {
      id: 55,
      name: 'Acme renewal',
      contact_id: RAW_VENDOR_CONTACT_ID,
    };

    // FORWARD — the deal's contact. The ref's value is fed to the identity link AS-IS: no
    // prefixing, no parsing, no transformation. That IS the key-space claim, and this is the
    // one hop D-206 rests on.
    const resolved = store.lookupPlatformLink('pipedrive', String(dealMeta['contact_id']));
    expect(resolved).toBe(EMAIL);

    // REVERSE — this contact's deals. The contact hands back the SAME raw id, which is what a
    // `json_extract(meta,'$.contact_id') = ?` filter over the deal mirror binds. If the two
    // key spaces ever diverge, THIS is the equality that silently stops holding.
    const platformId = store
      .get(EMAIL)!
      .platform_ids!.find((p) => p.vendor === 'pipedrive')!.platform_id;
    expect(platformId).toBe(dealMeta['contact_id']);
  });

  it('an UNLINKED vendor id resolves to NOTHING — the lookup is real, not a fixture echo', () => {
    // The negative control. Without it, the forward assertion above could pass for the wrong
    // reason (a lookup that returns the only contact in the db regardless of its argument).
    store.linkPlatformId({
      canonical_email: EMAIL,
      vendor: 'pipedrive',
      platform_id: RAW_VENDOR_CONTACT_ID,
      state: 'auto',
      linked_at: 1_700_000_000_000,
      linked_by: 'auto:email_match',
    });

    expect(store.lookupPlatformLink('pipedrive', '999')).toBeNull(); // wrong id
    expect(store.lookupPlatformLink('hubspot', RAW_VENDOR_CONTACT_ID)).toBeNull(); // wrong vendor
    // ⛔ And the PREFIXED form — the one the old docstring advertised — must NOT resolve.
    // If someone "fixes" a writer to store `pipedrive_person_123`, the join goes silently
    // dark; this is the assertion that would go red instead.
    expect(store.lookupPlatformLink('pipedrive', 'pipedrive_person_123')).toBeNull();
  });

  it('the identity link SURVIVES the contact’s address changing — which is why it is a link, not a ref', () => {
    // 🔑 The reason `contact.email` is NOT a D-206 ref. Identity hangs on a MUTABLE key, so it
    // needs a durable, redirect-able edge. Here the address the vendor originally matched on is
    // absorbed into another contact — and the vendor's raw id must STILL lead to the live
    // person. A read-time email join would have gone dark at exactly this moment.
    const survivor = 'robert@acme.example';
    store.observe({ email: survivor, name: 'Robert', source: 'email_from', event_at: 2_000 });
    store.linkPlatformId({
      canonical_email: EMAIL,
      vendor: 'pipedrive',
      platform_id: RAW_VENDOR_CONTACT_ID,
      state: 'auto',
      linked_at: 1_700_000_000_000,
      linked_by: 'auto:email_match',
    });

    store.setMergedInto([store.get(EMAIL)!], survivor, Date.now());

    // The link still resolves — to an address that is now a TOMBSTONE...
    const linked = store.lookupPlatformLink('pipedrive', RAW_VENDOR_CONTACT_ID);
    expect(linked).toBe(EMAIL);
    // ...and that address carries the merge edge to the live survivor. The durable link and
    // the merge chain COMPOSE: nothing was lost, and nothing had to be rewritten at read time.
    // (Asserted exactly — no `??` fallback, which would let this pass for the wrong reason.)
    expect(store.get(linked!)?.merged_into).toBe(survivor);
  });
});
