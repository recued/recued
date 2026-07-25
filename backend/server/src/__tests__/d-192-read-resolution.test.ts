/** D-192 read resolution - pure freshness, planner, wild-query, and
 *  long-text fidelity coverage. */

import type {
  SourceRegistration,
  WorkEntity,
  WorkEntityRemoteWhenReason,
  WorkEntitySourceFreshness,
  WorkEntitySourceReadResolution,
} from '@recued/contracts';
import { describe, expect, it } from 'vitest';

import type { WorkEntitySourceSyncState } from '../storage/work-entity-source-mirror.js';
import {
  WILD_QUERY_DEFAULT_MAX_REMOTE_RECORDS,
  WILD_QUERY_DEFAULT_MAX_SOURCES,
  classifyWorkEntitySourceFreshness,
  isWorkEntitySourceStale,
  planWorkEntityWildQueryReads,
  resolveWorkEntityReadPlan,
  workEntityDetailFidelity,
  workEntityLongText,
  type WildQuerySourceInput,
  type WorkEntityReadFidelity,
  type WorkEntityWildQueryPlan,
} from '../work-entity-read-resolution.js';

const NOW = 1_700_000_000_000;
const SOURCE = 'hubspot.acme.task';

const source = (
  source_kind: SourceRegistration['source_kind'],
  id = SOURCE,
): Pick<SourceRegistration, 'id' | 'source_kind'> => ({ id, source_kind });

const syncState = (
  overrides: Partial<WorkEntitySourceSyncState> = {},
): WorkEntitySourceSyncState => ({
  source_id: SOURCE,
  contract_hash: 'hash',
  sync_depth: 'meta',
  sync_mode: 'read_only',
  cursor_blob: null,
  last_sync_started_at: NOW - 2_000,
  last_sync_completed_at: NOW - 1_000,
  last_success_at: NOW - 500,
  last_error_code: null,
  last_error_message: null,
  degraded: false,
  field_health_blob: null,
  list_complete: true,
  stale_after_ms: 1_000,
  ...overrides,
});

const freshness = (
  source_id: string,
  state: WorkEntitySourceFreshness['state'],
): WorkEntitySourceFreshness => {
  if (state === 'local') return { source_id, state };
  return {
    source_id,
    state,
    last_success_at: state === 'never_synced' ? null : NOW - 500,
    stale_after_ms: 1_000,
    ...(state === 'degraded' ? { last_error_code: 'fetch_error' } : {}),
  };
};

const policy = (
  remote_when: WorkEntityRemoteWhenReason[] = [],
  wild_query: Partial<WorkEntitySourceReadResolution['wild_query']> = {},
): WorkEntitySourceReadResolution => ({
  default: 'local_rich_meta',
  remote_when: [...remote_when],
  wild_query: {
    remote_fanout: 'bounded_targeted',
    max_sources: 3,
    max_remote_records: 10,
    on_exceeds_cap: 'ask_to_narrow',
    ...wild_query,
  },
});

const wildSource = (
  source_id: string,
  opts: {
    state?: WorkEntitySourceFreshness['state'];
    freshness?: WorkEntitySourceFreshness;
    remote_when?: WorkEntityRemoteWhenReason[];
    policy?: WorkEntitySourceReadResolution | null;
    has_read_op?: boolean;
    record_ids?: readonly string[];
    wild_query?: Partial<WorkEntitySourceReadResolution['wild_query']>;
  } = {},
): WildQuerySourceInput => ({
  freshness: opts.freshness ?? freshness(source_id, opts.state ?? 'fresh'),
  policy:
    opts.policy !== undefined
      ? opts.policy
      : policy(opts.remote_when ?? [], opts.wild_query),
  has_read_op: opts.has_read_op ?? true,
  candidate_record_ids: opts.record_ids ?? [`${source_id}-record`],
});

const expectEscalate = (
  plan: WorkEntityWildQueryPlan,
): Extract<WorkEntityWildQueryPlan, { mode: 'escalate' }> => {
  if (plan.mode !== 'escalate') {
    throw new Error(`expected escalate plan, got ${plan.mode}`);
  }
  return plan;
};

const expectAskToNarrow = (
  plan: WorkEntityWildQueryPlan,
): Extract<WorkEntityWildQueryPlan, { mode: 'ask_to_narrow' }> => {
  if (plan.mode !== 'ask_to_narrow') {
    throw new Error(`expected ask_to_narrow plan, got ${plan.mode}`);
  }
  return plan;
};

const identity = {
  source_id: 'recued.task',
  last_seen_at: NOW,
  sync_state: 'live' as const,
  conflict_policy: 'source_wins' as const,
};

type TaskEntity = Extract<WorkEntity, { _kind: 'task' }>;
type NoteEntity = Extract<WorkEntity, { _kind: 'note' }>;
type CommitmentEntity = Extract<WorkEntity, { _kind: 'commitment' }>;
type ProjectEntity = Extract<WorkEntity, { _kind: 'project' }>;

const taskEntity = (overrides: Partial<TaskEntity> = {}): TaskEntity => ({
  _kind: 'task',
  id: 'task-1',
  title: 'Task',
  done: false,
  created_at: NOW,
  updated_at: NOW,
  blocks_task_ids: [],
  ...identity,
  ...overrides,
});

const noteEntity = (overrides: Partial<NoteEntity> = {}): NoteEntity => ({
  _kind: 'note',
  id: 'note-1',
  body: 'note body',
  created_at: NOW,
  updated_at: NOW,
  last_user_action_at: NOW,
  related_contact_ids: [],
  related_calendar_event_ids: [],
  related_mail_thread_ids: [],
  related_project_ids: [],
  ...identity,
  ...overrides,
});

const commitmentEntity = (
  overrides: Partial<CommitmentEntity> = {},
): CommitmentEntity => ({
  _kind: 'commitment',
  id: 'commitment-1',
  direction: 'outbound',
  statement: 'send the report',
  promised_at: NOW,
  lifecycle_state: 'pending',
  due_status: 'no_deadline',
  expiry_policy: 'escalate_overdue',
  created_at: NOW,
  updated_at: NOW,
  state_changed_at: NOW,
  lifecycle_changed_at: NOW,
  due_status_changed_at: NOW,
  derivation: 'user_declared',
  blocks_task_ids: [],
  blocks_project_ids: [],
  ...identity,
  ...overrides,
});

const projectEntity = (overrides: Partial<ProjectEntity> = {}): ProjectEntity => ({
  _kind: 'project',
  id: 'project-1',
  title: 'Project',
  state: 'active',
  created_at: NOW,
  updated_at: NOW,
  last_activity_at: NOW,
  related_contact_ids: [],
  ...identity,
  ...overrides,
});

describe('classifyWorkEntitySourceFreshness', () => {
  it.each([
    ['builtin'],
    ['adapter'],
    ['dish'],
  ] as const)('classifies %s sources as local', (source_kind) => {
    expect(
      classifyWorkEntitySourceFreshness(source(source_kind), syncState(), NOW),
    ).toEqual({ source_id: SOURCE, state: 'local' });
  });

  it('classifies a missing connection sync row as never_synced', () => {
    expect(
      classifyWorkEntitySourceFreshness(source('connection'), null, NOW),
    ).toEqual({
      source_id: SOURCE,
      state: 'never_synced',
      last_success_at: null,
    });
  });

  it('classifies a connection sync row with no last_success_at as never_synced', () => {
    expect(
      classifyWorkEntitySourceFreshness(
        source('connection'),
        syncState({ last_success_at: null }),
        NOW,
      ),
    ).toEqual({
      source_id: SOURCE,
      state: 'never_synced',
      last_success_at: null,
      stale_after_ms: 1_000,
    });
  });

  it('lets degraded win over a fresh-looking last_success_at and carries a non-null error code', () => {
    expect(
      classifyWorkEntitySourceFreshness(
        source('connection'),
        syncState({
          degraded: true,
          last_success_at: NOW,
          last_error_code: 'fetch_error',
          stale_after_ms: 60_000,
        }),
        NOW,
      ),
    ).toEqual({
      source_id: SOURCE,
      state: 'degraded',
      last_success_at: NOW,
      stale_after_ms: 60_000,
      last_error_code: 'fetch_error',
    });
  });

  it('treats the stale horizon as a strict boundary', () => {
    expect(
      classifyWorkEntitySourceFreshness(
        source('connection'),
        syncState({ last_success_at: NOW - 1_000, stale_after_ms: 1_000 }),
        NOW,
      ),
    ).toEqual({
      source_id: SOURCE,
      state: 'fresh',
      last_success_at: NOW - 1_000,
      stale_after_ms: 1_000,
    });

    expect(
      classifyWorkEntitySourceFreshness(
        source('connection'),
        syncState({ last_success_at: NOW - 1_001, stale_after_ms: 1_000 }),
        NOW,
      ),
    ).toEqual({
      source_id: SOURCE,
      state: 'stale',
      last_success_at: NOW - 1_001,
      stale_after_ms: 1_000,
    });
  });

  it('surfaces list_complete:false on a fresh-but-partial mirror, omits it when complete (CORE #8f)', () => {
    // Partial: fresh + degraded:false, but the last list walk was incomplete.
    expect(
      classifyWorkEntitySourceFreshness(
        source('connection'),
        syncState({ last_success_at: NOW - 100, stale_after_ms: 1_000, list_complete: false }),
        NOW,
      ),
    ).toEqual({
      source_id: SOURCE,
      state: 'fresh',
      last_success_at: NOW - 100,
      stale_after_ms: 1_000,
      list_complete: false,
    });
    // Complete: the flag is ABSENT (the common case stays quiet).
    const complete = classifyWorkEntitySourceFreshness(
      source('connection'),
      syncState({ last_success_at: NOW - 100, stale_after_ms: 1_000, list_complete: true }),
      NOW,
    );
    expect(complete.state).toBe('fresh');
    expect('list_complete' in complete).toBe(false);
  });

  it('omits last_error_code when the sync row has no error code', () => {
    const out = classifyWorkEntitySourceFreshness(
      source('connection'),
      syncState({ last_error_code: null }),
      NOW,
    );

    expect(out.state).toBe('fresh');
    expect(out).not.toHaveProperty('last_error_code');
  });
});

describe('isWorkEntitySourceStale', () => {
  it.each([
    ['stale', true],
    ['degraded', true],
    ['never_synced', true],
    ['fresh', false],
    ['local', false],
  ] as const)('returns %s for %s', (state, expected) => {
    expect(isWorkEntitySourceStale({ state })).toBe(expected);
  });
});

describe('resolveWorkEntityReadPlan', () => {
  it.each([
    'rich_meta',
    'remote_detail',
    'current_remote',
    'write_preflight',
  ] as const satisfies readonly WorkEntityReadFidelity[])(
    'short-circuits local sources for %s',
    (fidelity) => {
      expect(
        resolveWorkEntityReadPlan({
          fidelity,
          freshness: freshness('recued.task', 'local'),
          policy: policy([
            'field_missing',
            'source_stale',
            'complete_body_required',
            'comments_required',
            'attachments_required',
          ]),
          has_read_op: true,
        }),
      ).toEqual({ action: 'local', fresh: true, limitations: [] });
    },
  );

  it('always routes write_preflight remotely for connection sources', () => {
    expect(
      resolveWorkEntityReadPlan({
        fidelity: 'write_preflight',
        freshness: freshness(SOURCE, 'fresh'),
        policy: null,
        has_read_op: false,
      }),
    ).toEqual({ action: 'remote', reasons: ['write_preflight'] });

    expect(
      resolveWorkEntityReadPlan({
        fidelity: 'write_preflight',
        freshness: freshness(SOURCE, 'stale'),
        policy: policy([]),
        has_read_op: true,
      }),
    ).toEqual({ action: 'remote', reasons: ['write_preflight'] });
  });

  it('routes current_remote remotely and adds source_stale only when stale', () => {
    expect(
      resolveWorkEntityReadPlan({
        fidelity: 'current_remote',
        freshness: freshness(SOURCE, 'fresh'),
        policy: policy([]),
        has_read_op: true,
      }),
    ).toEqual({ action: 'remote', reasons: ['current_remote_required'] });

    expect(
      resolveWorkEntityReadPlan({
        fidelity: 'current_remote',
        freshness: freshness(SOURCE, 'stale'),
        policy: policy([]),
        has_read_op: true,
      }),
    ).toEqual({
      action: 'remote',
      reasons: ['current_remote_required', 'source_stale'],
    });
  });

  it('keeps current_remote local with explicit limitations when no read op exists', () => {
    expect(
      resolveWorkEntityReadPlan({
        fidelity: 'current_remote',
        freshness: freshness(SOURCE, 'fresh'),
        policy: policy([]),
        has_read_op: false,
      }),
    ).toEqual({
      action: 'local',
      fresh: true,
      limitations: ['no_remote_read_op', 'not_current'],
    });

    expect(
      resolveWorkEntityReadPlan({
        fidelity: 'current_remote',
        freshness: freshness(SOURCE, 'stale'),
        policy: policy([]),
        has_read_op: false,
      }),
    ).toEqual({
      action: 'local',
      fresh: false,
      limitations: ['no_remote_read_op', 'not_current', 'source_stale'],
    });
  });

  it('routes remote_detail by declared detail-reason intersection', () => {
    expect(
      resolveWorkEntityReadPlan({
        fidelity: 'remote_detail',
        freshness: freshness(SOURCE, 'fresh'),
        policy: policy([
          'field_missing',
          'attachments_required',
          'current_remote_required',
          'write_preflight',
        ]),
        has_read_op: true,
      }),
    ).toEqual({
      action: 'remote',
      reasons: ['attachments_required', 'field_missing'],
    });
  });

  it('escalates remote_detail for a stale source when source_stale is declared', () => {
    expect(
      resolveWorkEntityReadPlan({
        fidelity: 'remote_detail',
        freshness: freshness(SOURCE, 'stale'),
        policy: policy(['source_stale']),
        has_read_op: true,
      }),
    ).toEqual({ action: 'remote', reasons: ['source_stale'] });
  });

  it('keeps remote_detail local without limitations when no detail reason is declared and the source is fresh', () => {
    expect(
      resolveWorkEntityReadPlan({
        fidelity: 'remote_detail',
        freshness: freshness(SOURCE, 'fresh'),
        policy: policy([]),
        has_read_op: true,
      }),
    ).toEqual({ action: 'local', fresh: true, limitations: [] });
  });

  it('keeps remote_detail local with source_stale when stale escalation was not declared', () => {
    expect(
      resolveWorkEntityReadPlan({
        fidelity: 'remote_detail',
        freshness: freshness(SOURCE, 'stale'),
        policy: policy([]),
        has_read_op: true,
      }),
    ).toEqual({ action: 'local', fresh: false, limitations: ['source_stale'] });
  });

  it('keeps remote_detail local with no-read limitations when remote detail is declared but no read op exists', () => {
    expect(
      resolveWorkEntityReadPlan({
        fidelity: 'remote_detail',
        freshness: freshness(SOURCE, 'fresh'),
        policy: policy(['complete_body_required']),
        has_read_op: false,
      }),
    ).toEqual({
      action: 'local',
      fresh: true,
      limitations: ['no_remote_read_op', 'preview_only'],
    });

    expect(
      resolveWorkEntityReadPlan({
        fidelity: 'remote_detail',
        freshness: freshness(SOURCE, 'stale'),
        policy: policy(['source_stale']),
        has_read_op: false,
      }),
    ).toEqual({
      action: 'local',
      fresh: false,
      limitations: ['no_remote_read_op', 'source_stale'],
    });
  });

  it('keeps rich_meta local and reports source_stale instead of escalating', () => {
    expect(
      resolveWorkEntityReadPlan({
        fidelity: 'rich_meta',
        freshness: freshness(SOURCE, 'stale'),
        policy: policy([
          'field_missing',
          'source_stale',
          'complete_body_required',
          'comments_required',
          'attachments_required',
        ]),
        has_read_op: true,
      }),
    ).toEqual({ action: 'local', fresh: false, limitations: ['source_stale'] });
  });
});

describe('planWorkEntityWildQueryReads', () => {
  it('uses local mode when fresh rich-meta rows cover the query', () => {
    expect(
      planWorkEntityWildQueryReads(
        [wildSource('fresh', { remote_when: ['field_missing'] })],
        { detail: false, current: false },
      ),
    ).toEqual({ mode: 'local', limitations: [] });
  });

  it('keeps a stale source local with source_stale when source_stale was not declared', () => {
    expect(
      planWorkEntityWildQueryReads(
        [wildSource('stale', { state: 'stale', remote_when: [] })],
        { detail: false, current: false },
      ),
    ).toEqual({
      mode: 'local',
      limitations: [{ source_id: 'stale', limitations: ['source_stale'] }],
    });
  });

  it('returns targeted remote reads with the correct reasons and record ids', () => {
    const plan = expectEscalate(
      planWorkEntityWildQueryReads(
        [
          wildSource('detail', {
            remote_when: ['field_missing', 'attachments_required'],
            record_ids: ['d1', 'd2'],
          }),
          wildSource('stale', {
            state: 'stale',
            remote_when: ['source_stale'],
            record_ids: ['s1'],
          }),
        ],
        { detail: true, current: false },
      ),
    );

    expect(plan.reads).toEqual([
      {
        source_id: 'detail',
        record_ids: ['d1', 'd2'],
        reasons: ['attachments_required', 'field_missing'],
      },
      {
        source_id: 'stale',
        record_ids: ['s1'],
        reasons: ['source_stale'],
      },
    ]);
    expect(plan.limitations).toEqual([]);
  });

  it('skips local sources entirely even when the query asks for current detail', () => {
    const plan = expectEscalate(
      planWorkEntityWildQueryReads(
        [
          wildSource('recued.task', {
            state: 'local',
            remote_when: [
              'field_missing',
              'source_stale',
              'complete_body_required',
            ],
          }),
          wildSource('remote', { remote_when: ['field_missing'] }),
        ],
        { detail: true, current: true },
      ),
    );

    expect(plan.reads.map((read) => read.source_id)).toEqual(['remote']);
    expect(plan.limitations).toEqual([]);
  });

  it('turns no-read escalation candidates into limitations', () => {
    expect(
      planWorkEntityWildQueryReads(
        [
          wildSource('current-only', {
            has_read_op: false,
            remote_when: [],
          }),
        ],
        { detail: false, current: true },
      ),
    ).toEqual({
      mode: 'local',
      limitations: [
        { source_id: 'current-only', limitations: ['no_remote_read_op'] },
      ],
    });

    expect(
      planWorkEntityWildQueryReads(
        [
          wildSource('detail-stale', {
            state: 'stale',
            has_read_op: false,
            remote_when: ['field_missing', 'source_stale'],
          }),
        ],
        { detail: true, current: false },
      ),
    ).toEqual({
      mode: 'local',
      limitations: [
        {
          source_id: 'detail-stale',
          limitations: ['no_remote_read_op', 'preview_only', 'source_stale'],
        },
      ],
    });
  });

  it('uses the minimum max_sources cap across declared policies', () => {
    const plan = expectAskToNarrow(
      planWorkEntityWildQueryReads(
        [
          wildSource('cap-3', {
            wild_query: { max_sources: 3 },
          }),
          wildSource('cap-1', {
            wild_query: { max_sources: 1 },
          }),
        ],
        { detail: false, current: true },
      ),
    );

    expect(plan.cap).toBe('max_sources');
    expect(plan.detail).toContain('cap is 1');
    expect(plan.limitations).toEqual([
      { source_id: 'cap-3', limitations: ['not_current'] },
      { source_id: 'cap-1', limitations: ['not_current'] },
    ]);
  });

  it('applies default caps to null-policy candidates', () => {
    const maxSourcesPlan = expectAskToNarrow(
      planWorkEntityWildQueryReads(
        [
          wildSource('default-1', { policy: null }),
          wildSource('default-2', { policy: null }),
          wildSource('default-3', { policy: null }),
          wildSource('default-4', { policy: null }),
        ],
        { detail: false, current: true },
      ),
    );

    expect(WILD_QUERY_DEFAULT_MAX_SOURCES).toBe(3);
    expect(maxSourcesPlan.cap).toBe('max_sources');
    expect(maxSourcesPlan.detail).toContain('cap is 3');

    const maxRecordsPlan = expectAskToNarrow(
      planWorkEntityWildQueryReads(
        [
          wildSource('default-records', {
            policy: null,
            record_ids: Array.from(
              { length: WILD_QUERY_DEFAULT_MAX_REMOTE_RECORDS + 1 },
              (_value, i) => `r${i}`,
            ),
          }),
        ],
        { detail: false, current: true },
      ),
    );

    expect(WILD_QUERY_DEFAULT_MAX_REMOTE_RECORDS).toBe(10);
    expect(maxRecordsPlan.cap).toBe('max_remote_records');
    expect(maxRecordsPlan.detail).toContain('cap is 10');
  });

  it('asks to narrow when a per-source max_remote_records cap is exceeded', () => {
    const plan = expectAskToNarrow(
      planWorkEntityWildQueryReads(
        [
          wildSource('record-cap', {
            record_ids: ['r1', 'r2', 'r3'],
            wild_query: { max_remote_records: 2 },
          }),
        ],
        { detail: false, current: true },
      ),
    );

    expect(plan.cap).toBe('max_remote_records');
    expect(plan.detail).toContain("source 'record-cap'");
    expect(plan.limitations).toEqual([
      { source_id: 'record-cap', limitations: ['not_current'] },
    ]);
  });

  it('keeps ask_to_narrow limitations honest for current, detail, and stale reads', () => {
    const currentOnly = expectAskToNarrow(
      planWorkEntityWildQueryReads(
        [
          wildSource('fresh-a', { wild_query: { max_sources: 1 } }),
          wildSource('fresh-b', { wild_query: { max_sources: 1 } }),
        ],
        { detail: false, current: true },
      ),
    );

    expect(currentOnly.limitations).toEqual([
      { source_id: 'fresh-a', limitations: ['not_current'] },
      { source_id: 'fresh-b', limitations: ['not_current'] },
    ]);

    const detailAndStale = expectAskToNarrow(
      planWorkEntityWildQueryReads(
        [
          wildSource('fresh-detail', {
            remote_when: ['field_missing'],
            wild_query: { max_sources: 1 },
          }),
          wildSource('stale-detail', {
            state: 'stale',
            remote_when: ['field_missing', 'source_stale'],
            wild_query: { max_sources: 1 },
          }),
        ],
        { detail: true, current: true },
      ),
    );

    expect(detailAndStale.limitations).toEqual([
      { source_id: 'fresh-detail', limitations: ['preview_only', 'not_current'] },
      {
        source_id: 'stale-detail',
        limitations: ['preview_only', 'not_current', 'source_stale'],
      },
    ]);
  });
});

describe('workEntityLongText', () => {
  it('prefers canonical task body as complete text over preview text', () => {
    expect(
      workEntityLongText(
        taskEntity({
          body: 'canonical body',
          source_extension_blob: { preview: { body: 'preview body' } },
        }),
      ),
    ).toEqual({ field: 'body', text: 'canonical body', fidelity: 'complete' });
  });

  it('falls back to task body preview when the canonical body is null or empty', () => {
    expect(
      workEntityLongText(
        taskEntity({
          body: null as unknown as string,
          source_extension_blob: { preview: { body: 'preview body' } },
        }),
      ),
    ).toEqual({ field: 'body', text: 'preview body', fidelity: 'preview' });

    expect(
      workEntityLongText(
        taskEntity({
          body: '',
          source_extension_blob: { preview: { body: 'preview body' } },
        }),
      ),
    ).toEqual({ field: 'body', text: 'preview body', fidelity: 'preview' });
  });

  it('extracts complete long text from project, commitment, and note rows', () => {
    expect(
      workEntityLongText(projectEntity({ description: 'project description' })),
    ).toEqual({
      field: 'description',
      text: 'project description',
      fidelity: 'complete',
    });
    expect(
      workEntityLongText(commitmentEntity({ statement: 'commitment statement' })),
    ).toEqual({
      field: 'statement',
      text: 'commitment statement',
      fidelity: 'complete',
    });
    expect(workEntityLongText(noteEntity({ body: 'note body' }))).toEqual({
      field: 'body',
      text: 'note body',
      fidelity: 'complete',
    });
  });

  it('returns null for an entity with neither canonical nor preview long text', () => {
    expect(workEntityLongText(taskEntity())).toBeNull();
  });

  it('ignores non-string preview values', () => {
    expect(
      workEntityLongText(
        taskEntity({
          source_extension_blob: { preview: { body: 123, other: false } },
        }),
      ),
    ).toBeNull();

    expect(
      workEntityLongText(
        taskEntity({
          source_extension_blob: { preview: { body: 123, notes: 'usable preview' } },
        }),
      ),
    ).toEqual({ field: 'notes', text: 'usable preview', fidelity: 'preview' });
  });

  it.each([
    ['array', []],
    ['number', 7],
    ['string', 'blob'],
    ['null', null],
  ] as const)('handles malformed %s source_extension_blob values safely', (_label, blob) => {
    expect(
      workEntityLongText(
        taskEntity({ source_extension_blob: blob as unknown as Record<string, unknown> }),
      ),
    ).toBeNull();
  });
});

describe('workEntityDetailFidelity', () => {
  it('extracts only preview-valued detail_fidelity entries', () => {
    expect(
      workEntityDetailFidelity({
        source_extension_blob: {
          detail_fidelity: {
            body: 'preview',
            comments: 'complete',
            attachments: true,
            description: 'preview',
          },
        },
      }),
    ).toEqual({ body: 'preview', description: 'preview' });
  });

  it.each([
    ['array blob', []],
    ['primitive blob', 12],
    ['array detail_fidelity', { detail_fidelity: [] }],
    ['primitive detail_fidelity', { detail_fidelity: 'preview' }],
  ] as const)('returns an empty map for malformed %s', (_label, blob) => {
    expect(
      workEntityDetailFidelity({
        source_extension_blob: blob as unknown as Record<string, unknown>,
      }),
    ).toEqual({});
  });
});
