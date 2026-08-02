/** D-194 — Pack-Driven Connection Enrollment: the `connection_requirements`
 *  manifest descriptor + its legacy compile-time fallback.
 *
 *  A first-party pack that "claims" a capability (a file kind / app-pack ops)
 *  declares, per connection it needs, a small NON-SECRET descriptor: the API
 *  endpoint it talks to (`api_base` — the row-match key, §3), the file-wire
 *  `vendor` tag, the OAuth issuer for the consent dance (`authority`), an
 *  optional identity endpoint for the post-OAuth read-back (§7), and the
 *  credential METHOD (`auth` — §5). The install screen reads it to offer an
 *  inline "Connect account" that fast-tracks the existing BYO enrollment.
 *
 *  The install planner now reads the pack-carried descriptor directly. This
 *  file also retains `CONNECTION_REQUIREMENT_SEED` as a compatibility fallback
 *  for consumers loading an older manifest with the field absent; every shipped
 *  first-party pack, including OneDrive, carries the field today. Descriptor
 *  TRUST comes from the compiled-in vendor leaf it binds to by slug (Tier-3,
 *  §2), not from a review of the descriptor.
 *
 *  Spec: D-194 §4 (the manifest block) / §5 (the auth union) /
 *  §11 (the original seed). The manifest field + its first-party validator gate
 *  live on `BulkPackManifest` (`bulk-pack.ts`).
 */

import { AUTHORIZE_PARAM_RESERVED_KEYS, MICROSOFT_GRAPH_API_BASE } from './connection-vendor-providers.js';
import {
  CONNECTION_AUTH_TYPES,
  isValidOAuthEndpointUrl,
  MAX_HEADER_AUTH_ENTRIES,
  validateHeaderAuthEntries,
  type ConnectionAuthType,
  type ConnectionView,
  type HeaderAuthIssue,
} from './connection.js';
import { MICROSOFT_AUTHORIZE_URL, MICROSOFT_TOKEN_URL } from './foundational-oauth.js';

// ────────────────────────────────────────────────────────────────
// Auth descriptor — the credential METHOD, no secrets
// ────────────────────────────────────────────────────────────────

/** The credential-method descriptor a `ConnectionRequirement` carries. Mirrors
 *  the DISCRIMINANT of `ConnectionAuth` (`connection.ts:53`) but holds only the
 *  NON-SECRET enrollment metadata — the secret (bearer token, API key, OAuth
 *  client secret / refresh token) is obtained per-connection at enroll time and
 *  is never declared in a pack manifest.
 *
 *  Authorization-code scopes are deliberately absent: they live on the ops
 *  (`OperationRow.required_scopes`, `op-model.ts`) and are unioned per
 *  connection slot by `connection-scope-coverage.ts`, not re-declared here (§4).
 *
 *  D-194 §5. `access_key` (S3) is NOT a variant — S3 rides `basic`
 *  (username = access-key-id, password = secret; region/bucket are `config.*`). */
export type ConnectionAuthDescriptor =
  /** No credential (a public endpoint). */
  | { type: 'none' }
  /** Paste a long-lived bearer token. */
  | { type: 'bearer' }
  /** Username + password (S3: access-key-id + secret). */
  | { type: 'basic' }
  /** Paste N API-key headers. Names are declared; the values are pasted at
   *  enroll. One entry covers the common single-header case; two+ covers
   *  split-credential vendors (Plaid). Always non-empty. */
  | { type: 'header'; header_names: ReadonlyArray<string> }
  /** Paste a single query-param key. */
  | { type: 'query'; param_name: string }
  /** BYO OAuth (D-062). Carries the consent-dance URLs + the two per-vendor
   *  quirks the generic engine needs; `client_id` / `client_secret` are still
   *  typed at enroll (or reused from an existing connection). */
  | {
      type: 'oauth2_refresh';
      authorize_url: string;
      token_endpoint: string;
      /** Extra static query params merged into the authorize URL (Google's
       *  `access_type=offline` + `prompt=consent`, Dropbox's
       *  `token_access_type=offline`). Reserved standard keys can't be
       *  overridden. */
      authorize_params?: Readonly<Record<string, string>>;
      /** PKCE (RFC 7636, S256) support on the authorization-code flow. */
      supports_pkce?: boolean;
    }
  /** Machine-to-machine OAuth. The client id + secret are entered at enroll;
   *  only the trusted token endpoint and grant metadata live in the pack. */
  | {
      type: 'oauth2_client_credentials';
      token_endpoint: string;
      token_auth_style?: 'body' | 'basic';
      scope?: string;
    }
  /** D-218 — AT Protocol session exchange. The owner enters a handle and an app
   *  password at enroll.
   *
   *  ⛔ **Carries NO endpoint, and that is the security property (§ 7.5b).**
   *  Every other exchanging descriptor names a `token_endpoint`; this one
   *  deliberately does not, because the session endpoints are DERIVED from the
   *  connection's own `api_base`. A pack-declared, credential-only destination
   *  would let a manifest name where an account password gets POSTed — the
   *  highest-value exfiltration primitive in the system, and one no reviewer
   *  would think to look for on an auth descriptor. Deriving it means the
   *  password can only ever reach the host the connection already talks to. */
  | { type: 'atproto_session' };

/** Closed list of `ConnectionAuthDescriptor` discriminants.
 *
 *  ⚠ **A pack-side vocabulary, distinct from `ConnectionAuth`** — this is what a
 *  pack DECLARES it needs, not what the owner stores. The two happen to carry
 *  the same names, and D-218 found that "happen to" was doing real work: the
 *  list was a hand-kept copy, so widening `ConnectionAuth` left it silently
 *  short and a subset typechecks. It is now DERIVED, with the descriptor union
 *  checked against it below — the same both-directions guard `CONNECTION_AUTH_TYPES`
 *  carries. */
export const CONNECTION_AUTH_DESCRIPTOR_TYPES =
  CONNECTION_AUTH_TYPES satisfies readonly ConnectionAuthDescriptor['type'][];

/** Compile-time proof that no descriptor member is missing from the derived
 *  list — the reverse direction `satisfies` cannot express. */
type DescriptorTypesAreExhaustive =
  Exclude<ConnectionAuthDescriptor['type'], ConnectionAuthType> extends never ? true : never;
const _descriptorTypesAreExhaustive: DescriptorTypesAreExhaustive = true;
void _descriptorTypesAreExhaustive;
export type ConnectionAuthDescriptorType = (typeof CONNECTION_AUTH_DESCRIPTOR_TYPES)[number];

// ────────────────────────────────────────────────────────────────
// Connection requirement — one connection a pack needs
// ────────────────────────────────────────────────────────────────

/** One connection a first-party pack needs, declared in the manifest's
 *  `connection_requirements[]` (`bulk-pack.ts`). D-194 §4. */
export interface ConnectionRequirement {
  /** OAuth issuer host — used by the consent dance only. **Required for an
   *  `oauth2_refresh` descriptor** (`login.microsoftonline.com`); omitted for
   *  key/basic/query/none (no issuer). NOT the row-match key: matching is on
   *  `api_base` (§3). Optional at the type level because the requirement is keyed
   *  off the `auth` discriminant, enforced in `validateConnectionRequirementShape`. */
  authority?: string;
  /** The runtime API base (today: the ingredient's `http.base`). THE row-match
   *  key (§3): a connection stores the same value as `config.base_url`
   *  (plaintext in `config_json`), so "which existing connections could this
   *  pack adopt?" is `list api rows → filter by this endpoint's host`.
   *  Deliberately NOT the encrypted OAuth issuer and NOT `config.vendor`.
   *
   *  For a `per_org` vendor the host varies per account (Dataverse's
   *  `<tenant>.crm.dynamics.com`), so `api_base` can't be a match key — carry a
   *  placeholder-host base whose PATH is the real one (`https://
   *  org.crm.dynamics.com/api/data/v9.2`); matching then keys on `vendor`, not
   *  this host (see `per_org`). */
  api_base: string;
  /** D-192 — the vendor's API host is PER-ACCOUNT (Dataverse
   *  `<tenant>.crm.dynamics.com`, a Salesforce `my.salesforce.com` instance),
   *  so a fixed `api_base` host can't be the row-match key. When true,
   *  `findEndpointCandidates` matches an existing connection by its
   *  `config.vendor` tag (=== this `vendor`) instead of the endpoint host — the
   *  one case where §3's endpoint-over-vendor rule inverts, because the endpoint
   *  is not a stable identity and a per-org host is never shared cross-slug (so
   *  the cross-slug surfacing §3 protected doesn't apply). Absent/false ⇒
   *  endpoint-host match (the default, unchanged). */
  per_org?: boolean;
  /** File-wire tag stamped into `config.vendor` at enroll so
   *  `desiredFileSourcesFor` (`file-source-sync.ts`) lights up the file-source
   *  leaf by slug. NOT the reuse/match key (§3). Vendor-slug shape
   *  (`[a-z][a-z0-9_]*`). */
  vendor: string;
  /** "Who am I" endpoint (Graph `/me`, Google userinfo). The post-OAuth
   *  identity read-back (server-side, inside OAuth completion) reads it for the
   *  immutable-id auto-dedup key + email tag pre-fill (§7). Absent ⇒ identity
   *  unverifiable ⇒ NO auto-dedup, fail-safe to a separate connection. */
  identity_endpoint?: string;
  /** Credential method — §5. */
  auth: ConnectionAuthDescriptor;
}

/** Cap on `connection_requirements[]` length. A pack needing many DISTINCT
 *  connections is pathological — multiplicity (5 buckets = 5 dishes) is a
 *  D-179 dish config axis (§13), not a descriptor axis. Bounds the install
 *  dialog + guards against a hostile manifest. */
export const BULK_PACK_MAX_CONNECTION_REQUIREMENTS = 8;

// ────────────────────────────────────────────────────────────────
// Shape validation — ONE source of truth
// ────────────────────────────────────────────────────────────────

/** Vendor-slug shape — mirrors `VENDOR_REGEX` (`connection-vendor-providers.ts`)
 *  + the `config.vendor` field on a connection row. Kept local so this file is
 *  self-contained (easy to delete/relocate when the seed migrates at D-166). */
const VENDOR_SLUG_RE = /^[a-z][a-z0-9_]*$/;

/** True when `v` is a plain object whose every value is a string. */
const isStringRecord = (v: unknown): boolean =>
  v != null
  && typeof v === 'object'
  && !Array.isArray(v)
  && Object.values(v as Record<string, unknown>).every((x) => typeof x === 'string');

/** Frame a `validateHeaderAuthEntries` issue as a `header_names` message.
 *  `value_missing` is unreachable — we synthesize a placeholder value per name. */
const headerNamesIssueMessage = (issue: HeaderAuthIssue): string => {
  switch (issue.code) {
    case 'not_array':
      return 'auth.header_names must be a non-empty array of non-empty strings';
    case 'empty':
      return 'auth.header_names must be a non-empty array of non-empty strings';
    case 'too_many':
      return `auth.header_names may contain at most ${MAX_HEADER_AUTH_ENTRIES} entries`;
    case 'name_missing':
      return `auth.header_names[${issue.index}] must be a non-empty string`;
    case 'name_reserved':
      return `auth.header_names[${issue.index}] must not be a reserved object key (__proto__ / constructor / prototype)`;
    case 'value_missing':
      return `auth.header_names[${issue.index}] is invalid`;
  }
};

/** Shape-validate the `auth` descriptor. Returns issue strings (empty ⇒ valid). */
const validateAuthDescriptor = (auth: unknown): string[] => {
  if (auth == null || typeof auth !== 'object' || Array.isArray(auth)) {
    return ['auth must be an object'];
  }
  const a = auth as Record<string, unknown>;
  const type = a.type;
  if (typeof type !== 'string'
    || !(CONNECTION_AUTH_DESCRIPTOR_TYPES as readonly string[]).includes(type)) {
    return [`auth.type must be one of ${CONNECTION_AUTH_DESCRIPTOR_TYPES.join('|')}; got ${JSON.stringify(type)}`];
  }
  const issues: string[] = [];
  switch (type) {
    case 'oauth2_refresh':
      if (!isValidOAuthEndpointUrl(a.authorize_url)) {
        issues.push('auth.authorize_url must be a complete HTTPS URL with no embedded username or password and no URL fragment');
      }
      if (!isValidOAuthEndpointUrl(a.token_endpoint)) {
        issues.push('auth.token_endpoint must be a complete HTTPS URL with no embedded username or password and no URL fragment');
      }
      if (a.authorize_params !== undefined) {
        if (!isStringRecord(a.authorize_params)) {
          issues.push('auth.authorize_params must be a string→string object when present');
        } else {
          // Mirror assertConnectionVendorProviderShape: a descriptor may not
          // smuggle a reserved OAuth-start key (state / scope / redirect_uri /
          // client_id / …) through this hatch, and every value must be non-empty.
          for (const [k, v] of Object.entries(a.authorize_params as Record<string, string>)) {
            if (AUTHORIZE_PARAM_RESERVED_KEYS.has(k)) {
              issues.push(`auth.authorize_params may not override the reserved OAuth-start key '${k}'`);
            }
            if (v.length === 0) {
              issues.push(`auth.authorize_params['${k}'] must be a non-empty string`);
            }
          }
        }
      }
      if (a.supports_pkce !== undefined && typeof a.supports_pkce !== 'boolean') {
        issues.push('auth.supports_pkce must be a boolean when present');
      }
      break;
    case 'oauth2_client_credentials':
      if (!isValidOAuthEndpointUrl(a.token_endpoint)) {
        issues.push('auth.token_endpoint must be a complete HTTPS URL with no embedded username or password and no URL fragment');
      }
      if (a.token_auth_style !== undefined
        && a.token_auth_style !== 'body'
        && a.token_auth_style !== 'basic') {
        issues.push("auth.token_auth_style must be 'body' or 'basic' when present");
      }
      if (a.scope !== undefined && (typeof a.scope !== 'string' || a.scope.trim().length === 0)) {
        issues.push('auth.scope must be a non-empty string when present');
      }
      break;
    case 'header':
      if (!Array.isArray(a.header_names)) {
        issues.push('auth.header_names must be a non-empty array of non-empty strings');
      } else {
        // Delegate to the canonical ConnectionAuth header-name guard: it rejects
        // reserved object keys (__proto__ / constructor / prototype), enforces the
        // MAX_HEADER_AUTH_ENTRIES cap, and requires non-empty names — so a
        // first-party descriptor can never declare a header a real ConnectionAuth
        // would reject at enroll. The descriptor carries NAMES only (values are
        // pasted at enroll), so synthesize a placeholder value per name.
        const res = validateHeaderAuthEntries(
          a.header_names.map((n) => ({ header_name: n, value: 'x' })),
        );
        if (!res.ok) issues.push(headerNamesIssueMessage(res.issue));
      }
      break;
    case 'query':
      if (typeof a.param_name !== 'string' || a.param_name.length === 0) {
        issues.push('auth.param_name must be a non-empty string');
      }
      break;
    // 'bearer' | 'basic' | 'none' | 'atproto_session' — the discriminant is the
    // whole descriptor, so there is nothing beyond it to validate.
    //
    // ⚠ D-218: `atproto_session` belongs here for a REASON, not by omission. It
    // carries no endpoint by design (§ 7.5b) — the session URLs derive from the
    // connection's `api_base` — so a case that checked "is the endpoint https"
    // would have nothing to check. The absence IS the security property; if a
    // future edit gives this descriptor a field, it stops belonging here.
    default:
      break;
  }
  return issues;
};

/** Shape-validate one `ConnectionRequirement`. Returns issue strings (empty ⇒
 *  valid), mirroring `assertConnectionVendorProviderShape`. PURE — the single
 *  source of truth for descriptor shape, consumed by BOTH the boot-time seed
 *  self-check (below) and the manifest validator (`parseBulkPackManifest` maps
 *  each returned string to a `pack_connection_requirement_invalid` issue). */
export const validateConnectionRequirementShape = (entry: unknown): string[] => {
  if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) {
    return ['connection requirement must be an object'];
  }
  const r = entry as Record<string, unknown>;
  const issues: string[] = [];
  // api_base — required https URL (the match key, or a placeholder-host base
  // for a per_org vendor whose real host varies per account).
  if (typeof r.api_base !== 'string' || !r.api_base.startsWith('https://')) {
    issues.push(`api_base must be an https:// URL; got ${JSON.stringify(r.api_base)}`);
  }
  // per_org — optional boolean; flips matching from endpoint-host to vendor tag.
  if (r.per_org !== undefined && typeof r.per_org !== 'boolean') {
    issues.push('per_org must be a boolean when present');
  }
  // vendor — required, vendor-slug shape.
  if (typeof r.vendor !== 'string' || !VENDOR_SLUG_RE.test(r.vendor)) {
    issues.push(`vendor must match ${VENDOR_SLUG_RE.source}; got ${JSON.stringify(r.vendor)}`);
  }
  // authority — REQUIRED (non-empty) for an oauth2_refresh descriptor (the OAuth
  // issuer the consent dance narrows to, §3); optional for key/basic/query/none
  // (no issuer). Keyed off the auth discriminant.
  const authType = r.auth != null && typeof r.auth === 'object' && !Array.isArray(r.auth)
    ? (r.auth as Record<string, unknown>).type
    : undefined;
  if (authType === 'oauth2_refresh') {
    if (typeof r.authority !== 'string' || r.authority.length === 0) {
      issues.push('authority (OAuth issuer host) is required for an oauth2_refresh descriptor');
    }
  } else if (r.authority !== undefined && (typeof r.authority !== 'string' || r.authority.length === 0)) {
    issues.push('authority must be a non-empty string when present');
  }
  // identity_endpoint — optional; https:// URL when present.
  if (r.identity_endpoint !== undefined
    && (typeof r.identity_endpoint !== 'string' || !r.identity_endpoint.startsWith('https://'))) {
    issues.push('identity_endpoint must be an https:// URL when present');
  }
  // auth — required discriminated union.
  issues.push(...validateAuthDescriptor(r.auth));
  return issues;
};

// ────────────────────────────────────────────────────────────────
// Endpoint match — candidate lookup (§3)
// ────────────────────────────────────────────────────────────────

/** Normalize a URL / API base to its endpoint HOST (lowercase `host[:port]`,
 *  with scheme + path + query stripped) — the row-match key (§3: "matching
 *  normalizes to the host; a version/path suffix on `base_url` is trimmed").
 *  Returns `null` for a non-string / empty / unparseable value, so a row with a
 *  malformed `base_url` simply never matches (fail-safe to the per-pack default).
 *  A non-default PORT is kept (endpoint identity includes it, so two
 *  S3-compatible endpoints on distinct ports stay distinct — unlike `chat.ts`'s
 *  tab-URL matching which drops it); the FQDN root dot is folded
 *  (`graph.microsoft.com.` === `graph.microsoft.com`) so the two forms group. */
export const endpointHost = (url: unknown): string | null => {
  if (typeof url !== 'string' || url.length === 0) return null;
  try {
    const u = new URL(url);
    const hostname = u.hostname.replace(/\.+$/, '').toLowerCase();
    if (hostname.length === 0) return null;
    return u.port ? `${hostname}:${u.port}` : hostname;
  } catch {
    return null;
  }
};

/** A connection surfaced as a reuse/merge candidate for a pack's requirement —
 *  same endpoint host (§3). Identity (the verified email, §7) is added by the
 *  step-4 read-back; today a candidate carries what a listed row already has. */
export interface EndpointCandidate {
  /** The connection's `(kind, name)` name — the grant/slot bind target (§3). */
  name: string;
  display_name: string;
  /** OAuth scopes the vendor granted (a soft coverage hint; empty when unknown). */
  granted_scopes: readonly string[];
}

/** Find the existing `api` connections a pack's requirement could adopt: those
 *  whose endpoint HOST matches the descriptor's `api_base` (§3). Endpoint-keyed,
 *  NOT `config.vendor` — so a cross-slug candidate surfaces (a Microsoft app pack
 *  can show a OneDrive connection; both resolve `graph.microsoft.com`). Pure: the
 *  caller passes `collection.connection.list`'s `ConnectionView[]` (ideally
 *  already `{kind:'api'}`-filtered — non-api rows carry no `base_url` and are
 *  skipped regardless). Sorted by name. A MERGE across a returned candidate is
 *  still gated on verified identity (§7); this only GROUPS the candidates. */
export const findEndpointCandidates = (
  requirement: ConnectionRequirement,
  connections: readonly ConnectionView[],
): EndpointCandidate[] => {
  // §3 default: match on the endpoint HOST. A per_org vendor (Dataverse
  // `<tenant>.crm.dynamics.com`) has no fixed host, so its `api_base` can't be
  // the key — match on the plaintext `config.vendor` tag (`c.vendor`, flattened
  // onto the view) instead. Endpoint path unchanged: a non-per_org requirement
  // whose api_base is unparseable matches nothing (fail-safe to per-pack).
  const target = requirement.per_org ? null : endpointHost(requirement.api_base);
  if (!requirement.per_org && target === null) return [];
  const out: EndpointCandidate[] = [];
  for (const c of connections) {
    if (c.kind !== 'api') continue;
    // Endpoint identity alone cannot make two credential protocols
    // interchangeable. Missing legacy metadata fails closed and asks for
    // enrollment instead of auto-binding a row the operation cannot use.
    if (c.auth_type !== requirement.auth.type) continue;
    const isMatch = requirement.per_org
      ? c.vendor === requirement.vendor
      : endpointHost(c.base_url) === target;
    if (!isMatch) continue;
    out.push({
      name: c.name,
      display_name: c.display_name,
      granted_scopes: Array.isArray(c.granted_scopes) ? c.granted_scopes : [],
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
};

// ────────────────────────────────────────────────────────────────
// Legacy compile-time fallback (§11) — pack-carried descriptors are authoritative
// ────────────────────────────────────────────────────────────────

/** OneDrive connection requirement — the SAME data the compiled-in file leaf's
 *  `ONEDRIVE_PROVIDER` carries, relocated here (not throwaway; pre-launch ⇒ no
 *  migration, `feedback_pre_launch_no_migration`). Microsoft mints the refresh
 *  token from the `offline_access` SCOPE, so there are no `authorize_params`;
 *  Graph supports PKCE. `identity_endpoint` is the Graph `/me` read-back (§7). */
const ONEDRIVE_CONNECTION_REQUIREMENT: ConnectionRequirement = {
  authority: 'login.microsoftonline.com',
  api_base: MICROSOFT_GRAPH_API_BASE,
  vendor: 'onedrive',
  identity_endpoint: `${MICROSOFT_GRAPH_API_BASE}/me`,
  auth: {
    type: 'oauth2_refresh',
    authorize_url: MICROSOFT_AUTHORIZE_URL,
    token_endpoint: MICROSOFT_TOKEN_URL,
    supports_pkce: true,
  },
};

/** Legacy compile-time fallback: first-party pack SLUG → the connection
 *  requirements it needs when an older manifest omits
 *  `connection_requirements[]`. Shipped manifests now carry their descriptor
 *  directly; keep this fallback synchronized until its remaining consumers can
 *  drop pre-migration compatibility. */
export const CONNECTION_REQUIREMENT_SEED: Readonly<
  Record<string, ReadonlyArray<ConnectionRequirement>>
> = {
  onedrive: [ONEDRIVE_CONNECTION_REQUIREMENT],
};

/** Look up the seeded connection requirements for a first-party pack slug.
 *  Returns `[]` for a pack with no seeded descriptor (its connections enroll
 *  via the generic BYO form). The optional `seed` arg keeps callers + tests
 *  from binding to the module-level registry. */
export const getSeededConnectionRequirements = (
  slug: string,
  seed: Readonly<Record<string, ReadonlyArray<ConnectionRequirement>>> = CONNECTION_REQUIREMENT_SEED,
): ReadonlyArray<ConnectionRequirement> =>
  Object.prototype.hasOwnProperty.call(seed, slug) ? seed[slug] : [];

// Boot-time self-check — the fallback must satisfy the SAME shape rules the
// manifest validator enforces, so a first-party descriptor can never drift into
// an invalid shape (mirrors `CONNECTION_VENDOR_PROVIDERS`' boot validation at
// module load). Throws loudly at import if a seed entry is malformed.
const _seedIssues = Object.entries(CONNECTION_REQUIREMENT_SEED).flatMap(([slug, reqs]) =>
  reqs.flatMap((r, i) =>
    validateConnectionRequirementShape(r).map((msg) => `${slug}[${i}]: ${msg}`)),
);
if (_seedIssues.length > 0) {
  throw new Error(
    `CONNECTION_REQUIREMENT_SEED shape validation failed: ${_seedIssues.join('; ')}`,
  );
}
