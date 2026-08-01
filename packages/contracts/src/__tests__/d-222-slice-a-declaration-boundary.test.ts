import { describe, it, expect } from 'vitest';
import {
  UNDECLARED_CONFIG_ARGUMENT,
  undeclaredConfigArgumentMessage,
  undeclaredConfigArguments,
  type VariableDefault,
} from '../recipe.js';

/** D-222 Slice A — the pure half of the declaration boundary.
 *
 *  `variables` is supposed to BE the argument boundary, and before this slice
 *  that was a claim about a different check: `undeclared_variable_ref` walks the
 *  recipe document at install and proves an authored `{{config.X}}` points at a
 *  declaration. It says nothing about the keys a caller supplies at execution,
 *  so an undeclared key rode into the namespace store, resolved for nobody, and
 *  the run reported success having silently ignored what the caller asked for.
 *
 *  The rule lives here as a pure reporter rather than a thrower so it is
 *  testable without a server, and so the execute boundary owns the refusal (and
 *  its status code) in one place. The wiring half is
 *  `backend/server/src/__tests__/d-222-slice-a-execute-declaration-check.test.ts`. */

const vars = (v: Record<string, VariableDefault>): Record<string, VariableDefault> => v;

describe('D-222 Slice A — undeclaredConfigArguments', () => {
  it('reports nothing when every key is declared', () => {
    expect(
      undeclaredConfigArguments(vars({ status: 'open', limit: 5 }), { status: 'closed' }),
    ).toEqual([]);
  });

  it('reports an undeclared key', () => {
    expect(
      undeclaredConfigArguments(vars({ status: 'open' }), { staus: 'closed' }),
    ).toEqual([{ key: 'staus', origin: 'overlay' }]);
  });

  // The positive case is what separates a boundary from a blanket refusal: if
  // the check were `return Object.keys(config).map(...)` — refusing everything —
  // the negative test above would still pass. This is the input that would DO
  // THE THING if the rule were gone.
  it('admits a declared key that is the ONLY key — a guard, not a refusal', () => {
    const found = undeclaredConfigArguments(vars({ cursor: '' }), { cursor: 'abc' });
    expect(found).toEqual([]);
  });

  it('admits a declared key whose value is null-shorthand or a ValueHint', () => {
    const declared = vars({
      required_text: null,
      picked: { label: 'Picked', type: 'enum', options: ['a', 'b'] },
    });
    expect(
      undeclaredConfigArguments(declared, { required_text: 'x', picked: 'b' }),
    ).toEqual([]);
  });

  describe('origin attribution', () => {
    // A mistyped argument and a stale stored overlay present identically to the
    // owner and need different fixes, so the finding names which one it was.
    it('tags a key present in the wire set as `wire`', () => {
      const found = undeclaredConfigArguments(
        vars({}),
        { typo: 1 },
        new Set(['typo']),
      );
      expect(found).toEqual([{ key: 'typo', origin: 'wire' }]);
    });

    it('tags a key absent from the wire set as `overlay`', () => {
      const found = undeclaredConfigArguments(
        vars({}),
        { stale_overlay_key: 1 },
        new Set(['something_else']),
      );
      expect(found).toEqual([{ key: 'stale_overlay_key', origin: 'overlay' }]);
    });

    // Claiming `wire` without knowing would point the owner at the wrong fix,
    // so the default when no wire set is supplied is the conservative one.
    it('defaults to `overlay` when no wire set is supplied', () => {
      expect(undeclaredConfigArguments(vars({}), { k: 1 })).toEqual([
        { key: 'k', origin: 'overlay' },
      ]);
    });

    it('separates wire and overlay findings in one run', () => {
      const found = undeclaredConfigArguments(
        vars({ declared: 1 }),
        { declared: 2, from_wire: 3, from_overlay: 4 },
        new Set(['declared', 'from_wire']),
      );
      expect(found).toEqual([
        { key: 'from_wire', origin: 'wire' },
        { key: 'from_overlay', origin: 'overlay' },
      ]);
    });
  });

  describe('shapes that must not become a bypass', () => {
    it('treats an absent config as nothing to check', () => {
      expect(undeclaredConfigArguments(vars({ a: 1 }), undefined)).toEqual([]);
    });

    it('treats an empty config as nothing to check', () => {
      expect(undeclaredConfigArguments(vars({ a: 1 }), {})).toEqual([]);
    });

    it('refuses every key when the recipe declares no variables', () => {
      expect(undeclaredConfigArguments(undefined, { a: 1 })).toEqual([
        { key: 'a', origin: 'overlay' },
      ]);
      expect(undeclaredConfigArguments(vars({}), { a: 1 })).toEqual([
        { key: 'a', origin: 'overlay' },
      ]);
    });

    // A prototype-shaped payload must not read as declared. `Object.keys` skips
    // the chain and `hasOwnProperty` is used rather than `in`, so an inherited
    // property is neither reported as sent nor accepted as declared.
    it('does not accept an inherited property as a declaration', () => {
      const inherited = Object.create({ sneaky: 1 }) as Record<string, VariableDefault>;
      expect(undeclaredConfigArguments(inherited, { sneaky: 'v' })).toEqual([
        { key: 'sneaky', origin: 'overlay' },
      ]);
    });

    it('does not treat an inherited config property as a supplied key', () => {
      const cfg = Object.create({ ghost: 1 }) as Record<string, unknown>;
      expect(undeclaredConfigArguments(vars({}), cfg)).toEqual([]);
    });

    it('reports a literal __proto__ own key rather than skipping it', () => {
      const cfg = JSON.parse('{"__proto__": 1}') as Record<string, unknown>;
      // JSON.parse produces it as an OWN key, which is exactly the case a
      // naive `in`-based check would read as declared via Object.prototype.
      expect(undeclaredConfigArguments(vars({}), cfg)).toEqual([
        { key: '__proto__', origin: 'overlay' },
      ]);
    });
  });

  describe('message', () => {
    it('names the key, its origin, and what to do', () => {
      const msg = undeclaredConfigArgumentMessage([{ key: 'staus', origin: 'wire' }]);
      expect(msg).toContain("'staus' (wire)");
      expect(msg).toContain('variables');
      expect(msg).toMatch(/\bkey\b/);
    });

    it('pluralises for more than one finding', () => {
      const msg = undeclaredConfigArgumentMessage([
        { key: 'a', origin: 'wire' },
        { key: 'b', origin: 'overlay' },
      ]);
      expect(msg).toMatch(/\bkeys\b/);
      expect(msg).toContain("'a' (wire)");
      expect(msg).toContain("'b' (overlay)");
    });
  });

  it('exports a stable code distinct from undeclared_variable_ref', () => {
    expect(UNDECLARED_CONFIG_ARGUMENT).toBe('undeclared_config_argument');
    expect(UNDECLARED_CONFIG_ARGUMENT).not.toBe('undeclared_variable_ref');
  });
});
