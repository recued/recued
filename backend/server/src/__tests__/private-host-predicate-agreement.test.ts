/** ⛔⛔ EIGHT COPIES OF "IS THIS HOST REACHABLE FROM THE PUBLIC INTERNET", UNDER
 *  EIGHT NAMES, AND THEY DID NOT AGREE.
 *
 *  THE THREE DRIVEN AS COLUMNS BELOW:
 *    · `apps/bridge/src/pairing/server-url-security.ts`   `isLanLocalHost`
 *      — may this pairing URL carry plaintext?
 *    · `backend/server/src/ask-landing-answer-link.ts`  `isPrivateOrLocalHost`
 *      — is this base URL worth emailing a one-click link to?
 *    · `backend/server/src/network/resolve-lan-address.ts`
 *      `isPubliclyRoutableIpv4` — does this bind expose the LAN listener?
 *
 *  AND THE FIVE THAT ARE NOT COLUMNS, EACH FOR A STATED REASON — they answer
 *  NEARBY questions, so forcing them into one table would assert an agreement
 *  that should not hold:
 *    · `backend/api/src/shared/guarded-doc-fetch.ts`    `isBlockedIpv4`
 *      — SSRF: may the worker fetch this? Unexported, different package, and
 *      deliberately blocks a SUPERSET (0/8, multicast, reserved). Its own suite
 *      pins 169.254.169.254 and 100.64/10 directly.
 *    · `backend/server/src/network/igd-discovery.ts`    `isPrivateIpLiteral`
 *      — follow this LOCATION named by an unauthenticated M-SEARCH reply?
 *      Deliberately NARROWER: refuses DNS names outright and refuses loopback,
 *      both argued in its own header. Widening it to match the columns would
 *      widen what this server fetches on a stranger's say-so.
 *    · `packages/contracts/src/connection-hints.ts`     `isPrivateIpv4`
 *      — is this hostname unsafe as a SUGGESTED endpoint? The strictest of the
 *      eight, and the only one that already documented its own relationship to
 *      a sibling.
 *    · `packages/contracts/src/chat.ts`                 `isLocalSlotBaseUrl`
 *      — should this BYOK slot show a `(local)` badge?
 *    · `packages/contracts/src/free-pool-data-use.ts`   `isLocalHost`
 *      — does the owner's data stay on the owner's network?
 *
 *  ⛔⛔⛔ AND THE CENSUS ABOVE USED TO SAY *FOUR* — WHICH MISSED THE ONLY BROKEN
 *  ONE. The four were the ones the original drift investigation happened to
 *  walk into. Re-derived 2026-09-18 with a query instead of a memory —
 *  `grep -l 172` ∩ `grep -l 192\.168` across `*\/src`, minus tests — which
 *  returned eleven files, eight of them real predicates. `free-pool-data-use`
 *  was in the four extra, and it was matching `h.startsWith('10.')` against a
 *  HOSTNAME, so `https://10.evil.com/v1` was classified `local` — the one kind
 *  that emits NO notice at all (fixed in `98d9275ad`).
 *
 *  🔑🔑 A HAND-BUILT CENSUS ENUMERATES WHAT YOU ALREADY FOUND. It reads like
 *  coverage and is a record of an investigation's path. The population has to
 *  come from a query over the TREE, and the query must key on the thing the
 *  copies share — here the RANGE CONSTANTS, since by construction they share no
 *  name, no signature and no return polarity.
 *
 *  🔑 ONE PREDICATE WITH FOUR NAMES IS WHY NO NEAR-DUPLICATE SCAN FOUND THIS.
 *  `npm run check:near-duplicates` pairs bodies by NAME across files; these
 *  share no name, no signature and no return polarity — two say "private", one
 *  says "routable", one says "blocked" — so they were invisible to it while
 *  answering the same question about the same host.
 *
 *  ⛔ WHAT THE DRIFT ACTUALLY COST, in both directions:
 *    · the BRIDGE admitted loopback + RFC1918 ONLY, so `http://myserver.local`,
 *      a Tailscale peer at `100.x` and any `169.254` host were refused at
 *      pairing — while the webclient paired the same servers fine. Every one of
 *      those refusals contradicted the guard's own premise ("would cross the
 *      open internet in the clear"): none of that traffic does.
 *    · ASK-LANDING called a CGNAT host PUBLIC and would email a one-click
 *      answer link to an address no inbound connection can reach; and its
 *      `.local` test missed the trailing-dot FQDN form `new URL()` actually
 *      hands it, so `nas.local.` got the same dead link while `nas.local` did
 *      not. Both are the exact dead-link failure that function exists to stop.
 *
 *  ⚠ THIS PINS THE ANSWER, NOT JUST THE AGREEMENT. Copies that agree on the
 *  WRONG answer pass an agreement-only check — so every row carries its own
 *  expected value, and `100.0.0.1` / `100.63.255.255` / `100.128.0.1` are in
 *  the table because a /10 written as a /8 is the one way this widening could
 *  have admitted plaintext to the open internet. */

import { describe, expect, it } from 'vitest';
import { isLanLocalHost } from '../../../../apps/bridge/src/pairing/server-url-security.js';
import { resolvePublicBaseUrl } from '../ask-landing-answer-link.js';
import { describeLanBindExposure } from '../network/resolve-lan-address.js';

type HostKind = 'literal' | 'name';

interface Case {
  readonly host: string;
  /** Expected: NOT reachable from the public internet. */
  readonly notPublic: boolean;
  readonly kind: HostKind;
  readonly why: string;
}

const CASES: readonly Case[] = [
  // ── admitted: non-routable by specification ──────────────────────────────
  { host: '127.0.0.1', notPublic: true, kind: 'literal', why: '127/8 loopback' },
  { host: '10.0.0.5', notPublic: true, kind: 'literal', why: 'RFC 1918 10/8' },
  { host: '192.168.1.50', notPublic: true, kind: 'literal', why: 'RFC 1918 192.168/16' },
  { host: '172.16.0.1', notPublic: true, kind: 'literal', why: 'RFC 1918 172.16/12 low edge' },
  { host: '172.31.255.255', notPublic: true, kind: 'literal', why: 'RFC 1918 172.16/12 high edge' },
  { host: '169.254.10.5', notPublic: true, kind: 'literal', why: 'RFC 3927 link-local' },
  { host: '100.64.0.1', notPublic: true, kind: 'literal', why: 'RFC 6598 low edge' },
  { host: '100.101.102.103', notPublic: true, kind: 'literal', why: 'a Tailscale tailnet peer' },
  { host: '100.127.255.255', notPublic: true, kind: 'literal', why: 'RFC 6598 high edge' },
  { host: '::1', notPublic: true, kind: 'literal', why: 'IPv6 loopback' },
  { host: 'fd12::1', notPublic: true, kind: 'literal', why: 'RFC 4193 ULA' },
  { host: 'fe80::1', notPublic: true, kind: 'literal', why: 'IPv6 link-local' },
  { host: 'localhost', notPublic: true, kind: 'name', why: 'RFC 6761 § 6.3' },
  { host: 'myserver.local', notPublic: true, kind: 'name', why: 'RFC 6762 mDNS' },
  { host: 'nas.local.', notPublic: true, kind: 'name', why: 'mDNS, trailing FQDN root dot' },
  { host: 'box.localhost', notPublic: true, kind: 'name', why: 'RFC 6761 § 6.3 subdomain' },

  // ── refused: genuinely reachable from the internet ───────────────────────
  { host: '8.8.8.8', notPublic: false, kind: 'literal', why: 'public' },
  { host: '2001:db8::1', notPublic: false, kind: 'literal', why: 'IPv6 global unicast' },
  { host: '100.0.0.1', notPublic: false, kind: 'literal', why: '⚠ 100/8 is PUBLIC outside 64-127' },
  { host: '100.63.255.255', notPublic: false, kind: 'literal', why: 'one below RFC 6598' },
  { host: '100.128.0.1', notPublic: false, kind: 'literal', why: 'one above RFC 6598' },
  { host: '169.253.0.1', notPublic: false, kind: 'literal', why: 'one below RFC 3927' },
  { host: '169.255.0.1', notPublic: false, kind: 'literal', why: 'one above RFC 3927' },
  { host: '172.15.0.1', notPublic: false, kind: 'literal', why: 'one below RFC 1918' },
  { host: '172.32.0.1', notPublic: false, kind: 'literal', why: 'one above RFC 1918' },
  { host: 'recued.example.com', notPublic: false, kind: 'name', why: 'an ordinary public host' },
  { host: 'evil.local.attacker.com', notPublic: false, kind: 'name', why: '`.local` INFIX, not a suffix' },
  { host: '127.0.0.1.evil.com', notPublic: false, kind: 'name', why: 'the prefix-bypass string' },
];

const bracket = (h: string): string => (h.includes(':') ? `[${h}]` : h);

/** The three drivable copies, each reduced to the same question and polarity:
 *  TRUE means "not reachable from the public internet". */
const COPIES: ReadonlyArray<{
  readonly at: string;
  readonly handles: ReadonlyArray<HostKind>;
  readonly notPublic: (host: string) => boolean;
}> = [
  {
    at: 'apps/bridge/src/pairing/server-url-security.ts isLanLocalHost',
    handles: ['literal', 'name'],
    notPublic: (h) => isLanLocalHost(bracket(h)),
  },
  {
    at: 'backend/server/src/ask-landing-answer-link.ts isPrivateOrLocalHost',
    handles: ['literal', 'name'],
    // Not exported; `resolvePublicBaseUrl` returns null exactly when the host
    // is private, and a fixed `http://` scheme keeps the host the only variable.
    notPublic: (h) => resolvePublicBaseUrl(`http://${bracket(h)}`) === null,
  },
  {
    at: 'backend/server/src/network/resolve-lan-address.ts isPubliclyRoutableIpv4',
    // ⚠ LITERALS ONLY, AND THAT IS NOT DRIFT. It is handed a BIND ADDRESS, never
    //   a name, and reports anything unparseable as not-public on purpose: "a
    //   false 'you are exposed' costs the reader a search for a problem they do
    //   not have". Asserted separately below so a change there still reds.
    handles: ['literal'],
    notPublic: (h) => !describeLanBindExposure(h).publicly_routable,
  },
];

describe('one private-host predicate, four names, one answer', () => {
  /** ⛔ THE TABLE'S OWN FLOOR — an empty or single-polarity table passes every
   *  assertion below while checking nothing. */
  it('the table covers both answers and both host kinds', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(25);
    expect(CASES.some((c) => c.notPublic)).toBe(true);
    expect(CASES.some((c) => !c.notPublic)).toBe(true);
    expect(CASES.some((c) => c.kind === 'name')).toBe(true);
    expect(new Set(CASES.map((c) => c.host)).size).toBe(CASES.length);
  });

  for (const copy of COPIES) {
    it(`${copy.at} gives the expected answer for every host it handles`, () => {
      const wrong = CASES
        .filter((c) => copy.handles.includes(c.kind))
        .filter((c) => copy.notPublic(c.host) !== c.notPublic)
        .map((c) => `  ${c.host} — expected notPublic=${c.notPublic} (${c.why})`);
      expect(
        wrong,
        `${copy.at} disagrees with the table:\n${wrong.join('\n')}\n`
          + 'The other copies of this predicate are listed in this file\'s header — '
          + 'a range added to one belongs in all of them.',
      ).toEqual([]);
    });
  }

  it('the name-blind copy stays name-blind, rather than drifting quietly', () => {
    // It reports EVERY name as not-public. That is documented and deliberate,
    // and it is why names are excluded above — but if it ever starts parsing
    // names, this reds and the exclusion has to be revisited rather than
    // silently hiding a real disagreement.
    const nameCases = CASES.filter((c) => c.kind === 'name');
    expect(nameCases.length).toBeGreaterThan(3);
    for (const c of nameCases) {
      expect(
        describeLanBindExposure(c.host).publicly_routable,
        `${c.host}: resolve-lan-address started classifying names`,
      ).toBe(false);
    }
  });

  it('MUTATION: the harness can see a copy that is one range short', () => {
    // ⚠ Without this, the loop above passes just as happily against a driver
    //   that throws away its argument — which is the shape that let a guard
    //   missing three whole ranges look correct for months.
    const narrow = (h: string): boolean => /^(127|10|192\.168)\./.test(h);
    const wrong = CASES
      .filter((c) => c.kind === 'literal')
      .filter((c) => narrow(c.host) !== c.notPublic)
      .map((c) => c.host);
    expect(wrong).toContain('169.254.10.5');
    expect(wrong).toContain('100.101.102.103');
    expect(wrong).not.toContain('8.8.8.8');
  });
});
