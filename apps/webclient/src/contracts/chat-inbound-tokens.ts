/** D-137 P5 follow-on § A.9 — agent credential renderer substrate.
 *
 *  Pure projection of Bob's per-pair `McpInboundTokenRecord` rows +
 *  the live `ToolCatalogEntryView[]` catalog into the per-token UI model the
 *  Contracts page iterates. Two views share these helpers:
 *
 *    - **Agent credential inventory** (`#contracts`) — list of every
 *      issued token with label / peer / status / per-token capability
 *      summary. Row click navigates to the detail page.
 *    - **Per-token detail** (`#contracts` → `<label>`) —
 *      per-tool checklist grouped by ingredient kind with kind-level
 *      master toggles (all-on / all-off / mixed) + concurrency-tier
 *      picker + chat-mode picker + capability summary chip strip.
 *
 *  No business logic — the page reads server state via
 *  `chat.inbound_token.list` / `chat.inbound_token.get` rpc + listens
 *  to `chat.inbound_token_changed` broadcasts. Writes via
 *  `chat.inbound_token.{issue, update_grants, revoke, delete}`; the
 *  server validates + returns the canonical shape (which the broadcast
 *  re-fans on every state-changing op).
 *
 *  Per D-148 § A.4 invariant — the webclient projects server-supplied
 *  state only, NEVER synthesizes. When the server snapshot is
 *  unavailable (pre-fetch, store unwired) the model surfaces a
 *  `'pending'` discriminator distinct from a fully-empty-but-loaded
 *  registry.
 */

import {
  buildDefaultMcpInboundTokenGrants,
  isMcpInboundConcurrencyTier,
  isMcpInboundTokenActive,
  isMcpInboundTokenToolAuthorized,
  MCP_INBOUND_CONCURRENCY_LADDER,
  MCP_INBOUND_TOKEN_DEFAULT_EXPIRY_MS,
  summarizeMcpInboundTokenCapability,
  type DependencyReadAdmission,
  type IngredientKind,
  type McpInboundConcurrencyTier,
  type McpInboundTokenChatMode,
  type McpInboundTokenRecord,
  type Tier1ToolName,
  type ToolCatalogEntryView,
} from '@recued/contracts';

/** § A.9 — closed-list copy for each `McpInboundConcurrencyTier`. The
 *  per-token detail page renders one button per entry. Substrate-pure. */
export const CHAT_INBOUND_TOKEN_CONCURRENCY_COPY: Readonly<Record<
  McpInboundConcurrencyTier,
  { label: string; description: string }
>> = {
  3: {
    label: 'Conservative',
    description:
      'Up to 3 things at once. This suits people you know well, where a rush is rare.',
  },
  5: {
    label: 'Balanced',
    description:
      'Up to 5 things at once. This suits most sharing, and covers a few steps running together.',
  },
  10: {
    label: 'Power user',
    description:
      'Up to 10 things at once. This is for heavy use, like build systems or a big team.',
  },
} as const;

/** D-171 slice-2c follow-on #1 — the grant checklist groups by ingredient
 *  kind PLUS three synthetic buckets for the legacy inbound `tools/list`
 *  surface that `handleToolsList` advertises + the per-token gate enforces:
 *    - `recued_native` — the static `recued_*` meta tools (run / save / list
 *      recipes, audit, timeline, registry/enrichment/vector reads).
 *    - `recued_ingredient` — the dynamic `recued_ingredient_<slug>` tools that
 *      call one ingredient directly.
 *    - `recued_op` — D-182 §8 raw catalog ops `recued_op_<publisher>.<pack>.<operation>`
 *      a door may invoke directly (no recipe). Distinct from `recued_ingredient`
 *      (operation-level, not ingredient-level) and MUST NOT fall into the bare
 *      `recued_native` bucket — without this, the `recued_op_` prefix would match
 *      the `recued_` server-tools prefix and mislabel raw ops as Recued's own
 *      meta tools.
 *  These aren't `IngredientKind`s (they're not registry entries); the catalog
 *  provider projects them as `ToolCatalogEntryView` and `inferChatInboundTokenToolKind`
 *  groups them by NAME PREFIX. Distinct buckets (not folded into the
 *  ingredient-kind groups) keep their per-bucket master toggle from
 *  accidentally granting raw ingredient / raw operation / server-control access
 *  alongside the curated registry tools. */
export type ChatInboundTokenGroupKind =
  | IngredientKind
  | 'recued_native'
  | 'recued_ingredient'
  | 'recued_op';

/** § A.9 — closed-list ingredient-kind copy (+ the two D-171 legacy buckets +
 *  the D-182 §8 raw-op bucket). Renders kind-level master toggle headers +
 *  collapsed-section labels. Substrate-pure. */
export const CHAT_INBOUND_TOKEN_KIND_COPY: Readonly<Record<
  ChatInboundTokenGroupKind,
  { label: string; description: string }
>> = {
  http: {
    label: 'HTTP',
    description: 'Reading from and writing to other services over the web.',
  },
  dom: {
    label: 'Browser DOM',
    description:
      'Reading and changing whatever web pages you have open, through the Browser Bridge.',
  },
  ai: {
    label: 'AI inference',
    description:
      'Using AI on this machine to sort, score, pull out facts, or sum things up.',
  },
  chat: {
    label: 'Chat',
    description:
      'Talking to your Chat, where their AI reads the answer. The chat setting below controls this.',
  },
  mcp: {
    label: 'Recipes that use another AI app',
    description:
      'Recipes with a step that calls another AI app you have connected. '
      + 'That app’s own tools are not here. Recued puts them into a Pack, '
      + 'so you will find them under “Direct operation calls” below.',
  },
  service: {
    label: 'Long-running service',
    description:
      'Jobs that keep running in the background and watch for changes.',
  },
  storage: {
    label: 'Local storage',
    description:
      'Reading and writing your own things: mail, calendar, contacts, files and memories.',
  },
  connection: {
    label: 'Outbound connection',
    description:
      'Keeping services like HubSpot and Salesforce in step, and listening for what they send.',
  },
  cli: {
    label: 'Local tools',
    description:
      'Programs on your own machine, like whisper, docling, ffmpeg and imagemagick. '
      + 'Only Recipes can use these. They are never offered directly through a '
      + 'door, so this list stays empty here.',
  },
  recued_native: {
    label: 'Recued server tools',
    description:
      'Recued’s own tools: running, saving and listing Recipes, reading what happened, '
      + 'seeing a timeline, and looking through your things. These are powerful. Only allow what '
      + 'this connection actually needs.',
  },
  recued_ingredient: {
    label: 'Direct ingredient calls',
    description:
      'Call a single ingredient directly (one tool per installed '
      + 'ingredient). Advanced — agents normally use recipes; granting these '
      + 'lets a connection invoke raw ingredients.',
  },
  recued_op: {
    label: 'Direct operation calls',
    description:
      'Call a single catalog operation directly — one tool per installed '
      + 'pack operation (publisher/pack.operation). This is also where an '
      + 'enrolled MCP server’s own tools live: Recued mints them into a pack, '
      + 'one operation per tool. Advanced — like direct ingredient calls, these '
      + 'let a connection invoke a raw operation without a recipe (D-182 §8). '
      + 'Reads default on; writes default off (recipe-preferred).',
  },
} as const;

/** § A.9 — per-tool row in the per-token detail UI. Keyed on the
 *  catalog's `ToolCatalogEntryView.name`; carries the live grant state + the
 *  catalog's classification + tier so the renderer can paint the
 *  per-row badge. */
export interface ChatInboundTokenToolRow {
  tool_name: string;
  /** Mirrors `ToolCatalogEntryView.tier` so the renderer can paint `T1` / `T2` /
   *  `T3` chips alongside the per-tool checkbox. */
  tier: 1 | 2 | 3;
  /** From `ToolCatalogEntryView.classification` — `read` / `write` / `unknown`.
   *  Drives the per-row risk badge. */
  classification: 'read' | 'write' | 'unknown';
  /** Live grant state (current vs the substrate's default-deny posture).
   *  `granted` mirrors the persisted token grant; `default_grant`
   *  reflects the substrate's default for THIS tool — useful for the
   *  "Bob unchecked a normally-on read tool" heuristic in the renderer. */
  granted: boolean;
  default_grant: boolean;
  /** `ToolCatalogEntryView.description` — surfaces in tooltip / expander. Empty
   *  string when missing on the catalog entry. */
  description: string;
  /** D-192 Slice 7 — the container reads granting this raw op transitively
   *  admits (`ToolCatalogEntryView.also_reads`). Drives the per-tool "also reads: …"
   *  disclosure; absent when the tool admits none. */
  also_reads?: ReadonlyArray<DependencyReadAdmission>;
}

/** § A.9 — per-kind grouping row in the per-token detail UI. Carries
 *  the master-toggle state (`'all'` / `'none'` / `'mixed'`) + the
 *  per-tool rows nested underneath. */
export interface ChatInboundTokenKindGroup {
  kind: ChatInboundTokenGroupKind;
  master: 'all' | 'none' | 'mixed';
  rows: ReadonlyArray<ChatInboundTokenToolRow>;
}

/** § A.9 — full resolved render model for one token's detail page. */
export interface ChatInboundTokenDetailModel {
  kind: 'resolved';
  token_id: string;
  label: string;
  /** Mirrors the canonical record's optional `peer_handle`. Renderer
   *  paints the chip "for peer: <handle>" when present. */
  peer_handle?: string;
  active: boolean;
  /** Wall-clock when this token was issued. */
  created_at: number;
  /** Wall-clock when revoked. `null` = active. Renderer paints the
   *  banner "Revoked at <date>" when set. */
  revoked_at: number | null;
  /** Wall-clock at last grants edit. Renderer surfaces "last updated
   *  <relative>" alongside. */
  updated_at: number;
  concurrency_tier: McpInboundConcurrencyTier;
  /** Bob's per-token chat-mode metadata. `null` = not offered (default).
   *  Renderer paints the toggle + the optional session-cap inputs. */
  chat_mode: McpInboundTokenChatMode;
  /** Capability summary buckets — `summarizeMcpInboundTokenCapability`
   *  output. Renderer paints the chip strip "Can: read mail, read
   *  calendar. Cannot: send mail, run recipes." */
  summary: ReturnType<typeof summarizeMcpInboundTokenCapability>;
  groups: ReadonlyArray<ChatInboundTokenKindGroup>;
}

export interface ChatInboundTokenDetailPendingModel {
  kind: 'pending';
  token_id: string;
}

export type ChatInboundTokenDetailRenderModel =
  | ChatInboundTokenDetailModel
  | ChatInboundTokenDetailPendingModel;

/** § A.9 — table-row render model for the agent credential list view. */
export interface ChatInboundTokenTableRow {
  token_id: string;
  label: string;
  peer_handle?: string;
  active: boolean;
  created_at: number;
  revoked_at: number | null;
  concurrency_tier: McpInboundConcurrencyTier;
  /** Pre-counted "N tools allowed" stat the table column renders
   *  without re-projecting the full summary. Sums every per-tool grant
   *  that's `true` AND present in the catalog (stale grants on
   *  uninstalled recipes / removed connections are excluded). */
  granted_count: number;
  /** Pre-counted total catalog size — denominator for "N / M tools". */
  catalog_count: number;
  /** Mirrors `chat_mode.offered` for the table chip. `null` ⇒ false. */
  chat_mode_offered: boolean;
}

/** § A.9 — single-source-of-truth grouping of tool entries by their
 *  underlying ingredient kind. Tier 1 has an implicit kind per
 *  `TIER1_TO_INGREDIENT_KIND`; Tier 2 reads `requires_kinds[0]` (the
 *  primary kind from the recipe's step graph — recipes carrying mixed
 *  kinds default to the first one for grouping; the dispatcher still
 *  enforces Mary's per-kind catalog scope across ALL `requires_kinds`).
 *
 *  ⚠ D-228 slice 4 — the trailing `'mcp'` is a TOTAL-FUNCTION FALLBACK, not a
 *  tier rule. It used to read "Tier 3 always groups under `'mcp'`", and that
 *  tier is retired: an enrolled MCP server's tools are minted into a pack and
 *  reach this checklist as `recued_op_*` rows, which the prefix branch above
 *  catches long before any tier check. Nothing produces a tier-3 entry today, so
 *  this branch is unreachable — kept because the function must be total.
 *
 *  Substrate-pure: same `ToolCatalogEntryView` → same kind. Returns `'connection'`
 *  for any T1 not in the static map (defensive — the closed Tier1
 *  type means this branch is unreachable today, but the fallback keeps
 *  the renderer paintable if the catalog grows).
 */
const TIER1_TO_INGREDIENT_KIND: Readonly<Record<Tier1ToolName, IngredientKind>> = {
  'contact.search': 'storage',
  'mail.search': 'storage',
  'calendar.search': 'storage',
  'memory.search': 'storage',
  // D-198 — memory.write lands in the local user_memory warehouse (storage).
  'memory.write': 'storage',
  'enrichment.search': 'storage',
  'deal.search': 'connection',
  'account.search': 'connection',
  // D-192 — local work-entity warehouse reads (escalation is a
  // gateway-gated follow-on inside the handler, not the tool's home).
  'work.search': 'storage',
  'work.read': 'storage',
  // Slice 1 — `work.create` writes the LOCAL work graph, no connection.
  'work.create': 'storage',
  // Slice 2 — calendar writes go through the calendar STACK, which is a local
  // warehouse mirror even when the provider behind it is remote. Same kind as
  // `calendar.search` above, which reads that same mirror.
  'calendar.create': 'storage',
  'calendar.update': 'storage',
  'work.update': 'storage',
  // D-172 P2 — file.search reads the data.file warehouse collection.
  'file.search': 'storage',
  'recipe.run': 'storage',
  // D-259 § 7.4.3 — `recipe.stop` ends a run the caller started. Same home as
  // `recipe.run`: it reaches the local in-flight registry and the engine, never
  // a connection.
  'recipe.stop': 'storage',
} as const;

export const inferChatInboundTokenToolKind = (
  entry: ToolCatalogEntryView,
): ChatInboundTokenGroupKind => {
  // D-171 slice-2c follow-on #1 — the legacy inbound surface is grouped by
  // NAME PREFIX, independent of the synthetic `tier: 2` the catalog provider
  // stamps on it. Order matters: `recued_ingredient_` and `recued_op_` are both
  // sub-prefixes of the bare `recued_` server-tools prefix, so they MUST be
  // tested first (else a raw op `recued_op_<opid>` would mislabel as
  // `recued_native`). The two sub-prefixes are mutually exclusive, so their
  // relative order is irrelevant. Registry Tier 1 names are dot-separated
  // (`contact.search`) and Tier 2 are `<publisher>/<recipe_id>` — neither
  // collides with the `recued_` prefix space.
  // NB: `'recued_op_'` mirrors `RAW_OP_TOOL_PREFIX` (contracts `chat.ts`) /
  // `OP_TOOL_PREFIX` (`backend/server/src/mcp-server.ts`) — hardcoded here to
  // match the sibling prefix literals above; the unit test pins the mapping.
  if (entry.name.startsWith('recued_ingredient_')) return 'recued_ingredient';
  if (entry.name.startsWith('recued_op_')) return 'recued_op';
  if (entry.name.startsWith('recued_')) return 'recued_native';
  if (entry.tier === 1) {
    const t1 = TIER1_TO_INGREDIENT_KIND[entry.name as Tier1ToolName];
    if (t1) return t1;
    return 'connection';
  }
  if (entry.tier === 2) {
    const required = entry.requires_kinds;
    if (Array.isArray(required) && required.length > 0) {
      // Pick the first kind in the recipe manifest's `requires_kinds`
      // as the primary grouping. Recipes that span kinds (e.g. mail +
      // ai) sort under the first one in the manifest's declared order.
      // The orchestrator's per-kind catalog scope check (§ A.1.1) still
      // filters across the FULL `requires_kinds` set — this grouping
      // is renderer-only.
      return required[0] as IngredientKind;
    }
    // Manifest didn't declare requires_kinds (legacy recipe): default
    // to 'storage' since most stock recipes touch the personal
    // warehouse. The renderer paints a "kind unknown" badge alongside.
    return 'storage';
  }
  // Unreachable today (see the header): tier 1 and 2 are the only tiers a
  // producer emits, and the `recued_*` prefixes are handled above. Total by
  // construction rather than by exhaustiveness, so a future tier groups
  // somewhere paintable instead of throwing at the renderer.
  return 'mcp';
};

/** § A.9 — pure helper: derive the master-toggle state for a per-kind
 *  group. `'all'` when every row is granted; `'none'` when zero are;
 *  `'mixed'` otherwise. Empty groups (no rows) collapse to `'none'`
 *  (renderer hides the section entirely). */
export const deriveChatInboundTokenKindMaster = (
  rows: ReadonlyArray<ChatInboundTokenToolRow>,
): 'all' | 'none' | 'mixed' => {
  if (rows.length === 0) return 'none';
  let granted = 0;
  for (const r of rows) {
    if (r.granted) granted += 1;
  }
  if (granted === 0) return 'none';
  if (granted === rows.length) return 'all';
  return 'mixed';
};

/** § A.9 — full snapshot → detail-model projection. Returns a
 *  `'pending'` discriminator when snapshot is null (renderer paints
 *  the per-page skeleton). */
export const buildChatInboundTokenDetailModel = (args: {
  token: McpInboundTokenRecord | null | undefined;
  catalog: ReadonlyArray<ToolCatalogEntryView>;
  now: number;
}): ChatInboundTokenDetailRenderModel => {
  const { token, catalog, now } = args;
  if (!token || typeof token.token_id !== 'string' || token.token_id.length === 0) {
    return {
      kind: 'pending',
      token_id: token?.token_id ?? '',
    };
  }
  const defaults = buildDefaultMcpInboundTokenGrants(catalog);
  // Group catalog entries by inferred kind. Walk catalog in given order
  // (assumed canonical from the registry) — keeps the per-group row
  // order stable across renders.
  const groupedRows = new Map<
    ChatInboundTokenGroupKind,
    ChatInboundTokenToolRow[]
  >();
  for (const entry of catalog) {
    if (!entry || typeof entry.name !== 'string' || entry.name.length === 0) continue;
    const kind = inferChatInboundTokenToolKind(entry);
    const granted = isMcpInboundTokenToolAuthorized(token, entry.name, now);
    const row: ChatInboundTokenToolRow = {
      tool_name: entry.name,
      tier: entry.tier,
      classification: entry.classification,
      granted,
      default_grant: defaults[entry.name] === true,
      description: typeof entry.description === 'string' ? entry.description : '',
      ...(Array.isArray(entry.also_reads) && entry.also_reads.length > 0
        ? { also_reads: entry.also_reads }
        : {}),
    };
    let existing = groupedRows.get(kind);
    if (!existing) {
      existing = [];
      groupedRows.set(kind, existing);
    }
    existing.push(row);
  }
  // Project into the closed-list grouping order (matches
  // `INGREDIENT_KINDS` declaration order — keeps the page deterministic
  // across renders + matches the per-kind catalog scope toggle layout
  // in `chat-tool-catalog.ts`).
  const orderedKinds: ReadonlyArray<ChatInboundTokenGroupKind> = [
    'storage',
    'mcp',
    'http',
    'dom',
    'ai',
    'chat',
    'service',
    'connection',
    // D-171 slice-2c follow-on #1 — the legacy buckets render last (after the
    // curated registry kinds): Recued's own server tools, then raw direct
    // ingredient calls, then D-182 §8 raw catalog operation calls.
    'recued_native',
    'recued_ingredient',
    'recued_op',
  ];
  const groups: ChatInboundTokenKindGroup[] = [];
  for (const kind of orderedKinds) {
    const rows = groupedRows.get(kind) ?? [];
    if (rows.length === 0) continue;
    groups.push({
      kind,
      master: deriveChatInboundTokenKindMaster(rows),
      rows,
    });
  }
  const summary = summarizeMcpInboundTokenCapability(token.grants, catalog);
  const out: ChatInboundTokenDetailModel = {
    kind: 'resolved',
    token_id: token.token_id,
    label: token.label,
    active: isMcpInboundTokenActive(token, now),
    created_at: token.created_at,
    revoked_at: token.revoked_at,
    updated_at: token.updated_at,
    concurrency_tier: token.concurrency_tier,
    chat_mode: token.chat_mode,
    summary,
    groups,
  };
  if (token.peer_handle !== undefined) out.peer_handle = token.peer_handle;
  return out;
};

/** § A.9 — table-row projection. Walks every persisted token + counts
 *  the grant overlap with the live catalog so the renderer can paint
 *  "N / M tools" without re-projecting the per-token detail. */
export const buildChatInboundTokenTableRows = (args: {
  tokens: ReadonlyArray<McpInboundTokenRecord>;
  catalog: ReadonlyArray<ToolCatalogEntryView>;
  now: number;
}): ReadonlyArray<ChatInboundTokenTableRow> => {
  const { tokens, catalog, now } = args;
  const catalog_count = catalog.length;
  const out: ChatInboundTokenTableRow[] = [];
  for (const token of tokens) {
    if (!token || typeof token.token_id !== 'string' || token.token_id.length === 0) continue;
    let granted_count = 0;
    for (const entry of catalog) {
      if (!entry || typeof entry.name !== 'string') continue;
      if (token.grants[entry.name] === true) granted_count += 1;
    }
    const row: ChatInboundTokenTableRow = {
      token_id: token.token_id,
      label: token.label,
      active: isMcpInboundTokenActive(token, now),
      created_at: token.created_at,
        revoked_at: token.revoked_at,
      concurrency_tier: token.concurrency_tier,
      granted_count,
      catalog_count,
      chat_mode_offered: token.chat_mode !== null && token.chat_mode.offered,
    };
    if (token.peer_handle !== undefined) row.peer_handle = token.peer_handle;
    out.push(row);
  }
  return out;
};

/** § A.9 — pure reducer over the per-tool checkbox click. Returns the
 *  next `grants` object preserving every other entry. Idempotent on
 *  no-op. The renderer typically batches multiple toggles into one
 *  `chat.inbound_token.update_grants` call (debounce). */
export const projectToggledChatInboundTokenTool = (args: {
  current: Readonly<Record<string, boolean>>;
  tool_name: string;
  next_granted: boolean;
}): Record<string, boolean> => {
  const out: Record<string, boolean> = Object.create(null);
  for (const [k, v] of Object.entries(args.current)) {
    out[k] = v;
  }
  out[args.tool_name] = args.next_granted;
  return out;
};

/** § A.9 — pure reducer over the per-kind master-toggle click. Sets
 *  every catalog entry within `kind` to `next_granted`. The renderer
 *  uses this for the kind-level "all / none" affordance. Tools NOT in
 *  the catalog (e.g. stale grants on uninstalled recipes) are left
 *  alone — only live catalog entries are touched. */
export const projectToggledChatInboundTokenKind = (args: {
  current: Readonly<Record<string, boolean>>;
  catalog: ReadonlyArray<ToolCatalogEntryView>;
  kind: ChatInboundTokenGroupKind;
  next_granted: boolean;
}): Record<string, boolean> => {
  const out: Record<string, boolean> = Object.create(null);
  for (const [k, v] of Object.entries(args.current)) {
    out[k] = v;
  }
  for (const entry of args.catalog) {
    if (!entry || typeof entry.name !== 'string') continue;
    if (inferChatInboundTokenToolKind(entry) !== args.kind) continue;
    out[entry.name] = args.next_granted;
  }
  return out;
};

/** § A.9 — pure reducer for the "fill defaults" affordance on the
 *  issuance dialog. Calls `buildDefaultMcpInboundTokenGrants` (substrate
 *  default-deny per spec) — read-class T1 + T3 default true; everything
 *  else false. The renderer wires the "Reset to defaults" button to
 *  this reducer. */
export const projectDefaultChatInboundTokenGrants = (args: {
  catalog: ReadonlyArray<ToolCatalogEntryView>;
}): Record<string, boolean> => {
  // `buildDefaultMcpInboundTokenGrants` already returns a fresh
  // Object.create(null)-style map; surface it directly so the
  // reducer is a thin re-export.
  const defaults = buildDefaultMcpInboundTokenGrants(args.catalog);
  const out: Record<string, boolean> = Object.create(null);
  for (const [k, v] of Object.entries(defaults)) out[k] = v;
  return out;
};

/** § A.9 — closed-list options for the concurrency-tier picker. */
export const buildChatInboundTokenConcurrencyOptions = (): ReadonlyArray<{
  value: McpInboundConcurrencyTier;
  label: string;
  description: string;
}> => MCP_INBOUND_CONCURRENCY_LADDER.map((value) => ({
  value,
  ...CHAT_INBOUND_TOKEN_CONCURRENCY_COPY[value],
}));

/** § A.9 — pre-flight defaults for the issuance dialog. Combines the
 *  catalog-derived grants with the spec-defined concurrency / expiry
 *  / chat-mode defaults so the renderer can pre-fill the form without
 *  re-deriving each value. */
export interface ChatInboundTokenIssuanceDefaults {
  grants: Record<string, boolean>;
  concurrency_tier: McpInboundConcurrencyTier;
  /** § A.9's *"default 1 year, configurable; safety net against abandoned
   *  tokens"* — now expressed as a CONTRACT limit, because the token no longer
   *  has a lifetime of its own.
   *
   *  ⚠ The shipped panel does not call this helper (it issues with expiry as a
   *  D-171 opt-in via the Advanced toggles), so this is the spec's default
   *  preserved rather than live behaviour. Translated instead of deleted so the
   *  safety net has a home if it is ever wired. */
  contract_limits: { readonly expiry_at: number };
  /** Default `null` per spec — Bob explicitly opts in to chat-mode per
   *  token. */
  chat_mode: McpInboundTokenChatMode;
}

export const buildChatInboundTokenIssuanceDefaults = (args: {
  catalog: ReadonlyArray<ToolCatalogEntryView>;
  now: number;
}): ChatInboundTokenIssuanceDefaults => ({
  grants: projectDefaultChatInboundTokenGrants(args),
  // Spec § A.9 default ladder: 3 / 5 / 10 — `5` ("Balanced") is the
  // implicit middle / typical-trust default.
  concurrency_tier: 5,
  contract_limits: { expiry_at: args.now + MCP_INBOUND_TOKEN_DEFAULT_EXPIRY_MS },
  chat_mode: null,
});

/** § A.9 — pure reducer over the broadcast event. The Settings page
 *  invokes this on each `chat.inbound_token_changed` to refresh the
 *  per-token registry projection. The reducer handles all four
 *  operations (issue / update_grants / revoke / delete) by replacing
 *  the matching row OR removing it on `delete`. */
export const reduceChatInboundTokenChanged = (args: {
  current: ReadonlyArray<McpInboundTokenRecord>;
  event: {
    op: 'issue' | 'update_grants' | 'revoke' | 'delete';
    token_id: string;
    record: unknown;
  };
}): ReadonlyArray<McpInboundTokenRecord> => {
  const { current, event } = args;
  if (event.op === 'delete') {
    return current.filter((t) => t.token_id !== event.token_id);
  }
  const incoming = event.record as McpInboundTokenRecord | null | undefined;
  if (!incoming || typeof incoming.token_id !== 'string') return current;
  const next: McpInboundTokenRecord[] = [];
  let inserted = false;
  for (const existing of current) {
    if (existing.token_id === incoming.token_id) {
      next.push(incoming);
      inserted = true;
    } else {
      next.push(existing);
    }
  }
  if (!inserted) {
    // Issuance — prepend so newest issuance sits at the top of the
    // table (matches the SQLite store's `ORDER BY created_at DESC`
    // listing semantics).
    next.unshift(incoming);
  }
  return next;
};

/** § A.9 — narrow validator for the issuance form's concurrency-tier
 *  field. Caller-side pre-flight gate; the rpc handler re-validates
 *  via `validateMcpInboundTokenInput`. */
export const isChatInboundTokenConcurrencyTier =
  isMcpInboundConcurrencyTier;
