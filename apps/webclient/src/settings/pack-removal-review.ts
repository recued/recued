import type { PackRemovalPlan,PackRemovalApply,PackRemovalReview,PackRemovalApplyResult,PackRemovalPack } from '@recued/contracts';
import type { PackRemovalCaller } from './pack-removal-caller.js';

/** Stable local review/recovery intent inside the existing Delete strip. */
export const createPackRemovalReview = (options: { document: Document;packSlug: string;
  caller: PackRemovalCaller;changed(): void;confirm(): void }) => {
  const doc = options.document,root = doc.createElement('section');root.setAttribute('data-pack-removal-review','');
  root.style.cssText = 'min-width:0;max-width:100%;overflow-wrap:anywhere;flex-basis:100%';
  let plan: PackRemovalPlan | undefined,pendingReview: PackRemovalReview | undefined,pendingApply: PackRemovalApply | undefined;
  let busy = false,applying = false,disposed = false,spent = false,ack = false,unknown = false,incomplete = false;
  let publisher: string | undefined;
  let error = '',message = 'Loading removal impact…',expiry: ReturnType<typeof setTimeout> | undefined;
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K,text?: string): HTMLElementTagNameMap[K] => {
    const el = doc.createElement(tag);if (text !== undefined) el.textContent = text;return el;
  };
  const canApply = () => !disposed && !busy && !applying && (!!pendingApply || !!plan && !spent && !plan.blockers.length
    && plan.expires_at > Date.now() && ack && (!plan.unknown_dependencies.length || unknown) && (!plan.prior_attempt_unconfirmed || incomplete));
  const refreshConfirm = () => { const button = root.querySelector<HTMLButtonElement>('[data-recued-packs-row-delete-confirm]');if (button) button.disabled = !applying && !canApply(); };
  const action = (text: string,run: () => void) => {
    const button = node('button',text);button.type = 'button';button.className = 'rx-btn rx-btn-secondary rx-btn-sm';button.disabled = busy || applying;
    button.style.cssText = 'max-width:100%;white-space:normal';button.onclick = run;return button;
  };
  const check = (text: string,key: string,checked: boolean,set: (value: boolean) => void) => {
    const label = node('label');label.style.cssText = 'display:block;max-width:100%';const input = node('input');input.type = 'checkbox';input.checked = checked;
    input.setAttribute(key,'');input.disabled = busy || applying;input.onchange = () => { set(input.checked);refreshConfirm(); };
    label.append(input,doc.createTextNode(' '+text));root.append(label);
  };
  const list = (title: string,values: string[]) => {
    if (!values.length) return;const details = node('details'),items = node('ul');details.append(node('summary',`${title} (${values.length})`));
    for (const value of values) items.append(node('li',value));details.append(items);root.append(details);
  };
  const packName = (pack: PackRemovalPack) => `${pack.pack_slug}${pack.publisher ? ' · '+pack.publisher : ''}${pack.version !== undefined ? ' · v'+pack.version : ''}`;
  const render = () => {
    if (disposed) return;root.replaceChildren(node('h4','Review pack removal'));
    const status = node('p',error || (applying ? 'Removing the reviewed pack…' : busy ? 'Loading removal impact…' : message));
    status.setAttribute('data-pack-removal-status','');status.setAttribute('role',error ? 'alert' : 'status');status.tabIndex = -1;root.append(status);
    root.append(action(pendingReview ? 'Retry loading removal review' : 'Review current installation',() => { void reload(); }));
    if (plan) {
      root.append(node('p',`Remove ${packName(plan.pack)}. Review valid until ${new Date(plan.expires_at).toLocaleTimeString()}.`));
      if (plan.publisher_choices.length > 1) {
        const label = node('label','Installed publisher '),select = node('select');select.style.cssText = 'min-width:0;max-width:100%';select.setAttribute('data-pack-removal-publisher','');select.disabled = busy || applying;
        const choose = node('option','Choose publisher');choose.value = '';select.append(choose);
        for (const value of plan.publisher_choices) { const option = node('option',value);option.value = value;select.append(option); }
        select.value = publisher ?? '';select.onchange = () => { publisher = select.value || undefined;pendingReview = undefined;void reload(); };label.append(select);root.append(label);
      }
      for (const blocker of plan.blockers) { const el = node('p',blocker.message);el.setAttribute('role','alert');root.append(el); }
      list('Dependent packs — remove these first',plan.dependants.map(pack => `${packName(pack)}${pack.direct ? ' · direct dependency' : ' · via '+pack.via.join(' → ')}`));
      list('Recipes whose stored installation will be removed',plan.recipes);
      list('Bundled recipes that remain available',plan.bundled_recipes_kept);
      root.append(node('p',`Also removes ${plan.owned.schedules} schedules, ${plan.owned.automations} automations and saved settings for ${plan.owned.recipes_with_settings} recipes.`));
      list('Dependency packs that stay installed',plan.dependencies_kept.map(packName));
      list('Shared ingredients that stay installed',plan.ingredients.shared);
      list('Ingredients removed with this pack',plan.ingredients.removed);
      list('Surviving recipes that become blocked',plan.runtime.would_disable);list('Surviving recipes with reduced runnability',plan.runtime.would_degrade);
      if (plan.protection.roots.length) root.append(node('p',`Removal invalidates these protected update reviews: ${plan.protection.roots.join(', ')}.`));
      if (plan.protection.release_history) root.append(node('p','This pack’s retained release history will be removed.'));
      if (plan.records) root.append(node('p',`Records data for ${plan.records.publisher}/${plan.records.pack_slug} will be retained.`));
      list('Installed packs with unknown dependency metadata',plan.unknown_dependencies.map(packName));
      if (plan.unknown_dependencies.length) check('I understand the dependencies of these installs are unknown.','data-pack-removal-unknown',unknown,value => { unknown = value; });
      if (plan.prior_attempt_unconfirmed) {
        root.append(node('p','An earlier removal attempt has no confirmed completion. Inspect the current installation before starting this fresh removal.'));
        check('I inspected the current installation after the unconfirmed attempt.','data-pack-removal-incomplete',incomplete,value => { incomplete = value; });
      }
      check('I reviewed this pack’s removal impact.','data-pack-removal-ack',ack,value => { ack = value; });
    }
    const confirm = action(pendingApply ? 'Recover removal receipt' : 'Confirm reviewed removal',options.confirm);confirm.className = 'rx-btn rx-btn-danger rx-btn-sm';
    confirm.setAttribute('data-recued-packs-row-delete-confirm',options.packSlug);
    if (applying) { confirm.setAttribute('aria-disabled','true');confirm.setAttribute('aria-busy','true');confirm.disabled = false; }
    else confirm.disabled = !canApply();root.append(confirm);
  };
  const reload = async () => {
    if (busy || applying || disposed) return;busy = true;error = '';ack = false;unknown = false;incomplete = false;spent = false;pendingApply = undefined;
    pendingReview ??= { pack_slug: options.packSlug,...(publisher ? { publisher } : {}),request_id: crypto.randomUUID() };
    render();options.changed();
    try {
      const next = await options.caller.review(structuredClone(pendingReview));if (disposed) return;
      plan = next;pendingReview = undefined;message = 'Review the affected packs, recipes and retained shared resources before confirming.';
      if (expiry) clearTimeout(expiry);expiry = setTimeout(() => { if (disposed) return;ack = false;message = 'The removal review expired. Review the current installation again.';render();options.changed(); },Math.max(0,next.expires_at - Date.now()) + 1);
    } catch (cause) { if (!disposed) { plan = undefined;error = cause instanceof Error ? cause.message : String(cause); } }
    finally { if (!disposed) { busy = false;render();options.changed();
      if (root.isConnected && (doc.activeElement === doc.body || doc.activeElement === doc.documentElement)) root.querySelector<HTMLElement>('[data-pack-removal-status]')?.focus();
    } }
  };
  render();queueMicrotask(() => { if (!disposed) void reload(); });
  return { element: root,canApply,hasPendingRetry: () => !!pendingApply,hasInFlightWork: () => busy || applying,
    async apply(): Promise<PackRemovalApplyResult | undefined> {
      if (!canApply()) return;pendingApply ??= { review_id: plan!.review_id,request_id: crypto.randomUUID(),
        ...(unknown ? { acknowledge_unknown_dependencies: true } : {}),...(incomplete ? { acknowledge_incomplete_attempt: true } : {}) };
      applying = true;error = '';render();options.changed();
      try {
        const result = await options.caller.apply(structuredClone(pendingApply));if (disposed) return;
        pendingApply = undefined;spent = true;ack = false;message = result.receipt.result.ok ? result.installed_now
          ? `Removal receipt ${result.receipt.request_id}. A current installation remains; review it before removing.` : `Removal completed; receipt ${result.receipt.request_id}.`
          : 'Removal returned a failure. Review the remaining installation before making another removal request.';
        return result;
      } catch (cause) { if (!disposed) error = cause instanceof Error ? cause.message : String(cause);throw cause; }
      finally { if (!disposed) { applying = false;render();options.changed(); } }
    },
    hide() { ack = false;unknown = false;incomplete = false;render(); },
    dispose() { disposed = true;if (expiry) clearTimeout(expiry);root.remove(); },
  };
};
