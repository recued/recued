/**
 * §D.shell — the webclient's central deep-link router (R16, 2026-06-20).
 *
 * ONE hash scheme the shell owns: `#surface/subview/item[/subtab]`.
 *   #connections/mail/<account-id>  ·  #settings/ai-models  ·  #contracts/<id>/ops
 *
 * Replaces the prior split scheme — `#surface` for top routes PLUS a
 * per-surface `?key=value` query tail parsed by one-off helpers
 * (`parse{Runs,Recipes,Settings,Automation}…FromHash`). Every surface now
 * reads its slice off the parsed `ShellRoute.segments` and writes links via
 * `serializeShellRoute(...)`, so list→detail selections survive a refresh /
 * back-forward and can be cross-linked (R15 "used by pack X", the approvals
 * deep queue, Home "needs you" → the item).
 *
 * Segments are POSITIONAL, not typed — their meaning is the SURFACE's to
 * interpret: `#contracts/<id>/ops` puts the id at segment 0 and the tab at
 * segment 1, while `#connections/mail/<id>` puts the lane at 0 and the
 * account at 1. The router only splits + (de)serializes; the
 * `shellSubview/shellItem/shellSubtab` aliases name segments 0/1/2 after the
 * §D.shell vocabulary for surfaces that prefer it.
 */

/** Closed-list of route ids the shell can mount. Adding a surface — a top
 *  route like `approvals` (D-169 P2) — is a single entry here + a single case
 *  in the bootstrap's `mountRoute`. */
export const WEBCLIENT_ROUTE_IDS = [
  'reception',
  'settings',
  'approvals',
  'kitchen',
  'contracts',
  'connections',
  'packs',
  'recipes',
  'automation',
  'data',
  'logs',
  'chat',
] as const;
export type WebclientRouteId = (typeof WEBCLIENT_ROUTE_IDS)[number];
const WEBCLIENT_ROUTE_ID_SET: ReadonlySet<string> = new Set(WEBCLIENT_ROUTE_IDS);

/** The shell's default route. An empty or unknown hash falls through here.
 *  §D.L1 (shell-frame Step 5): the chat home is the default landing — it
 *  replaced the retired cockpit (`home`) + the retired `#compose` route. */
export const WEBCLIENT_DEFAULT_ROUTE: WebclientRouteId = 'chat';

/** A parsed hash: the resolved top-level surface + its (decoded) path tail. */
export interface ShellRoute {
  /** Always a valid route id — an unknown surface degrades to the default. */
  readonly surface: WebclientRouteId;
  /** Decoded path segments after the surface. `#contracts/<id>/ops` ⇒
   *  `['<id>', 'ops']`; `#logs` ⇒ `[]`. */
  readonly segments: readonly string[];
}

/** Strip a leading `#` and a leading `/` so `#/chat`, `#chat`, and
 *  `chat` all normalize to the same body. */
const stripHashPrefix = (hash: string): string => {
  const noHash = hash.startsWith('#') ? hash.slice(1) : hash;
  return noHash.startsWith('/') ? noHash.slice(1) : noHash;
};

/** `decodeURIComponent`, but a malformed segment (a lone `%`) returns itself
 *  rather than throwing — the router must never reject a hash. */
const decodeSegment = (raw: string): string => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

/** Parse a URL hash into its surface + decoded segment tail. */
export const parseShellRoute = (hash: string): ShellRoute => {
  const parts = stripHashPrefix(hash).split('/');
  // The surface tolerates (and discards) a stray legacy `?query` tail — so a
  // bookmarked `#logs?run_id=x` still resolves its surface rather than 404ing
  // to Home; the query value itself is dropped (pre-launch, no compat shim).
  const surfaceRaw = (parts[0] ?? '').split('?')[0] ?? '';
  const surface = WEBCLIENT_ROUTE_ID_SET.has(surfaceRaw)
    ? (surfaceRaw as WebclientRouteId)
    : WEBCLIENT_DEFAULT_ROUTE;
  const segments = parts
    .slice(1)
    .filter((part) => part.length > 0)
    .map(decodeSegment);
  return { surface, segments };
};

/** Resolve a hash to just its top-level surface (the route discriminator). */
export const parseRouteFromHash = (hash: string): WebclientRouteId =>
  parseShellRoute(hash).surface;

/** Segment 0 — the §D.shell "subview" (e.g. the Settings section, the
 *  Connections lane). `null` when absent. */
export const shellSubview = (route: ShellRoute): string | null =>
  route.segments[0] ?? null;
/** Segment 1 — the §D.shell "item" (e.g. the selected record id). */
export const shellItem = (route: ShellRoute): string | null =>
  route.segments[1] ?? null;
/** Segment 2 — the §D.shell "subtab" (e.g. a contract-detail tab). */
export const shellSubtab = (route: ShellRoute): string | null =>
  route.segments[2] ?? null;

/** Edit→Kitchen — the recipe id a `#kitchen/recipe/<id>` hash addresses (the
 *  recipe editor), or `null` for any other `#kitchen` hash (bare or the
 *  `#kitchen/pack[/<draft>]` pack-editor sibling). `recipe` is a reserved seg-0
 *  marker so it never collides with a pack draft id. Pure — the bootstrap's
 *  kitchen branch mounts the recipe editor iff this returns non-null. */
export const kitchenEditRecipeId = (route: ShellRoute): string | null =>
  route.surface === 'kitchen' && route.segments[0] === 'recipe'
    ? route.segments[1] ?? null
    : null;

/** Data -> Kitchen new-recipe context. `#kitchen/new/form-response/<id>`
 * addresses an UNSAVED recipe seed narrowed to one form definition. Keeping
 * `new` as a sibling of `recipe` means an installed recipe whose actual id is
 * `new` remains reachable at `#kitchen/recipe/new` without ambiguity. */
export interface KitchenNewRecipeSeed {
  readonly kind: 'form_response';
  readonly form_definition_id: string;
}

export const kitchenNewRecipeSeed = (
  route: ShellRoute,
): KitchenNewRecipeSeed | null => {
  if (
    route.surface !== 'kitchen'
    || route.segments[0] !== 'new'
    || route.segments[1] !== 'form-response'
    || route.segments.length !== 3
  ) return null;
  const formDefinitionId = route.segments[2] ?? '';
  return formDefinitionId.trim().length > 0
    ? { kind: 'form_response', form_definition_id: formDefinitionId }
    : null;
};

/** Edit→Kitchen — the draft id a `#kitchen/pack/<draft_id>` hash addresses (the
 *  pack editor opened on that draft), or `null` for `#kitchen/pack` (a fresh
 *  pack editor) and bare `#kitchen`. `pack` is the reserved seg-0 marker for the
 *  pack-editor sibling of `#kitchen/recipe/<id>`. Pure — the bootstrap's kitchen
 *  branch passes this as the builder's `initialDraftId` (self-loads the draft)
 *  and canonicalizes bare `#kitchen` to `#kitchen/pack`. */
export const kitchenPackDraftId = (route: ShellRoute): string | null =>
  route.surface === 'kitchen' && route.segments[0] === 'pack'
    ? route.segments[1] ?? null
    : null;

/** Build a hash from a surface + an ordered segment tail. `null`/`undefined`/
 *  empty segments are dropped; each segment is URL-encoded so a value with a
 *  `/` (e.g. a `publisher/name` recipe id) round-trips through the path. */
export const serializeShellRoute = (
  surface: WebclientRouteId,
  ...segments: ReadonlyArray<string | null | undefined>
): string => {
  const tail = segments
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .map((s) => encodeURIComponent(s))
    .join('/');
  return tail.length > 0 ? `#${surface}/${tail}` : `#${surface}`;
};

/** Canonical serialized form of a raw hash — drops a leading `/`, a stray
 *  `?tail`, and empty segments, then re-encodes. Two hashes that mean the
 *  same route normalize equal, so the same-route remount check below doesn't
 *  fire on cosmetic differences. */
export const normalizeShellHash = (hash: string): string => {
  const route = parseShellRoute(hash);
  return serializeShellRoute(route.surface, ...route.segments);
};

/** Surfaces whose mount depends on a deep-link segment — navigating WITHIN
 *  the surface to a different segment must tear down + re-mount so the new
 *  `initial*` selection takes hold. Surfaces NOT listed here no-op on a
 *  same-surface hash change. Extend as each list→detail surface gains an
 *  addressable selection (R16 sequences Connections/Contracts/Data/… in). */
export const WEBCLIENT_DEEP_LINK_ROUTES: ReadonlySet<WebclientRouteId> =
  new Set<WebclientRouteId>([
    'recipes',
    'logs',
    'settings',
    'automation',
    'contracts',
    'connections',
    // R18 — `#data/<tab>/<entity_id>` re-mounts on a tab / entity change so the
    // warehouse explorer's selection is a durable, shareable deep link.
    'data',
    // R19 — `#reception/<section>` (inbox · abuse · endpoints) re-mounts
    // on a section switch so the new `initialSection` takes; the deeper
    // endpoints segments (`#reception/endpoints/new|edit/<kind>`,
    // `#reception/endpoints/setup`, `#reception/endpoints/<id>`) ride the
    // same re-mount so authoring / wizard / detail are durable deep links.
    'reception',
    // R22 — `#packs/<slug>` re-mounts on a slug change so the packs
    // surface's list→detail selection is a durable, shareable deep link
    // (mirrors recipes/data). In-page selection uses replaceState so it
    // never remounts; only a link/refresh to a different slug does.
    'packs',
    // Kitchen (Edit→Kitchen) — `#kitchen/recipe/<id>` (recipe editor) and
    // `#kitchen/pack[/<draft>]` (pack editor) are sibling authoring surfaces
    // under one route, so a hash change BETWEEN them (or to a different
    // recipe / draft) must tear down + re-mount to swap editors / reload the
    // selection. In-page draft selection uses replaceState (no hashchange),
    // so it never remounts — matching the packs precedent.
    'kitchen',
  ]);

/** Whether a same-surface navigation should re-mount: true iff `route` is a
 *  deep-link surface AND the two hashes resolve to different routes. */
export const shouldRemountForSameRoute = (
  route: WebclientRouteId,
  previousHash: string,
  nextHash: string,
): boolean =>
  WEBCLIENT_DEEP_LINK_ROUTES.has(route)
  && normalizeShellHash(previousHash) !== normalizeShellHash(nextHash);
