import type { CanonicalSchema } from './shape.js';
import { ASSET_IDENTIFYING_FIELD_NOTE, ASSET_STATUSES } from '../assets.js';

/** D-325 — the small core used by generic entity consumers. Yours edits the
 * typed maps, rule rows and anchors on the asset's page. */
export const ASSET_SCHEMA: CanonicalSchema = {
  kind: 'asset',
  fields: [
    { name: 'id', type: 'uuid', auto: true },
    { name: 'name', type: 'text', max_length: 200 },
    { name: 'class_id', type: 'text', nullable: true },
    { name: 'status', type: 'enum', enum_values: ASSET_STATUSES, default: 'active' },
    { name: 'audience', type: 'enum', enum_values: ['owner', 'household'], nullable: true },
    { name: 'sphere', type: 'enum', enum_values: ['personal', 'professional'], nullable: true },
    { name: 'document_number', type: 'text', nullable: true, description: ASSET_IDENTIFYING_FIELD_NOTE },
    { name: 'serial_number', type: 'text', nullable: true, description: ASSET_IDENTIFYING_FIELD_NOTE },
    { name: 'exact_address', type: 'text', nullable: true, description: ASSET_IDENTIFYING_FIELD_NOTE },
    { name: 'created_at', type: 'timestamp', auto: true },
    { name: 'updated_at', type: 'timestamp', auto: true },
  ],
  relationships: [
    { name: 'holder_contact', ref: 'data.contact', cardinality: 'one', nullable: true },
    { name: 'belongs_to', ref: 'data.asset', cardinality: 'one', nullable: true },
  ],
  indices: [['status'], ['belongs_to'], ['holder_contact']],
};
