import { describe, expect, it } from 'vitest';

import {
  CANONICAL_CRM_FIELD_SCHEMA,
  CONNECTION_VENDOR_ENTITIES,
  CRM_ALIAS_VALUES,
  canonicalCrmField,
  canonicalCrmFieldSet,
  canonicalCrmFieldTypeLabel,
  crmEntityConformanceIssues,
  crmFieldPackTypeConforms,
  crmFieldTypeConforms,
  requiredCanonicalCrmFields,
  type CanonicalCrmField,
  type ConnectionVendorEntity,
  type ConnectionVendorEntityMetaFieldType,
  type CrmAlias,
  type MetaFieldType,
} from '../index.js';

const sorted = (values: Iterable<string>) => [...values].sort();

const acceptedType = (field: CanonicalCrmField): ConnectionVendorEntityMetaFieldType => {
  if (typeof field.type === 'string') {
    return field.type;
  }
  const [type] = field.type;
  if (type === undefined) {
    throw new Error(`canonical CRM field ${field.name} has no accepted types`);
  }
  return type;
};

const schemaNames = (crmAlias: CrmAlias) =>
  new Set(CANONICAL_CRM_FIELD_SCHEMA[crmAlias].map((field) => field.name));

const requiredMetaFields = (
  crmAlias: CrmAlias,
  omit: ReadonlySet<string> = new Set(),
): ConnectionVendorEntity['meta_fields'] =>
  [...requiredCanonicalCrmFields(crmAlias)]
    .filter((name) => !omit.has(name))
    .map((name) => {
      const field = canonicalCrmField(crmAlias, name);
      if (field === undefined) {
        throw new Error(`missing canonical CRM schema for required field ${crmAlias}.${name}`);
      }
      return {
        key: name,
        type: acceptedType(field),
        description: `${crmAlias} ${name}`,
      };
    });

const syntheticEntity = (
  crmAlias: CrmAlias | undefined,
  meta_fields: ConnectionVendorEntity['meta_fields'],
): ConnectionVendorEntity => ({
  vendor: 'synthetic',
  entity: crmAlias ?? 'ticket',
  scope: `connection.api.synthetic.${crmAlias ?? 'ticket'}` as ConnectionVendorEntity['scope'],
  display_name: crmAlias === undefined ? 'Synthetic Ticket' : `Synthetic ${crmAlias}`,
  meta_fields,
  ...(crmAlias === undefined ? {} : { crm_alias: crmAlias }),
});

describe('D-190 Slice 3 canonical CRM field schema', () => {
  it('covers every registered CRM meta field in the authored canonical schema', () => {
    const missing: string[] = [];

    for (const crmAlias of CRM_ALIAS_VALUES) {
      expect(CANONICAL_CRM_FIELD_SCHEMA[crmAlias].length).toBeGreaterThan(0);
      expect(schemaNames(crmAlias).has('id')).toBe(true);
    }

    for (const entry of CONNECTION_VENDOR_ENTITIES) {
      if (entry.crm_alias === undefined) continue;
      const canonical = schemaNames(entry.crm_alias);

      for (const field of entry.meta_fields) {
        if (!canonical.has(field.key)) {
          missing.push(`${entry.vendor}.${entry.entity}.${field.key} -> ${entry.crm_alias}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it('keeps canonicalCrmFieldSet covered by the authored schema for every alias', () => {
    const missing: string[] = [];

    for (const crmAlias of CRM_ALIAS_VALUES) {
      const canonical = schemaNames(crmAlias);
      for (const name of canonicalCrmFieldSet(crmAlias)) {
        if (!canonical.has(name)) {
          missing.push(`${crmAlias}.${name}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it('keeps the bundled CRM registry fully conformant', () => {
    const failures = CONNECTION_VENDOR_ENTITIES.flatMap((entry) => {
      const issues = crmEntityConformanceIssues(entry);
      return [
        ...issues.errors.map((message) => ({ severity: 'error', entry, message })),
        ...issues.warnings.map((message) => ({ severity: 'warning', entry, message })),
      ];
    });

    expect(failures).toEqual([]);
  });

  it('accepts both string and number ids and labels the multi-type contract', () => {
    const id = canonicalCrmField('deal', 'id');
    expect(id).toBeDefined();
    expect(crmFieldTypeConforms('deal', 'id', 'string')).toBe(true);
    expect(crmFieldTypeConforms('deal', 'id', 'number')).toBe(true);

    const label = canonicalCrmFieldTypeLabel('deal', 'id');
    expect(label).toContain('string');
    expect(label).toContain('number');
  });

  it('reports a synthetic CRM entity canonical field with the wrong registry type as an error', () => {
    const issues = crmEntityConformanceIssues(syntheticEntity('deal', [
      ...requiredMetaFields('deal'),
      { key: 'amount', type: 'string', description: 'wrong amount type' },
    ]));

    expect(issues.errors.some((message) => message.includes("field 'amount'"))).toBe(true);
  });

  it('reports a synthetic CRM entity missing a required field as a warning without errors', () => {
    const issues = crmEntityConformanceIssues(syntheticEntity(
      'deal',
      requiredMetaFields('deal', new Set(['owner'])),
    ));

    expect(issues.errors).toEqual([]);
    expect(issues.warnings.some((message) => message.includes("required canonical field 'owner'"))).toBe(true);
  });

  it('reports a synthetic CRM entity field absent from the canonical schema as an error', () => {
    const issues = crmEntityConformanceIssues(syntheticEntity('deal', [
      ...requiredMetaFields('deal'),
      { key: 'frobnicate', type: 'string', description: 'not canonical' },
    ]));

    expect(issues.errors.some((message) => message.includes("field 'frobnicate'"))).toBe(true);
  });

  it('does not report canonical CRM conformance issues for non-CRM entities', () => {
    const issues = crmEntityConformanceIssues(syntheticEntity(undefined, [
      { key: 'frobnicate', type: 'string', description: 'non-CRM field' },
    ]));

    expect(issues).toEqual({ errors: [], warnings: [] });
  });

  it('applies the pack-to-canonical type conformance matrix without boolean false-passes', () => {
    const cases = [
      ['deal', 'name', 'boolean', false],
      ['deal', 'name', 'string', true],
      ['deal', 'amount', 'number', true],
      ['deal', 'amount', 'string', false],
      ['contact', 'mailing_address', 'json', true],
      ['deal', 'id', 'number', true],
      ['deal', 'id', 'string', true],
      ['deal', 'frobnicate', 'boolean', true],
    ] satisfies ReadonlyArray<readonly [CrmAlias, string, MetaFieldType, boolean]>;

    for (const [crmAlias, name, type, expected] of cases) {
      expect(crmFieldPackTypeConforms(crmAlias, name, type)).toBe(expected);
    }
  });

  it('exposes the required deal field set and excludes optional deal fields', () => {
    const required = requiredCanonicalCrmFields('deal');
    const schemaRequired = CANONICAL_CRM_FIELD_SCHEMA.deal
      .filter((field) => field.required)
      .map((field) => field.name);

    expect(sorted(required)).toEqual(sorted(schemaRequired));
    expect([...required]).toEqual(expect.arrayContaining([
      'id',
      'name',
      'stage',
      'amount',
      'owner',
      'close_state',
      'key_dates.close_date',
      'key_dates.created_at',
    ]));
    expect(required.has('pipeline')).toBe(false);
    expect(required.has('probability')).toBe(false);
    expect(required.has('forecast_amount')).toBe(false);
  });
});
