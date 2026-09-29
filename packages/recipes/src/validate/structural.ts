/** Phase 1: Structural validation.
 *
 *  Shape + reference + transform-schema checks. Anything the recipe
 *  must satisfy to be parseable and wirable to the engine. Runs FIRST;
 *  phase 2 (quality) and phase 3 (contracts) assume these checks have
 *  already flagged gross malformations.
 *
 *  Each validator is a free function taking the recipe object + an
 *  `AddFn` accumulator. No shared state across validators; call order
 *  is decided by `validate.ts` orchestrator.
 */

import type { OutputType, TableColumnControl } from '@recued/contracts';
import {
  TABLE_COLUMN_CONTROLS,
  AUTO_RUN_SERVER_FLOOR_MS,
  WAIT_TRANSFORM_MAX_MS,
  ACCT_ALIAS_VALUES,
  CANONICAL_CRM_VERBS,
  CRM_ALIAS_VALUES,
  ENRICHMENT_REGISTRY,
  ENRICHMENT_WRITE_PERMISSION,
  getKernelDomain,
  getKernelOp,
  isCanonicalOpStep,
  isConnectionReadPermission,
  isEnrichmentTopic,
  isHttpsRepoUrl,
  isPlatformReferenceScope,
  OPS,
  parseOpId,
  PAID_DOCUMENT_DIRECT_CHECKOUT_CONFIGURATION_METADATA_KEY,
  recipeEventTriggerNotes,
  resolvePaidDocumentDirectCheckoutClaimConfiguration,
  validateRecipeEventTriggerEntry,
  validateRecipeWebhookTriggers,
  validateWebhookRequirements,
  validateWebhookTriggerBindings,
  validateRecipeBundleKey,
  validateRecipeFormFields,
  collectFormValueRefs,
  collectWholeFormRecordRefs,
  spreadsheetImportProblems,
  VALUE_HINT_KEYS,
  LIST_VOCABULARIES,
  listSettingChoices,
  listVocabularyRef,
  type EnrichmentDefinition,
  type EnrichmentTopic,
  type RecipeStep,
} from '@recued/contracts';
import { TRANSFORM_SCHEMAS, applyValueParam } from '@recued/transforms';
import { connectionVariableNames } from '../connection-agnostic.js';
import { OP_STEP_CONNECTION_REF_REGEX, parseOpStepConnectionRef } from '../connection-agnostic-paths.js';
import {
  AUTHOR_PLACEHOLDERS,
  KNOWN_PLATFORMS,
  OUTPUT_TYPES,
  RESERVED_STEP_IDS,
  VALID_MODEL_HINTS,
} from './constants.js';
import {
  REF_PATTERN,
  describeType,
  matchesParamType,
  parseStepRef,
  validateConditionField,
  validateStepId,
  type AddFn,
} from './helpers.js';

/** Canonical op-step vocabulary (D-170 N.18 / slice 3; §5 tool-op pack seam).
 *  A CRM op-step's `op` is `<crm_alias-entity>.<verb>` — the entity one of
 *  `CRM_ALIAS_VALUES`, the verb one of `CANONICAL_CRM_VERBS`; a vendor-specific CRM
 *  op is NOT reachable through a canonical op-step. An op whose family is NOT a
 *  `crm_alias` is a §5 TOOL op (`web.search`) naming a pack-declared catalog
 *  operation directly — its family/verb vocabulary is open (no fixed set), checked
 *  for `<family>.<verb>` shape only; both bind per pack in the install resolver. */
const CRM_ALIAS_SET: ReadonlySet<string> = new Set<string>(CRM_ALIAS_VALUES);
const CANONICAL_VERB_SET: ReadonlySet<string> = new Set<string>(CANONICAL_CRM_VERBS);
// SMB-finance slice 5b — accounting canonical op-steps (`<acct_alias>.<verb>`) are
// READ-ONLY: a money write rides the explicit ingredient binding, not an op-step.
const ACCT_ALIAS_SET: ReadonlySet<string> = new Set<string>(ACCT_ALIAS_VALUES);
const CANONICAL_ACCT_VERBS = ['search', 'read'] as const;
const CANONICAL_ACCT_VERB_SET: ReadonlySet<string> = new Set<string>(CANONICAL_ACCT_VERBS);

/** `requires_approval` appeared in an old authoring guide but was never part of
 *  RecipeStep or carried through lowering. Reject it explicitly so a recipe cannot
 *  present an approval promise that the runtime silently ignores. */
const validateUnsupportedStepApproval = (
  step: Record<string, unknown>,
  path: string,
  add: AddFn,
): void => {
  if (!('requires_approval' in step)) return;
  add('error', 'step_requires_approval_unsupported', `${path}.requires_approval`,
    '`requires_approval` is not a live recipe-step field; approval derives from the operation risk, catalog policy, and active dispatch trust policy');
};

export const validateRequiredFields = (r: Record<string, unknown>, add: AddFn): void => {
  if (typeof r.recipe_id !== 'string' || !r.recipe_id) {
    add('error', 'recipe_id_required', 'recipe_id', 'recipe_id is required and must be a non-empty string');
  }
  if (typeof r.version !== 'number' || !Number.isInteger(r.version) || r.version < 1) {
    add('error', 'version_invalid', 'version', 'version must be a positive integer');
  }
  if (typeof r.ttl !== 'number' || !Number.isFinite(r.ttl) || r.ttl < 0) {
    add('error', 'ttl_invalid', 'ttl', 'ttl must be a non-negative finite number of seconds');
  }
  if (!r.metadata || typeof r.metadata !== 'object' || Array.isArray(r.metadata)) {
    add('error', 'metadata_required', 'metadata', 'metadata is required and must be an object');
  }
  if (r.variables !== undefined
      && (typeof r.variables !== 'object' || r.variables === null || Array.isArray(r.variables))) {
    add('error', 'variables_shape', 'variables', 'variables must be an object (empty object OK)');
  }
  if (r.prefetch_steps !== undefined && !Array.isArray(r.prefetch_steps)) {
    add('error', 'prefetch_steps_shape', 'prefetch_steps', 'prefetch_steps must be an array (empty array OK)');
  }
  if (r.steps !== undefined && !Array.isArray(r.steps)) {
    add('error', 'steps_shape', 'steps', 'steps must be an array (empty array OK)');
  }
  if (r.trigger_steps !== undefined && !Array.isArray(r.trigger_steps)) {
    add('error', 'trigger_steps_shape', 'trigger_steps',
      'trigger_steps must be an array of steps (omit the field for non-reactive recipes)');
  }
  // Guard against DoS via excessive step count
  const MAX_STEPS = 500;
  const prefetchCount = Array.isArray(r.prefetch_steps) ? r.prefetch_steps.length : 0;
  const seqCount = Array.isArray(r.steps) ? r.steps.length : 0;
  const triggerCount = Array.isArray(r.trigger_steps) ? r.trigger_steps.length : 0;
  if (prefetchCount + seqCount + triggerCount > MAX_STEPS) {
    add('error', 'recipe_too_many_steps', 'steps',
      `Recipe has ${prefetchCount + seqCount + triggerCount} steps (max ${MAX_STEPS})`);
  }
  if (!r.output || typeof r.output !== 'object' || Array.isArray(r.output)) {
    add('error', 'output_required', 'output', 'output is required and must be an object');
  }
};

export const validateRecipeId = (r: Record<string, unknown>, add: AddFn): void => {
  if (typeof r.recipe_id !== 'string' || !r.recipe_id) return;
  const id = r.recipe_id;

  if (id !== id.toLowerCase()) {
    add('error', 'recipe_id_not_lowercase', 'recipe_id', 'recipe_id must be lowercase');
  }
  if (/\s/.test(id)) {
    add('error', 'recipe_id_has_whitespace', 'recipe_id', 'recipe_id must not contain whitespace');
  }
  if (!/^[a-z0-9-]+$/.test(id)) {
    add('error', 'recipe_id_invalid_chars', 'recipe_id',
      'recipe_id may only contain [a-z0-9-] (lowercase letters, digits, hyphens)');
  }
  if (id.startsWith('-') || id.endsWith('-')) {
    add('error', 'recipe_id_edge_hyphen', 'recipe_id',
      'recipe_id must not start or end with a hyphen');
  }
};

export const validateTrigger = (r: Record<string, unknown>, add: AddFn): void => {
  if (r.trigger === undefined) return;
  if (!Array.isArray(r.trigger)) {
    add('error', 'trigger_shape', 'trigger', 'trigger must be an array of URL patterns');
    return;
  }
  if (r.trigger.length === 0) {
    add('warn', 'trigger_empty', 'trigger',
      'trigger is an empty array — either omit the field or add patterns');
  }
  for (let i = 0; i < r.trigger.length; i++) {
    const pat = r.trigger[i];
    if (typeof pat !== 'string' || !pat) {
      add('error', 'trigger_pattern_shape', `trigger[${i}]`,
        'each trigger pattern must be a non-empty string');
      continue;
    }
    validateTriggerPattern(pat, `trigger[${i}]`, add);
  }
};

/** Chrome-style match pattern validation. Supported forms:
 *    - "host.tld/path"              — implicit scheme, any path
 *    - "host.tld/path/*"            — wildcard path
 *    - "*.host.tld/path"            — wildcard subdomain
 *    - "https://host.tld/path"      — explicit scheme
 *    - "*://host.tld/path"          — wildcard scheme
 *
 *  Rejected:
 *    - Patterns with no `.` in the host (can't recognize the domain)
 *    - Schemes other than http/https/* (extension only runs on web pages)
 *    - Whitespace anywhere (authoring bug)
 *    - `*` in the middle of a host label (e.g. `app*.hubspot.com`) — only
 *      full-label wildcards are supported by Chrome's match pattern parser */
const validateTriggerPattern = (pat: string, path: string, add: AddFn): void => {
  if (/\s/.test(pat)) {
    add('error', 'trigger_pattern_whitespace', path,
      `pattern "${pat}" contains whitespace`);
    return;
  }

  // Extract scheme if present
  let rest = pat;
  const schemeMatch = pat.match(/^([a-z*]+):\/\//);
  if (schemeMatch) {
    const scheme = schemeMatch[1];
    if (scheme !== 'http' && scheme !== 'https' && scheme !== '*') {
      add('warn', 'trigger_pattern_scheme', path,
        `pattern "${pat}" uses scheme "${scheme}" — extension recipes only run on http/https/* schemes`);
    }
    rest = pat.slice(schemeMatch[0].length);
  }

  // Host ends at first slash
  const slashIdx = rest.indexOf('/');
  const host = slashIdx === -1 ? rest : rest.slice(0, slashIdx);

  if (!host) {
    add('error', 'trigger_pattern_no_host', path,
      `pattern "${pat}" has no host component`);
    return;
  }

  if (!host.includes('.')) {
    add('warn', 'trigger_pattern_no_domain', path,
      `pattern "${pat}" host "${host}" has no domain — trigger patterns should look like "example.com/path/*"`);
    return;
  }

  // Host must be wildcard-free except for a leading `*.`
  // Valid:   app.hubspot.com, *.force.com, *.lightning.force.com
  // Invalid: ap*.hubspot.com, app.*.com, app.hub*.com
  const labels = host.split('.');
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    if (label === '*') {
      if (i !== 0) {
        add('warn', 'trigger_pattern_host_wildcard', path,
          `pattern "${pat}" has "*" in host label ${i} — Chrome only supports leading "*." subdomain wildcards`);
      }
      continue;
    }
    if (label.includes('*')) {
      add('warn', 'trigger_pattern_host_wildcard', path,
        `pattern "${pat}" has partial-label wildcard in "${label}" — Chrome only supports full-label "*" wildcards`);
    }
    if (!label) {
      add('error', 'trigger_pattern_empty_label', path,
        `pattern "${pat}" has an empty host label (consecutive dots?)`);
    }
  }
};

export const validateMetadata = (r: Record<string, unknown>, add: AddFn): void => {
  if (!r.metadata || typeof r.metadata !== 'object' || Array.isArray(r.metadata)) return;
  const meta = r.metadata as Record<string, unknown>;

  if (typeof meta.name !== 'string' || !meta.name) {
    add('error', 'name_required', 'metadata.name', 'metadata.name is required');
  }
  if (typeof meta.description !== 'string' || !meta.description) {
    add('error', 'description_required', 'metadata.description', 'metadata.description is required');
  } else if (meta.description.length < 20) {
    add('info', 'description_thin', 'metadata.description',
      `description is only ${meta.description.length} chars — add detail for marketplace listing`);
  }

  if (typeof meta.author !== 'string' || !meta.author) {
    add('error', 'author_required', 'metadata.author', 'metadata.author is required');
  } else if (AUTHOR_PLACEHOLDERS.has(meta.author.trim().toLowerCase())) {
    add('warn', 'author_placeholder', 'metadata.author',
      `author is a placeholder value '${meta.author}' — use a real publisher id`);
  }

  if (meta.supported_platforms === undefined) {
    add('error', 'platforms_required', 'metadata.supported_platforms',
      'supported_platforms is required (use an empty array if none)');
  } else if (!Array.isArray(meta.supported_platforms)
             || !meta.supported_platforms.every((p) => typeof p === 'string')) {
    add('error', 'platforms_shape', 'metadata.supported_platforms',
      'supported_platforms must be an array of strings');
  }

  for (const issue of validateRecipeBundleKey(meta.recipe_bundle)) {
    add('error', issue.code, issue.field, issue.message);
  }

  // D-200 — this deployment block is optional and does not gate ordinary
  // recipes merely by being absent. Once an author supplies the recognized
  // typed field, however, the standard parser must uphold RecipeMetadata's
  // closed shape instead of returning an unsound RecipeDefinition that only a
  // later role-specific caller happens to reject.
  if (Object.prototype.hasOwnProperty.call(
    meta,
    PAID_DOCUMENT_DIRECT_CHECKOUT_CONFIGURATION_METADATA_KEY,
  ) && resolvePaidDocumentDirectCheckoutClaimConfiguration(r).kind !== 'configured') {
    add(
      'error',
      'paid_document_direct_checkout_invalid',
      `metadata.${PAID_DOCUMENT_DIRECT_CHECKOUT_CONFIGURATION_METADATA_KEY}`,
      'paid_document_direct_checkout must be the closed v1 deployment block or '
        + 'closed v2 block with one syntactically valid local Seller offer association',
    );
  }

  // Tags
  if (meta.tags === undefined) {
    add('warn', 'tags_missing', 'metadata.tags',
      'tags not set — add for marketplace discovery (domain + function + entity)');
  } else if (!Array.isArray(meta.tags) || !meta.tags.every((t) => typeof t === 'string')) {
    add('error', 'tags_shape', 'metadata.tags', 'tags must be an array of strings');
  } else if (meta.tags.length < 3) {
    add('info', 'tags_thin', 'metadata.tags',
      `only ${meta.tags.length} tag(s) — recommend 3+ covering domain + function + entity`);
  }

  // variant_group: platform-specific recipe_id without one is a hint
  if (meta.variant_group === undefined && typeof r.recipe_id === 'string') {
    const parts = r.recipe_id.split('-');
    const lastPart = parts[parts.length - 1];
    if (parts.length > 1 && KNOWN_PLATFORMS.has(lastPart)) {
      add('info', 'variant_group_missing', 'metadata.variant_group',
        `recipe_id "${r.recipe_id}" looks platform-specific but variant_group is not set — add it so cross-platform variants can group`);
    }
  }

  // repo — optional; when present must be an https URL (author's
  // source repo, where issues/support route — entered at publish time).
  if (meta.repo !== undefined && !isHttpsRepoUrl(meta.repo)) {
    add('error', 'repo_invalid', 'metadata.repo',
      'metadata.repo must be an https URL when present');
  }

  // fork_of shape check
  if (meta.fork_of !== undefined) {
    const fo = meta.fork_of;
    if (!fo || typeof fo !== 'object' || Array.isArray(fo)) {
      add('error', 'fork_of_shape', 'metadata.fork_of',
        'fork_of must be an object with {recipe_id, author, version}');
    } else {
      const f = fo as Record<string, unknown>;
      if (typeof f.recipe_id !== 'string' || !f.recipe_id) {
        add('error', 'fork_of_recipe_id', 'metadata.fork_of.recipe_id', 'fork_of.recipe_id is required');
      }
      if (typeof f.author !== 'string' || !f.author) {
        add('error', 'fork_of_author', 'metadata.fork_of.author', 'fork_of.author is required');
      }
      if (typeof f.version !== 'number' || !Number.isInteger(f.version) || f.version < 1) {
        add('error', 'fork_of_version', 'metadata.fork_of.version', 'fork_of.version must be a positive integer');
      }
    }
  }
};

/** D-115 — `auto_run` field shape check. Pure structural; the
 *  scheduler's clamp + dynamic-mode behaviour is enforced at runtime,
 *  not here. */
export const validateAutoRun = (r: Record<string, unknown>, add: AddFn): void => {
  if (r.auto_run === undefined) return;
  if (!r.auto_run || typeof r.auto_run !== 'object' || Array.isArray(r.auto_run)) {
    add('error', 'auto_run_shape', 'auto_run',
      'auto_run must be an object with at least { interval_ms }');
    return;
  }
  const a = r.auto_run as Record<string, unknown>;

  if (typeof a.interval_ms !== 'number' || !Number.isFinite(a.interval_ms) || a.interval_ms <= 0) {
    add('error', 'auto_run_interval_invalid', 'auto_run.interval_ms',
      'auto_run.interval_ms must be a positive finite number of milliseconds');
  } else if (a.interval_ms < AUTO_RUN_SERVER_FLOOR_MS) {
    // Sub-floor is allowed — server clamps to AUTO_RUN_SERVER_FLOOR_MS,
    // extension clamps to AUTO_RUN_EXTENSION_FLOOR_MS — but warn the
    // author so they don't expect sub-floor cadence.
    add('warn', 'auto_run_interval_below_floor', 'auto_run.interval_ms',
      `auto_run.interval_ms is below the server floor (${AUTO_RUN_SERVER_FLOOR_MS}ms) — runtime will clamp upward`);
  }

  if ('dynamic' in a && a.dynamic !== undefined && typeof a.dynamic !== 'boolean') {
    add('error', 'auto_run_dynamic_shape', 'auto_run.dynamic',
      'auto_run.dynamic must be a boolean (omit for static interval)');
  }
  if ('default_enabled' in a
    && a.default_enabled !== undefined
    && typeof a.default_enabled !== 'boolean') {
    add('error', 'auto_run_default_enabled_shape', 'auto_run.default_enabled',
      'auto_run.default_enabled must be a boolean (omit for compatibility default true)');
  }
};

/** Reactive authoring sugar — `event_triggers` entry validation.
 *
 *  Each entry is either RAW (`event` bus pattern + optional `filter`)
 *  or SUGAR (`on` canonical form + optional `connection` / `fields` /
 *  `where`) — exactly one of the two. The grammar lives in ONE place
 *  (`validateRecipeEventTriggerEntry`, @recued/contracts) shared with
 *  the server's declarative reconciler, so publish-time validity and
 *  materialization-time compilability never drift. Registry coverage
 *  (which vendors an alias fans to) is deliberately NOT checked here —
 *  it is live server state, not a validity question.
 *
 *    - `event_triggers_shape` — field present but not an array.
 *    - `event_trigger_entry_invalid` — one issue per entry problem.
 *    - `event_trigger_mail_fact_unknown` (warn) — D-315: a mail-fact trigger
 *      watches something no built-in kind of email has. A kind the owner
 *      makes may have it, so it is not refused; it starts for no one else. */
export const validateEventTriggers = (r: Record<string, unknown>, add: AddFn): void => {
  if (r.event_triggers === undefined) return;
  if (!Array.isArray(r.event_triggers)) {
    add('error', 'event_triggers_shape', 'event_triggers',
      'event_triggers must be an array of subscription entries');
    return;
  }
  for (let i = 0; i < r.event_triggers.length; i++) {
    for (const problem of validateRecipeEventTriggerEntry(r.event_triggers[i])) {
      add('error', 'event_trigger_entry_invalid', `event_triggers[${i}]`, problem);
    }
    for (const note of recipeEventTriggerNotes(r.event_triggers[i])) {
      add('warn', 'event_trigger_mail_fact_unknown', `event_triggers[${i}]`, note);
    }
  }
};

/** D-201 Slice 0 — owner-local webhook requirements and strict binding-aware
 * triggers.  A pack-owned recipe may omit `webhook_requirements` because its
 * owning BulkPackManifest supplies them; that cross-artifact check runs after
 * the pack's recipe refs resolve.  When a recipe does carry local requirements,
 * every trigger is checked against them immediately. */
export const validateWebhookDeclarations = (r: Record<string, unknown>, add: AddFn): void => {
  if (r.webhook_requirements !== undefined) {
    for (const problem of validateWebhookRequirements(r.webhook_requirements)) {
      add(
        'error',
        problem.code === 'shape' ? 'webhook_requirements_shape' : 'webhook_requirement_invalid',
        problem.path,
        problem.message,
      );
    }
  }

  if (r.webhook_triggers !== undefined) {
    for (const problem of validateRecipeWebhookTriggers(r.webhook_triggers)) {
      add(
        'error',
        problem.code === 'shape' ? 'webhook_triggers_shape' : 'webhook_trigger_entry_invalid',
        problem.path,
        problem.message,
      );
    }
  }

  // A trigger without recipe-local requirements is meaningful only when the
  // recipe names its owning pack; that pack becomes the declaration authority
  // once refs resolve.  Otherwise an independently installed/local recipe would
  // pass shape validation with a binding nobody can ever satisfy.
  if (Array.isArray(r.webhook_triggers)
    && r.webhook_triggers.length > 0
    && r.webhook_requirements === undefined) {
    const metadata = r.metadata != null && typeof r.metadata === 'object' && !Array.isArray(r.metadata)
      ? r.metadata as Record<string, unknown>
      : null;
    if (metadata === null || typeof metadata.recipe_bundle !== 'string' || metadata.recipe_bundle.length === 0) {
      add(
        'error',
        'webhook_requirements_required',
        'webhook_requirements',
        'webhook_triggers require recipe-local webhook_requirements or metadata.recipe_bundle naming the owning pack',
      );
    }
  }

  if (Array.isArray(r.webhook_requirements) && Array.isArray(r.webhook_triggers)) {
    for (const problem of validateWebhookTriggerBindings(
      r.webhook_requirements,
      r.webhook_triggers,
    )) {
      add(
        'error',
        problem.code === 'trigger_binding_unknown'
          ? 'webhook_trigger_binding_unknown'
          : 'webhook_trigger_event_undeclared',
        problem.path,
        problem.message,
      );
    }
  }
};

/** D-120 Phase 3 — `provenance` field shape. The field gates engine-
 *  emitted `links` rows; default-on, explicit `false` opts out for
 *  the entire recipe. Anything other than a boolean is a validator
 *  error so authors can't accidentally `null` / stringify the field
 *  and silently fall through to the default.
 *
 *    - `provenance_shape` — value present but not a boolean. */
/** D-122 Phase 4.5 — `enrichment-upsert` step value-shape sweep.
 *
 *  Best-effort static check: when a recipe step calls
 *  `ingredient: 'enrichment-upsert'` with a literal `value` object
 *  (no top-level `{{ref}}` interpolation), validate it against the
 *  topic's `value_schema`. Soft-warn on mismatch — the runtime check
 *  inside the store is authoritative; this surface gives recipe
 *  authors a fast feedback loop at parse time.
 *
 *  We can't validate values that come from `{{step.X}}` references —
 *  their shape isn't known until runtime. Skip those silently.
 *
 *  D-128 Phase 6 — also gates the `write_enrichment` staged-trust
 *  permission. Every recipe with at least one `enrichment-upsert` step
 *  must declare `requires: ['write_enrichment']` so the install dialog
 *  can surface the permission for user approval. Hard error so authors
 *  notice immediately. The check fires once per recipe regardless of
 *  how many enrichment-upsert steps appear.
 *
 *  D-128 P6 also surfaces a hint when an enrichment-upsert step writes
 *  to a literal platform-reference scope (`connection.api.<vendor>.<entity>`)
 *  without a corresponding `read_connection_<connection_name>` declared
 *  in `requires`. The validator can't know the connection_name (only
 *  the vendor segment is visible at parse time); the hint nudges
 *  authors toward the convention without hard-failing the validate.
 *  Reads route through the same hint (see `validateReferences`). */
export const validateEnrichmentSteps = (r: Record<string, unknown>, add: AddFn): void => {
  const requires = Array.isArray(r.requires)
    ? new Set(r.requires.filter((p): p is string => typeof p === 'string'))
    : new Set<string>();
  let firstWriteSampleStep = '';
  // Track platform-reference scopes touched by writes — surfaces in the
  // `read_connection_*` hint below so the message points at the actual
  // vendors the recipe needs the permission for.
  const platformScopesWritten = new Set<string>();

  const visit = (steps: unknown, basePath: string): void => {
    if (!Array.isArray(steps)) return;
    steps.forEach((step, idx) => {
      if (!step || typeof step !== 'object' || Array.isArray(step)) return;
      const s = step as Record<string, unknown>;
      if (s.ingredient !== 'enrichment-upsert') return;
      // First write sighting drives the per-recipe permission error.
      if (firstWriteSampleStep === '') {
        firstWriteSampleStep = `${basePath}[${idx}]`;
      }
      // Track a literal `scope` field — when it's a platform-reference
      // scope the read_connection hint widens to mention the vendor.
      // Templated scopes (`{{config.scope}}`) are skipped.
      const scope = s.scope;
      if (typeof scope === 'string' && isPlatformReferenceScope(scope)) {
        platformScopesWritten.add(scope);
      }
      const topic = s.topic;
      if (typeof topic !== 'string') return;
      if (!isEnrichmentTopic(topic)) {
        add(
          'error',
          'enrichment_topic_unknown',
          `${basePath}[${idx}].topic`,
          `enrichment-upsert step references unknown topic '${topic}' — not registered in ENRICHMENT_REGISTRY`,
        );
        return;
      }
      const def = ENRICHMENT_REGISTRY[topic as EnrichmentTopic] as EnrichmentDefinition;
      // Static value validation — only when the literal payload doesn't
      // include `{{...}}` markers (those resolve at runtime).
      const value = s.value;
      const looksLiteral = !containsTemplate(value);
      if (looksLiteral) {
        const result = def.value_schema(value);
        if (!result.ok) {
          add(
            'warn',
            'enrichment_value_schema_mismatch',
            `${basePath}[${idx}].value`,
            `enrichment-upsert value for topic '${topic}' fails the registry validator — ${result.issues.join('; ')}`,
          );
        }
      }
    });
  };
  visit(r.prefetch_steps, 'prefetch_steps');
  visit(r.steps, 'steps');
  visit(r.trigger_steps, 'trigger_steps');

  // D-128 P6 — `write_enrichment` permission gate. Hard error mirroring
  // the `read_memory` gate's shape.
  if (firstWriteSampleStep !== '' && !requires.has(ENRICHMENT_WRITE_PERMISSION)) {
    add(
      'error',
      'enrichment_write_permission_missing',
      'requires',
      `recipe writes to data.enrichment via 'enrichment-upsert' (first sighting at ${firstWriteSampleStep}) ` +
        `but does not declare \`requires: ["${ENRICHMENT_WRITE_PERMISSION}"]\` — add the permission so the install dialog can surface it for approval`,
    );
  }

  // D-128 P6 — `read_connection_<connection_name>` hint. Soft-warn so
  // recipes get the nudge without failing validation; the runtime
  // resolver is the authoritative gate (returns undefined when the
  // permission isn't declared at install time). The vendor list in the
  // message helps authors fill in the right connection_name when the
  // user picks an enrolled connection at install.
  hasAnyConnectionReadPermission(requires)
    ? null
    : platformScopesWritten.size > 0 && add(
        'warn',
        'read_connection_permission_missing',
        'requires',
        `recipe writes to platform-reference scope${platformScopesWritten.size > 1 ? 's' : ''} ` +
          `${[...platformScopesWritten].sort().map((s) => `'${s}'`).join(', ')} — declare ` +
          `\`requires: ["read_connection_<connection_name>"]\` (substitute the user's enrolled ` +
          `connection name at install) so the resolver can gate the cross-vendor read path`,
      );
};

/** D-128 P6 — predicate: does the requires set contain any
 *  `read_connection_<connection_name>` slug. Used by both the
 *  enrichment-upsert step gate above and the reference-walker hint
 *  in `validateReferences`. */
export const hasAnyConnectionReadPermission = (requires: ReadonlySet<string>): boolean => {
  for (const slug of requires) {
    if (isConnectionReadPermission(slug)) return true;
  }
  return false;
};

/** Recursively probe a value for `{{…}}` placeholders. Used by the
 *  enrichment static-value check to skip ref-bearing payloads (their
 *  resolved shape isn't available at validate time). */
const containsTemplate = (value: unknown): boolean => {
  if (typeof value === 'string') return /\{\{/.test(value);
  if (Array.isArray(value)) return value.some(containsTemplate);
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(containsTemplate);
  }
  return false;
};

export const validateProvenance = (r: Record<string, unknown>, add: AddFn): void => {
  if (r.provenance === undefined) return;
  if (typeof r.provenance !== 'boolean') {
    add('error', 'provenance_shape', 'provenance',
      'provenance must be a boolean — omit the field for default-on emission, set false to opt out');
  }
};

/** D-137 § A.1.1 (amended 2026-07-02, source-dependent default) —
 *  `chat_exposed` field shape. Explicit `true` surfaces the recipe in
 *  the chat agent's Tier 2 catalog; explicit `false` keeps it runnable
 *  via `recipe.run` / URL trigger / scheduler without polluting the
 *  chat catalog. An ABSENT flag falls to the source-dependent default:
 *  EXPOSED for user-authored recipes, HIDDEN for pack-bundled /
 *  distributed content (`isRecipeChatExposed`). Anything other than a
 *  boolean is a validator error so authors can't accidentally `null` /
 *  stringify the field and silently fall through to a default.
 *
 *    - `chat_exposed_shape` — value present but not a boolean. */
export const validateChatExposed = (r: Record<string, unknown>, add: AddFn): void => {
  if (r.chat_exposed === undefined) return;
  if (typeof r.chat_exposed !== 'boolean') {
    add('error', 'chat_exposed_shape', 'chat_exposed',
      'chat_exposed must be a boolean — set true to surface in the chat catalog, false to opt out; '
      + 'an omitted field defaults exposed only for user-authored recipes (pack/bundled content defaults hidden)');
  }
};

/** D-120 Phase 7.5 — `run_mode` declarative override. Authors set
 *  `'backfill'` on cursor-loop recipes that walk historical data so
 *  the engine stamps `audit_log.run_mode` accordingly. Default when
 *  absent: engine infers `'manual'` for chat / Run-Now / UI triggers,
 *  `'live'` for cron / reactive / auto_run.
 *
 *    - `run_mode_shape` — value present but not one of the three
 *                         known modes. */
const KNOWN_RUN_MODES = new Set(['live', 'backfill', 'manual']);

export const validateRunMode = (r: Record<string, unknown>, add: AddFn): void => {
  if (r.run_mode === undefined) return;
  if (typeof r.run_mode !== 'string' || !KNOWN_RUN_MODES.has(r.run_mode)) {
    add('error', 'run_mode_shape', 'run_mode',
      'run_mode must be one of "live" | "backfill" | "manual" — omit the field to let the engine infer from the trigger');
  }
};

/** D-120 Phase 4 — `requires` (staged-trust permission requests)
 *  shape. Optional field; when present it must be a string array.
 *  Permission-specific cross-checks (e.g. `read_memory` declared but
 *  never used vs `data.memory.*` referenced without `read_memory`) live
 *  in `validateReferences` since they need the recipe-wide ref walk.
 *
 *    - `requires_shape`        — value present but not an array.
 *    - `requires_entry_shape`  — array element is not a non-empty string.
 *    - `requires_unknown`      — declared permission is not in the
 *                                known set. Soft warn (forward-compat
 *                                so future permissions ride on the same
 *                                field without breaking older clients). */
const KNOWN_PERMISSIONS = new Set([
  // D-120 Phase 4 ships `read_memory`. D-128 Phase 6 adds
  // `write_enrichment` — gates recipes that author rows into the
  // enrichment substrate via `enrichment-upsert` (mail / contact /
  // calendar / file scopes plus the platform-reference family).
  // Future permissions append here as they land in the staged-trust
  // catalogue.
  //
  // The open `read_connection_<connection_name>` family (D-128 P6) is
  // matched separately by `isConnectionReadPermission` since the
  // connection_name segment is user-typed and unbounded — listing every
  // possible value isn't feasible.
  'read_memory',
  ENRICHMENT_WRITE_PERMISSION,
]);

/** D-128 P6 — true when a permission slug is recognised by the
 *  validator. Membership in `KNOWN_PERMISSIONS` covers the closed list;
 *  the `read_connection_*` family is matched by prefix via
 *  `isConnectionReadPermission`. Centralising the check here keeps the
 *  whitelist discoverable + lets future open-prefix families (e.g. a
 *  `vault_*` slug post-launch) plug in by adding a single condition. */
const isKnownPermission = (slug: string): boolean =>
  KNOWN_PERMISSIONS.has(slug) || isConnectionReadPermission(slug);

export const validateRequires = (r: Record<string, unknown>, add: AddFn): void => {
  if (r.requires === undefined) return;
  if (!Array.isArray(r.requires)) {
    add('error', 'requires_shape', 'requires',
      'requires must be an array of permission slugs (strings) — omit the field when the recipe needs no staged-trust permissions');
    return;
  }
  const seen = new Set<string>();
  for (let i = 0; i < r.requires.length; i++) {
    const v = r.requires[i];
    if (typeof v !== 'string' || !v) {
      add('error', 'requires_entry_shape', `requires[${i}]`,
        'each requires entry must be a non-empty string permission slug');
      continue;
    }
    if (seen.has(v)) {
      add('warn', 'requires_duplicate', `requires[${i}]`,
        `duplicate permission "${v}" in requires — list each permission once`);
      continue;
    }
    seen.add(v);
    if (!isKnownPermission(v)) {
      add('warn', 'requires_unknown', `requires[${i}]`,
        `unknown permission "${v}" in requires — known permissions: ${[...KNOWN_PERMISSIONS].join(', ')}, or the open 'read_connection_<connection_name>' family`);
    }
  }
};

/** D-116 — `on_failure` field shape. Install-time "handler installed +
 *  reactive + has recipe-watcher" lives in `checkOnFailureInstallable`
 *  (needs registry I/O). This validator only enforces what can be
 *  checked from the recipe object alone:
 *
 *    - `on_failure_shape`          — not an object or missing recipe_id
 *    - `on_failure_recipe_id_required` — recipe_id absent or empty
 *    - `on_failure_self_loop`      — handler == source (would re-fire)
 *    - `on_failure_config_shape`   — config present but not an object */
export const validateOnFailure = (r: Record<string, unknown>, add: AddFn): void => {
  if (r.on_failure === undefined) return;
  if (!r.on_failure || typeof r.on_failure !== 'object' || Array.isArray(r.on_failure)) {
    add('error', 'on_failure_shape', 'on_failure',
      'on_failure must be an object with at least { recipe_id }');
    return;
  }
  const o = r.on_failure as Record<string, unknown>;
  if (typeof o.recipe_id !== 'string' || !o.recipe_id) {
    add('error', 'on_failure_recipe_id_required', 'on_failure.recipe_id',
      'on_failure.recipe_id is required and must be a non-empty string');
  } else if (typeof r.recipe_id === 'string' && o.recipe_id === r.recipe_id) {
    add('error', 'on_failure_self_loop', 'on_failure.recipe_id',
      'on_failure.recipe_id may not point at this recipe — failures of the handler would re-fire it');
  }
  if (o.config !== undefined
      && (o.config === null || typeof o.config !== 'object' || Array.isArray(o.config))) {
    add('error', 'on_failure_config_shape', 'on_failure.config',
      'on_failure.config must be an object (omit the field entirely if no patch is needed)');
  }
};

/** D-116 — cross-cutting checks for the `wait` transform. Ensures:
 *
 *  - `wait_max_exceeded`       — literal `ms` above WAIT_TRANSFORM_MAX_MS.
 *  - `wait_inside_trigger_steps` — `wait` placed in `trigger_steps`
 *    (pauses the gate phase, starves auto-run).
 *  - `wait_in_non_reactive`    — non-reactive recipe whose only step
 *    is `wait`, or whose cumulative wait exceeds 5_000ms. Warn only;
 *    the user's sidebar will block.
 *
 *  Schema-level type + required checks run in `validateTransformStep`.
 *  The max bound is enforced here (not in TRANSFORM_SCHEMAS) because
 *  the schema registry is pure shape; per-transform runtime bounds
 *  live next to their other cross-field rules. */
/** `pages: "all"` — read a Records search page by page (`StepPages` in contracts).
 *
 *  - `step_pages_invalid` — any value but `"all"`.
 *  - `step_pages_without_operation` — on a sequential step that dispatches
 *    nothing (a transform or guard), where there is no search to read.
 *  - `step_pages_not_sequential` — on a prefetch or trigger step. Only the
 *    sequential runner carries it to the gateway, so it would be ignored there,
 *    and an ignored `pages` reads one page while the recipe believes it read all.
 *
 *  Whether the operation IS a Records search is known at dispatch, where the
 *  gateway refuses it on anything else. */
export const validateStepPages = (r: Record<string, unknown>, add: AddFn): void => {
  for (const key of ['prefetch_steps', 'steps', 'trigger_steps'] as const) {
    const steps = r[key];
    if (!Array.isArray(steps)) continue;
    steps.forEach((step, i) => {
      if (step === null || typeof step !== 'object') return;
      const s = step as Record<string, unknown>;
      if (s.pages === undefined) return;
      const path = `${key}[${i}].pages`;
      if (s.pages !== 'all') {
        add('error', 'step_pages_invalid', path,
          `pages takes one value, "all" (got ${JSON.stringify(s.pages)})`);
        return;
      }
      if (key !== 'steps') {
        add('error', 'step_pages_not_sequential', path,
          `pages is honoured on sequential steps only; a ${key === 'prefetch_steps' ? 'prefetch' : 'trigger'} step would read one page`);
        return;
      }
      if (!('op' in s) && !('ingredient' in s)) {
        add('error', 'step_pages_without_operation', path,
          'pages reads a Records search page by page, so it belongs on the step that runs the search');
      }
    });
  }
};

export const validateWait = (r: Record<string, unknown>, add: AddFn): void => {
  const triggerSteps = Array.isArray(r.trigger_steps) ? r.trigger_steps : [];
  const seqSteps = Array.isArray(r.steps) ? r.steps : [];
  const prefetchSteps = Array.isArray(r.prefetch_steps) ? r.prefetch_steps : [];

  const isWait = (s: unknown): s is Record<string, unknown> =>
    !!s && typeof s === 'object' && !Array.isArray(s)
    && (s as Record<string, unknown>).transform === 'wait';

  for (let i = 0; i < triggerSteps.length; i++) {
    if (isWait(triggerSteps[i])) {
      add('error', 'wait_inside_trigger_steps', `trigger_steps[${i}].transform`,
        'wait is not allowed in trigger_steps — the gate phase must complete promptly so the auto-run scheduler can fire');
    }
  }

  const checkMax = (s: Record<string, unknown>, path: string): number => {
    const ms = s.ms;
    if (typeof ms === 'number' && Number.isFinite(ms)) {
      if (ms > WAIT_TRANSFORM_MAX_MS) {
        add('error', 'wait_max_exceeded', `${path}.ms`,
          `wait.ms is ${ms}ms (max ${WAIT_TRANSFORM_MAX_MS}ms) — use auto_run + next_run_at for longer pauses`);
      }
      return ms > 0 ? ms : 0;
    }
    return 0;
  };

  let totalLiteralWait = 0;
  let waitCount = 0;
  for (let i = 0; i < prefetchSteps.length; i++) {
    if (isWait(prefetchSteps[i])) {
      waitCount++;
      totalLiteralWait += checkMax(prefetchSteps[i] as Record<string, unknown>, `prefetch_steps[${i}]`);
    }
  }
  for (let i = 0; i < seqSteps.length; i++) {
    if (isWait(seqSteps[i])) {
      waitCount++;
      totalLiteralWait += checkMax(seqSteps[i] as Record<string, unknown>, `steps[${i}]`);
    }
  }

  const totalSteps = prefetchSteps.length + seqSteps.length;
  const reactive = r.auto_run !== undefined;
  if (!reactive && waitCount > 0) {
    if ((waitCount === totalSteps) || totalLiteralWait > 5_000) {
      add('warn', 'wait_in_non_reactive', 'steps',
        `wait used without auto_run — the recipe will block the user's sidebar for ${totalLiteralWait}ms; prefer auto_run + next_run_at`);
    }
  }
};

/** D-182 watcher — a trigger-position kernel op (`core.watch.<source>`). It
 *  produces the reactive `should_run` gate and is valid ONLY in `trigger_steps`;
 *  the op-step lowering rewrites it to its backing watcher ingredient. SHAPE only
 *  (domain check) — registry membership of a specific `core.watch.*` op is
 *  validated at install/dispatch by the lowering, mirroring how the other
 *  closed-kind kernel ops are shape-checked here. */
/** D-232 § 21 — `fail_kind` classifies a guard's refusal for a peer reading it
 *  across an exchange. Two rules, both load-bearing:
 *
 *  ⛔⛔ THE VOCABULARY IS NARROWER THAN THE ONE THE ENGINE REPORTS, ON PURPOSE.
 *  `unavailable` is the only remote-failure kind that means "retry later", so a
 *  recipe able to declare it could invite a peer to knock forever. Only the
 *  TRANSPORT may assert unreachability; an author may only describe their own
 *  decision (`policy` = I refused you, `config` = I am not set up for this).
 *
 *  ⚠ AND IT MUST ACCOMPANY A GUARD. `fail_kind` without `fail_on` classifies a
 *  refusal that can never happen — always an authoring mistake, and a silent one,
 *  because the field simply never reads. */
const validateFailKind = (
  s: Record<string, unknown>,
  path: string,
  add: AddFn,
): void => {
  if (s.fail_kind === undefined) return;
  if (s.fail_kind !== 'policy' && s.fail_kind !== 'config') {
    add(
      'error',
      'fail_kind_invalid',
      `${path}.fail_kind`,
      `fail_kind must be 'policy' or 'config' (got ${JSON.stringify(s.fail_kind)}). `
      + "'unavailable' is deliberately not authorable — only the transport may say "
      + 'a peer is unreachable, because that is the one kind that invites a retry.',
    );
    return;
  }
  if (s.fail_on === undefined) {
    add(
      'error',
      'fail_kind_without_fail_on',
      `${path}.fail_kind`,
      'fail_kind classifies a fail_on refusal, but this step declares no fail_on.',
    );
  }
};

/** `stop_when` ends the run, as a success, after a SEQUENTIAL step. Refused
 *  where it would silently do nothing: on a prefetch step (the parallel phase
 *  has no "after") and on a trigger step (its `should_run` already decides).
 *  And refused when it reads `{{item.*}}`: it is one decision about the whole
 *  step, checked once a `foreach` has finished, when no item is bound. */
const validateStopWhen = (
  s: Record<string, unknown>,
  path: string,
  list: 'trigger_steps' | 'prefetch_steps' | 'steps',
  add: AddFn,
): void => {
  if (s.stop_when === undefined) return;
  if (list !== 'steps') {
    add('error', 'stop_when_not_sequential', `${path}.stop_when`,
      `stop_when works only on a step in steps. ${list === 'prefetch_steps'
        ? 'Prefetch steps run side by side, so there is no "after" to stop.'
        : 'A trigger step already decides whether the run goes on, with should_run.'} `
      + 'Put stop_when on the first step in steps that reads this result.');
    return;
  }
  validateConditionField(s.stop_when, `${path}.stop_when`, add);
  const text = typeof s.stop_when === 'string' ? s.stop_when : JSON.stringify(s.stop_when);
  if (/\{\{\s*item(?:\.|\s*\}\})/.test(text)) {
    add('error', 'stop_when_item_ref', `${path}.stop_when`,
      'stop_when is one decision about the whole step, made after a foreach has finished, '
      + 'so no {{item.*}} is bound when it runs. For a per-item decision use skip_when or a filter step.');
  }
};

const isWatchOp = (op: unknown): boolean => {
  if (typeof op !== 'string') return false;
  const parsed = parseOpId(op);
  return parsed?.tier === 'kernel' && parsed.domain === 'watch';
};

/** D-115 — `trigger_steps` validation. Same shape rules as
 *  sequential `steps` (transform | ingredient | guard discriminator,
 *  unique ids), plus the cross-field invariant that `trigger_steps`
 *  without `auto_run` is never executed and therefore rejected. D-182 watcher —
 *  a `core.watch.*` trigger-position op-step IS allowed (it lowers to its backing
 *  watcher ingredient); any other op-step is rejected (it belongs in `steps`). */
export const validateTriggerSteps = (
  r: Record<string, unknown>,
  declared: Set<string>,
  add: AddFn,
): void => {
  if (r.trigger_steps === undefined) return;
  if (!Array.isArray(r.trigger_steps)) return; // shape error already added

  if (r.auto_run === undefined) {
    add('error', 'trigger_steps_without_auto_run', 'trigger_steps',
      'trigger_steps requires auto_run — without it the trigger phase would never fire');
    // Still validate per-step shape so the author sees every error at once.
  }

  if (r.trigger_steps.length === 0) {
    add('warn', 'trigger_steps_empty', 'trigger_steps',
      'trigger_steps is an empty array — omit the field for "always fire" semantics');
    return;
  }

  for (let i = 0; i < r.trigger_steps.length; i++) {
    const st = r.trigger_steps[i];
    const path = `trigger_steps[${i}]`;
    if (!st || typeof st !== 'object' || Array.isArray(st)) {
      add('error', 'trigger_step_shape', path, 'trigger step must be an object');
      continue;
    }
    const s = st as Record<string, unknown>;
    validateUnsupportedStepApproval(s, path, add);
    if (typeof s.id !== 'string' || !s.id) {
      add('error', 'trigger_step_id_required', `${path}.id`, 'trigger step id is required');
      continue;
    }
    validateStepId(s.id, path, declared, add);
      // A `defaults` step DECLARES each of its field names as a step id — the
      // runtime publishes them into `stores.step` (step-runner), so a ref to one
      // resolves. Without this the validator raises `undeclared_step_ref` for
      // every ref that survived a fold, which is how the corpus fold first
      // failed. Keep the two in lockstep.
      if ((s as { transform?: string }).transform === 'defaults') {
        const f = (s as { fields?: unknown }).fields;
        if (f !== null && typeof f === 'object' && !Array.isArray(f)) {
          for (const name of Object.keys(f as Record<string, unknown>)) declared.add(name);
        }
      }

    // D-182 watcher — a `core.watch.*` trigger-position op IS allowed here (it
    // produces the `should_run` gate and the lowering, now over trigger_steps,
    // rewrites it to its backing watcher ingredient). Any OTHER op-step is
    // rejected: a canonical / Tier-P / non-watcher kernel op doesn't produce the
    // gate and the trigger phase must complete promptly — it belongs in `steps`.
    // `op` is counted in the discriminator set so a MIXED step (e.g.
    // `{ op: core.watch.time, ingredient: mail-watcher }`) is rejected here rather
    // than slipping through as a concrete ingredient step at lowering (`isOpStep`
    // is false when a co-discriminator is present → the watch op would be dropped).
    const discriminators = ['transform', 'ingredient', 'guard', 'op'].filter((d) => d in s);
    if (discriminators.length === 0) {
      add('error', 'trigger_step_no_discriminator', path,
        'trigger step must have exactly one of: transform, ingredient, guard, op');
    } else if (discriminators.length > 1) {
      add('error', 'trigger_step_multi_discriminator', path,
        `trigger step has multiple discriminators (${discriminators.join(', ')}) — must have exactly one`);
    } else if ('op' in s) {
      if (isWatchOp(s.op)) {
        if (s.args !== undefined && (s.args === null || typeof s.args !== 'object' || Array.isArray(s.args))) {
          add('error', 'op_step_args_shape', `${path}.args`,
            'trigger op-step `args` must be an object (omit when none)');
        }
      } else {
        add('error', 'op_step_in_trigger_steps', path,
          'only core.watch.* trigger-position ops are allowed in trigger_steps — a canonical / Tier-P / non-watcher kernel op-step belongs in steps');
      }
    } else if (typeof s.transform === 'string') {
      validateTransformStep(s, path, add);
    }

    if (s.skip_when !== undefined) {
      validateConditionField(s.skip_when, `${path}.skip_when`, add);
    }
    if (s.fail_on !== undefined) {
      validateConditionField(s.fail_on, `${path}.fail_on`, add);
    }
    validateFailKind(s, path, add);
    validateStopWhen(s, path, 'trigger_steps', add);
    if ('guard' in s && s.guard !== undefined) {
      validateConditionField(s.guard, `${path}.guard`, add);
    }
  }
};

/** Connection-agnostic canonical op-step shape (D-170 N.18 / slice 3).
 *
 *  An op-step `{ id, op: '<crm_alias>.<verb>', args?, connection? }` carries no
 *  concrete ingredient/connection — it binds at install to whichever
 *  CRM-conformant pack the recipe lands in (the R1 rewrite,
 *  `resolveConnectionAgnosticRecipe`), or per run at dispatch (R2). This is the
 *  fourth step discriminant alongside transform / ingredient / guard, and
 *  the op namespace is the trust-tier discriminator: an all-op recipe is
 *  pure-workflow (D-170 N.18). Only the SHAPE is checked here — `<family>.<verb>`
 *  with exactly one dot. When the family is a `crm_alias` the verb must be a
 *  canonical CRM verb (an entity translate + projection op); ANY OTHER family is a
 *  §5 TOOL op (`web.search`) that names a pack-declared catalog operation directly
 *  (dispatched pass-through). Binding failures — an op the installed pack doesn't
 *  model (CRM or tool), no projectable fields — surface at install time in the
 *  resolver, not at authoring.
 *
 *  Per-operand connection SLOT (R2 step 5, doc §1.3): `connection`, when
 *  present, must be a PURE `{{config.<var>}}` ref naming a declared
 *  `type:'connection'` variable — a literal connection name is non-portable and
 *  any other ref shape is a dispatch-target injection vector. A recipe that
 *  declares MORE than one connection variable has no implicit default, so each
 *  of its op-steps must name its slot explicitly. (Zero declared connection
 *  variables stays valid — a composition-bundled recipe binds the pack's own
 *  connection.)
 *
 *    - `op_step_shape`               — `op` absent / not a non-empty string.
 *    - `op_step_malformed`           — not exactly one dot (`<family>.<verb>`).
 *    - `op_step_unknown_verb`        — entity IS a `crm_alias` but the verb is not a
 *                                      canonical CRM verb. (A NON-crm-alias family is
 *                                      a §5 TOOL op — `web.search` — not an error
 *                                      here; the pack must declare the operation,
 *                                      checked at install. `op_step_unknown_entity`
 *                                      is retired for this reason.)
 *    - `op_step_args_shape`          — `args` present but not an object.
 *    - `op_step_optional_unsupported` — `optional` present (a prefetch-only knob;
 *                                      op-steps are sequential-only, so it is dead).
 *    - `op_step_iteration_unsupported` — `foreach` on a crm_alias-family op-step
 *                                      (a CRM op decomposes into fetch + projection;
 *                                      foreach is supported on TOOL op-steps only).
 *    - `op_step_connection_shape`    — `connection` present but not a pure
 *                                      `{{config.<var>}}` ref.
 *    - `op_step_connection_unknown_variable` — the named variable is not
 *                                      declared `type:'connection'`.
 *    - `op_step_connection_ambiguous` — >1 connection variables declared and
 *                                      the op-step names no slot. */
const validateCanonicalOpStep = (
  s: Record<string, unknown>,
  path: string,
  connectionVars: readonly string[],
  add: AddFn,
): void => {
  const op = s.op;
  if (typeof op !== 'string' || op.length === 0) {
    add('error', 'op_step_shape', `${path}.op`,
      'canonical op-step `op` must be a non-empty string of the form "<entity>.<verb>" (e.g. "deal.search")');
    return;
  }
  // D-182 watcher — a `core.watch.*` op is trigger-position only (it produces the
  // reactive should_run gate); reject it in sequential `steps`. (Without this the
  // closed-kind kernel path below would silently accept it, since `watch` is a
  // closed-kind domain.)
  if (isWatchOp(op)) {
    add('error', 'watch_op_outside_trigger_steps', `${path}.op`,
      'core.watch.* ops are trigger-position only — place the watcher op-step in trigger_steps, not steps');
    return;
  }
  // D-182 Slice 4 — a TWO-TIER op id (kernel `core.<domain>.<op>` or Tier-P
  // `<publisher>.<pack>.<operation>`, ≥3 dot-segments → `parseOpId` non-null) is
  // the canonical D-182 op shape: its SHAPE is accepted here and the concrete
  // kernel-op / pack-op binding is validated at INSTALL/DISPATCH by the op-step
  // lowering (`lowerOpStepRecipe` — the structural validator has no kernel-op
  // registry / catalog access, the SAME trade-off the tool-op seam already takes).
  // Only a LEGACY bare canonical op (`deal.search` / a tool op `web.search` —
  // exactly one dot, 2 segments → `parseOpId` returns null) runs the one-dot +
  // entity/verb checks below; `entity` stays undefined for a two-tier id so the
  // CRM/acct-specific `foreach` guard further down does not fire on it.
  let entity: string | undefined;
  const parsedOp = parseOpId(op);
  // A closed-kind kernel op (`core.ai.*`, `core.storage.*`, `core.data.*`,
  // `core.memory.*`, `core.work-entity.*`, `core.mail.*`, `core.contact.*`,
  // `core.notification.*`) is CONNECTION-LESS by construction — the pool resolver /
  // warehouse drives it, never a per-instance account binding (`OpStep.connection`
  // doc; `resolveKernelClosedKindOpStep` emits no connection). So it never needs a
  // connection slot, even in a multi-connection recipe — exempt it from the
  // ambiguity check below. (Canonical-convention kernel ops `core.crm.*`/`core.acct.*`
  // are NOT closed_kind, so they keep the requirement; Tier-P pack ops can't be
  // resolved here, so they keep it too — concrete kind binds at install/dispatch.)
  const connectionlessKernelOp =
    parsedOp?.tier === 'kernel' && getKernelDomain(parsedOp.domain)?.class === 'closed_kind';
  if (parsedOp === null) {
    const dot = op.indexOf('.');
    if (dot <= 0 || dot >= op.length - 1 || op.indexOf('.', dot + 1) !== -1) {
      add('error', 'op_step_malformed', `${path}.op`,
        `op "${op}" must be a two-tier id ("core.<domain>.<op>" / "<publisher>.<pack>.<operation>") or a bare canonical op "<entity>.<verb>" with exactly one dot (e.g. "deal.search")`);
      return;
    }
    entity = op.slice(0, dot);
    const verb = op.slice(dot + 1);
    // §5 tool-op pack seam — a bare op-step is EITHER a CRM canonical op (entity ∈
    // crm_alias → the verb must be a canonical CRM verb, checked here) OR a TOOL op
    // (any other family — e.g. `web.search`) naming a pack-declared catalog
    // operation DIRECTLY. A tool op's family + verb are an OPEN, pack-defined
    // vocabulary the structural validator can't enumerate (no catalog access), so
    // only the `<family>.<verb>` SHAPE is checked for it; whether the installed
    // pack actually declares the operation surfaces at INSTALL (the resolver's
    // tool path), exactly as an unknown CRM op does. Trade-off: a crm_alias TYPO
    // ("dela.search") now reads as a tool op and fails at install rather than
    // here — acceptable, the install error names the missing operation.
    if (CRM_ALIAS_SET.has(entity) && !CANONICAL_VERB_SET.has(verb)) {
      add('error', 'op_step_unknown_verb', `${path}.op`,
        `canonical op "${op}" verb "${verb}" is not a canonical CRM verb — one of ${[...CANONICAL_CRM_VERBS].join(', ')} (vendor-specific ops bind per pack, not via a canonical op-step)`);
    }
    // SMB-finance slice 5b — an accounting canonical op (`<acct_alias>.<verb>`)
    // admits only the two READ verbs; a money write rides the explicit ingredient
    // binding so it keeps its approval gate, never a canonical op-step.
    if (ACCT_ALIAS_SET.has(entity) && !CANONICAL_ACCT_VERB_SET.has(verb)) {
      add('error', 'op_step_unknown_verb', `${path}.op`,
        `canonical accounting op "${op}" verb "${verb}" is not a read verb — one of ${[...CANONICAL_ACCT_VERBS].join(', ')} (accounting writes bind the explicit ingredient so they keep their approval gate, not a canonical op-step)`);
    }
  }
  // §5 tool-op pack seam — `optional` is honored ONLY on prefetch steps (`execute`
  // halts the sequential loop on any step error); op-steps are sequential-only (banned
  // from prefetch), so `optional` on ANY op-step is a dead field — reject it rather
  // than silently ignore. Per-iteration failure isolation comes from `foreach` itself
  // (each iteration yields an `{ ok:false }` envelope), not from `optional`.
  if (s.optional !== undefined) {
    add('error', 'op_step_optional_unsupported', `${path}.optional`,
      `canonical op-step "${op}" cannot carry \`optional\` — it is honored only on prefetch steps, and op-steps are sequential-only; per-call failures are isolated by \`foreach\` (tool op-steps) which yields an { ok:false } envelope per iteration`);
  }
  // `foreach` rides the SINGLE pass-through fetch a TOOL op (`<non-crm_alias>.<verb>`)
  // resolves to. A CRM entity-op decomposes into a fetch + projection PAIR, where
  // foreach has no single target, so the resolver does not carry it — reject here
  // rather than silently drop (a foreach CRM op would run ONCE). Lift when 2-step
  // iteration semantics are designed.
  if (entity !== undefined && (CRM_ALIAS_SET.has(entity) || ACCT_ALIAS_SET.has(entity)) && s.foreach !== undefined) {
    add('error', 'op_step_iteration_unsupported', `${path}.foreach`,
      `canonical ${ACCT_ALIAS_SET.has(entity) ? 'accounting' : 'CRM'} op-step "${op}" cannot carry \`foreach\` — per-iteration dispatch is supported on tool op-steps only (an entity op resolves to a fetch + projection pair)`);
  }
  if (s.args !== undefined && (s.args === null || typeof s.args !== 'object' || Array.isArray(s.args))) {
    add('error', 'op_step_args_shape', `${path}.args`,
      'canonical op-step `args` must be an object of vendor-neutral args (omit when none)');
  }
  // Per-operand connection slot (R2 step 5, doc §1.3).
  if (s.connection !== undefined) {
    if (typeof s.connection !== 'string' || !OP_STEP_CONNECTION_REF_REGEX.test(s.connection)) {
      add('error', 'op_step_connection_shape', `${path}.connection`,
        'canonical op-step `connection` must be a pure {{config.<var>}} ref naming a type:\'connection\' recipe variable — literal connection names and other refs are not portable');
      return;
    }
    const varName = parseOpStepConnectionRef(s.connection);
    if (varName !== undefined && !connectionVars.includes(varName)) {
      add('error', 'op_step_connection_unknown_variable', `${path}.connection`,
        `canonical op-step connection slot names variable "${varName}", which is not declared as a type:'connection' variable — declare it under variables with type: "connection"`);
    }
  } else if (connectionVars.length > 1 && !connectionlessKernelOp) {
    add('error', 'op_step_connection_ambiguous', path,
      `recipe declares ${connectionVars.length} connection variables (${[...connectionVars].sort().join(', ')}) so this op-step has no implicit connection — name its slot explicitly (connection: "{{config.<var>}}")`);
  }
};

/** D-182 Slice 4 — validate an op-shaped `prefetch_steps` entry. A prefetch op-step
 *  may ONLY name an op that lowers to a SINGLE fetch — a kernel CLOSED-KIND read
 *  (`core.ai.*`, `core.storage.*`, …) or a Tier-P vendor RAW read
 *  (`recued-core.hubspot.deal.read`). A canonical-convention kernel op (`core.crm.*`
 *  / `core.acct.*`) or a legacy bare canonical / malformed op (`deal.search`,
 *  `parseOpId === null`) decomposes into a fetch + a projection transform that the
 *  ingredient-calls-only prefetch phase cannot hold, so it is rejected
 *  (`op_step_in_prefetch`) — it must live in `steps`. Unlike the sequential
 *  `validateCanonicalOpStep`, `optional` IS honoured here (prefetch's per-step error
 *  isolation), so it is not rejected. The concrete kernel-op / pack-op binding is
 *  validated at install/dispatch by the op-step lowering (`lowerOpStepRecipe`) — the
 *  structural validator only checks SHAPE (no registry/catalog access). */
const validatePrefetchOpStep = (
  s: Record<string, unknown>,
  path: string,
  connectionVars: readonly string[],
  add: AddFn,
): void => {
  const op = s.op;
  if (typeof op !== 'string' || op.length === 0) {
    add('error', 'op_step_shape', `${path}.op`,
      'prefetch op-step `op` must be a non-empty two-tier op id (kernel "core.<domain>.<op>" or Tier-P "<publisher>.<pack>.<operation>")');
    return;
  }
  // D-182 watcher — a `core.watch.*` op is trigger-position only; reject it in
  // prefetch_steps. (`watch` is a closed-kind domain, so the `prefetchable` check
  // below would otherwise admit it.)
  if (isWatchOp(op)) {
    add('error', 'watch_op_outside_trigger_steps', `${path}.op`,
      'core.watch.* ops are trigger-position only — place the watcher op-step in trigger_steps, not prefetch_steps');
    return;
  }
  const parsed = parseOpId(op);
  // Only kernel CLOSED-KIND + Tier-P ops lower to a single prefetch fetch; a
  // canonical-convention kernel op or a legacy bare canonical / malformed op
  // decomposes → not allowed in prefetch.
  const prefetchable =
    parsed !== null &&
    (parsed.tier === 'pack' || getKernelDomain(parsed.domain)?.class === 'closed_kind');
  if (!prefetchable) {
    add('error', 'op_step_in_prefetch', `${path}.op`,
      `op-step "${op}" is not allowed in prefetch_steps — a canonical (CRM/acct or bare) op decomposes into a fetch + a projection and must live in steps; only kernel / Tier-P raw reads may sit in prefetch_steps`);
    return;
  }
  // prefetch_steps is read-tier by construction — the prefetch runner does NOT
  // run the preflight-pause/approval machinery (that lives only in the sequential
  // lane), so a write/destructive op placed here would bypass its gate entirely.
  // Reject a write/destructive KERNEL op (its risk is statically known via the
  // registry; e.g. core.dom.write / core.mail.send / core.storage.shared.write).
  // A Tier-P op's risk lives in the pack catalog (not resolvable at recipe-validate
  // time) — its prefetch use is the intended "raw read" path and stays admitted.
  if (parsed.tier === 'kernel') {
    const kernelOp = getKernelOp(op);
    if (kernelOp !== undefined && kernelOp.risk !== 'read') {
      add('error', 'write_op_in_prefetch', `${path}.op`,
        `op-step "${op}" is risk:${kernelOp.risk} — prefetch_steps is read-tier by construction (no approval gate runs there); place a write/destructive op in steps`);
      return;
    }
  }
  if (s.args !== undefined && (s.args === null || typeof s.args !== 'object' || Array.isArray(s.args))) {
    add('error', 'op_step_args_shape', `${path}.args`,
      'prefetch op-step `args` must be an object (omit when none)');
  }
  // A kernel closed-kind op is connection-less (pool resolver / warehouse driven);
  // a Tier-P op binds a per-instance connection slot. Validate a present slot's ref
  // SHAPE either way; require one (ambiguity check) only for a Tier-P op in a
  // multi-connection recipe — mirrors the sequential validator's exemption.
  const connectionlessKernelOp = parsed.tier === 'kernel';
  if (s.connection !== undefined) {
    if (typeof s.connection !== 'string' || !OP_STEP_CONNECTION_REF_REGEX.test(s.connection)) {
      add('error', 'op_step_connection_shape', `${path}.connection`,
        'prefetch op-step `connection` must be a pure {{config.<var>}} ref naming a type:\'connection\' recipe variable');
      return;
    }
    const varName = parseOpStepConnectionRef(s.connection);
    if (varName !== undefined && !connectionVars.includes(varName)) {
      add('error', 'op_step_connection_unknown_variable', `${path}.connection`,
        `prefetch op-step connection slot names variable "${varName}", which is not declared as a type:'connection' variable`);
    }
  } else if (connectionVars.length > 1 && !connectionlessKernelOp) {
    add('error', 'op_step_connection_ambiguous', path,
      `recipe declares ${connectionVars.length} connection variables (${[...connectionVars].sort().join(', ')}) so this prefetch op-step has no implicit connection — name its slot explicitly (connection: "{{config.<var>}}")`);
  }
};

/** Validate step shapes and collect declared step ids. Returns the
 *  union of prefetch + sequential ids so later validators can use it
 *  for reference resolution and output.source checks. */
export const validateSteps = (r: Record<string, unknown>, add: AddFn): Set<string> => {
  const declared = new Set<string>();
  // Per-operand connection slots (R2 step 5) — the declared `type:'connection'`
  // variables an op-step `connection` ref may name. Computed once; only consulted
  // for op-steps. A non-object `variables` already errors in validateRequiredFields.
  const connectionVars = connectionVariableNames(
    typeof r.variables === 'object' && r.variables !== null && !Array.isArray(r.variables)
      ? ({ variables: r.variables } as Parameters<typeof connectionVariableNames>[0])
      : {},
  );

  // Prefetch steps
  if (Array.isArray(r.prefetch_steps)) {
    for (let i = 0; i < r.prefetch_steps.length; i++) {
      const ps = r.prefetch_steps[i];
      const path = `prefetch_steps[${i}]`;
      if (!ps || typeof ps !== 'object' || Array.isArray(ps)) {
        add('error', 'prefetch_step_shape', path, 'prefetch step must be an object');
        continue;
      }
      const s = ps as Record<string, unknown>;
      validateUnsupportedStepApproval(s, path, add);
      if (typeof s.id !== 'string' || !s.id) {
        add('error', 'prefetch_step_id_required', `${path}.id`, 'prefetch step id is required');
        continue;
      }
      validateStepId(s.id, path, declared, add);
      validateStopWhen(s, path, 'prefetch_steps', add);
      // A `defaults` step DECLARES each of its field names as a step id — the
      // runtime publishes them into `stores.step` (step-runner), so a ref to one
      // resolves. Without this the validator raises `undeclared_step_ref` for
      // every ref that survived a fold, which is how the corpus fold first
      // failed. Keep the two in lockstep.
      if ((s as { transform?: string }).transform === 'defaults') {
        const f = (s as { fields?: unknown }).fields;
        if (f !== null && typeof f === 'object' && !Array.isArray(f)) {
          for (const name of Object.keys(f as Record<string, unknown>)) declared.add(name);
        }
      }
      // D-182 Slice 4 — a `prefetch_steps` entry may now name a two-tier `op`
      // (owner decision (a): "read ops ALLOWED in prefetch"), but ONLY for ops
      // that lower to a SINGLE fetch — kernel closed-kind reads and Tier-P vendor
      // raw reads. A canonical-convention op (`core.crm.*` / `core.acct.*`) or a
      // legacy bare canonical op (`deal.search`) decomposes into a fetch + a
      // projection transform the ingredient-calls-only prefetch phase can't hold,
      // so it stays rejected (`op_step_in_prefetch`). The op-step lowering
      // concretizes the admitted ones into `PrefetchStep`s before the engine runs.
      if ('op' in s) {
        validatePrefetchOpStep(s, path, connectionVars, add);
        continue;
      }
      if (typeof s.ingredient !== 'string' || !s.ingredient) {
        add('error', 'prefetch_ingredient_required', `${path}.ingredient`,
          'prefetch step must reference an ingredient slug');
      }
      // Prefetch steps shouldn't have transform or guard fields
      if ('transform' in s) {
        add('error', 'prefetch_has_transform', `${path}.transform`,
          'prefetch steps are ingredient calls only — transform is not allowed');
      }
      if ('guard' in s) {
        add('error', 'prefetch_has_guard', `${path}.guard`,
          'prefetch steps are ingredient calls only — guard is not allowed');
      }
    }
  }

  // Sequential steps
  if (Array.isArray(r.steps)) {
    for (let i = 0; i < r.steps.length; i++) {
      const st = r.steps[i];
      const path = `steps[${i}]`;
      if (!st || typeof st !== 'object' || Array.isArray(st)) {
        add('error', 'step_shape', path, 'step must be an object');
        continue;
      }
      const s = st as Record<string, unknown>;
      validateUnsupportedStepApproval(s, path, add);
      if (typeof s.id !== 'string' || !s.id) {
        add('error', 'step_id_required', `${path}.id`, 'step id is required');
        continue;
      }
      validateStepId(s.id, path, declared, add);
      // A `defaults` step DECLARES each of its field names as a step id — the
      // runtime publishes them into `stores.step` (step-runner), so a ref to one
      // resolves. Without this the validator raises `undeclared_step_ref` for
      // every ref that survived a fold, which is how the corpus fold first
      // failed. Keep the two in lockstep.
      if ((s as { transform?: string }).transform === 'defaults') {
        const f = (s as { fields?: unknown }).fields;
        if (f !== null && typeof f === 'object' && !Array.isArray(f)) {
          for (const name of Object.keys(f as Record<string, unknown>)) declared.add(name);
        }
      }

      // Exactly one discriminator: transform | ingredient | guard | op.
      // `op` is the connection-agnostic canonical op-step (D-170 N.18) — bound
      // to a concrete ingredient/connection at install (R1 rewrite).
      const discriminators = ['transform', 'ingredient', 'guard', 'op'].filter((d) => d in s);
      if (discriminators.length === 0) {
        add('error', 'step_no_discriminator', path,
          'step must have exactly one of: transform, ingredient, guard, op');
      } else if (discriminators.length > 1) {
        add('error', 'step_multi_discriminator', path,
          `step has multiple discriminators (${discriminators.join(', ')}) — must have exactly one`);
      }

      // Transform step: check name is known and required params are present.
      if (typeof s.transform === 'string') {
        validateTransformStep(s, path, add);
      }

      // Canonical op-step (connection-agnostic): validate the `op` shape only
      // when it's the sole discriminator (a transform/ingredient/guard that also
      // carries `op` already errored as multi-discriminator above).
      if ('op' in s && discriminators.length === 1) {
        validateCanonicalOpStep(s, path, connectionVars, add);
      }

      // Condition strings
      if (s.skip_when !== undefined) {
        validateConditionField(s.skip_when, `${path}.skip_when`, add);
      }
      if (s.fail_on !== undefined) {
        validateConditionField(s.fail_on, `${path}.fail_on`, add);
      }
      validateFailKind(s, path, add);
      validateStopWhen(s, path, 'steps', add);
      if ('guard' in s && s.guard !== undefined) {
        validateConditionField(s.guard, `${path}.guard`, add);
      }

      // model_hint check for ingredient steps
      if ('ingredient' in s && s.input && typeof s.input === 'object' && !Array.isArray(s.input)) {
        const inp = s.input as Record<string, unknown>;
        if (inp['llm.model_hint'] !== undefined && inp['llm.model_hint'] !== null) {
          const hint = inp['llm.model_hint'];
          if (typeof hint !== 'string' || !VALID_MODEL_HINTS.has(hint)) {
            add('error', 'invalid_model_hint', `${path}.input['llm.model_hint']`,
              `llm.model_hint must be one of ${[...VALID_MODEL_HINTS].join(', ')} — got ${JSON.stringify(hint)}`);
          }
        }
      }
    }
  }

  return declared;
};

/** Check a transform step against its schema. Catches unknown transform names,
 *  missing required params, and wrong-type literal params. Reference values
 *  (`{{...}}`) are skipped for type checks because their runtime type is
 *  only known at execution time. */
const validateTransformStep = (
  step: Record<string, unknown>,
  path: string,
  add: AddFn,
): void => {
  const name = step.transform as string;
  const schema = TRANSFORM_SCHEMAS[name];
  if (!schema) {
    add('error', 'unknown_transform', `${path}.transform`,
      `unknown transform "${name}" — not in the registered set`);
    return;
  }

  // Required params check
  for (const [paramName, def] of Object.entries(schema)) {
    if (!def.required) continue;
    if (!(paramName in step)) {
      add('error', 'transform_missing_param', `${path}.${paramName}`,
        `transform "${name}" requires parameter "${paramName}"`);
    }
  }

  // map apply-target check — the apply value must name a registered
  // TRANSFORM (ingredient slugs cannot run inside a transform step; the
  // runtime throws on dispatch — s13 spot-run found two shipped recipes
  // with `apply: ai-classify` / `apply: search-exa` that silently
  // passed the array through unchanged for their whole life). When the
  // target is known, its required params must be satisfiable: apply
  // injects the per-item field value under the target's value param
  // (`applyValueParam` — the same table the runtime injection uses), so
  // every OTHER required param has to be present on the step itself.
  if (name === 'map' && typeof step.apply === 'string' && step.apply.length > 0) {
    const targetName = step.apply;
    const target = TRANSFORM_SCHEMAS[targetName];
    if (step.expression !== undefined) {
      // Two competing modes on one step: the runtime runs EXPRESSION mode
      // first and never reaches apply, so the apply key is dead weight that
      // reads like the step's behavior (five shipped steps carried
      // `apply: "math"` beside a math expression for exactly this reason —
      // they worked, but only because the apply key was ignored).
      add('error', 'apply_with_expression', `${path}.apply`,
        `map step has both "expression" and "apply" — expression mode wins and `
        + `"${targetName}" never runs; remove the apply key (a math expression `
        + `needs no apply) or drop the expression`);
    }
    if (!target) {
      add('error', 'unknown_apply_transform', `${path}.apply`,
        `map apply target "${targetName}" is not a registered transform — `
        + `ingredient slugs cannot run inside a transform step; use a foreach `
        + `ingredient step (or D-162 batch mode for ai-*) instead`);
    } else if (!(applyValueParam(targetName) in target)) {
      // The injection contract: apply hands the per-item value to the target
      // under its value param. A target whose schema doesn't declare that
      // param (math reads expression/left/right; template reads template;
      // coalesce reads values; …) can never receive the item value — every
      // row would compute on undefined. Derived from the schema, so it
      // self-maintains as transforms evolve.
      add('error', 'apply_target_incompatible', `${path}.apply`,
        `map apply target "${targetName}" has no "${applyValueParam(targetName)}" `
        + `parameter — it cannot receive the per-item value; use expression mode `
        + `or a different target`);
    } else {
      const valueParam = applyValueParam(targetName);
      for (const [paramName, def] of Object.entries(target)) {
        if (paramName === valueParam) continue;
        if (!(paramName in step)) {
          if (def.required) {
            add('error', 'apply_param_missing', `${path}.${paramName}`,
              `map apply target "${targetName}" requires parameter "${paramName}" `
              + `(the per-item value is injected as "${valueParam}"; everything else `
              + `must be supplied on the step)`);
          }
          continue;
        }
        // Present on the step — run the target's literal type / enum checks
        // (the map schema doesn't know these params, so without this an
        // invalid operator spelling like `greater_equal` on `apply: compare`
        // validates clean and evaluates false forever at runtime).
        const value = step[paramName];
        if (typeof value === 'string' && REF_PATTERN.test(value)) continue;
        if (value === null || value === undefined) continue;
        if (def.type !== undefined && def.type !== 'any' && !matchesParamType(value, def.type)) {
          add('error', 'apply_param_wrong_type', `${path}.${paramName}`,
            `map apply target "${targetName}" expects parameter "${paramName}" to be `
            + `${def.type} — got ${describeType(value)}`);
          continue;
        }
        if (def.enum !== undefined && typeof value === 'string' && !def.enum.includes(value)) {
          add('error', 'apply_param_invalid_enum', `${path}.${paramName}`,
            `map apply target "${targetName}" parameter "${paramName}" must be one of: `
            + `${def.enum.join(', ')} — got "${value}"`);
        }
      }
    }
  }

  // Conditions-array operator check — `filter` / `partition` / `all` / `any`
  // accept a `conditions` array whose entries carry their own operator. The
  // schema layer types the array but never looks inside, so a misspelled
  // operator (`greater_equal`) validates clean and `evaluateOp` returns
  // false forever — a silent always-empty filter (s13 spot-run class).
  if (Array.isArray(step.conditions)) {
    (step.conditions as unknown[]).forEach((entry, i) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return;
      const op = (entry as Record<string, unknown>).operator;
      if (typeof op === 'string' && !OPS.has(op as never)) {
        add('error', 'condition_operator_invalid', `${path}.conditions[${i}].operator`,
          `unknown condition operator "${op}" — must be one of: `
          + `${[...OPS].join(', ')}`);
      }
    });
  }

  // Literal-type check for declared params
  for (const [paramName, def] of Object.entries(schema)) {
    if (!(paramName in step)) continue;
    const value = step[paramName];
    // Skip reference values — their runtime type depends on resolution
    if (typeof value === 'string' && REF_PATTERN.test(value)) continue;
    if (value === null || value === undefined) continue;
    if (def.type !== undefined && def.type !== 'any') {
      if (!matchesParamType(value, def.type)) {
        add('error', 'transform_param_wrong_type', `${path}.${paramName}`,
          `transform "${name}" expects parameter "${paramName}" to be ${def.type} — got ${describeType(value)}`);
        continue; // wrong type → don't also complain about enum
      }
    }
    // Enum check — only for literal strings, and only after type check passed
    if (def.enum !== undefined && typeof value === 'string' && !def.enum.includes(value)) {
      add('error', 'transform_param_invalid_enum', `${path}.${paramName}`,
        `transform "${name}" parameter "${paramName}" must be one of: ${def.enum.join(', ')} — got "${value}"`);
    }
  }
};

export const validateVariables = (
  r: Record<string, unknown>,
  declaredStepIds: Set<string>,
  add: AddFn,
): void => {
  if (!r.variables || typeof r.variables !== 'object' || Array.isArray(r.variables)) return;
  const variables = r.variables as Record<string, unknown>;

  for (const [name, value] of Object.entries(variables)) {
    // Name shape checks
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      add('error', 'variable_name_invalid', `variables.${name}`,
        `variable name "${name}" must match /^[a-zA-Z_][a-zA-Z0-9_]*$/`);
    }
    if (RESERVED_STEP_IDS.has(name)) {
      add('error', 'variable_name_reserved', `variables.${name}`,
        `variable name "${name}" is a reserved namespace root`);
    }
    if (declaredStepIds.has(name)) {
      add('warn', 'variable_shadows_step', `variables.${name}`,
        `variable "${name}" shares a name with a step — this is confusing, rename one`);
    }

    // Enum variable validation — array-valued variables follow the
    // "first element is default" convention. Enforce that all elements
    // share a type and there are at least two options (otherwise it's a
    // scalar default, not an enum).
    if (Array.isArray(value)) {
      validateEnumVariable(name, value, add);
    } else if (value !== null && typeof value === 'object') {
      validateValueHint(name, value as Record<string, unknown>, add);
    }
  }

  // Usage check comes in validateReferences (needs full ref walk first)
};

/** D-314 — a list setting's `options` are its checkboxes: the values, or one
 *  list Recued keeps (`["@weekdays"]`). Shape is checked above (non-empty
 *  strings, which is all an older server checks, so it installs these too).
 *
 *  ⛔ AN OPTIONAL LIST WITH OPTIONS HAS NO DEFAULT. Nothing ticked is how an
 *  owner empties it, and an empty optional setting takes its default, so the
 *  boxes they unticked would come back ticked. The two lists that carry options
 *  today are each one side: channels are optional with no default (nothing
 *  ticked is every channel set up), weekdays are required with one. */
const validateListOptions = (
  name: string,
  hint: Record<string, unknown>,
  issue: (field: string, message: string) => void,
): void => {
  const ref = listVocabularyRef(hint.options);
  const isList = (hint.type as string) === 'array';
  if (ref !== undefined && Object.hasOwn(LIST_VOCABULARIES, ref) && !isList) {
    issue('options', `"@${ref}" is a list of choices, so only a list setting (type 'array') can offer it`);
    return;
  }
  if (!isList || !Array.isArray(hint.options) || hint.options.length === 0) return;
  if (ref !== undefined && !Object.hasOwn(LIST_VOCABULARIES, ref)) {
    issue('options', `"@${ref}" is not a list Recued keeps. It keeps `
      + `${Object.keys(LIST_VOCABULARIES).map((known) => `@${known}`).join(', ')}`);
    return;
  }
  const choices = listSettingChoices(hint);
  if (choices === undefined) return; // shape refused above
  if (hint.default !== undefined) {
    if (!Array.isArray(hint.default)
        || hint.default.some((item) => choices.normalize(item) === undefined)) {
      issue('default', `list setting "${name}" has a default that is not a list of its options`);
    }
    if (hint.optional === true) {
      issue('default', `list setting "${name}" offers options and may be left empty, so it has no `
        + 'default: unticking every box would bring the default back');
    }
  }
};

/** D-222 Slice 0 — TypeScript's `ValueHint` interface is not an install-time
 *  guarantee. An arbitrary object used to pass validation, then the widget
 *  layer treated an object without `label` as a primitive default and silently
 *  synthesized a field. Close that third state here: admitted object-form
 *  variables have a non-empty label/type and correctly shaped known options.
 *  Unknown non-empty type strings remain valid for authored-corpus forward
 *  compatibility (`connection`, `service_ref`, `array`, ...). */
const validateValueHint = (
  name: string,
  hint: Record<string, unknown>,
  add: AddFn,
): void => {
  const path = `variables.${name}`;
  const issue = (field: string, message: string): void => {
    add('error', 'variable_hint_invalid', `${path}.${field}`, message);
  };

  // ⛔ The unknown-KEY fence (2026-07-30). Before it, this function type-checked
  // only the members it knew and ignored everything else, so an invented cell
  // validated perfectly clean and did nothing. Three of them were live:
  // `required` (1,968 occurrences across 1,133 recipes — `optional` is the real
  // member and its absence already means required) and `min`/`max`. The AI
  // recipe-draft brief and this repo's own schema reference both actively taught
  // `required`, which is how it reached 58% of the corpus without one reader.
  //
  // ⚠ Deliberately asymmetric with the `type` check below: an unknown TYPE stays
  // admitted (the authored corpus legitimately runs ahead of `ValueHintType` and
  // renderers fall back to `text` — a D-222 § 7 ruling), while an unknown KEY
  // refuses. An unknown type has a fallback; an unknown key has none. Silence is
  // the worst failure mode available: the author believes the field is doing
  // something and every reader sees nothing.
  //
  // The allow-list is `VALUE_HINT_KEYS`, derived from `keyof ValueHint` and
  // machine-checked complete in both directions at the contract. There is no
  // second copy of the vocabulary here — a copy is what let `required` survive.
  for (const key of Object.keys(hint)) {
    if ((VALUE_HINT_KEYS as readonly string[]).includes(key)) continue;
    add('error', 'variable_hint_unknown_key', `${path}.${key}`,
      `object-form variable "${name}" has unknown field "${key}" — `
      + `nothing reads it. Admitted fields: ${VALUE_HINT_KEYS.join(', ')}`
      + (key === 'required'
        ? '. Use "optional": true for a skippable variable; omit it to require one'
        : ''));
  }

  if (typeof hint.label !== 'string' || hint.label.trim().length === 0) {
    issue('label', `object-form variable "${name}" requires a non-empty string label`);
  }
  if (typeof hint.type !== 'string' || hint.type.trim().length === 0) {
    issue('type', `object-form variable "${name}" requires a non-empty string type`);
  }
  if (hint.optional !== undefined && typeof hint.optional !== 'boolean') {
    issue('optional', 'ValueHint.optional must be a boolean when present');
  }

  for (const field of ['help', 'link', 'provider'] as const) {
    const value = hint[field];
    if (value !== undefined && typeof value !== 'string') {
      issue(field, `ValueHint.${field} must be a string when present`);
    }
  }

  for (const field of ['options', 'scopes', 'accept_mime_types'] as const) {
    const value = hint[field];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((entry) =>
      typeof entry !== 'string' || entry.trim().length === 0)) {
      issue(field, `ValueHint.${field} must be an array of non-empty strings when present`);
    }
  }

  if (hint.type === 'enum'
      && (!Array.isArray(hint.options) || hint.options.length === 0)) {
    issue('options', 'an enum ValueHint requires at least one option');
  }

  validateListOptions(name, hint, issue);

  // ⛔ A `record_ref` with no entity is a picker over nothing. It would render
  // as a plain text box — the raw-id field the type exists to replace — and
  // look like it worked, which is the failure mode the key fence above was
  // written for. Refuse it while the author is looking at the recipe.
  if (hint.type === 'record_ref'
      && (typeof hint.entity !== 'string' || hint.entity.trim().length === 0)) {
    issue('entity', "a record_ref ValueHint requires the entity kind its picker searches");
  }
  // …and the converse: an entity on any other type reads as a binding that
  // nothing honours.
  if (hint.entity !== undefined && hint.type !== 'record_ref') {
    issue('entity', `ValueHint.entity is only meaningful on a record_ref, not on '${String(hint.type)}'`);
  }
  // ⛔ A scope with nothing to scope is a filter nobody applies — it reads as a
  // narrowed picker in the recipe and offers everything at the keyboard.
  if (hint.entity_filter !== undefined && hint.type !== 'record_ref') {
    issue('entity_filter',
      `ValueHint.entity_filter is only meaningful on a record_ref, not on '${String(hint.type)}'`);
  }
  if (hint.entity_filter !== undefined) {
    const filter = hint.entity_filter as unknown;
    if (filter === null || typeof filter !== 'object' || Array.isArray(filter)) {
      issue('entity_filter', 'entity_filter must be an object of { field: value }');
    } else {
      const entries = Object.entries(filter as Record<string, unknown>);
      if (entries.length === 0) {
        issue('entity_filter', 'entity_filter must name at least one field');
      }
      for (const [key, value] of entries) {
        // ⚠ Strings only. A picker filter is compared against a stored field,
        // and a number or boolean here would be an equality that never matches
        // — a picker that silently offers nothing rather than everything.
        if (typeof value !== 'string' || value.length === 0) {
          issue('entity_filter', `entity_filter.${key} must be a non-empty string`);
        }
      }
    }
  }
};

/** Validate an array-form enum variable. The convention is "first element
 *  is the default; the full array is the list of allowed values". */
const validateEnumVariable = (name: string, value: unknown[], add: AddFn): void => {
  const path = `variables.${name}`;

  if (value.length === 0) {
    add('error', 'enum_variable_empty', path,
      `enum variable "${name}" must have at least one element (conventionally the default)`);
    return;
  }

  if (value.length === 1) {
    add('warn', 'enum_variable_single', path,
      `enum variable "${name}" has only one element — if it's a fixed value use a scalar default instead`);
    return;
  }

  // All elements must be the same primitive type. Mixed-type enums are a
  // bug — the user picker can't render them and the AI can't reliably
  // interpret them.
  const firstType = describeType(value[0]);
  for (let i = 1; i < value.length; i++) {
    const t = describeType(value[i]);
    if (t !== firstType) {
      add('error', 'enum_variable_mixed_types', `${path}[${i}]`,
        `enum variable "${name}" has element ${i} of type ${t}, but element 0 is ${firstType} — all enum values must share a type`);
    }
  }

  // Enum elements must be scalar (string/number/boolean). Nested objects
  // or arrays don't render in the settings picker.
  if (firstType !== 'string' && firstType !== 'number' && firstType !== 'boolean') {
    add('error', 'enum_variable_non_scalar', path,
      `enum variable "${name}" elements must be string, number, or boolean — got ${firstType}`);
  }

  // Duplicate enum values are a bug
  const seen = new Set<unknown>();
  for (let i = 0; i < value.length; i++) {
    if (seen.has(value[i])) {
      add('warn', 'enum_variable_duplicate', `${path}[${i}]`,
        `enum variable "${name}" has duplicate value ${JSON.stringify(value[i])} at index ${i}`);
    }
    seen.add(value[i]);
  }
};

/** THE fence. An authored key this validator does not KNOW about is not an error today —
 *  it is SILENCE: it passes the gate, ships, and renders nowhere.
 *
 *  ⛔ THIS IS NOT A STYLE RULE. It closes a defect class that cost the corpus real work.
 *  `output.content` (245 recipes), `output.body` (30), `output.actions` (1), section `title`
 *  (442 authored, 21 surviving) and section `copy_button` (3) were all invented, all
 *  plausible, all validated CLEAN, and not one byte of any of them ever rendered — because
 *  the gate only ever looked at the keys it recognised. Authors then pattern-matched the
 *  corpus and reproduced them; a vendor session shipped 8/8 recipes carrying a dead
 *  `output.content` as late as 2026-07-16. Silence is the worst possible failure mode: the
 *  author believes the detail is surfaced, and every reader — owner AND model — sees nothing.
 *
 *  The rule is DERIVED, never a hand-typed list: ordinary `OutputSection`s are
 *  `{type, source, label?}` and the D-222 `filter` discriminator adds exactly
 *  `fields`, `hidden`, and `submit`
 *  and `RecipeOutput` is `{render?, sidebar?}`. Widen a shape in contracts and widen the
 *  matching const here in the same change — a copy that silently disagrees is the drift this
 *  very fence exists to catch. */
const KNOWN_OUTPUT_KEYS: ReadonlySet<string> = new Set(['render', 'sidebar', 'exchange']);
/** D-232 § 19.3 — the exchange output kind's own fence. Same rule as the block
 *  and section fences above and for the same reason: an invented key here is a
 *  field the fire point never reads, so an author would believe they had told
 *  the far side something and the far side would receive nothing. */
const KNOWN_EXCHANGE_KEYS: ReadonlySet<string> = new Set([
  'ref',
  'deliver_to',
  'callback_op',
  'connection',
  'data',
  // D-232 § 28 — "this answer must leave the server; refuse rather than
  // deliver it locally". See `RecipeExchangeOutput.require_connection`.
  'require_connection',
]);
const KNOWN_SECTION_KEYS: ReadonlySet<string> = new Set(['type', 'source', 'label']);
const KNOWN_FILTER_SECTION_KEYS: ReadonlySet<string> = new Set([
  ...KNOWN_SECTION_KEYS,
  'fields',
  'hidden',
  'submit',
]);
const KNOWN_RECORD_FIELDS_SECTION_KEYS: ReadonlySet<string> = new Set([
  ...KNOWN_SECTION_KEYS,
  'entity',
  'fields',
]);
/** A `table` may derive its columns from an entity schema. The keys are the
 *  same two `record_fields` uses, and deliberately so — one vocabulary for
 *  "these fields of that entity", whichever block is asking. */
const KNOWN_TABLE_SECTION_KEYS: ReadonlySet<string> = new Set([
  ...KNOWN_SECTION_KEYS,
  'entity',
  'fields',
  'edit',
  // D-282 B6 — pick rows, then act on the set. ⛔ The fence is the REASON a new
  // facet has to be added in two places: the block's own rules are useless if
  // the key never reaches them, and a section key that nothing reads is
  // silently ignored rather than refused.
  'select',
  /** The field whose value buckets the rows. NOT a layout directive and not a
   *  new output kind: `OUTPUT_TYPES` members say what the data IS, and "board"
   *  or "kanban" say how it looks. A grouped list is still a list, so this is a
   *  facet of `table` — which also means one vocabulary, one validator, and no
   *  widening of a closed union every consumer has to follow.
   *
   *  ⚠ NOT named anything column-ish: `columns` on a table already means its
   *  FIELDS, while a board's "columns" are its groups. One word, two meanings,
   *  in one descriptor is how a reader a year from now gets it wrong. */
  'group_by',
]);

export const validateOutput = (
  r: Record<string, unknown>,
  declaredStepIds: Set<string>,
  add: AddFn,
): void => {
  if (!r.output || typeof r.output !== 'object' || Array.isArray(r.output)) return;
  const output = r.output as Record<string, unknown>;

  for (const key of Object.keys(output)) {
    if (KNOWN_OUTPUT_KEYS.has(key)) continue;
    add('error', 'output_unknown_key', `output.${key}`,
      `output.${key} is not a field — a recipe's output carries only `
      + `${[...KNOWN_OUTPUT_KEYS].join(' / ')}. It would render NOWHERE. `
      + `Put display sections in output.render (raw step detail = a "json" section).`);
  }

  const hasRender = Object.prototype.hasOwnProperty.call(output, 'render');
  const hasSidebar = Object.prototype.hasOwnProperty.call(output, 'sidebar');
  const hasExchange = Object.prototype.hasOwnProperty.call(output, 'exchange');

  // ── D-232 § 19.3 — a recipe RETURNS or it FIRES ──────────────────────────
  // The alternatives live in ONE block so result-XOR-fire is structural rather
  // than a rule an author must remember. ⛔ The TYPE cannot express it (all three
  // keys are optional), so this is the only place the rule exists — without it
  // "structural" would mean "documented", which is what every other output key
  // in this file's header was before the fence.
  if (hasExchange) {
    // ⚠ NON-EMPTY, not merely present. `parseRecipe` normalizes output in place
    // and every recipe that survives a save/install round-trip may carry a
    // `render: []` it never authored — refusing THAT would refuse a recipe on
    // its second parse having accepted it on the first. An empty render returns
    // nothing, so it does not "return"; what the rule forbids is a recipe that
    // shows the owner something AND answers a peer with the same run.
    const returnsSomething =
      (Array.isArray(output.render) && output.render.length > 0)
      || (Array.isArray(output.sidebar) && output.sidebar.length > 0);
    if (returnsSomething) {
      add('error', 'output_exchange_exclusive', 'output.exchange',
        'a recipe RETURNS (output.render) or it FIRES (output.exchange) — not both. '
        + 'The peer receives the run result and a callback op as two separate things; '
        + 'rendering as well would mean one run owed an answer to two different readers.');
    }
    const exchange = output.exchange;
    if (!exchange || typeof exchange !== 'object' || Array.isArray(exchange)) {
      add('error', 'output_exchange_shape', 'output.exchange',
        'output.exchange must be an object naming at least a `ref`');
      return;
    }
    const ex = exchange as Record<string, unknown>;
    for (const key of Object.keys(ex)) {
      if (KNOWN_EXCHANGE_KEYS.has(key)) continue;
      add('error', 'output_exchange_unknown_key', `output.exchange.${key}`,
        `${key} is not a field on an exchange output — it carries only `
        + `${[...KNOWN_EXCHANGE_KEYS].join(' / ')}. It would be silently dropped, and `
        + 'the far side would receive an answer missing exactly what you meant to say.');
    }
    // ⛔ The ref is the ONLY thing that makes an exchange queryable afterwards,
    // which is the exchange's whole justification over a plain send. A recipe
    // that fires without one leaves the sender with nothing to ask about.
    if (typeof ex.ref !== 'string' || ex.ref.length === 0) {
      add('error', 'output_exchange_ref_required', 'output.exchange.ref',
        'output.exchange.ref is required — it is the correlation the sender asks about later.');
    }
    // ⛔ Without a target there is no fire — the run would reach its whole
    // purpose and fail there. Caught at authoring rather than at the one moment
    // a peer is waiting.
    if (typeof ex.deliver_to !== 'string' || ex.deliver_to.length === 0) {
      add('error', 'output_exchange_deliver_to_required', 'output.exchange.deliver_to',
        'output.exchange.deliver_to is required — it names the tool this message is '
        + 'delivered to. It is NOT callback_op: that is where the far side answers, '
        + 'which is the same string only when you are the one answering.');
    }
    for (const key of ['callback_op', 'connection'] as const) {
      if (ex[key] !== undefined && typeof ex[key] !== 'string') {
        add('error', 'output_exchange_field_shape', `output.exchange.${key}`,
          `output.exchange.${key} must be a string`);
      }
    }
    if (ex.data !== undefined
      && (ex.data === null || typeof ex.data !== 'object' || Array.isArray(ex.data))) {
      add('error', 'output_exchange_field_shape', 'output.exchange.data',
        'output.exchange.data must be an object');
    }
    // An exchange recipe renders nothing by construction, so the
    // render-or-sidebar requirement below does not apply to it.
    if (!hasRender && !hasSidebar) return;
  }

  let sections: unknown[];
  let outputPath: string;

  if (hasRender) {
    if (!Array.isArray(output.render)) {
      add('error', 'output_render_shape', 'output.render',
        'output.render must be an array (use empty array if no result rendering)');
      return;
    }
    sections = output.render;
    outputPath = 'output.render';
    if (hasSidebar) {
      add('warn', 'output_sidebar_ignored', 'output.sidebar',
        'output.sidebar is ignored when output.render is present');
    }
  } else if (hasSidebar) {
    if (!Array.isArray(output.sidebar)) {
      add('error', 'output_sidebar_shape', 'output.sidebar',
        'output.sidebar must be an array when used as a legacy migration alias');
      return;
    }
    sections = output.sidebar;
    outputPath = 'output.sidebar';
  } else {
    add('error', 'output_render_shape', 'output.render',
      'output.render must be an array (use empty array if no result rendering)');
    return;
  }

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    const path = `${outputPath}[${i}]`;
    if (!section || typeof section !== 'object' || Array.isArray(section)) {
      add('error', 'output_section_shape', path, 'output section must be an object');
      continue;
    }
    const s = section as Record<string, unknown>;
    const sectionKeys = s.type === 'filter'
      ? KNOWN_FILTER_SECTION_KEYS
      : s.type === 'record_fields'
        ? KNOWN_RECORD_FIELDS_SECTION_KEYS
        : s.type === 'table'
          ? KNOWN_TABLE_SECTION_KEYS
          : KNOWN_SECTION_KEYS;
    // The section half of the fence — same rule, same reason. `title` was authored 442 times
    // and read by nothing (the display field is `label`); `copy_button: true` on a `text`
    // section was reaching for the `copyable` kind that already existed.
    for (const key of Object.keys(s)) {
      if (sectionKeys.has(key)) continue;
      add('error', 'output_section_unknown_key', `${path}.${key}`,
        `${key} is not a field on an output section — a section carries only `
        + `${[...sectionKeys].join(' / ')}. It would be silently ignored.`
        + (key === 'title' ? ' Use `label`.' : ''));
    }
    if (typeof s.type !== 'string' || !OUTPUT_TYPES.has(s.type as OutputType)) {
      add('error', 'output_section_type_invalid', `${path}.type`,
        `output section type must be one of: ${[...OUTPUT_TYPES].join(', ')}`);
    }
    if (typeof s.source !== 'string' || !s.source) {
      add('error', 'output_section_source_required', `${path}.source`,
        'output section source is required (e.g. "step.risk_checklist")');
      continue;
    }
    // Resolve source: must be "step.X" where X is a declared step id
    const sourceId = parseStepRef(s.source);
    if (sourceId === null) {
      add('error', 'output_source_format', `${path}.source`,
        `output source "${s.source}" must reference a step (e.g. "step.metrics")`);
    } else if (!declaredStepIds.has(sourceId)) {
      add('error', 'output_source_not_a_step', `${path}.source`,
        `output source references "${sourceId}" but no step with that id exists`);
    }

    if (s.type === 'filter') {
      validateFilterOutputSection(s, path, r.variables, add);
    }
    if (s.type === 'record_fields') {
      validateRecordFieldsOutputSection(s, path, add);
    }
    if (s.type === 'table') {
      validateTableOutputSection(s, path, add,
        (r.variables ?? {}) as Record<string, unknown>);
    }
  }
};

/** A `table`'s optional entity binding. `entity` is what makes the block
 *  schema-derived; `fields` without it names columns of nothing, which would
 *  render an empty table rather than say so — hence an install-time refusal.
 *
 *  Same limit as its sibling: whether the entity and its keys EXIST needs the
 *  installed catalog manifest, which this validator cannot see. The resolver
 *  reports that as `unresolved: 'no_schema'`. */
const validateTableOutputSection = (
  section: Record<string, unknown>,
  path: string,
  add: AddFn,
  variables: Record<string, unknown>,
): void => {
  const hasEntity = typeof section.entity === 'string' && section.entity.trim().length > 0;
  if (section.entity !== undefined && !hasEntity) {
    add('error', 'table_entity_invalid', `${path}.entity`,
      'table.entity must be the non-empty entity kind whose schema supplies the columns');
  }
  if (section.group_by !== undefined
    && (typeof section.group_by !== 'string' || section.group_by.trim().length === 0)) {
    add('error', 'table_group_by_invalid', `${path}.group_by`,
      'table.group_by must name the row field whose value buckets the rows '
      + '(e.g. "status") — it is a field name, not a layout');
  }
  // ⛔ THE COMBINATION WITH NO DEFINED ANSWER. An editable grid submits its rows
  // as one repeating group bound to `edit.into`; grouping reorders them into
  // buckets, and nothing says which bucket a NEWLY ADDED row belongs to, nor
  // what a `fixed` grid's row identity means once the shown order is no longer
  // the submitted order. Refused at authoring time rather than rendered into a
  // grid whose submission quietly means something other than it looks like.
  if (section.group_by !== undefined && section.edit !== undefined) {
    add('error', 'table_group_by_with_edit', `${path}.group_by`,
      'table.group_by cannot be combined with table.edit — a grouped list is for reading '
      + 'and moving, an editable grid submits one ordered set, and nothing defines which '
      + 'group a row added to the grid would join');
  }
  if (section.fields !== undefined && !hasEntity) {
    add('error', 'table_fields_without_entity', `${path}.fields`,
      'table.fields names columns of an entity, so it requires table.entity — '
      + 'a hand-written table carries its columns on the to_table step instead');
  }
  // The editable grid — a repeating group. `into` names the variable the rows
  // submit as, and it must be DECLARED: that declaration is the argument
  // boundary the server bounds the submission against.
  if (section.edit !== undefined) {
    const edit = section.edit as Record<string, unknown> | null;
    if (edit === null || typeof edit !== 'object' || Array.isArray(edit)) {
      add('error', 'table_edit_shape', `${path}.edit`, 'table.edit must be an object');
    } else {
      // ⛔ No entity is fine — the grid collects values and the receiving
      // recipe decides what they mean. But then nothing can DERIVE which cells
      // are typeable, so the author must name them: without `columns` the grid
      // would render read-only and look broken.
      if (!hasEntity
        && (!Array.isArray(edit.columns) || (edit.columns as unknown[]).length === 0)) {
        add('error', 'table_edit_columns_required', `${path}.edit.columns`,
          'a table.edit without table.entity must name its editable columns — '
          + 'with no schema to derive them from, nothing else says which cells accept typing');
      }
      // ⛔⛔ The combination that cannot work. A `fixed` grid CORRECTS rows that
      // already exist, so its submission has to say which row each one is — and
      // that identity comes from the shown-but-not-editable columns, which only
      // an entity can resolve. Without one the carried set is necessarily empty,
      // every row submits as bare edited values, and the receiving recipe writes
      // them against nothing. That failure is silent where it matters: a write
      // inside a `foreach` refuses per item, which never fails the run, so the
      // recipe reports success having done nothing. Composing NEW rows
      // (`add_remove`) is fine without an entity — a new row has no identity to
      // carry yet.
      if (!hasEntity && edit.rows === 'fixed') {
        add('error', 'table_edit_fixed_without_entity', `${path}.edit.rows`,
          "a 'fixed' table.edit corrects rows that already exist, so it needs "
          + 'table.entity — without one nothing resolves the shown columns that carry '
          + 'each row\'s identity, and the submission cannot say which row it is');
      }
      if (typeof edit.into !== 'string' || edit.into.trim().length === 0) {
        add('error', 'table_edit_shape', `${path}.edit.into`,
          'table.edit.into must name the variable the collected rows submit as');
      } else if (!Object.prototype.hasOwnProperty.call(variables, edit.into)) {
        add('error', 'table_edit_into_undeclared', `${path}.edit.into`,
          `table.edit.into names '${edit.into}', which this recipe does not declare — `
          + 'the variable IS the argument boundary the submission is bounded by');
      }
      if (typeof edit.submit !== 'string' || edit.submit.trim().length === 0) {
        add('error', 'table_edit_shape', `${path}.edit.submit`,
          'table.edit.submit must be a non-empty button label');
      }
      // `hidden` rides run-level values back with the rows. Each name is an
      // argument the server will admit, so it gets exactly the rule `into` gets.
      if (edit.hidden !== undefined) {
        if (!Array.isArray(edit.hidden)
          || edit.hidden.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
          add('error', 'table_edit_shape', `${path}.edit.hidden`,
            'table.edit.hidden must be an array of declared variable names');
        } else {
          const seen = new Set<string>();
          for (const key of edit.hidden as string[]) {
            if (!Object.prototype.hasOwnProperty.call(variables, key)) {
              add('error', 'table_edit_hidden_undeclared', `${path}.edit.hidden`,
                `table.edit.hidden names '${key}', which this recipe does not declare — `
                + 'the variable IS the argument boundary the submission is bounded by');
            }
            // ⛔ The rows key is not a run setting. Listing it would send a
            // snapshot of the rows alongside the rows themselves — one of the
            // two must lose, and which one is an ordering accident.
            if (key === edit.into) {
              add('error', 'table_edit_shape', `${path}.edit.hidden`,
                `table.edit.hidden names '${key}', which is already the rows variable`);
            }
            if (seen.has(key)) {
              add('error', 'table_edit_shape', `${path}.edit.hidden`,
                `table.edit.hidden lists '${key}' twice`);
            }
            seen.add(key);
          }
        }
      }
      if (edit.rows !== undefined && edit.rows !== 'fixed' && edit.rows !== 'add_remove') {
        add('error', 'table_edit_shape', `${path}.edit.rows`,
          "table.edit.rows must be 'fixed' or 'add_remove' when present");
      }
      if (edit.columns !== undefined) {
        if (!Array.isArray(edit.columns)
          || edit.columns.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
          add('error', 'table_edit_shape', `${path}.edit.columns`,
            'table.edit.columns must be an array of non-empty column keys');
        } else if (hasEntity && Array.isArray(section.fields)) {
          // A typeable column the table does not SHOW is a cell with nowhere to
          // appear — and an author who meant to widen the grid would see
          // nothing happen. An AUTHORED column counts as shown by its `field`:
          // a joined column the recipe appended is exactly the kind of cell a
          // collection sheet exists to be typed into.
          const shown = new Set((section.fields as unknown[]).map((entry) =>
            typeof entry === 'string'
              ? entry
              : String((entry as Record<string, unknown> | null)?.field ?? '')));
          for (const key of edit.columns as string[]) {
            if (!shown.has(key)) {
              add('error', 'table_edit_column_unshown', `${path}.edit.columns`,
                `table.edit.columns names '${key}', which table.fields does not show`);
            }
          }
        }
      }
      // ⛔ A picker scope must name an EDITABLE column, or it reads as a
      // narrowed chooser in the recipe and offers everything at the keyboard.
      if (edit.scopes !== undefined) {
        const scopes = edit.scopes as unknown;
        if (scopes === null || typeof scopes !== 'object' || Array.isArray(scopes)) {
          add('error', 'table_edit_shape', `${path}.edit.scopes`,
            'table.edit.scopes must be an object of { column: { field: value } }');
        } else {
          const editable = new Set(
            Array.isArray(edit.columns) ? edit.columns as string[] : []);
          for (const [column, filter] of Object.entries(scopes as Record<string, unknown>)) {
            if (editable.size > 0 && !editable.has(column)) {
              add('error', 'table_edit_shape', `${path}.edit.scopes.${column}`,
                `'${column}' is scoped but not editable — a scope on a read-only cell is a filter nobody applies`);
            }
            if (filter === null || typeof filter !== 'object' || Array.isArray(filter)
              || Object.keys(filter as Record<string, unknown>).length === 0) {
              add('error', 'table_edit_shape', `${path}.edit.scopes.${column}`,
                'a scope must name at least one { field: value }');
              continue;
            }
            for (const [field, value] of Object.entries(filter as Record<string, unknown>)) {
              // ⚠ Strings only — a number compared against a stored field is an
              // equality that never matches, so the picker offers NOTHING
              // rather than everything, which is the harder failure to spot.
              if (typeof value !== 'string' || value.length === 0) {
                add('error', 'table_edit_shape', `${path}.edit.scopes.${column}.${field}`,
                  'a scope value must be a non-empty string');
              }
            }
          }
        }
      }
      for (const key of Object.keys(edit)) {
        if (['into', 'submit', 'rows', 'columns', 'hidden', 'scopes'].includes(key)) continue;
        add('error', 'table_edit_shape', `${path}.edit.${key}`,
          `table.edit has no field '${key}' — nothing reads it`);
      }
    }
  }

  // D-282 B6 — the selectable table. `into` names the variable the chosen row
  // IDS submit to, and gets exactly the rule `edit.into` gets, for exactly its
  // reason: the declaration IS the argument boundary the server bounds the
  // submission against.
  if (section.select !== undefined) {
    const select = section.select as Record<string, unknown> | null;
    if (select === null || typeof select !== 'object' || Array.isArray(select)) {
      add('error', 'table_select_shape', `${path}.select`, 'table.select must be an object');
    } else {
      // ⛔⛔ REFUSED WITH `edit`, AND NOT FOR `group_by`'s REASON. Two submit
      // buttons over one row set is ambiguous on its face, and an `add_remove`
      // grid's new row has no id to be selected by — so "the rows I ticked" and
      // "the rows I typed into" would be two different sets under one control.
      // ⚠ `group_by` is deliberately NOT refused here: grouping reorders rows
      // and selection creates none.
      if (section.edit !== undefined) {
        add('error', 'table_select_with_edit', `${path}.select`,
          'table.select cannot be combined with table.edit — one row set cannot carry two '
          + 'submissions, and a row added to an editable grid has no id to be selected by');
      }
      if (typeof select.into !== 'string' || select.into.trim().length === 0) {
        add('error', 'table_select_shape', `${path}.select.into`,
          'table.select.into must name the variable the chosen row ids submit as');
      } else if (!Object.prototype.hasOwnProperty.call(variables, select.into)) {
        add('error', 'table_select_into_undeclared', `${path}.select.into`,
          `table.select.into names '${select.into}', which this recipe does not declare — `
          + 'the variable IS the argument boundary the submission is bounded by');
      } else {
        // ⛔ A SELECTION IS ALWAYS AN ARRAY, even of one. A variable declared
        // `string` receives `["job_1"]` and the recipe reads it as a value it
        // can interpolate — which resolves to something, so the run SUCCEEDS
        // having acted on a stringified list. Only flagged when the declaration
        // states a type: a shorthand value is its own default and says nothing
        // about shape.
        const declared = (variables as Record<string, unknown>)[select.into];
        const declaredType = declared !== null
          && typeof declared === 'object'
          && !Array.isArray(declared)
          ? (declared as Record<string, unknown>).type
          : undefined;
        if (typeof declaredType === 'string' && declaredType !== 'array') {
          add('error', 'table_select_into_not_array', `${path}.select.into`,
            `table.select.into names '${select.into}', declared as '${declaredType}' — a `
            + "selection submits an ARRAY of ids, so the variable must be type 'array'");
        }
      }
      if (typeof select.submit !== 'string' || select.submit.trim().length === 0) {
        add('error', 'table_select_shape', `${path}.select.submit`,
          'table.select.submit must be a non-empty action label ("Mark paid")');
      }
      if (select.id_field !== undefined
        && (typeof select.id_field !== 'string' || select.id_field.trim().length === 0)) {
        add('error', 'table_select_shape', `${path}.select.id_field`,
          'table.select.id_field must name the row field carrying the id');
      }
      // ⛔ Without an entity nothing resolves which field IS the row. Guessing
      // would submit whichever column looked id-shaped — the foreign-key-as-
      // identity failure that shipped Open controls pointing at another record.
      if (!hasEntity
        && (typeof select.id_field !== 'string' || select.id_field.trim().length === 0)) {
        add('error', 'table_select_id_field_required', `${path}.select.id_field`,
          'a table.select without table.entity must name its id_field — with no schema to '
          + 'resolve the identity column, nothing else says which field IS the row');
      }
      if (select.hidden !== undefined) {
        if (!Array.isArray(select.hidden)
          || select.hidden.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
          add('error', 'table_select_shape', `${path}.select.hidden`,
            'table.select.hidden must be an array of declared variable names');
        } else {
          const seen = new Set<string>();
          for (const key of select.hidden as string[]) {
            if (!Object.prototype.hasOwnProperty.call(variables, key)) {
              add('error', 'table_select_hidden_undeclared', `${path}.select.hidden`,
                `table.select.hidden names '${key}', which this recipe does not declare — `
                + 'the variable IS the argument boundary the submission is bounded by');
            }
            if (key === select.into) {
              add('error', 'table_select_shape', `${path}.select.hidden`,
                `table.select.hidden names '${key}', which is already the selection variable`);
            }
            if (seen.has(key)) {
              add('error', 'table_select_shape', `${path}.select.hidden`,
                `table.select.hidden lists '${key}' twice`);
            }
            seen.add(key);
          }
        }
      }
      for (const key of Object.keys(select)) {
        if (['into', 'submit', 'id_field', 'hidden'].includes(key)) continue;
        add('error', 'table_select_shape', `${path}.select.${key}`,
          `table.select has no field '${key}' — nothing reads it`);
      }
    }
  }

  if (section.fields === undefined) return;
  if (!Array.isArray(section.fields)) {
    add('error', 'table_shape', `${path}.fields`,
      'table.fields must be an array of entity field keys (omit it for every declared field)');
    return;
  }
  const seen = new Set<string>();
  section.fields.forEach((entry, index) => {
    const key = tableFieldKey(entry, `${path}.fields[${index}]`, add);
    if (key === null) return;
    if (seen.has(key)) {
      add('error', 'table_duplicate', `${path}.fields[${index}]`,
        `table.fields lists '${key}' twice — one column cannot appear at two positions`);
    }
    seen.add(key);
  });
};

/** One `table.fields` entry — a schema field key, or an authored column that
 *  brings its own label and type. Returns the column key, or null once it has
 *  reported why the entry is not one.
 *
 *  An authored entry is how a recipe extends the entity's model (a joined
 *  column the schema has no slot for) and how it overrides presentation (a
 *  different caption, a picker instead of a text box) WITHOUT the pack bumping
 *  a version — so this validates the shape and says nothing about whether the
 *  key exists, which only the installed catalog knows. */
const tableFieldKey = (
  entry: unknown,
  path: string,
  add: AddFn,
): string | null => {
  if (typeof entry === 'string') {
    if (entry.trim().length === 0) {
      add('error', 'table_shape', path,
        'table.fields entries must be non-empty entity field keys');
      return null;
    }
    return entry;
  }
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    add('error', 'table_shape', path,
      'table.fields entries must be an entity field key, or an authored column '
      + '{ field, label, kind?, control?, options? }');
    return null;
  }
  const column = entry as Record<string, unknown>;
  let ok = true;
  if (typeof column.field !== 'string' || column.field.trim().length === 0) {
    add('error', 'table_shape', `${path}.field`,
      'an authored table column needs `field` — the key it reads on each row');
    ok = false;
  }
  // ⛔ Required, and not derived. An authored column has no schema to take a
  // label from, and title-casing the key silently is how a joined column ends
  // up captioned by its variable name.
  if (typeof column.label !== 'string' || column.label.trim().length === 0) {
    add('error', 'table_shape', `${path}.label`,
      'an authored table column needs `label` — there is no schema to derive one from');
    ok = false;
  }
  if (column.kind !== undefined
    && (typeof column.kind !== 'string' || column.kind.trim().length === 0)) {
    add('error', 'table_shape', `${path}.kind`,
      'table column `kind` must be a non-empty type name (omit it to keep the schema\'s)');
    ok = false;
  }
  if (column.control !== undefined
    && !TABLE_COLUMN_CONTROLS.has(column.control as TableColumnControl)) {
    add('error', 'table_shape', `${path}.control`,
      `table column \`control\` must be one of: ${[...TABLE_COLUMN_CONTROLS].join(' / ')}`);
    ok = false;
  }
  if (column.options !== undefined
    && (!Array.isArray(column.options)
      || column.options.some((o) => typeof o !== 'string' || o.trim() === ''))) {
    add('error', 'table_shape', `${path}.options`,
      'table column `options` must be an array of non-empty choices');
    ok = false;
  }
  // A picker with nothing to pick renders an empty box the owner cannot use —
  // and looks like a bug in the grid rather than an omission in the recipe.
  if ((column.control === 'select' || column.control === 'radio')
    && (!Array.isArray(column.options) || column.options.length === 0)) {
    add('error', 'table_shape', `${path}.options`,
      `a '${String(column.control)}' column needs \`options\` — with none it renders `
      + 'a control the owner cannot use');
    ok = false;
  }
  if (column.options !== undefined && column.control === undefined) {
    add('error', 'table_shape', `${path}.control`,
      'table column `options` needs `control: \'select\' | \'radio\'` — on a text '
      + 'column nothing reads them');
    ok = false;
  }
  for (const key of Object.keys(column)) {
    if (['field', 'label', 'kind', 'control', 'options'].includes(key)) continue;
    add('error', 'table_shape', `${path}.${key}`,
      `an authored table column has no field '${key}' — nothing reads it`);
    ok = false;
  }
  return ok ? (column.field as string) : null;
};

/** Shape of the schema-bound field list. Install-time like the filter's, and
 *  for the same reason: an author who misspells `entity` or a field key must
 *  learn it while they are looking at the recipe, not from a block that
 *  renders one blank row per typo at run time.
 *
 *  What is NOT checked here: whether the entity and its fields actually exist
 *  in the pack's schema. That needs the installed catalog manifest, which the
 *  recipe validator has no access to — it validates one recipe body. The
 *  resolver reports it as `unresolved: 'no_schema'` instead. */
const validateRecordFieldsOutputSection = (
  section: Record<string, unknown>,
  path: string,
  add: AddFn,
): void => {
  if (typeof section.entity !== 'string' || section.entity.trim().length === 0) {
    add('error', 'record_fields_entity_invalid', `${path}.entity`,
      'record_fields.entity must be the non-empty entity kind whose schema resolves the display');
  }
  if (section.fields === undefined) return; // omitted = every declared field
  if (!Array.isArray(section.fields)) {
    add('error', 'record_fields_shape', `${path}.fields`,
      'record_fields.fields must be an array of entity field keys (omit it to show every declared field)');
    return;
  }
  const seen = new Set<string>();
  section.fields.forEach((entry, index) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      add('error', 'record_fields_shape', `${path}.fields[${index}]`,
        'record_fields.fields entries must be non-empty entity field keys');
      return;
    }
    if (seen.has(entry)) {
      add('error', 'record_fields_duplicate', `${path}.fields[${index}]`,
        `record_fields.fields lists "${entry}" more than once`);
      return;
    }
    seen.add(entry);
  });
};

/** D-222 Slices 1/2 — filter shape and eligibility. This is deliberately
 *  install-time: overlap, credential echo, or a field without authored label
 *  never reaches a renderer where DOM ordering or synthesized copy could make
 *  the decision for us. */
const validateFilterOutputSection = (
  section: Record<string, unknown>,
  path: string,
  rawVariables: unknown,
  add: AddFn,
): void => {
  const variables = rawVariables !== null
    && typeof rawVariables === 'object'
    && !Array.isArray(rawVariables)
    ? rawVariables as Record<string, unknown>
    : {};

  const readKeys = (field: 'fields' | 'hidden'): string[] | null => {
    const value = section[field];
    if (!Array.isArray(value)) {
      add('error', `filter_${field}_shape`, `${path}.${field}`,
        `filter.${field} must be an array of declared variable keys`);
      return null;
    }
    const keys: string[] = [];
    const seen = new Set<string>();
    value.forEach((entry, index) => {
      if (typeof entry !== 'string' || entry.trim().length === 0) {
        add('error', `filter_${field}_shape`, `${path}.${field}[${index}]`,
          `filter.${field} entries must be non-empty strings`);
        return;
      }
      if (seen.has(entry)) {
        add('error', 'filter_variable_duplicate', `${path}.${field}[${index}]`,
          `filter.${field} lists "${entry}" more than once`);
        return;
      }
      seen.add(entry);
      keys.push(entry);
    });
    return keys;
  };

  const fields = readKeys('fields');
  const hidden = readKeys('hidden');
  if (typeof section.submit !== 'string' || section.submit.trim().length === 0) {
    add('error', 'filter_submit_invalid', `${path}.submit`,
      'filter.submit must be a non-empty display string');
  }

  if (fields !== null && hidden !== null) {
    const fieldSet = new Set(fields);
    for (const key of hidden) {
      if (!fieldSet.has(key)) continue;
      add('error', 'filter_fields_hidden_overlap', `${path}.hidden`,
        `filter variable "${key}" cannot be both visible and hidden`);
    }
  }

  const declared = (key: string, field: 'fields' | 'hidden'): unknown => {
    if (!Object.prototype.hasOwnProperty.call(variables, key)) {
      add('error', 'filter_variable_undeclared', `${path}.${field}`,
        `filter.${field} names "${key}", which is absent from recipe.variables`);
      return undefined;
    }
    return variables[key];
  };

  for (const key of fields ?? []) {
    const def = declared(key, 'fields');
    if (def === undefined) continue;
    const hint = def !== null && typeof def === 'object' && !Array.isArray(def)
      ? def as Record<string, unknown>
      : null;
    if (hint === null
        || typeof hint.label !== 'string' || hint.label.trim().length === 0
        || typeof hint.type !== 'string' || hint.type.trim().length === 0) {
      add('error', 'filter_field_not_labeled', `${path}.fields`,
        `filter field "${key}" must name a valid labeled ValueHint`);
      continue;
    }
    if (hint.type === 'secret' || hint.type === 'oauth') {
      add('error', 'filter_field_credential_ineligible', `${path}.fields`,
        `filter field "${key}" has credential type "${hint.type}" and cannot be rendered`);
    }
  }

  for (const key of hidden ?? []) {
    const def = declared(key, 'hidden');
    if (def === undefined) continue;
    const type = def !== null && typeof def === 'object' && !Array.isArray(def)
      ? (def as Record<string, unknown>).type
      : undefined;
    if (type === 'secret' || type === 'oauth') {
      add('error', 'filter_hidden_credential_ineligible', `${path}.hidden`,
        `filter hidden variable "${key}" has credential type "${type}" and cannot be echoed into output`);
    }
  }
};

/** D-292 — `metadata.spreadsheet_import`: the recipe says it imports a
 *  spreadsheet, so a surface may guide the owner through upload → match
 *  columns → check → import. The shape and every cross-check live in
 *  `@recued/contracts` (`spreadsheetImportProblems`) because the webclient asks
 *  the SAME question before offering the flow — a server older than D-292
 *  stores this block unvalidated (metadata keys are open), so the client cannot
 *  trust that a stored recipe was ever checked. One function, two callers, no
 *  second copy to drift.
 *
 *  ⛔ EVERY PROBLEM IS AN ERROR. The worst one — `preview` not reaching the
 *  import's `dry_run` — makes the surface's Check button a real import. The
 *  others make it offer a column picker that changes nothing, or put an upload
 *  into a variable nothing reads. None of those is a degraded-but-working
 *  recipe; each is a screen that lies. Absent is legal and unchecked. */
export const validateSpreadsheetImport = (
  r: Record<string, unknown>,
  add: AddFn,
): void => {
  for (const problem of spreadsheetImportProblems(r)) {
    add('error', problem.code, problem.path, problem.detail);
  }
};

/** D-302 — `metadata.retired_variables`: variables an earlier version declared
 *  and this one dropped, whose saved values are dropped before a run instead of
 *  refused (`withoutRetiredConfig`). Absent is legal.
 *
 *  ⛔ A RETIRED NAME CANNOT ALSO BE DECLARED: the run would drop the value the
 *  recipe reads. A `{{config.<retired>}}` reference is already refused as
 *  `undeclared_variable_ref`, since a retired name is by definition undeclared. */
export const validateRetiredVariables = (
  r: Record<string, unknown>,
  add: AddFn,
): void => {
  if (!r.metadata || typeof r.metadata !== 'object' || Array.isArray(r.metadata)) return;
  const list = (r.metadata as Record<string, unknown>).retired_variables;
  if (list === undefined) return;
  const path = 'metadata.retired_variables';
  if (!Array.isArray(list)) {
    add('error', 'retired_variables_shape', path, 'retired_variables must be an array of variable names');
    return;
  }
  const variables = r.variables !== null && typeof r.variables === 'object' && !Array.isArray(r.variables)
    ? r.variables as Record<string, unknown> : {};
  const seen = new Set<string>();
  list.forEach((name, index) => {
    if (typeof name !== 'string' || name === '') {
      add('error', 'retired_variables_shape', `${path}[${index}]`, 'must name a variable');
      return;
    }
    if (seen.has(name)) add('error', 'retired_variables_shape', `${path}[${index}]`, `'${name}' is listed twice`);
    seen.add(name);
    if (Object.prototype.hasOwnProperty.call(variables, name)) {
      add('error', 'retired_variable_declared', `${path}[${index}]`,
        `'${name}' is retired but still declared in variables: a run would drop the value the recipe reads`);
    }
  });
};

/** `metadata.retired_carries`: what a retired variable's saved value still means for
 *  the variables that replaced it (`carriedFromRetired`, contracts). Absent is legal.
 *
 *  A carry is a claim about the recipe's own variables, so it is checked against
 *  them. The `variable` must be retired, or there is nothing to carry from. Each `set`
 *  name must be declared, or the run would add a key the D-222 boundary refuses. An
 *  enum's value must be one of its options, or the owner's form shows the first
 *  option instead. */
export const validateRetiredCarries = (
  r: Record<string, unknown>,
  add: AddFn,
): void => {
  if (!r.metadata || typeof r.metadata !== 'object' || Array.isArray(r.metadata)) return;
  const metadata = r.metadata as Record<string, unknown>;
  const list = metadata.retired_carries;
  if (list === undefined) return;
  const path = 'metadata.retired_carries';
  if (!Array.isArray(list)) {
    add('error', 'retired_carries_shape', path, 'retired_carries must be an array of { variable, when, set }');
    return;
  }
  const retired = Array.isArray(metadata.retired_variables) ? metadata.retired_variables : [];
  const variables = r.variables !== null && typeof r.variables === 'object' && !Array.isArray(r.variables)
    ? r.variables as Record<string, unknown> : {};
  list.forEach((carry, index) => {
    const at = `${path}[${index}]`;
    if (carry === null || typeof carry !== 'object' || Array.isArray(carry)) {
      add('error', 'retired_carries_shape', at, 'must be { variable, when, set }');
      return;
    }
    const { variable, when, set } = carry as Record<string, unknown>;
    if (typeof variable !== 'string' || typeof when !== 'string'
      || set === null || typeof set !== 'object' || Array.isArray(set) || Object.keys(set).length === 0) {
      add('error', 'retired_carries_shape', at,
        'must be { variable, when, set }: two strings, and at least one variable to set');
      return;
    }
    if (!retired.includes(variable)) {
      add('error', 'retired_carry_invalid', `${at}.variable`,
        `'${variable}' is not in retired_variables, so no run drops a value to carry from`);
    }
    for (const [name, value] of Object.entries(set as Record<string, unknown>)) {
      if (typeof value !== 'string') {
        add('error', 'retired_carries_shape', `${at}.set.${name}`, 'must be a string');
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(variables, name)) {
        add('error', 'retired_carry_invalid', `${at}.set.${name}`,
          `'${name}' is not a declared variable, so the run would refuse the value it sets`);
        continue;
      }
      const hint = variables[name];
      const options = hint !== null && typeof hint === 'object' && !Array.isArray(hint)
        && (hint as { type?: unknown }).type === 'enum' ? (hint as { options?: unknown }).options : undefined;
      if (Array.isArray(options) && !options.some((option) => String(option) === value)) {
        add('error', 'retired_carry_invalid', `${at}.set.${name}`, `'${value}' is not one of ${name}'s options`);
      }
    }
  });
};

/** D-220 Slice A1 — `metadata.requires_form_fields` shape + the static
 *  cross-check that makes it a contract rather than a comment.
 *
 *  A recipe consuming an accepted Reception submission reads named answers by
 *  STATIC path (`{{step.<reader>.record.values.<name>}}`) — dynamic indexing
 *  raises `nested_template` — so the field names are a hard contract with
 *  whatever form the owner pairs it to. Declaring them here lets the wiring
 *  surfaces (Slice A2: pair-bind / "Automate this form") refuse a mismatched
 *  form while the OWNER is present, instead of at fire, where a misspelled
 *  field resolves `undefined`, a `default` fallback covers for it, and the run
 *  reports success having stored nothing.
 *
 *  This function enforces BOTH directions of the claim, because a declaration
 *  that is merely *present* would be a second place to write a comment:
 *
 *    - `requires_form_fields_unread` (warn) — declared, but no ref reads it.
 *      Warn, not error: an author may legitimately declare a field the form
 *      must collect for the OWNER's benefit (it lands in the sealed response
 *      and on the Inbox review card) without the recipe reading it.
 *    - `requires_form_fields_undeclared` (error) — a ref reads it and nothing
 *      declares it. This is the defect the slice exists to close, so it blocks.
 *      Only checked when the field is PRESENT: an absent declaration is the
 *      pre-D-220 undeclared recipe, legal and unchecked. `[]` is a positive
 *      claim and IS checked — which is what makes the seller-opener shape
 *      ("reads no named answers") provable rather than merely asserted. */
export const validateRequiresFormFields = (
  r: Record<string, unknown>,
  add: AddFn,
): void => {
  const metadataOk = !!r.metadata && typeof r.metadata === 'object' && !Array.isArray(r.metadata);
  const metadata = metadataOk ? (r.metadata as Record<string, unknown>) : null;
  const declared = metadata === null ? undefined : metadata.requires_form_fields;
  const read = collectFormValueRefs(r);
  // ⚠ A whole-object read (`record.values` / `record`, no field after it) takes
  // EVERY visitor answer while naming none, so the named-field scan above sees
  // nothing. Found by adversarial review: a `[]` declaration then validated as
  // accurate while the recipe consumed the lot via `json_stringify`. A
  // declaration cannot enumerate what a whole-object read takes, so any
  // declaration at all is incompatible with one.
  const wholeReads = collectWholeFormRecordRefs(r);

  if (declared === undefined) {
    // Undeclared recipe. Nudge only when it actually reads named answers —
    // there is a contract here and nothing is checking it.
    if (wholeReads.length > 0) {
      add('warn', 'requires_form_fields_absent', 'metadata.requires_form_fields',
        `recipe reads the WHOLE submitted-answer object (${wholeReads.join(', ')}) and declares nothing — `
          + 'every visitor field reaches this recipe and no gate can check it against a form');
      return;
    }
    if (read.length > 0) {
      add('info', 'requires_form_fields_absent', 'metadata.requires_form_fields',
        `recipe reads ${read.length} named form answer(s) (${read.join(', ')}) by static path but declares none — `
          + 'add metadata.requires_form_fields so a mismatched form is refused at pairing rather than storing nothing at fire');
    }
    return;
  }

  for (const failure of validateRecipeFormFields(declared)) {
    add('error', failure.code, 'metadata.requires_form_fields', failure.detail);
  }
  if (wholeReads.length > 0) {
    add('error', 'requires_form_fields_whole_object_read', 'metadata.requires_form_fields',
      `recipe reads the whole submitted-answer object (${wholeReads.join(', ')}), which takes every `
        + 'visitor field while naming none — a declaration cannot enumerate that. Read the answers '
        + 'you need by name, or drop metadata.requires_form_fields and accept that nothing checks '
        + 'this recipe against its form');
  }
  if (!Array.isArray(declared)) return;

  const declaredNames = new Set<string>();
  for (const entry of declared) {
    if (
      !!entry && typeof entry === 'object' && !Array.isArray(entry)
      && typeof (entry as Record<string, unknown>).name === 'string'
    ) {
      declaredNames.add((entry as Record<string, unknown>).name as string);
    }
  }

  for (const name of read) {
    if (!declaredNames.has(name)) {
      add('error', 'requires_form_fields_undeclared', 'metadata.requires_form_fields',
        `recipe reads record.values.${name} but does not declare it — add it to metadata.requires_form_fields `
          + 'or the pairing check cannot know the form must collect it');
    }
  }
  const readNames = new Set(read);
  for (const name of declaredNames) {
    if (!readNames.has(name)) {
      add('warn', 'requires_form_fields_unread', 'metadata.requires_form_fields',
        `metadata.requires_form_fields declares '${name}' but no step reads record.values.${name} — `
          + 'drop it, or keep it if the form must collect it for the owner rather than for this recipe');
    }
  }
};
