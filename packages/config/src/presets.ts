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

const BINARY_OVERLAY: PresetOverlay = {
  bootstrap: {
    bind_host: '127.0.0.1',
    bind_port: 7717,
    mcp_port: 7718,
    webhook_port: 0,
  },
  runtime: {
    'log.level': 'info',
  },
};

const SOURCE_OVERLAY: PresetOverlay = {
  bootstrap: {
    bind_host: '127.0.0.1',
    bind_port: 7717,
    mcp_port: 7718,
    webhook_port: 0,
  },
  runtime: {
    'log.level': 'debug',
  },
};

const SERVER_OVERLAY: PresetOverlay = {
  bootstrap: {
    bind_host: '0.0.0.0',
    bind_port: 7717,
    mcp_port: 7718,
    webhook_port: 0,
  },
  runtime: {
    'log.level': 'info',
  },
};

export const presetOverlay = (distribution: Distribution): PresetOverlay => {
  switch (distribution) {
    case 'binary': return BINARY_OVERLAY;
    case 'source': return SOURCE_OVERLAY;
    case 'server': return SERVER_OVERLAY;
  }
};

/** Universal bootstrap template. Everything here is safe no-op defaults
 *  that a preset is expected to tighten. `data_path` is filled in at
 *  load-time by the OS-path resolver. */
export const BOOTSTRAP_TEMPLATE: Omit<BootstrapConfig, 'data_path'> = {
  bind_host: '127.0.0.1',
  bind_port: 7717,
  mcp_port: 7718,
  webhook_port: 0,
  log_path: '{data_path}/logs',
};
