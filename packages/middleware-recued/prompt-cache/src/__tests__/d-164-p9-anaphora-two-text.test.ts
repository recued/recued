/** D-164 P9 — two-text anaphora deterministic gate.
 *
 *  Pins the invariant that a pronoun follow-up short-circuits ONLY when every
 *  closed rewrite rule holds. The rewrite substitutes the prior assistant
 *  referent's unique name into the current prompt, then the rewritten text
 *  re-enters the normal family pipeline; every unmodeled shape defers rather
 *  than risking a wrong answer. This suite also folds the two Codex HIGH
 *  regressions: prompt-side pronoun-homograph names must not be corrupted, and
 *  chained possessives after rewrite (`her boss's email` / `her boss' email`)
 *  must pass through exactly like the direct path.
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
  INTENTION_RESULT_STATE_KEY,
} from '../intention/index';
import type { AnaphoraSignal } from '../intention/index';
import type { SlotValue } from '../ner/index';
import type { SlotName, Template } from '../types';

const REFERENT = "Pat Lee's email address is pat@x.com.";

const pronounSignal = (
  trigger: string = 'her',
  position = 0,
): AnaphoraSignal => ({
  kind: 'pronoun',
  trigger,
  position,
});

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
    referentText: REFERENT,
    signal: pronounSignal(),
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

const PAT: ContactAttributeRow = {
  name: 'Pat Lee',
  email: 'pat@x.com',
  emails: ['pat@x.com'],
  phone: '+1 555 0100',
};

const makeRealFamilyDeps = (): GateDeps => {
  const contactLookup = () => [PAT];
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

const runAnaphoricGate = async (followUp: string) => {
  const { ctx, resolve } = makeTurnContext([
    makeSessionEntry('user', "What is Pat Lee's email?", 1),
    makeSessionEntry('assistant', REFERENT, 2),
    makeSessionEntry('user', followUp, 3),
  ]);
  attach(ctx);
  return { outcome: await runGate(ctx, makeRealFamilyDeps()), resolve };
};

describe('D-164 P9 rewriteAnaphoricPrompt unit table', () => {
  it.each([
    ['what about her phone?', "what about Pat Lee's phone?"],
    ['and his email?', "and Pat Lee's email?"],
    ['do I have her email?', "do I have Pat Lee's email?"],
    ['when is my next meeting with her?', 'when is my next meeting with Pat Lee?'],
    ['how many emails from him?', 'how many emails from Pat Lee?'],
    ['where does she work?', 'where does Pat Lee work?'],
    ['what about their email?', "what about Pat Lee's email?"],
  ])('rewrites %j to %j', (prompt, expected) => {
    expect(rewrite(prompt)).toBe(expected);
  });

  it.each([
    ['demonstrative', signal('demonstrative', 'this one')],
    ['ordinal', signal('ordinal', 'the second')],
  ])('defers a %s signal', (_label, s) => {
    expect(rewrite('what about her phone?', { signal: s })).toBeNull();
  });

  it('defers prompts with two pronouns', () => {
    expect(rewrite('does she have his number?')).toBeNull();
  });

  it.each([
    ['what about its domain?', pronounSignal('its', 11)],
    ['is it valid?', pronounSignal('it', 3)],
  ])('defers it / its tokens in %j', (prompt, s) => {
    expect(rewrite(prompt, { signal: s })).toBeNull();
  });

  it('defers a referent with no name', () => {
    expect(rewrite('what about her phone?', {
      referentText: 'email referent@example.com',
    })).toBeNull();
  });

  it('defers a referent with two names', () => {
    expect(rewrite('what about her phone?', {
      referentText: 'Found Pat Lee and Bob Stone.',
    })).toBeNull();
  });

  it.each([
    "what about her phone, and Bob Stone's?",
    "what is His Excellence's email?",
    "what is He Wei's email?",
  ])('defers prompt-side names and pronoun homographs: %j', (prompt) => {
    expect(rewrite(prompt)).toBeNull();
  });

  it.each([
    ['call her', pronounSignal('her', 5), 1],
    ['the package is his?', pronounSignal('his', 15), 1],
  ])('defers unmodeled position %j with one pronoun-ish token', (prompt, s, tokenCount) => {
    expect([...prompt.matchAll(/\b(he|she|it|its|they|them|him|her|his|their)\b/gi)])
      .toHaveLength(tokenCount);
    expect(rewrite(prompt, { signal: s })).toBeNull();
  });

  it('defers when the substituted referent name leaves a residual pronoun homograph', () => {
    expect(rewrite('what about her phone?', {
      referentText: 'He Wei sent a note.',
    })).toBeNull();
  });

  it('preserves surrounding text verbatim and the substituted name casing', () => {
    expect(rewrite('also, her phone, please!', {
      referentText: "Patricia Lane's email address is patricia@example.com.",
    })).toBe("also, Patricia Lane's phone, please!");
  });
});

describe('D-164 P9 runGate two-text e2e through the real four-family composition', () => {
  it('short-circuits a contact phone follow-up through the rewritten direct path', async () => {
    const { outcome, resolve } = await runAnaphoricGate('what about her phone?');

    expect(outcome).toEqual({
      kind: 'short-circuit',
      text: "Pat Lee's phone number is +1 555 0100.",
    });
    expect(resolve).toHaveBeenCalledWith("Pat Lee's phone number is +1 555 0100.");
  });

  it('short-circuits a calendar next-meeting follow-up through the rewritten direct path', async () => {
    const { outcome } = await runAnaphoricGate('when is my next meeting with her?');

    expect(outcome.kind).toBe('short-circuit');
    expect(outcome.kind === 'short-circuit' ? outcome.text : '').toContain('QBR');
  });

  it('short-circuits a mail from-count follow-up through the rewritten direct path', async () => {
    const { outcome } = await runAnaphoricGate('how many emails from her?');

    expect(outcome.kind).toBe('short-circuit');
    expect(outcome.kind === 'short-circuit' ? outcome.text : '').toContain(
      '2 emails from Pat Lee',
    );
  });

  it('short-circuits a has-email presence follow-up through the rewritten direct path', async () => {
    const { outcome } = await runAnaphoricGate('do I have her email?');

    expect(outcome).toEqual({
      kind: 'short-circuit',
      text: "Yes, Pat Lee's email address is pat@x.com.",
    });
  });

  it.each([
    "what is her boss's email?",
    "what is her boss' email?",
  ])('passes through chained possessive after rewrite with no-template: %j', async (followUp) => {
    const { outcome, resolve } = await runAnaphoricGate(followUp);

    expect(outcome).toEqual({
      kind: 'pass-through',
      reason: 'no-template',
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('passes through an anaphor with no assistant referent', async () => {
    const { ctx, resolve } = makeTurnContext([
      makeSessionEntry('user', "What is Pat Lee's email?", 1),
      makeSessionEntry('user', 'what about them?', 2),
    ]);
    attach(ctx);

    expect(ctx.state.get(INTENTION_RESULT_STATE_KEY)).toMatchObject({
      signal: { kind: 'pronoun', trigger: 'them' },
      referent: null,
    });
    await expect(runGate(ctx, makeRealFamilyDeps())).resolves.toEqual({
      kind: 'pass-through',
      reason: 'anaphora-without-referent',
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('leaves a non-anaphoric direct turn on the direct short-circuit path', async () => {
    const { ctx, resolve, stateDelete } = makeTurnContext([
      makeSessionEntry('user', "what is Pat Lee's email?", 1),
    ]);
    attach(ctx);

    expect(stateDelete).toHaveBeenCalledWith(INTENTION_RESULT_STATE_KEY);
    await expect(runGate(ctx, makeRealFamilyDeps())).resolves.toEqual({
      kind: 'short-circuit',
      text: "Pat Lee's email address is pat@x.com.",
    });
    expect(resolve).toHaveBeenCalledWith("Pat Lee's email address is pat@x.com.");
  });
});

describe('D-164 P9 direct-path chained-possessive pins', () => {
  const matchContact = (text: string): Template | null =>
    matchContactAttributeTemplate({
      text,
      slots: [nameSlot()],
      locale: 'en',
    }) as Template | null;

  it.each([
    "what is Pat Lee's boss's email?",
    "what is Pat Lee's boss' email?",
    "what is Pat Lee's boss’ email?",
  ])('does not fire on chained possessive %j', (text) => {
    expect(matchContact(text)).toBeNull();
  });

  it('keeps the direct email positive untouched', () => {
    expect(matchContact("what is Pat Lee's email address?")?.template_hash).toBe(
      CONTACT_ATTRIBUTE_TEMPLATES.email.template_hash,
    );
  });

  it('keeps the direct phone positive untouched', () => {
    expect(matchContact("what is Pat Lee's phone?")?.template_hash).toBe(
      CONTACT_ATTRIBUTE_TEMPLATES.phone.template_hash,
    );
  });
});

describe('D-164 P9 detector widening pins', () => {
  it('detects his as a pronoun trigger', () => {
    expect(detectAnaphora('and his phone?')).toMatchObject({
      kind: 'pronoun',
      trigger: 'his',
    });
  });

  it('detects their as a pronoun trigger', () => {
    expect(detectAnaphora('what about their email?')).toMatchObject({
      kind: 'pronoun',
      trigger: 'their',
    });
  });

  it('does not trigger on its at all — and never matches it inside its', () => {
    // `its` is deliberately absent from the pronoun list (thing-reference),
    // and `\bit\b` cannot match inside `its` — so this prompt carries NO
    // anaphora signal whatsoever and stays on the direct-prompt path.
    expect(detectAnaphora('what about its domain?')).toBeNull();
  });
});
