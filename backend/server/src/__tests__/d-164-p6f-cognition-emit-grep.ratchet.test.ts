/** D-164 P6f — cognition deletion source grep ratchets. */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

// D-164 P6.5 deleted `packages/middleware-recued/src/two-stage/orchestrator.ts`
// outright, so the cognition-emit ratchet over that file is now vacuous
// (its absence is enforced by the P6.5 deletion ratchet). chat-orchestrator.ts
// is the only surviving emit site this ratchet covers.
const emitSites = [
  [
    'backend/server/src/chat-orchestrator.ts',
    path.resolve(__dirname, '..', 'chat-orchestrator.ts'),
  ],
] as const;

const readSource = (absolutePath: string): string =>
  readFileSync(absolutePath, 'utf8');

describe('D-164 P6f — emit sites do not restore cognition count fields', () => {
  // mutate: restore cognition_selected to either emit site → this assertion fails.
  for (const [sourceName, absolutePath] of emitSites) {
    it(`${sourceName} does not contain cognition_selected emit field`, () => {
      expect(readSource(absolutePath)).not.toMatch(/cognition_selected:/);
    });

    it(`${sourceName} does not contain cognition_dropped emit field`, () => {
      expect(readSource(absolutePath)).not.toMatch(/cognition_dropped:/);
    });
  }
});

describe('D-164 P6f — chat orchestrator comment hygiene', () => {
  it('backend/server/src/chat-orchestrator.ts does not mention cognition', () => {
    // mutate: add a cognition doc comment in chat-orchestrator.ts → this assertion fails.
    const source = readSource(path.resolve(__dirname, '..', 'chat-orchestrator.ts'));
    expect(source).not.toContain('cognition');
  });
});
