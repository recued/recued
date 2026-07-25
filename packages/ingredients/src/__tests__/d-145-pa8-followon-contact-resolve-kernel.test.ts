import { describe, expect, it } from 'vitest';

import { createKernelAdapter, type KernelDispatchers } from '../kernel.js';
import { IngredientError, type ResolvedCall } from '../types.js';

const mkCall = (input: Record<string, unknown>): ResolvedCall => ({
  slug: 'contact-resolve',
  risk_tier: 'read',
  input,
  output: {},
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

describe('kernel adapter — contact-resolve', () => {
  it('throws SERVER_NOT_REACHABLE when the contactResolve dispatcher is absent', async () => {
    const adapter = createKernelAdapter({} satisfies KernelDispatchers);

    await expectIngredientError(
      adapter(mkCall({ email: 'ada@example.test' })),
      'SERVER_NOT_REACHABLE',
    );
  });

  it('forwards an email-only lookup exactly', async () => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      contactResolve: async (input) => {
        captured = input;
        return { contact_id: 'c1', confidence: 1, alternatives: [] };
      },
    });

    await adapter(mkCall({ email: 'ada@example.test' }));

    expect(captured).toEqual({ email: 'ada@example.test' });
  });

  it('drops empty and whitespace-only string identifiers without pre-validating exactly one identifier', async () => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      contactResolve: async (input) => {
        captured = input;
        return { contact_id: null, confidence: 0, alternatives: [] };
      },
    });

    await adapter(mkCall({
      email: '  ',
      phone: '+15551234567',
      alias: '',
    }));

    expect(captured).toEqual({ phone: '+15551234567' });

    captured = undefined;
    await adapter(mkCall({ email: '   ' }));

    expect(captured).toEqual({});
  });

  it('forwards platform_id objects as-is and drops empty or null platform_id values', async () => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      contactResolve: async (input) => {
        captured = input;
        return { contact_id: null, confidence: 0, alternatives: [] };
      },
    });
    const platformId = { platform: 'github', id: 'ada' };

    await adapter(mkCall({ platform_id: platformId }));

    expect(captured).toEqual({ platform_id: platformId });
    expect((captured as { platform_id?: unknown }).platform_id).toBe(platformId);

    captured = undefined;
    await adapter(mkCall({ platform_id: '' }));

    expect(captured).toEqual({});

    captured = undefined;
    await adapter(mkCall({ platform_id: null }));

    expect(captured).toEqual({});
  });

  it('returns the dispatcher result verbatim without stamping the resolve envelope', async () => {
    const result = {
      contact_id: 'c1',
      confidence: 0.91,
      alternatives: ['c2'],
      contact: {
        _id: 'c1',
        _collection: 'contact' as const,
        email: 'ada@example.test',
        first_seen: 1,
        last_interaction: 2,
        interaction_count: 3,
        source: 'manual' as const,
        created_at: 1,
        updated_at: 2,
      },
    };
    const adapter = createKernelAdapter({
      contactResolve: async () => result,
    });

    const out = await adapter(mkCall({ email: 'ada@example.test' }));

    expect(out).toBe(result);
    expect(out).toEqual(result);
    expect(Object.prototype.hasOwnProperty.call(out as object, '_id')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(out as object, '_collection')).toBe(false);
  });
});
