/** D-149 P6 § A.5.3 line 760 — no-leak invariant tests.
 *
 *  Covers:
 *    - `buildIntakeFormPacketRawInput` strips fields in
 *      `user_only_field_names` AND honeypot fields from the visitor-
 *      visible payload.
 *    - The redacted-packet builder strict-picks at the boundary so
 *      any caller-supplied extras (per_field_visibility metadata,
 *      enum.values) do not appear in the visitor packet.
 *    - Required / optional field name arrays are intersected with the
 *      visible-field set (defense in depth — repeated at the redacted-
 *      packet substrate too).
 *    - `parseIntakeFormConfig` returns null for an invalid blob. */

import { describe, expect, it } from 'vitest';
import {
  PACKET_FIELDS_VISIBLE,
  buildRedactedPacket,
  type IntakeFormConfig,
} from '@recued/contracts';
import {
  buildIntakeFormPacketRawInput,
  buildIntakeFormSourceView,
  parseIntakeFormConfig,
} from '../ports/reception/transformations/intake-form.js';
import { buildReceptionPacket } from '../ports/reception/redacted-packet.js';

const NOW = 1_700_000_000_000;

const buildConfig = (): IntakeFormConfig => ({
  display_name: 'Mary',
  form_definition: {
    form_definition_id: 'fd_no_leak',
    fields: [
      { name: 'your_name', type: 'text', label: 'Your name', required: true },
      {
        name: 'service_interest',
        type: 'enum',
        label: 'Service',
        required: true,
        values: ['consulting', 'training'],
      },
      { name: 'website', type: 'text', label: 'Website', required: false },
    ],
    user_only_field_names: ['internal_classification'],
  },
  submission_processing_rule: {
    target_kind: 'task',
    fields_to_include_in_target: ['your_name', 'service_interest'],
    fields_to_attach_as_metadata: [],
  },
  anti_spam: {
    honeypot_fields: ['website'],
    rate_limit_per_ip: 5,
    require_proof_of_work: false,
    require_captcha: false,
  },
  required_visitor_fields: { email: 'required' },
});

describe('D-149 P6 § A.5.3 — buildIntakeFormPacketRawInput strips non-visitor fields', () => {
  it('drops fields in user_only_field_names', () => {
    const config = buildConfig();
    // Inject a user-only field on top of the existing visible set
    const source = buildIntakeFormSourceView(config, 'rl_hint');
    const augmented = {
      ...source,
      fields: [
        ...source.fields,
        {
          name: 'internal_classification',
          type: 'text' as const,
          label: 'Internal',
          required: false,
        },
      ],
    };
    const raw = buildIntakeFormPacketRawInput(augmented);
    const names = raw.form_definition.visitor_visible_fields.map((f) => f.name);
    expect(names).not.toContain('internal_classification');
  });

  it('drops fields in honeypot_fields', () => {
    const config = buildConfig();
    const source = buildIntakeFormSourceView(config, 'rl_hint');
    const raw = buildIntakeFormPacketRawInput(source);
    const names = raw.form_definition.visitor_visible_fields.map((f) => f.name);
    expect(names).not.toContain('website');
    expect(names).toContain('your_name');
    expect(names).toContain('service_interest');
  });

  it('drops enum values from the visitor packet (only label / type / required surface)', () => {
    const config = buildConfig();
    const source = buildIntakeFormSourceView(config, 'rl_hint');
    const raw = buildIntakeFormPacketRawInput(source);
    const enumField = raw.form_definition.visitor_visible_fields.find(
      (f) => f.name === 'service_interest',
    );
    expect(enumField).toBeDefined();
    // The closed visitor-visible field shape is intentionally narrow
    // (name / type / label / required). enum values stay server-side.
    expect(Object.keys(enumField!).sort()).toEqual([
      'label',
      'name',
      'required',
      'type',
    ]);
  });

  it('intersects required / optional with visible-field names', () => {
    const config = buildConfig();
    const source = buildIntakeFormSourceView(config, 'rl_hint');
    const augmented = {
      ...source,
      // Pre-fold required/optional arrays carry a stale name (would
      // leak through verbatim without intersection).
      required_fields: [...source.required_fields, 'internal_classification'],
      optional_fields: [...source.optional_fields, 'internal_classification'],
    };
    const raw = buildIntakeFormPacketRawInput(augmented);
    expect(raw.required_fields).not.toContain('internal_classification');
    expect(raw.optional_fields).not.toContain('internal_classification');
  });
});

describe('D-149 P6 § A.5.3 — buildReceptionPacket strict-picks fields_visible', () => {
  it('emits only the closed PACKET_FIELDS_VISIBLE.intake_form_packet keys', () => {
    const config = buildConfig();
    const source = buildIntakeFormSourceView(config, 'rl_hint');
    const raw = buildIntakeFormPacketRawInput(source);
    const built = buildReceptionPacket(
      'intake_form_packet',
      raw,
      {
        endpoint_id: 'ep-1',
        kind: 'intake_form_packet',
      },
      { now: NOW, randomToken: () => 'tok-test' },
    );
    const declared = PACKET_FIELDS_VISIBLE.intake_form_packet;
    expect(Object.keys(built.payload).sort()).toEqual([...declared].sort());
  });

  it('drops user_only fields end-to-end via the redacted-packet substrate', () => {
    const config = buildConfig();
    const source = buildIntakeFormSourceView(config, 'rl_hint');
    const raw = buildIntakeFormPacketRawInput(source);
    const built = buildReceptionPacket(
      'intake_form_packet',
      raw,
      {
        endpoint_id: 'ep-1',
        kind: 'intake_form_packet',
      },
      { now: NOW, randomToken: () => 'tok-test' },
    );
    const json = JSON.stringify(built.payload);
    expect(json).not.toContain('internal_classification');
    expect(json).not.toContain('website'); // honeypot
  });
});

describe('D-149 P6 § A.5.3 — substrate also runs at the underlying buildRedactedPacket', () => {
  it('the upstream substrate strict-picks regardless of caller-supplied extras', () => {
    const config = buildConfig();
    const source = buildIntakeFormSourceView(config, 'rl_hint');
    const raw = buildIntakeFormPacketRawInput(source);
    // Tag a metadata extra onto the raw shape via a cast — the
    // substrate's strict-pick must drop it from the payload.
    const tampered = {
      ...raw,
      per_field_visibility: { your_name: 'visitor' },
    } as typeof raw & { per_field_visibility: Record<string, string> };
    const packet = buildRedactedPacket('intake_form_packet', tampered, {
      now: NOW,
      randomToken: () => 'tok-test',
    });
    expect(Object.keys(packet.payload)).not.toContain('per_field_visibility');
  });
});

describe('D-149 P6 § A.5.3 — parseIntakeFormConfig', () => {
  it('returns the config when valid', () => {
    expect(parseIntakeFormConfig(buildConfig())).not.toBeNull();
  });

  it('returns null for an invalid blob', () => {
    expect(parseIntakeFormConfig({ not_a_config: true })).toBeNull();
    expect(parseIntakeFormConfig(null)).toBeNull();
    expect(parseIntakeFormConfig(undefined)).toBeNull();
  });
});
