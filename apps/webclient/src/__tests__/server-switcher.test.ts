/** Server profile list acceptance.
 *
 *  Drives the createElement-only mount over a fake DOM. The cases that matter
 *  are the ones the feature exists for: it switches with NO server reachable
 *  (storage callbacks only, never rpc), forgetting presents explicit local
 *  versus server-revoke choices, and a profile with no address is never
 *  offered as a destination. The trigger, badge, and open/close belong to the
 *  account menu that embeds this — see `account-menu.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';

import type { WebclientServerProfile } from '@recued/contracts';
import {
  SERVER_SWITCHER_ATTR,
  SERVER_SWITCHER_ACTIVE_WORK_ITEM_ATTR,
  SERVER_SWITCHER_CURRENT_ATTR,
  SERVER_SWITCHER_EMPTY_ATTR,
  SERVER_SWITCHER_ITEM_ATTR,
  SERVER_SWITCHER_MENU_ATTR,
  SERVER_SWITCHER_RECENCY_ATTR,
  SERVER_SWITCHER_SWITCH_CANCEL_ATTR,
  SERVER_SWITCHER_SWITCH_COMMIT_ATTR,
  SERVER_SWITCHER_SWITCH_CONFIRM_ATTR,
  SERVER_SWITCHER_SWITCH_ERROR_ATTR,
  SERVER_SWITCHER_RETURN_TO_WORK_ATTR,
  SERVER_SWITCHER_RENAME_ATTR,
  SERVER_SWITCHER_RENAME_CANCEL_ATTR,
  SERVER_SWITCHER_RENAME_ERROR_ATTR,
  SERVER_SWITCHER_RENAME_FORM_ATTR,
  SERVER_SWITCHER_RENAME_INPUT_ATTR,
  SERVER_SWITCHER_RENAME_SAVE_ATTR,
  SERVER_SWITCHER_REMOVE_ATTR,
  SERVER_SWITCHER_REMOVE_CANCEL_ATTR,
  SERVER_SWITCHER_REMOVE_CONFIRM_ATTR,
  SERVER_SWITCHER_REMOVE_ERROR_ATTR,
  SERVER_SWITCHER_REMOVE_LOCAL_ATTR,
  SERVER_SWITCHER_REMOVE_REVOKE_ATTR,
  SERVER_SWITCHER_REMOVE_STATUS_ATTR,
  formatServerProfileRecency,
  mountProfileList,
  serverSwitchReviewCoversActiveWork,
  serverSwitchReviewCoversWorkState,
} from '../shell/server-switcher.js';

interface FakeEvent {
  type: string;
  target: FakeEl | null;
  key?: string;
}
type FakeListener = (event: FakeEvent) => void;

interface FakeEl {
  tagName: string;
  textContent: string;
  className: string;
  value: string;
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
  removeChild(c: FakeEl): FakeEl;
  addEventListener(type: string, listener: FakeListener): void;
  click(): void;
  input(value: string): void;
  focus(): void;
  contains(node: FakeEl): boolean;
}

const buildFakeDocument = () => {
  let active: FakeEl | null = null;
  const documentListeners = new Map<string, Set<FakeListener>>();

  const makeEl = (tagName: string): FakeEl => {
    const el: FakeEl = {
      tagName: tagName.toUpperCase(),
      textContent: '',
      className: '',
      value: '',
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
      click() {
        for (const l of [...(el.listeners.get('click') ?? [])]) {
          l({ type: 'click', target: el });
        }
      },
      input(value) {
        el.value = value;
        for (const l of [...(el.listeners.get('input') ?? [])]) {
          l({ type: 'input', target: el });
        }
      },
      focus() { active = el; },
      contains(node) {
        if (node === el) return true;
        return el.children.some((c) => c.contains(node));
      },
    };
    return el;
  };

  const doc = {
    createElement: makeEl,
    get activeElement() { return active; },
    addEventListener(type: string, listener: FakeListener) {
      const set = documentListeners.get(type) ?? new Set<FakeListener>();
      set.add(listener);
      documentListeners.set(type, set);
    },
    removeEventListener(type: string, listener: FakeListener) {
      documentListeners.get(type)?.delete(listener);
    },
  };

  return {
    document: doc as unknown as Document,
    activeElement: () => active,
    create: makeEl,
    fire(type: string, init?: { target?: FakeEl; key?: string }) {
      for (const l of [...(documentListeners.get(type) ?? [])]) {
        l({ type, target: init?.target ?? null, ...(init?.key !== undefined ? { key: init.key } : {}) });
      }
    },
    listenerCount: (type: string) => documentListeners.get(type)?.size ?? 0,
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

const findAllByAttr = (root: FakeEl, attr: string): FakeEl[] => {
  const out: FakeEl[] = [];
  const walk = (el: FakeEl): void => {
    if (el.hasAttribute(attr)) out.push(el);
    for (const c of el.children) walk(c);
  };
  walk(root);
  return out;
};

const subtreeText = (root: FakeEl): string =>
  [root.textContent, ...root.children.map(subtreeText)].join(' ');

const profile = (
  over: Partial<WebclientServerProfile> & Pick<WebclientServerProfile, 'id'>,
): WebclientServerProfile => ({
  label: 'home.example:8443',
  server_url: 'wss://home.example:8443/ws',
  webclient_token: null,
  server_public_key: null,
  pair_metadata: null,
  cert_pin_state: null,
  last_connected_at: null,
  ...over,
});

const HOME = profile({
  id: 'p1',
  pair_metadata: {
    paired_at: 1,
    server_passport_fingerprint: 'fp-home',
    server_handle_at_pair: 'home',
    instance_id: 'instance-home',
  },
});
const OFFICE = profile({
  id: 'p2',
  label: 'office.example:8443',
  server_url: 'wss://office.example:8443/ws',
});

const setup = (over: Partial<Parameters<typeof mountProfileList>[0]> = {}) => {
  const dom = buildFakeDocument();
  const host = dom.create('div');
  const onSwitch = vi.fn();
  const onSelectActive = vi.fn();
  const onRemove = vi.fn();
  const onRename = vi.fn();
  const mount = mountProfileList({
    host: host as unknown as HTMLElement,
    document: dom.document,
    profiles: [HOME, OFFICE],
    activeProfileId: 'p1',
    onSwitch,
    onSelectActive,
    onRemove,
    onRename,
    activeConnected: true,
    ...over,
  });
  return { dom, host, mount, onSwitch, onSelectActive, onRemove, onRename };
};

const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe('serverSwitchReviewCoversWorkState', () => {
  it('requires another review only when a new risk appears', () => {
    expect(serverSwitchReviewCoversWorkState('clean', 'in_flight')).toBe(false);
    expect(serverSwitchReviewCoversWorkState('in_flight', 'clean')).toBe(true);
    expect(serverSwitchReviewCoversWorkState(
      'in_flight',
      'in_flight_with_chat_draft',
    )).toBe(false);
    expect(serverSwitchReviewCoversWorkState(
      'in_flight_with_chat_draft',
      'chat_draft',
    )).toBe(true);
    expect(serverSwitchReviewCoversWorkState(
      'in_flight_with_unsaved_changes',
      'unsaved_changes',
    )).toBe(true);
    expect(serverSwitchReviewCoversWorkState(
      'chat_draft',
      'unsaved_changes',
    )).toBe(false);
  });
});

describe('serverSwitchReviewCoversActiveWork', () => {
  const first = { id: 'work-1', label: 'Creating a backup' };
  const second = { id: 'work-2', label: 'Sending a message' };

  it('allows reviewed work to settle but rejects a newly-started action', () => {
    expect(serverSwitchReviewCoversActiveWork([first, second], [second])).toBe(true);
    expect(serverSwitchReviewCoversActiveWork([first], [second])).toBe(false);
  });
});

describe('mountProfileList', () => {
  it('lists every server with the active one marked', () => {
    const { host } = setup();
    const items = findAllByAttr(host, SERVER_SWITCHER_ITEM_ATTR);
    expect(items).toHaveLength(2);
    expect(items[0]!.getAttribute('aria-current')).toBe('true');
    expect(items[1]!.getAttribute('aria-current')).toBe('false');
    expect(findAllByAttr(items[0]!, SERVER_SWITCHER_CURRENT_ATTR)).toHaveLength(1);
    expect(findAllByAttr(items[1]!, SERVER_SWITCHER_CURRENT_ATTR)).toHaveLength(0);
    expect(items[1]!.getAttribute('data-profile-id')).toBe('p2');
  });

  it('focuses an exact profile handoff without selecting or pre-confirming it', () => {
    const { dom, host, mount, onSwitch } = setup();

    expect(mount.focusProfile('p2')).toBe(true);
    expect(dom.activeElement()).toBe(
      findAllByAttr(host, SERVER_SWITCHER_ITEM_ATTR)[1],
    );
    expect(onSwitch).not.toHaveBeenCalled();
    expect(findAllByAttr(host, SERVER_SWITCHER_SWITCH_CONFIRM_ATTR))
      .toHaveLength(0);
    expect(mount.profileAvailability('p2')).toBe('available');
    expect(mount.focusProfile('missing-profile')).toBe(false);
    expect(mount.profileAvailability('missing-profile')).toBe('missing');
  });

  it('puts recently connected profiles first and explains recency without inventing status', () => {
    const now = 1_700_000_000_000;
    const older = profile({
      ...HOME,
      id: 'older',
      last_connected_at: now - (2 * 60 * 60 * 1_000),
    });
    const recent = profile({
      ...OFFICE,
      id: 'recent',
      last_connected_at: now - (5 * 60 * 1_000),
    });
    const fresh = profile({ ...HOME, id: 'fresh', last_connected_at: null });
    const { host } = setup({
      profiles: [older, fresh, recent],
      activeProfileId: 'older',
      activeConnected: false,
      now: () => now,
    });

    const items = findAllByAttr(host, SERVER_SWITCHER_ITEM_ATTR);
    expect(items.map((item) => item.getAttribute('data-profile-id')))
      .toEqual(['recent', 'older', 'fresh']);
    expect(findByAttr(items[0]!, SERVER_SWITCHER_RECENCY_ATTR)?.textContent)
      .toBe('Last connected 5 minutes ago');
    expect(findByAttr(items[1]!, SERVER_SWITCHER_RECENCY_ATTR)?.textContent)
      .toBe('Last connected 2 hours ago');
    expect(findByAttr(items[2]!, SERVER_SWITCHER_RECENCY_ATTR)?.textContent)
      .toBe('Not connected yet');
  });

  it('labels only the proved active connection as connected now', () => {
    const { host } = setup({ now: () => 1_700_000_000_000 });
    const items = findAllByAttr(host, SERVER_SWITCHER_ITEM_ATTR);
    expect(findByAttr(items[0]!, SERVER_SWITCHER_RECENCY_ATTR)?.textContent)
      .toBe('Connected now');
    expect(findByAttr(items[1]!, SERVER_SWITCHER_RECENCY_ATTR)?.textContent)
      .toBe('Not connected yet');
  });

  describe('recency copy', () => {
    it('handles future skew and invalid persisted values safely', () => {
      expect(formatServerProfileRecency(2_000, 1_000))
        .toBe('Last connected just now');
      expect(formatServerProfileRecency(Number.NaN, 1_000))
        .toBe('Not connected yet');
      expect(formatServerProfileRecency(-1, 1_000))
        .toBe('Not connected yet');
    });
  });

  describe('renaming a server', () => {
    it('opens an inline local form, trims the name, saves, and restores focus', async () => {
      const { dom, host, onRename } = setup();
      findAllByAttr(host, SERVER_SWITCHER_RENAME_ATTR)[0]!.click();

      expect(findByAttr(host, SERVER_SWITCHER_RENAME_FORM_ATTR)).not.toBeNull();
      const input = findByAttr(host, SERVER_SWITCHER_RENAME_INPUT_ATTR)!;
      expect(input.value).toBe(HOME.label);
      expect(dom.activeElement()).toBe(input);
      input.input('  Home workspace  ');
      findByAttr(host, SERVER_SWITCHER_RENAME_SAVE_ATTR)!.click();
      await flush();

      expect(onRename).toHaveBeenCalledWith('p1', 'Home workspace');
      expect(findByAttr(host, SERVER_SWITCHER_RENAME_FORM_ATTR)).toBeNull();
      const renameButton = findAllByAttr(host, SERVER_SWITCHER_RENAME_ATTR)[0]!;
      expect(renameButton.getAttribute('aria-label')).toBe('Rename Home workspace');
      expect(dom.activeElement()).toBe(renameButton);
    });

    it('keeps blank and failed saves in context with an actionable error', async () => {
      const onRename = vi.fn(async () => {
        throw new Error('Storage is unavailable.');
      });
      const { dom, host } = setup({ onRename });
      findAllByAttr(host, SERVER_SWITCHER_RENAME_ATTR)[0]!.click();
      const input = findByAttr(host, SERVER_SWITCHER_RENAME_INPUT_ATTR)!;
      input.input('   ');
      findByAttr(host, SERVER_SWITCHER_RENAME_SAVE_ATTR)!.click();
      expect(findByAttr(host, SERVER_SWITCHER_RENAME_ERROR_ATTR)?.textContent)
        .toContain('Enter a name');
      expect(onRename).not.toHaveBeenCalled();

      findByAttr(host, SERVER_SWITCHER_RENAME_INPUT_ATTR)!.input('Home');
      findByAttr(host, SERVER_SWITCHER_RENAME_SAVE_ATTR)!.click();
      await flush();
      expect(findByAttr(host, SERVER_SWITCHER_RENAME_ERROR_ATTR)?.textContent)
        .toContain('Storage is unavailable');
      expect(findByAttr(host, SERVER_SWITCHER_RENAME_FORM_ATTR)).not.toBeNull();
      expect(dom.activeElement()).toBe(
        findByAttr(host, SERVER_SWITCHER_RENAME_INPUT_ATTR),
      );
    });

    it('Cancel restores focus to Rename and read-only hosts omit the control', () => {
      const editable = setup();
      findAllByAttr(editable.host, SERVER_SWITCHER_RENAME_ATTR)[0]!.click();
      findByAttr(editable.host, SERVER_SWITCHER_RENAME_CANCEL_ATTR)!.click();
      expect(findByAttr(editable.host, SERVER_SWITCHER_RENAME_FORM_ATTR)).toBeNull();
      expect(editable.dom.activeElement()).toBe(
        findAllByAttr(editable.host, SERVER_SWITCHER_RENAME_ATTR)[0],
      );

      const readOnly = setup({ onRename: undefined });
      expect(findAllByAttr(readOnly.host, SERVER_SWITCHER_RENAME_ATTR)).toHaveLength(0);
    });
  });

  it('reviews the boundary before reporting a switch — no rpc required', async () => {
    // The reason this surface exists: every Server settings panel is rpc-
    // driven and unusable during an outage. This one only calls back.
    const { host, onSwitch } = setup();
    findAllByAttr(host, SERVER_SWITCHER_ITEM_ATTR)[1]!.click();

    expect(onSwitch).not.toHaveBeenCalled();
    expect(subtreeText(findByAttr(host, SERVER_SWITCHER_SWITCH_CONFIRM_ATTR)!))
      .toContain('Chats, records, runs and links belong to one server and stay there');
    findByAttr(host, SERVER_SWITCHER_SWITCH_COMMIT_ATTR)!.click();
    await flush();
    expect(onSwitch).toHaveBeenCalledWith('p2', 'clean');
    expect(findByAttr(host, SERVER_SWITCHER_SWITCH_CONFIRM_ATTR)).toBeNull();
  });

  it('warns about an unsent Chat draft and makes Cancel a no-op with focus recovery', () => {
    const { dom, host, onSwitch } = setup({
      switchWorkState: () => 'chat_draft',
    });
    findAllByAttr(host, SERVER_SWITCHER_ITEM_ATTR)[1]!.click();

    const confirm = findByAttr(host, SERVER_SWITCHER_SWITCH_CONFIRM_ATTR)!;
    expect(subtreeText(confirm)).toContain('The Chat message you have not sent is only in this tab');
    expect(subtreeText(confirm)).toContain('will never be sent to, or saved on, office.example:8443');
    findByAttr(host, SERVER_SWITCHER_SWITCH_CANCEL_ATTR)!.click();

    expect(onSwitch).not.toHaveBeenCalled();
    expect(findByAttr(host, SERVER_SWITCHER_SWITCH_CONFIRM_ATTR)).toBeNull();
    expect(dom.activeElement()).toBe(
      findAllByAttr(host, SERVER_SWITCHER_ITEM_ATTR)[1],
    );
  });

  it('treats unsettled source work as an unknown outcome, with a safe wait choice', () => {
    const { dom, host, onSwitch } = setup({
      switchWorkState: () => 'in_flight',
    });
    findAllByAttr(host, SERVER_SWITCHER_ITEM_ATTR)[1]!.click();

    const confirm = findByAttr(host, SERVER_SWITCHER_SWITCH_CONFIRM_ATTR)!;
    expect(subtreeText(confirm)).toContain('Work is still finishing on home');
    expect(subtreeText(confirm)).toContain('cannot confirm or cancel it');
    expect(subtreeText(confirm)).toContain('any outcome or receipt will stay there');
    expect(findByAttr(host, SERVER_SWITCHER_SWITCH_COMMIT_ATTR)?.textContent)
      .toBe('Switch, and check later');
    expect(findByAttr(host, SERVER_SWITCHER_SWITCH_CANCEL_ATTR)?.textContent)
      .toBe('Stay and wait');

    findByAttr(host, SERVER_SWITCHER_SWITCH_CANCEL_ATTR)!.click();
    expect(onSwitch).not.toHaveBeenCalled();
    expect(findByAttr(host, SERVER_SWITCHER_SWITCH_CONFIRM_ATTR)).toBeNull();
    expect(dom.activeElement()).toBe(
      findAllByAttr(host, SERVER_SWITCHER_ITEM_ATTR)[1],
    );
  });

  it('names active work and returns to its exact source route without switching', () => {
    const onReturnToWork = vi.fn();
    const { host, onSwitch } = setup({
      switchWorkState: () => 'in_flight',
      switchActiveWork: () => [{
        id: 'backup-1',
        label: 'Creating a full backup',
        returnHref: '#settings/backup',
        returnLabel: 'View backup progress',
      }],
      onReturnToWork,
    });
    findAllByAttr(host, SERVER_SWITCHER_ITEM_ATTR)[1]!.click();

    expect(subtreeText(findByAttr(host, SERVER_SWITCHER_ACTIVE_WORK_ITEM_ATTR)!))
      .toContain('Creating a full backup');
    const returnButton = findByAttr(host, SERVER_SWITCHER_RETURN_TO_WORK_ATTR);
    expect(returnButton?.textContent).toBe('View backup progress');
    returnButton?.click();

    expect(onReturnToWork).toHaveBeenCalledWith('#settings/backup');
    expect(onSwitch).not.toHaveBeenCalled();
    expect(findByAttr(host, SERVER_SWITCHER_SWITCH_CONFIRM_ATTR)).toBeNull();
  });

  it('requires a fresh review when one in-flight action replaces another', async () => {
    let activeWork = [{ id: 'work-1', label: 'Saving the first change' }];
    const { host, onSwitch } = setup({
      switchWorkState: () => 'in_flight',
      switchActiveWork: () => activeWork,
    });
    findAllByAttr(host, SERVER_SWITCHER_ITEM_ATTR)[1]!.click();

    activeWork = [{ id: 'work-2', label: 'Saving a newer change' }];
    findByAttr(host, SERVER_SWITCHER_SWITCH_COMMIT_ATTR)!.click();
    expect(onSwitch).not.toHaveBeenCalled();
    expect(subtreeText(findByAttr(host, SERVER_SWITCHER_SWITCH_CONFIRM_ATTR)!))
      .toContain('Saving a newer change');

    findByAttr(host, SERVER_SWITCHER_SWITCH_COMMIT_ATTR)!.click();
    await flush();
    expect(onSwitch).toHaveBeenCalledWith(
      'p2',
      'in_flight',
      [{ id: 'work-2', label: 'Saving a newer change' }],
    );
  });

  it('does not require another click when unsettled work becomes safer', async () => {
    let state: 'in_flight' | 'clean' = 'in_flight';
    const { host, onSwitch } = setup({ switchWorkState: () => state });
    findAllByAttr(host, SERVER_SWITCHER_ITEM_ATTR)[1]!.click();

    state = 'clean';
    findByAttr(host, SERVER_SWITCHER_SWITCH_COMMIT_ATTR)!.click();
    await flush();

    expect(onSwitch).toHaveBeenCalledWith('p2', 'in_flight');
    expect(findByAttr(host, SERVER_SWITCHER_SWITCH_CONFIRM_ATTR)).toBeNull();
  });

  it('requires a fresh confirmation if work becomes dirty while review is open', async () => {
    let state: 'clean' | 'chat_draft' = 'clean';
    const { dom, host, onSwitch } = setup({ switchWorkState: () => state });
    findAllByAttr(host, SERVER_SWITCHER_ITEM_ATTR)[1]!.click();
    expect(subtreeText(findByAttr(host, SERVER_SWITCHER_SWITCH_CONFIRM_ATTR)!))
      .toContain('Recued will reload this tab');

    state = 'chat_draft';
    findByAttr(host, SERVER_SWITCHER_SWITCH_COMMIT_ATTR)!.click();
    expect(onSwitch).not.toHaveBeenCalled();
    expect(subtreeText(findByAttr(host, SERVER_SWITCHER_SWITCH_CONFIRM_ATTR)!))
      .toContain('The Chat message you have not sent');
    expect(dom.activeElement()).toBe(
      findByAttr(host, SERVER_SWITCHER_SWITCH_CONFIRM_ATTR),
    );

    findByAttr(host, SERVER_SWITCHER_SWITCH_COMMIT_ATTR)!.click();
    await flush();
    expect(onSwitch).toHaveBeenCalledWith('p2', 'chat_draft');
  });

  it('keeps a failed switch inline with the current roster', async () => {
    const onSwitch = vi.fn().mockRejectedValue(new Error(
      'Couldn’t switch servers. Your work is still here; try again.',
    ));
    const { dom, host } = setup({ onSwitch });
    findAllByAttr(host, SERVER_SWITCHER_ITEM_ATTR)[1]!.click();
    findByAttr(host, SERVER_SWITCHER_SWITCH_COMMIT_ATTR)!.click();
    await flush();

    const error = findByAttr(host, SERVER_SWITCHER_SWITCH_ERROR_ATTR);
    expect(error?.textContent).toContain('Your work is still here');
    expect(findAllByAttr(host, SERVER_SWITCHER_ITEM_ATTR)).toHaveLength(2);
    expect(dom.activeElement()).toBe(error);
  });

  it('clicking the server you are ALREADY on switches nothing', () => {
    // Re-selecting the active row would otherwise tear down a healthy
    // connection and re-bootstrap for no reason. It still reports the click so
    // the container can close and the press does not feel ignored.
    const { host, onSwitch, onSelectActive } = setup();
    findAllByAttr(host, SERVER_SWITCHER_ITEM_ATTR)[0]!.click();
    expect(onSwitch).not.toHaveBeenCalled();
    expect(onSelectActive).toHaveBeenCalledTimes(1);
  });

  it('never offers a PENDING profile as a destination', () => {
    // A record whose URL has not arrived yet is roster bookkeeping. Rendering
    // it would put a row in the menu that cannot connect to anything.
    const { host } = setup({
      profiles: [HOME, profile({ id: 'p3', server_url: '', label: '' })],
    });
    expect(findAllByAttr(host, SERVER_SWITCHER_ITEM_ATTR)).toHaveLength(1);
  });

  it('says so on an empty roster instead of rendering a blank panel', () => {
    const { host } = setup({ profiles: [], activeProfileId: null });
    expect(findAllByAttr(host, SERVER_SWITCHER_ITEM_ATTR)).toHaveLength(0);
    expect(findByAttr(host, SERVER_SWITCHER_EMPTY_ATTR)?.textContent)
      .toContain('not paired with any server');
  });

  describe('unreachable marking', () => {
    it('marks ONLY the active row — the others are unprobed', () => {
      // Claiming a state for servers nobody has tried to reach would be
      // inventing status. Only the active connection's health is known.
      const { host } = setup({ activeUnreachable: true });
      const items = findAllByAttr(host, SERVER_SWITCHER_ITEM_ATTR);
      expect(items[0]!.getAttribute('data-unreachable')).toBe('true');
      expect(items[1]!.hasAttribute('data-unreachable')).toBe(false);
      expect(items[0]!.children[1]?.textContent).toContain('not reachable');
    });

    it('says nothing while the active server is reachable', () => {
      const { host } = setup({ activeUnreachable: false });
      const items = findAllByAttr(host, SERVER_SWITCHER_ITEM_ATTR);
      expect(items[0]!.hasAttribute('data-unreachable')).toBe(false);
      expect(items[0]!.children[1]?.textContent).not.toContain('not reachable');
    });

    it('refresh can flip it without a remount', () => {
      const { host, mount } = setup();
      mount.refresh([HOME, OFFICE], 'p1', true);
      expect(
        findAllByAttr(host, SERVER_SWITCHER_ITEM_ATTR)[0]!.getAttribute('data-unreachable'),
      ).toBe('true');
    });
  });

  describe('forgetting a server', () => {
    it('opens an explicit choice panel before changing anything', () => {
      const { host, onRemove } = setup();
      findAllByAttr(host, SERVER_SWITCHER_REMOVE_ATTR)[0]!.click();

      expect(onRemove).not.toHaveBeenCalled();
      expect(findByAttr(host, SERVER_SWITCHER_REMOVE_CONFIRM_ATTR)).not.toBeNull();
      expect(findByAttr(host, SERVER_SWITCHER_REMOVE_LOCAL_ATTR)?.textContent)
        .toBe('Forget on this browser');
      expect(findByAttr(host, SERVER_SWITCHER_REMOVE_REVOKE_ATTR)?.textContent)
        .toBe('Take access away and forget');
      expect(findByAttr(host, SERVER_SWITCHER_REMOVE_CANCEL_ATTR)).not.toBeNull();
    });

    it('forgets locally without pretending server access was revoked', async () => {
      const { host, onRemove } = setup();
      findAllByAttr(host, SERVER_SWITCHER_REMOVE_ATTR)[0]!.click();
      findByAttr(host, SERVER_SWITCHER_REMOVE_LOCAL_ATTR)!.click();
      await flush();

      expect(onRemove).toHaveBeenCalledWith('p1', 'local');
    });

    it('offers remote revoke only for the active connected profile with an instance id', () => {
      const active = setup();
      findAllByAttr(active.host, SERVER_SWITCHER_REMOVE_ATTR)[0]!.click();
      expect(findByAttr(active.host, SERVER_SWITCHER_REMOVE_REVOKE_ATTR)).not.toBeNull();

      const inactive = setup();
      findAllByAttr(inactive.host, SERVER_SWITCHER_REMOVE_ATTR)[1]!.click();
      expect(findByAttr(inactive.host, SERVER_SWITCHER_REMOVE_REVOKE_ATTR)).toBeNull();
      expect(findByAttr(inactive.host, SERVER_SWITCHER_REMOVE_STATUS_ATTR)?.textContent)
        .toContain('Switch to this server first');

      const disconnected = setup({ activeConnected: false });
      findAllByAttr(disconnected.host, SERVER_SWITCHER_REMOVE_ATTR)[0]!.click();
      expect(findByAttr(disconnected.host, SERVER_SWITCHER_REMOVE_REVOKE_ATTR)).toBeNull();
      expect(findByAttr(disconnected.host, SERVER_SWITCHER_REMOVE_STATUS_ATTR)?.textContent)
        .toContain('Reconnect');

      const legacy = setup({ profiles: [profile({ id: 'legacy' })], activeProfileId: 'legacy' });
      findByAttr(legacy.host, SERVER_SWITCHER_REMOVE_ATTR)!.click();
      expect(findByAttr(legacy.host, SERVER_SWITCHER_REMOVE_REVOKE_ATTR)).toBeNull();
      expect(findByAttr(legacy.host, SERVER_SWITCHER_REMOVE_STATUS_ATTR)?.textContent)
        .toContain('older profile');
    });

    it('reports the explicit revoke intent', async () => {
      const { host, onRemove } = setup();
      findAllByAttr(host, SERVER_SWITCHER_REMOVE_ATTR)[0]!.click();
      findByAttr(host, SERVER_SWITCHER_REMOVE_REVOKE_ATTR)!.click();
      await flush();

      expect(onRemove).toHaveBeenCalledWith('p1', 'revoke');
    });

    it('keeps a failed revoke visible with both retry and local-only recovery', async () => {
      const onRemove = vi.fn(async () => {
        throw new Error('Access could not be revoked. Saved access remains.');
      });
      const { host } = setup({ onRemove });
      findAllByAttr(host, SERVER_SWITCHER_REMOVE_ATTR)[0]!.click();
      findByAttr(host, SERVER_SWITCHER_REMOVE_REVOKE_ATTR)!.click();
      await flush();

      expect(findByAttr(host, SERVER_SWITCHER_REMOVE_CONFIRM_ATTR)).not.toBeNull();
      expect(findByAttr(host, SERVER_SWITCHER_REMOVE_ERROR_ATTR)?.textContent)
        .toContain('Saved access remains');
      expect(findByAttr(host, SERVER_SWITCHER_REMOVE_REVOKE_ATTR)).not.toBeNull();
      expect(findByAttr(host, SERVER_SWITCHER_REMOVE_LOCAL_ATTR)).not.toBeNull();
    });

    it('Cancel restores focus to Forget; disarm clears without removing anything', () => {
      const { dom, host, mount, onRemove } = setup();
      findAllByAttr(host, SERVER_SWITCHER_REMOVE_ATTR)[0]!.click();
      findByAttr(host, SERVER_SWITCHER_REMOVE_CANCEL_ATTR)!.click();
      expect(findByAttr(host, SERVER_SWITCHER_REMOVE_CONFIRM_ATTR)).toBeNull();
      expect(dom.activeElement()).toBe(
        findAllByAttr(host, SERVER_SWITCHER_REMOVE_ATTR)[0],
      );

      findAllByAttr(host, SERVER_SWITCHER_REMOVE_ATTR)[0]!.click();
      mount.disarm();
      expect(findByAttr(host, SERVER_SWITCHER_REMOVE_CONFIRM_ATTR)).toBeNull();
      expect(onRemove).not.toHaveBeenCalled();
    });

    it('omits the control entirely when no remove handler is wired', () => {
      const { host } = setup({ onRemove: undefined });
      expect(findAllByAttr(host, SERVER_SWITCHER_REMOVE_ATTR)).toHaveLength(0);
    });
  });

  it('refresh re-renders against a new roster', () => {
    const { host, mount } = setup();
    mount.refresh([OFFICE], 'p2');
    const items = findAllByAttr(host, SERVER_SWITCHER_ITEM_ATTR);
    expect(items).toHaveLength(1);
    expect(items[0]!.getAttribute('aria-current')).toBe('true');
  });

  it('preserves the focused profile action across reorder and recovers if it disappears', () => {
    const { dom, host, mount } = setup();
    const officeRename = findAllByAttr(host, SERVER_SWITCHER_RENAME_ATTR)[1]!;
    officeRename.focus();

    mount.refresh([
      HOME,
      { ...OFFICE, last_connected_at: 1_700_000_000_000 },
    ], 'p1');

    const focusedAfterReorder = findAllByAttr(host, SERVER_SWITCHER_RENAME_ATTR)
      .find((button) => button.getAttribute('data-profile-id') === 'p2');
    expect(dom.activeElement()).toBe(focusedAfterReorder);

    mount.refresh([HOME], 'p1');
    expect(dom.activeElement()).toBe(findByAttr(host, SERVER_SWITCHER_MENU_ATTR));
  });

  it('dispose removes the nodes and is idempotent', () => {
    const { host, mount } = setup();
    mount.dispose();
    mount.dispose();
    expect(findByAttr(host, SERVER_SWITCHER_ATTR)).toBeNull();
  });
});
