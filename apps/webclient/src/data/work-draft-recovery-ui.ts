import { e } from '@recued/ui-shared';
import type { WorkDraftKind, WorkRecoveryEntry } from './work-draft-recovery.js';

export const WORK_DRAFT_ACTION = 'work-draft-';
const label = (field: string): string => field === 'body' ? 'Notes' : field === 'due_at' ? 'Due date'
  : field === 'target_completion_at' ? 'Target completion' : field === 'title' ? 'Title'
    : field.replace(/_/g, ' ').replace(/^./, char => char.toUpperCase());
export const renderWorkDraftRecoveries = (props: {
  kind: WorkDraftKind; entries: WorkRecoveryEntry[]; busy: string | null; preview: string | null; discard: string | null;
  notice: { id: string; text: string } | null; sourceLabel: (id: string) => string;
}): string => {
  if (!props.entries.length) return '';
  const plural = props.kind === 'task' ? 'tasks' : 'projects';
  return `<section class="work-draft-recoveries" aria-label="Unfinished ${plural}"><h2>Unfinished ${plural}</h2>
    <p>These recovery copies are kept in this browser tab for up to 7 days.</p>
    ${props.entries.map(entry => {
      const button = (action: string, text: string, disabled = false) => `<button type="button" class="data-button" data-action="${WORK_DRAFT_ACTION}${action}" data-work-draft-focus="${entry.id}-${action}"${disabled ? ' disabled' : ''}>${text}</button>`;
      const title = typeof entry.values.title === 'string' && entry.values.title.trim() || `Untitled ${props.kind}`;
      const savedId = entry.savedId ?? entry.original?.id;
      return `<article data-work-draft-id="${e(entry.id)}"><h3>${e(title)}</h3>
        <p>${e(props.sourceLabel(entry.sourceId))} · ${entry.original ? `${props.kind === 'task' ? 'Task' : 'Project'} edits` : `New ${props.kind}`} · <time datetime="${new Date(entry.updatedAt).toISOString()}">${e(new Date(entry.updatedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))}</time></p>
        ${entry.status !== 'editing' ? `<p>Save was not confirmed. Check the saved ${props.kind} or ${plural} list before creating or saving another copy.</p>` : ''}
        ${props.notice?.id === entry.id ? `<p role="alert" tabindex="-1" data-work-draft-notice data-work-draft-focus="${entry.id}-notice">${e(props.notice.text)}</p>` : ''}
        <div class="work-draft-actions">
          ${button('resume', props.busy === entry.id ? 'Checking…' : 'Resume draft', props.busy !== null || entry.status !== 'editing')}
          ${button('preview', props.preview === entry.id ? 'Hide draft' : 'Review draft', props.busy !== null)}
          ${savedId ? button('open', `Open saved ${props.kind}`, props.busy !== null) : ''}
          ${button('discard', 'Discard draft', props.busy !== null)}
        </div>
        ${props.discard === entry.id ? `<div role="group" aria-label="Discard this recovery copy?">
          <p>Discard this recovery copy? The saved ${props.kind} will stay as it is.</p>${button('keep', 'Keep draft')}${button('remove', 'Discard recovery copy')}
        </div>` : ''}
        ${props.preview === entry.id ? `<div class="work-draft-preview">${Object.entries(entry.values).map(([key, value], index) => {
          const date = key === 'due_at' || key === 'target_completion_at'
            ? typeof value === 'number' ? value : typeof value === 'string' && value ? Date.parse(value) : NaN : NaN;
          const text = Number.isFinite(date) ? new Date(date).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
            : typeof value === 'string' ? value : value === null ? '' : typeof value === 'boolean' ? value ? 'Yes' : 'No'
              : Array.isArray(value) && value.every(item => typeof item === 'string') ? value.join('\n') : JSON.stringify(value);
          return `<label for="${entry.id}-${index}">Draft ${e(label(key).toLowerCase())}</label><textarea id="${entry.id}-${index}" data-work-draft-focus="${entry.id}-field-${index}" readonly rows="${key === 'body' || key === 'description' ? 7 : text.length > 100 ? 3 : 1}">
${e(text)}</textarea>`;
        }).join('')}</div>` : ''}
      </article>`;
    }).join('')}
  </section>`;
};
export const WORK_DRAFT_RECOVERY_STYLES = `
.work-draft-recoveries { margin:0 0 1rem; padding:1rem; border:1px solid var(--border); border-radius:8px; background:var(--surface); }
.work-draft-recoveries h2 { margin:0; font-size:1rem; }
.work-draft-recoveries h3 { margin:.6rem 0 .25rem; font-size:.95rem; overflow-wrap:anywhere; }
.work-draft-recoveries p { margin:.4rem 0; color:var(--fg-muted); font-size:.85rem; overflow-wrap:anywhere; }
.work-draft-recoveries article + article { margin-top:.8rem; border-top:1px solid var(--border); padding-top:.5rem; }
.work-draft-actions { display:flex; flex-wrap:wrap; gap:.4rem; }
.work-draft-recoveries button { min-height:44px; }
.work-draft-preview { display:grid; gap:.6rem; margin-top:.6rem; }
.work-draft-preview label { font-size:.85rem; }
.work-draft-preview textarea { box-sizing:border-box; width:100%; font:inherit; padding:.5rem; color:var(--fg); background:var(--surface); border:1px solid var(--border); border-radius:4px; }
[data-work-recovery-status] { margin:.4rem 0; font-size:.8rem; color:var(--fg-muted); }
`;
