import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseToml } from '../parse.js';
import { writeConfigField } from '../write.js';

describe('writeConfigField', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'recued-cfg-write-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates a new file when none exists', () => {
    const path = join(dir, 'config.toml');
    writeConfigField({
      path,
      section: 'runtime',
      key: 'llm.budget',
      value: 2500,
    });
    const { parsed } = parseToml(readFileSync(path, 'utf8'));
    expect(parsed.runtime['llm.budget']).toBe(2500);
  });

  it('updates an existing file in place', () => {
    const path = join(dir, 'config.toml');
    writeFileSync(path, `
[runtime]
"llm.budget" = 100
"log.level" = "info"
`);
    writeConfigField({
      path,
      section: 'runtime',
      key: 'log.level',
      value: 'warn',
    });
    const { parsed } = parseToml(readFileSync(path, 'utf8'));
    expect(parsed.runtime['log.level']).toBe('warn');
    expect(parsed.runtime['llm.budget']).toBe(100); // untouched
  });

  it('validates against the schema', () => {
    const path = join(dir, 'config.toml');
    expect(() =>
      writeConfigField({
        path,
        section: 'runtime',
        key: 'llm.budget',
        value: -1,
      }),
    ).toThrow(/>= 0/);
    expect(() =>
      writeConfigField({
        path,
        section: 'runtime',
        key: 'llm.free_pool_strategy',
        value: 'uniform',
      }),
    ).toThrow(/must be one of/);
  });

  it('rejects unknown runtime keys', () => {
    expect(() =>
      writeConfigField({
        path: join(dir, 'config.toml'),
        section: 'runtime',
        key: 'made.up',
        value: 1,
      }),
    ).toThrow(/Unknown runtime key/);
    expect(() =>
      writeConfigField({
        path: join(dir, 'config.toml'),
        section: 'runtime',
        key: 'constructor',
        value: 'polluted',
      }),
    ).toThrow(/Unknown runtime key/);
  });

  it('can also write bootstrap fields (no schema validation there)', () => {
    const path = join(dir, 'config.toml');
    writeConfigField({
      path,
      section: 'bootstrap',
      key: 'bind_port',
      value: 7500,
    });
    const { parsed } = parseToml(readFileSync(path, 'utf8'));
    expect(parsed.bootstrap.bind_port).toBe(7500);
  });

  it('writes atomically — no temp file leaks on success', () => {
    const path = join(dir, 'config.toml');
    writeConfigField({ path, section: 'runtime', key: 'llm.budget', value: 1 });
    const fs = require('node:fs') as typeof import('node:fs');
    const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });
});
