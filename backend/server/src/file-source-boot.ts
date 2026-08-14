/** D-192 file SOURCE family — Source-registry auto-registration boot wire.
 *
 *  The registry-visibility counterpart to `wireFileSourceSync` (which
 *  registers the housekeeping RECONCILE TASKS). `wireFileSourceSync` alone
 *  makes an enrolled file Source *sync* but leaves it INVISIBLE to Settings:
 *  no `SourceRegistration` row means no entry in the polymorphic Source
 *  surfaces + no freshness/health anchor. This wire closes that gap — it
 *  registers one `SourceRegistration` per connection whose vendor carries a
 *  `FileVendorDeclaration`, with `top_tier_kind: 'file'` +
 *  `sync_posture: 'file_meta_ref'`.
 *
 *  It is the file-family twin of `wireWorkEntitySourceBoot`, sharing its boot-
 *  scan + connection upsert/delete observer spine, but MUCH thinner: a file
 *  Source is a read-only meta-only mirror in v1, so there is no PA3
 *  write-capability probe (`write_capable` stays `false`), no sync-state seed
 *  (the file runner records health as housekeeping audit rows — a dedicated
 *  file sync-state store is a named slice-6 follow-on), and no work-graph
 *  edges.
 *
 *  ── Why registration is DECLARATION-driven, not adapter-driven ───────────
 *  A Source registry row is an IDENTITY/visibility fact — it should exist for
 *  any connection whose vendor is a declared file vendor, independent of
 *  whether the runtime adapter LEAF is resolved. (`wireFileSourceSync` gates
 *  its task on the leaf; the two agree on the Source `id` — see below — so the
 *  registered Source and its sync task never drift.) The desired set here is
 *  therefore keyed on `getFileVendorDeclaration(vendor) !== null`, NOT on the
 *  adapter resolver.
 *
 *  ── The shared Source `id` ───────────────────────────────────────────────
 *  Both wires mint the id with `CONNECTION_SOURCE_ID(vendor, name, 'file')`
 *  from the SAME inputs (`connectionVendorOf(row)` + `row.name`), so the
 *  registry row's id is exactly the `source_id` the sync task reconciles into
 *  the meta-store and Fork B's `data.file.*` resolver reads back.
 *
 *  ── Cross-family partition ───────────────────────────────────────────────
 *  This registry is SHARED with `wireWorkEntitySourceBoot`. Both wires observe
 *  every api-connection upsert/delete, and a work-entity vendor yields an empty
 *  file desired set here (and vice-versa), so each reconcile is scoped to its
 *  own `top_tier_kind` — this one manages ONLY `'file'` Sources — or the two
 *  would sweep each other's rows. (`wireWorkEntitySourceBoot` carries the
 *  mirror guard.)
 *
 *  Spec: D-192; the boot precedent is
 *  `work-entity-source-boot.ts`. */

import type { ConnectionRow, FileVendorDeclaration } from '@recued/contracts';
import { CONNECTION_SOURCE_ID, getFileVendorDeclaration } from '@recued/contracts';

import { connectionVendorOf, sourceIdConnectionName } from './work-entity-source-boot.js';
import type { ConnectionStoreSqlite } from './storage/connection-store.js';
import type { WorkEntityStore } from './storage/work-entity-store.js';

interface DesiredFileSourceRegistration {
  id: string;
  source_label: string;
}

/** The file Source (if any) one connection row registers: its vendor must
 *  carry a `FileVendorDeclaration`. Zero or one per connection (a connection
 *  is one vendor). Deliberately NOT gated on the adapter leaf — registration
 *  is a visibility fact; the sync task is what needs the leaf. */
const desiredFileSourceRegistrationsFor = (
  row: ConnectionRow,
): DesiredFileSourceRegistration[] => {
  const vendor = connectionVendorOf(row);
  if (vendor === null) return [];
  const declaration: FileVendorDeclaration | null = getFileVendorDeclaration(vendor);
  if (declaration === null) return [];
  return [{
    // SAME id `wireFileSourceSync` mints — `(vendor, name, 'file')`.
    id: CONNECTION_SOURCE_ID(vendor, row.name, 'file'),
    source_label: `${declaration.display_name} (${row.name})`,
  }];
};

/** Reconcile one connection name's file Sources against its current
 *  declarations. Registers the missing desired Source (read-only meta mirror
 *  posture) and unregisters any `'file'` connection Source for this name that
 *  no declaration produces anymore (vendor flip / connection delete). Scoped
 *  to `top_tier_kind: 'file'` so it never touches work-entity Sources sharing
 *  the same registry + connection name. `desired` is empty for a deleted row.
 *
 *  Idempotent: the desired Source is (re-)registered only when absent
 *  (`getSource` first).
 *
 *  ⚠ That skip used to be load-bearing for a USER TOGGLE — `registerSource` is
 *  an UPSERT whose ON CONFLICT overwrote `mcp_exposed`, so skipping was the
 *  only thing preserving a Settings opt-in across boot re-scans. `mcp_exposed`
 *  is gone (D-187 Sources half), and the surviving `enabled` toggle is
 *  preserved by the UPSERT itself (its ON CONFLICT deliberately OMITS the
 *  column). So the skip now buys idempotence only — keep it, but do not cite
 *  it as toggle preservation. */
const reconcileFileSources = (
  store: WorkEntityStore,
  desired: DesiredFileSourceRegistration[],
  connection_name: string,
  now: number,
): void => {
  const desiredIds = new Set(desired.map((d) => d.id));
  for (const existing of store.listSources()) {
    if (existing.source_kind !== 'connection') continue;
    // Scope to the file family — the work-entity boot manages the rest.
    if (existing.top_tier_kind !== 'file') continue;
    if (sourceIdConnectionName(existing.id) !== connection_name) continue;
    if (!desiredIds.has(existing.id)) {
      // Registry visibility only — the connection's `file_meta_ref` rows live
      // in the file-meta-store (a separate table `unregisterSource` doesn't
      // reach). A re-enroll under the same name self-heals via the sync's
      // complete-walk reconcile; a permanent delete leaves the mirror rows
      // orphaned (a bounded cleanup on unregister is a named follow-on).
      store.unregisterSource(existing.id);
    }
  }
  for (const d of desired) {
    if (store.getSource(d.id) !== null) continue;
    store.registerSource({
      id: d.id,
      top_tier_kind: 'file',
      source_kind: 'connection',
      sync_posture: 'file_meta_ref',
      source_label: d.source_label,
      // The Source sync is a read-only metadata mirror. Lazy remote-byte reads
      // do not create a provider write path, so this remains false.
      write_capable: false,
      registered_at: now,
    });
  }
};

export interface WireFileSourceBootInput {
  connectionStore: ConnectionStoreSqlite;
  /** The Source registry (shared with `wireWorkEntitySourceBoot`). */
  store: WorkEntityStore;
  now?: () => number;
}

/** Boot scan + upsert/delete observer for file-connection Source-registry
 *  rows. Idempotent: each registration checks `getSource` first, so a
 *  token-refresh upsert that doesn't change vendor identity is a no-op.
 *  Returns nothing — the observer handlers live on the connection-store
 *  instance for the process lifetime (mirrors `wireWorkEntitySourceBoot`). */
export const wireFileSourceBoot = (input: WireFileSourceBootInput): void => {
  const { connectionStore, store } = input;
  const now = input.now ?? ((): number => Date.now());

  // Boot scan — reconcile every api-kind connection's file Sources. Registry
  // rows survive server restarts, so a vendor flip / delete that happened
  // while stopped still leaves a stale row the reconcile drops.
  for (const row of connectionStore.list({ kind: 'api' })) {
    reconcileFileSources(store, desiredFileSourceRegistrationsFor(row), row.name, now());
  }

  // Future enrollments + vendor flips. Non-api upserts are ignored (a non-api
  // row may coexist with an api row under the same name — reconciling on it
  // would wrongly drop the api row's Source).
  connectionStore.addOnUpsert((row) => {
    if (row.kind !== 'api') return;
    reconcileFileSources(store, desiredFileSourceRegistrationsFor(row), row.name, now());
  });

  // Deletions — the desired set is empty, so every file Source parsed to this
  // name unregisters.
  connectionStore.addOnDelete((kind, name) => {
    if (kind !== 'api') return;
    reconcileFileSources(store, [], name, now());
  });
};
