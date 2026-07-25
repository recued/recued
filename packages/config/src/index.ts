/** @recued/config — TOML-backed server config loader.
 *
 *  Public surface:
 *    loadConfig(opts) → LoadResult
 *    writeConfigField(opts) → void
 *    RUNTIME_SCHEMA / RUNTIME_SCHEMA_MAP
 *    ConfigValidationError
 *    Default path helpers for tests and docs. */

export { loadConfig, ConfigValidationError } from './loader.js';
export type { LoadResult } from './loader.js';

export { writeConfigField } from './write.js';
export type { WriteFieldOptions } from './write.js';

export { createRuntimeConfigStore } from './runtime-store.js';
export type {
  RuntimeConfigStore,
  RuntimeConfigStoreOptions,
} from './runtime-store.js';

export { parseToml, runtimeDefaults } from './parse.js';
export type { ParsedToml } from './parse.js';

export { envConfigPath, envOverrides } from './env.js';
export { parseCliOverrides } from './cli.js';
export type { CliOverrides } from './cli.js';

export {
  RUNTIME_SCHEMA,
  RUNTIME_SCHEMA_MAP,
} from './schema.js';
export type { RuntimeKey } from './schema.js';

export {
  defaultConfigPath,
  defaultDataPath,
  detectOs,
  expandDataPath,
  expandHome,
  resolveBootstrapPath,
} from './paths.js';
export type { Os, PathEnv } from './paths.js';

export { presetOverlay, BOOTSTRAP_TEMPLATE } from './presets.js';
export type { PresetOverlay } from './presets.js';

export type {
  BootstrapConfig,
  Distribution,
  LoadOptions,
  LoadedConfig,
  RuntimeConfig,
  RuntimeValue,
  ScalarSchemaEntry,
  ScalarType,
} from './types.js';
