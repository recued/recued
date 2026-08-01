/** Federated-project prerequisite: recipe-callable native reads are real,
 * scoped before materialization, and wired through the registry/manifest/
 * adapter/dispatcher chain production uses. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createKernelAdapter } from '@recued/ingredients';
import {
  KERNEL_OP_REGISTRY,
  RECUED_BUILTIN_SOURCE_ID,
  kernelOpBackingSlug,
} from '@recued/contracts';

import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import {
  createWorkEntityStore,
  ensureWorkEntitySchema,
  type WorkEntityStore,
} from '../storage/work-entity-store.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';

let dir: string;
let db: Database.Database;
let store: WorkEntityStore;
let adapter: ReturnType<typeof createKernelAdapter>;

const mkCall = (slug: string, input: Record<string, unknown>) => ({
  slug,
  risk_tier: 'read' as const,
  input,
  output: {},
  manifest_version: 1,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'federated-project-native-read-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  ensureWorkEntitySchema(db);
  store = createWorkEntityStore(db);
  for (const kind of ['task', 'project'] as const) {
    store.registerSource({
      id: RECUED_BUILTIN_SOURCE_ID(kind),
      top_tier_kind: kind,
      source_kind: 'builtin',
      source_label: `Recued built-in (${kind})`,
      write_capable: true,
      mcp_exposed: false,
    });
  }
  adapter = createKernelAdapter(createWorkEntityDispatchers({
    store,
    resolver: createWorkEntityResolver(store),
    now: () => 1_700_000_000_000,
  }));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('federated-project native read surface', () => {
  it('keeps its registry, manifest, adapter, and dispatcher names joined', () => {
    for (const op of ['core.work-entity.list', 'core.work-entity.get']) {
      const entry = KERNEL_OP_REGISTRY.find((candidate) => candidate.op === op);
      expect(entry, op).toBeDefined();
      const slug = kernelOpBackingSlug(op);
      expect(slug, op).toBeDefined();
      expect(KERNEL_MANIFESTS.find((manifest) => manifest.slug === slug), slug).toBeDefined();
    }
  });

  it('applies parent_project_id in storage and reports an unpaginated total', async () => {
    const projectSource = RECUED_BUILTIN_SOURCE_ID('project');
    const taskSource = RECUED_BUILTIN_SOURCE_ID('task');
    const projectA = store.writeProject({ title: 'Shared A', source_id: projectSource }, 1_700_000_000_000);
    const projectB = store.writeProject({ title: 'Private B', source_id: projectSource }, 1_700_000_000_000);
    store.writeTask({ title: 'A one', parent_project_id: projectA.id, source_id: taskSource }, 1_700_000_000_001);
    store.writeTask({ title: 'A two', parent_project_id: projectA.id, source_id: taskSource }, 1_700_000_000_002);
    store.writeTask({ title: 'B private', parent_project_id: projectB.id, source_id: taskSource }, 1_700_000_000_003);

    const result = await adapter(mkCall('work-entity-list', {
      kind: 'task',
      parent_project_id: projectA.id,
      limit: 1,
    }));
    const out = result as { entities: Array<{ title: string }>; total: number };

    expect(out.total).toBe(2);
    expect(out.entities).toHaveLength(1);
    expect(out.entities[0]?.title).toMatch(/^A /);
    expect(JSON.stringify(out)).not.toContain('B private');
  });

  it('reads one exact project and exposes an explicit found verdict', async () => {
    const project = store.writeProject({
      title: 'Shared project',
      source_id: RECUED_BUILTIN_SOURCE_ID('project'),
    }, 1_700_000_000_000);

    await expect(adapter(mkCall('work-entity-get', {
      kind: 'project',
      id: project.id,
    }))).resolves.toMatchObject({
      found: true,
      entity: { _kind: 'project', id: project.id, title: 'Shared project' },
    });
    await expect(adapter(mkCall('work-entity-get', {
      kind: 'project',
      id: 'missing',
    }))).resolves.toEqual({ found: false, entity: null });
  });

  it('refuses a parent scope on a kind that has no project parent', async () => {
    await expect(adapter(mkCall('work-entity-list', {
      kind: 'note',
      parent_project_id: 'project-1',
    }))).rejects.toThrow(/parent_project_id is admitted only for task or project/);
  });

  it('fails closed instead of dropping malformed list scopes or pagination', async () => {
    await expect(adapter(mkCall('work-entity-list', {
      kind: 'task',
      parent_project_id: '',
    }))).rejects.toThrow(/parent_project_id must be a non-empty string/);
    await expect(adapter(mkCall('work-entity-list', {
      kind: 'task',
      source_id: null,
    }))).rejects.toThrow(/source_id must be a non-empty string/);
    await expect(adapter(mkCall('work-entity-list', {
      kind: 'task',
      offset: -1,
    }))).rejects.toThrow(/offset must be a non-negative integer/);
  });
});
