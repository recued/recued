import { describe, expect, it } from 'vitest';

import { BOOTSTRAP_TEMPLATE, presetOverlay } from '../presets.js';

// The three `presets/*.toml` files this used to parse were deleted on
// 2026-10-09. This test was their only reader: the loader takes its defaults
// from `presets.ts` and the schema, nothing copied the files to a config path,
// and they still set the four removed bootstrap keys.
describe('presets', () => {
  it('exposes overlays for all three distributions, all empty now', () => {
    // They differed only in `log.level` (and `bind_host` before it), which
    // nothing read: removed 2026-10-10 (2026-10-09).
    for (const distribution of ['binary', 'source', 'server'] as const) {
      expect(presetOverlay(distribution)).toEqual({ bootstrap: {}, runtime: {} });
    }
  });

  it('BOOTSTRAP_TEMPLATE listens on 7717 with webhooks off', () => {
    expect(BOOTSTRAP_TEMPLATE).toEqual({ bind_port: 7717, webhooks_enabled: false });
  });
});
