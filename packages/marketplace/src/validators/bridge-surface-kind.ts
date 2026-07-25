/** D-145 PC1 — Publishing-vs-messaging marketplace validator (four-gate).
 *
 *  Per § C.1.5 the marketplace runs four gates against every Bridge
 *  ingredient submission:
 *    1. `validateBridgeSurfaceKind`  — self-declaration check.
 *    2. `validateUrlClassifier`      — URL/domain blocklist.
 *    3. `validateSelectorClassifier` — DOM-selector blocklist.
 *    4. `flagMixedSurfaceDomain`     — human-review queue flag.
 *
 *  Self-declaration alone is breakable (bad-faith publisher mislabels
 *  a WhatsApp scraper as `surface_kind: 'reading'` and the gate
 *  passes). Defense-in-depth across all four gates makes the privacy
 *  invariant *"Recued bridges cannot access messaging surfaces"*
 *  structurally enforceable, not aspirational. The catalog ratchet
 *  test asserts every live ingredient passes all four gates.
 *
 *  Spec: `docs/d-145-spec.md` § C.1. */

import type { BridgeSurfaceKind } from '@recued/contracts';
import {
  BRIDGE_SURFACE_KINDS,
  FORBIDDEN_SURFACE_KIND_SET,
  MESSAGING_DOMAIN_BLOCKLIST,
  MESSAGING_SELECTOR_BLOCKLIST,
  MIXED_SURFACE_DOMAIN_SET,
} from '@recued/contracts';

// ── PC1.1 — Manifest shape (publish-time submission) ────────────────

/** Narrow shape the validator inspects. The full `IngredientManifest`
 *  carries far more fields; the four-gate validator only needs the
 *  bridge-relevant ones. Submission flow passes the full manifest;
 *  the validators destructure what they need.
 *
 *  Two trigger carriers, per CLAUDE.md § DOM Ingredient Pattern + § Recipe
 *  Trigger Field:
 *    1. `trigger: ReadonlyArray<string>` — optional top-level array; the
 *       recipe-trigger shape. Validator-direct callers may use this.
 *    2. `output[<url-pattern>]: 'trigger'` — the canonical DOM ingredient
 *       shape; the URL pattern is an `output` map key whose value is the
 *       literal string `'trigger'`. Validator extracts triggers from
 *       both carriers and unions them for gate 2 + gate 4. */
export interface BridgeSurfaceValidationManifest {
  kind: string;
  surface_kind?: string;
  trigger?: ReadonlyArray<string>;
  /** DOM ingredient `output` map: selector string → field name. The
   *  selector classifier scans selectors (the keys); we match
   *  case-insensitive substring against `MESSAGING_SELECTOR_BLOCKLIST`.
   *  Entries with value `'trigger'` carry the URL pattern in the key
   *  and are pulled into the trigger list for gates 2 + 4. */
  output?: Record<string, string>;
}

/** Materialize the trigger URL list for gates 2 + 4. Reads both the
 *  optional top-level `trigger[]` array (recipe-shape callers) AND the
 *  `output` map's entries whose value === `'trigger'` (canonical DOM
 *  ingredient shape). Returns the deduped union.
 *
 *  Exposed so external wiring layers (Edge Function inlined copy,
 *  Cloudflare Worker publish path, catalog ratchet test) share one
 *  materialization rule. Closes the publisher-bypass where a manifest
 *  hides a blocked URL in `output[<url>] = 'trigger'` while leaving the
 *  top-level `trigger` field absent. */
export const extractIngredientTriggers = (
  manifest: BridgeSurfaceValidationManifest,
): ReadonlyArray<string> => {
  const fromTop: ReadonlyArray<string> = Array.isArray(manifest.trigger)
    ? manifest.trigger.filter((s): s is string => typeof s === 'string')
    : [];
  const fromOutput: string[] = [];
  if (manifest.output && typeof manifest.output === 'object') {
    for (const [k, v] of Object.entries(manifest.output)) {
      if (v === 'trigger' && typeof k === 'string') fromOutput.push(k);
    }
  }
  return Array.from(new Set([...fromTop, ...fromOutput]));
};

// ── PC1.1 — Validation result envelope ──────────────────────────────

export type BridgeSurfaceValidationErrorCode =
  | 'surface_kind_messaging_rejected'
  | 'surface_kind_invalid'
  | 'surface_kind_missing'
  | 'surface_kind_messaging_rejected_by_url_classifier'
  | 'selector_pattern_messaging_rejected';

export const BRIDGE_SURFACE_VALIDATION_ERROR_CODES: ReadonlyArray<BridgeSurfaceValidationErrorCode> = [
  'surface_kind_messaging_rejected',
  'surface_kind_invalid',
  'surface_kind_missing',
  'surface_kind_messaging_rejected_by_url_classifier',
  'selector_pattern_messaging_rejected',
];

export type BridgeSurfaceValidationResult =
  | { ok: true }
  | {
      ok: false;
      error: BridgeSurfaceValidationErrorCode;
      detail: string;
      /** When the rejection was triggered by a specific pattern (URL
       *  trigger string / selector substring), the validator echoes
       *  the trigger so the publisher dashboard can highlight the
       *  offending row in the manifest. The validator MUST NOT echo
       *  any user content — only the manifest's own declared
       *  patterns. */
      trigger?: string;
    };

// ── PC1.2 gate 1 — Self-declaration ─────────────────────────────────

/** Gate 1 — check the manifest's self-declared `surface_kind` against
 *  `FORBIDDEN_SURFACE_KIND_SET` first, then the closed list of
 *  allowed values (`publishing` / `authoring` / `reading` per
 *  `BRIDGE_SURFACE_KINDS`). Pure — never reads external state. */
export const validateBridgeSurfaceKind = (
  manifest: BridgeSurfaceValidationManifest,
): BridgeSurfaceValidationResult => {
  const sk = manifest.surface_kind;

  if (sk === undefined || sk === null || sk === '') {
    return {
      ok: false,
      error: 'surface_kind_missing',
      detail:
        'Bridge ingredients (kind: \'dom\') must declare surface_kind. See docs/d-145-spec.md § C.1.1.',
    };
  }

  if (FORBIDDEN_SURFACE_KIND_SET.has(sk)) {
    return {
      ok: false,
      error: 'surface_kind_messaging_rejected',
      detail: `surface_kind '${sk}' is permanently rejected for Bridge ingredients per D-145 publishing-vs-messaging rule. Recued bridges cannot access messaging surfaces. See docs/d-145-spec.md § B.9.1.`,
    };
  }

  if (!(BRIDGE_SURFACE_KINDS as ReadonlyArray<string>).includes(sk)) {
    return {
      ok: false,
      error: 'surface_kind_invalid',
      detail: `surface_kind must be one of 'publishing' | 'authoring' | 'reading'. Got '${sk}'.`,
    };
  }

  return { ok: true };
};

// ── PC1.4 gate 2 — URL/domain classifier ────────────────────────────

interface UrlPatternParts {
  scheme: string;
  host: string;
  path: string;
}

const parsePattern = (raw: string): UrlPatternParts | null => {
  // Accept `<scheme>://<host>/<path>` and bare `<host>/<path>`. Bare
  // host shorthand (`web.whatsapp.com/*`) is supported because that's
  // what manifests use in practice (per existing ingredients in
  // `community/ingredients/`). Hosts lowercased so case-varied patterns
  // (`HTTPS://WEB.WHATSAPP.COM/*`, `Facebook.com/*`) cannot bypass the
  // messaging-domain or mixed-surface gates — URL hosts are
  // case-insensitive per RFC 3986 § 3.2.2.
  const withScheme = raw.match(/^([\w*]+):\/\/([^/]+)(\/.*)?$/);
  if (withScheme) {
    return {
      scheme: withScheme[1] ?? '*',
      host: (withScheme[2] ?? '').toLowerCase(),
      path: withScheme[3] ?? '/',
    };
  }
  const bare = raw.match(/^([^/]+)(\/.*)?$/);
  if (bare) {
    return {
      scheme: '*',
      host: (bare[1] ?? '').toLowerCase(),
      path: bare[2] ?? '/',
    };
  }
  return null;
};

const hostMatches = (
  triggerHost: string,
  blockHost: string,
): boolean => {
  // Wildcard host shorthand: `*` matches any host; `*.example.com`
  // matches any subdomain. Exact match always wins.
  if (blockHost === '*') return true;
  if (triggerHost === blockHost) return true;
  if (blockHost.startsWith('*.')) {
    const rest = blockHost.slice(2);
    return triggerHost === rest || triggerHost.endsWith('.' + rest);
  }
  // Suffix match for "host" forms — `web.whatsapp.com` matches
  // `whatsapp.com` (the blocklist enumerates both directions for
  // robustness; suffix match makes future telegram subdomain hits
  // catch even when only the bare host is in the list).
  if (triggerHost.endsWith('.' + blockHost)) return true;
  return false;
};

const pathMatches = (triggerPath: string, blockPath: string): boolean => {
  // `/*` matches anything; `/foo/*` matches `/foo/bar`.
  if (blockPath === '/*' || blockPath === '/' || blockPath === '') return true;
  if (triggerPath === blockPath) return true;
  if (blockPath.endsWith('/*')) {
    const prefix = blockPath.slice(0, -2);
    return triggerPath === prefix || triggerPath.startsWith(prefix + '/');
  }
  // Fallback: substring match — handles cross-host path patterns
  // like `*/messages/*` where the host classifier already passed
  // and we're left to check whether the path contains `/messages/`.
  return triggerPath.includes(blockPath.replace(/\*/g, ''));
};

const triggerIntersectsBlocklist = (trigger: string): string | null => {
  const t = parsePattern(trigger);
  if (!t) return null;
  for (const block of MESSAGING_DOMAIN_BLOCKLIST) {
    // Cross-host path patterns (`*/messages/*`): match across hosts.
    if (block.startsWith('*/')) {
      const blockPath = block.slice(1);
      if (pathMatches(t.path, blockPath)) return block;
      continue;
    }
    const b = parsePattern(block);
    if (!b) continue;
    if (hostMatches(t.host, b.host)) return block;
  }
  return null;
};

/** Gate 2 — URL/domain classifier. Hard-rejects any trigger pattern
 *  that intersects `MESSAGING_DOMAIN_BLOCKLIST`. Pure — never reads
 *  external state. Matches even when self-declaration claims
 *  `surface_kind: 'reading'`. Materializes triggers from both the
 *  top-level `trigger[]` field AND the `output[<url>] = 'trigger'`
 *  canonical-DOM shape so a manifest can't hide a blocked URL in one
 *  carrier while keeping the other empty. */
export const validateUrlClassifier = (
  manifest: BridgeSurfaceValidationManifest,
): BridgeSurfaceValidationResult => {
  const triggers = extractIngredientTriggers(manifest);
  for (const trigger of triggers) {
    const matched = triggerIntersectsBlocklist(trigger);
    if (matched !== null) {
      return {
        ok: false,
        error: 'surface_kind_messaging_rejected_by_url_classifier',
        detail: `trigger pattern '${trigger}' intersects messaging-domain blocklist entry '${matched}' — bridge ingredients cannot access messaging surfaces. See docs/d-145-spec.md § C.1.4 gate 1.`,
        trigger,
      };
    }
  }
  return { ok: true };
};

// ── PC1.4 gate 3 — Selector classifier ──────────────────────────────

/** Gate 3 — DOM-selector classifier. Hard-rejects any selector key
 *  in the manifest's `output` map that contains a substring from
 *  `MESSAGING_SELECTOR_BLOCKLIST`. Substring match (case-insensitive)
 *  rather than CSS-AST parsing — the substrate prefers fail-closed
 *  on near-matches over false-negative parse failures. */
export const validateSelectorClassifier = (
  manifest: BridgeSurfaceValidationManifest,
): BridgeSurfaceValidationResult => {
  const output = manifest.output ?? {};
  for (const selector of Object.keys(output)) {
    const lower = selector.toLowerCase();
    for (const block of MESSAGING_SELECTOR_BLOCKLIST) {
      if (lower.includes(block.toLowerCase())) {
        return {
          ok: false,
          error: 'selector_pattern_messaging_rejected',
          detail: `output selector '${selector}' matches messaging-selector blocklist entry '${block}'. Reading-surface ingredients should not need DM-conversation selectors. See docs/d-145-spec.md § C.1.4 gate 2.`,
          trigger: selector,
        };
      }
    }
  }
  return { ok: true };
};

// ── PC1.4 gate 4 — Mixed-surface domain flag ────────────────────────

export interface MixedSurfaceFlag {
  mixed_surface_review_required: boolean;
  /** When `true`, the host(s) that triggered the flag. Reviewer
   *  dashboard renders these so the manual reviewer can scope their
   *  inspection. */
  matched_domains: ReadonlyArray<string>;
}

/** Gate 4 — Mixed-surface domain flag. Submissions targeting domains
 *  in `MIXED_SURFACE_DOMAIN_SET` (Slack / Discord / LinkedIn /
 *  Facebook / Instagram) pass the automated gates but flag
 *  `mixed_surface_review_required: true` so a human reviewer must
 *  confirm the manifest targets the publishing surface (channel /
 *  feed) and not the messaging surface (DM / private chat).
 *
 *  The function is non-rejecting — returns the flag for the
 *  marketplace's submission flow to consume. */
export const flagMixedSurfaceDomain = (
  manifest: BridgeSurfaceValidationManifest,
): MixedSurfaceFlag => {
  const triggers = extractIngredientTriggers(manifest);
  const matched: string[] = [];
  for (const trigger of triggers) {
    const t = parsePattern(trigger);
    if (!t) continue;
    for (const mixed of MIXED_SURFACE_DOMAIN_SET) {
      if (hostMatches(t.host, mixed)) {
        matched.push(mixed);
      }
    }
  }
  // Dedup matched domains for a stable reviewer-dashboard render.
  const dedup = Array.from(new Set(matched));
  return {
    mixed_surface_review_required: dedup.length > 0,
    matched_domains: dedup,
  };
};

// ── PC1.5 — Composite four-gate runner ──────────────────────────────

export interface FourGateValidationResult {
  ok: boolean;
  /** Each gate's individual result; the composite `ok` is
   *  `gates.every(g => g.ok)` AND `mixed_surface_flag` either
   *  unset OR carrying `human_reviewed: true` in the metadata
   *  (callers responsible for the review-flag check). */
  gate_self_declaration: BridgeSurfaceValidationResult;
  gate_url_classifier: BridgeSurfaceValidationResult;
  gate_selector_classifier: BridgeSurfaceValidationResult;
  mixed_surface_flag: MixedSurfaceFlag;
}

/** Run all four gates against the manifest. Caller decides how to
 *  treat the mixed-surface flag (submission flow queues for human
 *  review when `mixed_surface_review_required: true`). */
export const runFourGateValidation = (
  manifest: BridgeSurfaceValidationManifest,
): FourGateValidationResult => {
  const gate_self_declaration = validateBridgeSurfaceKind(manifest);
  const gate_url_classifier = validateUrlClassifier(manifest);
  const gate_selector_classifier = validateSelectorClassifier(manifest);
  const mixed_surface_flag = flagMixedSurfaceDomain(manifest);
  const ok =
    gate_self_declaration.ok &&
    gate_url_classifier.ok &&
    gate_selector_classifier.ok;
  return {
    ok,
    gate_self_declaration,
    gate_url_classifier,
    gate_selector_classifier,
    mixed_surface_flag,
  };
};

// Re-export the type so consumers don't have to dual-import.
export type { BridgeSurfaceKind };
