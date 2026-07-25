/** D-164 P6f — transparency-stream cognition deletion grep ratchet. */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const sourceFiles = [
  ['events.ts', '../transparency-stream/events.ts'],
  ['templates.ts', '../transparency-stream/templates.ts'],
  ['redaction.ts', '../transparency-stream/redaction.ts'],
  ['settings.ts', '../transparency-stream/settings.ts'],
  ['audit.ts', '../transparency-stream/audit.ts'],
  ['transparency-stream/index.ts', '../transparency-stream/index.ts'],
  ['index.ts', '../index.ts'],
] as const;

const deletedSymbols = [
  'cognition.item_committed',
  'cognition.item_dropped',
  'cognition.reopen_reconciled',
  'TRANSPARENCY_COGNITION_DROP_TRIGGERS',
  'TransparencyCognitionDropTrigger',
  'TRANSPARENCY_REOPEN_PATHS',
  'TransparencyReopenPath',
  'cognition_selected',
  'cognition_dropped',
] as const;

const escapeRegex = (literal: string): string =>
  literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const readSource = (relativePath: string): string =>
  readFileSync(path.resolve(__dirname, relativePath), 'utf8');

describe('D-164 P6f — transparency-stream deleted cognition symbols stay deleted', () => {
  // mutate: reintroduce any deleted symbol in events.ts → at least one assertion fails
  for (const [sourceName, relativePath] of sourceFiles) {
    for (const symbol of deletedSymbols) {
      it(`${sourceName} does not contain ${symbol}`, () => {
        expect(readSource(relativePath)).not.toMatch(
          new RegExp(escapeRegex(symbol)),
        );
      });
    }
  }
});
