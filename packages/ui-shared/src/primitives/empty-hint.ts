/** Empty-state hint primitive.
 *
 *  The "no rows yet" / "nothing configured" paragraph that every list
 *  UI ends up reinventing. Single muted-tone line; callers that want a
 *  richer empty state (icon + body + CTA) should reach for `panel`
 *  instead.
 *
 *  The legacy `empty-hint` class is kept so pre-existing stylesheets
 *  (kitchen.html, sidebar.html) continue to style the paragraph the
 *  same way they did before the primitive existed.
 */

import { e } from '../template.js';

export interface EmptyHintProps {
  /** Plain-text message. Escaped. */
  message: string;
  /** Extra class tokens appended after the primitive classes. */
  extraClass?: string;
}

export const emptyHint = (props: EmptyHintProps): string => {
  const classes = [
    'rx-empty-hint',
    'empty-hint',
    props.extraClass ?? '',
  ].filter(Boolean).join(' ');
  return `<p class="${classes}">${e(props.message)}</p>`;
};

export const EMPTY_HINT_STYLES = `
.rx-empty-hint {
  color: var(--fg-muted, var(--fg));
  opacity: 0.7;
  font-size: 13px;
  margin: 0;
  padding: 8px 0;
}
`;
