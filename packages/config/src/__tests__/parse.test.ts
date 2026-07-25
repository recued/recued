import { describe, expect, it } from 'vitest';
import { ConfigValidationError, parseToml } from '../parse.js';

describe('parseToml', () => {
  it('extracts bootstrap + runtime from a full file', () => {
    const src = `
[bootstrap]
data_path = "/srv/recued"
bind_host = "127.0.0.1"
bind_port = 7717
mcp_port = 0
webhook_port = 0
log_path = "{data_path}/logs"

[runtime]
"llm.budget" = 1000
"log.level" = "warn"
"scheduler.min_interval_minutes" = 15
`;
    const { parsed, unknown } = parseToml(src);
    expect(parsed.bootstrap).toEqual({
      data_path: '/srv/recued',
      bind_host: '127.0.0.1',
      bind_port: 7717,
      mcp_port: 0,
      webhook_port: 0,
      log_path: '{data_path}/logs',
    });
    expect(parsed.runtime).toMatchObject({
      'llm.budget': 1000,
      'log.level': 'warn',
      'scheduler.min_interval_minutes': 15,
    });
    expect(unknown).toEqual([]);
  });

  it('accepts both quoted dotted keys and nested-table syntax', () => {
    const src = `
[runtime]
llm.budget = 500
"llm.free_pool_strategy" = "weighted"
`;
    const { parsed } = parseToml(src);
    expect(parsed.runtime).toMatchObject({
      'llm.budget': 500,
      'llm.free_pool_strategy': 'weighted',
    });
  });

  it('lists unknown runtime keys without throwing', () => {
    const src = `
[runtime]
"made.up.key" = 42
"llm.budget" = 10
`;
    const { parsed, unknown } = parseToml(src);
    expect(parsed.runtime['llm.budget']).toBe(10);
    expect(unknown).toContain('runtime.made.up.key');
  });

  it('treats prototype-sensitive runtime keys as unknown', () => {
    const src = `
[runtime]
"__proto__" = "polluted"
"constructor" = "polluted"
"prototype" = "polluted"
"llm.budget" = 10
`;
    const { parsed, unknown } = parseToml(src);
    expect(parsed.runtime['llm.budget']).toBe(10);
    expect(unknown).toEqual(expect.arrayContaining([
      'runtime.__proto__',
      'runtime.constructor',
      'runtime.prototype',
    ]));
    expect(Object.prototype.hasOwnProperty.call(parsed.runtime, '__proto__')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(parsed.runtime, 'constructor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(parsed.runtime, 'prototype')).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('throws on bad TOML syntax', () => {
    expect(() => parseToml('[bootstrap\ndata_path = "x"')).toThrow(ConfigValidationError);
  });

  it('validates value types — boolean wants boolean', () => {
    const src = `
[runtime]
"llm.allow_upgrade_default" = "yes"
`;
    expect(() => parseToml(src)).toThrow(/expects boolean/);
  });

  it('validates min bound for numeric fields', () => {
    const src = `
[runtime]
"llm.budget" = -1
`;
    expect(() => parseToml(src)).toThrow(/must be >= 0/);
  });

  it('validates enum membership', () => {
    const src = `
[runtime]
"llm.free_pool_strategy" = "uniform"
`;
    expect(() => parseToml(src)).toThrow(/must be one of/);
  });

  it('validates bootstrap port range', () => {
    const src = `
[bootstrap]
bind_port = 70000
`;
    expect(() => parseToml(src)).toThrow(/bind_port/);
  });

  it('returns empty partials for an empty file', () => {
    const { parsed } = parseToml('');
    expect(parsed.bootstrap).toEqual({});
    expect(parsed.runtime).toEqual({});
  });
});
