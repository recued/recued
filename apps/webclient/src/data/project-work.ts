import type { WorkEntityGetRpcResponse, WorkEntity, ProjectWorkKind, WorkEntityProjectItem, WorkEntityProjectItemsRpcRequest, WorkEntityProjectItemsRpcResponse } from '@recued/contracts';
import type { ProjectWorkSection } from '@recued/ui-shared/work-entity-page';

export type ProjectItemsCaller = (args: WorkEntityProjectItemsRpcRequest) => Promise<WorkEntityProjectItemsRpcResponse>;

/** One overview owns its reads, including while a child editor is open. */
export const createProjectWork = (project: Extract<WorkEntity, { _kind: 'project' }>, caller: ProjectItemsCaller | undefined, changed: () => void) => {
  const sections: Record<ProjectWorkKind, ProjectWorkSection> = {
    task: { items: [], loading: false }, note: { items: [], loading: false },
  };
  const sequences = { task: 0, note: 0 };
  const offsets = { task: 0, note: 0 };
  let disposed = false;
  const load = async (kind: ProjectWorkKind, replace = false): Promise<void> => {
    const section = sections[kind];
    if (disposed || section.loading && !replace) return;
    const sequence = ++sequences[kind];
    const current = () => !disposed && sequence === sequences[kind];
    section.loading = true; delete section.error; changed();
    let offset = replace ? 0 : offsets[kind];
    const goal = replace ? Math.max(10, section.items.length) : offset + 10;
    const items: WorkEntityProjectItem[] = replace ? [] : [...section.items];
    try {
      if (!caller) throw new Error('This server cannot load project work.');
      let response: WorkEntityProjectItemsRpcResponse;
      do {
        response = await caller({ project_id: project.id, kind, offset, limit: Math.min(50, goal - offset) });
        if (!current()) return;
        if (!replace && response.total < offset) throw new Error('Project work changed. Try again to refresh its items.');
        if (response.project_id !== project.id || response.kind !== kind || response.offset !== offset
          || !Number.isSafeInteger(response.total) || response.total < 0
          || kind === 'task' && (!Number.isSafeInteger(response.open_tasks) || response.open_tasks! < 0 || response.open_tasks! > response.total)) {
          throw new Error('The project page could not be confirmed. Try again.');
        }
        if (response.items.length === 0 && offset < response.total) throw new Error('The project page did not advance. Try again.');
        const known = new Set(items.map(item => item.id));
        for (const item of response.items) if (!known.has(item.id)) { items.push(item); known.add(item.id); }
        offset += response.items.length;
      } while (offset < goal && offset < response.total);
      offsets[kind] = offset;
      section.items = items; section.total = response.total;
      section.open_tasks = response.open_tasks;
      section.provider_only_sources = response.provider_only_sources;
      section.more = offset < response.total;
    } catch (error) {
      if (current()) section.error = error instanceof Error ? error.message : 'Project work could not be loaded. Try again.';
    } finally {
      if (current()) { section.loading = false; changed(); }
    }
  };
  return { project, freshness: undefined as WorkEntityGetRpcResponse['source_freshness'], sections, load, dispose() { disposed = true; } };
};
export type ProjectWork = ReturnType<typeof createProjectWork>;
