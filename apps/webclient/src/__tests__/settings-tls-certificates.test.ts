/** D-148 W3.8 — settings: TLS Certificates page renderer. */

import { describe, expect, it } from 'vitest';
import type {
  TLSDomainCertListEntry,
  TLSDomainUploadValidation,
} from '@recued/contracts';
import {
  TLS_CERT_MIN_VALIDITY_MS,
  TLS_CERT_SOURCE_LABEL,
  TLS_UPLOAD_ISSUE_COPY,
  buildTLSCertRow,
  buildTLSCertificatesPageModel,
  buildTLSDomainRemoveDispatch,
  buildTLSDomainUploadDispatch,
  projectUploadValidation,
} from '../settings/tls-certificates.js';

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

const entry = (
  override: Partial<TLSDomainCertListEntry> = {},
): TLSDomainCertListEntry => ({
  domain: 'alice.recued.cloud',
  fingerprint:
    'ab12cd34ef56789abcdef0123456789abcdef0123456789abcdef0123456789ab',
  expires_at: NOW + 90 * DAY,
  issuer: "Let's Encrypt",
  source: 'pro_acme',
  ...override,
});

describe('D-148 W3.8 — tls-certificates row builder', () => {
  it('healthy row with long-validity cert', () => {
    const r = buildTLSCertRow(entry(), { now_ms: NOW });
    expect(r.severity).toBe('healthy');
    expect(r.auto_renew).toBe(true);
    expect(r.renewal_due).toBe(false);
    expect(r.manual_renewal_hint).toBe(false);
    expect(r.source_label).toBe(TLS_CERT_SOURCE_LABEL.pro_acme);
    expect(r.days_until_expiry).toBeGreaterThan(80);
  });

  it('expiring_soon row when 20 days out', () => {
    const r = buildTLSCertRow(
      entry({ expires_at: NOW + 20 * DAY }),
      { now_ms: NOW },
    );
    expect(r.severity).toBe('expiring_soon');
    expect(r.renewal_due).toBe(false);
  });

  it('expiring_critical row when 5 days out (Pro: not renewal_due — auto-renews)', () => {
    const r = buildTLSCertRow(
      entry({ expires_at: NOW + 5 * DAY }),
      { now_ms: NOW },
    );
    expect(r.severity).toBe('expiring_critical');
    expect(r.renewal_due).toBe(false);
    expect(r.manual_renewal_hint).toBe(false);
  });

  it('expiring_critical row when 5 days out (BYO: renewal_due + manual hint)', () => {
    const r = buildTLSCertRow(
      entry({ expires_at: NOW + 5 * DAY, source: 'byo_upload' }),
      { now_ms: NOW },
    );
    expect(r.severity).toBe('expiring_critical');
    expect(r.renewal_due).toBe(true);
    expect(r.manual_renewal_hint).toBe(true);
    expect(r.auto_renew).toBe(false);
  });

  it('expired row when past expiry — renewal_due regardless of source', () => {
    const pro = buildTLSCertRow(
      entry({ expires_at: NOW - DAY }),
      { now_ms: NOW },
    );
    expect(pro.severity).toBe('expired');
    expect(pro.renewal_due).toBe(true);
    const byo = buildTLSCertRow(
      entry({ expires_at: NOW - DAY, source: 'byo_upload' }),
      { now_ms: NOW },
    );
    expect(byo.renewal_due).toBe(true);
  });

  it('expiring_soon manual hint surfaces on BYO source', () => {
    const r = buildTLSCertRow(
      entry({ expires_at: NOW + 20 * DAY, source: 'byo_upload' }),
      { now_ms: NOW },
    );
    expect(r.severity).toBe('expiring_soon');
    expect(r.manual_renewal_hint).toBe(true);
  });

  it('short fingerprint truncates correctly', () => {
    const r = buildTLSCertRow(entry(), { now_ms: NOW });
    expect(r.fingerprint_short.length).toBeLessThan(r.fingerprint_full.length);
    expect(r.fingerprint_short).toContain('…');
  });
});

describe('D-148 W3.8 — tls-certificates page model', () => {
  it('empty entries → healthy badge, no rows', () => {
    const m = buildTLSCertificatesPageModel({ entries: [], now_ms: NOW });
    expect(m.rows.length).toBe(0);
    expect(m.severity_summary.badge).toBe('healthy');
    expect(m.has_pro_managed).toBe(false);
    expect(m.has_byo_uploaded).toBe(false);
  });

  it('sorts rows expired → critical → soon → healthy → alpha', () => {
    const entries: TLSDomainCertListEntry[] = [
      entry({ domain: 'd.example.com', expires_at: NOW + 100 * DAY }),
      entry({ domain: 'b.example.com', expires_at: NOW - DAY }),
      entry({ domain: 'a.example.com', expires_at: NOW + 5 * DAY }),
      entry({ domain: 'c.example.com', expires_at: NOW + 20 * DAY }),
    ];
    const m = buildTLSCertificatesPageModel({ entries, now_ms: NOW });
    expect(m.rows.map((r) => r.domain)).toEqual([
      'b.example.com',
      'a.example.com',
      'c.example.com',
      'd.example.com',
    ]);
    expect(m.severity_summary.badge).toBe('critical');
  });

  it('attention badge when only soon entries exist', () => {
    const m = buildTLSCertificatesPageModel({
      entries: [entry({ expires_at: NOW + 20 * DAY })],
      now_ms: NOW,
    });
    expect(m.severity_summary.badge).toBe('attention');
    expect(m.has_pro_managed).toBe(true);
  });

  it('healthy badge when only healthy entries exist', () => {
    const m = buildTLSCertificatesPageModel({
      entries: [entry()],
      now_ms: NOW,
    });
    expect(m.severity_summary.badge).toBe('healthy');
  });

  it('has_byo_uploaded flips when at least one BYO present', () => {
    const m = buildTLSCertificatesPageModel({
      entries: [entry(), entry({ domain: 'b.example.com', source: 'byo_upload' })],
      now_ms: NOW,
    });
    expect(m.has_pro_managed).toBe(true);
    expect(m.has_byo_uploaded).toBe(true);
  });

  it('alphabetical tiebreak within same severity', () => {
    const entries: TLSDomainCertListEntry[] = [
      entry({ domain: 'b.example.com' }),
      entry({ domain: 'a.example.com' }),
    ];
    const m = buildTLSCertificatesPageModel({ entries, now_ms: NOW });
    expect(m.rows.map((r) => r.domain)).toEqual(['a.example.com', 'b.example.com']);
  });
});

describe('D-148 W3.8 — tls-domain dispatch builders', () => {
  it('buildTLSDomainUploadDispatch shapes payload correctly', () => {
    const d = buildTLSDomainUploadDispatch({
      domain: 'alice.recued.cloud',
      cert_pem: 'CERT',
      private_key_pem: 'KEY',
      chain_pem: 'CHAIN',
      source: 'byo_upload',
    });
    expect(d).toEqual({
      op: 'tls_domain.upload',
      domain: 'alice.recued.cloud',
      cert_pem: 'CERT',
      private_key_pem: 'KEY',
      chain_pem: 'CHAIN',
      source: 'byo_upload',
    });
  });

  it('buildTLSDomainUploadDispatch omits chain when undefined', () => {
    const d = buildTLSDomainUploadDispatch({
      domain: 'alice.recued.cloud',
      cert_pem: 'CERT',
      private_key_pem: 'KEY',
      source: 'pro_acme',
    });
    expect(d.chain_pem).toBeUndefined();
  });

  it('buildTLSDomainRemoveDispatch shapes payload correctly', () => {
    const d = buildTLSDomainRemoveDispatch('alice.recued.cloud');
    expect(d).toEqual({ op: 'tls_domain.remove', domain: 'alice.recued.cloud' });
  });
});

describe('D-148 W3.8 — upload validation projection', () => {
  it('failure case surfaces per-issue copy', () => {
    const validation: TLSDomainUploadValidation = {
      ok: false,
      issues: [
        { code: 'tls_san_mismatch', san: ['x.example.com'], domain: 'alice.recued.cloud' },
        { code: 'tls_key_pair_mismatch' },
      ],
    };
    const projected = projectUploadValidation(validation);
    expect(projected.ok).toBe(false);
    expect(projected.issues.length).toBe(2);
    expect(projected.issues[0]).toEqual({
      code: 'tls_san_mismatch',
      copy: TLS_UPLOAD_ISSUE_COPY.tls_san_mismatch,
    });
  });

  it('success without warns flags no expiry hint', () => {
    const validation: TLSDomainUploadValidation = {
      ok: true,
      expires_at: NOW + 60 * DAY,
      san: ['alice.recued.cloud'],
      warns: {},
    };
    const projected = projectUploadValidation(validation);
    expect(projected.ok).toBe(true);
    expect(projected.expires_at).toBe(NOW + 60 * DAY);
    expect(projected.expiry_within_7d).toBeUndefined();
  });

  it('success with expiry_within_7d warn flag passes through', () => {
    const validation: TLSDomainUploadValidation = {
      ok: true,
      expires_at: NOW + 3 * DAY,
      san: ['alice.recued.cloud'],
      warns: { expiry_within_7d: true },
    };
    const projected = projectUploadValidation(validation);
    expect(projected.ok).toBe(true);
    expect(projected.expiry_within_7d).toBe(true);
  });

  it('issue-copy registry exhausts every closed-list issue code', () => {
    for (const code of [
      'tls_san_mismatch',
      'tls_key_pair_mismatch',
      'tls_chain_invalid',
      'tls_cert_expired_at_upload',
    ] as const) {
      expect(TLS_UPLOAD_ISSUE_COPY[code]).toBeTruthy();
    }
  });

  it('TLS_CERT_MIN_VALIDITY_MS matches the contracts constant', () => {
    expect(TLS_CERT_MIN_VALIDITY_MS).toBe(7 * 86_400_000);
  });
});
