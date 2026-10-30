/** Owner list settings. The same filters apply to rows and totals before paging. */
export const COMMITMENT_VIEW_DIRECTIONS = ['all', 'outbound', 'inbound', 'internal'] as const;
export const COMMITMENT_VIEW_STATUSES = ['all', 'open', 'overdue', 'closed'] as const;
export interface CommitmentViewFilters {
  direction: typeof COMMITMENT_VIEW_DIRECTIONS[number];
  status: typeof COMMITMENT_VIEW_STATUSES[number];
}
export const DEFAULT_COMMITMENT_VIEW_FILTERS: Readonly<CommitmentViewFilters> = { direction: 'all', status: 'all' };

export const parseCommitmentViewFilters = (value: unknown): CommitmentViewFilters | null => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).length !== 2 || !Object.hasOwn(fields, 'direction') || !Object.hasOwn(fields, 'status')) return null;
  const direction = COMMITMENT_VIEW_DIRECTIONS.find(item => item === fields.direction);
  const status = COMMITMENT_VIEW_STATUSES.find(item => item === fields.status);
  return direction === undefined || status === undefined ? null : { direction, status };
};
