/** D-128 Phase 6 — connection adapter platform_scope attribution.
 *
 *  Sibling to `d-117-followon-connection-audit-step-attribution.test.ts`
 *  — pins that the new `stepMeta.platform_scope` field threads through
 *  the connection adapter onto every `ConnectionAuditEmission`, and is
 *  treated as absent when missing or empty (no half-populated rows). */

import { describe, expect, it } from 'vitest';
import type { ConnectionRow } from '@recued/contracts';
import {
  createConnectionAdapter,
  type ConnectionAuditEmission,
  type ConnectionKindHandler,
  type ConnectionAdapterStore,
} from '../connection.js';
import { IngredientError, type ResolvedCall } from '../types.js';

const mkRow = (overrides: Partial<ConnectionRow> = {}): ConnectionRow => ({
  pk: `${overrides.kind ?? 'api'}:${overrides.name ?? 'acme-hubspot'}`,
  kind: overrides.kind ?? 'api',
  name: overrides.name ?? 'acme-hubspot',
  display_name: overrides.display_name ?? 'Acme HubSpot',
  config_json: overrides.config_json ?? '{"base_url":"https://api.hubapi.com"}',
  auth_ciphertext: overrides.auth_ciphertext ?? 'opaque-blob',
  enrolled_at: overrides.enrolled_at ?? 1_700_000_000_000,
  updated_at: overrides.updated_at ?? 1_700_000_000_000,
  ...(overrides.subtype !== undefined ? { subtype: overrides.subtype } : {}),
});

const mkStore = (rows: ReadonlyArray<ConnectionRow>): ConnectionAdapterStore => ({
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
  ...(overrides.stepMeta ? { stepMeta: overrides.stepMeta } : {}),
});

const mkSink = () => {
  const emissions: ConnectionAuditEmission[] = [];
  const sink = (e: ConnectionAuditEmission) => { emissions.push(e); };
  return { emissions, sink };
};

describe('connection adapter audit — platform_scope attribution', () => {
  it('threads stepMeta.platform_scope onto the success emission', async () => {
    const { emissions, sink } = mkSink();
    const handler: ConnectionKindHandler = async () => ({ ok: true });
    const adapter = createConnectionAdapter({
      store: mkStore([mkRow({ kind: 'api', name: 'acme-hubspot', subtype: 'rest' })]),
      handlers: { api: handler },
      emitAudit: sink,
    });

    await adapter(mkCall(
      { connection_kind: 'api', connection: 'acme-hubspot' },
      {
        slug: 'deal-reader-hubspot',
        stepMeta: {
          step_id: 'fetch_updated',
          recipe_id: 'reconcile-hubspot-deals',
          platform_scope: 'connection.api.hubspot.deal',
        },
      },
    ));

    expect(emissions).toHaveLength(1);
    expect(emissions[0]).toMatchObject({
      kind: 'api',
      status: 'ok',
      recipe_id: 'reconcile-hubspot-deals',
      step_id: 'fetch_updated',
      platform_scope: 'connection.api.hubspot.deal',
    });
  });

  it('omits platform_scope from emission when stepMeta lacks the field', async () => {
    const { emissions, sink } = mkSink();
    const handler: ConnectionKindHandler = async () => ({ ok: true });
    const adapter = createConnectionAdapter({
      store: mkStore([mkRow({ kind: 'api', name: 'acme-hubspot', subtype: 'rest' })]),
      handlers: { api: handler },
      emitAudit: sink,
    });

    await adapter(mkCall(
      { connection_kind: 'api', connection: 'acme-hubspot' },
      {
        slug: 'deal-reader-hubspot',
        stepMeta: { step_id: 'fetch', recipe_id: 'r' },
      },
    ));

    expect(emissions).toHaveLength(1);
    expect(emissions[0]).not.toHaveProperty('platform_scope');
    expect(emissions[0]).toMatchObject({
      recipe_id: 'r',
      step_id: 'fetch',
    });
  });

  it('omits platform_scope when stepMeta is absent (direct-rpc callers)', async () => {
    const { emissions, sink } = mkSink();
    const handler: ConnectionKindHandler = async () => ({ ok: true });
    const adapter = createConnectionAdapter({
      store: mkStore([mkRow({ kind: 'api', name: 'acme-hubspot' })]),
      handlers: { api: handler },
      emitAudit: sink,
    });

    await adapter(mkCall(
      { connection_kind: 'api', connection: 'acme-hubspot' },
    ));

    expect(emissions).toHaveLength(1);
    expect(emissions[0]).not.toHaveProperty('platform_scope');
    expect(emissions[0]).not.toHaveProperty('recipe_id');
    expect(emissions[0]).not.toHaveProperty('step_id');
  });

  it('error-path emission carries platform_scope (CONNECTION_NOT_FOUND)', async () => {
    const { emissions, sink } = mkSink();
    const handler: ConnectionKindHandler = async () => ({ ok: true });
    const adapter = createConnectionAdapter({
      store: mkStore([]), // no records — lookup will miss
      handlers: { api: handler },
      emitAudit: sink,
    });

    await expect(adapter(mkCall(
      { connection_kind: 'api', connection: 'missing' },
      {
        slug: 'deal-reader-hubspot',
        stepMeta: {
          step_id: 'fetch_updated',
          recipe_id: 'reconcile-hubspot-deals',
          platform_scope: 'connection.api.hubspot.deal',
        },
      },
    ))).rejects.toBeInstanceOf(IngredientError);

    expect(emissions).toHaveLength(1);
    expect(emissions[0]).toMatchObject({
      status: 'error',
      error: expect.objectContaining({ code: 'CONNECTION_NOT_FOUND' }),
      platform_scope: 'connection.api.hubspot.deal',
    });
  });

  it('CONNECTION_NOT_BOUND path also carries platform_scope', async () => {
    const { emissions, sink } = mkSink();
    const handler: ConnectionKindHandler = async () => ({ ok: true });
    const adapter = createConnectionAdapter({
      store: mkStore([mkRow({ kind: 'api', name: 'acme-hubspot' })]),
      handlers: { api: handler },
      emitAudit: sink,
    });

    await expect(adapter(mkCall(
      { connection_kind: 'api', connection: '' },
      {
        slug: 'deal-reader-hubspot',
        stepMeta: {
          step_id: 'fetch_updated',
          recipe_id: 'reconcile-hubspot-deals',
          platform_scope: 'connection.api.hubspot.deal',
        },
      },
    ))).rejects.toBeInstanceOf(IngredientError);

    expect(emissions).toHaveLength(1);
    expect(emissions[0]).toMatchObject({
      status: 'error',
      error: expect.objectContaining({ code: 'CONNECTION_NOT_BOUND' }),
      platform_scope: 'connection.api.hubspot.deal',
    });
  });
});
