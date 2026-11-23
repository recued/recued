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
  browserActStepWrites,
  browserActNamesTabs,
  browserActReadsOnly,
  browserActUploads,
  browserAddressesMatch,
  browserAddressKey,
  parseBrowserActSteps,
  type BrowserActStep,
} from '../browser-act.js';
import { parseBridgeKey } from '../bridge.js';

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
      .toBe('step 2: a click step takes do, ref, selector, text, role, within, success_when, fail_when, then_read, then_read_form, page, url, not value');
    expect(error([{ do: 'type', ref: 'e1', value: 'x', enter: true }]))
      .toBe('step 1: a type step takes do, ref, selector, text, role, within, value, secret, submit, pick, success_when, fail_when, then_read, then_read_form, page, url, not enter');
    // Slice K renamed `expect`; it was never released, so it is refused like any other key.
    expect(error([{ do: 'click', ref: 'e1', expect: { shows: '#x' } }]))
      .toBe('step 1: a click step takes do, ref, selector, text, role, within, success_when, fail_when, then_read, then_read_form, page, url, not expect');
    expect(error([{ do: 'click', ref: 'e1', success_when: { shows: '#x', waits: 3 } }]))
      .toBe('step 1: success_when takes page_changes, url_includes, shows, gone, text, seconds, not waits');
    // Slice U made press a kind, and slice X hover among others; a kind that is none is still
    // refused, naming the kinds.
    expect(error([{ do: 'drag', ref: 'e1' }]))
      .toBe('step 1: "do" is type, click, press, submit, wait, read, collect, data, table, ask, scroll, go, back, reload, close, hover, download or upload, not "drag"');
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
      .toBe('step 1: a click step takes do, ref, selector, text, role, within, success_when, fail_when, then_read, then_read_form, page, url, not type');
    // One that names no kind is no kind: the step has none (a live run keyed it by an address).
    expect(error([{ action: 'fill', ref: 'e1' }])).toBe(error([{ 'https://example.org/': 'type', ref: 'e1' }]));
    expect(error([{ action: 'fill', ref: 'e1' }]))
      .toBe('step 1 has no "do", which says what it does: type, click, press, submit, wait, read, collect, data, table, ask, scroll, go, back, reload, close, hover, download or upload, such as {"do":"click","ref":"e7"}');
  });

  it('names each element one way, by a ref or by a selector', () => {
    expect(error([{ do: 'click' }])).toBe('step 1: name the element by ref, by selector or by text, one of them');
    expect(error([{ do: 'click', ref: 'e1', selector: '#a' }])).toBe('step 1: name the element by ref, by selector or by text, one of them');
    expect(error([{ do: 'click', ref: '' }])).toBe('step 1: ref is a ref from the latest inspection, such as e12');
    expect(error([{ do: 'click', selector: '  ' }])).toBe('step 1: selector is a CSS selector');
  });

  it('bounds the count and the waiting', () => {
    expect(error([])).toBe('steps must be a list of at least one step');
    expect(error('type e1')).toBe('steps must be a list of at least one step');
    const many = Array.from({ length: BROWSER_ACT_MAX_STEPS + 1 }, () => ({ do: 'click', ref: 'e1' }));
    expect(error(many)).toBe(`at most ${BROWSER_ACT_MAX_STEPS} steps, and this has ${BROWSER_ACT_MAX_STEPS + 1}`);
    expect(parseBrowserActSteps(many.slice(1)).ok).toBe(true);
    // 2026-11-21 (D-402, task H) — one wait may take 30 seconds, as long as a whole sequence may wait.
    expect(error([{ do: 'wait', seconds: 31 }])).toBe('step 1: seconds is a number above 0, at most 30');
    expect(error([{ do: 'wait', seconds: 0 }])).toBe('step 1: seconds is a number above 0, at most 30');
    expect(parseBrowserActSteps([{ do: 'wait', selector: '.quote', seconds: 30 }, { do: 'read' }]).ok).toBe(true);
    // Four pauses of 10 seconds are 40, over the 30 a sequence may wait.
    const pauses = [LOGIN[0], ...Array.from({ length: 4 }, () => ({ do: 'wait', seconds: 10 }))];
    expect(error(pauses)).toBe(`the waits and checks add up to 40 seconds, and a sequence may wait at most ${BROWSER_ACT_MAX_TOTAL_WAIT_SECONDS}`);
    expect(parseBrowserActSteps(pauses.slice(0, 4)).ok).toBe(true);
  });

  it('needs a step that does something, and a wait that waits for something', () => {
    expect(error([{ do: 'click', ref: 'e1' }, { do: 'wait', gone: '.loading', seconds: 10 }, { do: 'read' }]))
      .toContain('"selector":"<observed selector>","until":"gone"');
    expect(error([{ do: 'wait', seconds: 2 }])).toBe('a sequence needs a step that does more than wait');
    expect(error([{ do: 'wait' }])).toBe('step 1: a wait takes seconds, a selector to wait for, or url_includes');
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
    expect(on({ shows: '.e', seconds: 31 })).toBe('step 1: fail_when.seconds is a number above 0, at most 30');
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
      .toBe('step 1: a click step takes do, ref, selector, text, role, within, success_when, fail_when, then_read, then_read_form, page, url, not pick');
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

// D-335 slice U — a key pressed in an element: a step of a sequence, read as the Bridge reads it.
describe('D-335 slice U — keys', () => {
  it('reads a key as the page hears it, with its modifiers, and writes it back one way', () => {
    expect(parseBridgeKey('Enter')).toEqual({ name: 'Enter', key: 'Enter', code: 'Enter', keyCode: 13, ctrlKey: false,
      metaKey: false, altKey: false, shiftKey: false });
    expect(parseBridgeKey(' ctrl + enter ')).toMatchObject({ name: 'Control+Enter', key: 'Enter', ctrlKey: true });
    expect(parseBridgeKey('Shift+Tab')).toMatchObject({ name: 'Shift+Tab', key: 'Tab', shiftKey: true });
    expect(parseBridgeKey('cmd+K')).toMatchObject({ name: 'Meta+k', key: 'k', code: 'KeyK', keyCode: 75, metaKey: true });
    expect(parseBridgeKey('Shift+a')).toMatchObject({ name: 'Shift+a', key: 'A', code: 'KeyA' });
    expect(parseBridgeKey('esc')).toMatchObject({ name: 'Escape', key: 'Escape', keyCode: 27 });
    expect(parseBridgeKey('space')).toMatchObject({ name: 'Space', key: ' ', code: 'Space', keyCode: 32 });
    expect(parseBridgeKey('down')).toMatchObject({ name: 'ArrowDown', code: 'ArrowDown', keyCode: 40 });
    expect(parseBridgeKey('F12')).toMatchObject({ name: 'F12', keyCode: 123 });
    expect(parseBridgeKey('7')).toMatchObject({ name: '7', code: 'Digit7', keyCode: 55 });
    expect(parseBridgeKey('/')).toMatchObject({ name: '/', code: 'Slash', keyCode: 191 });
    expect(parseBridgeKey('\\')).toMatchObject({ name: '\\', code: 'Backslash', keyCode: 220 });
  });

  it('refuses anything else: an unknown key or modifier, a modifier twice, a plus with nothing after it', () => {
    for (const bad of ['', 'Hyper+a', 'Control+Control+a', 'Control++', 'Enter+', '+', 'F13', 'ab', '?', 'Return', 42, null]) {
      expect(parseBridgeKey(bad), String(bad)).toBeNull();
    }
  });

  it('takes a press step with its key, written back as read, and refuses a key it does not know', () => {
    const parsed = parseBrowserActSteps([{ do: 'press', ref: 'e3', key: 'control+enter', success_when: { shows: '.sent' } }]);
    expect(parsed).toEqual({ ok: true, steps: [{ do: 'press', ref: 'e3', key: 'Control+Enter', success_when: { shows: '.sent' } }] });
    expect(parseBrowserActSteps([{ do: 'press', ref: 'e3', key: 'Hyper+a' }])).toEqual({ ok: false,
      error: 'step 1: key is a key to press, such as Enter, Escape, Tab, ArrowDown, a letter or a digit, after any of Control, '
        + 'Meta, Alt and Shift joined with + (Control+Enter)' });
    expect(parseBrowserActSteps([{ do: 'press', ref: 'e3', key: 'Enter', value: 'x' }])).toEqual({ ok: false,
      error: 'step 1: a press step takes do, ref, selector, text, role, key, success_when, fail_when, then_read, then_read_form, page, url, not value' });
    // A key may load a new page, as a click may.
    if (!parsed.ok) throw new Error(parsed.error);
    const step = parsed.steps[0]!;
    expect(browserActStepMayMove(step)).toBe(true);
    expect(browserActStepSubmits(step)).toBe(false);
  });
});

describe('D-335 slice X — one batch across tabs, reading as it goes', () => {
  const steps = (raw: unknown[]): readonly BrowserActStep[] => {
    const parsed = parseBrowserActSteps(raw);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.steps;
  };

  it('a step names its tab by handle or by address, never both, and the address is http or https', () => {
    expect(steps([
      { url: ' https://en.wikipedia.org/wiki/Python_(programming_language) ', do: 'read' },
      { page: '12:ABC', do: 'click', ref: 'e3' },
      { do: 'read', form: 'text', find: 'See also' },
    ])).toEqual([
      // The address is kept as given, trimmed: the tab it names is matched by its key.
      { url: 'https://en.wikipedia.org/wiki/Python_(programming_language)', do: 'read' },
      { page: '12:ABC', do: 'click', ref: 'e3' },
      { do: 'read', form: 'text', find: 'See also' },
    ]);
    expect(error([{ page: '1:A', url: 'https://a.example', do: 'read' }])).toBe('step 1: name its tab by page or by url, not both');
    expect(error([{ url: 'ftp://a.example/x', do: 'read' }])).toBe('step 1: url is the http or https address of the page the step runs on');
    expect(error([{ url: 'the wikipedia tab', do: 'read' }])).toBe('step 1: url is the http or https address of the page the step runs on');
    expect(error([{ page: 7, do: 'read' }])).toBe('step 1: page is a page handle, such as one List browser tabs answered');
  });

  it('a read is an outline or the text, a part or one section, and refuses what Inspect a web page refuses', () => {
    expect(steps([{ do: 'read', from: 213, chars: 4000 }])).toEqual([{ do: 'read', from: 213, chars: 4000 }]);
    expect(error([{ do: 'read', form: 'html' }])).toContain('form is outline (the default) or text');
    expect(error([{ do: 'read', form: 'entries' }])).toContain('"data_format":"entries"');
    expect(parseBrowserActSteps([{ do: 'read', data_format: 'entries' }])).toMatchObject({ ok: true });
    expect(error([{ do: 'read', find: 'History', from: 3 }])).toBe('step 1: give one of find and from');
    expect(error([{ do: 'read', find: 'History', chars: 3000 }]))
      .toBe('step 1: chars sizes a part of the page, and find answers its sections: give one of the two');
    expect(error([{ do: 'read', chars: 60_001 }])).toBe('step 1: chars is how many characters the part holds, at most 60000');
    expect(error([{ do: 'read', from: '213' }])).toBe('step 1: from is a line number, such as 213');
    expect(steps([{ do: 'read', selector: ' main ', form: 'outline', from: 2 }, { do: 'read', ref: 'e12', form: 'text' }]))
      .toEqual([{ do: 'read', selector: 'main', form: 'outline', from: 2 }, { do: 'read', ref: 'e12', form: 'text' }]);
    expect(error([{ do: 'read', selector: 'main', ref: 'e12' }])).toContain('give one of ref and selector');
    expect(error([{ do: 'read', ref: 'e12', find: 'History' }])).toContain('omit find');
    expect(error([{ do: 'read', ref: 'e0' }])).toContain('observed element reference');
    expect(error([{ do: 'read', selector: '' }])).toContain('observed CSS selector');
    expect(error([{ do: 'read', selector: 'x'.repeat(1001) }])).toContain('observed CSS selector');
  });

  it('scrolls the page or a panel, goes to an http address only, and points at an element it names', () => {
    expect(steps([
      { do: 'scroll' }, { do: 'scroll', to: 'bottom', selector: '#feed' }, { do: 'scroll', screen: 3 },
      { do: 'go', address: 'https://example.com/next' }, { do: 'back' }, { do: 'reload' }, { do: 'close' },
      { do: 'hover', ref: 'e9' },
    ]).map((step) => step.do)).toEqual(['scroll', 'scroll', 'scroll', 'go', 'back', 'reload', 'close', 'hover']);
    expect(error([{ do: 'scroll', to: 'down' }])).toBe('step 1: to is next (the default), previous, top or bottom');
    expect(error([{ do: 'scroll', to: 'top', screen: 2 }])).toBe('step 1: give one of to and screen');
    expect(error([{ do: 'go', address: 'javascript:alert(1)' }])).toBe('step 1: address is the http or https address to load in the tab');
    expect(error([{ do: 'go', address: 'https://me:secret@example.com/' }]))
      .toBe('step 1: address is the http or https address to load in the tab');
    expect(error([{ do: 'hover' }])).toBe('step 1: name the element by ref, by selector or by text, one of them');
    expect(error([{ do: 'back', ref: 'e1' }])).toBe('step 1: a back step takes do, then_read, then_read_form, page, url, not ref');
  });

  it('a wait for an address, which is no wait for a selector too', () => {
    expect(steps([{ do: 'wait', url_includes: '/inbox', seconds: 8 }, { do: 'read' }]))
      .toEqual([{ do: 'wait', url_includes: '/inbox', seconds: 8 }, { do: 'read' }]);
    expect(error([{ do: 'wait', url_includes: '/inbox', selector: '#x' }]))
      .toBe('step 1: a wait waits for a selector or for url_includes, not both');
    expect(error([{ do: 'wait' }])).toBe('step 1: a wait takes seconds, a selector to wait for, or url_includes');
  });

  it('what changes something, what may move the tab, and a batch that only reads', () => {
    const all = steps([
      { do: 'read' }, { do: 'scroll' }, { do: 'wait', seconds: 1 }, { do: 'hover', ref: 'e1' },
      { do: 'type', ref: 'e2', value: 'x' }, { do: 'click', ref: 'e3' }, { do: 'press', ref: 'e2', key: 'Enter' },
      { do: 'submit', ref: 'e2' }, { do: 'go', address: 'https://a.example/' }, { do: 'back' }, { do: 'reload' }, { do: 'close' },
    ]);
    expect(all.map((step) => [step.do, browserActStepWrites(step), browserActStepMayMove(step)])).toEqual([
      ['read', false, false], ['scroll', false, false], ['wait', false, false], ['hover', false, false],
      ['type', true, false], ['click', true, true], ['press', true, true], ['submit', true, true],
      ['go', true, true], ['back', true, true], ['reload', true, true], ['close', true, true]]);
    expect(browserActReadsOnly(all.slice(0, 4))).toBe(true);
    expect(browserActReadsOnly(all.slice(0, 5))).toBe(false);
    expect(browserActNamesTabs(all)).toBe(false);
    expect(browserActNamesTabs(steps([{ do: 'read', url: 'https://a.example/' }]))).toBe(true);
    // Reading, moving and pointing cost the sequence's thirty seconds of waiting nothing; a click and a
    // key with no checks are counted as they always were (none), a sent form its watch.
    expect(all.map(browserActStepWaitSeconds)).toEqual([0, 0, 1, 0, 0, 0, 0, 5, 0, 0, 0, 0]);
  });

  it('a batch of twenty reads across tabs parses, and a batch that only waits does not', () => {
    const reads = Array.from({ length: BROWSER_ACT_MAX_STEPS }, (_, i) => ({ do: 'read', url: `https://site${i}.example/` }));
    expect(steps(reads)).toHaveLength(BROWSER_ACT_MAX_STEPS);
    expect(error([...reads, { do: 'read' }])).toBe(`at most ${BROWSER_ACT_MAX_STEPS} steps, and this has ${BROWSER_ACT_MAX_STEPS + 1}`);
    expect(error([{ do: 'wait', seconds: 1 }])).toBe('a sequence needs a step that does more than wait');
  });

  it('an address names a tab by host without www., path without a trailing slash, its escapes undone, and query', () => {
    const same = [
      ['https://news.ycombinator.com', 'https://news.ycombinator.com/'],
      ['http://news.ycombinator.com/', 'https://news.ycombinator.com/'],
      ['https://www.example.com/a/', 'https://example.com/a'],
      ['https://EN.wikipedia.org/wiki/Ada_Lovelace#Work', 'https://en.wikipedia.org/wiki/Ada_Lovelace'],
      ['https://en.wikipedia.org/wiki/Python_%28programming_language%29', 'https://en.wikipedia.org/wiki/Python_(programming_language)'],
      ['https://example.com:443/x', 'https://example.com/x'],
    ];
    for (const [a, b] of same) expect(browserAddressesMatch(a!, b!), `${a} = ${b}`).toBe(true);
    const different = [
      ['https://example.com/a', 'https://example.com/ab'],
      ['https://example.com/a?q=1', 'https://example.com/a?q=2'],
      ['https://example.com/a', 'https://example.org/a'],
      ['https://example.com:8443/a', 'https://example.com/a'],
      ['https://mail.example.com/', 'https://example.com/'],
    ];
    for (const [a, b] of different) expect(browserAddressesMatch(a!, b!), `${a} ≠ ${b}`).toBe(false);
    expect(browserAddressKey('file:///etc/hosts')).toBeUndefined();
    expect(browserAddressesMatch('not an address', 'not an address')).toBe(false);
  });
});

describe('D-335 slice Y — an element named by its text', () => {
  it('takes text in place of a ref or a selector, on every step that names an element, with a role, both trimmed', () => {
    expect(parseBrowserActSteps([
      { do: 'click', text: ' Sign in ', role: ' button ' },
      { do: 'type', text: 'Search Wikipedia', value: 'Ada' },
      { do: 'press', text: 'Search Wikipedia', key: 'Enter' },
      { do: 'submit', text: 'Search Wikipedia' },
      { do: 'hover', text: 'Tools' },
      { do: 'scroll', text: 'Comments', to: 'bottom' },
    ])).toEqual({ ok: true, steps: [
      { do: 'click', text: 'Sign in', role: 'button' },
      { do: 'type', text: 'Search Wikipedia', value: 'Ada' },
      { do: 'press', text: 'Search Wikipedia', key: 'Enter' },
      { do: 'submit', text: 'Search Wikipedia' },
      { do: 'hover', text: 'Tools' },
      { do: 'scroll', text: 'Comments', to: 'bottom' },
    ] });
  });

  it('refuses two ways of naming one element, a role without a text, and a text or a role that is no text', () => {
    const one = 'step 1: name the element by ref, by selector or by text, one of them';
    expect(error([{ do: 'click', text: 'Sign in', ref: 'e1' }])).toBe(one);
    expect(error([{ do: 'click', text: 'Sign in', selector: '#a' }])).toBe(one);
    const role = 'step 1: role narrows an element named by text, such as "button", "link" or "field"';
    expect(error([{ do: 'click', ref: 'e1', role: 'button' }])).toBe(role);
    expect(error([{ do: 'click', text: 'Sign in', role: 'x'.repeat(41) }])).toBe(role);
    const text = 'step 1: text is what the element shows or is called on the page, such as "Sign in"';
    expect(error([{ do: 'click', text: '   ' }])).toBe(text);
    expect(error([{ do: 'click', text: 'x'.repeat(201) }])).toBe(text);
    expect(error([{ do: 'click', text: 3 }])).toBe(text);
  });

  it('a wait\'s text is still the text it waits for, never an element', () => {
    expect(parseBrowserActSteps([{ do: 'wait', selector: '#status', text: 'Saved' }])).toEqual({ ok: false,
      error: 'a sequence needs a step that does more than wait' });
    const parsed = parseBrowserActSteps([{ do: 'click', text: 'Save' }, { do: 'wait', selector: '#status', text: 'Saved' }]);
    expect(parsed.ok && parsed.steps[1]).toMatchObject({ do: 'wait', selector: '#status', text: 'Saved' });
    expect(error([{ do: 'click', text: 'Save' }, { do: 'wait', text: 'Saved', role: 'button' }]))
      .toBe('step 2: a wait step takes do, seconds, selector, until, text, url_includes, fail_when, page, url, not role');
  });
});

describe('D-335 slice Z — a secret the model never holds', () => {
  it('a type step names the kind of secret in place of the value, case aside, and sends it as asked', () => {
    expect(parseBrowserActSteps([
      { do: 'type', text: 'Password', secret: 'Password' },
      { do: 'type', text: 'Code', secret: ' sign-in code ', submit: true },
      { do: 'type', ref: 'e4', secret: 'pin' },
    ])).toEqual({ ok: true, steps: [
      { do: 'type', text: 'Password', secret: 'password' },
      { do: 'type', text: 'Code', secret: 'sign-in code', submit: true },
      { do: 'type', ref: 'e4', secret: 'PIN' },
    ] });
  });

  it('refuses a value beside it, a pick, and any word that is not a kind, so the secret itself is never taken', () => {
    expect(error([{ do: 'type', ref: 'e3', secret: 'password', value: 'hunter2' }]))
      .toBe('step 1: give value, the text to type, or secret, what kind of secret it is, not both');
    const kinds = 'step 1: secret is the kind of secret the field takes: "password", "PIN", "sign-in code"; never the secret itself';
    expect(error([{ do: 'type', ref: 'e3', secret: 'hunter2' }])).toBe(kinds);
    expect(error([{ do: 'type', ref: 'e3', secret: 3 }])).toBe(kinds);
    expect(error([{ do: 'type', ref: 'e3', secret: 'password', pick: 'x' }])).toBe('step 1: a secret is typed, never picked from suggestions');
    expect(error([{ do: 'click', ref: 'e3', secret: 'password' }]))
      .toBe('step 1: a click step takes do, ref, selector, text, role, within, success_when, fail_when, then_read, then_read_form, page, url, not secret');
  });
});

describe('D-335 slice AC — then_read: the part of the page an action\'s result shows in', () => {
  it('an action takes it, trimmed, and it costs the sequence a check\'s wait', () => {
    const parsed = parseBrowserActSteps([
      { do: 'click', text: 'Reviews', then_read: ' #reviews ' },
      { do: 'type', ref: 'e3', value: 'Ada Lovelace', submit: true, then_read: '#firstHeading' },
      { do: 'go', address: 'https://en.wikipedia.org/wiki/Ada_Lovelace', then_read: '.infobox-caption' },
      { do: 'hover', ref: 'e9', then_read: '[role=menu]' },
      { do: 'back', then_read: 'main' },
    ]);
    if (!parsed.ok) throw new Error(parsed.error);
    const steps = parsed.steps;
    expect(steps.map((step) => ('then_read' in step ? step.then_read : undefined)))
      .toEqual(['#reviews', '#firstHeading', '.infobox-caption', '[role=menu]', 'main']);
    // Waited for once the step is done, as a check is.
    expect(browserActStepWaitSeconds(steps[0]!)).toBe(browserActStepWaitSeconds({ do: 'click', text: 'Reviews' }) + BROWSER_ACT_CHECK_SECONDS);
    expect(browserActStepWaitSeconds(steps[2]!)).toBe(BROWSER_ACT_CHECK_SECONDS);
    // Seven reads after their steps wait 35 s, more than a sequence may.
    const many = Array.from({ length: 7 }, () => ({ do: 'go', address: 'https://example.org/', then_read: 'main' }));
    expect(parseBrowserActSteps(many)).toEqual({ ok: false,
      error: `the waits and checks add up to 35 seconds, and a sequence may wait at most ${BROWSER_ACT_MAX_TOTAL_WAIT_SECONDS}` });
  });

  it('a step that reads, waits, scrolls or closes the tab takes none, and it is a CSS selector', () => {
    const error = (steps: unknown[]) => (parseBrowserActSteps(steps) as { error?: string }).error;
    expect(error([{ do: 'read', then_read: 'main' }])).toBe('step 1: a read step takes do, form, data_format, find, from, chars, ref, selector, page, url, not then_read');
    expect(error([{ do: 'close', then_read: 'main' }])).toBe('step 1: a close step takes do, page, url, not then_read');
    expect(error([{ do: 'click', ref: 'e1', then_read: '' }]))
      .toContain('then_read is a CSS selector observed on the page');
    const refused = error([{ do: 'submit', ref: 'e1', then_read_form: 'text' }]);
    expect(refused).toContain('remove then_read_form and add a separate {"do":"read","form":"text"} step');
    expect(parseBrowserActSteps([{ do: 'submit', ref: 'e1' }, { do: 'read', form: 'text' }])).toMatchObject({ ok: true });
  });
});

describe('D-335 slice AD — ask: a question for a tab, answered from its text', () => {
  it('takes a question, trimmed, and a line to ask on from, on the tab it names', () => {
    const parsed = parseBrowserActSteps([
      { url: 'https://en.wikipedia.org/wiki/Go_(programming_language)', do: 'ask', question: ' Who designed it? ' },
      { page: '7:DOC', do: 'ask', question: 'When did it first appear?', from: 413 },
    ]);
    expect(parsed).toEqual({ ok: true, steps: [
      { url: 'https://en.wikipedia.org/wiki/Go_(programming_language)', do: 'ask', question: 'Who designed it?' },
      { page: '7:DOC', do: 'ask', question: 'When did it first appear?', from: 413 },
    ] });
  });

  it('changes nothing and moves nothing: a batch of reads and asks asks the owner nothing', () => {
    const ask: BrowserActStep = { do: 'ask', question: 'Who designed it?' };
    expect(browserActStepWrites(ask)).toBe(false);
    expect(browserActStepMayMove(ask)).toBe(false);
    expect(browserActStepWaitSeconds(ask)).toBe(0);
    expect(browserActReadsOnly([{ do: 'read' }, ask])).toBe(true);
  });

  it('refuses no question, a question past 500 characters, a bad from, and an element', () => {
    const error = (steps: unknown[]) => (parseBrowserActSteps(steps) as { error?: string }).error;
    const said = 'step 1: question is what to find out from the page, in a sentence of at most 500 characters';
    expect(error([{ do: 'ask' }])).toBe(said);
    expect(error([{ do: 'ask', question: 'x'.repeat(501) }])).toBe(said);
    expect(error([{ do: 'ask', question: 'Who?', from: 0 }])).toBe('step 1: from is a line number to ask on from, such as 413');
    expect(error([{ do: 'ask', question: 'Who?', ref: 'e1' }])).toBe('step 1: a ask step takes do, question, from, page, url, not ref');
  });
});

describe('D-335 slice AE — the steps the model wrote in E that needed one more round', () => {
  const ADA = 'https://en.wikipedia.org/wiki/Ada_Lovelace';
  const steps = (raw: unknown[], call?: { page?: unknown }) => {
    const parsed = parseBrowserActSteps(raw, call);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.steps;
  };

  it('a page that is an address names the tab showing it, as url does; a handle stays a handle', () => {
    expect(steps([{ do: 'ask', page: ` ${ADA} `, question: 'Who was she?' }]))
      .toEqual([{ url: ADA, do: 'ask', question: 'Who was she?' }]);
    expect(steps([{ do: 'read', page: '7:DOC1' }])).toEqual([{ page: '7:DOC1', do: 'read' }]);
    expect(parseBrowserActSteps([{ do: 'read', page: ADA, url: ADA }]))
      .toEqual({ ok: false, error: 'step 1: name its tab by page or by url, not both' });
  });

  it('a first go naming no tab, with no handle for the call, is on the tab showing its address', () => {
    expect(steps([{ do: 'go', address: ADA }, { do: 'ask', question: 'What does the caption say?' }], {}))
      .toEqual([{ url: ADA, do: 'go', address: ADA }, { do: 'ask', question: 'What does the caption say?' }]);
    // A handle for the call: the go loads the address in that tab, as before.
    expect(steps([{ do: 'go', address: ADA }], { page: '7:DOC1' })).toEqual([{ do: 'go', address: ADA }]);
    // A caller that does not say what the call names reads the steps as before.
    expect(steps([{ do: 'go', address: ADA }])).toEqual([{ do: 'go', address: ADA }]);
    // An address for the call names the first step's tab.
    expect(steps([{ do: 'read' }], { page: ADA })).toEqual([{ url: ADA, do: 'read' }]);
    // A go to no web address is refused for what it is.
    expect(parseBrowserActSteps([{ do: 'go', address: 'ftp://x.org/a' }], {}))
      .toEqual({ ok: false, error: 'step 1: address is the http or https address to load in the tab' });
  });

  it('a key with no element is pressed in the field the step before typed into, on that tab', () => {
    expect(steps([{ do: 'type', text: 'Search Wikipedia', value: 'Ada Lovelace' }, { do: 'press', key: 'Enter' }]))
      .toEqual([{ do: 'type', text: 'Search Wikipedia', value: 'Ada Lovelace' },
        { do: 'press', text: 'Search Wikipedia', key: 'Enter' }]);
    expect(steps([{ do: 'type', ref: 'e4', value: 'Ada' }, { do: 'press', key: 'Enter' }])[1]).toEqual({ do: 'press', ref: 'e4', key: 'Enter' });
    const said = 'step 2: name the element by ref, by selector or by text, one of them (a key with none is pressed in the field '
      + 'the step before typed into)';
    // Not after typing that sent its form or picked a suggestion (the page may have moved), a click, or on another tab.
    expect(parseBrowserActSteps([{ do: 'type', ref: 'e4', value: 'Ada', submit: true }, { do: 'press', key: 'Enter' }]))
      .toEqual({ ok: false, error: said });
    expect(parseBrowserActSteps([{ do: 'click', ref: 'e4' }, { do: 'press', key: 'Enter' }])).toEqual({ ok: false, error: said });
    expect(parseBrowserActSteps([{ do: 'type', ref: 'e4', value: 'Ada' }, { url: ADA, do: 'press', key: 'Enter' }]))
      .toEqual({ ok: false, error: said });
  });
});

// D-335 slice AP (2026-11-07) — a file the page links to, saved among the owner's files: the link by
// ref, selector or text, or the file's address. The owner: "for #4 and #5 it should be generic".
describe('D-335 slice AP — a download step', () => {
  it('takes the link by ref, selector or text, or the file\'s address, and changes nothing on the page', () => {
    const parsed = parseBrowserActSteps([{ do: 'download', ref: 'e12' }, { do: 'download', text: 'Annual report', role: 'link' },
      { do: 'download', selector: 'a[href$=".pdf"]' }, { do: 'download', address: 'https://example.com/files/report.pdf' }],
    { page: '7:DOC1' });
    expect(parsed).toEqual({ ok: true, steps: [{ do: 'download', ref: 'e12' }, { do: 'download', text: 'Annual report', role: 'link' },
      { do: 'download', selector: 'a[href$=".pdf"]' }, { do: 'download', address: 'https://example.com/files/report.pdf' }] });
    if (!parsed.ok) return;
    for (const step of parsed.steps) {
      expect(browserActStepWrites(step)).toBe(false);
      expect(browserActStepMayMove(step)).toBe(false);
      expect(browserActStepWaitSeconds(step)).toBe(0);
    }
    // A batch that reads and saves files asks the owner nothing.
    expect(browserActReadsOnly([...parsed.steps, { do: 'read' }])).toBe(true);
  });

  it('refuses a link and an address together, neither, an address that is not a web one, and keys it does not take', () => {
    const at = (step: Record<string, unknown>) => parseBrowserActSteps([step], { page: '7:DOC1' });
    expect(at({ do: 'download', ref: 'e12', address: 'https://example.com/a.pdf' })).toEqual({ ok: false,
      error: 'step 1: name the link by ref, by selector or by text, or give the file\'s address, one of them' });
    expect(at({ do: 'download' })).toEqual({ ok: false,
      error: 'step 1: name the link by ref, by selector or by text, or give the file\'s address, one of them' });
    expect(at({ do: 'download', address: 'ftp://example.com/a.pdf' })).toEqual({ ok: false,
      error: 'step 1: address is the http or https address of the file to save' });
    expect(at({ do: 'download', ref: 'e12', then_read: '#x' })).toMatchObject({ ok: false,
      error: expect.stringMatching(/^step 1: a download step takes do, ref, selector, text, role, address, page, url, not then_read$/) });
  });
});

// D-335 slice AQ (2026-11-07) — one of the owner's files into a page's file field, always asked about.
describe('D-335 slice AQ — an upload step', () => {
  const REF = `file:${'c'.repeat(32)}`;
  it('takes the field by ref, selector or text and the file by its ref; it changes the page and is always asked about', () => {
    const parsed = parseBrowserActSteps([{ do: 'upload', ref: 'e7', file: REF }, { do: 'upload', text: 'Choose file', file: ` ${REF} ` }],
      { page: '7:DOC1' });
    expect(parsed).toEqual({ ok: true, steps: [{ do: 'upload', ref: 'e7', file: REF }, { do: 'upload', text: 'Choose file', file: REF }] });
    if (!parsed.ok) return;
    expect(browserActStepWrites(parsed.steps[0]!)).toBe(true);
    expect(browserActStepMayMove(parsed.steps[0]!)).toBe(false);
    expect(browserActUploads(parsed.steps)).toBe(true);
    expect(browserActUploads([{ do: 'click', ref: 'e1' }])).toBe(false);
  });

  it('refuses no field, and a file that is not the ref of one of the user\'s files', () => {
    expect(parseBrowserActSteps([{ do: 'upload', file: REF }])).toMatchObject({ ok: false,
      error: expect.stringMatching(/^step 1: name the element by ref, by selector or by text, one of them/) });
    for (const file of [undefined, '/Users/ada/october.pdf', 'file:xyz', `${REF}0`]) {
      expect(parseBrowserActSteps([{ do: 'upload', ref: 'e7', ...(file !== undefined ? { file } : {}) }])).toEqual({ ok: false,
        error: expect.stringContaining('malformed upload file reference') });
    }
  });
});

// D-347 follow-up (2026-11-08) — a wait for the page to move on, written after the step that moves it, is
// that step's check: the model wrote `{"do":"wait","page_changes":true}` in 2 of 24 runs of the head to
// head with browser-use (tasks C and G), each refused at the cost of a round.
describe('a wait written with page_changes', () => {
  const steps = (raw: unknown): readonly BrowserActStep[] => {
    const parsed = parseBrowserActSteps(raw);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.steps;
  };

  it('is the check of the click before it, as task C wrote it', () => {
    expect(steps([{ do: 'type', ref: 'e4', value: 'Ada Lovelace' }, { do: 'click', ref: 'e5' }, { do: 'wait', page_changes: true },
      { do: 'read' }])).toEqual([{ do: 'type', ref: 'e4', value: 'Ada Lovelace' },
      { do: 'click', ref: 'e5', success_when: { page_changes: true } }, { do: 'read' }]);
  });

  it('takes the wait\'s seconds, and the watch counts toward the sequence\'s waiting', () => {
    const [click] = steps([{ do: 'click', ref: 'e5' }, { do: 'wait', page_changes: true, seconds: 8 }]);
    expect(click).toEqual({ do: 'click', ref: 'e5', success_when: { page_changes: true, seconds: 8 } });
    expect(browserActStepWatchSeconds(click!)).toBe(8);
    // Four clicks, each watching 8 s for the page: 32 s, over a sequence's 30.
    const four = [0, 1, 2, 3].flatMap((i) => [{ do: 'click', ref: `e${i}` }, { do: 'wait', page_changes: true, seconds: 8 }]);
    expect(error(four)).toBe(`the waits and checks add up to 32 seconds, and a sequence may wait at most ${BROWSER_ACT_MAX_TOTAL_WAIT_SECONDS}`);
  });

  it('follows a press, a sent form or typing sent with submit, on the same tab', () => {
    expect(steps([{ do: 'press', ref: 'e1', key: 'Enter' }, { do: 'wait', page_changes: true }])[0])
      .toMatchObject({ do: 'press', success_when: { page_changes: true } });
    expect(steps([{ do: 'submit', ref: 'e1' }, { do: 'wait', page_changes: true }])[0])
      .toMatchObject({ do: 'submit', success_when: { page_changes: true } });
    expect(steps([{ do: 'type', ref: 'e1', value: 'x', submit: true }, { do: 'wait', page_changes: true }])[0])
      .toMatchObject({ do: 'type', submit: true, success_when: { page_changes: true } });
    expect(steps([{ do: 'click', ref: 'e1', page: 'p1' }, { do: 'wait', page_changes: true, page: 'p1' }]))
      .toEqual([{ do: 'click', ref: 'e1', page: 'p1', success_when: { page_changes: true } }]);
  });

  it('is refused anywhere else, saying where page_changes goes', () => {
    const where = (n: number) => `step ${n}: page_changes is checked on the step that moves the page, not on a wait: `
      + 'give that click, press or sent form "success_when":{"page_changes":true}';
    expect(error([{ do: 'wait', page_changes: true }, { do: 'read' }])).toBe(where(1));
    expect(error([{ do: 'read' }, { do: 'wait', page_changes: true }])).toBe(where(2));
    expect(error([{ do: 'type', ref: 'e1', value: 'x' }, { do: 'wait', page_changes: true }])).toBe(where(2));
    expect(error([{ do: 'click', ref: 'e1', success_when: { shows: '.done' } }, { do: 'wait', page_changes: true }])).toBe(where(2));
    expect(error([{ do: 'click', ref: 'e1' }, { do: 'wait', page_changes: false }])).toBe(where(2));
    expect(error([{ do: 'click', ref: 'e1' }, { do: 'wait', page_changes: true, selector: '#results' }])).toBe(where(2));
    expect(error([{ do: 'click', ref: 'e1' }, { do: 'wait', page_changes: true, seconds: 0 }])).toBe(where(2));
    expect(error([{ do: 'click', ref: 'e1', page: 'p1' }, { do: 'wait', page_changes: true, page: 'p2' }])).toBe(where(2));
  });
});

it('reports independent type-target and input failures together without exposing field values', () => {
  const raw = [{ do: 'click', ref: 'e7' },
    { do: 'type', secret: 'password', value: 'secret-must-not-echo' },
    { do: 'type', text: 'Email' }];
  const original = JSON.stringify(raw), result = parseBrowserActSteps(raw);
  expect(result).toMatchObject({ ok: false, error: 'step 2: name the element by ref, by selector or by text, one of them',
    violations: [
      { path: 'steps[1]', code: 'required' },
      { path: 'steps[1].value', code: 'invalid_value' },
      { path: 'steps[2].value', code: 'required' },
    ] });
  expect(JSON.stringify(result)).not.toContain('secret-must-not-echo');
  expect(JSON.stringify(raw)).toBe(original);
  expect(parseBrowserActSteps([{ do: 'type', ref: 'e24', secret: 'password' }])).toMatchObject({ ok: true });
  expect(parseBrowserActSteps([{ do: 'type', selector: '#search', value: '' }, { do: 'press', key: 'Enter' }]))
    .toMatchObject({ ok: true, steps: [{ do: 'type', value: '' }, { do: 'press', selector: '#search' }] });
  expect(error([{ do: 'type', text: 'Email', value: 'Ada' }, { do: 'press', key: 'Enter', role: 'x'.repeat(41) }]))
    .toContain('role narrows an element named by text');
});

it('bounds multiple form errors while retaining an earlier unrelated refusal', () => {
  const result = parseBrowserActSteps([{ do: 'close', value: 'not-allowed' },
    ...Array.from({ length: 19 }, () => ({ do: 'type', secret: 'not-a-secret-kind', value: 'secret-must-not-echo', submit: 'yes' }))]);
  expect(result.ok).toBe(false);
  if (result.ok) throw Error('invalid plan accepted');
  expect(result.error).toContain('a close step takes');
  expect(result.violations?.[0]).toMatchObject({ path: 'steps', message: result.error });
  expect(result.violations).toHaveLength(16);
  expect(result.violations_truncated).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/secret-must-not-echo|not-a-secret-kind/);
});
