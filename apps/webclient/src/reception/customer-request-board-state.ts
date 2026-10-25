import { QUOTE_SIGNOFF_SEARCH_MAX, QUOTE_SIGNOFF_STATES, type QuoteSignoffState } from '@recued/contracts';

/** Navigation metadata only. Draft fields and bearer URLs never belong here. */
export interface CustomerCompletionBoardState {
  filter: 'all' | 'review'; cursor?: string; previous: Array<string | undefined>;
  expanded: string[]; returnId?: string; returnAction?: string;
}
export interface CustomerRequestBoardState {
  scope: string; hash: string; search: string; state?: QuoteSignoffState; signoffId?: string;
  cursor?: string; previous: Array<string | undefined>;
  scrollTop: number; expanded: string[]; returnId?: string; returnAction?: string;
  completion?: CustomerCompletionBoardState; returnBoard?: 'requests' | 'completions';
}
export const readCustomerRequestBoardState = (value: unknown, scope: string, hash: string): CustomerRequestBoardState | undefined => {
  if (!value || typeof value !== 'object') return;
  const v = value as Record<string, unknown>;
  const short = (s: unknown, max: number): s is string => typeof s === 'string' && s.length <= max;
  const cursor = (s: unknown): s is string | undefined => s === undefined || short(s, 2048);
  if (v.scope !== scope || v.hash !== hash || !short(v.search, QUOTE_SIGNOFF_SEARCH_MAX)
    || v.state !== undefined && !QUOTE_SIGNOFF_STATES.includes(v.state as QuoteSignoffState)
    || !cursor(v.cursor) || !Array.isArray(v.previous) || v.previous.length > 100 || !v.previous.every(cursor)
    || v.signoffId !== undefined && (!short(v.signoffId, 128) || !v.signoffId || !!v.search || v.state !== undefined || v.cursor !== undefined || v.previous.length > 0)
    || typeof v.scrollTop !== 'number' || !Number.isFinite(v.scrollTop) || v.scrollTop < 0
    || !Array.isArray(v.expanded) || v.expanded.length > 100 || !v.expanded.every(s => short(s, 256))
    || v.returnId !== undefined && !short(v.returnId, 128) || v.returnAction !== undefined && !short(v.returnAction, 512)
    || v.returnBoard !== undefined && v.returnBoard !== 'requests' && v.returnBoard !== 'completions') return;
  let completion: CustomerCompletionBoardState | undefined;
  if (v.completion !== undefined) {
    if (!v.completion || typeof v.completion !== 'object') return;
    const c = v.completion as Record<string, unknown>;
    if (c.filter !== 'all' && c.filter !== 'review' || !cursor(c.cursor)
      || !Array.isArray(c.previous) || c.previous.length > 100 || !c.previous.every(cursor)
      || !Array.isArray(c.expanded) || c.expanded.length > 100 || !c.expanded.every(s => short(s, 256))
      || c.returnId !== undefined && !short(c.returnId, 128) || c.returnAction !== undefined && !short(c.returnAction, 512)) return;
    completion = { filter: c.filter, cursor: c.cursor, previous: [...c.previous], expanded: [...c.expanded],
      returnId: c.returnId as string | undefined, returnAction: c.returnAction as string | undefined };
  }
  return { scope, hash, search: v.search, state: v.state as QuoteSignoffState | undefined,
    signoffId: v.signoffId as string | undefined, cursor: v.cursor, previous: [...v.previous], scrollTop: v.scrollTop, expanded: [...v.expanded],
    returnId: v.returnId as string | undefined, returnAction: v.returnAction as string | undefined,
    ...(completion ? { completion } : {}), ...(v.returnBoard ? { returnBoard: v.returnBoard as 'requests' | 'completions' } : {}) };
};
