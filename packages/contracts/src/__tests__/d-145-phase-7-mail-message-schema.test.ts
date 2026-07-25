/** D-145 PA7 — mail_message canonical schema.
 *
 *  Pin per § A.5.1:
 *    - kind = 'mail_message'
 *    - subject: text, required, max 300
 *    - body: textarea, required
 *    - to: ref data.contact, cardinality 'many', required (non-nullable)
 *    - cc / bcc: ref data.contact, cardinality 'many', nullable
 *    - attachments: ref data.file, cardinality 'many', nullable
 *    - in_reply_to: ref data.mail.message, cardinality 'one', nullable
 *    - sender_source: ref source.mail, cardinality 'one', required
 *    - schema is consumable by `formFromCanonicalSchema` */

import { describe, expect, it } from 'vitest';

import {
  MAIL_MESSAGE_REF_CONTACT,
  MAIL_MESSAGE_REF_FILE,
  MAIL_MESSAGE_REF_MESSAGE,
  MAIL_MESSAGE_REF_SOURCE,
  MAIL_MESSAGE_SCHEMA,
  MAIL_MESSAGE_SUBJECT_MAX,
  formFromCanonicalSchema,
} from '../index.js';

describe('D-145 PA7 — MAIL_MESSAGE_SCHEMA', () => {
  it('declares kind = "mail_message"', () => {
    expect(MAIL_MESSAGE_SCHEMA.kind).toBe('mail_message');
  });

  it('subject is a required text field with max length 300', () => {
    const subject = MAIL_MESSAGE_SCHEMA.fields.find((f) => f.name === 'subject');
    expect(subject).toBeDefined();
    expect(subject?.type).toBe('text');
    expect(subject?.nullable).not.toBe(true);
    expect(subject?.max_length).toBe(MAIL_MESSAGE_SUBJECT_MAX);
    expect(MAIL_MESSAGE_SUBJECT_MAX).toBe(300);
  });

  it('body is a required textarea field', () => {
    const body = MAIL_MESSAGE_SCHEMA.fields.find((f) => f.name === 'body');
    expect(body).toBeDefined();
    expect(body?.type).toBe('textarea');
    expect(body?.nullable).not.toBe(true);
  });

  it('to is a many-cardinality ref to data.contact and is required (non-nullable)', () => {
    const to = MAIL_MESSAGE_SCHEMA.relationships.find((r) => r.name === 'to');
    expect(to).toBeDefined();
    expect(to?.ref).toBe(MAIL_MESSAGE_REF_CONTACT);
    expect(to?.cardinality).toBe('many');
    expect(to?.nullable).not.toBe(true);
  });

  it('cc and bcc are many-cardinality refs to data.contact and are nullable', () => {
    const cc = MAIL_MESSAGE_SCHEMA.relationships.find((r) => r.name === 'cc');
    const bcc = MAIL_MESSAGE_SCHEMA.relationships.find((r) => r.name === 'bcc');
    expect(cc?.ref).toBe(MAIL_MESSAGE_REF_CONTACT);
    expect(cc?.cardinality).toBe('many');
    expect(cc?.nullable).toBe(true);
    expect(bcc?.ref).toBe(MAIL_MESSAGE_REF_CONTACT);
    expect(bcc?.cardinality).toBe('many');
    expect(bcc?.nullable).toBe(true);
  });

  it('attachments is a nullable many-cardinality ref to data.file', () => {
    const attachments = MAIL_MESSAGE_SCHEMA.relationships.find(
      (r) => r.name === 'attachments',
    );
    expect(attachments?.ref).toBe(MAIL_MESSAGE_REF_FILE);
    expect(attachments?.cardinality).toBe('many');
    expect(attachments?.nullable).toBe(true);
  });

  it('in_reply_to is a nullable one-cardinality ref to data.mail.message', () => {
    const inReplyTo = MAIL_MESSAGE_SCHEMA.relationships.find(
      (r) => r.name === 'in_reply_to',
    );
    expect(inReplyTo?.ref).toBe(MAIL_MESSAGE_REF_MESSAGE);
    expect(inReplyTo?.cardinality).toBe('one');
    expect(inReplyTo?.nullable).toBe(true);
  });

  it('sender_source is a required one-cardinality ref to source.mail', () => {
    const senderSource = MAIL_MESSAGE_SCHEMA.relationships.find(
      (r) => r.name === 'sender_source',
    );
    expect(senderSource?.ref).toBe(MAIL_MESSAGE_REF_SOURCE);
    expect(senderSource?.cardinality).toBe('one');
    expect(senderSource?.nullable).not.toBe(true);
  });

  it('declares no indices (compose-side schema; mailbox indices live on data.mail tables)', () => {
    expect(MAIL_MESSAGE_SCHEMA.indices).toEqual([]);
  });
});

describe('D-145 PA7 — formFromCanonicalSchema(MAIL_MESSAGE_SCHEMA)', () => {
  const def = formFromCanonicalSchema(MAIL_MESSAGE_SCHEMA);

  it('emits a FormDefinition with kind = "mail_message"', () => {
    expect(def.kind).toBe('mail_message');
  });

  it('renders array<ref> form fields for to / cc / bcc / attachments', () => {
    for (const name of ['to', 'cc', 'bcc', 'attachments']) {
      const field = def.fields.find((f) => f.name === name);
      expect(field, name).toBeDefined();
      expect(field?.type, name).toBe('array');
      expect(field?.item_type, name).toBe('ref');
    }
  });

  it('renders ref form fields for in_reply_to and sender_source', () => {
    const inReplyTo = def.fields.find((f) => f.name === 'in_reply_to');
    expect(inReplyTo?.type).toBe('ref');
    expect(inReplyTo?.ref_target).toBe(MAIL_MESSAGE_REF_MESSAGE);
    expect(inReplyTo?.required).toBe(false);
    const senderSource = def.fields.find((f) => f.name === 'sender_source');
    expect(senderSource?.type).toBe('ref');
    expect(senderSource?.ref_target).toBe(MAIL_MESSAGE_REF_SOURCE);
    expect(senderSource?.required).toBe(true);
  });

  it('marks subject as required text + body as required textarea', () => {
    const subject = def.fields.find((f) => f.name === 'subject');
    expect(subject?.type).toBe('text');
    expect(subject?.required).toBe(true);
    expect(subject?.max_length).toBe(MAIL_MESSAGE_SUBJECT_MAX);
    const body = def.fields.find((f) => f.name === 'body');
    expect(body?.type).toBe('textarea');
    expect(body?.required).toBe(true);
  });
});
