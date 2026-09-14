/** D-148 § A.7.3 — Settings → Server → Exposure page renderer (W3.8).
 *
 *  The W3.5 module shipped the pure switcher model + transition pre-
 *  flight checks. W3.8 layers the full page-model on top:
 *
 *    - **Preset radio rows** — three rows (`lan_only` / `public` /
 *      `maintenance`) each carrying user-facing copy, projected
 *      resolution preview, `is_current`, and `requires_ddns` gating.
 *      A fourth virtual row surfaces the `Custom` badge when the
 *      current grid has drifted from every preset.
 *    - **Per-path checkbox grid** — five rows × two columns; each
 *      cell carries the toggle's current state plus the gate it would
 *      trigger if flipped (e.g. `/mcp.public` raises the ack modal,
 *      `/ws` going fully off raises the lockout modal).
 *    - **Dispatch builders** — the page is the caller for the three
 *      exposure rpcs (`exposure.apply_preset` /
 *      `exposure.set_path_resolution` / `exposure.set_public_mcp_-
 *      acknowledgement`). The builders shape the payload + thread
 *      the optional confirmation phrases so the caller can fire the
 *      rpc verbatim.
 *
 *  The model is a pure projection; the page-shell handles state
 *  updates by re-running this builder against the fresh
 *  `ExposureState` carried in the broadcast event. Mirrors the
 *  rotation-center pattern (`buildRotationDispatch`, etc.).
 */

import {
  EXPOSURE_PRESETS,
  PATH_ROLES,
  WS_LOCKOUT_DISABLE_PHRASE,
  WS_LOCKOUT_DISCONNECT_PHRASE,
  anyPathPublic,
  applyPathResolution,
  applyPreset,
  deriveLabel,
  isAcknowledgementWellFormed,
  requiredWsLockoutPhrase,
  type DerivedPresetLabel,
  type ExposurePreset,
  type ExposureState,
  type NetworkErrorCode,
  type PathResolution,
  type PathRole,
  type PublicMcpAcknowledgement,
  type WsLockoutPhrase,
} from '@recued/contracts';

/** Codex W3.8 P2 #1 fold — a record with `acknowledged: true` but no
 *  canonical phrase is malformed; the contracts predicate treats it as
 *  unacknowledged. The renderer must mirror that so the ack-gate flag
 *  + the projection helper don't trip the server with a stale boolean.
 *  Reduces to `acknowledged && well-formed`. */
const isAcknowledgementEffectivelyOn = (ack: PublicMcpAcknowledgement): boolean =>
  ack.acknowledged && isAcknowledgementWellFormed(ack);

/** Per-preset user-facing copy. The renderer is the localization seam —
 *  the substrate never assembles user-facing strings. */
export const EXPOSURE_PRESET_COPY: Record<
  ExposurePreset,
  { label: string; subtitle: string; description: string }
> = {
  lan_only: {
    label: 'LAN Only',
    subtitle: 'Safe for a home network',
    description:
      'Only devices on your own network can reach the server. Nothing is open to the internet. This is the safe choice at home. Pick it when nothing outside your network needs to reach in.',
  },
  public: {
    label: 'Public',
    subtitle: 'Fully open: services, devices anywhere, and AI apps',
    description:
      'Your own network still works. Services can tell your server things, visitors can reach your Reception page, you can connect from anywhere, and AI apps can reach it once you agree. You need a web address set up first.',
  },
  maintenance: {
    label: 'Maintenance',
    subtitle: 'Everything shut. Use the terminal to get back in',
    description:
      'Nothing is open at all. Use this if something has gone wrong, or while you change things. To get back in, use the terminal on the server itself. Until then, you cannot reach Recued in a browser.',
  },
};

/** Per-path user-facing copy. Keys the checkbox-grid rows. */
export const EXPOSURE_PATH_COPY: Record<
  PathRole,
  { label: string; subtitle: string }
> = {
  health: {
    label: '/health',
    subtitle: 'The are-you-alive check',
  },
  ws: {
    label: '/ws',
    subtitle: 'Reaching Recued in a browser',
  },
  mcp: {
    label: '/mcp',
    subtitle: 'AI apps reaching in',
  },
  llm_gateway: {
    label: '/llm-gateway',
    subtitle: 'AI reaching in through your own door',
  },
  webhooks: {
    label: '/webhooks',
    subtitle: 'Services telling your server things (HubSpot, Salesforce and so on)',
  },
  reception: {
    label: '/reception',
    subtitle: 'Your public pages',
  },
  oauth: {
    label: '/oauth/complete',
    subtitle: 'Signing in to services (HubSpot, Salesforce and so on)',
  },
  ask: {
    label: '/ask',
    subtitle: 'Email one-click answer page',
  },
  webclient: {
    label: '/webclient',
    subtitle: "This server's own embedded webclient app",
  },
};

/** Closed-list NetworkErrorCode → remediation copy. The Settings page
 *  surfaces this when the rpc round-trip fails. Mirrors the rotation-
 *  center error-copy registry. */
export const EXPOSURE_ERROR_COPY: Record<NetworkErrorCode, string> = {
  preset_unknown: 'Unknown preset. Refresh the page + try again.',
  preset_unachievable_no_ddns:
    'This choice needs an address people outside can use. Set up DDNS in Settings, then Server, then DDNS, or stay on your own network only.',
  public_mcp_not_acknowledged:
    'Public MCP requires an explicit acknowledgement. Click "Enable public MCP" and type the confirmation phrase first.',
  public_mcp_phrase_mismatch:
    'The acknowledgement phrase did not match. Type "enable public MCP" exactly + retry.',
  cert_pin_stale:
    'The pinned cert fingerprint is stale. Re-pair the affected client from Settings → Server → Key Health.',
  cert_pin_mismatch:
    'The cert fingerprint does not match the pinned value. Possible MITM — re-pair every client and rotate the cert.',
  rotation_notice_signature_invalid:
    'A message about swapping your certificate arrived unsigned, so Recued threw it away. Look in Settings, then Server, then Reachability.',
  telegram_port_unsupported:
    'Telegram only takes webhooks on ports 443, 80, 88 and 8443. Change the Connection to use one of those.',
  port_in_use: 'A port is already bound by another process. Free the port + retry.',
  lan_address_unresolved:
    'Recued could not work out your own network address. Type it in yourself under Settings, then Server, then Network.',
  path_unknown: 'Unknown path role. Refresh the page + try again.',
  ws_lockout_unconfirmed:
    'Disabling /ws would lock you out of Settings. Type the confirmation phrase shown in the modal to continue.',
  ws_lockout_phrase_mismatch:
    'The /ws confirmation phrase did not match. Type it exactly as shown in the modal.',
  tls_domain_unknown: 'Unknown TLS domain. Refresh the page + try again.',
  tls_san_mismatch:
    'The uploaded cert\'s SAN list does not cover the domain. Verify the domain matches the cert before upload.',
  tls_key_pair_mismatch:
    'The private key does not match the cert. Re-export the matching pair + retry.',
  tls_chain_invalid:
    'The cert chain does not terminate at a public CA root. Include the issuer chain in the upload, or use the BYO + self-signed path.',
  tls_cert_expired_at_upload:
    'The cert has already expired. Renew with the issuer + retry.',
  tls_pro_acme_unbind_required:
    'Auto-managed (Pro ACME) certs cannot be removed directly. Tear down the DDNS binding first via Settings → Server → DDNS → Unbind, which retires the cert in one transaction.',
  tls_custom_domain_unenroll_required:
    'Recued manages this certificate for your own domain, so removing it here would only make Recued issue it again. Remove the hostname in Settings → Server → Domains to un-enrol it — that retires the certificate with it.',
  pro_acme_not_found:
    'No Pro-managed cert exists for this domain. The handle may already be unbound, or it was managed manually (BYO upload) — use Remove on the cert row instead.',
  pro_acme_ddns_release_failed:
    'Giving back your Pro DDNS name did not work in the cloud. Your certificate is still safe. Try again, or use Reachability Doctor to see if the cloud is having trouble.',
  // Not a cloud outage — the opposite. The helper answered; it said this
  // server has issued enough certificates for today. Nothing to go fix.
  acme_rate_limited:
    'This server has issued as many certificates as it is allowed today. The allowance resets 24 hours after the first issuance in the current window — no action needed, and any existing certificate is untouched.',
  apex_mode_unknown: 'Unknown apex mode. Refresh the page + try again.',
  apex_reception_not_public:
    'Serving Reception at the root needs /reception public. Turn on the /reception public bit in the grid above first, then pick "Serve Reception".',
  apex_webclient_unavailable:
    'Serving the webclient at the root needs /webclient public in the grid above AND a webclient bundle deployed on this server. Turn on the /webclient public bit (and make sure the bundle is installed), then pick "Serve the webclient".',
};

/** Per-row metadata for the preset radio. Each row drives one option
 *  in the UI radio group; `Custom` surfaces as an out-of-band badge
 *  (never selectable — only reached by drifting from every preset). */
export interface ExposurePresetRow {
  preset: ExposurePreset;
  label: string;
  subtitle: string;
  description: string;
  /** Resolution table the preset projects under the current
   *  acknowledgement. The UI previews this on hover. */
  preview_resolution: Record<PathRole, PathResolution>;
  /** True iff the currently-applied resolution matches this preset's
   *  ack-aware shape exactly. */
  is_current: boolean;
  /** True iff this preset would resolve any path public AND DDNS is
   *  not configured — the option renders disabled with a "configure
   *  DDNS first" hint. */
  requires_ddns: boolean;
  /** True iff applying this preset would force `/ws` fully off and
   *  the current resolution still has at least one `/ws` bit on. The
   *  UI surfaces the lockout modal before firing the rpc. */
  triggers_ws_lockout: boolean;
}

/** Per-cell metadata for the checkbox grid. Each row carries the two
 *  cells (`lan` / `public`) plus the per-row gates the UI evaluates
 *  on toggle. */
export interface ExposurePathRow {
  path: PathRole;
  label: string;
  subtitle: string;
  /** Currently-applied resolution for this row. */
  resolution: PathResolution;
  /** True iff flipping `public` true on this row would require the
   *  acknowledgement modal. Only set on the `/mcp` row when the bit
   *  is currently off + ack is missing or invalid. */
  requires_public_mcp_ack: boolean;
  /** True iff turning both cells off would lock Mary out of Settings.
   *  Only set on the `/ws` row. */
  triggers_ws_lockout: boolean;
  /** True iff turning `public` on would require DDNS configured but
   *  it isn't yet. Set per-row so the UI can render the per-cell
   *  hint. */
  requires_ddns_for_public: boolean;
}

/** Full Settings → Server → Exposure page model. */
export interface ExposurePageModel {
  /** Current ack-aware label — `'custom'` when the grid has drifted
   *  from every preset. */
  derived_preset_label: DerivedPresetLabel;
  /** Three preset rows in the canonical order. */
  preset_rows: ReadonlyArray<ExposurePresetRow>;
  /** Five path rows in the canonical order. */
  path_rows: ReadonlyArray<ExposurePathRow>;
  /** Public-MCP acknowledgement state — drives the Public MCP card
   *  + the in-page "Enable public MCP" / "Revoke public MCP" button. */
  public_mcp_acknowledgement: PublicMcpAcknowledgement;
  /** True iff any path resolves public in the live state. Drives the
   *  doctor cross-link copy ("Your server is reachable from the
   *  Internet — review the Reachability Doctor"). */
  any_public: boolean;
  /** True iff DDNS is configured (Pro recued.cloud OR user-supplied
   *  DDNS adapter). When false, public presets render disabled +
   *  every per-row `requires_ddns_for_public` flag surfaces. */
  has_ddns: boolean;
}

const previewMatches = (
  preview: Record<PathRole, PathResolution>,
  state: Record<PathRole, PathResolution>,
): boolean => {
  for (const role of PATH_ROLES) {
    if (preview[role].lan !== state[role].lan) return false;
    if (preview[role].public !== state[role].public) return false;
  }
  return true;
};

/** Build the renderable page model from the server's `ExposureState`
 *  plus a couple of out-of-band context fields. Pure projection;
 *  caller re-runs after the `exposure_changed` broadcast carrying
 *  the next state. */
export const buildExposurePageModel = (args: {
  state: ExposureState;
  has_ddns: boolean;
}): ExposurePageModel => {
  const ack = args.state.public_mcp_acknowledgement;
  const liveResolution = args.state.resolution;

  const preset_rows: ExposurePresetRow[] = EXPOSURE_PRESETS.map((preset) => {
    const preview = applyPreset(preset, ack);
    const projected = preview;
    const requires_ddns = anyPathPublic(projected) && !args.has_ddns;
    const triggers_ws_lockout =
      !projected.ws.lan
      && !projected.ws.public
      && (liveResolution.ws.lan || liveResolution.ws.public);
    return {
      preset,
      label: EXPOSURE_PRESET_COPY[preset].label,
      subtitle: EXPOSURE_PRESET_COPY[preset].subtitle,
      description: EXPOSURE_PRESET_COPY[preset].description,
      preview_resolution: preview,
      is_current: previewMatches(preview, liveResolution),
      requires_ddns,
      triggers_ws_lockout,
    };
  });

  const ackEffective = isAcknowledgementEffectivelyOn(ack);
  const path_rows: ExposurePathRow[] = PATH_ROLES.map((path) => {
    const row = liveResolution[path];
    const requires_public_mcp_ack =
      path === 'mcp' && !row.public && !ackEffective;
    const triggers_ws_lockout = path === 'ws' && (row.lan || row.public);
    return {
      path,
      label: EXPOSURE_PATH_COPY[path].label,
      subtitle: EXPOSURE_PATH_COPY[path].subtitle,
      resolution: { lan: row.lan, public: row.public },
      requires_public_mcp_ack,
      triggers_ws_lockout,
      requires_ddns_for_public: !args.has_ddns,
    };
  });

  return {
    derived_preset_label: deriveLabel(liveResolution, ack),
    preset_rows,
    path_rows,
    public_mcp_acknowledgement: ack,
    any_public: anyPathPublic(liveResolution),
    has_ddns: args.has_ddns,
  };
};

// ────────────────────────────────────────────────────────────────
// Dispatch builders
// ────────────────────────────────────────────────────────────────
//
// The renderer never fires the rpc; it shapes the payload + hands it
// to the page-shell. The shell then calls the `exposure.*` rpc via
// the WS conn. Same separation as `buildRotationDispatch`.

/** Payload for `exposure.apply_preset`. */
export interface ExposurePresetDispatch {
  op: 'exposure.apply_preset';
  preset: ExposurePreset;
  lockout_confirmation_phrase?: string;
  reason?: string;
}

/** Payload for `exposure.set_path_resolution`. */
export interface ExposurePathResolutionDispatch {
  op: 'exposure.set_path_resolution';
  path: PathRole;
  resolution: PathResolution;
  lockout_confirmation_phrase?: string;
  reason?: string;
}

/** Payload for `exposure.set_public_mcp_acknowledgement`. */
export interface ExposurePublicMcpDispatch {
  op: 'exposure.set_public_mcp_acknowledgement';
  acknowledge: boolean;
  free_text_confirmation?: string;
  reason?: string;
}

export type ExposureDispatch =
  | ExposurePresetDispatch
  | ExposurePathResolutionDispatch
  | ExposurePublicMcpDispatch;

export const buildPresetDispatch = (args: {
  preset: ExposurePreset;
  lockout_confirmation_phrase?: string;
  reason?: string;
}): ExposurePresetDispatch => ({
  op: 'exposure.apply_preset',
  preset: args.preset,
  ...(args.lockout_confirmation_phrase !== undefined
    ? { lockout_confirmation_phrase: args.lockout_confirmation_phrase }
    : {}),
  ...(args.reason !== undefined ? { reason: args.reason } : {}),
});

export const buildPathResolutionDispatch = (args: {
  path: PathRole;
  resolution: PathResolution;
  lockout_confirmation_phrase?: string;
  reason?: string;
}): ExposurePathResolutionDispatch => ({
  op: 'exposure.set_path_resolution',
  path: args.path,
  resolution: { lan: args.resolution.lan, public: args.resolution.public },
  ...(args.lockout_confirmation_phrase !== undefined
    ? { lockout_confirmation_phrase: args.lockout_confirmation_phrase }
    : {}),
  ...(args.reason !== undefined ? { reason: args.reason } : {}),
});

export const buildPublicMcpDispatch = (args: {
  acknowledge: boolean;
  free_text_confirmation?: string;
  reason?: string;
}): ExposurePublicMcpDispatch => ({
  op: 'exposure.set_public_mcp_acknowledgement',
  acknowledge: args.acknowledge,
  ...(args.free_text_confirmation !== undefined
    ? { free_text_confirmation: args.free_text_confirmation }
    : {}),
  ...(args.reason !== undefined ? { reason: args.reason } : {}),
});

/** Compute the `/ws` lockout phrase for a projected transition.
 *  Re-exports the contracts helper as a renderer-side ergonomic seam
 *  + handles the "no lockout needed" branch by returning null. */
export const projectWsLockoutPhrase = (args: {
  next_resolution: PathResolution;
  active_ws_connections: number;
}): WsLockoutPhrase | null => requiredWsLockoutPhrase(args);

/** Phrase constants re-exported for the modal renderer. */
export {
  WS_LOCKOUT_DISCONNECT_PHRASE,
  WS_LOCKOUT_DISABLE_PHRASE,
  type WsLockoutPhrase,
};

/** When a preset transition (e.g., `maintenance`) would project a
 *  `/ws` lockout, this helper computes the projected resolution + the
 *  required phrase based on caller channel + active connections.
 *  Returns null when the transition does not trigger the lockout
 *  gate. */
export const projectPresetWsLockout = (args: {
  preset: ExposurePreset;
  acknowledgement: PublicMcpAcknowledgement;
  current_resolution: Record<PathRole, PathResolution>;
  active_ws_connections: number;
}): WsLockoutPhrase | null => {
  const projected = applyPreset(args.preset, args.acknowledgement);
  if (projected.ws.lan || projected.ws.public) return null;
  if (!args.current_resolution.ws.lan && !args.current_resolution.ws.public) {
    return null;
  }
  return requiredWsLockoutPhrase({
    next_resolution: projected.ws,
    active_ws_connections: args.active_ws_connections,
  });
};

/** Same shape but for a single-path mutation against `/ws`. Returns
 *  null when the path is not `/ws` OR when the target keeps at least
 *  one bit on. */
export const projectPathWsLockout = (args: {
  path: PathRole;
  next_resolution: PathResolution;
  current_resolution: Record<PathRole, PathResolution>;
  active_ws_connections: number;
}): WsLockoutPhrase | null => {
  if (args.path !== 'ws') return null;
  if (args.next_resolution.lan || args.next_resolution.public) return null;
  if (!args.current_resolution.ws.lan && !args.current_resolution.ws.public) {
    return null;
  }
  return requiredWsLockoutPhrase({
    next_resolution: args.next_resolution,
    active_ws_connections: args.active_ws_connections,
  });
};

/** True iff the projected target path would walk through the
 *  acknowledgement gate (`/mcp.public` flipped on with ack missing
 *  or malformed). Codex W3.8 P2 #1 fold — a boolean-true ack with a
 *  missing or non-canonical phrase still fails the server-side
 *  well-formedness check, so the renderer must treat it as
 *  unacknowledged and surface the modal rather than firing the rpc. */
export const projectRequiresPublicMcpAck = (args: {
  path: PathRole;
  next_resolution: PathResolution;
  current_resolution: Record<PathRole, PathResolution>;
  acknowledgement: PublicMcpAcknowledgement;
}): boolean => {
  if (args.path !== 'mcp') return false;
  if (!args.next_resolution.public) return false;
  if (args.current_resolution.mcp.public) return false;
  return !isAcknowledgementEffectivelyOn(args.acknowledgement);
};

/** Convenience: project a per-cell click into the next `PathResolution`
 *  + the resulting page-projection. Used by the page shell to render
 *  the optimistic UI before the rpc round-trip completes. */
export const projectCellToggle = (args: {
  current_resolution: Record<PathRole, PathResolution>;
  path: PathRole;
  cell: 'lan' | 'public';
}): Record<PathRole, PathResolution> => {
  const row = args.current_resolution[args.path];
  const next: PathResolution = {
    lan: args.cell === 'lan' ? !row.lan : row.lan,
    public: args.cell === 'public' ? !row.public : row.public,
  };
  return applyPathResolution(args.current_resolution, args.path, next);
};
