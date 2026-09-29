import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** app.recued.com's response headers keep the sign-in popup's link to the app.
 *
 *  ⛔ `Cross-Origin-Opener-Policy: same-origin` on every page (2026-08-08 to
 *  2026-09-28) cut the popup off from the app as soon as it opened Google's or
 *  Microsoft's page. The callback page then had no `window.opener` to hand the
 *  code to, the popup still said "Sign-in complete", and the app read the popup
 *  as closed. Nothing failed anywhere a test looked: the relay page and the
 *  popup driver are each correct on their own. Only the header pair decides it. */

const PUBLIC = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../public');
const HEADERS = readFileSync(resolve(PUBLIC, '_headers'), 'utf8');

/** The `_headers` blocks in file order: a path at column 0, then its indented
 *  header lines. Comments and blank lines separate them. */
const rules = (): Array<{ path: string; lines: string[] }> => {
  const out: Array<{ path: string; lines: string[] }> = [];
  for (const line of HEADERS.split('\n')) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    if (!/^\s/u.test(line)) out.push({ path: line.trim(), lines: [] });
    else out[out.length - 1]?.lines.push(line.trim());
  }
  return out;
};

const ruleFor = (path: string) => rules().find((rule) => rule.path === path);

describe('app.recued.com headers keep the sign-in popup attached', () => {
  it('app pages keep the popups they open: same-origin-allow-popups', () => {
    expect(ruleFor('/*')?.lines).toContain('Cross-Origin-Opener-Policy: same-origin-allow-popups');
  });

  /** A popup whose final page is stricter than its opener is moved away from
   *  it, so the callback page must send no COOP at all. */
  it('the callback page drops the header, after the rule that sets it', () => {
    const order = rules().map((rule) => rule.path);
    for (const path of ['/oauth-callback', '/oauth-callback.html']) {
      expect(ruleFor(path)?.lines).toContain('! Cross-Origin-Opener-Policy');
      // `! ` removes a header set by an EARLIER rule.
      expect(order.indexOf(path)).toBeGreaterThan(order.indexOf('/*'));
    }
    // The page those paths serve is the one this rule is for.
    expect(existsSync(resolve(PUBLIC, 'oauth-callback.html'))).toBe(true);
  });

  it('never sets the header twice: a second value would be joined with a comma', () => {
    const setters = rules().filter((rule) =>
      rule.lines.some((line) => line.startsWith('Cross-Origin-Opener-Policy:')));
    expect(setters.map((rule) => rule.path)).toEqual(['/*']);
  });
});
