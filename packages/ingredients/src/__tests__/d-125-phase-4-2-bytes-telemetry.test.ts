/** D-125 Phase 4.2 — bytes telemetry threading through the audit shell.
 *
 *  Pins the contract that `ctx.setBytes(in, out)` calls inside a
 *  per-kind handler land on the corresponding `ConnectionAuditEmission`
 *  fields:
 *
 *    1. Handler calls ctx.setBytes → emission.bytes_in/out set.
 *    2. Handler skips ctx → emission omits bytes_in/out (undefined).
 *    3. Handler signature without 4th ctx arg keeps working
 *       (P3.x stub handlers + 3-arg lambdas).
 *    4. Idempotent — last setBytes call wins.
 *    5. Bytes flow on error paths too (handler set bytes before
 *       throwing). */

import { describe, expect, it } from 'vitest';
import type { ConnectionRow } from '@recued/contracts';
import {
  createConnectionAdapter,
  type ConnectionAdapterStore,
  type ConnectionAuditEmission,
  type ConnectionKindHandler,
} from '../connection.js';
import { IngredientError, type ResolvedCall } from '../types.js';

const mkRow = (): ConnectionRow => ({
  pk: 'api:hubspot',
  kind: 'api',
  name: 'hubspot',
  display_name: 'HubSpot',
  config_json: '{}',
  auth_ciphertext: 'opaque',
  enrolled_at: 0,
  updated_at: 0,
});

const mkStore = (rows: ReadonlyArray<ConnectionRow>): ConnectionAdapterStore => ({
  get(kind, name) {
    return rows.find((r) => r.kind === kind && r.name === name) ?? null;
  },
});

const mkCall = (overrides: Partial<ResolvedCall> = {}): ResolvedCall => ({
  slug: overrides.slug ?? 'connection',
  risk_tier: overrides.risk_tier ?? 'admin',
  input: overrides.input ?? { connection_kind: 'api', connection: 'hubspot' },
  output: overrides.output ?? {},
});

const mkSink = () => {
  const emissions: ConnectionAuditEmission[] = [];
  return { emissions, sink: (e: ConnectionAuditEmission) => { emissions.push(e); } };
};

describe('D-125 P4.2 — bytes telemetry through audit shell', () => {
  it('handler ctx.setBytes lands on emission.bytes_in/out', async () => {
    const { emissions, sink } = mkSink();
    const handler: ConnectionKindHandler = async (_record, _params, _call, ctx) => {
      ctx?.setBytes(1024, 256);
      return { ok: true };
    };
    const adapter = createConnectionAdapter({
      store: mkStore([mkRow()]),
      handlers: { api: handler },
      emitAudit: sink,
    });
    await adapter(mkCall());
    expect(emissions).toHaveLength(1);
    expect(emissions[0]).toMatchObject({
      bytes_in: 1024,
      bytes_out: 256,
      status: 'ok',
    });
  });

  it('handler that skips ctx leaves bytes fields undefined', async () => {
    const { emissions, sink } = mkSink();
    const handler: ConnectionKindHandler = async () => ({ ok: true });
    const adapter = createConnectionAdapter({
      store: mkStore([mkRow()]),
      handlers: { api: handler },
      emitAudit: sink,
    });
    await adapter(mkCall());
    expect(emissions[0]?.bytes_in).toBeUndefined();
    expect(emissions[0]?.bytes_out).toBeUndefined();
  });

  it('3-arg handler signature keeps working (backward compat)', async () => {
    const { emissions, sink } = mkSink();
    // Cast through the 4-arg signature to simulate an older 3-arg
    // handler — JS will receive the ctx as a 4th positional and
    // simply ignore it. Critically, the adapter must not throw.
    const legacyHandler = (async (
      _record: ConnectionRow,
      _params: Record<string, unknown>,
      _call: ResolvedCall,
    ) => 'legacy-ok') as unknown as ConnectionKindHandler;
    const adapter = createConnectionAdapter({
      store: mkStore([mkRow()]),
      handlers: { api: legacyHandler },
      emitAudit: sink,
    });
    const result = await adapter(mkCall());
    expect(result).toBe('legacy-ok');
    expect(emissions[0]?.status).toBe('ok');
    expect(emissions[0]?.bytes_in).toBeUndefined();
  });

  it('last setBytes call wins (idempotent)', async () => {
    const { emissions, sink } = mkSink();
    const handler: ConnectionKindHandler = async (_record, _params, _call, ctx) => {
      ctx?.setBytes(100, 50);
      ctx?.setBytes(200, 80); // overwrites
      return null;
    };
    const adapter = createConnectionAdapter({
      store: mkStore([mkRow()]),
      handlers: { api: handler },
      emitAudit: sink,
    });
    await adapter(mkCall());
    expect(emissions[0]).toMatchObject({ bytes_in: 200, bytes_out: 80 });
  });

  it('bytes set before throw still appear in error emission', async () => {
    const { emissions, sink } = mkSink();
    const handler: ConnectionKindHandler = async (_record, _params, _call, ctx) => {
      ctx?.setBytes(512, 128);
      throw new IngredientError('NETWORK_ERROR', 'wire failed');
    };
    const adapter = createConnectionAdapter({
      store: mkStore([mkRow()]),
      handlers: { api: handler },
      emitAudit: sink,
    });
    await expect(adapter(mkCall())).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(emissions[0]).toMatchObject({
      bytes_in: 512,
      bytes_out: 128,
      status: 'error',
      error: { code: 'NETWORK_ERROR' },
    });
  });
});
