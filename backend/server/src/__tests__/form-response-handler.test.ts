import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FORM_RESPONSE_LIFECYCLE_STATES, type FormResponse } from '@recued/contracts';

import type { WsClient } from '../ws-server.js';
import {
  handleFormResponseGet,
  handleFormResponseExport,
  handleFormResponseSetState,
  handleFormResponseList,
  handleFormResponseUpdate,
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
    fields: [{ name: 'topic', label: 'What do you need?', type: 'textarea', required: true }],
  },
  values: { topic: `Request ${offset}` },
  visitor: { email: `visitor-${offset}@example.test` },
  submitted_at: BASE_TIME + offset,
  accepted_at: BASE_TIME + 100 + offset,
  metadata: { template_ref: 'foundation:intake/free-form' },
});

const formResponseForExport = (submission_id: string, accepted_at: number): FormResponse => ({
  _id: submission_id,
  _collection: 'form_response',
  submission_id,
  endpoint_id: 'ep-bulk',
  form_definition_id: 'form-a',
  definition_snapshot: { fields: [] },
  values: {},
  visitor: {},
  submitted_at: accepted_at - 1,
  accepted_at,
  updated_at: accepted_at,
  origin_actor: 'anonymous',
  origin_surface: 'system',
  lifecycle_state: 'received',
  state_changed_at: 0,
  metadata: {},
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
      updated_at: BASE_TIME + 104,
      lifecycle_state: 'received',
      state_changed_at: 0,
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

  it('drops cleanly when unwired and claims the complete owner RPC surface when wired', () => {
    expect(makeFormResponseHandlers(undefined)).toBeUndefined();
    expect(makeFormResponseHandlers(deps)?.methods).toEqual([
      'form_response.list',
      'form_response.get',
      'form_response.set_state',
      'form_response.update',
      'form_response.export',
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

  it('updates only validated working content and uses the server clock', async () => {
    deps = { ...deps, now: () => BASE_TIME + 999 };
    const before = (await handleFormResponseGet(deps, { submission_id: 'sub-1' })).response!;
    const result = await handleFormResponseUpdate(deps, {
      submission_id: 'sub-1',
      values: { topic: 'Owner-corrected answer' },
      visitor: { email: 'corrected@example.test' },
    });

    expect(result.response).toMatchObject({
      values: { topic: 'Owner-corrected answer' },
      visitor: { email: 'corrected@example.test' },
      updated_at: BASE_TIME + 999,
      submitted_at: before.submitted_at,
      accepted_at: before.accepted_at,
      definition_snapshot: before.definition_snapshot,
      lifecycle_state: before.lifecycle_state,
      state_changed_at: before.state_changed_at,
      origin_actor: 'anonymous',
      origin_surface: 'system',
    });
  });

  it('rejects missing, unknown, wrong-type, and malformed-email working edits', async () => {
    const attempts = [
      { values: {}, visitor: {} },
      { values: { topic: 'ok', forged: 'x' }, visitor: {} },
      { values: { topic: 42 }, visitor: {} },
      { values: { topic: 'ok' }, visitor: { email: 'not-an-email' } },
      { values: { topic: 'ok' }, visitor: { email: 'ok@example.test', role: 'admin' } },
    ];
    for (const attempt of attempts) {
      await expect(handleFormResponseUpdate(deps, {
        submission_id: 'sub-1',
        ...attempt,
      } as never)).rejects.toMatchObject({ code: 'bad_request' });
    }
    expect((await handleFormResponseGet(deps, { submission_id: 'sub-1' })).response?.values)
      .toEqual({ topic: 'Request 1' });
  });

  it('filters exports, neutralizes CSV formula cells, and returns JSON records', async () => {
    deps.store.accept({
      ...input('sub-csv', 20, 'ep-csv'),
      visitor: { email: '+cmd@example.test' },
    });
    deps.store.setLifecycleState('sub-csv', 'accepted', BASE_TIME + 500);
    deps = { ...deps, now: () => Date.UTC(2026, 6, 21) };

    const csv = await handleFormResponseExport(deps, {
      format: 'csv',
      endpoint_id: 'ep-csv',
      lifecycle_states: ['accepted'],
    });
    expect(csv).toMatchObject({
      filename: 'form-responses-2026-07-21.csv',
      mime_type: 'text/csv',
      record_count: 1,
    });
    expect(csv.content).toContain("\"'+cmd@example.test\"");
    expect(csv.content).not.toContain('\"+cmd@example.test\"');

    const json = await handleFormResponseExport(deps, {
      format: 'json',
      endpoint_id: 'ep-csv',
    });
    expect(json.mime_type).toBe('application/json');
    expect(JSON.parse(json.content)).toMatchObject([
      { submission_id: 'sub-csv', lifecycle_state: 'accepted' },
    ]);
  });

  it('hands back a resume cursor above the 10,000-record ceiling instead of refusing', async () => {
    // ⛔ THIS REPLACES A REFUSAL, deliberately. The ceiling used to throw
    // `result exceeds 10000 records; narrow the filters` — naming filters the
    // responses tab does not expose, so an owner with 10,001 responses could
    // never export anything at all. The ceiling bounds ONE rpc payload; it must
    // not bound the owner's ability to get their own data out.
    let call = 0;
    const list = vi.fn(() => {
      call += 1;
      const count = call <= 20 ? 500 : 1;
      return Array.from({ length: count }, (_, index) => formResponseForExport(
        `bulk-${call}-${index}`,
        BASE_TIME + 20_000 - call * 500 - index,
      ));
    });
    const bulkDeps = { store: { list } } as unknown as FormResponseRpcDeps;
    const first = await handleFormResponseExport(bulkDeps, { format: 'json' });
    // PRESERVED from the refusal test: the ceiling is reached by a paged walk
    // (20 pages of 500), and a 21st single-row probe decides whether more
    // remains — not a load-everything-then-slice.
    expect(list).toHaveBeenCalledTimes(21);
    expect(first.record_count).toBe(10_000);
    expect(first.next_cursor).toEqual({
      accepted_at: expect.any(Number),
      submission_id: expect.any(String),
    });
    // The chunk itself is COMPLETE and well-formed — never a truncated file
    // presented as the whole export.
    expect(JSON.parse(first.content)).toHaveLength(10_000);
  });

  it('omits the resume cursor — and the repeated CSV header — on a final chunk', async () => {
    const exact = vi.fn(() => []);
    const emptyDeps = { store: { list: exact } } as unknown as FormResponseRpcDeps;
    const last = await handleFormResponseExport(emptyDeps, { format: 'json' });
    expect(Object.hasOwn(last, 'next_cursor')).toBe(false);

    // A continuation chunk (`before` supplied) must NOT re-emit the header, so
    // a caller concatenating chunks gets one well-formed CSV.
    const headed = await handleFormResponseExport(deps, {
      format: 'csv',
      endpoint_id: 'ep-csv',
    });
    expect(headed.content).toContain('submission_id');
    const continued = await handleFormResponseExport(deps, {
      format: 'csv',
      endpoint_id: 'ep-csv',
      before: { accepted_at: BASE_TIME + 90_000, submission_id: 'zzz' },
    });
    expect(continued.content).not.toContain('submission_id,');
  });

  it('requires registration before update and export', async () => {
    const slice = makeFormResponseHandlers(deps)!;
    await expect(slice.handlers['form_response.update']({
      submission_id: 'sub-1', values: { topic: 'x' }, visitor: {},
    }, client(null))).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(slice.handlers['form_response.export'](
      { format: 'json' }, client(null),
    )).rejects.toMatchObject({ code: 'unauthorized' });
  });
});
