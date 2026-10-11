/** Connection-detail "Used by packs" — the INVERSE pivot of the pack-row
 *  readiness block. The pack row answers "does this pack have its connections?"
 *  (per pack → its connections); this answers "what packs use this connection,
 *  and are they scope-covered?" (per connection → its packs).
 *
 *  Reads each installed pack's `packs.list` row: its
 *  `required_scopes_by_connection` is `requiredScopesByConnection(manifest)`,
 *  lifted by the server, because the list carries no manifest (`b06752cc9`).
 *  Lives in ui-shared because the connection-detail renderer (`page.ts`) is
 *  the sole consumer. Vendor-match resolution (the connection slot IS the
 *  vendor), consistent with the pack-row readiness + the live runnability
 *  system. Pure — same inputs, same output.
 *
 *  Like the pack-row block, this is READINESS (does the connection cover its
 *  packs?), not authz — the gate stays the per-op contract grant. */

import {
  scopeCoverage,
  type PackListEntry,
  type ScopeCoverage,
} from '@recued/contracts';

/** What "Used by packs" reads off an installed pack's `packs.list` row: its slug,
 *  the scopes it needs, and (D-320 slice 2h) its name, shown instead of the slug. */
export type InstalledPackScopes = Pick<PackListEntry, 'slug' | 'required_scopes_by_connection'>
  & { name?: string };

/** One installed pack's use of a connection. */
export interface PackConnectionUsage {
  /** The pack's manifest slug. */
  pack_slug: string;
  /** D-320 slice 2h — its name; its slug when the list row has none. */
  pack_name: string;
  /** D-320 slice 2h — the names of the packs on the connection that sign in
   *  through this one (ruling 9): a family is named once, by its holder. Their
   *  scopes are in `needed`. */
  members: string[];
  /** The scopes this pack needs on the connection (sorted). Empty for a pack
   *  whose list holds the connection but which needs no scope (D-320). */
  needed: string[];
  /** Coverage of `needed` against the connection's granted set. */
  coverage: ScopeCoverage;
  /** D-320 §4 — the pack uses this connection by default. */
  is_default?: true;
}

/** The packs using a connection — for the connection-detail "Used by packs"
 *  view. Pass the INSTALLED packs' list rows + the connection's vendor + its
 *  `granted_scopes`; get one entry per installed pack that declares a
 *  scope-bearing op on that vendor, each with its needed scopes + coverage.
 *  Sorted by slug; empty when no installed pack uses the vendor. `granted`
 *  undefined → each entry's coverage is `known:false` (unknown, a soft hint).
 *
 *  D-194 #6 — `boundPackSlugs` (the SPECIFIC connection's granted pack set, from
 *  the grant store via `ConnectionView.bound_pack_slugs`) narrows the vendor-match
 *  to packs actually granted on THIS connection, so two accounts of one vendor
 *  (`onedrive_work` vs `onedrive_personal`) don't both list every vendor pack.
 *  Omitted (undefined) ⇒ the grant data is unavailable (dbless / legacy) → the
 *  original vendor-match (back-compat). A pack granted on the connection but
 *  declaring no scope-bearing op was excluded (nothing to show coverage for).
 *
 *  D-320 §4 — `boundPackSlugs` now holds the packs whose LIST holds the
 *  connection (their bindings) too, and those are shown whether or not they need
 *  a scope: most packs (an API key's) need none, and "Used by packs" names each
 *  pack. `defaultFor` marks the ones that use this connection by default. */
export const packsUsingConnection = (
  packs: readonly InstalledPackScopes[],
  vendor: string,
  granted: readonly string[] | undefined,
  boundPackSlugs?: readonly string[],
  defaultFor?: readonly string[],
  /** D-320 slice 2h — each pack on the connection signing in through another
   *  one on it, to that holder (`ConnectionView.pack_holders`). */
  holders?: Readonly<Record<string, string>>,
): PackConnectionUsage[] => {
  const bound = boundPackSlugs === undefined ? undefined : new Set(boundPackSlugs);
  const defaults = new Set(defaultFor ?? []);
  const out: PackConnectionUsage[] = [];
  for (const pack of packs) {
    const needed = pack.required_scopes_by_connection?.[vendor];
    const onList = bound?.has(pack.slug) === true;
    // Neither needs the vendor's scopes nor lists this connection.
    if (needed === undefined && !onList) continue;
    if (bound !== undefined && !onList) continue; // not on THIS connection
    out.push({
      pack_slug: pack.slug,
      pack_name: typeof pack.name === 'string' && pack.name.trim().length > 0 ? pack.name : pack.slug,
      members: [],
      needed: [...(needed ?? [])],
      coverage: scopeCoverage(needed ?? [], granted),
      ...(defaults.has(pack.slug) ? { is_default: true as const } : {}),
    });
  }
  // A family once: each member folds into its holder's line, its scopes with it,
  // so a scope a member needs and the connection lacks still shows.
  const bySlug = new Map(out.map((usage) => [usage.pack_slug, usage]));
  const folded = out.filter((usage) => {
    const holder = holders?.[usage.pack_slug];
    const into = holder !== undefined ? bySlug.get(holder) : undefined;
    if (into === undefined) return true;
    into.members.push(usage.pack_name);
    into.needed = [...new Set([...into.needed, ...usage.needed])].sort();
    into.coverage = scopeCoverage(into.needed, granted);
    return false;
  });
  for (const usage of folded) usage.members.sort((a, b) => a.localeCompare(b));
  return folded.sort((a, b) => a.pack_name.localeCompare(b.pack_name) || a.pack_slug.localeCompare(b.pack_slug));
};
