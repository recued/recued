import type { WorkEntityGetRpcResponse, WorkEntity, ProjectWorkKind, WorkEntityProjectItem, WorkEntityProjectItemsRpcRequest, WorkEntityProjectItemsRpcResponse } from '@recued/contracts';
import type { ProjectWorkSection } from '@recued/ui-shared/work-entity-page';
import { classifyRpcError } from '../shell/rpc-error-copy.js';
import { createProjectCommunication } from './project-communication.js';
import type { ProjectWorkViewState } from './project-view-state.js';
import { createProjectAttention } from './project-attention.js';
import { createProjectTaskActions, type ProjectTaskActionDeps } from './project-task-actions.js';

export type ProjectItemsCaller = (args: WorkEntityProjectItemsRpcRequest) => Promise<WorkEntityProjectItemsRpcResponse>;

/** One overview owns its reads, including while a child editor is open. */
export const createProjectWork = (project: Extract<WorkEntity, { _kind: 'project' }>, caller: ProjectItemsCaller | undefined, changed: () => void, taskDeps?: ProjectTaskActionDeps, attentionDeps?: Omit<Parameters<typeof createProjectAttention>[0], 'project' | 'adopt' | 'changed'>, communicationDeps?: Omit<Parameters<typeof createProjectCommunication>[0], 'project' | 'summary' | 'changed'>) => {
  const sections: Record<ProjectWorkKind, ProjectWorkSection> = {
    task: { items: [], loading: false }, note: { items: [], loading: false }, commitment: { items: [], loading: false },
  };
  const sequences = { task: 0, note: 0, commitment: 0 };
  const offsets = { task: 0, note: 0, commitment: 0 };
  const loadedGoals = { task: 0, note: 0, commitment: 0 };
  let query = '', draftQuery = '', searchError = '';
  let commitmentStatus: 'open' | 'all' = 'open';
  let taskCompletion: 'all' | 'open' | 'completed' = 'all';
  let currentProject = project;
  let disposed = false;
  const attention = attentionDeps ? createProjectAttention({ ...attentionDeps, project: () => currentProject, adopt: value => { currentProject = value; }, changed }) : undefined;
  const communication = communicationDeps ? createProjectCommunication({ ...communicationDeps, changed, project: () => currentProject,
    ...(attention ? { summary: async () => {
      await attention.refresh(); const state = attention.view();
      if (state?.phase !== 'ready' || !state.snapshot) throw new Error(state?.error ?? 'Project attention could not be confirmed. Refresh it before drafting an update.');
      return state.snapshot;
    } } : {}) }) : undefined;
  const load = async (kind: ProjectWorkKind, replace = false): Promise<void> => {
    const section = sections[kind];
    if (disposed || section.loading && !replace) return;
    const sequence = ++sequences[kind];
    const status = commitmentStatus, completion = taskCompletion, text = query;
    const current = () => !disposed && sequence === sequences[kind];
    section.loading = true; delete section.error; delete section.retry_append; delete section.unsupported; changed();
    let offset = replace ? 0 : offsets[kind];
    const goal = replace ? Math.max(10, loadedGoals[kind], section.items.length) : Math.max(offset, loadedGoals[kind]) + 10;
    const items: WorkEntityProjectItem[] = replace ? [] : [...section.items];
    try {
      if (!caller) throw new Error('This server cannot load project work.');
      let response: WorkEntityProjectItemsRpcResponse;
      do {
        const limit = Math.min(50, goal - offset);
        response = await caller({ project_id: project.id, kind, offset, limit, ...(text ? { query: text } : {}),
          ...(kind === 'commitment' ? { commitment_status: status } : kind === 'task' ? { task_completion: completion } : {}) });
        if (!current()) return;
        if (text && response.query === undefined) {
          section.search_supported = false;
          throw new Error('Update your Recued server to search this project. Clear search to browse its saved work.');
        }
        if (!replace && response.total < offset) throw new Error('Project work changed. Try again to refresh its items.');
        const allTasks = response.total_tasks ?? response.total;
        if (kind === 'task' && response.task_completion === undefined && completion !== 'all') {
          section.task_filters = false;
          throw new Error('Update your Recued server to filter project tasks. Choose All to view saved tasks.');
        }
        if (response.project_id !== project.id || response.kind !== kind || response.offset !== offset
          || response.query !== undefined && response.query !== text || response.items.length > limit
          || !Number.isSafeInteger(response.total) || response.total < 0
          || kind === 'task' && (!Number.isSafeInteger(response.open_tasks) || response.open_tasks! < 0 || response.open_tasks! > allTasks
            || !Number.isSafeInteger(allTasks) || allTasks < response.total
            || response.task_completion !== undefined && (response.task_completion !== completion || response.total_tasks === undefined)
            || completion !== 'all' && response.items.some(item => item.done !== (completion === 'completed'))
            || response.task_completion !== undefined && response.total !== (completion === 'all' ? allTasks : completion === 'open' ? response.open_tasks : allTasks - response.open_tasks!))
          || kind === 'commitment' && (response.commitment_status !== status || response.items.some(item => !item.commitment))) {
          throw new Error('The project page could not be confirmed. Try again.');
        }
        if (response.items.length === 0 && offset < response.total) throw new Error('The project page did not advance. Try again.');
        const known = new Set(items.map(item => item.id));
        for (const item of response.items) {
          if (known.has(item.id)) throw new Error('The project page repeated an item. Try again to refresh its results.');
          items.push(item); known.add(item.id);
        }
        offset += response.items.length;
      } while (offset < goal && offset < response.total);
      offsets[kind] = offset; loadedGoals[kind] = goal;
      section.items = items; section.total = response.total;
      section.open_tasks = response.open_tasks;
      if (kind === 'task') { section.total_tasks = response.total_tasks ?? response.total; section.task_filters = response.task_completion !== undefined; }
      section.provider_only_sources = response.provider_only_sources;
      section.search_supported = response.query !== undefined;
      section.more = offset < response.total;
    } catch (error) {
      if (!current()) return;
      section.retry_append = !replace;
      const code = classifyRpcError(error).code;
      if (code === 'unknown_method' || kind === 'commitment' && code === 'bad_request'
        && error instanceof Error && error.message.includes('either tasks or notes')) section.unsupported = true;
      else section.error = error instanceof Error ? error.message : 'Project work could not be loaded. Try again.';
    } finally {
      if (current()) { section.loading = false; changed(); }
    }
  };
  const taskActions = createProjectTaskActions({
    ...taskDeps, sources: taskDeps?.sources ?? (() => []), project: () => currentProject,
    items: () => sections.task.items, ready: () => !disposed && !sections.task.loading && !sections.task.error && sections.task.total !== undefined,
    changed,
    begin: () => { sequences.task++; },
    confirmed: async task => {
      // Preserve a verified row if refreshing the page fails. Counts continue to
      // say they belong to the last successful read until the server answers.
      sections.task.items = sections.task.items.map(item => item.id === task.id
        ? { ...item, done: task.done, pending_write: false, due_at: task.due_at } : item)
        .filter(item => taskCompletion === 'all' || item.done === (taskCompletion === 'completed'));
      await Promise.all([load('task', true), attention?.refresh()]);
    },
  });
  return { get project() { return currentProject; }, set project(value: typeof project) { currentProject = value; },
    taskActions, attention, communication, freshness: undefined as WorkEntityGetRpcResponse['source_freshness'], sections, load,
    viewState(): ProjectWorkViewState { const state = attention?.view(); return { query, draft: draftQuery, error: searchError, tasks: taskCompletion, commitments: commitmentStatus,
      loaded: { task: sections.task.items.length, note: sections.note.items.length, commitment: sections.commitment.items.length },
      ...(state?.scope ? { attention: { scope: state.scope, loaded: state.snapshot?.items.length ?? 0 } } : {}) }; },
    restore(state: ProjectWorkViewState): Promise<void> {
      if (disposed) return Promise.resolve();
      query = state.query; draftQuery = state.draft; searchError = state.error; taskCompletion = state.tasks; commitmentStatus = state.commitments;
      for (const kind of ['task', 'note', 'commitment'] as const) loadedGoals[kind] = Math.max(10, Math.min(500, state.loaded[kind]));
      return Promise.all([load('task', true), load('note', true), load('commitment', true),
        state.attention ? attention?.restore(state.attention.scope, state.attention.loaded) : attention?.refresh()]).then(() => {});
    },
    retry: (kind: ProjectWorkKind) => load(kind, !sections[kind].retry_append),
    get query() { return query; }, get draftQuery() { return draftQuery; }, get searchError() { return searchError; },
    setDraftQuery(value: string) { if (!disposed && !taskActions.busy()) draftQuery = value; },
    applyQuery(): Promise<void> {
      if (disposed || taskActions.busy()) return Promise.resolve();
      if (draftQuery.length > 200 || /[\u0000-\u001f\u007f]/u.test(draftQuery)) {
        searchError = 'Search this project with up to 200 characters of text.'; changed(); return Promise.resolve();
      }
      const next = draftQuery.trim(); searchError = '';
      if (next === query) { draftQuery = next; changed(); return Promise.resolve(); }
      query = draftQuery = next;
      for (const kind of ['task', 'note', 'commitment'] as const) {
        sequences[kind]++; offsets[kind] = loadedGoals[kind] = 0;
        sections[kind] = { items: [], loading: false, task_filters: sections[kind].task_filters };
      }
      return Promise.all((['task', 'note', 'commitment'] as const).map(kind => load(kind, true))).then(() => {});
    },
    get taskCompletion() { return taskCompletion; },
    setTaskCompletion(completion: typeof taskCompletion) {
      if (disposed || taskActions.busy() || completion === taskCompletion) return;
      taskCompletion = completion; sequences.task++; offsets.task = loadedGoals.task = 0;
      sections.task = { items: [], loading: false, total_tasks: sections.task.total_tasks,
        open_tasks: sections.task.open_tasks, task_filters: sections.task.task_filters };
      void load('task', true);
    },
    get commitmentStatus() { return commitmentStatus; },
    setCommitmentStatus(status: 'open' | 'all') {
      if (disposed || taskActions.busy() || status === commitmentStatus) return;
      commitmentStatus = status; sequences.commitment++; offsets.commitment = loadedGoals.commitment = 0;
      sections.commitment = { items: [], loading: false };
      void load('commitment', true);
    },
    dispose() { disposed = true; taskActions.dispose(); attention?.dispose(); communication?.dispose(); } };
};
export type ProjectWork = ReturnType<typeof createProjectWork>;
