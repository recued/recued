/** Every dep `composeListeners` hands to `createServerHandlerSet` is a `ServerConfig`
 *  member, and `server.ts` reads every member.
 *
 *  ⛔ A KEY INSIDE A CONDITIONAL SPREAD ESCAPES TSC. `composeListeners` builds the
 *  config as `...(store ? { someDeps } : {})`, and an object spread skips the
 *  excess-property check, so a key `ServerConfig` does not declare compiles and is
 *  dropped. `receptionRecordDeps`, `receptionManageMintDeps` and
 *  `receptionLookupRevokeDeps` went that way from the day each was written:
 *  26.10.21 answered all three `not_configured`, so Reception → Records said "not
 *  wired up" on every server. Undeclared, the mint deps were never type-checked
 *  either, and still carried a walk the handler had dropped in July. Each
 *  handler's own test stayed green, because each builds its slice directly.
 *
 *  `archive-rpc-wiring.test.ts` checks named methods over the wire; this checks the
 *  whole hand-off by reading both files with the TypeScript parser, so a new dep
 *  cannot be added on one side only. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const parse = (rel: string): ts.SourceFile => {
  const file = resolve(import.meta.dirname, rel);
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
};

const find = (root: ts.Node, match: (n: ts.Node) => boolean): ts.Node[] => {
  const out: ts.Node[] = [];
  const visit = (n: ts.Node): void => {
    if (match(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(root);
  return out;
};

/** Keys of an object literal, including those inside spreads of conditionals and `&&`. */
const literalKeys = (node: ts.Expression | undefined, out = new Set<string>()): Set<string> => {
  if (node === undefined) return out;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return literalKeys(node.expression, out);
  }
  if (ts.isConditionalExpression(node)) {
    literalKeys(node.whenTrue, out);
    literalKeys(node.whenFalse, out);
  } else if (ts.isBinaryExpression(node)) {
    literalKeys(node.right, out);
  } else if (ts.isObjectLiteralExpression(node)) {
    for (const p of node.properties) {
      if (ts.isSpreadAssignment(p)) literalKeys(p.expression, out);
      else if (p.name !== undefined) out.add(p.name.getText());
    }
  }
  return out;
};

const listeners = parse('../serve/compose-listeners.ts');
const server = parse('../server.ts');

const calls = find(listeners, (n) => ts.isCallExpression(n)
  && n.expression.getText() === 'createServerHandlerSet') as ts.CallExpression[];
const passed = literalKeys(calls[0]?.arguments[0]);

const config = find(server, (n) => ts.isInterfaceDeclaration(n)
  && n.name.text === 'ServerConfig') as ts.InterfaceDeclaration[];
const declared = new Set(config[0]?.members.flatMap((m) => (m.name ? [m.name.getText()] : [])) ?? []);

const read = new Set(find(server, (n) => ts.isPropertyAccessExpression(n)
  && n.expression.getText() === 'config').map((n) => (n as ts.PropertyAccessExpression).name.text));

describe('composeListeners → ServerConfig → the ws-server', () => {
  it('finds the hand-off it checks — one call, one interface, keys from inside spreads', () => {
    expect(calls).toHaveLength(1);
    expect(config).toHaveLength(1);
    expect(config[0]!.heritageClauses).toBeUndefined();
    // Spread-only keys prove the walk reaches inside `...(cond ? { … } : {})`.
    for (const key of ['receptionInboxDeps', 'receptionRecordDeps', 'archiveDeps']) {
      expect(passed.has(key), `${key} was not found in the composed config`).toBe(true);
    }
    expect(passed.size).toBeGreaterThan(100);
  });

  it('⛔ every key composeListeners passes is declared in ServerConfig — an undeclared one is dropped', () => {
    expect([...passed].filter((k) => !declared.has(k))).toEqual([]);
  });

  it('⛔ server.ts reads every ServerConfig member — a declared one it never forwards is dead too', () => {
    expect([...declared].filter((k) => !read.has(k))).toEqual([]);
  });
});
