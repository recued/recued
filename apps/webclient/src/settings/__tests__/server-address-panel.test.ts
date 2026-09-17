/** D-148 — Settings → Account & Servers, address editing.
 *
 *  Driven through a fake Document (no jsdom in this repo), against the REAL
 *  orchestration, the REAL probe and a REAL Ed25519 server — so "the candidate
 *  proved it is this server" means the same thing here as in production. */

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { codeNear } from '../../__tests__/helpers/source-text.js';
import { generateKeyPairSync } from 'node:crypto';
import type { WebclientServerProfile } from '@recued/contracts';
import { buildIdentityProbePayload } from '@recued/contracts';
import { ed25519Sign } from '@recued/server/keys/index.js';
import type { Ed25519Keypair } from '@recued/server/keys/index.js';

import { serverMountIdentity } from '../../auth/server-url-change-guard.js';
import {
  mountServerAddressPanel,
  retargetMessage,
  SERVER_ADDRESS_ROW_ATTR,
  SERVER_ADDRESS_SAVE_BTN_ATTR,
  SERVER_ADDRESS_CHECK_BTN_ATTR,
  SERVER_ADDRESS_EDIT_BTN_ATTR,
} from '../server-address-panel.js';

// ── Fake DOM ────────────────────────────────────────────────────────────
interface FakeElement {
  tagName: string;
  textContent: string;
  disabled: boolean;
  value: string;
  children: FakeElement[];
  parent: FakeElement | null;
  attrs: Map<string, string>;
  listeners: Map<string, Array<(ev: unknown) => void>>;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  appendChild(el: FakeElement): FakeElement;
  removeChild(el: FakeElement): FakeElement;
  readonly firstChild: FakeElement | null;
  remove(): void;
  addEventListener(n: string, f: (ev: unknown) => void): void;
  click(): void;
}

const makeEl = (tagName: string): FakeElement => {
  const children: FakeElement[] = [];
  const listeners = new Map<string, Array<(ev: unknown) => void>>();
  const attrs = new Map<string, string>();
  const el: FakeElement = {
    tagName: tagName.toUpperCase(),
    textContent: '',
    disabled: false,
    value: '',
    children,
    parent: null,
    attrs,
    listeners,
    setAttribute: (k, v) => attrs.set(k, v),
    getAttribute: (k) => attrs.get(k) ?? null,
    appendChild: (n) => { children.push(n); n.parent = el; return n; },
    removeChild: (t) => {
      const i = children.indexOf(t);
      if (i < 0) throw new Error('removeChild: not a child');
      children.splice(i, 1); t.parent = null; return t;
    },
    get firstChild() { return children[0] ?? null; },
    remove: () => { if (el.parent) el.parent.removeChild(el); },
    addEventListener: (n, f) => {
      const a = listeners.get(n) ?? []; a.push(f); listeners.set(n, a);
    },
    click: () => { for (const f of listeners.get('click') ?? []) f({ target: el }); },
  };
  return el;
};

const makeDoc = () => ({ createElement: (t: string) => makeEl(t) }) as unknown as Document;

const walk = (el: FakeElement, out: FakeElement[] = []): FakeElement[] => {
  out.push(el);
  for (const c of el.children) walk(c, out);
  return out;
};
const findIn = (root: FakeElement, attr: string): FakeElement | undefined =>
  walk(root).find((e) => e.attrs.has(attr));
const rowEl = (host: FakeElement, id: string): FakeElement =>
  walk(host).find((e) => e.getAttribute(SERVER_ADDRESS_ROW_ATTR) === id)!;

// ── Real server ─────────────────────────────────────────────────────────
const realKeypair = (): Ed25519Keypair => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    key_class: 'server_identity_key',
    private_key_b64: (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).toString('base64'),
    public_key_b64: (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64'),
    public_key_fingerprint: 'unused',
    created_at: 0,
  } as Ed25519Keypair;
};

const signingServer = (keypair: Ed25519Keypair) =>
  (async (_u: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { nonce: string };
    return new Response(JSON.stringify({
      signature: ed25519Sign(keypair, buildIdentityProbePayload({
        nonce: body.nonce, server_public_key: keypair.public_key_b64,
      })),
    }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;

const OLD = 'wss://home.example:443/ws';
const NEW = 'wss://home.example:4433/ws';

const profile = (keypair: Ed25519Keypair): WebclientServerProfile => ({
  id: 'p1',
  label: 'Home',
  server_url: OLD,
  webclient_token: null,
  server_public_key: keypair.public_key_b64,
  pair_metadata: null,
  cert_pin_state: null,
  last_connected_at: null,
});

const mount = (over: {
  keypair?: Ed25519Keypair;
  fetch?: typeof globalThis.fetch;
  retarget?: RetargetFn;
} = {}) => {
  const keypair = over.keypair ?? realKeypair();
  const host = makeEl('div');
  const retarget = over.retarget ?? vi.fn(async (_id: string, url: string) => url);
  const panel = mountServerAddressPanel({
    host: host as never,
    document: makeDoc(),
    listProfiles: async () => [profile(keypair)],
    deps: {
      tokenStore: { wrap: async () => { throw new Error('unused'); }, unwrap: async () => 'b' },
      retarget,
      fetch: over.fetch ?? signingServer(keypair),
    },
  });
  return { panel, host, retarget, keypair };
};
type RetargetFn = (id: string, url: string, token: unknown) => Promise<string | null>;

describe('Settings → Account & Servers — changing a server address', () => {
  it('renders each server with a Change address button and writes nothing on mount', async () => {
    const { panel, host, retarget } = mount();
    await panel.refresh();
    expect(findIn(rowEl(host, 'p1'), SERVER_ADDRESS_EDIT_BTN_ATTR)).toBeDefined();
    expect(panel.rowState('p1')).toBe('idle');
    expect(retarget).not.toHaveBeenCalled();
  });

  it('⛔ CHECKING DOES NOT SAVE — the proof and the write are two acts', async () => {
    const { panel, host, retarget } = mount();
    await panel.refresh();
    panel.clickEdit('p1');
    panel.typeAddress('p1', NEW);
    await panel.clickCheck('p1');

    expect(panel.rowState('p1')).toBe('verified');
    // The whole point of probe-and-confirm: proven, and still not written.
    expect(retarget).not.toHaveBeenCalled();
    expect(findIn(rowEl(host, 'p1'), SERVER_ADDRESS_SAVE_BTN_ATTR)).toBeDefined();
  });

  it('saves only after Save, and reports the new address', async () => {
    const { panel, retarget } = mount();
    await panel.refresh();
    panel.clickEdit('p1');
    panel.typeAddress('p1', NEW);
    await panel.clickCheck('p1');
    await panel.clickSave('p1');

    expect(retarget).toHaveBeenCalledTimes(1);
    expect((retarget as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toBe(NEW);
    expect(panel.rowState('p1')).toBe('saved');
    expect(panel.statusText('p1')).toContain(NEW);
  });

  it('⛔ offers no Save when the candidate cannot prove it is this server', async () => {
    const impostor = realKeypair();
    const { panel, host, retarget } = mount({ fetch: signingServer(impostor) });
    await panel.refresh();
    panel.clickEdit('p1');
    panel.typeAddress('p1', NEW);
    await panel.clickCheck('p1');

    expect(panel.rowState('p1')).toBe('refused');
    expect(findIn(rowEl(host, 'p1'), SERVER_ADDRESS_SAVE_BTN_ATTR)).toBeUndefined();
    expect(retarget).not.toHaveBeenCalled();
    expect(panel.statusText('p1')).toContain('could not prove');
  });

  it('says so plainly when nothing answers', async () => {
    const { panel } = mount({
      fetch: (async () => { throw new TypeError('Failed to fetch'); }) as never,
    });
    await panel.refresh();
    panel.clickEdit('p1');
    panel.typeAddress('p1', NEW);
    await panel.clickCheck('p1');
    expect(panel.rowState('p1')).toBe('refused');
    expect(panel.statusText('p1')).toContain('Nothing answered');
  });

  it('⚠ a proof does not survive editing the address again', async () => {
    // The signature is bound to the address that was probed. Leaving Save
    // armed after an edit would let a proven address authorise an unproven one.
    const { panel, host } = mount();
    await panel.refresh();
    panel.clickEdit('p1');
    panel.typeAddress('p1', NEW);
    await panel.clickCheck('p1');
    expect(panel.rowState('p1')).toBe('verified');

    panel.typeAddress('p1', 'wss://somewhere.else/ws');
    expect(panel.rowState('p1')).toBe('editing');
    expect(findIn(rowEl(host, 'p1'), SERVER_ADDRESS_SAVE_BTN_ATTR)).toBeUndefined();
    expect(findIn(rowEl(host, 'p1'), SERVER_ADDRESS_CHECK_BTN_ATTR)).toBeDefined();
  });

  it('refuses an unparseable address without contacting anything', async () => {
    const fetchSpy = vi.fn();
    const { panel } = mount({ fetch: fetchSpy as never });
    await panel.refresh();
    panel.clickEdit('p1');
    panel.typeAddress('p1', 'just some text');
    await panel.clickCheck('p1');
    expect(panel.rowState('p1')).toBe('refused');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('Cancel drops the draft and writes nothing', async () => {
    const { panel, retarget } = mount();
    await panel.refresh();
    panel.clickEdit('p1');
    panel.typeAddress('p1', NEW);
    await panel.clickCheck('p1');
    panel.clickCancel('p1');
    expect(panel.rowState('p1')).toBe('idle');
    expect(retarget).not.toHaveBeenCalled();
  });

  it('reports a store refusal without claiming success', async () => {
    const { panel } = mount({ retarget: async () => null });
    await panel.refresh();
    panel.clickEdit('p1');
    panel.typeAddress('p1', NEW);
    await panel.clickCheck('p1');
    await panel.clickSave('p1');
    // ⚠ The probe-only path reads a null retarget as "everything before the
    // write passed", so the SAVE is where a real refusal must surface.
    expect(panel.rowState('p1')).toBe('refused');
    expect(panel.statusText('p1')).toContain('already uses that address');
  });

  it('⚠ the saved message says to RELOAD — the live socket is still on the old address', async () => {
    // The server-switch convergence flow keys on `activeProfileId` CHANGING,
    // and a retarget moves the URL of the SAME profile — so it closes
    // immediately and nothing converges the tab. Someone who just moved a DEAD
    // address would otherwise read "Saved." and sit on a broken tab.
    const { panel } = mount();
    await panel.refresh();
    panel.clickEdit('p1');
    panel.typeAddress('p1', NEW);
    await panel.clickCheck('p1');
    await panel.clickSave('p1');
    expect(panel.statusText('p1')).toContain('Reload');
    expect(panel.statusText('p1')).toContain(NEW);
  });

  // ── Converging the live tab ─────────────────────────────────────────────

  const mountWithConverge = (over: {
    activeId?: string | null;
    converge?: () => 'reloading' | 'deferred';
    activeThrows?: boolean;
  } = {}) => {
    const keypair = realKeypair();
    const host = makeEl('div');
    const converge = vi.fn(over.converge ?? (() => 'reloading' as const));
    const panel = mountServerAddressPanel({
      host: host as never,
      document: makeDoc(),
      listProfiles: async () => [profile(keypair), { ...profile(keypair), id: 'p2', label: 'B', server_url: 'wss://other.example/ws' }],
      deps: {
        tokenStore: { unwrap: async () => 'b', wrap: async () => ({}) } as never,
        retarget: async (_id: string, url: string) => url,
        fetch: signingServer(keypair),
      },
      activeProfileId: async () => {
        if (over.activeThrows) throw new Error('idb unavailable');
        return over.activeId === undefined ? 'p1' : over.activeId;
      },
      onActiveAddressChanged: converge,
    });
    return { panel, converge };
  };

  const saveP1 = async (panel: ReturnType<typeof mountServerAddressPanel>) => {
    await panel.refresh();
    panel.clickEdit('p1');
    panel.typeAddress('p1', NEW);
    await panel.clickCheck('p1');
    await panel.clickSave('p1');
  };

  it('⛔ reloads the tab after saving the address it is CONNECTED through', async () => {
    const { panel, converge } = mountWithConverge({ activeId: 'p1' });
    await saveP1(panel);
    expect(converge).toHaveBeenCalledTimes(1);
    expect(panel.rowState('p1')).toBe('saved');
  });

  it('⛔ does NOT reload when another profile was the one moved', async () => {
    // Nothing live points at it, so yanking the tab would discard work for
    // a change that affects nothing on screen.
    const { panel, converge } = mountWithConverge({ activeId: 'p2' });
    await saveP1(panel);
    expect(converge).not.toHaveBeenCalled();
    expect(panel.rowState('p1')).toBe('saved');
  });

  it('⚠ a DEFERRED reload says the tab is still on the old address', async () => {
    // The host refuses when work would be lost. The address IS saved — the
    // message must not imply otherwise, and must name what is still true.
    const { panel, converge } = mountWithConverge({ converge: () => 'deferred' });
    await saveP1(panel);
    expect(converge).toHaveBeenCalledTimes(1);
    expect(panel.rowState('p1')).toBe('saved');
    expect(panel.statusText('p1')).toContain('still using the old address');
    expect(panel.statusText('p1')).toContain(NEW);
  });

  it('⚠ never yanks the tab when it cannot PROVE which profile is active', async () => {
    const { panel, converge } = mountWithConverge({ activeThrows: true });
    await saveP1(panel);
    expect(converge).not.toHaveBeenCalled();
    // ...and the save still stands.
    expect(panel.rowState('p1')).toBe('saved');
  });

  it('a host with no reload seam still saves, and still says to reload', async () => {
    const { panel } = mount();
    await saveP1(panel);
    expect(panel.rowState('p1')).toBe('saved');
    expect(panel.statusText('p1')).toContain('Reload');
  });

  it('⛔ converges only AFTER the write has landed', async () => {
    // Converging is about the live tab, not about the save. A reload racing
    // the write would discard the tab with nothing persisted.
    const order: string[] = [];
    const keypair = realKeypair();
    const panel = mountServerAddressPanel({
      host: makeEl('div') as never,
      document: makeDoc(),
      listProfiles: async () => [profile(keypair)],
      deps: {
        tokenStore: { unwrap: async () => 'b', wrap: async () => ({}) } as never,
        retarget: async (_id: string, url: string) => { order.push('write'); return url; },
        fetch: signingServer(keypair),
      },
      activeProfileId: async () => 'p1',
      onActiveAddressChanged: () => { order.push('reload'); return 'reloading'; },
    });
    await saveP1(panel);
    expect(order).toEqual(['write', 'reload']);
  });

  it('⛔ every optional dep the panel declares is one the BOOT passes', () => {
    // An `onSaved` hook lived here once, threaded through the route, and the
    // boot never passed it. This replaces a check for that ONE name with the
    // property it was reaching for: the panel's optional deps and the boot's
    // wiring must not drift apart, whatever they get called.
    const panelSrc = readFileSync(
      resolve(import.meta.dirname, '..', 'server-address-panel.ts'),
      'utf-8',
    );
    const optionsBlock = panelSrc.slice(
      panelSrc.indexOf('export interface MountServerAddressPanelOptions'),
      panelSrc.indexOf('export interface ServerAddressPanelMount'),
    );
    const declared = [...optionsBlock.matchAll(/readonly (\w+)\??:/g)]
      .map((m) => m[1]!)
      // `host`/`document`/`deps` are supplied structurally, not through
      // `serverAddressDeps`.
      .filter((name) => !['host', 'document', 'deps'].includes(name));
    expect(declared.length).toBeGreaterThan(0);

    // ⚠ CODE ONLY — comments stripped. `toContain('activeProfileId:')` passed
    // against `// activeProfileId: dropped on purpose`, so the boot could drop
    // a dep entirely and this guard would still say it was passed.
    const wiring = codeNear(
      resolve(import.meta.dirname, '..', '..', 'webclient-bootstrap.ts'),
      'serverAddressDeps: {',
      1800,
    );
    for (const name of declared) {
      // A property ASSIGNED a value, not a name appearing somewhere.
      expect(wiring, `the boot never passes \`${name}\``)
        .toMatch(new RegExp(`\\b${name}:\\s*[^,\\s]`));
    }
  });

  // ── State-machine guards (found by mutation, all three untested) ────────

  it('⛔⛔ Save does NOTHING from a state that has not been verified', async () => {
    // ⚠ THE CORE SAFETY PROPERTY, AND IT WAS ENFORCED ONLY BY THE UI NOT
    // RENDERING A BUTTON. Deleting `row.state !== 'verified'` reddened nothing,
    // because every test Checks before Saving. A stale button, a double click
    // landing after a re-render, or any future caller would have written an
    // address that never proved anything.
    const { panel, retarget } = mount();
    await panel.refresh();

    // Straight to Save from idle.
    await panel.clickSave('p1');
    expect(retarget).not.toHaveBeenCalled();

    // From an open editor with a typed address but no Check.
    panel.clickEdit('p1');
    panel.typeAddress('p1', NEW);
    await panel.clickSave('p1');
    expect(retarget).not.toHaveBeenCalled();
    expect(panel.rowState('p1')).toBe('editing');

    // From a REFUSED check.
    panel.typeAddress('p1', 'not a url');
    await panel.clickCheck('p1');
    expect(panel.rowState('p1')).toBe('refused');
    await panel.clickSave('p1');
    expect(retarget).not.toHaveBeenCalled();
  });

  it('⛔ a check that lands after the row moved on is discarded', async () => {
    // The probe is async. If the user cancels — or edits again — while it is in
    // flight, its verdict belongs to an address the row no longer shows.
    // Applying it would arm Save for something nobody checked.
    const keypair = realKeypair();
    let release: ((r: Response) => void) | null = null;
    let reached: () => void = () => {};
    const reachedFetch = new Promise<void>((r) => { reached = r; });
    const retarget = vi.fn(async (_id: string, url: string) => url);
    const panel = mountServerAddressPanel({
      host: makeEl('div') as never,
      document: makeDoc(),
      listProfiles: async () => [profile(keypair)],
      deps: {
        tokenStore: { unwrap: async () => 'b', wrap: async () => ({}) } as never,
        retarget,
        fetch: ((_u: unknown, init?: RequestInit) => new Promise<Response>((resolve) => {
          const body = JSON.parse(String(init?.body)) as { nonce: string };
          release = () => resolve(new Response(JSON.stringify({
            signature: ed25519Sign(keypair, buildIdentityProbePayload({
              nonce: body.nonce, server_public_key: keypair.public_key_b64,
            })),
          }), { status: 200 }));
          reached();
        })) as unknown as typeof globalThis.fetch,
      },
    });
    await panel.refresh();
    panel.clickEdit('p1');
    panel.typeAddress('p1', NEW);
    const checking = panel.clickCheck('p1');
    await reachedFetch;
    expect(panel.rowState('p1')).toBe('checking');

    // The user gives up while the probe is still out.
    panel.clickCancel('p1');
    expect(panel.rowState('p1')).toBe('idle');

    release!(new Response());
    await checking;
    // ⛔ The late verdict must NOT arm Save on a row the user closed.
    expect(panel.rowState('p1')).toBe('idle');
    expect(retarget).not.toHaveBeenCalled();
  });

  it('⛔ Cancel cannot interrupt a save in flight', async () => {
    // beginEdit already refuses to wind back a saving row; Cancel is the other
    // door to the same state, and its guard had no test.
    const keypair = realKeypair();
    let release: (() => void) | null = null;
    let reached: () => void = () => {};
    const reachedWrite = new Promise<void>((r) => { reached = r; });
    const panel = mountServerAddressPanel({
      host: makeEl('div') as never,
      document: makeDoc(),
      listProfiles: async () => [profile(keypair)],
      deps: {
        tokenStore: { unwrap: async () => 'b', wrap: async () => ({}) } as never,
        retarget: (_id: string, url: string) =>
          new Promise<string>((resolve) => { release = () => resolve(url); reached(); }),
        fetch: signingServer(keypair),
      },
    });
    await panel.refresh();
    panel.clickEdit('p1');
    panel.typeAddress('p1', NEW);
    await panel.clickCheck('p1');
    const saving = panel.clickSave('p1');
    await reachedWrite;

    panel.clickCancel('p1');
    expect(panel.rowState('p1')).toBe('saving');

    release!();
    await saving;
    expect(panel.rowState('p1')).toBe('saved');
  });

  it('every outcome has its own message', () => {
    const seen = new Set([
      retargetMessage({ kind: 'saved', server_url: NEW }),
      retargetMessage({ kind: 'invalid_address' }),
      retargetMessage({ kind: 'rejected_by_store' }),
      retargetMessage({ kind: 'token_reseal_failed', reason: 'x' }),
      retargetMessage({ kind: 'refused', probe: { kind: 'unreachable' } }),
      retargetMessage({ kind: 'refused', probe: { kind: 'not_the_same_server' } }),
    ]);
    expect(seen.size).toBe(6);
  });

  it('⛔ Checking never touches the bearer', async () => {
    // Found in review: Check used to run the whole retarget with a no-op write,
    // so every "just checking" click unwrapped and re-wrapped the user's
    // credential to compute a result it threw away — and could fail for a
    // reason having nothing to do with the address.
    const keypair = realKeypair();
    const unwrap = vi.fn(async () => 'bearer');
    const wrap = vi.fn(async () => ({ token_id: 't', ciphertext_b64: 'c', iv_b64: 'i', issued_at: 1 }));
    const host = makeEl('div');
    const panel = mountServerAddressPanel({
      host: host as never,
      document: makeDoc(),
      listProfiles: async () => [{
        ...profile(keypair),
        webclient_token: { token_id: 't', ciphertext_b64: 'c0', iv_b64: 'i0', issued_at: 0 },
      }],
      deps: {
        tokenStore: { unwrap, wrap } as never,
        retarget: async (_id: string, url: string) => url,
        fetch: signingServer(keypair),
      },
    });
    await panel.refresh();
    panel.clickEdit('p1');
    panel.typeAddress('p1', NEW);
    await panel.clickCheck('p1');

    expect(panel.rowState('p1')).toBe('verified');
    expect(unwrap).not.toHaveBeenCalled();
    expect(wrap).not.toHaveBeenCalled();

    // …and Saving still does, because that is when it is actually needed.
    await panel.clickSave('p1');
    expect(unwrap).toHaveBeenCalledTimes(1);
    expect(wrap).toHaveBeenCalledTimes(1);
  });

  it('⛔ refuses a duplicate address at CHECK, not after promising a Save', async () => {
    // Found in review: Check said "proved it is this server, Save to use it",
    // then Save answered "another server already uses that address".
    const keypair = realKeypair();
    const host = makeEl('div');
    const retarget = vi.fn(async (_id: string, url: string) => url);
    const fetchSpy = vi.fn(signingServer(keypair) as never);
    const panel = mountServerAddressPanel({
      host: host as never,
      document: makeDoc(),
      listProfiles: async () => [
        profile(keypair),
        { ...profile(keypair), id: 'p2', label: 'Other', server_url: 'wss://taken.example:8443/ws' },
      ],
      deps: { tokenStore: { unwrap: async () => 'b', wrap: async () => ({}) } as never, retarget, fetch: fetchSpy as never },
    });
    await panel.refresh();
    panel.clickEdit('p1');
    panel.typeAddress('p1', 'wss://taken.example:8443/ws');
    await panel.clickCheck('p1');

    expect(panel.rowState('p1')).toBe('refused');
    expect(panel.statusText('p1')).toContain('already uses that address');
    expect(retarget).not.toHaveBeenCalled();
    // ⚠ And it never contacted the address — a clash is answerable locally.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('⚠ two proxy mounts on ONE host+port are NOT duplicates', async () => {
    // Behind nginx/Caddy, `https://example.com/recued-a/` and `/recued-b/` are
    // different servers sharing a host and a port. Comparing listeners would
    // refuse a legitimate second server.
    const keypair = realKeypair();
    const host = makeEl('div');
    const retarget = vi.fn(async (_id: string, url: string) => url);
    const panel = mountServerAddressPanel({
      host: host as never,
      document: makeDoc(),
      listProfiles: async () => [
        { ...profile(keypair), id: 'p1', server_url: 'wss://example.com/recued-a/ws' },
        { ...profile(keypair), id: 'p2', label: 'B', server_url: 'wss://example.com/recued-b/ws' },
      ],
      deps: {
        tokenStore: { unwrap: async () => 'b', wrap: async () => ({}) } as never,
        retarget,
        fetch: signingServer(keypair),
      },
    });
    await panel.refresh();
    panel.clickEdit('p1');
    panel.typeAddress('p1', 'wss://example.com/recued-c/ws');
    await panel.clickCheck('p1');
    expect(panel.rowState('p1')).toBe('verified');
  });

  it('⚠ but the SAME mount on one host+port still is', async () => {
    const keypair = realKeypair();
    const host = makeEl('div');
    const panel = mountServerAddressPanel({
      host: host as never,
      document: makeDoc(),
      listProfiles: async () => [
        { ...profile(keypair), id: 'p1', server_url: 'wss://example.com/recued-a/ws' },
        { ...profile(keypair), id: 'p2', label: 'B', server_url: 'wss://example.com/recued-b/ws' },
      ],
      deps: {
        tokenStore: { unwrap: async () => 'b', wrap: async () => ({}) } as never,
        retarget: async (_id: string, url: string) => url,
        fetch: signingServer(keypair),
      },
    });
    await panel.refresh();
    panel.clickEdit('p1');
    panel.typeAddress('p1', 'wss://example.com/recued-b/ws');
    await panel.clickCheck('p1');
    expect(panel.rowState('p1')).toBe('refused');
    expect(panel.statusText('p1')).toContain('already uses that address');
  });

  it('⚠ the implicit-port form of a duplicate is still a duplicate', () => {
    // `wss://h/ws` and `wss://h:443/ws` are one listener; comparing raw strings
    // would let the clash through to the write.
    expect(serverMountIdentity('wss://taken.example/ws')).toBe(
      serverMountIdentity('wss://taken.example:443/ws'),
    );
  });

  it('opening another editor does not wind back a row that is mid-save', async () => {
    const keypair = realKeypair();
    const host = makeEl('div');
    let release: (() => void) | null = null;
    // ⚠ Signal when the WRITE is actually in flight. The row is already
    // 'saving' during the probe, so releasing before then would deadlock the
    // test on a retarget that had not been reached.
    let reached: () => void = () => {};
    const reachedWrite = new Promise<void>((r) => { reached = r; });
    const panel = mountServerAddressPanel({
      host: host as never,
      document: makeDoc(),
      listProfiles: async () => [profile(keypair), { ...profile(keypair), id: 'p2', label: 'Other', server_url: 'wss://other.example/ws' }],
      deps: {
        tokenStore: { unwrap: async () => 'b', wrap: async () => ({}) } as never,
        retarget: (_id: string, url: string) =>
          new Promise<string>((resolve) => { release = () => resolve(url); reached(); }),
        fetch: signingServer(keypair),
      },
    });
    await panel.refresh();
    panel.clickEdit('p1');
    panel.typeAddress('p1', NEW);
    await panel.clickCheck('p1');
    const saving = panel.clickSave('p1');
    await reachedWrite;
    expect(panel.rowState('p1')).toBe('saving');

    // Cancel already refuses mid-save; opening another editor must too.
    panel.clickEdit('p2');
    expect(panel.rowState('p1')).toBe('saving');

    release!();
    await saving;
    expect(panel.rowState('p1')).toBe('saved');
  });

  it('dispose removes the panel from its host', async () => {
    const { panel, host } = mount();
    await panel.refresh();
    expect(host.children).toHaveLength(1);
    panel.dispose();
    expect(host.children).toHaveLength(0);
  });
});
