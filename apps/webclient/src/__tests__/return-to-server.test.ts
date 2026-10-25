/** "Back to <server>" / "Use <server> instead" acceptance.
 *
 *  The control that makes "Add another server…" safe to offer at all, and the
 *  way off "Reconnect this browser". Both leave the shell for the pair form;
 *  without a way out, an owner with other working servers is stranded on a
 *  pairing screen with no route to them — the same dead end this feature set
 *  exists to remove, one step further along.
 */

import { describe, expect, it, vi } from 'vitest';

import type { WebclientServerProfile } from '@recued/contracts';
import {
  RETURN_TO_SERVER_ATTR,
  RETURN_TO_SERVER_BAR_ATTR,
  RETURN_TO_SERVER_CANCEL_ATTR,
  RETURN_TO_SERVER_COMMIT_ATTR,
  RETURN_TO_SERVER_COPY_ATTR,
  RETURN_TO_SERVER_DRAFT_ATTR,
  RETURN_TO_SERVER_REVIEW_ATTR,
  RETURN_TO_SERVER_STATUS_ATTR,
  mountReturnToServer,
  type MountReturnToServerOptions,
} from '../shell/return-to-server.js';

interface FakeEvent {
  type: string;
  target: FakeEl | null;
  key?: string;
  preventDefault(): void;
}
type FakeListener = (event: FakeEvent) => void;

interface FakeEl {
  tagName: string;
  textContent: string;
  className: string;
  disabled: boolean;
  hidden: boolean;
  value: string;
  selection: [number, number] | null;
  children: FakeEl[];
  parent: FakeEl | null;
  attrs: Map<string, string>;
  listeners: Map<string, Set<FakeListener>>;
  firstChild: FakeEl | null;
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(c: FakeEl): FakeEl;
  insertBefore(c: FakeEl, ref: FakeEl | null): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  addEventListener(type: string, listener: FakeListener): void;
  click(): void;
  keydown(key: string): boolean;
  focus(): void;
  setSelectionRange(start: number, end: number): void;
  contains(node: FakeEl): boolean;
}

const buildFakeDocument = () => {
  let active: FakeEl | null = null;

  const makeEl = (tagName: string): FakeEl => {
    const dispatch = (type: string, key?: string): boolean => {
      let prevented = false;
      for (const l of [...(el.listeners.get(type) ?? [])]) {
        l({
          type,
          target: el,
          ...(key !== undefined ? { key } : {}),
          preventDefault() { prevented = true; },
        });
      }
      return prevented;
    };
    const el: FakeEl = {
      tagName: tagName.toUpperCase(),
      textContent: '',
      className: '',
      disabled: false,
      hidden: false,
      value: '',
      selection: null,
      children: [],
      parent: null,
      attrs: new Map(),
      listeners: new Map(),
      get firstChild() { return el.children[0] ?? null; },
      setAttribute(k, v) { el.attrs.set(k, v); },
      removeAttribute(k) { el.attrs.delete(k); },
      getAttribute(k) { return el.attrs.get(k) ?? null; },
      hasAttribute(k) { return el.attrs.has(k); },
      appendChild(c) { el.children.push(c); c.parent = el; return c; },
      insertBefore(c, ref) {
        const i = ref === null ? -1 : el.children.indexOf(ref);
        if (i < 0) el.children.push(c);
        else el.children.splice(i, 0, c);
        c.parent = el;
        return c;
      },
      removeChild(c) {
        const i = el.children.indexOf(c);
        if (i < 0) throw new Error('removeChild: not a child');
        el.children.splice(i, 1);
        c.parent = null;
        return c;
      },
      addEventListener(type, listener) {
        const set = el.listeners.get(type) ?? new Set<FakeListener>();
        set.add(listener);
        el.listeners.set(type, set);
      },
      // A real browser never delivers a click to a disabled button.
      click() { if (!el.disabled) dispatch('click'); },
      keydown(key) { return dispatch('keydown', key); },
      focus() { active = el; },
      setSelectionRange(start, end) { el.selection = [start, end]; },
      contains(node) {
        if (node === el) return true;
        return el.children.some((c) => c.contains(node));
      },
    };
    return el;
  };

  return {
    document: { createElement: makeEl } as unknown as Document,
    activeElement: () => active,
    create: makeEl,
  };
};

const findByAttr = (root: FakeEl, attr: string): FakeEl | null => {
  if (root.hasAttribute(attr)) return root;
  for (const child of root.children) {
    const hit = findByAttr(child, attr);
    if (hit !== null) return hit;
  }
  return null;
};

const SIGN_IN = {
  token_id: 'tok',
  ciphertext_b64: 'ciphertext',
  iv_b64: 'iv',
  issued_at: 1,
};

const profile = (
  over: Partial<WebclientServerProfile> & Pick<WebclientServerProfile, 'id'>,
): WebclientServerProfile => ({
  label: 'home.example:8443',
  server_url: 'wss://home.example:8443/ws',
  webclient_token: SIGN_IN,
  server_public_key: null,
  pair_metadata: null,
  cert_pin_state: null,
  last_connected_at: null,
  ...over,
});

const HOME = profile({ id: 'p1', last_connected_at: 1_000 });
const OFFICE = profile({
  id: 'p2',
  label: 'office.example:8443',
  server_url: 'wss://office.example:8443/ws',
  last_connected_at: 5_000,
});
const PENDING = profile({
  id: 'p3',
  server_url: '',
  label: '',
  webclient_token: null,
});

/** The boot splash as the pair fallback hands it over: the brand, then the
 *  slot the pair form owns and redraws wholesale. */
const setup = (
  profiles: ReadonlyArray<WebclientServerProfile>,
  activeId: string | null = PENDING.id,
  extra: Partial<MountReturnToServerOptions> = {},
) => {
  const dom = buildFakeDocument();
  const host = dom.create('div');
  const brand = host.appendChild(dom.create('div'));
  const formSlot = host.appendChild(dom.create('div'));
  const onReturn = vi.fn<(id: string) => void | Promise<void>>();
  const mount = mountReturnToServer({
    host: host as unknown as HTMLElement,
    document: dom.document,
    profiles,
    activeId,
    onReturn,
    ...extra,
  });
  const button = (): FakeEl | null => findByAttr(host, RETURN_TO_SERVER_ATTR);
  const part = (attr: string): FakeEl | null => findByAttr(host, attr);
  return { dom, host, brand, formSlot, mount, onReturn, button, part };
};

/** Rejections and copy results settle on later microtasks. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe('mountReturnToServer', () => {
  it('offers the most recently connected server, not the first in the roster', () => {
    // The roster is insertion-ordered; the server you were last on is the one
    // you meant to go back to.
    const { button } = setup([HOME, OFFICE, PENDING]);
    expect(button()).not.toBeNull();
    expect(button()!.textContent).toBe('← Back to office.example:8443');
    // Named by what it says. ⛔ "Cancel adding a server and return to …"
    // hid the words on the button from voice control and screen readers.
    expect(button()!.getAttribute('aria-label')).toBeNull();
  });

  it('ignores corrupt recency when choosing the return destination', () => {
    const corruptHome = { ...HOME, last_connected_at: Number.POSITIVE_INFINITY };
    const { button } = setup([corruptHome, OFFICE, PENDING]);

    expect(button()?.textContent).toBe('← Back to office.example:8443');
  });

  it('sits first in the splash, above the brand and outside the form slot', () => {
    // ⛔ The pair form redraws by replacing its slot's whole innerHTML, so a
    // control inside that slot vanished on the first redraw — and appended
    // below a 24-word form it was under the fold before that.
    const { host, brand, formSlot, button } = setup([HOME, OFFICE, PENDING]);
    const bar = host.children[0]!;
    expect(bar.hasAttribute(RETURN_TO_SERVER_BAR_ATTR)).toBe(true);
    expect(findByAttr(bar, RETURN_TO_SERVER_ATTR)).not.toBeNull();
    expect(host.children.slice(1)).toEqual([brand, formSlot]);
    expect(formSlot.contains(button()!)).toBe(false);
  });

  it('returns the chosen id', () => {
    const { button, onReturn } = setup([HOME, OFFICE, PENDING]);
    button()!.click();
    expect(onReturn).toHaveBeenCalledWith('p2');
  });

  it('holds the button while going back, so a second click cannot race the first', () => {
    // The caller waits out any pairing in flight before switching, which can
    // take a moment; the owner sees that it is happening.
    const { button, onReturn } = setup([HOME, OFFICE, PENDING]);
    onReturn.mockReturnValue(new Promise<void>(() => undefined));
    button()!.click();
    button()!.click();
    expect(onReturn).toHaveBeenCalledTimes(1);
    expect(button()!.disabled).toBe(true);
    expect(button()!.textContent).toBe('Going back to office.example:8443…');
  });

  it('gives the button back when going back fails, so the owner can retry', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { button, part, onReturn } = setup([HOME, OFFICE, PENDING]);
      onReturn
        .mockRejectedValueOnce(new Error('roster write failed'))
        .mockResolvedValueOnce(undefined);
      button()!.click();
      await vi.waitFor(() => expect(button()!.disabled).toBe(false));
      expect(button()!.textContent).toBe('← Back to office.example:8443');
      expect(part(RETURN_TO_SERVER_STATUS_ATTR)!.textContent)
        .toBe('Couldn’t go back to office.example:8443. Try again.');
      expect(error).toHaveBeenCalledWith(
        'webclient: return to server failed',
        expect.any(Error),
      );
      button()!.click();
      expect(onReturn).toHaveBeenCalledTimes(2);
    } finally {
      error.mockRestore();
    }
  });

  it('renders NOTHING when the only record is the attempt in progress', () => {
    // A first pairing: "back" has no meaning, and a button that cannot work
    // is worse than no button.
    const { mount, button } = setup([PENDING]);
    expect(mount.rendered()).toBe(false);
    expect(button()).toBeNull();
  });

  it('renders nothing for an empty roster', () => {
    const { mount, button } = setup([], null);
    expect(mount.rendered()).toBe(false);
    expect(button()).toBeNull();
  });

  it('never offers a pending record as the destination', () => {
    const { button, onReturn } = setup([PENDING, HOME]);
    button()!.click();
    expect(onReturn).toHaveBeenCalledWith('p1');
  });

  it('never offers the active server — reconnecting it is not a way out', () => {
    // The active server is usually the most recently connected one, so a
    // destination chosen by recency alone named the very server being
    // reconnected, and the reload landed on the same form.
    const { button, onReturn } = setup([OFFICE, HOME], OFFICE.id);
    expect(button()!.textContent).toBe('Use home.example:8443 instead');
    button()!.click();
    expect(onReturn).toHaveBeenCalledWith('p1');
  });

  it('offers only servers this browser still has a sign-in for', () => {
    // A record without one leads only to another pair form.
    const signedOut = { ...OFFICE, webclient_token: null };
    const { button } = setup([HOME, signedOut, PENDING]);
    expect(button()!.textContent).toBe('← Back to home.example:8443');

    const { mount } = setup([signedOut, PENDING]);
    expect(mount.rendered()).toBe(false);
  });

  it('still offers the way back when the active pointer names nothing', () => {
    // A dangling pointer reads as unpaired, so the boot lands on the pair form
    // with working servers in the roster; going back heals it.
    const { button, onReturn } = setup([HOME, OFFICE], 'gone');
    button()!.click();
    expect(onReturn).toHaveBeenCalledWith('p2');
  });

  it('dispose removes the control and is idempotent', () => {
    const { host, brand, formSlot, mount, button } = setup([HOME, OFFICE, PENDING]);
    mount.dispose();
    mount.dispose();
    expect(button()).toBeNull();
    expect(findByAttr(host, RETURN_TO_SERVER_BAR_ATTR)).toBeNull();
    expect(host.children).toEqual([brand, formSlot]);
  });

  describe('on "Reconnect this browser"', () => {
    // The rejected server's record was swapped for a pending one, so the
    // roster alone reads exactly like an add; the caller says which it is.
    const reconnect = (
      extra: Partial<MountReturnToServerOptions> = {},
    ) => setup([HOME, OFFICE, PENDING], PENDING.id, {
      reconnecting: true,
      ...extra,
    });

    it('offers another server by name, not a "back" to an add that never happened', () => {
      const { button } = reconnect();
      expect(button()!.textContent).toBe('Use office.example:8443 instead');
      expect(button()!.hasAttribute('aria-label')).toBe(false);
    });

    it('switches straight away when no unsent message is held', () => {
      const { button, onReturn } = reconnect();
      onReturn.mockReturnValue(new Promise<void>(() => undefined));
      button()!.click();
      expect(onReturn).toHaveBeenCalledWith('p2');
      expect(button()!.disabled).toBe(true);
      expect(button()!.textContent).toBe('Switching to office.example:8443…');
    });

    it('reviews an unsent message before switching, in the Account switch’s words', () => {
      const { dom, button, part, onReturn } = reconnect({
        unsentChat: { text: 'Can we move Thursday to 3pm?' },
      });
      button()!.click();

      expect(onReturn).not.toHaveBeenCalled();
      const review = part(RETURN_TO_SERVER_REVIEW_ATTR)!;
      expect(review.getAttribute('role')).toBe('group');
      expect(dom.activeElement()).toBe(review);
      expect(button()!.hidden).toBe(true);
      expect(review.children.map((c) => c.textContent).slice(0, 2)).toEqual([
        'Switch to office.example:8443?',
        'The Chat message you have not sent is only in this tab. Switching loses it. It will never be sent to, or saved on, office.example:8443.',
      ]);
      const draft = part(RETURN_TO_SERVER_DRAFT_ATTR)!;
      expect(draft.value).toBe('Can we move Thursday to 3pm?');
      expect(draft.hasAttribute('readonly')).toBe(true);

      part(RETURN_TO_SERVER_COMMIT_ATTR)!.click();
      expect(onReturn).toHaveBeenCalledWith('p2');
      expect(part(RETURN_TO_SERVER_COMMIT_ATTR)!.textContent).toBe('Switching…');
    });

    it('Cancel and Escape keep the message and go back to the button', () => {
      const { dom, button, part, onReturn } = reconnect({
        unsentChat: { text: 'draft' },
      });
      button()!.click();
      part(RETURN_TO_SERVER_CANCEL_ATTR)!.click();
      expect(part(RETURN_TO_SERVER_REVIEW_ATTR)).toBeNull();
      expect(button()!.hidden).toBe(false);
      expect(dom.activeElement()).toBe(button());

      button()!.click();
      expect(part(RETURN_TO_SERVER_REVIEW_ATTR)!.keydown('Escape')).toBe(true);
      expect(part(RETURN_TO_SERVER_REVIEW_ATTR)).toBeNull();
      expect(dom.activeElement()).toBe(button());
      expect(onReturn).not.toHaveBeenCalled();
    });

    it('gives every control back when the switch fails, and says the message is still here', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const { button, part, onReturn } = reconnect({
          unsentChat: { text: 'draft' },
        });
        onReturn.mockRejectedValueOnce(new Error('switch failed'));
        button()!.click();
        part(RETURN_TO_SERVER_COMMIT_ATTR)!.click();
        expect(part(RETURN_TO_SERVER_CANCEL_ATTR)!.disabled).toBe(true);
        await vi.waitFor(() => {
          expect(part(RETURN_TO_SERVER_COMMIT_ATTR)!.disabled).toBe(false);
        });
        expect(part(RETURN_TO_SERVER_COMMIT_ATTR)!.textContent).toBe('Switch server');
        expect(part(RETURN_TO_SERVER_CANCEL_ATTR)!.disabled).toBe(false);
        expect(part(RETURN_TO_SERVER_COPY_ATTR)!.disabled).toBe(false);
        expect(part(RETURN_TO_SERVER_STATUS_ATTR)!.textContent).toBe(
          'Couldn’t switch servers. Your message is still here; try again.',
        );
      } finally {
        error.mockRestore();
      }
    });

    it('copies the message, and selects it for a manual copy when the clipboard refuses', async () => {
      const writeClipboard = vi.fn<(text: string) => Promise<void>>()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('denied'));
      const { dom, button, part } = reconnect({
        unsentChat: { text: 'Can we move Thursday to 3pm?' },
        writeClipboard,
      });
      button()!.click();
      const status = part(RETURN_TO_SERVER_STATUS_ATTR)!;

      part(RETURN_TO_SERVER_COPY_ATTR)!.click();
      expect(writeClipboard).toHaveBeenCalledWith('Can we move Thursday to 3pm?');
      await settle();
      expect(status.textContent).toBe('Copied. It is still not saved on office.example:8443.');

      part(RETURN_TO_SERVER_COPY_ATTR)!.click();
      await settle();
      const draft = part(RETURN_TO_SERVER_DRAFT_ATTR)!;
      expect(dom.activeElement()).toBe(draft);
      expect(draft.selection).toEqual([0, draft.value.length]);
      expect(status.textContent).toBe(
        'Recued could not copy it. The message is selected, so you can copy it yourself.',
      );
    });

    it('still warns when the message has no text to copy', () => {
      // A reply or an attachment alone is still lost by switching.
      const { button, part } = reconnect({ unsentChat: { text: '' } });
      button()!.click();
      expect(part(RETURN_TO_SERVER_REVIEW_ATTR)).not.toBeNull();
      expect(part(RETURN_TO_SERVER_DRAFT_ATTR)).toBeNull();
      expect(part(RETURN_TO_SERVER_COPY_ATTR)).toBeNull();
      expect(part(RETURN_TO_SERVER_COMMIT_ATTR)).not.toBeNull();
    });
  });
});
