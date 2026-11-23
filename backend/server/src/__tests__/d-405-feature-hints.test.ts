/** D-405 slice 2 — which of the owner's core features a message asks about, and the step it gives when
 *  none is connected. The probe's facts are fakes here; the real wire's are pinned in
 *  `d-404-thing-steps-composition.test.ts` (the Connections page's rows, the owner's switches). */
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { featureStepWords, type ChatSetupFeature } from '@recued/contracts';

import { featureStepSentence, featuresNamedBy, promptSetupStep, setupStepKeysOf, type PromptSetupDeps } from '../next-steps/prompt-steps.js';
import { assetTypes } from '../situations/asset-types.js';

/** The built-in types of thing, as a server starts with them. */
const BUILT_IN_TYPES = assetTypes(new Database(':memory:')).list();

describe('featuresNamedBy', () => {
  it('names mail, a calendar and files by their words, in the order the message names them', () => {
    expect(featuresNamedBy('Did Anna reply to my email?')).toEqual(['mail']);
    expect(featuresNamedBy('What is in my inbox')).toEqual(['mail']);
    expect(featuresNamedBy('Has my e-mail from the bank arrived')).toEqual(['mail']);
    expect(featuresNamedBy('Do I have any meetings tomorrow?')).toEqual(['calendar']);
    expect(featuresNamedBy('What is on my agenda today')).toEqual(['calendar']);
    expect(featuresNamedBy('Where are my files about the lease?')).toEqual(['file']);
    expect(featuresNamedBy('Add the meeting from my email to my calendar')).toEqual(['calendar', 'mail']);
    expect(featuresNamedBy('Put the PDF Anna emailed me in my folder')).toEqual(['file', 'mail']);
  });

  it('a word that is also a verb, or names something being made, counts only as one of the owner\'s', () => {
    expect(featuresNamedBy('Is there any new mail for me?')).toEqual(['mail']);
    expect(featuresNamedBy('When is my next meeting?')).toEqual(['calendar']);
    expect(featuresNamedBy('Find the lease PDF for me')).toEqual(['file']);
    expect(featuresNamedBy('Which document did I sign?')).toEqual(['file']);
    // ⛔ None of these is about a feature of the owner's.
    expect(featuresNamedBy('Can you file my taxes?')).toEqual([]);
    expect(featuresNamedBy('Remind me to mail the rent cheque')).toEqual([]);
    expect(featuresNamedBy('I\'m meeting Anna tomorrow, remind me')).toEqual([]);
    expect(featuresNamedBy('Make me a PDF of my notes')).toEqual([]);
    expect(featuresNamedBy('Summarize this document for me')).toEqual([]);
    expect(featuresNamedBy('Help me document my process')).toEqual([]);
  });

  it('⛔ never a recipe\'s schedule or an event', () => {
    expect(featuresNamedBy('Change my backup schedule to daily')).toEqual([]);
    expect(featuresNamedBy('Show my recent events')).toEqual([]);
  });
});

describe('the line the model reads', () => {
  it('says what is missing, what it means for the request, and the link as the owner sees it', () => {
    expect(featureStepSentence('mail')).toBe('No mailbox is connected yet, so there is no mail of the owner\'s to search, and none can be '
      + 'sent for them. They connect one in Connections, under Mail; in the app, the link "Connect your mail" under your answer opens '
      + 'it. Never say one is connected until it is.');
    // ⛔ Every server has its own calendar: the line says the owner's is missing, never that no event can be added,
    // and that Recued's own is still read.
    expect(featureStepSentence('calendar')).toBe('No calendar of the owner\'s is connected yet: the only calendar to read is Recued\'s '
      + 'own on this server, which holds only the events added in Recued. Read it as usual, and say their other calendars cannot be '
      + 'read until one is connected. They connect one in Connections, under Calendar; in the app, the link "Connect your calendar" '
      + 'under your answer opens it. Never say one is connected until it is.');
    expect(featureStepSentence('file')).toContain('They connect a folder in Connections, under Files');
    // One source of words: the row's link is quoted as the owner sees it. The owner is "the owner": the
    // row's "of yours" read by the model would be the model's own calendar.
    for (const feature of ['mail', 'calendar', 'file'] as const) {
      expect(featureStepSentence(feature)).toContain(`"${featureStepWords(feature).link}"`);
      expect(featureStepSentence(feature)).not.toContain('of yours');
    }
  });
});

/** Fakes for the probe: what is connected (null: the owner's switches do not let chat say), whether the
 *  conversation holds a file, and the search of the owner's things, which finds nothing to set up. */
const deps = (connected: Partial<Record<ChatSetupFeature, boolean | null>>, opts: { files?: boolean } = {}) => {
  const featureConnected = vi.fn((feature: ChatSetupFeature) => connected[feature] ?? true);
  const search = vi.fn(async () => ({ ok: true as const, result: { entities: [], total: 0 } }));
  const conversationHasFiles = vi.fn(() => opts.files === true);
  const built: PromptSetupDeps = { types: () => BUILT_IN_TYPES, search, featureConnected, conversationHasFiles };
  return { built, featureConnected, search, conversationHasFiles };
};

describe('promptSetupStep — a feature with none connected', () => {
  it('the step, its line and its key', async () => {
    const { built } = deps({ mail: false });
    expect(await promptSetupStep('Did Anna reply to my email?', built)).toEqual({
      fixes: [{ kind: 'feature', feature: 'mail' }], offers: [], line: featureStepSentence('mail'), key: 'feature:mail',
    });
  });

  it('⛔ none for a message not about the owner\'s own: nothing is asked', async () => {
    const { built, featureConnected } = deps({ mail: false });
    expect(await promptSetupStep('What makes an email look like spam?', built)).toBeNull();
    expect(featureConnected).not.toHaveBeenCalled();
  });

  it('a feature that is connected, or that the owner\'s switches keep quiet, gives way to the next one named', async () => {
    expect((await promptSetupStep('Add the meeting from my email to my calendar', deps({ calendar: true, mail: false }).built))?.key)
      .toBe('feature:mail');
    expect((await promptSetupStep('Add the meeting from my email to my calendar', deps({ calendar: null, mail: false }).built))?.key)
      .toBe('feature:mail');
    expect(await promptSetupStep('Add the meeting from my email to my calendar', deps({ calendar: true, mail: null }).built)).toBeNull();
  });

  it('a feature asked about comes before a thing; with it connected, the search for the thing runs as before', async () => {
    const none = deps({ mail: false });
    expect((await promptSetupStep('Did my passport renewal email arrive?', none.built))?.key).toBe('feature:mail');
    expect(none.search).not.toHaveBeenCalled();
    const connected = deps({ mail: true });
    // These fakes' search finds no step, so none; the real wire's gives the Passport (the composition test).
    expect(await promptSetupStep('Did my passport renewal email arrive?', connected.built)).toBeNull();
    expect(connected.search).toHaveBeenCalledWith('Passport');
  });

  it('⛔ no file hint while the conversation holds a file the owner sent; mail named after it still is', async () => {
    const { built } = deps({ file: false, mail: false }, { files: true });
    expect(await promptSetupStep('Can you summarize the file for me?', built)).toBeNull();
    expect((await promptSetupStep('Can you summarize the file and email it to me?', built))?.key).toBe('feature:mail');
  });

  it('no feature hints without the probe', async () => {
    const { built } = deps({ mail: false });
    expect(await promptSetupStep('Did Anna reply to my email?', { types: built.types, search: built.search })).toBeNull();
  });

  it('an earlier answer that carried it keys it the same way, so it is never given twice', () => {
    expect(setupStepKeysOf({ role: 'assistant', fixes: [{ kind: 'feature', feature: 'calendar' }] })).toEqual(['feature:calendar']);
    expect(setupStepKeysOf({ role: 'user', fixes: [{ kind: 'feature', feature: 'calendar' }] })).toEqual([]);
  });
});
