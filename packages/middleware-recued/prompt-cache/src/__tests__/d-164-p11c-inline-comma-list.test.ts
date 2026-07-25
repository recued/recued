/** D-164 P11c - inline comma-list referent grammar.
 *
 *  Pins the prose-enumeration sibling of P11's line-list binder. Inline
 *  lists only bind when every certainty-gated name forms one exact chain,
 *  the lead is provably item-free, and the tail carries no hidden item.
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
  containsListMarkerLine,
  createCalendarNextMeetingProbe,
  createContactAttributePresenceProbe,
  createContactHasEmailProbe,
  createMailFromCountProbe,
  createTemplateRenderer,
  matchCalendarNextMeetingTemplate,
  matchContactAttributeTemplate,
  matchContactHasEmailTemplate,
  matchMailFromCountTemplate,
  parseInlineNameList,
  rewriteAnaphoricPrompt,
  runGate,
  type AnaphoraRewriteInput,
  type ContactAttributeRow,
  type GateDeps,
  type ShortCircuitFamily,
} from '../index';
import {
  attach,
  INTENTION_RESULT_STATE_KEY,
  type AnaphoraSignal,
} from '../intention/index';

const INLINE_REFERENT =
  'You met with 3 people last week: Pat Lee, Bob Stone, and Ann Chu.';
const LINE_REFERENT = '1. Pat Lee\n2. Bob Stone\n3. Ann Chu';
const BARE_AND_REFERENT = 'You met Pat Lee and Bob Stone.';

const THREE_ITEMS = ['Pat Lee', 'Bob Stone', 'Ann Chu'] as const;
const TWO_ITEMS = ['Pat Lee', 'Bob Stone'] as const;

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
    referentText: INLINE_REFERENT,
    signal: signal('ordinal', 'the second'),
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
  referentText = INLINE_REFERENT,
) => {
  const { ctx, resolve } = makeTurnContext([
    makeSessionEntry('user', 'Which contacts did we find?', 1),
    makeSessionEntry('assistant', referentText, 2),
    makeSessionEntry('user', followUp, 3),
  ]);
  attach(ctx);
  return { outcome: await runGate(ctx, makeRealFamilyDeps()), resolve };
};

describe('D-164 P11c parseInlineNameList closed accepts', () => {
  it.each([
    [
      'colon-anchored lead',
      INLINE_REFERENT,
      THREE_ITEMS,
    ],
    [
      'non-Oxford final conjunction',
      'You met Pat Lee, Bob Stone and Ann Chu',
      THREE_ITEMS,
    ],
    [
      'bare-and two-item list',
      BARE_AND_REFERENT,
      TWO_ITEMS,
    ],
    [
      'no lead',
      'Pat Lee, Bob Stone, and Ann Chu',
      THREE_ITEMS,
    ],
    [
      'starter We',
      'We found Pat Lee and Bob Stone.',
      TWO_ITEMS,
    ],
    [
      'starter They',
      'They were Pat Lee and Bob Stone.',
      TWO_ITEMS,
    ],
    [
      'starter Today I',
      'Today I met Pat Lee and Bob Stone.',
      TWO_ITEMS,
    ],
    [
      'starter You',
      'You met Pat Lee and Bob Stone.',
      TWO_ITEMS,
    ],
    [
      'colon-then-newline',
      'Here they are:\nPat Lee, Bob Stone, and Ann Chu.',
      THREE_ITEMS,
    ],
    [
      'wrapped comma separator',
      'Pat Lee,\nBob Stone, and Ann Chu.',
      THREE_ITEMS,
    ],
    [
      'multi-sentence pre-colon frame',
      'You met four people. Here they are: Pat Lee, Bob Stone, and Ann Chu.',
      THREE_ITEMS,
    ],
    [
      'intra-word hyphen in safe verb lead',
      'You re-met Pat Lee and Bob Stone.',
      TWO_ITEMS,
    ],
  ])('parses %s', (_label, text, expected) => {
    expect(parseInlineNameList(text)).toEqual(expected);
  });
});

describe('D-164 P11c parseInlineNameList closed defers', () => {
  it.each([
    ['R1 invisible semicolon lead item', 'You met with 3 people last week: J. Smith; Bob Stone, and Ann Chu.'],
    ['R1 invisible ampersand lead item', 'You met with 3 people last week: J. Smith & Bob Stone, and Ann Chu.'],
    ['R1 invisible slash lead item', 'You met with 3 people last week: J. Smith / Bob Stone, and Ann Chu.'],
    ['R1 invisible dash lead item', 'You met with 3 people last week: J. Smith — Bob Stone, and Ann Chu.'],
    ['R1 invisible or lead item', 'You met with 3 people last week: J. Smith or Bob Stone, and Ann Chu.'],
    ['R1 trailing invisible item', 'You met Pat Lee, Bob Stone, and Ann Chu. Alice too.'],
    ['prior-sentence lead', 'You met J. Smith. You also met Pat Lee, Bob Stone, and Ann Chu.'],
    ['R2 slash delimiter', 'Alice / Pat Lee, Bob Stone, and Ann Chu.'],
    ['R2 middle-dot delimiter', 'Alice · Pat Lee, Bob Stone, and Ann Chu.'],
    ['R2 plus delimiter', 'Alice + Pat Lee, Bob Stone, and Ann Chu.'],
    ['R2 vs delimiter', 'Alice vs Pat Lee, Bob Stone, and Ann Chu.'],
    ['R2 paren delimiter', '(Alice) Pat Lee, Bob Stone, and Ann Chu.'],
    ['R2 quote delimiter', '"Alice" Pat Lee, Bob Stone, and Ann Chu.'],
    ['R2 newline-glued name span', 'Alice\nPat Lee, Bob Stone, and Ann Chu'],
    ['lexicon refuses leading Alice and', 'Alice and Pat Lee, Bob Stone, and Ann Chu.'],
    ['lexicon refuses leading Alice met', 'Alice met Pat Lee, Bob Stone, and Ann Chu.'],
    ['lexicon refuses leading Ivy met', 'Ivy met Pat Lee, Bob Stone, and Ann Chu.'],
    ['lexicon refuses all-caps starter', 'FYI you met Pat Lee and Bob Stone'],
    ['lowercase joiner splice', 'you met pat lee and Bob Stone, and Ann Chu'],
    ['documented with loss', 'You met with Pat Lee and Bob Stone.'],
    ['appositive item', 'You met Pat Lee, the CEO of Acme, and Bob Stone.'],
    ['invisible-first lowercase item', 'you met pat lee, Bob Stone, and Ann Chu.'],
    ['leading appositive', 'your manager, Bob Stone, and Ann Chu.'],
    ['stray gated name after list', 'You met Pat Lee, Bob Stone, and Ann Chu. Also Dan Roe emailed.'],
    ['and-chain interior', 'You met Pat Lee and Bob Stone and Ann Chu.'],
    ['trailing modifier', 'You met Pat Lee, Bob Stone, and Ann Chu last week.'],
    ['possessive tail', "You met Pat Lee, Bob Stone, and Ann Chu's manager."],
    ['no conjunction', 'You met Pat Lee, Bob Stone.'],
    ['trailing closer', 'You met Pat Lee, Bob Stone, and Ann Chu. Want details?'],
    ['lead comma', 'Last week in London, you met Pat Lee and Bob Stone.'],
    ['single name', 'You met Pat Lee.'],
    ['line-marker jurisdiction', '1. Pat Lee\n2. Bob Stone'],
    ['line-parser refusal stays refused', 'Sales:\n- Pat Lee\nEngineering:\n- Bob Stone'],
    ['markerless line-split names', 'Here:\nPat Lee and Bob Stone\nAnn Chu'],
  ])('defers %s', (_label, text) => {
    expect(parseInlineNameList(text)).toBeNull();
  });
});

describe('D-164 P11c containsListMarkerLine jurisdiction', () => {
  it.each([
    ['numbered lines', '1. Pat Lee\n2. Bob Stone'],
    ['numbered paren line', '1) Pat Lee'],
    ['bulleted lines', '- Pat Lee\n- Bob Stone'],
    ['unicode bullet line', '• Pat Lee'],
    ['bare marker line', 'Intro\n-\nPat Lee'],
    ['indented marker line', '  - Pat Lee'],
    ['crlf numbered lines', '1. Pat Lee\r\n2. Bob Stone'],
  ])('recognizes %s', (_label, text) => {
    expect(containsListMarkerLine(text)).toBe(true);
  });

  it.each([
    ['prose', 'Pat Lee and Bob Stone replied.'],
    ['inline comma enumeration', 'Pat Lee, Bob Stone, and Ann Chu.'],
    ['inline prose enumeration', 'We found 1. Pat Lee and 2. Bob Stone inline.'],
    ['blank text', ''],
    ['whitespace-only lines', '\n  \t\n'],
  ])('ignores %s', (_label, text) => {
    expect(containsListMarkerLine(text)).toBe(false);
  });
});

describe('D-164 P11c rewriteAnaphoricPrompt inline-list binder', () => {
  it.each([
    [
      'word ordinal over inline list',
      "what is the second one's email?",
      INLINE_REFERENT,
      signal('ordinal', 'the second'),
      "what is Bob Stone's email?",
    ],
    [
      'numeral ordinal over inline list',
      "what is the 2nd one's email?",
      INLINE_REFERENT,
      signal('ordinal', 'the 2nd one'),
      "what is Bob Stone's email?",
    ],
    [
      'former/latter over bare-and two-item list',
      "what is the latter's email?",
      BARE_AND_REFERENT,
      signal('ordinal', 'the latter'),
      "what is Bob Stone's email?",
    ],
    [
      'line-list precedence still binds first',
      "what is the second one's email?",
      LINE_REFERENT,
      signal('ordinal', 'the second'),
      "what is Bob Stone's email?",
    ],
  ])('rewrites %s', (_label, prompt, referentText, s, expected) => {
    expect(rewrite(prompt, { referentText, signal: s })).toBe(expected);
  });

  it.each([
    ['out-of-range inline ordinal', "what is the fourth one's email?", signal('ordinal', 'the fourth')],
    ['multi-item demonstrative', "what is this one's email?", signal('demonstrative', 'this one')],
  ])('defers %s', (_label, prompt, s) => {
    expect(rewrite(prompt, { signal: s })).toBeNull();
  });
});

describe('D-164 P11c runGate e2e through the real four-family composition', () => {
  it.each([
    [
      'word ordinal email',
      "what is the second one's email?",
      INLINE_REFERENT,
      "Bob Stone's email address is bob@y.com.",
    ],
    [
      'numeral ordinal email',
      "what is the 2nd one's email?",
      INLINE_REFERENT,
      "Bob Stone's email address is bob@y.com.",
    ],
    [
      'former/latter over bare-and list',
      "what is the latter's email?",
      BARE_AND_REFERENT,
      "Bob Stone's email address is bob@y.com.",
    ],
    [
      'line-list precedence',
      "what is the second one's email?",
      LINE_REFERENT,
      "Bob Stone's email address is bob@y.com.",
    ],
  ])('short-circuits %s', async (_label, followUp, referentText, text) => {
    const { outcome, resolve } = await runListGate(followUp, referentText);

    expect(outcome).toEqual({ kind: 'short-circuit', text });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(text);
  });

  it('short-circuits a last-item mail count lookup through an inline referent', async () => {
    const { outcome, resolve } = await runListGate(
      'how many emails from the last one?',
    );

    expect(outcome.kind).toBe('short-circuit');
    expect(outcome.kind === 'short-circuit' ? outcome.text : '').toContain(
      '2 emails from Ann Chu',
    );
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['out-of-range ordinal', "what is the fourth one's email?"],
    ['multi-item demonstrative', "what is this one's email?"],
  ])('passes through %s as unresolved anaphora', async (_label, followUp) => {
    const { outcome, resolve } = await runListGate(followUp);

    expect(outcome).toEqual({
      kind: 'pass-through',
      reason: 'anaphora-unresolved',
    });
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('D-164 P11c direct-path preservation e2e', () => {
  it('leaves direct contact lookup byte-identical despite inline-list history', async () => {
    const { ctx, resolve, stateDelete } = makeTurnContext([
      makeSessionEntry('user', 'Which contacts did we find?', 1),
      makeSessionEntry('assistant', INLINE_REFERENT, 2),
      makeSessionEntry('user', "what is Pat Lee's email?", 3),
    ]);
    attach(ctx);

    expect(stateDelete).toHaveBeenCalledWith(INTENTION_RESULT_STATE_KEY);
    await expect(runGate(ctx, makeRealFamilyDeps())).resolves.toEqual({
      kind: 'short-circuit',
      text: "Pat Lee's email address is pat@x.com.",
    });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith("Pat Lee's email address is pat@x.com.");
  });
});
