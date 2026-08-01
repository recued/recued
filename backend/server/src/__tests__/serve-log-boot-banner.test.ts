import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  logBootBanner,
  renderBootBanner,
  type LogBootBannerOptions,
} from '../serve/log-boot-banner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const logBootBannerPath = join(
  repoRoot,
  'backend/server/src/serve/log-boot-banner.ts',
);
const startPostHousekeepingTailPath = join(
  repoRoot,
  'backend/server/src/serve/start-post-housekeeping-tail.ts',
);
const startPostListenerRuntimePath = join(
  repoRoot,
  'backend/server/src/serve/start-post-listener-runtime.ts',
);
const startListenerExposureRuntimePath = join(
  repoRoot,
  'backend/server/src/serve/start-listener-exposure-runtime.ts',
);

const V = '│';

/** Base banner options; override per test. */
const opts = (over: Partial<LogBootBannerOptions> = {}): LogBootBannerOptions => ({
  version: '26.07.03',
  port: 4721,
  webclientServed: true,
  dbPath: '/tmp/server.db',
  recipeCount: 12,
  llmConfig: { slot_1: { provider: 'openai', model: 'gpt-4.1' } },
  pairingCode: undefined,
  notEnrolled: false,
  ...over,
});

/** The box lines (borders + rows), stripped of the 2-space page indent. */
const boxLines = (output: string): string[] =>
  output
    .split('\n')
    .map((l) => l.replace(/^ {2}/, ''))
    .filter((l) => /^[┌│├└]/.test(l));

/** The set of distinct rendered widths (code points) of the box lines — size 1
 *  iff every border + row aligns (the property the fix guarantees). */
const widths = (lines: string[]): Set<number> => new Set(lines.map((l) => [...l].length));

describe('renderBootBanner', () => {
  // ── Auto-PII posture warning ────────────────────────────────────────
  //
  // `RECUED_AUTO_PII=off` disables dispatch-seam PII aliasing. Before this
  // block its ONLY trace was the ABSENCE of auto-protection claims in recipe
  // disclosures — a negative signal an operator would never notice, on a
  // server that from the terminal looks exactly like a protected one.

  it('warns on EVERY boot while auto-PII is disabled', () => {
    const output = renderBootBanner(opts({ autoPiiDisabled: true }));
    expect(output).toContain('PII aliasing is OFF');
    // Points at the SETTING the owner can act on, not a variable they cannot.
    expect(output).toContain('Settings');
    // Names the consequence, not just the flag — an operator reading this
    // should not have to know what "auto-PII" aliases.
    expect(output).toContain('WITHOUT aliasing');
  });

  it('says NOTHING about auto-PII when protection is on', () => {
    // The positive case: without it, a banner that unconditionally printed the
    // warning would satisfy the assertion above and be strictly worse than
    // silence — a standing false alarm teaches operators to ignore the block.
    expect(renderBootBanner(opts({ autoPiiDisabled: false }))).not.toContain('PII aliasing is OFF');
    // Absent (the common shape — callers predating the field) must also be quiet.
    expect(renderBootBanner(opts())).not.toContain('PII aliasing is OFF');
  });

  it('keeps the box aligned when the warning renders (it sits OUTSIDE the box)', () => {
    const output = renderBootBanner(opts({ autoPiiDisabled: true }));
    expect(widths(boxLines(output)).size).toBe(1);
  });

  it('renders an ALIGNED box — every border and row is the same width', () => {
    const output = renderBootBanner(opts());

    const lines = boxLines(output);
    expect(lines.length).toBe(11); // top + title + rule + 7 rows + bottom
    expect(widths(lines).size).toBe(1); // all identical → borders align
    expect(lines[0]).toMatch(/^┌─+┐$/); // top
    expect(lines.at(-1)).toMatch(/^└─+┘$/); // bottom
    // Every content row (│…) closes with the right border │ at the same column.
    for (const row of lines.filter((l) => l.startsWith(V))) expect(row.endsWith(V)).toBe(true);
    // content present (incl. the new Version row)
    for (const needle of ['Recued Server', 'Version:', '26.07.03', 'Port:', '4721', '/tmp/server.db', 'openai/gpt-4.1', 'Status:', 'Running', 'Press Ctrl+C to stop.']) {
      expect(output).toContain(needle);
    }
  });

  it('prints NO ingredient count — the row was dropped, not merely emptied', () => {
    // The count was the manifest-registry size: inlined kernel substrate plus
    // locally authored bodies. Nothing the owner installed or can act on, so
    // the row is gone rather than showing a build constant as inventory.
    //
    // Paired with the label check: every OTHER row is asserted present, so a
    // regression that dropped rows wholesale (or an empty render) fails here
    // instead of passing the absence assertion for free.
    const output = renderBootBanner(opts());
    expect(output).not.toContain('Ingredients');
    for (const label of ['Version:', 'Port:', 'Database:', 'Recipes:', 'LLM:', 'WebSocket:', 'Status:']) {
      expect(output).toContain(label);
    }
    // No blank/ghost row left where it used to sit, and the box still squares up.
    expect(boxLines(output).length).toBe(11);
    expect(widths(boxLines(output)).size).toBe(1);
  });

  it('grows the box to fit a longer value without overflowing the right border', () => {
    const output = renderBootBanner(
      opts({ port: 7900, dbPath: '/tmp/recued-target/recued.db', recipeCount: 191, llmConfig: undefined, pairingCode: null }),
    );
    expect(widths(boxLines(output)).size).toBe(1); // still aligned
    expect(output).toContain('/tmp/recued-target/recued.db'); // fits → shown in full
  });

  it('middle-ellipsizes a value too long for the cap, keeping head + tail', () => {
    const longPath = '/Users/somebody/Library/Application Support/recued/data/recued-server.db';
    const output = renderBootBanner(
      opts({ port: 7717, dbPath: longPath, recipeCount: 8, llmConfig: undefined, pairingCode: null }),
    );
    const lines = boxLines(output);
    expect(widths(lines).size).toBe(1); // aligned despite the over-long value
    expect(output).not.toContain(longPath); // truncated
    expect(output).toContain('…'); // ellipsis
    expect(output).toContain('/Users/'); // head kept
    expect(output).toContain('recued-server.db'); // tail kept
    // No line exceeds the cap (MAX_CONTENT 52 + 2×2 inner pad + 2 borders).
    expect(Math.max(...lines.map((l) => [...l].length))).toBeLessThanOrEqual(58);
  });

  it('renders the not-enrolled pairing instructions with BOTH webclient targets (hosted first, local second)', () => {
    const output = renderBootBanner(
      opts({ port: 8123, recipeCount: 0, llmConfig: undefined, pairingCode: 'ABCDEFGH', notEnrolled: true, webclientServed: true }),
    );

    expect(widths(boxLines(output)).size).toBe(1); // box still aligns
    expect(output).toContain('Not enrolled');
    expect(output).toContain(
      '⚠  Server is not encrypted yet — operations are blocked until you',
    );
    expect(output).toContain('Open the Recued webclient:');
    // hosted webclient is the top target; local (bundled) is the second.
    const hostedIdx = output.indexOf('https://app.recued.com');
    const localIdx = output.indexOf('http://127.0.0.1:8123/webclient/');
    expect(hostedIdx).toBeGreaterThanOrEqual(0);
    expect(localIdx).toBeGreaterThan(hostedIdx);
    // LOOPBACK, both here and in the Server URL. A LAN origin is not a secure
    // context, so `crypto.subtle` is absent and the webclient stops at its
    // secure-context guard — printing a LAN URL here would hand the operator a
    // link that loads a page and then refuses to run. Reaching the server from
    // another device needs TLS in front and lives in the docs.
    expect(output).toContain('Server URL:    http://127.0.0.1:8123');
    // `127.0.0.1`, not `localhost`: the listener binds 0.0.0.0 (IPv4) and
    // `localhost` resolves to ::1 first on many systems.
    expect(output).not.toContain('http://localhost:8123');
    expect(output).toContain('ABCDEFGH');
    expect(output).toContain('expires in 15 min');
    expect(output).toContain('Choose "Generate a new one" to create your 24-word recovery key');
    expect(output).toContain('Pairing code expired? Run:  recued pair');
  });

  it('advertises ONLY loopback + the hosted app — never a LAN address, in any block', () => {
    // The guarantee, stated structurally rather than as "does not contain
    // 192.168.1.50" — that phrasing would pass for free now that the renderer
    // takes no address at all, and would keep passing if someone reintroduced
    // one. Every URL the banner prints must be somewhere the webclient can
    // actually boot: a loopback origin (secure context) or the hosted app.
    for (const over of [
      { notEnrolled: true, pairingCode: 'ABCDEFGH' },
      { notEnrolled: false, pairingCode: 'HGFEDCBA' },
      { notEnrolled: false, pairingCode: null },
      { notEnrolled: true, pairingCode: 'ABCDEFGH', webclientServed: false },
    ] as const) {
      const output = renderBootBanner(opts({ port: 8123, ...over }));
      const urls = output.match(/https?:\/\/[^\s]+/g) ?? [];
      for (const url of urls) {
        const host = new URL(url).hostname;
        expect(
          host === '127.0.0.1' || url.startsWith('https://app.recued.com'),
          `banner printed a non-loopback URL: ${url}`,
        ).toBe(true);
      }
    }
  });

  it('omits the local webclient URL when the server does not serve a bundle', () => {
    const output = renderBootBanner(
      opts({ port: 8123, pairingCode: 'ABCDEFGH', notEnrolled: true, webclientServed: false }),
    );
    expect(output).toContain('https://app.recued.com'); // hosted still shown
    expect(output).not.toContain('/webclient/'); // local NOT advertised (would 404)
  });

  it('renders the enrolled pairing-code block with the webclient targets', () => {
    const output = renderBootBanner(
      opts({ port: 8123, recipeCount: 0, llmConfig: undefined, pairingCode: 'HGFEDCBA', notEnrolled: false, webclientServed: true }),
    );

    expect(output).toContain('Running');
    expect(output).toContain('Add a browser'); // enrolled variant copy
    expect(output).toContain('https://app.recued.com');
    expect(output).toContain('http://127.0.0.1:8123/webclient/');
    expect(output).toContain('HGFEDCBA');
    expect(output).toContain('expires in 15 min');
    expect(output).not.toContain('Server is not encrypted yet');
  });
});

describe('logBootBanner', () => {
  it('logs the rendered banner through the injected logger', () => {
    const log = vi.fn();

    logBootBanner(opts({ port: 3000, recipeCount: 1, llmConfig: undefined, log }));

    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toContain('Recued Server');
  });
});

describe('log-boot-banner source boundary', () => {
  it('keeps banner rendering behind the post-housekeeping tail', () => {
    const bridgeSource = readFileSync(startListenerExposureRuntimePath, 'utf8');
    const runtimeSource = readFileSync(startPostListenerRuntimePath, 'utf8');
    const tailSource = readFileSync(startPostHousekeepingTailPath, 'utf8');

    expect(bridgeSource).toMatch(/start-post-listener-runtime\.js/);
    expect(runtimeSource).toMatch(/start-post-housekeeping-tail\.js/);
    expect(tailSource).toMatch(/log-boot-banner\.js/);
    expect(tailSource).toMatch(/logBootBanner\(\{/);
  });

  it('keeps banner rendering out of scheduler, shutdown, and listener ownership', () => {
    const source = readFileSync(logBootBannerPath, 'utf8');

    expect(source).toMatch(/renderBootBanner/);
    expect(source).toMatch(/logBootBanner/);
    expect(source).toMatch(/Press Ctrl\+C to stop/);
    expect(source).not.toMatch(/composeSchedulers|composeHousekeepingScheduler/);
    expect(source).not.toMatch(/installShutdown|processHandle|process\.on/);
    expect(source).not.toMatch(/createServerHandlerSet|createProductionPathListenerCoordinator/);
    expect(source).not.toMatch(/composeRetentionPruners|composeDdnsUpdatePoller/);
  });
});
