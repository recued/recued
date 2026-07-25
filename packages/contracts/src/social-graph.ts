/** D-145 PB8 — Social-graph intelligence addon (contracts).
 *
 *  Closed-list registries + types the engine's social-graph flow
 *  composes. Pure type / closed-list types stay here so consumers
 *  (recipes, ui, packs) don't pull engine internals.
 *
 *  The social-graph addon is *one optional addon among many* per
 *  § B.9 — equal-citizen to weather / news / Wolfram / custom
 *  adapters. Engine is the product, not any single primitive. The
 *  load-bearing architectural commitment is the four-class data
 *  model: only `social_raw_body` is gated to immediate-use-only;
 *  derived summaries, response synthesis, and provenance links
 *  persist by design.
 *
 *  Spec: D-145 § B.9 + § B.9.5. */

import type { ContextContentClass, ContextPersistPolicy } from './recued-plan.js';
import { CONTEXT_CLASS_PERSIST_POLICIES } from './recued-plan.js';

// ── PB8.1 — Closed list of social-graph platforms ───────────────────

/** Platforms covered by the v1.0 social-graph addon. Adding a new
 *  platform requires (a) a new bridge ingredient with
 *  `surface_kind: 'reading'`, (b) a marketplace-validator entry, and
 *  (c) a substrate D-spec annotation + this list extension.
 *
 *  Permanently scoped to publishing surfaces — messaging-surface
 *  platforms (WhatsApp / iMessage / Signal / Messenger / DMs of any
 *  kind) are out of scope per § B.9.1. */
export const SOCIAL_PLATFORMS = [
  'facebook',
  'instagram',
  'x',
  'linkedin',
  'github',
] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];
export const SOCIAL_PLATFORM_SET: ReadonlySet<SocialPlatform> = new Set(SOCIAL_PLATFORMS);

/** Per-platform `contact_alias` kind name (uniform — all platforms
 *  alias under `kind: 'platform_id'`; the platform itself sits on the
 *  alias row's `platform` column). Constant exposed for the engine's
 *  alias-lookup queries. */
export const SOCIAL_ALIAS_KIND = 'platform_id' as const;
export type SocialAliasKind = typeof SOCIAL_ALIAS_KIND;

/** Per-platform bridge ingredient slug. DORMANT — the `*-profile-reader`
 *  ingredients were retired in the kernel/community separation, so this map is
 *  no longer consulted by the (now stem-less) social-graph flow; a social
 *  lookup is authored manually as a recipe whose steps are op-steps. Kept as
 *  dormant substrate for a future re-enable. */
export const SOCIAL_PLATFORM_INGREDIENT_SLUG: Readonly<
  Record<SocialPlatform, string>
> = {
  facebook: 'facebook-profile-reader',
  instagram: 'instagram-profile-reader',
  x: 'x-profile-reader',
  linkedin: 'linkedin-profile-reader',
  github: 'github-profile-reader',
};

/** Per-platform login-site (for the `logged_in` capacity probe). The
 *  capacity walker resolves the site from this map when composing the
 *  capacity_spec for a social lookup. */
export const SOCIAL_PLATFORM_LOGIN_SITE: Readonly<Record<SocialPlatform, string>> = {
  facebook: 'facebook.com',
  instagram: 'instagram.com',
  x: 'x.com',
  linkedin: 'linkedin.com',
  github: 'github.com',
};

// ── PB8.2 — Four data classes per § B.9.5 ───────────────────────────

/** Closed list of the four content classes a social-graph flow
 *  produces. Maps to `ContextContentClass` for the plan-IR; the union
 *  is narrower than the full closed list because only these four are
 *  reachable from the social flow. The validator at flow-emit time
 *  rejects any class outside this set.
 *
 *  Per § B.9.5:
 *    - `social_raw_body`        — `immediate_use_only`; in-memory
 *                                 request scope only; never reaches
 *                                 `data_memory.payload`.
 *    - `social_derived_summary` — `persist`; engine-emitted structured
 *                                 audit-clean projection (counts +
 *                                 topics).
 *    - `response_synthesis`     — `persist`; AI-composed user-facing
 *                                 reply derived from social content.
 *    - `system_provenance`      — `persist`; D-120 link-graph
 *                                 metadata: lookup happened on date
 *                                 X for contact Y. Carries no body. */
export const SOCIAL_CONTENT_CLASSES = [
  'social_raw_body',
  'social_derived_summary',
  'response_synthesis',
  'system_provenance',
] as const;
export type SocialContentClass = (typeof SOCIAL_CONTENT_CLASSES)[number];
export const SOCIAL_CONTENT_CLASS_SET: ReadonlySet<SocialContentClass> = new Set(
  SOCIAL_CONTENT_CLASSES,
);

/** Per-class persist policy assertion — the social-graph flow's
 *  invariant. Mirrors the upstream `CONTEXT_CLASS_PERSIST_POLICIES`
 *  registry on `recued-plan.ts`; the flow's runtime composer asserts
 *  the two registries agree at boot, so a future widening of the
 *  upstream registry that contradicts the social flow's expectations
 *  fails fast instead of silently widening the leak surface.
 *
 *  Hard invariants:
 *    - `social_raw_body` MUST be `'immediate_use_only'` and NOT
 *      admit `'persist'` or `'redacted_only'`.
 *    - `social_derived_summary` + `response_synthesis` MUST admit
 *      `'persist'`.
 *    - `system_provenance` MUST admit `'persist'`. */
export const SOCIAL_CLASS_REQUIRED_POLICIES: Readonly<
  Record<SocialContentClass, ReadonlyArray<ContextPersistPolicy>>
> = {
  social_raw_body: ['immediate_use_only'],
  social_derived_summary: ['persist'],
  response_synthesis: ['persist'],
  system_provenance: ['persist'],
};

/** Self-check helper — asserts the upstream
 *  `CONTEXT_CLASS_PERSIST_POLICIES` registry agrees with the
 *  social-graph flow's expected per-class policies. Returns the list
 *  of mismatches; empty list = registries agree. The composer calls
 *  this at boot + the test suite asserts it stays empty as a ratchet.
 *
 *  Detects the failure mode where someone widens
 *  `CONTEXT_CLASS_PERSIST_POLICIES.social_raw_body` from
 *  `['immediate_use_only']` to `['immediate_use_only', 'persist']`
 *  without realizing the social flow's no-storage invariant depends
 *  on the narrow form. */
export const detectSocialClassPolicyDrift = (): ReadonlyArray<{
  class: SocialContentClass;
  expected: ReadonlyArray<ContextPersistPolicy>;
  actual: ReadonlyArray<ContextPersistPolicy>;
}> => {
  const drift: Array<{
    class: SocialContentClass;
    expected: ReadonlyArray<ContextPersistPolicy>;
    actual: ReadonlyArray<ContextPersistPolicy>;
  }> = [];
  for (const cls of SOCIAL_CONTENT_CLASSES) {
    const expected = SOCIAL_CLASS_REQUIRED_POLICIES[cls];
    // The social_classes are a strict subset of ContextContentClass.
    const actual = CONTEXT_CLASS_PERSIST_POLICIES[cls as ContextContentClass];
    if (
      expected.length !== actual.length ||
      expected.some((p, i) => p !== actual[i])
    ) {
      drift.push({ class: cls, expected, actual });
    }
  }
  return drift;
};

// ── PB8.3 — Bridge fetch result shape (in-memory request scope) ─────

/** Per-post excerpt the bridge returns. The body string is
 *  `social_raw_body` class — substrate gates persistence; this shape
 *  is the in-memory carrier between bridge response and AI synthesis.
 *  Bridge ingredients vary in fields; this is the canonical narrowed
 *  shape the social flow consumes. */
export interface SocialBridgePost {
  /** Platform-native id (post id, tweet id, gist id, etc.). Free of
   *  PII / body content — opaque identifier only. */
  id: string;
  /** Unix-ms when the post was published. */
  published_at: number;
  /** Post body excerpt — `social_raw_body` class. Persistence-gated. */
  body_excerpt: string;
  /** Free-text platform-defined topical category (`'family'` /
   *  `'work'` / `'travel'` / etc.). Bridge ingredient may emit empty
   *  string when no category derivable. */
  topic?: string;
  /** Optional engagement counts the AI may use as ranking signal.
   *  Counts are engagement evidence, not body content — persistence
   *  is independent of `social_raw_body` gating. */
  engagement?: {
    likes?: number;
    comments?: number;
    shares?: number;
  };
}

/** Bridge response envelope — whole social-graph fetch result before
 *  the four-class projection. The flow tags `posts` as
 *  `social_raw_body` content immediately on receipt; downstream
 *  transformations produce the derived summary + response synthesis
 *  on a per-class projection. */
export interface SocialBridgeFetchResult {
  platform: SocialPlatform;
  /** Platform-native profile id (`mary.castellanos.42`). Free of PII;
   *  the alias resolution upstream produced this from the contact's
   *  `contact_alias` row + capacity_spec walk. */
  profile_id: string;
  /** Window the fetch covered. Bridge ingredients pin a default —
   *  recipes can override. */
  window_days: number;
  /** Posts in the fetched window. Body excerpts are
   *  `social_raw_body` class. */
  posts: ReadonlyArray<SocialBridgePost>;
  /** Wall-clock when the bridge dispatch completed. */
  fetched_at: number;
}

// ── PB8.4 — Derived-summary projection ──────────────────────────────

/** Engine-emitted structured projection of the bridge result. Class:
 *  `social_derived_summary`; persists. Designed so a downstream AI
 *  follow-up call (or audit replay) can read the *shape* of the
 *  social activity without reading any post body. */
export interface SocialDerivedSummary {
  platform: SocialPlatform;
  profile_id: string;
  window_days: number;
  posts_count: number;
  /** Counts only — never bodies. `topic` keys the producer may emit
   *  are platform-defined; the engine doesn't enumerate them. */
  topic_counts: Readonly<Record<string, number>>;
  /** ISO date strings for the most-recent and least-recent posts in
   *  the window. Audit replay uses for staleness signals. */
  most_recent_post_at?: number;
  least_recent_post_at?: number;
}

// ── PB8.5 — Wrong-person handling decision shape (§ B.9.7) ──────────

/** Closed list of decisions the alias-resolution evaluator returns.
 *  Per § B.9.7 — never silent attachment. The engine routes to a
 *  user-confirmation queue when `'queue_for_user_confirm'`; runs the
 *  social lookup when `'auto_confirm'`; halts when `'reject'`. */
export const SOCIAL_ALIAS_RESOLUTION_DECISIONS = [
  'auto_confirm',
  'queue_for_user_confirm',
  'reject',
] as const;
export type SocialAliasResolutionDecision =
  (typeof SOCIAL_ALIAS_RESOLUTION_DECISIONS)[number];
export const SOCIAL_ALIAS_RESOLUTION_DECISION_SET: ReadonlySet<SocialAliasResolutionDecision> =
  new Set(SOCIAL_ALIAS_RESOLUTION_DECISIONS);

/** Confidence floor below which the engine queues for confirmation
 *  rather than dispatching. Hard threshold; per § B.9.7 the engine
 *  never silently attaches a profile id below the floor. */
export const SOCIAL_ALIAS_AUTO_CONFIRM_FLOOR = 0.85;

/** Confidence floor below which the engine outright rejects the
 *  resolution (degrades to lazy-ask via capacity_spec
 *  `annotation` gap). Below the floor the AI's resolution is too
 *  weak to even put in front of the user as a confirmation prompt. */
export const SOCIAL_ALIAS_REJECT_FLOOR = 0.5;
