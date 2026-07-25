/** D-117 follow-on (post-D-127) — connection adapter step-identity tests.
 *
 *  D-127 P2.1 widened `ResolvedCall` with `stepMeta` so kernel adapters
 *  can attribute audit rows back to the originating recipe + step. The
 *  D-127 audit follow-on (commit `90b2ecc`) used that substrate to
 *  thread `recipe_id` + `step_id` through the `mail_send` audit row.
 *  This test file pins the symmetric extension to the connection
 *  adapter — every `connection_api` / `connection_mcp` /
 *  `connection_notification` row now carries the originating recipe +
 *  step when the adapter receives a populated `stepMeta`, and stays
 *  unattributed when it doesn't (direct-rpc callers, MCP agent paths,
 *  Settings → Connections probe). */

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
  pk: `${overrides.kind ?? 'api'}:${overrides.name ?? 'hubspot'}`,
  kind: overrides.kind ?? 'api',
  name: overrides.name ?? 'hubspot',
  display_name: overrides.display_name ?? 'HubSpot',
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

describe('connection adapter audit — step identity attribution', () => {
  it('engine-driven api call propagates recipe_id + step_id onto the success emission', async () => {
    const { emissions, sink } = mkSink();
    const handler: ConnectionKindHandler = async () => ({ ok: true });
    const adapter = createConnectionAdapter({
      store: mkStore([mkRow({ kind: 'api', name: 'hubspot', subtype: 'rest' })]),
      handlers: { api: handler },
      emitAudit: sink,
    });

    await adapter(mkCall(
      { connection_kind: 'api', connection: 'hubspot' },
      {
        slug: 'ticket-reader-hubspot',
        stepMeta: { step_id: 'fetch_ticket', recipe_id: 'detect-ticket-risk-hubspot' },
      },
    ));

    expect(emissions).toHaveLength(1);
    expect(emissions[0]).toMatchObject({
      kind: 'api',
      status: 'ok',
      recipe_id: 'detect-ticket-risk-hubspot',
      step_id: 'fetch_ticket',
    });
  });

  it('engine-driven mcp call propagates identity onto the emission', async () => {
    const { emissions, sink } = mkSink();
    const adapter = createConnectionAdapter({
      store: mkStore([mkRow({ kind: 'mcp', name: 'tools', subtype: 'sse' })]),
      handlers: { mcp: async () => null },
      emitAudit: sink,
    });

    await adapter(mkCall(
      { connection_kind: 'mcp', connection: 'tools' },
      { stepMeta: { step_id: 'invoke_tool', recipe_id: 'mcp-tool-caller' } },
    ));

    expect(emissions[0]?.recipe_id).toBe('mcp-tool-caller');
    expect(emissions[0]?.step_id).toBe('invoke_tool');
  });

  it('engine-driven notification call propagates identity', async () => {
    const { emissions, sink } = mkSink();
    const adapter = createConnectionAdapter({
      store: mkStore([mkRow({ kind: 'notification', name: 'team-slack', subtype: 'slack' })]),
      handlers: { notification: async () => ({ ok: true }) },
      emitAudit: sink,
    });

    await adapter(mkCall(
      { connection_kind: 'notification', connection: 'team-slack', text: 'hello' },
      {
        slug: 'slack-post',
        stepMeta: { step_id: 'notify_owner', recipe_id: 'detect-deal-risk-hubspot' },
      },
    ));

    expect(emissions[0]).toMatchObject({
      kind: 'notification',
      status: 'ok',
      recipe_id: 'detect-deal-risk-hubspot',
      step_id: 'notify_owner',
    });
  });

  it('absent stepMeta omits recipe_id + step_id (direct-rpc caller path)', async () => {
    const { emissions, sink } = mkSink();
    const handler: ConnectionKindHandler = async () => ({ ok: true });
    const adapter = createConnectionAdapter({
      store: mkStore([mkRow({ kind: 'api', name: 'hubspot' })]),
      handlers: { api: handler },
      emitAudit: sink,
    });

    // No `stepMeta` — Settings → Connections probe / MCP agent / tests
    // all reach the adapter without engine context. The audit row
    // should land but carry no attribution.
    await adapter(mkCall(
      { connection_kind: 'api', connection: 'hubspot' },
      { slug: 'connection' },
    ));

    expect(emissions).toHaveLength(1);
    expect(emissions[0]?.recipe_id).toBeUndefined();
    expect(emissions[0]?.step_id).toBeUndefined();
  });

  it('partial stepMeta (step_id only) propagates step_id without synthesizing recipe_id', async () => {
    const { emissions, sink } = mkSink();
    const adapter = createConnectionAdapter({
      store: mkStore([mkRow({ kind: 'api', name: 'hubspot' })]),
      handlers: { api: async () => ({ ok: true }) },
      emitAudit: sink,
    });

    // `recipe_id` is optional on `StepMeta`; D-115 watcher executor +
    // pre-D-127 callers populate `step_id` only. The emission must
    // surface what's present without inventing a recipe attribution.
    await adapter(mkCall(
      { connection_kind: 'api', connection: 'hubspot' },
      { stepMeta: { step_id: 'fetch_ticket' } },
    ));

    expect(emissions[0]?.step_id).toBe('fetch_ticket');
    expect(emissions[0]?.recipe_id).toBeUndefined();
  });

  it('error paths attribute identity onto the failure emission', async () => {
    const { emissions, sink } = mkSink();
    const handler: ConnectionKindHandler = async () => {
      throw new IngredientError('UPSTREAM_ERROR', 'hubspot 503', { slug: 'ticket-reader-hubspot' });
    };
    const adapter = createConnectionAdapter({
      store: mkStore([mkRow({ kind: 'api', name: 'hubspot', subtype: 'rest' })]),
      handlers: { api: handler },
      emitAudit: sink,
    });

    await expect(
      adapter(mkCall(
        { connection_kind: 'api', connection: 'hubspot' },
        {
          slug: 'ticket-reader-hubspot',
          stepMeta: { step_id: 'fetch_ticket', recipe_id: 'detect-ticket-risk-hubspot' },
        },
      )),
    ).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });

    expect(emissions).toHaveLength(1);
    expect(emissions[0]).toMatchObject({
      status: 'error',
      error: { code: 'UPSTREAM_ERROR' },
      recipe_id: 'detect-ticket-risk-hubspot',
      step_id: 'fetch_ticket',
    });
  });

  it('CONNECTION_NOT_BOUND error path still attributes identity when known', async () => {
    const { emissions, sink } = mkSink();
    const adapter = createConnectionAdapter({
      store: mkStore([]),
      emitAudit: sink,
    });

    // The picker hasn't bound a connection but the engine knows which
    // step asked. Attributing the row lets the user trace which recipe
    // + step is misconfigured directly from the activity feed.
    await expect(
      adapter(mkCall(
        { connection_kind: 'api', connection: '' },
        { stepMeta: { step_id: 'fetch_ticket', recipe_id: 'broken-recipe' } },
      )),
    ).rejects.toMatchObject({ code: 'CONNECTION_NOT_BOUND' });

    expect(emissions[0]).toMatchObject({
      status: 'error',
      error: { code: 'CONNECTION_NOT_BOUND' },
      recipe_id: 'broken-recipe',
      step_id: 'fetch_ticket',
    });
  });

  it('CONNECTION_NOT_FOUND error path attributes identity when known', async () => {
    const { emissions, sink } = mkSink();
    const adapter = createConnectionAdapter({
      store: mkStore([]),
      emitAudit: sink,
    });

    await expect(
      adapter(mkCall(
        { connection_kind: 'mcp', connection: 'missing' },
        { stepMeta: { step_id: 'invoke_tool', recipe_id: 'mcp-tool-caller' } },
      )),
    ).rejects.toMatchObject({ code: 'CONNECTION_NOT_FOUND' });

    expect(emissions[0]).toMatchObject({
      status: 'error',
      error: { code: 'CONNECTION_NOT_FOUND' },
      recipe_id: 'mcp-tool-caller',
      step_id: 'invoke_tool',
    });
  });

  it('missing-handler INGREDIENT_ADAPTER_ALL_FAILED attributes identity', async () => {
    const { emissions, sink } = mkSink();
    const adapter = createConnectionAdapter({
      store: mkStore([mkRow({ kind: 'mcp', name: 'tools', subtype: 'stdio' })]),
      // No handler wired — runtime doesn't host mcp.
      emitAudit: sink,
    });

    await expect(
      adapter(mkCall(
        { connection_kind: 'mcp', connection: 'tools' },
        { stepMeta: { step_id: 'invoke_tool', recipe_id: 'r1' } },
      )),
    ).rejects.toMatchObject({ code: 'INGREDIENT_ADAPTER_ALL_FAILED' });

    expect(emissions[0]).toMatchObject({
      kind: 'mcp',
      status: 'error',
      recipe_id: 'r1',
      step_id: 'invoke_tool',
    });
  });
});
