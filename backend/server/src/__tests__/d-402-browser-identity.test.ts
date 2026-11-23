/** D-402 slice H1 (§4.2 items 5 and 6, ruling 14) — a browser's lasting identity and its name, over the
 *  real token store (a real rotation) and the real paired-instances store (a real rename and revoke). */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createClientTokenStore } from '../pairing/client-tokens.js';
import { createPairedInstancesStore } from '../paired-instances-store.js';
import { createBrowserIdentity } from '../bridges/browser-identity.js';
import { createBridgeRegistry } from '../bridges/registry.js';
import { createWebSocketUpgrade, type WebSocketUpgradeBinding } from '../ws-server.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

const DAY = 86_400_000;
const NOV_3 = Date.UTC(2026, 10, 3, 9);
const stand = () => {
  const db = new Database(':memory:'); databases.push(db);
  let now = NOV_3;
  const tokens = createClientTokenStore(db, { argon2_params: { t: 1, m: 8, p: 1 }, now: () => now });
  const instances = createPairedInstancesStore(db);
  const identity = createBrowserIdentity({
    tokens: () => tokens.list({ client_kind: 'bridge' }),
    instance: (instance_id) => instances.get(instance_id),
  });
  /** A Bridge paired as the side panel pairs it: an instance it minted, and a token issued to it. */
  const pair = async (instance_id: string | undefined, label: string, at = now) => {
    now = at;
    if (instance_id !== undefined) instances.addOrRefresh({ instance_id, user_id: 'owner', display_name: label, kind: 'bridge' });
    const issued = await tokens.issue({ client_kind: 'bridge', client_label: label,
      ...(instance_id !== undefined ? { metadata: { issued_via: 'pair', instance_id } } : {}) });
    return issued.token_id;
  };
  return { tokens, instances, identity, pair, setNow: (at: number) => { now = at; } };
};

describe('D-402 slice H1 — a browser\'s lasting identity', () => {
  it('a credential rotation keeps the browser: its lasting id now routes to the new token', async () => {
    const t = stand();
    const first = await t.pair('inst-work', 'Chrome on macOS');
    expect(t.identity.list()).toEqual([{ browser_id: 'inst-work', bridge_id: first, name: 'Chrome on macOS' }]);
    const rotated = await t.tokens.rotate({ token_id: first });
    if (!rotated.ok) throw new Error('expected a rotation');
    expect(t.identity.list()).toEqual([{ browser_id: 'inst-work', bridge_id: rotated.new_token_id, name: 'Chrome on macOS' }]);
    expect(t.identity.bridgeFor('inst-work')).toBe(rotated.new_token_id);
    // The replaced token names no browser any more.
    expect(t.identity.bridgeFor(first)).toBeUndefined();
  });

  it('a fresh pairing is a new browser; the one it replaced, revoked, is no longer paired', async () => {
    const t = stand();
    await t.pair('inst-old', 'Chrome on macOS');
    t.instances.revoke('inst-old');
    const fresh = await t.pair('inst-new', 'Chrome on macOS', NOV_3 + DAY);
    expect(t.identity.bridgeFor('inst-old')).toBeUndefined();
    expect(t.identity.list()).toEqual([{ browser_id: 'inst-new', bridge_id: fresh, name: 'Chrome on macOS' }]);
  });

  it('a token issued without a paired instance is its own identity', async () => {
    const t = stand();
    const bare = await t.pair(undefined, 'Old Bridge');
    expect(t.identity.list()).toEqual([{ browser_id: bare, bridge_id: bare, name: 'Old Bridge' }]);
    expect(t.identity.bridgeFor(bare)).toBe(bare);
  });
});

describe('D-402 slice H1 — the name its owner gave it', () => {
  it('the owner\'s name over the label it paired with, and a rename is seen at once', async () => {
    const t = stand();
    const token = await t.pair('inst-work', 'Chrome on macOS');
    t.instances.rename('inst-work', 'Work');
    expect(t.identity.list()).toEqual([{ browser_id: 'inst-work', bridge_id: token, name: 'Work' }]);
  });

  it('two of one name are told apart by the day each was paired, and by pairing order on the same day', async () => {
    const t = stand();
    await t.pair('inst-a', 'Chrome on macOS', NOV_3);
    await t.pair('inst-b', 'Chrome on macOS', NOV_3 + 6 * DAY);
    expect(t.identity.list().map((browser) => browser.name)).toEqual(['Chrome on macOS (paired Nov 3)', 'Chrome on macOS (paired Nov 9)']);
    await t.pair('inst-c', 'Chrome on macOS', NOV_3 + 6 * DAY + 60_000);
    expect(t.identity.list().map((browser) => browser.name)).toEqual(['Chrome on macOS (paired Nov 3)',
      'Chrome on macOS (paired Nov 9) #1', 'Chrome on macOS (paired Nov 9) #2']);
    // A rename that ends the collision ends the telling apart.
    t.instances.rename('inst-a', 'Work');
    t.instances.rename('inst-b', 'Personal');
    expect(t.identity.list().map((browser) => browser.name)).toEqual(['Work', 'Personal', 'Chrome on macOS']);
  });
});

describe('D-402 slice H1 — the server\'s own browser roster (`ws-server.ts`)', () => {
  let binding: WebSocketUpgradeBinding | undefined;
  afterEach(() => { binding?.handle.close(); binding = undefined; });

  it('lists each paired browser under its current token, by its owner\'s name, through a rename and a rotation', async () => {
    const db = new Database(':memory:'); databases.push(db);
    const clientTokens = createClientTokenStore(db, { argon2_params: { t: 1, m: 8, p: 1 } });
    const pairedInstances = createPairedInstancesStore(db);
    pairedInstances.addOrRefresh({ instance_id: 'inst-work', user_id: 'owner', display_name: 'Chrome on macOS', kind: 'bridge' });
    const issued = await clientTokens.issue({ client_kind: 'bridge', client_label: 'Chrome on macOS',
      metadata: { issued_via: 'pair', instance_id: 'inst-work' } });
    binding = createWebSocketUpgrade({ clientTokens, pairedInstances, bridgeRegistry: createBridgeRegistry() });
    const roster = () => binding!.handle.bridgeDispatcher?.listBrowserBridges?.();
    expect(roster()).toEqual([{ bridge_id: issued.token_id, bridge_label: 'Chrome on macOS', online: false }]);
    pairedInstances.rename('inst-work', 'Work');
    expect(roster()).toEqual([{ bridge_id: issued.token_id, bridge_label: 'Work', online: false }]);
    const rotated = await clientTokens.rotate({ token_id: issued.token_id });
    if (!rotated.ok) throw new Error('expected a rotation');
    expect(roster()).toEqual([{ bridge_id: rotated.new_token_id, bridge_label: 'Work', online: false }]);
  });
});

describe('D-402 slice H3 — the name a browser no longer paired went by', () => {
  /** The identity as the server builds it: revoked tokens listed too (`ws-server.ts`). */
  const withRevoked = (t: ReturnType<typeof stand>) => createBrowserIdentity({
    tokens: () => t.tokens.list({ client_kind: 'bridge', include_revoked: true }),
    instance: (instance_id) => t.instances.get(instance_id),
  });
  it('its owner\'s name for it, after its pairing was revoked and a fresh one took its place', async () => {
    const t = stand();
    await t.pair('inst-old', 'Chrome on macOS');
    t.instances.rename('inst-old', 'Work');
    t.instances.revoke('inst-old');
    await t.pair('inst-new', 'Chrome on macOS', NOV_3 + DAY);
    const identity = withRevoked(t);
    expect(identity.list().map((browser) => browser.browser_id)).toEqual(['inst-new']);
    expect(identity.formerName('inst-old')).toBe('Work');
  });
  it('else the label its last pairing came with, its token revoked; nothing for a browser never paired', async () => {
    const t = stand();
    const token = await t.pair(undefined, 'Chrome on Windows');
    t.tokens.revoke(token, 'test');
    const identity = withRevoked(t);
    expect(identity.list()).toEqual([]);
    expect(identity.formerName(token)).toBe('Chrome on Windows');
    expect(identity.formerName('inst-never')).toBeUndefined();
  });
});
