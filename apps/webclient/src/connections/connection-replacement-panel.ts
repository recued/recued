import type { ConnectionReplacementInspection as Inspection, ConnectionReplacementPlan as Plan,
  ConnectionReplacementReview as Review, ConnectionReplacementRollback as Rollback,
  ConnectionReplacementApply as Apply, ConnectionReplacementResult as Result,
  ConnectionReplacementIdentity as Identity } from '@recued/contracts';
import type { ConnectionReplacementCaller } from './connection-replacement-caller.js';
export const mountConnectionReplacementPanel = (options: {
  host: HTMLElement; caller: ConnectionReplacementCaller; busyOther?(): boolean; changed?(): void;
}) => {
  const doc = options.host.ownerDocument, root = doc.createElement('section');root.dataset.connectionReplacement = '';
  root.style.cssText = 'min-width:0;max-width:100%;overflow-wrap:anywhere;margin:16px 0';options.host.append(root);
  let disposed = false, busy = false, expanded = false, error = '', message = '', from = '', to = '', evidence = false, ack = false, spent = false;
  let inspection: Inspection | undefined, plan: Plan | undefined, result: Result | undefined;
  let pendingReview: { kind: 'replace'; value: Review } | { kind: 'rollback'; value: Rollback } | undefined, pendingApply: Apply | undefined;
  const packs = new Set<string>(), dishes = new Set<string>();let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => { const el = doc.createElement(tag);el.textContent = text;return el; };
  const keyOf = (slug: string, slot: string) => JSON.stringify([slug, slot]);
  const unavailable = () => disposed || busy || !!options.busyOther?.();
  const applyable = () => !unavailable() && !!plan && !spent && !plan.blockers.length && plan.expires_at > Date.now() && ack && !pendingApply;
  const focusKey = () => root.contains(doc.activeElement) ? (doc.activeElement as HTMLElement).dataset.replacementFocus : undefined;
  const focus = (key?: string) => {
    if (!key || disposed || doc.activeElement && doc.activeElement !== doc.body && !root.contains(doc.activeElement)) return;
    const found = [...root.querySelectorAll<HTMLElement>('[data-replacement-focus]')].find(el => el.dataset.replacementFocus === key && !('disabled' in el && el.disabled));
    (found ?? root.querySelector<HTMLElement>('[data-replacement-focus="status"]'))?.focus({ preventScroll: true });
  };
  const button = (label: string, key: string, run: () => void) => {
    const el = node('button', label);el.type = 'button';el.className = 'rx-btn rx-btn-outline rx-btn-sm';el.dataset.replacementFocus = key;
    el.style.cssText = 'white-space:normal;max-width:100%;margin:4px';el.disabled = unavailable();el.onclick = () => { if (!unavailable()) run(); };return el;
  };
  const checkbox = (label: string, key: string, checked: boolean, change: (checked: boolean) => void, disabled = false) => {
    const wrapper = node('label'), input = node('input');wrapper.style.cssText = 'display:block;margin:10px 0';input.type = 'checkbox';input.checked = checked;
    input.dataset.replacementFocus = key;input.disabled = unavailable() || disabled;
    input.onchange = () => { change(input.checked);render(); };wrapper.append(input, doc.createTextNode(' ' + label));return wrapper;
  };
  const identify = (identity: Identity) => `${identity.display_name} (${identity.connection_name}) · ${identity.host ?? 'unknown API host'} · identity ${identity.identity}`;
  const clear = () => { plan = undefined;result = undefined;pendingReview = undefined;pendingApply = undefined;ack = false;spent = false;error = '';if (expiryTimer) clearTimeout(expiryTimer); };
  const render = () => {
    if (disposed) return;const previous = focusKey();root.replaceChildren();
    const details = node('details');details.open = expanded;details.ontoggle = () => { expanded = details.open; };
    const summary = node('summary', 'Reviewed connection replacement');summary.dataset.replacementFocus = 'summary';details.append(summary);
    const status = node('p', busy ? 'Reading reviewed account references…' : error || message);status.tabIndex = -1;status.dataset.replacementFocus = 'status';status.setAttribute('role', error ? 'alert' : 'status');details.append(status);
    details.append(node('p', 'Move selected pack lists and saved recipe account choices to another enrolled API connection. Review shared sign-ins and automation before confirming. Account-bound settings and webhooks must be handled through their existing setup flows.'));
    const inspect = button(inspection ? 'Refresh connection evidence' : 'Inspect connections', 'inspect', () => { void inspectPair(); });inspect.disabled ||= !!plan || !!pendingApply || !!pendingReview;details.append(inspect);
    if (inspection) {
      const select = (label: string, key: string, value: string, excluded: string, update: (value: string) => void) => {
        const wrapper = node('label', label + ' '), input = node('select');input.dataset.replacementFocus = key;input.style.cssText = 'max-width:100%;display:block;width:100%';input.setAttribute('aria-label', label);
        const empty = node('option', 'Choose an enrolled API connection');empty.value = '';input.append(empty);
        for (const identity of inspection!.connections.filter(item => item.connection_name !== excluded)) {
          const option = node('option', `${identity.display_name} (${identity.connection_name}) · ${identity.host ?? 'unknown host'}`);option.value = identity.connection_name;input.append(option);
        }
        input.value = value;input.disabled = unavailable() || !!plan || !!pendingReview || !!pendingApply;
        input.onchange = () => { update(input.value);evidence = false;packs.clear();dishes.clear();clear();render(); };wrapper.append(input);details.append(wrapper);
      };
      select('Source connection', 'from', from, to, value => { from = value; });select('Replacement connection', 'to', to, from, value => { to = value; });
      if (from && to && !plan && !pendingApply) details.append(button('Inspect selected usages', 'usages', () => { void inspectPair(); }));
      if (evidence && !plan) {
        details.append(node('h4', 'Select local references'));
        for (const pack of inspection.packs) {
          const key = keyOf(pack.pack_slug, pack.slot);
          details.append(checkbox(`${pack.pack_name} · ${pack.slot}`, 'pack:' + key, packs.has(key), value => { value ? packs.add(key) : packs.delete(key); }, !!pendingReview || !!pendingApply || !!pack.blockers.length));
          details.append(node('p', `List: ${pack.before_connections.join(', ')} → ${pack.after_connections.join(', ')}. Default: ${pack.before_default ?? 'none'} → ${pack.after_default ?? 'none'}.`));
          if (pack.shared_with.length) details.append(node('p', `Shared sign-ins also move: ${pack.shared_with.join(', ')}.`));
          for (const issue of pack.blockers) details.append(node('p', issue.message));
        }
        for (const dish of inspection.dishes) details.append(checkbox(`${dish.name} · saved choice for ${dish.slots.join(', ')}`, 'dish:' + dish.dish_id, dishes.has(dish.dish_id), value => { value ? dishes.add(dish.dish_id) : dishes.delete(dish.dish_id); }, !!pendingReview || !!pendingApply));
        if (!inspection.packs.length && !inspection.dishes.length) details.append(node('p', 'No pack lists or explicit saved choices use the selected source.'));
        const review = button('Review selected replacement', 'review', () => { void reviewSelection(); });review.disabled ||= !packs.size && !dishes.size || !!pendingReview || !!pendingApply;details.append(review);
      }
      if (inspection.recent.length) {
        details.append(node('h4', 'Retained account change receipts'));
        for (const item of inspection.recent) {
          const recover = button(`Recover ${item.receipt.direction} receipt · ${item.receipt.from.display_name} → ${item.receipt.to.display_name}`, 'receipt:' + item.receipt.review_id, () => {
            clear();pendingApply = structuredClone(item.request);void apply(true);
          });recover.disabled ||= !!pendingApply || !!pendingReview;details.append(recover);
          if (item.receipt.direction === 'replace') {
            const rollback = button('Review rollback · ' + item.receipt.request_id, 'rollback:' + item.receipt.review_id, () => { void reviewRollback(item.receipt.review_id); });
            rollback.disabled ||= !!pendingApply || !!pendingReview;details.append(rollback);
          }
        }
      }
      if (inspection.unavailable_receipts) details.append(node('p', `${inspection.unavailable_receipts} retained receipts could not be read. Refresh evidence or review the current state.`));
    }
    if (pendingReview && !plan) details.append(button('Retry loading the same review', 'retry-review', () => { void runReview(); }));
    if (pendingApply && !result) details.append(button('Recover account change receipt', 'recover', () => { void apply(true); }));
    if (plan) {
      details.append(node('h4', plan.direction === 'replace' ? 'Review account replacement' : 'Review account rollback'));
      details.append(node('p', 'From: ' + identify(plan.from)), node('p', 'To: ' + identify(plan.to)));
      details.append(node('p', `Review expires at ${new Date(plan.expires_at).toLocaleTimeString()}.`));
      for (const change of plan.changes) details.append(node('p', change));
      for (const pack of plan.packs) details.append(node('p', `${pack.pack_name} · catalogs ${pack.catalogs.join(', ')}: list ${pack.before_connections.join(', ')} → ${pack.after_connections.join(', ')}; default ${pack.before_default ?? 'none'} → ${pack.after_default ?? 'none'}.`));
      for (const impact of plan.impacts) details.append(node('p', `${impact.name}: ${impact.dish_ids.length} saved recipe settings; ${impact.schedules} schedules, ${impact.triggers} triggers, ${impact.timers} timers affected.`));
      for (const issue of plan.blockers) { const alert = node('p', issue.message + (issue.resource ? ' (' + issue.resource + ')' : ''));alert.setAttribute('role', 'alert');details.append(alert); }
      if (!spent && !pendingApply) {
        details.append(checkbox('I reviewed the account identities and affected automation, and approve these local reference changes.', 'ack', ack, value => { ack = value; }, !!plan.blockers.length));
        const confirm = button(plan.direction === 'rollback' ? 'Confirm reviewed rollback' : 'Confirm reviewed replacement', 'confirm', () => { void apply(); });confirm.disabled = !applyable();details.append(confirm);
      }
      if (plan.expires_at <= Date.now() && !spent) details.append(node('p', 'This review expired. Inspect current state and review again.'));
    }
    if (result) {
      details.append(node('p', `${result.receipt.direction === 'rollback' ? 'Rollback' : 'Replacement'} completed · receipt ${result.receipt.request_id}.`));
      details.append(node('p', result.current ? 'Current enrolled connections and retained receipts were refreshed. This receipt records the earlier change.' : 'Current evidence could not be refreshed. Inspect again before another change.'));
      if (result.reconciliation_pending) details.append(button('Retry local reconciliation', 'reconcile', () => { void apply(true); }));
      if (result.receipt.direction === 'replace') details.append(button('Review rollback of this replacement', 'undo', () => { void reviewRollback(result!.receipt.review_id); }));
    }
    if (plan || pendingReview || pendingApply || result) details.append(button('Inspect current state and start a new review', 'fresh', () => {
      const uncertain = !!pendingApply && !result;clear();evidence = false;packs.clear();dishes.clear();message = uncertain ? 'The earlier confirmation may have completed. Check retained receipts before selecting another change.' : '';void inspectPair();
    }));
    root.append(details);focus(previous);
  };
  const run = async (operation: () => Promise<void>, success: string) => {
    if (unavailable()) return;busy = true;error = '';render();
    try { await operation();if (!disposed) message = success; }
    catch (cause) { if (!disposed) error = cause instanceof Error ? cause.message : String(cause); }
    finally { if (!disposed) { busy = false;render(); } }
  };
  const inspectPair = () => run(async () => {
    const next = await options.caller.inspect(from && to ? { from_connection: from, to_connection: to } : {});
    if (disposed) return;inspection = next;evidence = !!from && !!to;
    const available = new Set(next.connections.map(item => item.connection_name));if (!available.has(from) || !available.has(to)) { if (!available.has(from)) from = '';if (!available.has(to)) to = '';evidence = false; }
    const targets = new Set(next.packs.map(pack => keyOf(pack.pack_slug, pack.slot)));for (const key of packs) if (!targets.has(key)) packs.delete(key);
    for (const id of dishes) if (!next.dishes.some(dish => dish.dish_id === id)) dishes.delete(id);
  }, 'Connection evidence refreshed.');
  const runReview = () => run(async () => {
    const request = pendingReview!;
    const next = request.kind === 'replace' ? await options.caller.review(request.value) : await options.caller.rollback(request.value);
    if (disposed) return;plan = next;pendingReview = undefined;ack = false;spent = false;
    if (expiryTimer) clearTimeout(expiryTimer);expiryTimer = setTimeout(() => { if (!disposed) render(); }, Math.max(0, next.expires_at - Date.now()) + 5);
  }, 'Review the exact account changes before confirming.');
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
    }, 'Account-reference change completed.');
  };
  render();
  return { busy: () => busy, hasDraft: () => !!pendingReview || !!pendingApply && !spent || !!plan && !spent || packs.size > 0 || dishes.size > 0,
    dispose: () => { disposed = true;if (expiryTimer) clearTimeout(expiryTimer);root.remove(); } };
};
