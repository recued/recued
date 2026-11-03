import { describe, expect, it } from 'vitest';
import { ENTITY_FIELD_PRIVACY_KINDS } from '@recued/contracts';
import { inspectApprovalFields } from '../approval-authoring.js';
import { resolveArgEditSchema } from '../arg-edit-schema.js';

describe('shared approval inspection', () => {
  it('reuses runtime precedence, first-declaration deduplication and destination floors without changing source', () => {
    const op: any = { editable_args: [
      { key: 'calendar_id', type: 'string', label: 'Calendar', required: false, affects_target: false, privacy: ENTITY_FIELD_PRIVACY_KINDS[0] },
      { key: 'calendar_id', type: 'number', label: 'Ignored' }, { key: 'count', type: 'number', validation: { min: 1, max: 9, maxLength: 200 } },
    ], request_schema: { properties: { count: { type: 'number', minimum: 5 } } } };
    const before = JSON.stringify(op), report = inspectApprovalFields(op), field = report.fields[0]!.local_resolution as any;
    expect(report.mode).toBe('explicit_allowlist'); expect(field).toMatchObject({ label: 'Calendar', required: false, affects_target: true, privacy: ENTITY_FIELD_PRIVACY_KINDS[0] });
    expect(report.fields[0]!.unresolved_target_facets).toEqual([]); expect(report.fields[1]!.ignored_duplicate).toBe(true);
    expect((report.fields[2]!.local_resolution as any).validation).toEqual({ min: 1, max: 9 }); expect(report.fields[2]!.unsupported_metadata_keys).toContain('validation.maxLength'); expect(JSON.stringify(op)).toBe(before);
    const runtime = resolveArgEditSchema('op', { credential: 'not inspected' }, { lookupOperation: () => op });
    expect(runtime.fields[0]!.affects_target).toBe(true);
  });
  it('marks legacy type and missing entity facets unresolved while preserving permissive declarations', () => {
    const op = { editable_args: [{ key: 'nested.items', type: 'array', default: 'PRIVATE_DEFAULT' }],
      request_schema: { properties: { nested: { properties: { items: { type: 'array' } } } } } };
    const report = inspectApprovalFields(op);
    expect(report.complete).toBe(true); expect(report.fields[0]!.declared_type).toBe('array');
    expect(report.fields[0]!.local_resolution).toMatchObject({ type: 'json', label: 'Items' });
    expect(report.fields[0]!.unresolved_target_facets).toEqual(['type', 'privacy', 'required', 'label']);
    expect(report.fields[0]!.unsupported_metadata_keys).toEqual(['default']); expect(JSON.stringify(report)).not.toContain('PRIVATE_DEFAULT');
  });
  it('distinguishes schema display candidates from edit permission and shares secret/plumbing rules', () => {
    const report = inspectApprovalFields({ request_schema: { properties: { 'body.password': { type: 'string' }, token_id: { type: 'string' }, date: { type: 'string', format: 'date-time' }, idempotency_key: { type: 'string' } } } });
    expect(report.mode).toBe('schema_display_candidates'); expect(report.fields.map(row => row.key)).toEqual(['body.password', 'token_id', 'date']);
    expect(report.fields[0]!.value_visibility).toContain('secret hiding'); expect(report.fields[1]!.value_visibility).toContain('Display-only');
    expect(report.fields[2]!.local_resolution).toMatchObject({ type: 'string' }); expect(report.display_limit).toBe(12);
    expect(report.notes[0]).toContain('Nothing becomes editable');
    expect(inspectApprovalFields({}).mode).toBe('no_declared_fields');
  });
  it('withholds malformed picker/constraint metadata and excessive fields without invoking patterns', () => {
    const report = inspectApprovalFields({ editable_args: [{ key: 'bad', options_source: null }, { key: 'count', validation: { min: 'many' } }, null, { key: 'text', type: 'string', validation: { pattern: '^(a+)+$' } }] });
    expect(report.complete).toBe(false); expect(report.fields[0]!.details_omitted).toBe(true); expect(report.fields[1]!.details_omitted).toBe(true);
    expect((report.fields[2]!.local_resolution as any).validation.pattern).toBe('^(a+)+$');
    expect(inspectApprovalFields({ editable_args: 'bad' }).mode).toBe('malformed');
    expect(inspectApprovalFields({ editable_args: Array.from({ length: 101 }, (_, i) => ({ key: 'k' + i })) }).mode).toBe('limited');
    expect(inspectApprovalFields({ request_schema: { properties: Object.fromEntries(Array.from({ length: 101 }, (_, i) => ['k' + i, {}])) } }).mode).toBe('limited');
  });
});
