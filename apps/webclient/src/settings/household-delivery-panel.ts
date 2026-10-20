import type { YoursCommand, YoursSnapshot } from '@recued/contracts';
import { e } from '@recued/ui-shared';
import { classifyRpcError } from '../shell/rpc-error-copy.js';

export interface HouseholdDeliveryPanelOptions {
  host: HTMLElement; document?: Document;
  read(): Promise<NonNullable<YoursSnapshot['household']>>;
  save(input: Extract<YoursCommand, { action: 'household.telegram' | 'household.home_assistant' }>): Promise<unknown>;
}
export const mountHouseholdDeliveryPanel = (opts: HouseholdDeliveryPanelOptions) => {
  const doc = opts.document ?? document; const root = doc.createElement('section'); root.dataset.householdDelivery = ''; opts.host.append(root);
  let disposed = false; let busy = false; let dirty = false; let value: NonNullable<YoursSnapshot['household']> | undefined;
  type Choice = { name: string; enrolled_at: number } | null;
  let telegramDraft: { choice: Choice; members: string } | undefined;
  let haDraft: { choice: Choice; entity: string } | undefined;
  const message = (text: string, failed = false) => { const node = root.querySelector<HTMLElement>('[data-household-status]'); if (node) { node.textContent = text; node.setAttribute('role', failed ? 'alert' : 'status'); } };
  const render = () => {
    if (!value || disposed) return;
    const selected = value.telegram; const choice = telegramDraft ? telegramDraft.choice : selected ? { name: selected.connection_name, enrolled_at: selected.connection_enrolled_at } : null;
    const index = value.telegram_connections.findIndex(row => row.name === choice?.name && row.enrolled_at === choice.enrolled_at);
    root.innerHTML = `<h3>Household Telegram</h3><p>Household items go to this group. Selected members can use Done on the original task. Private reminders follow your personal notification connection.</p>
      <form><label>Household group <select name="group" aria-label="Household group"><option value=""${!choice ? ' selected' : ''}>Off</option>
      ${choice && index < 0 ? '<option value="missing" selected disabled>Selected group is unavailable</option>' : ''}
      ${value.telegram_connections.map((row, at) => `<option value="${at}"${at === index ? ' selected' : ''}>${e(row.name)} · ${e(row.recipient)}</option>`).join('')}</select></label>
      <label>Other member user IDs <input name="members" aria-label="Other member user IDs" value="${e(telegramDraft?.members ?? selected?.members.filter(id => id !== selected.expected_sender).join(', ') ?? '')}" placeholder="123456, 789012" maxlength="6400"></label>
      <p>The connection’s enrolled owner is included. Add up to 31 other Telegram user IDs. Members can use Done, Later and Not needed; only the enrolled owner changes a clock or its last-done date. New reminders keep their original group and members; removing a member blocks their older replies too.</p>
      <button type="submit">Save household Telegram</button></form><p data-household-status role="status"></p>`;
    for (const node of root.querySelectorAll<HTMLElement>('input,select,button')) node.style.minHeight = '44px';
    const rememberTelegram = () => { const selectedIndex = root.querySelector<HTMLSelectElement>('[name="group"]')!.value;
      const row = selectedIndex ? value!.telegram_connections[Number(selectedIndex)] : null;
      telegramDraft = { choice: row ? { name: row.name, enrolled_at: row.enrolled_at } : selectedIndex === 'missing' ? choice : null,
        members: root.querySelector<HTMLInputElement>('[name="members"]')!.value }; dirty = true; };
    root.querySelector('form')!.addEventListener('input', rememberTelegram); root.querySelector('form')!.addEventListener('change', rememberTelegram);
    root.querySelector('form')!.addEventListener('submit', async event => {
      event.preventDefault(); if (busy || !value) return;
      const choice = root.querySelector<HTMLSelectElement>('[name="group"]')!.value; const members = root.querySelector<HTMLInputElement>('[name="members"]')!.value;
      const active = doc.activeElement as HTMLElement | null; const activeName = active?.getAttribute('name'); const submitted = active?.tagName === 'BUTTON';
      busy = true; for (const node of root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button')) node.disabled = true;
      try {
        if (choice === '') await opts.save({ action: 'household.telegram', connection_name: null });
        else { const row = value.telegram_connections[Number(choice)]; if (!row || choice === 'missing') throw new Error('Choose a currently enrolled group');
          await opts.save({ action: 'household.telegram', connection_name: row.name, connection_enrolled_at: row.enrolled_at,
            members: [...new Set([row.owner_sender, ...members.split(/[\s,]+/u).filter(Boolean)])] }); }
        const next = await opts.read(); if (!disposed) { value = next; telegramDraft = undefined; dirty = !!haDraft; render(); message('Household Telegram saved.'); }
      } catch (error) { if (!disposed) message(error instanceof Error ? error.message : String(error), true); }
      finally { busy = false; if (!disposed) { for (const node of root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button')) node.disabled = false;
        if (submitted) root.querySelector<HTMLButtonElement>('button[type="submit"]')?.focus(); else if (activeName && doc.activeElement === doc.body) root.querySelector<HTMLElement>(`[name="${activeName}"]`)?.focus(); } }
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
      const rememberHA = () => { const index = section.querySelector<HTMLSelectElement>('[name="ha_connection"]')!.value;
        const row = index ? ha.connections[Number(index)] : null;
        haDraft = { choice: row ? { name: row.name, enrolled_at: row.enrolled_at } : index === 'missing' ? haChoice : null,
          entity: section.querySelector<HTMLInputElement>('[name="ha_entity"]')!.value }; dirty = true; };
      section.querySelector('form')!.addEventListener('input', rememberHA); section.querySelector('form')!.addEventListener('change', rememberHA);
      for (const node of section.querySelectorAll<HTMLElement>('input,select,button')) node.style.minHeight = '44px';
      section.querySelector('form')!.addEventListener('submit', async event => {
        event.preventDefault(); if (busy || !value) return;
        const index = section.querySelector<HTMLSelectElement>('[name="ha_connection"]')!.value;
        const entity_id = section.querySelector<HTMLInputElement>('[name="ha_entity"]')!.value.trim();
        busy = true; for (const node of root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button')) node.disabled = true;
        try {
          const row = ha.connections[Number(index)]; if (index && (!row || index === 'missing')) throw new Error('Choose an enrolled Home Assistant connection');
          await opts.save({ action: 'household.home_assistant', connection_name: index ? row!.name : null,
            ...(index ? { connection_enrolled_at: row!.enrolled_at, entity_id } : {}) });
          const next = await opts.read(); if (!disposed) { value = next; haDraft = undefined; dirty = !!telegramDraft; render(); message('Household Home Assistant saved.'); }
        } catch (error) { if (!disposed) message(error instanceof Error ? error.message : String(error), true); }
        finally { busy = false; if (!disposed) { for (const node of root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button')) node.disabled = false;
          root.querySelector<HTMLButtonElement>('[data-household-home-assistant] button[type="submit"]')?.focus(); } }
      });
    }
  };
  const refresh = async () => {
    if (busy || dirty || disposed) return; root.textContent = 'Loading household delivery…';
    try { const next = await opts.read(); if (!next) throw new Error('Household delivery is unavailable on this server'); if (!disposed) { value = next; render(); } }
    catch (error) { if (!disposed && classifyRpcError(error).code === 'unknown_method') { root.remove(); return; } if (!disposed) { root.textContent = error instanceof Error ? error.message : String(error); const retry = doc.createElement('button'); retry.textContent = 'Retry household delivery'; retry.addEventListener('click', () => { void refresh(); }); root.append(retry); } }
  };
  void refresh(); return { refresh, hasInFlightWork: () => busy, hasUnsavedChanges: () => dirty, dispose() { disposed = true; root.remove(); } };
};
