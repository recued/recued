/** Apps & APIs → Advanced → "Replace a connection": move selected pack lists
 *  and saved recipe connection choices from one enrolled API connection to
 *  another, as an owner-reviewed change with a receipt and a separately
 *  reviewed undo.
 *
 *  Three steps — choose the two connections, choose what moves, review and
 *  confirm. The server plan is the only thing that can be confirmed: it
 *  carries both account identities, the automation it touches and any
 *  blocker, it expires, and a lost reply is recovered by resending the exact
 *  same request, never a new one. Every control keeps a
 *  `data-replacement-focus` key so focus survives the re-render that follows
 *  each reply. */
import type { ConnectionReplacementInspection as Inspection, ConnectionReplacementPlan as Plan,
  ConnectionReplacementReview as Review, ConnectionReplacementRollback as Rollback,
  ConnectionReplacementApply as Apply, ConnectionReplacementResult as Result,
  ConnectionReplacementIdentity as Identity } from '@recued/contracts';
import type { ConnectionReplacementCaller } from './connection-replacement-caller.js';

const count = (n: number, one: string, many = one + 's'): string => n + ' ' + (n === 1 ? one : many);

export const mountConnectionReplacementPanel = (options: {
  host: HTMLElement; caller: ConnectionReplacementCaller; busyOther?(): boolean; changed?(): void;
}) => {
  const doc = options.host.ownerDocument, root = doc.createElement('section');root.dataset.connectionReplacement = '';
  root.className = 'connection-replacement';options.host.append(root);
  let disposed = false, busy = false, busyText = '', error = '', message = '', from = '', to = '', evidence = false, ack = false, spent = false, historyOpen = false;
  let inspection: Inspection | undefined, plan: Plan | undefined, result: Result | undefined;
  let pendingReview: { kind: 'replace'; value: Review } | { kind: 'rollback'; value: Rollback } | undefined, pendingApply: Apply | undefined;
  const packs = new Set<string>(), dishes = new Set<string>();let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') => {
    const el = doc.createElement(tag);el.textContent = text;if (className) el.className = className;return el;
  };
  const keyOf = (slug: string, slot: string) => JSON.stringify([slug, slot]);
  const unavailable = () => disposed || busy || !!options.busyOther?.();
  const applyable = () => !unavailable() && !!plan && !spent && !plan.blockers.length && plan.expires_at > Date.now() && ack && !pendingApply;
  const focusKey = () => root.contains(doc.activeElement) ? (doc.activeElement as HTMLElement).dataset.replacementFocus : undefined;
  const focus = (key?: string) => {
    if (!key || disposed || doc.activeElement && doc.activeElement !== doc.body && !root.contains(doc.activeElement)) return;
    const found = [...root.querySelectorAll<HTMLElement>('[data-replacement-focus]')].find(el => el.dataset.replacementFocus === key && !('disabled' in el && el.disabled));
    (found ?? root.querySelector<HTMLElement>('[data-replacement-focus="status"]'))?.focus({ preventScroll: true });
  };
  const button = (label: string, key: string, run: () => void, variant: 'primary' | 'outline' = 'outline', name?: string) => {
    const el = node('button', label, 'rx-btn rx-btn-' + variant + ' rx-btn-sm');el.type = 'button';el.dataset.replacementFocus = key;
    if (name) el.setAttribute('aria-label', name);
    el.disabled = unavailable();el.onclick = () => { if (!unavailable()) run(); };return el;
  };
  const checkbox = (label: string | HTMLElement, key: string, checked: boolean, change: (checked: boolean) => void, disabled = false) => {
    const wrapper = node('label', '', 'replacement-check'), input = node('input');input.type = 'checkbox';input.checked = checked;
    input.dataset.replacementFocus = key;input.disabled = unavailable() || disabled;
    input.onchange = () => { change(input.checked);render(); };
    const text = typeof label === 'string' ? node('span', label) : label;wrapper.append(input, text);return wrapper;
  };
  const actions = (...children: HTMLElement[]) => { const row = node('div', '', 'replacement-actions');row.append(...children);return row; };
  const step = (number: string, title: string) => {
    const section = node('div', '', 'replacement-step'), heading = node('h4', '', 'replacement-step-title');
    heading.append(node('span', number, 'replacement-step-number'), doc.createTextNode(title));section.append(heading);return section;
  };
  const muted = (text: string) => node('p', text, 'replacement-muted');
  const connectionLabel = (identity: Identity) => `${identity.display_name} (${identity.connection_name})`;
  const identityCard = (role: string, identity: Identity) => {
    const row = node('div', '', 'replacement-identity');row.append(node('span', role, 'replacement-identity-role'));
    const detail = node('div', '', 'replacement-identity-detail');detail.append(node('strong', connectionLabel(identity)),
      node('span', identity.host ?? 'API address unknown'), node('span', 'Account ID ' + identity.identity, 'replacement-identity-id'));
    row.append(detail);return row;
  };
  const alert = (text: string) => { const p = node('p', text, 'replacement-alert');p.setAttribute('role', 'alert');return p; };
  const clear = () => { plan = undefined;result = undefined;pendingReview = undefined;pendingApply = undefined;ack = false;spent = false;error = '';if (expiryTimer) clearTimeout(expiryTimer); };
  const render = () => {
    if (disposed) return;const previous = focusKey();root.replaceChildren();
    root.append(node('p', 'Use this when you move to a new account. Settings tied to one account, such as saved record IDs, and webhooks are not moved; '
      + 'change those where they are set up.', 'replacement-intro'));
    // One status line, kept beside the newest step: progress, the server's
    // error, or what just happened. It is also the focus anchor while busy.
    const status = node('p', busy ? busyText : error || message, error ? 'replacement-status replacement-alert' : 'replacement-status');status.tabIndex = -1;status.dataset.replacementFocus = 'status';
    status.setAttribute('role', error ? 'alert' : 'status');
    const locked = !!plan || !!pendingReview || !!pendingApply;
    let history: HTMLElement | undefined;
    const inspect = button(inspection ? 'Refresh' : 'Read connections', 'inspect', () => { void inspectPair(); });inspect.disabled ||= locked;
    if (!inspection) root.append(actions(inspect));
    if (inspection) {
      const choose = step('1', 'Choose the connections');
      const pair = node('div', '', 'replacement-pair');
      const select = (label: string, key: string, value: string, excluded: string, update: (value: string) => void) => {
        const wrapper = node('label', '', 'replacement-field'), input = node('select');input.dataset.replacementFocus = key;input.setAttribute('aria-label', label);
        const empty = node('option', 'Choose a connection');empty.value = '';input.append(empty);
        for (const identity of inspection!.connections.filter(item => item.connection_name !== excluded)) {
          const option = node('option', `${connectionLabel(identity)} · ${identity.host ?? 'unknown host'}`);option.value = identity.connection_name;input.append(option);
        }
        input.value = value;input.disabled = unavailable() || locked;
        input.onchange = () => { update(input.value);evidence = false;packs.clear();dishes.clear();clear();render();if (from && to) void inspectPair(); };
        wrapper.append(node('span', label, 'replacement-field-label'), input);return wrapper;
      };
      pair.append(select('Replace', 'from', from, to, value => { from = value; }), node('span', '→', 'replacement-arrow'),
        select('With', 'to', to, from, value => { to = value; }));
      choose.append(pair);
      if (!inspection.connections.length) choose.append(muted('No API connections are set up yet.'));
      choose.append(actions(inspect));
      root.append(choose);
      if (evidence && !plan) {
        const pick = step('2', 'Choose what moves');
        const list = node('ul', '', 'replacement-choices');
        for (const pack of inspection.packs) {
          const key = keyOf(pack.pack_slug, pack.slot), item = node('li');
          const label = node('span');label.append(node('strong', pack.pack_name), doc.createTextNode(' pack · ' + pack.slot));
          item.append(checkbox(label, 'pack:' + key, packs.has(key), value => { value ? packs.add(key) : packs.delete(key); }, !!pendingReview || !!pendingApply || !!pack.blockers.length));
          item.append(muted(`Uses ${pack.before_connections.join(', ') || 'none'} → ${pack.after_connections.join(', ') || 'none'}. Default ${pack.before_default ?? 'none'} → ${pack.after_default ?? 'none'}.`));
          if (pack.shared_with.length) item.append(muted(`Shared sign-ins also move: ${pack.shared_with.join(', ')}.`));
          for (const issue of pack.blockers) item.append(alert(issue.message));
          list.append(item);
        }
        for (const dish of inspection.dishes) {
          const item = node('li'), label = node('span');label.append(node('strong', dish.name), doc.createTextNode(' · saved choice for ' + dish.slots.join(', ')));
          item.append(checkbox(label, 'dish:' + dish.dish_id, dishes.has(dish.dish_id), value => { value ? dishes.add(dish.dish_id) : dishes.delete(dish.dish_id); }, !!pendingReview || !!pendingApply));
          list.append(item);
        }
        if (list.childElementCount) pick.append(list);
        else pick.append(muted('Nothing uses this connection: no pack lists or saved recipe choices name it.'));
        const review = button('Review changes', 'review', () => { void reviewSelection(); }, 'primary');review.disabled ||= !packs.size && !dishes.size || !!pendingReview || !!pendingApply;
        pick.append(actions(review));root.append(pick);
      }
      if (inspection.recent.length || inspection.unavailable_receipts) {
        const details = node('details', '', 'replacement-history');history = details;details.open = historyOpen;
        details.addEventListener('toggle', () => { historyOpen = details.open; });
        details.append(node('summary', `Recent replacements (${inspection.recent.length})`));
        const list = node('ul', '', 'replacement-history-list');
        for (const item of inspection.recent) {
          const { receipt } = item, pairText = `${receipt.from.display_name} → ${receipt.to.display_name}`;
          const kind = receipt.direction === 'replace' ? 'replacement' : 'undo';
          const row = node('li'), heading = node('div', '', 'replacement-history-heading');
          heading.append(node('strong', pairText), node('span', (receipt.direction === 'replace' ? 'Replacement' : 'Undo') + ' · ' + new Date(receipt.completed_at).toLocaleString(), 'replacement-muted'));
          row.append(heading);
          const recover = button('Show result', 'receipt:' + receipt.review_id, () => {
            clear();pendingApply = structuredClone(item.request);void apply(true);
          }, 'outline', `Show result of ${pairText} ${kind}`);recover.disabled ||= !!pendingApply || !!pendingReview;
          const buttons = [recover];
          if (receipt.direction === 'replace') {
            const rollback = button('Undo…', 'rollback:' + receipt.review_id, () => { void reviewRollback(receipt.review_id); }, 'outline', `Review undo of ${pairText} ${kind}`);
            rollback.disabled ||= !!pendingApply || !!pendingReview;buttons.push(rollback);
          }
          row.append(actions(...buttons));list.append(row);
        }
        details.append(list);
        if (inspection.unavailable_receipts) details.append(muted(`${count(inspection.unavailable_receipts, 'earlier receipt')} could not be read. Refresh, or review the current state.`));
      }
    }
    if (pendingReview && !plan) root.append(actions(button('Try loading the review again', 'retry-review', () => { void runReview(); }, 'primary')));
    if (pendingApply && !result) root.append(actions(button('Check whether it completed', 'recover', () => { void apply(true); }, 'primary')));
    if (plan) {
      const confirm = step('3', spent ? 'What changed' : plan.direction === 'replace' ? 'Review and confirm' : 'Review the undo');
      confirm.classList.add('replacement-review');
      const identities = node('div', '', 'replacement-identities');identities.append(identityCard('From', plan.from), identityCard('To', plan.to));confirm.append(identities);
      const changes = node('ul', '', 'replacement-changes');
      for (const change of plan.changes) changes.append(node('li', change));
      for (const pack of plan.packs) changes.append(node('li', `${pack.pack_name} (${pack.catalogs.join(', ')}): uses ${pack.before_connections.join(', ') || 'none'} → ${pack.after_connections.join(', ') || 'none'}; default ${pack.before_default ?? 'none'} → ${pack.after_default ?? 'none'}.`));
      for (const impact of plan.impacts) changes.append(node('li', `${impact.name}: ${count(impact.dish_ids.length, 'saved setting')}, ${count(impact.schedules, 'schedule')}, ${count(impact.triggers, 'trigger')}, ${count(impact.timers, 'timer')} affected.`));
      if (changes.childElementCount) { confirm.append(node('p', 'What changes', 'replacement-subtitle'), changes); }
      for (const issue of plan.blockers) confirm.append(alert(issue.message + (issue.resource ? ' (' + issue.resource + ')' : '')));
      if (!spent && !pendingApply) {
        confirm.append(muted(plan.expires_at > Date.now() ? `This review is good until ${new Date(plan.expires_at).toLocaleTimeString()}.` : 'This review expired. Start over to review the current state.'));
        confirm.append(checkbox('I checked both accounts and the automation above, and want to make these changes.', 'ack', ack, value => { ack = value; }, !!plan.blockers.length));
        const go = button(plan.direction === 'rollback' ? 'Undo replacement' : 'Replace connection', 'confirm', () => { void apply(); }, 'primary');go.disabled = !applyable();
        confirm.append(actions(go));
      }
      root.append(confirm);
    }
    if (result) {
      const done = node('div', '', 'replacement-result');
      done.append(status, node('p', `Receipt ${result.receipt.request_id}`, 'replacement-muted'));
      done.append(node('p', result.current ? 'Recent replacements below includes this change.' : 'Recued could not read your connections again. Check the current state before making another change.'));
      const next: HTMLElement[] = [];
      if (result.reconciliation_pending) next.push(button('Finish the remaining updates', 'reconcile', () => { void apply(true); }, 'primary'));
      if (result.receipt.direction === 'replace') next.push(button('Undo this replacement…', 'undo', () => { void reviewRollback(result!.receipt.review_id); }));
      if (next.length) done.append(actions(...next));
      root.append(done);
    } else root.append(status);
    if (plan || pendingReview || pendingApply || result) root.append(actions(button(result ? 'Start a new replacement' : 'Start over', 'fresh', () => {
      const uncertain = !!pendingApply && !result;clear();evidence = false;packs.clear();dishes.clear();message = uncertain ? 'The earlier confirmation may have completed. Check Recent replacements before choosing another change.' : '';void inspectPair();
    })));
    if (history) root.append(history);
    focus(previous);
  };
  const run = async (operation: () => Promise<void>, working: string, success?: string) => {
    if (unavailable()) return;busy = true;busyText = working;error = '';render();
    try { await operation();if (!disposed && success !== undefined) message = success; }
    catch (cause) { if (!disposed) error = cause instanceof Error ? cause.message : String(cause); }
    finally { if (!disposed) { busy = false;render(); } }
  };
  const inspectPair = () => run(async () => {
    const next = await options.caller.inspect(from && to ? { from_connection: from, to_connection: to } : {});
    if (disposed) return;inspection = next;evidence = !!from && !!to;
    const available = new Set(next.connections.map(item => item.connection_name));if (!available.has(from) || !available.has(to)) { if (!available.has(from)) from = '';if (!available.has(to)) to = '';evidence = false; }
    const targets = new Set(next.packs.map(pack => keyOf(pack.pack_slug, pack.slot)));for (const key of packs) if (!targets.has(key)) packs.delete(key);
    for (const id of dishes) if (!next.dishes.some(dish => dish.dish_id === id)) dishes.delete(id);
  }, 'Reading your connections…');
  const runReview = () => run(async () => {
    const request = pendingReview!;
    const next = request.kind === 'replace' ? await options.caller.review(request.value) : await options.caller.rollback(request.value);
    if (disposed) return;plan = next;pendingReview = undefined;ack = false;spent = false;
    if (expiryTimer) clearTimeout(expiryTimer);expiryTimer = setTimeout(() => { if (!disposed) render(); }, Math.max(0, next.expires_at - Date.now()) + 5);
  }, 'Preparing the review…', '');
  const reviewSelection = async () => {
    if (unavailable() || !evidence || !inspection || pendingApply) return;
    clear();pendingReview = { kind: 'replace', value: { from_connection: from, to_connection: to, targets: inspection.packs.filter(pack => packs.has(keyOf(pack.pack_slug, pack.slot))).map(({ pack_slug, slot }) => ({ pack_slug, slot })), dish_ids: [...dishes], request_id: crypto.randomUUID() } };
    await runReview();
  };
  const reviewRollback = async (id: string) => {
    if (unavailable()) return;clear();pendingReview = { kind: 'rollback', value: { receipt_id: id, request_id: crypto.randomUUID() } };await runReview();
  };
  const apply = async (recover = false) => {
    if (unavailable() || !recover && !applyable()) return;
    if (!pendingApply) { if (!plan) return;pendingApply = { review_id: plan.review_id, request_id: crypto.randomUUID(), acknowledge_account_change: true }; }
    await run(async () => {
      const next = await options.caller.apply(pendingApply!);if (disposed) return;
      result = next;spent = true;ack = false;packs.clear();dishes.clear();if (next.current) inspection = next.current;evidence = false;
      // Keep the exact attempt for reconciliation; new edits require a new review.
      try { options.changed?.(); } catch { /* the durable receipt remains visible */ }
      message = (next.receipt.direction === 'rollback' ? 'Undo' : 'Replacement') + ' completed.';
    }, recover ? 'Checking the earlier change…' : 'Making the changes…');
  };
  render();
  return { busy: () => busy, hasDraft: () => !!pendingReview || !!pendingApply && !spent || !!plan && !spent || packs.size > 0 || dishes.size > 0,
    /** The card opened: read the connections the first time. */
    activate: () => { if (!inspection && !busy && !disposed) void inspectPair(); },
    dispose: () => { disposed = true;if (expiryTimer) clearTimeout(expiryTimer);root.remove(); } };
};

export const CONNECTION_REPLACEMENT_STYLES = `
.connection-replacement { display: grid; gap: 14px; min-width: 0; font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
.connection-replacement p { margin: 0; }
.connection-replacement .replacement-intro { color: var(--fg-muted); }
.connection-replacement .replacement-status { color: var(--fg-muted); }
.connection-replacement .replacement-status:empty { display: none; }
.connection-replacement .replacement-result .replacement-status { color: var(--fg-strong, var(--fg)); font-weight: 650; }
.connection-replacement .replacement-alert { color: var(--danger); }
.connection-replacement .replacement-muted { color: var(--fg-muted); font-size: 12.5px; }
.connection-replacement .replacement-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.connection-replacement .replacement-actions .rx-btn { white-space: normal; max-width: 100%; }
.connection-replacement .replacement-step {
  display: grid; gap: 10px; min-width: 0; padding: 14px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface-sunk);
}
.connection-replacement .replacement-step-title {
  display: flex; align-items: center; gap: 8px; margin: 0;
  color: var(--fg-strong, var(--fg)); font-size: 13.5px; font-weight: 650;
}
.connection-replacement .replacement-step-number {
  display: inline-grid; place-items: center; width: 20px; height: 20px; flex: none; border-radius: 50%;
  background: var(--accent); color: var(--on-accent); font-size: 11px; font-weight: 700;
}
.connection-replacement .replacement-pair { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: end; gap: 10px; }
.connection-replacement .replacement-arrow { padding-bottom: 9px; color: var(--fg-muted); font-weight: 700; }
.connection-replacement .replacement-field { display: grid; gap: 4px; min-width: 0; }
.connection-replacement .replacement-field-label { color: var(--fg-muted); font-size: 12px; font-weight: 600; }
.connection-replacement select {
  box-sizing: border-box; width: 100%; min-width: 0; min-height: 36px; padding: 7px 10px;
  font: inherit; color: var(--fg); background: var(--surface); border: 1px solid var(--border-strong); border-radius: 7px;
}
.connection-replacement .replacement-choices, .connection-replacement .replacement-changes,
.connection-replacement .replacement-history-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.connection-replacement .replacement-choices > li {
  display: grid; gap: 3px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface);
}
.connection-replacement .replacement-choices .replacement-muted { padding-left: 26px; }
.connection-replacement .replacement-check { display: flex; align-items: flex-start; gap: 8px; cursor: pointer; }
.connection-replacement .replacement-check input { width: 18px; height: 18px; margin: 1px 0 0; flex: none; }
.connection-replacement .replacement-identities { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px; }
.connection-replacement .replacement-identity {
  display: grid; gap: 2px; min-width: 0; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface);
}
.connection-replacement .replacement-identity-role { color: var(--fg-muted); font-size: 11px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; }
.connection-replacement .replacement-identity-detail { display: grid; gap: 1px; min-width: 0; }
.connection-replacement .replacement-identity-id { color: var(--fg-muted); font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11.5px; }
.connection-replacement .replacement-subtitle { color: var(--fg-strong, var(--fg)); font-weight: 650; }
.connection-replacement .replacement-changes { gap: 4px; padding-left: 18px; list-style: disc; }
.connection-replacement .replacement-result {
  display: grid; gap: 8px; padding: 12px 14px; border: 1px solid var(--border-strong); border-radius: 10px;
  background: linear-gradient(135deg, var(--accent-weak), transparent 60%), var(--surface);
}
.connection-replacement .replacement-history { min-width: 0; border-top: 1px solid var(--border); padding-top: 10px; }
.connection-replacement .replacement-history > summary { cursor: pointer; color: var(--fg); font-weight: 600; }
.connection-replacement .replacement-history-list { margin-top: 10px; }
.connection-replacement .replacement-history-list > li {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px;
  padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface);
}
.connection-replacement .replacement-history-heading { display: grid; gap: 1px; min-width: 0; }
@media (max-width: 560px) {
  .connection-replacement .replacement-pair { grid-template-columns: minmax(0, 1fr); }
  .connection-replacement .replacement-arrow { display: none; }
}
`;
