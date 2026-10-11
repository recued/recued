import { describe, expect, it } from 'vitest';
import {
  RETIRED_FLAGS,
  findRetiredFlags,
  getArg,
  getFlag,
  parsePositionals,
} from '../cli/parse.js';

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

  it('still skips the values of the flags removed on 2026-10-09', () => {
    // So `--host 0.0.0.0 serve` routes to `serve`, where bin.ts refuses the
    // flag, instead of to help for a subcommand called "0.0.0.0".
    expect(parsePositionals(['pair', '--mcp-port', '7718', 'generate'])).toEqual([
      'pair',
      'generate',
    ]);
    expect(parsePositionals(['--host', '0.0.0.0', 'serve'])).toEqual(['serve']);
  });
});

describe('CLI findRetiredFlags', () => {
  it('finds each removed flag once, in either spelling, and nothing else', () => {
    expect(findRetiredFlags([
      '--host', '0.0.0.0', '--host=1.2.3.4', '--db', 'x.db', '--data-path=/d', '--port', '1',
    ])).toEqual(['--host', '--data-path']);
    expect(findRetiredFlags(['--db', '/x/recued-server.db', '--port', '7717', 'serve'])).toEqual([]);
  });

  it('names what replaced every removed flag', () => {
    expect([...RETIRED_FLAGS.keys()].sort()).toEqual([
      '--bind-host', '--data-path', '--db-path', '--host', '--mcp-port',
    ]);
    for (const replacement of RETIRED_FLAGS.values()) expect(replacement.length).toBeGreaterThan(0);
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
