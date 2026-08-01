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

    // ── RECUED_RUNTIME_* is no longer ingested (2026-07-28) ──────────
    //
    // Five tests died here with the feature: the runtime key mapping, boolean
    // coercion, and the boolean/numeric/enum coercion throws. All of them
    // exercised the runtime branch only — bootstrap coercion and its
    // out-of-range throw are covered separately below, so nothing they
    // asserted is left untested. What replaces them is the inverse claim.

    it('IGNORES RECUED_RUNTIME_* — a runtime key cannot be set from env', () => {
      // ⚠ Uses REAL schema keys on purpose. A made-up key would be dropped by
      // the unknown-key filter and pass just as happily with the runtime branch
      // still wired, which would make this guard worthless.
      const out = envOverrides({
        RECUED_RUNTIME_LLM_BUDGET: '1500',
        RECUED_RUNTIME_LOG_LEVEL: 'warn',
        RECUED_RUNTIME_PRIVACY_AUTO_PII_PROTECTION: 'false',
      });
      expect(out).toEqual({ bootstrap: {} });
      expect('runtime' in out).toBe(false);
    });

    it('does not THROW on a malformed runtime env value — it is simply not read', () => {
      // The old code coerced and threw here. Silence is now correct: the value
      // is never consulted, so failing the boot over its shape would be a lie
      // about what the server did with it.
      expect(() => envOverrides({ RECUED_RUNTIME_LLM_BUDGET: 'lots' })).not.toThrow();
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
      expect(out.bootstrap).toEqual({});
    });
  });
});
