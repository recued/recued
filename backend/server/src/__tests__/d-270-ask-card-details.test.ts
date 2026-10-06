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
import { HIDDEN_SECRET_VALUE, isSecretShapedKey } from '../ask-card-default-details.js';

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

describe('an action whose pack declares nothing reviewable (2026-10-04)', () => {
  // 11,687 of 12,470 holdable actions declare no `editable_args`; their cards
  // named the action and never what it would change. They now show their own
  // DECLARED request fields — never the raw held args — with secrets hidden.
  const REQUEST = { type: 'object', additionalProperties: false, properties: {
    'body.entity_id': { type: 'string' },
    'body.password': { type: 'string' },
    body_raw: { type: 'string' },
    'Idempotency-Key': { type: 'string' },
    'body.secret_name': { type: 'string' },
    'query.limit': { type: 'integer' },
  } };
  const held = recipeCheckpoint({
    'body.entity_id': 'lock.kitchen_door',
    'body.password': 'hunter2',
    'body.secret_name': 'prod-db',
    body_raw: '{"user":"sam","token":"tok-123","nested":{"client_secret":"cs-9"}}',
    'Idempotency-Key': 'retry-1',
    api_key: 'sk-live-SECRET',
  });

  it('shows the declared fields the call carries, hides secrets, and never a raw extra arg', async () => {
    const rows = await mk({
      getCheckpoint: async () => held,
      resolveArgEditSchema: () => schema(),
      lookupRequestSchema: () => REQUEST,
    })(ask({ checkpoint_id: 'cp1' }));
    // Idempotency is plumbing; `query.limit` was not sent, so it commits to nothing.
    expect(rows?.map((r) => r.label)).toEqual(['entity_id', 'password', 'Data sent', 'secret_name']);
    const value = (label: string) => rows?.find((r) => r.label === label)?.value;
    expect(value('entity_id')).toBe('lock.kitchen_door');
    // A secret is a ROW with its value hidden — the block stays complete.
    expect(value('password')).toBe(HIDDEN_SECRET_VALUE);
    // Hidden inside a JSON body too; the rest of the body still reads.
    expect(value('Data sent')).toContain('"user":"sam"');
    // The NAME of a secret is not one.
    expect(value('secret_name')).toBe('prod-db');
    expect(JSON.stringify(rows)).not.toMatch(/hunter2|tok-123|cs-9|sk-live-SECRET|retry-1/u);
  });

  it('a declared allowlist always wins over the default', async () => {
    const rows = await mk({
      getCheckpoint: async () => held,
      resolveArgEditSchema: () => schema('body.entity_id'),
      lookupRequestSchema: () => REQUEST,
    })(ask({ checkpoint_id: 'cp1' }));
    expect(rows?.map((r) => r.label)).toEqual(['body.entity_id']);
  });

  it('shows no block when the action declares nothing the call carries, or too much to summarise', async () => {
    const none = await mk({ getCheckpoint: async () => held, resolveArgEditSchema: () => schema(),
      lookupRequestSchema: () => ({ properties: { 'body.other': { type: 'string' } } }) })(ask({ checkpoint_id: 'cp1' }));
    expect(none).toBeNull();
    const wide = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`f${i}`, 'v']));
    const tooMany = await mk({ getCheckpoint: async () => recipeCheckpoint(wide), resolveArgEditSchema: () => schema(),
      lookupRequestSchema: () => ({ properties: Object.fromEntries(Object.keys(wide).map((k) => [k, { type: 'string' }])) }) })(ask({ checkpoint_id: 'cp1' }));
    expect(tooMany).toBeNull();
    // And with no schema reader at all, exactly as before the default.
    expect(await mk({ getCheckpoint: async () => held, resolveArgEditSchema: () => schema() })(ask({ checkpoint_id: 'cp1' }))).toBeNull();
  });

  it('tells a secret from the name of one', () => {
    for (const key of ['body.password', 'body.client_secret', 'body.access_token', 'body.refresh_token',
      'authorization', 'body.user_token', 'api_key', 'body.tokens']) expect([key, isSecretShapedKey(key)]).toEqual([key, true]);
    for (const key of ['body.secret_name', 'secretId', 'token_id', 'tokenId', 'apiCredentialId',
      'body.token_type', 'body.author_id', 'session_id', 'body.entity_id', 'className']) expect([key, isSecretShapedKey(key)]).toEqual([key, false]);
  });
});
