/** Explicit export projection. Never serialize a frame or scrape panel text:
 * either can contain identities, URLs or private error payloads. */
import { BRIDGE_CONFIRMED_INSPECTION_LIMIT, confirmedErrorMetadata, isUncertainBridgeErrorCode, type BridgeIdempotencyScope } from '../idempotency/cache.js';
import type { SidePanelDiagnosticFrame } from './store/local-store.js';

const validCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const count = (value: unknown): string => validCount(value) ? String(value) : 'Unavailable';
const timestamp = (value: number): string =>
  Number.isFinite(value) && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : 'Unavailable';

export const formatDiagnosticSummary = (frame: SidePanelDiagnosticFrame, opts: {
  bridgeVersion?: string;
  createdAt: number;
}): string => {
  // Chrome manifest versions contain one to four numeric components. Reject
  // arbitrary strings rather than exporting a URL or injected extra lines.
  const version = typeof opts.bridgeVersion === 'string' && opts.bridgeVersion.trim() === opts.bridgeVersion
    && /^\d{1,5}(?:\.\d{1,5}){0,3}$/.test(opts.bridgeVersion)
    ? opts.bridgeVersion : 'Unavailable';
  const complete = validCount(frame.idempotency_entry_count) && validCount(frame.pending_command_count)
    && typeof frame.queue_paused === 'boolean' && validCount(frame.grant_count)
    && frame.unresolved !== null && frame.recent_confirmed !== null;
  const refresh = frame.refreshing ? 'Refreshing' : frame.refresh_error !== null ? 'Incomplete'
    : frame.last_successful_refresh_at === null ? 'Not yet refreshed' : complete ? 'Ready' : 'Incomplete';
  const lines = [
    'Recued Bridge diagnostic summary (v1)',
    `Bridge version: ${version}`,
    `Summary created at: ${timestamp(opts.createdAt)}`,
    `Last successful refresh: ${frame.last_successful_refresh_at === null ? 'Never' : timestamp(frame.last_successful_refresh_at)}`,
    `Refresh state: ${refresh}`,
    `Saved command results: ${count(frame.idempotency_entry_count)}`,
    `Awaiting confirmation: ${count(frame.unresolved?.count)}`,
    `Queued commands: ${count(frame.pending_command_count)}`,
    `Current command present: ${typeof frame.queue_paused !== 'boolean' ? 'Unavailable' : frame.current_command_id === null ? 'No' : 'Yes'}`,
    `Queue state: ${typeof frame.queue_paused !== 'boolean' ? 'Unavailable' : frame.queue_paused ? 'Paused' : 'Ready'}`,
    `Ingredient grants: ${count(frame.grant_count)}`,
  ];
  const confirmed = frame.recent_confirmed;
  if (confirmed === null) lines.push('Recent confirmed outcomes: Unavailable');
  else {
    const entries = confirmed.entries.slice(0, BRIDGE_CONFIRMED_INSPECTION_LIMIT)
      .filter(entry => (entry.status === 'ok' || entry.status === 'error' || entry.status === 'rejected')
        && !isUncertainBridgeErrorCode(entry.error_code));
    const codes = new Map<string, number>();
    let withoutCode = 0;
    for (const entry of entries) {
      if (entry.status === 'ok') continue;
      const code = confirmedErrorMetadata(entry.status, entry.error_code).error_code;
      if (code) codes.set(code, (codes.get(code) ?? 0) + 1);
      else withoutCode++;
    }
    lines.push(
      `Recent confirmed outcome sample: ${entries.length} of ${count(confirmed.count)}`,
      `Sample completed: ${entries.filter(entry => entry.status === 'ok').length}`,
      `Sample failed: ${entries.filter(entry => entry.status === 'error').length}`,
      `Sample rejected: ${entries.filter(entry => entry.status === 'rejected').length}`,
      `Sample failure codes: ${[...codes].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([code, n]) => `${code}=${n}`).join(', ') || 'None'}`,
      `Sample failures without a known code: ${withoutCode}`,
    );
  }
  return lines.join('\n');
};

export interface DiagnosticSummaryCopyState {
  phase: 'idle' | 'copying' | 'copied' | 'manual';
  /** Only the allowlisted summary, retained for the manual-copy fallback. */
  summary: string;
}

/** A stable guard across refresh renders. Clipboard writes start in the click
 * stack to preserve user activation; failures never echo platform error text. */
export const createDiagnosticSummaryCopy = (deps: {
  getSummary(): string;
  getScope(): BridgeIdempotencyScope | null;
  canCopy(): boolean;
  writeText?(text: string): Promise<void>;
  apply(state: DiagnosticSummaryCopyState): void;
}) => {
  let generation = 0, pending = false, disposed = false;
  let state: DiagnosticSummaryCopyState = { phase: 'idle', summary: '' };
  const apply = (next: DiagnosticSummaryCopyState): void => { state = next; deps.apply(next); };
  const scopeKey = (): string | null => {
    const scope = deps.getScope();
    return scope === null ? null : JSON.stringify([scope.server_public_key, scope.token_id]);
  };
  return {
    async copy(): Promise<void> {
      if (disposed || !deps.canCopy() || state.phase === 'copying') return;
      const request = ++generation, scope = scopeKey(), summary = deps.getSummary();
      const finish = (next: DiagnosticSummaryCopyState): void => {
        if (disposed || request !== generation) return;
        // A click can occur after identity invalidation but before its
        // storage read finishes. The paired flag can stay true throughout.
        // Compare identities again even when no later invalidation arrived.
        apply(deps.canCopy() && scope === scopeKey() ? next : { phase: 'idle', summary: '' });
      };
      // A timed-out write cannot be cancelled. Offer manual copying while it
      // remains pending instead of starting an overlapping clipboard write.
      if (!deps.writeText || pending) { apply({ phase: 'manual', summary }); return; }
      pending = true;
      apply({ phase: 'copying', summary: '' });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const writing = (async () => deps.writeText!(summary))().finally(() => { pending = false; });
        await Promise.race([writing, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Clipboard write timed out')), 5_000);
        })]);
        finish({ phase: 'copied', summary: '' });
      } catch {
        finish({ phase: 'manual', summary });
      } finally { if (timer !== undefined) clearTimeout(timer); }
    },
    invalidate(): void {
      generation++;
      if (!disposed) apply({ phase: 'idle', summary: '' });
    },
    dispose(): void { disposed = true; generation++; },
  };
};
