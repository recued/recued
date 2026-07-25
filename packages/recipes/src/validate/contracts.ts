/** Phase 3: Contract validation (inner shapes + AI function inputs).
 *
 *  Walks every step and validates the INNER SHAPE of complex params
 *  that phase 1's TRANSFORM_SCHEMAS can't express:
 *   - `to_checklist.items[]`: label required, detail_* hints
 *   - `to_summary.fields[]`: label + value required
 *   - `to_table.columns[]`: field required, label recommended
 *   - `switch.cases`: non-empty object, default recommended
 *   - `any`/`all`: at least one of values|conditions
 *   - `merge`: at least one of source|sources
 *
 *  Also validates that AI function ingredients have all the `llm.*`
 *  inputs their contract requires (ai-classify needs llm.categories,
 *  etc.).
 */

import { isBatchCapableAISlug, isEntityFieldPrivacy, stripCorePrefix } from '@recued/contracts';
import { AI_FUNCTION_REQUIRED_INPUTS } from './constants.js';
import { REF_PATTERN, validateConditionField, type AddFn } from './helpers.js';

const ACTION_VARIANTS = new Set(['primary', 'secondary', 'danger']);
const ACTION_CONTEXT_RESERVED_KEYS = new Set(['event', 'server', 'recipe', 'tabs']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const validateContracts = (r: Record<string, unknown>, add: AddFn): void => {
  const steps = Array.isArray(r.steps)
    ? (r.steps as Array<Record<string, unknown>>)
    : [];

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const path = `steps[${i}]`;

    // Transform-step inner shapes
    if (typeof s.transform === 'string') {
      switch (s.transform) {
        case 'to_checklist':
          validateChecklistItems(s.items, `${path}.items`, add);
          break;
        case 'to_summary':
          validateSummaryFields(s.fields, `${path}.fields`, add);
          break;
        case 'to_table':
          validateTableColumns(s.columns, `${path}.columns`, add);
          break;
        case 'switch':
          validateSwitchShape(s, path, add);
          break;
        case 'any':
        case 'all':
          validateAnyAllShape(s, path, add);
          break;
        case 'merge':
          validateMergeShape(s, path, add);
          break;
      }
    }

    // Ingredient-step AI function input contracts. §5 — a `core-<bare>` kernel
    // alias carries the same input contract as its bare slug, so strip before the
    // lookup (e.g. `core-ai-classify` still requires `llm.categories`).
    if (typeof s.ingredient === 'string' && AI_FUNCTION_REQUIRED_INPUTS[stripCorePrefix(s.ingredient)]) {
      validateAiFunctionInputs(s, path, add);
    }
  }
};

/** Validate to_checklist.items[] — each item is a user-visible row in the
 *  sidebar, so malformed items render broken UI. */
const validateChecklistItems = (
  items: unknown,
  path: string,
  add: AddFn,
): void => {
  if (items === undefined) return; // missing items → phase 1 `transform_missing_param`
  if (!Array.isArray(items)) {
    add('error', 'checklist_items_shape', path,
      'to_checklist.items must be an array');
    return;
  }
  if (items.length === 0) {
    add('warn', 'checklist_items_empty', path,
      'to_checklist.items is empty — no rows will render');
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const itemPath = `${path}[${i}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      add('error', 'checklist_item_shape', itemPath,
        'checklist item must be an object');
      continue;
    }
    const it = item as Record<string, unknown>;
    if (typeof it.label !== 'string' || !it.label) {
      add('error', 'checklist_item_label_required', `${itemPath}.label`,
        'checklist item requires a label string');
    }
    // `issue` is the condition that flips the row to ❌. Missing = row is always ✅.
    if (it.issue === undefined) {
      add('info', 'checklist_item_no_issue', `${itemPath}.issue`,
        'checklist item has no `issue` condition — the row will always show as ok');
    } else {
      validateConditionField(it.issue, `${itemPath}.issue`, add);
    }
    // Display text fields — all optional but missing all three is a usability smell.
    const hasAnyDetail = [it.detail_ok, it.detail_issue, it.detail_null]
      .some((d) => typeof d === 'string' && d.length > 0);
    if (!hasAnyDetail) {
      add('info', 'checklist_item_no_detail', itemPath,
        'checklist item has no detail_ok / detail_issue / detail_null — row will have no explanatory text');
    }
    // Type-check the detail fields if present
    for (const key of ['detail_ok', 'detail_issue', 'detail_null'] as const) {
      if (it[key] !== undefined && typeof it[key] !== 'string') {
        add('error', `checklist_item_${key}_shape`, `${itemPath}.${key}`,
          `${key} must be a string if present`);
      }
    }
    if (it.action !== undefined) {
      validateRecipeOutputAction(it.action, `${itemPath}.action`, add);
    }
    if (it.actions !== undefined) {
      if (!Array.isArray(it.actions)) {
        add('error', 'checklist_item_actions_shape', `${itemPath}.actions`,
          'checklist item actions must be an array of recipe output actions');
      } else {
        for (let a = 0; a < it.actions.length; a++) {
          validateRecipeOutputAction(it.actions[a], `${itemPath}.actions[${a}]`, add);
        }
      }
    }
  }
  // Duplicate labels → user confusion
  const labelCounts = new Map<string, number>();
  for (const item of items) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const label = (item as Record<string, unknown>).label;
      if (typeof label === 'string' && label) {
        labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
      }
    }
  }
  for (const [label, count] of labelCounts) {
    if (count > 1) {
      add('warn', 'checklist_item_duplicate_label', path,
        `checklist has ${count} items with label "${label}" — labels should be unique`);
    }
  }
};

/** Validate to_summary.fields[] — each field renders one row of the summary. */
const validateSummaryFields = (
  fields: unknown,
  path: string,
  add: AddFn,
): void => {
  if (fields === undefined) return;
  if (!Array.isArray(fields)) {
    add('error', 'summary_fields_shape', path, 'to_summary.fields must be an array');
    return;
  }
  if (fields.length === 0) {
    add('warn', 'summary_fields_empty', path,
      'to_summary.fields is empty — no rows will render');
    return;
  }
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const fPath = `${path}[${i}]`;
    if (!f || typeof f !== 'object' || Array.isArray(f)) {
      add('error', 'summary_field_shape', fPath, 'summary field must be an object');
      continue;
    }
    const fr = f as Record<string, unknown>;
    if (typeof fr.label !== 'string' || !fr.label) {
      add('error', 'summary_field_label_required', `${fPath}.label`,
        'summary field requires a label string');
    }
    if (fr.value === undefined) {
      add('error', 'summary_field_value_required', `${fPath}.value`,
        'summary field requires a value (reference or literal)');
    }
  }
};

/** Validate to_table.columns[] — each column is a header + data accessor. */
const validateTableColumns = (
  columns: unknown,
  path: string,
  add: AddFn,
): void => {
  if (columns === undefined) return;
  if (!Array.isArray(columns)) {
    add('error', 'table_columns_shape', path, 'to_table.columns must be an array');
    return;
  }
  if (columns.length === 0) {
    add('warn', 'table_columns_empty', path,
      'to_table.columns is empty — table will render with no columns');
    return;
  }
  for (let i = 0; i < columns.length; i++) {
    const c = columns[i];
    const cPath = `${path}[${i}]`;
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      add('error', 'table_column_shape', cPath, 'table column must be an object');
      continue;
    }
    const col = c as Record<string, unknown>;
    if (typeof col.field !== 'string' || !col.field) {
      add('error', 'table_column_field_required', `${cPath}.field`,
        'table column requires a field string');
    }
    if (col.label !== undefined && typeof col.label !== 'string') {
      add('error', 'table_column_label_shape', `${cPath}.label`,
        'table column label must be a string if present');
    } else if (col.label === undefined) {
      add('info', 'table_column_no_label', `${cPath}.label`,
        `column "${col.field}" has no label — header will fall back to the raw field name`);
    }
    if (
      col.type !== undefined
      && col.type !== 'text'
      && col.type !== 'action'
    ) {
      add('error', 'table_column_type_invalid', `${cPath}.type`,
        'table column type must be "text" or "action" if present');
    }
    if (col.type === 'action' && col.format !== undefined) {
      add('error', 'table_column_action_format', `${cPath}.format`,
        'action table columns may not declare a format');
    }
  }
};

const validateRecipeOutputAction = (
  value: unknown,
  path: string,
  add: AddFn,
): void => {
  if (!isRecord(value)) {
    add('error', 'recipe_output_action_shape', path,
      'recipe output action must be an object');
    return;
  }
  if (value.kind !== 'recipe.run') {
    add('error', 'recipe_output_action_kind', `${path}.kind`,
      'recipe output action kind must be "recipe.run"');
  }
  if (typeof value.label !== 'string' || value.label.trim().length === 0) {
    add('error', 'recipe_output_action_label_required', `${path}.label`,
      'recipe output action requires a non-empty label');
  }
  if (typeof value.recipe_id !== 'string' || value.recipe_id.trim().length === 0) {
    add('error', 'recipe_output_action_recipe_id_required', `${path}.recipe_id`,
      'recipe.run action requires a non-empty recipe_id');
  }
  if (value.variant !== undefined && !ACTION_VARIANTS.has(value.variant as string)) {
    add('error', 'recipe_output_action_variant', `${path}.variant`,
      'recipe output action variant must be "primary", "secondary", or "danger" if present');
  }
  if (value.confirm !== undefined && typeof value.confirm !== 'string') {
    add('error', 'recipe_output_action_confirm_shape', `${path}.confirm`,
      'recipe output action confirm must be a string if present');
  }
  validateActionRecordValue(value.config, `${path}.config`, 'config', add);
  validateActionRecordValue(value.context, `${path}.context`, 'context', add);
  if (isRecord(value.context)) {
    for (const key of ACTION_CONTEXT_RESERVED_KEYS) {
      if (Object.prototype.hasOwnProperty.call(value.context, key)) {
        add('error', 'recipe_output_action_context_reserved', `${path}.context.${key}`,
          `recipe output action context may not set reserved key "${key}"`);
      }
    }
  }
};

const validateActionRecordValue = (
  value: unknown,
  path: string,
  field: 'config' | 'context',
  add: AddFn,
): void => {
  if (value === undefined) return;
  if (!isRecord(value)) {
    add('error', `recipe_output_action_${field}_shape`, path,
      `recipe output action ${field} must be an object if present`);
    return;
  }
  validateJsonCompatible(value, path, add);
};

const validateJsonCompatible = (
  value: unknown,
  path: string,
  add: AddFn,
): void => {
  if (value === null) return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      validateJsonCompatible(value[i], `${path}[${i}]`, add);
    }
    return;
  }
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return;
    case 'number':
      if (!Number.isFinite(value)) {
        add('error', 'recipe_output_action_json_value', path,
          'recipe output action config/context must be JSON-compatible');
      }
      return;
    case 'object':
      if (!isRecord(value)) {
        add('error', 'recipe_output_action_json_value', path,
          'recipe output action config/context must be JSON-compatible');
        return;
      }
      for (const [key, child] of Object.entries(value)) {
        validateJsonCompatible(child, `${path}.${key}`, add);
      }
      return;
    default:
      add('error', 'recipe_output_action_json_value', path,
        'recipe output action config/context must be JSON-compatible');
  }
};

/** Validate switch.cases — must be a non-empty object. Phase 1 already
 *  checks that the top-level `cases` is an object (via TRANSFORM_SCHEMAS).
 *  Phase 3 checks emptiness and the `default` case. */
const validateSwitchShape = (
  step: Record<string, unknown>,
  path: string,
  add: AddFn,
): void => {
  const cases = step.cases;
  if (cases === undefined) return; // phase 1 catches missing required
  if (cases === null || typeof cases !== 'object' || Array.isArray(cases)) return; // phase 1 catches wrong type
  const caseKeys = Object.keys(cases as Record<string, unknown>);
  if (caseKeys.length === 0) {
    add('error', 'switch_cases_empty', `${path}.cases`,
      'switch.cases must define at least one case');
    return;
  }
  if (step.default === undefined) {
    add('info', 'switch_no_default', `${path}.default`,
      `switch has ${caseKeys.length} case(s) but no default — values outside the case set will yield null`);
  }
};

/** Validate any/all — at least one of `values` or `conditions` must be present. */
const validateAnyAllShape = (
  step: Record<string, unknown>,
  path: string,
  add: AddFn,
): void => {
  const hasValues = Array.isArray(step.values);
  const hasConditions = Array.isArray(step.conditions);
  if (!hasValues && !hasConditions) {
    add('error', 'any_all_missing_operands', path,
      `${step.transform} requires at least one of 'values' (array of boolean refs) or 'conditions' (array of condition strings)`);
    return;
  }
  if (hasValues && (step.values as unknown[]).length === 0) {
    add('warn', 'any_all_empty_values', `${path}.values`,
      `${step.transform}.values is an empty array — result is deterministic`);
  }
  if (hasConditions && (step.conditions as unknown[]).length === 0) {
    add('warn', 'any_all_empty_conditions', `${path}.conditions`,
      `${step.transform}.conditions is an empty array — result is deterministic`);
  }
};

/** Validate merge — at least one of `source` or `sources` must be present. */
const validateMergeShape = (
  step: Record<string, unknown>,
  path: string,
  add: AddFn,
): void => {
  const hasSource = step.source !== undefined;
  const hasSources = step.sources !== undefined;
  if (!hasSource && !hasSources) {
    add('error', 'merge_missing_operands', path,
      "merge requires at least one of 'source' (single object) or 'sources' (array of objects)");
    return;
  }
  if (hasSources && !Array.isArray(step.sources)) {
    add('error', 'merge_sources_shape', `${path}.sources`,
      'merge.sources must be an array of objects');
  }
};

/** Validate AI function input contracts — each built-in AI slug has a fixed
 *  set of required llm.* inputs. Recipes using ai-classify without
 *  llm.categories won't work, and the validator should catch it statically. */
const validateAiFunctionInputs = (
  step: Record<string, unknown>,
  path: string,
  add: AddFn,
): void => {
  const slug = step.ingredient as string; // raw, for author-facing messages
  const required = AI_FUNCTION_REQUIRED_INPUTS[stripCorePrefix(slug)];
  if (!required) return;

  if (!step.input || typeof step.input !== 'object' || Array.isArray(step.input)) {
    add('error', 'ai_function_input_missing', `${path}.input`,
      `${slug} requires input with keys: ${required.join(', ')}`);
    return;
  }
  const input = step.input as Record<string, unknown>;
  for (const key of required) {
    if (!(key in input)) {
      add('error', 'ai_function_input_missing_key', `${path}.input['${key}']`,
        `${slug} requires input.${key}`);
      continue;
    }
    // Optional type checks for the array-valued ones
    if (key === 'llm.categories' || key === 'llm.criteria' || key === 'llm.fields') {
      const val = input[key];
      // Skip references — they resolve at runtime
      if (typeof val === 'string' && REF_PATTERN.test(val)) continue;
      if (!Array.isArray(val)) {
        add('error', 'ai_function_input_wrong_type', `${path}.input['${key}']`,
          `${slug} expects input.${key} to be an array`);
      } else if (val.length === 0) {
        add('warn', 'ai_function_input_empty_array', `${path}.input['${key}']`,
          `${slug} input.${key} is an empty array — the AI has nothing to work with`);
      }
    }
  }

  // D-167 P6.2 — soft-warn on an implausible single-step `llm.pii_fields` tag.
  validatePiiFields(input, slug, path, add);
};

/** A pure whole-value template ref (`"{{x}}"`) resolves type-preserving at
 *  runtime (Value System: a bare ref keeps its resolved type), so the resolved
 *  value can't be inspected statically and the check is skipped. A string with
 *  literal text outside the braces (`"a {{x}}"`) INTERPOLATES to a string at
 *  runtime, so it is checkable and must NOT be skipped. Anchored — mirrors the
 *  `^\{\{…\}\}$` test in `@recued/contracts` values.ts. */
const isWholeRef = (v: unknown): v is string =>
  typeof v === 'string' && /^\{\{[^}]+\}\}$/.test(v);

/** D-167 P6.2 — Kitchen design-time soft warnings for a single-step
 *  `llm.pii_fields` tag on a contracted `ai-*` step (D-167 §"Single-step `ai-*`
 *  PII"). The runtime is the hard gate: `normalizePiiFields` fails closed on a
 *  malformed declaration and `executeLLM` throws on a slug with no `llm.data`
 *  payload. This is the friendly heads-up so an author catches a typo in the
 *  Kitchen BEFORE running, so every finding here is `warn` / `info`, NEVER
 *  `error` — it can warn but must not block a valid recipe: the runtime is
 *  best-effort pass-through (undeclared-but-present data fields are legal, e.g.
 *  HubSpot's ~300), so a tag is never forced to match a known field. Mirrors the
 *  tag logic of the across-step transform's `pii_protect_bad_field_tag`
 *  (validate/quality.ts) at a softer altitude. */
const validatePiiFields = (
  input: Record<string, unknown>,
  slug: string,
  path: string,
  add: AddFn,
): void => {
  const raw = input['llm.pii_fields'];
  // Absent / explicit-null → valid empty no-op (normalizePiiFields returns []).
  if (raw === undefined || raw === null) return;
  const fieldPath = `${path}.input['llm.pii_fields']`;

  // A pure whole-value `{{ref}}` map resolves type-preserving at runtime, so it
  // could become a valid map — nothing to check statically. An INTERPOLATED
  // string ("x {{ref}}") resolves to a string, never a map, so it falls through
  // to the shape warning below — matching normalizePiiFields' runtime fail-closed.
  if (isWholeRef(raw)) return;

  // Shape: the substrate needs a plain `{ "<path>": "<kind>" }` map and fails
  // closed on anything else (`normalizePiiFields` throws). Recipe JSON can only
  // yield plain objects / arrays / primitives, so an object that isn't an array
  // is plain enough — no prototype check needed.
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    add('warn', 'ai_pii_fields_shape', fieldPath,
      `${slug} llm.pii_fields must be a { "<path>": "<kind>" } map; the alias substrate rejects any other shape at run time (fail closed)`);
    return;
  }

  // Unsupported slug: only the 8 batch-capable contracted functions take an
  // `llm.data` payload — the only payload the single-step aliaser protects. On
  // `ai-compare` (llm.data_a/_b) / `ai-prompt` (freeform llm.prompt) the real
  // payload would ship raw, so `executeLLM` fails closed rather than feign
  // protection — steer the author to alias upstream with the `pii-protect`
  // transform. (Reaches here because `ai-compare` / `ai-prompt` are themselves
  // in AI_FUNCTION_REQUIRED_INPUTS.)
  if (!isBatchCapableAISlug(slug)) {
    add('warn', 'ai_pii_fields_unsupported_slug', fieldPath,
      `${slug} has no llm.data payload, so llm.pii_fields cannot protect it and fails closed at run time — alias upstream with the pii-protect transform instead`);
    return;
  }

  // The only "declared contract" visible at author time is an inline-literal
  // `llm.data` OBJECT (single mode). When `llm.data` is a `{{ref}}` (the common
  // case) or an array (D-162 batch, paths apply per-element) the shape is
  // unknown, so the path-existence check is skipped — never forcing a field to
  // exist (undeclared-but-present fields are valid).
  const data = input['llm.data'];
  const literalDataKeys =
    data !== null && typeof data === 'object' && !Array.isArray(data)
      ? new Set(Object.keys(data as Record<string, unknown>))
      : null;

  for (const [tagPath, kind] of Object.entries(raw as Record<string, unknown>)) {
    if (tagPath.length === 0) {
      add('warn', 'ai_pii_fields_empty_path', fieldPath,
        `${slug} llm.pii_fields has an empty field-path key — the alias substrate rejects it at run time (fail closed)`);
      continue;
    }
    const entryPath = `${fieldPath}['${tagPath}']`;
    // A pure whole-value `{{ref}}` kind resolves type-preserving and could be a
    // valid kind — skip it (and never echo it: it could carry real data, the
    // caution normalizePiiFields takes). An interpolated string falls through to
    // the unknown-kind warning, since it resolves to a non-kind string at runtime.
    if (isWholeRef(kind)) continue;
    if (!isEntityFieldPrivacy(kind)) {
      add('warn', 'ai_pii_fields_unknown_kind', entryPath,
        `llm.pii_fields["${tagPath}"] kind ${JSON.stringify(kind)} is not one of the 9 privacy kinds (email/name/org/phone/address/url/external_id/account_id/content) — that field would NOT be aliased; the alias substrate rejects it at run time (fail closed)`);
      continue;
    }
    // Unmatched source path (best-effort): only checkable when `llm.data` is an
    // inline-literal object. Compare the path's root segment against its keys —
    // a literal can't carry an undeclared-but-present field, so a missing root
    // is a real typo worth a warning.
    if (literalDataKeys) {
      const root = tagPath.split('.')[0];
      if (!literalDataKeys.has(root)) {
        add('warn', 'ai_pii_fields_unmatched_path', entryPath,
          `llm.pii_fields path "${tagPath}" matches no field in the inline llm.data object — verify the path (a path absent at run time simply aliases nothing)`);
      }
    }
  }
};
