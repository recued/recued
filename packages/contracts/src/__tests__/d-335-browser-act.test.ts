/** D-335 slices J and K — the steps of a `core.dom.act` call (`browser-act.ts`): strict about what
 *  each step takes, so an ignored `submit`, `success_when` or `fail_when` never reads as done;
 *  bounded in count and in waiting; and what a step's checks cost the sequence's wait. */

import { describe, expect, it } from 'vitest';

import {
  BROWSER_ACT_CHECK_SECONDS,
  BROWSER_ACT_MAX_STEPS,
  BROWSER_ACT_MAX_TOTAL_WAIT_SECONDS,
  BROWSER_ACT_PICK_SECONDS,
  browserActStepCheckSeconds,
  browserActStepMayMove,
  browserActStepSubmits,
  browserActStepWaitSeconds,
  browserActStepWatchSeconds,
  parseBrowserActSteps,
  type BrowserActStep,
} from '../browser-act.js';

const LOGIN = [
  { do: 'type', ref: 'e3', value: 'me@example.com' },
  { do: 'type', ref: 'e5', value: 'hunter2', submit: true },
];

const error = (raw: unknown): string => {
  const parsed = parseBrowserActSteps(raw);
  if (parsed.ok) throw new Error('parsed');
  return parsed.error;
};

describe('D-335 slice J — parsing a sequence', () => {
  it('takes a sign-in as typed, and keeps only what each step names', () => {
    const parsed = parseBrowserActSteps([
      ...LOGIN,
      { do: 'wait', selector: '#welcome', until: 'shown', text: 'Hello', seconds: 4 },
      { do: 'click', selector: 'a.settings', success_when: { url_includes: '/settings', seconds: 3 } },
      { do: 'submit', ref: 'e9' },
      { do: 'wait', seconds: 1.5 },
    ]);
    expect(parsed).toEqual({ ok: true, steps: [
      { do: 'type', ref: 'e3', value: 'me@example.com' },
      { do: 'type', ref: 'e5', value: 'hunter2', submit: true },
      { do: 'wait', selector: '#welcome', until: 'shown', text: 'Hello', seconds: 4 },
      { do: 'click', selector: 'a.settings', success_when: { url_includes: '/settings', seconds: 3 } },
      { do: 'submit', ref: 'e9' },
      { do: 'wait', seconds: 1.5 },
    ] });
    // `submit: false` is the same as none, so it is not carried.
    expect(parseBrowserActSteps([{ do: 'type', ref: 'e1', value: 'x', submit: false }]))
      .toEqual({ ok: true, steps: [{ do: 'type', ref: 'e1', value: 'x' }] });
    // An empty text clears a field.
    expect(parseBrowserActSteps([{ do: 'type', ref: 'e1', value: '' }]).ok).toBe(true);
  });

  it('refuses a key a step does not take, naming the step as the model counts it', () => {
    expect(error([LOGIN[0], { do: 'click', ref: 'e2', value: 'x' }]))
      .toBe('step 2: a click step takes do, ref, selector, success_when, fail_when, not value');
    expect(error([{ do: 'type', ref: 'e1', value: 'x', enter: true }]))
      .toBe('step 1: a type step takes do, ref, selector, value, submit, pick, success_when, fail_when, not enter');
    // Slice K renamed `expect`; it was never released, so it is refused like any other key.
    expect(error([{ do: 'click', ref: 'e1', expect: { shows: '#x' } }]))
      .toBe('step 1: a click step takes do, ref, selector, success_when, fail_when, not expect');
    expect(error([{ do: 'click', ref: 'e1', success_when: { shows: '#x', waits: 3 } }]))
      .toBe('step 1: success_when takes page_changes, url_includes, shows, gone, text, seconds, not waits');
    expect(error([{ do: 'press', ref: 'e1' }])).toBe('step 1: "do" is type, click, submit or wait, not "press"');
    expect(error([LOGIN[0], 'click e2'])).toBe('step 2 is not an object');
  });

  /** ⛔ Measured: in six live runs, 7 of the 9 sequences refused named their kind under "type" or
   *  "action" (the keys other browser tools use). Either is read as "do" when it is the only one
   *  naming a kind; the steps come back with "do". */
  it('reads a step\'s kind from "type" or "action" when it has no "do"', () => {
    expect(parseBrowserActSteps([{ type: 'type', ref: 'e4', value: 'Ada Lovelace', submit: true }]))
      .toEqual({ ok: true, steps: [{ do: 'type', ref: 'e4', value: 'Ada Lovelace', submit: true }] });
    expect(parseBrowserActSteps([{ action: 'type', ref: 'e4', value: 'Ada Lovelace' }, { action: 'submit', ref: 'e4' },
      { type: 'wait', selector: '#content' }]))
      .toEqual({ ok: true, steps: [{ do: 'type', ref: 'e4', value: 'Ada Lovelace' }, { do: 'submit', ref: 'e4' },
        { do: 'wait', selector: '#content' }] });
    // Two that name a kind could each be meant.
    expect(error([{ type: 'click', action: 'submit', ref: 'e1' }]))
      .toBe('step 1 says what it does twice, in "type" and "action": say it once, in "do"');
    // Beside "do", either is a key the step does not take.
    expect(error([{ do: 'click', ref: 'e1', type: 'button' }]))
      .toBe('step 1: a click step takes do, ref, selector, success_when, fail_when, not type');
    // One that names no kind is no kind: the step has none (a live run keyed it by an address).
    expect(error([{ action: 'fill', ref: 'e1' }])).toBe(error([{ 'https://example.org/': 'type', ref: 'e1' }]));
    expect(error([{ action: 'fill', ref: 'e1' }]))
      .toBe('step 1 has no "do", which says what it does: type, click, submit or wait, such as {"do":"click","ref":"e7"}');
  });

  it('names each element one way, by a ref or by a selector', () => {
    expect(error([{ do: 'click' }])).toBe('step 1: name the element by ref or by selector, one of the two');
    expect(error([{ do: 'click', ref: 'e1', selector: '#a' }])).toBe('step 1: name the element by ref or by selector, one of the two');
    expect(error([{ do: 'click', ref: '' }])).toBe('step 1: ref is a ref from the latest inspection, such as e12');
    expect(error([{ do: 'click', selector: '  ' }])).toBe('step 1: selector is a CSS selector');
  });

  it('bounds the count and the waiting', () => {
    expect(error([])).toBe('steps must be a list of at least one step');
    expect(error('type e1')).toBe('steps must be a list of at least one step');
    const many = Array.from({ length: BROWSER_ACT_MAX_STEPS + 1 }, () => ({ do: 'click', ref: 'e1' }));
    expect(error(many)).toBe(`at most ${BROWSER_ACT_MAX_STEPS} steps, and this has ${BROWSER_ACT_MAX_STEPS + 1}`);
    expect(parseBrowserActSteps(many.slice(1)).ok).toBe(true);
    expect(error([{ do: 'wait', seconds: 11 }])).toBe('step 1: seconds is a number above 0, at most 10');
    expect(error([{ do: 'wait', seconds: 0 }])).toBe('step 1: seconds is a number above 0, at most 10');
    // Four pauses of 10 seconds are 40, over the 30 a sequence may wait.
    const pauses = [LOGIN[0], ...Array.from({ length: 4 }, () => ({ do: 'wait', seconds: 10 }))];
    expect(error(pauses)).toBe(`the waits and checks add up to 40 seconds, and a sequence may wait at most ${BROWSER_ACT_MAX_TOTAL_WAIT_SECONDS}`);
    expect(parseBrowserActSteps(pauses.slice(0, 4)).ok).toBe(true);
  });

  it('needs a step that does something, and a wait that waits for something', () => {
    expect(error([{ do: 'wait', seconds: 2 }])).toBe('a sequence needs a step that types, clicks or submits');
    expect(error([{ do: 'wait' }])).toBe('step 1: a wait takes seconds, or a selector to wait for');
    expect(error([{ do: 'wait', until: 'gone', seconds: 2 }])).toBe('step 1: until and text need a selector');
    expect(error([{ do: 'wait', selector: '.x', until: 'hidden' }])).toBe('step 1: until is shown or gone');
  });

  it('checks a step\'s success_when: one of shows and gone, at least one check, each of its type', () => {
    const on = (success_when: unknown) => error([{ do: 'click', ref: 'e1', success_when }]);
    expect(on({})).toBe('step 1: success_when names a check: page_changes, url_includes, shows, gone or text');
    expect(on({ seconds: 3 })).toBe('step 1: success_when names a check: page_changes, url_includes, shows, gone or text');
    expect(on({ shows: '#a', gone: '#b' })).toBe('step 1: success_when takes one of shows and gone, not both');
    expect(on({ page_changes: 'yes' })).toBe('step 1: success_when.page_changes is true or false');
    expect(on({ text: 4 })).toBe('step 1: success_when.text is text');
    expect(on('the page')).toBe('step 1: success_when is an object');
  });

  it('refuses a page check on typing alone, which leaves the page where it is', () => {
    expect(error([{ do: 'type', ref: 'e1', value: 'x', success_when: { page_changes: true } }]))
      .toBe('step 1: typing leaves the page where it is: check page_changes or url_includes on the step that sends '
        + 'the form (submit: true), or on a click');
    expect(error([{ do: 'type', ref: 'e1', value: 'x', success_when: { url_includes: '/q' } }])).toMatch(/^step 1: typing leaves/);
    // Sending the form, it moves, and what typing shows can be checked either way.
    expect(parseBrowserActSteps([{ do: 'type', ref: 'e1', value: 'x', submit: true, success_when: { url_includes: '/q' } }]).ok)
      .toBe(true);
    expect(parseBrowserActSteps([{ do: 'type', ref: 'e1', value: 'x', success_when: { shows: '.suggestions' } }]).ok).toBe(true);
  });
});

describe('D-335 slice K — a step\'s fail_when', () => {
  it('takes what shows, a text or an address, and keeps it on the step', () => {
    expect(parseBrowserActSteps([{ do: 'submit', ref: 'e5', fail_when: { shows: '.flash.error', text: 'invalid' } },
      { do: 'click', ref: 'e7', success_when: { url_includes: '/home' }, fail_when: { url_includes: '/login', seconds: 8 } },
      { do: 'wait', selector: '#results', fail_when: { text: 'No results' } }]))
      .toEqual({ ok: true, steps: [
        { do: 'submit', ref: 'e5', fail_when: { shows: '.flash.error', text: 'invalid' } },
        { do: 'click', ref: 'e7', success_when: { url_includes: '/home' }, fail_when: { url_includes: '/login', seconds: 8 } },
        { do: 'wait', selector: '#results', fail_when: { text: 'No results' } },
      ] });
  });

  it('checks it as strictly as success_when', () => {
    const on = (fail_when: unknown) => error([{ do: 'click', ref: 'e1', fail_when }]);
    expect(on({})).toBe('step 1: fail_when names a check: shows, text or url_includes');
    expect(on({ seconds: 3 })).toBe('step 1: fail_when names a check: shows, text or url_includes');
    expect(on({ gone: '.spinner' })).toBe('step 1: fail_when takes shows, text, url_includes, seconds, not gone');
    expect(on({ text: '' })).toBe('step 1: fail_when.text is text');
    expect(on({ shows: '.e', seconds: 11 })).toBe('step 1: fail_when.seconds is a number above 0, at most 10');
    expect(on('an error')).toBe('step 1: fail_when is an object');
  });

  it('needs something waiting while it is watched for', () => {
    // Typing alone waits for nothing; sending, or a success_when that waits, does.
    expect(error([{ do: 'type', ref: 'e1', value: 'x', fail_when: { text: 'taken' } }]))
      .toBe('step 1: typing alone waits for nothing, so its fail_when would never be checked: put it on the step that '
        + 'sends the form (submit: true), or on a click');
    expect(parseBrowserActSteps([{ do: 'type', ref: 'e1', value: 'x', submit: true, fail_when: { text: 'taken' } }]).ok).toBe(true);
    expect(parseBrowserActSteps([{ do: 'type', ref: 'e1', value: 'x', success_when: { shows: '.ok' },
      fail_when: { text: 'taken' } }]).ok).toBe(true);
    // A pause waits for nothing either; a wait watches its fail_when as long as itself.
    expect(error([{ do: 'wait', seconds: 2, fail_when: { text: 'error' } }, LOGIN[0]]))
      .toBe('step 1: fail_when needs something to wait for: give the wait a selector');
    expect(error([{ do: 'wait', selector: '#r', fail_when: { text: 'error', seconds: 3 } }, LOGIN[0]]))
      .toBe('step 1: a wait\'s fail_when watches as long as the wait: give the wait its seconds');
  });
});

describe('D-335 slices J and K — what a step costs the sequence', () => {
  // A wait alone is no sequence, so each goes before a click.
  const step = (raw: object): BrowserActStep => {
    const parsed = parseBrowserActSteps([raw, { do: 'click', ref: 'e9' }]);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.steps[0]!;
  };

  it('sends a form with the Bridge\'s submit: a submit step, or typing with submit', () => {
    expect(browserActStepSubmits(step({ do: 'submit', ref: 'e1' }))).toBe(true);
    expect(browserActStepSubmits(step({ do: 'type', ref: 'e1', value: 'x', submit: true }))).toBe(true);
    expect(browserActStepSubmits(step({ do: 'type', ref: 'e1', value: 'x' }))).toBe(false);
    expect(browserActStepSubmits(step({ do: 'click', ref: 'e1' }))).toBe(false);
  });

  it('runs its checks for success_when\'s seconds, else fail_when\'s, else five', () => {
    expect(browserActStepCheckSeconds(step({ do: 'click', ref: 'e1' }))).toBe(BROWSER_ACT_CHECK_SECONDS);
    expect(browserActStepCheckSeconds(step({ do: 'click', ref: 'e1', fail_when: { text: 'x', seconds: 7 } }))).toBe(7);
    expect(browserActStepCheckSeconds(step({ do: 'click', ref: 'e1', success_when: { shows: '#a', seconds: 3 },
      fail_when: { text: 'x', seconds: 7 } }))).toBe(3);
    expect(browserActStepCheckSeconds(step({ do: 'wait', selector: '#r', seconds: 4 }))).toBe(4);
  });

  it('watches for the page to move on only when its checks depend on it', () => {
    // A sent form is Recued's own check: the page moves on.
    expect(browserActStepWatchSeconds(step({ do: 'submit', ref: 'e1' }))).toBe(BROWSER_ACT_CHECK_SECONDS);
    expect(browserActStepWatchSeconds(step({ do: 'type', ref: 'e1', value: 'x', submit: true }))).toBe(BROWSER_ACT_CHECK_SECONDS);
    // Its success_when says what to look for instead, and how long.
    expect(browserActStepWatchSeconds(step({ do: 'submit', ref: 'e1', success_when: { shows: '.error' } }))).toBeUndefined();
    expect(browserActStepWatchSeconds(step({ do: 'submit', ref: 'e1', success_when: { page_changes: false, seconds: 2 } })))
      .toBe(2);
    expect(browserActStepWatchSeconds(step({ do: 'click', ref: 'e1', success_when: { url_includes: '/done', seconds: 8 } })))
      .toBe(8);
    expect(browserActStepWatchSeconds(step({ do: 'click', ref: 'e1' }))).toBeUndefined();
    expect(browserActStepWatchSeconds(step({ do: 'type', ref: 'e1', value: 'x' }))).toBeUndefined();
    // Slice K: a fail_when with nothing to wait for on the page watches for the failure meanwhile;
    // one beside a success_when that waits races it there instead.
    expect(browserActStepWatchSeconds(step({ do: 'click', ref: 'e1', fail_when: { shows: '.error', seconds: 6 } }))).toBe(6);
    expect(browserActStepWatchSeconds(step({ do: 'click', ref: 'e1', success_when: { shows: '#ok' },
      fail_when: { shows: '.error' } }))).toBeUndefined();
  });

  it('counts a wait, a watch and a check each, and a fail_when not at all', () => {
    expect(browserActStepWaitSeconds(step({ do: 'wait', seconds: 3 }))).toBe(3);
    expect(browserActStepWaitSeconds(step({ do: 'wait', selector: '#x' }))).toBe(BROWSER_ACT_CHECK_SECONDS);
    expect(browserActStepWaitSeconds(step({ do: 'wait', selector: '#x', fail_when: { text: 'no' } }))).toBe(BROWSER_ACT_CHECK_SECONDS);
    expect(browserActStepWaitSeconds(step({ do: 'click', ref: 'e1' }))).toBe(0);
    expect(browserActStepWaitSeconds(step({ do: 'submit', ref: 'e1' }))).toBe(BROWSER_ACT_CHECK_SECONDS);
    expect(browserActStepWaitSeconds(step({ do: 'submit', ref: 'e1', success_when: { shows: '#ok', seconds: 2 } }))).toBe(2);
    // Watching for the move, then for what shows: both.
    expect(browserActStepWaitSeconds(step({ do: 'click', ref: 'e1', success_when: { page_changes: true, shows: '#ok', seconds: 4 } })))
      .toBe(8);
    expect(browserActStepWaitSeconds(step({ do: 'click', ref: 'e1', fail_when: { url_includes: '/login' } })))
      .toBe(BROWSER_ACT_CHECK_SECONDS);
    expect(browserActStepWaitSeconds(step({ do: 'submit', ref: 'e1', success_when: { shows: '#ok', seconds: 2 },
      fail_when: { shows: '.error' } }))).toBe(2);
  });
});

describe('D-335 slice L — a typed field that picks its suggestion', () => {
  it('takes the suggestion to pick, by its text, on typing, and with a send after it', () => {
    expect(parseBrowserActSteps([{ do: 'type', ref: 'e3', value: 'Lond', pick: 'London, UK' }]))
      .toEqual({ ok: true, steps: [{ do: 'type', ref: 'e3', value: 'Lond', pick: 'London, UK' }] });
    expect(parseBrowserActSteps([{ do: 'type', ref: 'e3', value: 'Lond', pick: 'London, UK', submit: true }]))
      .toEqual({ ok: true, steps: [{ do: 'type', ref: 'e3', value: 'Lond', submit: true, pick: 'London, UK' }] });
    // Under the kind's other names too.
    expect(parseBrowserActSteps([{ action: 'type', ref: 'e3', value: 'Lond', pick: 'London, UK' }]).ok).toBe(true);
  });

  it('refuses a pick that is no text, one with nothing typed to show the suggestions, and one on another step', () => {
    expect(error([{ do: 'type', ref: 'e3', value: 'Lond', pick: '' }])).toBe('step 1: pick is the text of the suggestion to choose');
    expect(error([{ do: 'type', ref: 'e3', value: 'Lond', pick: 3 }])).toBe('step 1: pick is the text of the suggestion to choose');
    expect(error([{ do: 'type', ref: 'e3', value: 'Lond', pick: 'x'.repeat(201) }]))
      .toBe('step 1: pick is the text of the suggestion to choose');
    expect(error([{ do: 'type', ref: 'e3', value: ' ', pick: 'London, UK' }]))
      .toBe('step 1: pick needs something typed, which shows the suggestions');
    expect(error([{ do: 'click', ref: 'e3', pick: 'London, UK' }]))
      .toBe('step 1: a click step takes do, ref, selector, success_when, fail_when, not pick');
  });

  it('may load a new page, since a suggestion can be a link; typing alone and a wait cannot', () => {
    const one = (raw: object): BrowserActStep => {
      const parsed = parseBrowserActSteps([raw, { do: 'click', ref: 'e9' }]);
      if (!parsed.ok) throw new Error(parsed.error);
      return parsed.steps[0]!;
    };
    expect(browserActStepMayMove(one({ do: 'type', ref: 'e3', value: 'Lond', pick: 'London, UK' }))).toBe(true);
    expect(browserActStepMayMove(one({ do: 'type', ref: 'e3', value: 'Lond' }))).toBe(false);
    expect(browserActStepMayMove(one({ do: 'type', ref: 'e3', value: 'Lond', submit: true }))).toBe(true);
    expect(browserActStepMayMove(one({ do: 'click', ref: 'e3' }))).toBe(true);
    expect(browserActStepMayMove(one({ do: 'submit', ref: 'e3' }))).toBe(true);
    expect(browserActStepMayMove(one({ do: 'wait', seconds: 1 }))).toBe(false);
  });

  it('counts the wait for its suggestion toward the sequence\'s waiting', () => {
    const steps = (raw: object) => {
      const parsed = parseBrowserActSteps([raw]);
      if (!parsed.ok) throw new Error(parsed.error);
      return parsed.steps[0]!;
    };
    expect(browserActStepWaitSeconds(steps({ do: 'type', ref: 'e3', value: 'Lond', pick: 'London, UK' })))
      .toBe(BROWSER_ACT_PICK_SECONDS);
    // Then the send, watched as a send is.
    expect(browserActStepWaitSeconds(steps({ do: 'type', ref: 'e3', value: 'Lond', pick: 'London, UK', submit: true })))
      .toBe(BROWSER_ACT_PICK_SECONDS + BROWSER_ACT_CHECK_SECONDS);
    // Six picks are 30 seconds, the most a sequence may wait.
    const pick = { do: 'type', ref: 'e3', value: 'Lond', pick: 'London, UK' };
    expect(parseBrowserActSteps(Array.from({ length: 6 }, () => pick)).ok).toBe(true);
    expect(error(Array.from({ length: 7 }, () => pick)))
      .toBe(`the waits and checks add up to 35 seconds, and a sequence may wait at most ${BROWSER_ACT_MAX_TOTAL_WAIT_SECONDS}`);
  });
});
