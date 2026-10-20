import { describe, expect, it, vi } from 'vitest';
import { assetKernelReadGates } from '../asset-kernel-read-gates.js';
import type { ExecutionSource } from '@recued/contracts';
const source: ExecutionSource = { channel: 'reactive', actor: 'system', event_kind: 'fixture', source_recipe: 'fixture' };

describe('generic asset read grants', () => {
  it.each([[false, false], [false, true], [true, false], [true, true]])('composes verb %s and collection %s before any rows or counts are read', async (verb, collection) => {
    const list = vi.fn(async () => ({ entities: [], total: 0 }));
    const get = vi.fn(async () => ({ entity: null, found: false }));
    const checker = { isVerbOpGranted: () => verb, isCollectionReadGranted: () => collection, isTopicReadGranted: () => false };
    const gates = assetKernelReadGates({ workEntityList: list, workEntityGet: get }, { resolveForSource: () => checker, resolveForContract: () => checker });
    if (verb && collection) {
      await gates.workEntityList!({ kind: 'asset', origin_execution_source: source });
      await gates.workEntityGet!({ kind: 'asset', id: 'a1', origin_execution_source: source });
      expect(list).toHaveBeenCalledTimes(1); expect(get).toHaveBeenCalledTimes(1);
    } else {
      await expect(gates.workEntityList!({ kind: 'asset', origin_execution_source: source })).rejects.toThrow(/data.asset/);
      await expect(gates.workEntityGet!({ kind: 'asset', id: 'a1', origin_execution_source: source })).rejects.toThrow(/data.asset/);
      expect(list).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled();
    }
  });
  it('fails closed without an engine origin or a resolver', async () => {
    const list = vi.fn(async () => ({ entities: [], total: 0 }));
    await expect(assetKernelReadGates({ workEntityList: list }, undefined).workEntityList!({ kind: 'asset' })).rejects.toThrow();
    expect(list).not.toHaveBeenCalled();
  });
});
