/** D-137 W2.2 § A.1.1 + § P1 — Settings → Chat → Tool Catalog Scope
 *  renderer.
 *
 *  Pure projection of the closed-list D-126 8-kind `IngredientKind`
 *  set + Mary's persisted enabled-kind set into the per-toggle UI
 *  model. The renderer iterates `options`; each entry carries:
 *
 *    - `kind`        — closed-list `IngredientKind`
 *    - `enabled`     — derived from the server snapshot
 *    - `label`       — short display name ("Mail / HTTP")
 *    - `description` — one-line copy under the toggle
 *    - `risk_tier`   — `safe` | `risky` — UI surfaces the risky kinds
 *      under a "High-risk" divider with default-off framing
 *
 *  No business logic — the page reads server state via
 *  `chat.tool_catalog.get` rpc + listens to
 *  `chat.tool_catalog_scope_changed` broadcasts. Writes via
 *  `chat.tool_catalog.set`; the server validates + returns the
 *  canonicalized shape (which the broadcast re-fans).
 *
 *  Per D-148 § A.4 invariant — the webclient projects server-supplied
 *  state only, NEVER synthesizes. When the server snapshot is
 *  unavailable (pre-fetch, store unwired) the model surfaces a
 *  `'pending'` discriminator distinct from a server-supplied
 *  default-on snapshot (the user can distinguish "not loaded yet"
 *  from "you have all the safe kinds on").
 */

import {
  INGREDIENT_KINDS,
  SAFE_DEFAULT_CHAT_CATALOG_KINDS,
  type ChatToolCatalogScopeState,
  type IngredientKind,
} from '@recued/contracts';

/** Display row per kind. Closed-list `IngredientKind` is the only
 *  source of truth for membership; the page renders one row per kind
 *  in canonical declaration order. */
export interface ChatToolCatalogKindOption {
  kind: IngredientKind;
  enabled: boolean;
  /** Short label rendered next to the toggle. */
  label: string;
  /** One-line copy describing what the kind covers. The copy is
   *  user-facing — keep accurate references to the D-126 closed list
   *  so Mary can tell which adapters a kind transitively touches. */
  description: string;
  /** `safe` defaults to on; `risky` defaults to off. UI groups risky
   *  kinds under a separate "High-risk surfaces" header. */
  risk_tier: 'safe' | 'risky';
}

/** Snapshot-driven model the page iterates. */
export interface ChatToolCatalogScopeModel {
  kind: 'resolved';
  options: ReadonlyArray<ChatToolCatalogKindOption>;
  /** Wall-clock at last server write. `0` means the substrate
   *  default is still in effect (Mary has never toggled). */
  updated_at: number;
  /** True when Mary's enabled set diverges from the
   *  `SAFE_DEFAULT_CHAT_CATALOG_KINDS`. Drives the "reset to defaults"
   *  affordance visibility. */
  is_customised: boolean;
}

export interface ChatToolCatalogScopePendingModel {
  kind: 'pending';
  options: readonly [];
  updated_at: 0;
  is_customised: false;
}

export type ChatToolCatalogScopeRenderModel =
  | ChatToolCatalogScopeModel
  | ChatToolCatalogScopePendingModel;

/** Closed-list copy table. One entry per `IngredientKind`. Risk tier
 *  matches the § P1 default posture: `http` / `ai` / `storage` /
 *  `service` ship default-on; `dom` / `chat` / `mcp` / `connection` /
 *  `cli` ship default-off. The table is exhaustive over `IngredientKind`
 *  — adding a kind requires extending this map (the TS exhaustiveness
 *  check catches drift). */
export const CHAT_TOOL_CATALOG_KIND_COPY: Readonly<Record<IngredientKind, {
  label: string;
  description: string;
  risk_tier: 'safe' | 'risky';
}>> = {
  http: {
    label: 'HTTP adapters',
    description:
      'Mail / calendar / contact / CRM platform adapters. Required for most search recipes.',
    risk_tier: 'safe',
  },
  ai: {
    label: 'AI synthesis',
    description:
      'Programmatic AI (BYOK / free-pool) for summaries, scoring, and extraction. Routed through your configured providers per § A.14.',
    risk_tier: 'safe',
  },
  storage: {
    label: 'Local storage',
    description:
      'Local warehouse + memory + enrichment reads/writes. Stays on your machine.',
    risk_tier: 'safe',
  },
  service: {
    label: 'Long-running services',
    description:
      'D-118 long-running services (background sync, watchers). Local-only.',
    risk_tier: 'safe',
  },
  dom: {
    label: 'Browser DOM extraction',
    description:
      'Bridge-only DOM scrapers. High-risk: scrapes whatever tab is open. Off by default.',
    risk_tier: 'risky',
  },
  chat: {
    label: 'Web-chat AI tabs',
    description:
      'Web-chat-tab AI (Gemini / DeepSeek / ChatGPT). Sends prompt text to the chat provider. Off by default.',
    risk_tier: 'risky',
  },
  mcp: {
    label: 'Pre-D-125 MCP path',
    description:
      'Legacy MCP-client ingredient kind. Most users want `connection.mcp.*` instead. Off by default.',
    risk_tier: 'risky',
  },
  connection: {
    label: 'Outbound connections',
    description:
      'D-125 outbound named endpoints (API / MCP / notification). Write-capable connections live here. Off by default.',
    risk_tier: 'risky',
  },
  cli: {
    label: 'Local tools',
    description:
      'D-182 local-binary toolkit ops (whisper / docling / ffmpeg / imagemagick). Runs a local command on your machine. Off by default — enable to let the agent use installed tools (execution still needs a per-tool grant).',
    risk_tier: 'risky',
  },
} as const;

/** Build the closed-list option array — one entry per `IngredientKind`
 *  in canonical declaration order. Pure: same `(enabled_set, copy)` →
 *  same options array. */
export const buildChatToolCatalogScopeOptions = (
  enabledKinds: ReadonlySet<IngredientKind>,
): ReadonlyArray<ChatToolCatalogKindOption> => {
  const out: ChatToolCatalogKindOption[] = [];
  for (const kind of INGREDIENT_KINDS) {
    const copy = CHAT_TOOL_CATALOG_KIND_COPY[kind];
    out.push({
      kind,
      enabled: enabledKinds.has(kind),
      label: copy.label,
      description: copy.description,
      risk_tier: copy.risk_tier,
    });
  }
  return out;
};

/** Snapshot → model projection. Returns a `'pending'` discriminator
 *  when the server snapshot is missing or carries an off-list member
 *  (per the D-148 § A.4 invariant — webclient never synthesizes).
 *  Once the broadcast `chat.tool_catalog_scope_changed` fires + the
 *  reducer absorbs it, the model resolves. */
export const buildChatToolCatalogScopeModel = (
  snapshot: ChatToolCatalogScopeState | null | undefined,
): ChatToolCatalogScopeRenderModel => {
  if (!snapshot || !Array.isArray(snapshot.enabled_kinds)) {
    return {
      kind: 'pending',
      options: [],
      updated_at: 0,
      is_customised: false,
    };
  }
  const enabled = new Set<IngredientKind>();
  for (const k of snapshot.enabled_kinds) {
    if (typeof k === 'string' && INGREDIENT_KINDS.has(k as IngredientKind)) {
      enabled.add(k as IngredientKind);
    }
  }
  const safeDefaults = new Set<IngredientKind>(SAFE_DEFAULT_CHAT_CATALOG_KINDS);
  let is_customised = enabled.size !== safeDefaults.size;
  if (!is_customised) {
    for (const k of safeDefaults) {
      if (!enabled.has(k)) {
        is_customised = true;
        break;
      }
    }
  }
  return {
    kind: 'resolved',
    options: buildChatToolCatalogScopeOptions(enabled),
    updated_at: snapshot.updated_at,
    is_customised,
  };
};

/** Pre-flight evaluator for the toggle action. Returns the projected
 *  next `enabled_kinds` array (in canonical order) so the page can
 *  send it to `chat.tool_catalog.set` directly. Empty result is
 *  allowed (Mary may disable all kinds — every Tier 2 recipe would
 *  drop, but Tier 1 stays available; the orchestrator's
 *  `resolveEnabledKinds` substrate falls back to the safe defaults
 *  defensively at write time). */
export const projectToggledKinds = (args: {
  current: ReadonlyArray<IngredientKind>;
  kind: IngredientKind;
  next_enabled: boolean;
}): ReadonlyArray<IngredientKind> => {
  const set = new Set<IngredientKind>(args.current);
  if (args.next_enabled) {
    set.add(args.kind);
  } else {
    set.delete(args.kind);
  }
  const out: IngredientKind[] = [];
  for (const k of INGREDIENT_KINDS) {
    if (set.has(k)) out.push(k);
  }
  return out;
};

/** Pure reducer over the broadcast event. Webclient invokes this on
 *  each `chat.tool_catalog_scope_changed` to refresh the Settings
 *  page model. The reducer never trusts the wire shape directly —
 *  off-list kinds drop silently (same invariant as
 *  `buildChatToolCatalogScopeModel`). */
export const reduceChatToolCatalogScopeChanged = (
  current: ChatToolCatalogScopeRenderModel,
  event: {
    enabled_kinds: readonly string[];
    updated_at: number;
  },
): ChatToolCatalogScopeRenderModel => {
  // Drop the previous model — the broadcast carries the new canonical
  // shape, and the reducer is the only path that materialises a
  // `'resolved'` model from a wire event. We intentionally re-validate
  // each member rather than trusting the array.
  void current;
  return buildChatToolCatalogScopeModel({
    enabled_kinds: event.enabled_kinds as ReadonlyArray<IngredientKind>,
    updated_at: event.updated_at,
  });
};
