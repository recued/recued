import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A source file's string literals, with their lines: what a model can be
 *  handed, as opposed to the comments only a maintainer reads. */
const literals = (file: string): Array<{ line: number; text: string }> => {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const found: Array<{ line: number; text: string }> = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
    ) {
      found.push({ line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

// "Mary" is the code's name for the owner, and these tool results used it: a
// door's agent read "Write paused — Mary must approve the plan". The data and
// the approvals are the owner's; the person the agent is talking to is the user
// (internal design notes, 2026-10-22). Comments keep the persona.
describe.each(['mcp-internal-tools.ts', 'chat-tool-handlers.ts'])('%s: tool results name no one', (name) => {
  const all = literals(join(SRC, name));

  it('has string literals to check', () => {
    expect(all.length).toBeGreaterThan(10);
  });

  it('never names Mary', () => {
    expect(all.filter(({ text }) => /\bMary\b/.test(text)).map(({ line }) => line)).toEqual([]);
  });

  it('never says she or her', () => {
    expect(all.filter(({ text }) => /\b(she|her|hers|herself)\b/i.test(text)).map(({ line }) => line)).toEqual([]);
  });
});
