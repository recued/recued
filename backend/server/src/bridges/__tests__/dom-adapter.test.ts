/** D-169 P0 - DOM-ingredient bridge runner consumer adapter tests. */

import { describe, expect, it, vi } from 'vitest';
import type {
  BridgeErrorCode,
  BridgeResult,
  IngredientManifest,
} from '@recued/contracts';
import { IngredientError, type ResolvedCall } from '@recued/ingredients';
import { withRunAbortContext } from '../../execution/run-abort-context.js';
import { withPreapprovalIo, type PreapprovalIoContext } from '../../preapproval-io-context.js';

import {
  classifyDomAction,
  classifyEntryAction,
  createBridgeDomAdapter,
  translateDispatchOutcome,
} from '../dom-adapter.js';
import type {
  BridgeDispatcher,
  DispatchOutcome,
  DispatchRequest,
} from '../dispatcher.js';

const SLUG = 'dom.adapter.test';
const TARGET_A = '*://app.example.com/*';
const TARGET_B = '*://second.example.com/*';

const entry = (
  marker: string,
  selector = '#field',
  index = 1,
) => ({ selector, marker, index });

const manifest = (
  overrides: Partial<IngredientManifest> = {},
): IngredientManifest => ({
  slug: SLUG,
  name: 'DOM adapter test',
  description: 'DOM adapter test fixture',
  author: 'recued-core',
  kind: 'dom',
  version: 2,
  category: 'action',
  risk_tier: 'write',
  input: {},
  output: {},
  surface_kind: 'authoring',
  ...overrides,
});

const resolved = (overrides: Partial<ResolvedCall> = {}): ResolvedCall => ({
  slug: SLUG,
  risk_tier: 'write',
  input: {},
  output: {
    [TARGET_A]: 'trigger',
    '#title': 'title',
  },
  stepMeta: {
    run_id: 'run-1',
    recipe_id: 'recipe-1',
    step_id: 'step-1',
  },
  ...overrides,
});

const resultBase = (
  overrides: Pick<BridgeResult, 'status'> & Partial<Omit<BridgeResult, 'status'>>,
): BridgeResult => ({
  command_id: 'cmd-1',
  duration_ms: 7,
  bridge_version: 'bridge-test',
  idempotency_key_seen: false,
  ...overrides,
});

const okResult = (outputs?: Record<string, unknown>): BridgeResult =>
  resultBase({
    status: 'ok',
    ...(outputs !== undefined ? { outputs } : {}),
  });

const errorResult = (
  code: BridgeErrorCode,
  message: string = code,
): BridgeResult =>
  resultBase({
    status: 'error',
    error: { code, message },
  });

const completed = (result: BridgeResult): DispatchOutcome => ({
  kind: 'completed',
  result,
  bridge_client_token_id: 'bridge-token-1',
  attempts: 1,
});

const captureIngredientError = async (
  run: () => unknown | Promise<unknown>,
): Promise<IngredientError> => {
  let err: unknown;
  try {
    await run();
  } catch (caught) {
    err = caught;
  }
  expect(err).toBeInstanceOf(IngredientError);
  return err as IngredientError;
};

const expectIngredientCode = async (
  run: () => unknown | Promise<unknown>,
  code: string,
): Promise<IngredientError> => {
  const err = await captureIngredientError(run);
  expect(err.code).toBe(code);
  return err;
};

const setupAdapter = (options: {
  manifest?: IngredientManifest | null;
  dispatch?: BridgeDispatcher['dispatch'];
  getDispatcher?: () => BridgeDispatcher | undefined;
  defaultTimeoutMs?: number;
} = {}) => {
  const activeManifest = options.manifest === undefined
    ? manifest()
    : options.manifest;
  const dispatch = vi.fn<BridgeDispatcher['dispatch']>(
    options.dispatch ?? (async () => completed(okResult({}))),
  );
  const dispatcher: BridgeDispatcher = {
    dispatch,
    cancel: vi.fn(async () => ({ ok: true })),
    canResolve: vi.fn(() => false),
  };
  const manifests = {
    get: vi.fn((slug: string) =>
      activeManifest && slug === activeManifest.slug ? activeManifest : null,
    ),
  };
  const adapter = createBridgeDomAdapter({
    manifests,
    getDispatcher: options.getDispatcher ?? (() => dispatcher),
    ...(options.defaultTimeoutMs !== undefined
      ? { defaultTimeoutMs: options.defaultTimeoutMs }
      : {}),
  });
  return { adapter, dispatch, dispatcher, manifests };
};

const requestAt = (
  dispatch: ReturnType<typeof vi.fn>,
  index: number,
): DispatchRequest => dispatch.mock.calls[index]?.[0] as DispatchRequest;

const requests = (
  dispatch: ReturnType<typeof vi.fn>,
): DispatchRequest[] =>
  dispatch.mock.calls.map(([request]) => request as DispatchRequest);

describe('D-169 P0 - DOM action classification', () => {
  it('classifies a read marker as read_dom', () => {
    expect(classifyEntryAction(entry('company_name'))).toBe('read_dom');
  });

  it('classifies a dom.* marker as fill', () => {
    expect(classifyEntryAction(entry('dom.subject'))).toBe('fill');
  });

  it('classifies click as click', () => {
    expect(classifyEntryAction(entry('click'))).toBe('click');
  });

  it('classifies enter as click', () => {
    expect(classifyEntryAction(entry('enter'))).toBe('click');
  });

  it('gives fill precedence for a mixed read and write DOM step', () => {
    expect(classifyDomAction({
      [TARGET_A]: 'trigger',
      '#read': 'headline',
      '#write': 'dom.headline',
    })).toBe('fill');
  });

  it('keeps a reads-only DOM step as read_dom', () => {
    expect(classifyDomAction({
      [TARGET_A]: 'trigger',
      '#read': 'headline',
      '#other': 'owner',
    })).toBe('read_dom');
  });
});

describe('D-169 P0 - translateDispatchOutcome', () => {
  it.each(['error', 'ok'] as const)('preserves delivery uncertainty even with an %s result status', async status => {
    await expectIngredientCode(() => translateDispatchOutcome(completed(resultBase({ status,
      outputs: { text: 'must not be used' }, error: { code: 'delivery_uncertain', message: 'Check the page before retrying.' } })),
    SLUG, entry('click', '#save')), 'ACTION_DELIVERY_UNCERTAIN');
  });

  it.each(['error', 'ok'] as const)('treats a worker lifecycle interruption as uncertain despite an %s write status', async status => {
    await expectIngredientCode(() => translateDispatchOutcome(completed(resultBase({ status,
      error: { code: 'mv3_lifecycle_killed', message: 'The worker stopped before completion was confirmed.' } })),
    SLUG, entry('dom.value', '#save')), 'ACTION_DELIVERY_UNCERTAIN');
  });

  it('returns bridge outputs for a completed ok result', () => {
    expect(translateDispatchOutcome(
      completed(okResult({ text: 'Hello' })),
      SLUG,
      entry('title'),
    )).toEqual({ text: 'Hello' });
  });

  it('returns an empty object for a completed ok result with no outputs', () => {
    expect(translateDispatchOutcome(
      completed(okResult()),
      SLUG,
      entry('title'),
    )).toEqual({});
  });

  it.each([
    ['selector_not_found', 'DOM_SELECTOR_NOT_FOUND'],
    ['tab_navigation_blocked', 'DOM_CROSS_ORIGIN'],
    ['capacity_gap_logged_in', 'ROLE_RESTRICTION'],
    ['authority_invalid', 'INGREDIENT_SCOPE_INSUFFICIENT'],
    ['mv3_lifecycle_killed', 'INGREDIENT_ADAPTER_ALL_FAILED'],
  ] as const)('maps bridge error code %s to %s', async (bridgeCode, recipeCode) => {
    const err = await expectIngredientCode(
      () => translateDispatchOutcome(
        completed(errorResult(bridgeCode, `message for ${bridgeCode}`)),
        SLUG,
        entry('title', '#title'),
      ),
      recipeCode,
    );
    expect(err.message).toBe(`message for ${bridgeCode}`);
    expect(err.details).toMatchObject({
      bridge_error_code: bridgeCode,
      selector: '#title',
    });
  });

  it('reports a cancelled click as an uncertain effect', async () => {
    const err = await expectIngredientCode(
      () => translateDispatchOutcome(
        completed(resultBase({ status: 'cancelled' })),
        SLUG,
        entry('click', '#save'),
      ),
      'ACTION_DELIVERY_UNCERTAIN',
    );
    expect(err.details).toMatchObject({ status: 'cancelled', selector: '#save' });
  });

  it('keeps a cancelled read as ROLE_RESTRICTION', async () => {
    await expectIngredientCode(() => translateDispatchOutcome(completed(resultBase({ status: 'cancelled' })),
      SLUG, entry('title', '#title')), 'ROLE_RESTRICTION');
  });

  it('maps bridge rejected status to INGREDIENT_SCOPE_INSUFFICIENT', async () => {
    const err = await expectIngredientCode(
      () => translateDispatchOutcome(
        completed(resultBase({ status: 'rejected' })),
        SLUG,
        entry('click', '#save'),
      ),
      'INGREDIENT_SCOPE_INSUFFICIENT',
    );
    expect(err.details).toMatchObject({ selector: '#save' });
  });

  it('maps bridge-side timeout status to INGREDIENT_ADAPTER_ALL_FAILED', async () => {
    const err = await expectIngredientCode(
      () => translateDispatchOutcome(
        completed(resultBase({ status: 'timeout' })),
        SLUG,
        entry('title', '#slow'),
      ),
      'INGREDIENT_ADAPTER_ALL_FAILED',
    );
    expect(err.message).toContain('timed out');
    expect(err.details).toMatchObject({ selector: '#slow' });
  });

  it('maps dispatcher timeout outcome to INGREDIENT_ADAPTER_ALL_FAILED', async () => {
    const err = await expectIngredientCode(
      () => translateDispatchOutcome(
        { kind: 'timeout', command_id: 'cmd-timeout', attempts: 2 },
        SLUG,
        entry('title', '#slow'),
      ),
      'INGREDIENT_ADAPTER_ALL_FAILED',
    );
    expect(err.message).toContain('timed out');
    expect(err.details).toMatchObject({
      command_id: 'cmd-timeout',
      attempts: 2,
      selector: '#slow',
    });
  });

  it.each(['dom.value', 'click'])('reports an uncertain %s effect when the bridge times out', async marker => {
    await expectIngredientCode(() => translateDispatchOutcome(completed(resultBase({ status: 'timeout' })),
      SLUG, entry(marker, '#save')), 'ACTION_DELIVERY_UNCERTAIN');
  });

  it.each(['dom.value', 'click'])('reports an uncertain %s effect when the worker never replies', async marker => {
    await expectIngredientCode(() => translateDispatchOutcome({ kind: 'timeout', command_id: 'lost', attempts: 1 },
      SLUG, entry(marker, '#save')), 'ACTION_DELIVERY_UNCERTAIN');
  });

  it('maps dispatcher capacity_gap outcome to ROLE_RESTRICTION', async () => {
    const err = await expectIngredientCode(
      () => translateDispatchOutcome(
        {
          kind: 'capacity_gap',
          capacity_gap: { kind: 'bridge_online' },
          reason: 'bridge_online',
          attempts: 0,
        },
        SLUG,
        entry('title', '#title'),
      ),
      'ROLE_RESTRICTION',
    );
    expect(err.details).toMatchObject({
      reason: 'bridge_online',
      capacity_gap: { kind: 'bridge_online' },
    });
  });

  it('maps aggregate capacity gaps to ROLE_RESTRICTION with bridge details', async () => {
    const err = await expectIngredientCode(
      () => translateDispatchOutcome(
        {
          kind: 'aggregate_capacity_gap',
          aggregate: {
            kind: 'aggregate_capacity_gap',
            bridges: [
              {
                bridge_id: 'bridge-a',
                bridge_label: 'Laptop A',
                gap_reason: { kind: 'logged_in', site: TARGET_A },
              },
              {
                bridge_id: 'bridge-b',
                bridge_label: 'Laptop B',
                gap_reason: { kind: 'tab_unavailable', url_pattern: TARGET_A },
              },
            ],
          },
          attempts: 2,
        },
        SLUG,
        entry('title', '#title'),
      ),
      'ROLE_RESTRICTION',
    );
    expect(err.details).toMatchObject({
      bridges: [
        {
          bridge_id: 'bridge-a',
          bridge_label: 'Laptop A',
          gap_reason: { kind: 'logged_in', site: TARGET_A },
        },
        {
          bridge_id: 'bridge-b',
          bridge_label: 'Laptop B',
          gap_reason: { kind: 'tab_unavailable', url_pattern: TARGET_A },
        },
      ],
    });
  });
});

describe('D-169 P0 - bridge DOM adapter dispatch', () => {
  it('throws ROLE_RESTRICTION when getDispatcher returns undefined', async () => {
    const { adapter, dispatch } = setupAdapter({
      getDispatcher: () => undefined,
    });

    await expectIngredientCode(
      () => adapter(resolved()),
      'ROLE_RESTRICTION',
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('throws INGREDIENT_NOT_FOUND when the manifest source misses the slug', async () => {
    const { adapter, dispatch, manifests } = setupAdapter({ manifest: null });

    await expectIngredientCode(
      () => adapter(resolved()),
      'INGREDIENT_NOT_FOUND',
    );
    expect(manifests.get).toHaveBeenCalledWith(SLUG);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('throws DOM_PAGE_NOT_MATCHING when the resolved output has no trigger entries', async () => {
    const { adapter, dispatch } = setupAdapter();

    await expectIngredientCode(
      () => adapter(resolved({ output: { '#title': 'title' } })),
      'DOM_PAGE_NOT_MATCHING',
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('returns empty output for a trigger-only declaration without dispatching', async () => {
    const { adapter, dispatch } = setupAdapter();

    await expect(adapter(resolved({ output: { [TARGET_A]: 'trigger' } })))
      .resolves.toEqual({});
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('dispatches one read_dom command and keys output by field name', async () => {
    const { adapter, dispatch } = setupAdapter({
      dispatch: async () => completed(okResult({ text: 'Acme' })),
    });

    await expect(adapter(resolved({
      output: {
        [TARGET_A]: 'trigger',
        '#company': 'company',
      },
    }))).resolves.toEqual({ company: 'Acme' });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(requestAt(dispatch, 0)).toMatchObject({
      recipe_run_id: 'run-1',
      step_id: 'step-1',
      action: 'read_dom',
      args: { selector: '#company' },
      expects_output_keys: ['text'],
    });
  });

  it('dispatches multiple reads sequentially', async () => {
    const { adapter, dispatch } = setupAdapter();
    dispatch
      .mockResolvedValueOnce(completed(okResult({ text: 'Acme' })))
      .mockResolvedValueOnce(completed(okResult({ text: 'Ada' })));

    await expect(adapter(resolved({
      output: {
        [TARGET_A]: 'trigger',
        '#company': 'company',
        '#owner': 'owner',
      },
    }))).resolves.toEqual({ company: 'Acme', owner: 'Ada' });

    expect(requests(dispatch).map((request) => request.args.selector))
      .toEqual(['#company', '#owner']);
    expect(requests(dispatch).map((request) => request.action))
      .toEqual(['read_dom', 'read_dom']);
  });

  it('dispatches one fill command with value from input', async () => {
    const { adapter, dispatch } = setupAdapter({
      dispatch: async () => completed(okResult({ filled: true })),
    });

    await expect(adapter(resolved({
      input: { subject: 12345 },
      output: {
        [TARGET_A]: 'trigger',
        '#subject': 'dom.subject',
      },
    }))).resolves.toEqual({
      written: 1,
      fields: ['subject'],
      failed: [],
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(requestAt(dispatch, 0)).toMatchObject({
      action: 'fill',
      args: { selector: '#subject', value: '12345' },
      expects_output_keys: ['filled'],
    });
  });

  it('throws DOM_WRITE_FAILED before dispatch when fill input is missing', async () => {
    const { adapter, dispatch } = setupAdapter();

    const err = await expectIngredientCode(
      () => adapter(resolved({
        input: {},
        output: {
          [TARGET_A]: 'trigger',
          '#subject': 'dom.subject',
        },
      })),
      'DOM_WRITE_FAILED',
    );
    expect(err.details).toMatchObject({ field: 'subject', selector: '#subject' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('dispatches one click command', async () => {
    const { adapter, dispatch } = setupAdapter({
      dispatch: async () => completed(okResult({ clicked: true })),
    });

    await expect(adapter(resolved({
      output: {
        [TARGET_A]: 'trigger',
        '#send': 'click',
      },
    }))).resolves.toEqual({ clicked: 1 });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(requestAt(dispatch, 0)).toMatchObject({
      action: 'click',
      args: { selector: '#send' },
      expects_output_keys: ['clicked'],
    });
  });

  it('dispatches mixed read, write, and click entries and assembles mixed output', async () => {
    const { adapter, dispatch } = setupAdapter();
    dispatch
      .mockResolvedValueOnce(completed(okResult({ text: 'Draft' })))
      .mockResolvedValueOnce(completed(okResult({ filled: true })))
      .mockResolvedValueOnce(completed(okResult({ clicked: true })));

    await expect(adapter(resolved({
      input: { subject: 'Hello' },
      output: {
        [TARGET_A]: 'trigger',
        '#title': 'title',
        '#subject': 'dom.subject',
        '#send': 'click',
      },
    }))).resolves.toEqual({
      reads: { title: 'Draft' },
      writes: {
        written: 1,
        fields: ['subject'],
        failed: [],
      },
      clicked: 1,
    });

    expect(requests(dispatch).map((request) => request.action))
      .toEqual(['read_dom', 'fill', 'click']);
    expect(requests(dispatch).map((request) => request.args))
      .toEqual([
        { selector: '#title' },
        { selector: '#subject', value: 'Hello' },
        { selector: '#send' },
      ]);
  });
});

describe('D-169 P0 - DOM adapter idempotency keys', () => {
  it('produces the same idempotency_key for the same ResolvedCall', async () => {
    const { adapter, dispatch } = setupAdapter({
      dispatch: async () => completed(okResult({ text: 'same' })),
    });
    const call = resolved({
      input: { q: 'same' },
      output: {
        [TARGET_A]: 'trigger',
        '#title': 'title',
      },
    });

    await adapter(call);
    await adapter(call);

    const keys = requests(dispatch).map((request) => request.idempotency_key);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toMatch(/^run-1:1:[0-9a-f]{16}$/);
  });

  it.each([false, true])('separates identical calls belonging to different runs (write: %s)', async write => {
    const { adapter, dispatch } = setupAdapter({
      dispatch: async () => completed(okResult({ text: 'fresh', filled: true })),
    });
    const call = resolved({ input: { value: 'same' },
      output: { [TARGET_A]: 'trigger', '#field': write ? 'dom.value' : 'text' } });
    await adapter(call);
    await adapter({ ...call, stepMeta: { ...call.stepMeta!, run_id: 'run-2' } });
    const [first, second] = requests(dispatch);
    expect(first!.recipe_run_id).toBe('run-1'); expect(second!.recipe_run_id).toBe('run-2');
    expect(second!.idempotency_key).not.toBe(first!.idempotency_key);
  });

  it.each([undefined, { recipe_id: 'legacy-recipe', step_id: 'legacy-step' }])(
    'gives unanchored invocations separate identities (metadata: %s)', async stepMeta => {
      const { adapter, dispatch } = setupAdapter({ dispatch: async () => completed(okResult({ text: 'fresh' })) });
      const call = resolved({ stepMeta, input: { run_id: 'authored-run-id' },
        output: { [TARGET_A]: 'trigger', '#one': 'one', '#two': 'two' } });
      await adapter(call); await adapter(call);
      const sent = requests(dispatch);
      expect(sent[0]!.recipe_run_id).toBe(sent[1]!.recipe_run_id);
      expect(sent[2]!.recipe_run_id).toBe(sent[3]!.recipe_run_id);
      expect(sent[2]!.recipe_run_id).not.toBe(sent[0]!.recipe_run_id);
      expect(sent[0]!.recipe_run_id).not.toContain('authored-run-id');
      expect(sent[2]!.idempotency_key).not.toBe(sent[0]!.idempotency_key);
    },
  );

  it('retains a host context run id when step metadata has none, and prefers explicit child metadata', async () => {
    const { adapter, dispatch } = setupAdapter({ dispatch: async () => completed(okResult({ text: 'fresh' })) });
    const call = resolved({ stepMeta: { recipe_id: 'recipe-1', step_id: 'step-1' } });
    await withRunAbortContext({ run_id: 'parent-run' }, async () => {
      await adapter(call); await adapter(structuredClone(call));
      await adapter({ ...call, stepMeta: { ...call.stepMeta!, run_id: 'child-run' } });
    });
    const [first, retry, child] = requests(dispatch);
    expect(first!.recipe_run_id).toBe('parent-run'); expect(retry!.idempotency_key).toBe(first!.idempotency_key);
    expect(child!.recipe_run_id).toBe('child-run'); expect(child!.idempotency_key).not.toBe(first!.idempotency_key);
  });

  it.each([undefined, ''])('requires explicit run metadata for reviewed calls despite an ambient run (run id: %s)', async run_id => {
    const unavailable = vi.fn((): never => { throw new Error('A provider hook must not run without reviewed metadata'); });
    const scope: PreapprovalIoContext = { prepareDomCommand: unavailable, aiSlot: unavailable,
      coversAiFileAsk: unavailable, readAiFile: unavailable, readHttpFile: unavailable, beforeAiProvider: unavailable,
      beforeCliProvider: unavailable, validateProvider: unavailable, beforeProvider: unavailable,
      coversMailAttachmentAsks: unavailable, validateMail: unavailable, readMailAttachment: unavailable,
      fileAccess: unavailable, beforeMailProvider: unavailable };
    const { adapter, dispatch } = setupAdapter();
    await expect(withRunAbortContext({ run_id: 'ambient-run' }, () => withPreapprovalIo(scope, () => adapter(resolved({
      stepMeta: { recipe_id: 'recipe-1', step_id: 'step-1', run_id },
    }))))).rejects.toMatchObject({ code: 'DOM_WRITE_FAILED' });
    expect(unavailable).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
  });

  it('produces distinct idempotency_key values when input changes', async () => {
    const { adapter, dispatch } = setupAdapter({
      dispatch: async () => completed(okResult({ text: 'ok' })),
    });

    await adapter(resolved({ input: { q: 'first' } }));
    await adapter(resolved({ input: { q: 'second' } }));

    const keys = requests(dispatch).map((request) => request.idempotency_key);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('produces distinct per-entry keys that remain stable across retries', async () => {
    const { adapter, dispatch } = setupAdapter({
      dispatch: async () => completed(okResult({ text: 'ok' })),
    });
    const call = resolved({
      input: { q: 'stable' },
      output: {
        [TARGET_A]: 'trigger',
        '#one': 'one',
        '#two': 'two',
        '#three': 'three',
      },
    });

    await adapter(call);
    await adapter(call);

    const firstRun = requests(dispatch).slice(0, 3).map((request) => request.idempotency_key);
    const secondRun = requests(dispatch).slice(3, 6).map((request) => request.idempotency_key);
    expect(new Set(firstRun).size).toBe(3);
    expect(secondRun).toEqual(firstRun);
    expect(firstRun).toEqual([
      expect.stringMatching(/^run-1:1:[0-9a-f]{16}$/),
      expect.stringMatching(/^run-1:2:[0-9a-f]{16}$/),
      expect.stringMatching(/^run-1:3:[0-9a-f]{16}$/),
    ]);
  });
});

describe('D-169 P0 - DOM adapter step output assembly', () => {
  it('assembles successful writes into the write-only shape', async () => {
    const { adapter, dispatch } = setupAdapter();
    dispatch
      .mockResolvedValueOnce(completed(okResult({ filled: true })))
      .mockResolvedValueOnce(completed(okResult({ filled: true })));

    await expect(adapter(resolved({
      input: { first: 'Ada', last: 'Lovelace' },
      output: {
        [TARGET_A]: 'trigger',
        '#first': 'dom.first',
        '#last': 'dom.last',
      },
    }))).resolves.toEqual({
      written: 2,
      fields: ['first', 'last'],
      failed: [],
    });
  });

  it('throws on the first failing entry without dispatching later entries', async () => {
    const { adapter, dispatch } = setupAdapter();
    dispatch
      .mockResolvedValueOnce(completed(okResult({ text: 'before failure' })))
      .mockResolvedValueOnce(completed(errorResult('selector_not_found', 'missing second')))
      .mockResolvedValueOnce(completed(okResult({ text: 'should not run' })));

    await expectIngredientCode(
      () => adapter(resolved({
        output: {
          [TARGET_A]: 'trigger',
          '#first': 'first',
          '#missing': 'missing',
          '#third': 'third',
        },
      })),
      'DOM_SELECTOR_NOT_FOUND',
    );
    expect(requests(dispatch).map((request) => request.args.selector))
      .toEqual(['#first', '#missing']);
  });

  it('maps null text output to null instead of undefined', async () => {
    const { adapter } = setupAdapter({
      dispatch: async () => completed(okResult({ text: null })),
    });

    await expect(adapter(resolved({
      output: {
        [TARGET_A]: 'trigger',
        '#maybe': 'maybe',
      },
    }))).resolves.toEqual({ maybe: null });
  });

  it('places filled=false in failed instead of written', async () => {
    const { adapter } = setupAdapter({
      dispatch: async () => completed(okResult({ filled: false })),
    });

    await expect(adapter(resolved({
      input: { subject: 'Hello' },
      output: {
        [TARGET_A]: 'trigger',
        '#subject': 'dom.subject',
      },
    }))).resolves.toEqual({
      written: 0,
      fields: [],
      failed: ['subject'],
    });
  });
});

describe('D-169 P0 - BridgeIngredientRef construction', () => {
  it('carries manifest version and surface_kind into the dispatch request', async () => {
    const { adapter, dispatch } = setupAdapter({
      manifest: manifest({ version: 7, surface_kind: 'publishing' }),
      dispatch: async () => completed(okResult({ text: 'ok' })),
    });

    await adapter(resolved());

    expect(requestAt(dispatch, 0).ingredient).toMatchObject({
      slug: SLUG,
      publisher_id: 'recued-core',
      version: '7',
      surface_kind: 'publishing',
      domain_allowlist_signature: '',
    });
  });

  it('defaults missing manifest version to 1', async () => {
    const { adapter, dispatch } = setupAdapter({
      manifest: manifest({ version: undefined }),
      dispatch: async () => completed(okResult({ text: 'ok' })),
    });

    await adapter(resolved());

    expect(requestAt(dispatch, 0).ingredient.version).toBe('1');
  });

  it('defaults missing surface_kind to reading', async () => {
    const { adapter, dispatch } = setupAdapter({
      manifest: manifest({ surface_kind: undefined }),
      dispatch: async () => completed(okResult({ text: 'ok' })),
    });

    await adapter(resolved());

    expect(requestAt(dispatch, 0).ingredient.surface_kind).toBe('reading');
  });
});

describe('D-169 P0 - DOM adapter domain allowlist resolution', () => {
  it('uses a single trigger entry as the bridge ingredient allowlist', async () => {
    const { adapter, dispatch } = setupAdapter({
      dispatch: async () => completed(okResult({ text: 'ok' })),
    });

    await adapter(resolved({
      output: {
        [TARGET_A]: 'trigger',
        '#title': 'title',
      },
    }));

    expect(requestAt(dispatch, 0).ingredient.domain_allowlist).toEqual([TARGET_A]);
  });

  it('preserves multiple trigger entries in declaration order', async () => {
    const { adapter, dispatch } = setupAdapter({
      dispatch: async () => completed(okResult({ text: 'ok' })),
    });

    await adapter(resolved({
      output: {
        [TARGET_B]: 'trigger',
        [TARGET_A]: 'trigger',
        '#title': 'title',
      },
    }));

    expect(requestAt(dispatch, 0).ingredient.domain_allowlist)
      .toEqual([TARGET_B, TARGET_A]);
  });
});

describe('D-169 P0 - publishBridgeDispatcher boot-race fix', () => {
  it('reads the late-bound dispatcher again after it is published', async () => {
    let liveDispatcher: BridgeDispatcher | undefined;
    const { adapter, dispatch, dispatcher } = setupAdapter({
      getDispatcher: () => liveDispatcher,
      dispatch: async () => completed(okResult({ text: 'live' })),
    });

    await expectIngredientCode(() => adapter(resolved()), 'ROLE_RESTRICTION');
    expect(dispatch).not.toHaveBeenCalled();

    liveDispatcher = dispatcher;
    await expect(adapter(resolved())).resolves.toEqual({ title: 'live' });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

// ── D-182 "core.dom" — arg-driven dispatch. `core.dom.{read,write}` lower to the
//    `dom-read` / `dom-write` backing slugs and carry selectors/target/value as op
//    ARGS (no manifest selector map). The adapter synthesizes the per-entry
//    dispatch from those args, reusing the same per-entry loop + assembly.
describe('D-182 core.dom - arg-driven dispatch', () => {
  const GEMINI = 'gemini.google.com/*';
  const READ_SEL = '.conversation-container:last-child .markdown';
  const WRITE_SEL = "div.ql-editor[contenteditable='true']";

  const coreDomResolved = (
    slug: 'dom-read' | 'dom-write',
    input: Record<string, unknown>,
  ): ResolvedCall => ({
    slug,
    risk_tier: slug === 'dom-read' ? 'read' : 'write',
    input,
    output: {}, // ignored on the core.dom path — args drive the call
    stepMeta: { recipe_id: 'analyze-deal-gemini', step_id: slug === 'dom-read' ? 'gemini_response' : 'send_prompt' },
  });

  it('core.dom.read builds one read_dom command from args and returns { text }', async () => {
    const { adapter, dispatch } = setupAdapter({
      manifest: manifest({ slug: 'dom-read', kind: 'dom', risk_tier: 'read', surface_kind: 'reading' }),
      dispatch: async () => completed(okResult({ text: 'Three next steps: ...' })),
    });
    const out = await adapter(coreDomResolved('dom-read', { target: GEMINI, selector: READ_SEL }));
    expect(out).toEqual({ text: 'Three next steps: ...' });
    const reqs = requests(dispatch);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.action).toBe('read_dom');
    expect(reqs[0]?.args).toEqual({ selector: READ_SEL });
    // the `target` arg becomes the Bridge actuation domain (allowlist).
    expect(reqs[0]?.ingredient.domain_allowlist).toEqual([GEMINI]);
  });

  it('core.dom.write fills the value into the selector and returns the write result', async () => {
    const { adapter, dispatch } = setupAdapter({
      manifest: manifest({ slug: 'dom-write', kind: 'dom', risk_tier: 'write' }),
      dispatch: async () => completed(okResult({ filled: true })),
    });
    const out = await adapter(coreDomResolved('dom-write', {
      target: GEMINI, selector: WRITE_SEL, value: 'Analyze this deal',
    }));
    expect(out).toEqual({ written: 1, fields: ['__core_dom_value'], failed: [] });
    const reqs = requests(dispatch);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.action).toBe('fill');
    expect(reqs[0]?.args).toEqual({ selector: WRITE_SEL, value: 'Analyze this deal' });
    expect(reqs[0]?.ingredient.domain_allowlist).toEqual([GEMINI]);
  });

  it('core.dom.write with submit_selector fires a second click (Enter) command', async () => {
    const { adapter, dispatch } = setupAdapter({
      manifest: manifest({ slug: 'dom-write', kind: 'dom', risk_tier: 'write' }),
      dispatch: async (req) =>
        completed(okResult(req.action === 'fill' ? { filled: true } : { clicked: true })),
    });
    const out = await adapter(coreDomResolved('dom-write', {
      target: GEMINI, selector: WRITE_SEL, value: 'hi', submit_selector: 'div.ql-editor',
    }));
    expect(out).toEqual({ writes: { written: 1, fields: ['__core_dom_value'], failed: [] }, clicked: 1 });
    const reqs = requests(dispatch);
    expect(reqs).toHaveLength(2);
    expect(reqs.map((r) => r.action)).toEqual(['fill', 'click']);
    expect(reqs[1]?.args).toEqual({ selector: 'div.ql-editor' });
    // distinct idempotency cells per entry.
    expect(reqs[0]?.idempotency_key).not.toBe(reqs[1]?.idempotency_key);
  });

  it('rejects a core.dom call missing a required arg with DOM_SELECTOR_MISSING', async () => {
    const readAdapter = setupAdapter({
      manifest: manifest({ slug: 'dom-read', kind: 'dom', risk_tier: 'read', surface_kind: 'reading' }),
    });
    await expectIngredientCode(
      () => readAdapter.adapter(coreDomResolved('dom-read', { target: GEMINI })), // no selector
      'DOM_SELECTOR_MISSING',
    );
    const writeAdapter = setupAdapter({
      manifest: manifest({ slug: 'dom-write', kind: 'dom', risk_tier: 'write' }),
    });
    await expectIngredientCode(
      () => writeAdapter.adapter(coreDomResolved('dom-write', { target: GEMINI, selector: WRITE_SEL })), // no value
      'DOM_SELECTOR_MISSING',
    );
  });
});
