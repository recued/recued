import { describe, expect, it, vi } from 'vitest';
import type { ContactBusinessContextResult } from '@recued/contracts';

import { createKernelAdapter, type KernelDispatchers } from '../kernel.js';
import { IngredientError, type ResolvedCall } from '../types.js';

const mkCall = (input: Record<string, unknown>): ResolvedCall => ({
  slug: 'contact-business-context',
  risk_tier: 'read',
  input,
  output: {},
});

const result: ContactBusinessContextResult = {
  as_of: 500,
  known_before_at: 400,
  identity: {
    coverage: 'partial' as const,
    resolved: true,
    known_before: true,
    authoritative: false,
    company_known: false,
    same_company: false,
    same_company_contact_count: 0,
  },
  deals: {
    active_count: 0, historical_count: 0, won_count: 0, lost_count: 0, observed_count: 0,
    coverage: 'not_configured' as const,
  },
  tasks: { active_count: 1, historical_count: 0, observed_count: 1, coverage: 'complete' as const },
  calendar: { active_count: 0, historical_count: 0, observed_count: 0, coverage: 'complete' as const },
  bookings: { active_count: 0, historical_count: 0, observed_count: 0, coverage: 'complete' as const },
  projects: { active_count: 0, historical_count: 0, observed_count: 0, coverage: 'complete' as const },
  level: 'active' as const,
  active_families: ['tasks'],
  historical_families: [],
};

const captureError = async (promise: Promise<unknown>): Promise<IngredientError> => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(IngredientError);
    return error as IngredientError;
  }
  throw new Error('expected IngredientError');
};

describe('kernel adapter — contact-business-context', () => {
  it('fails closed when the server dispatcher is absent', async () => {
    const adapter = createKernelAdapter({} satisfies KernelDispatchers);

    const error = await captureError(adapter(mkCall({
      email: 'ada@example.test',
      as_of: 500,
      known_before_at: 400,
    })));

    expect(error.code).toBe('SERVER_NOT_REACHABLE');
  });

  it('canonicalizes the email, forwards as_of, and returns the projection verbatim', async () => {
    const dispatch = vi.fn(async () => result);
    const adapter = createKernelAdapter({ contactBusinessContext: dispatch });

    const output = await adapter(mkCall({
      email: '  ADA@Example.Test  ',
      as_of: 500,
      known_before_at: 400,
    }));

    expect(dispatch).toHaveBeenCalledWith({
      email: 'ada@example.test',
      as_of: 500,
      known_before_at: 400,
    });
    expect(output).toBe(result);
  });

  it.each([
    [{ email: '', as_of: 500, known_before_at: 400 }, 'email'],
    [{ email: 'not-an-email', as_of: 500, known_before_at: 400 }, 'email'],
    [{ email: 'ada@example.test' }, 'as_of'],
    [{ email: 'ada@example.test', as_of: -1, known_before_at: 0 }, 'as_of'],
    [{ email: 'ada@example.test', as_of: Number.POSITIVE_INFINITY, known_before_at: 400 }, 'as_of'],
    [{ email: 'ada@example.test', as_of: 500 }, 'known_before_at'],
    [{ email: 'ada@example.test', as_of: 500, known_before_at: -1 }, 'known_before_at'],
    [{ email: 'ada@example.test', as_of: 500, known_before_at: 501 }, 'known_before_at'],
  ])('rejects invalid input %j', async (input, field) => {
    const adapter = createKernelAdapter({
      contactBusinessContext: vi.fn(async () => result),
    });

    const error = await captureError(adapter(mkCall(input)));

    expect(error.code).toBe('BAD_INPUT');
    expect(error.message).toContain(field);
  });
});
