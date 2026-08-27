/** Every housekeeping task that exists is actually wired to something.
 *
 *  ⛔ THE CLASS THIS GUARDS, named in the audit kickoff as "exactly this audit's
 *  shape": a task is written under `housekeeping/`, reviewed, tested on its own
 *  — and never reaches a composition root. It has unit tests, it appears in the
 *  directory listing, and it never runs once in production. Nothing fails,
 *  because nothing is looking: a task nobody builds raises no error, logs no
 *  line, and leaves no row.
 *
 *  🔑 THE TWO SHAPES ARE CHECKED DIFFERENTLY, because they fail differently.
 *    - A pre-built `HousekeepingTaskInstance` is wired by being listed in
 *      `STANDALONE_TASKS`. Absence there = never registered.
 *    - A `build*Task` FACTORY is wired by being called from a composition root,
 *      usually behind an `if (deps.x)` gate. Absence of a call site = never
 *      built. Its absence from `STANDALONE_TASKS` is EXPECTED and is not a
 *      finding — checking factories against that list produced ten false
 *      positives on the first pass here.
 *
 *  ⛔ WHAT THIS DELIBERATELY DOES NOT CHECK, AND WHY THE ATTEMPT WAS DELETED.
 *  A factory can have a call site and still never run, because the `if (deps.x)`
 *  gate in front of it is never satisfied. A third case here tried to catch that
 *  by asserting every gate name is "populated somewhere" — and it was a
 *  too-weak assertion that passed for the wrong reason. Mutation-proved:
 *  deleting the `uploadService` forward out of `start-schedulers.ts` left it
 *  GREEN, because the identifier still appears as object-literal shorthand in
 *  `compose-collection-context.ts`'s own return. It was checking "this word
 *  occurs in some object literal", not "something sets this gate".
 *
 *  The gates chain through several optional forwards
 *  (`collection.uploadService` → `deps.uploadService` → registration), so a
 *  pattern that follows one hop cannot tell a population from a declaration or
 *  a re-export. Rather than ship a case that reddens for nothing, the check is
 *  gone and the reasoning is here. All nine conditional registrations were
 *  traced BY HAND on 2026-08-06: each gate is populated, and each is COHERENT —
 *  the upload sweep registers exactly when the upload service it sweeps exists,
 *  so "not registered" and "nothing to register" coincide. That half stays a
 *  human read. */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SERVER_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOUSEKEEPING = join(SERVER_SRC, 'housekeeping');

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : walk(full);
    return e.name.endsWith('.ts') ? [full] : [];
  });

/** Non-test server sources, read once — the corpus every call-site check runs
 *  against. Tests are excluded on purpose: a factory called ONLY from a test is
 *  precisely the unwired task this file exists to catch. */
const productionSources = (): Array<{ path: string; text: string }> =>
  walk(SERVER_SRC).map((path) => ({ path, text: readFileSync(path, 'utf8') }));

describe('housekeeping task wiring', () => {
  it('⛔ every `build*Task` factory has a PRODUCTION call site', () => {
    const sources = productionSources();
    const factories = new Map<string, string>();
    for (const { path, text } of sources) {
      if (!path.startsWith(HOUSEKEEPING)) continue;
      for (const name of text.match(/export const (build\w*Task)\b/g) ?? []) {
        factories.set(name.replace('export const ', ''), path);
      }
    }
    // Floor: a walk that silently matched nothing must not read as clean.
    expect(factories.size, 'no task factories found — did housekeeping/ move?')
      .toBeGreaterThanOrEqual(8);

    const unwired: string[] = [];
    for (const [name, declaredIn] of factories) {
      const called = sources.some(({ path, text }) =>
        path !== declaredIn && text.includes(`${name}(`));
      if (!called) unwired.push(name);
    }
    expect(unwired, 'these tasks exist but no production code ever builds them')
      .toEqual([]);
  });

  it('⛔⛔ every pre-built `HousekeepingTaskInstance` IS IN `STANDALONE_TASKS`', () => {
    // ⛔ THE HALF THIS FILE DESCRIBED AND DID NOT CHECK, added 2026-08-25 after a live
    // mutation found it: removing a freshly-registered task from `STANDALONE_TASKS`
    // left this suite GREEN. The header above says the two shapes "are checked
    // differently" and names `STANDALONE_TASKS` as where a pre-built instance is wired
    // — but only the FACTORY case was ever implemented, so a whole category was
    // documented-as-guarded and unguarded. Exactly the failure the file exists to
    // prevent, wearing the file's own name.
    const sources = productionSources();
    const registration = sources.find((f) => f.path.endsWith('housekeeping/registration.ts'));
    expect(registration, 'registration.ts not found — did housekeeping/ move?').toBeDefined();
    // The list body, so a task merely IMPORTED there does not count as registered.
    const listBody = registration!.text.slice(
      registration!.text.indexOf('export const STANDALONE_TASKS'),
      registration!.text.indexOf('export const PER_RECORD_PRODUCERS'),
    );
    expect(listBody.length, 'STANDALONE_TASKS body not located').toBeGreaterThan(100);

    const instances = new Map<string, string>();
    for (const { path, text } of sources) {
      if (!path.startsWith(HOUSEKEEPING)) continue;
      for (const m of text.matchAll(/export const (\w+Task)\s*:\s*HousekeepingTaskInstance\b/g)) {
        instances.set(m[1]!, path);
      }
    }
    // Floor: a regex that silently matched nothing must not read as clean — the same
    // discipline the factory case above already applies to itself.
    expect(instances.size, 'no pre-built task instances found')
      .toBeGreaterThanOrEqual(5);

    const unregistered = [...instances.keys()].filter(
      (name) => !new RegExp(`\\b${name}\\b`).test(listBody),
    );
    expect(unregistered, 'these tasks exist but are not in STANDALONE_TASKS')
      .toEqual([]);
  });

  it('⛔ KNOWN NEGATIVE: a factory whose only caller is a test counts as unwired', () => {
    // Proves the check discriminates rather than passing because `includes` is
    // permissive. `walk` skips `__tests__`, so a name that appears ONLY there is
    // invisible to `productionSources()` — which is the whole point, and is the
    // property that would silently invert if the exclusion were dropped.
    const sources = productionSources();
    const invented = 'buildTaskThatDoesNotExistAnywhereTask';
    expect(sources.some(({ text }) => text.includes(`${invented}(`)),
      'a name no production file mentions must not be found').toBe(false);
    // ...and the corpus genuinely excludes test files.
    expect(sources.some(({ path }) => path.includes('__tests__')),
      'productionSources() must not include tests').toBe(false);
  });
});
