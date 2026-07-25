/** D-192 Slice 6b — work-entity container-pick carrier contract. */

import { describe, expect, it } from 'vitest';

import {
  CONTAINER_PICK_REQUIRED_ERROR_CODE,
  isContainerPickDetail,
  type ContainerPickDetail,
} from '../container-pick.js';
import { ERR, ERROR_MESSAGES } from '../errors.js';

const wellFormed: ContainerPickDetail = {
  source_id: 'connection:linear:conn-1',
  kind: 'task',
  dependency_ref: 'team',
  options: [
    { entity_pk: 'team-eng', label: 'Engineering' },
    { entity_pk: 'team-design', label: 'Design' },
  ],
  can_create: false,
};

describe('container-pick classification contract', () => {
  it('the error code is registered in both exhaustive RecipeErrorCode maps', () => {
    expect(CONTAINER_PICK_REQUIRED_ERROR_CODE).toBe('CONTAINER_PICK_REQUIRED');
    // A missing entry in either map is a compile error at the map literal, but
    // assert the runtime values so a future refactor can't quietly drop them.
    expect(ERR.CONTAINER_PICK_REQUIRED).toBe('error');
    expect(typeof ERROR_MESSAGES.CONTAINER_PICK_REQUIRED).toBe('string');
    expect(ERROR_MESSAGES.CONTAINER_PICK_REQUIRED.length).toBeGreaterThan(0);
  });

  it('accepts a well-formed carrier; the guard is STRUCTURAL (empty options ok either way)', () => {
    expect(isContainerPickDetail(wellFormed)).toBe(true);
    expect(
      isContainerPickDetail({
        ...wellFormed,
        create_op: 'recued-core/asana.project.create',
        target_write_op: 'recued-core/asana.task.create',
      }),
    ).toBe(true);
    expect(
      isContainerPickDetail({
        ...wellFormed,
        create_op: undefined,
        target_write_op: undefined,
      }),
    ).toBe(true);
    // The guard is a structural carrier check, not a business-rule validator: an
    // empty option set is accepted regardless of `can_create` (the resolver only
    // ever PRODUCES empty-options with can_create:true, but the guard does not
    // enforce that cross-field rule — it just requires an options array).
    expect(isContainerPickDetail({ ...wellFormed, options: [], can_create: true })).toBe(true);
    expect(isContainerPickDetail({ ...wellFormed, options: [], can_create: false })).toBe(true);
  });

  it('rejects a carrier missing any required field', () => {
    const { source_id: _s, ...noSource } = wellFormed;
    const { kind: _k, ...noKind } = wellFormed;
    const { dependency_ref: _d, ...noRef } = wellFormed;
    const { options: _o, ...noOptions } = wellFormed;
    const { can_create: _c, ...noCanCreate } = wellFormed;
    expect(isContainerPickDetail(noSource)).toBe(false);
    expect(isContainerPickDetail(noKind)).toBe(false);
    expect(isContainerPickDetail(noRef)).toBe(false);
    expect(isContainerPickDetail(noOptions)).toBe(false);
    expect(isContainerPickDetail(noCanCreate)).toBe(false);
  });

  it('rejects empty-string keys (they cannot key a store selection / ask)', () => {
    expect(isContainerPickDetail({ ...wellFormed, source_id: '' })).toBe(false);
    expect(isContainerPickDetail({ ...wellFormed, kind: '' })).toBe(false);
    expect(isContainerPickDetail({ ...wellFormed, dependency_ref: '' })).toBe(false);
  });

  it('rejects malformed optional operation ids when present', () => {
    expect(isContainerPickDetail({ ...wellFormed, create_op: '' })).toBe(false);
    expect(isContainerPickDetail({ ...wellFormed, target_write_op: '' })).toBe(false);
    expect(isContainerPickDetail({ ...wellFormed, create_op: 7 })).toBe(false);
    expect(isContainerPickDetail({ ...wellFormed, target_write_op: false })).toBe(false);
  });

  it('rejects a malformed options array or option', () => {
    expect(isContainerPickDetail({ ...wellFormed, options: 'team-eng' })).toBe(false);
    expect(
      isContainerPickDetail({ ...wellFormed, options: [{ entity_pk: 'x' }] }),
    ).toBe(false); // missing label
    expect(
      isContainerPickDetail({ ...wellFormed, options: [{ label: 'X' }] }),
    ).toBe(false); // missing entity_pk
    expect(
      isContainerPickDetail({ ...wellFormed, options: [{ entity_pk: 1, label: 'X' }] }),
    ).toBe(false); // non-string id
    expect(isContainerPickDetail({ ...wellFormed, options: [null] })).toBe(false);
  });

  it('rejects a non-boolean can_create + non-object inputs', () => {
    expect(isContainerPickDetail({ ...wellFormed, can_create: 'false' })).toBe(false);
    expect(isContainerPickDetail(null)).toBe(false);
    expect(isContainerPickDetail(undefined)).toBe(false);
    expect(isContainerPickDetail('team')).toBe(false);
    expect(isContainerPickDetail([])).toBe(false);
  });
});
