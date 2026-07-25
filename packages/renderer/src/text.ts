/** Text block — plain-string output. Non-string data serialises via
 *  `JSON.stringify`. Empty input renders an empty-state row. */

import { e } from './escape.js';
import { renderBlockEmpty } from './block-error.js';
import { renderBlockLabel } from './label.js';

export const renderTextBlock = (data: unknown, label?: string): string => {
  if (data === null || data === undefined) return renderBlockEmpty('text');
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  return `
    <div class="block text-block">
      ${renderBlockLabel(label)}
      <p>${e(text)}</p>
    </div>
  `;
};
