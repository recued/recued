/** Read-only rendering for immutable file-artifact output cards.
 *
 *  This shared renderer has no paired-client RPC, so it deliberately exposes
 *  metadata and inert action labels only. The Recipes result host owns the
 *  authenticated preview/download interaction and rechecks the returned file
 *  identity before opening bytes.
 */

import { renderBlockEmpty, renderBlockError } from './block-error.js';
import { renderBlockLabel } from './label.js';
import { e } from './escape.js';
import { renderActionInline } from './action.js';
import type { RenderContext } from './types.js';

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const nonEmptyString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

const displayBytes = (value: unknown): string =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? `${value.toLocaleString('en-US')} bytes`
    : 'Unknown size';

const displayTime = (value: unknown): string => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Unknown time';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown time' : date.toISOString();
};

/** ⚠ The file-artifact descriptor is SERVER-DERIVED (see `OutputType`) — the
 *  recipe author says *"show this file"*, and the file substrate decides what
 *  the descriptor carries. So the internals below are not the author's choice
 *  and are not theirs to expose: `record_id` is a warehouse row id,
 *  `template.filename` the owner's template,
 *  `generation_mode` a detail of their pipeline. In the owner's own panel these
 *  are useful context. In front of an anonymous visitor they are leaked plumbing
 *  — and the host note is an instruction to open a panel that visitor has no
 *  account for.
 *
 *  `audience: 'public'` drops exactly those. What remains is everything ABOUT
 *  THE VISITOR'S OWN FILE — title, filename, type, size, SHA-256 (a buyer's
 *  integrity check), when it was generated, their own submission reference and
 *  their own payment status. Nothing the recipe chose to say is withheld. */
const renderOneFileArtifact = (value: unknown, context: RenderContext = {}): string => {
  const row = asRecord(value);
  const recordId = nonEmptyString(row?.record_id);
  const filename = nonEmptyString(row?.filename);
  const mimeType = nonEmptyString(row?.mime_type);
  const sha256 = nonEmptyString(row?.sha256);
  if (row === null || recordId === null || filename === null || mimeType === null || sha256 === null) {
    return renderBlockError('file_artifact', 'invalid exact-file descriptor');
  }
  const isPublic = context.audience === 'public';
  const origin = asRecord(row.origin);
  const payment = asRecord(row.payment);
  const template = asRecord(row.template);
  const title = nonEmptyString(row.title) ?? filename;
  const action = row.approval_action === undefined
    ? ''
    : `<div class="file-artifact-action">${renderActionInline(row.approval_action, context)}</div>`;
  const decisions = Array.isArray(row.decision_actions)
    ? row.decision_actions
      .map((decision) => `<div class="file-artifact-action">${renderActionInline(decision, context)}</div>`)
      .join('')
    : '';
  // The record id doubles as the card's ref attribute; on a public surface the
  // card carries no ref at all rather than a blank one.
  const ref = isPublic ? '' : ` data-file-artifact-ref="${e(recordId)}"`;
  const ownerOnlyRows = isPublic
    ? ''
    : `${nonEmptyString(row.generation_mode) !== null
          ? `<dt>Generation mode</dt><dd>${e(nonEmptyString(row.generation_mode)!)}</dd>`
          : ''}
        ${nonEmptyString(template?.filename) !== null
          ? `<dt>Template</dt><dd>${e(nonEmptyString(template?.filename)!)}</dd>`
          : ''}`;
  const hostNote = isPublic
    ? ''
    : '<p class="file-artifact-host-note">Authenticated preview/download is available in the Recipes result panel.</p>';
  return `
    <article class="file-artifact-card"${ref}>
      <h4>${e(title)}</h4>
      <dl>
        <dt>File</dt><dd>${e(filename)}</dd>
        <dt>Type</dt><dd>${e(mimeType)}</dd>
        <dt>Size</dt><dd>${e(displayBytes(row.size_bytes))}</dd>
        <dt>SHA-256</dt><dd><code>${e(sha256)}</code></dd>
        <dt>Generated</dt><dd>${e(displayTime(row.generated_at))}</dd>
        ${ownerOnlyRows}
        ${nonEmptyString(origin?.submission_id) !== null
          ? `<dt>Response</dt><dd>${e(nonEmptyString(origin?.submission_id)!)}</dd>`
          : ''}
        ${nonEmptyString(payment?.status) !== null
          ? `<dt>Payment</dt><dd>${e(nonEmptyString(payment?.status)!)}</dd>`
          : ''}
      </dl>
      ${hostNote}
      ${action}
      ${decisions}
    </article>
  `;
};

export const renderFileArtifactBlock = (data: unknown, context: RenderContext = {}, label?: string): string => {
  if (data === null || data === undefined) return renderBlockEmpty('file_artifact');
  const values = Array.isArray(data) ? data : [data];
  if (values.length === 0) return renderBlockEmpty('file_artifact');
  return `<div class="block file-artifact-block" data-file-mode="read-only">${renderBlockLabel(label)}${values.map((v) => renderOneFileArtifact(v, context)).join('')}</div>`;
};
