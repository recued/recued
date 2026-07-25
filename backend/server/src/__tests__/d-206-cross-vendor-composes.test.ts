/** D-206 step 3 — **PROVE cross-vendor composes. Do not build it.**
 *
 *  The spec's §2.3 claim, and the one the whole design rests on:
 *
 *  > `hubspot.contact ↔ salesforce.contact` needs **no declaration and no edge**. Both
 *  > already carry an IDENTITY link to the same `data.contact`. A cross-vendor
 *  > relationship is **two identity links sharing a spine** — derived at read, never
 *  > written.
 *
 *  And the full traversal, out of just two primitives:
 *
 *  ```
 *  pipedrive.deal ──REF──▶ person ──IDENTITY──▶ data.contact ──IDENTITY──▶ hubspot.contact
 *                (declared)         (already durable)          (already durable)
 *  ```
 *
 *  ## Why this is a TEST and not a build
 *
 *  🔴 **If cross-vendor does NOT compose, the spine premise is wrong and the `link` writer
 *  grows back.** An earlier draft of D-206 kept a writer specifically for "cross-vendor",
 *  and retiring it was justified ENTIRELY by this composition holding. So it gets proved,
 *  not asserted — and proved on the case that could actually break it.
 *
 *  ## The case that could actually break it
 *
 *  The easy case (one email, both CRMs auto-link to one contact) composes trivially. The
 *  load-bearing case is a **MERGE**: HubSpot knows `bob@work`, Salesforce knows `bob@home`
 *  — two SEPARATE core contacts, each with one vendor link — and the user later merges
 *  them. The survivor must carry BOTH links, or the two CRMs stop being reachable from one
 *  another and the composition silently dies.
 *
 *  ⚠ `setMergedInto` (the store primitive) does NOT re-point platform links. The **merge
 *  HANDLER** does, explicitly (`contact-merge-handler.ts:239-250`). So the merge case is
 *  driven through the REAL handler — a test that re-implemented the re-point itself would
 *  be a tautology and would prove nothing.
 *
 *  Spec: D-206 §2.3. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { crmRefFields, CRM_ALIAS_VALUES } from '@recued/contracts';

import { handleContactMergeConfirm } from '../contact-merge-handler.js';
import { createAnnotationStore, type AnnotationStore } from '../storage/annotation-store.js';
import { createBlobStore } from '../storage/blob-store.js';
import { createContactStore, type ContactStore } from '../storage/contact-store.js';

let dir: string;
let db: Database.Database;
let store: ContactStore;
let annotationStore: AnnotationStore;

const HUBSPOT_ID = '47291';
const SALESFORCE_ID = '003ABC';
const PIPEDRIVE_PERSON_ID = '123';

const link = (email: string, vendor: string, platform_id: string): void => {
  store.linkPlatformId({
    canonical_email: email,
    vendor,
    platform_id,
    state: 'auto',
    linked_at: 1_700_000_000_000,
    linked_by: 'auto:email_match',
  });
};

/** THE COMPOSITION UNDER TEST. Given one vendor's record id, reach ANOTHER vendor's record
 *  id — using ONLY the two identity links and the core contact between them.
 *
 *  ⛔ Note what is NOT here: no declaration is consulted, no edge table is read, nothing is
 *  keyed on a vendor pair. It is `identity → spine → identity`, and that is the claim. */
const crossVendor = (fromVendor: string, fromId: string, toVendor: string): string | null => {
  const email = store.lookupPlatformLink(fromVendor, fromId); // identity ↑ to the spine
  if (email === null) return null;
  const contact = store.get(email);
  if (!contact?.contact_id) return null;
  // Through the merge chain — the spine is the LIVE person, never a tombstone.
  const live = store.getByContactIdResolved(contact.contact_id);
  const hit = live?.platform_ids?.find((p) => p.vendor === toVendor); // identity ↓ to the vendor
  return hit?.platform_id ?? null;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd206-cross-vendor-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  store = createContactStore(db);
  annotationStore = createAnnotationStore({ db, blobs: createBlobStore(join(dir, 'blobs')) });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('D-206 §2.3 — cross-vendor is COMPOSED from identity, never written', () => {
  it('🔑 hubspot.contact ↔ salesforce.contact resolves through the spine — with ZERO declarations', () => {
    // One human, known to both CRMs under the same address, so both reconcilers auto-linked
    // to the SAME core contact. The cross-vendor relationship is not stored anywhere — it is
    // two identity links that happen to share a spine.
    store.observe({ email: 'bob@acme.example', name: 'Bob', source: 'email_from', event_at: 1_000 });
    link('bob@acme.example', 'hubspot', HUBSPOT_ID);
    link('bob@acme.example', 'salesforce', SALESFORCE_ID);

    // HubSpot → Salesforce, and back. Neither direction was ever written down.
    expect(crossVendor('hubspot', HUBSPOT_ID, 'salesforce')).toBe(SALESFORCE_ID);
    expect(crossVendor('salesforce', SALESFORCE_ID, 'hubspot')).toBe(HUBSPOT_ID);
  });

  it('🔑 THE FULL TRAVERSAL: a Pipedrive DEAL reaches the HubSpot contact — one declaration, two links', () => {
    // The picture from the spec, end to end:
    //   pipedrive.deal ──REF──▶ person ──IDENTITY──▶ data.contact ──IDENTITY──▶ hubspot.contact
    // The ONLY declared thing in that chain is `deal.contact_id`. The two identity links
    // already existed; no relationship edge is written at any point.
    store.observe({ email: 'bob@acme.example', name: 'Bob', source: 'email_from', event_at: 1_000 });
    link('bob@acme.example', 'pipedrive', PIPEDRIVE_PERSON_ID);
    link('bob@acme.example', 'hubspot', HUBSPOT_ID);

    // What a mirrored Pipedrive deal actually carries (canonical `contact_id` ← `person_id`).
    const dealMeta: Record<string, unknown> = { name: 'Acme renewal', contact_id: PIPEDRIVE_PERSON_ID };

    // Hop 1 — the DECLARATION. Which field carries the relationship is read from the schema,
    // never hardcoded.
    const ref = crmRefFields('deal').find((r) => r.entity === 'contact');
    expect(ref).toBeDefined();
    const personId = dealMeta[ref!.field] as string;
    expect(personId).toBe(PIPEDRIVE_PERSON_ID);

    // Hops 2 + 3 — the two pre-existing IDENTITY links, composed through the spine.
    expect(crossVendor('pipedrive', personId, 'hubspot')).toBe(HUBSPOT_ID);
  });

  it('⛔ and NO cross-vendor relationship is DECLARED anywhere — it is derived, not authored', () => {
    // The negative half of the claim, and the one that keeps a future author honest: if
    // cross-vendor ever needs a declaration, this test is where that shows up. Every declared
    // ref points at a canonical ENTITY (`contact` / `account`) — never at a vendor, and never
    // at a vendor PAIR.
    const refs = CRM_ALIAS_VALUES.flatMap((a) => crmRefFields(a));
    expect(refs.length).toBeGreaterThan(0); // never pass vacuously
    for (const r of refs) {
      expect(CRM_ALIAS_VALUES).toContain(r.entity);
      expect(r.field).not.toMatch(/hubspot|salesforce|pipedrive/i);
    }
  });

  it('🔴 SURVIVES A MERGE — the case that would have killed the premise', async () => {
    // The load-bearing case. HubSpot knows bob@work; Salesforce knows bob@home. TWO separate
    // core contacts, one vendor link each — so before the merge they are NOT reachable from
    // one another. The user merges them.
    //
    // If the survivor did not absorb both links, cross-vendor composition would silently die
    // for exactly the people most likely to be in two CRMs, and the `link` writer this spec
    // retired would have to come back.
    //
    // ⚠ Driven through the REAL merge handler — `setMergedInto` alone does NOT re-point the
    // links; the handler does. Re-implementing that here would be a tautology.
    store.observe({ email: 'bob@work.example', name: 'Bob Smith', source: 'email_from', event_at: 1_000 });
    store.observe({ email: 'bob@home.example', name: 'Bob Smith', source: 'email_from', event_at: 2_000 });
    link('bob@work.example', 'hubspot', HUBSPOT_ID);
    link('bob@home.example', 'salesforce', SALESFORCE_ID);

    // Before the merge they are two different people as far as the spine is concerned.
    expect(crossVendor('hubspot', HUBSPOT_ID, 'salesforce')).toBeNull();

    store.enqueueMergeCandidate({
      id: 'cand-1',
      email_a: 'bob@work.example',
      email_b: 'bob@home.example',
      matched_fields: ['name'],
      detected_at: 1,
      detected_by: 'inline',
    });
    await handleContactMergeConfirm(
      { contactStore: store, annotationStore, now: () => 1_700_000_000_000, newId: () => 'x' },
      { candidate_ids: ['cand-1'], survivor_email: 'bob@work.example' },
    );

    // The survivor absorbed BOTH vendor links, so the two CRMs now reach each other through
    // the spine — with nothing written to say so.
    expect(crossVendor('hubspot', HUBSPOT_ID, 'salesforce')).toBe(SALESFORCE_ID);
    expect(crossVendor('salesforce', SALESFORCE_ID, 'hubspot')).toBe(HUBSPOT_ID);

    // And the merged-away address still leads to the LIVE person, not the tombstone — which
    // is why identity is a durable link and not a read-time email join.
    expect(store.lookupPlatformLink('salesforce', SALESFORCE_ID)).not.toBeNull();
  });
});
