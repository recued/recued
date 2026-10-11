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
    expect(out.bootstrap).toEqual({ bind_port: 7717, webhooks_enabled: false });
    expect(out.retiredSettings).toEqual([]);
    expect(out.renamedSettings).toEqual([]);
    // Universal defaults come through untouched.
    expect(out.runtime['vault.quota.total_bytes']).toBe(52428800);
  });

  it('every distribution preset gives the same defaults', () => {
    // They differed in bind_host and log.level, which nothing read (removed
    // 2026-10-09 and 2026-10-10).
    const load = (distribution: 'binary' | 'source' | 'server') => loadConfig({
      distribution,
      configPath: join(dir, 'missing.toml'),
      env: { HOME: dir },
      argv: [],
    });
    const source = load('source');
    expect(load('server')).toMatchObject({ bootstrap: source.bootstrap, runtime: source.runtime });
    expect(load('binary')).toMatchObject({ bootstrap: source.bootstrap, runtime: source.runtime });
  });

  it('reads a user config.toml when present', () => {
    const cfgPath = join(dir, 'config.toml');
    writeFileSync(cfgPath, `
[bootstrap]
bind_port = 9999

[runtime]
"llm.budget" = 12345
"supervisor.mode" = "systemd"
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
    expect(out.runtime['supervisor.mode']).toBe('systemd');
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
"supervisor.mode" = "systemd"
`);
    const out = loadConfig({
      distribution: 'source',
      configPath: cfgPath,
      env: {
        HOME: dir,
        RECUED_BOOTSTRAP_BIND_PORT: '12345',
        RECUED_RUNTIME_SUPERVISOR_MODE: 'launchd',
      },
      argv: [],
    });
    // Bootstrap: env still wins over the file — these fields are needed before
    // any store can be read, so env is the only channel that can carry them.
    expect(out.bootstrap.bind_port).toBe(12345);
    // Runtime: INVERTED 2026-07-28. This used to assert the env value (env
    // beating the file). Runtime env is no longer ingested, so the file — which
    // stands in for what the owner saved through Settings — is what survives.
    // That inversion is the whole point of removing the runtime intake.
    expect(out.runtime['supervisor.mode']).toBe('systemd');
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

  it('loads a config an older install wrote: the removed keys are ignored and named', () => {
    // The [bootstrap] block the VPS cloud-init templates wrote until 2026-10-08,
    // plus a removed key with a value the old parser would have REFUSED: a file
    // like this must still boot after the update.
    const cfgPath = join(dir, 'config.toml');
    writeFileSync(cfgPath, `
[bootstrap]
data_path = "/var/lib/recued"
bind_host = "0.0.0.0"
bind_port = 7717
mcp_port  = "not a port"
webhook_port = 0
log_path = "{data_path}/logs"
`);
    const out = loadConfig({
      distribution: 'server',
      configPath: cfgPath,
      env: { HOME: dir, RECUED_BOOTSTRAP_DATA_PATH: '/var/recued' },
      argv: [],
    });
    // Its `webhook_port = 0` is the old name of the webhook switch: still read.
    expect(out.bootstrap).toEqual({ bind_port: 7717, webhooks_enabled: false });
    expect(out.renamedSettings).toEqual([{
      name: 'bootstrap.webhook_port',
      replacement: expect.stringContaining('read as webhooks_enabled = false'),
    }]);
    expect(out.retiredSettings.map((r) => r.name).sort()).toEqual([
      'RECUED_BOOTSTRAP_DATA_PATH',
      'bootstrap.bind_host',
      'bootstrap.data_path',
      'bootstrap.log_path',
      'bootstrap.mcp_port',
    ]);
    for (const setting of out.retiredSettings) expect(setting.replacement.length).toBeGreaterThan(0);
    // A removed key is not "unrecognised": it gets its own, more useful line.
    expect(out.unknownKeys).toEqual([]);
    expect(out.misplacedKeys).toEqual([]);
  });

  it('names a removed key written outside [bootstrap] as removed, not misplaced', () => {
    const cfgPath = join(dir, 'config.toml');
    writeFileSync(cfgPath, 'data_path = "/srv/recued"\n');
    const out = loadConfig({
      distribution: 'source',
      configPath: cfgPath,
      env: { HOME: dir },
      argv: [],
    });
    expect(out.misplacedKeys).toEqual([]);
    expect(out.retiredSettings.map((r) => r.name)).toEqual(['bootstrap.data_path']);
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
        RECUED_BOOTSTRAP_MCP_PORT: '0',
        RECUED_RUNTIME_LLM_BUDGET: '5',
        UNRELATED_VAR: 'x',
      },
      argv: [],
    });
    // `RECUED_RUNTIME_LLM_BUDGET` is deliberately absent: it was not applied,
    // and a diagnostic that names an inert variable is worse than one that
    // omits it — it would send someone hunting for an override that never
    // happened. So is `RECUED_BOOTSTRAP_MCP_PORT`, removed 2026-10-09: it is
    // reported as removed instead.
    expect(out.envApplied.sort()).toEqual(['RECUED_BOOTSTRAP_BIND_PORT']);
    expect(out.retiredSettings.map((r) => r.name)).toEqual(['RECUED_BOOTSTRAP_MCP_PORT']);
  });

  it('Phase D: the webhook switch is in the runtime schema; the collection defaults are not', () => {
    const out = loadConfig({
      distribution: 'source',
      configPath: join(dir, 'missing.toml'),
      env: { HOME: dir },
      argv: [],
    });
    expect(out.runtime['collection.webhook.public_reachable']).toBe(false);
    // The array form names ONE key: a dotted string would be read as a nested
    // path, which a flat key never matches, so a `.not` would always pass.
    expect(out.runtime).toHaveProperty(['collection.webhook.public_reachable']);
    // Removed 2026-10-10: nothing read them (`RETIRED_RUNTIME_SETTINGS`).
    expect(out.runtime).not.toHaveProperty(['collection.mail.default.quota_bytes']);
    expect(out.runtime).not.toHaveProperty(['collection.file.default.quota_bytes']);
    expect(out.runtime).not.toHaveProperty(['collection.mail.default.retention_days']);
  });

  it('a removed runtime setting in the file is named as removed, never refused', () => {
    const cfgPath = join(dir, 'config.toml');
    // Wrong-typed on purpose: a file an older install wrote must still boot.
    writeFileSync(cfgPath, `
"collection.calendar.gcal.poll_seconds" = 60

[runtime]
"log.level" = 7
"collection.mail.default.quota_bytes" = 1073741824
"no.such.setting" = true
`);
    const out = loadConfig({
      distribution: 'source',
      configPath: cfgPath,
      env: { HOME: dir },
      argv: [],
    });
    expect(out.retiredSettings).toEqual([
      { name: 'runtime.log.level', replacement: "nothing read it; no setting filters the server's log by level" },
      {
        name: 'runtime.collection.mail.default.quota_bytes',
        replacement: "nothing read it; each mail account's own quota_bytes decides, 512 MiB when unset",
      },
      {
        name: 'runtime.collection.calendar.gcal.poll_seconds',
        replacement: "nothing read it; each Google calendar's own poll_seconds decides, 300 when unset",
      },
    ]);
    // Not reported twice: a removed key is not "unrecognised" or "misplaced".
    expect(out.unknownKeys).toEqual(['runtime.no.such.setting']);
    expect(out.misplacedKeys).toEqual([]);
    expect(out.runtime).not.toHaveProperty(['log.level']);
  });

  it('a setting of the retired service installer in the file is named as removed, never refused', () => {
    const cfgPath = join(dir, 'config.toml');
    writeFileSync(cfgPath, `
[runtime]
"collection.service.max_concurrent_invokes" = 8
`);
    const out = loadConfig({
      distribution: 'source',
      configPath: cfgPath,
      env: { HOME: dir },
      argv: [],
    });
    expect(out.retiredSettings).toEqual([{
      name: 'runtime.collection.service.max_concurrent_invokes',
      replacement: 'the service installer it configured was retired',
    }]);
    expect(out.unknownKeys).toEqual([]);
    expect(out.runtime).not.toHaveProperty(['collection.service.max_concurrent_invokes']);
  });
});
