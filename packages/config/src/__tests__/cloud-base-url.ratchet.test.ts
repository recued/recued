import { describe, expect, it } from 'vitest';

import { RUNTIME_SCHEMA_MAP } from '../schema.js';

/** The production cloud host, pinned.
 *
 *  ⛔ THE BUG THIS EXISTS FOR (found 2026-08-26). `cloud.base_url` defaulted to
 *  `https://api.recued.cloud`, a host that has NEVER existed — NXDOMAIN, no
 *  record ever published. The `recued-cloud` worker is deployed to
 *  `api.recued.com`, and the live-drive scripts and compose-listeners.ts already
 *  hardcoded that, so the schema default was the last copy still wrong. Any
 *  server on the default therefore reached nothing, and per the schema's own
 *  note the Pro-provisioning tick then skips SILENTLY — no reserve, no DDNS, no
 *  error.
 *
 *  🔑 IT SURVIVED BECAUSE NOTHING PINNED IT. The 2026-08-05 live drive lost
 *  hours to the same symptom and produced `misplaced-keys.test.ts`, which
 *  hardened how an override is WRITTEN — while the value being overridden stayed
 *  wrong for another three weeks. Hardening the mechanism is not checking the
 *  value.
 *
 *  ⚠ THE LITERAL IS DELIBERATE. The deploy authority is
 *  `backend/api/wrangler.sync.toml` (`routes = [{ pattern = "api.recued.com" }]`),
 *  but that path is a PRIVATE export root: a test reaching into it would be
 *  dropped from the public payload, or ship and fail on a public clone with the
 *  file absent. So this restates the host and names where to verify it, rather
 *  than reading across the boundary. */
describe('cloud.base_url default', () => {
  it('names the worker that is actually deployed', () => {
    expect(RUNTIME_SCHEMA_MAP['cloud.base_url']?.default).toBe('https://api.recued.com');
  });

  it('never names the zone that has no cloud API', () => {
    // recued.cloud is retired as a fleet zone and never hosted the API at all.
    const entry = RUNTIME_SCHEMA_MAP['cloud.base_url'];
    expect(String(entry?.default)).not.toContain('recued.cloud');
    expect(String(entry?.description)).not.toContain('api.recued.cloud');
  });
});
