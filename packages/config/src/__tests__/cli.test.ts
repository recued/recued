import { describe, expect, it } from 'vitest';
import { parseCliOverrides } from '../cli.js';

describe('parseCliOverrides', () => {
  it('pulls --config / --bind-port', () => {
    const out = parseCliOverrides([
      '--config', '/etc/recued/c.toml',
      '--bind-port', '8080',
    ]);
    expect(out.configPath).toBe('/etc/recued/c.toml');
    expect(out.bootstrap.bind_port).toBe(8080);
  });

  it('sets nothing from the flags removed on 2026-10-09', () => {
    // The server's router refuses these before config loads (`RETIRED_FLAGS`);
    // here they are just unknown flags, so no removed key can reappear.
    const out = parseCliOverrides([
      '--host', '0.0.0.0',
      '--bind-host=0.0.0.0',
      '--data-path', '/var/lib/recued',
      '--db-path=/var/lib/recued',
      '--mcp-port', '0',
      '--bind-port', '8080',
    ]);
    expect(out.bootstrap).toEqual({ bind_port: 8080 });
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

  it('reads the old --webhook-port as the webhook switch — non-zero is on — and says so', () => {
    // Renamed `webhooks_enabled` 2026-10-10. A service that still passes the
    // flag keeps working; the number was never a port.
    const on = parseCliOverrides(['--webhook-port=8800']);
    expect(on.bootstrap).toEqual({ webhooks_enabled: true });
    expect(on.renamed).toEqual([
      { name: '--webhook-port', replacement: expect.stringContaining('read as webhooks_enabled = true') },
    ]);
    const off = parseCliOverrides(['--webhook-port', '0']);
    expect(off.bootstrap).toEqual({ webhooks_enabled: false });
    expect(parseCliOverrides(['--port', '1']).renamed).toEqual([]);
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
