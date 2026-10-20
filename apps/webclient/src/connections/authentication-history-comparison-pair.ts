import { AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES } from '@recued/contracts';
import type { AuthenticationHistoryComparison, ComparableHistorySnapshot } from './authentication-history-comparison.js';

export const AUTHENTICATION_HISTORY_COMPARISON_PAIR_FORMAT = 'recued.connection-history.comparison' as const;
export interface PreparedAuthenticationHistoryComparisonPair {
  readonly filename: string; readonly json: string; readonly bytes: number;
  readonly pair: {
    readonly format: typeof AUTHENTICATION_HISTORY_COMPARISON_PAIR_FORMAT; readonly version: 1;
    readonly baseline: ComparableHistorySnapshot['report']; readonly comparison: ComparableHistorySnapshot['report'];
  };
}

/** Keep both complete checked reports in their selected order. Derived rows,
 * source filenames and transient view state are recomputed or omitted. */
export const prepareAuthenticationHistoryComparisonPair = (capture: AuthenticationHistoryComparison): PreparedAuthenticationHistoryComparisonPair => {
  const pair = Object.freeze({ format: AUTHENTICATION_HISTORY_COMPARISON_PAIR_FORMAT, version: 1 as const,
    baseline: capture.baseline.report, comparison: capture.comparison.report });
  const json = JSON.stringify(pair), bytes = new TextEncoder().encode(json).byteLength;
  if (bytes > AUTHENTICATION_HISTORY_EXPORT_MAX_BYTES) throw new Error('The complete comparison pair must fit within 8 MiB.');
  const stamp = (side: 'baseline' | 'comparison'): string => new Date(capture[side].report.exported_at).toISOString().replace(/[:.]/g, '-');
  return Object.freeze({ filename: 'recued-history-comparison-pair-baseline-' + stamp('baseline') + '-comparison-' + stamp('comparison') + '.json', json, bytes, pair });
};
