/** D-173 P5 (scan-gate part B) — kernel adapter `file-set-scan-status` case
 *  (backs `core.storage.file.set-scan-status`). Validates record_id + status at
 *  the gate, routes to the dispatcher, and fails closed (SERVER_NOT_REACHABLE /
 *  BAD_INPUT) without a dispatcher or on bad input. Mirrors the file-persist
 *  kernel test. */
import { describe, expect, it } from 'vitest';

import { createKernelAdapter } from '../kernel.js';
import { IngredientError } from '../types.js';

const RECORD_ID = 'file:' + 'a'.repeat(32);

const mkCall = (input: Record<string, unknown>) => ({
  slug: 'file-set-scan-status',
  risk_tier: 'write' as const,
  input,
  output: {},
}) as Parameters<ReturnType<typeof createKernelAdapter>>[0];

const RESULT = { record_id: RECORD_ID, scan_status: 'clean' as const };

describe('kernel adapter — file-set-scan-status', () => {
  it('routes {record_id, status} to the dispatcher and returns its result verbatim', async () => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      fileSetScanStatus: async (input) => {
        captured = input;
        return RESULT;
      },
    });

    const out = await adapter(mkCall({ record_id: RECORD_ID, status: 'clean' }));
    expect(out).toBe(RESULT);
    expect(captured).toEqual({ record_id: RECORD_ID, status: 'clean' });
  });

  it('throws SERVER_NOT_REACHABLE when the dispatcher is absent', async () => {
    const adapter = createKernelAdapter({});
    await expect(
      adapter(mkCall({ record_id: RECORD_ID, status: 'clean' })),
    ).rejects.toMatchObject({ code: 'SERVER_NOT_REACHABLE' });
  });

  it('rejects a missing / empty record_id with BAD_INPUT', async () => {
    const adapter = createKernelAdapter({ fileSetScanStatus: async () => RESULT });
    await expect(adapter(mkCall({ status: 'clean' })))
      .rejects.toMatchObject({ code: 'BAD_INPUT' });
    await expect(adapter(mkCall({ record_id: '', status: 'clean' })))
      .rejects.toMatchObject({ code: 'BAD_INPUT' });
  });

  it('rejects a status outside the FileScanStatus union with BAD_INPUT', async () => {
    const adapter = createKernelAdapter({ fileSetScanStatus: async () => RESULT });
    let caught: unknown;
    try {
      await adapter(mkCall({ record_id: RECORD_ID, status: 'infected' }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IngredientError);
    expect((caught as IngredientError).code).toBe('BAD_INPUT');
  });

  it('admits every member of the FileScanStatus union', async () => {
    const adapter = createKernelAdapter({ fileSetScanStatus: async (i) => ({ record_id: RECORD_ID, scan_status: i.status }) });
    for (const status of ['pending', 'clean', 'flagged', 'unscanned'] as const) {
      const out = await adapter(mkCall({ record_id: RECORD_ID, status }));
      expect((out as { scan_status: string }).scan_status).toBe(status);
    }
  });
});
