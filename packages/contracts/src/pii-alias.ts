/**
 * D-167 — Reversible PII Alias Comfort Layer (P0 contract types).
 *
 * Catalog publishers tag PII fields with one closed-list value; the substrate
 * owns alias allocation, ledger keying, suffix composition, restore policy,
 * and audit summary. Publisher burden is one annotation per PII-bearing field.
 *
 * Spec: docs/d-167-spec.md §Field declaration, §Alias vocabulary, §Alias ledger.
 */

/** 9-kind closed list. Publisher-facing surface. */
export type EntityFieldPrivacy =
  | 'email'
  | 'name'
  | 'org'
  | 'phone'
  | 'address'
  | 'url'
  | 'external_id'
  | 'account_id'
  | 'content';

export const ENTITY_FIELD_PRIVACY_KINDS = [
  'email',
  'name',
  'org',
  'phone',
  'address',
  'url',
  'external_id',
  'account_id',
  'content',
] as const satisfies readonly EntityFieldPrivacy[];

export const isEntityFieldPrivacy = (s: unknown): s is EntityFieldPrivacy =>
  typeof s === 'string'
  && (ENTITY_FIELD_PRIVACY_KINDS as readonly string[]).includes(s);

/**
 * Ledger row kinds. Excludes 'content' (no whole-value alias of its own;
 * content fields populate other kinds via scan). Adds two internal kinds
 * that surface from email + URL side-effects:
 *
 *   - 'email_local' — the local-part `m<N>` half of an aliased email
 *   - 'domain'      — the host `d<N>.invalid` half, shared across emails
 *                     and URLs that point at the same host
 */
export type LedgerKind =
  | Exclude<EntityFieldPrivacy, 'content'>
  | 'email_local'
  | 'domain';

export const LEDGER_KINDS = [
  'email',
  'name',
  'org',
  'phone',
  'address',
  'url',
  'external_id',
  'account_id',
  'email_local',
  'domain',
] as const satisfies readonly LedgerKind[];

export const isLedgerKind = (s: unknown): s is LedgerKind =>
  typeof s === 'string' && (LEDGER_KINDS as readonly string[]).includes(s);

/**
 * Alias scope. v1 is session-only — chat / MCP / webclient context packets
 * share one ledger keyed on the active session. Recipe-mode `pii-protect` /
 * `pii-restore` operate in pure RAM within a single recipe run and do NOT
 * register a scope value (no persisted ledger row).
 */
export type AliasScope = 'session';

/** v1 substrate-internal redaction modes. Widened from earlier drafts. */
export type RedactionMode =
  | 'alias'
  | 'alias_known_entities'
  | 'hash'
  | 'drop'
  | 'allow';

/**
 * Per-kind restore policy.
 *
 *   - 'display_only'      — restore for read-only user display (default)
 *   - 'approval_preview'  — restore in D-157 preflight gate so the user
 *                           confirms the real call ("email alice@acme.com"),
 *                           not the alias ("email m1@d1.invalid")
 *   - 'never'             — never restore (substrate keeps the alias surface
 *                           even on display; reserved for future modes)
 */
export type RestorePolicy = 'display_only' | 'approval_preview' | 'never';

/**
 * Provenance — first place a given (kind, real_value) was observed. Stays
 * informational; restore lookups key on (scope_id, kind, real_value), not
 * on this field.
 */
export interface AliasFirstObserved {
  /** Catalog ref where the value first appeared. Absent for content-scan
   *  rows that didn't originate from a structured field. */
  source_ref?: string;
  /** For internally-allocated `'domain'` or `'email_local'` rows: the
   *  identifier kind that triggered the side-effect ('email' | 'url'). */
  via_side_effect_of?: 'email' | 'url';
}

/**
 * One ledger row.
 *
 *   - `(scope_id, kind, real_value)` is the composite key.
 *   - `real_value` stays plaintext under the storage layer's encryption-at-rest;
 *     the LLM never sees the ledger, only the `pii.Person<N>` / `m<N>@d<M>.invalid`
 *     ordering — no cryptographic shape is needed.
 *   - `alias_value` is the surface the LLM receives.
 */
export interface RedactionAliasEntry {
  scope_id: string;
  kind: LedgerKind;
  real_value: string;
  alias_value: string;
  first_observed_at: AliasFirstObserved;
  /** Optional cross-row references — e.g. an `email` row's alias_value of
   *  `m1@d1.invalid` may reference the `'domain'` row's `d1.invalid`. */
  relationship_refs?: string[];
  /** Shared-identifier case — a team inbox or family email that maps to
   *  more than one entity. v1 stores candidates; resolution UX comes later. */
  candidate_entity_refs?: string[];
  created_at: number;
  expires_at?: number;
}

/**
 * § 7 follow-on (pii-ledger-in-checkpoint) — the durable snapshot of a run's
 * `PiiLedgerStore` (`@recued/transforms`), carried on a D-157 `Checkpoint` so
 * a preflight-paused run resumed in a FRESH process can still restore its
 * aliases. Without it, `step_state`'s `step.<protect>.ledger_handle` strings
 * point at nothing after resume: every post-gate `pii-restore` (and the
 * engine's run-end `restoreAll` safety net) passes ALIASES through downstream
 * — protected, but garbled output. Pure JSON: Map entries as `[key, value]`
 * arrays, `RedactionAliasEntry` rows verbatim.
 *
 * Persistence posture — the same one `RedactionAliasEntry` documents and the
 * checkpoint already lives by: `real_value` stays plaintext under the storage
 * layer's encryption-at-rest. Provenance of the values (codex MED fold —
 * stated precisely, not overclaimed): a ledger value originates from the
 * protect step's resolved input, i.e. upstream STEP outputs (which the same
 * checkpoint's `step_state` already carries raw) or `{{config.*}}` /
 * `{{context.*}}` refs (which the paused run's anchor already persists raw —
 * `config_snapshot`, and `context_snapshot` on awaiting anchors). So the
 * paused-run record ENSEMBLE holds no new data class — but the checkpoint
 * ROW alone can now carry config/context-sourced values `step_state` does
 * not, which raises the priority of the boot sweep's documented stale-
 * checkpoint retention follow-on (checkpoints are consumed on answer; only
 * orphaned rows linger). `vault` material never appears in a ledger
 * (credentials are not PII kinds, and vault refs never resolve into
 * checkpointed state).
 *
 * Continuity invariants the hydrating store honors (`createPiiLedgerStore`
 * with a snapshot):
 *   - old handles resolve (`get`) against the restored per-handle registry;
 *   - NEW mints continue `(sid, ledger_seq)` past the snapshot, so a
 *     resumed run's later `pii-protect` never collides with a pre-pause
 *     handle — and a SECOND pause re-serializes old + new as one snapshot
 *     (multi-pause chains compose);
 *   - counters / forward maps restore run-wide alias numbering, so a value
 *     re-protected after resume collapses to its pre-pause alias.
 */
export interface PiiLedgerStoreSnapshot {
  /** The paused store's process-store sequence — re-used by the hydrated
   *  store (and the new process's global sequence is bumped past it) so
   *  handle uniqueness survives the process boundary. */
  sid: number;
  /** Next-mint ordinal — the hydrated store continues from here. */
  ledger_seq: number;
  /** Every handle the paused store had minted, re-registered on hydrate so
   *  `step.<protect>.ledger_handle` strings in `step_state` resolve. */
  handles: string[];
  /** The shared run-wide `AliasNamespace`, Map → entries arrays. */
  by_kind_real_value: Array<[string, RedactionAliasEntry]>;
  by_kind_base_alias: Array<[string, RedactionAliasEntry]>;
  counters: Array<[string, number]>;
  sibling_counters: Array<[string, number]>;
  pre_scan_literals: Array<[string, RedactionAliasEntry]>;
}

/**
 * Audit emission shape. The ledger itself is never sent to audit; only a
 * count summary lands in D-120 audit rows. Internal `'domain'` / `'email_local'`
 * allocations are excluded from counts (implementation detail of `'email'`
 * and `'url'`).
 */
export interface RedactionSummary {
  mode: RedactionMode;
  scope_kind: AliasScope;
  counts: {
    email?: number;
    name?: number;
    org?: number;
    phone?: number;
    address?: number;
    url?: number;
    external_id?: number;
    account_id?: number;
    content_text_replacements?: number;
  };
}

/* ──────────────── Recipe-mode transform I/O (§Transform exports) ──────────────── */

/**
 * The value shape `pii-protect` / `pii-restore` accept and return. Single
 * object / string, or a D-162 batch list of objects / strings. Aliasing a
 * list shares one run-local ledger so identical real values across items
 * collapse to one alias number.
 */
export type PiiAliasableData =
  | string
  | Record<string, unknown>
  | Array<string | Record<string, unknown>>;

/** Per-field PII tag for recipe-author-supplied structured data. Mirrors the
 *  catalog's `MetaField.privacy` declaration, applied at recipe author time. */
export interface PiiFieldTag {
  /** Dot-path into the structured `data` (`"owner.email"`). */
  path: string;
  kind: EntityFieldPrivacy;
}

/**
 * D-167 entity-marker privacy declaration (`docs/d-160-n10-part-pii-pending-design.md`
 * §E.1). An **operation-free** privacy tag keyed on a record's inline
 * `__entity` marker: any object that carries `__entity: <entity_id>` has these
 * bare field templates applied — rooted at that object's path — wherever it
 * appears in an LLM-bound packet. The entity-keyed peer of the operation-keyed
 * `EntitySchemaIngredientInput` / `source_operations` tagging.
 *
 * Deliberately NOT `EntitySchemaIngredientInput`: that type MANDATES
 * `source_operations` (its validator rejects an empty set), which re-binds
 * privacy to a result shape per operation — the per-envelope re-declaration
 * debt E.1 pays down (the same record re-declared for `candidates[].record.*`
 * AND each confidence-shape slot). `EntityPrivacyTag` carries only the entity
 * id + bare field templates, so one declaration covers every re-embedded copy.
 */
export interface EntityPrivacyTag {
  /** The id a record's `__entity` marker must equal for these tags to apply
   *  (`'contact'`, `'deal'`). */
  entity_id: string;
  /** Bare field templates ROOTED AT THE MARKED RECORD — `email`, `name`,
   *  `owner` (NOT full packet paths). The resolver prefixes each path with the
   *  marked object's location when it walks a packet. Same `{ path, kind }`
   *  shape as the recipe-mode `PiiFieldTag`. */
  fields: readonly PiiFieldTag[];
}

/**
 * The inline marker key a record carries to declare its entity identity for
 * D-167 entity-keyed privacy resolution (`__entity: <entity_id>`). One shared
 * constant across the three seams that touch it: the producer that STAMPS it
 * (the chat-egress projections, P2), the resolver that READS it (the
 * entity-marker walk), and the model-bound chat-egress STRIP that removes it
 * before any packet reaches the LLM. The `__`-prefix keeps it visually distinct
 * from real record fields and never collides with a canonical field name.
 */
export const PII_ENTITY_MARKER_KEY = '__entity';

/**
 * Normalize the single-step `ai-*` `llm.pii_fields` wire form — a
 * `{ "<path>": "<kind>" }` map (the recipe author's "field = type" shape, D-167
 * §Single-step `ai-*` PII) — into the substrate's `PiiFieldTag[]`. Fail-closed,
 * mirroring `pii-protect`'s `requireFieldTags` (D-167 safe-feature rule): an
 * absent / null map is a valid empty no-op, but a *present* map the alias
 * substrate could not honor — not a plain object, an empty-string path key, or a
 * value outside the 9-kind `EntityFieldPrivacy` enum — THROWS, so a typo'd tag
 * halts the `ai-*` step before egress rather than silently letting raw PII reach
 * the LLM. The error names the offending path (a field name — safe to echo) but
 * never the kind VALUE: a `{{ref}}`-derived kind could carry real data, the same
 * caution `requireFieldTags` takes. Field existence is NOT checked here — a tag
 * is a best-effort instruction (recipes read fields outside the ingredient
 * contract); a path absent at runtime simply aliases nothing.
 */
export const normalizePiiFields = (raw: unknown): PiiFieldTag[] => {
  if (raw === undefined || raw === null) return [];
  // Plain object only. A Map / Set / class instance / Object.create(custom)
  // yields no own-enumerable entries from Object.entries below, which would
  // SILENTLY alias nothing and ship raw PII to the model — so a non-plain map
  // must fail closed, not no-op. (Object.create(null) is a valid plain dict.)
  if (
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    (Object.getPrototypeOf(raw) !== Object.prototype && Object.getPrototypeOf(raw) !== null)
  ) {
    throw new Error('llm.pii_fields must be a plain { "<path>": "<kind>" } map');
  }
  const out: PiiFieldTag[] = [];
  for (const [path, kind] of Object.entries(raw as Record<string, unknown>)) {
    if (path.length === 0) {
      throw new Error('llm.pii_fields has an empty field path');
    }
    if (!isEntityFieldPrivacy(kind)) {
      throw new Error(
        `llm.pii_fields["${path}"] has a kind outside the 9 privacy kinds `
        + '(email/name/org/phone/address/url/external_id/account_id/content)',
      );
    }
    out.push({ path, kind });
  }
  return out;
};

/**
 * `pii-protect` input. With `fields` omitted, the transform is a no-op
 * pass-through that still emits a `ledger_handle` for symmetry with the
 * matching `pii-restore` step.
 */
export interface PiiProtectInput {
  data: PiiAliasableData;
  fields?: PiiFieldTag[];
}

export interface PiiProtectOutput {
  /** `data` with values replaced by typed aliases (same vocabulary as chat
   *  mode: `m<N>@d<M>.invalid` / `pii.Person<N>` / `pii.Phone<N>.gb` / ...). */
  aliased: PiiAliasableData;
  /** Opaque in-RAM handle to pass to `pii-restore`; valid only within the
   *  current recipe run. The ledger lives in pure process RAM and is dropped
   *  when the recipe ends — no cross-run / cross-session sharing. */
  ledger_handle: string;
}

export interface PiiRestoreInput {
  data: PiiAliasableData;
  /** From a prior `pii-protect` step in the same recipe run. */
  ledger_handle: string;
}

export interface PiiRestoreOutput {
  /** Aliases replaced with their real values via ledger lookup; unknown
   *  aliases pass through unchanged (comfort feature, no rejection policy). */
  restored: PiiAliasableData;
}

/* ──────────────── Session query lookup (§Query contract) ──────────────── */

/** `alias://<scope_id>/<alias_value>` URI scheme for exact follow-up lookups. */
export const ALIAS_REF_SCHEME = 'alias' as const;

/** Compose an `alias://<scope_id>/<alias_value>` ref. The alias is left
 *  verbatim (it may carry an `@`, dots, or a geo suffix); only the scope_id
 *  is path-separated. */
export const composeAliasRef = (scope_id: string, alias_value: string): string =>
  `${ALIAS_REF_SCHEME}://${scope_id}/${alias_value}`;

/**
 * Parse an `alias://<scope_id>/<alias_value>` ref. Returns undefined when the
 * scheme is wrong or either component is empty.
 *
 * Splits on the LAST `/` of the path, not the first: the `alias_value` is a
 * lookup-ref entity alias (`pii.Person1`, `m1@d1.invalid`, `pii.Phone1.gb`,
 * `pii.Address1.san-francisco.ca.usa`) — all slash-free — so the last `/` is
 * always the scope/alias boundary. This round-trips even when the `scope_id`
 * (a session_id) contains `/`. Aliases with `@` and geo-suffix dots survive
 * intact. URL-kind alias surfaces (`https://d1.invalid/portal`, which contain
 * `/`) are reconstructed-value forms, never lookup-ref alias_values.
 */
export const parseAliasRef = (
  ref: string,
): { scope_id: string; alias_value: string } | undefined => {
  if (typeof ref !== 'string') return undefined;
  const prefix = `${ALIAS_REF_SCHEME}://`;
  if (!ref.startsWith(prefix)) return undefined;
  const body = ref.slice(prefix.length);
  const slash = body.lastIndexOf('/');
  if (slash <= 0 || slash === body.length - 1) return undefined;
  const scope_id = body.slice(0, slash);
  const alias_value = body.slice(slash + 1);
  if (!scope_id || !alias_value) return undefined;
  return { scope_id, alias_value };
};

/**
 * How hard the resolver must resolve a lookup. v1 ships the single documented
 * mode — exact alias refs resolve locally; unknown aliases reject; free-text
 * hints degrade to bounded local search rather than blocking ordinary chat.
 */
export type AliasResolutionRequirement = 'exact_or_bounded_search';

/**
 * A follow-up lookup request from the LLM. Prefers exact alias refs over
 * free text — the LLM never queries vendors directly with raw values; it
 * requests intent + aliases and Recued resolves locally before re-aliasing
 * results through the runtime flow on the way back out.
 */
export interface AliasLookupRequest {
  /** Exact alias refs (`alias://session_abc/pii.Person1`). Unknown → reject;
   *  mutated → treat as unresolved, do not fuzzy-restore. */
  refs: string[];
  /** Weak natural-language hints; trigger bounded local search only. */
  free_text_hints?: string[];
  required_resolution: AliasResolutionRequirement;
}
