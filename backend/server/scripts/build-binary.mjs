#!/usr/bin/env node
/**
 * D-178 S1 — static-binary builder (SCAFFOLD).
 *
 * Produces a single-file executable for the HOST platform from the esbuild
 * `dist/bin.js` bundle, using Node's Single Executable Application (SEA)
 * facility. SEA cannot cross-compile — each manifest triple is built by its
 * own CI matrix runner (linux-x64, macos-arm64, windows-x64, …), so this
 * script always targets `process.platform`/`process.arch` and resolves the
 * triple from the running host via `@recued/release`.
 *
 * Pipeline (per the D-178 ordering: build → [S4/S5 platform-sign] → sha256 →
 * [S2 minisign]). THIS script owns only the first step — the produced binary
 * is the unsigned input that S4/S5 platform-sign and S2 minisign-sign + name
 * in the manifest as `BinaryArtifact { url, sha256, sig }`.
 *
 * Output:
 *   dist/binary/recued-<triple>[.exe]   — the host binary
 *   dist/binary/<binary>.sha256         — convenience checksum (S2 re-derives)
 *
 * ── KNOWN RESIDUAL (tracked in D-178 S1) ───────────────────
 * The server bundle keeps native + heavy deps EXTERNAL (the multiple-ciphers
 * SQLite driver is a
 * native `.node`; ws/imapflow/mailparser/@iarna/toml are real npm). SEA
 * embeds a single JS blob and CANNOT embed a native `.node`. A fully static
 * single file therefore needs ONE of: (a) ship the externals in a sibling
 * `lib/` next to the binary (semi-static), or (b) swap the native driver for a
 * bundleable sqlite (node:sqlite / a WASM build) + inline the pure-JS
 * externals. This scaffold builds the SEA binary and STAGES the externals;
 * picking (a) vs (b) is the S1 build decision, not wired here.
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { binaryFileName, currentPlatformTriple } from '@recued/release';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');
const DIST = join(PKG_ROOT, 'dist');
const OUT = join(DIST, 'binary');

const fail = (msg) => {
  console.error(`[build-binary] ${msg}`);
  process.exit(1);
};

// ── 0. Pin the runtime this binary will EMBED ───────────────────────────
//
// ⛔⛔⛔ STEP 4 BELOW IS `copyFileSync(process.execPath, binPath)`. THE NODE
// RUNNING THIS SCRIPT *IS* THE RUNTIME EVERY SELF-HOSTER DOWNLOADS. Nothing
// used to state that, nothing recorded it, and it had already drifted:
// measured 2026-08-19, linux shipped Node 24 (`node:24-slim`, see
// build-binary-docker.mjs) and windows shipped 24 (the VM's own node), while
// macOS shipped whatever the release engineer had on PATH — 25.9.0, an
// odd-numbered Current line that never becomes LTS. Three platforms, two
// runtimes, chosen by nobody.
//
// 🔑 So this is an ASSERTION, not a migration: it does not change which Node
// you run, it makes the choice deliberate and visible in the build log. The
// target is the LTS line the other two platforms already ship.
//
// ⏳ WHY 24 AND NOT 26, ASKED AND ANSWERED 2026-08-19. Node 26 becomes LTS in
// ~October, so 24 looks like a target you would move off almost immediately.
// Setting 26 TODAY would be worse in both directions: it ships a Current-line
// runtime to users for the next six weeks — the exact problem this exists to
// stop — and it would put ALL THREE platforms out of compliance at once
// (linux is `node:24-slim`, windows' VM is 24), inverting the signal so the
// two platforms doing the right thing start warning.
//
// ⇒ AND IT DOES NOT COST A SECOND MIGRATION, because this check WARNS rather
// than blocks. macOS keeps building under the override, linux + windows pass
// clean, and in October you move all three build hosts ONCE, set this to 26,
// and delete the override. One migration, and until then the constant states
// what 2 of 3 platforms actually ship rather than an aspiration.
const EXPECTED_NODE_MAJOR = 24;
const nodeMajor = Number(process.versions.node.split('.')[0]);
console.log(
  `[build-binary] embedding Node ${process.version} (${process.execPath}) — `
    + `this is the runtime the downloaded server will run on`,
);
if (nodeMajor !== EXPECTED_NODE_MAJOR) {
  // ⚠ An override rather than a hard stop, because macOS is not on 24 yet and
  // a build that cannot run is worse than one that says what it is doing.
  // Moving macOS to 24 is its own piece of work (both sqlite addons are
  // ABI-locked and need rebuilding). When it lands, delete the override and
  // this becomes a plain `fail`.
  const why = `this build embeds Node ${nodeMajor}, but the release target is `
    + `Node ${EXPECTED_NODE_MAJOR} (the LTS line linux + windows already ship)`;
  if (process.env.RECUED_ALLOW_NODE_MAJOR !== String(nodeMajor)) {
    fail(
      `${why}.\n`
        + `  Either build under Node ${EXPECTED_NODE_MAJOR} (\`nvm exec ${EXPECTED_NODE_MAJOR}\`, and\n`
        + `  \`npm rebuild better-sqlite3 better-sqlite3-multiple-ciphers\` first — both are\n`
        + `  ABI-locked), or state the exception explicitly:\n`
        + `      RECUED_ALLOW_NODE_MAJOR=${nodeMajor} npm run build:binary\n`
        + `  ⛔ The override ships Node ${nodeMajor} to every user of this triple. Mean it.`,
    );
  }
  console.warn(`[build-binary] ⚠ ${why} — allowed via RECUED_ALLOW_NODE_MAJOR`);
}

// ── 1. Resolve the host triple ──────────────────────────────────────────
const triple = currentPlatformTriple();
if (!triple) {
  fail(
    `unsupported build host ${process.platform}/${process.arch} — the ` +
      `static-binary channel builds linux/macos/windows × x64/arm64 only.`,
  );
}
const binName = binaryFileName(triple);
console.log(`[build-binary] host triple: ${triple} → ${binName}`);

// ── 2. Require the esbuild bundle (run `npm run build` first) ───────────
// D-178 S1 rev 2 item 0a — the CJS twin, NOT `bin.js`. Node's SEA embedder runs
// the blob as CommonJS, so an ESM entry produces a binary that dies on its first
// line. `bin.js` stays ESM because `package.json` is `type: module` and every
// normal run path uses it; `bin.cjs` exists solely for this step.
const ENTRY = join(DIST, 'bin.cjs');
if (!existsSync(ENTRY)) {
  fail(`missing ${ENTRY} — run the esbuild step (npm run build) first.`);
}

if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// ── 3. SEA blob config ──────────────────────────────────────────────────
// `main` points at the bundled CLI entry; SEA snapshots it into the blob.
// NOTE (residual): ESM-main + native-require support across node majors is the
// open S1 question above — `useCodeCache`/`useSnapshot` left default for the
// widest compatibility.
const seaConfigPath = join(OUT, 'sea-config.json');
const blobPath = join(OUT, 'recued.blob');

// ── 3a. PROTOTYPE (single-file) — carry the native addon as a SEA ASSET ──
//
// 🔑 "SEA cannot embed a .node" is true of `require()`ing one OUT of the blob,
// and false of CARRYING one. `assets` (Node >=20.12/21.7) stores arbitrary bytes
// retrievable with `sea.getRawAsset()`. The addon still has to reach the
// filesystem before `dlopen` will take it — that part is not optional on any
// platform — but it no longer has to be SHIPPED separately, which is the whole
// cost: two artifacts and two signatures per triple, the `lib-<triple>` manifest
// slots, the staged-without-sidecar guard, and the Windows failure mode where
// the binary starts and then cannot open its database.
//
// ⚠ OPT-IN. Absent the env var this writes exactly the config it always did, so
// the sidecar path stays the default until the embedded one is proven on every
// triple. `open-database.ts` prefers the asset and falls back to the sidecar, so
// binaries from either build work with either layout.
//
// ⛔ The addon must match the Node ABI of THIS process — the same coupling the
// sidecar already has (`build-binary-docker.mjs` builds both in one container).
// Embedding does not relax it; it just moves the bytes.
const EMBED_ADDON = process.env.RECUED_EMBED_ADDON === '1';
let addonPath;
if (EMBED_ADDON) {
  // Resolve through the package, not a guessed path — the addon is hoisted to
  // the workspace root here, and would not be in a non-hoisting install.
  addonPath = process.env.RECUED_ADDON_PATH ?? (() => {
    try {
      const pkg = createRequire(import.meta.url).resolve(
        'better-sqlite3-multiple-ciphers/package.json',
      );
      return join(dirname(pkg), 'build', 'Release', 'better_sqlite3.node');
    } catch {
      return '';
    }
  })();
  if (!existsSync(addonPath)) {
    fail(
      `RECUED_EMBED_ADDON=1 but no addon at ${addonPath}. `
        + 'Set RECUED_ADDON_PATH, or build it (npm rebuild better-sqlite3-multiple-ciphers) first. '
        + 'Refusing to emit a binary that claims to be self-contained and is not.',
    );
  }
  console.log(`[build-binary] embedding addon as SEA asset: ${addonPath}`);
}

writeFileSync(
  seaConfigPath,
  JSON.stringify(
    {
      main: ENTRY,
      output: blobPath,
      disableExperimentalSEAWarning: true,
      ...(EMBED_ADDON ? { assets: { 'better_sqlite3.node': addonPath } } : {}),
    },
    null,
    2,
  ),
);

console.log('[build-binary] generating SEA blob…');
try {
  execFileSync(process.execPath, ['--experimental-sea-config', seaConfigPath], {
    stdio: 'inherit',
  });
} catch (err) {
  fail(`SEA blob generation failed: ${err?.message ?? err}`);
}

// ── 4. Copy the node binary + inject the blob (postject) ────────────────
const binPath = join(OUT, binName);
copyFileSync(process.execPath, binPath);
chmodSync(binPath, 0o755);

// postject is the official SEA injector. Kept OPTIONAL in the scaffold so a
// checkout without it gets a clear instruction rather than a crash; CI installs
// it as a devDependency.
const SENTINEL = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
// ⛔ RUN POSTJECT'S JS WITH THIS NODE. NOT VIA npx.
//
//  Two reasons, one portability and one supply chain.
//
//  Portability: `npx` is `npx.cmd` on Windows, and since the CVE-2024-27980
//  hardening Node REFUSES to spawn .cmd/.bat without `shell: true` — bare 'npx'
//  gives ENOENT, 'npx.cmd' gives EINVAL. Both were reported by this script as
//  "install postject", pointing at the wrong component. `shell: true` would fix
//  it while re-introducing quoting hazards around the absolute paths below.
//
//  Supply chain: `npx --yes postject` FETCHED AN UNPINNED PACKAGE FROM THE
//  NETWORK AT BUILD TIME and let it write into the binary we then sign. postject
//  is now a pinned devDependency, so the injector is in the lockfile like
//  everything else and an offline build works.
//
//  Resolving the bin through package.json rather than hardcoding dist/cli.js so
//  an upstream layout change fails loudly here instead of silently skipping
//  injection.
// ⛔ NOT EVERY `node` CAN BE A SEA BASE. Injection needs the fuse sentinel
// COMPILED INTO the host binary, and distro/homebrew builds routinely lack it —
// verified on this machine: homebrew node 25.9.0 contains ZERO occurrences,
// official node:24 contains one. Without this check postject fails with "could
// not find the sentinel", which reads as a corrupt build; the actual fix is to
// build with an official nodejs.org runtime. Checking the COPY we are about to
// inject, not `process.execPath`, so it still holds if that copy ever changes.
if (!readFileSync(binPath).includes(SENTINEL)) {
  fail(
    `${basename(process.execPath)} has no SEA fuse sentinel, so nothing can be injected into it.\n`
    + '  Build with an official runtime from nodejs.org (or the node: Docker image).\n'
    + '  Homebrew/distro builds omit the sentinel and cannot host a single executable.',
  );
}

const postjectPkg = createRequire(import.meta.url).resolve('postject/package.json');
const postjectCli = resolve(dirname(postjectPkg), JSON.parse(readFileSync(postjectPkg, 'utf8')).bin.postject);
try {
  execFileSync(
    process.execPath,
    [
      postjectCli,
      binPath,
      'NODE_SEA_BLOB',
      blobPath,
      '--sentinel-fuse',
      SENTINEL,
      ...(process.platform === 'darwin'
        ? ['--macho-segment-name', 'NODE_SEA']
        : []),
    ],
    { stdio: 'inherit' },
  );
} catch (err) {
  fail(
    `postject injection failed (${err?.message ?? err}). On macOS the binary must also be ` +
      `re-signed AFTER injection (S4); on Windows re-signed via S5.`,
  );
}

// ── 5. Convenience checksum (S2's signer re-derives the authoritative one) ─
const sha256 = await new Promise((res, rej) => {
  const h = createHash('sha256');
  createReadStream(binPath)
    .on('data', (c) => h.update(c))
    .on('end', () => res(h.digest('hex')))
    .on('error', rej);
});
writeFileSync(join(OUT, `${binName}.sha256`), `${sha256}  ${binName}\n`);

console.log(`[build-binary] done → ${binPath}`);
console.log(`[build-binary] sha256: ${sha256}`);
console.log(
  '[build-binary] NEXT: platform-sign (S4/S5) → minisign + manifest (S2).',
);
