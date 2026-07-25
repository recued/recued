/** D-182 slice 2 — kernel op registry + R1 verb-split runnability.
 *
 *  Pins the kernel domain registry, the canonical-verb partition + kernel-
 *  defined risk, and — the load-bearing part — the R1 runnability
 *  gatherer: bound → resolve; unbound read/search → empty + warn; unbound
 *  write/destructive (and any unrecognized verb, fail-safe) → fail closed. Plus
 *  the wire-on-top vendor→family derivation. */

import { describe, expect, it } from 'vitest';
import {
  KERNEL_CONNECTION_FAMILIES,
  isKernelConnectionFamily,
  KERNEL_DOMAINS,
  getKernelDomain,
  isKernelDomain,
  KERNEL_READ_VERBS,
  KERNEL_WRITE_VERBS,
  classifyCanonicalVerb,
  kernelVerbRiskTier,
  kernelOpRunnability,
  conventionFamilyForVendor,
  boundConventionFamilies,
  type KernelConnectionFamily,
} from '../kernel-ops.js';
import { CANONICAL_CRM_VERBS } from '../connection-agnostic.js';
import { approvalFloorForRisk } from '../ingredient-catalog.js';

const NONE: ReadonlySet<KernelConnectionFamily> = new Set();
const CRM_BOUND: ReadonlySet<KernelConnectionFamily> = new Set(['crm']);
const BOTH_BOUND: ReadonlySet<KernelConnectionFamily> = new Set(['crm', 'acct']);

describe('kernel domain registry (§3)', () => {
  it('registers the closed kinds + the crm/acct conventions', () => {
    const names = KERNEL_DOMAINS.map((d) => d.domain);
    for (const k of [
      'ai',
      'storage',
      'work-entity',
      'notification',
      'mail',
      'contact',
      'memory',
      'data',
      'webhook',
      'seller',
      'customer',
    ]) {
      expect(names).toContain(k);
      expect(getKernelDomain(k)?.class).toBe('closed_kind');
      expect(getKernelDomain(k)?.required_connection_kind).toBeUndefined();
    }
    expect(getKernelDomain('crm')).toEqual({
      domain: 'crm',
      class: 'canonical_convention',
      required_connection_kind: 'crm',
    });
    expect(getKernelDomain('acct')?.required_connection_kind).toBe('acct');
  });

  // D-207 §4.5 — D-196's `customer-access` domain was MERGED into `seller`
  // (`core.seller.customer-access.*`). Pinned negatively: re-adding the
  // top-level domain would re-open the split this merge closed, and the
  // registry's own load-time assert only fires for an op that DECLARES a
  // domain — a dangling domain row with no ops would sit here unnoticed.
  it('does not re-open the merged `customer-access` top-level domain (§4.5)', () => {
    expect(KERNEL_DOMAINS.map((d) => d.domain)).not.toContain('customer-access');
    expect(getKernelDomain('customer-access')).toBeUndefined();
  });

  it('only the conventions declare a required_connection_kind', () => {
    for (const d of KERNEL_DOMAINS) {
      expect(d.required_connection_kind !== undefined).toBe(d.class === 'canonical_convention');
    }
  });

  it('isKernelDomain / family predicates', () => {
    expect(isKernelDomain('crm')).toBe(true);
    expect(isKernelDomain('nope')).toBe(false);
    expect(KERNEL_CONNECTION_FAMILIES).toEqual(['crm', 'acct']);
    expect(isKernelConnectionFamily('crm')).toBe(true);
    expect(isKernelConnectionFamily('email')).toBe(false);
  });
});

describe('canonical-verb split (R1)', () => {
  it('read/write verb sets partition CANONICAL_CRM_VERBS exactly', () => {
    expect([...KERNEL_READ_VERBS, ...KERNEL_WRITE_VERBS].sort()).toEqual([...CANONICAL_CRM_VERBS].sort());
    // disjoint
    for (const v of KERNEL_READ_VERBS) expect(KERNEL_WRITE_VERBS).not.toContain(v);
  });

  it('classifies each verb', () => {
    expect(classifyCanonicalVerb('read')).toBe('read');
    expect(classifyCanonicalVerb('search')).toBe('read');
    expect(classifyCanonicalVerb('create')).toBe('write');
    expect(classifyCanonicalVerb('update')).toBe('write');
    expect(classifyCanonicalVerb('delete')).toBe('write');
    expect(classifyCanonicalVerb('frobnicate')).toBeNull();
  });

  it('kernel-defined verb → risk tier', () => {
    expect(kernelVerbRiskTier('read')).toBe('read');
    expect(kernelVerbRiskTier('search')).toBe('read');
    expect(kernelVerbRiskTier('create')).toBe('write');
    expect(kernelVerbRiskTier('update')).toBe('write');
    expect(kernelVerbRiskTier('delete')).toBe('destructive');
    expect(kernelVerbRiskTier('nope')).toBeNull();
  });

  // D-209 §5b follow-on. This replaces a retired `kernelVerbApproval` test that
  // pinned `delete` → 'ask'. That fn was a SECOND approval derivation and it was
  // wrong in the dangerous direction: `ask` RELAXES to admit when op-risk <= the
  // ceiling, so a destructive convention op would have run silently on an `admin`
  // ceiling once anything wired it. Approval now composes from the verb's RISK
  // through the single enforced floor — which is where the tier's teeth are.
  it('verb → risk → the ENFORCED approval floor (delete is always, not ask)', () => {
    const approvalForVerb = (verb: string) => {
      const risk = kernelVerbRiskTier(verb);
      return risk === null ? null : approvalFloorForRisk(risk);
    };
    expect(approvalForVerb('read')).toBe('never');
    expect(approvalForVerb('search')).toBe('never');
    expect(approvalForVerb('create')).toBe('ask');
    // the retired map said 'ask' here — the enforced floor says 'always', and
    // only 'always' survives `applyTrustCeiling`.
    expect(approvalForVerb('delete')).toBe('always');
    expect(approvalForVerb('nope')).toBeNull();
  });
});

describe('kernelOpRunnability — R1 (§10 step 8)', () => {
  it('closed-kind kernel ops are always runnable (no required family)', () => {
    expect(kernelOpRunnability('core.ai.summarize', NONE)).toEqual({ runnable: true });
    expect(kernelOpRunnability('core.work-entity.commitment.create', NONE)).toEqual({ runnable: true });
    expect(kernelOpRunnability('core.data.timeline', NONE)).toEqual({ runnable: true });
  });

  it('a convention op is runnable when its family is bound', () => {
    expect(kernelOpRunnability('core.crm.deal.search', CRM_BOUND)).toEqual({
      runnable: true,
      required_connection_kind: 'crm',
    });
    expect(kernelOpRunnability('core.crm.deal.create', CRM_BOUND)?.runnable).toBe(true);
    expect(kernelOpRunnability('core.acct.invoice.search', BOTH_BOUND)?.runnable).toBe(true);
  });

  it('UNBOUND read/search → empty result + warning (downstream-safe)', () => {
    const r = kernelOpRunnability('core.crm.deal.search', NONE);
    expect(r?.runnable).toBe(false);
    expect(r?.unbound_behavior).toBe('empty_result_warn');
    expect(r?.required_connection_kind).toBe('crm');
    expect(r?.warning).toMatch(/crm not connected/i);
    expect(kernelOpRunnability('core.crm.deal.read', NONE)?.unbound_behavior).toBe('empty_result_warn');
  });

  it('UNBOUND write/destructive → fail closed (never a silent no-op)', () => {
    for (const verb of ['create', 'update', 'delete']) {
      const r = kernelOpRunnability(`core.crm.deal.${verb}`, NONE);
      expect(r?.runnable).toBe(false);
      expect(r?.unbound_behavior).toBe('fail_closed');
      expect(r?.required_connection_kind).toBe('crm');
      expect(r?.warning).toMatch(/connect a crm provider/i);
    }
    // acct write blocks too when acct is unbound, even if crm is bound.
    expect(kernelOpRunnability('core.acct.invoice.create', CRM_BOUND)?.unbound_behavior).toBe('fail_closed');
  });

  it('UNBOUND with an unrecognized verb fails CLOSED (fail-safe, not empty)', () => {
    const r = kernelOpRunnability('core.crm.deal.frobnicate', NONE);
    expect(r?.runnable).toBe(false);
    expect(r?.unbound_behavior).toBe('fail_closed');
  });

  it('UNBOUND MALFORMED canonical op fails CLOSED, never silently emptied', () => {
    // Unknown alias for the convention (`invoice` is not a crm_alias) — a read
    // verb must NOT mask the authoring error as an empty result.
    expect(kernelOpRunnability('core.crm.invoice.search', NONE)?.unbound_behavior).toBe('fail_closed');
    // Extra-segment remainder — not a well-formed `<alias>.<verb>`.
    expect(kernelOpRunnability('core.crm.deal.extra.search', NONE)?.unbound_behavior).toBe('fail_closed');
    // Same for the acct convention (a crm alias is not an acct_alias).
    expect(kernelOpRunnability('core.acct.deal.search', NONE)?.unbound_behavior).toBe('fail_closed');
    // Sanity: the well-formed sibling DOES empty (the guard is shape, not blanket).
    expect(kernelOpRunnability('core.crm.deal.search', NONE)?.unbound_behavior).toBe('empty_result_warn');
  });

  it('returns null for a non-kernel op or an unregistered domain', () => {
    expect(kernelOpRunnability('recued-core.whisper.audio.transcribe', NONE)).toBeNull(); // Tier-P
    expect(kernelOpRunnability('core.bogus.read', NONE)).toBeNull(); // unknown domain
    expect(kernelOpRunnability('garbage', NONE)).toBeNull();
  });
});

describe('conventionFamilyForVendor + boundConventionFamilies (wire-on-top)', () => {
  it('derives the family from the built-in vendor registry', () => {
    expect(conventionFamilyForVendor('hubspot')).toBe('crm');
    expect(conventionFamilyForVendor('salesforce')).toBe('crm');
    expect(conventionFamilyForVendor('linear')).toBeNull(); // not registered / non-canonical
  });

  it('a 3rd-party CRM vendor in a supplied registry participates', () => {
    const registry = [
      {
        vendor: 'acme-crm',
        entity: 'deal',
        scope: 'connection.api.acme-crm.deal' as const,
        display_name: 'Acme deal',
        meta_fields: [],
        crm_alias: 'deal' as const,
      },
    ];
    expect(conventionFamilyForVendor('acme-crm', registry)).toBe('crm');
  });

  it('builds the bound-families set, dropping non-canonical vendors', () => {
    expect([...boundConventionFamilies(['hubspot', 'linear'])]).toEqual(['crm']);
    expect(boundConventionFamilies([]).size).toBe(0);
  });

  it('round-trips through the gatherer: bound hubspot makes core.crm.* runnable', () => {
    const bound = boundConventionFamilies(['hubspot']);
    expect(kernelOpRunnability('core.crm.deal.create', bound)?.runnable).toBe(true);
    // but an acct write still blocks (no acct vendor bound)
    expect(kernelOpRunnability('core.acct.invoice.create', bound)?.unbound_behavior).toBe('fail_closed');
  });
});
