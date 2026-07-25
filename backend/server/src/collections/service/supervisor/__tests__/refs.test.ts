/** D-118 Phase 5 — argv/env ref resolution tests. */
import { describe, expect, it } from 'vitest';

import {
  redactArgvForAudit,
  resolveArgv,
  resolveEnv,
  resolveEnvValue,
} from '../refs.js';

describe('resolveArgv — {{config.*}} only', () => {
  it('substitutes a single pure ref inside an argv value', () => {
    expect(resolveArgv(['--port', '{{config.port}}'], { port: 11434 }))
      .toEqual(['--port', '11434']);
  });

  it('interpolates into a template string', () => {
    expect(resolveArgv(['--bind', '127.0.0.1:{{config.port}}'], { port: 9000 }))
      .toEqual(['--bind', '127.0.0.1:9000']);
  });

  it('leaves unresolved refs as literal text', () => {
    expect(resolveArgv(['--missing', '{{config.unknown}}'], { port: 80 }))
      .toEqual(['--missing', '{{config.unknown}}']);
  });

  it('leaves {{vault.*}} refs untouched (argv is config-only per spec)', () => {
    expect(resolveArgv(['--key', '{{vault.api}}'], { port: 80 }))
      .toEqual(['--key', '{{vault.api}}']);
  });

  it('stringifies object values as JSON on interpolation', () => {
    expect(resolveArgv(['--opts', '{{config.flags}}'], { flags: { a: 1 } }))
      .toEqual(['--opts', '{"a":1}']);
  });

  it('does not resolve prototype-chain config paths', () => {
    expect(resolveArgv(['{{config.constructor.name}}', '{{config.__proto__.polluted}}'], {}))
      .toEqual(['{{config.constructor.name}}', '{{config.__proto__.polluted}}']);
  });
});

describe('resolveEnv — config + vault', () => {
  const resolveVault = (pub: string, key: string): string | undefined => {
    if (pub !== 'recued-core') return undefined;
    if (key === 'api') return 'sk-test-abc';
    return undefined;
  };

  it('resolves {{config.*}} in env values', () => {
    expect(
      resolveEnv({ HOST: '127.0.0.1:{{config.port}}' }, { port: 11434 }, 'recued-core', undefined),
    ).toEqual({ HOST: '127.0.0.1:11434' });
  });

  it('resolves {{vault.*}} via the resolveVault seam', () => {
    expect(
      resolveEnv(
        { API_KEY: '{{vault.api}}' },
        {},
        'recued-core',
        resolveVault,
      ),
    ).toEqual({ API_KEY: 'sk-test-abc' });
  });

  it('leaves {{vault.*}} literal when resolver returns undefined', () => {
    expect(
      resolveEnv({ API_KEY: '{{vault.missing}}' }, {}, 'recued-core', resolveVault),
    ).toEqual({ API_KEY: '{{vault.missing}}' });
  });

  it('scopes vault by publisher_id', () => {
    expect(
      resolveEnv({ API_KEY: '{{vault.api}}' }, {}, 'third-party', resolveVault),
    ).toEqual({ API_KEY: '{{vault.api}}' });
  });

  it('returns undefined when env is undefined', () => {
    expect(resolveEnv(undefined, {}, 'recued-core', resolveVault)).toBeUndefined();
  });

  it('drops prototype-sensitive env names', () => {
    expect(
      resolveEnv(
        {
          SAFE: 'ok',
          ['__proto__']: 'polluted',
          constructor: 'polluted',
          prototype: 'polluted',
        },
        {},
        'recued-core',
        resolveVault,
      ),
    ).toEqual({ SAFE: 'ok' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('resolveEnvValue — mixed refs in one string', () => {
  it('resolves both config and vault refs in the same string', () => {
    const out = resolveEnvValue(
      'host=127.0.0.1:{{config.port}} auth={{vault.api}}',
      { port: 9000 },
      'recued-core',
      (_pub, k) => (k === 'api' ? 'xyz' : undefined),
    );
    expect(out).toBe('host=127.0.0.1:9000 auth=xyz');
  });
});

describe('redactArgvForAudit', () => {
  it('replaces any argv element that equals a resolved vault value', () => {
    const argv = ['--api-key', 'sk-test-abc', '--host', 'localhost'];
    const out = redactArgvForAudit(
      argv,
      new Set(['api']),
      new Map([['api', 'sk-test-abc']]),
    );
    expect(out).toEqual(['--api-key', '<vault:api>', '--host', 'localhost']);
  });

  it('passes argv through when no vault keys were captured', () => {
    const argv = ['ollama', 'serve'];
    const out = redactArgvForAudit(argv, new Set(), new Map());
    expect(out).toBe(argv);
  });

  it('only redacts exact-match argv elements (no substring matching)', () => {
    const argv = ['some-prefix=sk-test-abc'];
    const out = redactArgvForAudit(
      argv,
      new Set(['api']),
      new Map([['api', 'sk-test-abc']]),
    );
    expect(out).toEqual(['some-prefix=sk-test-abc']);
  });
});
