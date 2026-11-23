import { NOTE_DRAFT_RELATIONS, type NoteRecoveryEntry } from './note-draft-recovery.js';

const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
export const NOTE_DRAFT_ACTION = 'note-draft-';
export const renderNoteDraftRecoveries = (props: {
  entries: NoteRecoveryEntry[]; busy: string | null; preview: string | null; discard: string | null;
  notice: { id: string; text: string } | null; sourceLabel: (id: string) => string;
}): string => {
  if (!props.entries.length) return '';
  return `<section class="note-draft-recoveries" aria-label="Unfinished notes"><h2>Unfinished notes</h2>
    <p>These recovery copies are kept in this browser tab for up to 7 days.</p>
    ${props.entries.map(entry => {
      const button = (action: string, text: string, disabled = false) => `<button type="button" class="data-button" data-action="${NOTE_DRAFT_ACTION}${action}" data-note-focus="draft-${entry.id}-${action}"${disabled ? ' disabled' : ''}>${text}</button>`;
      const busy = props.busy !== null, preview = props.preview === entry.id, title = entry.values.title.trim() || 'Untitled note';
      const savedId = entry.savedId ?? entry.original?.id;
      return `<article data-note-draft-id="${escape(entry.id)}"><h3>${escape(title)}</h3>
        <p>${escape(props.sourceLabel(entry.sourceId))} · ${entry.original ? 'Note edits' : 'New note'} · <time datetime="${new Date(entry.updatedAt).toISOString()}">${escape(new Date(entry.updatedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))}</time></p>
        ${entry.status !== 'editing' ? '<p>Save was not confirmed. Check the saved note or Notes list before creating or saving another copy.</p>' : ''}
        ${props.notice?.id === entry.id ? `<p role="alert" tabindex="-1" data-note-draft-notice data-note-focus="draft-${entry.id}-notice">${escape(props.notice.text)}</p>` : ''}
        <div class="note-draft-recovery-actions">
          ${button('resume', props.busy === entry.id ? 'Checking…' : 'Resume draft', busy || entry.status !== 'editing')}
          ${button('preview', preview ? 'Hide draft' : 'Review draft', busy)}
          ${savedId ? button('open', 'Open saved note', busy) : ''}
          ${button('discard', 'Discard draft', busy)}
        </div>
        ${props.discard === entry.id ? `<div class="note-draft-discard" role="group" aria-label="Discard this recovery copy?">
          <p>Discard this recovery copy? The saved note will stay as it is.</p>${button('keep', 'Keep draft')}${button('remove', 'Discard recovery copy')}
        </div>` : ''}
        ${preview ? `<div class="note-draft-preview"><label for="${entry.id}-title">Draft title</label><input id="${entry.id}-title" readonly value="${escape(entry.values.title)}">
          <label for="${entry.id}-text">Draft text</label><textarea id="${entry.id}-text" readonly rows="7">
${escape(entry.values.body)}</textarea>
          <p>${NOTE_DRAFT_RELATIONS.map((key, index) => entry.values[key].length ? `${entry.values[key].length} related ${['contact', 'calendar event', 'mail thread', 'project'][index]}${entry.values[key].length === 1 ? '' : 's'}` : '').filter(Boolean).join(' · ')}</p>
        </div>` : ''}
      </article>`;
    }).join('')}
  </section>`;
};
export const NOTE_DRAFT_RECOVERY_STYLES = `
.note-draft-recoveries { margin:0 0 1rem; padding:1rem; border:1px solid var(--border); border-radius:8px; background:var(--surface); }
.note-draft-recoveries h2 { margin:0; font-size:1rem; }
.note-draft-recoveries h3 { margin:.6rem 0 .25rem; font-size:.95rem; overflow-wrap:anywhere; }
.note-draft-recoveries p { margin:.4rem 0; color:var(--fg-muted); font-size:.85rem; overflow-wrap:anywhere; }
.note-draft-recoveries article + article { margin-top:.8rem; border-top:1px solid var(--border); padding-top:.5rem; }
.note-draft-recovery-actions { display:flex; flex-wrap:wrap; gap:.4rem; }
.note-draft-recoveries button { min-height:44px; }
.note-draft-discard { margin-top:.6rem; }
.note-draft-discard button { margin-right:.4rem; }
.note-draft-preview { display:grid; gap:.6rem; margin-top:.6rem; }
.note-draft-preview label { display:grid; gap:.3rem; font-size:.85rem; }
.note-draft-preview input,.note-draft-preview textarea { box-sizing:border-box; width:100%; font:inherit; padding:.5rem; color:var(--fg); background:var(--surface); border:1px solid var(--border); border-radius:4px; }
[data-note-recovery-status] { margin:.4rem 0; font-size:.8rem; color:var(--fg-muted); }
`;
