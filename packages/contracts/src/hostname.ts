/** D-152 P0 — multi-hostname registry contracts.
 *
 * The registry is free substrate: it describes which hostnames a server may
 * answer for, how ownership was proven, and whether TLS terminates on Recued or
 * an upstream proxy. Public projections intentionally omit all cert/key bytes.
 */

import { resolveProDdnsHost } from './network.js';
import {
  customDomainDelegationUrgency,
  type CustomDomainDelegationState,
  type CustomDomainDelegationUrgency,
} from './custom-domain.js';

declare const URL: {
  new (input: string): { hostname: string };
};

export const HOSTNAME_CERT_SOURCES = [
  'recued_acme',
  /** D-235 — the fleet issues + renews for a hostname the USER owns, via a
   *  `_acme-challenge` CNAME delegated into the fleet's zone.
   *
   *  ⛔ DELIBERATELY NOT A RELAXATION OF `recued_acme`. That value means "the
   *  fleet owns the zone, so ownership is implicit" and three separate places
   *  encode that: the registry skips straight to `ownership_status: 'verified'`,
   *  the registry requires a single-label Pro DDNS hostname, and the
   *  ownership-proof machine refuses to take a proof at all. Widening
   *  `recued_acme` to custom hostnames means relaxing all three in agreement,
   *  and the auto-verify default is the one that fails silently — a custom
   *  hostname would enrol as `verified` with no proof of anything, which is the
   *  exact hole D-235 § 2.6 exists to keep shut. A separate member inherits the
   *  SAFE default (`pending`) by falling into the else branch, and the type
   *  checker names every site that has to think about it. */
  'recued_acme_custom',
  'byo_uploaded',
  'byo_external',
] as const;
export type HostnameCertSource = (typeof HOSTNAME_CERT_SOURCES)[number];

/** D-235 — is this source one the FLEET issues certificates for (as opposed to
 *  a BYO cert the user supplies or terminates upstream)? Both ACME sources are
 *  fleet-issued; they differ only in how ownership of the name is established. */
export const isFleetIssuedCertSource = (
  source: HostnameCertSource,
): source is 'recued_acme' | 'recued_acme_custom' =>
  source === 'recued_acme' || source === 'recued_acme_custom';

export const HOSTNAME_VERIFICATION_METHODS = [
  'cert_proof',
  'http_token',
  'dns_txt',
] as const;
export type HostnameVerificationMethod = (typeof HOSTNAME_VERIFICATION_METHODS)[number];

export const HOSTNAME_OWNERSHIP_STATUSES = [
  'pending',
  'verified',
  'failed',
] as const;
export type HostnameOwnershipStatus = (typeof HOSTNAME_OWNERSHIP_STATUSES)[number];

/** Certificate PROVISIONING state — deliberately separate from
 *  `ownership_status`, which answers a different question and was being read as
 *  this one. A `recued_acme` row registered by the enrollment service is
 *  `ownership_status: 'verified'` the instant it appears (the handle
 *  reservation IS the proof for a Recued-controlled zone), so the UI showed
 *  "Verified" while there was no certificate at all.
 *
 *  `pending` and `failed` are NOT distinguishable from a missing
 *  `cert_fingerprint` alone, which is why this is persisted rather than
 *  derived: a server backing off after a CA rejection looks identical to one
 *  that has simply not tried yet. */
export const HOSTNAME_CERT_PROVISIONING_STATES = [
  /** Registered; no issuance attempted yet. */
  'pending',
  /** An attempt failed; the enrollment service is backing off and will retry. */
  'failed',
  /** Certificate issued and stored. */
  'ready',
] as const;
export type HostnameCertProvisioningState =
  (typeof HOSTNAME_CERT_PROVISIONING_STATES)[number];

export const isHostnameCertProvisioningState = (
  value: unknown,
): value is HostnameCertProvisioningState =>
  typeof value === 'string'
  && (HOSTNAME_CERT_PROVISIONING_STATES as ReadonlyArray<string>).includes(value);

export const HOSTNAME_TLS_TOPOLOGIES = [
  'server_terminated',
  'upstream_terminated',
] as const;
export type HostnameTlsTopology = (typeof HOSTNAME_TLS_TOPOLOGIES)[number];

/** ⛔ NOT A LIST OF PORTS THIS SERVER LISTENS ON. D-272: production binds
 *  sockets in exactly ONE place — `packages/server-tls/src/path-listener-set.ts`
 *  — and it binds TWO, `lan_port` and `public_port`. `ws`, `mcp`, `reception`,
 *  `webhooks`, `oauth`, `ask` and `webclient` are all PATHS on those.
 *
 *  🔑 WHAT IT ACTUALLY MEANS: the ports a hostname may be DECLARED to answer
 *  on. `443` plus the three retired per-role public ports (8446 reception /
 *  8447 MCP / 8448 webhooks, named in D-152 § A.3.2), kept
 *  because an `upstream_terminated` topology can still front this server on one
 *  of them. The registry default is `[443]`, and the Hostnames UI renders one
 *  checkbox per entry.
 *
 *  Its consumers, all of which read it as a DECLARATION:
 *   - `deriveShareBaseUrlFromHostnameRegistry` — builds the public share URL,
 *     preferring 443 and otherwise suffixing `:<port>`. The only behavioural
 *     reader.
 *   - `DIAGNOSTIC_ALLOWED_PORTS` (= 80 + this set) — what the cloud probe may
 *     be ASKED about. ⚠ A `public_port` outside that set has no answer at all
 *     and must read `null` (unknown), never `false`.
 *   - the Hostnames checkbox grid, derived from this constant rather than
 *     hand-written.
 *
 *  ⚠ "WHY IS `ws` NOT IN HERE" IS A CATEGORY ERROR, NOT A GAP — settled
 *  2026-09-16, and left OPEN by D-272 with a warning not to invent a reason.
 *  The reason a reader reaches for ("ws is LAN-only") is false, and the
 *  `DEFAULT_PORTS` table that appears to say `ws: 8443` is from the FIVE-PROFILE
 *  / `PortRole` model the 2026-05-11 Path-Consolidation Amendment retired:
 *  `PortRole`, `DEFAULT_PORTS`, `PortState` and `EXPOSURE_PROFILE_PORT_MAP` exist
 *  NOWHERE in `packages/`, `backend/` or `apps/` — the single grep hit is a test
 *  file's comment recording the retirement. ⇒ In the live model no role has a
 *  port, so there is no ws port to omit. The numbers here are historical, and
 *  asking which role each one belongs to is asking a question the code stopped
 *  having an answer to. */
export const HOSTNAME_LISTENER_PORTS = [443, 8446, 8447, 8448] as const;
export type HostnameListenerPort = (typeof HOSTNAME_LISTENER_PORTS)[number];

export interface HostnameCertChainMetadata {
  issuer: string;
  subject: string;
}

/** Server-internal storage row. Never expose this shape over RPC. */
export interface HostnameStorageRow {
  hostname_id: string;
  server_identity_id: string;
  hostname_normalized: string;
  cert_source: HostnameCertSource;
  cert_blob_id?: string;
  cert_fingerprint?: string;
  cert_expires_at?: number;
  cert_chain_metadata?: HostnameCertChainMetadata;
  /** Certificate PROVISIONING state — distinct from `ownership_status`. */
  cert_provisioning?: HostnameCertProvisioningState;
  /** Closed-list reason from the last failed attempt, for the UI to explain
   *  WHY rather than just that something is wrong. */
  cert_last_error?: string;
  /** D-235 § 5.1 — last observed state of the `_acme-challenge` delegation.
   *  ⛔ Deliberately NOT folded into `cert_provisioning`: a `ready` cert whose
   *  delegation has been deleted is the exact silent-until-outage case this
   *  field exists to make visible. Absent on every non-custom row. */
  delegation_state?: CustomDomainDelegationState;
  /** Unix-ms of the last delegation check. Absent ⇒ never checked, which is
   *  distinct from "checked and could not tell" (`delegation_state:
   *  'unknown'`). */
  delegation_checked_at?: number;
  ownership_status: HostnameOwnershipStatus;
  verification_method?: HostnameVerificationMethod;
  verification_token_hash?: string;
  verified_at?: number;
  listener_ports: ReadonlyArray<HostnameListenerPort>;
  ddns_managed: boolean;
  enabled: boolean;
  tls_topology: HostnameTlsTopology;
  created_at: number;
  updated_at: number;
}

/** RPC/list projection. Excludes `cert_blob_id`, cert PEM, and private key PEM. */
export interface HostnameProjection {
  hostname_id: string;
  hostname: string;
  cert_source: HostnameCertSource;
  cert_fingerprint?: string;
  cert_expires_at?: number;
  cert_chain_metadata?: HostnameCertChainMetadata;
  cert_provisioning?: HostnameCertProvisioningState;
  cert_last_error?: string;
  /** D-235 § 5.1 — see `HostnameStorageRow`. Projected so Settings can render
   *  the degraded state without a second round-trip. */
  delegation_state?: CustomDomainDelegationState;
  delegation_checked_at?: number;
  /** Derived, not stored: how loudly to say it, given how much cert lifetime
   *  is left. Computed at projection time so the client cannot disagree with
   *  the server about severity by holding a stale clock. */
  delegation_urgency?: CustomDomainDelegationUrgency;
  ownership_status: HostnameOwnershipStatus;
  verification_method?: HostnameVerificationMethod;
  listener_ports: ReadonlyArray<HostnameListenerPort>;
  ddns_managed: boolean;
  enabled: boolean;
  tls_topology: HostnameTlsTopology;
}

export interface HostnameListResponse {
  hostnames: HostnameProjection[];
}

export interface HostnameGetRequest {
  hostname: string;
}

export interface HostnameGetResponse {
  hostname: HostnameProjection | null;
}

export interface HostnameAddRequest {
  hostname: string;
  cert_source: HostnameCertSource;
  cert_blob_id?: string;
  cert_fingerprint?: string;
  cert_expires_at?: number;
  cert_chain_metadata?: HostnameCertChainMetadata;
  cert_provisioning?: HostnameCertProvisioningState;
  cert_last_error?: string;
  ownership_status?: HostnameOwnershipStatus;
  verification_method?: HostnameVerificationMethod;
  verification_token_hash?: string;
  verified_at?: number;
  listener_ports?: ReadonlyArray<number>;
  ddns_managed?: boolean;
  enabled?: boolean;
}

export interface HostnameUpdateRequest
  extends Partial<Omit<HostnameAddRequest, 'hostname' | 'cert_source'>> {
  hostname: string;
  cert_source?: HostnameCertSource;
}

export interface HostnameMutationResponse {
  hostname: HostnameProjection;
}

export interface HostnameRemoveRequest {
  hostname: string;
}

export interface HostnameRemoveResponse {
  removed: boolean;
}

/** What an address is HANDED OUT for — kept by someone else, so it must not
 *  move unless the owner moves it: a webhook address a vendor stores, a
 *  Reception link that gets printed or embedded, the MCP / gateway address a
 *  customer is given.
 *
 *  Links in notifications are deliberately NOT here. They are opened soon
 *  after they are sent, so they follow whichever address answers best at the
 *  time (the server's probe-ranked resolver); a pin would only make them
 *  worse. */
export const HOSTNAME_ADDRESS_USES = ['webhooks', 'reception', 'customer_access'] as const;
export type HostnameAddressUse = (typeof HOSTNAME_ADDRESS_USES)[number];

export const isHostnameAddressUse = (value: unknown): value is HostnameAddressUse =>
  typeof value === 'string'
  && (HOSTNAME_ADDRESS_USES as readonly string[]).includes(value);

/** Who decided a use's address.
 *  - `configured` — `RECUED_PUBLIC_BASE_URL`, set on the server. It wins.
 *  - `owner` — picked on the Hostnames screen.
 *  - `first_use` — the automatic address, kept from the first time it was
 *    handed out, so adding a name later moves nothing.
 *  - `automatic` — nothing handed out yet: own domain first, then the Pro
 *    address, 443 first. */
export type HostnameAddressSource = 'configured' | 'owner' | 'first_use' | 'automatic';

export interface HostnameAddressUseState {
  use: HostnameAddressUse;
  source: HostnameAddressSource;
  /** The address handed out for this use now; null when there is none —
   *  including when the kept name no longer works, which is reported and
   *  never silently replaced. */
  base_url: string | null;
  /** The name kept for this use (`owner` / `first_use`), even when it no
   *  longer works. */
  hostname?: string;
  /** The kept name can no longer be used: removed, switched off, not
   *  verified, or without a certificate. */
  hostname_unusable?: boolean;
}

export interface HostnameAddressChoice {
  hostname: string;
  base_url: string;
}

export interface HostnameAddressUsesResponse {
  uses: HostnameAddressUseState[];
  /** The names that can be picked — verified, switched on, with a
   *  certificate — own domain first, then the Pro address. */
  choices: HostnameAddressChoice[];
  /** Links opened soon after they are sent — the best address right now, for
   *  a link into the app and for an answer link. Shown, not chosen. */
  links_now: { app: string | null; answers: string | null };
  /** Webhooks set up at their vendor with the current address. If the
   *  webhooks address moves, each stops until it is updated there. */
  registered_webhooks: number;
}

export interface HostnameSetAddressUseRequest {
  use: HostnameAddressUse;
  /** A name from `choices`, or null to go back to automatic. */
  hostname: string | null;
}

export type HostnameOwnershipProofInput =
  | {
      hostname: string;
      method: 'cert_proof';
      cert_matches_hostname: boolean;
    }
  | {
      hostname: string;
      method: 'http_token';
      observed_token_hash: string;
    }
  | {
      hostname: string;
      method: 'dns_txt';
      observed_token_hash: string;
    };

export type HostnameOwnershipProofFailureCode =
  | 'invalid_hostname'
  | 'not_found'
  | 'recued_acme_preverified'
  | 'incompatible_proof_method'
  /** D-235 § 3.2 — `cert_proof` was offered for a hostname the fleet would
   *  ISSUE for. Distinct from `incompatible_proof_method` on purpose: this is
   *  not "that method doesn't apply here", it is "that method is not authority
   *  to mint". Possession of a cert for a name is a fine proof for ADOPTING an
   *  already-issued `byo_uploaded` hostname, but as authority to have the fleet
   *  issue a NEW one it is circular, and a stale or leaked chain carries it. */
  | 'cert_proof_insufficient'
  | 'method_mismatch'
  | 'missing_token_hash';

export type HostnameOwnershipProofResult =
  | {
      ok: true;
      hostname: string;
      method: HostnameVerificationMethod;
      status: Extract<HostnameOwnershipStatus, 'verified' | 'failed'>;
      projection: HostnameProjection;
    }
  | {
      ok: false;
      code: HostnameOwnershipProofFailureCode;
      hostname: string;
      method: HostnameVerificationMethod;
      expected_method?: HostnameVerificationMethod;
      cert_source?: HostnameCertSource;
    };

export const isHostnameCertSource = (value: unknown): value is HostnameCertSource =>
  typeof value === 'string'
  && (HOSTNAME_CERT_SOURCES as readonly string[]).includes(value);

export const isHostnameVerificationMethod = (
  value: unknown,
): value is HostnameVerificationMethod =>
  typeof value === 'string'
  && (HOSTNAME_VERIFICATION_METHODS as readonly string[]).includes(value);

export const isHostnameOwnershipStatus = (
  value: unknown,
): value is HostnameOwnershipStatus =>
  typeof value === 'string'
  && (HOSTNAME_OWNERSHIP_STATUSES as readonly string[]).includes(value);

export const isHostnameTlsTopology = (value: unknown): value is HostnameTlsTopology =>
  typeof value === 'string'
  && (HOSTNAME_TLS_TOPOLOGIES as readonly string[]).includes(value);

export const isHostnameListenerPort = (value: unknown): value is HostnameListenerPort =>
  typeof value === 'number'
  && (HOSTNAME_LISTENER_PORTS as readonly number[]).includes(value);

export const tlsTopologyForHostnameCertSource = (
  certSource: HostnameCertSource,
): HostnameTlsTopology =>
  certSource === 'byo_external' ? 'upstream_terminated' : 'server_terminated';

/** D-176 — is `hostname` a single-label handle subdomain of an ENABLED Pro
 *  DDNS zone, with an RFC-1123-valid label? Used by the registry / poller /
 *  reconciler to gate managed Pro DDNS rows. Zone-agnostic via the DDNS_ZONES
 *  registry: `resolveProDdnsHost` enforces "single-label handle of an enabled
 *  zone"; the regex re-validates the label charset (resolve deliberately does
 *  not — handle charset is a registration-time gate). */
export const isSingleLabelProDdnsHostname = (hostname: string): boolean => {
  const resolved = resolveProDdnsHost(hostname);
  return (
    resolved !== null
    && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(resolved.handle)
  );
};

const hasInvalidHostnameChars = (value: string): boolean =>
  /[\s/:?#\\]/.test(value);

/** Normalize a DNS hostname to lowercase ASCII/punycode. Returns null for
 * inputs that are not bare hostnames (schemes, paths, ports, empty labels,
 * overlong labels, and leading/trailing hyphens are rejected). */
export const normalizeHostname = (input: string): string | null => {
  const trimmed = input.trim().replace(/\.$/, '');
  if (!trimmed || hasInvalidHostnameChars(trimmed)) return null;

  let ascii: string;
  try {
    ascii = new URL(`http://${trimmed}`).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!ascii || ascii.length > 253 || ascii.includes('..')) return null;

  const labels = ascii.split('.');
  if (labels.length < 2) return null;
  for (const label of labels) {
    if (
      label.length === 0
      || label.length > 63
      || label.startsWith('-')
      || label.endsWith('-')
      || !/^[a-z0-9-]+$/.test(label)
    ) {
      return null;
    }
  }
  return ascii;
};

export const projectHostname = (
  row: HostnameStorageRow,
  /** D-235 — needed only to derive `delegation_urgency`; defaults to the wall
   *  clock so every existing caller is unchanged. */
  now: number = Date.now(),
): HostnameProjection => {
  const projection: HostnameProjection = {
    hostname_id: row.hostname_id,
    hostname: row.hostname_normalized,
    cert_source: row.cert_source,
    ownership_status: row.ownership_status,
    listener_ports: row.listener_ports,
    ddns_managed: row.ddns_managed,
    enabled: row.enabled,
    tls_topology: row.tls_topology,
  };
  if (row.cert_fingerprint !== undefined) projection.cert_fingerprint = row.cert_fingerprint;
  // ⚠ Projected UNCONDITIONALLY when present, including 'pending' — the whole
  //   point is that the UI can tell "not tried yet" from "failed, backing off",
  //   which a missing field cannot express.
  if (row.cert_provisioning !== undefined) projection.cert_provisioning = row.cert_provisioning;
  if (row.cert_last_error !== undefined) projection.cert_last_error = row.cert_last_error;
  // D-235 § 5.1 — the delegation triple. `delegation_urgency` is DERIVED here
  // rather than stored: it is a function of the clock, so a persisted copy
  // would be wrong the moment it was written and would need re-deriving on
  // every read anyway. Emitted only when there is something to say, so a row
  // that has never been checked carries no field rather than a cheerful
  // `'none'` it has not earned.
  if (row.delegation_state !== undefined) {
    projection.delegation_state = row.delegation_state;
    const urgency = customDomainDelegationUrgency({
      delegation_state: row.delegation_state,
      cert_expires_at: row.cert_expires_at,
      now,
    });
    if (urgency !== 'none') projection.delegation_urgency = urgency;
  }
  if (row.delegation_checked_at !== undefined) {
    projection.delegation_checked_at = row.delegation_checked_at;
  }
  if (row.cert_expires_at !== undefined) projection.cert_expires_at = row.cert_expires_at;
  if (row.cert_chain_metadata !== undefined) projection.cert_chain_metadata = row.cert_chain_metadata;
  if (row.verification_method !== undefined) projection.verification_method = row.verification_method;
  return projection;
};

export const canBindHostname = (
  row: Pick<HostnameStorageRow, 'enabled' | 'ownership_status' | 'tls_topology'>,
  topology?: HostnameTlsTopology,
): boolean =>
  row.enabled
  && row.ownership_status === 'verified'
  && (topology === undefined || row.tls_topology === topology);
