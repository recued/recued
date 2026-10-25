import { parseRehearsalConfiguration, parseRehearsalDocument, type Conn, type ServerRpcRegistry, type RehearsalTarget,
  type RehearsalDocument, type RehearsalView, type RehearsalMutation, type RehearsalSave, type RehearsalActivate,
  type RehearsalComparison, type RehearsalReview, type RehearsalCase } from '@recued/contracts';
import { AUTOMATION_REHEARSAL_STYLES } from './automation-rehearsal-styles.js';

/** Kept alive by the route; pending writes retain their identity across lost replies. */
export const mountAutomationRehearsalPanel = (options: { host: HTMLElement; target: RehearsalTarget; call: Conn<ServerRpcRegistry>;
  beginWork?(): () => void; onActivated?(): void }) => {
  const doc = options.host.ownerDocument, root = doc.createElement('section'); options.host.append(root); root.dataset.automationRehearsal = '';
  root.className = 'rehearsal-workspace';
  if (doc.head && !doc.head.querySelector('[data-recued-rehearsal-styles]')) {
    const style = doc.createElement('style'); style.dataset.recuedRehearsalStyles = ''; style.textContent = AUTOMATION_REHEARSAL_STYLES; doc.head.appendChild(style);
  }
  let state: RehearsalView | null = null, text = '', savedText = '', dirty = false, busy = false, disposed = false, epoch = 0;
  let message = '', error = '', comparison: RehearsalComparison | null = null, review: RehearsalReview | null = null, deleteArmed = false;
  let pendingSave: RehearsalSave | null = null, pendingSaveText = '', pendingActivation: RehearsalActivate | null = null;
  let pendingDelete: { target: RehearsalTarget; expected_revision: number; request_id: string } | null = null, selectedVersion = '';
  let workFocus: string | undefined, builderDirty = false, builderEpoch = 0;
  let filterDraft: string | null = null;
  const now = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
  const newBuilder = () => ({ name: '', expected: 'start', at: now, last: '', next: now, running: false, tripped: false,
    platform: 'task', slug: 'main', entity: 'task', kind: 'created', record: '{}', prev: '', changed: '', ready: true, chat: false, drain: false });
  const builder = newBuilder();
  const builderChanged = () => { builderDirty = true; builderEpoch++; updateProgress(); };
  const clearBuilder = () => { Object.assign(builder, newBuilder()); builderDirty = false; builderEpoch++; };
  const pretty = (value: unknown) => JSON.stringify(value, null, 2);
  const blank = (): RehearsalDocument => ({ title: 'Automation scenarios', candidate: state!.current!, cases: [] });
  const working = (): RehearsalDocument => {
    const value = JSON.parse(text || pretty(blank())) as RehearsalDocument;
    if (!value || typeof value.title !== 'string' || !Array.isArray(value.cases)
      || !value.cases.every(item => item && typeof item.id === 'string' && typeof item.name === 'string'
        && ['start', 'skip', 'ask'].includes(item.expected) && item.input && ['event', 'clock'].includes(item.input.kind))) throw new Error('Use a title, configuration and scenario list.');
    const candidate = value.candidate;
    if (!candidate || typeof candidate.enabled !== 'boolean'
      || (candidate.kind === 'trigger' ? typeof candidate.pattern !== 'string' || candidate.filter !== null && (!candidate.filter || typeof candidate.filter !== 'object' || Array.isArray(candidate.filter))
        || candidate.fields !== null && (!Array.isArray(candidate.fields) || !candidate.fields.every(item => typeof item === 'string'))
        : candidate.kind === 'schedule' ? typeof candidate.cron_expression !== 'string' || typeof candidate.missed_policy !== 'string'
          : candidate.kind !== 'timer' || typeof candidate.reset_circuit !== 'boolean')) throw new Error('Use a valid configuration shape.');
    return value;
  };
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, parent: HTMLElement, content?: string) => {
    const item = doc.createElement(tag); if (content !== undefined) item.textContent = content; parent.append(item); return item;
  };
  /** These labels describe the working copy and current receipts; they do not
   *  grant permission or change any save, test, review or retry gate. */
  const updateProgress = () => {
    const set = (name: string, text: string, tone = '') => {
      const item = root.querySelector<HTMLElement>(`[data-rehearsal-${name}-state]`);
      if (item) { item.textContent = text; item.dataset.rehearsalTone = tone; }
    };
    set('working', !state ? 'Loading…' : dirty ? 'Unsaved changes' : pendingDelete ? 'Cleanup reply pending' : state.draft ? `Saved version ${state.draft.revision}` : 'Not saved', dirty || pendingDelete ? 'attention' : '');
    const current = state?.supported && state.current, draft = state?.draft;
    const proof = state?.qualification, result = comparison ?? proof?.comparison;
    const freshProof = proof && draft && proof.draft_revision === draft.revision && proof.expires_at > Date.now();
    if (!current) set('test', state ? 'Unavailable' : 'Loading…');
    else if (pendingDelete) set('test', 'Check cleanup outcome', 'attention');
    else if (dirty || !draft) set('test', 'Save before testing');
    else if (draft.base_digest !== state!.live_digest) set('test', 'Live configuration changed', 'attention');
    else if (result && result.failed > 0) set('test', `${result.failed} failed`, 'attention');
    else if (freshProof) set('test', `${proof.comparison.passed} passed · version ${draft.revision}`, 'ready');
    else if (proof && proof.expires_at <= Date.now()) set('test', 'Test expired', 'attention');
    else set('test', result ? 'Results available' : 'Not tested');
    if (!current) set('review', state ? 'Unavailable' : 'Loading…');
    else if (pendingDelete) set('review', 'Cleanup reply pending', 'attention');
    else if (pendingActivation) set('review', 'Activation reply pending', 'attention');
    else if (dirty) set('review', 'Save and test changes');
    else if (review) set('review', review.expires_at > Date.now() ? 'Ready to activate' : 'Review expired', review.expires_at > Date.now() ? 'ready' : 'attention');
    else set('review', freshProof ? 'Review next' : 'Not prepared');
    const form = root.querySelector<HTMLElement>('[data-rehearsal-builder-status]');
    if (form) { form.hidden = !builderDirty; form.textContent = 'The scenario form has changes. Add the scenario to include it in the next saved version.'; }
  };
  const gates = () => {
    root.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = busy
      || button.dataset.savedOnly === 'true' && dirty
      || button.dataset.testOnly === 'true' && (!state?.draft || state.draft.base_digest !== state.live_digest)
      || button.dataset.proofOnly === 'true' && (!state?.qualification || state.qualification.expires_at <= Date.now())
      || button.dataset.reviewOnly === 'true' && (!review || review.expires_at <= Date.now() && !pendingActivation); });
    root.querySelectorAll<HTMLElement>('[data-rehearsal-proof]').forEach(item => { item.hidden = dirty; });
    const advanced = root.querySelector<HTMLTextAreaElement>('[aria-label="Rehearsal document (JSON)"]');
    if (advanced) advanced.readOnly = filterDraft !== null;
    const filterNotice = root.querySelector<HTMLElement>('[data-rehearsal-filter-notice]'); if (filterNotice) filterNotice.hidden = filterDraft === null;
    root.setAttribute('aria-busy', String(busy));
    const status = root.querySelector<HTMLElement>('[data-rehearsal-status]'); if (status) status.textContent = dirty ? 'Working changes are not saved or tested.' : message;
    updateProgress();
  };
  const changed = () => {
    epoch++; dirty = text !== savedText || filterDraft !== null; review = null; pendingActivation = null; error = '';
    const editor = root.querySelector<HTMLTextAreaElement>('[aria-label="Rehearsal document (JSON)"]');
    if (editor && doc.activeElement !== editor) editor.value = text; gates();
  };
  const edit = (change: (document: RehearsalDocument) => void, repaint = true) => {
    try { const value = working(); change(value); text = pretty(value); changed(); if (repaint) render(); }
    catch (cause) { error = cause instanceof Error ? cause.message : String(cause); render(); }
  };
  const run = async (action: () => Promise<void>, tracked = true) => {
    if (busy || disposed) return;
    workFocus = root.contains(doc.activeElement) ? (doc.activeElement as HTMLElement).dataset.rehearsalFocus : undefined;
    const release = tracked ? options.beginWork?.() : undefined; busy = true; error = '';
    try { render(); await action(); } catch (cause) { if (!disposed) error = cause instanceof Error ? cause.message : String(cause); }
    finally { release?.(); busy = false; if (!disposed) render(); workFocus = undefined; }
  };
  const accept = (result: RehearsalMutation, started: number) => {
    state = { ...result, revision: result.mutation_revision, draft: result.saved_draft ?? result.draft };
    if (result.saved_draft) { savedText = pretty(result.saved_draft.document); if (epoch === started) text = savedText; dirty = text !== savedText || filterDraft !== null; }
    comparison = null; review = null; pendingSave = null; pendingActivation = null; pendingDelete = null;
  };
  const reload = () => run(async () => {
    const started = epoch, startedBuilder = builderEpoch, result = await options.call('automation.rehearsal.get', { target: options.target }); if (disposed) return;
    state = result; savedText = pretty(result.draft?.document ?? blank()); if (epoch === started) { text = savedText; filterDraft = null; } dirty = text !== savedText || filterDraft !== null;
    pendingSave = null; pendingActivation = null; pendingDelete = null; comparison = null; review = null; message = 'Loaded saved rehearsal.';
    if (builderEpoch === startedBuilder) clearBuilder();
  }, false);
  const save = () => run(async () => {
    if (!state) return;
    if (!pendingSave) {
      if (filterDraft !== null) {
        const document = working();
        if (document.candidate.kind === 'trigger') document.candidate.filter = JSON.parse(filterDraft);
        parseRehearsalConfiguration(document.candidate); filterDraft = null; text = pretty(document); changed();
      }
      pendingSave = { target: options.target, expected_revision: state.revision, expected_live_digest: state.live_digest,
        request_id: crypto.randomUUID(), document: parseRehearsalDocument(JSON.parse(text)) }; pendingSaveText = text;
    }
    const started = text === pendingSaveText ? epoch : -1, result = await options.call('automation.rehearsal.save', pendingSave);
    if (disposed) return; accept(result, started); message = 'Saved scenario version ' + result.saved_draft!.revision + '. Live automation is unchanged.';
  });
  const test = () => run(async () => {
    if (dirty || !state?.draft) return; state.qualification = null; review = null; comparison = null;
    const result = await options.call('automation.rehearsal.test', { target: options.target, expected_revision: state.revision, draft_revision: state.draft.revision });
    if (disposed) return; state = result; comparison = result.comparison; message = result.comparison.passed + ' passed · ' + result.comparison.failed + ' failed. Scenarios dispatched no live work.';
  });
  const prepare = () => run(async () => {
    if (dirty || !state?.draft || !state.qualification) return;
    const result = await options.call('automation.rehearsal.prepare', { target: options.target, expected_revision: state.revision,
      draft_revision: state.draft.revision, receipt_id: state.qualification.receipt_id }); if (disposed) return;
    review = result; pendingActivation = null; message = 'Inspect the exact configuration before activating it.';
  });
  const activate = () => run(async () => {
    if (dirty || !state || !review) return; const started = epoch;
    pendingActivation ??= { target: options.target, expected_revision: state.revision, review_id: review.review_id, request_id: crypto.randomUUID() };
    const result = await options.call('automation.rehearsal.activate', pendingActivation); if (disposed) return; accept(result, started);
    message = 'Committed configuration revision ' + result.activated!.sequence + '. Ordinary execution checks still apply.';
    error = result.refresh_warning ?? ''; options.onActivated?.();
  });
  const discard = () => !dirty && !builderDirty || !doc.defaultView?.confirm || doc.defaultView.confirm('Discard unsaved rehearsal and scenario changes?');
  const button = (host: HTMLElement, title: string, action: () => void, flags: string[] = []) => {
    const item = node('button', host, title); item.type = 'button'; item.className = 'automation-button'; item.dataset.rehearsalFocus = title;
    for (const flag of flags) item.dataset[flag] = 'true';
    item.addEventListener('click', () => { if (!busy) {
      // WebKit does not focus pointer-activated buttons. Own this explicit
      // action so the existing guarded handoff can follow its replacement.
      item.focus({ preventScroll: true }); action();
    } }); return item;
  };
  const input = (host: HTMLElement, title: string, value: string, update: (value: string) => void, multiline = false) => {
    const label = node('label', host); label.className = 'rehearsal-field' + (multiline ? ' rehearsal-field-wide' : ''); node('span', label, title);
    const field = multiline ? node('textarea', label) : node('input', label); field.value = value; field.setAttribute('aria-label', title); field.dataset.rehearsalFocus = title;
    // Retain the native-control floor over the shared shell's input rules.
    field.style.minHeight = '44px';
    if (multiline) (field as HTMLTextAreaElement).rows = 4; field.addEventListener('input', () => update(field.value)); return field;
  };
  const select = (host: HTMLElement, title: string, value: string, choices: Array<[string, string]>, update: (value: string) => void) => {
    const label = node('label', host); label.className = 'rehearsal-field'; node('span', label, title); const field = node('select', label);
    field.setAttribute('aria-label', title); field.dataset.rehearsalFocus = title;
    for (const [key, title] of choices) { const item = node('option', field, title); item.value = key; } field.value = value;
    field.addEventListener('change', () => update(field.value)); return field;
  };
  const checkbox = (host: HTMLElement, title: string, value: boolean, update: (value: boolean) => void) => {
    const label = node('label', host); label.className = 'rehearsal-checkbox';
    const field = node('input', label); field.type = 'checkbox'; field.checked = value; field.setAttribute('aria-label', title); field.dataset.rehearsalFocus = title;
    node('span', label, title); field.addEventListener('change', () => update(field.checked));
  };
  const pre = (host: HTMLElement, value: unknown) => node('pre', host, pretty(value));
  const card = (host: HTMLElement, title: string, label = title) => {
    const section = node('section', host); section.className = 'rehearsal-card'; section.setAttribute('aria-label', label); node('h4', section, title); return section;
  };
  const actions = (host: HTMLElement) => { const group = node('div', host); group.className = 'rehearsal-actions'; return group; };
  const deleteControls = (host: HTMLElement) => {
    const cleanup = card(host, 'Saved rehearsal data'); cleanup.classList.add('rehearsal-cleanup');
    node('p', cleanup, 'Remove saved scenarios and their history. Live automation stays in place.').className = 'rehearsal-hint';
    button(actions(cleanup), 'Delete saved rehearsal and history', () => { deleteArmed = true; render(); }).classList.add('automation-button--danger');
    if (deleteArmed) { node('p', cleanup, 'This deletes private scenarios and history. It leaves live automation in place.');
      const confirmation = actions(cleanup);
      button(confirmation, 'Confirm delete rehearsal', () => { void run(async () => {
        const started = epoch, keepWorking = dirty || builderDirty; pendingDelete ??= { target: options.target, expected_revision: state!.revision, request_id: crypto.randomUUID() };
        await options.call('automation.rehearsal.delete', pendingDelete);
        const result = await options.call('automation.rehearsal.get', { target: options.target }); if (disposed) return;
        state = result; savedText = pretty(blank()); if (!keepWorking && epoch === started) { text = savedText; filterDraft = null; } dirty = text !== savedText || filterDraft !== null;
        review = null; comparison = null; pendingSave = null; pendingDelete = null; deleteArmed = false; message = 'Deleted saved rehearsal. Live automation is unchanged.';
      }); }).classList.add('automation-button--danger');
      if (!pendingDelete) button(confirmation, 'Cancel deletion', () => { deleteArmed = false; message = 'Deletion canceled. Saved rehearsal is unchanged.'; render(); }); }
  };
  const render = () => {
    if (disposed) return;
    const focused = root.contains(doc.activeElement) ? (doc.activeElement as HTMLElement).dataset.rehearsalFocus : doc.activeElement === doc.body ? workFocus : undefined;
    const selection = doc.activeElement?.tagName === 'TEXTAREA' ? [(doc.activeElement as HTMLTextAreaElement).selectionStart, (doc.activeElement as HTMLTextAreaElement).selectionEnd] : null;
    const open = new Set([...root.querySelectorAll<HTMLDetailsElement>('details[open]')].map(item => item.querySelector('summary')?.textContent));
    const finish = () => { gates(); if (focused && (doc.activeElement === doc.body || root.contains(doc.activeElement))) {
      const replacement = [...root.querySelectorAll<HTMLElement>('[data-rehearsal-focus]')].find(item => item.dataset.rehearsalFocus === focused);
      (replacement ?? root.querySelector<HTMLElement>('[data-rehearsal-status]'))?.focus({ preventScroll: true });
      if (selection && replacement?.tagName === 'TEXTAREA') (replacement as HTMLTextAreaElement).setSelectionRange(selection[0]!, selection[1]!);
    } };
    root.replaceChildren();
    const header = node('header', root); header.className = 'rehearsal-header'; const identity = node('div', header);
    node('h3', identity, 'Rehearsal workspace');
    node('p', identity, 'Save and test event or clock scenarios, then review the configuration before activation. Rehearsal starts no live runs.').className = 'rehearsal-hint';
    button(header, 'Reload saved rehearsal', () => { if (discard()) void reload(); });
    const progress = node('dl', root); progress.className = 'rehearsal-progress'; progress.setAttribute('aria-label', 'Rehearsal progress');
    for (const [name, label] of [['working', 'Working copy'], ['test', 'Scenario test'], ['review', 'Activation review']]) {
      const fact = node('div', progress); node('dt', fact, label); node('dd', fact).setAttribute(`data-rehearsal-${name}-state`, '');
    }
    const feedback = node('div', root); feedback.className = 'rehearsal-feedback';
    const status = node('p', feedback, message); status.setAttribute('role', 'status'); status.tabIndex = -1; status.dataset.rehearsalStatus = ''; status.dataset.rehearsalFocus = 'status';
    node('p', feedback, error).setAttribute('role', 'alert');
    if (!state) { finish(); return; }
    if (!state.supported || !state.current) { node('p', card(root, 'Rehearsal unavailable'), state.reason); if (state.draft || state.history.length) deleteControls(root); finish(); return; }
    let value: RehearsalDocument | null = null; try { value = working(); } catch { /* Preserve malformed advanced text without rendering unsafe shapes. */ }
    const editors = node('div', root); editors.className = 'rehearsal-edit-grid';
    const configuration = card(editors, 'Proposed configuration');
    input(configuration, 'Rehearsal title', value?.title ?? '', title => edit(item => { item.title = title; }, false));
    node('p', configuration, 'Time zone: ' + state.time_zone + (state.interval_ms === null ? '' : ' · Recipe timer interval: ' + state.interval_ms + ' ms')).className = 'rehearsal-hint';
    if (value) {
      checkbox(configuration, 'Automation enabled after activation', value.candidate.enabled, enabled => edit(item => { item.candidate.enabled = enabled; }));
      const candidate = value.candidate;
      if (candidate.kind === 'schedule') {
        input(configuration, 'Cron expression', candidate.cron_expression, cron => edit(item => { if (item.candidate.kind === 'schedule') item.candidate.cron_expression = cron; }, false));
        select(configuration, 'Missed-run policy', candidate.missed_policy, [['auto', 'Decide for me'], ['ask', 'Ask me'], ['skip', 'Skip missed runs'], ['catch_up', 'Catch up']], policy => edit(item => { if (item.candidate.kind === 'schedule') item.candidate.missed_policy = policy as typeof candidate.missed_policy; }));
      } else if (candidate.kind === 'trigger') {
        input(configuration, 'Event pattern', candidate.pattern, pattern => edit(item => { if (item.candidate.kind === 'trigger') item.candidate.pattern = pattern; }, false));
        input(configuration, 'Payload filter (JSON or null)', filterDraft ?? pretty(candidate.filter), filter => {
          filterDraft = filter;
          try {
            const parsed = parseRehearsalConfiguration({ kind: 'trigger', enabled: false, pattern: '**', filter: JSON.parse(filter), fields: null, watch_interval_ms: null });
            const document = working(); if (document.candidate.kind === 'trigger' && parsed.kind === 'trigger') {
              document.candidate.filter = parsed.filter; text = pretty(document); filterDraft = null;
            }
          } catch { /* Preserve incomplete filter text; advanced replacement waits for it. */ }
          changed();
        }, true);
        input(configuration, 'Watched changed fields (comma separated)', candidate.fields?.join(', ') ?? '', fields => edit(item => { if (item.candidate.kind === 'trigger') item.candidate.fields = fields.trim() ? fields.split(',').map(value => value.trim()).filter(Boolean) : null; }, false));
      } else checkbox(configuration, 'Reset a tripped timer circuit on activation', candidate.reset_circuit, reset => edit(item => { if (item.candidate.kind === 'timer') item.candidate.reset_circuit = reset; }));
    }
    const scenarios = card(editors, 'Scenarios');
    node('p', scenarios, 'Examples in this working copy. Save them before testing.').className = 'rehearsal-hint';
    const formStatus = node('p', scenarios); formStatus.dataset.rehearsalBuilderStatus = ''; formStatus.className = 'rehearsal-hint';
    const scenarioList = node('ul', scenarios); scenarioList.className = 'rehearsal-scenarios';
    for (const item of value?.cases ?? []) {
      const row = node('li', scenarioList); node('h5', row, item.name + ' · ' + item.input.kind + ' scenario');
      select(row, 'Expected result for ' + item.name, item.expected, [['start', 'Request a run'], ['skip', 'Skip'], ['ask', 'Wait for owner']], expected => edit(value => { value.cases.find(value => value.id === item.id)!.expected = expected as RehearsalCase['expected']; }));
      button(actions(row), 'Remove ' + item.name, () => edit(value => { value.cases = value.cases.filter(value => value.id !== item.id); }));
    }
    const add = node('details', scenarios); add.className = 'rehearsal-disclosure'; node('summary', add, 'Add scenario');
    const form = node('div', add); form.className = 'rehearsal-scenario-form';
    input(form, 'Scenario name', builder.name, value => { builder.name = value; builderChanged(); });
    select(form, 'Scenario expected result', builder.expected, [['start', 'Request a run'], ['skip', 'Skip'], ['ask', 'Wait for owner']], value => { builder.expected = value; builderChanged(); });
    const buildText = (label: string, field: 'at' | 'last' | 'next' | 'platform' | 'slug' | 'entity' | 'kind' | 'record' | 'prev' | 'changed', multiline = false) =>
      input(form, label, builder[field], value => { builder[field] = value; builderChanged(); }, multiline);
    buildText('Scenario instant (ISO 8601 with UTC offset)', 'at');
    if (options.target.kind === 'trigger') {
      buildText('Event platform', 'platform'); buildText('Event source', 'slug'); buildText('Event entity type', 'entity'); buildText('Event kind', 'kind');
      buildText('Current record (JSON)', 'record', true); buildText('Previous record (JSON, optional)', 'prev', true); buildText('Changed fields (comma separated)', 'changed');
      checkbox(form, 'Fixture source is ready', builder.ready, value => { builder.ready = value; builderChanged(); });
      checkbox(form, 'Fixture is initial backfill or drain', builder.drain, value => { builder.drain = value; builderChanged(); });
      checkbox(form, 'Fixture mail is a conversation with Recued', builder.chat, value => { builder.chat = value; builderChanged(); });
    } else {
      buildText('Last run instant (ISO 8601, blank for never)', 'last'); buildText('Timer due instant (ISO 8601)', 'next');
      checkbox(form, 'Fixture has a running execution', builder.running, value => { builder.running = value; builderChanged(); });
      checkbox(form, 'Fixture timer circuit is tripped', builder.tripped, value => { builder.tripped = value; builderChanged(); });
    }
    const formActions = actions(form);
    button(formActions, 'Clear scenario form', () => { clearBuilder(); render(); });
    button(formActions, 'Add scenario to rehearsal', () => {
      try {
        const at = (value: string) => { if (!/(Z|[+-]\d\d:\d\d)$/u.test(value)) throw new Error('Use an ISO instant ending in Z or a UTC offset.'); const parsed = Date.parse(value); if (!Number.isFinite(parsed)) throw new Error('Use a valid date and time.'); return parsed; };
        const input: RehearsalCase['input'] = options.target.kind === 'trigger' ? { kind: 'event', source_ready: builder.ready, chat_mail: builder.chat,
          event: { platform: builder.platform, slug: builder.slug, entity_type: builder.entity, event_kind: builder.kind, record_id: 'fixture-record', at: at(builder.at),
            record: JSON.parse(builder.record), ...(builder.prev ? { prev: JSON.parse(builder.prev) } : {}), ...(builder.changed.trim() ? { changed_fields: builder.changed.split(',').map(item => item.trim()) } : {}), ...(builder.drain ? { in_drain: true } : {}) } }
          : { kind: 'clock', at: at(builder.at), last_run_at: builder.last ? at(builder.last) : null, next_run_at: at(builder.next), running: builder.running, auto_disabled: builder.tripped };
        const document = working(); document.cases.push({ id: crypto.randomUUID(), name: builder.name, expected: builder.expected as RehearsalCase['expected'], input });
        parseRehearsalDocument(document); text = pretty(document); changed(); builder.name = ''; builderDirty = false; builderEpoch++; render();
      } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); render(); }
    });
    const versions = card(root, 'Save and test');
    const advanced = node('details', versions); advanced.className = 'rehearsal-disclosure'; node('summary', advanced, 'Advanced rehearsal document');
    const filterNotice = node('p', advanced, 'Complete the payload filter before replacing the advanced document.'); filterNotice.dataset.rehearsalFilterNotice = '';
    input(advanced, 'Rehearsal document (JSON)', text, value => { text = value; filterDraft = null; changed(); }, true);
    const saveActions = actions(versions);
    button(saveActions, 'Save scenario version', () => { void save(); });
    button(saveActions, 'Test saved configuration', () => { if (!dirty) void test(); }, ['savedOnly', 'testOnly']).classList.add('automation-button--primary');
    if (state.draft?.base_digest !== state.live_digest && state.draft) node('p', versions, 'Live configuration changed. Reload, inspect it and save a new proposal before testing.');
    if (state.drafts.length) {
      const picker = node('div', versions); picker.className = 'rehearsal-version-picker';
      select(picker, 'Saved scenario version', selectedVersion || String(state.draft!.revision), state.drafts.map(item => [String(item.revision), item.revision + ' · ' + item.title]), value => { selectedVersion = value; });
      button(picker, 'Load selected scenario version', () => { if (!discard()) return; void run(async () => {
        const started = epoch, startedBuilder = builderEpoch, result = await options.call('automation.rehearsal.get', { target: options.target, draft_revision: Number(selectedVersion || state!.draft!.revision) }); if (disposed) return;
        state = result; savedText = pretty(result.draft!.document); if (epoch === started) { text = pretty(result.selected_draft!.document); filterDraft = null; } dirty = text !== savedText || filterDraft !== null; epoch++;
        pendingSave = null; review = null; comparison = null; message = 'Loaded a working copy. Save changes as a new version before testing.';
        if (builderEpoch === startedBuilder) clearBuilder();
      }, false); });
    }
    const result = comparison ?? state.qualification?.comparison;
    if (result) {
      const section = card(root, 'Scenario results'); section.dataset.rehearsalProof = '';
      node('p', section, result.passed + ' passed · ' + result.failed + ' failed');
      const results = node('ul', section); results.className = 'rehearsal-results';
      for (const item of result.cases) { const row = node('li', results); row.dataset.passed = String(item.passed); node('p', row, item.name + ': ' + item.current.verdict + ' → ' + item.candidate.verdict + ' · expected ' + item.expected + ' · ' + (item.passed ? 'passed' : 'failed') + ' · ' + item.candidate.detail); }
      for (const line of result.coverage) node('p', section, line).className = 'rehearsal-hint';
      if (state.qualification) button(actions(section), 'Review configuration activation', () => { void prepare(); }, ['savedOnly', 'proofOnly']);
    }
    if (review) {
      const section = card(root, 'Review exact configuration', 'Activation review'); section.dataset.rehearsalProof = '';
      node('p', section, 'Saved scenario version ' + review.draft_revision).className = 'rehearsal-hint';
      const configurations = node('div', section); configurations.className = 'rehearsal-comparison-grid';
      const before = node('div', configurations); node('h5', before, 'Current configuration'); pre(before, review.before);
      const after = node('div', configurations); node('h5', after, 'Tested configuration'); pre(after, review.after);
      node('p', section, 'Enabling automation can start ordinary runs after commit. This grants no execution permission and approves no held run.');
      button(actions(section), 'Activate reviewed configuration', () => { void activate(); }, ['savedOnly', 'reviewOnly']).classList.add('automation-button--primary');
    }
    if (state.history.length) { const history = node('details', root); history.className = 'rehearsal-card'; node('summary', history, 'Configuration activation history');
      const entries = node('div', history); entries.className = 'rehearsal-history-list';
      for (const item of state.history) { const entry = node('div', entries); entry.className = 'rehearsal-history-entry'; node('p', entry, 'Revision ' + item.sequence + ' · ' + new Date(item.at).toLocaleString());
        if (item.circuit_reset) node('p', entry, 'Timer circuit reset on activation.');
        node('p', entry, item.refresh_confirmed ? 'Runtime refresh confirmed.' : 'Runtime refresh was not confirmed for this activation.'); pre(entry, item.configuration); } }
    if (state.draft || state.history.length) deleteControls(root);
    for (const section of root.querySelectorAll<HTMLDetailsElement>('details')) if (open.has(section.querySelector('summary')?.textContent)) section.open = true;
    finish();
  };
  const loaded = reload(), timer = setInterval(gates, 2_000);
  return { whenLoaded: () => loaded, hasInFlightWork: () => busy, hasUnsavedChanges: () => dirty || builderDirty,
    dispose() { disposed = true; clearInterval(timer); root.remove(); } };
};
