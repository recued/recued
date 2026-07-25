/** D-148 § A.4 + § A.9 + § P8 — Settings → Account → Passport
 *  renderer.
 *
 *  Surfaces:
 *    - Profile picker (`support_redacted` default; `enterprise_audit`
 *      and `migration_full` require an explicit click + confirmation
 *      dialog naming the surfaces being exposed)
 *    - Free-text reason field (carried in the audit row)
 *    - Export button → triggers `passport.export` rpc → server signs
 *      + audits + returns the projection
 *    - Import affordance → upload `migration_full` JSON; preview the
 *      identity bundle before confirming the migration rpc
 *    - History list (read-only; surfaced via `passport.history.list`
 *      rpc backed by the audit log)
 *
 *  This module is pure projection + validation; the server runs the
 *  cryptographic substrate. The webclient never holds the
 *  server_identity_key.
 */

import {
  SERVER_PASSPORT_PROFILES,
  SERVER_PASSPORT_VERSION,
  type ServerPassportExportOptions,
  type ServerPassportImportCommitResult,
  type ServerPassportProfile,
  type ServerPassportProjection,
} from '@recued/contracts';

// ────────────────────────────────────────────────────────────────
// Profile picker
// ────────────────────────────────────────────────────────────────

export interface PassportProfileOption {
  profile: ServerPassportProfile;
  /** Short label rendered in the picker (e.g., "Support" /
   *  "Enterprise audit" / "Migration"). */
  label: string;
  /** Long description surfaced in the confirmation dialog when the
   *  user picks this profile. Names every surface exposed at this
   *  redaction level so the user knows what they're sharing. */
  exposes: string[];
  /** True iff the profile requires an explicit confirmation dialog
   *  (set for everything except `support_redacted` which is the
   *  default). */
  requires_confirmation: boolean;
}

export const PASSPORT_PROFILE_OPTIONS: ReadonlyArray<PassportProfileOption> = [
  {
    profile: 'support_redacted',
    label: 'Support (redacted)',
    exposes: [
      'Server identity fingerprint',
      'Current handle',
      'Software version + OS + arch',
      'Per-port public/lan/off booleans',
      'Per-key-class status badges (no fingerprints)',
    ],
    requires_confirmation: false,
  },
  {
    profile: 'enterprise_audit',
    label: 'Enterprise audit',
    exposes: [
      'Full identity bundle (server + publisher fingerprints)',
      'LAN URLs + per-port port numbers',
      'Per-client paired_at + last_seen_at + labels',
      'Installed pack list + per-vendor entity counts',
      'Backup location + recovery state',
      'Per-key-class fingerprints + last_rotated_at',
    ],
    requires_confirmation: true,
  },
  {
    profile: 'migration_full',
    label: 'Migration (new server)',
    exposes: [
      'Everything in the enterprise-audit profile',
      'Handle history with reservation + release timestamps',
      'Publisher identity fingerprint',
      'Capability profile (recipe counts, AI pool config, BYOK slots)',
    ],
    requires_confirmation: true,
  },
];

export const findPassportProfileOption = (
  profile: ServerPassportProfile,
): PassportProfileOption | undefined =>
  PASSPORT_PROFILE_OPTIONS.find((o) => o.profile === profile);

// ────────────────────────────────────────────────────────────────
// Export evaluation
// ────────────────────────────────────────────────────────────────

export type PassportExportEvaluation =
  | { ok: true; options: ServerPassportExportOptions }
  | { ok: false; error: PassportExportError };

export type PassportExportError =
  | 'profile_unknown'
  | 'reason_too_long'
  | 'confirmation_required';

export interface EvaluatePassportExportArgs {
  profile: ServerPassportProfile;
  reason?: string;
  /** True when the user has clicked-through the confirmation dialog
   *  for `enterprise_audit` / `migration_full`. */
  user_confirmed: boolean;
}

const PASSPORT_REASON_MAX_BYTES = 1024;

export const evaluatePassportExport = (
  args: EvaluatePassportExportArgs,
): PassportExportEvaluation => {
  if (
    !(SERVER_PASSPORT_PROFILES as ReadonlyArray<ServerPassportProfile>).includes(args.profile)
  ) {
    return { ok: false, error: 'profile_unknown' };
  }
  const opt = findPassportProfileOption(args.profile);
  if (!opt) return { ok: false, error: 'profile_unknown' };
  if (opt.requires_confirmation && !args.user_confirmed) {
    return { ok: false, error: 'confirmation_required' };
  }
  // `TextEncoder`, not `Buffer` — this module runs in the browser bundle
  // (esbuild `platform: 'browser'`, no Buffer shim), and the R26.4 Delta 2
  // passport panel drives this with a user-typed reason. `Buffer` is
  // undefined there; `TextEncoder().encode().byteLength` is the portable
  // UTF-8 byte count (identical to the server's `Buffer.byteLength`).
  if (
    args.reason !== undefined &&
    new TextEncoder().encode(args.reason).byteLength > PASSPORT_REASON_MAX_BYTES
  ) {
    return { ok: false, error: 'reason_too_long' };
  }
  return {
    ok: true,
    options: {
      profile: args.profile,
      ...(args.reason !== undefined ? { reason: args.reason } : {}),
    },
  };
};

// ────────────────────────────────────────────────────────────────
// Import preview
// ────────────────────────────────────────────────────────────────

export interface PassportImportPreview {
  ok: boolean;
  /** When ok=true, the metadata the user inspects before confirming.
   *  When ok=false, the `error` field surfaces the rejection. */
  current_handle?: string;
  publisher_id?: string;
  publisher_identity_fingerprint?: string;
  exported_at?: number;
  signer_fingerprint?: string;
  /** Count of historical handles the migration will carry forward. */
  handle_history_count?: number;
  error?:
    | 'invalid_json'
    | 'profile_not_migration_full'
    | 'unsupported_passport_version'
    | 'identity_block_incomplete';
}

/** Pre-flight inspection of an uploaded passport JSON file. The
 *  webclient surfaces the metadata to the user; on confirmation the
 *  rpc dispatches `passport.import` to the server, which re-verifies
 *  the signature against the embedded public key and stamps the
 *  imported identity onto the new server's local key store. */
export const inspectImportedPassport = (
  raw: string,
): PassportImportPreview => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'invalid_json' };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'invalid_json' };
  }
  const p = parsed as Partial<ServerPassportProjection> & Record<string, unknown>;
  if (p.passport_version !== SERVER_PASSPORT_VERSION) {
    return { ok: false, error: 'unsupported_passport_version' };
  }
  if (p.profile !== 'migration_full') {
    return { ok: false, error: 'profile_not_migration_full' };
  }
  const identity = p.identity as Record<string, unknown> | undefined;
  if (
    !identity ||
    typeof identity['current_handle'] !== 'string' ||
    typeof identity['publisher_id'] !== 'string' ||
    typeof identity['publisher_identity_fingerprint'] !== 'string' ||
    typeof identity['server_identity_fingerprint'] !== 'string'
  ) {
    return { ok: false, error: 'identity_block_incomplete' };
  }
  const handleHistory = identity['handle_history'];
  if (!Array.isArray(handleHistory)) {
    return { ok: false, error: 'identity_block_incomplete' };
  }
  return {
    ok: true,
    current_handle: identity['current_handle'] as string,
    publisher_id: identity['publisher_id'] as string,
    publisher_identity_fingerprint: identity['publisher_identity_fingerprint'] as string,
    exported_at: typeof p.exported_at === 'number' ? p.exported_at : undefined,
    signer_fingerprint: identity['server_identity_fingerprint'] as string,
    handle_history_count: handleHistory.length,
  };
};

/** The full set of import-rejection reasons surfaced to the user — the
 *  client-side preview errors (`inspectImportedPassport`) plus the
 *  authoritative server-side commit reasons (`passport.import`). The server
 *  re-verifies, so its reasons (signature / fingerprint binding / same
 *  identity) are the trust-bearing ones; the client errors are the
 *  fail-fast pre-flight. */
export type PassportImportFailureReason =
  | NonNullable<PassportImportPreview['error']>
  | Extract<ServerPassportImportCommitResult, { ok: false }>['reason'];

/** Map an import-rejection reason to a single human-readable line. Centralizes
 *  the copy so the panel renders one consistent message whether the rejection
 *  came from the client preview or the server commit. */
export const describeImportFailure = (
  reason: PassportImportFailureReason,
): string => {
  switch (reason) {
    case 'invalid_json':
      return 'That doesn’t look like a valid passport file (couldn’t parse the JSON).';
    case 'profile_not_migration_full':
      return 'That passport isn’t a “Migration (new server)” export. Re-export it from the old server with the migration profile.';
    case 'unsupported_passport_version':
      return 'That passport was produced by an incompatible Recued version.';
    case 'identity_block_incomplete':
      return 'That passport is missing required identity fields and can’t be imported.';
    case 'identity_block_missing_public_key':
      return 'That passport has no server public key, so its identity can’t be verified.';
    case 'identity_fingerprint_mismatch':
      return 'That passport’s claimed identity doesn’t match the key that signed it — it may be forged or corrupted.';
    case 'signature_missing':
    case 'signature_malformed':
    case 'signature_invalid':
      return 'That passport’s signature didn’t verify — it may have been tampered with.';
    case 'profile_unknown':
      return 'That passport has an unrecognized profile.';
    case 'same_identity':
      return 'That passport already describes THIS server — there’s nothing to migrate.';
    default:
      return 'That passport couldn’t be imported.';
  }
};

/** Build the human-readable summary lines for a successful import commit. The
 *  recorded identity is the cryptographically-VERIFIED fingerprint (see the
 *  `passport.import` substrate), so these lines reflect a proven lineage. */
export const summarizeImportCommit = (
  result: Extract<ServerPassportImportCommitResult, { ok: true }>,
): string[] => {
  const lines = [
    `Previous server identity: ${result.previous_publisher_id}`,
    `This server’s identity: ${result.new_publisher_id}`,
  ];
  lines.push(
    result.current_handle
      ? `Handle “${result.current_handle}” — re-anchor ${result.handle_reanchor_pending ? 'pending (completes once this server’s account is bound)' : 'complete'}.`
      : 'No handle to carry forward.',
  );
  lines.push(
    `Recorded ${result.handle_history_count} prior handle${result.handle_history_count === 1 ? '' : 's'} in the lineage.`,
  );
  return lines;
};

// ────────────────────────────────────────────────────────────────
// History list display
// ────────────────────────────────────────────────────────────────

export interface PassportHistoryDisplayRow {
  passport_id: string;
  profile: ServerPassportProfile;
  exported_at: number;
  exported_by_client_id: string;
  reason?: string;
  signer_fingerprint: string;
  /** True iff the row's signer fingerprint differs from the server's
   *  current identity fingerprint — flags rows minted by a key
   *  rotation predecessor (still verifiable but worth surfacing). */
  signer_pre_rotation?: boolean;
}

export interface BuildHistoryDisplayArgs {
  rows: ReadonlyArray<{
    passport_id: string;
    profile: ServerPassportProfile;
    exported_at: number;
    exported_by_client_id: string;
    reason?: string;
    signer_fingerprint: string;
  }>;
  current_signer_fingerprint?: string;
}

export const buildPassportHistoryDisplay = (
  args: BuildHistoryDisplayArgs,
): PassportHistoryDisplayRow[] =>
  args.rows
    .map((r): PassportHistoryDisplayRow => {
      const row: PassportHistoryDisplayRow = {
        passport_id: r.passport_id,
        profile: r.profile,
        exported_at: r.exported_at,
        exported_by_client_id: r.exported_by_client_id,
        signer_fingerprint: r.signer_fingerprint,
      };
      if (r.reason !== undefined) row.reason = r.reason;
      if (
        args.current_signer_fingerprint !== undefined &&
        r.signer_fingerprint !== args.current_signer_fingerprint
      ) {
        row.signer_pre_rotation = true;
      }
      return row;
    })
    .sort((a, b) => b.exported_at - a.exported_at);
