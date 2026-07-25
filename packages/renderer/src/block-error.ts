/** Terminal row templates for malformed or empty section data.
 *
 *  Renderers call these when the input fails their shape contract
 *  (e.g. a table block with no columns, or a summary block with a
 *  non-object data value). The output never throws — every
 *  ill-formed block shows up as a readable failure row. */

import { e } from './escape.js';

export const renderBlockEmpty = (kind: string): string =>
  `<div class="block block-empty">No ${e(kind)} data.</div>`;

export const renderBlockError = (kind: string, msg: string): string =>
  `<div class="block block-error">${e(kind)}: ${e(msg)}</div>`;
