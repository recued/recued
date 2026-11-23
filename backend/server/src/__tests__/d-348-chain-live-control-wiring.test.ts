/** D-348 — Live control's list of the owner's rules stays current: the composer that owns the bus
 *  fans each change the rule store tells of (`ChainRuleStore.onChange`, pinned by
 *  `d-348-chain-rule-store.test.ts`) as `contract.chain_rule_changed`.
 *
 *  ⛔ A store's notice that nobody wires is a feature that does nothing, and every unit test passes
 *  over it (D-289 shipped exactly so). The composer's own test drives the fan-out; this one reads
 *  the composers' source for the store they hand on, since one store must do both. */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { stripSourceComments } from './helpers/source-guards.js';

const read = (rel: string): string => stripSourceComments(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', rel), 'utf-8'),
);

// That compose-listeners fans each change onto the bus is driven in `serve-compose-listeners.test.ts`
// ("D-348 — fans each change …"); this file pins that the store it listens to is the one in use.
describe('D-348 — the store whose changes are fanned', () => {
  it('is the store the server composes, and the one its gates and rpc spend and end', () => {
    expect(read('serve/compose-storage-context.ts')).toMatch(/const chainRuleStore = createChainRuleStore\(/);
    expect(read('serve/compose-execution-context.ts')).toMatch(/chainRules: storage\.chainRuleStore,/);
    expect(read('serve/compose-listeners.ts')).toMatch(/chainRules: storage\.chainRuleStore,/);
  });
});
