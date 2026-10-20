import type { PackRepairInspection, PackRepairPlan, PackRepairReview, PackRepairApply, PackRepairApplyResult } from '@recued/contracts';
import type { PackRepairCaller } from './pack-repair-caller.js';

/** Mounted independently of catalog rows so an orphan or lost receipt stays reachable. */
export const createPackRepairPanel = (options: { document: Document; caller: PackRepairCaller; openPack?(slug: string): void; blocked?(): boolean }) => {
  const doc = options.document, root = doc.createElement('section');
  root.setAttribute('data-pack-repair-panel', '');root.style.cssText = 'min-width:0;max-width:100%;overflow-wrap:anywhere;padding:12px 4px';
  let inspection: PackRepairInspection | undefined, plan: PackRepairPlan | undefined, result: PackRepairApplyResult | undefined;
  let pendingReview: PackRepairReview | undefined, pendingApply: PackRepairApply | undefined;
  let targetKey: string | undefined;
  let busy = false, disposed = false, ack = false, unknown = false, expanded = false, spent = false;
  let message = 'Inspect installation inventory, recipes, local catalogs, grants, bindings and retained lifecycle state.', error = '';
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const unavailable = () => busy || options.blocked?.() === true;
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
    const el = doc.createElement(tag);if (text !== undefined) el.textContent = text;return el;
  };
  const canApply = () => !unavailable() && !disposed && (!!pendingApply || !!plan && !spent && !plan.blockers.length && plan.action !== 'none'
    && plan.expires_at > Date.now() && ack && (!plan.unknown_dependencies.length || unknown));
  const focusKey = (): string | null => root.contains(doc.activeElement) ? doc.activeElement?.getAttribute('data-pack-repair-focus') ?? null : null;
  const restoreFocus = (key: string | null) => {
    if (!key) return;
    const target = [...root.querySelectorAll<HTMLElement>('[data-pack-repair-focus]')].find(el => el.getAttribute('data-pack-repair-focus') === key);
    if (target && !target.matches(':disabled')) target.focus();
    else root.querySelector<HTMLElement>('[data-pack-repair-status]')?.focus();
  };
  const button = (label: string, key: string, run: () => void) => {
    const el = node('button', label);el.type = 'button';el.className = 'rx-btn rx-btn-secondary rx-btn-sm';el.disabled = unavailable();
    el.style.cssText = 'max-width:100%;white-space:normal;margin:4px';el.setAttribute('data-pack-repair-focus', key);el.onclick = () => { if (!unavailable()) run(); };return el;
  };
  const list = (parent: HTMLElement, title: string, values: string[]) => {
    if (!values.length) return;
    const details = node('details'), items = node('ul');details.append(node('summary', `${title} (${values.length})`));
    for (const value of values) items.append(node('li', value));details.append(items);parent.append(details);
  };
  const checkbox = (parent: HTMLElement, label: string, key: string, checked: boolean, set: (value: boolean) => void) => {
    const wrapper = node('label'), input = node('input');wrapper.style.cssText = 'display:block;margin:8px 0';input.type = 'checkbox';input.checked = checked;input.disabled = unavailable() || !!pendingApply || spent;
    input.setAttribute('data-pack-repair-focus', key);input.onchange = () => { set(input.checked);const confirm = root.querySelector<HTMLButtonElement>('[data-pack-repair-confirm]');if (confirm) confirm.disabled = !canApply(); };
    wrapper.append(input, doc.createTextNode(' ' + label));parent.append(wrapper);
  };
  const restartReview = () => {
    if (unavailable() || !targetKey) return;
    pendingReview = undefined;pendingApply = undefined;void reviewKey(targetKey);
  };
  const render = () => {
    if (disposed) return;const focus = focusKey();root.replaceChildren();
    const details = node('details');details.open = expanded;details.ontoggle = () => { expanded = details.open; };
    const summary = node('summary', 'Installation health and repair');summary.setAttribute('data-pack-repair-focus', 'summary');details.append(summary);
    const status = node('p', busy ? 'Reading local installation state…' : error || message);status.tabIndex = -1;
    status.setAttribute('data-pack-repair-focus', 'status');
    status.setAttribute('role', error ? 'alert' : 'status');status.setAttribute('data-pack-repair-status', '');details.append(status);
    details.append(node('p', 'Local cleanup revokes saved authority and removes proven leftovers. Reinstalling content or granting access uses the normal installation review. Provider resources and Records data need their existing lifecycle flows.'));
    details.append(button('Inspect local installations', 'inspect', () => { void inspect(); }));
    if (inspection) {
      details.append(node('p', `${inspection.entries.length} local pack identities inspected at ${new Date(inspection.inspected_at).toLocaleTimeString()}. This is a local consistency check; it does not verify provider access.`));
      const entries = node('ul');entries.style.cssText = 'padding-left:20px';
      for (const entry of inspection.entries) {
        const item = node('li');item.style.cssText = 'margin:12px 0';
        item.append(node('strong', `${entry.pack.pack_slug}${entry.pack.publisher ? ' · ' + entry.pack.publisher : ''}`));
        item.append(node('p', `${entry.inventory ? 'Inventory present' : 'Inventory absent'} · ${entry.recipes.length} stored recipes · ${entry.metadata.bindings} bindings · ${entry.metadata.grants + entry.metadata.body_grants} grants.`));
        if (entry.records_state) item.append(node('p', {
          ready: 'Records data is active.', migrating: 'Records data is migrating.', orphaned: 'Records data is retained after removal.', incoherent: 'Records data needs lifecycle inspection.',
        }[entry.records_state]));
        for (const finding of entry.findings) item.append(node('p', finding.message));
        if (!entry.findings.length) item.append(node('p', 'No discrepancy found in the inspected local evidence.'));
        const review = button(entry.next_step === 'review_cleanup' ? 'Review local cleanup' : 'Review local evidence', 'review:' + entry.pack.inventory_key, () => { void reviewKey(entry.pack.inventory_key); });
        review.disabled = unavailable() || !!pendingApply;item.append(review);
        if (entry.next_step === 'install' && options.openPack) {
          const install = button('Open normal installation review', 'install:' + entry.pack.inventory_key, () => options.openPack?.(entry.pack.pack_slug));
          install.disabled = unavailable() || !!pendingApply;item.append(install);
        }
        entries.append(item);
      }
      details.append(entries);list(details, 'Local catalog bodies without ingredient inventory — inspect ownership before removal', inspection.unattributed_manifests);
      if (inspection.recent_repairs.length) {
        details.append(node('h4', 'Retained repair receipts'));
        for (const repair of inspection.recent_repairs) {
          const recover = button(`Recover receipt for ${repair.receipt.pack.pack_slug}`, 'receipt:' + repair.receipt.review_id, () => {
            targetKey = repair.receipt.pack.inventory_key;plan = undefined;pendingReview = undefined;pendingApply = structuredClone(repair.request);void apply();
          });recover.disabled = unavailable() || !!pendingApply;details.append(recover);
        }
      }
      if (inspection.unavailable_receipts) details.append(node('p', `${inspection.unavailable_receipts} retained repair receipts could not be read. Their effects are not retried.`));
    }
    if (pendingReview) details.append(button('Retry loading this repair review', 'retry-review', () => { void reviewKey(pendingReview!.inventory_key); }));
    if (pendingApply && !plan) {
      details.append(button('Recover repair receipt', 'recover', () => { void apply(); }));
      details.append(button('Review current state again', 'fresh', restartReview));
    }
    if (plan) {
      const review = node('section');review.setAttribute('data-pack-repair-review', '');
      review.append(node('h4', `Review repair for ${plan.entry.pack.pack_slug}`));
      review.append(node('p', `Local identity: ${plan.entry.pack.inventory_key}${plan.entry.pack.publisher ? ' · ' + plan.entry.pack.publisher : ''}. Valid until ${new Date(plan.expires_at).toLocaleTimeString()}.`));
      for (const blocker of plan.blockers) { const el = node('p', blocker.message);el.setAttribute('role', 'alert');review.append(el); }
      for (const change of plan.changes) review.append(node('p', change));
      list(review, 'Local catalogs removed', plan.manifests_removed);list(review, 'Ingredient inventory removed', plan.ingredients_removed);
      list(review, 'Shared ingredients retained', plan.ingredients_kept);list(review, 'Connections to reconcile', plan.connections);
      list(review, 'Surviving recipes that become blocked', plan.would_disable);list(review, 'Surviving recipes with reduced runnability', plan.would_degrade);
      list(review, 'Packs with unknown dependency evidence', plan.unknown_dependencies.map(pack => pack.pack_slug));
      if (plan.unknown_dependencies.length) checkbox(review, 'I understand these installations have unknown dependencies.', 'unknown', unknown, value => { unknown = value; });
      if (!pendingApply && !spent && plan.action !== 'none') checkbox(review, 'I inspected the current state and approve this local cleanup. Provider cleanup may still need attention.', 'ack', ack, value => { ack = value; });
      const confirm = button(pendingApply ? 'Recover repair receipt' : 'Confirm reviewed local cleanup', 'confirm', () => { void apply(); });
      confirm.setAttribute('data-pack-repair-confirm', '');confirm.disabled = !canApply();review.append(confirm);
      review.append(button('Review current state again', 'fresh', restartReview));
      details.append(review);
    }
    if (result) {
      details.append(node('p', `Local cleanup completed; receipt ${result.receipt.request_id}. Pack: ${result.receipt.pack.pack_slug}.`));
      details.append(node('p', !result.current ? 'Current state could not be refreshed. Inspect again before taking another action.'
        : result.current.records_state === 'incoherent' ? 'Current Records data needs lifecycle inspection. This receipt describes the earlier cleanup.'
        : result.current.inventory || result.current.recipes.length || result.current.records_state === 'ready' || result.current.records_state === 'migrating'
          ? 'A current installation remains. This receipt describes the earlier cleanup.' : 'Pack inventory and stored recipes are absent. Any retained data keeps its existing lifecycle.'));
      if (result.reconciliation_pending) {
        details.append(node('p', 'Local catalog or connection reconciliation is pending. Recover this receipt to retry reconciliation.'));
        details.append(button('Retry local reconciliation', 'reconcile', () => { void apply(true); }));
      }
    }
    root.append(details);restoreFocus(focus);
  };
  const fail = (cause: unknown) => { error = cause instanceof Error ? cause.message : String(cause); };
  const focusStatusIfLocal = () => {
    if (doc.activeElement === doc.body || root.contains(doc.activeElement)) root.querySelector<HTMLElement>('[data-pack-repair-status]')?.focus();
  };
  const inspect = async () => {
    if (unavailable() || disposed) return;busy = true;expanded = true;error = '';render();
    try { const next = await options.caller.inspect();if (!disposed) { inspection = next;message = 'Review discrepancies and supported cleanup before making changes.'; } }
    catch (cause) { if (!disposed) fail(cause); }
    finally { if (!disposed) { busy = false;render(); } }
  };
  const reviewKey = async (key: string) => {
    if (unavailable() || disposed || pendingApply) return;
    targetKey = key;
    if (pendingReview?.inventory_key !== key) pendingReview = { inventory_key: key, request_id: crypto.randomUUID() };
    if (expiry) clearTimeout(expiry);
    busy = true;expanded = true;ack = false;unknown = false;spent = false;plan = undefined;result = undefined;error = '';render();
    try {
      const next = await options.caller.review(structuredClone(pendingReview));if (disposed) return;
      plan = next;pendingReview = undefined;message = 'Review the exact local changes and any remaining provider cleanup.';
      if (expiry) clearTimeout(expiry);expiry = setTimeout(() => { if (disposed || pendingApply || spent) return;ack = false;message = 'The repair review expired. Review current state again.';render(); }, Math.max(0, next.expires_at - Date.now()) + 1);
    } catch (cause) { if (!disposed) fail(cause); }
    finally { if (!disposed) { busy = false;render();focusStatusIfLocal(); } }
  };
  const apply = async (reconcile = false) => {
    if (unavailable() || disposed || (!reconcile && !canApply())) return;
    pendingApply ??= { review_id: plan!.review_id, request_id: result?.receipt.request_id ?? crypto.randomUUID(), acknowledge_local_cleanup: true,
      ...(unknown ? { acknowledge_unknown_dependencies: true } : {}) };
    busy = true;error = '';render();
    try {
      const next = await options.caller.apply(structuredClone(pendingApply));if (disposed) return;
      result = next;spent = true;ack = false;message = 'The local cleanup receipt is confirmed.';
      if (next.current && inspection) inspection.entries = inspection.entries.map(entry => entry.pack.inventory_key === next.current!.pack.inventory_key ? next.current! : entry);
      // Retain the exact request for safe cache-reconciliation retries.
      if (!next.reconciliation_pending) pendingApply = undefined;
    } catch (cause) { if (!disposed) { fail(cause);error += ' Completion is unconfirmed. Recover the same receipt before starting another repair.'; } }
    finally { if (!disposed) { busy = false;render();focusStatusIfLocal(); } }
  };
  render();
  return { element: root, focusKey, restoreFocus, refresh: render, hasInFlightWork: () => busy, hasPendingRetry: () => !!pendingApply,
    dispose() { disposed = true;if (expiry) clearTimeout(expiry);root.remove(); } };
};
