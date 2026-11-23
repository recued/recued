/** D-402 slice D5b — the Bridge commands of a looped Act call are keyed apart turn by turn. Task M's
 *  compiled loop, 2026-11-17: each turn clicked its page's number and read the table, yet pages 3 and 4
 *  read as page 2. The table's read had the same page handle and selector each turn, so the same
 *  idempotency key, and the Bridge replayed the first turn's answer. A retry of one turn keeps its key. */
import { describe, expect, it, vi } from 'vitest';
import type { BridgeResult } from '@recued/contracts';
import type { ResolvedCall } from '@recued/ingredients';
import type { BridgeDispatcher, DispatchOutcome, DispatchRequest } from '../bridges/dispatcher.js';
import { createBridgeDomAdapter } from '../bridges/dom-adapter.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';

const ok = (outputs: Record<string, unknown>): DispatchOutcome => ({ kind: 'completed', bridge_client_token_id: 'bridge-1', attempts: 1,
  result: { command_id: 'c', duration_ms: 3, bridge_version: '0.0.13', idempotency_key_seen: false, status: 'ok', outputs } as BridgeResult });

/** The idempotency key of an Act call's click, sent on turn `turn` of a loop (none: outside a loop). */
const clickKey = async (turn?: number[]): Promise<string> => {
  const requests: DispatchRequest[] = [];
  const dispatch = vi.fn<BridgeDispatcher['dispatch']>(async (request) => {
    requests.push(request);
    return ok({ page: '7:DOC1', url: 'https://example.com/table', title: 'Table' });
  });
  const adapter = createBridgeDomAdapter({
    manifests: { get: (slug) => KERNEL_MANIFESTS.find((manifest) => manifest.slug === slug) ?? null },
    getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: vi.fn(() => false) }),
  });
  const manifest = KERNEL_MANIFESTS.find((m) => m.slug === 'dom-act')!;
  const call: ResolvedCall = { slug: 'dom-act', risk_tier: 'write', output: manifest.output,
    input: { target: '*://*/*', page: '7:DOC1', steps: [{ do: 'click', selector: '#next' }] },
    stepMeta: { recipe_id: 'pages', step_id: 'act_3', run_id: 'run-1', ...(turn !== undefined ? { iteration_indices: turn } : {}) } };
  await adapter(call).catch(() => undefined);
  const keys = requests.filter((request) => request.action === 'click').map((request) => request.idempotency_key);
  expect(keys).toHaveLength(1);
  return keys[0]!;
};

describe('D-402 slice D5b — each turn of a loop sends its own commands', () => {
  it('another turn, another key; the same turn again, the same key; no turn, as outside a loop', async () => {
    const [first, second, again] = [await clickKey([0]), await clickKey([1]), await clickKey([1])];
    expect(first).not.toBe(second);
    expect(again).toBe(second);
    expect(await clickKey()).not.toBe(first);
    expect(await clickKey([])).toBe(await clickKey());
  });
});
