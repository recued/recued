/** D-125 Phase 3.2 — connection adapter audit emission tests.
 *
 *  Pins the `emitAudit` contract per spec § 3.3:
 *
 *    1. Successful dispatch fires one emission with `status: 'ok'`,
 *       the resolved `kind` + `name`, the record's `subtype`, and
 *       a non-negative `duration_ms` derived from the injected `now`.
 *    2. CONNECTION_NOT_BOUND emits with `name: ''` (no binding to
 *       attribute the call to) + `error.code: 'CONNECTION_NOT_BOUND'`
 *       — the row still lands so the user sees that the recipe tried
 *       to call without a binding.
 *    3. CONNECTION_NOT_FOUND emits with the resolved `name` (the user
 *       bound *something*, just not a record that exists) + `subtype`
 *       absent (no record was found to read it from).
 *    4. Missing-handler `INGREDIENT_ADAPTER_ALL_FAILED` emits with
 *       `subtype` from the looked-up record (the record exists; the
 *       runtime just doesn't host the per-kind handler — P4.x will).
 *    5. Handler throwing an `IngredientError` propagates with `error.code`
 *       set to the IngredientError's code; non-IngredientError throws
 *       surface as `{ code: 'UNKNOWN', message: <Error.message> }`.
 *    6. Adapter never emits when `connection_kind` is invalid (no
 *       transport bucket to attribute the row to). Same for the
 *       non-string `connection` programmer-error path.
 *    7. `emitAudit` undefined → silent no-op (everything else still
 *       works; the IngredientError still throws on the failure paths).
 *    8. Emission errors don't break dispatch — a throwing emit sink
 *       is swallowed; the handler result still returns to the caller.
 *    9. Each dispatch emits exactly once even on the catch path
 *       (the closure's `emitted` flag pins this — a bug here would
 *       double-count rows in the activity log).
 *   10. Per-kind action codes route correctly: api / mcp / notification
 *       each surface with the matching `kind` value on the emission. */

import { describe, expect, it, vi } from 'vitest';
import type { ConnectionRow } from '@recued/contracts';
import { createConnectionAdapter, type ConnectionAuditEmission, type ConnectionKindHandler } from '../connection.js';
import type { ConnectionAdapterStore } from '../connection.js';
import { IngredientError, type ResolvedCall } from '../types.js';

// ────────────────────────────────────────────────────────────────
// Test fixtures
// ────────────────────────────────────────────────────────────────

const mkRow = (overrides: Partial<ConnectionRow> = {}): ConnectionRow => ({
  pk: `${overrides.kind ?? 'api'}:${overrides.name ?? 'hubspot'}`,
  kind: overrides.kind ?? 'api',
  name: overrides.name ?? 'hubspot',
  display_name: overrides.display_name ?? 'HubSpot',
  config_json: overrides.config_json ?? '{"base_url":"https://api.hubapi.com"}',
  auth_ciphertext: overrides.auth_ciphertext ?? 'opaque-blob',
  enrolled_at: overrides.enrolled_at ?? 1_700_000_000_000,
  updated_at: overrides.updated_at ?? 1_700_000_000_000,
  ...(overrides.subtype !== undefined ? { subtype: overrides.subtype } : {}),
  ...(overrides.publisher_id !== undefined ? { publisher_id: overrides.publisher_id } : {}),
  ...(overrides.last_used_at !== undefined ? { last_used_at: overrides.last_used_at } : {}),
  ...(overrides.health_json !== undefined ? { health_json: overrides.health_json } : {}),
});

const mkStore = (
  rows: ReadonlyArray<ConnectionRow>,
): ConnectionAdapterStore => ({
  get(kind, name) {
    return rows.find((r) => r.kind === kind && r.name === name) ?? null;
  },
});

const mkCall = (
  input: Record<string, unknown>,
  overrides: Partial<ResolvedCall> = {},
): ResolvedCall => ({
  slug: overrides.slug ?? 'connection',
  risk_tier: overrides.risk_tier ?? 'admin',
  input,
  output: overrides.output ?? {},
  ...(overrides.fallback ? { fallback: overrides.fallback } : {}),
});

/** Capture every emission into an array — keeps the assertion site
 *  ergonomic (`emissions[0]` etc.) without recreating spies per test. */
const mkSink = () => {
  const emissions: ConnectionAuditEmission[] = [];
  const sink = (e: ConnectionAuditEmission) => { emissions.push(e); };
  return { emissions, sink };
};

/** Deterministic clock builder. Returns a `now` whose first call
 *  yields `start` and second call yields `start + delta`. The adapter
 *  calls `now()` exactly twice per dispatch (entry + emission). */
const mkClock = (start: number, delta: number): () => number => {
  let calls = 0;
  return () => (calls++ === 0 ? start : start + delta);
};

// ────────────────────────────────────────────────────────────────
// Success path
// ────────────────────────────────────────────────────────────────

describe('connection adapter audit (P3.2) — success path', () => {
  it('emits one row with status=ok, kind, name, subtype, duration_ms, ts', async () => {
    const { emissions, sink } = mkSink();
    const handler: ConnectionKindHandler = async () => ({ ok: true });
    const adapter = createConnectionAdapter({
      store: mkStore([mkRow({ kind: 'api', name: 'hubspot', subtype: 'rest' })]),
      handlers: { api: handler },
      emitAudit: sink,
      now: mkClock(1_700_000_000_000, 42),
    });

    const result = await adapter(
      mkCall({ connection_kind: 'api', connection: 'hubspot' }, { slug: 'ticket-reader-hubspot' }),
    );

    expect(result).toEqual({ ok: true });
    expect(emissions).toHaveLength(1);
    expect(emissions[0]).toMatchObject({
      slug: 'ticket-reader-hubspot',
      kind: 'api',
      name: 'hubspot',
      subtype: 'rest',
      status: 'ok',
      duration_ms: 42,
      ts: 1_700_000_000_000,
    });
    expect(emissions[0]?.error).toBeUndefined();
  });

  it('omits subtype when the record has none', async () => {
    const { emissions, sink } = mkSink();
    const adapter = createConnectionAdapter({
      store: mkStore([mkRow({ kind: 'mcp', name: 'tools' })]),
      handlers: { mcp: async () => null },
      emitAudit: sink,
    });

    await adapter(mkCall({ connection_kind: 'mcp', connection: 'tools' }));

    expect(emissions[0]?.subtype).toBeUndefined();
  });

  it('D-216 forwards the resolved upload content hash to the audit emission', async () => {
    const { emissions, sink } = mkSink();
    const hash = 'b'.repeat(64);
    const handler: ConnectionKindHandler = async (_row, _params, _call, ctx) => {
      ctx?.setUploadContentSha256?.(hash);
      return { ok: true };
    };
    const adapter = createConnectionAdapter({
      store: mkStore([mkRow({ kind: 'api', name: 'upload' })]),
      handlers: { api: handler },
      emitAudit: sink,
    });

    await adapter(mkCall({ connection_kind: 'api', connection: 'upload' }));

    expect(emissions).toHaveLength(1);
    expect(emissions[0]?.content_sha256).toBe(hash);
  });

  it('routes api / mcp / notification each into its own emission', async () => {
    const { emissions, sink } = mkSink();
    const adapter = createConnectionAdapter({
      store: mkStore([
        mkRow({ kind: 'api', name: 'a', subtype: 'rest' }),
        mkRow({ kind: 'mcp', name: 'b', subtype: 'sse' }),
        mkRow({ kind: 'notification', name: 'c', subtype: 'slack' }),
      ]),
      handlers: {
        api: async () => 'api-result',
        mcp: async () => 'mcp-result',
        notification: async () => 'notif-result',
      },
      emitAudit: sink,
    });

    await adapter(mkCall({ connection_kind: 'api', connection: 'a' }));
    await adapter(mkCall({ connection_kind: 'mcp', connection: 'b' }));
    await adapter(mkCall({ connection_kind: 'notification', connection: 'c' }));

    expect(emissions.map((e) => ({ kind: e.kind, name: e.name, subtype: e.subtype })))
      .toEqual([
        { kind: 'api', name: 'a', subtype: 'rest' },
        { kind: 'mcp', name: 'b', subtype: 'sse' },
        { kind: 'notification', name: 'c', subtype: 'slack' },
      ]);
  });
});

// ────────────────────────────────────────────────────────────────
// Error paths — emit and rethrow
// ────────────────────────────────────────────────────────────────

describe('connection adapter audit (P3.2) — error paths emit one row', () => {
  it('CONNECTION_NOT_BOUND: emits with empty name + error.code', async () => {
    const { emissions, sink } = mkSink();
    const adapter = createConnectionAdapter({
      store: mkStore([]),
      emitAudit: sink,
    });

    await expect(adapter(mkCall({ connection_kind: 'api', connection: '' })))
      .rejects.toMatchObject({ code: 'CONNECTION_NOT_BOUND' });

    expect(emissions).toHaveLength(1);
    expect(emissions[0]).toMatchObject({
      kind: 'api',
      name: '',
      status: 'error',
      error: { code: 'CONNECTION_NOT_BOUND' },
    });
    expect(emissions[0]?.subtype).toBeUndefined();
  });

  it('CONNECTION_NOT_FOUND: emits with resolved name + subtype undefined', async () => {
    const { emissions, sink } = mkSink();
    const adapter = createConnectionAdapter({
      store: mkStore([]),
      emitAudit: sink,
    });

    await expect(adapter(mkCall({ connection_kind: 'mcp', connection: 'missing' })))
      .rejects.toMatchObject({ code: 'CONNECTION_NOT_FOUND' });

    expect(emissions).toHaveLength(1);
    expect(emissions[0]).toMatchObject({
      kind: 'mcp',
      name: 'missing',
      status: 'error',
      error: { code: 'CONNECTION_NOT_FOUND' },
    });
    expect(emissions[0]?.subtype).toBeUndefined();
  });

  it('missing handler INGREDIENT_ADAPTER_ALL_FAILED: emits with record subtype', async () => {
    const { emissions, sink } = mkSink();
    const adapter = createConnectionAdapter({
      store: mkStore([mkRow({ kind: 'api', name: 'hubspot', subtype: 'rest' })]),
      handlers: {}, // no api handler — record exists, runtime doesn't host it
      emitAudit: sink,
    });

    await expect(adapter(mkCall({ connection_kind: 'api', connection: 'hubspot' })))
      .rejects.toMatchObject({ code: 'INGREDIENT_ADAPTER_ALL_FAILED' });

    expect(emissions).toHaveLength(1);
    expect(emissions[0]).toMatchObject({
      kind: 'api',
      name: 'hubspot',
      subtype: 'rest',
      status: 'error',
      error: { code: 'INGREDIENT_ADAPTER_ALL_FAILED' },
    });
  });

  it('handler throwing IngredientError: emits with that error code, rethrows', async () => {
    const { emissions, sink } = mkSink();
    const handler: ConnectionKindHandler = async () => {
      throw new IngredientError(
        'API_RATE_LIMITED',
        'rate-limited by upstream',
        { retry_after_ms: 1000 },
      );
    };
    const adapter = createConnectionAdapter({
      store: mkStore([mkRow({ kind: 'api', name: 'hubspot', subtype: 'rest' })]),
      handlers: { api: handler },
      emitAudit: sink,
    });

    await expect(adapter(mkCall({ connection_kind: 'api', connection: 'hubspot' })))
      .rejects.toMatchObject({ code: 'API_RATE_LIMITED' });

    expect(emissions).toHaveLength(1);
    expect(emissions[0]).toMatchObject({
      kind: 'api',
      name: 'hubspot',
      subtype: 'rest',
      status: 'error',
      error: { code: 'API_RATE_LIMITED', message: 'rate-limited by upstream' },
    });
  });

  it('handler throwing non-IngredientError: emits with code=UNKNOWN, rethrows', async () => {
    const { emissions, sink } = mkSink();
    const handler: ConnectionKindHandler = async () => {
      throw new TypeError('unexpected null');
    };
    const adapter = createConnectionAdapter({
      store: mkStore([mkRow({ kind: 'mcp', name: 'tools' })]),
      handlers: { mcp: handler },
      emitAudit: sink,
    });

    await expect(adapter(mkCall({ connection_kind: 'mcp', connection: 'tools' })))
      .rejects.toBeInstanceOf(TypeError);

    expect(emissions).toHaveLength(1);
    expect(emissions[0]?.error).toEqual({ code: 'UNKNOWN', message: 'unexpected null' });
    expect(emissions[0]?.status).toBe('error');
  });

  it('redacts a sensitive surface transport error from the durable audit emission', async () => {
    const callbackUrl = 'https://hooks.example/v1/webhooks/opaque-public-id';
    const { emissions, sink } = mkSink();
    const handler: ConnectionKindHandler = async () => {
      throw new Error(`provider echoed ${callbackUrl}`);
    };
    const adapter = createConnectionAdapter({
      store: mkStore([mkRow({ kind: 'api', name: 'fixture-provider' })]),
      handlers: { api: handler },
      emitAudit: sink,
    });
    const call: ResolvedCall = {
      ...mkCall({
        connection_kind: 'api',
        connection: 'fixture-provider',
        'body.callback_url': callbackUrl,
      }),
      stepMeta: {
        step_id: 'attach-resource',
        surface_dispatch: true,
        surface_dispatch_sensitive: true,
      },
    };

    await expect(adapter(call)).rejects.toThrow(callbackUrl);
    expect(emissions).toHaveLength(1);
    expect(emissions[0]?.error).toEqual({
      code: 'UNKNOWN',
      message: 'sensitive connection dispatch failed without exposing request configuration',
    });
    expect(JSON.stringify(emissions)).not.toContain(callbackUrl);
  });

  it('invalid connection_kind: skips emit (no transport bucket)', async () => {
    const { emissions, sink } = mkSink();
    const adapter = createConnectionAdapter({
      store: mkStore([]),
      emitAudit: sink,
    });

    await expect(adapter(mkCall({ connection_kind: 'webhook', connection: 'x' })))
      .rejects.toMatchObject({ code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED' });

    expect(emissions).toHaveLength(0);
  });

  it('non-string connection: skips emit (programmer-error path)', async () => {
    const { emissions, sink } = mkSink();
    const adapter = createConnectionAdapter({
      store: mkStore([]),
      emitAudit: sink,
    });

    await expect(adapter(mkCall({ connection_kind: 'api', connection: 42 })))
      .rejects.toMatchObject({ code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED' });

    expect(emissions).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────
// Sink resilience
// ────────────────────────────────────────────────────────────────

describe('connection adapter audit (P3.2) — sink resilience', () => {
  it('emitAudit undefined: success path completes silently', async () => {
    const adapter = createConnectionAdapter({
      store: mkStore([mkRow({ kind: 'api', name: 'hubspot' })]),
      handlers: { api: async () => ({ ok: true }) },
      // no emitAudit
    });

    const result = await adapter(mkCall({ connection_kind: 'api', connection: 'hubspot' }));
    expect(result).toEqual({ ok: true });
  });

  it('emitAudit undefined: error path still throws (without emit)', async () => {
    const adapter = createConnectionAdapter({ store: mkStore([]) });

    await expect(adapter(mkCall({ connection_kind: 'api', connection: 'missing' })))
      .rejects.toMatchObject({ code: 'CONNECTION_NOT_FOUND' });
  });

  it('throwing emit sink does not break the dispatch result', async () => {
    const adapter = createConnectionAdapter({
      store: mkStore([mkRow({ kind: 'api', name: 'hubspot' })]),
      handlers: { api: async () => 'success' },
      emitAudit: () => { throw new Error('audit-store down'); },
    });

    const result = await adapter(mkCall({ connection_kind: 'api', connection: 'hubspot' }));
    expect(result).toBe('success');
  });

  it('async emit sink is awaited (settles before adapter returns)', async () => {
    let settled = false;
    const adapter = createConnectionAdapter({
      store: mkStore([mkRow({ kind: 'api', name: 'hubspot' })]),
      handlers: { api: async () => 'ok' },
      emitAudit: async () => {
        await Promise.resolve();
        settled = true;
      },
    });

    await adapter(mkCall({ connection_kind: 'api', connection: 'hubspot' }));
    expect(settled).toBe(true);
  });

  it('emits exactly once even when the handler throws', async () => {
    // The closure's `emitted` guard pins the at-most-once contract.
    // If the catch path AND a nested finally both fired, we'd see 2.
    const sink = vi.fn();
    const adapter = createConnectionAdapter({
      store: mkStore([mkRow({ kind: 'api', name: 'hubspot' })]),
      handlers: {
        api: async () => { throw new Error('boom'); },
      },
      emitAudit: sink,
    });

    await expect(adapter(mkCall({ connection_kind: 'api', connection: 'hubspot' })))
      .rejects.toThrow('boom');
    expect(sink).toHaveBeenCalledTimes(1);
  });
});
