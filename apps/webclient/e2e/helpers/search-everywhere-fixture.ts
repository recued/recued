import type { Page } from '@playwright/test';

/** Wrap the active record fixture after boot so its calendar/note reads and
 * writes keep their normal behavior while global searches can be observed. */
export const installSearchEverywhereFixture = (page: Page) => page.evaluate(() => {
  const previous = (window as unknown as { __connectionsFixture?: (method: string, args: unknown) => unknown }).__connectionsFixture;
  const state = { calls: [] as { method: string; args: Record<string, unknown> }[], holdNext: false, pending: false, release: () => {} };
  Object.assign(window, { __searchEverywhereFixture: state, __connectionsFixture: async (method: string, raw: unknown) => {
    const args = raw as Record<string, unknown> | undefined;
    if (method === 'collection.searchAll' || method === 'work.search') state.calls.push({ method, args: structuredClone(args ?? {}) });
    if (method === 'collection.searchAll') {
      const query = String(args?.query);
      if (state.holdNext) { state.holdNext = false; state.pending = true; await new Promise<void>(done => { state.release = () => { state.pending = false; done(); }; }); }
      return { result: { groups: [{ platform: 'mail', slug: 'inbox', more: false,
        source_freshness: { stale: false, last_success_at: Date.now(), age_ms: 0, degraded: false, pending: 0 },
        matches: [{ record_id: 'global-result', rank: -1, hot_fields: { subject: `Global result for ${query}` } }],
      }] } };
    }
    return previous?.(method, raw);
  } });
});

declare global {
  interface Window {
    __searchEverywhereFixture: {
      calls: { method: string; args: Record<string, unknown> }[];
      holdNext: boolean; pending: boolean; release(): void;
    };
  }
}
