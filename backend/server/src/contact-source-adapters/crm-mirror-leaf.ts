/** D-192 C-2 (slice 7) — the CRM contact leaf. **One leaf, all three vendors.**
 *
 *  This is what finally makes the dead CRM contact path real. The taxonomy said CRM
 *  contacts *"link but never hydrate"*; the truth was worse — **they did neither.**
 *  No reconciler touched the contact store at all (zero references across `data/**`
 *  and `housekeeping/reconciliation/**`), so `resolveCompanyForDomain` was fully
 *  built with zero production callers and `PlatformIdEntry.linked_by`'s documented
 *  `'reconciler:<vendor>'` string was never written by anything.
 *
 *  ── It reads the MIRROR, not the vendor API ─────────────────────────────────
 *  The obvious leaf would call HubSpot's `/search`, Salesforce's SOQL and a new
 *  Pipedrive client — three vendor clients, three auth paths, three paginators,
 *  three rate-limit budgets, three completeness proofs to invent. All of it would
 *  duplicate work that ALREADY RUNS: the D-129/D-130 contact reconcilers (and
 *  D-190's generic one for Pipedrive) already walk every CRM contact through the
 *  gated + audited harness and mirror it into `crm_record_mirror` as a canonical
 *  `EnrichmentMeta` — `{ email, name, phone, company, mailing_address, … }`.
 *
 *  That canonical snapshot IS the shape this family wants. So the leaf reads the
 *  mirror, and the whole CRM half of slice 7 needs **zero per-vendor code**:
 *
 *    CRM API ──[existing reconciler: gated, audited, paginated]──▶ crm_record_mirror
 *                                                                        │
 *                                     ┌──────────────────────────────────┘
 *                                     ▼
 *                          this leaf ──▶ runContactSourceSync ──▶ data.contact
 *
 *  ⚠ **And it is why the slice-5 `supplies` declarations are what they are.** The
 *  mirror's meta is exactly what each vendor's projection produces, so the promise
 *  and the leaf agree by construction, per vendor:
 *    - **hubspot** — bespoke reconciler ⇒ `name` + `company` + `mailing_address` →
 *      `supplies: name, org, address` ✓
 *    - **salesforce** — bespoke reconciler ⇒ `name` + `mailing_address`, and NO
 *      company (a SF Contact has no `Company` field; its org is an `AccountId` link)
 *      → `supplies: name, address` ✓
 *    - **pipedrive** — D-190's GENERIC reconciler, whose projection comes from
 *      `entityFieldsFromRegistry` ⇒ `name` only. It cannot supply `mailing_address`,
 *      because the registry's `mailing_address` meta-field is the PHANTOM slice 5
 *      found (declared `type: 'object'` with neither a `source_path` nor a
 *      `derivation`, so `entityFieldsFromRegistry` skips it) → `supplies: name` ✓
 *
 *  ── The completeness proof ──────────────────────────────────────────────────
 *  The delete diff is absence-based, so it is only as safe as this proof. Two
 *  independent things must hold, and BOTH fail closed:
 *
 *   1. **The read must be uncapped.** `mirror.list()` clamps to 200 (it feeds a
 *      bounded chat surface) — using it here would make every contact past the 200th
 *      look absent from a walk claiming to be complete, and the sync would tear out
 *      their CRM contributions. Silently. So the leaf uses `listForConnection`,
 *      which carries no cap, and CROSS-CHECKS its length against
 *      `countForConnection` (which counts in SQL and drops nothing) — unequal means
 *      rows were dropped in deserialization, and a dropped row is indistinguishable
 *      from a deleted one.
 *   2. **An EMPTY mirror proves nothing.** A cold mirror (the reconciler has not run
 *      yet) and a purged one (the CRM connection was torn down) look exactly like
 *      "this CRM has no contacts" — and acting on that ambiguity would withdraw
 *      every CRM contribution the warehouse holds. So zero rows ⇒ `complete: false`
 *      ⇒ zero deletes. A genuinely empty CRM simply never withdraws; the user's
 *      explicit Source-teardown path is what removes imported data.
 *
 *  Beyond that the mirror is authoritative BY CONSTRUCTION, and that is the deeper
 *  reason to hydrate from it: a mirror row only disappears when the RECONCILER
 *  proved the remote record gone (its own delete diff is gated on its own
 *  completeness proof). So this leaf never has to prove a remote absence itself — it
 *  inherits a proof that was already made, once, upstream.
 *
 *  Spec: D-192 step 7. */

import {
  composeConnectionTargetIdPrefix,
  composeVendorEntityScope,
  type ContactAttributeKind,
  type ContactAliasKind,
  type ContactSourceDeclaration,
  type EnrichmentMeta,
} from '@recued/contracts';

import type {
  ContactSourceListFn,
  ContactSourceListOutcome,
  ContactSourceRecord,
} from '../contact-source-sync.js';
import type { CrmRecordMirrorStore } from '../storage/crm-record-mirror-store.js';

export interface CrmMirrorLeafDeps {
  /** The CRM mirror the reconcilers already maintain. */
  mirror: CrmRecordMirrorStore;
}

/** Read one canonical meta key as a trimmed non-empty string, or null. The mirror's
 *  meta is `Record<string, unknown>`-ish, so every read is defensive: a vendor whose
 *  projection omits a field yields `undefined`, which is a real answer ("this record
 *  has none"), not a failure. */
const metaString = (meta: EnrichmentMeta, key: string): string | null => {
  const raw = (meta as Record<string, unknown>)[key];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/** Build the record's alias lists — a KEY PER SUPPLIED KIND, always.
 *
 *  ⚠ The empty array is load-bearing. `[]` says "I looked; this record carries no
 *  phone"; a MISSING key would say "this leaf never looks at phones", and the
 *  runner's `supplies` verifier rejects the record for exactly that. Which is the
 *  point — the two must never be confusable. */
const aliasesFrom = (
  meta: EnrichmentMeta,
  supplies: ReadonlyArray<ContactAliasKind>,
): ContactSourceRecord['aliases'] => {
  const out: Record<string, readonly string[]> = {};
  for (const kind of supplies) {
    switch (kind) {
      case 'email_alias': {
        const email = metaString(meta, 'email');
        out[kind] = email === null ? [] : [email];
        break;
      }
      case 'phone_alias': {
        // ⚠ Canonicalized to E.164 by the BESPOKE reconcilers only (hb/sf run
        // `canonicalizePhone` in `projectContactMeta`). Pipedrive rides D-190's
        // GENERIC reconciler, whose projection is a plain `source_path` read of
        // `phones.0.value` — so its phone arrives in whatever local format the vendor
        // stored. Harmless, because the alias store normalizes on write; stated
        // because a future reader who "knows" it is already E.164 and skips
        // normalization would be wrong for one of the three vendors.
        const phone = metaString(meta, 'phone');
        out[kind] = phone === null ? [] : [phone];
        break;
      }
      default:
        // A CRM record cannot supply a chat handle or a social platform id, and no
        // declaration promises one — but if a future one did, an empty list is the
        // honest answer, never a missing key.
        out[kind] = [];
    }
  }
  return out as ContactSourceRecord['aliases'];
};

/** Build the record's attribute map — a KEY PER SUPPLIED KIND, always. `null` means
 *  "I looked; this record has none", and it is what the runner accepts in place of a
 *  value. A MISSING key is what it refuses. */
const attributesFrom = (
  meta: EnrichmentMeta,
  supplies: ReadonlyArray<ContactAttributeKind>,
): ContactSourceRecord['attributes'] => {
  const out: Record<string, unknown> = {};
  for (const kind of supplies) {
    switch (kind) {
      case 'name':
        out[kind] = metaString(meta, 'name');
        break;
      case 'org':
        // The CRM's contact-level company STRING (HubSpot's `properties.company`),
        // not the associated-company LINK. Salesforce and Pipedrive have no such
        // field at all, which is why neither declares `org` — see the header.
        out[kind] = metaString(meta, 'company');
        break;
      case 'address': {
        // The structured `MailingAddress` the reconciler composed from the vendor's
        // flat fields (`projectHubSpotMailingAddress` /
        // `projectSalesforceMailingAddress` → `canonicalizeMailingAddress`). This is
        // the mapping the VENDOR REGISTRY does not have — its `mailing_address`
        // meta-field is a bare declaration with nothing behind it — and reading it
        // off the mirror is how the leaf gets it without becoming a third
        // implementation of the same projection.
        const raw = (meta as Record<string, unknown>)['mailing_address'];
        out[kind] = raw !== null && typeof raw === 'object' ? raw : null;
        break;
      }
      default:
        // `title` / `photo` / `birthday` — no CRM entity carries them (HubSpot's
        // `jobtitle` and Salesforce's `Title` exist in the vendor APIs but are
        // neither declared as meta-fields nor requested by the reconcilers). No
        // declaration promises them; if one ever did without the meta-field landing
        // first, `null` is the honest answer.
        out[kind] = null;
    }
  }
  return out as ContactSourceRecord['attributes'];
};

/** The CRM contact leaf — serves every vendor whose contacts a reconciler mirrors.
 *  Keyed in the resolver by the `ContactSourceDeclaration.vendor` slug; the vendor
 *  only ever appears as a scope segment, never as a branch. */
export const buildCrmMirrorContactLeaf = (deps: CrmMirrorLeafDeps): ContactSourceListFn =>
  async ({ vendor, connection_name, declaration }): Promise<ContactSourceListOutcome> => {
    const entity = declaration.vendor_entity;
    if (entity === null) {
      // An address-book declaration has no platform-record entity, so there is no
      // mirror to read. It cannot reach this leaf (the resolver keys on CRM vendors)
      // — but say so rather than silently returning an empty, "complete" walk, which
      // would withdraw every contribution the Source ever made.
      return {
        ok: false,
        kind: 'config',
        reason: `contact source '${vendor}' has no vendor_entity — the CRM mirror leaf cannot serve an address book`,
      };
    }

    const scope = composeVendorEntityScope(vendor, entity);
    const prefix = composeConnectionTargetIdPrefix(vendor, entity, connection_name);

    // UNCAPPED — see the header. `list()` would clamp to 200 and silently mass-delete.
    const rows = deps.mirror.listForConnection(scope, prefix);
    // Counted IN SQL, dropping nothing — the cross-check that turns "I read some
    // rows" into "I read ALL of them".
    const total = deps.mirror.countForConnection(scope, prefix);

    // The completeness proof, fail-closed on both arms (see the header).
    const complete = total > 0 && rows.length === total;

    const records: ContactSourceRecord[] = [];
    for (const row of rows) {
      const meta = row.meta;
      records.push({
        // The mirror's `target_id` — already connection-qualified by D-190
        // (`<vendor>_<entity>_<connection>_<native>`), so two portals of one vendor
        // never collide. It is also the `platform_id` the runner links on.
        remote_id: row.target_id,
        // ⚠ **A KNOWN DEVIATION, stated rather than papered over.** `as_of` is
        // contractually EVENT time (D-120 bistemporal: "a CRM record edited last year
        // that Recued imported today is a year-old assertion, and the recency tiebreak
        // must see it that way"). This is `snapshot_at` — INGESTION time, when the
        // reconciler last refreshed the row.
        //
        // The mirror's meta genuinely does not carry the vendor's record-modified
        // timestamp: the reconciler HAS it (`SlimRecord.modified_at`, from
        // `hs_lastmodifieddate` / `LastModifiedDate`) but never projects it into the
        // snapshot. Consequence, bounded: when two SAME-RUNG sources disagree (a
        // HubSpot and a Salesforce contact, both `vendor_meta`), the ladder ties and
        // the tiebreak falls to recency — which here means "whichever we synced most
        // recently" rather than "whichever was asserted later". Deterministic, but
        // wrong. Against a different rung the ladder decides first and `as_of` is
        // never consulted, so the single-CRM case is unaffected.
        //
        // The fix is to project `modified_at` into the mirror meta (a reconciler +
        // `EnrichmentMeta` change, and it must be EXCLUDED from the record hash or
        // every touch would cascade). Named follow-on, not smuggled into this slice.
        as_of: typeof meta.snapshot_at === 'number' ? meta.snapshot_at : 0,
        // ⚠ The CANONICAL snapshot, not the raw vendor payload — a deviation from
        // `ContactSourceBlobRecord.blob`'s "vendor payload, verbatim". It IS the
        // record that asserted every contribution (which is the audit trail's real
        // job), and the raw vendor JSON is not ours to hold: it lives upstream in the
        // reconciler's own path. The cost is that the blob's documented "re-derive
        // after a mapping fix, no re-fetch needed" use case does not hold for CRM
        // sources — the blob is the OUTPUT of the mapping, so a fixed mapping needs
        // the reconciler to re-mirror first (which it does, on its own cadence).
        raw: meta,
        aliases: aliasesFrom(meta, declaration.supplies.aliases),
        attributes: attributesFrom(meta, declaration.supplies.attributes),
      });
    }

    return { ok: true, records, complete };
  };
