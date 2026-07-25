/** D-145 PA2 / D-192 P2 — Source primitive auto-registration boot wire.
 *
 *  Two responsibilities:
 *
 *  1. **Recued built-in Sources.** One Source per `WORK_ENTITY_KIND` —
 *     `recued.task` / `recued.note` / `recued.commitment` /
 *     `recued.project` — registered idempotently on first server init.
 *     The Source is the local-first canonical source for users who
 *     don't pair an external CRM. `write_capable: true`, `mcp_exposed:
 *     false` (user opts in via Settings — PA11).
 *
 *  2. **Connection-derived Sources — DECLARATION-DRIVEN since D-192
 *     P2.** The hardcoded `TASK_CAPABLE_VENDORS` closed list is
 *     retired: a connection's Sources now come from
 *     `work_entity_sources` declarations —
 *
 *       - the KERNEL declarations below for the first-party vendors
 *         (HubSpot / Salesforce), bundled like the CRM vendor-entity
 *         registry so an hb/sf connection registers its task Source
 *         with no pack install (existing-behavior preservation; the
 *         kernel is the trust root, so these constants do not carry a
 *         publish-time `contract_source` proof — Salesforce could not
 *         anyway: its OpenAPI is org-generated, not a static public
 *         URL);
 *       - any bound catalog manifest's `work_entity_sources`
 *         declarations, resolved through the OPTIONAL
 *         `resolveCatalogManifest` dep (the D-192 P1 contract — packs
 *         declare, the fail-closed validator gates at publish/install;
 *         activates per-site as the composition→catalog decomposer
 *         pass-through lands).
 *
 *     Registration preserves the D-192 P2 invariants BY the store's
 *     own semantics: `registerSource` never overwrites `enabled`
 *     (PA11) and `top_tier_kind` is locked after first registration;
 *     this module additionally skips rows that already exist so the
 *     PA3 probe's `write_capable` upgrade is never regressed by a
 *     boot/enroll refresh.
 *
 *  Spec: `docs/d-145-spec.md` § A.2 + Phase PA2; `docs/d-192-spec.md`
 *  § Phasing P2. */

import {
  RECUED_BUILTIN_SOURCE_ID,
  WORK_ENTITY_KINDS,
  isWorkEntitySourceKind,
  type IngredientManifest,
  type WorkEntityKind,
  type WorkEntitySourceDeclaration,
} from '@recued/contracts';

import type { ConnectionRow } from '@recued/contracts';
import { fnv1aHex, stableStringify } from './source-mirror/hash.js';
import type { ConnectionStoreSqlite } from './storage/connection-store.js';
import type { WorkEntityStore } from './storage/work-entity-store.js';
import type {
  WorkEntitySourceSyncState,
  WorkEntitySourceSyncStateStore,
} from './storage/work-entity-source-mirror.js';

/** A kernel-bundled Source declaration.
 *
 *  This used to be a genuinely different shape: the pack declaration MINUS
 *  the mandatory `contract_source`, because kernel constants are curated
 *  first-party code (the top of the code-trust ladder) and never pass through
 *  marketplace publish — so three of them have shipped unpinned for months
 *  (hubspot note, salesforce task, microsoft task).
 *
 *  🔑 That exemption is now the GENERAL rule. The D-192 authority ladder
 *  (ratified 2026-07-14) made `contract_source` optional on the pack
 *  declaration itself — the amendment invented nothing, it generalised the
 *  kernel's existing, working posture to packs. So the two shapes have
 *  CONVERGED and this is now a plain alias, kept only as a name that says
 *  where a declaration came from.
 *
 *  An absent `contract_source` still means exactly what it always meant here:
 *  no *documentary* op proof. It has never meant less capability. */
export type KernelWorkEntitySourceDeclaration = WorkEntitySourceDeclaration;

/** First-party kernel declarations, keyed by connection vendor. These
 *  mirror the vendors' own catalog compositions
 *  (`community/packs/hubspot.json` / `salesforce.json` task op names)
 *  so the declared ops resolve once those catalogs are bound; the
 *  registration half (id/label/kind) is what P2 consumes — the
 *  sync/projection halves are the P3 runner's blueprint. */
export const KERNEL_WORK_ENTITY_SOURCE_DECLARATIONS: Record<
  string,
  readonly KernelWorkEntitySourceDeclaration[]
> = {
  hubspot: [
    {
      kind: 'task',
      source_id_template: 'hubspot.${connection_id}.task',
      source_label_template: 'HubSpot tasks (${connection_name})',
      source_kind: 'connection',
      // The real release-pinned HubSpot Tasks OpenAPI (P1b pin ledger).
      contract_source: {
        kind: 'openapi',
        surface: 'surfaces.api.openapi_source',
        url: 'https://api.hubspot.com/public/api/spec/v2/specs/release/22187/version/3',
        sha256: '1ba065480c9dc0142f069ff02c73759a4eaaba2c0a54d7d5f74bd66d891fef8e',
        operations: ['task.list', 'task.read', 'task.create', 'task.update'],
      },
      remote: {
        entity: 'task',
        id: 'id',
        version: { kind: 'updated_at', field: 'updatedAt' },
        hash_fields: [
          'properties.hs_task_subject', 'properties.hs_task_status',
          'properties.hs_task_priority', 'properties.hs_timestamp',
          'properties.hs_task_body',
        ],
      },
      ops: { list: 'task.list', read: 'task.read', create: 'task.create', update: 'task.update' },
      // Targeted-op wire bindings — the catalog's own arg keys (the
      // `{{task_id}}` path variable on `task.read` / `task.update` in
      // `community/packs/hubspot.json`), NOT the OpenAPI param name
      // (`taskId`). `complete` falls back to the update binding.
      op_bindings: {
        read: { id_arg: 'task_id' },
        update: { id_arg: 'task_id' },
      },
      // Deletes are ABSENCE-based, not native (make-live verification
      // against the pinned spec): `GET /crm/v3/objects/tasks` takes
      // `archived` (default FALSE — "return only results that have
      // been archived"), so the default walk EXCLUDES archived rows
      // and every returned row carries `archived: false` — a 'native'
      // tombstone_field would never fire. The unfiltered walk-all list
      // (surface `pagination_style: hubspot_after` drives the
      // gateway's complete-walk proof) IS the complete authoritative
      // live set, so absence = archived/deleted, gated on the positive
      // `complete` proof per the runner.
      sync: {
        mode: 'read_write', depth: 'meta',
        tombstones: 'missing_means_deleted', list_scope: 'complete_authoritative',
        stale_after_ms: 21_600_000,
      },
      read_resolution: {
        default: 'local_rich_meta',
        remote_when: ['field_missing', 'source_stale', 'complete_body_required',
          'current_remote_required', 'write_preflight'],
        wild_query: {
          remote_fanout: 'bounded_targeted', max_sources: 3,
          max_remote_records: 10, on_exceeds_cap: 'ask_to_narrow',
        },
      },
      projection: {
        canonical: {
          title: 'properties.hs_task_subject', state: 'properties.hs_task_status',
          priority: 'properties.hs_task_priority', due_at: 'properties.hs_timestamp',
        },
        preview: { body: { field: 'properties.hs_task_body', max_chars: 800 } },
        extension: { detail_fidelity: 'preview' },
      },
      // `priority` writes through the declared vocab inverse — the
      // projector maps HubSpot's case-sensitive enum (`HIGH`/`MEDIUM`/
      // `LOW`) onto the canonical vocabulary, and the executor pushes
      // the mapped vendor value (a verbatim `'high'` would fail the
      // enumeration). `state` round-trips the vendor's own vocabulary
      // verbatim (free-form canonical field); `due_at` pushes the
      // canonical unix-ms epoch, which the datetime property accepts —
      // neither needs a transform.
      writable_fields: ['title', 'state', 'priority', 'due_at', 'body'],
      write_transforms: {
        priority: {
          kind: 'vocab',
          map: { low: 'LOW', medium: 'MEDIUM', high: 'HIGH' },
        },
      },
      // The pinned spec marks `hs_timestamp` required on create — a
      // vendor-first create without a due date would 400 and lose the
      // row; `prepare` refuses it up-front instead.
      create_required_fields: ['due_at'],
      write_policy: {
        conditional_write: 'none',
        stale_write: 'manual_merge', field_conflicts: 'manual_merge',
      },
    },
    {
      // D-192 shape-settle pilot — the `note`-KIND axis (the coverage gate's
      // "one note/page Source with long-body preview fidelity"). The task and
      // project Sources never exercise the note validation path: a note has no
      // required canonical column (`note` required = []) and MUST instead
      // project a preview field. This is the first Source that does — proving
      // the declaration shape already carries the note kind (empty canonical +
      // required preview) with no new field.
      kind: 'note',
      source_id_template: 'hubspot.${connection_id}.note',
      source_label_template: 'HubSpot notes (${connection_name})',
      source_kind: 'connection',
      // No contract_source: the HubSpot Notes OpenAPI is a SEPARATE document
      // from the Tasks pin the task Source above carries — a note Source pins
      // ONE doc, and adding the Notes spec pin is a marketplace-publish
      // concern; as a curated kernel declaration (top of the code-trust
      // ladder) it needs none — the Salesforce kernel posture.
      remote: {
        entity: 'note',
        id: 'id',
        version: { kind: 'updated_at', field: 'updatedAt' },
        hash_fields: ['properties.hs_note_body', 'properties.hs_timestamp'],
      },
      ops: { list: 'note.list', read: 'note.read' },
      // `note.read` names the record via the catalog's own `{{note_id}}` path
      // variable (the note analog of the task binding).
      op_bindings: {
        read: { id_arg: 'note_id' },
      },
      // GET /crm/v3/objects/notes takes `archived` (default FALSE) — the walk
      // EXCLUDES archived rows, so the unfiltered walk IS the complete
      // authoritative live set and absence = archived/deleted (the HubSpot
      // task Source's posture, gated on the runner's positive complete proof).
      // Read-only in v1 — a note create requires a vendor `hs_timestamp` the
      // canonical note model has no column for; write-side note modeling is a
      // separate concern from the note-kind SHAPE this pilot settles.
      sync: {
        mode: 'read_only', depth: 'meta',
        tombstones: 'missing_means_deleted', list_scope: 'complete_authoritative',
        stale_after_ms: 21_600_000,
      },
      read_resolution: {
        default: 'local_rich_meta',
        remote_when: ['field_missing', 'source_stale', 'complete_body_required',
          'current_remote_required'],
        wild_query: {
          remote_fanout: 'bounded_targeted', max_sources: 3,
          max_remote_records: 10, on_exceeds_cap: 'ask_to_narrow',
        },
      },
      // A HubSpot note has NO title — the note kind's `title` canonical column
      // is OPTIONAL; the body rides the PREVIEW lane (bounded long-body
      // fidelity), the note-kind's defining shape.
      projection: {
        canonical: {},
        preview: { body: { field: 'properties.hs_note_body', max_chars: 800 } },
        extension: { detail_fidelity: 'preview' },
      },
    },
  ],
  salesforce: [
    {
      kind: 'task',
      source_id_template: 'salesforce.${connection_id}.task',
      source_label_template: 'Salesforce tasks (${connection_name})',
      source_kind: 'connection',
      // No contract_source: Salesforce's OpenAPI is ORG-GENERATED
      // (`/services/data/vXX/async/specifications`), not a static
      // public URL — the P1b finding. The kernel trust root carries the
      // declaration; a future per-org pin model is the P3+ answer.
      remote: {
        entity: 'Task',
        id: 'Id',
        // `POST /sobjects/Task` responds `{ id, success, errors }` —
        // lowercase — unlike the SOQL row shape (`Id`). Without this
        // the executor would report a SUCCESSFUL vendor create as an
        // id-extraction failure, skip the local write, and invite
        // duplicate vendor tasks on retry (make-live codex HIGH).
        create_response_id_field: 'id',
        version: { kind: 'updated_at', field: 'LastModifiedDate' },
        hash_fields: ['Subject', 'Status', 'Priority', 'ActivityDate', 'WhoId', 'WhatId', 'Description'],
      },
      ops: { list: 'task.open.list', read: 'task.read', create: 'task.create', update: 'task.update' },
      // The catalog's own arg key (the `{{task_id}}` path variable on
      // `task.read` / `task.update` in `community/packs/salesforce.json`),
      // same shape as the HubSpot binding. `complete` falls back to the
      // update binding.
      op_bindings: {
        read: { id_arg: 'task_id' },
        update: { id_arg: 'task_id' },
      },
      // `task.open.list` is a FILTERED scope (open tasks) — absence
      // from it proves nothing, so tombstones stay 'none' (fail-safe;
      // the spec fragment's illustrative 'native' assumed an
      // authoritative walk this op does not provide). Completed /
      // vendor-deleted tasks simply go stale — the documented posture.
      sync: {
        mode: 'read_write', depth: 'meta', tombstones: 'none',
        list_scope: 'filtered', stale_after_ms: 21_600_000,
      },
      read_resolution: {
        default: 'local_rich_meta',
        remote_when: ['field_missing', 'source_stale', 'complete_body_required',
          'current_remote_required', 'write_preflight'],
        wild_query: {
          remote_fanout: 'bounded_targeted', max_sources: 3,
          max_remote_records: 10, on_exceeds_cap: 'ask_to_narrow',
        },
      },
      projection: {
        canonical: { title: 'Subject', state: 'Status', priority: 'Priority', due_at: 'ActivityDate' },
        preview: { body: { field: 'Description', max_chars: 800 } },
        extension: { detail_fidelity: 'preview' },
      },
      // D-192 P5 — the spec's own worked example: WhoId → contact via
      // the D-138 stack (platform link → canonical email → contact_id).
      // WhoId is itself polymorphic (Contact 003… / Lead 00Q…): a ref
      // resolves ONLY through Recued's own `contact_platform_link`
      // rows, so the resolved identity is always a contact Recued
      // itself linked (today only the contact reconciler writes SF
      // links, so Lead ids stay `rel_*` hints; a future lead-derived
      // link would make the edge point at that verified person — the
      // declared `remote_entity: 'Contact'` on the edge is the
      // declaration's claim, not a per-ref assertion).
      // WhatId is deliberately NOT declared:
      // it is POLYMORPHIC (Opportunity 006… / Account 001… share the
      // field), and a `crm.deal`-typed edge composed for an Account id
      // would be a mislabeled identity — needs a discriminated pairing
      // extension first.
      relationships: [
        {
          local_field: 'assigned_contact_id',
          remote_field: 'WhoId',
          target: 'contact',
          remote_entity: 'Contact',
          pairing: 'remote_id',
          cardinality: 'one',
          write_back: false,
        },
      ],
      // `priority` and `due_at` write through declared inverse
      // transforms (make-live verification against the official Task
      // object reference, 2026-07-02) — both forward projections are
      // lossy, so a verbatim push would break the vendor wire:
      //  - `priority`: Salesforce's picklist is `High`/`Normal`/`Low`
      //    (default `Normal`); the projector canonicalizes `Normal` →
      //    `medium`, the vocab inverse writes the picklist value back.
      //  - `due_at`: `ActivityDate` is a `date`-typed field — the REST
      //    wire carries `'yyyy-MM-dd'` STRINGS and rejects JSON numbers
      //    at deserialization (unlike HubSpot's `hs_timestamp`, a
      //    datetime property that accepts the canonical ms-epoch); the
      //    date_format derivation writes the UTC calendar date.
      // `title` (`Subject`) and `body` (`Description`) are free text;
      // `state` (`Status`) round-trips the vendor's own picklist
      // vocabulary verbatim — none need a transform.
      // No `create_required_fields`: every Task field is nillable or
      // defaulted on create (`Subject`/`ActivityDate` nillable,
      // `Status`/`Priority`/`OwnerId` defaulted) — a narrow create can
      // never 400 on a missing field.
      writable_fields: ['title', 'state', 'priority', 'due_at', 'body'],
      write_transforms: {
        priority: {
          kind: 'vocab',
          map: { low: 'Low', medium: 'Normal', high: 'High' },
        },
        due_at: { kind: 'date_format', format: 'yyyy-MM-dd' },
      },
      write_policy: {
        conditional_write: 'none',
        stale_write: 'manual_merge', field_conflicts: 'manual_merge',
      },
    },
  ],
  microsoft: [
    {
      // D-192 shape-settle pilot — the read_write + CONDITIONAL-WRITE axis (coverage
      // gate #6: "one vendor with read-write mode and conditional-write or revision
      // semantics"). Microsoft To Do is the VERIFIED etag-conditional case: Graph
      // annotates every task with `@odata.etag` and honors `If-Match` on the PATCH
      // (the same OData machinery web-confirmed for Planner). Vendor #2 on the "2
      // consecutive vendors, no new declaration field" track (note axis = #1) — the
      // write-slot container threading it needs was an ENGINE change (persist-
      // dependency write args, `a5b82bc7`), NOT a new declaration field.
      kind: 'task',
      source_id_template: 'microsoft.${connection_id}.task',
      source_label_template: 'Microsoft To Do tasks (${connection_name})',
      source_kind: 'connection',
      // No contract_source: the To Do Graph surface has no static public
      // OpenAPI/Discovery doc the marketplace publish gate could pin+equal; as a
      // curated kernel declaration (top of the code-trust ladder) it carries none —
      // the Salesforce / HubSpot-note posture. Vendor-key nuance: `microsoft` spans
      // packs (todo / defender / entra / intune). A kernel `microsoft` task Source
      // attaches to ANY `microsoft` connection and gracefully config-fails on a
      // non-To-Do catalog (its `task.*` ops resolve to nothing) — the same posture
      // as the kernel HubSpot task Source against a non-CRM catalog.
      remote: {
        entity: 'todoTask',
        id: 'id',
        // The conditional-write precondition token. Graph returns it in the record
        // BODY as the literal-dot annotation key `@odata.etag` (one key, not a
        // `@odata` → `etag` nesting, not a header) — captured verbatim by
        // `workEntitySourceVersionToken` now that `getByDotPath` tries the full
        // literal key before dot-splitting.
        version: { kind: 'etag', field: '@odata.etag' },
        hash_fields: ['title', 'status', 'importance', 'body.content', 'dueDateTime.dateTime'],
      },
      ops: { list: 'task.search', read: 'task.read', update: 'task.update' },
      op_bindings: {
        read: { id_arg: 'task_id' },
        // The etag rides Graph's `If-Match` REQUEST HEADER. `header.If-Match` reaches
        // the wire as a request header via the connection-api adapter; the catalog
        // gateway passes the extra caller arg through, so the op need not declare it.
        update: { id_arg: 'task_id', precondition_arg: 'header.If-Match' },
      },
      // `task.search` lists ONE To Do list (the picked container) — a FILTERED scope,
      // never an authoritative walk of every task; absence proves nothing, so
      // tombstones stay 'none' (fail-safe). A completed / vendor-deleted task simply
      // goes stale — the documented posture (the Salesforce task Source's).
      //
      // KNOWN LIMITATION (tracked follow-on): the `microsoft-todo` catalog's
      // `task.search` / `task_list.search` ops declare no pagination, so a list with
      // more than one Graph page mirrors only the FIRST page (Graph pages via a body
      // `@odata.nextLink` → the `next_path` op-pagination style). This is at parity
      // with the shipped Google Tasks Source and — with `tombstones: 'none'` — never
      // drives a false delete: the un-fetched rows are simply un-mirrored, not
      // tombstoned. Adding `pagination` to both packs' list ops is a separate,
      // catalog-wide change (it does not touch this read_write + etag SHAPE proof).
      sync: {
        mode: 'read_write', depth: 'meta', tombstones: 'none',
        list_scope: 'filtered', stale_after_ms: 21_600_000,
      },
      read_resolution: {
        default: 'local_rich_meta',
        remote_when: ['field_missing', 'source_stale', 'complete_body_required',
          'current_remote_required', 'write_preflight'],
        wild_query: {
          remote_fanout: 'bounded_targeted', max_sources: 3,
          max_remote_records: 10, on_exceeds_cap: 'ask_to_narrow',
        },
      },
      // Graph READS `title` / `status` top-level; the body rides the preview lane;
      // `due_at` reads the nested `dueDateTime.dateTime` string.
      projection: {
        canonical: { title: 'title', state: 'status', due_at: 'dueDateTime.dateTime' },
        preview: { body: { field: 'body.content', max_chars: 800 } },
        extension: { detail_fidelity: 'preview' },
      },
      // `title` (free text) and `state` (To Do's `status` is a FREE-FORM canonical
      // `state` — the task `state` column is NOT a closed domain, unlike `priority`)
      // both round-trip verbatim, so neither needs a write transform.
      writable_fields: ['title', 'state'],
      // Graph READS `title` / `status` top-level but WRITES them under `body.*` on the
      // PATCH — the read shape ≠ the write shape, so the write path overrides the
      // projection read lane (HubSpot/Salesforce read+write the same path, declare
      // none).
      write_paths: { title: 'body.title', state: 'body.status' },
      // The To Do task lives under a list — `/me/todo/lists/{list_id}/tasks/{task_id}`.
      // The SAME stored list selection that scopes the sync walk + the read-before-
      // write preflight also scopes the narrow PATCH (a WRITE-slot bind, threaded by
      // the engine's persist-dependency write-arg resolver — `a5b82bc7`). `persist`:
      // a headless sync picks the container once at setup, reused every cycle.
      source_dependencies: [
        {
          ref: 'task_list',
          list_op: 'task_list.search',
          id_field: 'id',
          label_field: 'displayName',
          binds: [
            { op: 'list', arg: 'list_id' },
            { op: 'read', arg: 'list_id' },
            { op: 'update', arg: 'list_id' },
          ],
          resolve: 'persist',
        },
      ],
      write_policy: {
        conditional_write: 'etag',
        stale_write: 'manual_merge', field_conflicts: 'manual_merge',
      },
    },
  ],
};

/** Recued built-in Source labels are stable per kind. Surfaces in
 *  Settings → Work Entities (PA11) and the Source dropdown (PA6). */
const RECUED_BUILTIN_LABEL: Record<WorkEntityKind, string> = {
  task: 'Recued built-in',
  note: 'Recued built-in',
  commitment: 'Recued built-in',
  project: 'Recued built-in',
  booking: 'Recued built-in',
};

/** Auto-register one Recued built-in Source per `WorkEntityKind` on
 *  first server init. Idempotent: existing rows are skipped (the
 *  registry's INSERT would otherwise raise a UNIQUE-constraint error
 *  on subsequent boots). The label + capability flags are baked in
 *  per § A.2. */
export const autoRegisterRecuedBuiltinSources = (
  store: WorkEntityStore,
  now: number = Date.now(),
): void => {
  for (const kind of WORK_ENTITY_KINDS) {
    const id = RECUED_BUILTIN_SOURCE_ID(kind);
    if (store.getSource(id) !== null) continue;
    store.registerSource({
      id,
      top_tier_kind: kind,
      source_kind: 'builtin',
      source_label: RECUED_BUILTIN_LABEL[kind],
      write_capable: true,
      // MCP-exposure default off per the privacy posture established
      // in D-136 P7.E (`mcp_exposed` per-topic gate). User opts in
      // through Settings — PA11 surfaces the toggle.
      mcp_exposed: false,
      registered_at: now,
    });
  }
};

/** Parse the connection row's vendor from `config_json`. Generic since
 *  D-192 P2 — ANY vendor may carry declarations (kernel or catalog);
 *  the closed `TASK_CAPABLE_VENDORS` gate retired with the hardcoded
 *  path. Exported since P5 — the sync wire threads the vendor into
 *  each task's input for edge resolution (platform links, `crm_alias`). */
export const connectionVendorOf = (row: ConnectionRow): string | null => {
  if (row.kind !== 'api') return null;
  let config: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.config_json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      config = parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  const vendor = config.vendor;
  return typeof vendor === 'string' && vendor.length > 0 ? vendor : null;
};

/** Parse an api connection row's non-secret config object — the source for a
 *  declaration's `op_arg_bindings` / `create_arg_bindings` per-connection scoping
 *  values (Asana `workspace`, Google Tasks `tasklist`, Linear `teamId`). Same
 *  parse as `connectionVendorOf`; a non-api row / malformed config yields
 *  undefined (the resolver then config-fails the bound arg). */
export const connectionConfigOf = (
  row: ConnectionRow,
): Record<string, unknown> | undefined => {
  if (row.kind !== 'api') return undefined;
  try {
    const parsed: unknown = JSON.parse(row.config_json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
};

/** `${connection_id}` / `${connection_name}` template substitution.
 *  The connection's identity key in this substrate IS its name (the
 *  connection store's `(kind, name)` PK), so both placeholders
 *  substitute the row name — `hubspot.${connection_id}.task` yields
 *  the exact `CONNECTION_SOURCE_ID` shape PA2 minted
 *  (`hubspot.<conn>.task`), preserving every existing Source id. */
const substituteTemplate = (template: string, connection_name: string): string =>
  template
    .replaceAll('${connection_id}', connection_name)
    .replaceAll('${connection_name}', connection_name);

/** The connection name embedded in a connection-Source id
 *  (`<vendor>.<name>.<kind>` — first segment vendor, last segment
 *  entity kind, everything between the name). Null when the id cannot
 *  carry the format. Exported since P4b — the write executor's
 *  declaration resolver parses the connection back out of a Source id
 *  the same way the reconcile does. */
export const sourceIdConnectionName = (id: string): string | null => {
  const parts = id.split('.');
  if (parts.length < 3) return null;
  return parts.slice(1, -1).join('.');
};

/** The declaration version pin persisted on the Source's sync-state
 *  row — a changed declaration (new projection, new ops, new sync
 *  posture) resets incremental trust: the P3b runner re-walks from
 *  scratch (`cursor_blob` nulled) while health history is preserved. */
export const workEntitySourceContractHash = (
  declaration: KernelWorkEntitySourceDeclaration,
): string => `fnv1a:${fnv1aHex(stableStringify(declaration))}`;

export interface DesiredWorkEntitySource {
  id: string;
  top_tier_kind: WorkEntityKind;
  source_label: string;
  /** The driving declaration — the P3b sync wire consumes the
   *  sync/projection halves; registration consumes id/label/kind. */
  declaration: KernelWorkEntitySourceDeclaration;
}

/** Resolve the declarations that apply to one connection row: the
 *  kernel registry for its vendor ∪ its bound catalog manifest's
 *  `work_entity_sources` (when the caller wires the resolver), deduped
 *  by substituted Source id (kernel first). Exported since P3b — the
 *  sync wire enumerates the SAME declaration set, so registration and
 *  sync can never drift. */
export const desiredWorkEntitySourcesFor = (
  row: ConnectionRow,
  resolveCatalogManifest?: (row: ConnectionRow) => IngredientManifest | null | undefined,
): DesiredWorkEntitySource[] => {
  const vendor = connectionVendorOf(row);
  const declarations: KernelWorkEntitySourceDeclaration[] = [];
  if (vendor !== null) {
    declarations.push(...(KERNEL_WORK_ENTITY_SOURCE_DECLARATIONS[vendor] ?? []));
  }
  const manifest = resolveCatalogManifest?.(row);
  if (manifest?.work_entity_sources !== undefined) {
    declarations.push(...manifest.work_entity_sources);
  }
  const out: DesiredWorkEntitySource[] = [];
  const seen = new Set<string>();
  for (const decl of declarations) {
    const id = substituteTemplate(decl.source_id_template, row.name);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      top_tier_kind: decl.kind,
      source_label: decl.source_label_template !== undefined
        ? substituteTemplate(decl.source_label_template, row.name)
        : id,
      declaration: decl,
    });
  }
  return out;
};

/** Seed / refresh the Source's sync-state row (P3b). Idempotent:
 *  an unchanged `contract_hash` leaves the row untouched (cursor +
 *  health preserved); a CHANGED declaration re-pins the contract
 *  fields and nulls the cursor (incremental trust reset) while
 *  keeping health history. */
const seedSyncState = (
  syncState: Pick<WorkEntitySourceSyncStateStore, 'get' | 'upsert'>,
  source_id: string,
  declaration: KernelWorkEntitySourceDeclaration,
): void => {
  const contract_hash = workEntitySourceContractHash(declaration);
  const existing = syncState.get(source_id);
  if (existing !== null && existing.contract_hash === contract_hash) return;
  const seeded: WorkEntitySourceSyncState = {
    source_id,
    contract_hash,
    sync_depth: declaration.sync.depth,
    sync_mode: declaration.sync.mode,
    // The tally is owned by the sync runner; `upsert` never writes this column,
    // so a re-seed cannot wipe a Source's lifetime field-health evidence.
    field_health_blob: null,
    cursor_blob: null,
    last_sync_started_at: existing?.last_sync_started_at ?? null,
    last_sync_completed_at: existing?.last_sync_completed_at ?? null,
    last_success_at: existing?.last_success_at ?? null,
    last_error_code: existing?.last_error_code ?? null,
    last_error_message: existing?.last_error_message ?? null,
    degraded: existing?.degraded ?? false,
    list_complete: existing?.list_complete ?? true,
    stale_after_ms: declaration.sync.stale_after_ms,
  };
  syncState.upsert(seeded);
};

/** Reconcile one connection name's Sources against its current
 *  declarations. Registers missing desired Sources (capability
 *  posture per § A.2 + Codex P2 fold: `write_capable: false` until
 *  the PA3 probe's first successful dispatch flips it — so the
 *  getSource-first skip below also preserves a probe upgrade across
 *  boots) and unregisters connection Sources for this name that no
 *  declaration produces anymore (vendor flip / catalog change /
 *  declaration removal — the same invariant the old closed-list
 *  reconcile enforced, now derived from declarations instead of the
 *  vendor list). `desired` is empty for a deleted row.
 *
 *  P3b: when a sync-state store is wired, every desired Source gets
 *  its `work_entity_source_sync_state` row seeded (also for Sources
 *  that already existed — an upgraded install grows its rows on the
 *  next boot scan) and an unregistered Source's row is hard-deleted
 *  (runtime state, not preserved history — the spec's ON DELETE
 *  CASCADE intent).
 *
 *  P5: an unregistered Source's `work_entity_edge` rows are hard-
 *  deleted alongside its sync state — edges are derived, rebuildable
 *  projections and follow the sync-STATE lifecycle, not the row
 *  lifecycle (the rows themselves orphan and are preserved). */
const reconcileConnectionSources = (
  store: WorkEntityStore,
  desired: DesiredWorkEntitySource[],
  connection_name: string,
  now: number,
  syncState?: Pick<WorkEntitySourceSyncStateStore, 'get' | 'upsert' | 'deleteForSource'>,
  edges?: { deleteForSource(source_id: string): number },
  dependencyEntities?: { deleteForSource(source_id: string): number },
): void => {
  const desiredIds = new Set(desired.map((d) => d.id));
  for (const existing of store.listSources()) {
    if (existing.source_kind !== 'connection') continue;
    // D-192 file SOURCE family — `wireFileSourceBoot` registers
    // `top_tier_kind: 'file'` connection Sources in this SAME registry.
    // Both boot wires' reconciles run for EVERY api connection (each
    // observes all upserts/deletes), and a file vendor yields an EMPTY
    // work-entity desired set here — so without this guard this reconcile
    // would unregister the connection's file Source (and the file
    // reconcile, scoped to `'file'`, would sweep work-entity Sources).
    // Scope each family to its own kinds: this one manages only
    // work-entity Sources.
    if (!isWorkEntitySourceKind(existing.top_tier_kind)) continue;
    if (sourceIdConnectionName(existing.id) !== connection_name) continue;
    if (!desiredIds.has(existing.id)) {
      store.unregisterSource(existing.id);
      syncState?.deleteForSource(existing.id);
      edges?.deleteForSource(existing.id);
      // D-192 source dependencies — the selected/cached container entities are
      // derived state; drop them with the Source (same lifecycle as sync-state).
      dependencyEntities?.deleteForSource(existing.id);
    }
  }
  for (const d of desired) {
    if (syncState !== undefined) seedSyncState(syncState, d.id, d.declaration);
    if (store.getSource(d.id) !== null) continue;
    store.registerSource({
      id: d.id,
      top_tier_kind: d.top_tier_kind,
      source_kind: 'connection',
      source_label: d.source_label,
      write_capable: false,
      mcp_exposed: false,
      registered_at: now,
    });
  }
};

export interface WireWorkEntitySourceBootInput {
  connectionStore: ConnectionStoreSqlite;
  store: WorkEntityStore;
  /** D-192 P2 — resolve the row's bound catalog manifest so
   *  pack-declared `work_entity_sources` register alongside the kernel
   *  registry. Optional: a composition site without manifest access
   *  wires kernel declarations only. */
  resolveCatalogManifest?: (row: ConnectionRow) => IngredientManifest | null | undefined;
  /** D-192 P3b — sync cursor/health rows, seeded at registration +
   *  deleted on unregister. Optional: harnesses without the sync
   *  substrate register Sources only. */
  syncState?: Pick<WorkEntitySourceSyncStateStore, 'get' | 'upsert' | 'deleteForSource'>;
  /** D-192 P5 — work-graph edges, hard-deleted on Source unregister
   *  (derived state; a re-registered Source rebuilds them on its first
   *  sync cycle). Optional like `syncState`. */
  edges?: { deleteForSource(source_id: string): number };
  /** D-192 source dependencies — the selected/cached container entities
   *  (`source_dependency_entity`), hard-deleted on Source unregister (derived,
   *  re-fetchable). Optional like `edges`. */
  dependencyEntities?: { deleteForSource(source_id: string): number };
  now?: () => number;
}

/** The handle `wireWorkEntitySourceBoot` returns — the install/uninstall
 *  live-reconcile primitive (mirrors `CatalogOperationProfileWiring`). */
export interface WorkEntitySourceBootWiring {
  /** (Re)reconcile ONE connection's work-entity Sources NOW, by name — the
   *  install/uninstall counterpart to the upsert observer, which fires only when
   *  the connection ROW changes, NOT when a composition install merely writes (or
   *  an uninstall drops) a catalog binding. A pack-declared Source enrolled
   *  BEFORE its pack was installed would otherwise stay unregistered until the
   *  next connection upsert / restart. Looks up the api row (a gone row → empty
   *  desired set → unregister), resolves declarations through the SAME
   *  `resolveCatalogManifest` the boot scan + observers use, and reconciles.
   *  Reads stores live, so the caller MUST run it AFTER the install/uninstall
   *  transaction commits the binding. Idempotent; safe with a name that resolves
   *  nothing (kernel-only or unbound). */
  reconcileConnection: (connectionName: string) => void;
}

/** Boot scan + upsert/delete observer for connection-derived Sources, plus the
 *  by-name live-reconcile primitive the install/uninstall deps drive.
 *
 *  Idempotent: each Source registration checks `getSource` first; the
 *  observer hooks de-dupe through the same path on token-refresh
 *  upserts that don't change vendor identity. */
export const wireWorkEntitySourceBoot = (
  input: WireWorkEntitySourceBootInput,
): WorkEntitySourceBootWiring => {
  const { connectionStore, store, resolveCatalogManifest, syncState, edges, dependencyEntities } = input;
  const now = input.now ?? ((): number => Date.now());

  // Reconcile ONE connection name against its current declarations — a null row
  // (deleted / never enrolled) yields the empty desired set (unregister). The
  // single primitive every path below drives so boot scan, observers, and the
  // install/uninstall by-name reconcile can never diverge.
  const reconcile = (row: ConnectionRow | null, name: string): void => {
    reconcileConnectionSources(
      store,
      row === null ? [] : desiredWorkEntitySourcesFor(row, resolveCatalogManifest),
      name, now(), syncState, edges, dependencyEntities,
    );
  };

  // Boot scan — reconcile every api-kind connection's Sources against
  // its current declarations. Source registry rows survive across
  // server restarts, so a vendor flip / declaration change that
  // happened while the server was stopped still leaves stale rows —
  // the reconcile drops them exactly as the upsert observer would at
  // runtime.
  for (const row of connectionStore.list({ kind: 'api' })) {
    reconcile(row, row.name);
  }

  // Future enrollments + vendor flips. Non-api upserts (kind: 'mcp' /
  // 'notification') are ignored: the connection store's `(kind, name)`
  // PK lets a non-api row coexist with an api row sharing the same
  // name — reconciling on them would wrongly drop the api row's
  // Sources.
  connectionStore.addOnUpsert((row) => {
    if (row.kind !== 'api') return;
    reconcile(row, row.name);
  });

  // Deletions — the row is gone, so the desired set is empty and the
  // reconcile unregisters every connection Source parsed to this name
  // (no closed vendor list needed — an improvement over the old path,
  // which could only try known vendors).
  connectionStore.addOnDelete((kind, name) => {
    if (kind !== 'api') return;
    reconcile(null, name);
  });

  // D-192 — the by-name reconcile the install/uninstall deps call post-commit
  // (mirrors `reconcileConnectionProfile`): install a pack whose catalog
  // declares `work_entity_sources` against an ALREADY-enrolled connection, and
  // this registers its Sources at once instead of at the next upsert / restart;
  // uninstall drops the binding → the resolver yields nothing → unregister.
  const reconcileConnection = (connectionName: string): void => {
    reconcile(connectionStore.get('api', connectionName), connectionName);
  };

  return { reconcileConnection };
};
