#!/usr/bin/env node
/**
 * Phase E build script for @recued/server (D-107).
 *
 * Bundles the monorepo workspace packages (@recued/*) into a
 * standalone dist/ so the published npm package is self-contained.
 * External-izes native + heavy real-npm deps so the installed tree
 * stays thin and the native SQLite cipher driver rebuilds postinstall.
 *
 * Outputs:
 *   dist/bin.js          — CLI entry (#!/usr/bin/env node banner)
 *   dist/index.js        — library entry
 *   dist/bin.js.map      — linked sourcemap
 *   dist/index.js.map    — linked sourcemap
 *   dist/index.d.ts      — TS types for the library entry (via tsc)
 *
 * Type declarations run through `tsc --emitDeclarationOnly` instead
 * of esbuild because esbuild doesn't emit .d.ts.
 */

import { builtinModules } from 'node:module';
import { build } from 'esbuild';
import { chmodSync, mkdirSync, readdirSync, rmSync, cpSync, existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');
const SRC = join(PKG_ROOT, 'src');
const OUT = join(PKG_ROOT, 'dist');

/** The declared inventory of every npm package our code reaches, and what each
 *  artifact must do with it. See `backend/server/dependency-manifest.json` — it is the
 *  single place that records the ESM/SEA split, and the reason it exists. */
const DEP_MANIFEST = JSON.parse(
  readFileSync(join(PKG_ROOT, 'dependency-manifest.json'), 'utf8'),
);

// Read the package version so we can bake it into the bundle. Distribution
// versioning is CALENDAR-BASED semver `yy.m.d` (Pacific) — package.json is the
// single source of truth (bumped per release; at most one release/day, so the
// Pacific date is a unique, human-legible version). We bake it here so
// `recued-server --version` reports it even when invoked outside `npm run`
// (which would otherwise supply it via `process.env.npm_package_version`).
const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;

// Real npm deps the ESM bundle keeps external — i.e. what `dist/bin.js` needs
// present in node_modules at runtime (the npm package, the `:managed` seed
// shim, and running from source).
//
// ⚠ THIS LIST NO LONGER DEFINES THE D-178 `lib/` SIDECAR. It did until the CJS
// twin landed (item 0a); the sidecar is now `SEA_EXTERNAL` below, which is
// shorter. Kept as a note because the old sentence — "every entry here must be
// shipped beside the binary" — was true when written and became false without
// changing, which is exactly how a stale rule survives a review.
//
// 🔑 THE RULE, learned twice, and it is ESM-SPECIFIC: a package must be external if OUR code reaches it
// through a deferred `require('<name>')`. That call survives bundling and
// resolves against real node_modules at runtime (the banner below gives the ESM
// output a real `require`), so a BUNDLED package would still be looked up by
// name and fail MODULE_NOT_FOUND. A package reached only by static `import` is
// inlined and safe to bundle.
//
// ⚠ `mailparser` and `@iarna/toml` were moved INTO the bundle on 2026-07-31
// after confirming both are static-import-only. That also removes mailparser's
// whole closure (iconv-lite, libmime, libqp, html-to-text, encoding-japanese,
// linkify-it) from the sidecar, which is the larger win. Do NOT do the same to
// `ws` or `imapflow` HERE without first deleting their deferred-require call
// sites (`ws-server.ts`, `imap-provider.ts`) — bundling those into an ESM
// output breaks the WebSocket server and IMAP sync respectively, and only at
// runtime. (The SEA bundle DOES bundle them, safely — see SEA_EXTERNAL: under
// CJS the same call sites inline instead of resolving at runtime.)
//
// ⛔ HIDDEN COUPLING, found by running the bundle in a directory with NO
// node_modules: bundled `mailparser` deep-requires `nodemailer/lib/addressparser`
// at runtime. It therefore works ONLY because `nodemailer` stays external and
// ships in the sidecar. Bundling nodemailer, or dropping it from the sidecar,
// breaks mail PARSING — a failure nowhere near either package's own call sites.
// Guarded by `build-externals-declared.test.ts`.
//
// 🔑 That coupling is invisible on a dev machine: with node_modules present the
// deep require resolves and everything looks fine. The only probe that finds it
// is running the emitted bundle from a clean directory. A static grep for
// dynamic requires does NOT find it — verified inert against nodemailer, the
// known positive.
const EXTERNAL = [
  'better-sqlite3-multiple-ciphers',
  // deferred require in ws-server.ts
  'ws',
  // deferred require in imap-provider.ts
  'imapflow',
  // ⛔ REQUIRED, not an optimization. `defaultSmtpTransportFactory` reaches
  // nodemailer through a deferred `require()`. Bundled into an ESM output,
  // esbuild rewrites nodemailer's own internal requires into its `__require`
  // shim, which THROWS at the first one — outbound SMTP died with
  // `Dynamic require of "events" is not supported` the moment the transport
  // was actually invoked.
  //
  // That went unnoticed because the substrate-bench replaced the transport
  // with a mock that returned before `require('nodemailer')` ever ran, so the
  // one thing exercising this path never reached it. The bench now speaks real
  // SMTP to a local sink and would fail loudly on a regression here.
  //
  // Every entry in this list is also a declared dependency of
  // backend/server/package.json — keep both sides in step, or the release
  // artifact resolves an external it does not ship.
  'nodemailer',
  // Node built-ins — always external.
  'node:*',
];

// ── D-178 S1 rev 2 item 1 (re-done under CJS) ────────────────────────────
// The SEA bundle's externals. SHORTER than the ESM list above, and the reason
// is the module format, not a different risk appetite:
//
//   ESM  — a deferred `require('ws')` survives bundling as a runtime lookup, so
//          the package must exist on disk. Hence it must be external.
//   CJS  — `require` is native, so esbuild INLINES the same call. The package
//          does not need to exist on disk, so it must NOT be external.
//
// ⇒ Everything that is external above purely because our code deferred-requires
// it is bundled here. Only the NATIVE addon is irreducible: `dlopen` needs a
// real file path, which no bundler can provide (proven for both Node SEA and
// `bun build --compile` — see the S1 rev-1 finding).
//
// 🔑 THIS IS WHY THE D-178 `lib/` SIDECAR IS ONE FILE. Before the CJS twin the
// sidecar had to carry ws + imapflow + nodemailer + the native driver and their
// closures; it now carries `better_sqlite3.node` alone.
//
// ⚠ VERIFIED BY RUNNING, NOT BY READING — a static "no bare require" check is
// exactly what missed the mailparser → nodemailer/lib/addressparser coupling.
// Each package was exercised from a bundle in a directory with NO node_modules:
// mailparser parsed an RFC2047 encoded-word subject (libmime + iconv), ws
// completed a real client↔server round-trip, imapflow constructed, and
// nodemailer's sendMail reached the socket layer (`ECONNREFUSED`, not a module
// error — the discriminator that proves its transport graph loaded).
//
// ⛔ Adding a package here is not free: anything NOT in this list is inlined
// into a 16 MB blob, so a new native addon must be added, and a new pure-JS dep
// must be left out. Re-run the clean-directory probe when this changes.
const SEA_EXTERNAL = [
  // ⛔ NO npm packages at all — not even the native driver, whose 60 KB JS
  // wrapper is bundled like everything else. A SEA's `require` resolves
  // BUILT-INS ONLY: an external here is not merely unbundled, it is
  // UNLOADABLE at runtime (`No such built-in module`, observed). The addon
  // itself cannot be bundled and is loaded by `open-database.ts` through
  // `createRequire(process.execPath)`, then handed to the driver as an object.
  'node:*',
];

/** ⛔ Subdirectories of `dist/` this build MUST NOT DELETE.
 *
 *  The clean used to be `rmSync(dist, {recursive: true})` — it owned the whole
 *  directory, not just its own outputs. That silently destroyed:
 *    - `binary-docker/` — ~10 minutes of cross-compilation, and
 *    - `release/`       — a CUSTODY-SIGNED release, only regenerable by
 *                         someone holding the offline signing key.
 *  Both were lost to `phase-e-package.test.ts`, which runs `build.mjs` to
 *  exercise `npm pack`. So RUNNING THE TEST SUITE deleted a signed release,
 *  silently, with the test still green.
 *
 *  A build should own the artifacts it emits, not the directory they sit in.
 *  Stale-output protection is unaffected: the esbuild entry points are still
 *  wiped every run, and `assertNoStaleSrcJsShadow` still guards the shadowing
 *  hazard the blanket clean was really there for. */
// ⛔ DO NOT ADD THE e2e SEED HERE. Preserving it under `dist/` looked like the
// obvious fix when a build deleted it mid-verification — and `npm pack` then
// shipped the whole realm (`seed-test.db`, `seed-identity.json`,
// `seed-recovery-key.txt`) inside the published package, which the Phase E
// files[] test caught. A fixture that is a SERVER REALM does not belong in the
// packaged tree; `make-e2e-seed.mjs` writes outside it.
const PRESERVED_DIST_DIRS = new Set(['binary', 'binary-docker', 'release']);

console.log('[build] cleaning dist/ (preserving release artifacts)');
if (existsSync(OUT)) {
  for (const entry of readdirSync(OUT)) {
    if (PRESERVED_DIST_DIRS.has(entry)) continue;
    rmSync(join(OUT, entry), { recursive: true, force: true });
  }
}
mkdirSync(OUT, { recursive: true });

/** ⛔⛔ THE SEA HAS NO `node_modules`. ANY BARE `require()` LEFT IN THE CJS
 *  BUNDLE IS A PACKAGE THAT WILL NOT EXIST AT RUNTIME.
 *
 *  `SEA_EXTERNAL` is builtins-only, so every npm package our code touches is
 *  supposed to be INLINED. A `require('<name>')` that survives into the output
 *  means esbuild could not see the dependency — the usual cause being a
 *  `createRequire()` shadow, which is opaque to it. Inside the binary that call
 *  throws `Cannot find module`, and whatever fallback the call site has takes
 *  over.
 *
 *  🔑 THIS SHIPPED. `ws-server.ts` reached the socket library through exactly
 *  such a shadow. Every released binary threw `Cannot find module 'ws'`, fell
 *  into a stub whose upgrade callback destroyed the socket without writing a
 *  byte, and served a server that booted, printed a pairing code, answered
 *  `/health` and `/webclient/` with 200s — and could not be paired to by
 *  anything. Found 2026-08-27 by driving a signed binary; no test could see it
 *  because every suite runs from source, where the package is present.
 *
 *  ⚠ CHECKED ON THE EMITTED ARTIFACT, and that is the point. The externals
 *  above were verified by RUNNING the bundle in a directory with no
 *  node_modules — thorough, and still blind here, because `createRequire`
 *  resolves against a real filesystem path and walks UP into the repo's own
 *  node_modules. A SEA has no such path. Reading the output is the one probe
 *  that does not depend on where it ran.
 *
 *  Unprefixed builtins (`stream`, `events`, …) are fine: bundled third-party
 *  code uses the classic spelling and a SEA resolves builtins by definition. */
/** Packages whose ABSENCE IS DESIGNED FOR — the requiring package catches the
 *  failure and keeps working with no loss of function.
 *
 *  ⛔ THE BAR IS "STILL CORRECT WITHOUT IT", NOT "DOES NOT CRASH". `ws` reaches
 *  these two through its own guarded `require`; without them it uses its pure-JS
 *  masking and validation and behaves identically, just slower. That is the only
 *  reason they may stay unresolved.
 *
 *  ⚠ `ws` ITSELF WOULD HAVE LOOKED LIKE A CANDIDATE, and adding it here would
 *  have re-shipped the outage this guard exists to prevent: its call site also
 *  "handled" the missing module — by falling back to a stub that destroyed every
 *  WebSocket in silence. Before adding anything, ask what the fallback DOES, not
 *  whether one exists. */
const OPTIONAL_UNRESOLVED = new Set(Object.keys(DEP_MANIFEST.optional_unresolved ?? {}));

/** ⛔ THE OTHER HALF: A PACKAGE CAN GO MISSING WITHOUT LEAVING A `require()`
 *  BEHIND. `assertNoUnresolvedBareRequires` proves nothing is left DANGLING; it
 *  cannot prove a package is actually THERE. Delete a call site, tree-shake a
 *  branch, or mis-declare an external and the bundle simply shrinks — no bare
 *  require, no error, and the feature is gone from the artifact while every
 *  source-run test stays green. That is the same blind spot the `ws` outage
 *  lived in, approached from the other side.
 *
 *  esbuild stamps each inlined module with its `node_modules/<pkg>/` path, so
 *  the presence of that string is the artifact's own statement that it carries
 *  the package.
 *
 *  ⚠ Depends on the bundle NOT being minified (it is not, and it is 19 MB, so
 *  this is not close). If minification is ever turned on, these markers vanish
 *  and this check must move to a different signal rather than be deleted. */
const assertManifestPackagesPresent = (outfile, format) => {
  const text = readFileSync(outfile, 'utf8');
  const missing = [];
  for (const [name, spec] of Object.entries(DEP_MANIFEST.packages ?? {})) {
    const disposition = spec[format];
    // `external` (esm) and `sidecar` (sea) are resolved OUTSIDE the bundle by
    // design; only an inlined package must be findable inside it.
    if (disposition !== 'inlined') continue;
    if (!text.includes(`node_modules/${name}/`)) missing.push(name);
  }
  if (missing.length === 0) return;
  console.error(
    `[build] FATAL: ${basename(outfile)} does not contain: ${missing.join(', ')}\n`
    + `  backend/server/dependency-manifest.json declares these "${format}": "inlined", so the\n`
    + '  artifact must carry their code. A missing one means the call site stopped\n'
    + '  reaching the package — the feature is absent from the build while every\n'
    + '  test that runs from source still passes.',
  );
  process.exit(1);
};

const BUILD_DEFINES = {
  '__RECUED_SERVER_VERSION__': JSON.stringify(VERSION),
};

/** Every `define` key must be GONE from the emitted bundle.
 *
 *  ⛔⛔ A DEFINE SUBSTITUTES IDENTIFIER REFERENCES, NOT PROPERTY NAMES. Written
 *  as `__RECUED_SERVER_VERSION__` it becomes the version literal; written as
 *  `globalThis.__RECUED_SERVER_VERSION__` it is a member expression, esbuild
 *  leaves it alone, nothing ever assigns that property, and it reads
 *  `undefined` forever. Both forms look correct in review and only one works.
 *
 *  🔑 THIS SHIPPED FOR THREE MONTHS AND TOOK THE UPDATE PATH WITH IT. The
 *  property form landed 2026-05-28 for `system.status`; D-178 later wired the
 *  release check and `boot-reconcile` to the same variable, so a booted server
 *  reported its identity as `stable:unknown`, never matched the staged
 *  `stable:<version>`, and counted every HEALTHY boot as a failed one —
 *  auto-reverting the update on the third restart. Measured against published
 *  26.8.28 on an enrolled realm: three clean boots, then `rolled_back … boot
 *  health failed 3 times`. No update could ever commit.
 *
 *  The name surviving into the output is the whole signal, and it is exact:
 *  a substituted define leaves nothing behind. */
const assertDefinesSubstituted = (outfile, defines) => {
  const src = readFileSync(outfile, 'utf8');
  const left = Object.keys(defines).filter((k) => src.includes(k));
  if (left.length === 0) return;
  throw new Error(
    `${basename(outfile)}: build define(s) survived into the bundle: ${left.join(', ')}.\n`
    + '  esbuild replaces IDENTIFIER references only. Something reads one as a\n'
    + '  property — `globalThis.NAME` or `obj.NAME` — which is never substituted and\n'
    + '  is `undefined` at runtime. Read the bare identifier (see server-version.ts),\n'
    + '  or import the resolved constant instead.',
  );
};

const assertNoUnresolvedBareRequires = (outfile) => {
  const text = readFileSync(outfile, 'utf8');
  const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
  const offenders = new Map();
  // ⚠ MATCH ANY IDENTIFIER ENDING IN `require`, NOT JUST `require(`. esbuild
  // RENAMES a shadowed local to avoid colliding with the native CJS one, so the
  // very call this guard exists to catch is emitted as `require2("ws")`. The
  // first version of this regex looked for `require(` / `__require(` only, and
  // a mutation test walked straight past it — green, and blind to its subject.
  for (const m of text.matchAll(/\b[A-Za-z0-9_$]*require\d*\(\s*["']([^"']+)["']\s*\)/gi)) {
    const spec = m[1];
    // `createRequire('file:///…')` takes a PATH, not a package — skip those the
    // same way relative specifiers are skipped.
    if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('file:')) continue;
    if (builtins.has(spec) || OPTIONAL_UNRESOLVED.has(spec)) continue;
    // A deep import into a package (`nodemailer/lib/x`) fails the same way.
    offenders.set(spec, (offenders.get(spec) ?? 0) + 1);
  }
  if (offenders.size === 0) return;
  const list = [...offenders.entries()].map(([k, n]) => `    ${k} (${n}×)`).join('\n');
  console.error(
    `[build] FATAL: ${basename(outfile)} still requires packages by name:\n${list}\n`
    + '  The SEA binary has no node_modules, so each of these throws\n'
    + '  `Cannot find module` at runtime and silently takes its fallback path.\n'
    + '  Fix the call site to a STATIC import so esbuild bundles it — do not add\n'
    + '  it to SEA_EXTERNAL, which makes it unloadable rather than merely absent.',
  );
  process.exit(1);
};

console.log('[build] bundling entry points via esbuild');
const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: 'linked',
  external: EXTERNAL,
  logLevel: 'info',
  tsconfig: join(PKG_ROOT, 'tsconfig.json'),
  // The monorepo ships .js shims alongside .ts files; prefer .ts so
  // we compile from source, not the pre-built dist/.
  resolveExtensions: ['.ts', '.tsx', '.mjs', '.js', '.json'],
  // Constants injected at build time. Source code reads these as
  // declared globals; esbuild replaces them verbatim in the bundle.
  define: BUILD_DEFINES,
  // ⛔ Give the ESM output a REAL `require`. Without this, every deferred
  // `require()` in our source — `nodemailer`, `imapflow`, `ws` — compiles to
  // esbuild's `__require` shim, whose body is:
  //
  //     if (typeof require !== "undefined") return require.apply(this, arguments);
  //     throw Error('Dynamic require of "' + x + '" is not supported');
  //
  // In an ES module `require` is undefined, so it took the throw. Outbound
  // SMTP died at `require('nodemailer')` — reported as NETWORK_ERROR, because
  // the step runner normalizes unknown codes — and IMAP `connect()` would die
  // the same way at `require('imapflow')`.
  //
  // The shim delegates to a real `require` when one is in scope, so defining
  // one fixes all of them at once and keeps the deferred-require pattern
  // (which exists to keep heavy deps off the boot path) working as intended.
  //
  // ⚠ Banner text lands ABOVE the bundle body but BELOW `bin.ts`'s shebang —
  // verified in the emitted artifact, not assumed. A banner that displaced the
  // shebang would make `dist/bin.js` unexecutable.
  banner: {
    js: "import { createRequire as __recuedCreateRequire } from 'node:module';\n"
      + 'const require = __recuedCreateRequire(import.meta.url);',
  },
};

// ── Stale-shadow guard (2026-06-04) ─────────────────────────────────
// esbuild resolves an explicit `./foo.js` import to a real `foo.js` on disk
// when present, even with a `foo.ts` sibling (`resolveExtensions` only
// rewrites EXTENSIONLESS imports). A stale `src/**/*.js` left over from an
// old tsc-into-src emit therefore SHADOWS its `.ts` source and silently gets
// bundled — shipping outdated or missing exports. (This masked a chat
// tool-loop reinvoke crash: a stale `packages/transforms/src/pii-alias.js`
// predating the `aliasArgs` export got bundled over the `.ts`, so
// `aliasArgsForEgress` threw `ReferenceError` on every reinvoke.) These `.js`
// are git-ignored compiled output. Fail the build LOUDLY (never rm source)
// if any reached the bundle, naming the offenders so the dev deletes them.
const assertNoStaleSrcJsShadow = (metafile, label) => {
  const offenders = [];
  for (const inputPath of Object.keys(metafile.inputs)) {
    const abs = resolve(process.cwd(), inputPath);
    if (abs.includes('/node_modules/')) continue;
    if (!/[/\\]src[/\\].*\.js$/.test(abs)) continue; // only src/**/*.js
    if (existsSync(abs.replace(/\.js$/, '.ts'))) offenders.push(inputPath);
  }
  if (offenders.length > 0) {
    throw new Error(
      `[build] stale .js shadow bundled into ${label}: a compiled src/*.js was ` +
        `resolved over its .ts source (git-ignored stale tsc output). Delete it ` +
        `and rebuild:\n  ${offenders.join('\n  ')}`,
    );
  }
};

// bin.ts already has a `#!/usr/bin/env node` shebang; esbuild keeps
// the first-line shebang in ESM output, so no explicit banner is
// needed. Adding one would double it.
const binResult = await build({
  ...common,
  entryPoints: [join(SRC, 'bin.ts')],
  outfile: join(OUT, 'bin.js'),
  metafile: true,
});
assertNoStaleSrcJsShadow(binResult.metafile, 'bin.js');
assertManifestPackagesPresent(join(OUT, 'bin.js'), 'esm');
assertDefinesSubstituted(join(OUT, 'bin.js'), BUILD_DEFINES);

const indexResult = await build({
  ...common,
  entryPoints: [join(SRC, 'index.ts')],
  outfile: join(OUT, 'index.js'),
  metafile: true,
});
assertNoStaleSrcJsShadow(indexResult.metafile, 'index.js');

// ── D-178 S1 rev 2 item 0a — the SEA entry, in CommonJS ──────────────────
// Node's Single Executable Application embedder runs the blob through
// `embedderRunCjs`. Handed the ESM `bin.js`, the produced binary died on its
// FIRST LINE with `Cannot use import statement outside a module` — a 132 MB
// artifact that could not start at all, while `build-binary.mjs` printed a
// sha256 and exited 0 over it.
//
// ⛔ This is a SECOND OUTPUT, not a format change to `bin.js`, and the
// distinction is load-bearing: `backend/server/package.json` declares
// `"type": "module"`, so a CJS `dist/bin.js` would be parsed as ESM by every
// NORMAL run — `node dist/bin.js`, the npm `bin` link, and the `:managed`
// image's seed shim (`exec node .../seed-dist/bin.js`) — and fail at the first
// `require`. Verified: a CJS file under this package errors immediately. The
// SEA path and the run-from-source path have genuinely different requirements,
// so they get genuinely different artifacts.
//
// The `.cjs` extension is what makes it CommonJS despite `type: module`.
//
// ⚠ No banner here. The banner exists to hand the ESM output a real `require`;
// in CJS `require` is native, and the banner's own `import` statement would be
// a syntax error.
const { banner: _esmBanner, ...seaCommon } = common;
const seaResult = await build({
  ...seaCommon,
  format: 'cjs',
  external: SEA_EXTERNAL,
  // Narrower than `common.external` on purpose — see SEA_EXTERNAL above.
  entryPoints: [join(SRC, 'bin.ts')],
  outfile: join(OUT, 'bin.cjs'),
  metafile: true,
});
assertNoStaleSrcJsShadow(seaResult.metafile, 'bin.cjs');
assertNoUnresolvedBareRequires(join(OUT, 'bin.cjs'));
assertManifestPackagesPresent(join(OUT, 'bin.cjs'), 'sea');
assertDefinesSubstituted(join(OUT, 'bin.cjs'), BUILD_DEFINES);

// D-178 — the thin `:managed` image launcher (I-9 frozen verify-and-exec loop).
// Bundled standalone so the `:managed` image carries ONLY the launcher + node,
// never the server bundle (the binary it launches lives on the data volume).
const launcherResult = await build({
  ...common,
  entryPoints: [join(SRC, 'launcher', 'bin.ts')],
  outfile: join(OUT, 'managed-launcher.js'),
  metafile: true,
});
assertNoStaleSrcJsShadow(launcherResult.metafile, 'managed-launcher.js');

// Executable bit on the CLI entry so npm's bin linker can invoke it.
chmodSync(join(OUT, 'bin.js'), 0o755);
chmodSync(join(OUT, 'managed-launcher.js'), 0o755);

// Declaration files intentionally NOT emitted — @recued/server is
// consumed as a CLI, not a library. Users who import via
// `await import('@recued/server')` get the JS runtime entry. If the
// library surface grows consumer-facing, add a minimal hand-written
// `index.d.ts` rather than letting tsc emit the full tree of
// internal types.

// config.sample.toml sits at the package root so it reaches users
// via npm's `files` array; no copy needed. Listed here as a
// reminder that the file is part of the distributable surface.
const sampleCfg = join(PKG_ROOT, 'config.sample.toml');
if (!existsSync(sampleCfg)) {
  console.warn('[build] warning: config.sample.toml missing at package root');
}

console.log('[build] done →', OUT);
