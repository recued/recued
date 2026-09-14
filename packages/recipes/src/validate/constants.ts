/** Constants shared across the validator phases.
 *
 *  Kept in one module so every Set / Record has exactly one definition
 *  and the structural + quality + contracts phases draw from the same
 *  authoritative list. Cross-package dedup (e.g. `AUTHOR_PLACEHOLDERS`
 *  duplicated in `packages/ingredients/src/validate.ts`) is a separate
 *  follow-up — that module has no dependency on @recued/recipes today.
 */

import { OUTPUT_TYPES as OUTPUT_TYPE_VOCABULARY, type OutputType } from '@recued/contracts';

/** The block kinds a recipe's `output.render` may declare.
 *
 *  ⛔ DERIVED, never re-typed. This was a hand-written Set literal duplicating
 *  the `OutputType` union — and a `Set<OutputType>` that is MISSING a member
 *  typechecks perfectly, so widening the union while forgetting this line would
 *  have failed the new kind at validation with no compiler complaint and no
 *  legible error. Same drift that took `door_types` out of its schema (D-207
 *  slice 1c). The vocabulary lives in contracts; this only re-shapes it. */
export const OUTPUT_TYPES: ReadonlySet<OutputType> = new Set(OUTPUT_TYPE_VOCABULARY);

/** Namespaces a RECIPE may reference via `{{ns.X}}`. `vault` and `account` are
 *  conspicuously absent — only ingredients reference those (D-100: account is
 *  credential material, same restriction as vault). */
// `item` is only meaningful inside a `map` transform's `expression` field
// (or object/array templates nested in that expression). The runtime resolves
// {{item.path}} to the current iteration's field value. Outside a map scope
// it silently resolves to undefined at runtime — harmless, but we could add
// stricter context-aware validation later.
//
// D-103 adds `shared` (cache-tier volatile, LRU+TTL) and `data` (gateway to
// `data.shared.*` durable records). The validator accepts both at the root;
// sub-namespace shape (data.shared.* is the only supported path under data)
// is checked by the pre-fetch resolver at runtime.
//
// D-115 adds `trigger` — outputs of `trigger_steps` ingredients are surfaced
// to prefetch + steps as `{{trigger.<step_id>.<field>}}`. Reference resolution
// against the actual trigger step ids lands with the executor in Phase 5;
// Phase 1 only opens the namespace so the structural validator stops flagging
// it as unknown.
export const ALLOWED_NAMESPACES = new Set(['config', 'context', 'meta', 'step', 'item', 'shared', 'data', 'trigger']);

/** Namespaces, including `vault` and `account`, plus prototype-sensitive
 *  object keys that cannot be used as step ids. Namespace collisions would
 *  break reference resolution; prototype-sensitive ids would not round-trip
 *  through the engine's step-output stores. */
export const RESERVED_STEP_IDS = new Set([
  'vault',
  'config',
  'context',
  'meta',
  'step',
  'item',
  'account',
  'trigger',
  '__proto__',
  'constructor',
  'prototype',
]);

export const AUTHOR_PLACEHOLDERS = new Set([
  '', 'todo', 'author', 'your-name', 'your_name', 'name', 'test', 'example',
]);

export const VALID_MODEL_HINTS = new Set(['fast', 'quality', 'thinking']);

/** Known platform suffixes that can appear at the end of a recipe_id. */
export const KNOWN_PLATFORMS = new Set([
  'hubspot', 'salesforce', 'pipedrive', 'zendesk', 'intercom', 'freshdesk',
  'gmail', 'outlook', 'slack',
]);

/** Step/recipe ids that look like placeholders from a scaffold. */
export const PLACEHOLDER_IDS = new Set([
  'step1', 'step2', 'step3', 'my_step', 'test', 'todo', 'example',
  'foo', 'bar', 'baz', 'temp', 'placeholder',
]);

/** Column field name roots that imply currency formatting. */
export const CURRENCY_FIELD_HINTS = [
  'amount', 'price', 'revenue', 'cost', 'value', 'pipeline', 'total', 'arr', 'mrr',
];

/** Column field name roots that imply date formatting. */
export const DATE_FIELD_HINTS = [
  'date', 'created_at', 'updated_at', 'close_date', 'start_date', 'end_date', 'timestamp',
];

/** Field-name roots that read as *aliasable* PII — the D-167 `EntityFieldPrivacy`
 *  kinds the `pii-protect` transform handles (email / name / org / phone /
 *  address / url / external_id / account_id). When a `hash_replace` step in an
 *  AI recipe targets one of these, `pii-protect` is the better tool: it hands
 *  the LLM typed aliases (`pii.Person1`, `m1@d1.invalid`) it can reason over, where
 *  `hash_replace` emits opaque tokens. The 9th kind, `content`, is deliberately
 *  absent — free text carries no field-name signature, so `hash_replace` stays
 *  the right escape hatch for non-aliasable blobs. Matched against the last
 *  dot-path segment with a `<root>_` / `_<root>` affix tolerance (so
 *  `contact.email`, `deal.owner_name`, `work_phone` all resolve) but no bare
 *  substring match, so `username` / `filename` don't trip the `name` hint. */
export const PII_FIELD_HINTS = [
  'email', 'name', 'phone', 'mobile', 'fax', 'address',
  'org', 'organization', 'company', 'url', 'website',
  'account_id', 'external_id',
];

/** TTL floors (seconds) — AI recipes cache longer because inference is costly. */
export const TTL_FLOOR_AI = 300;
export const TTL_FLOOR_DATA = 60;

/** Required `llm.*` input keys per built-in AI function ingredient slug.
 *  Source of truth: CLAUDE.md "Contracted AI functions" section. The engine
 *  will accept whatever the user supplies, so these are purely static
 *  contracts for early feedback — a recipe with ai-classify missing
 *  `llm.categories` is broken and the validator should say so.
 *
 *  ai-prompt is intentionally treated as the escape hatch — it requires
 *  `llm.prompt` but `llm.system_prompt` is handled by the phase-2 ai-prompt
 *  specificity check. */
export const AI_FUNCTION_REQUIRED_INPUTS: Record<string, string[]> = {
  'ai-classify':  ['llm.data', 'llm.categories'],
  'ai-score':     ['llm.data', 'llm.criteria'],
  'ai-extract':   ['llm.data', 'llm.fields'],
  'ai-summarize': ['llm.data'],
  'ai-sentiment': ['llm.data'],
  'ai-compare':   ['llm.data_a', 'llm.data_b'],
  'ai-generate':  ['llm.data', 'llm.template_type'],
  'ai-translate': ['llm.data', 'llm.target_language'],
  'ai-rewrite':   ['llm.data', 'llm.style'],
  'ai-prompt':    ['llm.prompt'],
};

/** Required INPUTS each kernel ingredient's adapter enforces at dispatch, so a
 *  missing one is caught at AUTHORING time instead of as a runtime `BAD_INPUT`.
 *
 *  ⛔ THIS EXISTS BECAUSE THE RUNTIME GUARD IS THE ONLY THING THAT CHECKED, and
 *  it fires far too late. `enrichment-upsert` guards `authored_by_recipe_id`,
 *  and SEVEN of the twelve shipped `enrichment-upsert` steps omitted it — every
 *  one dead on dispatch, in 3-7 packs each, with nothing at authoring time
 *  saying so. The validator only ever checked AI-function contracts
 *  (`AI_FUNCTION_REQUIRED_INPUTS` above); every other ingredient's input
 *  contract was unchecked.
 *
 *  ⚠ ENGINE-STAMPED FIELDS ARE DELIBERATELY ABSENT. `authored_by_recipe_id` and
 *  `recipe_hash` are supplied by the engine from `StepMeta` (see
 *  `stampedRecipeId` in `packages/ingredients/src/kernel.ts`), so requiring them
 *  from an author would flag every correct recipe. A field belongs here only
 *  when the AUTHOR is the one who must provide it.
 *
 *  ⚠ Derived from the adapter's own `'<slug>: <field> is required'` guards and
 *  pinned to them by test, so a new guard cannot land without landing here. */
export const KERNEL_REQUIRED_INPUTS: Record<string, readonly string[]> = {
  'annotation-create': ['key', 'source_record_hash'],
  'booking-create': ['title'],
  'booking-delete': ['id'],
  'booking-update': ['id'],
  'commitment-cancel': ['id'],
  'commitment-fulfill': ['id'],
  'commitment-update': ['id'],
  'contact-upsert': ['email'],
  'data-file-read': ['record_id'],
  'enrichment-list': ['topic'],
  'enrichment-upsert': ['id', 'topic'],
  'exchange-status': ['exchange_ref'],
  'file-render-markdown-template': ['template_file_ref'],
  'file-set-scan-status': ['record_id'],
  'form-response-get': ['submission_id'],
  'form-response-set-state': ['submission_id'],
  'link-create': ['kind'],
  'mail-body-read': ['record_id', 'slug'],
  'mail-draft-save-to-mailbox': ['draft_id'],
  'mail-get': ['record_id', 'slug'],
  'mail-send': ['body', 'sender_mail_instance', 'subject'],
  'mail-thread-reader': ['slug', 'thread_id'],
  'note-create': ['body'],
  'note-delete': ['id'],
  'note-update': ['id'],
  'notification-recipe-callback': ['destination_contract_id', 'query_tool', 'topic'],
  'notification-send': ['text'],
  'notify-booking-visitor': ['body', 'booking_id', 'sender_mail_instance', 'subject'],
  'project-archive': ['id'],
  'project-create': ['title'],
  'project-update': ['id'],
  'schedule-recipe': ['recipe_id'],
  'shared-compare-and-set': ['key'],
  'shared-read': ['key'],
  'task-create': ['title'],
  'task-delete': ['id'],
  'task-mark-done': ['id'],
  'task-update': ['id'],
  'webhook-event-get': ['event_ref'],
  'work-entity-get': ['id'],
};
