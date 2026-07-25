/** D-149 P9 § A.5.6 — status-link config validator tests. */

import { describe, expect, it } from 'vitest';
import {
  STATUS_LINK_CAPTION_MAX,
  STATUS_LINK_DISPLAY_NAME_MAX,
  STATUS_LINK_EXPIRY_DAYS_MAX,
  STATUS_LINK_EXPIRY_DAYS_MIN,
  STATUS_LINK_REFRESH_INTERVAL_SECONDS_MAX,
  STATUS_LINK_REFRESH_INTERVAL_SECONDS_MIN,
  validateStatusLinkConfig,
  type StatusLinkConfig,
} from '../status-link-config.js';
import {
  STATUS_LINK_PROJECTION_KIND_SET,
  STATUS_LINK_PROJECTION_KINDS,
  STATUS_PROJECTION_FIELDS_VISIBLE,
  type StatusLinkProjectionKind,
} from '../redacted-packets.js';
import {
  SOURCE_QUERY_KINDS_PERMITTED_PER_PACKET_KIND,
} from '../reception-source-query.js';

const baseConfig = (overrides: Partial<StatusLinkConfig> = {}): StatusLinkConfig => ({
  display_name: 'Mary',
  projection_kind: 'project',
  source_ref: { kind: 'data.project', project_id: 'proj-123' },
  refresh_policy: { auto_refresh_enabled: true, refresh_interval_seconds: 60 },
  comments_enabled: false,
  shows_update_history: true,
  expiry_days: 30,
  ...overrides,
});

describe('D-149 P9 § A.5.6 — validateStatusLinkConfig', () => {
  it('accepts a well-formed project config', () => {
    expect(validateStatusLinkConfig(baseConfig())).toEqual([]);
  });

  it('accepts every projection kind with a matching source ref', () => {
    const matrix: Array<{
      projection_kind: StatusLinkProjectionKind;
      source_ref: StatusLinkConfig['source_ref'];
    }> = [
      { projection_kind: 'event_plan', source_ref: { kind: 'data.event', event_id: 'evt-1' } },
      { projection_kind: 'itinerary', source_ref: { kind: 'data.itinerary', itinerary_id: 'it-1' } },
      { projection_kind: 'project', source_ref: { kind: 'data.project', project_id: 'p-1' } },
      { projection_kind: 'packing_list', source_ref: { kind: 'data.packing_list', list_id: 'l-1' } },
      { projection_kind: 'commitment_summary', source_ref: { kind: 'data.commitment', commitment_id: 'c-1' } },
      { projection_kind: 'custom', source_ref: { kind: 'data.note', note_id: 'n-1' } },
    ];
    for (const row of matrix) {
      expect(validateStatusLinkConfig(baseConfig(row))).toEqual([]);
    }
  });

  it('rejects non-object config', () => {
    expect(validateStatusLinkConfig(null)[0]?.code).toBe('config_shape_invalid');
    expect(validateStatusLinkConfig('string')[0]?.code).toBe('config_shape_invalid');
    expect(validateStatusLinkConfig([])[0]?.code).toBe('config_shape_invalid');
  });

  it('rejects empty display_name', () => {
    const failures = validateStatusLinkConfig(baseConfig({ display_name: '' }));
    expect(failures.some((f) => f.code === 'display_name_empty')).toBe(true);
  });

  it('rejects overlong display_name', () => {
    const failures = validateStatusLinkConfig(
      baseConfig({ display_name: 'x'.repeat(STATUS_LINK_DISPLAY_NAME_MAX + 1) }),
    );
    expect(failures.some((f) => f.code === 'display_name_too_long')).toBe(true);
  });

  it('rejects overlong caption', () => {
    const failures = validateStatusLinkConfig(
      baseConfig({ caption: 'x'.repeat(STATUS_LINK_CAPTION_MAX + 1) }),
    );
    expect(failures.some((f) => f.code === 'caption_too_long')).toBe(true);
  });

  it('rejects non-string caption', () => {
    const failures = validateStatusLinkConfig({
      ...baseConfig(),
      caption: 42,
    } as unknown);
    expect(failures.some((f) => f.code === 'caption_too_long')).toBe(true);
  });

  it('rejects unknown projection_kind', () => {
    const failures = validateStatusLinkConfig({
      ...baseConfig(),
      projection_kind: 'banana',
    } as unknown);
    expect(failures.some((f) => f.code === 'projection_kind_unknown')).toBe(true);
  });

  it('rejects non-object source_ref', () => {
    const failures = validateStatusLinkConfig({
      ...baseConfig(),
      source_ref: 'data.project',
    } as unknown);
    expect(failures.some((f) => f.code === 'source_ref_invalid')).toBe(true);
  });

  it('rejects unknown source_ref.kind', () => {
    const failures = validateStatusLinkConfig({
      ...baseConfig(),
      source_ref: { kind: 'vault.secret', secret_id: 'x' },
    } as unknown);
    expect(failures.some((f) => f.code === 'source_ref_kind_unknown')).toBe(true);
  });

  it('rejects vault.* / data.memory.* / data.enrichment.* paths', () => {
    for (const kind of ['vault.api_key', 'data.memory.audit', 'data.enrichment.contact']) {
      const failures = validateStatusLinkConfig({
        ...baseConfig(),
        source_ref: { kind, id: 'x' },
      } as unknown);
      expect(failures.some((f) => f.code === 'source_ref_kind_unknown')).toBe(true);
    }
  });

  it('rejects source_ref missing id field', () => {
    const failures = validateStatusLinkConfig({
      ...baseConfig(),
      source_ref: { kind: 'data.project' },
    } as unknown);
    expect(failures.some((f) => f.code === 'source_ref_missing_id_field')).toBe(true);
  });

  it('rejects source_ref with empty id field', () => {
    const failures = validateStatusLinkConfig({
      ...baseConfig(),
      source_ref: { kind: 'data.project', project_id: '' },
    } as unknown);
    expect(failures.some((f) => f.code === 'source_ref_missing_id_field')).toBe(true);
  });

  it('rejects fields_visible_override beyond the per-projection ceiling', () => {
    const failures = validateStatusLinkConfig(
      baseConfig({
        projection_kind: 'project',
        fields_visible_override: ['title', 'internal_codename'],
      }),
    );
    expect(failures.some((f) => f.code === 'fields_visible_override_exceeds_ceiling')).toBe(true);
  });

  it('accepts fields_visible_override that is a subset of the ceiling', () => {
    const failures = validateStatusLinkConfig(
      baseConfig({
        projection_kind: 'project',
        fields_visible_override: ['title', 'state'],
      }),
    );
    expect(failures).toEqual([]);
  });

  it('rejects non-array fields_visible_override', () => {
    const failures = validateStatusLinkConfig({
      ...baseConfig(),
      fields_visible_override: 'title',
    } as unknown);
    expect(failures.some((f) => f.code === 'fields_visible_override_invalid')).toBe(true);
  });

  it('rejects refresh_policy that is not an object', () => {
    const failures = validateStatusLinkConfig({
      ...baseConfig(),
      refresh_policy: 'on',
    } as unknown);
    expect(failures.some((f) => f.code === 'refresh_policy_invalid')).toBe(true);
  });

  it('rejects refresh_policy with non-boolean auto_refresh_enabled', () => {
    const failures = validateStatusLinkConfig({
      ...baseConfig(),
      refresh_policy: { auto_refresh_enabled: 'yes' },
    } as unknown);
    expect(failures.some((f) => f.code === 'refresh_policy_invalid')).toBe(true);
  });

  it('rejects auto_refresh_enabled=true without refresh_interval_seconds', () => {
    const failures = validateStatusLinkConfig({
      ...baseConfig(),
      refresh_policy: { auto_refresh_enabled: true },
    } as unknown);
    expect(failures.some((f) => f.code === 'refresh_interval_required_when_enabled')).toBe(true);
  });

  it('rejects refresh_interval below minimum', () => {
    const failures = validateStatusLinkConfig(
      baseConfig({
        refresh_policy: {
          auto_refresh_enabled: true,
          refresh_interval_seconds: STATUS_LINK_REFRESH_INTERVAL_SECONDS_MIN - 1,
        },
      }),
    );
    expect(failures.some((f) => f.code === 'refresh_interval_out_of_range')).toBe(true);
  });

  it('rejects refresh_interval above maximum', () => {
    const failures = validateStatusLinkConfig(
      baseConfig({
        refresh_policy: {
          auto_refresh_enabled: true,
          refresh_interval_seconds: STATUS_LINK_REFRESH_INTERVAL_SECONDS_MAX + 1,
        },
      }),
    );
    expect(failures.some((f) => f.code === 'refresh_interval_out_of_range')).toBe(true);
  });

  it('accepts refresh_policy with auto_refresh_enabled=false and no interval', () => {
    const failures = validateStatusLinkConfig(
      baseConfig({
        refresh_policy: { auto_refresh_enabled: false },
      }),
    );
    expect(failures).toEqual([]);
  });

  it('rejects comments_enabled=true at v1', () => {
    const failures = validateStatusLinkConfig(baseConfig({ comments_enabled: true }));
    expect(failures.some((f) => f.code === 'comments_enabled_must_be_false_at_v1')).toBe(true);
  });

  it('rejects non-boolean comments_enabled', () => {
    const failures = validateStatusLinkConfig({
      ...baseConfig(),
      comments_enabled: 'no',
    } as unknown);
    expect(failures.some((f) => f.code === 'config_shape_invalid')).toBe(true);
  });

  it('rejects non-boolean shows_update_history', () => {
    const failures = validateStatusLinkConfig({
      ...baseConfig(),
      shows_update_history: 1,
    } as unknown);
    expect(failures.some((f) => f.code === 'shows_update_history_invalid')).toBe(true);
  });

  it('rejects expiry_days below minimum', () => {
    const failures = validateStatusLinkConfig(
      baseConfig({ expiry_days: STATUS_LINK_EXPIRY_DAYS_MIN - 1 }),
    );
    expect(failures.some((f) => f.code === 'expiry_days_out_of_range')).toBe(true);
  });

  it('rejects expiry_days above maximum', () => {
    const failures = validateStatusLinkConfig(
      baseConfig({ expiry_days: STATUS_LINK_EXPIRY_DAYS_MAX + 1 }),
    );
    expect(failures.some((f) => f.code === 'expiry_days_out_of_range')).toBe(true);
  });

  it('rejects non-integer expiry_days', () => {
    const failures = validateStatusLinkConfig(baseConfig({ expiry_days: 30.5 }));
    expect(failures.some((f) => f.code === 'expiry_days_out_of_range')).toBe(true);
  });

  it('rejects empty template_ref', () => {
    const failures = validateStatusLinkConfig(baseConfig({ template_ref: '' }));
    expect(failures.some((f) => f.code === 'template_ref_invalid')).toBe(true);
  });

  it('accepts non-empty template_ref', () => {
    const failures = validateStatusLinkConfig(baseConfig({ template_ref: 'foundation:project' }));
    expect(failures).toEqual([]);
  });

  it('closed-list ratchet — projection kinds stay aligned with redacted-packets', () => {
    // STATUS_LINK_PROJECTION_KINDS in redacted-packets must include every
    // kind the validator accepts; both lists drift together.
    for (const k of STATUS_LINK_PROJECTION_KINDS) {
      expect(STATUS_LINK_PROJECTION_KIND_SET.has(k)).toBe(true);
      expect(STATUS_PROJECTION_FIELDS_VISIBLE[k]).toBeDefined();
    }
    expect(STATUS_LINK_PROJECTION_KINDS.length).toBe(6);
  });

  it('closed-list ratchet — source-ref kinds stay aligned with source-query allowlist', () => {
    const allowed = SOURCE_QUERY_KINDS_PERMITTED_PER_PACKET_KIND.status_link_packet ?? [];
    const validatorKinds = [
      'data.task',
      'data.note',
      'data.commitment',
      'data.project',
      'data.event',
      'data.packing_list',
      'data.itinerary',
    ];
    for (const k of validatorKinds) {
      expect(allowed.includes(k as (typeof allowed)[number])).toBe(true);
    }
    expect(allowed.length).toBe(validatorKinds.length);
  });
});
