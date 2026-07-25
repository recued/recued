/** D-145 PB8 / PC1 — Bridge platform classification (publishing-vs-
 *  messaging marketplace validator substrate).
 *
 *  Closed-list registries the marketplace's four-gate validator
 *  consults to decide whether a Bridge ingredient submission is
 *  publishing / authoring / reading (allowed) or
 *  messaging / private-chat / dm (permanently rejected).
 *
 *  The publishing-vs-messaging rule is the architectural commitment
 *  that makes the social-graph addon defensible: Bridge can read what
 *  contacts publish to an audience, NEVER what they privately tell
 *  another person. Messaging-surface ingredients are permanently out
 *  of scope (§ B.9.1).
 *
 *  This module ships only the closed-list classification registries
 *  + the forbidden-surface-kind set. The actual validator (with the
 *  four gates per spec § C.1.5) lives in
 *  `packages/marketplace/src/validators/bridge-surface-kind.ts`.
 *
 *  Spec: `docs/d-145-spec.md` § B.9.1 + § C.1. */

// ── PC1.1 — Forbidden surface kinds (self-declaration gate) ─────────

/** Closed list of `surface_kind` values the marketplace rejects with
 *  `surface_kind_messaging_rejected`. Bridge ingredient manifests that
 *  declare any of these values are hard-rejected at submission. The
 *  three accepted values (`'publishing'` / `'authoring'` / `'reading'`)
 *  live on `BridgeSurfaceKind` in `bridge.ts` (D-148 § A.3.1). */
export const FORBIDDEN_SURFACE_KINDS: ReadonlyArray<string> = [
  'messaging',
  'private_chat',
  'dm',
];

export const FORBIDDEN_SURFACE_KIND_SET: ReadonlySet<string> = new Set(
  FORBIDDEN_SURFACE_KINDS,
);

// ── PC1.3 — Per-platform classification (informational; reviewer aid) ─

/** Public publishing surfaces — contacts post to an audience.
 *  Approved for Bridge ingredients with `surface_kind: 'reading'` or
 *  `'publishing'`. */
export const PUBLISHING_PLATFORMS: ReadonlyArray<string> = [
  'facebook.com',
  'twitter.com',
  'x.com',
  'instagram.com',
  'linkedin.com',
  'github.com',
  'substack.com',
  'mastodon.social',
  'bsky.app',
  'medium.com',
];

/** Permanently-rejected messaging platforms. Hosts are matched
 *  case-insensitively + as host-suffix (e.g. `web.whatsapp.com`
 *  matches `whatsapp.com`). The validator's URL classifier expands
 *  this list with path patterns (§ PC1.2). */
export const MESSAGING_PLATFORMS_REJECTED: ReadonlyArray<string> = [
  'whatsapp.com',
  'web.whatsapp.com',
  'messenger.com',
  'imessage.apple.com',
  'signal.org',
  'telegram.org',
  'web.telegram.org',
];

/** Compose-side platforms — writing posts to publishing surfaces.
 *  Approved with `surface_kind: 'authoring'`. */
export const AUTHORING_PLATFORMS: ReadonlyArray<string> = [
  'twitter.com',
  'x.com',
  'facebook.com',
  'instagram.com',
  'linkedin.com',
  'github.com',
  'medium.com',
];

/** Reading-surface platforms — CRM tabs, project tools, etc.
 *  Approved with `surface_kind: 'reading'`. */
export const READING_PLATFORMS: ReadonlyArray<string> = [
  'app.hubspot.com',
  '*.lightning.force.com',
  'app.asana.com',
  'todoist.com',
  'app.linear.app',
];

// ── PC1.4 gate 1 — URL/domain classifier blocklist ──────────────────

/** Closed list of host-name + path patterns the URL classifier
 *  rejects regardless of self-declared `surface_kind`. The matcher
 *  intersects ingredient `trigger[]` URL patterns with this list and
 *  fails with `surface_kind_messaging_rejected_by_url_classifier` on
 *  any intersection.
 *
 *  Pattern syntax:
 *    - bare host like `web.whatsapp.com` matches the host literally
 *    - star in a host position matches one subdomain segment
 *    - star in a path position matches a path segment
 *    - leading `star-slash` matches across hosts (path-pattern; no host bind)
 *
 *  The list mixes hard-rejected hosts with cross-host path patterns
 *  for messaging UI (matching `slash-messages-slash-star`,
 *  `slash-dm-slash-star`, `slash-conversation-slash-star`) so
 *  Slack / Discord / LinkedIn / Facebook / Instagram messaging tabs
 *  reject regardless of which platform they ride. */
export const MESSAGING_DOMAIN_BLOCKLIST: ReadonlyArray<string> = [
  // Host blocklist — every URL hitting these is rejected outright.
  'web.whatsapp.com',
  'whatsapp.com',
  'messenger.com',
  'imessage.apple.com',
  'signal.org',
  'web.telegram.org',
  'telegram.org',
  // Cross-host path patterns — match any host with these path segments.
  '*/messages/*',
  '*/chats/*',
  '*/dm/*',
  '*/direct/*',
  '*/conversation/*',
  '*/im/*',
];

// ── PC1.4 gate 2 — Selector classifier blocklist ────────────────────

/** Closed list of DOM-selector patterns that any reading-surface
 *  ingredient should NEVER need. A manifest declaring
 *  `surface_kind: 'reading'` whose `output[]` selectors match any
 *  pattern below hard-rejects with `selector_pattern_messaging_rejected`.
 *
 *  Patterns matched as case-insensitive substring against the literal
 *  selector string (substring rather than CSS-AST so "private chat"
 *  variants in attribute selectors fail closed; the validator never
 *  parses CSS to interpret meaning). */
export const MESSAGING_SELECTOR_BLOCKLIST: ReadonlyArray<string> = [
  '[data-testid="conversation-list"]',
  "[data-testid='conversation-list']",
  '[aria-label="Direct Messages"]',
  "[aria-label='Direct Messages']",
  '[aria-label*="message"]',
  "[aria-label*='message']",
  '[data-test-id="dm-conversation"]',
  "[data-test-id='dm-conversation']",
  '[role="complementary"][aria-label*="message"]',
  "[role='complementary'][aria-label*='message']",
  '.conversation-thread',
  '.dm-thread',
  '.private-message',
];

// ── PC1.4 gate 3 — Mixed-surface domains (human-review queue) ───────

/** Closed list of platforms that host BOTH publishing AND messaging
 *  surfaces. Submissions targeting these domains pass automated gates
 *  but flag `mixed_surface_review_required: true`; reviewers must
 *  manually approve before publish. The reviewer dashboard surfaces
 *  trigger URL patterns + selector declarations + publisher
 *  justification.
 *
 *  Adding a domain to this list requires substrate-side review;
 *  closed list at launch per § C.1.4 gate 3. */
export const MIXED_SURFACE_DOMAINS: ReadonlyArray<string> = [
  'slack.com',
  'discord.com',
  'linkedin.com',
  'facebook.com',
  'instagram.com',
];

export const MIXED_SURFACE_DOMAIN_SET: ReadonlySet<string> = new Set(
  MIXED_SURFACE_DOMAINS,
);
