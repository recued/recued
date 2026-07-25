/** D-159 N.3 / I-7 -- the engine barrel exposes only the core surface.
 *
 *  A barrel re-exporting moved Part-B symbols re-creates the
 *  engine->middleware coupling (TR-3). Pin `packages/engine/src/index.ts`
 *  to the N.3 keep-list and assert the runtime value surface stays narrow.
 *
 *  Spec: D-159 section N.3 + I-7 + A.3. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import * as barrel from '@recued/engine';

const SRC = resolve(__dirname, '..'); // packages/engine/src
const PKGS = resolve(SRC, '..', '..'); // packages/
const INDEX = resolve(SRC, 'index.ts');
const MW = join(PKGS, 'middleware') + '/';
const MWR = join(PKGS, 'middleware-recued') + '/';

const REEXPORT = /\bexport\s+(?:type\s+)?(?:\*\s+as\s+\w+|\*|\{[\s\S]*?\})\s+from\s+['"]([^'"]+)['"]/g;
const MIDDLEWARE_ALIAS = /^@recued\/middleware(?:-recued)?(?:\/|$)/;

const KEEP_MODULES = new Set([
  'condition',
  'context-recipe',
  'context',
  'dry-run',
  'execute',
  'prefetch',
  'preflight',
  'run-mode',
  'shared-prefetch',
  'step-runner',
  'step-seed',
  'store-safety',
  'types',
  'adapters/registry',
  // Poll-manager / G6 — the watch poll invokes catalog operations
  // directly (one gated + audited `<entity>.search` per tick) with a
  // scoped ExecutionContext; the gateway is engine-core (D-165
  // enforcement boundary), not a moved Part-B middleware module, so
  // re-exporting it does not re-create the engine→middleware coupling
  // this ratchet guards.
  'catalog-gateway',
]);

const EXPECTED_RUNTIME_EXPORTS = [
  'executeRecipe',
  'evaluateCondition',
  'createTransformContext',
  'createDryRunExecutor',
  'generateMockData',
  'preflight',
  'findMissingVariables',
  'findMissingVaultEntries',
  'findRoleRestrictions',
  'collectIngredientSlugs',
  'analyzeStep',
  'analyzeSteps',
  'computeStepCacheKey',
  'canonicalStepSpec',
  'prefetchSharedRefs',
  // D-177 N.11 rule 1 — the prefetch's annotation/link ref grammar,
  // exported so the server's stored-row origin resolver parses the SAME
  // grammar the prefetch resolves (one grammar, never re-implemented).
  'parseAnnotationLinkRef',
  'snapshotContextRecipe',
  'injectContextRecipe',
  'deriveRunMode',
  'KNOWN_TRIGGER_SOURCES',
  'createAdapterRegistry',
  'connectionPlaceholder',
  // D-157 Part C — held-action idempotency resolves a recipe's variable
  // defaults the engine's way (the dedup identity's `config_snapshot` must
  // match the audit anchor's) via this canonical extractor.
  'extractVariableDefault',
  // D-157 server-wiring — prototype-safe namespace writers exposed so
  // the host's `ExecuteRequest.resume_from` seeder shares the engine
  // step-runner's `__proto__`/`constructor`/`prototype` reject list.
  'assignOwnSafe',
  'setNamespaceValue',
  'isPrototypeSensitiveKey',
  // Poll-manager / G6 — see the catalog-gateway keep-list note above.
  'runCatalogOperation',
].sort();

const reexportSpecifiers = (txt: string): string[] =>
  [...txt.matchAll(REEXPORT)].map((m) => m[1]);

const sourceModuleFor = (specifier: string, fileDir: string): string => {
  const withoutJs = specifier.replace(/\.js$/, '');
  if (!specifier.startsWith('.')) return withoutJs;
  return relative(SRC, resolve(fileDir, withoutJs)).replace(/\\/g, '/');
};

const isMiddlewareRelativeEscape = (specifier: string, fileDir: string): boolean => {
  if (!specifier.startsWith('.')) return false;
  const resolved = resolve(fileDir, specifier.replace(/\.js$/, ''));
  return resolved.startsWith(MW) || resolved.startsWith(MWR);
};

const barrelReexportViolations = (txt: string, fileDir: string): string[] => {
  const violations: string[] = [];
  for (const specifier of reexportSpecifiers(txt)) {
    if (MIDDLEWARE_ALIAS.test(specifier)) {
      violations.push(`middleware alias: ${specifier}`);
    } else if (isMiddlewareRelativeEscape(specifier, fileDir)) {
      violations.push(`middleware relative escape: ${specifier}`);
    }
    if (sourceModuleFor(specifier, fileDir) === 'step-cache') {
      violations.push(`deleted step-cache re-export: ${specifier}`);
    }
  }
  return violations;
};

describe('D-159 N.3 / I-7 -- engine barrel surface', () => {
  const indexText = readFileSync(INDEX, 'utf8');
  const indexDir = dirname(INDEX);
  const reexports = reexportSpecifiers(indexText);

  it('relative re-exports are a subset of the N.3 keep-list', () => {
    const relativeReexports = reexports.filter((s) => s.startsWith('.'));
    expect(relativeReexports.length).toBeGreaterThan(0);

    const offenders = relativeReexports
      .map((specifier) => ({ specifier, module: sourceModuleFor(specifier, indexDir) }))
      .filter((entry) => !KEEP_MODULES.has(entry.module))
      .map((entry) => `${entry.specifier} -> ${entry.module}`);

    expect(offenders).toEqual([]);
  });

  it('does not re-export middleware* or deleted step-cache', () => {
    expect(barrelReexportViolations(indexText, indexDir)).toEqual([]);
  });

  it('runtime value exports stay pinned to the D-159 core surface', () => {
    expect(Object.keys(barrel).sort()).toEqual(EXPECTED_RUNTIME_EXPORTS);
  });

  it('synthetic regression -- the scanner catches a middleware alias re-export', () => {
    expect(
      barrelReexportViolations("export { x } from '@recued/middleware';", indexDir),
    ).toEqual(['middleware alias: @recued/middleware']);
  });
});
