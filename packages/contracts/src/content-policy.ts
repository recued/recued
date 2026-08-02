/** Marketplace content policy — publisher handles, slugs, text safety.
 *
 *  Shared between Edge Functions (server-side enforcement) and
 *  client-side UI (instant feedback). Server is the authority;
 *  client checks are advisory for UX speed.
 */

import { CORE_SLUG_PREFIX } from './core-pack.js';
import {
  describeUnstorable,
  findUnstorableStrings,
  UNSTORABLE_FINDING_LIMIT,
} from './storable-encoding.js';

// ────────────────────────────────────────────────────────────────
// Reserved publisher handles
// ────────────────────────────────────────────────────────────────

/** Handles that cannot be claimed by users. Includes:
 *  - Recued system accounts
 *  - Common auth/admin terms
 *  - Offensive or confusing terms
 *  - Platform/vendor names that could mislead */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  // System
  'recued', 'recued-core', 'recued-official', 'recued-team', 'recued-admin',
  // D-225 Slice 2 — the publisher of packs the runtime GENERATES on this
  // machine (`GENERATED_PACK_PUBLISHER`). Reserved so no third party can
  // publish under a handle that reads as locally-minted.
  'recued-local',
  'core', // §5 — the binding-free kernel capability namespace (core-* slugs)
  // D-225 § 9.9 — the two GRANT-ENTRY prefixes. A STAMPED pack's operation_id
  // is `<publisher>.<pack>.<key>` (D-221 Records, D-225 generated), so a
  // publisher holding either handle would mint op ids that collide with the
  // reserved grant-entry namespace: `opGrantEntry` throws
  // `grant_entry_op_id_reserved_prefix`, and a stored key would classify as a
  // `collection` rather than an `op` — the fail-closed admission bug
  // `grant-entry.ts` warns about, arriving through the publisher handle.
  //
  // ⚠ The older SLASH form (`<author>/<entity>.<verb>`) could not collide,
  // because it carried a `/` before any `.`. That is exactly the invariant the
  // dotted stamp broke, and reserving these is what restores it by
  // construction rather than by comment.
  'data', 'enrichment',
  // D-228 — server-minted OP namespaces. These classify as ordinary op grants,
  // so a dotted pack stamp owned by either publisher handle would collide with
  // a genuine Tier-1 / ingredient-tool grant instead of failing structurally.
  'primitive', 'ingredient',
  'system', 'admin', 'administrator', 'moderator', 'mod', 'staff', 'support',
  'official', 'internal', 'test', 'demo', 'example', 'sample',
  // Auth / security
  'root', 'superuser', 'master', 'slave', 'user', 'login', 'password',
  'auth', 'token', 'api', 'key', 'secret', 'credential',
  // Platform names (impersonation risk)
  'hubspot', 'salesforce', 'pipedrive', 'zendesk', 'intercom',
  'openai', 'anthropic', 'google', 'microsoft', 'github', 'gitlab',
  'aws', 'azure', 'cloudflare', 'supabase', 'stripe', 'paddle',
  // AI / LLM (vault namespace collision risk)
  'ai', 'llm', 'model', 'bot', 'chatbot', 'agent',
  // Infrastructure
  'localhost', 'null', 'undefined', 'void', 'none', 'anonymous',
  'default', 'public', 'private', 'local',
  // Offensive (representative set — extend as needed)
  'fuck', 'shit', 'ass', 'damn', 'bitch', 'bastard', 'cunt', 'dick',
  'nigger', 'nigga', 'faggot', 'retard', 'whore', 'slut',
  'nazi', 'hitler', 'isis', 'terrorist', 'kill', 'murder', 'rape',
]);

export interface ContentIssue {
  code: string;
  field: string;
  message: string;
}

// ────────────────────────────────────────────────────────────────
// Publisher handle canonicalization
// ────────────────────────────────────────────────────────────────

/** Reduce a publisher handle to its canonical form: trim + lowercase.
 *
 *  The registration validator (below) already rejects uppercase and
 *  whitespace, so new publishers coming through the UI are canonical by
 *  construction. But handles reach the extension from many other ingress
 *  paths — recipe JSON, bundle imports, sync pulls, marketplace API,
 *  kitchen forks. Each of those must normalize before comparing,
 *  storing, or using the value as a vault namespace segment. Otherwise
 *  `Recued-Core` and `recued-core` hash to different vault scopes and
 *  create either credential leaks (aliased scope) or silent failures
 *  (scope split). One helper, used at every ingest boundary, keeps
 *  comparisons stable without resorting to server-side case-insensitive
 *  collation. */
export const canonicalizePublisher = (handle: string | null | undefined): string => {
  if (!handle) return '';
  return String(handle).trim().toLowerCase();
};

// ────────────────────────────────────────────────────────────────
// Publisher handle validation
// ────────────────────────────────────────────────────────────────

export const validatePublisherHandle = (handle: string): ContentIssue[] => {
  const issues: ContentIssue[] = [];
  const h = handle.toLowerCase().trim();

  if (!h) {
    issues.push({ code: 'handle_empty', field: 'id', message: 'Publisher handle is required' });
    return issues;
  }

  if (h.length < 6) {
    issues.push({ code: 'handle_too_short', field: 'id', message: 'Handle must be at least 6 characters' });
  }
  if (h.length > 40) {
    issues.push({ code: 'handle_too_long', field: 'id', message: 'Handle must be 40 characters or fewer' });
  }

  // Format check on raw input (before lowercasing) to catch uppercase
  if (handle.trim() !== h) {
    issues.push({ code: 'handle_format', field: 'id', message: 'Handle must be lowercase — no uppercase letters' });
  }
  if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(h) && h.length > 1) {
    issues.push({ code: 'handle_format', field: 'id', message: 'Handle must be lowercase letters, numbers, and hyphens. Must start with a letter and end with a letter or number' });
  }

  if (RESERVED_HANDLES.has(h)) {
    issues.push({ code: 'handle_reserved', field: 'id', message: `'${h}' is reserved and cannot be used as a publisher handle` });
  }

  // Check if handle contains a reserved word as a substring
  for (const word of RESERVED_HANDLES) {
    if (word.length >= 4 && h === word) {
      break; // Exact match already caught above
    }
  }

  return issues;
};

// ────────────────────────────────────────────────────────────────
// Text content safety
// ────────────────────────────────────────────────────────────────

/** Words that are blocked in user-facing text (names, descriptions, tags). */
const BLOCKED_WORDS: ReadonlySet<string> = new Set([
  'fuck', 'shit', 'cunt', 'nigger', 'nigga', 'faggot', 'retard',
  'nazi', 'hitler', 'isis', 'terrorist', 'rape',
]);

/** Check a text string for blocked content. Returns issues if found. */
export const validateTextContent = (text: string, field: string): ContentIssue[] => {
  const issues: ContentIssue[] = [];
  const lower = text.toLowerCase();

  for (const word of BLOCKED_WORDS) {
    // Word-start boundary — catches "fucking" from "fuck" but not "assassin" from "ass"
    const re = new RegExp(`\\b${word}`, 'i');
    if (re.test(lower)) {
      issues.push({
        code: 'content_blocked',
        field,
        message: `Contains blocked content. Please use appropriate language.`,
      });
      break; // One issue per field is enough
    }
  }

  return issues;
};

/** Check a list of tags for safety. Multi-segment tags using colons
 *  (e.g. D-116 `template:reactive:mail`) are allowed — each segment
 *  must follow the single-tag format. */
export const validateTags = (tags: string[]): ContentIssue[] => {
  const issues: ContentIssue[] = [];
  const SEGMENT = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
  for (const tag of tags) {
    if (tag.length > 30) {
      issues.push({ code: 'tag_too_long', field: 'tags', message: `Tag '${tag}' exceeds 30 characters` });
    }
    if (tag.length > 1) {
      const segments = tag.split(':');
      const ok = segments.every((s) => s.length === 1 ? /^[a-z0-9]$/.test(s) : SEGMENT.test(s));
      if (!ok) {
        issues.push({ code: 'tag_format', field: 'tags', message: `Tag '${tag}' must be lowercase alphanumeric with hyphens (optional ':' namespace separator)` });
      }
    }
    const textIssues = validateTextContent(tag, 'tags');
    issues.push(...textIssues);
  }
  if (tags.length > 15) {
    issues.push({ code: 'tags_too_many', field: 'tags', message: 'Maximum 15 tags allowed' });
  }
  return issues;
};

/** D-116 — Handles authorised to publish recipes carrying
 *  `template:*` tags. Third-party recipes with a `template:` tag are
 *  stripped at publish time (see `stripUnauthorizedTemplateTags`).
 *  Prevents SEO-chasing authors from polluting the gallery. */
export const AUTHORIZED_TEMPLATE_PUBLISHERS: ReadonlySet<string> = new Set([
  'recued-core',
]);

/** D-116 — Return a copy of `tags` with unauthorised `template:*`
 *  entries removed. Preserves order among retained tags. Safe to call
 *  with arbitrary input — non-string / non-array inputs return []. */
export const stripUnauthorizedTemplateTags = (
  tags: unknown,
  publisher_id: string,
): string[] => {
  if (!Array.isArray(tags)) return [];
  if (AUTHORIZED_TEMPLATE_PUBLISHERS.has(publisher_id)) {
    return tags.filter((t): t is string => typeof t === 'string');
  }
  return tags.filter((t): t is string => typeof t === 'string' && !t.startsWith('template:'));
};

/** D-116 — Extract the vertical segment from a `template:reactive:<vertical>`
 *  tag. Returns null when the tag doesn't match the expected shape.
 *  Used by the marketplace to index templates by vertical. */
export const parseTemplateVertical = (tag: string): string | null => {
  if (!tag.startsWith('template:')) return null;
  const parts = tag.split(':');
  if (parts.length < 3) return null;
  return parts[2] || null;
};

// ────────────────────────────────────────────────────────────────
// Slug validation
// ────────────────────────────────────────────────────────────────

/** Reserved slug prefixes that users cannot publish under. `core-` is the
 *  binding-free kernel capability namespace (§5 recipe-publish policy): the
 *  publish gate trusts a recipe's direct `core-*` ingredient steps as kernel
 *  capabilities, so a third party must not be able to publish (or, via the
 *  manifest registry, shadow) a `core-*` slug — that would make the gate's
 *  trust anchor spoofable. See `stripCorePrefix` / `CORE_CAPABILITY_SLUGS`. */
const RESERVED_SLUG_PREFIXES = ['recued-', 'system-', 'internal-', 'local/', CORE_SLUG_PREFIX];

export const validateSlug = (slug: string, field = 'slug'): ContentIssue[] => {
  const issues: ContentIssue[] = [];

  if (!slug || slug.length < 3) {
    issues.push({ code: 'slug_too_short', field, message: 'Slug must be at least 3 characters' });
    return issues;
  }
  if (slug.length > 80) {
    issues.push({ code: 'slug_too_long', field, message: 'Slug must be 80 characters or fewer' });
  }
  if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(slug)) {
    issues.push({ code: 'slug_format', field, message: 'Slug must be lowercase alphanumeric with hyphens' });
  }
  for (const prefix of RESERVED_SLUG_PREFIXES) {
    if (slug.startsWith(prefix)) {
      issues.push({ code: 'slug_reserved_prefix', field, message: `Slug cannot start with '${prefix}'` });
    }
  }
  const textIssues = validateTextContent(slug.replace(/-/g, ' '), field);
  issues.push(...textIssues);

  return issues;
};

// ────────────────────────────────────────────────────────────────
// Recipe bundle-pack identities
// ────────────────────────────────────────────────────────────────

export interface RecipeBundleKeyParts {
  publisher: string;
  bundle_slug: string;
}

export const parseRecipeBundleKey = (bundle: string): RecipeBundleKeyParts | null => {
  const parts = bundle.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { publisher: parts[0], bundle_slug: parts[1] };
};

export const RECIPE_BUNDLE_SHARED_STATES = [
  // D-200 — an authoritative workflow row may live at one stable key while
  // the lifecycle partitions below remain derived, self-healing indexes.
  'state',
  'active',
  'needs_owner',
  'proposal',
  'timed_out',
  'closed',
] as const;

export type RecipeBundleSharedState = (typeof RECIPE_BUNDLE_SHARED_STATES)[number];

export const isRecipeBundleSharedState = (
  value: unknown,
): value is RecipeBundleSharedState =>
  typeof value === 'string'
  && (RECIPE_BUNDLE_SHARED_STATES as readonly string[]).includes(value);

const retargetIssue = (issue: ContentIssue, field: string): ContentIssue => ({
  ...issue,
  field,
});

/** D-195 standalone bundle-pack identity validation. This checks only the
 *  `<publisher>/<pack_slug>` shape because standalone recipe authoring has no
 *  trustworthy publisher context. Direct pack identity/membership is verified
 *  where the current recipe and pack catalogs are available. */
export const validateRecipeBundleKey = (
  value: unknown,
  field = 'metadata.recipe_bundle',
): ContentIssue[] => {
  if (value === undefined) return [];
  if (typeof value !== 'string') {
    return [{
      code: 'recipe_bundle_type',
      field,
      message: 'recipe_bundle must be a string shaped as <pack.publisher>/<pack.slug>',
    }];
  }
  if (!value) {
    return [{
      code: 'recipe_bundle_empty',
      field,
      message: 'recipe_bundle must not be empty',
    }];
  }
  const parsed = parseRecipeBundleKey(value);
  if (!parsed) {
    return [{
      code: 'recipe_bundle_format',
      field,
      message: 'recipe_bundle must contain exactly one "/" separator: <pack.publisher>/<pack.slug>',
    }];
  }

  const issues: ContentIssue[] = [];
  for (const issue of validatePublisherHandle(parsed.publisher)) {
    // Reserved handles are blocked for public registration, but first-party
    // publishers such as recued-core must remain valid bundle publishers.
    if (issue.code === 'handle_reserved') continue;
    issues.push(retargetIssue(issue, `${field}.publisher`));
  }
  for (const issue of validateSlug(parsed.bundle_slug, `${field}.bundle_slug`)) {
    issues.push(issue);
  }
  return issues;
};

/** D-195 shared-storage prefix helper. When a workflow uses its install-pack
 *  identity as its state namespace, the sanitized key is derived from the full
 *  `<publisher>/<pack_slug>` value so honest workflows do not collide across
 *  publishers. Returns `null` when the key cannot be embedded safely. */
export const sanitizeRecipeBundleKey = (bundle: string): string | null => {
  if (validateRecipeBundleKey(bundle).length > 0) return null;
  const parsed = parseRecipeBundleKey(bundle);
  if (!parsed) return null;
  return `${parsed.publisher}_${parsed.bundle_slug}`;
};

export const recipeBundleSharedPrefix = (
  bundle: string,
  state: RecipeBundleSharedState,
): string | null => {
  if (!isRecipeBundleSharedState(state)) return null;
  const sanitized = sanitizeRecipeBundleKey(bundle);
  if (!sanitized) return null;
  return `data.shared.recipe.${sanitized}.${state}.`;
};

/** D-195 watcher row keys append exactly one dot-free segment after the
 *  state-partitioned prefix. This is intentionally for concrete row keys after
 *  interpolation/sanitization, not for authored `{{step.*}}` templates. */
export const isRecipeBundleSharedRowKeySegment = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);

export const recipeBundleSharedKey = (
  bundle: string,
  state: RecipeBundleSharedState,
  rowKey: unknown,
): string | null => {
  if (!isRecipeBundleSharedRowKeySegment(rowKey)) return null;
  const prefix = recipeBundleSharedPrefix(bundle, state);
  if (prefix === null) return null;
  return `${prefix}${rowKey}`;
};

/** D-195 publisher-context check. Use this only where the caller already knows
 *  the authoritative marketplace publisher_id for the recipe. */
export const validateRecipeBundlePublisher = (
  recipe: Record<string, unknown>,
  publisher_id: string,
  field = 'metadata.recipe_bundle',
): ContentIssue[] => {
  const meta = recipe.metadata;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return [];
  const bundle = (meta as Record<string, unknown>).recipe_bundle;
  if (bundle === undefined) return [];
  const issues = validateRecipeBundleKey(bundle, field);
  if (issues.length > 0) return issues;
  const parsed = parseRecipeBundleKey(bundle as string);
  if (!parsed) return [];
  if (parsed.publisher !== publisher_id) {
    return [{
      code: 'recipe_bundle_publisher_mismatch',
      field,
      message: `recipe_bundle publisher '${parsed.publisher}' must match publisher_id '${publisher_id}'`,
    }];
  }
  return [];
};

// ────────────────────────────────────────────────────────────────
// Full publish validation
// ────────────────────────────────────────────────────────────────

/** Validate all user-facing content in a recipe for marketplace publishing. */
export const validateRecipeContent = (recipe: Record<string, unknown>): ContentIssue[] => {
  const issues: ContentIssue[] = [];
  const meta = (recipe.metadata ?? {}) as Record<string, unknown>;

  // Whole-document storable-encoding sweep, BEFORE the per-field checks below.
  // Those inspect six named fields; the characters that have actually broken a
  // publish sat nowhere near them, so this deliberately walks everything —
  // steps, schemas, nested composition bodies included.
  const unstorable = findUnstorableStrings(recipe);
  for (const f of unstorable) {
    issues.push({ code: 'unstorable_encoding', field: f.path.replace(/^\./, ''), message: describeUnstorable(f) });
  }
  if (unstorable.length >= UNSTORABLE_FINDING_LIMIT) {
    issues.push({
      code: 'unstorable_encoding_truncated',
      field: '',
      message: `report capped at ${UNSTORABLE_FINDING_LIMIT} findings; there may be more`,
    });
  }

  // Slug
  if (typeof recipe.recipe_id === 'string') {
    issues.push(...validateSlug(recipe.recipe_id, 'recipe_id'));
  }

  // Name and description
  if (typeof meta.name === 'string') {
    issues.push(...validateTextContent(meta.name, 'metadata.name'));
    if (meta.name.length > 100) {
      issues.push({ code: 'name_too_long', field: 'metadata.name', message: 'Name must be 100 characters or fewer' });
    }
  }
  if (typeof meta.description === 'string') {
    issues.push(...validateTextContent(meta.description, 'metadata.description'));
    if (meta.description.length > 500) {
      issues.push({ code: 'description_too_long', field: 'metadata.description', message: 'Description must be 500 characters or fewer' });
    }
  }

  // Readme
  if (typeof meta.readme === 'string') {
    if (meta.readme.length > 10000) {
      issues.push({ code: 'readme_too_long', field: 'metadata.readme', message: 'Readme must be 10,000 characters or fewer' });
    }
    issues.push(...validateTextContent(meta.readme, 'metadata.readme'));
  }

  // Tags
  if (Array.isArray(meta.tags)) {
    issues.push(...validateTags(meta.tags as string[]));
  }

  issues.push(...validateRecipeBundleKey(meta.recipe_bundle));

  return issues;
};

/** Validate all user-facing content in an ingredient for marketplace publishing. */
export const validateIngredientContent = (manifest: Record<string, unknown>): ContentIssue[] => {
  const issues: ContentIssue[] = [];

  if (typeof manifest.slug === 'string') {
    issues.push(...validateSlug(manifest.slug, 'slug'));
  }
  if (typeof manifest.name === 'string') {
    issues.push(...validateTextContent(manifest.name, 'name'));
    if (manifest.name.length > 100) {
      issues.push({ code: 'name_too_long', field: 'name', message: 'Name must be 100 characters or fewer' });
    }
  }
  if (typeof manifest.description === 'string') {
    issues.push(...validateTextContent(manifest.description, 'description'));
    if (manifest.description.length > 500) {
      issues.push({ code: 'description_too_long', field: 'description', message: 'Description must be 500 characters or fewer' });
    }
  }
  if (Array.isArray(manifest.tags)) {
    issues.push(...validateTags(manifest.tags as string[]));
  }

  return issues;
};
