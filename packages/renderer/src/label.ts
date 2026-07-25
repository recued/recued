/** The section heading — `OutputSection.label`, rendered.
 *
 *  ⛔ ONE COPY, and it belongs to the BLOCK, not the caller. `label` is the only display
 *  field a section has, and for most of this package's history the dispatcher passed it to
 *  exactly two kinds (`copyable`, `json`) and dropped it for the rest. That is the
 *  declared-is-not-backed failure in miniature: 212 shipped sections declare a label —
 *  125 `table`, 56 `summary`, 24 `ai_analysis`, 6 `text`, 1 `file_artifact` — and the
 *  renderer silently ignored every one. The webclient hid the damage behind its own `<h3>`,
 *  so the drop only ever surfaced on a reception page: the same recipe, rendered by the same
 *  package, showed its section titles to the owner and withheld them from a visitor.
 *
 *  ⚠ A CALLER THAT RENDERS ITS OWN HEADING MUST NOT PASS `label`. The webclient result panel
 *  wraps every block in `<article><h3>{sectionTitle}</h3>` and dispatches itself, so it hands
 *  the shared blocks no label — otherwise the authored title prints twice. That is not a
 *  quirk of one surface; it is the rule for any host that owns its own chrome. */

import { e } from './escape.js';

export const renderBlockLabel = (label?: string): string =>
  typeof label === 'string' && label.trim().length > 0
    ? `<h4 class="block-label">${e(label)}</h4>`
    : '';
