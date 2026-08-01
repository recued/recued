/** Every Records action must be classified by EVERY authoring table.
 *
 *  ⛔⛔ THIS IS WHY. `aggregate` was added to `RECORDS_ACTIONS` and three tables
 *  keyed on it were typed `Record<string, …>`, so the compiler asked nothing:
 *    - `RECORDS_BIND_KEYS` — no bind-key allowlist ⇒ any bind key admitted
 *    - `RISK_FLOOR`        — no floor ⇒ `RISK_RANK[risk] < RISK_RANK[undefined]`
 *                            is always false ⇒ ANY declared risk accepted
 *    - `ACTION_ARGS`       — empty envelope ⇒ every declared arg is
 *                            `records_arg_extra`, so the action could not be
 *                            AUTHORED AT ALL
 *  Meanwhile `RECORDS_ACTION_EFFECT` in the webclient IS
 *  `Record<RecordsAction, …>` and failed to compile the moment the action
 *  landed. Two maps over one closed vocabulary; only the typed one asked.
 *
 *  The tables are now typed exhaustively, so this file is a belt to that
 *  braces: it fails on an entry that exists but is EMPTY, which the type
 *  cannot see. */
import { describe, expect, it } from 'vitest';
import { RECORDS_ACTIONS, type RecordsAction } from '@recued/contracts';
import { validateComposition } from '../validators.js';

/** A minimal Records composition carrying one operation for `action`. */
const compositionFor = (action: RecordsAction, risk: string, args: unknown[], bind: object) => ({
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
          { maps_to: 'size', field_path: 'n1', type: 'number', source_operation: 'thing.get' },
        ],
      },
    },
  }],
  operations: [{
    op: `thing.${action}`, ingredient: 'probe-records', risk, approval: 'never',
    args, bind: { kind: 'core.records', action, entity: 'thing', ...bind },
  }],
});

const errorsFor = (body: unknown) =>
  validateComposition(body).issues.filter(i => i.severity === 'error').map(i => i.code);

describe('every Records action is classified by every authoring table', () => {
  it.each(RECORDS_ACTIONS)('%s has a bind-key allowlist that actually constrains', action => {
    // An action with no allowlist admits every key. Probe with a key no action
    // should ever admit; it must be refused.
    const codes = errorsFor(compositionFor(action, 'destructive', [], { not_a_real_bind_key: true }));
    expect(codes, `${action} admitted an unknown bind key`).toContain('records_bind_key_unknown');
  });

  it.each(RECORDS_ACTIONS)('%s has a risk floor that refuses an under-declared risk', action => {
    // `read` is the lowest tier, so an action whose floor IS read cannot be
    // under-declared — that is a legitimately unreachable case, not a gap, and
    // the exhaustive type is what guarantees a floor exists at all.
    const codes = errorsFor(compositionFor(action, 'read', [], {}));
    const readFloored = ['get', 'get_many', 'search', 'count', 'aggregate'];
    if (readFloored.includes(action)) {
      expect(codes, `${action} should not trip the risk floor at 'read'`).not.toContain('records_risk_floor');
    } else {
      expect(codes, `${action} accepted risk 'read'`).toContain('records_risk_floor');
    }
  });

  it.each(RECORDS_ACTIONS)('%s has an arg envelope, so a bogus arg is refused', action => {
    const codes = errorsFor(compositionFor(action, 'destructive',
      [{ key: 'definitely_not_an_arg', type: 'string' }], {}));
    expect(codes, `${action} admitted an arg no action declares`).toContain('records_arg_extra');
  });

  it('⛔ an action with an EMPTY arg envelope cannot be authored — the type cannot see this', () => {
    // The failure `aggregate` actually had: an entry existed conceptually but
    // was empty, so every arg a caller needs is `records_arg_extra`. Only
    // `get`/`get_many` legitimately take a single fixed arg; none takes zero.
    for (const action of RECORDS_ACTIONS) {
      const codes = errorsFor(compositionFor(action, 'destructive', [], {}));
      // A truly empty envelope produces NO `records_arg_missing` for any key,
      // which is how an unusable action looks. Every real action requires or
      // admits at least one arg, so at least one of these signals must appear
      // when args are omitted OR when a plausible arg is supplied.
      const withFilters = errorsFor(compositionFor(action, 'destructive',
        [{ key: 'filters', type: 'object' }], {}));
      const usable = codes.includes('records_arg_missing')
        || !withFilters.includes('records_arg_extra');
      expect(usable, `${action} declares an empty arg envelope and cannot be authored`).toBe(true);
    }
  });
});
