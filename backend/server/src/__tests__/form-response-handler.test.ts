import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FORM_RESPONSE_LIFECYCLE_STATES } from '@recued/contracts';

import type { WsClient } from '../ws-server.js';
import {
  handleFormResponseGet,
  handleFormResponseSetState,
  handleFormResponseList,
  makeFormResponseHandlers,
  type FormResponseRpcDeps,
} from '../form-response-handler.js';
import { createFormResponseStore } from '../storage/form-response-store.js';

const BASE_TIME = 1_700_000_000_000;

const input = (submission_id: string, offset: number, endpoint_id = 'ep-1') => ({
  submission_id,
  endpoint_id,
  form_definition_id: offset % 2 === 0 ? 'form-a' : 'form-b',
  definition_snapshot: {
    form_definition_id: offset % 2 === 0 ? 'form-a' : 'form-b',
    fields: [{ name: 'topic', label: 'What do you need?', type: 'textarea' }],
  },
  values: { topic: `Request ${offset}` },
  visitor: { email: `visitor-${offset}@example.test` },
  submitted_at: BASE_TIME + offset,
  accepted_at: BASE_TIME + 100 + offset,
  metadata: { template_ref: 'foundation:intake/free-form' },
});

const client = (instance_id: string | null): WsClient =>
  ({
    ws: null,
    realm: 'recued',
    instance_id,
    display_name: 'browser',
    connected_at: 0,
    user_id: 'owner',
  }) as unknown as WsClient;

describe('form_response owner read RPC', () => {
  let db: Database.Database;
  let deps: FormResponseRpcDeps;

  beforeEach(() => {
    db = new Database(':memory:');
    const store = createFormResponseStore(db);
    for (let i = 0; i < 5; i += 1) {
      store.accept(input(`sub-${i}`, i, i === 4 ? 'ep-2' : 'ep-1'));
    }
    deps = { store };
  });

  afterEach(() => db.close());

  it('lists newest-first with an honest composite next cursor', async () => {
    const first = await handleFormResponseList(deps, { limit: 2 });
    expect(first.responses.map((row) => row.submission_id)).toEqual(['sub-4', 'sub-3']);
    expect(first.responses[0]).toEqual({
      submission_id: 'sub-4',
      endpoint_id: 'ep-2',
      form_definition_id: 'form-a',
      visitor: { email: 'visitor-4@example.test' },
      submitted_at: BASE_TIME + 4,
      accepted_at: BASE_TIME + 104,
      template_ref: 'foundation:intake/free-form',
    });
    expect(first.responses[0]).not.toHaveProperty('values');
    expect(first.responses[0]).not.toHaveProperty('definition_snapshot');
    expect(first.next_cursor).toEqual({
      accepted_at: BASE_TIME + 103,
      submission_id: 'sub-3',
    });

    const second = await handleFormResponseList(deps, {
      limit: 2,
      before: first.next_cursor,
    });
    expect(second.responses.map((row) => row.submission_id)).toEqual(['sub-2', 'sub-1']);
    expect(second.next_cursor).toEqual({
      accepted_at: BASE_TIME + 101,
      submission_id: 'sub-1',
    });

    const last = await handleFormResponseList(deps, {
      limit: 2,
      before: second.next_cursor,
    });
    expect(last.responses.map((row) => row.submission_id)).toEqual(['sub-0']);
    expect(last.next_cursor).toBeUndefined();
  });

  it('threads endpoint/form filters and gets a response by immutable id', async () => {
    const filtered = await handleFormResponseList(deps, {
      endpoint_id: 'ep-1',
      form_definition_id: 'form-a',
    });
    expect(filtered.responses.map((row) => row.submission_id)).toEqual(['sub-2', 'sub-0']);

    await expect(handleFormResponseGet(deps, { submission_id: 'sub-2' })).resolves.toMatchObject({
      response: {
        _collection: 'form_response',
        submission_id: 'sub-2',
        values: { topic: 'Request 2' },
      },
    });
    await expect(handleFormResponseGet(deps, { submission_id: 'missing' })).resolves.toEqual({
      response: null,
    });
  });

  it('projects only the declared visitor email into list summaries', async () => {
    deps.store.accept({
      ...input('sub-extra-visitor', 10),
      visitor: {
        email: 'listed@example.test',
        internal_note: 'must not cross the summary boundary',
      } as never,
    });

    const result = await handleFormResponseList(deps, { limit: 1 });
    expect(result.responses[0]?.visitor).toEqual({ email: 'listed@example.test' });
    expect(result.responses[0]?.visitor).not.toHaveProperty('internal_note');
  });

  it('maps malformed list/get inputs to bad_request', async () => {
    await expect(
      handleFormResponseList(deps, 'not-an-object' as never),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await expect(handleFormResponseList(deps, { limit: 500 })).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(
      handleFormResponseList(deps, {
        before: { accepted_at: -1, submission_id: 'sub-1' },
      }),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await expect(handleFormResponseGet(deps, { submission_id: '' })).rejects.toMatchObject({
      code: 'bad_request',
    });
  });

  it('requires registration before either owner read', async () => {
    const slice = makeFormResponseHandlers(deps)!;
    await expect(
      slice.handlers['form_response.list']({}, client(null)),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(
      slice.handlers['form_response.get']({ submission_id: 'sub-1' }, client(null)),
    ).rejects.toMatchObject({ code: 'unauthorized' });

    const listed = await slice.handlers['form_response.list']({ limit: 1 }, client('device-1'));
    expect((listed as { responses: unknown[] }).responses).toHaveLength(1);
  });

  it('drops cleanly when unwired and claims list/get/set_state when wired', () => {
    expect(makeFormResponseHandlers(undefined)).toBeUndefined();
    expect(makeFormResponseHandlers(deps)?.methods).toEqual([
      'form_response.list',
      'form_response.get',
      'form_response.set_state',
    ]);
  });

  // ══════════════════════════════════════════════════════════════
  // D-210 A.8 slice 2 — the lifecycle WRITE.
  // ══════════════════════════════════════════════════════════════

  it('advances the lifecycle and returns the updated record', async () => {
    const before = await handleFormResponseGet(deps, { submission_id: 'sub-1' });
    expect(before.response!.lifecycle_state).toBe('received');

    const result = await handleFormResponseSetState(deps, {
      submission_id: 'sub-1',
      lifecycle_state: 'no_show',
    });
    expect(result.response!.lifecycle_state).toBe('no_show');
    // Persisted, not merely echoed back.
    const after = await handleFormResponseGet(deps, { submission_id: 'sub-1' });
    expect(after.response!.lifecycle_state).toBe('no_show');
  });

  it('stamps state_changed_at from the SERVER, ignoring anything a caller sends', async () => {
    const result = await handleFormResponseSetState(deps, {
      submission_id: 'sub-1',
      lifecycle_state: 'accepted',
      // A caller trying to backdate the transition. The request type has no
      // such field, and the handler passes its OWN clock — so a hostile client
      // cannot make a no-show look older than it was.
      state_changed_at: 1,
    } as never);
    expect(result.response!.state_changed_at).toBeGreaterThan(1);
  });

  it('rejects a bad state AT THE RPC — the store is never reached', async () => {
    // ⚠ This spy exists because the obvious version of this test passes even
    // with the rpc's validation deleted: the STORE validates too, and builds
    // its message from the same const, so both layers produce byte-identical
    // errors. Asserting the outcome cannot distinguish them. Asserting the
    // store was never CALLED can. (Found by mutating the guard away and
    // watching every test stay green.)
    const setLifecycleState = vi.fn(() => null);
    const spyDeps = {
      store: { ...deps.store, setLifecycleState },
    } as unknown as FormResponseRpcDeps;

    await expect(
      handleFormResponseSetState(spyDeps, {
        submission_id: 'sub-1',
        lifecycle_state: 'attended' as never,
      }),
    ).rejects.toMatchObject({ code: 'bad_request' });
    expect(setLifecycleState).not.toHaveBeenCalled();

    // And a VALID state does reach it, so the guard is not just refusing
    // everything (a reduction faked by doing less).
    await handleFormResponseSetState(spyDeps, {
      submission_id: 'sub-1',
      lifecycle_state: 'accepted',
    });
    expect(setLifecycleState).toHaveBeenCalledOnce();
  });

  it('rejects a state outside the vocabulary and NAMES the accepted set', async () => {
    await expect(
      handleFormResponseSetState(deps, {
        submission_id: 'sub-1',
        lifecycle_state: 'attended' as never,
      }),
    ).rejects.toMatchObject({ code: 'bad_request' });
    // Built from the const, so the message cannot drift from the vocabulary.
    await expect(
      handleFormResponseSetState(deps, {
        submission_id: 'sub-1',
        lifecycle_state: 'attended' as never,
      }),
    ).rejects.toThrow(FORM_RESPONSE_LIFECYCLE_STATES.join(', '));
    // And the row is untouched.
    const row = await handleFormResponseGet(deps, { submission_id: 'sub-1' });
    expect(row.response!.lifecycle_state).toBe('received');
  });

  it('requires a submission id', async () => {
    await expect(
      handleFormResponseSetState(deps, { submission_id: '', lifecycle_state: 'accepted' }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('requires registration before the WRITE, not just the reads', async () => {
    const slice = makeFormResponseHandlers(deps)!;
    await expect(
      slice.handlers['form_response.set_state'](
        { submission_id: 'sub-1', lifecycle_state: 'accepted' },
        client(null),
      ),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    // An unregistered client must not have moved anything.
    const row = await handleFormResponseGet(deps, { submission_id: 'sub-1' });
    expect(row.response!.lifecycle_state).toBe('received');
  });
});
