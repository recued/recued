/** D-164 P11 — list-anaphora deterministic gate.
 *
 *  Pins the closed list-item binder separately from P9's unique-name
 *  pronoun binder. List ordinals and demonstratives are allowed to
 *  short-circuit only when the prior assistant turn is one parseable
 *  ordinal space and the selected item has exactly one certainty-gated
 *  contact name. Everything else defers to the LLM path rather than
 *  risking a wrong-person answer.
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
  parseReferentList,
  rewriteAnaphoricPrompt,
  runGate,
  type AnaphoraRewriteInput,
  type ContactAttributeRow,
  type GateDeps,
  type ShortCircuitFamily,
} from '../index';
import { attach, INTENTION_RESULT_STATE_KEY } from '../intention/index';
import type { AnaphoraSignal } from '../intention/index';
import type { SlotValue } from '../ner/index';
import type { SlotName, Template } from '../types';

const LIST_REFERENT = '1. Pat Lee\n2. Bob Stone\n3. Ann Chu';
const TWO_ITEM_REFERENT = '1. Pat Lee\n2. Bob Stone';
const ONE_ITEM_REFERENT = '1. Pat Lee';
const PRONOUN_REFERENT = "Pat Lee's email address is pat@x.com.";

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
    signal: signal('ordinal', 'the second'),
    ...over,
  });

const makeSlot = (kind: SlotName, value: string, position = 0): SlotValue => ({
  kind,
  value,
  raw: value,
  position,
});

const nameSlot = (value = 'Pat Lee', position = 8): SlotValue =>
  makeSlot('entity.name', value, position);

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

describe('D-164 P11 parseReferentList closed shapes', () => {
  it.each([
    ['numbered dot', '1. Pat Lee\n2. Bob Stone', ['Pat Lee', 'Bob Stone']],
    ['numbered paren', '1) Pat Lee\n2) Bob Stone', ['Pat Lee', 'Bob Stone']],
    ['dash bullets', '- Pat Lee\n- Bob Stone', ['Pat Lee', 'Bob Stone']],
    ['star bullets', '* Pat Lee\n* Bob Stone', ['Pat Lee', 'Bob Stone']],
    ['unicode bullets', '• Pat Lee\n• Bob Stone', ['Pat Lee', 'Bob Stone']],
    [
      'blank lines inside one loose list',
      'Found these:\n1. Pat Lee\n\n2. Bob Stone\nDone.',
      ['Pat Lee', 'Bob Stone'],
    ],
    ['crlf transport', '1. Pat Lee\r\n2. Bob Stone', ['Pat Lee', 'Bob Stone']],
    [
      'markdown item text',
      '1. **Pat Lee** — pat@x.com\n2. Bob Stone',
      ['**Pat Lee** — pat@x.com', 'Bob Stone'],
    ],
  ])('parses %s', (_label, text, expected) => {
    expect(parseReferentList(text)).toEqual(expected);
  });

  it.each([
    ['zero list lines', 'Pat Lee, Bob Stone, and Ann Chu.'],
    ['mixed numbered and bulleted lines', '1. Pat Lee\n- Bob Stone'],
    ['differing bullet indents', '- Pat Lee\n  - Bob Stone'],
    ['broken numbered sequence', '1. Pat Lee\n3. Bob Stone'],
    ['restarted numbered sequence', '1. Pat Lee\n2. Bob Stone\n1. Ann Chu'],
    ['markdown all-1 sequence', '1. Pat Lee\n1. Bob Stone\n1. Ann Chu'],
    ['prose inside the list span', '1. Pat Lee\nEngineering:\n2. Bob Stone'],
    ['horizontal rule inside the list span', '1. Pat Lee\n---\n2. Bob Stone'],
    ['bare bullet marker anywhere', 'Intro\n-\n1. Pat Lee'],
    ['bare numbered marker anywhere', '1. Pat Lee\n2.\n3. Ann Chu'],
  ])('defers %s', (_label, text) => {
    expect(parseReferentList(text)).toBeNull();
  });
});

describe('D-164 P11 rewriteAnaphoricPrompt list-item binder', () => {
  it.each([
    [
      'what is the second one\'s email?',
      signal('ordinal', 'the second'),
      LIST_REFERENT,
      "what is Bob Stone's email?",
    ],
    [
      'what is the first one\'s phone?',
      signal('ordinal', 'the first'),
      LIST_REFERENT,
      "what is Pat Lee's phone?",
    ],
    [
      'what is the last one\'s email?',
      signal('ordinal', 'the last'),
      LIST_REFERENT,
      "what is Ann Chu's email?",
    ],
    [
      'when is my next meeting with the third one?',
      signal('ordinal', 'the third'),
      LIST_REFERENT,
      'when is my next meeting with Ann Chu?',
    ],
    [
      'does the second one have an email?',
      signal('ordinal', 'the second'),
      LIST_REFERENT,
      'does Bob Stone have an email?',
    ],
    [
      'what is the latter\'s email?',
      signal('ordinal', 'the latter'),
      TWO_ITEM_REFERENT,
      "what is Bob Stone's email?",
    ],
    [
      'what is this one\'s email?',
      signal('demonstrative', 'this one'),
      ONE_ITEM_REFERENT,
      "what is Pat Lee's email?",
    ],
    [
      'what is that one\'s phone?',
      signal('demonstrative', 'that one'),
      ONE_ITEM_REFERENT,
      "what is Pat Lee's phone?",
    ],
  ])('rewrites %j', (prompt, s, referentText, expected) => {
    expect(rewrite(prompt, { referentText, signal: s })).toBe(expected);
  });

  it.each([
    ['out-of-range ordinal', 'what is the fourth one\'s email?', LIST_REFERENT, signal('ordinal', 'the fourth')],
    ['latter over three items', 'what is the latter\'s email?', LIST_REFERENT, signal('ordinal', 'the latter')],
    ['that one over multiple items', 'what is that one\'s email?', TWO_ITEM_REFERENT, signal('demonstrative', 'that one')],
    ['plural these signal', 'what about these?', LIST_REFERENT, signal('demonstrative', 'these')],
    ['plural those signal', 'what about those?', LIST_REFERENT, signal('demonstrative', 'those')],
    ['previous is intentionally unbound', 'what is the previous one\'s email?', LIST_REFERENT, signal('ordinal', 'the previous')],
    ['prompt-side name', 'what is the second one\'s email, Bob Stone?', LIST_REFERENT, signal('ordinal', 'the second')],
    ['pronoun riding along', 'what is the second one\'s email and his phone?', LIST_REFERENT, signal('ordinal', 'the second')],
    ['two list phrases', 'the first one or the last one?', LIST_REFERENT, signal('ordinal', 'the first')],
    ['adjectival former/latter', 'what is the former email?', TWO_ITEM_REFERENT, signal('ordinal', 'the former')],
    ['referent with no list', 'what is the second one\'s email?', PRONOUN_REFERENT, signal('ordinal', 'the second')],
    [
      'multi-name selected item',
      'what is the first one\'s email?',
      '1. Pat Lee and Ann Chu\n2. bob@x.com',
      signal('ordinal', 'the first'),
    ],
    [
      'name-less selected item',
      'what is the second one\'s email?',
      '1. Pat Lee and Ann Chu\n2. bob@x.com',
      signal('ordinal', 'the second'),
    ],
    ['residual homograph selected item', 'what is the first one\'s email?', '1. He Wei\n2. Bob Stone', signal('ordinal', 'the first')],
  ])('defers %s', (_label, prompt, referentText, s) => {
    expect(rewrite(prompt, { referentText, signal: s })).toBeNull();
  });

  it('still fires when a later list item does not leave residual anaphora', () => {
    expect(rewrite('what is the second one\'s email?', {
      referentText: '1. He Wei\n2. Bob Stone',
      signal: signal('ordinal', 'the second'),
    })).toBe("what is Bob Stone's email?");
  });

  it('routes pronoun-kind signals to the P9 binder unchanged', () => {
    expect(rewrite('what about her phone?', {
      referentText: PRONOUN_REFERENT,
      signal: signal('pronoun', 'her'),
    })).toBe("what about Pat Lee's phone?");
  });
});

describe('D-164 P11 runGate e2e through the real four-family composition', () => {
  it('short-circuits a second-item email lookup through the rewritten direct path', async () => {
    const { outcome, resolve } = await runListGate(
      'what is the second one\'s email?',
    );

    expect(outcome).toEqual({
      kind: 'short-circuit',
      text: "Bob Stone's email address is bob@y.com.",
    });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith("Bob Stone's email address is bob@y.com.");
  });

  it('short-circuits a calendar next-meeting lookup for an object-position list reference', async () => {
    const { outcome, resolve } = await runListGate(
      'when is my next meeting with the third one?',
    );

    expect(outcome.kind).toBe('short-circuit');
    expect(outcome.kind === 'short-circuit' ? outcome.text : '').toContain('QBR');
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('short-circuits a mail from-count lookup for an object-position list reference', async () => {
    const { outcome, resolve } = await runListGate(
      'how many emails from the second one?',
    );

    expect(outcome.kind).toBe('short-circuit');
    expect(outcome.kind === 'short-circuit' ? outcome.text : '').toContain(
      '2 emails from Bob Stone',
    );
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('short-circuits a has-email possessive list reference', async () => {
    const { outcome, resolve } = await runListGate(
      "do I have the second one's email?",
    );

    expect(outcome.kind).toBe('short-circuit');
    expect(outcome.kind === 'short-circuit' ? outcome.text : '').toContain(
      'Bob Stone',
    );
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('passes through when the selected item resolves but the requested attribute is absent', async () => {
    const { outcome, resolve } = await runListGate(
      'what is the third one\'s phone?',
    );

    expect(outcome).toEqual({ kind: 'pass-through', reason: 'empty-render' });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('passes through an out-of-range list reference before template matching', async () => {
    const { outcome, resolve } = await runListGate(
      'what is the fourth one\'s email?',
    );

    expect(outcome).toEqual({
      kind: 'pass-through',
      reason: 'anaphora-unresolved',
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('rewrites mutation-shaped list anaphora but lets downstream templates defer', async () => {
    const { outcome, resolve } = await runListGate('delete the second one');

    expect(outcome).toEqual({ kind: 'pass-through', reason: 'no-template' });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('does not merge separate visual list blocks into one ordinal space', async () => {
    const { outcome, resolve } = await runListGate(
      'what is the second one\'s email?',
      'Sales:\n- Pat Lee\nEngineering:\n- Bob Stone',
    );

    expect(outcome).toEqual({
      kind: 'pass-through',
      reason: 'anaphora-unresolved',
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('leaves a direct prompt byte-identical despite list-carrying history', async () => {
    const { ctx, resolve, stateDelete } = makeTurnContext([
      makeSessionEntry('user', 'Which contacts did we find?', 1),
      makeSessionEntry('assistant', LIST_REFERENT, 2),
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

describe('D-164 P11 direct-path contact-attribute R2 fold pins', () => {
  const matchContact = (text: string): Template | null =>
    matchContactAttributeTemplate({
      text,
      slots: [nameSlot()],
      locale: 'en',
    }) as Template | null;

  it.each([
    "what is Pat Lee's boss email?",
    "what is Pat Lee's manager phone?",
    "what is Pat Lee's old email?",
  ])('does not fire on qualified attribute lookup %j', (text) => {
    expect(matchContact(text)).toBeNull();
  });

  it.each([
    ["what is Pat Lee's email?", CONTACT_ATTRIBUTE_TEMPLATES.email.template_hash],
    ["Pat Lee's email address?", CONTACT_ATTRIBUTE_TEMPLATES.email.template_hash],
    ["what's Pat Lee's phone number", CONTACT_ATTRIBUTE_TEMPLATES.phone.template_hash],
  ])('keeps the direct positive template for %j', (text, templateHash) => {
    expect(matchContact(text)?.template_hash).toBe(templateHash);
  });
});
