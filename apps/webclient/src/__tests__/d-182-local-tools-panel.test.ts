/** D-182 §7.2 — the "Local tools" cli-reachability surface (the contract-first
 *  nested list of per-op toggles).
 *
 *  Verifies the owner-facing surface that projects the per-(principal ×
 *  cli-ingredient × OPERATION) reachability allowlist: contract blocks (Owner
 *  first + expanded, door/agent contracts collapsible with an "N of M granted"
 *  summary), per-op state derivation (on / off — one op = one row, no mixed),
 *  per-op grant/revoke writing exactly ONE `cli.reachability.set`, cross-op
 *  isolation in the UI, the per-contract "Disable all" kill-switch (bulk revoke),
 *  the bulk-vs-op race guard (Codex F3), and partial-failure reconcile (Codex F4).
 *
 *  Uses the same hand-rolled fake DOM as `d-166-contracts-panel.test.ts` (no
 *  jsdom) + a fake server whose `set` mutates an in-memory allowlist that `list`
 *  reflects, so the optimistic→reconcile path is exercised end to end. */

import { describe, expect, it, vi } from 'vitest';

import {
  LOCAL_TOOLS_ASKS_ATTR,
  LOCAL_TOOLS_EMPTY_ATTR,
  LOCAL_TOOLS_ERROR_ATTR,
  LOCAL_TOOLS_KILL_ATTR,
  LOCAL_TOOLS_KILL_CONFIRM_ATTR,
  LOCAL_TOOLS_OP_TOGGLE_ATTR,
  LOCAL_TOOLS_PRINCIPAL_ATTR,
  LOCAL_TOOLS_PRINCIPAL_ERROR_ATTR,
  LOCAL_TOOLS_PRINCIPAL_HEADER_ATTR,
  LOCAL_TOOLS_NOT_READY_ATTR,
  LOCAL_TOOLS_RISK_BADGE_ATTR,
  LOCAL_TOOLS_SUMMARY_ATTR,
  mountLocalToolsPanel,
  type LocalToolsContractsCaller,
  type LocalToolsListCaller,
  type LocalToolsSetCaller,
  type LocalToolsUniverseCaller,
} from '../settings/local-tools-panel.js';
import type {
  CliReachabilityListResponse,
  CliReachabilitySetRequest,
  CliReachabilityUniverseResponse,
  CliToolGridEntry,
  ContractDefinitionView,
} from '@recued/contracts';

// ── fake DOM (trimmed copy of the contracts-panel test harness) ──────
interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  attrs: Map<string, string>;
  children: FakeEl[];
  listeners: Map<string, Array<(ev?: unknown) => void>>;
  parent: FakeEl | null;
  readonly firstChild: FakeEl | null;
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  addEventListener(type: string, fn: (ev?: unknown) => void): void;
  removeEventListener(type: string, fn: (ev?: unknown) => void): void;
  click(): void;
  remove(): void;
}

const makeFakeElement = (tag: string): FakeEl => {
  const el: FakeEl = {
    tagName: tag.toUpperCase(),
    className: '',
    textContent: '',
    attrs: new Map(),
    children: [],
    listeners: new Map(),
    parent: null,
    get firstChild() {
      return el.children[0] ?? null;
    },
    setAttribute(k, v) {
      el.attrs.set(k, v);
    },
    removeAttribute(k) {
      el.attrs.delete(k);
    },
    getAttribute(k) {
      return el.attrs.get(k) ?? null;
    },
    hasAttribute(k) {
      return el.attrs.has(k);
    },
    appendChild(c) {
      el.children.push(c);
      c.parent = el;
      return c;
    },
    removeChild(c) {
      const i = el.children.indexOf(c);
      if (i < 0) throw new Error('removeChild: not a child');
      el.children.splice(i, 1);
      c.parent = null;
      return c;
    },
    addEventListener(type, fn) {
      const list = el.listeners.get(type) ?? [];
      list.push(fn);
      el.listeners.set(type, list);
    },
    removeEventListener(type, fn) {
      const list = el.listeners.get(type);
      if (list === undefined) return;
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    click() {
      if (el.attrs.has('disabled')) return;
      for (const fn of el.listeners.get('click') ?? []) fn({ target: el });
    },
    remove() {
      if (el.parent) el.parent.removeChild(el);
    },
  };
  return el;
};

const makeFakeDocument = () => ({ createElement: makeFakeElement });

const collectByAttr = (root: FakeEl, attr: string, out: FakeEl[] = []): FakeEl[] => {
  if (root.attrs.has(attr)) out.push(root);
  for (const c of root.children) collectByAttr(c, attr, out);
  return out;
};

const tick = async (n = 8): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

// ── fixtures ─────────────────────────────────────────────────────────
const OWNER = 'user_self';

/** whisper: one slug, one Write op. magick: two slugs (magick-a has a Read op +
 *  a Write op; magick-b has one Write op) — the multi-slug / multi-op case. */
const UNIVERSE: CliToolGridEntry[] = [
  {
    tool: 'whisper',
    catalog_slugs: ['whisper'],
    operations: [{ operation_id: 'transcribe', catalog_slug: 'whisper', risk_tier: 'write' }],
  },
  {
    tool: 'magick',
    catalog_slugs: ['magick-a', 'magick-b'],
    operations: [
      { operation_id: 'identify', catalog_slug: 'magick-a', risk_tier: 'read' },
      { operation_id: 'convert', catalog_slug: 'magick-a', risk_tier: 'write' },
      { operation_id: 'mogrify', catalog_slug: 'magick-b', risk_tier: 'write' },
    ],
  },
];

/** Total grantable ops across UNIVERSE — the "M" of "N of M granted". */
const TOTAL_OPS = 4;

const contract = (
  contract_id: string,
  over: Partial<ContractDefinitionView> = {},
): ContractDefinitionView => ({
  contract_id,
  minted_at: 1_714_867_200_000,
  minted_by: 'Owner',
  display_name: `Door ${contract_id}`,
  scope: {},
  lifecycle_state: 'active',
  ...over,
});

interface MountOpts {
  universe?: CliToolGridEntry[];
  seedRows?: Array<{ principal: string; slug: string; op: string }>;
  contracts?: ReadonlyArray<ContractDefinitionView>;
  withContractsCaller?: boolean;
  runUniverse?: LocalToolsUniverseCaller;
  runSet?: LocalToolsSetCaller;
  /** When set, the default `set` impl THROWS for any matching write (before
   *  mutating the server) — exercises partial-failure reconcile (F4). */
  failWhen?: (args: CliReachabilitySetRequest) => boolean;
}

const mountFor = (opts: MountOpts = {}) => {
  const doc = makeFakeDocument();
  const host = doc.createElement('div');

  // The fake server: an in-memory allowlist `set` mutates + `list` reflects.
  const server = new Map<string, boolean>();
  const key = (p: string, s: string, o: string): string => `${p}|${s}|${o}`;
  for (const r of opts.seedRows ?? []) server.set(key(r.principal, r.slug, r.op), true);

  const runUniverse = vi.fn<LocalToolsUniverseCaller>(
    opts.runUniverse
      ?? (async (): Promise<CliReachabilityUniverseResponse> => ({
        tools: opts.universe ?? UNIVERSE,
      })),
  );

  const runList = vi.fn<LocalToolsListCaller>(
    async (): Promise<CliReachabilityListResponse> => ({
      rows: [...server.entries()]
        .filter(([, allowed]) => allowed)
        .map(([k]) => {
          const [principal, ingredient_id, operation_id] = k.split('|');
          return { principal, ingredient_id, operation_id, allowed: true };
        }),
    }),
  );

  const setImpl: LocalToolsSetCaller = async (args: CliReachabilitySetRequest) => {
    if (opts.failWhen?.(args)) throw new Error('write failed');
    const principal = args.principal ?? OWNER;
    const k = key(principal, args.ingredient_id, args.operation_id);
    if (args.allowed) server.set(k, true);
    else server.delete(k);
    return {
      principal,
      ingredient_id: args.ingredient_id,
      operation_id: args.operation_id,
      allowed: args.allowed,
    };
  };
  const runSet = vi.fn<LocalToolsSetCaller>(opts.runSet ?? setImpl);

  const runListContracts = vi.fn<LocalToolsContractsCaller>(async () => ({
    contracts: opts.contracts ?? [],
  }));

  const mount = mountLocalToolsPanel({
    host: host as unknown as HTMLElement,
    document: doc as unknown as Document,
    runUniverse,
    runList,
    runSet,
    ...(opts.withContractsCaller === false ? {} : { runListContracts }),
  });

  return { doc, host, mount, server, key, runUniverse, runList, runSet, runListContracts };
};

const findToggle = (
  host: FakeEl,
  principal: string,
  slug: string,
  op: string,
): FakeEl | undefined =>
  collectByAttr(host, LOCAL_TOOLS_OP_TOGGLE_ATTR).find(
    (c) =>
      c.getAttribute('data-principal') === principal
      && c.getAttribute('data-slug') === slug
      && c.getAttribute('data-operation') === op,
  );

const principalHeader = (host: FakeEl, principal: string): FakeEl | undefined =>
  collectByAttr(host, LOCAL_TOOLS_PRINCIPAL_HEADER_ATTR).find(
    (h) => h.getAttribute('data-principal') === principal,
  );

// ════════════════════════════════════════════════════════════════════

describe('D-182 §7.2 Local tools — rendering (contract-first nested list)', () => {
  it('renders a contract block per principal; Owner first + expanded with its op toggles', async () => {
    const { host, mount } = mountFor();
    await mount.whenLoaded();
    await tick();
    expect(mount.getState()).toBe('ready');
    const blocks = collectByAttr(host, LOCAL_TOOLS_PRINCIPAL_ATTR);
    expect(blocks.map((b) => b.getAttribute('data-principal'))).toEqual([OWNER]);
    // Owner defaults expanded → every op of every tool renders a toggle.
    expect(mount.isExpanded(OWNER)).toBe(true);
    expect(findToggle(host, OWNER, 'whisper', 'transcribe')).toBeDefined();
    expect(findToggle(host, OWNER, 'magick-a', 'identify')).toBeDefined();
    expect(findToggle(host, OWNER, 'magick-a', 'convert')).toBeDefined();
    expect(findToggle(host, OWNER, 'magick-b', 'mogrify')).toBeDefined();
  });

  it('shows a risk badge on every op + an "asks" mark on write ops (not read)', async () => {
    const { host, mount } = mountFor();
    await mount.whenLoaded();
    await tick();
    const badges = collectByAttr(host, LOCAL_TOOLS_RISK_BADGE_ATTR).map((b) =>
      b.getAttribute('data-risk'),
    );
    expect(badges).toContain('read');
    expect(badges).toContain('write');
    // One "asks" mark per write op (transcribe, convert, mogrify) — read ops omit it.
    expect(collectByAttr(host, LOCAL_TOOLS_ASKS_ATTR)).toHaveLength(3);
  });

  // D-182 — proactive readiness badge: a tool whose binary is not on the server
  // PATH (`reachable: false`) shows "not installed"; unknown/reachable show nothing.
  const withReachability = (
    reachable: Record<string, boolean | undefined>,
  ): CliToolGridEntry[] =>
    UNIVERSE.map((t) =>
      reachable[t.tool] === undefined ? { ...t } : { ...t, reachable: reachable[t.tool] },
    );

  it('shows a "not installed" badge only on a tool whose binary is not reachable', async () => {
    const { host, mount } = mountFor({ universe: withReachability({ whisper: false, magick: true }) });
    await mount.whenLoaded();
    await tick();
    const badges = collectByAttr(host, LOCAL_TOOLS_NOT_READY_ATTR);
    // Owner is the only principal + expanded; whisper(false) → 1 badge, magick(true) → 0.
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).toBe('not installed');
  });

  it('shows no readiness badge when reachability is unknown or the tool is reachable', async () => {
    const { host, mount } = mountFor({ universe: withReachability({ whisper: undefined, magick: true }) });
    await mount.whenLoaded();
    await tick();
    expect(collectByAttr(host, LOCAL_TOOLS_NOT_READY_ATTR)).toHaveLength(0);
  });

  it('rows = Owner + active STANDING contracts (excludes revoked / non-standing rows)', async () => {
    const { host, mount } = mountFor({
      contracts: [
        contract('ct_door', { display_name: 'Sales door' }),
        contract('ct_revoked', { lifecycle_state: 'revoked' }),
        contract('ct_session', { grant_kind: 'session' }),
        contract('ct_deleg', { grant_kind: 'delegation' }),
        contract('ct_template', { grant_kind: 'customer_template' }),
        contract('ct_customer', { grant_kind: 'customer_instance' }),
      ],
    });
    await mount.whenLoaded();
    await tick();
    expect(mount.getRows().map((r) => r.principal)).toEqual([OWNER, 'ct_door']);
    expect(mount.getRows()[0]?.label).toBe('Owner (you)');
    const blocks = collectByAttr(host, LOCAL_TOOLS_PRINCIPAL_ATTR);
    expect(blocks.map((b) => b.getAttribute('data-principal'))).toEqual([OWNER, 'ct_door']);
  });

  it('a door/agent contract starts COLLAPSED (fail-closed-quiet) — no op toggles until expanded', async () => {
    const { host, mount } = mountFor({ contracts: [contract('ct_door')] });
    await mount.whenLoaded();
    await tick();
    expect(mount.isExpanded('ct_door')).toBe(false);
    expect(findToggle(host, 'ct_door', 'whisper', 'transcribe')).toBeUndefined();
    // Expand it (DOM click on the header) → its op toggles appear.
    principalHeader(host, 'ct_door')?.click();
    await tick();
    expect(mount.isExpanded('ct_door')).toBe(true);
    expect(findToggle(host, 'ct_door', 'whisper', 'transcribe')).toBeDefined();
  });

  it('renders Owner-only rows when no contracts caller is wired', async () => {
    const { mount } = mountFor({ withContractsCaller: false });
    await mount.whenLoaded();
    await tick();
    expect(mount.getRows().map((r) => r.principal)).toEqual([OWNER]);
  });

  it('renders an empty state when no cli tools are installed', async () => {
    const { host, mount } = mountFor({ universe: [] });
    await mount.whenLoaded();
    await tick();
    expect(collectByAttr(host, LOCAL_TOOLS_EMPTY_ATTR)).toHaveLength(1);
  });

  it('surfaces a load error when the universe read rejects', async () => {
    const { host, mount } = mountFor({
      runUniverse: async () => {
        throw new Error('unknown_method');
      },
    });
    await mount.whenLoaded();
    await tick();
    expect(mount.getState()).toBe('error');
    expect(collectByAttr(host, LOCAL_TOOLS_ERROR_ATTR)).toHaveLength(1);
    expect(mount.getError()).toContain('unknown_method');
  });
});

describe('D-182 §7.2 Local tools — op state (one op = one row, no mixed)', () => {
  it('derives on / off per op from the allowlist rows', async () => {
    const { host, mount } = mountFor({
      seedRows: [{ principal: OWNER, slug: 'magick-a', op: 'convert' }],
    });
    await mount.whenLoaded();
    await tick();
    expect(mount.getOpState(OWNER, 'whisper', 'transcribe')).toBe('off');
    expect(mount.getOpState(OWNER, 'magick-a', 'identify')).toBe('off');
    expect(mount.getOpState(OWNER, 'magick-a', 'convert')).toBe('on');
    // The granted op's toggle reflects on via data-op-state.
    expect(findToggle(host, OWNER, 'magick-a', 'convert')?.getAttribute('data-op-state')).toBe('on');
    expect(findToggle(host, OWNER, 'magick-a', 'identify')?.getAttribute('data-op-state')).toBe('off');
  });

  it('the header summary reports "N of M granted"', async () => {
    const { host, mount } = mountFor({
      seedRows: [
        { principal: OWNER, slug: 'magick-a', op: 'convert' },
        { principal: OWNER, slug: 'whisper', op: 'transcribe' },
      ],
    });
    await mount.whenLoaded();
    await tick();
    const summary = collectByAttr(host, LOCAL_TOOLS_SUMMARY_ATTR).find(
      (s) => s.getAttribute('data-principal') === OWNER,
    );
    expect(summary?.textContent).toBe(`2 of ${TOTAL_OPS} granted`);
  });
});

describe('D-182 §7.2 Local tools — toggling (one reachability row per op)', () => {
  it('grants exactly the one op when toggling it on, under the explicit owner principal', async () => {
    const { mount, server, key, runSet } = mountFor();
    await mount.whenLoaded();
    await tick();
    await mount.toggleOp(OWNER, 'magick-a', 'convert');
    await tick();
    expect(server.get(key(OWNER, 'magick-a', 'convert'))).toBe(true);
    expect(mount.getOpState(OWNER, 'magick-a', 'convert')).toBe('on');
    // Exactly one write — no fan-out.
    expect(runSet).toHaveBeenCalledTimes(1);
    expect(runSet.mock.calls[0]![0]).toMatchObject({
      principal: OWNER,
      ingredient_id: 'magick-a',
      operation_id: 'convert',
      allowed: true,
    });
  });

  it('granting one op leaves every sibling op untouched (cross-op isolation in the UI)', async () => {
    const { mount, server, key } = mountFor();
    await mount.whenLoaded();
    await tick();
    await mount.toggleOp(OWNER, 'magick-a', 'convert');
    await tick();
    // The sibling read op + the other slug's op stay denied.
    expect(server.has(key(OWNER, 'magick-a', 'identify'))).toBe(false);
    expect(server.has(key(OWNER, 'magick-b', 'mogrify'))).toBe(false);
    expect(mount.getOpState(OWNER, 'magick-a', 'identify')).toBe('off');
  });

  it('revokes the op when toggling an on op off', async () => {
    const { mount, server, key } = mountFor({
      seedRows: [{ principal: OWNER, slug: 'magick-a', op: 'convert' }],
    });
    await mount.whenLoaded();
    await tick();
    await mount.toggleOp(OWNER, 'magick-a', 'convert');
    await tick();
    expect(server.has(key(OWNER, 'magick-a', 'convert'))).toBe(false);
    expect(mount.getOpState(OWNER, 'magick-a', 'convert')).toBe('off');
  });
});

describe('D-182 §7.2 Local tools — per-contract "Disable all" kill-switch', () => {
  it('disablePrincipal clears every granted op for ONE principal, leaving others intact', async () => {
    const { mount, server, key } = mountFor({
      contracts: [contract('ct_door')],
      seedRows: [
        { principal: OWNER, slug: 'magick-a', op: 'identify' },
        { principal: OWNER, slug: 'magick-a', op: 'convert' },
        { principal: OWNER, slug: 'whisper', op: 'transcribe' },
        // a DIFFERENT principal's grant must survive — the kill is per contract.
        { principal: 'ct_door', slug: 'magick-b', op: 'mogrify' },
      ],
    });
    await mount.whenLoaded();
    await tick();
    await mount.disablePrincipal(OWNER);
    await tick();
    expect([...server.keys()].some((k) => k.startsWith(`${OWNER}|`))).toBe(false);
    // ct_door's grant survived.
    expect(server.get(key('ct_door', 'magick-b', 'mogrify'))).toBe(true);
  });

  it('is a two-stage DOM confirm (arm → Confirm) and only shows when something is granted', async () => {
    const { host, mount, server } = mountFor({
      seedRows: [{ principal: OWNER, slug: 'whisper', op: 'transcribe' }],
    });
    await mount.whenLoaded();
    await tick();
    // First click arms — no confirm button before, one after.
    expect(collectByAttr(host, LOCAL_TOOLS_KILL_CONFIRM_ATTR)).toHaveLength(0);
    const kill = collectByAttr(host, LOCAL_TOOLS_KILL_ATTR).find(
      (b) => b.getAttribute('data-principal') === OWNER,
    );
    expect(kill).toBeDefined();
    kill?.click();
    const confirm = collectByAttr(host, LOCAL_TOOLS_KILL_CONFIRM_ATTR).find(
      (b) => b.getAttribute('data-principal') === OWNER,
    );
    expect(confirm).toBeDefined();
    confirm?.click();
    await tick();
    expect([...server.keys()].some((k) => k.startsWith(`${OWNER}|`))).toBe(false);
  });

  it('no kill-switch renders for a principal with nothing granted', async () => {
    const { host, mount } = mountFor();
    await mount.whenLoaded();
    await tick();
    expect(collectByAttr(host, LOCAL_TOOLS_KILL_ATTR)).toHaveLength(0);
  });
});

describe('D-182 §7.2 Local tools — robustness (Codex folds)', () => {
  it('reconciles + surfaces an error on a PARTIAL bulk failure (F4)', async () => {
    // A bulk revoke where the `convert` write rejects but the others succeed. After
    // settle the surface must reconcile to the true server state (convert still
    // granted, the rest dropped) AND show the principal's error chip.
    const { host, mount, server, key } = mountFor({
      seedRows: [
        { principal: OWNER, slug: 'magick-a', op: 'identify' },
        { principal: OWNER, slug: 'magick-a', op: 'convert' },
        { principal: OWNER, slug: 'whisper', op: 'transcribe' },
      ],
      failWhen: (a) => a.operation_id === 'convert',
    });
    await mount.whenLoaded();
    await tick();
    await mount.disablePrincipal(OWNER);
    await tick();
    // The successful revokes landed; the failed one stays granted (reconciled).
    expect(server.has(key(OWNER, 'magick-a', 'identify'))).toBe(false);
    expect(server.has(key(OWNER, 'whisper', 'transcribe'))).toBe(false);
    expect(mount.getOpState(OWNER, 'magick-a', 'convert')).toBe('on');
    // The principal error chip is shown.
    expect(collectByAttr(host, LOCAL_TOOLS_PRINCIPAL_ERROR_ATTR).length).toBeGreaterThanOrEqual(1);
  });

  it('refuses a bulk op while a single-op write for the principal is in flight (F3)', async () => {
    const gate = deferred<void>();
    let firstCall = true;
    const runSet: LocalToolsSetCaller = async (args) => {
      if (firstCall) {
        firstCall = false;
        await gate.promise; // hold the first op write open
      }
      return {
        principal: args.principal ?? OWNER,
        ingredient_id: args.ingredient_id,
        operation_id: args.operation_id,
        allowed: args.allowed,
      };
    };
    const { mount, runSet: spy } = mountFor({
      runSet,
      // whisper starts granted so an unguarded disablePrincipal WOULD issue a
      // revoke — making the "no new writes" assertion a real test of the guard.
      seedRows: [{ principal: OWNER, slug: 'whisper', op: 'transcribe' }],
    });
    await mount.whenLoaded();
    await tick();
    // Start an op write that blocks on the gate (don't await).
    const pending = mount.toggleOp(OWNER, 'whisper', 'transcribe');
    await tick();
    const callsBeforeBulk = spy.mock.calls.length;
    // A bulk op for the same principal must be refused while the op write is open.
    await mount.disablePrincipal(OWNER);
    await tick();
    expect(spy.mock.calls.length).toBe(callsBeforeBulk); // bulk issued no writes
    gate.resolve();
    await pending;
    await tick();
  });
});
