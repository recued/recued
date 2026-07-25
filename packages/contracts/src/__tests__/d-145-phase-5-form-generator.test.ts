/** D-145 PA5 — form-from-canonical-schema generator.
 *
 *  Pin per § A.3.3:
 *    - `formFromCanonicalSchema` walks fields + relationships in order.
 *    - `formFromCanonicalSchemaWithExtension` merges extension fields
 *      AFTER canonical, dropping name-collisions silently (canonical
 *      wins).  Duplicates within an extension's own field list collapse
 *      to the first occurrence.
 *    - Auto fields → hidden + not-required.
 *    - Nullable fields → not-required.
 *    - Cardinality 'one' → 'ref'; cardinality 'many' → 'array' with
 *      `item_type: 'ref'` + `ref_target` carrying the relationship's
 *      ref path.
 *    - Extension fields tagged `origin: 'extension'`; canonical tagged
 *      `origin: 'canonical'`.
 *    - All four canonical schemas (TASK / NOTE / COMMITMENT / PROJECT)
 *      round-trip cleanly.
 */

import { describe, expect, it } from 'vitest';

import {
  COMMITMENT_SCHEMA,
  NOTE_SCHEMA,
  PROJECT_SCHEMA,
  TASK_SCHEMA,
  formFromCanonicalSchema,
  formFromCanonicalSchemaWithExtension,
  humanizeName,
} from '../index.js';
import type {
  FormDefinition,
  FormField,
  SourceExtensionSchema,
} from '../index.js';

const fieldByName = (def: FormDefinition, name: string): FormField | undefined =>
  def.fields.find((f) => f.name === name);

describe('D-145 PA5 — humanizeName', () => {
  it('converts snake_case into Sentence case', () => {
    expect(humanizeName('assigned_contact')).toBe('Assigned contact');
    expect(humanizeName('promised_for_at')).toBe('Promised for at');
  });

  it('passes single words through', () => {
    expect(humanizeName('title')).toBe('Title');
  });

  it('handles empty string', () => {
    expect(humanizeName('')).toBe('');
  });
});

describe('D-145 PA5 — formFromCanonicalSchema (TASK)', () => {
  const def = formFromCanonicalSchema(TASK_SCHEMA);

  it('carries the kind through', () => {
    expect(def.kind).toBe('task');
  });

  it('walks every canonical field + relationship', () => {
    const expected = [
      ...TASK_SCHEMA.fields.map((f) => f.name),
      ...TASK_SCHEMA.relationships.map((r) => r.name),
    ];
    expect(def.fields.map((f) => f.name)).toEqual(expected);
  });

  it('marks `id` (uuid + auto) as hidden + not-required', () => {
    const id = fieldByName(def, 'id');
    expect(id?.type).toBe('uuid');
    expect(id?.hidden).toBe(true);
    expect(id?.required).toBe(false);
  });

  it('marks `title` (non-nullable + not-auto) as required + visible', () => {
    const title = fieldByName(def, 'title');
    expect(title?.required).toBe(true);
    expect(title?.hidden).toBe(false);
    expect(title?.max_length).toBe(TASK_SCHEMA.fields.find((f) => f.name === 'title')?.max_length);
  });

  it('marks nullable fields as not-required', () => {
    const body = fieldByName(def, 'body');
    expect(body?.required).toBe(false);
    expect(body?.hidden).toBe(false);
  });

  it('humanizes labels', () => {
    expect(fieldByName(def, 'due_at')?.label).toBe('Due at');
    expect(fieldByName(def, 'completed_at')?.label).toBe('Completed at');
  });

  it('passes enum_values through', () => {
    const priority = fieldByName(def, 'priority');
    expect(priority?.type).toBe('enum');
    expect(priority?.enum_values).toEqual(
      TASK_SCHEMA.fields.find((f) => f.name === 'priority')?.enum_values,
    );
  });

  it('passes default through', () => {
    const done = fieldByName(def, 'done');
    expect(done?.default).toBe(false);
  });

  it('passes pattern / min / max / integer through (§ A.3.1)', () => {
    // Compose a synthetic schema to exercise every constraint at once.
    const synthetic = formFromCanonicalSchema({
      kind: 'task',
      fields: [
        { name: 'iso_country', type: 'text', pattern: '^[A-Z]{2}$' },
        { name: 'count', type: 'number', min: 0, max: 100, integer: true },
        { name: 'fraction', type: 'number', min: 0, max: 1 },
      ],
      relationships: [],
      indices: [],
    });
    expect(fieldByName(synthetic, 'iso_country')?.pattern).toBe('^[A-Z]{2}$');
    expect(fieldByName(synthetic, 'count')?.min).toBe(0);
    expect(fieldByName(synthetic, 'count')?.max).toBe(100);
    expect(fieldByName(synthetic, 'count')?.integer).toBe(true);
    expect(fieldByName(synthetic, 'fraction')?.integer).toBeUndefined();
  });

  it('maps `cardinality: one` relationship to `ref`', () => {
    const assigned = fieldByName(def, 'assigned_contact');
    expect(assigned?.type).toBe('ref');
    expect(assigned?.ref_target).toBe('data.contact');
  });

  it('maps `cardinality: many` relationship to `array<ref>`', () => {
    const blocks = fieldByName(def, 'blocks_task');
    expect(blocks?.type).toBe('array');
    expect(blocks?.item_type).toBe('ref');
    expect(blocks?.ref_target).toBe('data.task');
  });

  it('tags every canonical field as origin: canonical', () => {
    expect(def.fields.every((f) => f.origin === 'canonical')).toBe(true);
  });

  it('marks nullable relationships as not-required', () => {
    const linkedMail = fieldByName(def, 'linked_mail_thread');
    expect(linkedMail?.required).toBe(false);
  });
});

describe('D-145 PA5 — formFromCanonicalSchema (other kinds)', () => {
  it('round-trips NOTE', () => {
    const def = formFromCanonicalSchema(NOTE_SCHEMA);
    expect(def.kind).toBe('note');
    expect(fieldByName(def, 'body')?.type).toBe('textarea');
    expect(fieldByName(def, 'body')?.required).toBe(true);
    expect(fieldByName(def, 'related_contact')?.type).toBe('array');
  });

  it('round-trips COMMITMENT', () => {
    const def = formFromCanonicalSchema(COMMITMENT_SCHEMA);
    expect(def.kind).toBe('commitment');
    expect(fieldByName(def, 'expiry_policy')?.type).toBe('enum');
    expect(fieldByName(def, 'monetary_amount')?.required).toBe(false);
  });

  it('round-trips PROJECT', () => {
    const def = formFromCanonicalSchema(PROJECT_SCHEMA);
    expect(def.kind).toBe('project');
    expect(fieldByName(def, 'state')?.type).toBe('enum');
    expect(fieldByName(def, 'state')?.default).toBe('active');
  });
});

describe('D-145 PA5 — formFromCanonicalSchemaWithExtension', () => {
  const ext: SourceExtensionSchema = {
    fields: [
      { name: 'hubspot_owner_id', type: 'text' },
      { name: 'hubspot_priority', type: 'enum', enum_values: ['LOW', 'HIGH'] },
      // Collision with canonical `title`: must be dropped.
      { name: 'title', type: 'text' },
      // Duplicate within extension: only first kept.
      { name: 'hubspot_owner_id', type: 'number' },
      { name: 'hubspot_label_with_override', type: 'text', label: 'HubSpot Label' },
    ],
  };
  const def = formFromCanonicalSchemaWithExtension(TASK_SCHEMA, ext);

  it('appends extension fields after canonical', () => {
    const canonicalCount =
      TASK_SCHEMA.fields.length + TASK_SCHEMA.relationships.length;
    expect(def.fields.length).toBe(canonicalCount + 3); // 5 ext fields - 2 collisions
    expect(def.fields[canonicalCount].name).toBe('hubspot_owner_id');
  });

  it('drops extension fields that collide with canonical names', () => {
    const titleField = fieldByName(def, 'title');
    expect(titleField?.origin).toBe('canonical');
    // Only one `title` field — extension collision didn't dup it.
    expect(def.fields.filter((f) => f.name === 'title').length).toBe(1);
  });

  it('keeps the first instance of duplicate extension names', () => {
    expect(def.fields.filter((f) => f.name === 'hubspot_owner_id').length).toBe(1);
    const owner = fieldByName(def, 'hubspot_owner_id');
    expect(owner?.type).toBe('text'); // first declaration wins
  });

  it('tags extension fields as origin: extension', () => {
    expect(fieldByName(def, 'hubspot_owner_id')?.origin).toBe('extension');
    expect(fieldByName(def, 'hubspot_priority')?.origin).toBe('extension');
  });

  it('honours extension `label` overrides', () => {
    expect(fieldByName(def, 'hubspot_label_with_override')?.label).toBe('HubSpot Label');
  });

  it('humanizes extension fields without explicit label', () => {
    expect(fieldByName(def, 'hubspot_owner_id')?.label).toBe('Hubspot owner id');
  });

  it('passes extension enum_values through', () => {
    expect(fieldByName(def, 'hubspot_priority')?.enum_values).toEqual([
      'LOW',
      'HIGH',
    ]);
  });

  it('passes extension pattern / min / max / integer through', () => {
    const ext: SourceExtensionSchema = {
      fields: [
        { name: 'sf_iso_code', type: 'text', pattern: '^[A-Z]{3}$' },
        { name: 'sf_score', type: 'number', min: 0, max: 100, integer: true },
      ],
    };
    const merged = formFromCanonicalSchemaWithExtension(TASK_SCHEMA, ext);
    expect(fieldByName(merged, 'sf_iso_code')?.pattern).toBe('^[A-Z]{3}$');
    expect(fieldByName(merged, 'sf_score')?.min).toBe(0);
    expect(fieldByName(merged, 'sf_score')?.max).toBe(100);
    expect(fieldByName(merged, 'sf_score')?.integer).toBe(true);
  });

  it('treats nullable extension fields as not-required', () => {
    const optional: SourceExtensionSchema = {
      fields: [{ name: 'sf_optional', type: 'text', nullable: true }],
    };
    const optDef = formFromCanonicalSchemaWithExtension(TASK_SCHEMA, optional);
    expect(fieldByName(optDef, 'sf_optional')?.required).toBe(false);
  });

  it('handles empty extension', () => {
    const empty = formFromCanonicalSchemaWithExtension(TASK_SCHEMA, {
      fields: [],
    });
    const baseline = formFromCanonicalSchema(TASK_SCHEMA);
    expect(empty.fields.length).toBe(baseline.fields.length);
  });

  it('drops extension names that collide with relationship names', () => {
    const ext2: SourceExtensionSchema = {
      fields: [{ name: 'assigned_contact', type: 'text' }],
    };
    const merged = formFromCanonicalSchemaWithExtension(TASK_SCHEMA, ext2);
    // Only the canonical relationship version survives.
    const matches = merged.fields.filter((f) => f.name === 'assigned_contact');
    expect(matches.length).toBe(1);
    expect(matches[0]?.type).toBe('ref');
  });
});
