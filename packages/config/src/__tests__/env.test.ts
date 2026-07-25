import { describe, expect, it } from 'vitest';
import { envConfigPath, envOverrides } from '../env.js';

describe('env overrides', () => {
  describe('envConfigPath', () => {
    it('returns RECUED_CONFIG when set', () => {
      expect(envConfigPath({ RECUED_CONFIG: '/tmp/c.toml' })).toBe('/tmp/c.toml');
    });

    it('returns undefined when absent or empty', () => {
      expect(envConfigPath({})).toBeUndefined();
      expect(envConfigPath({ RECUED_CONFIG: '' })).toBeUndefined();
    });
  });

  describe('envOverrides', () => {
    it('maps RECUED_RUNTIME_* into dotted runtime keys', () => {
      const out = envOverrides({
        RECUED_RUNTIME_LLM_BUDGET: '1500',
        RECUED_RUNTIME_LOG_LEVEL: 'warn',
      });
      expect(out.runtime).toEqual({
        'llm.budget': 1500,
        'log.level': 'warn',
      });
    });

    it('maps RECUED_BOOTSTRAP_* into bootstrap keys with type coercion', () => {
      const out = envOverrides({
        RECUED_BOOTSTRAP_BIND_PORT: '8080',
        RECUED_BOOTSTRAP_BIND_HOST: '0.0.0.0',
        RECUED_BOOTSTRAP_DATA_PATH: '/var/lib/recued',
      });
      expect(out.bootstrap).toEqual({
        bind_port: 8080,
        bind_host: '0.0.0.0',
        data_path: '/var/lib/recued',
      });
    });

    it('coerces boolean env values', () => {
      const out = envOverrides({ RECUED_RUNTIME_LLM_ALLOW_UPGRADE_DEFAULT: 'true' });
      expect(out.runtime['llm.allow_upgrade_default']).toBe(true);
      const out2 = envOverrides({ RECUED_RUNTIME_LLM_ALLOW_UPGRADE_DEFAULT: '0' });
      expect(out2.runtime['llm.allow_upgrade_default']).toBe(false);
    });

    it('throws when a boolean env value is neither true/false nor 0/1', () => {
      expect(() =>
        envOverrides({ RECUED_RUNTIME_LLM_ALLOW_UPGRADE_DEFAULT: 'yes' }),
      ).toThrow(/must be true\/false/);
    });

    it('throws when a numeric env value is not numeric', () => {
      expect(() => envOverrides({ RECUED_RUNTIME_LLM_BUDGET: 'lots' })).toThrow(
        /must be numeric/,
      );
    });

    it('throws when an enum env value is not a member', () => {
      expect(() =>
        envOverrides({ RECUED_RUNTIME_LLM_FREE_POOL_STRATEGY: 'uniform' }),
      ).toThrow(/must be one of/);
    });

    it('throws when bootstrap port is out of range', () => {
      expect(() => envOverrides({ RECUED_BOOTSTRAP_BIND_PORT: '99999' })).toThrow(
        /integer in \[0, 65535\]/,
      );
    });

    it('ignores unknown RECUED_* env vars', () => {
      const out = envOverrides({
        RECUED_SOMETHING_ELSE: 'x',
        RECUED_RUNTIME_NOT_A_KEY: 'y',
      });
      expect(out.runtime).toEqual({});
      expect(out.bootstrap).toEqual({});
    });
  });
});
