/** D-192 Slice 6c — shared connection-api wire-arg composition.
 *
 *  ONE composer for every declaration-driven vendor write that carries a nested
 *  REST body: the write executor's create/update dispatch AND the source-
 *  dependency resolver's container `create_op` invoke. Sharing it is load-bearing
 *  — a second copy would drift, and a create that composes its body differently
 *  than the sync/update path is exactly the silent mis-scope the collision guards
 *  exist to prevent (D-192, Slice-5 rescope
 *  note).
 *
 *  The catalog gateway passes caller args through in WIRE-KEY form; the
 *  connection-api adapter's body builder (`extractDotPrefix(params, 'body')`)
 *  splits ONLY the first `body.` segment. So a 2-level REST body key
 *  (`body.data.workspace`) reaches the adapter as the literal flat key
 *  `data.workspace` — the vendor never sees it inside `data`. Nesting BELOW the
 *  first segment must therefore be composed HERE, into an object value the
 *  adapter emits verbatim:
 *
 *    rest:    body.data.name + body.data.workspace  →  body.data = { name, workspace }
 *    graphql: title + teamId                         →  title, teamId  (flat variables)
 */

import type { IngredientManifest } from '@recued/contracts';

/** D-225 Slice 1 — `'mcp'` is a member so the "anything not graphql is rest"
 *  default can no longer absorb it SILENTLY. It has no composer: composing wire
 *  args for it is D-225 Slice 3's job, which found that mcp composes like
 *  GRAPHQL — a typed object of named arguments — and NOT like REST.
 *
 *  ⛔ This is the whole reason the member exists. Before the `ApiTransport`
 *  widening, `kind === 'graphql' ? 'graphql' : 'rest'` was EXHAUSTIVE over the
 *  binding kinds a work-entity Source can reach, so the fallback was correct.
 *  It stopped being correct the moment `mcp` joined the union — and it still
 *  READS correct, which is what makes it dangerous. A work-entity Source may
 *  declare no `contract_source` at all (the pin is optional and the gate
 *  excludes unpinned declarations), so an mcp-backed pack could reach here
 *  today and compose a REST `body.*` tree for a transport that reads `args` —
 *  sending a write whose arguments the tool never sees. Fail closed instead. */
export type WireTransport = 'rest' | 'graphql' | 'mcp';

const PROTO_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

/** Set a body-local dot path (`data.workspace`) into a plain nested tree.
 *  Refuses prototype-sensitive segments (defense in depth — the adapter filters
 *  too) AND a collision: a path whose parent is already a non-object, or whose
 *  leaf is already set. Two wire args writing the same body leaf is an authoring
 *  error the caller must surface, never a silent last-write-wins. */
const setBodyLeaf = (
  tree: Record<string, unknown>,
  path: string,
  value: unknown,
): boolean => {
  const segs = path.split('.');
  if (segs.some((s) => s.length === 0 || PROTO_SEGMENTS.has(s))) return false;
  let cur = tree;
  for (const seg of segs.slice(0, -1)) {
    const next = cur[seg];
    if (next === undefined) {
      cur[seg] = {};
    } else if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      return false; // cannot descend through a scalar/array already at this segment
    }
    cur = cur[seg] as Record<string, unknown>;
  }
  const leaf = segs[segs.length - 1]!;
  if (Object.prototype.hasOwnProperty.call(cur, leaf)) return false; // colliding leaf
  cur[leaf] = value;
  return true;
};

/** Compose wire-key → value ENTRIES into the transport's dispatch args.
 *
 *  Entries (not a Record) so a duplicate key across arg sources is VISIBLE and
 *  refused here — one authority per wire arg (Codex MED).
 *
 *  - **graphql**: every key is a flat mutation-variable name; a dotted key is a
 *    REST shape and is rejected. Passed through (the gateway maps the object →
 *    `variables`).
 *  - **rest**: `body.<dotted>` keys compose into per-top-segment subtrees emitted
 *    as `body.<top>`; every other key (REST path token, `query.*`) passes flat. */
export const composeWireArgs = (
  entries: ReadonlyArray<readonly [string, unknown]>,
  transport: WireTransport,
): { ok: true; args: Record<string, unknown> } | { ok: false; reason: string } => {
  // 🔑 D-225 Slice 3 — MCP composes exactly like GRAPHQL, not like REST.
  //
  // Slice 1 refused mcp here on the reasoning that "MCP tool arguments are a
  // typed object per the tool inputSchema, not a REST body tree or graphql
  // variables". The refusal was right (nothing was built) but the reason was
  // half wrong: a GraphQL operation's variables are ALSO a typed object of
  // named arguments. REST is the odd one out — only it has a URL plus a body
  // TREE that needs composing under `body.`.
  //
  // So both take the same branch: flat argument names, and a dotted key is a
  // REST shape that would arrive at the vendor as a literal `"a.b"` property.
  if (transport === 'graphql' || transport === 'mcp') {
    const args: Record<string, unknown> = {};
    for (const [key, value] of entries) {
      if (key.includes('.')) {
        return {
          ok: false,
          reason: `${transport} wire arg '${key}' must be a flat argument name — a nested body path is a REST shape`,
        };
      }
      if (Object.prototype.hasOwnProperty.call(args, key)) {
        return { ok: false, reason: `wire arg '${key}' is set by more than one source — one authority per arg` };
      }
      args[key] = value;
    }
    return { ok: true, args };
  }
  const tree: Record<string, unknown> = {};
  const flat: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    if (key === 'body' || key.startsWith('body.')) {
      const path = key.slice('body.'.length); // key==='body' → '' → refused below
      if (path.length === 0 || !setBodyLeaf(tree, path, value)) {
        return {
          ok: false,
          reason: `REST body wire arg '${key}' is not composable (empty path, a colliding leaf, or a non-object parent)`,
        };
      }
    } else {
      if (Object.prototype.hasOwnProperty.call(flat, key)) {
        return { ok: false, reason: `wire arg '${key}' is set by more than one source — one authority per arg` };
      }
      flat[key] = value;
    }
  }
  const args: Record<string, unknown> = { ...flat };
  for (const [top, value] of Object.entries(tree)) args[`body.${top}`] = value;
  return { ok: true, args };
};

/** The wire transport of one catalog op, from its surface execution binding
 *  (`surfaces.api.executes[opKey].kind`). Anything not graphql or mcp (openapi
 *  / google_discovery REST bindings) composes the REST body.
 *
 *  D-225 Slice 1 — `mcp` is reported as ITSELF rather than falling into the
 *  rest default; `composeWireArgs` then refuses it. See `WireTransport`. */
export const wireTransportOf = (
  manifest: IngredientManifest,
  opKey: string,
): WireTransport => {
  const kind = (
    manifest.surfaces?.api?.executes as Record<string, { kind?: string }> | undefined
  )?.[opKey]?.kind;
  if (kind === 'graphql') return 'graphql';
  if (kind === 'mcp') return 'mcp';
  return 'rest';
};
