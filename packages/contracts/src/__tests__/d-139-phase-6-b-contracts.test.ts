/** D-139 P6.B — contracts smoke tests for the post-substrate canary
 *  registry entry + value schema + bulk-pack manifest extensions +
 *  launch-flag constant.
 *
 *  Covers:
 *    - `commitment_tracker` topic registration with the full Pass-4
 *      D-136 substrate annotations (temporal_class × identity_aggregation
 *      × lifecycle_policy + compression_class + producer_kind +
 *      default_trust_state + default_pool_policy + valid_scopes +
 *      aggregates_from listing all per-type engagement scopes + warehouse
 *      collections (mail / calendar / audit)).
 *    - Pass-4 evidence-quality consumption defaults (`body_state_acceptance`
 *      / `authorship_acceptance` / `lifecycle_state_acceptance` /
 *      `dedupe_acceptance`) declared per topic per Pass-4 P6.B requirements.
 *    - Manual-trust default per D-132 + free-pool default per spec § P6.B.
 *    - `commitment_tracker` value schema validator-pass on canonical
 *      shapes + reject on body-shaped strings, unknown enum values,
 *      malformed actor_email, oversized payloads.
 *    - Bulk-pack manifest validator extensions: `post_substrate_canary`
 *      (boolean), `launch_flag` (non-empty string), and
 *      `mcp_body_visibility_grants[]` (closed allow-list).
 *    - Closed-list export for `BULK_PACK_BODY_VISIBILITY_GRANT_KEYS` +
 *      cap on `BULK_PACK_MAX_BODY_VISIBILITY_GRANTS`.
 *    - Launch-flag constant `CRM_COMMITMENT_TRACKER_LAUNCH_FLAG`
 *      matches the spec § P6.B sequencing literal.
 *
 *  Spec: D-139 § A.9.2c + § A.9.5 + § P6.B acceptance. */

import { describe, expect, it } from 'vitest';

import {
  ENRICHMENT_REGISTRY,
  scopesForCrmAlias,
  COMMITMENT_STATUSES,
  COMMITMENT_EVIDENCE_SOURCES,
  COMMITMENT_TEXT_MAX_CHARS,
  COMMITMENT_EVIDENCE_LINKS_MAX,
  COMMITMENT_TRACKER_COMMITMENTS_MAX,
  BULK_PACK_BODY_VISIBILITY_GRANT_KEYS,
  BULK_PACK_MAX_BODY_VISIBILITY_GRANTS,
  BULK_PACK_INSTALL_PERMISSION,
  BULK_INSTALL_PACK_VERSION,
  CRM_COMMITMENT_TRACKER_LAUNCH_FLAG,
  ENGAGEMENT_BODY_CONTENT_REGISTRY_KEY,
  isEnrichmentTopic,
  parseBulkPackManifest,
  type CommitmentStatus,
  type CommitmentEvidenceSource,
  type CommitmentTrackerValue,
} from '../index.js';

const HUBSPOT_CONTACT = 'connection.api.hubspot.contact' as const;
const SALESFORCE_CONTACT = 'connection.api.salesforce.contact' as const;

const FULL_AGGREGATES_FROM = [
  'mail',
  'calendar',
  'audit',
  'connection.api.hubspot.email',
  'connection.api.hubspot.meeting',
  'connection.api.hubspot.note',
  'connection.api.hubspot.call',
  'connection.api.hubspot.task',
  'connection.api.salesforce.task',
  'connection.api.salesforce.event',
  'connection.api.salesforce.email_message',
  'connection.api.salesforce.voice_call',
  'connection.api.salesforce.call_history',
];

// ────────────────────────────────────────────────────────────────
// commitment_tracker registry shape
// ────────────────────────────────────────────────────────────────

describe('D-139 P6.B — commitment_tracker topic registration', () => {
  it('topic resolves via isEnrichmentTopic', () => {
    expect(isEnrichmentTopic('commitment_tracker')).toBe(true);
  });
  it('carries time_bound × perspective × historical lifecycle per § A.9.2c', () => {
    const def = ENRICHMENT_REGISTRY.commitment_tracker;
    expect(def).toBeDefined();
    expect(def.temporal_class).toBe('time_bound');
    expect(def.identity_aggregation).toBe('perspective');
    expect(def.lifecycle_policy).toBe('historical');
  });
  it('valid_scopes mirrors the built-in crm_alias:contact scopes (D-192 E2b — incl. Pipedrive person)', () => {
    const def = ENRICHMENT_REGISTRY.commitment_tracker;
    // Static mirror of `scopesForCrmAlias('contact', CONNECTION_VENDOR_ENTITIES)`
    // (not derived here — import cycle). Kept in lockstep with the walk.
    expect([...(def.valid_scopes ?? [])].sort()).toEqual(
      [...scopesForCrmAlias('contact')].sort(),
    );
    expect(def.valid_scopes).toContain('connection.api.pipedrive.person');
  });
  it('aggregates_from enumerates mail + calendar + audit + per-type engagement scopes', () => {
    const def = ENRICHMENT_REGISTRY.commitment_tracker;
    expect([...(def.aggregates_from ?? [])].sort()).toEqual(
      [...FULL_AGGREGATES_FROM].sort(),
    );
  });
  it('default trust state = manual per D-132 (AI-surface)', () => {
    const def = ENRICHMENT_REGISTRY.commitment_tracker;
    expect(def.default_trust_state).toBe('manual');
  });
  it('default pool policy = free_only per spec § P6.B (cost-recovery rationale)', () => {
    const def = ENRICHMENT_REGISTRY.commitment_tracker;
    expect(def.default_pool_policy).toBe('free_only');
  });
  it('producer_kind = housekeeping (D-192 E2b — the reactive AI harness never shipped; runs as a standalone housekeeping task)', () => {
    const def = ENRICHMENT_REGISTRY.commitment_tracker;
    expect(def.producer_kind).toBe('housekeeping');
  });
  it('compression_class = derived (closed-list status + scalar confidence + bounded text)', () => {
    expect(ENRICHMENT_REGISTRY.commitment_tracker.compression_class).toBe('derived');
  });
  it('populates_coverage = true per § A.9.3', () => {
    expect(ENRICHMENT_REGISTRY.commitment_tracker.populates_coverage).toBe(true);
  });
  it('declares prompt_bias_hints per § A.14.3 (AI-surface producer)', () => {
    const def = ENRICHMENT_REGISTRY.commitment_tracker;
    expect(def.prompt_bias_hints).toBeDefined();
    expect(def.prompt_bias_hints!.length).toBeGreaterThan(0);
  });
  it('inputFingerprintComposition = perspective_fan_in (Gate 8 — perspective requires a composition)', () => {
    const def = ENRICHMENT_REGISTRY.commitment_tracker;
    expect(def.inputFingerprintComposition).toBe('perspective_fan_in');
  });
  it('declares an identity_extractor (Gate 6 — perspective topics MUST extract identity)', () => {
    const def = ENRICHMENT_REGISTRY.commitment_tracker;
    expect(def.identity_extractor).toBeDefined();
    expect(typeof def.identity_extractor).toBe('function');
  });
  it('as_of_field = computed_at (Gate 4 — non-stable_truth requires as_of)', () => {
    const def = ENRICHMENT_REGISTRY.commitment_tracker;
    expect(def.as_of_field).toBe('computed_at');
  });
  it('body_state_acceptance = inline_body only (full-context required for accurate extraction)', () => {
    const def = ENRICHMENT_REGISTRY.commitment_tracker;
    expect([...(def.body_state_acceptance ?? [])].sort()).toEqual(['inline_body']);
  });
  it('authorship_acceptance excludes crm_automation + system_process per Pass-4 R4.1', () => {
    const def = ENRICHMENT_REGISTRY.commitment_tracker;
    expect(def.authorship_acceptance).toBeDefined();
    const accept = new Set<string>(def.authorship_acceptance);
    expect(accept.has('crm_automation')).toBe(false);
    expect(accept.has('system_process')).toBe(false);
    expect(accept.has('integration')).toBe(false);
    expect(accept.has('import')).toBe(false);
    expect(accept.has('user')).toBe(true);
    expect(accept.has('crm_user')).toBe(true);
    expect(accept.has('unknown')).toBe(true);
  });
  it('lifecycle_state_acceptance is exact_only evidence states (point_in_time + completed)', () => {
    const def = ENRICHMENT_REGISTRY.commitment_tracker;
    expect([...(def.lifecycle_state_acceptance ?? [])].sort()).toEqual([
      'completed',
      'point_in_time',
    ]);
  });
  it('dedupe_acceptance = exact_only per Pass-4 R5.12 (probable twins counted separately)', () => {
    const def = ENRICHMENT_REGISTRY.commitment_tracker;
    expect(def.dedupe_acceptance).toBe('exact_only');
  });
});

// ────────────────────────────────────────────────────────────────
// commitment_tracker value-schema validation
// ────────────────────────────────────────────────────────────────

describe('D-139 P6.B — commitment_tracker value-schema enforcement', () => {
  const def = ENRICHMENT_REGISTRY.commitment_tracker;

  const wellFormed: CommitmentTrackerValue = {
    commitments: [
      {
        commitment_id: 'sha256:abcd1234',
        text: "I'll send the proposal by Friday.",
        status: 'pending',
        actor_email: 'rep@example.com',
        due_at: 1714867200000,
        evidence_links: [
          { source: 'mail', source_id: 'msg-1', source_at: 1714780800000 },
        ],
        extracted_at: 1714867200000,
        confidence: 0.85,
      },
    ],
    samples: 5,
    cursor_at: 1714867200000,
    computed_at: 1714867200000,
  };

  it('value_schema validates a well-formed value', () => {
    expect(def.value_schema!(wellFormed).ok).toBe(true);
  });

  it('value_schema rejects non-object payloads', () => {
    expect(def.value_schema!(null).ok).toBe(false);
    expect(def.value_schema!([]).ok).toBe(false);
    expect(def.value_schema!('not-an-object').ok).toBe(false);
  });

  it(`value_schema rejects body-shaped commitment.text > ${COMMITMENT_TEXT_MAX_CHARS} chars`, () => {
    const bad = {
      ...wellFormed,
      commitments: [
        {
          ...wellFormed.commitments[0]!,
          text: 'x'.repeat(COMMITMENT_TEXT_MAX_CHARS + 1),
        },
      ],
    };
    expect(def.value_schema!(bad).ok).toBe(false);
  });

  it('value_schema rejects empty commitment.text (would be content-free row)', () => {
    const bad = {
      ...wellFormed,
      commitments: [
        {
          ...wellFormed.commitments[0]!,
          text: '',
        },
      ],
    };
    expect(def.value_schema!(bad).ok).toBe(false);
  });

  it('value_schema rejects unknown commitment.status enum', () => {
    const bad = {
      ...wellFormed,
      commitments: [
        {
          ...wellFormed.commitments[0]!,
          status: 'in-progress' as CommitmentStatus,
        },
      ],
    };
    expect(def.value_schema!(bad).ok).toBe(false);
  });

  it('value_schema rejects malformed actor_email (no @)', () => {
    const bad = {
      ...wellFormed,
      commitments: [
        {
          ...wellFormed.commitments[0]!,
          actor_email: 'rep_at_example.com',
        },
      ],
    };
    expect(def.value_schema!(bad).ok).toBe(false);
  });

  it('value_schema rejects too-short actor_email (< 3 chars)', () => {
    const bad = {
      ...wellFormed,
      commitments: [
        {
          ...wellFormed.commitments[0]!,
          actor_email: 'a@',
        },
      ],
    };
    expect(def.value_schema!(bad).ok).toBe(false);
  });

  // Codex /codex:review P2 #3 fold-back — tighten actor_email shape
  // beyond "contains '@'". Body-paragraph strings with embedded email
  // addresses ("Forward to: rep@example.com please ASAP", "Sent: 2026-04-22
  // by rep@example.com") would have passed pre-fold but smuggle body
  // content through the actor_email slot the same way the text cap
  // closes the body path. Validator now requires email-shape regex +
  // 254-char cap (RFC 5321) so multi-paragraph + embedded-spaces +
  // newlines + trailing-content shapes all reject.
  it('value_schema rejects body-paragraph string with embedded email (Codex P2 #3 — body-text smuggling)', () => {
    const bad = {
      ...wellFormed,
      commitments: [
        {
          ...wellFormed.commitments[0]!,
          actor_email: 'Hello, please forward to rep@example.com ASAP — thanks!',
        },
      ],
    };
    expect(def.value_schema!(bad).ok).toBe(false);
  });

  it('value_schema rejects multi-line actor_email (Codex P2 #3)', () => {
    const bad = {
      ...wellFormed,
      commitments: [
        {
          ...wellFormed.commitments[0]!,
          actor_email: 'rep@example.com\nFollow-up: send PDF',
        },
      ],
    };
    expect(def.value_schema!(bad).ok).toBe(false);
  });

  it('value_schema rejects actor_email with whitespace (Codex P2 #3)', () => {
    const bad = {
      ...wellFormed,
      commitments: [
        {
          ...wellFormed.commitments[0]!,
          actor_email: 'rep at example.com',
        },
      ],
    };
    expect(def.value_schema!(bad).ok).toBe(false);
  });

  it('value_schema rejects actor_email longer than 254 chars (RFC 5321 cap, Codex P2 #3)', () => {
    const bad = {
      ...wellFormed,
      commitments: [
        {
          ...wellFormed.commitments[0]!,
          actor_email: `${'a'.repeat(245)}@example.com`,
        },
      ],
    };
    expect(def.value_schema!(bad).ok).toBe(false);
  });

  it('value_schema rejects actor_email with multiple @ symbols (Codex P2 #3 — comma-separated paste)', () => {
    const bad = {
      ...wellFormed,
      commitments: [
        {
          ...wellFormed.commitments[0]!,
          actor_email: 'rep@example.com,other@example.com',
        },
      ],
    };
    expect(def.value_schema!(bad).ok).toBe(false);
  });

  it('value_schema rejects actor_email with no domain TLD (Codex P2 #3)', () => {
    const bad = {
      ...wellFormed,
      commitments: [
        {
          ...wellFormed.commitments[0]!,
          actor_email: 'rep@localhost',
        },
      ],
    };
    expect(def.value_schema!(bad).ok).toBe(false);
  });

  it('value_schema accepts canonical email shapes', () => {
    const ok1 = {
      ...wellFormed,
      commitments: [{ ...wellFormed.commitments[0]!, actor_email: 'a@b.co' }],
    };
    const ok2 = {
      ...wellFormed,
      commitments: [
        { ...wellFormed.commitments[0]!, actor_email: 'first.last+tag@sub.example.co.uk' },
      ],
    };
    expect(def.value_schema!(ok1).ok).toBe(true);
    expect(def.value_schema!(ok2).ok).toBe(true);
  });

  it('value_schema rejects negative due_at', () => {
    const bad = {
      ...wellFormed,
      commitments: [
        {
          ...wellFormed.commitments[0]!,
          due_at: -1,
        },
      ],
    };
    expect(def.value_schema!(bad).ok).toBe(false);
  });

  it('value_schema accepts undefined due_at (no explicit due in source)', () => {
    const ok = {
      ...wellFormed,
      commitments: [
        {
          commitment_id: 'sha256:abcd1234',
          text: "I'll get back to you.",
          status: 'pending' as CommitmentStatus,
          actor_email: 'rep@example.com',
          evidence_links: [
            { source: 'mail' as CommitmentEvidenceSource, source_id: 'msg-1', source_at: 1 },
          ],
          extracted_at: 1714867200000,
          confidence: 0.7,
        },
      ],
    };
    expect(def.value_schema!(ok).ok).toBe(true);
  });

  it('value_schema rejects evidence_links beyond cap', () => {
    const bad = {
      ...wellFormed,
      commitments: [
        {
          ...wellFormed.commitments[0]!,
          evidence_links: Array.from(
            { length: COMMITMENT_EVIDENCE_LINKS_MAX + 1 },
            (_, i) => ({
              source: 'mail' as CommitmentEvidenceSource,
              source_id: `msg-${i}`,
              source_at: 1,
            }),
          ),
        },
      ],
    };
    expect(def.value_schema!(bad).ok).toBe(false);
  });

  it('value_schema rejects empty evidence_links (every commitment requires evidence per § P6.B)', () => {
    const bad = {
      ...wellFormed,
      commitments: [
        {
          ...wellFormed.commitments[0]!,
          evidence_links: [],
        },
      ],
    };
    expect(def.value_schema!(bad).ok).toBe(false);
  });

  it('value_schema rejects unknown evidence_link.source enum', () => {
    const bad = {
      ...wellFormed,
      commitments: [
        {
          ...wellFormed.commitments[0]!,
          evidence_links: [
            { source: 'whatsapp' as CommitmentEvidenceSource, source_id: 'msg-1', source_at: 1 },
          ],
        },
      ],
    };
    expect(def.value_schema!(bad).ok).toBe(false);
  });

  it('value_schema rejects vendor_url on non-attachment evidence (closed-list pairing)', () => {
    const bad = {
      ...wellFormed,
      commitments: [
        {
          ...wellFormed.commitments[0]!,
          evidence_links: [
            {
              source: 'mail' as CommitmentEvidenceSource,
              source_id: 'msg-1',
              source_at: 1,
              vendor_url: 'https://example.com/foo',
            },
          ],
        },
      ],
    };
    expect(def.value_schema!(bad).ok).toBe(false);
  });

  it('value_schema rejects filename on non-attachment evidence (closed-list pairing)', () => {
    const bad = {
      ...wellFormed,
      commitments: [
        {
          ...wellFormed.commitments[0]!,
          evidence_links: [
            {
              source: 'mail' as CommitmentEvidenceSource,
              source_id: 'msg-1',
              source_at: 1,
              filename: 'agenda.pdf',
            },
          ],
        },
      ],
    };
    expect(def.value_schema!(bad).ok).toBe(false);
  });

  it('value_schema accepts vendor_url + filename on attachment evidence', () => {
    const ok = {
      ...wellFormed,
      commitments: [
        {
          ...wellFormed.commitments[0]!,
          evidence_links: [
            {
              source: 'attachment' as CommitmentEvidenceSource,
              source_id: 'att-1',
              source_at: 1,
              vendor_url: 'https://api.hubspot.com/files/v3/files/attach-1/download',
              filename: 'agenda.pdf',
            },
          ],
        },
      ],
    };
    expect(def.value_schema!(ok).ok).toBe(true);
  });

  it('value_schema rejects confidence outside [0, 1]', () => {
    const lowBad = {
      ...wellFormed,
      commitments: [{ ...wellFormed.commitments[0]!, confidence: -0.1 }],
    };
    const highBad = {
      ...wellFormed,
      commitments: [{ ...wellFormed.commitments[0]!, confidence: 1.5 }],
    };
    expect(def.value_schema!(lowBad).ok).toBe(false);
    expect(def.value_schema!(highBad).ok).toBe(false);
  });

  it(`value_schema rejects commitments[] beyond ${COMMITMENT_TRACKER_COMMITMENTS_MAX}-cap`, () => {
    const tooMany = Array.from(
      { length: COMMITMENT_TRACKER_COMMITMENTS_MAX + 1 },
      (_, i) => ({
        commitment_id: `c-${i}`,
        text: `commitment ${i}`,
        status: 'pending' as CommitmentStatus,
        actor_email: 'rep@example.com',
        evidence_links: [
          { source: 'mail' as CommitmentEvidenceSource, source_id: `msg-${i}`, source_at: 1 },
        ],
        extracted_at: 1,
        confidence: 0.5,
      }),
    );
    const bad = { ...wellFormed, commitments: tooMany };
    expect(def.value_schema!(bad).ok).toBe(false);
  });

  it('value_schema rejects negative samples / cursor_at / computed_at', () => {
    expect(def.value_schema!({ ...wellFormed, samples: -1 }).ok).toBe(false);
    expect(def.value_schema!({ ...wellFormed, cursor_at: -1 }).ok).toBe(false);
    expect(def.value_schema!({ ...wellFormed, computed_at: -1 }).ok).toBe(false);
  });

  it('value_schema accepts empty commitments[] (honest-empty when nothing extracted yet)', () => {
    expect(def.value_schema!({ ...wellFormed, commitments: [] }).ok).toBe(true);
  });

  it('COMMITMENT_STATUSES enumerates closed-list status values', () => {
    expect([...COMMITMENT_STATUSES].sort()).toEqual([
      'broken',
      'cancelled',
      'expired',
      'fulfilled',
      'pending',
    ]);
  });

  it('COMMITMENT_EVIDENCE_SOURCES covers warehouse + per-type engagements + attachment', () => {
    const sources = new Set<string>(COMMITMENT_EVIDENCE_SOURCES);
    expect(sources.has('mail')).toBe(true);
    expect(sources.has('calendar')).toBe(true);
    expect(sources.has('memory')).toBe(true);
    expect(sources.has('engagement_email')).toBe(true);
    expect(sources.has('engagement_meeting')).toBe(true);
    expect(sources.has('engagement_note')).toBe(true);
    expect(sources.has('engagement_call')).toBe(true);
    expect(sources.has('engagement_task')).toBe(true);
    expect(sources.has('engagement_event')).toBe(true);
    expect(sources.has('engagement_email_message')).toBe(true);
    expect(sources.has('engagement_voice_call')).toBe(true);
    expect(sources.has('engagement_call_history')).toBe(true);
    expect(sources.has('attachment')).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// Bulk-pack manifest extension — D-139 P6.B fields
// ────────────────────────────────────────────────────────────────

const baseManifest: Record<string, unknown> = {
  manifest_version: BULK_INSTALL_PACK_VERSION,
  slug: 'crm-commitment-tracker-test',
  publisher: 'recued-core',
  name: 'Test pack',
  description: 'Test description',
  version: 1,
  recipes: [{ slug: 'commitment-tracker-producer-test', version: 1 }],
  requires: [BULK_PACK_INSTALL_PERMISSION],
  tags: ['pack:test'],
};

describe('D-139 P6.B — bulk-pack manifest validator extensions', () => {
  it('CRM_COMMITMENT_TRACKER_LAUNCH_FLAG matches the spec § P6.B sequencing literal', () => {
    expect(CRM_COMMITMENT_TRACKER_LAUNCH_FLAG).toBe('packs.crm_commitment_tracker.enabled');
  });

  it('BULK_PACK_BODY_VISIBILITY_GRANT_KEYS is a closed-list allow-list', () => {
    expect([...BULK_PACK_BODY_VISIBILITY_GRANT_KEYS]).toEqual([
      ENGAGEMENT_BODY_CONTENT_REGISTRY_KEY,
    ]);
    expect([...BULK_PACK_BODY_VISIBILITY_GRANT_KEYS]).toEqual([
      'data.contact.engagements.body_content',
    ]);
  });

  it('BULK_PACK_MAX_BODY_VISIBILITY_GRANTS bounds install-dialog UX complexity', () => {
    expect(BULK_PACK_MAX_BODY_VISIBILITY_GRANTS).toBeGreaterThan(0);
    expect(BULK_PACK_MAX_BODY_VISIBILITY_GRANTS).toBeLessThanOrEqual(10);
  });

  it('manifest validator accepts post_substrate_canary: true', () => {
    const result = parseBulkPackManifest({
      ...baseManifest,
      post_substrate_canary: true,
    });
    expect(result.ok).toBe(true);
  });

  it('manifest validator accepts post_substrate_canary: false', () => {
    const result = parseBulkPackManifest({
      ...baseManifest,
      post_substrate_canary: false,
    });
    expect(result.ok).toBe(true);
  });

  it('manifest validator rejects non-boolean post_substrate_canary', () => {
    const result = parseBulkPackManifest({
      ...baseManifest,
      post_substrate_canary: 'yes',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.code === 'pack_post_substrate_canary_shape')).toBe(true);
    }
  });

  it('manifest validator accepts launch_flag string', () => {
    const result = parseBulkPackManifest({
      ...baseManifest,
      launch_flag: 'packs.test.enabled',
    });
    expect(result.ok).toBe(true);
  });

  it('manifest validator rejects empty launch_flag string', () => {
    const result = parseBulkPackManifest({
      ...baseManifest,
      launch_flag: '',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.code === 'pack_launch_flag_shape')).toBe(true);
    }
  });

  it('manifest validator rejects non-string launch_flag', () => {
    const result = parseBulkPackManifest({
      ...baseManifest,
      launch_flag: 42,
    });
    expect(result.ok).toBe(false);
  });

  it('manifest validator accepts mcp_body_visibility_grants from the closed list', () => {
    const result = parseBulkPackManifest({
      ...baseManifest,
      mcp_body_visibility_grants: ['data.contact.engagements.body_content'],
    });
    expect(result.ok).toBe(true);
  });

  it('manifest validator accepts empty mcp_body_visibility_grants[] (deterministic packs default)', () => {
    const result = parseBulkPackManifest({
      ...baseManifest,
      mcp_body_visibility_grants: [],
    });
    expect(result.ok).toBe(true);
  });

  it('manifest validator rejects unknown body-visibility grant keys', () => {
    const result = parseBulkPackManifest({
      ...baseManifest,
      mcp_body_visibility_grants: ['data.contact.engagements.full_body'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some((i) => i.code === 'pack_body_visibility_grant_unknown'),
      ).toBe(true);
    }
  });

  it('manifest validator rejects duplicate body-visibility grants', () => {
    const result = parseBulkPackManifest({
      ...baseManifest,
      mcp_body_visibility_grants: [
        'data.contact.engagements.body_content',
        'data.contact.engagements.body_content',
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some((i) => i.code === 'pack_body_visibility_grant_duplicate'),
      ).toBe(true);
    }
  });

  it('manifest validator rejects body-visibility grants beyond cap', () => {
    const result = parseBulkPackManifest({
      ...baseManifest,
      mcp_body_visibility_grants: Array.from(
        { length: BULK_PACK_MAX_BODY_VISIBILITY_GRANTS + 1 },
        () => 'data.contact.engagements.body_content',
      ),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some((i) => i.code === 'pack_body_visibility_grants_too_many'),
      ).toBe(true);
    }
  });

  it('manifest validator rejects non-array mcp_body_visibility_grants', () => {
    const result = parseBulkPackManifest({
      ...baseManifest,
      mcp_body_visibility_grants: 'data.contact.engagements.body_content',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some((i) => i.code === 'pack_body_visibility_grants_shape'),
      ).toBe(true);
    }
  });

  it('manifest validator accepts the canonical P6.B post-substrate-canary shape', () => {
    const result = parseBulkPackManifest({
      ...baseManifest,
      post_substrate_canary: true,
      launch_flag: CRM_COMMITMENT_TRACKER_LAUNCH_FLAG,
      mcp_body_visibility_grants: [ENGAGEMENT_BODY_CONTENT_REGISTRY_KEY],
    });
    expect(result.ok, result.ok ? '' : JSON.stringify(result.issues, null, 2)).toBe(true);
  });

  it('manifest validator backward-compat: omitting all P6.B fields is fine (deterministic packs)', () => {
    const result = parseBulkPackManifest(baseManifest);
    expect(result.ok).toBe(true);
  });
});
