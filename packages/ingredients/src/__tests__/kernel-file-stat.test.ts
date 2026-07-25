/** Phase 7 — file-stat kernel ingredient routing tests. */

import { describe, expect, it, vi } from 'vitest';
import { createKernelAdapter, type KernelDispatchers } from '../kernel.js';
import { IngredientError } from '../types.js';

const call = (slug: string, input: Record<string, unknown>) => ({
  slug,
  risk_tier: 'read' as const,
  input,
  output: {},
});

describe('file-stat kernel slug (Phase 7)', () => {
  it('routes to dispatchers.fileStat with { slug, path }', async () => {
    const fileStat = vi.fn().mockResolvedValue({
      exists: true,
      size_bytes: 42,
      modified_at_ms: 1_700_000_000_000,
      mime: 'application/pdf',
    });
    const dispatchers: KernelDispatchers = { fileStat };
    const adapter = createKernelAdapter(dispatchers);
    const res = await adapter(
      call('file-stat', { slug: 'myhomedir', path: 'report.pdf' }),
    );
    expect(fileStat).toHaveBeenCalledWith({
      slug: 'myhomedir',
      path: 'report.pdf',
    });
    expect(res).toEqual({
      exists: true,
      size_bytes: 42,
      modified_at_ms: 1_700_000_000_000,
      mime: 'application/pdf',
    });
  });

  it('surfaces { exists: false } without rethrowing', async () => {
    const fileStat = vi.fn().mockResolvedValue({ exists: false });
    const adapter = createKernelAdapter({ fileStat });
    const res = await adapter(call('file-stat', { slug: 'x', path: 'ghost' }));
    expect(res).toEqual({ exists: false });
    expect(fileStat).toHaveBeenCalledTimes(1);
  });

  it('throws SERVER_NOT_REACHABLE when no dispatcher wired', async () => {
    const adapter = createKernelAdapter({});
    try {
      await adapter(call('file-stat', { slug: 'x', path: 'y' }));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(IngredientError);
      expect((err as IngredientError).code).toBe('SERVER_NOT_REACHABLE');
      expect((err as IngredientError).message).toMatch(/file-stat/);
    }
  });

  it('propagates dispatcher errors (permission denied, io error)', async () => {
    const fileStat = vi.fn().mockRejectedValue(
      Object.assign(new Error('FILE_PERMISSION_DENIED: refused'), {
        status: 403,
      }),
    );
    const adapter = createKernelAdapter({ fileStat });
    await expect(
      adapter(call('file-stat', { slug: 'x', path: 'y' })),
    ).rejects.toThrow(/FILE_PERMISSION_DENIED/);
  });
});
