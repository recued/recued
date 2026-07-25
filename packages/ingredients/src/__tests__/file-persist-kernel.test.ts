/** D-185 Slice 4 — kernel adapter `file-persist` case (backs
 *  `core.storage.file.persist`). Accepts ONLY a temp file_ref, threads the
 *  step's run_id/step_id to the dispatcher (for confined read + idempotent
 *  source_id), and fails closed on a cas ref / missing run scope. */
import { describe, expect, it } from 'vitest';

import { createKernelAdapter } from '../kernel.js';
import { IngredientError } from '../types.js';
import type { TempFileRef } from '@recued/contracts';

const TEMP_REF: TempFileRef = {
  backing: 'temp',
  path: '/tmp/recued-run-scratch/run-1/op-x/audio.mp3',
  mime_type: 'audio/mpeg',
  filename: 'audio.mp3',
};

const mkCall = (input: Record<string, unknown>, stepMeta?: Record<string, unknown>) => ({
  slug: 'file-persist',
  risk_tier: 'write' as const,
  input,
  output: {},
  ...(stepMeta ? { stepMeta } : {}),
}) as Parameters<ReturnType<typeof createKernelAdapter>>[0];

const PERSIST_RESULT = {
  cas_ref: 'file:' + 'a'.repeat(32),
  record_id: 'file:' + 'a'.repeat(32),
  mime_type: 'audio/mpeg',
  filename: 'audio.mp3',
  size_bytes: 11,
};

describe('kernel adapter — file-persist', () => {
  it('routes a temp ref + run_id/step_id to the dispatcher and returns its result verbatim', async () => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      filePersist: async (input) => {
        captured = input;
        return PERSIST_RESULT;
      },
    });

    const out = await adapter(
      mkCall({ ref: TEMP_REF }, { run_id: 'run-1', step_id: 'keep' }),
    );

    expect(out).toBe(PERSIST_RESULT);
    expect(captured).toEqual({ ref: TEMP_REF, run_id: 'run-1', step_id: 'keep' });
  });

  it('threads run_id without step_id (step_id omitted when absent)', async () => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      filePersist: async (input) => {
        captured = input;
        return PERSIST_RESULT;
      },
    });
    await adapter(mkCall({ ref: TEMP_REF }, { run_id: 'run-2' }));
    expect(captured).toEqual({ ref: TEMP_REF, run_id: 'run-2' });
  });

  it('throws SERVER_NOT_REACHABLE when the dispatcher is absent', async () => {
    const adapter = createKernelAdapter({});
    await expect(
      adapter(mkCall({ ref: TEMP_REF }, { run_id: 'run-1' })),
    ).rejects.toMatchObject({ code: 'SERVER_NOT_REACHABLE' });
  });

  it('rejects a cas (string) ref — already durable — with BAD_INPUT', async () => {
    const adapter = createKernelAdapter({ filePersist: async () => PERSIST_RESULT });
    await expect(
      adapter(mkCall({ ref: 'file:' + 'a'.repeat(32) }, { run_id: 'run-1' })),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });

  it('rejects a missing / malformed ref with BAD_INPUT', async () => {
    const adapter = createKernelAdapter({ filePersist: async () => PERSIST_RESULT });
    let caught: unknown;
    try {
      await adapter(mkCall({}, { run_id: 'run-1' }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IngredientError);
    expect((caught as IngredientError).code).toBe('BAD_INPUT');
  });

  it('rejects a half-formed temp ref (missing mime_type/filename) with BAD_INPUT — not a crash at ingest', async () => {
    const adapter = createKernelAdapter({ filePersist: async () => PERSIST_RESULT });
    // `isTempFileRef` validates the FULL shape, so a ref with only backing+path
    // fails the guard cleanly at the gate (never reaching the dispatcher / ingest).
    const partial = { backing: 'temp', path: '/tmp/recued-run-scratch/run-1/op-x/a.mp3' };
    await expect(
      adapter(mkCall({ ref: partial }, { run_id: 'run-1' })),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });

  it('fails closed when the step carries no run scope (no run_id)', async () => {
    const adapter = createKernelAdapter({ filePersist: async () => PERSIST_RESULT });
    await expect(
      adapter(mkCall({ ref: TEMP_REF })), // no stepMeta
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    await expect(
      adapter(mkCall({ ref: TEMP_REF }, { run_id: '' })), // empty run_id
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });
});
