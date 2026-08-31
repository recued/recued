import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { expect, test } from '@playwright/test';

import {
  bootLiveServer, probeUpgrade, resolveLiveConfig,
  type BootMode, type LiveServer,
} from './harness/live-binary.js';

/**
 * Layer 3 — a real browser, the PUBLISHED binary, a real socket.
 *
 * Layers 1 and 2 between them drive every pixel of this app and never open a
 * WebSocket to a recued-server: staging-smoke has no server behind it, and
 * kitchen-render's connection is a mock. That gap is not academic. Every binary
 * published between 2026-07-31 and 26.8.27 answered `/ws` with nothing at all —
 * the upgrade path reached `ws` through a runtime `require` that did not
 * survive single-executable bundling — and no suite in this repository could
 * see it, because under vitest `ws` is simply a directory on disk.
 *
 * So the artifact under test here is the FILE A USER DOWNLOADS, booted on a
 * throwaway copy of an enrolled realm, dialled by a real Chromium from the
 * deployed webclient origin. It belongs after the binary exists — a release
 * gate, not a pre-merge one.
 *
 * ⛔ NO TRACE, NO SCREENSHOTS, NO VIDEO IN THIS FILE. Pairing types a live
 * 24-word recovery key into the page, and every one of those artifacts captures
 * input values.
 */
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

const HERE = dirname(fileURLToPath(import.meta.url));
const WEBCLIENT = join(HERE, '..');

const config = resolveLiveConfig();
const unavailable = 'unavailable' in config ? config.unavailable : undefined;

// A skip nobody reads is a gate that has quietly stopped running. Say why, and
// let the release driver demand the real thing with E2E_REQUIRE_LIVE=1.
if (unavailable && process.env.E2E_REQUIRE_LIVE === '1') {
  throw new Error(`E2E_REQUIRE_LIVE=1 but the live binary leg is not configured: ${unavailable}`);
}
test.skip(!!unavailable, `live-binary leg not configured — ${unavailable ?? ''}`);

const cacheNameOf = (source: string): string | undefined =>
  /const CACHE_NAME = '([^']+)'/.exec(source)?.[1];

test('the deployed origin is serving the current webclient', async ({ page, baseURL }) => {
  // ⛔ NOT a sha comparison against apps/webclient/build. That directory holds
  // whichever environment was built LAST, and the bundle is environment-specific
  // (the cloud apex is a build define), so a staging bundle can never equal a
  // production one — the check would fail on a truthful deploy.
  //
  // CACHE_NAME is the honest signal: it comes from source, is identical in both
  // environments, and deploy-webclient.sh REFUSES to ship a changed bundle under
  // an unchanged CACHE_NAME. That refusal is what makes this a proxy for the
  // whole bundle rather than for one string.
  const expected = cacheNameOf(readFileSync(join(WEBCLIENT, 'public/sw.js'), 'utf8'));
  expect(expected, 'apps/webclient/public/sw.js must declare a CACHE_NAME').toBeTruthy();

  const res = await page.request.get(`${baseURL}/sw.js`);
  expect(res.status()).toBe(200);
  const served = cacheNameOf(await res.text());

  expect(
    served,
    `${baseURL} is serving ${served} but this working tree is ${expected}. `
    + 'Staging is not running the build under test — deploy it first '
    + '(./scripts/deploy-webclient.sh), then re-run. Results against a stale '
    + 'origin describe an older build, not this one.',
  ).toBe(expected);
});

/** ⛔ A TEST OF THE TEST, AND IT EARNS ITS PLACE. `probeUpgrade` is the only
 *  thing standing between us and a repeat of the ws outage, and it fails OPEN
 *  in the most natural way to write it wrong: resolve to something non-empty on
 *  error and the gate passes forever. So reproduce the outage exactly — accept
 *  the connection, destroy it without writing a byte — and require the empty
 *  string. Needs no binary, so unlike the rest of this file it always runs. */
test('the upgrade probe reports silence as silence', async () => {
  const { createServer } = await import('node:net');
  const silent = createServer((socket) => socket.destroy());
  await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
  const port = (silent.address() as { port: number }).port;
  try {
    expect(await probeUpgrade(port, 3_000)).toBe('');
  } finally {
    silent.close();
  }
});

/** ⛔ BOTH LAUNCH PATHS, BECAUSE THEY ARE NOT THE SAME PATH. `recued serve` is
 *  what the banner and both autostart units use; `recued start` is what the
 *  installer prints as the way to run in the background, and it is the one that
 *  re-executes the binary. No published build could do it — the daemon spawned
 *  `npx tsx bin.ts`, died, and `recued status` said "stopped" — and every drive
 *  in this repository went through the foreground path, so nothing saw it.
 *  A binary is not shippable because ONE of its two front doors opens. */
const PORT_FOR: Record<BootMode, number> = { foreground: 7817, daemon: 7818, unit: 7819 };

for (const mode of ['foreground', 'daemon', 'unit'] as const) {
const launched = mode === 'daemon'
  ? 'with `recued start`'
  : mode === 'unit'
    ? 'by a unit, on a realm that has never been set up'
    : 'in the foreground';
test.describe(`the packaged binary, launched ${launched}`, () => {
  let server: LiveServer;

  test.beforeAll(async () => {
    // The harness gives the binary 60s and then throws with its output. Leave
    // room for that message: at an equal budget the hook times out first and
    // reports "beforeAll exceeded", which says nothing about the binary. A
    // 26.8.24 artifact crashing in its native addon looked like a slow boot.
    test.setTimeout(120_000);
    server = await bootLiveServer(
      config as Exclude<typeof config, { unavailable: string }>,
      { mode, port: PORT_FOR[mode] },
    );
  });
  test.afterAll(() => server?.stop());

  test('answers a /ws upgrade with an HTTP response, not silence', async () => {
    const line = await probeUpgrade(server.port);
    // 401 is the RIGHT answer to an unauthenticated upgrade. The regression is
    // an empty string: connection accepted, socket destroyed, not one byte written.
    expect(
      line,
      'the binary accepted the TCP connection and wrote nothing — this is the '
      + 'shape of the D-178 ws-bundling outage, where a browser sees a closed '
      + 'socket with no status and every client-side diagnostic blames the network',
    ).toMatch(/^HTTP\/1\.1 \d{3}/);
  });

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- narrowed by the loop
  if (mode === 'daemon') {
    test('`recued status` sees the server `recued start` produced', () => {
      const { stdout, stderr } = server.cli(['status', '--db', server.dbPath]);
      const said = `${stdout}${stderr}`;
      // ⚠ The BANNER prints `Status:    Running`; the status VERB prints
      // `Status:  running`. Matching the banner's spelling fails a working
      // binary — a false red costs exactly as much as a false green here.
      expect(
        said,
        'the daemon started but `recued status` cannot see it. That pairing — a '
        + 'start that reports success and a status that says stopped — is the '
        + 'whole shape of the defect: the child was somebody else\'s node, and it '
        + 'was already dead.',
      ).toMatch(/Status:\s*running/i);
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- narrowed by the loop
  if (mode === 'unit') {
    test('serves an unenrolled realm instead of refusing it', async () => {
      // ⛔ THE WHOLE OF D-252 IN TWO ASSERTIONS. Until 26.8.29 this combination —
      // the unit's own argv, a realm with no recovery key — printed "finish setup
      // by running the server yourself", exited 0 and bound NOTHING, so a
      // supervised server could never be the thing you pair to and first run
      // needed a terminal session and a handoff nobody documented.
      expect(server.log(), 'the realm must genuinely be unenrolled, or this passes for the wrong reason')
        .toMatch(/Status:\s*Not enrolled/);
      // And it is serving anyway. A status line back from the upgrade is proof of
      // a bound listener; the refusal case has nothing to connect to at all.
      expect(await probeUpgrade(server.port), 'unenrolled + --require-enrolled must LISTEN')
        .toMatch(/^HTTP\/1\.1 \d{3}/);
    });

    test('`recued pair` mints a code against it', () => {
      // The other half of the flow the installer now prints. `pair` needs no
      // running server, but the point here is that there IS one to pair to.
      const { stdout, stderr } = server.cli(['pair', '--db', server.dbPath]);
      expect(`${stdout}${stderr}`, '`recued pair` must print a usable code')
        .toMatch(/Pairing code:\s*[A-Z0-9-]{6,}/);
    });
  }

  test('pairs a real browser and opens a live socket', async ({ page, context, baseURL }) => {
    // ⛔ CHROME 149 GATES THIS, AND THE GATE IS THE PRODUCT'S FRONT DOOR.
    // A page on https://app.recued.com reaching http://127.0.0.1:7717 is a
    // public-origin request into the `loopback` address space, and Local
    // Network Access requires the user's permission for it. Denied — which is
    // what an automated Chromium does by default — every /auth/pair fetch dies
    // in CORS preflight and the form can only say "couldn't reach your server".
    // Granting it here is not papering over a failure: it is the "Allow" the
    // real user is asked for. The DENIED path is asserted separately below.
    await context.grantPermissions(['local-network-access'], { origin: baseURL! });
    const sockets: { url: string; frames: number; closed: boolean; error?: string }[] = [];
    page.on('websocket', (ws) => {
      const row: { url: string; frames: number; closed: boolean; error?: string } =
        { url: ws.url(), frames: 0, closed: false };
      sockets.push(row);
      ws.on('framereceived', () => { row.frames += 1; });
      ws.on('socketerror', (e) => { row.error = String(e); });
      ws.on('close', () => { row.closed = true; });
    });
    const pageErrors: Error[] = [];
    const console_: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e));
    // The browser's own refusal (mixed content, private-network, CORS) is
    // reported ONLY here — the page just shows "couldn't reach it".
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console_.push(`${m.type()}: ${m.text()}`); });

    // ⛔ Diagnose from what the SURFACES say, not from a guess. When this fails
    // the interesting state is the form's own error code, the browser console,
    // and the server's log — three independent witnesses to one handshake.
    const diagnose = async (): Promise<string> => {
      const status = page.locator('#webclient-pair-code-input-status');
      const text = (await status.count()) ? (await status.first().innerText().catch(() => '')) : '';
      const code = (await status.count()) ? await status.first().getAttribute('data-error') : null;
      return ['', `form status : ${code ?? '(none)'} — ${text.replace(/\s+/g, ' ').trim() || '(empty)'}`,
        `sockets     : ${sockets.map((s) => `${s.url}${s.closed ? ' (closed)' : ''} frames=${s.frames}${s.error ? ` err=${s.error}` : ''}`).join(', ') || '(none)'}`,
        `console     : ${console_.slice(-6).join(' | ') || '(quiet)'}`,
        `server tail : ${server.log().trim().split('\n').slice(-4).join(' ⏎ ')}`].join('\n  ');
    };

    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Pair this browser' })).toBeVisible();

    await page.getByRole('textbox', { name: 'Server URL' }).fill(server.url);
    // ⛔ MINT IT HERE, do not reuse the boot banner's. One live code exists at a
    // time and `recued pair` replaces it, so anything that ran `pair` earlier in
    // the file has already invalidated the boot code — which presents as
    // "pairing did not complete" with nothing wrong on either side.
    await page.getByLabel(/^\s*Pairing code/).fill(server.freshCode());

    // Enrolled realm ⇒ the owner proves it with the existing key. 'enter' is the
    // default mode; clicking is idempotent and keeps this honest if that changes.
    const enterTab = page.getByRole('button', { name: 'I have a recovery key' });
    if (await enterTab.isVisible()) await enterTab.click();

    // ⛔ Fill, never read back, never log. The values are a live recovery key.
    const words = page.locator('.pair-code-input-recovery input');
    await expect(words).toHaveCount(24);
    for (let i = 0; i < 24; i += 1) await words.nth(i).fill(server.recoveryWords[i]);

    await page.getByRole('button', { name: /pair this device/i }).click();

    // The pair form is replaced by the app once the server has accepted and the
    // client has a session — the url field going away is the observable edge.
    const paired = await page.locator('input[type=url]')
      .waitFor({ state: 'detached', timeout: 45_000 }).then(() => true, () => false);
    expect(paired, `the pair form never went away — pairing did not complete.${await diagnose()}`).toBe(true);

    // THE POINT OF THIS FILE. A socket to the server we booted, that the server
    // actually spoke on. `framereceived` is the assertion that survives the
    // outage: an upgrade that is never answered yields no frames.
    const mine = () => sockets.filter((s) => s.url.includes(`:${server.port}/`));
    // ⛔ WAIT, DO NOT SAMPLE — FOR BOTH OF THESE. The pair form detaching means
    // the server ACCEPTED; the client then boots its transport and the first
    // server frame lands after that. Reading either counter the instant the form
    // goes away races the thing under test. I sampled the socket count and it
    // passed on an arm64 binary for a week, then failed every run against an
    // x64 one under Rosetta — same code, slower machine. A check that depends
    // on the host being fast enough is not a check.
    const settles = async (probe: () => boolean, timeout = 20_000): Promise<boolean> => {
      const until = Date.now() + timeout;
      while (Date.now() < until) {
        if (probe()) return true;
        await new Promise((r) => setTimeout(r, 200));
      }
      return probe();
    };

    expect(
      await settles(() => mine().length > 0),
      `no WebSocket was opened to ${server.url} — sockets seen: `
      + `${sockets.map((s) => s.url).join(', ') || '(none)'}${await diagnose()}`,
    ).toBe(true);

    expect(
      await settles(() => mine().some((s) => s.frames > 0)),
      'the socket opened but the server never sent a frame on it — this is what '
      + `the ws-bundling outage looked like from the browser.${await diagnose()}`,
    ).toBe(true);

    expect(pageErrors.map((e) => e.message), 'uncaught page errors').toEqual([]);
  });

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- narrowed by the loop
  if (mode === 'unit') {
    // ⛔ LAST FOR THIS MODE — it reads state the pairing above produced.
    test('the pairing enrolled the realm in place, with no restart', () => {
      // The server that answered the pair is the same process that started
      // unenrolled. If enrolment needed a restart, first run would still have a
      // handoff — which is the thing D-252 removed.
      const { stdout, stderr } = server.cli(['pair', '--db', server.dbPath]);
      expect(`${stdout}${stderr}`, 'the realm should no longer announce itself as unenrolled')
        .not.toMatch(/has not been enrolled yet/i);
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- narrowed by the loop
  if (mode === 'daemon') {
    // ⛔ LAST IN THE FILE ON PURPOSE — it ends the server the tests above use.
    test('`recued stop` ends it, and status agrees', () => {
      const stopped = server.cli(['stop', '--db', server.dbPath]);
      expect(`${stopped.stdout}${stopped.stderr}`, 'stop did not report stopping anything')
        .toMatch(/stopped/i);
      const after = server.cli(['status', '--db', server.dbPath]);
      // A daemon nobody can stop is as broken as one nobody can start: the
      // pidfile is the only handle an owner has, and `serve` writes none.
      expect(`${after.stdout}${after.stderr}`, 'the server is still running after `recued stop`')
        .toMatch(/Status:\s*stopped/i);
    });
  }
});
}
