/** Copyable block — a text payload with an inline Copy button.
 *
 *  When the data is an object with a `content` field, the content
 *  is lifted out; anything else serialises via `JSON.stringify`. The
 *  button exposes `data-action="copy"` / `data-value="<text>"` for
 *  the caller (sidebar, import preview) to bind clipboard logic on.
 *
 *  `context.interactive === false` drops the Copy button — used by
 *  Kitchen preview and import-preview surfaces that render a
 *  read-only snapshot of the block without click handlers wired. */

import { e } from './escape.js';
import { renderBlockEmpty } from './block-error.js';
import type { RenderContext } from './types.js';

export const renderCopyableBlock = (
  data: unknown,
  label?: string,
  context?: RenderContext,
): string => {
  if (data === null || data === undefined) return renderBlockEmpty('copyable');
  const text = typeof data === 'string' ? data
    : typeof data === 'object' && data !== null && 'content' in data
      ? String((data as { content: unknown }).content)
      : JSON.stringify(data);
  // Attribute values need the same full HTML escaping as visible text. Escaping
  // only quote delimiters lets entity-looking source text (`&quot;`, `&amp;`)
  // decode during HTML parsing, changing what the Copy button writes.
  const copyValue = e(text);
  const button = context?.interactive === false
    ? ''
    : `<button type="button" class="copy-btn" data-action="copy" data-value="${copyValue}" title="Copy to clipboard">Copy</button>`;
  return `
    <div class="block copyable-block">
      ${label ? `<div class="copyable-label">${e(label)}</div>` : ''}
      <div class="copyable-content">
        <pre>${e(text)}</pre>
        ${button}
      </div>
    </div>
  `;
};
