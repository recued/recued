import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig, ConfigValidationError } from '../loader.js';

const makeTmpDir = (): string => mkdtempSync(join(tmpdir(), 'recued-cfg-'));

describe('loadConfig', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns schema + preset defaults when no file exists', () => {
    const out = loadConfig({
      distribution: 'source',
      configPath: join(dir, 'missing.toml'),
      env: { HOME: dir },
      argv: [],
    });
    expect(out.source).toBeNull();
    expect(out.bootstrap.bind_host).toBe('127.0.0.1');
    expect(out.bootstrap.bind_port).toBe(7717);
    // Source preset forces debug logs on.
    expect(out.runtime['log.level']).toBe('debug');
    // Universal defaults come through untouched.
    expect(out.runtime['vault.quota.total_bytes']).toBe(52428800);
  });

  it('server preset binds 0.0.0.0', () => {
    const out = loadConfig({
      distribution: 'server',
      configPath: join(dir, 'missing.toml'),
      env: { HOME: dir },
      argv: [],
    });
    expect(out.bootstrap.bind_host).toBe('0.0.0.0');
    expect(out.runtime['log.level']).toBe('info');
  });

  it('reads a user config.toml when present', () => {
    const cfgPath = join(dir, 'config.toml');
    writeFileSync(cfgPath, `
[bootstrap]
bind_port = 9999

[runtime]
"llm.budget" = 12345
"log.level" = "warn"
public_port = 8443
`);
    const out = loadConfig({
      distribution: 'source',
      configPath: cfgPath,
      env: { HOME: dir },
      argv: [],
    });
    expect(out.source).toBe(cfgPath);
    expect(out.bootstrap.bind_port).toBe(9999);
    expect(out.runtime['llm.budget']).toBe(12345);
    expect(out.runtime['log.level']).toBe('warn');
    expect(out.runtime.public_port).toBe(8443);
  });

  it('rejects public_port outside the valid listener port range', () => {
    const cfgPath = join(dir, 'config.toml');
    writeFileSync(cfgPath, `
[runtime]
public_port = 70000
`);
    expect(() =>
      loadConfig({
        distribution: 'source',
        configPath: cfgPath,
        env: { HOME: dir },
        argv: [],
      }),
    ).toThrow(ConfigValidationError);
    expect(() =>
      loadConfig({
        distribution: 'source',
        configPath: cfgPath,
        env: { HOME: dir },
        argv: [],
      }),
    ).toThrow(/runtime\.public_port must be <= 65535/);
  });

  it('BOOTSTRAP env beats the file; RUNTIME env is ignored so the FILE wins', () => {
    const cfgPath = join(dir, 'config.toml');
    writeFileSync(cfgPath, `
[bootstrap]
bind_port = 9999
[runtime]
"log.level" = "warn"
`);
    const out = loadConfig({
      distribution: 'source',
      configPath: cfgPath,
      env: {
        HOME: dir,
        RECUED_BOOTSTRAP_BIND_PORT: '12345',
        RECUED_RUNTIME_LOG_LEVEL: 'error',
      },
      argv: [],
    });
    // Bootstrap: env still wins over the file — these fields are needed before
    // any store can be read, so env is the only channel that can carry them.
    expect(out.bootstrap.bind_port).toBe(12345);
    // Runtime: INVERTED 2026-07-28. This used to assert `'error'` (env beating
    // the file). Runtime env is no longer ingested, so the file — which stands
    // in for what the owner saved through Settings — is what survives. That
    // inversion is the whole point of removing the runtime intake.
    expect(out.runtime['log.level']).toBe('warn');
  });

  it('CLI flags beat env vars', () => {
    const out = loadConfig({
      distribution: 'source',
      configPath: join(dir, 'missing.toml'),
      env: { HOME: dir, RECUED_BOOTSTRAP_BIND_PORT: '5000' },
      argv: ['--bind-port', '6000'],
    });
    expect(out.bootstrap.bind_port).toBe(6000);
  });

  it('honours --config CLI flag over configPath option', () => {
    const cfgA = join(dir, 'a.toml');
    writeFileSync(cfgA, '[bootstrap]\nbind_port = 1111');
    const cfgB = join(dir, 'b.toml');
    writeFileSync(cfgB, '[bootstrap]\nbind_port = 2222');
    const out = loadConfig({
      distribution: 'source',
      configPath: cfgA,
      env: { HOME: dir },
      argv: ['--config', cfgB],
    });
    expect(out.source).toBe(cfgB);
    expect(out.bootstrap.bind_port).toBe(2222);
  });

  it('honours RECUED_CONFIG env var over default OS path', () => {
    const cfg = join(dir, 'from-env.toml');
    writeFileSync(cfg, '[bootstrap]\nbind_port = 3333');
    const out = loadConfig({
      distribution: 'source',
      env: { HOME: dir, RECUED_CONFIG: cfg },
      argv: [],
    });
    expect(out.source).toBe(cfg);
    expect(out.bootstrap.bind_port).toBe(3333);
  });

  it('expands {data_path} in log_path after all overrides land', () => {
    const out = loadConfig({
      distribution: 'source',
      configPath: join(dir, 'missing.toml'),
      env: { HOME: dir, RECUED_BOOTSTRAP_DATA_PATH: '/var/recued' },
      argv: [],
    });
    expect(out.bootstrap.data_path).toBe('/var/recued');
    expect(out.bootstrap.log_path).toBe('/var/recued/logs');
  });

  it('surfaces unknown runtime keys without failing', () => {
    const cfgPath = join(dir, 'config.toml');
    writeFileSync(cfgPath, `
[runtime]
"something.new" = 1
"llm.budget" = 10
`);
    const out = loadConfig({
      distribution: 'source',
      configPath: cfgPath,
      env: { HOME: dir },
      argv: [],
    });
    expect(out.unknownKeys).toContain('runtime.something.new');
    expect(out.runtime['llm.budget']).toBe(10);
  });

  it('reports applied env names', () => {
    mkdirSync(join(dir, 'ignored'), { recursive: true });
    const out = loadConfig({
      distribution: 'source',
      configPath: join(dir, 'missing.toml'),
      env: {
        HOME: dir,
        RECUED_BOOTSTRAP_BIND_PORT: '7000',
        RECUED_RUNTIME_LLM_BUDGET: '5',
        UNRELATED_VAR: 'x',
      },
      argv: [],
    });
    // `RECUED_RUNTIME_LLM_BUDGET` is deliberately absent: it was not applied,
    // and a diagnostic that names an inert variable is worse than one that
    // omits it — it would send someone hunting for an override that never
    // happened.
    expect(out.envApplied.sort()).toEqual(['RECUED_BOOTSTRAP_BIND_PORT']);
  });

  it('Phase D: collection defaults land in the runtime schema', () => {
    const out = loadConfig({
      distribution: 'source',
      configPath: join(dir, 'missing.toml'),
      env: { HOME: dir },
      argv: [],
    });
    expect(out.runtime['collection.mail.default.quota_bytes']).toBe(2 * 1024 * 1024 * 1024);
    expect(out.runtime['collection.file.default.quota_bytes']).toBe(5 * 1024 * 1024 * 1024);
    expect(out.runtime['collection.webhook.default.quota_bytes']).toBe(200 * 1024 * 1024);
    expect(out.runtime['collection.mail.default.retention_days']).toBe(365);
    expect(out.runtime['collection.webhook.public_reachable']).toBe(false);
  });
});
