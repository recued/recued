/** Reactive authoring sugar — the canonical `on:` subscriber form
 *  (reactive-automation-watch-dispatch design § 3 / § 4 compile-down).
 *
 *  Recipes subscribe to change events either RAW (a literal warehouse-bus
 *  pattern — `event: "data.connection.api.hubspot.deal.**.updated"`) or via
 *  this sugar (`on: "deal.changed"`), which the server's declarative
 *  reconciler compiles down to raw bus patterns + per-row dispatch filters
 *  at materialization time. Composite to write, flat + stateless to run —
 *  the dispatch path never learns a new vocabulary.
 *
 *  Five authored forms, one closed grammar:
 *
 *    on: "<crm_alias>.<verb>"           deal.changed — cross-vendor: fans to
 *                                       one subscription per live-registry
 *                                       entity carrying that `crm_alias`
 *                                       (hubspot.deal + salesforce.opportunity)
 *    on: "<vendor>.<entity>.<verb>"     hubspot.deal.changed — single vendor;
 *                                       also what the D-170 N.18 decomposer
 *                                       mints for compiled workflow recipes
 *    on: "message.received"             messenger shorthand — verified inbound
 *                                       Slack/Telegram user messages
 *                                       (`data.messenger.<vendor>.message.created`)
 *    on: "reception.request"            reception shorthand — verified visitor
 *                                       mutation arrivals
 *                                       (`data.reception.<kind>.request.created`)
 *    on: "form_response.accepted"       an intake response the OWNER
 *                                       APPROVED: the row is written, and this
 *                                       fires once, on the approve leg
 *                                       (`form-response-promotion.ts`), never
 *                                       at submit. Only an intake whose
 *                                       destination is a form response, or a
 *                                       paid direct-checkout pair, writes one;
 *                                       an intake routed to a task, contact,
 *                                       calendar event or note does not, so
 *                                       watch that entity's `created` event.
 *                                       ⚠ This said "fires at SUBMIT" from
 *                                       2026-07-18 (D-210 WS2) until 09-27;
 *                                       audit finding 3a had moved the write
 *                                       back to approval on 07-21 (`2ec931cc7`).
 *                                       (`data.form_response.accepted.response.created`)
 *    on: "mail_fact.<type>"             D-315 — a thing (a parcel, an order, a
 *    on: "mail_fact"                    bill) that mail facts fold into was
 *                                       created or changed: of one kind of
 *                                       email (ruling 43), or of ANY kind
 *                                       that has the variables it designates
 *                                       (ruling 42), as `deal.changed` spans
 *                                       vendors. No verb: creation counts as
 *                                       a change of every variable read, and
 *                                       `fields` picks which changes wake it
 *                                       (`data.mail_fact.<type|*>.thing.*`)
 *
 *  Verbs are the canonical trigger vocabulary `created | changed | removed`
 *  (the trigger-side twin of the canonical-op verbs), mapped to the bus
 *  kinds `created | updated | deleted`. The fixed platform shorthands are
 *  fixed-event forms (all map to `created` arrivals). Messenger/reception
 *  replace the raw-only subscriber form for the push platforms the
 *  WatchSource slice re-slotted; form-response names the explicit post-review
 *  lifecycle boundary instead of exposing its bus address to authors.
 *
 *  `fields` / `where` are DISPATCH FILTERS, not poll params (design § 3):
 *  they lower onto the materialized trigger row and the dispatcher evaluates
 *  them read-free against the event payload before enqueueing a fire. The
 *  filter is a best-effort NOISE ABSORBER, never a correctness gate — except
 *  on a mail fact, whose event is never a doorbell (D-315 §5.1): an entry
 *  whose payload path is absent PASSES (see
 *  `matchesTriggerDispatchFilter`) because event fidelity is layered
 *  (webhook > reconciler > poll — design § 2) and doorbell shapes still
 *  exist (messenger/reception/adapter emits, meta-less prior rows) even
 *  though all three entity-change tiers now carry the fat
 *  `record` / `changed_fields` payload. A recipe that needs
 *  a hard guarantee keeps the check in its own `skip_when` / guard steps
 *  (design § 5: the state-dependent slice stays in the recipe). */

import { CRM_ALIAS_VALUES, type ConnectionVendorEntity } from './connection-vendors.js';
import { ELEMENT_ON_SHORTHAND } from './dom-watch-trigger.js';
import { FORM_RESPONSE_CREATED_EVENT_PATTERN } from './form-response.js';
import {
  canonicalMailFactCarrier,
  getMailFactBuiltinType,
  isMailFactTypeId,
  isMailFactVariableName,
  isMailFactWord,
  MAIL_FACT_BUILTIN_TYPES,
  MAIL_FACT_EVENT_PLATFORM,
  MAIL_FACT_FILTERABLE_KINDS,
  mailFactStoredId,
  mailFactStoredText,
  MAIL_FACT_LAST_EMAIL_AT,
  MAIL_FACT_NOTICE_VARIABLE,
  MAIL_FACT_ON_PREFIX,
  MAIL_FACT_ON_SHORTHAND,
  MAIL_FACT_STATE_VARIABLE,
  mailFactEventPattern,
  mailFactFieldKeys,
  mailFactTypeVariables,
  mailFactWhereKeys,
  type MailFactTypeId,
  type MailFactTypeSpec,
  type MailFactVariableSpec,
} from './mail-facts.js';
import {
  DOM_WATCH_BUS_PREFIX,
  DOM_WATCH_PLATFORM,
  encodeDomWatchTarget,
  isUnmatchableDomWatchPattern,
  MESSENGER_EVENT_PLATFORM,
  RECEPTION_EVENT_PLATFORM,
} from './watch.js';
import type { RecipeEventTrigger } from './recipe.js';

/** Canonical trigger verbs (design § 3). Closed — `changed` (not the bus's
 *  `updated`) keeps the authored vocabulary aligned with the canonical-op
 *  convention's tense, and the compile owns the mapping. */
export const TRIGGER_SUGAR_VERBS = ['created', 'changed', 'removed'] as const;
export type TriggerSugarVerb = (typeof TRIGGER_SUGAR_VERBS)[number];

const VERB_SET: ReadonlySet<string> = new Set(TRIGGER_SUGAR_VERBS);

/** Canonical verb → emitted warehouse-bus event kind. */
export const TRIGGER_SUGAR_VERB_TO_KIND: Readonly<
  Record<TriggerSugarVerb, 'created' | 'updated' | 'deleted'>
> = {
  created: 'created',
  changed: 'updated',
  removed: 'deleted',
};

/** Fixed platform shorthands. */
export const MESSENGER_ON_SHORTHAND = 'message.received';
export const RECEPTION_ON_SHORTHAND = 'reception.request';
export const FORM_RESPONSE_ON_SHORTHAND = 'form_response.accepted';
export { ELEMENT_ON_SHORTHAND, isDomWatchTriggerEntry } from './dom-watch-trigger.js';

/** Lowercase identifier — the same grammar `composeVendorEntityScope`
 *  enforces on scope segments (and `watch.ts` uses for literal pattern
 *  segments). Redeclared module-locally; the grammar is shared by
 *  convention, not by export. */
const SEGMENT_RE = /^[a-z][a-z0-9_]*$/;

/** Connection-name grammar (the D-125 connection store's namespace). */
const CONNECTION_NAME_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

const CRM_ALIAS_SET: ReadonlySet<string> = new Set(CRM_ALIAS_VALUES);

/** The accepted-response event has one fixed, privacy-minimized record shape.
 *  Keep authored narrowing closed to paths that are guaranteed to exist: a
 *  misspelled `where` path would otherwise PASS under the dispatcher's
 *  missing-path posture and run the recipe for every form. `id` lowers to the
 *  always-present top-level `record_id`; the other two live on `record`. */
const FORM_RESPONSE_WHERE_KEYS: ReadonlySet<string> = new Set([
  'id',
  'endpoint_id',
  'form_definition_id',
]);

/** D-315 — what a trigger check may know beyond the built-in kinds of email. */
export interface TriggerSugarOptions {
  /** The kinds of email the owner made on THIS server (§4.5). Given, the check
   *  knows every kind a fact here can have, so it refuses a kind, a variable or
   *  a value no kind here has. Without it — a recipe's check, which runs where
   *  no owner's kinds exist — it knows the built-in kinds only, and what none of
   *  them has is a note (`recipeEventTriggerNotes`), not a refusal: a kind
   *  made on the owner's server may have it. */
  readonly mailFactTypes?: () => readonly MailFactTypeSpec[];
  /** D-315 §5.1 — the template a recipe's `template_variable` names: the id
   *  its setting holds on this server, or null when none is chosen. Only the
   *  reconciler knows it; without it, an entry that names one compiles to
   *  nothing, as a narrowing no fact can be shown to match does. */
  readonly templateOf?: (variable: string) => string | null;
}

/** The keys a mail-fact entry takes. Any other key is refused, not ignored: an
 *  ignored `"feilds"` or `"typ"` would leave the trigger wider than written. */
const MAIL_FACT_ENTRY_KEYS: ReadonlySet<string> = new Set(['on', 'fields', 'where', 'template_variable']);
/** Keys refused with a reason of their own elsewhere in the check. */
const ENTRY_KEYS_REFUSED_ELSEWHERE: ReadonlySet<string> = new Set(['event', 'filter', 'connection', 'url', 'selector']);

const variableOf = (spec: MailFactTypeSpec, name: string): MailFactVariableSpec | undefined =>
  mailFactTypeVariables(spec).find((variable) => variable.name === name);

/** Why `value` cannot be what `variable` holds as a fact stores it, or null.
 *  Empty and uncollapsed text are refused before, for every kind. */
const mailFactValueProblem = (variable: MailFactVariableSpec, value: unknown): string | null => {
  const { kind } = variable;
  if (kind === 'number' ? typeof value !== 'number' : kind === 'boolean' ? typeof value !== 'boolean' : typeof value !== 'string') {
    return `must be a ${kind === 'number' || kind === 'boolean' ? kind : 'string'}, as the fact stores it`;
  }
  if (kind === 'enum' && !(variable.values ?? []).includes(value as string)) return `must be one of ${(variable.values ?? []).join(', ')}`;
  if (kind === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value as string)) return 'must be a date as the fact stores it (YYYY-MM-DD)';
  if (kind === 'id' && mailFactStoredId(value as string) !== value) {
    return `must be written as a fact stores it: '${mailFactStoredId(value as string)}'`;
  }
  return null;
};

/** Why a mail-fact entry's `fields` / `where` cannot match (§5.1).
 *   - `errors`: what no fact can match — a name that is no variable, an empty
 *     or uncollapsed value, a state that is no word, `where.id`, `where.type`,
 *     `where.last_email_at` — and, on a trigger naming one kind the checker
 *     knows, anything that kind does not have.
 *   - `unknown`: what the checker cannot find, and a kind made on a server
 *     can have: on a trigger on ANY kind, a variable, a value or a set of them
 *     together no known kind has; on one naming a kind the checker cannot see,
 *     the kind. Refused by a check that knows every kind (a trigger made on
 *     this server); a note for one that does not (a recipe's).
 *  Both filters are STRICT: an event carries every variable of its kind and
 *  its `changed_fields`, and the dispatch filter reads a variable its kind
 *  lacks as no match. */
const mailFactEntryProblems = (
  type: string | null,
  fields: unknown,
  where: unknown,
  options: TriggerSugarOptions = {},
): { errors: string[]; unknown: string[] } => {
  const errors: string[] = [];
  const unknown: string[] = [];
  const everywhere = options.mailFactTypes !== undefined;
  const owned = options.mailFactTypes?.() ?? [];
  const onlyYours = everywhere ? '' : ' — only a kind made on the owner’s server can start it';

  // What no fact of any kind can match.
  const variableKeys: [string, unknown][] = [];
  if (where !== null && typeof where === 'object' && !Array.isArray(where)) {
    for (const [key, value] of Object.entries(where)) {
      if (key === 'id') {
        errors.push("'where.id' does not apply to a mail fact — a thing's id is minted on the owner's server");
      } else if (key === 'type') {
        errors.push(`'where.type': name the kind in 'on' — '${MAIL_FACT_ON_PREFIX}shipment' — or leave it out for any kind`);
      } else if (key === MAIL_FACT_LAST_EMAIL_AT) {
        errors.push(`'where.${MAIL_FACT_LAST_EMAIL_AT}': a time is never matched exactly — name it in 'fields' to wake for every new email about the thing`);
      } else if (key === 'complete') {
        if (typeof value !== 'boolean') errors.push("'where.complete' must be true or false");
      } else if (key === 'template') {
        if (typeof value !== 'string' || value.trim().length === 0) errors.push("'where.template' must be a template's id");
      } else if (!isMailFactVariableName(key)) {
        errors.push(`'where.${key}' is not a variable — use a variable's name, 'complete' or 'template' (a fact's data is not filterable)`);
      } else if (typeof value === 'string' && value.trim().length === 0) {
        // An empty reading is stored as null, never as ''.
        errors.push(`'where.${key}' must not be empty — a fact never stores an empty value`);
      } else if (typeof value === 'string' && value !== value.replace(/\s+/g, ' ').trim()) {
        // Found text is stored collapsed (`normalize.ts`), and no other kind has spaces.
        errors.push(`'where.${key}' must be written as the fact stores it — no spaces at either end, and one between words`);
      } else if (typeof value === 'string' && value !== mailFactStoredText(value)) {
        // And canonical: a fullwidth letter, or one that shows nothing, is in no fact.
        errors.push(`'where.${key}' must be written as a fact stores it: '${mailFactStoredText(value)}' — plain letters and digits, and nothing that does not show`);
      } else if (key === 'carrier' && typeof value === 'string' && canonicalMailFactCarrier(value) !== value) {
        // Every pass names one of the four carriers the same way (§7.1).
        errors.push(`'where.carrier' must be written as a fact stores it: '${canonicalMailFactCarrier(value)}'`);
      } else if ((key === MAIL_FACT_STATE_VARIABLE || key === MAIL_FACT_NOTICE_VARIABLE)
        && !(typeof value === 'string' && isMailFactWord(value))) {
        errors.push(`'where.${key}' must be a ${key} as every kind of email writes one: lower-case words joined by _ (for example out_for_delivery)`);
      } else {
        variableKeys.push([key, value]);
      }
    }
  }
  // Every thing has the time of its newest email; the rest must be variables.
  const fieldNames: string[] = [];
  if (Array.isArray(fields)) {
    for (const field of fields) {
      if (typeof field !== 'string' || field.length === 0 || field === MAIL_FACT_LAST_EMAIL_AT) continue;
      if (!isMailFactVariableName(field)) {
        errors.push(`'fields' names '${field}', which is not a variable — 'fields' lists the variables whose change wakes it`);
      } else {
        fieldNames.push(field);
      }
    }
  }

  // One kind: checked exactly, when the checker can see it.
  if (type !== null) {
    const spec = getMailFactBuiltinType(type) ?? owned.find((candidate) => candidate.id === type);
    if (spec === undefined) {
      if (everywhere) errors.push(`'${MAIL_FACT_ON_PREFIX}${type}': there is no kind of email '${type}' on this server`);
      else unknown.push(`'${MAIL_FACT_ON_PREFIX}${type}': a kind of email made on a server exists only there — this recipe starts only where it was made`);
      return { errors, unknown };
    }
    const keys = mailFactWhereKeys(spec);
    for (const [key, value] of variableKeys) {
      const variable = variableOf(spec, key);
      if (variable === undefined || !keys.has(key)) {
        errors.push(`'where.${key}' is not filterable on ${type} — use its variables (money, times, files and data are not; watch a time with 'fields'), 'complete' or 'template': ${[...keys].join(', ')}`);
        continue;
      }
      const problem = mailFactValueProblem(variable, value);
      if (problem !== null) errors.push(`'where.${key}' ${problem}`);
    }
    const known = mailFactFieldKeys(spec);
    for (const field of fieldNames) {
      if (!known.has(field)) errors.push(`'fields' names '${field}', which is not a variable of ${type} (${[...known].join(', ')})`);
    }
    return { errors, unknown };
  }

  // Any kind: whatever SOME kind the checker knows has.
  const kinds: readonly MailFactTypeSpec[] = [...MAIL_FACT_BUILTIN_TYPES, ...owned];
  const noKind = everywhere ? 'no kind of email on this server' : 'no built-in kind of email';
  const accepted = new Map<string, ReadonlySet<string>>();
  for (const [key, value] of variableKeys) {
    const declaring = kinds.filter((spec) => variableOf(spec, key) !== undefined);
    const filterable = declaring.filter((spec) => MAIL_FACT_FILTERABLE_KINDS.has(variableOf(spec, key)!.kind));
    const matching = filterable.filter((spec) => mailFactValueProblem(variableOf(spec, key)!, value) === null);
    if (declaring.length === 0) {
      unknown.push(`'where.${key}': ${noKind} has a variable '${key}'${onlyYours}`);
    } else if (filterable.length === 0) {
      unknown.push(`'where.${key}': every kind of email that has ${key} holds money, a time, a file or data in it, which a filter cannot compare (watch it with 'fields')${onlyYours}`);
    } else if (matching.length === 0) {
      const enums = filterable.every((spec) => variableOf(spec, key)!.kind === 'enum');
      unknown.push(enums
        ? `'where.${key}': ${noKind} has the ${key} '${String(value)}'${onlyYours}`
        : `'where.${key}' ${mailFactValueProblem(variableOf(filterable[0]!, key)!, value)!} in every ${everywhere ? '' : 'built-in '}kind of email that has it${onlyYours}`);
    } else {
      accepted.set(key, new Set(matching.map((spec) => spec.id)));
    }
  }
  // Every `where` holds for ONE fact, so one kind must have them all.
  let candidates: readonly MailFactTypeSpec[] = kinds;
  if (accepted.size > 0 && accepted.size === variableKeys.length) {
    candidates = kinds.filter((spec) => [...accepted.values()].every((ids) => ids.has(spec.id)));
    if (candidates.length === 0) {
      unknown.push(`'where': ${noKind} has ${[...accepted.keys()].join(' and ')} with these values together${onlyYours}`);
      candidates = kinds;
    }
  }
  // `fields`: variables whose change wakes it, of a kind the `where` can match.
  for (const field of fieldNames) {
    if (!candidates.some((spec) => variableOf(spec, field) !== undefined)) {
      unknown.push(candidates === kinds
        ? `'fields': ${noKind} has a variable '${field}'${onlyYours}`
        : `'fields': no kind of email the 'where' matches has a variable '${field}'${onlyYours}`);
    }
  }
  return { errors, unknown };
};

/** A mail-fact entry's keys that are no part of one. */
const unknownMailFactKeys = (entry: object): string[] =>
  Object.keys(entry).filter((key) => !MAIL_FACT_ENTRY_KEYS.has(key) && !ENTRY_KEYS_REFUSED_ELSEWHERE.has(key));

const isCompilableFormResponseWhere = (where: unknown): boolean => {
  if (where === undefined) return true;
  if (where === null || typeof where !== 'object' || Array.isArray(where)) return false;
  return Object.entries(where).every(([key, value]) =>
    FORM_RESPONSE_WHERE_KEYS.has(key)
    && typeof value === 'string'
    && !value.includes('{{'));
};

/** Parsed `on:` value. `alias` fans across the live vendor registry at
 *  compile time; `vendor_entity` targets one vendor; the platform
 *  shorthands are fixed events. */
export type ParsedTriggerOn =
  | { kind: 'alias'; alias: string; verb: TriggerSugarVerb }
  | { kind: 'vendor_entity'; vendor: string; entity: string; verb: TriggerSugarVerb }
  | { kind: 'messenger' }
  | { kind: 'reception' }
  | { kind: 'form_response' }
  | { kind: 'mail_fact'; type: MailFactTypeId | null }
  | { kind: 'dom' };

/** Parse an `on:` string against the closed grammar. Returns null on any
 *  non-conforming value — callers (validator / compile) decide whether
 *  that's an authoring error or a skip. */
export const parseTriggerOn = (on: string): ParsedTriggerOn | null => {
  if (on === MESSENGER_ON_SHORTHAND) return { kind: 'messenger' };
  if (on === RECEPTION_ON_SHORTHAND) return { kind: 'reception' };
  if (on === FORM_RESPONSE_ON_SHORTHAND) return { kind: 'form_response' };
  if (on === ELEMENT_ON_SHORTHAND) return { kind: 'dom' };
  if (on === MAIL_FACT_ON_SHORTHAND) return { kind: 'mail_fact', type: null };
  // `mail_fact.<type>`, checked BEFORE the positional forms: a third part must
  // not be read as `<vendor>.<entity>.<verb>`, which compiles to a connection
  // pattern that never fires and never errors (D-315 §5.1).
  if (on.startsWith(MAIL_FACT_ON_PREFIX)) {
    const type = on.slice(MAIL_FACT_ON_PREFIX.length);
    return isMailFactTypeId(type) ? { kind: 'mail_fact', type } : null;
  }
  const segments = on.split('.');
  if (segments.length === 2) {
    const [alias, verb] = segments as [string, string];
    if (CRM_ALIAS_SET.has(alias) && VERB_SET.has(verb)) {
      return { kind: 'alias', alias, verb: verb as TriggerSugarVerb };
    }
    return null;
  }
  if (segments.length === 3) {
    const [vendor, entity, verb] = segments as [string, string, string];
    if (SEGMENT_RE.test(vendor) && SEGMENT_RE.test(entity) && VERB_SET.has(verb)) {
      return { kind: 'vendor_entity', vendor, entity, verb: verb as TriggerSugarVerb };
    }
    return null;
  }
  return null;
};

/** One compiled subscription — the reconciler materializes each as a
 *  trigger-store row. `filter` / `fields` are the row's dispatch-filter
 *  halves (see `matchesTriggerDispatchFilter`). */
export interface CompiledTriggerSubscription {
  pattern: string;
  filter?: Record<string, unknown>;
  fields?: string[];
}

/** Lower the sugar's `where` onto the dispatch-filter vocabulary (dotted
 *  paths into the event payload, scalar equality — the SAME semantics the
 *  raw form's `filter` field has always documented):
 *    - `id`        → `record_id` (present on EVERY event, all sources —
 *                    the one universally reliable narrowing)
 *    - any other k → `record.<k>` (the canonical projection riding
 *                    poll-sourced events; absent on doorbell-shaped
 *                    reconciler events → passes, see module header) */
export const whereToDispatchFilter = (
  where: Record<string, string | number | boolean>,
): Record<string, unknown> => {
  const filter: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(where)) {
    filter[key === 'id' ? 'record_id' : `record.${key}`] = value;
  }
  return filter;
};

/** The platform-reference emit convention (D-128; both the vendor
 *  reconcilers and the watch poll loop): path =
 *  `data.connection.api.<vendor>.<entity>.<connection_name>.<entity>.<kind>`.
 *  Without a connection the compile uses the shipped corpus form
 *  `data.connection.api.<vendor>.<entity>.**.<kind>` (`**` spans the
 *  connection + entity_type segments) — `parseWatchDemandFromPattern`
 *  reads the wildcard sixth segment as vendor-wide demand, a literal one
 *  as connection-narrowed demand. */
const platformReferencePattern = (
  vendor: string,
  entity: string,
  kind: string,
  connection: string | undefined,
): string =>
  connection === undefined
    ? `data.connection.api.${vendor}.${entity}.**.${kind}`
    : `data.connection.api.${vendor}.${entity}.${connection}.${entity}.${kind}`;

/** Compile one sugar entry into raw subscriptions. Returns null when the
 *  entry is not sugar (`on` missing / unparseable) — the caller falls back
 *  to its raw-entry path or skips. An ALIAS entry returns one subscription
 *  per live-registry entity carrying the alias (deduped per (vendor,
 *  entity)); zero registry coverage compiles to `[]` (the reconciler skips
 *  and re-fans automatically once a conforming pack registers — reconcile
 *  re-runs on every recipe-store mutation).
 *
 *  `connection` narrows positionally: the platform-reference connection
 *  segment, or the messenger vendor slug (the D-163 I-4 lock-step: a
 *  `connection.notification.<name>` row's name IS the transport vendor).
 *  An alias entry with a `connection` is a VALIDATOR ERROR — it would fan
 *  one never-firing governance row per non-owning vendor (connection names
 *  are unique per kind), and the author who knows the connection knows the
 *  vendor; the compile stays permissive for unvalidated paths and keeps
 *  the full fan. Reception endpoints are not connections — the validator
 *  rejects that combination too; the compile ignores `connection` there. */
export const compileTriggerSugarEntry = (
  entry: Pick<RecipeEventTrigger, 'on' | 'connection' | 'fields' | 'where' | 'url' | 'selector' | 'template_variable'>,
  vendorEntities: ReadonlyArray<Pick<ConnectionVendorEntity, 'vendor' | 'entity' | 'crm_alias'>>,
  options: TriggerSugarOptions = {},
): CompiledTriggerSubscription[] | null => {
  if (typeof entry.on !== 'string') return null;
  const parsed = parseTriggerOn(entry.on);
  if (parsed === null) return null;

  const whereRecord = entry.where !== null
    && typeof entry.where === 'object'
    && !Array.isArray(entry.where)
    ? entry.where
    : undefined;
  // Stored recipe JSON is still a runtime boundary. Validation rejects a
  // malformed `where`, but imports/legacy rows can reach reconciliation
  // directly; skip the sugar entry instead of throwing or dropping its
  // intended narrowing and over-firing.
  if (entry.where !== undefined && whereRecord === undefined) return [];
  const filter = whereRecord !== undefined && Object.keys(whereRecord).length > 0
    ? whereToDispatchFilter(whereRecord)
    : undefined;
  const fields = Array.isArray(entry.fields) && entry.fields.length > 0
    ? [...entry.fields]
    : undefined;
  const decorate = (pattern: string): CompiledTriggerSubscription => ({
    pattern,
    ...(filter !== undefined ? { filter } : {}),
    ...(fields !== undefined ? { fields } : {}),
  });

  switch (parsed.kind) {
    case 'alias': {
      const kind = TRIGGER_SUGAR_VERB_TO_KIND[parsed.verb];
      const seen = new Set<string>();
      const out: CompiledTriggerSubscription[] = [];
      for (const e of vendorEntities) {
        if (e.crm_alias !== parsed.alias) continue;
        const key = `${e.vendor}.${e.entity}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(decorate(platformReferencePattern(e.vendor, e.entity, kind, entry.connection)));
      }
      return out;
    }
    case 'vendor_entity': {
      const kind = TRIGGER_SUGAR_VERB_TO_KIND[parsed.verb];
      return [
        decorate(platformReferencePattern(parsed.vendor, parsed.entity, kind, entry.connection)),
      ];
    }
    case 'messenger':
      return [
        decorate(`data.${MESSENGER_EVENT_PLATFORM}.${entry.connection ?? '*'}.message.created`),
      ];
    case 'reception':
      return [decorate(`data.${RECEPTION_EVENT_PLATFORM}.*.request.created`)];
    case 'form_response':
      // Unlike open-ended canonical entity records, this event's routing
      // projection is closed. A malformed/unknown narrowing must materialize
      // nothing, never a missing-path filter that over-fires.
      if (!isCompilableFormResponseWhere(entry.where)) return [];
      return [decorate(FORM_RESPONSE_CREATED_EVENT_PATTERN)];
    case 'mail_fact': {
      // Strict like the form response: a narrowing no fact can match
      // materializes nothing, since an unvalidated recipe (an import, a legacy
      // row) reaches the compile directly — nor does a key that is no part of
      // one, which would leave it wider than written. What no KNOWN kind has
      // does materialize from a recipe — a kind made later may have it — and
      // not from a trigger made on this server, whose check knows every kind.
      // Only what the check takes: any other key, a `fields` that is no list of
      // names, or a value that is no literal would leave it wider than written
      // or dead (the check refuses each with its reason).
      if (Object.keys(entry).some((key) => !MAIL_FACT_ENTRY_KEYS.has(key))) return [];
      if (entry.fields !== undefined && (!Array.isArray(entry.fields) || entry.fields.length === 0
        || entry.fields.some((field) => typeof field !== 'string' || field.length === 0))) return [];
      if (whereRecord !== undefined && Object.values(whereRecord)
        .some((value) => !isScalar(value) || (typeof value === 'string' && value.includes('{{')))) return [];
      const { errors, unknown } = mailFactEntryProblems(parsed.type, entry.fields, entry.where, options);
      if (errors.length > 0 || (options.mailFactTypes !== undefined && unknown.length > 0)) return [];
      if (entry.template_variable === undefined) return [decorate(mailFactEventPattern(parsed.type))];
      // The recipe's own template (§5.1): the id its setting holds here. None
      // chosen, or a name that is no setting, and the row is not made — it
      // would wake for every template's facts, wider than written.
      if (typeof entry.template_variable !== 'string' || whereRecord?.template !== undefined) return [];
      const template = options.templateOf?.(entry.template_variable) ?? null;
      if (typeof template !== 'string' || template.length === 0) return [];
      return [{
        ...decorate(mailFactEventPattern(parsed.type)),
        filter: { ...(filter ?? {}), 'record.template': template },
      }];
    }
    case 'dom': {
      // url + selector are validator-required for the dom form; guard
      // defensively. `on` parsed (it IS sugar), so a malformed entry
      // compiles to `[]` (zero subscriptions — the reconciler skips, same
      // as alias-zero-coverage), NOT `null` (which means "not sugar" and
      // would route the caller to a non-existent raw fallback).
      if (typeof entry.url !== 'string' || entry.url.length === 0) return [];
      if (typeof entry.selector !== 'string' || entry.selector.length === 0) return [];
      const encoded = encodeDomWatchTarget(entry.url, entry.selector);
      // The poll source emits only `updated` (see ELEMENT_ON_SHORTHAND) —
      // compile a precise `.updated` tail, never `.**`.
      return [decorate(`data.${DOM_WATCH_PLATFORM}.element.${encoded}.updated`)];
    }
  }
};

/** The dispatch-filter halves a materialized trigger row carries. */
export interface TriggerDispatchFilter {
  /** Dotted paths into the dispatch payload → expected scalar. ALL
   *  entries must hold for the row to fire (single-object AND — the
   *  shape `RecipeEventTrigger.filter` has always documented). */
  filter?: Record<string, unknown> | undefined;
  /** Canonical field keys — fire only when the event's `changed_fields`
   *  intersects (any-of). */
  fields?: string[] | undefined;
}

/** Resolve a dotted path over nested plain objects. No array indexing —
 *  filter paths address payload/record fields, not collections. */
const resolvePath = (root: Record<string, unknown>, path: string): unknown => {
  let cursor: unknown = root;
  for (const segment of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
};

/** Evaluate a row's dispatch filter against the event payload view
 *  (`TriggerEventPayload` shape: `record_id` / `platform` / `slug` /
 *  `entity_type` always present; `prev` / `record` / `changed_fields`
 *  ride fat poll- and reconciler-/webhook-sourced entity events).
 *
 *  MISSING-PATH POSTURE — PASS, never block: a filter entry whose payload
 *  path resolves to `undefined`, and a `fields` gate on an event without
 *  `changed_fields`, both PASS. Every entity-change source now emits fat
 *  (poll loop, reconciler cycle, webhook funnel — the reconciler's meta
 *  snapshot IS the canonical projection vocabulary), but doorbell shapes
 *  remain in the wild: messenger / reception arrivals, adapter emits, and
 *  reconciler updates whose prior row carried no meta. A blocking posture
 *  would make a filtered recipe source-DEPENDENT (alive on fat sources,
 *  silently dead on doorbell ones), the exact trap this substrate keeps
 *  closing.
 *  Over-fire-and-let-the-recipe-gate beats silent-dead; the recipe's own
 *  `skip_when` remains the correctness gate (design § 5). A PRESENT path
 *  compares strict-equal (scalar literals).
 *
 *  ⛔ EXCEPT A MAIL FACT (D-315 §5.1): its event is never a doorbell — the
 *  record carries every variable of its kind (`null` when unread) and
 *  `changed_fields` always. A path it lacks is a variable its KIND does not
 *  have, and a fact trigger watches variables whatever kind has them, so
 *  passing it would wake a `where: { notice: "price_change" }` for every
 *  purchase. On a fact, a missing path is no match.
 *
 *  ⛔ And a new email that changed nothing but the thing's `last_email_at`
 *  wakes only a row whose `fields` name it (ruling 44): "every change" (no
 *  `fields`) means a change of what the thing SAYS, so a carrier's daily
 *  "still in transit" wakes only the recipe that asked for every email.
 *  ⚠ The dispatcher calls this for every fact event, filter or not. */
export const matchesTriggerDispatchFilter = (
  row: TriggerDispatchFilter,
  payload: Record<string, unknown>,
): boolean => {
  const strict = payload.platform === MAIL_FACT_EVENT_PLATFORM;
  if (strict) {
    // An UPDATE whose only change is the time. A creation always counts: it
    // carries no `prev`, and one that read nothing lists the time alone.
    const changed = payload.changed_fields;
    const timeOnly = payload.prev !== undefined
      && Array.isArray(changed) && changed.length === 1 && changed[0] === MAIL_FACT_LAST_EMAIL_AT;
    if (timeOnly && !(row.fields ?? []).includes(MAIL_FACT_LAST_EMAIL_AT)) return false;
  }
  if (row.fields !== undefined && row.fields.length > 0) {
    const changed = payload.changed_fields;
    if (Array.isArray(changed)) {
      const changedSet = new Set(changed.filter((c): c is string => typeof c === 'string'));
      if (!row.fields.some((f) => changedSet.has(f))) return false;
    } else if (strict) {
      return false;
    }
  }
  if (row.filter !== undefined) {
    for (const [path, expected] of Object.entries(row.filter)) {
      const actual = resolvePath(payload, path);
      if (actual === undefined) {
        if (strict) return false;
        continue;
      }
      if (actual !== expected) return false;
    }
  }
  return true;
};

const isScalar = (v: unknown): v is string | number | boolean =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/** Mirror of the warehouse bus subscribe grammar
 *  (`@recued/warehouse-events` glob.ts `isValidPattern` — contracts
 *  cannot import that package, and the grammar is pinned by the bus's
 *  own doc: non-empty dot-delimited segments, each `*` / `**` or a
 *  literal of `[A-Za-z0-9_-]+`). Validating raw `event` patterns HERE
 *  closes the silent-dead gap where a typo'd pattern passed
 *  `validateRecipe` and then materialized nothing at reconcile time
 *  (codex MEDIUM fold). */
const isValidBusPattern = (pattern: string): boolean => {
  if (pattern.length === 0) return false;
  for (const seg of pattern.split('.')) {
    if (seg === '*' || seg === '**') continue;
    if (seg.length === 0 || !/^[A-Za-z0-9_-]+$/.test(seg)) return false;
  }
  return true;
};

/** A part of a raw `event` pattern that a dish's setting fills (2026-10-05):
 *  `data.file.{{config.file_slug}}.*.created` watches the folder each dish
 *  names, where `data.file.*.*.created` started a run for a file in every
 *  folder and the recipe had to stop the ones it did not want. The reconciler
 *  writes the value into each dish's row (`resolveEventPatternSettings`). */
const SETTING_SEGMENT_RE = /^\{\{config\.([A-Za-z0-9_]+)\}\}$/;

/** A setting may fill a part only after the first two: those say what kind
 *  of event it is (`data.file`, `run.<recipe>`), and a setting there would let
 *  a dish change what the recipe watches, not just where. */
const FIRST_SETTING_SEGMENT = 2;

/** A raw pattern's parts. ⛔ Split on the dots OUTSIDE `{{…}}`: a setting
 *  part holds a dot of its own (`{{config.file_slug}}`), and a plain
 *  `split('.')` cuts it in two. */
export const eventPatternSegments = (pattern: string): string[] => {
  const segments: string[] = [];
  let current = '';
  let open = 0;
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern.startsWith('{{', i)) {
      open += 1;
      current += '{{';
      i += 1;
    } else if (open > 0 && pattern.startsWith('}}', i)) {
      open -= 1;
      current += '}}';
      i += 1;
    } else if (open === 0 && pattern[i] === '.') {
      segments.push(current);
      current = '';
    } else {
      current += pattern[i];
    }
  }
  segments.push(current);
  return segments;
};

/** The setting a pattern part names (`{{config.<setting>}}`), or null. */
export const settingOfEventSegment = (segment: string): string | null =>
  SETTING_SEGMENT_RE.exec(segment)?.[1] ?? null;

/** The settings a raw pattern's parts name, in order. */
export const eventPatternSettings = (pattern: string): string[] =>
  eventPatternSegments(pattern).flatMap((segment) => {
    const setting = settingOfEventSegment(segment);
    return setting === null ? [] : [setting];
  });

/** A raw pattern with each setting part filled from `valueOf`: what one dish's
 *  trigger subscribes to. Null when a setting holds no value that is ONE plain
 *  part (`[A-Za-z0-9_-]+`): none chosen, or a value that would widen the
 *  pattern (`*`) or shift its parts (`.`). The row is then not made, as a
 *  D-315 template trigger with no template is not (`compileTriggerSugarEntry`). */
export const resolveEventPatternSettings = (
  pattern: string,
  valueOf: (setting: string) => unknown,
): string | null => {
  const parts: string[] = [];
  for (const segment of eventPatternSegments(pattern)) {
    const setting = settingOfEventSegment(segment);
    if (setting === null) {
      parts.push(segment);
      continue;
    }
    const value = valueOf(setting);
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
    parts.push(value);
  }
  return parts.join('.');
};

/** Why a raw pattern's setting parts are malformed, or null. A `{{` must be
 *  a whole part naming a setting, after the first two parts. */
const eventPatternSettingProblem = (pattern: string): string | null => {
  const segments = eventPatternSegments(pattern);
  for (const [index, segment] of segments.entries()) {
    if (!segment.includes('{{') && !segment.includes('}}')) continue;
    if (settingOfEventSegment(segment) === null) {
      return `a part of 'event' can be a setting only as the whole part, written {{config.<setting>}} — got ${JSON.stringify(segment)}`;
    }
    if (index < FIRST_SETTING_SEGMENT) {
      return `a setting can fill a part of 'event' only after its first two, as in 'data.file.{{config.file_slug}}.*.created' — those two say what kind of event it is`;
    }
  }
  return null;
};

/** The pattern with each setting part read as a plain one, for the grammar
 *  checks a filled pattern must pass. */
const withSettingsAsParts = (pattern: string): string =>
  eventPatternSegments(pattern)
    .map((segment) => (settingOfEventSegment(segment) === null ? segment : 'setting'))
    .join('.');

/** Validate one `event_triggers` entry (raw or sugar) against the closed
 *  grammar. Returns human-readable problems (empty = well-formed). Pure +
 *  registry-free so the portable recipe validator and the server share ONE
 *  rule set; which vendors an alias fans to is the reconciler's live-
 *  registry concern, not a validity question.
 *
 *  Literal-only pin: `connection` and `where` values must be literals —
 *  the dispatch filter compares at dispatch time with no config
 *  resolution, so a `{{config.*}}` ref would never match (a silent dead
 *  subscription). Fail loud here instead. A raw `event` pattern is the one
 *  place a setting resolves: a whole part written `{{config.<setting>}}`,
 *  filled per dish when its row is made (`resolveEventPatternSettings`).
 *  Whether the recipe declares that setting is the recipe validator's check
 *  (`validateEventTriggers`); this one sees the entry alone. */
export const validateRecipeEventTriggerEntry = (entry: unknown, options: TriggerSugarOptions = {}): string[] => {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return ['entry must be an object'];
  }
  const e = entry as Record<string, unknown>;
  const problems: string[] = [];
  const hasEvent = e.event !== undefined;
  const hasOn = e.on !== undefined;
  if (hasEvent === hasOn) {
    problems.push("declare exactly one of 'event' (raw bus pattern) or 'on' (canonical sugar)");
    return problems;
  }

  if (hasEvent) {
    const settingProblem = typeof e.event === 'string' ? eventPatternSettingProblem(e.event) : null;
    if (typeof e.event !== 'string' || e.event.length === 0) {
      problems.push("'event' must be a non-empty bus pattern string");
    } else if (settingProblem !== null) {
      problems.push(settingProblem);
    } else if (!isValidBusPattern(withSettingsAsParts(e.event))) {
      problems.push(
        `'event' is not a valid bus pattern (dot-delimited segments of [A-Za-z0-9_-], '*', or '**') — got ${JSON.stringify(e.event)}`,
      );
    } else if (isUnmatchableDomWatchPattern(withSettingsAsParts(e.event))) {
      // Matchable-tail (brick-1-deferred): a dom-element pattern that can
      // never match the only emitted shape `data.dom.element.<target>.updated`
      // — tailless (`…<target>`), wrong kind (`…<target>.created`/`.deleted`
      // — the source emits ONLY `updated`), or overlong — is a silently-dead
      // subscription. Use `.updated`, a spanning `.**`, or a `.*` kind.
      problems.push(
        `'event' targets a dom watch but can never match an emitted 'data.dom.element.<target>.updated' event (use '.updated', '.*', or a spanning '.**' tail); got ${JSON.stringify(e.event)}`,
      );
    }
    for (const sugarOnly of ['connection', 'fields', 'where', 'template_variable'] as const) {
      if (e[sugarOnly] !== undefined) {
        problems.push(`'${sugarOnly}' requires the 'on' form — a raw 'event' entry narrows via its pattern / 'filter'`);
      }
    }
    for (const domOnly of ['url', 'selector'] as const) {
      if (e[domOnly] !== undefined) {
        problems.push(`'${domOnly}' belongs to the dom watch sugar ('on': '${ELEMENT_ON_SHORTHAND}') — a raw 'event' entry encodes the target in its pattern`);
      }
    }
    if (e.filter !== undefined) {
      if (e.filter === null || typeof e.filter !== 'object' || Array.isArray(e.filter)) {
        problems.push("'filter' must be an object of payload-path → literal");
      } else {
        for (const [k, v] of Object.entries(e.filter)) {
          if (!isScalar(v)) {
            problems.push(`'filter.${k}' must be a scalar literal (string / number / boolean)`);
          }
        }
      }
    }
    return problems;
  }

  const parsed = typeof e.on === 'string' ? parseTriggerOn(e.on) : null;
  if (parsed === null) {
    if (typeof e.on === 'string' && e.on.startsWith(MAIL_FACT_ON_PREFIX)) {
      const [type, ...rest] = e.on.slice(MAIL_FACT_ON_PREFIX.length).split('.');
      problems.push(
        rest.length > 0 && isMailFactTypeId(type)
          ? `'${e.on}': a mail-fact trigger takes no verb — '${MAIL_FACT_ON_PREFIX}${type}' wakes on the thing's creation and on every change; narrow with 'fields' and 'where'`
          : `'${e.on}' names no kind of email — use '${MAIL_FACT_ON_PREFIX}<kind>' with one of ${MAIL_FACT_BUILTIN_TYPES.map((t) => t.id).join(', ')} or a kind made on the server, or '${MAIL_FACT_ON_SHORTHAND}' for any kind`,
      );
      return problems;
    }
    problems.push(
      `'on' must be '<crm_alias>.<verb>', '<vendor>.<entity>.<verb>' (verbs: ${TRIGGER_SUGAR_VERBS.join(' | ')}), '${MESSENGER_ON_SHORTHAND}', '${RECEPTION_ON_SHORTHAND}', '${FORM_RESPONSE_ON_SHORTHAND}', '${MAIL_FACT_ON_SHORTHAND}', '${MAIL_FACT_ON_PREFIX}<kind>', or '${ELEMENT_ON_SHORTHAND}' (got ${JSON.stringify(e.on)})`,
    );
    return problems;
  }
  if (e.filter !== undefined) {
    problems.push("'filter' belongs to the raw 'event' form — the 'on' form narrows via 'where'");
  }
  if (e.template_variable !== undefined && parsed.kind !== 'mail_fact') {
    problems.push("'template_variable' applies only to a mail-fact trigger — it names the template whose facts wake it");
  }
  // url / selector are the dom-watch sugar's REQUIRED target, and apply to
  // NO other form.
  if (parsed.kind === 'dom') {
    for (const [field, value] of [['url', e.url], ['selector', e.selector]] as const) {
      if (value === undefined) {
        problems.push(`'${field}' is required for the dom watch sugar ('on': '${ELEMENT_ON_SHORTHAND}')`);
      } else if (typeof value !== 'string' || value.length === 0) {
        problems.push(`'${field}' must be a non-empty literal string`);
      } else if (value.includes('{{')) {
        problems.push(`'${field}' must be a literal — refs cannot resolve at compile/dispatch time; it encodes the watched target`);
      } else if (field === 'url' && /\s/.test(value)) {
        // The (url, selector) codec joins on a single space (a Chrome match
        // pattern is whitespace-free; the selector half may carry spaces).
        // Whitespace in the url would split the target at the wrong boundary
        // and silently watch the wrong thing — reject it here.
        problems.push("'url' must be a whitespace-free Chrome match pattern (it is the space-delimited first half of the watch target)");
      }
    }
  } else {
    for (const domOnly of ['url', 'selector'] as const) {
      if (e[domOnly] !== undefined) {
        problems.push(`'${domOnly}' applies only to the dom watch sugar ('on': '${ELEMENT_ON_SHORTHAND}')`);
      }
    }
  }
  if (e.connection !== undefined) {
    if (parsed.kind === 'reception') {
      problems.push("'connection' does not apply to 'reception.request' — reception endpoints are not connections (narrow via where.kind)");
    } else if (parsed.kind === 'form_response') {
      problems.push(`'connection' does not apply to '${FORM_RESPONSE_ON_SHORTHAND}' — accepted form responses are not connection-scoped (narrow via where.form_definition_id or where.endpoint_id)`);
    } else if (parsed.kind === 'dom') {
      problems.push(`'connection' does not apply to '${ELEMENT_ON_SHORTHAND}' — a dom watch has no connection record; it binds to bridges that granted the watched origin`);
    } else if (parsed.kind === 'mail_fact') {
      problems.push("'connection' does not apply to a mail fact — a fact is read from every mailbox; narrow via 'where'");
    } else if (parsed.kind === 'alias') {
      // An alias form fans across EVERY vendor carrying the alias, but a
      // connection belongs to exactly one vendor — the combination mints
      // a known-dead row per non-owning vendor (it lists in governance
      // and can never fire — codex MEDIUM fold). The author who knows
      // the connection knows the vendor; the vendor form is the tool.
      problems.push(
        `'connection' with an alias form would fan never-firing rows for the connection's non-owning vendors — use '<vendor>.<entity>.${parsed.verb}' with the connection instead`,
      );
    } else if (typeof e.connection !== 'string' || !CONNECTION_NAME_RE.test(e.connection)) {
      problems.push(
        "'connection' must be a literal connection name (lowercase, digits, hyphens) — config refs cannot resolve at dispatch; narrow in recipe skip_when instead",
      );
    }
  }
  if (e.fields !== undefined) {
    if (parsed.kind === 'messenger' || parsed.kind === 'reception' || parsed.kind === 'form_response') {
      problems.push("'fields' applies to entity change events only — messenger/reception/form-response arrivals carry no changed_fields");
    } else if (parsed.kind === 'dom') {
      problems.push(`'fields' does not apply to '${ELEMENT_ON_SHORTHAND}' — a dom watch carries only the element's text; narrow via 'where' on the text value instead`);
    } else if (
      !Array.isArray(e.fields)
      || e.fields.length === 0
      || e.fields.some((f) => typeof f !== 'string' || f.length === 0)
    ) {
      problems.push("'fields' must be a non-empty array of canonical field keys");
    }
  }
  if (e.where !== undefined) {
    if (e.where === null || typeof e.where !== 'object' || Array.isArray(e.where)) {
      problems.push("'where' must be a flat object of field → literal");
    } else {
      for (const [k, v] of Object.entries(e.where)) {
        if (k.length === 0) {
          problems.push("'where' keys must be non-empty field names");
        } else if (!isScalar(v)) {
          problems.push(`'where.${k}' must be a scalar literal (string / number / boolean)`);
        } else if (typeof v === 'string' && v.includes('{{')) {
          problems.push(`'where.${k}' must be a literal — refs cannot resolve at dispatch; gate in recipe skip_when instead`);
        } else if (k === 'id' && typeof v !== 'string') {
          problems.push("'where.id' must be a string record id");
        }
      }
      if (parsed.kind === 'form_response') {
        for (const [k, v] of Object.entries(e.where)) {
          if (!FORM_RESPONSE_WHERE_KEYS.has(k)) {
            problems.push(
              `'where.${k}' is not carried by '${FORM_RESPONSE_ON_SHORTHAND}' — use id, endpoint_id, or form_definition_id`,
            );
          } else if (typeof v !== 'string') {
            problems.push(`'where.${k}' must be a string id for '${FORM_RESPONSE_ON_SHORTHAND}'`);
          }
        }
      }
    }
  }
  if (parsed.kind === 'mail_fact') {
    for (const key of unknownMailFactKeys(e)) {
      problems.push(`'${key}' is not part of a mail-fact trigger — it takes 'on', 'fields', 'where' and 'template_variable'`);
    }
    if (e.template_variable !== undefined) {
      if (typeof e.template_variable !== 'string' || e.template_variable.length === 0) {
        problems.push("'template_variable' must name one of the recipe's mail_template variables");
      } else if (e.where !== null && typeof e.where === 'object' && !Array.isArray(e.where)
        && (e.where as Record<string, unknown>).template !== undefined) {
        problems.push("'template_variable' and 'where.template' each name the template — keep one");
      }
    }
    const { errors, unknown } = mailFactEntryProblems(parsed.type, e.fields, e.where, options);
    problems.push(...errors);
    // A check that knows every kind refuses what none has; a recipe's notes it.
    if (options.mailFactTypes !== undefined) problems.push(...unknown);
  }
  return problems;
};

/** What a recipe's mail-fact trigger names that no built-in kind of email has
 *  (D-315 §5.1): a kind made on a server, or — on a trigger on any kind — a
 *  variable, a value, or a set of them together. Not a refusal — a kind the
 *  owner makes on their server may have it — but it starts for no one who has
 *  not made one, so the author is told. Empty for a check that knows every
 *  kind (`options.mailFactTypes`), which refuses these instead, and for any
 *  other trigger. */
export const recipeEventTriggerNotes = (entry: unknown, options: TriggerSugarOptions = {}): string[] => {
  if (options.mailFactTypes !== undefined || entry === null || typeof entry !== 'object' || Array.isArray(entry)) return [];
  const e = entry as Record<string, unknown>;
  if (e.event !== undefined || typeof e.on !== 'string') return [];
  const parsed = parseTriggerOn(e.on);
  if (parsed?.kind !== 'mail_fact') return [];
  return mailFactEntryProblems(parsed.type, e.fields, e.where, options).unknown;
};
