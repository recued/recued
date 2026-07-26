/** Contracts package tree-shaking must preserve every module-load invariant.
 *
 * `@recued/contracts` is source-consumed by several esbuild bundles. Declaring
 * the whole package side-effect-free lets an unused barrel export erase its
 * owning module's boot-time assertion. This test pins both halves of the
 * contract: a recursive inventory requires the manifest to list every source
 * module with a detected discarded module-load call or top-level throwing
 * guard, and a real side-effect-only barrel import retains those guards. */

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));

const EXPECTED_SIDE_EFFECTS = [
  './src/index.ts',
  './src/connection-requirements.ts',
  './src/connection-vendor-aliases.ts',
  './src/connection-vendor-providers.ts',
  './src/connection-vendors.ts',
  './src/contact-contribution.ts',
  './src/contact-sources.ts',
  './src/cut-models.ts',
  './src/file-vendors.ts',
  './src/kernel-op-registry.ts',
  './src/messenger-vendors.ts',
  './src/notifications.ts',
  './src/session-routing.ts',
  './src/webhook-owner-profile-settings.ts',
  './src/webhook-profiles.ts',
] as const;

const containsTopLevelThrow = (node: ts.Node): boolean => {
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
    return false;
  }
  let found = false;
  const visit = (current: ts.Node): void => {
    if (found) return;
    if (current !== node && ts.isFunctionLike(current)) return;
    if (ts.isThrowStatement(current)) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
};

const isReferencedOutsideDeclaration = (
  file: ts.SourceFile,
  declarationName: ts.Identifier,
): boolean => {
  let found = false;
  const visit = (current: ts.Node): void => {
    if (found || current === declarationName) return;
    if (
      ts.isIdentifier(current)
      && current.text === declarationName.text
    ) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(file);
  return found;
};

const throwingTopLevelCallees = (file: ts.SourceFile): ReadonlySet<string> => {
  const throwing = new Set<string>();
  const functionThrows = (node: ts.FunctionLikeDeclaration): boolean => {
    if (!node.body) return false;
    let found = false;
    const visit = (current: ts.Node): void => {
      if (found) return;
      if (current !== node.body && ts.isFunctionLike(current)) return;
      if (ts.isThrowStatement(current)) {
        found = true;
        return;
      }
      ts.forEachChild(current, visit);
    };
    visit(node.body);
    return found;
  };

  for (const statement of file.statements) {
    if (
      ts.isFunctionDeclaration(statement)
      && statement.name
      && functionThrows(statement)
    ) throwing.add(statement.name.text);
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name)
        && declaration.initializer
        && (
          ts.isArrowFunction(declaration.initializer)
          || ts.isFunctionExpression(declaration.initializer)
        )
        && functionThrows(declaration.initializer)
      ) throwing.add(declaration.name.text);
    }
  }
  return throwing;
};

// A discarded module-load call is conservatively side-effectful even when the
// callee's effect is not lexically present at the call site. Expression calls
// discard their result directly. `const result = validate()` has the same
// meaning when `result` is otherwise unused; ordinary exported/consumed value
// construction remains tree-shakeable.
const isTopLevelCall = (
  statement: ts.Statement,
  file: ts.SourceFile,
  throwingCallees: ReadonlySet<string>,
): boolean => {
  if (ts.isExpressionStatement(statement)) {
    return ts.isCallExpression(statement.expression);
  }
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.some((declaration) =>
      ts.isIdentifier(declaration.name)
      && declaration.initializer !== undefined
      && ts.isCallExpression(declaration.initializer)
      && (
        (
          ts.isIdentifier(declaration.initializer.expression)
          && throwingCallees.has(declaration.initializer.expression.text)
        )
        || (
          !statement.modifiers?.some((modifier) =>
            modifier.kind === ts.SyntaxKind.ExportKeyword)
          && !isReferencedOutsideDeclaration(file, declaration.name)
        )
      ));
  }
  return false;
};

const sourceHasModuleLoadEffect = (
  source: string,
  name = 'module-load-effect-fixture.ts',
): boolean => {
  const file = ts.createSourceFile(
    name,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const throwingCallees = throwingTopLevelCallees(file);
  return file.statements.some((statement) =>
    isTopLevelCall(statement, file, throwingCallees)
    || containsTopLevelThrow(statement));
};

const discoveredModuleLoadEffectModules = (
  root = sourceRoot,
): string[] =>
  readdirSync(root, { recursive: true, encoding: 'utf8' })
    .map((name) => name.replaceAll('\\', '/'))
    .filter((name) =>
      name.endsWith('.ts')
      && !name.split('/').includes('__tests__'))
    .filter((name) => {
      const source = readFileSync(join(root, name), 'utf8');
      return sourceHasModuleLoadEffect(source, name);
    })
    .map((name) => `./src/${name}`)
    .sort();

const BOOT_GUARD_SENTINELS = [
  'CONNECTION_REQUIREMENT_SEED shape validation failed',
  'CONNECTION_VENDOR_ENTITIES alias-prefix clash',
  'CONNECTION_VENDOR_PROVIDERS boot validation failed',
  'CONNECTION_VENDOR_ENTITIES boot validation failed',
  'CONTACT_CONTRIBUTION_SOURCE_PRIORITY is out of sync',
  'CONTACT_SOURCE_DECLARATIONS boot validation failed',
  'D-153 P6 cut-model registry size mismatch',
  'FILE_VENDOR_DECLARATIONS boot validation failed',
  'kernel-op-registry: duplicate op id',
  'MESSENGER_VENDOR_DECLARATIONS boot validation failed',
  'CHANNEL_ROLES boot validation failed',
  'D-153 P7 registry size mismatch',
  'Duplicate webhook owner settings',
  'Invalid D-201 webhook profile registry',
] as const;

describe('@recued/contracts package side effects', () => {
  it('detects expression and discarded-initializer module-load calls', () => {
    expect(sourceHasModuleLoadEffect('assertRegistry();')).toBe(true);
    expect(sourceHasModuleLoadEffect('Object.freeze(REGISTRY);')).toBe(true);
    expect(
      sourceHasModuleLoadEffect('(() => initializeRegistry())();'),
    ).toBe(true);
    expect(sourceHasModuleLoadEffect(
      'const checked = validateRegistry();',
    )).toBe(true);
    expect(sourceHasModuleLoadEffect(
      'const frozen = Object.freeze(REGISTRY);',
    )).toBe(true);
    expect(sourceHasModuleLoadEffect(
      'export const frozen = Object.freeze(REGISTRY);',
    )).toBe(false);
    expect(sourceHasModuleLoadEffect(
      'const frozen = Object.freeze(REGISTRY); export { frozen };',
    )).toBe(false);
    expect(sourceHasModuleLoadEffect(
      'function validate() { throw new Error("bad"); } '
      + 'export const checked = validate();',
    )).toBe(true);
    expect(sourceHasModuleLoadEffect(
      'const validate = () => { throw new Error("bad"); }; '
      + 'export const checked = validate();',
    )).toBe(true);

    // A call inside an exported function is deferred until the consumer invokes
    // it; it is not a module-load effect and must not expand the allowlist.
    expect(sourceHasModuleLoadEffect(
      'export const freezeLater = () => Object.freeze(REGISTRY);',
    )).toBe(false);
  });

  it('discovers module-load effects recursively', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'contracts-effects-'));
    try {
      mkdirSync(join(fixtureRoot, 'nested'), { recursive: true });
      writeFileSync(
        join(fixtureRoot, 'nested', 'guard.ts'),
        'assertNestedRegistry();',
      );
      expect(discoveredModuleLoadEffectModules(fixtureRoot)).toEqual([
        './src/nested/guard.ts',
      ]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('allowlists every module with a detected module-load effect', () => {
    const packageJson = JSON.parse(
      readFileSync(`${packageRoot}package.json`, 'utf8'),
    ) as { sideEffects?: unknown };

    expect(discoveredModuleLoadEffectModules()).toEqual(
      EXPECTED_SIDE_EFFECTS.filter((path) => path !== './src/index.ts'),
    );
    expect(packageJson.sideEffects).toEqual(EXPECTED_SIDE_EFFECTS);
  });

  it('retains every declared effect module and boot guard through a barrel import', async () => {
    const result = await build({
      stdin: {
        contents: "import '@recued/contracts'; export const marker = 1;",
        resolveDir: repoRoot,
        sourcefile: 'contracts-side-effects-probe.ts',
        loader: 'ts',
      },
      bundle: true,
      write: false,
      platform: 'neutral',
      format: 'esm',
      treeShaking: true,
      tsconfig: `${repoRoot}tsconfig.base.json`,
      logLevel: 'silent',
      metafile: true,
    });
    const source = result.outputFiles?.[0]?.text ?? '';
    const emittedBytesByInput = new Map<string, number>();
    for (const output of Object.values(result.metafile?.outputs ?? {})) {
      for (const [input, details] of Object.entries(output.inputs)) {
        emittedBytesByInput.set(
          input,
          (emittedBytesByInput.get(input) ?? 0) + details.bytesInOutput,
        );
      }
    }

    for (const effectPath of EXPECTED_SIDE_EFFECTS) {
      if (effectPath === './src/index.ts') continue;
      const input = `packages/contracts/${effectPath.slice(2)}`;
      expect(
        emittedBytesByInput.get(input) ?? 0,
        `tree-shook declared module-load effect: ${effectPath}`,
      ).toBeGreaterThan(0);
    }

    for (const sentinel of BOOT_GUARD_SENTINELS) {
      expect(source, `missing bundled boot guard: ${sentinel}`).toContain(sentinel);
    }
  });
});
