import { describe, expect, it, vi } from 'vitest';
import { createKernelAdapter } from '../kernel.js';
import type { AssetCreateInput } from '@recued/contracts';

const call = (slug: string, input: Record<string, unknown>, stepMeta?: object) => ({
  slug, input, output: {}, risk_tier: 'read' as const, manifest_version: 1, stepMeta,
}) as never;

describe('asset kernel authority boundaries', () => {
  it('pins the observation actor to the installed recipe and returns no asset facts', async () => {
    const observe = vi.fn(async () => ({ asset_id: 'a1', changed_fields: ['readings.battery'] }));
    const adapter = createKernelAdapter({ assetObserve: observe });
    const input = { binding_id: 'b1', readings: { battery: { value: 2, unit: '%', as_of: 1, evidence: [] } } };
    expect(await adapter(call('asset-observe', input, { recipe_id: 'health', step_id: 'record', run_id: 'native-run' })))
      .toEqual({ asset_id: 'a1', changed_fields: ['readings.battery'] });
    expect(observe).toHaveBeenCalledWith(input, 'recipe:health', undefined, 'native-run');
    await expect(adapter(call('asset-observe', { ...input, run_id: 'forged-run' }, { recipe_id: 'health', run_id: 'native-run' }))).rejects.toThrow(/run_id/);
    await expect(adapter(call('asset-observe', { ...input, actor_ref: 'recipe:other' }, { recipe_id: 'health' }))).rejects.toThrow(/actor_ref/);
    await expect(adapter(call('asset-observe', { ...input, status: 'retired' }, { recipe_id: 'health' }))).rejects.toThrow(/status/);
    await expect(adapter(call('asset-observe', input))).rejects.toThrow(/installed recipe/);
    expect(observe).toHaveBeenCalledTimes(1);
  });
  it('never admits a recipe-authored owner rank or returns an existing private record from a write', async () => {
    const create = vi.fn(async (_input: AssetCreateInput) => ({ asset: { id: 'a1', document_number: 'private' } }));
    const adapter = createKernelAdapter({ assetCreate: create });
    await expect(adapter(call('asset-create', { name: 'ID', source: { kind: 'owner', ref: 'forged' } }))).rejects.toThrow(/extracted/);
    const source = { channel: 'reactive', actor: 'system', source_recipe: 'intake', event_kind: 'mail' };
    expect(await adapter(call('asset-create', { name: 'ID', source: { kind: 'extracted', ref: 'mail:1' },
      origin_execution_source: { channel: 'user', actor: 'user_self' } }, { execution_source: source })))
      .toEqual({ asset_id: 'a1' });
    expect(create.mock.calls[0]?.[0]).toMatchObject({ origin_execution_source: source });
  });
  it('forwards only the engine source to generic asset reads', async () => {
    const get = vi.fn(async () => ({ entity: null, found: false }));
    const adapter = createKernelAdapter({ workEntityGet: get });
    const actual = { channel: 'mcp', actor: 'contracted_user', contract_id: 'door' };
    await adapter(call('work-entity-get', { kind: 'asset', id: 'a1', origin_execution_source: { channel: 'user', actor: 'user_self' } }, { execution_source: actual }));
    expect(get).toHaveBeenCalledWith(expect.objectContaining({ origin_execution_source: actual }));
  });
});
