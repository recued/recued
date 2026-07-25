/** D-192 S4c3 — the Dynamics 365 engagement leaf.
 *
 *  THE only Dynamics-specific code (the D-192 "prefer-as-pack" payoff — everything
 *  else is the declaration `community/packs/dynamics.json` + the generic substrate).
 *  Implements `GenericEngagementLeaf` for the four Dataverse activity entities
 *  (email / appointment / phonecall / task, all `activitypointer` subtypes) so a
 *  Dynamics connection reconciles its engagement plane through
 *  `buildGenericEngagementReconciler` with no bespoke dispatch. One leaf serves all
 *  four — `entity.entity` selects the entity set + the projector.
 *
 *  The generic reconciler owns the drain (`odata-delta.ts` closures) + the flat
 *  `meta` projection (declaratively from `meta_fields[].source_path`); this leaf
 *  owns only the irreducible per-vendor bits:
 *    - `project` — the evidence-quality state machines (authorship / direction /
 *      lifecycle_state / event_at / body_state / tz) that CANNOT be declared. Modeled
 *      on the Salesforce reconcilers (`salesforce/task-engagement-reconciler.ts` +
 *      `engagement-shared.ts`).
 *    - `mapEdges` — the participant fan-out. v1 maps the OWNER (`_ownerid_value`) +
 *      the REGARDING record (`_regardingobjectid_value` + its
 *      `…lookuplogicalname` annotation), the analog of the Salesforce
 *      WhoId/WhatId fallback (`task-engagement-reconciler.ts`) when the junction
 *      isn't queried; the full `activityparty` fan-out (from/to/cc via `$expand`) is
 *      a follow-up (change-tracking + `$expand` interplay).
 *
 *  Registered via `registerEngagementLeaf('dynamics', …)` — `registerDynamicsEngagementLeaf`
 *  is called from `compose-generic-engagement-reconciliation.ts` with the HTTP deps.
 *
 *  Spec: D-192 (S4c3); survey Wall-D leaf. */

import {
  canonicalizeEmail,
  composePlatformRecordTargetId,
  resolveBearerAccessToken,
  type ConnectionRecord,
  type ConnectionVendorEntity,
  type Direction,
  type EngagementLifecycleState,
  type EngagementRow,
} from '@recued/contracts';

import type { ContactRedirectLookup, UpsertEdgeInput } from '../../storage/engagement-store.js';
import type {
  GenericEngagementEdgeInput,
  GenericEngagementLeaf,
  GenericEngagementProjectInput,
} from '../generic-engagement-reconciler.js';
import { registerEngagementLeaf } from '../engagement-leaf-registry.js';
import { parseIsoMs, pickInlineBodyState } from '../salesforce/engagement-shared.js';
import { resolveEngagementTzHint } from '../hubspot/engagement-shared.js';
import {
  buildDataverseDeltaDeps,
  isDataverseResync,
  type DynamicsFetch,
} from './odata-delta.js';
import type { IdKeyedDeltaDeps } from '../../file-source-adapters/id-keyed-delta.js';

// ────────────────────────────────────────────────────────────────
// Deps + per-entity config
// ────────────────────────────────────────────────────────────────

export interface DynamicsEngagementLeafDeps {
  /** OData fetch — the real `fetch` in prod, a fake in tests. */
  fetch: DynamicsFetch;
  /** D-138 contact-identity redirect for contact edges (the store requires it on
   *  every `edge_type:'contact'` write). Defaults to a no-op passthrough. */
  resolveContactRedirect?: ContactRedirectLookup;
  /** Per-pair `prefs.timezone` reader for the tz fallback chain (Dataverse stamps
   *  UTC, so the hint is inferred). */
  prefsTimezone?: () => string | null | undefined;
  /** Fallback IANA tz when prefs falls through. */
  defaultTzHint?: string;
}

/** Per-entity Dataverse config — the entity-set name (OData collection) + the
 *  `$select` superset the projector reads (the declared meta source_paths PLUS the
 *  derived-field logical names: modifiedon/createdon/statecode + owner/regarding
 *  lookups + entity-specific state fields). */
const ENTITY_CONFIG: Record<string, { set: string; select: string }> = {
  email: {
    set: 'emails',
    // `torecipients` (semicolon-delimited To addresses) + `sender` (From address) are
    // DIRECT string fields on the Dataverse email — the participant emails the
    // contact-edge linkage needs, without an activityparty `$expand` (change-tracking
    // forbids `$expand`; the other activity types' participants stay a follow-up).
    select: 'activityid,modifiedon,createdon,statecode,subject,directioncode,senton,description,torecipients,sender,_ownerid_value,_regardingobjectid_value',
  },
  appointment: {
    set: 'appointments',
    select: 'activityid,modifiedon,createdon,statecode,subject,scheduledstart,scheduledend,description,_ownerid_value,_regardingobjectid_value',
  },
  phonecall: {
    set: 'phonecalls',
    select: 'activityid,modifiedon,createdon,statecode,subject,directioncode,actualdurationminutes,actualstart,description,_ownerid_value,_regardingobjectid_value',
  },
  task: {
    set: 'tasks',
    select: 'activityid,modifiedon,createdon,statecode,subject,scheduledend,actualend,description,_ownerid_value,_regardingobjectid_value',
  },
};

const LOOKUP_ANNOTATION = '@Microsoft.Dynamics.CRM.lookuplogicalname';

// ────────────────────────────────────────────────────────────────
// Raw-record readers
// ────────────────────────────────────────────────────────────────

const readStr = (raw: Record<string, unknown>, key: string): string | null => {
  const v = raw[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
};
const readBool = (raw: Record<string, unknown>, key: string): boolean | null => {
  const v = raw[key];
  return v === true ? true : v === false ? false : null;
};
const readNum = (raw: Record<string, unknown>, key: string): number | null => {
  const v = raw[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};

const directionFromCode = (code: boolean | null): Direction =>
  code === true ? 'outbound' : code === false ? 'inbound' : 'unknown';

/** Split a Dataverse address field (`torecipients` is `;`-delimited; `sender` is a
 *  single address) and canonicalize each through the CONTRACTS `canonicalizeEmail`
 *  — the SAME function `resolveContactIdentity` runs at ingest. Invalid entries
 *  (garbage a user typed, `a@@b`, a display-name-only party) canonicalize to `''`
 *  and are dropped HERE, so a malformed recipient can never reach the store's
 *  transactional contact-edge resolution + throw the whole email's ingest (the
 *  lenient header parser the HubSpot reconciler uses does NOT pre-validate this). */
const strictParticipantEmails = (raw: string | null): string[] => {
  if (raw === null) return [];
  const out: string[] = [];
  for (const part of raw.split(/[;,\n]/)) {
    const canonical = canonicalizeEmail(part.trim());
    if (canonical.length > 0) out.push(canonical);
  }
  return out;
};

// ────────────────────────────────────────────────────────────────
// Projection
// ────────────────────────────────────────────────────────────────

/** The common EngagementRow skeleton every activity type shares; the per-entity
 *  projector overrides `direction` / `lifecycle_state` / `event_at` / time fields /
 *  `body_state`. */
const baseRow = (
  entity: string,
  input: GenericEngagementProjectInput,
  deps: DynamicsEngagementLeafDeps,
): EngagementRow => {
  const { connection_id, raw, target_id, meta, now } = input;
  const vendor_created_at = parseIsoMs(raw.createdon) ?? now;
  const vendor_modified_at = parseIsoMs(raw.modifiedon) ?? vendor_created_at;
  // Dataverse stamps UTC (no numeric offset), so the tz always resolves through the
  // prefs → UTC fallback and lands inferred.
  const tz = resolveEngagementTzHint({
    vendorTzHint: undefined,
    calendarAdapterTzHint: deps.defaultTzHint,
    prefsTimezone: deps.prefsTimezone,
  });
  const row: EngagementRow = {
    connection_id,
    target_id,
    vendor: 'dynamics',
    entity,
    meta,
    mirror_blob_hash: null,
    authorship: 'crm_user', // a CRM-logged activity; refine via _createdby vs _ownerid later
    direction: 'unknown',
    dedupe_confidence: 'none',
    lifecycle_state: 'point_in_time',
    event_at: null,
    vendor_created_at,
    vendor_modified_at,
    ingested_at: now,
    body_state: 'none',
    event_at_tz_hint: tz.tz,
  };
  if (tz.inferred) row.event_at_tz_inferred = true;
  if (typeof raw.modifiedon === 'string') {
    row.vendor_modstamp = raw.modifiedon;
    row.vendor_raw_timestamp = raw.modifiedon;
  }
  return row;
};

/** Attach an inline body (from `description`) — shared across the activity types
 *  that carry one. */
const applyBody = (row: EngagementRow, raw: Record<string, unknown>): void => {
  const body = readStr(raw, 'description') ?? '';
  const state = pickInlineBodyState(body);
  row.body_state = state.body_state;
  if ('body_inline' in state && state.body_inline !== undefined) row.body_inline = state.body_inline;
  if ('body_truncation_offset' in state && state.body_truncation_offset !== undefined) {
    row.body_truncation_offset = state.body_truncation_offset;
  }
};

const projectEmail = (input: GenericEngagementProjectInput, deps: DynamicsEngagementLeafDeps): EngagementRow => {
  const row = baseRow('email', input, deps);
  const raw = input.raw;
  row.direction = directionFromCode(readBool(raw, 'directioncode'));
  // An email is a point-in-time communication; `senton` is the touch time. A
  // cancelled draft is `statecode === 2`.
  row.lifecycle_state = readNum(raw, 'statecode') === 2 ? 'cancelled' : 'point_in_time';
  row.event_at = parseIsoMs(raw.senton);
  applyBody(row, raw);
  return row;
};

const projectPhonecall = (input: GenericEngagementProjectInput, deps: DynamicsEngagementLeafDeps): EngagementRow => {
  const row = baseRow('phonecall', input, deps);
  const raw = input.raw;
  row.direction = directionFromCode(readBool(raw, 'directioncode'));
  row.lifecycle_state = readNum(raw, 'statecode') === 2 ? 'cancelled' : 'point_in_time';
  // A logged call's touch time is when it started (falls back to modified).
  row.event_at = parseIsoMs(raw.actualstart) ?? row.vendor_modified_at;
  applyBody(row, raw);
  return row;
};

const projectAppointment = (input: GenericEngagementProjectInput, deps: DynamicsEngagementLeafDeps): EngagementRow => {
  const row = baseRow('appointment', input, deps);
  const raw = input.raw;
  row.direction = 'internal';
  const start = parseIsoMs(raw.scheduledstart);
  if (start !== null) row.scheduled_start_at = start;
  // Dataverse appointment statecode: 0=Open, 1=Completed, 2=Canceled, 3=Scheduled.
  // Cancellation is a terminal state (Salesforce events don't model it) — honor it
  // explicitly: it did NOT occur, so event_at stays null. Otherwise the
  // scheduled-vs-completed split is TIME-BASED (mirrors
  // `deriveSalesforceEventLifecycleState`): a past start is a completed touch at
  // that time; a future / unknown start stays scheduled with a NULL event_at (the
  // D-139 "not yet occurred" rule — event_at is never in the future, so
  // statecode 3=Scheduled can't be mis-read as completed).
  if (readNum(raw, 'statecode') === 2) {
    row.lifecycle_state = 'cancelled';
    row.event_at = null;
  } else {
    const occurred = start !== null && start <= input.now;
    row.lifecycle_state = occurred ? 'completed' : 'scheduled';
    row.event_at = occurred ? start : null;
  }
  applyBody(row, raw);
  return row;
};

const projectTask = (input: GenericEngagementProjectInput, deps: DynamicsEngagementLeafDeps): EngagementRow => {
  const row = baseRow('task', input, deps);
  const raw = input.raw;
  row.direction = 'internal';
  const statecode = readNum(raw, 'statecode');
  const lifecycle: EngagementLifecycleState =
    statecode === 1 ? 'completed' : statecode === 2 ? 'cancelled' : 'pending';
  row.lifecycle_state = lifecycle;
  const completedAt = parseIsoMs(raw.actualend);
  // A pending task hasn't occurred yet (null event_at); a completed one's touch
  // time is its completion (§ A.3.1).
  row.event_at = lifecycle === 'completed' ? completedAt : null;
  const dueAt = parseIsoMs(raw.scheduledend);
  if (dueAt !== null) row.due_at = dueAt;
  if (completedAt !== null) row.completed_at = completedAt;
  applyBody(row, raw);
  return row;
};

const PROJECTORS: Record<string, (input: GenericEngagementProjectInput, deps: DynamicsEngagementLeafDeps) => EngagementRow> = {
  email: projectEmail,
  appointment: projectAppointment,
  phonecall: projectPhonecall,
  task: projectTask,
};

// ────────────────────────────────────────────────────────────────
// Edges — owner + regarding (the SF WhoId/WhatId-fallback analog)
// ────────────────────────────────────────────────────────────────

const REGARDING_EDGE: Record<string, { edge_type: 'contact' | 'account' | 'deal'; entity: string }> = {
  contact: { edge_type: 'contact', entity: 'contact' },
  account: { edge_type: 'account', entity: 'account' },
  opportunity: { edge_type: 'deal', entity: 'opportunity' },
};

const mapEdges = (
  deps: DynamicsEngagementLeafDeps,
  entityName: string,
  input: GenericEngagementEdgeInput,
): UpsertEdgeInput[] => {
  const { connection_id, raw, target_id, now } = input;
  const edges: UpsertEdgeInput[] = [];
  const contactRedirect: ContactRedirectLookup = deps.resolveContactRedirect ?? ((): null => null);

  const owner = readStr(raw, '_ownerid_value');
  if (owner !== null) {
    edges.push({
      connection_id,
      engagement_target_id: target_id,
      edge_type: 'owner',
      target_kind: 'user',
      target_id: `dynamics_user:${owner}`,
      vendor: 'dynamics',
      created_at: now,
    });
  }

  // Email participant edges — the CONTACT linkage that lets the engagement score
  // under a contact (the `data.contact.engagements` resolver joins on
  // `edge_type='contact' AND target_id IN (<contact emails>)`, so the target_id MUST
  // be a canonical email, not a platform-reference GUID). Dataverse email carries the
  // addresses directly (`sender` + `torecipients`) — the analog of the HubSpot email
  // reconciler's header-derived `data.contact` edges. Deduped; each routes through
  // `resolveContactRedirect` (D-138 merged-contact survivor resolution).
  if (entityName === 'email') {
    const emails = new Set<string>(strictParticipantEmails(readStr(raw, 'torecipients')));
    for (const sender of strictParticipantEmails(readStr(raw, 'sender'))) emails.add(sender);
    for (const email of emails) {
      edges.push({
        connection_id,
        engagement_target_id: target_id,
        edge_type: 'contact',
        target_kind: 'data.contact',
        target_id: email,
        vendor: 'dynamics',
        created_at: now,
        resolveContactRedirect: contactRedirect,
      });
    }
  }

  const regardingId = readStr(raw, '_regardingobjectid_value');
  const regardingType = readStr(raw, `_regardingobjectid_value${LOOKUP_ANNOTATION}`);
  if (regardingId !== null && regardingType !== null) {
    const mapped = REGARDING_EDGE[regardingType];
    if (mapped !== undefined) {
      const edge: UpsertEdgeInput = {
        connection_id,
        engagement_target_id: target_id,
        edge_type: mapped.edge_type,
        target_kind: 'connection.api',
        target_id: composePlatformRecordTargetId('dynamics', mapped.entity, connection_id, regardingId),
        vendor: 'dynamics',
        created_at: now,
      };
      // A regarding CONTACT is a weak platform-reference (`connection.api`) fallback
      // — the store carries the redirect for identity resolution (the email edges
      // above are the scoring linkage).
      if (mapped.edge_type === 'contact') {
        edge.resolveContactRedirect = contactRedirect;
      }
      edges.push(edge);
    }
  }
  return edges;
};

// ────────────────────────────────────────────────────────────────
// Leaf assembly + registration
// ────────────────────────────────────────────────────────────────

/** Build the Dynamics engagement leaf for one declared activity entity. Throws on
 *  an unsupported entity (the boot only builds this for the four declared
 *  `delta_cursor` activities — an unknown one is a declaration/boot bug). */
export const buildDynamicsEngagementLeaf = (
  entity: ConnectionVendorEntity,
  deps: DynamicsEngagementLeafDeps,
): GenericEngagementLeaf => {
  const entityName = entity.entity;
  const config = ENTITY_CONFIG[entityName];
  const projector = PROJECTORS[entityName];
  if (config === undefined || projector === undefined) {
    throw new Error(`buildDynamicsEngagementLeaf: unsupported Dynamics engagement entity '${entityName}'`);
  }

  const baseUrl = (connection: ConnectionRecord): string => {
    const raw = connection.config?.base_url;
    const base = typeof raw === 'string' && raw.length > 0 ? raw : '';
    return base.replace(/\/+$/, '');
  };

  return {
    buildDelta: (connection: ConnectionRecord): IdKeyedDeltaDeps => {
      const token = resolveBearerAccessToken(connection.auth);
      if (token === undefined) {
        // No usable token — surface as a drain-time throw (the generic reconciler's
        // non-reset path errors the step, retried next idle window once auth is fixed).
        throw new Error(`dynamics connection '${connection.name}' has no usable access token`);
      }
      return buildDataverseDeltaDeps(deps.fetch, token);
    },
    coldStartRef: (connection: ConnectionRecord): string =>
      `${baseUrl(connection)}/${config.set}?$select=${config.select}`,
    composeTargetId: (nativeId: string): string => `dynamics_${entityName}_${nativeId}`,
    readNativeId: (raw): string | null => readStr(raw, 'activityid'),
    readModifiedAt: (raw): number => parseIsoMs(raw.modifiedon) ?? 0,
    project: (input): EngagementRow => projector(input, deps),
    mapEdges: (input): UpsertEdgeInput[] => mapEdges(deps, entityName, input),
    isResetError: (err): boolean => isDataverseResync(err),
  };
};

/** Register the Dynamics engagement leaf builder so the generic engagement boot
 *  resolves it for a bound `dynamics` connection. Called from
 *  `compose-generic-engagement-reconciliation.ts` with the live HTTP deps. */
export const registerDynamicsEngagementLeaf = (deps: DynamicsEngagementLeafDeps): void => {
  registerEngagementLeaf('dynamics', (entity) => buildDynamicsEngagementLeaf(entity, deps));
};
