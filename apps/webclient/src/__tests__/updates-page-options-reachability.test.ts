/** ⛔⛔ EVERY OPTION THE UPDATES PAGE DECLARES MUST BE REACHABLE THROUGH THE
 *  SETTINGS ROUTE — the ratchet for audit finding 2.
 *
 *  WHAT HAPPENED. `updateProgress` was declared on `MountUpdatesPageOptions`
 *  (with a comment explaining that the async apply's outcome "arrives here") and
 *  BUILT in `webclient-bootstrap.ts`. The settings route between them never
 *  declared or forwarded it, so nothing ever called `subscribe`. Both ends were
 *  individually correct and every unit test on either side passed, because each
 *  hand-built its own options.
 *
 *  🔑 DERIVED, NOT LISTED. The requirement is read off the page's OWN options
 *  interface, so a new option is covered the moment it is declared — a
 *  hand-written list would have to be remembered, which is the same failure one
 *  level up. Same shape as `subscriber.test.ts`, which derives its subscription
 *  requirement from the reducer's own predicate.
 *
 *  ⚠ A MENTION IS NOT A FORWARD, and this checks the weaker thing on purpose: it
 *  catches "nobody thought about this option at all", which is what happened. An
 *  option that IS mentioned but wired wrongly is a behaviour question, and
 *  behaviour is what `d-148-bootstrap-settings-route.test.ts` drives end to end. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string =>
  readFileSync(resolve(import.meta.dirname, rel), 'utf-8');

/** Options the route deliberately does NOT forward, each with the reason it
 *  cannot be a defect. Anything else must be reachable. */
const NOT_FORWARDED = new Map<string, string>([
  ['host', 'the route builds the host element itself'],
  ['document', 'the route passes its own document'],
  ['runCheck', 'forwarded under the route-level name `updateCheckCaller`'],
  ['onAvailabilityChanged', 'the route supplies its own rail-badge callback'],
]);

const optionNamesOf = (source: string, interfaceName: string): string[] => {
  const start = source.indexOf(`export interface ${interfaceName} {`);
  if (start < 0) throw new Error(`${interfaceName} not found — did it get renamed?`);
  // Top-level members only: two-space indent. Nested object members sit deeper,
  // so `updateProgress?: { subscribe: ... }` contributes `updateProgress` alone.
  const body = source.slice(start);
  const end = body.indexOf('\n}');
  const names: string[] = [];
  for (const line of body.slice(0, end).split('\n')) {
    const m = /^ {2}(\w+)\??:/.exec(line);
    if (m?.[1]) names.push(m[1]);
  }
  return names;
};

describe('the Updates page options are reachable through the settings route', () => {
  const pageSrc = read('../settings/updates-page.ts');
  const routeSrc = read('../settings/bootstrap-settings-route.ts');
  const names = optionNamesOf(pageSrc, 'MountUpdatesPageOptions');

  it('reads a plausible number of options off the interface (the parse itself works)', () => {
    // ⛔ A POSITIVE CONTROL. If the interface is renamed or the shape changes,
    // this parse could silently yield [] and every assertion below would pass
    // vacuously — the exact way a ratchet stops ratcheting without failing.
    expect(names.length).toBeGreaterThan(8);
    expect(names).toContain('updateProgress');
    expect(names).toContain('runApply');
  });

  it('every declared option is either forwarded or explicitly exempt', () => {
    const stranded = names.filter(
      (n) => !NOT_FORWARDED.has(n) && !routeSrc.includes(n),
    );
    expect(
      stranded,
      stranded.length > 0
        ? `these options are declared on the page and mentioned NOWHERE in the settings `
          + `route, so nothing can ever supply them: ${stranded.join(', ')}. Forward them, `
          + `or add them to NOT_FORWARDED with the reason.`
        : '',
    ).toEqual([]);
  });
});
