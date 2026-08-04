import { describe, expect, it } from 'vitest';
import type { IngredientManifest } from '@recued/contracts';
import { crossCheckCatalogOpenApi, validateIngredient } from '@recued/ingredients';
import { validateWorkEntitySources } from '../validate-work-entity-sources.js';

type Issue = {
  severity: 'error' | 'warn' | 'info';
  code: string;
  path: string;
  message: string;
};

type MutableCatalog = IngredientManifest & {
  operations: Record<string, Record<string, any>>;
  surfaces: {
    api?: Record<string, any> & {
      openapi_source?: { url: string; sha256: string };
      executes?: Record<string, Record<string, any>>;
    };
  };
  work_entity_sources: Array<Record<string, any>>;
};

const TASK_LIST_OP = 'task.open.list';
const TASK_READ_OP = 'task.read';
const TASK_CREATE_OP = 'task.create';
const TASK_UPDATE_OP = 'task.update';
const TASK_OPS = [TASK_LIST_OP, TASK_READ_OP, TASK_CREATE_OP, TASK_UPDATE_OP] as const;

const OPENAPI_URL =
  'https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/openapi.yaml';
const VALID_SHA256 = 'a'.repeat(64);
const DIFFERENT_SHA256 = 'b'.repeat(64);

const opSpec = (operationId: string, riskTier: 'read' | 'write') => ({
  operation_id: `recued-core/salesforce.${operationId}`,
  risk_tier: riskTier,
});

const BASE_CATALOG: MutableCatalog = {
  slug: 'salesforce-work-entity-sources-test',
  name: 'Salesforce Work Entity Sources Test',
  description: 'D-192 P1 work entity Source validation fixture.',
  author: 'recued-core',
  kind: 'connection',
  version: 1,
  category: 'data',
  risk_tier: 'read',
  tags: ['salesforce', 'tasks', 'catalog'],
  input: {
    operation: null,
    args: null,
  },
  output: {
    result: 'result',
  },
  operations: {
    [TASK_LIST_OP]: opSpec('task.open.list', 'read'),
    [TASK_READ_OP]: opSpec('task.read', 'read'),
    [TASK_CREATE_OP]: opSpec('task.create', 'write'),
    [TASK_UPDATE_OP]: opSpec('task.update', 'write'),
  },
  surfaces: {
    api: {
      transport: 'rest',
      default_base_url: 'https://api.salesforce.example',
      auth: {
        kind: 'none',
      },
      openapi_source: {
        url: OPENAPI_URL,
        sha256: VALID_SHA256,
      },
      executes: {
        [TASK_LIST_OP]: {
          kind: 'rest',
          method: 'GET',
          path_template: '/services/data/v60.0/query',
        },
        [TASK_READ_OP]: {
          kind: 'rest',
          method: 'GET',
          path_template: '/services/data/v60.0/sobjects/Task/{{task_id}}',
        },
        [TASK_CREATE_OP]: {
          kind: 'rest',
          method: 'POST',
          path_template: '/services/data/v60.0/sobjects/Task',
        },
        [TASK_UPDATE_OP]: {
          kind: 'rest',
          method: 'PATCH',
          path_template: '/services/data/v60.0/sobjects/Task/{{task_id}}',
        },
      },
    },
  },
  work_entity_sources: [
    {
      kind: 'task',
      source_id_template: 'salesforce.${connection_id}.task',
      source_label_template: 'Salesforce tasks (${connection_name})',
      source_kind: 'connection',
      contract_source: {
        kind: 'openapi',
        surface: 'surfaces.api.openapi_source',
        url: OPENAPI_URL,
        sha256: VALID_SHA256,
        operations: [...TASK_OPS],
      },
      remote: {
        entity: 'Task',
        id: 'Id',
        version: {
          kind: 'updated_at',
          field: 'LastModifiedDate',
        },
        hash_fields: [
          'Subject',
          'Status',
          'Priority',
          'ActivityDate',
          'WhoId',
          'WhatId',
          'Description',
        ],
      },
      ops: {
        list: TASK_LIST_OP,
        read: TASK_READ_OP,
        create: TASK_CREATE_OP,
        update: TASK_UPDATE_OP,
      },
      sync: {
        mode: 'read_write',
        depth: 'meta',
        cursor: {
          kind: 'updated_since',
          arg: 'query.updated_since',
          remote_field: 'LastModifiedDate',
        },
        tombstones: 'native',
          tombstone_field: 'IsDeleted',
        stale_after_ms: 86_400_000,
      },
      read_resolution: {
        default: 'local_rich_meta',
        remote_when: [
          'field_missing',
          'source_stale',
          'complete_body_required',
          'comments_required',
          'attachments_required',
          'current_remote_required',
          'write_preflight',
        ],
        wild_query: {
          remote_fanout: 'bounded_targeted',
          max_sources: 3,
          max_remote_records: 10,
          on_exceeds_cap: 'ask_to_narrow',
        },
      },
      projection: {
        canonical: {
          title: 'Subject',
          done: 'IsClosed',
          state: 'Status',
          due_at: 'ActivityDate',
        },
        preview: {
          body: {
            field: 'Description',
            max_chars: 800,
          },
        },
        extension: {
          detail_fidelity: 'preview',
          native_status: 'Status',
        },
      },
      writable_fields: ['title', 'body', 'state', 'due_at', 'done'],
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
        {
          local_field: 'parent_project_id',
          remote_field: 'WhatId',
          target: 'crm.deal',
          remote_entity: 'Opportunity',
          pairing: 'remote_id',
          cardinality: 'one',
          write_back: false,
        },
      ],
      write_policy: {
        conditional_write: 'none',
        stale_write: 'manual_merge',
        field_conflicts: 'manual_merge',
      },
    },
  ],
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const validCatalog = (): MutableCatalog => clone(BASE_CATALOG);

const source = (manifest: MutableCatalog): Record<string, any> =>
  manifest.work_entity_sources[0];

const api = (manifest: MutableCatalog): NonNullable<MutableCatalog['surfaces']['api']> => {
  if (!manifest.surfaces.api) throw new Error('fixture expected surfaces.api');
  return manifest.surfaces.api;
};

const executes = (manifest: MutableCatalog): Record<string, Record<string, any>> => {
  const e = api(manifest).executes;
  if (!e) throw new Error('fixture expected surfaces.api.executes');
  return e;
};

const collectWorkEntityIssues = (manifest: MutableCatalog): Issue[] => {
  const issues: Issue[] = [];
  validateWorkEntitySources(
    manifest as unknown as Record<string, unknown>,
    (severity, code, path, message) => issues.push({ severity, code, path, message }),
  );
  return issues;
};

const expectIssue = (
  issues: Issue[],
  code: string,
  path: string,
  messageIncludes?: string,
) => {
  expect(issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        severity: 'error',
        code,
        path,
      }),
    ]),
  );
  if (messageIncludes !== undefined) {
    const issue = issues.find((i) => i.severity === 'error' && i.code === code && i.path === path);
    expect(issue?.message).toEqual(expect.stringContaining(messageIncludes));
  }
};

const expectWorkEntityError = (
  mutate: (manifest: MutableCatalog) => void,
  code: string,
  path: string,
  messageIncludes?: string,
) => {
  const manifest = validCatalog();
  mutate(manifest);
  const issues = collectWorkEntityIssues(manifest);

  expectIssue(issues, code, path, messageIncludes);
};

const validNoteCatalog = (): MutableCatalog => {
  const manifest = validCatalog();
  const s = source(manifest);
  s.kind = 'note';
  s.source_id_template = 'salesforce.${connection_id}.note';
  s.remote.entity = 'ContentNote';
  s.remote.id = 'Id';
  s.remote.version = { kind: 'updated_at', field: 'LastModifiedDate' };
  s.remote.hash_fields = ['Title', 'TextPreview'];
  s.projection = {
    canonical: {
      title: 'Title',
    },
    extension: {
      native_status: 'Status',
    },
  };
  s.writable_fields = ['title'];
  delete s.relationships;
  return manifest;
};

const matchingOpenApiDocument = (): {
  openapi: string;
  paths: Record<string, Record<string, unknown>>;
} => ({
  openapi: '3.1.0',
  paths: {
    '/services/data/v60.0/query': {
      get: {},
    },
    '/services/data/v60.0/sobjects/Task/{taskId}': {
      get: {},
      patch: {},
    },
    '/services/data/v60.0/sobjects/Task': {
      post: {},
    },
  },
});

const openApiIssues = (result: ReturnType<typeof crossCheckCatalogOpenApi>) =>
  result.issues.filter((issue) => issue.code.startsWith('CATALOG_OPENAPI_'));

const expectOpenApiIssue = (
  result: ReturnType<typeof crossCheckCatalogOpenApi>,
  code: string,
  path: string,
) => {
  expect(result.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        severity: 'error',
        code,
        path,
      }),
    ]),
  );
};

describe('D-192 P1 work_entity_sources section validation', () => {
  // NB: the fixture above is a SYNTHETIC Salesforce-shaped declaration
  // exercising validator SHAPE rules only — it is NOT the live kernel
  // contract (work-entity-source-boot + the make-live proof suites).
  // Notably the live declaration pairs lossy-projection writable
  // fields (`priority`, `due_at`) with declared `write_transforms`
  // inverses; this fixture's writable set passes shape validation
  // without them because transforms are per-field opt-in.
  it('accepts the canonical Salesforce task Source declaration with zero issues', () => {
    expect(collectWorkEntityIssues(validCatalog())).toEqual([]);
  });

  it('accepts a read-through Source with no mirror lifecycle fields', () => {
    const manifest = validCatalog();
    const declaration = source(manifest);
    declaration.sync = {
      posture: 'read_through',
      mode: 'read_write',
      depth: 'meta',
    };
    declaration.read_resolution = {
      default: 'source',
      wild_query: {
        remote_fanout: 'bounded_targeted',
        max_sources: 3,
        max_remote_records: 10,
        on_exceeds_cap: 'ask_to_narrow',
      },
    };

    expect(collectWorkEntityIssues(manifest)).toEqual([]);
  });

  it('accepts ops.create on a read-through Source (create is vendor-first, id minted from the response)', () => {
    const manifest = validCatalog();
    const declaration = source(manifest);
    // The base fixture declares list + read + create + update. A read-through
    // create needs no incoming qualified id — the vendor mints the record and
    // its id becomes the `we1` identity the caller answers with.
    declaration.sync = {
      posture: 'read_through',
      mode: 'read_write',
      depth: 'meta',
    };
    declaration.read_resolution = {
      default: 'source',
      wild_query: {
        remote_fanout: 'bounded_targeted',
        max_sources: 3,
        max_remote_records: 10,
        on_exceeds_cap: 'ask_to_narrow',
      },
    };

    expect(collectWorkEntityIssues(manifest)).toEqual([]);
  });

  it('a read-through create still requires ops.read — the universal rule already covers it', () => {
    const manifest = validCatalog();
    const declaration = source(manifest);
    declaration.sync = {
      posture: 'read_through',
      mode: 'read_write',
      depth: 'meta',
    };
    declaration.read_resolution = {
      default: 'source',
      wild_query: {
        remote_fanout: 'bounded_targeted',
        max_sources: 3,
        max_remote_records: 10,
        on_exceeds_cap: 'ask_to_narrow',
      },
    };
    // A read-through create projects the new record by reading it back — there
    // is no sync cycle to fill it in later. Pinned here because that need is
    // specific to read-through, while the rule enforcing it is the generic
    // `ops.read` requirement: if the generic rule is ever narrowed, this fails.
    delete declaration.ops.read;
    delete declaration.ops.update;
    delete declaration.op_bindings;

    expectIssue(
      collectWorkEntityIssues(manifest),
      'WORK_ENTITY_SOURCES_OP_INVALID',
      'work_entity_sources[0].ops.read',
      'ops.read is required',
    );
  });

  it('rejects mirror lifecycle fields on a read-through Source', () => {
    const manifest = validCatalog();
    const declaration = source(manifest);
    declaration.sync.posture = 'read_through';
    declaration.read_resolution.default = 'source';
    delete declaration.read_resolution.remote_when;

    expectIssue(
      collectWorkEntityIssues(manifest),
      'WORK_ENTITY_SOURCES_SYNC_INVALID',
      'work_entity_sources[0].sync.stale_after_ms',
      'mirror-only',
    );
  });

  it('rejects a read-through Source that claims a local read default', () => {
    const manifest = validCatalog();
    const declaration = source(manifest);
    declaration.sync = {
      posture: 'read_through',
      mode: 'read_write',
      depth: 'meta',
    };
    delete declaration.read_resolution.remote_when;

    expectIssue(
      collectWorkEntityIssues(manifest),
      'WORK_ENTITY_SOURCES_READ_RESOLUTION_INVALID',
      'work_entity_sources[0].read_resolution.default',
      "must be 'source'",
    );
  });

  it('accepts write_paths overrides for writable fields (read≠write vendors)', () => {
    const manifest = validCatalog();
    (source(manifest) as { write_paths?: Record<string, string> }).write_paths = {
      due_at: 'due_date',
      title: 'Subject',
    };
    expect(collectWorkEntityIssues(manifest)).toEqual([]);
  });

  // ── D-192 AUTHORITY LADDER, ratified 2026-07-14 — `contract_source` is OPTIONAL ──
  //
  // An unpinned Source is LEGAL. It carries no *documentary* op proof and proves
  // its ops EMPIRICALLY instead (a live smoke against a real connection, ladder
  // §6) — the stronger proof of the two: a document asserts an endpoint SHOULD
  // exist; a live call proves it DOES. The old official-doc-or-nothing gate was
  // sized for a 25-vendor sweep and became a permanent ceiling at catalog scale
  // (Salesloft WITHDREW its spec; Freshdesk — a public company — publishes none
  // at all). The kernel has run three unpinned Sources for months; this is that
  // posture generalised to packs, not a new one invented.
  it('accepts a Source with NO contract_source — an unpinned Source is legal (ladder §3)', () => {
    const manifest = validCatalog();
    delete source(manifest).contract_source;

    expect(collectWorkEntityIssues(manifest)).toEqual([]);
  });

  // 🔴 THE TEST ABOVE WAS MUTE, AND THIS IS THE ONE THAT MATTERS.
  //
  // Deleting the declaration's `contract_source` while the CATALOG still carries an
  // `openapi_source` pin proves almost nothing: the real gate was a top-level guard
  // demanding a pinned surface on the CATALOG, and the fixture kept supplying one. A
  // doc-less vendor has NEITHER — no `contract_source` on the declaration AND no pin on
  // the catalog — and that combination failed `WORK_ENTITY_SOURCES_SURFACE_REQUIRED`
  // until 2026-07-14, short-circuiting the entire validator on the way out.
  //
  // So `contract_source: optional` did NOT, on its own, make salesloft / freshdesk /
  // helpscout authorable. THIS is the case that does. A classic fixture coincidence —
  // the assertion passed for a reason unrelated to what it claimed to test.
  // [[feedback_fixture_value_coincidence_masks_field_confusion]]
  it('accepts a DOC-LESS vendor — NO catalog pin AND NO contract_source (the whole point of the amendment)', () => {
    const manifest = validCatalog();
    delete source(manifest).contract_source;
    delete manifest.surfaces.api!.openapi_source;   // ⬅ the vendor publishes NO doc at all

    expect(collectWorkEntityIssues(manifest)).toEqual([]);
  });

  // ⚠ The fail-closed half must SURVIVE: a missing pin is an error ONLY for a
  // declaration that CLAIMS a contract_source the catalog does not pin. It fires on the
  // declaration that lied — not on every Source in the catalog.
  it('still rejects a declaration that CLAIMS a contract_source the catalog does not pin', () => {
    const manifest = validCatalog();
    delete manifest.surfaces.api!.openapi_source;   // the pin is gone…
    // …but the declaration still claims kind:'openapi'.

    expect(collectWorkEntityIssues(manifest).map((i) => i.code))
      .toContain('WORK_ENTITY_SOURCES_CONTRACT_SOURCE_INVALID');
  });

  // Locks the owner's ruling that capability is governed by CONTRACT + APPROVAL at
  // every rung, NEVER by an authority rung (ladder §8.1). An unpinned Source is not
  // read-only, not second-class, not fenced. Worth a standing guard, because the
  // "obvious" safety move is to pin writes to a document — and that would be
  // safety-by-narrowing that does not even work: D-192's own field-path verification
  // pass caught MIS-MAPPED WRITE PATHS in packs authored from official pinned docs
  // (`close` bound title→a task-TYPE enum; `outreach` bound action vs note).
  // Provenance was never the control; the asserting post-write verify is.
  it('accepts an UNPINNED read_write Source — an absent pin is not a capability fence', () => {
    const manifest = validCatalog();
    delete source(manifest).contract_source;

    expect(source(manifest).sync.mode).toBe('read_write');
    expect(collectWorkEntityIssues(manifest)).toEqual([]);
  });

  // ⚠ The fail-closed half must SURVIVE the amendment. ABSENT is legal; PRESENT
  // but malformed is not — a declaration that CLAIMED a document is still held to
  // one. Omitting `contract_source` is a decision; corrupting it is a bug, and the
  // amendment must not launder the second into the first.
  it('still rejects a contract_source that is PRESENT but malformed (absent ≠ malformed)', () => {
    const manifest = validCatalog();
    source(manifest).contract_source = 'https://example.com/openapi.yaml';

    expect(collectWorkEntityIssues(manifest).map((i) => i.code))
      .toContain('WORK_ENTITY_SOURCES_CONTRACT_SOURCE_INVALID');
  });

  it('accepts a read-only tokenless task whose completion signal is derived from a number', () => {
    const manifest = validCatalog();
    const s = source(manifest);
    s.remote.version = { kind: 'none' };
    s.projection.canonical = {
      title: 'Subject',
      done: { kind: 'number_equals', field: 'percentComplete', value: 100 },
    };
    s.sync.mode = 'read_only';
    delete s.ops.create;
    delete s.ops.update;
    s.writable_fields = [];
    delete s.write_policy;

    expect(collectWorkEntityIssues(manifest)).toEqual([]);
  });

  it('accepts a valid two-path title coalesce on a task declaration', () => {
    const manifest = validCatalog();
    const s = source(manifest);
    s.projection.canonical.title = ['PrimarySubject', 'FallbackSubject'];
    s.writable_fields = s.writable_fields.filter((field: string) => field !== 'title');

    expect(collectWorkEntityIssues(manifest)).toEqual([]);
  });

  it('counts a title coalesce as projecting the required task title', () => {
    const manifest = validCatalog();
    const s = source(manifest);
    s.projection.canonical.title = ['RequiredPrimaryTitle', 'RequiredFallbackTitle'];
    s.writable_fields = s.writable_fields.filter((field: string) => field !== 'title');

    const issues = collectWorkEntityIssues(manifest);
    expect(
      issues.some((issue) => issue.message.includes("omits required canonical field 'title'")),
    ).toBe(false);
  });

  it('accepts a valid strip_html transform title on a task declaration (CORE #8e)', () => {
    const manifest = validCatalog();
    const s = source(manifest);
    s.projection.canonical.title = { kind: 'transform', field: 'Body', transform: 'strip_html' };
    s.writable_fields = s.writable_fields.filter((field: string) => field !== 'title');

    expect(collectWorkEntityIssues(manifest)).toEqual([]);
  });

  it('counts a transform title as projecting the required task title (CORE #8e)', () => {
    const manifest = validCatalog();
    const s = source(manifest);
    s.projection.canonical.title = { kind: 'transform', field: 'RequiredBody', transform: 'strip_html' };
    s.writable_fields = s.writable_fields.filter((field: string) => field !== 'title');

    const issues = collectWorkEntityIssues(manifest);
    expect(
      issues.some((issue) => issue.message.includes("omits required canonical field 'title'")),
    ).toBe(false);
  });

  it('accepts a tokenless read-write Source with only a create op', () => {
    const manifest = validCatalog();
    const s = source(manifest);
    s.remote.version = { kind: 'none' };
    delete s.ops.update;
    s.writable_fields = ['title'];
    s.write_policy = {
      conditional_write: 'none',
      stale_write: 'manual_merge',
      field_conflicts: 'manual_merge',
    };

    expect(collectWorkEntityIssues(manifest)).toEqual([]);
  });

  const cases: Array<{
    name: string;
    mutate: (manifest: MutableCatalog) => void;
    code: string;
    path: string;
    messageIncludes?: string;
  }> = [
    {
      name: 'rejects commitment as the reserved future declaration kind',
      mutate: (manifest) => { source(manifest).kind = 'commitment'; },
      code: 'WORK_ENTITY_SOURCES_KIND_INVALID',
      path: 'work_entity_sources[0].kind',
      messageIncludes: 'commitment_evidence',
    },
    {
      name: 'rejects an unknown kind',
      mutate: (manifest) => { source(manifest).kind = 'event'; },
      code: 'WORK_ENTITY_SOURCES_KIND_INVALID',
      path: 'work_entity_sources[0].kind',
    },
    {
      name: 'rejects a canonical kind until its external Source landing adapter exists',
      mutate: (manifest) => { source(manifest).kind = 'booking'; },
      code: 'WORK_ENTITY_SOURCES_LANDING_ADAPTER_REQUIRED',
      path: 'work_entity_sources[0].kind',
      messageIncludes: 'no runtime Source landing adapter',
    },
    {
      name: 'rejects a source_id_template without connection_id',
      mutate: (manifest) => { source(manifest).source_id_template = 'salesforce.task'; },
      code: 'WORK_ENTITY_SOURCES_SOURCE_ID_TEMPLATE_INVALID',
      path: 'work_entity_sources[0].source_id_template',
    },
    {
      name: 'rejects a source_id_template that does not end with the kind',
      mutate: (manifest) => { source(manifest).source_id_template = 'salesforce.${connection_id}.note'; },
      code: 'WORK_ENTITY_SOURCES_SOURCE_ID_TEMPLATE_INVALID',
      path: 'work_entity_sources[0].source_id_template',
    },
    {
      name: 'rejects duplicate source_id_template values across declarations',
      mutate: (manifest) => {
        manifest.work_entity_sources.push(clone(source(manifest)));
      },
      code: 'WORK_ENTITY_SOURCES_DUPLICATE',
      path: 'work_entity_sources[1].source_id_template',
    },
    {
      name: 'rejects non-connection source_kind',
      mutate: (manifest) => { source(manifest).source_kind = 'tenant'; },
      code: 'WORK_ENTITY_SOURCES_INVALID',
      path: 'work_entity_sources[0].source_kind',
    },
    {
      name: 'rejects a contract_source url that differs from the surface pin',
      mutate: (manifest) => { source(manifest).contract_source.url = 'https://example.com/other-openapi.yaml'; },
      code: 'WORK_ENTITY_SOURCES_CONTRACT_SOURCE_INVALID',
      path: 'work_entity_sources[0].contract_source.url',
    },
    {
      name: 'rejects a malformed contract_source sha256',
      mutate: (manifest) => { source(manifest).contract_source.sha256 = 'A'.repeat(64); },
      code: 'WORK_ENTITY_SOURCES_CONTRACT_SOURCE_INVALID',
      path: 'work_entity_sources[0].contract_source.sha256',
    },
    {
      name: 'rejects a contract_source sha256 that differs from the surface pin',
      mutate: (manifest) => { source(manifest).contract_source.sha256 = DIFFERENT_SHA256; },
      code: 'WORK_ENTITY_SOURCES_CONTRACT_SOURCE_INVALID',
      path: 'work_entity_sources[0].contract_source.sha256',
    },
    {
      name: 'rejects contract_source.operations that omit a used op',
      mutate: (manifest) => {
        source(manifest).contract_source.operations =
          source(manifest).contract_source.operations.filter((op: string) => op !== TASK_UPDATE_OP);
      },
      code: 'WORK_ENTITY_SOURCES_CONTRACT_SOURCE_INVALID',
      path: 'work_entity_sources[0].contract_source.operations',
    },
    {
      name: 'rejects a Source op absent from surfaces.api.executes',
      mutate: (manifest) => { delete executes(manifest)[TASK_READ_OP]; },
      code: 'WORK_ENTITY_SOURCES_OP_INVALID',
      path: 'work_entity_sources[0].ops.read',
    },
    {
      name: 'rejects a list slot bound to a write-tier operation',
      mutate: (manifest) => { manifest.operations[TASK_LIST_OP]!.risk_tier = 'write'; },
      code: 'WORK_ENTITY_SOURCES_OP_INVALID',
      path: 'work_entity_sources[0].ops.list',
      messageIncludes: 'must be read-tier',
    },
    {
      name: 'rejects a read slot bound to a write-tier operation',
      mutate: (manifest) => { manifest.operations[TASK_READ_OP]!.risk_tier = 'write'; },
      code: 'WORK_ENTITY_SOURCES_OP_INVALID',
      path: 'work_entity_sources[0].ops.read',
      messageIncludes: 'must be read-tier',
    },
    {
      name: 'rejects a Source op bound to graphql instead of rest',
      mutate: (manifest) => {
        executes(manifest)[TASK_READ_OP] = {
          kind: 'graphql',
          operation_type: 'query',
          endpoint_path: '/graphql',
          query: 'query Task { task { id } }',
        };
      },
      code: 'WORK_ENTITY_SOURCES_OP_INVALID',
      path: 'work_entity_sources[0].ops.read',
    },
    {
      name: 'rejects a declaration missing ops.list',
      mutate: (manifest) => { delete source(manifest).ops.list; },
      code: 'WORK_ENTITY_SOURCES_OP_INVALID',
      path: 'work_entity_sources[0].ops.list',
    },
    {
      name: 'rejects a declaration missing ops.read',
      mutate: (manifest) => { delete source(manifest).ops.read; },
      code: 'WORK_ENTITY_SOURCES_OP_INVALID',
      path: 'work_entity_sources[0].ops.read',
    },
    {
      name: 'rejects read_only mode with declared write ops',
      mutate: (manifest) => { source(manifest).sync.mode = 'read_only'; },
      code: 'WORK_ENTITY_SOURCES_OP_INVALID',
      path: 'work_entity_sources[0].ops',
    },
    {
      name: 'rejects read_write mode with no write op',
      mutate: (manifest) => {
        delete source(manifest).ops.create;
        delete source(manifest).ops.update;
      },
      code: 'WORK_ENTITY_SOURCES_OP_INVALID',
      path: 'work_entity_sources[0].ops',
    },
    {
      name: 'rejects an empty create_response_id_field',
      mutate: (manifest) => { source(manifest).remote.create_response_id_field = ''; },
      code: 'WORK_ENTITY_SOURCES_REMOTE_INVALID',
      path: 'work_entity_sources[0].remote.create_response_id_field',
    },
    {
      name: 'rejects create_response_id_field without a declared create op',
      mutate: (manifest) => {
        source(manifest).remote.create_response_id_field = 'id';
        delete source(manifest).ops.create;
      },
      code: 'WORK_ENTITY_SOURCES_REMOTE_INVALID',
      path: 'work_entity_sources[0].remote.create_response_id_field',
      messageIncludes: 'ops.create',
    },
    {
      name: 'rejects a write transform on a field outside writable_fields',
      mutate: (manifest) => {
        source(manifest).write_transforms = {
          priority: { kind: 'vocab', map: { low: 'Low', medium: 'Normal', high: 'High' } },
        };
      },
      code: 'WORK_ENTITY_SOURCES_WRITE_TRANSFORM_INVALID',
      path: 'work_entity_sources[0].write_transforms.priority',
      messageIncludes: 'writable_fields',
    },
    {
      name: 'rejects an unknown write transform kind',
      mutate: (manifest) => {
        source(manifest).write_transforms = { title: { kind: 'uppercase' } };
      },
      code: 'WORK_ENTITY_SOURCES_WRITE_TRANSFORM_INVALID',
      path: 'work_entity_sources[0].write_transforms.title',
    },
    {
      name: 'rejects a write path for a field outside writable_fields (dead config)',
      mutate: (manifest) => {
        (source(manifest) as { write_paths?: Record<string, string> }).write_paths = {
          priority: 'priority_field',
        };
      },
      code: 'WORK_ENTITY_SOURCES_WRITABLE_INVALID',
      path: 'work_entity_sources[0].write_paths.priority',
      messageIncludes: 'writable_fields',
    },
    {
      name: 'rejects an empty write path value',
      mutate: (manifest) => {
        (source(manifest) as { write_paths?: Record<string, string> }).write_paths = { title: '' };
      },
      code: 'WORK_ENTITY_SOURCES_WRITABLE_INVALID',
      path: 'work_entity_sources[0].write_paths.title',
    },
    {
      name: 'rejects a create arg binding with an unknown source',
      mutate: (manifest) => {
        (source(manifest) as { create_arg_bindings?: Record<string, unknown> }).create_arg_bindings = {
          teamId: { source: 'env', config_key: 'X' },
        };
      },
      code: 'WORK_ENTITY_SOURCES_WRITABLE_INVALID',
      path: 'work_entity_sources[0].create_arg_bindings.teamId',
      messageIncludes: 'connection_config',
    },
    {
      name: 'rejects a connection_config create arg binding with no config_key',
      mutate: (manifest) => {
        (source(manifest) as { create_arg_bindings?: Record<string, unknown> }).create_arg_bindings = {
          teamId: { source: 'connection_config', config_key: '' },
        };
      },
      code: 'WORK_ENTITY_SOURCES_WRITABLE_INVALID',
      path: 'work_entity_sources[0].create_arg_bindings.teamId',
      messageIncludes: 'config_key',
    },
    {
      name: 'rejects a create arg binding whose config_key is a prototype key',
      mutate: (manifest) => {
        (source(manifest) as { create_arg_bindings?: Record<string, unknown> }).create_arg_bindings = {
          teamId: { source: 'connection_config', config_key: '__proto__' },
        };
      },
      code: 'WORK_ENTITY_SOURCES_WRITABLE_INVALID',
      path: 'work_entity_sources[0].create_arg_bindings.teamId.config_key',
      messageIncludes: 'prototype key',
    },
    {
      name: 'rejects a priority vocab that does not cover the closed canonical domain',
      mutate: (manifest) => {
        source(manifest).writable_fields.push('priority');
        source(manifest).projection.canonical.priority = 'Priority';
        source(manifest).write_transforms = {
          priority: { kind: 'vocab', map: { low: 'Low', high: 'High' } },
        };
      },
      code: 'WORK_ENTITY_SOURCES_WRITE_TRANSFORM_INVALID',
      path: 'work_entity_sources[0].write_transforms.priority.map',
      messageIncludes: 'missing: medium',
    },
    {
      name: 'rejects a priority vocab with keys outside the closed canonical domain',
      mutate: (manifest) => {
        source(manifest).writable_fields.push('priority');
        source(manifest).projection.canonical.priority = 'Priority';
        source(manifest).write_transforms = {
          priority: {
            kind: 'vocab',
            map: { low: 'Low', medium: 'Normal', high: 'High', urgent: 'High' },
          },
        };
      },
      code: 'WORK_ENTITY_SOURCES_WRITE_TRANSFORM_INVALID',
      path: 'work_entity_sources[0].write_transforms.priority.map',
      messageIncludes: 'outside the closed canonical',
    },
    {
      name: 'rejects a date_format transform on a non-date field',
      mutate: (manifest) => {
        source(manifest).write_transforms = {
          title: { kind: 'date_format', format: 'yyyy-MM-dd' },
        };
      },
      code: 'WORK_ENTITY_SOURCES_WRITE_TRANSFORM_INVALID',
      path: 'work_entity_sources[0].write_transforms.title',
      messageIncludes: 'date canonical fields',
    },
    {
      name: 'rejects an unknown date_format format',
      mutate: (manifest) => {
        source(manifest).write_transforms = {
          due_at: { kind: 'date_format', format: 'MM/dd/yyyy' },
        };
      },
      code: 'WORK_ENTITY_SOURCES_WRITE_TRANSFORM_INVALID',
      path: 'work_entity_sources[0].write_transforms.due_at.format',
    },
    {
      name: 'rejects a vocab transform on a date field',
      mutate: (manifest) => {
        source(manifest).write_transforms = {
          due_at: { kind: 'vocab', map: { soon: '2026-01-01' } },
        };
      },
      code: 'WORK_ENTITY_SOURCES_WRITE_TRANSFORM_INVALID',
      path: 'work_entity_sources[0].write_transforms.due_at',
      messageIncludes: 'string-valued',
    },
    {
      name: 'rejects an empty vocab map',
      mutate: (manifest) => {
        source(manifest).write_transforms = { state: { kind: 'vocab', map: {} } };
      },
      code: 'WORK_ENTITY_SOURCES_WRITE_TRANSFORM_INVALID',
      path: 'work_entity_sources[0].write_transforms.state.map',
    },
    {
      name: 'rejects sync.depth full',
      mutate: (manifest) => { source(manifest).sync.depth = 'full'; },
      code: 'WORK_ENTITY_SOURCES_SYNC_INVALID',
      path: 'work_entity_sources[0].sync.depth',
    },
    {
      name: 'rejects an unknown sync.list_rows value',
      mutate: (manifest) => { source(manifest).sync.list_rows = 'pointer'; },
      code: 'WORK_ENTITY_SOURCES_SYNC_INVALID',
      path: 'work_entity_sources[0].sync.list_rows',
    },
    {
      name: 'rejects reference list rows without a read id binding',
      mutate: (manifest) => {
        source(manifest).sync.list_rows = 'reference';
      },
      code: 'WORK_ENTITY_SOURCES_SYNC_INVALID',
      path: 'work_entity_sources[0].sync.list_rows',
      messageIncludes: 'op_bindings.read.id_arg',
    },
    {
      name: 'rejects missing_means_deleted tombstones without complete authoritative list scope',
      mutate: (manifest) => { source(manifest).sync.tombstones = 'missing_means_deleted'; },
      code: 'WORK_ENTITY_SOURCES_SYNC_INVALID',
      path: 'work_entity_sources[0].sync.list_scope',
    },
    {
      name: 'rejects missing stale_after_ms',
      mutate: (manifest) => { delete source(manifest).sync.stale_after_ms; },
      code: 'WORK_ENTITY_SOURCES_SYNC_INVALID',
      path: 'work_entity_sources[0].sync.stale_after_ms',
    },
    {
      name: 'rejects a cursor missing arg',
      mutate: (manifest) => { delete source(manifest).sync.cursor.arg; },
      code: 'WORK_ENTITY_SOURCES_SYNC_INVALID',
      path: 'work_entity_sources[0].sync.cursor',
    },
    {
      name: 'rejects an unsupported read_resolution.default',
      mutate: (manifest) => { source(manifest).read_resolution.default = 'remote_first'; },
      code: 'WORK_ENTITY_SOURCES_READ_RESOLUTION_INVALID',
      path: 'work_entity_sources[0].read_resolution.default',
    },
    {
      name: 'rejects unknown remote_when reasons',
      mutate: (manifest) => { source(manifest).read_resolution.remote_when = ['source_stale', 'because']; },
      code: 'WORK_ENTITY_SOURCES_READ_RESOLUTION_INVALID',
      path: 'work_entity_sources[0].read_resolution.remote_when',
    },
    {
      name: 'rejects write-capable Sources without write_preflight',
      mutate: (manifest) => { source(manifest).read_resolution.remote_when = ['field_missing', 'source_stale']; },
      code: 'WORK_ENTITY_SOURCES_READ_RESOLUTION_INVALID',
      path: 'work_entity_sources[0].read_resolution.remote_when',
    },
    {
      name: 'rejects wild_query without caps',
      mutate: (manifest) => { delete source(manifest).read_resolution.wild_query.max_sources; },
      code: 'WORK_ENTITY_SOURCES_READ_RESOLUTION_INVALID',
      path: 'work_entity_sources[0].read_resolution.wild_query',
    },
    {
      name: 'rejects canonical projection of relationship fields with an FK hint',
      mutate: (manifest) => {
        source(manifest).projection.canonical.assigned_contact_id = 'WhoId';
      },
      code: 'WORK_ENTITY_SOURCES_PROJECTION_INVALID',
      path: 'work_entity_sources[0].projection.canonical.assigned_contact_id',
      messageIncludes: 'relationship/FK fields are never projection targets',
    },
    {
      name: 'rejects canonical projection of long body fields',
      mutate: (manifest) => { source(manifest).projection.canonical.body = 'Description'; },
      code: 'WORK_ENTITY_SOURCES_PROJECTION_INVALID',
      path: 'work_entity_sources[0].projection.canonical.body',
      messageIncludes: 'long-body fields ride the preview lane',
    },
    {
      name: 'rejects a task projection missing required canonical title',
      mutate: (manifest) => { delete source(manifest).projection.canonical.title; },
      code: 'WORK_ENTITY_SOURCES_PROJECTION_INVALID',
      path: 'work_entity_sources[0].projection.canonical',
    },
    {
      // P1b fold — `done` OR `state` satisfies the completion-signal
      // invariant, but a task projecting NEITHER must fail (Codex F3:
      // the coverage fixtures are all positive, so without this case
      // the either-of check could be deleted and stay green).
      name: 'rejects a task projection with neither done nor state (no completion signal)',
      mutate: (manifest) => {
        source(manifest).projection.canonical = { title: 'Subject' };
        source(manifest).writable_fields = ['title', 'body'];
      },
      code: 'WORK_ENTITY_SOURCES_PROJECTION_INVALID',
      path: 'work_entity_sources[0].projection.canonical',
      messageIncludes: 'completion signal',
    },
    {
      name: 'rejects a done coalesce because completion fields are not coalescable in v1',
      mutate: (manifest) => {
        const s = source(manifest);
        s.projection.canonical.done = ['IsClosed', 'FallbackIsClosed'];
        s.writable_fields = s.writable_fields.filter((field: string) => field !== 'done');
      },
      code: 'WORK_ENTITY_SOURCES_PROJECTION_INVALID',
      path: 'work_entity_sources[0].projection.canonical.done',
      messageIncludes: 'does not admit a coalesce',
    },
    {
      name: 'rejects a due_at coalesce because due dates are not coalescable in v1',
      mutate: (manifest) => {
        const s = source(manifest);
        s.projection.canonical.due_at = ['ActivityDate', 'FallbackActivityDate'];
        s.writable_fields = s.writable_fields.filter((field: string) => field !== 'due_at');
      },
      code: 'WORK_ENTITY_SOURCES_PROJECTION_INVALID',
      path: 'work_entity_sources[0].projection.canonical.due_at',
      messageIncludes: 'does not admit a coalesce',
    },
    {
      name: 'rejects a singleton canonical coalesce',
      mutate: (manifest) => {
        const s = source(manifest);
        s.projection.canonical.title = ['OnlySubjectPath'];
        s.writable_fields = s.writable_fields.filter((field: string) => field !== 'title');
      },
      code: 'WORK_ENTITY_SOURCES_PROJECTION_INVALID',
      path: 'work_entity_sources[0].projection.canonical.title',
      messageIncludes: 'at least two',
    },
    {
      name: 'rejects an empty-string canonical coalesce entry',
      mutate: (manifest) => {
        const s = source(manifest);
        s.projection.canonical.title = ['NonEmptySubjectPath', ''];
        s.writable_fields = s.writable_fields.filter((field: string) => field !== 'title');
      },
      code: 'WORK_ENTITY_SOURCES_PROJECTION_INVALID',
      path: 'work_entity_sources[0].projection.canonical.title',
      messageIncludes: 'non-empty remote field paths',
    },
    {
      name: 'rejects a non-string canonical coalesce entry',
      mutate: (manifest) => {
        const s = source(manifest);
        s.projection.canonical.title = ['StringSubjectPath', 17];
        s.writable_fields = s.writable_fields.filter((field: string) => field !== 'title');
      },
      code: 'WORK_ENTITY_SOURCES_PROJECTION_INVALID',
      path: 'work_entity_sources[0].projection.canonical.title',
      messageIncludes: 'non-empty remote field paths',
    },
    {
      name: 'rejects a coalesced title in writable_fields',
      mutate: (manifest) => {
        source(manifest).projection.canonical.title = ['WritablePrimaryTitle', 'WritableFallbackTitle'];
      },
      code: 'WORK_ENTITY_SOURCES_WRITABLE_INVALID',
      path: 'work_entity_sources[0].writable_fields',
      messageIncludes: 'coalesced canonical fields are read-only in v1',
    },
    {
      name: 'rejects a derivation on a non-derivable canonical field',
      mutate: (manifest) => {
        source(manifest).projection.canonical.state = {
          kind: 'number_equals',
          field: 'percentComplete',
          value: 100,
        };
        source(manifest).writable_fields =
          source(manifest).writable_fields.filter((field: string) => field !== 'state');
      },
      code: 'WORK_ENTITY_SOURCES_PROJECTION_INVALID',
      path: 'work_entity_sources[0].projection.canonical.state',
      messageIncludes: 'does not admit a derivation',
    },
    {
      name: 'rejects an unknown canonical derivation kind',
      mutate: (manifest) => {
        source(manifest).projection.canonical.done = {
          kind: 'number_at_least',
          field: 'percentComplete',
          value: 100,
        };
        source(manifest).writable_fields =
          source(manifest).writable_fields.filter((field: string) => field !== 'done');
      },
      code: 'WORK_ENTITY_SOURCES_PROJECTION_INVALID',
      path: 'work_entity_sources[0].projection.canonical.done.kind',
      messageIncludes: 'number_equals',
    },
    {
      name: 'rejects a canonical derivation with an empty remote field',
      mutate: (manifest) => {
        source(manifest).projection.canonical.done = {
          kind: 'number_equals',
          field: '',
          value: 100,
        };
        source(manifest).writable_fields =
          source(manifest).writable_fields.filter((field: string) => field !== 'done');
      },
      code: 'WORK_ENTITY_SOURCES_PROJECTION_INVALID',
      path: 'work_entity_sources[0].projection.canonical.done.field',
      messageIncludes: 'non-empty remote field path',
    },
    {
      name: 'rejects a number_equals derivation with a missing value',
      mutate: (manifest) => {
        source(manifest).projection.canonical.done = {
          kind: 'number_equals',
          field: 'percentComplete',
        };
        source(manifest).writable_fields =
          source(manifest).writable_fields.filter((field: string) => field !== 'done');
      },
      code: 'WORK_ENTITY_SOURCES_PROJECTION_INVALID',
      path: 'work_entity_sources[0].projection.canonical.done.value',
      messageIncludes: 'finite numeric comparand',
    },
    {
      name: 'rejects a number_equals derivation with a non-finite value',
      mutate: (manifest) => {
        source(manifest).projection.canonical.done = {
          kind: 'number_equals',
          field: 'percentComplete',
          value: Number.POSITIVE_INFINITY,
        };
        source(manifest).writable_fields =
          source(manifest).writable_fields.filter((field: string) => field !== 'done');
      },
      code: 'WORK_ENTITY_SOURCES_PROJECTION_INVALID',
      path: 'work_entity_sources[0].projection.canonical.done.value',
      messageIncludes: 'finite numeric comparand',
    },
    {
      name: 'rejects a number_equals derivation with a non-numeric value',
      mutate: (manifest) => {
        source(manifest).projection.canonical.done = {
          kind: 'number_equals',
          field: 'percentComplete',
          value: '100',
        };
        source(manifest).writable_fields =
          source(manifest).writable_fields.filter((field: string) => field !== 'done');
      },
      code: 'WORK_ENTITY_SOURCES_PROJECTION_INVALID',
      path: 'work_entity_sources[0].projection.canonical.done.value',
      messageIncludes: 'finite numeric comparand',
    },
    {
      name: 'rejects a derived done field in writable_fields',
      mutate: (manifest) => {
        source(manifest).projection.canonical.done = {
          kind: 'number_equals',
          field: 'percentComplete',
          value: 100,
        };
      },
      code: 'WORK_ENTITY_SOURCES_WRITABLE_INVALID',
      path: 'work_entity_sources[0].writable_fields',
      messageIncludes: 'derived canonical fields are read-only',
    },
    {
      name: 'rejects writable completed_at beside a derived done field',
      mutate: (manifest) => {
        source(manifest).projection.canonical.done = {
          kind: 'number_equals',
          field: 'percentComplete',
          value: 100,
        };
        source(manifest).projection.canonical.completed_at = 'CompletedDate';
        source(manifest).writable_fields = [
          ...source(manifest).writable_fields.filter((field: string) => field !== 'done'),
          'completed_at',
        ];
      },
      code: 'WORK_ENTITY_SOURCES_WRITABLE_INVALID',
      path: 'work_entity_sources[0].writable_fields',
      messageIncludes: 'half-completion',
    },
    {
      name: 'rejects ops.complete beside a derived done field',
      mutate: (manifest) => {
        source(manifest).projection.canonical.done = {
          kind: 'number_equals',
          field: 'percentComplete',
          value: 100,
        };
        source(manifest).writable_fields =
          source(manifest).writable_fields.filter((field: string) => field !== 'done');
        source(manifest).ops.complete = TASK_UPDATE_OP;
      },
      code: 'WORK_ENTITY_SOURCES_OP_INVALID',
      path: 'work_entity_sources[0].ops.complete',
      messageIncludes: 'cannot dispatch truthfully',
    },
    {
      name: 'rejects a transform derivation on a non-transformable canonical field (CORE #8e)',
      mutate: (manifest) => {
        source(manifest).projection.canonical.state = {
          kind: 'transform',
          field: 'Body',
          transform: 'strip_html',
        };
        source(manifest).writable_fields =
          source(manifest).writable_fields.filter((field: string) => field !== 'state');
      },
      code: 'WORK_ENTITY_SOURCES_PROJECTION_INVALID',
      path: 'work_entity_sources[0].projection.canonical.state',
      messageIncludes: 'does not admit a transform derivation',
    },
    {
      name: 'rejects a transform derivation naming a transform outside the whitelist (CORE #8e)',
      mutate: (manifest) => {
        source(manifest).projection.canonical.title = {
          kind: 'transform',
          field: 'Body',
          transform: 'uppercase',
        };
        source(manifest).writable_fields =
          source(manifest).writable_fields.filter((field: string) => field !== 'title');
      },
      code: 'WORK_ENTITY_SOURCES_PROJECTION_INVALID',
      path: 'work_entity_sources[0].projection.canonical.title.transform',
      messageIncludes: 'strip_html',
    },
    {
      name: 'rejects a transform derivation with an empty remote field (CORE #8e)',
      mutate: (manifest) => {
        source(manifest).projection.canonical.title = {
          kind: 'transform',
          field: '',
          transform: 'strip_html',
        };
        source(manifest).writable_fields =
          source(manifest).writable_fields.filter((field: string) => field !== 'title');
      },
      code: 'WORK_ENTITY_SOURCES_PROJECTION_INVALID',
      path: 'work_entity_sources[0].projection.canonical.title.field',
      messageIncludes: 'non-empty remote field path',
    },
    {
      name: 'rejects a transform derivation missing the transform key (CORE #8e)',
      mutate: (manifest) => {
        source(manifest).projection.canonical.title = {
          kind: 'transform',
          field: 'Body',
        };
        source(manifest).writable_fields =
          source(manifest).writable_fields.filter((field: string) => field !== 'title');
      },
      code: 'WORK_ENTITY_SOURCES_PROJECTION_INVALID',
      path: 'work_entity_sources[0].projection.canonical.title.transform',
      messageIncludes: 'strip_html',
    },
    {
      name: 'rejects a transform-derived title in writable_fields (CORE #8e read-only)',
      mutate: (manifest) => {
        source(manifest).projection.canonical.title = {
          kind: 'transform',
          field: 'Body',
          transform: 'strip_html',
        };
      },
      code: 'WORK_ENTITY_SOURCES_WRITABLE_INVALID',
      path: 'work_entity_sources[0].writable_fields',
      messageIncludes: 'derived canonical fields are read-only in v1',
    },
    {
      name: "rejects remote.version kind 'none' carrying a field",
      mutate: (manifest) => {
        const s = source(manifest);
        s.remote.version = { kind: 'none', field: 'LastModifiedDate' };
        s.sync.mode = 'read_only';
        delete s.ops.create;
        delete s.ops.update;
        s.writable_fields = [];
        delete s.write_policy;
      },
      code: 'WORK_ENTITY_SOURCES_REMOTE_INVALID',
      path: 'work_entity_sources[0].remote.version.field',
      messageIncludes: "forbidden for kind 'none'",
    },
    {
      name: "rejects conditional_write etag with remote.version kind 'none'",
      mutate: (manifest) => {
        const s = source(manifest);
        s.remote.version = { kind: 'none' };
        delete s.ops.update;
        s.writable_fields = ['title'];
        s.write_policy.conditional_write = 'etag';
      },
      code: 'WORK_ENTITY_SOURCES_WRITE_POLICY_INVALID',
      path: 'work_entity_sources[0].write_policy.conditional_write',
      messageIncludes: "unsatisfiable with remote.version.kind 'none'",
    },
    {
      name: "rejects a targeted update op with remote.version kind 'none'",
      mutate: (manifest) => {
        source(manifest).remote.version = { kind: 'none' };
      },
      code: 'WORK_ENTITY_SOURCES_OP_INVALID',
      path: 'work_entity_sources[0].ops',
      messageIncludes: 'admits no targeted write ops',
    },
    {
      name: 'rejects preview max_chars above the hard cap',
      mutate: (manifest) => { source(manifest).projection.preview.body.max_chars = 2_001; },
      code: 'WORK_ENTITY_SOURCES_PROJECTION_INVALID',
      path: 'work_entity_sources[0].projection.preview.body.max_chars',
    },
    {
      name: 'rejects preview fields without detail_fidelity',
      mutate: (manifest) => { delete source(manifest).projection.extension.detail_fidelity; },
      code: 'WORK_ENTITY_SOURCES_PROJECTION_INVALID',
      path: 'work_entity_sources[0].projection.extension.detail_fidelity',
    },
    {
      name: 'rejects a detail_fidelity map that omits a preview field',
      mutate: (manifest) => { source(manifest).projection.extension.detail_fidelity = {}; },
      code: 'WORK_ENTITY_SOURCES_PROJECTION_INVALID',
      path: 'work_entity_sources[0].projection.extension.detail_fidelity',
    },
    {
      name: 'rejects a detail_fidelity map value other than preview',
      mutate: (manifest) => { source(manifest).projection.extension.detail_fidelity = { body: 'full' }; },
      code: 'WORK_ENTITY_SOURCES_PROJECTION_INVALID',
      path: 'work_entity_sources[0].projection.extension.detail_fidelity.body',
    },
    {
      name: 'rejects detail_fidelity when no preview lane exists',
      mutate: (manifest) => { delete source(manifest).projection.preview; },
      code: 'WORK_ENTITY_SOURCES_PROJECTION_INVALID',
      path: 'work_entity_sources[0].projection.extension.detail_fidelity',
    },
    {
      name: 'rejects extension values over 500 chars',
      mutate: (manifest) => { source(manifest).projection.extension.native_status = 'x'.repeat(501); },
      code: 'WORK_ENTITY_SOURCES_PROJECTION_INVALID',
      path: 'work_entity_sources[0].projection.extension.native_status',
    },
    {
      name: 'rejects writable fields outside canonical plus preview',
      mutate: (manifest) => { source(manifest).writable_fields.push('assigned_contact_id'); },
      code: 'WORK_ENTITY_SOURCES_WRITABLE_INVALID',
      path: 'work_entity_sources[0].writable_fields',
    },
    {
      name: 'rejects create and update ops with empty writable_fields',
      mutate: (manifest) => { source(manifest).writable_fields = []; },
      code: 'WORK_ENTITY_SOURCES_WRITABLE_INVALID',
      path: 'work_entity_sources[0].writable_fields',
    },
    {
      name: 'rejects relationship local_field outside the per-kind allowlist',
      mutate: (manifest) => { source(manifest).relationships[0].local_field = 'related_contact_ids'; },
      code: 'WORK_ENTITY_SOURCES_RELATIONSHIP_INVALID',
      path: 'work_entity_sources[0].relationships[0].local_field',
    },
    {
      name: 'rejects duplicate relationship local_field values',
      mutate: (manifest) => { source(manifest).relationships[1].local_field = 'assigned_contact_id'; },
      code: 'WORK_ENTITY_SOURCES_RELATIONSHIP_INVALID',
      path: 'work_entity_sources[0].relationships[1].local_field',
    },
    {
      name: 'rejects one cardinality for blocks_task_ids',
      mutate: (manifest) => { source(manifest).relationships[0].local_field = 'blocks_task_ids'; },
      code: 'WORK_ENTITY_SOURCES_RELATIONSHIP_INVALID',
      path: 'work_entity_sources[0].relationships[0].cardinality',
    },
    {
      name: 'rejects file as a relationship target with the attachment idiom message',
      mutate: (manifest) => { source(manifest).relationships[0].target = 'file'; },
      code: 'WORK_ENTITY_SOURCES_RELATIONSHIP_INVALID',
      path: 'work_entity_sources[0].relationships[0].target',
      messageIncludes: 'file rides data.link attachments',
    },
    {
      name: 'rejects an unknown relationship target noun',
      mutate: (manifest) => { source(manifest).relationships[0].target = 'supplier'; },
      code: 'WORK_ENTITY_SOURCES_RELATIONSHIP_INVALID',
      path: 'work_entity_sources[0].relationships[0].target',
    },
    {
      name: 'rejects remote_id pairing without remote_entity',
      mutate: (manifest) => { delete source(manifest).relationships[0].remote_entity; },
      code: 'WORK_ENTITY_SOURCES_RELATIONSHIP_INVALID',
      path: 'work_entity_sources[0].relationships[0].remote_entity',
    },
    {
      name: 'rejects lookup pairing without lookup_key',
      mutate: (manifest) => { source(manifest).relationships[0].pairing = 'lookup'; },
      code: 'WORK_ENTITY_SOURCES_RELATIONSHIP_INVALID',
      path: 'work_entity_sources[0].relationships[0].lookup_key',
    },
    {
      name: 'rejects lookup_key with non-lookup pairing',
      mutate: (manifest) => { source(manifest).relationships[0].lookup_key = 'email'; },
      code: 'WORK_ENTITY_SOURCES_RELATIONSHIP_INVALID',
      path: 'work_entity_sources[0].relationships[0].lookup_key',
    },
    {
      name: 'rejects relationship write_back true',
      mutate: (manifest) => { source(manifest).relationships[0].write_back = true; },
      code: 'WORK_ENTITY_SOURCES_RELATIONSHIP_INVALID',
      path: 'work_entity_sources[0].relationships[0].write_back',
    },
    {
      name: 'rejects missing write_policy on read_write',
      mutate: (manifest) => { delete source(manifest).write_policy; },
      code: 'WORK_ENTITY_SOURCES_WRITE_POLICY_INVALID',
      path: 'work_entity_sources[0].write_policy',
    },
    {
      name: 'rejects write_policy on read_only',
      mutate: (manifest) => { source(manifest).sync.mode = 'read_only'; },
      code: 'WORK_ENTITY_SOURCES_WRITE_POLICY_INVALID',
      path: 'work_entity_sources[0].write_policy',
    },
    {
      name: 'requires surfaces.api for work_entity_sources',
      mutate: (manifest) => { delete manifest.surfaces.api; },
      code: 'WORK_ENTITY_SOURCES_SURFACE_REQUIRED',
      path: 'work_entity_sources',
    },
    {
      name: 'rejects an empty work_entity_sources array',
      mutate: (manifest) => { manifest.work_entity_sources = []; },
      code: 'WORK_ENTITY_SOURCES_INVALID',
      path: 'work_entity_sources',
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expectWorkEntityError(
        testCase.mutate,
        testCase.code,
        testCase.path,
        testCase.messageIncludes,
      );
    });
  }

  it('rejects a note Source with neither canonical title nor preview', () => {
    const manifest = validNoteCatalog();
    expect(collectWorkEntityIssues(manifest)).toEqual([]);

    delete source(manifest).projection.canonical.title;
    const issues = collectWorkEntityIssues(manifest);

    expectIssue(
      issues,
      'WORK_ENTITY_SOURCES_PROJECTION_INVALID',
      'work_entity_sources[0].projection',
    );
  });

  it('accepts reference list rows when the read id binding is declared', () => {
    const manifest = validCatalog();
    source(manifest).sync.list_rows = 'reference';
    source(manifest).op_bindings = { read: { id_arg: 'task_id' } };

    expect(collectWorkEntityIssues(manifest)).toEqual([]);
  });

  it('accepts record and absent list row modes without a read id binding', () => {
    for (const listRows of ['record', undefined] as const) {
      const manifest = validCatalog();
      if (listRows === undefined) {
        delete source(manifest).sync.list_rows;
      } else {
        source(manifest).sync.list_rows = listRows;
      }

      expect(collectWorkEntityIssues(manifest)).toEqual([]);
    }
  });
});

describe('D-192 P1 work_entity_sources OpenAPI cross-check extension', () => {
  it('accepts a valid Source manifest when the document covers every REST binding', () => {
    const result = crossCheckCatalogOpenApi(validCatalog(), matchingOpenApiDocument());

    expect(result.valid).toBe(true);
    expect(openApiIssues(result)).toEqual([]);
  });

  it('rejects a Source op with a graphql binding as unprovable', () => {
    const manifest = validCatalog();
    executes(manifest)[TASK_READ_OP] = {
      kind: 'graphql',
      operation_type: 'query',
      endpoint_path: '/graphql',
      query: 'query Task { task { id } }',
    };

    const result = crossCheckCatalogOpenApi(manifest, matchingOpenApiDocument());

    expectOpenApiIssue(
      result,
      'CATALOG_OPENAPI_SOURCE_OP_UNPROVABLE',
      'work_entity_sources[0].ops.read',
    );
    expect(result.valid).toBe(false);
  });

  it('keeps the generic OpenAPI mismatch for a Source op whose REST path is absent', () => {
    const doc = matchingOpenApiDocument();
    delete doc.paths['/services/data/v60.0/sobjects/Task'];

    const result = crossCheckCatalogOpenApi(validCatalog(), doc);

    expectOpenApiIssue(
      result,
      'CATALOG_OPENAPI_MISMATCH',
      `surfaces.api.executes.${TASK_CREATE_OP}`,
    );
    expect(result.valid).toBe(false);
  });

  it('reports every Source op as unprovable when the api surface is absent', () => {
    const manifest = validCatalog();
    delete manifest.surfaces.api;

    const result = crossCheckCatalogOpenApi(manifest, matchingOpenApiDocument());

    expect(
      result.issues
        .filter((issue) => issue.code === 'CATALOG_OPENAPI_SOURCE_OP_UNPROVABLE')
        .map((issue) => issue.path),
    ).toEqual([
      'work_entity_sources[0].ops.list',
      'work_entity_sources[0].ops.read',
      'work_entity_sources[0].ops.create',
      'work_entity_sources[0].ops.update',
    ]);
    expect(result.valid).toBe(false);
  });

  // The PAIR of the test directly above, and the only variable between them is the
  // pin. Same manifest, same broken surface — but with NO `contract_source` the
  // Source claims no document, so the documentary prover must not touch it at all:
  // 4 unprovable issues collapse to 0. (D-192 authority ladder, ratified
  // 2026-07-14.)
  //
  // 🔴 This is the amendment's sharpest edge, and it is easy to miss. The absent
  // case USED to fall through to a fail-closed `declKind = 'openapi'` default —
  // harmless while absence was itself an error, and a LEGAL-SOURCE-REJECTOR the
  // moment absence became legal. The concrete victim is the MIXED pack: a vendor
  // whose OpenAPI covers tasks but not notes, so the pin is real and the note
  // Source deliberately carries none. That is not hypothetical — it is the kernel's
  // own HubSpot note today (the Notes OpenAPI is a SEPARATE document from the Tasks
  // pin). Without the absent-only skip it would be proven against a document it
  // never claimed, and rejected at publish.
  it('excludes an UNPINNED Source from the OpenAPI cross-check (its ops are proven empirically)', () => {
    const manifest = validCatalog();
    delete manifest.surfaces.api;
    delete source(manifest).contract_source;

    const result = crossCheckCatalogOpenApi(manifest, matchingOpenApiDocument());

    expect(
      result.issues.filter((issue) => issue.code === 'CATALOG_OPENAPI_SOURCE_OP_UNPROVABLE'),
    ).toEqual([]);
  });

  it('still skips ordinary non-Source graphql operations silently', () => {
    const manifest = validCatalog();
    manifest.operations['task.search'] = opSpec('task.search', 'read');
    executes(manifest)['task.search'] = {
      kind: 'graphql',
      operation_type: 'query',
      endpoint_path: '/graphql',
      query: 'query SearchTasks { tasks { id } }',
    };

    const result = crossCheckCatalogOpenApi(manifest, matchingOpenApiDocument());

    expect(result.valid).toBe(true);
    expect(openApiIssues(result)).toEqual([]);
  });
});

describe('D-192 P1 work_entity_sources validateIngredient integration', () => {
  it('wires the section validator into validateIngredient', () => {
    const manifest = validCatalog();
    source(manifest).source_kind = 'tenant';

    const result = validateIngredient(manifest);

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'WORK_ENTITY_SOURCES_INVALID',
          path: 'work_entity_sources[0].source_kind',
        }),
      ]),
    );
    expect(result.valid).toBe(false);
  });
});

// ── D-192 Gate E′ — graphql work-entity Sources ─────────────────────────────
// The gate-widen: a graphql-pinned Source (a `graphql_schema_source` pin +
// graphql op bindings + a graphql `contract_source`) validates, reusing the
// full worker-side `crossCheckGraphqlSchema` prover. The op-binding gate stays
// TIGHT — each op's binding kind must MATCH the transport its contract_source
// proves — so a transport mismatch (a REST op under a graphql Source or vice
// versa) and a realtime subscription binding still fail closed.
const GRAPHQL_SCHEMA_URL = 'https://api.linear.app/graphql/schema.graphql';

const graphqlCatalog = (): MutableCatalog => {
  const m = validCatalog();
  const a = api(m);
  delete a.openapi_source;
  a.graphql_schema_source = { url: GRAPHQL_SCHEMA_URL, sha256: VALID_SHA256 };
  a.transport = 'graphql';
  const e = executes(m);
  for (const opKey of Object.keys(e)) {
    const isWrite = opKey.endsWith('.create') || opKey.endsWith('.update');
    e[opKey] = {
      kind: 'graphql',
      operation_type: isWrite ? 'mutation' : 'query',
      endpoint_path: '/graphql',
      query: `${isWrite ? 'mutation' : 'query'} Op { __typename }`,
    };
  }
  source(m).contract_source = {
    kind: 'graphql',
    surface: 'surfaces.api.graphql_schema_source',
    url: GRAPHQL_SCHEMA_URL,
    sha256: VALID_SHA256,
    operations: [...TASK_OPS],
  };
  return m;
};

describe('D-192 Gate E′ graphql work_entity_sources', () => {
  it('accepts a graphql-pinned Source (graphql schema pin + graphql op bindings + graphql contract_source)', () => {
    expect(collectWorkEntityIssues(graphqlCatalog())).toEqual([]);
  });

  it('accepts graphql_schema_source alone as the surface prerequisite (no openapi/discovery pin)', () => {
    const manifest = graphqlCatalog();
    expect(api(manifest).openapi_source).toBeUndefined();
    expect(api(manifest).graphql_schema_source).toBeDefined();
    expect(
      collectWorkEntityIssues(manifest).some((i) => i.code === 'WORK_ENTITY_SOURCES_SURFACE_REQUIRED'),
    ).toBe(false);
  });

  it('fails closed when a graphql Source op binds a REST binding (transport mismatch — no op may escape its prover)', () => {
    const manifest = graphqlCatalog();
    executes(manifest)[TASK_READ_OP] = {
      kind: 'rest',
      method: 'GET',
      path_template: '/tasks/{{task_id}}',
    };
    expectIssue(
      collectWorkEntityIssues(manifest),
      'WORK_ENTITY_SOURCES_OP_INVALID',
      'work_entity_sources[0].ops.read',
      'graphql execution binding',
    );
  });

  it('fails closed when an openapi Source op binds a graphql binding (reverse mismatch, caught at the shape gate)', () => {
    const manifest = validCatalog();
    executes(manifest)[TASK_READ_OP] = {
      kind: 'graphql',
      operation_type: 'query',
      endpoint_path: '/graphql',
      query: 'query Op { __typename }',
    };
    expectIssue(
      collectWorkEntityIssues(manifest),
      'WORK_ENTITY_SOURCES_OP_INVALID',
      'work_entity_sources[0].ops.read',
      'rest execution binding',
    );
  });

  it('fails closed when a Source op binds a realtime subscription (webhook) binding', () => {
    const manifest = graphqlCatalog();
    executes(manifest)[TASK_LIST_OP] = {
      kind: 'webhook_subscription',
      signature_scheme: 'hmac_sha256_v1',
    };
    expectIssue(
      collectWorkEntityIssues(manifest),
      'WORK_ENTITY_SOURCES_OP_INVALID',
      'work_entity_sources[0].ops.list',
    );
  });

  it('excludes graphql Source ops from the OpenAPI cross-check (proven by crossCheckGraphqlSchema instead)', () => {
    const result = crossCheckCatalogOpenApi(graphqlCatalog(), matchingOpenApiDocument());
    // A graphql declaration's ops are NOT collected by the REST prover (declKind
    // 'graphql' ≠ 'openapi') — so none is reported unprovable against the OpenAPI doc.
    expect(
      result.issues.filter((i) => i.code === 'CATALOG_OPENAPI_SOURCE_OP_UNPROVABLE'),
    ).toEqual([]);
  });
});

describe('D-225 Slice 3 — an EMPIRICALLY-proven Source is not confined to REST', () => {
  /** ⛔ The bug: a missing `contract_source` resolved to the fail-closed
   *  `openapi`/REST default, which silently confined the EMPIRICAL route — the
   *  one the D-192 ladder rates HIGHEST — to REST-bound ops.
   *
   *  It was never mcp-specific: a doc-less Source over a graphql pack was
   *  rejected for the same reason. Widening for mcp alone would have left the
   *  real rule unstated.
   *
   *  With no pinned document there is no prover, so "must match the prover's
   *  transport" has nothing to say. The only constraint the machine can honestly
   *  impose is that the op is SYNCHRONOUSLY DISPATCHABLE. */
  const empirical = (bindingKind: string): MutableCatalog => {
    const manifest = validCatalog();
    delete source(manifest).contract_source;
    for (const op of Object.values(executes(manifest))) {
      for (const k of Object.keys(op)) delete op[k];
      op.kind = bindingKind;
      if (bindingKind === 'rest') { op.method = 'GET'; op.path_template = '/x'; }
      if (bindingKind === 'graphql') {
        op.operation_type = 'query'; op.query = 'query Q { a }'; op.endpoint_path = '/graphql';
      }
      if (bindingKind === 'mcp') op.tool = 'thing.list';
    }
    return manifest;
  };
  const opIssues = (m: MutableCatalog): Issue[] =>
    collectWorkEntityIssues(m).filter((i) => i.code === 'WORK_ENTITY_SOURCES_OP_INVALID');

  it('admits MCP-bound ops', () => {
    expect(opIssues(empirical('mcp'))).toEqual([]);
  });

  it('admits GRAPHQL-bound ops — the same bug, and it predates mcp', () => {
    expect(opIssues(empirical('graphql'))).toEqual([]);
  });

  it('still admits REST-bound ops', () => {
    expect(opIssues(empirical('rest'))).toEqual([]);
  });

  it('⛔ still REFUSES a realtime binding — it cannot back a Source op at all', () => {
    // The line the widening must not cross. A webhook/queue/push subscription
    // delivers events; it is not a call a sync walk can make, whatever proves
    // it. This is what separates "no prover, so no transport constraint" from
    // "no constraint at all".
    for (const realtime of ['webhook_subscription', 'queue_subscription', 'push_channel']) {
      const issues = opIssues(empirical(realtime));
      expect(issues.length, realtime).toBeGreaterThan(0);
      expect(issues[0]!.message).toMatch(/synchronously-dispatchable/);
    }
  });

  it('a PINNED Source still requires its prover’s transport', () => {
    // The paired direction. The widening applies ONLY where there is no
    // document; an openapi-pinned Source must still be REST, or an op would
    // escape the prover the pin exists to run.
    const manifest = empirical('mcp');
    source(manifest).contract_source = {
      kind: 'openapi',
      surface: 'surfaces.api.openapi_source',
      url: api(manifest).openapi_source?.url,
      sha256: api(manifest).openapi_source?.sha256,
    };
    const issues = opIssues(manifest);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.message).toMatch(/must have a rest execution binding/);
  });
});
