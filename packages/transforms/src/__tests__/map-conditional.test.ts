import { describe, expect, it } from 'vitest';
import { getTransform } from '../index.js';
import { ctx } from './helpers.js';

const c = ctx();

const mapTransform = () => {
  const fn = getTransform('map');
  if (!fn) throw new Error('map transform is not registered');
  return fn;
};

// The exact nested-$ternary the connection-agnostic resolver emits for the CRM
// `close_state` closed_state derivation: closed ? (won ? "won" : "lost") : "open".
const closedStateExpr = (closedPath: string, wonPath: string) => ({
  close_state: {
    $ternary: {
      if: `{{item.${closedPath}}}`,
      then: { $ternary: { if: `{{item.${wonPath}}}`, then: 'won', else: 'lost' } },
      else: 'open',
    },
  },
});

describe('map expression $ternary conditional', () => {
  it('bool-coerces the condition: real true, string "true", else falsey', () => {
    const items = [
      { flag: true, label: 'real-true' },
      { flag: false, label: 'real-false' },
      { flag: 'true', label: 'string-true' },
      { flag: 'True', label: 'string-True-mixedcase' },
      { flag: 'false', label: 'string-false' },
      { flag: '', label: 'empty-string' },
      { flag: null, label: 'null' },
      { label: 'missing' },
      { flag: 1, label: 'number-1-NOT-truthy' }, // only real true / "true" coerce
    ];
    const result = mapTransform()(
      { array: items, expression: { picked: { $ternary: { if: '{{item.flag}}', then: 'YES', else: 'no' } } } },
      c,
    ) as Array<{ picked: string }>;
    expect(result.map((r) => r.picked)).toEqual([
      'YES', // true
      'no',  // false
      'YES', // "true"
      'YES', // "True"
      'no',  // "false" — the silent-bug case (Boolean("false") is true)
      'no',  // ""
      'no',  // null
      'no',  // missing
      'no',  // 1 (deliberately NOT truthy — tight coercion)
    ]);
  });

  it('computes the closed_state tri-state from HubSpot STRING flags (closed ? won?won:lost : open)', () => {
    const items = [
      { hs_is_closed: 'false', hs_is_closed_won: 'false', n: 'open-deal' },
      { hs_is_closed: 'true',  hs_is_closed_won: 'true',  n: 'won-deal' },
      { hs_is_closed: 'true',  hs_is_closed_won: 'false', n: 'lost-deal' },
      { n: 'no-flags-deal' }, // missing both → open
    ];
    const result = mapTransform()(
      { array: items, expression: closedStateExpr('hs_is_closed', 'hs_is_closed_won') },
      c,
    ) as Array<{ close_state: string }>;
    expect(result.map((r) => r.close_state)).toEqual(['open', 'won', 'lost', 'open']);
  });

  it('computes the SAME tri-state from Salesforce REAL-boolean flags (cross-vendor parity)', () => {
    const items = [
      { IsClosed: false, IsWon: false, n: 'open' },
      { IsClosed: true,  IsWon: true,  n: 'won' },
      { IsClosed: true,  IsWon: false, n: 'lost' },
    ];
    const result = mapTransform()(
      { array: items, expression: closedStateExpr('IsClosed', 'IsWon') },
      c,
    ) as Array<{ close_state: string }>;
    // Identical canonical outputs to the HubSpot string-flag case above — the whole
    // point of the closed_state derivation (vendor-neutral open/won/lost).
    expect(result.map((r) => r.close_state)).toEqual(['open', 'won', 'lost']);
  });

  it('resolves then/else recursively (refs + nested templates), not just literals', () => {
    const result = mapTransform()(
      {
        array: [{ closed: 'true', label: 'Acme' }],
        expression: {
          out: { $ternary: { if: '{{item.closed}}', then: '{{item.label}}', else: 'n/a' } },
        },
      },
      c,
    ) as Array<{ out: string }>;
    expect(result[0].out).toBe('Acme');
  });
});

// The exact `$concat` the connection-agnostic resolver emits for the CRM `name`
// concat derivation: join non-empty parts with the separator, fall back to the
// email LOCAL-PART (the `| local_part` projection hint).
const nameConcatExpr = (firstPath: string, lastPath: string, emailPath: string) => ({
  name: {
    $concat: {
      parts: [`{{item.${firstPath}}}`, `{{item.${lastPath}}}`],
      separator: ' ',
      fallback: `{{item.${emailPath} | local_part}}`,
    },
  },
});

describe('map expression $concat (name derivation)', () => {
  it('joins non-empty parts, skips empties (no stray separators), falls back when all empty', () => {
    const items = [
      { firstname: 'Alice', lastname: 'Smith', email: 'a@x.com', n: 'both' },
      { firstname: 'Alice', email: 'a@x.com', n: 'first-only' },
      { lastname: 'Smith', email: 's@x.com', n: 'last-only' },
      { email: 'nameless@x.com', n: 'email-fallback' },
      { firstname: '  ', lastname: '', n: 'all-empty-no-email' }, // whitespace + missing fallback → null
    ];
    const result = mapTransform()(
      { array: items, expression: nameConcatExpr('firstname', 'lastname', 'email') },
      c,
    ) as Array<{ name: string | null }>;
    expect(result.map((r) => r.name)).toEqual([
      'Alice Smith', // both
      'Alice',       // first only — no trailing separator
      'Smith',       // last only — no leading separator
      'nameless',    // every part empty → fallback to the email LOCAL-PART
      null,          // every part empty + no fallback value → null
    ]);
  });

  it('falls back to the email LOCAL-PART (alice@x.com → alice); leading-@ / missing → null', () => {
    const items = [
      { email: 'nameless@example.com', n: 'normal-email' },
      { email: 'plainstring', n: 'no-at-sign' },   // no @ → whole value
      { email: '@nodomain.com', n: 'leading-at' }, // empty local part → null
      { n: 'missing-email' },                       // missing → null
    ];
    const result = mapTransform()(
      { array: items, expression: nameConcatExpr('firstname', 'lastname', 'email') },
      c,
    ) as Array<{ name: string | null }>;
    expect(result.map((r) => r.name)).toEqual(['nameless', 'plainstring', null, null]);
  });

  it('| local_part hint resolves directly to the substring before the FIRST @ (trimmed)', () => {
    const result = mapTransform()(
      {
        array: [{ e: 'a.b+tag@sub.example.com' }, { e: 'noat' }, { e: '  spaced@x.com ' }, { e: '' }],
        expression: { local: '{{item.e | local_part}}' },
      },
      c,
    ) as Array<{ local: string | null }>;
    expect(result.map((r) => r.local)).toEqual(['a.b+tag', 'noat', 'spaced', null]);
  });

  it('trims whitespace parts; a fallback-less all-empty row is null (not "")', () => {
    const result = mapTransform()(
      {
        array: [{ first: '  Bob  ', last: ' Jones ' }, { n: 'missing' }],
        expression: { name: { $concat: { parts: ['{{item.first}}', '{{item.last}}'], separator: ' ' } } },
      },
      c,
    ) as Array<{ name: string | null }>;
    expect(result.map((r) => r.name)).toEqual(['Bob Jones', null]);
  });

  it('cross-vendor parity: HubSpot firstname/lastname and Salesforce FirstName/LastName yield the same name', () => {
    const hs = mapTransform()(
      { array: [{ firstname: 'Carol', lastname: 'Lee' }], expression: nameConcatExpr('firstname', 'lastname', 'email') },
      c,
    ) as Array<{ name: string }>;
    const sf = mapTransform()(
      { array: [{ FirstName: 'Carol', LastName: 'Lee' }], expression: nameConcatExpr('FirstName', 'LastName', 'Email') },
      c,
    ) as Array<{ name: string }>;
    expect(hs[0].name).toBe('Carol Lee');
    expect(sf[0].name).toBe(hs[0].name);
  });
});
