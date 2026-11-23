import { readBodyGoal, type Asset, type AssetPatch } from '@recued/contracts';
import { assetFieldName, nameInSentence } from './reading-words.js';
import { yoursChoice, yoursInput, yoursNode } from './yours-view.js';
import { yoursFieldError } from './yours-field-errors.js';
import { PursuitFieldError, pursuitDraft, pursuitPartChoices, pursuitPatch, type PursuitDraft } from './pursuits.js';

/** D-342 §3 — the Pursuit form, to add one (no `own`) or edit it. `read` refuses at the field
 * it cannot save, as the other Yours editors do. "Ask me in the evening" is what Close the day
 * (D-343 slice 4) lists in its evening message. */
export const mountPursuitEditor = (host: HTMLFormElement, own: Asset | undefined, pursuits: readonly Asset[],
  options: { partOf?: string; parentName?: string; changed: () => void }) => {
  const draft = pursuitDraft(own, options.partOf); const { changed } = options;
  yoursNode(host, 'p', 'yours-muted', 'Something you are working toward, from a goal for this year to a habit for life. Nothing here sends reminders.');
  const name = yoursInput(host, 'What you are working toward', 'pursuit-name', draft.name, changed); name.required = true; name.maxLength = 200;
  const horizon = yoursInput(host, 'Horizon (optional)', 'pursuit-horizon', draft.horizon, changed);
  yoursNode(host, 'small', 'yours-muted', 'In your words, such as 2027, by summer 2027 or ongoing. Leave it empty for a habit.');
  const area = (title: string, key: string, value: string) => {
    const label = yoursNode(host, 'label', '', title); const entry = yoursNode(label, 'textarea', '');
    entry.name = key; entry.value = value; entry.dataset.yoursFocus = key; entry.setAttribute('aria-label', title); entry.addEventListener('input', changed);
    return entry;
  };
  const why = area('Why (optional)', 'pursuit-why', draft.why);
  const where = area('Where I am (optional)', 'pursuit-where', draft.where_i_am);
  yoursNode(host, 'small', 'yours-muted', 'Where you are with it now, such as “Ran 15 km on 6 November 2026”. A new note replaces the last one.');
  const row = yoursNode(host, 'div', 'yours-pursuit-progress');
  const progress = yoursInput(row, 'Progress (optional)', 'pursuit-progress', draft.progress, changed, 'number'); progress.step = 'any';
  const unit = yoursInput(row, 'Counted in', 'pursuit-unit', draft.unit, changed);
  const counted = yoursNode(host, 'small', 'yours-muted', 'A number and what it counts, such as 12 books. Each update is kept with its time.');
  // D-339 slice 15 — a goal on a Body takes its progress from the Body's reading, so there is none to type.
  const goal = own ? readBodyGoal(own.settings) : undefined;
  if (goal) {
    row.hidden = true; counted.hidden = true;
    yoursNode(host, 'small', 'yours-muted', `Its progress is the Body's ${nameInSentence(assetFieldName(goal.reading))}, so there is none to type. `
      + 'Change its number with Change goal.').dataset.yoursPursuitGoalNote = '';
  }
  const target = yoursInput(host, 'Target date (optional)', 'pursuit-target', draft.target_on, changed, 'date');
  const partOf = yoursChoice(host, 'Part of (optional)', 'pursuit-part-of', pursuitPartChoices(own, pursuits, options.parentName), draft.part_of, changed);
  const privacy = yoursInput(host, 'Private', 'pursuit-private', '', changed, 'checkbox'); privacy.checked = draft.private;
  yoursNode(host, 'small', 'yours-muted', 'A message that mentions it calls it only “a reminder in Yours”.');
  const evening = yoursInput(host, 'Ask me in the evening', 'pursuit-evening', '', changed, 'checkbox'); evening.checked = draft.evening;
  yoursNode(host, 'small', 'yours-muted', 'Close the day lists it in its evening message, so you can say how it went.');
  const household = yoursInput(host, 'Shared with your household', 'pursuit-household', '', changed, 'checkbox'); household.checked = draft.household;
  const controls: Record<keyof PursuitDraft, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement> = {
    name, horizon, why, where_i_am: where, progress, unit, target_on: target, part_of: partOf, private: privacy, household, evening };
  return { read(now: number): AssetPatch {
    const value: PursuitDraft = { name: name.value, horizon: horizon.value, why: why.value, where_i_am: where.value, progress: progress.value,
      unit: unit.value, target_on: target.value, part_of: partOf.value, private: privacy.checked, household: household.checked,
      evening: evening.checked };
    try { return pursuitPatch(value, own, now); }
    catch (error) { if (error instanceof PursuitFieldError) yoursFieldError(controls[error.field], error.message); throw error; }
  } };
};
