/** Passive display data from an executing tool. No provider prose, results,
 * credentials or authority ride this surface. Totals are optional, never guessed. */
export interface ToolProgress {
  kind: 'steps' | 'provider';
  current: number;
  total?: number;
}

export const TOOL_PROGRESS_INTERVAL_MS = 5_000;

export const isToolProgress = (value: unknown): value is ToolProgress => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (row.kind === 'steps' || row.kind === 'provider')
    && typeof row.current === 'number' && Number.isFinite(row.current) && row.current >= 0
    && (row.total === undefined || typeof row.total === 'number'
      && Number.isFinite(row.total) && row.total >= row.current && row.total > 0);
};

export const formatToolProgress = (progress: ToolProgress): string => {
  const amount = progress.total === undefined
    ? `${progress.current}` : `${progress.current} of ${progress.total}`;
  return progress.kind === 'steps' ? `Recipe steps: ${amount}` : `Tool progress: ${amount}`;
};
