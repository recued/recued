/** D-178 — release manifest ↔ server-check END-TO-END (leg B staging proof).
 *
 *  The existing `release-check.test.ts` verifies `runReleaseCheck` against a
 *  hand-crafted manifest JSON. This test closes the producer↔consumer gap: it
 *  runs the REAL build pipeline (`assembleManifest` + `signManifest` + real
 *  `signArtifact`), SERVES the output over a real localhost HTTP server, and
 *  drives the server's `runReleaseCheck` through real `fetch` — proving the exact
 *  bytes `release-build.mjs` publishes to R2 fetch → minisign-verify → parse →
 *  resolve to `update-available`. This is the "manifest hosting + check" chain a
 *  staging deploy exercises, minus the R2 hop (a static file host is transparent).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { AddressInfo } from 'node:net';

import {
  assembleManifest,
  binaryFileName,
  generateKeypair,
  signArtifact,
  signManifest,
} from '@recued/release';

import { resolveForApply, runReleaseCheck, type ReleaseCheckDeps } from '../update/release-check.js';
import type { ReleaseCheckState } from '../update/release-state-store.js';

const kp = generateKeypair();
const NOW = Date.parse('2026-07-10T00:00:00Z');

// ── build a real signed manifest via the production pipeline ─────────
const binBytes = Buffer.from('fake recued-linux-x64 binary payload');
const binName = binaryFileName('linux-x64');
const binArtifact = {
  url: `https://cdn.example/releases/1.4.2/${binName}`,
  sha256: createHash('sha256').update(binBytes).digest('hex'),
  sig: signArtifact({ content: binBytes, fileName: binName, version: '1.4.2', key: kp }),
};
const manifest = assembleManifest({
  sequence: 200,
  expires_at: '2027-01-01T00:00:00Z',
  min_launcher_version: 1,
  channels: {
    stable: {
      version: '1.4.2',
      released_at: '2026-07-02T10:00:00Z',
      min_supported: '1.2.0',
      migration: true,
      rollout_pct: 100,
      notes_url: 'https://recued.com/notes',
      binaries: { 'linux-x64': binArtifact },
    },
  },
});
const signed = signManifest(manifest, kp); // { json, sig } — the exact published bytes

// ── the SAME release, but complete: binary + its native `lib-<triple>` sidecar.
//    D-178 S1 rev 2 item 4 — `release-build.mjs` refuses to publish one without
//    the other, so this is the shape the real pipeline emits.
const libBytes = Buffer.from('fake better_sqlite3-linux-x64.node payload');
const libName = 'better_sqlite3-linux-x64.node';
const libArtifact = {
  url: `https://cdn.example/releases/1.4.2/${libName}`,
  sha256: createHash('sha256').update(libBytes).digest('hex'),
  sig: signArtifact({ content: libBytes, fileName: libName, version: '1.4.2', key: kp }),
};
const pairedManifest = assembleManifest({
  sequence: 200,
  expires_at: '2027-01-01T00:00:00Z',
  min_launcher_version: 1,
  channels: {
    stable: {
      version: '1.4.2',
      released_at: '2026-07-02T10:00:00Z',
      min_supported: '1.2.0',
      migration: true,
      rollout_pct: 100,
      notes_url: 'https://recued.com/notes',
      binaries: { 'linux-x64': binArtifact },
      libs: { 'lib-linux-x64': libArtifact },
    },
  },
});
const signedPaired = signManifest(pairedManifest, kp);

// ── serve manifest.json + .minisig over real HTTP (the "hosting" hop) ─
let served = { json: signed.json, sig: signed.sig };
let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/manifest.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(served.json);
    } else if (req.url === '/manifest.json.minisig') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(served.sig);
    } else {
      res.writeHead(404);
      res.end('nope');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const deps = (currentVersion: string): ReleaseCheckDeps => {
  const state: ReleaseCheckState = { salt: 'fixed-salt', highest_accepted_sequence: 0 };
  return {
    trustedPubkey: kp.publicKeyText,
    manifestUrl: `${base}/manifest.json`,
    fetchText: async (url: string): Promise<string> => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    },
    channel: 'stable',
    currentVersion,
    platform: 'linux-x64',
    loadState: () => state,
    saveState: (s) => Object.assign(state, s),
    now: () => NOW,
  };
};

describe('D-178 release manifest ↔ runReleaseCheck (real HTTP + real minisign)', () => {
  it('a pipeline-built manifest fetched over HTTP resolves to update-available', async () => {
    served = { json: signed.json, sig: signed.sig };
    const r = await runReleaseCheck(deps('1.3.0'));
    expect(r.status).toBe('update-available');
    expect(r.available?.version).toBe('1.4.2');
    expect(r.available?.migration).toBe(true);
    expect(r.current_version).toBe('1.3.0');
  });

  it('the same manifest resolves to up-to-date when the running version matches', async () => {
    served = { json: signed.json, sig: signed.sig };
    const r = await runReleaseCheck(deps('1.4.2'));
    expect(r.status).toBe('up-to-date');
  });

  it('a tampered manifest body (sig no longer matches) is rejected as bad-signature', async () => {
    // Flip the served body while keeping the original signature — the minisign
    // verify must fail closed BEFORE any field is trusted.
    served = { json: `${signed.json} `, sig: signed.sig };
    const r = await runReleaseCheck(deps('1.3.0'));
    expect(r.status).toBe('bad-signature');
  });
});

/** D-178 S1 rev 2 item 4 — the APPLY-side resolve, which until now was stubbed
 *  at every call site and so had never run its `update-available` branch against
 *  a real signed manifest. The exe and its native addon are ONE artifact here:
 *  both self-apply channels run the SEA, which dlopen's
 *  `<binDir>/lib/better_sqlite3.node` at the first database open. */
describe('D-178 resolveForApply — the exe and its native addon are one artifact', () => {
  it('a complete release resolves to applyable and carries the addon', async () => {
    served = { json: signedPaired.json, sig: signedPaired.sig };
    const r = await resolveForApply(deps('1.3.0'));
    expect(r.status).toBe('applyable');
    if (r.status !== 'applyable') return;
    expect(r.artifact.url).toBe(binArtifact.url);
    expect(r.libArtifact).toEqual(libArtifact);
    expect(r.toVersion).toBe('1.4.2');
  });

  it('⛔ a binary with NO addon for this triple is refused as no-artifact', async () => {
    // `signed` is the same release minus `lib-linux-x64`. Applying it would
    // install an exe that boots far enough to look healthy and then cannot open
    // its database — so the apply path refuses BEFORE any ledger entry exists.
    served = { json: signed.json, sig: signed.sig };
    const r = await resolveForApply(deps('1.3.0'));
    expect(r.status).toBe('no-artifact');
  });

  it('…but the CHECK still reports that same release — only applying it is refused', async () => {
    // The refusal must not blank the owner's update card: they need to see the
    // release exists in order to understand why it will not install.
    served = { json: signed.json, sig: signed.sig };
    const r = await runReleaseCheck(deps('1.3.0'));
    expect(r.status).toBe('update-available');
    expect(r.available?.version).toBe('1.4.2');
  });

  it('an addon for a DIFFERENT triple does not satisfy this install', async () => {
    // A manifest carrying only `lib-linux-arm64` must not let an x64 install
    // proceed — the pairing is per-triple, and an arm64 .node on x64 is exactly
    // the load failure the guard exists to prevent.
    const wrongTriple = assembleManifest({
      sequence: 200,
      expires_at: '2027-01-01T00:00:00Z',
      min_launcher_version: 1,
      channels: {
        stable: {
          version: '1.4.2',
          released_at: '2026-07-02T10:00:00Z',
          min_supported: '1.2.0',
          migration: true,
          rollout_pct: 100,
          notes_url: 'https://recued.com/notes',
          binaries: { 'linux-x64': binArtifact },
          libs: { 'lib-linux-arm64': libArtifact },
        },
      },
    });
    const s = signManifest(wrongTriple, kp);
    served = { json: s.json, sig: s.sig };
    const r = await resolveForApply(deps('1.3.0'));
    expect(r.status).toBe('no-artifact');
  });
});
