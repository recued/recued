import { dueDayIso, type Project, type ProjectWorkKind, type WorkEntityProjectItem } from '@recued/contracts';
import { e } from '../template.js';

export interface ProjectWorkSection {
  items: readonly WorkEntityProjectItem[];
  total?: number;
  open_tasks?: number;
  loading: boolean;
  more?: boolean;
  error?: string;
  provider_only_sources?: readonly string[];
}
export interface ProjectOverviewProps {
  project: Project;
  sections: Readonly<Record<ProjectWorkKind, ProjectWorkSection>>;
  editing: boolean;
  source_label: string;
  can_edit: boolean;
  can_create_task: boolean;
  can_create_note: boolean;
  stale?: boolean;
  source_incomplete?: boolean;
  close_label?: string;
  history_html?: string;
}
const date = (value: number) => dueDayIso(value) ?? new Date(value).toLocaleDateString();
const states: Record<Project['state'], string> = { active: 'Active', paused: 'Paused', completed: 'Completed', archived: 'Archived' };
const section = (kind: ProjectWorkKind, state: ProjectWorkSection, canCreate: boolean): string => {
  const label = kind === 'task' ? 'Tasks' : 'Notes';
  return `<section class="project-work-section" aria-labelledby="project-${kind}-heading" aria-busy="${state.loading}" data-project-section="${kind}">
    <header class="project-work-head"><h3 id="project-${kind}-heading" tabindex="-1" data-project-focus="${kind}-heading">${label}</h3>
      ${state.total !== undefined ? `<span class="project-work-count">${state.total}</span>` : ''}
      ${canCreate ? `<button type="button" data-action="project-work-new" data-project-kind="${kind}" data-project-focus="new-${kind}">New ${kind}</button>` : ''}</header>
    ${state.provider_only_sources?.length ? `<p class="project-work-hint">Provider-only ${label.toLowerCase()} are not included: ${e(state.provider_only_sources.join(', '))}.</p>` : ''}
    ${state.error ? `<p role="alert" class="project-work-error">${e(state.error)}${state.items.length ? ' Previously loaded items remain below.' : ''}</p>` : ''}
    ${state.loading ? `<p role="status" class="${state.total === undefined ? 'project-work-hint' : 'project-work-refreshing'}">${state.total === undefined ? 'Loading' : 'Refreshing'} ${label.toLowerCase()}…</p>` : ''}
    ${state.total === 0 && !state.loading && !state.error ? `<p class="project-work-hint">No saved ${label.toLowerCase()} are linked to this project.</p>` : ''}
    <ul class="project-work-items">${state.items.map(item => `<li><button type="button" class="project-work-item"
      data-action="project-work-open" data-project-kind="${kind}" data-project-item-id="${e(item.id)}" data-project-focus="${kind}:${e(item.id)}">
      <span class="project-work-item-title">${e(item.title)}</span>
      <span class="project-work-meta">${kind === 'task' ? `${item.done ? 'Completed' : 'Open'}${item.due_at !== undefined ? ` · Due ${e(date(item.due_at))}` : ''} · ` : ''}${e(item.source_label)}</span>
      ${item.excerpt ? `<span class="project-work-excerpt">${e(item.excerpt)}</span>` : ''}
      ${item.stale || item.source_incomplete || item.pending_write ? `<span class="project-work-badges">
        ${item.stale ? '<span>May be out of date</span>' : ''}${item.source_incomplete ? '<span>Source partly synced</span>' : ''}${item.pending_write ? '<span>Waiting for source confirmation</span>' : ''}</span>` : ''}
    </button></li>`).join('')}</ul>
    ${state.error || state.more ? `<button type="button" data-action="${state.error ? 'project-work-retry' : 'project-work-more'}" data-project-kind="${kind}"
      data-project-focus="more-${kind}"${state.loading ? ' aria-disabled="true" aria-busy="true"' : ''}>${state.loading ? 'Loading…' : state.error ? `Try ${label.toLowerCase()} again` : `More ${label.toLowerCase()}`}</button>` : ''}
  </section>`;
};
export const renderProjectOverview = (props: ProjectOverviewProps): string => {
  const { project, sections } = props;
  const open = sections.task.open_tasks;
  return `<article class="project-overview" data-project-overview="${e(project.id)}">
    <header class="project-overview-header">
      <button type="button" data-action="close-work-entity-dialog" data-project-focus="back">${e(props.close_label ?? 'Back to projects')}</button>
      ${props.can_edit ? '<button type="button" data-action="project-edit" data-project-focus="edit">Edit project</button>' : ''}
    </header>
    <div class="project-overview-summary"><div class="project-overview-status"><span class="project-state">${e(states[project.state])}</span><span class="project-work-meta">${e(props.source_label)}</span>
      ${props.stale || project.sync_state === 'stale_unreachable' ? '<span class="project-work-meta">May be out of date</span>' : ''}${props.source_incomplete ? '<span class="project-work-meta">Source partly synced</span>' : ''}${project.pending_write ? '<span class="project-work-meta">Waiting for source confirmation</span>' : ''}</div>
      <h2 class="project-overview-title" tabindex="-1" data-project-focus="heading">${e(project.title)}</h2>
      ${project.description ? `<p class="project-overview-description">${e(project.description)}</p>` : ''}
      <div class="project-overview-facts">${project.target_completion_at !== undefined ? `<span>Target ${e(date(project.target_completion_at))}</span>` : '<span>No target date</span>'}
        ${open !== undefined && sections.task.total !== undefined ? `<span>${open} open · ${sections.task.total - open} completed tasks</span>` : ''}</div>
      ${sections.task.error && sections.task.total !== undefined ? '<p class="project-work-hint">Task counts are from the last successful read.</p>' : ''}
      <p class="project-work-hint">Linked tasks and notes saved on this server. Only explicit project links are included.</p>
    </div>
    <div class="project-overview-work">${section('task', sections.task, props.can_create_task)}
      ${section('note', sections.note, props.can_create_note)}</div>
    ${props.history_html ?? ''}
  </article>`;
};
export const PROJECT_OVERVIEW_STYLES = `
.project-overview { display:flex; flex-direction:column; gap:1.25rem; min-width:0; }
.project-overview-header, .project-work-head { display:flex; flex-wrap:wrap; align-items:center; gap:.625rem; }
.project-overview-header > :last-child:not(:first-child), .project-work-head > button { margin-left:auto; }
.project-overview button { min-height:44px; box-sizing:border-box; padding:.5rem .75rem; font:inherit; color:var(--fg); background:var(--surface); border:1px solid var(--border); border-radius:.5rem; cursor:pointer; }
.project-overview button:hover { background:var(--surface-sunk); border-color:var(--border-strong); }
.project-overview button:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.project-overview button[aria-disabled="true"] { cursor:progress; color:var(--fg-muted); }
.project-overview-summary { display:flex; flex-direction:column; gap:.75rem; padding:1rem; border:1px solid var(--border); border-radius:.75rem; background:var(--surface); }
.project-overview-status { display:flex; flex-wrap:wrap; align-items:center; gap:.5rem .75rem; }
.project-state { padding:.2rem .6rem; border-radius:1rem; background:var(--surface-sunk); color:var(--fg); font-size:.8125rem; font-weight:600; }
.project-overview-work { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:1.5rem; align-items:start; }
@media (max-width:760px) { .project-overview-work { grid-template-columns:minmax(0,1fr); } }
.project-overview-title { margin:0; font-size:1.5rem; overflow-wrap:anywhere; }
.project-overview-description { margin:0; white-space:pre-wrap; line-height:1.6; overflow-wrap:anywhere; }
.project-overview-facts { display:flex; flex-wrap:wrap; gap:.5rem 1.25rem; font-size:.875rem; }
.project-work-section { display:flex; flex-direction:column; align-items:stretch; gap:.625rem; }
.project-work-head h3 { margin:0; font-size:1rem; }
.project-work-count { padding:.125rem .5rem; border-radius:1rem; background:var(--surface-sunk); font-size:.8rem; color:var(--fg-muted); }
.project-work-hint, .project-work-meta { margin:0; font-size:.8125rem; color:var(--fg-muted); line-height:1.5; }
.project-work-items { list-style:none; display:flex; flex-direction:column; gap:.5rem; padding:0; margin:0; }
.project-work-item { display:flex; flex-direction:column; gap:.3rem; width:100%; text-align:left; }
.project-work-item > span { min-width:0; max-width:100%; overflow-wrap:anywhere; }
.project-work-item-title { font-weight:600; line-height:1.5; }
.project-work-excerpt { font-size:.875rem; line-height:1.5; color:var(--fg-muted); }
.project-work-badges { display:flex; flex-wrap:wrap; gap:.4rem; }
.project-work-badges > span { padding:.125rem .4rem; border:1px dotted var(--border-strong); border-radius:.5rem; font-size:.75rem; color:var(--fg-muted); }
.project-work-section > button { align-self:flex-start; }
.project-work-error { margin:0; font-size:.875rem; color:var(--danger); }
.project-work-refreshing { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
`;
