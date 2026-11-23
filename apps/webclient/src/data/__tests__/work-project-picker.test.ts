import { describe, expect, it, vi } from 'vitest';
import type { WorkEntity, SourceRegistration, WorkEntitySearchGroup } from '@recued/contracts';
import { projectReferenceLabel, searchProjectReferences } from '../work-reference-picker.js';

const project: Extract<WorkEntity, { _kind: 'project' }> = { _kind: 'project', id: 'p1', title: 'Launch', state: 'active', source_id: 'recued.project',
  sync_state: 'live', conflict_policy: 'recued_wins', created_at: 1, updated_at: 1, last_seen_at: 1, last_activity_at: 1, related_contact_ids: [] };
const sources: SourceRegistration[] = [{ id: 'recued.project', top_tier_kind: 'project', source_kind: 'builtin', source_label: 'Recued', write_capable: true, registered_at: 1 }];
const match = { id: 'p1', title: 'Launch', excerpt: '', source_id: 'recued.project', source_label: 'Recued', updated_at: 1, stale: false, pending_write: false };
const group: WorkEntitySearchGroup = { kind: 'project', matches: [match], offset: 0, more: false };

describe('project reference lookup', () => {
  it('searches projects on the server and distinguishes identical titles by source while reporting more matches', async () => {
    const search = vi.fn().mockResolvedValue({ groups: [{ ...group, more: true, matches: [match, { ...match, id: 'p2', source_label: 'Imported' }] }] });
    expect(await searchProjectReferences(search, '  Launch ')).toEqual({ options: [
      { id: 'p1', label: 'Launch · Recued' }, { id: 'p2', label: 'Launch · Imported' }], truncated: true });
    expect(search).toHaveBeenCalledWith({ kind: 'project', query: 'Launch', limit: 20, offset: 0 });
  });

  it('refuses wrong inventories, repeated ids and invalid pages instead of making them selectable', async () => {
    for (const bad of [{ ...group, kind: 'task' }, { ...group, matches: [match, match] }, { ...group, offset: 20 }]) {
      const result = await searchProjectReferences(async () => ({ groups: [bad as WorkEntitySearchGroup] }), 'Launch');
      expect(result.options).toEqual([]); expect(result.retryableError).toContain('could not be confirmed');
    }
  });

  it('distinguishes an empty result from a failed or unsupported search and keeps source freshness visible', async () => {
    expect(await searchProjectReferences(async () => ({ groups: [{ ...group, matches: [] }] }), 'Absent')).toEqual({ options: [], truncated: false });
    expect(await searchProjectReferences(async () => { throw { code: 'unknown_method' }; }, 'Launch')).toMatchObject({ options: [], retryableError: expect.stringContaining('Update your Recued server') });
    expect(await searchProjectReferences(async () => ({ groups: [{ ...group, error: 'Local index unavailable' }] }), 'Launch')).toMatchObject({ options: [], retryableError: expect.stringContaining('Local index unavailable') });
    expect((await searchProjectReferences(async () => ({ groups: [{ ...group, matches: [{ ...match, stale: true, pending_write: true }] }] }), 'Launch')).options[0]?.sublabel).toBe('Last synced copy · Changes pending');
  });

  it('hydrates only the exact project identity and reports a missing or orphaned project without inventing a replacement', () => {
    expect(projectReferenceLabel('p1', { entity: project }, sources)).toMatchObject({ state: 'ready', label: 'Launch · Recued', message: '' });
    expect(() => projectReferenceLabel('other', { entity: project }, sources)).toThrow('could not be confirmed');
    for (const entity of [null, { ...project, deleted_at: 2 }, { ...project, sync_state: 'orphaned' as const }]) {
      expect(projectReferenceLabel('p1', { entity }, sources)).toEqual({ state: 'missing', label: 'Unavailable project', message: expect.stringContaining('link is kept') });
    }
  });
});
