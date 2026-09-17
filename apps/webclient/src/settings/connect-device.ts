/** Settings — Server — Connect a device: the projection behind the page that
 *  answers "it says port 7717, now what?".
 *
 *  ⛔ THE QUESTION HAD NO SURFACE. Exposure answers WHICH PATHS ARE PUBLIC and
 *  Reachability answers WHETHER THE INTERNET CAN SEE THIS SERVER — both are
 *  operator tools for a server that is already reachable. A beginner has neither
 *  question yet.
 *
 *  🔑 ORGANISED BY WHERE THE READER IS, with the port as a DETAIL inside each
 *  answer. A port-shaped page is the right model for an operator and the wrong one
 *  for the person this page exists for: they do not think "7717 or 443", they
 *  think "can I open this on my phone?". Two answers, because there are two:
 *
 *    - **This computer** — nothing to do. Port 7717 is always bound, and the
 *      browser trusts the machine it is running on.
 *    - **Every other device, at home and away** — one certificate. Port 443
 *      serves the visitor page and the app together, so it is one port and not
 *      two; and the public listener binds every interface, so the SAME address
 *      answers a phone in the house and a laptop in another country. Away from
 *      home adds ONE row — traffic through the router — and that row is marked
 *      away-only rather than given a card of its own.
 *
 *  ⛔ IT WAS THREE CARDS UNTIL 2026-09-15. "At home" and "away" shared an
 *  address, a port and a certificate and differed by a single checklist row, so
 *  the reader was left to notice that two of the three answers were the same
 *  answer.
 *
 *  ⚠ COPY IS HELD TO THE DOCS READABILITY GATE (avg <= 12 words, longest <= 24,
 *  FK <= 4.5). A settings page a non-technical owner cannot read is not a simpler
 *  version of this problem, it is the same problem with more words.
 *
 *  ⛔⛔ THE CERTIFICATE IS THE ONLY LEVER, AND THE REASON IS A BROWSER RULE, not
 *  a Recued one, so no server configuration removes it:
 *
 *    - `http://127.0.0.1:7717` is a SECURE CONTEXT (loopback is the browser's
 *      own exception), so `crypto.subtle` exists and the embedded webclient
 *      boots — same-origin with the server it pairs to.
 *    - `http://192.168.x.x:7717` is NOT. The page loads and then stops at the
 *      webclient's own guard, which is why `serve/log-boot-banner.ts` refuses to
 *      print a LAN address and `settings/server-url.ts` rejects `ws://<lan-ip>`.
 *    - `https://app.recued.com` + a `ws://` server is refused by the browser
 *      before a byte leaves it — close 1006, indistinguishable from an unplugged
 *      cable (`net/insecure-origin.ts`). Chrome excepts loopback; Safari and
 *      Firefox do not.
 *
 *  ⚠ AND THE CERTIFICATE HAS FREE ROUTES, which a page that only said "needs a
 *  certificate" would hide behind the Pro upsell. `path-listener-coordinator.ts`:
 *  "null/empty holder → public listener binds plaintext (upstream-proxy mode)" —
 *  so anything holding a cert in front works, and `CERTIFICATE_ROUTES` names
 *  three that cost the reader nothing. Pro is the same outcome with the work
 *  removed, not the only way to get there.
 *
 *  Pure by design: no DOM, no rpc. The mount renders; this owns what is true.
 *
 *  See internal design notes D-272. */


/** Where the reader is trying to open Recued from — which is also, exactly, the
 *  two ports. `this_computer` is 7717; `other_devices` is 443, at home and away
 *  alike. See the note on `buildConnectDevicePlaces` for why that is two answers
 *  and not three. */
export type ConnectDevicePlace = 'this_computer' | 'other_devices';

/** `ready` needs nothing. `one_step` needs a certificate — and that is all it
 *  needs, which is why it is not called "blocked" or "not yet". */
export type ConnectDeviceState = 'ready' | 'one_step';

export interface ConnectDeviceFacts {
  /** `bootstrap.bind_port` — always bound. */
  lan_port: number;
  /** `public_port` — serves the visitor page and the app together. */
  public_port: number;
  /** Hostnames that resolve to this server AND hold a live certificate.
   *
   *  ⚠ `null` MEANS NOBODY ASKED, and is not `[]`. Telling someone they have no
   *  certificate when nothing looked is the same mistake as calling an unprobed
   *  server unreachable. */
  certified_hostnames: readonly string[] | null;
  /** Whether a check from OUTSIDE this network reached `public_port`.
   *
   *  🔑 THIS IS THE ROUTER STEP, ANSWERED. This machine cannot read a router's
   *  forwarding table, which is why the step shipped permanently unknown — but
   *  the reachability probe asks from the other side of the router, so the answer
   *  exists and only had to be carried here. Folded from a `DiagnosticResponse`
   *  by `diagnosticPortReachability`.
   *
   *  ⚠ `null` MEANS NOBODY CHECKED, and is not `false`. The probe reports
   *  `blocked` and `no_response` separately; both mean "did not get in" to a
   *  reader deciding whether to open their router's settings, and neither is the
   *  same as never having asked. */
  public_port_reachable: boolean | null;
  /** Whether a check from outside can be run from here at all. It needs an
   *  account and a name the probe is allowed to ask about, so it is a fact about
   *  this install, not a rendering choice — and it decides whether the unknown
   *  state offers a check or sends the reader to their router. */
  can_check_from_outside: boolean;
  /** D-272 — did THIS browser, on THIS network, reach the certified address?
   *
   *  🔑 THE ONLY THING THAT CAN SEE NAT HAIRPIN. A certified address points at
   *  the house FROM THE INTERNET, so a phone already inside has to be turned
   *  back in by the router; plenty will not. ⛔ The cloud probe cannot see it —
   *  it asks from outside and reports the port reachable while the phone in the
   *  kitchen fails. A fetch from the browser that is actually standing there can.
   *
   *  ⚠ MEASURED, 2026-09-16, real Chromium: a cross-origin `no-cors` fetch
   *  RESOLVES only after DNS resolved, TCP connected, TLS verified against a
   *  TRUSTED cert, and an HTTP response returned (an untrusted cert rejects).
   *  ⇒ `true` is a strong positive. But every rejection is the same
   *  `TypeError: Failed to fetch` — TLS, refused and DNS are indistinguishable —
   *  so `false` means "did not reach", NEVER a named cause.
   *
   *  ⛔ AND IT CANNOT KNOW WHERE THE DEVICE IS. The webclient may be open on
   *  mobile data, where a `true` means "works from the internet", not "works at
   *  home". The copy says "this device" and lets the reader supply the context;
   *  it never claims to have diagnosed a router. */
  address_reachable_here?: boolean | null;
  /** Whether that check can run from here: there has to be an address to try. */
  can_check_address_here: boolean;
  /** D-273 — what the router says about opening the port, and what Recued did.
   *
   *  🔑 THIS IS WHAT TURNS ONE INSTRUCTION INTO SEVERAL ANSWERS. The router step
   *  told every reader to forward the public port — including the one whose
   *  router has the feature switched off (where that instruction is wrong), the
   *  one whose router already forwards it (where it is redundant), and the one
   *  behind carrier-grade NAT (where it cannot work at all).
   *
   *  ⚠ ABSENT MEANS NOBODY ASKED, and the step keeps the wording it had. */
  /** D-273 audit P2-5 — is the webclient PATH open to the internet?
   *
   *  ⛔⛔ A REACHABLE PORT IS NOT A REACHABLE APP, AND THE DEFAULT SPLITS THEM.
   *  `exposure/bootstrap.ts` derives `webclient: { lan: true, public: false }`,
   *  so on a stock install the address resolves, TLS completes, and `/webclient/`
   *  returns 404 from outside. This page said "Ready anywhere — both steps are
   *  done" through all of that: it had checked the port and never the path.
   *
   *  ⚠ ABSENT MEANS NOBODY ASKED and renders no step at all. `false` is a fact
   *  worth a row; `undefined` is a server too old to say, or an exposure caller
   *  the route did not wire, and inventing a blocker from it would send readers
   *  to change a setting that may already be right. */
  webclient_public_exposed?: boolean;
  port_mapping?: {
    enabled: boolean;
    support?: 'enabled' | 'disabled' | 'unsupported';
    /** ⛔ WHEN TRUE, THE WHOLE STEP IS POINTLESS — the ISP is NATing upstream, so
     *  no forwarding rule on this router can make the address reachable. */
    cgnat?: boolean;
    outcome?:
      | 'idle' | 'mapped' | 'released' | 'unavailable' | 'failed'
      | 'foreign_ok' | 'foreign_conflict' | 'conflict';
    /** The external port the router ACTUALLY gave, when it said.
     *
     *  ⛔⛔ NOT NECESSARILY THE ONE WE ASKED FOR, AND THE DIFFERENCE IS THE WHOLE
     *  ADDRESS. NAT-PMP may assign another port when the requested one is taken.
     *  The backend recorded that faithfully and the route adapter dropped it, so
     *  a mapping on 50000 was rendered as "Recued opened this port" beside a
     *  card still advertising 443 — an address that cannot work, presented as
     *  the success. */
    external_port?: number;
  };
}

/** Which step this is. The panel hangs the check button off `router`, so it must
 *  not have to recognise the step by reading its label — the label is copy, and
 *  copy is the thing most likely to change. */
export type ConnectDeviceStepKey = 'certificate' | 'router' | 'app_path';

/** The checks a card's note can carry. See `note_check`.
 *  ⚠ ONE MEMBER SINCE THE LAN-EXPOSURE WARNING MOVED TO EXPOSURE. Kept as a
 *  union rather than collapsed to a boolean: the reason it stopped being a
 *  boolean — two cards carrying notes that call different things — is still the
 *  reason a second member would need naming rather than guessing. */
export type ConnectDeviceNoteCheck = 'address_from_here';

/** One thing a place needs before it works.
 *
 *  ⛔ `done: null` MEANS WE CANNOT TELL, and is not `false`. The router step is the
 *  case that forces this: nothing on this machine can see whether a home router
 *  forwards a port, so drawing it unticked would state a fact we do not have — the
 *  same mistake as calling an unprobed server unreachable. It renders as "check
 *  this", offering the check that CAN answer. */
export interface ConnectDeviceStep {
  key: ConnectDeviceStepKey;
  label: string;
  done: boolean | null;
  /** Where the reader goes to do it, or to find out. */
  hint: string;
  /** D-273 — a control that DOES this step, when there is one that can.
   *
   *  ⛔ IT DOES NOT REVERSE THE CHECK CONSOLIDATION. Three check buttons became
   *  one because all three answered the same question and it was a question
   *  about BOTH cards. This is not a check and it answers nothing: it is the
   *  one SETTING on this page, it belongs to this row alone, and the sentence
   *  that tells the reader they want it is in this row's own hint. A control
   *  placed below both cards would be an instruction to go and find it. */
  action?: ConnectDeviceStepAction;
}

/** The only action a step can offer today. A named union rather than a boolean
 *  for the reason `note_check` is one: a second member would be a DIFFERENT
 *  thing to do, and the mount must never infer which from the row it is on. */
export interface ConnectDeviceStepAction {
  kind: 'port_mapping';
  /** What pressing it sets `network.auto_port_mapping` to. */
  enable: boolean;
  label: string;
  /** What it will do, in the reader's words. Shown beside the control. */
  note: string;
}

export interface ConnectDevicePlaceCard {
  place: ConnectDevicePlace;
  /** Heading, in the reader's words. */
  title: string;
  state: ConnectDeviceState;
  /** Two or three words, shown as a chip. */
  status: string;
  /** What to do, or what is missing. Short sentences on purpose. */
  body: string;
  /** What the reader gets when this works — shown even BEFORE it does, because a
   *  page that only lists work is a page nobody finishes. */
  payoff?: string;
  /** The things this place needs, as a checklist. Empty when nothing is needed. */
  steps?: readonly ConnectDeviceStep[];
  /** Present only when opening it actually works. */
  url?: string;
  /** One line of "if that did not work", under the address. Its own field and
   *  not a fourth sentence in `body`, because a reader skims a paragraph and
   *  reads a line — and this is the line they need only once something has
   *  already gone wrong. */
  note?: string;
  /** Which check this card's note carries, if any.
   *
   *  ⛔ NAMED, NOT A BOOLEAN. Two cards now carry a note with a button and they
   *  call different things — `lan_exposure` asks the CLOUD about a port that
   *  should not be open, `address_from_here` asks THIS BROWSER whether an address
   *  answers. A shared boolean would have the mount guess from the card, which is
   *  how one card ends up running the other's check.
   *
   *  ⛔ AND THEIR POLARITIES DISAGREE: `lan_exposure` dreads a `true`;
   *  `address_from_here` wants one. Keeping them on separate cards with separate
   *  names is what stops a reader carrying one sign to the other. */
  note_check?: ConnectDeviceNoteCheck;
  /** The port this place uses — a detail, shown small. */
  portNote: string;
}

const publicOrigin = (hostname: string, port: number): string =>
  (port === 443 ? `https://${hostname}` : `https://${hostname}:${port}`);

/** Build the two answers, easiest first.
 *
 *  🔑 TWO, NOT THREE — CONSOLIDATED 2026-09-15. "At home" and "away" were
 *  separate cards that shared an address, a port and a certificate, and differed
 *  by ONE checklist row. Three cards for one answer is not thoroughness, it is
 *  the reader doing the de-duplication we should have done. The router row keeps
 *  its own line and says it is away-only, so the distinction that earned the
 *  split survives without a card around it.
 *
 *  ⚠ The port mapping this settled on, and why it is not what it looks like:
 *
 *    - **7717 is this computer.** It is the LAN listener and it does serve the
 *      LAN — but PLAIN HTTP, which a browser will not run the app from unless
 *      the address is the machine itself. Non-browser clients on the LAN (MCP,
 *      anything scripted) use 7717 happily; the browser is the one client
 *      carrying the extra rule, and this page is the browser surface.
 *    - **443 is every other device, at home AND away.** The public listener
 *      binds `0.0.0.0` (`DEFAULT_PUBLIC_BIND_ADDRESS`), so it is already on the
 *      LAN interface — a phone in the house reaches it without leaving the
 *      switch, provided the name resolves to the local address. Away from home
 *      is the SAME address on the SAME port; only the router step is added. */
export const buildConnectDevicePlaces = (
  facts: ConnectDeviceFacts,
): readonly ConnectDevicePlaceCard[] => {
  const certified = facts.certified_hostnames?.[0];
  const unread = facts.certified_hostnames === null;
  const loopback = `http://127.0.0.1:${facts.lan_port}`;
  const secure = certified === undefined
    ? undefined
    : publicOrigin(certified, facts.public_port);

  const thisComputer: ConnectDevicePlaceCard = {
    place: 'this_computer',
    title: 'On this computer',
    state: 'ready',
    status: 'Ready',
    body:
      'Open the link below. There is nothing to set up. The page comes from '
      + 'your own server, so your browser already trusts it.',
    url: `${loopback}/webclient/`,
    // ⛔ THE LAN-EXPOSURE WARNING USED TO LIVE HERE AND HAS MOVED TO EXPOSURE.
    // It failed the only test that matters for this page: is it a PREREQUISITE
    // for connecting a device? Everything else here is — a certificate, a
    // forwarded port, an address that resolves — and each is something the
    // reader must get right before a device can connect. That one is a SECURITY
    // FINDING with nothing downstream depending on it, and a reader can connect
    // every device they own with it unresolved.
    // ⛔ THE NOTE IS ABOUT THE ADDRESS, NOT ABOUT THE PORT — it used to say
    // "Nothing leaves your computer", which is true of this LINK and FALSE of
    // this LISTENER. `resolveLanAddress` binds `0.0.0.0` whenever exactly one
    // RFC1918 address is found (or several plus a matching default route) —
    // the ordinary home case — so `lan_port` is on EVERY interface, and there
    // is no source-address filter anywhere in the path router. Whether that
    // reaches the internet depends on a firewall this machine cannot see.
    // ⇒ Say what is true of the thing the reader is about to click. The
    // listener's reach is a real question and it belongs on Exposure, not in a
    // reassurance on a beginner's first screen.
    portNote: `Uses port ${facts.lan_port}. This address is your own machine, `
      + `so the page never leaves it.`,
  };

  // ⛔ THE ROUTER STEP IS NAMED UP FRONT, NOT AFTER A FAILURE. It used to appear
  // only once a certificate existed, as "if it does not load…". That is the shape
  // of a page that lets someone finish one task, believe they are done, and find
  // out later. Pro removes the certificate work; it does NOT remove this — the
  // cloud publishes the name and issues the certificate, but traffic goes
  // straight to this machine, and nothing here opens a router port (`upnp_status`
  // is REPORTED by diagnostics, never acted on).
  //
  // 🔑 AND IT IS NO LONGER PERMANENTLY UNKNOWN. "Nothing here can see a router's
  // forwarding table" is true and was the wrong conclusion: the check does not
  // have to run HERE. The reachability probe asks from outside the router, which
  // is the only place the question can be answered.
  //
  // ⚠ EVERY STATE SAYS "AWAY FROM HOME" FIRST, because on a consolidated card
  // this is the one row that is not needed by everybody. Without it the reader
  // takes an untickable box as work they owe before their phone will work in the
  // kitchen, and it is not.
  const routerOpen = facts.public_port_reachable;

  /** What to tell THIS reader about opening the port, or null to keep the
   *  wording the step had before any of this existed.
   *
   *  ⛔ CGNAT IS CHECKED FIRST AND OVERRIDES EVERYTHING. Every other sentence
   *  here is advice about a router; behind carrier-grade NAT the router is not
   *  the obstacle and following any of that advice is an afternoon spent on a
   *  setting that cannot work. It is the one answer worth interrupting for.
   *
   *  ⚠ ORDER BELOW IS "WHAT IS TRUE OF THIS READER", not severity: a mapping we
   *  made and a forward they made are both successes and are said differently,
   *  because the second one is theirs and Recued must not claim it. */
  const portMappingNote = (): string | null => {
    const pm = facts.port_mapping;
    if (pm === undefined) return null;
    if (pm.cgnat === true) {
      return 'Your internet provider shares one address between many homes. '
        + 'Opening a port cannot reach you. Tailscale avoids this.';
    }
    if (pm.outcome === 'mapped') {
      // ⛔ A DIFFERENT PORT IS NOT THIS PORT. Saying "Recued opened this port"
      // over a mapping the router put somewhere else hands the reader an address
      // that refuses, with a tick beside it.
      return pm.external_port !== undefined && pm.external_port !== facts.public_port
        ? `Your router would not give us port ${String(facts.public_port)} — it opened `
          + `${String(pm.external_port)} instead, so the address above will not work `
          + 'from outside. Free that port, or set the public port to '
          + `${String(pm.external_port)}.`
        : 'Recued opened this port on your router.';
    }
    if (pm.outcome === 'foreign_ok') {
      // ⚠ Credited to them. Saying "Recued opened this" about a forward the
      // owner set up by hand takes credit for their work and, worse, implies
      // Recued will take it down again.
      return 'Your router already sends this port here. You set that up yourself.';
    }
    if (pm.outcome === 'conflict') {
      return 'Another device on your network is using this port.';
    }
    if (pm.outcome === 'foreign_conflict') {
      return 'Something else on your router is using this port.';
    }
    if (pm.support === 'disabled') {
      // ⛔ The one actionable answer, and the one most easily lost: this owner
      // has a switch to flip, and the `unsupported` owner does not.
      return 'Your router can open this by itself, but that is switched off in '
        + 'its settings.';
    }
    if (pm.support === 'enabled' && !pm.enabled) {
      // ⚠ NO LONGER NAMES A FILE. This used to end "turn on automatic port
      // forwarding in your server config" — an instruction to leave the page,
      // find a TOML file and edit it by hand, for the one setting a beginner is
      // most likely to need. The control is now in this row; `portMappingAction`
      // returns it for exactly this case.
      return 'Recued can ask your router to open this for you.';
    }
    return null;
  };

  /** D-273 — whether to offer the toggle, and which way it points.
   *
   *  ⛔⛔ OFFER "ON" ONLY WHERE WE HAVE REASON TO THINK IT WILL WORK; OFFER
   *  "OFF" WHENEVER IT IS ON. The two halves are NOT symmetric and must not be
   *  collapsed into one `support` check:
   *
   *  — Turning it on is a PREDICTION. `support === 'enabled'` is the router
   *    saying it does this; `'disabled'` and `'unsupported'` are it saying it
   *    will not, and `undefined` is nobody having asked. Offering a switch in
   *    those three cases promises an outcome we have no basis for, and the
   *    reader who flips it and sees nothing happen learns to distrust the page.
   *    ⛔ CGNAT OVERRIDES EVEN A WILLING ROUTER: the mapping SUCCEEDS and
   *    changes nothing, which is the worst of the three — a green answer to the
   *    wrong question.
   *
   *  — Turning it off is a FACT. It is on, the owner may want it down, and the
   *    schema's own copy promises "Recued takes it down again when you switch
   *    this off". So the off switch is offered on `enabled` ALONE — no support
   *    check, no CGNAT check. A router that stopped answering, an ISP that
   *    moved us behind CGNAT since, a server that has not looked yet: none of
   *    them is a reason to withhold the control that closes a port we opened.
   *    ⚠ Withholding it there would be the livelock shape — a state reachable
   *    only while a condition holds, and no way out when it stops. */
  const portMappingAction = (): ConnectDeviceStepAction | undefined => {
    const pm = facts.port_mapping;
    if (pm === undefined) return undefined;
    if (pm.enabled) {
      return {
        kind: 'port_mapping',
        enable: false,
        label: 'Stop opening this port',
        note: 'Recued takes the opening down. Away from home stops working '
          + 'unless your router forwards this port by itself.',
      };
    }
    if (pm.cgnat === true) return undefined;
    if (pm.support !== 'enabled') return undefined;
    return {
      kind: 'port_mapping',
      enable: true,
      label: 'Open this port for me',
      note: 'Recued asks your router to send this port here, and keeps asking '
        + 'while the server runs. This opens a port on your internet '
        + 'connection. Switch it off here to take it down again.',
    };
  };
  const routerStep: ConnectDeviceStep = {
    key: 'router',
    label: routerOpen === true
      ? `Port ${facts.public_port} reaches this computer from outside`
      : `Let port ${facts.public_port} through your router`,
    done: routerOpen,
    // ⚠ THE PORT-MAPPING SENTENCE REPLACES THE ADVICE, NOT THE CONTEXT. "Only
    // needed away from home" is why the row exists and stays regardless; what
    // changes is what the reader is told to do about it, which is the whole
    // point of having asked the router.
    hint: routerOpen === true
      ? `A check from outside got in. Away from home works.${
        portMappingNote() !== null ? ` ${portMappingNote() ?? ''}` : ''}`
      : `Only needed away from home. ${
        portMappingNote()
        ?? (routerOpen === false
          ? 'A check from outside could not get in. Change this in your router '
            + 'settings.'
          : facts.can_check_from_outside
          // The check is one button away, so the hint offers it rather than
          // naming a page the reader would have to go and interpret.
          ? 'Recued can check this from outside.'
          : 'Your router settings screen shows this.')}`,
    ...(portMappingAction() !== undefined
      ? { action: portMappingAction() as ConnectDeviceStepAction }
      : {}),
  };

  const certificateStep: ConnectDeviceStep = secure === undefined
    ? {
        key: 'certificate',
        label: 'A safe web address',
        done: false,
        hint: 'Free. Pick a way below.',
      }
    : {
        key: 'certificate',
        label: 'A safe web address',
        done: true,
        hint: `${certified!} is ready.`,
      };

  /** D-273 audit P2-5 — the app path, which is a DIFFERENT question from the port.
   *
   *  ⚠ RENDERED ONLY WHEN WE KNOW IT IS SHUT. A row saying "the app is open"
   *  would be a third tick nobody needs and a fourth thing to read; a row saying
   *  "we have not looked" would be worse than silence. So the checklist grows by
   *  one only in the state that blocks the reader. */
  const appPathStep: ConnectDeviceStep | null =
    facts.webclient_public_exposed === false
      ? {
          key: 'app_path',
          label: 'Let the app itself answer from outside',
          done: false,
          hint: 'Your router may let the port through, but Recued is not serving '
            + 'the app to the internet yet, so the address opens to nothing. '
            + 'Turn on the webclient under Settings → Server → Exposure.',
        }
      : null;

  // ⚠ THE STATUS REPORTS REACH, NOT A COUNT. "Ready at home" and "Ready
  // anywhere" are the two things a reader actually wants to know, and the
  // difference between them is exactly the router row. A count ("one thing
  // left") would say the same thing in a way nobody can act on.
  // ⛔ "ANYWHERE" NEEDS THE PORT *AND* THE PATH. It used to need only the port,
  // so a default install — where `webclient.public` is false — announced Ready
  // anywhere while `/webclient/` 404'd from the internet.
  const awayWorks = routerOpen === true && facts.webclient_public_exposed !== false;
  const status = secure === undefined
    ? 'One thing to set up'
    : awayWorks ? 'Ready anywhere' : 'Ready at home';

  // ⛔ THE ONE PROMISE ON THIS CARD WE CANNOT KEEP, NAMED RATHER THAN HIDDEN.
  // A certified address points at the house FROM THE INTERNET, so a phone
  // already inside has to be sent back in by the router. Plenty of home routers
  // will not do that, and then the address that works from a train fails on the
  // sofa — the exact "opens then stops" failure this page exists to prevent,
  // just relocated.
  //
  // ⚠ AND NOTHING HERE CAN DETECT IT. The check asks from OUTSIDE, so it would
  // report the port reachable while the phone in the kitchen still fails. That
  // is why this is copy and not a step: a step implies something looked.
  //
  // ⚠ A LAN ADDRESS IS NOT THE FALLBACK. `network.local_urls` can hand back
  // `http://192.168.1.42:7717`, and `LocalServerUrl` says plainly that LAN is
  // plain http — so offering it would be handing over an address that opens a
  // page and then refuses to start. Tailscale is the real answer, named here
  // even though the routes stop rendering once a certificate exists.
  // ⛔ THREE STATES, AND THE MIDDLE ONE IS THE HONEST LIMIT OF THE INSTRUMENT.
  // A rejection is measured to be indistinguishable across TLS, refused and DNS
  // — so the failed wording names the router as ONE possibility beside the
  // network, and asserts neither. The unchecked wording is what shipped before
  // the check existed, unchanged: a reader who has not run it is exactly where
  // they were.
  //
  // ⚠ "This device", never "at home" — the browser cannot know which network it
  // is on. The reader knows where they are standing; we do not.
  const homeRouterNote =
    facts.address_reachable_here === true
      ? 'This device reached that address just now. If you are at home, your '
        + 'router sends your address back inside.'
      : facts.address_reachable_here === false
      // ⛔⛔ HAIRPIN DEPENDS ON THE PORT FORWARD, so a failure here has a cause
      // the first draft of this copy never named. A device inside resolves the
      // name to the PUBLIC ip; the packet reaches the router's WAN side and needs
      // a forwarding rule before there is anything to send back in. ⇒ With no
      // forward the check fails too, and from inside "not forwarded" and "will
      // not hairpin" are INDISTINGUISHABLE.
      //
      // 🔑 So the reading depends on what the OTHER check found. Router
      // confirmed open ⇒ the forward exists and hairpin is the live suspect.
      // Router unknown or shut ⇒ the forward is the likelier answer, and naming
      // hairpin first would send a beginner hunting an exotic router setting
      // instead of doing the step they have not done.
      ? facts.public_port_reachable === true
        ? 'This device could not reach that address just now. Your router lets '
          + 'the internet in, so it may not send your own address back inside. '
          + 'Tailscale avoids this.'
        : 'This device could not reach that address just now. The port may not '
          + 'be open in your router yet. It can also be a router that will not '
          + 'send your address back inside.'
      : 'If it does not open at home, your router is not sending your address '
        + 'back inside. Tailscale avoids this.';

  const body = (): string => {
    if (secure === undefined) {
      return unread
        // Same answer, without claiming a fact nothing read.
        ? 'Your phone will not open a plain web address. It needs a safe one, '
          + 'the kind that starts with https. That takes a certificate.'
        : 'Your phone will not open a plain web address. It needs a safe one, '
          + 'the kind that starts with https. That takes a certificate. It is free.';
    }
    if (awayWorks) {
      // ⛔ AND NOT WHEN THIS VERY DEVICE JUST FAILED TO REACH IT. The outside
      // check says the world can get in; `address_reachable_here === false` says
      // the machine the reader is holding could not. Telling them "any device"
      // over the top of that is the page contradicting its own evidence — and
      // it is the hairpin case, which this card already has prose for.
      return facts.address_reachable_here === false
        ? 'Open the address below on any device away from home. ⚠ This device '
          + 'could not reach it just now — if you are at home, your router may '
          + 'not send the address back inside. Tailscale solves that.'
        : 'Open the address below on any device, at home or away. Both steps '
          + 'are done.';
    }
    return 'Open the address below on any device in your home. To use it away '
      + 'from home, finish the steps above.';
  };

  const otherDevices: ConnectDevicePlaceCard = {
    place: 'other_devices',
    title: 'On any other device',
    // ⚠ READY THE MOMENT A CERTIFICATE EXISTS. The address works at home
    // whatever the router does — a router has no say in traffic that never
    // leaves the house — so withholding it until the router step passes would
    // hide a working address from someone who has one.
    state: secure === undefined ? 'one_step' : 'ready',
    status,
    body: body(),
    // ⛔ THE PAYOFF IS FOR SOMEBODY WHO HAS NOT DONE THE WORK. Once a
    // certificate exists it earned nothing and cost twice: it repeated the
    // body's "Open …" sentence, and it promised "from anywhere" on a card whose
    // own status said "Ready at home". Reading the page as plain text is what
    // showed it — every assertion was green, because each half was true alone.
    ...(secure === undefined
      ? {
          payoff:
            'One web address for your phone, your laptop, and anywhere you go. '
            + 'Recued Pro gives you one, like yourname.recued.net, and keeps it working.',
        }
      : {}),
    steps: [certificateStep, routerStep, ...(appPathStep !== null ? [appPathStep] : [])],
    // ⚠ THE NOTE AND ITS CHECK BOTH HANG OFF `secure`. With no certificate there
    // is no address to try, so there is nothing to check — and offering a button
    // with no target is the "opens then stops" shape one layer up.
    ...(secure !== undefined
      ? {
          url: `${secure}/webclient/`,
          note: homeRouterNote,
          ...(facts.can_check_address_here
            ? { note_check: 'address_from_here' as const }
            : {}),
        }
      : {}),
    portNote:
      `Uses port ${facts.public_port}. The same port shows your visitor page, `
      + 'so there is only one to set up.',
  };

  return [thisComputer, otherDevices];
};

/** The free ways to get a certificate, each with what to run.
 *
 *  ⛔ A ROUTE WITHOUT ITS COMMAND IS A NAME, NOT AN ANSWER. An earlier version
 *  said "put a reverse proxy in front" and stopped, which leaves the reader
 *  knowing the word for the thing they cannot do.
 *
 *  ⚠ ORDER IS BY WHAT THE READER ALREADY HAS. Tailscale leads because it needs
 *  neither a domain nor an open router port — the free self-hoster's actual
 *  starting position — and it is the only one that covers away-from-home without
 *  a second step.
 *
 *  ⚠ Pro is NOT a fourth row. It is the same outcome with the work removed, so it
 *  is a footnote. A paid row among three free ones invites the reading that the
 *  free ones are second-best; they are what most self-hosters should use. */
export interface CertificateRoute {
  title: string;
  /** Who it is for, in the reader's terms. */
  when: string;
  detail: string;
  /** True when this route also covers away-from-home with no router step. */
  coversAway: boolean;
  /** Copy-pasteable. Rendered as a code block, never as prose. */
  command?: string;
}

/** The heading over the routes. Without one they begin mid-page as a bare
 *  "Tailscale — …", which reads as a wall rather than as a list of answers to
 *  the step directly above. */
export const CERTIFICATE_ROUTES_HEADING = 'Free ways to get a safe web address';

export const CERTIFICATE_ROUTES: readonly CertificateRoute[] = [
  {
    title: 'Tailscale',
    when: 'Best if you have no web address of your own',
    detail:
      'Tailscale links your devices privately and gives you a safe address. '
      + 'It works at home and away, and your router needs no changes. Install it '
      + 'on this computer and on your phone. Then run this here.',
    coversAway: true,
    command:
      'tailscale cert my-server.my-tailnet.ts.net\n'
      + 'tailscale serve --bg https / http://127.0.0.1:7717',
  },
  {
    title: 'Caddy',
    when: 'Best if you own a web address',
    detail:
      'Caddy is a small helper that gets and renews your certificate. Point your '
      + 'web address at your home, save this as a file named Caddyfile, then run '
      + 'caddy run. To use it away from home, let traffic in through your router.',
    coversAway: false,
    command: 'recued.example.com {\n\treverse_proxy 127.0.0.1:7717\n}',
  },
  {
    title: 'A certificate you already have',
    when: 'Best if someone set one up for you',
    detail: 'Upload it under Settings, then Server, then Certificates.',
    coversAway: false,
  },
];

/** One line, after the routes. See the note above for why Pro is not one.
 *
 *  ⚠ IT SAYS WHAT PRO DOES *NOT* DO, and that sentence is not a hedge. The cloud
 *  publishes the name and issues the certificate; traffic still goes straight to
 *  this machine, so away-from-home needs the router port either way. The earlier
 *  wording ("there is nothing to set up") was true of the certificate and false of
 *  the thing a reader would try next — which is how someone pays, finishes, and
 *  then finds out. */
/** The line above the two cards.
 *
 *  ⛔ IT LIVED IN THE MOUNT UNTIL 2026-09-15, which meant the readability gate
 *  never saw it — `allCopy` walks this module, so the one sentence every reader
 *  meets first was the one sentence nobody measured. Same trap the gate's own
 *  header warns about, one file over. */
export const CONNECT_DEVICE_INTRO =
  'Recued uses two ports. The first one already works.';

/** The button on the router step. Lives here, with the rest of the copy, so the
 *  readability gate measures it — a label defined in the mount would be the one
 *  string on this page nobody checked. */
export const CHECK_FROM_OUTSIDE_LABEL = 'Check this now';

/** Once the step is ticked.
 *
 *  ⚠ THE LABEL CHANGES BECAUSE THE ACT DOES. A ticked row beside a button that
 *  says "Check this now" reads as unfinished work. Taking the button away
 *  instead would be worse: this verdict is a MOMENT, not a property — an address
 *  moves, a router resets, and the reader whose away access just broke would
 *  arrive at a page still showing the tick with no way to test it again. */
export const CHECK_FROM_OUTSIDE_AGAIN_LABEL = 'Check again';

/** While the check is running. Same reason it lives here. */
export const CHECK_FROM_OUTSIDE_RUNNING_LABEL = 'Checking…';

/** When the check itself could not run. ⚠ It says the CHECK failed, not that the
 *  router is shut — those are different facts, and the step stays unknown. */
export const CHECK_FROM_OUTSIDE_ERROR = 'That check could not run just now. Try again in a minute.';

/** The button on the exposure note. Its own labels, because the ACT is its own:
 *  "check my router" and "check whether the internet can reach a port I did not
 *  mean to publish" are not the same request, and a shared label would have to be
 *  vague enough to cover both. */
export const CHECK_EXPOSURE_LABEL = 'Check from the internet';
/** The button on the away card's note. ⚠ "from this device", because that is
 *  the only thing it establishes — see `address_reachable_here`. */
/** ⛔ ONE LABEL FOR ONE ACTION. This page briefly carried three check buttons —
 *  router, exposure, from-this-device — each justified alone and collectively
 *  unreadable: a reader could not tell which answered their question, and the
 *  answer was "all of them, partly". The wording names what the READER wants to
 *  know, not which mechanism produces it. */
export const CHECK_CONNECTION_LABEL = 'Check my connection';
export const CHECK_CONNECTION_NOTE =
  'Checks your address from the internet and from this device.';

export const CHECK_HERE_LABEL = 'Check from this device';
export const CHECK_HERE_AGAIN_LABEL = 'Check again';
export const CHECK_HERE_RUNNING_LABEL = 'Checking…';
export const CHECK_EXPOSURE_AGAIN_LABEL = 'Check again';
export const CHECK_EXPOSURE_RUNNING_LABEL = 'Checking…';

/** D-273 follow-on — the step this page was NAMED FOR and did not have.
 *
 *  ⛔ THE PAGE PROMISED AN ACT IT DID NOT PERFORM. "Connect a device" handed
 *  over an address and stopped; the reader opened it on their phone, met a
 *  sign-in screen, and the page that sent them there had nothing more to say.
 *  Every other mention of pairing in the whole webclient is a WARNING that it
 *  will be needed again — key rotation, key health, restore — so the only
 *  instruction anywhere was buried inside a caution about something else.
 *
 *  ⛔⛔ AND THERE IS DELIBERATELY NO BUTTON HERE. No rpc mints a pairing code
 *  (`pair.list` / `pair.revoke` / `pair.registerRecoveryKey` are the whole
 *  surface), and that absence is a SECURITY PROPERTY rather than a gap: a
 *  paired browser able to mint pairing credentials means a stolen session can
 *  add devices silently. Pairing costs shell access or the 24 words, on
 *  purpose. ⇒ The page explains the flow; it does not perform it.
 *
 *  ⛔⛔ DO NOT "HELPFULLY" BUILD A LINK CARRYING THE SERVER URL. The `?url=`
 *  pre-fill shape was designed and then CUT on a critical-severity finding
 *  (`auth/pair-deeplink.ts` DD#1): `app.recued.com/pair?url=https://attacker…`
 *  renders the official form, pre-fills the attacker's destination, and POSTs
 *  the owner's 24-word master recovery key there on submit. The destination
 *  must be self-authored or derived from the live page origin — which is why
 *  step three offers "or open the address above" rather than one tidy link. */
export const PAIRING_HEADING = 'Sign a new device in';

export const PAIRING_STEPS: readonly string[] = [
  // ⚠ `recued pair`, not `recued-server pair`. The binary is `recued`
  // (`backend/server/package.json`), the boot banner prints `recued pair`, and
  // a test pins that string — but the docstring on the command file itself
  // still says `recued-server pair`. Copy the banner, not the comment.
  'On the computer running your server, run recued pair.',
  'It prints a code that expires after a while, and a link to open.',
  'Open that link on the new device, or open the address above and type the code in.',
];

/** ⚠ The one surprise worth naming up front: the first pair is also enrolment,
 *  and the words it shows are the only copy of them. */
export const PAIRING_FIRST_DEVICE_NOTE =
  'The first device you sign in also sets up your recovery words. Keep them safe.';

export const PRO_CERTIFICATE_NOTE =
  'Recued Pro gives your server its own web address, like yourname.recued.net, '
  + 'and keeps it working. You still let port 443 through your router once.';

/** The hosted app, explained where it will be asked about.
 *
 *  ⛔ IT IS NOT A SECOND WAY TO REACH A PLAIN-HTTP SERVER. The boot banner used to
 *  imply it was. Pasting a loopback address into it half-works — Chrome allows
 *  that one, Safari and Firefox refuse it — and the failure is silent. */
export const hostedAppNote = (facts: ConnectDeviceFacts): string =>
  (facts.certified_hostnames?.length ?? 0) > 0
    ? 'You can also use app.recued.com with the address above. It is the same '
      + 'app your server shows you. Use whichever you like.'
    // ⚠ "port 7717 makes it safe" was wrong and said so for weeks. The PORT makes
    // nothing safe — the browser trusts the address because it names the machine
    // the browser is running on, which is why the same port over a home network
    // address does not work.
    : 'You may have seen app.recued.com. It cannot reach your server yet. It is a '
      + 'safe page, and a safe page may not open a plain one. Use the link above '
      + 'instead. It is the same app, and your browser trusts it because it comes '
      + 'from this computer.';
