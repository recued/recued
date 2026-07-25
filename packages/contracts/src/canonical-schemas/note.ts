/** D-145 PA1 — canonical `note` schema (§ A.1.2).
 *
 *  `last_referenced_at` is deliberately NOT a canonical field —
 *  read-mutating canonical records distorts the
 *  `note_relevance_decay` producer math, churns audit, and lets AI
 *  retrieval change future ranking. Access tracking lives in
 *  `note_access_ledger` (server-internal; no cross-cloud sync
 *  per D-097 / D-168). */

import { NOTE_TITLE_MAX } from '../work-entities.js';
import type { CanonicalSchema } from './shape.js';

export const NOTE_SCHEMA: CanonicalSchema = {
  kind: 'note',
  fields: [
    { name: 'id', type: 'uuid', auto: true },
    { name: 'title', type: 'text', max_length: NOTE_TITLE_MAX, nullable: true },
    { name: 'body', type: 'textarea' },
    { name: 'created_at', type: 'timestamp', auto: true },
    { name: 'updated_at', type: 'timestamp', auto: true },
    {
      name: 'last_user_action_at',
      type: 'timestamp',
      auto: true,
      description:
        'Updated only on explicit user open / edit / save / pin / unpin. Read events do NOT mutate the canonical row.',
    },
  ],
  relationships: [
    { name: 'related_contact', ref: 'data.contact', cardinality: 'many' },
    { name: 'related_calendar_event', ref: 'data.calendar.event', cardinality: 'many' },
    { name: 'related_mail_thread', ref: 'data.mail.thread', cardinality: 'many' },
    { name: 'related_project', ref: 'data.project', cardinality: 'many' },
  ],
  // `fts5:body` declares the full-text search index over `body` per
  // § A.1.2. The form-renderer + read-side resolver treat the
  // `fts5:` prefix as a sentinel for "this index uses SQLite FTS5
  // virtual-table semantics, not a normal B-tree composite index."
  // PA1 storage materializes the `data_note_fts` companion table.
  indices: [['fts5:body'], ['last_user_action_at']],
};
