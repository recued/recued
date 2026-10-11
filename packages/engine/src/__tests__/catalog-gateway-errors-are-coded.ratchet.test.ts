/** Every error the catalog gateway constructs reaches a step with a code, or is
 *  one of the plain throws listed below, and that list only shrinks (D-313 § 8).
 *
 *  The step runner keeps a thrown error's `code` when it is a `RecipeErrorCode`
 *  (`adapterErrorCode`). A plain `Error` becomes its catch-all `NETWORK_ERROR`,
 *  "check your connection and try again": an agent retries, an automation
 *  retries until the breaker, a peer reads the server as unavailable. Until
 *  2026-10-09 the gateway's refusals were plain, so a switched-off action was
 *  all three, and its message printed `on connection 'undefined'`.
 *
 *  This reads every `new …Error(` in `catalog-gateway.ts`, messages written
 *  across lines and joined with `+` included, and fails on one that is neither
 *  coded nor listed, naming the line and the message. Code it with
 *  `codedError(message, code)`. A listed message thrown a different number of
 *  times fails too, so coding one of them means taking it off the list.
 *
 *  ⚠ Only errors constructed in this file are read. One thrown by a module the
 *  gateway calls is that module's to code. */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const GATEWAY = join(dirname(fileURLToPath(import.meta.url)), '..', 'catalog-gateway.ts');

/** The plain throws left on 2026-10-09, by message (`…` for an interpolation),
 *  with how many times each is thrown. None is a refusal: each is a server
 *  that was built without a part, a state the code calls unreachable, or a
 *  step or pack giving input it cannot use. Code one, then take it off. */
const PLAIN_THROWS_LEFT: ReadonlyArray<{ readonly message: string; readonly count: number }> = [
  // Host not wired: a dependency this server never composed.
  { message: "D-165 gateway: operation '…' declares a chunked upload but no upload-source reader is wired on this host.", count: 2 },
  { message: "D-165 gateway: operation '…' on connection '…' has a cli_invocation binding but no CLI executor is wired (no_cli_executor).", count: 1 },
  { message: "D-232 local recipe operation '…' has no localRecipeInvoker.", count: 1 },
  { message: "D-221 Records operation '…' has no local executor (no_records_executor).", count: 1 },
  { message: "D-201 operation-bound webhook '…' has no trusted resolver.", count: 1 },
  // Unreachable, by the code's own account.
  { message: "D-165 gateway: operation '…' had no API dispatch input after CLI dispatch narrowing.", count: 1 },
  { message: "D-165 gateway: operation '…' has a dispatch input but no protocol executor (unreachable).", count: 1 },
  { message: 'D-201 operation-bound webhook resolver returned an invalid dispatch', count: 1 },
  { message: "D-221 Records operation '…' has no derived execution principal.", count: 1 },
  // Input a step or pack gave that this operation cannot use.
  { message: "D-165 gateway: operation '…' declares a chunked upload but arg '…' carries no file_ref.", count: 2 },
  { message: "D-165 gateway: operation '…' cannot read file '…' for a chunked upload.", count: 2 },
  { message: "D-201 operation-bound webhook '…' cannot be read-tier.", count: 1 },
  { message: "D-201 operation-bound webhook '…' cannot cache provider dispatch.", count: 1 },
  { message: "D-201 operation-bound webhook '…' requires a REST catalog binding.", count: 1 },
  // An operation-bound webhook without the provenance it must carry.
  { message: "D-201 operation-bound webhook '…' requires trusted step metadata.", count: 1 },
  { message: "D-201 operation-bound webhook '…' requires stored consumer provenance.", count: 1 },
  // A Records search whose next page added no row.
  { message: 'records search stopped after … pages with … rows: a page added no new row', count: 1 },
];

/** The plain throws on 2026-10-09. The list may shrink; raising this needs a reason in D-313. */
const CEILING = 20;

/** The top-level arguments of the call whose `(` ends at `start`, template
 *  interpolations kept whole. */
const argumentsAt = (text: string, start: number): string[] => {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (let i = start; i < text.length; i += 1) {
    const c = text[i]!;
    if (quote !== null) {
      current += c;
      if (c === '\\') { current += text[i + 1] ?? ''; i += 1; continue; }
      if (quote === '`' && c === '$' && text[i + 1] === '{') {
        let nested = 0;
        for (i += 1; i < text.length; i += 1) {
          const d = text[i]!;
          current += d;
          if (d === '{') nested += 1;
          if (d === '}') { nested -= 1; if (nested === 0) break; }
        }
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') { quote = c; current += c; continue; }
    if (c === '(' || c === '[' || c === '{') { depth += 1; current += c; continue; }
    if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) { out.push(current.trim()); return out; }
      depth -= 1; current += c; continue;
    }
    if (c === ',' && depth === 0) { out.push(current.trim()); current = ''; continue; }
    current += c;
  }
  return out;
};

/** A message argument as it reads: string pieces joined with `+` become one
 *  text, each interpolation `…`. Anything else (a variable) reads `<name>`. */
const messageOf = (argument: string): string => {
  const pieces = argument.split(/\s*\+\s*(?=['"`])/u);
  const literal = /^(['"`])([\s\S]*)\1$/u;
  if (!pieces.every((p) => literal.test(p.trim()))) return `<${argument}>`;
  return pieces
    .map((p) => literal.exec(p.trim())![2]!.replace(/\$\{[^}]*\}/gu, '…'))
    .join('');
};

interface Construction {
  readonly line: number;
  readonly message: string;
  readonly coded: boolean;
}

const source = readFileSync(GATEWAY, 'utf8');

const constructions: Construction[] = [...source.matchAll(/new ([A-Za-z]*Error)\(/gu)].map((match) => {
  const at = match.index!;
  const argument = argumentsAt(source, at + match[0].length)[0] ?? '';
  // Coded: the error is the first argument of `Object.assign(`, whose second
  // argument gives it a `code`. That is `codedError`, and the adapter's own
  // failure (D-232 § 21), coded when the protocol classified it.
  const assign = /Object\.assign\(\s*$/u.test(source.slice(Math.max(0, at - 40), at));
  const assigned = assign ? argumentsAt(source, source.lastIndexOf('Object.assign(', at) + 'Object.assign('.length) : [];
  return {
    line: source.slice(0, at).split('\n').length,
    message: messageOf(argument),
    coded: assign && /\bcode\b/u.test(assigned[1] ?? ''),
  };
});

const plain = constructions.filter((c) => !c.coded);

describe('every error the catalog gateway constructs reaches a step with a code', () => {
  it('⛔ no plain error the list does not name: code it with codedError(message, code)', () => {
    const listed = new Set(PLAIN_THROWS_LEFT.map((entry) => entry.message));
    expect(plain.filter((c) => !listed.has(c.message)).map((c) => `catalog-gateway.ts:${String(c.line)} ${c.message}`))
      .toEqual([]);
  });

  it('each listed message is thrown as often as the list says, so a coded one comes off it', () => {
    const counted = new Map<string, number>();
    for (const c of plain) counted.set(c.message, (counted.get(c.message) ?? 0) + 1);
    expect(PLAIN_THROWS_LEFT.filter((entry) => counted.get(entry.message) !== entry.count).map((entry) =>
      `${entry.message}: listed ${String(entry.count)}, thrown ${String(counted.get(entry.message) ?? 0)}`))
      .toEqual([]);
  });

  it('the list only shrinks', () => {
    expect(PLAIN_THROWS_LEFT.reduce((sum, entry) => sum + entry.count, 0)).toBeLessThanOrEqual(CEILING);
  });

  it('the scan reads messages written across lines, and tells a coded construction from a plain one', () => {
    // A scan that found nothing fails the count test above (each listed message
    // must be found as often as listed); this pins how the scan READS.
    // Two lines joined with `+`, read as one message.
    expect(plain.some((c) => c.message
      === "D-165 gateway: operation '…' declares a chunked upload but arg '…' carries no file_ref.")).toBe(true);
    // `codedError` itself, and the adapter's failure (D-232 § 21), read as coded.
    expect(constructions.filter((c) => c.coded).map((c) => c.message))
      .toEqual(expect.arrayContaining(['<message>', '<adapted.message>']));
  });
});
