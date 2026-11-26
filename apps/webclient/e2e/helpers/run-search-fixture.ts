import { expect, type Page } from '@playwright/test';
import type { ExecutionGetResponse, ExecutionSearchRequest, ExecutionSearchResponse, RunFeedRow } from '@recued/contracts';
import { FIXED_NOW, HARNESS_URL } from './full-app.js';
type Reply = { result?: unknown; error?: { code: string; message: string } };
interface RunSearchFixture {
  rows: RunFeedRow[]; calls: Array<{ method: string; args: unknown }>; held: string[]; failing: string[]; unsupported: boolean; ignoreFilters: boolean;
  pending(method: string): number; release(method: string): void;
  substitutions: Record<string, string>;
  searchPages: ExecutionSearchResponse[];
}
declare global { interface Window { __runSearch: RunSearchFixture } }
export const runResults = (page: Page) => page.getByRole('region', { name: 'Run history search results', exact: true });
export const runQuery = (page: Page) => page.getByRole('searchbox', { name: 'Search everything', exact: true });
export const runType = (page: Page) => page.getByRole('combobox', { name: 'Result type', exact: true });
export const runHit = (page: Page, id: string) => runResults(page).locator(`[data-search-run-id="${id}"]`);
export const runHits = (page: Page) => runResults(page).locator('[data-search-run-id]');
export const runNotice = (page: Page) => runResults(page).locator('[data-search-run-focus]');
export const moreRuns = (page: Page) => runResults(page).getByRole('button', { name: /^(Search|Retry) older runs$/ });
export const refreshRuns = (page: Page) => runResults(page).getByRole('button', { name: 'Refresh run history', exact: true });
export const runOutcome = (page: Page) => runResults(page).getByRole('combobox', { name: 'Run outcome', exact: true });
export const runTime = (page: Page) => runResults(page).getByRole('combobox', { name: 'Run start time', exact: true });
export const findRuns = async (page: Page, query = 'follow-up') => {
  await runQuery(page).fill(query); await runType(page).selectOption('run'); await expect(runResults(page)).toHaveAttribute('aria-busy', 'false');
};
export const openRunSearch = async (page: Page, options: { width?: number; count?: number; pageSize?: number; sparse?: boolean; unsupported?: boolean } = {}) => {
  await page.setViewportSize({ width: options.width ?? 1280, height: 900 }); await page.clock.setFixedTime(FIXED_NOW);
  await page.addInitScript(({ now, options }) => {
    const rows: RunFeedRow[] = Array.from({ length: options.count ?? 4 }, (_, index) => ({
      run_id: 'run-' + index, recipe_id: index === 3 ? 'billing' : 'customer-followup',
      name: index === 3 ? 'Billing statement' : 'Customer follow-up', started_at: now - 1000 * (index + 1),
      finished_at: now - 1000 * (index + 1) + 20, duration_ms: 20, status: index === 1 ? 'failed' : index === 2 ? 'in_doubt' : 'succeeded',
      origin: { actor: 'user_self', label: 'user_self' }, policy_result: 'allowed', links: [],
      ...(index === 0 ? { run_yield: { steps_run: 1, steps_skipped: 0, items_total: 5, items_failed: 2, stopped_at: null } } : {}),
      ...(index === 1 ? { error_category: 'timeout' } : {}),
    }));
    const waiting = new Map<string, Array<() => void>>();
    const fixture: RunSearchFixture = { rows, calls: [], held: [], failing: [], unsupported: !!options.unsupported, ignoreFilters: false,
      substitutions: {},
      searchPages: [],
      pending: method => waiting.get(method)?.length ?? 0,
      release(method) { const callbacks = waiting.get(method) ?? []; if (!callbacks.length) throw Error('No pending ' + method); waiting.delete(method); callbacks.forEach(fn => fn()); },
    };
    const fold = (value: string) => value.normalize('NFKC').toLowerCase().replace(/ς/gu, 'σ');
    const reply = (method: string, raw: unknown): Reply | undefined => {
      if (fixture.failing.includes(method)) return { error: { code: 'unavailable', message: 'Run history is temporarily unavailable.' } };
      if (method === 'execution.search') {
        if (fixture.unsupported) return { error: { code: 'unknown_method', message: 'Unknown rpc method: execution.search' } };
        const args = raw as ExecutionSearchRequest;
        const filters = fixture.ignoreFilters ? undefined : args.filters;
        const ack = filters ? { applied_filters: filters } : {};
        if (fixture.searchPages.length) return { result: { ...ack, ...fixture.searchPages.shift()! } };
        if (options.sparse && !args.cursor) return { result: { runs: [], ...ack, next_cursor: { last_event_at: now, last_run_id: 'sparse-boundary' } } };
        const terms = fold(args.query).split(/\s+/u).filter(Boolean);
        const matches = fixture.rows.filter(row => {
          const outcome = row.status === 'in_doubt' ? 'unknown' : row.status === 'awaiting_approval' ? 'waiting-owner'
            : row.status === 'failed' && row.error_category !== 'killed' && row.error_category !== 'cancelled_before_dispatch' ? 'failed'
            : row.status === 'succeeded' && row.run_yield && row.run_yield.items_total > 0 && row.run_yield.items_failed === row.run_yield.items_total ? 'refused'
            : row.status === 'succeeded' && row.run_yield && row.run_yield.items_failed > 0 ? 'partial' : 'other';
          return terms.every(term => fold(row.run_id + ' ' + row.recipe_id + ' ' + row.name).includes(term))
            && (!filters?.outcome || outcome === filters.outcome)
            && (filters?.started_from === undefined || row.started_at >= filters.started_from)
            && (filters?.started_before === undefined || row.started_at < filters.started_before);
        });
        const offset = !args.cursor || args.cursor.last_run_id === 'sparse-boundary' ? 0 : matches.findIndex(row => row.run_id === args.cursor?.last_run_id) + 1;
        const runs = matches.slice(offset, offset + (options.pageSize ?? 2)), last = runs.at(-1);
        return { result: { runs, ...ack, ...(last && offset + runs.length < matches.length ? { next_cursor: { last_event_at: last.started_at, last_run_id: last.run_id } } : {}) } };
      }
      if (method === 'execution.get') {
        const requested = (raw as { run_id: string }).run_id;
        const row = fixture.rows.find(row => row.run_id === (fixture.substitutions[requested] ?? requested));
        if (!row) return { error: { code: 'not_found', message: 'Run is no longer available.' } };
        const result: ExecutionGetResponse = { run: { audit: { ...row, recipe_hash: 'fixture-hash', trigger_source: 'manual', instance_id: 'fixture-server', errors: [] },
          approvals: { checkpoints: [] }, errors: [], links: [], gateway: { policy_result: row.policy_result, per_call_trace: [] } } };
        return { result };
      }
      if (method === 'execution.list') return { result: { runs: fixture.rows } };
      if (method === 'execution.active') return { result: { entries: [], lanes: [] } };
      if (method === 'collection.contract.session_grant.list') return { result: { grants: [] } };
      if (method === 'recipe.list') return { result: { recipes: [{ recipe_id: 'customer-followup', name: 'Customer follow-up' }, { recipe_id: 'billing', name: 'Billing statement' }] } };
      return undefined;
    };
    Object.assign(window, { __runSearch: fixture, __connectionsFixture: async (method: string, raw: unknown): Promise<Reply | undefined> => {
      fixture.calls.push({ method, args: raw });
      if (fixture.held.includes(method)) await new Promise<void>(resolve => waiting.set(method, [...(waiting.get(method) ?? []), resolve]));
      return reply(method, raw);
    } });
  }, { now: FIXED_NOW, options });
  await page.goto(`${HARNESS_URL}?settle_reads=1&journey=verification#data/search`); await page.waitForFunction(() => window.__app?.ready === true);
  await expect(runQuery(page)).toBeVisible();
};
