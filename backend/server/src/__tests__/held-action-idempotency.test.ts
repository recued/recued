/** D-157 Part C - held-action idempotency unit coverage. */

import type { Checkpoint, ExecutionSource } from '@recued/contracts';
import {
  buildAuditEntry,
  createAuditLogStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditEntry,
  type AuditLogStore,
  type CheckpointStore,
} from '@recued/storage';
import { extractVariableDefault } from '@recued/engine';
import { describe, expect, it, vi } from 'vitest';

import {
  awaitInflightHold,
  buildHeldActionAuthority,
  buildHeldConfigSnapshot,
  buildHeldTwinResponse,
  claimInflightHold,
  configSnapshotsEqual,
  computeHeldActionKey,
  findLiveHeldTwin,
  HELD_DEDUP_CHANNELS,
  isHeldDedupEligibleSource,
  type HeldActionIdentity,
} from '../held-action-idempotency.js';
import {
  HELD_FOR_APPROVAL_MESSAGE,
  projectRunResultForAgent,
} from '../run-result-agent-projection.js';

const CHANNEL_SESSION_ID = 'chat:chat-held-session';
const RECIPE_ID = 'held-action-idempotency-recipe';
const RECIPE_HASH = 'hash-held-action';
const CHECKPOINT_ID = 'checkpoint-live-1';
const FIXED_NOW = 1_750_000_000_000;

const chatSource: ExecutionSource = {
  channel: 'chat',
  actor: 'user_self',
  chat_session_id: 'chat-held-session',
  user_id: 'user-1',
};

const contractedChatSource: ExecutionSource = {
  ...chatSource,
  actor: 'contracted_user',
  contract_id: 'contract-1',
};

const selfRestrictedChatSource: ExecutionSource = {
  ...chatSource,
  contract_id: 'contract-1',
};

const identity: HeldActionIdentity = {
  channel_session_id: CHANNEL_SESSION_ID,
  authority: buildHeldActionAuthority(chatSource),
  recipe_id: RECIPE_ID,
  recipe_hash: RECIPE_HASH,
  config_snapshot: {
    mode: 'send',
    nested: { one: 1, two: [2, 3] },
    enabled: true,
  },
};

const auditLog = (): AuditLogStore =>
  createAuditLogStore(
    createInMemoryCollection<AuditEntry>(),
    createInMemoryCollection<ActivityEntry>(),
  );

const buildCheckpoint = (overrides: Partial<Checkpoint> = {}): Checkpoint => ({
  checkpoint_id: CHECKPOINT_ID,
  run_id: 'run-live-1',
  recipe_id: RECIPE_ID,
  gated_step_id: 'send_message',
  step_state: {},
  created_at: FIXED_NOW,
  ...overrides,
});

const checkpointStore = (
  ...checkpoints: Checkpoint[]
): Pick<CheckpointStore, 'get'> & {
  get: ReturnType<typeof vi.fn>;
} => {
  const live = new Map(checkpoints.map((checkpoint) => [
    checkpoint.checkpoint_id,
    checkpoint,
  ]));
  return {
    get: vi.fn(async (checkpoint_id: string) => live.get(checkpoint_id) ?? null),
  };
};

const buildAnchor = (
  overrides: {
    run_id?: string;
    now?: number;
    channel_session_id?: string;
    recipe_id?: string;
    recipe_hash?: string;
    config_snapshot?: Record<string, unknown>;
    commit_status?: AuditEntry['commit_status'];
    checkpoint_id?: string | null;
    duration_ms?: number;
    execution_source?: ExecutionSource | null;
  } = {},
): AuditEntry => {
  const checkpointId =
    overrides.checkpoint_id === null
      ? undefined
      : overrides.checkpoint_id ?? CHECKPOINT_ID;

  return buildAuditEntry({
    recipe_id: overrides.recipe_id ?? RECIPE_ID,
    recipe_hash: overrides.recipe_hash ?? RECIPE_HASH,
    commit_status: overrides.commit_status ?? 'awaiting_approval',
    duration_ms: overrides.duration_ms ?? 0,
    errors: [],
    config_snapshot: overrides.config_snapshot ?? identity.config_snapshot,
    channel_session_id: overrides.channel_session_id ?? CHANNEL_SESSION_ID,
    ...(overrides.execution_source !== null
      ? { execution_source: overrides.execution_source ?? chatSource }
      : {}),
    run_id: overrides.run_id ?? 'run-live-1',
    now: overrides.now ?? FIXED_NOW,
    ...(checkpointId !== undefined ? { checkpoint_id: checkpointId } : {}),
  });
};

describe('configSnapshotsEqual (D-177 N.7 — canonical hash equality)', () => {
  it('returns true for structurally equal snapshots with reordered keys', () => {
    expect(
      configSnapshotsEqual(
        { a: 1, nested: { z: [1, 2], a: { b: true } } },
        { nested: { a: { b: true }, z: [1, 2] }, a: 1 },
      ),
    ).toBe(true);
  });

  it('returns false for unequal snapshots', () => {
    expect(
      configSnapshotsEqual(
        { a: 1, nested: { z: [1, 2] } },
        { a: 1, nested: { z: [2, 1] } },
      ),
    ).toBe(false);
  });

  it('keeps an explicit null distinct from an absent / undefined value', () => {
    expect(configSnapshotsEqual({ value: null }, {})).toBe(false);
    expect(configSnapshotsEqual({ value: null }, { value: undefined })).toBe(
      false,
    );
  });

  it('equates a resolved-undefined variable with its JSON-round-tripped absence (the N.7 fix)', () => {
    // A default-less recipe variable resolves to `undefined`; the persisted
    // anchor's config_snapshot drops the key on the JSON round-trip. The old
    // sentinel-based stringify kept them distinct, so the dedup silently
    // never fired for such recipes — the wire projection makes the fresh
    // identity match the stored anchor.
    expect(configSnapshotsEqual({ subject: undefined, mode: 'send' }, { mode: 'send' })).toBe(true);
  });

  it('matches nothing when a snapshot has no canonical form (fail-safe to a normal run)', () => {
    const unhashable = { when: new Date(0) } as unknown as Record<string, unknown>;
    expect(configSnapshotsEqual(unhashable, unhashable)).toBe(false);
    expect(configSnapshotsEqual({ n: Number.NaN }, { n: Number.NaN })).toBe(false);
  });
});

describe('computeHeldActionKey', () => {
  it('is independent of identity object and config key order', () => {
    const reorderedIdentity: HeldActionIdentity = {
      recipe_hash: RECIPE_HASH,
      config_snapshot: {
        nested: { two: [2, 3], one: 1 },
        enabled: true,
        mode: 'send',
      },
      recipe_id: RECIPE_ID,
      channel_session_id: CHANNEL_SESSION_ID,
      authority: buildHeldActionAuthority(chatSource),
    };

    expect(computeHeldActionKey(reorderedIdentity)).toBe(
      computeHeldActionKey(identity),
    );
  });

  it.each([
    [
      'channel_session_id',
      { ...identity, channel_session_id: 'chat:other-session' },
    ],
    ['recipe_id', { ...identity, recipe_id: 'other-recipe' }],
    ['recipe_hash', { ...identity, recipe_hash: 'other-hash' }],
    [
      'authority actor',
      { ...identity, authority: buildHeldActionAuthority(contractedChatSource) },
    ],
    [
      'authority contract',
      { ...identity, authority: buildHeldActionAuthority(selfRestrictedChatSource) },
    ],
    [
      'config_snapshot',
      {
        ...identity,
        config_snapshot: { ...identity.config_snapshot, mode: 'different' },
      },
    ],
  ] as const)('changes when %s differs', (_field, variant) => {
    expect(computeHeldActionKey(variant)).not.toBe(computeHeldActionKey(identity));
  });

  it('returns null when the config snapshot has no canonical form', () => {
    expect(
      computeHeldActionKey({
        ...identity,
        config_snapshot: { n: Number.NaN },
      }),
    ).toBeNull();
  });
});

describe('in-flight hold registry', () => {
  it('allows only one unsettled leader and releases the slot after settle', async () => {
    const key = 'unit-registry-single-leader';
    const claim = claimInflightHold(key);
    if (claim === null) throw new Error('expected initial claim');
    let freshClaim: ReturnType<typeof claimInflightHold> = null;

    try {
      expect(claimInflightHold(key)).toBeNull();
      const pending = awaitInflightHold(key);
      if (pending === null) throw new Error('expected pending in-flight hold');

      claim.settle({ status: 'durable', run_id: 'run-1' });
      await expect(pending).resolves.toEqual({
        status: 'durable',
        run_id: 'run-1',
      });
      expect(awaitInflightHold(key)).toBeNull();

      freshClaim = claimInflightHold(key);
      if (freshClaim === null) throw new Error('expected fresh claim after settle');
      const freshPending = awaitInflightHold(key);
      if (freshPending === null) throw new Error('expected fresh pending hold');
      freshClaim.settle({ status: 'failed' });
      await expect(freshPending).resolves.toEqual({ status: 'failed' });
      expect(awaitInflightHold(key)).toBeNull();
    } finally {
      freshClaim?.settle({ status: 'failed' });
      claim.settle({ status: 'failed' });
    }
  });

  it('makes settle once-only', async () => {
    const key = 'unit-registry-once-only';
    const claim = claimInflightHold(key);
    if (claim === null) throw new Error('expected initial claim');

    try {
      const pending = awaitInflightHold(key);
      if (pending === null) throw new Error('expected pending in-flight hold');

      claim.settle({ status: 'durable', run_id: 'run-once' });
      expect(() => claim.settle({ status: 'failed' })).not.toThrow();

      await expect(pending).resolves.toEqual({
        status: 'durable',
        run_id: 'run-once',
      });
      expect(awaitInflightHold(key)).toBeNull();
    } finally {
      claim.settle({ status: 'failed' });
    }
  });
});

describe('buildHeldConfigSnapshot', () => {
  it('resolves schema-form variable defaults', () => {
    expect(
      buildHeldConfigSnapshot(
        {
          subject: {
            label: 'Subject',
            type: 'string',
            default: 'x',
          },
        },
        {},
      ),
    ).toEqual({ subject: 'x' });
  });

  it('drops no-default ValueHint variables from the JSON snapshot in lockstep with extractVariableDefault', () => {
    const hint = {
      label: 'Subject',
      type: 'string',
    };
    const snapshot = buildHeldConfigSnapshot({ subject: hint }, {});
    const jsonSnapshot = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;

    expect(extractVariableDefault(hint)).toBeUndefined();
    expect(snapshot.subject).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(jsonSnapshot, 'subject')).toBe(false);
    expect(jsonSnapshot).toEqual({});
  });

  it('resolves array-shorthand variable defaults to the first element', () => {
    expect(buildHeldConfigSnapshot({ choice: ['a', 'b'] }, {})).toEqual({
      choice: 'a',
    });
  });

  it('passes plain-value variables through unchanged', () => {
    expect(
      buildHeldConfigSnapshot(
        {
          count: 3,
          title: 'plain',
          enabled: false,
        },
        {},
      ),
    ).toEqual({
      count: 3,
      title: 'plain',
      enabled: false,
    });
  });

  it('lets config overrides win over resolved variable defaults', () => {
    expect(
      buildHeldConfigSnapshot(
        {
          subject: {
            label: 'Subject',
            type: 'string',
            default: 'x',
          },
        },
        { subject: 'override' },
      ),
    ).toEqual({ subject: 'override' });
  });

  it('includes config keys with no matching variable', () => {
    expect(buildHeldConfigSnapshot({ subject: 'x' }, { extra: 'kept' })).toEqual({
      subject: 'x',
      extra: 'kept',
    });
  });

  it('returns just the config for undefined or empty variables', () => {
    const config = { extra: 'kept' };

    expect(buildHeldConfigSnapshot(undefined, config)).toEqual(config);
    expect(buildHeldConfigSnapshot({}, config)).toEqual(config);
    expect(buildHeldConfigSnapshot(undefined, {})).toEqual({});
  });

  it('matches the resolved snapshot used by configSnapshotsEqual', () => {
    const snapshot = buildHeldConfigSnapshot(
      {
        subject: {
          label: 'Subject',
          type: 'string',
          default: 'x',
        },
        choice: ['a', 'b'],
        count: 3,
      },
      { extra: 'kept' },
    );
    const resolvedSnapshot = {
      subject: 'x',
      choice: 'a',
      count: 3,
      extra: 'kept',
    };

    expect(snapshot).toEqual(resolvedSnapshot);
    expect(configSnapshotsEqual(snapshot, resolvedSnapshot)).toBe(true);
  });
});

describe('findLiveHeldTwin', () => {
  it('returns a live twin on full identity match', async () => {
    const log = auditLog();
    const twin = buildAnchor();
    await log.append(twin);

    const found = await findLiveHeldTwin(
      { auditLog: log, checkpointStore: checkpointStore(buildCheckpoint()) },
      identity,
    );

    expect(found?.run_id).toBe(twin.run_id);
  });

  it('returns null when config_snapshot differs', async () => {
    const log = auditLog();
    await log.append(buildAnchor({ config_snapshot: { mode: 'different' } }));

    await expect(
      findLiveHeldTwin(
        { auditLog: log, checkpointStore: checkpointStore(buildCheckpoint()) },
        identity,
      ),
    ).resolves.toBeNull();
  });

  it('returns null when recipe_id differs', async () => {
    const log = auditLog();
    await log.append(buildAnchor({ recipe_id: 'other-recipe' }));

    await expect(
      findLiveHeldTwin(
        { auditLog: log, checkpointStore: checkpointStore(buildCheckpoint()) },
        identity,
      ),
    ).resolves.toBeNull();
  });

  it('returns null when recipe_hash differs', async () => {
    const log = auditLog();
    await log.append(buildAnchor({ recipe_hash: 'other-hash' }));

    await expect(
      findLiveHeldTwin(
        { auditLog: log, checkpointStore: checkpointStore(buildCheckpoint()) },
        identity,
      ),
    ).resolves.toBeNull();
  });

  it.each([
    ['actor differs', contractedChatSource],
    ['contract differs', selfRestrictedChatSource],
  ] as const)('returns null when source authority %s', async (_label, source) => {
    const log = auditLog();
    await log.append(buildAnchor({ execution_source: source }));

    await expect(
      findLiveHeldTwin(
        { auditLog: log, checkpointStore: checkpointStore(buildCheckpoint()) },
        identity,
      ),
    ).resolves.toBeNull();
  });

  it('returns null when a legacy anchor has no source authority', async () => {
    const log = auditLog();
    await log.append(buildAnchor({ execution_source: null }));

    await expect(
      findLiveHeldTwin(
        { auditLog: log, checkpointStore: checkpointStore(buildCheckpoint()) },
        identity,
      ),
    ).resolves.toBeNull();
  });

  it.each(['succeeded', 'failed', 'cancelled', 'in_doubt'] as const)(
    'returns null for terminal status %s',
    async (commit_status) => {
      const log = auditLog();
      await log.append(buildAnchor({ commit_status, checkpoint_id: null }));

      await expect(
        findLiveHeldTwin(
          { auditLog: log, checkpointStore: checkpointStore(buildCheckpoint()) },
          identity,
        ),
      ).resolves.toBeNull();
    },
  );

  it('returns null when there are no awaiting rows', async () => {
    await expect(
      findLiveHeldTwin(
        { auditLog: auditLog(), checkpointStore: checkpointStore(buildCheckpoint()) },
        identity,
      ),
    ).resolves.toBeNull();
  });

  it('returns null when the awaiting anchor checkpoint was reaped', async () => {
    const log = auditLog();
    await log.append(buildAnchor());

    await expect(
      findLiveHeldTwin(
        { auditLog: log, checkpointStore: checkpointStore() },
        identity,
      ),
    ).resolves.toBeNull();
  });

  it('returns the most recent live match when multiple awaiting twins match', async () => {
    const log = auditLog();
    await log.append(
      buildAnchor({
        run_id: 'run-older',
        checkpoint_id: 'checkpoint-older',
        now: FIXED_NOW,
      }),
    );
    await log.append(
      buildAnchor({
        run_id: 'run-newer',
        checkpoint_id: 'checkpoint-newer',
        now: FIXED_NOW + 1_000,
      }),
    );

    const found = await findLiveHeldTwin(
      {
        auditLog: log,
        checkpointStore: checkpointStore(
          buildCheckpoint({
            checkpoint_id: 'checkpoint-older',
            run_id: 'run-older',
          }),
          buildCheckpoint({
            checkpoint_id: 'checkpoint-newer',
            run_id: 'run-newer',
          }),
        ),
      },
      identity,
    );

    expect(found?.run_id).toBe('run-newer');
  });
});

describe('buildHeldTwinResponse', () => {
  it('builds the held twin ExecuteResponse shape and clean agent projection', () => {
    const twin = buildAnchor();
    const response = buildHeldTwinResponse(twin);

    expect(response.awaiting_approval).toBe(true);
    expect(response.recipe_id).toBe(twin.recipe_id);
    expect(response.recipe_hash).toBe(twin.recipe_hash);
    expect(response.success).toBe(false);
    expect(response.steps).toEqual([]);
    expect(response.errors).toEqual([]);
    expect(response.output.render).toEqual([]);
    expect(response.output.sidebar).toEqual([]);

    expect(projectRunResultForAgent(response)).toEqual({
      status: 'awaiting_approval',
      awaiting_approval: true,
      recipe_id: twin.recipe_id,
      message: HELD_FOR_APPROVAL_MESSAGE,
    });
  });
});

describe('HELD_DEDUP_CHANNELS', () => {
  it('includes only chat, messenger, and mcp agent-resend channels', () => {
    expect(HELD_DEDUP_CHANNELS.has('chat')).toBe(true);
    expect(HELD_DEDUP_CHANNELS.has('messenger')).toBe(true);
    expect(HELD_DEDUP_CHANNELS.has('mcp')).toBe(true);

    for (const channel of [
      'reactive',
      'schedule',
      'webhook',
      'reception',
      'user',
      'housekeeping',
    ] as const) {
      expect(HELD_DEDUP_CHANNELS.has(channel)).toBe(false);
    }
  });
});

describe('isHeldDedupEligibleSource', () => {
  it('admits only the owner lane for messenger', () => {
    const ownerSource: ExecutionSource = {
      channel: 'messenger',
      actor: 'user_self',
      vendor: 'slack',
      from: 'U-owner',
    };
    const contractedSource: ExecutionSource = {
      ...ownerSource,
      actor: 'contracted_user',
      contract_id: 'contract-1',
    };

    expect(isHeldDedupEligibleSource(ownerSource)).toBe(true);
    expect(isHeldDedupEligibleSource(contractedSource)).toBe(false);
  });
});
