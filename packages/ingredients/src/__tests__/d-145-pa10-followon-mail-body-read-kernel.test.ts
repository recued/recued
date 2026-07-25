import { describe, expect, it } from 'vitest';

import { createKernelAdapter } from '../kernel.js';
import { IngredientError } from '../types.js';

const mkCall = (slug: string, input: Record<string, unknown>) => ({
  slug,
  risk_tier: 'read' as const,
  input,
  output: {},
  manifest_version: 1,
});

const expectIngredientError = async (
  promise: Promise<unknown>,
  code?: string,
): Promise<void> => {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(IngredientError);
  if (code) {
    expect((caught as IngredientError).code).toBe(code);
  }
};

describe('kernel adapter — mail-body-read', () => {
  it('routes to the mail-body-read dispatcher and returns its result verbatim', async () => {
    let captured: unknown;
    const result = { body: 'x', found: true, size_bytes: 1, truncated: false };
    const adapter = createKernelAdapter({
      mailBodyRead: async (input) => {
        captured = input;
        return result;
      },
    });

    const out = await adapter(mkCall('mail-body-read', {
      slug: 'gmail',
      record_id: 'msg-1',
    }));

    expect(out).toBe(result);
    expect(captured).toEqual({ slug: 'gmail', record_id: 'msg-1' });
  });

  it('forwards max_chars when provided', async () => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      mailBodyRead: async (input) => {
        captured = input;
        return { body: 'abc', found: true, size_bytes: 6, truncated: true };
      },
    });

    await adapter(mkCall('mail-body-read', {
      slug: 'gmail',
      record_id: 'msg-1',
      max_chars: 3,
    }));

    expect(captured).toEqual({
      slug: 'gmail',
      record_id: 'msg-1',
      max_chars: 3,
    });
  });

  it('omits max_chars when it is not provided', async () => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      mailBodyRead: async (input) => {
        captured = input;
        return { body: 'abc', found: true, size_bytes: 3, truncated: false };
      },
    });

    await adapter(mkCall('mail-body-read', {
      slug: 'gmail',
      record_id: 'msg-1',
    }));

    expect(captured).toEqual({ slug: 'gmail', record_id: 'msg-1' });
    expect(Object.prototype.hasOwnProperty.call(captured as object, 'max_chars')).toBe(false);
    expect((captured as { max_chars?: unknown }).max_chars).toBeUndefined();
  });

  it("throws SERVER_NOT_REACHABLE when the mailBodyRead dispatcher is absent", async () => {
    const adapter = createKernelAdapter({});

    await expect(adapter(mkCall('mail-body-read', {
      slug: 'gmail',
      record_id: 'msg-1',
    }))).rejects.toMatchObject({ code: 'SERVER_NOT_REACHABLE' });
  });

  it('rejects missing slug with IngredientError', async () => {
    const adapter = createKernelAdapter({
      mailBodyRead: async () => ({ body: null, found: false, size_bytes: 0, truncated: false }),
    });

    await expectIngredientError(adapter(mkCall('mail-body-read', {
      record_id: 'msg-1',
    })), 'BAD_INPUT');
  });

  it('rejects missing record_id with IngredientError', async () => {
    const adapter = createKernelAdapter({
      mailBodyRead: async () => ({ body: null, found: false, size_bytes: 0, truncated: false }),
    });

    await expectIngredientError(adapter(mkCall('mail-body-read', {
      slug: 'gmail',
    })), 'BAD_INPUT');
  });

  it.each([-1, 2.5])(
    'rejects invalid max_chars %s with IngredientError(BAD_INPUT)',
    async (max_chars) => {
      const adapter = createKernelAdapter({
        mailBodyRead: async () => ({ body: null, found: false, size_bytes: 0, truncated: false }),
      });

      await expectIngredientError(adapter(mkCall('mail-body-read', {
        slug: 'gmail',
        record_id: 'msg-1',
        max_chars,
      })), 'BAD_INPUT');
    },
  );
});
