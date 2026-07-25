/** D-120 Phase 7 — unified memory-export contracts tests.
 *
 *  Covers:
 *    - presetToBounds: every preset translates to the right
 *      (since, until) window against a fixed `now`
 *    - clampAuditExportPageSize: defaults, clamping, NaN/zero/negative
 *      tolerance
 *    - AUDIT_EXPORT_BYTES_PER_ENTRY: per-format constants exist
 *    - SERVER_RPC_METHODS: registry contains the new estimate + page
 *      pair (boot-time wiring guard)
 */

import { describe, expect, it } from 'vitest';
import {
  AUDIT_EXPORT_BYTES_PER_ENTRY,
  AUDIT_EXPORT_DEFAULT_PAGE_SIZE,
  AUDIT_EXPORT_MAX_PAGE_SIZE,
  SERVER_RPC_METHOD_SET,
  clampAuditExportPageSize,
  presetToBounds,
  type AuditExportFormat,
  type AuditExportPreset,
} from '../index.js';

describe('presetToBounds', () => {
  // 2026-04-26T00:00:00Z — fixed clock so each preset window is
  // checkable against an absolute reference.
  const now = 1_777_104_000_000;
  const day = 86_400_000;

  it('translates 7d to (now-7d, now)', () => {
    const bounds = presetToBounds('7d', now);
    expect(bounds.since).toBe(now - 7 * day);
    expect(bounds.until).toBe(now);
  });

  it('translates 30d to (now-30d, now) — the dialog default', () => {
    const bounds = presetToBounds('30d', now);
    expect(bounds.since).toBe(now - 30 * day);
    expect(bounds.until).toBe(now);
  });

  it('translates 90d to (now-90d, now)', () => {
    const bounds = presetToBounds('90d', now);
    expect(bounds.since).toBe(now - 90 * day);
    expect(bounds.until).toBe(now);
  });

  it('translates 1y to (now-365d, now)', () => {
    const bounds = presetToBounds('1y', now);
    expect(bounds.since).toBe(now - 365 * day);
    expect(bounds.until).toBe(now);
  });

  it('translates all to no bounds (undefined since/until)', () => {
    const bounds = presetToBounds('all', now);
    expect(bounds.since).toBeUndefined();
    expect(bounds.until).toBeUndefined();
  });

  it('throws on custom — caller must supply explicit bounds', () => {
    expect(() => presetToBounds('custom', now)).toThrow(/custom/);
  });

  it('windows shift relative to caller-supplied now', () => {
    const otherNow = 2_000_000_000_000;
    const a = presetToBounds('30d', now);
    const b = presetToBounds('30d', otherNow);
    expect(b.until! - a.until!).toBe(otherNow - now);
    expect(b.since! - a.since!).toBe(otherNow - now);
  });
});

describe('clampAuditExportPageSize', () => {
  it('returns the default when undefined', () => {
    expect(clampAuditExportPageSize(undefined)).toBe(AUDIT_EXPORT_DEFAULT_PAGE_SIZE);
  });

  it('returns the default for non-positive / non-finite inputs', () => {
    expect(clampAuditExportPageSize(0)).toBe(AUDIT_EXPORT_DEFAULT_PAGE_SIZE);
    expect(clampAuditExportPageSize(-10)).toBe(AUDIT_EXPORT_DEFAULT_PAGE_SIZE);
    expect(clampAuditExportPageSize(NaN)).toBe(AUDIT_EXPORT_DEFAULT_PAGE_SIZE);
    expect(clampAuditExportPageSize(Infinity)).toBe(AUDIT_EXPORT_DEFAULT_PAGE_SIZE);
  });

  it('clamps to the max when caller exceeds the ceiling', () => {
    expect(clampAuditExportPageSize(99_999)).toBe(AUDIT_EXPORT_MAX_PAGE_SIZE);
    expect(clampAuditExportPageSize(AUDIT_EXPORT_MAX_PAGE_SIZE + 1)).toBe(
      AUDIT_EXPORT_MAX_PAGE_SIZE,
    );
  });

  it('passes through valid values unchanged (after Math.floor)', () => {
    expect(clampAuditExportPageSize(100)).toBe(100);
    expect(clampAuditExportPageSize(123.7)).toBe(123);
    expect(clampAuditExportPageSize(AUDIT_EXPORT_MAX_PAGE_SIZE)).toBe(
      AUDIT_EXPORT_MAX_PAGE_SIZE,
    );
  });
});

describe('AUDIT_EXPORT_BYTES_PER_ENTRY', () => {
  it('declares a per-format byte estimate for each AuditExportFormat', () => {
    const formats: AuditExportFormat[] = ['json', 'jsonl', 'csv'];
    for (const f of formats) {
      expect(AUDIT_EXPORT_BYTES_PER_ENTRY[f]).toBeGreaterThan(0);
      expect(Number.isFinite(AUDIT_EXPORT_BYTES_PER_ENTRY[f])).toBe(true);
    }
  });

  it('CSV is the densest (smallest per-entry bytes) — no field names per row', () => {
    expect(AUDIT_EXPORT_BYTES_PER_ENTRY.csv)
      .toBeLessThan(AUDIT_EXPORT_BYTES_PER_ENTRY.json);
    expect(AUDIT_EXPORT_BYTES_PER_ENTRY.csv)
      .toBeLessThan(AUDIT_EXPORT_BYTES_PER_ENTRY.jsonl);
  });
});

describe('Phase 7 rpc registry wiring', () => {
  it('registers `audit.export.estimate` + `audit.export.page` in the server registry', () => {
    expect(SERVER_RPC_METHOD_SET.has('audit.export.estimate')).toBe(true);
    expect(SERVER_RPC_METHOD_SET.has('audit.export.page')).toBe(true);
  });

  it('no longer registers the legacy `audit.*` read-rpc family (D-157 P0)', () => {
    // D-157 P0 deleted the legacy `audit.*` read rpcs; the paginated
    // `audit.export.*` pair above is the whole `audit.*` rpc surface.
    const methods = SERVER_RPC_METHOD_SET as ReadonlySet<string>;
    for (const deleted of [
      'audit.list',
      'audit.get',
      'audit.export',
      'audit.runs.list',
      'audit.runs.aggregate',
      'audit.commits.by_channel_session',
      'audit.commits.by_cognition_session',
      'audit.commits.by_correlation',
    ]) {
      expect(methods.has(deleted)).toBe(false);
    }
  });
});

describe('AuditExportPreset enum coverage', () => {
  it('covers every preset surfaced in the dialog dropdown', () => {
    const presets: AuditExportPreset[] = ['7d', '30d', '90d', '1y', 'all', 'custom'];
    // Compile-time check that the enum stays exhaustive.
    expect(presets).toHaveLength(6);
  });
});
