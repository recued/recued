import { describe, expect, it, vi } from 'vitest';
import type { ChatDispatchResult } from '@recued/contracts';
import { createAssetReadReuse, simpleAssetReadId } from '../chat-asset-read-reuse.js';
import { sourceCitation, sourceCitationHint, sourceReadVersion } from '../chat-source-citations.js';

const args = { kind: 'asset', id: 'asset:reuse' };
const result = (value = 'about 25 meters'): Extract<ChatDispatchResult, { ok: true }> => {
  const entity = { kind: 'asset', source_id: 'recued.asset', attributes: { length: value }, readings: {} };
  const source = sourceCitation({ kind: 'asset', asset_id: args.id }, 'Hose', sourceReadVersion(entity), 1000);
  return { ok: true, source_citations: [source], result: { found: true, entity,
    source_freshness: { source_id: 'recued.asset', state: 'local' }, plan: { action: 'local' }, ...sourceCitationHint(source) } };
};
const packet = (value: ChatDispatchResult, callArgs: unknown = args) => JSON.stringify({ prior_tool_calls: [
  { tool_name: 'work.read', status: 'ok', args: callArgs, result: value.ok ? value.result : undefined },
] });

describe('turn-local asset read reuse', () => {
  it('uses only a fully exposed canonical result and awaits current validation', async () => {
    const validate = vi.fn(async () => true); const cache = createAssetReadReuse(validate); const value = result();
    cache.remember(args, value);
    expect(await cache.reuse({ id: args.id, kind: 'asset' }, packet(value))).toBe(value);
    expect(validate).toHaveBeenCalledWith(args.id, sourceReadVersion({ kind: 'asset', source_id: 'recued.asset', attributes: { length: 'about 25 meters' }, readings: {} }));
  });

  it('does not recover missing, folded, elided or merely quoted results', async () => {
    const validate = vi.fn(async () => true); const cache = createAssetReadReuse(validate); const value = result();
    cache.remember(args, value);
    for (const body of ['', '{}', JSON.stringify({ chat_tail: [{ content: packet(value) }] }),
      packet({ ...value, result: { omitted: true } }), JSON.stringify({ prior_tool_calls: [{ tool_name: 'context.brief', result: value }] })]) {
      expect(await cache.reuse(args, body)).toBeUndefined();
    }
    expect(validate).not.toHaveBeenCalled();
  });

  it('drops a candidate when source or access validation fails', async () => {
    const validate = vi.fn(async () => false); const cache = createAssetReadReuse(validate); const value = result();
    cache.remember(args, value); expect(await cache.reuse(args, packet(value))).toBeUndefined();
    expect(await cache.reuse(args, packet(value))).toBeUndefined(); expect(validate).toHaveBeenCalledTimes(1);
  });

  it('does not share candidates across turn-local instances or a write barrier', async () => {
    const validate = vi.fn(async () => true); const first = createAssetReadReuse(validate); const value = result();
    first.remember(args, value);
    expect(await createAssetReadReuse(validate).reuse(args, packet(value))).toBeUndefined();
    first.clear(); expect(await first.reuse(args, packet(value))).toBeUndefined(); expect(validate).not.toHaveBeenCalled();
  });

  it.each([{ ...args, fidelity: 'rich_meta' }, { ...args, include_related: false }, { ...args, kind: 'note' },
    { ...args, id: 'we1:asset:recued.asset:local:reuse' }, { ...args, extra: 1 }])('keeps extended/qualified reads on the normal path: %j', async other => {
    const validate = vi.fn(async () => true); const cache = createAssetReadReuse(validate); const value = result();
    cache.remember(other, value); expect(simpleAssetReadId(other)).toBeUndefined();
    expect(await cache.reuse(other, packet(value, other))).toBeUndefined(); expect(validate).not.toHaveBeenCalled();
  });

  it.each([{ ok: false, reason: 'execution_error' }, { ...result(), run_failed: { detail: 'failed' } },
    { ...result(), run_held: { kind: 'approval' } }, { ...result(), source_citations: [] },
    { ...result(), result: { found: false } }] satisfies ChatDispatchResult[])('never reuses an unsuccessful or unattested result', async value => {
    const validate = vi.fn(async () => true); const cache = createAssetReadReuse(validate);
    cache.remember(args, value); expect(await cache.reuse(args, packet(value))).toBeUndefined();
    expect(validate).not.toHaveBeenCalled();
  });

  it('rejects a result mutated while its version is being checked', async () => {
    const value = result(); const body = packet(value);
    const cache = createAssetReadReuse(async () => { if (value.ok) value.result = { changed: true }; return true; });
    cache.remember(args, value); expect(await cache.reuse(args, body)).toBeUndefined();
  });

  it('does not retain large results or hide cancellation', async () => {
    const value = result('x'.repeat(20_000)); const validate = vi.fn(async () => true);
    const cache = createAssetReadReuse(validate); cache.remember(args, value);
    expect(await cache.reuse(args, packet(value))).toBeUndefined(); expect(validate).not.toHaveBeenCalled();
    const cancelled = createAssetReadReuse(async () => { throw new Error('cancelled'); }); const small = result();
    cancelled.remember(args, small); await expect(cancelled.reuse(args, packet(small))).rejects.toThrow('cancelled');
  });
});
