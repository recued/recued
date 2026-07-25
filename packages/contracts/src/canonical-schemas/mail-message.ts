/** D-145 PA7 — canonical `mail_message` schema (§ A.5.1).
 *
 *  Mail-message canonical-schema extension covering the compose-side
 *  fields per § A.5.1. Existing mail-collection records (`data.mail.<slug>`)
 *  carry the inbound shape derived from the mail provider; this schema
 *  is what the form-renderer consumes when the user composes a NEW
 *  message — the outbound shape. The two halves share `subject` /
 *  `body` / `to` / `cc` / `bcc` / `attachments` semantics; compose adds
 *  `in_reply_to` (thread continuation) + `sender_source` (which mail
 *  Source to send from, must be `send_capable: true`).
 *
 *  Recipients (`to` / `cc` / `bcc`) are modeled as `ref data.contact`
 *  arrays — the host autocompletes from the contact graph.
 *  `attachments` reference `data.file` records. `in_reply_to` is a
 *  single optional `ref data.mail.message`. `sender_source` is the
 *  Source registry entry for the mail kind (`source.mail` ref target).
 *
 *  Spec: docs/d-145-spec.md § A.5 (Email compose UI). */

import { MAIL_MESSAGE_SUBJECT_MAX } from '../mail.js';
import type { CanonicalSchema } from './shape.js';

export const MAIL_MESSAGE_SCHEMA: CanonicalSchema = {
  kind: 'mail_message',
  fields: [
    { name: 'subject', type: 'text', max_length: MAIL_MESSAGE_SUBJECT_MAX },
    { name: 'body', type: 'textarea' },
  ],
  relationships: [
    {
      name: 'to',
      ref: 'data.contact',
      cardinality: 'many',
      description:
        'Primary recipients. Required at submit-time — compose dispatch rejects payloads with empty `to`. Schema cardinality is `many` (non-nullable array); compose substrate enforces the non-empty floor.',
    },
    { name: 'cc', ref: 'data.contact', cardinality: 'many', nullable: true },
    { name: 'bcc', ref: 'data.contact', cardinality: 'many', nullable: true },
    {
      name: 'attachments',
      ref: 'data.file',
      cardinality: 'many',
      nullable: true,
      description:
        'Attachment file refs (data.file record-ids). D-172 P2 resolves each through the Gateway-gated file.read into bytes at the rpc layer (`collection.mail.send`) before the provider send; over-cap files are dropped with a warning, never silently.',
    },
    {
      name: 'in_reply_to',
      ref: 'data.mail.message',
      cardinality: 'one',
      nullable: true,
      description:
        'Set when compose was opened from a thread context. Drives the `In-Reply-To` + `References` headers on outbound send.',
    },
    {
      name: 'sender_source',
      ref: 'source.mail',
      cardinality: 'one',
      description:
        'Which mail Source to send from. Defaults to the kind-default Source (`prefs.mail_message.last_used_source_id`); compose rejects sends from a Source where `send_capable !== true`.',
    },
  ],
  indices: [],
};
