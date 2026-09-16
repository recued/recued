/** `recued doctor` — the offline boot diagnosis.
 *
 *  ⛔ WHAT THESE TESTS EXIST TO PIN, beyond "it prints something". The command's
 *  whole value is that `unknown` never renders as `ok`: a diagnostic whose
 *  "couldn't look" is indistinguishable from its "looked, fine" is worse than
 *  none, because an owner acts on it. So the cascade — four database-backed
 *  checks when the realm will not open — is asserted BY NAME, and the exit code
 *  is asserted on both paths.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDoctorProfile, type DoctorProfileOptions } from '../cli-context/doctor.js';
import { createBootTrace } from '../cli/boot-trace.js';

// `profile` is REQUIRED on BootTraceOptions; omitting it typechecked nowhere the
// hook or vitest looks (`typecheck:tests` is not gated on commit). 'doctor' is what
// `classifyBootProfile` returns for this subcommand, so the trace matches the real
// entrypoint's rather than inventing a shape.
const bootTrace = () => createBootTrace({ env: {}, entrypoint: 'test', profile: 'doctor' });

interface RunResult { lines: string[]; code: number | null; text: string }

const run = async (overrides: Partial<DoctorProfileOptions>): Promise<RunResult> => {
  const lines: string[] = [];
  let code: number | null = null;
  await runDoctorProfile({
    args: [],
    bootTrace: bootTrace(),
    log: (line) => lines.push(line),
    exit: (c) => { code = c; },
    // The payload probe is seamed so the suite does not depend on the native
    // addon; every OTHER check runs for real against the temp realm below.
    probe: () => {},
    ...overrides,
  });
  return { lines, code, text: lines.join('\n') };
};

describe('recued doctor — offline boot diagnosis', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'doctor-test-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('fails, and exits 1, when the realm database is absent', async () => {
    const { text, code } = await run({ realmPath: join(dir, 'missing.db') });
    expect(text).toContain('✗');
    expect(text).toContain('no database at');
    expect(code).toBe(1);
  });

  it('names every database-backed check it could not run, rather than omitting them', async () => {
    // ⛔ THE CENTRAL ASSERTION. With no realm there is nothing to say about
    // identity, pairing, recipes or TLS — and the failure mode this guards is
    // those four silently VANISHING from the report, which reads to an owner as
    // "nothing wrong there". Each must appear, by name, marked not-checked.
    const { lines } = await run({ realmPath: join(dir, 'missing.db') });
    for (const section of ['identity', 'pairing', 'recipes', 'tls']) {
      const idx = lines.findIndex((l) => l.trim() === section);
      expect(idx, `${section} must appear in the report`).toBeGreaterThan(-1);
      expect(lines[idx + 1]).toContain('?');
      expect(lines[idx + 1]).toContain('not checked');
    }
  });

  it('does not fail the command for advisories alone', async () => {
    // A real database with no paired client and no certificates is a healthy
    // fresh install, not a broken one. Exit 0 or `doctor` cries wolf on day one.
    const { openDatabase } = await import('../open-database.js');
    const realmPath = join(dir, 'realm.db');
    const db = await openDatabase(realmPath);
    db.close();
    writeFileSync(join(dir, 'recued-server-identity.json'), '{}');
    const { text, code } = await run({ realmPath });
    expect(text).toContain('opens');
    expect(text).not.toContain('✗');
    expect(code).toBe(0);
  });

  it('reports an uninitialised TLS schema as a fact, not a blind spot', async () => {
    // `no such table: tls_domains` means no certificate was ever stored — the
    // same answer as an empty table. Reporting it `unknown` would send an owner
    // hunting a fault that is an unconfigured feature.
    const { openDatabase } = await import('../open-database.js');
    const realmPath = join(dir, 'realm.db');
    const db = await openDatabase(realmPath);
    db.close();
    const { lines } = await run({ realmPath });
    const idx = lines.findIndex((l) => l.trim() === 'tls');
    expect(lines[idx + 1]).toContain('✓');
    expect(lines[idx + 1]).toContain('no certificates configured');
  });

  it('exits 1 when the payload cannot open a database at all', async () => {
    const { text, code } = await run({
      realmPath: join(dir, 'missing.db'),
      probe: () => { throw new Error('addon is built for another platform'); },
    });
    expect(text).toContain('another platform');
    expect(text).toContain('native addon');
    expect(code).toBe(1);
  });
});
