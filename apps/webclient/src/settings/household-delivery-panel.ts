import type { HouseholdHomeAssistantList, YoursCommand, YoursSnapshot } from '@recued/contracts';
import { e } from '@recued/ui-shared';
import { classifyRpcError } from '../shell/rpc-error-copy.js';

export const HOUSEHOLD_DELIVERY_PANEL_ATTR = 'data-household-delivery';

export interface HouseholdDeliveryPanelOptions {
  host: HTMLElement; document?: Document;
  read(): Promise<NonNullable<YoursSnapshot['household']>>;
  save(input: Extract<YoursCommand, { action: 'household.telegram' | 'household.home_assistant' }>): Promise<unknown>;
  /** §15.7 amendment — a Home Assistant connection's to-do lists (`yours.household_lists`),
   *  so the owner picks one by name. Absent, or refused by an older server, the card keeps
   *  the typed list id. */
  homeAssistantLists?(input: { connection_name: string; connection_enrolled_at: number }): Promise<{ lists: HouseholdHomeAssistantList[] }>;
}
/** What Settings calls each connection; `detail` tells two of the same name apart. */
const optionLabels = <T extends { name: string; display_name?: string }>(rows: readonly T[], detail: (row: T) => string): string[] => {
  const label = (row: T) => row.display_name || row.name;
  return rows.map(row => rows.filter(other => label(other) === label(row)).length > 1 ? `${label(row)} · ${detail(row)}` : label(row));
};
/** The assets whose reminders reach the household. An older server sends none, and
 *  a malformed list is left out rather than failing the card it only describes. */
const sharedAssetsOf = (value: NonNullable<YoursSnapshot['household']>) => {
  const shared = value.shared_assets;
  return shared && Array.isArray(shared.assets) && Number.isInteger(shared.total) && shared.total >= shared.assets.length
    && (shared.assets.length > 0 || shared.total === 0) // "and 3 more" needs a name before it
    && shared.assets.every(row => row && typeof row.id === 'string' && typeof row.name === 'string') ? shared : undefined;
};
export const mountHouseholdDeliveryPanel = (opts: HouseholdDeliveryPanelOptions) => {
  type Kind = 'telegram' | 'home_assistant';
  type Save = Parameters<HouseholdDeliveryPanelOptions['save']>[0];
  type Confirmation = { kind: Kind; focusName: string | null };
  const labels = { telegram: 'Household Telegram', home_assistant: 'Home Assistant list' };
  type ListsRead = { state: 'loading' } | { state: 'ready'; lists: HouseholdHomeAssistantList[] } | { state: 'failed'; message: string };
  const doc = opts.document ?? document; const root = doc.createElement('section'); root.setAttribute(HOUSEHOLD_DELIVERY_PANEL_ATTR, ''); opts.host.append(root);
  let disposed = false; let busy = false; let value: NonNullable<YoursSnapshot['household']> | undefined;
  let pendingRead: Promise<void> | null = null;
  let readFailed = false;
  let showingReadFeedback = false;
  let confirming: Confirmation | null = null;
  const unconfirmedSaves = new Set<Kind>();
  // Keep the same control attached through loading and repeated failures so
  // native keyboard focus does not fall back to the page body.
  const heading = doc.createElement('h3'); heading.textContent = 'Household';
  const readFeedback = doc.createElement('div'); readFeedback.className = 'hd-feedback';
  const readStatus = doc.createElement('p');
  readStatus.setAttribute('data-household-read-status', '');
  readStatus.setAttribute('data-household-status', '');
  readStatus.setAttribute('aria-atomic', 'true');
  readStatus.setAttribute('tabindex', '-1');
  const retry = doc.createElement('button');
  retry.type = 'button'; retry.textContent = 'Retry household delivery';
  retry.className = 'rx-btn rx-btn-secondary rx-btn-sm';
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
      root.replaceChildren(heading, readFeedback);
      showingReadFeedback = true;
    }
    paintControls();
  };
  type Choice = { name: string; enrolled_at: number } | null;
  let telegramDraft: { choice: Choice } | undefined;
  let haDraft: { choice: Choice; entity: string } | undefined;
  const sameChoice = (a: Choice, b: Choice) => a === null ? b === null
    : b !== null && a.name === b.name && a.enrolled_at === b.enrolled_at;
  const telegramRestored = (draft: NonNullable<typeof telegramDraft>) => {
    const selected = value?.telegram;
    return sameChoice(draft.choice, selected ? { name: selected.connection_name, enrolled_at: selected.connection_enrolled_at } : null);
  };
  const haRestored = (draft: NonNullable<typeof haDraft>) => {
    const ha = value?.home_assistant;
    if (!ha) return false;
    const selected = ha.selection;
    return sameChoice(draft.choice, selected ? { name: selected.connection_name, enrolled_at: selected.connection_enrolled_at } : null)
      && (draft.choice === null || draft.entity === (selected?.entity_id ?? ''));
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
    const block = root.querySelector(kind === 'telegram' ? '[data-household-telegram]' : '[data-household-home-assistant]');
    const named = focusName ? Array.from(block?.querySelectorAll<HTMLElement>('[name]') ?? [])
      .find(node => node.getAttribute('name') === focusName) : undefined;
    (named ?? block?.querySelector<HTMLElement>('button[type="submit"]'))?.focus();
  };
  const render = () => {
    if (!value || disposed) return;
    showingReadFeedback = false;
    const selected = value.telegram;
    const saved: Choice = selected ? { name: selected.connection_name, enrolled_at: selected.connection_enrolled_at } : null;
    const choice = telegramDraft ? telegramDraft.choice : saved;
    const index = value.telegram_connections.findIndex(row => row.name === choice?.name && row.enrolled_at === choice.enrolled_at);
    // §15.7 amendment — sharing is an asset's setting, so the card names the assets
    // it covers and where that is set. An older server sends no list.
    const shared = sharedAssetsOf(value);
    const assets = '<a href="#yours/assets">your assets</a>';
    const howTo = `edit it in ${assets} and set Who sees its reminders to Me and my household`;
    const links = shared?.assets.map(row => `<a href="#yours/asset/${encodeURIComponent(row.id)}">${e(row.name)}</a>`) ?? [];
    const more = shared ? shared.total - links.length : 0;
    const named = more > 0 ? `${links.join(', ')} and ${more} more` : links.length > 1 ? `${links.slice(0, -1).join(', ')} and ${links.at(-1)}` : links[0];
    // One card, two destinations. A destination's details show once it is on;
    // until then the card says only what it is and where to connect one.
    root.innerHTML = `<h3>Reminders for shared assets</h3>
      <p class="hd-lede">Assets you share with your household also send their reminders to the people you live with. Approvals, birthdays and your other reminders reach only you.</p>
      <p class="hd-shared" data-household-shared>${!shared ? `To share an asset, ${howTo}.` : named ? `Shared now: ${named}. To change one, edit it in ${assets}.`
        : `No asset is shared yet. To share one, ${howTo}.`}</p>
      <section class="hd-block" data-household-telegram><h4>Post them in a Telegram group</h4>
      <p class="hd-hint">They are posted as messages in the group you choose, for everyone there to read. Nobody answers them there: you mark them done in Recued.</p>
      <form><label class="hd-field"><span>Household group</span><select name="group" class="rx-select" aria-label="Household group"><option value=""${!choice ? ' selected' : ''}>Off</option>
      ${choice && index < 0 ? '<option value="missing" selected disabled>Selected group is unavailable</option>' : ''}
      ${optionLabels(value.telegram_connections, row => row.recipient).map((label, at) => `<option value="${at}"${at === index ? ' selected' : ''}>${e(label)}</option>`).join('')}</select></label>
      ${value.telegram_connections.length ? '' : '<p class="hd-hint">No Telegram group is connected yet. Add one in <a href="#connections">Connections</a>, then choose it here.</p>'}
      <div class="hd-actions"><button type="submit" class="rx-btn rx-btn-secondary rx-btn-sm">Save household Telegram</button></div></form></section>`;
    const telegramForm = root.querySelector('form')!;
    const group = telegramForm.querySelector<HTMLSelectElement>('[name="group"]')!;
    const draftChoice = (): Choice => {
      const row = group.value && group.value !== 'missing' ? value!.telegram_connections[Number(group.value)] : null;
      return row ? { name: row.name, enrolled_at: row.enrolled_at } : group.value === 'missing' ? choice : null;
    };
    const rememberTelegram = () => {
      if (disposed || pendingRead || readFailed || busy || !root.contains(telegramForm)) return;
      telegramDraft = { choice: draftChoice() }; clearRestoredDrafts(); };
    telegramForm.addEventListener('input', rememberTelegram); telegramForm.addEventListener('change', rememberTelegram);
    telegramForm.addEventListener('submit', event => {
      event.preventDefault(); if (disposed || pendingRead || readFailed || busy || confirming || !value || !root.contains(telegramForm)) return;
      const choice = group.value;
      void saveSettings('telegram', telegramForm, () => {
        if (choice === '') return { action: 'household.telegram', connection_name: null };
        const row = value!.telegram_connections[Number(choice)]; if (!row || choice === 'missing') throw new Error('Choose a currently enrolled group');
        return { action: 'household.telegram', connection_name: row.name, connection_enrolled_at: row.enrolled_at };
      });
    });
    const ha = value.home_assistant;
    // Nothing to choose from and nothing chosen: someone without Home Assistant
    // reads one line, not an empty form.
    if (ha && !ha.connections.length && !ha.selection && !haDraft && !unconfirmedSaves.has('home_assistant') && confirming?.kind !== 'home_assistant') {
      const section = doc.createElement('section'); section.className = 'hd-block'; section.dataset.householdHomeAssistant = '';
      section.innerHTML = `<h4>Show their tasks on a Home Assistant <span class="hd-nowrap">to-do list</span></h4>
        <p class="hd-hint">If you use Home Assistant at home, open tasks for shared assets can also show on one of its to-do lists. Connect it in <a href="#connections">Connections</a> first.</p>`;
      root.append(section);
    } else if (ha) {
      const section = doc.createElement('section'); section.className = 'hd-block'; section.dataset.householdHomeAssistant = ''; const selection = ha.selection;
      const haChoice = haDraft ? haDraft.choice : selection ? { name: selection.connection_name, enrolled_at: selection.connection_enrolled_at } : null;
      const selectedIndex = ha.connections.findIndex(row => row.name === haChoice?.name && row.enrolled_at === haChoice.enrolled_at);
      // §15.7 amendment — only open tasks (a commitment, not a notice or a question)
      // reach the list (`household-home-assistant.ts` `context`), and nothing is sent.
      // The household only receives (2026-10-24): ticking one off there changes nothing.
      section.innerHTML = `<h4>Show their tasks on a Home Assistant <span class="hd-nowrap">to-do list</span></h4>
        <p class="hd-hint">Open tasks for shared assets, like “Service boiler”, show on the to-do list you choose, for your household to see. It sends no messages, and ticking a task off there doesn’t change it in Recued: you mark it done in Recued.</p>
        <form><label class="hd-field"><span>Home Assistant connection</span><select name="ha_connection" class="rx-select" aria-label="Home Assistant connection"><option value=""${!haChoice ? ' selected' : ''}>Off</option>
        ${haChoice && selectedIndex < 0 ? '<option value="missing" selected disabled>Selected connection is unavailable</option>' : ''}
        ${optionLabels(ha.connections, row => row.name).map((label, index) => `<option value="${index}"${index === selectedIndex ? ' selected' : ''}>${e(label)}</option>`).join('')}</select></label>
        ${ha.connections.length ? '' : '<p class="hd-hint">No Home Assistant is connected yet. Add it in <a href="#connections">Connections</a>, then choose it here.</p>'}
        <div class="hd-detail" data-household-entity${haChoice ? '' : ' hidden'}>
        <label class="hd-field" data-household-list hidden><span>To-do list</span><select name="ha_list" class="rx-select" aria-label="To-do list"></select></label>
        <p class="hd-hint" data-household-list-status role="status" hidden></p>
        <details class="hd-more" data-household-entity-manual open><summary>Type a list ID instead</summary>
        <label class="hd-field"><span>To-do list ID</span><input name="ha_entity" class="rx-input" aria-label="To-do list ID" value="${e(haDraft?.entity ?? selection?.entity_id ?? '')}" placeholder="todo.household" maxlength="205"></label>
        <p class="hd-hint">In Home Assistant, the list’s settings show its ID, which starts with todo.</p></details></div>
        <div class="hd-actions"><button type="submit" class="rx-btn rx-btn-secondary rx-btn-sm">Save to-do list</button></div></form>
        ${ha.issue ? `<p class="hd-note hd-note-issue">${e(ha.issue)}</p>` : ''}
        ${ha.uncertain ? `<p class="hd-note">${ha.uncertain} ${ha.uncertain === 1 ? 'change to the list is' : 'changes to the list are'} not confirmed yet. Recued checks again without adding duplicates.</p>` : ''}`;
      root.append(section);
      const haForm = section.querySelector('form')!;
      const connection = haForm.querySelector<HTMLSelectElement>('[name="ha_connection"]')!;
      connection.addEventListener('change', () => {
        haForm.querySelector<HTMLElement>('[data-household-entity]')!.hidden = connection.value === ''; const row = chosenHomeAssistant(); if (row) loadLists(row); paintLists();
      });
      // A pick from the menu is the list id the form saves, so drafts and Save work as typed.
      const menu = haForm.querySelector<HTMLSelectElement>('[name="ha_list"]')!;
      menu.addEventListener('change', () => { haForm.querySelector<HTMLInputElement>('[name="ha_entity"]')!.value = menu.value; });
      if (selectedIndex >= 0) loadLists(ha.connections[selectedIndex]!);
      paintLists();
      const rememberHA = () => {
        if (disposed || pendingRead || readFailed || busy || !root.contains(haForm)) return;
        const index = section.querySelector<HTMLSelectElement>('[name="ha_connection"]')!.value;
        const row = index ? ha.connections[Number(index)] : null;
        haDraft = { choice: row ? { name: row.name, enrolled_at: row.enrolled_at } : index === 'missing' ? haChoice : null,
          entity: section.querySelector<HTMLInputElement>('[name="ha_entity"]')!.value }; clearRestoredDrafts(); };
      haForm.addEventListener('input', rememberHA); haForm.addEventListener('change', rememberHA);
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
  // §15.7 amendment — each connection's to-do lists, read once while the card is open
  // and again when it reads again, so a list added in Home Assistant shows up.
  const haLists = new Map<string, ListsRead>();
  const listKey = (row: { name: string; enrolled_at: number }) => `${row.enrolled_at} ${row.name}`;
  const chosenHomeAssistant = () => {
    const index = root.querySelector<HTMLSelectElement>('[data-household-home-assistant] [name="ha_connection"]')?.value;
    return index && index !== 'missing' ? value?.home_assistant?.connections[Number(index)] : undefined;
  };
  const loadLists = (row: { name: string; enrolled_at: number }) => {
    const key = listKey(row); if (!opts.homeAssistantLists || haLists.has(key)) return;
    const pending: ListsRead = { state: 'loading' }; haLists.set(key, pending);
    void opts.homeAssistantLists({ connection_name: row.name, connection_enrolled_at: row.enrolled_at }).then(result => {
      const lists = Array.isArray(result?.lists) ? result.lists.filter(list => list && typeof list.entity_id === 'string'
        && typeof list.name === 'string' && typeof list.usable === 'boolean') : null;
      if (haLists.get(key) === pending) haLists.set(key, lists ? { state: 'ready', lists } : { state: 'failed', message: 'Home Assistant sent no lists.' });
    }, (error: unknown) => {
      // An older server has no menu: the typed id stays, with nothing to explain.
      if (haLists.get(key) === pending) haLists.set(key, { state: 'failed',
        message: classifyRpcError(error).code === 'unknown_method' ? '' : error instanceof Error ? error.message : String(error) });
    }).finally(() => { if (!disposed) paintLists(); });
  };
  const listLabel = (list: HouseholdHomeAssistantList) => list.usable ? list.name : `${list.name} (${list.reason ?? 'can’t be used'})`;
  // Fills the menu in place, so a read that lands later never redraws the form under the owner.
  const paintLists = () => {
    const form = root.querySelector<HTMLFormElement>('[data-household-home-assistant] form'); if (!form) return;
    const field = form.querySelector<HTMLElement>('[data-household-list]')!, menu = field.querySelector('select')!;
    const status = form.querySelector<HTMLElement>('[data-household-list-status]')!;
    const manual = form.querySelector<HTMLDetailsElement>('[data-household-entity-manual]')!;
    const typed = form.querySelector<HTMLInputElement>('[name="ha_entity"]')!.value.trim();
    const row = chosenHomeAssistant(); const read = row ? haLists.get(listKey(row)) : undefined;
    const say = (text: string) => { status.textContent = text; status.hidden = !text; };
    field.hidden = read?.state !== 'ready' || !read.lists.length;
    if (!read) { say(''); manual.open = true; return; }
    if (read.state === 'loading') { say('Reading this Home Assistant’s to-do lists…'); return; }
    if (read.state === 'failed') { say(read.message ? `Recued couldn’t read its to-do lists: ${read.message} Type the list’s ID below.` : ''); manual.open = true; return; }
    if (!read.lists.length) { say('This Home Assistant has no to-do lists yet. Add one there, such as a Local To-do list, then come back.'); manual.open = true; return; }
    const choose = doc.createElement('option'); choose.value = ''; choose.textContent = 'Choose a list';
    menu.replaceChildren(choose, ...read.lists.map(list => {
      const option = doc.createElement('option'); option.value = list.entity_id; option.textContent = listLabel(list); option.disabled = !list.usable; return option;
    }));
    menu.value = read.lists.some(list => list.usable && list.entity_id === typed) ? typed : '';
    say(read.lists.some(list => list.usable) ? '' : 'None of these lists can hold Recued’s tasks. Add a Local To-do list in Home Assistant, then come back.');
    // A list typed by hand that isn't on the menu stays in view.
    if (typed && !read.lists.some(list => list.entity_id === typed)) manual.open = true;
    else if (!manual.contains(doc.activeElement)) manual.open = false;
    paintControls();
  };
  // Check the fields used by the renderer before retiring either draft. Older
  // replies may also omit Home Assistant while its form has edits.
  const unreadable = (next: NonNullable<YoursSnapshot['household']> | undefined, confirmation: Confirmation | null): boolean =>
    !next || !Array.isArray(next.telegram_connections) || !('telegram' in next)
    || !next.telegram_connections.every(row => row && typeof row.name === 'string' && typeof row.recipient === 'string')
    || (!!next.telegram && (typeof next.telegram.connection_name !== 'string' || typeof next.telegram.recipient !== 'string'))
    || (!!next.home_assistant && (!Array.isArray(next.home_assistant.connections) || !('selection' in next.home_assistant)
      || !next.home_assistant.connections.every(row => row && typeof row.name === 'string')
      || (!!next.home_assistant.selection && typeof next.home_assistant.selection.entity_id !== 'string')
      || (next.home_assistant.issue !== null && typeof next.home_assistant.issue !== 'string')
      || !Number.isFinite(next.home_assistant.uncertain)))
    || ((confirmation?.kind === 'home_assistant' || !!haDraft || unconfirmedSaves.has('home_assistant')) && !next.home_assistant);
  // A save or an explicit read started since a quiet read went out makes its reply stale.
  let generation = 0;
  const readSettings = (): Promise<void> => {
    if (pendingRead) return pendingRead;
    generation += 1; haLists.clear();
    const confirmation = confirming;
    // Install the shared promise before invoking the caller, including callers
    // that throw synchronously. No older refresh can settle over a newer form.
    pendingRead = Promise.resolve().then(async () => {
      try {
        const next = await opts.read();
        if (disposed) return;
        if (unreadable(next, confirmation)) throw new Error('Recued could not read the current household settings. Try again.');
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
  // A return to the page re-reads quietly: the card stays as it is while the read
  // is out and is redrawn only when something changed (an asset shared elsewhere, a
  // connection added) and nothing is being edited. An explicit read would swap the
  // card for "Loading…" and drop keyboard focus.
  let quietRead: Promise<void> | null = null;
  let readAgain = false;
  const refreshQuietly = (): Promise<void> => {
    if (quietRead) { readAgain = true; return quietRead; }
    if (!disposed) { haLists.clear(); const row = chosenHomeAssistant(); if (row) loadLists(row); paintLists(); }
    if (disposed || !value || busy || pendingRead || confirming || readFailed || unconfirmedSaves.size > 0 || hasEditedValues()) return Promise.resolve();
    const started = generation;
    quietRead = (async () => {
      try {
        const next = await opts.read();
        if (disposed || started !== generation || busy || pendingRead || confirming || hasEditedValues() || unreadable(next, null)) return;
        if (JSON.stringify(next) === JSON.stringify(value)) return;
        const active = doc.activeElement as HTMLElement | null;
        const held = active && root.contains(active) ? { name: active.getAttribute('name'), value: (active as HTMLButtonElement).value } : null;
        value = next; clearRestoredDrafts(); render();
        if (held) {
          // The same control if it is still there, else the group's Save.
          const named = held.name ? Array.from(root.querySelectorAll<HTMLElement>('[name]')).filter(node => node.getAttribute('name') === held.name) : [];
          (named.find(node => node.tagName !== 'BUTTON' || (node as HTMLButtonElement).value === held.value)
            ?? root.querySelector<HTMLElement>('[data-household-telegram] button[type="submit"]'))?.focus({ preventScroll: true });
        }
      } catch { /* A nudge that cannot be read waits for the next one, or a manual refresh. */ }
      finally {
        quietRead = null;
        if (readAgain && !disposed) { readAgain = false; void refreshQuietly(); }
      }
    })();
    return quietRead;
  };
  const saveSettings = async (kind: Kind, form: HTMLElement, command: () => Save): Promise<void> => {
    if (disposed || busy || pendingRead || readFailed || confirming || !root.contains(form)) return;
    generation += 1;
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
  void refresh(); return { refresh, refreshQuietly, hasInFlightWork: () => busy || (confirming !== null && pendingRead !== null),
    hasUnsavedChanges: () => !disposed && (!!telegramDraft || !!haDraft || unconfirmedSaves.size > 0),
    dispose() { disposed = true; root.remove(); } };
};

/** Injected once by the settings route, in the card style of the panels above
 *  it. Control heights are the shell's (`--wc-control-h`, 44px on a phone),
 *  which replace the 44px this panel set inline on every control.
 *  ⚠ `[hidden]` is restated because `.rx-btn` and the field rows set a
 *  display, which would otherwise show a destination's details while it is Off. */
export const HOUSEHOLD_DELIVERY_PANEL_STYLES = `
[${HOUSEHOLD_DELIVERY_PANEL_ATTR}] {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 18px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--fg);
  font-size: 13px;
}
[${HOUSEHOLD_DELIVERY_PANEL_ATTR}] [hidden] {
  display: none !important;
}
[${HOUSEHOLD_DELIVERY_PANEL_ATTR}] h3,
[${HOUSEHOLD_DELIVERY_PANEL_ATTR}] h4 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
[${HOUSEHOLD_DELIVERY_PANEL_ATTR}] h4 {
  font-size: 13px;
}
[${HOUSEHOLD_DELIVERY_PANEL_ATTR}] p {
  margin: 0;
}
[${HOUSEHOLD_DELIVERY_PANEL_ATTR}] .hd-lede,
[${HOUSEHOLD_DELIVERY_PANEL_ATTR}] .hd-hint {
  max-width: 68ch;
  color: var(--fg-muted);
}
[${HOUSEHOLD_DELIVERY_PANEL_ATTR}] .hd-hint {
  font-size: 12px;
}
[${HOUSEHOLD_DELIVERY_PANEL_ATTR}] .hd-hint a,
[${HOUSEHOLD_DELIVERY_PANEL_ATTR}] .hd-shared a {
  color: var(--accent);
}
[${HOUSEHOLD_DELIVERY_PANEL_ATTR}] .hd-shared {
  max-width: 68ch;
}
/* "to-do" would otherwise break at its hyphen on a phone. */
[${HOUSEHOLD_DELIVERY_PANEL_ATTR}] .hd-nowrap {
  white-space: nowrap;
}
/* Each destination is a white card on the grey panel, like a channel row. */
[${HOUSEHOLD_DELIVERY_PANEL_ATTR}] .hd-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 4px;
}
[${HOUSEHOLD_DELIVERY_PANEL_ATTR}] form,
[${HOUSEHOLD_DELIVERY_PANEL_ATTR}] .hd-detail {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
[${HOUSEHOLD_DELIVERY_PANEL_ATTR}] .hd-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-width: 420px;
}
[${HOUSEHOLD_DELIVERY_PANEL_ATTR}] .hd-field > span {
  font-size: 12px;
  font-weight: 500;
  color: var(--fg-muted);
}
[${HOUSEHOLD_DELIVERY_PANEL_ATTR}] .hd-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
[${HOUSEHOLD_DELIVERY_PANEL_ATTR}] .hd-more summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--fg-muted);
}
[${HOUSEHOLD_DELIVERY_PANEL_ATTR}] .hd-more[open] {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
[${HOUSEHOLD_DELIVERY_PANEL_ATTR}] .hd-note {
  padding: 6px 8px;
  border-radius: 4px;
  background: var(--surface-sunk);
  font-size: 12px;
}
[${HOUSEHOLD_DELIVERY_PANEL_ATTR}] .hd-note-issue {
  background: var(--danger-weak);
  color: var(--danger);
}
[${HOUSEHOLD_DELIVERY_PANEL_ATTR}] .hd-feedback {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
}
[${HOUSEHOLD_DELIVERY_PANEL_ATTR}] [data-household-read-status][role="alert"] {
  color: var(--danger);
}
`;
