/** Why an update was reverted, as the closed code `update.operation_status`
 *  sends (`UpdateRevertReason` in `@recued/contracts`).
 *
 *  ⛔ THE TYPED FIELD WINS. Every writer of a terminal that reverts an update
 *  sets `revert_reason`. The legacy arm below reads the cause from `detail` only
 *  for rows written before the field existed, and its prose is FROZEN: it is
 *  what those releases wrote, so rewording a writer's `detail` must never touch
 *  it. Same rule as `recovery_source`: owner-facing meaning must not hang on
 *  text a writer is free to reword.
 *
 *  ⚠ A row a NEWER binary wrote can carry a code this one does not know (an
 *  older binary reads the same ledger after a rollback). It reads as `other`
 *  rather than reaching the wire as a value the type says cannot exist. */

import { UPDATE_REVERT_REASONS, type UpdateRevertReason } from '@recued/contracts';

import type { UpdateLedgerEntry } from './update-ledger.js';

const KNOWN: ReadonlySet<string> = new Set(UPDATE_REVERT_REASONS);

/** The `detail` prose that releases up to 26.10.25 wrote, by cause. Frozen. */
const legacyRevertReason = (entry: UpdateLedgerEntry): UpdateRevertReason => {
  // Structural first: a refusal row and a supervisor's revert say what they are.
  if (entry.kind === 'operation_refused') return 'not_started';
  if (entry.recovery_source === 'outer-supervisor') return 'new_version_failed';
  const detail = entry.detail ?? '';
  if (detail.startsWith('supervisor revert: ') || detail.startsWith('auto-revert: ')) {
    return 'new_version_failed';
  }
  // `download: …` and `download (native addon): …`; `verify: …` likewise.
  if (detail.startsWith('download')) return 'download_failed';
  if (detail.startsWith('verify')) return 'verify_failed';
  if (detail.startsWith('stage: the realm was not quiesced at commit time')) return 'drain_incomplete';
  // The snapshot's own refusal of a realm another process still had open.
  if (detail.includes('survived the close, so this realm is still open somewhere')) return 'database_in_use';
  if (detail.startsWith('stage: ')) return 'install_failed';
  if (detail === 'staging aborted (crash before swap)') return 'interrupted';
  return 'other';
};

export const updateRevertReason = (entry: UpdateLedgerEntry): UpdateRevertReason => {
  const typed: unknown = entry.revert_reason;
  if (typeof typed === 'string') {
    return KNOWN.has(typed) ? typed as UpdateRevertReason : 'other';
  }
  return legacyRevertReason(entry);
};
