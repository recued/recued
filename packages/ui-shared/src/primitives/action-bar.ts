/** Action bar primitive.
 *
 *  "Row of buttons at the bottom of a panel" — recurs as
 *  `cloud-actions`, `sync-actions`, `signout-actions`,
 *  `clear-data-actions`, `login-gate-actions`, `conn-actions`,
 *  `options-actions`, `signout-export-actions`, etc. Every variant is
 *  some combination of:
 *    - flex row with gap
 *    - left/right/center/space-between alignment
 *    - optional top border separating it from the panel body
 *    - occasional leading text (e.g. "Are you sure?")
 *
 *  One primitive with two enum props (`align`, `variant`) absorbs them
 *  all. Callers pass already-rendered button strings (usually via the
 *  `button()` primitive) plus any extra leading content.
 */

export type ActionBarAlign = 'start' | 'end' | 'between' | 'center';

export interface ActionBarProps {
  /** Pre-rendered children (buttons or any markup). Rendered in order. */
  children: string[];
  /** Horizontal alignment. Defaults to `start`. */
  align?: ActionBarAlign;
  /** Show a top border separating the bar from the panel above. */
  bordered?: boolean;
  /** Gap between items in pixels. Defaults to 8. */
  gap?: 4 | 6 | 8 | 10 | 12;
  /** Extra class tokens (kept for legacy callers that need the old
   *  feature-specific class to style layout around the bar). */
  extraClass?: string;
}

export const actionBar = (props: ActionBarProps): string => {
  const align = props.align ?? 'start';
  const gap = props.gap ?? 8;
  const classes = [
    'rx-action-bar',
    `rx-action-bar-${align}`,
    `rx-action-bar-gap-${gap}`,
  ];
  if (props.bordered) classes.push('rx-action-bar-bordered');
  if (props.extraClass) classes.push(props.extraClass);
  return `<div class="${classes.join(' ')}">${props.children.join('')}</div>`;
};

export const ACTION_BAR_STYLES = `
.rx-action-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
}
.rx-action-bar-start   { justify-content: flex-start; }
.rx-action-bar-end     { justify-content: flex-end; }
.rx-action-bar-center  { justify-content: center; }
.rx-action-bar-between { justify-content: space-between; }

.rx-action-bar-gap-4   { gap: 4px; }
.rx-action-bar-gap-6   { gap: 6px; }
.rx-action-bar-gap-8   { gap: 8px; }
.rx-action-bar-gap-10  { gap: 10px; }
.rx-action-bar-gap-12  { gap: 12px; }

.rx-action-bar-bordered {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
`;
