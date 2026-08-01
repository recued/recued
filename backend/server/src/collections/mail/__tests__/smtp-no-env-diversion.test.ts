/** The production SMTP transport has NO env branch.
 *
 *  `defaultSmtpTransportFactory` used to consult `RECUED_BENCH_SMTP_OUTBOX` and,
 *  when set, hand back a no-network outbox recorder instead of nodemailer — so
 *  the substrate-bench could run an APPROVED `mail-send` offline. The lazy
 *  `require` meant production never LOADED the dev module, but esbuild bundled
 *  the branch anyway: `dist/bin.js` shipped the diversion. Setting one env var
 *  on a real server therefore made every outbound mail silently not-send while
 *  the mock returned a synthetic `250 2.0.0 OK` — a delivery failure surfaced as
 *  `success: true`.
 *
 *  Removed 2026-07-28. There is no longer a transport double ANYWHERE — not in
 *  this repo, and not in a bench patch either. The substrate-bench runs a real
 *  local SMTP server and points the seeded mail instance's `smtp.host` at it
 *  (127.0.0.1), so it exercises this very factory over a real socket. Offline-
 *  ness is a property of the bench's seeded DATA, not of a code branch, which
 *  is why nothing can leak into an artifact any more.
 *
 *  ⚠ This file tests the branch's ABSENCE with the input that would TAKE it —
 *  the env var SET. A test that only checked the unset case would pass just as
 *  happily with the diversion still in place, and would be no guard at all. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultSmtpTransportFactory } from '../imap-provider.js';

const VAR = 'RECUED_BENCH_SMTP_OUTBOX';

const CONFIG = {
  host: 'smtp.example.test',
  port: 465,
  secure: true,
  auth: { user: 'someone@example.test', pass: 'unused' },
};

describe('defaultSmtpTransportFactory ignores the bench env var', () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[VAR];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[VAR];
    else process.env[VAR] = saved;
  });

  it('returns the SAME transport shape whether or not the bench var is set', () => {
    // The witness: with the old code these two differ — the second is the mock.
    delete process.env[VAR];
    const withoutEnv = defaultSmtpTransportFactory(CONFIG);

    process.env[VAR] = '/tmp/should-never-be-written-by-this-test.jsonl';
    const withEnv = defaultSmtpTransportFactory(CONFIG);

    // nodemailer's transporter carries `transporter`/`options`; the bench mock is
    // a bare `{ sendMail }` object literal. Comparing CONSTRUCTORS rather than
    // key sets keeps this robust to nodemailer internals changing shape.
    expect(withEnv.constructor).toBe(withoutEnv.constructor);
    expect(withEnv.constructor.name).not.toBe('Object');
  });

  it('does not create the outbox file the bench mock would append to', async () => {
    // The bench mock appends a JSON line per send. If the diversion were still
    // wired, constructing the transport and sending would create this path.
    const { mkdtempSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const outbox = join(mkdtempSync(join(tmpdir(), 'smtp-no-divert-')), 'outbox.jsonl');

    process.env[VAR] = outbox;
    const transport = defaultSmtpTransportFactory(CONFIG);

    // Real nodemailer would try to open a socket to smtp.example.test, so the
    // send is EXPECTED to reject. That rejection is itself the signal: the mock
    // resolves with a synthetic 250 and never touches the network.
    let diverted = false;
    try {
      await transport.sendMail({
        raw: 'From: a@example.test\r\nTo: b@example.test\r\nSubject: s\r\n\r\nt\r\n',
        envelope: { from: 'a@example.test', to: ['b@example.test'] },
      });
      diverted = true; // resolved with no network ⇒ something intercepted it
    } catch {
      diverted = false; // network attempt failed ⇒ the real transport
    }

    expect(diverted).toBe(false);
    expect(existsSync(outbox)).toBe(false);
  }, 20_000);
});
