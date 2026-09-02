/** Every subcommand the classifier routes must be reachable from the CLI.
 *
 *  ⛔ THE DEFECT THIS EXISTS FOR. `bin.ts` computes
 *  `unknownSubcommand = !KNOWN_SUBCOMMANDS.has(subcommand)` and then passes
 *  `help: helpRequested || unknownSubcommand` into `classifyBootProfile`, whose
 *  FIRST line is `if (input.version || input.help) return 'none'`. So a
 *  subcommand missing from that one set can never reach its `case` in the
 *  switch, however complete and correct the module behind it is — the router
 *  prints the help screen and exits 0.
 *
 *  Found live on 2026-08-31: `recued recover-keyfile` and
 *  `recued rotate-passphrase` both printed help. Both were fully built, typed,
 *  dispatched and covered by their own unit tests, which call the context
 *  modules directly and never go through the router. `recover-keyfile` is the
 *  D-212 emergency path — its own profile comment says it exists "because it
 *  must run when the server cannot boot" — so the command written for the worst
 *  day was the one that did not work.
 *
 *  🔑 THIS TEST DERIVES ITS EXPECTATIONS FROM `classifyBootProfile` ITSELF and
 *  drives the real `bin.ts` composition, rather than checking a hand-written
 *  list against another hand-written list. A list-vs-list assertion has to be
 *  edited to catch a new case, which is exactly what nobody does.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyBootProfile } from '../cli/boot-trace.js';

const SRC = join(import.meta.dirname, '..');

/** Comments have matched as code in three previous ratchets in this repo. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const setLiteral = (src: string, name: string): string[] => {
  const m = new RegExp(`${name}\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`).exec(src);
  if (!m) throw new Error(`could not find ${name}`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
};

const binSrc = stripComments(readFileSync(join(SRC, 'bin.ts'), 'utf8'));
const traceSrc = stripComments(readFileSync(join(SRC, 'cli', 'boot-trace.ts'), 'utf8'));

const known = new Set(setLiteral(binSrc, 'KNOWN_SUBCOMMANDS'));

/** Every subcommand the classifier can name — the equality checks plus the
 *  daemon set it delegates to. This is the authority; the allowlist must cover it. */
const routed = [
  ...new Set([
    ...[...traceSrc.matchAll(/input\.subcommand === '([^']+)'/g)].map((m) => m[1]),
    ...setLiteral(traceSrc, 'DAEMON_SUBCOMMANDS'),
  ]),
].filter((s) => s !== 'serve');

describe('CLI router reachability', () => {
  it('finds the subcommands the classifier routes', () => {
    // A positive control: if the extraction silently matched nothing, every
    // assertion below would pass vacuously.
    expect(routed.length).toBeGreaterThan(10);
    expect(routed).toContain('recover-keyfile');
    expect(routed).toContain('report-boot-failure');
  });

  it.each(routed)('`recued %s` reaches its profile instead of the help screen', (subcommand) => {
    // The exact composition `bin.ts` performs, with the real classifier.
    const unknownSubcommand = !known.has(subcommand);
    const profile = classifyBootProfile({
      subcommand,
      version: false,
      help: false || unknownSubcommand,
      mcp: false,
    });

    expect(
      profile,
      `\`recued ${subcommand}\` resolves to '${profile}'. If that is 'none', the `
        + `subcommand is missing from KNOWN_SUBCOMMANDS in bin.ts, and the router `
        + `prints help instead of running it — however complete its module is.`,
    ).not.toBe('none');
  });
});
