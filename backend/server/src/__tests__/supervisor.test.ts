import { describe, it, expect } from 'vitest';
import {
  resolveSupervisorMode,
  createSupervisor,
  nativeSupervisor,
  systemdSupervisor,
  launchdSupervisor,
  dockerSupervisor,
  dockerThinSupervisor,
  devSupervisor,
  type Supervisor,
} from '../lifecycle/supervisor.js';
import type { ResolvedSupervisorMode } from '@recued/contracts';

describe('per-mode exit-code handoff', () => {
  it('native/systemd/launchd follow the standard table', () => {
    for (const s of [nativeSupervisor, systemdSupervisor, launchdSupervisor]) {
      expect(s.handoff('shutdown')).toBe(0);
      expect(s.handoff('crash')).toBe(1);
      expect(s.handoff('restart')).toBe(3);
      expect(s.handoff('lock_held')).toBe(4);
    }
  });

  it('docker remaps restart→1 but keeps crash/shutdown/lock_held', () => {
    expect(dockerSupervisor.handoff('shutdown')).toBe(0);
    expect(dockerSupervisor.handoff('crash')).toBe(1);
    expect(dockerSupervisor.handoff('restart')).toBe(1);   // remap
    expect(dockerSupervisor.handoff('lock_held')).toBe(4);
  });

  it('docker-thin keeps the STANDARD table (no restart→1 remap — the launcher distinguishes)', () => {
    expect(dockerThinSupervisor.handoff('shutdown')).toBe(0);
    expect(dockerThinSupervisor.handoff('crash')).toBe(1);
    expect(dockerThinSupervisor.handoff('restart')).toBe(3);   // NOT remapped
    expect(dockerThinSupervisor.handoff('lock_held')).toBe(4);
  });

  it('resolves an explicit docker-thin override', () => {
    expect(resolveSupervisorMode('auto', { env: { RECUED_SUPERVISOR_MODE: 'docker-thin' } })).toBe('docker-thin');
  });

  it('dev collapses every intent to 0', () => {
    expect(devSupervisor.handoff('shutdown')).toBe(0);
    expect(devSupervisor.handoff('crash')).toBe(0);
    expect(devSupervisor.handoff('restart')).toBe(0);
    expect(devSupervisor.handoff('lock_held')).toBe(0);
  });
});

describe('dev guidance messages', () => {
  it('returns a message for restart', () => {
    const msg = devSupervisor.guidanceFor?.('restart');
    expect(msg).toMatch(/restart.*dev mode|re-run/);
  });

  it('returns a message for lock_held', () => {
    const msg = devSupervisor.guidanceFor?.('lock_held');
    expect(msg).toMatch(/lock|data_path/i);
  });

  it('returns undefined for shutdown/crash (no user message needed)', () => {
    expect(devSupervisor.guidanceFor?.('shutdown')).toBeUndefined();
    expect(devSupervisor.guidanceFor?.('crash')).toBeUndefined();
  });

  it('non-dev modes do not provide guidance', () => {
    for (const s of [nativeSupervisor, systemdSupervisor, launchdSupervisor, dockerSupervisor, dockerThinSupervisor]) {
      expect(s.guidanceFor).toBeUndefined();
    }
  });
});

describe('resolveSupervisorMode — explicit overrides', () => {
  it('RECUED_SUPERVISOR_MODE wins over everything else', () => {
    const mode = resolveSupervisorMode('auto', {
      env: { RECUED_SUPERVISOR_MODE: 'launchd', INVOCATION_ID: '1234' },
    });
    expect(mode).toBe('launchd');
  });

  it('invalid env override falls through to detection', () => {
    const mode = resolveSupervisorMode('auto', {
      env: { RECUED_SUPERVISOR_MODE: 'nonsense', INVOCATION_ID: '1234' },
    });
    expect(mode).toBe('systemd');
  });

  it('explicit config (non-auto) wins over env detection', () => {
    const mode = resolveSupervisorMode('dev', {
      env: { INVOCATION_ID: '1234' },
    });
    expect(mode).toBe('dev');
  });

  it('env override beats explicit config', () => {
    const mode = resolveSupervisorMode('dev', {
      env: { RECUED_SUPERVISOR_MODE: 'native' },
    });
    expect(mode).toBe('native');
  });
});

describe('resolveSupervisorMode — environment detection', () => {
  it('INVOCATION_ID → systemd', () => {
    expect(
      resolveSupervisorMode('auto', {
        env: { INVOCATION_ID: 'abcd1234' },
        dockerEnvExists: () => false,
      }),
    ).toBe('systemd');
  });

  it('XPC_SERVICE_NAME starting with com.recued. → launchd', () => {
    expect(
      resolveSupervisorMode('auto', {
        env: { XPC_SERVICE_NAME: 'com.recued.daemon' },
        dockerEnvExists: () => false,
      }),
    ).toBe('launchd');
  });

  it('XPC_SERVICE_NAME with other prefix does not trigger launchd', () => {
    expect(
      resolveSupervisorMode('auto', {
        env: { XPC_SERVICE_NAME: 'com.apple.other' },
        dockerEnvExists: () => false,
      }),
    ).toBe('dev');
  });

  it('/.dockerenv file → docker', () => {
    expect(
      resolveSupervisorMode('auto', {
        env: {},
        dockerEnvExists: () => true,
      }),
    ).toBe('docker');
  });

  it('container=docker env → docker', () => {
    expect(
      resolveSupervisorMode('auto', {
        env: { container: 'docker' },
        dockerEnvExists: () => false,
      }),
    ).toBe('docker');
  });

  it('RECUED_LAUNCHER=1 → native', () => {
    expect(
      resolveSupervisorMode('auto', {
        env: { RECUED_LAUNCHER: '1' },
        dockerEnvExists: () => false,
      }),
    ).toBe('native');
  });

  it('no signatures → dev fallback', () => {
    expect(
      resolveSupervisorMode('auto', {
        env: {},
        dockerEnvExists: () => false,
      }),
    ).toBe('dev');
  });

  it('systemd beats launchd when both signatures present (precedence)', () => {
    expect(
      resolveSupervisorMode('auto', {
        env: {
          INVOCATION_ID: 'abcd',
          XPC_SERVICE_NAME: 'com.recued.daemon',
        },
        dockerEnvExists: () => false,
      }),
    ).toBe('systemd');
  });

  it('launchd beats docker when both signatures present', () => {
    expect(
      resolveSupervisorMode('auto', {
        env: { XPC_SERVICE_NAME: 'com.recued.daemon', container: 'docker' },
        dockerEnvExists: () => true,
      }),
    ).toBe('launchd');
  });
});

describe('createSupervisor', () => {
  it('returns the right impl for every resolved mode', () => {
    const modes: ResolvedSupervisorMode[] = ['native', 'systemd', 'launchd', 'docker', 'dev'];
    for (const m of modes) {
      const s: Supervisor = createSupervisor(m);
      expect(s.mode).toBe(m);
    }
  });

  it('returned supervisors are the exported singletons', () => {
    expect(createSupervisor('native')).toBe(nativeSupervisor);
    expect(createSupervisor('systemd')).toBe(systemdSupervisor);
    expect(createSupervisor('launchd')).toBe(launchdSupervisor);
    expect(createSupervisor('docker')).toBe(dockerSupervisor);
    expect(createSupervisor('dev')).toBe(devSupervisor);
  });
});
