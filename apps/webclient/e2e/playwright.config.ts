import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import { configureWebclientArtifacts } from './harness/artifacts.mjs';

// Resolve the owned server's working directory independently of caller cwd.
const CONFIG_DIR = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = configureWebclientArtifacts(CONFIG_DIR);

/**
 * Browser e2e for the webclient PWA.
 *
 *   npm run e2e:webclient
 *
 * Two layers (see the two specs):
 *   • staging-smoke.spec.ts — a REAL browser against a deployed origin named
 *     by E2E_BASE_URL: the PWA boots, the unpaired
 *     pair-form is the reachable surface, and the shipped bundle carries the
 *     Edit→Kitchen routing. Never point at production (it only reads).
 *   • kitchen-render.spec.ts — the shipped `#kitchen` route-target components
 *     (recipe editor + pack builder) rendered in Chromium off a local
 *     mock-conn harness, since those routes dispatch inside the paired
 *     bootstrap and aren't reachable on staging without a paired server.
 *
 * Env:
 *   E2E_BASE_URL   target webclient origin for the smoke spec. REQUIRED for
 *                  it — the default is the LOCAL harness, because the specs
 *                  that ship publicly all drive that and a public checkout
 *                  must not default at anyone's deployed origin.
 *
 * Prereq: `node e2e/harness/build-harness.mjs` (bundles the render harness).
 * The `npm run e2e:webclient` script does this for you.
 */
export default defineConfig({
  testDir: '.',
  // The real paired-workflow lane builds a binary and enrolls a throwaway
  // realm. Run it explicitly with e2e:webclient:paired.
  testIgnore: '**/paired/**',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: OUTPUT_DIR,
  // Serve the render harness over HTTP — Chromium blocks `<script type=module>`
  // loaded from a `file://` (opaque-origin) page under CORS, so the harness must
  // come off a real origin. Python binds port 0 once and keeps that listener;
  // named captures reach workers through Playwright's server lifecycle.
  webServer: {
    command: 'python3 serve-harness.py',
    cwd: `${CONFIG_DIR}/harness`,
    wait: {
      stdout: /RECUED_HARNESS_READY (?<WEBCLIENT_HARNESS_ORIGIN>(?<PLAYWRIGHT_TEST_BASE_URL>http:\/\/127\.0\.0\.1:\d+))\r?\n/,
    },
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 3_000 },
    timeout: 30_000,
  },
  use: {
    // ⛔ LOCAL BY DEFAULT. This used to name the operator's staging origin, so a
    // public checkout's `npx playwright test` defaulted at someone else's
    // deployment — and it put that hostname in public source for a spec that is
    // not even exported. Deployed runs pass E2E_BASE_URL.
    // The default baseURL fixture reads the captured PLAYWRIGHT_TEST_BASE_URL.
    ...(process.env.E2E_BASE_URL ? { baseURL: process.env.E2E_BASE_URL } : {}),
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
