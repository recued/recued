/** D-182 §8 — the door-cli-recipe authorization path (the deferred F4 HIGH).
 *
 *  A `cli` ingredient is §8-fenced from raw door exposure (never a
 *  `recued_ingredient_<slug>` tool), so it is ungrantable and never enters a
 *  door's per-token grants → never lands in the contract snapshot's
 *  `allowed_tools`. But a recipe a door TRIGGERS may run the binary internally,
 *  authorized by the §7.2 per-(principal × cli-ingredient × OPERATION)
 *  reachability allowlist. Without the snapshot-admit below, the policy gate
 *  denies that cli step `tool_not_in_contract` BEFORE `executeRecipe` ever reaches
 *  the catalog-gateway's reachability resolver.
 *
 *  `buildMcpContractSnapshot` therefore UNIONS the cli slugs the door's principal
 *  has any reachability grant for into `allowed_tools` (coarse, slug-level — the
 *  gateway resolver still enforces the exact granted OPERATION). This suite pins:
 *    1. the snapshot admit (with/without grant, dead-contract, fail-closed,
 *       principal-scoped, and the service-fence guard — Codex F4-HIGH fold), and
 *    2. the end-to-end policy-gate outcome (a door recipe with a cli step is
 *       admitted iff the grant exists). */

import { describe, expect, it } from 'vitest';

import {
  isCliIngredient,
  isExternallyExposableIngredient,
  type ExecutionSource,
  type IngredientManifest,
  type ProviderSurfaces,
  type RecipeDefinition,
} from '@recued/contracts';

import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { _testing, type McpDeps } from '../mcp-server.js';
import { gateRecipeAgainstPolicy } from '../policy-gate.js';

// ── fixtures ─────────────────────────────────────────────────────────

/** A cli catalog — rides a connector surface with a `cli_invocation` runtime. */
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

/** A D-118 service catalog — `kind: 'service'`. Has NO §7.2 reachability auth
 *  path and must stay fully fenced even if a stray reachability row names it. */
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

/** A MALFORMED hybrid — declares `kind: 'service'` yet also carries a
 *  `cli_invocation` connector runtime. The validator rejects this at install, but
 *  it can reach the live registry. It must be treated as a service (no
 *  reachability auth path), NOT cli — else a stray reachability row for it would
 *  evade the service fence (Codex F4-HIGH follow-on). */
const serviceWithCliBinding: IngredientManifest = {
  slug: 'sneaky-service',
  name: 'Sneaky service',
  description: 'A service that malformedly claims a cli runtime.',
  author: 'recued-core',
  kind: 'service',
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
        package_ref: 'system_binary:sneaky',
        entry_point: 'sneaky',
        expected_protocol_version: 1,
      },
    },
  } as unknown as ProviderSurfaces,
};

/** A normal, externally-exposable third-party ingredient (the control). */
const httpReader: IngredientManifest = {
  slug: 'allowed-http',
  name: 'HTTP reader',
  description: 'fixture',
  author: 'recued-core',
  kind: 'http',
  version: 1,
  category: 'data',
  risk_tier: 'read',
  tags: ['test'],
  input: { url: 'https://example.com/fixture', method: 'GET' },
  output: { body: 'body' },
};

const registry = () => {
  const manifests = createManifestRegistry('/nonexistent');
  manifests.register(httpReader);
  manifests.register(whisperCli);
  manifests.register(longService);
  manifests.register(serviceWithCliBinding);
  return manifests;
};

/** A door's MCP deps: bound to `ct_door`, live, with a per-token grant for the
 *  normal http tool (cli/service are ungrantable, so never in the token grants).
 *  `cliReachableSlugsForPrincipal` is the boot-composer lister; tests inject it. */
const doorDeps = (overrides: Partial<McpDeps> = {}): McpDeps =>
  ({
    recipeStore: createRecipeStore('/nonexistent'),
    executorConfig: { manifests: registry() },
    baseVault: {},
    mcpTokenId: 'tok_door',
    boundContractId: 'ct_door',
    boundContractActive: true,
    // The door's per-token checklist grants only the normal http tool.
    inboundTokenAuthorize: (tool_name: string): boolean =>
      tool_name === 'allowed-http' || tool_name === 'recued_ingredient_allowed-http',
    ...overrides,
  }) as McpDeps;

const snapshotFor = (deps: McpDeps) => {
  const source = _testing.buildMcpExecutionSource(deps);
  return { source, snapshot: _testing.buildMcpContractSnapshot(source, deps) };
};

/** A grant lister that returns `slugs` for `principal`, else nothing. */
const granting = (principal: string, slugs: string[]) =>
  (p: string): string[] => (p === principal ? slugs : []);

// ════════════════════════════════════════════════════════════════════

describe('D-182 §8 — isCliIngredient (the canonical cli detector)', () => {
  it('detects a cli_invocation-runtime connector', () => {
    expect(isCliIngredient(whisperCli)).toBe(true);
  });
  it('a service-kind ingredient is NOT cli (it has no reachability auth path)', () => {
    expect(isCliIngredient(longService)).toBe(false);
  });
  it('a normal ingredient is NOT cli', () => {
    expect(isCliIngredient(httpReader)).toBe(false);
  });
  it('detects a per-operation cli_invocation binding under a non-cli runtime', () => {
    const sneaky: IngredientManifest = {
      ...whisperCli,
      slug: 'sneaky',
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
    expect(isCliIngredient(sneaky)).toBe(true);
  });
  it('null/undefined fails closed (not cli)', () => {
    expect(isCliIngredient(null)).toBe(false);
    expect(isCliIngredient(undefined)).toBe(false);
  });
  it('a kind:service manifest is NEVER cli even with a cli_invocation runtime (service-kind wins)', () => {
    expect(isCliIngredient(serviceWithCliBinding)).toBe(false);
  });

  // Regression pin: isCliIngredient is factored out of isExternallyExposableIngredient,
  // which must stay exactly behavior-preserving (cli + service → false, normal → true).
  it('isExternallyExposableIngredient stays behavior-preserving after the factor-out', () => {
    expect(isExternallyExposableIngredient(httpReader)).toBe(true);
    expect(isExternallyExposableIngredient(whisperCli)).toBe(false); // cli
    expect(isExternallyExposableIngredient(longService)).toBe(false); // service
    expect(isExternallyExposableIngredient(serviceWithCliBinding)).toBe(false); // service+cli hybrid
    expect(isExternallyExposableIngredient(null)).toBe(false);
  });
});

describe('D-182 §8 — buildMcpContractSnapshot cli union (the door-cli auth path)', () => {
  it('admits a granted cli slug into allowed_tools alongside the token grants', () => {
    const deps = doorDeps({
      cliReachableSlugsForPrincipal: granting('ct_door', ['whisper-catalog']),
    });
    const { snapshot } = snapshotFor(deps);
    expect(snapshot.allowed_tools).toContain('whisper-catalog');
    // the normal per-token grant is preserved
    expect(snapshot.allowed_tools).toContain('allowed-http');
  });

  it('does NOT admit a cli slug the principal has no grant for', () => {
    const deps = doorDeps({
      cliReachableSlugsForPrincipal: granting('ct_door', []),
    });
    const { snapshot } = snapshotFor(deps);
    expect(snapshot.allowed_tools).not.toContain('whisper-catalog');
    expect(snapshot.allowed_tools).toEqual(['allowed-http']);
  });

  it('a dead bound contract admits NOTHING even with a cli grant present (kill-switch wins)', () => {
    const deps = doorDeps({
      boundContractActive: false,
      cliReachableSlugsForPrincipal: granting('ct_door', ['whisper-catalog']),
    });
    const { snapshot } = snapshotFor(deps);
    expect(snapshot.allowed_tools).toEqual([]);
  });

  it('fails CLOSED when the lister throws — the cli slug is not admitted, token grants survive', () => {
    const deps = doorDeps({
      cliReachableSlugsForPrincipal: () => {
        throw new Error('transient store read failure');
      },
    });
    const { snapshot } = snapshotFor(deps);
    expect(snapshot.allowed_tools).not.toContain('whisper-catalog');
    expect(snapshot.allowed_tools).toEqual(['allowed-http']);
  });

  it('NEVER admits a non-cli slug even if a stray reachability row names it (service fence — Codex F4-HIGH)', () => {
    // The `cli.reachability.set` rpc does not verify cli-ness, so an owner could
    // author a row for a `service` (or any) slug. The cli-kind guard must drop it.
    const deps = doorDeps({
      cliReachableSlugsForPrincipal: granting('ct_door', [
        'indexer-service', // service — no reachability auth path
        'sneaky-service', // malformed service+cli hybrid — still not cli
        'allowed-http', // normal — not cli either
        'whisper-catalog', // the only genuine cli ingredient
      ]),
    });
    const { snapshot } = snapshotFor(deps);
    expect(snapshot.allowed_tools).not.toContain('indexer-service');
    expect(snapshot.allowed_tools).not.toContain('sneaky-service');
    expect(snapshot.allowed_tools).toContain('whisper-catalog');
  });

  it('only admits a grant keyed to THIS door principal (no cross-principal leak)', () => {
    const deps = doorDeps({
      // grant exists, but for a DIFFERENT contract — must not leak in
      cliReachableSlugsForPrincipal: granting('ct_other', ['whisper-catalog']),
    });
    const { snapshot } = snapshotFor(deps);
    expect(snapshot.allowed_tools).not.toContain('whisper-catalog');
  });

  it('drops a granted slug that is not in the loaded manifest registry', () => {
    const deps = doorDeps({
      cliReachableSlugsForPrincipal: granting('ct_door', ['ghost-cli-not-installed']),
    });
    const { snapshot } = snapshotFor(deps);
    expect(snapshot.allowed_tools).not.toContain('ghost-cli-not-installed');
    expect(snapshot.allowed_tools).toEqual(['allowed-http']);
  });

  it('an absent lister leaves the token-grant allowlist unchanged', () => {
    const { snapshot } = snapshotFor(doorDeps());
    expect(snapshot.allowed_tools).toEqual(['allowed-http']);
  });

  /** ⛔⛔ RENAMED AND FLIPPED BY DECISION — D-228 slice 1. This read "the unbound
   *  owner (no inboundTokenAuthorize) still admits every slug" and PASSED,
   *  because `buildMcpContractSnapshot` fell back to the full slug list when no
   *  authorizer was supplied. That fallback was the defect: proximity is not
   *  identity, and a local process that can reach a stdio server is not the
   *  owner. Slice 1 made the no-authorizer case yield `[]`.
   *
   *  ⚠⚠ THIS PINS THE SNAPSHOT ONLY, and must not be read as proof that the
   *  stdio surface is closed. `handleToolsList` and `handleToolCall` still treat
   *  an ABSENT authorizer as ungated — `handleToolCall`'s gate is
   *  `deps.inboundTokenAuthorize && !deps.inboundTokenAuthorize(name)`, which
   *  short-circuits when the callback is undefined. Slice 1 is INCOMPLETE at
   *  those two seams; see the fence comment in `mcp-server.ts`. */
  it('the unbound caller (no inboundTokenAuthorize) is admitted NOTHING', () => {
    const deps = doorDeps({
      boundContractId: undefined,
      boundContractActive: undefined,
      inboundTokenAuthorize: undefined,
      cliReachableSlugsForPrincipal: granting('ct_door', []),
    });
    const { snapshot } = snapshotFor(deps);
    expect(snapshot.allowed_tools).toEqual([]);
  });
});

describe('D-182 §8 — end-to-end policy gate (snapshot → gateRecipeAgainstPolicy)', () => {
  const cliRecipe: RecipeDefinition = {
    id: 'transcribe-and-store',
    name: 'Transcribe with a local binary',
    version: 1,
    steps: [{ id: 'transcribe', ingredient: 'whisper-catalog' }],
  } as unknown as RecipeDefinition;

  it('a door WITH the cli grant can run a recipe that uses the cli step', () => {
    const deps = doorDeps({
      cliReachableSlugsForPrincipal: granting('ct_door', ['whisper-catalog']),
    });
    const { source, snapshot } = snapshotFor(deps);
    const result = gateRecipeAgainstPolicy(
      cliRecipe,
      source,
      (slug) => deps.executorConfig.manifests.get(slug) ?? undefined,
      snapshot,
    );
    expect(result.admit).toBe(true);
    expect(result.denials).toEqual([]);
  });

  it('a door WITHOUT the cli grant is denied tool_not_in_contract on the cli step', () => {
    const deps = doorDeps({
      cliReachableSlugsForPrincipal: granting('ct_door', []),
    });
    const { source, snapshot } = snapshotFor(deps);
    const result = gateRecipeAgainstPolicy(
      cliRecipe,
      source,
      (slug) => deps.executorConfig.manifests.get(slug) ?? undefined,
      snapshot,
    );
    expect(result.admit).toBe(false);
    expect(result.denials).toHaveLength(1);
    expect(result.denials[0].ingredient).toBe('whisper-catalog');
    expect(result.denials[0].decision.code).toBe('tool_not_in_contract');
  });
});
