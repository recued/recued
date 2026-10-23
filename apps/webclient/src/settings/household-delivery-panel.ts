import type { YoursCommand, YoursSnapshot } from '@recued/contracts';
import { e } from '@recued/ui-shared';
import { classifyRpcError } from '../shell/rpc-error-copy.js';

export interface HouseholdDeliveryPanelOptions {
  host: HTMLElement; document?: Document;
  read(): Promise<NonNullable<YoursSnapshot['household']>>;
  save(input: Extract<YoursCommand, { action: 'household.telegram' | 'household.home_assistant' }>): Promise<unknown>;
}
export const mountHouseholdDeliveryPanel = (opts: HouseholdDeliveryPanelOptions) => {
  type Kind = 'telegram' | 'home_assistant';
  type Save = Parameters<HouseholdDeliveryPanelOptions['save']>[0];
  type Confirmation = { kind: Kind; focusName: string | null };
  const labels = { telegram: 'Household Telegram', home_assistant: 'Household Home Assistant' };
  const doc = opts.document ?? document; const root = doc.createElement('section'); root.dataset.householdDelivery = ''; opts.host.append(root);
  let disposed = false; let busy = false; let value: NonNullable<YoursSnapshot['household']> | undefined;
  let pendingRead: Promise<void> | null = null;
  let readFailed = false;
  let showingReadFeedback = false;
  let confirming: Confirmation | null = null;
  const unconfirmedSaves = new Set<Kind>();
  // Keep the same control attached through loading and repeated failures so
  // native keyboard focus does not fall back to the page body.
  const readFeedback = doc.createElement('div');
  const readStatus = doc.createElement('p');
  readStatus.setAttribute('data-household-read-status', '');
  readStatus.setAttribute('data-household-status', '');
  readStatus.setAttribute('aria-atomic', 'true');
  readStatus.setAttribute('tabindex', '-1');
  const retry = doc.createElement('button');
  retry.type = 'button'; retry.textContent = 'Retry household delivery';
  retry.className = 'rx-btn rx-btn-secondary'; retry.style.minHeight = '44px';
  retry.setAttribute('data-household-retry', ''); retry.hidden = true;
  readFeedback.append(readStatus);
  const paintControls = () => {
    if (disposed) return;
    for (const node of root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('form input,form select,form button')) {
      node.disabled = busy || readFailed || confirming !== null;
    }
  };
  const showReadFeedback = (loading: boolean, error?: unknown) => {
    readStatus.setAttribute('role', loading ? 'status' : 'alert');
    readStatus.textContent = loading
      ? confirming ? 'Saved. Checking the current household settings…'
        : readFailed ? 'Retrying household delivery…' : 'Loading household delivery…'
      : `${confirming ? `${labels[confirming.kind]} was saved, but Recued could not check the current settings: ` : ''}${error instanceof Error ? error.message : String(error)}`;
    retry.textContent = confirming ? 'Retry checking saved settings' : 'Retry household delivery';
    retry.hidden = !readFailed;
    if (readFailed) { if (retry.parentElement !== readFeedback) readFeedback.append(retry); }
    else retry.remove();
    retry.setAttribute('aria-disabled', String(loading));
    retry.setAttribute('aria-busy', String(loading));
    if (!confirming && !showingReadFeedback) {
      root.replaceChildren(readFeedback);
      showingReadFeedback = true;
    }
    paintControls();
  };
  type Choice = { name: string; enrolled_at: number } | null;
  let telegramDraft: { choice: Choice; members: string } | undefined;
  let haDraft: { choice: Choice; entity: string } | undefined;
  const sameChoice = (a: Choice, b: Choice) => a === null ? b === null
    : b !== null && a.name === b.name && a.enrolled_at === b.enrolled_at;
  const telegramRestored = (draft: NonNullable<typeof telegramDraft>) => {
    const selected = value?.telegram;
    return sameChoice(draft.choice, selected ? { name: selected.connection_name, enrolled_at: selected.connection_enrolled_at } : null)
      && draft.members === (selected?.members.filter(id => id !== selected.expected_sender).join(', ') ?? '');
  };
  const haRestored = (draft: NonNullable<typeof haDraft>) => {
    const ha = value?.home_assistant;
    if (!ha) return false;
    const selected = ha.selection;
    return sameChoice(draft.choice, selected ? { name: selected.connection_name, enrolled_at: selected.connection_enrolled_at } : null)
      && draft.entity === (selected?.entity_id ?? '');
  };
  const clearRestoredDrafts = () => {
    // A failed write may already have reached the server. Keep its restored
    // values until a fresh read can compare them with the actual outcome.
    if (telegramDraft && !unconfirmedSaves.has('telegram') && telegramRestored(telegramDraft)) telegramDraft = undefined;
    if (haDraft && !unconfirmedSaves.has('home_assistant') && haRestored(haDraft)) haDraft = undefined;
  };
  const hasEditedValues = () => (telegramDraft !== undefined && !telegramRestored(telegramDraft))
    || (haDraft !== undefined && !haRestored(haDraft));
  const message = (text: string, failed = false) => { readStatus.textContent = text; readStatus.setAttribute('role', failed ? 'alert' : 'status'); };
  const focusSavedForm = ({ kind, focusName }: Confirmation) => {
    const form = kind === 'telegram' ? root.querySelector('form') : root.querySelector('[data-household-home-assistant] form');
    const named = focusName ? Array.from(form?.querySelectorAll<HTMLElement>('[name]') ?? [])
      .find(node => node.getAttribute('name') === focusName) : undefined;
    (named ?? form?.querySelector<HTMLElement>('button[type="submit"]'))?.focus();
  };
  const render = () => {
    if (!value || disposed) return;
    showingReadFeedback = false;
    const selected = value.telegram; const choice = telegramDraft ? telegramDraft.choice : selected ? { name: selected.connection_name, enrolled_at: selected.connection_enrolled_at } : null;
    const index = value.telegram_connections.findIndex(row => row.name === choice?.name && row.enrolled_at === choice.enrolled_at);
    root.innerHTML = `<h3>Household Telegram</h3><p>Household items go to this group. Selected members can use Done on the original task. Private reminders follow your personal notification connection.</p>
      <form><label>Household group <select name="group" aria-label="Household group"><option value=""${!choice ? ' selected' : ''}>Off</option>
      ${choice && index < 0 ? '<option value="missing" selected disabled>Selected group is unavailable</option>' : ''}
      ${value.telegram_connections.map((row, at) => `<option value="${at}"${at === index ? ' selected' : ''}>${e(row.name)} · ${e(row.recipient)}</option>`).join('')}</select></label>
      <label>Other member user IDs <input name="members" aria-label="Other member user IDs" value="${e(telegramDraft?.members ?? selected?.members.filter(id => id !== selected.expected_sender).join(', ') ?? '')}" placeholder="123456, 789012" maxlength="6400"></label>
      <p>The connection’s enrolled owner is included. Add up to 31 other Telegram user IDs. Members can use Done, Later and Not needed; only the enrolled owner changes a clock or its last-done date. New reminders keep their original group and members; removing a member blocks their older replies too.</p>
      <button type="submit">Save household Telegram</button></form>`;
    for (const node of root.querySelectorAll<HTMLElement>('input,select,button')) node.style.minHeight = '44px';
    const telegramForm = root.querySelector('form')!;
    const rememberTelegram = () => {
      if (disposed || pendingRead || readFailed || busy || !root.contains(telegramForm)) return;
      const selectedIndex = root.querySelector<HTMLSelectElement>('[name="group"]')!.value;
      const row = selectedIndex ? value!.telegram_connections[Number(selectedIndex)] : null;
      telegramDraft = { choice: row ? { name: row.name, enrolled_at: row.enrolled_at } : selectedIndex === 'missing' ? choice : null,
        members: root.querySelector<HTMLInputElement>('[name="members"]')!.value }; clearRestoredDrafts(); };
    telegramForm.addEventListener('input', rememberTelegram); telegramForm.addEventListener('change', rememberTelegram);
    telegramForm.addEventListener('submit', event => {
      event.preventDefault(); if (disposed || pendingRead || readFailed || busy || confirming || !value || !root.contains(telegramForm)) return;
      const choice = root.querySelector<HTMLSelectElement>('[name="group"]')!.value; const members = root.querySelector<HTMLInputElement>('[name="members"]')!.value;
      void saveSettings('telegram', telegramForm, () => {
        if (choice === '') return { action: 'household.telegram', connection_name: null };
        const row = value!.telegram_connections[Number(choice)]; if (!row || choice === 'missing') throw new Error('Choose a currently enrolled group');
        return { action: 'household.telegram', connection_name: row.name, connection_enrolled_at: row.enrolled_at,
          members: [...new Set([row.owner_sender, ...members.split(/[\s,]+/u).filter(Boolean)])] };
      });
    });
    const ha = value.home_assistant;
    if (ha) {
      const section = doc.createElement('section'); section.dataset.householdHomeAssistant = ''; const selection = ha.selection;
      const haChoice = haDraft ? haDraft.choice : selection ? { name: selection.connection_name, enrolled_at: selection.connection_enrolled_at } : null;
      const selectedIndex = ha.connections.findIndex(row => row.name === haChoice?.name && row.enrolled_at === haChoice.enrolled_at);
      section.innerHTML = `<h3>Household Home Assistant list</h3><p>Shared tasks appear in one to-do list. Done there closes the original task. An unknown service date or reading waits for your confirmation in Yours.</p>
        <form><label>Home Assistant connection <select name="ha_connection" aria-label="Home Assistant connection"><option value=""${!haChoice ? ' selected' : ''}>Off</option>
        ${haChoice && selectedIndex < 0 ? '<option value="missing" selected disabled>Selected connection is unavailable</option>' : ''}
        ${ha.connections.map((row, index) => `<option value="${index}"${index === selectedIndex ? ' selected' : ''}>${e(row.name)}</option>`).join('')}</select></label>
        <label>To-do entity ID <input name="ha_entity" aria-label="To-do entity ID" value="${e(haDraft?.entity ?? selection?.entity_id ?? '')}" placeholder="todo.household" maxlength="205"></label>
        <button type="submit">Save household list</button></form>
        ${selection?.mode === 'display_only' ? '<p>This list is display-only. Complete its tasks in Recued.</p>' : ''}
        ${ha.issue ? `<p role="status">${e(ha.issue)}</p>` : ''}${ha.uncertain ? `<p>${ha.uncertain} provider writes are waiting for reconciliation.</p>` : ''}`;
      root.append(section);
      const haForm = section.querySelector('form')!;
      const rememberHA = () => {
        if (disposed || pendingRead || readFailed || busy || !root.contains(haForm)) return;
        const index = section.querySelector<HTMLSelectElement>('[name="ha_connection"]')!.value;
        const row = index ? ha.connections[Number(index)] : null;
        haDraft = { choice: row ? { name: row.name, enrolled_at: row.enrolled_at } : index === 'missing' ? haChoice : null,
          entity: section.querySelector<HTMLInputElement>('[name="ha_entity"]')!.value }; clearRestoredDrafts(); };
      haForm.addEventListener('input', rememberHA); haForm.addEventListener('change', rememberHA);
      for (const node of section.querySelectorAll<HTMLElement>('input,select,button')) node.style.minHeight = '44px';
      haForm.addEventListener('submit', event => {
        event.preventDefault(); if (disposed || pendingRead || readFailed || busy || confirming || !value || !root.contains(haForm)) return;
        const index = section.querySelector<HTMLSelectElement>('[name="ha_connection"]')!.value;
        const entity_id = section.querySelector<HTMLInputElement>('[name="ha_entity"]')!.value.trim();
        void saveSettings('home_assistant', haForm, () => {
          const row = ha.connections[Number(index)]; if (index && (!row || index === 'missing')) throw new Error('Choose an enrolled Home Assistant connection');
          return { action: 'household.home_assistant', connection_name: index ? row!.name : null,
            ...(index ? { connection_enrolled_at: row!.enrolled_at, entity_id } : {}) };
        });
      });
    }
    root.append(readFeedback);
    paintControls();
  };
  const readSettings = (): Promise<void> => {
    if (pendingRead) return pendingRead;
    const confirmation = confirming;
    // Install the shared promise before invoking the caller, including callers
    // that throw synchronously. No older refresh can settle over a newer form.
    pendingRead = Promise.resolve().then(async () => {
      try {
        const next = await opts.read();
        if (disposed) return;
        // Check the fields used by the renderer before retiring either draft.
        // Older replies may also omit Home Assistant while its form has edits.
        if (!next || !Array.isArray(next.telegram_connections) || !('telegram' in next)
          || !next.telegram_connections.every(row => row && typeof row.name === 'string' && typeof row.recipient === 'string')
          || (next.telegram && (!Array.isArray(next.telegram.members) || !next.telegram.members.every(id => typeof id === 'string')))
          || (next.home_assistant && (!Array.isArray(next.home_assistant.connections) || !('selection' in next.home_assistant)
            || !next.home_assistant.connections.every(row => row && typeof row.name === 'string')
            || (next.home_assistant.selection && typeof next.home_assistant.selection.entity_id !== 'string')
            || (next.home_assistant.issue !== null && typeof next.home_assistant.issue !== 'string')
            || !Number.isFinite(next.home_assistant.uncertain)))
          || ((confirmation?.kind === 'home_assistant' || haDraft || unconfirmedSaves.has('home_assistant')) && !next.home_assistant)) {
          throw new Error('Recued could not read the current household settings. Try again.');
        }
        const ownedFeedback = doc.activeElement === retry || doc.activeElement === readStatus;
        value = next;
        unconfirmedSaves.clear();
        if (confirmation) {
          if (confirmation.kind === 'telegram') telegramDraft = undefined;
          else haDraft = undefined;
          confirming = null;
        }
        clearRestoredDrafts();
        readFailed = false; retry.hidden = true; retry.remove(); render();
        message(confirmation ? `${labels[confirmation.kind]} saved.` : '');
        if (ownedFeedback) {
          if (confirmation) focusSavedForm(confirmation);
          else root.querySelector<HTMLElement>('select:not([disabled]),input:not([disabled]),button:not([disabled])')?.focus({ preventScroll: true });
        }
      } catch (error) {
        if (disposed) return;
        // An unsupported read cannot resolve an earlier uncertain write.
        if (!confirmation && unconfirmedSaves.size === 0 && classifyRpcError(error).code === 'unknown_method') { disposed = true; root.remove(); return; }
        readFailed = true;
        showReadFeedback(false, error);
        if (confirmation && doc.activeElement === readStatus) retry.focus();
      }
    }).finally(() => { pendingRead = null; });
    showReadFeedback(true);
    return pendingRead;
  };
  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (pendingRead) return pendingRead;
    if (busy || (hasEditedValues() && !confirming)) return Promise.resolve();
    return readSettings();
  };
  const saveSettings = async (kind: Kind, form: HTMLFormElement, command: () => Save): Promise<void> => {
    if (disposed || busy || pendingRead || readFailed || confirming || !root.contains(form)) return;
    const active = doc.activeElement;
    const ownedForm = active !== null && form.contains(active);
    const confirmation: Confirmation = { kind, focusName: active?.getAttribute('name') ?? null };
    busy = true; message(`Saving ${labels[kind]}…`);
    if (ownedForm) readStatus.focus();
    paintControls();
    try {
      const input = command();
      unconfirmedSaves.add(kind);
      await opts.save(input);
      if (disposed) return;
      confirming = confirmation;
      const read = readSettings();
      busy = false;
      await read;
    } catch (error) {
      if (!disposed) message(error instanceof Error ? error.message : String(error), true);
    } finally {
      busy = false;
      if (!disposed) {
        paintControls();
        if (ownedForm && doc.activeElement === readStatus && !confirming) focusSavedForm(confirmation);
      }
    }
  };
  retry.addEventListener('click', () => {
    if (disposed || pendingRead || !readFailed) return;
    void refresh();
  });
  void refresh(); return { refresh, hasInFlightWork: () => busy || (confirming !== null && pendingRead !== null),
    hasUnsavedChanges: () => !disposed && (!!telegramDraft || !!haDraft || unconfirmedSaves.size > 0),
    dispose() { disposed = true; root.remove(); } };
};
