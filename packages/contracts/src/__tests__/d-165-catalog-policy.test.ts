import { describe, it, expect } from 'vitest';

import {
  HUBSPOT_CATALOG_SLUG,
  PIPEDRIVE_CATALOG_SLUG,
  SALESFORCE_CATALOG_SLUG,
  catalogSlugForVendor,
  isCatalogForm,
  resolveCatalogOperationPolicy,
  resolveCliReachabilityPolicy,
} from '../ingredient-catalog.js';
import type {
  ConnectionOperationProfile,
  OperationApproval,
  OperationRiskTier,
  OperationSpec,
  ProviderDefaultPolicy,
} from '../ingredient-catalog.js';

const op = (
  risk_tier: OperationRiskTier,
  extras: Partial<OperationSpec> = {},
): OperationSpec => ({
  operation_id: 'pub/cat.x',
  risk_tier,
  groups: ['g'],
  ...extras,
});

const profile = (
  extras: Partial<ConnectionOperationProfile> = {},
): ConnectionOperationProfile => ({
  allowed_operations: ['x'],
  ...extras,
});

const resolve = (
  operation: OperationSpec,
  extras: {
    profile?: ConnectionOperationProfile | null;
    default_policy?: ProviderDefaultPolicy;
  } = {},
) => resolveCatalogOperationPolicy({
  operations: { x: operation },
  operation_id: 'x',
  profile: Object.prototype.hasOwnProperty.call(extras, 'profile')
    ? extras.profile
    : profile(),
  ...(extras.default_policy ? { default_policy: extras.default_policy } : {}),
});

describe('D-165 catalog operation policy resolution', () => {
  it('maps registered vendors to catalog slugs with a prototype-safe guard', () => {
    expect(catalogSlugForVendor('hubspot')).toBe('hubspot-catalog');
    expect(catalogSlugForVendor('salesforce')).toBe('salesforce-catalog');
    expect(catalogSlugForVendor('pipedrive')).toBe(PIPEDRIVE_CATALOG_SLUG);
    expect(catalogSlugForVendor('unknownvendor')).toBeUndefined();
    expect(catalogSlugForVendor(undefined)).toBeUndefined();
    expect(catalogSlugForVendor(null)).toBeUndefined();

    for (const key of ['__proto__', 'constructor', 'hasOwnProperty']) {
      expect(catalogSlugForVendor(key)).toBeUndefined();
    }
  });

  it('derives effective_risk_tier from the catalog operation, never a wrapper static tier', () => {
    const operations = {
      x: {
        operation_id: 'pub/cat.x',
        risk_tier: 'destructive',
        groups: ['g'],
      },
    } satisfies Record<string, OperationSpec>;
    const args = {
      operations,
      operation_id: 'x',
      profile: { allowed_operations: ['x'] },
    };

    expect(args).not.toHaveProperty('risk_tier');
    expect(resolveCatalogOperationPolicy(args).effective_risk_tier).toBe('destructive');
  });

  it('fails closed when no profile exists or the operation is not granted', () => {
    expect(resolve(op('read'), { profile: undefined }).verdict).toBe('deny');
    expect(resolve(op('read'), { profile: undefined }).deny_reason).toBe('no_connection_profile');
    expect(resolve(op('read'), { profile: null }).verdict).toBe('deny');
    expect(resolve(op('read'), { profile: null }).deny_reason).toBe('no_connection_profile');

    const denied = resolve(op('read'), {
      profile: profile({ allowed_operations: ['other'] }),
    });

    expect(denied.verdict).toBe('deny');
    expect(denied.deny_reason).toBe('operation_not_granted');
  });

  it('denies undeclared operations and echoes the requested lookup key', () => {
    const resolution = resolveCatalogOperationPolicy({
      operations: {},
      operation_id: 'x',
      profile: profile(),
    });

    expect(resolution.verdict).toBe('deny');
    expect(resolution.deny_reason).toBe('operation_not_declared');
    expect(resolution.operation_id).toBe('x');
  });

  it('applies risk_overrides as stricter-wins only', () => {
    const escalated = resolve(op('read'), {
      profile: profile({ risk_overrides: { x: 'destructive' } }),
    });
    const notWeakened = resolve(op('destructive'), {
      profile: profile({ risk_overrides: { x: 'read' } }),
    });

    expect(escalated.effective_risk_tier).toBe('destructive');
    expect(notWeakened.effective_risk_tier).toBe('destructive');
  });

  it('maps risk tiers to approval/verdict defaults and lets stricter profile approval win', () => {
    const cases: Array<{
      risk: OperationRiskTier;
      approval: OperationApproval;
      verdict: 'admit' | 'ask';
    }> = [
      { risk: 'read', approval: 'never', verdict: 'admit' },
      { risk: 'write', approval: 'ask', verdict: 'ask' },
      { risk: 'destructive', approval: 'always', verdict: 'ask' },
    ];

    for (const c of cases) {
      const resolution = resolve(op(c.risk));
      expect(resolution.approval).toBe(c.approval);
      expect(resolution.verdict).toBe(c.verdict);
    }

    // D-209 §1.3 — a declared approval LOOSER than the risk floor is CLAMPED UP to
    // it, never honored below: a `write`-`never` op resolves `ask`, not a silent
    // admit. This is the floor clamp that closes the D-207 intake-door bypass at the
    // source (an author can no longer opt a write out of review).
    const explicitNever = resolve(op('write', { approval: 'never' }));
    expect(explicitNever.approval).toBe('ask');
    expect(explicitNever.verdict).toBe('ask');

    // The profile's `approval_defaults` still ESCALATES — it tightens the clamped
    // `ask` base up to `always` (owner-tightening runs AFTER the floor clamp).
    const profileEscalated = resolve(op('write', { approval: 'never' }), {
      profile: profile({ approval_defaults: { x: 'always' } }),
    });
    expect(profileEscalated.approval).toBe('always');
    expect(profileEscalated.verdict).toBe('ask');
  });

  it('D-209 §1.3/§1.6 — clamps a declared approval UP to the risk floor, never below', () => {
    // read floor = never: a read keeps its declared value (tightening allowed).
    expect(resolve(op('read', { approval: 'never' })).approval).toBe('never');
    expect(resolve(op('read', { approval: 'always' })).approval).toBe('always');
    // write / admin floor = ask: a declared `never` clamps UP to `ask`; `always` stays.
    expect(resolve(op('write', { approval: 'never' })).approval).toBe('ask');
    expect(resolve(op('write', { approval: 'ask' })).approval).toBe('ask');
    expect(resolve(op('write', { approval: 'always' })).approval).toBe('always');
    expect(resolve(op('admin', { approval: 'never' })).approval).toBe('ask');
    // destructive floor = always (§1.6): a declared `never` OR `ask` clamps UP to
    // `always` — a destructive op always holds, unweakenable by an author.
    expect(resolve(op('destructive', { approval: 'never' })).approval).toBe('always');
    expect(resolve(op('destructive', { approval: 'ask' })).approval).toBe('always');
    expect(resolve(op('destructive', { approval: 'always' })).approval).toBe('always');
  });

  it('honors default_policy deny unless an operation declares explicit approval', () => {
    const denied = resolve(op('write'), {
      default_policy: { write_default: 'deny' },
    });
    const explicitAsk = resolve(op('write', { approval: 'ask' }), {
      default_policy: { write_default: 'deny' },
    });

    expect(denied.verdict).toBe('deny');
    expect(denied.deny_reason).toBe('policy_denied');
    expect(explicitAsk.verdict).toBe('ask');
    expect(explicitAsk.deny_reason).toBeUndefined();
  });

  it('uses the canonical OperationSpec.operation_id on granted and declared paths', () => {
    const granted = resolve(op('read', { operation_id: 'pub/cat.canonical' }));
    const declaredDenied = resolve(op('read', { operation_id: 'pub/cat.canonical' }), {
      profile: profile({ allowed_operations: ['other'] }),
    });

    expect(granted.operation_id).toBe('pub/cat.canonical');
    expect(declaredDenied.operation_id).toBe('pub/cat.canonical');
  });

  it('sets operation_group to the first group or null when none is declared', () => {
    expect(resolve(op('read', { groups: ['primary', 'secondary'] })).operation_group).toBe('primary');
    expect(resolve(op('read', { groups: [] })).operation_group).toBeNull();
    expect(resolve(op('read', { groups: undefined })).operation_group).toBeNull();
  });

  it('denies a colliding short operation key when catalog slugs mismatch', () => {
    const operations = {
      'contact.read': op('read', {
        operation_id: 'recued-core/salesforce.contact.read',
        groups: ['recued-core/salesforce.contacts.read'],
      }),
    } satisfies Record<string, OperationSpec>;
    const seededForHubSpot = profile({
      allowed_operations: ['contact.read'],
      catalog_slug: HUBSPOT_CATALOG_SLUG,
    });

    const mismatched = resolveCatalogOperationPolicy({
      operations,
      operation_id: 'contact.read',
      profile: seededForHubSpot,
      catalog_slug: SALESFORCE_CATALOG_SLUG,
    });
    expect(mismatched.verdict).toBe('deny');
    expect(mismatched.deny_reason).toBe('catalog_mismatch');

    expect(resolveCatalogOperationPolicy({
      operations,
      operation_id: 'contact.read',
      profile: seededForHubSpot,
    }).verdict).toBe('admit');

    expect(resolveCatalogOperationPolicy({
      operations,
      operation_id: 'contact.read',
      profile: profile({ allowed_operations: ['contact.read'] }),
      catalog_slug: SALESFORCE_CATALOG_SLUG,
    }).verdict).toBe('admit');

    expect(resolveCatalogOperationPolicy({
      operations,
      operation_id: 'contact.read',
      profile: profile({
        allowed_operations: ['contact.read'],
        catalog_slug: SALESFORCE_CATALOG_SLUG,
      }),
      catalog_slug: SALESFORCE_CATALOG_SLUG,
    }).verdict).toBe('admit');
  });
});

describe('D-182 §7.2 cli operation policy resolution (per-contract reachability source)', () => {
  const resolveCli = (
    operation: OperationSpec,
    extras: {
      reachable?: boolean;
      default_policy?: ProviderDefaultPolicy;
    } = {},
  ) => resolveCliReachabilityPolicy({
    operations: { x: operation },
    operation_id: 'x',
    reachable: Object.prototype.hasOwnProperty.call(extras, 'reachable')
      ? extras.reachable!
      : true,
    ...(extras.default_policy ? { default_policy: extras.default_policy } : {}),
  });

  it('admits a reachable op — NEVER reaching no_connection_profile', () => {
    const res = resolveCli(op('read'));
    expect(res.verdict).toBe('admit');
    expect(res.granted).toBe(true);
    expect(res.deny_reason).toBeUndefined();
  });

  it('denies with cli_reachability_disabled when not reachable (the gap-closing reason, not no_connection_profile)', () => {
    const res = resolveCli(op('read'), { reachable: false });
    expect(res.verdict).toBe('deny');
    expect(res.deny_reason).toBe('cli_reachability_disabled');
    expect(res.granted).toBe(false);
    // The catalog-derived risk still rides the deny row.
    expect(res.effective_risk_tier).toBe('read');
  });

  it('denies undeclared operations BEFORE any reachability check, echoing the requested lookup key', () => {
    const res = resolveCliReachabilityPolicy({
      operations: {},
      operation_id: 'missing',
      // even reachable=true: an undeclared op is operation_not_declared, not admit.
      reachable: true,
    });
    expect(res.verdict).toBe('deny');
    expect(res.deny_reason).toBe('operation_not_declared');
    expect(res.operation_id).toBe('missing');
  });

  it('uses the catalog-declared risk as the effective tier (no per-op override source)', () => {
    expect(resolveCli(op('read')).effective_risk_tier).toBe('read');
    expect(resolveCli(op('admin')).effective_risk_tier).toBe('admin');
    // The reachable row authorizes exactly the dispatched op; the effective risk
    // is just the op's catalog-declared tier, feeding the approval stage — it is
    // NOT a key (the grid keys per OPERATION, never per risk tier).
    expect(resolveCli(op('destructive')).effective_risk_tier).toBe('destructive');
  });

  it('clamps a cli write op to the ask floor even when it declares approval:never (D-209 §1.3)', () => {
    expect(resolveCli(op('write')).verdict).toBe('ask');
    // D-209 §1.3 — a cli op declaring approval:never on a write tier (the whisper
    // audio.transcribe pattern, and the 82 shipped write-`never` cli ops) no longer
    // auto-admits: it is clamped UP to the `ask` floor. It HOLDS on an untrusted door
    // and relaxes on the owner's own trust (Slice B) — never a silent admit on a
    // public intake door.
    expect(resolveCli(op('write', { approval: 'never' })).verdict).toBe('ask');
  });

  it('honors default_policy deny unless the op declares explicit approval (granted:true, policy_denied)', () => {
    const res = resolveCli(op('write'), { default_policy: { write_default: 'deny' } });
    expect(res.verdict).toBe('deny');
    expect(res.deny_reason).toBe('policy_denied');
    expect(res.granted).toBe(true);

    // An explicit op-declared approval overrides the deny-class default policy.
    const explicit = resolveCli(op('write', { approval: 'ask' }), {
      default_policy: { write_default: 'deny' },
    });
    expect(explicit.verdict).toBe('ask');
    expect(explicit.deny_reason).toBeUndefined();
  });
});

describe('D-165 catalog-form detection', () => {
  it('requires a non-empty operations object', () => {
    expect(isCatalogForm({ operations: { x: op('read') } })).toBe(true);
    expect(isCatalogForm({ operations: {} })).toBe(false);
    expect(isCatalogForm(undefined)).toBe(false);
    expect(isCatalogForm(null)).toBe(false);
    expect(isCatalogForm({})).toBe(false);
    expect(isCatalogForm({ operations: [op('read')] })).toBe(false);
  });
});
