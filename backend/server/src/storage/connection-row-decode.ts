/** Server-side projection: `ConnectionRow` (persisted) → `ConnectionRecord`
 *  (runtime), tolerant of opaque AEAD-encrypted auth.
 *
 *  When `JSON.parse(row.auth_ciphertext)` throws (the FileVault-
 *  initialised path stores opaque AEAD ciphertext), this helper falls
 *  back to `auth: { type: 'none' }` so the outer record still returns —
 *  the caller surfaces a meaningful error further along (typically
 *  `vendor_auth_expired` from the vendor merger). The legacy /
 *  uninitialised-vault path stores `JSON.stringify(plain)` so the
 *  parse recovers the shape directly.
 *
 *  Returns `null` only when `row.config_json` is malformed — that
 *  field is the one load-bearing decode for callers (vendor mergers
 *  can't do anything useful with a record whose config can't be
 *  parsed). `health_json` absence defaults to
 *  `{ status: 'unknown', last_probed_at: row.updated_at }`.
 *
 *  NOT for use on the proper AEAD-decrypted path — that lives at
 *  `composition/bin/wire-vendor-substrate.ts:lookupConnection` and uses
 *  `decodeAuthFromStorage(keyProvider)` for real decryption. This
 *  helper is the "decode-without-crypto" path used by:
 *
 *    - The upstream-merge driver's rpc deps (`vendorConnectionLookup`
 *      reads server-side outside the rpc handler so the keyProvider
 *      isn't in scope).
 *    - The upstream-merge recovery sweep (boot-time replay; same
 *      reason). */

import type {
  ConnectionAuth,
  ConnectionHealth,
  ConnectionRecord,
  ConnectionRow,
} from '@recued/contracts';
import { parseGrantedScopesJson } from '@recued/contracts';

export const decodeConnectionRow = (
  row: ConnectionRow,
): ConnectionRecord | null => {
  try {
    return {
      kind: row.kind,
      subtype: row.subtype,
      name: row.name,
      display_name: row.display_name,
      publisher_id: row.publisher_id,
      config: JSON.parse(row.config_json) as Record<string, unknown>,
      auth: ((): ConnectionAuth => {
        try {
          return JSON.parse(row.auth_ciphertext) as ConnectionAuth;
        } catch {
          return { type: 'none' as const } satisfies ConnectionAuth;
        }
      })(),
      enrolled_at: row.enrolled_at,
      updated_at: row.updated_at,
      ...(row.last_used_at !== undefined && row.last_used_at !== null
        ? { last_used_at: row.last_used_at }
        : {}),
      ...(row.subresource_path !== undefined && row.subresource_path !== null
        ? { subresource_path: row.subresource_path }
        : {}),
      // granted-scopes — faithful row → record projection (mirrors the view's
      // parse); absent/malformed → omitted so the record matches the row.
      ...((): { granted_scopes?: string[] } => {
        const gs = parseGrantedScopesJson(row.granted_scopes_json);
        return gs !== undefined ? { granted_scopes: gs } : {};
      })(),
      health: row.health_json
        ? (JSON.parse(row.health_json) as ConnectionHealth)
        : { status: 'unknown' as const, last_probed_at: row.updated_at },
    } satisfies ConnectionRecord;
  } catch {
    return null;
  }
};
