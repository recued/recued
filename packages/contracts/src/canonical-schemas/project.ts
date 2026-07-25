/** D-145 PA1 — canonical `project` schema (§ A.1.4). */

import { PROJECT_STATES, PROJECT_TITLE_MAX } from '../work-entities.js';
import type { CanonicalSchema } from './shape.js';

export const PROJECT_SCHEMA: CanonicalSchema = {
  kind: 'project',
  fields: [
    { name: 'id', type: 'uuid', auto: true },
    { name: 'title', type: 'text', max_length: PROJECT_TITLE_MAX },
    { name: 'description', type: 'textarea', nullable: true },
    { name: 'state', type: 'enum', enum_values: PROJECT_STATES, default: 'active' },
    { name: 'created_at', type: 'timestamp', auto: true },
    { name: 'updated_at', type: 'timestamp', auto: true },
    { name: 'target_completion_at', type: 'timestamp', nullable: true },
    { name: 'last_activity_at', type: 'timestamp', auto: true },
  ],
  relationships: [
    { name: 'related_contacts', ref: 'data.contact', cardinality: 'many' },
    { name: 'parent_project', ref: 'data.project', cardinality: 'one', nullable: true },
  ],
  indices: [
    ['state', 'last_activity_at'],
    ['target_completion_at', 'state'],
  ],
};
