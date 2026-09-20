/** D-272 — `diagnosticResponseShowsReachableUrl`, the verdict behind "this
 *  address works".
 *
 *  ⛔ IT HAD NO TESTS AT ALL, and it is wired into production
 *  (`webclient-bootstrap.ts` fills `reachable:` from it). Mutation found it:
 *  deleting the hostname check, deleting the port check, and dropping the
 *  certificate requirement on 443 all survived.
 *
 *  ⚠ EACH DELETED GUARD IS A DIFFERENT WRONG REASSURANCE. Telling someone their
 *  address works when the probe answered about a DIFFERENT hostname, or when no
 *  port answered, or when 443 answered with a certificate that does not match
 *  the name they typed, all end the same way — they stop looking for the
 *  problem that is still there.
 */

import { describe, expect, it } from 'vitest';
import type { DiagnosticResponse } from '@recued/contracts';

import { diagnosticResponseShowsReachableUrl } from '../reachability.js';

/** ⚠⚠ `status` IS OVERRIDABLE, AND THAT IS THE POINT. This builder used to
 *  DERIVE it — `outcome === 'reachable' ? 'pass' : 'fail'` — so no fixture
 *  built from it could ever make the two fields disagree. `has ReachablePort`
 *  checks BOTH (`status === 'pass'` AND `outcome === 'reachable'`), so each
 *  condition was fully masked by the other: mutation showed that deleting
 *  EITHER left every test in this file green. A helper that ties two fields
 *  together hides the join for every test that uses it at once. */
const portResult = (
  port: number,
  outcome: 'reachable' | 'blocked',
  status: 'pass' | 'warn' | 'fail' = outcome === 'reachable' ? 'pass' : 'fail',
) => ({
  kind: 'port_reachability' as const,
  status,
  payload: { kind: 'port_reachability' as const, port, outcome },
});

const tlsResult = (opts: { valid: boolean; matches: boolean }) => ({
  kind: 'tls_handshake' as const,
  status: 'pass' as const,
  payload: {
    kind: 'tls_handshake' as const,
    cert_valid: opts.valid,
    cert_matches_hostname: opts.matches,
  },
});

const response = (
  hostname: string,
  results: ReadonlyArray<unknown>,
): DiagnosticResponse => ({ hostname, results } as unknown as DiagnosticResponse);

const HOST = 'alice.recued.net';

describe('diagnosticResponseShowsReachableUrl', () => {
  it('says yes for a reachable non-443 port on the right hostname', () => {
    expect(diagnosticResponseShowsReachableUrl(
      response(HOST, [portResult(7717, 'reachable')]), HOST, 7717,
    )).toBe(true);
  });

  it('⛔ says NO when the probe answered about a DIFFERENT hostname', () => {
    // The probe is asked about one name and reports under it. A verdict read
    // against another name is somebody else's answer.
    expect(diagnosticResponseShowsReachableUrl(
      response('someone-else.recued.net', [portResult(7717, 'reachable')]), HOST, 7717,
    )).toBe(false);
  });

  it('⛔ says NO when the port did not answer', () => {
    expect(diagnosticResponseShowsReachableUrl(
      response(HOST, [portResult(7717, 'blocked')]), HOST, 7717,
    )).toBe(false);
  });

  it('⛔ says NO when a DIFFERENT port answered', () => {
    expect(diagnosticResponseShowsReachableUrl(
      response(HOST, [portResult(443, 'reachable')]), HOST, 7717,
    )).toBe(false);
  });

  it('⛔⛔ on 443, a reachable port is NOT enough — the cert must match the name', () => {
    // ⚠ THE ASYMMETRY, AND THE REASON IT EXISTS. 443 is the address a browser
    // will dial with strict TLS, so "the port answers" understates what has to
    // be true. A reachable 443 behind a cert for another name is a page that
    // will refuse to load with a security warning.
    expect(diagnosticResponseShowsReachableUrl(
      response(HOST, [portResult(443, 'reachable')]), HOST, 443,
    )).toBe(false);

    expect(diagnosticResponseShowsReachableUrl(
      response(HOST, [portResult(443, 'reachable'), tlsResult({ valid: true, matches: false })]),
      HOST, 443,
    )).toBe(false);

    expect(diagnosticResponseShowsReachableUrl(
      response(HOST, [portResult(443, 'reachable'), tlsResult({ valid: false, matches: true })]),
      HOST, 443,
    )).toBe(false);

    // Both true ⇒ yes.
    expect(diagnosticResponseShowsReachableUrl(
      response(HOST, [portResult(443, 'reachable'), tlsResult({ valid: true, matches: true })]),
      HOST, 443,
    )).toBe(true);
  });

  it('⚠ a NON-443 port does not need a certificate at all', () => {
    // The control for the asymmetry above: without it, requiring TLS
    // everywhere would report a working plain-http LAN address as broken.
    expect(diagnosticResponseShowsReachableUrl(
      response(HOST, [portResult(7717, 'reachable')]), HOST, 7717,
    )).toBe(true);
  });

  it('says NO for a missing response rather than assuming either way', () => {
    expect(diagnosticResponseShowsReachableUrl(null, HOST, 443)).toBe(false);
    expect(diagnosticResponseShowsReachableUrl(undefined, HOST, 443)).toBe(false);
    expect(diagnosticResponseShowsReachableUrl(response(HOST, []), HOST, 443)).toBe(false);
  });
});

/** ⛔ THE TWO CONDITIONS, SEPARATED. `diagnosticResponseHasReachablePort` demands
 *  a `pass` STATUS and a `reachable` OUTCOME. Every fixture above satisfies both
 *  or neither, so until now nothing said which one was load-bearing — and a
 *  reader could delete either and ship.
 *
 *  ⚠ This fold decides whether the page shows an address as working. The
 *  response comes from the cloud probe, so the two fields are set by a different
 *  codebase on a different deploy cadence; a client that trusts one and ignores
 *  the other is trusting a field it does not own to keep agreeing with another
 *  field it does not own. */
describe('a status and an outcome that disagree', () => {
  it('⛔⛔ a non-pass STATUS is not reachable, whatever the outcome says', () => {
    for (const status of ['fail', 'warn'] as const) {
      expect(
        diagnosticResponseShowsReachableUrl(
          response(HOST, [portResult(7717, 'reachable', status)]), HOST, 7717,
        ),
        `a '${status}' port check was shown as a working address`,
      ).toBe(false);
    }
  });

  it('⛔⛔ a non-reachable OUTCOME is not reachable, whatever the status says', () => {
    expect(
      diagnosticResponseShowsReachableUrl(
        response(HOST, [portResult(7717, 'blocked', 'pass')]), HOST, 7717,
      ),
      'a blocked port was shown as a working address because its status said pass',
    ).toBe(false);
  });

  it('both agreeing is still the yes — the pair above did not invert the rule', () => {
    expect(
      diagnosticResponseShowsReachableUrl(
        response(HOST, [portResult(7717, 'reachable', 'pass')]), HOST, 7717,
      ),
    ).toBe(true);
  });
});

