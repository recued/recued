import { describe, expect, it, vi } from 'vitest';
import { isLiveSendCapableMailInstance } from '../ws-server.js';

describe('D-196 Seller mail readiness', () => {
  it.each([
    ['missing collection', undefined, false],
    ['read-only collection', { sendCapable: false }, false],
    ['flag without executable send', { sendCapable: true }, false],
    ['send method without capability flag', { sendCapable: false, send: vi.fn() }, false],
    ['live send-capable collection', { sendCapable: true, send: vi.fn() }, true],
  ] as const)('resolves %s from the live mail registry', (
    _label,
    collection,
    expected,
  ) => {
    const get = vi.fn(() => collection as never);

    expect(isLiveSendCapableMailInstance({ get }, 'mail_primary')).toBe(expected);
    expect(get).toHaveBeenCalledWith('mail', 'mail_primary');
  });
});
