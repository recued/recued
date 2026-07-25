/** D-164 P7 — mail from-count short-circuit class.
 *
 *  Covers the third short-circuit family (the second reading a non-contact
 *  collection): the intent-aware matcher, the contact-resolving + mail-count
 *  probe, the multi-family composer (now THREE families), and the body
 *  render. The matcher is a both-ends-anchored whitelist mirroring the
 *  calendar matcher, plus an allowlisted MIDDLE region (the novel surface) —
 *  every wrong-answer hole a Codex review surfaced gets an explicit
 *  regression case:
 *    - a FILTERED count (unread / read-state / partitive) must pass through;
 *    - a RECIPIENT ("to X") / NON-OWNER subject / DIFFERENT intent must pass
 *      through;
 *    - a WRITE must pass through (never answer a write as a read);
 *    - the answer is PERSON-scoped, so the probe REQUIRES the contact's
 *      complete linked address set (`emails`) and hands the WHOLE set to the
 *      count lookup — a row without the set (a port that can't claim
 *      completeness) defers rather than risk a false person-wide total;
 *    - a `0` count defers (only a POSITIVE count fires). */

import { describe, expect, it, vi } from 'vitest';

import {
  CALENDAR_NEXT_MEETING_TEMPLATE,
  CONTACT_ATTRIBUTE_TEMPLATES,
  MAIL_FROM_COUNT_TEMPLATE,
  composeShortCircuitFamilies,
  createCalendarNextMeetingProbe,
  createContactAttributePresenceProbe,
  createMailFromCountProbe,
  createTemplateRenderer,
  matchCalendarNextMeetingTemplate,
  matchContactAttributeTemplate,
  matchMailFromCountTemplate,
  type ContactAttributeLookup,
  type ContactAttributeRow,
  type DataSnapshot,
  type MailFromCountLookup,
  type ShortCircuitFamily,
} from '../index';
import type { SlotValue } from '../ner/index';
import type { SlotName, Template } from '../types';

const makeSlot = (kind: SlotName, value: string, position = 0): SlotValue => ({
  kind,
  value,
  raw: value,
  position,
});

const nameSlot = (value = 'Pat Lee', position = 18): SlotValue =>
  makeSlot('entity.name', value, position);

const match = (
  text: string,
  slots: ReadonlyArray<SlotValue> = [nameSlot()],
): Template | null =>
  matchMailFromCountTemplate({ text, slots, locale: 'en' }) as Template | null;

const PAT: ContactAttributeRow = {
  name: 'Pat Lee',
  email: 'pat@x.com',
  emails: ['pat@x.com'],
};

const runProbe = async (
  opts: {
    readonly contact?: ContactAttributeLookup;
    readonly count?: MailFromCountLookup;
    readonly slots?: ReadonlyArray<SlotValue>;
  } = {},
): Promise<DataSnapshot | null> => {
  const probe = createMailFromCountProbe(
    opts.contact ?? (() => [PAT]),
    opts.count ?? (() => 2),
  );
  return await probe({
    template: MAIL_FROM_COUNT_TEMPLATE,
    slots: opts.slots ?? [nameSlot()],
  });
};

// ── Matcher: fires ───────────────────────────────────────────────────

describe('D-164 P7 mail from-count matcher — fires', () => {
  it.each([
    'How many emails from Pat Lee?',
    'how many emails from Pat Lee',
    'how many emails do I have from Pat Lee',
    'how many emails have I gotten from Pat Lee',
    'how many emails have I received from Pat Lee',
    'how many emails did I get from Pat Lee',
    'how many emails are there from Pat Lee',
    'number of emails from Pat Lee',
    'the number of emails from Pat Lee',
    "what's the total number of emails from Pat Lee",
    'count of emails from Pat Lee',
    'how many e-mails from Pat Lee',
    'how many mails from Pat Lee',
    'how much mail from Pat Lee',
    'tell me how many emails from Pat Lee',
  ])('fires on %j', (text) => {
    const t = match(text);
    expect(t).not.toBeNull();
    expect(t?.template_hash).toBe(MAIL_FROM_COUNT_TEMPLATE.template_hash);
  });
});

// ── Matcher: passes through (wrong-answer holes) ─────────────────────

describe('D-164 P7 mail from-count matcher — passes through', () => {
  it.each([
    // No count cue → a LIST request, not a count.
    ['bare mention (no cue)', 'emails from Pat Lee'],
    ['list request (what are)', 'what are my emails from Pat Lee'],
    ['list request (show me)', 'show me emails from Pat Lee'],
    ['who reframe', 'who emailed me'],
    // Filtered counts — the total can't answer a narrowed count.
    ['type modifier (unread)', 'how many unread emails from Pat Lee'],
    ['type modifier (important)', 'how many important emails from Pat Lee'],
    ['type modifier (recent)', 'how many recent emails from Pat Lee'],
    ['read-state filter (middle)', 'how many emails have I read from Pat Lee'],
    ['partitive (of my)', 'how many of my emails are from Pat Lee'],
    // Different intent / shape.
    ['frequency (how often)', 'how often does Pat Lee email me'],
    ['occurrence count (how many times)', 'how many times did Pat Lee email me'],
    // Recipient, not sender.
    ['recipient (to)', 'how many emails to Pat Lee'],
    // Non-owner subject in the middle.
    ['non-owner subject (she)', 'how many emails does she have from Pat Lee'],
    ['non-owner subject (they)', 'how many emails do they have from Pat Lee'],
    ['non-owner subject (you)', 'how many emails do you have from Pat Lee'],
    // Trailing constraint after the name (not $-anchored).
    ['trailing time constraint', 'how many emails from Pat Lee this week'],
    ['trailing clause', 'how many emails from Pat Lee about the budget'],
    ['trailing conjunction (single-token party)', 'how many emails from Pat Lee and Bob'],
    ['possessive counterpart', "how many emails from Pat Lee's team"],
    // Duplicate cue in the lead.
    ['duplicate cue', 'how many number of emails from Pat Lee'],
    // Cue not directly followed by the mail noun.
    ['modifier between cue and noun', 'how many work emails from Pat Lee'],
  ])('passes through: %s', (_label, text) => {
    expect(match(text)).toBeNull();
  });

  it.each([
    'delete all emails from Pat Lee',
    'archive emails from Pat Lee',
    'mark emails from Pat Lee as read',
    'forward emails from Pat Lee',
    'move emails from Pat Lee to a folder',
  ])('passes through a write: %j', (text) => {
    expect(match(text)).toBeNull();
  });

  it('passes through when more than one name slot is present (ambiguous)', () => {
    const slots = [nameSlot('Pat Lee'), nameSlot('Bob Stone', 40)];
    expect(match('how many emails from Pat Lee and Bob Stone', slots)).toBeNull();
  });

  it('passes through when an email slot rides along (more specific request)', () => {
    const slots = [nameSlot('Pat Lee'), makeSlot('entity.email', 'pat@x.com', 40)];
    expect(match('how many emails from Pat Lee at pat@x.com', slots)).toBeNull();
  });

  it('passes through when a date slot rides along (more specific request)', () => {
    const slots = [nameSlot('Pat Lee'), makeSlot('date', '2026-01-01', 40)];
    expect(match('how many emails from Pat Lee since 2026-01-01', slots)).toBeNull();
  });

  it('passes through when the sole slot is not a name', () => {
    const slots = [makeSlot('entity.email', 'pat@x.com')];
    expect(match('how many emails from pat@x.com', slots)).toBeNull();
  });

  it('passes through when the name is used as a recipient, not the trailing sender', () => {
    // "from <other> to Pat Lee" — Pat is the recipient; the $-anchored core
    // needs `from Pat Lee` AT THE END, so this never matches.
    expect(match('how many emails to Pat Lee from the team')).toBeNull();
  });
});

// ── Probe ───────────────────────────────────────────────────────────

describe('D-164 P7 mail from-count probe', () => {
  it('resolves the contact + count into a frozen {name, count_phrase} snapshot', async () => {
    const count = vi.fn<MailFromCountLookup>(() => 2);
    const out = await runProbe({ contact: () => [PAT], count });

    expect(count).toHaveBeenCalledWith(['pat@x.com']);
    expect(out?.data).toEqual({
      name: 'Pat Lee',
      count_phrase: '2 emails',
    });
    expect(Object.isFrozen(out?.data)).toBe(true);
  });

  it('hands the WHOLE linked address set to the count lookup (multi-address)', async () => {
    const count = vi.fn<MailFromCountLookup>(() => 5);
    const merged: ContactAttributeLookup = () => [
      { name: 'Pat Lee', email: 'pat@x.com', emails: ['pat@x.com', 'pat@old.com'] },
    ];
    const out = await runProbe({ contact: merged, count });
    expect(count).toHaveBeenCalledWith(['pat@x.com', 'pat@old.com']);
    expect(out?.data).toEqual({ name: 'Pat Lee', count_phrase: '5 emails' });
  });

  it('pluralizes a single email as "1 email"', async () => {
    const out = await runProbe({ count: () => 1 });
    expect(out?.data.count_phrase).toBe('1 email');
  });

  it('matches the contact by exact name even when the lookup returns near-misses', async () => {
    const contact: ContactAttributeLookup = () => [
      { name: 'Pat Leeson', email: 'leeson@x.com', emails: ['leeson@x.com'] },
      { name: 'pat lee', email: 'pat@x.com', emails: ['pat@x.com'] },
    ];
    const out = await runProbe({ contact });
    expect(out?.data).toEqual({ name: 'pat lee', count_phrase: '2 emails' });
  });

  it('defers (null) a ZERO count — a confident "no emails" is the least-safe answer', async () => {
    const count = vi.fn<MailFromCountLookup>(() => 0);
    expect(await runProbe({ count })).toBeNull();
    expect(count).toHaveBeenCalledWith(['pat@x.com']);
  });

  it('defers (null) a contact row WITHOUT the linked address set — the person-scoped total needs the completeness claim', async () => {
    const noSet: ContactAttributeLookup = () => [{ name: 'Pat Lee', email: 'pat@x.com' }];
    const count = vi.fn<MailFromCountLookup>(() => 2);
    expect(await runProbe({ contact: noSet, count })).toBeNull();
    expect(count).not.toHaveBeenCalled();
  });

  it('defers (null) an empty or malformed address set', async () => {
    const empty: ContactAttributeLookup = () => [
      { name: 'Pat Lee', email: 'pat@x.com', emails: [] },
    ];
    expect(await runProbe({ contact: empty })).toBeNull();
    const blank: ContactAttributeLookup = () => [
      { name: 'Pat Lee', email: 'pat@x.com', emails: ['pat@x.com', '   '] },
    ];
    expect(await runProbe({ contact: blank })).toBeNull();
  });

  it('passes through (null) when the count lookup returns null (no mailbox / read error)', async () => {
    expect(await runProbe({ count: () => null })).toBeNull();
  });

  it.each([
    ['negative', -1],
    ['NaN', Number.NaN],
    ['fractional', 2.5],
  ])('passes through (null) on a %s count (lookup bug)', async (_label, n) => {
    expect(await runProbe({ count: () => n })).toBeNull();
  });

  it('passes through (null) when the contact does not resolve uniquely', async () => {
    const ambiguous: ContactAttributeLookup = () => [
      { name: 'Pat Lee', email: 'pat-1@x.com' },
      { name: 'pat lee', email: 'pat-2@x.com' },
    ];
    expect(await runProbe({ contact: ambiguous })).toBeNull();
  });

  it('passes through (null) when the resolved contact has no email to count against', async () => {
    const noEmail: ContactAttributeLookup = () => [
      { name: 'Pat Lee', email: '   ', emails: ['pat@x.com'] },
    ];
    const count = vi.fn<MailFromCountLookup>(() => 2);
    expect(await runProbe({ contact: noEmail, count })).toBeNull();
    expect(count).not.toHaveBeenCalled();
  });

  it('passes through (null) when the count lookup throws', async () => {
    const count: MailFromCountLookup = () => {
      throw new Error('warehouse read failed');
    };
    expect(await runProbe({ count })).toBeNull();
  });

  it('awaits an async count lookup', async () => {
    const out = await runProbe({ count: () => Promise.resolve(7) });
    expect(out?.data.count_phrase).toBe('7 emails');
  });
});

// ── Composer (now three families) ────────────────────────────────────

describe('D-164 P7 composeShortCircuitFamilies — three families', () => {
  const contactFamily: ShortCircuitFamily = {
    match: matchContactAttributeTemplate,
    probe: createContactAttributePresenceProbe(() => [
      { name: 'Pat Lee', email: 'pat@x.com', phone: '+1' },
    ]),
    templateHashes: new Set(
      Object.values(CONTACT_ATTRIBUTE_TEMPLATES).map((t) => t.template_hash),
    ),
  };
  const calendarFamily: ShortCircuitFamily = {
    match: matchCalendarNextMeetingTemplate,
    probe: createCalendarNextMeetingProbe(
      () => [PAT],
      () => ({ summary: 'Quarterly business review', when: 'Wednesday' }),
    ),
    templateHashes: new Set([CALENDAR_NEXT_MEETING_TEMPLATE.template_hash]),
  };
  const mailFamily: ShortCircuitFamily = {
    match: matchMailFromCountTemplate,
    probe: createMailFromCountProbe(() => [PAT], () => 2),
    templateHashes: new Set([MAIL_FROM_COUNT_TEMPLATE.template_hash]),
  };
  const families = [contactFamily, calendarFamily, mailFamily];

  it('matcher routes a mail-count prompt to the mail template', async () => {
    const { matchTemplate } = composeShortCircuitFamilies(families);
    const t = await matchTemplate({
      text: 'how many emails from Pat Lee',
      slots: [nameSlot()],
      locale: 'en',
    });
    expect(t?.template_hash).toBe(MAIL_FROM_COUNT_TEMPLATE.template_hash);
  });

  it('matcher still routes the contact + calendar prompts correctly alongside the mail family', async () => {
    const { matchTemplate } = composeShortCircuitFamilies(families);
    const contactMatch = await matchTemplate({
      text: "what is Pat Lee's email?",
      slots: [nameSlot('Pat Lee', 8)],
      locale: 'en',
    });
    expect(contactMatch?.template_hash).toBe(CONTACT_ATTRIBUTE_TEMPLATES.email.template_hash);

    const calMatch = await matchTemplate({
      text: 'when is my next meeting with Pat Lee',
      slots: [nameSlot('Pat Lee', 25)],
      locale: 'en',
    });
    expect(calMatch?.template_hash).toBe(CALENDAR_NEXT_MEETING_TEMPLATE.template_hash);
  });

  it('probe routes the mail-count template to its owning family by hash', async () => {
    const { probeData } = composeShortCircuitFamilies(families);
    const mailSnap = await probeData({
      template: MAIL_FROM_COUNT_TEMPLATE,
      slots: [nameSlot()],
    });
    expect(mailSnap?.data).toMatchObject({ count_phrase: '2 emails', name: 'Pat Lee' });
  });
});

// ── Render ──────────────────────────────────────────────────────────

describe('D-164 P7 mail from-count render', () => {
  it('renders the person-scoped body from a probe snapshot', () => {
    const render = createTemplateRenderer();
    const out = render(MAIL_FROM_COUNT_TEMPLATE, {
      data: { name: 'Pat Lee', count_phrase: '2 emails' },
    });
    expect(out).toBe('You have 2 emails from Pat Lee.');
  });

  it('renders the singular form', () => {
    const render = createTemplateRenderer();
    const out = render(MAIL_FROM_COUNT_TEMPLATE, {
      data: { name: 'Pat Lee', count_phrase: '1 email' },
    });
    expect(out).toBe('You have 1 email from Pat Lee.');
  });

  it('declines (empty render) when the count-phrase placeholder is missing — gate passes through', () => {
    const render = createTemplateRenderer();
    const out = render(MAIL_FROM_COUNT_TEMPLATE, {
      data: { name: 'Pat Lee' },
    });
    expect(out).toBe('');
  });
});
