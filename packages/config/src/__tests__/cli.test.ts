import { describe, expect, it } from 'vitest';
import { parseCliOverrides } from '../cli.js';

describe('parseCliOverrides', () => {
  it('pulls --config / --bind-port / --bind-host / --data-path', () => {
    const out = parseCliOverrides([
      '--config', '/etc/recued/c.toml',
      '--bind-port', '8080',
      '--bind-host', '0.0.0.0',
      '--data-path', '/var/lib/recued',
    ]);
    expect(out.configPath).toBe('/etc/recued/c.toml');
    expect(out.bootstrap.bind_port).toBe(8080);
    expect(out.bootstrap.bind_host).toBe('0.0.0.0');
    expect(out.bootstrap.data_path).toBe('/var/lib/recued');
  });

  it('accepts = syntax too', () => {
    const out = parseCliOverrides(['--bind-port=9090', '--config=/x.toml']);
    expect(out.configPath).toBe('/x.toml');
    expect(out.bootstrap.bind_port).toBe(9090);
  });

  it('accepts --port as an alias for --bind-port', () => {
    const out = parseCliOverrides(['--port', '7777']);
    expect(out.bootstrap.bind_port).toBe(7777);
  });

  it('captures --mcp-port and --webhook-port', () => {
    const out = parseCliOverrides(['--mcp-port', '0', '--webhook-port=8800']);
    expect(out.bootstrap.mcp_port).toBe(0);
    expect(out.bootstrap.webhook_port).toBe(8800);
  });

  it('ignores unknown flags', () => {
    const out = parseCliOverrides(['--foo', '--bar=baz', '--bind-port=8080']);
    expect(out.bootstrap.bind_port).toBe(8080);
    expect(out.configPath).toBeUndefined();
  });

  it('throws on bad port values', () => {
    expect(() => parseCliOverrides(['--bind-port', 'oops'])).toThrow(/must be an integer/);
    expect(() => parseCliOverrides(['--bind-port', '70000'])).toThrow(/must be an integer/);
  });

  it('throws when a flag that needs a value is bare', () => {
    expect(() => parseCliOverrides(['--config'])).toThrow(/expects a path/);
    expect(() => parseCliOverrides(['--bind-port'])).toThrow(/expects a number/);
  });
});
