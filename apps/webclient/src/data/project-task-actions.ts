import type { Project, SourceRegistration, WorkEntity, WorkEntityProjectItem } from '@recued/contracts';
import type { ProjectOverviewProps } from '@recued/ui-shared/work-entity-page';
import type { DataTaskMarkDoneCaller, DataWorkEntityGetCaller, WorkEntitySourceListCaller } from './bootstrap-data-route.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

type Task = Extract<WorkEntity, { _kind: 'task' }>;
type Feedback = NonNullable<ProjectOverviewProps['task_feedback']>;
export interface ProjectTaskActionDeps {
  get?: DataWorkEntityGetCaller;
  sources: () => readonly SourceRegistration[];
  listSources?: WorkEntitySourceListCaller;
  complete?: DataTaskMarkDoneCaller;
}
const sameProject = (row: WorkEntity | null, project: Project): boolean => row?._kind === 'project' && row.id === project.id
  && row.source_id === project.source_id && row.created_at === project.created_at && row.source_record_id === project.source_record_id
  && row.deleted_at == null && (row.sync_state === 'live' || row.sync_state === 'stale_unreachable');
const sameTask = (row: WorkEntity | null, item: WorkEntityProjectItem, projectId: string): row is Task => row?._kind === 'task'
  && row.id === item.id && row.source_id === item.source_id && row.created_at === item.created_at
  && row.source_record_id === item.source_record_id && row.parent_project_id === projectId
  && row.deleted_at == null && row.sync_state === 'live';
const unavailable = (item: WorkEntityProjectItem, sources: readonly SourceRegistration[]): string | undefined => {
  const source = sources.find(row => row.id === item.source_id);
  if (item.created_at === undefined || typeof item.done !== 'boolean') return 'Update your Recued server to change tasks from this project.';
  if (item.pending_write) return 'Waiting for source confirmation. Open the task to check it.';
  if (item.stale) return 'This task may be out of date. Open it to check its source.';
  if (source?.top_tier_kind !== 'task' || !source.write_capable || source.sync_posture === 'read_through') return 'This task is read-only here.';
  return undefined;
};

/** Explicit set-state actions, bound to the task and project the owner saw.
 * A dispatched failure must be checked before another write can be attempted. */
export const createProjectTaskActions = (deps: ProjectTaskActionDeps & {
  project: () => Project;
  items: () => readonly WorkEntityProjectItem[];
  ready: () => boolean;
  changed: () => void;
  begin: () => void;
  confirmed: (task: Task) => Promise<void>;
}) => {
  let busy = false, disposed = false, feedback: Feedback | undefined;
  let chosen: { item: WorkEntityProjectItem; project: Project; done: boolean } | undefined;
  let pending = Promise.resolve();
  const enabled = () => !!deps.get && !!deps.listSources && !!deps.complete;
  const paint = () => { if (!disposed) deps.changed(); };
  const held = () => busy || feedback?.state === 'unconfirmed';
  const controls = (): NonNullable<ProjectOverviewProps['task_controls']> => new Map(deps.items().map(item => {
    const reason = unavailable(item, deps.sources());
    return [item.id, { disabled: !deps.ready() || held() || !!reason, reason }];
  }));
  const run = async (checkOnly: boolean): Promise<void> => {
    if (busy || disposed || !chosen || !enabled()) return;
    const { item, project, done } = chosen;
    busy = true; feedback = { id: item.id, title: item.title, state: 'working', message: checkOnly ? 'Checking task status…' : done ? 'Completing task…' : 'Reopening task…' };
    deps.begin(); paint();
    let dispatched = false;
    try {
      const [{ entity }, { entity: currentProject }, { sources }] = await Promise.all([
        deps.get!({ kind: 'task', id: item.id }), deps.get!({ kind: 'project', id: project.id }), deps.listSources!(),
      ]);
      if (disposed) return;
      if (!sameProject(currentProject, project) || !sameTask(entity, item, project.id)) {
        throw new Error('This task or its project link changed. Refresh the project before changing it.');
      }
      if (entity.pending_write) {
        feedback = { ...feedback, state: checkOnly ? 'unconfirmed' : 'failed',
          message: 'This task is waiting for source confirmation. Check its status before trying again.' };
        return;
      }
      if (entity.done !== done) {
        if (checkOnly) {
          feedback = { ...feedback, state: 'failed', message: 'Checked: the requested status is not set. You can retry this task.' };
          return;
        }
        const why = unavailable({ ...item, stale: false, pending_write: false }, sources);
        if (why) throw new Error(why);
        dispatched = true;
        const out = await deps.complete!({ id: item.id, done });
        if (disposed) return;
        if (!sameTask(out.entity, item, project.id) || out.entity.done !== done || out.entity.pending_write) {
          throw new Error(out.entity.pending_write ? 'Saved in Recued; waiting for source confirmation.' : 'The server did not confirm the requested task status.');
        }
        feedback = { ...feedback, state: 'confirmed', message: done ? 'Task completed.' : 'Task reopened.' };
        await deps.confirmed(out.entity);
      } else {
        feedback = { ...feedback, state: 'confirmed', message: done ? 'Task is completed.' : 'Task is open.' };
        await deps.confirmed(entity);
      }
    } catch (error) {
      if (!disposed) feedback = feedback?.state === 'confirmed'
        ? { ...feedback, message: `${feedback.message} The task list could not be refreshed.` }
        : { ...feedback!, state: dispatched || checkOnly ? 'unconfirmed' : 'failed', message: humanizeRpcError(error) };
    } finally {
      busy = false; paint();
    }
  };
  return {
    enabled, controls,
    busy: () => busy,
    holdsList: held,
    feedback: () => feedback,
    whenSettled: () => pending,
    change(id: string, done: boolean): Promise<void> {
      if (disposed || held() || !enabled() || !deps.ready()) return pending;
      const item = deps.items().find(row => row.id === id);
      if (!item || unavailable(item, deps.sources()) || item.done === done) return pending;
      chosen = { item: { ...item }, project: { ...deps.project() }, done };
      pending = run(false); return pending;
    },
    retry(checkOnly = false): Promise<void> {
      if (disposed || busy || feedback?.state !== (checkOnly ? 'unconfirmed' : 'failed')) return pending;
      pending = run(checkOnly); return pending;
    },
    dispose() { disposed = true; },
  };
};
