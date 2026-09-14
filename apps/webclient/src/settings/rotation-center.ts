/** D-148 § A.11 + § P7 — Settings → Server → Key Health rotation
 *  flow projection.
 *
 *  Rotation buttons live in the per-class panels rendered by
 *  `key-health.ts`. This module is the call-shape projection — the
 *  webclient never runs rotations itself; it dispatches the
 *  `key.rotate.*` rpc + renders the `RotationResult` returned by the
 *  server.
 *
 *  P7 ships the eight rotation kinds as separate dispatch shapes so
 *  the UI can route each button to the right rpc + render the right
 *  follow-up affordance (re-pair prompt for `server_identity`,
 *  ACME-helper-unavailable copy for `tls_renew`, etc.). */

import {
  ROTATION_OPS,
  ROTATION_OP_KEY_CLASS,
  type KeyClass,
  type RotationErrorCode,
  type RotationOp,
  type RotationResult,
} from '@recued/contracts';

/** Per-button dispatch shape. The UI binds one shape to each rotation
 *  button + populates per-context fields (e.g. `client_id` for
 *  bridge/webclient token rotations, `vendor` for webhook secret
 *  rotations). */
export type RotationDispatch =
  | { op: 'master_dek_rotate'; reason?: string }
  | { op: 'server_identity_rotate'; reason?: string }
  | { op: 'publisher_identity_rotate'; reason?: string }
  | { op: 'tls_renew'; reason?: string }
  // D-169 P0 Slice 2B — `webclient_token_rotate` now serves both
  // bridge + webclient paired clients (`client_kind` on the
  // underlying `client_tokens` row distinguishes the kind; the
  // rotation primitive is the same). The selector resolves a single
  // paired-client list regardless of kind.
  | { op: 'webclient_token_rotate'; client_id: string; reason?: string }
  | { op: 'webhook_secret_rotate'; vendor: string; reason?: string }
  | { op: 'mark_compromised'; key_class: KeyClass; reason?: string };

/** Per-op user-facing copy. Used for the confirmation dialog ("This
 *  will…") + the success / failure toast. Kept inside the renderer
 *  so localization is centralised — the substrate never assembles
 *  user-facing strings. */
export const ROTATION_COPY: Record<
  RotationOp,
  { confirm_title: string; confirm_body: string; success_title: string }
> = {
  master_dek_rotate: {
    confirm_title: 'Replace the main key?',
    confirm_body:
      'Everything you have stored will be locked again with a new main key. Recued pauses while it works, and carries on by itself when it is done.',
    success_title: 'Your main key has been replaced.',
  },
  server_identity_rotate: {
    confirm_title: 'Replace the key that proves this is your server?',
    confirm_body:
      'Every device you have paired will have to pair again. Pick a time when that is fine. Until you do it, they will refuse to connect.',
    success_title: 'Done. Pair every device again to get them back.',
  },
  publisher_identity_rotate: {
    confirm_title: 'Replace the key you sign Recipes with?',
    confirm_body:
      'Every recipe you have published will be re-signed under the new publisher identity + re-uploaded to the marketplace. Consumers who pinned the previous publisher_id will see a "publisher key rotated" badge until they accept the new key.',
    success_title: 'Publisher identity rotated. Marketplace will surface the rotated badge.',
  },
  tls_renew: {
    confirm_title: 'Renew the TLS cert?',
    confirm_body:
      'Pro tier triggers Recued gets one for you. Free tier drives certbot/caddy locally. The substrate broadcasts a signed rotation notice so pinned clients accept the new fingerprint without re-pair.',
    success_title: 'TLS cert renewed.',
  },
  // D-169 P0 Slice 2B — single client-token rotation copy covers both
  // bridge + webclient paired clients (the underlying primitive is one
  // store keyed by `client_id` regardless of `client_kind`). Copy
  // widened to say "client" instead of "webclient" so the dialog
  // surfaces correctly when the selected target is a bridge.
  webclient_token_rotate: {
    confirm_title: 'Rotate this client token?',
    confirm_body:
      'The device you picked loses its access and gets a new key. Next time it asks for anything it will be sent back to pairing, so make sure you can reach that device.',
    success_title: 'Client token rotated. Re-pair the client to restore the connection.',
  },
  webhook_secret_rotate: {
    confirm_title: 'Rotate this webhook secret?',
    confirm_body:
      'Any webhook still on its way, signed with the old secret, will be turned away. Put the new secret into the other service as soon as this finishes, so nothing is missed.',
    success_title: 'The webhook secret is swapped. Put the new one into the other service.',
  },
  mark_compromised: {
    confirm_title: 'Mark this key class as compromised?',
    confirm_body:
      'The substrate will record the compromise + trigger immediate rotation of the affected class + every dependent class. This is the incident-response path — only continue if you believe the key has been exposed.',
    success_title: 'Compromise recorded + cascade rotation initiated.',
  },
};

/** Per-error remediation copy. Maps the closed-list `RotationErrorCode`
 *  to a user-actionable hint. */
export const ROTATION_ERROR_COPY: Record<RotationErrorCode, string> = {
  op_unknown: 'Unknown rotation op. Refresh the page + try again.',
  key_class_mismatch: 'The selected button does not match the target key class. Refresh the page.',
  key_not_loaded:
    'The key is not loaded on this server. Restart the server or run the boot diagnostic.',
  rotation_in_progress:
    'A rotation for this key is already running. Wait for it to complete + retry.',
  compromise_already_recorded:
    'This key class is already marked compromised. Run a per-class rotation directly (instead of re-marking compromise) to cascade dependents.',
  acme_helper_unavailable:
    'ACME helper is unreachable. Check Settings → Server → Pro DDNS, or fall back to the local certbot/caddy hook.',
  subscription_required:
    'You need Pro for the cloud to get certificates for you. Use your own certbot or caddy instead, or move to Pro.',
  target_not_found: 'No client/vendor matched the rotation target. Refresh the panel + retry.',
  database_rekey_unsupported:
    'This build cannot rotate the master key: your realm database is encrypted from it, and rotating without re-keying the database would leave it unreadable by both your keyfile and your recovery key. Nothing was changed.',
  forbidden: 'You do not have permission to rotate this key. Sign in as the owning admin.',
  unsigned_notice:
    'A message about swapping your certificate arrived unsigned, so Recued threw it away. Look in Settings, then Server, then Reachability.',
  storage_io_error:
    'Recued could not save the new key. Check there is room on the disk, and that it is allowed to write there.',
  // ⛔ SAY "NOTHING IS WRONG" FIRST. Every other line here describes a fault
  //    the operator must go fix; these two describe a healthy server
  //    declining to spend certificate quota. Copy that opened with the
  //    failure would send someone debugging a system that is working.
  renew_cooldown:
    'A certificate renewal already ran recently, so this one was skipped — nothing is wrong. Certificates are renewed automatically well before they expire; renewing again now would spend your issuer\'s duplicate-certificate allowance without changing anything.',
  renew_rate_limited:
    'This server has issued as many certificates as it is allowed today, so the request was declined before reaching the certificate authority. The allowance resets 24 hours after the first issuance in the current window. Your existing certificate is untouched and still valid.',
};

/** Build the dispatch payload for a confirmation flow. The UI calls
 *  this on button-click → presents the `ROTATION_COPY` dialog →
 *  on confirm calls `key.rotate.<op>` rpc with the result of this
 *  function as the body. */
export const buildRotationDispatch = (
  args:
    | { op: 'master_dek_rotate'; reason?: string }
    | { op: 'server_identity_rotate'; reason?: string }
    | { op: 'publisher_identity_rotate'; reason?: string }
    | { op: 'tls_renew'; reason?: string }
    | { op: 'webclient_token_rotate'; client_id: string; reason?: string }
    | { op: 'webhook_secret_rotate'; vendor: string; reason?: string }
    | { op: 'mark_compromised'; key_class: KeyClass; reason?: string },
): RotationDispatch => args;

/** True when this rotation result requires a follow-up "re-pair" affordance
 *  on the relevant client surface. */
export const requiresRepairFollowup = (result: RotationResult): boolean => {
  if (!result.ok) return false;
  return Boolean(result.repair_client_ids && result.repair_client_ids.length > 0);
};

/** True when the result represents a successful TLS rotation; the UI
 *  refreshes the cert fingerprint + the Reachability Doctor's TLS row. */
export const isTlsRotationSuccess = (result: RotationResult): boolean =>
  result.ok && result.op === 'tls_renew';

/** Map a rotation result to the toast severity the UI should render. */
export const severityForResult = (
  result: RotationResult,
): 'info' | 'success' | 'warning' | 'error' => {
  if (!result.ok) return 'error';
  if (result.op === 'mark_compromised') return 'warning';
  return 'success';
};

/** Closed-list registry for the UI to iterate when rendering the
 *  rotation buttons. Each row carries the op + the targeted key class
 *  + a "selector" hint enumerating the per-context selector shape. */
export const ROTATION_BUTTON_REGISTRY: ReadonlyArray<{
  op: RotationOp;
  key_class: KeyClass | 'any';
  // D-169 P0 Slice 2B — `'client_id'` replaces `'bridge_client_id'` +
  // `'webclient_client_id'`. The UI dropdown for the unified
  // `webclient_token_rotate` op lists every paired client regardless
  // of `client_kind`; the selector enum collapses to a single value.
  selector: 'none' | 'client_id' | 'webhook_vendor' | 'key_class';
}> = ROTATION_OPS.map((op) => {
  if (op === 'mark_compromised') return { op, key_class: 'any', selector: 'key_class' as const };
  if (op === 'webclient_token_rotate') {
    return { op, key_class: ROTATION_OP_KEY_CLASS[op], selector: 'client_id' as const };
  }
  if (op === 'webhook_secret_rotate') {
    return { op, key_class: ROTATION_OP_KEY_CLASS[op], selector: 'webhook_vendor' as const };
  }
  return { op, key_class: ROTATION_OP_KEY_CLASS[op], selector: 'none' as const };
});
