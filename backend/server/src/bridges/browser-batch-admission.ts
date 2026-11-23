/** D-335 slice X — how a batch (`core.dom.act`) was let through without an ask, so it opens no tab
 *  its admission did not cover.
 *
 *  A batch that only reads, scrolls, waits and points asks nothing, and a pass lets a batch through
 *  when it covers every site the batch acts on or opens a tab on (the pass seam in
 *  `execute-handler.ts`). Both decide on the tabs open at that moment. A tab that closes before its
 *  step runs would make the batch open a new one, which nothing approved: so the admission records
 *  which sites it may open a tab on, and the run (`dom-adapter.ts`) reads it back.
 *
 *  A batch held and approved carries `preflight_admitted` and opens what its ask listed. One the
 *  gateway admitted with no ask to stand in for (the owner's own policy, or an exact session
 *  grant) has no admission here and opens as before: the owner chose that. So does one a
 *  pre-approval let through (D-402 ruling 18): an "Always" covers opening a page at an address the
 *  run finds as it goes, within its recipe's sites.
 *
 *  In memory, for a few minutes: the run reads it as it starts, right after the gateway admitted
 *  it. Keyed by the run and the call's page and steps, so another call of the same run never reads
 *  this one's. */

import { canonicalJSONStringify } from '@recued/crypto/canonical-json';

/** What an admission lets a batch open: a new tab on any site (an approval stands in), or on these
 *  sites only (by origin, as a pass names one); none for a batch let through because it only reads. */
export type BrowserBatchAdmission = { readonly open: 'any' } | { readonly open: ReadonlySet<string> };

export interface BrowserBatchAdmissions {
  record(run_id: string, input: unknown, admission: BrowserBatchAdmission): void;
  read(run_id: string, input: unknown): BrowserBatchAdmission | undefined;
}

/** How long an admission is kept: the run reads it within moments of the gateway's decision. */
export const BROWSER_BATCH_ADMISSION_TTL_MS = 10 * 60_000;

const keyOf = (run_id: string, input: unknown): string => {
  const call = input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  return `${run_id}|${canonicalJSONStringify({ page: call.page ?? null, steps: call.steps ?? null, bridge_id: call.bridge_id ?? null })}`;
};

export const createBrowserBatchAdmissions = (now: () => number = Date.now): BrowserBatchAdmissions => {
  const kept = new Map<string, { admission: BrowserBatchAdmission; at: number }>();
  const sweep = () => {
    const before = now() - BROWSER_BATCH_ADMISSION_TTL_MS;
    for (const [key, entry] of kept) if (entry.at < before) kept.delete(key);
  };
  return {
    record(run_id, input, admission) {
      sweep();
      kept.set(keyOf(run_id, input), { admission, at: now() });
    },
    read(run_id, input) {
      sweep();
      return kept.get(keyOf(run_id, input))?.admission;
    },
  };
};

/** The process's admissions, as the page read store is the process's: one server, one owner. */
export const browserBatchAdmissions: BrowserBatchAdmissions = createBrowserBatchAdmissions();
