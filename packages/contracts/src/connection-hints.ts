/** D-223 — connection hints: values a publisher may suggest, schema they may not.
 *
 *  A pack from ANY publisher may pre-fill fields of the generic connection form.
 *  A hint sets a VALUE; it never sets SCHEMA (`hidden` / `readonly` / `showWhen`),
 *  which is what decides whether an owner can see and edit a field. A hinted value
 *  therefore lands on a visible, editable control the owner reads and can correct
 *  — that is the whole safety argument, and it is one an owner can check without
 *  reading the decision.
 *
 *  ⛔ NOT `connection_requirements` (D-194), which stays reserved. Four of its
 *  five cells carry authority rather than a hint: `api_base` is the row-match key
 *  `findEndpointCandidates` uses to propose adopting the owner's EXISTING
 *  connections; `vendor` selects a registered vendor schema (and so reaches the
 *  hidden/readonly fields) and lights the file-source leaf; `authority` drives the
 *  OAuth consent dance; `identity_endpoint` produces the auto-dedup key. A hint
 *  carrying any of them is refused rather than ignored. D-223 § 1 / § 7.1.
 *
 *  ⚠ The admission filter below MOVED HERE from
 *  `ui-shared/connections/setup-guide.ts`, which now re-exports it. It is
 *  deliberately ONE implementation: the setup guide already applies it to values
 *  from a source with no accountable author at all (inference), so routing a
 *  published pack — which has a publisher handle and a review path — through the
 *  same gate is conservative. A second copy for the "more trusted" source is
 *  exactly the fork that drifts. D-223 § 4. */

/** The form-field keys a suggestion may target. This list IS the capability
 *  surface: widening a publisher's reach means one entry here plus its
 *  validation, never a new authoring cell. */
import { CONNECTION_AUTH_TYPES } from './connection.js';

export const APPLICABLE_GUIDE_FIELD_KEYS: ReadonlySet<string> = new Set([
  'config.base_url',
  // ⛔ Added because D-223 shipped SHORT OF ITS OWN § 7 promise: "an owner …
  // sees the base URL already filled, THE AUTH TYPE PRE-SELECTED, and a link to
  // the page where the token is created." `auth.type` was never in this list, so
  // that clause could not hold.
  //
  // 🔑 And its absence did not cost one field, it cost most of the feature.
  // Every other OAuth key here is gated `showWhen: ifAuth('oauth2_refresh')` /
  // `ifAuth('oauth2_client_credentials')` on the api form, so with the type
  // unset a hinted `auth.authorize_url` / `auth.token_endpoint` / `auth.scopes`
  // is seeded and NEVER RENDERS — the owner still has to research the auth
  // method, which is the one thing the hint exists to spare them.
  //
  // ⚠ It is a VALUE, not schema: `auth.type` is a visible, editable `select`
  // the owner can change. Selecting a value that reveals other fields is what
  // that select does for a human too — the hint does not set `hidden`,
  // `readonly` or `showWhen`, which is D-223's actual boundary.
  'auth.type',
  'subresource_path',
  'auth.param_name',
  'auth.token_endpoint',
  'auth.scope',
  'auth.authorize_url',
  'auth.scopes',
]);

/** The subset of the above that must parse as a public HTTPS URL. */
export const HTTPS_GUIDE_FIELD_KEYS: ReadonlySet<string> = new Set([
  'config.base_url',
  'auth.token_endpoint',
  'auth.authorize_url',
]);

const isPrivateIpv4 = (hostname: string): boolean => {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(hostname);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((part) => part < 0 || part > 255)) return true;
  const [a, b] = octets as [number, number, number, number];
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
};

/** ⚠ NOT `isLocalSlotBaseUrl` (`chat.ts`). That one answers "should this BYOK
 *  slot show a (local) badge" and takes a URL; this one answers "is this hostname
 *  unsafe as a suggested endpoint" and is stricter — it also refuses `.local` /
 *  `.internal` / `.lan` / `.home`, single-label hosts, link-local, CGNAT, and
 *  benchmark ranges. Two predicates, two jobs; do not merge them. */
export const isPrivateHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.$/u, '');
  if (
    host === 'localhost'
    || !host.includes('.')
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host.endsWith('.internal')
    || host.endsWith('.lan')
    || host.endsWith('.home')
  ) return true;
  if (isPrivateIpv4(host)) return true;
  // These prefixes identify IPv6 ranges only; domains beginning with the same
  // letters (for example fc.example.com) remain valid public provider URLs.
  if (!host.includes(':')) return false;
  return host === '::1'
    || host === '::'
    || host.startsWith('::ffff:')
    || host.startsWith('fc')
    || host.startsWith('fd')
    || host.startsWith('fe8')
    || host.startsWith('fe9')
    || host.startsWith('fea')
    || host.startsWith('feb');
};

/** Admit one suggested value for one field key. The single gate for BOTH the
 *  setup guide's inferred suggestions and a pack's declared hints. */
export const canApplyConnectionSetupGuideSuggestion = (
  fieldKey: string,
  suggestedValue: string | undefined,
): boolean => {
  if (
    !APPLICABLE_GUIDE_FIELD_KEYS.has(fieldKey)
    || typeof suggestedValue !== 'string'
    || suggestedValue.trim().length === 0
    || suggestedValue.length > 500
  ) return false;
  // `auth.type` is a CLOSED vocabulary — validate against the canonical union,
  // never "any non-empty string". An unknown value would select nothing on the
  // form and silently strand every dependent `showWhen` field, which is the
  // failure this key was added to remove.
  //
  // `'none'` is excluded deliberately: the api form's own `AUTH_TYPES` filters
  // it out, so hinting it would name an option the select does not offer.
  if (fieldKey === 'auth.type') {
    return (CONNECTION_AUTH_TYPES as readonly string[]).includes(suggestedValue.trim())
      && suggestedValue.trim() !== 'none';
  }
  if (!HTTPS_GUIDE_FIELD_KEYS.has(fieldKey)) return true;
  try {
    const parsed = new URL(suggestedValue.trim());
    return parsed.protocol === 'https:'
      && parsed.hostname.length > 0
      && !isPrivateHost(parsed.hostname)
      && parsed.username.length === 0
      && parsed.password.length === 0;
  } catch {
    return false;
  }
};

/** One pack-declared pre-fill for one of the pack's connections. */
export interface ConnectionHint {
  /** The connection slug an ingredient in this pack names. Cross-checked against
   *  the composition by the authoring validator, not here — the pack contract
   *  admits the discriminant and D-170 owns composition internals. */
  connection: string;
  /** Field key → suggested value. Keys restricted to
   *  {@link APPLICABLE_GUIDE_FIELD_KEYS}; values must pass
   *  {@link canApplyConnectionSetupGuideSuggestion}. */
  values: Record<string, string>;
  /** Where the owner goes to create a credential. Same URL rules as a hinted
   *  endpoint: public HTTPS, no embedded credentials. */
  setup_url?: string;
}

/** Cap on `connection_hints[]`. Mirrors
 *  `BULK_PACK_MAX_CONNECTION_REQUIREMENTS` — a pack needing more distinct
 *  connections than this is pathological, and the cap bounds a hostile
 *  manifest's reach over the install dialog. */
export const BULK_PACK_MAX_CONNECTION_HINTS = 8;

/** Cells that belong to `connection_requirements` and carry authority. A hint
 *  carrying one is REFUSED rather than ignored: an ignored declaration reads to
 *  its author as an accepted one, which is the failure mode the output-key and
 *  variable-key fences exist to prevent. */
export const RESERVED_CONNECTION_REQUIREMENT_CELLS: readonly string[] = [
  'api_base',
  'vendor',
  'authority',
  'identity_endpoint',
  'auth',
  'per_org',
];

/** Validate one `connection_hints[]` entry. Shape only — the composition
 *  cross-check ("does an ingredient actually use this connection") belongs to the
 *  authoring validator, which is the layer that sees ingredients. */
export const validateConnectionHintShape = (
  entry: unknown,
  path: string,
  add: (code: string, path: string, message: string) => void,
): void => {
  if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) {
    add('pack_connection_hint_shape', path, 'connection hint must be an object');
    return;
  }
  const hint = entry as Record<string, unknown>;

  for (const cell of RESERVED_CONNECTION_REQUIREMENT_CELLS) {
    if (cell in hint) {
      add(
        'pack_connection_hint_reserved_cell',
        `${path}.${cell}`,
        `'${cell}' belongs to connection_requirements and carries authority a hint may not; `
        + 'a hint supplies values for visible, editable fields only',
      );
    }
  }

  if (typeof hint.connection !== 'string' || hint.connection.length === 0) {
    add('pack_connection_hint_connection', `${path}.connection`,
      'connection hint requires a non-empty connection slug');
  }

  if (hint.values == null || typeof hint.values !== 'object' || Array.isArray(hint.values)) {
    add('pack_connection_hint_values_shape', `${path}.values`,
      'connection hint values must be an object of field key -> suggested value');
  } else {
    const values = hint.values as Record<string, unknown>;
    const keys = Object.keys(values);
    if (keys.length === 0) {
      add('pack_connection_hint_values_empty', `${path}.values`,
        'connection hint declares no values');
    }
    for (const key of keys) {
      if (!APPLICABLE_GUIDE_FIELD_KEYS.has(key)) {
        add('pack_connection_hint_field_unknown', `${path}.values.${key}`,
          `'${key}' is not a pre-fillable connection field; admitted: `
          + `${[...APPLICABLE_GUIDE_FIELD_KEYS].join(', ')}`);
        continue;
      }
      const value = values[key];
      if (typeof value !== 'string') {
        add('pack_connection_hint_value_shape', `${path}.values.${key}`,
          'a suggested value must be a string');
        continue;
      }
      if (!canApplyConnectionSetupGuideSuggestion(key, value)) {
        add('pack_connection_hint_value_rejected', `${path}.values.${key}`,
          `'${key}' value is not admissible — endpoint fields must be a public `
          + 'https URL carrying no credentials, and every value is capped at 500 characters');
      }
    }
  }

  if (hint.setup_url !== undefined) {
    // Held to the same bar as a hinted endpoint: it is a link the owner is
    // invited to follow, so a private host or embedded credential is no more
    // acceptable here than in `config.base_url`.
    if (!canApplyConnectionSetupGuideSuggestion('config.base_url', hint.setup_url as string)) {
      add('pack_connection_hint_setup_url', `${path}.setup_url`,
        'setup_url must be a public https URL carrying no credentials');
    }
  }
};
