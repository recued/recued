import { isToolProgress, type ToolProgress } from '@recued/contracts';

/** A progress token belongs to one in-flight request. Invalid, repeated and
 * regressing observations do not prove progress. Provider prose is not exposed. */
export const createMcpProgressReceiver = (
  token: string | number,
  report: ((progress: ToolProgress) => void) | undefined,
): ((params: unknown) => void) => {
  let previous = -1;
  return (params) => {
    if (!report || params === null || typeof params !== 'object' || Array.isArray(params)) return;
    const row = params as Record<string, unknown>;
    if (row.progressToken !== token) return;
    const progress = { kind: 'provider', current: row.progress,
      ...(row.total === undefined ? {} : { total: row.total }) };
    if (!isToolProgress(progress) || progress.current <= previous) return;
    previous = progress.current;
    try { report(progress); } catch { /* observability only */ }
  };
};

export const withMcpProgressToken = (params: unknown, token: number): Record<string, unknown> => {
  const row = params !== null && typeof params === 'object' && !Array.isArray(params)
    ? params as Record<string, unknown> : {};
  const meta = row._meta !== null && typeof row._meta === 'object' && !Array.isArray(row._meta)
    ? row._meta as Record<string, unknown> : {};
  return { ...row, _meta: { ...meta, progressToken: token } };
};
