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
writeFileSync(
  seaConfigPath,
  JSON.stringify(
    {
      main: ENTRY,
      output: blobPath,
      disableExperimentalSEAWarning: true,
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
