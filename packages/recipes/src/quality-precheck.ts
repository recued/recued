/** Quality precheck — deterministic recipe quality checks.
 *
 *  JS port of recipe-research-dev/manual/quality_check.py's
 *  quality_precheck(). Runs without I/O — pure function on a
 *  recipe JSON object. Used by:
 *    - Chat Tier 2 (show warnings in UI after AI generation)
 *    - Marketplace quality gate (automated review pipeline)
 *    - Kitchen editor (real-time feedback while editing)
 *
 *  Severity tiers:
 *    'info'     — observation, no risk, can pass as-is
 *    'review'   — correctness/security concern, needs attention
 *    'critical' — runtime-breaking, will be auto-rejected
 */

export interface QualityFinding {
  severity: 'info' | 'review' | 'critical';
  check: string;
  detail: string;
}

const PLACEHOLDER_IDS = new Set([
  'step1', 'step2', 'step3', 'step_1', 'step_2', 'step_3',
  'fetch', 'data', 'result', 'output', 'temp', 'tmp', 'test',
  'foo', 'bar', 'baz', 'x', 'y', 'z',
]);

const AUTHOR_PLACEHOLDERS = new Set([
  '', 'todo', 'author', 'your-name', 'your_name', 'name', 'test', 'example',
]);

const KNOWN_PLATFORMS = new Set([
  'hubspot', 'salesforce', 'pipedrive', 'zendesk', 'gmail', 'outlook', 'intercom', 'freshdesk',
]);

const VALID_MODEL_HINTS = new Set(['fast', 'quality', 'thinking']);

const CURRENCY_HINTS = new Set(['amount', 'price', 'revenue', 'cost', 'value', 'pipeline', 'total', 'arr', 'mrr']);
const DATE_HINTS = new Set(['date', 'created_at', 'updated_at', 'close_date', 'start_date', 'end_date', 'timestamp']);
// D-167 P4 — field-name roots that read as aliasable PII (the EntityFieldPrivacy
// kinds pii-protect handles; `content` is omitted — free text has no field-name
// signature). Mirrors PII_FIELD_HINTS in validate/constants.ts; kept local so
// this Python-port stays self-contained, like CURRENCY_HINTS / DATE_HINTS.
const PII_HINTS = new Set([
  'email', 'name', 'phone', 'mobile', 'fax', 'address',
  'org', 'organization', 'company', 'url', 'website',
  'account_id', 'external_id',
]);
// D-167 P4 — the 9-kind EntityFieldPrivacy enum (mirrors ENTITY_FIELD_PRIVACY_KINDS
// in @recued/contracts; kept local so this Python-port stays import-free). A
// pii-protect field tag whose kind is outside this set is silently dropped.
const PRIVACY_KINDS = new Set([
  'email', 'name', 'org', 'phone', 'address', 'url', 'external_id', 'account_id', 'content',
]);

type R = Record<string, unknown>;

/** Run all deterministic quality checks on a recipe. Pure, no I/O. */
export const qualityPrecheck = (recipe: R): QualityFinding[] => {
  const findings: QualityFinding[] = [];
  const find = (severity: QualityFinding['severity'], check: string, detail: string) => {
    findings.push({ severity, check, detail });
  };

  const prefetch = arr(recipe.prefetch_steps);
  const steps = arr(recipe.steps);
  const variables = obj(recipe.variables);
  const meta = obj(recipe.metadata);
  const sidebar = arr(obj(recipe.output).sidebar);
  const recipeJson = JSON.stringify(recipe);

  const prefetchIds = new Set(prefetch.map((s) => str(s.id)).filter(Boolean));
  const stepIds = steps.map((s) => str(s.id)).filter(Boolean);
  const allStepIds = new Set([...prefetchIds, ...stepIds]);

  // AI step indices
  const aiStepIndices: number[] = [];
  for (let i = 0; i < steps.length; i++) {
    if (stripCore(str(steps[i].ingredient)).startsWith('ai-')) aiStepIndices.push(i);
  }

  // ── Empty / degenerate recipe ──
  // A recipe with no work at all does nothing — auto-reject at the publish gate.
  // Structure-only: 0 runtime results from a populated recipe is legitimate (e.g.
  // a search that matched nothing), so this fires on the AUTHORED shape, never on
  // runtime output. Counts all three step phases so a reactive recipe carrying
  // only `trigger_steps` (the gate) isn't false-flagged.
  if (prefetch.length === 0 && steps.length === 0 && arr(recipe.trigger_steps).length === 0) {
    find('critical', 'empty_recipe',
      'recipe has no prefetch_steps, steps, or trigger_steps — it performs no work');
  }

  // ── Orphan prefetch ──
  const downstreamJson = JSON.stringify(steps) + JSON.stringify(recipe.output ?? {});
  for (const pid of prefetchIds) {
    if (!downstreamJson.includes(`step.${pid}`)) {
      find('info', 'orphan_prefetch', `prefetch '${pid}' output is never referenced by any step or output`);
    }
  }

  // ── Orphan sequential steps ──
  for (let i = 0; i < steps.length; i++) {
    const sid = str(steps[i].id);
    if (!sid || steps[i].guard !== undefined) continue;
    const remaining = JSON.stringify(steps.slice(i + 1)) + JSON.stringify(recipe.output ?? {});
    if (!remaining.includes(`step.${sid}`)) {
      find('info', 'orphan_step', `step '${sid}' output is not referenced downstream or in output`);
    }
  }

  // ── Vault leak ──
  for (const step of steps) {
    if (JSON.stringify(step).includes('{{vault.') && !step.ingredient) {
      find('critical', 'vault_leak', `step '${str(step.id)}' references vault namespace — only ingredients should`);
    }
  }

  // ── Guard before AI ──
  for (const aiIdx of aiStepIndices) {
    const aiStep = steps[aiIdx];
    const hasSkip = aiStep.skip_when != null;
    const hasPriorGuard = steps.slice(0, aiIdx).some((s) => s.guard != null);
    if (!hasSkip && !hasPriorGuard) {
      find('info', 'no_guard_before_ai', `AI step '${str(aiStep.id)}' has no guard or skip_when — runs even on empty data`);
    }
  }

  // ── Hash/restore pairing ──
  const hasReplace = steps.some((s) => s.transform === 'hash_replace');
  const hasRestore = steps.some((s) => s.transform === 'hash_restore');
  const hasPiiFields = steps.some((s) => Array.isArray(s.pii_fields) && (s.pii_fields as unknown[]).length > 0);
  if (aiStepIndices.length > 0 && !hasReplace && !hasPiiFields) {
    find('info', 'no_hash_before_ai', 'recipe has AI steps but no hash_replace or pii_fields — verify no PII is sent to LLM');
  }
  if (hasReplace && !hasRestore) {
    find('review', 'missing_hash_restore', 'hash_replace used but no hash_restore — output may contain hashed tokens');
  }

  // ── PII alias guidance (D-167 P4) ──
  // Nudge an AI recipe's hash_replace toward pii-protect when the hashed field
  // reads as aliasable PII — the LLM then gets typed aliases it can reason over
  // instead of opaque hash tokens. AI-gated so a stable-pseudonym hash with no
  // LLM round-trip stays quiet. pii-protect without pii-restore stays a review:
  // the engine auto-restores the final output (D-167 Slice 3), but a mid-run
  // egress (notify / durable write) before the run ends still surfaces aliases.
  if (aiStepIndices.length > 0) {
    for (const step of steps) {
      if (step.transform !== 'hash_replace') continue;
      const fields = Array.isArray(step.fields) ? step.fields : [];
      const piiField = fields.find((f): f is string => typeof f === 'string' && fieldLooksLikePii(f));
      if (piiField) {
        find('info', 'prefer_pii_protect',
          `step '${str(step.id)}' hash_replaces '${piiField}', which looks like aliasable PII — consider pii-protect for LLM-readable typed aliases (pii.Person1, m1@d1.invalid) instead of opaque hash tokens`);
      }
    }
  }
  const hasProtect = steps.some((s) => s.transform === 'pii-protect');
  const hasPiiRestore = steps.some((s) => s.transform === 'pii-restore');
  if (hasProtect && !hasPiiRestore) {
    find('review', 'missing_pii_restore', 'pii-protect used but no pii-restore — the engine restores the final output, but alias tokens (pii.Person1, m1@d1.invalid) still reach any mid-run egress (notify, durable write); add pii-restore before those steps');
  }
  // A pii-protect field tag the alias substrate can't honor (not a {path,kind}
  // object, empty path, or kind outside the 9-kind enum) leaves that field
  // un-aliased — its real value reaches the LLM. `critical` (auto-rejected):
  // pii-protect throws on the same condition at run time (D-167 safe-feature
  // rule — fail closed), so a recipe carrying one is runtime-breaking.
  for (const step of steps) {
    if (step.transform !== 'pii-protect') continue;
    const tags = step.fields;
    if (tags === undefined || tags === null) continue; // absent/null → valid no-op (nothing to alias)
    // qualityPrecheck runs standalone (no structural-schema layer behind it, unlike
    // validate/quality.ts), so it owns the shape check too: a present-but-non-array
    // `fields` is exactly what pii-protect throws on at run time.
    if (!Array.isArray(tags)) {
      find('critical', 'pii_protect_bad_field_tag',
        `step '${str(step.id)}' pii-protect 'fields' must be an array of { path, kind } tags — pii-protect rejects this at run time`);
      continue;
    }
    tags.forEach((tag, j) => {
      const problem = piiFieldTagProblem(tag);
      if (problem) {
        find('critical', 'pii_protect_bad_field_tag',
          `step '${str(step.id)}' pii-protect field tag #${j} ${problem} — that field would NOT be aliased and its real value would reach the LLM; pii-protect rejects this at run time, so fix or remove the tag`);
      }
    });
  }

  // ── Division guard ──
  for (const step of steps) {
    if (step.transform !== 'math') continue;
    if ((step.operator ?? step.operation) === 'divide' && step.skip_when == null) {
      find('review', 'unguarded_division', `step '${str(step.id)}' divides without zero guard`);
    }
  }

  // ── TTL floor ──
  const ttl = typeof recipe.ttl === 'number' ? recipe.ttl : 0;
  const hasAi = aiStepIndices.length > 0;
  const minTtl = hasAi ? 300 : 60;
  if (ttl < minTtl) {
    find('info', 'ttl_below_floor', `TTL ${ttl}s below floor ${minTtl}s for ${hasAi ? 'AI' : 'data'} recipes`);
  }

  // ── Placeholder IDs ──
  for (const step of [...prefetch, ...steps]) {
    const sid = str(step.id).toLowerCase();
    if (sid && PLACEHOLDER_IDS.has(sid)) {
      find('info', 'placeholder_id', `step '${str(step.id)}' looks like a placeholder name`);
    }
  }

  // ── Variable reference hygiene ──
  const configRefs = new Set([...recipeJson.matchAll(/\{\{config\.(\w+)/g)].map((m) => m[1]));
  const declaredVars = new Set(Object.keys(variables));
  for (const ref of configRefs) {
    if (!declaredVars.has(ref)) {
      find('critical', 'undeclared_variable_ref', `{{config.${ref}}} referenced but not declared in variables`);
    }
  }
  for (const v of declaredVars) {
    if (!configRefs.has(v)) {
      find('review', 'unused_variable', `variable '${v}' declared but never referenced`);
    }
  }

  // ── Step reference hygiene ──
  const stepRefs = new Set([...recipeJson.matchAll(/\{\{step\.(\w+)/g)].map((m) => m[1]));
  for (const ref of stepRefs) {
    if (!allStepIds.has(ref)) {
      find('critical', 'undeclared_step_ref', `{{step.${ref}}} referenced but no step with id '${ref}' exists`);
    }
  }

  // ── Invalid model_hint ──
  for (const step of steps) {
    if (!stripCore(str(step.ingredient)).startsWith('ai-')) continue;
    const hint = obj(step.input)['llm.model_hint'];
    if (hint != null && !VALID_MODEL_HINTS.has(String(hint))) {
      find('critical', 'invalid_model_hint', `step '${str(step.id)}' has llm.model_hint='${hint}' — must be fast, quality, or thinking`);
    }
  }

  // ── Nested templates ──
  if (/\{\{[^{}]*\{\{/.test(recipeJson)) {
    find('critical', 'nested_template', 'nested {{...{{...}}...}} detected — templates cannot be nested');
  }

  // ── Author placeholder ──
  const author = str(meta.author).toLowerCase().trim();
  if (AUTHOR_PLACEHOLDERS.has(author)) {
    find('review', 'author_placeholder', `metadata.author is placeholder value '${str(meta.author)}'`);
  }

  // ── Tags ──
  const tags = arr(meta.tags);
  if (tags.length === 0) {
    find('review', 'tags_missing', 'metadata.tags is empty — add domain, function, and entity tags');
  } else if (tags.length < 3) {
    find('info', 'tags_thin', `metadata.tags has only ${tags.length} tag(s) — recommended: domain + function + entity`);
  }

  // ── No-op transforms ──
  for (const step of steps) {
    if (step.transform === 'hash_replace' && !arr(step.fields).length) {
      find('review', 'empty_hash_replace', `step '${str(step.id)}' is hash_replace with empty fields — no-op`);
    }
    if (step.transform === 'pick' && !step.source && !arr(step.keys).length) {
      find('review', 'empty_pick', `step '${str(step.id)}' is pick with no source or keys — no-op`);
    }
  }

  // ── ai-prompt system_prompt ──
  for (const step of steps) {
    if (step.ingredient !== 'ai-prompt') continue;
    if (!obj(step.input)['llm.system_prompt']) {
      find('review', 'ai_prompt_missing_system', `step '${str(step.id)}' ai-prompt has no llm.system_prompt`);
    }
  }

  // ── variant_group ──
  const recipeId = str(recipe.recipe_id);
  if (recipeId && !meta.variant_group) {
    const parts = recipeId.split('-');
    const lastPart = parts[parts.length - 1];
    if (lastPart && KNOWN_PLATFORMS.has(lastPart)) {
      find('info', 'variant_group_missing', `recipe targets '${lastPart}' but variant_group not set`);
    }
  }

  // ── Format hints on to_table columns ──
  for (const step of steps) {
    if (step.transform !== 'to_table') continue;
    for (const col of arr(step.columns)) {
      if (col.type === 'action') continue;
      const field = str(col.field).toLowerCase();
      if (col.format || !field) continue;
      if ([...CURRENCY_HINTS].some((h) => field.includes(h))) {
        find('info', 'format_hint_missing_currency', `to_table column '${str(col.field)}' looks like currency but has no format hint`);
      } else if ([...DATE_HINTS].some((d) => field === d || field.endsWith(`_${d}`))) {
        find('info', 'format_hint_missing_date', `to_table column '${str(col.field)}' looks like a date but has no format hint`);
      }
    }
  }

  return findings;
};

// ── Helpers ──

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const arr = (v: unknown): R[] => (Array.isArray(v) ? v as R[] : []);
const obj = (v: unknown): R => (v && typeof v === 'object' && !Array.isArray(v) ? v as R : {});
// §5 — a `core-ai-*` kernel alias is an AI step like its bare slug; strip the
// reserved prefix before the `ai-` heuristic (helper kept local — this Python-port
// stays import-free).
const stripCore = (s: string): string => (s.startsWith('core-') ? s.slice(5) : s);

/** True if a hash_replace field path's last segment reads as one of the
 *  aliasable D-167 PII kinds (PII_HINTS). camelCase is folded to `_` first
 *  (ownerName → owner_name); the `<root>_` / `_<root>` affix rule keeps it
 *  boundary-aware so `username` / `filename` don't trip the `name` hint. */
const fieldLooksLikePii = (path: string): boolean => {
  const last = path.split('.').pop() ?? '';
  const seg = last.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  if (!seg) return false;
  return [...PII_HINTS].some(
    (h) => seg === h || seg.endsWith(`_${h}`) || seg.startsWith(`${h}_`),
  );
};

/** Mirrors the drop conditions of the alias substrate's `normalizeFields`
 *  (packages/transforms/src/pii-transforms.ts): a pii-protect field tag is
 *  silently discarded unless it is a `{ path, kind }` object with a non-empty
 *  string `path` and a `kind` in PRIVACY_KINDS. Returns a reason when the tag
 *  would be dropped, else null. */
const piiFieldTagProblem = (tag: unknown): string | null => {
  if (!tag || typeof tag !== 'object' || Array.isArray(tag)) {
    return 'is not a { path, kind } object';
  }
  const t = tag as { path?: unknown; kind?: unknown };
  if (typeof t.path !== 'string' || t.path.length === 0) {
    return "has no non-empty 'path' string";
  }
  if (typeof t.kind !== 'string' || !PRIVACY_KINDS.has(t.kind)) {
    return `has kind ${JSON.stringify(t.kind)} outside the privacy kinds (email/name/org/phone/address/url/external_id/account_id/content)`;
  }
  return null;
};
