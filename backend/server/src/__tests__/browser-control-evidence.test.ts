import { expect, it } from 'vitest';
import { BROWSER_CONTROL_EVIDENCE_CHARS, parseBrowserActSteps, isBrowserControlEvidence, isBrowserPageObservation } from '@recued/contracts';
import { browserControlEvidence } from '../bridges/browser-control-evidence.js';
import { browserPageObservation, limitPageObservation } from '../bridges/browser-page-observation.js';
import { findControl, outlinePage } from '../bridges/page-outline.js';
const page = { url: 'https://example.org/notes' };
const evidence = (html: string, truncated = false) => browserControlEvidence(html, { whole: true, truncated });
const native = '<label for="category">Category</label><select ref="e1" id="category">'
  + '<option selected>Home</option><option value="work">Work</option><option disabled>Locked</option></select>'
  + '<label><input ref="e2" type="checkbox" checked>Completed</label>'
  + '<input ref="e3" type="radio" name="priority" aria-label="High" checked>'
  + '<input ref="e4" type="radio" name="priority" aria-label="Low">';

it('names the native operation, exact option values and current checked state', () => {
  const result = evidence(native)!;
  expect(isBrowserControlEvidence(result)).toBe(true);
  expect(result).toMatchObject({ complete: true, items: [
    { ref: 'e1', kind: 'select', label: 'Category', native: true, action: { do: 'type' }, value_kind: 'option_value_or_label',
      options_complete: true, options: [{ label: 'Home', value: 'Home', selected: true }, { label: 'Work', value: 'work', selected: false },
        { label: 'Locked', disabled: true }] },
    { ref: 'e2', kind: 'checkbox', label: 'Completed', checked: true, action: { do: 'type' }, value_kind: 'true_or_false' },
    { ref: 'e3', kind: 'radio', group: 'priority', checked: true, action: { do: 'type' }, value_kind: 'true' },
    { ref: 'e4', kind: 'radio', group: 'priority', checked: false },
  ] });
});
it('omits hidden values and structural placeholders and marks incomplete choices', () => {
  const html = '<select ref="e1" multiple aria-label="Tags"><option selected>A &amp; B</option>'
    + '<option hidden>private-hidden-value</option><option data-recued-structural-only>private-placeholder</option>'
    + '<option>' + 'x'.repeat(161) + '</option></select><input ref="e2" type="password" value="private-password">';
  const result = evidence(html)!;
  expect(result.items[0]).toMatchObject({ value_kind: 'option_lines', options_complete: false,
    options: [{ label: 'A & B', value: 'A & B', selected: true }] });
  expect(result.complete).toBe(false);
  expect(JSON.stringify(result)).not.toMatch(/private-hidden|private-placeholder|private-password/);
  expect(evidence(native, true)).toMatchObject({ complete: false, incomplete: ['page_truncated'] });
});
it('scopes names to the active dialog and explicitly linked portalled options', () => {
  const html = '<button ref="e1">Work</button><input ref="e2" type="checkbox" aria-label="Completed">'
    + '<div role="dialog" aria-modal="true"><button ref="e3" role="combobox" aria-controls="category" aria-expanded="true" aria-label="Category">Home</button></div>'
    + '<div role="listbox" id="category"><div role="option" ref="e4" aria-selected="false">Work</div></div>'
    + '<div role="listbox"><div role="option" ref="e5">Work</div></div>';
  const controls = outlinePage(html, page).controls;
  expect(findControl(controls, 'Work')).toMatchObject({ ref: 'e4' });
  expect(findControl(controls, 'Completed')).toHaveProperty('none');
  expect(evidence(html)).toMatchObject({ scope: 'dialog', complete: true, items: [
    { ref: 'e3', native: false, expanded: true, action: { do: 'click' }, follow_up: { do: 'read' } },
    { ref: 'e4', kind: 'option', selected: false, owner_ref: 'e3' },
  ] });
  expect(findControl(outlinePage(html.replace(' aria-controls="category"', ''), page).controls, 'Work')).toHaveProperty('none');
});
it('does not confuse a native option with a background tab named Work', () => {
  const html = '<button ref="e8">Work</button><div role="dialog" aria-modal="true">' + native + '</div>';
  expect(findControl(outlinePage(html, page).controls, 'Work')).toHaveProperty('none');
  expect(findControl(outlinePage(html, page).controls, 'Category')).toMatchObject({ ref: 'e1' });
  expect(evidence(html)!.items.map(item => item.ref)).not.toContain('e8');
});
it('custom widgets use click/read and retain mixed or unknown state', () => {
  const html = '<div role="checkbox" ref="e1" aria-checked="mixed">Tasks</div>'
    + '<div role="switch" ref="e2">Alerts</div><div role="combobox" ref="e3" aria-expanded="false">Category</div>';
  const result = evidence(html)!;
  expect(result.items[0]).toMatchObject({ checked: 'mixed', native: false, action: { do: 'click' }, follow_up: { do: 'read' } });
  expect(result.items[1]).not.toHaveProperty('checked');
  expect(result.items[2]).toMatchObject({ expanded: false });
  expect(result.items[2]).not.toHaveProperty('options');
  expect(isBrowserControlEvidence({ ...result, items: [{ ...result.items[0], action: { do: 'type' }, value_kind: 'true_or_false' }] })).toBe(false);
});
it('bounds choices and observations and supplies no actionable state while loading', () => {
  const result = evidence('<select ref="e1" aria-label="Country">'
    + Array.from({ length: 30 }, (_, i) => `<option>Country ${i}</option>`).join('') + '</select>')!;
  expect(result.items[0]?.options).toHaveLength(12);
  expect(result).toMatchObject({ complete: false, incomplete: ['option_limit'] });
  expect(JSON.stringify(result).length).toBeLessThanOrEqual(BROWSER_CONTROL_EVIDENCE_CHARS);
  const input = { ...page, page: '7:DOC', title: 'Page', html: native, loading: false, source_truncated: false, state: 'snapshot' as const };
  const observation = browserPageObservation(input);
  expect(observation.control_evidence).toMatchObject({ complete: true });
  expect(isBrowserPageObservation(observation)).toBe(true);
  expect(browserPageObservation({ ...input, loading: true })).not.toHaveProperty('control_evidence');
  expect(isBrowserPageObservation({ ...observation, loading: true })).toBe(false);
  expect(JSON.stringify(limitPageObservation(observation, 700)!).length).toBeLessThanOrEqual(700);
  expect(observation.control_evidence!.items).toHaveLength(4);
  expect(evidence('<div role="dialog" aria-modal="true"></div><div role="dialog" aria-modal="true"></div>'))
    .toMatchObject({ complete: false, incomplete: ['scope_limit'], items: [] });
});

it('emits hints that can be turned directly into valid native and custom batch steps', () => {
  const result = evidence(native + '<div ref="e5" role="combobox">Category</div><div ref="e6" role="checkbox" aria-checked="false">Custom tick</div>')!;
  for (const item of result.items) {
    const value = item.kind === 'select' ? 'work' : 'true';
    const steps = [{ ...item.action, ref: item.ref, ...(item.action.do === 'type' ? { value } : {}) },
      ...(item.follow_up ? [item.follow_up] : [])];
    expect(parseBrowserActSteps(steps), item.kind).toMatchObject({ ok: true });
  }
  expect(isBrowserControlEvidence({ ...result, items: [{ ...result.items.at(-1), action: { do: 'click', then_read: true } }] })).toBe(false);
  expect(isBrowserControlEvidence({ ...result, items: [{ ...result.items[0], action: { do: 'type', value_kind: 'option_value_or_label' } }] })).toBe(false);
});
