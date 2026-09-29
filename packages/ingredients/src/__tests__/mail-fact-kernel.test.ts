/** D-315 — the kernel adapter's mail-fact reads: `mail-fact-get` needs an id,
 *  and `mail-fact-list` refuses a malformed filter rather than dropping it (a
 *  dropped filter would widen the list without a word). */

import type { MailFactListInput } from '@recued/contracts';
import { describe, expect, it, vi } from 'vitest';

import { createKernelAdapter } from '../kernel.js';

const call = (slug: string, input: Record<string, unknown>) => ({
  slug,
  risk_tier: 'read' as const,
  input,
  output: {},
});

describe('kernel adapter — mail-fact-get', () => {
  it('routes the trimmed id and returns what the server read', async () => {
    const mailFactGet = vi.fn(async () => ({ thing: null, facts: [] }));
    const adapter = createKernelAdapter({ mailFactGet });
    await expect(adapter(call('mail-fact-get', { id: ' mthing_1 ' }))).resolves.toEqual({ thing: null, facts: [] });
    expect(mailFactGet).toHaveBeenCalledWith({ id: 'mthing_1' });
  });

  it('requires an id', async () => {
    const adapter = createKernelAdapter({ mailFactGet: async () => ({ thing: null, facts: [] }) });
    await expect(adapter(call('mail-fact-get', {}))).rejects.toMatchObject({
      code: 'BAD_INPUT',
      message: 'mail-fact-get: id is required',
    });
  });

  it('fails closed without a server', async () => {
    await expect(createKernelAdapter({})(call('mail-fact-get', { id: 'x' }))).rejects.toMatchObject({
      code: 'SERVER_NOT_REACHABLE',
    });
    await expect(createKernelAdapter({})(call('mail-fact-list', {}))).rejects.toMatchObject({
      code: 'SERVER_NOT_REACHABLE',
    });
  });
});

describe('kernel adapter — mail-fact-list', () => {
  const listed = async (input: Record<string, unknown>): Promise<MailFactListInput | undefined> => {
    const mailFactList = vi.fn(async (_query: MailFactListInput) => ({ records: [] }));
    await createKernelAdapter({ mailFactList })(call('mail-fact-list', input));
    return mailFactList.mock.calls[0]?.[0];
  };

  it('defaults to things, treats null as absent, and passes every filter through', async () => {
    expect(await listed({})).toEqual({ of: 'things' });
    expect(await listed({ of: null, type: null, state: null, identity: null, since: null, limit: null }))
      .toEqual({ of: 'things' });
    expect(await listed({
      type: 'shipment',
      state: 'delivered',
      identity: { carrier: 'UPS', tracking_number: '1Z 999' },
      since: 5,
      limit: 20,
    })).toEqual({
      of: 'things',
      type: 'shipment',
      state: 'delivered',
      identity: { carrier: 'UPS', tracking_number: '1Z 999' },
      since: 5,
      limit: 20,
    });
    expect(await listed({ of: 'facts', type: 'bill' })).toEqual({ of: 'facts', type: 'bill' });
  });

  it('refuses a malformed filter instead of dropping it', async () => {
    const adapter = createKernelAdapter({ mailFactList: async () => ({ records: [] }) });
    for (const [input, reason] of [
      [{ of: 'emails' }, 'of must be one of things, facts'],
      [{ type: 'parcel' }, 'type must be a mail fact type'],
      [{ state: '' }, 'state must be a non-empty string'],
      [{ of: 'facts', state: 'delivered' }, 'state filters things'],
      [{ identity: { carrier: 'UPS' } }, 'identity needs a type'],
      [{ type: 'shipment', identity: { carrier: 5 } }, 'identity must be an object'],
      [{ type: 'shipment', of: 'facts', identity: { carrier: 'UPS' } }, 'identity names a thing'],
      [{ since: -1 }, 'since must be a time'],
      [{ limit: 0 }, 'limit must be a whole number from 1 to 500'],
      [{ limit: 501 }, 'limit must be a whole number from 1 to 500'],
      [{ limit: 2.5 }, 'limit must be a whole number from 1 to 500'],
    ] as const) {
      await expect(adapter(call('mail-fact-list', input)), JSON.stringify(input)).rejects.toMatchObject({
        code: 'BAD_INPUT',
        message: expect.stringContaining(reason),
      });
    }
  });
});
