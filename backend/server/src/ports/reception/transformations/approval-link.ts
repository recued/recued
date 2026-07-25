/** D-149 P8 § A.4 + § A.5.5 — `approval_link_packet` transformation
 *  helpers (server-side, per-kind).
 *
 *  Source-query → raw-input adapter. The substrate owns the closed-list
 *  pick + the `context_raw → context_summary` redaction step
 *  (counterparty aliases + private notes stripped at the boundary —
 *  the public payload carries only `context_summary`).
 *
 *  P2 shipped the typed builder skeleton; P8 wires:
 *    - `parseApprovalLinkConfig` reads the registry row's `metadata_blob`
 *      into the canonical `ApprovalLinkConfig` shape (returns null on
 *      corrupt JSON / validation failure so the dispatcher can degrade
 *      to the placeholder page rather than crash).
 *    - `buildApprovalLinkSourceView` projects the config into the
 *      `ApprovalLinkSourceView` the packet builder consumes. The
 *      expiry_display is derived from the registry row's expires_at +
 *      now so the visitor sees an honest "expires in X days" hint. */

import {
  validateApprovalLinkConfig,
  type ApprovalLinkActionKind,
  type ApprovalLinkConfig,
  type ApprovalLinkContextRaw,
  type ApprovalLinkOption,
  type ApprovalLinkPacketRawInput,
  type ApprovalLinkVisitorFieldConstraints,
} from '@recued/contracts';

export interface ApprovalLinkSourceView {
  readonly action_kind: ApprovalLinkActionKind;
  readonly prompt: string;
  readonly options?: ReadonlyArray<ApprovalLinkOption>;
  readonly expiry_display: string;
  readonly visitor_field_constraints: ApprovalLinkVisitorFieldConstraints;
  readonly context_raw: ApprovalLinkContextRaw;
}

/** Parse a registry-row's `metadata_blob` into a canonical
 *  `ApprovalLinkConfig`. Returns `null` on shape failure so the
 *  dispatcher can degrade to the placeholder rather than crash. */
export const parseApprovalLinkConfig = (
  raw: Readonly<Record<string, unknown>> | unknown,
): ApprovalLinkConfig | null => {
  const failures = validateApprovalLinkConfig(raw);
  if (failures.length > 0) return null;
  // Validator only confirms shape; the `as ApprovalLinkConfig` cast
  // is sound because validateApprovalLinkConfig gates every required
  // field + closed-list value.
  return raw as ApprovalLinkConfig;
};

/** Build the source-view feeding the packet raw input. The
 *  `expiry_display` is the only user-derived rendering string the
 *  substrate emits to the visitor (per § A.5.5 packet payload
 *  closed list line 183-190). */
export const buildApprovalLinkSourceView = (
  config: ApprovalLinkConfig,
  expires_at: number | null,
  now: number,
): ApprovalLinkSourceView => {
  const view: {
    action_kind: ApprovalLinkActionKind;
    prompt: string;
    options?: ReadonlyArray<ApprovalLinkOption>;
    expiry_display: string;
    visitor_field_constraints: ApprovalLinkVisitorFieldConstraints;
    context_raw: ApprovalLinkContextRaw;
  } = {
    action_kind: config.action_kind,
    prompt: config.prompt,
    expiry_display: formatExpiryDisplay(expires_at, now),
    visitor_field_constraints: config.visitor_field_constraints,
    // The raw context flows through to the packet builder; the
    // substrate redacts at the build boundary (counterparty_aliases +
    // private_notes are dropped — see redacted-packets.ts).
    context_raw: config.context_raw,
  };
  if (config.options !== undefined) {
    view.options = config.options;
  }
  return view;
};

/** Adapter — produces the raw input the substrate transform consumes.
 *  The substrate strips `counterparty_aliases` + `private_notes` at
 *  the boundary (`context_raw.summary` is the only field that
 *  reaches the visitor payload). */
export const buildApprovalLinkPacketRawInput = (
  source: ApprovalLinkSourceView,
): ApprovalLinkPacketRawInput => {
  const raw: {
    action_kind: ApprovalLinkActionKind;
    prompt: string;
    options?: ReadonlyArray<ApprovalLinkOption>;
    expiry_display: string;
    visitor_field_constraints: ApprovalLinkVisitorFieldConstraints;
    context_raw: ApprovalLinkContextRaw;
  } = {
    action_kind: source.action_kind,
    prompt: source.prompt,
    expiry_display: source.expiry_display,
    visitor_field_constraints: source.visitor_field_constraints,
    context_raw: source.context_raw,
  };
  if (source.options !== undefined) raw.options = source.options;
  return raw;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Format the expiry as a coarse-grained "expires in X days" / "expires
 *  in X hours" hint. Visitor-facing string; never leaks the precise
 *  expiry timestamp (the URL token's lifetime is server-internal). */
const formatExpiryDisplay = (expires_at: number | null, now: number): string => {
  if (expires_at === null) return 'no expiration';
  const remaining = expires_at - now;
  if (remaining <= 0) return 'expired';
  const days = Math.floor(remaining / DAY_MS);
  if (days >= 2) return `expires in ${days} days`;
  if (days === 1) return 'expires in 1 day';
  const hours = Math.floor(remaining / (60 * 60 * 1000));
  if (hours >= 2) return `expires in ${hours} hours`;
  if (hours === 1) return 'expires in 1 hour';
  return 'expires within the hour';
};
