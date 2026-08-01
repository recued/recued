/** ⛔⛔ EVERY TABLE KEYED ON `RecordsAction` MUST NAME EVERY ACTION.
 *
 *  Adding `aggregate` to the vocabulary once shipped an op that could not be
 *  authored: one typed table compile-errored and three `Record<string, …>` ones
 *  said nothing and failed OPEN, because an absent entry reads as `undefined`
 *  and `undefined` is permissive everywhere it lands.
 *
 *  ⚠ The type cannot see an entry that EXISTS but is EMPTY, which is the other
 *  half of the same failure — so this walks the union at runtime and checks the
 *  VALUES, not just the keys. Adding an action to `RECORDS_ACTIONS` without
 *  filling in what it means is a red here. */
import { describe, expect, it } from 'vitest';
import { RECORDS_ACTIONS, RECORDS_BATCH_ACTIONS } from '@recued/contracts';
import type { CompositionIngredient } from '../schema.js';
import { validateComposition } from '../index.js';
import { RECORDS_BIND_KEYS } from '../records.js';

describe('the action vocabulary is fully covered', () => {
  it('finds the actions at all', () => {
    // Guards the probe: an empty union would make every loop below vacuous.
    expect(RECORDS_ACTIONS.length).toBeGreaterThan(8);
  });

  it('⛔ every action has bind keys, and they are never empty', () => {
    for (const action of RECORDS_ACTIONS) {
      const keys = RECORDS_BIND_KEYS[action];
      expect(keys, `no bind keys declared for '${action}'`).toBeDefined();
      expect([...keys], `bind keys for '${action}' are empty`).not.toEqual([]);
      // Every bind carries its own identity; a table that forgot them would
      // admit a bind that names no entity at all.
      for (const required of ['kind', 'action', 'entity']) {
        expect(keys.has(required), `'${action}' bind keys omit '${required}'`).toBe(true);
      }
    }
  });

  it('⛔ every batchable action is a real action, and none is a read', () => {
    for (const action of RECORDS_BATCH_ACTIONS) {
      expect(RECORDS_ACTIONS as readonly string[]).toContain(action);
    }
    expect(RECORDS_BATCH_ACTIONS as readonly string[]).not.toContain('batch');
    for (const read of ['get', 'get_many', 'search', 'count', 'aggregate']) {
      expect(RECORDS_BATCH_ACTIONS as readonly string[]).not.toContain(read);
    }
  });
});

// ── the batch's risk floor ───────────────────────────────────────────────────
/** ⛔⛔ A BATCH'S AUTHORITY IS THE UNION OF WHAT IT MAY DO.
 *
 *  `RISK_FLOOR` is a constant per action, and a batch is the one action whose
 *  floor is not constant — it depends on the allow-list. A survived mutant
 *  found this uncovered: dropping the computed floor and falling back to the
 *  table let a batch that may DELETE ship as `write`, which is a destructive op
 *  wearing a tier that skips the approval a delete earns. */
describe('a batch is as risky as the strictest thing it may do', () => {
  const composition = (allow: unknown, risk: string): CompositionIngredient => ({
    schema_version: 1,
    slug: 'probe',
    ingredients: [{
      slug: 'probe-records',
      kind: 'storage',
      entities: {
        thing: {
          fields: [
            { maps_to: 'id', field_path: 'pk', type: 'string', source_operation: 'thing.get' },
            { maps_to: 'name', field_path: 's1', type: 'string', source_operation: 'thing.get' },
          ],
        },
      },
    }],
    operations: [{
      op: 'thing.get', ingredient: 'probe-records', risk: 'read', approval: 'never',
      args: [{ key: 'id', type: 'string', required: true, affects_target: true }],
      bind: { kind: 'core.records', action: 'get', entity: 'thing' },
    }, {
      op: 'thing.post', ingredient: 'probe-records', risk, approval: 'never',
      args: [{ key: 'ops', type: 'array', required: true }],
      bind: { kind: 'core.records', action: 'batch', entity: 'thing', allow },
    }],
  } as unknown as CompositionIngredient);

  const codes = (allow: unknown, risk: string) =>
    validateComposition(composition(allow, risk)).issues
      .filter(i => i.severity === 'error').map(i => i.code);

  it('⛔ a batch that may DELETE cannot ship as a write', () => {
    expect(codes([{ entity: 'thing', action: 'delete' }], 'write'))
      .toContain('records_risk_floor');
  });

  it('⛔ the floor is the MAX, not the first or the last pair', () => {
    // Both orders, so a floor computed from `allow[0]` fails one of them.
    expect(codes([{ entity: 'thing', action: 'create' },
                  { entity: 'thing', action: 'delete' }], 'write'))
      .toContain('records_risk_floor');
    expect(codes([{ entity: 'thing', action: 'delete' },
                  { entity: 'thing', action: 'create' }], 'write'))
      .toContain('records_risk_floor');
  });

  it('⛔ the guard PERMITS what it should — the case that separates it from a ban', () => {
    expect(codes([{ entity: 'thing', action: 'delete' }], 'destructive')).toEqual([]);
    expect(codes([{ entity: 'thing', action: 'create' },
                  { entity: 'thing', action: 'update' }], 'write')).toEqual([]);
  });

  it('⚠ a write-only batch is NOT forced to destructive', () => {
    // The over-correction: taking the max of the whole ACTION table rather than
    // of this batch's own pairs would make every batch destructive, and a tier
    // that is always the strictest tells a person nothing.
    expect(codes([{ entity: 'thing', action: 'create' }], 'write')).toEqual([]);
  });

  it('refuses an allow-list on a non-batch action', () => {
    const value = composition([{ entity: 'thing', action: 'create' }], 'write');
    (value.operations[1]!.bind as Record<string, unknown>).action = 'create';
    (value.operations[1]!).args = [{ key: 'values', type: 'object', required: true }];
    expect(validateComposition(value).issues.map(i => i.code))
      .toContain('records_batch_allow');
  });
});
