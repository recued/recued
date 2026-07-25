/** D-137 W2.3 § A.1.1 + § A.10 — Settings → Connections → MCP install
 *  flow + per-tool classification UI helpers.
 *
 *  Pure projection of Mary's per-connection MCP tool annotation +
 *  the upstream `tools/list` cache into the per-row UI model the
 *  Settings page iterates. Two surfaces share these helpers:
 *
 *    - **Enrollment dialog** (Settings → Connections → Add MCP) —
 *      first-classification UI: rows surface every cached tool with
 *      Mary's classification dropdown (`read` / `write` / `unknown`)
 *      + enable toggle + per-tool topic-tag override input.
 *    - **Per-connection management page** (Settings → Connections →
 *      `<name>` → Tools) — same surface for ongoing edits + re-
 *      classification prompts when upstream advertises new tools.
 *
 *  No business logic — the page reads server state via
 *  `chat.connection_mcp.get` / `chat.connection_mcp.list` rpc + listens
 *  to `chat.connection_mcp_annotation_changed` broadcasts. Writes via
 *  `chat.connection_mcp.set`; the server validates + returns the
 *  canonical shape (which the broadcast re-fans).
 *
 *  Per D-148 § A.4 invariant — the webclient projects server-supplied
 *  state only, NEVER synthesizes. When the server snapshot is
 *  unavailable (pre-fetch, store unwired) the model surfaces a
 *  `'pending'` discriminator distinct from a fully-empty-but-loaded
 *  annotation.
 */

import {
  buildDefaultConnectionMcpAnnotation,
  isTier3ToolClassification,
  TIER3_TOOL_CLASSIFICATIONS,
  type ConnectionMcpAnnotationState,
  type ConnectionMcpToolOverride,
  type McpToolDescriptor,
  type Tier3ToolClassification,
} from '@recued/contracts';

/** § A.10 — per-tool row in the enrollment / management UI. Keyed on
 *  the upstream tool name; carries the override + descriptor + a
 *  derived `visible` flag matching the substrate's "tool surfaces iff
 *  enabled && classified" rule. */
export interface ChatConnectionMcpToolRow {
  /** Upstream tool name (NOT the formatted `<connection>.<tool>`). */
  tool_name: string;
  /** § A.10 — Mary's current override OR a sentinel `'unset'` shape
   *  for tools the probe just learned about but Mary has not yet
   *  classified. The renderer uses the discriminator to surface the
   *  "needs classification" badge. */
  override:
    | { kind: 'unset' }
    | { kind: 'set'; value: ConnectionMcpToolOverride };
  /** Upstream-advertised description (renderer copies into a tooltip).
   *  Empty when missing. */
  description: string;
  /** Upstream-advertised `destructive_hint` from the MCP annotations
   *  (informational — Mary's classification is the load-bearing gate). */
  destructive_hint: boolean;
  /** Derived: `true` iff override is set AND `enabled` AND
   *  `classification !== 'unknown'`. Drives the per-row visibility
   *  badge ("visible in chat" vs "hidden"). */
  visible: boolean;
}

/** § A.10 — full resolved render model for one connection. */
export interface ChatConnectionMcpAnnotationModel {
  kind: 'resolved';
  connection_name: string;
  topic_tags: ReadonlyArray<string>;
  rows: ReadonlyArray<ChatConnectionMcpToolRow>;
  /** Wall-clock at last server write. `0` means the substrate default
   *  is still in effect (no row written yet). */
  updated_at: number;
  /** Wall-clock at last upstream `tools/list` probe. `0` means the
   *  probe has never run (substrate-default annotation; Mary has not
   *  yet enrolled the connection or the probe is still queued). */
  cached_at: number;
  /** Convenience counts the page header renders without re-walking
   *  rows. */
  total_count: number;
  visible_count: number;
  unclassified_count: number;
}

export interface ChatConnectionMcpAnnotationPendingModel {
  kind: 'pending';
  connection_name: string;
  topic_tags: readonly [];
  rows: readonly [];
  updated_at: 0;
  cached_at: 0;
  total_count: 0;
  visible_count: 0;
  unclassified_count: 0;
}

export type ChatConnectionMcpAnnotationRenderModel =
  | ChatConnectionMcpAnnotationModel
  | ChatConnectionMcpAnnotationPendingModel;

/** § A.10 — closed-list copy for each `Tier3ToolClassification`. The
 *  enrollment UI renders one button per entry. */
export const CHAT_CONNECTION_MCP_CLASSIFICATION_COPY: Readonly<Record<
  Tier3ToolClassification,
  { label: string; description: string; risk_tier: 'safe' | 'risky' | 'unset' }
>> = {
  read: {
    label: 'Read',
    description:
      'Tool only reads data — search / list / fetch endpoints. Surfaces in the chat catalog when enabled.',
    risk_tier: 'safe',
  },
  write: {
    label: 'Write',
    description:
      'Tool modifies state — index / delete / update endpoints. Routes through plan-approval before each call (P3 substrate; W2.3 ships the classification gate only).',
    risk_tier: 'risky',
  },
  unknown: {
    label: 'Unclassified',
    description:
      'Default for newly-advertised tools. Stays invisible to the chat catalog until Mary picks Read or Write.',
    risk_tier: 'unset',
  },
} as const;

const EMPTY_TOOL_TAGS: readonly string[] = [];

/** § A.10 — derive the visibility flag for one tool row. Substrate-
 *  pure: same inputs → same output. */
export const isChatConnectionMcpToolVisible = (
  override: ConnectionMcpToolOverride | undefined,
): boolean => {
  if (!override) return false;
  if (!override.enabled) return false;
  if (override.classification === 'unknown') return false;
  return true;
};

/** § A.10 — build one ChatConnectionMcpToolRow from the cached
 *  descriptor + (optional) override. Substrate-pure. */
export const buildChatConnectionMcpToolRow = (
  descriptor: McpToolDescriptor,
  override: ConnectionMcpToolOverride | undefined,
): ChatConnectionMcpToolRow => ({
  tool_name: descriptor.name,
  override: override ? { kind: 'set', value: override } : { kind: 'unset' },
  description: typeof descriptor.description === 'string'
    ? descriptor.description
    : '',
  destructive_hint: descriptor.destructive_hint === true,
  visible: isChatConnectionMcpToolVisible(override),
});

/** § A.10 — full snapshot → model projection. Returns a `'pending'`
 *  discriminator when snapshot is null / shape-broken. The page reads
 *  this model directly; rows are sorted by upstream tool name
 *  (`name` ascending) for deterministic ordering. */
export const buildChatConnectionMcpAnnotationModel = (
  snapshot: ConnectionMcpAnnotationState | null | undefined,
): ChatConnectionMcpAnnotationRenderModel => {
  if (
    !snapshot
    || typeof snapshot.connection_name !== 'string'
    || snapshot.connection_name.length === 0
  ) {
    return {
      kind: 'pending',
      connection_name: snapshot?.connection_name ?? '',
      topic_tags: [],
      rows: [],
      updated_at: 0,
      cached_at: 0,
      total_count: 0,
      visible_count: 0,
      unclassified_count: 0,
    };
  }
  const tags = Array.isArray(snapshot.topic_tags)
    ? snapshot.topic_tags.filter((t): t is string => typeof t === 'string')
    : EMPTY_TOOL_TAGS;
  const tools = Array.isArray(snapshot.tools_list_cache?.tools)
    ? snapshot.tools_list_cache.tools
    : EMPTY_TOOL_TAGS;
  const rows: ChatConnectionMcpToolRow[] = [];
  let visible_count = 0;
  let unclassified_count = 0;
  for (const desc of tools as ReadonlyArray<McpToolDescriptor>) {
    if (!desc || typeof desc.name !== 'string' || desc.name.length === 0) continue;
    const override = snapshot.tool_overrides[desc.name];
    const row = buildChatConnectionMcpToolRow(desc, override);
    rows.push(row);
    if (row.visible) visible_count += 1;
    if (row.override.kind === 'unset' || row.override.value.classification === 'unknown') {
      unclassified_count += 1;
    }
  }
  rows.sort((a, b) => (a.tool_name < b.tool_name ? -1 : a.tool_name > b.tool_name ? 1 : 0));
  return {
    kind: 'resolved',
    connection_name: snapshot.connection_name,
    topic_tags: tags,
    rows,
    updated_at: snapshot.updated_at,
    cached_at: snapshot.tools_list_cache?.cached_at ?? 0,
    total_count: rows.length,
    visible_count,
    unclassified_count,
  };
};

/** § A.10 — pre-flight evaluator for a single per-tool toggle. Returns
 *  the next `tool_overrides` object preserving every other entry. Used
 *  by the enable-toggle button in the per-tool row. Idempotent on
 *  no-op. */
export const projectToggledConnectionMcpTool = (args: {
  current: Readonly<Record<string, ConnectionMcpToolOverride>>;
  tool_name: string;
  next_enabled: boolean;
}): Record<string, ConnectionMcpToolOverride> => {
  const out: Record<string, ConnectionMcpToolOverride> = Object.create(null);
  for (const [k, v] of Object.entries(args.current)) {
    out[k] = v;
  }
  const existing = out[args.tool_name];
  if (!existing) {
    // Toggle on a tool with no override row yet — seed with the
    // upstream-defaulting `'unknown'` classification. The tool stays
    // invisible until Mary picks read/write, but enabling it surfaces
    // the row for follow-up classification. The webclient renderer
    // typically pairs the enable-toggle with the classification UI in
    // a single save action, so this `'unknown'` intermediate state
    // is mostly transient.
    out[args.tool_name] = {
      enabled: args.next_enabled,
      classification: 'unknown',
    };
    return out;
  }
  if (existing.enabled === args.next_enabled) return out;
  out[args.tool_name] = {
    ...existing,
    enabled: args.next_enabled,
  };
  return out;
};

/** § A.10 — pre-flight evaluator for the classification dropdown.
 *  Returns the next `tool_overrides` object preserving other entries.
 *  Rejects off-list values silently (returns the unchanged map);
 *  callers gate via `isTier3ToolClassification` before invoking. */
export const projectClassifiedConnectionMcpTool = (args: {
  current: Readonly<Record<string, ConnectionMcpToolOverride>>;
  tool_name: string;
  next_classification: Tier3ToolClassification;
}): Record<string, ConnectionMcpToolOverride> => {
  if (!isTier3ToolClassification(args.next_classification)) {
    const out: Record<string, ConnectionMcpToolOverride> = Object.create(null);
    for (const [k, v] of Object.entries(args.current)) out[k] = v;
    return out;
  }
  const out: Record<string, ConnectionMcpToolOverride> = Object.create(null);
  for (const [k, v] of Object.entries(args.current)) {
    out[k] = v;
  }
  const existing = out[args.tool_name];
  if (!existing) {
    out[args.tool_name] = {
      // New tool — seed with disabled+classification so Mary's pick
      // takes effect only after she explicitly toggles `enabled: true`.
      // Matches the spec § A.10 default-deny posture.
      enabled: false,
      classification: args.next_classification,
    };
    return out;
  }
  out[args.tool_name] = {
    ...existing,
    classification: args.next_classification,
  };
  return out;
};

/** § A.10 — pure reducer over the broadcast event. The Settings page
 *  invokes this on each `chat.connection_mcp_annotation_changed` to
 *  refresh the per-connection model. The reducer re-validates the
 *  wire shape — off-list classifications drop silently (same
 *  invariant as `buildChatConnectionMcpAnnotationModel`). */
export const reduceChatConnectionMcpAnnotationChanged = (
  current: ChatConnectionMcpAnnotationRenderModel,
  event: {
    connection_name: string;
    annotation: unknown;
  },
): ChatConnectionMcpAnnotationRenderModel => {
  // The current model is replaced wholesale — the broadcast carries
  // the canonical shape; we re-project from scratch. `current` is
  // referenced only to scope the diff in tests (it has no effect on
  // the projection itself).
  void current;
  const ann = event.annotation as
    | ConnectionMcpAnnotationState
    | null
    | undefined;
  if (!ann || typeof ann !== 'object' || Array.isArray(ann)) {
    return buildChatConnectionMcpAnnotationModel(
      buildDefaultConnectionMcpAnnotation(event.connection_name),
    );
  }
  // Use the wire-supplied connection_name verbatim — the server's
  // store key is the source of truth (event field).
  return buildChatConnectionMcpAnnotationModel({
    ...ann,
    connection_name: event.connection_name,
  });
};

/** § A.10 — closed-list classification options for the dropdown
 *  renderer. Mirrors `TIER3_TOOL_CLASSIFICATIONS` order. */
export const buildChatConnectionMcpClassificationOptions = (): ReadonlyArray<{
  value: Tier3ToolClassification;
  label: string;
  description: string;
  risk_tier: 'safe' | 'risky' | 'unset';
}> => TIER3_TOOL_CLASSIFICATIONS.map((value) => ({
  value,
  ...CHAT_CONNECTION_MCP_CLASSIFICATION_COPY[value],
}));
