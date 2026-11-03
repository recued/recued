import { e } from '../template.js';

export interface ProjectLinkReviewProps {
  kind: 'task' | 'note';
  title: string;
  project_title: string;
  source_label: string;
  linked: boolean;
  pending: boolean;
  can_link: boolean;
  unavailable_reason?: string;
  current_project_title?: string;
  other_projects: number;
  busy: boolean;
  error?: string;
}

/** Review a relationship change without opening an unrelated content editor. */
export const renderProjectLinkReview = (props: ProjectLinkReviewProps): string => {
  const moving = props.kind === 'task' && props.current_project_title !== undefined && !props.linked;
  const disabled = props.busy ? ' disabled' : '';
  return `<div class="work-entity-dialog-backdrop" data-action="close-work-entity-dialog-on-backdrop">
    <div class="work-entity-dialog" role="dialog" aria-modal="true" data-kind="${props.kind}"
      aria-labelledby="work-entity-dialog-title" aria-describedby="project-link-description" data-project-link-review>
      <header class="work-entity-dialog-header">
        <h2 class="work-entity-dialog-title" id="work-entity-dialog-title" tabindex="-1">${moving ? 'Move task' : `Link ${props.kind}`} to project</h2>
        <button type="button" class="work-entity-dialog-close" data-action="close-work-entity-dialog" aria-label="Close"${disabled}>×</button>
      </header>
      <div class="work-entity-note-content">
        <h3>${e(props.title)}</h3>
        <p class="work-entity-note-meta">${e(props.source_label)}</p>
        <p id="project-link-description" tabindex="-1">${props.pending && props.linked ? `The link to <strong>${e(props.project_title)}</strong> is waiting for source confirmation.`
          : props.linked ? `Already linked to <strong>${e(props.project_title)}</strong>.`
          : moving ? `Move this task from <strong>${e(props.current_project_title!)}</strong> to <strong>${e(props.project_title)}</strong>?`
          : `Link this ${props.kind} to <strong>${e(props.project_title)}</strong>?`}</p>
        ${moving ? '<p class="work-entity-note-warning">A task belongs to one project. It will no longer appear in its previous project.</p>' : ''}
        ${props.kind === 'note' && props.other_projects > 0 ? `<p>This note will keep its ${props.other_projects === 1 ? 'other project link' : `${props.other_projects} other project links`}.</p>` : ''}
        ${props.pending && props.linked ? `<p class="work-entity-note-warning" role="status">Reopen this ${props.kind} after source confirmation to check the link.</p>` : ''}
        ${!props.can_link && !props.linked ? `<p class="work-entity-note-warning">${e(props.unavailable_reason ?? `This ${props.kind} is read-only here.`)}</p>` : ''}
        ${props.error ? `<p class="work-entity-dialog-submit-error" role="alert" tabindex="-1">${e(props.error)}</p>` : ''}
      </div>
      <footer class="work-entity-dialog-actions">
        <button type="button" class="work-entity-dialog-cancel" data-action="close-work-entity-dialog"${disabled}>Back to ${props.kind === 'task' ? 'tasks' : 'notes'}</button>
        ${props.can_link && !props.linked ? `<button type="button" class="work-entity-dialog-submit" data-action="confirm-project-work-link"${disabled}${props.busy ? ' aria-busy="true"' : ''}>${props.busy ? 'Saving…' : moving ? 'Move task' : 'Link to project'}</button>` : ''}
      </footer>
    </div>
  </div>`;
};
