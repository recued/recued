/**
 * Canonicalization fixture corpus.
 *
 * Each fixture declares an input and the exact canonical string it must produce.
 * The expected strings are frozen contract — any change here is a breaking
 * change to the cache-key scheme and requires a cache-key version bump.
 *
 * Fixtures run in both jsdom (ext) and Node (server) CI environments.
 */

export interface CanonFixture {
  name: string;
  input: unknown;
  expected: string;
}

export const primitives: CanonFixture[] = [
  { name: 'null',          input: null,        expected: 'null' },
  { name: 'true',          input: true,        expected: 'true' },
  { name: 'false',         input: false,       expected: 'false' },
  { name: 'empty string',  input: '',          expected: '""' },
  { name: 'ascii string',  input: 'hello',     expected: '"hello"' },
  { name: 'zero',          input: 0,           expected: '0' },
  { name: 'negative zero', input: -0,          expected: '0' },
  { name: 'int',           input: 42,          expected: '42' },
  { name: 'negative int',  input: -7,          expected: '-7' },
  { name: 'float',         input: 3.14,        expected: '3.14' },
  { name: 'int as float',  input: 1.0,         expected: '1' },
  { name: 'max safe int',  input: 9007199254740991, expected: '9007199254740991' },
  { name: 'min value',     input: 5e-324,      expected: '5e-324' },
  { name: 'scientific',    input: 1e21,        expected: '1e+21' },
];

export const strings: CanonFixture[] = [
  { name: 'space',           input: ' ',          expected: '" "' },
  { name: 'unicode emoji',   input: '😀',         expected: '"😀"' },
  { name: 'quote',           input: '"',          expected: '"\\""' },
  { name: 'backslash',       input: '\\',         expected: '"\\\\"' },
  { name: 'newline',         input: '\n',         expected: '"\\n"' },
  { name: 'tab',             input: '\t',         expected: '"\\t"' },
  { name: 'carriage return', input: '\r',         expected: '"\\r"' },
  { name: 'backspace',       input: '\b',         expected: '"\\b"' },
  { name: 'formfeed',        input: '\f',         expected: '"\\f"' },
  { name: 'control char',    input: '\u0001',     expected: '"\\u0001"' },
  { name: 'combined escapes',input: 'a\nb\tc"d',  expected: '"a\\nb\\tc\\"d"' },
  { name: 'long ascii',      input: 'x'.repeat(100), expected: '"' + 'x'.repeat(100) + '"' },
];

export const arrays: CanonFixture[] = [
  { name: 'empty',       input: [],            expected: '[]' },
  { name: 'single',      input: [1],           expected: '[1]' },
  { name: 'three ints',  input: [1, 2, 3],     expected: '[1,2,3]' },
  { name: 'mixed',       input: [1, 'a', true, null], expected: '[1,"a",true,null]' },
  { name: 'nested',      input: [[1, 2], [3]], expected: '[[1,2],[3]]' },
  { name: 'order preserved', input: [3, 1, 2], expected: '[3,1,2]' },
  { name: 'undefined → null',  input: [1, undefined, 3], expected: '[1,null,3]' },
];

export const objects: CanonFixture[] = [
  { name: 'empty',            input: {},                    expected: '{}' },
  { name: 'single',           input: { a: 1 },              expected: '{"a":1}' },
  { name: 'sorted keys',      input: { b: 2, a: 1 },        expected: '{"a":1,"b":2}' },
  { name: 'nested sort',      input: { z: { b: 2, a: 1 } }, expected: '{"z":{"a":1,"b":2}}' },
  { name: 'mixed types',      input: { n: null, s: 'x', b: true, i: 1 }, expected: '{"b":true,"i":1,"n":null,"s":"x"}' },
  { name: 'undefined omitted', input: { a: 1, b: undefined, c: 3 }, expected: '{"a":1,"c":3}' },
  { name: 'key with spaces',  input: { 'key space': 1 },    expected: '{"key space":1}' },
  { name: 'unicode key',      input: { 'æ': 1, 'a': 2 },    expected: '{"a":2,"æ":1}' },
  { name: 'empty string key', input: { '': 'v' },           expected: '{"":"v"}' },
  { name: 'numeric-looking key', input: { '1': 'a', '2': 'b' }, expected: '{"1":"a","2":"b"}' },
];

export const nesting: CanonFixture[] = [
  {
    name: 'array of objects',
    input: [{ b: 1, a: 2 }, { d: 3, c: 4 }],
    expected: '[{"a":2,"b":1},{"c":4,"d":3}]',
  },
  {
    name: 'object of arrays',
    input: { y: [3, 2, 1], x: ['a', 'b'] },
    expected: '{"x":["a","b"],"y":[3,2,1]}',
  },
  {
    name: '4 levels deep',
    input: { a: { b: { c: { d: 1 } } } },
    expected: '{"a":{"b":{"c":{"d":1}}}}',
  },
  {
    name: 'realistic recipe input',
    input: {
      deal_id: '42',
      filters: { stage: 'open', priority: 'high' },
      fields: ['amount', 'close_date', 'owner'],
      include_archived: false,
    },
    expected: '{"deal_id":"42","fields":["amount","close_date","owner"],"filters":{"priority":"high","stage":"open"},"include_archived":false}',
  },
];

export const all: CanonFixture[] = [
  ...primitives,
  ...strings,
  ...arrays,
  ...objects,
  ...nesting,
];

/**
 * Pairs of inputs that must canonicalize identically.
 * These protect against ordering, equivalence, and normalization bugs.
 */
export interface EquivalenceGroup {
  name: string;
  inputs: unknown[];
}

export const equivalenceGroups: EquivalenceGroup[] = [
  {
    name: 'top-level key order',
    inputs: [{ a: 1, b: 2 }, { b: 2, a: 1 }],
  },
  {
    name: 'nested key order',
    inputs: [
      { x: { a: 1, b: 2 } },
      { x: { b: 2, a: 1 } },
    ],
  },
  {
    name: 'deeply nested key order',
    inputs: [
      { x: { y: { a: 1, b: 2, c: 3 } } },
      { x: { y: { c: 3, a: 1, b: 2 } } },
      { x: { y: { b: 2, c: 3, a: 1 } } },
    ],
  },
  {
    name: 'NFC vs NFD unicode (é)',
    inputs: ['\u00E9', '\u0065\u0301'],
  },
  {
    name: 'NFC vs NFD in keys',
    inputs: [{ '\u00E9': 1 }, { '\u0065\u0301': 1 }],
  },
  {
    name: 'negative zero vs zero',
    inputs: [0, -0],
  },
  {
    name: 'integer vs float int',
    inputs: [1, 1.0],
  },
  {
    name: 'undefined key vs missing key',
    inputs: [{ a: 1, b: undefined }, { a: 1 }],
  },
  {
    name: 'scientific notation vs integer',
    inputs: [100, 1e2],
  },
  {
    name: 'array of objects with different key orders',
    inputs: [
      [{ a: 1, b: 2 }, { c: 3, d: 4 }],
      [{ b: 2, a: 1 }, { d: 4, c: 3 }],
    ],
  },
];

/**
 * Inputs that must throw CanonicalizationError.
 * `errorMatch` is a substring the error message must contain.
 */
export interface RejectionFixture {
  name: string;
  input: () => unknown;
  errorMatch: string;
}

export const rejections: RejectionFixture[] = [
  { name: 'undefined at top level', input: () => undefined,         errorMatch: 'undefined' },
  { name: 'NaN',                     input: () => NaN,               errorMatch: 'NaN' },
  { name: 'Infinity',                input: () => Infinity,          errorMatch: 'Infinity' },
  { name: 'negative Infinity',       input: () => -Infinity,         errorMatch: 'Infinity' },
  { name: 'BigInt',                  input: () => 1n,                errorMatch: 'BigInt' },
  { name: 'Symbol',                  input: () => Symbol('x'),       errorMatch: 'Symbol' },
  { name: 'Function',                input: () => (() => 1),         errorMatch: 'Function' },
  { name: 'Date',                    input: () => new Date(0),       errorMatch: 'non-plain' },
  { name: 'Map',                     input: () => new Map(),         errorMatch: 'non-plain' },
  { name: 'Set',                     input: () => new Set(),         errorMatch: 'non-plain' },
  { name: 'RegExp',                  input: () => /x/,               errorMatch: 'non-plain' },
  { name: 'Uint8Array',              input: () => new Uint8Array(0), errorMatch: 'non-plain' },
  { name: 'class instance',          input: () => new (class Foo {})(), errorMatch: 'non-plain' },
  {
    name: 'circular object',
    input: () => { const o: Record<string, unknown> = {}; o.self = o; return o; },
    errorMatch: 'circular',
  },
  {
    name: 'NaN in array',
    input: () => [1, NaN, 3],
    errorMatch: 'NaN',
  },
  {
    name: 'BigInt in object',
    input: () => ({ n: 1n }),
    errorMatch: 'BigInt',
  },
  {
    name: 'Date deep in object',
    input: () => ({ a: { b: { c: new Date(0) } } }),
    errorMatch: 'non-plain',
  },
];
