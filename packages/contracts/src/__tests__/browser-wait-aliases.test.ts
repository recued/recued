import { expect, it } from 'vitest';
import { parseBrowserActSteps } from '../browser-act.js';

it('normalizes equivalent wait checks and preserves deadlines and failure checks', () => {
  const fail = { shows: '.error' };
  expect(parseBrowserActSteps([{ do: 'wait', seconds: 4, success_when: { shows: '.quote', text: 'Ready' }, fail_when: fail }, { do: 'read' }]))
    .toEqual({ ok: true, steps: [{ do: 'wait', seconds: 4, selector: '.quote', until: 'shown', text: 'Ready', fail_when: fail }, { do: 'read' }] });
  expect(parseBrowserActSteps([{ do: 'wait', success_when: { gone: '.spinner', seconds: 3 } }, { do: 'read' }]))
    .toEqual({ ok: true, steps: [{ do: 'wait', selector: '.spinner', until: 'gone', seconds: 3 }, { do: 'read' }] });
  expect(parseBrowserActSteps([{ do: 'wait', seconds: 3, success_when: { url_includes: '/done' } }, { do: 'read' }]))
    .toMatchObject({ ok: true, steps: [{ do: 'wait', url_includes: '/done', seconds: 3 }, { do: 'read' }] });
  expect(parseBrowserActSteps([{ do: 'click', ref: 'e1' }, { do: 'wait', seconds: 3, success_when: { page_changes: true } }]))
    .toEqual({ ok: true, steps: [{ do: 'click', ref: 'e1', success_when: { page_changes: true, seconds: 3 } }] });
});

it('refuses conflicting and unsupported wait checks without silently dropping any condition', () => {
  for (const step of [
    { do: 'wait', selector: '#old', success_when: { shows: '#new' } },
    { do: 'wait', success_when: { shows: '#new', gone: '#old' } },
    { do: 'wait', success_when: { gone: '#old', text: 'Done' } },
    { do: 'wait', seconds: 2, success_when: { shows: '#new', seconds: 3 } },
    { do: 'wait', success_when: { page_changes: true, shows: '#new' } },
    { do: 'wait', success_when: { shows: '#new', unexpected: true } },
  ]) expect(parseBrowserActSteps([step]).ok).toBe(false);
});
