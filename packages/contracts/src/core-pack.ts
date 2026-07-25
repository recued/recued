/** §5 recipe-publish policy — the binding-free kernel capability namespace.
 *
 *  A published marketplace recipe may reach a "richer" ingredient kind
 *  (`http`/`dom`/`mcp`/connection-egress/`ai-prompt`) ONLY through a pack-bound
 *  canonical op-step — the kind lives on the pack's catalog, resolved at install,
 *  so the recipe stays kind-agnostic. The only DIRECT ingredient steps a published
 *  recipe may carry are the kernel "core" capabilities: the things the system
 *  itself provides that a normal pack structurally can't (AI-pool routing,
 *  notification dispatch). They live under a reserved `core-` slug namespace so the
 *  publish gate's trust anchor is unspoofable: `core-*` cannot be published or
 *  registry-shadowed by a third party (see `RESERVED_SLUG_PREFIXES` in
 *  `content-policy.ts` + the manifest-registry guard), so a recipe step naming
 *  `core-ai-classify` unambiguously resolves to the bundled kernel capability.
 *
 *  `CORE_CAPABILITY_SLUGS` is the closed set of bare (un-prefixed) capability
 *  names, and `stripCorePrefix` is the strip-on-read normalization the dispatch
 *  consumers apply (the slug is load-bearing in the AI + kernel adapters, so
 *  `core-ai-classify` must route exactly like `ai-classify`). The publish gate
 *  (slice 3) allows a direct ingredient step iff its slug is `core-`-prefixed AND
 *  its stripped bare name is in this set.
 */

/** The reserved slug prefix for binding-free kernel capabilities. Hyphen (not a
 *  dot) so the existing slug regex `^[a-z][a-z0-9-]*[a-z0-9]$` admits it with no
 *  change. A `core-<bare>` slug exposes the kernel capability `<bare>`. */
export const CORE_SLUG_PREFIX = 'core-';

/** Is this slug in the reserved `core-` namespace? */
export const isCoreSlug = (slug: string): boolean => slug.startsWith(CORE_SLUG_PREFIX);

/** Strip a single leading `core-` so a `core-*` slug normalizes to its bare
 *  capability name for routing/contract reads (`core-ai-classify` → `ai-classify`,
 *  `notification-send` → `notification-send` unchanged). Apply at the point a
 *  consumer reads the slug for behavior; NEVER mutate `manifest.slug` itself (its
 *  identity must stay `core-*` for the reservation + anti-shadow). */
export const stripCorePrefix = (slug: string): string =>
  slug.startsWith(CORE_SLUG_PREFIX) ? slug.slice(CORE_SLUG_PREFIX.length) : slug;

/** The closed set of BARE (un-prefixed) kernel capability names a published recipe
 *  may invoke directly as a `core-<bare>` ingredient step — the things the system
 *  itself provides that a normal pack structurally can't:
 *    - the 9 contracted AI functions (fixed input/output contract);
 *    - `ai-prompt`, the uncontracted free-prompt function — admitted because its
 *      threat surface is the same as the contracted nine (the contracted functions
 *      also carry author-supplied free text via `llm.context` / field descriptions,
 *      and the real data-access + egress controls live at the connection / gateway /
 *      grant layer, which applies identically). The ONE capability difference —
 *      `llm.allow_search` (web egress) — is neutralized for EVERY publishable
 *      `core-*` AI slug: the LLM executor forces search OFF for any `core-`-prefixed
 *      slug (§5 routes published-recipe web egress only through gated pack ops like
 *      `web.search`, never an ungated AI-step search); the kernel bare slugs keep it.
 *      `ai-embed` is included (D-174 R28 — embeddings routes to the embeddings
 *      executor; same egress profile as the contracted nine, no web-search);
 *    - notification dispatch (the bounded channel-delivery surface that resolves
 *      through the user's configured notification connections, not a per-recipe
 *      binding) — matches the pure-workflow notify set.
 *  This is the gate's allow-set after `stripCorePrefix`. A drift-guard test asserts
 *  it stays a superset of `@recued/llm`'s `CONTRACTED_SLUGS`. */
export const CORE_CAPABILITY_SLUGS: ReadonlySet<string> = new Set([
  // contracted AI
  'ai-classify',
  'ai-score',
  'ai-extract',
  'ai-summarize',
  'ai-sentiment',
  'ai-compare',
  'ai-generate',
  'ai-translate',
  'ai-rewrite',
  // embeddings (D-174 R28 — `ai-embed` / `core-ai-embed` route to the embeddings
  // executor; same egress profile as the contracted nine).
  'ai-embed',
  // uncontracted free-prompt (web-search egress neutralized for every core- AI
  // slug by the LLM executor).
  'ai-prompt',
  // notification dispatch
  'notification-send',
  'mail-post',
  'slack-post',
]);

/** Is `slug` a valid direct core capability step — `core-`-prefixed AND its bare
 *  name a known kernel capability? The publish gate's allow predicate for direct
 *  ingredient steps. */
export const isCoreCapabilitySlug = (slug: string): boolean =>
  isCoreSlug(slug) && CORE_CAPABILITY_SLUGS.has(stripCorePrefix(slug));
