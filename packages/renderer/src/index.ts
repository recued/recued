/** `@recued/renderer` — the recipe output section renderers the engine
 *  protocol names (`text`, `summary`, `checklist`, `table`,
 *  `ai_analysis`, `copyable`, `button`, `file_artifact`, `link_button`,
 *  `json`).
 *
 *  ⛔ THIS IS THE ONE BLOCK RENDERER. D-207 slice 2 added the ninth kind and
 *  the reception surfaces as a second consumer, deliberately instead of giving
 *  the public pages a renderer of their own: two renderers for one block is
 *  what D-196 § 4.5 ruled against, and it is how a fence like the `link_button`
 *  href check ends up enforced on one surface and forgotten on the other.
 *
 *  The extension sidebar, the Kitchen recipe-preview surface, and the D-149
 *  reception pages all consume this package; the output contract is identical
 *  so a recipe rendered in any of them produces byte-equivalent HTML. What
 *  differs is `RenderContext` — a reception surface passes
 *  `{ audience: 'public', interactive: false }`, which suppresses the chrome
 *  this renderer adds for an owner (internal ids, panel instructions) and the
 *  controls its CSP (`script-src 'none'`) cannot run. It never withholds
 *  anything a recipe itself supplied.
 *
 *  Pure string templates — no DOM, no side effects, safe for use inside
 *  service workers or node-side test harnesses.
 *
 *  The dispatcher `renderSection(kind, data, ctx?)` routes one block
 *  by kind. Callers that already know the kind (the sidebar's
 *  `renderBlock` switch, the Kitchen preview panels) prefer the
 *  direct named exports for tighter types. */

export { escapeHtml, e } from './escape.js';
export {
  formatValue,
  formatCurrency,
  formatDate,
  formatRelative,
} from './format.js';
export { renderBlockEmpty, renderBlockError } from './block-error.js';
export { renderBlockLabel } from './label.js';
export { renderSummaryBlock } from './summary.js';
export { renderChecklistBlock } from './checklist.js';
export { renderTableBlock } from './table.js';
export { renderAiAnalysisBlock } from './ai-analysis.js';
export { renderTextBlock } from './text.js';
export { renderCopyableBlock } from './copyable.js';
export {
  renderActionGroupInline,
  renderActionInline,
  renderButtonBlock,
} from './action.js';
export { renderFileArtifactBlock } from './file-artifact.js';
export { renderLinkButtonBlock } from './link-button.js';
export { renderJsonBlock } from './json.js';
export {
  renderFilterBlock,
  FILTER_BLOCK_ATTR,
  FILTER_SUBMIT_ATTR,
  FILTER_PAGE_ATTR,
} from './filter.js';
export {
  renderRecordFieldsBlock,
  RECORD_FIELDS_BLOCK_ATTR,
  RECORD_FIELDS_ROW_ATTR,
} from './record-fields.js';
export type {
  SectionKind,
  RenderAudience,
  RenderContext,
  SummaryData,
  ChecklistData,
  ChecklistStatus,
  TableData,
} from './types.js';

import { renderSummaryBlock } from './summary.js';
import { renderChecklistBlock } from './checklist.js';
import { renderTableBlock } from './table.js';
import { isResolvedRecordColumnsDescriptor } from '@recued/contracts';
import { renderAiAnalysisBlock } from './ai-analysis.js';
import { renderTextBlock } from './text.js';
import { renderCopyableBlock } from './copyable.js';
import { renderButtonBlock } from './action.js';
import { renderFileArtifactBlock } from './file-artifact.js';
import { renderLinkButtonBlock } from './link-button.js';
import { renderJsonBlock } from './json.js';
import { renderFilterBlock } from './filter.js';
import { renderRecordFieldsBlock } from './record-fields.js';
import { renderBlockError } from './block-error.js';
import type { SectionKind } from './types.js';

import type { RenderContext } from './types.js';

export interface SectionBlock {
  kind: SectionKind | string;
  data: unknown;
  label?: string;
  /** D-222 host-derived metadata for a resolved filter section. */
  filter?: unknown;
  /** Host-derived metadata for a resolved schema-bound field list. */
  record_fields?: unknown;
  /** Host-derived columns for a `table` that named an entity. Absent on a
   *  hand-written table, which still carries its columns in `data`. */
  record_columns?: unknown;
}

export const renderSection = (
  block: SectionBlock,
  context: RenderContext = {},
): string => {
  switch (block.kind) {
    // `label` reaches EVERY kind that can show a heading. It used to reach two, and the
    // other kinds silently dropped it — see `label.ts`. `button` / `link_button` are
    // excluded on purpose: their labels live per-action inside the data, not on the section.
    case 'summary':     return renderSummaryBlock(block.data, block.label);
    case 'checklist':   return renderChecklistBlock(block.data, block.label);
    case 'table':       return renderTableBlock(block.data, block.label,
      isResolvedRecordColumnsDescriptor(block.record_columns) ? block.record_columns : undefined);
    case 'ai_analysis': return renderAiAnalysisBlock(block.data, block.label);
    case 'text':        return renderTextBlock(block.data, block.label);
    case 'copyable':    return renderCopyableBlock(block.data, block.label, context);
    case 'button':      return renderButtonBlock(block.data, context);
    case 'file_artifact': return renderFileArtifactBlock(block.data, context, block.label);
    case 'link_button': return renderLinkButtonBlock(block.data);
    case 'json':        return renderJsonBlock(block.data, block.label);
    case 'filter':      return renderFilterBlock(block.filter, context, block.label);
    case 'record_fields':
      return renderRecordFieldsBlock(block.record_fields, context, block.label);
    default:            return renderBlockError(String(block.kind), 'unsupported section type');
  }
};
