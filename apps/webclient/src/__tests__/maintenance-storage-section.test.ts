/** Server ▸ Maintenance renders the storage read-out and can reclaim.
 *
 *  ⛔ WHY HERE. R25 defines this tab as ops/status, and it already lists the
 *  tasks that RECLAIM these surfaces — audit compaction, cache GC. Until now
 *  you could see "audit compaction ran 20 min ago" and had no way to tell
 *  whether it helped: `used_bytes` reached every client on `server.getStatus`
 *  and the heartbeat, and nothing rendered it.
 *
 *  ⚠ `server.runPressureReclaim` had NO client caller at all. It is the
 *  `[Reclaim now]` this tab was missing.
 *
 *  ⛔ THE COMPOSITION SEAM IS TESTED SEPARATELY at the bottom. A panel test
 *  proves the panel renders when handed callers; it says nothing about whether
 *  anything HANDS it those callers — which is the failure mode that ships an
 *  inert feature with a green suite. */

import { describe, expect, it, vi } from 'vitest';

import {
  MAINTENANCE_STORAGE_ATTR,
  mountMaintenancePanel,
} from '../settings/maintenance-panel-mount.js';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

const STATUS = {
  tasks: [
    {
      meta: { id: 'audit-compaction', description: 'x', kind: 'core', tags: [] },
      state: 'idle',
      last_run_at: null,
    },
  ],
} as unknown as Awaited<ReturnType<() => Promise<{ tasks: unknown[] }>>>;

const pressure = () => ({
  pressure_details: {
    worst_state: 'pressure_managed' as const,
    per_surface: [
      { surface: 'audit', state: 'running' as const, used_bytes: 100 * MB, quota_bytes: 5 * GB, pct: 2 },
      { surface: 'cache', state: 'pressure_managed' as const, used_bytes: 180 * MB, quota_bytes: 200 * MB, pct: 90 },
    ],
  },
});

/** ⚠ Captures the click listener the mount installs, so the tests drive the
 *  REAL handler rather than a re-implementation of it. Same technique as
 *  `server-pill-host.test.ts`. */
const makeHost = () => {
  let onClick: ((ev: unknown) => void) | null = null;
  const el = {
    innerHTML: '',
    setAttribute: () => {},
    removeAttribute: () => {},
    addEventListener: (type: string, fn: (ev: unknown) => void) => {
      if (type === 'click') onClick = fn;
    },
    removeEventListener: () => {},
    querySelectorAll: () => [] as unknown as ArrayLike<HTMLElement>,
    querySelector: () => null,
    contains: () => false,
    ownerDocument: { activeElement: null },
  };
  return {
    el: el as unknown as HTMLElement,
    click: (action: string, surface?: string) => {
      onClick?.({
        target: {
          closest: () => ({
            getAttribute: (name: string) =>
              name === 'data-action' ? action
                : name === 'data-surface' ? (surface ?? null)
                  : null,
          }),
        },
        preventDefault: () => {},
      });
    },
  };
};

/** The storage section only — so an assertion cannot accidentally match the
 *  header copy, which mentions "audit compaction" ABOVE the table. That is
 *  exactly what made the first ordering assertion fail against correct code. */
const storageSection = (html: string): string => {
  const i = html.indexOf(MAINTENANCE_STORAGE_ATTR);
  return i === -1 ? '' : html.slice(i);
};

const mount = (over: Record<string, unknown> = {}) => {
  const host = makeHost();
  const m = mountMaintenancePanel({
    host: host.el,
    runStatusRead: vi.fn(async () => STATUS) as never,
    runServerStatus: vi.fn(async () => pressure()),
    now: () => 1_000_000,
    ...over,
  } as never);
  return { host: host.el, click: host.click, m };
};

describe('Server ▸ Maintenance — storage read-out', () => {
  it('⛔ renders each surface, most-constrained first', async () => {
    const { host, m } = mount();
    await m.whenLoaded();
    const html = host.innerHTML;
    expect(html).toContain(MAINTENANCE_STORAGE_ATTR);
    expect(html).toContain('5.00 GB');
    expect(html).toContain('(90%)');
    // cache (90%) must precede audit (2%) — scoped to the section, because the
    // tab's own header copy mentions "audit compaction" further up the page.
    const section = storageSection(html);
    expect(section.indexOf('cache')).toBeLessThan(section.indexOf('audit'));
    m.dispose();
  });

  it('renders NO storage section when the status caller is absent', async () => {
    // Absence reads as absence — not an empty "Storage" heading, which would
    // look like a server holding nothing.
    const { host, m } = mount({ runServerStatus: undefined });
    await m.whenLoaded();
    expect(host.innerHTML).not.toContain(MAINTENANCE_STORAGE_ATTR);
    expect(host.innerHTML).toContain('Maintenance'); // the tab DID render
    m.dispose();
  });

  it('⛔ a failing storage read does NOT blank the maintenance table', async () => {
    // The tasks are this tab's primary content and they loaded fine. A storage
    // failure that emptied the page would trade a missing read-out for a
    // missing tab.
    const { host, m } = mount({
      runServerStatus: vi.fn(async () => { throw new Error('nope'); }),
    });
    await m.whenLoaded();
    expect(host.innerHTML).toContain('Maintenance');
    expect(host.innerHTML).not.toContain(MAINTENANCE_STORAGE_ATTR);
    expect(host.innerHTML).not.toContain('nope'); // not surfaced as a page error
    m.dispose();
  });

  it('shows Reclaim now only when the caller is wired — button AND copy', async () => {
    // ⚠ Asserted on the ACTION ATTRIBUTE, not the label. The first version
    // matched the string "Reclaim now" and failed against correct code,
    // because the section's own summary sentence contained it — which also
    // meant the read-only view PROMISED a button it never rendered. The copy
    // is now conditional too, and both halves are pinned here.
    const readOnly = mount();
    await readOnly.m.whenLoaded();
    expect(readOnly.host.innerHTML).toContain(MAINTENANCE_STORAGE_ATTR);
    expect(readOnly.host.innerHTML).not.toContain('maintenance-storage-reclaim');
    expect(readOnly.host.innerHTML).not.toContain('Reclaim now');
    readOnly.m.dispose();

    const actionable = mount({
      runReclaim: vi.fn(async () => ({ ran: true, bytes_freed: 0 })),
    });
    await actionable.m.whenLoaded();
    expect(actionable.host.innerHTML).toContain('maintenance-storage-reclaim');
    expect(actionable.host.innerHTML).toContain('Reclaim now');
    actionable.m.dispose();
  });

  it('⛔ reports freed bytes, and RE-READS usage afterwards', async () => {
    // Re-reading is the point: a reclaim that freed space and left a stale
    // number on screen is indistinguishable from one that did nothing.
    const runServerStatus = vi.fn(async () => pressure());
    const runReclaim = vi.fn(async () => ({ ran: true, bytes_freed: 40 * MB }));
    const { host, click, m } = mount({ runServerStatus, runReclaim });
    await m.whenLoaded();
    const before = runServerStatus.mock.calls.length;

    click('maintenance-storage-reclaim', 'cache');
    await new Promise((r) => setTimeout(r, 0));

    expect(runReclaim).toHaveBeenCalledWith({ surface: 'cache' });
    expect(runServerStatus.mock.calls.length).toBeGreaterThan(before);
    expect(host.innerHTML).toContain('freed 40.0 MB');
    m.dispose();
  });

  it('⛔ "ran: false" reads as DECLINED, not as space freed', async () => {
    // The server debounces one reclaim per surface per window. Reporting a
    // declined attempt as success would tell the owner space was reclaimed
    // when nothing ran.
    const runReclaim = vi.fn(async () => ({ ran: false, bytes_freed: 0 }));
    const { host, click, m } = mount({ runReclaim });
    await m.whenLoaded();
    click('maintenance-storage-reclaim', 'cache');
    await new Promise((r) => setTimeout(r, 0));
    expect(host.innerHTML).toContain('already ran recently');
    expect(host.innerHTML).not.toContain('freed');
    m.dispose();
  });

  it('a FAILED reclaim shows its error on the row, not as a page error', async () => {
    const runReclaim = vi.fn(async () => { throw new Error('gate halted'); });
    const { host, click, m } = mount({ runReclaim });
    await m.whenLoaded();
    click('maintenance-storage-reclaim', 'audit');
    await new Promise((r) => setTimeout(r, 0));
    expect(host.innerHTML).toContain(MAINTENANCE_STORAGE_ATTR); // still rendered
    expect(host.innerHTML).toMatch(/gate halted/i);
    m.dispose();
  });

});

describe('⛔ the composition seam — the route HANDS the panel its callers', () => {
  it('bootstrap builds both callers and forwards them', () => {
    // A panel that renders when handed callers proves nothing about whether
    // anything supplies them. This asserts the two ends by SOURCE, which is
    // what the type system alone cannot: an optional prop nobody passes
    // typechecks perfectly and ships an inert feature.
    const fs = require('node:fs') as typeof import('node:fs');
    const bootstrap = fs.readFileSync(
      new URL('../webclient-bootstrap.ts', import.meta.url), 'utf8',
    );
    const route = fs.readFileSync(
      new URL('../settings/bootstrap-settings-route.ts', import.meta.url), 'utf8',
    );

    // Built from the real rpcs…
    expect(bootstrap).toMatch(/maintenanceServerStatusCaller[\s\S]{0,200}server\.getStatus/);
    expect(bootstrap).toMatch(
      /maintenanceReclaimCaller[\s\S]{0,240}server\.runPressureReclaim/,
    );
    // …passed to the route…
    expect(bootstrap).toMatch(/maintenanceServerStatusCaller !== undefined/);
    expect(bootstrap).toMatch(/maintenanceReclaimCaller !== undefined/);
    // …and forwarded by the route into the mount.
    expect(route).toMatch(/runServerStatus: opts\.maintenanceServerStatusCaller/);
    expect(route).toMatch(/runReclaim: opts\.maintenanceReclaimCaller/);
  });
});
