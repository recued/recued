import { RefPicker } from '@recued/ui-shared';
import type { RecentReferenceChoice, RecentReferenceChoices, RecentReferenceKind } from './recent-reference-choices.js';

const plural = (kind: RecentReferenceKind) => kind === 'contact' ? 'contacts' : kind === 'project' ? 'projects' : 'tasks';
export const recentReferencePage = async (history: RecentReferenceChoices, kind: RecentReferenceKind,
  resolve: (choice: RecentReferenceChoice, current: () => boolean) => Promise<RefPicker.RefPickerOption | null>,
  current: () => boolean): Promise<RefPicker.RefPickerSearchPage> => {
  const epoch = history.clearEpoch(kind), choices = history.list(kind), owns = () => current() && history.clearEpoch(kind) === epoch;
  let failed = false;
  const resolved = await Promise.all(choices.map(async choice => {
    try { return owns() ? await resolve(choice, owns) : null; }
    catch { if (owns()) failed = true; return null; }
  }));
  const seen = new Set<string>(), options: RefPicker.RefPickerOption[] = [];
  if (owns()) for (const option of resolved) if (option && !seen.has(option.id)) {
    seen.add(option.id); options.push({ ...option, sublabel: ['Recent choice', option.sublabel].filter(Boolean).join(' · ') });
  }
  return { options, emptyText: choices.length ? `No available recent ${plural(kind)}. Type to search.` : `No recent ${plural(kind)} yet. Type to search.`,
    ...(failed && owns() ? { retryableError: `Some recent ${plural(kind)} could not be checked. Try again, or type to search.` } : {}) };
};

/** Clearing history is independent of the field's selected reference, query
 * and draft. The host refreshes any cached recent lists before focus returns. */
export const mountRecentReferenceControl = (shell: HTMLElement, kind: RecentReferenceKind, history: RecentReferenceChoices | undefined,
  handle: RefPicker.RefPickerHandle, cleared: () => void): void => {
  if (!history) return;
  let row = shell.querySelector<HTMLElement>('[data-reference-choice-history]');
  if (!row) {
    const doc = shell.ownerDocument; row = doc.createElement('div'); row.className = 'work-reference-picker-status';
    row.setAttribute('data-reference-choice-history', ''); row.setAttribute(RefPicker.REF_PICKER_KEEP_QUERY_ATTR, '');
    const button = doc.createElement('button'); button.type = 'button'; button.className = 'data-button'; button.textContent = 'Clear recent choices';
    button.setAttribute('aria-label', `Clear recent ${plural(kind)}`);
    const notice = doc.createElement('span'); notice.setAttribute('role', 'status');
    button.addEventListener('click', () => {
      if (!button.isConnected || !shell.contains(button)) return;
      if (!history.clear(kind)) { notice.textContent = 'Recent choices could not be cleared. Try again.'; button.focus({ preventScroll: true }); return; }
      const input = shell.querySelector<HTMLInputElement>('[data-ref-picker-input]'), query = handle.getQuery();
      const start = input?.selectionStart, end = input?.selectionEnd, direction = input?.selectionDirection;
      // Move focus before the host hides Clear, otherwise its removal can
      // emit a genuine blur and revert the query before we restore its caret.
      input?.focus({ preventScroll: true }); cleared();
      if (input && query === handle.getQuery() && start != null && end != null) input.setSelectionRange(start, end, direction ?? undefined);
      notice.textContent = 'Recent choices cleared.'; button.hidden = true; row!.hidden = false;
    });
    row.append(button, notice); shell.append(row);
  }
  const button = row.querySelector<HTMLButtonElement>('button')!;
  button.hidden = history.list(kind).length === 0;
  row.hidden = button.hidden && !row.querySelector('span')?.textContent;
};
