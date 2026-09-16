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
 *  think "can I open this on my phone?". The three places differ in what they
 *  need, which is the only reason to separate them at all:
 *
 *    - **This computer** — nothing. Port 7717 is always bound and loopback is
 *      trusted by the browser.
 *    - **Home, other devices** — a certificate. Port 443 serves the visitor page
 *      and the app together, so it is one port, not two.
 *    - **Away** — the same certificate, PLUS traffic getting in through the
 *      router. Tailscale covers both at once; a domain-and-proxy setup needs the
 *      router step separately. That difference is the whole reason `away` is not
 *      folded into `home`.
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


/** Where the reader is trying to open Recued from. */
export type ConnectDevicePlace = 'this_computer' | 'at_home' | 'away';

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
  /** Present only when opening it actually works. */
  url?: string;
  /** The port this place uses — a detail, shown small. */
  portNote: string;
}

const publicOrigin = (hostname: string, port: number): string =>
  (port === 443 ? `https://${hostname}` : `https://${hostname}:${port}`);

/** Build the three answers, easiest first. */
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
    portNote: `Uses port ${facts.lan_port}. Nothing leaves your computer.`,
  };

  const atHome: ConnectDevicePlaceCard = secure === undefined
    ? {
        place: 'at_home',
        title: 'On your phone or another computer at home',
        state: 'one_step',
        status: 'One step first',
        body: unread
          // Same answer, without claiming a fact nothing read.
          ? 'Your phone will not open a plain web address. It needs a safe one, '
            + 'the kind that starts with https. That takes a certificate. Pick a '
            + 'free way below.'
          : 'Your phone will not open a plain web address. It needs a safe one, '
            + 'the kind that starts with https. That takes a certificate. It is '
            + 'free. Pick a way below.',
        portNote:
          `Uses port ${facts.public_port}. The same port shows your visitor page, `
          + 'so there is only one to set up.',
      }
    : {
        place: 'at_home',
        title: 'On your phone or another computer at home',
        state: 'ready',
        status: 'Ready',
        body: `Open ${certified!} on any device in your home. Your certificate `
          + 'makes it safe, so the app just runs.',
        url: `${secure}/webclient/`,
        portNote:
          `Uses port ${facts.public_port}. The same port shows your visitor page.`,
      };

  const away: ConnectDevicePlaceCard = secure === undefined
    ? {
        place: 'away',
        title: 'When you are away from home',
        state: 'one_step',
        status: 'One step first',
        body:
          'This needs the same certificate as above. Tailscale covers both at '
          + 'once. With the other ways you must also let traffic in through '
          + 'your router.',
        portNote: `Uses port ${facts.public_port}, the same one as at home.`,
      }
    : {
        place: 'away',
        title: 'When you are away from home',
        state: 'ready',
        status: 'Ready',
        body: `Use the same address, ${certified!}. If it does not load, your `
          + 'router may still need to let traffic in. Reachability can check.',
        url: `${secure}/webclient/`,
        portNote: `Uses port ${facts.public_port}, the same one as at home.`,
      };

  return [thisComputer, atHome, away];
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

/** One line, after the routes. See the note above for why Pro is not one. */
export const PRO_CERTIFICATE_NOTE =
  'Recued Pro does this step for you. It gives your server a web address and '
  + 'keeps the certificate fresh. There is nothing to set up.';

/** The hosted app, explained where it will be asked about.
 *
 *  ⛔ IT IS NOT A SECOND WAY TO REACH A PLAIN-HTTP SERVER. The boot banner used to
 *  imply it was. Pasting a loopback address into it half-works — Chrome allows
 *  that one, Safari and Firefox refuse it — and the failure is silent. */
export const hostedAppNote = (facts: ConnectDeviceFacts): string =>
  (facts.certified_hostnames?.length ?? 0) > 0
    ? 'You can also use app.recued.com with the address above. It is the same '
      + 'app your server shows you. Use whichever you like.'
    : 'You may have seen app.recued.com. It cannot reach your server yet. It is a '
      + 'safe page, and a safe page may not open a plain one. Use the link above '
      + `instead. It is the same app, and port ${facts.lan_port} makes it safe.`;
