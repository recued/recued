import { parsePermissionDocument, type Conn, type ServerRpcRegistry, type PermissionWorkbenchView, type PermissionDocument,
  type PermissionCase, type PermissionComparison, type PermissionReview, type PermissionSave, type PermissionActivate,
  type PermissionRestore, type PermissionMutation, type PermissionCatalogEntry } from '@recued/contracts';

/** A kept-alive owner editor. Reads and late replies never discard working edits. */
export const mountPermissionRegressionPanel = (options: { host: HTMLElement; contractId: string; call: Conn<ServerRpcRegistry>; beginWork?(): () => void; onActivated?(): void }) => {
  const doc = options.host.ownerDocument, root = doc.createElement('section'); root.dataset.permissionWorkbench = ''; options.host.append(root);
  root.style.cssText = 'min-width:0;overflow-wrap:anywhere';
  let state: PermissionWorkbenchView | null = null, text = '', savedText = '', dirty = false, busy = false, disposed = false, epoch = 0;
  let message = '', error = '', comparison: PermissionComparison | null = null, review: PermissionReview | null = null, deleteArmed = false;
  let selectedDraft = '';
  let focusAfterWork: string | null = null;
  let builderDirty = false;
  let pendingSave: PermissionSave | null = null, pendingActivation: PermissionActivate | null = null, pendingRestore: PermissionRestore | null = null;
  let pendingSaveText = '';
  let pendingDelete: { contract_id: string; expected_revision: number; request_id: string } | null = null;
  const builder = { name: '', credential: '', kind: 'operation', entry: '', expected: 'ask', args: '{}', connection: '', change: '', grant: 'false' };
  const pretty = (value: unknown) => JSON.stringify(value, null, 2);
  const blank = (): PermissionDocument => ({ title: 'Permission checks', cases: [], changes: [] });
  const working = (): PermissionDocument => {
    const value = JSON.parse(text || pretty(blank())) as PermissionDocument;
    // The advanced editor can contain incomplete or malformed JSON. Only let
    // renderable shapes reach the structured controls; saving still uses the
    // closed, bounded contract parser below.
    if (!value || typeof value.title !== 'string' || !Array.isArray(value.cases) || !Array.isArray(value.changes)
      || !value.cases.every(item => item && typeof item === 'object' && typeof item.id === 'string' && typeof item.name === 'string'
        && typeof item.credential_id === 'string' && ['allow', 'ask', 'deny'].includes(item.expected)
        && item.target && typeof item.target === 'object' && (item.target.kind === 'operation'
          ? typeof item.target.ingredient === 'string' && !!item.target.input && typeof item.target.input === 'object' && !Array.isArray(item.target.input)
          : item.target.kind === 'collection' ? typeof item.target.collection === 'string'
            : item.target.kind === 'topic' && typeof item.target.topic === 'string'))
      || !value.changes.every(item => item && typeof item === 'object' && typeof item.entry_key === 'string'
        && (item.granted === null || typeof item.granted === 'boolean'))) throw new Error('Use a title, cases and changes in the test document.');
    return value;
  };
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, parent: HTMLElement, content?: string) => {
    const value = doc.createElement(tag); if (content !== undefined) value.textContent = content; parent.append(value); return value;
  };
  const gates = () => {
    root.querySelectorAll<HTMLButtonElement>('button').forEach(button => {
      button.disabled = busy || button.dataset.savedOnly === 'true' && dirty
        || button.dataset.testOnly === 'true' && (!state?.draft || state.draft.base_digest !== state.live_digest)
        || button.dataset.proofOnly === 'true' && (!state?.qualification || state.qualification.expires_at <= Date.now())
        || button.dataset.reviewOnly === 'true' && (!review || review.expires_at <= Date.now() && !pendingActivation);
    });
    root.querySelectorAll<HTMLElement>('[data-permission-proof]').forEach(element => { element.hidden = dirty; });
    root.setAttribute('aria-busy', String(busy));
    const status = root.querySelector<HTMLElement>('[data-permission-message]'); if (status) status.textContent = dirty ? 'Working changes are not saved or tested.' : message;
  };
  const changed = () => {
    const editor = root.querySelector<HTMLTextAreaElement>('[aria-label="Permission test document (JSON)"]');
    if (editor && doc.activeElement !== editor) editor.value = text;
    epoch++; dirty = text !== savedText; review = null; pendingActivation = null; error = ''; gates();
  };
  const edit = (change: (value: PermissionDocument) => void, repaint = true) => {
    try { const value = working(); change(value); text = pretty(value); changed(); if (repaint) render(); }
    catch (cause) { error = cause instanceof Error ? cause.message : String(cause); render(); }
  };
  const run = async (action: () => Promise<void>, tracked = true) => {
    if (busy || disposed) return;
    focusAfterWork = root.contains(doc.activeElement) ? (doc.activeElement as HTMLElement).dataset.permissionFocus ?? null : null;
    const release = tracked ? options.beginWork?.() : undefined;
    busy = true; error = '';
    try { render(); await action(); } catch (cause) { if (!disposed) error = cause instanceof Error ? cause.message : String(cause); }
    finally { release?.(); busy = false; if (!disposed) render(); focusAfterWork = null; }
  };
  const accept = (result: PermissionMutation, started: number) => {
    const draft = result.saved_draft ?? result.draft;
    state = { ...result, revision: result.mutation_revision, draft,
      qualification: result.qualification?.draft_revision === draft?.revision ? result.qualification : null };
    if (result.saved_draft) {
      savedText = pretty(result.saved_draft.document);
      if (epoch === started) { text = savedText; dirty = false; } else dirty = text !== savedText;
    }
    comparison = null; review = null; pendingSave = null; pendingActivation = null; pendingRestore = null; pendingDelete = null;
  };
  const refresh = () => run(async () => {
    const started = epoch, result = await options.call('contract.regression.get', { contract_id: options.contractId }); if (disposed) return;
    state = result; savedText = pretty(result.draft?.document ?? blank());
    if (epoch === started) { text = savedText; dirty = false; } else dirty = text !== savedText;
    comparison = null; review = null; pendingSave = null; pendingActivation = null; pendingRestore = null; pendingDelete = null; message = 'Loaded saved permission tests.';
  }, false);
  const save = () => run(async () => {
    if (!state) return;
    if (!pendingSave) {
      pendingSave = { contract_id: options.contractId, expected_revision: state.revision, expected_live_digest: state.live_digest,
        request_id: crypto.randomUUID(), document: parsePermissionDocument(JSON.parse(text)) };
      pendingSaveText = text;
    }
    const started = text === pendingSaveText ? epoch : -1;
    const result = await options.call('contract.regression.save', pendingSave); if (disposed) return; accept(result, started);
    message = `Saved test version ${result.saved_draft!.revision}. ${dirty ? 'Save your newer working edits as another version.' : 'Live grants are unchanged.'}`;
  });
  const test = () => run(async () => {
    if (dirty || !state?.draft) return;
    const expected = state.revision, draft = state.draft.revision; state.qualification = null; review = null; comparison = null; gates();
    const result = await options.call('contract.regression.test', { contract_id: options.contractId, expected_revision: expected, draft_revision: draft });
    if (disposed) return; state = result; comparison = result.comparison; message = `${result.comparison.passed} passed · ${result.comparison.failed} failed. These results cover the saved examples.`;
  });
  const prepare = () => run(async () => {
    if (dirty || !state?.qualification || !state.draft) return;
    const result = await options.call('contract.regression.prepare', { contract_id: options.contractId, expected_revision: state.revision,
      draft_revision: state.draft.revision, receipt_id: state.qualification.receipt_id }); if (disposed) return;
    review = result; pendingActivation = null; message = 'Review the exact stored grant changes and impact coverage before activation.';
  });
  const activate = () => run(async () => {
    if (dirty || !review || !state) return; const started = epoch;
    pendingActivation ??= { contract_id: options.contractId, expected_revision: state.revision, review_id: review.review_id, request_id: crypto.randomUUID() };
    const result = await options.call('contract.regression.activate', pendingActivation); if (disposed) return; accept(result, started);
    message = `Activated permission revision ${result.activated!.sequence}. Existing dispatch checks still apply.`; options.onActivated?.();
  });
  const restore = (sequence: number) => run(async () => {
    if (!state) return; const started = epoch;
    pendingRestore ??= { contract_id: options.contractId, expected_revision: state.revision, expected_live_digest: state.live_digest, request_id: crypto.randomUUID(), sequence };
    if (pendingRestore.sequence !== sequence) throw new Error('Retry the pending restore or reload its recorded result first.');
    const result = await options.call('contract.regression.restore', pendingRestore); if (disposed) return; accept(result, started); pendingRestore = null;
    message = 'Restored as a draft. Adjust expectations, save, test and review before changing live grants.';
  });
  const confirmDiscard = () => !dirty || !doc.defaultView?.confirm || doc.defaultView.confirm('Discard unsaved permission test changes?');
  const button = (host: HTMLElement, title: string, action: () => void, flags: string[] = []) => {
    const value = node('button', host, title); value.dataset.permissionFocus = title; value.type = 'button'; value.style.cssText = 'min-height:44px;max-width:100%;white-space:normal;margin:4px 8px 4px 0';
    for (const flag of flags) value.dataset[flag] = 'true'; value.addEventListener('click', () => { if (!busy) action(); }); return value;
  };
  const input = (host: HTMLElement, title: string, value: string, onInput: (value: string) => void, multiline = false) => {
    const label = node('label', host, title); label.style.cssText = 'display:grid;gap:4px;min-width:0;margin:8px 0';
    const field = multiline ? node('textarea', label) : node('input', label); field.value = value; field.setAttribute('aria-label', title); field.dataset.permissionFocus = title;
    field.style.cssText = 'box-sizing:border-box;width:100%;min-width:0;min-height:44px;font:inherit';
    if (field.tagName === 'TEXTAREA') (field as HTMLTextAreaElement).rows = 4;
    field.addEventListener('input', () => onInput(field.value)); return field;
  };
  const select = (host: HTMLElement, title: string, value: string, choices: Array<[string, string]>, onChange: (value: string) => void) => {
    const label = node('label', host, title); label.style.cssText = 'display:grid;gap:4px;min-width:0;margin:8px 0'; const field = node('select', label);
    field.setAttribute('aria-label', title); field.dataset.permissionFocus = title; field.style.cssText = 'max-width:100%;min-width:0;width:100%;min-height:44px;font:inherit';
    for (const [key, title] of choices) { const option = node('option', field, title); option.value = key; }
    if (value && !choices.some(item => item[0] === value)) { const option = node('option', field, 'Unavailable selection'); option.value = value; }
    field.value = value; field.addEventListener('change', () => onChange(field.value)); return field;
  };
  const chosenEntry = (value: string): PermissionCatalogEntry | undefined => state?.catalog.find(item => `${item.entry_key}|${item.ingredient ?? ''}|${item.operation ?? ''}` === value);
  const entryValue = (entry: PermissionCatalogEntry) => `${entry.entry_key}|${entry.ingredient ?? ''}|${entry.operation ?? ''}`;
  const impact = (host: HTMLElement, value: PermissionComparison['impact']) => {
    node('h4', host, 'Possible effects on saved work'); for (const detail of value.coverage) node('p', host, detail);
    const list = node('ul', host); for (const item of value.entries) {
      const row = node('li', list, `${item.label} (${item.kind}) · ${item.detail}`);
      if (item.kind === 'review') { const link = node('a', row, ' Open review'); link.href = '#approvals/preapproval/' + encodeURIComponent(item.id); }
    }
    if (!value.total) node('p', host, 'No references found within this inspection.');
    if (value.truncated) node('p', host, `Showing ${value.entries.length} of at least ${value.total} references. Coverage is limited.`);
  };
  const deleteSaved = () => run(async () => {
          const started = epoch;
          pendingDelete ??= { contract_id: options.contractId, expected_revision: state!.revision, request_id: crypto.randomUUID() };
          await options.call('contract.regression.delete', pendingDelete); if (disposed) return;
          const result = await options.call('contract.regression.get', { contract_id: options.contractId }); if (disposed) return;
          state = result; savedText = pretty(blank()); if (epoch === started) text = savedText; dirty = text !== savedText; deleteArmed = false; comparison = null; review = null; pendingDelete = null; message = 'Deleted saved tests and history. Live grants are unchanged.';

  });
  const deleteControls = (host: HTMLElement) => {
    button(host, 'Delete saved tests and history', () => { deleteArmed = true; render(); });
    if (deleteArmed) { node('p', host, 'This deletes private cases, drafts and retained history. Live grants stay in place.');
      button(host, 'Confirm delete saved tests', () => { void deleteSaved(); }); }
  };
  const render = () => {
    if (disposed) return;
    const focused = root.contains(doc.activeElement) ? (doc.activeElement as HTMLElement).dataset.permissionFocus
      : doc.activeElement === doc.body ? focusAfterWork ?? undefined : undefined;
    const selection = doc.activeElement?.tagName === 'TEXTAREA' ? [(doc.activeElement as HTMLTextAreaElement).selectionStart, (doc.activeElement as HTMLTextAreaElement).selectionEnd] : null;
    const finish = () => {
      gates();
      if (focused && (!doc.activeElement || doc.activeElement === doc.body || root.contains(doc.activeElement))) {
        const target = [...root.querySelectorAll<HTMLElement>('[data-permission-focus]')].find(item => item.dataset.permissionFocus === focused);
        (target ?? root.querySelector<HTMLElement>('[data-permission-message]'))?.focus({ preventScroll: true });
        if (selection && target?.tagName === 'TEXTAREA') (target as HTMLTextAreaElement).setSelectionRange(selection[0]!, selection[1]!);
      }
    };
    const openSections = new Set([...root.querySelectorAll<HTMLDetailsElement>('details[open]')].map(item => item.querySelector('summary')?.textContent));
    root.replaceChildren(); node('h3', root, 'Permission tests and reviewed grants');
    node('p', root, 'Check a proposed grant change against saved examples, then review the exact revision before applying it. Ordinary grant controls remain available.');
    const status = node('p', root, message); status.dataset.permissionMessage = ''; status.dataset.permissionFocus = 'permission-message'; status.tabIndex = -1; status.setAttribute('role', 'status');
    const alert = node('p', root, error); alert.setAttribute('role', 'alert');
    button(root, 'Reload saved tests', () => { if (confirmDiscard()) void refresh(); });
    if (!state) { finish(); return; }
    if (!state.supported) { node('p', root, state.reason); if (state.draft || state.history.length) { node('p', root, 'Retained private tests and history can still be deleted.'); deleteControls(root); } finish(); return; }
    let document: PermissionDocument | null = null; try { document = working(); } catch { /* The advanced editor retains invalid working JSON. */ }
    input(root, 'Test suite title', document?.title ?? '', value => edit(item => { item.title = value; }, false));
    node('h4', root, 'Permission examples');
    for (const item of document?.cases ?? []) {
      const article = node('article', root); article.style.cssText = 'border:1px solid currentColor;padding:8px;margin:8px 0;min-width:0';
      const target = item.target.kind === 'operation' ? item.target.ingredient : item.target.kind === 'collection' ? item.target.collection + ' collection' : item.target.topic + ' topic';
      node('p', article, `${item.name} · ${target} · ${state.credentials.find(value => value.id === item.credential_id)?.label ?? 'Unavailable credential'}`);
      select(article, 'Expected result for ' + item.name, item.expected, [['allow', 'Allow'], ['ask', 'Ask for approval'], ['deny', 'Deny']], value => edit(valueDoc => { valueDoc.cases.find(row => row.id === item.id)!.expected = value as PermissionCase['expected']; }));
      if (item.target.kind === 'operation') { const details = node('details', article); node('summary', details, 'Example arguments'); const pre = node('pre', details, pretty(item.target.input)); pre.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere'; }
      button(article, 'Remove ' + item.name, () => edit(value => { value.cases = value.cases.filter(row => row.id !== item.id); }));
    }
    const addCase = node('details', root); node('summary', addCase, 'Add permission example');
    input(addCase, 'Example name', builder.name, value => { builder.name = value; builderDirty = true; });
    select(addCase, 'Credential', builder.credential, [['', 'Choose an existing credential'], ...state.credentials.map(item => [item.id, item.label + (item.active ? '' : ' (inactive)')] as [string, string])], value => { builder.credential = value; });
    select(addCase, 'Check', builder.kind, [['operation', 'Operation admission'], ['collection', 'Collection read grant'], ['topic', 'Topic read grant']], value => { builder.kind = value; builder.entry = ''; render(); });
    select(addCase, 'Operation or read grant', builder.entry, [['', 'Choose a declared target'], ...state.catalog.filter(item => item.kind === builder.kind).map(item => [entryValue(item), item.label] as [string, string])], value => { builder.entry = value; });
    select(addCase, 'Expected result', builder.expected, [['allow', 'Allow'], ['ask', 'Ask for approval'], ['deny', 'Deny']], value => { builder.expected = value; });
    if (builder.kind === 'operation') { input(addCase, 'Example arguments (JSON)', builder.args, value => { builder.args = value; builderDirty = true; }, true); input(addCase, 'Connection name (optional)', builder.connection, value => { builder.connection = value; builderDirty = true; }); }
    button(addCase, 'Add example', () => {
      const entry = chosenEntry(builder.entry);
      if (!entry || !builder.credential || !builder.name.trim()) { error = 'Choose a target and credential, and name the example.'; render(); return; }
      try { const args = JSON.parse(builder.args) as Record<string, never>;
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Use an object for example arguments.');
        const target: PermissionCase['target'] = entry.kind === 'collection' ? { kind: 'collection', collection: entry.entry_key.slice(5) }
          : entry.kind === 'topic' ? { kind: 'topic', topic: entry.entry_key.slice(11) } : { kind: 'operation', ingredient: entry.ingredient!,
            input: entry.operation ? { operation: entry.operation, args } : args, ...(builder.connection ? { connection: builder.connection } : {}) };
        edit(value => value.cases.push({ id: crypto.randomUUID(), name: builder.name, credential_id: builder.credential, expected: builder.expected as PermissionCase['expected'], target }));
        builder.name = ''; builderDirty = false; render();
      } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); render(); }
    });
    node('h4', root, 'Proposed grant changes');
    for (const change of document?.changes ?? []) {
      const label = state.catalog.find(item => item.entry_key === change.entry_key)?.label ?? change.entry_key;
      node('p', root, `${label}: ${change.granted === null ? 'Clear explicit row; use author default' : change.granted ? 'Grant' : 'Revoke'}`);
      button(root, 'Remove change for ' + label, () => edit(value => { value.changes = value.changes.filter(item => item.entry_key !== change.entry_key); }));
    }
    select(root, 'Permission to change', builder.change, [['', 'Choose a permission'], ...[...new Map(state.catalog.map(item => [item.entry_key, item])).values()].map(item => [item.entry_key, item.label] as [string, string])], value => { builder.change = value; });
    select(root, 'Proposed value', builder.grant, [['false', 'Revoke'], ['true', 'Grant'], ['null', 'Clear explicit row; use author default']], value => { builder.grant = value; });
    button(root, 'Add grant change', () => {
      if (!builder.change) { error = 'Choose a permission to change.'; render(); return; }
      edit(value => { value.changes = value.changes.filter(item => item.entry_key !== builder.change); value.changes.push({ entry_key: builder.change, granted: builder.grant === 'null' ? null : builder.grant === 'true' }); });
    });
    if (state.catalog_truncated) node('p', root, 'The picker shows the first 2,000 declared entries. The advanced editor can name another declared target.');
    const advanced = node('details', root); node('summary', advanced, 'Advanced test document'); input(advanced, 'Permission test document (JSON)', text, value => { text = value; changed(); }, true);
    button(root, 'Save test version', () => { void save(); });
    button(root, 'Test saved grant draft', () => { if (!dirty) void test(); }, ['savedOnly', 'testOnly']);
    if (state.draft && state.draft.base_digest !== state.live_digest) node('p', root, 'Live grants changed after this draft was saved. Reload, inspect the current grants and save a new draft before testing.');
    if (state.draft) node('p', root, `Saved draft ${state.draft.revision} · ${state.drafts.length} retained test versions.`);
    if (state.drafts.length) {
      select(root, 'Saved test version', selectedDraft || String(state.draft!.revision), state.drafts.map(item => [String(item.revision), `${item.revision} · ${item.title}`]), value => { selectedDraft = value; });
      button(root, 'Load selected test version', () => { if (!confirmDiscard()) return; void run(async () => {
        const started = epoch, result = await options.call('contract.regression.get', { contract_id: options.contractId, draft_revision: Number(selectedDraft || state!.draft!.revision) });
        if (disposed) return; state = result; savedText = pretty(result.draft?.document ?? blank());
        if (epoch === started) text = pretty(result.selected_draft!.document);
        dirty = text !== savedText; epoch++; comparison = null; review = null; pendingSave = null; pendingActivation = null;
        message = 'Loaded a saved test version. Save working changes as a new version before testing.';
      }, false); });
    }
    const result = comparison ?? state.qualification?.comparison;
    if (result) {
      const section = node('section', root); section.dataset.permissionProof = ''; node('h4', section, 'Admission comparison');
      for (const item of result.cases) node('p', section, `${item.name}: ${item.current.verdict} → ${item.candidate.verdict} · expected ${item.expected} · ${item.passed ? 'passed' : 'failed'} · ${item.candidate.detail}`);
      impact(section, result.impact);
      if (state.qualification) button(section, 'Review grant activation', () => { if (!dirty) void prepare(); }, ['savedOnly', 'proofOnly']);
    }
    if (review) {
      const section = node('section', root); section.dataset.permissionProof = ''; node('h4', section, 'Review exact grant changes');
      for (const change of review.changes) node('p', section, `${change.entry_key}: ${change.before === null ? 'Author default' : change.before ? 'Granted' : 'Revoked'} → ${change.after === null ? 'Author default' : change.after ? 'Granted' : 'Revoked'}`);
      impact(section, review.impact); node('p', section, 'This changes live grant rows. It does not approve a held action or restart work.');
      button(section, 'Activate reviewed grants', () => { if (!dirty) void activate(); }, ['savedOnly', 'reviewOnly']);
    }
    if (state.history.length) {
      const history = node('details', root); node('summary', history, 'Permission revision history');
      for (const item of state.history) { node('p', history, `Revision ${item.sequence} · ${item.kind === 'activated' ? 'Reviewed activation' : 'Observed baseline'} · ${new Date(item.created_at).toLocaleString()}`);
        button(history, 'Restore revision ' + item.sequence + ' as draft', () => { if (confirmDiscard()) void restore(item.sequence); }); }
      node('p', history, 'Restoration prepares grant changes for new tests and review. It cannot undo actions already performed.');
      deleteControls(history);
    }
    for (const detail of root.querySelectorAll<HTMLDetailsElement>('details')) if (openSections.has(detail.querySelector('summary')?.textContent)) detail.open = true;
    finish();
  };
  const loaded = refresh();
  const expiryTimer = setInterval(gates, 2_000);
  return { whenLoaded: () => loaded, hasInFlightWork: () => busy, hasUnsavedChanges: () => dirty || builderDirty,
    dispose() { disposed = true; clearInterval(expiryTimer); root.remove(); } };
};
