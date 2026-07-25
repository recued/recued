/** D-118 Phase 3 — defaultSpawn helper tests.
 *
 *  The helper wraps Node's `child_process.spawn` with the
 *  load-bearing stdio shape (`['ignore', 'pipe', 'pipe']`) + line-
 *  buffered capture + 1 MiB cap. Real subprocesses via `node -e`.
 */

import { describe, expect, it } from 'vitest';

import { SERVICE_INVOKE_STDOUT_CAP_BYTES } from '@recued/contracts';

import { defaultSpawn } from '../process.js';

describe('defaultSpawn', () => {
  it('captures stdout lines from a node subprocess', async () => {
    const out = await defaultSpawn([
      process.execPath,
      '-e',
      `console.log('line one'); console.log('line two');`,
    ]);
    expect(out.exit_code).toBe(0);
    expect(out.log_lines).toEqual(['line one', 'line two']);
  });

  it('captures stderr alongside stdout in arrival order', async () => {
    const out = await defaultSpawn([
      process.execPath,
      '-e',
      `console.error('err'); console.log('out');`,
    ]);
    expect(out.exit_code).toBe(0);
    // Stream interleaving order isn't deterministic across Node
    // versions, so just assert both lines surfaced.
    expect(out.log_lines).toContain('err');
    expect(out.log_lines).toContain('out');
  });

  it('non-zero exit code surfaces unmodified', async () => {
    const out = await defaultSpawn([
      process.execPath,
      '-e',
      `process.exit(42);`,
    ]);
    expect(out.exit_code).toBe(42);
  });

  it('missing binary surfaces as exit -1 + error message', async () => {
    const out = await defaultSpawn(['this-binary-definitely-does-not-exist-xyz']);
    expect(out.exit_code).toBe(-1);
    expect(out.log_lines.length).toBeGreaterThan(0);
  });

  it('empty argv refused', async () => {
    const out = await defaultSpawn([]);
    expect(out.exit_code).toBe(-1);
    expect(out.log_lines).toEqual(['empty argv']);
  });

  it('truncates output once the 1 MiB cap is hit', async () => {
    // Emit lines until well past the cap. Each line ≈ 100 bytes;
    // 20 000 lines = ~2 MB → guaranteed to trip the truncation.
    const script = `for (let i = 0; i < 20000; i++) console.log('x'.repeat(99));`;
    const out = await defaultSpawn([process.execPath, '-e', script]);
    expect(out.exit_code).toBe(0);
    const total = out.log_lines.reduce(
      (acc, l) => acc + Buffer.byteLength(l, 'utf8') + 1,
      0,
    );
    // Capture stops at the cap (give or take one line). Assert
    // the total is at most slightly above the cap.
    expect(total).toBeLessThanOrEqual(SERVICE_INVOKE_STDOUT_CAP_BYTES + 200);
    // Truncation marker present.
    expect(
      out.log_lines.some((l) => l.startsWith('[stdout truncated')),
    ).toBe(true);
  });

  it('respects shell: false — argv values stay literal', async () => {
    // Pass a value that would be a glob/expansion under a shell,
    // and ensure it lands as a single literal argv element.
    const out = await defaultSpawn([
      process.execPath,
      '-e',
      `console.log(process.argv[1]);`,
      '*; echo SHELL-RAN',
    ]);
    expect(out.exit_code).toBe(0);
    expect(out.log_lines).toContain('*; echo SHELL-RAN');
    expect(out.log_lines.join('\n')).not.toContain('SHELL-RAN\n');
  });
});
