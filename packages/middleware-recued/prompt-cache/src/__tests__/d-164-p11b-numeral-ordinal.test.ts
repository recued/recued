/** D-164 P11b - numeral ordinal widening.
 *
 *  Pins the narrow detector arm (`the 2nd one`) together with the
 *  stricter list binder. Numeral ordinals may route loosely, but only
 *  suffix-agreeing, one-headed, exactly-one list references bind.
 */

import { describe, expect, it, vi } from 'vitest';

import type { SessionEntry } from '@recued/chat';
import type { TurnContext } from '@recued/middleware';

import {
  CALENDAR_NEXT_MEETING_TEMPLATE,
  CONTACT_ATTRIBUTE_TEMPLATES,
  CONTACT_HAS_EMAIL_TEMPLATE,
  CONTACT_HAS_NO_EMAIL_TEMPLATE,
  MAIL_FROM_COUNT_TEMPLATE,
  composeShortCircuitFamilies,
  createCalendarNextMeetingProbe,
  createContactAttributePresenceProbe,
  createContactHasEmailProbe,
  createMailFromCountProbe,
  createTemplateRenderer,
  matchCalendarNextMeetingTemplate,
  matchContactAttributeTemplate,
  matchContactHasEmailTemplate,
  matchMailFromCountTemplate,
  rewriteAnaphoricPrompt,
  runGate,
  type AnaphoraRewriteInput,
  type ContactAttributeRow,
  type GateDeps,
  type ShortCircuitFamily,
} from '../index';
import {
  attach,
  detectAnaphora,
  type AnaphoraSignal,
} from '../intention/index';

const LIST_REFERENT = '1. Pat Lee\n2. Bob Stone\n3. Ann Chu';

const signal = (
  kind: AnaphoraSignal['kind'],
  trigger: string,
  position = 0,
): AnaphoraSignal => ({ kind, trigger, position });

const rewrite = (
  promptText: string,
  over: Partial<AnaphoraRewriteInput> = {},
): string | null =>
  rewriteAnaphoricPrompt({
    promptText,
    referentText: LIST_REFERENT,
    signal: signal('ordinal', 'the 2nd one'),
    ...over,
  });

const makeSessionEntry = (
  role: SessionEntry['role'],
  text: string,
  ts = 0,
): SessionEntry => ({
  session_id: 's',
  surface: 'chat',
  role,
  text,
  ts,
});

const makeTurnContext = (
  history: readonly SessionEntry[],
  state = new Map<string, unknown>(),
) => {
  const contribute = vi.fn();
  const resolve = vi.fn();
  const stateSet = vi.spyOn(state, 'set');
  const stateDelete = vi.spyOn(state, 'delete');
  const ctx = {
    surface: 'chat',
    history,
    prompt: {
      contribute,
      parts: () => [],
    },
    resolve,
    state,
  } as unknown as TurnContext;

  return { contribute, ctx, resolve, state, stateDelete, stateSet };
};

const CONTACT_ROWS = [
  {
    name: 'Pat Lee',
    email: 'pat@x.com',
    emails: ['pat@x.com'],
    phone: '+1 555 0100',
  },
  {
    name: 'Bob Stone',
    email: 'bob@y.com',
    emails: ['bob@y.com'],
    phone: '+1 555 0200',
  },
  {
    name: 'Ann Chu',
    email: 'ann@z.com',
    emails: ['ann@z.com'],
  },
] satisfies readonly ContactAttributeRow[];

const makeRealFamilyDeps = (): GateDeps => {
  const contactLookup = (name: string) =>
    CONTACT_ROWS.filter((r) => r.name.toLowerCase() === name.toLowerCase());
  const families: readonly ShortCircuitFamily[] = [
    {
      match: matchContactHasEmailTemplate,
      probe: createContactHasEmailProbe(
        contactLookup,
        () => false,
        CONTACT_HAS_NO_EMAIL_TEMPLATE,
      ),
      templateHashes: new Set([CONTACT_HAS_EMAIL_TEMPLATE.template_hash]),
      overrideTemplates: [CONTACT_HAS_NO_EMAIL_TEMPLATE],
    },
    {
      match: matchContactAttributeTemplate,
      probe: createContactAttributePresenceProbe(contactLookup),
      templateHashes: new Set(
        Object.values(CONTACT_ATTRIBUTE_TEMPLATES).map((t) => t.template_hash),
      ),
    },
    {
      match: matchCalendarNextMeetingTemplate,
      probe: createCalendarNextMeetingProbe(
        contactLookup,
        () => ({ summary: 'QBR', when: 'Wednesday' }),
      ),
      templateHashes: new Set([CALENDAR_NEXT_MEETING_TEMPLATE.template_hash]),
    },
    {
      match: matchMailFromCountTemplate,
      probe: createMailFromCountProbe(contactLookup, () => 2),
      templateHashes: new Set([MAIL_FROM_COUNT_TEMPLATE.template_hash]),
    },
  ];
  return {
    ...composeShortCircuitFamilies(families),
    renderTemplate: createTemplateRenderer(),
  };
};

const runListGate = async (
  followUp: string,
  referentText = LIST_REFERENT,
) => {
  const { ctx, resolve } = makeTurnContext([
    makeSessionEntry('user', 'Which contacts did we find?', 1),
    makeSessionEntry('assistant', referentText, 2),
    makeSessionEntry('user', followUp, 3),
  ]);
  attach(ctx);
  return { outcome: await runGate(ctx, makeRealFamilyDeps()), resolve };
};

const referentFor = (names: readonly string[]): string =>
  names.map((name, i) => `${i + 1}. ${name}`).join('\n');

const LONG_NAMES = [
  'Ada Adams', 'Ada Baker', 'Ada Carter', 'Ada Dixon', 'Ada Ellis',
  'Ada Foster', 'Ada Gray', 'Ada Hale', 'Ada Irwin', 'Ada Jones',
  'Ada King', 'Ada Lane', 'Ada Mills', 'Ben Adams', 'Ben Baker',
  'Ben Carter', 'Ben Dixon', 'Ben Ellis', 'Ben Foster', 'Ben Gray',
  'Ben Hale', 'Ben Irwin', 'Ben Jones', 'Ben King', 'Ben Lane',
  'Ben Mills', 'Cara Adams', 'Cara Baker', 'Cara Carter', 'Cara Dixon',
  'Cara Ellis', 'Cara Foster', 'Cara Gray', 'Cara Hale', 'Cara Irwin',
  'Cara Jones', 'Cara King', 'Cara Lane', 'Cara Mills', 'Dena Adams',
  'Dena Baker', 'Dena Carter', 'Dena Dixon', 'Dena Ellis', 'Dena Foster',
  'Dena Gray', 'Dena Hale', 'Dena Irwin', 'Dena Jones', 'Dena King',
  'Dena Lane', 'Dena Mills', 'Eli Adams', 'Eli Baker', 'Eli Carter',
  'Eli Dixon', 'Eli Ellis', 'Eli Foster', 'Eli Gray', 'Eli Hale',
  'Eli Irwin', 'Eli Jones', 'Eli King', 'Eli Lane', 'Eli Mills',
  'Fiona Adams', 'Fiona Baker', 'Fiona Carter', 'Fiona Dixon',
  'Fiona Ellis', 'Fiona Foster', 'Fiona Gray', 'Fiona Hale',
  'Fiona Irwin', 'Fiona Jones', 'Fiona King', 'Fiona Lane',
  'Fiona Mills', 'Gina Adams', 'Gina Baker', 'Gina Carter',
  'Gina Dixon', 'Gina Ellis', 'Gina Foster', 'Gina Gray', 'Gina Hale',
  'Gina Irwin', 'Gina Jones', 'Gina King', 'Gina Lane', 'Gina Mills',
  'Hugo Adams', 'Hugo Baker', 'Hugo Carter', 'Hugo Dixon',
  'Hugo Ellis', 'Hugo Foster', 'Hugo Gray', 'Hugo Hale', 'Hugo Irwin',
  'Hugo Jones', 'Hugo King', 'Hugo Lane', 'Hugo Mills', 'Ivy Adams',
  'Ivy Baker', 'Ivy Carter', 'Ivy Dixon', 'Ivy Ellis', 'Ivy Foster',
  'Ivy Gray', 'Ivy Hale', 'Ivy Irwin',
] as const;
const TWENTY_FIVE_REFERENT = referentFor(LONG_NAMES.slice(0, 25));
const LONG_REFERENT = referentFor(LONG_NAMES);

describe('D-164 P11b detectAnaphora numeral ordinal arm', () => {
  it.each([
    ["what is the 2nd one's email?", 'the 2nd one', 8],
    ['the 1st one', 'the 1st one', 0],
    ['the 12th one', 'the 12th one', 0],
    ['the 2ND one', 'the 2nd one', 0],
    ['the 2th one', 'the 2th one', 0],
    ['the 111th one', 'the 111th one', 0],
  ])('detects %j as a numeral ordinal', (text, trigger, position) => {
    expect(detectAnaphora(text)).toEqual({
      kind: 'ordinal',
      trigger,
      position,
    });
  });

  it('keeps earliest-wins when a later pronoun follows', () => {
    expect(detectAnaphora('the 2nd one said they would reply')).toEqual({
      kind: 'ordinal',
      trigger: 'the 2nd one',
      position: 0,
    });
  });

  it.each([
    'the 2nd thing',
    'before the 25th',
    'on the 21st',
    'the 0th one',
    'the 011th one',
    'the 1000th one',
    'the 1st one-on-one',
  ])('does not route narrow exclusion %j', (text) => {
    expect(detectAnaphora(text)).toBeNull();
  });

  it.each([
    ['word ordinal', 'show the second one', signal('ordinal', 'the second', 5)],
    ['pronoun', 'what about her?', signal('pronoun', 'her', 11)],
    ['demonstrative', 'I want this one', signal('demonstrative', 'this one', 7)],
  ])('leaves the %s arm unchanged', (_label, text, expected) => {
    expect(detectAnaphora(text)).toEqual(expected);
  });
});

describe('D-164 P11b detector and binder coupling behavior', () => {
  it.each([
    ['the 2nd one', true, "what is Bob Stone's email?"],
    ['the 21st one', true, null],
    ['the 2th one', true, null],
    ['the 2nd thing', false, null],
    ['the 1st one-on-one', false, null],
    ['the 0th one', false, null],
  ])(
    'routes only countable numeral phrase %j',
    (token, detectorRoutes, expected) => {
      const prompt = `what is ${token}'s email?`;
      const detected = detectAnaphora(prompt);

      if (detectorRoutes) {
        expect(detected).toMatchObject({ kind: 'ordinal', trigger: token });
      } else {
        expect(detected).toBeNull();
      }

      // The private union is pinned behaviorally: routed numerals bind or
      // defer, while forced non-routed phrases count zero list references.
      expect(rewrite(prompt, {
        signal: detected ?? signal('ordinal', token, prompt.indexOf(token)),
      })).toBe(expected);
    },
  );
});

describe('D-164 P11b numeral selector and suffix agreement', () => {
  it.each([
    ['the 1st one', LIST_REFERENT, "what is Pat Lee's email?"],
    ['the 2nd one', LIST_REFERENT, "what is Bob Stone's email?"],
    ['the 3rd one', LIST_REFERENT, "what is Ann Chu's email?"],
    ['the 12th one', TWENTY_FIVE_REFERENT, `what is ${LONG_NAMES[11]}'s email?`],
    ['the 21st one', TWENTY_FIVE_REFERENT, `what is ${LONG_NAMES[20]}'s email?`],
    ['the 111th one', LONG_REFERENT, `what is ${LONG_NAMES[110]}'s email?`],
    ['the 112th one', LONG_REFERENT, `what is ${LONG_NAMES[111]}'s email?`],
    ['the 113th one', LONG_REFERENT, `what is ${LONG_NAMES[112]}'s email?`],
  ])('binds %s by numeric index', (token, referentText, expected) => {
    expect(rewrite(`what is ${token}'s email?`, {
      referentText,
      signal: signal('ordinal', token),
    })).toBe(expected);
  });

  it.each([
    ['the 2th one', 'the 2nd one', LIST_REFERENT, "what is Bob Stone's email?"],
    ['the 1nd one', 'the 1st one', LIST_REFERENT, "what is Pat Lee's email?"],
    ['the 3st one', 'the 3rd one', LIST_REFERENT, "what is Ann Chu's email?"],
    [
      'the 11st one',
      'the 11th one',
      referentFor(LONG_NAMES.slice(0, 11)),
      `what is ${LONG_NAMES[10]}'s email?`,
    ],
  ])(
    'defers suffix typo %s where %s would bind',
    (wrongToken, rightToken, referentText, expected) => {
      expect(rewrite(`what is ${wrongToken}'s email?`, {
        referentText,
        signal: signal('ordinal', wrongToken),
      })).toBeNull();
      expect(rewrite(`what is ${rightToken}'s email?`, {
        referentText,
        signal: signal('ordinal', rightToken),
      })).toBe(expected);
    },
  );
});

describe('D-164 P11b exactly-one and zero-pronoun guards', () => {
  it.each([
    ['two numeral references', 'the 1st one or the 2nd one?'],
    ['word and numeral references', 'the first one or the 2nd one?'],
    ['pronoun riding along', 'what is the 2nd one and his email?'],
    ['prompt-side name', "what is the 2nd one's email, and Pat Lee's?"],
  ])('defers %s', (_label, prompt) => {
    expect(rewrite(prompt)).toBeNull();
  });
});

describe('D-164 P11b runGate e2e through the real four-family composition', () => {
  it('short-circuits a second-item email lookup', async () => {
    const { outcome, resolve } = await runListGate(
      "what is the 2nd one's email?",
    );

    expect(outcome).toEqual({
      kind: 'short-circuit',
      text: "Bob Stone's email address is bob@y.com.",
    });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith("Bob Stone's email address is bob@y.com.");
  });

  it('short-circuits a third-item mail count lookup', async () => {
    const { outcome, resolve } = await runListGate(
      'how many emails from the 3rd one?',
    );

    expect(outcome.kind).toBe('short-circuit');
    expect(outcome.kind === 'short-circuit' ? outcome.text : '').toContain(
      '2 emails from Ann Chu',
    );
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('short-circuits a first-item next-meeting lookup', async () => {
    const { outcome, resolve } = await runListGate(
      'when is my next meeting with the 1st one?',
    );

    expect(outcome.kind).toBe('short-circuit');
    expect(outcome.kind === 'short-circuit' ? outcome.text : '').toContain('QBR');
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['out of range', "what is the 4th one's email?"],
    ['suffix typo', "what is the 2th one's email?"],
  ])('passes through %s as unresolved anaphora', async (_label, followUp) => {
    const { outcome, resolve } = await runListGate(followUp);

    expect(outcome).toEqual({
      kind: 'pass-through',
      reason: 'anaphora-unresolved',
    });
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('D-164 P11b direct-path preservation e2e', () => {
  it.each([
    ['noun modifier', "btw the 2nd thing: what is Pat Lee's email?"],
    ['compound one-on-one', "After the 1st one-on-one, what is Pat Lee's email?"],
  ])('keeps %s on the direct path', async (_label, followUp) => {
    const { outcome, resolve } = await runListGate(followUp);

    expect(outcome).toEqual({
      kind: 'short-circuit',
      text: "Pat Lee's email address is pat@x.com.",
    });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith("Pat Lee's email address is pat@x.com.");
  });

  it('keeps date-shaped numerals off the anaphora path', async () => {
    const { outcome, resolve } = await runListGate(
      'do I have meetings on the 21st?',
    );

    expect(outcome.kind).toBe('pass-through');
    if (outcome.kind === 'pass-through') {
      expect(outcome.reason).not.toBe('anaphora-unresolved');
      expect(['no-extraction', 'no-template']).toContain(outcome.reason);
    }
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('D-164 P11b accepted design pin', () => {
  it('allows a lead-position discourse numeral before the real list reference', async () => {
    const { outcome, resolve } = await runListGate(
      "the 3rd thing: what is the 1st one's email?",
    );

    // Accepted residual risk: the numeral-kind head check is blind by
    // design, and the rewritten direct prompt still names the right person.
    expect(outcome).toEqual({
      kind: 'short-circuit',
      text: "Pat Lee's email address is pat@x.com.",
    });
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});
