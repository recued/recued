import { describe, expect, it } from 'vitest';
import type { Asset } from '@recued/contracts';
import { changedAssetPatch } from '../yours/asset-provenance.js';
import { PursuitFieldError, endedPursuits, pursuitDraft, pursuitEndingWords, pursuitFacts, pursuitPartChoices, pursuitPartsEnding,
  pursuitPatch, pursuitTree } from '../yours/pursuits.js';

// D-342 slice 1 — the Pursuits tab's tree, endings and form, as pure reads of the assets.
const at = Date.parse('2026-11-06T12:00Z');
const pursuit = (id: string, patch: Partial<Asset> = {}): Asset => ({ id, name: id, class_id: 'pursuit', status: 'active', source_id: 'recued.asset',
  last_seen_at: at, sync_state: 'live', conflict_policy: 'recued_wins', created_at: at, updated_at: at, dates: { target_on: null },
  readings: { progress: null }, observations: {}, values: [], anchors: [], attributes: {}, settings: {}, rules: [],
  field_sources: {}, retirement: 'part', audience: 'owner', sphere: 'personal', ...patch });
const names = (rows: ReturnType<typeof pursuitTree>) => rows.map(row => `${'  '.repeat(row.depth)}${row.asset.name}`);

describe('D-342 §7 the Pursuits tree', () => {
  it('nests parts under their pursuit, each level by target date, then by name, with no date last', () => {
    const rows = pursuitTree([
      pursuit('Read more'),
      pursuit('Learn Spanish', { dates: { target_on: '2027-06-01' } }),
      pursuit('Unit 6', { belongs_to: 'Learn Spanish' }),
      pursuit('B1 by December', { belongs_to: 'Learn Spanish', dates: { target_on: '2026-12-31' } }),
      pursuit('Apply for the course', { belongs_to: 'B1 by December', dates: { target_on: '2026-11-20' } }),
      pursuit('Being kinder'),
      pursuit('Run a 10k', { dates: { target_on: '2027-03-01' } }),
    ]);
    expect(names(rows)).toEqual(['Run a 10k', 'Learn Spanish', '  B1 by December', '    Apply for the course', '  Unit 6', 'Being kinder', 'Read more']);
  });
  it('lists only active pursuits; a part whose pursuit ended, or whose parent is not a pursuit, stands at the top', () => {
    const rows = pursuitTree([
      pursuit('Learn Spanish', { status: 'retired' }),
      pursuit('B1 by December', { belongs_to: 'Learn Spanish' }),
      pursuit('Learn the chords', { belongs_to: 'guitar' }),
      { ...pursuit('guitar'), class_id: 'heirloom' },
      pursuit('Lent out', { status: 'lent' }),
    ]);
    expect(names(rows)).toEqual(['B1 by December', 'Learn the chords', 'Lent out']);
  });
  it('still shows each member of a loop that reached it, once', () => {
    expect(names(pursuitTree([pursuit('A', { belongs_to: 'B' }), pursuit('B', { belongs_to: 'A' })]))).toEqual(['A', '  B']);
  });
});

describe('D-342 ending a pursuit', () => {
  it('lists ended pursuits, the most recently ended first', () => {
    const ended = endedPursuits([
      pursuit('First', { status: 'retired', field_sources: { status: { kind: 'owner', ref: 'owner:local', at: at + 1 } } }),
      pursuit('Second', { status: 'retired', field_sources: { status: { kind: 'owner', ref: 'owner:local', at: at + 2 } } }),
      pursuit('Active'),
    ]);
    expect(ended.map(asset => asset.name)).toEqual(['Second', 'First']);
  });
  it('says how it ended: Reached, Let go, with the pursuit it was part of, or only that it did', () => {
    expect(pursuitEndingWords(pursuit('A', { status: 'retired', attributes: { ended_as: 'reached' } }))).toBe('Reached');
    expect(pursuitEndingWords(pursuit('A', { status: 'retired', attributes: { ended_as: 'let_go' } }))).toBe('Let go');
    expect(pursuitEndingWords(pursuit('A', { status: 'retired', field_sources: { status: { kind: 'owner', ref: 'retirement:parent', at } } })))
      .toBe('Ended with the pursuit it was part of');
    expect(pursuitEndingWords(pursuit('A', { status: 'retired' }))).toBe('Ended');
  });
  it('names the active parts that end with it, as the server walks them', () => {
    const all = [pursuit('Spanish'), pursuit('B1', { belongs_to: 'Spanish' }), pursuit('Unit 6', { belongs_to: 'B1' }),
      pursuit('Done already', { belongs_to: 'Spanish', status: 'retired' }), pursuit('Kept', { belongs_to: 'Spanish', retirement: 'cancel_or_transfer' })];
    expect(pursuitPartsEnding(all[0]!, all).map(asset => asset.name)).toEqual(['B1', 'Unit 6']);
  });
});

describe('D-342 what a pursuit says', () => {
  const spanish = pursuit('Learn Spanish', { attributes: { horizon: 'ongoing', why: 'Ana’s family', where_i_am: 'Finished unit 4' },
    readings: { progress: { value: 4, unit: 'units', as_of: at, evidence: [] } }, dates: { target_on: '2026-12-31' } });
  it('gives a line its horizon, where I am, progress and target date, and its page why in place of progress', () => {
    expect(pursuitFacts(spanish).map(([name]) => name)).toEqual(['Horizon', 'Where I am', 'Progress', 'Target date']);
    expect(pursuitFacts(spanish)[2]).toEqual(['Progress', '4 units', 'readings.progress']);
    // Each fact names the field it is kept in, so its page can say where it came from.
    expect(pursuitFacts(spanish, 'page').map(([, , path]) => path)).toEqual(['attributes.horizon', 'attributes.why', 'attributes.where_i_am', 'dates.target_on']);
    expect(pursuitFacts(spanish, 'page').map(([name]) => name)).toEqual(['Horizon', 'Why', 'Where I am', 'Target date']);
  });
  it('leaves out what was not given', () => {
    expect(pursuitFacts(pursuit('Being kinder'))).toEqual([]);
  });
});

describe('D-342 Part of', () => {
  it('offers every active pursuit but this one and any under it, an ended part’s included, and keeps the current parent', () => {
    const all = [pursuit('Spanish'), pursuit('B1', { belongs_to: 'Spanish' }), pursuit('Old', { belongs_to: 'B1', status: 'retired' }),
      pursuit('Under old', { belongs_to: 'Old' }), pursuit('Running')];
    expect(pursuitPartChoices(all[1], all).map(([id]) => id)).toEqual(['', 'Running', 'Spanish']);
    expect(pursuitPartChoices(undefined, all).map(([, name]) => name)).toEqual(['Nothing: it stands on its own', 'Running', 'Spanish', '– B1', 'Under old']);
    // A parent that is not an active pursuit stays chosen, by its name.
    expect(pursuitPartChoices(pursuit('Chords', { belongs_to: 'guitar' }), all, 'Guitar').at(-1)).toEqual(['guitar', 'Guitar']);
  });
});

describe('D-342 the Pursuit form', () => {
  const draft = (patch: Partial<ReturnType<typeof pursuitDraft>> = {}) => ({ ...pursuitDraft(), ...patch });
  it('adds a pursuit with only what was given; not private unless the owner ticks it, as its type makes it', () => {
    // Ruling 9: the daily suggestions are what a pursuit is for, and they leave a private one out.
    expect(pursuitDraft().private).toBe(false);
    expect(pursuitPatch(draft({ name: ' Run a 10k ' }), undefined, at)).toEqual({ name: 'Run a 10k' });
    expect(pursuitPatch(draft({ name: 'Learn Spanish', horizon: 'ongoing', why: ' Ana’s family ', where_i_am: 'Unit 4', progress: '4', unit: 'units',
      target_on: '2026-12-31', part_of: 'languages', private: true, household: true }), undefined, at)).toEqual({ name: 'Learn Spanish',
      attributes: { horizon: 'ongoing', why: 'Ana’s family', where_i_am: 'Unit 4' }, dates: { target_on: '2026-12-31' },
      readings: { progress: { value: 4, unit: 'units', as_of: at, evidence: [] } }, belongs_to: 'languages', settings: { sensitive: true }, audience: 'household' });
  });
  it('refuses at the field it cannot save', () => {
    const refused = (patch: Partial<ReturnType<typeof pursuitDraft>>) => {
      try { pursuitPatch(draft({ name: 'Read', ...patch }), undefined, at); } catch (error) { return error instanceof PursuitFieldError ? error.field : 'other'; }
      return 'saved';
    };
    expect(refused({ name: '  ' })).toBe('name');
    expect(refused({ progress: '12' })).toBe('unit');
    expect(refused({ unit: 'books' })).toBe('progress');
    expect(refused({ progress: 'twelve', unit: 'books' })).toBe('progress');
    expect(refused({ target_on: '2026-02-30' })).toBe('target_on');
    expect(refused({ progress: '0', unit: 'books' })).toBe('saved');
  });
  it('sends nothing from an edit the owner did not change, so every fact keeps its source', () => {
    const own = pursuit('Learn Spanish', { attributes: { horizon: 'ongoing', where_i_am: 'Unit 4' }, belongs_to: 'languages',
      readings: { progress: { value: 4, unit: 'units', as_of: at - 1000, evidence: [] } }, dates: { target_on: '2026-12-31' } });
    expect(changedAssetPatch(pursuitPatch(pursuitDraft(own), own, at), own)).toEqual({});
    // A pursuit with no private setting of its own, as its type makes it, shows the box unticked, as
    // the server reads it; leaving it unticked sends nothing, as an unset audience shown as "Only me"
    // sends nothing.
    const bare = pursuit('Bare', { settings: {}, audience: undefined, readings: {}, dates: {} });
    expect(pursuitDraft(bare).private).toBe(false);
    expect(changedAssetPatch(pursuitPatch(pursuitDraft(bare), bare, at), bare)).toEqual({});
    // One the owner made private shows it ticked, and leaving it ticked sends nothing too.
    const kept = pursuit('Kept to myself', { settings: { sensitive: true } });
    expect(pursuitDraft(kept).private).toBe(true);
    expect(changedAssetPatch(pursuitPatch(pursuitDraft(kept), kept, at), kept)).toEqual({});
  });
  it('sends what changed: a new reading for new progress, null for a cleared note, and a box the owner changed', () => {
    const own = pursuit('Learn Spanish', { attributes: { horizon: 'ongoing', where_i_am: 'Unit 4' },
      readings: { progress: { value: 4, unit: 'units', as_of: at - 1000, evidence: [] } } });
    const edit = (patch: Partial<ReturnType<typeof pursuitDraft>>) => changedAssetPatch(pursuitPatch({ ...pursuitDraft(own), ...patch }, own, at), own);
    expect(edit({ progress: '5' })).toEqual({ readings: { progress: { value: 5, unit: 'units', as_of: at, evidence: [] } } });
    expect(edit({ where_i_am: '' })).toEqual({ attributes: { where_i_am: null } });
    // Clearing a note that was never written sends nothing.
    expect(edit({ why: '' })).toEqual({});
    expect(edit({ progress: '', unit: '' })).toEqual({ readings: { progress: null } });
    expect(edit({ private: true, household: true })).toEqual({ settings: { sensitive: true }, audience: 'household' });
    const kept = pursuit('Kept to myself', { settings: { sensitive: true } });
    expect(changedAssetPatch(pursuitPatch({ ...pursuitDraft(kept), private: false }, kept, at), kept)).toEqual({ settings: { sensitive: false } });
    expect(edit({ target_on: '2027-01-15', part_of: 'languages' })).toEqual({ dates: { target_on: '2027-01-15' }, belongs_to: 'languages' });
  });
});

describe('D-343 slice 4 — "Ask me in the evening" on the Pursuit form', () => {
  it('is off unless the owner ticks it, and a new pursuit sends it only then', () => {
    expect(pursuitDraft().evening).toBe(false);
    expect(pursuitPatch({ ...pursuitDraft(), name: 'Learn Spanish' }, undefined, at)).toEqual({ name: 'Learn Spanish' });
    expect(pursuitPatch({ ...pursuitDraft(), name: 'Learn Spanish', evening: true }, undefined, at))
      .toEqual({ name: 'Learn Spanish', settings: { evening: true } });
    expect(pursuitPatch({ ...pursuitDraft(), name: 'Learn Spanish', evening: true, private: true }, undefined, at))
      .toEqual({ name: 'Learn Spanish', settings: { sensitive: true, evening: true } });
  });
  it('an edit sends the box the owner changed, beside Private, and nothing when neither changed', () => {
    const own = pursuit('Learn Spanish', { settings: { sensitive: true } });
    const edit = (patch: Partial<ReturnType<typeof pursuitDraft>>) => changedAssetPatch(pursuitPatch({ ...pursuitDraft(own), ...patch }, own, at), own);
    expect(edit({ evening: true })).toEqual({ settings: { evening: true } });
    expect(edit({ evening: true, private: false })).toEqual({ settings: { sensitive: false, evening: true } });
    const asked = pursuit('Asked about', { settings: { evening: true } });
    expect(pursuitDraft(asked).evening).toBe(true);
    expect(changedAssetPatch(pursuitPatch(pursuitDraft(asked), asked, at), asked)).toEqual({});
    expect(changedAssetPatch(pursuitPatch({ ...pursuitDraft(asked), evening: false }, asked, at), asked)).toEqual({ settings: { evening: false } });
  });
});
