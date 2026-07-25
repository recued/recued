/** D-145 PA1 — canonical schema definitions for the four work entities.
 *
 *  Schema-as-data per § A.1. Every entry describes one canonical
 *  field's name, type, constraint envelope, and optional default. The
 *  PA5 form renderer (substrate level) consumes these declarations to
 *  generate forms; the PA1 storage layer uses them only for type-name
 *  lookup. The Source primitive (PA2) layers schema-extension blobs on
 *  top per registered Source.
 *
 *  Spec: docs/d-145-spec.md § A.1, § A.7.5 (the 16-field
 *  `EnrichmentDeclaration` lives elsewhere — these schemas describe
 *  user-visible fields, not enrichment producer declarations).
 *
 *  Pre-launch zero-installs rule applies: changes to the canonical
 *  schemas at this level are SQL DDL changes (PRAGMA-guarded ALTER
 *  TABLE in the storage layer); no migration code, no compat shims. */

import type { WorkEntityKind } from '../work-entities.js';
import { TASK_SCHEMA } from './task.js';
import { NOTE_SCHEMA } from './note.js';
import { COMMITMENT_SCHEMA } from './commitment.js';
import { PROJECT_SCHEMA } from './project.js';
import { BOOKING_SCHEMA } from './booking.js';
import { MAIL_MESSAGE_SCHEMA } from './mail-message.js';
import type { CanonicalSchema } from './shape.js';

export type {
  CanonicalSchema,
  CanonicalField,
  CanonicalFieldType,
  CanonicalRelationship,
  CanonicalRelationshipCardinality,
  CanonicalIndex,
} from './shape.js';

export { TASK_SCHEMA } from './task.js';
export { NOTE_SCHEMA } from './note.js';
export { COMMITMENT_SCHEMA } from './commitment.js';
export { PROJECT_SCHEMA } from './project.js';
export { BOOKING_SCHEMA } from './booking.js';
export { MAIL_MESSAGE_SCHEMA } from './mail-message.js';

/** Closed registry of canonical schemas — keyed on `WorkEntityKind`.
 *  Iteration is stable per `WORK_ENTITY_KINDS`. The `mail_message`
 *  schema (PA7) lives outside this registry because it's not a work
 *  entity — the compose substrate consumes `MAIL_MESSAGE_SCHEMA`
 *  directly. */
export const CANONICAL_SCHEMAS: Readonly<Record<WorkEntityKind, CanonicalSchema>> = {
  task: TASK_SCHEMA,
  note: NOTE_SCHEMA,
  commitment: COMMITMENT_SCHEMA,
  project: PROJECT_SCHEMA,
  booking: BOOKING_SCHEMA,
};

export const getCanonicalSchema = (kind: WorkEntityKind): CanonicalSchema =>
  CANONICAL_SCHEMAS[kind];
