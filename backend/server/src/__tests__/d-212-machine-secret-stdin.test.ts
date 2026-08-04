/** D-212 slice 5 — the sealing rungs actually hand their secret to the child.
 *
 *  ⛔ WHY THIS TEST DID NOT EXIST, AND WHY IT HAD TO. Every other d-212 test
 *  mocks the provider registry, because provisioning writes to the developer's
 *  own OS keychain — shared machine state nothing cleans up. That mock is
 *  correct, and it is also precisely why a suite of thousands stayed green while
 *  THREE OF THE FOUR RUNGS COULD NEVER WORK: the call sites passed `input` inside
 *  an options object cast `as never`, and async `execFile` has no `input` option
 *  (that belongs to `execFileSync`). The secret never reached stdin. Windows
 *  dpapi and systemd-creds timed out and reported themselves unavailable — a
 *  silent downgrade to an unsealed keyfile — while secret-service reported
 *  available and then threw from `provision` ten seconds later.
 *
 *  So this spawns a REAL child and asserts the bytes arrive. `process.execPath`
 *  rather than `cat`, so it runs the same way on Windows, where the defect was
 *  found.
 */

import { describe, expect, it } from 'vitest';

import { runWithInput } from '../keys/machine-secret.js';

/** Echoes stdin back on stdout — the smallest possible stand-in for
 *  `secret-tool store`, `systemd-creds encrypt -` and the DPAPI snippet, all of
 *  which read their secret from stdin to EOF. */
const ECHO_STDIN = 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>process.stdout.write(b))';

describe('runWithInput feeds the child stdin', () => {
  it('⛔ the input actually arrives — the whole defect in one assertion', async () => {
    const secret = Buffer.alloc(32, 0x5a).toString('base64');
    const { stdout } = await runWithInput(
      process.execPath,
      ['-e', ECHO_STDIN],
      secret,
      { timeout: 15_000 },
    );
    expect(stdout.trim()).toBe(secret);
  });

  it('closes stdin, so a child reading to EOF completes instead of hanging', async () => {
    // The old shape left the pipe OPEN, so the child blocked until the timeout
    // killed it. Measured: `cat` with `{ input }` took SIGTERM at 3006ms rather
    // than seeing EOF. A short timeout here would therefore have failed before
    // the fix and passes comfortably after it.
    const started = Date.now();
    await runWithInput(process.execPath, ['-e', ECHO_STDIN], 'probe', { timeout: 15_000 });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('surfaces a non-zero exit rather than resolving with partial output', async () => {
    // `provision` must fail loudly: a rung that swallows an error would record a
    // sealing provider in the keyfile that cannot serve the secret back at boot.
    await expect(
      runWithInput(process.execPath, ['-e', 'process.exit(3)'], 'x', { timeout: 15_000 }),
    ).rejects.toThrow();
  });

  it('does not reject twice when the child exits before draining stdin', async () => {
    // An EPIPE on the write races the callback. Both settle the same promise, so
    // an unguarded pipe error would be an unhandled rejection rather than a test
    // failure — it must be swallowed on the stream and reported by the callback.
    const big = 'x'.repeat(1_000_000);
    await expect(
      runWithInput(process.execPath, ['-e', 'process.exit(0)'], big, { timeout: 15_000 }),
    ).resolves.toBeDefined();
  });
});

describe('no call site passes the inert `input` option', () => {
  it('⛔ `as never` on an options object is what hid this from tsc', async () => {
    // Proven separately: the same call WITHOUT the cast is a compile error —
    // "'input' does not exist in type 'ExecFileOptionsWithBufferEncoding'".
    // The type system had the answer; the cast discarded it. A source assertion
    // is weak, but it is the only thing that catches a NEW site reintroducing
    // the pattern, which typecheck alone would again let through if cast.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../keys/machine-secret.ts', import.meta.url)),
      'utf8',
    );
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    expect(code).not.toMatch(/as never/);
    expect(code).not.toMatch(/\binput:\s*(secret|'probe')/);
  });
});
