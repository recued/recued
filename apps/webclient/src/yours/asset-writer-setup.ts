import { HOME_ASSISTANT_WRITER_SETUP, type Asset, type AssetWriterReview, type AssetWriterSelection, type AssetWriterSetupChange, type AssetWriterSetupRead, type AssetWriterSetupReadRequest, type AssetWriterSetupStatus } from '@recued/contracts';
import { assetObservationFieldName } from './asset-observation-editor.js';
import { yoursDateTime } from './yours-dates.js';

export interface AssetWriterSetupCallers {
  read(input: AssetWriterSetupReadRequest): Promise<AssetWriterSetupRead>;
  preview(input: AssetWriterSelection): Promise<AssetWriterReview>;
  change(input: AssetWriterSetupChange): Promise<AssetWriterSetupStatus>;
}
const fieldName = (path: string) => assetObservationFieldName(path.split('.')[1] ?? path);
const time = yoursDateTime;
const frequencyName = (minutes: number) => `Every ${minutes} minutes`;
const outcomes = { accepted: 'Saved', confirmed: 'Confirmed current value', unchanged: 'Unchanged sample',
  manual_priority: 'Kept your manual entry', protected_source: 'Kept the higher priority source', before_handoff: 'Observation predates your permission', older_observation: 'Kept the newer observation' };
const checkOutcomes = { succeeded: 'Finished', running: 'In progress', unknown: 'Result unknown', failed: 'Failed', waiting: 'Waiting for an answer', skipped: 'Skipped' };
const sameSelection = (a: AssetWriterSelection, b: AssetWriterSelection) => a.asset_id === b.asset_id && a.definition_id === b.definition_id
  && a.connection.name === b.connection.name && a.connection.enrolled_at === b.connection.enrolled_at && a.connection.revision === b.connection.revision
  && a.source_id === b.source_id
  && a.interval_minutes === b.interval_minutes && [...a.fields].sort().join('|') === [...b.fields].sort().join('|');

/** Selection and preview are reads. Only the explicit approval creates an
 * automation; late source reads cannot replace a newer selection or a closed editor. */
export const mountAssetWriterSetup = (host: HTMLElement, asset: Asset, callers: AssetWriterSetupCallers, options: {
  field?: string; isCurrent(): boolean; dirty(value: boolean): void; busy(value: boolean): void; close(): void;
}) => {
  const doc = host.ownerDocument;
  let data: AssetWriterSetupRead | undefined;
  const definitionId = HOME_ASSISTANT_WRITER_SETUP.id;
  let connectionName = ''; let sourceId = ''; let selectedFields = new Set<string>(); let interval = 15;
  let review: AssetWriterReview | undefined; let requestId: string | undefined;
  let editing = false; let working = false; let stopped = false; let generation = 0; let error = ''; let notice = '';
  const receiptDetails = new Map<string, boolean>();
  let existingSourcesOpen = false;
  const current = (token: number) => !stopped && options.isCurrent() && generation === token;
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, parent: HTMLElement, text?: string) => {
    const element = doc.createElement(tag); if (text !== undefined) element.textContent = text; parent.append(element); return element;
  };
  const action = (parent: HTMLElement, text: string, run: () => void, name: string) => {
    const button = node('button', parent, text); button.type = 'button'; button.dataset.writerAction = name; button.dataset.writerFocus = name; button.disabled = working; button.onclick = run; return button;
  };
  const changed = () => { review = undefined; requestId = undefined; options.dirty(true); };
  const selectedConnection = () => data?.connections.find(row => row.name === connectionName);
  const definition = () => data?.definitions.find(row => row.id === definitionId);
  const source = () => data?.sources?.find(row => row.id === sourceId);
  const allowedFields = () => (definition()?.fields ?? []).filter(path => source()?.fields.includes(path));
  const selection = (): AssetWriterSelection => {
    const connection = selectedConnection();
    if (!connection || !sourceId || !selectedFields.size || !definition()) throw new Error('Choose a connection, source and at least one field');

    return { asset_id: asset.id, definition_id: definitionId, connection, source_id: sourceId,
      fields: [...selectedFields].sort(), interval_minutes: interval };
  };
  const setWorking = (value: boolean, mutation = false) => { working = value; options.busy(value && mutation); };
  const load = async (withSources = false, selected?: AssetWriterSelection['connection']) => {
    const connection = withSources ? selected ?? selectedConnection() : undefined;
    const token = ++generation; setWorking(true); error = ''; notice = ''; render();
    try {
      const response = await callers.read({ asset_id: asset.id, definition_id: definitionId,
        ...(connection ? { connection } : {}) });
      if (!current(token)) return;
      // A connection replaced under the same name is a fresh selection.
      if (connection && !response.connections.some(row => row.name === connection.name && row.revision === connection.revision)) throw new Error('The connection changed. Choose it again.');
      data = response;
      if (!response.setups.length) editing = true;
      if (response.setups.length && (!editing || review && response.setups.some(setup => setup.revision > review!.setup_revision
        && setup.state !== 'needs_review' && sameSelection(setup.selection, review!.selection)))) {
        editing = false; options.dirty(false); review = undefined; requestId = undefined;
      }
      if (withSources) {
        if (sourceId && !source()) { sourceId = ''; changed(); }


        const previous = selectedFields.size;
        selectedFields = new Set([...selectedFields].filter(path => allowedFields().includes(path)));
        if (selectedFields.size !== previous) changed();
      }
    } catch (value) {
      if (current(token)) {
        error = value instanceof Error ? value.message : String(value);
        if (connection) {
          // Recover the current account list without retrying provider IO or
          // silently adopting a replacement account under the same name.
          try {
            const metadata = await callers.read({ asset_id: asset.id, definition_id: definitionId });
            if (!current(token)) return;
            data = metadata; sourceId = ''; selectedFields.clear(); changed();
            if (!metadata.connections.some(row => row.name === connection.name && row.revision === connection.revision)) connectionName = '';
          } catch { /* Keep the original source error and the owner's draft. */ }
        }
      }
    }
    finally { if (current(token)) { setWorking(false); render(); } }
  };
  const refresh = () => working ? Promise.resolve() : load(!!connectionName && (editing || !data?.setups.length));
  const mutate = async (input: AssetWriterSetupChange) => {
    const token = ++generation; setWorking(true, true); error = ''; notice = 'Waiting for the server…'; render();
    try {
      const result = await callers.change(input); if (!current(token)) return;
      if (data) data.setups = [...data.setups.filter(row => row.id !== result.id), result];
      if (input.action === 'configure') {
        editing = false; review = undefined; requestId = undefined; options.dirty(false);
      } else if (editing && review?.selection.definition_id === result.selection.definition_id && review.setup_revision !== result.revision) changed();
      notice = result.state === 'scheduled' ? 'Automatic updates are scheduled.' : result.state === 'paused' ? 'Scheduled updates are paused. A check already in progress may still finish.' : 'Setup status refreshed.';
    } catch (value) {
      if (current(token)) { error = value instanceof Error ? value.message : String(value);
        notice = input.action === 'configure' ? 'Use Refresh status if the result was lost. Approving this same review again does not create another automation.'
          : 'Use Refresh status if the result was lost. Your source setup draft is kept.'; }
    } finally { if (current(token)) { setWorking(false); render(); } }
  };
  const prepare = async () => {
    const token = ++generation; setWorking(true); error = ''; render();
    try { const result = await callers.preview(selection()); if (current(token)) { review = result; requestId = globalThis.crypto.randomUUID(); } }
    catch (value) { if (current(token)) error = value instanceof Error ? value.message : String(value); }
    finally { if (current(token)) { setWorking(false); render(); host.querySelector<HTMLElement>('[data-writer-review]')?.focus(); } }
  };
  const showSetup = (parent: HTMLElement, setup: AssetWriterSetupStatus) => {
    const card = node('section', parent); card.className = 'yours-card'; card.dataset.writerSetup = setup.id;
    node('h3', card, setup.source_name); node('p', card, `${setup.connection_label} · ${frequencyName(setup.interval_minutes)}`);
    node('p', card, setup.state === 'scheduled' ? 'Scheduled' : setup.state === 'running' ? 'Checking now' : setup.state === 'needs_review' ? `${setup.scheduled ? 'Scheduled' : 'Paused'} · Needs review` : 'Paused').className = 'yours-state';
    if (setup.issue) node('p', card, setup.issue);
    if (setup.next_run_at) node('p', card, `Next scheduled check: ${time(setup.next_run_at)}`);
    if (setup.last_run) { node('p', card, `Last check: ${time(setup.last_run.at)} · ${checkOutcomes[setup.last_run.outcome]}`);
      if (setup.last_run.message) node('p', card, setup.last_run.message); }
    else node('p', card, 'No completed check is recorded here.');
    const receipts = node('dl', card); receipts.className = 'yours-writer-receipts';
    for (const item of setup.deliveries) {
      const field = node('div', receipts); node('dt', field, fieldName(item.path));
      const value = node('dd', field);
      if (item.delivery.status === 'no_receipt') node('p', value, 'No field submission on file.');
      else { const last = item.delivery.last_submission;
        node('p', value, outcomes[last.outcome]);
        node('p', value, item.delivery.last_accepted ? `Last accepted: ${time(item.delivery.last_accepted.at)}` : 'No accepted submission on file.').className = 'yours-muted';
        const details = node('details', value); const key = JSON.stringify([setup.id, item.path]); details.dataset.writerReceipt = key;
        details.open = receiptDetails.get(key) ?? false; node('summary', details, 'Submission details');
        node('p', details, `Submitted ${time(last.at)} · Observed ${time(last.observation_at)}`);
        if (item.delivery.last_accepted) node('p', details, `Accepted ${time(item.delivery.last_accepted.at)} · Observed ${time(item.delivery.last_accepted.observation_at)}`); }
    }
    const actions = node('div', card); actions.className = 'yours-actions';
    if (setup.state !== 'needs_review') action(actions, 'Run now', () => { void mutate({ action: 'run', asset_id: asset.id, setup_id: setup.id, revision: setup.revision }); }, 'run')
      .disabled = working || setup.last_run?.outcome === 'waiting';
    if (setup.last_run?.outcome === 'waiting') node('a', actions, 'Review approval').href = '#approvals';
    action(actions, setup.scheduled || setup.state === 'running' ? 'Pause' : 'Resume', () => { void mutate({
      action: setup.scheduled || setup.state === 'running' ? 'pause' : 'resume', asset_id: asset.id, setup_id: setup.id, revision: setup.revision }); }, 'switch')
      .disabled = working || !setup.scheduled && setup.state !== 'running' && !setup.can_resume;
    action(actions, 'Review setup', () => { editing = true; connectionName = setup.selection.connection.name; sourceId = setup.selection.source_id;
      interval = setup.interval_minutes; selectedFields = new Set(setup.fields); changed(); void load(true, setup.selection.connection); }, `edit-${setup.id}`)
      .disabled = working || !['active', 'lent'].includes(asset.status);
    const runs = node('a', actions, 'View runs'); runs.href = '#runs';
  };
  const render = () => {
    if (stopped || !options.isCurrent()) return;
    const focused = (doc.activeElement as HTMLElement | null)?.getAttribute('data-writer-focus');
    const token = generation;
    if (focused) queueMicrotask(() => { if (current(token) && doc.activeElement === doc.body)
      (host.querySelector<HTMLElement>(`[data-writer-focus="${focused}"]:not(:disabled)`) ?? host.querySelector<HTMLElement>('h2'))?.focus(); });
    for (const details of host.querySelectorAll<HTMLDetailsElement>('[data-writer-receipt]')) receiptDetails.set(details.dataset.writerReceipt!, details.open);
    const previousSources = host.querySelector<HTMLDetailsElement>('[data-writer-existing]'); if (previousSources) existingSourcesOpen = previousSources.open;
    host.replaceChildren(); host.dataset.yoursWriterSetup = '';
    const statusView = !!data?.setups.length && !editing && !review;
    const heading = node('h2', host, review ? 'Review automatic updates' : statusView ? 'Automatic updates' : 'Choose a source'); heading.tabIndex = -1; heading.dataset.writerFocus = 'heading';
    node('p', host, asset.name).className = 'yours-muted';
    const steps = node('ol', host); steps.className = 'yours-steps'; steps.setAttribute('aria-label', 'Source setup');
    for (const [index, title] of ['Choose', 'Review', 'Status'].entries()) { const step = node('li', steps, title); if (index === (review ? 1 : statusView ? 2 : 0)) step.setAttribute('aria-current', 'step'); }
    const status = node('p', host, error || notice || (working ? 'Loading source setup…' : ''));
    status.setAttribute('role', error ? 'alert' : 'status');
    status.hidden = !status.textContent;
    const top = node('div', host); top.className = 'yours-actions';
    action(top, 'Refresh status', () => { void refresh(); }, 'refresh');
    action(top, 'Close', options.close, 'close');
    if (!data) return;
    const showExisting = () => {
      if (statusView) for (const setup of data!.setups) showSetup(host, setup);
      else if (data!.setups.length) { const existing = node('details', host); existing.className = 'yours-disclosure'; existing.dataset.writerExisting = ''; existing.open = existingSourcesOpen;
        node('summary', existing, 'Existing automatic sources'); for (const setup of data!.setups) showSetup(existing, setup); }
    };
    if (statusView) showExisting();
    if (!['active', 'lent'].includes(asset.status)) { if (!statusView) showExisting(); node('p', host, 'Automatic updates require an active or lent asset. Existing schedules can be paused here.'); return; }
    if (data.setups.length && !editing) {
      return;
    }
    const selectedDefinition = definition(); const provider = 'Home Assistant';
    if (!selectedDefinition?.available) { node('p', host, `Install or update the ${provider} pack to set up source updates here.`); node('a', host, 'Open Discover').href = '#discover'; return; }
    if (!selectedDefinition.fields.length) { node('p', host, 'This asset has no battery, availability, flicker or problem fields for this source to update. Review its type and fields first.'); return; }
    if (!data.connections.length) { node('p', host, `Connect ${provider} first, then refresh this setup.`); node('a', host, 'Open Connections').href = '#settings/connections'; return; }
    if (review) {
      const panel = node('section', host); panel.className = 'yours-writer-review'; panel.dataset.writerReview = ''; panel.tabIndex = -1;
      node('h3', panel, 'What you’re approving');
      const details = node('dl', panel); details.className = 'yours-review-facts';
      for (const [name, value] of [['Asset', review.asset_name], ['Connection', review.selection.connection.label], ['Device', review.source.name],
        ['Current source sample', review.source.sample], ...([]),
        ['Fields it may report', review.selection.fields.map(fieldName).join(', ')], ['Frequency', frequencyName(review.selection.interval_minutes)]]) {
        const pair = node('div', details); node('dt', pair, name); node('dd', pair, value);
      }
      node('p', panel, 'Approval saves this setup and runs its first check. The schedule starts after that check finishes successfully.');
      node('p', panel, 'Your manual entries keep their priority; allow automatic updates on the field separately when you want to hand it over.');
      const actions = node('div', panel); actions.className = 'yours-actions';
      action(actions, 'Approve and start updates', () => { if (review && requestId) void mutate({ action: 'configure', review, request_id: requestId }); }, 'approve').className = 'yours-primary';
      action(actions, 'Back to source selection', () => { review = undefined; requestId = undefined; render(); }, 'back');
      showExisting(); return;
    }
    const form = node('form', host);
    const select = (label: string, name: string, choices: Array<[string, string]>, value: string) => {
      const wrapper = node('label', form, label); const control = node('select', wrapper); control.name = name; control.dataset.writerFocus = name;
      control.setAttribute('aria-label', label);
      for (const [key, text] of choices) { const option = node('option', control, text); option.value = key; }
      control.value = value; control.disabled = working; return control;
    };
    const account = select(`${provider} connection`, 'connection', [['', 'Choose a connection'], ...data.connections.map(row => [row.name, row.label] as [string, string])], connectionName);
    account.onchange = () => { connectionName = account.value; sourceId = ''; selectedFields.clear(); if (data) { delete data.sources; } changed(); void load(true); };

    const choices = data.sources ?? [];
    const devices = select('Device or sensor', 'source', [['', 'Choose a device'], ...choices.map(row => [row.id, `${row.name} · ${row.id}`] as [string, string])], sourceId);
    devices.disabled = working || !data.sources;
    devices.onchange = () => { sourceId = devices.value;
      selectedFields = new Set(options.field && allowedFields().includes(options.field) ? [options.field] : allowedFields()); changed();
      render(); };
    if (data.sources && !data.sources.length) node('p', form, 'No compatible device health sources were found. Battery percentage, reported problems and supported device availability are offered here.');

    if (data.sources_truncated) node('p', form, 'Showing the first 1,000 sources by name.');
    if (source()) node('p', form, `Current source sample: ${source()!.sample}`);
    {
      const fields = node('fieldset', form); node('legend', fields, 'Fields this source may update');
      for (const path of allowedFields()) { const label = node('label', fields); const checkbox = node('input', label); checkbox.type = 'checkbox'; checkbox.name = path;
        checkbox.setAttribute('aria-label', fieldName(path));
        checkbox.checked = selectedFields.has(path); checkbox.disabled = working; node('span', label, fieldName(path));
        checkbox.onchange = () => { if (checkbox.checked) selectedFields.add(path); else selectedFields.delete(path); changed(); render(); }; }
    }
    const frequency = select('Check frequency', 'frequency', ([5, 15, 30, 60]).map(minutes => [String(minutes), frequencyName(minutes)]), String(interval));
    frequency.onchange = () => { interval = Number(frequency.value); changed(); };
    const actions = node('div', form); actions.className = 'yours-actions';
    const button = node('button', actions, 'Review setup'); button.type = 'submit'; button.className = 'yours-primary'; button.disabled = working || !sourceId || !selectedFields.size;
    form.onsubmit = event => { event.preventDefault(); if (!working) void prepare(); };
    showExisting();
    if (focused) host.querySelector<HTMLElement>(`[data-writer-focus="${focused}"]`)?.focus();
  };
  const loaded = load();
  return { whenLoaded: () => loaded, refresh,
    dispose() { stopped = true; generation++; options.busy(false); } };
};
