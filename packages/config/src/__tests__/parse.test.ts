import { describe, expect, it } from 'vitest';
import { ConfigValidationError, parseToml } from '../parse.js';

describe('parseToml', () => {
  it('extracts bootstrap + runtime from a full file', () => {
    const src = `
[bootstrap]
bind_port = 7717
webhooks_enabled = false

[runtime]
"llm.budget" = 1000
"supervisor.mode" = "systemd"
"scheduler.min_interval_minutes" = 15
`;
    const { parsed, unknown, retired, retiredRuntime, renamed } = parseToml(src);
    expect(parsed.bootstrap).toEqual({
      bind_port: 7717,
      webhooks_enabled: false,
    });
    expect(retired).toEqual([]);
    expect(retiredRuntime).toEqual([]);
    expect(renamed).toEqual([]);
    expect(parsed.runtime).toMatchObject({
      'llm.budget': 1000,
      'supervisor.mode': 'systemd',
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

  it('reports the bootstrap keys removed on 2026-10-09 and applies none of them', () => {
    // Even a value the old parser refused (a string port) must not throw: the
    // file may have been written by an older install.
    const src = `
[bootstrap]
data_path = "/srv/recued"
bind_host = "127.0.0.1"
bind_port = 7717
mcp_port = "seven"
log_path = "{data_path}/logs"
`;
    const { parsed, unknown, misplaced, retired } = parseToml(src);
    expect(parsed.bootstrap).toEqual({ bind_port: 7717 });
    expect([...retired].sort()).toEqual(['bind_host', 'data_path', 'log_path', 'mcp_port']);
    expect(unknown).toEqual([]);
    expect(misplaced).toEqual([]);
  });

  it('reads the old webhook_port as the webhook switch — non-zero is on', () => {
    // Renamed `webhooks_enabled` 2026-10-10; still validated as the port it
    // always claimed to be, so a file the old parser refused is still refused.
    const on = parseToml('[bootstrap]\nwebhook_port = 8443\n');
    expect(on.parsed.bootstrap).toEqual({ webhooks_enabled: true });
    expect(on.renamed).toEqual([{ key: 'webhook_port', port: 8443, overridden: false }]);
    expect(parseToml('[bootstrap]\nwebhook_port = 0\n').parsed.bootstrap).toEqual({ webhooks_enabled: false });
    expect(() => parseToml('[bootstrap]\nwebhook_port = "x"\n')).toThrow(/bootstrap\.webhook_port/);
  });

  it('lets webhooks_enabled win when a file sets both names', () => {
    const both = parseToml('[bootstrap]\nwebhook_port = 8443\nwebhooks_enabled = false\n');
    expect(both.parsed.bootstrap).toEqual({ webhooks_enabled: false });
    expect(both.renamed).toEqual([{ key: 'webhook_port', port: 8443, overridden: true }]);
  });

  it('refuses a webhooks_enabled that is not true or false, and flags either name outside [bootstrap]', () => {
    expect(() => parseToml('[bootstrap]\nwebhooks_enabled = 1\n')).toThrow(/true or false/);
    expect(parseToml('webhook_port = 1\n').misplaced).toEqual([
      'webhook_port → write webhooks_enabled under [bootstrap]',
    ]);
    expect(parseToml('webhooks_enabled = true\n').misplaced).toEqual([
      'webhooks_enabled → move under [bootstrap]',
    ]);
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
