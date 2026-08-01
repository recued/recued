/** D-169 P0 Slice 4 - multi-bridge dispatcher routing tests.
 *
 *  Covers the Slice 4 surface added around bridge eligibility,
 *  success-history ordering, capacity-gap fall-through, and the
 *  activity-log accessor that feeds the next dispatch.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AggregateCapacityGap,
  BridgeCapabilityProfile,
  BridgeErrorCode,
  BridgeIngredientRef,
  BridgeResult,
} from '@recued/contracts';
import {
  createAuditLogStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditEntry,
  type AuditLogStore,
} from '@recued/storage';
import { createBridgeRegistry, type BridgeConnectionRecord } from '../bridges/registry.js';
import {
  createBridgeDispatcher,
  createBridgeResultListener,
  filterEligible,
  isCapacityGapResult,
  orderForDispatch,
  type BridgeResultListener,
  type BridgeSendResult,
  type BridgeTransport,
  type BridgeWireEnvelope,
  type DispatchRequest,
} from '../bridges/dispatcher.js';

const target_pattern = '*://app.hubspot.com/*';
const api_pattern = '*://api.hubspot.com/*';

const sample_capabilities: BridgeCapabilityProfile = {
  software_version: '0.0.1',
  chrome_version: '124.0.0.0',
  permissions_granted: ['storage', 'alarms', 'offscreen', 'notifications', 'tabs', 'scripting'],
  granted_origins: [target_pattern],
  offscreen_supported: true,
  alarms_supported: true,
};

const sample_ingredient: BridgeIngredientRef = {
  publisher_id: 'recued-core',
  slug: 'draft-email-reader-hubspot',
  version: '1.0.0',
  surface_kind: 'reading',
  domain_allowlist: [target_pattern],
  domain_allowlist_signature: 'PUB',
};

const capabilitiesWithOrigins = (granted_origins: string[]): BridgeCapabilityProfile => ({
  ...sample_capabilities,
  granted_origins,
});

const buildRecord = (
  client_token_id: string,
  online_since: number,
  client_label?: string,
  capabilities: BridgeCapabilityProfile = sample_capabilities,
): BridgeConnectionRecord => ({
  client_token_id,
  client_label,
  session_id: `sess-${client_token_id}`,
  online_since,
  last_seen_at: online_since,
  capabilities,
});

interface SentEnvelope {
  client_token_id: string;
  envelope: BridgeWireEnvelope;
}

interface Setup {
  registry: ReturnType<typeof createBridgeRegistry>;
  listener: BridgeResultListener;
  transport: BridgeTransport;
  send: ReturnType<typeof vi.fn>;
  sent: SentEnvelope[];
}

type OnSend = (args: {
  client_token_id: string;
  envelope: BridgeWireEnvelope;
  listener: BridgeResultListener;
  sent: SentEnvelope[];
}) => BridgeSendResult | Promise<BridgeSendResult>;

const buildSetup = (options: { onSend?: OnSend } = {}): Setup => {
  const registry = createBridgeRegistry();
  const listener = createBridgeResultListener({ now: () => 1_000 });
  const sent: SentEnvelope[] = [];
  const send = vi.fn(
    async (client_token_id: string, envelope: BridgeWireEnvelope): Promise<BridgeSendResult> => {
      sent.push({ client_token_id, envelope });
      return options.onSend?.({ client_token_id, envelope, listener, sent }) ?? { ok: true };
    },
  );
  const transport: BridgeTransport = {
    send,
    async cancel() {
      return { ok: true };
    },
  };
  return { registry, listener, transport, send, sent };
};

const buildAuditLog = (): AuditLogStore =>
  createAuditLogStore(
    createInMemoryCollection<AuditEntry>(),
    createInMemoryCollection<ActivityEntry>(),
  );

const buildDispatcher = (
  setup: Setup,
  options: {
    auditLog?: AuditLogStore;
    generateCommandId?: () => string;
    now?: () => number;
  } = {},
) =>
  createBridgeDispatcher({
    registry: setup.registry,
    transport: setup.transport,
    listener: setup.listener,
    now: options.now ?? (() => 1_000),
    sleep: async () => {},
    generateCommandId: options.generateCommandId,
    auditLog: options.auditLog,
  });

const buildRequest = (overrides: Partial<DispatchRequest> = {}): DispatchRequest => ({
  recipe_run_id: 'run-1',
  step_id: 'step-1',
  ingredient: sample_ingredient,
  action: 'read_dom',
  args: {},
  expects_output_keys: ['text'],
  idempotency_key: 'idem-1',
  timeout_ms: 1_000,
  ...overrides,
});

const buildResult = (
  command_id: string,
  partial: Pick<BridgeResult, 'status'> & Partial<Omit<BridgeResult, 'status'>>,
): BridgeResult => ({
  command_id,
  duration_ms: 5,
  bridge_version: '0.0.1',
  idempotency_key_seen: false,
  ...partial,
});

const okResult = (outputs: Record<string, unknown> = {}) =>
  (command_id: string): BridgeResult =>
    buildResult(command_id, { status: 'ok', outputs });

const errorResult = (code: BridgeErrorCode, message = code) =>
  (command_id: string): BridgeResult =>
    buildResult(command_id, {
      status: 'error',
      error: { code, message },
    });

const respondByBridge = (
  responses: Record<string, (command_id: string) => BridgeResult>,
): OnSend =>
  ({ client_token_id, envelope, listener }) => {
    if (envelope.kind === 'command') {
      const response = responses[client_token_id];
      if (response) {
        listener.resolveResult(response(envelope.command.command_id));
      }
    }
    return { ok: true };
  };

const bridgeIds = (bridges: BridgeConnectionRecord[]): string[] =>
  bridges.map((bridge) => bridge.client_token_id);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('D-169 P0 Slice 4 - filterEligible', () => {
  it('returns an empty result for an empty bridge list', () => {
    expect(filterEligible([], target_pattern)).toEqual([]);
  });

  it('returns a single bridge whose granted origins include the target pattern', () => {
    const bridge = buildRecord('bridge-a', 1_000);
    expect(filterEligible([bridge], target_pattern)).toEqual([bridge]);
  });

  it('filters out a single bridge whose granted origins do not include the target pattern', () => {
    const bridge = buildRecord(
      'bridge-a',
      1_000,
      undefined,
      capabilitiesWithOrigins([api_pattern]),
    );
    expect(filterEligible([bridge], target_pattern)).toEqual([]);
  });

  it('returns only the matching subset when multiple bridges are connected', () => {
    const matching_a = buildRecord('bridge-a', 1_000);
    const non_matching = buildRecord(
      'bridge-b',
      2_000,
      undefined,
      capabilitiesWithOrigins([api_pattern]),
    );
    const matching_c = buildRecord('bridge-c', 3_000);

    expect(bridgeIds(filterEligible([matching_a, non_matching, matching_c], target_pattern)))
      .toEqual(['bridge-a', 'bridge-c']);
  });

  it('never treats an empty granted_origins list as eligible', () => {
    const bridge = buildRecord(
      'bridge-a',
      1_000,
      undefined,
      capabilitiesWithOrigins([]),
    );
    expect(filterEligible([bridge], target_pattern)).toEqual([]);
  });

  it('uses v1 exact-membership semantics rather than wildcard overlap matching', () => {
    const bridge = buildRecord(
      'bridge-a',
      1_000,
      undefined,
      capabilitiesWithOrigins(['*://*.hubspot.com/*']),
    );

    expect(filterEligible([bridge], target_pattern)).toEqual([]);
  });
});

describe('D-169 P0 Slice 4 - orderForDispatch', () => {
  it('without an audit log, sorts by online_since descending', async () => {
    const older = buildRecord('bridge-older', 1_000);
    const newer = buildRecord('bridge-newer', 3_000);
    const middle = buildRecord('bridge-middle', 2_000);

    await expect(orderForDispatch([older, newer, middle], target_pattern, undefined))
      .resolves.toEqual([newer, middle, older]);
  });

  it('with an audit log but no prior successes, falls back to online_since descending', async () => {
    const auditLog = buildAuditLog();
    const older = buildRecord('bridge-older', 1_000);
    const newer = buildRecord('bridge-newer', 3_000);

    await expect(orderForDispatch([older, newer], target_pattern, auditLog))
      .resolves.toEqual([newer, older]);
  });

  it('ranks a bridge with prior success before a more recently attached bridge with no success', async () => {
    const auditLog = buildAuditLog();
    await auditLog.logActivity({
      activity_id: 'success-a',
      timestamp: 1_000,
      action: 'bridge_dispatch_succeeded',
      target: 'bridge-a',
      detail: target_pattern,
    });
    const bridge_a = buildRecord('bridge-a', 1_000);
    const bridge_b = buildRecord('bridge-b', 9_000);

    expect(bridgeIds(await orderForDispatch([bridge_b, bridge_a], target_pattern, auditLog)))
      .toEqual(['bridge-a', 'bridge-b']);
  });

  it('uses newest success timestamp first, with online_since as the tie-breaker', async () => {
    const auditLog = buildAuditLog();
    await auditLog.logActivity({
      activity_id: 'success-a-old',
      timestamp: 1_000,
      action: 'bridge_dispatch_succeeded',
      target: 'bridge-a',
      detail: target_pattern,
    });
    await auditLog.logActivity({
      activity_id: 'success-b-new',
      timestamp: 2_000,
      action: 'bridge_dispatch_succeeded',
      target: 'bridge-b',
      detail: target_pattern,
    });
    const bridge_a = buildRecord('bridge-a', 9_000);
    const bridge_b = buildRecord('bridge-b', 1_000);

    expect(bridgeIds(await orderForDispatch([bridge_a, bridge_b], target_pattern, auditLog)))
      .toEqual(['bridge-b', 'bridge-a']);

    await auditLog.logActivity({
      activity_id: 'success-a-tie',
      timestamp: 2_000,
      action: 'bridge_dispatch_succeeded',
      target: 'bridge-a',
      detail: target_pattern,
    });

    expect(bridgeIds(await orderForDispatch([bridge_b, bridge_a], target_pattern, auditLog)))
      .toEqual(['bridge-a', 'bridge-b']);
  });

  it('keeps bridges when audit reads fail and calls the accessor once per bridge with the target', async () => {
    const lastSuccessfulBridgeDispatch = vi.fn(async () => {
      throw new Error('audit read failed');
    });
    const auditLog = { lastSuccessfulBridgeDispatch } as unknown as AuditLogStore;
    const bridge_a = buildRecord('bridge-a', 1_000);
    const bridge_b = buildRecord('bridge-b', 3_000);

    expect(bridgeIds(await orderForDispatch([bridge_a, bridge_b], target_pattern, auditLog)))
      .toEqual(['bridge-b', 'bridge-a']);
    expect(lastSuccessfulBridgeDispatch).toHaveBeenCalledTimes(2);
    expect(lastSuccessfulBridgeDispatch).toHaveBeenNthCalledWith(1, 'bridge-a', target_pattern);
    expect(lastSuccessfulBridgeDispatch).toHaveBeenNthCalledWith(2, 'bridge-b', target_pattern);
  });
});

describe('D-169 P0 Slice 4 - isCapacityGapResult', () => {
  it('recognizes only the capacity_gap_* BridgeResult error codes', () => {
    const cases: Array<[string, BridgeResult, boolean]> = [
      ['ok result', buildResult('cmd-1', { status: 'ok' }), false],
      [
        'tab unavailable',
        errorResult('capacity_gap_tab_unavailable')('cmd-2'),
        true,
      ],
      [
        'logged in',
        errorResult('capacity_gap_logged_in')('cmd-3'),
        true,
      ],
      [
        'permission missing',
        errorResult('capacity_gap_permission_missing')('cmd-4'),
        true,
      ],
      ['selector not found', errorResult('selector_not_found')('cmd-5'), false],
      ['tab navigation blocked', errorResult('tab_navigation_blocked')('cmd-6'), false],
      [
        'error without error object',
        buildResult('cmd-7', { status: 'error', error: undefined }),
        false,
      ],
      ['timeout result', buildResult('cmd-8', { status: 'timeout' }), false],
    ];

    for (const [label, result, expected] of cases) {
      expect(isCapacityGapResult(result), label).toBe(expected);
    }
  });
});

describe('D-169 P0 Slice 4 - dispatcher multi-bridge fall-through', () => {
  it('tries the next eligible bridge after a capacity gap and returns only the success', async () => {
    const setup = buildSetup({
      onSend: respondByBridge({
        'bridge-a': errorResult('capacity_gap_tab_unavailable'),
        'bridge-b': okResult({ text: 'from-b' }),
      }),
    });
    setup.registry.attach(buildRecord('bridge-a', 3_000, 'A'));
    setup.registry.attach(buildRecord('bridge-b', 2_000, 'B'));

    const out = await buildDispatcher(setup).dispatch(buildRequest());

    expect(bridgeIds(setup.sent.map((entry) => setup.registry.get(entry.client_token_id)!)))
      .toEqual(['bridge-a', 'bridge-b']);
    expect(out.kind).toBe('completed');
    if (out.kind === 'completed') {
      expect(out.bridge_client_token_id).toBe('bridge-b');
      expect(out.result.outputs).toEqual({ text: 'from-b' });
      expect('aggregate' in out).toBe(false);
    }
  });

  it('returns immediately on the first successful bridge result', async () => {
    const setup = buildSetup({
      onSend: respondByBridge({
        'bridge-a': okResult({ text: 'from-a' }),
        'bridge-b': okResult({ text: 'from-b' }),
      }),
    });
    setup.registry.attach(buildRecord('bridge-a', 3_000, 'A'));
    setup.registry.attach(buildRecord('bridge-b', 2_000, 'B'));

    const out = await buildDispatcher(setup).dispatch(buildRequest());

    expect(out.kind).toBe('completed');
    if (out.kind === 'completed') {
      expect(out.bridge_client_token_id).toBe('bridge-a');
      expect(out.result.outputs).toEqual({ text: 'from-a' });
    }
    expect(setup.send).toHaveBeenCalledTimes(1);
    expect(setup.sent.map((entry) => entry.client_token_id)).toEqual(['bridge-a']);
  });

  it('aggregates per-bridge capacity gaps when every eligible bridge reports a gap', async () => {
    const setup = buildSetup({
      onSend: respondByBridge({
        'bridge-a': errorResult('capacity_gap_tab_unavailable'),
        'bridge-b': errorResult('capacity_gap_logged_in'),
      }),
    });
    setup.registry.attach(buildRecord('bridge-a', 3_000, 'laptop-a'));
    setup.registry.attach(buildRecord('bridge-b', 2_000));

    const out = await buildDispatcher(setup).dispatch(buildRequest());

    expect(out.kind).toBe('aggregate_capacity_gap');
    if (out.kind === 'aggregate_capacity_gap') {
      expect(out.aggregate).toEqual({
        kind: 'aggregate_capacity_gap',
        bridges: [
          {
            bridge_id: 'bridge-a',
            bridge_label: 'laptop-a',
            gap_reason: { kind: 'tab_unavailable', url_pattern: target_pattern },
          },
          {
            bridge_id: 'bridge-b',
            bridge_label: 'bridge-b',
            gap_reason: { kind: 'logged_in', site: target_pattern },
          },
        ],
      });
    }
  });

  it('returns immediately on transport_error and does not try another bridge', async () => {
    const setup = buildSetup({
      onSend: ({ client_token_id }) =>
        client_token_id === 'bridge-a'
          ? { ok: false, reason: 'transport_error' }
          : { ok: true },
    });
    setup.registry.attach(buildRecord('bridge-a', 3_000, 'A'));
    setup.registry.attach(buildRecord('bridge-b', 2_000, 'B'));

    const out = await buildDispatcher(setup).dispatch(buildRequest());

    expect(out.kind).toBe('capacity_gap');
    if (out.kind === 'capacity_gap') {
      expect(out.reason).toBe('bridge_online');
    }
    expect(setup.send).toHaveBeenCalledTimes(1);
    expect(setup.sent.map((entry) => entry.client_token_id)).toEqual(['bridge-a']);
  });

  it('returns timeout for the first bridge timeout and does not try another bridge', async () => {
    vi.useFakeTimers();
    const setup = buildSetup();
    const auditLog = buildAuditLog();
    setup.registry.attach(buildRecord('bridge-a', 3_000, 'A'));
    setup.registry.attach(buildRecord('bridge-b', 2_000, 'B'));

    const out_promise = buildDispatcher(setup, {
      generateCommandId: () => 'cmd-timeout-a',
      auditLog,
    }).dispatch(buildRequest({ timeout_ms: 1 }));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5_001);
    const out = await out_promise;

    expect(out).toEqual({ kind: 'timeout', command_id: 'cmd-timeout-a', attempts: 1 });
    expect(setup.send).toHaveBeenCalledTimes(1);
    expect(setup.sent.map((entry) => entry.client_token_id)).toEqual(['bridge-a']);
    expect(await auditLog.listActivities()).toEqual([]);
  });

  it('returns immediately on a non-gap bridge error and does not try another bridge', async () => {
    const setup = buildSetup({
      onSend: respondByBridge({
        'bridge-a': errorResult('selector_not_found'),
        'bridge-b': okResult({ text: 'from-b' }),
      }),
    });
    setup.registry.attach(buildRecord('bridge-a', 3_000, 'A'));
    setup.registry.attach(buildRecord('bridge-b', 2_000, 'B'));

    const out = await buildDispatcher(setup).dispatch(buildRequest());

    expect(out.kind).toBe('completed');
    if (out.kind === 'completed') {
      expect(out.bridge_client_token_id).toBe('bridge-a');
      expect(out.result.status).toBe('error');
      expect(out.result.error?.code).toBe('selector_not_found');
    }
    expect(setup.send).toHaveBeenCalledTimes(1);
  });
});

describe('D-169 P0 Slice 4 - dispatcher eligibility branching', () => {
  it('returns bridge_online capacity_gap when no bridges are connected', async () => {
    const setup = buildSetup();

    const out = await buildDispatcher(setup).dispatch(buildRequest());

    expect(out.kind).toBe('capacity_gap');
    if (out.kind === 'capacity_gap') {
      expect(out.reason).toBe('bridge_online');
      expect(out.attempts).toBe(0);
    }
  });

  it('returns bridge_online capacity_gap when connected bridges are not eligible', async () => {
    const setup = buildSetup();
    setup.registry.attach(buildRecord(
      'bridge-a',
      1_000,
      undefined,
      capabilitiesWithOrigins([api_pattern]),
    ));

    const out = await buildDispatcher(setup).dispatch(buildRequest());

    expect(out.kind).toBe('capacity_gap');
    if (out.kind === 'capacity_gap') {
      expect(out.reason).toBe('bridge_online');
      expect(out.attempts).toBe(0);
    }
    expect(setup.send).not.toHaveBeenCalled();
  });

  it('dispatches through a single eligible bridge', async () => {
    const setup = buildSetup({
      onSend: respondByBridge({
        'bridge-a': okResult({ text: 'from-a' }),
      }),
    });
    setup.registry.attach(buildRecord('bridge-a', 1_000, 'A'));

    const out = await buildDispatcher(setup).dispatch(buildRequest());

    expect(out.kind).toBe('completed');
    if (out.kind === 'completed') {
      expect(out.bridge_client_token_id).toBe('bridge-a');
      expect(out.result.outputs).toEqual({ text: 'from-a' });
    }
  });

  it('preferred_bridge_label dispatches even when that bridge is not eligible and does not fall through', async () => {
    const setup = buildSetup({
      onSend: respondByBridge({
        'bridge-a': errorResult('capacity_gap_permission_missing'),
        'bridge-b': okResult({ text: 'from-b' }),
      }),
    });
    setup.registry.attach(buildRecord(
      'bridge-a',
      1_000,
      'strict',
      capabilitiesWithOrigins([api_pattern]),
    ));
    setup.registry.attach(buildRecord('bridge-b', 2_000, 'eligible'));

    const out = await buildDispatcher(setup).dispatch(
      buildRequest({ preferred_bridge_label: 'strict' }),
    );

    expect(out.kind).toBe('completed');
    if (out.kind === 'completed') {
      expect(out.bridge_client_token_id).toBe('bridge-a');
      expect(out.result.status).toBe('error');
      expect(out.result.error?.code).toBe('capacity_gap_permission_missing');
    }
    expect(setup.send).toHaveBeenCalledTimes(1);
    expect(setup.sent.map((entry) => entry.client_token_id)).toEqual(['bridge-a']);
  });

  it('preferred_bridge_label that is not connected returns bridge_label_unavailable', async () => {
    const setup = buildSetup();
    setup.registry.attach(buildRecord('bridge-a', 1_000, 'other-label'));

    const out = await buildDispatcher(setup).dispatch(
      buildRequest({ preferred_bridge_label: 'missing-label' }),
    );

    expect(out.kind).toBe('capacity_gap');
    if (out.kind === 'capacity_gap') {
      expect(out.reason).toBe('bridge_label_unavailable');
      expect(out.attempts).toBe(0);
    }
    expect(setup.send).not.toHaveBeenCalled();
  });
});

describe('D-169 P0 Slice 4 - bridge dispatch success activity', () => {
  it('records a bridge_dispatch_succeeded activity for an ok result', async () => {
    const auditLog = buildAuditLog();
    const setup = buildSetup({
      onSend: respondByBridge({
        'bridge-a': okResult({ text: 'ok' }),
      }),
    });
    setup.registry.attach(buildRecord('bridge-a', 1_000, 'A'));

    await buildDispatcher(setup, { auditLog, now: () => 7_000 }).dispatch(buildRequest());

    expect(await auditLog.listActivities()).toMatchObject([
      {
        timestamp: 7_000,
        action: 'bridge_dispatch_succeeded',
        target: 'bridge-a',
        detail: target_pattern,
      },
    ]);
  });

  it('does not record a success activity when all eligible bridges return capacity gaps', async () => {
    const auditLog = buildAuditLog();
    const setup = buildSetup({
      onSend: respondByBridge({
        'bridge-a': errorResult('capacity_gap_tab_unavailable'),
        'bridge-b': errorResult('capacity_gap_logged_in'),
      }),
    });
    setup.registry.attach(buildRecord('bridge-a', 2_000, 'A'));
    setup.registry.attach(buildRecord('bridge-b', 1_000, 'B'));

    const out = await buildDispatcher(setup, { auditLog }).dispatch(buildRequest());

    expect(out.kind).toBe('aggregate_capacity_gap');
    expect(await auditLog.listActivities()).toEqual([]);
  });

  it('does not record a success activity for non-ok bridge results', async () => {
    const auditLog = buildAuditLog();
    const setup = buildSetup({
      onSend: respondByBridge({
        'bridge-a': errorResult('selector_not_found'),
      }),
    });
    setup.registry.attach(buildRecord('bridge-a', 1_000, 'A'));

    const out = await buildDispatcher(setup, { auditLog }).dispatch(buildRequest());

    expect(out.kind).toBe('completed');
    expect(await auditLog.listActivities()).toEqual([]);
  });

  it('records exactly one success activity for the bridge that succeeds after a prior gap', async () => {
    const auditLog = buildAuditLog();
    const setup = buildSetup({
      onSend: respondByBridge({
        'bridge-a': errorResult('capacity_gap_tab_unavailable'),
        'bridge-b': okResult({ text: 'from-b' }),
      }),
    });
    setup.registry.attach(buildRecord('bridge-a', 2_000, 'A'));
    setup.registry.attach(buildRecord('bridge-b', 1_000, 'B'));

    const out = await buildDispatcher(setup, { auditLog, now: () => 8_000 })
      .dispatch(buildRequest());

    expect(out.kind).toBe('completed');
    expect(await auditLog.listActivities()).toMatchObject([
      {
        timestamp: 8_000,
        action: 'bridge_dispatch_succeeded',
        target: 'bridge-b',
        detail: target_pattern,
      },
    ]);
  });

  it('uses prior success activity to try a less recently attached bridge first on a later dispatch', async () => {
    const auditLog = buildAuditLog();
    await auditLog.logActivity({
      activity_id: 'manual-a',
      timestamp: 1_000,
      action: 'bridge_dispatch_succeeded',
      target: 'bridge-a',
      detail: target_pattern,
    });
    await auditLog.logActivity({
      activity_id: 'manual-b',
      timestamp: 2_000,
      action: 'bridge_dispatch_succeeded',
      target: 'bridge-b',
      detail: target_pattern,
    });
    const setup = buildSetup({
      onSend: respondByBridge({
        'bridge-a': okResult({ text: 'from-a' }),
        'bridge-b': okResult({ text: 'from-b' }),
      }),
    });
    setup.registry.attach(buildRecord('bridge-a', 9_000, 'A'));
    setup.registry.attach(buildRecord('bridge-b', 1_000, 'B'));

    const out = await buildDispatcher(setup, { auditLog }).dispatch(buildRequest());

    expect(out.kind).toBe('completed');
    expect(setup.sent.map((entry) => entry.client_token_id)).toEqual(['bridge-b']);
  });
});

describe('D-169 P0 Slice 4 - lastSuccessfulBridgeDispatch audit accessor', () => {
  it('returns null for an empty store and for empty inputs', async () => {
    const auditLog = buildAuditLog();

    await expect(auditLog.lastSuccessfulBridgeDispatch('bridge-a', target_pattern))
      .resolves.toBeNull();
    await expect(auditLog.lastSuccessfulBridgeDispatch('', target_pattern))
      .resolves.toBeNull();
    await expect(auditLog.lastSuccessfulBridgeDispatch('bridge-a', ''))
      .resolves.toBeNull();
  });

  it('returns the timestamp for one matching bridge_dispatch_succeeded activity', async () => {
    const auditLog = buildAuditLog();
    await auditLog.logActivity({
      activity_id: 'matching',
      timestamp: 1_234,
      action: 'bridge_dispatch_succeeded',
      target: 'bridge-a',
      detail: target_pattern,
    });

    await expect(auditLog.lastSuccessfulBridgeDispatch('bridge-a', target_pattern))
      .resolves.toBe(1_234);
  });

  it('returns the newest timestamp from multiple matching activities', async () => {
    const auditLog = buildAuditLog();
    await auditLog.logActivity({
      activity_id: 'old',
      timestamp: 1_000,
      action: 'bridge_dispatch_succeeded',
      target: 'bridge-a',
      detail: target_pattern,
    });
    await auditLog.logActivity({
      activity_id: 'new',
      timestamp: 3_000,
      action: 'bridge_dispatch_succeeded',
      target: 'bridge-a',
      detail: target_pattern,
    });
    await auditLog.logActivity({
      activity_id: 'middle',
      timestamp: 2_000,
      action: 'bridge_dispatch_succeeded',
      target: 'bridge-a',
      detail: target_pattern,
    });

    await expect(auditLog.lastSuccessfulBridgeDispatch('bridge-a', target_pattern))
      .resolves.toBe(3_000);
  });

  it('ignores non-matching target, detail, and action rows', async () => {
    const auditLog = buildAuditLog();
    await auditLog.logActivity({
      activity_id: 'wrong-target',
      timestamp: 3_000,
      action: 'bridge_dispatch_succeeded',
      target: 'bridge-b',
      detail: target_pattern,
    });
    await auditLog.logActivity({
      activity_id: 'wrong-detail',
      timestamp: 4_000,
      action: 'bridge_dispatch_succeeded',
      target: 'bridge-a',
      detail: api_pattern,
    });
    await auditLog.logActivity({
      activity_id: 'wrong-action',
      timestamp: 5_000,
      action: 'install',
      target: 'bridge-a',
      detail: target_pattern,
    });

    await expect(auditLog.lastSuccessfulBridgeDispatch('bridge-a', target_pattern))
      .resolves.toBeNull();
  });

  it('returns the newest matching activity from a mixed activity log', async () => {
    const auditLog = buildAuditLog();
    await auditLog.logActivity({
      activity_id: 'matching-old',
      timestamp: 1_000,
      action: 'bridge_dispatch_succeeded',
      target: 'bridge-a',
      detail: target_pattern,
    });
    await auditLog.logActivity({
      activity_id: 'wrong-target-newer',
      timestamp: 9_000,
      action: 'bridge_dispatch_succeeded',
      target: 'bridge-b',
      detail: target_pattern,
    });
    await auditLog.logActivity({
      activity_id: 'matching-new',
      timestamp: 4_000,
      action: 'bridge_dispatch_succeeded',
      target: 'bridge-a',
      detail: target_pattern,
    });

    await expect(auditLog.lastSuccessfulBridgeDispatch('bridge-a', target_pattern))
      .resolves.toBe(4_000);
  });
});

describe('D-169 P0 Slice 4 - AggregateCapacityGap contract shape', () => {
  it('pins the exported aggregate capacity-gap shape', () => {
    const aggregate: AggregateCapacityGap = {
      kind: 'aggregate_capacity_gap',
      bridges: [
        {
          bridge_id: 'bridge-a',
          bridge_label: 'Work laptop',
          gap_reason: { kind: 'tab_unavailable', url_pattern: target_pattern },
        },
        {
          bridge_id: 'bridge-b',
          bridge_label: 'Home laptop',
          gap_reason: { kind: 'logged_in', site: target_pattern },
        },
      ] as const,
    };
    const readonly_bridges: ReadonlyArray<AggregateCapacityGap['bridges'][number]> =
      aggregate.bridges;

    expect(aggregate.kind).toBe('aggregate_capacity_gap');
    expect(Array.isArray(aggregate.bridges)).toBe(true);
    expect(readonly_bridges[0]).toMatchObject({
      bridge_id: 'bridge-a',
      bridge_label: 'Work laptop',
      gap_reason: { kind: 'tab_unavailable', url_pattern: target_pattern },
    });
    expect(readonly_bridges[1].gap_reason.kind).toBe('logged_in');
  });
});
