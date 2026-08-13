/** D-148 § A.9 — Server Passport.
 *
 *  Exportable signed JSON identity bundle. Used for migration,
 *  debugging, and enterprise audit. Three explicit redaction
 *  profiles with the signature committing to the projection — a
 *  verifier knows it's looking at a `support_redacted` view because
 *  the signature commits to that exact shape.
 *
 *  P1 ships the contract types + canonical-JSON serializer + the
 *  per-profile projection helper. P8 wires the export rpc + import
 *  flow + handle history + audit row.
 *
 *  Why three profiles. The full passport carries metadata that is
 *  sensitive even though it doesn't include warehouse content — LAN
 *  URLs, client labels, installed packs, connections, backup
 *  location, key-health summary. A user sharing their passport for
 *  routine support shouldn't expose all of this. The redacted
 *  default is for support tickets; `enterprise_audit` is for SOC2 /
 *  ISO27001 audits under NDA; `migration_full` is for moving a
 *  server to a new VPS / hardware.
 */

import type {
  DerivedPresetLabel,
  PathResolution,
  PathRole,
  PublicMcpAcknowledgement,
} from './network.js';
import { KEY_CLASSES } from './keys.js';
import type { KeyClass, KeyHealthBundle } from './keys.js';
import { totalRecord } from './total-record.js';
import type { ReceptionEndpointKind } from './reception.js';

/** D-148 § A.9 — closed list of passport export profiles. */
export type ServerPassportProfile = 'support_redacted' | 'enterprise_audit' | 'migration_full';

export const SERVER_PASSPORT_PROFILES: ReadonlyArray<ServerPassportProfile> = [
  'support_redacted',
  'enterprise_audit',
  'migration_full',
] as const;

/** D-148 § A.9 — passport version. Bumped only when the canonical
 *  JSON shape changes in a way that invalidates prior signatures. */
export const SERVER_PASSPORT_VERSION = '1' as const;

export interface ServerPassportIdentityBlock {
  server_public_key: string;
  server_identity_fingerprint: string;
  publisher_id: string;
  current_handle: string;
  handle_history: Array<{
    handle: string;
    reserved_at: number;
    released_at?: number;
  }>;
  publisher_identity_fingerprint: string;
}

/** D-148 § A.9 + D-149 § A.7 — per-path passport entry (Amendment
 *  2026-05-11; supersedes the per-port shape). The base shape carries
 *  the path resolution (lan + public bits) for every role; the Reception
 *  entry adds `enabled_endpoint_count` + `enabled_endpoint_kinds` so a
 *  recipient of the passport can read the surface-area summary without
 *  rendering the per-endpoint registry (the registry stays server-
 *  internal per Must Hold I-15). The extras are optional on the type
 *  so the WS / Webhooks / MCP / Health rows leave them undefined; the
 *  projection helper strips them in `support_redacted` and preserves
 *  them in `enterprise_audit` / `migration_full`. */
export interface ServerPassportPathEntry {
  resolution: PathResolution;
  /** D-149 § A.7 — count of enabled Reception endpoints. Populated
   *  only on the `reception` entry; undefined on every other role. */
  enabled_endpoint_count?: number;
  /** D-149 § A.7 — closed list of Reception endpoint kinds the
   *  user has at least one enabled endpoint for. Populated only on
   *  the `reception` entry. */
  enabled_endpoint_kinds?: ReadonlyArray<ReceptionEndpointKind>;
}

export interface ServerPassportNetworkBlock {
  /** Detected LAN bind addresses. Redacted in `support_redacted`. */
  lan_urls: string[];
  /** `<handle>.recued.cloud` — present only when Pro subscription
   *  active. */
  ddns_handle?: string;
  ddns_provider?: string;
  cert_fingerprint: string;
  cert_expires_at: number;
  /** Recomputed UI label — `'lan_only' | 'public' | 'maintenance' |
   *  'custom'`. Carried alongside the per-path map so passport
   *  recipients can render the canonical "matches preset X" badge
   *  without re-deriving it. */
  derived_preset_label: DerivedPresetLabel;
  /** Public-MCP acknowledgement snapshot. Carried verbatim so the
   *  audit / migration consumers see exactly which gesture (free-text
   *  phrase included) unlocked the public-MCP path. */
  public_mcp_acknowledgement: PublicMcpAcknowledgement;
  /** Per-path resolved state. `support_redacted` ships only the
   *  resolution bits; full profiles ship the reception extras + the
   *  full ack record. */
  per_path: Record<PathRole, ServerPassportPathEntry>;
}

export interface ServerPassportClientEntry {
  client_id: string;
  client_kind: 'bridge' | 'webclient' | 'cli';
  client_label?: string;
  paired_at: number;
  last_seen_at?: number;
  revoked_at?: number;
}

export interface ServerCapabilityProfile {
  software_version: string;
  os: string;
  arch: string;
  storage_size_bytes: number;
  ai_pool_configured: boolean;
  /** 0, 1, or 2. */
  byok_slots_configured: number;
  scheduled_recipes_count: number;
  reactive_recipes_count: number;
  installed_packs: string[];
  connections: Array<{ vendor: string; entity_count: number }>;
}

export interface ServerPassportRecoveryBlock {
  backup_status: 'configured' | 'unconfigured' | 'overdue';
  last_backup_at?: number;
  /** e.g. 's3://...' or 'local'. Redacted in `support_redacted`. */
  backup_location?: string;
  filevault_recovery_key_status: 'present' | 'absent';
}

export interface ServerPassport {
  passport_version: typeof SERVER_PASSPORT_VERSION;
  passport_id: string;
  profile: ServerPassportProfile;
  exported_at: number;
  exported_by_client_id: string;
  reason?: string;
  identity: ServerPassportIdentityBlock;
  network: ServerPassportNetworkBlock;
  clients: ServerPassportClientEntry[];
  capabilities: ServerCapabilityProfile;
  recovery: ServerPassportRecoveryBlock;
  key_health: KeyHealthBundle;
  /** Ed25519 signature over canonical JSON of the entire passport
   *  EXCLUDING this field. Signature commits to the `profile` value
   *  + the projection — substituting profile name without re-signing
   *  fails verification. */
  signature: string;
}

/** D-148 § A.9 — export options surfaced to the user at export time. */
export interface ServerPassportExportOptions {
  profile: ServerPassportProfile;
  reason?: string;
}

/** Max byte length of the user-supplied export reason (carried verbatim
 *  into the `passport.exported` audit row). Enforced on BOTH the client
 *  (clearer pre-flight error) and the server (`passport.export` rpc, the
 *  trust boundary). */
export const PASSPORT_REASON_MAX_BYTES = 1024;

/** R26.4 Delta 2 — one row of the passport export history. Denormalized
 *  from the `passport.exported` audit ledger into a queryable cache so
 *  Settings → Backup & Recovery can render the list without re-parsing
 *  audit detail. Carried by the `passport.history.list` rpc. */
export interface ServerPassportHistoryEntry {
  passport_id: string;
  profile: ServerPassportProfile;
  exported_at: number;
  exported_by_client_id: string;
  reason?: string;
  /** Fingerprint of the `server_identity_key` that signed this export.
   *  Differs from the server's current fingerprint when the row was
   *  minted by a pre-rotation key — the UI flags those. */
  signer_fingerprint: string;
}

/** R26.4 Delta 2 — `passport.history.list` rpc args. Newest-first,
 *  capped page with an optional `before` cursor (exported_at). */
export interface ServerPassportHistoryListArgs {
  /** Page size. Server clamps to a sane ceiling. */
  limit?: number;
  /** Return only rows with `exported_at < before` (cursor pagination). */
  before?: number;
}

/** R26.4 Delta 5 (D-148 § A.9 import half) — `passport.import` rpc result.
 *
 *  The COMMIT half of passport migration (model A, owner-ratified
 *  2026-06-25): re-verify a `migration_full` passport on the NEW server and
 *  record a high-assurance `passport.imported` provenance row binding the
 *  old identity → the new (live) identity. Under the D-175 identity contract
 *  `publisher_id == server_fingerprint == publisher_identity_fingerprint`, a
 *  fresh server legitimately mints a NEW publisher_id; this result surfaces
 *  the old → new linkage the operator confirms.
 *
 *  Import deliberately does NOT touch the cloud handle reservation — the
 *  pro-convenience provisioner (`handle-provisioner.ts`, account-binding-
 *  driven, idempotent) already owns the `reReserve` re-anchor. `handle_
 *  reanchor_pending` reports whether that re-anchor is still outstanding
 *  (the live handle state's `publisher_id` ≠ the new fingerprint) so the
 *  caller can surface "your handle will re-anchor once your account is
 *  bound" without duplicating the provisioner's cloud path. */
export type ServerPassportImportCommitResult =
  | {
      ok: true;
      /** `passport_id` of the imported bundle (audit `target`). */
      passport_id: string;
      /** Old server identity = the `server_identity_fingerprint` VERIFIED
       *  against the signing key (== old `publisher_id` under D-175). The raw
       *  `publisher_id` field is never recorded — only this cryptographically-
       *  bound fingerprint, so a forged claim can't taint the provenance. */
      previous_publisher_id: string;
      /** Same verified fingerprint, under the `server_fingerprint` name (the
       *  two are equal by the D-175 contract; both bound to the signing key). */
      previous_server_fingerprint: string;
      /** Live server fingerprint = the new `publisher_id` after migration. */
      new_publisher_id: string;
      /** Handle carried in the imported passport (provenance only — import
       *  does not claim it cloud-side). */
      current_handle: string;
      /** Length of the imported `handle_history` (recorded in the audit
       *  detail; not seeded into the live handle store in this slice). */
      handle_history_count: number;
      /** Old server's `publisher_identity_fingerprint` (== publisher_id
       *  under D-175; carried verbatim for pre-D-175 passports). */
      publisher_identity_fingerprint: string;
      /** True iff the provisioner-owned cloud handle re-anchor is still
       *  pending (live handle state's publisher_id ≠ new fingerprint AND a
       *  handle is held). False when already re-anchored or no handle. */
      handle_reanchor_pending: boolean;
    }
  | {
      ok: false;
      /** Verification / narrowing failure (mirrors the server-side preview
       *  reasons) plus `same_identity` (the passport already describes THIS
       *  live identity — nothing to migrate from). */
      reason:
        | 'profile_not_migration_full'
        | 'signature_missing'
        | 'signature_malformed'
        | 'signature_invalid'
        | 'identity_block_missing_public_key'
        | 'profile_unknown'
        | 'identity_block_incomplete'
        | 'identity_fingerprint_mismatch'
        | 'unsupported_passport_version'
        | 'same_identity';
    };

/** Coarse summary of `client_kind` counts. Used by `support_redacted`
 *  in place of the per-client array. */
export interface ServerPassportClientSummary {
  bridge_count: number;
  webclient_count: number;
  cli_count: number;
}

/** D-148 § A.9 — `support_redacted` projection of capabilities.
 *  Spec table line 1051: keep software_version + os + arch +
 *  pack count + connection count by vendor; drop per-pack list +
 *  per-vendor entity counts + storage_size_bytes +
 *  ai_pool_configured + byok_slots_configured + scheduled/reactive
 *  recipe counts. The `connections_by_vendor` shape reports the
 *  vendor names + how many connections of each, but NOT the
 *  per-vendor entity counts. */
export interface ServerCapabilityProfileRedacted {
  software_version: string;
  os: string;
  arch: string;
  installed_pack_count: number;
  /** Vendor-grouped connection counts. Each row is a single vendor
   *  + the number of distinct connections of that vendor. Per-vendor
   *  entity counts are explicitly stripped. */
  connections_by_vendor: Array<{ vendor: string; count: number }>;
}

/** D-148 § A.9 — `support_redacted` projection of recovery block.
 *  Drops `backup_location` (sensitive). */
export interface ServerPassportRecoveryRedacted {
  backup_status: 'configured' | 'unconfigured' | 'overdue';
  filevault_recovery_key_status: 'present' | 'absent';
}

/** Per-key class status booleans only. Used by `support_redacted`. */
export type KeyHealthBundleRedacted = Record<
  KeyClass,
  { status: 'healthy' | 'warning' | 'overdue' }
>;

/** D-148 § A.9 — full shape of a `support_redacted` passport. Note:
 *  this is the SHIPPING shape — what gets serialized + signed.
 *  Switching profile to `enterprise_audit` or `migration_full` ships
 *  the corresponding wider shape (the unprojected `ServerPassport`).
 *  Signature commits to the projection so `support_redacted` cannot
 *  be promoted without re-signing. */
export interface ServerPassportSupportRedacted {
  passport_version: typeof SERVER_PASSPORT_VERSION;
  passport_id: string;
  profile: 'support_redacted';
  exported_at: number;
  exported_by_client_id: string;
  reason?: string;
  identity: {
    server_public_key: string;
    server_identity_fingerprint: string;
    current_handle: string;
  };
  network: {
    ddns_handle?: string;
    cert_fingerprint: string;
    cert_expires_at: number;
    /** Recomputed UI label only. Per-path bits coarsen below. */
    derived_preset_label: DerivedPresetLabel;
    /** Acknowledgement boolean only — free-text phrase is stripped
     *  in `support_redacted` (the full phrase ships only in
     *  `enterprise_audit` / `migration_full`). */
    public_mcp_acknowledged: boolean;
    per_path: Record<PathRole, { resolution: PathResolution }>;
  };
  clients: ServerPassportClientSummary;
  capabilities: ServerCapabilityProfileRedacted;
  recovery: ServerPassportRecoveryRedacted;
  key_health: KeyHealthBundleRedacted;
  signature: string;
}

/** Export shape — the runtime returns one of these three projections.
 *  Each projection is signed AFTER projection (signature commits to
 *  the projection per § A.9 line 1059). The unprojected source
 *  shape's signature MUST be stripped before re-signing. */
export type ServerPassportProjection =
  | ServerPassportSupportRedacted
  | (Omit<ServerPassport, 'signature'> & { profile: 'enterprise_audit'; signature: string })
  | (Omit<ServerPassport, 'signature'> & { profile: 'migration_full'; signature: string });

/** Project the full passport into the requested profile. The
 *  caller MUST re-sign the returned shape with `server_identity_key`
 *  before shipping; this function returns the unsigned projection
 *  payload. The original passport's `signature` is stripped on every
 *  projection — including `enterprise_audit` and `migration_full` —
 *  because the spec requires the signature to commit to the exact
 *  projection bytes (Codex P1 #4 fold). P8 wires the caller. */
export const projectServerPassport = (
  full: ServerPassport,
  profile: ServerPassportProfile,
): Omit<ServerPassportProjection, 'signature'> => {
  if (profile === 'enterprise_audit') {
    const { signature: _drop, ...rest } = full;
    return { ...rest, profile: 'enterprise_audit' as const };
  }
  if (profile === 'migration_full') {
    const { signature: _drop, ...rest } = full;
    return { ...rest, profile: 'migration_full' as const };
  }
  // support_redacted — coarsen everything sensitive.
  const counts: ServerPassportClientSummary = {
    bridge_count: 0,
    webclient_count: 0,
    cli_count: 0,
  };
  for (const c of full.clients) {
    if (c.client_kind === 'bridge') counts.bridge_count++;
    else if (c.client_kind === 'webclient') counts.webclient_count++;
    else if (c.client_kind === 'cli') counts.cli_count++;
  }
  const network: ServerPassportSupportRedacted['network'] = {
    cert_fingerprint: full.network.cert_fingerprint,
    cert_expires_at: full.network.cert_expires_at,
    derived_preset_label: full.network.derived_preset_label,
    public_mcp_acknowledged: full.network.public_mcp_acknowledgement.acknowledged,
    // D-149 § A.7 — `support_redacted` strips the Reception extras
    // (`enabled_endpoint_count` + `enabled_endpoint_kinds`). The
    // recipient sees only the per-path resolution bits (lan + public);
    // surface-area + free-text ack phrase are gated to
    // `enterprise_audit` / `migration_full`.
    per_path: Object.fromEntries(
      Object.entries(full.network.per_path).map(([role, entry]) => [
        role,
        { resolution: { lan: entry.resolution.lan, public: entry.resolution.public } },
      ]),
    ) as Record<PathRole, { resolution: PathResolution }>,
  };
  if (full.network.ddns_handle !== undefined) {
    network.ddns_handle = full.network.ddns_handle;
  }
  // Aggregate connections-by-vendor: collapse the per-connection
  // entity counts into vendor-only counts. Entity counts are
  // explicitly stripped per spec § A.9 line 1051.
  const vendor_counts = new Map<string, number>();
  for (const c of full.capabilities.connections) {
    vendor_counts.set(c.vendor, (vendor_counts.get(c.vendor) ?? 0) + 1);
  }
  const connections_by_vendor = [...vendor_counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([vendor, count]) => ({ vendor, count }));
  const capabilities: ServerCapabilityProfileRedacted = {
    software_version: full.capabilities.software_version,
    os: full.capabilities.os,
    arch: full.capabilities.arch,
    installed_pack_count: full.capabilities.installed_packs.length,
    connections_by_vendor,
  };
  const recovery: ServerPassportRecoveryRedacted = {
    backup_status: full.recovery.backup_status,
    filevault_recovery_key_status: full.recovery.filevault_recovery_key_status,
  };
  // Walks KEY_CLASSES rather than the input's own keys: `KeyHealthBundle` is
  // total by type AND by production (`loadKeyHealth` returns all seven), so the
  // redacted projection is total too — no `{} as KeyHealthBundleRedacted`
  // asserting keys nobody filled.
  const key_health = totalRecord(KEY_CLASSES, (cls) => ({
    status: full.key_health[cls].status,
  }));
  const projection: Omit<ServerPassportSupportRedacted, 'signature'> = {
    passport_version: full.passport_version,
    passport_id: full.passport_id,
    profile: 'support_redacted',
    exported_at: full.exported_at,
    exported_by_client_id: full.exported_by_client_id,
    identity: {
      server_public_key: full.identity.server_public_key,
      server_identity_fingerprint: full.identity.server_identity_fingerprint,
      current_handle: full.identity.current_handle,
    },
    network,
    clients: counts,
    capabilities,
    recovery,
    key_health,
  };
  if (full.reason !== undefined) projection.reason = full.reason;
  return projection;
};

/** Canonical JSON serializer for passport content. Stable
 *  round-trip across two serializations; lexicographic key order at
 *  every nesting level; no trailing whitespace. The signature
 *  covers `canonicalPassportJSON(payload_without_signature)`.
 *
 *  Re-exported from `@recued/crypto/canonical-json` as the
 *  STRICT variant — passport content is well-typed, so any non-finite
 *  number / bigint / function / symbol value indicates a programming
 *  error and should throw rather than coerce silently. Byte-identical
 *  to the lenient variant for all JSON-clean inputs.
 *
 *  Prior to this consolidation contracts carried its own copy that
 *  drifted from @recued/crypto's lenient variant — same algorithm,
 *  different edge-case handling. Centralizing on one implementation
 *  with a `strict` flag eliminates the divergence class. */
import { canonicalJSONStringifyStrict } from '@recued/crypto/canonical-json';
export const canonicalJSONStringify = canonicalJSONStringifyStrict;

/** Strip `signature` from a passport for serialization-before-sign.
 *  Verifier reads the signature, removes it, canonical-JSON the rest,
 *  and Ed25519-verifies the signature against the
 *  `identity.server_public_key`. */
export const stripPassportSignature = <T extends { signature: string }>(
  passport: T,
): Omit<T, 'signature'> => {
  const { signature: _drop, ...rest } = passport;
  return rest;
};

/** Compute the canonical signing payload for a passport. */
export const canonicalPassportSigningPayload = <T extends { signature: string }>(
  passport: T,
): string => canonicalJSONStringify(stripPassportSignature(passport));
