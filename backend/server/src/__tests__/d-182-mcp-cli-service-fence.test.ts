/** D-182 §8 — the MCP per-ingredient fence (Codex F4 from increment 3).
 *
 *  `cli` / `service` ingredients are local code-exec / external subprocess and
 *  are NEVER door-exposable (`external_exposable: false`): an external actor may
 *  *trigger a recipe* that uses one internally (Gateway-gated via the §7.2
 *  reachability grant), but can NEVER call it directly as a raw
 *  `recued_ingredient_<slug>` MCP tool. This invariant must hold across EVERY MCP
 *  per-ingredient surface — the dynamic tools/list, the grant-catalog
 *  projection, and the tools/call dispatch routing (a structural backstop that
 *  fires on every transport, incl. the stdio owner who has no per-token gate).
 *
 *  The ratchet: an installed cli/service catalog NEVER appears as a
 *  `recued_ingredient_<slug>` tool, and a direct call is refused. */

import { describe, expect, it } from 'vitest';

import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import {
  _testing,
  buildMcpGrantCatalogLegacyEntries,
} from '../mcp-server.js';
import {
  isExternallyExposableIngredient,
  type IngredientManifest,
  type ProviderSurfaces,
} from '@recued/contracts';

// ── fixtures ─────────────────────────────────────────────────────────

/** A normal third-party ingredient — externally exposable (the control). */
const aiClassify: IngredientManifest = {
  slug: 'ai-classify',
  name: 'AI Classifier',
  description: 'Pick one category from a closed list.',
  author: 'recued-core',
  kind: 'ai',
  version: 1,
  category: 'ai',
  risk_tier: 'read',
  tags: ['ai'],
  input: { 'llm.data': null },
  output: {},
};

/** A cli catalog — rides a connector surface with `cli_invocation` runtime.
 *  `author` is non-kernel, so the kernel-exposure gate ALONE would expose it;
 *  the §8 fence is what keeps it off the wire. The connector surface is cast
 *  (only `runtime` matters to the fence detector). */
const whisperCli: IngredientManifest = {
  slug: 'whisper-catalog',
  name: 'Whisper',
  description: 'Transcribe audio with a local binary.',
  author: 'recued-core',
  kind: 'connection',
  version: 1,
  category: 'action',
  risk_tier: 'write',
  tags: [],
  input: {},
  output: {},
  surfaces: {
    connector: {
      runtime: {
        transport: 'stdio',
        wire_protocol: 'cli_invocation',
        package_ref: 'system_binary:whisper',
        entry_point: 'whisper',
        expected_protocol_version: 1,
      },
    },
  } as unknown as ProviderSurfaces,
};

/** A D-118 service catalog — `kind: 'service'`. */
const longService: IngredientManifest = {
  slug: 'indexer-service',
  name: 'Indexer service',
  description: 'A long-running local service.',
  author: 'recued-core',
  kind: 'service',
  version: 1,
  category: 'action',
  risk_tier: 'write',
  tags: [],
  input: {},
  output: {},
};

/** D-173 P5 — a recipe-internal kernel WRITER (author `recued`, NOT in
 *  `MCP_EXPOSED_KERNEL_INGREDIENTS`). Hidden from tools/list + ungrantable; the
 *  dispatch backstop must refuse a direct `recued_ingredient_<slug>` call so a
 *  guessed slug can never forge a scan verdict / warehouse write. */
const fileSetScanStatus: IngredientManifest = {
  slug: 'file-set-scan-status',
  name: 'Report a file scan verdict',
  description: 'Patch a data.file.received record scan_status (recipe-internal).',
  author: 'recued',
  kind: 'storage',
  version: 1,
  category: 'data',
  risk_tier: 'write',
  tags: ['kernel'],
  input: { record_id: null, status: null },
  output: {},
};

/** D-173 P5 — the ONE kernel ingredient authored `mcp_exposed: true` (D-228
 *  slice 2 replaced the `MCP_EXPOSED_KERNEL_INGREDIENTS` hand-list with the
 *  field). It must PASS the backstop (stay callable). */
const dataFileRead: IngredientManifest = {
  slug: 'data-file-read',
  mcp_exposed: true,
  name: 'Read a file',
  description: 'Read content bytes from data.file.received.',
  author: 'recued',
  kind: 'storage',
  version: 1,
  category: 'data',
  risk_tier: 'read',
  tags: ['kernel'],
  input: { record_id: null },
  output: {},
};

const registryWithFenced = () => {
  const manifests = createManifestRegistry('/nonexistent');
  manifests.register(aiClassify);
  manifests.register(whisperCli);
  manifests.register(longService);
  return manifests;
};

const registryWithKernel = () => {
  const manifests = createManifestRegistry('/nonexistent');
  manifests.register(aiClassify);
  manifests.register(fileSetScanStatus);
  manifests.register(dataFileRead);
  return manifests;
};

const depsFor = (manifests: ReturnType<typeof registryWithFenced>) =>
  ({
    // ⛔⛔ D-228 slice 6 — REQUIRED, and NOT a weakening of this file's subject.
    // An absent checklist now denies at both `handleToolsList` and
    // `handleToolCall`, so without this every test here would go green for the
    // WRONG REASON: the token gate would refuse first and the KIND fence
    // (`isExternallyExposableIngredient`) — the actual subject — would never
    // run. A permissive checklist is also the production-faithful shape: a real
    // caller on this path presents a token, and the KIND fence is what must
    // still refuse a cli/service catalog AFTER the gate admits it.
    inboundTokenAuthorize: () => true,
    recipeStore: createRecipeStore('/nonexistent'),
    executorConfig: { manifests },
    baseVault: {},
  }) as unknown as Parameters<typeof _testing.handleToolCall>[1];

// ════════════════════════════════════════════════════════════════════

describe('D-182 §8 — isExternallyExposableIngredient (the single source of truth)', () => {
  it('a normal ingredient is externally exposable', () => {
    expect(isExternallyExposableIngredient(aiClassify)).toBe(true);
  });

  it('a cli (cli_invocation connector) ingredient is NOT externally exposable', () => {
    expect(isExternallyExposableIngredient(whisperCli)).toBe(false);
  });

  it('a service-kind ingredient is NOT externally exposable', () => {
    expect(isExternallyExposableIngredient(longService)).toBe(false);
  });

  it('null/undefined fails closed (not exposable)', () => {
    expect(isExternallyExposableIngredient(null)).toBe(false);
    expect(isExternallyExposableIngredient(undefined)).toBe(false);
  });

  it('fences a manifest with a per-operation cli_invocation binding even under a non-cli runtime', () => {
    // Malformed/hand-authored local catalog: runtime says `mcp`, but an op
    // binding is `cli_invocation` — the gateway would route it to the cli
    // executor at call time, so the fence must catch the per-op binding too.
    const sneakyCli: IngredientManifest = {
      ...whisperCli,
      slug: 'sneaky-cli-catalog',
      surfaces: {
        connector: {
          runtime: {
            transport: 'stdio',
            wire_protocol: 'mcp',
            package_ref: '@vendor/looks-remote',
            entry_point: 'serve',
            expected_protocol_version: 1,
          },
          executes: { 'audio.transcribe': { kind: 'cli_invocation' } },
        },
      } as unknown as ProviderSurfaces,
    };
    expect(isExternallyExposableIngredient(sneakyCli)).toBe(false);
  });

  it('a non-cli connector (e.g. mcp wire) stays exposable — the fence is cli/service-only', () => {
    const mcpConnector: IngredientManifest = {
      ...whisperCli,
      slug: 'remote-mcp-catalog',
      surfaces: {
        connector: {
          runtime: {
            transport: 'stdio',
            wire_protocol: 'mcp',
            package_ref: '@vendor/mcp',
            entry_point: 'serve',
            expected_protocol_version: 1,
          },
        },
      } as unknown as ProviderSurfaces,
    };
    expect(isExternallyExposableIngredient(mcpConnector)).toBe(true);
  });
});

describe('D-182 §8 — tools/list never advertises a cli/service catalog', () => {
  it('lists the normal ingredient, excludes the cli + service catalogs', async () => {
    const manifests = registryWithFenced();
    const deps = depsFor(manifests);
    const res = (await _testing.handleToolsList(deps)) as {
      tools: Array<{ name: string }>;
    };
    const names = res.tools.map((t) => t.name);
    expect(names).toContain('recued_ingredient_ai-classify');
    expect(names).not.toContain('recued_ingredient_whisper-catalog');
    expect(names).not.toContain('recued_ingredient_indexer-service');
  });
});

describe('D-182 §8 — the grant catalog never offers a cli/service catalog', () => {
  it('projects the normal ingredient, excludes the cli + service catalogs', () => {
    const manifests = registryWithFenced();
    const entries = buildMcpGrantCatalogLegacyEntries(manifests);
    const names = entries.map((e) => e.name);
    expect(names).toContain('recued_ingredient_ai-classify');
    expect(names).not.toContain('recued_ingredient_whisper-catalog');
    expect(names).not.toContain('recued_ingredient_indexer-service');
  });
});

describe('D-182 §8 — tools/call refuses a direct cli/service dispatch (structural backstop)', () => {
  it('refuses a raw recued_ingredient_<cli-slug> call', async () => {
    const manifests = registryWithFenced();
    const deps = depsFor(manifests);
    const res = (await _testing.handleToolCall(
      { name: 'recued_ingredient_whisper-catalog', arguments: {} },
      deps,
    )) as { isError?: boolean; content: Array<{ text: string }> };
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain('D-182 §8');
    expect(res.content[0]?.text).toContain('recipe-internal');
  });

  it('refuses a raw recued_ingredient_<service-slug> call', async () => {
    const manifests = registryWithFenced();
    const deps = depsFor(manifests);
    const res = (await _testing.handleToolCall(
      { name: 'recued_ingredient_indexer-service', arguments: {} },
      deps,
    )) as { isError?: boolean; content: Array<{ text: string }> };
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain('D-182 §8');
  });

  it('does NOT fence a normal ingredient at the dispatch backstop', async () => {
    // The fence must not fire for an exposable ingredient: the call proceeds
    // past the §8 backstop (and then fails for unrelated missing-deps reasons in
    // this minimal harness). We assert only that the §8 refusal is NOT what came
    // back — i.e. the fence let it through.
    const manifests = registryWithFenced();
    const deps = depsFor(manifests);
    const res = (await _testing.handleToolCall(
      { name: 'recued_ingredient_ai-classify', arguments: {} },
      deps,
    )) as { isError?: boolean; content: Array<{ text: string }> };
    expect(res.content[0]?.text ?? '').not.toContain('D-182 §8');
  });
});

describe('D-173 P5 — tools/call refuses a non-exposed kernel ingredient (backstop matches tools/list)', () => {
  it('refuses a raw recued_ingredient_<kernel-writer> call (file-set-scan-status)', async () => {
    // A guessed direct call to a recipe-internal kernel writer must be refused
    // STRUCTURALLY — the policy gate fails closed for an external token, but the
    // owner's no-token stdio path would otherwise dispatch it. The backstop keeps
    // the MCP-reserved invariant airtight (no forged scan verdicts).
    const deps = depsFor(registryWithKernel());
    const res = (await _testing.handleToolCall(
      { name: 'recued_ingredient_file-set-scan-status', arguments: { record_id: 'file:x', status: 'clean' } },
      deps,
    )) as { isError?: boolean; content: Array<{ text: string }> };
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain('recipe-internal kernel ingredient');
  });

  it('does NOT fence the whitelisted kernel ingredient (data-file-read passes the backstop)', async () => {
    // The one MCP_EXPOSED_KERNEL_INGREDIENTS member must stay callable: the
    // backstop lets it through (it then fails for unrelated missing-deps reasons
    // in this minimal harness). Assert only that NEITHER fence message came back.
    const deps = depsFor(registryWithKernel());
    const res = (await _testing.handleToolCall(
      { name: 'recued_ingredient_data-file-read', arguments: { record_id: 'file:x' } },
      deps,
    )) as { isError?: boolean; content: Array<{ text: string }> };
    const text = res.content[0]?.text ?? '';
    expect(text).not.toContain('recipe-internal kernel ingredient');
    expect(text).not.toContain('D-182 §8');
  });
});
