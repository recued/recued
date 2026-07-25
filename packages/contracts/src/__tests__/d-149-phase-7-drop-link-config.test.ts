/** D-149 P7 § A.5.4 — `DropLinkConfig` + upload validator tests.
 *
 *  Covers:
 *    - Closed-shape gate on every required field.
 *    - Closed allowlist of MIME types — substrate code change required.
 *    - Size cap clamped at `[DROP_LINK_SIZE_CAP_MIN_BYTES,
 *      DROP_LINK_SIZE_CAP_HARD_MAX_BYTES]`; hard ceiling enforced.
 *    - Expiry days clamped at `[1, 30]` per § N.4.
 *    - Per-day cap clamped at `[1, 1000]`.
 *    - `required_visitor_fields.*` ∈ closed list.
 *    - `on_upload.notification_target` ∈ closed list.
 *    - Upload validator: per-field caps, MIME-allowlist intersection,
 *      filename presence, size_cap_bytes guard, domain-allowlist gating.
 *    - RECEPTION_RPC_ERROR_CODE_SET extension for
 *      `drop_link_config_invalid`. */

import { describe, expect, it } from 'vitest';
import {
  DROP_LINK_ALLOWED_MIME_TYPES,
  DROP_LINK_ALLOWED_MIME_TYPE_SET,
  DROP_LINK_DOMAIN_ALLOWLIST_ENTRY_MAX,
  DROP_LINK_DOMAIN_ALLOWLIST_MAX,
  DROP_LINK_EXPIRY_DAYS_MAX,
  DROP_LINK_MAX_UPLOADS_PER_DAY_MAX,
  DROP_LINK_MAX_UPLOADS_PER_DAY_MIN,
  DROP_LINK_PROCESSING_OUTCOMES,
  DROP_LINK_PROCESSING_OUTCOME_SET,
  DROP_LINK_SCAN_STATUSES,
  DROP_LINK_SCAN_STATUS_SET,
  DROP_LINK_SIZE_CAP_HARD_MAX_BYTES,
  DROP_LINK_SIZE_CAP_MIN_BYTES,
  DROP_LINK_VISITOR_DESCRIPTION_MAX,
  DROP_LINK_VISITOR_EMAIL_MAX,
  DROP_LINK_VISITOR_FILENAME_MAX,
  DROP_LINK_VISITOR_NAME_MAX,
  RECEPTION_RPC_ERROR_CODE_SET,
  validateDropLinkConfig,
  validateDropLinkUpload,
  type DropLinkConfig,
  type DropLinkUploadInput,
} from '../index.js';

const goodConfig: DropLinkConfig = {
  display_name: 'Mary Smith',
  instructions: 'Send me your contract PDF.',
  success_message: 'Got it.',
  submit_button_label: 'Send',
  template_ref: 'foundation:drop/contract_intake',
  link_kind: 'repeated',
  size_cap_bytes: 10 * 1024 * 1024,
  allowed_mime_types: ['application/pdf'],
  expiry_days: 7,
  max_uploads_per_endpoint_per_day: 50,
  required_visitor_fields: {
    name: 'required',
    email: 'required',
    description: 'optional',
  },
  on_upload: {
    create_data_file_entity: true,
    auto_attach_to_contact: false,
  },
};

describe('D-149 P7 § A.5.4 — validateDropLinkConfig', () => {
  it('accepts a minimal valid config', () => {
    expect(validateDropLinkConfig(goodConfig)).toEqual([]);
  });

  it('rejects non-object input', () => {
    expect(validateDropLinkConfig(null)[0]?.code).toBe('config_shape_invalid');
    expect(validateDropLinkConfig([])[0]?.code).toBe('config_shape_invalid');
    expect(validateDropLinkConfig('mary')[0]?.code).toBe('config_shape_invalid');
    expect(validateDropLinkConfig(undefined as unknown)[0]?.code).toBe(
      'config_shape_invalid',
    );
  });

  it('rejects empty display_name', () => {
    expect(
      validateDropLinkConfig({ ...goodConfig, display_name: '' })[0]?.code,
    ).toBe('display_name_empty');
    expect(
      validateDropLinkConfig({ ...goodConfig, display_name: '   ' })[0]?.code,
    ).toBe('display_name_empty');
  });

  it('rejects oversize display_name / instructions / success_message / submit_button_label', () => {
    expect(
      validateDropLinkConfig({ ...goodConfig, display_name: 'a'.repeat(101) })[0]?.code,
    ).toBe('display_name_too_long');
    expect(
      validateDropLinkConfig({ ...goodConfig, instructions: 'a'.repeat(801) })[0]?.code,
    ).toBe('instructions_too_long');
    expect(
      validateDropLinkConfig({ ...goodConfig, success_message: 'a'.repeat(401) })[0]?.code,
    ).toBe('success_message_too_long');
    expect(
      validateDropLinkConfig({ ...goodConfig, submit_button_label: 'a'.repeat(61) })[0]
        ?.code,
    ).toBe('submit_button_label_too_long');
  });

  it('rejects unknown link_kind', () => {
    expect(
      validateDropLinkConfig({
        ...goodConfig,
        link_kind: 'forever' as unknown as DropLinkConfig['link_kind'],
      })[0]?.code,
    ).toBe('link_kind_unknown');
  });

  it('rejects size_cap_bytes below floor / above ceiling / non-integer', () => {
    expect(
      validateDropLinkConfig({ ...goodConfig, size_cap_bytes: 100 })[0]?.code,
    ).toBe('size_cap_out_of_range');
    expect(
      validateDropLinkConfig({
        ...goodConfig,
        size_cap_bytes: DROP_LINK_SIZE_CAP_HARD_MAX_BYTES + 1,
      })[0]?.code,
    ).toBe('size_cap_out_of_range');
    expect(
      validateDropLinkConfig({
        ...goodConfig,
        size_cap_bytes: 1024.5,
      })[0]?.code,
    ).toBe('size_cap_out_of_range');
  });

  it('accepts size_cap_bytes at exact boundaries', () => {
    expect(
      validateDropLinkConfig({
        ...goodConfig,
        size_cap_bytes: DROP_LINK_SIZE_CAP_MIN_BYTES,
      }),
    ).toEqual([]);
    expect(
      validateDropLinkConfig({
        ...goodConfig,
        size_cap_bytes: DROP_LINK_SIZE_CAP_HARD_MAX_BYTES,
      }),
    ).toEqual([]);
  });

  it('rejects empty / oversize / unknown MIME allowlist', () => {
    expect(
      validateDropLinkConfig({
        ...goodConfig,
        allowed_mime_types: [],
      })[0]?.code,
    ).toBe('allowed_mime_types_empty');
    const tooMany = DROP_LINK_ALLOWED_MIME_TYPES.length + 1;
    expect(
      validateDropLinkConfig({
        ...goodConfig,
        allowed_mime_types: new Array(tooMany).fill(
          'application/pdf',
        ) as DropLinkConfig['allowed_mime_types'],
      })[0]?.code,
    ).toBe('allowed_mime_types_too_many');
    expect(
      validateDropLinkConfig({
        ...goodConfig,
        allowed_mime_types: ['application/x-msdownload'] as unknown as DropLinkConfig['allowed_mime_types'],
      })[0]?.code,
    ).toBe('allowed_mime_type_unknown');
  });

  it('rejects expiry_days out of range', () => {
    expect(
      validateDropLinkConfig({ ...goodConfig, expiry_days: 0 })[0]?.code,
    ).toBe('expiry_days_out_of_range');
    expect(
      validateDropLinkConfig({
        ...goodConfig,
        expiry_days: DROP_LINK_EXPIRY_DAYS_MAX + 1,
      })[0]?.code,
    ).toBe('expiry_days_out_of_range');
  });

  it('rejects max_uploads_per_endpoint_per_day out of range', () => {
    expect(
      validateDropLinkConfig({
        ...goodConfig,
        max_uploads_per_endpoint_per_day: 0,
      })[0]?.code,
    ).toBe('max_uploads_out_of_range');
    expect(
      validateDropLinkConfig({
        ...goodConfig,
        max_uploads_per_endpoint_per_day: DROP_LINK_MAX_UPLOADS_PER_DAY_MAX + 1,
      })[0]?.code,
    ).toBe('max_uploads_out_of_range');
  });

  it('rejects required_visitor_fields without all three required keys', () => {
    expect(
      validateDropLinkConfig({
        ...goodConfig,
        required_visitor_fields: { name: 'required', email: 'required' } as unknown as DropLinkConfig['required_visitor_fields'],
      })[0]?.code,
    ).toBe('visitor_fields_invalid');
    expect(
      validateDropLinkConfig({
        ...goodConfig,
        required_visitor_fields: {
          name: 'sometimes',
          email: 'required',
          description: 'optional',
        } as unknown as DropLinkConfig['required_visitor_fields'],
      })[0]?.code,
    ).toBe('visitor_fields_invalid');
  });

  // Codex review P2 fold (2026-05-13) — `omit` is in the substrate-
  // wide visitor-field requirement union for forward-compat across
  // reception kinds, but the drop_link packet validator + spec § A.5.4
  // restrict to `required | optional`. The config validator rejects
  // `omit` at the rpc edge so a stale config can't reach the visitor
  // render path where it would throw mid-render.
  it('rejects omit in required_visitor_fields (matches packet validator + spec § A.5.4)', () => {
    expect(
      validateDropLinkConfig({
        ...goodConfig,
        required_visitor_fields: {
          name: 'omit',
          email: 'required',
          description: 'optional',
        } as unknown as DropLinkConfig['required_visitor_fields'],
      })[0]?.code,
    ).toBe('visitor_fields_invalid');
    expect(
      validateDropLinkConfig({
        ...goodConfig,
        required_visitor_fields: {
          name: 'required',
          email: 'omit',
          description: 'optional',
        } as unknown as DropLinkConfig['required_visitor_fields'],
      })[0]?.code,
    ).toBe('visitor_fields_invalid');
    expect(
      validateDropLinkConfig({
        ...goodConfig,
        required_visitor_fields: {
          name: 'required',
          email: 'required',
          description: 'omit',
        } as unknown as DropLinkConfig['required_visitor_fields'],
      })[0]?.code,
    ).toBe('visitor_fields_invalid');
  });

  it('REFUSES on_upload.notification_target — retired, not merely closed-list-gated', () => {
    // ⚠ D-210 Phase C RE-AIMED. This pinned "reject a value outside the closed
    // list". The list is gone: it was a per-endpoint copy of the D-158 channel
    // vocabulary that never dispatched. Channels are chosen in Settings and the
    // inbox fanout mode picks the surface, so ANY value here is now refused.

    expect(
      validateDropLinkConfig({
        ...goodConfig,
        on_upload: {
          ...goodConfig.on_upload,
          notification_target: 'webclient' as unknown as string,
        },
      })[0]?.code,
    ).toBe('notification_target_unknown');
  });

  it('rejects on_upload booleans of wrong type', () => {
    expect(
      validateDropLinkConfig({
        ...goodConfig,
        on_upload: {
          ...goodConfig.on_upload,
          create_data_file_entity: 'yes' as unknown as boolean,
        },
      })[0]?.code,
    ).toBe('on_upload_invalid');
    expect(
      validateDropLinkConfig({
        ...goodConfig,
        on_upload: {
          ...goodConfig.on_upload,
          auto_attach_to_contact: 1 as unknown as boolean,
        },
      })[0]?.code,
    ).toBe('on_upload_invalid');
  });

  it('rejects empty triggered_recipe_id / auto_attach_to_project_id', () => {
    expect(
      validateDropLinkConfig({
        ...goodConfig,
        on_upload: {
          ...goodConfig.on_upload,
          triggered_recipe_id: '',
        },
      })[0]?.code,
    ).toBe('triggered_recipe_id_invalid');
    expect(
      validateDropLinkConfig({
        ...goodConfig,
        on_upload: {
          ...goodConfig.on_upload,
          auto_attach_to_project_id: '',
        },
      })[0]?.code,
    ).toBe('auto_attach_to_project_id_invalid');
  });

  it('rejects contact_scoping shape mismatch', () => {
    expect(
      validateDropLinkConfig({
        ...goodConfig,
        contact_scoping: { contact_id: '', require_contact_email_match: true },
      })[0]?.code,
    ).toBe('contact_scoping_invalid');
    expect(
      validateDropLinkConfig({
        ...goodConfig,
        contact_scoping: {
          contact_id: 'c_123',
          require_contact_email_match: 'true' as unknown as boolean,
        },
      })[0]?.code,
    ).toBe('contact_scoping_invalid');
  });

  it('rejects oversize known_domain_allowlist', () => {
    const tooMany = DROP_LINK_DOMAIN_ALLOWLIST_MAX + 1;
    expect(
      validateDropLinkConfig({
        ...goodConfig,
        known_domain_allowlist: new Array(tooMany).fill('example.com'),
      })[0]?.code,
    ).toBe('domain_allowlist_too_many');
    expect(
      validateDropLinkConfig({
        ...goodConfig,
        known_domain_allowlist: ['a'.repeat(DROP_LINK_DOMAIN_ALLOWLIST_ENTRY_MAX + 1)],
      })[0]?.code,
    ).toBe('domain_allowlist_entry_too_long');
  });

  it('exposes closed-list constants the substrate relies on', () => {
    expect(DROP_LINK_ALLOWED_MIME_TYPE_SET.size).toBe(DROP_LINK_ALLOWED_MIME_TYPES.length);
    expect(DROP_LINK_PROCESSING_OUTCOME_SET.size).toBe(
      DROP_LINK_PROCESSING_OUTCOMES.length,
    );
    expect(DROP_LINK_SCAN_STATUS_SET.size).toBe(DROP_LINK_SCAN_STATUSES.length);
  });

  it('reserves rpc error code for drop_link_config_invalid', () => {
    expect(RECEPTION_RPC_ERROR_CODE_SET.has('drop_link_config_invalid')).toBe(true);
  });
});

describe('D-149 P7 § A.5.4 — validateDropLinkUpload', () => {
  const baseUpload: DropLinkUploadInput = {
    visitor_name: 'Mary',
    visitor_email: 'mary@example.com',
    visitor_description: 'Contract for review.',
    mime_type_reported: 'application/pdf',
    filename: 'contract.pdf',
    size_bytes: 1024,
  };

  it('accepts a valid upload', () => {
    expect(validateDropLinkUpload(baseUpload, goodConfig)).toEqual([]);
  });

  it('requires visitor_name when configured required', () => {
    expect(
      validateDropLinkUpload({ ...baseUpload, visitor_name: '' }, goodConfig)[0]?.code,
    ).toBe('visitor_name_required');
  });

  it('caps visitor_name at the substrate ceiling', () => {
    expect(
      validateDropLinkUpload(
        { ...baseUpload, visitor_name: 'a'.repeat(DROP_LINK_VISITOR_NAME_MAX + 1) },
        goodConfig,
      )[0]?.code,
    ).toBe('visitor_name_too_long');
  });

  it('rejects an unparseable email', () => {
    expect(
      validateDropLinkUpload({ ...baseUpload, visitor_email: 'not-an-email' }, goodConfig)[0]
        ?.code,
    ).toBe('visitor_email_invalid');
  });

  it('caps visitor_email at the substrate ceiling', () => {
    const long = `${'a'.repeat(DROP_LINK_VISITOR_EMAIL_MAX)}@example.com`;
    expect(
      validateDropLinkUpload({ ...baseUpload, visitor_email: long }, goodConfig)[0]?.code,
    ).toBe('visitor_email_too_long');
  });

  it('caps visitor_description at the substrate ceiling', () => {
    expect(
      validateDropLinkUpload(
        {
          ...baseUpload,
          visitor_description: 'a'.repeat(DROP_LINK_VISITOR_DESCRIPTION_MAX + 1),
        },
        goodConfig,
      )[0]?.code,
    ).toBe('visitor_description_too_long');
  });

  it('treats optional visitor fields as not-required when absent', () => {
    const optionalCfg: DropLinkConfig = {
      ...goodConfig,
      required_visitor_fields: {
        name: 'optional',
        email: 'optional',
        description: 'optional',
      },
    };
    expect(
      validateDropLinkUpload(
        {
          mime_type_reported: 'application/pdf',
          filename: 'x.pdf',
          size_bytes: 1024,
        },
        optionalCfg,
      ),
    ).toEqual([]);
  });

  it('rejects MIME types outside the per-config allowlist', () => {
    expect(
      validateDropLinkUpload(
        { ...baseUpload, mime_type_reported: 'image/jpeg' },
        goodConfig,
      )[0]?.code,
    ).toBe('mime_type_not_allowed');
  });

  it('rejects empty filename / oversize filename', () => {
    expect(
      validateDropLinkUpload({ ...baseUpload, filename: '' }, goodConfig)[0]?.code,
    ).toBe('filename_invalid');
    expect(
      validateDropLinkUpload(
        {
          ...baseUpload,
          filename: 'a'.repeat(DROP_LINK_VISITOR_FILENAME_MAX + 1),
        },
        goodConfig,
      )[0]?.code,
    ).toBe('filename_invalid');
  });

  it('rejects when size_bytes exceeds size_cap_bytes', () => {
    expect(
      validateDropLinkUpload(
        { ...baseUpload, size_bytes: goodConfig.size_cap_bytes + 1 },
        goodConfig,
      )[0]?.code,
    ).toBe('size_cap_exceeded');
  });

  it('rejects domains outside the allowlist', () => {
    const cfgWithAllowlist: DropLinkConfig = {
      ...goodConfig,
      known_domain_allowlist: ['example.org'],
    };
    expect(
      validateDropLinkUpload(
        { ...baseUpload, visitor_email: 'leaked@evil.example' },
        cfgWithAllowlist,
      )[0]?.code,
    ).toBe('visitor_email_domain_rejected');
  });
});
