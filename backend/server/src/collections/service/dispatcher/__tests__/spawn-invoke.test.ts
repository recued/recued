/** D-118 Phase 6 — spawn-invoke helper tests.
 *
 *  Drives real Node subprocesses via `node -e` so we exercise the
 *  stdio + timeout + capture paths against actual child processes.
 *  Fast enough for CI (each test runs a sub-100ms node script).
 */
import { describe, expect, it } from 'vitest';

import { SERVICE_INVOKE_STDOUT_CAP_BYTES } from '@recued/contracts';

import { defaultSpawnInvoke } from '../spawn-invoke.js';

describe('defaultSpawnInvoke — exit + capture', () => {
  it('captures stdout lines + returns exit 0', async () => {
    const res = await defaultSpawnInvoke(
      ['node', '-e', 'console.log("a"); console.log("b")'],
      { timeout_ms: 5_000 },
    );
    expect(res.exit_code).toBe(0);
    expect(res.log_lines).toEqual(['a', 'b']);
    expect(res.stdout_truncated).toBe(false);
    expect(res.timed_out).toBe(false);
    expect(res.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('captures stderr lines alongside stdout (combined, arrival order)', async () => {
    const res = await defaultSpawnInvoke(
      ['node', '-e', 'process.stderr.write("err\\n"); console.log("out")'],
      { timeout_ms: 5_000 },
    );
    expect(res.exit_code).toBe(0);
    expect(res.log_lines).toEqual(expect.arrayContaining(['err', 'out']));
  });

  it('propagates non-zero exit codes', async () => {
    const res = await defaultSpawnInvoke(
      ['node', '-e', 'process.exit(7)'],
      { timeout_ms: 5_000 },
    );
    expect(res.exit_code).toBe(7);
    expect(res.timed_out).toBe(false);
  });

  it('surfaces spawn failure as exit -1 (missing binary)', async () => {
    const res = await defaultSpawnInvoke(
      ['no-such-binary-xyz-recued'],
      { timeout_ms: 2_000 },
    );
    expect(res.exit_code).toBe(-1);
    // Node spawn raises via the 'error' event — we capture its message.
    expect(res.log_lines.join('\n')).toMatch(/ENOENT|not found|no such/);
  });
});

describe('defaultSpawnInvoke — timeout', () => {
  it('kills the child on timeout, returns exit -9 + timed_out=true', async () => {
    const res = await defaultSpawnInvoke(
      ['node', '-e', 'setInterval(()=>{}, 1000)'],
      { timeout_ms: 120 },
    );
    expect(res.timed_out).toBe(true);
    expect(res.exit_code).toBe(-9);
    expect(res.duration_ms).toBeGreaterThanOrEqual(100);
  });
});

describe('defaultSpawnInvoke — truncation marker', () => {
  it('appends the truncation marker + stops capturing above the cap', async () => {
    // Write > 1 MiB to stdout using a repeated buffer so we trip
    // the cap deterministically. Node script prints 3 × 512KiB
    // blocks separated by newlines.
    const script = `
      const line = 'x'.repeat(512 * 1024);
      for (let i = 0; i < 4; i++) { process.stdout.write(line + '\\n'); }
    `;
    const res = await defaultSpawnInvoke(
      ['node', '-e', script],
      { timeout_ms: 5_000 },
    );
    expect(res.exit_code).toBe(0);
    expect(res.stdout_truncated).toBe(true);
    // Marker is appended once we hit the cap; subsequent lines are dropped.
    const joined = res.log_lines.join('\n');
    expect(joined).toContain(`[stdout truncated at ${SERVICE_INVOKE_STDOUT_CAP_BYTES} bytes]`);
    // Captured bytes ≈ cap (slightly less due to newline accounting).
    const captured = Buffer.byteLength(joined, 'utf8');
    expect(captured).toBeLessThan(SERVICE_INVOKE_STDOUT_CAP_BYTES + 2048);
  });
});

describe('defaultSpawnInvoke — empty argv', () => {
  it('rejects cleanly rather than crashing', async () => {
    const res = await defaultSpawnInvoke([], { timeout_ms: 1_000 });
    expect(res.exit_code).toBe(-1);
    expect(res.log_lines).toEqual(['empty argv']);
  });
});
