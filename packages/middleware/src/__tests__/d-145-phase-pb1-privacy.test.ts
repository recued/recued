/** D-145 PB1 — privacy-assertion test surface (§ N.16).
 *
 *  Constructs fixtures with deliberately identity-bearing strings
 *  and asserts none of them appear in any audit / transparency /
 *  cache surface. */

import { describe, expect, it } from 'vitest';

import * as capacity from '../capacity/index.js';
import {
  IDENTITY_BEARING_FIELDS,
  capacityParamsForAudit,
  type CapacitySpec,
} from '@recued/contracts';

import {
  buildStubProbeDeps,
  connKey,
  createStubControls,
} from './fixtures/d-145-pb1/stub-deps.js';

const IDENTITY_PROBE_VALUES = {
  contact_id: 'contact-pii-7f3e',
  email: 'jane.doe@example.com',
  phone: '+15551234567',
  address: '123 Pine St',
  mail_thread_id: 'thread-abc123',
  name: 'Jane Doe',
  connection_id: 'conn-pii-99',
};

const buildHarness = () => {
  const controls = createStubControls();
  const probeDeps = buildStubProbeDeps(controls);
  const invalidationSource = capacity.createCapacityInvalidationSource();
  const cache = capacity.createCapacityCache({ invalidationSource });
  const registry = capacity.createCapacityProbeRegistry(probeDeps);
  const audit: { action: string; detail: string; target: string }[] = [];
  const auditEmitter = capacity.createCapacityAuditEmitter({
    logActivity(entry) {
      audit.push({
        action: entry.action,
        detail: entry.detail ?? '',
        target: entry.target,
      });
    },
  });
  const [transparencyEmitter, transparency] =
    capacity.createCapturingTransparencyEmitter();
  return { controls, registry, cache, audit, transparency, auditEmitter, transparencyEmitter };
};

const containsAnyIdentity = (s: string): string | null => {
  for (const v of Object.values(IDENTITY_PROBE_VALUES)) {
    if (s.includes(v)) return v;
  }
  return null;
};

describe('D-145 PB1 — § N.16 P1 audit detail strips identity', () => {
  it('annotation ref is projected to ref_kind + ref_hash + path_template', async () => {
    const h = buildHarness();
    const spec: CapacitySpec = {
      capacities: [
        {
          kind: 'annotation',
          ref: `data.contact.${IDENTITY_PROBE_VALUES.contact_id}.aliases.facebook`,
        },
      ],
      remediations: {
        [`annotation:data.contact.${IDENTITY_PROBE_VALUES.contact_id}.aliases.facebook`]: {
          action: 'lazy_ask_user',
          user_facing_copy: 'Need handle.',
        },
      },
    };
    await capacity.walkCapacities({
      spec,
      registry: h.registry,
      cache: h.cache,
      ctx: {
        audit_emitter: h.auditEmitter,
        transparency_emitter: h.transparencyEmitter,
      },
    });
    expect(h.audit).toHaveLength(1);
    const detail = JSON.parse(h.audit[0]!.detail);
    expect(detail.gap_params.ref_kind).toBe('data.contact.aliases.facebook');
    expect(detail.gap_params.path_template).toBe('data.contact.{id}.aliases.facebook');
    // The contact_id MUST NOT appear in the JSON-stringified detail.
    expect(containsAnyIdentity(h.audit[0]!.detail)).toBeNull();
  });

  it('connection_id is hashed in audit projection', async () => {
    const h = buildHarness();
    const spec: CapacitySpec = {
      capacities: [
        {
          kind: 'connection_active',
          vendor: 'hubspot',
          entity: 'task',
          connection_id: IDENTITY_PROBE_VALUES.connection_id,
        },
      ],
      remediations: {
        [`connection_active:hubspot:task:${IDENTITY_PROBE_VALUES.connection_id}`]: {
          action: 'enroll_connection',
          user_facing_copy: 'Enroll.',
        },
      },
    };
    await capacity.walkCapacities({
      spec,
      registry: h.registry,
      cache: h.cache,
      ctx: {
        audit_emitter: h.auditEmitter,
        transparency_emitter: h.transparencyEmitter,
      },
    });
    expect(h.audit).toHaveLength(1);
    expect(containsAnyIdentity(h.audit[0]!.detail)).toBeNull();
  });
});

describe('D-145 PB1 — § N.16 P2 transparency event strips identity', () => {
  it('emitted event for annotation gap carries no raw ref', async () => {
    const h = buildHarness();
    const spec: CapacitySpec = {
      capacities: [
        {
          kind: 'annotation',
          ref: `data.contact.${IDENTITY_PROBE_VALUES.contact_id}.aliases.facebook`,
        },
      ],
      remediations: {
        [`annotation:data.contact.${IDENTITY_PROBE_VALUES.contact_id}.aliases.facebook`]: {
          action: 'lazy_ask_user',
          user_facing_copy: 'Need handle.',
        },
      },
    };
    await capacity.walkCapacities({
      spec,
      registry: h.registry,
      cache: h.cache,
      ctx: {
        audit_emitter: h.auditEmitter,
        transparency_emitter: h.transparencyEmitter,
      },
    });
    expect(h.transparency).toHaveLength(1);
    const json = JSON.stringify(h.transparency[0]);
    expect(containsAnyIdentity(json)).toBeNull();
  });
});

describe('D-145 PB1 — § N.16 P3 capacityParamsForAudit projection schema', () => {
  it('annotation projection has no identity field name', () => {
    const out = capacityParamsForAudit({
      kind: 'annotation',
      ref: `data.contact.${IDENTITY_PROBE_VALUES.contact_id}.aliases.facebook`,
    });
    const keys = Object.keys(out);
    for (const f of IDENTITY_BEARING_FIELDS) {
      expect(keys).not.toContain(f);
    }
  });

  it('connection_active projection has no identity field name', () => {
    const out = capacityParamsForAudit({
      kind: 'connection_active',
      vendor: 'hubspot',
      entity: 'task',
      connection_id: IDENTITY_PROBE_VALUES.connection_id,
    });
    const keys = Object.keys(out);
    for (const f of IDENTITY_BEARING_FIELDS) {
      expect(keys).not.toContain(f);
    }
  });

  it('every CapacityKind projection schema has no identity field name', () => {
    const projections = [
      capacityParamsForAudit({ kind: 'bridge_online' }),
      capacityParamsForAudit({ kind: 'annotation_not_required' }),
      capacityParamsForAudit({ kind: 'ingredient_installed', slug: 'x' }),
      capacityParamsForAudit({ kind: 'selector_freshness', slug: 'x' }),
      capacityParamsForAudit({ kind: 'logged_in', site: 'x.com' }),
      capacityParamsForAudit({
        kind: 'annotation',
        ref: 'data.contact.x.aliases.facebook',
      }),
      capacityParamsForAudit({ kind: 'permission_grant', permission: 'p' }),
      capacityParamsForAudit({
        kind: 'connection_active',
        vendor: 'v',
      }),
      capacityParamsForAudit({ kind: 'pool_quota_available', pool: 'free' }),
    ];
    for (const p of projections) {
      const keys = Object.keys(p);
      for (const f of IDENTITY_BEARING_FIELDS) {
        expect(keys).not.toContain(f);
      }
    }
  });
});
