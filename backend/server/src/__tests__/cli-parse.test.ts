import { describe, expect, it } from 'vitest';
import { getArg, getFlag, parsePositionals } from '../cli/parse.js';

describe('CLI parsePositionals', () => {
  it('skips --config and its value before a subcommand', () => {
    expect(parsePositionals(['--config', '/foo/recued.toml', 'start'])).toEqual(['start']);
  });

  it('skips --config and its value before --version', () => {
    expect(parsePositionals(['--config', '/foo/recued.toml', '--version'])).toEqual([]);
  });

  it('skips all global valued flags while preserving command positionals', () => {
    expect(
      parsePositionals([
        '--db',
        '/tmp/recued.db',
        '--config',
        '/foo/recued.toml',
        '--port',
        '4000',
        '--bind-port',
        '5000',
        'pair',
        'generate',
      ]),
    ).toEqual(['pair', 'generate']);
  });

  it('skips --bind-port value after an initial positional', () => {
    expect(parsePositionals(['pair', '--bind-port', '9000', 'generate'])).toEqual([
      'pair',
      'generate',
    ]);
  });

  it('skips --bind-port=value without consuming the following positional', () => {
    expect(parsePositionals(['pair', '--bind-port=9000', 'generate'])).toEqual([
      'pair',
      'generate',
    ]);
  });

  it('skips sibling bootstrap valued flags after an initial positional', () => {
    expect(parsePositionals(['pair', '--mcp-port', '7718', 'generate'])).toEqual([
      'pair',
      'generate',
    ]);
  });
});

describe('CLI getArg', () => {
  it('still reads --config as a valued global flag', () => {
    expect(getArg(['--config', '/foo/recued.toml', 'start'], 'config')).toBe('/foo/recued.toml');
  });
});

describe('CLI getFlag', () => {
  it('reads long boolean flags', () => {
    expect(getFlag(['--version'], 'version')).toBe(true);
    expect(getFlag(['--help'], 'help')).toBe(true);
  });

  it('reads short single-letter boolean flags', () => {
    expect(getFlag(['-v'], 'v')).toBe(true);
    expect(getFlag(['-h'], 'h')).toBe(true);
  });

  it('does not treat long flag names as short aliases', () => {
    expect(getFlag(['--version'], 'v')).toBe(false);
    expect(getFlag(['-version'], 'version')).toBe(false);
  });
});
