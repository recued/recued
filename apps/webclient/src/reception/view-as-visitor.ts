/** D-149 § A.20.2 — Reception → endpoint detail → "View as
 *  visitor" panel render.
 *
 *  The second self-contained satellite Settings surface attaching to the
 *  § A.9 management spine (`spine.ts`), after the Abuse Inbox
 *  subview. P12 shipped the View-As-Visitor substrate —
 *  `buildViewAsVisitorPanel` derives the visible-vs-stripped field map
 *  (with per-field rationale), the expiry / token / audit posture, and
 *  the § N.7 MUST-invariant compliance summary; the
 *  `reception.endpoint.preview_draft` rpc populates `view_as_visitor` on
 *  every `ReceptionEndpointPreviewResult` — but, consistent with how
 *  P4-P12 each deferred its Settings UX, nothing rendered it. This is
 *  the projection layer.
 *
 *  One surface:
 *
 *    - **View-As-Visitor panel** (Reception → `<endpoint>` →
 *      "View as visitor") — the load-bearing privacy-trust UX. Before
 *      enabling any endpoint the user sees the exact server-rendered
 *      visitor page (`rendered_html`, sandboxed by the renderer) plus a
 *      panel: the fields a visitor sees vs. the fields stripped at the
 *      redacted-packet boundary (each with its rationale), the expiry
 *      policy (default + per-kind ceiling + this endpoint's own
 *      expiry), the token-presentation mode, the audit mode, and the
 *      privacy-invariant compliance summary. The whole result also
 *      carries the `preview_hash` — gated by a 10-minute TTL — that
 *      `reception.endpoint.create` requires, so the panel surfaces a
 *      freshness label too.
 *
 *  This module is **projection only** — it does NOT own a dispatch
 *  builder. The "View as visitor" button fires
 *  `reception.endpoint.preview_draft`, whose dispatch builder
 *  (`buildEndpointPreviewDispatch`) is owned by `authoring.ts`
 *  (the authoring flow runs preview FIRST to mint the hash). The
 *  detail-view button works off an existing endpoint rather than
 *  freshly-authored config, so the one bridge this module adds is
 *  `previewDispatchArgsFromSummary` — an `EndpointSummary` → preview-
 *  dispatch-args adapter that normalises a long-lived endpoint's `null`
 *  `expires_at` to an omitted field (sending `null` on the wire would
 *  desync the canonical preview-hash serialisation — exactly the
 *  D-149 per-kind-authoring Codex P2 fold). `buildEndpointPreviewDispatch`
 *  is re-exported so the page shell composes the two with one import.
 *
 *  `computeExpiryLabel` is imported from the spine sibling (`./reception.js`)
 *  — the one expiry-label rule across the whole Reception Settings
 *  surface, same discipline as the shared `truncateSourceIpHash`.
 *
 *  Per D-148 § A.4 invariant — the webclient projects server-supplied
 *  state only, never synthesises. `buildViewAsVisitorModel` is a pure
 *  projection of the `reception.endpoint.preview_draft` result. There is
 *  deliberately **no** broadcast reducer: a preview is a one-shot
 *  synthetic session (`synthetic: true` is hard-coded by the contract's
 *  `buildViewAsVisitorPanel`), never an access-log entry, and nothing
 *  fans a broadcast on it — the page shell just re-fires
 *  `reception.endpoint.preview_draft` when the user re-opens the panel.
 *
 *  Spec: D-149 § A.20.2 (View-As-Visitor Preview) + § N.7
 *  (MUST-invariant list the panel surfaces) + § A.18.3 (token mode) +
 *  § A.16.5 (audit-mode split). */

import {
  type EndpointSummary,
  type PacketDeclaration,
  type ReceptionEndpointKind,
  type ReceptionEndpointPreviewResult,
  type RedactedPacketKind,
  type ViewAsVisitorFieldRow,
  type ViewAsVisitorPanel,
} from '@recued/contracts';

import { computeExpiryLabel } from './spine.js';
import { buildEndpointPreviewDispatch } from './authoring.js';

const MINUTE_MS = 60 * 1000;

// ════════════════════════════════════════════════════════════════
// Preview-hash freshness — the `preview_draft` result's `preview_hash`
// carries a 10-minute TTL; `reception.endpoint.create` rejects a stale
// one as `preview_hash_expired`. The panel surfaces a countdown label.
// ════════════════════════════════════════════════════════════════

/** Human label for the preview hash's freshness. A still-valid hash ⇒
 *  "Preview good for N more minutes"; a lapsed one ⇒ a re-run prompt.
 *  Minute-scale (the hash TTL is 10 min) — distinct from the day-scale
 *  `computeExpiryLabel`. Pure — no I/O. */
export const computePreviewFreshnessLabel = (
  preview_hash_expires_at: number,
  now: number,
): string => {
  const remaining = preview_hash_expires_at - now;
  if (remaining <= 0) {
    return 'The preview has run out. Look as a visitor again before you make this.';
  }
  const minutes = Math.ceil(remaining / MINUTE_MS);
  return `Preview good for ${minutes} more ${minutes === 1 ? 'minute' : 'minutes'}`;
};

// ════════════════════════════════════════════════════════════════
// Copy registries — closed-list token-mode / audit-mode / privacy-
// invariant copy. The renderer is the localisation seam; the substrate
// never assembles user-facing strings.
// ════════════════════════════════════════════════════════════════

/** § A.18.3 — the two token-presentation modes across the six endpoint
 *  kinds. The contract's `RECEPTION_KIND_TOKEN_MODE` maps each kind to
 *  one of these raw strings; this module-local closed list is the copy-
 *  registry key (a ratchet test asserts it stays exhaustive over the
 *  contract map's values). */
export type ReceptionTokenMode = 'tokenless_singleton' | 'bearer_query_param';

export const RECEPTION_TOKEN_MODES: ReadonlyArray<ReceptionTokenMode> = [
  'tokenless_singleton',
  'bearer_query_param',
] as const;

/** Closed-list `ReceptionTokenMode` → user-facing copy. `label` is the
 *  panel chip; `description` is the "what this means for sharing" body. */
export const RECEPTION_TOKEN_MODE_COPY: Readonly<
  Record<ReceptionTokenMode, { label: string; description: string }>
> = {
  tokenless_singleton: {
    label: 'No secret in the link',
    description:
      'Your Reception page is your front door at /reception/, and its link holds no secret. Anyone who knows your server’s address can look at it. There is no secret to leak, swap, or take back — you decide by switching it on or off, and by what you put on the page.',
  },
  bearer_query_param: {
    label: 'The link holds the secret',
    description:
      'The link you share holds a secret in its ?t= part, so the link itself is the password — treat it like one. Your server keeps only a scrambled copy and can never show it again. If a link gets out, swap the secret and the old link stops working.',
  },
};

/** Resolve token-mode copy from a panel's `token_mode` (typed `string`
 *  on the contract — the panel echoes the raw `RECEPTION_KIND_TOKEN_MODE`
 *  value). A value outside the closed list falls back to a neutral
 *  shape rather than throwing — the renderer always gets a label. Pure
 *  — no I/O. */
export const resolveTokenModeCopy = (
  mode: string,
): { label: string; description: string } =>
  RECEPTION_TOKEN_MODE_COPY[mode as ReceptionTokenMode] ?? {
    label: mode,
    description: 'How the secret is carried, for this kind of link.',
  };

/** § A.16.5 — per-`ReceptionEndpointKind` audit-mode copy. Every kind
 *  writes the operational `public_endpoint_access_log` row per request;
 *  the copy names the additional D-120 high-assurance signed event the
 *  kind emits (none for the read-only `status_link`). Keyed on the kind
 *  because the audit mode is 1:1 with the kind — tsc enforces
 *  completeness. */
export const RECEPTION_AUDIT_MODE_COPY: Readonly<
  Record<ReceptionEndpointKind, { label: string; description: string }>
> = {
  reception_page: {
    label: 'A note of every visit, plus a signed record when you change the page',
    description:
      'Every visit adds a line to the log. Changing the Reception page also writes a signed record that nobody can quietly alter.',
  },
  scheduling_link: {
    label: 'A note of every visit, plus a signed record for every booking',
    description:
      'Every visit adds a line to the log. Every booking also writes a signed record that nobody can quietly alter.',
  },
  intake_form: {
    label: 'A note of every visit, plus a signed record for every answer',
    description:
      'Every visit adds a line to the log. Every answer also writes a signed record that nobody can quietly alter.',
  },
  drop_link: {
    label: 'A note of every visit, plus a signed record for every file left here',
    description:
      'Every visit adds a line to the log. Every file that arrives also writes a signed record that nobody can quietly alter.',
  },
  approval_link: {
    label: 'A note of every visit, plus a signed record when the link is used up',
    description:
      'Every visit adds a line to the log. Using up the one-time link also writes a signed record that nobody can quietly alter.',
  },
  status_link: {
    label: 'Just a note of every visit',
    description:
      'Status pages only show things. Every visit adds a line to the log, but nothing can be changed, so there is nothing to sign.',
  },
};

/** § N.7 — "why it matters" detail copy for each privacy invariant the
 *  panel surfaces. Keyed on the exact label string from the contract's
 *  `RECEPTION_PRIVACY_INVARIANT_LABELS` (a `ReadonlyArray<string>`, not
 *  a typed union — so a ratchet test, not tsc, enforces exhaustiveness).
 *  Mirrors the spine's `RECEPTION_SAFETY_LABEL_TOOLTIP` — a short label
 *  from the substrate, a longer "why" from the renderer. */
export const RECEPTION_PRIVACY_INVARIANT_DETAIL: Readonly<Record<string, string>> = {
  'Endpoint is default-off until explicitly enabled':
    'A new one shows nothing until you switch it on, so there is never a moment when a half-finished page is open to visitors.',
  'Only the closed fields_visible list crosses the boundary':
    'Recued takes out every field except the ones listed above. Nothing else has any way to reach a visitor.',
  'Expiry is within the per-kind ceiling':
    'Each kind has a limit on how long it may last: drop-off and approval 30 days, status 90 days. Page, booking and form links may last longer, but only if you say so.',
  'Bearer token is HMAC-keyed and never re-readable':
    'Your server keeps only a scrambled copy. You see the real one once, when you make it or swap it, and never again. Even someone who stole the whole database could not get a working link.',
  'Source IP is endpoint-scoped HKDF-hashed (no cross-endpoint tracking)':
    'Each visitor’s address is scrambled with a secret only your server knows, and differently for every link. The same person at two links looks like two different people, so nobody can follow them about unless you ask for that.',
  'No recipe content or visitor data is relayed through the cloud':
    'Reception comes straight from your server. The cloud only passes on your name. No Recipe, nothing a visitor sends, and no file they leave ever goes through Recued’s cloud.',
};

/** Resolve a privacy-invariant's detail copy. An invariant label outside
 *  the registry (defensive — the contract list and this registry are
 *  ratchet-tested to agree) falls back to the label itself so the
 *  renderer always has something to show. Pure — no I/O. */
export const resolvePrivacyInvariantDetail = (invariant: string): string =>
  RECEPTION_PRIVACY_INVARIANT_DETAIL[invariant] ?? invariant;

// ════════════════════════════════════════════════════════════════
// Privacy-invariant row projection
// ════════════════════════════════════════════════════════════════

/** One projected privacy-invariant row — the contract's
 *  `{ invariant, satisfied }` plus the resolved "why it matters" detail
 *  copy. */
export interface ViewAsVisitorInvariantRowModel {
  invariant: string;
  detail: string;
  satisfied: boolean;
}

// ════════════════════════════════════════════════════════════════
// Panel model
// ════════════════════════════════════════════════════════════════

/** The projected View-As-Visitor panel — the contract's
 *  `ViewAsVisitorPanel` with copy resolved + the field rows split into
 *  the visible vs. stripped sections § A.20.2 names + the invariant
 *  summary aggregated. */
export interface ViewAsVisitorPanelModel {
  /** Always `true` — mirrors the contract's hard-coded flag so any
   *  debug echo of the model stays unmistakably a synthetic session,
   *  never a real visitor access-log entry (§ A.20.2). */
  synthetic: true;
  endpoint_kind: ReceptionEndpointKind;
  /** The D-145 packet kind the endpoint kind binds to — secondary
   *  detail, carried raw (the user-facing handle is `endpoint_kind`). */
  packet_kind: RedactedPacketKind;
  /** Closed list of fields the visitor sees (= `fields_visible_override`
   *  when the declaration clamps it, else the packet kind's default). */
  visible_fields: ReadonlyArray<string>;
  /** Field rows the visitor sees — `visible: true`, in fields_visible
   *  order. */
  visible_field_rows: ReadonlyArray<ViewAsVisitorFieldRow>;
  /** Field rows stripped at the redacted-packet boundary — `visible:
   *  false`, each carrying its per-packet-kind rationale. */
  stripped_field_rows: ReadonlyArray<ViewAsVisitorFieldRow>;
  visible_field_count: number;
  stripped_field_count: number;
  expiry_policy: {
    /** Human label for the default expiry posture (from the contract). */
    default_label: string;
    /** Human label for the per-kind ceiling (from the contract). */
    max_label: string;
    /** The endpoint's own `expires_at` (Unix-ms; `null` ⇒ long-lived). */
    expires_at: number | null;
    /** Relative label for `expires_at` — via the shared
     *  `computeExpiryLabel` ("Never expires" / "Expires in N days" /
     *  "Expired …"). */
    expires_at_label: string;
    is_long_lived: boolean;
  };
  /** Raw token-mode string (from `RECEPTION_KIND_TOKEN_MODE`). */
  token_mode: string;
  token_mode_label: string;
  token_mode_description: string;
  /** Raw audit-mode string (from `RECEPTION_KIND_AUDIT_MODE`). */
  audit_mode: string;
  audit_mode_label: string;
  audit_mode_description: string;
  invariant_summary: {
    rows: ReadonlyArray<ViewAsVisitorInvariantRowModel>;
    /** True iff every invariant row is `satisfied`. */
    all_satisfied: boolean;
    satisfied_count: number;
    total_count: number;
    /** "All N privacy promises kept" when clean, else a
     *  "M of N … — review the flagged K" prompt. */
    compliance_label: string;
  };
}

/** Project a contract `ViewAsVisitorPanel` into the render model —
 *  splits the field rows into the visible / stripped sections, resolves
 *  the token-mode + audit-mode + privacy-invariant copy, labels the
 *  endpoint's own expiry via the shared `computeExpiryLabel`, and
 *  aggregates the invariant summary. Pure — no I/O. */
export const buildViewAsVisitorPanelModel = (
  panel: ViewAsVisitorPanel,
  now: number,
): ViewAsVisitorPanelModel => {
  const visible_field_rows = panel.field_rows.filter((r) => r.visible);
  const stripped_field_rows = panel.field_rows.filter((r) => !r.visible);

  const token_copy = resolveTokenModeCopy(panel.token_mode);
  const audit_copy = RECEPTION_AUDIT_MODE_COPY[panel.endpoint_kind];

  const invariant_rows: ViewAsVisitorInvariantRowModel[] =
    panel.privacy_invariant_summary.map((row) => ({
      invariant: row.invariant,
      detail: resolvePrivacyInvariantDetail(row.invariant),
      satisfied: row.satisfied,
    }));
  const satisfied_count = invariant_rows.filter((r) => r.satisfied).length;
  const total_count = invariant_rows.length;
  const all_satisfied = satisfied_count === total_count;
  const compliance_label = all_satisfied
    ? `All ${total_count} privacy promises kept`
    : `${satisfied_count} of ${total_count} privacy promises kept — look at the ${total_count - satisfied_count} marked before you switch it on`;

  return {
    synthetic: true,
    endpoint_kind: panel.endpoint_kind,
    packet_kind: panel.packet_kind,
    visible_fields: panel.visible_fields,
    visible_field_rows,
    stripped_field_rows,
    visible_field_count: visible_field_rows.length,
    stripped_field_count: stripped_field_rows.length,
    expiry_policy: {
      default_label: panel.expiry_policy.default_label,
      max_label: panel.expiry_policy.max_label,
      expires_at: panel.expiry_policy.expires_at,
      expires_at_label: computeExpiryLabel(panel.expiry_policy.expires_at, now),
      is_long_lived: panel.expiry_policy.expires_at === null,
    },
    token_mode: panel.token_mode,
    token_mode_label: token_copy.label,
    token_mode_description: token_copy.description,
    audit_mode: panel.audit_mode,
    audit_mode_label: audit_copy.label,
    audit_mode_description: audit_copy.description,
    invariant_summary: {
      rows: invariant_rows,
      all_satisfied,
      satisfied_count,
      total_count,
      compliance_label,
    },
  };
};

// ════════════════════════════════════════════════════════════════
// Full preview-result model
// ════════════════════════════════════════════════════════════════

/** Full Reception → `<endpoint>` → "View as visitor" model —
 *  the `reception.endpoint.preview_draft` result projected: the server-
 *  rendered visitor page, the panel projection, and the preview-hash
 *  freshness. */
export interface ViewAsVisitorModel {
  /** The server-rendered visitor-page HTML — the renderer sandboxes /
   *  iframes it (it is anonymous-visitor markup). Passthrough; never
   *  assembled client-side. */
  rendered_html: string;
  /** The View-As-Visitor panel projection. `null` only if a result was
   *  produced without `view_as_visitor` — the contract types the field
   *  optional purely so pre-P12 fixtures compile; `reception.endpoint.preview_draft`
   *  on a P12+ server always populates it. */
  panel: ViewAsVisitorPanelModel | null;
  /** SHA-256 preview hash `reception.endpoint.create` requires. */
  preview_hash: string;
  /** Unix-ms — the preview hash is invalid after this stamp (10-min TTL). */
  preview_hash_expires_at: number;
  /** Whether the preview hash is still within its TTL — gates whether
     the renderer offers "Create endpoint" or "Re-run preview". */
  preview_is_fresh: boolean;
  preview_freshness_label: string;
}

/** Build the renderable View-As-Visitor model from the
 *  `reception.endpoint.preview_draft` rpc result. Pure projection — the
 *  page shell re-fires `reception.endpoint.preview_draft` (there is no
 *  broadcast on a synthetic preview) and re-runs this builder when the
 *  user re-opens the panel. */
export const buildViewAsVisitorModel = (args: {
  result: ReceptionEndpointPreviewResult;
  now: number;
}): ViewAsVisitorModel => {
  const { result, now } = args;
  return {
    rendered_html: result.html,
    panel:
      result.view_as_visitor !== undefined
        ? buildViewAsVisitorPanelModel(result.view_as_visitor, now)
        : null,
    preview_hash: result.preview_hash,
    preview_hash_expires_at: result.expires_at,
    preview_is_fresh: result.expires_at - now > 0,
    preview_freshness_label: computePreviewFreshnessLabel(result.expires_at, now),
  };
};

// ════════════════════════════════════════════════════════════════
// EndpointSummary → preview-dispatch-args adapter
// ════════════════════════════════════════════════════════════════
//
// The detail-view "View as visitor" button works off an existing
// `EndpointSummary`, not freshly-authored config — so it can't reach
// for `authoring.ts`'s authoring-flow builders directly. This
// adapter bridges the two: it normalises a long-lived endpoint's `null`
// `expires_at` (an `EndpointSummary` carries `number | null`) to an
// OMITTED field, because `reception.endpoint.preview_draft`'s input
// types `expires_at` as `number` — a `null` on the wire would desync
// the canonical preview-hash serialisation (the D-149 per-kind-authoring
// Codex P2 fold). The shell composes `buildEndpointPreviewDispatch` over
// the result; that builder is re-exported below for one-import ergonomics.

/** Args for `buildEndpointPreviewDispatch` — structurally the subset of
 *  an `EndpointSummary` the preview rpc needs. `expires_at` is
 *  `number | undefined`, never `null` (see the adapter note above). */
export interface ViewAsVisitorPreviewArgs {
  kind: ReceptionEndpointKind;
  packet_declaration: PacketDeclaration;
  metadata: Readonly<Record<string, unknown>>;
  expires_at?: number;
}

/** Project an existing `EndpointSummary` into the args
 *  `buildEndpointPreviewDispatch` accepts — for the detail-view "View as
 *  visitor" button. A long-lived endpoint (`expires_at: null`) yields an
 *  OMITTED `expires_at`, never `null` on the wire. Pure — no I/O. */
export const previewDispatchArgsFromSummary = (
  summary: EndpointSummary,
): ViewAsVisitorPreviewArgs => ({
  kind: summary.kind,
  packet_declaration: summary.packet_declaration,
  metadata: summary.metadata,
  ...(summary.expires_at !== null ? { expires_at: summary.expires_at } : {}),
});

/** Re-export of the authoring flow's `buildEndpointPreviewDispatch` so
 *  the page shell composes the detail-view "View as visitor" button
 *  (summary → `previewDispatchArgsFromSummary` → dispatch) with a single
 *  module import. */
export { buildEndpointPreviewDispatch };
