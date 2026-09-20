/** Settings — Server — Connect a device.
 *
 *  TWO places, because there are two ports and two answers. The assertions that
 *  matter are about what is NOT said: no card may hand over an address that opens
 *  and then refuses to run, nothing may assert a certificate state that was never
 *  read, and the router row must never read as work everybody owes. Readability
 *  is held separately, in `settings-connect-device-readability.test.ts`. */
import { describe, expect, it } from 'vitest';

import {
  CERTIFICATE_ROUTES,
  PRO_CERTIFICATE_NOTE,
  buildConnectDevicePlaces,
  hostedAppNote,
  type ConnectDeviceFacts,
} from '../settings/connect-device.js';

const facts = (over: Partial<ConnectDeviceFacts> = {}): ConnectDeviceFacts => ({
  lan_port: 7717,
  public_port: 443,
  certified_hostnames: [],
  // The default is the honest one: nobody has checked from outside.
  public_port_reachable: null,
  can_check_from_outside: true,
  can_check_address_here: false,
  ...over,
});

const certified = (over: Partial<ConnectDeviceFacts> = {}): ConnectDeviceFacts =>
  facts({ certified_hostnames: ['home.example.com'], ...over });

describe('a fresh server', () => {
  const [here, others] = buildConnectDevicePlaces(facts());

  it('⚠ answers in TWO places, not three, easiest first', () => {
    // "At home" and "away" shared an address, a port and a certificate and
    // differed by one checklist row. Three cards for one answer left the reader
    // to notice that two of them were the same answer.
    expect(buildConnectDevicePlaces(facts()).map((c) => c.place))
      .toEqual(['this_computer', 'other_devices']);
  });

  it('this computer is ready with no setup, and carries the link', () => {
    expect(here!.state).toBe('ready');
    expect(here!.status).toBe('Ready');
    expect(here!.url).toBe('http://127.0.0.1:7717/webclient/');
    expect(here!.portNote).toContain('7717');
    // ⛔ ABOUT THE ADDRESS, NOT THE PORT. "Nothing leaves your computer" was a
    // claim about the LISTENER, and the listener binds `0.0.0.0` in the ordinary
    // case — see the note at the call site. A reassurance that is false is worse
    // than none, because nobody goes and checks a sentence that calmed them.
    expect(here!.portNote).toContain('your own machine');
    expect(here!.portNote).not.toContain('Nothing leaves');
  });

  it('⛔ with no certificate there is NO address', () => {
    // The failure this page exists to prevent: an address that opens a page and
    // then stops is worse than no address.
    expect(others!.url).toBeUndefined();
    expect(others!.state).toBe('one_step');
    expect(others!.status).toBe('One thing to set up');
    expect(others!.body).toContain('needs a safe one');
  });

  it('names both steps, certificate first', () => {
    expect(others!.steps?.map((st) => st.key)).toEqual(['certificate', 'router']);
    expect(others!.steps?.map((st) => st.label)).toEqual([
      'A safe web address',
      'Let port 443 through your router',
    ]);
  });

  it('⛔ the ROUTER step is unknown UNTIL SOMETHING CHECKS, never unticked', () => {
    // Nothing on this machine can read a home router's forwarding table. Drawing
    // it as "not done" would state a fact we do not have. The answer exists on
    // the far side of the router, which is where the check runs.
    const router = others!.steps!.find((st) => st.key === 'router');
    expect(router!.done).toBeNull();
    expect(router!.hint).toContain('check this from outside');
    // ...while the certificate step IS knowable, so it takes a real boolean.
    expect(others!.steps!.find((st) => st.key === 'certificate')!.done).toBe(false);
  });

  it('⛔⛔ EVERY unfinished router state says AWAY FROM HOME first', () => {
    // On one card this is the only row not everybody needs. Without that phrase
    // an untickable box reads as work owed before a phone will work in the
    // kitchen — and it is not; a router has no say in traffic that stays home.
    for (const f of [
      facts(),
      facts({ can_check_from_outside: false }),
      certified({ public_port_reachable: false }),
    ]) {
      const [, card] = buildConnectDevicePlaces(f);
      const router = card!.steps!.find((st) => st.key === 'router');
      expect({ hint: router!.hint, saysAway: router!.hint.startsWith('Only needed away from home.') })
        .toEqual({ hint: router!.hint, saysAway: true });
    }
  });

  it('⚠ with no way to run the check, it points at the ROUTER, not at a check', () => {
    // Offering a check the reader cannot run is worse than naming the place that
    // holds the answer. The step stays unknown either way.
    const [, card] = buildConnectDevicePlaces(facts({ can_check_from_outside: false }));
    const router = card!.steps!.find((st) => st.key === 'router');
    expect(router!.done).toBeNull();
    expect(router!.hint).toContain('Your router settings screen shows this.');
  });

  it('⚠ shows the PAYOFF before the work, and names the Pro address shape', () => {
    // A card that opens with what is missing is a card people close.
    expect(others!.payoff).toContain('anywhere you go');
    expect(others!.payoff).toContain('yourname.recued.net');
  });
});

describe('the ways to get a certificate', () => {
  it('⚠ all free, ordered by what the reader already has', () => {
    expect(CERTIFICATE_ROUTES.map((r) => r.title)).toEqual([
      'Tailscale', 'Caddy', 'A certificate you already have',
    ]);
    // ⛔ Pro is NOT one of them — a paid row among free ones reads as the free
    // ones being second-best. It is a footnote instead.
    expect(CERTIFICATE_ROUTES.some((r) => r.title.includes('Pro'))).toBe(false);
    // ⚠ The note must say what Pro does NOT do. Pro removes the certificate
    // work and not the router work, and a reader who pays, finishes, and then
    // discovers the second half is worse off than one who was told.
    expect(PRO_CERTIFICATE_NOTE).toContain('yourname.recued.net');
    expect(PRO_CERTIFICATE_NOTE).toContain('still let port 443 through your router');
  });

  it('⛔ a route that needs a command CARRIES it — a name is not an answer', () => {
    const [tailscale, caddy, byo] = CERTIFICATE_ROUTES;
    expect(tailscale!.command).toContain('tailscale cert');
    expect(tailscale!.command).toContain('tailscale serve');
    expect(caddy!.command).toContain('reverse_proxy 127.0.0.1:7717');
    // Uploading is a place in the UI, not a shell step.
    expect(byo!.command).toBeUndefined();
    expect(byo!.detail).toContain('Certificates');
  });

  it('only Tailscale claims to cover away-from-home', () => {
    // The badge is a promise. Caddy needs a router change for away, so it must
    // not carry one.
    expect(CERTIFICATE_ROUTES.filter((r) => r.coversAway).map((r) => r.title))
      .toEqual(['Tailscale']);
  });
});

describe('⚠ a certificate state that was never READ', () => {
  const [, others] = buildConnectDevicePlaces(facts({ certified_hostnames: null }));

  it('gives the same guidance without claiming what nothing looked for', () => {
    expect(others!.state).toBe('one_step');
    expect(others!.url).toBeUndefined();
    expect(others!.body).toContain('needs a safe one');
  });
});

describe('once a certificate exists', () => {
  it('⛔ the PAYOFF is gone, because it had nothing left to promise', () => {
    // It said "from anywhere" on a card whose status said "Ready at home", and
    // repeated the body's own "Open …" sentence. Both true in isolation, which
    // is why only reading the rendered page caught it.
    const [, others] = buildConnectDevicePlaces(certified());
    expect(others!.payoff).toBeUndefined();
    // ...and it is still there for the reader who has the work ahead of them.
    expect(buildConnectDevicePlaces(facts())[1]!.payoff).toContain('anywhere you go');
  });

  it('⛔ names the one promise this card cannot keep — and both states carry it', () => {
    // A certified address points at the house from the internet, so a phone
    // already inside must be sent back in by the router, and plenty will not.
    // ⚠ The check CANNOT catch this: it asks from outside, so it reports the
    // port reachable while the phone in the kitchen still fails. So it is copy,
    // not a step — a step would imply something looked.
    for (const f of [
      certified(),
      certified({ public_port_reachable: true }),
      certified({ public_port_reachable: false }),
    ]) {
      const [, others] = buildConnectDevicePlaces(f);
      // ⚠ Its own line, not a fourth sentence in the body — a reader skims a
      // paragraph and reads a line, and this one is only needed once something
      // has already gone wrong.
      expect({ note: others!.note, warns: (others!.note ?? '').includes('not sending your address back inside') })
        .toEqual({ note: others!.note, warns: true });
      // ⛔ And it names a way out. The routes stop rendering once a certificate
      // exists, so pointing at "the list below" would point at nothing.
      expect(others!.note).toContain('Tailscale');
    }
    // Not said before there is an address to fail — nothing to caveat yet.
    expect(buildConnectDevicePlaces(facts())[1]!.note).toBeUndefined();
  });

  it('⚠ the status reports REACH, and a certificate alone reaches HOME', () => {
    // A certificate makes an address safe, not reachable from outside. The card
    // says exactly how far it got rather than counting boxes.
    const [, others] = buildConnectDevicePlaces(certified());
    expect(others!.state).toBe('ready');
    expect(others!.status).toBe('Ready at home');
    expect(others!.url).toBe('https://home.example.com/webclient/');
    expect(others!.steps!.map((st) => st.done)).toEqual([true, null]);
  });

  it('turns ready ANYWHERE once a check from outside got in', () => {
    const [, others] = buildConnectDevicePlaces(certified({ public_port_reachable: true }));
    expect(others!.status).toBe('Ready anywhere');
    expect(others!.steps!.map((st) => st.done)).toEqual([true, true]);
    expect(others!.steps![1]!.label).toBe('Port 443 reaches this computer from outside');
    expect(others!.body).toContain('at home or away');
  });

  it('⛔⛔ a REFUSED router check does NOT withdraw the address', () => {
    // ⚠ THIS REVERSES A RULE THE THREE-CARD VERSION HAD, deliberately. An "away"
    // card offering an address a check had just proved unreachable was wrong. On
    // one card the same address is the one that WORKS AT HOME — a router has no
    // say in traffic that never leaves the house — so withholding it would hide
    // a working address from someone who has one.
    const [, others] = buildConnectDevicePlaces(certified({ public_port_reachable: false }));
    expect(others!.url).toBe('https://home.example.com/webclient/');
    expect(others!.status).toBe('Ready at home');
    expect(others!.steps![1]!.done).toBe(false);
    expect(others!.steps![1]!.hint).toContain('could not get in');
  });

  it('carries a non-default public port into the address', () => {
    const [, others] = buildConnectDevicePlaces(certified({ public_port: 8446 }));
    expect(others!.url).toBe('https://home.example.com:8446/webclient/');
    expect(others!.steps![1]!.label).toContain('8446');
  });

  it('carries a non-default bind port everywhere 7717 was named', () => {
    const [here] = buildConnectDevicePlaces(certified({ lan_port: 9100 }));
    expect(here!.url).toBe('http://127.0.0.1:9100/webclient/');
    expect(here!.portNote).toContain('9100');
  });

  it('the hosted app becomes a real option, described as equivalent', () => {
    expect(hostedAppNote(certified())).toContain('same app');
    expect(hostedAppNote(certified())).not.toContain('cannot reach');
  });
});

describe('D-272 — the hairpin note, in its three states', () => {
  const away = (over: Record<string, unknown> = {}) =>
    buildConnectDevicePlaces({
      lan_port: 7717,
      public_port: 443,
      certified_hostnames: ['home.example.com'],
      public_port_reachable: null,
      can_check_from_outside: false,
          can_check_address_here: true,
      ...over,
    } as Parameters<typeof buildConnectDevicePlaces>[0])
      .find((c) => c.place === 'other_devices')!;

  it('⚠ unchecked reads exactly as it did before the check existed', () => {
    // A reader who has not run it is where they were. The check adds a verdict;
    // it does not change what "no verdict" says.
    const card = away();
    expect(card.note).toContain('your router is not sending your address back');
    expect(card.note_check).toBe('address_from_here');
  });

  it('⛔ reached: states WHAT was established, and conditions the rest', () => {
    const card = away({ address_reachable_here: true });
    expect(card.note).toContain('This device reached that address');
    // ⛔ "If you are at home" — the browser cannot know which network it is on.
    // Claiming the router works would assert a fact about a place nobody located.
    expect(card.note).toContain('If you are at home');
  });

  it('⛔⛔ failed with the router UNCONFIRMED names the port forward FIRST', () => {
    // ⛔ HAIRPIN DEPENDS ON THE PORT FORWARD. With no forward the check fails
    // too, and from inside "not forwarded" and "will not hairpin" are
    // indistinguishable — so naming hairpin first would send a beginner hunting
    // an exotic router setting instead of doing the step they have not done.
    for (const routerState of [null, false]) {
      const card = away({
        address_reachable_here: false,
        public_port_reachable: routerState,
      });
      expect(card.note).toContain('could not reach');
      expect(card.note).toContain('port may not be open in your router yet');
      // ...hairpin still named, but second, and as a possibility.
      expect(card.note).toContain('can also be');
    }
  });

  it('⛔ failed with the router CONFIRMED OPEN makes hairpin the live suspect', () => {
    // Only once something has established the forward exists does hairpin
    // become the thing to suspect — and even then it is "may not".
    const card = away({
      address_reachable_here: false,
      public_port_reachable: true,
    });
    expect(card.note).toContain('Your router lets the internet in');
    expect(card.note).toContain('may not send your own address back inside');
    // ⛔ And it never tells a reader with a working forward to go check it again.
    expect(card.note).not.toContain('port may not be open');
  });

  it('⛔ no certificate ⇒ no address ⇒ no check offered', () => {
    // A button with no target is the "opens then stops" shape one layer up.
    const card = away({ certified_hostnames: [] });
    expect(card.url).toBeUndefined();
    expect(card.note_check).toBeUndefined();
  });

  it('⛔ and the check is not offered when nothing can run it', () => {
    expect(away({ can_check_address_here: false }).note_check).toBeUndefined();
  });
});

describe('D-273 — the router step, once the router has been asked', () => {
  const routerHint = (over: Record<string, unknown> = {}): string => {
    const cards = buildConnectDevicePlaces({
      lan_port: 7717, public_port: 443,
      certified_hostnames: ['home.example.com'],
      public_port_reachable: null,
      can_check_from_outside: false,
          can_check_address_here: false,
      ...over,
    } as Parameters<typeof buildConnectDevicePlaces>[0]);
    const away = cards.find((c) => c.place === 'other_devices')!;
    return away.steps!.find((st) => st.key === 'router')!.hint;
  };

  it('⚠ with nothing asked, the wording is exactly what it was', () => {
    // A reader on a server that never looked is where they were.
    expect(routerHint()).toContain('Your router settings screen shows this');
  });

  it('⛔⛔ CGNAT OVERRIDES EVERYTHING, including a router that says it can', () => {
    // Every other sentence is advice about a router. Behind carrier-grade NAT
    // the router is not the obstacle, and following any of that advice is an
    // afternoon on a setting that cannot work.
    const hint = routerHint({
      port_mapping: { enabled: true, support: 'enabled', cgnat: true, outcome: 'mapped' },
    });
    expect(hint).toContain('shares one address between many homes');
    expect(hint).not.toContain('Recued opened this port');
  });

  it('says when Recued opened it', () => {
    expect(routerHint({ port_mapping: { enabled: true, outcome: 'mapped' } }))
      .toContain('Recued opened this port on your router');
  });

  it('⛔ CREDITS THE OWNER for a forward they made — Recued must not claim it', () => {
    // Saying "Recued opened this" about their hand-made forward takes credit for
    // their work and implies Recued will take it down again.
    const hint = routerHint({ port_mapping: { enabled: true, outcome: 'foreign_ok' } });
    expect(hint).toContain('You set that up yourself');
    expect(hint).not.toContain('Recued opened');
  });

  it('⛔ `disabled` names a SWITCH TO FLIP; `unsupported` does not', () => {
    // The distinction P0 exists to keep, arriving at the reader. Collapsing it
    // would tell someone with a capable router that it cannot do this.
    expect(routerHint({ port_mapping: { enabled: false, support: 'disabled' } }))
      .toContain('switched off in its settings');
    expect(routerHint({ port_mapping: { enabled: false, support: 'unsupported' } }))
      .toContain('Your router settings screen shows this');
  });

  it('offers the feature when the router can but the toggle is off', () => {
    expect(routerHint({ port_mapping: { enabled: false, support: 'enabled' } }))
      .toContain('Recued can ask your router to open this for you');
  });

  it('⛔ AND NO LONGER SENDS THE READER TO A CONFIG FILE', () => {
    // This sentence used to end "turn on automatic port forwarding in your
    // server config" — for the one setting a beginner is most likely to need,
    // on the page whose whole job is to remove that kind of errand. The control
    // is in the row now; nothing here may name a file again.
    const hint = routerHint({ port_mapping: { enabled: false, support: 'enabled' } });
    expect(hint).not.toContain('server config');
    expect(hint).not.toContain('config.toml');
  });

  it.each([
    ['conflict', 'Another device on your network'],
    ['foreign_conflict', 'Something else on your router'],
  ])('%s names who holds the port', (outcome, expected) => {
    expect(routerHint({ port_mapping: { enabled: true, outcome } })).toContain(expected);
  });

  it('⚠ "Only needed away from home" survives EVERY variant', () => {
    // It is why the row exists, and it is not what the router told us. Only the
    // ADVICE changes.
    for (const pm of [
      undefined,
      { enabled: true, outcome: 'mapped' },
      { enabled: true, outcome: 'conflict' },
      { enabled: false, support: 'disabled' },
      { enabled: true, cgnat: true },
    ]) {
      expect(routerHint(pm === undefined ? {} : { port_mapping: pm }))
        .toContain('Only needed away from home');
    }
  });

  it('⚠ and a router that IS open still leads with that, then adds the detail', () => {
    const hint = routerHint({
      public_port_reachable: true,
      port_mapping: { enabled: true, outcome: 'mapped' },
    });
    expect(hint).toContain('A check from outside got in');
    expect(hint).toContain('Recued opened this port');
  });
});

// ──────────────────────────────────────────────────────────────────
// D-273 — the control, and the asymmetry between switching it on and off.
// ──────────────────────────────────────────────────────────────────
describe('D-273 — the port-mapping control', () => {
  const action = (pm?: ConnectDeviceFacts['port_mapping']) => {
    const cards = buildConnectDevicePlaces(
      certified(pm === undefined ? {} : { port_mapping: pm }),
    );
    const away = cards.find((c) => c.place === 'other_devices')!;
    return away.steps!.find((st) => st.key === 'router')!.action;
  };

  it('⚠ absent when nobody asked a router', () => {
    // Same rule as the copy beside it: no `port_mapping` is not a verdict, and a
    // switch offered on no information promises an outcome we cannot predict.
    expect(action()).toBeUndefined();
  });

  it('offers ON when the router says it can', () => {
    expect(action({ enabled: false, support: 'enabled' }))
      .toMatchObject({ kind: 'port_mapping', enable: true });
  });

  it('⛔⛔ NOT offered when the router says it will not — either way it says so', () => {
    // `disabled` has a switch the OWNER must flip in the router; `unsupported`
    // has none. Neither is a case where our toggle changes anything, and a
    // control that does nothing teaches the reader to distrust the page.
    expect(action({ enabled: false, support: 'disabled' })).toBeUndefined();
    expect(action({ enabled: false, support: 'unsupported' })).toBeUndefined();
  });

  it('⛔⛔ NOT offered behind CGNAT, EVEN THOUGH THE ROUTER WOULD SAY YES', () => {
    // The worst of the three to get wrong: the mapping SUCCEEDS and changes
    // nothing, so the reader gets a green answer to the wrong question and
    // spends the afternoon on a setting that cannot work.
    expect(action({ enabled: false, support: 'enabled', cgnat: true })).toBeUndefined();
  });

  it('⛔⛔ but OFF is offered on `enabled` ALONE — support and CGNAT are not consulted', () => {
    // The asymmetry, and the reason it is not one `support` check. Turning it on
    // is a PREDICTION; turning it off is a FACT about a port we opened. A router
    // that stopped answering, or an ISP that moved us behind CGNAT since, must
    // not be able to strand the owner with an opening they cannot close — that
    // is the gate-plus-non-decaying-state shape.
    for (const pm of [
      { enabled: true },
      { enabled: true, support: 'disabled' as const },
      { enabled: true, support: 'unsupported' as const },
      { enabled: true, cgnat: true },
      { enabled: true, support: 'enabled' as const, cgnat: true, outcome: 'mapped' as const },
    ]) {
      expect(action(pm)).toMatchObject({ kind: 'port_mapping', enable: false });
    }
  });

  it('⚠ the ON copy names the CONSEQUENCE and the way back', () => {
    // It opens a port on the reader's internet connection. A control that says
    // only what it gives you is the one people press without reading.
    const on = action({ enabled: false, support: 'enabled' })!;
    expect(on.note).toContain('opens a port on your internet connection');
    expect(on.note).toContain('Switch it off here');
  });

  it('⚠ and the OFF copy names what STOPS working', () => {
    const off = action({ enabled: true, outcome: 'mapped' })!;
    expect(off.note).toContain('Away from home stops working');
  });
});

// ──────────────────────────────────────────────────────────────────
// Audit P2-5 — "Ready anywhere" is a claim about the APP, not just the port.
// ──────────────────────────────────────────────────────────────────
describe('D-273 audit P2-5 — readiness answers for the whole path', () => {
  const away = (over: Partial<ConnectDeviceFacts> = {}) =>
    buildConnectDevicePlaces(certified({ public_port_reachable: true, ...over }))
      .find((c) => c.place === 'other_devices')!;

  it('⛔⛔ an OPEN PORT with the app SHUT is NOT Ready anywhere', () => {
    // The default. `exposure/bootstrap.ts` derives `webclient: { public: false }`,
    // so the address resolves, TLS completes, and /webclient/ 404s from outside
    // — while this card said "Ready anywhere. Both steps are done."
    const card = away({ webclient_public_exposed: false });
    expect(card.status).toBe('Ready at home');
    expect(card.body).not.toContain('at home or away');
  });

  it('⛔ and it SAYS what is shut, rather than leaving a tick missing', () => {
    const card = away({ webclient_public_exposed: false });
    const step = card.steps!.find((st) => st.key === 'app_path')!;
    expect(step.done).toBe(false);
    expect(step.hint).toContain('Exposure');
  });

  it('⚠ UNREAD exposure renders NO step and blocks nothing', () => {
    // `undefined` is a server too old to say, or a route that wired no exposure
    // caller. Inventing a blocker from it would send readers to change a setting
    // that may already be right.
    const card = away();
    expect(card.steps!.some((st) => st.key === 'app_path')).toBe(false);
    expect(card.status).toBe('Ready anywhere');
  });

  it('open port + open app ⇒ Ready anywhere, with no extra row', () => {
    const card = away({ webclient_public_exposed: true });
    expect(card.status).toBe('Ready anywhere');
    expect(card.steps!.some((st) => st.key === 'app_path')).toBe(false);
  });

  it('⛔⛔ does NOT promise "any device" when THIS device just failed to reach it', () => {
    // The outside check says the world can get in; `address_reachable_here:
    // false` says the machine in the reader's hands could not. Saying "any
    // device, at home or away" over the top of that is the page contradicting
    // its own evidence — and it is the hairpin case it already has prose for.
    const card = away({ webclient_public_exposed: true, address_reachable_here: false });
    expect(card.status).toBe('Ready anywhere');
    expect(card.body).toContain('could not reach it just now');
    expect(card.body).not.toContain('Both steps are done');
  });

  it('⚠ an UNTESTED from-here verdict still reads as the clean success', () => {
    // `null` is "nobody checked", which must not be rendered as a failure.
    const card = away({ webclient_public_exposed: true, address_reachable_here: null });
    expect(card.body).toContain('Both steps are done');
  });
});

// ──────────────────────────────────────────────────────────────────
// Audit P2-9 — the router does not always give the port we asked for.
// ──────────────────────────────────────────────────────────────────
describe('D-273 audit P2-9 — a mapping on another port is not a success', () => {
  const routerHint = (over: Partial<ConnectDeviceFacts>) => {
    const away = buildConnectDevicePlaces(certified(over))
      .find((c) => c.place === 'other_devices')!;
    return away.steps!.find((st) => st.key === 'router')!.hint;
  };

  it('⛔⛔ NAMES the port the router actually opened, instead of claiming ours', () => {
    // NAT-PMP may assign another port when the requested one is taken. The
    // backend recorded that faithfully; the route adapter dropped it, so a
    // mapping on 50000 rendered as "Recued opened this port" beside a card still
    // advertising 443 — an address that cannot work, shown as the success.
    const hint = routerHint({
      port_mapping: { enabled: true, outcome: 'mapped', external_port: 50_000 },
    });
    expect(hint).toContain('50000');
    expect(hint).not.toContain('Recued opened this port on your router');
  });

  it('⚠ and says the same thing it always did when the ports agree', () => {
    expect(routerHint({
      port_mapping: { enabled: true, outcome: 'mapped', external_port: 443 },
    })).toContain('Recued opened this port on your router');
  });

  it('⚠ an UNREPORTED external port is not treated as a mismatch', () => {
    // A server too old to send it must not make the page invent a problem.
    expect(routerHint({ port_mapping: { enabled: true, outcome: 'mapped' } }))
      .toContain('Recued opened this port on your router');
  });
});

/** D-273 — the port the owner asked for, when the server could not move to it.
 *
 *  ⛔ THIS IS THE WHOLE OWNER-FACING REPORT OF A FAILED LIVE PORT CHANGE.
 *  `server.setConfigField` resolves as soon as the key is persisted; the rebind
 *  runs after the reply, and on failure the server keeps the working port and
 *  writes one `console.warn`. The settings field then reads the NEW number while
 *  this page reads the OLD one — two surfaces disagreeing, with nothing to say
 *  why, until the server started sending `public_port_requested`. */
describe('a port change that did not take', () => {
  it('⛔⛔ says the change did not apply, and leads with the port that WORKS', () => {
    const [, others] = buildConnectDevicePlaces(
      certified({ public_port: 443, public_port_requested: 8446 }),
    );
    const note = others!.portNote;
    // The served port first: the address above is built from it and it works.
    expect(note).toContain('443');
    expect(note).toContain('8446');
    expect(note.indexOf('443')).toBeLessThan(note.indexOf('8446'));
    // ⛔ IT MUST NOT READ AS AN ERROR ABOUT THE ADDRESS BEING HANDED OVER. That
    // address is fine; what failed is the setting.
    expect(others!.state).toBe('ready');
    expect(others!.url).toContain('home.example.com');
    expect(others!.url).not.toContain('8446');
  });

  it('⛔ names a way out that is not "retype the number you already typed"', () => {
    // ⚠ The config ALREADY holds the requested port, so "your change did not
    // apply" on its own sends the reader back to a field that looks correct and
    // to an action guaranteed not to help.
    const [, others] = buildConnectDevicePlaces(
      certified({ public_port: 443, public_port_requested: 8446 }),
    );
    expect(others!.portNote).toMatch(/different|free that port/i);
  });

  it('says nothing at all when the ports agree', () => {
    // ⛔ ABSENCE IS THE NORMAL CASE. A note that renders on every healthy server
    // is one every reader learns to skip, including on the day it is true.
    const [, others] = buildConnectDevicePlaces(certified({ public_port: 443 }));
    expect(others!.portNote).toContain('443');
    expect(others!.portNote).not.toMatch(/asked for|could not open|did not/i);
  });

  it('⚠ the port THIS COMPUTER uses is unaffected — the LAN listener did not move', () => {
    // The failed change is on the public listener. Saying anything about it on
    // the loopback card would be borrowing another listener's problem.
    const [here] = buildConnectDevicePlaces(
      certified({ public_port: 443, public_port_requested: 8446 }),
    );
    expect(here!.portNote).not.toContain('8446');
  });
});

