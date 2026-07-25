/** dom poll source — brick 2: the `readDom` bridge-fetch plug.
 *
 *  Two surfaces:
 *    - `classifyDomReadOutcome` — the (branchy) DispatchOutcome →
 *      DomReadOutcome bucketing that decides error-cap auto-disable.
 *      Every variant pinned: routine client absence → `'unavailable'`
 *      (off the cap), an absent selector on an OPEN tab → `text: null`
 *      (a content observation, not a failure), a grant denial → `'policy'`,
 *      a genuine read failure → `'error'`.
 *    - `createBridgeDomRead` — the request it builds (synthetic kernel
 *      `recued/dom-watch` ingredient, watched-origin-only allowlist,
 *      FRESH idempotency key per tick) + the dispatcher-absent /
 *      dispatch-throw paths. */

import { describe, expect, it } from 'vitest';
import type {
  BridgeErrorCode,
  BridgeResult,
  BridgeResultStatus,
} from '@recued/contracts';
import type {
  BridgeDispatcher,
  DispatchOutcome,
  DispatchRequest,
} from '../bridges/dispatcher.js';
import {
  classifyDomReadOutcome,
  createBridgeDomRead,
} from '../watch/dom-bridge-read.js';

const URL_PATTERN = 'https://app.hubspot.com/contacts/*';
const SELECTOR = '#deal-amount';

const bridgeResult = (
  status: BridgeResultStatus,
  extra: {
    outputs?: Record<string, unknown>;
    error?: { code: BridgeErrorCode; message: string; detail?: string };
  } = {},
): BridgeResult => ({
  command_id: 'cmd-1',
  status,
  duration_ms: 5,
  bridge_version: 'test',
  idempotency_key_seen: false,
  ...(extra.outputs ? { outputs: extra.outputs } : {}),
  ...(extra.error ? { error: extra.error } : {}),
});

const completed = (result: BridgeResult): DispatchOutcome => ({
  kind: 'completed',
  result,
  bridge_client_token_id: 'bridge-a',
  attempts: 1,
});

describe('classifyDomReadOutcome — ok reads', () => {
  it('a string `text` is the element text', () => {
    expect(
      classifyDomReadOutcome(completed(bridgeResult('ok', { outputs: { text: '€42,000' } }))),
    ).toEqual({ ok: true, text: '€42,000' });
  });

  it('an empty string is a real read (not coerced to null)', () => {
    expect(
      classifyDomReadOutcome(completed(bridgeResult('ok', { outputs: { text: '' } }))),
    ).toEqual({ ok: true, text: '' });
  });

  it('a non-string / absent `text` snaps to null', () => {
    expect(classifyDomReadOutcome(completed(bridgeResult('ok', { outputs: {} })))).toEqual({
      ok: true,
      text: null,
    });
    expect(
      classifyDomReadOutcome(completed(bridgeResult('ok', { outputs: { text: 42 } }))),
    ).toEqual({ ok: true, text: null });
  });

  it('selector_not_found on an OPEN tab is an absent-element observation (text: null), NOT an error', () => {
    expect(
      classifyDomReadOutcome(
        completed(bridgeResult('error', { error: { code: 'selector_not_found', message: 'gone' } })),
      ),
    ).toEqual({ ok: true, text: null });
  });
});

describe('classifyDomReadOutcome — transient `unavailable` (off the error cap)', () => {
  it('capacity_gap (no eligible bridge) → unavailable', () => {
    const out = classifyDomReadOutcome({
      kind: 'capacity_gap',
      capacity_gap: { kind: 'bridge_online' },
      reason: 'bridge_online',
      attempts: 0,
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.kind).toBe('unavailable');
  });

  it('aggregate_capacity_gap (all eligible bridges gapped) → unavailable', () => {
    const out = classifyDomReadOutcome({
      kind: 'aggregate_capacity_gap',
      aggregate: {
        kind: 'aggregate_capacity_gap',
        bridges: [
          { bridge_id: 'b1', bridge_label: 'B1', gap_reason: { kind: 'tab_unavailable', url_pattern: URL_PATTERN } },
        ],
      },
      attempts: 1,
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.kind).toBe('unavailable');
    expect(out.reason).toContain('1 eligible bridge');
  });

  it('dispatcher timeout (bridge never returned) → unavailable', () => {
    const out = classifyDomReadOutcome({ kind: 'timeout', command_id: 'cmd-1', attempts: 1 });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.kind).toBe('unavailable');
  });

  it.each<BridgeResultStatus>(['timeout', 'cancelled'])(
    'a completed result with status %s → unavailable',
    (status) => {
      const out = classifyDomReadOutcome(completed(bridgeResult(status)));
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error('unreachable');
      expect(out.kind).toBe('unavailable');
    },
  );

  it.each<BridgeErrorCode>([
    'capacity_gap_logged_in',
    'capacity_gap_tab_unavailable',
    'capacity_gap_permission_missing',
    'mv3_lifecycle_killed',
  ])('an error result coded %s → unavailable', (code) => {
    const out = classifyDomReadOutcome(
      completed(bridgeResult('error', { error: { code, message: 'm' } })),
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.kind).toBe('unavailable');
  });
});

describe('classifyDomReadOutcome — `policy` (grant/scope, counts toward the cap)', () => {
  it('a rejected result (bridge two-way grant denial) → policy', () => {
    const out = classifyDomReadOutcome(completed(bridgeResult('rejected')));
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.kind).toBe('policy');
  });

  it.each<BridgeErrorCode>([
    'authority_invalid',
    'authority_expired',
    'authority_invalid_grant_scope',
    'ingredient_domain_signature_invalid',
  ])('an error result coded %s → policy', (code) => {
    const out = classifyDomReadOutcome(
      completed(bridgeResult('error', { error: { code, message: 'denied' } })),
    );
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.kind).toBe('policy');
  });
});

describe('classifyDomReadOutcome — `error` (genuine read failure, counts toward the cap)', () => {
  it.each<BridgeErrorCode>(['tab_navigation_blocked', 'idempotency_violation', 'unknown'])(
    'an error result coded %s → error',
    (code) => {
      const out = classifyDomReadOutcome(
        completed(bridgeResult('error', { error: { code, message: 'boom' } })),
      );
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error('unreachable');
      expect(out.kind).toBe('error');
      expect(out.reason).toBe('boom');
    },
  );

  it('an error result with no code → error', () => {
    const out = classifyDomReadOutcome(completed(bridgeResult('error')));
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.kind).toBe('error');
  });
});

// ────────────────────────────────────────────────────────────────
// createBridgeDomRead — the plug
// ────────────────────────────────────────────────────────────────

const fakeDispatcher = (
  onDispatch: (req: DispatchRequest) => Promise<DispatchOutcome> | DispatchOutcome,
): BridgeDispatcher => ({
  dispatch: async (req) => onDispatch(req),
  cancel: async () => ({ ok: true }),
  canResolve: () => false,
});

describe('createBridgeDomRead — the production plug', () => {
  it('reports unavailable WITHOUT dispatching when no bridge runtime is wired', async () => {
    let dispatched = false;
    const read = createBridgeDomRead({
      getDispatcher: () => undefined,
    });
    const out = await read({ url_pattern: URL_PATTERN, selector: SELECTOR });
    expect(dispatched).toBe(false);
    expect(out).toEqual({ ok: false, kind: 'unavailable', reason: expect.any(String) });
  });

  it('builds a read-only dispatch: synthetic recued/dom-watch ingredient, watched-origin-only allowlist, read_dom of the selector', async () => {
    let captured: DispatchRequest | undefined;
    const read = createBridgeDomRead({
      getDispatcher: () =>
        fakeDispatcher((req) => {
          captured = req;
          return completed(bridgeResult('ok', { outputs: { text: 'v' } }));
        }),
    });
    const out = await read({ url_pattern: URL_PATTERN, selector: SELECTOR });
    expect(out).toEqual({ ok: true, text: 'v' });

    expect(captured).toBeDefined();
    const req = captured!;
    expect(req.action).toBe('read_dom');
    expect(req.args).toEqual({ selector: SELECTOR });
    expect(req.expects_output_keys).toEqual(['text']);
    expect(req.target_domain_pattern).toBe(URL_PATTERN);
    expect(req.ingredient).toMatchObject({
      slug: 'dom-watch',
      publisher_id: 'recued',
      surface_kind: 'reading',
      domain_allowlist: [URL_PATTERN],
      domain_allowlist_signature: '',
    });
  });

  it('mints a FRESH idempotency key per tick (bypasses the bridge 24h replay cache)', async () => {
    const keys: string[] = [];
    let n = 0;
    const read = createBridgeDomRead({
      getDispatcher: () =>
        fakeDispatcher((req) => {
          keys.push(req.idempotency_key);
          return completed(bridgeResult('ok', { outputs: { text: 'v' } }));
        }),
      generateIdempotencyKey: () => `key-${(n += 1)}`,
    });
    await read({ url_pattern: URL_PATTERN, selector: SELECTOR });
    await read({ url_pattern: URL_PATTERN, selector: SELECTOR });
    expect(keys).toEqual(['key-1', 'key-2']);
    expect(new Set(keys).size).toBe(2);
  });

  it('the default idempotency key generator yields distinct values across ticks', async () => {
    const keys: string[] = [];
    const read = createBridgeDomRead({
      getDispatcher: () =>
        fakeDispatcher((req) => {
          keys.push(req.idempotency_key);
          return completed(bridgeResult('ok', { outputs: { text: 'v' } }));
        }),
    });
    await read({ url_pattern: URL_PATTERN, selector: SELECTOR });
    await read({ url_pattern: URL_PATTERN, selector: SELECTOR });
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('a dispatch throw maps to a counted `error` (fails loud, not a transient skip)', async () => {
    const read = createBridgeDomRead({
      getDispatcher: () =>
        fakeDispatcher(() => {
          throw new Error('transport exploded');
        }),
    });
    const out = await read({ url_pattern: URL_PATTERN, selector: SELECTOR });
    expect(out).toEqual({ ok: false, kind: 'error', reason: 'transport exploded' });
  });

  it('forwards a live dispatch outcome through the classifier (capacity_gap → unavailable)', async () => {
    const read = createBridgeDomRead({
      getDispatcher: () =>
        fakeDispatcher(() => ({
          kind: 'capacity_gap',
          capacity_gap: { kind: 'bridge_online' },
          reason: 'bridge_online',
          attempts: 0,
        })),
    });
    const out = await read({ url_pattern: URL_PATTERN, selector: SELECTOR });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.kind).toBe('unavailable');
  });
});
