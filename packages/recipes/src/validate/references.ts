/** Phase 1.5: Template reference validation.
 *
 *  Walks every string in the recipe looking for `{{namespace.path}}`
 *  refs and enforces:
 *    1. namespace is allowed (forbids `{{vault.*}}` in recipes)
 *    2. nested templates `{{...{{...}}...}}` are rejected
 *    3. `{{config.X}}` X is declared in the variables block
 *    4. `{{step.X.path}}` X is a declared step id
 *    5. Variables declared but never referenced are flagged
 *
 *  Also runs forward-reference detection via the step graph —
 *  sequential steps that reference a later-declared id or prefetch
 *  steps that reference another prefetch step are always null at
 *  runtime, so fail validation rather than producing surprising
 *  null-propagation bugs downstream.
 */

import {
  MEMORY_DATA_ALIAS_SUBNAMESPACE,
  MEMORY_DATA_SUBNAMESPACE,
  MEMORY_READ_PERMISSION,
  CRM_ALIAS_VALUES,
  activeVendorAliasRegistry,
  isEnrichmentScopeSupported,
  isMemoryDataSubnamespace,
  isEnrichmentTopic,
  ENRICHMENT_REGISTRY,
  enrichmentTopicsForScope,
  isPlatformReferenceScope,
  parseVendorEntityScope,
  matchVendorEnrichmentAlias,
  matchCrmAlias,
  WORK_ENTITY_KINDS,
  type ConnectionVendorEntity,
  type CrmAlias,
  type EnrichmentDefinition,
  type EnrichmentScope,
  type EnrichmentTopic,
} from '@recued/contracts';
import { buildStepGraph, findForwardReferences } from '../graph.js';
import { hasAnyConnectionReadPermission } from './structural.js';
import { ALLOWED_NAMESPACES } from './constants.js';
import type { AddFn } from './helpers.js';

export const validateReferences = (
  r: Record<string, unknown>,
  declaredStepIds: Set<string>,
  add: AddFn,
): void => {
  const variables = (r.variables && typeof r.variables === 'object' && !Array.isArray(r.variables))
    ? (r.variables as Record<string, unknown>)
    : {};
  const declaredVars = new Set(Object.keys(variables));
  const referencedVars = new Set<string>();

  // D-120 Phase 4 — declared staged-trust permissions on the recipe.
  // Reading `{{data.memory.*}}` (or its `data.audit.*` alias) requires
  // an explicit `requires: ['read_memory']` so the install dialog can
  // surface the permission for user approval. Tracked per-ref so a
  // single missing-permission error fires once even if the recipe has
  // many memory refs.
  const requires = Array.isArray(r.requires)
    ? new Set(r.requires.filter((p): p is string => typeof p === 'string'))
    : new Set<string>();
  let memoryRefSeen = false;
  let memoryRefSample = '';
  let auditAliasSampleRef: string | null = null;

  const serialized = JSON.stringify(r);

  // Nested template detection — `{{ ... {{ ... }} ... }}` is not allowed
  if (/\{\{[^{}]*\{\{/.test(serialized)) {
    add('error', 'nested_template', '',
      'nested {{...{{...}}...}} templates are not allowed — compute the inner value in a step first');
  }

  // Walk all refs
  const refRe = /\{\{\s*([a-z_]+)\.([a-zA-Z_][a-zA-Z0-9_.]*?)(?::[a-z]+)?\s*\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = refRe.exec(serialized)) !== null) {
    const ns = match[1];
    const path = match[2];

    if (ns === 'vault') {
      add('error', 'vault_ref_in_recipe', '',
        `{{vault.${path}}} is not allowed in recipes — only ingredients may reference vault`);
      continue;
    }

    if (ns === 'account') {
      // D-125 P5.2 retired the account-namespace runtime. Refs land in
      // the same `unknown_namespace` bucket as any other unrecognized
      // namespace; the `'account'` literal in the Namespace type is
      // reserved for a future category but has no resolver path.
      add('error', 'unknown_namespace', '',
        `{{account.${path}}} — the account namespace was retired in D-125 P5.2; route credentials through an enrolled connection (Settings → Connections)`);
      continue;
    }

    if (!ALLOWED_NAMESPACES.has(ns)) {
      add('error', 'unknown_namespace', '',
        `unknown namespace "${ns}" in {{${ns}.${path}}} — allowed: ${[...ALLOWED_NAMESPACES].join(', ')}`);
      continue;
    }

    // D-120 Phase 4.5 — `context.recipe.*` is prior-run state for MANUAL + CRON
    // runs only. Its reactive half was designed and never built: the host write
    // is gated `trigger_source !== 'auto_run'` (execute-handler.ts, deliberate —
    // per-tick writes would thrash), the process-retire boundary that was to own
    // it has no handler anywhere, and the auto-run handler holds
    // `Pick<DishContextStore, 'clear'>` — it cannot `set`. So in an `auto_run`
    // recipe every read resolves `undefined` FOREVER, `coalesce` makes each tick
    // look like a first run, and a cursor gate
    // (`{{step.id}} not_equal {{context.recipe.last_id}}`) is unconditionally
    // true — the recipe re-does its work every tick at `success: true`. Two
    // shipped watchers burned docling/whisper + an AI extract every 5 minutes on
    // this. Silence is the failure mode, so it is an ERROR here, not a warning.
    // ⇒ If the reactive half is ever built, delete this check.
    if (ns === 'context' && /^recipe\b/.test(path) && r.auto_run !== undefined) {
      add('error', 'context_recipe_in_auto_run', '',
        `{{context.${path}}} never persists in an auto_run recipe — it is manual/cron only, so this read is always undefined and any gate on it is always true. Use data.shared for a reactive cursor.`);
      continue;
    }

    // D-120 Phase 4 — `data.memory.*` + `data.audit.*` collapse to the
    // same read-only memory surface. Track touches so we can enforce
    // the `read_memory` permission once at the end (one error per
    // recipe, regardless of how many memory refs appear).
    if (ns === 'data') {
      const sub = path.split('.')[0];
      if (isMemoryDataSubnamespace(sub)) {
        if (!memoryRefSeen) {
          memoryRefSeen = true;
          memoryRefSample = `{{${ns}.${path}}}`;
        }
        if (sub === MEMORY_DATA_ALIAS_SUBNAMESPACE && auditAliasSampleRef === null) {
          auditAliasSampleRef = `{{${ns}.${path}}}`;
        }
      }
      // Other data sub-namespaces are warehouse collections (mail,
      // calendar, file, contact, deal, service, shared) plus per-
      // collection foreign keys — handled at runtime, no recipe-side
      // validation required here. `data.enrichment.*` is validated
      // separately below since the standard ref regex doesn't
      // accept email-friendly characters in the id segment.
      continue;
    }

    if (ns === 'config') {
      // Every {{config.X}} must be a declared variable
      const varName = path.split('.')[0];
      if (!declaredVars.has(varName)) {
        add('error', 'undeclared_variable_ref', '',
          `{{config.${varName}}} referenced but not declared in variables block`);
      } else {
        referencedVars.add(varName);
      }
      continue;
    }

    if (ns === 'step') {
      const stepId = path.split('.')[0];
      if (!declaredStepIds.has(stepId)) {
        add('error', 'undeclared_step_ref', '',
          `{{step.${stepId}}} referenced but no step with id "${stepId}" exists`);
      }
      continue;
    }

    // context, meta: free-form, allowed
  }

  // D-122 Phase 4.5 — separate scan for `{{data.enrichment.*}}` refs.
  // The standard ref regex constrains the path segment to
  // alphanumeric + underscore + dot — too narrow for email-style ids
  // (`bob@x.com`) and message-id style ids (`abc+v1@x.com`). Use a
  // wider character class so contact-keyed enrichments validate.
  //
  // D-128 P6 — also tracks platform-reference scopes touched by reads
  // so the read_connection_* hint at the bottom of the walker can list
  // the actual vendor names.
  const platformScopesRead = new Set<string>();
  const enrichmentRefRe = /\{\{\s*data\.enrichment\.([^}\s]+?)\s*\}\}/g;
  let enrichmentMatch: RegExpExecArray | null;
  while ((enrichmentMatch = enrichmentRefRe.exec(serialized)) !== null) {
    const fullPath = enrichmentMatch[1];
    if (typeof fullPath !== 'string') continue;
    validateEnrichmentRef(`{{data.enrichment.${fullPath}}}`, fullPath, add);
    const scope = extractPlatformReferenceScope(fullPath);
    if (scope !== null) platformScopesRead.add(scope);
  }

  // D-129 Phase 7 — separate scan for the cosmetic alias form
  // `{{data.<vendor>.<entity>.<id>.enrichments[.<rest>]}}`. Same wide
  // charset as the enrichment scanner so canonical-email contact ids
  // (`bob@x.com`) walk. Each match rewrites to the canonical D-128
  // enrichment path and forwards to the same validator with the
  // ORIGINAL ref preserved in error messages — authors see their own
  // syntax in failure surfaces, not the rewritten canonical form.
  //
  // D-130 Phase 7 — same scanner doubles for the cross-vendor alias
  // `{{data.crm.<crm_alias>.<full_target_id>.enrichments[.<rest>]}}`.
  // The CRM alias is tried first; on dispatch the matcher returns the
  // resolved (vendor, entity) from the target_id's prefix. When the
  // CRM matcher returns null (path is not under `data.crm.*` or the
  // target_id doesn't dispatch to any registered vendor), the vendor
  // alias is tried. Authors see the ORIGINAL `data.crm.*` ref in
  // error messages even though the topic / scope check runs against
  // the dispatched vendor's canonical scope.
  // D-192 unit-3 — dispatch the alias matchers against the LIVE merged
  // registry (server binds it via `setVendorAliasRegistryResolver`) so a
  // pack-declared CRM's `data.crm.*` / `data.<vendor>.*` refs validate;
  // unbound (client / test) → frozen builtin, byte-identical.
  const aliasRegistry = activeVendorAliasRegistry();
  const aliasRefRe = /\{\{\s*data\.([^}\s]+?)\s*\}\}/g;
  let aliasMatch: RegExpExecArray | null;
  while ((aliasMatch = aliasRefRe.exec(serialized)) !== null) {
    const fullPath = aliasMatch[1];
    if (typeof fullPath !== 'string') continue;
    // Already-canonical paths flow through the enrichment scanner
    // above; memory + audit handle through the main scanner.
    if (fullPath === 'enrichment' || fullPath.startsWith('enrichment.')) continue;
    if (fullPath === MEMORY_DATA_SUBNAMESPACE
        || fullPath.startsWith(`${MEMORY_DATA_SUBNAMESPACE}.`)
        || fullPath === MEMORY_DATA_ALIAS_SUBNAMESPACE
        || fullPath.startsWith(`${MEMORY_DATA_ALIAS_SUBNAMESPACE}.`)) continue;

    // D-130 P7 — try the cross-vendor `data.crm.*` matcher first.
    // The first segment after `data.` discriminates: `crm.*` is the
    // cross-vendor lens, `<vendor>.*` is the per-vendor alias.
    const crmAliased = matchCrmAlias(fullPath, aliasRegistry);
    if (crmAliased !== null) {
      const refSample = `{{data.${fullPath}}}`;
      const enrichmentSubpath = crmAliased.canonicalPostData.slice('enrichment.'.length);
      validateEnrichmentRef(refSample, enrichmentSubpath, add);
      platformScopesRead.add(`connection.api.${crmAliased.vendor}.${crmAliased.entity}`);
      continue;
    }

    // D-130 P7 — `data.crm.*` paths that look like an enrichment alias
    // shape (`crm.<X>.<Y>.enrichments[.<Z>]`) but failed the matcher
    // are validator-time hard-errors per spec § P7 open decision §3
    // ("substrate boundaries should fail loud"). Two shapes:
    //   - Unknown `<crm_alias>` segment (e.g. `crm.foo.<id>.enrichments.<topic>`).
    //   - Valid alias segment but no registered vendor matches the
    //     target_id prefix (e.g. `crm.deal.unknown_42.enrichments.foo`).
    // Bare refs (`crm`, `crm.<alias>`, `crm.<alias>.<id>` without
    // `.enrichments`) silently pass — same posture as the D-129 vendor
    // alias's bare-entity rule.
    if (fullPath === 'crm' || fullPath.startsWith('crm.')) {
      const issue = classifyCrmAliasFailure(fullPath, aliasRegistry);
      if (issue !== null) {
        add('error', issue.code, '', `{{data.${fullPath}}} — ${issue.message}`);
      }
      continue;
    }

    const aliased = matchVendorEnrichmentAlias(fullPath, aliasRegistry);
    if (aliased === null) continue;
    const refSample = `{{data.${fullPath}}}`;
    const enrichmentSubpath = aliased.canonicalPostData.slice('enrichment.'.length);
    validateEnrichmentRef(refSample, enrichmentSubpath, add);
    platformScopesRead.add(`connection.api.${aliased.vendor}.${aliased.entity}`);
  }

  // D-120 Phase 4 — `read_memory` permission gate. The install dialog
  // surfaces declared `requires` to the user as part of the staged-
  // trust flow; default-deny means recipes that read memory without
  // declaring the permission shouldn't reach the marketplace. Hard
  // error so authors notice immediately.
  if (memoryRefSeen && !requires.has(MEMORY_READ_PERMISSION)) {
    add(
      'error',
      'memory_read_permission_missing',
      'requires',
      `recipe references ${memoryRefSample} (\`data.${MEMORY_DATA_SUBNAMESPACE}.*\` / \`data.${MEMORY_DATA_ALIAS_SUBNAMESPACE}.*\`) ` +
        `but does not declare \`requires: ["${MEMORY_READ_PERMISSION}"]\` — add the permission so the install dialog can surface it for approval`,
    );
  }

  // D-120 Phase 4 — soft-warn on `data.audit.*` references. The
  // namespace stays for one release cycle as a deprecation alias for
  // `data.memory.*`; emitting a warn (not error) lets the existing
  // marketplace corpus migrate without blocking submissions.
  if (auditAliasSampleRef !== null) {
    add(
      'warn',
      'data_audit_deprecated',
      '',
      `${auditAliasSampleRef} uses the deprecated \`data.${MEMORY_DATA_ALIAS_SUBNAMESPACE}.*\` alias — rename to \`data.${MEMORY_DATA_SUBNAMESPACE}.*\` before the alias is retired in a future release`,
    );
  }

  // D-128 P6 — `read_connection_<connection_name>` hint for platform-
  // reference scope reads. Soft-warn so recipes get the nudge without
  // failing validation; the runtime resolver is the authoritative gate
  // (returns undefined when the permission isn't declared at install
  // time). The vendor list in the message helps authors fill in the
  // right connection_name when the user picks an enrolled connection.
  // Suppressed when the recipe already declares any read_connection_*
  // slug (one declaration covers the whole walk — at install the user
  // approves per-name, the validator just tracks "the recipe knows it
  // needs the family").
  if (
    platformScopesRead.size > 0
    && !hasAnyConnectionReadPermission(requires)
  ) {
    const vendors = vendorsFromScopes(platformScopesRead);
    add(
      'warn',
      'read_connection_permission_missing',
      'requires',
      `recipe reads platform-reference scope${platformScopesRead.size > 1 ? 's' : ''} ` +
        `${[...platformScopesRead].sort().map((s) => `'${s}'`).join(', ')} — declare ` +
        `\`requires: ["read_connection_<connection_name>"]\` (substitute the user's enrolled ` +
        `${vendors.length === 1 ? `${vendors[0]} ` : ''}connection name at install) so the ` +
        `resolver can gate the cross-vendor read path`,
    );
  }

  // Unused variables
  for (const v of declaredVars) {
    if (!referencedVars.has(v)) {
      add('warn', 'unused_variable', `variables.${v}`,
        `variable "${v}" is declared but never referenced — remove or use it`);
    }
  }
};

// D-122 Phase 4.5 — `data.enrichment.<…>` ref validator.
// D-125 Phase 6.1 — connection.<kind> compound scopes.
// D-128 Phase 4   — connection.api.<vendor>.<entity> platform-reference scopes.
// D-145 PA4       — work-entity scopes (task / note / commitment / project).
//
// Shape A — per-record:    `enrichment.<scope>.<target_id>.<topic?>`
//   where <scope> is either:
//     - a single segment (mail / contact / calendar / file / task /
//       note / commitment / project — D-145 PA4 widens with the four
//       work-entity scopes so PA9 producers' enrichment refs validate),
//     - two segments (connection.api / connection.mcp /
//       connection.notification — the `connection` literal followed
//       by the kind, used by D-125 P6.1 connection-record enrichments), or
//     - four segments (connection.api.<vendor>.<entity>, used by D-128
//       platform-reference enrichments where target_id is the
//       platform-native id like `hubspot_deal_47291`).
// Shape B — derived-entity: `enrichment.<topic>.<id?>`
//
// Codes:
//   enrichment_topic_unknown      — topic name not in the registry
//   enrichment_scope_unsupported  — Shape A topic doesn't list scope
//                                   in valid_scopes
const SHAPE_A_DATA_SCOPES: ReadonlySet<EnrichmentScope> = new Set([
  'mail', 'contact', 'calendar', 'file',
  // D-145 PA4 — work-entity scopes. Producers ship in PA9. DERIVED:
  // this was a fourth hand-copy of the kind list, and the validator
  // silently rejecting a new kind's `data.enrichment.<kind>.*` ref is
  // indistinguishable from that ref being wrong.
  ...WORK_ENTITY_KINDS,
]);

/** D-125 P6.1 — kinds that follow the `connection` literal in a
 *  Shape-A path. The validator consumes two segments to compose the
 *  compound scope when the head is `connection` and the second segment
 *  is one of these. */
const CONNECTION_KIND_SEGMENTS: ReadonlySet<string> = new Set([
  'api', 'mcp', 'notification',
]);

/** D-128 P4 — vendor + entity segments must match this. Same regex
 *  the contracts-side `composeVendorEntityScope` enforces. */
const PLATFORM_REFERENCE_SEGMENT_REGEX = /^[a-z][a-z0-9_]*$/;

/** Render the helpful "valid topics on '<scope>' are: …" hint when an
 *  author references a Shape A topic that isn't valid on the scope —
 *  or no topic at all when the scope's valid topic list is empty. */
const formatValidTopicsHint = (scope: EnrichmentScope): string => {
  const topics = enrichmentTopicsForScope(scope);
  if (topics.length === 0) {
    return ` — no per-record topics are registered for scope '${scope}' yet`;
  }
  return ` — valid topics on '${scope}' are: ${topics.join(', ')}`;
};

const validateEnrichmentRef = (
  refSample: string,
  path: string,
  add: AddFn,
): void => {
  // path is everything after `data.enrichment.` — e.g.
  // `contact.bob@x.com.contact_timeline_rollup`. Segments splitting
  // on `.` is ambiguous because target_ids (especially emails) carry
  // dots; we resolve by inspecting the first segment for a known
  // scope (Shape A) or known topic (Shape B), then peel from the
  // ends.
  const segments = path.split('.');
  if (segments.length === 0) return;
  let head = segments[0]!;
  let scopeSegmentCount = 1;

  // D-125 P6.1 — `connection.<kind>` is the only two-segment scope.
  // Consume the kind segment so the rest of the walk reads identically
  // to single-segment scopes (target_id at offset `scopeSegmentCount`).
  if (head === 'connection' && segments.length >= 2
    && CONNECTION_KIND_SEGMENTS.has(segments[1]!)) {
    head = `connection.${segments[1]}`;
    scopeSegmentCount = 2;
  }

  // D-128 P4 — `connection.api.<vendor>.<entity>` is the four-segment
  // platform-reference scope. Discriminator: when the path has at
  // least 4 segments and segments[2] / segments[3] both match the
  // vendor / entity identifier regex, treat the scope as four
  // segments. The `composeVendorEntityScope`-shaped string
  // `connection.api.<vendor>.<entity>` then walks identically to the
  // shorter scope shapes (target_id at offset `scopeSegmentCount`).
  //
  // The 2-segment `connection.api` interpretation still applies when
  // segments[2] doesn't fit the vendor/entity convention (e.g. the
  // user-typed connection_name has uppercase or digits at the start).
  if (head === 'connection.api'
    && segments.length >= 4
    && PLATFORM_REFERENCE_SEGMENT_REGEX.test(segments[2]!)
    && PLATFORM_REFERENCE_SEGMENT_REGEX.test(segments[3]!)) {
    const candidate = `connection.api.${segments[2]}.${segments[3]}`;
    // Only widen to 4-segment when the resulting scope shape is
    // recognised by the contracts-side `isPlatformReferenceScope`
    // predicate (which is structural — any matching string passes).
    // Failing that, fall back to 2-segment so the existing connection-
    // record path still works for unconventional connection names.
    if (isPlatformReferenceScope(candidate)) {
      head = candidate;
      scopeSegmentCount = 4;
    }
  }

  // Shape A: scope.<target_id>.<topic?>.<...drill?>
  if (SHAPE_A_DATA_SCOPES.has(head as EnrichmentScope)
    || (scopeSegmentCount === 2 && /^connection\.(api|mcp|notification)$/.test(head))
    || scopeSegmentCount === 4) {
    // Bag form — `data.enrichment.<scope>.<id>` (or just
    // `data.enrichment.<scope>`). Nothing to validate without a topic.
    // For 2-segment scopes (connection.<kind>) the bag form extends
    // through `<scope_seg_1>.<scope_seg_2>.<id>`; for 4-segment
    // platform-reference scopes through `<scope_seg_1..4>.<id>`.
    const bagThreshold = scopeSegmentCount + 1;
    if (segments.length <= bagThreshold) return;
    const last = segments[segments.length - 1]!;
    if (last === '*') return;
    // Index of the first segment that *could* be a topic — directly
    // after `<scope_segments>.<target_id>`.
    const earliestTopicIdx = scopeSegmentCount + 1;
    // Walk back from the end looking for an identifier-shaped segment
    // that IS a registered topic. This handles three path shapes
    // uniformly:
    //   1. `<scope>.<id>.<topic>`              — drop in at last.
    //   2. `<scope>.<id>.<topic>.<value-drill>` — `<topic>` is the
    //      first id-shaped registered segment found walking back from
    //      the value drill; `score` / `meta.name` etc. lands in the
    //      drill suffix.
    //   3. `<scope>.<id>.<topic>.brief.text`    — last is id-shaped
    //      but not a registered topic; walk-back picks `<topic>`.
    let topicSegmentIdx = -1;
    for (let i = segments.length - 1; i >= earliestTopicIdx; i -= 1) {
      const candidate = segments[i]!;
      if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(candidate)
        && isEnrichmentTopic(candidate)) {
        topicSegmentIdx = i;
        break;
      }
    }
    if (topicSegmentIdx < 0) {
      // No registered topic anywhere in the path — pick the LAST
      // identifier-shaped segment as the unknown-topic candidate.
      for (let i = segments.length - 1; i >= earliestTopicIdx; i -= 1) {
        const candidate = segments[i]!;
        if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(candidate)) {
          add(
            'error',
            'enrichment_topic_unknown',
            '',
            `${refSample} references unknown enrichment topic '${candidate}' — not registered in ENRICHMENT_REGISTRY${formatValidTopicsHint(head as EnrichmentScope)}`,
          );
          return;
        }
      }
      return;
    }
    const topic = segments[topicSegmentIdx]!;
    const def = ENRICHMENT_REGISTRY[topic as EnrichmentTopic] as EnrichmentDefinition;
    if (def.shape !== 'per_record') {
      add(
        'error',
        'enrichment_topic_unknown',
        '',
        `${refSample} addresses derived-entity topic '${topic}' through scope '${head}' — use 'data.enrichment.<topic>.<id>'`,
      );
      return;
    }
    // D-192 S4b follow-on — a pack CRM's mirror scope (e.g.
    // `connection.api.dynamics.contact` for a contact-anchored topic) is not in
    // the STATIC `valid_scopes` but IS a live-registry scope of the topic's
    // crm_alias family from a pack vendor — the SAME widening the enrichment
    // store's write gate applies (`isEnrichmentScopeSupported`), so a recipe
    // validates exactly where the row persists. Unbound registry (client / test)
    // → frozen builtin → static-only, unchanged.
    if (!isEnrichmentScopeSupported(def.valid_scopes, head as EnrichmentScope, activeVendorAliasRegistry())) {
      add(
        'error',
        'enrichment_scope_unsupported',
        '',
        `${refSample} — topic '${topic}' does not support scope '${head}' (valid: ${def.valid_scopes!.join(', ')})`,
      );
    }
    return;
  }

  // Shape B: <topic>.<id?>.<...drill?>
  if (head === '*') return;
  if (!isEnrichmentTopic(head)) {
    add(
      'error',
      'enrichment_topic_unknown',
      '',
      `${refSample} references unknown enrichment topic '${head}' — not registered in ENRICHMENT_REGISTRY`,
    );
    return;
  }
  const def = ENRICHMENT_REGISTRY[head as EnrichmentTopic] as EnrichmentDefinition;
  if (def.shape === 'per_record') {
    add(
      'error',
      'enrichment_scope_unsupported',
      '',
      `${refSample} — topic '${head}' is per-record; address it as 'data.enrichment.<scope>.<id>.${head}'`,
    );
  }
};

/** D-128 P6 — extract a four-segment platform-reference scope from a
 *  `data.enrichment.<…>` path. Mirrors the recognition logic in
 *  `validateEnrichmentRef` (`connection.api.<vendor>.<entity>` only
 *  when both segments fit the identifier regex AND
 *  `isPlatformReferenceScope` accepts the composed string). Returns
 *  null for closed-list scopes + Shape B refs.
 *
 *  Used to drive the `read_connection_*` hint with the actual scopes
 *  the recipe touched — the message lists `'connection.api.hubspot.deal'`
 *  rather than the generic "any platform-reference scope". */
const extractPlatformReferenceScope = (path: string): string | null => {
  const segments = path.split('.');
  if (segments.length < 4) return null;
  if (segments[0] !== 'connection' || segments[1] !== 'api') return null;
  const vendorEntity = `connection.api.${segments[2]}.${segments[3]}`;
  return isPlatformReferenceScope(vendorEntity) ? vendorEntity : null;
};

/** D-128 P6 — collect unique vendor identifiers from a set of
 *  platform-reference scope strings. Used by the read_connection_*
 *  hint to mention "the user's enrolled hubspot connection name" when
 *  exactly one vendor is touched, falling back to a generic message
 *  for multi-vendor recipes. */
const vendorsFromScopes = (scopes: ReadonlySet<string>): ReadonlyArray<string> => {
  const out = new Set<string>();
  for (const scope of scopes) {
    const parsed = parseVendorEntityScope(scope);
    if (parsed !== null) out.add(parsed.vendor);
  }
  return [...out].sort();
};

/** D-130 P7 — classify why a `data.crm.*` path failed the cross-vendor
 *  matcher. Returns null when the shape is too short to be a real
 *  alias attempt (bare `data.crm`, bare `data.crm.<alias>`, or
 *  `data.crm.<alias>.<id>` without `.enrichments`). For paths that
 *  reach the alias shape but failed to dispatch, returns a hard-error
 *  per spec § P7 open decision §3 ("substrate boundaries should fail
 *  loud"). */
const classifyCrmAliasFailure = (
  fullPath: string,
  registry: ReadonlyArray<ConnectionVendorEntity>,
): { code: string; message: string } | null => {
  // `crm` bare or with trailing dot: silent.
  if (fullPath === 'crm') return null;
  const segments = fullPath.split('.');
  // Need at least `crm.<alias>.<id>.enrichments` (4 segments) before
  // the validator complains. Shorter shapes are bare-namespace reads.
  if (segments.length < 4) return null;
  const aliasSegment = segments[1] ?? '';
  // Must contain the `.enrichments` marker somewhere after the
  // target_id segment. The cheapest probe: scan for the literal.
  if (!fullPath.includes('.enrichments')) return null;

  if (!CRM_ALIAS_VALUES.includes(aliasSegment as CrmAlias)) {
    return {
      code: 'crm_alias_unknown',
      message:
        `unknown crm_alias '${aliasSegment}' — valid: ${CRM_ALIAS_VALUES.join(', ')}. ` +
        `Address vendor-specific entities through the per-vendor alias ` +
        `(\`data.<vendor>.<entity>.<id>.enrichments.<topic>\`) when the entity ` +
        `is not a CRM concept`,
    };
  }

  // Valid alias segment but the target_id prefix didn't dispatch to
  // any registered vendor — typically a typo in the target_id or a
  // vendor that hasn't been enrolled yet. Surface the candidate
  // vendor list so authors can see what the resolver knows about.
  const candidates = registry
    .filter((e) => e.crm_alias === aliasSegment)
    .map((e) => `${e.vendor}_${e.entity}_<id>`);
  return {
    code: 'crm_alias_unresolved',
    message:
      `target_id segment does not dispatch to any registered vendor for crm_alias '${aliasSegment}' — ` +
      `expected a target_id matching one of: ${candidates.length === 0 ? '(no vendors registered)' : candidates.join(', ')}`,
  };
};

/** Detect forward step references — sequential steps that reference a
 *  later-declared step id, or prefetch steps that reference each other /
 *  a sequential step. See `findForwardReferences` in graph.ts for the full
 *  rule table.
 *
 *  This is a hard error, not a warning: the engine will always resolve
 *  the reference to `null` because the target hasn't run yet, which leads
 *  to downstream surprises that are hard to debug from a null value.
 *  Better to fail validation early. */
export const validateForwardReferences = (r: Record<string, unknown>, add: AddFn): void => {
  const graph = buildStepGraph(r);
  const forwards = findForwardReferences(graph);
  for (const f of forwards) {
    const fromNode = graph.nodes[f.from];
    const fromPath = fromNode?.phase === 'prefetch'
      ? `prefetch_steps[${f.from_index}]`
      : `steps[${f.from_index}]`;
    const toPhase = graph.nodes[f.to]?.phase ?? 'sequential';
    const explanation = fromNode?.phase === 'sequential' && toPhase === 'sequential'
      ? `references step '${f.to}' declared later (sequential steps run in JSON order)`
      : fromNode?.phase === 'prefetch' && toPhase === 'prefetch'
      ? `references prefetch step '${f.to}' (prefetch runs in parallel — no ordering guarantee)`
      : `references step '${f.to}' which hasn't run yet when this step executes`;
    add('error', 'forward_step_ref', fromPath,
      `step '${f.from}' ${explanation}`);
  }
};
