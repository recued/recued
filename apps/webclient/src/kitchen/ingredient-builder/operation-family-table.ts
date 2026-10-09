import type {
  AuthoringValidationIssue,
  ApiExecutionBinding,
  BulkPackManifest,
  CliMethodBinding,
  CompositionAuthModel,
  CompositionIngredient,
  CompositionReviewView,
  CompositionSurface,
  ConnectorExecutionBinding,
  ConnectorMethodBinding,
  Conn,
  CatalogKind,
  CrmAlias,
  AcctAlias,
  CliStdinHandling,
  CliOutputShape,
  CliOutputStorage,
  DateGranularity,
  EntityFieldPrivacy,
  FieldDerivation,
  GraphQLExecutionBinding,
  GraphQLOperationType,
  IngredientDraftSummary,
  IngredientEntity,
  IngredientEntityField,
  IngredientInstallResult,
  IngredientPreviewResult,
  IngredientRow,
  InstallAccessTier,
  InstallAudienceSelection,
  InstallGrantSelection,
  InstallScopeWho,
  MetaFieldType,
  OpKind,
  OperationApproval,
  OperationArgEntry,
  OperationArgType,
  OperationPaginationPlacement,
  OperationPaginationSpec,
  OperationPaginationStyle,
  OperationRiskTier,
  PackOperationRow,
  PackDependency,
  PackKind,
  PackServiceKind,
  RestExecutionBinding,
  RestMethod,
  SearchStyle,
  ServerRpcRegistry,
  WriteStyle,
} from '@recued/contracts';
import {
  BULK_PACK_INSTALL_PERMISSION,
  BULK_PACK_MANIFEST_VERSION_V2,
  CLI_STDIN_HANDLINGS,
  CLI_OUTPUT_SHAPES,
  CLI_OUTPUT_STORAGES,
  CRM_ALIAS_VALUES,
  ACCT_ALIAS_VALUES,
  DATE_GRANULARITIES,
  isCatalogKind,
  isOpKind,
  isDateGranularity,
  ENTITY_FIELD_PRIVACY_KINDS,
  GRAPHQL_OPERATION_TYPES,
  META_FIELD_TYPES,
  OPERATION_ARG_TYPES,
  PACK_KINDS,
  OPERATION_PAGINATION_PLACEMENTS,
  OPERATION_PAGINATION_STYLES,
  PACK_SERVICE_KINDS,
  REST_METHODS,
  SEARCH_STYLES,
  WRITE_STYLES,
  isSearchStyle,
  isWriteStyle,
} from '@recued/contracts';
import { PRIMITIVE_STYLES } from '@recued/ui-shared/primitives';
// D-182 §7.1 / D-196 — the {Access × Audience} install grant picker. The kitchen
// "Install" path is an owner install (spec §7.1 table), so a connection-backed
// reviewed draft surfaces the picker before commit; its access tier drives
// `ingredient.install`'s `install_scope`. cli drafts yield a `null` model (cli
// authority is the §7.2 per-contract reachability bit) and render no picker.
import {
  INSTALL_GRANT_PICKER_STYLES,
  installGrantModelFromReviewFamilies,
  renderInstallGrantPicker,
  DEFAULT_INSTALL_AUDIENCE,
  resolveInstallAudienceSelection,
} from '../../settings/install-grant-picker.js';
import { humanizeRpcError } from '../../shell/rpc-error-copy.js';

export const INGREDIENT_BUILDER_STYLES_MARKER =
  'data-recued-ingredient-builder-styles';
export const INGREDIENT_BUILDER_ROUTE_ATTR =
  'data-recued-ingredient-builder-route';
export const INGREDIENT_BUILDER_HEADING_ATTR =
  'data-recued-ingredient-builder-heading';
const INGREDIENT_BUILDER_FOCUS_FIELD_ATTR =
  'data-recued-ingredient-builder-focus-field';
export const INGREDIENT_BUILDER_TABLE_ATTR =
  'data-recued-ingredient-operation-family-table';
export const INGREDIENT_BUILDER_ROW_ATTR =
  'data-recued-ingredient-operation-row';
export const INGREDIENT_BUILDER_FIELD_ATTR =
  'data-recued-ingredient-operation-field';
export const INGREDIENT_BUILDER_ADD_ROW_ATTR =
  'data-recued-ingredient-operation-add';
export const INGREDIENT_BUILDER_REMOVE_ROW_ATTR =
  'data-recued-ingredient-operation-remove';
export const INGREDIENT_BUILDER_ENTITY_TABLE_ATTR =
  'data-recued-ingredient-entity-field-table';
export const INGREDIENT_BUILDER_ENTITY_ROW_ATTR =
  'data-recued-ingredient-entity-field-row';
export const INGREDIENT_BUILDER_ENTITY_FIELD_ATTR =
  'data-recued-ingredient-entity-field';
export const INGREDIENT_BUILDER_ENTITY_ADD_ROW_ATTR =
  'data-recued-ingredient-entity-field-add';
export const INGREDIENT_BUILDER_ENTITY_REMOVE_ROW_ATTR =
  'data-recued-ingredient-entity-field-remove';
/** The per-entity-group cross-vendor alias `<select>` (value = the trimmed
 *  entity name). Surfaces `IngredientEntity.crm_alias` XOR `.acct_alias` — an
 *  entity-level field, so it lives in the entity-group header, not per row. */
export const INGREDIENT_BUILDER_ENTITY_ALIAS_ATTR =
  'data-recued-ingredient-entity-alias';
export const INGREDIENT_BUILDER_SAVE_ATTR =
  'data-recued-ingredient-draft-save';
export const INGREDIENT_BUILDER_STATUS_ATTR =
  'data-recued-ingredient-builder-status';
export const INGREDIENT_BUILDER_REVIEW_STATUS_ATTR =
  'data-recued-ingredient-builder-review-status';
export const INGREDIENT_BUILDER_REVIEW_ISSUE_ATTR =
  'data-recued-ingredient-builder-review-issue';
export const INGREDIENT_BUILDER_FIELD_PRIVACY_ATTR =
  'data-recued-ingredient-builder-field-privacy';
export const INGREDIENT_BUILDER_SLUG_ATTR =
  'data-recued-ingredient-builder-slug';
export const INGREDIENT_BUILDER_TITLE_ATTR =
  'data-recued-ingredient-builder-title';
export const INGREDIENT_BUILDER_CONNECTION_ATTR =
  'data-recued-ingredient-builder-connection';
/** http-surface connector fields (api auth model) — base URL + the
 *  `IngredientHttpConfig` dialects. */
export const INGREDIENT_BUILDER_HTTP_BASE_ATTR =
  'data-recued-ingredient-builder-http-base';
export const INGREDIENT_BUILDER_HTTP_RESULT_PATH_ATTR =
  'data-recued-ingredient-builder-http-result-path';
export const INGREDIENT_BUILDER_HTTP_SEARCH_STYLE_ATTR =
  'data-recued-ingredient-builder-http-search-style';
export const INGREDIENT_BUILDER_HTTP_WRITE_STYLE_ATTR =
  'data-recued-ingredient-builder-http-write-style';
export const INGREDIENT_BUILDER_AUTH_MODEL_ATTR =
  'data-recued-ingredient-builder-auth-model';
/** The loaded Table-A ingredient kind. Non-HTTP/CLI kinds are preserved and
 *  shown read-only because their execution contract is carried by raw binds. */
export const INGREDIENT_BUILDER_INGREDIENT_KIND_ATTR =
  'data-recued-ingredient-builder-ingredient-kind';
export const INGREDIENT_BUILDER_CLI_TOOL_ATTR =
  'data-recued-ingredient-builder-cli-tool';
export const INGREDIENT_BUILDER_CLI_READINESS_ATTR =
  'data-recued-ingredient-builder-cli-readiness';
export const INGREDIENT_BUILDER_META_ATTR =
  'data-recued-ingredient-builder-meta';
/** The mini-app section nav tab (value = the `SectionId`). */
export const INGREDIENT_BUILDER_SECTION_NAV_ATTR =
  'data-recued-ingredient-builder-section-nav';
/** A section's view container (value = the `SectionId`). Inactive views render
 *  but carry an `is-hidden` class — every control stays in the DOM. */
export const INGREDIENT_BUILDER_SECTION_VIEW_ATTR =
  'data-recued-ingredient-builder-section-view';
export const INGREDIENT_BUILDER_PACK_SLUG_ATTR =
  'data-recued-ingredient-builder-pack-slug';
export const INGREDIENT_BUILDER_PUBLISHER_ATTR =
  'data-recued-ingredient-builder-publisher';
export const INGREDIENT_BUILDER_PACK_KIND_ATTR =
  'data-recued-ingredient-builder-pack-kind';
export const INGREDIENT_BUILDER_SERVICE_KIND_ATTR =
  'data-recued-ingredient-builder-service-kind';
export const INGREDIENT_BUILDER_PACK_DESCRIPTION_ATTR =
  'data-recued-ingredient-builder-pack-description';
export const INGREDIENT_BUILDER_PACK_TAGS_ATTR =
  'data-recued-ingredient-builder-pack-tags';
export const INGREDIENT_BUILDER_PACK_DEPENDENCIES_ATTR =
  'data-recued-ingredient-builder-pack-dependencies';
export const INGREDIENT_BUILDER_DEFAULT_GRANTS_ATTR =
  'data-recued-ingredient-builder-default-grants';
export const INGREDIENT_BUILDER_OPERATION_ADVANCED_FIELD_ATTR =
  'data-recued-ingredient-operation-advanced-field';
/** One arg-row control in an op's Arguments repeater (value
 *  `${rowId}:${argIdx}:${field}`, field ∈ key / type / affects_target). */
export const INGREDIENT_BUILDER_OPERATION_ARG_FIELD_ATTR =
  'data-recued-ingredient-operation-arg-field';
/** The "Add argument" button for an op (value = the row id). */
export const INGREDIENT_BUILDER_OPERATION_ARG_ADD_ATTR =
  'data-recued-ingredient-operation-arg-add';
/** A per-arg Remove button (value `${rowId}:${argIdx}`). */
export const INGREDIENT_BUILDER_OPERATION_ARG_REMOVE_ATTR =
  'data-recued-ingredient-operation-arg-remove';
export const INGREDIENT_BUILDER_DRAFT_PICKER_ATTR =
  'data-recued-ingredient-draft-picker';
export const INGREDIENT_BUILDER_DRAFT_REFRESH_ATTR =
  'data-recued-ingredient-draft-refresh';
export const INGREDIENT_BUILDER_DRAFT_NEW_ATTR =
  'data-recued-ingredient-draft-new';
export const INGREDIENT_BUILDER_PREVIEW_OPERATION_ATTR =
  'data-recued-ingredient-preview-operation';
export const INGREDIENT_BUILDER_PREVIEW_ARGS_ATTR =
  'data-recued-ingredient-preview-args';
export const INGREDIENT_BUILDER_PREVIEW_ATTR =
  'data-recued-ingredient-preview';
export const INGREDIENT_BUILDER_PREVIEW_STATUS_ATTR =
  'data-recued-ingredient-preview-status';
export const INGREDIENT_BUILDER_INSTALL_ATTR =
  'data-recued-ingredient-install';
export const INGREDIENT_BUILDER_INSTALL_STATUS_ATTR =
  'data-recued-ingredient-install-status';
export const INGREDIENT_BUILDER_INSTALL_WARNING_ATTR =
  'data-recued-ingredient-install-warning';

type IngredientBuilderRpcMethods =
  | 'ingredient.draft.save'
  | 'ingredient.draft.list'
  | 'ingredient.draft.get'
  | 'ingredient.compose.decompose'
  | 'ingredient.preview'
  | 'ingredient.install';
export type IngredientBuilderConn =
  Conn<Pick<ServerRpcRegistry, IngredientBuilderRpcMethods>>;

export type IngredientBuilderSaveStage =
  | 'idle'
  | 'saving'
  | 'reviewing'
  | 'saved'
  | 'error';

/** D-170 — first-class binding-kind discriminator for an operation-row draft.
 *  Mirrors the catalog's `ApiExecutionBinding` / `ConnectorExecutionBinding`
 *  unions: the typed kinds (`rest`/`graphql`/`cli_invocation`/`method_call`)
 *  are authored via labeled flat fields; the three realtime-API kinds carry a
 *  raw-JSON fallback until they get typed forms. `core.records` is the shipped
 *  workflow/storage binding and uses that same lossless raw form. */
export type BindingKindDraft =
  | 'rest'
  | 'graphql'
  // D-225 Slice 1 — listed so the load-side `binding.kind as BindingKindDraft`
  // cast stops asserting something false. mcp gets no typed form yet: it rides
  // the raw-JSON fallback like the three realtime kinds, which already
  // round-trips a binding verbatim (load stashes the whole object, save parses
  // it back). A typed form belongs with D-225 Slice 2, and a GENERATED pack is
  // minted from `tools/list` rather than hand-authored here at all.
  | 'mcp'
  | 'core.records'
  | 'cli_invocation'
  | 'method_call'
  | 'webhook_subscription'
  | 'queue_subscription'
  | 'push_channel';

/** One authored `args` entry — the editor's structured form of an
 *  `OperationArgEntry`. A bare-string contract entry loads as a `'string'` type
 *  with `affectsTarget: false`; the save re-compacts back to a bare string when
 *  it carries no type/authority annotation. */
export interface OperationArgDraft {
  key: string;
  type: OperationArgType;
  /** D-177 — editing this arg re-resolves the approved target at the gate. */
  affectsTarget: boolean;
}

export interface OperationFamilyRowDraft {
  id: string;
  family: string;
  operation: string;
  verb: string;
  /** the op's callable input args (drives Compose autocomplete + the D-177
   *  `affects_target` authority). Authored in the card's Arguments repeater. */
  args: OperationArgDraft[];
  bindingKind: BindingKindDraft;
  // REST (`rest`):
  restMethod: RestMethod;
  restPathTemplate: string;
  restStaticQueryText: string;
  restMergeQueryText: string;
  restStaticHeadersText: string;
  restResponseCaptureText: string;
  // GraphQL (`graphql`):
  graphqlOperationType: GraphQLOperationType;
  graphqlEndpointPath: string;
  graphqlQueryText: string;
  graphqlVariablesSchemaText: string;
  graphqlResultSchemaText: string;
  // CLI (`cli_invocation`):
  cliArgvText: string;
  cliStdin: CliStdinHandling;
  /** D-185 — the cli output shape (the SOLE output declaration). '' = omitted
   *  (exit-code-only — no stdout captured, no file); a value shape captures
   *  stdout; 'ref' produces a file_ref. Defaults to 'text' for a new op (the
   *  common stdout case + the pre-Slice-3 capture_text behaviour). */
  cliShape: '' | CliOutputShape;
  /** D-185 Slice 2 — ref-output storage backing; '' = omitted (defaults cas). */
  cliStorage: '' | CliOutputStorage;
  cliExitCodeText: string;
  cliDetachedText: string;
  cliOutputCaptureText: string;
  cliInputMaterializeText: string;
  cliProgressText: string;
  // Connector method (`method_call`):
  methodCallName: string;
  methodCallArgsMappingText: string;
  // Fallback for the 3 not-yet-typed kinds (webhook/queue/push):
  bindingRawJsonText: string;
  risk_tier: OperationRiskTier;
  approval: OperationApproval;
  reviewed: boolean;
  description: string;
  requiredScopesText: string;
  editableArgsText: string;
  timeoutMsText: string;
  cacheTtlMsText: string;
  resultPath: string;
  paginationStyle: OperationPaginationStyle | '';
  paginationPageSizePlacement: OperationPaginationPlacement;
  paginationPageSizeParam: string;
  paginationPageSizeValue: string;
  paginationPageSizeMax: string;
  paginationDetailsText: string;
  extraJsonText: string;
}

type EntityFieldApplies = NonNullable<IngredientEntityField['applies']>;
type EntityFieldPrivacyDraft = EntityFieldPrivacy | '';
type PackServiceKindDraft = PackServiceKind | '';

/** D-185 redesign — the mini-app section views. The editor is a sectioned
 *  workspace (one menu, each section its own view) rather than one long scroll:
 *  Overview (identity + status) · Setup (the connector: api connection / cli
 *  binary) · Operations (family-grouped op cards) · Data fields (entity schema)
 *  · Publish (pack meta + validate/install). */
type SectionId = 'overview' | 'setup' | 'operations' | 'data' | 'publish';

const SECTIONS: ReadonlyArray<{ id: SectionId; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'setup', label: 'Setup' },
  { id: 'operations', label: 'Operations' },
  { id: 'data', label: 'Data fields' },
  { id: 'publish', label: 'Publish' },
];

export interface EntityFieldRowDraft {
  id: string;
  entity: string;
  field_path: string;
  type: MetaFieldType;
  maps_to: string;
  optional: boolean;
  applies: EntityFieldApplies;
  pii: EntityFieldPrivacyDraft;
  source: string;
  /** D-182 Tier-2 entity extras (authored in the per-field Advanced expander). */
  description: string;
  /** Records-facing display name. */
  label: string;
  /** Records ref-slot target entity. */
  references: string;
  /** the op id whose response sources this field (links it to its read op). */
  sourceOperation: string;
  /** request-side datetime filter granularity (`datetime` fields); '' omits. */
  dateGranularity: DateGranularity | '';
  /** computed-projection derivation (the G3 `closed_state` lift) — flat-authored;
   *  emitted only when the kind + both vendor paths are set. '' kind omits. */
  derivationKind: FieldDerivation['kind'] | '';
  derivationClosedPath: string;
  derivationWonPath: string;
  reviewed: boolean;
}

/** Entity-level cross-vendor alias — `IngredientEntity.crm_alias` XOR
 *  `.acct_alias` (the validators enforce mutual exclusion). Stored once per
 *  entity in `IngredientBuilderState.entityAliases` (keyed by trimmed entity
 *  name), NOT denormalized onto each field row — so the single authoring
 *  control in the entity-group header has one unambiguous value to read/write
 *  and a row moving between entities picks up its new entity's alias. */
export interface EntityAlias {
  crm_alias?: CrmAlias;
  acct_alias?: AcctAlias;
}

/** The combined cross-vendor alias picker's value: '' (none) or one of the
 *  CRM / accounting alias slugs. The value sets are disjoint (`ledger_account`
 *  not `account` on the accounting side), so one `<select>` covers both axes
 *  with no duplicate option and routes the pick to the right field on save. */
export type EntityAliasValue = '' | CrmAlias | AcctAlias;

interface IngredientBuilderState {
  draftId?: string;
  title: string;
  slug: string;
  connection: string;
  /** http ingredient base URL (`IngredientHttpConfig.base`); empty falls back to
   *  the placeholder on save. Authored in the Setup section's API connector. */
  httpBase: string;
  /** http surface-level default response-envelope key
   *  (`IngredientHttpConfig.result_path`) — a per-op `result_path` overrides it.
   *  '' omits it. */
  httpResultPath: string;
  /** the catalog search dialect (`IngredientHttpConfig.search_style`); '' omits. */
  httpSearchStyle: SearchStyle | '';
  /** the catalog write-body dialect (`IngredientHttpConfig.write_style`); '' omits. */
  httpWriteStyle: WriteStyle | '';
  /** Composition governance/trust tier, preserved on round-trip (the old build
   *  hardcoded `private_byo`, downgrading a loaded official/acknowledged pack). */
  catalogKind: CatalogKind;
  /** Table-A adapter kind. Kept separately from the legacy two-way auth label
   *  so storage/workflow ingredients do not silently serialize as HTTP. */
  ingredientKind: OpKind;
  authModel: CompositionAuthModel;
  cliTool: string;
  cliReadinessProbe: string;
  packSlug: string;
  packPublisher: string;
  packKind: PackKind;
  packServiceKind: PackServiceKindDraft;
  packDescription: string;
  packTagsText: string;
  packDependenciesText: string;
  /** comma-separated `composition.default_grants` — derived group ids to grant
   *  at install IN ADDITION to the auto-derived read groups (the rare cold-start
   *  override). '' omits the field. */
  packDefaultGrantsText: string;
  /** Loaded Source contracts are not yet directly editable in Kitchen, but
   *  they are load-bearing catalog schema and must survive an inspect/save
   *  round-trip unchanged. */
  workEntitySources: CompositionIngredient['work_entity_sources'];
  /** Runtime-generated MCP packs may require catalog lowering even when they
   *  contain a single operation. Kitchen does not author this flag, but it
   *  must preserve it when editing such a pack. */
  forceCatalogLowering: CompositionIngredient['force_catalog_lowering'];
  rows: OperationFamilyRowDraft[];
  entityFields: EntityFieldRowDraft[];
  /** Entity-level cross-vendor aliases, keyed by trimmed entity name. Authored
   *  in the entity-group header; `buildEntities` reads it back onto each
   *  `IngredientEntity`. An entry with no field rows is harmlessly dropped at
   *  build time (only entities that actually exist get an alias). */
  entityAliases: Record<string, EntityAlias>;
  saveStage: IngredientBuilderSaveStage;
  status: string;
  review?: CompositionReviewView;
  reviewIssues: AuthoringValidationIssue[];
  drafts: IngredientDraftSummary[];
  draftsStage: 'idle' | 'loading' | 'loaded' | 'error';
  draftsError: string;
  previewOperationKey: string;
  previewArgsText: string;
  previewStage: 'idle' | 'previewing' | 'ready' | 'error';
  preview?: IngredientPreviewResult;
  previewError: string;
  installStage: 'idle' | 'installing' | 'installed' | 'error';
  installResult?: IngredientInstallResult;
  installMessage: string;
  installWarnings: AuthoringValidationIssue[];
  /** D-182 §7.1 (inc 5b.2) — the install grant picker's selected Access tier
   *  (default `read`). Sent as `install_scope.access` when the reviewed draft is
   *  connection-backed; ignored for a cli draft (no picker shown). */
  installAccess: InstallAccessTier;
  /** D-182 §7.2 / D-196 — the install grant picker's Audience checklist (`You`
   *  selected by default). Sent as `install_scope.audience` alongside
   *  `installAccess`. */
  installAudience: InstallAudienceSelection;
  /** Transient UI: the New button is mid-two-tap (showing "Discard & New?")
   *  because the current draft has unsaved edits. Cleared on any edit, load,
   *  new, or save. */
  newConfirmPending: boolean;
  /** Which mini-app section view is active (the section nav). UI-only — never
   *  loaded from a body, and preserved across draft switches (applyDraftState
   *  doesn't reset it). */
  activeSection: SectionId;
  /** UI-only — per-op-card open/closed override (keyed by row id). Without it
   *  every rerender snaps a card back to its `!reviewed` default, losing the
   *  user's toggles. Reset on draft switch; pruned on row removal. */
  opCardOpen: Map<string, boolean>;
  /** UI-only — the nested Advanced disclosure for each operation. Argument
   *  add/remove and binding-shape repaints must not collapse the panel the
   *  author is actively using. Reset on draft switch; pruned on row removal. */
  opAdvancedOpen: Map<string, boolean>;
  /** UI-only — bumped by every markDirty. A save captures the epoch at
   *  dispatch; if edits landed while the save/decompose was in flight, the
   *  completion must NOT report the draft clean ('Saved') — those keystrokes
   *  are not in the saved body. */
  editEpoch: number;
  /** UI-only — bumped by every input that affects the install manifest,
   *  including Publish metadata that deliberately does not dirty/re-review
   *  the composition draft. */
  installInputEpoch: number;
  /** UI-only — the editEpoch value at the last CLEAN point (fresh/blank
   *  state, draft applied, save completed with no interim edits). Dirty ⇔
   *  editEpoch !== cleanEpoch: user edits since the last clean sync, which a
   *  failed LOAD is not (a load-error draft has nothing unsaved to lose). */
  cleanEpoch: number;
}

export interface BootstrapIngredientBuilderRouteOptions {
  root: HTMLElement;
  conn: IngredientBuilderConn;
  document?: Document;
  initialDraftId?: string;
  initialTitle?: string;
  initialBody?: unknown;
  /** Edit→Kitchen deep link — fired whenever the loaded draft changes (an
   *  in-page draft switch or "new draft"), with the new draft id (`undefined`
   *  for a fresh/blank draft). The kitchen route wires this to `replaceState`
   *  the URL to `#kitchen/pack[/<draft_id>]` so a selected draft is a durable,
   *  shareable deep link (route-agnostic: this route never touches the URL
   *  itself). Pairs with `initialDraftId`, which self-loads a draft on arrival. */
  onDraftChange?: (draftId: string | undefined) => void;
}

export interface IngredientBuilderRoute {
  dispose(): void;
  /** True while the draft has edits that navigating away would discard —
   *  the shell's leave-guard seam (same predicate as the Unsaved cue and
   *  the two-tap New confirm). */
  hasUnsavedChanges(): boolean;
  /** Save/review or install work already dispatched to the source server. */
  hasInFlightWork(): boolean;
  getState(): {
    draftId?: string;
    title: string;
    slug: string;
    connection: string;
    ingredientKind: OpKind;
    authModel: CompositionAuthModel;
    cliTool: string;
    cliReadinessProbe: string;
    packSlug: string;
    packPublisher: string;
    packKind: PackKind;
    packServiceKind: PackServiceKindDraft;
    packDescription: string;
    packTagsText: string;
    packDependenciesText: string;
    rows: OperationFamilyRowDraft[];
    entityFields: EntityFieldRowDraft[];
    saveStage: IngredientBuilderSaveStage;
    status: string;
    review?: CompositionReviewView;
    reviewIssues: AuthoringValidationIssue[];
    drafts: IngredientDraftSummary[];
    draftsStage: IngredientBuilderState['draftsStage'];
    draftsError: string;
    previewOperationKey: string;
    previewArgsText: string;
    previewStage: IngredientBuilderState['previewStage'];
    preview?: IngredientPreviewResult;
    previewError: string;
    installStage: IngredientBuilderState['installStage'];
    installResult?: IngredientInstallResult;
    installMessage: string;
    installWarnings: AuthoringValidationIssue[];
    installAccess: InstallAccessTier;
    installScope: InstallScopeWho;
    installAudience: InstallAudienceSelection;
  };
  buildDraftBody(): CompositionIngredient;
}

export const INGREDIENT_BUILDER_STYLES = `
[${INGREDIENT_BUILDER_ROUTE_ATTR}] {
  box-sizing: border-box;
  max-width: 1200px;
  margin: 0 auto;
  padding: 20px 24px 40px;
  color: var(--fg);
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-topbar {
  position: sticky;
  top: 12px;
  z-index: 5;
  display: grid;
  grid-template-columns: minmax(180px, 0.55fr) minmax(420px, 1.45fr) auto;
  gap: 14px;
  align-items: end;
  margin: 0 0 24px;
  padding: 16px 16px 0;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--surface);
  box-shadow: 0 8px 24px rgba(24, 24, 27, 0.06), 0 1px 2px rgba(24, 24, 27, 0.04);
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-header {
  display: grid;
  gap: 2px;
  align-self: center;
  min-width: 0;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-eyebrow {
  color: var(--accent);
  font-size: 10px;
  font-weight: 750;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-subtitle {
  color: var(--fg-muted);
  font-size: 11px;
  line-height: 1.35;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] h1 {
  margin: 0;
  font-size: 21px;
  line-height: 1.15;
  font-weight: 720;
  letter-spacing: -0.02em;
  color: var(--fg-strong);
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-nav {
  display: flex;
  gap: 4px;
  overflow-x: auto;
  scrollbar-width: thin;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-nav-tab[aria-current='page'] {
  font-weight: 650;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-section-view {
  display: block;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-section-view.is-hidden {
  display: none;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-card {
  display: grid;
  gap: 16px;
  margin-bottom: 16px;
  padding: 20px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--surface);
  box-shadow: 0 1px 2px rgba(24, 24, 27, 0.035);
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-search {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 12px;
  border-radius: 9px;
  background: var(--surface-sunk);
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-search input {
  flex: 1 1 220px;
  width: auto;
  min-width: 0;
  max-width: 420px;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-search [hidden] { display: none; }
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-search p {
  margin: 0 0 0 auto;
  font-size: 12px;
  color: var(--fg-muted);
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-identity-card {
  display: grid;
  grid-template-columns: minmax(220px, 1.2fr) minmax(170px, 0.8fr);
  gap: 16px;
  align-items: end;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-overview {
  display: grid;
  grid-template-columns: repeat(4, minmax(110px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-metric {
  display: grid;
  gap: 6px;
  min-width: 0;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
  box-shadow: 0 1px 2px rgba(24, 24, 27, 0.035);
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-metric dt {
  margin: 0;
  color: var(--fg-muted);
  font-size: 12px;
  font-weight: 600;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-metric dd {
  margin: 0;
  color: var(--fg-strong);
  font-size: 14px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-field {
  display: grid;
  gap: 4px;
  min-width: 180px;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] label {
  font-size: 12px;
  color: var(--fg-muted);
  font-weight: 600;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] input,
[${INGREDIENT_BUILDER_ROUTE_ATTR}] select,
[${INGREDIENT_BUILDER_ROUTE_ATTR}] textarea {
  width: 100%;
  box-sizing: border-box;
  min-height: 38px;
  border: 1px solid var(--border-strong);
  border-radius: 9px;
  padding: 8px 11px;
  color: var(--fg);
  background: var(--surface);
  font: inherit;
  font-size: 13px;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] input:focus-visible,
[${INGREDIENT_BUILDER_ROUTE_ATTR}] select:focus-visible,
[${INGREDIENT_BUILDER_ROUTE_ATTR}] textarea:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
  border-color: var(--accent);
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] textarea {
  min-height: 58px;
  resize: vertical;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  line-height: 1.35;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-layout--workflow {
  grid-template-columns: minmax(0, 1fr) minmax(300px, 360px);
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-main {
  min-width: 0;
  display: grid;
  gap: 16px;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-rail {
  min-width: 0;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-table-wrap {
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-editor-section {
  display: grid;
  gap: 12px;
  min-width: 0;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-section-intro {
  display: grid;
  gap: 5px;
  margin: 0 0 16px;
  padding: 2px 2px 0;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-section-intro h2 {
  font-size: 18px;
  letter-spacing: -0.015em;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-section-intro p {
  max-width: 720px;
  margin: 0;
  color: var(--fg-muted);
  font-size: 12px;
  line-height: 1.5;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-section-lede {
  margin: -4px 0 2px;
  color: var(--fg-muted);
  font-size: 12px;
  line-height: 1.5;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-section-header {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
}
/* The count badge hugs its title; any trailing action (Add) is pushed right. */
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-section-header > .ingredient-builder-section-meta {
  margin-right: auto;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-advanced-subsection {
  display: grid;
  gap: 8px;
  min-width: 0;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-advanced-subsection + .ingredient-builder-advanced-subsection {
  margin-top: 16px;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-subsection-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--fg-subtle);
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-arg-list {
  display: grid;
  gap: 8px;
  min-width: 0;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-arg-row {
  display: grid;
  grid-template-columns: minmax(120px, 1.4fr) minmax(96px, 0.8fr) auto auto;
  gap: 8px;
  align-items: center;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-arg-affects {
  display: flex;
  gap: 6px;
  align-items: center;
  white-space: nowrap;
  font-size: 12px;
  color: var(--fg-muted);
  font-weight: 600;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-arg-affects input {
  width: auto;
  min-height: 0;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-arg-empty {
  font-size: 12px;
  color: var(--fg-subtle);
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-panel {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-panel > summary {
  list-style: none;
  cursor: pointer;
  padding: 12px 16px;
  border-radius: 10px;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-panel > summary::-webkit-details-marker {
  display: none;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-panel > summary:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-panel > summary .ingredient-builder-section-header::before {
  content: "+";
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--fg-muted);
  font-weight: 600;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-panel[open] > summary {
  border-bottom: 1px solid var(--border);
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-panel[open] > summary .ingredient-builder-section-header::before {
  content: "-";
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-panel > .ingredient-builder-section-header {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-panel-body {
  display: grid;
  gap: 12px;
  min-width: 0;
  padding: 16px;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-section-meta {
  display: inline-flex;
  align-items: center;
  min-height: 22px;
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--fg-muted);
  background: var(--surface);
  font-size: 11px;
  font-weight: 600;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--fg-strong);
}

/* Operation family-grouped cards */
[${INGREDIENT_BUILDER_TABLE_ATTR}] {
  display: grid;
  gap: 16px;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-op-group {
  display: grid;
  gap: 8px;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-op-group-header {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 0 2px;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-op-group-name {
  font-size: 13px;
  font-weight: 650;
  color: var(--fg-strong);
}
/* Data-fields entity groups — one group (header + field table) per entity,
   mirroring the op-family card grouping. The cross-vendor alias picker lives in
   the group header (it's an IngredientEntity-level field, not per row). */
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-entity-groups {
  display: grid;
  gap: 16px;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-entity-group {
  display: grid;
  gap: 8px;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-entity-group-header {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 0 2px;
}
/* The count badge hugs the entity name; the alias picker is pushed to the end. */
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-entity-group-header > .ingredient-builder-section-meta {
  margin-right: auto;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-entity-alias {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 12px;
  color: var(--fg-muted);
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-op-card {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
  overflow: hidden;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-op-card-summary {
  list-style: none;
  cursor: pointer;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 12px 16px;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-op-card-summary::-webkit-details-marker {
  display: none;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-op-card-summary:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-op-card[open] > .ingredient-builder-op-card-summary {
  border-bottom: 1px solid var(--border);
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-op-card-title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  font-weight: 650;
  color: var(--fg-strong);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-op-card-title.is-untitled {
  color: var(--fg-muted);
  font-weight: 600;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-op-card-verb {
  font-size: 11px;
  color: var(--fg-subtle);
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-op-card-body {
  display: grid;
  gap: 16px;
  padding: 16px;
  background: var(--surface-sunk);
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-kind-pill {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--accent-weak);
  color: var(--accent);
  font-size: 11px;
  font-weight: 650;
  letter-spacing: 0.02em;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-pill {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  color: var(--fg-muted);
  font-size: 11px;
  font-weight: 600;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-pill.is-elevated {
  color: var(--fg-strong);
  font-weight: 650;
  border-color: var(--border-strong);
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-field-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
  align-items: end;
  min-width: 0;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-field-grid .span-full {
  grid-column: 1 / -1;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-field-checkbox {
  display: inline-flex;
  gap: 8px;
  align-items: center;
  min-height: 36px;
  color: var(--fg);
  font-size: 13px;
  font-weight: 600;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-field-checkbox input {
  width: auto;
  min-height: auto;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-op-empty {
  display: grid;
  gap: 4px;
  padding: 24px 16px;
  text-align: center;
  border: 1px dashed var(--border-strong);
  border-radius: 10px;
  background: var(--surface);
  color: var(--fg-muted);
  font-size: 13px;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-op-empty strong {
  color: var(--fg-strong);
  font-weight: 650;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-op-empty span {
  font-size: 11px;
  color: var(--fg-subtle);
}
[${INGREDIENT_BUILDER_ENTITY_TABLE_ATTR}] table {
  width: 100%;
  min-width: 980px;
  border-collapse: collapse;
  table-layout: fixed;
}
[${INGREDIENT_BUILDER_ENTITY_TABLE_ATTR}] th,
[${INGREDIENT_BUILDER_ENTITY_TABLE_ATTR}] td {
  padding: 8px;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}
[${INGREDIENT_BUILDER_ENTITY_TABLE_ATTR}] th {
  text-align: left;
  font-size: 11px;
  text-transform: uppercase;
  color: var(--fg-muted);
  background: var(--surface-sunk);
  position: sticky;
  top: 0;
  z-index: 1;
}
[${INGREDIENT_BUILDER_ENTITY_TABLE_ATTR}] tr:last-child td {
  border-bottom: none;
}
[${INGREDIENT_BUILDER_ENTITY_TABLE_ATTR}] tbody tr:hover td {
  background: var(--surface-sunk);
}
[${INGREDIENT_BUILDER_ENTITY_TABLE_ATTR}] tbody tr.ingredient-builder-entity-extras-tr:hover td {
  background: transparent;
}
[${INGREDIENT_BUILDER_ENTITY_TABLE_ATTR}] .ingredient-builder-entity-extras-cell {
  padding: 0 8px 10px;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-empty-cell {
  padding: 16px;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-empty-state {
  color: var(--fg-muted);
  font-size: 13px;
}
[${INGREDIENT_BUILDER_ENTITY_TABLE_ATTR}] .review-cell {
  text-align: center;
}
[${INGREDIENT_BUILDER_ENTITY_TABLE_ATTR}] .review-cell input {
  width: auto;
  min-height: auto;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-status-line {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  min-width: 0;
  font-size: 13px;
  padding-top: 2px;
}
[${INGREDIENT_BUILDER_REVIEW_STATUS_ATTR}] {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  font-weight: 600;
  background: var(--surface);
  color: var(--fg-muted);
}
[${INGREDIENT_BUILDER_REVIEW_STATUS_ATTR}][data-state="valid"] {
  border-color: var(--border-strong);
  color: var(--fg-strong);
}
[${INGREDIENT_BUILDER_REVIEW_STATUS_ATTR}][data-state="invalid"] {
  background: var(--danger-weak);
  border-color: var(--danger);
  color: var(--danger);
}
[${INGREDIENT_BUILDER_STATUS_ATTR}] {
  min-width: 0;
  max-width: 100%;
  color: var(--fg-muted);
  overflow-wrap: anywhere;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-review-detail {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 13px;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-draft-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: end;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-draft-picker .ingredient-builder-field {
  flex: 1 1 220px;
  min-width: 180px;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-draft-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-dirty-dot {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-right: 2px;
  font-size: 11px;
  font-weight: 600;
  color: var(--fg-muted);
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-dirty-dot::before {
  content: "";
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--accent);
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-draft-error {
  flex-basis: 100%;
  color: var(--danger);
  font-size: 12px;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-workflow {
  position: sticky;
  top: 88px;
  display: grid;
  gap: 12px;
  max-height: calc(100vh - 112px);
  overflow: auto;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-pack-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 12px;
  align-items: end;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-meta-popover {
  position: relative;
  border: 0;
  background: transparent;
  box-shadow: none;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-meta-popover > summary {
  min-height: 34px;
  padding: 0;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-meta-popover > summary .ingredient-builder-section-header {
  display: inline-flex;
  flex-wrap: nowrap;
  min-height: 34px;
  gap: 6px;
  align-items: center;
  padding: 0 12px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: var(--surface);
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-meta-popover > summary .ingredient-builder-section-header::before {
  display: none;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-meta-popover h2 {
  font-size: 12px;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-meta-popover .ingredient-builder-section-meta {
  min-height: 18px;
  padding: 1px 6px;
  font-size: 10px;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-meta-popover > .ingredient-builder-panel-body {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 20;
  width: min(720px, calc(100vw - 48px));
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  box-shadow: 0 16px 36px rgba(0, 0, 0, 0.14);
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-pack-toggle {
  display: inline-flex;
  gap: 8px;
  align-items: center;
  min-height: 34px;
  color: var(--fg);
  font-size: 13px;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-pack-toggle input {
  width: auto;
  min-height: auto;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-preview-controls {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
  align-items: end;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-preview-controls button {
  width: 100%;
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-workflow-status {
  font-size: 12px;
  color: var(--fg-muted);
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-preview-detail,
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-install-detail {
  display: grid;
  gap: 4px;
  font-size: 12px;
  color: var(--fg-muted);
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-preview-detail code,
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-install-detail code {
  font-size: 11px;
}
[${INGREDIENT_BUILDER_FIELD_PRIVACY_ATTR}] {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
}
[${INGREDIENT_BUILDER_REVIEW_ISSUE_ATTR}] {
  flex-basis: 100%;
  color: var(--danger);
}
@media (max-width: 1100px) {
  [${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-topbar {
    position: static;
    grid-template-columns: minmax(160px, 0.7fr) minmax(360px, 1.3fr);
  }
  [${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-status-line {
    grid-column: 1 / -1;
  }
  [${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-overview {
    grid-template-columns: repeat(3, minmax(120px, 1fr));
  }
  [${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-layout {
    grid-template-columns: 1fr;
  }
  [${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-layout--workflow {
    grid-template-columns: 1fr;
  }
  [${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-workflow {
    position: static;
    max-height: none;
  }
  [${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-meta-popover > .ingredient-builder-panel-body {
    position: static;
    width: auto;
    margin-top: 6px;
    box-shadow: none;
  }
}
@media (max-width: 760px) {
  [${INGREDIENT_BUILDER_ROUTE_ATTR}] {
    padding: 16px 12px 24px;
  }
  [${INGREDIENT_BUILDER_ROUTE_ATTR}] button.rx-btn {
    min-width: 36px;
    min-height: 36px;
  }
  [${INGREDIENT_BUILDER_ROUTE_ATTR}] summary,
  [${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-field-checkbox,
  [${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-arg-affects,
  [${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-pack-toggle {
    min-height: 36px;
  }
  [${INGREDIENT_BUILDER_ENTITY_TABLE_ATTR}] .ingredient-builder-review-check {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 36px;
    min-height: 36px;
  }
  [${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-topbar {
    grid-template-columns: 1fr;
    padding: 14px 14px 0;
    border-radius: 12px;
  }
  [${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-status-line {
    grid-column: auto;
  }
  [${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-identity-card,
  [${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-draft-picker {
    grid-template-columns: 1fr;
  }
  [${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-card,
  [${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-field,
  [${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-op-card-body,
  [${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-panel,
  [${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-field-grid {
    min-width: 0;
  }
  [${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-field-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  [${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-arg-row {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  [${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-arg-row > :first-child,
  [${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-arg-row > select {
    grid-column: 1 / -1;
  }
  [${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-arg-affects {
    grid-column: 1;
    white-space: normal;
  }
  [${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-arg-row > .rx-btn {
    grid-column: 2;
  }
  [${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-overview {
    grid-template-columns: 1fr 1fr;
  }
  [${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-draft-actions {
    justify-content: stretch;
  }
  [${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-draft-actions button {
    flex: 1 0 auto;
    white-space: nowrap;
  }
}
/* ── Polish pass (mirrors the recipe editor) ─────────────────────── */

/* Clean state — hide the whole dirty cue (incl. the ::before dot; the
 * textContent is the only dot-less carrier, so :empty means clean). */
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-dirty-dot:empty {
  display: none;
}
/* Failures read as failures — progress notes stay muted. */
[${INGREDIENT_BUILDER_STATUS_ATTR}][data-state="error"] {
  color: var(--danger);
}
/* Section nav lives INSIDE the sticky topbar as a full-width underline-tab
 * row (the mini-app menu stays reachable while scrolled). */
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-topbar .ingredient-builder-nav {
  grid-column: 1 / -1;
  margin: 4px -16px 0;
  padding: 0 12px;
  border-top: 1px solid var(--border);
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-nav-tab.rx-btn {
  flex: 0 0 auto;
  border: 0;
  border-bottom: 2px solid transparent;
  border-radius: 0;
  background: transparent;
  padding: 10px 12px 12px;
  font-weight: 600;
  color: var(--fg-muted);
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-nav-tab.rx-btn:hover:not(:disabled) {
  background: transparent;
  color: var(--fg);
}
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-nav-tab--active.rx-btn {
  color: var(--fg-strong);
  border-bottom-color: var(--accent);
  background: var(--accent-weak);
}
/* Host-level validation issues (visible from every section). The scroll
 * margin keeps revealIssues() clear of the sticky topbar; the measured
 * offsetHeight overrides this fallback at scroll time. */
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-review-host {
  min-width: 0;
  margin-bottom: 16px;
  scroll-margin-top: 120px;
}
[${INGREDIENT_BUILDER_REVIEW_ISSUE_ATTR}] {
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
  padding: 6px 10px;
  border: 1px solid var(--danger);
  border-radius: 6px;
  background: var(--danger-weak);
  font-size: 12px;
  overflow-wrap: anywhere;
}
[${INGREDIENT_BUILDER_REVIEW_ISSUE_ATTR}][data-severity="warn"],
[${INGREDIENT_BUILDER_REVIEW_ISSUE_ATTR}][data-severity="info"] {
  border-color: var(--border-strong);
  background: var(--warn-bg);
  color: var(--fg);
}
/* Publish-section guidance while Preview/Install are still locked. */
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-publish-hint {
  margin: 0;
  padding: 12px 16px;
  border: 1px dashed var(--border-strong);
  border-radius: 10px;
  background: var(--surface);
  color: var(--fg-muted);
  font-size: 13px;
}
/* The Publish workflow renders full-width inside the section view (the
 * two-column rail layout is retired) — the rail-era sticky/self-scroll
 * behaviour would tuck its header under the (now taller) sticky topbar and
 * trap the grant picker in an inner scrollbar. Let the page scroll. */
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-section-view .ingredient-builder-workflow {
  position: static;
  max-height: none;
  overflow: visible;
}
/* Visually-hidden live region for outcome announcements. */
[${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-sr-announcer {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
@media (max-width: 520px) {
  [${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-topbar .ingredient-builder-nav {
    flex-wrap: wrap;
    gap: 0;
    overflow: visible;
    padding: 0;
  }
  [${INGREDIENT_BUILDER_ROUTE_ATTR}] .ingredient-builder-nav-tab.rx-btn {
    flex: 1 1 33.333%;
    justify-content: center;
    min-width: 0;
    padding-right: 6px;
    padding-left: 6px;
  }
}
`;

const RISK_TIERS: readonly OperationRiskTier[] = [
  'read',
  'write',
  'admin',
  'destructive',
] as const;

const APPROVALS: readonly OperationApproval[] = [
  'never',
  'ask',
  'always',
] as const;

/** D-170 — every authorable binding kind, in the order the Kind select offers
 *  them (typed kinds first, then the three raw-JSON-fallback realtime kinds). */
const BINDING_KINDS: readonly BindingKindDraft[] = [
  'rest',
  'graphql',
  'mcp',
  'core.records',
  'cli_invocation',
  'method_call',
  'webhook_subscription',
  'queue_subscription',
  'push_channel',
] as const;

/** The binding kinds with a typed labeled-field form. Every other kind renders
 *  the raw-JSON fallback (`bindingRawJsonText`). */
const TYPED_BINDING_KINDS: ReadonlySet<BindingKindDraft> = new Set<BindingKindDraft>([
  'rest',
  'graphql',
  'cli_invocation',
  'method_call',
]);

/** Connector kinds map onto the `connector` surface; everything else is `api`.
 *  Used to classify the pack service-kind (the surface is no longer a stored
 *  field — `PackOperationRow` derives it from the ingredient `kind`). */
const surfaceForBindingKind = (kind: BindingKindDraft): CompositionSurface =>
  kind === 'cli_invocation' || kind === 'method_call' ? 'connector' : 'api';

const CLI_STDIN_OPTIONS: readonly CliStdinHandling[] = CLI_STDIN_HANDLINGS;
const CLI_SHAPE_OPTIONS: readonly ('' | CliOutputShape)[] = ['', ...CLI_OUTPUT_SHAPES];
const CLI_STORAGE_OPTIONS: readonly ('' | CliOutputStorage)[] = ['', ...CLI_OUTPUT_STORAGES];

const ENTITY_FIELD_APPLIES: readonly EntityFieldApplies[] = [
  'request',
  'response',
  'both',
  'req',
  'resp',
] as const;

const ENTITY_FIELD_PRIVACY_OPTIONS: readonly EntityFieldPrivacyDraft[] = [
  '',
  ...ENTITY_FIELD_PRIVACY_KINDS,
] as const;

const AUTH_MODELS: readonly CompositionAuthModel[] = [
  'recued_injected',
  'cli_delegated',
] as const;

const PACK_SERVICE_KIND_OPTIONS: readonly PackServiceKindDraft[] = [
  '',
  ...PACK_SERVICE_KINDS,
] as const;

const PAGINATION_STYLE_OPTIONS: readonly (OperationPaginationStyle | '')[] = [
  '',
  ...OPERATION_PAGINATION_STYLES,
] as const;

const defaultRow = (id: string): OperationFamilyRowDraft => ({
  id,
  family: '',
  operation: '',
  verb: 'get',
  args: [],
  bindingKind: 'rest',
  restMethod: 'GET',
  restPathTemplate: '/path/{id}',
  restStaticQueryText: '{}',
  restMergeQueryText: '[]',
  restStaticHeadersText: '{}',
  restResponseCaptureText: '{}',
  graphqlOperationType: 'query',
  graphqlEndpointPath: '/graphql',
  graphqlQueryText: '',
  graphqlVariablesSchemaText: '{}',
  graphqlResultSchemaText: '{}',
  cliArgvText: '[]',
  cliStdin: 'none',
  cliShape: 'text',
  cliStorage: '',
  cliExitCodeText: '',
  cliDetachedText: '{}',
  cliOutputCaptureText: '{}',
  cliInputMaterializeText: '{}',
  cliProgressText: '{}',
  methodCallName: '',
  methodCallArgsMappingText: '{}',
  bindingRawJsonText: '{}',
  risk_tier: 'read',
  approval: 'never',
  reviewed: false,
  description: '',
  requiredScopesText: '[]',
  editableArgsText: '[]',
  timeoutMsText: '',
  cacheTtlMsText: '',
  resultPath: '',
  paginationStyle: '',
  paginationPageSizePlacement: 'query',
  paginationPageSizeParam: '',
  paginationPageSizeValue: '',
  paginationPageSizeMax: '',
  paginationDetailsText: '{}',
  extraJsonText: '{}',
});

const defaultEntityField = (id: string): EntityFieldRowDraft => ({
  id,
  entity: '',
  field_path: '',
  type: 'string',
  maps_to: '',
  optional: false,
  applies: 'response',
  pii: '',
  source: 'manual',
  description: '',
  label: '',
  references: '',
  sourceOperation: '',
  dateGranularity: '',
  derivationKind: '',
  derivationClosedPath: '',
  derivationWonPath: '',
  reviewed: false,
});

/** The route keeps one blank starter row mounted so the first operation can be
 * authored in place. Treat that editor shell as zero authored operations in
 * headings and progress metrics until it has an operation key. */
const authoredOperationRows = (
  rows: readonly OperationFamilyRowDraft[],
): readonly OperationFamilyRowDraft[] =>
  rows.filter((row) => row.operation.trim().length > 0);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isMetaFieldTypeValue = (value: unknown): value is MetaFieldType =>
  typeof value === 'string'
  && (META_FIELD_TYPES as readonly string[]).includes(value);

const isOperationArgTypeValue = (value: unknown): value is OperationArgType =>
  typeof value === 'string'
  && (OPERATION_ARG_TYPES as readonly string[]).includes(value);

const isEntityFieldPrivacyValue = (value: unknown): value is EntityFieldPrivacy =>
  typeof value === 'string'
  && (ENTITY_FIELD_PRIVACY_KINDS as readonly string[]).includes(value);

const isEntityFieldAppliesValue = (value: unknown): value is EntityFieldApplies =>
  typeof value === 'string'
  && (ENTITY_FIELD_APPLIES as readonly string[]).includes(value);

const isPackKindValue = (value: unknown): value is PackKind =>
  typeof value === 'string'
  && (PACK_KINDS as readonly string[]).includes(value);

const isPackServiceKindValue = (value: unknown): value is PackServiceKind =>
  typeof value === 'string'
  && (PACK_SERVICE_KINDS as readonly string[]).includes(value);

const isCompositionAuthModelValue = (value: unknown): value is CompositionAuthModel =>
  value === 'recued_injected' || value === 'cli_delegated';

const clearPreviewState = (state: IngredientBuilderState): void => {
  state.previewStage = 'idle';
  state.preview = undefined;
  state.previewError = '';
};

const clearInstallState = (state: IngredientBuilderState): void => {
  state.installStage = 'idle';
  state.installResult = undefined;
  state.installMessage = '';
  state.installWarnings = [];
  // D-182 §7.1 (inc 5b.2) — editing/re-reviewing invalidates the install grant
  // selection too: reset the Access tier to the `read` default so a prior
  // `write`/`all` pick can't carry into a freshly reviewed (possibly
  // lower-tier) draft (Codex 5b.2 MED). The render + submit paths also clamp
  // defensively to the model's offered tiers.
  state.installAccess = 'read';
  // D-182 §7.2 — reset Scope to the `owner` default too, so a prior `Everyone`
  // pick can't carry into a freshly reviewed draft.
  state.installAudience = { ...DEFAULT_INSTALL_AUDIENCE };
};

/** Live topbar refresh, one per mounted route (keyed by state identity so
 *  parallel mounts can't cross-wire). A focused field edit calls `markDirty`
 *  WITHOUT a rerender — deliberately, to keep input focus — so the topbar cues
 *  (Unsaved dot, Save label, status text, review chip) must update in place
 *  here or they keep claiming "Saved / validated" against edited state. */
const topbarSyncByState = new WeakMap<IngredientBuilderState, () => void>();

const markDirty = (state: IngredientBuilderState): void => {
  state.saveStage = 'idle';
  state.status = '';
  state.review = undefined;
  state.reviewIssues = [];
  state.editEpoch += 1;
  state.installInputEpoch += 1;
  // Starting to edit cancels a pending "Discard & New?" confirm.
  state.newConfirmPending = false;
  clearPreviewState(state);
  clearInstallState(state);
  topbarSyncByState.get(state)?.();
};

const markInstallDirty = (state: IngredientBuilderState): void => {
  state.installInputEpoch += 1;
  clearInstallState(state);
};

/** D-170 — every per-kind flat binding field on the draft, with neutral
 *  defaults. `bindingDraftFields` overlays the active kind's values onto this. */
type BindingDraftFields = Pick<
  OperationFamilyRowDraft,
  | 'bindingKind'
  | 'restMethod'
  | 'restPathTemplate'
  | 'restStaticQueryText'
  | 'restMergeQueryText'
  | 'restStaticHeadersText'
  | 'restResponseCaptureText'
  | 'graphqlOperationType'
  | 'graphqlEndpointPath'
  | 'graphqlQueryText'
  | 'graphqlVariablesSchemaText'
  | 'graphqlResultSchemaText'
  | 'cliArgvText'
  | 'cliStdin'
  | 'cliShape'
  | 'cliStorage'
  | 'cliExitCodeText'
  | 'cliDetachedText'
  | 'cliOutputCaptureText'
  | 'cliInputMaterializeText'
  | 'cliProgressText'
  | 'methodCallName'
  | 'methodCallArgsMappingText'
  | 'bindingRawJsonText'
>;

const defaultBindingDraftFields = (): BindingDraftFields => ({
  bindingKind: 'rest',
  restMethod: 'GET',
  restPathTemplate: '',
  restStaticQueryText: '{}',
  restMergeQueryText: '[]',
  restStaticHeadersText: '{}',
  restResponseCaptureText: '{}',
  graphqlOperationType: 'query',
  graphqlEndpointPath: '/graphql',
  graphqlQueryText: '',
  graphqlVariablesSchemaText: '{}',
  graphqlResultSchemaText: '{}',
  cliArgvText: '[]',
  cliStdin: 'none',
  cliShape: 'text',
  cliStorage: '',
  cliExitCodeText: '',
  cliDetachedText: '{}',
  cliOutputCaptureText: '{}',
  cliInputMaterializeText: '{}',
  cliProgressText: '{}',
  methodCallName: '',
  methodCallArgsMappingText: '{}',
  bindingRawJsonText: '{}',
});

/** Serialize an `exit_code_handling` value into the `cliExitCodeText` field:
 *  the literal `'zero_is_success'` stays as a bare token; a `{success_codes}`
 *  object is JSON-stringified. */
const cliExitCodeText = (value: CliMethodBinding['exit_code_handling']): string =>
  value === 'zero_is_success' ? 'zero_is_success' : JSON.stringify(value);

/** D-170 — split a typed op `bind` object into the draft's flat per-kind fields.
 *  Typed kinds populate their labeled fields and leave the raw-JSON fallback
 *  empty; the three realtime-API kinds set `bindingKind` and stash the whole
 *  binding object in `bindingRawJsonText`. */
const bindingDraftFields = (
  binding: ApiExecutionBinding | ConnectorExecutionBinding,
): BindingDraftFields => {
  const base = defaultBindingDraftFields();
  if (binding.kind === 'rest') {
    const rest = binding as RestExecutionBinding;
    return {
      ...base,
      bindingKind: 'rest',
      restMethod: rest.method,
      restPathTemplate: rest.path_template,
      restStaticQueryText: jsonText(rest.static_query, '{}'),
      restMergeQueryText: jsonText(rest.merge_query, '[]'),
      restStaticHeadersText: jsonText(rest.static_headers, '{}'),
      restResponseCaptureText: jsonText(rest.response_capture, '{}'),
    };
  }
  if (binding.kind === 'graphql') {
    const graphql = binding as GraphQLExecutionBinding;
    return {
      ...base,
      bindingKind: 'graphql',
      graphqlOperationType: graphql.operation_type,
      graphqlEndpointPath: graphql.endpoint_path,
      graphqlQueryText: graphql.query,
      graphqlVariablesSchemaText: jsonText(graphql.variables_schema, '{}'),
      graphqlResultSchemaText: jsonText(graphql.result_schema, '{}'),
    };
  }
  if (binding.kind === 'cli_invocation') {
    const cli = binding as CliMethodBinding;
    return {
      ...base,
      bindingKind: 'cli_invocation',
      cliArgvText: JSON.stringify(cli.argv_template),
      cliStdin: cli.stdin_handling ?? 'none',
      cliShape: cli.shape ?? '',
      cliStorage: cli.storage ?? '',
      cliExitCodeText: cliExitCodeText(cli.exit_code_handling),
      cliDetachedText: cli.detached === undefined ? '{}' : JSON.stringify(cli.detached),
      cliOutputCaptureText:
        cli.output_capture === undefined ? '{}' : JSON.stringify(cli.output_capture),
      cliInputMaterializeText:
        cli.input_materialize === undefined ? '{}' : JSON.stringify(cli.input_materialize),
      cliProgressText: cli.progress === undefined ? '{}' : JSON.stringify(cli.progress),
    };
  }
  if (binding.kind === 'method_call') {
    const method = binding as ConnectorMethodBinding;
    return {
      ...base,
      bindingKind: 'method_call',
      methodCallName: method.method_name,
      methodCallArgsMappingText:
        method.args_mapping === undefined ? '{}' : JSON.stringify(method.args_mapping),
    };
  }
  // webhook_subscription / queue_subscription / push_channel — no typed form
  // yet; carry the whole binding object verbatim through the raw-JSON fallback.
  return {
    ...base,
    bindingKind: binding.kind as BindingKindDraft,
    bindingRawJsonText: JSON.stringify(binding),
  };
};

const jsonText = (value: unknown, fallback = '{}'): string =>
  value === undefined ? fallback : JSON.stringify(value);

const stringArrayJsonText = (value: unknown): string =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? JSON.stringify(value)
    : '[]';

const numberText = (value: unknown): string =>
  typeof value === 'number' && Number.isFinite(value) ? String(value) : '';

const paginationDetailsText = (
  pagination: OperationPaginationSpec | undefined,
): string => {
  if (pagination === undefined) return '{}';
  const { style: _style, page_size, ...rest } = pagination;
  // The structured page-size editor owns ONLY the placement shape. A graphql_relay
  // variable page-size (`{ variable, value }`) has no structured editor, so keep it
  // in the raw details JSON — otherwise the read→write round-trip would drop it.
  const details =
    page_size !== undefined && !('placement' in page_size) ? { ...rest, page_size } : rest;
  return JSON.stringify(details);
};

const paginationPageSize = (pagination: OperationPaginationSpec | undefined): {
  placement: OperationPaginationPlacement;
  param: string;
  value: string;
  max: string;
} => {
  const pageSize = pagination?.page_size;
  // Only the placement shape feeds the structured editor; a graphql_relay variable
  // page-size rides the raw details JSON (see `paginationDetailsText`).
  const placementSize = pageSize !== undefined && 'placement' in pageSize ? pageSize : undefined;
  return {
    placement: placementSize?.placement ?? 'query',
    param: placementSize?.param ?? '',
    value: numberText(placementSize?.value),
    max: numberText(placementSize?.max),
  };
};

const operationExtraJsonText = (op: Record<string, unknown>): string => {
  const extra: Record<string, unknown> = {};
  if (typeof op.idempotency === 'string') extra.idempotency = op.idempotency;
  if (Array.isArray(op.accepts_media)) extra.accepts_media = op.accepts_media;
  if (Array.isArray(op.produces_media)) extra.produces_media = op.produces_media;
  if (op.request_schema !== undefined) extra.request_schema = op.request_schema;
  if (op.response_schema !== undefined) extra.response_schema = op.response_schema;
  return JSON.stringify(extra);
};

/** Read a raw `OperationArgEntry[]` into the editor's structured arg drafts. A
 *  bare string is a required string arg; an object carries an explicit
 *  type/authority. Defensive — a malformed entry (no key) is skipped. */
const operationArgDraftsFromRaw = (raw: unknown): OperationArgDraft[] => {
  if (!Array.isArray(raw)) return [];
  const drafts: OperationArgDraft[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      drafts.push({ key: entry, type: 'string', affectsTarget: false });
    } else if (isRecord(entry) && typeof entry.key === 'string') {
      drafts.push({
        key: entry.key,
        type: isOperationArgTypeValue(entry.type) ? entry.type : 'string',
        affectsTarget: entry.affects_target === true,
      });
    }
  }
  return drafts;
};

/** D-182 — read one raw `operations[]` record (a `PackOperationRow`) directly
 *  into an op-row draft. Replaces the old two-hop legacy-`OperationRow`
 *  projection (the projection where op-extras silently dropped). `family`/`verb`
 *  derive from the op id; the binding-kind flat fields come from the opaque
 *  `bind`; `reviewed` has no `PackOperationRow` equivalent (decomposer-set) so it
 *  defaults — same as the legacy path. */
const fromPackOperationRow = (
  op: Record<string, unknown>,
  id: string,
): OperationFamilyRowDraft => {
  const opId = typeof op.op === 'string' ? op.op : '';
  const dot = opId.indexOf('.');
  const bind = (isRecord(op.bind) ? op.bind : {}) as unknown as
    ApiExecutionBinding | ConnectorExecutionBinding;
  const pagination = isRecord(op.pagination)
    ? (op.pagination as unknown as OperationPaginationSpec)
    : undefined;
  const pageSize = paginationPageSize(pagination);
  return {
    id,
    family: dot > 0 ? opId.slice(0, dot) : opId,
    operation: opId,
    verb: dot >= 0 ? opId.slice(dot + 1) : opId,
    args: operationArgDraftsFromRaw(op.args),
    ...bindingDraftFields(bind),
    risk_tier: (op.risk as OperationRiskTier) ?? 'read',
    approval: (op.approval as OperationApproval) ?? 'never',
    reviewed: true,
    description: typeof op.description === 'string' ? op.description : '',
    requiredScopesText: stringArrayJsonText(op.required_scopes),
    editableArgsText: Array.isArray(op.editable_args) ? JSON.stringify(op.editable_args) : '[]',
    timeoutMsText: numberText(op.timeout_ms),
    cacheTtlMsText: numberText(op.cache_ttl_ms),
    resultPath: typeof op.result_path === 'string' ? op.result_path : '',
    paginationStyle: pagination?.style ?? '',
    paginationPageSizePlacement: pageSize.placement,
    paginationPageSizeParam: pageSize.param,
    paginationPageSizeValue: pageSize.value,
    paginationPageSizeMax: pageSize.max,
    paginationDetailsText: paginationDetailsText(pagination),
    extraJsonText: operationExtraJsonText(op),
  };
};

/** D-182 — read a loaded composition's `operations[]` directly into op-row
 *  drafts (one hop; no legacy intermediate). */
const operationDraftsFromComposition = (
  composition: Record<string, unknown>,
): OperationFamilyRowDraft[] => {
  const ops = Array.isArray(composition.operations) ? composition.operations : [];
  return ops
    .filter(isRecord)
    .map((op, idx) => fromPackOperationRow(op, `row-${idx}`));
};

/** D-182 — flatten a loaded composition's nested `ingredients[].entities`
 *  directly into entity-field drafts (one hop). The entity-level cross-vendor
 *  alias denormalizes onto every field draft of the entity so it round-trips. */
const entityFieldDraftsFromComposition = (
  composition: Record<string, unknown>,
): EntityFieldRowDraft[] => {
  const ingredients = Array.isArray(composition.ingredients) ? composition.ingredients : [];
  const drafts: EntityFieldRowDraft[] = [];
  for (const ing of ingredients) {
    if (!isRecord(ing) || !isRecord(ing.entities)) continue;
    for (const [entity, ent] of Object.entries(ing.entities)) {
      if (!isRecord(ent) || !Array.isArray(ent.fields)) continue;
      for (const field of ent.fields) {
        if (!isRecord(field)) continue;
        const derivation = isRecord(field.derivation) ? field.derivation : undefined;
        drafts.push({
          id: `field-${drafts.length}`,
          entity,
          field_path: typeof field.field_path === 'string' ? field.field_path : '',
          type: isMetaFieldTypeValue(field.type) ? field.type : 'string',
          maps_to: typeof field.maps_to === 'string' ? field.maps_to : '',
          optional: typeof field.optional === 'boolean' ? field.optional : false,
          applies: isEntityFieldAppliesValue(field.applies) ? field.applies : 'response',
          pii: isEntityFieldPrivacyValue(field.pii) ? field.pii : '',
          source: typeof field.source === 'string' ? field.source : 'manual',
          description: typeof field.description === 'string' ? field.description : '',
          label: typeof field.label === 'string' ? field.label : '',
          references: typeof field.references === 'string' ? field.references : '',
          sourceOperation: typeof field.source_operation === 'string' ? field.source_operation : '',
          dateGranularity: isDateGranularity(field.date_granularity) ? field.date_granularity : '',
          derivationKind: derivation?.kind === 'closed_state' ? 'closed_state' : '',
          derivationClosedPath:
            derivation !== undefined && typeof derivation.closed_path === 'string' ? derivation.closed_path : '',
          derivationWonPath:
            derivation !== undefined && typeof derivation.won_path === 'string' ? derivation.won_path : '',
          reviewed: true,
        });
      }
    }
  }
  return drafts;
};

/** Read the entity-level cross-vendor aliases off a loaded composition into the
 *  `entityAliases` map (keyed by trimmed entity name). Mirrors the entity walk
 *  in `entityFieldDraftsFromComposition` but collects the alias once per entity
 *  rather than denormalizing onto every field row. crm_alias wins if a
 *  malformed body carries both (the validator forbids that anyway); an
 *  unrecognized value is dropped (it's not a pickable option). */
const entityAliasesFromComposition = (
  composition: Record<string, unknown>,
): Record<string, EntityAlias> => {
  const aliases: Record<string, EntityAlias> = {};
  const ingredients = Array.isArray(composition.ingredients) ? composition.ingredients : [];
  for (const ing of ingredients) {
    if (!isRecord(ing) || !isRecord(ing.entities)) continue;
    for (const [entity, ent] of Object.entries(ing.entities)) {
      if (!isRecord(ent)) continue;
      const key = entity.trim();
      // A blank-entity bucket renders no alias picker (an alias on an unnamed
      // entity is meaningless), so don't load one — otherwise it would survive
      // round-trip invisibly, with no UI to see or clear it.
      if (key.length === 0) continue;
      if (typeof ent.crm_alias === 'string'
        && (CRM_ALIAS_VALUES as readonly string[]).includes(ent.crm_alias)) {
        aliases[key] = { crm_alias: ent.crm_alias as CrmAlias };
      } else if (typeof ent.acct_alias === 'string'
        && (ACCT_ALIAS_VALUES as readonly string[]).includes(ent.acct_alias)) {
        aliases[key] = { acct_alias: ent.acct_alias as AcctAlias };
      }
    }
  }
  return aliases;
};

const firstOperationKey = (rows: readonly OperationFamilyRowDraft[]): string =>
  rows.map((row) => row.operation.trim()).find((operation) => operation.length > 0) ?? '';

const operationKeys = (rows: readonly OperationFamilyRowDraft[]): string[] => {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const row of rows) {
    const key = row.operation.trim();
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
};

const packSlugFor = (slug: string): string =>
  `${slug.trim() || 'local-ingredient'}-pack`;

const defaultPackDescription = (slug: string): string =>
  `Locally authored v3 pack for ${slug.trim() || 'local-ingredient'}`;

const DEFAULT_PACK_TAGS = ['local', 'composition', 'v3'] as const;

const defaultPackTagsText = (): string => DEFAULT_PACK_TAGS.join(',');

const packLooksLikeManifest = (body: Record<string, unknown>): boolean =>
  body.artifact_type === 'pack'
  || body.manifest_version === BULK_PACK_MANIFEST_VERSION_V2
  || Array.isArray(body.contents);

const compositionRecordFromBody = (
  body: unknown,
): { composition?: Record<string, unknown>; pack?: Record<string, unknown> } => {
  if (!isRecord(body)) return {};
  if (!packLooksLikeManifest(body)) return { composition: body };
  const content = Array.isArray(body.contents)
    ? body.contents.find((entry): entry is Record<string, unknown> =>
      isRecord(entry) && entry.type === 'composition' && isRecord(entry.composition))
    : undefined;
  return {
    ...(content === undefined ? {} : { composition: content.composition as Record<string, unknown> }),
    pack: body,
  };
};

const stringArrayText = (value: unknown): string => {
  if (!Array.isArray(value) || !value.every((part) => typeof part === 'string')) return '';
  return JSON.stringify(value);
};

/** `composition.default_grants` (a `string[]` of derived group ids) → the
 *  comma-separated editor text. */
const defaultGrantsText = (value: unknown): string =>
  Array.isArray(value)
    ? value.filter((g): g is string => typeof g === 'string').join(', ')
    : '';

/** the comma-separated editor text → `default_grants` (trimmed, empties dropped). */
const defaultGrantsFromText = (text: string): string[] =>
  text.split(',').map((g) => g.trim()).filter((g) => g.length > 0);

const packTagsTextFromManifest = (pack: Record<string, unknown> | undefined): string => {
  if (pack === undefined || !Array.isArray(pack.tags)) return defaultPackTagsText();
  const tags = pack.tags.filter((tag): tag is string => typeof tag === 'string');
  return tags.length === 0 ? defaultPackTagsText() : tags.join(',');
};

const packDependenciesTextFromManifest = (
  pack: Record<string, unknown> | undefined,
): string =>
  pack !== undefined && Array.isArray(pack.dependencies)
    ? JSON.stringify(pack.dependencies)
    : '[]';

const packStateFromManifest = (
  pack: Record<string, unknown> | undefined,
  slug: string,
): Pick<
  IngredientBuilderState,
  | 'packSlug'
  | 'packPublisher'
  | 'packKind'
  | 'packServiceKind'
  | 'packDescription'
  | 'packTagsText'
  | 'packDependenciesText'
> => ({
  packSlug: typeof pack?.slug === 'string' && pack.slug.trim().length > 0
    ? pack.slug
    : packSlugFor(slug),
  packPublisher: typeof pack?.publisher === 'string' && pack.publisher.trim().length > 0
    ? pack.publisher
    : 'local-authoring',
  packKind: isPackKindValue(pack?.pack_kind) ? pack.pack_kind : 'app_pack',
  packServiceKind: isPackServiceKindValue(pack?.service_kind) ? pack.service_kind : '',
  packDescription: typeof pack?.description === 'string' && pack.description.trim().length > 0
    ? pack.description
    : defaultPackDescription(slug),
  packTagsText: packTagsTextFromManifest(pack),
  packDependenciesText: packDependenciesTextFromManifest(pack),
});

const stateFromBody = (
  body: unknown,
  initialTitle: string | undefined,
  initialDraftId: string | undefined,
): IngredientBuilderState => {
  const workflow = {
    drafts: [] as IngredientDraftSummary[],
    draftsStage: 'idle' as const,
    draftsError: '',
    previewArgsText: '{}',
    previewStage: 'idle' as const,
    previewError: '',
    installStage: 'idle' as const,
    installMessage: '',
    installWarnings: [] as AuthoringValidationIssue[],
    // D-182 §7.1 (inc 5b.2) — the install-time Access tier (default `read`)
    // sent as `install_scope.access` when the reviewed draft is
    // connection-backed (the grant picker is shown).
    installAccess: 'read' as const,
    // D-182 §7.2 / D-196 — the owner-only default Audience checklist sent as
    // `install_scope.audience`.
    installAudience: { ...DEFAULT_INSTALL_AUDIENCE },
    newConfirmPending: false,
    activeSection: 'overview' as const,
    opCardOpen: new Map<string, boolean>(),
    opAdvancedOpen: new Map<string, boolean>(),
    editEpoch: 0,
    installInputEpoch: 0,
    cleanEpoch: 0,
  };
  const { composition, pack } = compositionRecordFromBody(body);
  if (composition !== undefined) {
    const rows = operationDraftsFromComposition(composition);
    const entityFields = entityFieldDraftsFromComposition(composition);
    const entityAliases = entityAliasesFromComposition(composition);
    const ingredients = Array.isArray(composition.ingredients) ? composition.ingredients : [];
    const firstIngredient = isRecord(ingredients[0]) ? ingredients[0] : {};
    const ingredientKind = isOpKind(firstIngredient.kind) ? firstIngredient.kind : 'http';
    const http = isRecord(firstIngredient.http) ? firstIngredient.http : {};
    const cli = isRecord(firstIngredient.cli) ? firstIngredient.cli : {};
    const materializedRows = rows.length > 0 ? rows : [defaultRow('row-0')];
    const slug = typeof composition.slug === 'string' ? composition.slug : 'local-ingredient';
    return {
      ...workflow,
      ...(initialDraftId !== undefined ? { draftId: initialDraftId } : {}),
      title: initialTitle ?? slug,
      slug,
      connection: typeof http.connection === 'string' ? http.connection : '',
      httpBase: typeof http.base === 'string' ? http.base : '',
      httpResultPath: typeof http.result_path === 'string' ? http.result_path : '',
      httpSearchStyle: isSearchStyle(http.search_style) ? http.search_style : '',
      httpWriteStyle: isWriteStyle(http.write_style) ? http.write_style : '',
      catalogKind: isCatalogKind(composition.catalog_kind) ? composition.catalog_kind : 'private_byo',
      ingredientKind,
      authModel: ingredientKind === 'cli' ? 'cli_delegated' : 'recued_injected',
      cliTool: typeof cli.tool === 'string' ? cli.tool : '',
      cliReadinessProbe: stringArrayText(cli.probe),
      ...packStateFromManifest(pack, slug),
      packDefaultGrantsText: defaultGrantsText(composition.default_grants),
      workEntitySources: Array.isArray(composition.work_entity_sources)
        ? composition.work_entity_sources as NonNullable<CompositionIngredient['work_entity_sources']>
        : undefined,
      forceCatalogLowering: typeof composition.force_catalog_lowering === 'boolean'
        ? composition.force_catalog_lowering
        : undefined,
      rows: materializedRows,
      entityFields,
      entityAliases,
      saveStage: 'idle',
      status: '',
      reviewIssues: [],
      previewOperationKey: firstOperationKey(materializedRows),
    };
  }
  const rows = [defaultRow('row-0')];
  return {
    ...workflow,
    ...(initialDraftId !== undefined ? { draftId: initialDraftId } : {}),
    title: initialTitle ?? BLANK_DRAFT_TITLE,
    slug: BLANK_DRAFT_SLUG,
    connection: '',
    httpBase: '',
    httpResultPath: '',
    httpSearchStyle: '',
    httpWriteStyle: '',
    catalogKind: 'private_byo',
    ingredientKind: 'http',
    authModel: 'recued_injected',
    cliTool: '',
    cliReadinessProbe: '',
    ...packStateFromManifest(undefined, BLANK_DRAFT_SLUG),
    packDefaultGrantsText: '',
    workEntitySources: undefined,
    forceCatalogLowering: undefined,
    rows,
    entityFields: [],
    entityAliases: {},
    saveStage: 'idle',
    status: '',
    reviewIssues: [],
    previewOperationKey: firstOperationKey(rows),
  };
};

const argvTemplateFromBindingText = (value: string): string[] => {
  const trimmed = value.trim();
  if (trimmed.length === 0) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed) && parsed.every((part) => typeof part === 'string')) {
      return parsed;
    }
  } catch {
    return [trimmed];
  }
  return [trimmed];
};

const parseJsonObject = (text: string, label: string): Record<string, unknown> => {
  const trimmed = text.trim();
  if (trimmed.length === 0) return {};
  const parsed = JSON.parse(trimmed) as unknown;
  if (!isRecord(parsed)) throw new Error(`${label} must be a JSON object`);
  return parsed;
};

const parseJsonArray = <T = unknown>(text: string, label: string): T[] => {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  const parsed = JSON.parse(trimmed) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`${label} must be a JSON array`);
  return parsed as T[];
};

const optionalIntegerFromText = (text: string, label: string): number | undefined => {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  const n = Number(trimmed);
  if (!Number.isInteger(n)) throw new Error(`${label} must be an integer`);
  return n;
};

const paginationForRow = (row: OperationFamilyRowDraft): OperationPaginationSpec | undefined => {
  if (row.paginationStyle === '') return undefined;
  const details = parseJsonObject(row.paginationDetailsText, 'Pagination details');
  const pageSizeValue = optionalIntegerFromText(row.paginationPageSizeValue, 'Pagination page size');
  const pageSizeMax = optionalIntegerFromText(row.paginationPageSizeMax, 'Pagination page max');
  const pageSize =
    pageSizeValue === undefined && row.paginationPageSizeParam.trim().length === 0
      ? undefined
      : {
          placement: row.paginationPageSizePlacement,
          param: row.paginationPageSizeParam.trim(),
          value: pageSizeValue ?? 0,
          ...(pageSizeMax !== undefined ? { max: pageSizeMax } : {}),
        };
  return {
    style: row.paginationStyle,
    ...details,
    ...(pageSize !== undefined ? { page_size: pageSize } : {}),
  } as OperationPaginationSpec;
};

const cliStdinHandling = (value: unknown): CliMethodBinding['stdin_handling'] =>
  value === 'pipe_args' || value === 'pipe_body' ? value : 'none';

const cliExitCodeHandling = (value: unknown): CliMethodBinding['exit_code_handling'] => {
  if (isRecord(value) && Array.isArray(value.success_codes)) {
    const successCodes = value.success_codes.filter((code): code is number =>
      Number.isInteger(code));
    if (successCodes.length > 0) return { success_codes: successCodes };
  }
  return 'zero_is_success';
};

const isStringRecord = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');

/** Parse a `*Text` field that should hold a JSON object into a typed
 *  `Record<string, string>`, or `undefined` when empty/`{}`. Used for REST
 *  `static_query` / `static_headers`. */
const optionalStringRecordFromText = (
  text: string,
  label: string,
): Record<string, string> | undefined => {
  const parsed = parseJsonObject(text, label);
  if (Object.keys(parsed).length === 0) return undefined;
  if (!isStringRecord(parsed)) {
    throw new Error(`${label} must be a JSON object of strings`);
  }
  return parsed;
};

/** Parse a `*Text` field that should hold a JSON string-array into a typed
 *  `string[]`, or `undefined` when empty/`[]`. Used for REST `merge_query`. */
const optionalStringArrayFromText = (
  text: string,
  label: string,
): string[] | undefined => {
  const parsed = parseJsonArray<unknown>(text, label);
  if (parsed.length === 0) return undefined;
  if (!parsed.every((entry) => typeof entry === 'string')) {
    throw new Error(`${label} must be a JSON array of strings`);
  }
  return parsed as string[];
};

/** D-170 — build the REST binding from the draft's typed flat fields. The
 *  method comes from the dedicated `restMethod` select (no longer re-derived
 *  from the verb at serialize). */
const restBindingFromRow = (row: OperationFamilyRowDraft): RestExecutionBinding => {
  const staticQuery = optionalStringRecordFromText(row.restStaticQueryText, 'Static query');
  const mergeQuery = optionalStringArrayFromText(row.restMergeQueryText, 'Merge query');
  const staticHeaders = optionalStringRecordFromText(row.restStaticHeadersText, 'Static headers');
  const responseCapture = parseJsonObject(row.restResponseCaptureText, 'Response capture');
  return {
    kind: 'rest',
    method: row.restMethod,
    path_template: row.restPathTemplate.trim(),
    ...(staticQuery !== undefined ? { static_query: staticQuery } : {}),
    ...(mergeQuery !== undefined ? { merge_query: mergeQuery } : {}),
    ...(staticHeaders !== undefined ? { static_headers: staticHeaders } : {}),
    ...(Object.keys(responseCapture).length > 0
      ? { response_capture: responseCapture as unknown as RestExecutionBinding['response_capture'] }
      : {}),
  };
};

/** D-170 — build the GraphQL binding from the draft's typed flat fields. */
const graphqlBindingFromRow = (row: OperationFamilyRowDraft): GraphQLExecutionBinding => {
  const variablesSchema = parseJsonObject(row.graphqlVariablesSchemaText, 'GraphQL variables schema');
  const resultSchema = parseJsonObject(row.graphqlResultSchemaText, 'GraphQL result schema');
  return {
    kind: 'graphql',
    operation_type: row.graphqlOperationType,
    endpoint_path: row.graphqlEndpointPath.trim(),
    query: row.graphqlQueryText,
    ...(Object.keys(variablesSchema).length > 0 ? { variables_schema: variablesSchema } : {}),
    ...(Object.keys(resultSchema).length > 0 ? { result_schema: resultSchema } : {}),
  };
};

/** D-170 — build the cli_invocation binding from the draft's typed flat fields.
 *  `cliExitCodeText` accepts '' / 'zero_is_success' (both map to the literal)
 *  or a JSON `{"success_codes":[...]}` object. `detached` / `output_capture`
 *  parse from their JSON `*Text` fields (empty/`{}` → omitted). */
const cliBindingFromRow = (row: OperationFamilyRowDraft): CliMethodBinding => {
  const detached = parseJsonObject(row.cliDetachedText, 'CLI detached');
  const outputCapture = parseJsonObject(row.cliOutputCaptureText, 'CLI output capture');
  const inputMaterialize = parseJsonObject(row.cliInputMaterializeText, 'CLI input materialize');
  const progress = parseJsonObject(row.cliProgressText, 'CLI progress');
  const exitTrimmed = row.cliExitCodeText.trim();
  const exitCode: CliMethodBinding['exit_code_handling'] =
    exitTrimmed.length === 0 || exitTrimmed === 'zero_is_success'
      ? 'zero_is_success'
      : cliExitCodeHandling(parseJsonObject(row.cliExitCodeText, 'CLI exit code handling'));
  return {
    kind: 'cli_invocation',
    argv_template: argvTemplateFromBindingText(row.cliArgvText),
    stdin_handling: cliStdinHandling(row.cliStdin),
    ...(row.cliShape ? { shape: row.cliShape } : {}),
    ...(row.cliStorage ? { storage: row.cliStorage } : {}),
    exit_code_handling: exitCode,
    ...(Object.keys(detached).length > 0
      ? { detached: detached as unknown as CliMethodBinding['detached'] }
      : {}),
    ...(Object.keys(outputCapture).length > 0
      ? { output_capture: outputCapture as unknown as CliMethodBinding['output_capture'] }
      : {}),
    ...(Object.keys(inputMaterialize).length > 0
      ? { input_materialize: inputMaterialize as unknown as CliMethodBinding['input_materialize'] }
      : {}),
    ...(Object.keys(progress).length > 0
      ? { progress: progress as unknown as CliMethodBinding['progress'] }
      : {}),
  };
};

/** D-170 — build the method_call binding from the draft's typed flat fields.
 *  `args_mapping` parses from its JSON `*Text` field (empty/`{}` → omitted). */
const methodCallBindingFromRow = (row: OperationFamilyRowDraft): ConnectorMethodBinding => {
  const argsMapping = parseJsonObject(row.methodCallArgsMappingText, 'Args mapping');
  return {
    kind: 'method_call',
    method_name: row.methodCallName.trim(),
    ...(Object.keys(argsMapping).length > 0 ? { args_mapping: argsMapping } : {}),
  };
};

/** D-170 — assemble the typed op `bind` object from the draft's `bindingKind` +
 *  flat fields (inverse of `bindingDraftFields`). The three realtime-API kinds
 *  parse their whole binding object from the raw-JSON fallback field. */
const bindingFromRow = (
  row: OperationFamilyRowDraft,
): ApiExecutionBinding | ConnectorExecutionBinding => {
  switch (row.bindingKind) {
    case 'rest':
      return restBindingFromRow(row);
    case 'graphql':
      return graphqlBindingFromRow(row);
    case 'cli_invocation':
      return cliBindingFromRow(row);
    case 'method_call':
      return methodCallBindingFromRow(row);
    default: {
      // webhook_subscription / queue_subscription / push_channel — carry the
      // raw-JSON fallback verbatim; composition validators own the deep shape.
      const parsed = parseJsonObject(row.bindingRawJsonText, 'Binding JSON');
      return parsed as unknown as ApiExecutionBinding;
    }
  }
};

/** D-182 — project one entity-field draft into a nested `IngredientEntityField`
 *  (the per-field shape, minus the entity key + the entity-level aliases, which
 *  `buildEntities` groups). */
const toIngredientEntityField = (row: EntityFieldRowDraft): IngredientEntityField => {
  const source = row.source.trim();
  const description = row.description.trim();
  const label = row.label.trim();
  const references = row.references.trim();
  const sourceOperation = row.sourceOperation.trim();
  const closedPath = row.derivationClosedPath.trim();
  const wonPath = row.derivationWonPath.trim();
  // A `closed_state` derivation needs both vendor paths; emit it only when fully
  // specified (a half-built derivation is dropped, like an unfilled arg row).
  const derivation: FieldDerivation | undefined =
    row.derivationKind === 'closed_state' && closedPath.length > 0 && wonPath.length > 0
      ? { kind: 'closed_state', closed_path: closedPath, won_path: wonPath }
      : undefined;
  return {
    field_path: row.field_path.trim(),
    type: row.type,
    maps_to: row.maps_to.trim(),
    optional: row.optional,
    applies: row.applies,
    ...(row.pii === '' ? {} : { pii: row.pii }),
    ...(source.length > 0 ? { source } : {}),
    ...(sourceOperation.length > 0 ? { source_operation: sourceOperation } : {}),
    ...(description.length > 0 ? { description } : {}),
    ...(label.length > 0 ? { label } : {}),
    ...(references.length > 0 ? { references } : {}),
    ...(row.dateGranularity === '' ? {} : { date_granularity: row.dateGranularity }),
    ...(derivation !== undefined ? { derivation } : {}),
  };
};

const cliReadinessProbeForState = (state: IngredientBuilderState, tool: string): string[] => {
  const parsed = argvTemplateFromBindingText(state.cliReadinessProbe);
  return parsed.length > 0 ? parsed : [tool, '--version'];
};

// D-182 3b — the editor authors the two-table shape. The single-grid UI state
// (per-op rows + flat entity-field drafts + authModel/connection/cli) is
// unchanged; only the build/parse glue here emits/reads `ingredients[]` +
// `operations[]`. (The full two-grid authoring UX is slice 6.)

/** Group the flat entity-field drafts into the nested per-entity schema the
 *  ingredient carries (`IngredientEntity` map keyed by entity id; the entity-
 *  level cross-vendor alias rides on the entity, the rest on each field). */
/** The combined alias picker's current value for an entity — the set field, or
 *  '' when the entity has no alias. */
const entityAliasValue = (alias: EntityAlias | undefined): EntityAliasValue => {
  if (alias === undefined) return '';
  if (alias.crm_alias !== undefined) return alias.crm_alias;
  if (alias.acct_alias !== undefined) return alias.acct_alias;
  return '';
};

/** Route a picked alias value onto the right field (or clear the entry). The
 *  CRM / accounting value sets are disjoint, so membership unambiguously
 *  decides the axis — and storing a single value naturally enforces the
 *  crm_alias-XOR-acct_alias rule. */
const setEntityAlias = (
  state: IngredientBuilderState,
  entity: string,
  value: EntityAliasValue,
): void => {
  if (value === '') {
    delete state.entityAliases[entity];
  } else if ((CRM_ALIAS_VALUES as readonly string[]).includes(value)) {
    state.entityAliases[entity] = { crm_alias: value as CrmAlias };
  } else {
    state.entityAliases[entity] = { acct_alias: value as AcctAlias };
  }
};

const buildEntities = (
  rows: readonly EntityFieldRowDraft[],
  aliases: Record<string, EntityAlias>,
): Record<string, IngredientEntity> | undefined => {
  if (rows.length === 0) return undefined;
  const entities: Record<string, IngredientEntity> = {};
  for (const draft of rows) {
    const entity = draft.entity.trim();
    const target = entities[entity] ?? { fields: [] };
    target.fields.push(toIngredientEntityField(draft));
    entities[entity] = target;
  }
  // Apply entity-level cross-vendor aliases — only onto entities that have rows
  // (an alias keyed under a since-renamed/removed entity is silently dropped).
  for (const [entity, target] of Object.entries(entities)) {
    const alias = aliases[entity];
    if (alias === undefined) continue;
    if (alias.crm_alias !== undefined) target.crm_alias = alias.crm_alias;
    else if (alias.acct_alias !== undefined) target.acct_alias = alias.acct_alias;
  }
  return entities;
};

/** Build the single Table-A ingredient from the draft's auth/connection/cli
 *  state. The composition's slug is the ingredient slug (single-ingredient). */
const buildIngredient = (state: IngredientBuilderState, slug: string): IngredientRow => {
  const entities = buildEntities(state.entityFields, state.entityAliases);
  if (state.ingredientKind === 'cli') {
    const tool = state.cliTool.trim() || slug || 'cli';
    const ingredient: IngredientRow = {
      slug,
      kind: 'cli',
      cli: { tool, probe: cliReadinessProbeForState(state, tool) },
    };
    if (entities !== undefined) ingredient.entities = entities;
    return ingredient;
  }
  if (state.ingredientKind !== 'http') {
    const ingredient: IngredientRow = { slug, kind: state.ingredientKind };
    if (entities !== undefined) ingredient.entities = entities;
    return ingredient;
  }
  const ingredient: IngredientRow = {
    slug,
    kind: 'http',
    http: {
      base: state.httpBase.trim() || 'https://api.example.com',
      ...(state.connection.trim().length > 0 ? { connection: state.connection.trim() } : {}),
      ...(state.httpResultPath.trim().length > 0 ? { result_path: state.httpResultPath.trim() } : {}),
      ...(state.httpSearchStyle !== '' ? { search_style: state.httpSearchStyle } : {}),
      ...(state.httpWriteStyle !== '' ? { write_style: state.httpWriteStyle } : {}),
    },
  };
  if (entities !== undefined) ingredient.entities = entities;
  return ingredient;
};

/** Compact the structured arg drafts back to `OperationArgEntry[]` — a bare
 *  string when the arg is a plain required string (default `string` type, no
 *  D-177 authority), else the object form. Args with an empty key are dropped
 *  (an unfilled repeater row). */
const operationArgsForRow = (row: OperationFamilyRowDraft): OperationArgEntry[] => {
  const args: OperationArgEntry[] = [];
  for (const arg of row.args) {
    const key = arg.key.trim();
    if (key.length === 0) continue;
    if (arg.type === 'string' && !arg.affectsTarget) {
      args.push(key);
    } else {
      args.push({
        key,
        ...(arg.type === 'string' ? {} : { type: arg.type }),
        ...(arg.affectsTarget ? { affects_target: true } : {}),
      });
    }
  }
  return args;
};

/** D-182 §4 — the modeled carried columns on a `PackOperationRow` beyond the
 *  always-present `op`/`ingredient`/`risk`/`approval`/`bind`. The save merges the
 *  dedicated draft inputs over the raw extra-JSON escape hatch, then keeps only
 *  these columns — arbitrary extra-JSON keys are dropped, matching the legacy
 *  two-step projection. The last five (idempotency / media / schemas) have no
 *  dedicated input and arrive ONLY through extra-JSON. */
const PACK_OP_CARRIED_COLUMNS = [
  'args', 'description', 'required_scopes', 'editable_args', 'result_path', 'pagination',
  'timeout_ms', 'cache_ttl_ms', 'idempotency', 'accepts_media', 'produces_media',
  'request_schema', 'response_schema',
] as const;

/** Build one Table-B `PackOperationRow` directly from an op-row draft (one hop;
 *  no legacy `OperationRow` intermediate). The binding-kind flat fields assemble
 *  back into the opaque `bind`; the carried op-extras (the dedicated meta inputs,
 *  falling back to the extra-JSON escape hatch, plus the five extra-JSON-only
 *  schema/media columns) write once via the whitelist below. `op` is the full
 *  pack-local op id; `family`/`verb`/`reviewed` are draft-only (derived or
 *  decomposer-set) and have no row equivalent. */
const toPackOperationRow = (
  row: OperationFamilyRowDraft,
  ingredientSlug: string,
): PackOperationRow => {
  const description = row.description.trim();
  const resultPath = row.resultPath.trim();
  const args = operationArgsForRow(row);
  const requiredScopes = parseJsonArray<string>(row.requiredScopesText, 'Required scopes');
  const editableArgs = parseJsonArray<NonNullable<PackOperationRow['editable_args']>[number]>(
    row.editableArgsText,
    'Editable args',
  );
  const timeoutMs = optionalIntegerFromText(row.timeoutMsText, 'Timeout ms');
  const cacheTtlMs = optionalIntegerFromText(row.cacheTtlMsText, 'Cache ttl ms');
  const pagination = paginationForRow(row);
  // `args` is authored ONLY through the structured repeater. Drop any `args` key
  // typed into the Extra JSON escape hatch so it can't smuggle past the
  // parser/compactor — otherwise an empty repeater ("No callable inputs") could
  // still save hidden, un-normalized args. The dedicated spread below is the
  // sole `args` writer (it stays in the whitelist for that spread to survive).
  const { args: _droppedExtraArgs, ...extra } = parseJsonObject(
    row.extraJsonText,
    'Extra operation JSON',
  );
  // Dedicated draft inputs win; the raw extra-JSON object is the fallback (mirror
  // of the legacy `{...extra, ...dedicated}` merge). The whitelist drops any
  // extra-JSON key that is not a modeled column.
  const carried: Record<string, unknown> = {
    ...extra,
    ...(args.length > 0 ? { args } : {}),
    ...(description.length > 0 ? { description } : {}),
    ...(requiredScopes.length > 0 ? { required_scopes: requiredScopes } : {}),
    ...(editableArgs.length > 0 ? { editable_args: editableArgs } : {}),
    ...(resultPath.length > 0 ? { result_path: resultPath } : {}),
    ...(pagination !== undefined ? { pagination } : {}),
    ...(timeoutMs !== undefined ? { timeout_ms: timeoutMs } : {}),
    ...(cacheTtlMs !== undefined ? { cache_ttl_ms: cacheTtlMs } : {}),
  };
  const op: PackOperationRow = {
    op: row.operation.trim(),
    ingredient: ingredientSlug,
    risk: row.risk_tier,
    approval: row.approval,
    bind: bindingFromRow(row) as unknown as Record<string, unknown>,
  };
  const writable = op as unknown as Record<string, unknown>;
  for (const key of PACK_OP_CARRIED_COLUMNS) {
    if (carried[key] !== undefined) writable[key] = carried[key];
  }
  return op;
};

const buildComposition = (state: IngredientBuilderState): CompositionIngredient => {
  const slug = state.slug.trim() || 'local-ingredient';
  const defaultGrants = defaultGrantsFromText(state.packDefaultGrantsText);
  return {
    schema_version: 1,
    slug,
    catalog_kind: state.catalogKind,
    ...(state.forceCatalogLowering !== undefined
      ? { force_catalog_lowering: state.forceCatalogLowering }
      : {}),
    ingredients: [buildIngredient(state, slug)],
    operations: state.rows.map((row) => toPackOperationRow(row, slug)),
    ...(defaultGrants.length > 0 ? { default_grants: defaultGrants } : {}),
    ...(state.workEntitySources !== undefined
      ? { work_entity_sources: state.workEntitySources }
      : {}),
  };
};

const packTagsFromText = (text: string): string[] => {
  const tags = text
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
  return tags.length > 0 ? tags : [...DEFAULT_PACK_TAGS];
};

const packDependenciesFromText = (text: string): PackDependency[] => {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  const parsed = JSON.parse(trimmed) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('Pack dependencies must be a JSON array');
  }
  return parsed as PackDependency[];
};

const packServiceKindForState = (state: IngredientBuilderState): PackServiceKind => {
  if (state.packServiceKind !== '') return state.packServiceKind;
  return state.authModel === 'cli_delegated'
    || state.rows.some((row) => surfaceForBindingKind(row.bindingKind) === 'connector')
    ? 'cli'
    : 'entity_platform';
};

const installManifestFor = (
  state: IngredientBuilderState,
  body: unknown,
): unknown => {
  const composition = (compositionRecordFromBody(body).composition ?? body) as CompositionIngredient;
  const slug = typeof composition.slug === 'string' && composition.slug.trim().length > 0
    ? composition.slug.trim()
    : state.slug.trim() || 'local-ingredient';
  const title = state.title.trim() || slug;
  const dependencies = packDependenciesFromText(state.packDependenciesText);
  return {
    manifest_version: BULK_PACK_MANIFEST_VERSION_V2,
    artifact_type: 'pack',
    pack_kind: state.packKind,
    service_kind: packServiceKindForState(state),
    slug: state.packSlug.trim() || packSlugFor(slug),
    publisher: state.packPublisher.trim() || 'local-authoring',
    name: title,
    description: state.packDescription.trim() || defaultPackDescription(slug),
    version: 1,
    recipes: [],
    requires: [BULK_PACK_INSTALL_PERMISSION],
    tags: packTagsFromText(state.packTagsText),
    contents: [{ type: 'composition', composition }],
    ...(dependencies.length > 0 ? { dependencies } : {}),
  } satisfies BulkPackManifest;
};

const clearChildren = (el: HTMLElement): void => {
  while (el.firstChild) el.removeChild(el.firstChild);
};

const appendText = (
  doc: Document,
  parent: HTMLElement,
  tag: keyof HTMLElementTagNameMap,
  text: string,
): HTMLElement => {
  const el = doc.createElement(tag);
  el.textContent = text;
  parent.appendChild(el);
  return el;
};

/** A `<button>` built on the `.rx-btn` primitive — variant + size only, no
 *  doubled legacy `btn btn-*` strings (D-174 cleanup). */
const makeButton = (
  doc: Document,
  label: string,
  variant: 'primary' | 'secondary' | 'danger-text',
  size: 'xs' | 'sm',
  onClick: () => void,
): HTMLButtonElement => {
  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.className = `rx-btn rx-btn-${variant} rx-btn-${size}`;
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
};

const ingredientBuilderFocusFieldKey = (
  attrName: string,
  attrValue: string,
): string => JSON.stringify([attrName, attrValue]);

const makeTextInputWithAttr = (
  doc: Document,
  value: string,
  attrName: string,
  attrValue: string,
  onInput: (next: string) => void,
): HTMLInputElement => {
  const input = doc.createElement('input');
  input.type = 'text';
  input.value = value;
  input.setAttribute(attrName, attrValue);
  input.setAttribute(
    INGREDIENT_BUILDER_FOCUS_FIELD_ATTR,
    ingredientBuilderFocusFieldKey(attrName, attrValue),
  );
  input.addEventListener('input', () => onInput(input.value));
  return input;
};

const makeTextareaWithAttr = (
  doc: Document,
  value: string,
  attrName: string,
  attrValue: string,
  onInput: (next: string) => void,
): HTMLTextAreaElement => {
  const textarea = doc.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute(attrName, attrValue);
  textarea.setAttribute(
    INGREDIENT_BUILDER_FOCUS_FIELD_ATTR,
    ingredientBuilderFocusFieldKey(attrName, attrValue),
  );
  textarea.addEventListener('input', () => onInput(textarea.value));
  return textarea;
};

const makeTextInput = (
  doc: Document,
  value: string,
  attrValue: string,
  onInput: (next: string) => void,
): HTMLInputElement =>
  makeTextInputWithAttr(doc, value, INGREDIENT_BUILDER_FIELD_ATTR, attrValue, onInput);

const makeEntityTextInput = (
  doc: Document,
  value: string,
  attrValue: string,
  onInput: (next: string) => void,
): HTMLInputElement =>
  makeTextInputWithAttr(doc, value, INGREDIENT_BUILDER_ENTITY_FIELD_ATTR, attrValue, onInput);

const makeSelectWithAttr = <T extends string>(
  doc: Document,
  value: T,
  options: readonly T[],
  attrName: string,
  attrValue: string,
  onChange: (next: T) => void,
): HTMLSelectElement => {
  const select = doc.createElement('select');
  select.value = value;
  select.setAttribute(attrName, attrValue);
  select.setAttribute(
    INGREDIENT_BUILDER_FOCUS_FIELD_ATTR,
    ingredientBuilderFocusFieldKey(attrName, attrValue),
  );
  for (const option of options) {
    const el = doc.createElement('option');
    el.value = option;
    el.textContent = option.length === 0 ? 'none' : option;
    if (option === value) el.selected = true;
    select.appendChild(el);
  }
  select.addEventListener('change', () => onChange(select.value as T));
  return select;
};

const makeSelect = <T extends string>(
  doc: Document,
  value: T,
  options: readonly T[],
  attrValue: string,
  onChange: (next: T) => void,
): HTMLSelectElement =>
  makeSelectWithAttr(doc, value, options, INGREDIENT_BUILDER_FIELD_ATTR, attrValue, onChange);

const makeEntitySelect = <T extends string>(
  doc: Document,
  value: T,
  options: readonly T[],
  attrValue: string,
  onChange: (next: T) => void,
): HTMLSelectElement =>
  makeSelectWithAttr(doc, value, options, INGREDIENT_BUILDER_ENTITY_FIELD_ATTR, attrValue, onChange);

const addCell = (
  doc: Document,
  row: HTMLTableRowElement,
  child: HTMLElement,
): void => {
  const cell = doc.createElement('td');
  cell.appendChild(child);
  row.appendChild(cell);
};

const appendSectionHeader = (
  doc: Document,
  host: HTMLElement,
  title: string,
  meta: string,
): HTMLElement => {
  const header = doc.createElement('div');
  header.className = 'ingredient-builder-section-header';
  appendText(doc, header, 'h2', title);
  const badge = appendText(doc, header, 'span', meta);
  badge.className = 'ingredient-builder-section-meta';
  host.appendChild(header);
  return header;
};

const appendSectionIntro = (
  doc: Document,
  host: HTMLElement,
  title: string,
  description: string,
): void => {
  const intro = doc.createElement('div');
  intro.className = 'ingredient-builder-section-intro';
  appendText(doc, intro, 'h2', title);
  appendText(doc, intro, 'p', description);
  host.appendChild(intro);
};

const appendPanelSummary = (
  doc: Document,
  panel: HTMLElement,
  title: string,
  meta: string,
): void => {
  const summary = doc.createElement('summary');
  const header = doc.createElement('div');
  header.className = 'ingredient-builder-section-header';
  appendText(doc, header, 'h2', title);
  if (meta.length > 0) {
    const badge = appendText(doc, header, 'span', meta);
    badge.className = 'ingredient-builder-section-meta';
  }
  summary.appendChild(header);
  panel.appendChild(summary);
};

const addAdvancedField = (
  doc: Document,
  grid: HTMLElement,
  labelText: string,
  child: HTMLElement,
  wide = false,
): void => {
  const field = doc.createElement('div');
  field.className = wide
    ? 'ingredient-builder-field span-full'
    : 'ingredient-builder-field';
  const label = doc.createElement('label');
  label.textContent = labelText;
  if (child.getAttribute('aria-label') === null) {
    child.setAttribute('aria-label', labelText);
  }
  field.appendChild(label);
  field.appendChild(child);
  grid.appendChild(field);
};

/** A labeled sub-group inside the Advanced panel (Binding / Execution /
 *  Pagination), so the per-op field set reads as grouped sections instead of
 *  one undifferentiated wall. Returns the inner field grid to append into. */
const addAdvancedSubsection = (
  doc: Document,
  host: HTMLElement,
  title: string,
): HTMLElement => {
  const section = doc.createElement('div');
  section.className = 'ingredient-builder-advanced-subsection';
  const label = doc.createElement('div');
  label.className = 'ingredient-builder-subsection-label';
  label.textContent = title;
  section.appendChild(label);
  const grid = doc.createElement('div');
  grid.className = 'ingredient-builder-field-grid';
  section.appendChild(grid);
  host.appendChild(section);
  return grid;
};

const makeOperationAdvancedInput = (
  doc: Document,
  entry: OperationFamilyRowDraft,
  field: string,
  value: string,
  onInput: (next: string) => void,
): HTMLInputElement =>
  makeTextInputWithAttr(
    doc,
    value,
    INGREDIENT_BUILDER_OPERATION_ADVANCED_FIELD_ATTR,
    `${entry.id}:${field}`,
    onInput,
  );

const makeOperationAdvancedTextarea = (
  doc: Document,
  entry: OperationFamilyRowDraft,
  field: string,
  value: string,
  onInput: (next: string) => void,
): HTMLTextAreaElement =>
  makeTextareaWithAttr(
    doc,
    value,
    INGREDIENT_BUILDER_OPERATION_ADVANCED_FIELD_ATTR,
    `${entry.id}:${field}`,
    onInput,
  );

const makeOperationAdvancedSelect = <T extends string>(
  doc: Document,
  entry: OperationFamilyRowDraft,
  field: string,
  value: T,
  options: readonly T[],
  onChange: (next: T) => void,
): HTMLSelectElement =>
  makeSelectWithAttr(
    doc,
    value,
    options,
    INGREDIENT_BUILDER_OPERATION_ADVANCED_FIELD_ATTR,
    `${entry.id}:${field}`,
    onChange,
  );

interface OperationArgumentFocusTargets {
  keyInputs: HTMLInputElement[];
  addButton?: HTMLButtonElement;
}

/** The op's Arguments repeater — one row per `OperationArgEntry` (key + type +
 *  D-177 `affects_target`), plus an "Add argument" button. This is the op's
 *  callable-input declaration: it drives Compose autocomplete and the authority
 *  scoping at the approval gate, so it leads the Advanced panel. */
const renderOperationArgsSubsection = (
  doc: Document,
  state: IngredientBuilderState,
  entry: OperationFamilyRowDraft,
  host: HTMLElement,
  rerender: () => void,
  focusTargets: OperationArgumentFocusTargets,
  rerenderOperationArgument: (rowId: string, argIndex: number | null) => void,
): void => {
  const operationLabel = entry.operation.trim() || 'untitled';
  const section = doc.createElement('div');
  section.className = 'ingredient-builder-advanced-subsection';
  section.setAttribute('role', 'group');
  section.setAttribute('aria-label', `Arguments for operation ${operationLabel}`);
  const label = doc.createElement('div');
  label.className = 'ingredient-builder-subsection-label';
  label.textContent = 'Arguments';
  section.appendChild(label);

  const list = doc.createElement('div');
  list.className = 'ingredient-builder-arg-list';
  if (entry.args.length === 0) {
    const empty = doc.createElement('div');
    empty.className = 'ingredient-builder-arg-empty';
    empty.textContent = 'Nothing can be passed in yet. Add an argument.';
    list.appendChild(empty);
  }

  entry.args.forEach((arg, argIdx) => {
    const argRow = doc.createElement('div');
    argRow.className = 'ingredient-builder-arg-row';

    const keyInput = makeTextInputWithAttr(
      doc,
      arg.key,
      INGREDIENT_BUILDER_OPERATION_ARG_FIELD_ATTR,
      `${entry.id}:${argIdx}:key`,
      (next) => {
        arg.key = next;
        markDirty(state);
      },
    );
    keyInput.setAttribute(
      'aria-label',
      `Argument ${argIdx + 1} key for operation ${operationLabel}`,
    );
    keyInput.setAttribute('placeholder', 'arg_key');
    focusTargets.keyInputs.push(keyInput);
    argRow.appendChild(keyInput);

    const typeSelect = makeSelectWithAttr(
      doc,
      arg.type,
      OPERATION_ARG_TYPES,
      INGREDIENT_BUILDER_OPERATION_ARG_FIELD_ATTR,
      `${entry.id}:${argIdx}:type`,
      (next) => {
        arg.type = next;
        markDirty(state);
      },
    );
    typeSelect.setAttribute(
      'aria-label',
      `Argument ${argIdx + 1} type for operation ${operationLabel}`,
    );
    argRow.appendChild(typeSelect);

    const affectsLabel = doc.createElement('label');
    affectsLabel.className = 'ingredient-builder-arg-affects';
    const affectsBox = doc.createElement('input');
    affectsBox.type = 'checkbox';
    affectsBox.checked = arg.affectsTarget;
    affectsBox.setAttribute(
      INGREDIENT_BUILDER_OPERATION_ARG_FIELD_ATTR,
      `${entry.id}:${argIdx}:affects_target`,
    );
    affectsBox.setAttribute(
      INGREDIENT_BUILDER_FOCUS_FIELD_ATTR,
      ingredientBuilderFocusFieldKey(
        INGREDIENT_BUILDER_OPERATION_ARG_FIELD_ATTR,
        `${entry.id}:${argIdx}:affects_target`,
      ),
    );
    affectsBox.setAttribute(
      'aria-label',
      `Argument ${argIdx + 1} affects target for operation ${operationLabel}`,
    );
    affectsBox.addEventListener('change', () => {
      arg.affectsTarget = affectsBox.checked;
      markDirty(state);
    });
    affectsLabel.appendChild(affectsBox);
    appendText(doc, affectsLabel, 'span', 'affects target');
    argRow.appendChild(affectsLabel);

    const remove = makeButton(doc, 'Remove', 'danger-text', 'xs', () => {
      entry.args.splice(argIdx, 1);
      markDirty(state);
      state.opAdvancedOpen.set(entry.id, true);
      const nextIndex = entry.args.length === 0
        ? null
        : Math.min(argIdx, entry.args.length - 1);
      rerenderOperationArgument(entry.id, nextIndex);
    });
    remove.setAttribute(
      INGREDIENT_BUILDER_OPERATION_ARG_REMOVE_ATTR,
      `${entry.id}:${argIdx}`,
    );
    remove.setAttribute(
      'aria-label',
      `Remove argument ${arg.key.trim() || String(argIdx + 1)} from operation ${operationLabel}`,
    );
    argRow.appendChild(remove);

    list.appendChild(argRow);
  });
  section.appendChild(list);

  const add = makeButton(doc, 'Add argument', 'secondary', 'xs', () => {
    const nextIndex = entry.args.length;
    entry.args.push({ key: '', type: 'string', affectsTarget: false });
    markDirty(state);
    state.opAdvancedOpen.set(entry.id, true);
    rerenderOperationArgument(entry.id, nextIndex);
  });
  add.setAttribute(INGREDIENT_BUILDER_OPERATION_ARG_ADD_ATTR, entry.id);
  add.setAttribute('aria-label', `Add argument to operation ${operationLabel}`);
  focusTargets.addButton = add;
  section.appendChild(add);

  host.appendChild(section);
};

const renderOperationAdvancedFields = (
  doc: Document,
  state: IngredientBuilderState,
  entry: OperationFamilyRowDraft,
  host: HTMLElement,
  rerender: () => void,
  argumentFocusTargets: OperationArgumentFocusTargets,
  rerenderOperationArgument: (rowId: string, argIndex: number | null) => void,
): void => {
  renderOperationArgsSubsection(
    doc,
    state,
    entry,
    host,
    rerender,
    argumentFocusTargets,
    rerenderOperationArgument,
  );
  // D-170 — per-kind binding fields. The card body already renders the kind's
  // PRIMARY field; the remaining typed binding fields live in a "Binding"
  // sub-section, gated by kind. Fallback kinds (webhook/queue/push) carry no
  // extra binding fields (the raw-JSON primary cell holds the whole binding).
  let grid = TYPED_BINDING_KINDS.has(entry.bindingKind)
    ? addAdvancedSubsection(doc, host, 'Binding')
    : doc.createElement('div');
  if (entry.bindingKind === 'rest') {
    addAdvancedField(doc, grid, 'REST method', makeOperationAdvancedSelect(
      doc,
      entry,
      'rest_method',
      entry.restMethod,
      REST_METHODS,
      (next) => {
        entry.restMethod = next;
        markDirty(state);
      },
    ));
    addAdvancedField(doc, grid, 'Static query JSON', makeOperationAdvancedInput(doc, entry, 'rest_static_query', entry.restStaticQueryText, (next) => {
      entry.restStaticQueryText = next;
      markDirty(state);
    }));
    addAdvancedField(doc, grid, 'Merge query JSON', makeOperationAdvancedInput(doc, entry, 'rest_merge_query', entry.restMergeQueryText, (next) => {
      entry.restMergeQueryText = next;
      markDirty(state);
    }));
    addAdvancedField(doc, grid, 'Static headers JSON', makeOperationAdvancedInput(doc, entry, 'rest_static_headers', entry.restStaticHeadersText, (next) => {
      entry.restStaticHeadersText = next;
      markDirty(state);
    }));
    addAdvancedField(doc, grid, 'Response capture JSON', makeOperationAdvancedInput(doc, entry, 'rest_response_capture', entry.restResponseCaptureText, (next) => {
      entry.restResponseCaptureText = next;
      markDirty(state);
    }));
  } else if (entry.bindingKind === 'graphql') {
    addAdvancedField(doc, grid, 'GraphQL operation type', makeOperationAdvancedSelect(
      doc,
      entry,
      'graphql_operation_type',
      entry.graphqlOperationType,
      GRAPHQL_OPERATION_TYPES,
      (next) => {
        entry.graphqlOperationType = next;
        markDirty(state);
      },
    ));
    addAdvancedField(doc, grid, 'GraphQL endpoint path', makeOperationAdvancedInput(doc, entry, 'graphql_endpoint_path', entry.graphqlEndpointPath, (next) => {
      entry.graphqlEndpointPath = next;
      markDirty(state);
    }));
    addAdvancedField(doc, grid, 'Variables schema JSON', makeOperationAdvancedInput(doc, entry, 'graphql_variables_schema', entry.graphqlVariablesSchemaText, (next) => {
      entry.graphqlVariablesSchemaText = next;
      markDirty(state);
    }));
    addAdvancedField(doc, grid, 'Result schema JSON', makeOperationAdvancedInput(doc, entry, 'graphql_result_schema', entry.graphqlResultSchemaText, (next) => {
      entry.graphqlResultSchemaText = next;
      markDirty(state);
    }));
  } else if (entry.bindingKind === 'cli_invocation') {
    addAdvancedField(doc, grid, 'Stdin handling', makeOperationAdvancedSelect(
      doc,
      entry,
      'cli_stdin',
      entry.cliStdin,
      CLI_STDIN_OPTIONS,
      (next) => {
        entry.cliStdin = next;
        markDirty(state);
      },
    ));
    addAdvancedField(doc, grid, 'Output shape', makeOperationAdvancedSelect(
      doc,
      entry,
      'cli_shape',
      entry.cliShape,
      CLI_SHAPE_OPTIONS,
      (next) => {
        entry.cliShape = next;
        markDirty(state);
      },
    ));
    addAdvancedField(doc, grid, 'Storage', makeOperationAdvancedSelect(
      doc,
      entry,
      'cli_storage',
      entry.cliStorage,
      CLI_STORAGE_OPTIONS,
      (next) => {
        entry.cliStorage = next;
        markDirty(state);
      },
    ));
    addAdvancedField(doc, grid, 'Exit code handling', makeOperationAdvancedInput(doc, entry, 'cli_exit_code', entry.cliExitCodeText, (next) => {
      entry.cliExitCodeText = next;
      markDirty(state);
    }));
    addAdvancedField(doc, grid, 'Detached JSON', makeOperationAdvancedTextarea(doc, entry, 'cli_detached', entry.cliDetachedText, (next) => {
      entry.cliDetachedText = next;
      markDirty(state);
    }), true);
    addAdvancedField(doc, grid, 'Output capture JSON', makeOperationAdvancedInput(doc, entry, 'cli_output_capture', entry.cliOutputCaptureText, (next) => {
      entry.cliOutputCaptureText = next;
      markDirty(state);
    }));
    addAdvancedField(doc, grid, 'Input materialize JSON', makeOperationAdvancedInput(doc, entry, 'cli_input_materialize', entry.cliInputMaterializeText, (next) => {
      entry.cliInputMaterializeText = next;
      markDirty(state);
    }));
    addAdvancedField(doc, grid, 'Progress JSON', makeOperationAdvancedTextarea(doc, entry, 'cli_progress', entry.cliProgressText, (next) => {
      entry.cliProgressText = next;
      markDirty(state);
    }), true);
  } else if (entry.bindingKind === 'method_call') {
    addAdvancedField(doc, grid, 'Args mapping JSON', makeOperationAdvancedTextarea(doc, entry, 'method_call_args_mapping', entry.methodCallArgsMappingText, (next) => {
      entry.methodCallArgsMappingText = next;
      markDirty(state);
    }), true);
  }

  grid = addAdvancedSubsection(doc, host, 'Execution');
  addAdvancedField(doc, grid, 'Description', makeOperationAdvancedInput(doc, entry, 'description', entry.description, (next) => {
    entry.description = next;
    markDirty(state);
  }), true);
  addAdvancedField(doc, grid, 'Required scopes JSON', makeOperationAdvancedInput(doc, entry, 'required_scopes', entry.requiredScopesText, (next) => {
    entry.requiredScopesText = next;
    markDirty(state);
  }));
  addAdvancedField(doc, grid, 'Editable args JSON', makeOperationAdvancedTextarea(doc, entry, 'editable_args', entry.editableArgsText, (next) => {
    entry.editableArgsText = next;
    markDirty(state);
  }), true);
  addAdvancedField(doc, grid, 'Timeout ms', makeOperationAdvancedInput(doc, entry, 'timeout_ms', entry.timeoutMsText, (next) => {
    entry.timeoutMsText = next;
    markDirty(state);
  }));
  addAdvancedField(doc, grid, 'Cache ttl ms', makeOperationAdvancedInput(doc, entry, 'cache_ttl_ms', entry.cacheTtlMsText, (next) => {
    entry.cacheTtlMsText = next;
    markDirty(state);
  }));
  addAdvancedField(doc, grid, 'Result path', makeOperationAdvancedInput(doc, entry, 'result_path', entry.resultPath, (next) => {
    entry.resultPath = next;
    markDirty(state);
  }));
  addAdvancedField(doc, grid, 'Extra operation JSON', makeOperationAdvancedTextarea(doc, entry, 'extra_json', entry.extraJsonText, (next) => {
    entry.extraJsonText = next;
    markDirty(state);
  }), true);

  grid = addAdvancedSubsection(doc, host, 'Pagination');
  addAdvancedField(doc, grid, 'Pagination style', makeOperationAdvancedSelect(
    doc,
    entry,
    'pagination_style',
    entry.paginationStyle,
    PAGINATION_STYLE_OPTIONS,
    (next) => {
      entry.paginationStyle = next;
      markDirty(state);
      rerender();
    },
  ));
  addAdvancedField(doc, grid, 'Page size placement', makeOperationAdvancedSelect(
    doc,
    entry,
    'pagination_page_size_placement',
    entry.paginationPageSizePlacement,
    OPERATION_PAGINATION_PLACEMENTS,
    (next) => {
      entry.paginationPageSizePlacement = next;
      markDirty(state);
    },
  ));
  addAdvancedField(doc, grid, 'Page size param', makeOperationAdvancedInput(doc, entry, 'pagination_page_size_param', entry.paginationPageSizeParam, (next) => {
    entry.paginationPageSizeParam = next;
    markDirty(state);
  }));
  addAdvancedField(doc, grid, 'Page size value', makeOperationAdvancedInput(doc, entry, 'pagination_page_size_value', entry.paginationPageSizeValue, (next) => {
    entry.paginationPageSizeValue = next;
    markDirty(state);
  }));
  addAdvancedField(doc, grid, 'Page size max', makeOperationAdvancedInput(doc, entry, 'pagination_page_size_max', entry.paginationPageSizeMax, (next) => {
    entry.paginationPageSizeMax = next;
    markDirty(state);
  }));
  addAdvancedField(doc, grid, 'Pagination details JSON', makeOperationAdvancedTextarea(doc, entry, 'pagination_details', entry.paginationDetailsText, (next) => {
    entry.paginationDetailsText = next;
    markDirty(state);
  }), true);
};

/** D-170 — a short 3–4 char tag for a binding kind, shown in the card-summary
 *  glyph pill. Maps the typed + realtime kinds onto a compact label. */
const KIND_PILL_LABEL: Record<BindingKindDraft, string> = {
  rest: 'REST',
  graphql: 'GQL',
  mcp: 'MCP',
  'core.records': 'REC',
  cli_invocation: 'CLI',
  method_call: 'MTHD',
  webhook_subscription: 'HOOK',
  queue_subscription: 'QUE',
  push_channel: 'PUSH',
};

/** Per-kind primary binding fields that need a multi-line / full-width control
 *  (the GraphQL query body, the CLI argv array, the raw-JSON fallback). */
const WIDE_PRIMARY_FIELDS: ReadonlySet<string> = new Set([
  'graphqlQueryText',
  'cliArgvText',
  'bindingRawJsonText',
]);

/** D-170 — the single PRIMARY binding field, switched by kind: the data-field
 *  name + current value + setter for the kind's headline field. The remaining
 *  per-kind fields live in the advanced details. */
const primaryBindingField = (
  entry: OperationFamilyRowDraft,
): { field: string; value: string; set: (next: string) => void } => {
  // Non-typed kinds (webhook/queue/push) author their whole binding via the
  // raw-JSON fallback field.
  if (!TYPED_BINDING_KINDS.has(entry.bindingKind)) {
    return {
      field: 'bindingRawJsonText',
      value: entry.bindingRawJsonText,
      set: (next) => { entry.bindingRawJsonText = next; },
    };
  }
  switch (entry.bindingKind) {
    case 'graphql':
      return {
        field: 'graphqlQueryText',
        value: entry.graphqlQueryText,
        set: (next) => { entry.graphqlQueryText = next; },
      };
    case 'cli_invocation':
      return {
        field: 'cliArgvText',
        value: entry.cliArgvText,
        set: (next) => { entry.cliArgvText = next; },
      };
    case 'method_call':
      return {
        field: 'methodCallName',
        value: entry.methodCallName,
        set: (next) => { entry.methodCallName = next; },
      };
    case 'rest':
      return {
        field: 'restPathTemplate',
        value: entry.restPathTemplate,
        set: (next) => { entry.restPathTemplate = next; },
      };
    default:
      return {
        field: 'bindingRawJsonText',
        value: entry.bindingRawJsonText,
        set: (next) => { entry.bindingRawJsonText = next; },
      };
  }
};

/** A labeled field cell for the operation card body: a `<label>` over the
 *  given control. `wide` spans the whole responsive grid. */
const addCardField = (
  doc: Document,
  grid: HTMLElement,
  labelText: string,
  child: HTMLElement,
  wide = false,
): void => {
  const field = doc.createElement('div');
  field.className = wide
    ? 'ingredient-builder-field span-full'
    : 'ingredient-builder-field';
  const label = doc.createElement('label');
  label.textContent = labelText;
  if (child.getAttribute('aria-label') === null) {
    child.setAttribute('aria-label', labelText);
  }
  field.appendChild(label);
  field.appendChild(child);
  grid.appendChild(field);
};

const addPill = (
  doc: Document,
  parent: HTMLElement,
  text: string,
  elevated = false,
): void => {
  const pill = doc.createElement('span');
  pill.className = elevated
    ? 'ingredient-builder-pill is-elevated'
    : 'ingredient-builder-pill';
  pill.textContent = text;
  parent.appendChild(pill);
};

/** Build one operation card (`<details>` keyed on the row id). The summary is
 *  the at-a-glance header (kind pill, name, verb, risk/approval pills, Remove);
 *  the body is the labeled field grid + the nested Advanced details. */
const renderOperationCard = (
  doc: Document,
  state: IngredientBuilderState,
  entry: OperationFamilyRowDraft,
  rerender: () => void,
  focusTargets: Map<string, {
    card: HTMLElement;
    summary: HTMLElement;
    firstField: HTMLInputElement;
    bindingKind: HTMLSelectElement;
    reviewed: HTMLInputElement;
    arguments: OperationArgumentFocusTargets;
  }>,
  removeOperation: (entry: OperationFamilyRowDraft) => void,
  rerenderOperationField: (
    rowId: string,
    field: 'bindingKind' | 'reviewed' | 'summary',
  ) => void,
  rerenderOperationArgument: (rowId: string, argIndex: number | null) => void,
): HTMLElement => {
  const idx = state.rows.indexOf(entry);
  const operationName = entry.operation.trim();
  const operationLabel = operationName || 'untitled';
  const card = doc.createElement('details');
  card.className = 'ingredient-builder-op-card';
  card.setAttribute(INGREDIENT_BUILDER_ROW_ATTR, entry.id);
  card.setAttribute('aria-label', `Operation ${operationLabel}`);
  // Open by default for unreviewed / fresh rows so authoring starts expanded;
  // reviewed rows collapse to the summary glance. A user toggle overrides the
  // default and SURVIVES rerenders (state.opCardOpen) — without it every
  // structural rerender (add/remove/save/section swap) snapped cards back.
  if (state.opCardOpen.get(entry.id) ?? !entry.reviewed) {
    card.setAttribute('open', '');
  }
  card.addEventListener('toggle', () => {
    const el = card as unknown as { open?: boolean; isConnected?: boolean };
    // Toggle tasks fire ASYNC — one queued by a card this rerender already
    // replaced (or by the open-attribute set at creation) must not be recorded
    // as a user action: a stale row-id echo would poison the override map
    // across a draft switch (row ids are re-minted). Drop events from
    // disconnected cards and events that merely restate the rendered default.
    if (el.isConnected === false) return;
    const isOpen = el.open === true;
    if (isOpen === (state.opCardOpen.get(entry.id) ?? !entry.reviewed)) return;
    state.opCardOpen.set(entry.id, isOpen);
  });

  const summary = doc.createElement('summary');
  summary.className = 'ingredient-builder-op-card-summary';
  // Capture the disclosure intent synchronously. The native `toggle` event is
  // queued after the click; an in-flight review can repaint and detach this
  // card before that event runs, which otherwise loses the user's open/close
  // action. Nested controls in the summary own their own clicks and must not
  // change disclosure state.
  summary.addEventListener('click', (event?: MouseEvent) => {
    const target = event?.target as Element | null | undefined;
    if (
      target !== undefined
      && target !== null
      && target !== summary
      && target.closest?.('button, input, select, textarea, a') !== null
    ) {
      return;
    }
    state.opCardOpen.set(entry.id, !card.hasAttribute('open'));
  });

  const kindPill = doc.createElement('span');
  kindPill.className = 'ingredient-builder-kind-pill';
  kindPill.textContent = KIND_PILL_LABEL[entry.bindingKind];
  summary.appendChild(kindPill);

  const title = doc.createElement('span');
  title.className = operationName.length > 0
    ? 'ingredient-builder-op-card-title'
    : 'ingredient-builder-op-card-title is-untitled';
  title.textContent = operationName.length > 0 ? operationName : 'untitled';
  summary.appendChild(title);

  const verbText = entry.verb.trim();
  if (verbText.length > 0) {
    const verb = doc.createElement('span');
    verb.className = 'ingredient-builder-op-card-verb';
    verb.textContent = verbText;
    summary.appendChild(verb);
  }

  addPill(doc, summary, entry.risk_tier);
  addPill(doc, summary, `approval: ${entry.approval}`);

  const remove = makeButton(
    doc,
    'Remove',
    'danger-text',
    'xs',
    () => removeOperation(entry),
  );
  remove.disabled = state.rows.length <= 1;
  remove.setAttribute(INGREDIENT_BUILDER_REMOVE_ROW_ATTR, entry.id);
  remove.setAttribute('aria-label', `Remove operation ${operationLabel}`);
  summary.appendChild(remove);

  card.appendChild(summary);

  const body = doc.createElement('div');
  body.className = 'ingredient-builder-op-card-body';

  const grid = doc.createElement('div');
  grid.className = 'ingredient-builder-field-grid';

  const familyInput = makeTextInput(doc, entry.family, 'family', (next) => {
    entry.family = next;
    markDirty(state);
  });
  addCardField(doc, grid, 'Family', familyInput);
  addCardField(doc, grid, 'Operation', makeTextInput(doc, entry.operation, 'operation', (next) => {
    entry.operation = next;
    markDirty(state);
  }));
  addCardField(doc, grid, 'Verb', makeTextInput(doc, entry.verb, 'verb', (next) => {
    entry.verb = next;
    markDirty(state);
  }));
  const bindingKindSelect = makeSelect(
    doc,
    entry.bindingKind,
    BINDING_KINDS,
    'bindingKind',
    (next) => {
      entry.bindingKind = next;
      markDirty(state);
      rerenderOperationField(entry.id, 'bindingKind');
    },
  );
  addCardField(doc, grid, 'Kind', bindingKindSelect);

  const primary = primaryBindingField(entry);
  const primaryControl = WIDE_PRIMARY_FIELDS.has(primary.field)
    ? makeTextareaWithAttr(doc, primary.value, INGREDIENT_BUILDER_FIELD_ATTR, primary.field, (next) => {
        primary.set(next);
        markDirty(state);
      })
    : makeTextInput(doc, primary.value, primary.field, (next) => {
        primary.set(next);
        markDirty(state);
      });
  addCardField(doc, grid, 'Binding', primaryControl, WIDE_PRIMARY_FIELDS.has(primary.field));

  addCardField(doc, grid, 'Risk', makeSelect(doc, entry.risk_tier, RISK_TIERS, 'risk', (next) => {
    entry.risk_tier = next;
    markDirty(state);
  }));
  addCardField(doc, grid, 'Approval', makeSelect(doc, entry.approval, APPROVALS, 'approval', (next) => {
    entry.approval = next;
    markDirty(state);
  }));

  const reviewField = doc.createElement('div');
  reviewField.className = 'ingredient-builder-field';
  const reviewLabel = doc.createElement('label');
  reviewLabel.className = 'ingredient-builder-field-checkbox';
  const checkbox = doc.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = entry.reviewed;
  checkbox.setAttribute(INGREDIENT_BUILDER_FIELD_ATTR, 'reviewed');
  checkbox.setAttribute(
    INGREDIENT_BUILDER_FOCUS_FIELD_ATTR,
    ingredientBuilderFocusFieldKey(INGREDIENT_BUILDER_FIELD_ATTR, 'reviewed'),
  );
  checkbox.setAttribute('aria-label', `Reviewed for operation ${operationLabel}`);
  checkbox.addEventListener('change', () => {
    entry.reviewed = checkbox.checked;
    markDirty(state);
    const remainsOpen = state.opCardOpen.get(entry.id) ?? !entry.reviewed;
    rerenderOperationField(entry.id, remainsOpen ? 'reviewed' : 'summary');
  });
  reviewLabel.appendChild(checkbox);
  appendText(doc, reviewLabel, 'span', 'Reviewed');
  reviewField.appendChild(reviewLabel);
  grid.appendChild(reviewField);

  body.appendChild(grid);

  const advanced = doc.createElement('details');
  advanced.className = 'ingredient-builder-panel';
  advanced.setAttribute(
    'aria-label',
    `Advanced options for operation ${operationLabel}`,
  );
  if (state.opAdvancedOpen.get(entry.id) ?? false) {
    advanced.setAttribute('open', '');
  }
  advanced.addEventListener('toggle', () => {
    const el = advanced as unknown as { open?: boolean; isConnected?: boolean };
    if (el.isConnected === false) return;
    const isOpen = el.open === true;
    if (isOpen === (state.opAdvancedOpen.get(entry.id) ?? false)) return;
    state.opAdvancedOpen.set(entry.id, isOpen);
  });
  appendPanelSummary(doc, advanced, 'Advanced', 'options');
  const advancedBody = doc.createElement('div');
  advancedBody.className = 'ingredient-builder-panel-body';
  const argumentFocusTargets: OperationArgumentFocusTargets = { keyInputs: [] };
  renderOperationAdvancedFields(
    doc,
    state,
    entry,
    advancedBody,
    rerender,
    argumentFocusTargets,
    rerenderOperationArgument,
  );
  advanced.appendChild(advancedBody);
  body.appendChild(advanced);

  card.appendChild(body);
  focusTargets.set(entry.id, {
    card,
    summary,
    firstField: familyInput,
    bindingKind: bindingKindSelect,
    reviewed: checkbox,
    arguments: argumentFocusTargets,
  });
  return card;
};

const renderTable = (
  doc: Document,
  state: IngredientBuilderState,
  host: HTMLElement,
  rerender: () => void,
  focusTargets: Map<string, {
    card: HTMLElement;
    summary: HTMLElement;
    firstField: HTMLInputElement;
    bindingKind: HTMLSelectElement;
    reviewed: HTMLInputElement;
    arguments: OperationArgumentFocusTargets;
  }>,
  removeOperation: (entry: OperationFamilyRowDraft) => void,
  rerenderOperationField: (
    rowId: string,
    field: 'bindingKind' | 'reviewed' | 'summary',
  ) => void,
  rerenderOperationArgument: (rowId: string, argIndex: number | null) => void,
): void => {
  // The `TABLE_ATTR` marker now rides the operations cards CONTAINER (no
  // `<table>`); descendant `ROW_ATTR` cards still count as operation rows.
  const container = doc.createElement('div');
  container.setAttribute(INGREDIENT_BUILDER_TABLE_ATTR, '');

  // Friendly onboarding state: a single blank default row → a prompt instead of
  // a bare empty card. (The card itself still renders so authoring can begin.)
  const onlyBlankDefault = state.rows.length === 1
    && state.rows[0]!.operation.trim().length === 0
    && state.rows[0]!.family.trim().length === 0;
  if (onlyBlankDefault) {
    const empty = doc.createElement('div');
    empty.className = 'ingredient-builder-op-empty';
    appendText(doc, empty, 'strong', 'Write your first operation');
    appendText(
      doc,
      empty,
      'span',
      'Give an operation a name, choose how it connects, then add more.',
    );
    container.appendChild(empty);
  }

  // Group rows by family (preserving row order; stable group order by first
  // appearance). A blank family folds into an "Ungrouped" group.
  const groups: Array<{ name: string; rows: OperationFamilyRowDraft[] }> = [];
  const byName = new Map<string, { name: string; rows: OperationFamilyRowDraft[] }>();
  for (const entry of state.rows) {
    const trimmed = entry.family.trim();
    const key = trimmed.length > 0 ? trimmed : '';
    let group = byName.get(key);
    if (group === undefined) {
      group = { name: trimmed.length > 0 ? trimmed : 'Ungrouped', rows: [] };
      byName.set(key, group);
      groups.push(group);
    }
    group.rows.push(entry);
  }

  for (const group of groups) {
    const groupEl = doc.createElement('div');
    groupEl.className = 'ingredient-builder-op-group';

    const groupHeader = doc.createElement('div');
    groupHeader.className = 'ingredient-builder-op-group-header';
    const groupName = doc.createElement('span');
    groupName.className = 'ingredient-builder-op-group-name';
    groupName.textContent = group.name;
    groupHeader.appendChild(groupName);
    const count = appendText(doc, groupHeader, 'span', plural(group.rows.length, 'operation'));
    count.className = 'ingredient-builder-section-meta';
    // A lone blank starter card is already introduced by the onboarding copy;
    // an "Ungrouped · 1 operation" header above it contradicts that state.
    if (!onlyBlankDefault) groupEl.appendChild(groupHeader);

    for (const entry of group.rows) {
      groupEl.appendChild(renderOperationCard(
        doc,
        state,
        entry,
        rerender,
        focusTargets,
        removeOperation,
        rerenderOperationField,
        rerenderOperationArgument,
      ));
    }
    container.appendChild(groupEl);
  }

  host.appendChild(container);
};

const addCheckboxCell = (
  doc: Document,
  row: HTMLTableRowElement,
  checked: boolean,
  attrName: string,
  attrValue: string,
  onChange: (next: boolean) => void,
): HTMLInputElement => {
  const cell = doc.createElement('td');
  cell.className = 'review-cell';
  const checkbox = doc.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = checked;
  checkbox.setAttribute(attrName, attrValue);
  checkbox.setAttribute(
    INGREDIENT_BUILDER_FOCUS_FIELD_ATTR,
    ingredientBuilderFocusFieldKey(attrName, attrValue),
  );
  checkbox.addEventListener('change', () => onChange(checkbox.checked));
  const target = doc.createElement('label');
  target.className = 'ingredient-builder-review-check';
  target.appendChild(checkbox);
  cell.appendChild(target);
  row.appendChild(cell);
  return checkbox;
};

/** D-182 Tier-2 — the per-field "Advanced" extras: a second full-width row under
 *  the field's main row holding a collapsed `<details>` with the optional
 *  `IngredientEntityField` extras (description/label/reference, the sourcing
 *  op, datetime granularity, and the `closed_state` derivation). Kept out of the main 10-column
 *  row so the table stays legible; every control still renders into the DOM. */
const appendEntityExtrasRow = (
  doc: Document,
  tbody: HTMLElement,
  state: IngredientBuilderState,
  entry: EntityFieldRowDraft,
): void => {
  const fieldNumber = state.entityFields.indexOf(entry) + 1;
  const tr = doc.createElement('tr');
  tr.className = 'ingredient-builder-entity-extras-tr';
  const cell = doc.createElement('td');
  cell.setAttribute('colspan', '10');
  cell.className = 'ingredient-builder-entity-extras-cell';

  const details = doc.createElement('details');
  details.className = 'ingredient-builder-panel';
  details.setAttribute('aria-label', `Advanced options for data field ${fieldNumber}`);
  appendPanelSummary(doc, details, 'Advanced', 'label · reference · source op · derivation');
  const body = doc.createElement('div');
  body.className = 'ingredient-builder-panel-body';
  const grid = doc.createElement('div');
  grid.className = 'ingredient-builder-field-grid';

  addAdvancedField(doc, grid, 'Description', makeEntityTextInput(doc, entry.description, 'description', (next) => {
    entry.description = next;
    markDirty(state);
  }), true);
  addAdvancedField(doc, grid, 'Label', makeEntityTextInput(doc, entry.label, 'label', (next) => {
    entry.label = next;
    markDirty(state);
  }));
  addAdvancedField(doc, grid, 'References entity', makeEntityTextInput(doc, entry.references, 'references', (next) => {
    entry.references = next;
    markDirty(state);
  }));
  addAdvancedField(doc, grid, 'Source operation', makeEntityTextInput(doc, entry.sourceOperation, 'source_operation', (next) => {
    entry.sourceOperation = next;
    markDirty(state);
  }));
  addAdvancedField(doc, grid, 'Date granularity', makeEntitySelect(
    doc,
    entry.dateGranularity,
    ['', ...DATE_GRANULARITIES],
    'date_granularity',
    (next) => {
      entry.dateGranularity = next;
      markDirty(state);
    },
  ));
  addAdvancedField(doc, grid, 'Derivation kind', makeEntitySelect(
    doc,
    entry.derivationKind,
    ['', 'closed_state'],
    'derivation_kind',
    (next) => {
      entry.derivationKind = next;
      markDirty(state);
    },
  ));
  addAdvancedField(doc, grid, 'Derivation closed path', makeEntityTextInput(doc, entry.derivationClosedPath, 'derivation_closed_path', (next) => {
    entry.derivationClosedPath = next;
    markDirty(state);
  }));
  addAdvancedField(doc, grid, 'Derivation won path', makeEntityTextInput(doc, entry.derivationWonPath, 'derivation_won_path', (next) => {
    entry.derivationWonPath = next;
    markDirty(state);
  }));

  body.appendChild(grid);
  details.appendChild(body);
  cell.appendChild(details);
  tr.appendChild(cell);
  tbody.appendChild(tr);
};

/** Column widths + headers for an entity-group field table — shared so every
 *  per-entity group renders an aligned table. */
const ENTITY_FIELD_COL_WIDTHS = [
  '11%', '18%', '10%', '14%', '6%', '10%', '12%', '11%', '5%', '5%',
] as const;
const ENTITY_FIELD_HEADERS = [
  'Entity', 'Field path', 'Type', 'Maps to', 'Opt', 'Applies', 'PII tag',
  'Source', 'Reviewed', '',
] as const;

/** One field row (the main `<tr>` + its per-field Advanced extras row).
 *  Removal is identity-based (`indexOf`) so it stays correct regardless of
 *  which entity group the row renders under. */
const appendEntityFieldRow = (
  doc: Document,
  state: IngredientBuilderState,
  entry: EntityFieldRowDraft,
  tbody: HTMLElement,
  rerender: () => void,
  focusTargets: Map<string, {
    row: HTMLElement;
    firstField: HTMLInputElement;
    optional: HTMLInputElement;
    reviewed: HTMLInputElement;
  }>,
  removeEntityField: (entry: EntityFieldRowDraft) => void,
  rerenderEntityField: (
    fieldId: string,
    field: 'optional' | 'reviewed',
  ) => void,
): void => {
  const fieldNumber = state.entityFields.indexOf(entry) + 1;
  const tr = doc.createElement('tr');
  tr.setAttribute(INGREDIENT_BUILDER_ENTITY_ROW_ATTR, entry.id);
  tr.setAttribute('aria-label', `Data field ${fieldNumber}`);

  const entityInput = makeEntityTextInput(doc, entry.entity, 'entity', (next) => {
    entry.entity = next;
    markDirty(state);
  });
  entityInput.setAttribute('aria-label', `Entity for data field ${fieldNumber}`);
  addCell(doc, tr, entityInput);
  const fieldPathInput = makeEntityTextInput(doc, entry.field_path, 'field_path', (next) => {
    entry.field_path = next;
    markDirty(state);
  });
  fieldPathInput.setAttribute('aria-label', `Field path for data field ${fieldNumber}`);
  addCell(doc, tr, fieldPathInput);
  const typeSelect = makeEntitySelect(doc, entry.type, META_FIELD_TYPES, 'type', (next) => {
    entry.type = next;
    markDirty(state);
  });
  typeSelect.setAttribute('aria-label', `Type for data field ${fieldNumber}`);
  addCell(doc, tr, typeSelect);
  const mapsToInput = makeEntityTextInput(doc, entry.maps_to, 'maps_to', (next) => {
    entry.maps_to = next;
    markDirty(state);
  });
  mapsToInput.setAttribute('aria-label', `Maps to for data field ${fieldNumber}`);
  addCell(doc, tr, mapsToInput);
  const optionalCheckbox = addCheckboxCell(
    doc,
    tr,
    entry.optional,
    INGREDIENT_BUILDER_ENTITY_FIELD_ATTR,
    'optional',
    (next) => {
      entry.optional = next;
      markDirty(state);
      rerenderEntityField(entry.id, 'optional');
    },
  );
  optionalCheckbox.setAttribute('aria-label', `Optional for data field ${fieldNumber}`);
  const appliesSelect = makeEntitySelect(doc, entry.applies, ENTITY_FIELD_APPLIES, 'applies', (next) => {
    entry.applies = next;
    markDirty(state);
  });
  appliesSelect.setAttribute('aria-label', `Applies for data field ${fieldNumber}`);
  addCell(doc, tr, appliesSelect);
  const piiSelect = makeEntitySelect(doc, entry.pii, ENTITY_FIELD_PRIVACY_OPTIONS, 'pii', (next) => {
    entry.pii = next;
    markDirty(state);
  });
  piiSelect.setAttribute('aria-label', `PII tag for data field ${fieldNumber}`);
  addCell(doc, tr, piiSelect);
  const sourceInput = makeEntityTextInput(doc, entry.source, 'source', (next) => {
    entry.source = next;
    markDirty(state);
  });
  sourceInput.setAttribute('aria-label', `Source for data field ${fieldNumber}`);
  addCell(doc, tr, sourceInput);
  const reviewedCheckbox = addCheckboxCell(
    doc,
    tr,
    entry.reviewed,
    INGREDIENT_BUILDER_ENTITY_FIELD_ATTR,
    'reviewed',
    (next) => {
      entry.reviewed = next;
      markDirty(state);
      rerenderEntityField(entry.id, 'reviewed');
    },
  );
  reviewedCheckbox.setAttribute('aria-label', `Reviewed for data field ${fieldNumber}`);

  const removeCell = doc.createElement('td');
  const remove = makeButton(
    doc,
    'Remove',
    'danger-text',
    'xs',
    () => removeEntityField(entry),
  );
  remove.setAttribute(INGREDIENT_BUILDER_ENTITY_REMOVE_ROW_ATTR, entry.id);
  remove.setAttribute('aria-label', `Remove data field ${fieldNumber}`);
  removeCell.appendChild(remove);
  tr.appendChild(removeCell);

  tbody.appendChild(tr);
  focusTargets.set(entry.id, {
    row: tr,
    firstField: entityInput,
    optional: optionalCheckbox,
    reviewed: reviewedCheckbox,
  });
  appendEntityExtrasRow(doc, tbody, state, entry);
};

/** The entity-group header's cross-vendor alias control — a single combined
 *  `<select>` (crm_alias XOR acct_alias; '' = none) keyed by the entity name.
 *  The disjoint CRM / accounting value sets let one picker cover both axes. */
const appendEntityAliasControl = (
  doc: Document,
  state: IngredientBuilderState,
  entityKey: string,
  host: HTMLElement,
): void => {
  const field = doc.createElement('label');
  field.className = 'ingredient-builder-entity-alias';
  appendText(doc, field, 'span', 'Cross-vendor alias');
  const select = makeSelectWithAttr<EntityAliasValue>(
    doc,
    entityAliasValue(state.entityAliases[entityKey]),
    ['', ...CRM_ALIAS_VALUES, ...ACCT_ALIAS_VALUES],
    INGREDIENT_BUILDER_ENTITY_ALIAS_ATTR,
    entityKey,
    (next) => {
      setEntityAlias(state, entityKey, next);
      markDirty(state);
    },
  );
  select.setAttribute('aria-label', `Cross-vendor alias for entity ${entityKey}`);
  field.appendChild(select);
  host.appendChild(field);
};

interface EntityFieldGroup {
  key: string;
  name: string;
  rows: EntityFieldRowDraft[];
}

/** One entity group — a header (entity name + field count + the entity-level
 *  cross-vendor alias picker) above a field table holding just that entity's
 *  rows. The blank-entity "Ungrouped" bucket gets no alias picker (an alias on
 *  an unnamed entity is meaningless). */
const renderEntityGroup = (
  doc: Document,
  state: IngredientBuilderState,
  group: EntityFieldGroup,
  rerender: () => void,
  focusTargets: Map<string, {
    row: HTMLElement;
    firstField: HTMLInputElement;
    optional: HTMLInputElement;
    reviewed: HTMLInputElement;
  }>,
  removeEntityField: (entry: EntityFieldRowDraft) => void,
  rerenderEntityField: (
    fieldId: string,
    field: 'optional' | 'reviewed',
  ) => void,
): HTMLElement => {
  const groupEl = doc.createElement('div');
  groupEl.className = 'ingredient-builder-entity-group';
  groupEl.setAttribute('role', 'group');
  groupEl.setAttribute('aria-label', `Entity ${group.name}`);

  const header = doc.createElement('div');
  header.className = 'ingredient-builder-entity-group-header';
  const name = appendText(doc, header, 'span', group.name);
  name.className = 'ingredient-builder-op-group-name';
  const count = appendText(doc, header, 'span', plural(group.rows.length, 'field'));
  count.className = 'ingredient-builder-section-meta';
  if (group.key.length > 0) appendEntityAliasControl(doc, state, group.key, header);
  groupEl.appendChild(header);

  const wrap = doc.createElement('div');
  wrap.className = 'ingredient-builder-table-wrap';
  wrap.setAttribute('data-recued-scroll-rail', '');
  const table = doc.createElement('table');
  table.setAttribute('aria-label', `${group.name} data fields`);
  const colgroup = doc.createElement('colgroup');
  for (const width of ENTITY_FIELD_COL_WIDTHS) {
    const col = doc.createElement('col');
    col.setAttribute('style', `width: ${width}`);
    colgroup.appendChild(col);
  }
  table.appendChild(colgroup);
  const thead = doc.createElement('thead');
  const headerRow = doc.createElement('tr');
  for (const label of ENTITY_FIELD_HEADERS) appendText(doc, headerRow, 'th', label);
  thead.appendChild(headerRow);
  table.appendChild(thead);
  const tbody = doc.createElement('tbody');
  for (const entry of group.rows) {
    appendEntityFieldRow(
      doc,
      state,
      entry,
      tbody,
      rerender,
      focusTargets,
      removeEntityField,
      rerenderEntityField,
    );
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  groupEl.appendChild(wrap);
  return groupEl;
};

const renderEntityFieldTable = (
  doc: Document,
  state: IngredientBuilderState,
  host: HTMLElement,
  rerender: () => void,
  focusTargets: Map<string, {
    row: HTMLElement;
    firstField: HTMLInputElement;
    optional: HTMLInputElement;
    reviewed: HTMLInputElement;
  }>,
  removeEntityField: (entry: EntityFieldRowDraft) => void,
  rerenderEntityField: (
    fieldId: string,
    field: 'optional' | 'reviewed',
  ) => void,
): void => {
  // The `ENTITY_TABLE_ATTR` marker rides the groups CONTAINER (each entity gets
  // its own `<table>` below); descendant `ENTITY_ROW_ATTR` rows still count as
  // field rows. Mirrors the operations cards' container-marker grouping.
  const container = doc.createElement('div');
  container.className = 'ingredient-builder-entity-groups';
  container.setAttribute(INGREDIENT_BUILDER_ENTITY_TABLE_ATTR, '');

  if (state.entityFields.length === 0) {
    const empty = doc.createElement('div');
    empty.className = 'ingredient-builder-empty-state';
    empty.textContent = 'No entity fields';
    container.appendChild(empty);
    host.appendChild(container);
    return;
  }

  // Bucket rows by trimmed entity name (blank → an "Ungrouped" bucket, key '');
  // stable group order by first appearance, like the op-family grouping. An
  // edited entity name regroups on the next rerender (the input marks dirty
  // only, matching the op-family Family field).
  const groups: EntityFieldGroup[] = [];
  const byKey = new Map<string, EntityFieldGroup>();
  for (const entry of state.entityFields) {
    const trimmed = entry.entity.trim();
    let group = byKey.get(trimmed);
    if (group === undefined) {
      group = { key: trimmed, name: trimmed.length > 0 ? trimmed : 'Ungrouped', rows: [] };
      byKey.set(trimmed, group);
      groups.push(group);
    }
    group.rows.push(entry);
  }

  for (const group of groups) {
    container.appendChild(renderEntityGroup(
      doc,
      state,
      group,
      rerender,
      focusTargets,
      removeEntityField,
      rerenderEntityField,
    ));
  }
  host.appendChild(container);
};

const plural = (count: number, singular: string, pluralLabel = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : pluralLabel}`;

const reviewBannerText = (
  review: CompositionReviewView | undefined,
  fallbackIssues: readonly AuthoringValidationIssue[],
): string => {
  if (review === undefined) {
    return fallbackIssues.length > 0
      ? `Check failed: ${plural(fallbackIssues.length, 'issue')}`
      : 'Review pending';
  }
  const counts = review.summary.counts;
  if (!review.valid) {
    return `Check failed: ${plural(review.issues.length, 'issue')}`;
  }
  return [
    'Valid',
    plural(counts.operation_families, 'operation'),
    plural(counts.entity_fields, 'field'),
    plural(counts.pii_fields, 'PII tag'),
    plural(counts.compiled_outputs, 'output'),
  ].join(' | ');
};

const issueText = (issue: AuthoringValidationIssue): string => {
  const path = issue.path.length > 0 ? `${issue.path}: ` : '';
  return `${issue.severity} ${issue.code} ${path}${issue.message}`;
};

const renderEditorOverview = (
  doc: Document,
  state: IngredientBuilderState,
  host: HTMLElement,
): void => {
  const authoredOps = authoredOperationRows(state.rows);
  const reviewedOps = authoredOps.filter((row) => row.reviewed).length;
  const reviewedFields = state.entityFields.filter((field) => field.reviewed).length;
  const piiFields = state.entityFields.filter((field) => field.pii !== '').length;
  const metrics: Array<{ label: string; value: string }> = [
    { label: 'Operations', value: `${reviewedOps}/${authoredOps.length} reviewed` },
    { label: 'Fields', value: `${reviewedFields}/${state.entityFields.length} reviewed` },
    { label: 'PII', value: plural(piiFields, 'tag') },
    {
      label: 'Auth',
      value: state.ingredientKind === 'cli'
        ? 'CLI delegated'
        : state.ingredientKind === 'http' ? 'Connection' : state.ingredientKind,
    },
  ];

  const overview = doc.createElement('dl');
  overview.className = 'ingredient-builder-overview';
  for (const metric of metrics) {
    const item = doc.createElement('div');
    item.className = 'ingredient-builder-metric';
    appendText(doc, item, 'dt', metric.label);
    appendText(doc, item, 'dd', metric.value);
    overview.appendChild(item);
  }
  host.appendChild(overview);
};

/** The issue list the UI surfaces: the review's own issues when it carries
 *  any (incl. warn/info riding a VALID review), else the decompose rpc's
 *  fallback issues — a failed decompose can return a clean review shell while
 *  the errors ride the rpc `issues` array (the server runs the recipe
 *  validator for the verdict but not for the review compile). The render gate
 *  and the renderer must derive from THIS one list or they disagree (an empty
 *  panel gets scrolled to, or valid-review warnings vanish). */
const visibleReviewIssues = (
  state: IngredientBuilderState,
): readonly AuthoringValidationIssue[] => {
  const fromReview = state.review?.issues ?? [];
  return fromReview.length > 0 ? fromReview : state.reviewIssues;
};

/** Review detail, split by concern: `privacy` (the PII chips — Overview-only
 *  context) vs `issues` (validation failures — host-level under the topbar so
 *  they're visible from every section). */
const renderReviewDetail = (
  doc: Document,
  state: IngredientBuilderState,
  host: HTMLElement,
  mode: 'privacy' | 'issues',
): void => {
  const review = state.review;
  const issues = visibleReviewIssues(state);

  if (mode === 'privacy') {
    if (review === undefined) return;
    const detail = doc.createElement('div');
    detail.className = 'ingredient-builder-review-detail';
    if (review.field_privacy.length === 0) {
      const empty = doc.createElement('span');
      empty.setAttribute(INGREDIENT_BUILDER_FIELD_PRIVACY_ATTR, '');
      empty.textContent = 'No PII tags';
      detail.appendChild(empty);
    } else {
      for (const entry of review.field_privacy) {
        const item = doc.createElement('span');
        item.setAttribute(INGREDIENT_BUILDER_FIELD_PRIVACY_ATTR, entry.privacy_kind);
        item.textContent = `${entry.path}: ${entry.privacy_kind}`;
        detail.appendChild(item);
      }
    }
    host.appendChild(detail);
    return;
  }

  if (issues.length === 0) return;
  const detail = doc.createElement('div');
  detail.className = 'ingredient-builder-review-detail';
  for (const issue of issues) {
    const item = doc.createElement('div');
    item.setAttribute(INGREDIENT_BUILDER_REVIEW_ISSUE_ATTR, issue.code);
    item.setAttribute('data-severity', issue.severity);
    item.textContent = issueText(issue);
    detail.appendChild(item);
  }
  host.appendChild(detail);
};

const errorMessage = (error: unknown): string =>
  humanizeRpcError(error);

const draftSummaryLabel = (draft: IngredientDraftSummary): string => {
  const title = draft.title ?? draft.slug ?? draft.draft_id;
  return `${title} (${plural(draft.operation_count, 'operation')})`;
};

const installBlockedReason = (state: IngredientBuilderState): string | null => {
  if (state.draftId === undefined) {
    return 'You cannot install this yet. Save a draft and review it first';
  }
  if (state.saveStage !== 'saved' || state.review?.valid !== true) {
    return 'You cannot install this yet. Your server has to check it again after your latest change';
  }
  return null;
};

const isWorkflowReady = (state: IngredientBuilderState): boolean =>
  state.draftId !== undefined
  && state.saveStage === 'saved'
  && state.review?.valid === true;

const canPreview = (state: IngredientBuilderState): boolean =>
  state.draftId !== undefined
  && state.saveStage === 'saved'
  && state.review?.valid === true
  && state.previewOperationKey.trim().length > 0
  && state.previewStage !== 'previewing';

const previewStatusText = (state: IngredientBuilderState): string => {
  if (state.previewStage === 'previewing') return 'Previewing';
  if (state.previewStage === 'error') return state.previewError;
  const preview = state.preview;
  if (preview === undefined) {
    return canPreview(state)
      ? 'Preview ready'
      : 'You cannot preview this until the draft is saved and checked';
  }
  if (!preview.ok) return `Preview failed: ${preview.code}`;
  if (!preview.execution.executed) return `Preview skipped: ${preview.execution.reason}`;
  if (preview.execution.outcome === 'error') {
    return `Preview error: ${preview.execution.error.code}`;
  }
  return preview.execution.status === undefined
    ? 'Preview ran: ok'
    : `Preview executed: ${preview.execution.status}`;
};

const installStatusText = (
  state: IngredientBuilderState,
  installInFlight = false,
  installBelongsToCurrentDraft = true,
): string => {
  if (installInFlight) {
    if (!installBelongsToCurrentDraft) return 'Finishing the last install';
    return state.installStage === 'installing'
      ? 'Installing the checked draft'
      : 'Installing an earlier checked draft';
  }
  if (state.installStage === 'installed' || state.installStage === 'error') {
    return state.installMessage;
  }
  return installBlockedReason(state) ?? 'Checked, and ready to install';
};

const parsePreviewArgs = (
  text: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } => {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed)
      ? { ok: true, value: parsed }
      : { ok: false, error: 'Preview args must be a JSON object' };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
};

/** The blank-draft identity defaults (stateFromBody's no-body branch) — the
 *  unsaved-content predicate compares against these so Setup/Overview-only
 *  edits on a fresh draft count as content. */
const BLANK_DRAFT_TITLE = 'Local ingredient';
const BLANK_DRAFT_SLUG = 'local-ingredient';

/** True when the current draft has USER EDITS that a New / draft-switch /
 *  route-leave would silently discard: the edit epoch moved off the last
 *  clean point (blank init, draft applied, save completed). Content
 *  enumeration can't do this job — it can't tell a load-FAILED draft (whose
 *  body is safely persisted server-side; nothing to lose) from a save-failed
 *  one, and it misses fields it forgot to enumerate. */
const draftHasUnsavedContent = (state: IngredientBuilderState): boolean =>
  state.editEpoch !== state.cleanEpoch;

/** The Save button's label carries the clean/dirty/busy signal. Shared by the
 *  render and the in-place topbar sync. */
const saveButtonLabel = (state: IngredientBuilderState): string =>
  state.saveStage === 'saving'
    ? 'Saving'
    : state.saveStage === 'reviewing'
      ? 'Validating'
      : state.saveStage === 'saved'
        ? 'Saved'
        : 'Save';

/** Live refs the topbar sync updates in place on a focused field edit. */
interface DraftPickerRefs {
  dirtyCue: HTMLElement;
  saveBtn: HTMLButtonElement;
  refreshBtn: HTMLButtonElement;
  newBtn: HTMLButtonElement;
}

const renderDraftPicker = (
  doc: Document,
  state: IngredientBuilderState,
  host: HTMLElement,
  loadDraft: (draftId: string) => void,
  newDraft: () => void,
  refreshDrafts: () => void,
  saveDraft: () => void,
  rerender: () => void,
): DraftPickerRefs => {
  const wrap = doc.createElement('div');
  wrap.className = 'ingredient-builder-draft-picker';

  const field = doc.createElement('div');
  field.className = 'ingredient-builder-field';
  const label = doc.createElement('label');
  label.textContent = 'Draft';
  field.appendChild(label);
  const select = doc.createElement('select');
  select.setAttribute(INGREDIENT_BUILDER_DRAFT_PICKER_ATTR, '');
  select.setAttribute(
    INGREDIENT_BUILDER_FOCUS_FIELD_ATTR,
    ingredientBuilderFocusFieldKey(INGREDIENT_BUILDER_DRAFT_PICKER_ATTR, ''),
  );
  select.setAttribute('aria-label', 'Draft');
  select.disabled = state.draftsStage === 'loading';

  const empty = doc.createElement('option');
  empty.value = '';
  empty.textContent = state.draftsStage === 'loading' ? 'Loading drafts' : 'New draft';
  if (state.draftId === undefined) empty.selected = true;
  select.appendChild(empty);
  for (const draft of state.drafts) {
    const option = doc.createElement('option');
    option.value = draft.draft_id;
    option.textContent = draftSummaryLabel(draft);
    if (draft.draft_id === state.draftId) option.selected = true;
    select.appendChild(option);
  }
  select.value = state.draftId ?? '';
  select.addEventListener('change', () => {
    const currentDraftId = state.draftId ?? '';
    const nextDraftId = select.value;
    if (nextDraftId === currentDraftId) return;
    if (draftHasUnsavedContent(state)) {
      const target = state.drafts.find((draft) => draft.draft_id === nextDraftId);
      const prompt = nextDraftId === ''
        ? 'Throw away your unsaved changes and start again?'
        : `Discard unsaved changes and open "${
            target?.title?.trim() || target?.slug?.trim() || nextDraftId
          }"?`;
      const view = doc.defaultView;
      if (view === null || !view.confirm(prompt)) {
        select.value = currentDraftId;
        return;
      }
    }
    if (nextDraftId === '') newDraft();
    else loadDraft(nextDraftId);
  });
  field.appendChild(select);
  wrap.appendChild(field);

  const draftActions = doc.createElement('div');
  draftActions.className = 'ingredient-builder-draft-actions';

  // Dirty cue: at-a-glance "you have unsaved changes". Always in the DOM so
  // the topbar sync can flip it in place on a focused field edit; an empty
  // cue hides entirely via :empty (the ● comes from the ::before dot).
  // Suppressed while busy — the Save label carries Saving/Validating, and the
  // epoch only reconciles at completion.
  const saved = state.saveStage === 'saved';
  const busy = state.saveStage === 'saving' || state.saveStage === 'reviewing';
  const dirty = doc.createElement('span');
  dirty.className = 'ingredient-builder-dirty-dot';
  dirty.textContent = !busy && draftHasUnsavedContent(state) ? 'Unsaved' : '';
  draftActions.appendChild(dirty);

  const save = makeButton(
    doc,
    saveButtonLabel(state),
    saved ? 'secondary' : 'primary',
    'sm',
    saveDraft,
  );
  // Keep the guarded RPC action focusable while busy. Native `disabled` drops
  // focus when the repaint replaces an active Save button; saveInFlight + the
  // stage guard remain the single-flight authority. Explicit ARIA exposes the
  // same unavailable/progress state without stranding keyboard focus.
  save.disabled = false;
  save.setAttribute('aria-disabled', String(busy));
  save.setAttribute('aria-busy', String(busy));
  save.setAttribute(INGREDIENT_BUILDER_SAVE_ATTR, '');
  save.setAttribute('title', 'Save and check the draft (⌘S or Ctrl+S)');
  draftActions.appendChild(save);

  const refresh = makeButton(
    doc,
    state.draftsStage === 'loading' ? 'Refreshing' : 'Refresh',
    'secondary',
    'sm',
    refreshDrafts,
  );
  const refreshBusy = state.draftsStage === 'loading';
  // Keep this owner reachable across its pending repaint. refreshDrafts owns
  // single-flight authority; ARIA conveys the guarded/progress state without
  // native disabling dropping keyboard focus.
  refresh.disabled = false;
  refresh.setAttribute('aria-disabled', String(refreshBusy));
  refresh.setAttribute('aria-busy', String(refreshBusy));
  refresh.setAttribute(INGREDIENT_BUILDER_DRAFT_REFRESH_ATTR, '');
  refresh.setAttribute('title', 'Load saved drafts again');
  draftActions.appendChild(refresh);

  // New, guarded by a two-tap confirm when the current draft has unsaved edits.
  const newBtn = makeButton(
    doc,
    state.newConfirmPending ? 'Discard & New?' : 'New',
    state.newConfirmPending ? 'danger-text' : 'secondary',
    'sm',
    () => {
      if (draftHasUnsavedContent(state) && !state.newConfirmPending) {
        state.newConfirmPending = true;
        rerender();
        return;
      }
      newDraft();
    },
  );
  newBtn.setAttribute(INGREDIENT_BUILDER_DRAFT_NEW_ATTR, '');
  draftActions.appendChild(newBtn);

  wrap.appendChild(draftActions);

  if (state.draftsStage === 'error') {
    const error = doc.createElement('div');
    error.className = 'ingredient-builder-draft-error';
    error.setAttribute('role', 'alert');
    error.textContent = state.draftsError.trim().length > 0
      ? state.draftsError
      : 'Cannot load drafts';
    wrap.appendChild(error);
  }
  host.appendChild(wrap);
  return { dirtyCue: dirty, saveBtn: save, refreshBtn: refresh, newBtn };
};

const renderPackSettings = (
  doc: Document,
  state: IngredientBuilderState,
  host: HTMLElement,
  rerender: () => void,
  target: 'setup' | 'publish',
  rerenderSetting?: (field: 'authModel') => void,
): { authModel?: HTMLSelectElement } => {
  const focusTargets: { authModel?: HTMLSelectElement } = {};
  appendSectionIntro(
    doc,
    host,
    target === 'setup' ? 'Connection setup' : 'Publish details',
    target === 'setup'
      ? 'Choose how this Pack reaches its service, then say what it sends and what comes back.'
      : 'Finish naming the Pack, filling in its Marketplace details, and setting what it does by default, before you preview it.',
  );
  const grid = doc.createElement('div');
  grid.className = 'ingredient-builder-pack-grid ingredient-builder-card';
  const addField = (labelText: string, child: HTMLElement): void => {
    const field = doc.createElement('div');
    field.className = 'ingredient-builder-field';
    const label = doc.createElement('label');
    label.textContent = labelText;
    if (child.getAttribute('aria-label') === null) {
      child.setAttribute('aria-label', labelText);
    }
    field.appendChild(label);
    field.appendChild(child);
    grid.appendChild(field);
  };

  if (target === 'setup') {
    // The connector: how this pack's operations reach the world. The auth model
    // drives whether a cli binary (delegated) or a connection is authored.
    // Closed local kinds such as storage have no connector config: show their
    // real kind and preserve it instead of projecting it onto the HTTP form.
    if (state.ingredientKind !== 'http' && state.ingredientKind !== 'cli') {
      const kind = makeTextInputWithAttr(
        doc,
        state.ingredientKind,
        INGREDIENT_BUILDER_INGREDIENT_KIND_ATTR,
        '',
        () => undefined,
      );
      kind.setAttribute('readonly', '');
      addField('Ingredient kind', kind);
    } else {
      const authSelect = makeSelectWithAttr(
        doc,
        state.authModel,
        AUTH_MODELS,
        INGREDIENT_BUILDER_AUTH_MODEL_ATTR,
        '',
        (next) => {
          state.authModel = next;
          state.ingredientKind = next === 'cli_delegated' ? 'cli' : 'http';
          markDirty(state);
          if (rerenderSetting === undefined) rerender();
          else rerenderSetting('authModel');
        },
      );
      focusTargets.authModel = authSelect;
      addField('Auth model', authSelect);
    }
    if (state.ingredientKind === 'cli') {
      addField('CLI tool', makeTextInputWithAttr(
        doc,
        state.cliTool,
        INGREDIENT_BUILDER_CLI_TOOL_ATTR,
        '',
        (next) => {
          state.cliTool = next;
          markDirty(state);
        },
      ));
      addField('Readiness argv', makeTextInputWithAttr(
        doc,
        state.cliReadinessProbe,
        INGREDIENT_BUILDER_CLI_READINESS_ATTR,
        '',
        (next) => {
          state.cliReadinessProbe = next;
          markDirty(state);
        },
      ));
    } else if (state.ingredientKind === 'http') {
      // api (`recued_injected`) connector config — base URL + the connection-KIND
      // these ops authenticate through + the catalog dialects. The secret auth
      // config itself is the D-125 connection record's job, not the pack.
      addField('Base URL', makeTextInputWithAttr(
        doc,
        state.httpBase,
        INGREDIENT_BUILDER_HTTP_BASE_ATTR,
        '',
        (next) => {
          state.httpBase = next;
          markDirty(state);
        },
      ));
      addField('Connection', makeTextInputWithAttr(
        doc,
        state.connection,
        INGREDIENT_BUILDER_CONNECTION_ATTR,
        '',
        (next) => {
          state.connection = next;
          markDirty(state);
        },
      ));
      addField('Surface result path', makeTextInputWithAttr(
        doc,
        state.httpResultPath,
        INGREDIENT_BUILDER_HTTP_RESULT_PATH_ATTR,
        '',
        (next) => {
          state.httpResultPath = next;
          markDirty(state);
        },
      ));
      addField('Search style', makeSelectWithAttr(
        doc,
        state.httpSearchStyle,
        ['', ...SEARCH_STYLES],
        INGREDIENT_BUILDER_HTTP_SEARCH_STYLE_ATTR,
        '',
        (next) => {
          state.httpSearchStyle = next;
          markDirty(state);
        },
      ));
      addField('Write style', makeSelectWithAttr(
        doc,
        state.httpWriteStyle,
        ['', ...WRITE_STYLES],
        INGREDIENT_BUILDER_HTTP_WRITE_STYLE_ATTR,
        '',
        (next) => {
          state.httpWriteStyle = next;
          markDirty(state);
        },
      ));
    }
    host.appendChild(grid);
    return focusTargets;
  }

  // target === 'publish' — the marketplace / install metadata. The editor always
  // produces a pack: a single ingredient (a simple endpoint, a one-call cli) is
  // itself the minimal pack — there is no non-pack install mode.
  // `default_grants` is a COMPOSITION field (install-grant override) that feeds
  // the decompose/review, so it uses markDirty (not markInstallDirty).
  const defaultGrantsInput = makeTextInputWithAttr(
    doc,
    state.packDefaultGrantsText,
    INGREDIENT_BUILDER_DEFAULT_GRANTS_ATTR,
    '',
    (next) => {
      state.packDefaultGrantsText = next;
      markDirty(state);
    },
  );
  addField('Default grants (group ids)', defaultGrantsInput);

  addField('Pack slug', makeTextInputWithAttr(
    doc,
    state.packSlug,
    INGREDIENT_BUILDER_PACK_SLUG_ATTR,
    '',
    (next) => {
      state.packSlug = next;
      markInstallDirty(state);
    },
  ));

  addField('Publisher', makeTextInputWithAttr(
    doc,
    state.packPublisher,
    INGREDIENT_BUILDER_PUBLISHER_ATTR,
    '',
    (next) => {
      state.packPublisher = next;
      markInstallDirty(state);
    },
  ));

  addField('Pack kind', makeSelectWithAttr(
    doc,
    state.packKind,
    PACK_KINDS,
    INGREDIENT_BUILDER_PACK_KIND_ATTR,
    '',
    (next) => {
      state.packKind = next;
      markInstallDirty(state);
    },
  ));

  addField('Service kind', makeSelectWithAttr(
    doc,
    state.packServiceKind,
    PACK_SERVICE_KIND_OPTIONS,
    INGREDIENT_BUILDER_SERVICE_KIND_ATTR,
    '',
    (next) => {
      state.packServiceKind = next;
      markInstallDirty(state);
    },
  ));

  addField('Description', makeTextInputWithAttr(
    doc,
    state.packDescription,
    INGREDIENT_BUILDER_PACK_DESCRIPTION_ATTR,
    '',
    (next) => {
      state.packDescription = next;
      markInstallDirty(state);
    },
  ));

  addField('Tags', makeTextInputWithAttr(
    doc,
    state.packTagsText,
    INGREDIENT_BUILDER_PACK_TAGS_ATTR,
    '',
    (next) => {
      state.packTagsText = next;
      markInstallDirty(state);
    },
  ));

  addField('Dependencies JSON', makeTextInputWithAttr(
    doc,
    state.packDependenciesText,
    INGREDIENT_BUILDER_PACK_DEPENDENCIES_ATTR,
    '',
    (next) => {
      state.packDependenciesText = next;
      markInstallDirty(state);
    },
  ));

  host.appendChild(grid);
  return focusTargets;
};

const renderPreviewDetail = (
  doc: Document,
  state: IngredientBuilderState,
  host: HTMLElement,
): HTMLElement | undefined => {
  const preview = state.preview;
  if (preview === undefined) return;
  const detail = doc.createElement('div');
  detail.className = 'ingredient-builder-preview-detail';
  if (!preview.ok) {
    appendText(doc, detail, 'span', preview.message);
    host.appendChild(detail);
    return detail;
  }
  appendText(doc, detail, 'span', `${preview.risk_tier} / ${preview.approval}`);
  appendText(doc, detail, 'code', preview.target.request);
  appendText(
    doc,
    detail,
    'span',
    `Auth ${preview.target.auth.model}`
      + (preview.target.auth.connection === null ? '' : ` via ${preview.target.auth.connection}`)
      + (preview.target.auth.connection_enrolled ? '' : ' (not set up yet)'),
  );
  if (preview.execution.executed && preview.execution.outcome === 'ok') {
    appendText(doc, detail, 'span', `${plural(preview.execution.mapping_preview.length, 'mapping')} checked`);
  }
  host.appendChild(detail);
  return detail;
};

const renderInstallDetail = (
  doc: Document,
  state: IngredientBuilderState,
  host: HTMLElement,
): void => {
  const result = state.installResult;
  if (result === undefined && state.installWarnings.length === 0) return;
  const detail = doc.createElement('div');
  detail.className = 'ingredient-builder-install-detail';
  if (result !== undefined) {
    if (result.ok) {
      appendText(doc, detail, 'span', `${plural(result.ingredient_ids.length, 'ingredient')} installed`);
      if (result.installed.kind === 'pack') {
        appendText(doc, detail, 'code', result.installed.pack_slug);
      } else {
        appendText(doc, detail, 'code', result.installed.ingredient_id);
      }
    } else {
      appendText(doc, detail, 'span', `${result.code}: ${result.message}`);
    }
  }
  for (const warning of state.installWarnings) {
    const item = appendText(doc, detail, 'span', issueText(warning));
    item.setAttribute(INGREDIENT_BUILDER_INSTALL_WARNING_ATTR, warning.code);
  }
  host.appendChild(detail);
};

const syncWorkflowActionAvailability = (
  button: HTMLButtonElement,
  busy: boolean,
  available: boolean,
): void => {
  // A genuinely unavailable workflow stays natively disabled. Once activated,
  // however, its busy replacement must remain focusable across the repaint;
  // the preview/install stage guards remain the single-flight authority.
  button.disabled = !busy && !available;
  button.setAttribute('aria-disabled', String(busy || !available));
  button.setAttribute('aria-busy', String(busy));
};

const renderWorkflow = (
  doc: Document,
  state: IngredientBuilderState,
  host: HTMLElement,
  invalidatePreview: () => void,
  runPreview: () => void,
  runInstall: () => void,
  installInFlight: boolean,
  installBelongsToCurrentDraft: boolean,
  setInstallAccess: (tier: InstallAccessTier) => void,
  setInstallAudience: (audience: InstallAudienceSelection) => void,
): {
  previewBtn: HTMLButtonElement;
  installBtn: HTMLButtonElement;
} => {
  const section = doc.createElement('section');
  section.className = 'ingredient-builder-workflow';
  appendText(doc, section, 'h2', 'Publish');
  const previewStatus = doc.createElement('div');
  previewStatus.className = 'ingredient-builder-workflow-status';
  previewStatus.setAttribute(INGREDIENT_BUILDER_PREVIEW_STATUS_ATTR, '');
  previewStatus.textContent = previewStatusText(state);
  let previewDetail: HTMLElement | undefined;
  let renderedPreviewBtn: HTMLButtonElement | undefined;
  const clearRenderedPreview = (): void => {
    invalidatePreview();
    previewStatus.textContent = previewStatusText(state);
    previewDetail?.remove();
    previewDetail = undefined;
    if (renderedPreviewBtn !== undefined) {
      renderedPreviewBtn.textContent = 'Preview';
      syncWorkflowActionAvailability(
        renderedPreviewBtn,
        false,
        canPreview(state),
      );
    }
  };

  // D-182 §7.1 / D-196 — the {Access × Audience} grant picker for a
  // connection-backed reviewed draft. Renders only once the draft validates
  // (install is actionable) AND the review has ≥1 connection-backed op family
  // (`surface === 'api'`); a cli draft yields a `null` model (cli authority is
  // the §7.2 per-contract bit, not a connection grant) and shows no picker. The
  // selected tier drives `ingredient.install`'s `install_scope` in `runInstall`.
  const grantModel =
    state.review?.valid === true
      ? installGrantModelFromReviewFamilies(state.review.operation_families)
      : null;
  if (grantModel !== null) {
    // Clamp to an offered tier — `installAccess` resets to `read` on re-review,
    // but a model change could still leave a tier the new model doesn't offer.
    const effectiveAccess = grantModel.accessOptions.includes(state.installAccess)
      ? state.installAccess
      : grantModel.defaultAccess;
    section.appendChild(
      renderInstallGrantPicker({
        document: doc,
        model: grantModel,
        access: effectiveAccess,
        audience: state.installAudience,
        disabled: installInFlight,
        onAccess: setInstallAccess,
        onAudience: setInstallAudience,
      }),
    );
  }

  const controls = doc.createElement('div');
  controls.className = 'ingredient-builder-preview-controls';

  const keys = operationKeys(state.rows);
  if (!keys.includes(state.previewOperationKey)) {
    state.previewOperationKey = keys[0] ?? '';
  }
  const opField = doc.createElement('div');
  opField.className = 'ingredient-builder-field';
  const opLabel = doc.createElement('label');
  opLabel.textContent = 'Preview operation';
  opField.appendChild(opLabel);
  const opSelect = makeSelectWithAttr(
    doc,
    state.previewOperationKey,
    keys.length > 0 ? keys : [''],
    INGREDIENT_BUILDER_PREVIEW_OPERATION_ATTR,
    '',
    (next) => {
      state.previewOperationKey = next;
      clearRenderedPreview();
    },
  );
  opSelect.disabled = keys.length === 0;
  opField.appendChild(opSelect);
  controls.appendChild(opField);

  const argsField = doc.createElement('div');
  argsField.className = 'ingredient-builder-field';
  const argsLabel = doc.createElement('label');
  argsLabel.textContent = 'Preview args';
  argsField.appendChild(argsLabel);
  argsField.appendChild(makeTextInputWithAttr(
    doc,
    state.previewArgsText,
    INGREDIENT_BUILDER_PREVIEW_ARGS_ATTR,
    '',
    (next) => {
      state.previewArgsText = next;
      clearRenderedPreview();
    },
  ));
  controls.appendChild(argsField);

  const preview = makeButton(
    doc,
    state.previewStage === 'previewing' ? 'Previewing' : 'Preview',
    'secondary',
    'sm',
    runPreview,
  );
  syncWorkflowActionAvailability(
    preview,
    state.previewStage === 'previewing',
    canPreview(state),
  );
  preview.setAttribute(INGREDIENT_BUILDER_PREVIEW_ATTR, '');
  renderedPreviewBtn = preview;
  controls.appendChild(preview);

  const install = makeButton(
    doc,
    installInFlight ? 'Installing' : 'Install',
    'primary',
    'sm',
    runInstall,
  );
  const blocked = installBlockedReason(state);
  syncWorkflowActionAvailability(
    install,
    installInFlight,
    blocked === null,
  );
  if (installInFlight) {
    install.title = installBelongsToCurrentDraft
      ? 'A checked version of this draft is installing'
      : 'Another checked draft is still installing';
  } else if (blocked !== null) install.title = blocked;
  install.setAttribute(INGREDIENT_BUILDER_INSTALL_ATTR, '');
  controls.appendChild(install);
  section.appendChild(controls);

  section.appendChild(previewStatus);
  previewDetail = renderPreviewDetail(doc, state, section);

  const installStatus = doc.createElement('div');
  installStatus.className = 'ingredient-builder-workflow-status';
  installStatus.setAttribute(INGREDIENT_BUILDER_INSTALL_STATUS_ATTR, '');
  installStatus.textContent = installStatusText(
    state,
    installInFlight,
    installBelongsToCurrentDraft,
  );
  section.appendChild(installStatus);
  renderInstallDetail(doc, state, section);

  host.appendChild(section);
  return { previewBtn: preview, installBtn: install };
};

/** Live refs the topbar sync updates in place on a focused field edit. */
interface StatusLineRefs {
  chip: HTMLElement;
  status: HTMLElement;
}

/** The review chip's data-state for the current review/issue state. */
const reviewChipState = (state: IngredientBuilderState): string =>
  state.review === undefined
    ? state.reviewIssues.length > 0
      ? 'invalid'
      : 'pending'
    : state.review.valid
      ? 'valid'
      : 'invalid';

const renderStatusLine = (
  doc: Document,
  state: IngredientBuilderState,
  host: HTMLElement,
): StatusLineRefs => {
  const statusLine = doc.createElement('div');
  statusLine.className = 'ingredient-builder-status-line';
  const review = doc.createElement('span');
  review.setAttribute(
    INGREDIENT_BUILDER_REVIEW_STATUS_ATTR,
    '',
  );
  review.setAttribute('data-state', reviewChipState(state));
  review.textContent = reviewBannerText(state.review, state.reviewIssues);
  statusLine.appendChild(review);

  const status = doc.createElement('span');
  status.setAttribute(INGREDIENT_BUILDER_STATUS_ATTR, '');
  // Failures read as failures — not the same muted gray as progress notes.
  if (state.saveStage === 'error') status.setAttribute('data-state', 'error');
  status.textContent = state.status;
  statusLine.appendChild(status);
  host.appendChild(statusLine);
  return { chip: review, status };
};

const injectStyles = (doc: Document): void => {
  if (
    doc.head !== undefined
    && doc.head.querySelector(`style[${INGREDIENT_BUILDER_STYLES_MARKER}]`) === null
  ) {
    const style = doc.createElement('style');
    style.setAttribute(INGREDIENT_BUILDER_STYLES_MARKER, '');
    // D-182 §7.1 (inc 5b.2) — the install grant picker renders inside the
    // kitchen Install workflow for a connection-backed reviewed draft, so its
    // styles join this route bundle too (scoped, inert until rendered).
    style.textContent = [
      PRIMITIVE_STYLES,
      INGREDIENT_BUILDER_STYLES,
      INSTALL_GRANT_PICKER_STYLES,
    ].join('\n');
    doc.head.appendChild(style);
  }
};

export const bootstrapIngredientBuilderRoute = (
  options: BootstrapIngredientBuilderRouteOptions,
): IngredientBuilderRoute => {
  const doc = options.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'bootstrapIngredientBuilderRoute: no document available; pass options.document for non-browser environments',
    );
  }
  injectStyles(doc);

  const focusDocument = doc as Partial<Pick<Document, 'activeElement' | 'body'>>;
  const activeBeforeMount = focusDocument.activeElement ?? null;
  let focusHeadingOnMount = activeBeforeMount === null
    || activeBeforeMount === focusDocument.body;
  if (!focusHeadingOnMount && activeBeforeMount !== null) {
    try {
      focusHeadingOnMount = options.root.contains(activeBeforeMount);
    } catch {
      focusHeadingOnMount = false;
    }
  }

  const state = stateFromBody(
    options.initialBody,
    options.initialTitle,
    options.initialDraftId,
  );
  let nextRowId = state.rows.length;
  let nextFieldId = state.entityFields.length;
  let operationSearch = '';
  let fieldSearch = '';
  const appendSearch = (parent: HTMLElement, kind: 'operations' | 'fields'): void => {
    const toolbar = doc.createElement('div'); toolbar.className = 'ingredient-builder-search';
    const search = doc.createElement('input'); search.type = 'search';
    search.value = kind === 'operations' ? operationSearch : fieldSearch;
    search.setAttribute('aria-label', kind === 'operations' ? 'Search the operations' : 'Search the data fields');
    search.setAttribute('data-recued-pack-search', kind);
    search.setAttribute('placeholder', kind === 'operations' ? 'Find an operation…' : 'Find a data field…');
    toolbar.appendChild(search);
    const clear = makeButton(doc, 'Clear', 'secondary', 'sm', () => {
      search.value = '';
      if (kind === 'operations') operationSearch = ''; else fieldSearch = '';
      filter(); search.focus();
    });
    clear.setAttribute('aria-label', kind === 'operations' ? 'Clear the operation search' : 'Clear the data field search');
    toolbar.appendChild(clear);
    const count = doc.createElement('p'); count.setAttribute('role', 'status');
    toolbar.appendChild(count);
    if (typeof parent.insertBefore === 'function') parent.insertBefore(toolbar, parent.children[1] ?? null);
    else parent.appendChild(toolbar);
    const filter = (): void => {
      const query = search.value.trim().toLowerCase();
      const rows = kind === 'operations' ? state.rows : state.entityFields;
      const attr = kind === 'operations' ? INGREDIENT_BUILDER_ROW_ATTR : INGREDIENT_BUILDER_ENTITY_ROW_ATTR;
      const matches = new Set(rows.filter(row => JSON.stringify(row).toLowerCase().includes(query)).map(row => row.id));
      for (const el of Array.from(parent.querySelectorAll?.<HTMLElement>(`[${attr}]`) ?? [])) {
        const shown = matches.has(el.getAttribute(attr) ?? '');
        el.hidden = !shown;
        if (shown) el.style?.removeProperty('display'); else el.style?.setProperty('display', 'none');
        if (kind === 'fields') {
          const extras = el.nextElementSibling as HTMLElement | null;
          if (extras?.classList.contains('ingredient-builder-entity-extras-tr')) {
            extras.hidden = !shown;
            if (shown) extras.style.removeProperty('display'); else extras.style.setProperty('display', 'none');
          }
        }
      }
      for (const group of Array.from(parent.querySelectorAll?.<HTMLElement>(
        '.ingredient-builder-op-group, .ingredient-builder-entity-group',
      ) ?? [])) {
        const shown = Array.from(group.querySelectorAll<HTMLElement>(`[${attr}]`))
          .some(row => matches.has(row.getAttribute(attr) ?? ''));
        group.hidden = !shown;
        if (shown) group.style.removeProperty('display'); else group.style.setProperty('display', 'none');
      }
      clear.hidden = search.value.length === 0;
      const label = kind === 'operations' ? 'operation' : 'field';
      count.textContent = query
        ? `${matches.size} of ${plural(rows.length, label)}${matches.size ? '' : ' · Try a different search'}`
        : plural(rows.length, label);
    };
    search.addEventListener('input', () => {
      if (kind === 'operations') operationSearch = search.value; else fieldSearch = search.value;
      filter();
    });
    search.addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (event.key === 'Escape' && search.value) { event.preventDefault(); event.stopPropagation(); clear.click(); }
    });
    filter();
  };
  let disposed = false;
  /** True while a save→decompose chain is in flight (saveStage can't carry
   *  this — markDirty resets it to 'idle' on a mid-save edit). */
  let saveInFlight = false;
  /** The install stage lives in rendered state and is cleared when an author
   *  edits or swaps drafts. The RPC does not disappear with that repaint, so
   *  keep its ownership outside state: this is the single-flight authority
   *  and the generation/epoch boundary for late completions. */
  let installFlight: {
    draftGeneration: number;
    editEpoch: number;
    installInputEpoch: number;
  } | null = null;
  /** Bumped on every draft swap (load / new). Async continuations capture it
   *  at dispatch and drop their verdicts when it moved — a slow save/load for
   *  a PREVIOUS draft must never stomp the currently shown one (success AND
   *  failure paths alike). */
  let draftGeneration = 0;
  // Save owns focus across its saving → reviewing → settled repaint chain.
  // Its guarded busy replacement remains focusable; cancel the intent if the
  // user deliberately focuses another connected control.
  let saveBtn: HTMLButtonElement | undefined;
  let draftRefreshBtn: HTMLButtonElement | undefined;
  let newDraftBtn: HTMLButtonElement | undefined;
  let routeHeading: HTMLElement | undefined;
  let pendingSaveFocus = false;
  let pendingDraftRefreshFocus = false;
  let pendingNewDraftFocus = false;
  // A save completion may need a newer list than an already-running manual
  // refresh can provide. Queue one follow-up instead of overlapping list RPCs.
  let draftRefreshQueued = false;
  // Preview and Install own focus across their busy → settled repaint chains.
  // Their guarded busy replacements remain focusable; cancel the intent when
  // the author moves to another live control during the request.
  let previewBtn: HTMLButtonElement | undefined;
  let installBtn: HTMLButtonElement | undefined;
  let pendingWorkflowFocus: 'preview' | 'install' | null = null;
  let previewGeneration = 0;
  let pendingAddedOperationFocusId: string | null = null;
  let pendingRemovedOperationFocusId: string | null = null;
  let pendingOperationFieldFocus: {
    rowId: string;
    field: 'bindingKind' | 'reviewed' | 'summary';
  } | null = null;
  let pendingOperationArgumentFocus: {
    rowId: string;
    argIndex: number | null;
  } | null = null;
  let pendingPackSettingFocus: 'authModel' | null = null;
  let pendingAddedEntityFieldFocusId: string | null = null;
  let pendingRemovedEntityFieldFocus: { fieldId: string | null } | null = null;
  let pendingEntityFieldFocus: {
    fieldId: string;
    field: 'optional' | 'reviewed';
  } | null = null;
  let addEntityFieldBtn: HTMLButtonElement | undefined;
  let renderedOperationFocusTargets = new Map<string, {
    card: HTMLElement;
    summary: HTMLElement;
    firstField: HTMLInputElement;
    bindingKind: HTMLSelectElement;
    reviewed: HTMLInputElement;
    arguments: OperationArgumentFocusTargets;
  }>();
  let renderedEntityFieldFocusTargets = new Map<string, {
    row: HTMLElement;
    firstField: HTMLInputElement;
    optional: HTMLInputElement;
    reviewed: HTMLInputElement;
  }>();
  let renderedPackSettingFocusTargets: { authModel?: HTMLSelectElement } = {};

  const host = doc.createElement('section');
  host.setAttribute(INGREDIENT_BUILDER_ROUTE_ATTR, '');
  options.root.appendChild(host);

  // Screen-reader outcome announcer — one PERSISTENT visually-hidden live
  // region (a per-render node born with its text set announces nothing, and
  // AT also ignores mutations in a region re-inserted the same task). It is
  // therefore mounted ONCE, outside the per-render `content` wrapper that
  // rerender clears, and never detached until dispose; announce() mutates it
  // only on save/validate/preview/install completion.
  const announcer = doc.createElement('div');
  announcer.className = 'ingredient-builder-sr-announcer';
  announcer.setAttribute('role', 'status');
  announcer.setAttribute('aria-live', 'polite');
  host.appendChild(announcer);
  const announce = (text: string): void => {
    announcer.textContent = text;
  };

  // Everything rerender() paints lives under this wrapper — clearing it
  // leaves the announcer (above) attached across renders.
  const content = doc.createElement('div');
  host.appendChild(content);

  // Async draft validation/save completion repaints the whole editor while an
  // author may already be typing. Preserve the live control by semantic field
  // key + same-key occurrence (operation/entity rows repeat column keys), plus
  // a text selection when the control carries one.
  type IngredientBuilderFieldFocus = {
    fieldKey: string;
    occurrence: number;
    selectionStart: number | null;
    selectionEnd: number | null;
  };

  const editorFields = (fieldKey: string): HTMLElement[] => {
    const matches: HTMLElement[] = [];
    const walk = (element: HTMLElement): void => {
      if (element.getAttribute?.(INGREDIENT_BUILDER_FOCUS_FIELD_ATTR) === fieldKey) {
        matches.push(element);
      }
      const children = (
        element as unknown as { children?: ArrayLike<HTMLElement> }
      ).children;
      if (children === undefined) return;
      for (let index = 0; index < children.length; index += 1) {
        walk(children[index] as HTMLElement);
      }
    };
    walk(content);
    return matches;
  };

  const captureFieldFocus = (
    element: HTMLElement,
  ): IngredientBuilderFieldFocus | null => {
    const fieldKey = element.getAttribute?.(INGREDIENT_BUILDER_FOCUS_FIELD_ATTR) ?? null;
    if (fieldKey === null) return null;
    const occurrence = editorFields(fieldKey).indexOf(element);
    if (occurrence < 0) return null;
    const selection = element as unknown as {
      selectionStart?: number | null;
      selectionEnd?: number | null;
    };
    return {
      fieldKey,
      occurrence,
      selectionStart: typeof selection.selectionStart === 'number'
        ? selection.selectionStart
        : null,
      selectionEnd: typeof selection.selectionEnd === 'number'
        ? selection.selectionEnd
        : null,
    };
  };

  const restoreFieldFocus = (focus: IngredientBuilderFieldFocus): boolean => {
    const target = editorFields(focus.fieldKey)[focus.occurrence];
    if (target === undefined || (target as HTMLInputElement).disabled === true) {
      return false;
    }
    target.focus?.({ preventScroll: true });
    if (focus.selectionStart !== null && focus.selectionEnd !== null) {
      try {
        (target as HTMLInputElement | HTMLTextAreaElement).setSelectionRange?.(
          focus.selectionStart,
          focus.selectionEnd,
        );
      } catch {
        // Selects and non-text inputs have no caret to restore.
      }
    }
    return true;
  };

  // Live refs for post-completion scrolling: the sticky topbar (its measured
  // height keeps scrolled-to content clear of the overlay) and the host-level
  // validation-issues panel rendered right under it.
  let topbarEl: HTMLElement | undefined;
  let issuesPanel: HTMLElement | undefined;

  /** Bring freshly rendered validation issues into view — Save sits in the
   *  sticky topbar while the user may be scrolled deep in any section. Same
   *  approach as the recipe editor: measure the CURRENT topbar height into
   *  scroll-margin-top (the CSS 120px is only the no-measure fallback) and
   *  align to 'start' ('nearest' would no-op while the panel sits occluded
   *  UNDER the bar). No-op in non-browser docs. */
  const revealIssues = (): void => {
    if (issuesPanel === undefined) return;
    const barHeight = topbarEl?.offsetHeight;
    if (typeof barHeight === 'number' && barHeight > 0) {
      issuesPanel.style?.setProperty?.('scroll-margin-top', `${barHeight + 12}px`);
    }
    issuesPanel.scrollIntoView?.({ block: 'start' });
  };

  const applyDraftState = (
    body: unknown,
    title: string | undefined,
    draftId: string | undefined,
  ): void => {
    const drafts = state.drafts;
    const draftsStage = state.draftsStage;
    const draftsError = state.draftsError;
    const next = stateFromBody(body, title, draftId);
    if (next.draftId === undefined) delete state.draftId;
    else state.draftId = next.draftId;
    state.title = next.title;
    state.slug = next.slug;
    state.connection = next.connection;
    state.httpBase = next.httpBase;
    state.httpResultPath = next.httpResultPath;
    state.httpSearchStyle = next.httpSearchStyle;
    state.httpWriteStyle = next.httpWriteStyle;
    state.catalogKind = next.catalogKind;
    state.ingredientKind = next.ingredientKind;
    state.authModel = next.authModel;
    state.cliTool = next.cliTool;
    state.cliReadinessProbe = next.cliReadinessProbe;
    state.packSlug = next.packSlug;
    state.packPublisher = next.packPublisher;
    state.packKind = next.packKind;
    state.packServiceKind = next.packServiceKind;
    state.packDescription = next.packDescription;
    state.packTagsText = next.packTagsText;
    state.packDependenciesText = next.packDependenciesText;
    state.packDefaultGrantsText = next.packDefaultGrantsText;
    state.workEntitySources = next.workEntitySources;
    state.forceCatalogLowering = next.forceCatalogLowering;
    state.rows = next.rows;
    state.entityFields = next.entityFields;
    state.entityAliases = next.entityAliases;
    state.saveStage = next.saveStage;
    state.status = next.status;
    state.review = undefined;
    state.reviewIssues = [];
    state.drafts = drafts;
    state.draftsStage = draftsStage;
    state.draftsError = draftsError;
    state.previewOperationKey = next.previewOperationKey;
    state.previewArgsText = '{}';
    // Per-card open overrides belong to the OLD draft's rows — reset.
    state.opCardOpen = new Map();
    state.opAdvancedOpen = new Map();
    // The applied body IS the clean baseline — nothing user-authored yet.
    state.cleanEpoch = state.editEpoch;
    state.installInputEpoch = next.installInputEpoch;
    // Invalidate in-flight continuations dispatched against the old draft.
    draftGeneration += 1;
    clearPreviewState(state);
    clearInstallState(state);
    nextRowId = state.rows.length;
    nextFieldId = state.entityFields.length;
    // Edit→Kitchen — the single choke point for a draft change (load / new /
    // self-load), so the kitchen route can keep the `#kitchen/pack[/<draft>]`
    // URL in lockstep with the loaded draft. `next.draftId` is undefined for a
    // fresh/blank draft.
    options.onDraftChange?.(next.draftId);
  };

  const refreshDrafts = (queueWhenBusy = false): void => {
    if (disposed) return;
    if (state.draftsStage === 'loading') {
      if (queueWhenBusy === true) draftRefreshQueued = true;
      return;
    }
    state.draftsStage = 'loading';
    state.draftsError = '';
    rerender();
    const settleDraftRefresh = (): void => {
      if (draftRefreshQueued) {
        draftRefreshQueued = false;
        refreshDrafts();
        return;
      }
      rerender();
    };
    void options.conn('ingredient.draft.list', undefined)
      .then((result) => {
        state.drafts = result.drafts;
        state.draftsStage = 'loaded';
        state.draftsError = '';
        settleDraftRefresh();
      })
      .catch((error: unknown) => {
        state.draftsStage = 'error';
        state.draftsError = errorMessage(error);
        settleDraftRefresh();
      });
  };

  const newDraft = (): void => {
    applyDraftState(undefined, undefined, undefined);
    state.newConfirmPending = false;
    state.status = 'New draft';
    rerender();
  };

  const loadDraft = (draftId: string): void => {
    if (draftId.trim().length === 0) {
      newDraft();
      return;
    }
    state.newConfirmPending = false;
    state.status = 'Loading draft';
    state.saveStage = 'idle';
    clearPreviewState(state);
    clearInstallState(state);
    rerender();
    // The generation this load is CURRENTLY entitled to act on. Starts at the
    // dispatch value; applyDraftState (below) bumps the global counter for
    // THIS load, so the entitlement advances with it — while any OTHER swap
    // bumping the counter orphans both the continuation and the catch.
    let genEntitled = draftGeneration;
    void options.conn('ingredient.draft.get', { draft_id: draftId })
      .then(async (result) => {
        if (disposed || draftGeneration !== genEntitled) return;
        if (!result.ok) {
          state.status = result.message;
          rerender();
          return;
        }
        applyDraftState(result.draft.body, result.draft.title, result.draft.draft_id);
        genEntitled = draftGeneration;
        const epochAtLoad = state.editEpoch;
        state.saveStage = 'reviewing';
        state.status = 'Checking the draft';
        rerender();

        const decompose = await options.conn('ingredient.compose.decompose', {
          draft_id: result.draft.draft_id,
        });
        if (disposed || draftGeneration !== genEntitled) return;
        const staleEdits = state.editEpoch !== epochAtLoad;
        if (decompose.ok && staleEdits) {
          // Edits landed while validating — the verdict describes a body the
          // editor no longer shows. Don't dress the chip 'Valid' next to an
          // 'Unsaved' dot; leave the review pending until the next save.
          state.review = undefined;
          state.reviewIssues = [];
          state.saveStage = 'idle';
          state.status = 'Opened — you have unsaved changes';
        } else {
          state.review = decompose.review;
          state.reviewIssues = decompose.ok ? [] : decompose.issues;
          state.saveStage = decompose.ok ? 'saved' : 'error';
          if (decompose.ok) {
            state.status = 'Draft opened and checked';
            state.previewOperationKey = state.previewOperationKey || firstOperationKey(state.rows);
          } else if (decompose.code === 'validation_failed') {
            state.status = 'Check failed';
          } else {
            state.status = decompose.message;
          }
        }
        rerender();
        announce(state.status);
        if (!decompose.ok) revealIssues();
      })
      .catch((error: unknown) => {
        if (disposed || draftGeneration !== genEntitled) return;
        state.saveStage = 'error';
        state.status = errorMessage(error);
        state.review = undefined;
        state.reviewIssues = [];
        rerender();
        announce(state.status);
      });
  };

  const runPreview = (): void => {
    if (!canPreview(state) || state.draftId === undefined) return;
    previewGeneration += 1;
    const previewGenerationAtDispatch = previewGeneration;
    const draftGenerationAtDispatch = draftGeneration;
    const editEpochAtDispatch = state.editEpoch;
    const args = parsePreviewArgs(state.previewArgsText);
    if (!args.ok) {
      state.previewStage = 'error';
      state.previewError = args.error;
      state.preview = undefined;
      rerender();
      return;
    }
    state.previewStage = 'previewing';
    state.previewError = '';
    state.preview = undefined;
    rerender();
    void options.conn('ingredient.preview', {
      draft_id: state.draftId,
      operation_key: state.previewOperationKey,
      args: args.value,
    })
      .then((result) => {
        if (
          disposed
          || previewGeneration !== previewGenerationAtDispatch
          || draftGeneration !== draftGenerationAtDispatch
          || state.editEpoch !== editEpochAtDispatch
        ) return;
        state.preview = result;
        state.previewStage = result.ok ? 'ready' : 'error';
        state.previewError = result.ok ? '' : result.message;
        rerender();
        announce(previewStatusText(state));
      })
      .catch((error: unknown) => {
        if (
          disposed
          || previewGeneration !== previewGenerationAtDispatch
          || draftGeneration !== draftGenerationAtDispatch
          || state.editEpoch !== editEpochAtDispatch
        ) return;
        state.previewStage = 'error';
        state.previewError = errorMessage(error);
        state.preview = undefined;
        rerender();
        announce(previewStatusText(state));
      });
  };

  const runInstall = (): void => {
    if (installFlight !== null) return;
    const blocked = installBlockedReason(state);
    if (blocked !== null || state.draftId === undefined) return;
    const flight = {
      draftGeneration,
      editEpoch: state.editEpoch,
      installInputEpoch: state.installInputEpoch,
    };
    installFlight = flight;
    let installRequestSent = false;
    state.installStage = 'installing';
    state.installMessage = 'Installing the checked draft';
    state.installResult = undefined;
    state.installWarnings = [];
    rerender();
    void options.conn('ingredient.draft.get', { draft_id: state.draftId })
      .then(async (draft) => {
        if (
          disposed
          || installFlight !== flight
          || draftGeneration !== flight.draftGeneration
          || state.editEpoch !== flight.editEpoch
          || state.installInputEpoch !== flight.installInputEpoch
        ) return;
        if (!draft.ok) {
          state.installStage = 'error';
          state.installMessage = draft.message;
          return;
        }
        // D-182 §7.1/§7.2 — send the picked Access tier + Scope as `install_scope`
        // when the reviewed draft is connection-backed (the picker was shown). A cli
        // draft (null grant model → no picker) sends no `install_scope`, so the
        // provisioner fails closed to authored read/`ask` defaults.
        const grantModel =
          state.review?.valid === true
            ? installGrantModelFromReviewFamilies(state.review.operation_families)
            : null;
        // Clamp to an offered tier (defensive — mirrors the render clamp) so a
        // stale tier can never be sent as `install_scope.access`. Scope has no
        // model-derived clamp (its options are fixed by `InstallScopeWho`).
        const installScope: InstallGrantSelection | undefined =
          grantModel !== null
            ? {
                access: grantModel.accessOptions.includes(state.installAccess)
                  ? state.installAccess
                  : grantModel.defaultAccess,
                audience: state.installAudience,
              }
            : undefined;
        const manifest = installManifestFor(state, draft.draft.body);
        installRequestSent = true;
        const result = await options.conn('ingredient.install', {
          manifest,
          ...(installScope !== undefined ? { install_scope: installScope } : {}),
        });
        if (
          disposed
          || installFlight !== flight
          || draftGeneration !== flight.draftGeneration
        ) return;
        const newerEdits = state.editEpoch !== flight.editEpoch
          || state.installInputEpoch !== flight.installInputEpoch;
        state.installResult = result;
        state.installWarnings = result.ok ? result.warnings : result.issues;
        if (result.ok) {
          state.installStage = 'installed';
          const receipt = result.installed.kind === 'pack'
            ? `Installed pack ${result.installed.pack_slug}`
            : `Installed ingredient ${result.installed.ingredient_id}`;
          state.installMessage = newerEdits
            ? `${receipt} — newer edits pending`
            : receipt;
        } else {
          state.installStage = 'error';
          state.installMessage = newerEdits
            ? `${result.message} — newer edits pending`
            : result.message;
        }
        announce(state.installMessage);
      })
      .catch((error: unknown) => {
        if (
          disposed
          || installFlight !== flight
          || draftGeneration !== flight.draftGeneration
          || (
            !installRequestSent
            && (
              state.editEpoch !== flight.editEpoch
              || state.installInputEpoch !== flight.installInputEpoch
            )
          )
        ) return;
        const newerEdits = state.editEpoch !== flight.editEpoch
          || state.installInputEpoch !== flight.installInputEpoch;
        state.installStage = 'error';
        const message = errorMessage(error);
        state.installMessage = newerEdits
          ? `${message} — newer edits pending`
          : message;
        state.installResult = undefined;
        state.installWarnings = [];
        announce(state.installMessage);
      })
      .finally(() => {
        if (installFlight !== flight) return;
        installFlight = null;
        rerender();
      });
  };

  const saveDraft = (): void => {
    // saveStage alone can't gate reentry: markDirty resets it to 'idle' on a
    // mid-save field edit, which would let Cmd+S start a SECOND overlapping
    // save/decompose chain. The flag tracks the actual flight.
    if (saveInFlight) return;
    if (state.saveStage === 'saving' || state.saveStage === 'reviewing') return;
    // Advanced-field JSON (groups / editable args / pagination details /
    // extra operation JSON) parses here — surface a bad field as a save
    // error instead of throwing out of the click handler mid-"Saving".
    let body: CompositionIngredient;
    try {
      body = buildComposition(state);
    } catch (error: unknown) {
      state.saveStage = 'error';
      state.status = errorMessage(error);
      state.review = undefined;
      state.reviewIssues = [];
      rerender();
      return;
    }
    state.saveStage = 'saving';
    state.status = 'Saving draft';
    state.review = undefined;
    state.reviewIssues = [];
    clearPreviewState(state);
    clearInstallState(state);
    rerender();
    saveInFlight = true;
    // Edits landing while the flight is up are NOT in `body` — the completion
    // checks the epoch so it never reports those keystrokes as saved. A draft
    // swap (load / New) bumps the generation and orphans the whole chain,
    // success and failure alike — a slow verdict for a previous draft must
    // not stomp the one now shown.
    const epochAtSave = state.editEpoch;
    const genAtDispatch = draftGeneration;
    void options.conn('ingredient.draft.save', {
      ...(state.draftId !== undefined ? { draft_id: state.draftId } : {}),
      ...(state.title.trim().length > 0 ? { title: state.title.trim() } : {}),
      body,
    })
      .then(async (result) => {
        if (disposed || draftGeneration !== genAtDispatch) return;
        if (!result.ok) {
          state.saveStage = 'error';
          state.status = result.message;
          state.reviewIssues = [];
          rerender();
          return;
        }

        state.draftId = result.draft.draft_id;
        // Edit→Kitchen — a first save assigns a server draft id; surface it so
        // the kitchen route can update the URL to `#kitchen/pack/<draft_id>`
        // (a fresh draft's URL was `#kitchen/pack`). saveDraft sets draftId
        // directly rather than via applyDraftState, so fire the hook here too.
        options.onDraftChange?.(state.draftId);
        state.saveStage = 'reviewing';
        state.status = 'Checking the draft';
        rerender();

        const decompose = await options.conn('ingredient.compose.decompose', {
          draft_id: result.draft.draft_id,
        });
        if (disposed || draftGeneration !== genAtDispatch) return;
        const staleEdits = state.editEpoch !== epochAtSave;
        if (decompose.ok && staleEdits) {
          // The verdict is for a superseded body — report the save without
          // dressing the chip 'Valid' next to an 'Unsaved' dot.
          state.review = undefined;
          state.reviewIssues = [];
          state.saveStage = 'idle';
          state.status = 'Saved — you have changed things since';
          state.previewOperationKey = state.previewOperationKey || firstOperationKey(state.rows);
          refreshDrafts(true);
        } else {
          state.review = decompose.review;
          state.reviewIssues = decompose.ok ? [] : decompose.issues;
          state.saveStage = decompose.ok ? 'saved' : 'error';
          if (decompose.ok) {
            // Everything through epochAtSave is durable — new clean baseline.
            state.cleanEpoch = epochAtSave;
            state.status = 'Draft saved and checked';
            state.previewOperationKey = state.previewOperationKey || firstOperationKey(state.rows);
            refreshDrafts(true);
          } else if (decompose.code === 'validation_failed') {
            state.status = 'Check failed';
          } else {
            state.status = decompose.message;
          }
        }
        rerender();
        announce(state.status);
        if (!decompose.ok) revealIssues();
      })
      .catch((error: unknown) => {
        if (disposed || draftGeneration !== genAtDispatch) return;
        state.saveStage = 'error';
        state.status = humanizeRpcError(error);
        state.review = undefined;
        state.reviewIssues = [];
        rerender();
        announce(state.status);
      })
      .finally(() => {
        saveInFlight = false;
      });
  };

  const removeOperation = (entry: OperationFamilyRowDraft): void => {
    const renderedIds = [...renderedOperationFocusTargets.keys()];
    const renderedIndex = renderedIds.indexOf(entry.id);
    const stateIndex = state.rows.indexOf(entry);
    if (renderedIndex < 0 || stateIndex < 0) return;
    state.rows.splice(stateIndex, 1);
    // Prune the removed row's open override — row ids can be re-minted.
    state.opCardOpen.delete(entry.id);
    state.opAdvancedOpen.delete(entry.id);
    const survivors = renderedIds.filter((id) => id !== entry.id);
    pendingRemovedOperationFocusId =
      survivors[Math.min(renderedIndex, survivors.length - 1)] ?? null;
    markDirty(state);
    rerender();
  };

  const removeEntityField = (entry: EntityFieldRowDraft): void => {
    const renderedIds = [...renderedEntityFieldFocusTargets.keys()];
    const renderedIndex = renderedIds.indexOf(entry.id);
    const stateIndex = state.entityFields.indexOf(entry);
    if (renderedIndex < 0 || stateIndex < 0) return;
    state.entityFields.splice(stateIndex, 1);
    const survivors = renderedIds.filter((id) => id !== entry.id);
    pendingRemovedEntityFieldFocus = {
      fieldId: survivors[Math.min(renderedIndex, survivors.length - 1)] ?? null,
    };
    markDirty(state);
    rerender();
  };

  const rerenderOperationField = (
    rowId: string,
    field: 'bindingKind' | 'reviewed' | 'summary',
  ): void => {
    pendingOperationFieldFocus = { rowId, field };
    rerender();
  };

  const rerenderEntityField = (
    fieldId: string,
    field: 'optional' | 'reviewed',
  ): void => {
    pendingEntityFieldFocus = { fieldId, field };
    rerender();
  };

  const rerenderOperationArgument = (
    rowId: string,
    argIndex: number | null,
  ): void => {
    pendingOperationArgumentFocus = { rowId, argIndex };
    rerender();
  };

  const rerenderPackSetting = (field: 'authModel'): void => {
    pendingPackSettingFocus = field;
    rerender();
  };

  const rerender = (): void => {
    if (disposed) return;
    const activeBeforeRender = (
      doc.activeElement as HTMLElement | null | undefined
    ) ?? null;
    const restoreHeadingFocus = activeBeforeRender === routeHeading;
    const restoreActiveField = activeBeforeRender === null
      ? null
      : captureFieldFocus(activeBeforeRender);
    if (activeBeforeRender === saveBtn) {
      pendingSaveFocus = true;
      pendingWorkflowFocus = null;
    } else if (activeBeforeRender === previewBtn) {
      pendingSaveFocus = false;
      pendingWorkflowFocus = 'preview';
    } else if (activeBeforeRender === installBtn) {
      pendingSaveFocus = false;
      pendingWorkflowFocus = 'install';
    } else if (
      activeBeforeRender !== null
      && activeBeforeRender !== doc.body
      && activeBeforeRender.isConnected
    ) {
      pendingSaveFocus = false;
      pendingWorkflowFocus = null;
    }
    if (activeBeforeRender === newDraftBtn) {
      pendingNewDraftFocus = true;
    } else if (
      activeBeforeRender !== null
      && activeBeforeRender !== doc.body
      && activeBeforeRender.isConnected
    ) {
      pendingNewDraftFocus = false;
    }
    if (activeBeforeRender === draftRefreshBtn) {
      pendingDraftRefreshFocus = true;
    } else if (
      activeBeforeRender !== null
      && activeBeforeRender !== doc.body
      && activeBeforeRender.isConnected
    ) {
      pendingDraftRefreshFocus = false;
    }
    previewBtn = undefined;
    installBtn = undefined;
    clearChildren(content);
    renderedOperationFocusTargets = new Map();
    renderedEntityFieldFocusTargets = new Map();

    // Slim sticky header: title + draft picker (Save lives in the picker
    // actions) + the status / review chip + the section nav. Identity,
    // metrics, and review detail live in non-sticky content below.
    const topbar = doc.createElement('section');
    topbar.className = 'ingredient-builder-topbar';
    topbar.setAttribute('aria-label', 'Pack editor buttons');

    const header = doc.createElement('div');
    header.className = 'ingredient-builder-header';
    const eyebrow = appendText(doc, header, 'span', 'Ingredient workspace');
    eyebrow.className = 'ingredient-builder-eyebrow';
    routeHeading = appendText(doc, header, 'h1', 'Pack editor');
    routeHeading.setAttribute(INGREDIENT_BUILDER_HEADING_ATTR, '');
    routeHeading.tabIndex = -1;
    const subtitle = appendText(
      doc,
      header,
      'span',
      'Build something reusable, check it, and install it.',
    );
    subtitle.className = 'ingredient-builder-subtitle';
    topbar.appendChild(header);

    const pickerRefs = renderDraftPicker(
      doc, state, topbar, loadDraft, newDraft, () => refreshDrafts(), saveDraft, rerender,
    );
    saveBtn = pickerRefs.saveBtn;
    draftRefreshBtn = pickerRefs.refreshBtn;
    newDraftBtn = pickerRefs.newBtn;
    const statusRefs = renderStatusLine(doc, state, topbar);

    // Section nav: the mini-app menu, INSIDE the sticky topbar so switching
    // sections never requires scrolling back up. Every section renders (its
    // controls stay in the DOM, so attribute-based tests + cross-section state
    // updates don't depend on the active view); only the active one is shown.
    const nav = doc.createElement('nav');
    nav.className = 'ingredient-builder-nav';
    nav.setAttribute('data-recued-scroll-rail', '');
    nav.setAttribute('aria-label', 'Parts of the Pack editor');
    nav.setAttribute('role', 'tablist');
    nav.setAttribute('aria-orientation', 'horizontal');
    const focusSectionTab = (id: SectionId): void => {
      const next = host.querySelector?.(
        `[${INGREDIENT_BUILDER_SECTION_NAV_ATTR}="${id}"]`,
      ) as { focus?: (options?: FocusOptions) => void } | null | undefined;
      next?.focus?.({ preventScroll: true });
    };
    for (const [sectionIndex, entry] of SECTIONS.entries()) {
      const active = state.activeSection === entry.id;
      const tab = makeButton(doc, entry.label, 'secondary', 'sm', () => {
        if (state.activeSection === entry.id) return;
        state.activeSection = entry.id;
        rerender();
        focusSectionTab(entry.id);
      });
      tab.className += active
        ? ' ingredient-builder-nav-tab ingredient-builder-nav-tab--active'
        : ' ingredient-builder-nav-tab';
      tab.setAttribute(INGREDIENT_BUILDER_SECTION_NAV_ATTR, entry.id);
      tab.setAttribute('id', `ingredient-builder-tab-${entry.id}`);
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', `ingredient-builder-panel-${entry.id}`);
      tab.setAttribute('aria-selected', String(active));
      tab.setAttribute('tabindex', active ? '0' : '-1');
      tab.addEventListener('keydown', (event) => {
        const key = (event as KeyboardEvent).key;
        let nextIndex: number | null = null;
        if (key === 'ArrowRight') nextIndex = (sectionIndex + 1) % SECTIONS.length;
        if (key === 'ArrowLeft') {
          nextIndex = (sectionIndex - 1 + SECTIONS.length) % SECTIONS.length;
        }
        if (key === 'Home') nextIndex = 0;
        if (key === 'End') nextIndex = SECTIONS.length - 1;
        if (nextIndex === null) return;
        event.preventDefault();
        const nextSection = SECTIONS[nextIndex]!;
        state.activeSection = nextSection.id;
        rerender();
        focusSectionTab(nextSection.id);
      });
      if (active) tab.setAttribute('aria-current', 'page');
      nav.appendChild(tab);
    }
    topbar.appendChild(nav);
    content.appendChild(topbar);
    topbarEl = topbar;

    // The in-place topbar sync for focused field edits (markDirty without a
    // rerender): flip the dirty cue, relabel Save (and promote it back to the
    // primary look), clear the stale status, downgrade the review chip. While
    // a save is IN FLIGHT the busy label + progress status stay put — the
    // guarded button must not read as an actionable 'Save', and the
    // completion (epoch-checked) reports the pending edits.
    topbarSyncByState.set(state, () => {
      pickerRefs.dirtyCue.textContent = draftHasUnsavedContent(state) ? 'Unsaved' : '';
      statusRefs.chip.setAttribute('data-state', reviewChipState(state));
      statusRefs.chip.textContent = reviewBannerText(state.review, state.reviewIssues);
      if (saveInFlight) return;
      pickerRefs.saveBtn.textContent = saveButtonLabel(state);
      pickerRefs.saveBtn.className = pickerRefs.saveBtn.className
        .split(' ')
        .map((cls) =>
          cls === 'rx-btn-secondary' ? 'rx-btn-primary'
          : cls === 'btn-secondary' ? 'btn-primary'
          : cls)
        .join(' ');
      statusRefs.status.textContent = state.status;
      statusRefs.status.removeAttribute?.('data-state');
    });

    // Validation issues — host-level, right under the sticky topbar, so a
    // failed save is REASONS-visible from whichever section the user saved in
    // (they used to render inside the Overview view only, invisible from the
    // other four sections). Gate and renderer share visibleReviewIssues, so a
    // non-empty panel is guaranteed whenever this renders.
    issuesPanel = undefined;
    if (visibleReviewIssues(state).length > 0) {
      const issuesHost = doc.createElement('div');
      issuesHost.className = 'ingredient-builder-review-host';
      renderReviewDetail(doc, state, issuesHost, 'issues');
      content.appendChild(issuesHost);
      issuesPanel = issuesHost;
    }

    // One container per section; inactive views render but carry `is-hidden`.
    const view = (id: SectionId): HTMLElement => {
      const el = doc.createElement('section');
      el.className = state.activeSection === id
        ? 'ingredient-builder-section-view'
        : 'ingredient-builder-section-view is-hidden';
      el.setAttribute(INGREDIENT_BUILDER_SECTION_VIEW_ATTR, id);
      el.setAttribute('id', `ingredient-builder-panel-${id}`);
      el.setAttribute('role', 'tabpanel');
      el.setAttribute('aria-labelledby', `ingredient-builder-tab-${id}`);
      if (state.activeSection !== id) el.setAttribute('hidden', '');
      content.appendChild(el);
      return el;
    };

    // ── Overview — identity (title / slug) + metrics + review detail.
    const overview = view('overview');
    appendSectionIntro(
      doc,
      overview,
      'Draft overview',
      'Name the Pack, and see at a glance how ready its operations, fields, privacy and connections are.',
    );
    const identity = doc.createElement('div');
    identity.className = 'ingredient-builder-card ingredient-builder-identity-card';

    const titleWrap = doc.createElement('div');
    titleWrap.className = 'ingredient-builder-field';
    const titleLabel = doc.createElement('label');
    titleLabel.textContent = 'Draft title';
    titleWrap.appendChild(titleLabel);
    const titleInput = makeTextInput(doc, state.title, 'title', (next) => {
      state.title = next;
      markDirty(state);
    });
    titleInput.setAttribute(INGREDIENT_BUILDER_TITLE_ATTR, '');
    titleInput.setAttribute('aria-label', 'Draft title');
    titleWrap.appendChild(titleInput);
    identity.appendChild(titleWrap);

    const slugWrap = doc.createElement('div');
    slugWrap.className = 'ingredient-builder-field';
    const slugLabel = doc.createElement('label');
    slugLabel.textContent = 'Slug';
    slugWrap.appendChild(slugLabel);
    const slugInput = makeTextInput(doc, state.slug, 'slug', (next) => {
      const priorDefaultPackSlug = packSlugFor(state.slug);
      const priorDefaultDescription = defaultPackDescription(state.slug);
      state.slug = next;
      if (state.packSlug.trim() === priorDefaultPackSlug) {
        state.packSlug = packSlugFor(next);
      }
      if (state.packDescription.trim() === priorDefaultDescription) {
        state.packDescription = defaultPackDescription(next);
      }
      markDirty(state);
    });
    slugInput.setAttribute(INGREDIENT_BUILDER_SLUG_ATTR, '');
    slugInput.setAttribute('aria-label', 'Slug');
    slugWrap.appendChild(slugInput);
    identity.appendChild(slugWrap);
    overview.appendChild(identity);

    renderEditorOverview(doc, state, overview);
    renderReviewDetail(doc, state, overview, 'privacy');

    // ── Setup — the connector. renderPackSettings('setup') owns it all: auth
    //    model + (api: base URL / connection / dialects | cli: binary + probe).
    renderedPackSettingFocusTargets = renderPackSettings(
      doc,
      state,
      view('setup'),
      rerender,
      'setup',
      rerenderPackSetting,
    );

    // ── Operations — family-grouped op cards.
    const operationsView = view('operations');
    appendSectionIntro(
      doc,
      operationsView,
      'Operations',
      'Say what this Pack may do, and when each group of things should ask you first.',
    );
    const operations = doc.createElement('section');
    operations.className = 'ingredient-builder-editor-section ingredient-builder-card';
    const operationsHeader = appendSectionHeader(
      doc,
      operations,
      'Operation families',
      plural(authoredOperationRows(state.rows).length, 'operation'),
    );
    const add = makeButton(doc, 'Add operation', 'secondary', 'sm', () => {
      operationSearch = '';
      const id = `row-${nextRowId}`;
      state.rows.push(defaultRow(id));
      nextRowId += 1;
      markDirty(state);
      pendingAddedOperationFocusId = id;
      rerender();
    });
    add.setAttribute(INGREDIENT_BUILDER_ADD_ROW_ATTR, '');
    operationsHeader.appendChild(add);
    renderTable(
      doc,
      state,
      operations,
      rerender,
      renderedOperationFocusTargets,
      removeOperation,
      rerenderOperationField,
      rerenderOperationArgument,
    );
    appendSearch(operations, 'operations');
    operationsView.appendChild(operations);

    // ── Data fields — entity schema.
    const dataView = view('data');
    appendSectionIntro(
      doc,
      dataView,
      'Data fields',
      'Say which records these read or write, including their other names and anything private.',
    );
    const entitySection = doc.createElement('section');
    entitySection.className = 'ingredient-builder-editor-section ingredient-builder-card';
    const entityHeader = appendSectionHeader(
      doc,
      entitySection,
      'Entity fields',
      plural(state.entityFields.length, 'field'),
    );
    const addField = makeButton(doc, 'Add field', 'secondary', 'sm', () => {
      fieldSearch = '';
      const id = `field-${nextFieldId}`;
      state.entityFields.push(defaultEntityField(id));
      nextFieldId += 1;
      markDirty(state);
      pendingAddedEntityFieldFocusId = id;
      rerender();
    });
    addField.setAttribute(INGREDIENT_BUILDER_ENTITY_ADD_ROW_ATTR, '');
    addEntityFieldBtn = addField;
    entityHeader.appendChild(addField);
    renderEntityFieldTable(
      doc,
      state,
      entitySection,
      rerender,
      renderedEntityFieldFocusTargets,
      removeEntityField,
      rerenderEntityField,
    );
    appendSearch(entitySection, 'fields');
    dataView.appendChild(entitySection);

    // ── Publish — pack metadata + (once validated) preview / install.
    const publishView = view('publish');
    renderPackSettings(doc, state, publishView, rerender, 'publish');
    if (!isWorkflowReady(state)) {
      // The Preview/Install workflow only renders once reviewed — say WHY it's
      // absent instead of ending the section silently.
      const hint = doc.createElement('p');
      hint.className = 'ingredient-builder-publish-hint';
      hint.textContent = `${
        installBlockedReason(state) ?? 'Save and check this draft'
      } — Preview and Install unlock once the server review passes.`;
      publishView.appendChild(hint);
    }
    if (isWorkflowReady(state)) {
      const workflowRefs = renderWorkflow(
        doc,
        state,
        publishView,
        () => {
          previewGeneration += 1;
          clearPreviewState(state);
        },
        runPreview,
        runInstall,
        installFlight !== null,
        installFlight?.draftGeneration === draftGeneration,
        (tier) => {
          // D-182 §7.1 (inc 5b.2) — record the owner's Access pick + re-render. No
          // offered-tier guard needed: the picker only renders the tiers in
          // `grantModel.accessOptions`, so a real change event carries an offered
          // tier; a connection-backed draft is the only path that reaches here.
          state.installAccess = tier;
          rerender();
        },
        (audience) => {
          state.installAudience = resolveInstallAudienceSelection(audience);
          rerender();
        },
      );
      previewBtn = workflowRefs.previewBtn;
      installBtn = workflowRefs.installBtn;
    }
    if (restoreHeadingFocus) {
      routeHeading.focus({ preventScroll: true });
    }
    if (pendingSaveFocus && saveBtn !== undefined && !saveBtn.disabled) {
      pendingSaveFocus = false;
      saveBtn.focus({ preventScroll: true });
    }
    if (pendingNewDraftFocus && newDraftBtn !== undefined) {
      pendingNewDraftFocus = false;
      newDraftBtn.focus({ preventScroll: true });
    }
    if (pendingDraftRefreshFocus && draftRefreshBtn !== undefined) {
      pendingDraftRefreshFocus = false;
      draftRefreshBtn.focus({ preventScroll: true });
    }
    if (pendingWorkflowFocus !== null) {
      const target = pendingWorkflowFocus === 'preview'
        ? previewBtn
        : installBtn;
      if (target !== undefined && !target.disabled) {
        pendingWorkflowFocus = null;
        target.focus({ preventScroll: true });
      }
    }
    if (restoreActiveField !== null) restoreFieldFocus(restoreActiveField);
    if (pendingAddedOperationFocusId !== null) {
      const id = pendingAddedOperationFocusId;
      pendingAddedOperationFocusId = null;
      const target = renderedOperationFocusTargets.get(id);
      target?.firstField.focus({ preventScroll: true });
      target?.card.scrollIntoView?.({ block: 'nearest' });
    }
    if (pendingRemovedOperationFocusId !== null) {
      const id = pendingRemovedOperationFocusId;
      pendingRemovedOperationFocusId = null;
      renderedOperationFocusTargets.get(id)?.summary.focus({ preventScroll: true });
    }
    if (pendingAddedEntityFieldFocusId !== null) {
      const id = pendingAddedEntityFieldFocusId;
      pendingAddedEntityFieldFocusId = null;
      const target = renderedEntityFieldFocusTargets.get(id);
      target?.firstField.focus({ preventScroll: true });
      target?.row.scrollIntoView?.({ block: 'nearest' });
    }
    if (pendingRemovedEntityFieldFocus !== null) {
      const pending = pendingRemovedEntityFieldFocus;
      pendingRemovedEntityFieldFocus = null;
      const target = pending.fieldId === null
        ? addEntityFieldBtn
        : renderedEntityFieldFocusTargets.get(pending.fieldId)?.firstField;
      target?.focus({ preventScroll: true });
    }
    if (pendingOperationFieldFocus !== null) {
      const pending = pendingOperationFieldFocus;
      pendingOperationFieldFocus = null;
      renderedOperationFocusTargets.get(pending.rowId)?.[pending.field]
        .focus({ preventScroll: true });
    }
    if (pendingEntityFieldFocus !== null) {
      const pending = pendingEntityFieldFocus;
      pendingEntityFieldFocus = null;
      renderedEntityFieldFocusTargets.get(pending.fieldId)?.[pending.field]
        .focus({ preventScroll: true });
    }
    if (pendingOperationArgumentFocus !== null) {
      const pending = pendingOperationArgumentFocus;
      pendingOperationArgumentFocus = null;
      const targets = renderedOperationFocusTargets.get(pending.rowId)?.arguments;
      const target = pending.argIndex === null
        ? targets?.addButton
        : targets?.keyInputs[pending.argIndex];
      target?.focus({ preventScroll: true });
      target?.scrollIntoView?.({ block: 'nearest' });
    }
    if (pendingPackSettingFocus !== null) {
      const field = pendingPackSettingFocus;
      pendingPackSettingFocus = null;
      renderedPackSettingFocusTargets[field]?.focus({ preventScroll: true });
    }
  };

  rerender();
  if (focusHeadingOnMount) {
    routeHeading?.focus?.({ preventScroll: true });
  }
  refreshDrafts();

  // Edit→Kitchen deep-link arrival — an `initialDraftId` WITHOUT an
  // `initialBody` means "open this draft" (`#kitchen/pack/<draft_id>`). Self-
  // load it through the same path the in-page picker uses (fetch + decompose)
  // so a refreshed / shared URL restores the selection. A caller that supplies
  // an `initialBody` (the draft is already in hand) skips this.
  if (options.initialDraftId !== undefined && options.initialBody === undefined) {
    loadDraft(options.initialDraftId);
  }

  // Cmd/Ctrl+S saves the draft — scoped and gated like the recipe editor:
  // only when focus is on this editor (or nowhere in particular — persistent
  // surfaces like the chat drawer must not trigger it), flushing the
  // in-progress field first (commit handlers run on 'change'/'input' blur),
  // and only when there is UNSAVED content (a clean reflex-save is a no-op).
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.isComposing) return;
    if (!(event.metaKey || event.ctrlKey)) return;
    if (event.key !== 's' && event.key !== 'S') return;
    const target = event.target as Node | null;
    const scoped =
      target === null
      || target === (doc as Partial<Document>).body
      || typeof host.contains !== 'function'
      || host.contains(target);
    if (!scoped) return;
    event.preventDefault();
    if (state.saveStage === 'saving' || state.saveStage === 'reviewing') return;
    const active = (doc as Partial<Document>).activeElement as
      | (Node & { blur?: () => void })
      | null
      | undefined;
    active?.blur?.();
    if (!draftHasUnsavedContent(state)) return;
    saveDraft();
  };
  const docEvents = doc as Partial<
    Pick<Document, 'addEventListener' | 'removeEventListener'>
  >;
  if (typeof docEvents.addEventListener === 'function') {
    docEvents.addEventListener('keydown', onKeydown as EventListener);
  }

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      if (typeof docEvents.removeEventListener === 'function') {
        docEvents.removeEventListener('keydown', onKeydown as EventListener);
      }
      topbarSyncByState.delete(state);
      host.remove();
    },
    hasUnsavedChanges() {
      // In-flight counts: the rpc may not be transmitted/acked yet, so
      // leaving mid-save could still lose the edits being saved.
      return saveInFlight || draftHasUnsavedContent(state);
    },
    hasInFlightWork() {
      return saveInFlight || installFlight !== null;
    },
    getState() {
      return {
        ...(state.draftId !== undefined ? { draftId: state.draftId } : {}),
        title: state.title,
        slug: state.slug,
        connection: state.connection,
        ingredientKind: state.ingredientKind,
        authModel: state.authModel,
        cliTool: state.cliTool,
        cliReadinessProbe: state.cliReadinessProbe,
        packSlug: state.packSlug,
        packPublisher: state.packPublisher,
        packKind: state.packKind,
        packServiceKind: state.packServiceKind,
        packDescription: state.packDescription,
        packTagsText: state.packTagsText,
        packDependenciesText: state.packDependenciesText,
        rows: state.rows.map((row) => ({ ...row })),
        entityFields: state.entityFields.map((row) => ({ ...row })),
        saveStage: state.saveStage,
        status: state.status,
        ...(state.review !== undefined ? { review: state.review } : {}),
        reviewIssues: [...state.reviewIssues],
        drafts: state.drafts.map((draft) => ({ ...draft })),
        draftsStage: state.draftsStage,
        draftsError: state.draftsError,
        previewOperationKey: state.previewOperationKey,
        previewArgsText: state.previewArgsText,
        previewStage: state.previewStage,
        ...(state.preview !== undefined ? { preview: state.preview } : {}),
        previewError: state.previewError,
        installStage: state.installStage,
        ...(state.installResult !== undefined ? { installResult: state.installResult } : {}),
        installMessage: state.installMessage,
        installWarnings: [...state.installWarnings],
        installAccess: state.installAccess,
        installScope: state.installAudience.all_customers
          ? state.installAudience.all_other_contracts ? 'all_contracts' : 'all_customers'
          : state.installAudience.all_other_contracts ? 'all_other_contracts' : 'owner',
        installAudience: resolveInstallAudienceSelection(state.installAudience),
      };
    },
    buildDraftBody() {
      return buildComposition(state);
    },
  };
};
