import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigValidationError, loadConfig } from '@recued/config';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveBindPort } from '../cli/resolve-bind-port.js';

let tmp: string | undefined;

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

const makeTmp = (): string => {
  tmp = mkdtempSync(join(tmpdir(), 'recued-resolve-bind-port-'));
  return tmp;
};

const writeConfig = (dir: string, bindPort: number): string => {
  const configPath = join(dir, 'config.toml');
  writeFileSync(configPath, `
[bootstrap]
bind_port = ${bindPort}
`);
  return configPath;
};

describe('resolveBindPort', () => {
  it.each([
    [['--port', '4100'], 4100],
    [['--port=4101'], 4101],
    [['--bind-port', '4102'], 4102],
    [['--bind-port=4103'], 4103],
  ])('resolves CLI override spelling %j before config loading', (args, expected) => {
    expect(resolveBindPort({ args, env: { PORT: '9000' } })).toBe(expected);
  });

  it('lets CLI --bind-port beat PORT', () => {
    expect(resolveBindPort({
      args: ['--bind-port=4444'],
      env: { PORT: '9000' },
    })).toBe(4444);
  });

  it('lets trimmed PORT beat config.toml bind_port', () => {
    const dir = makeTmp();
    const configPath = writeConfig(dir, 8080);

    expect(resolveBindPort({
      args: ['--config', configPath],
      env: { HOME: dir, PORT: ' 9000 ' },
    })).toBe(9000);
  });

  it('lets config.toml bind_port beat the preset default', () => {
    const dir = makeTmp();
    const configPath = writeConfig(dir, 8080);

    expect(resolveBindPort({
      args: ['--config', configPath],
      env: { HOME: dir },
    })).toBe(8080);
  });

  it('falls back to the source preset default when no overrides exist', () => {
    const dir = makeTmp();

    expect(resolveBindPort({
      args: ['--config', join(dir, 'missing.toml')],
      env: { HOME: dir },
    })).toBe(7717);
  });

  it('throws ConfigValidationError for invalid non-blank PORT', () => {
    const dir = makeTmp();
    const configPath = writeConfig(dir, 8080);

    expect(() =>
      resolveBindPort({
        args: ['--config', configPath],
        env: { HOME: dir, PORT: 'oops' },
      }),
    ).toThrow(ConfigValidationError);
  });

  it('treats whitespace PORT as absent and falls through to config', () => {
    const dir = makeTmp();
    const configPath = writeConfig(dir, 8080);

    expect(resolveBindPort({
      args: ['--config', configPath],
      env: { HOME: dir, PORT: '   ' },
    })).toBe(8080);
  });

  it('throws ConfigValidationError for out-of-range PORT', () => {
    const dir = makeTmp();
    const configPath = writeConfig(dir, 8080);

    expect(() =>
      resolveBindPort({
        args: ['--config', configPath],
        env: { HOME: dir, PORT: '65536' },
      }),
    ).toThrow(ConfigValidationError);
  });

  it('accepts explicit PORT=0', () => {
    const dir = makeTmp();
    const configPath = writeConfig(dir, 8080);

    expect(resolveBindPort({
      args: ['--config', configPath],
      env: { HOME: dir, PORT: '0' },
    })).toBe(0);
  });

  it('reuses a passed loaded config instead of re-reading config.toml', () => {
    const dir = makeTmp();
    const configPath = writeConfig(dir, 8123);
    const env = { HOME: dir };
    const loaded = loadConfig({
      distribution: 'source',
      configPath,
      argv: [],
      env,
    });

    writeFileSync(configPath, `
[bootstrap]
bind_port = 70000
`);

    expect(resolveBindPort({
      args: ['--config', configPath],
      env,
      loaded,
    })).toBe(8123);
  });
});
