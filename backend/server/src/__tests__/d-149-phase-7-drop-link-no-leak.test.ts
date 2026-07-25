/** D-149 P7 § A.5.4 — no-leak invariant tests.
 *
 *  Covers:
 *    - `buildDropLinkPacketRawInput` strips user-only config fields
 *      (storage paths, blob ids, on_upload internals, contact-scoping,
 *      auto_attach_to_project_id) from the visitor-visible payload.
 *    - The redacted-packet substrate strict-picks at the boundary so
 *      any caller-supplied extras do NOT appear in the visitor packet.
 *    - `parseDropLinkConfig` returns null for an invalid blob.
 *    - The `drop_link_packet` PACKET_FIELDS_VISIBLE closed list matches
 *      the spec § A.4 + § A.5.4 contract. */

import { describe, expect, it } from 'vitest';
import {
  PACKET_FIELDS_VISIBLE,
  type DropLinkConfig,
} from '@recued/contracts';
import {
  buildDropLinkPacketRawInput,
  buildDropLinkSourceView,
  parseDropLinkConfig,
} from '../ports/reception/transformations/drop-link.js';
import { buildReceptionPacket } from '../ports/reception/redacted-packet.js';

const NOW = 1_700_000_000_000;

const buildConfig = (): DropLinkConfig => ({
  display_name: 'Mary',
  instructions: 'Send me the contract.',
  link_kind: 'repeated',
  contact_scoping: {
    contact_id: 'c_super_secret_internal',
    require_contact_email_match: true,
  },
  size_cap_bytes: 1024 * 1024,
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
    auto_attach_to_contact: true,
    auto_attach_to_project_id: 'proj_internal_secret',
  },
});

describe('D-149 P7 § A.5.4 — no-leak invariant', () => {
  it('redacted packet exposes ONLY visitor-visible fields', () => {
    const config = buildConfig();
    const rawInput = buildDropLinkPacketRawInput(buildDropLinkSourceView(config));
    const built = buildReceptionPacket(
      'drop_link_packet',
      rawInput,
      { endpoint_id: 'ep_1', kind: 'drop_link_packet' },
      { now: NOW, randomToken: () => 'tok' },
    );
    const payload = built.payload;
    const keys = Object.keys(payload);
    // PACKET_FIELDS_VISIBLE['drop_link_packet'] is the substrate's
    // closed list; payload keys must be a subset.
    const visible = PACKET_FIELDS_VISIBLE.drop_link_packet;
    for (const k of keys) {
      expect(visible.includes(k)).toBe(true);
    }
  });

  it('does not leak contact_scoping / auto_attach_to_project_id', () => {
    const config = buildConfig();
    const rawInput = buildDropLinkPacketRawInput(buildDropLinkSourceView(config));
    const built = buildReceptionPacket(
      'drop_link_packet',
      rawInput,
      { endpoint_id: 'ep_1', kind: 'drop_link_packet' },
      { now: NOW, randomToken: () => 'tok' },
    );
    const json = JSON.stringify(built.payload);
    expect(json).not.toContain('c_super_secret_internal');
    expect(json).not.toContain('proj_internal_secret');
    expect(json).not.toContain('recipe_internal_scan');
  });

  it('only emits the allowlist of fields documented in PACKET_FIELDS_VISIBLE', () => {
    expect([...PACKET_FIELDS_VISIBLE.drop_link_packet]).toEqual([
      'size_cap_bytes',
      'allowed_mime_types',
      'instructions',
      'required_visitor_fields',
      'one_time_use',
      'expiry_display',
    ]);
  });

  it('one_time_use mirrors the link_kind toggle', () => {
    const config: DropLinkConfig = { ...buildConfig(), link_kind: 'one_time' };
    const src = buildDropLinkSourceView(config);
    expect(src.one_time_use).toBe(true);
  });

  it('parseDropLinkConfig returns null for an invalid blob', () => {
    expect(parseDropLinkConfig(null)).toBeNull();
    expect(parseDropLinkConfig({ display_name: '' })).toBeNull();
    expect(parseDropLinkConfig({ ...buildConfig(), size_cap_bytes: 0 })).toBeNull();
  });

  it('parseDropLinkConfig accepts a valid blob', () => {
    expect(parseDropLinkConfig(buildConfig())).not.toBeNull();
  });
});
