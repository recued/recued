/** D-405 slice 7 — Connections opened from a chat answer's "Connect your mail" offers the way back to that
 *  answer: a "Back to chat" link under the page's heading, its chat hand-off going to the answer, and the
 *  first mailbox's Proposals (D-325's first session) carrying the answer on. Opened any other way, the
 *  page is as it was.
 *
 *  The accounts lane is replaced by one that records what the route handed it: its own tests cover when
 *  it calls each hand-off (`accounts-lane-oauth.test.ts`, and `connections.spec.ts` in a browser, which
 *  also runs this whole path). */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MountAccountsLanePanelOptions } from '../connections/accounts-lane-panel.js';
import {
  CONNECTIONS_ROUTE_BACK_TO_CHAT_ATTR,
  bootstrapConnectionsRoute,
} from '../connections/bootstrap-connections-route.js';
import { parseConnectionsAddress } from '../connections/connections-navigation.js';
import { parseShellRoute } from '../shell/route.js';
import { makeFakeDocument, type FakeEl } from './helpers/vendor-prefilled-enroll-rig.js';

const lanes: MountAccountsLanePanelOptions[] = [];
vi.mock('../connections/accounts-lane-panel.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../connections/accounts-lane-panel.js')>()),
  mountAccountsLanePanel: (opts: MountAccountsLanePanelOptions) => {
    lanes.push(opts);
    return {
      getState: () => ({ rows: [] }),
      refresh: async () => undefined,
      whenLoaded: async () => undefined,
      hasInFlightWork: () => false,
      hasUnsavedChanges: () => false,
      dispose: () => undefined,
    };
  },
}));

const all = (node: FakeEl): FakeEl[] => [node, ...node.children.flatMap(all)];
const mounted: Array<{ dispose(): void }> = [];
afterEach(() => {
  for (const route of mounted.splice(0)) route.dispose();
  lanes.length = 0;
});

/** The page at this address, as the app hands it the address it read; every navigation, kept. */
const open = (hash: string) => {
  const doc = makeFakeDocument();
  const root = doc.createElement('div');
  const navigate = vi.fn((_hash: string) => undefined);
  const address = parseConnectionsAddress(parseShellRoute(hash));
  const route = bootstrapConnectionsRoute({
    root: root as unknown as HTMLElement,
    document: doc as unknown as Document,
    ...(address !== null ? { initialAddress: address } : {}),
    navigate,
  });
  mounted.push(route);
  const back = all(root).filter((node) => node.attrs.has(CONNECTIONS_ROUTE_BACK_TO_CHAT_ATTR));
  return { back, navigate, lane: lanes.at(-1)! };
};

const SOURCE = { lane: 'mail' as const, providerId: 'gmail', slug: 'work' };

describe('D-405 slice 7 — Connections opened from a chat answer', () => {
  it('offers "Back to chat" to that answer, and its chat and the first mailbox\'s Proposals go back to it', () => {
    const { back, navigate, lane } = open('#connections/mail/return/chat/s1/m12');
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ tagName: 'A', textContent: 'Back to chat', href: '#chat/session/s1/answer/m12' });
    expect(lane.initialLane).toBe('mail');
    lane.onGoToChat!(SOURCE);
    expect(navigate).toHaveBeenLastCalledWith('#chat/session/s1/answer/m12');
    lane.onFirstMailboxConnected!();
    expect(navigate).toHaveBeenLastCalledWith('#yours/proposals/return/chat/s1/m12');
    // ⛔ Never as an account named "return": the lane opens on its list.
    expect(lane.initialDetailSlug).toBeUndefined();
  });

  it('a calendar or files lane too', () => {
    for (const laneId of ['calendar', 'file'] as const) {
      const { back, navigate, lane } = open(`#connections/${laneId}/return/chat/s1/m12`);
      expect(back.map((node) => (node as unknown as { href: string }).href)).toEqual(['#chat/session/s1/answer/m12']);
      expect(lane.initialLane).toBe(laneId);
      lane.onGoToChat!({ ...SOURCE, lane: laneId });
      expect(navigate).toHaveBeenLastCalledWith('#chat/session/s1/answer/m12');
    }
  });

  it('⛔ opened any other way, the page is as it was: no link, its own chat hand-off, Proposals alone', () => {
    for (const hash of ['#connections/mail', '#connections', '#connections/mail/return']) {
      const { back, navigate, lane } = open(hash);
      expect(back).toEqual([]);
      lane.onGoToChat!(SOURCE);
      expect(navigate).toHaveBeenLastCalledWith('#chat/source/mail/gmail/work');
      lane.onFirstMailboxConnected!();
      expect(navigate).toHaveBeenLastCalledWith('#yours/proposals');
    }
  });
});
