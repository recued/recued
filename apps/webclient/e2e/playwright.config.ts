import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

// Absolute path to this config's dir, so the webServer's `--directory` is
// cwd-independent (Playwright spawns webServer.command with cwd = config dir,
// not the repo root).
const CONFIG_DIR = dirname(fileURLToPath(import.meta.url));

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
/** The local harness the publicly-shipped specs drive. */
const HARNESS_ORIGIN = 'http://127.0.0.1:4319';

export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: './.playwright-artifacts',
  // Serve the render harness over HTTP — Chromium blocks `<script type=module>`
  // loaded from a `file://` (opaque-origin) page under CORS, so the harness must
  // come off a real origin. Zero-dep static server over the built harness dir.
  webServer: {
    command: `python3 -m http.server 4319 --bind 127.0.0.1 --directory "${CONFIG_DIR}/harness"`,
    url: 'http://127.0.0.1:4319/kitchen-harness.html',
    reuseExistingServer: true,
    timeout: 30_000,
  },
  use: {
    // ⛔ LOCAL BY DEFAULT. This used to name the operator's staging origin, so a
    // public checkout's `npx playwright test` defaulted at someone else's
    // deployment — and it put that hostname in public source for a spec that is
    // not even exported. Deployed runs pass E2E_BASE_URL.
    baseURL: process.env.E2E_BASE_URL ?? HARNESS_ORIGIN,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
