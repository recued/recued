/** D-192 P4c actor-aware create-source resolution and kernel origin forwarding. */

import Database from 'better-sqlite3';
import {
  RECUED_BUILTIN_SOURCE_ID,
  WORK_ENTITY_KINDS,
  type SourceRegistration,
  type Task,
  type WorkEntityKind,
} from '@recued/contracts';
import {
  createKernelAdapter,
  type KernelDispatchers,
  type ResolvedCall,
} from '@recued/ingredients';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createWorkEntityStore,
  ensureWorkEntitySchema,
  type WorkEntityStore,
} from '../storage/work-entity-store.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';

const NOW = 1_700_000_000_000;

let db: Database.Database;
let store: WorkEntityStore;
let dispatchers: ReturnType<typeof createWorkEntityDispatchers>;

const registerSource = (
  kind: WorkEntityKind,
  id: string,
  source_kind: SourceRegistration['source_kind'],
): SourceRegistration =>
  store.registerSource({
    id,
    top_tier_kind: kind,
    source_kind,
    source_label: id,
    write_capable: true,
    registered_at: NOW,
  });

const pinnedSourceId = (kind: WorkEntityKind): string => `adapterx.${kind}`;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  ensureWorkEntitySchema(db);
  store = createWorkEntityStore(db);

  for (const kind of WORK_ENTITY_KINDS) {
    registerSource(kind, RECUED_BUILTIN_SOURCE_ID(kind), 'builtin');
    registerSource(kind, pinnedSourceId(kind), 'adapter');
  }

  dispatchers = createWorkEntityDispatchers({
    store,
    resolver: createWorkEntityResolver(store),
    now: () => NOW,
  });
});

afterEach(() => {
  db.close();
});

describe('D-192 P4c dispatcher create-source resolution', () => {
  // ⛔ REWRITTEN for D-187 Sources half. This suite used to pin the sticky
  // per-kind default and the LLM-origin carve-out that skipped it — an
  // `isLlmOriginCreate` axis over (trigger_source, actor). Both are deleted:
  // resolution is now `explicit source_id ?? RECUED_BUILTIN_SOURCE_ID(kind)`.
  //
  // 🔑 The invariant worth pinning is therefore the OPPOSITE of the old one:
  // ORIGIN CANNOT STEER THE DESTINATION. Asserting only "chat goes local"
  // would pass vacuously now, so every origin the old suite separated is
  // driven here against the SAME expectation — that is what makes the
  // assertion mean something after the carve-out is gone.

  it('an explicit source_id wins, whatever the origin', async () => {
    for (const origin_trigger_source of ['chat', 'mcp', 'manual', 'reactive', 'auto_run']) {
      const out = await dispatchers.taskCreate({
        title: `explicit ${origin_trigger_source}`,
        source_id: pinnedSourceId('task'),
        origin_trigger_source,
      });
      expect(out.task.source_id).toBe(pinnedSourceId('task'));
    }
  });

  it.each([
    ['chat', 'user_self'],
    ['mcp', 'user_self'],
    ['manual', 'contracted_user'],
    ['reactive', 'user_self'],
    ['reactive', 'system'],
    ['manual', 'user_self'],
    ['manual', 'system'],
    ['auto_run', 'user_self'],
    ['auto_run', 'system'],
  ] as const)(
    'with no explicit source_id, %s creates by %s go LOCAL — origin is not a router',
    async (origin_trigger_source, origin_actor) => {
      const out = await dispatchers.taskCreate({
        title: `${origin_trigger_source} ${origin_actor}`,
        origin_trigger_source,
        origin_actor,
      });
      expect(out.task.source_id).toBe(RECUED_BUILTIN_SOURCE_ID('task'));
      // The registered non-builtin Source must NOT be reachable by inference.
      expect(out.task.source_id).not.toBe(pinnedSourceId('task'));
    },
  );

  it('every kind resolves local without an explicit source_id', async () => {
    const note = await dispatchers.noteCreate({ body: 'note body' });
    const commitment = await dispatchers.commitmentCreate({
      direction: 'outbound',
      statement: 'deliver the report',
      derivation: 'user_declared',
    });
    const project = await dispatchers.projectCreate({ title: 'project' });

    expect(note.note.source_id).toBe(RECUED_BUILTIN_SOURCE_ID('note'));
    expect(commitment.commitment.source_id).toBe(RECUED_BUILTIN_SOURCE_ID('commitment'));
    expect(project.project.source_id).toBe(RECUED_BUILTIN_SOURCE_ID('project'));
  });
});

const taskResult = (input: { title: string }): Task => ({
  id: 'task-from-kernel',
  title: input.title,
  done: false,
  created_at: NOW,
  updated_at: NOW,
  blocks_task_ids: [],
  source_id: RECUED_BUILTIN_SOURCE_ID('task'),
  last_seen_at: NOW,
  sync_state: 'live',
  conflict_policy: 'source_wins',
});

const mkCall = (
  input: Record<string, unknown>,
  stepMeta?: ResolvedCall['stepMeta'],
): ResolvedCall => ({
  slug: 'task-create',
  risk_tier: 'write',
  input,
  output: {},
  ...(stepMeta ? { stepMeta } : {}),
});

describe('D-192 P4c kernel adapter create-origin channel', () => {
  it('forwards actor and trigger_source from stepMeta to taskCreate', async () => {
    let captured: Parameters<NonNullable<KernelDispatchers['taskCreate']>>[0] | undefined;
    const adapter = createKernelAdapter({
      taskCreate: async (input) => {
        captured = input;
        return { task: taskResult(input) };
      },
    });
    const input = { title: 'from chat' };

    await adapter(mkCall(input, {
      step_id: 'create-task',
      actor: 'user_self',
      trigger_source: 'chat',
    }));

    expect(captured).toEqual({
      title: 'from chat',
      origin_actor: 'user_self',
      origin_trigger_source: 'chat',
    });
    expect(input).toEqual({ title: 'from chat' });
  });

  it('drops recipe-authored origin fields when stepMeta is absent and leaves caller input untouched', async () => {
    let captured: Parameters<NonNullable<KernelDispatchers['taskCreate']>>[0] | undefined;
    const adapter = createKernelAdapter({
      taskCreate: async (input) => {
        captured = input;
        return { task: taskResult(input) };
      },
    });
    const input = {
      title: 'spoofed origin',
      origin_actor: 'contracted_user',
      origin_trigger_source: 'chat',
    };

    await adapter(mkCall(input));

    expect(captured).toEqual({ title: 'spoofed origin' });
    expect(input).toEqual({
      title: 'spoofed origin',
      origin_actor: 'contracted_user',
      origin_trigger_source: 'chat',
    });
  });
});
