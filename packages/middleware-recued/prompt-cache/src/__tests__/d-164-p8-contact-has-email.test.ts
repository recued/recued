/** D-164 P8 — contact has-email YES-only short-circuit class.
 *
 *  Covers the fourth short-circuit family (the affirmative sibling of P5): the
 *  presence-question matcher, the REUSED contact-attribute probe + the
 *  has-email body (so an absent email → empty render → defer), and the two
 *  Codex-folded holes:
 *    - DECLARATIVE statements must NOT fire ("I have an email for X." is a
 *      statement, not a presence question — the lead must invert with a
 *      presence verb);
 *    - the YES-ONLY defer (no email → empty render → pass through; the "no" is
 *      left to the LLM, which can check CRM). */

import { describe, expect, it } from 'vitest';

import {
  CONTACT_HAS_EMAIL_TEMPLATE,
  createContactAttributePresenceProbe,
  createTemplateRenderer,
  matchContactHasEmailTemplate,
  type ContactAttributeLookup,
  type ContactAttributeRow,
} from '../index';
import type { SlotValue } from '../ner/index';
import type { SlotName, Template } from '../types';

const makeSlot = (kind: SlotName, value: string, position = 0): SlotValue => ({
  kind,
  value,
  raw: value,
  position,
});

const nameSlot = (value = 'Pat Lee', position = 12): SlotValue =>
  makeSlot('entity.name', value, position);

const match = (
  text: string,
  slots: ReadonlyArray<SlotValue> = [nameSlot()],
): Template | null =>
  matchContactHasEmailTemplate({ text, slots, locale: 'en' }) as Template | null;

const PAT: ContactAttributeRow = { name: 'Pat Lee', email: 'pat@x.com' };

// ── Matcher: fires (presence questions) ──────────────────────────────

describe('D-164 P8 contact has-email matcher — fires', () => {
  it.each([
    "Do I have Pat Lee's email?",
    "do I have Pat Lee's email",
    "do you have Pat Lee's email?",
    "do we have Pat Lee's email?",
    "have I got Pat Lee's email?",
    'do I have an email for Pat Lee?',
    'is there an email for Pat Lee?',
    'do I have the email for Pat Lee?',
    "do I have Pat Lee's email address?",
    "do I have Pat Lee's email on file?",
    "do I still have Pat Lee's email?",
    'is there an email address for Pat Lee on file?',
  ])('fires on %j', (text) => {
    const t = match(text);
    expect(t).not.toBeNull();
    expect(t?.template_hash).toBe(CONTACT_HAS_EMAIL_TEMPLATE.template_hash);
  });
});

// ── Matcher: passes through (folded holes) ───────────────────────────

describe('D-164 P8 contact has-email matcher — passes through', () => {
  it.each([
    // DECLARATIVE statements (subject-first, not inverted) — Codex R2 fold.
    ['declarative (I have)', 'I have an email for Pat Lee.'],
    ['declarative (we have)', 'we have the email for Pat Lee.'],
    ['declarative (you have)', 'you have an email for Pat Lee.'],
    ['declarative (there is)', 'there is an email for Pat Lee.'],
    // Non-presence framing → left to P5 (no presence-verb opener).
    ['what-is (P5 territory)', "what is Pat Lee's email?"],
    ['tell-me (P5 territory)', "tell me Pat Lee's email"],
    ['bare possessive (P5 territory)', "Pat Lee's email?"],
    // Different intent / structure.
    ['obligation (have to email)', 'do I have to email Pat Lee?'],
    ['received mail (from, not for)', 'do I have an email from Pat Lee?'],
    ['different attribute (number)', "do I have Pat Lee's number?"],
    ['no email reference', 'do I have Pat Lee?'],
    // Trailing predicate after the attribute (not terminal).
    ['predicate after attribute', "do I have Pat Lee's email handy right now?"],
  ])('passes through: %s', (_label, text) => {
    expect(match(text)).toBeNull();
  });

  it.each([
    "add Pat Lee's email",
    "save Pat Lee's email",
    "set Pat Lee's email address",
  ])('passes through a write: %j', (text) => {
    expect(match(text)).toBeNull();
  });

  it('passes through when more than one name slot is present (ambiguous)', () => {
    const slots = [nameSlot('Pat Lee'), nameSlot('Bob Stone', 40)];
    expect(match("do I have Pat Lee's and Bob Stone's email", slots)).toBeNull();
  });

  it('passes through when an email slot rides along', () => {
    const slots = [nameSlot('Pat Lee'), makeSlot('entity.email', 'pat@x.com', 40)];
    expect(match("do I have Pat Lee's email pat@x.com", slots)).toBeNull();
  });

  it('passes through when the sole slot is not a name', () => {
    expect(match('do I have an email for pat@x.com', [makeSlot('entity.email', 'pat@x.com')])).toBeNull();
  });
});

// ── Render (reused probe → has-email body) ───────────────────────────

describe('D-164 P8 contact has-email render', () => {
  const render = createTemplateRenderer();

  it('renders the affirmative body from a probe snapshot WITH an email', async () => {
    const probe = createContactAttributePresenceProbe(() => [PAT]);
    const snap = await probe({ template: CONTACT_HAS_EMAIL_TEMPLATE, slots: [nameSlot()] });
    expect(snap).not.toBeNull();
    expect(render(CONTACT_HAS_EMAIL_TEMPLATE, snap!)).toBe(
      "Yes, Pat Lee's email address is pat@x.com.",
    );
  });

  it('YES-ONLY defer: a contact WITHOUT an email → empty render → pass through', async () => {
    // The reused contact-attribute probe still resolves the contact (it has a
    // name) but the snapshot carries no email; the body's {{email}} then misses
    // → empty render → the gate passes through (the "no" deferred to the LLM).
    const noEmail: ContactAttributeLookup = () => [{ name: 'Pat Lee' }];
    const probe = createContactAttributePresenceProbe(noEmail);
    const snap = await probe({ template: CONTACT_HAS_EMAIL_TEMPLATE, slots: [nameSlot()] });
    expect(snap).not.toBeNull(); // contact resolved (has a name)
    expect(snap!.data.email).toBeUndefined();
    expect(render(CONTACT_HAS_EMAIL_TEMPLATE, snap!)).toBe(''); // empty → pass through
  });
});
