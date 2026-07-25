/** D-145 PA1 — canonical `commitment` schema (§ A.1.3).
 *
 *  Two orthogonal axes: `lifecycle_state` (whether the work happened)
 *  × `due_status` (whether the deadline has been crossed). Per-row
 *  `expiry_policy` decides how a deadline crossing maps onto
 *  lifecycle. Default `escalate_overdue` keeps "Bob owes me $5K" alive
 *  past Friday. */

import {
  COMMITMENT_DERIVATIONS,
  COMMITMENT_DIRECTIONS,
  COMMITMENT_DUE_STATUSES,
  COMMITMENT_EXPIRY_POLICIES,
  COMMITMENT_LIFECYCLE_STATES,
  COMMITMENT_STATEMENT_MAX,
} from '../work-entities.js';
import type { CanonicalSchema } from './shape.js';

export const COMMITMENT_SCHEMA: CanonicalSchema = {
  kind: 'commitment',
  fields: [
    { name: 'id', type: 'uuid', auto: true },
    { name: 'direction', type: 'enum', enum_values: COMMITMENT_DIRECTIONS },
    { name: 'statement', type: 'text', max_length: COMMITMENT_STATEMENT_MAX },
    { name: 'promised_at', type: 'timestamp', auto: true },
    { name: 'promised_for_at', type: 'timestamp', nullable: true },
    {
      name: 'lifecycle_state',
      type: 'enum',
      enum_values: COMMITMENT_LIFECYCLE_STATES,
      default: 'pending',
    },
    {
      name: 'due_status',
      type: 'enum',
      enum_values: COMMITMENT_DUE_STATUSES,
      default: 'no_deadline',
    },
    {
      name: 'expiry_policy',
      type: 'enum',
      enum_values: COMMITMENT_EXPIRY_POLICIES,
      default: 'escalate_overdue',
    },
    { name: 'state_changed_at', type: 'timestamp', auto: true },
    { name: 'lifecycle_changed_at', type: 'timestamp', auto: true },
    { name: 'due_status_changed_at', type: 'timestamp', auto: true },
    { name: 'derivation', type: 'enum', enum_values: COMMITMENT_DERIVATIONS },
    { name: 'derivation_confidence', type: 'number', nullable: true },
    {
      name: 'monetary_amount',
      type: 'text',
      nullable: true,
      description:
        'Decimal-as-string at scale 2 (-?\\d+(\\.\\d{1,2})?). Storage flattens monetary_value to monetary_amount + monetary_currency for indexing ergonomics; the conceptual contract is one nullable value object — both NULL or both populated.',
    },
    {
      name: 'monetary_currency',
      type: 'text',
      nullable: true,
      max_length: 3,
      description:
        'ISO 4217 three-letter currency code (^[A-Z]{3}$). Populated together with monetary_amount.',
    },
  ],
  relationships: [
    { name: 'counterparty_contact', ref: 'data.contact', cardinality: 'one', nullable: true },
    { name: 'derived_from_mail_thread', ref: 'data.mail.thread', cardinality: 'one', nullable: true },
    { name: 'derived_from_meeting', ref: 'data.meeting', cardinality: 'one', nullable: true },
    { name: 'blocks_task', ref: 'data.task', cardinality: 'many' },
    { name: 'blocks_project', ref: 'data.project', cardinality: 'many' },
  ],
  indices: [
    ['lifecycle_state', 'promised_for_at'],
    ['due_status', 'promised_for_at'],
    ['counterparty_contact', 'lifecycle_state'],
    ['direction', 'lifecycle_state'],
    ['counterparty_contact', 'lifecycle_state', 'monetary_currency'],
  ],
};
