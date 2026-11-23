import type { SourceRegistration, WorkEntity } from '@recued/contracts';
import { RefPicker } from '@recued/ui-shared';
import type { DataWorkEntityGetCaller, DataWorkEntitySearchCaller } from './bootstrap-data-route.js';
import { projectReferenceLabel, searchProjectReferences } from './work-reference-picker.js';

type Task = Extract<WorkEntity, { _kind: 'task' }>;
export type BulkTaskProject = Extract<WorkEntity, { _kind: 'project' }>;
export type TaskProjectChange = { from: string; to: string };

export const availableTaskProject = (entity: WorkEntity | null, sources: readonly SourceRegistration[]): entity is BulkTaskProject =>
  entity?._kind === 'project' && entity.deleted_at == null && entity.sync_state === 'live' && !entity.pending_write
  && sources.some(source => source.id === entity.source_id && source.top_tier_kind === 'project');

export const sameTaskProject = (entity: WorkEntity | null, target: BulkTaskProject, sources: readonly SourceRegistration[]): boolean =>
  availableTaskProject(entity, sources) && entity.id === target.id && entity.source_id === target.source_id
  && entity.source_record_id === target.source_record_id && entity.created_at === target.created_at;

/** Names are read for review; the selected task snapshots retain the original
 * links. Missing old project names never silently turn into "No project". */
export const loadTaskProjectPreview = async (deps: {
  tasks: readonly Task[]; targetId?: string; get: DataWorkEntityGetCaller; sources: () => readonly SourceRegistration[];
  current: () => boolean; unavailable: (task: Task) => string | undefined;
}) => {
  if (!deps.current()) return null;
  let target: BulkTaskProject | null = null;
  const names = new Map<string, string>();
  if (deps.targetId !== undefined) {
    const response = await deps.get({ kind: 'project', id: deps.targetId });
    if (!deps.current()) return null;
    if (!availableTaskProject(response.entity, deps.sources()) || response.entity.id !== deps.targetId) {
      throw new Error('This project is unavailable or waiting for source confirmation. Choose an available project.');
    }
    target = { ...response.entity };
    names.set(target.id, projectReferenceLabel(target.id, response, deps.sources()).label);
  }
  const ids = [...new Set(deps.tasks.map(task => task.parent_project_id).filter((id): id is string => !!id))].filter(id => !names.has(id));
  for (let index = 0; index < ids.length; index += 8) {
    if (!deps.current()) return null;
    await Promise.all(ids.slice(index, index + 8).map(async id => {
      try { names.set(id, projectReferenceLabel(id, await deps.get({ kind: 'project', id }), deps.sources()).label); }
      catch { names.set(id, 'Project name unavailable'); }
    }));
  }
  if (!deps.current()) return null;
  const to = target ? names.get(target.id)! : 'No project';
  return { target, rows: deps.tasks.map(task => ({ task,
    projectChange: { from: task.parent_project_id ? names.get(task.parent_project_id)! : 'No project', to },
    message: deps.unavailable(task) ?? ((task.parent_project_id ?? null) === (target?.id ?? null)
      ? target ? 'Already in this project.' : 'Already has no project.' : undefined),
  })) };
};

/** Keep the shared combobox's query and keyboard state across host renders. */
export const createTaskBulkProjectPicker = (deps: {
  search?: DataWorkEntitySearchCaller; choose: (value: RefPicker.RefPickerSelection | null) => void;
  picker?: { id: string; label: string; focusAttr: string };
}) => {
  const config: RefPicker.RefPickerRenderConfig = { pickerId: deps.picker?.id ?? 'task-bulk-project', ariaLabel: deps.picker?.label ?? 'Project for selected tasks',
    placeholder: 'Search projects by name', emptyText: 'No matching projects.', truncatedText: 'More projects match. Type a more specific project name.' };
  let handle: RefPicker.RefPickerHandle | undefined;
  const queries = new Map<string, string>();
  const detach = () => { handle?.destroy(); handle = undefined; };
  const reset = () => { detach(); queries.clear(); };
  return { reset,
    render: (selection: RefPicker.RefPickerSelection | null) => RefPicker.renderRefPicker(RefPicker.initialRefPickerState(selection), config),
    mount(root: ParentNode, selection: RefPicker.RefPickerSelection | null) {
      const shell = root.querySelector?.<HTMLElement>(`[data-ref-picker="${config.pickerId}"]`);
      if (!shell) { detach(); return; }
      if (handle) handle.rewire(root);
      else handle = RefPicker.wireRefPicker(root, { config, initialValue: selection,
        search: async query => {
          const selected = handle?.getValue();
          const actual = selected && query === selected.label ? queries.get(selected.id) ?? query : query;
          const page = await searchProjectReferences(deps.search, actual);
          for (const option of page.options) queries.set(option.id, actual);
          return page;
        }, onChange: deps.choose });
      shell.querySelector('[data-ref-picker-input]')?.setAttribute(deps.picker?.focusAttr ?? 'data-task-bulk-focus', 'project-search');
    },
  };
};
