/** D-149 § A.20.5 — Reception → Abuse Inbox subview.
 *
 *  The first satellite Settings surface attaching to the § A.9
 *  management spine (`spine.ts`). P12 shipped the Abuse Inbox
 *  substrate — `buildAbuseInbox` aggregates operational-access-log rows
 *  into `(signal_kind, endpoint_id, source_ip_hash)` clusters, and the
 *  `reception.abuse_inbox.{list,ban_ip,unban_ip}` rpc trio + the
 *  `reception_ip_block_list` store wire it — but, consistent with how
 *  P4-P12 each deferred its Settings UX, nothing rendered it. This is
 *  the projection layer.
 *
 *  One surface:
 *
 *    - **Abuse Inbox subview** (Reception → Abuse
 *      Inbox) — a header (total surfaced clusters, the lookback-window
 *      label, the cluster-threshold explanation) plus the abuse-signal
 *      cluster rows (each carrying the per-`AbuseInboxSignalKind` copy,
 *      the event count, first / last-seen relative-time labels, the
 *      § A.16.7-truncated source-IP-hash prefix, and the `ip_blocked`
 *      ban state) plus the per-server IP block list ("currently
 *      banned"). § A.20.5 names four user actions — "Ban this IP" /
 *      "Investigate" / "Mark false positive" / "Dismiss":
 *        · **Ban / unban** are the only ones backed by substrate —
 *          `buildAbuseInboxBanIpDispatch` / `…UnbanIpDispatch` shape the
 *          `reception.abuse_inbox.{ban_ip,unban_ip}` rpc payloads.
 *        · **Investigate** is a navigation affordance — every row
 *          carries `endpoint_id` + `source_ip_hash`, so the shell deep-
 *          links to the spine's per-endpoint access-log surface; no
 *          dispatch needed.
 *        · **Mark false positive** / **Dismiss** have NO substrate —
 *          the Abuse Inbox is a pure aggregation view, there is no
 *          persisted "dismissed" state. They are client-local view
 *          state only; this module deliberately ships no builder for a
 *          non-existent rpc (same honesty discipline as the spine's
 *          "no `endpoint_changed` reducer" + "share URL never
 *          re-readable" decisions).
 *
 *  Per D-148 § A.4 invariant — the webclient projects server-supplied
 *  state only, never synthesizes. `buildAbuseInboxSubviewModel` is a
 *  pure projection of the `reception.abuse_inbox.list` result. There is
 *  deliberately **no** broadcast reducer: `ReceptionBroadcastEvent` is
 *  the closed pair `reception.endpoint_changed | .emergency_disabled` —
 *  neither a ban / unban nor a fresh abuse cluster fans a broadcast, so
 *  after a `ban_ip` / `unban_ip` round-trip the page shell simply
 *  refetches `reception.abuse_inbox.list` and re-runs this builder. The
 *  spine's `reduceReceptionEmergencyDisabled` exists only because that
 *  one broadcast carries enough to apply optimistically; nothing here
 *  does.
 *
 *  Spec: D-149 § A.20.5 (Abuse Inbox) + § A.16.7 (access-
 *  log source-IP-hash truncation) + § A.11 (threat model the inbox
 *  operationalises). */

import {
  ABUSE_INBOX_DEFAULT_CLUSTER_THRESHOLD,
  ABUSE_INBOX_SIGNAL_KINDS,
  abuseInboxBlockKey,
  type AbuseInboxRow,
  type AbuseInboxSignalKind,
  type AbuseInboxSummary,
  type ReceptionIpBlockEntry,
} from '@recued/contracts';

import { truncateSourceIpHash } from './spine.js';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// ════════════════════════════════════════════════════════════════
// Relative-time labels — past-only (abuse events are always behind
// `now`; a future `accessed_at` is clock skew → clamps to "just now")
// ════════════════════════════════════════════════════════════════

/** Human "N ago" label for a past timestamp. Clamps a non-positive
 *  elapsed (clock skew — `ts` at or ahead of `now`) to "just now" so a
 *  skewed clock never paints a negative duration. Pure — no I/O. */
export const computeRelativeTimeLabel = (ts: number, now: number): string => {
  const elapsed = now - ts;
  if (elapsed < MINUTE_MS) return 'just now';
  if (elapsed < HOUR_MS) {
    const m = Math.floor(elapsed / MINUTE_MS);
    return `${m} ${m === 1 ? 'minute' : 'minutes'} ago`;
  }
  if (elapsed < DAY_MS) {
    const h = Math.floor(elapsed / HOUR_MS);
    return `${h} ${h === 1 ? 'hour' : 'hours'} ago`;
  }
  const d = Math.floor(elapsed / DAY_MS);
  return `${d} ${d === 1 ? 'day' : 'days'} ago`;
};

/** Human label for the Abuse Inbox lookback window — derived from the
 *  summary's `window_start_at` / `window_end_at` span (the rpc accepts
 *  a caller-supplied `since`, so the window is not always the 7-day
 *  default). A non-positive span (defensive — start at or past end)
 *  falls back to a neutral phrase. Pure — no I/O. */
export const computeWindowLabel = (start: number, end: number): string => {
  const span = end - start;
  if (span <= 0) return 'the selected window';
  if (span < HOUR_MS) {
    const m = Math.max(1, Math.round(span / MINUTE_MS));
    return `Last ${m} ${m === 1 ? 'minute' : 'minutes'}`;
  }
  if (span < DAY_MS) {
    const h = Math.max(1, Math.round(span / HOUR_MS));
    return `Last ${h} ${h === 1 ? 'hour' : 'hours'}`;
  }
  const d = Math.max(1, Math.round(span / DAY_MS));
  return `Last ${d} ${d === 1 ? 'day' : 'days'}`;
};

// ════════════════════════════════════════════════════════════════
// Copy registries — closed-list signal-kind + rpc-error copy. The
// renderer is the localization seam; the substrate never assembles
// user-facing strings.
// ════════════════════════════════════════════════════════════════

/** § A.20.5 — per-`AbuseInboxSignalKind` user-facing copy. `label` is
 *  the row chip; `description` explains what the cluster is; the
 *  `suggested_action` is the operator guidance the row surfaces beside
 *  the ban / investigate affordances. */
export const ABUSE_INBOX_SIGNAL_COPY: Readonly<
  Record<
    AbuseInboxSignalKind,
    { label: string; description: string; suggested_action: string }
  >
> = {
  spam_burst: {
    label: 'Spam burst',
    description:
      'One place sent far too many requests, over and over, and Recued turned them away.',
    suggested_action:
      'This is usually junk from a robot. Block the address if there is a lot of it, or lower how much one place may send.',
  },
  mime_rejection: {
    label: 'Wrong kind of file',
    description:
      'Someone kept uploading files of a kind this link does not accept.',
    suggested_action:
      'Usually a badly set up app, or someone poking around. Nothing was saved. Check which file kinds you allow, then block the address if it keeps happening.',
  },
  invalid_token_burst: {
    label: 'Lots of bad keys',
    description:
      'Someone kept turning up with a missing or wrong key, looking for a way in.',
    suggested_action:
      'Your keys cannot be guessed, so this is usually just noise. Block the address if it keeps growing.',
  },
  endpoint_ddos: {
    label: 'Too much traffic to one link',
    description:
      'One place sent far more than a single link can handle.',
    suggested_action:
      'Block the address to take the load off. If many addresses are involved, switch the link off until it calms down.',
  },
  oversized_upload: {
    label: 'File too big',
    description:
      'Someone tried to upload files bigger than this link allows.',
    suggested_action:
      'It might be a real big file, or someone trying to fill up your storage. Raise the limit if you expected it. Otherwise block the address.',
  },
  suspicious_payload: {
    label: 'Something suspicious was sent',
    description:
      'Someone put code into boxes that should only hold plain words.',
    suggested_action:
      'Someone was trying to slip code in. Recued removed it and saved nothing. Block the address if it keeps happening.',
  },
};

/** The rpc error codes the `reception.abuse_inbox.*` trio surfaces.
 *  `permission_denied` (the subview is admin-only — matches the § A.9
 *  admin-gate) + `bad_request` (malformed args) can come back from any
 *  of the three; `not_configured` is ban / unban only — the IP block
 *  store is optional at boot (the inbox still aggregates without it). */
export type AbuseInboxRpcErrorCode = 'permission_denied' | 'bad_request' | 'not_configured';

/** Runtime closed list of `AbuseInboxRpcErrorCode` — lets the renderer
 *  enumerate the codes + lets the copy registry's completeness be
 *  ratchet-tested (the `Record` type already enforces it at compile
 *  time; this is the runtime belt-and-suspenders, mirroring the spine's
 *  `RECEPTION_RPC_ERROR_CODES` usage). */
export const ABUSE_INBOX_RPC_ERROR_CODES: ReadonlyArray<AbuseInboxRpcErrorCode> = [
  'permission_denied',
  'bad_request',
  'not_configured',
] as const;

/** Closed-list `AbuseInboxRpcErrorCode` → remediation copy. The subview
 *  surfaces this when a `reception.abuse_inbox.*` rpc round-trip fails.
 *  Mirrors `RECEPTION_ERROR_COPY` in `spine.ts`. */
export const ABUSE_INBOX_ERROR_COPY: Readonly<Record<AbuseInboxRpcErrorCode, string>> = {
  permission_denied:
    'Only an administrator can see this. Pair this browser again with an administrator key, or open Settings on a device that has one.',
  bad_request: 'Recued could not read that request. Load the page again and try once more.',
  not_configured:
    'Recued cannot reach the list of blocked addresses, so you cannot block or unblock right now. Everything above still works. Restarting the server usually fixes it.',
};

// ════════════════════════════════════════════════════════════════
// Abuse-signal cluster row projection
// ════════════════════════════════════════════════════════════════

/** One projected Abuse Inbox cluster row — the projection of one
 *  `AbuseInboxRow`. Carries the resolved signal copy, the § A.16.7
 *  source-IP-hash display prefix, first / last-seen relative-time
 *  labels, the `ip_blocked` ban state, and the composite block key
 *  (so the renderer's ban / unban affordance fires the dispatch
 *  builder without recomputing it). */
export interface AbuseInboxRowModel {
  signal_kind: AbuseInboxSignalKind;
  signal_label: string;
  signal_description: string;
  suggested_action: string;
  endpoint_id: string;
  /** Endpoint-scoped HKDF source-IP hash (§ Must Hold I-9) — the full
   *  value, carried for the "reveal" opt-in + as the `ban_ip` arg. */
  source_ip_hash: string;
  /** 8-char display prefix of the source-IP hash (§ A.16.7) — the
   *  default-rendered form before the reveal opt-in. */
  source_ip_hash_prefix: string;
  event_count: number;
  first_seen_at: number;
  first_seen_label: string;
  last_seen_at: number;
  last_seen_label: string;
  /** Whether `(endpoint_id, source_ip_hash)` is on the per-server IP
   *  block list — drives the "Banned" badge + the ban / unban toggle. */
  ip_blocked: boolean;
  /** `abuseInboxBlockKey(endpoint_id, source_ip_hash)` — the canonical
   *  composite key, surfaced so the renderer can key its row list +
   *  match a row against the `blocked_entries` panel without rebuilding
   *  the key. */
  block_key: string;
}

/** Project one `AbuseInboxRow` into a subview row. Resolves the signal
 *  copy, truncates the source-IP hash (§ A.16.7 — via the spine's
 *  `truncateSourceIpHash`, the one truncation rule across the whole
 *  Reception Settings surface), and labels the first / last-seen
 *  stamps. Pure — no I/O. */
export const buildAbuseInboxRowModel = (
  row: AbuseInboxRow,
  now: number,
): AbuseInboxRowModel => {
  const copy = ABUSE_INBOX_SIGNAL_COPY[row.signal_kind];
  return {
    signal_kind: row.signal_kind,
    signal_label: copy.label,
    signal_description: copy.description,
    suggested_action: copy.suggested_action,
    endpoint_id: row.endpoint_id,
    source_ip_hash: row.source_ip_hash,
    source_ip_hash_prefix: truncateSourceIpHash(row.source_ip_hash),
    event_count: row.event_count,
    first_seen_at: row.first_seen_at,
    first_seen_label: computeRelativeTimeLabel(row.first_seen_at, now),
    last_seen_at: row.last_seen_at,
    last_seen_label: computeRelativeTimeLabel(row.last_seen_at, now),
    ip_blocked: row.ip_blocked,
    block_key: abuseInboxBlockKey(row.endpoint_id, row.source_ip_hash),
  };
};

// ════════════════════════════════════════════════════════════════
// IP-block-list entry projection
// ════════════════════════════════════════════════════════════════

/** One projected "currently banned" entry — the projection of one
 *  `ReceptionIpBlockEntry`. The block list is the full per-server set;
 *  a banned `(endpoint_id, source_ip_hash)` pair can have no matching
 *  cluster row (the ban worked — the traffic stopped), so this panel
 *  is genuinely separate data from the cluster rows above it. */
export interface AbuseInboxBlockedEntryModel {
  endpoint_id: string;
  source_ip_hash: string;
  source_ip_hash_prefix: string;
  blocked_at: number;
  blocked_at_label: string;
  blocked_by_client_id: string;
  reason: string | null;
  /** `abuseInboxBlockKey(endpoint_id, source_ip_hash)` — keys the panel
   *  list + cross-references the cluster rows' `block_key`. */
  block_key: string;
}

/** Project one `ReceptionIpBlockEntry` into a "currently banned" panel
 *  row. Pure — no I/O. */
export const buildAbuseInboxBlockedEntryModel = (
  entry: ReceptionIpBlockEntry,
  now: number,
): AbuseInboxBlockedEntryModel => ({
  endpoint_id: entry.endpoint_id,
  source_ip_hash: entry.source_ip_hash,
  source_ip_hash_prefix: truncateSourceIpHash(entry.source_ip_hash),
  blocked_at: entry.blocked_at,
  blocked_at_label: computeRelativeTimeLabel(entry.blocked_at, now),
  blocked_by_client_id: entry.blocked_by_client_id,
  reason: entry.reason,
  block_key: abuseInboxBlockKey(entry.endpoint_id, entry.source_ip_hash),
});

// ════════════════════════════════════════════════════════════════
// Full subview model
// ════════════════════════════════════════════════════════════════

/** The Abuse Inbox subview header — the top band of the § A.20.5
 *  subview. */
export interface AbuseInboxHeader {
  /** Total surfaced clusters (= `summary.total_signals`). */
  total_signals: number;
  /** True iff zero clusters surfaced — drives the "No abuse signals in
   *  this window" empty state. The IP block list can still be
   *  non-empty (a successful ban stops the traffic that produced the
   *  cluster), so `is_empty` is about the clusters only. */
  is_empty: boolean;
  window_start_at: number;
  window_end_at: number;
  /** Human label for the lookback window — "Last 7 days" for the rpc
   *  default, derived from the actual span otherwise. */
  window_label: string;
  cluster_threshold: number;
  /** "Showing clusters of N or more events" — explains why a single
   *  drive-by hit is not a row (a cluster is the signal; one hit is
   *  noise). */
  threshold_explanation: string;
  /** Count of currently-banned `(endpoint_id, source_ip_hash)` pairs. */
  blocked_count: number;
}

/** Full Reception → Abuse Inbox subview model. */
export interface AbuseInboxSubviewModel {
  header: AbuseInboxHeader;
  /** Abuse-signal cluster rows, most-recent-abuse-first (the rpc /
   *  `buildAbuseInbox` already sorts by `last_seen_at` desc, tiebroken
   *  on `event_count` desc; this projection preserves it). */
  rows: ReadonlyArray<AbuseInboxRowModel>;
  /** The per-server IP block list ("currently banned"), in the rpc's
   *  returned order. */
  blocked_entries: ReadonlyArray<AbuseInboxBlockedEntryModel>;
}

/** Build the renderable Abuse Inbox subview model from the
 *  `reception.abuse_inbox.list` rpc result (`summary` + `blocked`).
 *  Pure projection — the page shell re-runs it after a `ban_ip` /
 *  `unban_ip` round-trip by refetching the list (there is no abuse-
 *  inbox broadcast — see the module docstring). */
export const buildAbuseInboxSubviewModel = (args: {
  summary: AbuseInboxSummary;
  blocked: ReadonlyArray<ReceptionIpBlockEntry>;
  now: number;
}): AbuseInboxSubviewModel => {
  const { summary, blocked, now } = args;
  const threshold = summary.cluster_threshold;
  return {
    header: {
      total_signals: summary.total_signals,
      is_empty: summary.total_signals === 0,
      window_start_at: summary.window_start_at,
      window_end_at: summary.window_end_at,
      window_label: computeWindowLabel(summary.window_start_at, summary.window_end_at),
      cluster_threshold: threshold,
      threshold_explanation: `Showing clusters of ${threshold} or more. One stray hit is nothing. A lot of them means something.`,
      blocked_count: blocked.length,
    },
    rows: summary.rows.map((row) => buildAbuseInboxRowModel(row, now)),
    blocked_entries: blocked.map((entry) => buildAbuseInboxBlockedEntryModel(entry, now)),
  };
};

// ════════════════════════════════════════════════════════════════
// Dispatch builders
// ════════════════════════════════════════════════════════════════
//
// The renderer never fires the rpc; it shapes the payload + hands it
// to the page shell, which calls the `reception.abuse_inbox.*` rpc
// over the WS conn. Same separation as `buildPresetDispatch` in
// exposure-surface.ts + the spine's lifecycle dispatch builders.

/** Payload for `reception.abuse_inbox.list`. All fields optional — the
 *  rpc fills the defaults server-side (`since` ⇒ `now - 7d`,
 *  `cluster_threshold` ⇒ 3); the shell passes `{}` for the default
 *  view. */
export interface AbuseInboxListDispatch {
  op: 'reception.abuse_inbox.list';
  since?: number;
  limit?: number;
  cluster_threshold?: number;
}

/** Payload for `reception.abuse_inbox.ban_ip` — appends
 *  `(endpoint_id, source_ip_hash)` to the per-server block list the
 *  path-listener enforces. Idempotent server-side (a re-ban returns
 *  `created: false`). */
export interface AbuseInboxBanIpDispatch {
  op: 'reception.abuse_inbox.ban_ip';
  endpoint_id: string;
  source_ip_hash: string;
  reason?: string;
}

/** Payload for `reception.abuse_inbox.unban_ip` — removes the pair
 *  from the block list. Idempotent server-side (unbanning a pair not
 *  on the list returns `removed: false`). */
export interface AbuseInboxUnbanIpDispatch {
  op: 'reception.abuse_inbox.unban_ip';
  endpoint_id: string;
  source_ip_hash: string;
}

export type AbuseInboxDispatch =
  | AbuseInboxListDispatch
  | AbuseInboxBanIpDispatch
  | AbuseInboxUnbanIpDispatch;

export const buildAbuseInboxListDispatch = (args: {
  since?: number;
  limit?: number;
  cluster_threshold?: number;
}): AbuseInboxListDispatch => ({
  op: 'reception.abuse_inbox.list',
  ...(args.since !== undefined ? { since: args.since } : {}),
  ...(args.limit !== undefined ? { limit: args.limit } : {}),
  ...(args.cluster_threshold !== undefined
    ? { cluster_threshold: args.cluster_threshold }
    : {}),
});

export const buildAbuseInboxBanIpDispatch = (args: {
  endpoint_id: string;
  source_ip_hash: string;
  reason?: string;
}): AbuseInboxBanIpDispatch => ({
  op: 'reception.abuse_inbox.ban_ip',
  endpoint_id: args.endpoint_id,
  source_ip_hash: args.source_ip_hash,
  ...(args.reason !== undefined ? { reason: args.reason } : {}),
});

export const buildAbuseInboxUnbanIpDispatch = (args: {
  endpoint_id: string;
  source_ip_hash: string;
}): AbuseInboxUnbanIpDispatch => ({
  op: 'reception.abuse_inbox.unban_ip',
  endpoint_id: args.endpoint_id,
  source_ip_hash: args.source_ip_hash,
});

/** Re-export of the closed signal-kind list + the default cluster
 *  threshold so the renderer can enumerate the legend / filter chips +
 *  explain the default without a second `@recued/contracts` import. */
export { ABUSE_INBOX_SIGNAL_KINDS, ABUSE_INBOX_DEFAULT_CLUSTER_THRESHOLD };
