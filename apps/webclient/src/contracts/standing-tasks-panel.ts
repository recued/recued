import type { AssetRule, ProactiveProposal, YoursCommand, YoursCommandResult, YoursReadRequest, YoursSnapshot } from '@recued/contracts';
import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import { parseReminderOffsets } from '../yours/bootstrap-yours-route.js';
import { classifyRpcError } from '../shell/rpc-error-copy.js';

export interface StandingTasksOptions {
  host: HTMLElement;
  read(input: YoursReadRequest): Promise<YoursSnapshot>;
  change(input: YoursCommand): Promise<YoursCommandResult>;
  subscribe?: BroadcastSubscriber['on'];
}
/** Owner-confirmed annual tasks share the proposal review home with staged
 * delegation. Accepting one creates an occasion clock; it grants no authority. */
export const mountStandingTasksPanel = (options: StandingTasksOptions) => {
  const doc = options.host.ownerDocument; const root = doc.createElement('section'); options.host.append(root);
  root.dataset.standingTasks = '';
  let rows: ProactiveProposal[] = []; let editing: ProactiveProposal | undefined; let busy = false; let dirty = false;
  let disposed = false; let generation = 0; let error = ''; let message = '';
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, parent: HTMLElement, text?: string) => {
    const value = doc.createElement(tag); if (text !== undefined) value.textContent = text; parent.append(value); return value;
  };
  const render = () => {
    root.replaceChildren(); root.hidden = !rows.length && !error;
    if (root.hidden) return;
    node('h2', root, 'Proposals · annual tasks');
    node('p', root, 'Review a task suggested from your own accepted precedents. Each year asks you to act; accepting grants no purchase, booking or message permission.');
    node('p', root, message).setAttribute('role', 'status'); node('p', root, error).setAttribute('role', 'alert');
    root.setAttribute('aria-busy', String(busy));
    const button = (parent: HTMLElement, text: string, action: () => Promise<void> | void) => {
      const value = node('button', parent, text); value.type = 'button'; value.disabled = busy; value.style.minHeight = '44px';
      value.addEventListener('click', () => { void Promise.resolve().then(action).catch(value => { if (!disposed) { error = String(value instanceof Error ? value.message : value); render(); } }); }); return value;
    };
    for (const proposal of rows) {
      const article = node('article', root); node('h3', article, proposal.title); node('p', article, proposal.explanation);
      for (const source of proposal.sources.filter(ref => ref.collection === 'episode')) { const link = node('a', article, 'Open precedent'); link.href = `#yours/episodes/episode/${encodeURIComponent(source.id)}`; }
      if (editing?.id !== proposal.id) {
        button(article, 'Accept annual task', () => mutate({ action: 'proposal.accept', ids: [proposal.id] }));
        button(article, 'Edit annual task', () => { editing = proposal; dirty = false; render(); root.querySelector<HTMLInputElement>('input')?.focus(); });
        button(article, 'Not now', () => mutate({ action: 'proposal.dismiss', id: proposal.id, code: 'not_now' }));
        button(article, 'Never this kind', () => mutate({ action: 'proposal.dismiss', id: proposal.id, code: 'never_this_kind' }));
        button(article, 'Delete proposal', () => mutate({ action: 'proposal.delete', id: proposal.id })); continue;
      }
      const form = node('form', article); const rule = proposal.payload.rule as AssetRule;
      const input = (title: string, value: string, type = 'text') => {
        const label = node('label', form, title); label.style.display = 'grid'; const field = node('input', label); field.type = type; field.value = value; field.required = true; field.setAttribute('aria-label', title);
        field.style.minHeight = '44px'; field.disabled = busy; field.addEventListener('input', () => { dirty = true; }); return field;
      };
      const title = input('Annual task', rule.title); const before = input('Remind before the due date', rule.schedule.before.map(point => `${point.amount} ${point.unit}`).join(', ')); before.required = false;
      const offset = input('Days before the occasion', String(rule.when.kind === 'expiry' ? rule.when.offset?.amount ?? 0 : 0), 'number'); offset.min = '0'; offset.max = '365';
      const proposed = proposal.payload.occasion as { title: string; month_day: string } | undefined;
      const occasionTitle = proposed ? input('Occasion name', proposed.title) : null;
      const annual = proposed ? input('Annual date (MM-DD)', proposed.month_day) : null;
      const save = node('button', form, 'Save proposal'); save.type = 'submit'; save.disabled = busy; save.style.minHeight = '44px';
      form.addEventListener('submit', event => { event.preventDefault(); if (busy) return;
        try {
        if (!Number.isInteger(Number(offset.value)) || Number(offset.value) < 0 || Number(offset.value) > 365) throw new Error('Choose zero to 365 days before the occasion');
        const payload = { ...proposal.payload, rule: { ...rule, title: title.value, enabled: false, pinned: false,
          when: { kind: 'expiry', field: 'next_on', ...(Number(offset.value) ? { offset: { amount: Number(offset.value), unit: 'days' } } : {}) },
          schedule: { ...rule.schedule, before: parseReminderOffsets(before.value) } },
          ...(proposed ? { occasion: { ...proposed, title: occasionTitle!.value, month_day: annual!.value } } : {}) };
        void mutate({ action: 'proposal.edit', id: proposal.id, payload });
        } catch (value) { error = value instanceof Error ? value.message : String(value); root.querySelector<HTMLElement>('[role=alert]')!.textContent = error; }
      });
      button(form, 'Cancel edit', () => { if (dirty && doc.defaultView?.confirm && !doc.defaultView.confirm('Discard these unsaved changes?')) return; editing = undefined; dirty = false; render(); });
    }
  };
  const refresh = async () => {
    if (disposed || editing || busy) return; const version = ++generation;
    try { const result = await options.read({ proposal_kind: 'habit', mark_shown: true }); if (disposed || generation !== version) return; rows = result.proposals; error = ''; }
    catch (value) { if (disposed || generation !== version) return; if (classifyRpcError(value).code === 'unknown_method') { root.remove(); return; }
      error = value instanceof Error ? value.message : String(value); }
    render();
  };
  const mutate = async (command: YoursCommand) => {
    if (disposed || busy) return; busy = true; error = '';
    root.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input').forEach(value => { value.disabled = true; }); root.setAttribute('aria-busy', 'true');
    try { const result = await options.change(command); if (disposed) return;
      if (result.failed?.length) throw new Error(result.failed.map(row => row.reason).join(' '));
      message = result.message; editing = undefined; dirty = false;
    } catch (value) { if (!disposed) error = value instanceof Error ? value.message : String(value); }
    finally { busy = false; if (!disposed) { if (editing) { root.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input').forEach(value => { value.disabled = false; }); root.setAttribute('aria-busy', 'false');
      root.querySelector<HTMLElement>('[role=alert]')!.textContent = error; } else await refresh(); } }
  };
  const unsubscribes = options.subscribe ? [options.subscribe('warehouse', () => { void refresh(); }), options.subscribe('memory', () => { void refresh(); })] : [];
  void refresh();
  return { hasInFlightWork: () => busy, hasUnsavedChanges: () => dirty, dispose() { disposed = true; generation++; unsubscribes.forEach(unsubscribe => unsubscribe()); root.remove(); } };
};
