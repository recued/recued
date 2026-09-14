/** Account menu acceptance — the topbar's rightmost control.
 *
 *  The persistent banner announces an outage; Account owns the exact active
 *  profile, recovery explanation, status controls, and local profile actions.
 *  These pin that single hierarchy, honest dialog semantics, focus handoff,
 *  and the fact that opening it needs no server.
 */

import { describe, expect, it, vi } from 'vitest';

import type { WebclientServerProfile } from '@recued/contracts';
import {
  ACCOUNT_MENU_ADD_SERVER_ATTR,
  ACCOUNT_MENU_ACTIVE_WORK_ATTR,
  ACCOUNT_MENU_ACTIVE_WORK_ITEM_ATTR,
  ACCOUNT_MENU_ACTIVE_WORK_RETURN_ATTR,
  ACCOUNT_MENU_ATTR,
  ACCOUNT_MENU_BADGE_ATTR,
  ACCOUNT_MENU_CLOSE_ATTR,
  ACCOUNT_MENU_CONNECTION_DIAGNOSIS_ATTR,
  ACCOUNT_MENU_CONNECTION_DIAGNOSIS_CONTROLS_ATTR,
  ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RECONCILE_ATTR,
  ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RECEIPT_ATTR,
  ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RETURN_ATTR,
  ACCOUNT_MENU_CONNECTION_DIAGNOSIS_STATUS_ATTR,
  ACCOUNT_MENU_CONNECTION_DIAGNOSIS_TITLE_ATTR,
  ACCOUNT_MENU_POPOVER_ATTR,
  ACCOUNT_MENU_QUICK_ROW_ATTR,
  ACCOUNT_MENU_RECOVERY_ATTR,
  ACCOUNT_MENU_RECOVERY_STEPS_ATTR,
  ACCOUNT_MENU_SERVERS_ROW_ATTR,
  ACCOUNT_MENU_SERVERS_DETAIL_ATTR,
  ACCOUNT_MENU_SETTINGS_ATTR,
  ACCOUNT_MENU_SERVER_SLOT_ATTR,
  ACCOUNT_MENU_SERVER_SLOT_DIAGNOSIS_TARGET_ATTR,
  ACCOUNT_MENU_SERVER_UPDATE_ATTR,
  ACCOUNT_MENU_SERVER_UPDATE_DISMISS_ATTR,
  ACCOUNT_MENU_SERVER_UPDATE_DIAGNOSTIC_ATTR,
  ACCOUNT_MENU_SERVER_UPDATE_DIAGNOSTIC_COPY_ATTR,
  ACCOUNT_MENU_SERVER_UPDATE_DIAGNOSTIC_STATUS_ATTR,
  ACCOUNT_MENU_SERVER_UPDATE_DIAGNOSTIC_SUMMARY_ATTR,
  ACCOUNT_MENU_SERVER_UPDATE_OPEN_ATTR,
  ACCOUNT_MENU_SERVER_UPDATE_RETRY_ATTR,
  ACCOUNT_MENU_SERVER_UPDATE_RETURN_ATTR,
  ACCOUNT_MENU_SERVER_UPDATE_STATUS_ATTR,
  ACCOUNT_MENU_SERVER_UPDATE_STEPS_ATTR,
  ACCOUNT_MENU_THEME_SLOT_ATTR,
  ACCOUNT_MENU_TITLE_ATTR,
  ACCOUNT_MENU_TRIGGER_ATTR,
  buildAccountServerUpdateDiagnostic,
  mountAccountMenu,
  type AccountConnectionDiagnosis,
} from '../shell/account-menu.js';
import {
  SERVER_SWITCHER_ATTR,
  SERVER_SWITCHER_ANNOUNCER_ATTR,
  SERVER_SWITCHER_ITEM_ATTR,
  SERVER_SWITCHER_MENU_ATTR,
  SERVER_SWITCHER_RECENCY_ATTR,
  SERVER_SWITCHER_SWITCH_COMMIT_ATTR,
  SERVER_SWITCHER_SWITCH_CONFIRM_ATTR,
  SERVER_SWITCHER_REMOVE_ATTR,
  SERVER_SWITCHER_REMOVE_CONFIRM_ATTR,
  SERVER_SWITCHER_REMOVE_LOCAL_ATTR,
  SERVER_SWITCHER_REMOVE_REVOKE_ATTR,
} from '../shell/server-switcher.js';
import { SERVER_CONTROL_POPOVER_ATTR } from '../shell/server-pill-host.js';

interface FakeEvent {
  type: string;
  target: FakeEl | null;
  key?: string;
  isComposing?: boolean;
}
type FakeListener = (event: FakeEvent) => void;

interface FakeEl {
  tagName: string;
  textContent: string;
  className: string;
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
  focus(): void;
  contains(node: FakeEl): boolean;
  closest(selector: string): FakeEl | null;
}

const buildFakeDocument = () => {
  let active: FakeEl | null = null;
  const documentListeners = new Map<string, Set<FakeListener>>();

  const makeEl = (tagName: string): FakeEl => {
    const el: FakeEl = {
      tagName: tagName.toUpperCase(),
      textContent: '',
      className: '',
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
      focus() { active = el; },
      contains(node) {
        if (node === el) return true;
        return el.children.some((c) => c.contains(node));
      },
      closest(selector) {
        const attr = /^\[([^\]]+)\]$/.exec(selector)?.[1] ?? null;
        let current: FakeEl | null = el;
        while (current !== null) {
          if (attr !== null && current.hasAttribute(attr)) return current;
          current = current.parent;
        }
        return null;
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
    fire(type: string, init?: {
      target?: FakeEl;
      key?: string;
      isComposing?: boolean;
    }) {
      for (const l of [...(documentListeners.get(type) ?? [])]) {
        l({
          type,
          target: init?.target ?? null,
          ...(init?.key !== undefined ? { key: init.key } : {}),
          ...(init?.isComposing !== undefined
            ? { isComposing: init.isComposing }
            : {}),
        });
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

const subtreeText = (root: FakeEl): string => [
  root.textContent,
  ...root.children.map((child) => subtreeText(child)),
].join(' ');


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

const setup = (over: Partial<Parameters<typeof mountAccountMenu>[0]> = {}) => {
  const dom = buildFakeDocument();
  const host = dom.create('div');
  const onSwitch = vi.fn();
  const onRemove = vi.fn();
  const mount = mountAccountMenu({
    host: host as unknown as HTMLElement,
    document: dom.document,
    profiles: [HOME, OFFICE],
    activeProfileId: 'p1',
    settingsHref: '#settings/account',
    onSwitch,
    onRemove,
    activeConnected: true,
    ...over,
  });
  return { dom, host, mount, onSwitch, onRemove };
};

const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe('mountAccountMenu', () => {
  it('renders a closed menu with the account trigger', () => {
    const { host, mount } = setup();
    const trigger = findByAttr(host, ACCOUNT_MENU_TRIGGER_ATTR)!;
    expect(trigger).not.toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(findByAttr(host, ACCOUNT_MENU_POPOVER_ATTR)!.hasAttribute('hidden')).toBe(true);
    expect(mount.isOpen()).toBe(false);
  });

  it('opens one named dialog containing quick actions and server profiles', () => {
    const { host, mount, dom } = setup();
    const trigger = findByAttr(host, ACCOUNT_MENU_TRIGGER_ATTR)!;
    const popover = findByAttr(host, ACCOUNT_MENU_POPOVER_ATTR)!;
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(popover.getAttribute('role')).toBe('dialog');
    expect(popover.getAttribute('aria-labelledby')).toBe('recued-account-menu-title');
    findByAttr(host, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    expect(mount.isOpen()).toBe(true);
    expect(dom.activeElement()).toBe(popover);
    const dialogTitle = findByAttr(popover, ACCOUNT_MENU_TITLE_ATTR)?.children[0];
    expect(dialogTitle?.tagName).toBe('H2');
    expect(dialogTitle?.textContent).toBe('Account & servers');
    const quick = findByAttr(host, ACCOUNT_MENU_QUICK_ROW_ATTR)!;
    const servers = findByAttr(host, ACCOUNT_MENU_SERVERS_ROW_ATTR)!;
    expect(quick).not.toBeNull();
    expect(servers).not.toBeNull();
    expect(servers.children[0]?.tagName).toBe('H3');
    expect(servers.children[0]?.textContent).toBe('Server profiles');
    // Quick actions and profiles share one dialog instead of separate status
    // and account popovers.
    expect(findByAttr(quick, ACCOUNT_MENU_THEME_SLOT_ATTR)).not.toBeNull();
    expect(findByAttr(quick, ACCOUNT_MENU_SETTINGS_ATTR)!.getAttribute('href'))
      .toBe('#settings/account');
    expect(findAllByAttr(servers, SERVER_SWITCHER_ITEM_ATTR)).toHaveLength(2);
    expect(findByAttr(servers, ACCOUNT_MENU_SERVERS_DETAIL_ATTR)?.textContent)
      .toBe('Names and recent use are kept only in this browser.');
  });

  it('refreshes relative recency when Account opens after an idle tab', () => {
    let now = 1_700_000_000_000;
    const recentOffice = { ...OFFICE, last_connected_at: now - (5 * 60_000) };
    const { host } = setup({
      profiles: [HOME, recentOffice],
      activeConnected: false,
      now: () => now,
    });
    expect(findByAttr(host, SERVER_SWITCHER_RECENCY_ATTR)?.textContent)
      .toBe('Last connected 5 minutes ago');

    now += 55 * 60_000;
    findByAttr(host, ACCOUNT_MENU_TRIGGER_ATTR)!.click();

    expect(findByAttr(host, SERVER_SWITCHER_RECENCY_ATTR)?.textContent)
      .toBe('Last connected 1 hour ago');
  });

  it('has an explicit close action that restores focus to Account', () => {
    const { host, mount, dom } = setup();
    const trigger = findByAttr(host, ACCOUNT_MENU_TRIGGER_ATTR)!;
    trigger.click();
    findByAttr(host, ACCOUNT_MENU_CLOSE_ATTR)!.click();
    expect(mount.isOpen()).toBe(false);
    expect(dom.activeElement()).toBe(trigger);
  });

  it('gives an external exact landing a stable focus bridge through Account', () => {
    const onClose = vi.fn();
    const { host, mount, dom } = setup({ onClose });
    const trigger = findByAttr(host, ACCOUNT_MENU_TRIGGER_ATTR)!;
    const destination = dom.create('button');
    trigger.click();
    expect(dom.activeElement()).toBe(
      findByAttr(host, ACCOUNT_MENU_POPOVER_ATTR),
    );

    expect(mount.close()).toBe(true);
    expect(mount.isOpen()).toBe(false);
    expect(findByAttr(
      host,
      ACCOUNT_MENU_POPOVER_ATTR,
    )!.hasAttribute('hidden')).toBe(true);
    expect(dom.activeElement()).toBe(trigger);
    destination.focus();
    expect(dom.activeElement()).toBe(destination);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does not let an external landing close over an in-flight profile action', async () => {
    let finishSwitch = (): void => undefined;
    const switchInFlight = new Promise<void>((resolve) => {
      finishSwitch = resolve;
    });
    const onClose = vi.fn();
    const { host, mount, dom } = setup({
      onClose,
      onSwitch: vi.fn(() => switchInFlight),
    });
    const trigger = findByAttr(host, ACCOUNT_MENU_TRIGGER_ATTR)!;
    trigger.click();
    findAllByAttr(host, SERVER_SWITCHER_ITEM_ATTR)[1]!.click();
    findByAttr(host, SERVER_SWITCHER_SWITCH_COMMIT_ATTR)!.click();

    expect(mount.close()).toBe(false);
    expect(mount.isOpen()).toBe(true);
    expect(findByAttr(
      host,
      ACCOUNT_MENU_POPOVER_ATTR,
    )!.hasAttribute('hidden')).toBe(false);
    expect(dom.activeElement()).not.toBe(trigger);
    expect(onClose).not.toHaveBeenCalled();

    finishSwitch();
    await flush();
    expect(mount.isOpen()).toBe(false);
    expect(dom.activeElement()).toBe(trigger);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('opens on an exact profile without selecting it and reports a real close once', () => {
    const onClose = vi.fn();
    const { dom, host, mount, onSwitch } = setup({ onClose });

    expect(mount.openServerProfile('p2')).toBe('opened');
    expect(mount.isOpen()).toBe(true);
    expect(dom.activeElement()?.getAttribute('data-profile-id')).toBe('p2');
    expect(onSwitch).not.toHaveBeenCalled();

    findByAttr(host, ACCOUNT_MENU_CLOSE_ATTR)!.click();
    expect(onClose).toHaveBeenCalledOnce();
    mount.dispose();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('lands on one exact live connection diagnosis and returns deliberately', () => {
    const onConnectionDiagnosisClosed = vi.fn();
    const { dom, host, mount } = setup({
      onConnectionDiagnosisClosed,
    });
    const diagnosis = {
      id: 'recovery-verification:1700000000000:1',
      profileId: 'p1',
      profileLabel: 'Home server',
      areaLabel: 'Contracts',
      interruptionReason: 'connection' as const,
    };

    expect(mount.canOpenConnectionDiagnosis('p1')).toBe(true);
    expect(mount.openConnectionDiagnosis(diagnosis)).toBe('opened');
    const section = findByAttr(
      host,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_ATTR,
    )!;
    const title = findByAttr(
      section,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_TITLE_ATTR,
    )!;
    const status = findByAttr(
      section,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_STATUS_ATTR,
    )!;
    expect(mount.isOpen()).toBe(true);
    expect(section.hasAttribute('hidden')).toBe(false);
    expect(section.getAttribute('data-interruption-reason')).toBe(
      'connection',
    );
    expect(title.textContent).toBe('Check connection to home.example:8443');
    expect(dom.activeElement()).toBe(title);
    expect(title.getAttribute('aria-describedby')).toBe(
      'recued-account-menu-connection-diagnosis-detail recued-account-menu-connection-diagnosis-status',
    );
    expect(subtreeText(section)).toContain(
      'The check stopped because the server connection changed.',
    );
    expect(subtreeText(section)).toContain(
      'Opening Account does not retry verification or mark it resolved.',
    );
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toContain(
      'home.example:8443 is connected now',
    );
    expect(status.textContent).toContain(
      'Connection alone does not verify Contracts',
    );

    // Live connection renders update only the status copy; the stable
    // diagnosis heading keeps keyboard and assistive-technology focus.
    mount.setActiveConnected(false);
    expect(status.textContent).toContain(
      'home.example:8443 is reconnecting or still being checked',
    );
    expect(dom.activeElement()).toBe(title);
    mount.setUnreachable(true);
    expect(status.textContent).toContain(
      'home.example:8443 cannot be reached',
    );
    expect(dom.activeElement()).toBe(title);
    mount.refresh(
      [{ ...HOME, label: 'Renamed home' }, OFFICE],
      'p1',
      false,
      true,
    );
    expect(title.textContent).toBe('Check connection to Renamed home');
    expect(status.textContent).toContain('Renamed home is connected now');
    expect(dom.activeElement()).toBe(title);

    const returnButton = findByAttr(
      section,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RETURN_ATTR,
    )!;
    expect(returnButton.textContent).toBe('Say what you found');
    returnButton.click();
    expect(mount.isOpen()).toBe(false);
    expect(dom.activeElement()).toBe(
      findByAttr(host, ACCOUNT_MENU_TRIGGER_ATTR),
    );
    expect(onConnectionDiagnosisClosed).toHaveBeenCalledWith(
      diagnosis,
      'return',
    );

    // The cue is one-shot. A normal Account reopen cannot replay it.
    findByAttr(host, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    expect(section.hasAttribute('hidden')).toBe(true);
    expect(title.textContent).toBe('');
  });

  it('orients an expired-area retry handoff without inventing a verification outcome', () => {
    const onConnectionDiagnosisClosed = vi.fn();
    const { dom, host, mount } = setup({ onConnectionDiagnosisClosed });
    const diagnosis: AccountConnectionDiagnosis = {
      id: 'expired-area-review:1700000000000:1',
      profileId: 'p1',
      profileLabel: 'Home server',
      areaLabel: 'Contracts',
      kind: 'expired_area_review',
    };

    expect(mount.openConnectionDiagnosis(diagnosis)).toBe('opened');
    const section = findByAttr(
      host,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_ATTR,
    )!;
    const title = findByAttr(
      section,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_TITLE_ATTR,
    )!;
    expect(title.textContent).toBe(
      'Review home.example:8443 for Contracts',
    );
    expect(dom.activeElement()).toBe(title);
    expect(subtreeText(section)).toContain(
      'stopped after two unsuccessful current Contracts checks',
    );
    expect(subtreeText(section)).toContain(
      'This review will not retry Contracts',
    );
    expect(subtreeText(section)).toContain(
      'choose one fresh current-area check or close the review',
    );
    expect(subtreeText(section)).not.toContain(
      'The latest check ended',
    );
    const returnButton = findByAttr(
      section,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RETURN_ATTR,
    )!;
    expect(returnButton.textContent).toBe('Choose: check, or close');
    expect(returnButton.getAttribute('aria-label')).toContain(
      'choose one current Contracts check or close the review',
    );
    returnButton.click();
    expect(onConnectionDiagnosisClosed).toHaveBeenCalledWith(
      diagnosis,
      'return',
    );
  });

  it('opens the exact active-server controls and returns to the outcome step', () => {
    let returnFromControls = (): void => undefined;
    const onConnectionDiagnosisClosed = vi.fn();
    let publishControlReceipt: Parameters<NonNullable<
      Parameters<typeof mountAccountMenu>[0][
        'onReviewConnectionDiagnosisServerControls'
      ]
    >>[1]['onReceipt'] = () => undefined;
    const diagnosis: AccountConnectionDiagnosis = {
      id: 'recovery-verification:1700000000000:controls',
      profileId: 'p1',
      profileLabel: 'Home server',
      areaLabel: 'Contracts',
      interruptionReason: 'connection',
    };
    const onReviewConnectionDiagnosisServerControls = vi.fn(
      (
        received: AccountConnectionDiagnosis,
        handoff: Parameters<NonNullable<
          Parameters<typeof mountAccountMenu>[0][
            'onReviewConnectionDiagnosisServerControls'
          ]
        >>[1],
      ): 'opened' => {
        expect(received).toEqual(diagnosis);
        returnFromControls = handoff.onReturn;
        publishControlReceipt = handoff.onReceipt;
        return 'opened';
      },
    );
    const { dom, host, mount } = setup({
      onConnectionDiagnosisClosed,
      onReviewConnectionDiagnosisServerControls,
    });
    mount.setConnectionDiagnosisControlAvailability('p1', true);
    expect(mount.openConnectionDiagnosis(diagnosis)).toBe('opened');

    const section = findByAttr(
      host,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_ATTR,
    )!;
    const controls = findByAttr(
      section,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_CONTROLS_ATTR,
    )!;
    const outcome = findByAttr(
      section,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RETURN_ATTR,
    )!;
    const receipt = findByAttr(
      section,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RECEIPT_ATTR,
    )!;
    const status = findByAttr(
      section,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_STATUS_ATTR,
    )!;
    const serverSlot = findByAttr(host, ACCOUNT_MENU_SERVER_SLOT_ATTR)!;
    expect(controls.textContent).toBe('Look at the server controls');
    expect(controls.hasAttribute('disabled')).toBe(false);
    expect(section.getAttribute('data-control-review')).toBe('ready');

    controls.click();
    expect(onReviewConnectionDiagnosisServerControls).toHaveBeenCalledOnce();
    expect(section.getAttribute('data-control-review')).toBe('active');
    expect(serverSlot.hasAttribute(
      ACCOUNT_MENU_SERVER_SLOT_DIAGNOSIS_TARGET_ATTR,
    )).toBe(true);
    expect(controls.textContent).toBe('Looking at the server controls');
    expect(controls.hasAttribute('disabled')).toBe(true);
    expect(status.textContent).toContain('controls are open');

    publishControlReceipt({ action: 'pause', phase: 'pending' });
    expect(receipt.hasAttribute('hidden')).toBe(false);
    expect(receipt.getAttribute('data-action')).toBe('pause');
    expect(receipt.getAttribute('data-phase')).toBe('pending');
    expect(receipt.textContent).toContain('Pause asked for');
    expect(receipt.textContent).toContain('does not prove Contracts');
    publishControlReceipt({
      action: 'pause',
      phase: 'confirmed',
      currentState: 'paused',
    });
    expect(receipt.getAttribute('data-phase')).toBe('confirmed');
    expect(receipt.textContent).toContain('Pause completed');
    expect(receipt.textContent).toContain('work is paused');

    returnFromControls();
    expect(section.getAttribute('data-control-review')).toBe('returned');
    expect(serverSlot.hasAttribute(
      ACCOUNT_MENU_SERVER_SLOT_DIAGNOSIS_TARGET_ATTR,
    )).toBe(false);
    expect(controls.textContent).toBe(
      'Look at the server controls again',
    );
    expect(status.textContent).toContain(
      'home.example:8443 is connected now. Back from its controls',
    );
    expect(receipt.hasAttribute('hidden')).toBe(false);
    expect(receipt.textContent).toContain('Pause completed');
    expect(dom.activeElement()).toBe(outcome);

    publishControlReceipt({
      action: 'restart',
      phase: 'accepted',
      currentState: 'restarting',
    });
    expect(receipt.getAttribute('data-phase')).toBe('accepted');
    expect(receipt.textContent).toContain('Restart accepted');
    expect(receipt.textContent).toContain('a new status to arrive');
    publishControlReceipt({
      action: 'restart',
      phase: 'reconnected',
      currentState: 'running',
    });
    expect(receipt.getAttribute('data-phase')).toBe('reconnected');
    expect(receipt.textContent).toContain('does not prove it actually started again');
    expect(receipt.textContent).toContain('work is running');
    expect(receipt.textContent).toContain('does not prove Contracts');
    publishControlReceipt({
      action: 'restart',
      phase: 'confirmed',
      currentState: 'running',
    });
    expect(receipt.textContent).toContain('really did start again');
    expect(receipt.textContent).toContain('work is running');
    publishControlReceipt({
      action: 'restart',
      phase: 'failed',
      currentState: 'running',
      detail: 'A restart is already in progress.',
    });
    expect(receipt.textContent).toContain(
      'This request did not start a restart',
    );
    expect(receipt.textContent).toContain('work is running');
    publishControlReceipt({
      action: 'pause',
      phase: 'failed',
      currentState: 'running',
      detail: `${'x'.repeat(319)}…`,
    });
    expect(receipt.textContent).toContain('… Last known state');
    expect(receipt.textContent).not.toContain('….');

    controls.focus();
    mount.setConnectionDiagnosisControlAvailability(null, false);
    expect(controls.hasAttribute('disabled')).toBe(true);
    expect(dom.activeElement()).toBe(outcome);
    mount.setConnectionDiagnosisControlAvailability('p1', true);

    // A connection loss while a repeated review is active returns to the same
    // outcome step instead of leaving focus in a hidden server-control tree.
    controls.click();
    expect(section.getAttribute('data-control-review')).toBe('active');
    mount.setConnectionDiagnosisControlAvailability(null, false);
    expect(section.getAttribute('data-control-review')).toBe('returned');
    expect(controls.hasAttribute('disabled')).toBe(true);
    expect(dom.activeElement()).toBe(outcome);

    // Only the closed-list outcome crosses the explicit return. RPC detail is
    // Account-owned receipt copy and cannot leak into recovery continuity.
    publishControlReceipt({
      action: 'pause',
      phase: 'superseded',
      currentState: 'running',
      detail: 'private transport detail',
    });
    outcome.click();
    expect(onConnectionDiagnosisClosed).toHaveBeenCalledWith(
      diagnosis,
      'return',
      {
        action: 'pause',
        phase: 'superseded',
        currentState: 'running',
      },
    );
    expect(onConnectionDiagnosisClosed.mock.calls[0]?.[2]).not.toHaveProperty(
      'detail',
    );
  });

  it('reopens an unresolved receipt on the exact live controls without replaying it', () => {
    let returnFromControls = (): void => undefined;
    const onConnectionDiagnosisClosed = vi.fn();
    const onReviewConnectionDiagnosisServerControls = vi.fn(
      (
        _diagnosis: AccountConnectionDiagnosis,
        handoff: Parameters<NonNullable<
          Parameters<typeof mountAccountMenu>[0][
            'onReviewConnectionDiagnosisServerControls'
          ]
        >>[1],
      ): 'opened' => {
        returnFromControls = handoff.onReturn;
        return 'opened';
      },
    );
    const { dom, host, mount } = setup({
      onConnectionDiagnosisClosed,
      onReviewConnectionDiagnosisServerControls,
      onReadConnectionDiagnosisServerCurrentState: () => ({
        state: 'running',
      }),
    });
    mount.setConnectionDiagnosisControlAvailability('p1', true);
    mount.setConnectionDiagnosisCurrentStateAvailability('p1', true);

    const diagnosis: AccountConnectionDiagnosis = {
      id: 'recovery-server-re-review:1700000000000:1',
      profileId: 'p1',
      profileLabel: 'Home server',
      areaLabel: 'Contracts',
    };
    expect(mount.openConnectionDiagnosis(diagnosis, {
      initialServerOutcome: {
        action: 'restart',
        phase: 'reconnected',
        currentState: 'running',
      },
      reviewServerControls: true,
    })).toBe('opened');

    const section = findByAttr(
      host,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_ATTR,
    )!;
    const receipt = findByAttr(
      section,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RECEIPT_ATTR,
    )!;
    const title = findByAttr(
      section,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_TITLE_ATTR,
    )!;
    const outcome = findByAttr(
      section,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RETURN_ATTR,
    )!;
    const reconcile = findByAttr(
      section,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RECONCILE_ATTR,
    )!;

    expect(title.textContent).toBe('Review home.example:8443 again');
    expect(subtreeText(section)).toContain(
      'The last server-control receipt did not settle the result.',
    );
    expect(subtreeText(section)).toContain('Nothing runs automatically');
    expect(section.getAttribute('data-control-review')).toBe('active');
    expect(onReviewConnectionDiagnosisServerControls).toHaveBeenCalledOnce();
    expect(receipt.getAttribute('data-action')).toBe('restart');
    expect(receipt.getAttribute('data-phase')).toBe('reconnected');
    expect(receipt.textContent).toContain(
      'does not prove it actually started again',
    );

    // Inspecting the controls does not synthesize a fresh action receipt. The
    // prior unresolved projection remains the exact return context.
    returnFromControls();
    expect(dom.activeElement()).toBe(reconcile);
    outcome.click();
    expect(onConnectionDiagnosisClosed).toHaveBeenCalledWith(
      diagnosis,
      'return',
      {
        action: 'restart',
        phase: 'reconnected',
        currentState: 'running',
      },
    );
  });

  it('closes an unresolved receipt against a separate stable current-state observation', () => {
    const onConnectionDiagnosisClosed = vi.fn();
    const onReadConnectionDiagnosisServerCurrentState = vi.fn(() => ({
      state: 'paused' as const,
    }));
    const onReviewConnectionDiagnosisServerControls = vi.fn(
      (): 'opened' => 'opened',
    );
    const { dom, host, mount } = setup({
      onConnectionDiagnosisClosed,
      onReadConnectionDiagnosisServerCurrentState,
      onReviewConnectionDiagnosisServerControls,
    });
    mount.setConnectionDiagnosisControlAvailability('p1', true);
    const diagnosis: AccountConnectionDiagnosis = {
      id: 'recovery-server-re-review:1700000000000:reconcile',
      profileId: 'p1',
      profileLabel: 'Home server',
      areaLabel: 'Contracts',
    };

    expect(mount.openConnectionDiagnosis(diagnosis, {
      initialServerOutcome: {
        action: 'pause',
        phase: 'unconfirmed',
        currentState: 'running',
      },
      reviewServerControls: true,
    })).toBe('opened');
    const section = findByAttr(
      host,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_ATTR,
    )!;
    const reconcile = findByAttr(
      section,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RECONCILE_ATTR,
    )!;
    const status = findByAttr(
      section,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_STATUS_ATTR,
    )!;
    const receipt = findByAttr(
      section,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RECEIPT_ATTR,
    )!;
    const keepUnresolved = findByAttr(
      section,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RETURN_ATTR,
    )!;
    expect(reconcile.hasAttribute('hidden')).toBe(false);
    expect(reconcile.hasAttribute('disabled')).toBe(true);
    expect(reconcile.textContent).toBe('Waiting to hear how the server is doing…');
    expect(status.textContent).toContain('controls are open');

    mount.setConnectionDiagnosisCurrentStateAvailability('p1', true);
    expect(reconcile.hasAttribute('disabled')).toBe(false);
    expect(reconcile.textContent).toBe('Use what the server says now');
    expect(status.textContent).toContain(
      'stable current state ready to reconcile with the last receipt',
    );
    expect(receipt.textContent).toMatch(/^Last receipt — /);
    expect(keepUnresolved.getAttribute('aria-label')).toBe(
      'Keep the historical server receipt from home.example:8443 unresolved in Attention for Contracts',
    );
    expect(subtreeText(section)).toContain(
      'does not claim the earlier request succeeded',
    );

    reconcile.click();
    expect(onReadConnectionDiagnosisServerCurrentState).toHaveBeenCalledWith(
      diagnosis,
    );
    expect(mount.isOpen()).toBe(false);
    expect(dom.activeElement()).toBe(
      findByAttr(host, ACCOUNT_MENU_TRIGGER_ATTR),
    );
    expect(onConnectionDiagnosisClosed).toHaveBeenCalledWith(
      diagnosis,
      'return',
      {
        action: 'pause',
        phase: 'unconfirmed',
        currentState: 'running',
      },
      { state: 'paused' },
    );
  });

  it('keeps the receipt unresolved when current state changes at click time', () => {
    const onConnectionDiagnosisClosed = vi.fn();
    const { dom, host, mount } = setup({
      onConnectionDiagnosisClosed,
      onReadConnectionDiagnosisServerCurrentState: () => null,
      onReviewConnectionDiagnosisServerControls: () => 'opened',
    });
    mount.setConnectionDiagnosisControlAvailability('p1', true);
    mount.setConnectionDiagnosisCurrentStateAvailability('p1', true);
    expect(mount.openConnectionDiagnosis({
      id: 'recovery-server-re-review:1700000000000:changed',
      profileId: 'p1',
      profileLabel: 'Home server',
      areaLabel: 'Contracts',
    }, {
      initialServerOutcome: { action: 'restart', phase: 'reconnected' },
      reviewServerControls: true,
    })).toBe('opened');
    const section = findByAttr(
      host,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_ATTR,
    )!;
    const reconcile = findByAttr(
      section,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RECONCILE_ATTR,
    )!;
    const outcome = findByAttr(
      section,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RETURN_ATTR,
    )!;

    reconcile.click();
    expect(mount.isOpen()).toBe(true);
    expect(reconcile.hasAttribute('disabled')).toBe(true);
    expect(subtreeText(section)).toContain(
      'changed or is still settling',
    );
    expect(dom.activeElement()).toBe(outcome);
    expect(onConnectionDiagnosisClosed).not.toHaveBeenCalled();
  });

  it('opens a queued receipt re-review once when fresh controls arrive later', () => {
    const onReviewConnectionDiagnosisServerControls = vi.fn(
      (): 'opened' => 'opened',
    );
    const { host, mount } = setup({
      onReviewConnectionDiagnosisServerControls,
    });
    const diagnosis: AccountConnectionDiagnosis = {
      id: 'recovery-server-re-review:1700000000000:deferred',
      profileId: 'p1',
      profileLabel: 'Home server',
      areaLabel: 'Contracts',
    };

    expect(mount.openConnectionDiagnosis(diagnosis, {
      initialServerOutcome: {
        action: 'pause',
        phase: 'unconfirmed',
        currentState: 'running',
      },
      reviewServerControls: true,
    })).toBe('opened');
    const section = findByAttr(
      host,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_ATTR,
    )!;
    const receipt = findByAttr(
      section,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RECEIPT_ATTR,
    )!;
    expect(section.getAttribute('data-control-review')).toBe('waiting');
    expect(receipt.getAttribute('data-phase')).toBe('unconfirmed');
    expect(onReviewConnectionDiagnosisServerControls).not.toHaveBeenCalled();

    mount.setConnectionDiagnosisControlAvailability('p1', true);
    expect(section.getAttribute('data-control-review')).toBe('active');
    expect(onReviewConnectionDiagnosisServerControls).toHaveBeenCalledOnce();
    expect(onReviewConnectionDiagnosisServerControls).toHaveBeenCalledWith(
      diagnosis,
      expect.objectContaining({ ownerId: diagnosis.id }),
    );

    // Repeated heartbeat-backed availability cannot replay the one-shot open.
    mount.setConnectionDiagnosisControlAvailability('p1', true);
    expect(onReviewConnectionDiagnosisServerControls).toHaveBeenCalledOnce();
  });

  it('binds live controls to this tab server without dropping an early heartbeat', () => {
    const onReviewConnectionDiagnosisServerControls = vi.fn(
      (): 'opened' => 'opened',
    );
    const { host, mount } = setup({
      activeConnected: false,
      onReviewConnectionDiagnosisServerControls,
    });
    expect(mount.openConnectionDiagnosis({
      id: 'recovery-verification:1700000000000:profile-bound',
      profileId: 'p1',
      profileLabel: 'Home server',
      areaLabel: 'Contracts',
      interruptionReason: 'connection',
    })).toBe('opened');
    const controls = findByAttr(
      host,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_CONTROLS_ATTR,
    )!;

    // The live owner can report before Account receives its parallel status
    // projection. Keep that fresh signal, but do not expose it prematurely.
    mount.setConnectionDiagnosisControlAvailability('p1', true);
    expect(controls.hasAttribute('disabled')).toBe(true);
    mount.setActiveConnected(true);
    expect(controls.hasAttribute('disabled')).toBe(false);

    // A sibling can move the saved active pointer before this source tab
    // reloads. Never relabel the source socket as controls for that profile.
    mount.refresh([HOME, OFFICE], 'p2', false, true);
    expect(mount.openConnectionDiagnosis({
      id: 'recovery-verification:1700000000000:sibling-profile',
      profileId: 'p2',
      profileLabel: 'Office server',
      areaLabel: 'Contracts',
      interruptionReason: 'ownership',
    })).toBe('opened');
    expect(controls.hasAttribute('disabled')).toBe(true);
    controls.click();
    expect(onReviewConnectionDiagnosisServerControls).not.toHaveBeenCalled();
  });

  it('lets nested server controls consume Escape before Account closes', () => {
    const { dom, host, mount } = setup();
    findByAttr(host, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    const serverSlot = findByAttr(host, ACCOUNT_MENU_SERVER_SLOT_ATTR)!;
    const nestedSurface = dom.create('div');
    nestedSurface.setAttribute(SERVER_CONTROL_POPOVER_ATTR, '');
    const nestedControl = dom.create('button');
    nestedSurface.appendChild(nestedControl);
    serverSlot.appendChild(nestedSurface);
    nestedControl.focus();

    dom.fire('keydown', { key: 'Escape', target: nestedControl });

    expect(mount.isOpen()).toBe(true);
    expect(dom.activeElement()).toBe(nestedControl);
  });

  it('keeps a dismissed diagnosis quiet and rejects or retires another active profile', () => {
    const onConnectionDiagnosisClosed = vi.fn();
    const { host, mount } = setup({ onConnectionDiagnosisClosed });
    const diagnosis = {
      id: 'recovery-verification:1700000000000:2',
      profileId: 'p1',
      profileLabel: 'Home server',
      areaLabel: 'Contracts',
      interruptionReason: 'reload' as const,
    };

    expect(mount.openConnectionDiagnosis(diagnosis)).toBe('opened');
    findByAttr(host, ACCOUNT_MENU_CLOSE_ATTR)!.click();
    expect(onConnectionDiagnosisClosed).toHaveBeenCalledWith(
      diagnosis,
      'dismissed',
    );
    expect(mount.isOpen()).toBe(false);

    expect(mount.openConnectionDiagnosis({
      ...diagnosis,
      id: 'recovery-verification:1700000000000:3',
      profileId: 'p2',
    })).toBe('unavailable');
    expect(mount.isOpen()).toBe(false);
    expect(onConnectionDiagnosisClosed).toHaveBeenCalledTimes(1);

    const displacedDiagnosis = {
      ...diagnosis,
      id: 'recovery-verification:1700000000000:4',
    };
    expect(mount.openConnectionDiagnosis(displacedDiagnosis)).toBe('opened');
    mount.refresh([HOME, OFFICE], 'p2', false, true);
    expect(findByAttr(
      host,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_ATTR,
    )!.hasAttribute('hidden')).toBe(true);
    expect(mount.isOpen()).toBe(true);
    expect(onConnectionDiagnosisClosed).toHaveBeenLastCalledWith(
      displacedDiagnosis,
      'dismissed',
    );

    mount.refresh([HOME, OFFICE], 'p1', false, true);
    const lostDiagnosis = {
      ...diagnosis,
      id: 'recovery-verification:1700000000000:5',
    };
    expect(mount.openConnectionDiagnosis(lostDiagnosis)).toBe('opened');
    mount.refresh([], null, true, false);
    expect(findByAttr(
      host,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_ATTR,
    )!.hasAttribute('hidden')).toBe(true);
    expect(mount.canOpenConnectionDiagnosis('p1')).toBe(false);
    expect(onConnectionDiagnosisClosed).toHaveBeenLastCalledWith(
      lostDiagnosis,
      'dismissed',
    );
  });

  it('does not report a diagnosis outcome through a profile change in flight', async () => {
    let finishSwitch = (): void => undefined;
    const switchInFlight = new Promise<void>((resolve) => {
      finishSwitch = resolve;
    });
    const onConnectionDiagnosisClosed = vi.fn();
    const { host, mount } = setup({
      onConnectionDiagnosisClosed,
      onSwitch: vi.fn(() => switchInFlight),
    });
    const diagnosis = {
      id: 'recovery-verification:1700000000000:5',
      profileId: 'p1',
      profileLabel: 'Home server',
      areaLabel: 'Contracts',
      interruptionReason: 'connection' as const,
    };
    expect(mount.openConnectionDiagnosis(diagnosis)).toBe('opened');
    findAllByAttr(host, SERVER_SWITCHER_ITEM_ATTR)[1]!.click();
    findByAttr(host, SERVER_SWITCHER_SWITCH_COMMIT_ATTR)!.click();

    expect(mount.canOpenConnectionDiagnosis('p1')).toBe(false);
    findByAttr(
      host,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_RETURN_ATTR,
    )!.click();
    expect(mount.isOpen()).toBe(true);
    expect(onConnectionDiagnosisClosed).not.toHaveBeenCalled();
    expect(findByAttr(
      host,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_STATUS_ATTR,
    )!.textContent).toContain('Finish the server profile change');

    finishSwitch();
    await flush();
    expect(mount.isOpen()).toBe(false);
    expect(onConnectionDiagnosisClosed).toHaveBeenCalledWith(
      diagnosis,
      'dismissed',
    );
  });

  it('does not leave Account open when an exact profile is missing or temporarily unavailable', async () => {
    const onClose = vi.fn();
    let finishSwitch = (): void => undefined;
    const switchInFlight = new Promise<void>((resolve) => {
      finishSwitch = resolve;
    });
    const onSwitch = vi.fn(() => switchInFlight);
    const { host, mount } = setup({ onClose, onSwitch });

    expect(mount.openServerProfile('missing-profile')).toBe('missing');
    expect(mount.isOpen()).toBe(false);
    expect(onClose).not.toHaveBeenCalled();

    findByAttr(host, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    findAllByAttr(host, SERVER_SWITCHER_ITEM_ATTR)[1]!.click();
    findByAttr(host, SERVER_SWITCHER_SWITCH_COMMIT_ATTR)!.click();
    expect(mount.canOpenConnectionDiagnosis('p1')).toBe(false);
    expect(mount.openConnectionDiagnosis({
      id: 'recovery-verification:1700000000000:6',
      profileId: 'p1',
      profileLabel: 'Home server',
      areaLabel: 'Contracts',
      interruptionReason: 'ownership',
    })).toBe('unavailable');
    expect(mount.openServerProfile('p2')).toBe('unavailable');
    expect(mount.isOpen()).toBe(false);
    expect(onClose).toHaveBeenCalledOnce();
    finishSwitch();
    await flush();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('exposes the theme slot for the caller to mount into', () => {
    // The toggle itself is the existing shell component; the menu only owns
    // the hole it goes in, so the two can be tested apart.
    const { mount } = setup();
    const slot = mount.themeSlot() as unknown as { hasAttribute(a: string): boolean };
    expect(slot.hasAttribute(ACCOUNT_MENU_THEME_SLOT_ATTR)).toBe(true);
  });

  it('keeps route-independent work discoverable and returns to its exact route', () => {
    const onReturnToWork = vi.fn();
    const { dom, host, mount } = setup({
      activeWork: [{
        id: 'backup-1',
        label: 'Creating a full backup',
        returnHref: '#settings/backup',
        returnLabel: 'View backup progress',
      }],
      onReturnToWork,
    });

    expect(findByAttr(host, ACCOUNT_MENU_BADGE_ATTR)?.getAttribute('data-state'))
      .toBe('working');
    expect(findByAttr(host, ACCOUNT_MENU_TRIGGER_ATTR)?.getAttribute('aria-label'))
      .toContain('1 action needs this server');
    expect(findByAttr(host, ACCOUNT_MENU_ACTIVE_WORK_ATTR)?.hasAttribute('hidden'))
      .toBe(false);
    expect(findByAttr(host, ACCOUNT_MENU_ACTIVE_WORK_ITEM_ATTR)?.children[0]?.textContent)
      .toBe('Creating a full backup');

    const trigger = findByAttr(host, ACCOUNT_MENU_TRIGGER_ATTR)!;
    trigger.click();
    findByAttr(host, ACCOUNT_MENU_ACTIVE_WORK_RETURN_ATTR)!.click();
    expect(onReturnToWork).toHaveBeenCalledWith('#settings/backup');
    expect(mount.isOpen()).toBe(false);
    expect(dom.activeElement()).toBe(trigger);

    mount.setActiveWork([{
      id: 'backup-1',
      label: 'Backup ready to review',
      returnHref: '#settings/backup',
      phase: 'result_ready',
    }]);
    expect(findByAttr(host, ACCOUNT_MENU_BADGE_ATTR)?.getAttribute('data-state'))
      .toBe('result-ready');
    expect(findByAttr(host, ACCOUNT_MENU_TRIGGER_ATTR)?.getAttribute('aria-label'))
      .toContain('1 result is ready on this server');
    expect(findByAttr(host, ACCOUNT_MENU_ACTIVE_WORK_ATTR)?.children[1]?.textContent)
      .toContain('A result is ready');

    mount.setActiveWork([]);
    expect(findByAttr(host, ACCOUNT_MENU_ACTIVE_WORK_ATTR)?.hasAttribute('hidden'))
      .toBe(true);
    expect(findByAttr(host, ACCOUNT_MENU_BADGE_ATTR)?.getAttribute('data-state'))
      .toBe('ok');
  });

  it('guides a server update and keeps it until the exact retry reaches a stable landing', () => {
    const onReturnToWork = vi.fn();
    const { dom, host, mount } = setup({ onReturnToWork });
    const returnHref =
      '#connections/others/retry-credential-rotation/api/github-main';

    mount.openServerUpdateGuide({
      connectionIdentity: 'api/github-main',
      updateHref: '#settings/updates',
      returnHref,
    });

    const guide = findByAttr(host, ACCOUNT_MENU_SERVER_UPDATE_ATTR)!;
    expect(mount.isOpen()).toBe(true);
    expect(guide.hasAttribute('hidden')).toBe(false);
    expect(guide.children[0]?.textContent).toBe('Update this server');
    expect(dom.activeElement()).toBe(guide.children[0]);
    expect(guide.children[1]?.textContent).toContain('api/github-main');
    expect(findByAttr(guide, ACCOUNT_MENU_SERVER_UPDATE_STEPS_ATTR)?.children)
      .toHaveLength(3);
    expect(findByAttr(guide, ACCOUNT_MENU_SERVER_UPDATE_STEPS_ATTR)?.children[0]?.textContent)
      .toContain('home.example:8443');
    expect(findByAttr(guide, ACCOUNT_MENU_SERVER_UPDATE_STATUS_ATTR)?.textContent)
      .toContain('connected');
    expect(guide.children[4]?.textContent).toContain(
      'never keeps or sends a new key',
    );
    expect(findByAttr(host, ACCOUNT_MENU_BADGE_ATTR)?.getAttribute('data-state'))
      .toBe('working');
    expect(findByAttr(host, ACCOUNT_MENU_TRIGGER_ATTR)?.getAttribute('aria-label'))
      .toContain('Server update steps are ready for api/github-main');

    // Closing Account does not lose the externally actionable guide. Opening
    // it again returns focus to the exact update heading, not the dialog root.
    findByAttr(host, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    expect(mount.isOpen()).toBe(false);
    findByAttr(host, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    expect(dom.activeElement()).toBe(guide.children[0]);

    findByAttr(host, ACCOUNT_MENU_SERVER_UPDATE_OPEN_ATTR)!.click();
    expect(onReturnToWork).toHaveBeenNthCalledWith(1, '#settings/updates');
    expect(mount.isOpen()).toBe(false);
    expect(guide.hasAttribute('hidden')).toBe(false);
    expect(findByAttr(host, ACCOUNT_MENU_BADGE_ATTR)?.getAttribute('data-state'))
      .toBe('working');

    findByAttr(host, ACCOUNT_MENU_TRIGGER_ATTR)!.click();

    findByAttr(host, ACCOUNT_MENU_SERVER_UPDATE_RETURN_ATTR)!.click();
    expect(onReturnToWork).toHaveBeenCalledTimes(2);
    expect(onReturnToWork).toHaveBeenNthCalledWith(2, returnHref);
    expect(mount.isOpen()).toBe(false);
    // The router may reject the navigation because another route owns unsaved
    // work. The click alone therefore cannot consume the recovery pointer.
    expect(guide.hasAttribute('hidden')).toBe(false);
    expect(findByAttr(host, ACCOUNT_MENU_BADGE_ATTR)?.getAttribute('data-state'))
      .toBe('working');

    // Bootstrap calls this only once the exact retry reaches a stable landing.
    mount.setServerUpdateGuide(null);
    expect(guide.hasAttribute('hidden')).toBe(true);
    expect(findByAttr(host, ACCOUNT_MENU_BADGE_ATTR)?.getAttribute('data-state'))
      .toBe('ok');
  });

  it('retires the durable server-update guide only on explicit dismissal', () => {
    const onDismissServerUpdateGuide = vi.fn();
    const { host, mount } = setup({ onDismissServerUpdateGuide });
    const guide = {
      connectionIdentity: 'api/github-main',
      updateHref: '#settings/updates',
      returnHref:
        '#connections/others/retry-credential-rotation/api/github-main',
      reloadSafe: false,
    };
    mount.openServerUpdateGuide(guide);

    expect(findByAttr(host, ACCOUNT_MENU_SERVER_UPDATE_ATTR)?.children[4]?.textContent)
      .toMatch(/keep this tab open/i);

    findByAttr(host, ACCOUNT_MENU_SERVER_UPDATE_DISMISS_ATTR)!.click();

    expect(onDismissServerUpdateGuide).toHaveBeenCalledWith(guide);
    expect(findByAttr(host, ACCOUNT_MENU_SERVER_UPDATE_ATTR)?.hasAttribute('hidden'))
      .toBe(true);
    expect(findByAttr(host, ACCOUNT_MENU_BADGE_ATTR)?.getAttribute('data-state'))
      .toBe('ok');
  });

  it('returns focus to the open Account dialog when a live retry settles', () => {
    const { dom, host, mount } = setup();
    mount.openServerUpdateGuide({
      connectionIdentity: 'api/github-main',
      updateHref: '#settings/updates',
      returnHref:
        '#connections/others/retry-credential-rotation/api/github-main',
    });
    expect(dom.activeElement()).toBe(
      findByAttr(host, ACCOUNT_MENU_SERVER_UPDATE_ATTR)?.children[0],
    );

    mount.setServerUpdateGuide(null);

    expect(dom.activeElement()).toBe(
      findByAttr(host, ACCOUNT_MENU_POPOVER_ATTR),
    );
  });

  it('waits for reconnect before Account unlocks an accepted update retry', () => {
    const { host, mount } = setup({ onReturnToWork: vi.fn() });
    const guide = {
      connectionIdentity: 'api/github-main',
      updateHref: '#settings/updates',
      returnHref:
        '#connections/others/retry-credential-rotation/api/github-main',
      phase: 'awaiting_reconnect' as const,
    };
    mount.openServerUpdateGuide(guide);
    const returnButton = findByAttr(
      host,
      ACCOUNT_MENU_SERVER_UPDATE_RETURN_ATTR,
    )!;
    expect(returnButton.hasAttribute('disabled')).toBe(true);
    expect(returnButton.textContent).toMatch(/waiting for server/i);
    expect(returnButton.getAttribute('aria-label')).toMatch(/waiting.*server/i);
    expect(findByAttr(host, ACCOUNT_MENU_SERVER_UPDATE_STATUS_ATTR)?.textContent)
      .toMatch(/waiting.*restart/i);

    mount.setServerUpdateGuide({ ...guide, phase: 'ready' });

    expect(returnButton.hasAttribute('disabled')).toBe(false);
    expect(returnButton.textContent).toBe('Go back and check');
    expect(returnButton.getAttribute('aria-label')).toMatch(/return.*check/i);
    expect(findByAttr(host, ACCOUNT_MENU_SERVER_UPDATE_STATUS_ATTR)?.textContent)
      .toMatch(/the server is back/i);
  });

  it('shows one active exact check, then offers one interruption-safe resume without replaying completion', () => {
    const onReturnToWork = vi.fn();
    const onDismissServerUpdateGuide = vi.fn();
    const { host, mount } = setup({
      onReturnToWork,
      onDismissServerUpdateGuide,
    });
    const guide = {
      connectionIdentity: 'api/github-main',
      updateHref: '#settings/updates',
      returnHref:
        '#connections/others/retry-credential-rotation/api/github-main',
      phase: 'checking_return' as const,
      exactReturnActive: true as const,
      serverUpdateVerification: {
        phase: 'completed' as const,
        operation: 'update' as const,
        startedAt: 100,
        reason: 'server_closed_unresolved' as const,
        baseline: {
          currentVersion: '26.8.1',
          channel: 'stable' as const,
          updateStatus: 'up-to-date' as const,
          affectedConnection: {
            kind: 'api' as const,
            name: 'github-main',
            activity: 'idle' as const,
          },
        },
      },
    };
    mount.setServerUpdateGuide(guide);

    const section = findByAttr(host, ACCOUNT_MENU_SERVER_UPDATE_ATTR)!;
    const returnButton = findByAttr(
      section,
      ACCOUNT_MENU_SERVER_UPDATE_RETURN_ATTR,
    )!;
    const dismissButton = findByAttr(
      section,
      ACCOUNT_MENU_SERVER_UPDATE_DISMISS_ATTR,
    )!;
    const openButton = findByAttr(
      section,
      ACCOUNT_MENU_SERVER_UPDATE_OPEN_ATTR,
    )!;
    expect(section.children[0]?.textContent).toBe(
      'Checking the key',
    );
    expect(section.getAttribute('aria-busy')).toBe('true');
    expect(subtreeText(section)).toMatch(
      /another key is already being replaced/i,
    );
    expect(subtreeText(section)).not.toMatch(/recovery finished/i);
    expect(returnButton.textContent).toBe('Checking…');
    expect(returnButton.hasAttribute('disabled')).toBe(true);
    expect(dismissButton.hasAttribute('disabled')).toBe(true);
    expect(openButton.hasAttribute('hidden')).toBe(true);
    expect(findByAttr(host, ACCOUNT_MENU_BADGE_ATTR)?.getAttribute('data-state'))
      .toBe('working');
    returnButton.click();
    dismissButton.click();
    openButton.click();
    expect(onReturnToWork).not.toHaveBeenCalled();
    expect(onDismissServerUpdateGuide).not.toHaveBeenCalled();

    const {
      exactReturnActive: _active,
      serverUpdateVerification: _completion,
      ...interrupted
    } = guide;
    mount.setServerUpdateGuide(interrupted);

    expect(section.children[0]?.textContent).toBe(
      'Carry on checking the key',
    );
    expect(section.hasAttribute('aria-busy')).toBe(false);
    expect(subtreeText(section)).toMatch(
      /stopped before Recued finished its checks/i,
    );
    expect(subtreeText(section)).toMatch(
      /carries over no keys, nothing you typed, and no results/i,
    );
    expect(returnButton.textContent).toBe('Carry on checking');
    expect(returnButton.hasAttribute('disabled')).toBe(false);
    expect(openButton.hasAttribute('hidden')).toBe(true);
    expect(returnButton.getAttribute('aria-label')).toMatch(
      /carry on the key check for api\/github-main/i,
    );
    expect(findByAttr(host, ACCOUNT_MENU_BADGE_ATTR)?.getAttribute('data-state'))
      .toBe('result-ready');
    expect(findByAttr(host, ACCOUNT_MENU_TRIGGER_ATTR)?.getAttribute('aria-label'))
      .toMatch(/key check that was stopped can carry on/i);

    openButton.click();
    expect(onReturnToWork).not.toHaveBeenCalled();
    returnButton.click();
    expect(onReturnToWork).toHaveBeenCalledOnce();
    expect(onReturnToWork).toHaveBeenCalledWith(guide.returnHref);
    mount.dispose();
  });

  it('offers one target-only clean-editor resume and hides stale update actions', () => {
    const onReturnToWork = vi.fn();
    const { host, mount } = setup({ onReturnToWork });
    const returnHref =
      '#connections/others/retry-credential-rotation/api/github-main';
    mount.setServerUpdateGuide({
      connectionIdentity: 'api/github-main',
      updateHref: '#settings/updates',
      returnHref,
      phase: 'editor_ready',
      reloadSafe: true,
      serverUpdateVerification: {
        phase: 'completed',
        operation: 'update',
        startedAt: 100,
        reason: 'server_closed_unresolved',
      },
    });

    const section = findByAttr(host, ACCOUNT_MENU_SERVER_UPDATE_ATTR)!;
    const returnButton = findByAttr(
      section,
      ACCOUNT_MENU_SERVER_UPDATE_RETURN_ATTR,
    )!;
    const openButton = findByAttr(
      section,
      ACCOUNT_MENU_SERVER_UPDATE_OPEN_ATTR,
    )!;
    expect(section.children[0]?.textContent)
      .toBe('Carry on replacing the key');
    expect(section.hasAttribute('aria-busy')).toBe(false);
    expect(subtreeText(section)).toMatch(
      /fresh key editor.*closed before any field changed/i,
    );
    expect(subtreeText(section)).toMatch(
      /repeat.*activity.*latest-saved-connection checks/i,
    );
    expect(subtreeText(section)).toMatch(
      /nothing you typed, no keys, and no results are kept/i,
    );
    expect(subtreeText(section)).not.toMatch(/recovery finished/i);
    expect(returnButton.textContent).toBe('Reopen the fresh editor');
    expect(returnButton.getAttribute('aria-label')).toMatch(
      /reopen the fresh key editor.*running its safety check again/i,
    );
    expect(findByAttr(
      section,
      ACCOUNT_MENU_SERVER_UPDATE_DISMISS_ATTR,
    )?.textContent).toBe('Dismiss');
    expect(openButton.hasAttribute('hidden')).toBe(true);
    expect(findByAttr(host, ACCOUNT_MENU_BADGE_ATTR)?.getAttribute('data-state'))
      .toBe('result-ready');
    expect(findByAttr(host, ACCOUNT_MENU_TRIGGER_ATTR)?.getAttribute('aria-label'))
      .toMatch(/fresh key editor is ready to reopen/i);

    openButton.click();
    expect(onReturnToWork).not.toHaveBeenCalled();
    returnButton.click();
    expect(onReturnToWork).toHaveBeenCalledOnce();
    expect(onReturnToWork).toHaveBeenCalledWith(returnHref);
    mount.dispose();
  });

  it('makes Account a source-neutral passive observer during a server change', () => {
    const onReturnToWork = vi.fn();
    const onDismissServerUpdateGuide = vi.fn();
    const { host, mount } = setup({
      onReturnToWork,
      onDismissServerUpdateGuide,
    });
    const base = {
      connectionIdentity: 'api/github-main',
      updateHref: '#settings/updates',
      returnHref:
        '#connections/others/retry-credential-rotation/api/github-main',
      phase: 'triage' as const,
    };
    mount.setServerUpdateGuide({
      ...base,
      serverUpdateProgress: {
        phase: 'applying',
        operation: 'update',
        startedAt: 100,
      },
    });

    const section = findByAttr(host, ACCOUNT_MENU_SERVER_UPDATE_ATTR)!;
    expect(section.getAttribute('aria-busy')).toBe('true');
    expect(section.children[0]?.textContent).toBe(
      'Server update in progress',
    );
    expect(section.children[1]?.textContent).toMatch(
      /open Recued tab.*without sending a duplicate action/i,
    );
    expect(findByAttr(
      section,
      ACCOUNT_MENU_SERVER_UPDATE_STATUS_ATTR,
    )?.textContent).toMatch(/in another open Recued tab/i);
    const updatesButton = findByAttr(
      section,
      ACCOUNT_MENU_SERVER_UPDATE_OPEN_ATTR,
    )!;
    expect(updatesButton.hasAttribute('hidden')).toBe(false);
    expect(updatesButton.textContent).toBe('View Server Updates');
    expect(updatesButton.getAttribute('aria-label')).toMatch(
      /see the shared server update progress/i,
    );
    const returnButton = findByAttr(
      section,
      ACCOUNT_MENU_SERVER_UPDATE_RETURN_ATTR,
    )!;
    const dismissButton = findByAttr(
      section,
      ACCOUNT_MENU_SERVER_UPDATE_DISMISS_ATTR,
    )!;
    expect(returnButton.hasAttribute('disabled')).toBe(true);
    expect(dismissButton.hasAttribute('disabled')).toBe(true);
    expect(section.children[4]?.textContent).toMatch(
      /meaningless code for the server.*never share keys.*addresses.*error details/i,
    );

    // Inspecting the passive progress is safe, while credential continuation
    // and dismissal remain blocked even for scripted events.
    updatesButton.click();
    returnButton.click();
    dismissButton.click();
    expect(onReturnToWork).toHaveBeenCalledOnce();
    expect(onReturnToWork).toHaveBeenCalledWith('#settings/updates');
    expect(onDismissServerUpdateGuide).not.toHaveBeenCalled();

    mount.setServerUpdateGuide({
      ...base,
      serverUpdateProgress: {
        phase: 'awaiting_reconnect',
        operation: 'update',
        startedAt: 100,
        operationId: 'server-ledger-receipt',
      },
    });
    expect(section.children[0]?.textContent).toMatch(
      /checking update result/i,
    );
    expect(findByAttr(
      section,
      ACCOUNT_MENU_SERVER_UPDATE_STATUS_ATTR,
    )?.textContent).toMatch(
      /accepted.*checking what the server said about restarting/i,
    );

    mount.setServerUpdateGuide(base);
    expect(section.hasAttribute('aria-busy')).toBe(false);
    expect(findByAttr(
      section,
      ACCOUNT_MENU_SERVER_UPDATE_OPEN_ATTR,
    )?.hasAttribute('hidden')).toBe(false);
    expect(dismissButton.hasAttribute('disabled')).toBe(false);
  });

  it('keeps an unknown receipt paused with explicit retry and a safe diagnostic', async () => {
    const onRetryServerUpdateReceipt = vi.fn();
    const serverUpdateDiagnosticWriter = vi.fn(async () => undefined);
    const { host, mount } = setup({
      onRetryServerUpdateReceipt,
      serverUpdateDiagnosticWriter,
    });
    const guide = {
      connectionIdentity: 'api/github-main',
      updateHref: '#settings/updates',
      returnHref:
        '#connections/others/retry-credential-rotation/api/github-main',
      phase: 'triage',
      serverUpdateProgress: {
        phase: 'awaiting_reconnect',
        operation: 'update',
        startedAt: 100,
        operationId: 'opaque-receipt-never-render',
      },
      serverUpdateVerification: {
        phase: 'unknown',
        operation: 'update',
        startedAt: 100,
        reason: 'unknown_receipt',
      },
    } as const;
    mount.setServerUpdateGuide(guide);

    const guideEl = findByAttr(host, ACCOUNT_MENU_SERVER_UPDATE_ATTR)!;
    expect(guideEl.getAttribute('aria-busy')).toBeNull();
    expect(guideEl.children[0]?.textContent).toMatch(/result needs a look/i);
    expect(findByAttr(guideEl, ACCOUNT_MENU_SERVER_UPDATE_STATUS_ATTR)?.textContent)
      .toMatch(/did not know about/i);
    const retry = findByAttr(
      guideEl,
      ACCOUNT_MENU_SERVER_UPDATE_RETRY_ATTR,
    )!;
    expect(retry.hasAttribute('hidden')).toBe(false);
    expect(retry.hasAttribute('disabled')).toBe(false);
    retry.click();
    expect(onRetryServerUpdateReceipt).toHaveBeenCalledOnce();

    const diagnostic = findByAttr(
      guideEl,
      ACCOUNT_MENU_SERVER_UPDATE_DIAGNOSTIC_ATTR,
    )!;
    const summary = findByAttr(
      diagnostic,
      ACCOUNT_MENU_SERVER_UPDATE_DIAGNOSTIC_SUMMARY_ATTR,
    )?.textContent ?? '';
    expect(summary).toContain('home.example:8443');
    expect(summary).toMatch(/selected server did not recognize receipt/i);
    expect(summary).not.toMatch(/opaque-receipt-never-render|\/ws/i);
    findByAttr(
      diagnostic,
      ACCOUNT_MENU_SERVER_UPDATE_DIAGNOSTIC_COPY_ATTR,
    )?.click();
    await flush();
    expect(serverUpdateDiagnosticWriter).toHaveBeenCalledWith(summary);
    expect(findByAttr(host, ACCOUNT_MENU_TRIGGER_ATTR)?.getAttribute('aria-label'))
      .toMatch(/result needs a look/i);

    mount.setServerUpdateGuide({
      ...guide,
      serverUpdateVerification: {
        phase: 'checking',
        operation: 'update',
        startedAt: 100,
      },
    });
    expect(retry.hasAttribute('hidden')).toBe(false);
    expect(retry.hasAttribute('disabled')).toBe(true);
    expect(retry.textContent).toBe('Checking the result…');
    mount.dispose();
  });

  it('carries server-authored unresolved closure into Account and finishes only that latch', () => {
    const onRetryServerUpdateReceipt = vi.fn();
    const onFinishServerUpdateReceiptClosure = vi.fn();
    const onReturnToWork = vi.fn();
    const { host, mount } = setup({
      onRetryServerUpdateReceipt,
      onFinishServerUpdateReceiptClosure,
      onReturnToWork,
    });
    const base = {
      connectionIdentity: 'api/github-main',
      updateHref: '#settings/updates',
      returnHref:
        '#connections/others/retry-credential-rotation/api/github-main',
      phase: 'triage',
      serverUpdateProgress: {
        phase: 'awaiting_reconnect',
        operation: 'rollback',
        startedAt: 100,
        operationId: 'opaque-receipt-never-render',
      },
    } as const;

    mount.setServerUpdateGuide({
      ...base,
      serverUpdateVerification: {
        phase: 'reviewing_closure',
        operation: 'rollback',
        startedAt: 100,
        reason: 'unknown_receipt',
      },
    });
    const guide = findByAttr(host, ACCOUNT_MENU_SERVER_UPDATE_ATTR)!;
    expect(guide.children[0]?.textContent).toMatch(/closing this unanswered/i);
    expect(subtreeText(guide)).toMatch(/nothing is written down until you say so/i);
    expect(findByAttr(
      guide,
      ACCOUNT_MENU_SERVER_UPDATE_OPEN_ATTR,
    )?.textContent).toBe('Back to closing this');

    mount.setServerUpdateGuide({
      ...base,
      serverUpdateVerification: {
        phase: 'closed',
        operation: 'rollback',
        startedAt: 100,
        reason: 'server_closed_unresolved',
      },
    });
    expect(guide.children[0]?.textContent).toMatch(
      /closed.*check how things are/i,
    );
    expect(findByAttr(
      guide,
      ACCOUNT_MENU_SERVER_UPDATE_STATUS_ATTR,
    )?.textContent).toMatch(/closed this without an answer.*still unclear/i);
    const finish = findByAttr(
      guide,
      ACCOUNT_MENU_SERVER_UPDATE_RETRY_ATTR,
    )!;
    expect(finish.textContent).toBe('Check how the server is');
    expect(finish.hasAttribute('disabled')).toBe(false);
    finish.click();
    expect(onFinishServerUpdateReceiptClosure).toHaveBeenCalledOnce();
    expect(onRetryServerUpdateReceipt).not.toHaveBeenCalled();

    mount.refresh([HOME, OFFICE], 'p1', true, false);
    expect(finish.textContent).toBe('Confirm when connected');
    expect(finish.hasAttribute('disabled')).toBe(true);

    mount.setServerUpdateGuide({
      ...base,
      serverUpdateVerification: {
        phase: 'baseline_confirmed',
        operation: 'rollback',
        startedAt: 100,
        reason: 'server_closed_unresolved',
        baseline: {
          currentVersion: '26.8.1',
          channel: 'stable',
          updateStatus: 'up-to-date',
          affectedConnection: {
            kind: 'api',
            name: 'github-main',
            activity: 'pending',
          },
        },
      },
    });
    expect(guide.children[0]?.textContent).toMatch(
      /checked how the server is/i,
    );
    expect(findByAttr(
      guide,
      ACCOUNT_MENU_SERVER_UPDATE_STATUS_ATTR,
    )?.textContent).toMatch(
      /running 26\.8\.1.*stable.*this is the newest version.*github-main.*pending.*original rollback result is still unknown/i,
    );
    expect(finish.textContent).toBe(
      'Finish and go back to api/github-main',
    );
    // The server read already completed. Retiring the exact local latch remains
    // available during a later network blip and cannot send another mutation.
    expect(finish.hasAttribute('disabled')).toBe(false);
    finish.click();
    expect(onFinishServerUpdateReceiptClosure).toHaveBeenCalledTimes(2);
    expect(findByAttr(
      host,
      ACCOUNT_MENU_TRIGGER_ATTR,
    )?.getAttribute('aria-label')).toMatch(/current server state is confirmed/i);
    expect(subtreeText(guide)).not.toMatch(/opaque-receipt-never-render/i);

    mount.setServerUpdateGuide({
      ...base,
      serverUpdateVerification: {
        phase: 'baseline_confirmed',
        operation: 'rollback',
        startedAt: 100,
        reason: 'finish_unavailable',
        baseline: {
          currentVersion: '26.8.1',
          channel: 'stable',
          updateStatus: 'up-to-date',
          affectedConnection: {
            kind: 'api',
            name: 'github-main',
            activity: 'pending',
          },
        },
      },
    });
    expect(guide.children[0]?.textContent).toMatch(
      /checked. finishing needs another go/i,
    );
    expect(finish.textContent).toBe(
      'Try finishing again and go back to api/github-main',
    );
    expect(subtreeText(guide)).toMatch(
      /browser could not finish tidying up.*nothing is sent to the server twice/i,
    );
    finish.click();
    expect(onFinishServerUpdateReceiptClosure).toHaveBeenCalledTimes(3);

    mount.setServerUpdateGuide({
      ...base,
      serverUpdateVerification: {
        phase: 'finishing',
        operation: 'rollback',
        startedAt: 100,
        reason: 'server_closed_unresolved',
      },
    });
    expect(finish.textContent).toBe('Finishing up…');
    expect(finish.hasAttribute('disabled')).toBe(true);
    mount.refresh([HOME, OFFICE], 'p1', false, true);

    const {
      serverUpdateProgress: _retiredProgress,
      ...completionBase
    } = base;
    mount.setServerUpdateGuide({
      ...completionBase,
      phase: 'ready',
      serverUpdateVerification: {
        phase: 'completed',
        operation: 'rollback',
        startedAt: 100,
        reason: 'server_closed_unresolved',
        baseline: {
          currentVersion: '26.8.1',
          channel: 'stable',
          updateStatus: 'up-to-date',
          affectedConnection: {
            kind: 'api',
            name: 'github-main',
            activity: 'pending',
          },
        },
      },
    });
    expect(onReturnToWork).toHaveBeenCalledOnce();
    expect(onReturnToWork).toHaveBeenCalledWith(
      '#connections/others/retry-credential-rotation/api/github-main',
    );
    expect(guide.children[0]?.textContent).toMatch(
      /all sorted.*back to work/i,
    );
    expect(subtreeText(guide)).toMatch(/server controls work again/i);
    expect(subtreeText(guide)).toMatch(/running 26\.8\.1/i);
    expect(subtreeText(guide)).toMatch(/new safety check/i);
    expect(subtreeText(guide)).toMatch(/one-off note.*gone after a reload/is);
    expect(finish.hasAttribute('hidden')).toBe(true);
    expect(findByAttr(
      guide,
      ACCOUNT_MENU_SERVER_UPDATE_RETURN_ATTR,
    )?.textContent).toBe('Return to api/github-main');
    expect(findByAttr(
      host,
      ACCOUNT_MENU_TRIGGER_ATTR,
    )?.getAttribute('aria-label')).toMatch(
      /server recovery is finished.*return is ready/i,
    );
    mount.dispose();
  });

  it('keeps a passively observed completion explicit instead of auto-routing', () => {
    const onReturnToWork = vi.fn();
    const { host, mount } = setup({ onReturnToWork });
    mount.setServerUpdateGuide({
      connectionIdentity: 'api/github-main',
      updateHref: '#settings/updates',
      returnHref:
        '#connections/others/retry-credential-rotation/api/github-main',
      phase: 'ready',
      serverUpdateVerification: {
        phase: 'completed',
        operation: 'update',
        startedAt: 100,
        reason: 'server_closed_unresolved',
        baseline: {
          currentVersion: '26.8.1',
          channel: 'stable',
          updateStatus: 'up-to-date',
          affectedConnection: {
            kind: 'api',
            name: 'github-main',
            activity: 'idle',
          },
        },
      },
    });

    expect(onReturnToWork).not.toHaveBeenCalled();
    const guide = findByAttr(host, ACCOUNT_MENU_SERVER_UPDATE_ATTR)!;
    const exactReturn = findByAttr(
      guide,
      ACCOUNT_MENU_SERVER_UPDATE_RETURN_ATTR,
    )!;
    expect(exactReturn.textContent).toBe('Return to api/github-main');
    exactReturn.click();
    expect(onReturnToWork).toHaveBeenCalledOnce();
    expect(onReturnToWork).toHaveBeenCalledWith(
      '#connections/others/retry-credential-rotation/api/github-main',
    );
    mount.dispose();
  });

  it('turns a repeated unsupported result into selected-profile triage instead of replaying the guide', async () => {
    const onReturnToWork = vi.fn();
    const serverUpdateDiagnosticWriter = vi.fn(async () => undefined);
    const { host, mount } = setup({
      onReturnToWork,
      serverUpdateDiagnosticWriter,
    });
    mount.openServerUpdateGuide({
      connectionIdentity: 'api/github-main',
      updateHref: '#settings/updates',
      returnHref:
        '#connections/others/retry-credential-rotation/api/github-main',
      phase: 'triage',
      serverUpdateTriage: {
        reason: 'running_version_changed',
        checkStatus: 'up-to-date',
        baselineVersion: '26.7.3',
        currentVersion: '26.8.0',
        channel: 'stable',
      },
    });

    const guide = findByAttr(host, ACCOUNT_MENU_SERVER_UPDATE_ATTR)!;
    expect(guide.children[0]?.textContent).toBe('A server update needs a look');
    expect(guide.children[1]?.textContent).toContain('home.example:8443');
    expect(findByAttr(guide, ACCOUNT_MENU_SERVER_UPDATE_STATUS_ATTR)?.textContent)
      .toContain('Running 26.8.0');
    expect(findByAttr(guide, ACCOUNT_MENU_SERVER_UPDATE_STATUS_ATTR)?.textContent)
      .toContain('before update: 26.7.3');
    expect(findByAttr(guide, ACCOUNT_MENU_SERVER_UPDATE_STEPS_ATTR)?.children[1]?.textContent)
      .toMatch(/version changed.*whole update/i);
    expect(findByAttr(guide, ACCOUNT_MENU_SERVER_UPDATE_OPEN_ATTR)?.textContent)
      .toBe('See how the update is going');
    expect(findByAttr(guide, ACCOUNT_MENU_SERVER_UPDATE_RETURN_ATTR)?.textContent)
      .toBe('Check the server again');
    expect(findByAttr(host, ACCOUNT_MENU_TRIGGER_ATTR)?.getAttribute('aria-label'))
      .toContain('Server update diagnosis is ready for api/github-main');
    const diagnostic = findByAttr(
      guide,
      ACCOUNT_MENU_SERVER_UPDATE_DIAGNOSTIC_ATTR,
    )!;
    expect(diagnostic.hasAttribute('hidden')).toBe(false);
    const summary = findByAttr(
      diagnostic,
      ACCOUNT_MENU_SERVER_UPDATE_DIAGNOSTIC_SUMMARY_ATTR,
    )?.textContent ?? '';
    expect(summary).toContain('Server host: home.example:8443');
    expect(summary).toContain(
      'Missing feature: collection.connection.credentialRotationActivity',
    );
    expect(summary).not.toContain('/ws');
    expect(summary).not.toMatch(/token|credential value|config\.base_url/i);
    findByAttr(
      diagnostic,
      ACCOUNT_MENU_SERVER_UPDATE_DIAGNOSTIC_COPY_ATTR,
    )!.click();
    await flush();
    expect(serverUpdateDiagnosticWriter).toHaveBeenCalledWith(summary);
    expect(findByAttr(
      diagnostic,
      ACCOUNT_MENU_SERVER_UPDATE_DIAGNOSTIC_STATUS_ATTR,
    )?.textContent).toMatch(/safe diagnostic copied/i);

    findByAttr(guide, ACCOUNT_MENU_SERVER_UPDATE_RETURN_ATTR)!.click();
    expect(onReturnToWork).toHaveBeenCalledWith(
      '#connections/others/retry-credential-rotation/api/github-main',
    );
    expect(guide.hasAttribute('hidden')).toBe(false);
  });

  it('presents a freshly confirmed capability as a one-shot result without leaving the current route', () => {
    const onReturnToWork = vi.fn();
    const onResumeServerUpdateGuide = vi.fn();
    const onDismissServerUpdateGuide = vi.fn();
    const { host, mount } = setup({
      onReturnToWork,
      onResumeServerUpdateGuide,
      onDismissServerUpdateGuide,
    });
    const guide = {
      connectionIdentity: 'api/github-main',
      updateHref: '#settings/updates',
      returnHref:
        '#connections/others/retry-credential-rotation/api/github-main',
      reloadSafe: false,
      phase: 'resolved_elsewhere' as const,
    };

    mount.setServerUpdateGuide(guide);

    const section = findByAttr(host, ACCOUNT_MENU_SERVER_UPDATE_ATTR)!;
    expect(section.children[0]?.textContent).toBe(
      'The key check is ready',
    );
    expect(section.children[1]?.textContent).toMatch(
      /look-only check says.*home\.example:8443/i,
    );
    expect(findByAttr(
      section,
      ACCOUNT_MENU_SERVER_UPDATE_STATUS_ATTR,
    )?.textContent).toMatch(/look-only question to the server.*did not move/i);
    expect(findByAttr(
      section,
      ACCOUNT_MENU_SERVER_UPDATE_STEPS_ATTR,
    )?.children[1]?.textContent).toMatch(
      /never read, kept, or sent a key/i,
    );
    expect(section.children[4]?.textContent).toMatch(
      /kept only in this tab and is gone after a reload/i,
    );
    expect(findByAttr(
      section,
      ACCOUNT_MENU_SERVER_UPDATE_OPEN_ATTR,
    )?.hasAttribute('hidden')).toBe(true);
    expect(findByAttr(
      section,
      ACCOUNT_MENU_SERVER_UPDATE_DIAGNOSTIC_ATTR,
    )?.hasAttribute('hidden')).toBe(true);
    const continueButton = findByAttr(
      section,
      ACCOUNT_MENU_SERVER_UPDATE_RETURN_ATTR,
    )!;
    expect(continueButton.textContent).toBe('Continue in this tab');
    expect(continueButton.getAttribute('aria-label')).toMatch(
      /carry on checking the new key for api\/github-main/i,
    );
    expect(findByAttr(host, ACCOUNT_MENU_BADGE_ATTR)?.getAttribute('data-state'))
      .toBe('result-ready');
    expect(findByAttr(host, ACCOUNT_MENU_TRIGGER_ATTR)?.getAttribute('aria-label'))
      .toContain('The key check is ready for api/github-main');
    expect(onReturnToWork).not.toHaveBeenCalled();

    continueButton.click();
    expect(onResumeServerUpdateGuide).toHaveBeenCalledWith(guide);
    expect(onReturnToWork).toHaveBeenCalledWith(guide.returnHref);
    expect(onResumeServerUpdateGuide.mock.invocationCallOrder[0])
      .toBeLessThan(onReturnToWork.mock.invocationCallOrder[0]!);
    expect(section.hasAttribute('hidden')).toBe(false);

    mount.open();
    findByAttr(section, ACCOUNT_MENU_SERVER_UPDATE_DISMISS_ATTR)!.click();
    expect(onDismissServerUpdateGuide).toHaveBeenCalledWith(guide);
    expect(section.hasAttribute('hidden')).toBe(true);
  });

  it('builds the admin handoff from allowlisted fields only', () => {
    const summary = buildAccountServerUpdateDiagnostic({
      connectionIdentity: 'api/github-main',
      profileLabel: 'Home\nserver',
      serverUrl:
        'wss://home.example:8443/private/path?token=must-not-leak#secret',
      triage: {
        reason: 'self_update_unavailable',
        checkStatus: 'not-configured',
        currentVersion: '26.7.3',
        channel: 'stable',
      },
    });
    expect(summary).toContain('Server you picked: Home server');
    expect(summary).toContain('Server host: home.example:8443');
    expect(summary).not.toContain('/private/path');
    expect(summary).not.toContain('must-not-leak');
    expect(summary).not.toContain('#secret');
  });

  it('makes a bad release signature a stop-and-correct step', () => {
    const { host, mount } = setup({ onReturnToWork: vi.fn() });
    mount.openServerUpdateGuide({
      connectionIdentity: 'api/github-main',
      updateHref: '#settings/updates',
      returnHref:
        '#connections/others/retry-credential-rotation/api/github-main',
      phase: 'triage',
      serverUpdateTriage: {
        reason: 'release_check_inconclusive',
        checkStatus: 'bad-signature',
        baselineVersion: '26.7.3',
        currentVersion: '26.7.3',
        channel: 'stable',
      },
    });

    const guide = findByAttr(host, ACCOUNT_MENU_SERVER_UPDATE_ATTR)!;
    expect(findByAttr(guide, ACCOUNT_MENU_SERVER_UPDATE_STEPS_ATTR)?.children[1]?.textContent)
      .toMatch(/do not install.*trusted update key.*signature/i);
    expect(findByAttr(guide, ACCOUNT_MENU_SERVER_UPDATE_STATUS_ATTR)?.textContent)
      .toMatch(/update check: bad signature/i);
  });

  it('falls back to manual diagnostic copy when the clipboard throws synchronously', () => {
    const { dom, host, mount } = setup({
      onReturnToWork: vi.fn(),
      serverUpdateDiagnosticWriter: () => {
        throw new Error('clipboard denied');
      },
    });
    mount.openServerUpdateGuide({
      connectionIdentity: 'api/github-main',
      updateHref: '#settings/updates',
      returnHref:
        '#connections/others/retry-credential-rotation/api/github-main',
      phase: 'triage',
      serverUpdateTriage: {
        reason: 'current_build_missing_capability',
        checkStatus: 'up-to-date',
        currentVersion: '26.8.0',
        channel: 'stable',
      },
    });

    const copy = findByAttr(
      host,
      ACCOUNT_MENU_SERVER_UPDATE_DIAGNOSTIC_COPY_ATTR,
    )!;
    copy.click();

    const summary = findByAttr(
      host,
      ACCOUNT_MENU_SERVER_UPDATE_DIAGNOSTIC_SUMMARY_ATTR,
    )!;
    expect(copy.hasAttribute('disabled')).toBe(false);
    expect(copy.textContent).toBe('Copy the details');
    expect(findByAttr(
      host,
      ACCOUNT_MENU_SERVER_UPDATE_DIAGNOSTIC_STATUS_ATTR,
    )?.textContent).toMatch(/could not copy it/i);
    expect(dom.activeElement()).toBe(summary);
  });

  it('does not let an older diagnostic copy receipt steal exact diagnosis focus', async () => {
    let finishCopy: () => void = () => undefined;
    const serverUpdateDiagnosticWriter = vi.fn(() => new Promise<void>(
      (resolve) => {
        finishCopy = resolve;
      },
    ));
    const { dom, host, mount } = setup({
      onReturnToWork: vi.fn(),
      serverUpdateDiagnosticWriter,
    });
    mount.openServerUpdateGuide({
      connectionIdentity: 'api/github-main',
      updateHref: '#settings/updates',
      returnHref:
        '#connections/others/retry-credential-rotation/api/github-main',
      phase: 'triage',
      serverUpdateTriage: {
        reason: 'current_build_missing_capability',
        checkStatus: 'up-to-date',
        currentVersion: '26.8.0',
        channel: 'stable',
      },
    });
    findByAttr(
      host,
      ACCOUNT_MENU_SERVER_UPDATE_DIAGNOSTIC_COPY_ATTR,
    )!.click();
    expect(mount.openConnectionDiagnosis({
      id: 'recovery-verification:1700000000000:7',
      profileId: 'p1',
      profileLabel: 'Home server',
      areaLabel: 'Contracts',
      interruptionReason: 'connection',
    })).toBe('opened');
    const diagnosisTitle = findByAttr(
      host,
      ACCOUNT_MENU_CONNECTION_DIAGNOSIS_TITLE_ATTR,
    )!;
    expect(dom.activeElement()).toBe(diagnosisTitle);

    finishCopy();
    await flush();
    expect(findByAttr(
      host,
      ACCOUNT_MENU_SERVER_UPDATE_DIAGNOSTIC_STATUS_ATTR,
    )!.textContent).toMatch(/safe diagnostic copied/i);
    expect(dom.activeElement()).toBe(diagnosisTitle);
  });

  it('does not report an old diagnostic as copied after profile hydration changes it', async () => {
    let finishCopy: () => void = () => undefined;
    const serverUpdateDiagnosticWriter = vi.fn(() => new Promise<void>(
      (resolve) => {
        finishCopy = resolve;
      },
    ));
    const { host, mount } = setup({
      onReturnToWork: vi.fn(),
      serverUpdateDiagnosticWriter,
    });
    mount.openServerUpdateGuide({
      connectionIdentity: 'api/github-main',
      updateHref: '#settings/updates',
      returnHref:
        '#connections/others/retry-credential-rotation/api/github-main',
      phase: 'triage',
      serverUpdateTriage: {
        reason: 'current_build_missing_capability',
        checkStatus: 'up-to-date',
        currentVersion: '26.8.0',
        channel: 'stable',
      },
    });
    const copy = findByAttr(
      host,
      ACCOUNT_MENU_SERVER_UPDATE_DIAGNOSTIC_COPY_ATTR,
    )!;
    copy.click();
    expect(copy.hasAttribute('disabled')).toBe(true);

    mount.refresh([{
      ...HOME,
      label: 'Renamed home',
      server_url: 'wss://renamed.example:9443/ws',
    }, OFFICE], 'p1');

    const summary = findByAttr(
      host,
      ACCOUNT_MENU_SERVER_UPDATE_DIAGNOSTIC_SUMMARY_ATTR,
    )?.textContent ?? '';
    expect(summary).toContain('Server you picked: Renamed home');
    expect(summary).toContain('Server host: renamed.example:9443');
    expect(copy.hasAttribute('disabled')).toBe(false);
    expect(findByAttr(
      host,
      ACCOUNT_MENU_SERVER_UPDATE_DIAGNOSTIC_STATUS_ATTR,
    )?.textContent).toBe('');

    finishCopy();
    await flush();
    expect(findByAttr(
      host,
      ACCOUNT_MENU_SERVER_UPDATE_DIAGNOSTIC_STATUS_ATTR,
    )?.textContent).toBe('');
  });

  it('preserves focus when live work metadata repaints an open menu', () => {
    const { dom, host, mount } = setup({
      activeWork: [{
        id: 'backup-1',
        label: 'Creating a full backup',
        returnHref: '#settings/backup',
      }],
      onReturnToWork: vi.fn(),
    });
    findByAttr(host, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    const original = findByAttr(host, ACCOUNT_MENU_ACTIVE_WORK_RETURN_ATTR)!;
    original.focus();

    mount.setActiveWork([{
      id: 'backup-1',
      label: 'Backup ready to review',
      returnHref: '#settings/backup',
      phase: 'result_ready',
    }]);
    const replacement = findByAttr(host, ACCOUNT_MENU_ACTIVE_WORK_RETURN_ATTR)!;
    expect(replacement).not.toBe(original);
    expect(dom.activeElement()).toBe(replacement);

    mount.setActiveWork([]);
    expect(dom.activeElement()).toBe(findByAttr(host, ACCOUNT_MENU_POPOVER_ATTR));
  });

  describe('the unreachable badge', () => {
    it('is hidden while the server is reachable', () => {
      const { host } = setup();
      const badge = findByAttr(host, ACCOUNT_MENU_BADGE_ATTR)!;
      expect(badge.getAttribute('data-state')).toBe('ok');
      expect(findByAttr(host, ACCOUNT_MENU_TRIGGER_ATTR)!.getAttribute('aria-label'))
        .toBe('Your account and servers');
    });

    it('shows, and SAYS SO, when the server is unreachable', () => {
      // The badge is decorative; the state has to reach a screen reader
      // through the trigger's name, or the cue is sighted-only.
      const { host } = setup({ unreachable: true });
      const badge = findByAttr(host, ACCOUNT_MENU_BADGE_ATTR)!;
      expect(badge.getAttribute('data-state')).toBe('unreachable');
      expect(badge.getAttribute('aria-hidden')).toBe('true');
      const trigger = findByAttr(host, ACCOUNT_MENU_TRIGGER_ATTR)!;
      expect(trigger.getAttribute('aria-label')).toContain('cannot reach this server');
      expect(trigger.getAttribute('title')).toContain('cannot reach this server');
    });

    it('flips live with the connection status', () => {
      const { host, mount } = setup();
      mount.setUnreachable(true);
      expect(findByAttr(host, ACCOUNT_MENU_BADGE_ATTR)!.getAttribute('data-state'))
        .toBe('unreachable');
      mount.setUnreachable(false);
      expect(findByAttr(host, ACCOUNT_MENU_BADGE_ATTR)!.getAttribute('data-state'))
        .toBe('ok');
    });

    it('keeps the open list in step with the badge', () => {
      // Badge and active row read the same fact. Updating one without the
      // other leaves the menu contradicting its own icon while open.
      const { host, mount } = setup();
      findByAttr(host, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
      mount.setUnreachable(true);
      expect(
        findAllByAttr(host, SERVER_SWITCHER_ITEM_ATTR)[0]!.getAttribute('data-unreachable'),
      ).toBe('true');
    });

    it('marks the row of the CURRENT active profile after a switch, not the original', () => {
      // The regression guarded here: a badge update that re-rendered from the
      // roster the menu was BUILT with would mark the wrong server.
      const { host, mount } = setup();
      mount.refresh([HOME, OFFICE], 'p2');
      mount.setUnreachable(true);
      findByAttr(host, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
      const items = findAllByAttr(host, SERVER_SWITCHER_ITEM_ATTR);
      expect(items[1]!.getAttribute('data-unreachable')).toBe('true');
      expect(items[0]!.hasAttribute('data-unreachable')).toBe(false);
    });
  });

  it('closes only after a reviewed switch succeeds', async () => {
    const { host, mount, onSwitch } = setup();
    findByAttr(host, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    findAllByAttr(host, SERVER_SWITCHER_ITEM_ATTR)[1]!.click();
    expect(findByAttr(host, SERVER_SWITCHER_SWITCH_CONFIRM_ATTR)).not.toBeNull();
    expect(mount.isOpen()).toBe(true);
    findByAttr(host, SERVER_SWITCHER_SWITCH_COMMIT_ATTR)!.click();
    await flush();
    expect(onSwitch).toHaveBeenCalledWith('p2', 'clean');
    expect(mount.isOpen()).toBe(false);
  });

  it('keeps Account open when switching fails so inline recovery remains visible', async () => {
    const onSwitch = vi.fn().mockRejectedValue(new Error('switch failed'));
    const { host, mount } = setup({ onSwitch });
    findByAttr(host, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    findAllByAttr(host, SERVER_SWITCHER_ITEM_ATTR)[1]!.click();
    findByAttr(host, SERVER_SWITCHER_SWITCH_COMMIT_ATTR)!.click();
    await flush();

    expect(mount.isOpen()).toBe(true);
    expect(findByAttr(host, SERVER_SWITCHER_SWITCH_CONFIRM_ATTR)).not.toBeNull();
  });

  it('clicking the active row closes without switching', () => {
    const { host, mount, onSwitch } = setup();
    findByAttr(host, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    findAllByAttr(host, SERVER_SWITCHER_ITEM_ATTR)[0]!.click();
    expect(onSwitch).not.toHaveBeenCalled();
    expect(mount.isOpen()).toBe(false); // the press still feels answered
  });

  it('closing disarms a pending removal choice', () => {
    const { host, mount, onRemove } = setup();
    findByAttr(host, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    findAllByAttr(host, SERVER_SWITCHER_REMOVE_ATTR)[1]!.click();
    expect(findByAttr(host, SERVER_SWITCHER_REMOVE_CONFIRM_ATTR)).not.toBeNull();
    findByAttr(host, ACCOUNT_MENU_TRIGGER_ATTR)!.click(); // close
    findByAttr(host, ACCOUNT_MENU_TRIGGER_ATTR)!.click(); // reopen
    expect(findByAttr(host, SERVER_SWITCHER_REMOVE_CONFIRM_ATTR)).toBeNull();
    findAllByAttr(host, SERVER_SWITCHER_REMOVE_ATTR)[1]!.click();
    // A live destructive choice must not survive a close and greet the next
    // open as though the first confirmation step had already happened.
    expect(onRemove).not.toHaveBeenCalled();
    expect(findByAttr(host, SERVER_SWITCHER_REMOVE_CONFIRM_ATTR)).not.toBeNull();
    expect(mount.isOpen()).toBe(true);
  });

  it('closing disarms an idle server-switch review', () => {
    const { host } = setup();
    findByAttr(host, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    findAllByAttr(host, SERVER_SWITCHER_ITEM_ATTR)[1]!.click();
    expect(findByAttr(host, SERVER_SWITCHER_SWITCH_CONFIRM_ATTR)).not.toBeNull();
    findByAttr(host, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    findByAttr(host, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    expect(findByAttr(host, SERVER_SWITCHER_SWITCH_CONFIRM_ATTR)).toBeNull();
  });

  it('updates an open removal choice when the active connection becomes usable', () => {
    const { host, mount } = setup({ activeConnected: false });
    findByAttr(host, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    findAllByAttr(host, SERVER_SWITCHER_REMOVE_ATTR)[0]!.click();
    expect(findByAttr(host, SERVER_SWITCHER_REMOVE_REVOKE_ATTR)).toBeNull();

    mount.setActiveConnected(true);

    expect(findByAttr(host, SERVER_SWITCHER_REMOVE_CONFIRM_ATTR)).not.toBeNull();
    expect(findByAttr(host, SERVER_SWITCHER_REMOVE_REVOKE_ATTR)).not.toBeNull();
  });

  it('keeps Account open on the surviving roster after removing another profile', async () => {
    const onRemove = vi.fn(async () => undefined);
    const { dom, host, mount } = setup({ onRemove });
    findByAttr(host, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    findAllByAttr(host, SERVER_SWITCHER_REMOVE_ATTR)[1]!.click();
    findByAttr(host, SERVER_SWITCHER_REMOVE_LOCAL_ATTR)!.click();

    await flush();

    expect(onRemove).toHaveBeenCalledWith('p2', 'local');
    expect(mount.isOpen()).toBe(true);
    expect(findAllByAttr(host, SERVER_SWITCHER_ITEM_ATTR)).toHaveLength(1);
    expect(dom.activeElement()).toBe(
      findByAttr(host, SERVER_SWITCHER_MENU_ATTR),
    );
    expect(findByAttr(host, SERVER_SWITCHER_ANNOUNCER_ATTR)?.textContent)
      .toContain('no longer saved');
  });

  it('closes to the stable Account trigger after removing the active profile', async () => {
    const onRemove = vi.fn(async () => undefined);
    const { dom, host, mount } = setup({ onRemove });
    const trigger = findByAttr(host, ACCOUNT_MENU_TRIGGER_ATTR)!;
    trigger.click();
    findAllByAttr(host, SERVER_SWITCHER_REMOVE_ATTR)[0]!.click();
    findByAttr(host, SERVER_SWITCHER_REMOVE_LOCAL_ATTR)!.click();

    await flush();

    expect(onRemove).toHaveBeenCalledWith('p1', 'local');
    expect(mount.isOpen()).toBe(false);
    expect(dom.activeElement()).toBe(trigger);
  });

  it('closes on Escape, outside click, and focus departure while staying open for inside focus', async () => {
    const { host, dom, mount } = setup();
    const trigger = findByAttr(host, ACCOUNT_MENU_TRIGGER_ATTR)!;
    const popover = findByAttr(host, ACCOUNT_MENU_POPOVER_ATTR)!;
    trigger.click();
    dom.fire('click', { target: popover });
    expect(mount.isOpen()).toBe(true);
    dom.fire('click', { target: dom.create('div') });
    expect(mount.isOpen()).toBe(false);

    trigger.click();
    const outside = dom.create('button');
    outside.focus();
    dom.fire('focusin', { target: outside });
    await flush();
    expect(mount.isOpen()).toBe(false);
    expect(dom.activeElement()).toBe(outside);

    trigger.click();
    dom.fire('keydown', { key: 'Escape', isComposing: true });
    expect(mount.isOpen()).toBe(true);
    expect(dom.activeElement()).not.toBe(trigger);
    dom.fire('keydown', { key: 'Escape' });
    expect(mount.isOpen()).toBe(false);
    expect(dom.activeElement()).toBe(trigger); // focus returns to the trigger
  });

  it('following Settings closes the menu', () => {
    const { host, mount } = setup();
    findByAttr(host, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    findByAttr(host, ACCOUNT_MENU_SETTINGS_ATTR)!.click();
    expect(mount.isOpen()).toBe(false);
  });

  it('dispose removes the nodes and every document listener, and is idempotent', () => {
    const { host, dom, mount } = setup();
    expect(dom.listenerCount('click')).toBe(1);
    expect(dom.listenerCount('focusin')).toBe(1);
    expect(dom.listenerCount('keydown')).toBe(1);
    mount.dispose();
    mount.dispose();
    expect(dom.listenerCount('click')).toBe(0);
    expect(dom.listenerCount('focusin')).toBe(0);
    expect(dom.listenerCount('keydown')).toBe(0);
    expect(findByAttr(host, ACCOUNT_MENU_ATTR)).toBeNull();
  });
});

describe('the outage explainer', () => {
  it('is absent while reachable and present while not', () => {
    // The badge says SOMETHING is wrong; this is where the menu says what.
    // It moved here from the connection popover, minus that popover's third
    // step — which linked to Settings ▸ Server, a page the same outage makes
    // unreachable. The servers list below IS what that step reached for.
    const { host, mount } = setup();
    const recovery = findByAttr(host, ACCOUNT_MENU_RECOVERY_ATTR)!;
    expect(recovery.hasAttribute('hidden')).toBe(true);
    mount.setUnreachable(true);
    expect(recovery.hasAttribute('hidden')).toBe(false);
    expect(recovery.textContent === '' ? recovery.children[0]?.textContent : recovery.textContent)
      .toContain('Can’t reach your server');
  });

  it('carries steps that do not send the owner somewhere the outage blocks', () => {
    const { host } = setup({ unreachable: true });
    const steps = findByAttr(host, ACCOUNT_MENU_RECOVERY_STEPS_ATTR)!;
    expect(steps.children).toHaveLength(2);
    const text = steps.children.map((c) => c.textContent).join(' ');
    expect(text).toContain('this device is online');
    expect(text).toContain('server is switched on');
    // The retired third step. Settings cannot load without the server.
    expect(text).not.toContain('Server settings');
  });

  it('open() lets the offline banner bring the owner straight here', () => {
    const { host, mount, dom } = setup({ unreachable: true });
    expect(mount.isOpen()).toBe(false);
    mount.open();
    expect(mount.isOpen()).toBe(true);
    const recovery = findByAttr(host, ACCOUNT_MENU_RECOVERY_ATTR)!;
    expect(dom.activeElement()).toBe(recovery.children[0]);
  });

  it('returns focus to the open dialog when recovery hides its focused heading', () => {
    const { host, mount, dom } = setup({ unreachable: true });
    mount.open();
    const popover = findByAttr(host, ACCOUNT_MENU_POPOVER_ATTR)!;
    expect(dom.activeElement()).toBe(
      findByAttr(host, ACCOUNT_MENU_RECOVERY_ATTR)!.children[0],
    );

    mount.setUnreachable(false);

    expect(findByAttr(host, ACCOUNT_MENU_RECOVERY_ATTR)!.hasAttribute('hidden'))
      .toBe(true);
    expect(dom.activeElement()).toBe(popover);
  });

  it('explains switching only when another saved profile exists', () => {
    const withAlternative = setup({ unreachable: true });
    const alternativeCopy = findByAttr(
      withAlternative.host,
      ACCOUNT_MENU_RECOVERY_ATTR,
    )!.children[1]!.textContent;
    expect(alternativeCopy).toContain('pick another saved server');

    const oneProfile = setup({ profiles: [HOME], unreachable: true });
    const oneProfileCopy = findByAttr(
      oneProfile.host,
      ACCOUNT_MENU_RECOVERY_ATTR,
    )!.children[1]!.textContent;
    expect(oneProfileCopy).not.toContain('pick another saved server');
    expect(oneProfileCopy).toContain('add another server');
  });
});

describe('adding a server', () => {
  it('offers the entry and reports it', () => {
    const onAddServer = vi.fn();
    const { host, mount } = setup({ onAddServer });
    findByAttr(host, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    const add = findByAttr(host, ACCOUNT_MENU_ADD_SERVER_ATTR)!;
    expect(add).not.toBeNull();
    const servers = findByAttr(host, ACCOUNT_MENU_SERVERS_ROW_ATTR)!;
    expect(servers.children.indexOf(findByAttr(servers, SERVER_SWITCHER_ATTR)!))
      .toBeLessThan(servers.children.indexOf(add));
    add.click();
    expect(onAddServer).toHaveBeenCalledTimes(1);
    expect(mount.isOpen()).toBe(false);
  });

  it('hides the entry when the caller cannot offer a way back', () => {
    // The entry ships WITH the return path or not at all: reaching the pair
    // form means leaving this shell, and stranding the owner there is the dead
    // end this whole surface removed.
    const { host } = setup({ onAddServer: undefined });
    findByAttr(host, ACCOUNT_MENU_TRIGGER_ATTR)!.click();
    expect(findByAttr(host, ACCOUNT_MENU_ADD_SERVER_ATTR)).toBeNull();
  });
});
