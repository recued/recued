import { e } from '../template.js';

/** A host fills the status from exact task reads. The saved ids remain on the
 * shell so a missing dependency can never look like an empty dependency list. */
export const renderTaskBlockers = (owner: string, ids: readonly string[], uncertain = false): string => ids.length === 0 ? ''
  : `<details class="task-blockers" data-task-blockers="${e(owner)}" data-task-blocker-ids="${e(JSON.stringify([...new Set(ids)]))}"${uncertain ? ' data-task-blocker-uncertain' : ''}>
    <summary data-task-blocker-focus="summary"><span data-task-blocker-summary>Checking dependencies…</span></summary>
    <div data-task-blocker-body><p role="status">Checking linked tasks…</p></div>
  </details>`;

export const TASK_BLOCKERS_STYLES = `
.task-blockers { min-width:0; margin:6px 0; border:1px solid var(--border); border-radius:6px; font-size:13px; color:var(--fg); }
.work-entity-list-row > .task-blockers { grid-column:1 / -1; }
.task-blockers summary { min-height:44px; padding:10px; box-sizing:border-box; cursor:pointer; overflow-wrap:anywhere; }
.task-blockers [data-task-blocker-body] { padding:0 10px 10px; }
.task-blockers ul { display:grid; gap:10px; list-style:none; padding:0; margin:0 0 8px; }
.task-blockers li { min-width:0; display:grid; gap:3px; overflow-wrap:anywhere; }
.task-blockers p { margin:4px 0; }
.task-blockers .task-blocker-meta { color:var(--fg-muted); }
.task-blockers a { display:inline-block; min-height:44px; align-content:center; color:var(--accent); }
.task-blockers button { min-height:44px; padding:6px 10px; border:1px solid var(--border); border-radius:5px; background:var(--surface); color:var(--fg); font:inherit; cursor:pointer; }
.task-blockers button[aria-disabled="true"] { opacity:.6; cursor:default; }
.task-blockers :focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.task-blocker-return { padding:8px 0; }
.task-blocker-return button { min-height:44px; }
`;
