/** D-270 — the approval card's resolved "what will happen" rows.
 *
 *  ⛔ THE POINT OF THE SIBLING IS THE CASE THE LANDING RESOLVER REFUSES. Its
 *  `findReceptionHoldItem` returns null for a NON-RECEPTION hold — the fence
 *  that keeps an agent's held MCP write off a URL-bearer page — and inheriting
 *  it on a paired client would have rendered details for reception holds and
 *  nothing for the approval an owner most needs values for. The first test is
 *  that case, and it must stay the first test. */

import { describe, expect, it, vi } from 'vitest';

import { createAskCardDetailResolver } from '../ask-card-held-op-details.js';

const PREFLIGHT = 'gateway.preflight';

const ask = (payload: Record<string, unknown>, handler_kind = PREFLIGHT): never =>
  ({ ask_id: 'a1', handler_kind, handler_payload: payload } as never);

const anchor = (over: Record<string, unknown> = {}): never =>
  ({ commit_status: 'awaiting_approval', recipe_id: 'pub/r', ...over } as never);

/** A recipe-step hold: args live under the gated step's recorded input. */
const recipeCheckpoint = (args: Record<string, unknown>, over: Record<string, unknown> = {}): never =>
  ({
    checkpoint_id: 'cp1', run_id: 'run1', gated_step_id: 's1',
    step_state: { s1: { input: args } }, ...over,
  } as never);

const schema = (...keys: string[]): never =>
  ({ fields: keys.map((k) => ({ key: k, label: k, type: 'string' })) } as never);

const mk = (over: Record<string, unknown> = {}) => createAskCardDetailResolver({
  getCheckpoint: vi.fn(async () => recipeCheckpoint({ to: 'a@b.c', subject: 'Hi' })),
  getAnchor: vi.fn(async () => anchor()),
  resolveArgEditSchema: vi.fn(() => schema('to', 'subject')),
  timeZone: 'UTC',
  ...over,
} as never);

describe('D-270 card detail resolver', () => {
  it('⛔ renders no block for a held foreach with items still to come — the approval covers them all', async () => {
    // Found live: the Details named one recipient of a mail-out that went to
    // everyone. The prose lists every covered call; one item here would read as
    // the whole approval.
    const progress = { step_id: 's1', next_index: 0, source_length: 3, source_hash: 'h', results: [] };
    expect(await mk({
      getCheckpoint: async () => recipeCheckpoint({ to: 'a@b.c', subject: 'Hi' }, { foreach_progress: progress }),
    })(ask({ checkpoint_id: 'cp1' }))).toBeNull();

    // NON-VACUITY: paused on its LAST item it is one call, and renders.
    expect(await mk({
      getCheckpoint: async () => recipeCheckpoint({ to: 'a@b.c', subject: 'Hi' }, {
        foreach_progress: { ...progress, next_index: 2, results: [{}, {}] },
      }),
    })(ask({ checkpoint_id: 'cp1' }))).toHaveLength(2);

    // A chunked gate is bounded to its one item, so it renders too.
    expect(await mk({
      getCheckpoint: async () => recipeCheckpoint({ to: 'a@b.c', subject: 'Hi' }, {
        foreach_progress: progress,
        preflight_context: { egress_bound: { requests: 4, total_bytes: 1_000 } },
      }),
    })(ask({ checkpoint_id: 'cp1' }))).toHaveLength(2);
  });

  it('⛔ resolves a NON-RECEPTION hold — the case the landing resolver fences off', async () => {
    // Nothing in this resolver consults an origin: the allowlist is the fence,
    // not the channel. An agent's held MCP write resolves exactly like any other.
    const rows = await mk()(ask({ checkpoint_id: 'cp1' }));
    expect(rows).toEqual([
      { label: 'to', value: 'a@b.c' },
      { label: 'subject', value: 'Hi' },
    ]);
  });

  it('⛔ projects ONLY the allowlist, never the raw held args', async () => {
    // The safety argument for lifting the transport fence. A checkpoint retains
    // its call's args un-redacted by design, so a resolver that enumerated
    // `args` would surface whatever a recipe passed. Only pack-declared
    // `editable_args` keys are ever rendered.
    const rows = await mk({
      getCheckpoint: async () => recipeCheckpoint({
        to: 'a@b.c', api_key: 'sk-live-SECRET', subject: 'Hi',
      }),
      resolveArgEditSchema: () => schema('to', 'subject'),
    })(ask({ checkpoint_id: 'cp1' }));
    expect(rows?.map((r) => r.label)).toEqual(['to', 'subject']);
    expect(JSON.stringify(rows)).not.toContain('SECRET');
  });

  it('reads a RAW-OP checkpoint too — the shape the reception resolver says never reaches it', async () => {
    const rows = await mk({
      getCheckpoint: async () => ({
        checkpoint_id: 'cp1', run_id: 'run1',
        raw_op: { op_args: { to: 'raw@b.c', subject: 'Raw' } },
      } as never),
    })(ask({ checkpoint_id: 'cp1' }));
    expect(rows).toEqual([
      { label: 'to', value: 'raw@b.c' },
      { label: 'subject', value: 'Raw' },
    ]);
  });

  it('shows what will ACTUALLY run — `arg_overrides` win over the proposal', async () => {
    const rows = await mk({
      getCheckpoint: async () => recipeCheckpoint(
        { to: 'old@b.c', subject: 'Hi' },
        { arg_overrides: { to: 'new@b.c' } },
      ),
    })(ask({ checkpoint_id: 'cp1' }));
    expect(rows?.[0]).toEqual({ label: 'to', value: 'new@b.c' });
  });

  describe('every null is a distinct fact, and none of them earns copy', () => {
    it('a non-preflight ask holds no operation — and reads NOTHING first', async () => {
      const getCheckpoint = vi.fn(async () => recipeCheckpoint({}));
      const rows = await mk({ getCheckpoint })(ask({ checkpoint_id: 'cp1' }, 'other.kind'));
      expect(rows).toBeNull();
      // The cost bound depends on this: the common case must not touch a store.
      expect(getCheckpoint).not.toHaveBeenCalled();
    });

    it('a MULTI-MEMBER batch would show one member as the whole approval', async () => {
      const rows = await mk({
        getBatch: async () => ({ members: [1, 2] }),
      })(ask({ checkpoint_id: 'cp1', batch_id: 'b1' }));
      expect(rows).toBeNull();
    });

    it('a single-member batch DOES resolve — "one member as the whole" is vacuous at N=1', async () => {
      const rows = await mk({
        getBatch: async () => ({ members: [1] }),
      })(ask({ checkpoint_id: 'cp1', batch_id: 'b1' }));
      expect(rows).not.toBeNull();
    });

    it('a batched ask with NO membership reader fails closed', async () => {
      const rows = await mk({ getBatch: undefined })(ask({ checkpoint_id: 'cp1', batch_id: 'b1' }));
      expect(rows).toBeNull();
    });

    it('a run no longer awaiting approval has nothing held', async () => {
      const rows = await mk({
        getAnchor: async () => anchor({ commit_status: 'committed' }),
      })(ask({ checkpoint_id: 'cp1' }));
      expect(rows).toBeNull();
    });

    it('an EMPTY allowlist renders nothing rather than an empty block', async () => {
      const rows = await mk({ resolveArgEditSchema: () => schema() })(ask({ checkpoint_id: 'cp1' }));
      expect(rows).toBeNull();
    });

    it('no checkpoint_id, and an unknown checkpoint', async () => {
      expect(await mk()(ask({}))).toBeNull();
      expect(await mk({ getCheckpoint: async () => null })(ask({ checkpoint_id: 'cp1' }))).toBeNull();
    });

    it('⛔ a THROWING store loses the rows, never the ask', async () => {
      // The owner losing the approval list because a detail could not resolve is
      // strictly worse than losing the detail.
      const rows = await mk({
        getCheckpoint: async () => { throw new Error('db gone'); },
      })(ask({ checkpoint_id: 'cp1' }));
      expect(rows).toBeNull();
    });

    it('and a throwing schema resolver', async () => {
      const rows = await mk({
        resolveArgEditSchema: () => { throw new Error('catalog gone'); },
      })(ask({ checkpoint_id: 'cp1' }));
      expect(rows).toBeNull();
    });
  });
});
