/** What a record that ends a paused run without resuming it keeps from the
 *  paused record: the owner's deny (`preflight-resumer`), the approval's expiry
 *  (`checkpoint-retention`) and an abandoned peer hold (`peer-hold-abandoner`).
 *
 *  A run keeps one record (`AuditLog.append` replaces by run id), so the ending
 *  record REPLACES the paused one, and a field it does not carry is gone. The
 *  three writers each listed their own fields and had drifted apart: none kept
 *  what the run spent (D-250) or the connections it used (D-320), two dropped
 *  its dish, and one dropped its contract snapshot and chat sessions. This is
 *  the one list for all three.
 *
 *  It keeps two kinds of field: what links the run (its dish, process, sessions,
 *  contract), and what the run did before it paused (what it produced and spent,
 *  the connections it used, the programs it started under Warn), which only the
 *  paused record knows, because nothing ran after the pause.
 *
 *  ⚠ `buildAuditEntry` is an enumerating copier too: a field added here must be
 *  one it names, or it is dropped there instead.
 *
 *  Two other writers end a paused run the other way round: they pass the whole
 *  paused record and clear its pause fields (`peer-ask-delivery-recovery.ts`,
 *  `preflight-boot-sweep.ts`), which keeps a field nobody listed. This list
 *  keeps only what is named, field by field. */

import { aggregateTokenUsageReports, type TokenUsageReport } from '@recued/contracts';
import type { AuditEntry, AuditEntryInput } from '@recued/storage';

type CarriedFromPausedRun = Pick<AuditEntryInput,
  | 'dish_id' | 'recipe_insight_id' | 'backfill' | 'process_id' | 'run_mode'
  | 'execution_source' | 'contract_snapshot' | 'channel_session_id'
  | 'cognition_session_id' | 'correlation_id'
  | 'run_yield' | 'total_usage' | 'connections_used' | 'untested_tools'>;

export const carriedFromPausedRun = (anchor: AuditEntry): CarriedFromPausedRun => ({
  ...(anchor.dish_id !== undefined ? { dish_id: anchor.dish_id } : {}),
  ...(anchor.recipe_insight_id !== undefined
    ? { recipe_insight_id: anchor.recipe_insight_id }
    : {}),
  ...(anchor.backfill ? { backfill: anchor.backfill } : {}),
  ...(anchor.process_id ? { process_id: anchor.process_id } : {}),
  ...(anchor.run_mode ? { run_mode: anchor.run_mode } : {}),
  ...(anchor.execution_source ? { execution_source: anchor.execution_source } : {}),
  ...(anchor.contract_snapshot ? { contract_snapshot: anchor.contract_snapshot } : {}),
  ...(anchor.channel_session_id ? { channel_session_id: anchor.channel_session_id } : {}),
  ...(anchor.cognition_session_id
    ? { cognition_session_id: anchor.cognition_session_id }
    : {}),
  ...(anchor.correlation_id ? { correlation_id: anchor.correlation_id } : {}),
  // What the run did before it paused.
  // D-237 — what it produced. Presence-checked: an all-zero yield is a fact.
  ...(anchor.run_yield !== undefined ? { run_yield: anchor.run_yield } : {}),
  // D-250 — what it spent. Absent means no provider call, so it stays absent.
  ...(anchor.total_usage !== undefined ? { total_usage: anchor.total_usage } : {}),
  // D-320 §3.5 — the connection each slot settled on.
  ...(anchor.connections_used !== undefined && anchor.connections_used.length > 0
    ? { connections_used: anchor.connections_used }
    : {}),
  // D-321 — the programs it started under Warn at an untested version.
  ...(anchor.untested_tools !== undefined && anchor.untested_tools.length > 0
    ? { untested_tools: anchor.untested_tools }
    : {}),
});

/** The record a resumed run is about to replace, or undefined when there is none
 *  (a run whose id was minted before it started has no record yet) or it cannot
 *  be read. ⚠ A failed read loses what only that record knew, never the run's
 *  record: it is read just before that record is written, inside its guard. */
export const readPausedRecord = async (
  log: { get(runId: string): Promise<AuditEntry | null | undefined> },
  runId: string,
): Promise<AuditEntry | undefined> => {
  try {
    return (await log.get(runId)) ?? undefined;
  } catch {
    return undefined;
  }
};

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

const isUsageReport = (value: unknown): value is TokenUsageReport => {
  if (value === null || typeof value !== 'object') return false;
  const report = value as Record<string, unknown>;
  return isCount(report.input_tokens) && isCount(report.output_tokens)
    && isCount(report.total_tokens)
    && ['provider_calls', 'cache_read_input_tokens', 'cache_write_input_tokens', 'reasoning_tokens']
      .every((key) => report[key] === undefined || isCount(report[key]));
};

/** D-250 — what a resumed run spent in all: the paused record's total, which
 *  holds what it spent before it paused (taken from the sink when that record
 *  was written), plus what `taken` holds for this part. A stored total that is
 *  not a usage report counts as none. */
export const resumedRunUsage = (
  paused: AuditEntry | undefined,
  taken: TokenUsageReport | undefined,
): TokenUsageReport | undefined => {
  const before = paused?.total_usage;
  return isUsageReport(before) ? aggregateTokenUsageReports(before, taken) : taken;
};
