import Database from 'better-sqlite3';
import { FORM_RESPONSE_DEFAULT_LIFECYCLE_STATE } from '@recued/contracts';
import { describe, expect, it } from 'vitest';
import {
  createFormResponseStore,
  ensureFormResponseSchema,
  FormResponseConflictError,
  FormResponseValidationError,
} from '../storage/form-response-store.js';

const SUBMITTED_AT = 1_700_000_000_000;
const ACCEPTED_AT = SUBMITTED_AT + 60_000;

const acceptedInput = () => ({
  submission_id: 'sub-1',
  endpoint_id: 'ep-1',
  form_definition_id: 'form-1',
  definition_snapshot: {
    fields: [{ name: 'topic', label: 'What do you need?', type: 'textarea' }],
  },
  values: { topic: 'Review my launch plan', budget: 2500 },
  visitor: { email: 'visitor@example.com' },
  submitted_at: SUBMITTED_AT,
  accepted_at: ACCEPTED_AT,
  metadata: { template_ref: 'foundation:intake/free-form' },
});

describe('FormResponseStore', () => {
  it('stores an accepted free-form response as canonical owner data', () => {
    const db = new Database(':memory:');
    const store = createFormResponseStore(db);

    const accepted = store.accept(acceptedInput());

    expect(accepted.status).toBe('created');
    expect(accepted.response).toMatchObject({
      _id: 'sub-1',
      _collection: 'form_response',
      submission_id: 'sub-1',
      endpoint_id: 'ep-1',
      form_definition_id: 'form-1',
      values: { topic: 'Review my launch plan', budget: 2500 },
      visitor: { email: 'visitor@example.com' },
      origin_actor: 'anonymous',
      origin_surface: 'system',
    });
    expect(store.findById('sub-1')).toEqual(accepted.response);
  });

  it('persists ordinary JSON columns inside the encrypted database boundary', () => {
    const db = new Database(':memory:');
    const store = createFormResponseStore(db);
    store.accept(acceptedInput());

    const columns = db.prepare('PRAGMA table_info(form_response)').all() as Array<{
      name: string;
      type: string;
    }>;
    expect(columns.some((column) => column.name.endsWith('_encrypted'))).toBe(false);
    expect(columns.find((column) => column.name === 'values_blob')?.type).toBe('TEXT');

    const raw = db.prepare(
      'SELECT values_blob, visitor_blob FROM form_response WHERE submission_id = ?',
    ).get('sub-1') as { values_blob: string; visitor_blob: string };
    expect(JSON.parse(raw.values_blob)).toEqual({
      budget: 2500,
      topic: 'Review my launch plan',
    });
    expect(JSON.parse(raw.visitor_blob)).toEqual({ email: 'visitor@example.com' });
    expect(() =>
      db.prepare(
        "UPDATE form_response SET origin_actor = 'user_self' WHERE submission_id = 'sub-1'",
      ).run(),
    ).toThrow();
  });

  it('is idempotent across retry time and object key order', () => {
    const db = new Database(':memory:');
    const store = createFormResponseStore(db);
    expect(store.accept(acceptedInput()).status).toBe('created');

    const retry = acceptedInput();
    const result = store.accept({
      ...retry,
      values: { budget: 2500, topic: 'Review my launch plan' },
      metadata: { template_ref: 'foundation:intake/free-form' },
      accepted_at: ACCEPTED_AT + 5_000,
    });

    expect(result.status).toBe('existing');
    expect(result.response.accepted_at).toBe(ACCEPTED_AT);
    expect(store.list()).toHaveLength(1);
  });

  it('fails closed when a submission id is reused for different content', () => {
    const db = new Database(':memory:');
    const store = createFormResponseStore(db);
    store.accept(acceptedInput());

    expect(() =>
      store.accept({
        ...acceptedInput(),
        values: { topic: 'Changed after acceptance' },
      }),
    ).toThrow(FormResponseConflictError);
    expect(store.findById('sub-1')?.values).toEqual({
      budget: 2500,
      topic: 'Review my launch plan',
    });
  });

  it('edits only the working content and advances updated_at only on a real change', () => {
    const db = new Database(':memory:');
    const store = createFormResponseStore(db);
    const original = store.accept(acceptedInput()).response;

    const changed = store.updateContent('sub-1', {
      values: { topic: 'Owner clarified the brief', budget: 3000 },
      visitor: { email: 'corrected@example.com' },
    }, ACCEPTED_AT + 10)!;
    expect(changed).toMatchObject({
      values: { topic: 'Owner clarified the brief', budget: 3000 },
      visitor: { email: 'corrected@example.com' },
      updated_at: ACCEPTED_AT + 10,
      submitted_at: original.submitted_at,
      accepted_at: original.accepted_at,
      definition_snapshot: original.definition_snapshot,
      origin_actor: 'anonymous',
      origin_surface: 'system',
      lifecycle_state: 'received',
      state_changed_at: 0,
    });

    const noOp = store.updateContent('sub-1', {
      values: { budget: 3000, topic: 'Owner clarified the brief' },
      visitor: { email: 'corrected@example.com' },
    }, ACCEPTED_AT + 99)!;
    expect(noOp.updated_at).toBe(ACCEPTED_AT + 10);
  });

  it('keeps source idempotency bound to the immutable submitted content after owner edits', () => {
    const db = new Database(':memory:');
    const store = createFormResponseStore(db);
    expect(store.accept(acceptedInput()).status).toBe('created');
    store.updateContent('sub-1', {
      values: { topic: 'Owner working copy' },
      visitor: {},
    }, ACCEPTED_AT + 10);

    const retry = store.accept(acceptedInput());
    expect(retry.status).toBe('existing');
    expect(retry.response.values).toEqual({ topic: 'Owner working copy' });
    expect(retry.response.visitor).toEqual({});
    expect(() => store.accept({
      ...acceptedInput(),
      values: { topic: 'Different source submission', budget: 2500 },
    })).toThrow(FormResponseConflictError);
  });

  it('applies approve-time edits atomically and never overwrites them on a retry', () => {
    const db = new Database(':memory:');
    const store = createFormResponseStore(db);
    const first = store.acceptWithWorkingContent(
      acceptedInput(),
      { values: { topic: 'Approved wording' }, visitor: {} },
      ACCEPTED_AT + 5,
    );
    expect(first.status).toBe('created');
    expect(first.response.values).toEqual({ topic: 'Approved wording' });
    expect(first.response.updated_at).toBe(ACCEPTED_AT + 5);

    store.updateContent('sub-1', {
      values: { topic: 'Later owner edit' },
      visitor: { email: 'later@example.test' },
    }, ACCEPTED_AT + 20);
    const retry = store.acceptWithWorkingContent(
      acceptedInput(),
      { values: { topic: 'Stale approve retry' }, visitor: {} },
      ACCEPTED_AT + 30,
    );
    expect(retry.status).toBe('existing');
    expect(retry.response.values).toEqual({ topic: 'Later owner edit' });
    expect(retry.response.updated_at).toBe(ACCEPTED_AT + 20);
  });

  it('lists newest-first and filters by form and endpoint', () => {
    const db = new Database(':memory:');
    const store = createFormResponseStore(db);
    store.accept(acceptedInput());
    store.accept({
      ...acceptedInput(),
      submission_id: 'sub-2',
      form_definition_id: 'form-2',
      accepted_at: ACCEPTED_AT + 1,
    });
    store.accept({
      ...acceptedInput(),
      submission_id: 'sub-3',
      endpoint_id: 'ep-2',
      accepted_at: ACCEPTED_AT + 2,
    });

    expect(store.list().map((row) => row.submission_id)).toEqual([
      'sub-3',
      'sub-2',
      'sub-1',
    ]);
    expect(store.list({ endpoint_id: 'ep-1' }).map((row) => row.submission_id)).toEqual([
      'sub-2',
      'sub-1',
    ]);
    expect(store.list({ form_definition_id: 'form-1' }).map((row) => row.submission_id)).toEqual([
      'sub-3',
      'sub-1',
    ]);
  });

  it('filters list and summaries by a validated lifecycle closed list', () => {
    const store = createFormResponseStore(new Database(':memory:'));
    store.accept(acceptedInput());
    store.accept({ ...acceptedInput(), submission_id: 'sub-2', accepted_at: ACCEPTED_AT + 1 });
    store.setLifecycleState('sub-2', 'accepted', ACCEPTED_AT + 2);

    expect(store.list({ lifecycle_states: ['accepted'] }).map((row) => row.submission_id))
      .toEqual(['sub-2']);
    expect(store.listSummaries({ lifecycle_states: ['received'] }).map((row) => row.submission_id))
      .toEqual(['sub-1']);
    expect(() => store.list({ lifecycle_states: [] })).toThrow(FormResponseValidationError);
    expect(() => store.list({ lifecycle_states: ['unknown' as never] }))
      .toThrow(FormResponseValidationError);
  });

  it('projects Data-browser summaries without answer values or the frozen definition', () => {
    const db = new Database(':memory:');
    const store = createFormResponseStore(db);
    store.accept(acceptedInput());

    const summaries = store.listSummaries();
    expect(summaries).toEqual([
      {
        submission_id: 'sub-1',
        endpoint_id: 'ep-1',
        form_definition_id: 'form-1',
        visitor: { email: 'visitor@example.com' },
        submitted_at: SUBMITTED_AT,
        accepted_at: ACCEPTED_AT,
        updated_at: ACCEPTED_AT,
        lifecycle_state: 'received',
        state_changed_at: 0,
        metadata: { template_ref: 'foundation:intake/free-form' },
      },
    ]);
    // The large blobs never decode into the browse projection (spec §6.1).
    expect(summaries[0]).not.toHaveProperty('values');
    expect(summaries[0]).not.toHaveProperty('definition_snapshot');
  });

  it('applies the same filters and keyset cursor to summaries as to full rows', () => {
    const db = new Database(':memory:');
    const store = createFormResponseStore(db);
    store.accept(acceptedInput());
    store.accept({
      ...acceptedInput(),
      submission_id: 'sub-2',
      form_definition_id: 'form-2',
      accepted_at: ACCEPTED_AT + 1,
    });
    store.accept({
      ...acceptedInput(),
      submission_id: 'sub-3',
      endpoint_id: 'ep-2',
      accepted_at: ACCEPTED_AT + 2,
    });

    const ids = (rows: ReadonlyArray<{ submission_id: string }>) =>
      rows.map((row) => row.submission_id);
    expect(ids(store.listSummaries())).toEqual(ids(store.list()));
    expect(ids(store.listSummaries({ endpoint_id: 'ep-1' }))).toEqual(['sub-2', 'sub-1']);
    const firstPage = store.listSummaries({ limit: 2 });
    expect(ids(firstPage)).toEqual(['sub-3', 'sub-2']);
    expect(ids(store.listSummaries({
      before: {
        accepted_at: firstPage[1]!.accepted_at,
        submission_id: firstPage[1]!.submission_id,
      },
      limit: 2,
    }))).toEqual(['sub-1']);
  });

  it('uses a composite cursor so equal acceptance timestamps are not skipped', () => {
    const db = new Database(':memory:');
    const store = createFormResponseStore(db);
    for (const submission_id of ['sub-a', 'sub-b', 'sub-c']) {
      store.accept({ ...acceptedInput(), submission_id });
    }

    const first = store.list({ limit: 2 });
    expect(first.map((row) => row.submission_id)).toEqual(['sub-c', 'sub-b']);
    const second = store.list({
      before: {
        accepted_at: first[1]!.accepted_at,
        submission_id: first[1]!.submission_id,
      },
      limit: 2,
    });
    expect(second.map((row) => row.submission_id)).toEqual(['sub-a']);
  });

  it('rejects invalid acceptance timestamps and invalid limits', () => {
    const db = new Database(':memory:');
    const store = createFormResponseStore(db);

    expect(() =>
      store.accept({ ...acceptedInput(), accepted_at: SUBMITTED_AT - 1 }),
    ).toThrow(FormResponseValidationError);
    expect(() => store.list({ limit: 0 })).toThrow(FormResponseValidationError);
    expect(() =>
      store.accept({
        ...acceptedInput(),
        visitor: { email: '' },
      }),
    ).toThrow(FormResponseValidationError);
    expect(store.list()).toEqual([]);
  });

  it('installs its schema idempotently', () => {
    const db = new Database(':memory:');
    ensureFormResponseSchema(db);
    expect(() => ensureFormResponseSchema(db)).not.toThrow();
    expect(
      db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'form_response'",
      ).get(),
    ).toEqual({ name: 'form_response' });
    const plan = db.prepare(
      'EXPLAIN QUERY PLAN SELECT * FROM form_response '
      + 'ORDER BY accepted_at DESC, submission_id DESC LIMIT 100',
    ).all() as Array<{ detail: string }>;
    expect(plan.some((row) => row.detail.includes('idx_form_response_accepted'))).toBe(true);
  });

  // ══════════════════════════════════════════════════════════════
  // D-210 A.8 slice 2 — the owner-authored lifecycle.
  // ══════════════════════════════════════════════════════════════

  it('is born in the NAMED default state, not the first enum member', () => {
    const store = createFormResponseStore(new Database(':memory:'));
    const row = store.accept(acceptedInput()).response;
    expect(row.lifecycle_state).toBe(FORM_RESPONSE_DEFAULT_LIFECYCLE_STATE);
    expect(row.lifecycle_state).toBe('received');
    expect(row.state_changed_at).toBe(0); // never transitioned
  });

  it('advances the lifecycle and stamps state_changed_at', () => {
    const store = createFormResponseStore(new Database(':memory:'));
    store.accept(acceptedInput());
    const updated = store.setLifecycleState('sub-1', 'no_show', 5_000)!;
    expect(updated.lifecycle_state).toBe('no_show');
    expect(updated.state_changed_at).toBe(5_000);
    expect(store.findById('sub-1')!.lifecycle_state).toBe('no_show'); // persisted
  });

  it('does NOT restamp state_changed_at when the same state is re-applied', () => {
    const store = createFormResponseStore(new Database(':memory:'));
    store.accept(acceptedInput());
    store.setLifecycleState('sub-1', 'accepted', 5_000);
    const again = store.setLifecycleState('sub-1', 'accepted', 9_999)!;
    // "When did this become accepted?" must not decay into "when was this last
    // touched?" -- the trap booking's state_changed_at already documents.
    expect(again.state_changed_at).toBe(5_000);
  });

  it('leaves the VISITOR-authored columns untouched by a lifecycle change', () => {
    const store = createFormResponseStore(new Database(':memory:'));
    const before = store.accept(acceptedInput()).response;
    const after = store.setLifecycleState('sub-1', 'declined', 7_000)!;
    expect(after.values).toEqual(before.values);
    expect(after.definition_snapshot).toEqual(before.definition_snapshot);
    expect(after.visitor).toEqual(before.visitor);
    expect(after.submitted_at).toBe(before.submitted_at);
    // The taint must NOT be laundered because the owner touched the row: the
    // ANSWERS are still the visitor's, and the Gateway treats a `user_self`
    // stored read as clean. One row, two authorships.
    expect(after.origin_actor).toBe('anonymous');
  });

  it('rejects a state outside the contract vocabulary', () => {
    const store = createFormResponseStore(new Database(':memory:'));
    store.accept(acceptedInput());
    expect(() => store.setLifecycleState('sub-1', 'attended' as never, 1_000))
      .toThrow(FormResponseValidationError);
    expect(store.findById('sub-1')!.lifecycle_state).toBe('received');
  });

  it('returns null for a missing row rather than inventing one', () => {
    const store = createFormResponseStore(new Database(':memory:'));
    expect(store.setLifecycleState('no-such-submission', 'accepted', 1_000)).toBeNull();
    expect(store.list()).toEqual([]);
  });

  it('ADDS the lifecycle columns to a table that predates them', () => {
    const db = new Database(':memory:');
    // The pre-slice-2 schema, verbatim minus the two new columns.
    db.exec(`
      CREATE TABLE form_response (
        submission_id TEXT PRIMARY KEY, endpoint_id TEXT NOT NULL,
        form_definition_id TEXT NOT NULL, definition_snapshot_blob TEXT NOT NULL,
        values_blob TEXT NOT NULL, visitor_blob TEXT NOT NULL,
        submitted_at INTEGER NOT NULL, accepted_at INTEGER NOT NULL,
        origin_actor TEXT NOT NULL DEFAULT 'anonymous',
        origin_surface TEXT NOT NULL DEFAULT 'system',
        metadata_blob TEXT NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO form_response VALUES "
      + "('old-1','ep-1','fd-1','{}','{}','{}',1,2,'anonymous','system','{}')",
    ).run();

    // The upgrade path: CREATE TABLE IF NOT EXISTS no-ops, so the ALTERs must
    // carry it. This throws "no such column" if the lifecycle index is created
    // before them.
    expect(() => ensureFormResponseSchema(db)).not.toThrow();

    const migrated = createFormResponseStore(db).findById('old-1')!;
    expect(migrated.lifecycle_state).toBe('received');
    // 0, NOT the migration instant -- an existing row never transitioned, and
    // stamping "now" would claim every historical response changed state on
    // deploy day.
    expect(migrated.state_changed_at).toBe(0);
    expect(migrated.updated_at).toBe(2);
    const raw = db.prepare(
      'SELECT source_content_hash FROM form_response WHERE submission_id = ?',
    ).get('old-1') as { source_content_hash: string };
    expect(raw.source_content_hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
