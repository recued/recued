/** D-201 Slices 10N and 10R — where the server's own stop left a resumed run,
 *  from the steps the engine reported from the approved one on.
 *
 *  10Q finding 1: the 10N form read the approved step alone, so the next start
 *  ran every later step again (a create that ran unasked was made twice).
 *  10Q finding 15: removing the `plain`, upload or `foreach` exclusion left
 *  every test green; each is pinned here. */

import { describe, expect, it } from 'vitest';
import type { RecipeStep } from '@recued/contracts';

import {
  restartClassificationContext, classifyRestartStop, stepUnderWay, type RestartStepProgress } from '../execute-handler.js';

const steps = [
  { id: 'remove', ingredient: 'hubspot-catalog', input: { operation: 'deal.delete' } },
  { id: 'create', ingredient: 'hubspot-catalog', input: { operation: 'deal.create' } },
  { id: 'shape', transform: 'concat', values: ['a', 'b'] },
  { id: 'check', guard: '{{step.create}} is_not_null' },
  { id: 'notify', ingredient: 'core-notification-send', input: {} },
  { id: 'fan', ingredient: 'hubspot-catalog', foreach: '{{config.ids}}', input: {} },
] as unknown as RecipeStep[];

const ran = (id: string, extra: Partial<RestartStepProgress> = {}): RestartStepProgress => ({
  id, started: true, finished: true, skipped: false, failed: false, ...extra,
});
const underWay = (id: string): RestartStepProgress => ({ id, started: true, finished: false, skipped: false, failed: false });

const classify = (
  progress: RestartStepProgress[],
  stepValues: Record<string, unknown> = { remove: { deleted: true } },
  extra: {
    approvedStepId?: string;
    approvedUploads?: number;
    plain?: boolean;
    replayed?: Parameters<typeof classifyRestartStop>[0]['replayed'];
  } = {},
) => classifyRestartStop({
  approvedStepId: extra.approvedStepId ?? 'remove',
  steps,
  progress,
  stepValues,
  approvedUploads: extra.approvedUploads ?? 0,
  plain: extra.plain ?? true,
  ...(extra.replayed !== undefined ? { replayed: extra.replayed } : {}),
});

describe('D-201 Slices 10N and 10R — classifying the server\'s own stop', () => {
  it('nothing started: unsent', () => {
    expect(classify([])).toEqual({ kind: 'unsent' });
  });

  it('the approved step under way, failed, or not as a value can stand in for: in doubt', () => {
    expect(classify([underWay('remove')])).toEqual({ kind: 'approved_in_doubt' });
    expect(classify([ran('remove', { failed: true })])).toEqual({ kind: 'approved_in_doubt' });
    // No value in `step.*` to stand in. D-201 Slice 10BP (the 10BM audit's
    // note) — it came back, though nothing of it can be kept: said so.
    expect(classify([ran('remove')], {})).toEqual({ kind: 'approved_in_doubt', returned: true });
    // A resume bound to an egress budget, a resource review or a loop's progress.
    expect(classify([ran('remove')], undefined, { plain: false })).toEqual({ kind: 'approved_in_doubt', returned: true });
    // Chunked uploads it made.
    expect(classify([ran('remove')], undefined, { approvedUploads: 1 }))
      .toEqual({ kind: 'approved_in_doubt', returned: true });
    // A loop under way: nothing of it is known yet. D-201 Slice 10BH — one that
    // finished is kept (below).
    expect(classify([underWay('fan')], undefined, { approvedStepId: 'fan' })).toEqual({ kind: 'approved_in_doubt' });
    // The first step reported is not the approved one.
    expect(classify([ran('create')], { create: {} })).toEqual({ kind: 'approved_in_doubt' });
  });

  it('the approved step returned and nothing after it started: returned, nothing more to replay', () => {
    expect(classify([ran('remove')])).toEqual({
      kind: 'returned', value: { deleted: true }, skipped: false, later: [],
    });
    expect(classify([ran('remove', { skipped: true })], { remove: null })).toEqual({
      kind: 'returned', value: null, skipped: true, later: [],
    });
  });

  it('every later step that finished is kept as it came out, in order: a value, a skip, nothing at all', () => {
    expect(classify(
      [ran('remove'), ran('create'), ran('notify', { skipped: true }), ran('shape'), ran('fan')],
      { remove: { deleted: true }, create: { id: 'deal-2' }, notify: null, shape: undefined, fan: [{ ok: true }] },
    )).toEqual({
      kind: 'returned',
      value: { deleted: true },
      skipped: false,
      later: [
        { step_id: 'create', skipped: false, value: { id: 'deal-2' } },
        { step_id: 'notify', skipped: true },
        { step_id: 'shape', skipped: false },
        { step_id: 'fan', skipped: false, value: [{ ok: true }] },
      ],
    });
  });

  it('a later step that can send something, under way at the stop: in doubt, naming it', () => {
    expect(classify(
      [ran('remove'), ran('create'), underWay('notify')],
      { remove: { deleted: true }, create: { id: 'deal-2' } },
    )).toEqual({
      kind: 'later_in_doubt',
      value: { deleted: true },
      skipped: false,
      step_id: 'notify',
      // D-201 Slice 10W (10V finding 1) — what went through before it, for the
      // owner's try again to go on from the step in doubt.
      later: [{ step_id: 'create', skipped: false, value: { id: 'deal-2' } }],
    });
    // A loop under way has sent some of its items.
    expect(classify([ran('remove'), underWay('fan')])).toMatchObject({ kind: 'later_in_doubt', step_id: 'fan' });
    // A step the recipe does not name cannot be shown to send nothing.
    expect(classify([ran('remove'), underWay('mystery')])).toMatchObject({ kind: 'later_in_doubt', step_id: 'mystery' });
  });

  it('D-201 Slice 10W (10V finding 13) — a step the run was replaying is never in doubt: its kept value stands, however far the replay got', () => {
    // A second stop while the next start replays: the shared prefetch before a
    // replay is a wait the drain can land in.
    expect(classify(
      [underWay('remove')],
      {},
      { replayed: { approved: { value: { deleted: true } } } },
    )).toEqual({ kind: 'returned', value: { deleted: true }, skipped: false, later: [] });
    expect(classify(
      [ran('remove'), underWay('create')],
      { remove: { deleted: true } },
      { replayed: { approved: { value: { deleted: true } }, steps: [{ step_id: 'create', skipped: false, value: { id: 'deal-2' } }] } },
    )).toEqual({
      kind: 'returned',
      value: { deleted: true },
      skipped: false,
      later: [{ step_id: 'create', skipped: false, value: { id: 'deal-2' } }],
    });
    // A step it was not replaying, under way after them, is still in doubt.
    expect(classify(
      [ran('remove'), underWay('create'), underWay('notify')],
      { remove: { deleted: true } },
      { replayed: { approved: { value: { deleted: true } }, steps: [{ step_id: 'create', skipped: false, value: { id: 'deal-2' } }] } },
    )).toMatchObject({ kind: 'later_in_doubt', step_id: 'notify', later: [{ step_id: 'create' }] });
    // Without the replay it was: under way, in doubt.
    expect(classify([ran('remove'), underWay('create')])).toMatchObject({ kind: 'later_in_doubt', step_id: 'create' });
    // A step it replays and had not reached is kept as it was: 10R kept only
    // what the run reported, and a stop between two replays lost the second.
    expect(classify(
      [ran('remove')],
      { remove: { deleted: true } },
      { replayed: { approved: { value: { deleted: true } }, steps: [{ step_id: 'create', skipped: false, value: { id: 'deal-2' } }] } },
    )).toEqual({
      kind: 'returned',
      value: { deleted: true },
      skipped: false,
      later: [{ step_id: 'create', skipped: false, value: { id: 'deal-2' } }],
    });
  });

  it('a later call that failed, or left no value, is in doubt too', () => {
    expect(classify([ran('remove'), ran('create', { failed: true })]))
      .toMatchObject({ kind: 'later_in_doubt', step_id: 'create' });
    expect(classify([ran('remove'), ran('create')], { remove: { deleted: true } }))
      .toMatchObject({ kind: 'later_in_doubt', step_id: 'create' });
  });

  it('a transform or a guard under way, or failed, sends nothing: it runs again, and the replay stops before it', () => {
    expect(classify(
      [ran('remove'), ran('create'), underWay('shape')],
      { remove: { deleted: true }, create: { id: 'deal-2' } },
    )).toEqual({
      kind: 'returned',
      value: { deleted: true },
      skipped: false,
      later: [{ step_id: 'create', skipped: false, value: { id: 'deal-2' } }],
    });
    expect(classify([ran('remove'), underWay('check')])).toMatchObject({ kind: 'returned', later: [] });
    expect(classify([ran('remove'), ran('shape', { failed: true })])).toMatchObject({ kind: 'returned', later: [] });
  });
});

describe('D-201 Slice 10W — what the handler reads beside the progress (10V finding 14)', () => {
  const uploads = new Map<string, readonly unknown[]>([['remove', [{ part: 1 }, { part: 2 }]], ['create', [{ part: 1 }]]]);
  const read = (resumeFrom: Parameters<typeof restartClassificationContext>[0]['resumeFrom']) =>
    restartClassificationContext({ approvedStepId: 'remove', resumeFrom, chunkedUploadsByStep: uploads });

  it('only the approved step\'s chunked uploads count', () => {
    expect(read(undefined).approvedUploads).toBe(2);
    expect(restartClassificationContext({ approvedStepId: 'look', resumeFrom: undefined, chunkedUploadsByStep: uploads })
      .approvedUploads).toBe(0);
  });

  it('a resume bound to an egress budget, a resource review or a loop\'s progress is never plain', () => {
    const base = { gated_step_id: 'remove', step_state: {} };
    expect(read(base).plain).toBe(true);
    expect(read({ ...base, egress_bound: { requests: 1, total_bytes: 10 } }).plain).toBe(false);
    expect(read({ ...base, resource_review: {} as never }).plain).toBe(false);
    expect(read({ ...base, foreach_progress: {} as never }).plain).toBe(false);
    // D-201 Slice 10BH — a loop asked for from its first item, nothing of it run
    // before the ask, is the whole loop: plain. One resumed mid-way is not.
    expect(read({ ...base, foreach_progress: { next_index: 0, results: [] } as never }).plain).toBe(true);
    expect(read({ ...base, foreach_progress: { next_index: 1, results: [{ ok: true }] } as never }).plain).toBe(false);
    expect(read({ ...base, foreach_progress: { next_index: 0, results: [{ ok: true }] } as never }).plain).toBe(false);
  });

  it('reads what the run replays', () => {
    expect(read({
      gated_step_id: 'remove',
      step_state: {},
      replayed_result: { value: { deleted: true } },
      replayed_steps: [{ step_id: 'create', skipped: false, value: { id: 'deal-2' } }],
    }).replayed).toEqual({
      approved: { value: { deleted: true } },
      steps: [{ step_id: 'create', skipped: false, value: { id: 'deal-2' } }],
    });
    expect(read(undefined).replayed).toEqual({});
  });
});

describe('D-201 Slice 10BC (10AY finding 2) — past an approved step Recued cannot keep', () => {
  it('a step after it started: in doubt, the run gone past it', () => {
    const cases: Array<[RestartStepProgress[], Record<string, unknown> | undefined, Parameters<typeof classify>[2]]> = [
      // A resume bound to an egress budget, a resource review or a loop's progress.
      [[ran('remove'), underWay('create')], undefined, { plain: false }],
      // Chunked uploads it made.
      [[ran('remove'), underWay('create')], undefined, { approvedUploads: 1 }],
      // Failed, and the run went on.
      [[ran('remove', { failed: true }), underWay('notify')], undefined, {}],
      // No value to stand in.
      [[ran('remove'), underWay('create')], {}, {}],
    ];
    for (const [progress, values, extra] of cases) {
      expect(classify(progress, values, extra)).toEqual({ kind: 'approved_in_doubt', went_past: true });
    }
  });

  it('nothing after it started: in doubt, not past it', () => {
    expect(classify([underWay('fan')], undefined, { approvedStepId: 'fan' })).toEqual({ kind: 'approved_in_doubt' });
    expect(classify([underWay('remove')])).toEqual({ kind: 'approved_in_doubt' });
    // D-201 Slice 10BP (the 10BM audit's note) — came back: said so.
    expect(classify([ran('remove')], undefined, { plain: false })).toEqual({ kind: 'approved_in_doubt', returned: true });
  });

  it('the row written ahead: at a step Recued cannot keep, marked once a later step starts', () => {
    const base = {
      approvedStepId: 'fan',
      steps,
      stepValues: { fan: [{ ok: true }] },
      resumeFrom: { gated_step_id: 'fan', execution_phase: 'sequential', egress_bound: { requests: 1, total_bytes: 10 } } as never,
      chunkedUploadsByStep: new Map<string, readonly unknown[]>(),
      piiLedgers: () => undefined,
    };
    // Its own start: nothing past it ran.
    expect(stepUnderWay({ ...base, stepId: 'fan', progress: [underWay('fan')] })).toEqual({ kind: 'in_doubt' });
    // A later step's: the steps after it run again.
    expect(stepUnderWay({ ...base, stepId: 'notify', progress: [ran('fan'), underWay('notify')] }))
      .toEqual({ kind: 'in_doubt', later_run_again: true });
    // A plain approved step names the later step instead, and is not marked.
    expect(stepUnderWay({
      ...base,
      approvedStepId: 'remove',
      stepId: 'notify',
      stepValues: { remove: { deleted: true } },
      resumeFrom: { gated_step_id: 'remove', execution_phase: 'sequential' } as never,
      progress: [ran('remove'), underWay('notify')],
    })).toEqual({ kind: 'in_doubt', step_id: 'notify', value: { deleted: true }, later: [] });
  });
});

describe('D-201 Slice 10BH — a finished approved loop is kept (the owner\'s call, 2026-11-21)', () => {
  const results = [{ ok: true, result: { closed: true }, item: 'a' }, { ok: false, error: 'gone', item: 'b' }];
  it('finished, plain, no uploads: returned as it came out, a later step under way named', () => {
    expect(classify([ran('fan')], { fan: results }, { approvedStepId: 'fan' }))
      .toEqual({ kind: 'returned', value: results, skipped: false, later: [] });
    expect(classify([ran('fan'), ran('create'), underWay('notify')], { fan: results, create: { id: 'deal-2' } },
      { approvedStepId: 'fan' })).toEqual({
      kind: 'later_in_doubt', value: results, skipped: false, step_id: 'notify',
      later: [{ step_id: 'create', skipped: false, value: { id: 'deal-2' } }],
    });
  });

  it('bound, uploaded, or under way: still in doubt', () => {
    expect(classify([ran('fan'), underWay('notify')], { fan: results }, { approvedStepId: 'fan', plain: false }))
      .toEqual({ kind: 'approved_in_doubt', went_past: true });
    expect(classify([ran('fan'), underWay('notify')], { fan: results }, { approvedStepId: 'fan', approvedUploads: 1 }))
      .toEqual({ kind: 'approved_in_doubt', went_past: true });
    expect(classify([underWay('fan')], { fan: results }, { approvedStepId: 'fan' })).toEqual({ kind: 'approved_in_doubt' });
  });

  it('the row written ahead of a later step: past the loop, saying it is one', () => {
    expect(stepUnderWay({
      approvedStepId: 'fan',
      stepId: 'notify',
      steps,
      progress: [ran('fan'), underWay('notify')],
      stepValues: { fan: results },
      resumeFrom: {
        gated_step_id: 'fan',
        execution_phase: 'sequential',
        foreach_progress: { step_id: 'fan', next_index: 0, source_length: 2, source_hash: 'h', results: [] },
      } as never,
      chunkedUploadsByStep: new Map<string, readonly unknown[]>(),
      piiLedgers: () => undefined,
    })).toEqual({ kind: 'in_doubt', step_id: 'notify', value: results, later: [], approved_foreach: true });
  });
});
