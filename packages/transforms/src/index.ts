import type { TransformFn } from './types.js';

import { filter, sort, map, project, reduce, unique, flatten, slice, chunk, group_by, enrich_by, to_list, partition } from './collection.js';
import {
  merge, prefix_keys, pick, omit, rename, set, json_byte_length,
  json_stringify, json_parse, csv_parse, utf8_byte_length, sha256,
} from './object.js';
import { lowercase, uppercase, trim, string_length, split, contains_any, concat, replace, template, truncate, strip_html, encode_base64, decode_base64 } from './string.js';
export { stripHtmlText, STRIP_HTML_MAX_INPUT } from './string.js';
/** D-244 — whole-file CSV filtering as PURE functions. Exported for the kernel
 *  ops that own the I/O: `core.storage.csv.filter` reads the warehouse record and
 *  saves the matches as a new one, `core.storage.csv.rows` returns them as a
 *  value. Both parse through the SAME code `csv_parse` uses, so the layers cannot
 *  disagree about what a file says. */
export {
  csvFilter, csvRows, csvColumns, csvStats, CSV_STATS_UNIQUE_CAP,
  type CsvFilterOptions, type CsvFilterResult, type CsvRowsOptions, type CsvRowsResult,
  type CsvColumnsOptions, type CsvMatchMode, type CsvStatsResult, type CsvColumnStats,
} from './csv-file.js';
import { round, clamp, to_number, math, weighted_score } from './numeric.js';
import { date_diff, date_format, date_add, date_parse, is_past, is_future, date_period, to_recent_date } from './date.js';
import { compare, coalesce, switch_, all, any, count, default_, defaults_, not_, ternary, pluralize } from './logic.js';
import { hash_replace, hash_restore, redact } from './privacy.js';
import { to_checklist, to_table, to_summary, to_csv } from './display.js';
import { to_slack_blocks } from './slack-blocks.js';
import { starts_with, ends_with } from './boolean.js';
import { find, pluck, sum, min_by, max_by, percent, join } from './compound.js';
import {
  mail_received, file_changed, calendar_starting_soon,
  calendar_changed_since, calendar_new_since, attendee_diff,
  recipe_succeeded_since,
  time_within_window, time_elapsed_since, http_changed,
} from './reactive.js';
import { wait } from './timing.js';
import { enrichmentOrFetch } from './enrichment-or-fetch.js';
import { piiProtect, piiRestore } from './pii-transforms.js';

export type { TransformFn, TransformContext, EnrichmentRowSnapshot } from './types.js';
export type { ReduceOp, MathOp, DateUnit, SortDirection, SortField, TableColumn,
  ChecklistItem, SummaryField } from './types.js';
export { evaluateOp, getField } from './evaluate.js';
export {
  TRANSFORM_SCHEMAS,
  getTransformSchema,
  APPLY_VALUE_PARAM,
  applyValueParam,
  type ParamType,
  type ParamDef,
  type TransformSchema,
} from './schemas.js';

// D-167 — PII alias substrate. P0 landed the primitives + fixture tests
// unexported (no consumer); P1 added the gateway chat-mode egress aliaser as
// the first consumer. P4 adds the recipe-callable `pii-protect` / `pii-restore`
// transforms (registered in TRANSFORMS below) + the run-local ledger store
// (`createPiiLedgerStore`) the recued-server engine mints per recipe run.
// These named exports are the substrate; the registered transforms are below.
export {
  createLedger,
  cloneLedger,
  commitLedger,
  restrictStagedLedgerToRestoreAuthority,
  createCounters,
  summarizeRedactions,
  aliasIdentifierField,
  aliasFields,
  aliasFieldsBatch,
  restoreInString,
  restoreInStringWithAuthority,
  restoreArgs,
  restoreArgsWithAuthority,
  restoreArgsAndKeys,
  restoreArgsAndKeysWithAuthority,
  restoreArgKeys,
  restoreArgKeysWithAuthority,
  derivePiiRestoreAuthority,
  containsPotentialPiiAliasLiteral,
  containsPiiAliasToken,
  holdsPiiAliasToken,
  aliasArgs,
  // D-167 (recall path) — value-walk that aliases a memory.* result against the
  // contact known-value index (seed ⊇ scan) + overlap-decorates each name/org
  // alias. Closes the cross-session memory-recall leak.
  aliasRecallArgs,
  scanContent,
  preScanReservePii,
  phoneMatchDigits,
  ledgerKindForAlias,
  // D-167 P4 — Aho-Corasick known-value content aliasing (the registry's
  // `aliasContent` / `seedContent` substrate; closes the memory-recall leak).
  buildKnownValueIndex,
  aliasKnownValuesInContent,
  seedKnownValuesFromContent,
  // D-167 — deterministic per-session alias slot ordering, so a restart cannot
  // renumber `pii.Person1` onto a different person.
  reserveAliasSlotOrdering,
  // D-167 — the structured-address substrate. `ADDRESS_COARSE_KEYS` is the ONE
  // definition of "coarse" (city / state / country stay visible; the postcode is
  // NOT coarse and IS aliased); `addressMatchForms` derives the composite prose
  // targets that give a postcode its neighbours — never a bare postcode.
  // Exported so a second producer derives them instead of restating them.
  ADDRESS_COARSE_KEYS,
  readAddressComponents,
  addressMatchForms,
  // D-167 (recall↔PII) — overlap-reveal: decorate a recalled name/org alias
  // with the user-disclosed overlap fragment (`pii.Person1.sarah`) so a partial
  // reference re-binds without leaking the unrevealed rest.
  decorateOverlapReveal,
  classifyAliasTokens,
  rawLedgerValuesInText,
  type AliasVocabularyReport,
  tokenizeForOverlap,
  createPiiLedgerStore,
  getFallbackPiiLedgerStore,
  _resetPiiLedgerState,
} from './pii-alias.js';
export type {
  Ledger,
  PiiRestoreAuthority,
  AliasNamespace,
  RedactionCounters,
  PiiLedgerStore,
  KnownValueIndex,
  KnownValueSeed,
  KnownValueIdentifierSeed,
  AliasSlotSeed,
  AddressComponents,
} from './pii-alias.js';
export {
  buildAhoCorasick,
  findAhoCorasickMatches,
} from './aho-corasick.js';
export type { AhoCorasick, AhoCorasickMatch } from './aho-corasick.js';

export const TRANSFORMS: ReadonlyMap<string, TransformFn> = new Map([
  // Collection
  ['filter', filter], ['sort', sort], ['map', map], ['project', project], ['reduce', reduce],
  ['unique', unique], ['flatten', flatten], ['slice', slice], ['chunk', chunk], ['group_by', group_by], ['enrich_by', enrich_by], ['to_list', to_list],
  ['partition', partition],
  // Object
  ['merge', merge], ['prefix_keys', prefix_keys], ['pick', pick], ['omit', omit], ['rename', rename], ['set', set],
  ['json_byte_length', json_byte_length], ['json_stringify', json_stringify], ['json_parse', json_parse], ['csv_parse', csv_parse],
  ['utf8_byte_length', utf8_byte_length], ['sha256', sha256],
  // String
  ['lowercase', lowercase], ['uppercase', uppercase], ['trim', trim], ['string_length', string_length], ['split', split],
  ['contains_any', contains_any], ['concat', concat], ['replace', replace], ['template', template],
  ['truncate', truncate], ['strip_html', strip_html], ['encode_base64', encode_base64], ['decode_base64', decode_base64],
  // Numeric
  ['round', round], ['clamp', clamp], ['to_number', to_number], ['math', math], ['weighted_score', weighted_score],
  // Date
  ['date_diff', date_diff], ['date_format', date_format], ['date_add', date_add],
  ['date_parse', date_parse], ['is_past', is_past], ['is_future', is_future], ['date_period', date_period],
  ['to_recent_date', to_recent_date],
  // Logic
  ['compare', compare], ['coalesce', coalesce], ['switch', switch_], ['all', all], ['any', any], ['count', count],
  ['default', default_], ['defaults', defaults_], ['not', not_], ['ternary', ternary], ['pluralize', pluralize],
  // Privacy
  ['hash_replace', hash_replace], ['hash_restore', hash_restore], ['redact', redact],
  // D-167 P4 — reversible PII alias comfort layer (typed aliases over hash tokens)
  ['pii-protect', piiProtect], ['pii-restore', piiRestore],
  // Display
  ['to_checklist', to_checklist], ['to_table', to_table], ['to_summary', to_summary],
  ['to_csv', to_csv],
  ['to_slack_blocks', to_slack_blocks],
  // Boolean
  ['starts_with', starts_with], ['ends_with', ends_with],
  // Compound (Tier 2)
  ['find', find], ['pluck', pluck], ['sum', sum], ['min_by', min_by], ['max_by', max_by],
  ['percent', percent], ['join', join],
  // D-115 reactive (Tier 2 — starter set)
  ['mail_received', mail_received],
  ['file_changed', file_changed],
  ['calendar_starting_soon', calendar_starting_soon],
  ['recipe_succeeded_since', recipe_succeeded_since],
  ['time_within_window', time_within_window],
  ['time_elapsed_since', time_elapsed_since],
  ['http_changed', http_changed],
  // D-117 calendar reactive helpers
  ['calendar_changed_since', calendar_changed_since],
  ['calendar_new_since', calendar_new_since],
  ['attendee_diff', attendee_diff],
  // D-116 timing
  ['wait', wait],
  // D-125 P6.2 enrichment-first convention
  ['enrichment-or-fetch', enrichmentOrFetch],
]);

export const getTransform = (name: string): TransformFn | undefined => TRANSFORMS.get(name);
