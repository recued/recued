/** D-223 § 7.2 / gate 9 — the trust seam is a rename, not a widening.
 *
 *  This slice exists so a future publisher-verification property has ONE place to
 *  land instead of a slug repeated across the validator and the pre-install
 *  planner. It must therefore change nothing today, and "changes nothing" is the
 *  thing to assert — a test that would pass equally before and after the refactor
 *  is exactly the point here, not a weakness. */

import { describe, expect, it } from 'vitest';

import {
  FIRST_PARTY_PUBLISHER,
  parseBulkPackManifest,
  publisherMayDeclare,
  reservedCapabilityMessage,
  type ReservedPackCapability,
} from '../index.js';

const CAPABILITIES: ReservedPackCapability[] = ['pre_install', 'connection_requirements'];

const pack = (over: Record<string, unknown>) => ({
  manifest_version: 2,
  artifact_type: 'pack',
  pack_kind: 'app_pack',
  slug: 'acme-tasks',
  publisher: 'third-party',
  name: 'Acme Tasks',
  description: 'Read and act on Acme tasks.',
  version: 1,
  recipes: [],
  requires: ['install_bulk_pack'],
  tags: ['pack:acme'],
  contents: [{ type: 'recipe', slug: 'list-tasks-acme', version: 1, visible: true }],
  ...over,
});

const codes = (over: Record<string, unknown>): string[] => {
  const parsed = parseBulkPackManifest(pack(over)) as {
    issues: Array<{ severity: string; code: string }>;
  };
  return parsed.issues.filter((i) => i.severity === 'error').map((i) => i.code);
};

const requirement = {
  api_base: 'https://api.acme.example',
  vendor: 'acme',
  auth: { type: 'bearer' },
};

describe('D-223 § 7.2 — publisher trust seam', () => {
  it('admits exactly the first-party publisher, for every capability', () => {
    for (const capability of CAPABILITIES) {
      expect(publisherMayDeclare(FIRST_PARTY_PUBLISHER, capability), capability).toBe(true);
      for (const other of ['third-party', 'recued', 'recued-core-ish', '', null, undefined, 0]) {
        expect(publisherMayDeclare(other, capability), `${capability}/${String(other)}`).toBe(false);
      }
    }
  });

  it('asks per capability even though every answer is currently the same', () => {
    // ⚠ The parameter is the extension point. § 7.2.1: presentation is earnable by
    // verification, vendor identity needs PER-VENDOR recognition, and reaching an
    // existing credential is the owner's call and earnable by nobody. Collapsing
    // this to one boolean is how verification would quietly answer all three.
    expect(publisherMayDeclare.length).toBe(2);
  });

  it('still refuses a third-party pre_install — unchanged', () => {
    expect(codes({ pre_install: true })).toContain('pack_pre_install_publisher');
    expect(codes({ publisher: FIRST_PARTY_PUBLISHER, pre_install: true }))
      .not.toContain('pack_pre_install_publisher');
  });

  it('still refuses third-party connection_requirements — unchanged', () => {
    expect(codes({ connection_requirements: [requirement] }))
      .toContain('pack_connection_requirements_publisher');
    expect(codes({ publisher: FIRST_PARTY_PUBLISHER, connection_requirements: [requirement] }))
      .not.toContain('pack_connection_requirements_publisher');
  });

  it('keeps the empty-array carve-out: declaring nothing is not declaring', () => {
    // The original gate deliberately fired on the meaningful assertion rather
    // than on the key's presence. A refactor that started refusing `[]` would be
    // a behaviour change wearing a rename's clothes.
    expect(codes({ connection_requirements: [] }))
      .not.toContain('pack_connection_requirements_publisher');
    expect(codes({ pre_install: false })).not.toContain('pack_pre_install_publisher');
  });

  it('D-223 hints stay open to everyone — the seam did not catch them', () => {
    // The whole point of the decision: a hint carries no authority, so it is not
    // a reserved capability and must not acquire a publisher gate by proximity.
    expect(codes({
      connection_hints: [{
        connection: 'acme',
        values: { 'config.base_url': 'https://api.acme.example' },
      }],
    })).toEqual([]);
  });

  it('shares one refusal wording between the validator and the planner', () => {
    const message = reservedCapabilityMessage('pre_install', 'third-party');
    expect(message).toContain('pre_install');
    expect(message).toContain(FIRST_PARTY_PUBLISHER);
    expect(message).toContain('"third-party"');
  });
});
