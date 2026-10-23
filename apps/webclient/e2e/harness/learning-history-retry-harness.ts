/** Production Learning panel with held replies; no server, model, or Kitchen. */
import { DEFAULT_INSTANCE_PREFS, type ExecutionCaseLearnedEntry, type InstancePrefs } from '@recued/contracts';
import { PRIMITIVE_STYLES } from '@recued/ui-shared/primitives';
import { mountLearningPanel, LEARNING_PANEL_STYLES } from '../../src/settings/learning-panel.js';
import { WEBCLIENT_POLISH_STYLES } from '../../src/shell/webclient-polish-styles.js';

type Kind = 'preferences' | 'history' | 'save' | 'forget' | 'draft';
type Outcome = 'success' | 'error';
const host = document.querySelector<HTMLElement>('#panel')!;
const holdPreferences = new URLSearchParams(location.search).get('preferences') === 'held';
const style = document.createElement('style'); style.textContent = `${PRIMITIVE_STYLES}\n${WEBCLIENT_POLISH_STYLES}\n${LEARNING_PANEL_STYLES}`; document.head.appendChild(style);
const entry = (case_id: string, request: string): ExecutionCaseLearnedEntry => ({ case_id, request: [request],
  flows: [{ tools_that_may_be_needed: ['file.search', 'mail.send'], outcome: ['You confirmed this was right.'] }],
  shown_to_model: true, request_observations: 1, last_seen_at: 1_700_000_000_000 });
const first = entry('history-case-a', 'Send the quarterly report'), second = entry('history-case-b', 'Check the monthly totals');
let cases = [first, second]; let current: InstancePrefs = { ...DEFAULT_INSTANCE_PREFS }; let allowHandoff = false;
const recipe = { recipe_id: 'finished-history-fixture', title: 'Finished draft fixture' };
const calls: Array<{ kind: Kind | 'handoff'; case_id?: string; patch?: Partial<InstancePrefs>; prompt?: string; recipe?: unknown; request_aliased?: boolean; work_pending?: boolean; unsaved?: boolean }> = [];
const pending: Array<{ kind: Kind; finish(outcome: Outcome): void }> = [];
const request = <T>(kind: Kind, response: () => T, detail: Partial<(typeof calls)[number]> = {}): Promise<T> => {
  calls.push({ kind, ...detail });
  return new Promise((resolve, reject) => {
    let released = false;
    pending.push({ kind, finish(outcome) {
      if (released) throw new Error('Fixture reply was already released.'); released = true;
      if (outcome === 'error') { reject(new Error(`Temporary ${kind} fixture failure.`)); return; }
      resolve(response());
    } });
  });
};
const panel = mountLearningPanel({ host, document,
  runPrefsGet: () => {
    if (holdPreferences) return request('preferences', () => ({ prefs: structuredClone(current) }));
    calls.push({ kind: 'preferences' }); return Promise.resolve({ prefs: structuredClone(current) });
  },
  runPrefsSet: ({ patch }) => request('save', () => { current = { ...current, ...patch }; return { prefs: structuredClone(current) }; }, { patch }),
  runCasesList: () => { const snapshot = structuredClone(cases); return request('history', () => ({ cases: snapshot })); },
  runCaseForget: ({ case_id }) => request('forget', () => { cases = cases.filter(value => value.case_id !== case_id); return { removed: true, cases_remaining: cases.length }; }, { case_id }),
  runDraftRecipe: ({ case_id, prompt }) => request('draft', () => ({ ok: true, recipe: structuredClone(recipe), issues: [], request_aliased: true }), { case_id, prompt }),
  onDraftReady: result => { calls.push({ kind: 'handoff', ...structuredClone(result), work_pending: panel.hasInFlightWork(), unsaved: panel.hasUnsavedChanges() }); return allowHandoff; },
  draftConfirmation: 'This fixture stands in for the server confirmation. A real draft asks your model and spends quota.',
});
const controls = {
  calls,
  async release(kind: Kind, index = 0, outcome: Outcome = 'success') {
    const item = pending.filter(item => item.kind === kind)[index];
    if (!item) throw new Error(`Missing fixture reply: ${kind} ${index}`);
    item.finish(outcome);
    if (kind === 'history') await panel.whenCasesSettled();
    else if (kind === 'save') await panel.whenSaveSettled();
    else if (kind === 'draft') await panel.whenDraftSettled();
    // Preference reads and Forget can start a held history read, released separately.
  },
  setOffer(value: boolean) { current = { ...current, 'chat.execution_case_offer': value }; },
  setCases(value: 'both' | 'first' | 'empty') { cases = value === 'both' ? [first, second] : value === 'first' ? [first] : []; },
  allowHandoff() { allowHandoff = true; },
  hasInFlightWork: () => panel.hasInFlightWork(),
  hasUnsavedChanges: () => panel.hasUnsavedChanges(),
  dispose: () => panel.dispose(),
};
declare global { interface Window { __learningHistory: typeof controls } }
window.__learningHistory = controls;
