/** `recued doctor` — owner-facing diagnosis of an install that will not start,
 *  will not pair, or has quietly stopped doing something.
 *
 *  ⛔⛔ WHY THIS IS NOT THE REACHABILITY DOCTOR, AND MUST NOT BECOME IT.
 *  There used to be a `diagnostics/reachability.ts` here — 362 lines building a
 *  full `ReachabilityReport`, tested, and called by nothing in production for as
 *  long as it existed; its own comment named the caller nobody wrote, "eventually
 *  bin.ts after the doctor rpc wires". It was DELETED 2026-09-16 along with its
 *  eleven report-family contracts, and this paragraph is what is left of it.
 *
 *  ⛔ DO NOT REBUILD IT BEHIND A `--network` FLAG. That is what this comment used
 *  to propose, and it was wrong on this file's own terms. The report answers a
 *  DIFFERENT question — *why can't the world reach me* — and needs a running,
 *  networked server to answer it: every block was required-field, with no unknown
 *  state. Its DNS block demanded `ddns_resolves` / `resolution_ms` /
 *  `last_ddns_update`; its TLS block demanded `cert_fingerprint` / `issuer` /
 *  `san`. Feeding it zeroes offline would publish "DDNS does not resolve" when
 *  the truth is "nobody checked", and the two would render identically — which is
 *  exactly the rule below, violated by the very shape of the report.
 *
 *  🔑 THE QUESTION STILL HAS AN OWNER, AND IT IS NOT A CLI. *Why can't the world
 *  reach me* is answered from the OUTSIDE, by the cloud probe worker, and
 *  rendered in Settings — Server — Connect a device (`connect-device-panel.ts`,
 *  which folds in the from-here address check and the port-mapping state). A
 *  machine cannot testify to its own reachability; that is why the surviving
 *  plumbing is a probe CALLER and not a report BUILDER.
 *
 *  ⇒ THIS command answers *why won't my server start* — and is therefore useful
 *  exactly when that whole surface is unavailable, because the server is down.
 *  It opens files and a database. It makes no network call and needs no listener.
 *
 *  🔑 THE RULE THE WHOLE FILE IS BUILT ON: `unknown` IS NOT `ok`. Every check
 *  that cannot run reports `unknown` WITH THE REASON it could not. A diagnostic
 *  whose "couldn't look" renders like its "looked, fine" is worse than no
 *  diagnostic, because it is trusted. The cascade is explicit for the same
 *  reason — when the realm will not open, the four checks that need a database
 *  say so by name rather than silently vanishing from the report.
 *
 *  Exit status: 1 if any check FAILED, 0 otherwise. A `warn` or an `unknown` is
 *  advisory and does not fail the command — an install with no paired client yet
 *  is not a broken install.
 */
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BootTrace } from '../cli/boot-trace.js';

export type DoctorStatus = 'ok' | 'warn' | 'fail' | 'unknown';

export interface DoctorCheck {
  /** Grouping label, rendered once above its checks. */
  section: string;
  status: DoctorStatus;
  /** What was found. Present tense, no leading capital. */
  detail: string;
  /** What the owner should do about it. Omitted when `ok`. */
  hint?: string;
}

export interface DoctorProfileOptions {
  args: string[];
  bootTrace: BootTrace;
  exit?: (code: number) => void;
  log?: (line: string) => void;
  /** Overridden in tests. Production omits every seam below so the checks run
   *  against the real install — a doctor exercised only through stubs proves
   *  the stubs. */
  probe?: (dbPath: string) => Promise<void> | void;
  realmPath?: string;
  now?: () => number;
}

const SYMBOL: Record<DoctorStatus, string> = {
  ok: '✓',
  warn: '⚠',
  fail: '✗',
  unknown: '?',
};

const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The payload can load its native addon and round-trip a database. Borrowed
 *  wholesale from `self-test`, which exists because `--version` returns before
 *  the first dynamic import and so proves nothing about the addon. */
const checkPayload = async (
  probe: (dbPath: string) => Promise<void> | void,
): Promise<DoctorCheck> => {
  const dir = mkdtempSync(join(tmpdir(), 'recued-doctor-'));
  try {
    await probe(join(dir, 'probe.db'));
    return { section: 'payload', status: 'ok', detail: 'native addon loads, database round-trips' };
  } catch (err) {
    return {
      section: 'payload',
      status: 'fail',
      detail: `this build cannot open a database: ${reason(err)}`,
      hint: 'the executable runs, so this is usually its native addon — lib/better_sqlite3.node'
        + ' missing, built for another platform, or a different ABI. Reinstall the matching build.',
    };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* the probe is over either way */ }
  }
};

/** Everything that needs the realm database open. Returns the checks AND the
 *  open handle so the caller can close it once. */
const checkRealm = async (
  realmPath: string,
  now: number,
): Promise<{ checks: DoctorCheck[]; db: unknown | null }> => {
  const checks: DoctorCheck[] = [];
  if (!existsSync(realmPath)) {
    checks.push({
      section: 'realm',
      status: 'fail',
      detail: `no database at ${realmPath}`,
      hint: 'this install has never booted. Run `recued serve` once to create it.',
    });
    return { checks, db: null };
  }
  let db: Awaited<ReturnType<typeof import('../open-database.js')['openDatabase']>> | null = null;
  try {
    const { openDatabase } = await import('../open-database.js');
    db = await openDatabase(realmPath);
    checks.push({ section: 'realm', status: 'ok', detail: `${realmPath} opens` });
  } catch (err) {
    checks.push({
      section: 'realm',
      status: 'fail',
      detail: `${realmPath} will not open: ${reason(err)}`,
      hint: 'at-rest encryption seals this database to a keyfile. If the keyfile moved, was'
        + ' re-scoped, or the passphrase changed, `recued recover-keyfile` is the way back.',
    });
    return { checks, db: null };
  }

  // Identity lives beside the realm, not inside it — a present database with no
  // passport is a real state (a half-finished first boot), not an impossible one.
  const identityPath = join(dirname(realmPath), 'recued-server-identity.json');
  checks.push(existsSync(identityPath)
    ? { section: 'identity', status: 'ok', detail: 'server passport present' }
    : {
      section: 'identity',
      status: 'fail',
      detail: `no passport at ${identityPath}`,
      hint: 'the server cannot prove who it is, so nothing can pair with it. Run `recued serve`'
        + ' once to mint one, or restore it from the same backup as the database.',
    });

  checks.push(...await checkPairing(db, now));
  checks.push(...await checkAutoDisabled(realmPath));
  checks.push(...await checkTls(db, now));
  return { checks, db };
};

const checkPairing = async (db: unknown, _now: number): Promise<DoctorCheck[]> => {
  try {
    const { createPairedInstancesStore } = await import('../paired-instances-store.js');
    const store = createPairedInstancesStore(db as never);
    // `listAllActive` and not `listAll`: a revoked client is not a way in.
    const paired = store.listAllActive();
    return [paired.length > 0
      ? { section: 'pairing', status: 'ok', detail: `${paired.length} paired client(s)` }
      : {
        section: 'pairing',
        status: 'warn',
        detail: 'no paired clients',
        hint: 'nothing can reach this server yet. Run `recued pair` to enrol a browser.',
      }];
  } catch (err) {
    return [{
      section: 'pairing',
      status: 'unknown',
      detail: `could not read the pairing table: ${reason(err)}`,
      hint: 'the database opened, so this is a schema or migration problem rather than a key one.',
    }];
  }
};

const checkAutoDisabled = async (realmPath: string): Promise<DoctorCheck[]> => {
  try {
    const { readAutoDisabledFromDb } = await import('../cli-status-extras.js');
    const rows = await readAutoDisabledFromDb(realmPath);
    if (rows.length === 0) {
      return [{ section: 'recipes', status: 'ok', detail: 'none auto-disabled' }];
    }
    const names = rows.map((r) => r.name ?? r.recipe_id).slice(0, 3).join(', ');
    return [{
      section: 'recipes',
      status: 'warn',
      detail: `${rows.length} auto-disabled: ${names}${rows.length > 3 ? ', …' : ''}`,
      hint: 'a recipe the engine disabled after repeated failures. `recued status` prints the'
        + ' full table with the reason each was stopped.',
    }];
  } catch (err) {
    return [{
      section: 'recipes',
      status: 'unknown',
      detail: `could not read the recipe table: ${reason(err)}`,
    }];
  }
};

/** Why a renewal has not run, by who owns it.
 *
 *  🔑 THE SOURCE CHANGES WHOSE PROBLEM IT IS, which is the only thing a hint
 *  here is for. A generic "renewal did not run" sends all three owners to look
 *  in the same place, and only one of them would find anything.
 *
 *  ⛔ AND `pro_acme_custom` IS NOT `pro_acme` (D-235 § 5.1). A fleet-issued
 *  CUSTOM domain renews only while a CNAME in the OWNER'S zone still points at
 *  ours — so "it stopped renewing" and "you deleted the delegation" are the same
 *  event, and the delegation is the first thing worth checking. Folding it into
 *  the auto-managed branch would say "we handle it" about the one case where the
 *  owner holds the half that broke.
 *
 *  ⚠ IN THE DOCTOR'S REGISTER, NOT THE WEB UI'S. The rolled-up copy this
 *  replaces pointed at "Settings → Server → TLS Certificates" — a page on the
 *  server whose health is in question, reached by a reader who ran a terminal
 *  command. These name the CAUSE, which is actionable wherever they are. */
const renewalHint = (source: string, domain: string): string => {
  if (source === 'pro_acme') {
    return 'Recued renews this one. If it does not clear on its own, ACME is stuck.';
  }
  if (source === 'pro_acme_custom') {
    return `Recued renews ${domain}, but only while its _acme-challenge delegation still `
      + 'resolves. Check that record first — removing it stops renewal silently.';
  }
  return 'This certificate is yours to renew. Clients will refuse the connection '
    + 'once it lapses.';
};

/** Certificate health, read from the domain store's public bytes. Never touches
 *  private key material — `listForHealthCheck()` does not carry it. */
const checkTls = async (db: unknown, now: number): Promise<DoctorCheck[]> => {
  try {
    const [{ createSqliteTlsDomainStore }, verifiers, { verifyDomainHealth }, { X509Certificate }] =
      await Promise.all([
        import('../tls/domain-store.js'),
        import('../tls/cert-verifiers.js'),
        import('../diagnostics/per-domain-tls-health.js'),
        import('node:crypto'),
      ]);
    // `getKey` is deliberately omitted: unwired, the store falls back to
    // base64-only encoding, which is all a public-cert read needs.
    //
    // ⚠ `acceptSelfSigned` IS OMITTED ON BOTH SIDES, AND THAT IS THE COUPLING.
    // The store defaults it false at upload and `verifyDomainHealth` below
    // defaults it false at health-check, so the two gates agree. They agree by
    // SHARED DEFAULT, not by threading — so if a production caller ever passes
    // `acceptSelfSigned: true` to this store, the chain check below starts
    // failing every self-signed row the server deliberately accepted. Verified
    // 2026-09-16: nothing outside tests sets it.
    const store = createSqliteTlsDomainStore({
      db: db as never,
      verifiers: verifiers as never,
    });
    const rows = store.listForHealthCheck();
    if (rows.length === 0) {
      return [{ section: 'tls', status: 'ok', detail: 'no per-domain certificates configured' }];
    }
    const checks: DoctorCheck[] = [];
    for (const row of rows) {
      const health = verifyDomainHealth(row as never, {
        verifyChain: verifiers.verifyChain,
        computeFingerprint: (pem: string) => new X509Certificate(pem).fingerprint256,
      } as never);
      const days = Math.floor((health.expires_at - now) / 86_400_000);
      if (days < 0) {
        checks.push({
          section: 'tls',
          status: 'fail',
          detail: `${health.domain} expired ${-days} day(s) ago`,
          hint: renewalHint(health.source, health.domain),
        });
      } else if (days <= 14) {
        checks.push({
          section: 'tls',
          status: 'warn',
          detail: `${health.domain} expires in ${days} day(s)`,
          hint: renewalHint(health.source, health.domain),
        });
      } else {
        checks.push({ section: 'tls', status: 'ok', detail: `${health.domain} valid for ${days} day(s)` });
      }

      // ⛔⛔ THESE TWO WERE COMPUTED AND THROWN AWAY (until 2026-09-16). This
      // loop called `verifyDomainHealth` — which walks leaf → chain → the system
      // trust store, and hashes the cert to compare against the stored
      // fingerprint — and then read `expires_at` and nothing else. So a cert
      // whose chain had stopped terminating at a trust root, or whose row had
      // been tampered with, reported `✓ valid for 340 day(s)`.
      //
      // 🔑 WORSE THAN THIS FILE'S OWN NAMED FAILURE MODE. The header rule is
      // that a "couldn't look" must not render like a "looked, fine". This DID
      // look, it FOUND the fault, and it rendered fine — the cost of the check
      // paid and the answer discarded. ⚠ The facts were one property access
      // away the whole time, which is what makes it worth a comment this long:
      // nothing was missing, nothing failed, and no test could tell, because a
      // discarded value has no observable behaviour to assert against.
      if (!health.fingerprint_matches) {
        checks.push({
          section: 'tls',
          status: 'fail',
          detail: `${health.domain} does not hash to its stored fingerprint`,
          hint: 'the stored row and the certificate disagree — treat the row as tampered '
            + 'with and re-upload a known-good certificate.',
        });
      }
      if (!health.chain_valid) {
        checks.push({
          section: 'tls',
          status: 'fail',
          // ⚠ Said as the CLIENT experiences it. "Chain does not verify" names
          // our finding; "browsers will refuse it" names the consequence, and
          // this one is invisible from the server — it serves the handshake
          // perfectly well and every connection fails at the far end.
          detail: `${health.domain}'s certificate chain does not reach a trusted root`,
          hint: 'clients will refuse this certificate even though the server serves it. '
            + "Usually an intermediate expired, or the issuer's chain was never uploaded "
            + 'alongside the certificate.',
        });
      }
    }
    return checks;
  } catch (err) {
    // A MISSING TABLE IS A FACT, NOT A BLIND SPOT. `no such table: tls_domains`
    // means the TLS schema was never ensured, which means no certificate was
    // ever stored — so this is the same answer as the empty-rows branch above,
    // and reporting it as `unknown` would send an owner looking for a fault
    // that is really just an unconfigured feature. Every OTHER failure stays
    // unknown, because those genuinely mean nobody looked.
    if (/no such table/i.test(reason(err))) {
      return [{ section: 'tls', status: 'ok', detail: 'no certificates configured' }];
    }
    return [{
      section: 'tls',
      status: 'unknown',
      detail: `could not read the certificate store: ${reason(err)}`,
    }];
  }
};

/** Is anything already serving on the port this install would bind? Answers
 *  "is it running" without asking it anything — a connect, not a request. */
const checkListener = async (args: string[]): Promise<DoctorCheck> => {
  let port: number;
  try {
    const { resolveBindPort } = await import('../cli/resolve-bind-port.js');
    port = resolveBindPort({ args });
  } catch (err) {
    return { section: 'listener', status: 'unknown', detail: `could not resolve the bind port: ${reason(err)}` };
  }
  const { createConnection } = await import('node:net');
  const listening = await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const settle = (value: boolean) => { socket.destroy(); resolve(value); };
    socket.setTimeout(1500);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });
  return listening
    ? { section: 'listener', status: 'ok', detail: `a server is listening on :${port}` }
    : {
      section: 'listener',
      status: 'warn',
      detail: `nothing listening on :${port}`,
      hint: 'the server is not running. Every check above reads files directly, so they are'
        + ' still accurate — but nothing will answer a client until `recued serve` is up.',
    };
};

export async function runDoctorProfile(options: DoctorProfileOptions): Promise<void> {
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const now = (options.now ?? Date.now)();

  const { probeDatabaseRoundTrip } = await import('./self-test.js');
  const checks: DoctorCheck[] = [await checkPayload(options.probe ?? probeDatabaseRoundTrip)];

  let realmPath = options.realmPath;
  if (realmPath === undefined) {
    try {
      const { resolveRealmDbPath } = await import('../realm-db-path.js');
      const { getArg } = await import('../cli/parse.js');
      // ⚠ `getArg` prepends the dashes itself — passing '--db' makes it search for
      // '----db' and return undefined, silently falling back to the standard path.
      realmPath = resolveRealmDbPath(getArg(options.args, 'db'), { note: () => {} });
    } catch (err) {
      checks.push({
        section: 'realm',
        status: 'unknown',
        detail: `could not work out where the database lives: ${reason(err)}`,
        hint: 'pass one explicitly with --db <path>.',
      });
    }
  }

  let db: unknown = null;
  if (realmPath !== undefined) {
    const realm = await checkRealm(realmPath, now);
    checks.push(...realm.checks);
    db = realm.db;
    // ⛔ The cascade, stated rather than silent. When the realm did not open the
    // four database-backed checks are absent from `realm.checks`, and a reader
    // cannot tell "clean" from "never ran" unless the report says which.
    if (db === null) {
      for (const section of ['identity', 'pairing', 'recipes', 'tls']) {
        if (!realm.checks.some((c) => c.section === section)) {
          checks.push({
            section,
            status: 'unknown',
            detail: 'not checked — the realm database did not open',
          });
        }
      }
    }
  }
  checks.push(await checkListener(options.args));
  if (db !== null) {
    try { (db as { close: () => void }).close(); } catch { /* the report is already built */ }
  }

  log('');
  let lastSection: string | null = null;
  for (const check of checks) {
    if (check.section !== lastSection) {
      log(`  ${check.section}`);
      lastSection = check.section;
    }
    log(`    ${SYMBOL[check.status]} ${check.detail}`);
    if (check.hint !== undefined) log(`      ${check.hint}`);
  }
  const failed = checks.filter((c) => c.status === 'fail').length;
  const warned = checks.filter((c) => c.status === 'warn').length;
  const unknown = checks.filter((c) => c.status === 'unknown').length;
  log('');
  log(failed > 0
    ? `  ${failed} problem(s) to fix${warned > 0 ? `, ${warned} advisory` : ''}${unknown > 0 ? `, ${unknown} not checked` : ''}.`
    : `  no problems found${warned > 0 ? `, ${warned} advisory` : ''}${unknown > 0 ? `, ${unknown} not checked` : ''}.`);
  log('');
  options.bootTrace.mark('doctor', failed > 0 ? 'failed' : 'ok');
  exit(failed > 0 ? 1 : 0);
}
