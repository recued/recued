import { describe, expect, it, vi } from 'vitest';

import {
  CONTACT_ATTRIBUTE_TEMPLATES,
  type DataSnapshot,
} from '@recued/middleware-prompt-cache';

import { createPromptCacheGateDeps } from '../chat-prompt-cache-gate.js';
import type { ContactStore } from '../storage/contact-store.js';

const CONTACT_NAME_LOOKUP_LIMIT = 50;

const NAME_SLOT = {
  kind: 'entity.name',
  value: 'Alice Bond',
  raw: 'Alice Bond',
  position: 8,
} as const;

const contact = (
  overrides: Partial<{
    readonly email: string;
    readonly name: string;
    readonly phone: string;
    readonly company: string;
  }> = {},
): ReturnType<ContactStore['list']>[number] => ({
  email: 'alice@x.com',
  name: 'Alice Bond',
  phone: '+14155550199',
  company: 'ACME',
  ...overrides,
}) as unknown as ReturnType<ContactStore['list']>[number];

const makeStore = (list: ContactStore['list']): ContactStore =>
  ({ list, addressSet: (email: string) => [email] }) as unknown as ContactStore;

const probeContactAttribute = async (
  getContactStore: () => ContactStore | undefined,
): Promise<DataSnapshot | null> => {
  // Contact-attribute probe path doesn't touch the calendar registry — a
  // no-op getter keeps these tests focused on the contact lookup.
  const deps = createPromptCacheGateDeps(getContactStore, () => undefined);
  return await deps.probeData({
    template: CONTACT_ATTRIBUTE_TEMPLATES.email,
    slots: [NAME_SLOT],
  });
};

describe('D-164 P5 prompt-cache gate backend contact lookup', () => {
  it('resolves a single exact contact match through ContactStore.list', async () => {
    const list = vi.fn<ContactStore['list']>(() => [
      contact({
        name: 'alice  bond',
        email: 'alice@x.com',
        phone: '+14155550199',
        company: 'ACME',
      }),
    ]);
    const store = makeStore(list);

    const out = await probeContactAttribute(() => store);

    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith({
      name_contains: 'Alice Bond',
      limit: CONTACT_NAME_LOOKUP_LIMIT,
    });
    expect(out?.data).toEqual({
      name: 'alice  bond',
      email: 'alice@x.com',
      phone: '+14155550199',
      company: 'ACME',
    });
    expect(Object.isFrozen(out?.data)).toBe(true);
  });

  it('fails closed when the contact name lookup returns a full page', async () => {
    const rows = Array.from({ length: CONTACT_NAME_LOOKUP_LIMIT }, (_unused, idx) =>
      contact({
        email: `alice-${idx}@x.com`,
        name: idx === 0 ? 'Alice Bond' : `Alice Bond ${idx}`,
      }));
    const list = vi.fn<ContactStore['list']>(() => rows);
    const store = makeStore(list);

    await expect(probeContactAttribute(() => store)).resolves.toBeNull();
    expect(list).toHaveBeenCalledWith({
      name_contains: 'Alice Bond',
      limit: CONTACT_NAME_LOOKUP_LIMIT,
    });
  });

  it('returns null when the contact store is absent or list throws', async () => {
    await expect(probeContactAttribute(() => undefined)).resolves.toBeNull();

    const list = vi.fn<ContactStore['list']>(() => {
      throw new Error('contact store unavailable');
    });
    const store = makeStore(list);

    await expect(probeContactAttribute(() => store)).resolves.toBeNull();
    expect(list).toHaveBeenCalledTimes(1);
  });
});
