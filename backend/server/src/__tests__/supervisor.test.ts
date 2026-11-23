import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  childOfInstallSupervisor,
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
    // Names the data folder, not `data_path` — a setting removed on 2026-10-09.
    expect(msg).toMatch(/already owns this data folder/);
    expect(msg).toContain('--db');
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

describe('resolveSupervisorMode — the install supervisor on macOS', () => {
  // launchd gives every LaunchAgent `XPC_SERVICE_NAME=0`, which is what a real
  // macOS install's server sees.
  const env = { XPC_SERVICE_NAME: '0' };

  it('a child of the install\'s recued-supervise is launchd on macOS', () => {
    expect(resolveSupervisorMode('auto', {
      env, dockerEnvExists: () => false, platform: 'darwin', childOfInstallSupervisor: () => true,
    })).toBe('launchd');
  });

  it('is dev without that parent: XPC_SERVICE_NAME=0 says nothing', () => {
    expect(resolveSupervisorMode('auto', {
      env, dockerEnvExists: () => false, platform: 'darwin', childOfInstallSupervisor: () => false,
    })).toBe('dev');
  });

  it('is not consulted off macOS, where systemd names itself', () => {
    expect(resolveSupervisorMode('auto', {
      env: {}, dockerEnvExists: () => false, platform: 'linux', childOfInstallSupervisor: () => true,
    })).toBe('dev');
    expect(resolveSupervisorMode('auto', {
      env: { INVOCATION_ID: 'abcd' }, dockerEnvExists: () => false, platform: 'linux',
      childOfInstallSupervisor: () => true,
    })).toBe('systemd');
  });
});

describe('childOfInstallSupervisor', () => {
  const install = '/Users/owner/.local/lib/recued';
  const probe = (command: string | null, execPath = `${install}/recued`,
    realpath: (path: string) => string = (path) => path) =>
    childOfInstallSupervisor({ execPath, parentPid: 4242, readCommand: () => command, realpath });

  it('matches the script beside the running binary, as /bin/sh runs it', () => {
    expect(probe(`/bin/sh ${install}/recued-supervise serve --require-enrolled`)).toBe(true);
  });

  it('matches through spaces and symlinks in the install path', () => {
    expect(probe('/bin/sh /Users/o/My Apps/recued/recued-supervise serve',
      '/Users/o/My Apps/recued/recued')).toBe(true);
    expect(probe('/bin/sh /opt/link/recued-supervise serve', '/opt/real/recued',
      (path) => path.replace('/opt/link', '/opt/real'))).toBe(true);
  });

  it('refuses another install\'s supervisor, a look-alike name, launchd itself or an unreadable parent', () => {
    expect(probe('/bin/sh /opt/other/recued-supervise serve')).toBe(false);
    expect(probe(`/bin/sh ${install}/recued-supervise-old serve`)).toBe(false);
    expect(probe('/sbin/launchd')).toBe(false);
    expect(probe(null)).toBe(false);
  });

  for (const path of ['inherited', 'empty'] as const) {
    it.runIf(process.platform === 'darwin' || process.platform === 'linux')(
      `reads a real parent through ps (${path} PATH)`,
      async () => {
        const dir = mkdtempSync(join(tmpdir(), 'recued-supervise-probe-'));
        const script = join(dir, 'recued-supervise');
        // Shell builtins keep the real parent alive independently of PATH.
        // Wait for readiness, then release and reap the parent before removing its files.
        writeFileSync(script, '#!/bin/sh\nprintf "ready\\n"\nIFS= read -r release || :\n', { mode: 0o755 });
        const parent = spawn(script, [], { stdio: 'pipe',
          ...(path === 'empty' ? { env: { ...process.env, PATH: '' } } : {}) });
        let stderr = '';
        parent.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
        const closed = new Promise<void>(resolve => parent.once('close', () => resolve()));
        let readyTimer: ReturnType<typeof setTimeout> | undefined;
        const ready = new Promise<void>((resolve, reject) => {
          parent.stdout.once('data', (chunk: Buffer) => {
            if (chunk.toString() === 'ready\n') resolve();
            else reject(new Error(`Unexpected parent readiness: ${chunk.toString()}`));
          });
          parent.once('error', reject);
          parent.once('close', code => reject(new Error(`Parent exited before readiness (${code}): ${stderr}`)));
          readyTimer = setTimeout(() => reject(new Error(`Parent did not become ready: ${stderr}`)), 5_000);
        });
        try {
          await ready;
          const detected = childOfInstallSupervisor({ parentPid: parent.pid!, execPath: join(dir, 'recued') });
          const diagnostic = detected ? undefined : spawnSync('/bin/ps', ['-o', 'pid=,ppid=,stat=,command=', '-p', String(parent.pid)],
            { encoding: 'utf8', timeout: 2_000 });
          expect(detected, JSON.stringify({ path, exit_code: parent.exitCode, stderr,
            diagnostic_ps: diagnostic && { status: diagnostic.status, stdout: diagnostic.stdout, stderr: diagnostic.stderr,
              error: diagnostic.error?.message } })).toBe(true);
          expect(childOfInstallSupervisor({ parentPid: parent.pid!, execPath: join(tmpdir(), 'recued') })).toBe(false);
        } finally {
          clearTimeout(readyTimer);
          parent.stdin.end();
          const killTimer = setTimeout(() => parent.kill('SIGKILL'), 2_000);
          try { await closed; }
          finally { clearTimeout(killTimer); rmSync(dir, { recursive: true, force: true }); }
        }
        expect(parent.exitCode).toBe(0);
        expect(parent.signalCode).toBeNull();
      },
      15_000,
    );
  }

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
