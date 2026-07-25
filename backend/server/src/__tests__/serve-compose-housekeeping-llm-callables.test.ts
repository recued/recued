import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const llmMocks = vi.hoisted(() => ({
  composeHousekeepingLlmCallables: vi.fn(),
}));

vi.mock('../composition/bin/wire-llm-substrate.js', () => ({
  composeHousekeepingLlmCallables: llmMocks.composeHousekeepingLlmCallables,
}));

import {
  composeHousekeepingLlmCallables,
  type HousekeepingLlmCallableSubstrate,
} from '../serve/compose-housekeeping-llm-callables.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const composeHousekeepingLlmCallablesPath = join(
  repoRoot,
  'backend/server/src/serve/compose-housekeeping-llm-callables.ts',
);
const startHousekeepingStartupPath = join(
  repoRoot,
  'backend/server/src/serve/start-housekeeping-startup.ts',
);
const startPostListenerRuntimePath = join(
  repoRoot,
  'backend/server/src/serve/start-post-listener-runtime.ts',
);
const startListenerExposureRuntimePath = join(
  repoRoot,
  'backend/server/src/serve/start-listener-exposure-runtime.ts',
);

const makeSubstrate = (): HousekeepingLlmCallableSubstrate =>
  ({
    llmManager: { tag: 'llm-manager' },
    llmConfig: { tag: 'llm-config' },
    llmQuota: { tag: 'llm-quota' },
    llmAdapterRegistry: { tag: 'llm-adapter-registry' },
    llmEmbeddingsAdapterRegistry: { tag: 'llm-embeddings-adapter-registry' },
    emptyTabProbe: vi.fn(async () => new Set()),
  }) as unknown as HousekeepingLlmCallableSubstrate;

beforeEach(() => {
  llmMocks.composeHousekeepingLlmCallables.mockReset();
});

describe('composeHousekeepingLlmCallables serve boundary', () => {
  it('delegates the preserved LLM substrate inputs to the wire composer', () => {
    const substrate = makeSubstrate();
    const bundle = {
      llm: vi.fn(),
      llmWithMeta: vi.fn(),
      resolveLLMModelId: vi.fn(),
      embed: vi.fn(),
      transcribe: vi.fn(),
    };
    llmMocks.composeHousekeepingLlmCallables.mockReturnValue(bundle);

    const result = composeHousekeepingLlmCallables({ substrate });

    expect(result).toBe(bundle);
    expect(llmMocks.composeHousekeepingLlmCallables).toHaveBeenCalledTimes(1);
    expect(llmMocks.composeHousekeepingLlmCallables).toHaveBeenCalledWith({
      substrate,
    });
  });
});

describe('compose-housekeeping-llm-callables source boundary', () => {
  it('keeps housekeeping LLM callable startup behind the housekeeping startup orchestrator', () => {
    const bridgeSource = readFileSync(startListenerExposureRuntimePath, 'utf8');
    const runtimeSource = readFileSync(startPostListenerRuntimePath, 'utf8');
    const startupSource = readFileSync(startHousekeepingStartupPath, 'utf8');

    expect(bridgeSource).toMatch(/start-post-listener-runtime\.js/);
    expect(runtimeSource).toMatch(/start-housekeeping-startup\.js/);
    expect(runtimeSource).toMatch(/startHousekeepingStartup\(\{/);
    expect(startupSource).toMatch(/\.\/compose-housekeeping-llm-callables\.js/);
    expect(startupSource).toMatch(/composeHousekeepingLlmCallables\(\{/);
  });

  it('preserves vendor, LLM callable, and housekeeping scheduler order', () => {
    const source = readFileSync(startHousekeepingStartupPath, 'utf8');
    const vendorIndex = source.indexOf(
      'const vendorRefs = await composeVendorSubstrateContext({',
    );
    const llmCallablesIndex = source.indexOf(
      'const housekeepingLlmCallables = composeHousekeepingLlmCallables({',
    );
    const schedulerIndex = source.indexOf('return startServeHousekeepingScheduler({');

    expect(vendorIndex).toBeGreaterThanOrEqual(0);
    expect(llmCallablesIndex).toBeGreaterThan(vendorIndex);
    expect(schedulerIndex).toBeGreaterThan(llmCallablesIndex);
  });

  it('keeps the helper focused on the callable substrate only', () => {
    const source = readFileSync(composeHousekeepingLlmCallablesPath, 'utf8');

    expect(source).toMatch(/composeWireHousekeepingLlmCallables/);
    expect(source).toMatch(/llmManager/);
    expect(source).toMatch(/llmConfig/);
    expect(source).toMatch(/llmQuota/);
    expect(source).toMatch(/llmAdapterRegistry/);
    expect(source).toMatch(/llmEmbeddingsAdapterRegistry/);
    expect(source).toMatch(/emptyTabProbe/);
    expect(source).not.toMatch(/composeVendorSubstrate/);
    expect(source).not.toMatch(/composeSchedulers|composeHousekeepingScheduler/);
    expect(source).not.toMatch(/startRetentionPruners|startDdnsUpdatePoller/);
    expect(source).not.toMatch(/createServerHandlerSet|createProductionPathListenerCoordinator/);
    expect(source).not.toMatch(/createLifecycle|LockHeldError|process\.on|process\.exit/);
  });
});
