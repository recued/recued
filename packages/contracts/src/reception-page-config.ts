/** D-149 P4 § A.5.1 — `reception_page` singleton config contract.
 *
 *  The reception_page kind is the one Reception surface that has no
 *  per-link token and no per-link registry row — it is a server-wide
 *  singleton at `/reception/` (one per server per spec § A.5.1: "Not a
 *  per-link substrate — there is exactly one `reception_page` row in
 *  the registry per server").
 *
 *  Storage: the singleton config lives in the `metadata_blob` of a
 *  reserved registry row keyed on
 *  `RECEPTION_PAGE_SINGLETON_ENDPOINT_ID`. The reception listener
 *  special-cases the bare `/reception/` path: no token extract, no
 *  token verify, no post-verify daily cap (uncapped per
 *  RECEPTION_RATE_LIMIT_DEFAULTS). The pre-verify per-IP rate limit
 *  still applies (60 req / 60s default per § Contract Tightening
 *  rate-limit table). Page exists ALWAYS — a fresh server with no
 *  upserted config renders the substrate-defined placeholder so the
 *  surface is structurally non-fingerprinting per § Must Hold I-1
 *  default-off baseline.
 *
 *  Validators in this file:
 *
 *    - Length bounds on user-typed text fields (display_name / tagline
 *      / response_time_estimate / custom_link.label). Bounds picked to
 *      keep the rendered HTML compact + bound the no-leak surface.
 *    - URL scheme allowlist on avatar_url + custom_link.url. Only
 *      `http:` / `https:` absolute URLs OR relative paths under the
 *      reserved `/reception/_static/` prefix. Rejects `javascript:` /
 *      `data:` / `file:` / `ftp:` / `vbscript:` per TR-8 custom-link
 *      XSS mitigation.
 *    - Closed-list enforcement on preferred_contact_methods (already
 *      gated at the redacted-packet validator at substrate boundary;
 *      validated here too so the rpc layer rejects upstream).
 *    - Section toggle closed shape — defense in depth against caller-
 *      supplied extra keys at the rpc edge.
 *
 *  Spec: D-149 § A.5.1 + § Must Hold I-1 + § A.11 (TR-8). */

import {
  RECEPTION_PAGE_PREFERRED_CONTACT_METHOD_SET,
  type ReceptionPageLinkedEndpoints,
  type ReceptionPagePreferredContactMethod,
  type ReceptionPageSectionConfig,
} from './redacted-packets.js';
import {
  validateReceptionLinkButton,
  type ReceptionLinkButton,
} from './reception-link-button.js';

// ────────────────────────────────────────────────────────────────
// Singleton constants
// ────────────────────────────────────────────────────────────────

/** D-149 § A.5.1 — the stable endpoint_id of the singleton row in
 *  `public_endpoint_registry` whose `kind = 'reception_page'`. The
 *  literal is wrapped in double-underscores so a normal `generateEndpointId()`
 *  (UUIDv4 hex) can never collide; the substrate creates the row on
 *  first upsert + reuses it across every subsequent update. */
export const RECEPTION_PAGE_SINGLETON_ENDPOINT_ID = '__reception_page__' as const;

/** D-149 § A.5.1 — `/reception/_static/<asset>` URL prefix. Reception
 *  static assets are bundled with the server binary + served via this
 *  reserved subtree; user-uploaded avatars live under
 *  `/reception/_static/avatar/<sha256-prefix>` once the user-profile
 *  substrate ships the upload path. P4 hard-codes the prefix here so
 *  validators + the handler share a single source of truth. */
export const RECEPTION_PAGE_STATIC_PATH_PREFIX = '/reception/_static/' as const;

// ────────────────────────────────────────────────────────────────
// Field bounds
// ────────────────────────────────────────────────────────────────

export const RECEPTION_PAGE_DISPLAY_NAME_MAX = 100;
export const RECEPTION_PAGE_TAGLINE_MAX = 200;
export const RECEPTION_PAGE_RESPONSE_TIME_ESTIMATE_MAX = 100;
export const RECEPTION_PAGE_TZ_LABEL_MAX = 64;
export const RECEPTION_PAGE_CUSTOM_LINK_LABEL_MAX = 60;
export const RECEPTION_PAGE_CUSTOM_LINKS_MAX = 6;
/** D-196 S3 — first-host cardinality for the reusable link-button element. */
export const RECEPTION_PAGE_LINK_BUTTONS_MAX = 6;
export const RECEPTION_PAGE_AVATAR_URL_MAX = 512;

/** URL schemes permitted on `avatar_url` + `custom_links[].url`.
 *  Closed list excludes `javascript:` / `data:` / `file:` / `ftp:` /
 *  `vbscript:` per TR-8 (custom-link XSS). The validator also accepts
 *  relative paths under `RECEPTION_PAGE_STATIC_PATH_PREFIX` for
 *  substrate-served avatar uploads. */
export const RECEPTION_PAGE_URL_SCHEMES_ALLOWED: ReadonlyArray<string> = [
  'http:',
  'https:',
] as const;

export const RECEPTION_PAGE_URL_SCHEME_SET: ReadonlySet<string> = new Set(
  RECEPTION_PAGE_URL_SCHEMES_ALLOWED,
);

// ────────────────────────────────────────────────────────────────
// Config shape
// ────────────────────────────────────────────────────────────────

/** Display-profile overrides — the visitor-facing identity block.
 *  Fallback chain: `display_overrides.<field>` ?? server profile
 *  default ?? substrate placeholder. P4 wires the substrate placeholder
 *  path (the per-user-profile fallback lands when the profile substrate
 *  is wired downstream). */
export interface ReceptionPageDisplayOverrides {
  readonly display_name: string;
  readonly tagline: string;
  readonly tz_label: string;
  readonly preferred_contact_methods: ReadonlyArray<ReceptionPagePreferredContactMethod>;
  readonly avatar_url?: string;
  readonly response_time_estimate?: string;
}

/** Per-link CTA on the reception_page. Mary captures these from the
 *  scheduling_link / intake_form / drop_link create rpc's
 *  `share_url_once` then pastes them into the reception_page config.
 *  CTA buttons in the rendered packet derive their `href` directly
 *  from these stored share URLs — the substrate never re-mints a
 *  bearer secret to drive a CTA. */
export interface ReceptionPageCustomLink {
  readonly label: string;
  readonly url: string;
}

/** Singleton-config blob persisted in the registry row's `metadata_blob`.
 *  Read at every page render; write only via `reception.page.upsert`. */
export interface ReceptionPageConfig {
  readonly display_overrides: ReceptionPageDisplayOverrides;
  readonly sections_enabled: ReceptionPageSectionConfig;
  readonly linked_endpoints: ReceptionPageLinkedEndpoints;
  readonly custom_links?: ReadonlyArray<ReceptionPageCustomLink>;
  /** D-196 S3 — HTTPS-only navigation elements. Separate from the legacy
   * `custom_links` field so already-stored HTTP/static links remain valid. */
  readonly link_buttons?: ReadonlyArray<ReceptionLinkButton>;
  /** D-149 P12 § A.20.7 — Public Trust Footer on/off toggle. The footer
   *  text body is substrate-fixed (`buildTrustFooter` in
   *  `reception-visitor-ux.ts`) — the user toggles visibility only.
   *  Absent ⇒ default-on (§ A.20.7: "default-on; user can disable per
   *  Settings"); the renderer / receipt builder treats `undefined` and
   *  `true` identically. */
  readonly trust_footer_enabled?: boolean;
  /** D-210 Phase C — how a newly-held reception item reaches the owner's
   *  DEVICES. `'approval'` (the default) raises the durable
   *  `gateway.preflight` ask, so every surface renders an actionable
   *  approve/deny card; `'notify'` fires a passive fire-and-forget FYI
   *  instead. One surface per item, never both.
   *
   *  ⚠ THIS IS A FANOUT CHOICE, NOT A GATE — and it does not decide WHERE
   *  the item lives.
   *
   *  THE WEBCLIENT INBOX ALWAYS HOLDS THE ITEM AND OWNS ITS LIFECYCLE,
   *  in either mode. It is the manual fallback and the authoritative
   *  review surface: it reads the audit anchors directly, so it lists a
   *  held item whether or not an ask was ever raised, and it drives the
   *  resume itself (`reception-inbox-no-ask-release.ts`). What this
   *  setting picks is only which DEVICE surface pings — an actionable
   *  quick-access card you can answer from the notification, or a passive
   *  heads-up that says "go look".
   *
   *  That is why `'notify'` is not a weaker gate. Both modes hold at the
   *  D-157 gate (inbox model "B" — nothing a visitor submits reaches the
   *  owner's world without approval), and `'notify'` auto-accepts
   *  nothing. The ask, when raised, is convenience that happens to share
   *  the approval code path; it is not the thing that holds.
   *
   *  Strictly GLOBAL by owner ruling — it lives on the `reception_page`
   *  singleton because there is exactly one owner and one inbox, not
   *  because it describes the public page. Absent ⇒ `'approval'`; the
   *  raise sites treat `undefined` and `'approval'` identically. */
  readonly inbox_fanout_mode?: ReceptionInboxFanoutMode;
}

/** D-210 Phase C — the two device-fanout surfaces for a newly-held item.
 *  Derived from one const so a copy cannot rot into a subset
 *  ([[feedback_a_subset_typechecks_so_derive_the_closed_list]]). */
export const RECEPTION_INBOX_FANOUT_MODES = ['notify', 'approval'] as const;

export type ReceptionInboxFanoutMode = (typeof RECEPTION_INBOX_FANOUT_MODES)[number];

/** The fanout mode a config resolves to. The ONE place `undefined` is
 *  collapsed to the default — every raise site reads through this so a
 *  missing config, a missing field, and an explicit `'approval'` cannot
 *  drift apart. Fail-safe direction: anything unrecognized reads as
 *  `'approval'` (an actionable card is the recoverable failure; a
 *  silently-passive hold is not). */
export const resolveReceptionInboxFanoutMode = (
  mode: string | undefined,
): ReceptionInboxFanoutMode => (mode === 'notify' ? 'notify' : 'approval');

// ────────────────────────────────────────────────────────────────
// Validator
// ────────────────────────────────────────────────────────────────

export type ReceptionPageConfigValidationCode =
  | 'display_name_empty'
  | 'display_name_too_long'
  | 'tagline_too_long'
  | 'tz_label_empty'
  | 'tz_label_too_long'
  | 'response_time_estimate_too_long'
  | 'avatar_url_too_long'
  | 'avatar_url_invalid'
  | 'preferred_contact_method_unknown'
  | 'sections_enabled_unknown_key'
  | 'linked_endpoints_unknown_key'
  | 'custom_link_url_invalid'
  | 'custom_link_label_empty'
  | 'custom_link_label_too_long'
  | 'custom_links_count_exceeded'
  | 'link_button_invalid'
  | 'link_buttons_count_exceeded'
  // D-149 P12 § A.20.7 — Public Trust Footer toggle type-gate.
  | 'trust_footer_enabled_invalid'
  // D-210 Phase C — inbox device-fanout mode type-gate.
  | 'inbox_fanout_mode_invalid';

export interface ReceptionPageConfigValidationFailure {
  readonly code: ReceptionPageConfigValidationCode;
  readonly detail: string;
}

const SECTION_KEYS: ReadonlySet<keyof ReceptionPageSectionConfig> = new Set([
  'contact_card',
  'contact_methods',
  'availability_cta',
  'intake_cta',
  'drop_cta',
  'custom_links',
  'link_buttons',
]);

const LINKED_ENDPOINT_KEYS: ReadonlySet<keyof ReceptionPageLinkedEndpoints> = new Set([
  'scheduling_link_endpoint_id',
  'intake_form_endpoint_id',
  'drop_link_endpoint_id',
  // D-149 P4 Codex review fold (2026-05-13) — share-URL fields.
  'scheduling_link_share_url',
  'intake_form_share_url',
  'drop_link_share_url',
]);

const LINKED_ENDPOINT_SHARE_URL_KEYS: ReadonlySet<keyof ReceptionPageLinkedEndpoints> =
  new Set(['scheduling_link_share_url', 'intake_form_share_url', 'drop_link_share_url']);

/** Pure URL validator. Returns true iff `raw` is a non-empty string
 *  AND parses as either:
 *    - a relative path beginning with `RECEPTION_PAGE_STATIC_PATH_PREFIX`
 *      AND contains no `..` segments (path-traversal defense), OR
 *    - an absolute URL whose scheme ∈ RECEPTION_PAGE_URL_SCHEMES_ALLOWED.
 *
 *  Any other shape (bare `javascript:` / `data:` URI / mailto / file
 *  scheme / scheme-relative `//x` / malformed) returns false. */
export const isReceptionPageUrlAllowed = (raw: unknown): raw is string => {
  if (typeof raw !== 'string' || raw.length === 0) return false;
  if (raw.length > RECEPTION_PAGE_AVATAR_URL_MAX) return false;
  if (raw.startsWith(RECEPTION_PAGE_STATIC_PATH_PREFIX)) {
    // Path-traversal defense — reject any `..` segment in the relative
    // path. The handler's static-asset dispatcher applies the same
    // check; validating at config-store time keeps poisoned values
    // out of the row in the first place.
    if (raw.includes('..')) return false;
    return true;
  }
  // Absolute URL parse — `new URL` rejects malformed strings + lets us
  // gate on the scheme via the closed-list set.
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return RECEPTION_PAGE_URL_SCHEME_SET.has(u.protocol);
};

/** Validate a `ReceptionPageConfig` shape. Returns the list of
 *  failures; empty array ⇒ valid. Pure function — no I/O. */
export const validateReceptionPageConfig = (
  config: ReceptionPageConfig,
): ReadonlyArray<ReceptionPageConfigValidationFailure> => {
  const failures: ReceptionPageConfigValidationFailure[] = [];
  const d = config.display_overrides;

  if (typeof d.display_name !== 'string' || d.display_name.trim().length === 0) {
    failures.push({ code: 'display_name_empty', detail: 'display_name must be non-empty' });
  } else if (d.display_name.length > RECEPTION_PAGE_DISPLAY_NAME_MAX) {
    failures.push({
      code: 'display_name_too_long',
      detail: `display_name must be ≤ ${RECEPTION_PAGE_DISPLAY_NAME_MAX} characters`,
    });
  }
  if (typeof d.tagline !== 'string') {
    failures.push({ code: 'tagline_too_long', detail: 'tagline must be a string' });
  } else if (d.tagline.length > RECEPTION_PAGE_TAGLINE_MAX) {
    failures.push({
      code: 'tagline_too_long',
      detail: `tagline must be ≤ ${RECEPTION_PAGE_TAGLINE_MAX} characters`,
    });
  }
  // Codex review P2 fold (2026-05-13 P4) — type-gate `response_time_estimate`
  // BEFORE length-gate. Pre-fold, a non-string value (number / object /
  // array) skipped the length check, was stored verbatim, and broke the
  // next `/reception/` render at the substrate validator boundary
  // (`buildReceptionPacket` rejects non-string fields). Reject any
  // defined non-string here so the malformed config never reaches the
  // store.
  if (
    d.response_time_estimate !== undefined &&
    typeof d.response_time_estimate !== 'string'
  ) {
    failures.push({
      code: 'response_time_estimate_too_long',
      detail: 'response_time_estimate must be a string when present',
    });
  }
  // Type-gate avatar_url BEFORE the URL-allowlist check. Pre-fold the
  // URL allowlist returned false for non-string input, mapping to
  // `avatar_url_invalid` — adequate, but the dedicated type-gate makes
  // the failure mode explicit (parallels response_time_estimate).
  if (d.avatar_url !== undefined && typeof d.avatar_url !== 'string') {
    failures.push({
      code: 'avatar_url_invalid',
      detail: 'avatar_url must be a string when present',
    });
  }
  if (typeof d.tz_label !== 'string' || d.tz_label.trim().length === 0) {
    failures.push({ code: 'tz_label_empty', detail: 'tz_label must be non-empty' });
  } else if (d.tz_label.length > RECEPTION_PAGE_TZ_LABEL_MAX) {
    failures.push({
      code: 'tz_label_too_long',
      detail: `tz_label must be ≤ ${RECEPTION_PAGE_TZ_LABEL_MAX} characters`,
    });
  }
  if (
    d.response_time_estimate !== undefined &&
    typeof d.response_time_estimate === 'string' &&
    d.response_time_estimate.length > RECEPTION_PAGE_RESPONSE_TIME_ESTIMATE_MAX
  ) {
    failures.push({
      code: 'response_time_estimate_too_long',
      detail: `response_time_estimate must be ≤ ${RECEPTION_PAGE_RESPONSE_TIME_ESTIMATE_MAX} characters`,
    });
  }
  if (d.avatar_url !== undefined) {
    if (typeof d.avatar_url === 'string' && d.avatar_url.length > RECEPTION_PAGE_AVATAR_URL_MAX) {
      failures.push({
        code: 'avatar_url_too_long',
        detail: `avatar_url must be ≤ ${RECEPTION_PAGE_AVATAR_URL_MAX} characters`,
      });
    } else if (!isReceptionPageUrlAllowed(d.avatar_url)) {
      failures.push({
        code: 'avatar_url_invalid',
        detail: `avatar_url must be http(s) or under ${RECEPTION_PAGE_STATIC_PATH_PREFIX}`,
      });
    }
  }
  if (!Array.isArray(d.preferred_contact_methods)) {
    failures.push({
      code: 'preferred_contact_method_unknown',
      detail: 'preferred_contact_methods must be an array',
    });
  } else {
    for (const m of d.preferred_contact_methods) {
      if (!RECEPTION_PAGE_PREFERRED_CONTACT_METHOD_SET.has(m)) {
        failures.push({
          code: 'preferred_contact_method_unknown',
          detail: `preferred_contact_method '${String(m)}' is not in the closed list`,
        });
      }
    }
  }

  // Defense-in-depth: caller-supplied extra keys at the rpc edge get
  // surfaced as validation failures rather than silently dropped, so
  // a future contract drift doesn't introduce a hidden surface.
  for (const [key, value] of Object.entries(config.sections_enabled)) {
    if (!SECTION_KEYS.has(key as keyof ReceptionPageSectionConfig)) {
      failures.push({
        code: 'sections_enabled_unknown_key',
        detail: `sections_enabled.${key} is not in the closed list`,
      });
      continue;
    }
    // Codex review P2 fold (2026-05-13 P4) — type-gate each section
    // toggle value. Pre-fold, a caller could pass
    // `sections_enabled.availability_cta: "true"` and the malformed
    // config persisted; the next `/reception/` render then crashed at
    // the substrate validator's `isSectionConfig` boolean check.
    // Surface the failure at upsert time so the store never accepts
    // the bad shape.
    if (value !== undefined && typeof value !== 'boolean') {
      failures.push({
        code: 'sections_enabled_unknown_key',
        detail: `sections_enabled.${key} must be boolean when present`,
      });
    }
  }
  for (const [key, value] of Object.entries(config.linked_endpoints)) {
    if (!LINKED_ENDPOINT_KEYS.has(key as keyof ReceptionPageLinkedEndpoints)) {
      failures.push({
        code: 'linked_endpoints_unknown_key',
        detail: `linked_endpoints.${key} is not in the closed list`,
      });
      continue;
    }
    if (value !== undefined && typeof value !== 'string') {
      failures.push({
        code: 'linked_endpoints_unknown_key',
        detail: `linked_endpoints.${key} must be a string when present`,
      });
      continue;
    }
    // D-149 P4 Codex review fold (2026-05-13) — share_url fields go
    // through the same URL allowlist as `avatar_url` + `custom_links[].url`.
    // The endpoint_id fields aren't URLs (just substrate ids); the
    // share_url fields are full visitor-facing URLs that the renderer
    // emits in a CTA's `<a href="…">`. Reject javascript: / data: /
    // etc. here so the renderer never has to second-guess the source.
    if (
      LINKED_ENDPOINT_SHARE_URL_KEYS.has(key as keyof ReceptionPageLinkedEndpoints) &&
      value !== undefined &&
      !isReceptionPageUrlAllowed(value)
    ) {
      failures.push({
        code: 'custom_link_url_invalid',
        detail: `linked_endpoints.${key} must be http(s) or under ${RECEPTION_PAGE_STATIC_PATH_PREFIX}`,
      });
    }
  }

  // D-149 P12 § A.20.7 — trust_footer_enabled is an optional boolean
  // toggle (absent ⇒ default-on). Type-gate it at the rpc edge so a
  // malformed value never reaches the store + the renderer / receipt
  // builder can treat undefined and true identically.
  if (
    config.trust_footer_enabled !== undefined &&
    typeof config.trust_footer_enabled !== 'boolean'
  ) {
    failures.push({
      code: 'trust_footer_enabled_invalid',
      detail: 'trust_footer_enabled must be a boolean when present',
    });
  }

  // D-210 Phase C — inbox_fanout_mode is an optional closed-vocabulary
  // string (absent ⇒ 'approval'). Type-gate it at the rpc edge: an
  // unrecognized value must be REFUSED here rather than silently read as
  // the default downstream, or a typo'd write would look accepted while
  // the owner's devices kept behaving the old way.
  if (
    config.inbox_fanout_mode !== undefined &&
    !(RECEPTION_INBOX_FANOUT_MODES as readonly string[]).includes(
      config.inbox_fanout_mode as string,
    )
  ) {
    failures.push({
      code: 'inbox_fanout_mode_invalid',
      detail:
        `inbox_fanout_mode must be one of ${RECEPTION_INBOX_FANOUT_MODES.join(' | ')} when present`,
    });
  }

  if (config.custom_links !== undefined) {
    if (!Array.isArray(config.custom_links)) {
      failures.push({
        code: 'custom_link_url_invalid',
        detail: 'custom_links must be an array',
      });
    } else {
      if (config.custom_links.length > RECEPTION_PAGE_CUSTOM_LINKS_MAX) {
        failures.push({
          code: 'custom_links_count_exceeded',
          detail: `custom_links length ${config.custom_links.length} exceeds max ${RECEPTION_PAGE_CUSTOM_LINKS_MAX}`,
        });
      }
      for (const link of config.custom_links) {
        if (
          typeof link !== 'object' ||
          link === null ||
          typeof link.label !== 'string' ||
          link.label.trim().length === 0
        ) {
          failures.push({
            code: 'custom_link_label_empty',
            detail: 'custom_link.label must be non-empty',
          });
          continue;
        }
        if (link.label.length > RECEPTION_PAGE_CUSTOM_LINK_LABEL_MAX) {
          failures.push({
            code: 'custom_link_label_too_long',
            detail: `custom_link.label must be ≤ ${RECEPTION_PAGE_CUSTOM_LINK_LABEL_MAX} characters`,
          });
        }
        if (!isReceptionPageUrlAllowed(link.url)) {
          failures.push({
            code: 'custom_link_url_invalid',
            detail: `custom_link.url must be http(s) or under ${RECEPTION_PAGE_STATIC_PATH_PREFIX}`,
          });
        }
      }
    }
  }

  if (config.link_buttons !== undefined) {
    if (!Array.isArray(config.link_buttons)) {
      failures.push({
        code: 'link_button_invalid',
        detail: 'link_buttons must be an array',
      });
    } else {
      if (config.link_buttons.length > RECEPTION_PAGE_LINK_BUTTONS_MAX) {
        failures.push({
          code: 'link_buttons_count_exceeded',
          detail: `link_buttons length ${config.link_buttons.length} exceeds max ${RECEPTION_PAGE_LINK_BUTTONS_MAX}`,
        });
      }
      for (const linkButton of config.link_buttons) {
        for (const linkFailure of validateReceptionLinkButton(linkButton)) {
          failures.push({ code: 'link_button_invalid', detail: linkFailure.detail });
        }
      }
    }
  }

  return failures;
};

// ────────────────────────────────────────────────────────────────
// Rpc input/output shapes
// ────────────────────────────────────────────────────────────────

export interface ReceptionPageGetResult {
  /** The stored singleton config, or `null` if the row has never been
   *  upserted (fresh-install state). The handler renders the
   *  substrate-defined placeholder in the `null` case. */
  readonly config: ReceptionPageConfig | null;
  /** Unix-ms timestamp of the last upsert; `null` when fresh. */
  readonly last_updated_at: number | null;
}

export interface ReceptionPageUpsertInput {
  readonly config: ReceptionPageConfig;
}

export interface ReceptionPageUpsertResult {
  readonly ok: true;
  readonly created: boolean;
  readonly last_updated_at: number;
}

// ────────────────────────────────────────────────────────────────
// Default-empty placeholder
// ────────────────────────────────────────────────────────────────

/** Substrate-defined placeholder body for the fresh-install state.
 *  Surfaces a "not yet configured" copy ONLY — no display_name, no
 *  tagline, no contact methods, no CTAs. Visitors see the same string
 *  on every fresh server (§ Must Hold I-1: no fingerprinting between
 *  configured + unconfigured surfaces). */
export const RECEPTION_PAGE_PLACEHOLDER_TEXT =
  "This server's Reception is not yet configured." as const;
