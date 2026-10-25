import type Database from 'better-sqlite3';
import type { Commitment } from '@recued/contracts';
import type { WorkEntityStore } from '../storage/work-entity-store.js';
import { createAssetOccurrenceStore } from '../storage/asset-occurrence-store.js';
import { RenewalDateRequiredError } from '../work-entity-ingredients.js';
import { assetRenewal } from './asset-rule-timing.js';

/** D-325 §15.7 (2026-10-24) — no close marks a renewal done while its asset still holds
 * the task's own date: not the owner's Done in Today, Data or Due, and not an AI's or a
 * recipe's close. Such a Done closed the task and kept the old date, so the clock that
 * would have reminded again went quiet. A renewal, a moved date and a proof write the
 * later date first, so their closes pass. */
export const createRenewalFulfillGuard = (db: Database.Database, work: WorkEntityStore) => {
  const rows = createAssetOccurrenceStore(db);
  return (commitment: Commitment): void => {
    const row = rows.byCommitment(commitment.id);
    if (!row || row.subject_kind === 'occasion') return;
    const asset = work.readAsset(row.asset_id);
    const rule = asset?.rules.find(item => item.id === row.rule_id);
    if (!asset || !rule || assetRenewal(asset, rule)?.current !== row.cycle) return;
    throw new RenewalDateRequiredError(commitment.id, commitment.lifecycle_state,
      `“${commitment.statement}” is done once its new date is entered. Enter it under Yours → Due.`);
  };
};
