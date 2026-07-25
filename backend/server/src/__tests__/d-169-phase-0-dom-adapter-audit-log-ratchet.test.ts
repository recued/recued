/** D-169 P0 follow-on — DOM adapter ↔ dispatcher audit-log ratchet.
 *
 *  Composes the real `BridgeDispatcher` with the real `AuditLogStore`
 *  and the real `createBridgeDomAdapter` so future refactors of the
 *  adapter or dispatcher can't silently break the
 *  `bridge_dispatch_succeeded` activity emission. The unit-level
 *  adapter tests (`bridges/__tests__/dom-adapter.test.ts`) inject a
 *  `vi.fn` dispatcher and never exercise the emission path; the
 *  slice-4 dispatcher tests (`d-169-phase-0-slice-4-multi-bridge-dispatcher.test.ts`)
 *  exercise emission via a synthetic `DispatchRequest` but skip the
 *  adapter's contract translation. This test sits at the integration
 *  seam — adapter → real dispatcher → fake transport → real audit log
 *  — and ratchets the row shape that drives next-dispatch iteration
 *  order through `lastSuccessfulBridgeDispatch`.
 *
 *  Ratchets per row (spec § A.8 / DL-7):
 *    - `action`: `'bridge_dispatch_succeeded'`
 *    - `target`: the SERVING bridge's `client_token_id`
 *    - `detail`: the resolved `target_domain_pattern` from the
 *                ingredient's `domain_allowlist`
 *    - `timestamp`: the dispatcher's `now()` at emission
 *
 *  Spec: docs/d-169-spec.md § N.9 / A.8 — multi-bridge fall-through. */

import { describe, expect, it, vi } from 'vitest';
import type {
  BridgeCapabilityProfile,
  BridgeResult,
  BridgeWireEnvelope,
  IngredientManifest,
} from '@recued/contracts';
import {
  createAuditLogStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditEntry,
} from '@recued/storage';
import type { ResolvedCall } from '@recued/ingredients';

import { createBridgeDomAdapter } from '../bridges/dom-adapter.js';
import { createBridgeRegistry } from '../bridges/registry.js';
import {
  createBridgeDispatcher,
  createBridgeResultListener,
  type BridgeSendResult,
  type BridgeTransport,
} from '../bridges/dispatcher.js';

const SLUG = 'dom-adapter-audit-ratchet';
const TARGET = '*://app.example.com/*';

const RATCHET_NOW = 7_000;

const capabilities = (
  granted_origins: string[],
): BridgeCapabilityProfile => ({
  software_version: '0.0.1',
  chrome_version: '124.0.0.0',
  permissions_granted: ['tabs', 'scripting'],
  granted_origins,
  offscreen_supported: true,
  alarms_supported: true,
});

const manifestFixture = (): IngredientManifest => ({
  slug: SLUG,
  name: 'DOM adapter audit-log ratchet fixture',
  description: 'Drives audit-log emission end-to-end',
  author: 'recued-core',
  kind: 'dom',
  version: 1,
  category: 'action',
  risk_tier: 'write',
  input: {},
  output: {},
  surface_kind: 'authoring',
});

const buildResult = (
  command_id: string,
  partial:
    | Pick<BridgeResult, 'status'>
    | (Pick<BridgeResult, 'status'> & Partial<Omit<BridgeResult, 'status'>>),
): BridgeResult => ({
  command_id,
  duration_ms: 5,
  bridge_version: '0.0.1',
  idempotency_key_seen: false,
  ...partial,
});

const okOutputs = (
  command_id: string,
  outputs: Record<string, unknown>,
): BridgeResult => buildResult(command_id, { status: 'ok', outputs });

const bridgeError = (
  command_id: string,
  code: BridgeResult['error'] extends infer E
    ? E extends { code: infer C }
      ? C
      : never
    : never,
  message?: string,
): BridgeResult =>
  buildResult(command_id, {
    status: 'error',
    error: { code, message: message ?? String(code) },
  });

type Responder = (envelope: {
  client_token_id: string;
  command_id: string;
  action: string;
  sent_count: number;
}) => BridgeResult | null;

interface SetupOptions {
  bridges?: Array<{
    token: string;
    label?: string;
    origins?: string[];
    online_since?: number;
  }>;
  responder?: Responder;
  now?: number;
}

const setupRatchet = (options: SetupOptions = {}) => {
  const registry = createBridgeRegistry();
  const bridgeSpecs = options.bridges ?? [
    { token: 'bridge-a', label: 'A', online_since: 1_000 },
  ];
  for (const b of bridgeSpecs) {
    registry.attach({
      client_token_id: b.token,
      ...(b.label !== undefined ? { client_label: b.label } : {}),
      session_id: `sess-${b.token}`,
      online_since: b.online_since ?? 1_000,
      last_seen_at: b.online_since ?? 1_000,
      capabilities: capabilities(b.origins ?? [TARGET]),
    });
  }
  const listener = createBridgeResultListener({ now: () => 1_000 });
  let sentCount = 0;
  const send = vi.fn(
    async (
      client_token_id: string,
      envelope: BridgeWireEnvelope,
    ): Promise<BridgeSendResult> => {
      if (envelope.kind === 'command') {
        const responder = options.responder
          ?? ((args) => okOutputs(args.command_id, { text: 'ok' }));
        const result = responder({
          client_token_id,
          command_id: envelope.command.command_id,
          action: envelope.command.action,
          sent_count: sentCount,
        });
        sentCount++;
        if (result) listener.resolveResult(result);
      }
      return { ok: true };
    },
  );
  const transport: BridgeTransport = {
    send,
    async cancel() {
      return { ok: true };
    },
  };
  const auditLog = createAuditLogStore(
    createInMemoryCollection<AuditEntry>(),
    createInMemoryCollection<ActivityEntry>(),
  );
  const dispatcher = createBridgeDispatcher({
    registry,
    transport,
    listener,
    now: () => options.now ?? RATCHET_NOW,
    sleep: async () => {},
    auditLog,
  });
  const adapter = createBridgeDomAdapter({
    manifests: { get: (slug) => (slug === SLUG ? manifestFixture() : null) },
    getDispatcher: () => dispatcher,
  });
  return { registry, auditLog, dispatcher, send, adapter };
};

const resolvedFixture = (
  overrides: Partial<ResolvedCall> = {},
): ResolvedCall => ({
  slug: SLUG,
  risk_tier: 'write',
  input: {},
  output: { [TARGET]: 'trigger', '#title': 'title' },
  stepMeta: { recipe_id: 'recipe-ratchet', step_id: 'step-ratchet' },
  ...overrides,
});

describe('D-169 P0 - DOM adapter audit-log ratchet', () => {
  it('emits one bridge_dispatch_succeeded row for a single-entry success', async () => {
    const { adapter, auditLog, send } = setupRatchet();

    await adapter(resolvedFixture());

    expect(send).toHaveBeenCalledTimes(1);
    const rows = await auditLog.listActivities();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      timestamp: RATCHET_NOW,
      action: 'bridge_dispatch_succeeded',
      target: 'bridge-a',
      detail: TARGET,
    });
  });

  it('emits one row per successful dispatch for a mixed read+fill+click step', async () => {
    const { adapter, auditLog, send } = setupRatchet({
      responder: ({ command_id, action }) => {
        if (action === 'read_dom') return okOutputs(command_id, { text: 'Draft' });
        if (action === 'fill') return okOutputs(command_id, { filled: true });
        if (action === 'click') return okOutputs(command_id, { clicked: true });
        return null;
      },
    });

    await adapter(resolvedFixture({
      input: { subject: 'Hello' },
      output: {
        [TARGET]: 'trigger',
        '#title': 'title',
        '#subject': 'dom.subject',
        '#send': 'click',
      },
    }));

    expect(send).toHaveBeenCalledTimes(3);
    const rows = await auditLog.listActivities();
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row).toMatchObject({
        action: 'bridge_dispatch_succeeded',
        target: 'bridge-a',
        detail: TARGET,
      });
    }
  });

  it('records the audit row’s detail as the manifest trigger pattern, not the entry selector', async () => {
    // Defensive — if the dispatcher's `target_pattern` ever swapped to
    // `entry.selector` (the rendered CSS path), recency-of-success
    // matching would degrade silently because the next dispatch's
    // `target_domain_pattern` is the manifest's allowlist entry. The
    // ratchet catches a refactor that conflated the two.
    const { adapter, auditLog } = setupRatchet();
    const deepSelector = '#root > .panel[data-test="picker"] > article';

    await adapter(resolvedFixture({
      output: { [TARGET]: 'trigger', [deepSelector]: 'value' },
    }));

    const rows = await auditLog.listActivities();
    expect(rows).toHaveLength(1);
    expect(rows[0].detail).toBe(TARGET);
    expect(rows[0].detail).not.toContain(deepSelector);
  });

  it('does not emit an audit row when the bridge returns an error result', async () => {
    const { adapter, auditLog, send } = setupRatchet({
      responder: ({ command_id }) =>
        bridgeError(command_id, 'selector_not_found', 'gone'),
    });

    await expect(adapter(resolvedFixture())).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
    expect(await auditLog.listActivities()).toEqual([]);
  });

  it('does not emit an audit row when no bridge is attached', async () => {
    const { adapter, auditLog, send } = setupRatchet({ bridges: [] });

    await expect(adapter(resolvedFixture())).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    expect(await auditLog.listActivities()).toEqual([]);
  });

  it('does not emit an audit row when the bridge returns cancelled status', async () => {
    // `recordSuccess` is gated on `result.status === 'ok'`; `cancelled`
    // is one of the three non-ok status surfaces (alongside `rejected`
    // and `timeout`). Slice-4 covers this at the dispatcher unit level
    // — this is the adapter-end-to-end ratchet.
    const { adapter, auditLog, send } = setupRatchet({
      responder: ({ command_id }) =>
        buildResult(command_id, { status: 'cancelled' }),
    });

    await expect(adapter(resolvedFixture())).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
    expect(await auditLog.listActivities()).toEqual([]);
  });

  it('does not emit an audit row when the bridge returns rejected status', async () => {
    const { adapter, auditLog, send } = setupRatchet({
      responder: ({ command_id }) =>
        buildResult(command_id, { status: 'rejected' }),
    });

    await expect(adapter(resolvedFixture())).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
    expect(await auditLog.listActivities()).toEqual([]);
  });

  // Deferred per Codex 2026-05-28 7-angle Angle 1 allowance. The
  // dispatcher's `recordSuccess` is gated on `result.status === 'ok'`
  // at `dispatcher.ts:594` / `:674`, so the dispatcher `timeout` outcome
  // is structurally excluded from emission. Slice-4's
  // `'returns timeout for the first bridge timeout and does not try
  // another bridge'` already exercises the dispatcher path with
  // `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync`. Wiring the
  // same pattern through the adapter requires advancing past two
  // additional async boundaries (`orderForDispatch` audit-log query +
  // `dispatchToBridge` send) which the simple `await Promise.resolve()`
  // + `advanceTimersByTimeAsync` pair does not flush, and the unit-level
  // gate already proves the structural exclusion.
  it.todo('does not emit an audit row when the dispatch times out at the listener');

  it('records the row against the serving bridge after a capacity-gap fall-through', async () => {
    // bridge-a is attached more recently → ordered first; it returns a
    // capacity_gap_*. The dispatcher falls through to bridge-b, which
    // serves. The audit row's `target` MUST be the SERVING bridge.
    // Catches a refactor that captured the wrong client_token_id at
    // emission time.
    const { adapter, auditLog, send } = setupRatchet({
      bridges: [
        { token: 'bridge-a', label: 'A', online_since: 2_000 },
        { token: 'bridge-b', label: 'B', online_since: 1_000 },
      ],
      responder: ({ client_token_id, command_id }) => {
        if (client_token_id === 'bridge-a') {
          return bridgeError(command_id, 'capacity_gap_tab_unavailable');
        }
        return okOutputs(command_id, { text: 'from-b' });
      },
    });

    await adapter(resolvedFixture());

    expect(send).toHaveBeenCalledTimes(2);
    const rows = await auditLog.listActivities();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'bridge_dispatch_succeeded',
      target: 'bridge-b',
      detail: TARGET,
    });
  });
});
