import { isDateOnlyDue, timedDueMs } from '@recued/contracts';
import { e } from './template.js';

export type TaskDueShortcut = 'today' | 'tomorrow' | 'clear';

/** Move a due in the viewer's calendar, retaining a timed deadline's clock.
 *  Undated and whole-day tasks stay whole days. Calendar arithmetic crosses
 *  daylight-saving boundaries without assuming every day has 24 hours. */
export const taskDueShortcutDue = (
  shortcut: TaskDueShortcut,
  current: number | undefined,
  now: number,
): number | undefined => {
  if (shortcut === 'clear') return undefined;
  const target = new Date(now);
  target.setDate(target.getDate() + (shortcut === 'tomorrow' ? 1 : 0));
  if (current === undefined || isDateOnlyDue(current)) {
    const day = new Date(0);
    day.setUTCFullYear(target.getFullYear(), target.getMonth(), target.getDate());
    day.setUTCHours(0, 0, 0, 0);
    return day.getTime();
  }
  const clock = new Date(current);
  const targetDay = target.getDate();
  target.setHours(clock.getHours(), clock.getMinutes(), clock.getSeconds(), clock.getMilliseconds());
  if (target.getDate() !== targetDay || target.getHours() !== clock.getHours()
    || target.getMinutes() !== clock.getMinutes()) {
    throw new Error('That time does not exist on the selected day in your time zone. Pick a date and time instead.');
  }
  return timedDueMs(target.getTime());
};

/** Both task surfaces offer the same choices; their hosts own all writes. */
export const renderTaskDueActions = (options: {
  actionAttr: string;
  prefix: string;
  title?: string;
  taskKey?: string;
  disabled?: boolean;
  hasDue: boolean;
  pickAction?: string;
  pickExpanded?: boolean;
}): string => {
  const owner = options.taskKey === undefined ? '' : ` data-today-task="${e(options.taskKey)}"`;
  const suffix = options.title ? `: ${options.title}` : '';
  const button = (action: string, label: string, aria: string, disabled = false, expanded?: boolean): string =>
    `<button type="button" ${options.actionAttr}="${e(action)}"${owner} aria-label="${e(aria)}"${expanded === undefined ? '' : ` aria-expanded="${expanded}"`}${options.disabled || disabled ? ' disabled aria-disabled="true"' : ''}>${label}</button>`;
  return `<div class="task-due-actions" role="group" aria-label="${e(`Due date shortcuts${suffix}`)}">
    ${button(`${options.prefix}-today`, 'Today', `Due today${suffix}`)}
    ${button(`${options.prefix}-tomorrow`, 'Tomorrow', `Due tomorrow${suffix}`)}
    ${button(options.pickAction ?? `${options.prefix}-pick`, 'Pick date', options.title ? `Reschedule ${options.title}` : 'Pick due date', false, options.pickExpanded)}
    ${button(`${options.prefix}-clear`, 'Clear date', `Clear due date${suffix}`, !options.hasDue)}
  </div>`;
};

export const TASK_DUE_STYLES = `
.task-due-actions { display:flex; flex-wrap:wrap; align-items:center; gap:6px; min-width:0; }
.task-due-actions button { box-sizing:border-box; min-height:44px; max-width:100%; padding:7px 10px; border:1px solid var(--rx-divider, var(--border)); border-radius:6px; background:var(--rx-input-bg, var(--surface)); color:var(--rx-fg, var(--fg)); font:inherit; font-size:13px; cursor:pointer; }
.task-due-actions button:disabled { opacity:.5; cursor:default; }
.task-due-actions button:not(:disabled):hover { border-color:var(--rx-accent, var(--accent)); }
`;
