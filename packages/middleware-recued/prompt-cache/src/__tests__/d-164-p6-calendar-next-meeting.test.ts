/** D-164 P6 — calendar next-meeting short-circuit class.
 *
 *  Covers the second short-circuit family (the first reading a non-contact
 *  collection): the intent-aware matcher, the contact-resolving + calendar
 *  probe, the multi-family composer, the shared `resolveUniqueExactContact`
 *  helper, and the body render. The three correctness holes a Codex review
 *  surfaced (and we folded) get explicit regression cases:
 *    - calendar/general write verbs must pass through (never answer a write
 *      as a read);
 *    - a `with <Name>'s <thing>` possessive must NOT fire on `<Name>`;
 *    - (all-day date-shift lives in the backend formatter test). */

import { describe, expect, it, vi } from 'vitest';

import {
  CALENDAR_NEXT_MEETING_TEMPLATE,
  CONTACT_ATTRIBUTE_TEMPLATES,
  composeShortCircuitFamilies,
  createCalendarNextMeetingProbe,
  createContactAttributePresenceProbe,
  createTemplateRenderer,
  matchCalendarNextMeetingTemplate,
  matchContactAttributeTemplate,
  resolveUniqueExactContact,
  type CalendarNextMeeting,
  type CalendarNextMeetingLookup,
  type ContactAttributeLookup,
  type ContactAttributeRow,
  type DataSnapshot,
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

const nameSlot = (value = 'Pat Lee', position = 25): SlotValue =>
  makeSlot('entity.name', value, position);

const match = (
  text: string,
  slots: ReadonlyArray<SlotValue> = [nameSlot()],
): Template | null =>
  matchCalendarNextMeetingTemplate({ text, slots, locale: 'en' }) as Template | null;

const meeting = (over: Partial<CalendarNextMeeting> = {}): CalendarNextMeeting => ({
  summary: 'Quarterly business review',
  when: 'Wednesday, July 8, 2026 at 9:00 AM EDT',
  ...over,
});

const PAT: ContactAttributeRow = {
  name: 'Pat Lee',
  email: 'pat@x.com',
  emails: ['pat@x.com'],
};

const runProbe = async (
  opts: {
    readonly contact?: ContactAttributeLookup;
    readonly next?: CalendarNextMeetingLookup;
    readonly slots?: ReadonlyArray<SlotValue>;
  } = {},
): Promise<DataSnapshot | null> => {
  const probe = createCalendarNextMeetingProbe(
    opts.contact ?? (() => [PAT]),
    opts.next ?? (() => meeting()),
  );
  return await probe({
    template: CALENDAR_NEXT_MEETING_TEMPLATE,
    slots: opts.slots ?? [nameSlot()],
  });
};

// ── Matcher ─────────────────────────────────────────────────────────

describe('D-164 P6 calendar next-meeting matcher', () => {
  it.each([
    'When is my next meeting with Pat Lee?',
    'when is my next meeting with Pat Lee',
    "when's my next meeting with Pat Lee?",
    'my next meeting with Pat Lee',
    "what's my upcoming call with Pat Lee?",
    'soonest sync with Pat Lee',
    'when do I next meet with Pat Lee',
    'when is my next 1:1 with Pat Lee',
  ])('fires on %j', (text) => {
    const t = match(text);
    expect(t).not.toBeNull();
    expect(t?.template_hash).toBe(CALENDAR_NEXT_MEETING_TEMPLATE.template_hash);
  });

  it('does not over-extract a capitalized sentence-initial word (single cap word ≠ name run)', () => {
    // The matcher is fed exactly the NER slots; "When" is a single
    // capitalized word so the English NER never emits it as a name run. We
    // pin that the canonical prompt yields a single-name match here.
    expect(match('When is my next meeting with Pat Lee?')).not.toBeNull();
  });

  it.each([
    ['no NEXT cue (bare "when")', 'when is my meeting with Pat Lee'],
    ['past tense (no next cue)', 'when was my meeting with Pat Lee'],
    ['no meeting noun', 'what is my next thing with Pat Lee'],
    ['no "with" linkage', "Pat Lee's next meeting"],
    ['possessive counterpart', "when is my next meeting with Pat Lee's team"],
    ['trailing day constraint', 'when is my next meeting with Pat Lee on Tuesday'],
    ['trailing conjunction (single-token party)', 'when is my next meeting with Pat Lee and Bob'],
    ['trailing clause', 'when is my next meeting with Pat Lee scheduled'],
    ['foreign possessive subject', "when is Sarah's next meeting with Pat Lee"],
    ['foreign possessive (the team)', "when is the team's next meeting with Pat Lee"],
    ['counterpart not directly after with', 'when is my next meeting with Bob and Pat Lee'],
    ['type modifier (budget meeting)', 'when is my next budget meeting with Pat Lee'],
    ['type modifier (sales call)', 'when is my next sales call with Pat Lee'],
    ['modifier between noun and with', 'when is my next meeting about budget with Pat Lee'],
    ['possessive pronoun subject (her)', 'when is her next meeting with Pat Lee'],
    ['possessive pronoun subject (their)', 'when is their next meeting with Pat Lee'],
    ['possessive pronoun subject (his)', 'when is his next meeting with Pat Lee'],
    ['plural possessive subject', "when is the clients' next meeting with Pat Lee"],
    ['agenda content reframe', "what's the agenda for my next meeting with Pat Lee"],
    ['location reframe (where)', 'where is my next meeting with Pat Lee'],
    ['attendee reframe (who)', "who's coming to my next meeting with Pat Lee"],
    ['duration reframe (how long)', 'how long is my next meeting with Pat Lee'],
    ['prepare reframe', 'prepare for my next meeting with Pat Lee'],
    ['notes reframe', 'pull the notes for my next meeting with Pat Lee'],
    ['duplicate cue (next next → meeting after the next)', 'when is my next next meeting with Pat Lee'],
    ['plural list question (meetings)', 'what are my upcoming meetings with Pat Lee'],
    ['plural list question (calls)', 'what are my upcoming calls with Pat Lee'],
  ])('passes through: %s', (_label, text) => {
    expect(match(text)).toBeNull();
  });

  it.each([
    'schedule my next meeting with Pat Lee',
    'cancel my next meeting with Pat Lee',
    'reschedule my next meeting with Pat Lee',
    'change my next meeting with Pat Lee',
    'update my next meeting with Pat Lee',
    'move my next meeting with Pat Lee to Friday',
    'set up my next call with Pat Lee',
    'postpone my next meeting with Pat Lee',
  ])('passes through a write: %j', (text) => {
    expect(match(text)).toBeNull();
  });

  it('passes through when more than one name slot is present (ambiguous)', () => {
    const slots = [nameSlot('Pat Lee'), nameSlot('Bob Stone', 40)];
    expect(match('next meeting with Pat Lee and Bob Stone', slots)).toBeNull();
  });

  it('passes through when an email slot rides along (more specific request)', () => {
    const slots = [nameSlot('Pat Lee'), makeSlot('entity.email', 'pat@x.com', 40)];
    expect(match('next meeting with Pat Lee at pat@x.com', slots)).toBeNull();
  });

  it('passes through when the sole slot is not a name', () => {
    const slots = [makeSlot('entity.email', 'pat@x.com')];
    expect(match('next meeting with pat@x.com', slots)).toBeNull();
  });
});

// ── Probe ───────────────────────────────────────────────────────────

describe('D-164 P6 calendar next-meeting probe', () => {
  it('resolves the contact + meeting into a frozen {name, summary, when} snapshot', async () => {
    const next = vi.fn<CalendarNextMeetingLookup>(() => meeting());
    const out = await runProbe({ contact: () => [PAT], next });

    expect(next).toHaveBeenCalledWith(['pat@x.com']);
    expect(out?.data).toEqual({
      name: 'Pat Lee',
      summary: 'Quarterly business review',
      when: 'Wednesday, July 8, 2026 at 9:00 AM EDT',
    });
    expect(Object.isFrozen(out?.data)).toBe(true);
  });

  it('matches the contact by exact name even when the lookup returns near-misses', async () => {
    const contact: ContactAttributeLookup = () => [
      { name: 'Pat Leeson', email: 'leeson@x.com', emails: ['leeson@x.com'] },
      { name: 'pat lee', email: 'pat@x.com', emails: ['pat@x.com'] },
    ];
    const out = await runProbe({ contact });
    expect(out?.data).toEqual({
      name: 'pat lee',
      summary: 'Quarterly business review',
      when: 'Wednesday, July 8, 2026 at 9:00 AM EDT',
    });
  });

  it('passes through (null) when the contact does not resolve uniquely', async () => {
    const ambiguous: ContactAttributeLookup = () => [
      { name: 'Pat Lee', email: 'pat-1@x.com' },
      { name: 'pat lee', email: 'pat-2@x.com' },
    ];
    expect(await runProbe({ contact: ambiguous })).toBeNull();
  });

  it('passes through (null) when the resolved contact has no email to match attendees', async () => {
    const noEmail: ContactAttributeLookup = () => [{ name: 'Pat Lee', email: '   ' }];
    const next = vi.fn<CalendarNextMeetingLookup>(() => meeting());
    expect(await runProbe({ contact: noEmail, next })).toBeNull();
    expect(next).not.toHaveBeenCalled();
  });

  // The complete-set requirement: "next" is a superlative over EVERY linked
  // address, so a row without the `ContactAttributeRow.emails` completeness
  // claim must defer — `email` alone never stands in.
  it.each([
    ['emails absent (no completeness claim)', { name: 'Pat Lee', email: 'pat@x.com' }],
    ['emails empty', { name: 'Pat Lee', email: 'pat@x.com', emails: [] as readonly string[] }],
    [
      'emails with a malformed member',
      { name: 'Pat Lee', email: 'pat@x.com', emails: ['pat@x.com', '  '] as readonly string[] },
    ],
  ])('passes through (null) on %s — lookup never called', async (_label, row) => {
    const next = vi.fn<CalendarNextMeetingLookup>(() => meeting());
    expect(await runProbe({ contact: () => [row], next })).toBeNull();
    expect(next).not.toHaveBeenCalled();
  });

  it('hands the COMPLETE multi-address set to the lookup verbatim', async () => {
    const multi: ContactAttributeRow = {
      name: 'Pat Lee',
      email: 'pat@x.com',
      emails: ['pat@x.com', 'old-pat@y.com'],
    };
    const next = vi.fn<CalendarNextMeetingLookup>(() => meeting());
    const out = await runProbe({ contact: () => [multi], next });
    expect(next).toHaveBeenCalledWith(['pat@x.com', 'old-pat@y.com']);
    expect(out?.data.name).toBe('Pat Lee');
  });

  it('passes through (null) when there is no future meeting with the attendee', async () => {
    expect(await runProbe({ next: () => null })).toBeNull();
  });

  it.each([
    ['blank summary', meeting({ summary: '  ' })],
    ['blank when', meeting({ when: '' })],
  ])('passes through (null) on a %s', async (_label, m) => {
    expect(await runProbe({ next: () => m })).toBeNull();
  });

  it('passes through (null) when the calendar lookup throws', async () => {
    const next: CalendarNextMeetingLookup = () => {
      throw new Error('warehouse read failed');
    };
    expect(await runProbe({ next })).toBeNull();
  });

  it('awaits an async calendar lookup', async () => {
    const next: CalendarNextMeetingLookup = () => Promise.resolve(meeting({ summary: 'Async sync' }));
    const out = await runProbe({ next });
    expect(out?.data.summary).toBe('Async sync');
  });
});

// ── Shared resolver ─────────────────────────────────────────────────

describe('D-164 P6 resolveUniqueExactContact (shared identity step)', () => {
  it('returns the unique exact row', async () => {
    const row = await resolveUniqueExactContact(() => [PAT], [nameSlot()]);
    expect(row).toEqual(PAT);
  });

  it.each([
    ['zero names', [] as ReadonlyArray<SlotValue>],
    ['two names', [nameSlot('Pat Lee'), nameSlot('Bob Stone', 40)]],
  ])('returns null for %s', async (_label, slots) => {
    expect(await resolveUniqueExactContact(() => [PAT], slots)).toBeNull();
  });

  it('returns null when the lookup throws', async () => {
    const lookup: ContactAttributeLookup = () => {
      throw new Error('boom');
    };
    expect(await resolveUniqueExactContact(lookup, [nameSlot()])).toBeNull();
  });
});

// ── Composer ────────────────────────────────────────────────────────

describe('D-164 P6 composeShortCircuitFamilies', () => {
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
    probe: createCalendarNextMeetingProbe(() => [PAT], () => meeting()),
    templateHashes: new Set([CALENDAR_NEXT_MEETING_TEMPLATE.template_hash]),
  };

  it('matcher tries families in order and returns the first non-null template', async () => {
    const { matchTemplate } = composeShortCircuitFamilies([contactFamily, calendarFamily]);
    const calMatch = await matchTemplate({
      text: 'when is my next meeting with Pat Lee',
      slots: [nameSlot()],
      locale: 'en',
    });
    expect(calMatch?.template_hash).toBe(CALENDAR_NEXT_MEETING_TEMPLATE.template_hash);

    const contactMatch = await matchTemplate({
      text: "what is Pat Lee's email?",
      slots: [nameSlot('Pat Lee', 8)],
      locale: 'en',
    });
    expect(contactMatch?.template_hash).toBe(CONTACT_ATTRIBUTE_TEMPLATES.email.template_hash);
  });

  it('probe routes a matched template to its owning family by hash', async () => {
    const { probeData } = composeShortCircuitFamilies([contactFamily, calendarFamily]);
    const calSnap = await probeData({
      template: CALENDAR_NEXT_MEETING_TEMPLATE,
      slots: [nameSlot()],
    });
    expect(calSnap?.data).toMatchObject({ summary: 'Quarterly business review' });

    const contactSnap = await probeData({
      template: CONTACT_ATTRIBUTE_TEMPLATES.email,
      slots: [nameSlot('Pat Lee', 8)],
    });
    expect(contactSnap?.data).toMatchObject({ email: 'pat@x.com' });
  });

  it('probe returns null for a template no family claims', async () => {
    const { probeData } = composeShortCircuitFamilies([contactFamily, calendarFamily]);
    const unknown: Template = {
      template_hash: 'recued/unclaimed@v1',
      kind: 'render_template',
      slot_grammar: ['entity.name'],
      action_class: 'read',
      short_circuit_eligible: true,
      body: '{{name}}',
    };
    expect(await probeData({ template: unknown, slots: [nameSlot()] })).toBeNull();
  });

  it('matcher returns null when no family matches', async () => {
    const { matchTemplate } = composeShortCircuitFamilies([contactFamily, calendarFamily]);
    expect(
      await matchTemplate({ text: 'what is the weather', slots: [], locale: 'en' }),
    ).toBeNull();
  });
});

// ── Render ──────────────────────────────────────────────────────────

describe('D-164 P6 calendar next-meeting render', () => {
  it('renders the body from a probe snapshot', () => {
    const render = createTemplateRenderer();
    const out = render(CALENDAR_NEXT_MEETING_TEMPLATE, {
      data: {
        name: 'Pat Lee',
        summary: 'Quarterly business review',
        when: 'Wednesday, July 8, 2026 at 9:00 AM EDT',
      },
    });
    expect(out).toBe(
      'Your next meeting with Pat Lee is "Quarterly business review" on Wednesday, July 8, 2026 at 9:00 AM EDT.',
    );
  });

  it('declines (empty render) when a placeholder is missing — gate passes through', () => {
    const render = createTemplateRenderer();
    const out = render(CALENDAR_NEXT_MEETING_TEMPLATE, {
      data: { name: 'Pat Lee', summary: 'Quarterly business review' },
    });
    expect(out).toBe('');
  });
});
