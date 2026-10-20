import type { SituationCluster, SituationItem } from '@recued/contracts';

/** Clock schedules own their reminders, including when the shared query has
 * replaced a rule fact with its canonical commitment. Names and dates never
 * establish that two records are the same obligation. */
export const selectDayOfClusterItems = (
  items: readonly SituationItem[],
  isRuleCommitment: (id: string) => boolean,
): readonly SituationItem[] | null => {
  if (!items.length) return null;
  const ownsReminder = (item: SituationItem): boolean => {
    const { collection, id, field } = item.ref;
    if (collection === 'commitment') return field === undefined && item.kind === 'commitment' && isRuleCommitment(id);
    if (!field?.startsWith('rules.') || field.length === 'rules.'.length) return false;
    return collection === 'asset' && item.kind === 'asset_rule'
      || collection === 'occasion' && (item.kind === 'occasion' || item.kind === 'occasion_rule');
  };
  const owned = items.map(ownsReminder);
  if (!owned.some(Boolean)) return items;
  // A related label alone adds no reason to interrupt. A separate due item,
  // collision, missing fact or derived travel check can carry the clock as
  // context. The clock remains available in Today and the overview either way.
  const reason = items.find((item, index) => !owned[index] && (item.kind === 'travel_validity'
    || item.reasons.some(reason => reason === 'due' || reason === 'collides' || reason === 'missing')));
  // Keep the independent reason when high-ranked clocks fill the item cap.
  return reason ? [reason, ...items.filter(item => item !== reason)] : null;
};

export const shouldSendDayOfCluster = (cluster: SituationCluster, isRuleCommitment: (id: string) => boolean): boolean =>
  selectDayOfClusterItems(cluster.items, isRuleCommitment) !== null;
