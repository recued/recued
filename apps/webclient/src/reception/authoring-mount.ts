/** D-149 § A.9 + § A.5.x — Reception per-kind
 *  authoring-form mount + the shared working-config container.
 *
 *  `authoring.ts` is the projection layer (`build<Kind>FormModel`
 *  / `validate<Kind>FormConfig` / the dispatch builders) and
 *  `authoring-render.ts` is the pure renderer
 *  (`renderAuthoringForm`). Both are substrate. **This is the stateful
 *  piece they were built for: the working-config container.** It holds
 *  the per-kind config blob being edited, wires the renderer's
 *  `data-field-*` / `data-repeater-*` markup to mutate it, re-renders on
 *  structural change, runs `validate<Kind>FormConfig` on submit, and
 *  fires the dispatch builders against the `ReceptionPageShell`.
 *
 *  ── Two exports + the shared machinery ────────────────────────────
 *    - **`mountAuthoringForm(opts)`** — the `mountReceptionPage`-shape
 *      mount: seeds a working config, renders into a host element,
 *      installs a delegated `data-action` dispatcher (repeater add /
 *      remove, preview, submit, cancel) + a delegated `input` / `change`
 *      field-edit dispatcher, and drives the `reception.*` rpc through
 *      the injected shell. Returns an `update()` / `dispose()` handle.
 *    - **the working-config machinery** — `seedWorkingConfig`,
 *      `buildAuthoringView`, `validateConfigForKind`, `applyFieldDelegateEvent`,
 *      `addRepeaterRow` / `removeRepeaterRow`, `attachFieldDelegator`.
 *      Exported because `launch-wizard-mount.ts` reuses every
 *      one of them — the wizard's four config-editing steps embed the
 *      exact same per-kind authoring forms.
 *
 *  ── Why a delegated field dispatcher, not `attachFieldHandlers` ────
 *  `@recued/ui-shared/field-dispatcher`'s `attachFieldHandlers` is
 *  per-element (`querySelectorAll`) — it needs a real DOM, which the
 *  DOM-free fake-host test pattern (the `action-dispatcher.test.ts`
 *  shape every Reception mount test uses) does not provide.
 *  `attachFieldDelegator` here is the delegation analog of
 *  `createActionDispatcher`: one `input` + one `change` listener on the
 *  root, `event.target.closest('[data-field-control]')` to resolve the
 *  control. It de-dupes across the two listeners with the same
 *  tag-based "commit event" rule `field-dispatcher.ts` documents (a
 *  `<select>` fires both `input` and `change`).
 *
 *  ── Working config ≠ model `key`s — two non-obvious translations ──
 *  The renderer tags every control with `data-field-key` (the model
 *  field's `key` — a *DOM locator*, NOT always the contract config
 *  path). Two kinds need translation back to the contract shape:
 *    1. **`reception_page`** — the six `display_overrides.*` fields are
 *       *flat-keyed* in the model (`display_name`, `tagline`, … — NOT
 *       `display_overrides.display_name`). `resolveConfigPath` re-nests
 *       them. The `sections_enabled.*` / `linked_endpoints.*` fields
 *       already carry the prefix, and every other kind's keys mirror
 *       the contract path 1:1.
 *    2. **`status_link`** — `source_ref` is a discriminated union keyed
 *       on `kind` with a per-kind id field; the model splits it into
 *       `source_ref.kind` + `source_ref.id`. `setConfigValue`
 *       reassembles via the contract's `buildStatusLinkSourceRef` /
 *       `readStatusLinkSourceId` so the id round-trips under the new
 *       kind's id field.
 *
 *  ── Re-render discipline ──────────────────────────────────────────
 *  The whole webclient UI is HTML-string rendering — every re-render
 *  rebuilds `host.innerHTML` and so loses input focus. Field edits
 *  therefore mutate the working config *silently* (no re-render — the
 *  DOM input already shows the typed value). Only structural changes
 *  re-render: repeater add / remove, intake target-kind changes (which
 *  show or hide entity-mapping controls), and a failed submit
 *  (the error panel + disabled submit). The one focus cost: the first
 *  field edit after a failed submit clears the stale validation summary
 *  and re-renders once (re-enabling the disabled submit button).
 *
 *  Spec: D-149 § A.9 (Settings UX) + § A.5.1-A.5.6
 *  (per-kind config contracts) + § A.3 (preview-hash-gated create). */

import { createActionDispatcher } from '@recued/ui-shared/action-dispatcher';
// D-210 WS3 — the authoring default a fresh calendar end-mode seeds.
import { INTAKE_FORM_CALENDAR_DEFAULT_DURATION_MINUTES } from '@recued/contracts';

import type {
  ApprovalLinkConfig,
  DropLinkConfig,
  IntakeFormConfig,
  PacketDeclaration,
  ReceptionEndpointCreateResult,
  ReceptionEndpointKind,
  ReceptionPageConfig,
  SchedulingLinkConfig,
  SourceQueryRef,
  StatusLinkConfig,
} from '@recued/contracts';

import {
  buildApprovalLinkFormModel,
  buildDropLinkFormModel,
  buildEndpointCreateDispatch,
  buildEndpointPreviewDispatch,
  buildIntakeFormFormModel,
  buildReceptionPageFormModel,
  buildReceptionPageUpsertDispatch,
  buildSchedulingLinkFormModel,
  buildStatusLinkFormModel,
  buildStatusLinkSourceRef,
  readStatusLinkSourceId,
  INTAKE_FORM_CALENDAR_END_MODE_KEY,
  type IntakeFormCalendarEndMode,
  validateApprovalLinkFormConfig,
  validateDropLinkFormConfig,
  validateIntakeFormFormConfig,
  validateReceptionPageFormConfig,
  validateSchedulingLinkFormConfig,
  validateStatusLinkFormConfig,
  type AuthoringValidationSummary,
  type StatusLinkSourceKind,
} from './authoring.js';
import {
  renderAuthoringForm,
  type AuthoringFormAction,
  type AuthoringFormView,
} from './authoring-render.js';
import type { ReceptionPageShell } from './page-shell.js';

// ════════════════════════════════════════════════════════════════
// Dotted-path get / set over a plain working-config object
// ════════════════════════════════════════════════════════════════

/** Set `value` at a dotted `path` in `target`, materialising any
 *  missing intermediate objects. Numeric repeater indices are NOT a
 *  `path` concern — repeater cells are mutated in place by index (see
 *  `applyFieldDelegateEvent`). Pure mutation — no I/O. */
const setPath = (
  target: Record<string, unknown>,
  path: string,
  value: unknown,
): void => {
  const segments = path.split('.');
  let node: Record<string, unknown> = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i]!;
    const next = node[segment];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      node[segment] = {};
    }
    node = node[segment] as Record<string, unknown>;
  }
  node[segments[segments.length - 1]!] = value;
};

/** Read the value at a dotted `path` in `target`. Returns `undefined`
 *  for any missing / non-object intermediate. Pure — no I/O. */
const getPath = (target: Record<string, unknown>, path: string): unknown => {
  let node: unknown = target;
  for (const segment of path.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
};

/** Materialise every object along a dotted `path` (no leaf is set). Used
 *  to keep the load-bearing sub-objects (`reception_page`'s
 *  `linked_endpoints` is all-optional-text — every leaf can be omitted)
 *  present so the no-null-guard validators never throw. Pure mutation. */
const ensurePath = (target: Record<string, unknown>, path: string): void => {
  let node: Record<string, unknown> = target;
  for (const segment of path.split('.')) {
    const next = node[segment];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      node[segment] = {};
    }
    node = node[segment] as Record<string, unknown>;
  }
};

/** Delete the leaf at a dotted `path`, leaving the intermediates intact.
 *  Used when an optional text field is cleared back to empty. No-op for
 *  a missing intermediate. Pure mutation. */
const deletePath = (target: Record<string, unknown>, path: string): void => {
  const segments = path.split('.');
  let node: unknown = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (node === null || typeof node !== 'object') return;
    node = (node as Record<string, unknown>)[segments[i]!];
  }
  if (node !== null && typeof node === 'object') {
    delete (node as Record<string, unknown>)[segments[segments.length - 1]!];
  }
};

// ════════════════════════════════════════════════════════════════
// Model `key` → contract config path translation
// ════════════════════════════════════════════════════════════════

/** `reception_page`'s six `display_overrides.*` fields are flat-keyed
 *  in `buildReceptionPageFormModel` (the model `key` is a DOM locator,
 *  not the contract path). Re-nest them under `display_overrides`. */
const RECEPTION_PAGE_DISPLAY_OVERRIDE_KEYS: ReadonlySet<string> = new Set([
  'display_name',
  'tagline',
  'tz_label',
  'avatar_url',
  'response_time_estimate',
  'preferred_contact_methods',
]);

/** Translate a renderer `data-field-key` (the model field `key`) to the
 *  contract config path. Identity for every kind / key except
 *  `reception_page`'s flat-keyed `display_overrides.*` fields. */
const resolveConfigPath = (kind: ReceptionEndpointKind, key: string): string =>
  kind === 'reception_page' && RECEPTION_PAGE_DISPLAY_OVERRIDE_KEYS.has(key)
    ? `display_overrides.${key}`
    : key;

/** Set a scalar form value into the working config at the contract
 *  path. Handles the `status_link` `source_ref` discriminated-union
 *  reassembly; every other key resolves through `resolveConfigPath`. */
const setConfigValue = (
  kind: ReceptionEndpointKind,
  config: Record<string, unknown>,
  key: string,
  value: unknown,
): void => {
  if (
    kind === 'status_link' &&
    (key === 'source_ref.kind' || key === 'source_ref.id')
  ) {
    const current = config.source_ref as SourceQueryRef | undefined;
    if (key === 'source_ref.kind') {
      config.source_ref = buildStatusLinkSourceRef(
        value as StatusLinkSourceKind,
        readStatusLinkSourceId(current),
      );
    } else {
      const currentKind =
        (current?.kind as StatusLinkSourceKind | undefined) ?? 'data.task';
      config.source_ref = buildStatusLinkSourceRef(currentKind, String(value));
    }
    return;
  }
  // D-220 Slice B (follow-up) — owner-only field names are string rows the
  // owner types; a row left blank is not a field, so it is dropped here rather
  // than failing validation as an empty name.
  if (kind === 'intake_form' && key === 'form_definition.user_only_field_names' && Array.isArray(value)) {
    value = value.filter((row) => typeof row === 'string' && row.trim().length > 0).map((row) => (row as string).trim());
  }
  setPath(config, resolveConfigPath(kind, key), value);
};

/** Write one form field's value into the working config — the entry
 *  point for both the seed walk and the live field-edit handler.
 *
 *  An **empty text value is treated as "not set"**: the leaf is omitted
 *  (and any stale value deleted) rather than written as `''`. This is
 *  load-bearing for validity — the contract validators reject a
 *  *present-but-empty* optional string (`scheduling_link`'s
 *  `instructions` / `success_message`, …), so materialising the model
 *  builder's `?? ''` defaults would make a freshly-seeded config fail on
 *  fields the user never touched. A
 *  required empty field still fails — the validator's type-gate catches
 *  the omitted (`undefined`) value. The parent sub-object is still
 *  materialised so the no-null-guard validators never throw.
 *
 *  `status_link`'s `source_ref.*` always routes through `setConfigValue`
 *  — it reassembles the discriminated union, and an empty id surfaces as
 *  the validator's `source_ref_missing_id_field`, the correct error. */
/** D-210 WS3 — the first form field a given end-mode could legitimately name.
 *  Read off the WORKING CONFIG rather than the model so a mode switch made in
 *  the same tick as a field edit still sees the current fields. `undefined`
 *  when the form has none — the mode then does not stick, which is honest: you
 *  cannot end an event with a field that does not exist. */
const firstEligibleCalendarField = (
  config: Record<string, unknown>,
  mode: 'end_field' | 'duration_field',
): string | undefined => {
  const fields = getPath(config, 'form_definition.fields');
  if (!Array.isArray(fields)) return undefined;
  const start = getPath(config, 'submission_processing_rule.calendar_mapping.start_field');
  const wanted = mode === 'duration_field'
    ? (t: unknown) => t === 'number'
    : (t: unknown) => t === 'date' || t === 'datetime';
  for (const f of fields) {
    if (f === null || typeof f !== 'object') continue;
    const row = f as Record<string, unknown>;
    if (typeof row.name !== 'string' || !wanted(row.type)) continue;
    // An end field must differ from the start — the same rule the contract
    // validator enforces, applied here so the seeded value is never DOA.
    if (mode === 'end_field' && row.name === start) continue;
    return row.name;
  }
  return undefined;
};

const putConfigField = (
  kind: ReceptionEndpointKind,
  config: Record<string, unknown>,
  key: string,
  control: FieldDelegateEvent['control'],
  value: unknown,
): void => {
  if (
    kind === 'status_link' &&
    (key === 'source_ref.kind' || key === 'source_ref.id')
  ) {
    setConfigValue(kind, config, key, value);
    return;
  }
  // D-210 WS3 — the calendar end-mode is a SYNTHETIC discriminator, not a
  // contract path. The contract expresses the choice by which of the three
  // end-spec keys is present (exactly one), so a mode switch must set the
  // chosen key and DELETE the other two — the same reassembly `status_link`'s
  // `source_ref.kind` does above. Writing the synthetic key itself would
  // persist a field the validator has never heard of.
  if (key === INTAKE_FORM_CALENDAR_END_MODE_KEY) {
    const base = 'submission_processing_rule.calendar_mapping';
    ensurePath(config, base);
    for (const spec of ['end_field', 'duration_field', 'default_duration_minutes']) {
      deletePath(config, `${base}.${spec}`);
    }
    // Seed the chosen spec so the mode STICKS: it is derived from which key is
    // present, so switching to a mode and writing nothing would read back as
    // the default and the control would snap back under the owner.
    const chosen = value as IntakeFormCalendarEndMode;
    if (chosen === 'default_duration_minutes') {
      setPath(config, `${base}.default_duration_minutes`, INTAKE_FORM_CALENDAR_DEFAULT_DURATION_MINUTES);
    } else {
      const first = firstEligibleCalendarField(config, chosen);
      if (first !== undefined) setPath(config, `${base}.${chosen}`, first);
    }
    return;
  }

  // D-210 WS3 — switching the intake TARGET to `calendar` seeds a usable
  // mapping. Without it the destination is born invalid: the end-mode control
  // derives to "a fixed length" but no end-spec key exists, so the owner would
  // see an error for a choice the form is already showing as made. Seeded only
  // when absent, so switching away and back keeps whatever was authored.
  if (
    kind === 'intake_form'
    && key === 'submission_processing_rule.target_kind'
    && value === 'calendar'
    && getPath(config, 'submission_processing_rule.calendar_mapping') === undefined
  ) {
    setConfigValue(kind, config, key, value);
    setPath(
      config,
      'submission_processing_rule.calendar_mapping.default_duration_minutes',
      INTAKE_FORM_CALENDAR_DEFAULT_DURATION_MINUTES,
    );
    return;
  }

  // An empty scalar means "this key is absent", not "this key is `''`".
  //
  // For `text` that has always been true (validators reject `''`). D-210 WS2
  // extends it to `select`: an optional closed-list field is authored as an
  // empty option — the intake `submission_processing_rule.target_kind`, where
  // absent = log-only. Every select's options are non-empty strings by
  // construction, so `''` can only ever come from such a deliberate "none"
  // option; there is no select for which `''` is a storable value.
  if ((control === 'text' || control === 'select') && value === '') {
    const path = resolveConfigPath(kind, key);
    const lastDot = path.lastIndexOf('.');
    if (lastDot > 0) ensurePath(config, path.slice(0, lastDot));
    deletePath(config, path);
    return;
  }
  setConfigValue(kind, config, key, value);
};

// ════════════════════════════════════════════════════════════════
// Per-kind model / validator dispatch
// ════════════════════════════════════════════════════════════════

const isAuthoringField = (value: unknown): value is { control: string; key: string } =>
  value !== null && typeof value === 'object' && 'control' in value;

/** Build the renderer's `AuthoringFormView` for a kind from a working
 *  config (or `null` for a fresh seed). `isNew` overrides the model
 *  builder's own `config === null` derivation — the container holds a
 *  non-null working object even for a fresh create, so the "Set up" vs
 *  "Edit" heading must be driven by the caller's intent, not the
 *  working object's nullness. */
export const buildAuthoringView = (
  kind: ReceptionEndpointKind,
  // `object | null` so a caller can pass either a live working config
  // (`Record<string, unknown>`) or a typed contract config (the
  // interfaces carry no index signature) — the model builders cast each
  // to the kind's `<Kind>Config | null`.
  config: object | null,
  validation: AuthoringValidationSummary<string> | null,
  isNew: boolean,
): AuthoringFormView => {
  switch (kind) {
    case 'reception_page':
      return {
        kind,
        model: {
          ...buildReceptionPageFormModel(config as ReceptionPageConfig | null),
          is_new: isNew,
        },
        validation,
      };
    case 'scheduling_link':
      return {
        kind,
        model: {
          ...buildSchedulingLinkFormModel(config as SchedulingLinkConfig | null),
          is_new: isNew,
        },
        validation,
      };
    case 'intake_form':
      return {
        kind,
        model: {
          ...buildIntakeFormFormModel(config as IntakeFormConfig | null),
          is_new: isNew,
        },
        validation,
      };
    case 'drop_link':
      return {
        kind,
        model: {
          ...buildDropLinkFormModel(config as DropLinkConfig | null),
          is_new: isNew,
        },
        validation,
      };
    case 'approval_link':
      return {
        kind,
        model: {
          ...buildApprovalLinkFormModel(config as ApprovalLinkConfig | null),
          is_new: isNew,
        },
        validation,
      };
    case 'status_link':
      return {
        kind,
        model: {
          ...buildStatusLinkFormModel(config as StatusLinkConfig | null),
          is_new: isNew,
        },
        validation,
      };
  }
};

/** Validate a working config through the kind's contract validator +
 *  resolve the failure copy. The per-kind `AuthoringValidationSummary<XCode>`
 *  is assignable to `<string>` (the `code` is a covariant readonly
 *  field). Pure — no I/O; the link-kind validators never throw. */
export const validateConfigForKind = (
  kind: ReceptionEndpointKind,
  config: Record<string, unknown>,
): AuthoringValidationSummary<string> => {
  switch (kind) {
    case 'reception_page':
      return validateReceptionPageFormConfig(config as unknown as ReceptionPageConfig);
    case 'scheduling_link':
      return validateSchedulingLinkFormConfig(config);
    case 'intake_form':
      return validateIntakeFormFormConfig(config);
    case 'drop_link':
      return validateDropLinkFormConfig(config);
    case 'approval_link':
      return validateApprovalLinkFormConfig(config);
    case 'status_link':
      return validateStatusLinkFormConfig(config);
  }
};

// ════════════════════════════════════════════════════════════════
// Working-config seed
// ════════════════════════════════════════════════════════════════

/** Apply one model field's current value into the working config at its
 *  contract path. Repeater rows + multiselect arrays are shallow-cloned
 *  so later mutation never reaches back into the model; scalar fields
 *  route through `putConfigField` (empty text is omitted, not `''`). */
const applyFieldToConfig = (
  kind: ReceptionEndpointKind,
  config: Record<string, unknown>,
  field: Record<string, unknown>,
): void => {
  const control = field.control as FieldDelegateEvent['control'] | 'repeater';
  const key = field.key as string;
  if (control === 'repeater') {
    const rows = (field.rows as ReadonlyArray<unknown>).map((row) =>
      row !== null && typeof row === 'object'
        ? { ...(row as Record<string, unknown>) }
        : row,
    );
    setConfigValue(kind, config, key, rows);
  } else if (control === 'multiselect') {
    setConfigValue(kind, config, key, [...(field.value as ReadonlyArray<unknown>)]);
  } else {
    putConfigField(kind, config, key, control, field.value);
  }
};

/** Seed a complete, contract-shaped working config for a kind. Builds
 *  the model from the caller's seed (or `null` for a fresh create — the
 *  model builder materialises every default) and walks every field back
 *  through `setConfigValue`. The result always carries the load-bearing
 *  sub-objects (`reception_page`'s `display_overrides` / `sections_enabled`
 *  / `linked_endpoints`, `scheduling_link`'s `on_booking`, …) so the
 *  kind's contract validator — which dereferences them without a
 *  null-guard — never throws. Pure — no I/O. */
export const seedWorkingConfig = (
  kind: ReceptionEndpointKind,
  initial: object | null,
): Record<string, unknown> => {
  const { model } = buildAuthoringView(kind, initial, null, initial === null);
  const config: Record<string, unknown> = {};
  // `model` is the six-member discriminated union — none carries an
  // index signature, so `Object.values` resolves to the `{}` overload
  // (`any[]`); each entry is then narrowed by `isAuthoringField`.
  for (const entry of Object.values(model)) {
    if (Array.isArray(entry)) {
      for (const field of entry) {
        if (isAuthoringField(field)) {
          applyFieldToConfig(kind, config, field as Record<string, unknown>);
        }
      }
    } else if (isAuthoringField(entry)) {
      applyFieldToConfig(kind, config, entry as Record<string, unknown>);
    }
    // `is_new` (boolean) — skipped; it is a model flag, not a config field.
  }
  // D-220 Slice B (audit) — a template seed carries `template_version`
  // (provenance the endpoint row records), which the model has no field for.
  // Rebuilding the config from editable fields alone dropped it before
  // preview / create — for Foundation templates too. Carry it from the seed;
  // the kind's validator still bounds it at preview. (Owner-only field names
  // were carried the same way until the model grew its own repeater.)
  if (kind === 'intake_form' && initial !== null) {
    const seed = initial as { template_version?: unknown };
    if (typeof seed.template_version === 'string' && config.template_version === undefined) {
      config.template_version = seed.template_version;
    }
  }
  return config;
};

// ════════════════════════════════════════════════════════════════
// Repeater row editing
// ════════════════════════════════════════════════════════════════

/** Fresh default row per repeater (keyed on the model repeater `key` —
 *  every repeater `key` mirrors its contract path 1:1, so it doubles as
 *  the `getPath` argument). The structured-row repeaters seed an empty
 *  shape; the string-row repeaters (the email-domain allowlists, the
 *  approval-link counterparty aliases / private notes) seed `''`. */
const REPEATER_DEFAULT_ROW: Readonly<Record<string, () => unknown>> = {
  // reception_page § A.5.1
  custom_links: () => ({ label: '', url: '' }),
  link_buttons: () => ({ label: '', url: '', description: '' }),
  // scheduling_link § A.5.2
  'available_window_definition.explicit_windows': () => ({
    day_of_week: 1,
    start_minute: 540,
    end_minute: 1020,
  }),
  // intake_form § A.5.3
  'form_definition.fields': () => ({
    name: '',
    type: 'text',
    label: '',
    required: false,
    values: [],
  }),
  'anti_spam.known_domain_allowlist': () => '',
  // D-220 Slice B (follow-up) — owner-only field names are string rows.
  'form_definition.user_only_field_names': () => '',
  // drop_link § A.5.4
  known_domain_allowlist: () => '',
  // approval_link § A.5.5
  'context_raw.counterparty_aliases': () => '',
  'context_raw.private_notes': () => '',
  options: () => ({ id: '', label: '', description: '' }),
};

/** Append a fresh default row to a repeater. No-op for an unknown
 *  repeater key or a missing array (the renderer never emits either). */
export const addRepeaterRow = (
  config: Record<string, unknown>,
  repeaterKey: string,
): void => {
  const arr = getPath(config, repeaterKey);
  const factory = REPEATER_DEFAULT_ROW[repeaterKey];
  if (!Array.isArray(arr) || factory === undefined) return;
  arr.push(factory());
};

/** Remove a repeater row by index. No-op for a missing array or an
 *  out-of-range index. */
export const removeRepeaterRow = (
  config: Record<string, unknown>,
  repeaterKey: string,
  rowIndex: number,
): void => {
  const arr = getPath(config, repeaterKey);
  if (!Array.isArray(arr)) return;
  if (Number.isInteger(rowIndex) && rowIndex >= 0 && rowIndex < arr.length) {
    arr.splice(rowIndex, 1);
  }
};

// ════════════════════════════════════════════════════════════════
// Delegated field-edit dispatcher
// ════════════════════════════════════════════════════════════════

/** A resolved field-edit event — the structured form of one `input` /
 *  `change` on a control the authoring renderer tagged with
 *  `data-field-control`. Either a top-level field (`fieldKey` set) or a
 *  repeater cell (`repeaterKey` + `rowIndex` + `rowField` set). */
export interface FieldDelegateEvent {
  readonly control: 'text' | 'number' | 'toggle' | 'select' | 'multiselect';
  /** Top-level field `data-field-key` — `null` for a repeater cell. */
  readonly fieldKey: string | null;
  /** Repeater `data-repeater-key` — `null` for a top-level field. */
  readonly repeaterKey: string | null;
  readonly rowIndex: number | null;
  readonly rowField: string | null;
  /** Multiselect `data-option-value` — `null` for every other control. */
  readonly optionValue: string | null;
  /** `el.value` — the raw input string (coerced per `control`). */
  readonly value: string;
  /** `el.checked` — meaningful for the `toggle` / `multiselect` controls. */
  readonly checked: boolean;
}

const FIELD_CONTROLS: ReadonlySet<string> = new Set([
  'text',
  'number',
  'toggle',
  'select',
  'multiselect',
]);

/** Which DOM event a control commits on — `change` for `<select>` +
 *  checkbox, `input` for everything else. Mirrors `field-dispatcher.ts`'s
 *  `resolveEvent` so the delegated listener over both events does not
 *  double-fire (a `<select>` fires both `input` and `change`). */
const resolveFieldEvent = (el: {
  tagName?: string;
  type?: string;
}): 'input' | 'change' => {
  if (el.tagName === 'SELECT') return 'change';
  if (el.tagName === 'INPUT' && el.type === 'checkbox') return 'change';
  return 'input';
};

type FieldElement = HTMLElement & {
  value?: string;
  checked?: boolean;
  type?: string;
};

/** Install a delegated `input` + `change` listener on `root` that
 *  resolves every event off a `[data-field-control]` element into a
 *  structured `FieldDelegateEvent` + hands it to `handler`. The
 *  delegation analog of `createActionDispatcher` — one listener per
 *  event type, re-render-survivable. Returns a `dispose` fn. */
export const attachFieldDelegator = (
  root: HTMLElement,
  handler: (event: FieldDelegateEvent) => void,
): (() => void) => {
  const listener = (event: Event): void => {
    const target = event.target as FieldElement | null;
    if (target === null) return;
    const el = target.closest('[data-field-control]') as FieldElement | null;
    if (el === null || !root.contains(el)) return;
    // De-dupe across the two listeners: only the control's commit event
    // acts (a `<select>` fires both `input` and `change`).
    if (resolveFieldEvent(el) !== event.type) return;
    const dataset = el.dataset;
    const control = dataset.fieldControl;
    if (control === undefined || !FIELD_CONTROLS.has(control)) return;
    const rowIndexRaw = dataset.rowIndex;
    handler({
      control: control as FieldDelegateEvent['control'],
      fieldKey: dataset.fieldKey ?? null,
      repeaterKey: dataset.repeaterKey ?? null,
      rowIndex: rowIndexRaw !== undefined ? Number(rowIndexRaw) : null,
      rowField: dataset.rowField ?? null,
      optionValue: dataset.optionValue ?? null,
      value: el.value ?? '',
      checked: el.checked ?? false,
    });
  };
  root.addEventListener('input', listener);
  root.addEventListener('change', listener);
  return () => {
    root.removeEventListener('input', listener);
    root.removeEventListener('change', listener);
  };
};

// ════════════════════════════════════════════════════════════════
// Field-edit value coercion
// ════════════════════════════════════════════════════════════════

/** Coerce a top-level scalar field's raw input by its `control`. */
const coerceScalarValue = (event: FieldDelegateEvent): unknown => {
  if (event.control === 'number') return Number(event.value);
  if (event.control === 'toggle') return event.checked;
  return event.value;
};

/** Coerce a repeater cell's raw input. Two cells need more than the
 *  `control` says:
 *    - `form_definition.fields` rows surface `values` as a comma-joined
 *      string (`row.values.join(', ')`); the contract row carries
 *      `values: string[]`.
 *    - `day_of_week` is a numeric `select` cell — the contract row
 *      types it `number`; preserve the existing cell value's type. */
const coerceCellValue = (event: FieldDelegateEvent, current: unknown): unknown => {
  if (event.repeaterKey === 'form_definition.fields' && event.rowField === 'values') {
    return event.value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  if (event.control === 'number') return Number(event.value);
  if (event.control === 'toggle') return event.checked;
  if (event.control === 'select') {
    return typeof current === 'number' ? Number(event.value) : event.value;
  }
  return event.value;
};

/** Multiselect fields whose array elements are `number`, not `string` —
 *  the option toggle coerces `data-option-value` to a number for these.
 *  Keyed on the model `key` (a closed list; today only
 *  `scheduling_link.duration_options_minutes`). Element type MUST come
 *  from the key, not the current array: an emptied multiselect carries
 *  no element to infer from, so a re-check would push a string. */
const NUMERIC_MULTISELECT_KEYS: ReadonlySet<string> = new Set([
  'duration_options_minutes',
]);

/** Apply one resolved `FieldDelegateEvent` to a working config in place.
 *  Top-level scalar fields route through `putConfigField` (kind-aware
 *  path translation, empty-text omission); multiselect option toggles
 *  add / remove from the array preserving its element type; repeater
 *  cells mutate the indexed row. No-op for any locator that does not
 *  resolve. Pure mutation. */
export const applyFieldDelegateEvent = (
  kind: ReceptionEndpointKind,
  config: Record<string, unknown>,
  event: FieldDelegateEvent,
): void => {
  // Repeater cell — `data-repeater-key` + `data-row-index` + `data-row-field`.
  if (
    event.repeaterKey !== null &&
    event.rowIndex !== null &&
    event.rowField !== null
  ) {
    const arr = getPath(config, event.repeaterKey);
    if (!Array.isArray(arr)) return;
    if (event.rowIndex < 0 || event.rowIndex >= arr.length) return;
    const row = arr[event.rowIndex];
    // String-row repeaters (the email-domain allowlists, the approval-link
    // counterparty aliases / private notes) — the renderer emits the cell
    // with `rowField: 'value'`, but the array element IS the string;
    // replace it in place.
    if (typeof row === 'string') {
      arr[event.rowIndex] = coerceCellValue(event, row);
      return;
    }
    if (row === null || typeof row !== 'object') return;
    const target = row as Record<string, unknown>;
    target[event.rowField] = coerceCellValue(event, target[event.rowField]);
    return;
  }
  if (event.fieldKey === null) return;
  // Multiselect — a checkbox per option carrying `data-option-value`.
  if (event.control === 'multiselect' && event.optionValue !== null) {
    const path = resolveConfigPath(kind, event.fieldKey);
    const current = getPath(config, path);
    const list = Array.isArray(current) ? [...current] : [];
    // Element type comes from the key — NOT the array contents — so a
    // re-check after the multiselect was emptied still pushes a number
    // for `duration_options_minutes`.
    const numeric = NUMERIC_MULTISELECT_KEYS.has(event.fieldKey);
    if (event.checked) {
      if (!list.some((entry) => String(entry) === event.optionValue)) {
        list.push(numeric ? Number(event.optionValue) : event.optionValue);
      }
    } else {
      const next = list.filter((entry) => String(entry) !== event.optionValue);
      list.length = 0;
      list.push(...next);
    }
    setPath(config, path, list);
    return;
  }
  // Top-level scalar field — text / number / toggle / select. Routes
  // through `putConfigField` so a cleared optional text field is omitted
  // (not written as `''`, which some validators reject).
  putConfigField(kind, config, event.fieldKey, event.control, coerceScalarValue(event));
};

// ════════════════════════════════════════════════════════════════
// mountAuthoringForm
// ════════════════════════════════════════════════════════════════

/** Options for `mountAuthoringForm`. */
export interface AuthoringFormMountOptions {
  /** Host element the form is rendered into — replaced on every
   *  structural re-render, cleared on `dispose()`. */
  host: HTMLElement;
  /** The page shell — `mountAuthoringForm` fires the `reception.*` rpc
   *  through it (`upsertReceptionPage` for the singleton; `runPreview` +
   *  `createEndpoint` for the link-style kinds). */
  shell: ReceptionPageShell;
  /** Which per-kind authoring form to mount. */
  kind: ReceptionEndpointKind;
  /** The config blob being edited, or `null` / omitted for a fresh
   *  create. Drives the "Set up" / "New" vs "Edit {singular}" heading.
   *  Accepts either a typed contract config or a plain working object. */
  initialConfig?: object | null;
  /** Packet declaration for the link-style kinds' `preview_draft` /
   *  `create` dispatch — the D-145 packet declaration is substrate
   *  separate from the config blob. `reception_page` ignores it (its
   *  `page.upsert` carries no packet declaration + no preview-hash gate).
   *  Absent for a link kind without `buildPacketDeclaration` ⇒ the
   *  preview / submit actions are inert (the host owns the packet-
   *  declaration wiring). */
  packetDeclaration?: PacketDeclaration;
  /** Lazy packet-declaration factory — called at preview / submit time
   *  with the CURRENT working config. Takes precedence over the static
   *  `packetDeclaration` when both are supplied. The host plumbs this
   *  through for the kinds whose `source_query_ref` carries a user-typed
   *  id (intake_form's `form_definition.form_definition_id`) — the
   *  static option captures the id only at mount time, so a fresh-seed
   *  intake form would otherwise mount with `null` packet declaration
   *  and submit becomes inert once the user types the id. The factory
   *  re-derives on every preview / submit so the typed id flows in. */
  buildPacketDeclaration?: (config: object) => PacketDeclaration | null;
  /** Bounded forward Unix-ms expiry for the link-style `create`
   *  dispatch. Takes precedence over the built-in `expiry_days`
   *  derivation. Omitted / `null` for kinds without `expiry_days` and
   *  no `expiresAt` override ⇒ long-lived. */
  expiresAt?: number | null;
  /** Clock seam for the built-in `expiry_days → expires_at` derivation
   *  on the hard-ceiling kinds (drop_link / approval_link / status_link).
   *  Defaults to `Date.now`. Only consulted when `expiresAt` is absent
   *  and the working config carries `expiry_days`. */
  now?: () => number;
  /** Called after a successful create / upsert, and on cancel — the
   *  host unmounts the form + the page-render mount (subscribed to the
   *  same shell) shows the refreshed list.
   *
   *  A link-style **create** passes its `ReceptionEndpointCreateResult`
   *  — the result carries the one-shot `share_url_once`, which the
   *  substrate never re-surfaces (the page shell does NOT auto-cache it;
   *  see its `setEndpointShare` DD). The host must register it via
   *  `shell.setEndpointShare` to drive the § A.20.4 Share Cards. A
   *  `reception_page` upsert (the tokenless singleton — no share URL)
   *  and cancel pass no result. */
  onClose?: (result?: ReceptionEndpointCreateResult) => void;
}

// ════════════════════════════════════════════════════════════════
// Hard-ceiling expiry derivation
// ════════════════════════════════════════════════════════════════

/** One day in milliseconds. Same value `buildLaunchWizardPlan` uses to
 *  derive `expires_at = now + expiry_days * DAY_MS` for the drop_link
 *  draft (`reception-visitor-ux.ts` § A.20.1). */
const AUTHORING_DAY_MS = 24 * 60 * 60 * 1000;

/** The three kinds the substrate rejects long-lived for — each carries
 *  an `expiry_days` field on its config (validator-clamped to its
 *  per-kind ceiling: drop_link [1,30], approval_link [1,30],
 *  status_link [1,90]). The mount derives `expires_at = now +
 *  expiry_days * DAY_MS` for these whenever the caller did not pass an
 *  explicit `expiresAt` override. */
const AUTHORING_HARD_CEILING_KINDS = new Set<ReceptionEndpointKind>([
  'drop_link',
  'approval_link',
  'status_link',
]);

/** Built-in `expiry_days → expires_at` derivation for the three hard-
 *  ceiling kinds. Returns `null` when the kind has no `expiry_days` /
 *  the field is missing or non-numeric; the caller's explicit
 *  `expiresAt` always wins over this. Pure — `now` is the clock seam. */
const deriveDefaultExpiresAt = (
  kind: ReceptionEndpointKind,
  config: Record<string, unknown>,
  now: number,
): number | null => {
  if (!AUTHORING_HARD_CEILING_KINDS.has(kind)) return null;
  const days = config.expiry_days;
  if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) return null;
  return now + days * AUTHORING_DAY_MS;
};

/** Mounted authoring-form handle. */
export interface AuthoringFormMount {
  /** Re-render from the current working config. */
  update(): void;
  /** Detach both dispatchers + clear the host. Idempotent. */
  dispose(): void;
}

/** Mount a per-kind Reception authoring form into a host element. Seeds
 *  a working config, wires the renderer's `data-*` markup, and drives
 *  the `reception.*` rpc through the shell:
 *    - **field edits** mutate the working config silently (no re-render);
 *    - **repeater add / remove** mutate + re-render (structural change);
 *    - **preview** fires `reception.endpoint.preview_draft` (link kinds —
 *      never validation-gated; previewing a partial draft is the trust
 *      check);
 *    - **submit** validates, then either `reception.page.upsert` (the
 *      singleton) or `preview_draft → create` gated on the returned
 *      `preview_hash` (§ A.3); an invalid submit re-renders the error
 *      panel + disabled submit;
 *    - **cancel** calls `onClose`.
 *
 *  Shell action methods reject on rpc failure AND capture the failure
 *  into the shell's `last_error` (the page-render mount surfaces it) —
 *  the handlers `.catch()` the rejection so it never escapes. */
export const mountAuthoringForm = (
  opts: AuthoringFormMountOptions,
): AuthoringFormMount => {
  const { host, shell, kind } = opts;
  const isNew = opts.initialConfig === undefined || opts.initialConfig === null;
  const workingConfig = seedWorkingConfig(kind, opts.initialConfig ?? null);
  let validation: AuthoringValidationSummary<string> | null = null;
  let disposed = false;
  let lastHtml = '';
  // I-20 a11y — every re-render rebuilds `innerHTML` and drops focus. A
  // repeater add / remove sets a target so focus lands on the new row's
  // first control (add) or the repeater's Add button (remove) after the
  // render, instead of jumping to the top of the document. Guarded so the
  // DOM-free fake-host tests (no `querySelector`) simply skip it.
  let pendingFocus: (() => void) | null = null;

  const focusRepeaterRow = (repeaterKey: string, rowIndex: number): void => {
    if (typeof host.querySelector !== 'function') return;
    const row = host.querySelector(
      `.reception-form-repeater-row[data-repeater-key="${repeaterKey}"][data-row-index="${rowIndex}"]`,
    );
    const ctl = (row?.querySelector?.('input, select, textarea') ?? null) as
      | { focus?: () => void }
      | null;
    ctl?.focus?.();
  };
  const focusRepeaterAddButton = (repeaterKey: string): void => {
    if (typeof host.querySelector !== 'function') return;
    const btn = host.querySelector(
      `[data-action="reception-form-add-row"][data-repeater-key="${repeaterKey}"]`,
    ) as { focus?: () => void } | null;
    btn?.focus?.();
  };

  const render = (): void => {
    if (disposed) return;
    const html = renderAuthoringForm(
      buildAuthoringView(kind, workingConfig, validation, isNew),
    );
    if (html !== lastHtml) {
      host.innerHTML = html;
      lastHtml = html;
    }
    if (pendingFocus) {
      const apply = pendingFocus;
      pendingFocus = null;
      apply();
    }
  };

  const swallow = (promise: Promise<unknown>): void => {
    void promise.catch(() => {});
  };

  // Field edits mutate silently — the DOM input already shows the typed
  // value. Two edits must re-render: the first edit after a failed submit
  // clears the stale validation summary, and intake target-kind changes
  // alter which processing controls exist. Every webclient re-render rebuilds
  // `innerHTML` + loses focus, so keep the exception list explicit.
  const onFieldEdit = (event: FieldDelegateEvent): void => {
    applyFieldDelegateEvent(kind, workingConfig, event);
    const changesVisibleControls =
      kind === 'intake_form'
      && (event.fieldKey === 'submission_processing_rule.target_kind'
        // D-210 WS3 — the destination mapping controls appear/disappear with the
        // target, and the end-spec control swaps with the mode.
        || event.fieldKey === INTAKE_FORM_CALENDAR_END_MODE_KEY);
    if (validation !== null || changesVisibleControls) {
      validation = null;
      render();
    }
  };

  /** Resolve the effective packet declaration. The lazy
   *  `buildPacketDeclaration` factory takes precedence (it sees the
   *  current working config, so a user-typed id like
   *  `form_definition_id` flows in even on a fresh-seed mount); falls
   *  back to the static `packetDeclaration`. Returns null when neither
   *  resolves a declaration — the caller must short-circuit (preview /
   *  submit becomes inert). */
  const resolvePacketDeclaration = (): PacketDeclaration | null => {
    if (opts.buildPacketDeclaration !== undefined) {
      return opts.buildPacketDeclaration(workingConfig);
    }
    return opts.packetDeclaration ?? null;
  };

  const now = opts.now ?? ((): number => Date.now());

  /** Resolve the effective `expires_at` for the dispatch. The caller's
   *  explicit `expiresAt` wins (allows opt-in long-lived); otherwise
   *  the mount derives `expires_at = now + expiry_days * DAY_MS` for
   *  the hard-ceiling kinds, leaving the long-lived-permitted kinds
   *  (scheduling_link / intake_form) with no expiry on the wire.
   *  Returns `undefined` when no expiry should be carried at all. */
  const resolveExpiresAt = (): number | undefined => {
    if (typeof opts.expiresAt === 'number') return opts.expiresAt;
    if (opts.expiresAt === null) return undefined; // explicit long-lived
    const derived = deriveDefaultExpiresAt(kind, workingConfig, now());
    return derived !== null ? derived : undefined;
  };

  /** Link-style preview-then-create — `reception.endpoint.preview_draft`
   *  then `reception.endpoint.create` gated on the returned
   *  `preview_hash` (§ A.3). Inert without a resolvable packet declaration. */
  const runCreateFlow = (): void => {
    const packet = resolvePacketDeclaration();
    if (packet === null) return;
    const expiresAt = resolveExpiresAt();
    const preview = buildEndpointPreviewDispatch({
      kind,
      packet_declaration: packet,
      metadata: workingConfig,
      ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
    });
    swallow(
      shell.runPreview(preview).then((result) =>
        shell
          .createEndpoint(
            buildEndpointCreateDispatch({
              kind,
              packet_declaration: packet,
              metadata: workingConfig,
              preview_hash: result.preview_hash,
              ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
            }),
          )
          .then((createResult) => {
            // Hand the create result back — `createResult.share_url_once`
            // is one-shot, and the page shell does not auto-cache it.
            opts.onClose?.(createResult);
          }),
      ),
    );
  };

  const handlers = {
    'reception-form-add-row': (dataset: DOMStringMap) => {
      if (dataset.repeaterKey === undefined) return;
      const key = dataset.repeaterKey;
      addRepeaterRow(workingConfig, key);
      const rows = getPath(workingConfig, key);
      const newIndex = Array.isArray(rows) ? rows.length - 1 : 0;
      pendingFocus = () => focusRepeaterRow(key, newIndex);
      render();
    },
    'reception-form-remove-row': (dataset: DOMStringMap) => {
      if (dataset.repeaterKey === undefined || dataset.rowIndex === undefined) return;
      const key = dataset.repeaterKey;
      removeRepeaterRow(workingConfig, key, Number(dataset.rowIndex));
      // The removed row's controls are gone — land focus on the repeater's
      // Add button so keyboard users keep a stable position.
      pendingFocus = () => focusRepeaterAddButton(key);
      render();
    },
    'reception-form-preview': () => {
      // The `reception_page` singleton has no preview path — its
      // `page.upsert` is a plain config write, no preview-hash gate.
      if (kind === 'reception_page') return;
      const packet = resolvePacketDeclaration();
      if (packet === null) return;
      const expiresAt = resolveExpiresAt();
      swallow(
        shell.runPreview(
          buildEndpointPreviewDispatch({
            kind,
            packet_declaration: packet,
            metadata: workingConfig,
            ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
          }),
        ),
      );
    },
    'reception-form-submit': () => {
      validation = validateConfigForKind(kind, workingConfig);
      if (!validation.valid) {
        render();
        return;
      }
      if (kind === 'reception_page') {
        swallow(
          shell
            .upsertReceptionPage(
              buildReceptionPageUpsertDispatch(
                workingConfig as unknown as ReceptionPageConfig,
              ),
            )
            .then(() => {
              opts.onClose?.();
            }),
        );
        return;
      }
      runCreateFlow();
    },
    'reception-form-cancel': () => {
      opts.onClose?.();
    },
  } satisfies Record<AuthoringFormAction, (dataset: DOMStringMap) => void>;

  const detachActions = createActionDispatcher<AuthoringFormAction>({
    root: host,
    handlers,
  });
  const detachFields = attachFieldDelegator(host, onFieldEdit);
  render();

  return {
    update: render,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      detachActions();
      detachFields();
      host.innerHTML = '';
    },
  };
};
