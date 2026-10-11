/** Preset overlays per distribution. Each preset returns the patch that
 *  layers on top of the shared runtime defaults + the universal bootstrap
 *  template. Patches stay small on purpose — the load pipeline merges
 *  them with the rest of the schema so a new field added in `schema.ts`
 *  automatically picks up the universal default without preset edits. */

import type { BootstrapConfig, Distribution, RuntimeConfig } from './types.js';

/** Shape of the patch each preset supplies. Missing fields fall through
 *  to the shared defaults. */
export interface PresetOverlay {
  bootstrap: Partial<BootstrapConfig>;
  runtime: Partial<RuntimeConfig>;
}

// The three distributions take the same defaults. They differed in
// `bind_host` and in `log.level`, neither of which anything read; both were
// removed (2026-10-09, `bootstrap-keys.ts`; 2026-10-10, `schema.ts`).
const BINARY_OVERLAY: PresetOverlay = { bootstrap: {}, runtime: {} };
const SOURCE_OVERLAY: PresetOverlay = { bootstrap: {}, runtime: {} };
const SERVER_OVERLAY: PresetOverlay = { bootstrap: {}, runtime: {} };

export const presetOverlay = (distribution: Distribution): PresetOverlay => {
  switch (distribution) {
    case 'binary': return BINARY_OVERLAY;
    case 'source': return SOURCE_OVERLAY;
    case 'server': return SERVER_OVERLAY;
  }
};

/** Universal bootstrap template: the defaults every distribution starts
 *  from. Webhooks are off until an operator turns them on. */
export const BOOTSTRAP_TEMPLATE: BootstrapConfig = {
  bind_port: 7717,
  webhooks_enabled: false,
};
