/** D-192 C-2 (slice 6) — contact-Source registry auto-registration boot wire.
 *
 *  The registry-visibility counterpart to `wireContactSourceSync` (which registers
 *  the housekeeping RECONCILE TASKS). The sync wire alone makes an enrolled contact
 *  Source *sync* but leaves it INVISIBLE to Settings: no `SourceRegistration` row
 *  means no entry in the polymorphic Source surfaces and no freshness/health
 *  anchor. This wire closes that gap — one `SourceRegistration` per connection whose
 *  vendor carries a `ContactSourceDeclaration`, with `top_tier_kind: 'contact'` +
 *  `sync_posture: 'contact_import'`.
 *
 *  The contact-family twin of `wireFileSourceBoot`, sharing its boot-scan +
 *  connection upsert/delete observer spine.
 *
 *  ── Why registration is DECLARATION-driven, not adapter-driven ───────────────
 *  A Source registry row is an IDENTITY/visibility fact — it should exist for any
 *  connection whose vendor is a declared contact vendor, independent of whether the
 *  runtime adapter LEAF is resolved. (`wireContactSourceSync` gates its task on the
 *  leaf; the two agree on the Source `id`, so the registered Source and its sync
 *  task never drift.) The desired set is therefore keyed on
 *  `getContactSourceDeclaration(vendor) !== null`, NOT on the adapter resolver.
 *
 *  ── The shared Source `id` ───────────────────────────────────────────────────
 *  Both wires mint it with `CONNECTION_SOURCE_ID(vendor, name, 'contact')` from the
 *  SAME inputs, so the registry row's id is exactly the `source_id` the sync
 *  reconciles under — which, since slice 6a, is also the key its mirrored blobs and
 *  its contributions are stored on. One Source, one id, everywhere.
 *
 *  ⚠ **The middle parameter of `CONNECTION_SOURCE_ID` is a misnomer** — it is named
 *  `connection_id` but the boot path passes the connection NAME (the inverse,
 *  `sourceIdConnectionName`, proves it). So `hubspot.work.contact` is vendor
 *  `hubspot` + connection *name* `work` + kind `contact`.
 *
 *  ── Cross-family partition ───────────────────────────────────────────────────
 *  This registry is SHARED with `wireWorkEntitySourceBoot` and `wireFileSourceBoot`.
 *  All three observe every api-connection upsert/delete, and each reconcile is
 *  scoped to its OWN `top_tier_kind` — this one manages ONLY `'contact'` Sources —
 *  or they would sweep each other's rows. This matters more here than for files: a
 *  HubSpot connection legitimately produces a work-entity Source AND a contact
 *  Source, so the two wires are live on the SAME connection at once.
 *
 *  Spec: `docs/d-192-contact-source-family.md` step 6. */

import type { ConnectionRow, ContactSourceDeclaration } from '@recued/contracts';
import { CONNECTION_SOURCE_ID, getContactSourceDeclaration } from '@recued/contracts';

import { connectionVendorOf, sourceIdConnectionName } from './work-entity-source-boot.js';
import type { ConnectionStoreSqlite } from './storage/connection-store.js';
import type { WorkEntityStore } from './storage/work-entity-store.js';

interface DesiredContactSourceRegistration {
  id: string;
  source_label: string;
}

/** The contact Source (if any) one connection row registers: its vendor must carry
 *  a `ContactSourceDeclaration`. Zero or one per connection (a connection is one
 *  vendor). Deliberately NOT gated on the adapter leaf — registration is a
 *  visibility fact; the sync task is what needs the leaf. */
const desiredContactSourceRegistrationsFor = (
  row: ConnectionRow,
): DesiredContactSourceRegistration[] => {
  const vendor = connectionVendorOf(row);
  if (vendor === null) return [];
  const declaration: ContactSourceDeclaration | null = getContactSourceDeclaration(vendor);
  if (declaration === null) return [];
  return [{
    // SAME id `wireContactSourceSync` mints — `(vendor, name, 'contact')`.
    id: CONNECTION_SOURCE_ID(vendor, row.name, 'contact'),
    source_label: `${declaration.display_name} (${row.name})`,
  }];
};

/** Reconcile one connection name's contact Sources against its current
 *  declarations. Registers the missing desired Source and unregisters any
 *  `'contact'` connection Source for this name that no declaration produces anymore
 *  (vendor flip / connection delete). Scoped to `top_tier_kind: 'contact'` so it
 *  never touches the file or work-entity Sources sharing the same registry and the
 *  same connection. `desired` is empty for a deleted row.
 *
 *  Idempotent + toggle-preserving: the desired Source is (re-)registered only when
 *  absent (`getSource` first). `registerSource` is an UPSERT and DOES overwrite
 *  `mcp_exposed` on conflict, so the getSource-first skip is what preserves a user's
 *  Settings opt-in across boot re-scans. */
const reconcileContactSources = (
  store: WorkEntityStore,
  desired: DesiredContactSourceRegistration[],
  connection_name: string,
  now: number,
): void => {
  const desiredIds = new Set(desired.map((d) => d.id));
  for (const existing of store.listSources()) {
    if (existing.source_kind !== 'connection') continue;
    // Scope to the contact family — the file + work-entity boots manage the rest.
    if (existing.top_tier_kind !== 'contact') continue;
    if (sourceIdConnectionName(existing.id) !== connection_name) continue;
    if (!desiredIds.has(existing.id)) {
      // Registry visibility only. The Source's mirrored blobs + contributions live
      // in the contact store (tables `unregisterSource` does not reach); the
      // deliberate teardown path is `deleteContactSourceBlobsForSource` +
      // `deleteContact{Attributes,Aliases}ForSource`, which is a USER decision
      // ("also remove the imported data?"), not something a vendor flip should do
      // silently. A re-enroll under the same name self-heals via the sync's
      // complete-walk reconcile.
      store.unregisterSource(existing.id);
    }
  }
  for (const d of desired) {
    if (store.getSource(d.id) !== null) continue;
    store.registerSource({
      id: d.id,
      top_tier_kind: 'contact',
      source_kind: 'connection',
      sync_posture: 'contact_import',
      source_label: d.source_label,
      // Read-only in v1: the sync HYDRATES the local contact graph from the CRM and
      // never writes back. There is no write path to flip this true.
      write_capable: false,
      // MCP-exposure default off (privacy posture — D-136 P7.E); the user opts in
      // per Source through Settings.
      mcp_exposed: false,
      registered_at: now,
    });
  }
};

export interface WireContactSourceBootInput {
  connectionStore: ConnectionStoreSqlite;
  /** The Source registry (shared with the file + work-entity boots). */
  store: WorkEntityStore;
  now?: () => number;
}

/** Boot scan + upsert/delete observer for contact-connection Source-registry rows.
 *  Idempotent: each registration checks `getSource` first, so a token-refresh upsert
 *  that doesn't change vendor identity is a no-op. Returns nothing — the observer
 *  handlers live on the connection-store instance for the process lifetime (mirrors
 *  `wireFileSourceBoot`). */
export const wireContactSourceBoot = (input: WireContactSourceBootInput): void => {
  const { connectionStore, store } = input;
  const now = input.now ?? ((): number => Date.now());

  // Boot scan — reconcile every api-kind connection's contact Sources. Registry rows
  // survive restarts, so a vendor flip / delete that happened while stopped still
  // leaves a stale row this reconcile drops.
  for (const row of connectionStore.list({ kind: 'api' })) {
    reconcileContactSources(store, desiredContactSourceRegistrationsFor(row), row.name, now());
  }

  // Future enrollments + vendor flips. Non-api upserts are ignored (a non-api row
  // may coexist with an api row under the same name — reconciling on it would
  // wrongly drop the api row's Source).
  connectionStore.addOnUpsert((row) => {
    if (row.kind !== 'api') return;
    reconcileContactSources(store, desiredContactSourceRegistrationsFor(row), row.name, now());
  });

  // Deletions — the desired set is empty, so every contact Source parsed to this
  // name unregisters.
  connectionStore.addOnDelete((kind, name) => {
    if (kind !== 'api') return;
    reconcileContactSources(store, [], name, now());
  });
};
