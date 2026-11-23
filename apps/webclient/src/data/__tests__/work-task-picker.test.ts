import { describe, expect, it, vi } from 'vitest';
import type { SourceRegistration, WorkEntity, WorkEntitySearchGroup } from '@recued/contracts';
import type { RefPicker } from '@recued/ui-shared';
import { createWorkTaskPickers, searchTaskReferences, taskReferenceLabel } from '../work-reference-picker.js';

const { wire } = vi.hoisted(() => ({ wire: vi.fn() }));
vi.mock('@recued/ui-shared', () => ({ RefPicker: { wireRefPicker: wire } }));

const task: Extract<WorkEntity, { _kind: 'task' }> = { _kind: 'task', id: 't1', title: 'Launch', done: false, blocks_task_ids: [], source_id: 'recued.task',
  sync_state: 'live', conflict_policy: 'recued_wins', created_at: 1, updated_at: 1, last_seen_at: 1 };
const sources: SourceRegistration[] = [{ id: 'recued.task', top_tier_kind: 'task', source_kind: 'builtin', source_label: 'Recued', write_capable: true, registered_at: 1 }];
const match = { id: 't1', title: 'Launch', excerpt: '', source_id: 'recued.task', source_label: 'Recued', updated_at: 1, stale: false, pending_write: false };
const group: WorkEntitySearchGroup = { kind: 'task', matches: [match], offset: 0, more: false };

describe('task reference lookup', () => {
  it('searches the task inventory and disambiguates names by source without inventing completion status', async () => {
    const search = vi.fn().mockResolvedValue({ groups: [{ ...group, more: true, matches: [match, { ...match, id: 't2', source_label: 'Imported', stale: true }] }] });
    expect(await searchTaskReferences(search, '  Launch ')).toEqual({ options: [
      { id: 't1', label: 'Launch · Recued' }, { id: 't2', label: 'Launch · Imported', sublabel: 'Last synced copy' }], truncated: true });
    expect(search).toHaveBeenCalledWith({ kind: 'task', query: 'Launch', limit: 20, offset: 0 });
  });

  it('keeps failed, malformed and unsupported searches distinct from a successful empty result', async () => {
    expect(await searchTaskReferences(async () => ({ groups: [{ ...group, matches: [] }] }), 'Absent')).toEqual({ options: [], truncated: false });
    for (const bad of [{ ...group, kind: 'project' }, { ...group, matches: [match, match] }, { ...group, offset: 20 }]) {
      expect(await searchTaskReferences(async () => ({ groups: [bad as WorkEntitySearchGroup] }), 'Launch')).toMatchObject({ options: [], retryableError: expect.stringContaining('could not be confirmed') });
    }
    expect(await searchTaskReferences(async () => { throw { code: 'unknown_method' }; }, 'Launch')).toMatchObject({ options: [], retryableError: expect.stringContaining('Update your Recued server') });
    expect(await searchTaskReferences(async () => ({ groups: [{ ...group, error: 'Task index unavailable' }] }), 'Launch')).toMatchObject({ options: [], retryableError: expect.stringContaining('Task index unavailable') });
  });

  it('shows confirmed completion state and marks a saved copy as stale', () => {
    expect(taskReferenceLabel('t1', { entity: task }, sources)).toMatchObject({ state: 'ready', label: 'Launch · Recued', message: 'Open task.' });
    const stale = { ...task, done: true, sync_state: 'stale_unreachable' as const };
    expect(taskReferenceLabel('t1', { entity: stale }, sources)).toMatchObject({ state: 'ready', message: expect.stringMatching(/Completed task.*last synced task name and status/) });
  });

  it('retains unavailable identities and rejects the wrong task or inventory', () => {
    for (const entity of [null, { ...task, deleted_at: 2 }, { ...task, sync_state: 'orphaned' as const }]) {
      expect(taskReferenceLabel('t1', { entity }, sources)).toMatchObject({ state: 'missing', label: 'Unavailable task', message: expect.stringContaining('link is kept') });
    }
    expect(() => taskReferenceLabel('different', { entity: task }, sources)).toThrow('could not be confirmed');
    const project: Extract<WorkEntity, { _kind: 'project' }> = { ...task, _kind: 'project', state: 'active', last_activity_at: 1, related_contact_ids: [] };
    expect(() => taskReferenceLabel('t1', { entity: project }, sources)).toThrow('could not be confirmed');
  });

  it('rechecks a stale choice at commit and restores the previous id before the host can capture a duplicate or self link', async () => {
    const slots = ['t2', ''].map((id, index) => {
      const mirror = { value: id, getAttribute: (name: string) => name === 'data-form-array-item' ? 'blocks_task' : name === 'data-form-array-index' ? String(index) : null }, message = { textContent: '' }, retry = { hidden: true };
      const notice = { hidden: true, querySelector: (selector: string) => selector.includes('message') ? message : retry };
      return { mirror, message, shell: { getAttribute: () => `dependency-${index}`,
        querySelector: (selector: string) => selector.includes('picker-status') ? notice : mirror } };
    });
    const controls = new Map<string, { choose: (selection: RefPicker.RefPickerSelection) => void; search: RefPicker.RefPickerSearchCaller }>();
    wire.mockImplementation((_form: unknown, options: RefPicker.WireRefPickerOptions) => {
      let value = options.initialValue ?? null;
      const mirror = slots[Number(options.config.pickerId.split('-')[1])]!.mirror;
      const setValue = (selection: RefPicker.RefPickerSelection | null) => { value = selection; mirror.value = selection?.id ?? ''; };
      controls.set(options.config.pickerId, { search: options.search, choose: selection => { setValue(selection); options.onChange?.(selection); } });
      return { getValue: () => value, setValue, rewire: () => {}, destroy: () => {} };
    });
    const changed = vi.fn(), clearArrayItem = vi.fn();
    const controller = createWorkTaskPickers({ changed, clearArrayItem, sources: () => sources, currentTaskId: () => 'self',
      get: async ({ id }) => ({ entity: { ...task, id } }),
      search: async () => ({ groups: [{ ...group, matches: ['self', 't1', 't2'].map(id => ({ ...match, id })) }] }) });
    controller.mount({ querySelectorAll: () => slots.map(slot => slot.shell) } as unknown as HTMLElement, 'editor');
    const first = controls.get('dependency-0')!, second = controls.get('dependency-1')!;
    const page = await first.search('Launch');
    expect('options' in page && page.options.map(option => option.id)).toEqual(['t1', 't2']);
    second.choose({ id: 't1', label: 'Launch · Recued' }); expect(changed).toHaveBeenCalledTimes(1);
    first.choose({ id: 't1', label: 'Launch · Recued' });
    expect(slots.map(slot => slot.mirror.value)).toEqual(['t2', 't1']);
    expect(slots[0]!.message.textContent).toContain('already selected'); expect(changed).toHaveBeenCalledTimes(1);
    first.choose({ id: 'self', label: 'Current task · Recued' });
    expect(slots[0]!.mirror.value).toBe('t2'); expect(slots[0]!.message.textContent).toContain('cannot depend on itself');
    expect(changed).toHaveBeenCalledTimes(1); expect(clearArrayItem).not.toHaveBeenCalled();
    const refreshed = await first.search('Launch');
    expect('options' in refreshed && refreshed.options.map(option => option.id)).toEqual(['t2']);
    controller.reset();
  });

  it('migrates the remaining query and committed id after row removal, freeing the removed choice while retaining the self-link guard', async () => {
    const slot = (id: string, index: number) => {
      const mirror = { value: id, getAttribute: (name: string) => name === 'data-form-array-item' ? 'blocks_task' : name === 'data-form-array-index' ? String(index) : null };
      const message = { textContent: '' }, retry = { hidden: true }, notice = { hidden: true, querySelector: (name: string) => name.includes('message') ? message : retry };
      return { mirror, message, shell: { getAttribute: () => `dependency-${index}`, querySelector: (name: string) => name.includes('picker-status') ? notice : mirror } };
    };
    let slots = [slot('t1', 0), slot('t2', 1)];
    const controls = new Map<string, { handle: RefPicker.RefPickerHandle; search: RefPicker.RefPickerSearchCaller; choose: (selection: RefPicker.RefPickerSelection) => void }>();
    wire.mockImplementation((_form: unknown, options: RefPicker.WireRefPickerOptions) => {
      let value = options.initialValue ?? null, query = value?.label ?? '';
      const mirror = slots[Number(options.config.pickerId.split('-')[1])]!.mirror;
      const handle: RefPicker.RefPickerHandle = { getValue: () => value, getQuery: () => query, setQuery: text => { query = text; },
        setValue: selection => { if (selection?.id !== value?.id || query === value?.label) query = selection?.label ?? ''; value = selection; mirror.value = selection?.id ?? ''; },
        beforeRender: vi.fn(), refresh: vi.fn(), rewire: vi.fn(), destroy: vi.fn() };
      controls.set(options.config.pickerId, { handle, search: options.search,
        choose: selection => { handle.setValue(selection); query = selection.label; options.onChange?.(selection); } });
      return handle;
    });
    const changed = vi.fn();
    const controller = createWorkTaskPickers({ changed, clearArrayItem: vi.fn(), sources: () => sources, currentTaskId: () => 'self',
      get: async ({ id }) => ({ entity: { ...task, id } }),
      search: async () => ({ groups: [{ ...group, matches: ['self', 't1', 't2'].map(id => ({ ...match, id })) }] }) });
    const form = { querySelectorAll: () => slots.map(value => value.shell) } as unknown as HTMLElement;
    controller.mount(form, 'editor'); await Promise.resolve();
    const removed = controls.get('dependency-0')!, remaining = controls.get('dependency-1')!;
    remaining.handle.setQuery('Launch'); controller.removeArrayItem('blocks_task', 0);
    slots = [slot('t2', 0)]; controller.mount(form, 'editor');
    const migrated = controls.get('dependency-0')!;
    expect(migrated.handle.getQuery()).toBe('Launch'); expect(migrated.handle.getValue()?.id).toBe('t2'); expect(slots[0]!.mirror.value).toBe('t2');
    expect(removed.handle.destroy).toHaveBeenCalledOnce(); expect(remaining.handle.destroy).toHaveBeenCalledOnce(); expect(changed).not.toHaveBeenCalled();
    const page = await migrated.search('Launch'); expect('options' in page && page.options.map(option => option.id)).toEqual(['t1', 't2']);
    migrated.choose({ id: 'self', label: 'Current task' }); expect(slots[0]!.mirror.value).toBe('t2'); expect(changed).not.toHaveBeenCalled();
    migrated.choose({ id: 't1', label: 'Launch · Recued' }); expect(slots[0]!.mirror.value).toBe('t1'); expect(changed).toHaveBeenCalledOnce();
    controller.reset();
  });
});
