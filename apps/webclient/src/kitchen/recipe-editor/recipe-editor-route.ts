/** Recipe editor — the visible half of the Kitchen recipe inspector (D-148
 *  salvage, Step 3 / slice 3).
 *
 *  This is the imperative-DOM step inspector that the pure helpers in
 *  `./step-utils.js` + `./step-logic.js` back. It mirrors the pack editor
 *  (`../ingredient-builder/operation-family-table.ts`) one-for-one: a single
 *  mutable `state`, a full `rerender()` from the working `RecipeDefinition`,
 *  the `makeButton` primitive, the card/field-grid CSS, and the canonical
 *  `@recued/ui-shared` design tokens (no raw hex; light + dark; responsive
 *  12–24px spacing; card r14 / control r9; sentence-case labels; accent rings).
 *
 *  Callers are INJECTED (`validateCaller` / `saveCaller`) — wiring this into
 *  `webclient-bootstrap` (a `recipe.validate` / `recipe.save` `Conn`) is a
 *  later slice. The route holds a working recipe and never reaches the wire
 *  itself.
 *
 *  Step kinds — all fully editable (the D-182 absorb relaxed the `recipe.save`
 *  seam to accept inline op-steps; the dispatch path lowers + runs them):
 *    - transform / ingredient / guard — discriminator + schema-/manifest-derived
 *      fields.
 *    - op — op id, vendor-neutral args (add / edit / remove), the per-operand
 *      connection slot, and `foreach`. A CRM op needs a `type:'connection'`
 *      recipe variable for its slot (declared in a later slice) or the save seam
 *      rejects it as slotless — the notice points the user there.
 *  Every kind also carries a `skip_when` / `fail_on` condition builder. */

import type {
  LocalRecipeWebhookStatus,
  RecipeDefinition,
  RecipeEventTrigger,
  RecipeWebhookRequirement,
  PrefetchOpStep,
  RecipeStep,
  Condition,
  ConditionOp,
  VariableDefault,
  WebhookIngressBindingSelection,
  WebhookIngressView,
} from '@recued/contracts';
import {
  FORM_RESPONSE_ON_SHORTHAND,
  parseCondition,
  UNARY_OPS,
  validateRecipeEventTriggerEntry,
  WEBHOOK_PROFILE_REGISTRY,
} from '@recued/contracts';
import { TRANSFORM_SCHEMAS } from '@recued/transforms';
import { PRIMITIVE_STYLES } from '@recued/ui-shared/primitives';

import {
  applyFieldToStep,
  createBlankOpStep,
  createBlankStep,
  formatCSV,
  formatCondition,
  generateStepId,
  parseCSV,
  parseOpArgValue,
  parseStepFieldValue,
  removeStepById,
  renameStepIdInRecipe,
  reorderSteps,
  validateStepIdRename,
} from './step-utils.js';
import {
  CONDITION_OP_LABELS,
  detectStepFieldType,
  detectStepKind,
  enumerateIngredientInputs,
  enumerateOpArgs,
  enumerateTransformParams,
  getStepDiscriminator,
  type StepFieldType,
  type StepKind,
} from './step-logic.js';
import {
  FORM_RESPONSE_EVENT_RECORD_ID_REF,
  FORM_RESPONSE_READER_OP,
} from './form-response-automation-seed.js';
import { humanizeRpcError } from '../../shell/rpc-error-copy.js';

// ────────────────────────────────────────────────────────────────
// Test/route attribute hooks (mirror INGREDIENT_BUILDER_*_ATTR)
// ────────────────────────────────────────────────────────────────

export const RECIPE_EDITOR_STYLES_MARKER = 'data-recued-recipe-editor-styles';
export const RECIPE_EDITOR_ROUTE_ATTR = 'data-recued-recipe-editor-route';
/** Programmatic route-entry target; focus announces the editor without placing
 *  a caret in a mutable recipe field. */
export const RECIPE_EDITOR_HEADING_ATTR = 'data-recued-recipe-editor-heading';
/** Each step card — value is the step id. */
export const RECIPE_EDITOR_ROW_ATTR = 'data-recued-recipe-editor-step';
/** Each editable field — value is a `data-field` key like `param:foo`,
 *  `input:bar`, `skip_when`, `fail_on`, `step_id`. */
export const RECIPE_EDITOR_FIELD_ATTR = 'data-recued-recipe-editor-field';
export const RECIPE_EDITOR_ADD_KIND_ATTR = 'data-recued-recipe-editor-add-kind';
export const RECIPE_EDITOR_ADD_NAME_ATTR = 'data-recued-recipe-editor-add-name';
export const RECIPE_EDITOR_ADD_ATTR = 'data-recued-recipe-editor-add';
export const RECIPE_EDITOR_REMOVE_ATTR = 'data-recued-recipe-editor-remove';
/** Per-step "move up" / "move down" reorder buttons — value is the step id. */
export const RECIPE_EDITOR_MOVE_UP_ATTR = 'data-recued-recipe-editor-move-up';
export const RECIPE_EDITOR_MOVE_DOWN_ATTR = 'data-recued-recipe-editor-move-down';
/** The "+ Skip when" / "+ Fail on" reveal buttons on a step card with no
 *  condition set — value is `<step_id>:<field>`. */
export const RECIPE_EDITOR_COND_ADD_ATTR = 'data-recued-recipe-editor-cond-add';
/** The Steps-header Collapse-all / Expand-all toggle. */
export const RECIPE_EDITOR_COLLAPSE_ALL_ATTR =
  'data-recued-recipe-editor-collapse-all';
export const RECIPE_EDITOR_VALIDATE_ATTR = 'data-recued-recipe-editor-validate';
export const RECIPE_EDITOR_SAVE_ATTR = 'data-recued-recipe-editor-save';
export const RECIPE_EDITOR_RECIPE_ID_ATTR = 'data-recued-recipe-editor-recipe-id';
export const RECIPE_EDITOR_RECIPE_NAME_ATTR = 'data-recued-recipe-editor-recipe-name';
export const RECIPE_EDITOR_STATUS_ATTR = 'data-recued-recipe-editor-status';
export const RECIPE_EDITOR_ISSUES_ATTR = 'data-recued-recipe-editor-issues';
export const RECIPE_EDITOR_ISSUE_ATTR = 'data-recued-recipe-editor-issue';
export const RECIPE_EDITOR_VALID_CHIP_ATTR = 'data-recued-recipe-editor-valid';
export const RECIPE_EDITOR_DIRTY_ATTR = 'data-recued-recipe-editor-dirty';
export const RECIPE_EDITOR_OP_NOTICE_ATTR = 'data-recued-recipe-editor-op-notice';
/** The "new arg name" input in an op-step's Add-arg control. */
export const RECIPE_EDITOR_OP_ARG_NAME_ATTR = 'data-recued-recipe-editor-op-arg-name';
/** The "Add arg" button in an op-step body. */
export const RECIPE_EDITOR_OP_ARG_ADD_ATTR = 'data-recued-recipe-editor-op-arg-add';
/** The per-arg Remove button — value is the arg name. */
export const RECIPE_EDITOR_OP_ARG_REMOVE_ATTR = 'data-recued-recipe-editor-op-arg-remove';
/** The recipe-level Connection-variables / dependencies section. */
export const RECIPE_EDITOR_BINDINGS_ATTR = 'data-recued-recipe-editor-bindings';
/** Each connection-variable row — value is the variable name. */
export const RECIPE_EDITOR_CONN_VAR_ROW_ATTR = 'data-recued-recipe-editor-conn-var';
/** The per-variable Remove button — value is the variable name. */
export const RECIPE_EDITOR_CONN_VAR_REMOVE_ATTR = 'data-recued-recipe-editor-conn-var-remove';
/** The "new connection variable" name input. */
export const RECIPE_EDITOR_CONN_VAR_NAME_ATTR = 'data-recued-recipe-editor-conn-var-name';
/** The "new connection variable" kind select. */
export const RECIPE_EDITOR_CONN_VAR_KIND_ATTR = 'data-recued-recipe-editor-conn-var-kind';
/** The "Add variable" button. */
export const RECIPE_EDITOR_CONN_VAR_ADD_ATTR = 'data-recued-recipe-editor-conn-var-add';
/** Recipe-level warehouse-event subscriptions. */
export const RECIPE_EDITOR_TRIGGERS_ATTR = 'data-recued-recipe-editor-triggers';
/** One event-trigger row — value is its array index. */
export const RECIPE_EDITOR_TRIGGER_ROW_ATTR = 'data-recued-recipe-editor-trigger';
/** Editable form-definition narrowing on the accepted-response preset. */
export const RECIPE_EDITOR_TRIGGER_FORM_ID_ATTR =
  'data-recued-recipe-editor-trigger-form-id';
/** Editable raw warehouse-bus pattern on a custom trigger. */
export const RECIPE_EDITOR_TRIGGER_EVENT_ATTR = 'data-recued-recipe-editor-trigger-event';
/** Per-row remove control — value is its array index. */
export const RECIPE_EDITOR_TRIGGER_REMOVE_ATTR = 'data-recued-recipe-editor-trigger-remove';
/** New-trigger kind picker. */
export const RECIPE_EDITOR_TRIGGER_ADD_KIND_ATTR =
  'data-recued-recipe-editor-trigger-add-kind';
/** New custom-trigger event pattern input. */
export const RECIPE_EDITOR_TRIGGER_ADD_EVENT_ATTR =
  'data-recued-recipe-editor-trigger-add-event';
/** Add-trigger action. */
export const RECIPE_EDITOR_TRIGGER_ADD_ATTR = 'data-recued-recipe-editor-trigger-add';
/** Accepted-response event → full-record reader bridge (`missing` /
 *  `needs-binding` / `ready`). */
export const RECIPE_EDITOR_FORM_RESPONSE_READER_ATTR =
  'data-recued-recipe-editor-form-response-reader';
/** Response-reader action (`add` or explicit `bind`). */
export const RECIPE_EDITOR_FORM_RESPONSE_READER_ACTION_ATTR =
  'data-recued-recipe-editor-form-response-reader-action';
/** Standalone recipe webhook ingress chooser + arm state. */
export const RECIPE_EDITOR_WEBHOOKS_ATTR = 'data-recued-recipe-editor-webhooks';
export const RECIPE_EDITOR_WEBHOOK_SELECT_ATTR =
  'data-recued-recipe-editor-webhook-select';
export const RECIPE_EDITOR_WEBHOOK_ARM_ATTR = 'data-recued-recipe-editor-webhook-arm';
export const RECIPE_EDITOR_WEBHOOK_DISARM_ATTR =
  'data-recued-recipe-editor-webhook-disarm';
export const RECIPE_EDITOR_WEBHOOK_STATUS_ATTR =
  'data-recued-recipe-editor-webhook-status';
export const RECIPE_EDITOR_WEBHOOK_ADD_ATTR = 'data-recued-recipe-editor-webhook-add';
export const RECIPE_EDITOR_WEBHOOK_REMOVE_ATTR =
  'data-recued-recipe-editor-webhook-remove';
/** D-209 #1 Task 3 — the door-authority consent block. Attribute value = the
 * door state (`minted` / `missing` / `refused`) so tests can pin the branch. */
export const RECIPE_EDITOR_WEBHOOK_DOOR_ATTR = 'data-recued-recipe-editor-webhook-door';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface RecipeValidateIssue {
  path?: string;
  message: string;
  severity: string;
}

export interface RecipeValidateResult {
  ok: boolean;
  issues: RecipeValidateIssue[];
}

export interface RecipeSaveResult {
  saved: true;
  recipe_id: string;
  version: number;
  name: string;
  /** D-182 — non-blocking advisories from the save seam (e.g. a Tier-P op whose
   *  pack isn't covered by `depends_on`). The recipe saved; these are surfaced
   *  as `warn`-severity issues. */
  op_warnings?: string[];
  webhook?: LocalRecipeWebhookStatus;
}

export interface RecipeWebhookControl {
  ingresses: readonly WebhookIngressView[];
  initialStatus: LocalRecipeWebhookStatus;
  armCaller: (args: { recipe_id: string }) => Promise<{
    webhook: LocalRecipeWebhookStatus;
  }>;
  disarmCaller: (args: { recipe_id: string }) => Promise<{
    webhook: LocalRecipeWebhookStatus;
  }>;
}

export type RecipeEditorSaveStage =
  | 'idle'
  | 'validating'
  | 'saving'
  | 'saved'
  | 'error';

export interface BootstrapRecipeEditorRouteOptions {
  root: HTMLElement;
  document?: Document;
  validateCaller: (args: { recipe: RecipeDefinition }) => Promise<RecipeValidateResult>;
  saveCaller: (args: {
    recipe: RecipeDefinition;
    publisher_id?: string;
    webhook_bindings?: ReadonlyArray<WebhookIngressBindingSelection>;
  }) => Promise<RecipeSaveResult>;
  /** Present only on the owner Kitchen surface. MCP authoring deliberately has
   * no equivalent arm authority. */
  webhookControl?: RecipeWebhookControl;
  initialRecipe?: RecipeDefinition;
  /** A caller-provided draft that has never been persisted. New-recipe entry
   *  points set this so the shell leave guard protects the seeded work even
   *  before the owner edits a field. Existing loaded recipes leave it false. */
  initialDirty?: boolean;
  /** Post-persist navigation hook. The editor has already recorded the save as
   *  successful before this runs; callers use it to replace a contextual
   *  `new` URL with the canonical installed-recipe URL. */
  onSaved?: (result: RecipeSaveResult) => void;
}

export interface RecipeEditorRoute {
  dispose(): void;
  getRecipe(): RecipeDefinition;
  /** True while the working recipe has edits that navigating away would
   *  discard — the shell's leave-guard seam. */
  hasUnsavedChanges(): boolean;
  /** Validate/save request already dispatched to the source server. */
  hasInFlightWork(): boolean;
}

interface RecipeEditorState {
  recipe: RecipeDefinition;
  saveStage: RecipeEditorSaveStage;
  issues: RecipeValidateIssue[];
  status: string;
  /** A field edit happened since the last SAVE. The label-carries-state pattern
   *  (pack editor): the Save button label, not its disabled flag, tracks
   *  progress so a focused field edit (which calls markDirty WITHOUT a
   *  rerender) never disables the button mid-typing. Only a successful save
   *  clears it — validating doesn't make edits any less unsaved. */
  dirty: boolean;
  /** Step ids whose cards render collapsed (summary only). Survives rerenders;
   *  a fresh (added) step is never in here, so it opens for editing. */
  collapsed: Set<string>;
  /** `<step_id>:<field>` keys whose empty skip_when / fail_on builder is
   *  force-shown (the user clicked "+ Skip when" / "+ Fail on"). A set field
   *  always shows its builder without needing an entry here. */
  openConditions: Set<string>;
  /** Bumped by every edit. A save captures the epoch at dispatch; if edits
   *  landed mid-flight the completion must NOT clear `dirty` — those
   *  keystrokes are not in the saved recipe. */
  editEpoch: number;
}

// ────────────────────────────────────────────────────────────────
// Blank recipe + helpers
// ────────────────────────────────────────────────────────────────

/** A minimal valid `RecipeDefinition` for a fresh editor. Fills every required
 *  field (`version` / `ttl` / `variables` / `prefetch_steps`) so the working
 *  value type-checks; the visible defaults match the spec (`new-recipe`,
 *  "New recipe"). */
const blankRecipe = (): RecipeDefinition => ({
  recipe_id: 'new-recipe',
  version: 1,
  ttl: 300,
  metadata: {
    name: 'New recipe',
    description: '',
    author: '',
    supported_platforms: [],
  },
  variables: {},
  prefetch_steps: [],
  steps: [],
  output: { render: [] },
});

/** The kinds the Add-step control offers. Op-steps are inline-authorable since
 *  the D-182 absorb (the `recipe.save` seam lowers + runs them). */
type AddStepKind = 'transform' | 'ingredient' | 'guard' | 'op';
const ADD_STEP_KINDS: ReadonlyArray<AddStepKind> = [
  'transform',
  'ingredient',
  'guard',
  'op',
];

const TRANSFORM_NAMES: readonly string[] = Object.keys(TRANSFORM_SCHEMAS).sort();

/** Connection-variable kinds (the `connection_kind` facet — an unlisted
 *  ValueHint field accepted by design; see value-hint.ts CONTRACT_GAP). */
const CONNECTION_KINDS = ['api', 'mcp', 'notification'] as const;

const ADD_TRIGGER_KINDS = ['Accepted form response', 'Custom event pattern'] as const;
type AddTriggerKind = (typeof ADD_TRIGGER_KINDS)[number];

/** Build a `type:'connection'` recipe variable. `type` / `connection_kind` are
 *  unlisted ValueHint fields (the structural validator accepts them by design),
 *  so the shape is cast through `unknown`. */
const makeConnectionVar = (label: string, kind: string): VariableDefault =>
  ({
    label,
    type: 'connection',
    connection_kind: kind,
    default: '',
  } as unknown as VariableDefault);

const KIND_PILL_LABEL: Record<StepKind, string> = {
  transform: 'TRANSFORM',
  ingredient: 'INGREDIENT',
  guard: 'GUARD',
  op: 'OP',
};

/** The gated per-step condition fields — the one list every consumer (builder
 *  render, reveal buttons, rename carry-over, removal pruning) shares. */
const CONDITION_FIELDS = ['skip_when', 'fail_on'] as const;

/** Fill the optional list fields the editor reads as if they were required.
 *  ⛔ Only ADDS empty lists — never changes a value the recipe actually
 *  carries, so what the owner saves is what they wrote plus nothing. */
const adoptRecipe = (
  recipe: RecipeDefinition | undefined,
): RecipeDefinition | undefined => {
  if (recipe === undefined) return undefined;
  if (Array.isArray(recipe.prefetch_steps)) return recipe;
  return { ...recipe, prefetch_steps: [] };
};

/** All step ids across prefetch + steps — for rename uniqueness checks. */
const allStepIds = (recipe: RecipeDefinition): string[] => [
  // ⚠ Same optional-field hazard as the Prefetch section guard below: the key
  // is absent on a valid recipe, and unguarded this threw on every rename.
  ...(recipe.prefetch_steps ?? []).map((s) => s.id),
  ...recipe.steps.map((s) => s.id),
];

/** Names of the recipe's `type:'connection'` variables — the legal op-step
 *  connection slots. (`'connection'` is an unlisted ValueHint type accepted by
 *  design.) The slot UI to DECLARE these lands in a later slice; until then this
 *  surfaces any that a loaded recipe already carries so the op body offers a
 *  picker instead of free text. */
const connectionVarNames = (recipe: RecipeDefinition): string[] =>
  Object.entries(recipe.variables)
    .filter(
      ([, v]) =>
        v !== null
        && typeof v === 'object'
        && !Array.isArray(v)
        && (v as { type?: unknown }).type === 'connection',
    )
    .map(([name]) => name);

/** Coerce a `skip_when` / `fail_on` field (string | Condition | undefined) into
 *  the inline-string form the condition builder edits. Object-form conditions
 *  serialize to a non-empty JSON string, which the renderer shows read-only. */
const conditionFieldString = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return JSON.stringify(value);
};

const isObjectCondition = (value: unknown): value is Condition =>
  value !== null
  && typeof value === 'object'
  && typeof (value as { field?: unknown }).field === 'string';

const serializeValue = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  if (value === null) return 'null';
  return JSON.stringify(value);
};

const errorMessage = (error: unknown): string =>
  humanizeRpcError(error);

const plural = (count: number, singular: string): string =>
  `${count} ${singular}${count === 1 ? '' : 's'}`;

// ────────────────────────────────────────────────────────────────
// Styles — token-only, sibling of the pack editor sheet
// ────────────────────────────────────────────────────────────────

export const RECIPE_EDITOR_STYLES = `
[${RECIPE_EDITOR_ROUTE_ATTR}] {
  box-sizing: border-box;
  max-width: 1200px;
  margin: 0 auto;
  padding: 20px 24px 40px;
  color: var(--fg);
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-topbar {
  position: sticky;
  top: 12px;
  z-index: 5;
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  align-items: center;
  justify-content: space-between;
  margin: 0 0 24px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--surface);
  box-shadow: 0 8px 24px rgba(24, 24, 27, 0.06), 0 1px 2px rgba(24, 24, 27, 0.04);
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-header {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  align-items: end;
  flex: 1 1 620px;
  min-width: 0;
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-heading {
  display: grid;
  gap: 2px;
  align-self: center;
  flex: 0 0 170px;
  min-width: 0;
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-eyebrow {
  color: var(--accent);
  font-size: 10px;
  font-weight: 750;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-subtitle {
  color: var(--fg-muted);
  font-size: 11px;
  line-height: 1.35;
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-header .recipe-editor-field {
  flex: 1 1 200px;
  min-width: 180px;
  max-width: 320px;
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  justify-content: flex-end;
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-statusbar {
  flex-basis: 100%;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
[${RECIPE_EDITOR_ROUTE_ATTR}] h1 {
  margin: 0;
  font-size: 21px;
  line-height: 1.15;
  font-weight: 720;
  letter-spacing: -0.02em;
  color: var(--fg-strong);
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-field {
  display: grid;
  gap: 4px;
  min-width: 160px;
}
[${RECIPE_EDITOR_ROUTE_ATTR}] label {
  font-size: 12px;
  color: var(--fg-muted);
  font-weight: 600;
}
[${RECIPE_EDITOR_ROUTE_ATTR}] input,
[${RECIPE_EDITOR_ROUTE_ATTR}] select,
[${RECIPE_EDITOR_ROUTE_ATTR}] textarea {
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
[${RECIPE_EDITOR_ROUTE_ATTR}] input:focus-visible,
[${RECIPE_EDITOR_ROUTE_ATTR}] select:focus-visible,
[${RECIPE_EDITOR_ROUTE_ATTR}] textarea:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
  border-color: var(--accent);
}
[${RECIPE_EDITOR_ROUTE_ATTR}] textarea {
  min-height: 58px;
  resize: vertical;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  line-height: 1.35;
}
[${RECIPE_EDITOR_ROUTE_ATTR}] [readonly],
[${RECIPE_EDITOR_ROUTE_ATTR}] [disabled] {
  background: var(--surface-sunk);
  color: var(--fg-muted);
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-section {
  display: grid;
  gap: 14px;
  margin-top: 20px;
  padding: 20px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--surface);
  box-shadow: 0 1px 2px rgba(24, 24, 27, 0.035);
}
[${RECIPE_EDITOR_WEBHOOKS_ATTR}] .recipe-editor-webhook-row {
  display: grid;
  grid-template-columns: minmax(150px, .7fr) minmax(240px, 1.3fr);
  gap: 10px;
  align-items: end;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
}
[${RECIPE_EDITOR_WEBHOOKS_ATTR}] .recipe-editor-webhook-row code {
  overflow-wrap: anywhere;
  color: var(--fg-muted);
  font-size: 12px;
}
[${RECIPE_EDITOR_WEBHOOKS_ATTR}] .recipe-editor-webhook-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
[${RECIPE_EDITOR_WEBHOOK_STATUS_ATTR}] { color: var(--fg-muted); font-size: 12px; }
[${RECIPE_EDITOR_WEBHOOK_DOOR_ATTR}] {
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  display: grid;
  gap: 6px;
}
[${RECIPE_EDITOR_WEBHOOK_DOOR_ATTR}] p { margin: 0; font-size: 12px; }
[${RECIPE_EDITOR_WEBHOOK_DOOR_ATTR}] .recipe-editor-webhook-door-lede {
  font-weight: 650;
  color: var(--fg-strong);
}
[${RECIPE_EDITOR_WEBHOOK_DOOR_ATTR}] ul {
  margin: 0;
  padding-left: 18px;
  display: grid;
  gap: 2px;
}
[${RECIPE_EDITOR_WEBHOOK_DOOR_ATTR}] li { font-size: 12px; }
[${RECIPE_EDITOR_WEBHOOK_DOOR_ATTR}] code { overflow-wrap: anywhere; }
[${RECIPE_EDITOR_WEBHOOK_DOOR_ATTR}] .recipe-editor-webhook-door-help {
  color: var(--fg-muted);
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-section-header {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-section-header > .recipe-editor-section-meta {
  margin-right: auto;
}
[${RECIPE_EDITOR_ROUTE_ATTR}] h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--fg-strong);
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-section-meta {
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
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-add {
  flex: 1 0 100%;
  display: grid;
  gap: 10px;
  align-items: end;
  box-sizing: border-box;
  margin-top: 4px;
  padding: 12px;
  border: 1px dashed var(--border-strong);
  border-radius: 10px;
  background: var(--surface-sunk);
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-add--step {
  grid-template-columns: minmax(150px, 0.8fr) minmax(150px, 0.8fr) minmax(220px, 1fr) auto;
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-add--compact {
  grid-template-columns: minmax(180px, 0.8fr) minmax(260px, 1.2fr) auto;
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-add--compact > .rx-btn {
  min-height: 38px;
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-add-copy {
  display: grid;
  gap: 3px;
  align-self: center;
  min-width: 0;
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-add-copy strong {
  color: var(--fg-strong);
  font-size: 13px;
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-add-copy span {
  color: var(--fg-muted);
  font-size: 11px;
  line-height: 1.35;
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-step-card {
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
  overflow: hidden;
  transition: border-color 120ms ease, box-shadow 120ms ease;
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-step-card:hover {
  border-color: var(--border-strong);
  box-shadow: 0 5px 16px rgba(24, 24, 27, 0.055);
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-step-summary {
  list-style: none;
  cursor: pointer;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 12px 16px;
  transition: background 120ms ease;
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-step-summary:hover {
  background: var(--surface-sunk);
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-step-summary::before {
  content: "▸";
  flex: 0 0 auto;
  color: var(--fg-muted);
  font-size: 12px;
  transform-origin: center;
  transition: transform 120ms ease;
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-step-card[open] > .recipe-editor-step-summary::before {
  transform: rotate(90deg);
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-step-summary::-webkit-details-marker {
  display: none;
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-step-summary:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-step-card[open] > .recipe-editor-step-summary {
  border-bottom: 1px solid var(--border);
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-step-summary .rx-btn {
  flex: 0 0 auto;
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-step-actions {
  display: inline-flex;
  flex: 0 0 auto;
  gap: 6px;
  align-items: center;
  margin-left: auto;
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-step-actions .rx-btn {
  min-width: 30px;
  min-height: 30px;
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-step-id {
  flex: 0 1 200px;
  min-width: 140px;
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-step-id input {
  min-height: 28px;
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-step-disc {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12px;
  color: var(--fg-subtle);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-kind-pill {
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
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-step-body {
  display: grid;
  gap: 16px;
  padding: 16px;
  background: var(--surface-sunk);
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-field-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
  align-items: end;
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-field-grid .span-full {
  grid-column: 1 / -1;
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-field-checkbox {
  display: inline-flex;
  gap: 8px;
  align-items: center;
  min-height: 34px;
  color: var(--fg);
  font-size: 13px;
  font-weight: 600;
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-field-checkbox input {
  width: auto;
  min-height: auto;
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-subsection-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--fg-subtle);
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-condition-row {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 0.9fr) minmax(0, 1.4fr);
  gap: 8px;
  align-items: end;
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-arg-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  align-items: end;
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-arg-add {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: end;
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-arg-add .recipe-editor-field {
  min-width: 200px;
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-conn-var-row {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  padding: 12px 16px;
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-trigger-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 12px;
  align-items: end;
  padding: 12px 16px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-trigger-body {
  display: grid;
  gap: 8px;
  min-width: 0;
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-trigger-title {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  font-size: 13px;
  font-weight: 650;
  color: var(--fg-strong);
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-trigger-code {
  padding: 2px 6px;
  border-radius: 6px;
  background: var(--surface-sunk);
  color: var(--fg-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  font-weight: 500;
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-trigger-fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 8px;
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-trigger-bridge {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  padding: 12px 16px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-sunk);
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-trigger-bridge-copy {
  display: grid;
  gap: 4px;
  flex: 1 1 480px;
  min-width: 0;
  font-size: 12px;
  color: var(--fg-muted);
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-trigger-bridge-copy strong {
  color: var(--fg-strong);
  font-size: 13px;
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-trigger-bridge-copy code {
  overflow-wrap: anywhere;
  color: var(--fg);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-readonly {
  display: block;
  padding: 6px 10px;
  border: 1px dashed var(--border-strong);
  border-radius: 6px;
  color: var(--fg-muted);
  background: var(--surface);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  word-break: break-word;
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-hint {
  font-size: 11px;
  color: var(--fg-subtle);
  line-height: 1.45;
}
[${RECIPE_EDITOR_ROUTE_ATTR}] p.recipe-editor-hint {
  margin: 0;
}
[${RECIPE_EDITOR_OP_NOTICE_ATTR}] {
  display: block;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--fg-muted);
  font-size: 12px;
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-empty {
  display: grid;
  gap: 4px;
  padding: 28px 18px;
  text-align: center;
  border: 1px dashed var(--border-strong);
  border-radius: 12px;
  background: var(--surface-sunk);
  color: var(--fg-muted);
  font-size: 13px;
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-empty strong {
  color: var(--fg-strong);
  font-size: 14px;
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-dirty-dot {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--fg-muted);
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-dirty-dot::before {
  content: "";
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--accent);
}
/* Clean state — hide the whole cue (incl. the ::before dot; textContent is
 * the only dot-less carrier, so :empty means clean). */
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-dirty-dot:empty {
  display: none;
}
/* Visually-hidden live region for validate/save outcome announcements. */
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-sr-announcer {
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
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-cond-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
[${RECIPE_EDITOR_STATUS_ATTR}] {
  color: var(--fg-muted);
  font-size: 13px;
}
[${RECIPE_EDITOR_STATUS_ATTR}][data-state="error"] {
  color: var(--danger);
}
[${RECIPE_EDITOR_VALID_CHIP_ATTR}] {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 3px 8px;
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  color: var(--fg-strong);
  background: var(--surface);
  font-size: 12px;
  font-weight: 600;
}
[${RECIPE_EDITOR_ISSUES_ATTR}] {
  display: grid;
  gap: 6px;
  margin-top: 12px;
  /* revealIssues() scrolls this panel to the viewport top — keep it clear of
   * the sticky topbar overlaying that edge. */
  scroll-margin-top: 120px;
}
[${RECIPE_EDITOR_ISSUE_ATTR}] {
  display: flex;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  font-size: 12px;
}
[${RECIPE_EDITOR_ISSUE_ATTR}][data-severity="error"] {
  border-color: var(--danger);
  background: var(--danger-weak);
  color: var(--danger);
}
[${RECIPE_EDITOR_ISSUE_ATTR}][data-severity="warn"] {
  border-color: var(--border-strong);
  background: var(--warn-bg);
  color: var(--fg);
}
[${RECIPE_EDITOR_ISSUE_ATTR}] .recipe-editor-issue-badge {
  flex: 0 0 auto;
  font-weight: 700;
  font-size: 11px;
}
[${RECIPE_EDITOR_ISSUE_ATTR}] .recipe-editor-issue-path {
  color: var(--fg-subtle);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
@media (max-width: 980px) {
  [${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-topbar {
    position: static;
  }
  [${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-add--step {
    grid-template-columns: minmax(140px, 0.7fr) minmax(180px, 1fr) auto;
  }
  [${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-add--step .recipe-editor-add-copy {
    grid-column: 1 / -1;
  }
}
@media (max-width: 760px) {
  [${RECIPE_EDITOR_ROUTE_ATTR}] {
    padding: 16px 12px 24px;
  }
  [${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-topbar {
    padding: 14px;
    border-radius: 12px;
  }
  [${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-heading {
    flex-basis: 100%;
  }
  [${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-header .recipe-editor-field {
    max-width: none;
  }
  [${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-actions {
    flex: 1 1 100%;
  }
  [${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-section {
    padding: 16px;
  }
  [${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-add {
    grid-template-columns: 1fr;
  }
  [${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-add > .rx-btn {
    width: 100%;
  }
  [${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-step-summary {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    padding: 12px;
  }
  [${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-step-summary::before {
    grid-column: 1;
    grid-row: 1;
  }
  [${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-kind-pill {
    grid-column: 2;
    grid-row: 1;
    justify-self: start;
  }
  [${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-step-actions {
    grid-column: 3;
    grid-row: 1;
  }
  [${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-step-actions .rx-btn {
    min-width: 34px;
    min-height: 34px;
  }
  [${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-step-id {
    grid-column: 2 / -1;
    grid-row: 2;
    width: 100%;
    min-width: 0;
  }
  [${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-step-disc {
    grid-column: 2 / -1;
    grid-row: 3;
    white-space: normal;
  }
  [${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-condition-row {
    grid-template-columns: 1fr;
  }
  [${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-arg-row {
    grid-template-columns: 1fr auto;
  }
  [${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-trigger-row {
    grid-template-columns: 1fr;
  }
}
`;

// ────────────────────────────────────────────────────────────────
// DOM primitives (mirror the pack editor)
// ────────────────────────────────────────────────────────────────

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

const makeTextInput = (
  doc: Document,
  value: string,
  fieldKey: string,
  onInput: (next: string) => void,
): HTMLInputElement => {
  const input = doc.createElement('input');
  input.type = 'text';
  input.value = value;
  input.setAttribute(RECIPE_EDITOR_FIELD_ATTR, fieldKey);
  input.addEventListener('input', () => onInput(input.value));
  return input;
};

/** A monospace multi-line editor for structured values (JSON objects/arrays,
 *  long templates) that would be unreadable in a one-line input. Rows scale
 *  with content, bounded so a huge blob doesn't own the page. */
const makeTextArea = (
  doc: Document,
  value: string,
  fieldKey: string,
  onInput: (next: string) => void,
): HTMLTextAreaElement => {
  const area = doc.createElement('textarea');
  area.value = value;
  area.rows = Math.min(8, Math.max(2, Math.ceil(value.length / 72)));
  area.setAttribute(RECIPE_EDITOR_FIELD_ATTR, fieldKey);
  area.addEventListener('input', () => onInput(area.value));
  return area;
};

/** Values that deserve the multi-line editor: actual JSON containers (the raw
 *  value is the truth — string-sniffing would misread `"[urgent] call"` or a
 *  `{{ref}}`) and anything serialized too long to scan in one line. */
const isBlockValue = (value: unknown, serialized: string): boolean =>
  (typeof value === 'object' && value !== null) || serialized.length > 64;

const makeNumberInput = (
  doc: Document,
  value: string,
  fieldKey: string,
  onInput: (next: string) => void,
): HTMLInputElement => {
  const input = doc.createElement('input');
  input.type = 'number';
  input.value = value;
  input.setAttribute(RECIPE_EDITOR_FIELD_ATTR, fieldKey);
  input.addEventListener('input', () => onInput(input.value));
  return input;
};

const makeSelect = (
  doc: Document,
  value: string,
  options: readonly string[],
  fieldKey: string,
  onChange: (next: string) => void,
): HTMLSelectElement => {
  const select = doc.createElement('select');
  select.value = value;
  select.setAttribute(RECIPE_EDITOR_FIELD_ATTR, fieldKey);
  for (const option of options) {
    const el = doc.createElement('option');
    el.value = option;
    el.textContent = option.length === 0 ? 'none' : option;
    if (option === value) el.selected = true;
    select.appendChild(el);
  }
  select.addEventListener('change', () => onChange(select.value));
  return select;
};

const addField = (
  doc: Document,
  grid: HTMLElement,
  labelText: string,
  child: HTMLElement,
  wide = false,
): void => {
  const field = doc.createElement('div');
  field.className = wide ? 'recipe-editor-field span-full' : 'recipe-editor-field';
  const label = doc.createElement('label');
  label.textContent = labelText;
  if (child.getAttribute('aria-label') === null) {
    child.setAttribute('aria-label', labelText);
  }
  field.appendChild(label);
  field.appendChild(child);
  grid.appendChild(field);
};

const addReadonlyField = (
  doc: Document,
  grid: HTMLElement,
  labelText: string,
  text: string,
): void => {
  const field = doc.createElement('div');
  field.className = 'recipe-editor-field span-full';
  const label = doc.createElement('label');
  label.textContent = labelText;
  field.appendChild(label);
  const ro = doc.createElement('code');
  ro.className = 'recipe-editor-readonly';
  ro.textContent = text.length > 0 ? text : '(empty)';
  field.appendChild(ro);
  grid.appendChild(field);
};

// ────────────────────────────────────────────────────────────────
// Bootstrap
// ────────────────────────────────────────────────────────────────

const injectStyles = (doc: Document): void => {
  if (
    doc.head !== undefined
    && doc.head.querySelector(`style[${RECIPE_EDITOR_STYLES_MARKER}]`) === null
  ) {
    const style = doc.createElement('style');
    style.setAttribute(RECIPE_EDITOR_STYLES_MARKER, '');
    style.textContent = [PRIMITIVE_STYLES, RECIPE_EDITOR_STYLES].join('\n');
    doc.head.appendChild(style);
  }
};

export const bootstrapRecipeEditorRoute = (
  options: BootstrapRecipeEditorRouteOptions,
): RecipeEditorRoute => {
  const doc = options.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'bootstrapRecipeEditorRoute: no document available; pass options.document for non-browser environments',
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

  const state: RecipeEditorState = {
    // ⛔ NORMALISE, don't guard each read. `prefetch_steps` is OPTIONAL in a
    // valid recipe (`parseRecipe` accepts one without the key), but this editor
    // was written against `blankRecipe()`, which always seeds it — so dozens of
    // reads assume an array and any one of them throws on a recipe that omits
    // it. Three such reads were found by hand and that was clearly not all of
    // them; seeding once here fixes the ones nobody has hit yet too.
    //
    // Hit live on 2026-07-29 by the first D-219 AI draft, but nothing about it
    // is AI-specific: an imported or hand-written recipe omitting the key
    // crashed the editor at mount with "Cannot read properties of undefined".
    // ⚠ Seeding an EMPTY list changes no behaviour — an absent list and an
    // empty one mean the same thing to every reader and to save.
    recipe: adoptRecipe(options.initialRecipe) ?? blankRecipe(),
    saveStage: 'idle',
    issues: [],
    status: '',
    dirty: options.initialDirty ?? false,
    collapsed: new Set(),
    openConditions: new Set(),
    editEpoch: 0,
  };
  const webhookSelections = new Map(
    options.webhookControl?.initialStatus.bindings.map((selection) => [
      selection.binding,
      selection.ingress_id,
    ]) ?? [],
  );
  let persistedRecipeId = state.recipe.recipe_id;
  let webhookStatus = options.webhookControl?.initialStatus;
  let webhookBusy = false;
  let webhookError: string | null = null;

  let disposed = false;
  /** True while a validate/save rpc is in flight — the stage fields can't
   *  carry this (markDirty resets them on a mid-flight edit), and a reflex
   *  Cmd+S must not start an overlapping call. */
  let rpcInFlight = false;

  const host = doc.createElement('section');
  host.setAttribute(RECIPE_EDITOR_ROUTE_ATTR, '');
  options.root.appendChild(host);

  // Screen-reader outcome announcer — one PERSISTENT visually-hidden live
  // region. A live region only announces mutations made while it is already
  // in the tree (AT also ignores mutations in a node re-inserted the same
  // task), so it mounts ONCE outside the per-render `content` wrapper and is
  // never detached until dispose; `announce()` mutates it only on
  // validate/save completion.
  const announcer = doc.createElement('div');
  announcer.className = 'recipe-editor-sr-announcer';
  announcer.setAttribute('role', 'status');
  announcer.setAttribute('aria-live', 'polite');
  host.appendChild(announcer);
  const announce = (text: string): void => {
    announcer.textContent = text;
  };

  // Everything rerender() paints lives under this wrapper — clearing it
  // leaves the announcer attached across renders.
  const content = doc.createElement('div');
  host.appendChild(content);

  type RecipeEditorFieldFocus = {
    fieldKey: string;
    occurrence: number;
    selectionStart: number | null;
    selectionEnd: number | null;
    reveal?: boolean;
  };

  const editorFields = (fieldKey: string): HTMLElement[] => {
    const matches: HTMLElement[] = [];
    const walk = (element: HTMLElement): void => {
      if (element.getAttribute?.(RECIPE_EDITOR_FIELD_ATTR) === fieldKey) {
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
  ): RecipeEditorFieldFocus | null => {
    const fieldKey = element.getAttribute?.(RECIPE_EDITOR_FIELD_ATTR) ?? null;
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

  const restoreFieldFocus = (focus: RecipeEditorFieldFocus): boolean => {
    const target = editorFields(focus.fieldKey)[focus.occurrence];
    if (target === undefined || (target as HTMLInputElement).disabled === true) {
      return false;
    }
    target.focus?.({ preventScroll: true });
    if (focus.reveal === true) {
      target.scrollIntoView?.({ block: 'nearest' });
    }
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

  /** A field edit that must NOT trigger a rerender (keeps input focus). Marks
   *  the recipe dirty + invalidates the prior validate result, and updates the
   *  Save button label in place via `syncActionLabels`. */
  const markDirty = (): void => {
    state.dirty = true;
    state.saveStage = 'idle';
    state.issues = [];
    state.editEpoch += 1;
    syncActionLabels();
  };

  /** Mutate the recipe and rerender (structure changed — add / remove / rename /
   *  kind change / condition rebuild). */
  const mutateAndRerender = (next: RecipeDefinition): void => {
    state.recipe = next;
    state.dirty = true;
    state.saveStage = 'idle';
    state.issues = [];
    state.editEpoch += 1;
    rerender();
  };

  /** Patch the fields of an existing recipe variable in place (a focused field
   *  edit — no rerender; the caller follows with markDirty). */
  const patchVariable = (name: string, patch: Record<string, unknown>): void => {
    const prev = (state.recipe.variables[name] ?? {}) as Record<string, unknown>;
    state.recipe = {
      ...state.recipe,
      variables: {
        ...state.recipe.variables,
        [name]: { ...prev, ...patch } as unknown as VariableDefault,
      },
    };
  };

  // Live references to the action buttons / dirty cue / issues panel, so a
  // focused field edit can update labels without a full rerender and the
  // validate/save handlers can scroll fresh issues into view.
  let saveBtn: HTMLButtonElement | undefined;
  let validateBtn: HTMLButtonElement | undefined;
  let dirtyCue: HTMLElement | undefined;
  let issuesPanel: HTMLElement | undefined;
  let topbarEl: HTMLElement | undefined;
  let routeHeading: HTMLElement | undefined;
  let webhookAuthorityBtn: HTMLButtonElement | undefined;
  // Render-owning controls rebuild the entire editor. Remember which one had
  // focus, then restore its durable replacement; Validate/Save and webhook
  // Arm/Disarm hold ownership across their guarded, aria-busy paint. A user
  // who moves to another connected element while an RPC runs cancels it.
  let pendingActionFocus:
    | 'validate'
    | 'save'
    | 'collapse-all'
    | 'webhook-authority'
    | null = null;
  let pendingFieldFocus: RecipeEditorFieldFocus | null = null;

  const saveLabel = (): string => {
    switch (state.saveStage) {
      case 'saving':
        return 'Saving…';
      case 'saved':
        return 'Saved';
      default:
        // While VALIDATING the Save button keeps its own label — the progress
        // reads on the Validate button + status line, not here.
        return 'Save';
    }
  };

  const syncActionLabels = (): void => {
    // While an rpc is in flight, a mid-flight edit resets the stage — but the
    // busy labels/disabled state must hold until the completion repaints
    // (an enabled-looking 'Save' over a still-disabled button lies).
    if (rpcInFlight && state.saveStage === 'idle') {
      if (dirtyCue !== undefined) {
        dirtyCue.textContent = state.dirty ? 'Unsaved' : '';
      }
      return;
    }
    const busy = state.saveStage === 'validating'
      || state.saveStage === 'saving'
      || webhookBusy;
    const syncBusyState = (button: HTMLButtonElement): void => {
      // These RPC actions remain focusable while guarded. Native `disabled`
      // drops focus when rerender replaces the active button, stranding a
      // keyboard user on the document until the request settles. The handler
      // guards above remain the single-flight authority; ARIA exposes the same
      // unavailable + progress state without destroying focus ownership.
      button.disabled = false;
      button.setAttribute('aria-disabled', String(busy));
      button.setAttribute('aria-busy', String(busy));
    };
    if (saveBtn !== undefined) {
      saveBtn.textContent = saveLabel();
      syncBusyState(saveBtn);
    }
    if (validateBtn !== undefined) {
      validateBtn.textContent =
        state.saveStage === 'validating' ? 'Validating…' : 'Validate';
      syncBusyState(validateBtn);
    }
    if (dirtyCue !== undefined) {
      // Text-only carrier — the ● comes from the ::before dot; an empty cue
      // hides entirely via :empty.
      dirtyCue.textContent = state.dirty ? 'Unsaved' : '';
    }
  };

  /** Bring the freshly rendered issues panel into view — validate/save fire
   *  from the sticky topbar while the user may be scrolled anywhere. The
   *  sticky bar overlays the scrollport top, so: measure its CURRENT height
   *  into scroll-margin-top (it grows a status row at exactly this moment;
   *  the CSS 120px is only the no-measure fallback) and align to 'start'
   *  ('nearest' would no-op while the panel sits occluded UNDER the bar).
   *  No-op in non-browser docs (the fake-DOM harness has neither offsetHeight
   *  nor scrollIntoView). */
  const revealIssues = (): void => {
    if (state.issues.length === 0 || issuesPanel === undefined) return;
    const barHeight = topbarEl?.offsetHeight;
    if (typeof barHeight === 'number' && barHeight > 0) {
      issuesPanel.style?.setProperty?.('scroll-margin-top', `${barHeight + 12}px`);
    }
    issuesPanel.scrollIntoView?.({ block: 'start' });
  };

  const runValidate = (): void => {
    if (disposed || rpcInFlight || webhookBusy) return;
    state.saveStage = 'validating';
    state.status = 'Validating…';
    rerender();
    rpcInFlight = true;
    // Fields remain editable while validation runs. A response only describes
    // the snapshot dispatched at this epoch, never edits made afterward.
    const epochAtValidate = state.editEpoch;
    void options
      .validateCaller({ recipe: state.recipe })
      .then((result) => {
        rpcInFlight = false;
        if (disposed) return;
        const staleEdits = state.editEpoch !== epochAtValidate;
        state.issues = staleEdits ? [] : result.issues;
        state.saveStage = staleEdits ? 'idle' : result.ok ? 'idle' : 'error';
        state.status = staleEdits
          ? 'Validation finished — newer edits pending'
          : result.ok
            ? 'Valid'
            : `Validation failed: ${plural(result.issues.length, 'issue')}`;
        // Validating never clears `dirty` — the edits are still unsaved.
        rerender();
        announce(state.status);
        revealIssues();
      })
      .catch((error: unknown) => {
        rpcInFlight = false;
        if (disposed) return;
        state.saveStage = 'error';
        state.status = errorMessage(error);
        rerender();
        announce(state.status);
      });
  };

  const runSave = (): void => {
    if (disposed || rpcInFlight || webhookBusy) return;
    if (webhookStatus?.armed && state.recipe.recipe_id !== persistedRecipeId) {
      state.saveStage = 'error';
      state.status = 'Disarm the saved webhook before forking this recipe';
      state.issues = [{
        path: 'recipe_id',
        severity: 'error',
        message: `Disarm '${persistedRecipeId}' first so the editor cannot hide an armed original after saving the new id.`,
      }];
      rerender();
      return;
    }
    const requirements = state.recipe.webhook_requirements ?? [];
    const declaresWebhook = requirements.length > 0
      || (state.recipe.webhook_triggers?.length ?? 0) > 0;
    let webhookBindings: WebhookIngressBindingSelection[] | undefined;
    if (declaresWebhook) {
      if (!options.webhookControl) {
        state.saveStage = 'error';
        state.status = 'Webhook binding controls are unavailable';
        state.issues = [{
          severity: 'error',
          message: 'Reload on an owner Kitchen surface to select webhook ingresses.',
        }];
        rerender();
        return;
      }
      webhookBindings = [];
      for (const requirement of requirements) {
        const ingressId = webhookSelections.get(requirement.binding);
        if (!ingressId) {
          state.saveStage = 'error';
          state.status = 'Select every webhook ingress before saving';
          state.issues = [{
            path: `webhook_requirements.${requirement.binding}`,
            severity: 'error',
            message: `Choose an enabled compatible ingress for '${requirement.binding}'.`,
          }];
          rerender();
          return;
        }
        webhookBindings.push({ binding: requirement.binding, ingress_id: ingressId });
      }
    }
    state.saveStage = 'saving';
    state.status = 'Saving…';
    rerender();
    rpcInFlight = true;
    // Edits landing while the save is in flight are NOT in the saved body —
    // the completion checks the epoch so it never reports them clean.
    const epochAtSave = state.editEpoch;
    void options
      .saveCaller({
        recipe: state.recipe,
        ...(webhookBindings ? { webhook_bindings: webhookBindings } : {}),
      })
      .then((result) => {
        rpcInFlight = false;
        if (disposed) return;
        const warnings = result.op_warnings ?? [];
        const staleEdits = state.editEpoch !== epochAtSave;
        state.saveStage = staleEdits ? 'idle' : 'saved';
        const savedNote = `Saved ${result.recipe_id} v${result.version}`;
        state.status =
          warnings.length > 0
            ? `${savedNote} — ${plural(warnings.length, 'warning')}`
            : staleEdits
              ? `${savedNote} — newer edits pending`
              : savedNote;
        // Surface non-blocking save advisories as warn-severity issues.
        state.issues = warnings.map((message) => ({ message, severity: 'warn' }));
        if (result.webhook) {
          webhookStatus = result.webhook;
          webhookSelections.clear();
          for (const selection of result.webhook.bindings) {
            webhookSelections.set(selection.binding, selection.ingress_id);
          }
          webhookError = null;
        } else if (!declaresWebhook && options.webhookControl) {
          webhookStatus = {
            declared: false,
            configured: false,
            armed: false,
            bindings: [],
          };
          webhookSelections.clear();
          webhookError = null;
        }
        persistedRecipeId = result.recipe_id;
        state.dirty = staleEdits;
        rerender();
        announce(state.status);
        revealIssues();
        if (options.onSaved !== undefined) {
          try {
            options.onSaved(result);
          } catch (error: unknown) {
            state.status = `${savedNote} — editor link was not updated`;
            state.issues = [
              ...state.issues,
              {
                severity: 'warn',
                message: `The recipe was saved, but its editor URL could not be updated: ${errorMessage(error)}`,
              },
            ];
            rerender();
            announce(state.status);
            revealIssues();
          }
        }
      })
      .catch((error: unknown) => {
        rpcInFlight = false;
        if (disposed) return;
        // The save rpc throws on rejection (e.g. an inline op-step). Surface it.
        state.saveStage = 'error';
        state.status = errorMessage(error);
        rerender();
        announce(state.status);
      });
  };

  // ────────────────────────────────────────────────────────────
  // Condition builder (skip_when / fail_on) — common to all kinds
  // ────────────────────────────────────────────────────────────
  const renderConditionField = (
    step: RecipeStep,
    listKey: 'prefetch_steps' | 'steps',
    field: 'skip_when' | 'fail_on',
    grid: HTMLElement,
  ): void => {
    const raw = (step as Record<string, unknown>)[field];
    const current = conditionFieldString(raw);

    // Object-form condition → show read-only JSON with an "edit as JSON" hint.
    if (isObjectCondition(raw)) {
      const wrap = doc.createElement('div');
      wrap.className = 'recipe-editor-field span-full';
      const label = doc.createElement('label');
      label.textContent = field === 'skip_when' ? 'Skip when' : 'Fail on';
      wrap.appendChild(label);
      const ro = doc.createElement('code');
      ro.className = 'recipe-editor-readonly';
      ro.setAttribute(RECIPE_EDITOR_FIELD_ATTR, field);
      ro.textContent = current;
      wrap.appendChild(ro);
      const hint = appendText(doc, wrap, 'span', 'Object-form condition — edit as JSON');
      hint.className = 'recipe-editor-hint';
      grid.appendChild(wrap);
      return;
    }

    const parsed = parseCondition(current);
    const conditionKey = `${step.id}:${field}`;
    const parts = {
      field: parsed.field ?? '',
      operator: parsed.operator ?? '',
      value: parsed.value ?? '',
    };

    const applyCondition = (rebuild: boolean): void => {
      const built = formatCondition(parts);
      const value = parseStepFieldValue(built, 'string', true);
      const nextList = applyFieldToStep(
        state.recipe[listKey] as Array<{ id: string }>,
        step.id,
        field,
        value,
      );
      const nextRecipe = {
        ...state.recipe,
        [listKey]: nextList,
      } as RecipeDefinition;
      // Once someone is editing a condition, keep the builder revealed even
      // if its current parts temporarily format to an empty value.
      state.openConditions.add(conditionKey);
      if (rebuild) {
        pendingConditionFocus = { conditionKey, part: 'operator' };
        mutateAndRerender(nextRecipe);
      } else {
        // Source/value commits do not change the row shape. Updating in place
        // lets native Tab/Shift+Tab continue through the builder uninterrupted.
        state.recipe = nextRecipe;
        markDirty();
      }
    };

    const section = doc.createElement('div');
    section.className = 'recipe-editor-field span-full';
    const label = doc.createElement('label');
    label.textContent = field === 'skip_when' ? 'Skip when' : 'Fail on';
    section.appendChild(label);

    const row = doc.createElement('div');
    row.className = 'recipe-editor-condition-row';

    const fieldInput = makeTextInput(doc, parts.field, field, (next) => {
      parts.field = next;
    });
    fieldInput.setAttribute('placeholder', '{{step.x}}');
    fieldInput.addEventListener('change', () => applyCondition(false));
    row.appendChild(fieldInput);

    const opOptions = ['', ...CONDITION_OP_LABELS.map((entry) => entry.op)];
    const opSelect = makeSelect(doc, parts.operator, opOptions, `${field}_op`, (next) => {
      const priorUnary = UNARY_OPS.has(parts.operator as ConditionOp);
      parts.operator = next;
      const nextUnary = UNARY_OPS.has(parts.operator as ConditionOp);
      applyCondition(priorUnary !== nextUnary);
    });
    row.appendChild(opSelect);

    const unary = UNARY_OPS.has(parts.operator as ConditionOp);
    if (!unary) {
      const valueInput = makeTextInput(doc, parts.value, `${field}_value`, (next) => {
        parts.value = next;
      });
      valueInput.setAttribute('placeholder', 'value');
      valueInput.addEventListener('change', () => applyCondition(false));
      row.appendChild(valueInput);
    }

    renderedConditionFocusTargets.set(conditionKey, {
      field: fieldInput,
      operator: opSelect,
    });

    section.appendChild(row);
    grid.appendChild(section);
  };

  // ────────────────────────────────────────────────────────────
  // Per-kind body renderers
  // ────────────────────────────────────────────────────────────
  const renderTransformBody = (
    step: RecipeStep,
    listKey: 'prefetch_steps' | 'steps',
    grid: HTMLElement,
  ): void => {
    for (const { name, value, def } of enumerateTransformParams(step)) {
      const fieldType: StepFieldType = detectStepFieldType(value, def);
      const fieldKey = `param:${name}`;

      if (fieldType === 'unsupported') {
        addReadonlyField(doc, grid, name, serializeValue(value));
        continue;
      }

      const apply = (raw: string): void => {
        const parsed = parseStepFieldValue(raw, fieldType, false);
        const nextList = applyFieldToStep(
          state.recipe[listKey] as Array<{ id: string }>,
          step.id,
          fieldKey,
          parsed,
        );
        state.recipe = { ...state.recipe, [listKey]: nextList } as RecipeDefinition;
        markDirty();
      };

      if (fieldType === 'boolean') {
        const wrap = doc.createElement('div');
        wrap.className = 'recipe-editor-field';
        const cbLabel = doc.createElement('label');
        cbLabel.className = 'recipe-editor-field-checkbox';
        const cb = doc.createElement('input');
        cb.type = 'checkbox';
        cb.checked = value === true;
        cb.setAttribute(RECIPE_EDITOR_FIELD_ATTR, fieldKey);
        cb.addEventListener('change', () => apply(cb.checked ? 'true' : 'false'));
        cbLabel.appendChild(cb);
        appendText(doc, cbLabel, 'span', name);
        wrap.appendChild(cbLabel);
        grid.appendChild(wrap);
      } else if (fieldType === 'enum') {
        const enumValues = def?.enum ?? [];
        addField(
          doc,
          grid,
          name,
          makeSelect(doc, serializeValue(value), enumValues, fieldKey, apply),
        );
      } else if (fieldType === 'number') {
        addField(doc, grid, name, makeNumberInput(doc, serializeValue(value), fieldKey, apply));
      } else {
        addField(doc, grid, name, makeTextInput(doc, serializeValue(value), fieldKey, apply));
      }
    }
  };

  const renderIngredientBody = (
    step: RecipeStep,
    listKey: 'prefetch_steps' | 'steps',
    grid: HTMLElement,
  ): void => {
    const slug = getStepDiscriminator(step);
    addField(
      doc,
      grid,
      'Ingredient',
      makeTextInput(doc, slug, 'ingredient', (next) => {
        const nextList = (state.recipe[listKey] as Array<{ id: string }>).map((s) =>
          s.id === step.id ? { ...s, ingredient: next } : s,
        );
        state.recipe = { ...state.recipe, [listKey]: nextList } as RecipeDefinition;
        markDirty();
      }),
      true,
    );

    for (const { name, value } of enumerateIngredientInputs(step)) {
      const fieldType = detectStepFieldType(value);
      const fieldKey = `input:${name}`;
      if (fieldType === 'unsupported') {
        addReadonlyField(doc, grid, name, serializeValue(value));
        continue;
      }
      const apply = (raw: string): void => {
        const parsed = parseStepFieldValue(raw, fieldType, false);
        const nextList = applyFieldToStep(
          state.recipe[listKey] as Array<{ id: string }>,
          step.id,
          fieldKey,
          parsed,
        );
        state.recipe = { ...state.recipe, [listKey]: nextList } as RecipeDefinition;
        markDirty();
      };
      if (fieldType === 'boolean') {
        const wrap = doc.createElement('div');
        wrap.className = 'recipe-editor-field';
        const cbLabel = doc.createElement('label');
        cbLabel.className = 'recipe-editor-field-checkbox';
        const cb = doc.createElement('input');
        cb.type = 'checkbox';
        cb.checked = value === true;
        cb.setAttribute(RECIPE_EDITOR_FIELD_ATTR, fieldKey);
        cb.addEventListener('change', () => apply(cb.checked ? 'true' : 'false'));
        cbLabel.appendChild(cb);
        appendText(doc, cbLabel, 'span', name);
        wrap.appendChild(cbLabel);
        grid.appendChild(wrap);
      } else if (fieldType === 'number') {
        addField(doc, grid, name, makeNumberInput(doc, serializeValue(value), fieldKey, apply));
      } else {
        addField(doc, grid, name, makeTextInput(doc, serializeValue(value), fieldKey, apply));
      }
    }
  };

  const renderGuardBody = (
    step: RecipeStep,
    listKey: 'prefetch_steps' | 'steps',
    grid: HTMLElement,
  ): void => {
    const guardValue = String((step as { guard?: unknown }).guard ?? '');
    addField(
      doc,
      grid,
      'Guard',
      makeTextInput(doc, guardValue, 'guard', (next) => {
        const nextList = (state.recipe[listKey] as Array<{ id: string }>).map((s) =>
          s.id === step.id ? { ...s, guard: next } : s,
        );
        state.recipe = { ...state.recipe, [listKey]: nextList } as RecipeDefinition;
        markDirty();
      }),
      true,
    );
  };

  const renderOpBody = (
    step: RecipeStep,
    listKey: 'prefetch_steps' | 'steps',
    grid: HTMLElement,
  ): void => {
    const opStep = step as { op?: unknown; connection?: unknown; foreach?: unknown };

    // Patch a top-level op-step field on this step. For `connection` / `foreach`
    // an empty value DELETES the key (an empty connection slot / foreach must be
    // omitted, never `''`); `op` always sets (the discriminator is required).
    const patchTopLevel = (
      key: 'op' | 'connection' | 'foreach',
      raw: string,
    ): void => {
      const nextList = (state.recipe[listKey] as Array<{ id: string }>).map((s) => {
        if (s.id !== step.id) return s;
        const next = { ...s } as Record<string, unknown>;
        if (key !== 'op' && raw.trim() === '') delete next[key];
        else next[key] = raw;
        return next;
      });
      state.recipe = { ...state.recipe, [listKey]: nextList } as RecipeDefinition;
      markDirty();
    };

    // Op id — the primary discriminator (free text; recipe.validate checks shape).
    addField(
      doc,
      grid,
      'Op',
      makeTextInput(doc, String(opStep.op ?? ''), 'op', (next) =>
        patchTopLevel('op', next),
      ),
      true,
    );

    // Connection slot — a {{config.<var>}} ref naming a type:'connection'
    // variable. A picker when the recipe declares any, else free text.
    const connVars = connectionVarNames(state.recipe);
    const connValue = String(opStep.connection ?? '');
    if (connVars.length > 0) {
      const refs = connVars.map((name) => `{{config.${name}}}`);
      const options =
        connValue !== '' && !refs.includes(connValue)
          ? ['', connValue, ...refs]
          : ['', ...refs];
      addField(
        doc,
        grid,
        'Connection slot',
        makeSelect(doc, connValue, options, 'connection', (next) =>
          patchTopLevel('connection', next),
        ),
      );
    } else {
      const connInput = makeTextInput(doc, connValue, 'connection', (next) =>
        patchTopLevel('connection', next),
      );
      connInput.setAttribute('placeholder', '{{config.crm}}');
      addField(doc, grid, 'Connection slot', connInput);
    }

    // foreach — per-iteration dispatch over a source collection (tool ops only).
    const foreachInput = makeTextInput(
      doc,
      String(opStep.foreach ?? ''),
      'foreach',
      (next) => patchTopLevel('foreach', next),
    );
    foreachInput.setAttribute('placeholder', '{{step.items}}');
    addField(doc, grid, 'For each', foreachInput);

    // Args — vendor-neutral key/value pairs (add / edit / remove). No schema,
    // so values are always editable free text and smart-parsed on commit (refs
    // stay strings; JSON literals become their typed value).
    const argsLabel = doc.createElement('div');
    argsLabel.className = 'recipe-editor-subsection-label span-full';
    argsLabel.textContent = 'Args';
    grid.appendChild(argsLabel);

    for (const { name, value } of enumerateOpArgs(step)) {
      const wrap = doc.createElement('div');
      wrap.className = 'recipe-editor-field span-full';
      const label = doc.createElement('label');
      label.textContent = name;
      wrap.appendChild(label);

      const row = doc.createElement('div');
      row.className = 'recipe-editor-arg-row';

      const serialized = serializeValue(value);
      const applyArg = (raw: string): void => {
        const nextList = applyFieldToStep(
          state.recipe[listKey] as Array<{ id: string }>,
          step.id,
          `arg:${name}`,
          parseOpArgValue(raw),
        );
        state.recipe = { ...state.recipe, [listKey]: nextList } as RecipeDefinition;
        markDirty();
      };
      // JSON containers / long values get the multi-line monospace editor —
      // a nested op body is unworkable in a one-line input.
      const valueInput = isBlockValue(value, serialized)
        ? makeTextArea(doc, serialized, `arg:${name}`, applyArg)
        : makeTextInput(doc, serialized, `arg:${name}`, applyArg);
      row.appendChild(valueInput);

      const removeArg = makeButton(doc, 'Remove', 'danger-text', 'xs', () => {
        const fresh = (state.recipe[listKey] as RecipeStep[]).find(
          (candidate) => candidate.id === step.id,
        );
        const orderedBefore = fresh === undefined
          ? []
          : enumerateOpArgs(fresh).map((arg) => arg.name);
        const removedIndex = orderedBefore.indexOf(name);
        const orderedAfter = orderedBefore.filter((argName) => argName !== name);
        pendingRemovedOpArgFocus = {
          stepId: step.id,
          argName: removedIndex < 0
            ? null
            : orderedAfter[Math.min(removedIndex, orderedAfter.length - 1)] ?? null,
        };
        const nextList = (state.recipe[listKey] as Array<{ id: string }>).map((s) => {
          if (s.id !== step.id) return s;
          const nextArgs = { ...((s as { args?: Record<string, unknown> }).args ?? {}) };
          delete nextArgs[name];
          return { ...s, args: nextArgs };
        });
        mutateAndRerender({ ...state.recipe, [listKey]: nextList } as RecipeDefinition);
      });
      removeArg.setAttribute(RECIPE_EDITOR_OP_ARG_REMOVE_ATTR, name);
      removeArg.setAttribute('aria-label', `Remove arg ${name}`);
      row.appendChild(removeArg);
      renderedOpArgFocusTargets.set(
        `${step.id}\u0000${name}`,
        valueInput,
      );

      wrap.appendChild(row);
      grid.appendChild(wrap);
    }

    // Add-arg control — a name input + button (mints args.<name> = '').
    const argDraft = { name: '' };
    const addWrap = doc.createElement('div');
    addWrap.className = 'recipe-editor-arg-add span-full';

    const nameField = doc.createElement('div');
    nameField.className = 'recipe-editor-field';
    const nameLabel = doc.createElement('label');
    nameLabel.textContent = 'New arg';
    nameField.appendChild(nameLabel);
    const nameInput = makeTextInput(doc, '', 'op_arg_name', (next) => {
      argDraft.name = next;
    });
    nameInput.setAttribute(RECIPE_EDITOR_OP_ARG_NAME_ATTR, '');
    nameInput.setAttribute('placeholder', 'arg name');
    renderedOpArgDraftTargets.set(step.id, nameInput);
    nameField.appendChild(nameInput);
    addWrap.appendChild(nameField);

    const addArg = makeButton(doc, 'Add arg', 'secondary', 'sm', () => {
      const name = argDraft.name.trim();
      if (name === '') return;
      if (enumerateOpArgs(step).some((a) => a.name === name)) return; // dup — ignore
      const nextList = (state.recipe[listKey] as Array<{ id: string }>).map((s) =>
        s.id === step.id
          ? {
              ...s,
              args: { ...((s as { args?: Record<string, unknown> }).args ?? {}), [name]: '' },
            }
          : s,
      );
      pendingAddedOpArgFocus = { stepId: step.id, argName: name };
      mutateAndRerender({ ...state.recipe, [listKey]: nextList } as RecipeDefinition);
    });
    addArg.setAttribute(RECIPE_EDITOR_OP_ARG_ADD_ATTR, '');
    addWrap.appendChild(addArg);
    grid.appendChild(addWrap);

    // Guidance — only while it's actionable: THIS card's slot is unfilled.
    // (A filled slot needs no reminder, and repeating the same sentence on
    // every op card is noise.) The pointer depends on whether a variable
    // exists to pick yet.
    if (connValue.trim() === '') {
      const notice = doc.createElement('p');
      notice.className = 'span-full';
      notice.setAttribute(RECIPE_EDITOR_OP_NOTICE_ATTR, '');
      notice.textContent =
        'Op-steps resolve at run through the dispatch path. A CRM op needs a '
        + 'connection variable to fill its connection slot — '
        + (connVars.length === 0
          ? 'declare one under Connections & dependencies below.'
          : 'pick one above.');
      grid.appendChild(notice);
    }
  };

  // ────────────────────────────────────────────────────────────
  // One step card
  // ────────────────────────────────────────────────────────────
  const renderStepCard = (
    step: RecipeStep,
    listKey: 'prefetch_steps' | 'steps',
    index: number,
    listLength: number,
  ): HTMLElement => {
    const kind = detectStepKind(step);
    const card = doc.createElement('details');
    card.className = 'recipe-editor-step-card';
    card.setAttribute(RECIPE_EDITOR_ROW_ATTR, step.id);
    card.setAttribute('data-step-kind', kind);
    // Open unless the user collapsed this card — the summary (kind + id +
    // discriminator) is the collapsed overview, and the choice survives
    // rerenders via state.collapsed keyed on the step id.
    if (!state.collapsed.has(step.id)) card.setAttribute('open', '');
    card.addEventListener('toggle', () => {
      if ((card as unknown as { open?: boolean }).open === true) {
        state.collapsed.delete(step.id);
      } else {
        state.collapsed.add(step.id);
      }
      // Manual toggles don't rerender — keep the header toggle's label honest.
      syncCollapseAllLabel();
    });

    const summary = doc.createElement('summary');
    summary.className = 'recipe-editor-step-summary';

    const kindPill = doc.createElement('span');
    kindPill.className = 'recipe-editor-kind-pill';
    kindPill.textContent = KIND_PILL_LABEL[kind];
    summary.appendChild(kindPill);

    // Editable step id — rename rewrites refs everywhere on commit.
    const idWrap = doc.createElement('div');
    idWrap.className = 'recipe-editor-step-id';
    const idInput = doc.createElement('input');
    idInput.type = 'text';
    idInput.value = step.id;
    idInput.setAttribute(RECIPE_EDITOR_FIELD_ATTR, 'step_id');
    idInput.setAttribute('aria-label', `Step id (${step.id})`);
    let renameFocusTarget: 'self' | 'previous' | 'next' = 'self';
    const commitRename = (): void => {
      const proposed = idInput.value;
      if (proposed === step.id) return;
      const others = allStepIds(state.recipe).filter((id) => id !== step.id);
      const verdict = validateStepIdRename(others, step.id, proposed);
      if (!verdict.ok) {
        state.status = verdict.error;
        state.saveStage = 'error';
        idInput.value = step.id; // revert
        pendingRenamedStepFocus = { stepId: step.id, target: 'self' };
        rerender();
        return;
      }
      // Carry per-card UI state (collapse / revealed conditions) across the
      // rename — both sets are keyed on the step id.
      if (state.collapsed.delete(step.id)) state.collapsed.add(proposed);
      for (const field of CONDITION_FIELDS) {
        if (state.openConditions.delete(`${step.id}:${field}`)) {
          state.openConditions.add(`${proposed}:${field}`);
        }
      }
      pendingRenamedStepFocus = { stepId: proposed, target: renameFocusTarget };
      mutateAndRerender(renameStepIdInRecipe(state.recipe, step.id, proposed));
    };
    idInput.addEventListener('keydown', (event) => {
      if (event.key === 'Tab') {
        renameFocusTarget = event.shiftKey ? 'previous' : 'next';
      }
    });
    idInput.addEventListener('change', commitRename);
    idWrap.appendChild(idInput);
    summary.appendChild(idWrap);

    const disc = doc.createElement('span');
    disc.className = 'recipe-editor-step-disc';
    disc.textContent = getStepDiscriminator(step);
    summary.appendChild(disc);

    // Reorder — step order IS execution order, so every card can move. The
    // handler re-reads the CURRENT list at click time: focused field edits
    // replace state.recipe without a rerender (markDirty path), so the
    // render-time list/index — fine for the disabled cues below — would
    // silently revert those edits if committed.
    const moveTo = (offset: number): boolean => {
      const fresh = state.recipe[listKey] as Array<{ id: string }>;
      const from = fresh.findIndex((s) => s.id === step.id);
      if (from < 0) return false;
      const nextList = reorderSteps(fresh, from, from + offset);
      if (nextList === fresh) return false;
      mutateAndRerender({
        ...state.recipe,
        [listKey]: nextList,
      } as RecipeDefinition);
      return true;
    };
    const requestMove = (
      action: 'move-up' | 'move-down',
      offset: number,
    ): void => {
      pendingStepActionFocus = { stepId: step.id, action };
      if (!moveTo(offset)) pendingStepActionFocus = null;
    };
    const moveUp = makeButton(
      doc,
      '↑',
      'secondary',
      'xs',
      () => requestMove('move-up', -1),
    );
    moveUp.setAttribute(RECIPE_EDITOR_MOVE_UP_ATTR, step.id);
    moveUp.setAttribute('aria-label', `Move step ${step.id} up`);
    moveUp.setAttribute('title', 'Move up');
    moveUp.disabled = index <= 0;

    const moveDown = makeButton(
      doc,
      '↓',
      'secondary',
      'xs',
      () => requestMove('move-down', 1),
    );
    moveDown.setAttribute(RECIPE_EDITOR_MOVE_DOWN_ATTR, step.id);
    moveDown.setAttribute('aria-label', `Move step ${step.id} down`);
    moveDown.setAttribute('title', 'Move down');
    moveDown.disabled = index >= listLength - 1;

    const remove = makeButton(doc, 'Remove', 'danger-text', 'xs', () => {
      const orderedBefore = allStepIds(state.recipe);
      const removedIndex = orderedBefore.indexOf(step.id);
      if (removedIndex < 0) return;
      const nextList = removeStepById(
        state.recipe[listKey] as Array<{ id: string }>,
        step.id,
      );
      const nextRecipe = {
        ...state.recipe,
        [listKey]: nextList,
      } as RecipeDefinition;
      const orderedAfter = allStepIds(nextRecipe);
      pendingRemovedStepFocus = {
        stepId: orderedAfter[Math.min(removedIndex, orderedAfter.length - 1)] ?? null,
      };
      // Prune the removed id's UI state — generateStepId reuses freed ids, so
      // a stale entry would make a later fresh step render collapsed (or with
      // a pre-revealed condition builder).
      state.collapsed.delete(step.id);
      for (const field of CONDITION_FIELDS) {
        state.openConditions.delete(`${step.id}:${field}`);
      }
      mutateAndRerender(nextRecipe);
    });
    remove.setAttribute(RECIPE_EDITOR_REMOVE_ATTR, step.id);
    remove.setAttribute('aria-label', `Remove step ${step.id}`);
    remove.setAttribute('title', `Remove ${step.id}`);

    const actions = doc.createElement('div');
    actions.className = 'recipe-editor-step-actions';
    actions.setAttribute('role', 'group');
    actions.setAttribute('aria-label', `Step ${step.id} actions`);
    actions.appendChild(moveUp);
    actions.appendChild(moveDown);
    actions.appendChild(remove);
    summary.appendChild(actions);

    renderedStepFocusTargets.set(step.id, {
      summary,
      idInput,
      moveUp,
      moveDown,
      remove,
    });

    card.appendChild(summary);

    const body = doc.createElement('div');
    body.className = 'recipe-editor-step-body';

    const grid = doc.createElement('div');
    grid.className = 'recipe-editor-field-grid';

    if (kind === 'transform') renderTransformBody(step, listKey, grid);
    else if (kind === 'ingredient') renderIngredientBody(step, listKey, grid);
    else if (kind === 'guard') renderGuardBody(step, listKey, grid);
    else renderOpBody(step, listKey, grid);

    body.appendChild(grid);

    // Conditions — every kind (incl. op-steps, which extend BaseStep) carries
    // skip_when / fail_on, but most steps set neither. Render a builder only
    // for a field with a value (or one the user revealed); the rest stay
    // behind "+ Skip when" / "+ Fail on" so an unconditioned card stays short.
    const condControls = doc.createElement('div');
    condControls.className = 'recipe-editor-cond-controls';
    const condLabel = doc.createElement('span');
    condLabel.className = 'recipe-editor-subsection-label';
    condLabel.textContent = 'Conditions';
    condControls.appendChild(condLabel);

    const condGrid = doc.createElement('div');
    condGrid.className = 'recipe-editor-field-grid';
    let builtAny = false;
    for (const field of CONDITION_FIELDS) {
      const value = (step as Record<string, unknown>)[field];
      const revealed = state.openConditions.has(`${step.id}:${field}`);
      if (conditionFieldString(value) !== '' || revealed) {
        renderConditionField(step, listKey, field, condGrid);
        builtAny = true;
      } else {
        const reveal = makeButton(
          doc,
          field === 'skip_when' ? '+ Skip when' : '+ Fail on',
          'secondary',
          'xs',
          () => {
            const conditionKey = `${step.id}:${field}`;
            state.openConditions.add(conditionKey);
            pendingConditionFocus = { conditionKey, part: 'field' };
            rerender();
          },
        );
        reveal.setAttribute(RECIPE_EDITOR_COND_ADD_ATTR, `${step.id}:${field}`);
        condControls.appendChild(reveal);
      }
    }
    body.appendChild(condControls);
    if (builtAny) body.appendChild(condGrid);

    card.appendChild(body);
    return card;
  };

  // ────────────────────────────────────────────────────────────
  // A steps section (Prefetch or Steps)
  // ────────────────────────────────────────────────────────────
  /** Collapse-all / Expand-all — one toggle over every card (prefetch +
   *  steps). Collapsed cards read as a step list (kind + id + discriminator),
   *  the overview + reorder view. Both the branch and the label re-derive from
   *  CURRENT state (manual summary toggles update state.collapsed without a
   *  rerender, so anything captured at render time goes stale). */
  let collapseAllBtn: HTMLButtonElement | undefined;
  let pendingStepActionFocus: {
    stepId: string;
    action: 'move-up' | 'move-down';
  } | null = null;
  let pendingAddedStepFocusId: string | null = null;
  let pendingRemovedStepFocus: { stepId: string | null } | null = null;
  let pendingRenamedStepFocus: {
    stepId: string;
    target: 'self' | 'previous' | 'next';
  } | null = null;
  let pendingConditionFocus: {
    conditionKey: string;
    part: 'field' | 'operator';
  } | null = null;
  let pendingAddedOpArgFocus: { stepId: string; argName: string } | null = null;
  let pendingRemovedOpArgFocus: {
    stepId: string;
    argName: string | null;
  } | null = null;
  let addStepBtn: HTMLButtonElement | undefined;
  let renderedStepFocusTargets = new Map<string, {
    summary: HTMLElement;
    idInput: HTMLInputElement;
    moveUp: HTMLButtonElement;
    moveDown: HTMLButtonElement;
    remove: HTMLButtonElement;
  }>();
  let renderedConditionFocusTargets = new Map<string, {
    field: HTMLInputElement;
    operator: HTMLSelectElement;
  }>();
  let renderedOpArgFocusTargets = new Map<string, HTMLElement>();
  let renderedOpArgDraftTargets = new Map<string, HTMLInputElement>();
  let pendingTriggerFocus: { index: number | null } | null = null;
  let renderedTriggerFocusTargets = new Map<number, HTMLElement>();
  let triggerAddKindSelect: HTMLSelectElement | undefined;

  const everyCardCollapsed = (): boolean => {
    const ids = allStepIds(state.recipe);
    return ids.length > 0 && ids.every((id) => state.collapsed.has(id));
  };

  const syncCollapseAllLabel = (): void => {
    if (collapseAllBtn !== undefined) {
      collapseAllBtn.textContent = everyCardCollapsed() ? 'Expand all' : 'Collapse all';
    }
  };

  const buildCollapseAllControl = (): HTMLElement | undefined => {
    if (allStepIds(state.recipe).length === 0) {
      collapseAllBtn = undefined;
      return undefined;
    }
    const toggle = makeButton(doc, '', 'secondary', 'xs', () => {
      if (everyCardCollapsed()) {
        state.collapsed.clear();
      } else {
        for (const id of allStepIds(state.recipe)) state.collapsed.add(id);
      }
      rerender();
    });
    toggle.setAttribute(RECIPE_EDITOR_COLLAPSE_ALL_ATTR, '');
    collapseAllBtn = toggle;
    syncCollapseAllLabel();
    return toggle;
  };

  const renderStepsSection = (
    host2: HTMLElement,
    title: string,
    listKey: 'prefetch_steps' | 'steps',
    controls: ReadonlyArray<HTMLElement | undefined>,
  ): void => {
    const list = state.recipe[listKey];
    const section = doc.createElement('section');
    section.className = 'recipe-editor-section';

    const header = doc.createElement('div');
    header.className = 'recipe-editor-section-header';
    appendText(doc, header, 'h2', title);
    const meta = appendText(doc, header, 'span', plural(list.length, 'step'));
    meta.className = 'recipe-editor-section-meta';
    for (const control of controls) {
      if (control !== undefined) header.appendChild(control);
    }
    section.appendChild(header);

    if (list.length === 0) {
      const empty = doc.createElement('div');
      empty.className = 'recipe-editor-empty';
      appendText(doc, empty, 'strong', 'No steps yet');
      appendText(
        doc,
        empty,
        'span',
        'Pick a kind above and press Add step to start building this recipe.',
      );
      section.appendChild(empty);
    } else {
      // `renderStepCard` discriminates kind itself (op-steps render read-only),
      // so prefetch op-steps and sequential steps both route through it.
      for (const [index, step] of list.entries()) {
        section.appendChild(
          renderStepCard(step as unknown as RecipeStep, listKey, index, list.length),
        );
      }
    }

    host2.appendChild(section);
  };

  // ────────────────────────────────────────────────────────────
  // Add-step control (transform / ingredient / guard / op)
  // ────────────────────────────────────────────────────────────
  /** Scroll a (freshly added) step card into view — the list can be long and
   *  the new card lands at the bottom. No-op outside a real browser DOM
   *  (same optional-call guard as revealIssues). */
  const revealStep = (id: string): void => {
    const card = host.querySelector?.(`[${RECIPE_EDITOR_ROW_ATTR}="${id}"]`) as
      | { scrollIntoView?: (opts?: unknown) => void }
      | null
      | undefined;
    card?.scrollIntoView?.({ block: 'nearest' });
  };

  const buildAddStepControl = (): HTMLElement => {
    const wrap = doc.createElement('div');
    wrap.className = 'recipe-editor-add recipe-editor-add--step';

    const copy = doc.createElement('div');
    copy.className = 'recipe-editor-add-copy';
    appendText(doc, copy, 'strong', 'Add a step');
    appendText(doc, copy, 'span', 'Steps run in order, from top to bottom.');
    wrap.appendChild(copy);

    // Local picker state lives on the control until Add fires.
    const draft = { kind: 'transform' as AddStepKind, name: '' };

    const kindField = doc.createElement('div');
    kindField.className = 'recipe-editor-field';
    const kindLabel = doc.createElement('label');
    kindLabel.textContent = 'Kind';
    kindField.appendChild(kindLabel);
    const kindSelect = makeSelect(doc, draft.kind, ADD_STEP_KINDS, 'add_kind', (next) => {
      draft.kind = next as AddStepKind;
      // Transform offers a known-name picker; the others a free text input.
      rebuildNameControl();
    });
    kindSelect.setAttribute(RECIPE_EDITOR_ADD_KIND_ATTR, '');
    kindSelect.setAttribute('aria-label', 'Step kind');
    kindField.appendChild(kindSelect);
    wrap.appendChild(kindField);

    const nameField = doc.createElement('div');
    nameField.className = 'recipe-editor-field';
    const nameLabel = doc.createElement('label');
    nameLabel.textContent = 'Name';
    nameField.appendChild(nameLabel);
    wrap.appendChild(nameField);

    const rebuildNameControl = (): void => {
      // Clear everything after the label (the prior name control).
      while (nameField.children.length > 1) {
        nameField.removeChild(nameField.children[nameField.children.length - 1]!);
      }
      // Default to a representative transform, not the alphabetical first
      // ('all' reads like an accident); fall back if the schema set changes.
      draft.name =
        draft.kind === 'transform'
          ? TRANSFORM_NAMES.includes('filter')
            ? 'filter'
            : (TRANSFORM_NAMES[0] ?? '')
          : '';
      if (draft.kind === 'transform') {
        const sel = makeSelect(doc, draft.name, TRANSFORM_NAMES, 'add_name', (next) => {
          draft.name = next;
        });
        sel.setAttribute(RECIPE_EDITOR_ADD_NAME_ATTR, '');
        sel.setAttribute('aria-label', 'Step name');
        nameField.appendChild(sel);
      } else {
        const inp = makeTextInput(doc, draft.name, 'add_name', (next) => {
          draft.name = next;
        });
        inp.setAttribute(RECIPE_EDITOR_ADD_NAME_ATTR, '');
        inp.setAttribute('aria-label', 'Step name');
        const placeholder =
          draft.kind === 'ingredient'
            ? 'ingredient-slug'
            : draft.kind === 'op'
              ? 'core.crm.deal.search'
              : 'condition';
        inp.setAttribute('placeholder', placeholder);
        nameField.appendChild(inp);
      }
    };
    rebuildNameControl();

    const add = makeButton(doc, 'Add step', 'secondary', 'sm', () => {
      const kind = draft.kind;
      if (kind === 'op') {
        const opName = draft.name.trim();
        // Seed the step id from the op's last segment (`deal.search` → `search`).
        const base = opName.split('.').pop() || 'op';
        const id = generateStepId(allStepIds(state.recipe), base);
        pendingAddedStepFocusId = id;
        mutateAndRerender({
          ...state.recipe,
          steps: [...state.recipe.steps, createBlankOpStep(opName, id)],
        });
        revealStep(id);
        return;
      }
      const base = kind === 'transform' ? draft.name || 'transform' : kind;
      const id = generateStepId(allStepIds(state.recipe), base);
      const step = createBlankStep(kind, draft.name, id);
      pendingAddedStepFocusId = id;
      mutateAndRerender({
        ...state.recipe,
        steps: [...state.recipe.steps, step],
      });
      revealStep(id);
    });
    add.setAttribute(RECIPE_EDITOR_ADD_ATTR, '');
    addStepBtn = add;
    wrap.appendChild(add);

    return wrap;
  };

  // ────────────────────────────────────────────────────────────
  // Recipe-level event triggers
  // ────────────────────────────────────────────────────────────
  type ReaderListKey = 'prefetch_steps' | 'steps';
  interface FormResponseReaderMatch {
    listKey: ReaderListKey;
    index: number;
    id: string;
    boundToEvent: boolean;
  }

  const formResponseReaderMatches = (): FormResponseReaderMatch[] => {
    const matches: FormResponseReaderMatch[] = [];
    for (const listKey of ['prefetch_steps', 'steps'] as const) {
      for (const [index, step] of state.recipe[listKey].entries()) {
        if (step === null || typeof step !== 'object') continue;
        const candidate = step as unknown as {
          id?: unknown;
          op?: unknown;
          args?: unknown;
        };
        if (candidate.op !== FORM_RESPONSE_READER_OP || typeof candidate.id !== 'string') {
          continue;
        }
        const args = candidate.args !== null
          && typeof candidate.args === 'object'
          && !Array.isArray(candidate.args)
          ? candidate.args as Record<string, unknown>
          : undefined;
        matches.push({
          listKey,
          index,
          id: candidate.id,
          boundToEvent: args?.submission_id === FORM_RESPONSE_EVENT_RECORD_ID_REF,
        });
      }
    }
    return matches;
  };

  const bindFormResponseReader = (match: FormResponseReaderMatch): void => {
    const nextList = state.recipe[match.listKey].map((step, index) => {
      if (index !== match.index || step === null || typeof step !== 'object') return step;
      const current = step as unknown as Record<string, unknown>;
      const currentArgs = current.args !== null
        && typeof current.args === 'object'
        && !Array.isArray(current.args)
        ? current.args as Record<string, unknown>
        : {};
      return {
        ...current,
        args: {
          ...currentArgs,
          submission_id: FORM_RESPONSE_EVENT_RECORD_ID_REF,
        },
      };
    });
    pendingAddedStepFocusId = match.id;
    mutateAndRerender({
      ...state.recipe,
      [match.listKey]: nextList,
    } as RecipeDefinition);
    revealStep(match.id);
  };

  const addFormResponseReader = (): void => {
    const id = generateStepId(allStepIds(state.recipe), 'form_response');
    const reader: PrefetchOpStep = {
      id,
      op: FORM_RESPONSE_READER_OP,
      args: { submission_id: FORM_RESPONSE_EVENT_RECORD_ID_REF },
    };
    pendingAddedStepFocusId = id;
    mutateAndRerender({
      ...state.recipe,
      prefetch_steps: [...state.recipe.prefetch_steps, reader],
    });
    revealStep(id);
  };

  const patchEventTrigger = (index: number, trigger: RecipeEventTrigger): void => {
    const triggers = [...(state.recipe.event_triggers ?? [])];
    if (index < 0 || index >= triggers.length) return;
    triggers[index] = trigger;
    state.recipe = { ...state.recipe, event_triggers: triggers };
    markDirty();
  };

  const removeEventTrigger = (index: number): void => {
    const current = state.recipe.event_triggers ?? [];
    if (index < 0 || index >= current.length) return;
    const triggers = current.filter((_, i) => i !== index);
    pendingTriggerFocus = {
      index: triggers.length === 0
        ? null
        : Math.min(index, triggers.length - 1),
    };
    const next = { ...state.recipe };
    if (triggers.length > 0) next.event_triggers = triggers;
    else delete next.event_triggers;
    mutateAndRerender(next);
  };

  const ingressMatchesWebhookRequirement = (
    ingress: WebhookIngressView,
    requirement: RecipeWebhookRequirement,
    triggerEventTypes: readonly string[],
  ): boolean => ingress.intake_state === 'enabled'
    && requirement.profile_ids.includes(ingress.profile_id)
    && (requirement.registration_modes === undefined
      || requirement.registration_modes.includes(ingress.registration_mode))
    && (requirement.required_event_types ?? []).every((eventType) =>
      ingress.selected_event_types.includes(eventType))
    && triggerEventTypes.every((eventType) =>
      ingress.selected_event_types.includes(eventType))
    && !(requirement.environment_policy === 'test_only' && ingress.environment !== 'test')
    && !(requirement.environment_policy === 'live_only' && ingress.environment !== 'live')
    && !(requirement.environment_policy === 'match_connection'
      && ingress.paired_connection_id === null)
    && !(requirement.paired_connection_slot !== undefined
      && ingress.paired_connection_id === null);

  const setWebhookArmed = (armed: boolean): void => {
    if (disposed
      || rpcInFlight
      || webhookBusy
      || (armed && state.dirty)
      || !options.webhookControl) {
      return;
    }
    webhookBusy = true;
    webhookError = null;
    rerender();
    const caller = armed
      ? options.webhookControl.armCaller
      : options.webhookControl.disarmCaller;
    void caller({ recipe_id: persistedRecipeId }).then(
      (result) => {
        webhookBusy = false;
        if (disposed) return;
        webhookStatus = result.webhook;
        state.status = armed ? 'Webhook trigger armed' : 'Webhook trigger disarmed';
        rerender();
        announce(state.status);
      },
      (error: unknown) => {
        webhookBusy = false;
        if (disposed) return;
        webhookError = errorMessage(error);
        state.status = webhookError;
        rerender();
        announce(state.status);
      },
    );
  };

  const ownWebhookAuthorityButton = (button: HTMLButtonElement): void => {
    webhookAuthorityBtn = button;
    if (webhookBusy) {
      // The handler guard is the single-flight authority. Keep the command in
      // the focus order while its RPC owns the editor so the repaint does not
      // strand a keyboard user on <body>.
      button.setAttribute('aria-disabled', 'true');
      button.setAttribute('aria-busy', 'true');
    }
  };

  const focusWebhookIngressAfterRender = (binding: string): void => {
    pendingFieldFocus = {
      fieldKey: `webhook_ingress:${binding}`,
      occurrence: 0,
      selectionStart: null,
      selectionEnd: null,
      reveal: true,
    };
  };

  const renderWebhooksSection = (host2: HTMLElement): void => {
    const requirements = state.recipe.webhook_requirements ?? [];
    const triggers = state.recipe.webhook_triggers ?? [];
    if (requirements.length === 0 && triggers.length === 0 && !options.webhookControl) return;

    const section = doc.createElement('section');
    section.className = 'recipe-editor-section';
    section.setAttribute(RECIPE_EDITOR_WEBHOOKS_ATTR, '');
    const header = doc.createElement('div');
    header.className = 'recipe-editor-section-header';
    appendText(doc, header, 'h2', 'Inbound webhook');
    const label = state.dirty && webhookStatus?.configured
      ? 'Binding changes pending'
      : webhookStatus?.armed
        ? 'Armed'
        : webhookStatus?.configured
          ? 'Disarmed'
          : 'Not configured';
    const meta = appendText(doc, header, 'span', label);
    meta.className = 'recipe-editor-section-meta';
    section.appendChild(header);
    const hint = appendText(
      doc,
      section,
      'p',
      'Choose an enabled compatible ingress for every logical binding. Saving always '
        + 'leaves this recipe disarmed; arming is a separate owner action.',
    );
    hint.className = 'recipe-editor-hint';

    if (requirements.length === 0 && triggers.length === 0) {
      const row = doc.createElement('div');
      row.className = 'recipe-editor-webhook-row';
      const copy = doc.createElement('div');
      appendText(doc, copy, 'strong', 'Add a webhook trigger');
      appendText(
        doc,
        copy,
        'code',
        'The selected ingress fixes the trusted profile and admitted event set.',
      );
      row.appendChild(copy);
      const field = doc.createElement('label');
      field.textContent = 'Enabled ingress';
      const select = doc.createElement('select');
      select.setAttribute(RECIPE_EDITOR_WEBHOOK_SELECT_ATTR, 'new');
      select.setAttribute(RECIPE_EDITOR_FIELD_ATTR, 'webhook_ingress:new');
      const placeholder = doc.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Select an enabled ingress…';
      select.appendChild(placeholder);
      const candidates = options.webhookControl?.ingresses.filter(
        (ingress) => ingress.intake_state === 'enabled'
          && ingress.selected_event_types.length > 0
          && Object.prototype.hasOwnProperty.call(
            WEBHOOK_PROFILE_REGISTRY,
            ingress.profile_id,
          ),
      ) ?? [];
      for (const ingress of candidates) {
        const option = doc.createElement('option');
        option.value = ingress.ingress_id;
        option.textContent = `${ingress.display_name} · ${ingress.environment} · ${ingress.profile_id}`;
        select.appendChild(option);
      }
      field.appendChild(select);
      row.appendChild(field);
      section.appendChild(row);

      const actions = doc.createElement('div');
      actions.className = 'recipe-editor-webhook-actions';
      const add = makeButton(doc, 'Add webhook trigger', 'secondary', 'sm', () => {
        const ingress = candidates.find((candidate) => candidate.ingress_id === select.value);
        if (!ingress) return;
        const profile = WEBHOOK_PROFILE_REGISTRY[
          ingress.profile_id as keyof typeof WEBHOOK_PROFILE_REGISTRY
        ];
        const binding = 'webhook_delivery';
        webhookSelections.set(binding, ingress.ingress_id);
        focusWebhookIngressAfterRender(binding);
        mutateAndRerender({
          ...state.recipe,
          webhook_requirements: [{
            binding,
            profile_ids: [ingress.profile_id],
            required_event_types: [...ingress.selected_event_types],
            registration_modes: [ingress.registration_mode],
            environment_policy: ingress.environment === 'test'
              ? 'test_only'
              : ingress.environment === 'live'
                ? 'live_only'
                : 'any',
            decoded_payload_access: 'metadata_only',
            source_truth_policy: profile.minimum_source_truth_policy,
          }],
          webhook_triggers: [{
            binding,
            event_types: [...ingress.selected_event_types],
          }],
        });
      });
      add.setAttribute(RECIPE_EDITOR_WEBHOOK_ADD_ATTR, '');
      add.disabled = true;
      select.addEventListener('change', () => {
        add.disabled = select.value.length === 0;
      });
      actions.appendChild(add);
      if (webhookStatus?.armed) {
        const disarm = makeButton(
          doc,
          webhookBusy ? 'Disarming…' : 'Disarm saved webhook',
          'secondary',
          'sm',
          () => {
            setWebhookArmed(false);
          },
        );
        disarm.setAttribute(RECIPE_EDITOR_WEBHOOK_DISARM_ATTR, '');
        disarm.disabled = rpcInFlight;
        ownWebhookAuthorityButton(disarm);
        actions.appendChild(disarm);
      }
      const stateLabel = doc.createElement('span');
      stateLabel.setAttribute(RECIPE_EDITOR_WEBHOOK_STATUS_ATTR, '');
      stateLabel.textContent = state.dirty && webhookStatus?.armed
        ? 'The saved webhook remains armed until you save this removal.'
        : candidates.length === 0
          ? 'Create and enable a compatible ingress in Connections first.'
          : 'Adding changes only this draft; save, then arm it separately.';
      actions.appendChild(stateLabel);
      section.appendChild(actions);
      host2.appendChild(section);
      return;
    }

    // D-209 #1 Task 3 — the consent surface. The server derives the door's op
    // closure at save (`reconcileWebhookDoors`) and returns it on every
    // save/status/arm response; naming the ops HERE, next to the Arm button,
    // is what makes arming consent rather than a rubber stamp. Unlike a
    // reception form, an armed webhook's granted writes run WITHOUT a
    // per-delivery approval (two-sided enrollment IS the standing approval),
    // so the list must be visible before the owner arms.
    const door = webhookStatus?.door;
    if (door) {
      const block = doc.createElement('div');
      block.className = 'recipe-editor-webhook-door';
      block.setAttribute(RECIPE_EDITOR_WEBHOOK_DOOR_ATTR, door.state);
      if (door.state === 'refused') {
        const lede = appendText(doc, block, 'p', 'This recipe cannot run from a webhook:');
        lede.className = 'recipe-editor-webhook-door-lede';
        const refusal = door.refusal;
        appendText(
          doc,
          block,
          'code',
          refusal ? `${refusal.detail} (step ${refusal.step_id})` : 'the door mint was refused',
        );
        const help = appendText(
          doc,
          block,
          'p',
          'Deliveries are denied. Change the refused step, then save again.',
        );
        help.className = 'recipe-editor-webhook-door-help';
      } else if (door.state === 'missing') {
        const lede = appendText(doc, block, 'p', 'No door contract backs this webhook.');
        lede.className = 'recipe-editor-webhook-door-lede';
        const help = appendText(
          doc,
          block,
          'p',
          'Deliveries are denied until one exists. Re-save the recipe to mint it.',
        );
        help.className = 'recipe-editor-webhook-door-help';
      } else {
        const ops = door.operation_ids ?? [];
        const hasOps = ops.length > 0;
        // The consent copy must match the ARMED state — "Once armed …" on a
        // live webhook would read as if the deliveries it describes were
        // still hypothetical.
        const armedNow = webhookStatus?.armed === true;
        const lede = appendText(
          doc,
          block,
          'p',
          !hasOps
            ? 'This recipe calls no gated operations — the door grants nothing.'
            : armedNow
              ? 'An admitted delivery may:'
              : 'Once armed, an admitted delivery may:',
        );
        lede.className = 'recipe-editor-webhook-door-lede';
        if (hasOps) {
          const list = doc.createElement('ul');
          for (const op of ops) {
            const item = doc.createElement('li');
            appendText(doc, item, 'code', op);
            list.appendChild(item);
          }
          block.appendChild(list);
          const help = appendText(
            doc,
            block,
            'p',
            armedNow
              ? 'These run without a per-delivery approval — arming was that approval. '
                + 'Disarm to revoke it.'
              : 'These run without a per-delivery approval — arming is that approval. '
                + 'Disarm to revoke it.',
          );
          help.className = 'recipe-editor-webhook-door-help';
        }
        // The capability diff arrives only on the SAVE response that
        // re-minted (status/arm recompute the door without it). Suppress it
        // once the draft is dirty again — "this save" would then describe a
        // state the editor has already moved past.
        const added = door.added ?? [];
        const removed = door.removed ?? [];
        if (!state.dirty && (added.length > 0 || removed.length > 0)) {
          const diffLede = appendText(doc, block, 'p', 'This save changed the webhook’s authority:');
          diffLede.className = 'recipe-editor-webhook-door-lede';
          const diff = doc.createElement('ul');
          for (const op of added) {
            const item = doc.createElement('li');
            appendText(doc, item, 'code', `+ ${op}`);
            diff.appendChild(item);
          }
          for (const op of removed) {
            const item = doc.createElement('li');
            appendText(doc, item, 'code', `− ${op}`);
            diff.appendChild(item);
          }
          block.appendChild(diff);
        }
      }
      section.appendChild(block);
    }

    for (const requirement of requirements) {
      const row = doc.createElement('div');
      row.className = 'recipe-editor-webhook-row';
      const identity = doc.createElement('div');
      appendText(doc, identity, 'strong', requirement.binding);
      const eventLabel = (requirement.required_event_types ?? []).join(', ')
        || 'declared events';
      const payloadLabel = requirement.decoded_payload_access === 'scoped_read'
        ? 'decoded payload access'
        : 'metadata only';
      const truthLabel = requirement.source_truth_policy === 'provider_readback_required'
        ? 'provider read-back required'
        : 'delivery payload allowed';
      appendText(
        doc,
        identity,
        'code',
        `${requirement.profile_ids.join(' or ')} · ${eventLabel} · ${payloadLabel} · ${truthLabel}`,
      );
      row.appendChild(identity);

      const field = doc.createElement('label');
      field.textContent = 'Owner-selected ingress';
      const select = doc.createElement('select');
      select.setAttribute(RECIPE_EDITOR_WEBHOOK_SELECT_ATTR, requirement.binding);
      select.setAttribute(
        RECIPE_EDITOR_FIELD_ATTR,
        `webhook_ingress:${requirement.binding}`,
      );
      select.disabled = webhookBusy || rpcInFlight || !options.webhookControl;
      const placeholder = doc.createElement('option');
      placeholder.value = '';
      placeholder.textContent = options.webhookControl
        ? 'Select an enabled ingress…'
        : 'Webhook controls unavailable';
      select.appendChild(placeholder);
      const triggerEventTypes = triggers
        .filter((trigger) => trigger.binding === requirement.binding)
        .flatMap((trigger) => trigger.event_types);
      const compatible = options.webhookControl?.ingresses.filter((ingress) =>
        ingressMatchesWebhookRequirement(
          ingress,
          requirement,
          triggerEventTypes,
        )) ?? [];
      const selected = webhookSelections.get(requirement.binding) ?? '';
      for (const ingress of compatible) {
        const option = doc.createElement('option');
        option.value = ingress.ingress_id;
        option.textContent = `${ingress.display_name} · ${ingress.environment} · ${ingress.profile_id}`;
        select.appendChild(option);
      }
      if (selected.length > 0
        && !compatible.some((ingress) => ingress.ingress_id === selected)) {
        const unavailable = doc.createElement('option');
        unavailable.value = selected;
        unavailable.textContent = `Current selection is unavailable · ${selected}`;
        select.appendChild(unavailable);
      }
      select.value = selected;
      select.addEventListener('change', () => {
        if (select.value.length > 0) webhookSelections.set(requirement.binding, select.value);
        else webhookSelections.delete(requirement.binding);
        markDirty();
        rerender();
      });
      field.appendChild(select);
      row.appendChild(field);
      section.appendChild(row);
    }

    const actions = doc.createElement('div');
    actions.className = 'recipe-editor-webhook-actions';
    if (requirements.length === 1
      && triggers.every((trigger) => trigger.binding === requirements[0]!.binding)) {
      const remove = makeButton(doc, 'Remove webhook declaration', 'secondary', 'sm', () => {
        webhookSelections.clear();
        const next = { ...state.recipe };
        delete next.webhook_requirements;
        delete next.webhook_triggers;
        focusWebhookIngressAfterRender('new');
        mutateAndRerender(next);
      });
      remove.setAttribute(RECIPE_EDITOR_WEBHOOK_REMOVE_ATTR, '');
      remove.disabled = webhookBusy || rpcInFlight;
      actions.appendChild(remove);
    }
    if (webhookStatus?.armed) {
      const disarm = makeButton(
        doc,
        webhookBusy ? 'Disarming…' : 'Disarm webhook',
        'secondary',
        'sm',
        () => {
          setWebhookArmed(false);
        },
      );
      disarm.setAttribute(RECIPE_EDITOR_WEBHOOK_DISARM_ATTR, '');
      disarm.disabled = rpcInFlight;
      ownWebhookAuthorityButton(disarm);
      actions.appendChild(disarm);
    } else {
      const arm = makeButton(
        doc,
        webhookBusy ? 'Arming…' : 'Arm webhook',
        'primary',
        'sm',
        () => {
          setWebhookArmed(true);
        },
      );
      arm.setAttribute(RECIPE_EDITOR_WEBHOOK_ARM_ATTR, '');
      // A door in a non-minted state means the server WILL refuse the arm
      // (`webhook_not_ready`); disable proactively so the status line explains
      // instead of a failed round-trip. An absent door (substrate unwired on
      // a partial harness) keeps the pre-door behavior.
      arm.disabled = rpcInFlight
        || state.dirty
        || triggers.length === 0
        || webhookStatus?.configured !== true
        || (door !== undefined && door.state !== 'minted');
      ownWebhookAuthorityButton(arm);
      actions.appendChild(arm);
    }
    const status = doc.createElement('span');
    status.setAttribute(RECIPE_EDITOR_WEBHOOK_STATUS_ATTR, '');
    status.textContent = webhookError
      ?? (webhookBusy ? 'Updating webhook authority…'
        : state.dirty ? 'Save binding changes before arming.'
          : triggers.length === 0 ? 'Add a webhook trigger before arming.'
          : door?.state === 'missing'
            ? 'Webhook door contract missing — re-save the recipe to mint it.'
          : door?.state === 'refused'
            ? 'This recipe cannot back a webhook door; change the refused step and save.'
          : webhookStatus?.armed ? 'Future admitted deliveries can start this recipe.'
            : 'No webhook delivery can start this recipe yet.');
    actions.appendChild(status);
    const settings = doc.createElement('a');
    settings.setAttribute('href', '#connections/webhooks');
    settings.textContent = 'Manage webhook ingresses';
    actions.appendChild(settings);
    section.appendChild(actions);
    host2.appendChild(section);
  };

  const renderTriggersSection = (host2: HTMLElement): void => {
    const triggers = state.recipe.event_triggers ?? [];
    const section = doc.createElement('section');
    section.className = 'recipe-editor-section';
    section.setAttribute(RECIPE_EDITOR_TRIGGERS_ATTR, '');

    const header = doc.createElement('div');
    header.className = 'recipe-editor-section-header';
    appendText(doc, header, 'h2', 'Runs when');
    const meta = appendText(doc, header, 'span', plural(triggers.length, 'trigger'));
    meta.className = 'recipe-editor-section-meta';
    section.appendChild(header);

    const hint = appendText(
      doc,
      section,
      'p',
      'Triggers can start this recipe automatically. New triggers stay paused in Automation '
        + 'until the owner arms them. An accepted form response fires only after owner review; '
        + 'submitted answers stay behind core.data.form-response.get.',
    );
    hint.className = 'recipe-editor-hint';

    if (triggers.length === 0) {
      const empty = doc.createElement('div');
      empty.className = 'recipe-editor-empty';
      appendText(doc, empty, 'strong', 'Runs manually');
      appendText(doc, empty, 'span', 'Add a trigger to start this recipe from an event.');
      section.appendChild(empty);
    }

    for (const [index, trigger] of triggers.entries()) {
      const row = doc.createElement('div');
      row.className = 'recipe-editor-trigger-row';
      row.setAttribute(RECIPE_EDITOR_TRIGGER_ROW_ATTR, String(index));

      const body = doc.createElement('div');
      body.className = 'recipe-editor-trigger-body';
      const title = doc.createElement('div');
      title.className = 'recipe-editor-trigger-title';
      body.appendChild(title);

      const fields = doc.createElement('div');
      fields.className = 'recipe-editor-trigger-fields';
      body.appendChild(fields);
      let triggerFocusTarget: HTMLElement | null = null;

      if (trigger.on === FORM_RESPONSE_ON_SHORTHAND) {
        appendText(doc, title, 'span', 'Accepted form response');
        const code = appendText(doc, title, 'code', FORM_RESPONSE_ON_SHORTHAND);
        code.className = 'recipe-editor-trigger-code';

        const formDefinitionId = trigger.where?.form_definition_id;
        const input = makeTextInput(
          doc,
          typeof formDefinitionId === 'string' ? formDefinitionId : '',
          `event_trigger_form_definition_id:${index}`,
          (raw) => {
            const nextWhere = { ...(trigger.where ?? {}) };
            const value = raw.trim();
            if (value.length > 0) nextWhere.form_definition_id = value;
            else delete nextWhere.form_definition_id;

            const nextTrigger = { ...trigger };
            if (Object.keys(nextWhere).length > 0) nextTrigger.where = nextWhere;
            else delete nextTrigger.where;
            patchEventTrigger(index, nextTrigger);
          },
        );
        input.setAttribute(RECIPE_EDITOR_TRIGGER_FORM_ID_ATTR, String(index));
        input.setAttribute('placeholder', 'No form-definition filter');
        triggerFocusTarget = input;
        addField(doc, fields, 'Form definition ID', input);

        const otherWhere = Object.fromEntries(
          Object.entries(trigger.where ?? {}).filter(([key]) => key !== 'form_definition_id'),
        );
        if (Object.keys(otherWhere).length > 0) {
          addReadonlyField(doc, fields, 'Other filters', JSON.stringify(otherWhere));
        }

        const readerHint = appendText(
          doc,
          body,
          'span',
          'Leave this field empty to avoid form-definition narrowing; other filters shown '
            + 'still apply. The response reader below fetches the full owner-approved record.',
        );
        readerHint.className = 'recipe-editor-hint';
      } else if (typeof trigger.event === 'string') {
        appendText(doc, title, 'span', 'Custom event pattern');
        const code = appendText(doc, title, 'code', 'event');
        code.className = 'recipe-editor-trigger-code';

        const input = makeTextInput(
          doc,
          trigger.event,
          `event_trigger_event:${index}`,
          (value) => patchEventTrigger(index, { ...trigger, event: value.trim() }),
        );
        input.setAttribute(RECIPE_EDITOR_TRIGGER_EVENT_ATTR, String(index));
        input.setAttribute('placeholder', 'data.platform.slug.entity.created or run.recipe.*.completed');
        triggerFocusTarget = input;
        addField(doc, fields, 'Warehouse event pattern', input, true);
        if (trigger.filter !== undefined) {
          addReadonlyField(doc, fields, 'Dispatch filter', JSON.stringify(trigger.filter));
        }
      } else {
        appendText(doc, title, 'span', 'Advanced trigger');
        const code = appendText(doc, title, 'code', trigger.on ?? 'invalid');
        code.className = 'recipe-editor-trigger-code';
        addReadonlyField(doc, fields, 'Trigger JSON', JSON.stringify(trigger));
        const advancedHint = appendText(
          doc,
          body,
          'span',
          'This trigger uses advanced authoring fields. It is preserved unchanged here.',
        );
        advancedHint.className = 'recipe-editor-hint';
      }

      row.appendChild(body);

      const remove = makeButton(doc, 'Remove', 'danger-text', 'sm', () => {
        removeEventTrigger(index);
      });
      remove.setAttribute(RECIPE_EDITOR_TRIGGER_REMOVE_ATTR, String(index));
      remove.setAttribute('aria-label', `Remove trigger ${index + 1}`);
      row.appendChild(remove);
      renderedTriggerFocusTargets.set(index, triggerFocusTarget ?? remove);
      section.appendChild(row);
    }

    if (triggers.some((trigger) => trigger.on === FORM_RESPONSE_ON_SHORTHAND)) {
      const readers = formResponseReaderMatches();
      const ready = readers.find((reader) => reader.boundToEvent);
      const repair = ready === undefined ? readers[0] : undefined;
      const bridge = doc.createElement('div');
      bridge.className = 'recipe-editor-trigger-bridge';
      bridge.setAttribute(
        RECIPE_EDITOR_FORM_RESPONSE_READER_ATTR,
        ready !== undefined ? 'ready' : repair !== undefined ? 'needs-binding' : 'missing',
      );

      const copy = doc.createElement('div');
      copy.className = 'recipe-editor-trigger-bridge-copy';
      if (ready !== undefined) {
        appendText(doc, copy, 'strong', 'Response reader ready');
        const detail = doc.createElement('span');
        detail.textContent = 'Full answers are available to downstream steps at ';
        const ref = doc.createElement('code');
        ref.textContent = `{{step.${ready.id}.record}}`;
        detail.appendChild(ref);
        appendText(doc, detail, 'span', '.');
        copy.appendChild(detail);
      } else if (repair !== undefined) {
        appendText(doc, copy, 'strong', 'Keep or connect the existing response reader');
        appendText(
          doc,
          copy,
          'span',
          `Step ${repair.id} reads a fixed submission. Keep it and add an event reader, or `
            + `explicitly bind it to this trigger's record id.`,
        );
      } else {
        appendText(doc, copy, 'strong', 'Read the submitted answers');
        appendText(
          doc,
          copy,
          'span',
          'The event carries routing data only. Add the owner-only prefetch reader before '
            + 'building the workflow steps.',
        );
      }
      bridge.appendChild(copy);

      if (ready === undefined) {
        const addAction = makeButton(
          doc,
          repair !== undefined ? 'Add separate event reader' : 'Add response reader',
          'secondary',
          'sm',
          addFormResponseReader,
        );
        addAction.setAttribute(RECIPE_EDITOR_FORM_RESPONSE_READER_ACTION_ATTR, 'add');
        bridge.appendChild(addAction);
        if (repair !== undefined) {
          const bindAction = makeButton(
            doc,
            'Bind existing reader',
            'secondary',
            'sm',
            () => bindFormResponseReader(repair),
          );
          bindAction.setAttribute(RECIPE_EDITOR_FORM_RESPONSE_READER_ACTION_ATTR, 'bind');
          bridge.appendChild(bindAction);
        }
      }
      section.appendChild(bridge);
    }

    const draft = {
      kind: ADD_TRIGGER_KINDS[0] as AddTriggerKind,
      event: '',
    };
    const addWrap = doc.createElement('div');
    addWrap.className = 'recipe-editor-add recipe-editor-add--compact';

    const kindField = doc.createElement('div');
    kindField.className = 'recipe-editor-field';
    appendText(doc, kindField, 'label', 'Trigger');
    const kindSelect = makeSelect(
      doc,
      draft.kind,
      ADD_TRIGGER_KINDS,
      'event_trigger_add_kind',
      (value) => {
        draft.kind = value as AddTriggerKind;
        rebuildEventControl();
        syncAddTrigger();
      },
    );
    kindSelect.setAttribute(RECIPE_EDITOR_TRIGGER_ADD_KIND_ATTR, '');
    kindSelect.setAttribute('aria-label', 'Trigger type');
    triggerAddKindSelect = kindSelect;
    kindField.appendChild(kindSelect);
    addWrap.appendChild(kindField);

    const eventField = doc.createElement('div');
    eventField.className = 'recipe-editor-field';
    appendText(doc, eventField, 'label', 'Event pattern');
    addWrap.appendChild(eventField);

    let addTrigger: HTMLButtonElement | undefined;
    const canAddCustomEvent = (): boolean => {
      const event = draft.event.trim();
      return (event.startsWith('data.') || event.startsWith('run.'))
        && validateRecipeEventTriggerEntry({ event }).length === 0;
    };
    const syncAddTrigger = (): void => {
      if (addTrigger === undefined) return;
      addTrigger.disabled = draft.kind === 'Custom event pattern'
        && !canAddCustomEvent();
    };
    const rebuildEventControl = (): void => {
      while (eventField.children.length > 1) {
        eventField.removeChild(eventField.children[eventField.children.length - 1]!);
      }
      if (draft.kind === 'Custom event pattern') {
        const input = makeTextInput(doc, draft.event, 'event_trigger_add_event', (value) => {
          draft.event = value;
          syncAddTrigger();
        });
        input.setAttribute(RECIPE_EDITOR_TRIGGER_ADD_EVENT_ATTR, '');
        input.setAttribute('aria-label', 'Event pattern');
        input.setAttribute('placeholder', 'data.platform.slug.entity.created or run.recipe.*.completed');
        eventField.appendChild(input);
        const patternHint = appendText(
          doc,
          eventField,
          'span',
          "Warehouse events begin with 'data.' or 'run.'; '*' matches one segment and '**' spans segments.",
        );
        patternHint.className = 'recipe-editor-hint';
      } else {
        const fixed = doc.createElement('code');
        fixed.className = 'recipe-editor-readonly';
        fixed.textContent = 'After owner acceptance';
        eventField.appendChild(fixed);
      }
    };
    rebuildEventControl();

    addTrigger = makeButton(doc, 'Add trigger', 'secondary', 'sm', () => {
      const nextTrigger: RecipeEventTrigger = draft.kind === 'Accepted form response'
        ? { on: FORM_RESPONSE_ON_SHORTHAND }
        : { event: draft.event.trim() };
      if (
        draft.kind === 'Custom event pattern'
          ? !canAddCustomEvent()
          : validateRecipeEventTriggerEntry(nextTrigger).length > 0
      ) return;
      pendingTriggerFocus = { index: state.recipe.event_triggers?.length ?? 0 };
      mutateAndRerender({
        ...state.recipe,
        event_triggers: [...(state.recipe.event_triggers ?? []), nextTrigger],
      });
    });
    addTrigger.setAttribute(RECIPE_EDITOR_TRIGGER_ADD_ATTR, '');
    addWrap.appendChild(addTrigger);
    syncAddTrigger();
    section.appendChild(addWrap);

    host2.appendChild(section);
  };

  // ────────────────────────────────────────────────────────────
  // Recipe-level bindings: connection variables + depends_on
  // ────────────────────────────────────────────────────────────
  const renderBindingsSection = (host2: HTMLElement): void => {
    const connVars = connectionVarNames(state.recipe);
    const section = doc.createElement('section');
    section.className = 'recipe-editor-section';
    section.setAttribute(RECIPE_EDITOR_BINDINGS_ATTR, '');

    const header = doc.createElement('div');
    header.className = 'recipe-editor-section-header';
    appendText(doc, header, 'h2', 'Connections & dependencies');
    const meta = appendText(doc, header, 'span', plural(connVars.length, 'slot'));
    meta.className = 'recipe-editor-section-meta';
    section.appendChild(header);

    const hint = appendText(
      doc,
      section,
      'p',
      'One connection variable per CRM / Tier-P op-step slot, referenced as '
        + '{{config.<name>}} — a CRM op-step without one is rejected at save.',
    );
    hint.className = 'recipe-editor-hint';

    // Existing connection variables — label + kind editable, name is the key
    // ({{config.<name>}}), renamed by remove + re-add.
    for (const name of connVars) {
      const cv = state.recipe.variables[name] as {
        label?: unknown;
        connection_kind?: unknown;
      };
      const row = doc.createElement('div');
      row.className = 'recipe-editor-conn-var-row';
      row.setAttribute(RECIPE_EDITOR_CONN_VAR_ROW_ATTR, name);

      const grid = doc.createElement('div');
      grid.className = 'recipe-editor-field-grid';

      addReadonlyField(doc, grid, 'Variable', `{{config.${name}}}`);
      addField(
        doc,
        grid,
        'Label',
        makeTextInput(doc, String(cv.label ?? ''), `conn_var_label:${name}`, (next) => {
          patchVariable(name, { label: next });
          markDirty();
        }),
      );
      addField(
        doc,
        grid,
        'Kind',
        makeSelect(
          doc,
          String(cv.connection_kind ?? 'api'),
          CONNECTION_KINDS,
          `conn_var_kind:${name}`,
          (next) => {
            patchVariable(name, { connection_kind: next });
            markDirty();
          },
        ),
      );

      const removeWrap = doc.createElement('div');
      removeWrap.className = 'recipe-editor-field';
      appendText(doc, removeWrap, 'label', ' ');
      const remove = makeButton(doc, 'Remove', 'danger-text', 'sm', () => {
        const removedIndex = connVars.indexOf(name);
        const remaining = connVars.filter((candidate) => candidate !== name);
        const survivor = remaining[
          Math.min(Math.max(removedIndex, 0), remaining.length - 1)
        ] ?? null;
        pendingFieldFocus = {
          fieldKey: survivor === null
            ? 'conn_var_new_name'
            : `conn_var_label:${survivor}`,
          occurrence: 0,
          selectionStart: 0,
          selectionEnd: 0,
          reveal: true,
        };
        const nextVars = { ...state.recipe.variables };
        delete nextVars[name];
        mutateAndRerender({ ...state.recipe, variables: nextVars });
      });
      remove.setAttribute(RECIPE_EDITOR_CONN_VAR_REMOVE_ATTR, name);
      remove.setAttribute('aria-label', `Remove connection variable ${name}`);
      removeWrap.appendChild(remove);
      grid.appendChild(removeWrap);

      row.appendChild(grid);
      section.appendChild(row);
    }

    // Add-variable control — name + kind + Add.
    const draft = { name: '', kind: CONNECTION_KINDS[0] as string };
    const addWrap = doc.createElement('div');
    addWrap.className = 'recipe-editor-add recipe-editor-add--compact';

    const nameField = doc.createElement('div');
    nameField.className = 'recipe-editor-field';
    appendText(doc, nameField, 'label', 'New variable');
    const nameInput = makeTextInput(doc, '', 'conn_var_new_name', (next) => {
      draft.name = next;
    });
    nameInput.setAttribute(RECIPE_EDITOR_CONN_VAR_NAME_ATTR, '');
    nameInput.setAttribute('aria-label', 'New connection variable');
    nameInput.setAttribute('placeholder', 'crm');
    nameField.appendChild(nameInput);
    addWrap.appendChild(nameField);

    const kindField = doc.createElement('div');
    kindField.className = 'recipe-editor-field';
    appendText(doc, kindField, 'label', 'Kind');
    const kindSelect = makeSelect(doc, draft.kind, CONNECTION_KINDS, 'conn_var_new_kind', (next) => {
      draft.kind = next;
    });
    kindSelect.setAttribute(RECIPE_EDITOR_CONN_VAR_KIND_ATTR, '');
    kindSelect.setAttribute('aria-label', 'Connection kind');
    kindField.appendChild(kindSelect);
    addWrap.appendChild(kindField);

    const addVar = makeButton(doc, 'Add variable', 'secondary', 'sm', () => {
      const name = draft.name.trim();
      if (name === '') return;
      if (name in state.recipe.variables) return; // dup any variable — ignore
      pendingFieldFocus = {
        fieldKey: `conn_var_label:${name}`,
        occurrence: 0,
        selectionStart: 0,
        selectionEnd: name.length,
        reveal: true,
      };
      mutateAndRerender({
        ...state.recipe,
        variables: {
          ...state.recipe.variables,
          [name]: makeConnectionVar(name, draft.kind),
        },
      });
    });
    addVar.setAttribute(RECIPE_EDITOR_CONN_VAR_ADD_ATTR, '');
    addWrap.appendChild(addVar);
    section.appendChild(addWrap);

    // Pack dependencies (depends_on) — comma-separated Tier-P pack ids.
    const depLabel = doc.createElement('div');
    depLabel.className = 'recipe-editor-subsection-label';
    depLabel.textContent = 'Pack dependencies (depends_on)';
    section.appendChild(depLabel);

    const depGrid = doc.createElement('div');
    depGrid.className = 'recipe-editor-field-grid';
    const depInput = makeTextInput(
      doc,
      formatCSV(state.recipe.depends_on ?? []),
      'depends_on',
      (raw) => {
        const arr = parseCSV(raw);
        const next = { ...state.recipe };
        if (arr.length > 0) next.depends_on = arr;
        else delete next.depends_on;
        state.recipe = next;
        markDirty();
      },
    );
    depInput.setAttribute('placeholder', 'recued-core.hubspot, recued-core.salesforce');
    addField(doc, depGrid, 'Tier-P packs', depInput, true);
    const depHint = appendText(
      doc,
      depGrid,
      'span',
      'Comma-separated <publisher>.<pack> ids whose ops this recipe uses. '
        + 'Tier-K core.* ops need none.',
    );
    depHint.className = 'recipe-editor-hint span-full';
    section.appendChild(depGrid);

    host2.appendChild(section);
  };

  // ────────────────────────────────────────────────────────────
  // Status line (sticky topbar) + issues panel (top of content)
  // ────────────────────────────────────────────────────────────

  /** The one-line outcome readout. Lives INSIDE the sticky topbar so the
   *  result of Validate / Save appears next to the buttons that ran them —
   *  never below the fold. Announced politely to screen readers. */
  const renderStatusLine = (topbar: HTMLElement): void => {
    const hasChip = state.saveStage === 'idle' && state.status === 'Valid';
    if (state.status.length === 0 && !hasChip) return;

    const bar = doc.createElement('div');
    bar.className = 'recipe-editor-statusbar';

    if (hasChip) {
      const chip = doc.createElement('span');
      chip.setAttribute(RECIPE_EDITOR_VALID_CHIP_ATTR, '');
      chip.textContent = 'Valid';
      bar.appendChild(chip);
    }

    const status = doc.createElement('div');
    status.setAttribute(RECIPE_EDITOR_STATUS_ATTR, '');
    if (state.saveStage === 'error') status.setAttribute('data-state', 'error');
    status.textContent = state.status;
    bar.appendChild(status);

    topbar.appendChild(bar);
  };

  const renderIssues = (host2: HTMLElement): void => {
    issuesPanel = undefined;
    if (state.issues.length === 0) return;
    const issues = doc.createElement('div');
    issues.setAttribute(RECIPE_EDITOR_ISSUES_ATTR, '');
    for (const issue of state.issues) {
      const row = doc.createElement('div');
      row.setAttribute(RECIPE_EDITOR_ISSUE_ATTR, '');
      row.setAttribute('data-severity', issue.severity);
      // Meaning carried by a glyph + label (not colour alone — WCAG 1.4.1).
      if (issue.severity === 'warn') {
        const badge = appendText(doc, row, 'span', '⚠ Warning');
        badge.className = 'recipe-editor-issue-badge';
      }
      if (issue.path !== undefined && issue.path.length > 0) {
        const path = appendText(doc, row, 'span', issue.path);
        path.className = 'recipe-editor-issue-path';
      }
      appendText(doc, row, 'span', issue.message);
      issues.appendChild(row);
    }
    host2.appendChild(issues);
    issuesPanel = issues;
  };

  // ────────────────────────────────────────────────────────────
  // Full render
  // ────────────────────────────────────────────────────────────
  const rerender = (): void => {
    if (disposed) return;
    const activeBeforeRender = (
      doc.activeElement as HTMLElement | null | undefined
    ) ?? null;
    let restoreActiveField = pendingFieldFocus;
    pendingFieldFocus = null;
    if (activeBeforeRender !== null) {
      const capturedField = captureFieldFocus(activeBeforeRender);
      if (capturedField !== null) restoreActiveField = capturedField;
    }
    if (activeBeforeRender === validateBtn) {
      pendingActionFocus = 'validate';
    } else if (activeBeforeRender === saveBtn) {
      pendingActionFocus = 'save';
    } else if (activeBeforeRender === collapseAllBtn) {
      pendingActionFocus = 'collapse-all';
    } else if (activeBeforeRender === webhookAuthorityBtn) {
      pendingActionFocus = 'webhook-authority';
    } else if (
      activeBeforeRender !== null
      && activeBeforeRender !== doc.body
      && activeBeforeRender.isConnected
    ) {
      pendingActionFocus = null;
    }
    clearChildren(content);
    renderedStepFocusTargets = new Map();
    renderedConditionFocusTargets = new Map();
    renderedOpArgFocusTargets = new Map();
    renderedOpArgDraftTargets = new Map();
    renderedTriggerFocusTargets = new Map();
    triggerAddKindSelect = undefined;
    webhookAuthorityBtn = undefined;

    // Slim sticky header.
    const topbar = doc.createElement('section');
    topbar.className = 'recipe-editor-topbar';
    topbar.setAttribute('aria-label', 'Recipe editor controls');

    const header = doc.createElement('div');
    header.className = 'recipe-editor-header';

    const heading = doc.createElement('div');
    heading.className = 'recipe-editor-heading';
    const eyebrow = appendText(doc, heading, 'span', 'Recipe workspace');
    eyebrow.className = 'recipe-editor-eyebrow';
    routeHeading = appendText(doc, heading, 'h1', 'Recipe editor');
    routeHeading.setAttribute(RECIPE_EDITOR_HEADING_ATTR, '');
    routeHeading.tabIndex = -1;
    const subtitle = appendText(
      doc,
      heading,
      'span',
      'Build, validate, and save this automation.',
    );
    subtitle.className = 'recipe-editor-subtitle';
    header.appendChild(heading);

    const idField = doc.createElement('div');
    idField.className = 'recipe-editor-field';
    appendText(doc, idField, 'label', 'Recipe id');
    const idInput = makeTextInput(doc, state.recipe.recipe_id, 'recipe_id', (next) => {
      state.recipe = { ...state.recipe, recipe_id: next };
      markDirty();
    });
    idInput.setAttribute(RECIPE_EDITOR_RECIPE_ID_ATTR, '');
    idInput.setAttribute('aria-label', 'Recipe id');
    idField.appendChild(idInput);
    header.appendChild(idField);

    const nameField = doc.createElement('div');
    nameField.className = 'recipe-editor-field';
    appendText(doc, nameField, 'label', 'Name');
    const nameInput = makeTextInput(doc, state.recipe.metadata.name, 'recipe_name', (next) => {
      state.recipe = {
        ...state.recipe,
        metadata: { ...state.recipe.metadata, name: next },
      };
      markDirty();
    });
    nameInput.setAttribute(RECIPE_EDITOR_RECIPE_NAME_ATTR, '');
    nameInput.setAttribute('aria-label', 'Recipe name');
    nameField.appendChild(nameInput);
    header.appendChild(nameField);

    topbar.appendChild(header);

    const actions = doc.createElement('div');
    actions.className = 'recipe-editor-actions';

    // Label set by the syncActionLabels() call below — one owner for the text.
    dirtyCue = doc.createElement('span');
    dirtyCue.className = 'recipe-editor-dirty-dot';
    dirtyCue.setAttribute(RECIPE_EDITOR_DIRTY_ATTR, '');
    actions.appendChild(dirtyCue);

    validateBtn = makeButton(doc, 'Validate', 'secondary', 'sm', runValidate);
    validateBtn.setAttribute(RECIPE_EDITOR_VALIDATE_ATTR, '');
    validateBtn.setAttribute('title', 'Check this recipe without saving');
    actions.appendChild(validateBtn);

    saveBtn = makeButton(doc, saveLabel(), 'primary', 'sm', runSave);
    saveBtn.setAttribute(RECIPE_EDITOR_SAVE_ATTR, '');
    saveBtn.setAttribute('title', 'Save recipe (⌘S or Ctrl+S)');
    actions.appendChild(saveBtn);

    topbar.appendChild(actions);
    renderStatusLine(topbar);
    content.appendChild(topbar);
    topbarEl = topbar;

    syncActionLabels();

    // Issues sit at the top of the content, right under the sticky topbar
    // that reports them — not below the step list.
    renderIssues(content);

    // The event starts the recipe, then the steps do its work. Supporting
    // bindings (connection variables + depends_on) stay last.
    renderWebhooksSection(content);
    renderTriggersSection(content);
    // ⛔ OPTIONAL FIELD, and the editor assumed it was always there. Only
    // `blankRecipe()` seeds `prefetch_steps: []`; an `initialRecipe` is used
    // as given, and `parseRecipe` accepts a recipe without the key at all — so
    // a perfectly VALID recipe crashed the editor at mount with "Cannot read
    // properties of undefined (reading 'length')". Hit live on 2026-07-29 by
    // the first D-219 AI draft, but nothing about it is AI-specific: a
    // hand-written or imported recipe omitting the key crashed identically.
    if ((state.recipe.prefetch_steps?.length ?? 0) > 0) {
      renderStepsSection(content, 'Prefetch', 'prefetch_steps', []);
    }
    renderStepsSection(content, 'Steps', 'steps', [
      buildCollapseAllControl(),
      buildAddStepControl(),
    ]);

    renderBindingsSection(content);

    const ownedAction = pendingActionFocus === 'validate'
      ? validateBtn
      : pendingActionFocus === 'save'
        ? saveBtn
        : pendingActionFocus === 'collapse-all'
          ? collapseAllBtn
          : pendingActionFocus === 'webhook-authority'
            ? webhookAuthorityBtn
            : undefined;
    if (ownedAction !== undefined && !ownedAction.disabled) {
      pendingActionFocus = null;
      ownedAction.focus({ preventScroll: true });
    }
    if (restoreActiveField !== null) restoreFieldFocus(restoreActiveField);
    if (pendingAddedOpArgFocus !== null) {
      const pending = pendingAddedOpArgFocus;
      pendingAddedOpArgFocus = null;
      const target = renderedOpArgFocusTargets.get(
        `${pending.stepId}\u0000${pending.argName}`,
      );
      target?.focus({ preventScroll: true });
      target?.scrollIntoView?.({ block: 'nearest' });
    }
    if (pendingRemovedOpArgFocus !== null) {
      const pending = pendingRemovedOpArgFocus;
      pendingRemovedOpArgFocus = null;
      const target = pending.argName === null
        ? renderedOpArgDraftTargets.get(pending.stepId)
        : renderedOpArgFocusTargets.get(
            `${pending.stepId}\u0000${pending.argName}`,
          );
      target?.focus({ preventScroll: true });
      target?.scrollIntoView?.({ block: 'nearest' });
    }
    if (pendingStepActionFocus !== null) {
      const pending = pendingStepActionFocus;
      pendingStepActionFocus = null;
      const targets = renderedStepFocusTargets.get(pending.stepId);
      if (targets !== undefined) {
        const action = pending.action === 'move-up'
          ? targets.moveUp
          : targets.moveDown;
        const target = action.disabled ? targets.summary : action;
        target.focus({ preventScroll: true });
      }
    }
    if (pendingAddedStepFocusId !== null) {
      const stepId = pendingAddedStepFocusId;
      pendingAddedStepFocusId = null;
      renderedStepFocusTargets.get(stepId)?.idInput.focus({
        preventScroll: true,
      });
    }
    if (pendingRemovedStepFocus !== null) {
      const pending = pendingRemovedStepFocus;
      pendingRemovedStepFocus = null;
      const target = pending.stepId === null
        ? addStepBtn
        : renderedStepFocusTargets.get(pending.stepId)?.summary;
      target?.focus({ preventScroll: true });
    }
    if (pendingRenamedStepFocus !== null) {
      const pending = pendingRenamedStepFocus;
      pendingRenamedStepFocus = null;
      const targets = renderedStepFocusTargets.get(pending.stepId);
      if (targets !== undefined) {
        const target = pending.target === 'previous'
          ? targets.summary
          : pending.target === 'next'
            ? [targets.moveUp, targets.moveDown, targets.remove]
              .find((action) => !action.disabled)
            : targets.idInput;
        target?.focus({ preventScroll: true });
      }
    }
    if (pendingConditionFocus !== null) {
      const pending = pendingConditionFocus;
      pendingConditionFocus = null;
      const targets = renderedConditionFocusTargets.get(pending.conditionKey);
      const target = pending.part === 'field' ? targets?.field : targets?.operator;
      target?.focus({ preventScroll: true });
    }
    if (pendingTriggerFocus !== null) {
      const pending = pendingTriggerFocus;
      pendingTriggerFocus = null;
      const target = pending.index === null
        ? triggerAddKindSelect
        : renderedTriggerFocusTargets.get(pending.index);
      target?.focus({ preventScroll: true });
      target?.scrollIntoView?.({ block: 'nearest' });
    }
  };

  rerender();
  if (focusHeadingOnMount) {
    routeHeading?.focus?.({ preventScroll: true });
  }

  // Cmd/Ctrl+S saves — the reflex every editor user has. Scoped and gated:
  // the listener sits on the document (a focused field must not swallow it),
  // but persistent surfaces OUTSIDE the route (chat drawer, approvals
  // popover) survive alongside it, so only act when focus is on the editor
  // or nowhere in particular; skip while a validate/save is in flight; and
  // only save DIRTY work — recipe.save mints a new version per call, so a
  // clean reflex-save must be a no-op, not a version bump.
  const onKeydown = (event: KeyboardEvent): void => {
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
    if (rpcInFlight) return;
    if (state.saveStage === 'saving' || state.saveStage === 'validating') return;
    // Flush the in-progress field edit first — commit handlers run on
    // 'change', which a keyboard save would otherwise bypass (an uncommitted
    // step-id rename would silently save the OLD id).
    const active = (doc as Partial<Document>).activeElement as
      | (Node & HTMLElement & { blur?: () => void })
      | null
      | undefined;
    pendingFieldFocus = active === null || active === undefined
      ? null
      : captureFieldFocus(active);
    if (pendingFieldFocus === null) pendingActionFocus = 'save';
    active?.blur?.();
    if (!state.dirty) {
      if (pendingFieldFocus !== null) {
        restoreFieldFocus(pendingFieldFocus);
        pendingFieldFocus = null;
      } else {
        pendingActionFocus = null;
        active?.focus?.({ preventScroll: true });
      }
      return;
    }
    runSave();
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
      host.remove();
    },
    getRecipe() {
      return state.recipe;
    },
    hasUnsavedChanges() {
      return state.dirty;
    },
    hasInFlightWork() {
      return rpcInFlight || webhookBusy;
    },
  };
};
