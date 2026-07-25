/** D-157 P1 - preflight checkpoint store.
 *
 *  Tests the write-once checkpoint persistence substrate over the
 *  in-memory Collection reference implementation. */

import { beforeEach, describe, expect, it } from 'vitest';

import type { AuditExportEntry, Checkpoint } from '@recued/contracts';
import {
  createCheckpointStore,
  createInMemoryCollection,
  type AuditEntryInput,
  type CheckpointStore,
  type Collection,
} from '../index.js';

const checkpoint = (overrides: Partial<Checkpoint> = {}): Checkpoint => ({
  checkpoint_id: 'checkpoint-1',
  run_id: 'run-a',
  recipe_id: 'recipe-1',
  gated_step_id: 'send-mail',
  step_state: { lookup: { email: 'ada@example.com' } },
  created_at: 1_700_000_000_000,
  ...overrides,
});

let backing: Collection<Checkpoint>;
let store: CheckpointStore;

beforeEach(() => {
  backing = createInMemoryCollection<Checkpoint>();
  store = createCheckpointStore(backing);
});

describe('createCheckpointStore write/get', () => {
  it('write persists a checkpoint and get round-trips the exact object', async () => {
    const row = checkpoint({ checkpoint_id: 'round-trip' });

    await store.write(row);

    expect(await store.get('round-trip')).toEqual(row);
  });

  it('round-trips arg_overrides (D-173 N.5) — the whole-object blob carries the new field', async () => {
    const row = checkpoint({
      checkpoint_id: 'round-trip-edits',
      arg_overrides: {
        start_at: 1_700_000_100_000,
        calendar_id: 'cal-x',
        note: 'edited at approval',
      },
    });

    await store.write(row);

    const read = await store.get('round-trip-edits');
    expect(read).toEqual(row);
    expect(read?.arg_overrides).toEqual({
      start_at: 1_700_000_100_000,
      calendar_id: 'cal-x',
      note: 'edited at approval',
    });
  });

  it('write throws on a second write with the same checkpoint_id', async () => {
    await store.write(checkpoint({
      checkpoint_id: 'duplicate',
      run_id: 'run-a',
      recipe_id: 'recipe-a',
    }));

    await expect(store.write(checkpoint({
      checkpoint_id: 'duplicate',
      run_id: 'run-b',
      recipe_id: 'recipe-b',
      gated_step_id: 'different-step',
      created_at: 1_700_000_000_500,
    }))).rejects.toThrow(/already written/);
  });

  it('get returns null for an unknown checkpoint_id', async () => {
    expect(await store.get('missing')).toBeNull();
  });
});

describe('createCheckpointStore listByRun', () => {
  it('returns only rows matching the given run_id, ordered newest created_at first', async () => {
    const rows = [
      checkpoint({ checkpoint_id: 'run-a-old', run_id: 'run-a', created_at: 100 }),
      checkpoint({ checkpoint_id: 'run-b', run_id: 'run-b', created_at: 300 }),
      checkpoint({ checkpoint_id: 'run-a-new', run_id: 'run-a', created_at: 200 }),
    ];
    for (const row of rows) await store.write(row);

    expect((await store.listByRun('run-a')).map((c) => c.checkpoint_id))
      .toEqual(['run-a-new', 'run-a-old']);
  });

  it('orders multiple checkpoints for one run by descending created_at', async () => {
    const rows = [
      checkpoint({ checkpoint_id: 'old', run_id: 'run-a', created_at: 100 }),
      checkpoint({ checkpoint_id: 'new', run_id: 'run-a', created_at: 300 }),
      checkpoint({ checkpoint_id: 'mid', run_id: 'run-a', created_at: 200 }),
    ];
    for (const row of rows) await store.write(row);

    expect((await store.listByRun('run-a')).map((c) => c.checkpoint_id))
      .toEqual(['new', 'mid', 'old']);
  });

  it('returns [] for empty string run_id', async () => {
    await store.write(checkpoint({ checkpoint_id: 'row', run_id: 'run-a' }));

    expect(await store.listByRun('')).toEqual([]);
  });

  it('returns [] for a run_id with no matching rows', async () => {
    await store.write(checkpoint({ checkpoint_id: 'row', run_id: 'run-a' }));

    expect(await store.listByRun('run-missing')).toEqual([]);
  });
});

describe('createCheckpointStore delete', () => {
  it('removes the row so subsequent get returns null', async () => {
    await store.write(checkpoint({ checkpoint_id: 'delete-me' }));

    await store.delete('delete-me');

    expect(await store.get('delete-me')).toBeNull();
  });

  it('is idempotent for unknown and already-deleted checkpoint_ids', async () => {
    await expect(store.delete('missing')).resolves.toBeUndefined();

    await store.write(checkpoint({ checkpoint_id: 'delete-once' }));
    await store.delete('delete-once');

    await expect(store.delete('delete-once')).resolves.toBeUndefined();
  });
});

describe('createCheckpointStore list/size', () => {
  it('list returns all rows across all run_ids, ordered oldest created_at first', async () => {
    const rows = [
      checkpoint({ checkpoint_id: 'new', run_id: 'run-a', created_at: 300 }),
      checkpoint({ checkpoint_id: 'old', run_id: 'run-b', created_at: 100 }),
      checkpoint({ checkpoint_id: 'mid', run_id: 'run-a', created_at: 200 }),
    ];
    for (const row of rows) await store.write(row);

    expect((await store.list()).map((c) => c.checkpoint_id))
      .toEqual(['old', 'mid', 'new']);
  });

  it('size returns 0 on empty store, counts writes, and decrements after delete', async () => {
    expect(await store.size()).toBe(0);

    await store.write(checkpoint({ checkpoint_id: 'a' }));
    await store.write(checkpoint({ checkpoint_id: 'b' }));
    expect(await store.size()).toBe(2);

    await store.delete('a');
    expect(await store.size()).toBe(1);
  });

  it('supports a complete multi-checkpoint-per-run scenario', async () => {
    const rows = [
      checkpoint({ checkpoint_id: 'run-a-old', run_id: 'run-a', created_at: 100 }),
      checkpoint({ checkpoint_id: 'run-b-only', run_id: 'run-b', created_at: 200 }),
      checkpoint({ checkpoint_id: 'run-a-new', run_id: 'run-a', created_at: 300 }),
    ];
    for (const row of rows) await store.write(row);

    expect((await store.listByRun('run-a')).map((c) => c.checkpoint_id))
      .toEqual(['run-a-new', 'run-a-old']);
    expect((await store.listByRun('run-b')).map((c) => c.checkpoint_id))
      .toEqual(['run-b-only']);
    expect((await store.list()).map((c) => c.checkpoint_id))
      .toEqual(['run-a-old', 'run-b-only', 'run-a-new']);
  });
});

describe('AuditEntry coherence', () => {
  it('accepts awaiting_approval on storage and contracts audit shapes at compile time', () => {
    const storageInput: AuditEntryInput = {
      recipe_id: 'recipe-1',
      recipe_hash: 'hash-1',
      commit_status: 'awaiting_approval',
      duration_ms: 0,
      errors: [],
    };
    expect(storageInput.commit_status).toBe('awaiting_approval');

    const exportEntry: AuditExportEntry = {
      id: 'run-1',
      recipe_id: 'recipe-1',
      recipe_hash: 'hash-1',
      started_at: 1_700_000_000_000,
      finished_at: 1_700_000_000_000,
      duration_ms: 0,
      commit_status: 'awaiting_approval',
      trigger_source: null,
      trigger_url: null,
      instance_id: null,
      config_snapshot: {},
      errors: [],
      links: [],
    };
    expect(exportEntry.commit_status).toBe('awaiting_approval');

    // @ts-expect-error - wrong values remain outside the RunAnchorStatus literal union.
    const badStorageInput: AuditEntryInput['commit_status'] = 'approval_pending';
    expect(badStorageInput).toBe('approval_pending');

    // @ts-expect-error - the contracts export shape also rejects unknown statuses.
    const badExportStatus: AuditExportEntry['commit_status'] = 'approval_pending';
    expect(badExportStatus).toBe('approval_pending');
  });
});
