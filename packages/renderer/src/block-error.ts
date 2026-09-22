/** Terminal row templates for malformed or empty section data.
 *
 *  Renderers call these when the input fails their shape contract
 *  (e.g. a table block with no columns, or a summary block with a
 *  non-object data value). The output never throws — every
 *  ill-formed block shows up as a readable failure row. */

import { e } from './escape.js';

export const renderBlockEmpty = (kind: string): string =>
  `<div class="block block-empty">No ${e(kind)} data.</div>`;

/** A collection that came back EMPTY — which is not the same as a block that could not
 *  be drawn.
 *
 *  ⛔⛔ D-282 B3 — `renderBlockEmpty` served both, so a table with no ROWS and a table
 *  with no COLUMNS produced the identical sentence, "No table data." One is a first-run
 *  moment for a business app; the other is a broken block. A reader cannot tell them
 *  apart, and neither can the author debugging it.
 *
 *  ⚠ IT DOES NOT PLURALISE THE ENTITY. `building` → "buildings" is easy and
 *  `company` → "companys", `person` → "persons" are wrong, and the entity keys are the
 *  pack author's, not a vocabulary this file controls. "records" is the plural instead,
 *  which is grammatical after any noun. */
export const renderEmptyCollection = (entity?: string): string => {
  const human = entity === undefined || entity.trim() === ''
    ? undefined
    : entity.replace(/[._]/g, ' ').trim();
  return `<div class="block block-empty">${
    human === undefined ? 'Nothing here yet.' : `No ${e(human)} records yet.`
  }</div>`;
};

export const renderBlockError = (kind: string, msg: string): string =>
  `<div class="block block-error">${e(kind)}: ${e(msg)}</div>`;
