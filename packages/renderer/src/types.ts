/** Public types for the recipe output section renderers.
 *
 *  Recipe outputs declare an array of `OutputBlock`; each block has a
 *  `type` (one of `SectionKind`) and a `data` payload whose shape is
 *  determined by the kind. The renderers here convert one block into
 *  HTML and never mutate the input.
 */

import type { OutputType } from '@recued/contracts';

/** The block vocabulary, DERIVED from the recipe contract's `OutputType`.
 *
 *  ⛔ Was a hand-written copy of the same eight kinds — a third source of truth
 *  for one closed list (contracts' union, the recipe validator's Set, and this).
 *  A renderer whose vocabulary silently disagrees with what a recipe may
 *  DECLARE renders `unsupported section type` for a block the validator just
 *  admitted. Derive; never re-type. */
export type SectionKind = OutputType;

/** Who is going to read this HTML.
 *
 *  ⛔ NOT a content filter — the substrate cannot judge whether the data a
 *  recipe put in a `summary` is fit for a stranger; the author chose it and the
 *  owner consented to it at bind. This governs only the chrome THE RENDERER
 *  ITSELF adds, which was written for one audience and is wrong for the other:
 *
 *    - `owner` (default) — the webclient sidebar and Kitchen preview. The
 *      reader owns the server, so internal identifiers (`recipe_id`,
 *      `record_id`) are useful context and copy like *"available in the Recipes
 *      result panel"* is addressed to them.
 *
 *    - `public` — a D-149 reception surface, read by an anonymous visitor. The
 *      same identifiers are internals the visitor's recipe never asked to
 *      show, and that copy is an instruction to a panel they cannot open. Both
 *      are suppressed. Nothing the RECIPE supplied is withheld.
 *
 *  Defaults to `owner` so every existing caller is unchanged. */
export type RenderAudience = 'owner' | 'public';

export interface RenderContext {
  /** Whether the caller wants interactive affordances (copy buttons,
   *  expanders) inside rendered output. Sidebar: true. Kitchen or
   *  import-preview: false. Defaults to true.
   *
   *  ⚠ A reception surface must pass `false`: its CSP is `script-src 'none'`,
   *  so a Copy button there is not merely unstyled, it is DEAD — a control that
   *  cannot do the one thing it advertises. */
  interactive?: boolean;
  /** Who reads the output. See `RenderAudience`. Defaults to `'owner'`. */
  audience?: RenderAudience;
  /** Clock override. When set, renderers that surface relative times
   *  use this instead of `Date.now()`. Tests pass a fixed epoch. */
  now?: number;
}

export interface SummaryData {
  fields: Array<{ label: string; value: unknown }>;
}

export type ChecklistStatus = 'ok' | 'issue' | 'null';

export interface ChecklistData {
  title?: string;
  items: Array<{
    label: string;
    status: ChecklistStatus;
    detail?: string;
    action?: unknown;
    actions?: unknown[];
  }>;
}

export interface TableData {
  columns: Array<{
    field: string;
    label?: string;
    format?: string;
    type?: 'text' | 'action';
  }>;
  rows: unknown[];
}
