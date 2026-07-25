/** `recued-server llm *` subcommands.
 *
 *  Local-DB operations — no daemon required. Each helper reads/writes
 *  the LLMConfigManager directly; the calling process exits (non-zero)
 *  on argument validation failures to match the existing CLI shape.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type {
  LLMConfig, LLMSlot, FreePoolApiEntry, FreePoolEntry,
} from '@recued/llm';
import { parseLLMConfig, LLMConfigValidationError } from '@recued/llm';
import type { ModelHint } from '@recued/contracts';
import type { LLMConfigManager } from '../llm-config.js';
import { argValue, argFlag, argNumeric } from '../cli/parse.js';

export interface LLMCommandDeps {
  llmManager: LLMConfigManager;
}

export function cmdLLM(deps: LLMCommandDeps, args: string[]): void {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'show':                    return llmShow(deps, rest);
    case 'set-slot':                return llmSetSlot(deps, rest);
    case 'set-budget':              return llmSetBudget(deps, rest);
    case 'set-strategy':            return llmSetStrategy(deps, rest);
    case 'set-allow-upgrade':       return llmSetAllowUpgrade(deps, rest);
    case 'list-pool-entries':       return llmListPoolEntries(deps, rest);
    case 'add-pool-entry':          return llmAddPoolEntry(deps, rest);
    case 'remove-pool-entry':       return llmRemovePoolEntry(deps, rest);
    case 'export':                  return llmExport(deps, rest);
    case 'import':                  return llmImport(deps, rest);
    default:                        return llmHelp();
  }
}

export function llmHelp(): void {
  console.log([
    'Usage: recued llm <subcommand>',
    '',
    '  show [--reveal-keys]          Print current LLM config (keys redacted by default).',
    '  set-slot <slot> --provider <p> --model <m> --api-key <k>',
    '                                [--base-url <u>] [--speed fast|quality|thinking]',
    '                                [--supports-json] [--supports-search]',
    '                                Set slot_1 or slot_2. Pass empty --api-key to clear.',
    '  set-budget <tokens>           Set daily token budget (0 = unlimited).',
    '  set-strategy <name>           Coordination strategy: round_robin | weighted.',
    '  set-allow-upgrade <bool>      Global fallback for allow_llm_upgrade (true|false).',
    '',
    '  list-pool-entries [--reveal-keys]',
    '                                Print current free-pool entries (keys redacted by default).',
    '  add-pool-entry --type api --id <i> --provider <p> --model <m> --api-key <k>',
    '                                --speed fast|quality|thinking [--base-url <u>]',
    '                                [--supports-json] [--supports-search]',
    '                                [--weight <n>] [--daily-cap-tokens <n>] [--rpm-cap <n>]',
    '                                Append an entry to the free pool. --id must be unique.',
    '  remove-pool-entry --id <i>    Remove a pool entry by id.',
    '',
    '  export <path> [--with-keys]   Write config as JSON (keys redacted unless --with-keys).',
    '  import <path>                 Read config from JSON file and replace current config.',
  ].join('\n'));
}

function redactSlot<T extends { api_key?: string }>(slot: T | undefined): T | undefined {
  if (!slot) return slot;
  if (!slot.api_key) return slot;
  return { ...slot, api_key: `***${slot.api_key.slice(-4)}` };
}

function redactConfig(cfg: LLMConfig, reveal: boolean): LLMConfig {
  if (reveal) return cfg;
  const out: LLMConfig = { ...cfg };
  if (out.slot_1) out.slot_1 = redactSlot(out.slot_1)!;
  if (out.slot_2) out.slot_2 = redactSlot(out.slot_2)!;
  if (out.free_pool) {
    out.free_pool = out.free_pool.map((e) => {
      if (e.type === 'api' && e.api_key) {
        return { ...e, api_key: `***${e.api_key.slice(-4)}` };
      }
      return e;
    });
  }
  return out;
}

/** Validate a ModelHint value or exit. */
function requireSpeed(raw: string | undefined, flag: string): ModelHint {
  if (raw !== 'fast' && raw !== 'quality' && raw !== 'thinking') {
    console.error(`--${flag} must be one of: fast | quality | thinking (got '${raw ?? ''}').`);
    process.exit(1);
  }
  return raw;
}

function llmShow({ llmManager }: LLMCommandDeps, args: string[]) {
  const reveal = argFlag(args, 'reveal-keys');
  const cfg = llmManager.getConfig();
  const budget = llmManager.getBudget();
  const usage = llmManager.getUsage();
  const out = {
    config: redactConfig(cfg, reveal),
    budget,
    usage_today: usage,
  };
  console.log(JSON.stringify(out, null, 2));
}

function llmSetSlot({ llmManager }: LLMCommandDeps, args: string[]) {
  const slotName = args[0];
  if (slotName !== 'slot_1' && slotName !== 'slot_2') {
    console.error('Usage: recued llm set-slot <slot_1|slot_2> --provider ... --model ... --api-key ...');
    process.exit(1);
  }
  const apiKey = argValue(args, 'api-key');
  if (apiKey === '') {
    // Explicit clear
    if (slotName === 'slot_1') llmManager.setSlot1(null);
    else llmManager.setSlot2(null);
    console.log(`${slotName} cleared.`);
    return;
  }
  const provider = argValue(args, 'provider');
  const model = argValue(args, 'model');
  if (!provider || !model || !apiKey) {
    console.error('Missing required field. Need --provider, --model, --api-key.');
    process.exit(1);
  }
  if (provider !== 'anthropic' && provider !== 'openai' && provider !== 'openai-compatible' && provider !== 'google') {
    console.error(`Unknown provider '${provider}'. Valid: anthropic | openai | openai-compatible | google.`);
    process.exit(1);
  }
  const speed = argValue(args, 'speed');
  if (speed && speed !== 'fast' && speed !== 'quality' && speed !== 'thinking') {
    console.error(`Invalid --speed '${speed}'. Valid: fast | quality | thinking.`);
    process.exit(1);
  }
  const slot: LLMSlot = {
    provider: provider as LLMSlot['provider'],
    model,
    api_key: apiKey,
  };
  const baseUrl = argValue(args, 'base-url');
  if (baseUrl) slot.base_url = baseUrl;
  if (speed) slot.speed = speed as LLMSlot['speed'];
  if (argFlag(args, 'supports-json')) slot.supports_json = true;
  if (argFlag(args, 'supports-search')) slot.supports_search = true;

  if (slotName === 'slot_1') llmManager.setSlot1(slot);
  else llmManager.setSlot2(slot);
  console.log(`${slotName} set (${provider} / ${model}, speed=${slot.speed ?? 'default'}).`);
}

function llmSetBudget({ llmManager }: LLMCommandDeps, args: string[]) {
  const tokens = parseInt(args[0] ?? '', 10);
  if (!Number.isFinite(tokens) || tokens < 0) {
    console.error('Usage: recued llm set-budget <tokens> (0 = unlimited)');
    process.exit(1);
  }
  llmManager.setBudget(tokens);
  console.log(`Daily token budget set to ${tokens === 0 ? 'unlimited' : tokens}.`);
}

function llmSetStrategy({ llmManager }: LLMCommandDeps, args: string[]) {
  const strategy = args[0];
  if (strategy !== 'round_robin' && strategy !== 'weighted') {
    console.error(`Invalid strategy '${strategy}'. Valid: round_robin | weighted.`);
    process.exit(1);
  }
  llmManager.setPoolStrategy(strategy);
  console.log(`Pool coordination strategy set to '${strategy}'.`);
}

function llmSetAllowUpgrade({ llmManager }: LLMCommandDeps, args: string[]) {
  const raw = (args[0] ?? '').toLowerCase();
  if (raw !== 'true' && raw !== 'false') {
    console.error('Usage: recued llm set-allow-upgrade <true|false>');
    process.exit(1);
  }
  llmManager.setAllowUpgradeDefault(raw === 'true');
  console.log(`Global allow_upgrade_default set to ${raw}.`);
}

function llmListPoolEntries({ llmManager }: LLMCommandDeps, args: string[]) {
  const reveal = argFlag(args, 'reveal-keys');
  const pool = llmManager.getPool();
  const redacted = pool.map((e) => {
    if (!reveal && e.type === 'api' && e.api_key) {
      return { ...e, api_key: `***${e.api_key.slice(-4)}` };
    }
    return e;
  });
  console.log(JSON.stringify(redacted, null, 2));
}

function llmAddPoolEntry({ llmManager }: LLMCommandDeps, args: string[]) {
  const type = argValue(args, 'type');
  const id = argValue(args, 'id');
  if (!id) {
    console.error('--id is required.');
    process.exit(1);
  }
  const pool = llmManager.getPool();
  if (pool.some((e) => e.id === id)) {
    console.error(`A pool entry with id '${id}' already exists. Remove it first or pick a different id.`);
    process.exit(1);
  }

  let entry: FreePoolEntry;
  if (type === 'api') {
    const provider = argValue(args, 'provider');
    const model = argValue(args, 'model');
    const apiKey = argValue(args, 'api-key');
    if (!provider || !model || !apiKey) {
      console.error('Missing required flags. API entries need --provider, --model, --api-key.');
      process.exit(1);
    }
    if (provider !== 'anthropic' && provider !== 'openai' && provider !== 'openai-compatible' && provider !== 'google') {
      console.error(`Unknown provider '${provider}'. Valid: anthropic | openai | openai-compatible | google.`);
      process.exit(1);
    }
    const speed = requireSpeed(argValue(args, 'speed'), 'speed');
    const api: FreePoolApiEntry = {
      id,
      type: 'api',
      provider: provider as FreePoolApiEntry['provider'],
      model,
      api_key: apiKey,
      speed,
      supports_json: argFlag(args, 'supports-json'),
      enabled: true,
    };
    const baseUrl = argValue(args, 'base-url');
    if (baseUrl) api.base_url = baseUrl;
    if (argFlag(args, 'supports-search')) api.supports_search = true;
    const weight = argNumeric(args, 'weight');
    if (weight !== undefined) api.weight = weight;
    const dailyCap = argNumeric(args, 'daily-cap-tokens');
    if (dailyCap !== undefined) api.daily_cap_tokens = dailyCap;
    const rpmCap = argNumeric(args, 'rpm-cap');
    if (rpmCap !== undefined) api.rpm_cap = rpmCap;
    entry = api;
  } else {
    console.error(`--type must be api (got '${type ?? ''}').`);
    process.exit(1);
  }

  llmManager.setPool([...pool, entry]);
  console.log(`Added pool entry '${id}' (${entry.type} / ${entry.provider} / ${entry.model}).`);
}

function llmRemovePoolEntry({ llmManager }: LLMCommandDeps, args: string[]) {
  const id = argValue(args, 'id');
  if (!id) {
    console.error('Usage: recued llm remove-pool-entry --id <id>');
    process.exit(1);
  }
  const pool = llmManager.getPool();
  if (!pool.some((e) => e.id === id)) {
    console.error(`No pool entry with id '${id}'.`);
    process.exit(1);
  }
  llmManager.setPool(pool.filter((e) => e.id !== id));
  console.log(`Removed pool entry '${id}'.`);
}

function llmExport({ llmManager }: LLMCommandDeps, args: string[]) {
  const path = args[0];
  if (!path) {
    console.error('Usage: recued llm export <path> [--with-keys]');
    process.exit(1);
  }
  const reveal = argFlag(args, 'with-keys');
  const cfg = llmManager.getConfig();
  const data = {
    version: 1,
    config: redactConfig(cfg, reveal),
    budget: llmManager.getBudget(),
  };
  writeFileSync(path, JSON.stringify(data, null, 2));
  console.log(`Config exported to ${path}${reveal ? '' : ' (keys redacted; use --with-keys to include)'}.`);
}

function llmImport({ llmManager }: LLMCommandDeps, args: string[]) {
  const path = args[0];
  if (!path) {
    console.error('Usage: recued llm import <path>');
    process.exit(1);
  }
  if (!existsSync(path)) {
    console.error(`File not found: ${path}`);
    process.exit(1);
  }
  const raw = readFileSync(path, 'utf-8');
  let parsed: { config?: LLMConfig; budget?: number } = {};
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error(`Failed to parse JSON: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
  let cfg: LLMConfig;
  try {
    cfg = parseLLMConfig(parsed.config);
  } catch (e) {
    if (e instanceof LLMConfigValidationError) {
      console.error(`Invalid config: ${e.message}`);
    } else {
      console.error(`Failed to validate config: ${e instanceof Error ? e.message : e}`);
    }
    process.exit(1);
  }
  if (cfg.slot_1 !== undefined) llmManager.setSlot1(cfg.slot_1 ?? null);
  if (cfg.slot_2 !== undefined) llmManager.setSlot2(cfg.slot_2 ?? null);
  if (cfg.free_pool !== undefined) llmManager.setPool(cfg.free_pool ?? []);
  if (cfg.free_pool_strategy !== undefined) llmManager.setPoolStrategy(cfg.free_pool_strategy);
  if (cfg.allow_upgrade_default !== undefined) llmManager.setAllowUpgradeDefault(cfg.allow_upgrade_default);
  if (parsed.budget !== undefined && Number.isFinite(parsed.budget)) {
    llmManager.setBudget(parsed.budget);
  }
  console.log(`Config imported from ${path}.`);
}
