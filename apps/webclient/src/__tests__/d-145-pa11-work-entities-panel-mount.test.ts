/** D-145 PA11 — `mountWorkEntitiesPanel` tests.
 *
 *  PA11 shipped the renderer + its state + its own render tests, and
 *  **nothing ever mounted it**. `work_entity.source.set_mcp_exposed`
 *  therefore had zero callers, so the per-Source `mcp_exposed` flag —
 *  which boots `false` — could not be flipped by any shipped surface,
 *  and `work.search` / `work.read` returned zero rows to every external
 *  MCP door forever. These tests pin the seam that closes that: a
 *  toggle must reach the rpc, and the panel must never claim a
 *  boundary state the server didn't confirm.
 *
 *  Drives the mount through its real change delegator via the
 *  string-innerHTML fake host (mirrors
 *  `d-145-pa11-llm-result-cache-card-mount.test.ts`). The panel's
 *  controls are checkboxes + a `<select>`, so events are synthesized as
 *  `change` with a `getAttribute`-bearing target, NOT the cache card's
 *  `click` + `closest('[data-action]')` shape.
 *
 *  NB the assertions are on OUTCOMES (the rpc received these args; the
 *  state holds the server's row; the error is user-visible), never on
 *  "a seam was called" — a green test over a hollow seam is what let the
 *  unmounted panel look finished for as long as it did. */

import { describe, expect, it, vi } from 'vitest';

import type { SourceRegistration } from '@recued/contracts';

import {
  mountWorkEntitiesPanel,
  WORK_ENTITIES_PANEL_HOST_ATTR,
  type MountWorkEntitiesPanelOptions,
} from '../settings/work-entities-panel-mount.js';

// ════════════════════════════════════════════════════════════════
// Fake host
// ════════════════════════════════════════════════════════════════

const makeFakeHost = () => {
  let html = '';
  const attrs = new Map<string, string>();
  const listeners: Record<string, Set<(event: Event) => void>> = {};
  const host = {
    get innerHTML() {
      return html;
    },
    set innerHTML(value: string) {
      html = value;
    },
    setAttribute: (k: string, v: string): void => {
      attrs.set(k, v);
    },
    getAttribute: (k: string): string | null => attrs.get(k) ?? null,
    addEventListener: (evt: string, fn: (event: Event) => void): void => {
      (listeners[evt] ??= new Set()).add(fn);
    },
    removeEventListener: (evt: string, fn: (event: Event) => void): void => {
      listeners[evt]?.delete(fn);
    },
  } as unknown as HTMLElement;
  const fire = (evt: string, target: unknown): void => {
    for (const fn of [...(listeners[evt] ?? [])]) {
      fn({ target, type: evt } as unknown as Event);
    }
  };
  return {
    host,
    getHtml: () => html,
    getAttr: (k: string) => attrs.get(k) ?? null,
    listenerCount: () =>
      Object.values(listeners).reduce((n, s) => n + s.size, 0),
    /** Synthesize a checkbox `change` — the shape `source-row.ts` emits. */
    toggle: (action: string, source_id: string, checked: boolean): void => {
      fire('change', {
        checked,
        getAttribute: (name: string) =>
          name === 'data-action'
            ? action
            : name === 'data-source-id'
              ? source_id
              : null,
      });
    },
    /** Synthesize the default-Source `<select>` change. */
    select: (kind: string, value: string): void => {
      fire('change', {
        value,
        getAttribute: (name: string) =>
          name === 'data-action'
            ? 'set-default-source'
            : name === 'data-kind'
              ? kind
              : null,
      });
    },
  };
};

const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

// ════════════════════════════════════════════════════════════════
// Fixtures
// ════════════════════════════════════════════════════════════════

const BUILTIN = 'recued.builtin.task';
const HUBSPOT = 'hubspot.conn-42.task';

/** Distinct field values per Source so a field-confusion bug can't hide
 *  behind a coincidence (`feedback_fixture_value_coincidence`). */
const source = (over: Partial<SourceRegistration> = {}): SourceRegistration => ({
  id: BUILTIN,
  top_tier_kind: 'task',
  source_kind: 'builtin',
  source_label: 'Recued built-in',
  write_capable: true,
  // The REAL boot posture — `work-entity-source-boot.ts` registers false.
  mcp_exposed: false,
  enabled: true,
  registered_at: 1_700_000_000_000,
  ...over,
});

const deps = (
  over: Partial<MountWorkEntitiesPanelOptions> = {},
): MountWorkEntitiesPanelOptions & {
  host: ReturnType<typeof makeFakeHost>;
} => {
  const fake = makeFakeHost();
  const sources = [
    source(),
    source({
      id: HUBSPOT,
      source_kind: 'connection',
      source_label: 'HubSpot Tasks (conn-42)',
    }),
  ];
  return {
    host: fake.host,
    runSourceList: vi.fn(async () => ({
      sources,
      defaults_by_kind: { task: BUILTIN } as Record<string, string>,
    })),
    runSetEnabled: vi.fn(async (args: { source_id: string; enabled: boolean }) => ({
      ok: true as const,
      effective: source({ id: args.source_id, enabled: args.enabled }),
    })),
    runSetMcpExposed: vi.fn(
      async (args: { source_id: string; mcp_exposed: boolean }) => ({
        ok: true as const,
        effective: source({ id: args.source_id, mcp_exposed: args.mcp_exposed }),
      }),
    ),
    runSetDefault: vi.fn(async () => ({ ok: true as const })),
    runClearDefault: vi.fn(async () => ({ ok: true as const, cleared: true })),
    ...over,
  } as never;
};

// ════════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════════

describe('D-145 PA11 — mountWorkEntitiesPanel', () => {
  it('stamps the host attr + loads the Source list on mount', async () => {
    const opts = deps();
    const fake = makeFakeHost();
    const mount = mountWorkEntitiesPanel({ ...opts, host: fake.host });
    await mount.whenLoaded();

    expect(fake.getAttr(WORK_ENTITIES_PANEL_HOST_ATTR)).toBe('');
    expect(opts.runSourceList).toHaveBeenCalledTimes(1);
    const state = mount.getState();
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
    expect(state.sources.map((s) => s.id)).toEqual([BUILTIN, HUBSPOT]);
    expect(state.defaults_by_kind.task).toBe(BUILTIN);
    // The rendered panel actually carries the Sources — not just state.
    expect(fake.getHtml()).toContain('Recued built-in');
    expect(fake.getHtml()).toContain('HubSpot Tasks (conn-42)');
    mount.dispose();
  });

  it('a failed list surfaces a page-level error, not a blank panel', async () => {
    const opts = deps({
      runSourceList: vi.fn(async () => {
        throw new Error('list rpc exploded');
      }),
    });
    const mount = mountWorkEntitiesPanel(opts);
    await mount.whenLoaded();

    const state = mount.getState();
    expect(state.loading).toBe(false);
    expect(state.error).not.toBeNull();
    mount.dispose();
  });

  // ── THE POINT ────────────────────────────────────────────────────
  it('flipping MCP exposed reaches set_mcp_exposed with that source + value', async () => {
    const fake = makeFakeHost();
    const opts = deps();
    const mount = mountWorkEntitiesPanel({ ...opts, host: fake.host });
    await mount.whenLoaded();

    fake.toggle('set-source-mcp-exposed', BUILTIN, true);
    await mount.whenWriteSettled();
    await flush();

    expect(opts.runSetMcpExposed).toHaveBeenCalledTimes(1);
    expect(opts.runSetMcpExposed).toHaveBeenCalledWith({
      source_id: BUILTIN,
      mcp_exposed: true,
    });
    // The post-write row is what the state holds (DD#4) — and ONLY that
    // row: a patch that clobbered its sibling would show up here.
    const state = mount.getState();
    expect(state.sources.find((s) => s.id === BUILTIN)?.mcp_exposed).toBe(true);
    expect(state.sources.find((s) => s.id === HUBSPOT)?.mcp_exposed).toBe(false);
    // Slot dropped once clean → the row renders idle, not stuck pending.
    expect(state.pending_by_source[BUILTIN]).toBeUndefined();
    mount.dispose();
  });

  it('un-flipping MCP exposed sends false (not a bare truthy toggle)', async () => {
    const fake = makeFakeHost();
    const opts = deps();
    const mount = mountWorkEntitiesPanel({ ...opts, host: fake.host });
    await mount.whenLoaded();

    fake.toggle('set-source-mcp-exposed', BUILTIN, false);
    await mount.whenWriteSettled();

    expect(opts.runSetMcpExposed).toHaveBeenCalledWith({
      source_id: BUILTIN,
      mcp_exposed: false,
    });
    mount.dispose();
  });

  it('a REFUSED exposure keeps the server row + shows the error inline', async () => {
    const fake = makeFakeHost();
    const opts = deps({
      runSetMcpExposed: vi.fn(async () => {
        throw new Error('source refuses MCP exposure');
      }),
    });
    const mount = mountWorkEntitiesPanel({ ...opts, host: fake.host });
    await mount.whenLoaded();

    fake.toggle('set-source-mcp-exposed', BUILTIN, true);
    await mount.whenWriteSettled();
    await flush();

    const state = mount.getState();
    // DD#5 — the row must still read `false`. A panel that painted the
    // box ON here would claim rows leave the house when they do not.
    expect(state.sources.find((s) => s.id === BUILTIN)?.mcp_exposed).toBe(false);
    // DD#6 — per-control error; the page is NOT blanked.
    expect(state.pending_by_source[BUILTIN]?.pending).toBe(false);
    expect(state.pending_by_source[BUILTIN]?.error).toMatch(/refus/i);
    expect(state.error).toBeNull();
    // And the user can actually see it.
    expect(fake.getHtml()).toMatch(/refus/i);
    mount.dispose();
  });

  it('ignores a change for a row whose write is already in flight', async () => {
    const fake = makeFakeHost();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const opts = deps({
      runSetMcpExposed: vi.fn(async (args: { source_id: string; mcp_exposed: boolean }) => {
        await gate;
        return { ok: true as const, effective: source({ id: args.source_id, mcp_exposed: args.mcp_exposed }) };
      }),
    });
    const mount = mountWorkEntitiesPanel({ ...opts, host: fake.host });
    await mount.whenLoaded();

    fake.toggle('set-source-mcp-exposed', BUILTIN, true);
    await flush();
    expect(mount.getState().pending_by_source[BUILTIN]?.pending).toBe(true);
    // A second change while pending must not double-fire the rpc.
    fake.toggle('set-source-mcp-exposed', BUILTIN, false);
    expect(opts.runSetMcpExposed).toHaveBeenCalledTimes(1);

    release();
    await mount.whenWriteSettled();
    await flush();
    expect(opts.runSetMcpExposed).toHaveBeenCalledTimes(1);
    mount.dispose();
  });

  it('the Enabled toggle reaches set_enabled', async () => {
    const fake = makeFakeHost();
    const opts = deps();
    const mount = mountWorkEntitiesPanel({ ...opts, host: fake.host });
    await mount.whenLoaded();

    fake.toggle('set-source-enabled', HUBSPOT, false);
    await mount.whenWriteSettled();

    expect(opts.runSetEnabled).toHaveBeenCalledWith({
      source_id: HUBSPOT,
      enabled: false,
    });
    // The two toggles must not cross-wire.
    expect(opts.runSetMcpExposed).not.toHaveBeenCalled();
    mount.dispose();
  });

  it('picking a Source pins the per-kind default', async () => {
    const fake = makeFakeHost();
    const opts = deps();
    const mount = mountWorkEntitiesPanel({ ...opts, host: fake.host });
    await mount.whenLoaded();

    fake.select('task', HUBSPOT);
    await mount.whenWriteSettled();
    await flush();

    expect(opts.runSetDefault).toHaveBeenCalledWith({
      kind: 'task',
      source_id: HUBSPOT,
    });
    expect(opts.runClearDefault).not.toHaveBeenCalled();
    expect(mount.getState().defaults_by_kind.task).toBe(HUBSPOT);
    mount.dispose();
  });

  it('the empty option CLEARS the default — never a set_default with ""', async () => {
    const fake = makeFakeHost();
    const opts = deps();
    const mount = mountWorkEntitiesPanel({ ...opts, host: fake.host });
    await mount.whenLoaded();

    fake.select('task', '');
    await mount.whenWriteSettled();
    await flush();

    expect(opts.runClearDefault).toHaveBeenCalledWith({ kind: 'task' });
    expect(opts.runSetDefault).not.toHaveBeenCalled();
    expect(mount.getState().defaults_by_kind.task).toBeUndefined();
    mount.dispose();
  });

  it('ignores a change carrying an unknown kind', async () => {
    const fake = makeFakeHost();
    const opts = deps();
    const mount = mountWorkEntitiesPanel({ ...opts, host: fake.host });
    await mount.whenLoaded();

    fake.select('sandwich', BUILTIN);
    await flush();

    expect(opts.runSetDefault).not.toHaveBeenCalled();
    expect(opts.runClearDefault).not.toHaveBeenCalled();
    mount.dispose();
  });

  it('dispose drops the listener + clears the DOM, and is idempotent', async () => {
    const fake = makeFakeHost();
    const opts = deps();
    const mount = mountWorkEntitiesPanel({ ...opts, host: fake.host });
    await mount.whenLoaded();
    expect(fake.listenerCount()).toBe(1);

    mount.dispose();
    expect(fake.listenerCount()).toBe(0);
    expect(fake.getHtml()).toBe('');

    // A post-dispose change must not reach the rpc.
    fake.toggle('set-source-mcp-exposed', BUILTIN, true);
    await flush();
    expect(opts.runSetMcpExposed).not.toHaveBeenCalled();

    expect(() => mount.dispose()).not.toThrow();
  });
});
