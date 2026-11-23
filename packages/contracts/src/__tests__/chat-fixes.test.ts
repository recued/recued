/** D-346 follow-up (2026-11-08) — the fixes an owner's chat answer offers, read back through one
 *  reader: what the server stamped and what a stored message holds. */
import { describe, expect, it } from 'vitest';

import { CHAT_FIX_LIMIT, CHAT_SETUP_FEATURES, chatFixesOf, chatSetupFeaturesOf, featureStepWords, sourceStepWords, THING_PAGE_SETUPS, thingPageSetupOf, thingStepWords } from '../chat-fixes.js';

describe('chatFixesOf', () => {
  it('keeps a run need and an owner switch', () => {
    expect(chatFixesOf([
      { kind: 'run_need', need: { kind: 'connection', step_id: 'deal', problem: 'reconnect', slot: 'hubspot' } },
      { kind: 'switch', entry_key: 'primitive.mail.search', label: 'Search your mail' },
    ])).toEqual([
      { kind: 'run_need', need: { kind: 'connection', step_id: 'deal', problem: 'reconnect', slot: 'hubspot' } },
      { kind: 'switch', entry_key: 'primitive.mail.search', label: 'Search your mail' },
    ]);
  });

  it('drops a switch that is not one of the owner\'s own, and anything malformed', () => {
    expect(chatFixesOf([
      { kind: 'switch', entry_key: 'recued-core/hubspot-catalog.deal.update', label: 'x' },
      { kind: 'switch', entry_key: 'data.task' },
      { kind: 'run_need', need: { kind: 'nope', step_id: 's' } },
      'text',
      null,
    ])).toEqual([]);
    expect(chatFixesOf('not a list')).toEqual([]);
  });

  it('says each fix once, and at most a few', () => {
    const off = { kind: 'switch', entry_key: 'data.task', label: 'Your tasks' };
    expect(chatFixesOf([off, off])).toHaveLength(1);
    const many = Array.from({ length: 9 }, (_, i) => ({ kind: 'switch', entry_key: `data.k${i}`, label: `k${i}` }));
    expect(chatFixesOf(many)).toHaveLength(CHAT_FIX_LIMIT);
  });
});

// D-404 slice A — a type of thing the owner has none of, which a search of their things needed.
describe('a thing to add (D-404)', () => {
  it('keeps a type id and its name, the name trimmed and cut, once per type', () => {
    expect(chatFixesOf([
      { kind: 'thing', type_id: 'travel_passport', type_name: '  Passport ' },
      { kind: 'thing', type_id: 'travel_passport', type_name: 'Passport' },
      { kind: 'thing', type_id: 'owner_0f3a', type_name: 'x'.repeat(200) },
    ])).toEqual([
      { kind: 'thing', type_id: 'travel_passport', type_name: 'Passport' },
      { kind: 'thing', type_id: 'owner_0f3a', type_name: 'x'.repeat(80) },
    ]);
  });

  it('drops a type id no type can have, and a step with no name', () => {
    expect(chatFixesOf([
      { kind: 'thing', type_id: 'Passport', type_name: 'Passport' },
      { kind: 'thing', type_id: '../packs', type_name: 'Passport' },
      { kind: 'thing', type_id: 'passport', type_name: '   ' },
      { kind: 'thing', type_id: 'passport' },
      { kind: 'thing', type_name: 'Passport' },
    ])).toEqual([]);
  });

  it('shares the cap with the other fixes', () => {
    const thing = (i: number) => ({ kind: 'thing', type_id: `t${i}`, type_name: `T${i}` });
    expect(chatFixesOf([{ kind: 'switch', entry_key: 'data.task', label: 'Your tasks' }, ...[1, 2, 3, 4].map(thing)]))
      .toHaveLength(CHAT_FIX_LIMIT);
  });

  it('says it in the words every surface shows, with the article the name takes', () => {
    expect(thingStepWords('Passport')).toEqual({ lead: 'No Passport in Yours yet.', link: 'Add a Passport', landed: 'A Passport is in Yours now.',
      named: 'a Passport' });
    // Slice E — the name with its article, for a sentence that names the type (a pack's badge).
    expect(thingStepWords('ID card').named).toBe('an ID card');
    expect(thingStepWords('ID card').landed).toBe('An ID card is in Yours now.');
    expect(thingStepWords('ID card').link).toBe('Add an ID card');
    expect(thingStepWords('Insurance policy').link).toBe('Add an Insurance policy');
    expect(thingStepWords('Heirloom or keepsake').link).toBe('Add an Heirloom or keepsake');
    expect(thingStepWords('Home Assistant device').link).toBe('Add a Home Assistant device');
    expect(thingStepWords('Uniform').link).toBe('Add a Uniform');
    expect(thingStepWords('Body').link).toBe('Add a Body');
  });
});

// D-404 step 4 — a thing with no readings yet, and the installed pack that feeds them.
describe('a thing with no readings, and what feeds it (D-404 step 4)', () => {
  it('keeps the thing\'s name and the pack, once per pack; drops a slug no pack can have or a blank name', () => {
    expect(chatFixesOf([
      { kind: 'source', thing_name: ' Anna’s body ', pack_slug: 'body-signals-apple-health', pack_name: 'Body signals from Apple Health' },
      { kind: 'source', thing_name: 'Anna’s body', pack_slug: 'body-signals-apple-health', pack_name: 'Body signals from Apple Health' },
      { kind: 'source', thing_name: 'x', pack_slug: '../packs', pack_name: 'y' },
      { kind: 'source', thing_name: '  ', pack_slug: 'p', pack_name: 'y' },
      { kind: 'source', thing_name: 'x', pack_slug: 'p' },
    ])).toEqual([{ kind: 'source', thing_name: 'Anna’s body', pack_slug: 'body-signals-apple-health', pack_name: 'Body signals from Apple Health' }]);
  });

  it('says it in the words the line, its link and the model share', () => {
    expect(sourceStepWords('Anna’s body', 'Body signals from Apple Health'))
      .toEqual({ lead: 'No readings for Anna’s body yet.', link: 'Set up Body signals from Apple Health' });
  });
});

// D-405 slice 2 — one of the owner's core features with none connected.
describe('a feature to connect (D-405 slice 2)', () => {
  it('keeps mail, a calendar and a file source, each once; drops any other feature', () => {
    expect(chatFixesOf([
      { kind: 'feature', feature: 'mail' },
      { kind: 'feature', feature: 'calendar' },
      { kind: 'feature', feature: 'mail' },
      { kind: 'feature', feature: 'file' },
    ])).toEqual([
      { kind: 'feature', feature: 'mail' },
      { kind: 'feature', feature: 'calendar' },
      { kind: 'feature', feature: 'file' },
    ]);
    expect(chatFixesOf([
      { kind: 'feature', feature: 'contacts' },
      { kind: 'feature', feature: 'Mail' },
      { kind: 'feature', feature: '../connections' },
      { kind: 'feature' },
    ])).toEqual([]);
  });

  it('says each in the words every surface shows: what is missing, its link, and once one is connected', () => {
    expect(featureStepWords('mail')).toEqual({ lead: 'No mailbox is connected yet.', link: 'Connect your mail', landed: 'A mailbox is connected now.' });
    // Every server has its own calendar: the one missing is the owner's.
    expect(featureStepWords('calendar')).toEqual({ lead: 'No calendar of yours is connected yet.', link: 'Connect your calendar',
      landed: 'Your calendar is connected now.' });
    expect(featureStepWords('file')).toEqual({ lead: 'No file source is connected yet.', link: 'Connect your files',
      landed: 'A file source is connected now.' });
    // One set of words per feature: a feature added to the list without its words would show nothing.
    for (const feature of CHAT_SETUP_FEATURES) expect(featureStepWords(feature).link).toMatch(/^Connect your /u);
  });
});

// D-405 slice 4 — the Set up page's mail, calendar and files, read back.
describe('the Set up page\'s features, read back', () => {
  it('keeps each feature once, in the page\'s order, connected, not, or unknown', () => {
    expect(chatSetupFeaturesOf([
      { feature: 'file', connected: null },
      { feature: 'mail', connected: true },
      { feature: 'mail', connected: false },
      { feature: 'calendar', connected: false },
    ])).toEqual([
      { feature: 'mail', connected: true },
      { feature: 'calendar', connected: false },
      { feature: 'file', connected: null },
    ]);
  });

  it('⛔ drops a feature it does not know and a state that is none of the three; a missing one stays missing, not "none"', () => {
    expect(chatSetupFeaturesOf([
      { feature: 'contacts', connected: true },
      { feature: 'mail', connected: 'yes' },
      { feature: 'mail' },
      { feature: 'calendar', connected: true },
    ])).toEqual([{ feature: 'calendar', connected: true }]);
    expect(chatSetupFeaturesOf('nope')).toEqual([]);
  });
});

describe('D-339 slice 23 — a source step that names its thing, for a setup on the thing\'s own page', () => {
  const base = { kind: 'source', thing_name: 'Anna’s body', pack_slug: 'body-signals-apple-health', pack_name: 'Body signals from Apple Health' } as const;

  it('keeps a thing id that is one segment of an address, and drops any other', () => {
    expect(chatFixesOf([{ ...base, thing_id: 'asset-idempotent-6433:2' }])).toEqual([{ ...base, thing_id: 'asset-idempotent-6433:2' }]);
    for (const bad of ['a/b', ' b1', 'b 1', '', '../x', 7, null]) expect(chatFixesOf([{ ...base, thing_id: bad }])).toEqual([base]);
  });

  it('opens Apple Health\'s setup on the Body\'s page only when the step names the Body; any other pack keeps its page', () => {
    expect(THING_PAGE_SETUPS).toEqual({ 'body-signals-apple-health': 'Connect Apple Health' });
    expect(Object.isFrozen(THING_PAGE_SETUPS)).toBe(true);
    expect(thingPageSetupOf({ pack_slug: 'body-signals-apple-health', thing_id: 'b1' })).toBe('Connect Apple Health');
    expect(thingPageSetupOf({ pack_slug: 'body-signals-apple-health' })).toBeUndefined();
    expect(thingPageSetupOf({ pack_slug: 'body-signals-oura', thing_id: 'b1' })).toBeUndefined();
    // A slug that is a name on every object is not a setup.
    expect(thingPageSetupOf({ pack_slug: 'constructor', thing_id: 'b1' })).toBeUndefined();
    expect(sourceStepWords('Anna’s body', 'Body signals from Apple Health', 'Connect Apple Health'))
      .toEqual({ lead: 'No readings for Anna’s body yet.', link: 'Connect Apple Health' });
    expect(sourceStepWords('Anna’s body', 'Body signals from Apple Health').link).toBe('Set up Body signals from Apple Health');
  });
});
