#!/usr/bin/env node
/** D-178 S4 — macOS code signing for the server binary + its native addon.
 *
 *  Runs today with AD-HOC signing (no Apple account), and takes a Developer ID
 *  as one argument when the certificate arrives. Notarization (S5) is the only
 *  stage that cannot be exercised without an account, and it is the mechanical
 *  half; everything that could force a DESIGN change lives here.
 *
 *  Usage:
 *    node scripts/sign-macos.mjs --dir dist/binary                 # ad-hoc
 *    node scripts/sign-macos.mjs --dir dist/binary --identity "Developer ID Application: X (TEAM)"
 *
 *  ── MEASURED ON macos-arm64, 2026-08-07 ─────────────────────────────────
 *  Every row below was run, not reasoned about:
 *
 *    exe unsigned                          -> does not execute AT ALL. postject
 *                                             strips the signature, and Apple
 *                                             Silicon kills unsigned binaries.
 *                                             Signing is not optional even for
 *                                             a local build.
 *    exe hardened, NO entitlements         -> V8 dies (`--version` returns junk,
 *                                             no database is created).
 *    exe hardened + allow-jit              -> runs.
 *    ...with addon UNSIGNED                -> dlopen refuses: "Trying to load an
 *                                             unsigned library". Nothing loads
 *                                             unsigned on Apple Silicon.
 *    ...with addon signed, DIFFERENT team  -> dlopen refuses: "mapping process
 *                                             and mapped file (non-platform)
 *                                             have different Team IDs".
 *    ...+ disable-library-validation       -> works, but see below.
 *
 *  🔑 THE ADDON MUST CARRY THE SAME TEAM ID AS THE EXECUTABLE. That is why this
 *  script signs BOTH with one identity rather than only the exe. The prebuilt
 *  `better_sqlite3.node` ships linker-signed with `TeamIdentifier=not set`, so
 *  shipping it untouched under a Developer ID would be refused at first database
 *  open — after a successful install, which is the worst place to find out.
 *
 *  ⚠ `disable-library-validation` is used for AD-HOC builds ONLY, and never for
 *  a real identity — see the entitlements block below for why that split is
 *  forced rather than chosen. It switches the check off for EVERY library the
 *  process loads, which is a documented weakening reviewers look for.
 *
 *  ⚠ allow-jit vs allow-unsigned-executable-memory: EITHER alone is sufficient
 *  (both measured). `allow-jit` is the narrower grant — it permits MAP_JIT
 *  rather than unsigned executable pages generally — so that is the one used.
 *
 *  ⛔ ORDER MATTERS: sign AFTER postject. Injection invalidates a signature; on
 *  macOS it strips it outright ("code object is not signed at all"), and on
 *  Windows postject warns that it is corrupt. Signing first is wasted work.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const fail = (m) => { console.error(`[sign-macos] ${m}`); process.exit(1); };

if (process.platform !== 'darwin') fail(`this must run on macOS (host is ${process.platform}).`);

const dir = resolve(PKG_ROOT, flag('dir', 'dist/binary'));
/** Ad-hoc ("-") unless a real identity is given. Ad-hoc produces a binary that
 *  RUNS locally but fails Gatekeeper on a downloaded copy — fine for building
 *  and testing the pipeline, never for release. */
const identity = flag('identity', '-');
const adhoc = identity === '-';

if (!existsSync(dir)) fail(`no such directory: ${dir}`);
const exe = readdirSync(dir).find((f) => /^recued-macos-(arm64|x64)$/.test(f));
if (!exe) fail(`no recued-macos-* binary in ${dir} — run the SEA build first.`);
const addon = join(dir, 'lib', 'better_sqlite3.node');
if (!existsSync(addon)) {
  fail(`no addon at ${addon}.\n`
    + '  recued is TWO files and BOTH must be signed with the same identity; signing\n'
    + '  only the executable produces an install that dies at the first database open.');
}

/** ⛔ THE ENTITLEMENTS DIFFER BETWEEN AD-HOC AND RELEASE, AND THAT IS NOT A
 *  SHORTCUT — IT IS THE LIMIT OF WHAT CAN BE TESTED WITHOUT APPLE.
 *
 *  Library validation requires the loaded addon to carry the SAME Team ID as the
 *  executable. Measured: ad-hoc signing gives neither a Team ID, and dlopen
 *  still refuses with "mapping process and mapped file (non-platform) have
 *  different Team IDs" — an unset Team ID does not match another unset one.
 *  A trusted SELF-SIGNED certificate does not help either: codesign reports
 *  `TeamIdentifier=not set` for it, because only Apple-issued certificates
 *  populate that field.
 *
 *  So without a Developer ID there is no way to make library validation pass,
 *  and an ad-hoc build must disable it merely to run. Release builds must NOT:
 *  the same identity on both files satisfies the check properly, and
 *  `disable-library-validation` switches it off for EVERY library the process
 *  loads — a documented weakening reviewers look for.
 *
 *  ⚠ THEREFORE THE RELEASE PATH IS UNVERIFIED until a real certificate exists.
 *  What IS verified: sign-after-postject, that unsigned does not run at all,
 *  that hardened runtime kills V8 without entitlements, that `allow-jit` alone
 *  suffices, and that the addon must be signed. The remaining unknown is one
 *  binary question — does same-team signing satisfy library validation — with a
 *  measured fallback (`disable-library-validation`) if it somehow does not. */
const entitlements = join(tmpdir(), `recued-ent-${process.pid}.plist`);
writeFileSync(entitlements, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>${adhoc ? `
  <!-- AD-HOC ONLY. Removed for a real identity, where matching Team IDs are
       what satisfy library validation. Present here solely so a local build
       runs at all. -->
  <key>com.apple.security.cs.disable-library-validation</key><true/>` : ''}
</dict></plist>
`);

const sign = (target, extra) => {
  const a = ['--sign', identity, '--force', '--timestamp' + (adhoc ? '=none' : ''), ...extra, target];
  try {
    execFileSync('/usr/bin/codesign', a, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    fail(`codesign failed for ${target}:\n  ${(err.stderr || err.message || '').toString().trim()}`);
  }
};

try {
  console.log(`[sign-macos] identity: ${adhoc ? 'AD-HOC (not distributable)' : identity}`);

  // ADDON FIRST. It is a dependency of the executable, and codesign seals what
  // it finds at signing time — signing the exe first would seal a stale state.
  sign(addon, []);
  console.log(`[sign-macos] signed addon    ${addon.replace(dir + '/', '')}`);

  sign(join(dir, exe), ['--options', 'runtime', '--entitlements', entitlements]);
  console.log(`[sign-macos] signed binary   ${exe}  (hardened runtime + allow-jit)`);

  // ⛔ VERIFY, DO NOT ASSUME. `codesign --sign` succeeding says the write
  // happened, not that the result is loadable. This is the same distinction
  // that let an install "succeed" on Alpine with a binary that could not run.
  for (const t of [addon, join(dir, exe)]) {
    try {
      execFileSync('/usr/bin/codesign', ['--verify', '--strict', t], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      fail(`signature does not verify for ${t}:\n  ${(err.stderr || '').toString().trim()}`);
    }
  }
  console.log('[sign-macos] both signatures verify');

  if (adhoc) {
    console.log('[sign-macos] NOTE: ad-hoc. This runs locally and FAILS Gatekeeper once');
    console.log('[sign-macos]       downloaded (quarantined). Not distributable — S5 notarization');
    console.log('[sign-macos]       needs a Developer ID and an Apple account.');
  } else {
    console.log('[sign-macos] NEXT (S5): zip the pair, `notarytool submit --wait`, `stapler staple` the ZIP.');
    console.log('[sign-macos]       Stapling attaches to CONTAINERS, so ship the zip/dmg, not a bare binary.');
  }
} finally {
  rmSync(entitlements, { force: true });
}
