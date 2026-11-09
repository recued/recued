import type Database from 'better-sqlite3';
import { assetConditionHolds, type Asset, type AssetUpdateInput, type Commitment } from '@recued/contracts';
import type { WorkEntityStore } from '../storage/work-entity-store.js';
import { createAssetOccurrenceStore } from '../storage/asset-occurrence-store.js';
import { AssetReminderOpenError, RenewalDateRequiredError } from '../work-entity-ingredients.js';
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
      `“${commitment.statement}” is done once its new date is entered. Enter it under Yours → Due.`,
      { asset_id: asset.id, asset_name: asset.name, field: rule.when.field });
  };
};

/** D-343 ruling 16 (2026-11-06) — an AI's write of a date that a thing's open reminder reads is
 * refused before it writes, and names the reminder to keep instead. The owner's approved write
 * of the date is theirs, but it is an edit: the reminder it replaces closes as cancelled, where
 * keeping it records the date (`processClose`) and closes it as kept. Live, a model that kept the
 * reminder also wrote the date, 5 of 5 times, and the date ran first. A date no open reminder
 * reads, an unchanged one, and a renewal's expiry (its new date keeps it, D-325 §5.1) pass. */
export const createReminderDateGuard = (db: Database.Database, work: WorkEntityStore) => {
  const rows = createAssetOccurrenceStore(db);
  return (asset: Asset, dates: AssetUpdateInput['dates']): void => {
    if (!dates) return;
    for (const rule of asset.rules) {
      if (!rule.enabled || rule.when.kind !== 'interval' || rule.reaction.occurrence !== 'action') continue;
      const field = rule.when.field;
      if (!Object.hasOwn(dates, field) || dates[field] === asset.dates[field]) continue;
      for (const row of rows.byAsset(asset.id)) {
        if (row.rule_id !== rule.id || !row.commitment_id) continue;
        const reminder = work.readCommitment(row.commitment_id);
        if (reminder?.lifecycle_state === 'pending') throw new AssetReminderOpenError({ commitment_id: reminder.id, statement: reminder.statement, field });
      }
    }
  };
};

/** D-343 slice 1 — the condition a reminder stands for, while it still holds: a recall still open,
 *  a battery still low. The chat keeps such a reminder by clearing the condition, which records
 *  it on the thing and closes the reminder kept (`processClose`), rather than leaving the thing
 *  saying "Present". Today's Done is not asked. `null` for any other commitment. */
export const createConditionReminderLookup = (db: Database.Database, work: WorkEntityStore, now: () => number = Date.now) => {
  const rows = createAssetOccurrenceStore(db);
  return (commitment: Commitment): { asset_id: string; asset_name: string; field: string } | null => {
    const row = rows.byCommitment(commitment.id);
    if (!row || row.subject_kind === 'occasion') return null;
    const asset = work.readAsset(row.asset_id);
    const rule = asset?.rules.find((item) => item.id === row.rule_id);
    if (!asset || rule?.when.kind !== 'condition' || !assetConditionHolds(asset.observations[rule.when.field], now())) return null;
    return { asset_id: asset.id, asset_name: asset.name, field: rule.when.field };
  };
};
