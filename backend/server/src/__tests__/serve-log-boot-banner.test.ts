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
  lanBindAddress: '192.168.1.50',
  webclientServed: true,
  dbPath: '/tmp/server.db',
  recipeCount: 12,
  ingredientCount: 34,
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
  it('renders an ALIGNED box — every border and row is the same width', () => {
    const output = renderBootBanner(opts());

    const lines = boxLines(output);
    expect(lines.length).toBe(12); // top + title + rule + 8 rows + bottom
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

  it('grows the box to fit a longer value without overflowing the right border', () => {
    const output = renderBootBanner(
      opts({ port: 7900, dbPath: '/tmp/recued-target/recued.db', recipeCount: 191, ingredientCount: 104, llmConfig: undefined, pairingCode: null }),
    );
    expect(widths(boxLines(output)).size).toBe(1); // still aligned
    expect(output).toContain('/tmp/recued-target/recued.db'); // fits → shown in full
  });

  it('middle-ellipsizes a value too long for the cap, keeping head + tail', () => {
    const longPath = '/Users/somebody/Library/Application Support/recued/data/recued-server.db';
    const output = renderBootBanner(
      opts({ port: 7717, dbPath: longPath, recipeCount: 8, ingredientCount: 1200, llmConfig: undefined, pairingCode: null }),
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
      opts({ port: 8123, recipeCount: 0, ingredientCount: 0, llmConfig: undefined, pairingCode: 'ABCDEFGH', notEnrolled: true, lanBindAddress: '192.168.1.50', webclientServed: true }),
    );

    expect(widths(boxLines(output)).size).toBe(1); // box still aligns
    expect(output).toContain('Not enrolled');
    expect(output).toContain(
      '⚠  Server is not encrypted yet — operations are blocked until you',
    );
    expect(output).toContain('Open the Recued webclient:');
    // hosted webclient is the top target; local (bundled) is the second.
    const hostedIdx = output.indexOf('https://app.recued.com');
    const localIdx = output.indexOf('http://192.168.1.50:8123/webclient/');
    expect(hostedIdx).toBeGreaterThanOrEqual(0);
    expect(localIdx).toBeGreaterThan(hostedIdx);
    // Server URL uses the LAN bind address (NOT localhost) so a LAN device can reach it.
    expect(output).toContain('Server URL:    http://192.168.1.50:8123');
    expect(output).not.toContain('http://localhost:8123');
    expect(output).toContain('ABCDEFGH');
    expect(output).toContain('expires in 15 min');
    expect(output).toContain('Choose "Generate a new one" to create your 24-word recovery key');
    expect(output).toContain('Pairing code expired? Run:  recued pair');
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
      opts({ port: 8123, recipeCount: 0, ingredientCount: 0, llmConfig: undefined, pairingCode: 'HGFEDCBA', notEnrolled: false, lanBindAddress: '10.0.0.9', webclientServed: true }),
    );

    expect(output).toContain('Running');
    expect(output).toContain('Add a browser'); // enrolled variant copy
    expect(output).toContain('https://app.recued.com');
    expect(output).toContain('http://10.0.0.9:8123/webclient/');
    expect(output).toContain('HGFEDCBA');
    expect(output).toContain('expires in 15 min');
    expect(output).not.toContain('Server is not encrypted yet');
  });
});

describe('logBootBanner', () => {
  it('logs the rendered banner through the injected logger', () => {
    const log = vi.fn();

    logBootBanner(opts({ port: 3000, recipeCount: 1, ingredientCount: 2, llmConfig: undefined, log }));

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
