/** D-402 slice H2 (§4.2 item 1) — a recipe's browser settings, read from how its steps use them. */
import { describe, expect, it } from 'vitest';
import { recipeBrowserSettings, recipeBrowserSteps } from '../browser-settings.js';
import { readRunQuestionHold, runQuestionFirstBlock, type RunQuestion } from '../run-question.js';
import { callerPreapprovalCovers, readPreapprovalBrowsers, samePreapprovalBrowsers } from '../trigger-preapproval.js';
import { browserPassKeyHash } from '../browser-pass.js';

describe('D-402 slice H2 — which settings name one of the owner\'s browsers', () => {
  it('a setting passed straight as a browser operation\'s bridge_id, in steps or prefetch, each key once', () => {
    expect(recipeBrowserSettings({
      variables: { browser_1: 'inst-work', browser_2: '' },
      prefetch_steps: [{ id: 'tabs', op: 'core.dom.tabs', args: { target: '*://*/*', bridge_id: '{{config.browser_2}}' } }],
      steps: [
        { id: 'act_1', op: 'core.dom.act', args: { target: 'https://a.example/*', steps: [], bridge_id: ' {{config.browser_1}} ' } },
        { id: 'act_2', op: 'core.dom.act', args: { target: 'https://a.example/*', steps: [], bridge_id: '{{config.browser_1}}' } },
      ],
    })).toEqual([{ key: 'browser_1' }, { key: 'browser_2' }]);
  });

  it('not a value made of more than the setting, a fixed id, nor another operation\'s argument', () => {
    expect(recipeBrowserSettings({ variables: { browser: 'inst-work' }, steps: [
      { id: 'a', op: 'core.dom.act', args: { bridge_id: '{{config.browser}}-work' } },
      { id: 'b', op: 'core.dom.act', args: { bridge_id: 'tok-work' } },
      { id: 'c', op: 'core.mail.send', args: { bridge_id: '{{config.browser}}' } },
      { id: 'd', transform: 'set', source: {}, field: 'x', value: '{{config.browser}}' },
    ] })).toEqual([]);
    expect(recipeBrowserSettings({})).toEqual([]);
  });

  it('⛔ not a caller\'s argument: a labeled one, as the Browser Toolkit\'s bridge_id is, one required from the caller, or one never declared', () => {
    const passes = (key: string) => [{ id: 'act', op: 'core.dom.act', args: { target: '*://*/*', bridge_id: `{{config.${key}}}` } }];
    const toolkit = { label: 'Browser', type: 'string', help: 'Optional ID from List browser tabs/bridges.', default: '' };
    expect(recipeBrowserSettings({ variables: { bridge_id: toolkit }, steps: passes('bridge_id') })).toEqual([]);
    expect(recipeBrowserSettings({ variables: { browser: null }, steps: passes('browser') })).toEqual([]);
    expect(recipeBrowserSettings({ variables: {}, steps: passes('browser') })).toEqual([]);
    expect(recipeBrowserSettings({ steps: passes('browser') })).toEqual([]);
  });

  it('D-402 slice H3 — each such step, in either spelling: as authored, or lowered as the server runs it', () => {
    expect(recipeBrowserSteps({ variables: { browser: 'inst-work' }, steps: [
      { id: 'authored', op: 'core.dom.act', args: { target: 'https://a.example/*', bridge_id: '{{config.browser}}' } },
      { id: 'lowered', ingredient: 'dom-act', input: { target: 'https://b.example/*', bridge_id: '{{config.browser}}' } },
      { id: 'not_kernel', ingredient: 'dom-reader-acme', input: { bridge_id: '{{config.browser}}' } },
    ] })).toEqual([
      { step_id: 'authored', op: 'core.dom.act', key: 'browser', target: 'https://a.example/*',
        args: { target: 'https://a.example/*', bridge_id: '{{config.browser}}' } },
      { step_id: 'lowered', op: 'core.dom.act', key: 'browser', target: 'https://b.example/*',
        args: { target: 'https://b.example/*', bridge_id: '{{config.browser}}' } },
    ]);
  });
});


describe('D-402 slice H4 — the browsers a pre-approval holds', () => {
  it('the same when each setting names the same browser; none and none are the same', () => {
    expect(samePreapprovalBrowsers({ a: 'x', b: 'y' }, { b: 'y', a: 'x' })).toBe(true);
    expect(samePreapprovalBrowsers(undefined, {})).toBe(true);
    expect(samePreapprovalBrowsers({ a: 'x' }, { a: 'z' })).toBe(false);
    expect(samePreapprovalBrowsers({ a: 'x' }, { a: 'x', b: 'y' })).toBe(false);
    expect(samePreapprovalBrowsers({ a: 'x' }, undefined)).toBe(false);
  });
  it('read back only as settings naming browsers', () => {
    expect(readPreapprovalBrowsers({ browser: 'inst-work' })).toEqual({ browser: 'inst-work' });
    expect(readPreapprovalBrowsers({ browser: 7 })).toBeUndefined();
    expect(readPreapprovalBrowsers(['inst-work'])).toBeUndefined();
    expect(readPreapprovalBrowsers({ '': 'inst-work' })).toBeUndefined();
  });
  it('a row covers a run only for the browsers it was granted for', () => {
    const row = { id: 'r', caller: { kind: 'owner_chat' as const }, recipe_id: 'r', recipe_sha256: 'v', uses: 0, created_at: 1,
      browsers: { browser: 'inst-work' } };
    const call = { caller: { kind: 'owner_chat' as const }, recipe_id: 'r', recipe_sha256: 'v', run_id: 'run' };
    expect(callerPreapprovalCovers(row, { ...call, browsers: { browser: 'inst-work' } })).toBe(true);
    expect(callerPreapprovalCovers(row, { ...call, browsers: { browser: 'inst-home' } })).toBe(false);
    expect(callerPreapprovalCovers(row, call)).toBe(false);
  });
  it('a held question keeps them, and one it cannot read is no hold', () => {
    const hold = { question: { recipe_name: 'R', runs: 1, covers: [], still: [], ai: false, secrets: [], saves_files: 0,
      asked_by: { kind: 'owner_chat' } }, caller: { kind: 'owner_chat' }, recipe_sha256: 'a'.repeat(64), always: true };
    expect(readRunQuestionHold({ ...hold, browsers: { browser: 'inst-work' } })?.browsers).toEqual({ browser: 'inst-work' });
    expect(readRunQuestionHold(hold)).not.toHaveProperty('browsers');
    expect(readRunQuestionHold({ ...hold, browsers: { browser: 3 } })).toBeUndefined();
  });
});

describe('D-402 slice H4c — a site pass keyed by its browser too', () => {
  const key = { principal: { kind: 'owner_chat' as const }, recipe: 'read-then-type', site: 'https://b.example' };
  it('⛔ a pass with no browser keeps the hash it had: every pass granted before, and every Browser Toolkit pass', () => {
    // Pinned from the code before slice H4c.
    expect(browserPassKeyHash(key)).toBe('e4797a48b126ac9bd3f905f82efc1ddc72350b2f4830dd7cccf74b7a276bbc5b');
  });
  it('one browser\'s pass is not another\'s, nor one with no browser', () => {
    const home = browserPassKeyHash({ ...key, browser: 'inst-home' });
    expect(home).not.toBe(browserPassKeyHash({ ...key, browser: 'inst-work' }));
    expect(home).not.toBe(browserPassKeyHash(key));
  });
});

describe('D-402 slice H4a — the question says what a run does in each of its browsers', () => {
  const question = (browsers?: RunQuestion['browsers']): RunQuestion => ({ recipe_name: 'Read, then type', runs: 1,
    covers: [{ label: 'Act in Home', where: 'on b.example' }], still: [], ai: false, secrets: [], saves_files: 0,
    asked_by: { kind: 'owner_chat' }, ...(browsers !== undefined ? { browsers } : {}) });
  it('what it reads in each, then what crosses from one to the next it acts in', () => {
    expect(runQuestionFirstBlock(question([{ name: 'Work', reads: ['a.example'], acts: [] }, { name: 'Home', reads: [], acts: ['b.example'] }])))
      .toBe('Your chat asks to run it. Without asking, it will: act in Home on b.example. In Work it reads a.example. '
        + 'What it reads in Work is used in Home.');
  });
  it('nothing more for one browser, and no crossing where nothing is read before an action', () => {
    expect(runQuestionFirstBlock(question([{ name: 'Home', reads: ['b.example'], acts: ['b.example'] }])))
      .toBe('Your chat asks to run it. Without asking, it will: act in Home on b.example.');
    expect(runQuestionFirstBlock(question([{ name: 'Home', reads: [], acts: ['b.example'] }, { name: 'Work', reads: ['a.example'], acts: [] }])))
      .toBe('Your chat asks to run it. Without asking, it will: act in Home on b.example. In Work it reads a.example.');
  });
  it('kept on the hold, and a hold whose browsers it cannot read is none', () => {
    const hold = { question: { ...question(), browsers: [{ name: 'Work', reads: ['a.example'], acts: [] }] },
      caller: { kind: 'owner_chat' }, recipe_sha256: 'a'.repeat(64), always: true };
    expect(readRunQuestionHold(hold)?.question.browsers).toEqual([{ name: 'Work', reads: ['a.example'], acts: [] }]);
    expect(readRunQuestionHold({ ...hold, question: { ...hold.question, browsers: [{ name: 'Work', reads: 'a.example', acts: [] }] } }))
      .toBeUndefined();
  });
});
