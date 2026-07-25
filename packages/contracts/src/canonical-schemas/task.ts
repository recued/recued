/** D-145 PA1 — canonical `task` schema (§ A.1.1). */

import { TASK_PRIORITIES, TASK_TITLE_MAX } from '../work-entities.js';
import type { CanonicalSchema } from './shape.js';

export const TASK_SCHEMA: CanonicalSchema = {
  kind: 'task',
  fields: [
    { name: 'id', type: 'uuid', auto: true },
    { name: 'title', type: 'text', max_length: TASK_TITLE_MAX },
    { name: 'body', type: 'textarea', nullable: true },
    { name: 'done', type: 'boolean', default: false },
    { name: 'due_at', type: 'timestamp', nullable: true },
    { name: 'priority', type: 'enum', enum_values: TASK_PRIORITIES, nullable: true },
    { name: 'created_at', type: 'timestamp', auto: true },
    { name: 'updated_at', type: 'timestamp', auto: true },
    { name: 'completed_at', type: 'timestamp', nullable: true, auto: true },
  ],
  relationships: [
    { name: 'assigned_contact', ref: 'data.contact', cardinality: 'one', nullable: true },
    { name: 'parent_calendar_event', ref: 'data.calendar.event', cardinality: 'one', nullable: true },
    { name: 'linked_mail_thread', ref: 'data.mail.thread', cardinality: 'one', nullable: true },
    { name: 'parent_project', ref: 'data.project', cardinality: 'one', nullable: true },
    { name: 'blocks_task', ref: 'data.task', cardinality: 'many' },
  ],
  indices: [
    ['done', 'due_at'],
    ['assigned_contact', 'done'],
    ['parent_project', 'done'],
  ],
};
