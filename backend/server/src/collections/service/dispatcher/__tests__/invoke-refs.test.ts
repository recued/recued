/** D-118 Phase 6 — invoke input validation + ref resolution. */
import { describe, expect, it } from 'vitest';

import {
  InvokeInputInvalidError,
  resolveInvokeArgv,
  resolveInvokeEnv,
  validateInvokeInputs,
} from '../invoke-refs.js';
import type { InvokeOpSpec } from '../types.js';

const baseOp = (overrides: Partial<InvokeOpSpec> = {}): InvokeOpSpec => ({
  argv: ['ffmpeg', '-i', '{{input.source}}', '-y', '{{input.target}}'],
  timeout_ms: 60_000,
  input: {
    source: { type: 'file_ref', required: true },
    target: { type: 'file_ref', required: true, write: true },
    preset: { type: 'enum', values: ['ultrafast', 'fast', 'medium'] },
  },
  output: { log_lines: 'lines' },
  ...overrides,
});

describe('validateInvokeInputs — required fields', () => {
  it('rejects missing required field', () => {
    expect(() =>
      validateInvokeInputs(baseOp(), { target: 'out.mp4' }),
    ).toThrow(/required/);
  });

  it('accepts optional field omitted', () => {
    const out = validateInvokeInputs(baseOp(), {
      source: 'in.mp4',
      target: 'out.mp4',
    });
    expect(out).toEqual({ source: 'in.mp4', target: 'out.mp4' });
  });

  it('rejects unknown input field (extras blocked)', () => {
    expect(() =>
      validateInvokeInputs(baseOp(), {
        source: 'in.mp4',
        target: 'out.mp4',
        rogue: 42,
      }),
    ).toThrow(/unknown input field/);
  });

  it('rejects prototype-sensitive extra input fields instead of treating them as inherited', () => {
    expect(() =>
      validateInvokeInputs(baseOp(), {
        source: 'in.mp4',
        target: 'out.mp4',
        constructor: 'polluted',
      }),
    ).toThrow(/unknown input field/);
  });

  it('ignores prototype-sensitive declared fields', () => {
    const op: InvokeOpSpec = {
      ...baseOp(),
      input: {
        source: { type: 'file_ref', required: true },
        ['constructor']: { type: 'string' as const, required: true },
      },
      argv: [],
    };

    expect(validateInvokeInputs(op, { source: 'in.mp4' })).toEqual({ source: 'in.mp4' });
  });
});

describe('validateInvokeInputs — type coercion per field type', () => {
  it('string field requires string', () => {
    const op: InvokeOpSpec = {
      ...baseOp(),
      input: { greeting: { type: 'string', required: true } },
      argv: [],
    };
    expect(() => validateInvokeInputs(op, { greeting: 42 })).toThrow(/must be a string/);
  });

  it('number field requires finite number', () => {
    const op: InvokeOpSpec = {
      ...baseOp(),
      input: { n: { type: 'number', required: true } },
      argv: [],
    };
    expect(() => validateInvokeInputs(op, { n: 'nope' })).toThrow(/finite number/);
    expect(() => validateInvokeInputs(op, { n: Number.POSITIVE_INFINITY })).toThrow(/finite number/);
  });

  it('boolean field requires boolean', () => {
    const op: InvokeOpSpec = {
      ...baseOp(),
      input: { flag: { type: 'boolean', required: true } },
      argv: [],
    };
    expect(() => validateInvokeInputs(op, { flag: 'true' })).toThrow(/must be a boolean/);
    expect(validateInvokeInputs(op, { flag: true })).toEqual({ flag: true });
  });

  it('enum field requires one of declared values', () => {
    expect(() =>
      validateInvokeInputs(baseOp(), {
        source: 'a',
        target: 'b',
        preset: 'blazing',
      }),
    ).toThrow(/must be one of/);
  });
});

describe('validateInvokeInputs — flag-injection guard', () => {
  it('rejects file_ref starting with "-"', () => {
    expect(() =>
      validateInvokeInputs(baseOp(), {
        source: '--evil.mp4',
        target: 'out.mp4',
      }),
    ).toThrow(/flag-injection guard/);
  });

  it('allow_flag_like opts out of the guard', () => {
    const op: InvokeOpSpec = {
      ...baseOp(),
      input: {
        source: { type: 'file_ref', required: true, allow_flag_like: true },
        target: { type: 'file_ref', required: true, write: true },
      },
    };
    expect(() =>
      validateInvokeInputs(op, { source: '--legit', target: 'out' }),
    ).not.toThrow();
  });

  it('rejects url starting with "-"', () => {
    const op: InvokeOpSpec = {
      ...baseOp(),
      input: { u: { type: 'url', required: true } },
      argv: [],
    };
    expect(() => validateInvokeInputs(op, { u: '-http://a.example' })).toThrow(
      /flag-injection guard/,
    );
  });

  it('rejects url without http/https scheme', () => {
    const op: InvokeOpSpec = {
      ...baseOp(),
      input: { u: { type: 'url', required: true } },
      argv: [],
    };
    expect(() => validateInvokeInputs(op, { u: 'file:///etc/passwd' })).toThrow(
      /http:\/\/ or https:\/\//,
    );
  });
});

describe('validateInvokeInputs — InvokeInputInvalidError', () => {
  it('carries the offending field name', () => {
    try {
      validateInvokeInputs(baseOp(), { target: 'o' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(InvokeInputInvalidError);
      expect((err as InvokeInputInvalidError).field).toBe('source');
    }
  });
});

describe('resolveInvokeArgv — {{input.*}} + {{config.*}} substitution', () => {
  it('substitutes {{input.*}} into argv values', () => {
    const out = resolveInvokeArgv(
      ['ffmpeg', '-i', '{{input.source}}', '-y', '{{input.target}}'],
      { source: 'in.mp4', target: 'out.mp4' },
      {},
    );
    expect(out).toEqual(['ffmpeg', '-i', 'in.mp4', '-y', 'out.mp4']);
  });

  it('substitutes {{config.*}} first, then {{input.*}}', () => {
    const out = resolveInvokeArgv(
      ['ollama', '--host', '{{config.host}}', '--model', '{{input.model}}'],
      { model: 'llama3' },
      { host: '127.0.0.1:11434' },
    );
    expect(out).toEqual(['ollama', '--host', '127.0.0.1:11434', '--model', 'llama3']);
  });

  it('interpolates refs inside template strings', () => {
    const out = resolveInvokeArgv(
      ['--dest={{input.target}}'],
      { target: 'x.mp4' },
      {},
    );
    expect(out).toEqual(['--dest=x.mp4']);
  });

  it('leaves unresolved refs as literal text', () => {
    const out = resolveInvokeArgv(
      ['{{input.missing}}'],
      {},
      {},
    );
    expect(out).toEqual(['{{input.missing}}']);
  });

  it('does not resolve prototype-chain input paths', () => {
    const out = resolveInvokeArgv(
      ['{{input.constructor.name}}', '{{input.__proto__.polluted}}'],
      {},
      {},
    );
    expect(out).toEqual(['{{input.constructor.name}}', '{{input.__proto__.polluted}}']);
  });
});

describe('resolveInvokeEnv — config + vault + input', () => {
  it('resolves config + input + vault in one env value', () => {
    const out = resolveInvokeEnv(
      { CMD: 'host=127.0.0.1:{{config.port}} token={{vault.api}} user={{input.user}}' },
      { user: 'alice' },
      { port: 9000 },
      'recued-core',
      (pub, k) => (pub === 'recued-core' && k === 'api' ? 'sk-abc' : undefined),
    );
    expect(out).toEqual({ CMD: 'host=127.0.0.1:9000 token=sk-abc user=alice' });
  });

  it('returns undefined when env is undefined', () => {
    expect(resolveInvokeEnv(undefined, {}, {}, 'recued-core', undefined)).toBeUndefined();
  });

  it('drops prototype-sensitive env names', () => {
    const out = resolveInvokeEnv(
      {
        SAFE: '{{input.user}}',
        ['__proto__']: 'polluted',
        constructor: 'polluted',
        prototype: 'polluted',
      },
      { user: 'alice' },
      {},
      'recued-core',
      undefined,
    );
    expect(out).toEqual({ SAFE: 'alice' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
