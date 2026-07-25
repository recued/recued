/** UX-review flow-10 — derive the connection(s) a recipe needs.
 *
 *  The install-consent disclosure "never mentions the connection the
 *  recipe will need" (review flow-10). A recipe binds a connection two
 *  ways, both surfaced here:
 *
 *    - `{{connection.<kind>.<name>.<field>}}` refs anywhere in the recipe
 *      (the authoritative read-time binding) → carries kind + name.
 *    - a `read_connection_<name>` entry in `requires` (the declared
 *      permission) → carries name only (kind unknown).
 *
 *  Deduped by name; a ref-derived kind upgrades a permission-only entry.
 *  Pure — same recipe → same list (sorted by name for stable rendering).
 */

import { collectRefs, type ConnectionKind } from '@recued/contracts';
import type { RecipeDefinition } from '@recued/contracts';

export interface RequiredConnection {
  /** `'api' | 'mcp' | 'notification'` when a `connection.*` ref names the
   *  kind; `null` when only a `read_connection_*` permission declared it. */
  kind: ConnectionKind | null;
  /** Connection name — the `<name>` in `connection.<kind>.<name>` or the
   *  suffix of `read_connection_<name>`. */
  name: string;
}

const CONNECTION_KINDS: ReadonlySet<string> = new Set([
  'api',
  'mcp',
  'notification',
]);

const READ_CONNECTION_PREFIX = 'read_connection_';

/** Collapse raw needs to the distinct set a user must enroll. Connection
 *  storage keys on `(kind, name)`, so two refs with the same name but
 *  different kinds (`connection.api.default` + `connection.mcp.default`)
 *  are TWO needs and stay distinct. A kind-null entry (from a
 *  `read_connection_<name>` permission) is a coarse echo of the same
 *  requirement: it is dropped when any concrete-kind entry already names
 *  it, and kept only when nothing else does. Sorted by name then kind for
 *  stable rendering. Exported so the pack-install dialog can aggregate
 *  across a pack's recipes. */
export const dedupeRequiredConnections = (
  needs: ReadonlyArray<RequiredConnection>,
): RequiredConnection[] => {
  const concreteByName = new Map<string, Set<ConnectionKind>>();
  const nullNames = new Set<string>();
  for (const need of needs) {
    if (need.name.length === 0) continue;
    if (need.kind === null) {
      nullNames.add(need.name);
    } else {
      const kinds = concreteByName.get(need.name) ?? new Set<ConnectionKind>();
      kinds.add(need.kind);
      concreteByName.set(need.name, kinds);
    }
  }
  const out: RequiredConnection[] = [];
  for (const [name, kinds] of concreteByName) {
    for (const kind of kinds) out.push({ kind, name });
  }
  for (const name of nullNames) {
    if (!concreteByName.has(name)) out.push({ kind: null, name });
  }
  return out.sort(
    (a, b) =>
      a.name.localeCompare(b.name) || (a.kind ?? '').localeCompare(b.kind ?? ''),
  );
};

export const recipeRequiredConnections = (
  recipe: RecipeDefinition,
): RequiredConnection[] => {
  const raw: RequiredConnection[] = [];

  // 1. `{{connection.<kind>.<name>...}}` refs — authoritative, kind + name.
  for (const ref of collectRefs(recipe)) {
    if (ref.ns !== 'connection') continue;
    const [kindPart, namePart] = ref.path.split('.');
    if (
      kindPart !== undefined
      && namePart !== undefined
      && CONNECTION_KINDS.has(kindPart)
    ) {
      raw.push({ kind: kindPart as ConnectionKind, name: namePart });
    }
  }

  // 2. `read_connection_<name>` permissions — name only (kind unknown).
  for (const perm of recipe.requires ?? []) {
    if (perm.startsWith(READ_CONNECTION_PREFIX)) {
      raw.push({ kind: null, name: perm.slice(READ_CONNECTION_PREFIX.length) });
    }
  }

  return dedupeRequiredConnections(raw);
};
