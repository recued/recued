/** The nodemailer that parses incoming mail is the one the server sends with,
 *  and it carries every addressparser fix.
 *
 *  The bundled `mailparser` deep-requires `nodemailer/lib/addressparser` for
 *  each synced message's From, To and Cc (the HIDDEN COUPLING in
 *  `scripts/build.mjs`), and the SEA build inlines whichever copy that require
 *  resolves to from mailparser's own directory. mailparser 3.9.14 pins
 *  nodemailer 9.0.3, so raising the server's own dependency alone left incoming
 *  mail on the old parser; the root `overrides` points mailparser at the
 *  server's version. Up to 10.0.5 that parser's free-text fallback was
 *  quadratic (GHSA-v53p-9fqp-m79j): one 60,000-character From header held the
 *  event loop 2.1 s (measured 2026-10-27, mailparser 3.9.14 + nodemailer 9.0.3).
 *  10.0.10 is the first release with all five nodemailer fixes of that week. */

import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const fromServer = createRequire(import.meta.url);
const fromMailparser = createRequire(fromServer.resolve('mailparser'));

const versionOf = (load: NodeRequire): number[] =>
  (load('nodemailer/package.json') as { version: string }).version.split('.').map(Number);

describe('the nodemailer that parses incoming mail', () => {
  it('is the copy the server sends with', () => {
    expect(fromMailparser.resolve('nodemailer/lib/addressparser'))
      .toBe(fromServer.resolve('nodemailer/lib/addressparser'));
  });

  it('is 10.0.10 or later', () => {
    const [major = 0, minor = 0, patch = 0] = versionOf(fromServer);
    expect(major * 1_000_000 + minor * 1_000 + patch).toBeGreaterThanOrEqual(10_000_010);
  });
});
