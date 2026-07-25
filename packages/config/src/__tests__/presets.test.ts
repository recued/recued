import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseToml } from '../parse.js';
import { BOOTSTRAP_TEMPLATE, presetOverlay } from '../presets.js';

describe('presets', () => {
  it('exposes overlays for all three distributions', () => {
    expect(presetOverlay('binary').bootstrap.bind_host).toBe('127.0.0.1');
    expect(presetOverlay('source').runtime['log.level']).toBe('debug');
    expect(presetOverlay('server').bootstrap.bind_host).toBe('0.0.0.0');
  });

  it('BOOTSTRAP_TEMPLATE establishes a safe localhost baseline', () => {
    expect(BOOTSTRAP_TEMPLATE.bind_host).toBe('127.0.0.1');
    expect(BOOTSTRAP_TEMPLATE.webhook_port).toBe(0);
  });

  for (const name of ['binary', 'source', 'server'] as const) {
    it(`bundled ${name}.toml parses clean against the schema`, () => {
      const path = join(__dirname, '..', 'presets', `${name}.toml`);
      const src = readFileSync(path, 'utf8');
      const { parsed, unknown } = parseToml(src);
      expect(unknown).toEqual([]);
      expect(parsed.bootstrap.bind_port).toBe(7717);
      // Every preset enumerates every runtime key so a fresh install
      // doesn't rely on the schema defaults.
      expect(parsed.runtime['llm.allow_upgrade_default']).toBe(false);
      expect(parsed.runtime['vault.quota.per_publisher_bytes']).toBe(1048576);
    });
  }
});
