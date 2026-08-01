/** The esbuild `external` list and `dependencies` must be the same set.
 *
 *  ── Why this exists ───────────────────────────────────────────────
 *  `nodemailer` was required by `defaultSmtpTransportFactory` but appeared in
 *  NEITHER list. It was therefore bundled — and because the output is ESM,
 *  esbuild rewrote nodemailer's own internal `require()` calls into its
 *  `__require` shim, which throws. Every outbound SMTP send failed at the
 *  first one with `Dynamic require of "events" is not supported`.
 *
 *  It shipped that way because the only thing that exercised the transport was
 *  the substrate-bench, and the bench had replaced it with a mock that returned
 *  before `require('nodemailer')` ever ran. The mock made the broken path
 *  unreachable from the one place that would have caught it. (The bench now
 *  speaks real SMTP to a local sink, so it would fail loudly on a regression.)
 *
 *  Two directions, both real:
 *    · external but NOT declared → the release artifact resolves a package it
 *      does not ship, and the failure is a runtime MODULE_NOT_FOUND on the
 *      user's machine.
 *    · declared but NOT external → it gets bundled; fine for a pure-ESM
 *      package, fatal for one with dynamic requires, and the difference only
 *      shows up when the code path actually runs.
 *
 *  ⚠ This reads `build.mjs` as TEXT. The file is a build script, not a module
 *  that exports its config, and importing it would run a build. If the EXTERNAL
 *  declaration is ever reshaped, this parse must be updated with it — the
 *  `parses the EXTERNAL list at all` case exists so that reshaping fails here
 *  rather than silently reducing this file to a vacuous pass over an empty set.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const readExternals = (): string[] => {
  const src = readFileSync(join(PKG_ROOT, 'scripts', 'build.mjs'), 'utf8');
  const block = /const EXTERNAL = \[([\s\S]*?)\];/.exec(src);
  if (!block) throw new Error('could not find the EXTERNAL array in scripts/build.mjs');
  // Strip `//` comments FIRST. The list is heavily commented, and an
  // apostrophe in prose ("nodemailer's own requires") otherwise opens a
  // string literal that swallows the rest of the line — which is exactly how
  // the first version of this test failed.
  const code = block[1].replace(/\/\/[^\n]*/g, '');
  return [...code.matchAll(/'([^']+)'/g)]
    .map((m) => m[1])
    // `node:*` is a wildcard for built-ins, not an npm package.
    .filter((name) => !name.startsWith('node:'));
};

const readDependencies = (): string[] =>
  Object.keys(
    (JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    }).dependencies ?? {},
  );

describe('esbuild externals are declared dependencies', () => {
  it('parses the EXTERNAL list at all', () => {
    // Guards the guard: a parse that silently returned [] would make every
    // assertion below pass over an empty set.
    const externals = readExternals();
    expect(externals.length).toBeGreaterThan(3);
    expect(readDependencies().length).toBeGreaterThan(3);
  });

  it('every external is a declared dependency', () => {
    const declared = new Set(readDependencies());
    const undeclared = readExternals().filter((name) => !declared.has(name));
    expect(
      undeclared,
      `external but not declared — the release artifact would not ship ${undeclared.join(', ')}`,
    ).toEqual([]);
  });

  it('every declared dependency is external', () => {
    const externals = new Set(readExternals());
    const bundled = readDependencies().filter((name) => !externals.has(name));
    expect(
      bundled,
      `declared but not external — ${bundled.join(', ')} gets bundled, and a package with `
        + 'dynamic requires throws "Dynamic require of X is not supported" at runtime',
    ).toEqual([]);
  });

  it('pins nodemailer specifically — the send path that actually broke', () => {
    // Named on purpose rather than left to the set comparison above. If someone
    // ever "simplifies" both lists together, the set check still passes while
    // outbound mail breaks again.
    expect(readExternals()).toContain('nodemailer');
    expect(readDependencies()).toContain('nodemailer');
  });

  it('⛔ a BUNDLED mailparser requires nodemailer to stay external', () => {
    // Found 2026-07-31 by running the emitted bundle in a directory with NO
    // node_modules: bundled `mailparser` deep-requires
    // `nodemailer/lib/addressparser` at runtime. It resolves only because
    // nodemailer is external and therefore ships in the D-178 `lib/` sidecar.
    //
    // 🔑 This is unobservable on a dev machine — node_modules is present, the
    // deep require resolves, everything looks correct. And it is a coupling
    // between two packages whose own call sites are nowhere near each other,
    // so nothing else in the suite would connect them.
    const externals = readExternals();
    if (!externals.includes('mailparser')) {
      expect(
        externals,
        'mailparser is bundled, so nodemailer MUST stay external — it deep-requires nodemailer/lib/addressparser',
      ).toContain('nodemailer');
    }
  });

  it('keeps the deferred-require packages external — bundling them breaks at runtime', () => {
    // `ws-server.ts` and `imap-provider.ts` reach these through a deferred
    // `require('<name>')`. That call survives bundling and resolves against real
    // node_modules, so bundling the package leaves the lookup pointing at
    // something that no longer ships: MODULE_NOT_FOUND on the WebSocket server
    // and on IMAP sync respectively. Externalising them is what makes the
    // deferred-require pattern safe, not an optimization.
    for (const name of ['ws', 'imapflow']) {
      expect(readExternals(), `${name} is deferred-required by our own source`).toContain(name);
    }
  });
});
