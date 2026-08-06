/** D-212 §7.10 — keyfile posture on the webclient's Key Health page.
 *
 *  §7.10 replaced the retracted §7.9 refusal with a floor: an operator may
 *  run unsealed, and what makes that acceptable is that the posture stays
 *  legible on a surface they actually look at. The CLI + bridge already
 *  render it; this is the webclient's half, so these tests are the fence
 *  around the property that makes the permission safe.
 *
 *  Two things are load-bearing and both are asserted in BOTH directions:
 *
 *   1. ⛔⛔ `'none'` (known UNSEALED) and `null` (nothing reported) must
 *      never render the same. Same width on screen, opposite meaning. It is
 *      asserted on the projection AND on the DOM, and each is checked for
 *      the ABSENCE of the other's treatment — a test that only checks
 *      `'none'` renders a warning would stay green if `null` grew one too.
 *   2. The posture read is NOT part of the page's load contract: a failed
 *      `system.status` shows on the card, never as a failed page, and a
 *      failed `key.health` is not rescued by a healthy posture. */

import { describe, expect, it } from 'vitest';

import {
  KEY_HEALTH_CARD_ATTR,
  KEY_HEALTH_PANEL_ATTR,
  KEY_HEALTH_PANEL_STATE_ATTR,
  KEYFILE_POSTURE_CARD_ATTR,
  KEYFILE_POSTURE_CONSEQUENCE_ATTR,
  KEYFILE_POSTURE_REMEDIATION_ATTR,
  KEYFILE_POSTURE_TONE_ATTR,
  mountKeyHealthPanel,
  type KeyHealthLoader,
  type KeyRotateCaller,
  type SystemStatusLoader,
} from '../settings/key-health-panel.js';
import {
  describeKeyfilePosture,
  type KeyfileSealing,
} from '../settings/keyfile-posture.js';
import type {
  KeyHealthView,
  RotationResult,
  ServerSystemStatus,
} from '@recued/contracts';

// ──────────────────────────────────────────────────────────────────
// Fake DOM (same shape as the Key Health panel test beside it)
// ──────────────────────────────────────────────────────────────────

interface FakeElement {
  tagName: string;
  textContent: string;
  disabled: boolean;
  className: string;
  type: string;
  children: FakeElement[];
  parent: FakeElement | null;
  attrs: Map<string, string>;
  listeners: Map<string, Array<(ev: unknown) => void>>;
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(el: FakeElement): FakeElement;
  removeChild(el: FakeElement): FakeElement;
  readonly firstChild: FakeElement | null;
  remove(): void;
  addEventListener(name: string, fn: (ev: unknown) => void): void;
  removeEventListener(name: string, fn: (ev: unknown) => void): void;
  click(): void;
}

const makeFakeElement = (tagName: string): FakeElement => {
  const listeners = new Map<string, Array<(ev: unknown) => void>>();
  const attrs = new Map<string, string>();
  const children: FakeElement[] = [];
  const el: FakeElement = {
    tagName: tagName.toUpperCase(),
    textContent: '',
    disabled: false,
    className: '',
    type: '',
    children,
    parent: null,
    attrs,
    listeners,
    setAttribute: (k, v) => attrs.set(k, v),
    removeAttribute: (k) => attrs.delete(k),
    getAttribute: (k) => attrs.get(k) ?? null,
    hasAttribute: (k) => attrs.has(k),
    appendChild: (next) => {
      children.push(next);
      next.parent = el;
      return next;
    },
    removeChild: (target) => {
      const idx = children.indexOf(target);
      if (idx < 0) throw new Error('removeChild: not a child');
      children.splice(idx, 1);
      target.parent = null;
      return target;
    },
    get firstChild() {
      return children[0] ?? null;
    },
    remove: () => {
      if (el.parent) el.parent.removeChild(el);
    },
    addEventListener: (name, fn) => {
      const arr = listeners.get(name) ?? [];
      arr.push(fn);
      listeners.set(name, arr);
    },
    removeEventListener: (name, fn) => {
      const arr = listeners.get(name);
      if (!arr) return;
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    },
    click: () => {
      for (const fn of listeners.get('click') ?? []) fn({ target: el });
    },
  };
  return el;
};

const makeFakeDocument = () => ({ createElement: (tag: string) => makeFakeElement(tag) });

const findByAttr = (root: FakeElement, attr: string): FakeElement | null => {
  if (root.hasAttribute(attr)) return root;
  for (const c of root.children) {
    const hit = findByAttr(c, attr);
    if (hit) return hit;
  }
  return null;
};

const findAllByAttr = (root: FakeElement, attr: string): FakeElement[] => {
  const out: FakeElement[] = [];
  if (root.hasAttribute(attr)) out.push(root);
  for (const c of root.children) out.push(...findAllByAttr(c, attr));
  return out;
};

/** All text under a node, concatenated. The renderer puts each sentence on
 *  its own element, so a substring check has to walk. */
const textOf = (root: FakeElement): string =>
  [root.textContent, ...root.children.map(textOf)].join(' ');

// ──────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────

const selfHostView = (
  availabilityOverrides: Partial<KeyHealthView['availability']> = {},
): KeyHealthView => ({
  key_health: {
    master_dek: { status: 'healthy' },
    sub_dek: { status: 'healthy' },
    server_identity_key: { status: 'healthy' },
    publisher_identity_key: { status: 'healthy' },
    tls_private_key: { status: 'healthy' },
    webclient_token: { status: 'healthy' },
    webhook_secret: { status: 'healthy' },
  },
  availability: {
    master_dek: 'unavailable',
    sub_dek: 'unavailable',
    server_identity_key: 'available',
    publisher_identity_key: 'unavailable',
    tls_private_key: 'managed_elsewhere',
    webclient_token: 'managed_elsewhere',
    webhook_secret: 'unavailable',
    ...availabilityOverrides,
  },
});

/** Let queued microtasks + the panel's own async loads settle. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const statusWith = (keyfile_sealing: KeyfileSealing): ServerSystemStatus => ({
  name: 'test-server',
  version: '1.2.3',
  uptime_seconds: 42,
  paired_client_count: 1,
  paired_client_connected: 1,
  ws_state: 'serving',
  last_sync_at: null,
  executions_last_hour: null,
  executions_last_24h: null,
  pending_asks: null,
  schedule_queue_depth: null,
  recent_error_count: null,
  keyfile_sealing,
  snapshot_at: 1_800_000_000_000,
});

interface SetupOptions {
  loadHealth?: KeyHealthLoader;
  loadSystemStatus?: SystemStatusLoader | 'omit';
  sealing?: KeyfileSealing;
}

const setup = (overrides: SetupOptions = {}) => {
  const host = makeFakeElement('div');
  const doc = makeFakeDocument();
  const statusCalls = { count: 0 };
  const loadHealth: KeyHealthLoader = overrides.loadHealth ?? (async () => selfHostView());
  const runRotate: KeyRotateCaller = async () =>
    ({ ok: true, op: 'server_identity_rotate' }) as RotationResult;
  // ⚠ `'sealing' in overrides`, never `overrides.sealing ?? 'machine'` — the
  // posture under test IS `null` in one case, and `??` would silently swap it
  // for the sealed default. That fixture bug made the `null` test assert the
  // machine path while reading green.
  const sealing: KeyfileSealing =
    'sealing' in overrides ? (overrides.sealing as KeyfileSealing) : 'machine';
  const defaultStatus: SystemStatusLoader = async () => {
    statusCalls.count += 1;
    return statusWith(sealing);
  };
  const loadSystemStatus =
    overrides.loadSystemStatus === 'omit'
      ? undefined
      : (overrides.loadSystemStatus ?? defaultStatus);
  const mount = mountKeyHealthPanel({
    host: host as unknown as HTMLElement,
    document: doc as unknown as Document,
    loadHealth,
    runRotate,
    ...(loadSystemStatus !== undefined ? { loadSystemStatus } : {}),
  });
  return { host, mount, statusCalls };
};

const stateOf = (host: FakeElement): string | null =>
  findByAttr(host, KEY_HEALTH_PANEL_ATTR)?.getAttribute(KEY_HEALTH_PANEL_STATE_ATTR) ?? null;

const postureCard = (host: FakeElement): FakeElement | null =>
  findByAttr(host, KEYFILE_POSTURE_CARD_ATTR);

const toneOf = (host: FakeElement): string | null =>
  postureCard(host)?.getAttribute(KEYFILE_POSTURE_TONE_ATTR) ?? null;

// ══════════════════════════════════════════════════════════════════
// The projection
// ══════════════════════════════════════════════════════════════════

describe('D-212 §7.10 — describeKeyfilePosture', () => {
  it('reports both sealed postures with no consequence and no remediation', () => {
    for (const sealing of ['machine', 'passphrase'] as const) {
      const view = describeKeyfilePosture({ kind: 'value', sealing });
      expect(view.tone).toBe('sealed');
      expect(view.consequence).toBeNull();
      expect(view.remediation).toBeNull();
      // The two sealed postures are not interchangeable: which factor holds
      // the secret is exactly what an operator is checking.
      expect(view.status).toContain(sealing === 'machine' ? 'machine' : 'passphrase');
    }
  });

  it('reports `none` as a warned, consequential posture', () => {
    const view = describeKeyfilePosture({ kind: 'value', sealing: 'none' });
    expect(view.tone).toBe('unsealed');
    expect(view.status).toContain('UNSEALED');
    expect(view.consequence).not.toBeNull();
    expect(view.consequence).toMatch(/data directory/i);
    expect(view.consequence).toMatch(/only copies that omit the keyfile/i);
    expect(view.consequence).toMatch(/database-only backup/i);
    expect(view.remediation).not.toBeNull();
  });

  it('states the FULL price of resealing, not just the commands', () => {
    // The CLI + bridge one-liners have no room for the cost and say only
    // "set the passphrase and run recover-keyfile", which reads far cheaper
    // than it is: regeneration mints a new server identity. This page has
    // the room, so every part §7.11 says to name is pinned here — a later
    // "tidy" that shortens this back to the one-liner reds.
    const { remediation } = describeKeyfilePosture({ kind: 'value', sealing: 'none' });
    expect(remediation).toContain('RECUED_IDENTITY_PASSPHRASE');
    expect(remediation).toContain('recover-keyfile');
    expect(remediation).toMatch(/24-word recovery key/i);
    expect(remediation).toMatch(/pair again/i);
    expect(remediation).toMatch(/publisher identity/i);
    expect(remediation).toMatch(/account binding/i);
    // …and that the data itself survives, or the warning reads like a
    // threat to the warehouse and nobody acts on it.
    expect(remediation).toMatch(/data is untouched/i);
  });

  it('⛔ keeps `none` and `null` apart on every field', () => {
    const none = describeKeyfilePosture({ kind: 'value', sealing: 'none' });
    const unreported = describeKeyfilePosture({ kind: 'value', sealing: null });
    expect(unreported.tone).toBe('unreported');
    expect(unreported.tone).not.toBe(none.tone);
    expect(unreported.status).not.toBe(none.status);
    expect(unreported.detail).not.toBe(none.detail);
    // The asymmetry that matters: only the KNOWN-bad posture carries a
    // consequence + a remediation. An unknown must not borrow either.
    expect(unreported.consequence).toBeNull();
    expect(unreported.remediation).toBeNull();
    // …and `null` must not be readable as reassurance.
    expect(unreported.status).not.toMatch(/sealed/i);
    expect(unreported.detail).toMatch(/not a sealed keyfile/i);
  });

  it('keeps a failed read distinct from a server that reported nothing', () => {
    const unreadable = describeKeyfilePosture({
      kind: 'unreadable',
      message: 'transport closed',
    });
    const unreported = describeKeyfilePosture({ kind: 'value', sealing: null });
    expect(unreadable.tone).toBe('unreadable');
    expect(unreadable.tone).not.toBe(unreported.tone);
    // Carries the reason (an operator can act on "transport closed"; they
    // cannot act on a blank) and refuses to be read as sealed.
    expect(unreadable.detail).toContain('transport closed');
    expect(unreadable.detail).toMatch(/not a report that the keyfile is sealed/i);
    expect(unreadable.consequence).toBeNull();
  });

  it('gives the four contract postures four distinct labels', () => {
    // Cheap ratchet against a future collapse: the whole control is that
    // these do not converge on screen.
    const labels = (['machine', 'passphrase', 'none', null] as const).map(
      (sealing) => describeKeyfilePosture({ kind: 'value', sealing }).status,
    );
    expect(new Set(labels).size).toBe(4);
  });
});

// ══════════════════════════════════════════════════════════════════
// The card, in the page
// ══════════════════════════════════════════════════════════════════

describe('D-212 §7.10 — the keyfile posture card on the Key Health page', () => {
  it('renders UNSEALED first, above the key inventory, with its consequence', async () => {
    const { host, mount } = setup({ sealing: 'none' });
    await mount.whenReady();

    expect(toneOf(host)).toBe('unsealed');
    expect(findByAttr(host, KEYFILE_POSTURE_CONSEQUENCE_ATTR)).not.toBeNull();
    expect(findByAttr(host, KEYFILE_POSTURE_REMEDIATION_ATTR)).not.toBeNull();
    expect(textOf(postureCard(host)!)).toContain('UNSEALED');

    // First in the list — a standing disclosure under seven rotation cards
    // is not standing. The posture card carries its OWN attribute and is
    // deliberately not one of the seven class cards.
    const list = postureCard(host)!.parent!;
    expect(list.children[0]!.hasAttribute(KEYFILE_POSTURE_CARD_ATTR)).toBe(true);
    expect(findAllByAttr(host, KEY_HEALTH_CARD_ATTR)).toHaveLength(7);
  });

  it('renders a sealed posture with no consequence and no remediation', async () => {
    const { host, mount } = setup({ sealing: 'passphrase' });
    await mount.whenReady();

    expect(toneOf(host)).toBe('sealed');
    expect(findByAttr(host, KEYFILE_POSTURE_CONSEQUENCE_ATTR)).toBeNull();
    expect(findByAttr(host, KEYFILE_POSTURE_REMEDIATION_ATTR)).toBeNull();
    expect(textOf(postureCard(host)!)).not.toContain('UNSEALED');
  });

  it('⛔ renders a null posture as unknown — never as unsealed, never as sealed', async () => {
    const { host, mount } = setup({ sealing: null });
    await mount.whenReady();

    expect(toneOf(host)).toBe('unreported');
    const text = textOf(postureCard(host)!);
    // Neither of the two things it is not.
    expect(text).not.toContain('UNSEALED');
    expect(findByAttr(host, KEYFILE_POSTURE_CONSEQUENCE_ATTR)).toBeNull();
    expect(text).toMatch(/not a sealed keyfile/i);
  });

  it('renders no card at all when the host wired no status reader', async () => {
    const { host, mount } = setup({ loadSystemStatus: 'omit' });
    await mount.whenReady();

    // Absent means absent — not a default, in either direction.
    expect(postureCard(host)).toBeNull();
    // …and the page it rides on is untouched.
    expect(stateOf(host)).toBe('idle');
    expect(findAllByAttr(host, KEY_HEALTH_CARD_ATTR)).toHaveLength(7);
  });

  it('shows a failed status read on the card, and keeps the page loaded', async () => {
    const { host, mount } = setup({
      loadSystemStatus: async () => {
        throw Object.assign(new Error('socket closed'), { code: 'transport' });
      },
    });
    await mount.whenReady();

    // The page did NOT fail: the key inventory is the reason a user opened
    // this page, and a posture outage must not take it down.
    expect(stateOf(host)).toBe('idle');
    expect(findAllByAttr(host, KEY_HEALTH_CARD_ATTR)).toHaveLength(7);
    expect(toneOf(host)).toBe('unreadable');
    expect(findByAttr(host, KEYFILE_POSTURE_CONSEQUENCE_ATTR)).toBeNull();
  });

  it('does not let a healthy posture rescue a failed key.health load', async () => {
    // The inverse of the above — the two reads fail independently.
    const { host, mount } = setup({
      loadHealth: async () => {
        throw new Error('key.health exploded');
      },
      sealing: 'machine',
    });
    await mount.whenReady();

    expect(stateOf(host)).toBe('load_error');
    // No posture card either: `load_error` renders the retry surface, not
    // a half page with one good card on it.
    expect(postureCard(host)).toBeNull();
  });

  it('re-reads the posture on every page reload', async () => {
    // Driven through the real Retry path: the page can only reload from
    // `load_error` (Retry) or after a rotation (Close), and both re-enter
    // the same load. A stale posture beside a freshly-loaded inventory is
    // exactly the "assurance-shaped non-assurance" §7.10 refuses.
    let healthCalls = 0;
    const { host, mount, statusCalls } = setup({
      loadHealth: async () => {
        healthCalls += 1;
        if (healthCalls === 1) throw new Error('key.health exploded');
        return selfHostView();
      },
      sealing: 'machine',
    });
    await mount.whenReady();
    expect(stateOf(host)).toBe('load_error');
    expect(statusCalls.count).toBe(1);

    await mount.clickRetry();

    expect(stateOf(host)).toBe('idle');
    expect(statusCalls.count).toBe(2);
    expect(toneOf(host)).toBe('sealed');
  });

  it('ignores a stale status answer that lands after a newer read', async () => {
    // A slow first read resolving UNSEALED after a second read already
    // answered `machine` must not repaint the card. Without the token this
    // shows the wrong posture indefinitely — and in the direction nobody
    // reports: a warning appearing on a sealed server gets questioned, a
    // sealed badge on an unsealed one does not.
    let releaseFirst: (() => void) | null = null;
    const firstParked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let call = 0;
    const { host, mount } = setup({
      // `master_dek` available ⇒ a NON-de-pairing rotation, whose `done`
      // state carries the Close button that re-enters `runLoad`.
      loadHealth: async () => selfHostView({ master_dek: 'available' }),
      loadSystemStatus: async () => {
        call += 1;
        if (call === 1) {
          await firstParked;
          return statusWith('none');
        }
        return statusWith('machine');
      },
    });

    // Reach `idle` WITHOUT awaiting whenReady() — that would wait on the
    // parked first posture, which is the whole point of the scenario.
    await flush();
    expect(stateOf(host)).toBe('idle');
    expect(postureCard(host)).toBeNull(); // still in flight — nothing claimed yet

    mount.clickRotate('master_dek');
    await mount.clickConfirm();
    await mount.clickClose(); // second load: posture #2 answers `machine`
    expect(call).toBe(2);
    expect(toneOf(host)).toBe('sealed');

    // Now the stale first answer lands.
    releaseFirst!();
    await flush();

    expect(toneOf(host)).toBe('sealed');
    expect(findByAttr(host, KEYFILE_POSTURE_CONSEQUENCE_ATTR)).toBeNull();
  });
});
