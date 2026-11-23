import { unresolvedPromptEdits, type PromptEditComparison } from './prompt-edit-recovery.js';
import { describePromptCron } from './prompt-repeat.js';
import { formatReminderTimePreview } from '../reminders/reminder-time.js';

const display = (key: string, value: string) => {
  if (key === 'model') return ({ slot_1: 'Slot 1: fast', slot_2: 'Slot 2: better, slower thinking', free_pool: 'Free pool' } as Record<string, string>)[value] ?? value;
  if (key === 'timing' && !value.startsWith('Timing needs review:')) {
    const split = value.lastIndexOf(' · '), when = value.slice(0, split), zone = value.slice(split + 3);
    try { return (/^\d{4}-/.test(when) ? formatReminderTimePreview(Date.parse(when), zone) : describePromptCron(when)) + ' · ' + zone; } catch { /* Keep the stated values readable. */ }
  }
  return value;
};

export const promptEditComparisonView = (options: {
  document: Document; comparison: PromptEditComparison; disabled: boolean; prepare(): void;
}): HTMLElement => {
  const { document: doc, comparison } = options;
  const node = (tag: string, text: string) => { const el = doc.createElement(tag); el.textContent = text; return el; };
  const section = doc.createElement('section'); section.className = 'prompt-edit-comparison'; section.setAttribute('role', 'region'); section.setAttribute('aria-label', 'Compare scheduled prompt edits');
  const heading = node('h3', 'Compare scheduled prompt edits'); heading.tabIndex = -1; heading.dataset.promptComparisonHeading = '';
  section.append(heading, node('p', 'The saved prompt changed. Changes in different fields can be kept together. Choose which version to use when both changed the same field.'),
    node('p', `The current schedule is ${comparison.current.enabled ? 'active' : 'paused'}. Preparing or discarding this draft does not change that state.`));
  const status = node('p', ''); status.setAttribute('role', 'status');
  const prepare = doc.createElement('button'); prepare.type = 'button'; prepare.textContent = 'Prepare draft'; prepare.addEventListener('click', options.prepare);
  const update = () => { const count = unresolvedPromptEdits(comparison); prepare.disabled = options.disabled || count > 0;
    status.textContent = count ? `Choose a version for ${count} ${count === 1 ? 'field' : 'fields'}.` : 'Prepare draft checks the saved prompt again. You review and save the resulting draft separately.'; };
  for (const row of comparison.rows) {
    const field = doc.createElement('fieldset'); field.append(node('legend', row.label));
    const pair = doc.createElement('div'); pair.className = 'prompt-edit-values';
    for (const [label, value] of [['Saved now', row.saved], ['Your edits', row.mine]]) {
      const column = doc.createElement('div'), text = node('p', display(row.key, value!) || '(empty)'); text.tabIndex = 0; column.append(node('h4', label!), text); pair.append(column);
    }
    field.append(pair);
    if (row.conflict) {
      const label = doc.createElement('label'); label.append(node('span', row.label + ': which version?'));
      const select = doc.createElement('select'); select.disabled = options.disabled;
      for (const [value, text] of [['', 'Choose a version'], ['saved', 'Use saved value'], ['mine', 'Use my edits']]) {
        const option = doc.createElement('option'); option.value = value!; option.textContent = text!; select.append(option);
      }
      select.value = comparison.choices[row.key] ?? '';
      select.addEventListener('change', () => { const value = select.value; if (value === 'mine' || value === 'saved') comparison.choices[row.key] = value; else delete comparison.choices[row.key]; update(); });
      label.append(select); field.append(label);
    } else field.append(node('p', !row.mineChanged ? 'The saved change will be kept.' : !row.savedChanged ? 'Your edits will be carried over.' : 'Both versions have this value.'));
    section.append(field);
  }
  if (!comparison.rows.length) section.append(node('p', 'The editable settings match. Preparing the draft will use the current revision.'));
  section.append(status, prepare); update(); return section;
};
