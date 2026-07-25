/** D-192 C-2 (slice 7) + D-205 #4c — the contact-source adapter resolver.
 *
 *  The contact twin of `file-source-adapters/index.ts`: keyed by the
 *  `ContactSourceDeclaration.vendor` slug, and a vendor with no leaf here resolves
 *  to `undefined` → that Source gets no sync task (the slice-6 wire contract).
 *
 *  ## TWO leaves, and the split is the family's real seam
 *
 *  **The CRM leaf — one leaf, all three vendors, zero per-vendor code.** A CRM
 *  contact needs no vendor client: the D-129/D-130/D-190 reconcilers ALREADY walk
 *  every CRM contact through the gated + audited harness and mirror it into
 *  `crm_record_mirror` as one canonical shape. So the leaf reads the mirror and the
 *  vendor slug is only ever a scope segment — the §0 governing rule paying off (a
 *  new CRM vendor is a declaration entry, and its contacts hydrate for free the
 *  moment its reconciler mirrors them).
 *
 *  **The Google People leaf — a contact book has no mirror, because it has no
 *  platform record.** It IS the record (`vendor_entity: null`). Nothing reconciles
 *  it, so the leaf must go to the source — and it does so by dispatching the
 *  `google-contacts` pack's OWN operation through the catalog gateway, which keeps
 *  the call gated, audited, and paginated by declaration. Still zero HTTP in this
 *  tree.
 *
 *  That is the honest factoring: the two leaves differ because a CRM's contacts
 *  arrive as a side-effect of something else Recued already syncs, and a contact
 *  book's do not.
 *
 *  ⚠ **MS Graph contacts and CardDAV are still absent, and that is a decision, not
 *  an omission.** Neither has a leaf, and `CONTACT_SOURCE_DECLARATIONS` does not
 *  declare them — so nothing here is waiting on a leaf that will never come. They
 *  land together, as `google` just did. */

import { buildCrmMirrorContactLeaf, type CrmMirrorLeafDeps } from './crm-mirror-leaf.js';
import { createGooglePeopleLeaf, type GooglePeopleLeafDeps } from './google-people-leaf.js';
import type {
  ContactSourceAdapterResolver,
  ContactSourceListFn,
} from '../contact-source-sync.js';

export type { CrmMirrorLeafDeps, GooglePeopleLeafDeps };
export { buildCrmMirrorContactLeaf, createGooglePeopleLeaf };

/** What the resolver needs to build EVERY leaf it can.
 *
 *  ⚠ Both halves are OPTIONAL, and independently so — a server can legitimately
 *  have one and not the other. A CRM-less install (no `crm_record_mirror`) still
 *  imports a contact book; a contact-book-less install still hydrates from HubSpot.
 *
 *  🔑 This used to be `extends CrmMirrorLeafDeps` — i.e. `{ mirror }`, REQUIRED. The
 *  boot wire read that literally (`crmRecordMirrorStoreRef ? {resolveAdapter} : {}`),
 *  so on a server with no CRM mirror the resolver was **not passed at all** and a
 *  contact book would have registered as a Source, appeared in the health strip, and
 *  silently never synced. A dep bundle that couples two unrelated vendors is how that
 *  happens. */
export interface ContactSourceAdapterDeps {
  /** The CRM mirror the reconcilers maintain. Absent ⇒ no CRM contact leaves (and
   *  that is not an error — this server syncs no CRM). */
  crm?: CrmMirrorLeafDeps;
  /** The gated catalog-op dispatcher's deps. Absent ⇒ no contact-book leaves. */
  google?: GooglePeopleLeafDeps;
}

/** Build the per-vendor `ContactSourceListFn` resolver the slice-6 wire consumes
 *  (`wireContactSourceSync({ resolveAdapter })`). */
export const buildContactSourceAdapterResolver = (
  deps: ContactSourceAdapterDeps,
): ContactSourceAdapterResolver => {
  // Listed explicitly rather than defaulted, so adding a vendor to
  // `CONTACT_SOURCE_DECLARATIONS` without a leaf behind it does NOT silently resolve
  // to one that would read an empty scope — an empty mirror is exactly the ambiguity
  // the CRM leaf's completeness proof refuses to act on, and a Source with no task at
  // all is a clearer state than one that runs and does nothing.
  const leaves: Record<string, ContactSourceListFn> = {};

  if (deps.crm !== undefined) {
    const crmLeaf: ContactSourceListFn = buildCrmMirrorContactLeaf(deps.crm);
    leaves.hubspot = crmLeaf;
    leaves.salesforce = crmLeaf;
    leaves.pipedrive = crmLeaf;
  }

  if (deps.google !== undefined) {
    leaves.google = createGooglePeopleLeaf(deps.google);
  }

  return (vendor) => leaves[vendor];
};
