/** D-148 P5 — server cert-renewal task tests.
 *
 *  Covers acceptance:
 *    - Renewal task no-ops when cert is not yet due.
 *    - Renewal task fires when cert is past renewal_recommended_at.
 *    - Failed cert renewal flips
 *      `coverage.sources_degraded: 'cert_renewal_overdue'` (only
 *      within the user-warning window).
 *    - Successful renewal clears the degraded flag.
 *    - CSR generator returning a PRIVATE KEY block is rejected
 *      defensively.
 *    - Audit row emitted on every outcome.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  runCertRenewal,
  type CertRenewalStore,
  type CertRenewalAuditEmitter,
  type CoverageDegradedSink,
  type CertRenewalState,
} from '../tls/cert-renewal.js';
import type { RecuedAcmeIssueResult } from '@recued/server-network';
import { CERT_RENEWAL_OVERDUE_DEGRADED_REASON } from '@recued/contracts';

const mkStore = (initial: CertRenewalState | null) => {
  let current = initial;
  const writes: CertRenewalState[] = [];
  return {
    writes,
    store: {
      async loadCurrent() {
        return current;
      },
      async applyNew(args) {
        current = {
          handle: args.handle,
          cert_pem: args.cert_pem,
          expires_at: args.expires_at,
          renewal_recommended_at: args.renewal_recommended_at,
        };
        writes.push(current);
      },
    } satisfies CertRenewalStore,
  };
};

const mkAcme = (override?: RecuedAcmeIssueResult | (() => Promise<never>)) => {
  if (typeof override === 'function') {
    return {
      issueCert: vi.fn(override),
    };
  }
  const default_: RecuedAcmeIssueResult = override ?? {
    cert_pem: 'NEW_CERT',
    issuer_chain_pem: 'NEW_CHAIN',
    expires_at: Date.now() + 90 * 24 * 60 * 60 * 1000,
    renewal_recommended_at: Date.now() + 60 * 24 * 60 * 60 * 1000,
  };
  return {
    issueCert: vi.fn(async () => default_),
  };
};

const mkAudit = (): CertRenewalAuditEmitter & {
  events: Parameters<CertRenewalAuditEmitter['emit']>[0][];
} => {
  const events: Parameters<CertRenewalAuditEmitter['emit']>[0][] = [];
  return {
    events,
    emit(event) {
      events.push(event);
    },
  };
};

const mkCoverage = (): CoverageDegradedSink & {
  flagged: Array<{ reason: string; args: Record<string, unknown> }>;
  cleared: Array<{ reason: string; args: Record<string, unknown> }>;
} => {
  const flagged: Array<{ reason: string; args: Record<string, unknown> }> = [];
  const cleared: Array<{ reason: string; args: Record<string, unknown> }> = [];
  return {
    flagged,
    cleared,
    flag(reason, args) {
      flagged.push({ reason, args });
    },
    clear(reason, args) {
      cleared.push({ reason, args });
    },
  };
};

const validCsr = '-----BEGIN CERTIFICATE REQUEST-----\nFOO\n-----END CERTIFICATE REQUEST-----';

describe('runCertRenewal', () => {
  it('no-ops when no cert is loaded', async () => {
    const audit = mkAudit();
    const coverage = mkCoverage();
    const out = await runCertRenewal({
      acme: mkAcme(),
      store: mkStore(null).store,
      generateCsr: () => validCsr,
      audit,
      coverage,
    });
    expect(out.outcome).toBe('no_cert');
    expect(audit.events).toHaveLength(0);
  });

  it('skips when cert is not yet due', async () => {
    const future = Date.now() + 60 * 24 * 60 * 60 * 1000;
    const { store } = mkStore({
      handle: 'alice',
      cert_pem: 'CURRENT',
      expires_at: future + 30 * 24 * 60 * 60 * 1000,
      renewal_recommended_at: future,
    });
    const audit = mkAudit();
    const coverage = mkCoverage();
    const out = await runCertRenewal({
      acme: mkAcme(),
      store,
      generateCsr: () => validCsr,
      audit,
      coverage,
    });
    expect(out.outcome).toBe('not_yet_due');
    expect(audit.events).toHaveLength(0);
  });

  it('fires renewal when past renewal_recommended_at', async () => {
    const fixture = mkStore({
      handle: 'alice',
      cert_pem: 'CURRENT',
      expires_at: Date.now() + 5 * 24 * 60 * 60 * 1000,
      renewal_recommended_at: Date.now() - 1,
    });
    const audit = mkAudit();
    const coverage = mkCoverage();
    const acme = mkAcme();
    const out = await runCertRenewal({
      acme,
      store: fixture.store,
      generateCsr: () => validCsr,
      audit,
      coverage,
    });
    expect(out.outcome).toBe('renewed');
    expect(acme.issueCert).toHaveBeenCalledTimes(1);
    expect(fixture.writes).toHaveLength(1);
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0].kind).toBe('cert_renewed');
    expect(coverage.cleared).toHaveLength(1);
    expect(coverage.cleared[0].reason).toBe(CERT_RENEWAL_OVERDUE_DEGRADED_REASON);
  });

  it('flags coverage degraded when ACME fails AND cert is in user-warning window', async () => {
    // Cert expiring in 5 days < 7-day user-warning window.
    const fixture = mkStore({
      handle: 'alice',
      cert_pem: 'CURRENT',
      expires_at: Date.now() + 5 * 24 * 60 * 60 * 1000,
      renewal_recommended_at: Date.now() - 1,
    });
    const audit = mkAudit();
    const coverage = mkCoverage();
    const acme = mkAcme(async () => {
      throw new Error('LE_RATE_LIMITED');
    });
    const out = await runCertRenewal({
      acme,
      store: fixture.store,
      generateCsr: () => validCsr,
      audit,
      coverage,
    });
    expect(out.outcome).toBe('renewal_failed');
    expect(out.error).toContain('LE_RATE_LIMITED');
    expect(coverage.flagged).toHaveLength(1);
    expect(coverage.flagged[0].reason).toBe(CERT_RENEWAL_OVERDUE_DEGRADED_REASON);
    expect(audit.events[0].kind).toBe('cert_renewal_failed');
  });

  it('does NOT flag coverage degraded when failure is outside user-warning window', async () => {
    // Cert expiring in 30 days > 7-day user-warning window — failure
    // should audit but NOT flag coverage degraded.
    const fixture = mkStore({
      handle: 'alice',
      cert_pem: 'CURRENT',
      expires_at: Date.now() + 30 * 24 * 60 * 60 * 1000,
      renewal_recommended_at: Date.now() - 1,
    });
    const audit = mkAudit();
    const coverage = mkCoverage();
    const acme = mkAcme(async () => {
      throw new Error('LE_TRANSIENT');
    });
    await runCertRenewal({
      acme,
      store: fixture.store,
      generateCsr: () => validCsr,
      audit,
      coverage,
    });
    expect(coverage.flagged).toHaveLength(0);
    expect(audit.events[0].kind).toBe('cert_renewal_failed');
  });

  it('refuses to send a CSR with PRIVATE KEY (defensive)', async () => {
    const fixture = mkStore({
      handle: 'alice',
      cert_pem: 'CURRENT',
      expires_at: Date.now() + 5 * 24 * 60 * 60 * 1000,
      renewal_recommended_at: Date.now() - 1,
    });
    const audit = mkAudit();
    const coverage = mkCoverage();
    const acme = mkAcme();
    const badCsr = '-----BEGIN PRIVATE KEY-----\nBOOM\n-----END PRIVATE KEY-----';
    const out = await runCertRenewal({
      acme,
      store: fixture.store,
      generateCsr: () => badCsr,
      audit,
      coverage,
    });
    expect(out.outcome).toBe('renewal_failed');
    expect(out.error).toBe('csr_contained_private_key');
    expect(acme.issueCert).not.toHaveBeenCalled();
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0].error_code).toBe('csr_contained_private_key');
  });

  it('flags coverage_degraded when pre-flight CSR rejection happens within user-warning window (Codex MEDIUM #2 fold)', async () => {
    // Cert expiring in 5 days < 7-day user-warning window. Pre-
    // flight CSR rejection MUST flag coverage so the Reachability
    // Doctor surfaces the broken pipeline.
    const fixture = mkStore({
      handle: 'alice',
      cert_pem: 'CURRENT',
      expires_at: Date.now() + 5 * 24 * 60 * 60 * 1000,
      renewal_recommended_at: Date.now() - 1,
    });
    const audit = mkAudit();
    const coverage = mkCoverage();
    const acme = mkAcme();
    const badCsr = '-----BEGIN PRIVATE KEY-----\nBOOM\n-----END PRIVATE KEY-----';
    await runCertRenewal({
      acme,
      store: fixture.store,
      generateCsr: () => badCsr,
      audit,
      coverage,
    });
    expect(coverage.flagged).toHaveLength(1);
    expect(coverage.flagged[0].reason).toBe(CERT_RENEWAL_OVERDUE_DEGRADED_REASON);
    expect(coverage.flagged[0].args.last_error).toBe('csr_contained_private_key');
  });

  it('does NOT flag coverage_degraded for pre-flight rejection outside user-warning window', async () => {
    // 30 days > 7-day window; rejection is audited but no coverage
    // flag (the substrate has time before the user is impacted).
    const fixture = mkStore({
      handle: 'alice',
      cert_pem: 'CURRENT',
      expires_at: Date.now() + 30 * 24 * 60 * 60 * 1000,
      renewal_recommended_at: Date.now() - 1,
    });
    const audit = mkAudit();
    const coverage = mkCoverage();
    const acme = mkAcme();
    const badCsr = '-----BEGIN PRIVATE KEY-----\nBOOM\n-----END PRIVATE KEY-----';
    await runCertRenewal({
      acme,
      store: fixture.store,
      generateCsr: () => badCsr,
      audit,
      coverage,
    });
    expect(coverage.flagged).toHaveLength(0);
    expect(audit.events[0].error_code).toBe('csr_contained_private_key');
  });
});
