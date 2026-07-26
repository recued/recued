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
 *    on: "form_response.accepted"       ⚠ a SUBMITTED intake response, NOT an
 *                                       approved one. D-210 WS2 moved the
 *                                       canonical log write to SUBMIT ("submit
 *                                       IS the acceptance now"), so this fires
 *                                       on UNREVIEWED visitor input. To act on
 *                                       what the owner APPROVED, watch the
 *                                       destination entity's own `created`
 *                                       event instead — that is written on the
 *                                       approve leg.
 *                                       (`data.form_response.accepted.response.created`)
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
 *  filter is a best-effort NOISE ABSORBER, never a correctness gate: an
 *  entry whose payload path is absent PASSES (see
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
  | { kind: 'dom' };

/** Parse an `on:` string against the closed grammar. Returns null on any
 *  non-conforming value — callers (validator / compile) decide whether
 *  that's an authoring error or a skip. */
export const parseTriggerOn = (on: string): ParsedTriggerOn | null => {
  if (on === MESSENGER_ON_SHORTHAND) return { kind: 'messenger' };
  if (on === RECEPTION_ON_SHORTHAND) return { kind: 'reception' };
  if (on === FORM_RESPONSE_ON_SHORTHAND) return { kind: 'form_response' };
  if (on === ELEMENT_ON_SHORTHAND) return { kind: 'dom' };
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
  entry: Pick<RecipeEventTrigger, 'on' | 'connection' | 'fields' | 'where' | 'url' | 'selector'>,
  vendorEntities: ReadonlyArray<Pick<ConnectionVendorEntity, 'vendor' | 'entity' | 'crm_alias'>>,
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
 *  compares strict-equal (scalar literals). */
export const matchesTriggerDispatchFilter = (
  row: TriggerDispatchFilter,
  payload: Record<string, unknown>,
): boolean => {
  if (row.fields !== undefined && row.fields.length > 0) {
    const changed = payload.changed_fields;
    if (Array.isArray(changed)) {
      const changedSet = new Set(changed.filter((c): c is string => typeof c === 'string'));
      if (!row.fields.some((f) => changedSet.has(f))) return false;
    }
  }
  if (row.filter !== undefined) {
    for (const [path, expected] of Object.entries(row.filter)) {
      const actual = resolvePath(payload, path);
      if (actual === undefined) continue;
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

/** Validate one `event_triggers` entry (raw or sugar) against the closed
 *  grammar. Returns human-readable problems (empty = well-formed). Pure +
 *  registry-free so the portable recipe validator and the server share ONE
 *  rule set; which vendors an alias fans to is the reconciler's live-
 *  registry concern, not a validity question.
 *
 *  Literal-only pin: `connection` and `where` values must be literals —
 *  the dispatch filter compares at dispatch time with no config
 *  resolution, so a `{{config.*}}` ref would never match (a silent dead
 *  subscription). Fail loud here instead; per-install narrowing stays in
 *  recipe-side `skip_when` until dispatch-time config resolution lands. */
export const validateRecipeEventTriggerEntry = (entry: unknown): string[] => {
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
    if (typeof e.event !== 'string' || e.event.length === 0) {
      problems.push("'event' must be a non-empty bus pattern string");
    } else if (!isValidBusPattern(e.event)) {
      problems.push(
        `'event' is not a valid bus pattern (dot-delimited segments of [A-Za-z0-9_-], '*', or '**') — got ${JSON.stringify(e.event)}`,
      );
    } else if (isUnmatchableDomWatchPattern(e.event)) {
      // Matchable-tail (brick-1-deferred): a dom-element pattern that can
      // never match the only emitted shape `data.dom.element.<target>.updated`
      // — tailless (`…<target>`), wrong kind (`…<target>.created`/`.deleted`
      // — the source emits ONLY `updated`), or overlong — is a silently-dead
      // subscription. Use `.updated`, a spanning `.**`, or a `.*` kind.
      problems.push(
        `'event' targets a dom watch but can never match an emitted 'data.dom.element.<target>.updated' event (use '.updated', '.*', or a spanning '.**' tail); got ${JSON.stringify(e.event)}`,
      );
    }
    for (const sugarOnly of ['connection', 'fields', 'where'] as const) {
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
    problems.push(
      `'on' must be '<crm_alias>.<verb>', '<vendor>.<entity>.<verb>' (verbs: ${TRIGGER_SUGAR_VERBS.join(' | ')}), '${MESSENGER_ON_SHORTHAND}', '${RECEPTION_ON_SHORTHAND}', '${FORM_RESPONSE_ON_SHORTHAND}', or '${ELEMENT_ON_SHORTHAND}' (got ${JSON.stringify(e.on)})`,
    );
    return problems;
  }
  if (e.filter !== undefined) {
    problems.push("'filter' belongs to the raw 'event' form — the 'on' form narrows via 'where'");
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
  return problems;
};
