/** D-118 — service contracts tests.
 *
 *  Phase 1 surface: service-platform shared types live in
 *  `packages/contracts/src/service.ts`. These tests exercise the
 *  exported constants, the closed registries, the caps shape, the
 *  status shape, the audit event shape, the rpc enrollment payload
 *  shapes, and the new SERVICE_* error codes.
 *
 *  Runtime behavior tests (installer dispatch, supervisor crash
 *  detection, kernel-ingredient handlers, etc.) land in later
 *  phases. Phase 1 is type-level scaffolding plus a handful of
 *  shape + closed-registry assertions.
 */

import { describe, expect, it } from 'vitest';

import {
  ERR,
  ERROR_MESSAGES,
  SERVER_RPC_METHOD_SET,
  SERVER_RPC_METHODS,
  SERVICE_CHECK_KINDS,
  SERVICE_CONSECUTIVE_CRASHES_MAX,
  SERVICE_CWD_SUBDIR,
  SERVICE_EVENT_NAMES,
  SERVICE_HEALTH_CHECK_INTERVAL_MS_FLOOR,
  SERVICE_INSTALL_KINDS,
  SERVICE_INVOKE_STDOUT_CAP_BYTES,
  SERVICE_MIN_DISK_FREE_BYTES_DEFAULT,
  SERVICE_QUOTA_BYTES_DEFAULT,
  SERVICE_RESTART_BACKOFF_MS,
  SERVICE_RESTART_POLICIES,
  SERVICE_STARTUP_GRACE_MS_DEFAULT,
  defaultErrorMessage,
  type CollectionCaps,
  type CollectionPlatform,
  type RecipeErrorCode,
  type ServiceAuditEvent,
  type ServiceCheckKind,
  type ServiceCheckResult,
  type ServiceCollectionCaps,
  type ServiceCollectionHealth,
  type ServiceEnrollInput,
  type ServiceEnrollOutput,
  type ServiceEventName,
  type ServiceHealthState,
  type ServiceInstallKind,
  type ServiceInstallOutput,
  type ServiceInstanceList,
  type ServiceInstanceListRow,
  type ServiceRestartPolicy,
  type ServiceState,
  type ServiceStatus,
} from '../index.js';

describe('SERVICE_INSTALL_KINDS', () => {
  it('enumerates exactly the nine closed install kinds', () => {
    expect(SERVICE_INSTALL_KINDS).toEqual([
      'brew',
      'scoop',
      'winget',
      'npm',
      'pip',
      'cargo',
      'go_install',
      'docker_pull',
      'download',
    ]);
  });

  it('explicitly excludes system package managers (sudo-required)', () => {
    // Decision #4 — apt / yum / dnf / pacman / zypper / apk would
    // require running recued-server as root. Hard no.
    const sysPMs = ['apt', 'yum', 'dnf', 'pacman', 'zypper', 'apk'];
    for (const pm of sysPMs) {
      expect((SERVICE_INSTALL_KINDS as readonly string[])).not.toContain(pm);
    }
  });

  it('every kind matches the ServiceInstallKind type', () => {
    const sample: ServiceInstallKind = 'brew';
    expect(SERVICE_INSTALL_KINDS).toContain(sample);
  });
});

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

describe('SERVICE_EVENT_NAMES', () => {
  it('covers enrollment, install, lifecycle, invoke, and failure surfaces', () => {
    // Spec line 168-173 — eleven event names. Drift here breaks
    // service-logs filtering.
    expect(SERVICE_EVENT_NAMES).toEqual([
      'enrolled',
      'uninstalled',
      'installed',
      'upgraded',
      'started',
      'stopped',
      'crashed',
      'invoked',
      'health_changed',
      'install_failed',
      'upgrade_failed',
    ]);
  });

  it('event name is assignable from ServiceEventName', () => {
    const evt: ServiceEventName = 'crashed';
    expect(SERVICE_EVENT_NAMES).toContain(evt);
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

describe('Service constants', () => {
  it('startup grace defaults to 15 seconds', () => {
    expect(SERVICE_STARTUP_GRACE_MS_DEFAULT).toBe(15_000);
  });

  it('health-check interval floor is 10 seconds', () => {
    // Floor below this would turn health checks into a liveness probe.
    expect(SERVICE_HEALTH_CHECK_INTERVAL_MS_FLOOR).toBe(10_000);
  });

  it('invoke stdout cap is exactly 1 MiB', () => {
    expect(SERVICE_INVOKE_STDOUT_CAP_BYTES).toBe(1_048_576);
  });

  it('OS free-space gate defaults to 1 GiB', () => {
    expect(SERVICE_MIN_DISK_FREE_BYTES_DEFAULT).toBe(1_073_741_824);
  });

  it('per-instance quota defaults to 5 GiB', () => {
    expect(SERVICE_QUOTA_BYTES_DEFAULT).toBe(5_368_709_120);
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

  it('cwd subdirectory is "services"', () => {
    expect(SERVICE_CWD_SUBDIR).toBe('services');
  });
});

describe('CollectionPlatform union', () => {
  it('includes service alongside the prior four platforms', () => {
    const platforms: CollectionPlatform[] = [
      'mail',
      'file',
      'webhook',
      'calendar',
      'service',
    ];
    expect(platforms.length).toBe(5);
  });
});

describe('ServiceCollectionCaps', () => {
  const toolCaps: ServiceCollectionCaps = {
    install: 'yes',
    upgrade: 'yes',
    uninstall: 'yes',
    start: 'no',
    stop: 'no',
    invoke: ['convert', 'probe'],
    health: 'install_check',
    restart: 'never',
  };

  const serviceCaps: ServiceCollectionCaps = {
    install: 'yes',
    upgrade: 'yes',
    uninstall: 'yes',
    start: 'yes',
    stop: 'yes',
    invoke: ['pull', 'list_models'],
    health: 'http_ok',
    restart: 'on-crash',
  };

  it('tool-shaped caps disable start/stop and alias health to install_check', () => {
    expect(toolCaps.start).toBe('no');
    expect(toolCaps.stop).toBe('no');
    expect(toolCaps.health).toBe('install_check');
  });

  it('service-shaped caps enable start/stop with restart policy', () => {
    expect(serviceCaps.start).toBe('yes');
    expect(serviceCaps.restart).toBe('on-crash');
  });

  it('install: hint_only is a legal third state for hint-only templates', () => {
    const hintOnly: ServiceCollectionCaps = {
      ...toolCaps,
      install: 'hint_only',
    };
    expect(hintOnly.install).toBe('hint_only');
  });

  it('invoke list can be empty (rare service templates)', () => {
    const noInvoke: ServiceCollectionCaps = { ...serviceCaps, invoke: [] };
    expect(noInvoke.invoke).toEqual([]);
  });

  it('caps assign into the unioned CollectionCaps shape', () => {
    const wide: CollectionCaps = serviceCaps;
    expect((wide as ServiceCollectionCaps).restart).toBe('on-crash');
  });
});

describe('ServiceStatus', () => {
  it('stopped instance carries null pid and uptime', () => {
    const stopped: ServiceStatus = {
      state: 'stopped',
      health: 'unknown',
      pid: null,
      started_at: null,
      uptime_s: null,
      last_crash_at: null,
      consecutive_crashes: 0,
      config: {},
      exposes: {},
    };
    expect(stopped.pid).toBeNull();
    expect(stopped.uptime_s).toBeNull();
  });

  it('running instance carries pid + started_at + computed uptime', () => {
    const running: ServiceStatus = {
      state: 'running',
      health: 'healthy',
      pid: 12_345,
      started_at: 1_700_000_000_000,
      uptime_s: 42,
      last_crash_at: null,
      consecutive_crashes: 0,
      config: { port: 11434 },
      exposes: { endpoint: 'http://127.0.0.1:11434' },
    };
    expect(running.pid).toBe(12_345);
    expect(running.exposes.endpoint).toContain('11434');
  });

  it('permanently_crashed surfaces the consecutive crash ceiling', () => {
    const crashed: ServiceStatus = {
      state: 'permanently_crashed',
      health: 'unknown',
      pid: null,
      started_at: null,
      uptime_s: null,
      last_crash_at: 1_700_000_000_000,
      consecutive_crashes: SERVICE_CONSECUTIVE_CRASHES_MAX,
      config: {},
      exposes: {},
    };
    expect(crashed.consecutive_crashes).toBe(5);
  });

  it('state and health unions enumerate every legal value', () => {
    const states: ServiceState[] = [
      'running',
      'stopped',
      'crashed',
      'permanently_crashed',
      'unknown',
    ];
    const healths: ServiceHealthState[] = ['healthy', 'unhealthy', 'unknown'];
    expect(states.length).toBe(5);
    expect(healths.length).toBe(3);
  });
});

describe('ServiceCollectionHealth', () => {
  it('rides on the service platform discriminator', () => {
    const health: ServiceCollectionHealth = {
      platform: 'service',
      slug: 'ollama_home',
      last_indexed_at: 1_700_000_000_000,
      pending_queue_size: 0,
      error_count_24h: 0,
      state: 'connected',
      auth_state: 'healthy',
      service_state: 'running',
      pid: 4242,
      uptime_s: 600,
      last_crash_at: null,
      consecutive_crashes: 0,
    };
    expect(health.platform).toBe('service');
    expect(health.service_state).toBe('running');
  });

  it('unhealthy run carries the rolling 24h error counter', () => {
    const health: ServiceCollectionHealth = {
      platform: 'service',
      slug: 'tunnel',
      last_indexed_at: 0,
      pending_queue_size: 0,
      error_count_24h: 3,
      state: 'error',
      service_state: 'crashed',
      pid: null,
      uptime_s: null,
      last_crash_at: 1_700_000_000_000,
      consecutive_crashes: 2,
    };
    expect(health.error_count_24h).toBe(3);
    expect(health.consecutive_crashes).toBe(2);
  });
});

describe('ServiceAuditEvent', () => {
  it('records a successful install with argv + null error', () => {
    const evt: ServiceAuditEvent = {
      type: 'service_event',
      slug: 'ollama_home',
      binary: 'ollama',
      event_name: 'installed',
      argv: ['brew', 'install', 'ollama'],
      error: null,
      timestamp: 1_700_000_000_000,
    };
    expect(evt.event_name).toBe('installed');
    expect(evt.error).toBeNull();
  });

  it('records a crash with the failure detail in error', () => {
    const evt: ServiceAuditEvent = {
      type: 'service_event',
      slug: 'ollama_home',
      binary: 'ollama',
      event_name: 'crashed',
      argv: ['ollama', 'serve'],
      error: 'exit code 137 (SIGKILL)',
      timestamp: 1_700_000_000_000,
    };
    expect(evt.event_name).toBe('crashed');
    expect(evt.error).toContain('137');
  });

  it('purely informational events carry null argv', () => {
    const evt: ServiceAuditEvent = {
      type: 'service_event',
      slug: 'ollama_home',
      binary: null,
      event_name: 'health_changed',
      argv: null,
      error: null,
      timestamp: 1_700_000_000_000,
    };
    expect(evt.argv).toBeNull();
  });
});

describe('ServiceEnroll payload shapes', () => {
  it('enroll input carries slug + template + config', () => {
    const input: ServiceEnrollInput = {
      slug: 'ollama_home',
      template_slug: 'ollama-macos@1.0.0',
      config: { port: 11434 },
    };
    expect(input.template_slug).toBe('ollama-macos@1.0.0');
  });

  it('enroll output dispatches install / hint / ready via two flags', () => {
    const ready: ServiceEnrollOutput = {
      slug: 'ollama_home',
      install_check: { passed: true },
      install_available: true,
      caps: {
        install: 'yes',
        upgrade: 'yes',
        uninstall: 'yes',
        start: 'yes',
        stop: 'yes',
        invoke: [],
        health: 'http_ok',
        restart: 'on-crash',
      },
    };
    // install_check.passed = true → UI skips install; the next user
    // action is "Start now?".
    expect(ready.install_check.passed).toBe(true);
  });

  it('enroll output carries install_hint path when install[] is null', () => {
    const hintOnly: ServiceEnrollOutput = {
      slug: 'ffmpeg_local',
      install_check: { passed: false, detail: 'binary not in PATH' },
      install_available: false,
      caps: {
        install: 'hint_only',
        upgrade: 'no',
        uninstall: 'no',
        start: 'no',
        stop: 'no',
        invoke: ['convert'],
        health: 'install_check',
        restart: 'never',
      },
    };
    expect(hintOnly.install_available).toBe(false);
    expect(hintOnly.caps.install).toBe('hint_only');
  });
});

describe('ServiceInstallOutput', () => {
  it('captures exit code + post-install check + truncated log', () => {
    const out: ServiceInstallOutput = {
      slug: 'ollama_home',
      exit_code: 0,
      install_check: { passed: true },
      log_lines: ['Resolving dependencies...', 'Installed ollama 0.1.32'],
    };
    expect(out.exit_code).toBe(0);
    expect(out.install_check.passed).toBe(true);
    expect(out.log_lines.length).toBe(2);
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

describe('ServiceInstanceList', () => {
  it('row carries the per-instance summary view', () => {
    const row: ServiceInstanceListRow = {
      slug: 'ollama_home',
      template_slug: 'ollama-macos@1.0.0',
      state: 'running',
      health: 'healthy',
      caps: {
        install: 'yes',
        upgrade: 'yes',
        uninstall: 'yes',
        start: 'yes',
        stop: 'yes',
        invoke: ['pull'],
        health: 'http_ok',
        restart: 'on-crash',
      },
    };
    const list: ServiceInstanceList = { instances: [row] };
    expect(list.instances[0].slug).toBe('ollama_home');
  });
});

describe('SERVICE_* error codes', () => {
  const codes: RecipeErrorCode[] = [
    'SERVICE_NOT_FOUND',
    'SERVICE_TEMPLATE_UNAVAILABLE',
    'SERVICE_PLATFORM_MISMATCH',
    'SERVICE_INSTALL_UNAVAILABLE',
    'SERVICE_INSTALL_FAILED',
    'SERVICE_UPGRADE_FAILED',
    'SERVICE_UNINSTALL_FAILED',
    'SERVICE_ALREADY_RUNNING',
    'SERVICE_NOT_RUNNING',
    'SERVICE_PERMANENTLY_CRASHED',
    'SERVICE_OP_NOT_SUPPORTED',
    'SERVICE_INPUT_INVALID',
    'SERVICE_STORAGE_PRESSURE',
    'SERVICE_HEALTH_TIMEOUT',
    'SERVICE_CHECK_FAILED',
    'SERVICE_DOWNLOAD_SHA_MISMATCH',
  ];

  it('every spec-declared code has a severity entry', () => {
    for (const code of codes) {
      expect(ERR[code]).toBeDefined();
    }
  });

  it('every spec-declared code has a user-facing message', () => {
    for (const code of codes) {
      expect(ERROR_MESSAGES[code]).toBeTruthy();
      expect(ERROR_MESSAGES[code]).not.toBe(code);
    }
  });

  it('defaultErrorMessage resolves SERVICE_* codes without falling back', () => {
    for (const code of codes) {
      const msg = defaultErrorMessage(code);
      expect(msg).not.toContain('Recipe stopped');
    }
  });

  it('SHA mismatch + platform mismatch are fatal (cannot retry without changes)', () => {
    expect(ERR.SERVICE_DOWNLOAD_SHA_MISMATCH).toBe('fatal');
    expect(ERR.SERVICE_PLATFORM_MISMATCH).toBe('fatal');
  });

  it('SERVICE_ALREADY_RUNNING is a warn (non-error variant per spec)', () => {
    // service-start against a running instance returns the current
    // status with this code — a soft signal, not a failure.
    expect(ERR.SERVICE_ALREADY_RUNNING).toBe('warn');
  });
});

describe('collection.service.* rpc registry', () => {
  it('every spec-declared service rpc is in SERVER_RPC_METHODS', () => {
    const rpcs = [
      'collection.service.list',
      'collection.service.listTemplates',
      'collection.service.enroll',
      'collection.service.install',
      'collection.service.upgrade',
      'collection.service.uninstall',
      'collection.service.update',
      'collection.service.delete',
      'collection.service.clear_crash',
      'collection.service.start',
      'collection.service.stop',
      'collection.service.restart',
    ];
    for (const rpc of rpcs) {
      expect(SERVER_RPC_METHOD_SET.has(rpc)).toBe(true);
    }
  });

  it('SERVER_RPC_METHODS exposes the full service surface (12 entries — Phase 10 follow-up adds listTemplates + start/stop/restart)', () => {
    const serviceMethods = (SERVER_RPC_METHODS as readonly string[]).filter(
      (m) => m.startsWith('collection.service.'),
    );
    expect(serviceMethods.length).toBe(12);
  });
});
