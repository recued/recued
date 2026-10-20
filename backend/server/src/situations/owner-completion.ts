import type Database from 'better-sqlite3';
import type { Commitment } from '@recued/contracts';
import type { WorkEntityStore } from '../storage/work-entity-store.js';
import { createAssetOccurrenceStore } from '../storage/asset-occurrence-store.js';

/** What Yours asks the owner about one cycle: a completion's actual date, and the
 * last-done date a new clock needs. Retention keeps a cycle while either is open. */
export const completionQuestionKey = (occurrence_id: string): string => `completion:${occurrence_id}`;
export const lastDoneQuestionKey = (occurrence_id: string): string => `last-done:${occurrence_id}`;

/** Selected by the host after owner authentication, never from ingredient
 * input. A failed canonical write leaves no receipt for a later AI close. */
export const createOwnerCompletionWriter = (db: Database.Database, work: WorkEntityStore) => {
  const rows = createAssetOccurrenceStore(db);
  return (prior: Commitment, at: number, write: () => Commitment): Commitment => db.transaction(() => {
    const result = write();
    const row = rows.byCommitment(prior.id);
    if (!row) return result;
    const asset = row.subject_kind === 'occasion' ? null : work.readAssetEffective(row.asset_id);
    const rule = asset?.rules.find(rule => rule.id === row.rule_id);
    const usage = rule?.when.kind === 'objective' && rule.when.mode === 'usage' ? rule.when : null;
    const reading = usage && asset ? work.assetReadingAt(asset.id, usage.field, at) : null;
    rows.recordCompletion(row.id, at, reading, !row.question && (!usage || reading !== null), true);
    return result;
  })();
};
