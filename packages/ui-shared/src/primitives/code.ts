/** Code primitives.
 *
 *  Inline `<code>` snippets (instance IDs, URLs, handles) and
 *  multi-line `<pre>` blocks (recovery key, exported bundle preview).
 *  Both use self-scoped classes with their own background so the look
 *  is consistent whether they're inside a flash, a form row, or a
 *  table cell.
 */

import { e } from '../template.js';

export const code = (text: string): string =>
  `<code class="rx-code">${e(text)}</code>`;

export const codeBlock = (text: string): string =>
  `<pre class="rx-code-block">${e(text)}</pre>`;

export const CODE_STYLES = `
.rx-code {
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 11px;
  background: var(--bg-code, var(--surface-sunk));
  color: var(--fg);
  padding: 1px 5px;
  border-radius: 3px;
  word-break: break-all;
}
.rx-code-block {
  display: block;
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 12px;
  background: var(--bg-code, var(--surface-sunk));
  color: var(--fg);
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 4px;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 6px 0;
}
`;
