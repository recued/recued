/** D-137 P2 § A.4 — Scope-search fan-out runner unit tests.
 *
 *  Verifies the pure runner's contract:
 *    - Sequential execution preserves source registration order.
 *    - Per-source throws surface as `partial_failures` entries with
 *      the source id + the error's message; other sources still
 *      contribute their records.
 *    - `isEnabled: () => false` skips the source WITHOUT surfacing
 *      a partial_failure (disabled is an opt-out, not a degradation).
 *    - All-green path omits both `partial` + `partial_failures` so
 *      the result envelope stays minimal.
 *    - `score` per record is preserved on the candidate when set;
 *      non-finite / undefined scores drop. */

import { describe, it, expect } from 'vitest';
import { runScopeSearchFanout, type ScopeSearchSource } from '../scope-search/index.js';

interface Args {
  query: string;
}
interface Row {
  id: string;
  label: string;
}

const buildSource = (
  id: 'local' | 'hubspot' | 'salesforce',
  rows: ReadonlyArray<{ record: Row; score?: number }>,
  opts: { isEnabled?: () => boolean; throws?: string } = {},
): ScopeSearchSource<Args, Row> => ({
  id,
  ...(opts.isEnabled ? { isEnabled: opts.isEnabled } : {}),
  query: async () => {
    if (opts.throws !== undefined) throw new Error(opts.throws);
    return rows;
  },
});

describe('D-137 P2 § A.4 — runScopeSearchFanout', () => {
  it('preserves source order; tags every candidate with source id', async () => {
    const sources: ReadonlyArray<ScopeSearchSource<Args, Row>> = [
      buildSource('local', [{ record: { id: 'l1', label: 'Local 1' } }]),
      buildSource('hubspot', [{ record: { id: 'h1', label: 'HubSpot 1' } }]),
      buildSource('salesforce', [{ record: { id: 's1', label: 'Salesforce 1' } }]),
    ];
    const result = await runScopeSearchFanout({ query: 'x' }, sources);
    expect(result.candidates).toEqual([
      { source: 'local', record: { id: 'l1', label: 'Local 1' } },
      { source: 'hubspot', record: { id: 'h1', label: 'HubSpot 1' } },
      { source: 'salesforce', record: { id: 's1', label: 'Salesforce 1' } },
    ]);
    expect(result.partial).toBeUndefined();
    expect(result.partial_failures).toBeUndefined();
  });

  it('catches per-source throws into partial_failures; other sources still contribute', async () => {
    const sources: ReadonlyArray<ScopeSearchSource<Args, Row>> = [
      buildSource('local', [{ record: { id: 'l1', label: 'Local 1' } }]),
      buildSource('hubspot', [], { throws: 'timeout' }),
    ];
    const result = await runScopeSearchFanout({ query: 'x' }, sources);
    expect(result.candidates).toEqual([
      { source: 'local', record: { id: 'l1', label: 'Local 1' } },
    ]);
    expect(result.partial).toBe(true);
    expect(result.partial_failures).toEqual([{ source: 'hubspot', reason: 'timeout' }]);
  });

  it('skips disabled sources silently (no partial_failure, no candidate)', async () => {
    let hubspotCalled = false;
    const sources: ReadonlyArray<ScopeSearchSource<Args, Row>> = [
      buildSource('local', [{ record: { id: 'l1', label: 'Local 1' } }]),
      {
        id: 'hubspot',
        isEnabled: () => false,
        query: async () => {
          hubspotCalled = true;
          return [];
        },
      },
    ];
    const result = await runScopeSearchFanout({ query: 'x' }, sources);
    expect(hubspotCalled).toBe(false);
    expect(result.candidates).toEqual([
      { source: 'local', record: { id: 'l1', label: 'Local 1' } },
    ]);
    expect(result.partial).toBeUndefined();
    expect(result.partial_failures).toBeUndefined();
  });

  it('preserves finite scores; drops undefined / non-finite scores', async () => {
    const sources: ReadonlyArray<ScopeSearchSource<Args, Row>> = [
      buildSource('local', [
        { record: { id: 'l1', label: 'A' }, score: 0.8 },
        { record: { id: 'l2', label: 'B' } }, // no score
        { record: { id: 'l3', label: 'C' }, score: Number.NaN },
        { record: { id: 'l4', label: 'D' }, score: Number.POSITIVE_INFINITY },
      ]),
    ];
    const result = await runScopeSearchFanout({ query: 'x' }, sources);
    expect(result.candidates[0]?.score).toBe(0.8);
    expect(result.candidates[1]?.score).toBeUndefined();
    expect(result.candidates[2]?.score).toBeUndefined();
    expect(result.candidates[3]?.score).toBeUndefined();
  });

  it('non-Error throws stringify into reason', async () => {
    const sources: ReadonlyArray<ScopeSearchSource<Args, Row>> = [
      {
        id: 'hubspot',
        query: async () => {
          // eslint-disable-next-line @typescript-eslint/no-throw-literal
          throw 'string_reason';
        },
      },
    ];
    const result = await runScopeSearchFanout({ query: 'x' }, sources);
    expect(result.partial).toBe(true);
    expect(result.partial_failures).toEqual([
      { source: 'hubspot', reason: 'string_reason' },
    ]);
  });
});
