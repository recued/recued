import { parseRehearsalConfiguration, parseRehearsalDocument, type Conn, type ServerRpcRegistry, type RehearsalTarget,
  type RehearsalDocument, type RehearsalView, type RehearsalMutation, type RehearsalSave, type RehearsalActivate,
  type RehearsalComparison, type RehearsalReview, type RehearsalCase } from '@recued/contracts';

/** Kept alive by the route; pending writes retain their identity across lost replies. */
export const mountAutomationRehearsalPanel = (options: { host: HTMLElement; target: RehearsalTarget; call: Conn<ServerRpcRegistry>;
  beginWork?(): () => void; onActivated?(): void }) => {
  const doc = options.host.ownerDocument, root = doc.createElement('section'); options.host.append(root); root.dataset.automationRehearsal = '';
  root.style.cssText = 'min-width:0;overflow-wrap:anywhere';
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
  const builderChanged = () => { builderDirty = true; builderEpoch++; };
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
    item.style.cssText = 'min-height:44px;max-width:100%;white-space:normal;margin:4px 8px 4px 0'; for (const flag of flags) item.dataset[flag] = 'true';
    item.addEventListener('click', () => { if (!busy) action(); }); return item;
  };
  const input = (host: HTMLElement, title: string, value: string, update: (value: string) => void, multiline = false) => {
    const label = node('label', host, title); label.style.cssText = 'display:grid;gap:4px;margin:8px 0;min-width:0';
    const field = multiline ? node('textarea', label) : node('input', label); field.value = value; field.setAttribute('aria-label', title); field.dataset.rehearsalFocus = title;
    field.style.cssText = 'box-sizing:border-box;width:100%;min-width:0;min-height:44px;font:inherit';
    if (multiline) (field as HTMLTextAreaElement).rows = 4; field.addEventListener('input', () => update(field.value)); return field;
  };
  const select = (host: HTMLElement, title: string, value: string, choices: Array<[string, string]>, update: (value: string) => void) => {
    const label = node('label', host, title); label.style.cssText = 'display:grid;gap:4px;margin:8px 0;min-width:0'; const field = node('select', label);
    field.setAttribute('aria-label', title); field.dataset.rehearsalFocus = title; field.style.cssText = 'min-width:0;max-width:100%;min-height:44px';
    for (const [key, title] of choices) { const item = node('option', field, title); item.value = key; } field.value = value;
    field.addEventListener('change', () => update(field.value)); return field;
  };
  const checkbox = (host: HTMLElement, title: string, value: boolean, update: (value: boolean) => void) => {
    const label = node('label', host); label.style.cssText = 'display:flex;gap:8px;align-items:center;min-height:44px';
    const field = node('input', label); field.type = 'checkbox'; field.checked = value; field.setAttribute('aria-label', title); field.dataset.rehearsalFocus = title;
    node('span', label, title); field.addEventListener('change', () => update(field.checked));
  };
  const pre = (host: HTMLElement, value: unknown) => { const item = node('pre', host, pretty(value)); item.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;max-width:100%'; };
  const deleteControls = (host: HTMLElement) => {
    button(host, 'Delete saved rehearsal and history', () => { deleteArmed = true; render(); });
    if (deleteArmed) { node('p', host, 'This deletes private scenarios and history. It leaves live automation in place.');
      button(host, 'Confirm delete rehearsal', () => { void run(async () => {
        const started = epoch, keepWorking = dirty || builderDirty; pendingDelete ??= { target: options.target, expected_revision: state!.revision, request_id: crypto.randomUUID() };
        await options.call('automation.rehearsal.delete', pendingDelete);
        const result = await options.call('automation.rehearsal.get', { target: options.target }); if (disposed) return;
        state = result; savedText = pretty(blank()); if (!keepWorking && epoch === started) { text = savedText; filterDraft = null; } dirty = text !== savedText || filterDraft !== null;
        review = null; comparison = null; pendingSave = null; pendingDelete = null; deleteArmed = false; message = 'Deleted saved rehearsal. Live automation is unchanged.';
      }); }); }
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
    root.replaceChildren(); node('h3', root, 'Rehearsal and reviewed activation');
    node('p', root, 'Check event or clock scenarios, review the configuration, then activate it. Rehearsal starts no live runs. Ordinary automation controls remain available.');
    const status = node('p', root, message); status.setAttribute('role', 'status'); status.tabIndex = -1; status.dataset.rehearsalStatus = ''; status.dataset.rehearsalFocus = 'status';
    node('p', root, error).setAttribute('role', 'alert');
    button(root, 'Reload saved rehearsal', () => { if (discard()) void reload(); });
    if (!state) { finish(); return; }
    if (!state.supported || !state.current) { node('p', root, state.reason); if (state.draft || state.history.length) deleteControls(root); finish(); return; }
    let value: RehearsalDocument | null = null; try { value = working(); } catch { /* Preserve malformed advanced text without rendering unsafe shapes. */ }
    input(root, 'Rehearsal title', value?.title ?? '', title => edit(item => { item.title = title; }, false));
    node('h4', root, 'Proposed configuration'); node('p', root, 'Time zone: ' + state.time_zone + (state.interval_ms === null ? '' : ' · Recipe timer interval: ' + state.interval_ms + ' ms'));
    if (value) {
      checkbox(root, 'Automation enabled after activation', value.candidate.enabled, enabled => edit(item => { item.candidate.enabled = enabled; }));
      const candidate = value.candidate;
      if (candidate.kind === 'schedule') {
        input(root, 'Cron expression', candidate.cron_expression, cron => edit(item => { if (item.candidate.kind === 'schedule') item.candidate.cron_expression = cron; }, false));
        select(root, 'Missed-run policy', candidate.missed_policy, [['auto', 'Decide for me'], ['ask', 'Ask me'], ['skip', 'Skip missed runs'], ['catch_up', 'Catch up']], policy => edit(item => { if (item.candidate.kind === 'schedule') item.candidate.missed_policy = policy as typeof candidate.missed_policy; }));
      } else if (candidate.kind === 'trigger') {
        input(root, 'Event pattern', candidate.pattern, pattern => edit(item => { if (item.candidate.kind === 'trigger') item.candidate.pattern = pattern; }, false));
        input(root, 'Payload filter (JSON or null)', filterDraft ?? pretty(candidate.filter), filter => {
          filterDraft = filter;
          try {
            const parsed = parseRehearsalConfiguration({ kind: 'trigger', enabled: false, pattern: '**', filter: JSON.parse(filter), fields: null, watch_interval_ms: null });
            const document = working(); if (document.candidate.kind === 'trigger' && parsed.kind === 'trigger') {
              document.candidate.filter = parsed.filter; text = pretty(document); filterDraft = null;
            }
          } catch { /* Preserve incomplete filter text; advanced replacement waits for it. */ }
          changed();
        }, true);
        input(root, 'Watched changed fields (comma separated)', candidate.fields?.join(', ') ?? '', fields => edit(item => { if (item.candidate.kind === 'trigger') item.candidate.fields = fields.trim() ? fields.split(',').map(value => value.trim()).filter(Boolean) : null; }, false));
      } else checkbox(root, 'Reset a tripped timer circuit on activation', candidate.reset_circuit, reset => edit(item => { if (item.candidate.kind === 'timer') item.candidate.reset_circuit = reset; }));
    }
    node('h4', root, 'Saved scenarios');
    for (const item of value?.cases ?? []) {
      node('p', root, item.name + ' · ' + item.input.kind + ' scenario');
      select(root, 'Expected result for ' + item.name, item.expected, [['start', 'Request a run'], ['skip', 'Skip'], ['ask', 'Wait for owner']], expected => edit(value => { value.cases.find(value => value.id === item.id)!.expected = expected as RehearsalCase['expected']; }));
      button(root, 'Remove ' + item.name, () => edit(value => { value.cases = value.cases.filter(value => value.id !== item.id); }));
    }
    const add = node('details', root); node('summary', add, 'Add scenario');
    input(add, 'Scenario name', builder.name, value => { builder.name = value; builderChanged(); });
    select(add, 'Scenario expected result', builder.expected, [['start', 'Request a run'], ['skip', 'Skip'], ['ask', 'Wait for owner']], value => { builder.expected = value; builderChanged(); });
    const buildText = (label: string, field: 'at' | 'last' | 'next' | 'platform' | 'slug' | 'entity' | 'kind' | 'record' | 'prev' | 'changed', multiline = false) =>
      input(add, label, builder[field], value => { builder[field] = value; builderChanged(); }, multiline);
    buildText('Scenario instant (ISO 8601 with UTC offset)', 'at');
    if (options.target.kind === 'trigger') {
      buildText('Event platform', 'platform'); buildText('Event source', 'slug'); buildText('Event entity type', 'entity'); buildText('Event kind', 'kind');
      buildText('Current record (JSON)', 'record', true); buildText('Previous record (JSON, optional)', 'prev', true); buildText('Changed fields (comma separated)', 'changed');
      checkbox(add, 'Fixture source is ready', builder.ready, value => { builder.ready = value; builderChanged(); });
      checkbox(add, 'Fixture is initial backfill or drain', builder.drain, value => { builder.drain = value; builderChanged(); });
      checkbox(add, 'Fixture mail is a conversation with Recued', builder.chat, value => { builder.chat = value; builderChanged(); });
    } else {
      buildText('Last run instant (ISO 8601, blank for never)', 'last'); buildText('Timer due instant (ISO 8601)', 'next');
      checkbox(add, 'Fixture has a running execution', builder.running, value => { builder.running = value; builderChanged(); });
      checkbox(add, 'Fixture timer circuit is tripped', builder.tripped, value => { builder.tripped = value; builderChanged(); });
    }
    button(add, 'Clear scenario form', () => { clearBuilder(); render(); });
    button(add, 'Add scenario to rehearsal', () => {
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
    const advanced = node('details', root); node('summary', advanced, 'Advanced rehearsal document');
    const filterNotice = node('p', advanced, 'Complete the payload filter before replacing the advanced document.'); filterNotice.dataset.rehearsalFilterNotice = '';
    input(advanced, 'Rehearsal document (JSON)', text, value => { text = value; filterDraft = null; changed(); }, true);
    button(root, 'Save scenario version', () => { void save(); });
    button(root, 'Test saved configuration', () => { if (!dirty) void test(); }, ['savedOnly', 'testOnly']);
    if (state.draft?.base_digest !== state.live_digest && state.draft) node('p', root, 'Live configuration changed. Reload, inspect it and save a new proposal before testing.');
    if (state.drafts.length) {
      select(root, 'Saved scenario version', selectedVersion || String(state.draft!.revision), state.drafts.map(item => [String(item.revision), item.revision + ' · ' + item.title]), value => { selectedVersion = value; });
      button(root, 'Load selected scenario version', () => { if (!discard()) return; void run(async () => {
        const started = epoch, startedBuilder = builderEpoch, result = await options.call('automation.rehearsal.get', { target: options.target, draft_revision: Number(selectedVersion || state!.draft!.revision) }); if (disposed) return;
        state = result; savedText = pretty(result.draft!.document); if (epoch === started) { text = pretty(result.selected_draft!.document); filterDraft = null; } dirty = text !== savedText || filterDraft !== null; epoch++;
        pendingSave = null; review = null; comparison = null; message = 'Loaded a working copy. Save changes as a new version before testing.';
        if (builderEpoch === startedBuilder) clearBuilder();
      }, false); });
    }
    const result = comparison ?? state.qualification?.comparison;
    if (result) {
      const section = node('section', root); section.dataset.rehearsalProof = ''; node('h4', section, 'Dispatch-selection comparison');
      for (const item of result.cases) node('p', section, item.name + ': ' + item.current.verdict + ' → ' + item.candidate.verdict + ' · expected ' + item.expected + ' · ' + (item.passed ? 'passed' : 'failed') + ' · ' + item.candidate.detail);
      for (const line of result.coverage) node('p', section, line);
      if (state.qualification) button(section, 'Review configuration activation', () => { void prepare(); }, ['savedOnly', 'proofOnly']);
    }
    if (review) {
      const section = node('section', root); section.dataset.rehearsalProof = ''; node('h4', section, 'Review exact configuration');
      node('h5', section, 'Current configuration'); pre(section, review.before); node('h5', section, 'Tested configuration'); pre(section, review.after);
      node('p', section, 'Enabling automation can start ordinary runs after commit. This grants no execution permission and approves no held run.');
      button(section, 'Activate reviewed configuration', () => { void activate(); }, ['savedOnly', 'reviewOnly']);
    }
    if (state.history.length) { const history = node('details', root); node('summary', history, 'Configuration activation history');
      for (const item of state.history) { node('p', history, 'Revision ' + item.sequence + ' · ' + new Date(item.at).toLocaleString());
        if (item.circuit_reset) node('p', history, 'Timer circuit reset on activation.');
        node('p', history, item.refresh_confirmed ? 'Runtime refresh confirmed.' : 'Runtime refresh was not confirmed for this activation.'); pre(history, item.configuration); } }
    if (state.draft || state.history.length) deleteControls(root);
    for (const section of root.querySelectorAll<HTMLDetailsElement>('details')) if (open.has(section.querySelector('summary')?.textContent)) section.open = true;
    finish();
  };
  const loaded = reload(), timer = setInterval(gates, 2_000);
  return { whenLoaded: () => loaded, hasInFlightWork: () => busy, hasUnsavedChanges: () => dirty || builderDirty,
    dispose() { disposed = true; clearInterval(timer); root.remove(); } };
};
