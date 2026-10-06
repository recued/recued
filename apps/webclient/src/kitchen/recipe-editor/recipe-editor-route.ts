/** Kitchen recipe workbench. The route owns an unsaved document, editor history,
 * field drafts, navigation, and sample results; callers supply server simulation, validation
 * and persistence. Owner webhook controls remain separate from document history. */

import type {
  LocalRecipeWebhookStatus,
  RecipeDefinition,
  RecipeEventTrigger,
  RecipeWebhookRequirement,
  PrefetchOpStep,
  RecipeStep,
  Condition,
  ConditionOp,
  MailFactTypeSpec,
  MailTemplate,
  MailTemplateDefinition,
  VariableDefault,
  WebhookIngressBindingSelection,
  WebhookIngressView,
} from '@recued/contracts';
import {
  FORM_RESPONSE_ON_SHORTHAND,
  MAIL_FACT_BUILTIN_TYPES,
  mailFactOn,
  parseCondition,
  parseTriggerOn,
  recipeEventTriggerNotes,
  UNARY_OPS,
  validateRecipeEventTriggerEntry,
  WEBHOOK_PROFILE_REGISTRY,
} from '@recued/contracts';
import { TRANSFORM_SCHEMAS, type ParamDef } from '@recued/transforms';
import { createValueEditor, parseEditorValue, type FieldDraft } from './value-editor.js';
import { createEditorHistory, readEditorDraft, writeEditorDraft, type DraftRecovery, type EditorSnapshot } from './editor-history.js';
import { renderRecipeSettings, EDITOR_WORKBENCH_STYLES } from './editor-panels.js';
import type { RecipeSimulationResult } from '@recued/contracts';
import type { RecipeSimulationCaller } from './recipe-simulation-caller.js';
import { PRIMITIVE_STYLES } from '@recued/ui-shared/primitives';
import { RunModal, startPhrase } from '@recued/ui-shared';

import {
  applyFieldToStep,
  createBlankOpStep,
  createBlankStep,
  formatCSV,
  formatCondition,
  generateStepId,
  parseCSV,
  parseStepFieldValue,
  removeStepById,
  renameStepIdInRecipe,
  reorderSteps,
  validateStepIdRename,
} from './step-utils.js';
import {
  CONDITION_OP_LABELS,
  detectStepKind,
  enumerateIngredientInputs,
  enumerateOpArgs,
  enumerateTransformParams,
  getStepDiscriminator,
  type StepKind,
} from './step-logic.js';
import {
  FORM_RESPONSE_EVENT_RECORD_ID_REF,
  FORM_RESPONSE_READER_OP,
} from './form-response-automation-seed.js';
import { humanizeRpcError } from '../../shell/rpc-error-copy.js';
import { mailTemplateVariableNames, starterChanged, starterOf, starterSourceOf } from './mail-template-starters.js';

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
/** The "+ Skip when" / "+ Fail on" / "+ Stop when" reveal buttons on a step
 *  card with no condition set — value is `<step_id>:<field>`. */
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
/** The "new connection input" name input. */
export const RECIPE_EDITOR_CONN_VAR_NAME_ATTR = 'data-recued-recipe-editor-conn-var-name';
/** The "new connection input" kind select. */
export const RECIPE_EDITOR_CONN_VAR_KIND_ATTR = 'data-recued-recipe-editor-conn-var-kind';
/** The "Add variable" button. */
export const RECIPE_EDITOR_CONN_VAR_ADD_ATTR = 'data-recued-recipe-editor-conn-var-add';
/** D-315 §5.2 — the recipe's mail template settings, each row (value = the
 *  setting's name), its "copy from" choice, its copy button, and the add
 *  control's name input and button. */
export const RECIPE_EDITOR_MAIL_TEMPLATES_ATTR = 'data-recued-recipe-editor-mail-templates';
export const RECIPE_EDITOR_MAIL_TEMPLATE_ROW_ATTR = 'data-recued-recipe-editor-mail-template';
export const RECIPE_EDITOR_MAIL_TEMPLATE_SOURCE_ATTR = 'data-recued-recipe-editor-mail-template-source';
export const RECIPE_EDITOR_MAIL_TEMPLATE_COPY_ATTR = 'data-recued-recipe-editor-mail-template-copy';
export const RECIPE_EDITOR_MAIL_TEMPLATE_NAME_ATTR = 'data-recued-recipe-editor-mail-template-name';
export const RECIPE_EDITOR_MAIL_TEMPLATE_ADD_ATTR = 'data-recued-recipe-editor-mail-template-add';
/** Recipe-level warehouse-event subscriptions. */
export const RECIPE_EDITOR_TRIGGERS_ATTR = 'data-recued-recipe-editor-triggers';
/** One event-trigger row — value is its array index. */
export const RECIPE_EDITOR_TRIGGER_ROW_ATTR = 'data-recued-recipe-editor-trigger';
/** Editable form-definition narrowing on the accepted-response preset. */
export const RECIPE_EDITOR_TRIGGER_FORM_ID_ATTR =
  'data-recued-recipe-editor-trigger-form-id';
/** Editable raw warehouse-bus pattern on a custom trigger. */
export const RECIPE_EDITOR_TRIGGER_EVENT_ATTR = 'data-recued-recipe-editor-trigger-event';
/** A mail-fact trigger's controls (D-315 §5.1) — value is `<index>:type`,
 *  `<index>:field:<name>`, `<index>:where`, `<index>:value` or
 *  `<index>:problems`. */
export const RECIPE_EDITOR_TRIGGER_FACT_ATTR = 'data-recued-recipe-editor-trigger-fact';
/** Per-row remove control — value is its array index. */
export const RECIPE_EDITOR_TRIGGER_REMOVE_ATTR = 'data-recued-recipe-editor-trigger-remove';
/** New-trigger kind picker. */
export const RECIPE_EDITOR_TRIGGER_ADD_KIND_ATTR =
  'data-recued-recipe-editor-trigger-add-kind';
/** New custom-trigger event pattern input. */
export const RECIPE_EDITOR_TRIGGER_ADD_EVENT_ATTR =
  'data-recued-recipe-editor-trigger-add-event';
/** New mail-fact trigger's kind of email (`''`: any kind). */
export const RECIPE_EDITOR_TRIGGER_ADD_FACT_TYPE_ATTR =
  'data-recued-recipe-editor-trigger-add-fact-type';
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
  recovery?: DraftRecovery;
  validateCaller: (args: { recipe: RecipeDefinition }) => Promise<RecipeValidateResult>;
  simulateCaller?: RecipeSimulationCaller;
  saveCaller: (args: {
    recipe: RecipeDefinition;
    publisher_id?: string;
    webhook_bindings?: ReadonlyArray<WebhookIngressBindingSelection>;
  }) => Promise<RecipeSaveResult>;
  /** Present only on the owner Kitchen surface. MCP authoring deliberately has
   * no equivalent arm authority. */
  webhookControl?: RecipeWebhookControl;
  /** D-315 §5.1 — the kinds of email the owner made on this server, so a
   *  mail-fact trigger can watch their variables too. Without it the pickers
   *  offer the built-in kinds' alone. */
  mailFactTypesCaller?: () => Promise<{ readonly types: readonly MailFactTypeSpec[] }>;
  /** D-315 §5.2 — the author's own mail templates, so a `mail_template`
   *  setting can bring one as its starter. */
  mailTemplatesCaller?: () => Promise<{ readonly templates: readonly MailTemplate[] }>;
  /** D-315 §5.2 — one of them as a starter, checked by the author's server for
   *  anything of their mail (`mail_fact.template.starter`). */
  mailTemplateStarterCaller?: (args: { template_id: string }) => Promise<{ readonly starter: MailTemplateDefinition }>;
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
  /** `<step_id>:<field>` keys whose empty skip_when / fail_on / stop_when
   *  builder is force-shown (the user clicked its "+" button). A set field
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

const ADD_TRIGGER_KINDS = ['A form answer you accepted', 'A mail fact', 'Your own event pattern'] as const;
type AddTriggerKind = (typeof ADD_TRIGGER_KINDS)[number];

/** D-315 §5.1 — a mail-fact trigger, on one kind of email (ruling 43) or on
 *  any kind that has what it watches (ruling 42): the kind it names, or null. */
const mailFactTriggerType = (trigger: RecipeEventTrigger): string | null | undefined => {
  if (trigger.event !== undefined || typeof trigger.on !== 'string') return undefined;
  const parsed = parseTriggerOn(trigger.on);
  return parsed?.kind === 'mail_fact' ? parsed.type : undefined;
};
const isMailFactTrigger = (trigger: RecipeEventTrigger): boolean => mailFactTriggerType(trigger) !== undefined;

/** Whether the owner's kinds of email are known: until they are, a kind the
 *  recipe names that is not built in may well be one of them. */
type OwnedMailFactKinds = 'loading' | 'loaded' | 'unread';

/** The kinds a mail-fact trigger may be on: any, the built-in ones, the
 *  owner's — and one not among them, kept as the recipe names it. It is "not
 *  on this server" only once the server's kinds have been read. */
const mailFactKindOptions = (
  owned: readonly MailFactTypeSpec[],
  current: string | null,
  known: OwnedMailFactKinds,
): { value: string; label: string }[] => {
  const options = [
    { value: '', label: 'Any kind that has what it watches' },
    ...MAIL_FACT_BUILTIN_TYPES.map((kind) => ({ value: kind.id, label: kind.name })),
    ...owned.map((kind) => ({ value: kind.id, label: `${kind.name} (you made it)` })),
  ];
  if (current !== null && !options.some((option) => option.value === current)) {
    options.push({
      value: current,
      label: known === 'loaded' ? `${current} (not on this server)`
        : known === 'loading' ? `${current} (reading your kinds of email…)`
        : `${current} (your kinds of email could not be read)`,
    });
  }
  return options;
};

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
const CONDITION_FIELDS = ['skip_when', 'fail_on', 'stop_when'] as const;
type ConditionField = (typeof CONDITION_FIELDS)[number];

/** How each condition field reads on a step card. */
const CONDITION_LABELS: Record<ConditionField, string> = {
  skip_when: 'Skip when',
  fail_on: 'Fail on',
  stop_when: 'Stop when',
};

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
  ...(recipe.trigger_steps ?? []).map((s) => s.id),
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
  min-width: 0;
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
  min-width: 36px;
  min-height: 36px;
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
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-fact-fields {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  gap: 0 16px;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
[${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-fact-fields legend {
  padding: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--fg-muted);
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
  min-width: 0;
  max-width: 100%;
  color: var(--fg-muted);
  font-size: 13px;
  overflow-wrap: anywhere;
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
  min-width: 0;
  display: grid;
  gap: 6px;
  margin-top: 12px;
  /* revealIssues() scrolls this panel to the viewport top — keep it clear of
   * the sticky topbar overlaying that edge. */
  scroll-margin-top: 120px;
}
[${RECIPE_EDITOR_ISSUE_ATTR}] {
  min-width: 0;
  display: flex;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  font-size: 12px;
}
[${RECIPE_EDITOR_ISSUE_ATTR}] > * {
  min-width: 0;
  overflow-wrap: anywhere;
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
    min-width: 0;
    max-width: none;
  }
  [${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-actions {
    flex: 1 1 100%;
  }
  [${RECIPE_EDITOR_ROUTE_ATTR}] button.rx-btn {
    min-height: 36px;
  }
  [${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-section {
    min-width: 0;
    padding: 16px;
  }
  [${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-field,
  [${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-field-grid,
  [${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-trigger-fields {
    min-width: 0;
  }
  [${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-field-grid,
  [${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-trigger-fields {
    grid-template-columns: minmax(0, 1fr);
  }
  [${RECIPE_EDITOR_WEBHOOKS_ATTR}] .recipe-editor-webhook-row {
    min-width: 0;
    grid-template-columns: minmax(0, 1fr);
  }
  [${RECIPE_EDITOR_WEBHOOKS_ATTR}] .recipe-editor-webhook-row > *,
  [${RECIPE_EDITOR_WEBHOOKS_ATTR}] .recipe-editor-webhook-actions {
    min-width: 0;
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
    min-width: 36px;
    min-height: 36px;
  }
  [${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-step-id {
    grid-column: 2 / -1;
    grid-row: 2;
    width: 100%;
    min-width: 0;
  }
  [${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-step-id input {
    min-height: 36px;
  }
  [${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-field-checkbox {
    min-height: 36px;
  }
  [${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-step-disc {
    grid-column: 2 / -1;
    grid-row: 3;
    white-space: normal;
  }
  [${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-condition-row {
    grid-template-columns: minmax(0, 1fr);
  }
  [${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-arg-row {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  [${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-arg-add .recipe-editor-field {
    flex: 1 1 100%;
    min-width: 0;
  }
  [${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-trigger-row {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 340px) {
  [${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-step-summary {
    grid-template-columns: auto minmax(0, 1fr);
  }
  [${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-step-actions {
    grid-column: 1 / -1;
    grid-row: 2;
    width: 100%;
    margin-left: 0;
    justify-content: flex-end;
  }
  [${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-step-id {
    grid-column: 1 / -1;
    grid-row: 3;
  }
  [${RECIPE_EDITOR_ROUTE_ATTR}] .recipe-editor-step-disc {
    grid-column: 1 / -1;
    grid-row: 4;
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

/** A select whose options show a label apart from their value. */
const makeLabelledSelect = (
  doc: Document,
  value: string,
  options: readonly { value: string; label: string }[],
  fieldKey: string,
  onChange: (next: string) => void,
): HTMLSelectElement => {
  const select = doc.createElement('select');
  select.setAttribute(RECIPE_EDITOR_FIELD_ATTR, fieldKey);
  for (const option of options) {
    const el = doc.createElement('option');
    el.value = option.value;
    el.textContent = option.label;
    if (option.value === value) el.selected = true;
    select.appendChild(el);
  }
  select.value = value;
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
    style.textContent = [PRIMITIVE_STYLES, RECIPE_EDITOR_STYLES, EDITOR_WORKBENCH_STYLES].join('\n');
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
  let fieldDrafts: Record<string, FieldDraft> = {};
  const validationFields = new Map<HTMLElement, string>();
  let savedRecipe = state.recipe;
  let neverSaved = options.initialDirty ?? false;
  const snapshot = (): EditorSnapshot => ({ recipe: state.recipe, fields: fieldDrafts });
  const history = createEditorHistory(snapshot());
  let recoveredDraft = readEditorDraft(options.recovery);
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  let recoveryFailed = false;
  const persistDraft = (): void => {
    if (recoveryTimer !== undefined) clearTimeout(recoveryTimer);
    recoveryTimer = undefined;
    if (!options.recovery || (recoveredDraft && state.editEpoch === 0)) return;
    recoveryFailed = !writeEditorDraft(options.recovery, state.dirty
      ? { base: savedRecipe, snapshot: snapshot() } : null);
    if (recoveryFailed) {
      const status = host.querySelector?.<HTMLElement>(`[${RECIPE_EDITOR_STATUS_ATTR}]`);
      if (status) status.textContent = 'This browser cannot keep a backup copy. Save to keep your work.';
      announce('This browser cannot keep a backup copy. Save to keep your work.');
    }
  };
  const queueDraft = (): void => {
    if (!options.recovery) return;
    if (recoveryTimer !== undefined) clearTimeout(recoveryTimer);
    recoveryTimer = setTimeout(persistDraft, 250);
  };
  const panelOpen = new Set<string>();
  if ((doc.defaultView?.innerWidth ?? 1440) > 1100) panelOpen.add('outline');
  let outlineQuery = '';
  let refreshOutline: (() => void) | undefined;
  let activeOutlineStep: string | undefined;
  let undoBtn: HTMLButtonElement | undefined;
  let redoBtn: HTMLButtonElement | undefined;
  let testText = JSON.stringify({ config: {}, context: { event: {} }, mocks: {} }, null, 2);
  let testResult: RecipeSimulationResult | undefined;
  let testError = '';
  let testEpoch = -1;
  let sampleEpoch = 0;
  let testedSampleEpoch = -1;
  let testStatusEl: HTMLElement | undefined;
  let testRunBtn: HTMLButtonElement | undefined;
  let testCancelBtn: HTMLButtonElement | undefined;
  let testAbort: AbortController | undefined;
  let testGeneration = 0;
  const idsOnLoad = allStepIds(state.recipe);
  if (idsOnLoad.length > 100) for (const id of idsOnLoad.slice(1)) state.collapsed.add(id);
  const webhookSelections = new Map(
    options.webhookControl?.initialStatus.bindings.map((selection) => [
      selection.binding,
      selection.ingress_id,
    ]) ?? [],
  );
  let persistedRecipeId = state.recipe.recipe_id;
  /** D-315 §5.1 — the owner's kinds of email, once loaded: their variables
   *  join the mail-fact pickers. */
  let ownedMailFactKinds: readonly MailFactTypeSpec[] = [];
  let ownedMailFactKindsKnown: OwnedMailFactKinds = options.mailFactTypesCaller === undefined ? 'unread' : 'loading';
  /** D-315 §5.2 — the author's mail templates (null until loaded), the one each
   *  setting copies from when the author picked it, and what a copy refused. */
  let authorTemplates: readonly MailTemplate[] | null = null;
  const starterPicks = new Map<string, string>();
  const starterProblems = new Map<string, readonly string[]>();
  let starterCopying: string | null = null;
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
  host.addEventListener('focusout', () => history.breakGroup());

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
    if (recoveredDraft) {
      recoveredDraft = null;
      if (!recoveryFailed) host.querySelector?.('.recipe-editor-recovery')?.remove();
    }
    state.dirty = true;
    state.saveStage = 'idle';
    const hadIssues = state.issues.length > 0;
    state.issues = [];
    if (!rpcInFlight && !webhookBusy) state.status = 'You have changes. Check them, or save.';
    state.editEpoch += 1;
    for (const [field, key] of validationFields) {
      if (!fieldDrafts[key]) field.removeAttribute('aria-invalid');
    }
    validationFields.clear();
    for (const message of Array.from(host.querySelectorAll?.('[data-recued-recipe-validation-message]') ?? [])) message.remove();
    issuesPanel?.remove(); issuesPanel = undefined;
    statusbarEl?.remove();
    if (topbarEl) renderStatusLine(topbarEl);
    if (hadIssues || outlineQuery.trim()) refreshOutline?.();
    const active = doc.activeElement as HTMLElement | null;
    const group = active?.getAttribute?.(RECIPE_EDITOR_FIELD_ATTR) ?? undefined;
    history.record(snapshot(), group);
    queueDraft();
    syncActionLabels();
  };

  /** Mutate the recipe and rerender (structure changed — add / remove / rename /
   *  kind change / condition rebuild). */
  const mutateAndRerender = (next: RecipeDefinition): void => {
    recoveredDraft = null;
    state.recipe = next;
    state.dirty = true;
    state.saveStage = 'idle';
    state.issues = [];
    if (!rpcInFlight && !webhookBusy) state.status = 'You have changes. Check them, or save.';
    state.editEpoch += 1;
    history.record(snapshot());
    queueDraft();
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
  let statusbarEl: HTMLElement | undefined;
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
    if (testResult && testStatusEl && testEpoch !== state.editEpoch) {
      testStatusEl.textContent = `Test ${testResult.status} — recipe changed since this test`;
      testStatusEl.setAttribute('data-state', 'stale');
    }
    if (undoBtn) undoBtn.setAttribute('aria-disabled', String(!history.canUndo || rpcInFlight || webhookBusy));
    if (redoBtn) redoBtn.setAttribute('aria-disabled', String(!history.canRedo || rpcInFlight || webhookBusy));
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
    if (disposed || rpcInFlight || webhookBusy || blockInvalidFields()) return;
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
          ? 'Checked, but you have changed things since'
          : result.ok
            ? 'Valid'
            : `Check failed: ${plural(result.issues.length, 'issue')}`;
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
    if (blockInvalidFields()) return;
    if (disposed || rpcInFlight || webhookBusy) return;
    if (webhookStatus?.armed && state.recipe.recipe_id !== persistedRecipeId) {
      state.saveStage = 'error';
      state.status = 'Switch off the saved webhook before you copy this Recipe';
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
        state.status = 'You cannot change webhook settings here';
        state.issues = [{
          severity: 'error',
          message: 'Open this in your own Kitchen to choose where webhooks come in.',
        }];
        rerender();
        return;
      }
      webhookBindings = [];
      for (const requirement of requirements) {
        const ingressId = webhookSelections.get(requirement.binding);
        if (!ingressId) {
          state.saveStage = 'error';
          state.status = 'Choose where every webhook comes in before you save';
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
    const recipeAtSave = state.recipe;
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
        savedRecipe = { ...recipeAtSave, version: result.version };
        if (state.recipe.recipe_id === recipeAtSave.recipe_id) {
          state.recipe = { ...state.recipe, version: result.version };
        }
        history.updateVersion(recipeAtSave.recipe_id, result.version);
        neverSaved = false;
        recoveredDraft = null;
        state.dirty = staleEdits;
        history.breakGroup();
        if (options.recovery?.savedKey) {
          const key = options.recovery.savedKey(result.recipe_id);
          if (key !== options.recovery.key) {
            writeEditorDraft(options.recovery, null);
            options.recovery.key = key;
          }
        }
        persistDraft();
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
                message: `The Recipe was saved, but Recued could not update the address: ${errorMessage(error)}`,
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
  const locateStep = (id: string): { key: 'trigger_steps' | 'prefetch_steps' | 'steps'; index: number } | undefined => {
    for (const key of ['trigger_steps', 'prefetch_steps', 'steps'] as const) {
      const index = (state.recipe[key] ?? []).findIndex(step => step.id === id);
      if (index >= 0) return { key, index };
    }
    return undefined;
  };
  const fieldPath = (key: string, stepId?: string): string => {
    if (!stepId) return key;
    const location = locateStep(stepId);
    const suffix = key.replace(/^param:/, '').replace(/^input:/, 'input.').replace(/^arg:/, 'args.');
    return location ? `${location.key}[${location.index}].${suffix}` : key;
  };
  const valueField = (
    label: string, key: string, value: unknown, schema: ParamDef | undefined,
    apply: (next: unknown) => void, stepId?: string,
  ): HTMLElement => {
    const draftKey = JSON.stringify([stepId ?? '', key]);
    const field = doc.createElement('div');
    const compact = stepId !== undefined && ['string', 'number', 'boolean'].includes(schema?.type ?? '');
    field.className = compact ? 'recipe-editor-field' : 'recipe-editor-field span-full';
    appendText(doc, field, 'label', label + (schema?.required ? ' *' : ''));
    const patch = (next: unknown, draft?: FieldDraft): void => {
      if (draft) fieldDrafts[draftKey] = draft;
      else { delete fieldDrafts[draftKey]; apply(next); }
      markDirty();
    };
    field.appendChild(createValueEditor({
      document: doc, fieldAttribute: RECIPE_EDITOR_FIELD_ATTR, fieldKey: key,
      label: stepId ? `${label} for step ${stepId}` : label, value, schema,
      draft: fieldDrafts[draftKey],
      references: stepId ? () => {
        const ids = allStepIds(state.recipe);
        const phase = locateStep(stepId)?.key;
        const earlier = ids.slice(0, ids.indexOf(stepId)).filter(id =>
          phase !== 'prefetch_steps' || locateStep(id)?.key !== 'prefetch_steps');
        return [
          ...earlier.map(id => {
            const ns = locateStep(id)?.key === 'trigger_steps' ? 'trigger' : 'step';
            return { value: `{{${ns}.${id}}}`, label: `Output: ${id}` };
          }),
          ...Object.keys(state.recipe.variables).map(name => ({ value: `{{config.${name}}}`, label: `Variable: ${name}` })),
          { value: '{{context.event}}', label: 'Trigger event' },
        ];
      } : undefined,
      change: patch,
      chooseReference: next => {
        patch(next);
        pendingFieldFocus = { fieldKey: key, occurrence: 0, selectionStart: null, selectionEnd: null };
        rerender();
        revealIssue(fieldPath(key, stepId));
      },
    }));
    return field;
  };
  const blockInvalidFields = (): boolean => {
    const local = Object.entries(fieldDrafts).map(([key, draft]) => {
      const [stepId, field] = JSON.parse(key) as [string, string];
      return { path: fieldPath(field, stepId || undefined), message: draft.error, severity: 'error' as const };
    });
    if (!local.length) return false;
    state.issues = local;
    state.status = 'Fill in the boxes marked before you check or save.';
    state.saveStage = 'error';
    rerender(); revealIssues();
    return true;
  };
  const changeHistory = (direction: 'undo' | 'redo'): void => {
    if (rpcInFlight || webhookBusy) return;
    const active = doc.activeElement as HTMLElement | null;
    const focus = active ? captureFieldFocus(active) : null;
    const next = history[direction]();
    if (!next) return;
    state.recipe = adoptRecipe(next.recipe)!;
    fieldDrafts = next.fields;
    state.dirty = neverSaved || JSON.stringify(state.recipe) !== JSON.stringify(savedRecipe) || Object.keys(fieldDrafts).length > 0;
    state.editEpoch += 1; state.issues = []; state.saveStage = 'idle';
    state.status = direction === 'undo' ? 'Undid last edit' : 'Redid edit';
    pendingFieldFocus = focus;
    queueDraft(); rerender(); announce(state.status);
    if (!focus) (direction === 'undo' ? undoBtn : redoBtn)?.focus();
  };
  const issueDestination = (path: string): { stepId?: string; field: string } => {
    const normalized = path.replace(/^recipe\./, '');
    const match = /^(steps|prefetch_steps|trigger_steps)(?:\[(\d+)\]|\.(\d+))(?:\.(.*))?/.exec(normalized);
    if (match) {
      const key = match[1] as 'steps' | 'prefetch_steps' | 'trigger_steps';
      const step = state.recipe[key]?.[Number(match[2] ?? match[3])];
      const suffix = match[4] ?? 'id';
      let field = suffix === 'id' ? 'step_id' : suffix;
      if (/^(skip_when|fail_on|stop_when)([.\[]|$)/.test(suffix)) field = suffix.split(/[.\[]/)[0]!;
      else if (suffix.startsWith('args.')) field = `arg:${suffix.slice(5).split(/[.\[]/)[0]}`;
      else if (suffix.startsWith('input.')) field = `input:${suffix.slice(6).split(/[.\[]/)[0]}`;
      else if (step && detectStepKind(step as RecipeStep) === 'transform'
        && !['step_id', 'skip_when', 'fail_on', 'stop_when'].includes(field)) field = `param:${suffix.split(/[.\[]/)[0]}`;
      return { stepId: step?.id, field };
    }
    if (/^output([.\[]|$)/.test(normalized)) return { field: 'output' };
    const variable = /^variables\.([^.\[]+)/.exec(normalized)?.[1];
    if (variable && mailTemplateVariableNames(state.recipe).includes(variable)) {
      return { field: `mail_template_label:${variable}` };
    }
    if (variable) return { field: connectionVarNames(state.recipe).includes(variable)
      ? `${normalized.endsWith('.kind') ? 'conn_var_kind' : 'conn_var_label'}:${variable}`
      : `variables.${variable}` };
    return { field: normalized === 'metadata.name' ? 'recipe_name' : normalized };
  };
  const revealIssue = (path: string): void => {
    const destination = issueDestination(path);
    let scope: HTMLElement = host;
    if (destination.stepId) {
      const cards = host.querySelectorAll?.<HTMLElement>(`[${RECIPE_EDITOR_ROW_ATTR}]`);
      const card = cards ? Array.from(cards).find(el => el.getAttribute(RECIPE_EDITOR_ROW_ATTR) === destination.stepId) : undefined;
      if (card) { card.setAttribute('open', ''); state.collapsed.delete(destination.stepId); scope = card; }
    }
    const fields = scope.querySelectorAll?.<HTMLElement>(`[${RECIPE_EDITOR_FIELD_ATTR}]`);
    const target = fields ? Array.from(fields).find(el => el.getAttribute(RECIPE_EDITOR_FIELD_ATTR) === destination.field)
      ?? Array.from(fields).find(el => destination.field.startsWith(`${el.getAttribute(RECIPE_EDITOR_FIELD_ATTR)}.`)) : undefined;
    const fallback = target ?? (scope === host ? editorFields('recipe_id')[0] : scope.querySelector?.<HTMLElement>('summary'));
    let ancestor = fallback?.parentElement;
    while (ancestor && ancestor !== host) {
      if (ancestor.tagName === 'DETAILS') ancestor.setAttribute('open', '');
      ancestor = ancestor.parentElement;
    }
    fallback?.focus?.({ preventScroll: true });
    fallback?.scrollIntoView?.({ block: 'center' });
  };
  const renderOutline = (): HTMLElement => {
    const nav = doc.createElement('nav'); nav.className = 'recipe-editor-outline';
    nav.setAttribute('aria-label', 'The steps in this Recipe');
    const disclosure = doc.createElement('details');
    disclosure.setAttribute('data-recued-recipe-outline', '');
    const summary = appendText(doc, disclosure, 'summary', '');
    appendText(doc, summary, 'span', 'The steps');
    appendText(doc, summary, 'span', plural(allStepIds(state.recipe).length, 'step')).className = 'recipe-editor-panel-hint';
    rememberPanel(disclosure, 'outline'); nav.appendChild(disclosure);
    const body = doc.createElement('div'); body.className = 'recipe-editor-panel-body'; disclosure.appendChild(body);
    const shortcuts = doc.createElement('div'); shortcuts.className = 'recipe-editor-outline-shortcuts';
    for (const [label, selector, panel] of [
      ['Settings', '[data-recued-recipe-settings]', 'settings'],
      ['Runs when', `[${RECIPE_EDITOR_TRIGGERS_ATTR}]`, ''],
      ['Connections', `[${RECIPE_EDITOR_BINDINGS_ATTR}]`, ''],
      ['Sample test', '[data-recued-recipe-test]', 'test'],
    ] as const) {
      const link = makeButton(doc, label, 'secondary', 'sm', () => {
        const target = host.querySelector<HTMLElement>(selector);
        if (!target) return;
        if (panel) { target.setAttribute('open', ''); panelOpen.add(panel); }
        const heading = target.querySelector<HTMLElement>('summary, h2');
        if (heading) {
          if (heading.tagName !== 'SUMMARY') heading.tabIndex = -1;
          heading.focus({ preventScroll: true });
        }
        target.scrollIntoView({ block: 'center' });
      });
      shortcuts.appendChild(link);
    }
    body.appendChild(shortcuts);
    const toolbar = doc.createElement('div'); toolbar.className = 'recipe-editor-search';
    const search = makeTextInput(doc, outlineQuery, 'outline_search', next => { outlineQuery = next; paint(); });
    search.type = 'search'; search.setAttribute('aria-label', 'Search the steps');
    search.placeholder = 'Find a step…'; toolbar.appendChild(search);
    const clear = makeButton(doc, 'Clear', 'secondary', 'sm', () => {
      outlineQuery = ''; search.value = ''; paint(); search.focus();
    });
    clear.setAttribute('aria-label', 'Clear the step search'); toolbar.appendChild(clear);
    body.appendChild(toolbar);
    const countLabel = appendText(doc, body, 'span', '');
    countLabel.className = 'recipe-editor-search-count'; countLabel.setAttribute('role', 'status');
    const list = doc.createElement('div'); list.className = 'recipe-editor-outline-list'; body.appendChild(list);
    search.addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (event.key === 'Escape' && outlineQuery) { event.preventDefault(); event.stopPropagation(); clear.click(); }
      if (event.key === 'Enter') { event.preventDefault(); list.querySelector<HTMLButtonElement>('button')?.click(); }
    });
    const paint = (): void => {
      clearChildren(list);
      const query = outlineQuery.toLowerCase().trim();
      clear.hidden = outlineQuery.length === 0;
      let count = 0;
      for (const key of ['trigger_steps', 'prefetch_steps', 'steps'] as const) {
        const group = doc.createElement('div'); group.className = 'recipe-editor-outline-group';
        appendText(doc, group, 'span', key === 'trigger_steps' ? 'Trigger steps' : key === 'prefetch_steps' ? 'Prefetch' : 'Steps')
          .className = 'recipe-editor-outline-group-title';
        for (const [index, step] of (state.recipe[key] ?? []).entries()) {
          if (query && !JSON.stringify(step).toLowerCase().includes(query)) continue;
          count += 1;
          const issues = state.issues.filter(issue => issue.path && issueDestination(issue.path).stepId === step.id);
          const link = makeButton(doc, '', 'secondary', 'sm', () => {
            activeOutlineStep = step.id;
            for (const item of Array.from(list.querySelectorAll<HTMLElement>('[data-recued-recipe-outline-step]'))) {
              if (item.getAttribute('data-recued-recipe-outline-step') === step.id) item.setAttribute('aria-current', 'step');
              else item.removeAttribute('aria-current');
            }
            revealIssue(`${key}[${index}].id`);
          });
          appendText(doc, link, 'span', String(index + 1)).className = 'recipe-editor-outline-number';
          const copy = doc.createElement('span'); copy.className = 'recipe-editor-outline-copy';
          appendText(doc, copy, 'strong', step.id);
          appendText(doc, copy, 'span', getStepDiscriminator(step as RecipeStep)); link.appendChild(copy);
          if (issues.length) appendText(doc, link, 'span', `⚠ ${issues.length}`);
          link.setAttribute('data-recued-recipe-outline-step', step.id);
          if (issues.length) link.setAttribute('data-has-error', '');
          if (activeOutlineStep === step.id) link.setAttribute('aria-current', 'step');
          group.appendChild(link);
        }
        if (group.children.length > 1) list.appendChild(group);
      }
      countLabel.textContent = query ? `${count} of ${plural(allStepIds(state.recipe).length, 'step')}` : '';
      if (!count) appendText(doc, list, 'span', query ? 'No steps match. Try a name, something it does, or an input.' : 'Add a step to begin.').className = 'recipe-editor-outline-empty';
    };
    refreshOutline = paint; paint();
    return nav;
  };
  const rememberPanel = (panel: HTMLElement, key: string): void => {
    if (panelOpen.has(key)) panel.setAttribute('open', '');
    panel.addEventListener('toggle', () => {
      if (panel.isConnected === false) return;
      if (panel.hasAttribute('open')) panelOpen.add(key); else panelOpen.delete(key);
    });
  };
  const renderRecovery = (): HTMLElement | null => {
    if (!recoveredDraft && !recoveryFailed) return null;
    const row = doc.createElement('div'); row.className = 'recipe-editor-recovery';
    if (recoveryFailed) appendText(doc, row, 'span', 'This browser cannot keep a backup copy. Save this draft to keep your work.');
    if (recoveredDraft) {
      appendText(doc, row, 'span', JSON.stringify(recoveredDraft.base) === JSON.stringify(savedRecipe)
        ? 'There is unsaved work from this tab.'
        : 'There is unsaved work. The saved Recipe has changed since then.');
      row.appendChild(makeButton(doc, 'Restore draft', 'secondary', 'sm', () => {
        if (!recoveredDraft) return;
        fieldDrafts = recoveredDraft.snapshot.fields;
        const recipe = recoveredDraft.snapshot.recipe;
        recoveredDraft = null;
        mutateAndRerender(adoptRecipe(recipe)!);
      }));
      row.appendChild(makeButton(doc, 'Discard draft', 'secondary', 'sm', () => {
        recoveredDraft = null; writeEditorDraft(options.recovery, null); rerender();
      }));
    }
    return row;
  };
  const renderTestPanel = (): HTMLElement => {
    const section = doc.createElement('details'); section.className = 'recipe-editor-section recipe-editor-test';
    section.setAttribute('data-recued-recipe-test', '');
    const summary = appendText(doc, section, 'summary', '');
    appendText(doc, summary, 'span', 'Test with sample data');
    appendText(doc, summary, 'span', 'Sample preview').className = 'recipe-editor-panel-hint';
    rememberPanel(section, 'test');
    const body = doc.createElement('div'); body.className = 'recipe-editor-panel-body'; section.appendChild(body);
    appendText(doc, body, 'p', 'Try it out with made-up inputs and pretend results. Nothing real is called.').className = 'recipe-editor-test-intro';
    const help = doc.createElement('details'); help.className = 'recipe-editor-test-help';
    appendText(doc, help, 'summary', 'How to write sample data');
    appendText(doc, help, 'p', 'Use config to change settings, context for event details, and mocks to pretend what a step sent back. Key them by step id.');
    appendText(doc, help, 'pre', JSON.stringify({ config: {}, context: { event: {} }, mocks: { read: { result: [] } } }, null, 2));
    appendText(doc, help, 'p', 'For different outputs in a loop, use {"iterations": [...]}. To test a failed call, use {"error": "message"}.');
    rememberPanel(help, 'test-help'); body.appendChild(help);
    const sampleLabel = appendText(doc, body, 'label', 'Sample data (JSON)');
    sampleLabel.className = 'recipe-editor-sample-label';
    const sample = makeTextArea(doc, testText, 'test_sample', next => {
      testText = next; sampleEpoch += 1; testError = '';
      if (testStatusEl) {
        testStatusEl.textContent = 'You changed the sample. Run it again';
        testStatusEl.setAttribute('data-state', 'stale');
      }
    });
    sample.setAttribute('aria-label', 'Sample settings, event details, data and pretend results (JSON)'); sample.rows = 8;
    body.appendChild(sample);
    const status = appendText(doc, body, 'p', testAbort ? 'Testing…' : testError || (testResult
      ? `Test ${testResult.status}${testEpoch !== state.editEpoch ? ' — recipe changed since this test' : testedSampleEpoch !== sampleEpoch ? ' — sample changed since this test' : ''}` : 'Ready to test'));
    status.setAttribute('role', 'status'); status.setAttribute('data-recued-recipe-test-status', '');
    status.setAttribute('data-state', testAbort ? 'running' : testError ? 'failed'
      : testResult && (testEpoch !== state.editEpoch || testedSampleEpoch !== sampleEpoch) ? 'stale' : testResult?.status ?? 'ready');
    testStatusEl = status;
    const actions = doc.createElement('div'); actions.className = 'recipe-editor-actions'; body.appendChild(actions);
    const run = makeButton(doc, testAbort ? 'Testing…' : 'Test recipe', 'primary', 'sm', () => {
      if (testAbort || blockInvalidFields()) return;
      if (!options.simulateCaller) { testError = 'This server cannot try Recipes out.'; rerender(); return; }
      let sampleInput: unknown;
      try {
        sampleInput = JSON.parse(testText);
        if (!sampleInput || typeof sampleInput !== 'object' || Array.isArray(sampleInput)) throw new Error('Sample data must be a JSON object.');
      } catch (error) { testError = errorMessage(error); rerender(); return; }
      const controller = new AbortController(); testAbort = controller;
      const generation = ++testGeneration; testEpoch = state.editEpoch; testedSampleEpoch = sampleEpoch;
      const recipe = JSON.parse(JSON.stringify(state.recipe)) as RecipeDefinition;
      testError = ''; testResult = undefined; panelOpen.add('test'); rerender();
      void options.simulateCaller({ recipe, sample: sampleInput }, controller.signal).then(result => {
        controller.signal.throwIfAborted();
        if (!disposed && generation === testGeneration) testResult = result;
      }).catch((error: unknown) => {
        if (!disposed && generation === testGeneration) testError = controller.signal.aborted ? 'Test cancelled' : errorMessage(error);
      }).finally(() => {
        if (disposed || generation !== testGeneration) return;
        testAbort = undefined; rerender();
      });
    });
    run.setAttribute('data-recued-recipe-test-run', ''); run.setAttribute('aria-disabled', String(testAbort !== undefined)); run.setAttribute('aria-busy', String(testAbort !== undefined)); testRunBtn = run; actions.appendChild(run);
    testCancelBtn = undefined;
    if (testAbort) {
      testCancelBtn = makeButton(doc, 'Cancel test', 'secondary', 'sm', () => testAbort?.abort());
      actions.appendChild(testCancelBtn);
    }
    if (testResult) {
      const results = doc.createElement('div'); results.className = 'recipe-editor-test-results';
      const counts = new Map<string, number>();
      for (const step of testResult.steps) counts.set(step.status, (counts.get(step.status) ?? 0) + 1);
      const totals = appendText(doc, results, 'p', Array.from(counts, ([key, count]) => `${count} ${key}`).join(' · '));
      totals.className = 'recipe-editor-test-totals';
      for (const step of testResult.steps) {
        const detail = doc.createElement('details');
        detail.setAttribute('data-state', step.status);
        const summary = appendText(doc, detail, 'summary', `${step.id} · ${step.status}${step.mocked ? ' · mocked' : ''}`);
        summary.setAttribute('data-recued-recipe-test-step', step.id);
        if (step.message) appendText(doc, detail, 'p', step.message);
        const values = doc.createElement('div'); values.className = 'recipe-editor-test-values';
        for (const [label, value] of [['Input', step.input], ['Output', step.output]] as const) {
          const valueHost = doc.createElement('div');
          appendText(doc, valueHost, 'strong', label); appendText(doc, valueHost, 'pre', JSON.stringify(value, null, 2) ?? `No ${label.toLowerCase()}`);
          values.appendChild(valueHost);
        }
        detail.appendChild(values);
        const location = locateStep(step.id);
        if (location) detail.appendChild(makeButton(doc, 'Go to step', 'secondary', 'sm', () => revealIssue(`${location.key}[${location.index}].id`)));
        results.appendChild(detail);
      }
      body.appendChild(results);
    }
    return section;
  };

  const renderConditionField = (
    step: RecipeStep,
    listKey: 'trigger_steps' | 'prefetch_steps' | 'steps',
    field: ConditionField,
    grid: HTMLElement,
  ): void => {
    const raw = (step as Record<string, unknown>)[field];
    const current = conditionFieldString(raw);
    const conditionLabel = CONDITION_LABELS[field];

    if (isObjectCondition(raw)) {
      stepValue(grid, step, listKey, conditionLabel, field, raw, { type: 'object' });
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
    label.textContent = conditionLabel;
    section.appendChild(label);

    const row = doc.createElement('div');
    row.className = 'recipe-editor-condition-row';

    const fieldInput = makeTextInput(doc, parts.field, field, (next) => {
      parts.field = next;
    });
    fieldInput.setAttribute(
      'aria-label',
      `${conditionLabel} source for step ${step.id}`,
    );
    fieldInput.setAttribute('placeholder', '{{step.x}}');
    fieldInput.setAttribute('data-recued-recipe-deferred-value', parts.field);
    fieldInput.addEventListener('change', () => {
      fieldInput.setAttribute('data-recued-recipe-deferred-value', fieldInput.value);
      applyCondition(false);
    });
    row.appendChild(fieldInput);

    const opOptions = ['', ...CONDITION_OP_LABELS.map((entry) => entry.op)];
    const opSelect = makeSelect(doc, parts.operator, opOptions, `${field}_op`, (next) => {
      const priorUnary = UNARY_OPS.has(parts.operator as ConditionOp);
      parts.operator = next;
      const nextUnary = UNARY_OPS.has(parts.operator as ConditionOp);
      applyCondition(priorUnary !== nextUnary);
    });
    opSelect.setAttribute(
      'aria-label',
      `${conditionLabel} operator for step ${step.id}`,
    );
    row.appendChild(opSelect);

    const unary = UNARY_OPS.has(parts.operator as ConditionOp);
    if (!unary) {
      const valueInput = makeTextInput(doc, parts.value, `${field}_value`, (next) => {
        parts.value = next;
      });
      valueInput.setAttribute(
        'aria-label',
        `${conditionLabel} value for step ${step.id}`,
      );
      valueInput.setAttribute('placeholder', 'value');
      valueInput.setAttribute('data-recued-recipe-deferred-value', parts.value);
      valueInput.addEventListener('change', () => {
        valueInput.setAttribute('data-recued-recipe-deferred-value', valueInput.value);
        applyCondition(false);
      });
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
  const stepValue = (
    grid: HTMLElement, step: RecipeStep, listKey: 'trigger_steps' | 'prefetch_steps' | 'steps',
    name: string, key: string, value: unknown, schema?: ParamDef,
  ): void => {
    const field = valueField(name, key, value, schema, next => {
      const nextList = applyFieldToStep(state.recipe[listKey] as RecipeStep[], step.id, key, next);
      state.recipe = { ...state.recipe, [listKey]: nextList } as RecipeDefinition;
    }, step.id);
    grid.appendChild(field);
  };

  const renderTransformBody = (
    step: RecipeStep, listKey: 'trigger_steps' | 'prefetch_steps' | 'steps', grid: HTMLElement,
  ): void => {
    for (const { name, value, def } of enumerateTransformParams(step)) {
      stepValue(grid, step, listKey, name, `param:${name}`, value, def);
    }
  };

  const renderIngredientBody = (
    step: RecipeStep, listKey: 'trigger_steps' | 'prefetch_steps' | 'steps', grid: HTMLElement,
  ): void => {
    addField(doc, grid, 'Ingredient', makeTextInput(doc, getStepDiscriminator(step), 'ingredient', next => {
      const list = (state.recipe[listKey] as RecipeStep[]).map(s => s.id === step.id ? { ...s, ingredient: next } : s);
      state.recipe = { ...state.recipe, [listKey]: list } as RecipeDefinition;
      markDirty();
    }), true);
    for (const { name, value } of enumerateIngredientInputs(step)) {
      stepValue(grid, step, listKey, name, `input:${name}`, value);
    }
    const row = doc.createElement('div'); row.className = 'recipe-editor-variable-row span-full';
    const name = makeTextInput(doc, '', 'new_ingredient_input', () => {});
    name.setAttribute('aria-label', `New input name for step ${step.id}`);
    row.appendChild(name);
    row.appendChild(makeButton(doc, 'Add input', 'secondary', 'sm', () => {
      const key = name.value.trim();
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) return;
      const current = (state.recipe[listKey] as RecipeStep[]).find(s => s.id === step.id) as { input?: Record<string, unknown> } | undefined;
      if (Object.hasOwn(current?.input ?? {}, key)) return;
      const list = applyFieldToStep(state.recipe[listKey] as RecipeStep[], step.id, `input:${key}`, null);
      mutateAndRerender({ ...state.recipe, [listKey]: list } as RecipeDefinition);
    }));
    grid.appendChild(row);
  };

  const renderGuardBody = (
    step: RecipeStep,
    listKey: 'trigger_steps' | 'prefetch_steps' | 'steps',
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
    listKey: 'trigger_steps' | 'prefetch_steps' | 'steps',
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

      const draftKey = JSON.stringify([step.id, `arg:${name}`]);
      const serialized = fieldDrafts[draftKey]?.text ?? serializeValue(value);
      const error = doc.createElement('span');
      error.className = 'recipe-editor-field-error';
      error.setAttribute('role', 'status');
      error.textContent = fieldDrafts[draftKey]?.error ?? '';
      const applyArg = (raw: string): void => {
        const parsed = parseEditorValue(raw, undefined, undefined, true);
        error.textContent = parsed.error ?? '';
        if (parsed.error !== undefined) {
          fieldDrafts[draftKey] = { text: raw, error: parsed.error };
          valueInput.setAttribute('aria-invalid', 'true');
          markDirty();
          return;
        }
        delete fieldDrafts[draftKey];
        valueInput.removeAttribute('aria-invalid');
        const nextList = applyFieldToStep(
          state.recipe[listKey] as Array<{ id: string }>,
          step.id,
          `arg:${name}`,
          parsed.value,
        );
        state.recipe = { ...state.recipe, [listKey]: nextList } as RecipeDefinition;
        markDirty();
      };
      // JSON containers / long values get the multi-line monospace editor —
      // a nested op body is unworkable in a one-line input.
      const valueInput = isBlockValue(value, serialized)
        ? makeTextArea(doc, serialized, `arg:${name}`, applyArg)
        : makeTextInput(doc, serialized, `arg:${name}`, applyArg);
      valueInput.setAttribute(
        'aria-label',
        `Argument ${name} value for step ${step.id}`,
      );
      if (fieldDrafts[draftKey]) valueInput.setAttribute('aria-invalid', 'true');
      row.appendChild(valueInput);

      const removeArg = makeButton(doc, 'Remove', 'danger-text', 'xs', () => {
        delete fieldDrafts[draftKey];
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
      removeArg.setAttribute(
        'aria-label',
        `Remove argument ${name} from step ${step.id}`,
      );
      row.appendChild(removeArg);
      renderedOpArgFocusTargets.set(
        `${step.id}\u0000${name}`,
        valueInput,
      );

      wrap.appendChild(row);
      wrap.appendChild(error);
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
    nameInput.setAttribute('aria-label', `New argument name for step ${step.id}`);
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
    addArg.setAttribute('aria-label', `Add argument to step ${step.id}`);
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
        'Recued works these out when it runs. Anything touching a CRM needs a '
        + 'connection input to say which one to use. '
        + (connVars.length === 0
          ? 'Add one under Connections and dependencies below.'
          : 'pick one above.');
      grid.appendChild(notice);
    }
  };

  // ────────────────────────────────────────────────────────────
  // One step card
  // ────────────────────────────────────────────────────────────
  const renderStepCard = (
    step: RecipeStep,
    listKey: 'trigger_steps' | 'prefetch_steps' | 'steps',
    index: number,
    listLength: number,
  ): HTMLElement => {
    const kind = detectStepKind(step);
    const card = doc.createElement('details');
    card.className = 'recipe-editor-step-card';
    card.setAttribute(RECIPE_EDITOR_ROW_ATTR, step.id);
    card.setAttribute('data-step-kind', kind);
    card.setAttribute('aria-label', `Step ${step.id}`);
    // Open unless the user collapsed this card — the summary (kind + id +
    // discriminator) is the collapsed overview, and the choice survives
    // rerenders via state.collapsed keyed on the step id.
    if (!state.collapsed.has(step.id)) card.setAttribute('open', '');
    card.addEventListener('toggle', () => {
      if (card.isConnected === false) return;
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
    idInput.setAttribute('data-recued-recipe-deferred-value', step.id);
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
      for (const [key, draft] of Object.entries(fieldDrafts)) {
        const [owner, field] = JSON.parse(key) as [string, string];
        if (owner === step.id) { delete fieldDrafts[key]; fieldDrafts[JSON.stringify([proposed, field])] = draft; }
      }
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
      for (const key of Object.keys(fieldDrafts)) {
        if ((JSON.parse(key) as string[])[0] === step.id) delete fieldDrafts[key];
      }
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
    const duplicate = makeButton(doc, 'Duplicate', 'secondary', 'xs', () => {
      const id = generateStepId(allStepIds(state.recipe), `${step.id}_copy`);
      const renamed = renameStepIdInRecipe(state.recipe, step.id, id);
      const copy = (renamed[listKey] as RecipeStep[]).find(candidate => candidate.id === id);
      if (!copy) return;
      const list = [...(state.recipe[listKey] as RecipeStep[])];
      list.splice(index + 1, 0, copy);
      for (const [key, draft] of Object.entries(fieldDrafts)) {
        const [owner, field] = JSON.parse(key) as [string, string];
        if (owner === step.id) fieldDrafts[JSON.stringify([id, field])] = { ...draft };
      }
      pendingAddedStepFocusId = id;
      mutateAndRerender({ ...state.recipe, [listKey]: list } as RecipeDefinition);
      revealStep(id);
    });
    duplicate.setAttribute('aria-label', `Duplicate step ${step.id}`);
    duplicate.setAttribute('data-recued-recipe-duplicate', step.id);
    actions.appendChild(duplicate);
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
    // skip_when / fail_on / stop_when, but most steps set none. Render a builder
    // only for a field with a value (or one the user revealed); the rest stay
    // behind "+ Skip when" / "+ Fail on" / "+ Stop when" so an unconditioned
    // card stays short.
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
      } else if (field !== 'stop_when' || listKey === 'steps') {
        // `stop_when` works on a step in `steps` only (the validator refuses it on
        // prefetch and trigger steps), so it is not OFFERED there. One already
        // set still shows above, where the refusal can be seen and fixed.
        const reveal = makeButton(
          doc,
          `+ ${CONDITION_LABELS[field]}`,
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
        reveal.setAttribute(
          'aria-label',
          `Add ${CONDITION_LABELS[field]} condition for step ${step.id}`,
        );
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
    listKey: 'trigger_steps' | 'prefetch_steps' | 'steps',
    controls: ReadonlyArray<HTMLElement | undefined>,
  ): void => {
    const list = state.recipe[listKey] ?? [];
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
        'Pick a kind above and press Add step to start.',
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

  const buildAddStepControl = (listKey: 'trigger_steps' | 'prefetch_steps' | 'steps' = 'steps'): HTMLElement => {
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
    kindSelect.setAttribute(listKey === 'steps' ? RECIPE_EDITOR_ADD_KIND_ATTR : 'data-recued-recipe-trigger-add-kind', '');
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
        sel.setAttribute(listKey === 'steps' ? RECIPE_EDITOR_ADD_NAME_ATTR : 'data-recued-recipe-trigger-add-name', '');
        sel.setAttribute('aria-label', 'Step name');
        nameField.appendChild(sel);
      } else {
        const inp = makeTextInput(doc, draft.name, 'add_name', (next) => {
          draft.name = next;
        });
        inp.setAttribute(listKey === 'steps' ? RECIPE_EDITOR_ADD_NAME_ATTR : 'data-recued-recipe-trigger-add-name', '');
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
          [listKey]: [...(state.recipe[listKey] ?? []), createBlankOpStep(opName, id)],
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
        [listKey]: [...(state.recipe[listKey] ?? []), step],
      });
      revealStep(id);
    });
    add.setAttribute(listKey === 'steps' ? RECIPE_EDITOR_ADD_ATTR : 'data-recued-recipe-trigger-add', '');
    if (listKey === 'steps') addStepBtn = add;
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
        state.status = armed ? 'Webhook trigger switched on' : 'Webhook trigger switched off';
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
    appendText(doc, header, 'h2', 'Webhooks coming in');
    const label = state.dirty && webhookStatus?.configured
      ? 'Webhook choices not saved yet'
      : webhookStatus?.armed
        ? 'On'
        : webhookStatus?.configured
          ? 'Off'
          : 'Not set up';
    const meta = appendText(doc, header, 'span', label);
    meta.className = 'recipe-editor-section-meta';
    section.appendChild(header);
    const hint = appendText(
      doc,
      section,
      'p',
      'Pick a switched-on way in for every webhook. Saving always '
        + 'leaves this Recipe switched off. Turning it on is something you do separately.',
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
        'The way in you pick decides who is trusted and what gets let through.',
      );
      row.appendChild(copy);
      const field = doc.createElement('label');
      field.textContent = 'Way in that is switched on';
      const select = doc.createElement('select');
      select.setAttribute(RECIPE_EDITOR_WEBHOOK_SELECT_ATTR, 'new');
      select.setAttribute(RECIPE_EDITOR_FIELD_ATTR, 'webhook_ingress:new');
      const placeholder = doc.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Pick a way in that is switched on…';
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
          webhookBusy ? 'Switching off…' : 'Switch off saved webhook',
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
        ? 'The saved webhook stays on until you save this change.'
        : candidates.length === 0
          ? 'Make a way in under Connections and switch it on first.'
          : 'This only changes your draft. Save, then switch it on separately.';
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
        const lede = appendText(doc, block, 'p', 'A webhook cannot start this Recipe:');
        lede.className = 'recipe-editor-webhook-door-lede';
        const refusal = door.refusal;
        appendText(
          doc,
          block,
          'code',
          refusal ? `${refusal.detail} (step ${refusal.step_id})` : 'the door could not be made',
        );
        const help = appendText(
          doc,
          block,
          'p',
          'Nothing gets through. Change the step that was refused, then save again.',
        );
        help.className = 'recipe-editor-webhook-door-help';
      } else if (door.state === 'missing') {
        const lede = appendText(doc, block, 'p', 'There is no door behind this webhook.');
        lede.className = 'recipe-editor-webhook-door-lede';
        const help = appendText(
          doc,
          block,
          'p',
          'Nothing gets through until there is one. Save the Recipe again to make one.',
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
            ? 'This Recipe does nothing that needs asking, so the door gives nothing away.'
            : armedNow
              ? 'Anything let through may:'
              : 'Once this is on, anything let through may:',
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
              ? 'These run without asking you each time. Switching it on was your yes. '
                + 'Switch it off to take that back.'
              : 'These run without asking you each time. Switching it on is your yes. '
                + 'Switch it off to take that back.',
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
          const diffLede = appendText(doc, block, 'p', 'Saving changed what this webhook may do:');
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
        || 'the events it named';
      const payloadLabel = requirement.decoded_payload_access === 'scoped_read'
        ? 'can read what was sent'
        : 'only the labels around it';
      const truthLabel = requirement.source_truth_policy === 'provider_readback_required'
        ? 'has to check back with the service'
        : 'can trust what was sent';
      appendText(
        doc,
        identity,
        'code',
        `${requirement.profile_ids.join(' or ')} · ${eventLabel} · ${payloadLabel} · ${truthLabel}`,
      );
      row.appendChild(identity);

      const field = doc.createElement('label');
      field.textContent = 'The way in you picked';
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
        ? 'Pick a way in that is switched on…'
        : 'You cannot change webhooks here';
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
        unavailable.textContent = `What you picked is not there any more · ${selected}`;
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
      const remove = makeButton(doc, 'Remove this webhook', 'secondary', 'sm', () => {
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
        webhookBusy ? 'Switching off…' : 'Switch off webhook',
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
        webhookBusy ? 'Switching on…' : 'Switch on webhook',
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
      ?? (webhookBusy ? 'Changing what the webhook may do…'
        : state.dirty ? 'Save your webhook choices before switching it on.'
          : triggers.length === 0 ? 'Add a webhook trigger before switching it on.'
          : door?.state === 'missing'
            ? 'The webhook door is missing. Save the Recipe again to make one.'
          : door?.state === 'refused'
            ? 'This Recipe cannot have a webhook door. Change the step that was refused, then save.'
          : webhookStatus?.armed ? 'Anything let through from now on can start this Recipe.'
            : 'No webhook can start this Recipe yet.');
    actions.appendChild(status);
    const settings = doc.createElement('a');
    settings.setAttribute('href', '#connections/webhooks');
    settings.textContent = 'Manage ways in for webhooks';
    actions.appendChild(settings);
    section.appendChild(actions);
    host2.appendChild(section);
  };

    /** D-315 §5.1 — "A mail fact": the values whose change wakes it, one "only
   *  when" and its value, checked as they change by the check the recipe is
   *  validated with, with what no built-in kind has named as a note. It names
   *  no kind of email: each value is labelled with the kinds that have it,
   *  the owner's included. No template picker: a recipe names its template
   *  through its template variable (§5.2) — an id from this server would match
   *  nothing on another. */
  const renderMailFactTrigger = (
    fields: HTMLElement,
    body: HTMLElement,
    index: number,
    trigger: RecipeEventTrigger,
  ): HTMLElement => {
    const part = (name: string): string => `${index}:${name}`;
    let current = trigger;
    const problems = doc.createElement('span');
    problems.className = 'recipe-editor-field-error';
    problems.setAttribute('role', 'status');
    problems.setAttribute(RECIPE_EDITOR_TRIGGER_FACT_ATTR, part('problems'));
    const notes = doc.createElement('span');
    notes.className = 'recipe-editor-hint';
    notes.setAttribute('role', 'status');
    notes.setAttribute(RECIPE_EDITOR_TRIGGER_FACT_ATTR, part('notes'));
    const showProblems = (): void => {
      problems.textContent = validateRecipeEventTriggerEntry(current).join(' ');
      notes.textContent = recipeEventTriggerNotes(current).join(' ');
    };
    /** A value edit: no other control depends on it. */
    const patch = (next: RecipeEventTrigger): void => {
      current = next;
      patchEventTrigger(index, next);
      showProblems();
    };
    /** A choice that changes which controls the row shows. */
    const replace = (next: RecipeEventTrigger): void => {
      const triggers = [...(state.recipe.event_triggers ?? [])];
      triggers[index] = next;
      mutateAndRerender({ ...state.recipe, event_triggers: triggers });
    };
    const withWhere = (where: Record<string, string | number | boolean>): RecipeEventTrigger => {
      const next = { ...current };
      if (Object.keys(where).length > 0) next.where = where;
      else delete next.where;
      return next;
    };
    const type = mailFactTriggerType(current) ?? null;
    const kindSelect = makeLabelledSelect(
      doc,
      type ?? '',
      mailFactKindOptions(ownedMailFactKinds, type, ownedMailFactKindsKnown),
      `event_trigger_fact_type:${index}`,
      (value) => {
        // What was watched and filtered belongs to the kind it was for.
        const next: RecipeEventTrigger = { ...current, on: mailFactOn(value === '' ? null : value) };
        delete next.fields;
        delete next.where;
        replace(next);
      },
    );
    kindSelect.setAttribute(RECIPE_EDITOR_TRIGGER_FACT_ATTR, part('type'));
    addField(doc, fields, 'Kind of email', kindSelect);
    // D-315 §5.1 — only the facts the recipe's own template reads: the one its
    // setting holds on the owner's server.
    const settings = mailTemplateVariableNames(state.recipe);
    if (settings.length > 0 || current.template_variable !== undefined) {
      const readBy = makeLabelledSelect(
        doc,
        current.template_variable ?? '',
        [
          { value: '', label: 'Any template, or none' },
          ...settings.map((name) => {
            const label = (state.recipe.variables[name] as { label?: unknown } | undefined)?.label;
            return { value: name, label: `The one in the setting “${typeof label === 'string' && label !== '' ? label : name}”` };
          }),
          ...(current.template_variable !== undefined && !settings.includes(current.template_variable)
            ? [{ value: current.template_variable, label: `${current.template_variable} (no such setting)` }]
            : []),
        ],
        `event_trigger_fact_template:${index}`,
        (value) => {
          const next: RecipeEventTrigger = { ...current };
          if (value === '') delete next.template_variable;
          else next.template_variable = value;
          patch(next);
        },
      );
      readBy.setAttribute(RECIPE_EDITOR_TRIGGER_FACT_ATTR, part('template'));
      addField(doc, fields, 'Read by', readBy);
    }
    const vocabulary = RunModal.mailFactVocabulary(ownedMailFactKinds, type);
    const labelOf = (name: string): string => {
      const choice = vocabulary.find((candidate) => candidate.name === name);
      return choice === undefined ? RunModal.humanizeFactName(name) : RunModal.mailFactChoiceLabel(choice, ownedMailFactKinds, type);
    };

    // What it watches: the chosen values, then one more to choose.
    const watched = current.fields ?? [];
    const watch = doc.createElement('fieldset');
    watch.className = 'recipe-editor-fact-fields';
    appendText(doc, watch, 'legend', 'Wake when one of these changes — none chosen: on every change');
    for (const name of watched) {
      const label = doc.createElement('label');
      label.className = 'recipe-editor-field-checkbox';
      const box = doc.createElement('input');
      box.type = 'checkbox';
      box.checked = true;
      box.setAttribute(RECIPE_EDITOR_FIELD_ATTR, `event_trigger_fact_field:${index}:${name}`);
      box.setAttribute(RECIPE_EDITOR_TRIGGER_FACT_ATTR, part(`field:${name}`));
      box.addEventListener('change', () => {
        // Kept in place until the row repaints, to tick again.
        const kept = (current.fields ?? []).filter((field) => field !== name);
        const picked = box.checked ? watched.filter((field) => field === name || kept.includes(field)) : kept;
        const next = { ...current };
        if (picked.length > 0) next.fields = picked;
        else delete next.fields;
        patch(next);
      });
      label.appendChild(box);
      appendText(doc, label, 'span', labelOf(name));
      watch.appendChild(label);
    }
    fields.appendChild(watch);
    const add = makeLabelledSelect(
      doc,
      '',
      [
        { value: '', label: 'choose a value…' },
        ...vocabulary
          .filter((choice) => !watched.includes(choice.name))
          .map((choice) => ({ value: choice.name, label: RunModal.mailFactChoiceLabel(choice, ownedMailFactKinds, type) })),
      ],
      `event_trigger_fact_field_add:${index}`,
      (value) => {
        if (value === '' || (current.fields ?? []).includes(value)) return;
        replace({ ...current, fields: [...(current.fields ?? []), value] });
      },
    );
    add.setAttribute(RECIPE_EDITOR_TRIGGER_FACT_ATTR, part('field-add'));
    addField(doc, fields, watched.length > 0 ? 'Also watch' : 'Watch', add);

    const whereOptions = RunModal.mailFactWhereOptions(ownedMailFactKinds, type);
    const where = current.where ?? {};
    const editable = Object.keys(where).find((key) => whereOptions.some((option) => option.name === key));
    const chosen = whereOptions.find((option) => option.name === editable);
    const variable = makeLabelledSelect(
      doc,
      editable ?? '',
      [
        { value: '', label: 'Always' },
        ...whereOptions.map((option) => ({
          value: option.name,
          label: option.kind === 'complete' ? 'Every required value was read' : labelOf(option.name),
        })),
      ],
      `event_trigger_fact_where:${index}`,
      (value) => {
        const nextWhere = { ...(current.where ?? {}) };
        if (editable !== undefined) delete nextWhere[editable];
        const picked = whereOptions.find((option) => option.name === value);
        // A closed kind starts at its first value; an open one is typed next.
        if (picked !== undefined && !(picked.name in nextWhere)) {
          nextWhere[picked.name] = picked.values === undefined
            ? ''
            : picked.kind === 'complete' || picked.kind === 'boolean' ? true : picked.values[0]!;
        }
        replace(withWhere(nextWhere));
      },
    );
    variable.setAttribute(RECIPE_EDITOR_TRIGGER_FACT_ATTR, part('where'));
    addField(doc, fields, 'Only when', variable);

    if (chosen !== undefined && editable !== undefined) {
      const stored = where[editable];
      const setWhereValue = (value: string | number | boolean): void =>
        patch(withWhere({ ...(current.where ?? {}), [editable]: value }));
      let control: HTMLInputElement | HTMLSelectElement;
      if (chosen.values !== undefined) {
        const yesNo = chosen.kind === 'complete' || chosen.kind === 'boolean';
        control = makeLabelledSelect(
          doc,
          String(stored),
          chosen.values.map((value) => ({
            value,
            label: yesNo ? (value === 'true' ? 'Yes' : 'No') : RunModal.humanizeFactName(value),
          })),
          `event_trigger_fact_value:${index}`,
          (raw) => {
            const typed = RunModal.mailFactWhereValue(chosen, raw);
            if ('value' in typed) setWhereValue(typed.value);
          },
        );
      } else {
        control = makeTextInput(doc, stored === undefined ? '' : String(stored), `event_trigger_fact_value:${index}`, (raw) => {
          const typed = RunModal.mailFactWhereValue(chosen, raw);
          // What a fact cannot hold is kept as typed, for the check to name.
          setWhereValue('value' in typed ? typed.value : raw.trim());
        });
        if (chosen.kind === 'date') control.type = 'date';
      }
      control.setAttribute(RECIPE_EDITOR_TRIGGER_FACT_ATTR, part('value'));
      addField(doc, fields, 'Must be', control);
    }

    const others = Object.fromEntries(Object.entries(where).filter(([key]) => key !== editable));
    if (Object.keys(others).length > 0) addReadonlyField(doc, fields, 'Other filters', JSON.stringify(others));

    const hint = doc.createElement('span');
    hint.className = 'recipe-editor-hint';
    const typeSpec = type === null ? undefined : RunModal.mailFactTypeOf(type, ownedMailFactKinds);
    hint.textContent = (type === null
      ? 'Starts when a fact read from mail is new or changes, whatever kind of email it came from, if it has what this watches'
      : `Starts when ${RunModal.withIndefiniteArticle((typeSpec?.name ?? type).toLowerCase())} read from mail is new or changes`)
      + `${Object.keys(others).length > 0 ? ', and the other filters shown still apply' : ''}. Later steps read its values at `;
    const ref = doc.createElement('code');
    ref.textContent = '{{context.event.payload.record}}';
    hint.appendChild(ref);
    appendText(doc, hint, 'span', ', and its kind at ');
    const kindRef = doc.createElement('code');
    kindRef.textContent = '{{context.event.payload.record.type}}';
    hint.appendChild(kindRef);
    appendText(doc, hint, 'span', '.');
    body.appendChild(hint);
    body.appendChild(problems);
    body.appendChild(notes);
    showProblems();
    return kindSelect;
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
      // D-319 §5.5 — nothing starts until the Recipe is switched on, with its settings.
      'Start when something happens. Nothing starts until you switch the Recipe on from its page, '
        + 'with its settings. Form answers only start this after you have looked at them. '
        + 'Add a reader to use what people wrote.',
    );
    hint.className = 'recipe-editor-hint';

    if (triggers.length === 0) {
      const empty = doc.createElement('div');
      empty.className = 'recipe-editor-empty recipe-editor-trigger-empty';
      // A timer says when it really runs: its window, at the recipe's defaults.
      const timer = state.recipe.auto_run ? startPhrase(state.recipe) : null;
      appendText(doc, empty, 'strong', timer !== null
        ? `${timer.charAt(0).toUpperCase()}${timer.slice(1)} once switched on`
        : 'Runs manually');
      appendText(doc, empty, 'span', 'Add a trigger so something can set this Recipe off.');
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
        appendText(doc, title, 'span', 'A form answer you accepted');
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
        input.setAttribute('placeholder', 'Any form');
        triggerFocusTarget = input;
        addField(doc, fields, 'Form ID', input);

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
          'Leave this empty to take answers from every form. The other filters shown '
            + 'still apply. The reader below gets the whole answer once you have said yes to it.',
        );
        readerHint.className = 'recipe-editor-hint';
      } else if (isMailFactTrigger(trigger)) {
        appendText(doc, title, 'span', 'A mail fact');
        const code = appendText(doc, title, 'code', trigger.on ?? '');
        code.className = 'recipe-editor-trigger-code';
        triggerFocusTarget = renderMailFactTrigger(fields, body, index, trigger);
      } else if (typeof trigger.event === 'string') {
        appendText(doc, title, 'span', 'Your own event pattern');
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
        addField(doc, fields, 'Event name pattern', input, true);
        if (trigger.filter !== undefined) {
          addReadonlyField(doc, fields, 'Only when', JSON.stringify(trigger.filter));
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
          'This trigger uses advanced settings. Recued keeps them exactly as they are.',
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
        appendText(doc, copy, 'strong', 'Answer reader ready');
        const detail = doc.createElement('span');
        detail.textContent = 'Later steps can read the whole answer at ';
        const ref = doc.createElement('code');
        ref.textContent = `{{step.${ready.id}.record}}`;
        detail.appendChild(ref);
        appendText(doc, detail, 'span', '.');
        copy.appendChild(detail);
      } else if (repair !== undefined) {
        appendText(doc, copy, 'strong', 'Keep the reader you have, or hook it up');
        appendText(
          doc,
          copy,
          'span',
          `Step ${repair.id} always reads the same answer. Keep it and add a reader for the event, or `
            + `point it at the answer this trigger brings in.`,
        );
      } else {
        appendText(doc, copy, 'strong', 'Read what people wrote');
        appendText(
          doc,
          copy,
          'span',
          'The event only says where to look. Add the owner-only reader before '
            + 'building the steps.',
        );
      }
      bridge.appendChild(copy);

      if (ready === undefined) {
        const addAction = makeButton(
          doc,
          repair !== undefined ? 'Add a separate reader for the event' : 'Add an answer reader',
          'secondary',
          'sm',
          addFormResponseReader,
        );
        addAction.setAttribute(RECIPE_EDITOR_FORM_RESPONSE_READER_ACTION_ATTR, 'add');
        bridge.appendChild(addAction);
        if (repair !== undefined) {
          const bindAction = makeButton(
            doc,
            'Point the reader you have at it',
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
      factType: '',
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
    const eventLabel = appendText(doc, eventField, 'label', 'Event pattern');
    addWrap.appendChild(eventField);

    let addTrigger: HTMLButtonElement | undefined;
    const canAddCustomEvent = (): boolean => {
      const event = draft.event.trim();
      return (event.startsWith('data.') || event.startsWith('run.'))
        && validateRecipeEventTriggerEntry({ event }).length === 0;
    };
    const syncAddTrigger = (): void => {
      if (addTrigger === undefined) return;
      addTrigger.disabled = draft.kind === 'Your own event pattern'
        && !canAddCustomEvent();
    };
    const rebuildEventControl = (): void => {
      while (eventField.children.length > 1) {
        eventField.removeChild(eventField.children[eventField.children.length - 1]!);
      }
      eventLabel.textContent = draft.kind === 'A mail fact' ? 'Kind of email' : 'Event pattern';
      if (draft.kind === 'A mail fact') {
        const select = makeLabelledSelect(doc, draft.factType, mailFactKindOptions(ownedMailFactKinds, null, ownedMailFactKindsKnown), 'event_trigger_add_fact_type', (value) => {
          draft.factType = value;
        });
        select.setAttribute(RECIPE_EDITOR_TRIGGER_ADD_FACT_TYPE_ATTR, '');
        select.setAttribute('aria-label', 'Kind of email');
        eventField.appendChild(select);
      } else if (draft.kind === 'Your own event pattern') {
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
          "Events about your own records start with 'data.' or 'run.'. Use '*' for one part of the name, and '**' for any number of parts.",
        );
        patternHint.className = 'recipe-editor-hint';
      } else {
        const fixed = doc.createElement('code');
        fixed.className = 'recipe-editor-readonly';
        fixed.textContent = 'After you accept it';
        eventField.appendChild(fixed);
      }
    };
    rebuildEventControl();

    addTrigger = makeButton(doc, 'Add trigger', 'secondary', 'sm', () => {
      const nextTrigger: RecipeEventTrigger = draft.kind === 'A form answer you accepted'
        ? { on: FORM_RESPONSE_ON_SHORTHAND }
        : draft.kind === 'A mail fact'
          ? { on: mailFactOn(draft.factType === '' ? null : draft.factType) }
          : { event: draft.event.trim() };
      if (
        draft.kind === 'Your own event pattern'
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
      'One connection input for each CRM step that needs one, written as '
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

      addReadonlyField(doc, grid, 'Write it like this', `{{config.${name}}}`);
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
      remove.setAttribute('aria-label', `Remove connection input ${name}`);
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
    appendText(doc, nameField, 'label', 'New connection input');
    const nameInput = makeTextInput(doc, '', 'conn_var_new_name', (next) => {
      draft.name = next;
    });
    nameInput.setAttribute(RECIPE_EDITOR_CONN_VAR_NAME_ATTR, '');
    nameInput.setAttribute('aria-label', 'New connection input');
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

    const addVar = makeButton(doc, 'Add connection input', 'secondary', 'sm', () => {
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
    addField(doc, depGrid, 'Packs it needs', depInput, true);
    const depHint = appendText(
      doc,
      depGrid,
      'span',
      'The <publisher>.<pack> ids this Recipe uses, separated by commas. '
        + 'Steps that only use core.* need none.',
    );
    depHint.className = 'recipe-editor-hint span-full';
    section.appendChild(depGrid);

    host2.appendChild(section);
  };

  /** D-315 §5.2 — the recipe's mail template settings. Each may bring the
   *  template the recipe was built and tested with: one of the author's own,
   *  copied in by their server, which refuses a copy holding anything of their
   *  mail. "Update from my template" copies it again once it changed. */
  const copyStarter = async (name: string, template_id: string): Promise<void> => {
    const call = options.mailTemplateStarterCaller;
    if (call === undefined || starterCopying !== null) return;
    starterCopying = name;
    starterProblems.delete(name);
    rerender();
    try {
      const { starter } = await call({ template_id });
      if (disposed) return;
      starterCopying = null;
      // Removed while its copy was on the way: nothing to bring it to.
      if (!mailTemplateVariableNames(state.recipe).includes(name)) {
        rerender();
        return;
      }
      starterPicks.set(name, template_id);
      const prev = state.recipe.variables[name] as unknown as Record<string, unknown>;
      mutateAndRerender({
        ...state.recipe,
        variables: { ...state.recipe.variables, [name]: { ...prev, starter } as unknown as VariableDefault },
      });
    } catch (error) {
      if (disposed) return;
      starterCopying = null;
      const problems = (error as { details?: { problems?: unknown } }).details?.problems;
      starterProblems.set(name, Array.isArray(problems) && problems.every((p) => typeof p === 'string')
        ? problems as string[]
        : [humanizeRpcError(error)]);
      rerender();
    }
  };

  const renderMailTemplatesSection = (host2: HTMLElement): void => {
    const names = mailTemplateVariableNames(state.recipe);
    // Shown where it can matter: a recipe with a template setting, or one that
    // starts on mail facts — not on every recipe.
    if (names.length === 0 && !(state.recipe.event_triggers ?? []).some(isMailFactTrigger)) return;
    const section = doc.createElement('section');
    section.className = 'recipe-editor-section';
    section.setAttribute(RECIPE_EDITOR_MAIL_TEMPLATES_ATTR, '');
    const header = doc.createElement('div');
    header.className = 'recipe-editor-section-header';
    appendText(doc, header, 'h2', 'Mail templates');
    const meta = appendText(doc, header, 'span', plural(names.length, 'setting'));
    meta.className = 'recipe-editor-section-meta';
    section.appendChild(header);
    const hint = appendText(
      doc,
      section,
      'p',
      'A setting that holds one of the owner’s mail templates, written as {{config.<name>}}. '
        + 'It can bring the template you built this Recipe with: installing the Recipe adds it, with its AI off.',
    );
    hint.className = 'recipe-editor-hint';

    for (const name of names) {
      const hintDef = state.recipe.variables[name] as { label?: unknown };
      const starter = starterOf(state.recipe.variables[name]);
      const row = doc.createElement('div');
      row.className = 'recipe-editor-conn-var-row';
      row.setAttribute(RECIPE_EDITOR_MAIL_TEMPLATE_ROW_ATTR, name);
      const grid = doc.createElement('div');
      grid.className = 'recipe-editor-field-grid';
      addReadonlyField(doc, grid, 'Write it like this', `{{config.${name}}}`);
      addField(
        doc,
        grid,
        'Label',
        makeTextInput(doc, String(hintDef.label ?? ''), `mail_template_label:${name}`, (next) => {
          patchVariable(name, { label: next });
          markDirty();
        }),
      );
      row.appendChild(grid);

      const brings = appendText(
        doc,
        row,
        'p',
        starter === null
          ? 'Brings no template: whoever installs it picks one of theirs.'
          : `Brings “${starter.name}”, a ${starter.type.replace(/_/g, ' ')} template.`,
      );
      brings.className = 'recipe-editor-hint';

      // Copy one of the author's templates in, or again.
      const templates = authorTemplates ?? [];
      const found = starter !== null ? starterSourceOf(starter, templates) : null;
      const picked = starterPicks.get(name) ?? found?.template_id ?? '';
      const source = templates.find((template) => template.template_id === picked) ?? null;
      if (options.mailTemplateStarterCaller !== undefined && templates.length > 0) {
        const copyWrap = doc.createElement('div');
        copyWrap.className = 'recipe-editor-add recipe-editor-add--compact';
        const field = doc.createElement('div');
        field.className = 'recipe-editor-field';
        appendText(doc, field, 'label', 'From my template');
        const select = makeLabelledSelect(
          doc,
          picked,
          [
            { value: '', label: 'Choose one' },
            ...templates.map((template) => ({ value: template.template_id, label: `${template.name} (${template.type.replace(/_/g, ' ')})` })),
          ],
          `mail_template_source:${name}`,
          (next) => {
            if (next === '') starterPicks.delete(name);
            else starterPicks.set(name, next);
            rerender();
          },
        );
        select.setAttribute(RECIPE_EDITOR_MAIL_TEMPLATE_SOURCE_ATTR, name);
        select.setAttribute('aria-label', `The template ${name} brings`);
        field.appendChild(select);
        copyWrap.appendChild(field);
        const again = starter !== null && source !== null && source.template_id === found?.template_id;
        const copy = makeButton(
          doc,
          starterCopying === name ? 'Copying…' : again ? 'Update from my template' : 'Bring this template',
          'secondary',
          'sm',
          () => { if (source !== null) void copyStarter(name, source.template_id); },
        );
        copy.setAttribute(RECIPE_EDITOR_MAIL_TEMPLATE_COPY_ATTR, name);
        if (source === null || starterCopying !== null) copy.setAttribute('disabled', '');
        copyWrap.appendChild(copy);
        row.appendChild(copyWrap);
        if (starter !== null && source !== null && again && starterChanged(starter, source)) {
          const changed = appendText(doc, row, 'p', `“${source.name}” changed since this copy. Update from it to bring the change.`);
          changed.className = 'recipe-editor-hint';
        }
      }
      const make = doc.createElement('a');
      make.className = 'rx-link';
      make.setAttribute('href', '#data/mail_fact/templates/new');
      make.textContent = 'Make a template';
      row.appendChild(make);
      for (const problem of starterProblems.get(name) ?? []) {
        const line = appendText(doc, row, 'p', problem);
        line.className = 'recipe-editor-field-error';
        line.setAttribute('role', 'alert');
      }
      const remove = makeButton(doc, 'Remove', 'danger-text', 'sm', () => {
        const nextVars = { ...state.recipe.variables };
        delete nextVars[name];
        starterPicks.delete(name);
        starterProblems.delete(name);
        mutateAndRerender({ ...state.recipe, variables: nextVars });
      });
      remove.setAttribute('aria-label', `Remove the template setting ${name}`);
      row.appendChild(remove);
      section.appendChild(row);
    }

    // Add a template setting.
    const draft = { name: '' };
    const addWrap = doc.createElement('div');
    addWrap.className = 'recipe-editor-add recipe-editor-add--compact';
    const nameField = doc.createElement('div');
    nameField.className = 'recipe-editor-field';
    appendText(doc, nameField, 'label', 'New template setting');
    const nameInput = makeTextInput(doc, '', 'mail_template_new_name', (next) => { draft.name = next; });
    nameInput.setAttribute(RECIPE_EDITOR_MAIL_TEMPLATE_NAME_ATTR, '');
    nameInput.setAttribute('aria-label', 'New template setting');
    nameInput.setAttribute('placeholder', 'template');
    nameField.appendChild(nameInput);
    addWrap.appendChild(nameField);
    const add = makeButton(doc, 'Add template setting', 'secondary', 'sm', () => {
      const name = draft.name.trim();
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) || name in state.recipe.variables) return;
      pendingFieldFocus = {
        fieldKey: `mail_template_label:${name}`,
        occurrence: 0,
        selectionStart: 0,
        selectionEnd: name.length,
        reveal: true,
      };
      mutateAndRerender({
        ...state.recipe,
        variables: {
          ...state.recipe.variables,
          [name]: { label: 'Mail template', type: 'mail_template' } as unknown as VariableDefault,
        },
      });
    });
    add.setAttribute(RECIPE_EDITOR_MAIL_TEMPLATE_ADD_ATTR, '');
    addWrap.appendChild(add);
    section.appendChild(addWrap);
    host2.appendChild(section);
  };

  // ────────────────────────────────────────────────────────────
  // Status line (sticky topbar) + issues panel (top of content)
  // ────────────────────────────────────────────────────────────

  /** The one-line outcome readout. Lives INSIDE the sticky topbar so the
   *  result of Validate / Save appears next to the buttons that ran them —
   *  never below the fold. Announced politely to screen readers. */
  const renderStatusLine = (topbar: HTMLElement): void => {
    statusbarEl = undefined;
    const hasChip = state.saveStage === 'idle' && state.status === 'Valid';
    if (state.status.length === 0 && !hasChip) return;

    const bar = doc.createElement('div');
    bar.className = 'recipe-editor-statusbar';
    statusbarEl = bar;

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
        const path = makeButton(doc, issue.path, 'secondary', 'sm', () => revealIssue(issue.path!));
        path.className += ' recipe-editor-issue-path';
        path.setAttribute('aria-label', `Fix ${issue.path}`);
        row.appendChild(path);
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
    const restoreTestFocus = (testRunBtn !== undefined && activeBeforeRender === testRunBtn)
      || (testCancelBtn !== undefined && activeBeforeRender === testCancelBtn);
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
    validationFields.clear();
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
    topbar.setAttribute('aria-label', 'Recipe editor buttons');

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
      'Build it, check it, and save it.',
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
    undoBtn = makeButton(doc, 'Undo', 'secondary', 'sm', () => changeHistory('undo'));
    undoBtn.setAttribute('title', 'Undo (⌘Z or Ctrl+Z)');
    undoBtn.setAttribute('data-recued-recipe-undo', ''); actions.appendChild(undoBtn);
    redoBtn = makeButton(doc, 'Redo', 'secondary', 'sm', () => changeHistory('redo'));
    redoBtn.setAttribute('title', 'Redo (⌘⇧Z or Ctrl+Shift+Z)');
    redoBtn.setAttribute('data-recued-recipe-redo', ''); actions.appendChild(redoBtn);

    validateBtn = makeButton(doc, 'Validate', 'secondary', 'sm', runValidate);
    validateBtn.setAttribute(RECIPE_EDITOR_VALIDATE_ATTR, '');
    validateBtn.setAttribute('title', 'Check this Recipe without saving');
    actions.appendChild(validateBtn);

    saveBtn = makeButton(doc, saveLabel(), 'primary', 'sm', runSave);
    saveBtn.setAttribute(RECIPE_EDITOR_SAVE_ATTR, '');
    saveBtn.setAttribute('title', 'Save Recipe (⌘S or Ctrl+S)');
    actions.appendChild(saveBtn);

    topbar.appendChild(actions);
    renderStatusLine(topbar);
    content.appendChild(topbar);
    topbarEl = topbar;

    syncActionLabels();

    // Issues sit at the top of the content, right under the sticky topbar
    // that reports them — not below the step list.
    renderIssues(content);

    const recovery = renderRecovery(); if (recovery) content.appendChild(recovery);
    const workspace = doc.createElement('div'); workspace.className = 'recipe-editor-workspace';
    workspace.appendChild(renderOutline());
    const body = doc.createElement('div'); workspace.appendChild(body); content.appendChild(workspace);
    const settings = renderRecipeSettings({
      document: doc,
      get recipe() { return state.recipe; },
      change(recipe, rebuild) {
        if (rebuild) {
          for (const key of Object.keys(fieldDrafts)) {
            const [owner, field] = JSON.parse(key) as [string, string];
            if (owner) continue;
            if ((field.startsWith('variables.') && !Object.hasOwn(recipe.variables, field.slice(10)))
              || (field.startsWith('auto_run.') && !recipe.auto_run)) delete fieldDrafts[key];
          }
          const added = Object.keys(recipe.variables).find(key => !Object.hasOwn(state.recipe.variables, key));
          const intervalChanged = Boolean(state.recipe.auto_run) !== Boolean(recipe.auto_run);
          pendingFieldFocus = { fieldKey: added ? `variables.${added}` : intervalChanged
            ? recipe.auto_run ? 'auto_run.interval_ms' : 'auto_run_enabled' : 'variable_new_name',
            occurrence: 0, selectionStart: null, selectionEnd: null, reveal: true };
          panelOpen.add('settings'); mutateAndRerender(recipe);
        }
        else state.recipe = recipe;
      },
      value: valueField,
    });
    rememberPanel(settings, 'settings'); body.appendChild(settings);
    renderWebhooksSection(body);
    renderTriggersSection(body);
    if (state.recipe.auto_run || state.recipe.trigger_steps?.length) {
      renderStepsSection(body, 'Trigger steps', 'trigger_steps', [buildAddStepControl('trigger_steps')]);
    }
    if ((state.recipe.prefetch_steps?.length ?? 0) > 0) {
      renderStepsSection(body, 'Prefetch', 'prefetch_steps', []);
    }
    renderStepsSection(body, 'Steps', 'steps', [buildCollapseAllControl(), buildAddStepControl()]);
    renderBindingsSection(body);
    renderMailTemplatesSection(body);
    body.appendChild(renderTestPanel());
    if (restoreTestFocus) testRunBtn?.focus?.({ preventScroll: true });
    for (const issue of state.issues) {
      if (!issue.path) continue;
      const destination = issueDestination(issue.path);
      const scope = destination.stepId
        ? Array.from(host.querySelectorAll?.<HTMLElement>(`[${RECIPE_EDITOR_ROW_ATTR}]`) ?? [])
          .find(el => el.getAttribute(RECIPE_EDITOR_ROW_ATTR) === destination.stepId)
        : host;
      const field = Array.from(scope?.querySelectorAll?.<HTMLElement>(`[${RECIPE_EDITOR_FIELD_ATTR}]`) ?? [])
        .find(el => el.getAttribute(RECIPE_EDITOR_FIELD_ATTR) === destination.field);
      if (field?.parentElement) {
        const draftKey = JSON.stringify([destination.stepId ?? '', destination.field]);
        if (fieldDrafts[draftKey]?.error === issue.message) continue;
        if (issue.severity === 'error') {
          field.setAttribute('aria-invalid', 'true');
          validationFields.set(field, draftKey);
        }
        const message = appendText(doc, field.parentElement, 'span', issue.message);
        message.className = 'recipe-editor-field-error';
        message.setAttribute('data-recued-recipe-validation-message', '');
      }
    }

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
  void options.mailTemplatesCaller?.().then(({ templates }) => {
    if (disposed) return;
    authorTemplates = templates;
    if (mailTemplateVariableNames(state.recipe).length > 0) rerender();
  }, () => {
    // No list: a setting keeps its starter, and offers no copy.
    if (disposed) return;
    authorTemplates = [];
  });
  void options.mailFactTypesCaller?.().then(({ types }) => {
    if (disposed) return;
    ownedMailFactKinds = types;
    ownedMailFactKindsKnown = 'loaded';
    if ((state.recipe.event_triggers ?? []).some(isMailFactTrigger)) rerender();
  }, () => {
    // The pickers keep the built-in kinds, and a kind the recipe names is not
    // called missing: it may be one of the owner's.
    if (disposed) return;
    ownedMailFactKindsKnown = 'unread';
    if ((state.recipe.event_triggers ?? []).some(isMailFactTrigger)) rerender();
  });

  // Cmd/Ctrl+S saves — the reflex every editor user has. Scoped and gated:
  // the listener sits on the document (a focused field must not swallow it),
  // but persistent surfaces OUTSIDE the route (chat drawer, approvals
  // popover) survive alongside it, so only act when focus is on the editor
  // or nowhere in particular; skip while a validate/save is in flight; and
  // only save DIRTY work — recipe.save mints a new version per call, so a
  // clean reflex-save must be a no-op, not a version bump.
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.isComposing) return;
    if (!(event.metaKey || event.ctrlKey)) return;
    if (!['s', 'z', 'y'].includes(event.key.toLowerCase())) return;
    const target = event.target as Node | null;
    const scoped =
      target === null
      || target === (doc as Partial<Document>).body
      || typeof host.contains !== 'function'
      || host.contains(target);
    if (!scoped) return;
    const fieldKey = (target as HTMLElement | null)?.getAttribute?.(RECIPE_EDITOR_FIELD_ATTR);
    const deferredValue = (target as HTMLElement | null)?.getAttribute?.('data-recued-recipe-deferred-value');
    if (event.key.toLowerCase() !== 's' && deferredValue !== null && deferredValue !== undefined
      && (target as HTMLInputElement).value !== deferredValue) return;
    // These inputs edit UI drafts rather than the recipe. Keep their native
    // text undo instead of unexpectedly undoing an unrelated recipe edit.
    if (event.key.toLowerCase() !== 's' && fieldKey && [
      'test_sample', 'outline_search', 'variable_new_name', 'new_ingredient_input',
      'op_arg_name', 'add_name', 'conn_var_new_name', 'event_trigger_add_event',
    ].includes(fieldKey)) return;
    event.preventDefault();
    if (event.key.toLowerCase() !== 's') {
      changeHistory(event.key.toLowerCase() === 'y' || event.shiftKey ? 'redo' : 'undo');
      return;
    }
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
    doc.defaultView?.addEventListener('pagehide', persistDraft);
  }

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      testGeneration += 1; testAbort?.abort();
      if (state.dirty) persistDraft();
      else if (recoveryTimer !== undefined) clearTimeout(recoveryTimer);
      doc.defaultView?.removeEventListener('pagehide', persistDraft);
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
