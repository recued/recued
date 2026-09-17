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

// ──────────────────────────────────────────────────────────────────
// ⛔⛔ THE TWO CHECKS THAT WERE COMPUTED AND DISCARDED.
//
// Until 2026-09-16 `checkTls` called `verifyDomainHealth` — which walks leaf →
// chain → the system trust store and hashes the cert against the stored
// fingerprint — and then read `expires_at` and NOTHING ELSE. A certificate whose
// chain no longer reached a trusted root, or whose row had been tampered with,
// reported `✓ valid for N day(s)`.
//
// 🔑 THIS IS THE FILE'S OWN HEADER RULE, FAILED IN THE WORSE DIRECTION. That rule
// is that a "couldn't look" must not render as a "looked, fine". This looked,
// found the fault, and rendered fine — and no test could have caught it, because
// a discarded value changes no output. Only asking "what did we pay to compute,
// and who reads it?" finds this class.
// ──────────────────────────────────────────────────────────────────
describe('recued doctor — the certificate checks beyond expiry', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'doctor-tls-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  /** A real self-signed cert via the OpenSSL CLI. Self-signed is exactly the
   *  shape we need: it PARSES (so the fingerprint is computable and expiry is
   *  real) and its chain does NOT terminate at a system trust root. Returns null
   *  when `openssl` is unavailable, and the cases no-op — the same fallback the
   *  TLS store suite uses. */
  const selfSigned = async (
    validityDays: number,
  ): Promise<{ cert_pem: string; fingerprint: string; expires_at: number } | null> => {
    const { execFileSync } = await import('node:child_process');
    const { X509Certificate } = await import('node:crypto');
    const keyPath = join(dir, 'k.pem');
    const certPath = join(dir, 'c.pem');
    try {
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', keyPath, '-out', certPath,
        '-days', String(validityDays), '-subj', '/CN=alpha.example',
        '-addext', 'subjectAltName=DNS:alpha.example',
      ], { stdio: 'ignore' });
    } catch { return null; }
    const { readFileSync } = await import('node:fs');
    const cert_pem = readFileSync(certPath, 'utf8');
    const cert = new X509Certificate(cert_pem);
    return {
      cert_pem,
      fingerprint: cert.fingerprint256,
      expires_at: Date.parse(cert.validTo),
    };
  };

  /** Put a row in directly. ⚠ RAW SQL ON PURPOSE — both scenarios below are
   *  states the upload validator exists to REFUSE, so reaching them through it
   *  is impossible by design. A chain that stopped verifying and a row that was
   *  edited underneath us both arrive after upload, which is the whole reason a
   *  health check is a separate act from a validation. */
  const seedRow = async (
    realmPath: string,
    row: { cert_pem: string; fingerprint: string; expires_at: number },
  ): Promise<void> => {
    const { openDatabase } = await import('../open-database.js');
    const { ensureTlsDomainSchema } = await import('../tls/domain-store.js');
    const db = await openDatabase(realmPath);
    ensureTlsDomainSchema(db as never);
    (db as unknown as {
      prepare: (sql: string) => { run: (...a: unknown[]) => void };
    }).prepare(
      `INSERT INTO tls_domains
         (domain, source, cert_pem, private_key_encrypted, chain_pem,
          fingerprint, issuer, expires_at, uploaded_at, last_renewed_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL)`,
    ).run(
      'alpha.example', 'byo_upload', row.cert_pem, 'x',
      row.fingerprint, 'self', row.expires_at, Date.now(),
    );
    db.close();
  };

  const tlsLines = (lines: string[]): string[] => {
    const idx = lines.findIndex((l) => l.trim() === 'tls');
    return idx === -1 ? [] : lines.slice(idx + 1, idx + 6);
  };

  it('⛔ a chain that does not reach a trusted root FAILS, and exits 1', async () => {
    const fx = await selfSigned(365);
    if (fx === null) return; // no openssl on this host
    const realmPath = join(dir, 'realm.db');
    await seedRow(realmPath, fx);
    const { lines, code } = await run({ realmPath });
    const tls = tlsLines(lines).join('\n');
    // The expiry row still says the cert is fine, because it IS — that is the
    // point. The second row is the one that was missing.
    expect(tls).toContain('valid for');
    expect(tls).toContain('✗');
    expect(tls).toContain('does not reach a trusted root');
    // ⚠ Named as the CLIENT sees it: the server serves this handshake happily.
    expect(tls).toContain('clients will refuse');
    expect(code).toBe(1);
  });

  it('⛔ a row whose stored fingerprint disagrees with the cert FAILS', async () => {
    const fx = await selfSigned(365);
    if (fx === null) return;
    const realmPath = join(dir, 'realm.db');
    await seedRow(realmPath, { ...fx, fingerprint: 'f'.repeat(95) });
    const { lines, code } = await run({ realmPath });
    const tls = tlsLines(lines).join('\n');
    expect(tls).toContain('does not hash to its stored fingerprint');
    expect(tls).toContain('tampered');
    expect(code).toBe(1);
  });

  it('⚠ and the expiry hint now names WHO renews it', async () => {
    // A generic "renewal did not run" sends all three sources to look in the
    // same place, and only one of them would find anything. This row is
    // `byo_upload`, so the renewal is the owner's.
    const fx = await selfSigned(3);
    if (fx === null) return;
    const realmPath = join(dir, 'realm.db');
    await seedRow(realmPath, fx);
    const { lines } = await run({ realmPath });
    const tls = tlsLines(lines).join('\n');
    expect(tls).toContain('expires in');
    expect(tls).toContain('yours to renew');
  });
});
