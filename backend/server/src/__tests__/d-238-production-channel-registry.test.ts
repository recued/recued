/** D-238 — the PRODUCTION channel registry, not a hand-built channel.
 *
 *  ⛔⛔ This file exists because every other D-238 test built its channel by
 *  calling `createRemoteChannel` directly, and the shipped feature was
 *  nonetheless completely absent: `buildMessengerRemoteChannels` fed off the
 *  INTERACTIVE-ONLY transport map, so `messengerChannels.teams` never existed.
 *  Teams was missing from notification fan-out and readiness, and inbound events
 *  were dropped as "no channel adapter wired" — with the whole suite green,
 *  because no test ever called the builder the server actually uses.
 *
 *  🔑 The rule this encodes: a vendor is not shipped because its leaf works. It
 *  is shipped when the composition root produces it. */

import { describe, expect, it } from 'vitest';

import { listMessengerVendors, getMessengerVendorDeclaration } from '@recued/contracts';

import { buildMessengerRemoteChannels } from '../composition/bin/messenger-transport-leaves.js';
import type { ConnectionStoreSqlite } from '../storage/connection-store.js';

const emptyStore = (): ConnectionStoreSqlite =>
  ({ get: () => null }) as unknown as ConnectionStoreSqlite;

describe('buildMessengerRemoteChannels — the map the server actually uses', () => {
  it('includes EVERY declared vendor, interactive or not', () => {
    const channels = buildMessengerRemoteChannels({ connectionStore: emptyStore() });
    // Derived, so a future vendor is covered with no edit here — and so this
    // cannot be satisfied by hard-spelling the four that already worked.
    for (const vendor of listMessengerVendors()) {
      expect(Object.keys(channels)).toContain(vendor);
    }
  });

  /** ⛔ The specific regression. Teams has no `sendPrompt`; a filter keyed on
   *  that is what dropped it, and the drop was invisible everywhere else. */
  it('includes Teams, which has no sendPrompt', () => {
    const channels = buildMessengerRemoteChannels({ connectionStore: emptyStore() });
    expect(channels.teams).toBeDefined();
  });

  /** ⛔ And with its DECLARED capability. Omitting it defaults the channel to
   *  `inline`, which for a transport without `sendPrompt` throws at construction
   *  — so a capability regression shows up as the builder failing outright,
   *  which this asserts does not happen. */
  it('gives every channel the capability its declaration states', () => {
    const channels = buildMessengerRemoteChannels({ connectionStore: emptyStore() });
    for (const vendor of listMessengerVendors()) {
      const declared = getMessengerVendorDeclaration(vendor)?.capability;
      expect(channels[vendor]?.capability).toBe(declared);
    }
    // Named explicitly too: the derived loop above passes vacuously if every
    // vendor happened to be `inline`, which was the world before Teams.
    expect(channels.teams?.capability).toBe('landing-page');
  });

  it('names each channel for its vendor, so closeAsk and the dispatcher agree', () => {
    const channels = buildMessengerRemoteChannels({ connectionStore: emptyStore() });
    for (const [vendor, channel] of Object.entries(channels)) {
      expect(channel.name).toBe(vendor);
    }
  });
});
