/** JSON block — raw structured data from a step result, pretty-printed.
 *
 *  The DETAIL behind a curated `summary` / `table`: what the step actually
 *  produced, shown faithfully and in full. `label` (the authored
 *  `OutputSection.label`) titles it.
 *
 *  ⛔ FAITHFUL, deliberately. `copyable` lifts a `.content` field out of any
 *  object handed to it, so a payload that happens to carry one — a Contentful
 *  entry, a Freshdesk ticket — renders as that ONE field with everything else
 *  silently dropped. A block whose job is "here is the data" must not do that:
 *  what the step produced is what it shows.
 *
 *  ⚠ COLLAPSED is human-only chrome, and costs a model NOTHING. A model reads
 *  `output.render[].data` off the `ExecuteResponse` and never sees this HTML at
 *  all, so `<details>` trades no fidelity for the reader that needs it — it only
 *  keeps a 500-line API dump from burying the curated card in front of a person.
 *
 *  ⚠ NATIVE `<details>`, not a JS expander: a reception surface serves under
 *  `script-src 'none'` (see `RenderContext.interactive`), where a scripted
 *  expander is not merely unstyled but DEAD — a control that cannot do the one
 *  thing it advertises. Native disclosure works identically on every surface,
 *  which is why this renderer needs no `RenderContext`: it adds no chrome that
 *  differs by audience, and it withholds nothing the recipe supplied.
 */

import { e } from './escape.js';
import { renderBlockEmpty, renderBlockError } from './block-error.js';

/** Fallback disclosure title when the section authored no `label`. */
const UNLABELLED = 'Data';

export const renderJsonBlock = (data: unknown, label?: string): string => {
  if (data === null || data === undefined) return renderBlockEmpty('json');

  let json: string | undefined;
  try {
    json = JSON.stringify(data, null, 2);
  } catch {
    // `JSON.stringify` THROWS on a circular structure and on a BigInt. Every
    // other renderer here degrades to a readable row rather than propagating;
    // a block that throws would take down the whole panel — including the
    // curated summary that rendered fine — over one unserialisable payload.
    return renderBlockError('json', 'value is not serialisable');
  }
  // `undefined` back from `stringify` means the payload was a function, a
  // symbol, or literally `undefined` — nothing to show, not an error.
  if (json === undefined) return renderBlockEmpty('json');

  const title = label !== undefined && label.length > 0 ? label : UNLABELLED;
  return `
    <div class="block json-block">
      <details class="json-details">
        <summary class="json-summary">${e(title)}</summary>
        <pre class="json-content">${e(json)}</pre>
      </details>
    </div>
  `;
};
