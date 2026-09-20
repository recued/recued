/** Settings — Server — Connect a device: the MOUNT.
 *
 *  `settings-connect-device.test.ts` holds what is true; this holds what the
 *  reader can do about it. The one thing they can do here is run the check that
 *  settles the router step, so that is what this drives.
 *
 *  ⛔ WHY A DOM TEST AT ALL when the projection is pure. Because the button is
 *  the one part of this page that is NOT a projection: it has a running state, a
 *  failure that must not be read as a verdict, and a value that is PULLED at
 *  render rather than held. Each of those is a place where "the fact is right"
 *  and "the page says the right thing" come apart. */
import { describe, expect, it, vi } from 'vitest';

import {
  CHECK_CONNECTION_LABEL,
  CHECK_FROM_OUTSIDE_AGAIN_LABEL,
  CHECK_FROM_OUTSIDE_ERROR,
  CHECK_FROM_OUTSIDE_LABEL,
  CHECK_FROM_OUTSIDE_RUNNING_LABEL,
} from '../settings/connect-device.js';
import {
  ADDRESS_VERDICT_TTL_MS,
  CONNECT_DEVICE_CHECK_BTN_ATTR,
  CONNECT_DEVICE_STEP_ACTION_ATTR,
  CONNECT_DEVICE_STEP_ACTION_ERROR_ATTR,
  CONNECT_DEVICE_NOTE_ATTR,
  CONNECT_DEVICE_CHECK_ERROR_ATTR,
  CONNECT_DEVICE_PLACE_ATTR,
  CONNECT_DEVICE_STATE_ATTR,
  CONNECT_DEVICE_STEP_DONE_ATTR,
  CONNECT_DEVICE_STEP_KEY_ATTR,
  mountConnectDevicePanel,
} from '../settings/connect-device-panel.js';

// ──────────────────────────────────────────────────────────────────
// Fake DOM. ⚠ `innerHTML = ''` CLEARS CHILDREN here, as it does in a browser —
// a fake where it only assigns a string turns every re-render into a second copy
// of the panel and hides exactly the bug a re-render test exists to catch.
// ──────────────────────────────────────────────────────────────────
interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  children: FakeEl[];
  attrs: Map<string, string>;
  listeners: Map<string, Array<() => void>>;
  innerHTML: string;
  appendChild(child: FakeEl): FakeEl;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  addEventListener(name: string, fn: () => void): void;
  click(): void;
}

const makeEl = (tagName: string): FakeEl => {
  const children: FakeEl[] = [];
  const attrs = new Map<string, string>();
  const listeners = new Map<string, Array<() => void>>();
  const el: FakeEl = {
    tagName: tagName.toUpperCase(),
    className: '',
    textContent: '',
    children,
    attrs,
    listeners,
    get innerHTML(): string { return ''; },
    set innerHTML(_value: string) { children.length = 0; },
    appendChild: (child) => { children.push(child); return child; },
    setAttribute: (k, v) => { attrs.set(k, v); },
    getAttribute: (k) => attrs.get(k) ?? null,
    addEventListener: (name, fn) => {
      listeners.set(name, [...(listeners.get(name) ?? []), fn]);
    },
    click: () => { for (const fn of listeners.get('click') ?? []) fn(); },
  };
  return el;
};

const fakeDoc = { createElement: (tag: string) => makeEl(tag) } as unknown as Document;

const walk = (el: FakeEl): FakeEl[] => [el, ...el.children.flatMap(walk)];
const byAttr = (root: FakeEl, attr: string, value?: string): FakeEl[] =>
  walk(root).filter((el) =>
    el.attrs.has(attr) && (value === undefined || el.attrs.get(attr) === value));

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const mount = (over: Record<string, unknown> = {}) => {
  const host = makeEl('div');
  const panel = mountConnectDevicePanel({
    host: host as unknown as HTMLElement,
    document: fakeDoc,
    lanPort: 7717,
    ...over,
  } as Parameters<typeof mountConnectDevicePanel>[0]);
  const routerStep = (): FakeEl =>
    byAttr(host, CONNECT_DEVICE_STEP_KEY_ATTR, 'router')[0]!;
  return {
    host,
    panel,
    routerStep,
    routerDone: (): string | null =>
      routerStep().getAttribute(CONNECT_DEVICE_STEP_DONE_ATTR),
    button: (): FakeEl | undefined => byAttr(host, CONNECT_DEVICE_CHECK_BTN_ATTR)[0],
    exposureButton: (): FakeEl | undefined =>
      byAttr(host, 'data-recued-connect-device-exposure-check')[0],
    otherState: (): string | null =>
      byAttr(host, CONNECT_DEVICE_PLACE_ATTR, 'other_devices')[0]!
        .getAttribute(CONNECT_DEVICE_STATE_ATTR),
  };
};

describe('D-272/D-273 — ONE check action, several answers', () => {
  const exposed = {
    publicly_routable: true, wildcard: true, public_addresses: ['203.0.113.7'],
  };
  const certified = async () => ['home.example.com'];

  it('⛔ is offered ONLY where something can actually run', () => {
    // A control that cannot check is worse than none: it reads as "we looked"
    // when nothing did.
    expect(mount().button()).toBeUndefined();
    expect(mount({ runOutsideChecks: async () => {} }).button()).toBeDefined();
  });

  it('⛔⛔ NOT offered for a port the probe may not be asked about', () => {
    // `normalizePorts` in the worker THROWS on a port outside the allowlist, so
    // a control that could only ever produce a 400 must not be offered.
    expect(mount({
      publicPort: 8443,
      canCheckPort: () => false,
      runOutsideChecks: async () => {},
    }).button()).toBeUndefined();
  });

  it('⛔⛔ but IS offered when only the LAN port can be asked about', () => {
    // 🔑 The coupling this replaced. `public_port` 8443 is off the closed list,
    // so the router half cannot run — and the operator whose LAN listener is on
    // a public address is the one most likely to BE exposed. One action, offered
    // when ANY half can answer.
    const m = mount({
      publicPort: 8443,
      canCheckPort: () => false,
      canCheckExtraPort: () => true,
      readPorts: async () => ({ public_port: 8443, lan_exposure: exposed }),
      runOutsideChecks: async () => {},
    });
    return flush().then(() => { expect(m.button()).toBeDefined(); });
  });

  it('⛔ and when only the from-this-device check can run', async () => {
    // No probe caller at all — the free self-hoster with no account. The
    // browser-side check needs neither.
    const m = mount({
      readCertifiedHostnames: certified,
      checkAddressFromHere: async () => true,
    });
    await flush();
    expect(m.button()).toBeDefined();
  });

  it('⛔⛔ RUNS EVERY APPLICABLE CHECK IN ONE PRESS', async () => {
    // The whole point. Three buttons meant a reader had to know which mechanism
    // answered their question; one action means they do not.
    const ran: string[] = [];
    const m = mount({
      readCertifiedHostnames: certified,
      readPorts: async () => ({ lan_exposure: exposed }),
      canCheckExtraPort: () => true,
      runOutsideChecks: async (args: { publicPort: number; lanPort: number; lanExposed: boolean }) => {
        ran.push(`outside:${String(args.publicPort)}:${String(args.lanPort)}:${String(args.lanExposed)}`);
      },
      checkAddressFromHere: async (url: string) => { ran.push(`here:${url}`); return true; },
    });
    await flush();
    m.button()!.click();
    await flush();
    expect(ran).toEqual([
      'outside:443:7717:true',
      'here:https://home.example.com/webclient/',
    ]);
  });

  it('⛔⛔ one half FAILING does not discard the other half\u2019s answer', async () => {
    // `allSettled`, never `all`. A cloud probe that fails must not throw away
    // what the browser already established, and vice versa.
    const m = mount({
      readCertifiedHostnames: certified,
      runOutsideChecks: async () => { throw new Error('rate limited'); },
      checkAddressFromHere: async () => true,
    });
    await flush();
    m.button()!.click();
    await flush();
    const note = byAttr(m.host, CONNECT_DEVICE_NOTE_ATTR)
      .map((e) => walk(e).map((x) => x.textContent ?? '').join(' ')).join(' | ');
    expect(note).toContain('This device reached that address');
    // ⛔ And NO error line: one half failing still leaves the reader better
    // informed, and "that could not run" over a row that was just answered is
    // worse than silence.
    expect(byAttr(m.host, CONNECT_DEVICE_CHECK_ERROR_ATTR)).toHaveLength(0);
  });

  // ── Two mutants that survive here, deliberately left untested ───────────
  //
  // ⚠ RECORDED RATHER THAN COVERED, because three attempts at each produced
  // tests that passed either way — which is the vacuity this file's other cases
  // exist to avoid, and shipping one would be worse than shipping neither.
  //
  // 1. `if (!disposed` in the address-verdict block. REDUNDANT, not risky:
  //    `render()` already no-ops after dispose, and the block's only other
  //    effect is `clearTimeout` followed by `setTimeout` — a net-zero change to
  //    the timer count, so even counting timers cannot see it. Its sibling
  //    guard on the same condition (`askedAbout === addressToCheck()`) IS
  //    tested, which is how this one looked covered.
  //
  // 2. `attemptedStatuses.length > 0`. UNREACHABLE: the list is empty only when
  //    `runOutsideChecks` is unset and the address is null, and the button that
  //    starts the check is offered only when one of those holds. Getting there
  //    needs the address to become null between the click and the synchronous
  //    re-read inside the handler. The guard is correct defence against
  //    `[].every()` being vacuously true; there is just no state that reaches
  //    it.
  //
  // ⇒ Both are defence behind a guarantee something else already makes. Saying
  // so is more useful than a green test that asserts nothing.

  it('⚠ an error line ONLY when everything failed', async () => {
    const m = mount({
      readCertifiedHostnames: certified,
      runOutsideChecks: async () => { throw new Error('rate limited'); },
      checkAddressFromHere: async () => { throw new Error('offline'); },
    });
    await flush();
    m.button()!.click();
    await flush();
    expect(byAttr(m.host, CONNECT_DEVICE_CHECK_ERROR_ATTR)).toHaveLength(1);
  });

  it('⛔ a check that FAILED TO RUN is not a closed port', async () => {
    // The verdict stays wherever the reader\u2019s last real answer left it.
    const m = mount({
      readPublicPortReachable: () => null,
      runOutsideChecks: async () => { throw new Error('rate limited'); },
    });
    m.button()!.click();
    await flush();
    expect(m.routerDone()).toBe('unknown');
  });

  it('⚠ a second click while one is in flight does not start another', async () => {
    let calls = 0;
    let release: (() => void) | null = null;
    const m = mount({
      runOutsideChecks: async () => {
        calls += 1;
        await new Promise<void>((r) => { release = r; });
      },
    });
    m.button()!.click();
    await flush();
    expect(m.button()!.getAttribute('disabled')).toBe('true');
    m.button()!.click();
    await flush();
    expect(calls).toBe(1);
    release!();
    await flush();
    expect(m.button()!.getAttribute('disabled')).toBeNull();
  });

  it('⚠ a verdict the caller already holds renders WITHOUT anyone clicking', async () => {
    // The check may have run on another page. The panel reads the standing
    // answer rather than holding a copy, so it arrives already settled — and the
    // label offers a RE-check, because that is what pressing would be.
    const m = mount({
      readPublicPortReachable: () => true,
      runOutsideChecks: async () => {},
    });
    expect(m.routerDone()).toBe('true');
    expect(m.button()!.textContent).toBe(CHECK_FROM_OUTSIDE_AGAIN_LABEL);
  });

  it('starts as a first-time check when nothing has looked', () => {
    expect(mount({ runOutsideChecks: async () => {} }).button()!.textContent)
      .toBe(CHECK_CONNECTION_LABEL);
  });

  it('⛔ the verdict is read for the RESOLVED port, not the opening guess', async () => {
    // Reading 443\u2019s answer while the card says 8446 reports another port\u2019s
    // verdict under this one\u2019s label.
    const asked: number[] = [];
    const m = mount({
      publicPort: 443,
      readPorts: async () => ({ public_port: 8446 }),
      readPublicPortReachable: (port: number) => { asked.push(port); return null; },
      runOutsideChecks: async () => {},
    });
    await flush();
    expect(asked[0]).toBe(443);
    expect(asked[asked.length - 1]).toBe(8446);
  });

  it('⛔ and the action is told the RESOLVED ports, not the guesses', async () => {
    const seen: { publicPort: number; lanPort: number }[] = [];
    const m = mount({
      publicPort: 443,
      readPorts: async () => ({ public_port: 8446, lan_port: 9100 }),
      canCheckPort: () => true,
      runOutsideChecks: async (a: { publicPort: number; lanPort: number }) => { seen.push(a); },
    });
    await flush();
    m.button()!.click();
    await flush();
    expect(seen[0]).toMatchObject({ publicPort: 8446, lanPort: 9100 });
  });

  it('⛔ the COPY and the CONTROL never disagree', async () => {
    // Derived separately, the hint would offer a check the panel had decided not
    // to show — the shape D-272 caught once with a \u2713 row beside "Check this
    // now", which only a real browser revealed.
    const hint = (m: ReturnType<typeof mount>): string => {
      const step = byAttr(m.host, CONNECT_DEVICE_STEP_KEY_ATTR, 'router')[0]!;
      return walk(step).map((el) => el.textContent ?? '').join(' ');
    };
    const m = mount({
      publicPort: 443,
      readPorts: async () => ({ public_port: 8443 }),
      canCheckPort: (port: number) => port === 443,
      runOutsideChecks: async () => {},
    });
    expect(hint(m)).toContain('Recued can check this from outside');
    await flush();
    expect(m.button()).toBeUndefined();
    expect(hint(m)).toContain('Your router settings screen shows this');
  });

  it('⚠ a click cannot outrun the gate', async () => {
    let calls = 0;
    const m = mount({
      publicPort: 443,
      readPorts: async () => ({ public_port: 8443 }),
      canCheckPort: (port: number) => port === 443,
      runOutsideChecks: async () => { calls += 1; },
    });
    const button = m.button()!;
    await flush();
    button.click();
    await flush();
    expect(calls).toBe(0);
  });

  it('sits below the cards, and the router step keeps its own mark', () => {
    const m = mount({ runOutsideChecks: async () => {} });
    expect(m.routerDone()).toBe('unknown');
    // ⚠ Found by KEY, not by label — labels are copy, and copy changes.
    expect(byAttr(m.host, CONNECT_DEVICE_STEP_KEY_ATTR, 'certificate')).toHaveLength(1);
  });
});

describe('D-273 follow-on — the pairing step', () => {
  const pairingText = (m: ReturnType<typeof mount>): string => {
    const block = byAttr(m.host, 'data-recued-connect-device-pairing')[0];
    return block === undefined
      ? ''
      : walk(block).map((el) => el.textContent ?? '').join(' ');
  };

  it('⛔ renders WITHOUT any caller — it is copy, not a capability', () => {
    // No rpc mints a pairing code, and that absence is a security property: a
    // paired browser able to mint pairing credentials means a stolen session
    // can add devices silently. The page explains the flow; it never performs
    // it, so it needs nothing wired to say so.
    expect(pairingText(mount())).toContain('Sign a new device in');
  });

  it('prints the command the boot banner prints', () => {
    // ⚠ `recued pair` — the binary is `recued`. The docstring on the command
    // file says `recued-server pair` and is stale; copying it would have put a
    // command that does not exist in front of a beginner.
    const text = pairingText(mount());
    expect(text).toContain('run recued pair');
    expect(text).not.toContain('recued-server pair');
  });

  it('⚠ names that the code expires', () => {
    expect(pairingText(mount())).toContain('expires');
  });

  it('⛔⛔ offers the ADDRESS as an alternative to the link — never a link carrying it', () => {
    // The `?url=` pre-fill was cut on a critical finding: a link carrying the
    // destination renders the official form, pre-fills an attacker's server and
    // POSTs the 24-word master key there. The destination must be self-authored,
    // which is exactly why step three has two options rather than one tidy link.
    const text = pairingText(mount());
    expect(text).toContain('open the address above and type the code in');
    expect(text).not.toMatch(/\?url=/);
  });

  it('⚠ warns that the first device also sets up the recovery words', () => {
    // The one surprise worth naming up front: the first pair is enrolment, and
    // the words it shows are the only copy of them.
    expect(pairingText(mount())).toContain('recovery words');
  });

  it('⛔ appears ONCE, after both cards — not per card', () => {
    // The command is the same whichever address was used. Twice would be noise;
    // on one card it would imply it applies only to that route.
    const m = mount({ readCertifiedHostnames: async () => ['home.example.com'] });
    expect(byAttr(m.host, 'data-recued-connect-device-pairing')).toHaveLength(1);
  });
});

describe('D-272 — the Reachability tab, folded in', () => {
  const detail = () => [
    { kind: 'Port reachability', status: 'Pass', detail: 'port 443 reachable' },
    { kind: 'TLS handshake', status: 'Fail', detail: 'cert expired' },
  ];

  it('⛔ shows the raw rows UNDER the plain-language answer, not instead of it', () => {
    // The tab this replaces made the table the ONLY answer, which is what made
    // it an operator surface. Here it is detail beneath a verdict the reader
    // already has.
    const m = mount({
      runOutsideChecks: async () => {},
      readPublicPortReachable: () => true,
      readProbeDetail: detail,
    });
    const rows = byAttr(m.host, 'data-recued-connect-device-probe-detail');
    expect(rows).toHaveLength(1);
    const text = walk(rows[0]!).map((e) => e.textContent ?? '').join(' ');
    expect(text).toContain('Port reachability: Pass — port 443 reachable');
    expect(text).toContain('TLS handshake: Fail — cert expired');
    // ...and the plain answer is still the thing above it.
    expect(m.routerDone()).toBe('true');
  });

  it('⚠ nothing checked ⇒ no detail block', () => {
    // Absent is "nobody looked". An empty table would say a probe ran and found
    // nothing, which is a different claim.
    const m = mount({ runOutsideChecks: async () => {}, readProbeDetail: () => [] });
    expect(byAttr(m.host, 'data-recued-connect-device-probe-detail')).toHaveLength(0);
  });

  it('⚠ and no reader wired ⇒ no detail block either', () => {
    const m = mount({ runOutsideChecks: async () => {} });
    expect(byAttr(m.host, 'data-recued-connect-device-probe-detail')).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────
// D-273 — the port-mapping control. The one thing on this page that CHANGES
// the server, so every assertion here is about not lying about whether it did.
// ──────────────────────────────────────────────────────────────────
describe('D-273 — flipping automatic port forwarding', () => {
  const offerable = { enabled: false, support: 'enabled' as const };
  const actionBtn = (host: FakeEl): FakeEl | undefined =>
    byAttr(host, CONNECT_DEVICE_STEP_ACTION_ATTR)[0];

  it('⛔ NOT rendered without a writer, even when the facts say to offer it', () => {
    // The copy decides whether flipping it is worth OFFERING; the caller decides
    // whether the panel can flip it at all. A control with no writer behind it
    // is a button that does nothing — worse than the sentence it replaced,
    // which at least named somewhere to go.
    const m = mount({ readPortMapping: async () => offerable });
    return flush().then(() => { expect(actionBtn(m.host)).toBeUndefined(); });
  });

  it('⛔ and NOT rendered when the facts say not to, even with a writer', () => {
    // Both gates, independently. This is the pair that a single combined check
    // would collapse.
    const m = mount({
      readPortMapping: async () => ({ enabled: false, support: 'unsupported' as const }),
      setPortMappingEnabled: async () => {},
    });
    return flush().then(() => { expect(actionBtn(m.host)).toBeUndefined(); });
  });

  it('sends the DIRECTION the row was drawn with, not a toggle of what it read', () => {
    // ⚠ The button carries `enable` as an attribute for the same reason the copy
    // carries it as a field: a mount that flipped `!current` would send the
    // wrong value the moment the read and the render disagree.
    const sent: boolean[] = [];
    const m = mount({
      readPortMapping: async () => offerable,
      setPortMappingEnabled: async (enabled: boolean) => { sent.push(enabled); },
    });
    return flush().then(() => {
      const btn = actionBtn(m.host)!;
      expect(btn.getAttribute('data-recued-connect-device-step-action-enable')).toBe('true');
      btn.click();
      return flush();
    }).then(() => { expect(sent).toEqual([true]); });
  });

  it('⛔⛔ RE-READS AFTER THE WRITE — the write and the outcome are two facts', () => {
    // `server.setConfigField` resolves when the KEY is persisted. The supervisor
    // then reconciles on its own clock and coalesces concurrent runs, so nothing
    // the write returns can describe what the router did. The row must go and
    // look, or it renders the pre-flip world under a flipped switch.
    let reads = 0;
    const m = mount({
      readPortMapping: async () => {
        reads += 1;
        return reads === 1 ? offerable : { enabled: true, outcome: 'mapped' as const };
      },
      setPortMappingEnabled: async () => {},
    });
    return flush().then(() => {
      expect(reads).toBe(1);
      actionBtn(m.host)!.click();
      return flush();
    }).then(() => {
      expect(reads).toBe(2);
      // ...and the row now shows the other direction, from the fresh read.
      expect(actionBtn(m.host)!.getAttribute(
        'data-recued-connect-device-step-action-enable')).toBe('false');
      const text = walk(m.routerStep()).map((e) => e.textContent ?? '').join(' ');
      expect(text).toContain('Recued opened this port on your router');
    });
  });

  it('⛔⛔ A REFUSED WRITE IS NAMED, and the row does NOT redraw as if it took', () => {
    // The shipped docker-compose bind-mounts `config.toml` read-only, so this is
    // the ordinary path for a real deployment, not an edge. A switch that sprang
    // back with no sentence is how someone concludes the page is broken.
    const m = mount({
      readPortMapping: async () => offerable,
      setPortMappingEnabled: async () => { throw new Error('config.toml is read-only'); },
    });
    return flush().then(() => {
      actionBtn(m.host)!.click();
      return flush();
    }).then(() => {
      const err = byAttr(m.host, CONNECT_DEVICE_STEP_ACTION_ERROR_ATTR)[0];
      expect(err?.textContent).toContain('read-only');
      // Still offering ON: nothing changed, and the row says so.
      expect(actionBtn(m.host)!.getAttribute(
        'data-recued-connect-device-step-action-enable')).toBe('true');
    });
  });

  it('⚠ is busy while in flight, and not pressable twice', () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const m = mount({
      readPortMapping: async () => offerable,
      setPortMappingEnabled: async () => {
        calls += 1;
        await new Promise<void>((resolve) => { release = resolve; });
      },
    });
    return flush().then(() => {
      actionBtn(m.host)!.click();
      return flush();
    }).then(() => {
      const btn = actionBtn(m.host)!;
      expect(btn.getAttribute('disabled')).toBe('true');
      expect(btn.getAttribute('aria-busy')).toBe('true');
      btn.click();
      release?.();
      return flush();
    }).then(() => { expect(calls).toBe(1); });
  });
});

// ──────────────────────────────────────────────────────────────────
// Audit P2-7 / P2-8 — a verdict belongs to the address it was asked about, and
// the one check action must refresh every row it answers for.
// ──────────────────────────────────────────────────────────────────
describe('D-273 audit — late results and stale rows', () => {
  const certified = async () => ['home.example.com'];

  it('⛔⛔ a check that RESOLVES AFTER the address moved is DISCARDED', async () => {
    // The port RPC arriving mid-check is the ordinary case, not a race someone
    // has to contrive: the card opens on the 443 fallback and corrects itself.
    // `forgetAddressVerdict` clears a SETTLED verdict when that happens; it
    // cannot un-fire one already in flight, and the late `true` was committed
    // against the NEW address — the card then showed the :8446 link over "this
    // device reached that address just now".
    let releaseCheck: ((v: boolean) => void) | undefined;
    let releasePorts: ((p: { public_port: number }) => void) | undefined;
    const m = mount({
      readCertifiedHostnames: certified,
      readPorts: () => new Promise((resolve) => { releasePorts = resolve; }),
      checkAddressFromHere: () => new Promise<boolean>((resolve) => { releaseCheck = resolve; }),
    });
    await flush();
    m.button()!.click();          // starts against the 443 fallback
    await flush();
    releasePorts?.({ public_port: 8446 });   // the real port lands mid-check
    await flush();
    releaseCheck?.(true);                     // the old check finally answers
    await flush();
    const text = walk(m.host).map((e) => e.textContent ?? '').join(' ');
    expect(text).not.toContain('reached that address just now');
  });

  it('⚠ and a check whose address did NOT move still counts', async () => {
    // The guard must not throw away the ordinary success it was added around.
    let releaseCheck: ((v: boolean) => void) | undefined;
    const m = mount({
      readCertifiedHostnames: certified,
      checkAddressFromHere: () => new Promise<boolean>((resolve) => { releaseCheck = resolve; }),
    });
    await flush();
    m.button()!.click();
    await flush();
    releaseCheck?.(true);
    await flush();
    const text = walk(m.host).map((e) => e.textContent ?? '').join(' ');
    expect(text).toContain('reached that address just now');
  });

  it('⛔ Check connection RE-READS the router row', async () => {
    // It read `network.port_mapping` once at mount and never again, so the
    // button left a stale `idle`/`unsupported` on screen however the router had
    // changed — and re-opening the page was the only refresh.
    let reads = 0;
    const m = mount({
      readCertifiedHostnames: certified,
      checkAddressFromHere: async () => true,
      readPortMapping: async () => {
        reads += 1;
        return reads === 1
          ? { enabled: false, support: 'disabled' as const }
          : { enabled: true, outcome: 'mapped' as const };
      },
    });
    await flush();
    expect(reads).toBe(1);
    m.button()!.click();
    await flush();
    expect(reads).toBe(2);
    const text = walk(m.routerStep()).map((e) => e.textContent ?? '').join(' ');
    expect(text).toContain('Recued opened this port on your router');
  });
});

// ──────────────────────────────────────────────────────────────────
// Audit P2-12 — a skipped check is not a successful one.
// ──────────────────────────────────────────────────────────────────
describe('D-273 audit P2-12 — a failed outside check is SAID', () => {
  it('⛔⛔ reports the failure when the outside check is the ONLY one attempted', async () => {
    // The ordinary shape, not a contrived one: no certificate ⇒ no address ⇒
    // the from-here check is skipped and FULFILS with null, so
    // `results.every(rejected)` was false and a genuine outside failure — no
    // diagnostics hostname, refused authorization, rate limit — completed
    // silently with nothing on screen.
    const m = mount({
      runOutsideChecks: async () => { throw new Error('diagnostics hostname is unavailable'); },
    });
    await flush();
    m.button()!.click();
    await flush();
    expect(byAttr(m.host, CONNECT_DEVICE_CHECK_ERROR_ATTR)).toHaveLength(1);
  });

  it('⚠ stays quiet when a check that DID run answered', async () => {
    // The rule this preserves: do not shout "that could not run" over a row
    // that just got its answer.
    const m = mount({
      readCertifiedHostnames: async () => ['home.example.com'],
      runOutsideChecks: async () => { throw new Error('probe refused'); },
      checkAddressFromHere: async () => true,
    });
    await flush();
    m.button()!.click();
    await flush();
    expect(byAttr(m.host, CONNECT_DEVICE_CHECK_ERROR_ATTR)).toHaveLength(0);
  });

  it('⚠ a from-here check resolving FALSE is an answer, not a failure', async () => {
    // It resolves false on a network error by design — an unreachable address IS
    // the answer there — so it can never contribute a rejection. A guard that
    // counted on it to would only ever pass.
    const m = mount({
      readCertifiedHostnames: async () => ['home.example.com'],
      checkAddressFromHere: async () => false,
    });
    await flush();
    m.button()!.click();
    await flush();
    expect(byAttr(m.host, CONNECT_DEVICE_CHECK_ERROR_ATTR)).toHaveLength(0);
  });
});
