import { dueDayIso, type Project, type ProjectWorkKind, type WorkEntityProjectItem } from '@recued/contracts';
import { e } from '../template.js';
import { commitmentDeadlineLabel, commitmentDirectionLabel, commitmentStatusLabel } from './commitment-reader.js';

export interface ProjectWorkSection {
  items: readonly WorkEntityProjectItem[];
  total?: number;
  open_tasks?: number;
  loading: boolean;
  more?: boolean;
  error?: string;
  /** The server cannot list a project's work (one before 26.10.28). Not an error: a retry cannot help. */
  unsupported?: true;
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
  can_create_commitment?: boolean;
  can_link_task?: boolean;
  can_link_note?: boolean;
  can_link_commitment?: boolean;
  commitment_status?: 'open' | 'all';
  stale?: boolean;
  source_incomplete?: boolean;
  close_label?: string;
  history_html?: string;
}
const date = (value: number) => dueDayIso(value) ?? new Date(value).toLocaleDateString();
const states: Record<Project['state'], string> = { active: 'Active', paused: 'Paused', completed: 'Completed', archived: 'Archived' };
const section = (kind: ProjectWorkKind, state: ProjectWorkSection, canCreate: boolean, props: ProjectOverviewProps): string => {
  const label = kind === 'task' ? 'Tasks' : kind === 'note' ? 'Notes' : 'Commitments';
  const commitmentStatus = props.commitment_status ?? 'open';
  return `<section class="project-work-section" aria-labelledby="project-${kind}-heading" aria-busy="${state.loading}" data-project-section="${kind}">
    <header class="project-work-head"><h3 id="project-${kind}-heading" tabindex="-1" data-project-focus="${kind}-heading">${kind === 'commitment' ? 'Blocking commitments' : label}</h3>
      ${state.total !== undefined ? `<span class="project-work-count">${state.total}</span>` : ''}
      <div class="project-work-actions">${canCreate && !state.unsupported ? `<button type="button" data-action="project-work-new" data-project-kind="${kind}" data-project-focus="new-${kind}">New ${kind}</button>` : ''}
        ${props[`can_link_${kind}`] && !state.unsupported ? `<button type="button" data-action="project-work-link-existing" data-project-kind="${kind}" data-project-focus="link-${kind}">Link existing</button>` : ''}</div></header>
    ${kind === 'commitment' ? `<div class="project-commitment-filters" role="group" aria-label="Commitments to show">
      <button type="button" data-action="project-commitment-scope" data-project-status="open" data-project-focus="commitment-open" aria-pressed="${commitmentStatus === 'open'}">Outstanding</button>
      <button type="button" data-action="project-commitment-scope" data-project-status="all" data-project-focus="commitment-all" aria-pressed="${commitmentStatus === 'all'}">All</button></div>` : ''}
    ${state.provider_only_sources?.length ? `<p class="project-work-hint">Provider-only ${label.toLowerCase()} are not included: ${e(state.provider_only_sources.join(', '))}.</p>` : ''}
    ${state.unsupported ? `<p class="project-work-hint">Update your Recued server to list this project's ${label.toLowerCase()}.</p>` : ''}
    ${state.error ? `<p role="alert" class="project-work-error">${e(state.error)}${state.items.length ? ' Previously loaded items remain below.' : ''}</p>` : ''}
    ${state.loading ? `<p role="status" class="${state.total === undefined ? 'project-work-hint' : 'project-work-refreshing'}">${state.total === undefined ? 'Loading' : 'Refreshing'} ${label.toLowerCase()}…</p>` : ''}
    ${state.total === 0 && !state.loading && !state.error ? `<p class="project-work-hint">No ${kind === 'commitment' && commitmentStatus === 'open' ? 'outstanding commitments' : `saved ${label.toLowerCase()}`} are linked to this project.</p>` : ''}
    <ul class="project-work-items">${state.items.map(item => `<li><button type="button" class="project-work-item"
      data-action="project-work-open" data-project-kind="${kind}" data-project-item-id="${e(item.id)}" data-project-focus="${kind}:${e(item.id)}">
      <span class="project-work-item-title">${e(item.title)}</span>
      ${item.commitment ? `<span class="project-work-meta">${e(commitmentDirectionLabel(item.commitment.direction))} · ${e(item.commitment.counterparty_label ?? 'No contact linked')} · ${e(commitmentDeadlineLabel(item.commitment))}</span>
        <span class="project-work-commitment-status${item.commitment.lifecycle_state === 'pending' && item.commitment.due_status === 'overdue' ? ' is-overdue' : ''}">${e(commitmentStatusLabel(item.commitment))}</span>` : ''}
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
      <p class="project-work-hint">Linked tasks, notes and blocking commitments saved on this server. Only explicit project links are included.</p>
    </div>
    <div class="project-overview-work">${section('commitment', sections.commitment, props.can_create_commitment === true, props)}
      ${section('task', sections.task, props.can_create_task, props)}
      ${section('note', sections.note, props.can_create_note, props)}</div>
    ${props.history_html ?? ''}
  </article>`;
};
export const PROJECT_OVERVIEW_STYLES = `
.project-overview { display:flex; flex-direction:column; gap:1.25rem; min-width:0; }
.project-overview-header, .project-work-head { display:flex; flex-wrap:wrap; align-items:center; gap:.625rem; }
.project-overview-header > :last-child:not(:first-child), .project-work-head > button { margin-left:auto; }
:is(.project-overview, .project-link-context) button { min-height:44px; box-sizing:border-box; padding:.5rem .75rem; font:inherit; color:var(--fg); background:var(--surface); border:1px solid var(--border); border-radius:.5rem; cursor:pointer; }
:is(.project-overview, .project-link-context) button:hover { background:var(--surface-sunk); border-color:var(--border-strong); }
:is(.project-overview, .project-link-context) button:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
:is(.project-overview, .project-link-context) button[aria-disabled="true"] { cursor:progress; color:var(--fg-muted); }
.project-overview-summary { display:flex; flex-direction:column; gap:.75rem; padding:1rem; border:1px solid var(--border); border-radius:.75rem; background:var(--surface); }
.project-overview-status { display:flex; flex-wrap:wrap; align-items:center; gap:.5rem .75rem; }
.project-state { padding:.2rem .6rem; border-radius:1rem; background:var(--surface-sunk); color:var(--fg); font-size:.8125rem; font-weight:600; }
.project-overview-work { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:1.5rem; align-items:start; }
@media (max-width:760px) { .project-overview-work { grid-template-columns:minmax(0,1fr); } }
.project-overview-title { margin:0; font-size:1.5rem; overflow-wrap:anywhere; }
.project-overview-description { margin:0; white-space:pre-wrap; line-height:1.6; overflow-wrap:anywhere; }
.project-overview-facts { display:flex; flex-wrap:wrap; gap:.5rem 1.25rem; font-size:.875rem; }
.project-work-section { display:flex; flex-direction:column; align-items:stretch; gap:.625rem; }
.project-work-section[data-project-section="commitment"] { grid-column:1 / -1; }
.project-work-section[data-project-section="commitment"] .project-work-items { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,20rem),1fr)); }
.project-work-section[data-project-section="commitment"] .project-work-item { height:100%; }
.project-work-actions { display:flex; flex-wrap:wrap; gap:.5rem; margin-left:auto; }
.project-commitment-filters { display:flex; flex-wrap:wrap; gap:.5rem; }
.project-commitment-filters [aria-pressed="true"] { border-color:var(--accent); background:var(--surface-sunk); font-weight:600; }
.project-work-commitment-status { font-size:.8125rem; font-weight:600; }
.project-work-commitment-status.is-overdue { color:var(--danger); }
.project-link-context { display:flex; flex-wrap:wrap; align-items:center; gap:.5rem 1rem; margin:0 0 1rem; padding:.75rem 1rem; border:1px solid var(--border); border-radius:.5rem; }
.project-link-context p { flex:1; min-width:12rem; margin:0; }
.work-entity-dialog[data-project-link-review] { width:min(560px,100%); overflow:hidden; }
.work-entity-dialog[data-project-link-review] .work-entity-dialog-header { flex-shrink:0; }
.work-entity-dialog[data-project-link-review] .work-entity-dialog-title { min-width:0; overflow-wrap:anywhere; }
.work-entity-dialog[data-project-link-review] .work-entity-note-content { gap:12px; }
.work-entity-dialog[data-project-link-review] .work-entity-note-content > :is(h3,p) { margin:0; overflow-wrap:anywhere; }
.work-entity-dialog[data-project-link-review] .work-entity-dialog-actions { padding:12px 20px; flex-shrink:0; flex-wrap:wrap; }
.work-entity-dialog[data-project-link-review] button { min-height:44px; }
.work-entity-dialog[data-project-link-review] button:disabled { opacity:.6; cursor:progress; }
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
