import type Database from 'better-sqlite3';
import { createAssetOccurrenceStore, type AssetOccurrence } from '../storage/asset-occurrence-store.js';
import { createOccurrenceReminderStore } from '../storage/occurrence-reminder-store.js';
import type { ProactiveHistoryStore } from '../storage/proactive-history-store.js';
import type { ProactiveProposalStore } from '../storage/proactive-proposal-store.js';
import type { WorkEntityStore } from '../storage/work-entity-store.js';
import { completionQuestionKey, lastDoneQuestionKey } from './owner-completion.js';

export interface ClockRetentionDeps {
  db: Database.Database;
  work: Pick<WorkEntityStore, 'readCommitment' | 'readAssetEffective'>;
  history: Pick<ProactiveHistoryStore, 'occasion'>;
  proposals: Pick<ProactiveProposalStore, 'byKey'>;
}
/** Each clock cycle keeps what a reader can still use. A clock counts its cycles
 * from its newest one, which stays. A finished cycle is the occurrence service's
 * record of what it sent and heard: its readers are done with it once nothing
 * waits on it and it has not changed for `before`. A cycle the owner confirmed
 * done is the learner's service history, which it reads for its lookback, so only
 * its send log goes until then. */
export const createClockRetention = (deps: ClockRetentionDeps) => {
  const rows = createAssetOccurrenceStore(deps.db); const points = createOccurrenceReminderStore(deps.db);
  const has = (table: string): boolean => !!deps.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  const clock = (row: AssetOccurrence): string => JSON.stringify([row.subject_kind ?? 'asset', row.asset_id, row.rule_id, row.commitment_id ? 'action' : 'notice']);
  const clockExists = (row: AssetOccurrence): boolean => {
    if (row.subject_kind === 'occasion') return !!deps.history.occasion(row.asset_id)?.rules.some(rule => rule.id === row.rule_id);
    const asset = deps.work.readAssetEffective(row.asset_id);
    return !!asset && asset.deleted_at == null && asset.rules.some(rule => rule.id === row.rule_id);
  };
  return {
    prune(input: { before: number; lookback: number }): { close_events: number; projections: number; services: number; cycles: number; cycle_logs: number } {
      if (!Number.isSafeInteger(input.before) || !Number.isSafeInteger(input.lookback)) throw new Error('Invalid clock retention');
      const result = { close_events: rows.pruneDelivered(), projections: 0, services: rows.pruneServices(input.lookback), cycles: 0, cycle_logs: 0 };
      // The occasion clock's own outbox and Home Assistant's withdrawn items: delivered, or already removed there.
      const occasionEvents = has('proactive_occasion_close_events'); const projections = has('household_ha_projections');
      const reminders = has('reminders') && (deps.db.prepare('PRAGMA table_info(reminders)').all() as { name: string }[]).some(column => column.name === 'clock_occurrence_id');
      if (occasionEvents) result.close_events += deps.db.prepare('DELETE FROM proactive_occasion_close_events WHERE delivered=1').run().changes;
      if (projections) result.projections = deps.db.prepare("DELETE FROM household_ha_projections WHERE json_extract(value,'$.withdrawn')=1").run().changes;
      const waiting = (id: string): boolean => rows.undelivered(id) || points.open(id)
        || occasionEvents && !!deps.db.prepare('SELECT 1 FROM proactive_occasion_close_events WHERE id=?').get(id)
        || projections && !!deps.db.prepare('SELECT 1 FROM household_ha_projections WHERE occurrence_id=?').get(id)
        || reminders && !!deps.db.prepare("SELECT 1 FROM reminders WHERE clock_occurrence_id=? AND state='pending'").get(id)
        || [completionQuestionKey(id), lastDoneQuestionKey(id)].some(key => deps.proposals.byKey(key)?.state === 'proposed');
      const all = rows.all(); const newest = new Map<string, string>();
      for (const row of all) newest.set(clock(row), row.id);
      for (const row of all) {
        if (newest.get(clock(row)) === row.id && clockExists(row)) continue;
        const commitment = row.commitment_id ? deps.work.readCommitment(row.commitment_id) : null;
        if (commitment && commitment.deleted_at == null && commitment.lifecycle_state === 'pending') continue;
        const touched = Math.max(rows.lastActivity(row.id), points.lastActivity(row.id) ?? 0, commitment?.lifecycle_changed_at ?? 0);
        if (touched >= input.before || waiting(row.id)) continue;
        const completion = rows.completion(row.id);
        deps.db.transaction(() => {
          const dropped = points.dropLog(row.id);
          if (completion?.owner_action === true && completion.known !== false && touched >= input.lookback) { if (dropped) result.cycle_logs++; return; }
          rows.remove(row.id); result.cycles++;
        })();
      }
      return result;
    },
  };
};
export type ClockRetention = ReturnType<typeof createClockRetention>;
