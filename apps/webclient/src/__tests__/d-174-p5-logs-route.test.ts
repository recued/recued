import { describe, expect, it, vi } from 'vitest';
import type {
  ActiveExecutionEntry,
  CliFailureReason,
  ExecutionListQuery,
  HeavyOpErrorCategory,
  LaneStatus,
  PolicyResult,
  RecipeError,
  RunAnchorStatus,
  RunDetail,
  RunFeedRow,
  RunOrigin,
  SessionGrantView,
} from '@recued/contracts';
import { RUN_ANCHOR_STATUSES } from '@recued/contracts';
import { formatClientDateTime } from '@recued/ui-shared';

import {
  LOGS_ROUTE_ACTIVE_ATTR,
  LOGS_ROUTE_ACTIVE_ROW_ATTR,
  LOGS_ROUTE_AFFECTED_ITEMS_ATTR,
  LOGS_ROUTE_CHAT_RETURN_ATTR,
  LOGS_ROUTE_DEGRADED_ATTR,
  LOGS_ROUTE_DETAIL_ATTR,
  LOGS_ROUTE_DETAIL_HEADING_ATTR,
  LOGS_ROUTE_CLI_FAILURE_ATTR,
  LOGS_ROUTE_ERROR_CATEGORY_ATTR,
  LOGS_ROUTE_GATEWAY_TRACE_ATTR,
  LOGS_ROUTE_HEADING_ATTR,
  LOGS_ROUTE_HOST_ATTR,
  LOGS_ROUTE_LANES_ATTR,
  LOGS_ROUTE_LOAD_MORE_ATTR,
  LOGS_ROUTE_OUTCOME_ATTR,
  LOGS_ROUTE_PEEK_ATTR,
  LOGS_ROUTE_PASSES_ATTR,
  LOGS_ROUTE_PASS_ROW_ATTR,
  LOGS_ROUTE_POLICY_ATTR,
  LOGS_ROUTE_REDACTED_IO_ATTR,
  LOGS_ROUTE_ROW_ATTR,
  LOGS_ROUTE_STATUS_ATTR,
  LOGS_ROUTE_STYLES_MARKER,
  LOGS_ROUTE_YIELD_ATTR,
  bootstrapLogsRoute,
  projectRunAffectedItems,
  projectRunOutcomeSummary,
  projectRunYieldNotice,
  type RunsActiveCaller,
  type RunsCancelCaller,
  type RunsGetCaller,
  type RunsKillCaller,
  type RunsListCaller,
  type RunsPromoteCaller,
  type RunsSessionGrantListCaller,
  type RunsSessionGrantRevokeCaller,
} from '../logs/bootstrap-logs-route.js';
import type { ChatPlanAddress } from '../shell/route.js';

type LogsRouteSubscribe = NonNullable<
  Parameters<typeof bootstrapLogsRoute>[0]['subscribe']
>;

interface FakeEl {
  tagName: string;
  textContent: string;
  innerHTML: string;
  attrs: Map<string, string>;
  children: FakeEl[];
  parent: FakeEl | null;
  listeners: Map<string, Array<(ev: Event) => void>>;
  readonly firstChild: FakeEl | null;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  addEventListener(type: string, fn: (ev: Event) => void): void;
  removeEventListener(type: string, fn: (ev: Event) => void): void;
  remove(): void;
}

interface FakeDoc {
  styleElements: FakeEl[];
  head: {
    querySelector(sel: string): FakeEl | null;
    appendChild(el: FakeEl): FakeEl;
  };
  createElement(tag: string): FakeEl;
}

const makeFakeEl = (tag: string): FakeEl => {
  const el: FakeEl = {
    tagName: tag.toUpperCase(),
    textContent: '',
    innerHTML: '',
    attrs: new Map(),
    children: [],
    parent: null,
    listeners: new Map(),
    get firstChild() {
      return el.children[0] ?? null;
    },
    setAttribute(k, v) {
      el.attrs.set(k, v);
    },
    getAttribute(k) {
      return el.attrs.get(k) ?? null;
    },
    hasAttribute(k) {
      return el.attrs.has(k);
    },
    appendChild(c) {
      c.parent = el;
      el.children.push(c);
      return c;
    },
    removeChild(c) {
      const idx = el.children.indexOf(c);
      if (idx < 0) throw new Error('removeChild: not a child');
      el.children.splice(idx, 1);
      c.parent = null;
      return c;
    },
    addEventListener(type, fn) {
      const arr = el.listeners.get(type) ?? [];
      arr.push(fn);
      el.listeners.set(type, arr);
    },
    removeEventListener(type, fn) {
      const arr = el.listeners.get(type);
      if (arr === undefined) return;
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    },
    remove() {
      if (el.parent !== null) el.parent.removeChild(el);
    },
  };
  return el;
};

const makeFakeDocument = (): FakeDoc => {
  const styleElements: FakeEl[] = [];
  const attrFromStyleSelector = (sel: string): string | null => {
    const m = sel.match(/^style\[([\w-]+)\]$/);
    return m?.[1] ?? null;
  };
  return {
    styleElements,
    head: {
      querySelector(sel) {
        const attr = attrFromStyleSelector(sel);
        if (attr === null) return null;
        return styleElements.find((style) => style.attrs.has(attr)) ?? null;
      },
      appendChild(el) {
        styleElements.push(el);
        return el;
      },
    },
    createElement: (tag) => makeFakeEl(tag),
  };
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

const NOW = 1_750_000_000_000;

const mcpOrigin = (): RunOrigin => ({
  actor: 'contracted_user',
  label: 'contracted_user',
  channel: 'mcp',
  attribution: {
    kind: 'agent',
    origin_actor: 'contracted_user',
    agent_id: 'agent-1',
    contract_id: 'contract-1',
    label: 'agent agent-1, under contract contract-1, asserted this',
  },
});

const runRow = (
  overrides: Partial<RunFeedRow> = {},
): RunFeedRow => ({
  run_id: 'run-1',
  recipe_id: 'mail/send-digest',
  name: 'Send digest',
  started_at: NOW - 1_000,
  finished_at: NOW,
  duration_ms: 1_000,
  origin: mcpOrigin(),
  status: 'awaiting_approval',
  policy_result: 'approval-requested',
  links: [
    { entity_id: 'conn-1', kind: 'connection', ts: NOW - 1_000 },
    { entity_id: 'contact-1', kind: 'contact', ts: NOW - 900 },
  ],
  ...overrides,
});

const recipeError = (
  overrides: Partial<RecipeError> = {},
): RecipeError => ({
  error_id: 'err-1',
  code: 'RECIPE_POLICY_DENIED',
  message: 'Policy denied this step.',
  severity: 'error',
  source: {
    recipe_id: 'mail/send-digest',
    step_id: 'send',
    ingredient_slug: 'mail.send',
  },
  details: { raw_token: 'super-secret-token' },
  timestamp: new Date(NOW).toISOString(),
  retryable: false,
  ...overrides,
});

const runDetail = (
  status: RunAnchorStatus = 'awaiting_approval',
  policy: PolicyResult = 'approval-requested',
  opts: {
    degraded?: RunDetail['audit']['degraded'];
    errorCategory?: HeavyOpErrorCategory;
    errors?: RecipeError[];
    trace?: RunDetail['gateway']['per_call_trace'];
    runYield?: RunDetail['audit']['run_yield'];
  } = {},
): RunDetail => ({
  audit: {
    run_id: 'run-1',
    recipe_id: 'mail/send-digest',
    recipe_hash: 'hash-1',
    started_at: NOW - 1_000,
    finished_at: NOW,
    duration_ms: 1_000,
    status,
    origin: mcpOrigin(),
    trigger_source: 'manual',
    instance_id: 'server-1',
    errors: opts.errors ?? [recipeError()],
    output_string: 'SECRET_OUTPUT_SHOULD_NOT_RENDER',
    ...(opts.degraded !== undefined ? { degraded: opts.degraded } : {}),
    ...(opts.errorCategory !== undefined
      ? { error_category: opts.errorCategory }
      : {}),
    ...(opts.runYield !== undefined ? { run_yield: opts.runYield } : {}),
  },
  approvals: {
    checkpoints: [
      {
        checkpoint_id: 'checkpoint-1',
        run_id: 'run-1',
        recipe_id: 'mail/send-digest',
        gated_step_id: 'send',
        created_at: NOW - 800,
      },
    ],
    ask_id: 'ask-1',
    checkpoint_id: 'checkpoint-1',
    outcome: policy === 'released-after-approval' ? 'allow' : undefined,
    output_string: 'SECRET_APPROVAL_OUTPUT_SHOULD_NOT_RENDER',
  },
  errors: opts.errors ?? [recipeError()],
  links: [
    { entity_id: 'conn-1', kind: 'connection', ts: NOW - 1_000 },
    { entity_id: 'contact-1', kind: 'contact', ts: NOW - 900 },
  ],
  gateway: {
    policy_result: policy,
    per_call_trace: opts.trace ?? [],
  },
});

const mountRoute = (overrides: {
  listCaller?: RunsListCaller;
  getCaller?: RunsGetCaller;
  initialRunId?: string;
  initialRecipeId?: string;
  chatReturn?: ChatPlanAddress;
  replaceState?: (
    data: unknown,
    unused: string,
    url?: string | URL | null,
  ) => void;
  pushState?: (
    data: unknown,
    unused: string,
    url?: string | URL | null,
  ) => void;
  onHashSync?: Parameters<typeof bootstrapLogsRoute>[0]['onHashSync'];
  subscribe?: LogsRouteSubscribe;
} = {}) => {
  const doc = makeFakeDocument();
  if (overrides.replaceState !== undefined || overrides.pushState !== undefined) {
    (doc as unknown as { defaultView: unknown }).defaultView = {
      history: {
        ...(overrides.replaceState !== undefined
          ? { replaceState: overrides.replaceState }
          : {}),
        ...(overrides.pushState !== undefined
          ? { pushState: overrides.pushState }
          : {}),
      },
    };
  }
  const root = doc.createElement('div');
  const listCaller =
    overrides.listCaller
    ?? vi.fn<RunsListCaller>(async () => ({
      runs: [runRow()],
    }));
  const getCaller =
    overrides.getCaller
    ?? vi.fn<RunsGetCaller>(async () => ({
      run: runDetail(),
    }));

  const route = bootstrapLogsRoute({
    root: root as unknown as HTMLElement,
    document: doc as unknown as Document,
    listCaller,
    getCaller,
    now: () => NOW,
    ...(overrides.initialRunId !== undefined
      ? { initialRunId: overrides.initialRunId }
      : {}),
    ...(overrides.initialRecipeId !== undefined
      ? { initialRecipeId: overrides.initialRecipeId }
      : {}),
    ...(overrides.chatReturn !== undefined
      ? { chatReturn: overrides.chatReturn }
      : {}),
    ...(overrides.onHashSync !== undefined
      ? { onHashSync: overrides.onHashSync }
      : {}),
    ...(overrides.subscribe !== undefined ? { subscribe: overrides.subscribe } : {}),
  });
  return { doc, root, route, listCaller, getCaller };
};

describe('D-174 P5 - Runs route', () => {
  it('renders the execution.list History table with filters, color-coded status/policy chips, detail-pane links, and cursor pagination', async () => {
    const calls: ExecutionListQuery[] = [];
    const nextCursor = {
      last_started_at: NOW - 1_000,
      last_run_id: 'run-1',
    };
    const listCaller = vi.fn<RunsListCaller>(async (query) => {
      calls.push(query);
      if (query.cursor !== undefined) {
        return {
          runs: [
            runRow({
              run_id: 'run-2',
              name: 'CRM update',
              recipe_id: 'crm/update-contact',
              status: 'succeeded',
              policy_result: 'allowed',
            }),
          ],
        };
      }
      if (query.recipe_id !== undefined) {
        return {
          runs: [
            runRow({
              run_id: 'run-filtered',
              status: 'failed',
              policy_result: 'denied',
            }),
          ],
        };
      }
      return {
        runs: [runRow()],
        next_cursor: nextCursor,
      };
    });
    const rig = mountRoute({ listCaller });
    await rig.route.whenLoaded();

    expect(calls[0]).toEqual({ limit: 25 });
    const shell = rig.root.children[0]!;
    expect(shell.attrs.has(LOGS_ROUTE_HOST_ATTR)).toBe(true);
    expect(shell.innerHTML).toContain(LOGS_ROUTE_HEADING_ATTR);
    expect(shell.innerHTML).toContain(LOGS_ROUTE_ROW_ATTR);
    expect(shell.innerHTML).toContain(LOGS_ROUTE_STATUS_ATTR);
    expect(shell.innerHTML).toContain(LOGS_ROUTE_POLICY_ATTR);
    expect(shell.innerHTML).toContain(LOGS_ROUTE_LOAD_MORE_ATTR);
    expect(shell.innerHTML).toContain(
      `${LOGS_ROUTE_DETAIL_ATTR} aria-label="Run detail"`,
    );
    expect(shell.innerHTML).toContain(
      'aria-label="Open run detail for Send digest (run-1)"',
    );
    // R17 — History is a responsive table, not a card list.
    expect(shell.innerHTML).toContain('<table class="logs-table"');
    // The Recipe filter renders the shared ref-picker shell (★), not a
    // raw recipe-id text box.
    expect(shell.innerHTML).toContain('data-ref-picker="logs-recipe-filter"');
    expect(shell.innerHTML).not.toContain('placeholder="recipe id"');
    expect(shell.innerHTML).toContain('Connected agent');
    expect(shell.innerHTML).toContain('data-recued-provenance');
    expect(shell.innerHTML).toContain(
      'agent agent-1, under contract contract-1, asserted this',
    );
    expect(shell.innerHTML).toContain('approval requested');
    expect(shell.innerHTML).toContain(formatClientDateTime(NOW - 1_000));
    expect(shell.innerHTML).not.toContain(new Date(NOW - 1_000).toISOString());
    // R17 — per-row provenance / recipe / approval links moved OUT of the
    // (scannable) table into the detail pane; the feed carries none.
    expect(shell.innerHTML).not.toContain('Audit detail');
    expect(shell.innerHTML).not.toContain('href="#approvals"');
    expect(rig.doc.styleElements[0]?.attrs.has(LOGS_ROUTE_STYLES_MARKER))
      .toBe(true);
    const routeStyles = rig.doc.styleElements[0]?.textContent ?? '';
    expect(routeStyles).toMatch(
      /\.logs-inline-link,[\s\S]*?min-height: 36px;/,
    );
    expect(routeStyles).toMatch(/\.logs-button \{[\s\S]*?min-height: 36px;/);
    expect(routeStyles).toMatch(
      /\.logs-row-open \{[\s\S]*?min-width: 36px;[\s\S]*?min-height: 36px;/,
    );
    expect(routeStyles).toMatch(
      /@media \(max-width: 860px\)[\s\S]*?\.logs-table td\.logs-cell-status,[\s\S]*?\.logs-table td\.logs-cell-policy \{[\s\S]*?display: flex;/,
    );

    // Opening a run surfaces those links in the detail pane.
    await rig.route.openRun('run-1');
    const detailHtml = rig.root.children[0]?.innerHTML ?? '';
    expect(detailHtml).toContain(
      `${LOGS_ROUTE_DETAIL_ATTR}="run-1" aria-label="Run detail"`,
    );
    expect(detailHtml).toContain(
      `${LOGS_ROUTE_DETAIL_HEADING_ATTR}="run-1" tabindex="-1"`,
    );
    expect(detailHtml).toContain('Audit detail');
    expect(detailHtml).toContain('href="#recipes/mail%2Fsend-digest"');
    expect(detailHtml).toContain(
      'data-recued-reference-id="mail/send-digest"',
    );
    // R17 — the Approval link is run-SCOPED to the pending ask (fixture
    // ask_id 'ask-1'), not the bare #approvals queue.
    expect(detailHtml).toContain('href="#approvals/ask-1"');
    expect(detailHtml).toContain('data-recued-reference-id="ask-1"');
    expect(detailHtml).toContain('data-recued-reference-id="run-1"');
    expect(detailHtml).not.toContain('href="#approvals"');
    expect(detailHtml).toContain('href="#data"');
    expect(detailHtml).toContain('href="#connections"');

    await rig.route.loadMore();
    expect(calls[1]).toEqual({
      limit: 25,
      cursor: nextCursor,
    });
    expect(rig.route.getRuns().map((row) => row.run_id)).toEqual([
      'run-1',
      'run-2',
    ]);

    await rig.route.setFilters({
      status: 'failed',
      origin: 'contracted_user',
      recipe_id: 'mail/send-digest',
      time_range: '24h',
    });
    expect(calls[2]).toEqual({
      limit: 25,
      status: ['failed'],
      origin: ['contracted_user'],
      recipe_id: 'mail/send-digest',
      since: NOW - 24 * 60 * 60 * 1000,
    });
    expect(rig.root.children[0]?.innerHTML).toContain('data-risk="blocked"');

    rig.route.dispose();
  });

  it('keeps a failed run-detail retry visible and single-flight', async () => {
    const retry = deferred<Awaited<ReturnType<RunsGetCaller>>>();
    const getCaller = vi.fn<RunsGetCaller>()
      .mockRejectedValueOnce(new Error('Run detail unavailable.'))
      .mockImplementationOnce(() => retry.promise);
    const rig = mountRoute({ getCaller });
    await rig.route.whenLoaded();

    await rig.route.openRun('run-1');
    const shell = rig.root.children[0]!;
    expect(shell.innerHTML).toContain('role="alert"');
    expect(shell.innerHTML).toContain('Run detail unavailable.');
    expect(shell.innerHTML).toContain(
      'data-recued-logs-action="retry-detail" data-run-id="run-1"',
    );

    const target = {
      closest: (selector: string) =>
        selector.includes('data-recued-logs-action')
          ? {
              getAttribute: (name: string) =>
                name === 'data-recued-logs-action'
                  ? 'retry-detail'
                  : name === 'data-run-id'
                    ? 'run-1'
                    : null,
            }
          : null,
    };
    const clickRetry = (): void => {
      for (const listener of shell.listeners.get('click') ?? []) {
        listener({ target } as unknown as Event);
      }
    };

    clickRetry();
    clickRetry();
    expect(getCaller).toHaveBeenCalledTimes(2);
    expect(shell.innerHTML).toContain(
      'data-recued-logs-action="retry-detail" data-run-id="run-1" '
      + 'aria-disabled="true" aria-busy="true">Retrying…',
    );

    retry.resolve({ run: runDetail() });
    await Promise.resolve();
    await Promise.resolve();
    expect(rig.route.getSelectedRun()?.audit.run_id).toBe('run-1');
    expect(shell.innerHTML).not.toContain('retry-detail');

    rig.route.dispose();
  });

  it('guards a cursor page while Load more is already in flight', async () => {
    const nextCursor = {
      last_started_at: NOW - 1_000,
      last_run_id: 'run-1',
    };
    const append = deferred<{ runs: RunFeedRow[] }>();
    const listCaller = vi.fn<RunsListCaller>(async (query) => {
      if (query.cursor !== undefined) return append.promise;
      return { runs: [runRow()], next_cursor: nextCursor };
    });
    const rig = mountRoute({ listCaller });
    await rig.route.whenLoaded();

    const first = rig.route.loadMore();
    const duplicate = rig.route.loadMore();
    expect(listCaller).toHaveBeenCalledTimes(2);
    expect(rig.root.children[0]?.innerHTML).toContain(
      'aria-disabled="true">Loading...',
    );

    append.resolve({
      runs: [runRow({ run_id: 'run-2', started_at: NOW - 2_000 })],
    });
    await Promise.all([first, duplicate]);
    expect(rig.route.getRuns().map((row) => row.run_id)).toEqual([
      'run-1',
      'run-2',
    ]);

    rig.route.dispose();
  });

  it('keeps an explicit filter Apply focusable and single-flight', async () => {
    const filtered = deferred<{ runs: RunFeedRow[] }>();
    const listCaller = vi.fn<RunsListCaller>()
      .mockResolvedValueOnce({ runs: [runRow()] })
      .mockImplementationOnce(() => filtered.promise);
    const rig = mountRoute({ listCaller });
    await rig.route.whenLoaded();
    const shell = rig.root.children[0]!;
    const target = {
      closest: (selector: string) =>
        selector.includes('data-recued-logs-action')
          ? {
              getAttribute: (name: string) =>
                name === 'data-recued-logs-action' ? 'apply-filters' : null,
            }
          : null,
    };
    const clickApply = (): void => {
      for (const listener of shell.listeners.get('click') ?? []) {
        listener({ target } as unknown as Event);
      }
    };

    clickApply();
    clickApply();
    expect(listCaller).toHaveBeenCalledTimes(2);
    expect(shell.innerHTML).toContain('aria-disabled="true" aria-busy="true"');
    expect(shell.innerHTML).toContain('Applying…');

    filtered.resolve({ runs: [runRow({ run_id: 'run-filtered' })] });
    await Promise.resolve();
    await Promise.resolve();
    expect(shell.innerHTML).toContain('>Apply</button>');
    expect(shell.innerHTML).not.toContain('Applying…');

    rig.route.dispose();
  });

  it('renders Status + Policy as separate color-coded chips, hiding Policy on allowed runs (kills the double-OK)', async () => {
    const listCaller = vi.fn<RunsListCaller>(async () => ({
      runs: [
        runRow({ run_id: 'run-ok', status: 'succeeded', policy_result: 'allowed' }),
        runRow({ run_id: 'run-bad', status: 'failed', policy_result: 'denied' }),
      ],
    }));
    const rig = mountRoute({ listCaller });
    await rig.route.whenLoaded();
    const html = rig.root.children[0]?.innerHTML ?? '';

    // Columnar table headers.
    expect(html).toContain('<th scope="col">Status</th>');
    expect(html).toContain('<th scope="col">Policy</th>');
    expect(html).toContain('data-label="Status"');

    // Status chip is color-coded by tone — `ok` for succeeded, `off` (danger)
    // for failed — and carries the label, not a glyph.
    expect(html).toContain(`${LOGS_ROUTE_STATUS_ATTR}="succeeded" data-tone="ok"`);
    expect(html).toContain(`${LOGS_ROUTE_STATUS_ATTR}="failed" data-tone="off"`);

    // The allowed run shows NO Policy chip (the boring default is silent — this
    // is what kills the old "OK succeeded · OK allowed" double-glyph); the denied
    // run shows a danger-toned Policy chip.
    expect(html).not.toContain(`${LOGS_ROUTE_POLICY_ATTR}="allowed"`);
    expect(html).toContain(`${LOGS_ROUTE_POLICY_ATTR}="denied" data-tone="off"`);

    // The redundant 'OK' status/policy glyph is gone entirely.
    expect(html).not.toContain('aria-hidden="true">OK');

    rig.route.dispose();
  });

  it('projects every run state into a truthful outcome, uncertainty boundary, and safe next step', () => {
    const scenarios: ReadonlyArray<{
      status: RunAnchorStatus;
      tone: ReturnType<typeof projectRunOutcomeSummary>['tone'];
      title: string;
      detail: string;
      nextStep?: string;
      actionHref?: string;
    }> = [
      {
        status: 'pending',
        tone: 'attention',
        title: 'The run is waiting to start',
        detail: 'it has not started',
        nextStep: 'before you start another run',
        actionHref: '#logs/active',
      },
      {
        status: 'running',
        tone: 'attention',
        title: 'The run is still going',
        detail: 'Nothing has been written down about how it ended',
        nextStep: 'before you start another run',
        actionHref: '#logs/active',
      },
      {
        status: 'succeeded',
        tone: 'positive',
        title: 'Run completed',
        detail: 'finished, and it worked',
      },
      {
        status: 'failed',
        tone: 'danger',
        title: 'Run failed',
        detail: 'Earlier steps may already have changed things',
        nextStep: 'check the app or data it touched, before you try again',
      },
      {
        status: 'cancelled',
        tone: 'neutral',
        title: 'Run was cancelled',
        detail: 'Earlier steps may already have changed things',
        nextStep: 'before you run it again',
      },
      {
        status: 'killed',
        tone: 'danger',
        title: 'Run was stopped',
        detail: 'still doing something',
        nextStep: 'Check the app or the data it touched before you try again',
      },
      {
        status: 'in_doubt',
        tone: 'attention',
        title: 'Somebody needs to check what happened',
        detail: 'lost contact',
        nextStep: 'will not run it again by itself',
      },
      {
        status: 'awaiting_approval',
        tone: 'attention',
        title: 'The run is waiting for your yes',
        detail: 'That step has not happened',
        nextStep: 'carry on or stop it',
        actionHref: '#approvals/ask-1',
      },
      {
        // D-234 § 234.4 — the REMOTE hold. ⛔ NOTE WHAT IS ABSENT: no
        // `actionHref`. The `awaiting_approval` row above links to the approvals
        // queue because the owner can answer it; this hold is answerable only by
        // another server's owner, and a link into a queue that will never contain
        // it is the correct-looking absence this project keeps paying for. That
        // asymmetry is the entire reason § 234.4 made it a distinct status rather
        // than a flag on the existing one.
        status: 'awaiting_peer',
        tone: 'attention',
        title: 'Waiting on a peer',
        detail: 'asking another Recued server',
        nextStep: 'carries on by itself when they answer',
      },
    ];

    expect(scenarios.map(({ status }) => status)).toEqual(
      RUN_ANCHOR_STATUSES,
    );
    for (const scenario of scenarios) {
      // ⚠ `derivePolicyResult` maps BOTH holds to `'approval-requested'` — the
      // closest honest value in the closed `PolicyResult` union, since letting a
      // peer hold fall through to `'allowed'` would report that policy cleared a
      // run which is right now suspended. The run's own status is what
      // distinguishes whose answer is outstanding.
      const policy: PolicyResult = scenario.status === 'awaiting_approval'
        || scenario.status === 'awaiting_peer'
        ? 'approval-requested'
        : 'allowed';
      const summary = projectRunOutcomeSummary(
        runDetail(scenario.status, policy, { errors: [] }),
      );
      expect(summary.tone, scenario.status).toBe(scenario.tone);
      expect(summary.title, scenario.status).toBe(scenario.title);
      expect(summary.detail, scenario.status).toContain(scenario.detail);
      if (scenario.nextStep === undefined) {
        expect(summary.nextStep, scenario.status).toBeUndefined();
      } else {
        expect(summary.nextStep, scenario.status).toContain(
          scenario.nextStep,
        );
      }
      expect(summary.action?.href, scenario.status).toBe(
        scenario.actionHref,
      );
      expect(summary.recordWarnings, scenario.status).toEqual([]);
    }
  });

  it('uses structured termination, permission, and CLI causes instead of a generic failed outcome', () => {
    const categoryCases: ReadonlyArray<
      readonly [HeavyOpErrorCategory, string]
    > = [
      ['timeout', 'Run timed out'],
      ['oom', 'The run ran out of memory'],
      ['crashed', 'Run crashed'],
      ['stalled', 'Run stalled'],
      ['killed', 'Run was stopped'],
      ['cancelled_before_dispatch', 'A waiting step was cancelled'],
    ];
    for (const [errorCategory, title] of categoryCases) {
      const summary = projectRunOutcomeSummary(
        runDetail('failed', 'blocked', {
          errorCategory,
          errors: [],
        }),
      );
      expect(summary.title, errorCategory).toBe(title);
    }

    const denied = projectRunOutcomeSummary(
      runDetail('failed', 'denied', { errors: [] }),
    );
    expect(denied.title).toBe('Permission was denied');
    expect(denied.detail).toContain('step you said no to was not sent');

    const policyError = projectRunOutcomeSummary(
      runDetail('failed', 'allowed', {
        errors: [recipeError()],
      }),
    );
    expect(policyError.title).toBe('Permission was denied');

    // The server's aggregate `blocked` result also covers dispatched commits
    // that failed / cancelled / became uncertain. It is not proof that policy
    // stopped a step before dispatch.
    const blockedAfterDispatch = projectRunOutcomeSummary(
      runDetail('failed', 'blocked', {
        errors: [
          recipeError({
            code: 'NETWORK_ERROR',
            message: 'The provider call failed.',
          }),
        ],
      }),
    );
    expect(blockedAfterDispatch.title).toBe('Run failed');
    expect(blockedAfterDispatch.detail).not.toContain('before it was sent');

    const cliCases: ReadonlyArray<readonly [CliFailureReason, string]> = [
      ['not_found', 'A tool it needed is missing'],
      ['spawn_error', 'A tool it needed would not start'],
      ['nonzero_exit', 'A tool it needed gave an error'],
      ['timeout', 'A tool it needed took too long'],
      ['bad_output', 'A tool sent back something Recued could not read'],
    ];
    for (const [reason, title] of cliCases) {
      const summary = projectRunOutcomeSummary(
        runDetail('failed', 'allowed', {
          errors: [
            recipeError({
              code: reason === 'not_found'
                ? 'CLI_TOOL_NOT_FOUND'
                : 'CLI_TOOL_FAILED',
              message: 'The local tool failed.',
              details: {
                cli_failure: {
                  reason,
                  tool: 'example-tool',
                },
              },
            }),
          ],
        }),
      );
      expect(summary.title, reason).toBe(title);
    }
  });

  it('keeps confirmed execution separate from friendly audit-record warnings', () => {
    const summary = projectRunOutcomeSummary(
      runDetail('succeeded', 'allowed', {
        degraded: ['audit_unwritten', 'provenance_incomplete'],
        errors: [],
      }),
    );

    expect(summary.title).toBe('Run completed');
    expect(summary.detail).toBe('The run finished, and it worked.');
    expect(summary.tone).toBe('attention');
    expect(summary.nextStep).toContain('Read the warning');
    expect(summary.recordWarnings).toEqual([
      {
        code: 'audit_unwritten',
        message: 'Recued could not save part of this run’s story.',
      },
      {
        code: 'provenance_incomplete',
        message: 'Some links to what this run touched are missing.',
      },
    ]);
  });

  it('projects provenance into deduped exact, source-resolved, and honest fallback targets', () => {
    const items = projectRunAffectedItems(
      [
        {
          entity_id: 'calendar:event-1',
          kind: 'execution.action',
          ts: NOW - 900,
        },
        {
          entity_id: 'calendar:event-1',
          kind: 'execution.write',
          ts: NOW - 800,
        },
        {
          entity_id: 'contact:person@example.com',
          kind: 'execution.action',
          ts: NOW - 700,
        },
        {
          entity_id:
            'connection.api.hubspot.deal:hubspot_deal_42',
          kind: 'execution.derived',
          ts: NOW - 600,
        },
        {
          entity_id: 'future_collection:item-9',
          kind: 'execution.write',
          ts: NOW - 500,
        },
        {
          entity_id: 'not-qualified',
          kind: 'execution.write',
          ts: NOW - 400,
        },
        { entity_id: 'conn-1', kind: 'connection', ts: NOW - 300 },
      ],
      { run_id: 'run-1', status: 'in_doubt' },
      {
        sessionId: 'chat/one',
        planId: 'plan 1',
      },
    );

    expect(items).toHaveLength(4);
    expect(items[0]).toMatchObject({
      entityId: 'calendar:event-1',
      title: 'Calendar event',
      relationship: 'involved',
      relationshipLabel: 'Involved in change',
      resolution: 'resolve-source',
      actionLabel: 'Check before running it again',
    });
    expect(items[0]?.href).toBe(
      '#data/calendar/verify/event-1/relationship/involved/return/logs/'
      + 'run-1/return/chat/session/chat%2Fone/plan/plan%201',
    );
    expect(items[1]).toMatchObject({
      title: 'Contact',
      relationshipLabel: 'Used by action',
      resolution: 'exact',
    });
    expect(items[1]?.href).toContain(
      '#data/contact/item/person%40example.com/relationship/action/'
      + 'return/logs/run-1',
    );
    expect(items[2]).toMatchObject({
      title: 'CRM hubspot deal',
      resolution: 'exact',
    });
    expect(items[2]?.href).toContain(
      'connection.api.hubspot.deal%3Ahubspot_deal_42',
    );
    expect(items[3]).toMatchObject({
      title: 'Future collection',
      resolution: 'fallback',
      href: '#data',
      actionLabel: 'Open Data',
    });

    const success = projectRunAffectedItems(
      [{
        entity_id: 'project:project-1',
        kind: 'execution.write',
        ts: NOW,
      }],
      { run_id: 'run-2', status: 'succeeded' },
    );
    expect(success[0]?.actionLabel).toBe('Verify item');
  });

  it('puts affected-item verification directly after the outcome and keeps the run/Chat return', async () => {
    const getCaller = vi.fn<RunsGetCaller>(async () => {
      const detail = runDetail('in_doubt', 'blocked', { errors: [] });
      return {
        run: {
          ...detail,
          links: [
            {
              entity_id: 'mail:message-1',
              kind: 'execution.action',
              ts: NOW - 500,
            },
            {
              entity_id: 'calendar:event-1',
              kind: 'execution.write',
              ts: NOW - 400,
            },
            {
              entity_id: 'not-qualified',
              kind: 'execution.write',
              ts: NOW - 300,
            },
          ],
        },
      };
    });
    const rig = mountRoute({
      getCaller,
      initialRunId: 'run-1',
      chatReturn: {
        sessionId: 'chat-1',
        planId: 'plan-1',
        messageId: 'answer-1',
      },
    });
    await rig.route.whenLoaded();

    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain(LOGS_ROUTE_AFFECTED_ITEMS_ATTR);
    expect(html).toContain(
      `${LOGS_ROUTE_OUTCOME_ATTR}="in_doubt" data-tone="attention" `
      + 'aria-label="Run outcome" tabindex="-1"',
    );
    expect(html.indexOf(LOGS_ROUTE_OUTCOME_ATTR)).toBeLessThan(
      html.indexOf(LOGS_ROUTE_AFFECTED_ITEMS_ATTR),
    );
    expect(html).toContain('Recorded items');
    expect(html).toContain('Check these recorded items before retrying');
    expect(html).toContain('Used by action');
    expect(html).toContain('Involved in change');
    expect(html).toContain('Check before running it again');
    expect(html).toContain(
      'href="#data/mail/verify/message-1/relationship/action/return/logs/'
      + 'run-1/return/chat/session/chat-1/plan/plan-1/answer/answer-1"',
    );
    expect(html).toContain(
      'Data will check connected sources before opening this record.',
    );
    expect(html).not.toContain('execution.action mail:message-1');
    expect(html).not.toContain('execution.write calendar:event-1');
    expect(html).toContain('execution.write not-qualified');

    rig.route.dispose();
  });

  it('gives uncertain runs an honest destination-app fallback when no affected item was recorded', async () => {
    const getCaller = vi.fn<RunsGetCaller>(async () => {
      const detail = runDetail('failed', 'allowed', { errors: [] });
      return { run: { ...detail, links: [] } };
    });
    const rig = mountRoute({ getCaller, initialRunId: 'run-1' });
    await rig.route.whenLoaded();

    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain(LOGS_ROUTE_AFFECTED_ITEMS_ATTR);
    expect(html).toContain('No item links were recorded.');
    expect(html).toContain('Check the destination app directly before retrying.');

    rig.route.dispose();
  });

  it('renders execution.get detail with approvals, errors, links, real gateway trace, stored verdict, and degraded state without raw secret payloads', async () => {
    const getCaller = vi.fn<RunsGetCaller>(async () => ({
      run: runDetail('failed', 'blocked', {
        degraded: ['provenance_incomplete'],
        trace: [
          {
            commit_id: 'commit-real-trace',
            kind: 'action',
            ingredient: 'mail-send',
            tool: 'send',
            decision: 'blocked',
            verdict: 'failed',
            dispatched_at: NOW - 700,
            completed_at: NOW - 660,
            duration_ms: 40,
          },
        ],
      }),
    }));
    const rig = mountRoute({ getCaller });
    await rig.route.whenLoaded();

    await rig.route.openRun('run-1');

    expect(getCaller).toHaveBeenCalledWith({ run_id: 'run-1' });
    expect(rig.route.getSelectedRun()?.audit.run_id).toBe('run-1');
    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain('checkpoint-1');
    expect(html).toContain('RECIPE_POLICY_DENIED');
    expect(html).toContain(LOGS_ROUTE_GATEWAY_TRACE_ATTR);
    expect(html).toContain('commit-real-trace');
    expect(html).toContain('mail-send / send');
    expect(html).toContain('Recorded result');
    expect(html).toContain('blocked');
    expect(html).toContain(
      `${LOGS_ROUTE_OUTCOME_ATTR}="failed" data-tone="danger"`,
    );
    expect(html).toContain('aria-label="Run outcome"');
    expect(html).toContain('Permission was denied');
    expect(html).toContain('Earlier steps may already have changed things.');
    expect(html).toContain(LOGS_ROUTE_DEGRADED_ATTR);
    expect(html).toContain('provenance_incomplete');
    expect(html).toContain(
      'Some links to what this run touched are missing.',
    );
    expect(html).not.toContain('Degraded: provenance_incomplete');
    expect(html).toContain(LOGS_ROUTE_REDACTED_IO_ATTR);
    expect(html).toContain('Redacted output is recorded');
    expect(html).not.toContain('pending-commit-log-read');
    expect(html).not.toContain('per-call gateway trace pending');
    expect(html).not.toContain('super-secret-token');
    expect(html).not.toContain('SECRET_OUTPUT_SHOULD_NOT_RENDER');
    expect(html).not.toContain('SECRET_APPROVAL_OUTPUT_SHOULD_NOT_RENDER');

    rig.route.dispose();
  });

  it('opens an inbound #logs run_id on initial mount', async () => {
    const getCaller = vi.fn<RunsGetCaller>(async () => ({
      run: runDetail('succeeded', 'allowed'),
    }));
    const rig = mountRoute({ getCaller, initialRunId: 'run-1' });
    await rig.route.whenLoaded();

    expect(getCaller).toHaveBeenCalledWith({ run_id: 'run-1' });
    expect(rig.route.getSelectedRun()?.audit.status).toBe('succeeded');

    rig.route.dispose();
  });

  it('keeps a reload-safe return to the exact originating Chat action', async () => {
    const replaceState = vi.fn();
    const rig = mountRoute({
      initialRunId: 'run-1',
      chatReturn: {
        sessionId: 'chat/one',
        planId: 'plan one',
        messageId: 'answer #1',
      },
      replaceState,
    });
    await rig.route.whenLoaded();

    expect(replaceState).not.toHaveBeenCalled();
    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain(LOGS_ROUTE_CHAT_RETURN_ATTR);
    expect(html).toContain('You came here from an action in Chat.');
    expect(html).toContain(
      'href="#chat/session/chat%2Fone/plan/plan%20one/answer/answer%20%231"',
    );
    expect(html).toContain('Back to this Chat action');
    expect(html).toContain(
      'aria-label="Back to the originating Chat action"',
    );
    // The detail's existing self-link must not silently discard the return.
    expect(html).toContain(
      'href="#logs/run-1/return/chat/session/chat%2Fone/plan/plan%20one/'
      + 'answer/answer%20%231"',
    );

    rig.route.dispose();
  });

  it('loads an exact run beside a slow History list and never rewrites after dispose', async () => {
    const feed = deferred<{ runs: RunFeedRow[] }>();
    const detail = deferred<{ run: RunDetail }>();
    const listCaller = vi.fn<RunsListCaller>(() => feed.promise);
    const getCaller = vi.fn<RunsGetCaller>(() => detail.promise);
    const replaceState = vi.fn();
    const rig = mountRoute({
      listCaller,
      getCaller,
      initialRunId: 'run-1',
      chatReturn: {
        sessionId: 'chat-1',
        planId: 'plan-1',
      },
      replaceState,
    });

    // The exact destination must not wait for the unrelated History query.
    expect(listCaller).toHaveBeenCalledOnce();
    expect(getCaller).toHaveBeenCalledWith({ run_id: 'run-1' });
    expect(replaceState).not.toHaveBeenCalled();

    const hashWritesBeforeDispose = replaceState.mock.calls.length;
    rig.route.dispose();
    feed.resolve({ runs: [runRow()] });
    detail.resolve({ run: runDetail() });
    await rig.route.whenLoaded();

    expect(replaceState).toHaveBeenCalledTimes(hashWritesBeforeDispose);
    expect(rig.root.children).toHaveLength(0);
  });

  it('drops Chat-origin context after the user selects a different run', async () => {
    const replaceState = vi.fn();
    const rig = mountRoute({
      initialRunId: 'run-1',
      chatReturn: {
        sessionId: 'chat-1',
        planId: 'plan-1',
      },
      replaceState,
    });
    await rig.route.whenLoaded();

    await rig.route.openRun('run-2');

    expect(replaceState).toHaveBeenLastCalledWith(null, '', '#logs/run-2');
    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).not.toContain(LOGS_ROUTE_CHAT_RETURN_ATTR);
    expect(html).not.toContain('Back to this Chat action');

    rig.route.dispose();
  });

  it('D-210 Phase C — renders NO approval link for an AWAITING run with no ask id', async () => {
    // ⚠ RE-AIMED. This test used to assert the link degraded to the bare
    // `#approvals` queue. That was a DEAD LINK: the queue is ask-store-backed,
    // so it cannot contain a hold that has no ask — the user landed on an
    // empty queue while their item really was waiting. Phase C made this state
    // routine (a notify-mode reception hold is ask-less on purpose), so the
    // dead link went from rare to normal. No link beats a lying one.
    const getCaller = vi.fn<RunsGetCaller>(async () => {
      const d = runDetail('awaiting_approval', 'approval-requested');
      // Strip the pending-ask id (omit, not explicit-undefined).
      const { ask_id: _a, ...approvals } = d.approvals;
      const { ask_id: _b, ...audit } = d.audit;
      return { run: { ...d, approvals, audit } };
    });
    const rig = mountRoute({ getCaller });
    await rig.route.whenLoaded();
    await rig.route.openRun('run-1');
    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).not.toContain('href="#approvals"');
    expect(html).not.toContain('#approvals/');
    // Suppressing the LINK must not blank the pane — the run is still there,
    // and its awaiting status is still what the reader came for.
    expect(html).toContain('awaiting approval');
    expect(html).toContain('The run is waiting for your yes');
    expect(html).toContain('That step has not happened.');
    expect(html).toContain('This is not in your approvals list.');
    expect(html).not.toContain('Look at this run');
    rig.route.dispose();
  });

  it('D-210 Phase C — an awaiting run WITH an ask id keeps its run-scoped link', async () => {
    // The other side of the fence: suppression must be narrow. A hold that
    // really is in the queue still deep-links to its own card.
    const rig = mountRoute();
    await rig.route.whenLoaded();
    await rig.route.openRun('run-1');
    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain('#approvals/ask-1');
    expect(html).toContain('Look at this run');
    rig.route.dispose();
  });

  it('D-210 Phase C — a RELEASED-after-approval run keeps the bare-queue degrade', async () => {
    // R17's original intent, deliberately preserved: the ask has closed, so
    // there is no card to focus, but the queue is a truthful destination for a
    // run whose approval already happened.
    const getCaller = vi.fn<RunsGetCaller>(async () => {
      const d = runDetail('succeeded', 'released-after-approval');
      const { ask_id: _a, ...approvals } = d.approvals;
      const { ask_id: _b, ...audit } = d.audit;
      return { run: { ...d, approvals, audit } };
    });
    const rig = mountRoute({ getCaller });
    await rig.route.whenLoaded();
    await rig.route.openRun('run-1');
    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain('href="#approvals"');
    expect(html).toContain('Approval result: Approved');
    expect(html).not.toContain('Outcome: allow');
    rig.route.dispose();
  });

  it('syncs the URL through the replace-only History fallback when a run opens', async () => {
    const replaceState = vi.fn();
    const onHashSync = vi.fn();
    const rig = mountRoute({ replaceState, onHashSync });
    await rig.route.whenLoaded();

    await rig.route.openRun('run-1');
    expect(replaceState).toHaveBeenCalledWith(null, '', '#logs/run-1');
    expect(onHashSync).toHaveBeenCalledWith('#logs/run-1');

    rig.route.dispose();
  });

  it('pushes list-to-run navigation so native Back returns to History', async () => {
    const calls: string[] = [];
    const rig = mountRoute({
      replaceState: (_data, _unused, url) => {
        calls.push(`replace ${String(url)}`);
      },
      pushState: (_data, _unused, url) => {
        calls.push(`push ${String(url)}`);
      },
    });
    await rig.route.whenLoaded();

    await rig.route.openRun('run-1');
    await rig.route.openRun('run-2');

    expect(calls).toEqual([
      'push #logs/run-1',
      'replace #logs/run-2',
    ]);
    rig.route.dispose();
  });

  it('does not desync the shell cache when replaceState rejects the run URL', async () => {
    const onHashSync = vi.fn();
    const rig = mountRoute({
      replaceState: vi.fn(() => {
        throw new Error('history unavailable');
      }),
      onHashSync,
    });
    await rig.route.whenLoaded();

    await rig.route.openRun('run-1');
    expect(onHashSync).not.toHaveBeenCalled();

    rig.route.dispose();
  });

  it('console view (#logs/active) does not sync the run hash — it owns no run selection', async () => {
    const replaceState = vi.fn();
    const doc = makeFakeDocument();
    (doc as unknown as { defaultView: unknown }).defaultView = {
      history: { replaceState },
    };
    const root = doc.createElement('div');
    const route = bootstrapLogsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialView: 'active',
      listCaller: vi.fn<RunsListCaller>(async () => ({ runs: [] })),
      activeCaller: vi.fn<RunsActiveCaller>(async () => ({ entries: [], lanes: [] })),
      getCaller: vi.fn<RunsGetCaller>(async () => ({ run: runDetail() })),
      now: () => NOW,
    });
    await route.whenLoaded();
    await route.openRun('run-1');
    expect(replaceState).not.toHaveBeenCalled();
    route.dispose();
  });

  it('disposes the route and live refresh subscriptions', async () => {
    const unsubscribers = [vi.fn(), vi.fn()];
    const subscribeKinds: string[] = [];
    let nextUnsubscriber = 0;
    const subscribe: LogsRouteSubscribe = (kind) => {
      subscribeKinds.push(kind);
      const unsubscribe = unsubscribers[nextUnsubscriber]!;
      nextUnsubscriber += 1;
      return unsubscribe;
    };
    const rig = mountRoute({ subscribe });
    await rig.route.whenLoaded();

    expect(subscribeKinds).toEqual([
      'session_lifecycle',
      'notification.ask_closed',
    ]);

    rig.route.dispose();
    expect(rig.root.children).toHaveLength(0);
    expect(unsubscribers.every((fn) => fn.mock.calls.length === 1)).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────
// D-181 slice 5b — the live Active section + failed/killed error chip.
// ───────────────────────────────────────────────────────────────────────

const runEntry = (
  overrides: Partial<ActiveExecutionEntry> = {},
): ActiveExecutionEntry => ({
  entry_kind: 'run',
  run_id: 'run-active-1',
  recipe_id: 'docs/normalize-document',
  step_id: 'parse',
  lane: 'local-heavy',
  state: 'running',
  origin: 'attended',
  source: {
    channel: 'user',
    actor: 'user_self',
    user_id: 'user-1',
    client_token_id: 'client-1',
  },
  started_at: NOW - 5_000,
  slot_acquired_at: NOW - 4_000,
  progress: { contract: 'file-growth', last_signal_at: NOW - 500, stalled: false },
  kill: { mechanism: 'sigkill', pid: 4242 },
  ...overrides,
});

const queuedEntry = (
  overrides: Partial<ActiveExecutionEntry> = {},
): ActiveExecutionEntry => ({
  entry_kind: 'queued-call',
  queued_call_id: 'call-7',
  run_id: 'run-active-2',
  recipe_id: 'media/transcode',
  lane: 'local-heavy',
  state: 'waiting_slot',
  origin: 'unattended',
  source: {
    channel: 'schedule',
    actor: 'system',
    cron: '0 * * * *',
    source_recipe: 'media/transcode',
  },
  started_at: NOW - 2_000,
  progress: { contract: 'silent', stalled: false },
  kill: { mechanism: 'abandon_await', run_id: 'run-active-2' },
  ...overrides,
});

const activeEntryIdForTest = (entry: ActiveExecutionEntry): string =>
  entry.entry_kind === 'queued-call'
    ? entry.queued_call_id ?? entry.run_id ?? ''
    : entry.run_id ?? '';

const lane = (overrides: Partial<LaneStatus> = {}): LaneStatus => ({
  lane: 'local-heavy',
  capacity: 2,
  in_use: 2,
  queued: 1,
  oldest_wait_ms: 12 * 60 * 1000,
  ...overrides,
});

const mountActive = (overrides: {
  activeResponse?: { entries: ActiveExecutionEntry[]; lanes: LaneStatus[] };
  activeCaller?: RunsActiveCaller;
  killCaller?: RunsKillCaller;
  cancelCaller?: RunsCancelCaller;
  promoteCaller?: RunsPromoteCaller;
  subscribe?: LogsRouteSubscribe;
  activeRefreshDebounceMs?: number;
} = {}) => {
  const doc = makeFakeDocument();
  const root = doc.createElement('div');
  const activeCaller =
    overrides.activeCaller
    ?? vi.fn<RunsActiveCaller>(async () =>
      overrides.activeResponse ?? { entries: [runEntry(), queuedEntry()], lanes: [lane()] });
  const route = bootstrapLogsRoute({
    root: root as unknown as HTMLElement,
    document: doc as unknown as Document,
    // R17 — the full Active section (lanes + kill/cancel/promote) lives in the
    // #logs/active console view; mount there to exercise it.
    initialView: 'active',
    listCaller: vi.fn<RunsListCaller>(async () => ({ runs: [] })),
    activeCaller,
    ...(overrides.killCaller !== undefined ? { killCaller: overrides.killCaller } : {}),
    ...(overrides.cancelCaller !== undefined ? { cancelCaller: overrides.cancelCaller } : {}),
    ...(overrides.promoteCaller !== undefined ? { promoteCaller: overrides.promoteCaller } : {}),
    // Immediate (synchronous) bus-delta refresh by default so the wiring is
    // deterministic; the debounced production path is exercised separately.
    activeRefreshDebounceMs: overrides.activeRefreshDebounceMs ?? 0,
    now: () => NOW,
    ...(overrides.subscribe !== undefined ? { subscribe: overrides.subscribe } : {}),
  });
  const html = () => root.children[0]?.innerHTML ?? '';
  return { doc, root, route, activeCaller, html };
};

describe('D-181 slice 5b — Runs Active section', () => {
  it('renders the execution.active list with lanes, a run Kill control, and queued Cancel/Promote controls', async () => {
    const rig = mountActive();
    await rig.route.whenLoaded();

    expect(rig.activeCaller).toHaveBeenCalledWith({});
    expect(rig.route.getActiveEntries().map((entry) => entry.entry_kind)).toEqual([
      'run',
      'queued-call',
    ]);
    expect(rig.route.getLanes()[0]?.lane).toBe('local-heavy');

    const html = rig.html();
    expect(html).toContain(LOGS_ROUTE_ACTIVE_ATTR);
    expect(html).toContain(LOGS_ROUTE_ACTIVE_ROW_ATTR);
    expect(html).toContain(LOGS_ROUTE_LANES_ATTR);
    // Lane occupancy + oldest-wait formatting.
    expect(html).toContain('local-heavy 2/2');
    expect(html).toContain('oldest 12m');
    // The run entry exposes a Kill button bound to its run_id; the queued call
    // exposes Cancel + Promote bound to its queued_call_id.
    expect(html).toContain('kill-run');
    expect(html).toContain('data-run-id="run-active-1"');
    expect(html).toContain(
      'aria-label="Kill docs/normalize-document · parse (run-active-1)"',
    );
    expect(html).toContain('cancel-call');
    expect(html).toContain('promote-call');
    expect(html).toContain('data-queued-call-id="call-7"');
    expect(html).toContain(
      'aria-label="Promote media/transcode (call-7)"',
    );
    expect(html).toContain(
      'aria-label="Cancel media/transcode (call-7)"',
    );

    rig.route.dispose();
  });

  it('renders a killed-but-not-yet-retired run as "stopping…" (slice-4 #1 instant feedback)', async () => {
    const rig = mountActive({
      activeResponse: { entries: [runEntry({ state: 'stopping' })], lanes: [lane()] },
    });
    await rig.route.whenLoaded();
    expect(rig.html()).toContain('stopping…');
    rig.route.dispose();
  });

  it('renders manual Active refresh as a focusable busy action', async () => {
    const refresh = deferred<Awaited<ReturnType<RunsActiveCaller>>>();
    let calls = 0;
    const activeCaller = vi.fn<RunsActiveCaller>(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          entries: [runEntry(), queuedEntry()],
          lanes: [lane()],
        });
      }
      return refresh.promise;
    });
    const rig = mountActive({ activeCaller });
    await rig.route.whenLoaded();

    const pending = rig.route.refreshActive();
    expect(rig.html()).toContain(
      'data-recued-logs-action="refresh-active" '
      + 'aria-label="Refreshing… active runs" aria-disabled="true" '
      + 'aria-busy="true">Refreshing…',
    );
    expect(rig.html()).not.toContain(
      'data-recued-logs-action="refresh-active" disabled',
    );

    refresh.resolve({ entries: [runEntry()], lanes: [lane()] });
    await pending;
    expect(rig.html()).toContain(
      'data-recued-logs-action="refresh-active" '
      + 'aria-label="Refresh active runs">Refresh',
    );
    rig.route.dispose();
  });

  it('Active section is absent when no activeCaller is wired', async () => {
    const rig = mountRoute();
    await rig.route.whenLoaded();
    expect(rig.root.children[0]?.innerHTML ?? '').not.toContain(LOGS_ROUTE_ACTIVE_ATTR);
    expect(rig.route.getActiveEntries()).toEqual([]);
    expect(rig.route.getLanes()).toEqual([]);
    rig.route.dispose();
  });

  it('killRun calls execution.kill and re-lists the active snapshot', async () => {
    const kill = deferred<{ status: 'killed' }>();
    const killCaller = vi.fn<RunsKillCaller>(() => kill.promise);
    const rig = mountActive({ killCaller });
    await rig.route.whenLoaded();
    expect(rig.activeCaller).toHaveBeenCalledTimes(1);

    const pending = rig.route.killRun('run-active-1');
    expect(rig.route.hasInFlightWork()).toBe(true);
    expect(rig.route.inFlightWorkPrompt()).toBe(
      'A run action is still in progress. Leave Logs anyway?',
    );
    expect(rig.html()).toContain('Killing…');
    expect(rig.html()).toContain(
      'data-run-id="run-active-1" '
      + 'aria-label="Killing… docs/normalize-document · parse (run-active-1)" '
      + 'aria-disabled="true" aria-busy="true"',
    );
    expect(rig.html()).not.toContain(
      'data-run-id="run-active-1" disabled',
    );
    await rig.route.killRun('run-active-1');
    expect(killCaller).toHaveBeenCalledTimes(1);
    kill.resolve({ status: 'killed' });
    await pending;

    expect(killCaller).toHaveBeenCalledWith({ run_id: 'run-active-1' });
    expect(rig.route.hasInFlightWork()).toBe(false);
    expect(rig.route.inFlightWorkPrompt()).toBeNull();
    // Re-listed after the mutation.
    expect(rig.activeCaller).toHaveBeenCalledTimes(2);
    rig.route.dispose();
  });

  it('keeps an acknowledged kill retired when the follow-up active read fails', async () => {
    const followup = deferred<Awaited<ReturnType<RunsActiveCaller>>>();
    let activeCalls = 0;
    const activeCaller = vi.fn<RunsActiveCaller>(() => {
      activeCalls += 1;
      return activeCalls === 1
        ? Promise.resolve({ entries: [runEntry(), queuedEntry()], lanes: [lane()] })
        : followup.promise;
    });
    const kill = deferred<{ status: 'killed' }>();
    const rig = mountActive({
      activeCaller,
      killCaller: vi.fn(() => kill.promise),
    });
    await rig.route.whenLoaded();

    const pending = rig.route.killRun('run-active-1');
    kill.resolve({ status: 'killed' });
    await Promise.resolve();
    await Promise.resolve();

    expect(rig.route.hasInFlightWork()).toBe(true);
    expect(rig.route.getActiveEntries().map((entry) => entry.run_id))
      .not.toContain('run-active-1');
    expect(rig.html()).not.toContain(
      `${LOGS_ROUTE_ACTIVE_ROW_ATTR}="run-active-1"`,
    );

    followup.reject(new Error('active reconciliation unavailable'));
    await pending;
    expect(rig.route.hasInFlightWork()).toBe(false);
    expect(rig.route.getActiveEntries().map((entry) => entry.run_id))
      .not.toContain('run-active-1');
    expect(rig.html()).toContain('active reconciliation unavailable');
    expect(rig.html()).toContain(`${LOGS_ROUTE_ACTIVE_ROW_ATTR}="call-7"`);

    rig.route.dispose();
  });

  it('filters a stale post-kill snapshot until absence releases the run id', async () => {
    const snapshots = [
      { entries: [runEntry(), queuedEntry()], lanes: [lane()] },
      { entries: [runEntry(), queuedEntry()], lanes: [lane()] }, // stale
      { entries: [queuedEntry()], lanes: [lane()] }, // clears tombstone
      { entries: [runEntry(), queuedEntry()], lanes: [lane()] }, // reused id
    ];
    const activeCaller = vi.fn<RunsActiveCaller>(async () => snapshots.shift()!);
    const rig = mountActive({
      activeCaller,
      killCaller: vi.fn(async () => ({ status: 'killed' as const })),
    });
    await rig.route.whenLoaded();

    await rig.route.killRun('run-active-1');
    expect(rig.route.getActiveEntries().map(activeEntryIdForTest))
      .toEqual(['call-7']);
    await rig.route.refreshActive();
    expect(rig.route.getActiveEntries().map(activeEntryIdForTest))
      .toEqual(['call-7']);
    await rig.route.refreshActive();
    expect(rig.route.getActiveEntries().map(activeEntryIdForTest))
      .toEqual(['run-active-1', 'call-7']);

    rig.route.dispose();
  });

  it('a non-terminal kill verdict (already_terminal) surfaces a legible notice', async () => {
    const killCaller = vi.fn<RunsKillCaller>(async () => ({
      status: 'already_terminal' as const,
    }));
    const rig = mountActive({ killCaller });
    await rig.route.whenLoaded();

    await rig.route.killRun('run-active-1');

    expect(rig.html()).toContain('That run has already finished.');
    rig.route.dispose();
  });

  it('cancelCall / promoteCall drive their rpc + re-list; already_dispatched surfaces a notice', async () => {
    const cancel = deferred<{ status: 'already_dispatched' }>();
    const promote = deferred<{ status: 'promoted' }>();
    const cancelCaller = vi.fn<RunsCancelCaller>(() => cancel.promise);
    const promoteCaller = vi.fn<RunsPromoteCaller>(() => promote.promise);
    const rig = mountActive({ cancelCaller, promoteCaller });
    await rig.route.whenLoaded();

    const pendingPromote = rig.route.promoteCall('call-7');
    expect(rig.html()).toContain('Promoting…');
    expect(rig.html()).toContain(
      'data-recued-logs-action="promote-call" '
      + 'data-queued-call-id="call-7" '
      + 'aria-label="Promoting… media/transcode (call-7)" '
      + 'aria-disabled="true" '
      + 'aria-busy="true"',
    );
    expect(rig.html()).toContain(
      'data-recued-logs-action="cancel-call" '
      + 'data-queued-call-id="call-7" '
      + 'aria-label="Cancel media/transcode (call-7)" '
      + 'aria-disabled="true">Cancel',
    );
    expect(rig.html()).not.toContain('data-queued-call-id="call-7" disabled');
    await rig.route.cancelCall('call-7');
    expect(cancelCaller).not.toHaveBeenCalled();
    promote.resolve({ status: 'promoted' });
    await pendingPromote;
    expect(promoteCaller).toHaveBeenCalledWith({ queued_call_id: 'call-7' });
    rig.route.dispose();

    // A promoted call is authoritatively retired, so exercise the independent
    // non-terminal Cancel verdict on a fresh active snapshot.
    const cancelRig = mountActive({ cancelCaller });
    await cancelRig.route.whenLoaded();
    const pendingCancel = cancelRig.route.cancelCall('call-7');
    expect(cancelRig.html()).toContain('Cancelling…');
    expect(cancelRig.html()).toContain(
      'data-recued-logs-action="cancel-call" '
      + 'data-queued-call-id="call-7" '
      + 'aria-label="Cancelling… media/transcode (call-7)" '
      + 'aria-disabled="true" '
      + 'aria-busy="true"',
    );
    expect(cancelRig.html()).toContain(
      'data-recued-logs-action="promote-call" '
      + 'data-queued-call-id="call-7" '
      + 'aria-label="Promote media/transcode (call-7)" '
      + 'aria-disabled="true">Promote',
    );
    cancel.resolve({ status: 'already_dispatched' });
    await pendingCancel;
    expect(cancelCaller).toHaveBeenCalledWith({ queued_call_id: 'call-7' });
    expect(cancelRig.html()).toContain('That has already started');
    cancelRig.route.dispose();
  });

  it('subscribes to execution deltas; re-lists on a control op but ignores progress ticks', async () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const subscribe: LogsRouteSubscribe = ((kind: string, listener: (event: unknown) => void) => {
      listeners.set(kind, listener);
      return () => listeners.delete(kind);
    }) as unknown as LogsRouteSubscribe;
    const rig = mountActive({ subscribe });
    await rig.route.whenLoaded();

    expect(listeners.has('execution')).toBe(true);
    expect(rig.activeCaller).toHaveBeenCalledTimes(1);

    // A high-frequency progress tick must NOT re-list.
    listeners.get('execution')!({
      kind: 'execution',
      recipe_id: 'r',
      run_id: 'u',
      op: 'progress',
      cursor: 1,
    });
    await Promise.resolve();
    expect(rig.activeCaller).toHaveBeenCalledTimes(1);

    // A membership-changing op (killed) re-lists.
    listeners.get('execution')!({
      kind: 'execution',
      recipe_id: 'r',
      run_id: 'u',
      op: 'killed',
      cursor: 2,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(rig.activeCaller).toHaveBeenCalledTimes(2);

    rig.route.dispose();
  });

  it('debounces a delta burst into ONE trailing refresh (outlasts the emit-start-before-registerRun race)', async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Map<string, (event: unknown) => void>();
      const subscribe: LogsRouteSubscribe = ((kind: string, listener: (event: unknown) => void) => {
        listeners.set(kind, listener);
        return () => listeners.delete(kind);
      }) as unknown as LogsRouteSubscribe;
      const rig = mountActive({ subscribe, activeRefreshDebounceMs: 250 });
      await rig.route.whenLoaded();
      expect(rig.activeCaller).toHaveBeenCalledTimes(1);

      // A `start` then a `slot_acquired` in quick succession.
      listeners.get('execution')!({
        kind: 'execution', recipe_id: 'r', run_id: 'u', op: 'start', cursor: 1,
      });
      listeners.get('execution')!({
        kind: 'execution', recipe_id: 'r', run_id: 'u', op: 'slot_acquired', cursor: 2,
      });
      // No refresh yet — the debounce window is still open.
      expect(rig.activeCaller).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(250);
      // The burst coalesced into exactly one trailing snapshot.
      expect(rig.activeCaller).toHaveBeenCalledTimes(2);

      rig.route.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a queued bus delta re-lists and surfaces a mid-run queued call (no catch-up poll)', async () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const subscribe: LogsRouteSubscribe = ((kind: string, listener: (event: unknown) => void) => {
      listeners.set(kind, listener);
      return () => listeners.delete(kind);
    }) as unknown as LogsRouteSubscribe;
    // First snapshot: one active run. After the `queued` delta: the run plus the
    // queued call that entered a lane mid-run (slice-4 follow-up #2 — the
    // governor now fans this membership delta, so no poll is needed).
    const activeCaller = vi
      .fn<RunsActiveCaller>()
      .mockResolvedValueOnce({ entries: [runEntry()], lanes: [lane({ queued: 0 })] })
      .mockResolvedValue({ entries: [runEntry(), queuedEntry()], lanes: [lane()] });
    const rig = mountActive({ activeCaller, subscribe });
    await rig.route.whenLoaded();
    expect(rig.activeCaller).toHaveBeenCalledTimes(1);
    expect(rig.route.getActiveEntries()).toHaveLength(1);

    // The governor's `queued` delta drives the re-list; the queued call appears
    // off the bus alone.
    listeners.get('execution')!({
      kind: 'execution',
      recipe_id: 'r',
      run_id: 'u',
      op: 'queued',
      queued_call_id: 'call_1',
      lane: 'local-heavy',
      cursor: 1,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(rig.activeCaller).toHaveBeenCalledTimes(2);
    expect(rig.route.getActiveEntries().map((entry) => entry.entry_kind)).toEqual([
      'run',
      'queued-call',
    ]);

    rig.route.dispose();
  });

  it('a retired bus delta drops a run with no lifecycle terminal (durable-pause / trigger-skip exit)', async () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const subscribe: LogsRouteSubscribe = ((kind: string, listener: (event: unknown) => void) => {
      listeners.set(kind, listener);
      return () => listeners.delete(kind);
    }) as unknown as LogsRouteSubscribe;
    // First snapshot: one active run. After the `retired` delta (the registry
    // completeRun'd it on a durable-pause exit — no complete/error fired): empty.
    const activeCaller = vi
      .fn<RunsActiveCaller>()
      .mockResolvedValueOnce({ entries: [runEntry()], lanes: [lane()] })
      .mockResolvedValue({ entries: [], lanes: [] });
    const rig = mountActive({ activeCaller, subscribe });
    await rig.route.whenLoaded();
    expect(rig.route.getActiveEntries()).toHaveLength(1);

    listeners.get('execution')!({
      kind: 'execution',
      recipe_id: 'r',
      run_id: 'u',
      op: 'retired',
      cursor: 1,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(rig.activeCaller).toHaveBeenCalledTimes(2);
    expect(rig.route.getActiveEntries()).toHaveLength(0);

    rig.route.dispose();
  });

  it('makes no further rpc calls over time without a bus delta (the catch-up poll is retired)', async () => {
    vi.useFakeTimers();
    try {
      // A non-empty list is the case the old catch-up poll WOULD have re-listed.
      const activeCaller = vi.fn<RunsActiveCaller>(async () => ({
        entries: [runEntry()],
        lanes: [lane()],
      }));
      const rig = mountActive({ activeCaller });
      await rig.route.whenLoaded();
      expect(rig.activeCaller).toHaveBeenCalledTimes(1);

      // Many poll windows elapse with NO bus delta — the route makes zero extra
      // rpc (no interval exists; membership is bus-driven).
      await vi.advanceTimersByTimeAsync(30000);
      expect(rig.activeCaller).toHaveBeenCalledTimes(1);

      rig.route.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────
// R17 — the default-view Active peek-strip (capped; the full console — lanes +
// kill/cancel/promote + passes — lives at #logs/active).
// ───────────────────────────────────────────────────────────────────────

const mountPeek = (entries: ActiveExecutionEntry[]) => {
  const doc = makeFakeDocument();
  const root = doc.createElement('div');
  const route = bootstrapLogsRoute({
    root: root as unknown as HTMLElement,
    document: doc as unknown as Document,
    // Default ('logs') view — the peek-strip, NOT the console.
    listCaller: vi.fn<RunsListCaller>(async () => ({ runs: [runRow()] })),
    activeCaller: vi.fn<RunsActiveCaller>(async () => ({ entries, lanes: [lane()] })),
    activeRefreshDebounceMs: 0,
    now: () => NOW,
  });
  const html = () => root.children[0]?.innerHTML ?? '';
  return { doc, root, route, html };
};

describe('R17 — Active peek-strip (default #logs view)', () => {
  it('shows a thin "Nothing running" line when idle — never the full console section', async () => {
    const rig = mountPeek([]);
    await rig.route.whenLoaded();
    const html = rig.html();
    expect(html).toContain(LOGS_ROUTE_PEEK_ATTR);
    expect(html).toContain('Nothing running.');
    // The peek is NOT the console: no full Active section, no lanes, no controls.
    expect(html).not.toContain(LOGS_ROUTE_ACTIVE_ATTR);
    expect(html).not.toContain(LOGS_ROUTE_LANES_ATTR);
    expect(html).not.toContain('kill-run');
    // The History table sits below the peek.
    expect(html).toContain('logs-table');
    rig.route.dispose();
  });

  it('shows capped inline glance rows (no controls) + a manage link when short', async () => {
    const rig = mountPeek([
      runEntry(),
      runEntry({ run_id: 'run-active-2', recipe_id: 'r2' }),
    ]);
    await rig.route.whenLoaded();
    const html = rig.html();
    expect(html).toContain('2 running');
    expect(html).toContain('logs-peek-row');
    // Glance-only — acting on a run happens in the console.
    expect(html).not.toContain('kill-run');
    expect(html).not.toContain('promote-call');
    // The manage link deep-links to the console.
    expect(html).toContain('manage ▸');
    expect(html).toContain('href="#logs/active"');
    rig.route.dispose();
  });

  it('collapses to "N running ▸ manage" (no rows) beyond the cap', async () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      runEntry({ run_id: `run-active-${i}`, recipe_id: `r-${i}` }));
    const rig = mountPeek(many);
    await rig.route.whenLoaded();
    const html = rig.html();
    expect(html).toContain('5 running');
    expect(html).toContain('href="#logs/active"');
    // Capped — no inline rows when busy, so History is never buried.
    expect(html).not.toContain('logs-peek-row');
    rig.route.dispose();
  });

  it('console view (#logs/active) renders the full Active section with a back link', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const route = bootstrapLogsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialView: 'active',
      listCaller: vi.fn<RunsListCaller>(async () => ({ runs: [runRow()] })),
      activeCaller: vi.fn<RunsActiveCaller>(async () => ({
        entries: [runEntry()],
        lanes: [lane()],
      })),
      activeRefreshDebounceMs: 0,
      now: () => NOW,
    });
    await route.whenLoaded();
    const html = root.children[0]?.innerHTML ?? '';
    // Full console: the Active section + lanes + the run Kill control.
    expect(html).toContain(LOGS_ROUTE_ACTIVE_ATTR);
    expect(html).toContain(LOGS_ROUTE_LANES_ATTR);
    expect(html).toContain('kill-run');
    // Back to the History view.
    expect(html).toContain('href="#logs"');
    expect(html).toContain('← Logs');
    // The console has no History table or filters.
    expect(html).not.toContain('logs-table');
    expect(html).not.toContain(LOGS_ROUTE_PEEK_ATTR);
    route.dispose();
  });

  it('deep-link (#logs/recipe/<id> → initialRecipeId) opens History pre-filtered to that recipe', async () => {
    const calls: ExecutionListQuery[] = [];
    const listCaller = vi.fn<RunsListCaller>(async (query) => {
      calls.push(query);
      return { runs: [runRow()] };
    });
    const rig = mountRoute({ listCaller, initialRecipeId: 'mail/send-digest' });
    await rig.route.whenLoaded();

    // The very first feed load is already scoped to the deep-linked recipe...
    expect(calls[0]?.recipe_id).toBe('mail/send-digest');
    // ...and the filter state reflects it, so the ref-picker shows it selected.
    expect(rig.route.getFilters().recipe_id).toBe('mail/send-digest');

    rig.route.dispose();
  });
});

describe('D-181 slice 5b — error_category chip', () => {
  it('renders the failed/killed error_category chip on feed rows', async () => {
    const listCaller = vi.fn<RunsListCaller>(async () => ({
      runs: [
        runRow({
          run_id: 'run-killed',
          status: 'killed',
          policy_result: 'allowed',
          error_category: 'killed',
        }),
        runRow({
          run_id: 'run-timeout',
          status: 'failed',
          policy_result: 'allowed',
          error_category: 'timeout',
        }),
        runRow({
          run_id: 'run-ok',
          status: 'succeeded',
          policy_result: 'allowed',
        }),
      ],
    }));
    const rig = mountRoute({ listCaller });
    await rig.route.whenLoaded();

    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain(LOGS_ROUTE_ERROR_CATEGORY_ATTR);
    expect(html).toContain('killed');
    // `timeout` → display copy "timed out".
    expect(html).toContain('timed out');
    rig.route.dispose();
  });

  it('omits the chip on ordinary rows without an error_category', async () => {
    const listCaller = vi.fn<RunsListCaller>(async () => ({
      runs: [runRow({ run_id: 'run-ok', status: 'succeeded', policy_result: 'allowed' })],
    }));
    const rig = mountRoute({ listCaller });
    await rig.route.whenLoaded();
    expect(rig.root.children[0]?.innerHTML ?? '').not.toContain(LOGS_ROUTE_ERROR_CATEGORY_ATTR);
    rig.route.dispose();
  });
});

describe('D-182 — cli failure render', () => {
  it('renders the cli failure chip on a cli-failed feed row', async () => {
    const listCaller = vi.fn<RunsListCaller>(async () => ({
      runs: [
        runRow({
          run_id: 'run-cli', status: 'failed', policy_result: 'allowed',
          cli_failure_reason: 'not_found',
        }),
        runRow({ run_id: 'run-ok', status: 'succeeded', policy_result: 'allowed' }),
      ],
    }));
    const rig = mountRoute({ listCaller });
    await rig.route.whenLoaded();
    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain(LOGS_ROUTE_CLI_FAILURE_ATTR);
    // The label only appears in the rendered chip (not the CSS selector).
    expect(html).toContain('tool not found');
    rig.route.dispose();
  });

  it('renders the cli failure detail (reason/tool/exit/stderr + op) but NOT the raw details blob', async () => {
    const cliError = recipeError({
      code: 'CLI_TOOL_FAILED',
      message: "cli tool 'docling' exited with code 1",
      source: {
        recipe_id: 'mail/send-digest',
        step_id: 'transcribe',
        ingredient_slug: 'recued-core.docling.document.to_markdown',
      },
      details: {
        cli_failure: {
          reason: 'nonzero_exit',
          tool: 'docling',
          exit_code: 1,
          stderr: 'REAL_STDERR_DIAGNOSTIC',
          stderr_truncated: true,
        },
        // A sibling raw key the route must NEVER render (only cli_failure is pulled).
        raw_token: 'super-secret-token',
      },
    });
    const base = runDetail('failed', 'allowed');
    const detail: RunDetail = { ...base, errors: [cliError] };
    const getCaller = vi.fn<RunsGetCaller>(async () => ({ run: detail }));
    const rig = mountRoute({ getCaller });
    await rig.route.whenLoaded();
    await rig.route.openRun('run-1');
    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain('CLI_TOOL_FAILED');
    expect(html).toContain('tool error');                 // nonzero_exit label
    expect(html).toContain('docling');                    // tool + ingredient_slug
    expect(html).toContain('<pre class="logs-cli-stderr"'); // the stderr block element
    expect(html).toContain('REAL_STDERR_DIAGNOSTIC');     // the actual diagnostic
    expect(html).toContain('recued-core.docling.document.to_markdown'); // op
    expect(html).toContain('earlier tool output trimmed'); // truncation note
    // The structured cli_failure renders; the sibling raw details key does NOT.
    expect(html).not.toContain('super-secret-token');
    rig.route.dispose();
  });

  it('renders a not_found cli failure as a label with no stderr block', async () => {
    const cliError = recipeError({
      code: 'CLI_TOOL_NOT_FOUND',
      message: "cli tool 'whisper' was not found",
      source: { recipe_id: 'mail/send-digest', step_id: 's', ingredient_slug: 'recued-core.whisper.x' },
      details: { cli_failure: { reason: 'not_found', tool: 'whisper' } },
    });
    const base = runDetail('failed', 'allowed');
    const getCaller = vi.fn<RunsGetCaller>(async () => ({ run: { ...base, errors: [cliError] } }));
    const rig = mountRoute({ getCaller });
    await rig.route.whenLoaded();
    await rig.route.openRun('run-1');
    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain('tool not found');
    expect(html).toContain('whisper');
    // No stderr → no <pre> element (asserting the element tag, not the CSS class).
    expect(html).not.toContain('<pre class="logs-cli-stderr"');
    rig.route.dispose();
  });
});

// ───────────────────────────────────────────────────────────────────────
// D-186 slice C — the live "Active passes" (session-grant) section.
// ───────────────────────────────────────────────────────────────────────

const sessionGrantView = (
  overrides: Partial<SessionGrantView> = {},
): SessionGrantView => ({
  contract_id: 'ct_pass_1',
  display_name: 'Batched approval send-email (3 items)',
  grant_mode: 'batch',
  permits: {
    ingredient_ids: ['mail.send'],
    operation_ids: ['mail.send'],
    connection_names: ['gmail-primary'],
  },
  risk_tier: 'write',
  channel_session_id: 'chat-1',
  expiry_at: NOW + 5 * 60 * 1000,
  remaining_ttl_ms: 5 * 60 * 1000,
  uses_remaining: 3,
  max_uses: 3,
  member_count: 3,
  lifecycle_state: 'active',
  ...overrides,
});

const mountPasses = (overrides: {
  grants?: SessionGrantView[];
  grantsListCaller?: RunsSessionGrantListCaller;
  grantsRevokeCaller?: RunsSessionGrantRevokeCaller;
  subscribe?: LogsRouteSubscribe;
  activeRefreshDebounceMs?: number;
} = {}) => {
  const doc = makeFakeDocument();
  const root = doc.createElement('div');
  const grantsListCaller =
    overrides.grantsListCaller
    ?? vi.fn<RunsSessionGrantListCaller>(async () => ({
      grants: overrides.grants ?? [sessionGrantView()],
    }));
  const route = bootstrapLogsRoute({
    root: root as unknown as HTMLElement,
    document: doc as unknown as Document,
    // R17 — Active passes live in the #logs/active console view.
    initialView: 'active',
    listCaller: vi.fn<RunsListCaller>(async () => ({ runs: [] })),
    grantsListCaller,
    ...(overrides.grantsRevokeCaller !== undefined
      ? { grantsRevokeCaller: overrides.grantsRevokeCaller }
      : {}),
    // Immediate (synchronous) bus-delta refresh by default so the wiring is
    // deterministic.
    activeRefreshDebounceMs: overrides.activeRefreshDebounceMs ?? 0,
    now: () => NOW,
    ...(overrides.subscribe !== undefined ? { subscribe: overrides.subscribe } : {}),
  });
  const html = () => root.children[0]?.innerHTML ?? '';
  return { doc, root, route, grantsListCaller, html };
};

describe('D-186 slice C — Runs Active passes section', () => {
  it('renders active passes with mode, permits, remaining TTL, budget, and a Revoke control', async () => {
    const rig = mountPasses();
    await rig.route.whenLoaded();

    expect(rig.grantsListCaller).toHaveBeenCalledWith({});
    expect(rig.route.getSessionGrants().map((g) => g.contract_id)).toEqual(['ct_pass_1']);

    const html = rig.html();
    expect(html).toContain(LOGS_ROUTE_PASSES_ATTR);
    expect(html).toContain(LOGS_ROUTE_PASS_ROW_ATTR);
    expect(html).toContain('Active passes');
    expect(html).toContain('Batched approval send-email (3 items)');
    expect(html).toContain('batch'); // mode label
    expect(html).toContain('mail.send'); // permits
    expect(html).toContain('via gmail-primary');
    expect(html).toContain('expires in 5m'); // computed from expiry_at at render
    expect(html).toContain('3 items'); // batch budget
    // The Revoke control is bound to the grant's contract_id.
    expect(html).toContain('revoke-grant');
    expect(html).toContain('data-grant-id="ct_pass_1"');
    expect(html).toContain(
      'aria-label="Revoke Batched approval send-email (3 items) (ct_pass_1)"',
    );
    rig.route.dispose();
  });

  it('summarises an exact grant with operation + uses budget', async () => {
    const rig = mountPasses({
      grants: [sessionGrantView({
        contract_id: 'ct_exact',
        display_name: 'Session grant',
        grant_mode: 'exact',
        permits: { operation_ids: ['hubspot.deal.update'], connection_names: ['hubspot-1'] },
        member_count: undefined,
        uses_remaining: 1,
        max_uses: 1,
      })],
    });
    await rig.route.whenLoaded();
    const html = rig.html();
    expect(html).toContain('one call'); // exact mode label
    expect(html).toContain('hubspot.deal.update via hubspot-1');
    expect(html).toContain('1/1 uses left');
    rig.route.dispose();
  });

  it('shows the empty state when there are no active passes', async () => {
    const rig = mountPasses({ grants: [] });
    await rig.route.whenLoaded();
    expect(rig.html()).toContain('No active passes.');
    rig.route.dispose();
  });

  it('renders manual pass refresh as a focusable busy action', async () => {
    const refresh = deferred<
      Awaited<ReturnType<RunsSessionGrantListCaller>>
    >();
    let calls = 0;
    const grantsListCaller = vi.fn<RunsSessionGrantListCaller>(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({ grants: [sessionGrantView()] });
      }
      return refresh.promise;
    });
    const rig = mountPasses({ grantsListCaller });
    await rig.route.whenLoaded();

    const pending = rig.route.refreshGrants();
    expect(rig.html()).toContain(
      'data-recued-logs-action="refresh-passes" '
      + 'aria-label="Refreshing… active passes" aria-disabled="true" '
      + 'aria-busy="true">Refreshing…',
    );
    expect(rig.html()).not.toContain(
      'data-recued-logs-action="refresh-passes" disabled',
    );

    refresh.resolve({ grants: [sessionGrantView()] });
    await pending;
    expect(rig.html()).toContain(
      'data-recued-logs-action="refresh-passes" '
      + 'aria-label="Refresh active passes">Refresh',
    );
    rig.route.dispose();
  });

  it('Active passes section is absent when no grantsListCaller is wired', async () => {
    const rig = mountActive(); // wires activeCaller, NOT grantsListCaller
    await rig.route.whenLoaded();
    expect(rig.html()).not.toContain(LOGS_ROUTE_PASSES_ATTR);
    expect(rig.route.getSessionGrants()).toEqual([]);
    rig.route.dispose();
  });

  it('revokeGrant drives session_grant.revoke and re-lists', async () => {
    const revoke = deferred<SessionGrantView>();
    let firstActive = true;
    const first = sessionGrantView();
    const second = sessionGrantView({ contract_id: 'ct_pass_2' });
    const grantsListCaller = vi.fn<RunsSessionGrantListCaller>(async () => ({
      grants: firstActive ? [first, second] : [second],
    }));
    const grantsRevokeCaller = vi.fn<RunsSessionGrantRevokeCaller>(
      () => revoke.promise,
    );
    const rig = mountPasses({ grantsListCaller, grantsRevokeCaller });
    await rig.route.whenLoaded();
    expect(rig.grantsListCaller).toHaveBeenCalledTimes(1);

    const pending = rig.route.revokeGrant('ct_pass_1');
    expect(rig.route.hasInFlightWork()).toBe(true);
    expect(rig.route.inFlightWorkPrompt()).toBe(
      'A run action is still in progress. Leave Logs anyway?',
    );
    expect(rig.html()).toContain('Revoking…');
    expect(rig.html()).toContain(
      'data-grant-id="ct_pass_1" '
      + 'aria-label="Revoking… Batched approval send-email (3 items) (ct_pass_1)" '
      + 'aria-disabled="true" aria-busy="true"',
    );
    expect(rig.html()).not.toContain('data-grant-id="ct_pass_1" disabled');
    await rig.route.revokeGrant('ct_pass_1');
    expect(grantsRevokeCaller).toHaveBeenCalledTimes(1);
    firstActive = false;
    revoke.resolve(sessionGrantView({ lifecycle_state: 'revoked' }));
    await pending;

    expect(grantsRevokeCaller).toHaveBeenCalledWith({ contract_id: 'ct_pass_1' });
    expect(rig.route.hasInFlightWork()).toBe(false);
    expect(rig.route.inFlightWorkPrompt()).toBeNull();
    // Re-listed after the revoke.
    expect(rig.grantsListCaller).toHaveBeenCalledTimes(2);
    rig.route.dispose();
  });

  it('keeps an acknowledged pass revoke retired when its follow-up read fails', async () => {
    const followup = deferred<Awaited<ReturnType<RunsSessionGrantListCaller>>>();
    let listCalls = 0;
    const first = sessionGrantView();
    const second = sessionGrantView({ contract_id: 'ct_pass_2' });
    const grantsListCaller = vi.fn<RunsSessionGrantListCaller>(() => {
      listCalls += 1;
      return listCalls === 1
        ? Promise.resolve({ grants: [first, second] })
        : followup.promise;
    });
    const revoke = deferred<SessionGrantView>();
    const rig = mountPasses({
      grantsListCaller,
      grantsRevokeCaller: vi.fn(() => revoke.promise),
    });
    await rig.route.whenLoaded();

    const pending = rig.route.revokeGrant('ct_pass_1');
    revoke.resolve(sessionGrantView({ lifecycle_state: 'revoked' }));
    await Promise.resolve();
    await Promise.resolve();

    expect(rig.route.hasInFlightWork()).toBe(true);
    expect(rig.route.getSessionGrants().map((grant) => grant.contract_id))
      .toEqual(['ct_pass_2']);
    expect(rig.html()).not.toContain(`${LOGS_ROUTE_PASS_ROW_ATTR}="ct_pass_1"`);

    followup.reject(new Error('pass reconciliation unavailable'));
    await pending;
    expect(rig.route.hasInFlightWork()).toBe(false);
    expect(rig.route.getSessionGrants().map((grant) => grant.contract_id))
      .toEqual(['ct_pass_2']);
    expect(rig.html()).toContain('pass reconciliation unavailable');
    expect(rig.html()).toContain(`${LOGS_ROUTE_PASS_ROW_ATTR}="ct_pass_2"`);

    rig.route.dispose();
  });

  it('filters a stale post-revoke pass snapshot until absence releases its id', async () => {
    const first = sessionGrantView();
    const second = sessionGrantView({ contract_id: 'ct_pass_2' });
    const snapshots = [
      { grants: [first, second] },
      { grants: [first, second] }, // stale
      { grants: [second] }, // clears tombstone
      { grants: [first, second] }, // reused id
    ];
    const grantsListCaller = vi.fn<RunsSessionGrantListCaller>(
      async () => snapshots.shift()!,
    );
    const rig = mountPasses({
      grantsListCaller,
      grantsRevokeCaller: vi.fn(async () =>
        sessionGrantView({ lifecycle_state: 'revoked' })),
    });
    await rig.route.whenLoaded();

    await rig.route.revokeGrant('ct_pass_1');
    expect(rig.route.getSessionGrants().map((grant) => grant.contract_id))
      .toEqual(['ct_pass_2']);
    await rig.route.refreshGrants();
    expect(rig.route.getSessionGrants().map((grant) => grant.contract_id))
      .toEqual(['ct_pass_2']);
    await rig.route.refreshGrants();
    expect(rig.route.getSessionGrants().map((grant) => grant.contract_id))
      .toEqual(['ct_pass_1', 'ct_pass_2']);

    rig.route.dispose();
  });

  it('surfaces a legible notice when the revoke caller rejects (e.g. already gone)', async () => {
    const grantsRevokeCaller = vi.fn<RunsSessionGrantRevokeCaller>(async () => {
      throw new Error('no active session grant');
    });
    const rig = mountPasses({ grantsRevokeCaller });
    await rig.route.whenLoaded();

    await rig.route.revokeGrant('ct_pass_1');

    expect(rig.html()).toContain('no active session grant');
    rig.route.dispose();
  });

  it('re-lists off the contract.contract_definition_changed bus kind', async () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const subscribe: LogsRouteSubscribe = ((kind: string, listener: (event: unknown) => void) => {
      listeners.set(kind, listener);
      return () => listeners.delete(kind);
    }) as unknown as LogsRouteSubscribe;
    const rig = mountPasses({ subscribe });
    await rig.route.whenLoaded();

    expect(listeners.has('contract.contract_definition_changed')).toBe(true);
    expect(rig.grantsListCaller).toHaveBeenCalledTimes(1);

    // A peer minting / revoking a pass re-lists.
    listeners.get('contract.contract_definition_changed')!({
      kind: 'contract.contract_definition_changed',
      op: 'mint',
      contract_id: 'ct_other',
      cursor: 1,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(rig.grantsListCaller).toHaveBeenCalledTimes(2);

    rig.route.dispose();
  });

  it('HTML-escapes the grant display_name', async () => {
    const rig = mountPasses({
      grants: [sessionGrantView({ display_name: 'evil <img src=x> "pass"' })],
    });
    await rig.route.whenLoaded();
    const html = rig.html();
    expect(html).toContain('evil &lt;img src=x&gt; &quot;pass&quot;');
    expect(html).not.toContain('<img src=x>');
    rig.route.dispose();
  });

  it('disposes the contract subscription', async () => {
    const unsubscribe = vi.fn();
    const subscribeKinds: string[] = [];
    const subscribe: LogsRouteSubscribe = ((kind: string) => {
      subscribeKinds.push(kind);
      return unsubscribe;
    }) as unknown as LogsRouteSubscribe;
    const rig = mountPasses({ subscribe });
    await rig.route.whenLoaded();
    expect(subscribeKinds).toContain('contract.contract_definition_changed');

    rig.route.dispose();
    expect(rig.root.children).toHaveLength(0);
    // Every subscription (incl. the passes one) was torn down.
    expect(unsubscribe.mock.calls.length).toBe(subscribeKinds.length);
  });
});

describe('D-237 P2 residual — the all-refused run is visible to a reader', () => {
  // ⛔ P2's own suite passed once with its wiring SEVERED, which is why the
  // first test here starts where the value ARRIVES (the `execution.get`
  // response) and asserts the rendered DOM. A pure-projection test cannot tell
  // "the notice is computed" from "the notice is computed and shown".
  it('renders the notice and refuses to leave a succeeded run reading positive', async () => {
    const getCaller = vi.fn<RunsGetCaller>(async () => ({
      run: runDetail('succeeded', 'allowed', {
        errors: [],
        runYield: {
          steps_run: 1,
          steps_skipped: 0,
          items_total: 12,
          items_failed: 12,
        },
      }),
    }));
    const rig = mountRoute({ getCaller, initialRunId: 'run-1' });
    await rig.route.whenLoaded();

    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain(`${LOGS_ROUTE_YIELD_ATTR}="all-refused"`);
    expect(html).toContain('All 12 things this run touched failed.');
    // The whole point: a green status must not read green here.
    expect(html).toContain(
      `${LOGS_ROUTE_OUTCOME_ATTR}="succeeded" data-tone="attention"`,
    );
    expect(html).toContain('Look at the steps below to see what was refused');

    rig.route.dispose();
  });

  it('reports a partial failure without escalating the tone', async () => {
    const getCaller = vi.fn<RunsGetCaller>(async () => ({
      run: runDetail('succeeded', 'allowed', {
        errors: [],
        runYield: {
          steps_run: 2,
          steps_skipped: 0,
          items_total: 400,
          items_failed: 3,
        },
      }),
    }));
    const rig = mountRoute({ getCaller, initialRunId: 'run-1' });
    await rig.route.whenLoaded();

    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).toContain(`${LOGS_ROUTE_YIELD_ATTR}="partial-failure"`);
    expect(html).toContain('3 of 400 failed.');
    expect(html).toContain(
      `${LOGS_ROUTE_OUTCOME_ATTR}="succeeded" data-tone="positive"`,
    );

    rig.route.dispose();
  });

  it('says nothing at all when the anchor predates D-237', async () => {
    const getCaller = vi.fn<RunsGetCaller>(async () => ({
      run: runDetail('succeeded', 'allowed', { errors: [] }),
    }));
    const rig = mountRoute({ getCaller, initialRunId: 'run-1' });
    await rig.route.whenLoaded();

    const html = rig.root.children[0]?.innerHTML ?? '';
    expect(html).not.toContain(LOGS_ROUTE_YIELD_ATTR);
    expect(html).toContain(
      `${LOGS_ROUTE_OUTCOME_ATTR}="succeeded" data-tone="positive"`,
    );

    rig.route.dispose();
  });

  describe('projectRunYieldNotice', () => {
    const y = (items_total: number, items_failed: number) => ({
      steps_run: 1,
      steps_skipped: 0,
      items_total,
      items_failed,
    });

    it('is silent on absence — absent means pre-D-237, never "produced nothing"', () => {
      expect(projectRunYieldNotice(undefined)).toBeUndefined();
    });

    it('is silent on a run that legitimately touched no items', () => {
      // A recipe without a `foreach` is not a pathology.
      expect(projectRunYieldNotice(y(0, 0))).toBeUndefined();
    });

    it('is silent when every item succeeded', () => {
      expect(projectRunYieldNotice(y(400, 0))).toBeUndefined();
    });

    it('flags the all-refused run, and says "the only item" for one', () => {
      expect(projectRunYieldNotice(y(12, 12))?.kind).toBe('all-refused');
      expect(projectRunYieldNotice(y(1, 1))?.message).toContain(
        'The one thing this run touched failed.',
      );
    });

    it('SKIPS a malformed tally rather than coercing it', () => {
      // Matches deriveRunYield's own rule: a confident, meaningless yield is
      // worse than none. `failed > total` cannot come from the deriver, so it
      // is malformed — clamping it would report a fabricated all-refused run.
      expect(projectRunYieldNotice(y(Number.NaN, 3))).toBeUndefined();
      expect(projectRunYieldNotice(y(3, Number.NaN))).toBeUndefined();
      expect(projectRunYieldNotice(y(2, 5))).toBeUndefined();
      expect(projectRunYieldNotice(y(-1, -1))).toBeUndefined();
    });

    it('names the step a stop_when ended the run at, so it does not read as an ordinary run', () => {
      const notice = projectRunYieldNotice({ ...y(0, 0), stopped_at: 'no_new_mail' });
      expect(notice?.kind).toBe('stopped');
      expect(notice?.message).toContain('"no_new_mail"');
      // Absent or null: the run went to the end (or predates the field).
      expect(projectRunYieldNotice({ ...y(0, 0), stopped_at: null })).toBeUndefined();
    });

    it('lets refused items outrank a stop — the more urgent sentence wins', () => {
      expect(projectRunYieldNotice({ ...y(4, 4), stopped_at: 'done' })?.kind).toBe('all-refused');
    });
  });

  it('does not touch the tone of a run that already failed', () => {
    const summary = projectRunOutcomeSummary(
      runDetail('failed', 'allowed', {
        errors: [],
        runYield: {
          steps_run: 1,
          steps_skipped: 0,
          items_total: 5,
          items_failed: 5,
        },
      }),
    );
    expect(summary.yieldNotice?.kind).toBe('all-refused');
    expect(summary.tone).not.toBe('attention');
  });
});
