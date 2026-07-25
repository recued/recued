/** D-125 Phase 3.1 — connection adapter shell tests.
 *
 *  Pins the dispatch contract for `kind: 'connection'` ingredients:
 *
 *    1. invalid `connection_kind` → `INGREDIENT_OUTPUT_VALIDATION_FAILED`
 *       with the offending value on the error context.
 *    2. empty / null / undefined / blank string `connection` →
 *       `CONNECTION_NOT_BOUND` (picker resolved to nothing — point the
 *       user at Kitchen, not Settings → Connections).
 *    3. non-string `connection` → `INGREDIENT_OUTPUT_VALIDATION_FAILED`.
 *    4. valid `connection_kind` + `connection` but no row in the store
 *       → `CONNECTION_NOT_FOUND` (point the user at Settings, not
 *       Kitchen).
 *    5. valid binding + missing per-kind handler →
 *       `INGREDIENT_ADAPTER_ALL_FAILED` with `kind: 'connection.<kind>'`
 *       on the context. The placeholder stays until P4 wires the real
 *       handler; tests pin the diagnostic shape.
 *    6. valid binding + present handler → handler invoked with
 *       `(record, params, call)` shape per spec § 3.2; `params` is the
 *       step input minus `connection_kind` + `connection`; the record
 *       comes through verbatim (no auth-decryption side-effects in the
 *       shell — handlers decrypt at invoke time in P4.x).
 *    7. handler return value flows through to the engine unchanged. */

import { describe, expect, it } from 'vitest';
import type { ConnectionRow } from '@recued/contracts';
import { createConnectionAdapter, type ConnectionKindHandler } from '../connection.js';
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

// ────────────────────────────────────────────────────────────────
// connection_kind validation
// ────────────────────────────────────────────────────────────────

describe('connection adapter — connection_kind validation', () => {
  it('throws INGREDIENT_OUTPUT_VALIDATION_FAILED when connection_kind is missing', async () => {
    const adapter = createConnectionAdapter({ store: mkStore([]) });
    await expect(adapter(mkCall({ connection: 'hubspot' })))
      .rejects.toMatchObject({
        code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED',
        details: { connection_kind: undefined },
      });
  });

  it('throws when connection_kind is an unknown value', async () => {
    const adapter = createConnectionAdapter({ store: mkStore([]) });
    await expect(
      adapter(mkCall({ connection_kind: 'webhook', connection: 'x' })),
    ).rejects.toMatchObject({
      code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED',
      details: { connection_kind: 'webhook' },
    });
  });

  it('throws when connection_kind is a non-string', async () => {
    const adapter = createConnectionAdapter({ store: mkStore([]) });
    await expect(
      adapter(mkCall({ connection_kind: 42, connection: 'x' })),
    ).rejects.toBeInstanceOf(IngredientError);
  });
});

// ────────────────────────────────────────────────────────────────
// CONNECTION_NOT_BOUND — picker resolved to empty
// ────────────────────────────────────────────────────────────────

describe('connection adapter — CONNECTION_NOT_BOUND (picker empty)', () => {
  it('throws when `connection` is undefined', async () => {
    const adapter = createConnectionAdapter({ store: mkStore([]) });
    await expect(
      adapter(mkCall({ connection_kind: 'api' })),
    ).rejects.toMatchObject({
      code: 'CONNECTION_NOT_BOUND',
      details: { kind: 'api' },
    });
  });

  it('throws when `connection` is null', async () => {
    const adapter = createConnectionAdapter({ store: mkStore([]) });
    await expect(
      adapter(mkCall({ connection_kind: 'api', connection: null })),
    ).rejects.toMatchObject({ code: 'CONNECTION_NOT_BOUND' });
  });

  it('throws when `connection` is the empty string', async () => {
    const adapter = createConnectionAdapter({ store: mkStore([]) });
    await expect(
      adapter(mkCall({ connection_kind: 'api', connection: '' })),
    ).rejects.toMatchObject({ code: 'CONNECTION_NOT_BOUND' });
  });

  it('throws when `connection` is whitespace-only', async () => {
    const adapter = createConnectionAdapter({ store: mkStore([]) });
    await expect(
      adapter(mkCall({ connection_kind: 'api', connection: '   ' })),
    ).rejects.toMatchObject({ code: 'CONNECTION_NOT_BOUND' });
  });

  it('throws INGREDIENT_OUTPUT_VALIDATION_FAILED when `connection` is a non-string non-null', async () => {
    // Distinct from CONNECTION_NOT_BOUND — a number / object slipping
    // through the picker is a programmer error, not a missing binding.
    const adapter = createConnectionAdapter({ store: mkStore([]) });
    await expect(
      adapter(mkCall({ connection_kind: 'api', connection: 42 })),
    ).rejects.toMatchObject({
      code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED',
      details: { connection_type: 'number' },
    });
  });
});

// ────────────────────────────────────────────────────────────────
// CONNECTION_NOT_FOUND — bound but no record
// ────────────────────────────────────────────────────────────────

describe('connection adapter — CONNECTION_NOT_FOUND (no record)', () => {
  it('throws when the store has no row for (kind, name)', async () => {
    const adapter = createConnectionAdapter({ store: mkStore([]) });
    await expect(
      adapter(mkCall({ connection_kind: 'api', connection: 'hubspot' })),
    ).rejects.toMatchObject({
      code: 'CONNECTION_NOT_FOUND',
      details: { kind: 'api', name: 'hubspot' },
    });
  });

  it('throws when the row exists for a different kind', async () => {
    const adapter = createConnectionAdapter({
      store: mkStore([mkRow({ kind: 'mcp', name: 'shared-name' })]),
    });
    await expect(
      adapter(mkCall({ connection_kind: 'api', connection: 'shared-name' })),
    ).rejects.toMatchObject({ code: 'CONNECTION_NOT_FOUND' });
  });

  it('throws when the row exists for a different name', async () => {
    const adapter = createConnectionAdapter({
      store: mkStore([mkRow({ kind: 'api', name: 'hubspot' })]),
    });
    await expect(
      adapter(mkCall({ connection_kind: 'api', connection: 'salesforce' })),
    ).rejects.toMatchObject({ code: 'CONNECTION_NOT_FOUND' });
  });

  it('awaits async store.get() before deciding', async () => {
    const adapter = createConnectionAdapter({
      store: {
        async get(kind, name) {
          return name === 'hubspot' && kind === 'api' ? mkRow({ kind, name }) : null;
        },
      },
    });
    // Async path — found case.
    await expect(
      adapter(mkCall({ connection_kind: 'api', connection: 'hubspot' })),
    ).rejects.toMatchObject({ code: 'INGREDIENT_ADAPTER_ALL_FAILED' });
    // Async path — missing case.
    await expect(
      adapter(mkCall({ connection_kind: 'api', connection: 'salesforce' })),
    ).rejects.toMatchObject({ code: 'CONNECTION_NOT_FOUND' });
  });
});

// ────────────────────────────────────────────────────────────────
// Per-kind handler dispatch
// ────────────────────────────────────────────────────────────────

describe('connection adapter — handler dispatch', () => {
  it('invokes the api handler with (record, params, call) and returns its result', async () => {
    const row = mkRow({ kind: 'api', name: 'hubspot' });
    const captured: Array<{ record: ConnectionRow; params: Record<string, unknown>; slug: string }> = [];
    const handler: ConnectionKindHandler = async (record, params, call) => {
      captured.push({ record, params, slug: call.slug });
      return { ok: true };
    };
    const adapter = createConnectionAdapter({
      store: mkStore([row]),
      handlers: { api: handler },
    });
    const result = await adapter(mkCall({
      connection_kind: 'api',
      connection: 'hubspot',
      method: 'GET',
      path: '/crm/v3/objects/tickets/42',
      'query.properties': 'subject,content',
    }));
    expect(result).toEqual({ ok: true });
    expect(captured).toHaveLength(1);
    expect(captured[0].record).toBe(row);
    expect(captured[0].params).toEqual({
      method: 'GET',
      path: '/crm/v3/objects/tickets/42',
      'query.properties': 'subject,content',
    });
    expect(captured[0].slug).toBe('connection');
  });

  it('routes mcp / notification independently (no cross-call leakage)', async () => {
    const apiHandler: ConnectionKindHandler = async () => 'api-handler-ran';
    const mcpHandler: ConnectionKindHandler = async () => 'mcp-handler-ran';
    const adapter = createConnectionAdapter({
      store: mkStore([
        mkRow({ kind: 'api', name: 'hubspot' }),
        mkRow({ kind: 'mcp', name: 'gh-mcp' }),
      ]),
      handlers: { api: apiHandler, mcp: mcpHandler },
    });
    expect(await adapter(mkCall({ connection_kind: 'api', connection: 'hubspot' })))
      .toBe('api-handler-ran');
    expect(await adapter(mkCall({ connection_kind: 'mcp', connection: 'gh-mcp' })))
      .toBe('mcp-handler-ran');
  });

  it('passes the full ResolvedCall envelope to the handler (slug + risk_tier + output)', async () => {
    let seen: ResolvedCall | undefined;
    const adapter = createConnectionAdapter({
      store: mkStore([mkRow({ kind: 'api', name: 'hubspot' })]),
      handlers: {
        api: async (_record, _params, call) => {
          seen = call;
          return null;
        },
      },
    });
    await adapter(mkCall(
      { connection_kind: 'api', connection: 'hubspot' },
      {
        slug: 'ticket-reader-hubspot',
        risk_tier: 'read',
        output: { record: 'data' },
      },
    ));
    expect(seen?.slug).toBe('ticket-reader-hubspot');
    expect(seen?.risk_tier).toBe('read');
    expect(seen?.output).toEqual({ record: 'data' });
  });

  it('strips connection_kind + connection from params (only the discriminants disappear)', async () => {
    let captured: Record<string, unknown> | undefined;
    const adapter = createConnectionAdapter({
      store: mkStore([mkRow({ kind: 'api', name: 'hubspot' })]),
      handlers: {
        api: async (_record, params) => {
          captured = params;
          return null;
        },
      },
    });
    await adapter(mkCall({
      connection_kind: 'api',
      connection: 'hubspot',
      method: 'GET',
      path: '/x',
      anything_else: 'flows-through',
    }));
    expect(captured).toEqual({
      method: 'GET',
      path: '/x',
      anything_else: 'flows-through',
    });
    // connection_kind / connection MUST NOT appear in params (handlers
    // shouldn't have to re-strip).
    expect(captured).not.toHaveProperty('connection_kind');
    expect(captured).not.toHaveProperty('connection');
  });
});

// ────────────────────────────────────────────────────────────────
// Missing handler — INGREDIENT_ADAPTER_ALL_FAILED placeholder
// ────────────────────────────────────────────────────────────────

describe('connection adapter — missing per-kind handler', () => {
  it('throws INGREDIENT_ADAPTER_ALL_FAILED with kind: connection.api when api handler is unwired', async () => {
    const adapter = createConnectionAdapter({
      store: mkStore([mkRow({ kind: 'api', name: 'hubspot' })]),
    });
    await expect(
      adapter(mkCall({ connection_kind: 'api', connection: 'hubspot' })),
    ).rejects.toMatchObject({
      code: 'INGREDIENT_ADAPTER_ALL_FAILED',
      details: { kind: 'connection.api', name: 'hubspot' },
    });
  });

  it('throws with kind: connection.mcp for unwired mcp', async () => {
    const adapter = createConnectionAdapter({
      store: mkStore([mkRow({ kind: 'mcp', name: 'gh-mcp' })]),
      handlers: { api: async () => 'irrelevant' }, // api wired, mcp not
    });
    await expect(
      adapter(mkCall({ connection_kind: 'mcp', connection: 'gh-mcp' })),
    ).rejects.toMatchObject({
      code: 'INGREDIENT_ADAPTER_ALL_FAILED',
      details: { kind: 'connection.mcp' },
    });
  });

  it('throws with kind: connection.notification for unwired notification', async () => {
    const adapter = createConnectionAdapter({
      store: mkStore([mkRow({ kind: 'notification', name: 'slack-team' })]),
    });
    await expect(
      adapter(mkCall({ connection_kind: 'notification', connection: 'slack-team' })),
    ).rejects.toMatchObject({
      code: 'INGREDIENT_ADAPTER_ALL_FAILED',
      details: { kind: 'connection.notification' },
    });
  });
});
