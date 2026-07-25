/** D-192 Slice 6c — work-entity create-plan carrier contract. */

import { describe, expect, it } from 'vitest';

import {
  CREATE_PLAN_REQUIRED_ERROR_CODE,
  isCreatePlanDetail,
  type CreatePlanDetail,
  type PlannedDependencyCreate,
} from '../create-plan.js';
import { ERR, ERROR_MESSAGES } from '../errors.js';

const plan: PlannedDependencyCreate = {
  ref: 'project', create_op: 'project.create', name: 'Roadmap',
  args: { 'body.data': { name: 'Roadmap' } }, result_path: 'data', id_field: 'gid',
};

const wellFormed: CreatePlanDetail = {
  source_id: 'asana.conn-1.task',
  kind: 'task',
  plans: [plan],
  target_summary: "task 'Ship it'",
};

describe('create-plan classification contract', () => {
  it('the error code is registered in both exhaustive RecipeErrorCode maps', () => {
    expect(CREATE_PLAN_REQUIRED_ERROR_CODE).toBe('CREATE_PLAN_REQUIRED');
    expect(ERR.CREATE_PLAN_REQUIRED).toBe('error');
    expect(typeof ERROR_MESSAGES.CREATE_PLAN_REQUIRED).toBe('string');
    expect(ERROR_MESSAGES.CREATE_PLAN_REQUIRED.length).toBeGreaterThan(0);
  });

  it('accepts a well-formed carrier (an empty name is allowed — vendors may auto-name)', () => {
    expect(isCreatePlanDetail(wellFormed)).toBe(true);
    expect(isCreatePlanDetail({ ...wellFormed, plans: [{ ...plan, name: '' }] })).toBe(true);
  });

  it('rejects a carrier missing any required field', () => {
    const { source_id: _s, ...noSource } = wellFormed;
    const { kind: _k, ...noKind } = wellFormed;
    const { plans: _p, ...noPlans } = wellFormed;
    const { target_summary: _t, ...noSummary } = wellFormed;
    expect(isCreatePlanDetail(noSource)).toBe(false);
    expect(isCreatePlanDetail(noKind)).toBe(false);
    expect(isCreatePlanDetail(noPlans)).toBe(false);
    expect(isCreatePlanDetail(noSummary)).toBe(false);
  });

  it('rejects empty-string keys + an EMPTY plans array (the create set is load-bearing)', () => {
    expect(isCreatePlanDetail({ ...wellFormed, source_id: '' })).toBe(false);
    expect(isCreatePlanDetail({ ...wellFormed, kind: '' })).toBe(false);
    expect(isCreatePlanDetail({ ...wellFormed, plans: [] })).toBe(false);
  });

  it('rejects a malformed plan entry', () => {
    expect(isCreatePlanDetail({ ...wellFormed, plans: 'project.create' })).toBe(false);
    expect(isCreatePlanDetail({ ...wellFormed, plans: [{ ...plan, create_op: '' }] })).toBe(false);
    expect(isCreatePlanDetail({ ...wellFormed, plans: [{ ...plan, result_path: '' }] })).toBe(false);
    expect(isCreatePlanDetail({ ...wellFormed, plans: [{ ...plan, id_field: '' }] })).toBe(false);
    expect(isCreatePlanDetail({ ...wellFormed, plans: [{ ...plan, args: [] }] })).toBe(false); // args must be an object
    expect(isCreatePlanDetail({ ...wellFormed, plans: [null] })).toBe(false);
  });

  it('rejects non-object inputs', () => {
    expect(isCreatePlanDetail(null)).toBe(false);
    expect(isCreatePlanDetail(undefined)).toBe(false);
    expect(isCreatePlanDetail('project')).toBe(false);
    expect(isCreatePlanDetail([])).toBe(false);
  });
});
