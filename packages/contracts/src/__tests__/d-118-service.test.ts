/** D-118 — the service vocabulary that outlived the service installer.
 *
 *  The installer (`collection.service.*`, `data.service.*` instances, `kind:
 *  service` templates) was retired on 2026-10-10 (D-321 § 5.4): nothing could
 *  reach it. What `service.ts` still exports is what the cli-daemon supervision
 *  (D-170) shares with it: the closed check-kind and restart-policy registries,
 *  the crash ceiling and backoff, and the check result. These pin that, and that
 *  the installer's rpcs and error codes are gone rather than left behind.
 */

import { describe, expect, it } from 'vitest';

import {
  ERR,
  ERROR_MESSAGES,
  SERVER_RPC_METHODS,
  SERVICE_CHECK_KINDS,
  SERVICE_CONSECUTIVE_CRASHES_MAX,
  SERVICE_HEALTH_CHECK_INTERVAL_MS_FLOOR,
  SERVICE_RESTART_BACKOFF_MS,
  SERVICE_RESTART_POLICIES,
  type ServiceCheckKind,
  type ServiceCheckResult,
  type ServiceRestartPolicy,
} from '../index.js';

describe('SERVICE_CHECK_KINDS', () => {
  it('enumerates exactly the six closed check kinds', () => {
    expect(SERVICE_CHECK_KINDS).toEqual([
      'binary_in_path',
      'file_exists',
      'http_ok',
      'tcp_open',
      'pid_file',
      'exec_ok',
    ]);
  });

  it('every kind matches the ServiceCheckKind type', () => {
    const sample: ServiceCheckKind = 'binary_in_path';
    expect(SERVICE_CHECK_KINDS).toContain(sample);
  });
});

describe('SERVICE_RESTART_POLICIES', () => {
  it('covers never / on-crash / always', () => {
    expect(SERVICE_RESTART_POLICIES).toEqual(['never', 'on-crash', 'always']);
  });

  it('matches the ServiceRestartPolicy type', () => {
    const policy: ServiceRestartPolicy = 'on-crash';
    expect(SERVICE_RESTART_POLICIES).toContain(policy);
  });
});

describe('the supervision constants', () => {
  it('health-check interval floor is 10 seconds', () => {
    // Floor below this would turn health checks into a liveness probe.
    expect(SERVICE_HEALTH_CHECK_INTERVAL_MS_FLOOR).toBe(10_000);
  });

  it('consecutive crash ceiling matches decision #12', () => {
    // Five consecutive crashes → permanently_crashed.
    expect(SERVICE_CONSECUTIVE_CRASHES_MAX).toBe(5);
  });

  it('restart backoff escalates 1s → 5s → 30s → 2min → 10min', () => {
    expect(SERVICE_RESTART_BACKOFF_MS).toEqual([
      1_000,
      5_000,
      30_000,
      120_000,
      600_000,
    ]);
  });

  it('backoff length matches the consecutive-crashes ceiling', () => {
    // The Nth crash uses backoff[N-1]; the ceiling triggers
    // permanently_crashed before the next backoff would be needed.
    expect(SERVICE_RESTART_BACKOFF_MS.length).toBe(SERVICE_CONSECUTIVE_CRASHES_MAX);
  });
});

describe('ServiceCheckResult', () => {
  it('passing check needs only the boolean', () => {
    const passed: ServiceCheckResult = { passed: true };
    expect(passed.detail).toBeUndefined();
  });

  it('failing check carries the structured detail', () => {
    const failed: ServiceCheckResult = {
      passed: false,
      detail: 'tcp connect to 127.0.0.1:11434 refused',
    };
    expect(failed.detail).toContain('refused');
  });
});

describe('the retired installer', () => {
  it('has no rpc left in SERVER_RPC_METHODS', () => {
    expect((SERVER_RPC_METHODS as readonly string[]).filter((m) => m.startsWith('collection.service.')))
      .toEqual([]);
  });

  it('has no error code left', () => {
    expect(Object.keys(ERR).filter((code) => code.startsWith('SERVICE_'))).toEqual([]);
    expect(Object.keys(ERROR_MESSAGES).filter((code) => code.startsWith('SERVICE_'))).toEqual([]);
  });
});
