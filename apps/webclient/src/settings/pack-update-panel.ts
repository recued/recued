import { createRecipeRegressionPanel } from '../kitchen/recipe-editor/recipe-regression-panel.js';
import type { RecipeRegressionCaller } from '../kitchen/recipe-editor/recipe-regression-caller.js';
import type { PackUpdateView, PackUpdateStage, PackUpdateTestResult, PackUpdateApply, PackUpdateRelease, PackRestoreStage } from '@recued/contracts';
import type { PackUpdateCaller } from './pack-update-caller.js';

/** Stable DOM subtree inside the existing update dialog. Protection persists
 * server-side; closing the dialog drops only the local test/acknowledgement. */
export const createPackUpdatePanel = (options: { document: Document; packSlug: string;
  manifestHash: string; source: 'bundled' | 'marketplace'; managed: boolean;
  caller: PackUpdateCaller; regressionCaller?: RecipeRegressionCaller; changed(): void;
  applying?(value: boolean): void; refresh?(): void; historyOnly?: boolean }) => {
  const doc = options.document, root = doc.createElement('section');
  root.setAttribute('data-pack-update-tests',''); root.style.cssText = 'min-width:0;max-width:100%;overflow-wrap:anywhere';
  let current: PackUpdateView | undefined, busy = true, installing = false, disposed = false, acknowledged = false;
  let error = '', message = 'Loading saved update protection…', blockedRead = true;
  let pendingStage: PackUpdateStage | undefined, comparisons: PackUpdateTestResult['comparisons'] | undefined;
  let pendingApply: PackUpdateApply | undefined;
  let pendingRelease: PackUpdateRelease | undefined;
  let pendingRestore: PackRestoreStage | undefined, pendingWasRestore = false;
  let controller: AbortController | undefined, expiry: ReturnType<typeof setTimeout> | undefined;
  const suiteSections = new Map<string,HTMLDetailsElement>();
  const suiteRevisions = new Map<string,number>();
  const suitePanels = new Map<string,ReturnType<typeof createRecipeRegressionPanel>>();
  const inCandidate = (id: string): boolean => !!current?.candidate?.recipes.some(recipe => recipe.recipe_id === id);
  const editingSuites = (): boolean => [...suitePanels].some(([id,panel]) => inCandidate(id) && (panel.hasUnsavedChanges() || panel.hasInFlightWork()));
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
    const element = doc.createElement(tag); if (text !== undefined) element.textContent = text; return element;
  };
  const matching = (): boolean => !!current?.candidate && !current.applied && (!!current.candidate.restore
    || !options.historyOnly && current.candidate.manifest_hash === options.manifestHash && current.candidate.source === options.source);
  const qualified = (): boolean => matching() && !editingSuites() && !!current?.qualification && current.qualification.expires_at > Date.now();
  const grouped = (): boolean => (current?.candidate?.packs?.length ?? 0) > 1;
  const canApply = (): boolean => !busy && !installing && !blockedRead && !pendingRelease && !pendingRestore && !editingSuites()
    && (!!pendingApply || grouped() && qualified() && acknowledged);
  const refreshApply = (): void => {
    const button = root.querySelector<HTMLButtonElement>('[data-pack-update-apply]'); if (button) button.disabled = !canApply();
  };
  const blocked = (): boolean => grouped() || !!pendingApply || busy || blockedRead || !!pendingStage || !!pendingRestore || editingSuites() || (current?.managed ?? options.managed) && (!qualified() || !acknowledged);
  const armExpiry = (): void => {
    if (expiry) clearTimeout(expiry);
    if (current?.qualification) expiry = setTimeout(() => {
      if (disposed) return; acknowledged = false; if (current) current.qualification = null;
      message = 'The passing result expired. Run the saved tests again before updating.'; render(); options.changed();
    },Math.max(0,current.qualification.expires_at - Date.now()) + 1);
  };
  const accept = (value: PackUpdateView): void => {
    const prior = current?.candidate?.digest; current = value;
    for (const [id,panel] of suitePanels) {
      if (!inCandidate(id) && !panel.hasUnsavedChanges() && !panel.hasInFlightWork()) {
        panel.dispose(); suitePanels.delete(id); suiteSections.delete(id); suiteRevisions.delete(id);
      } else if (value.candidate?.digest !== prior) panel.recipeChanged();
    }
    blockedRead = false; acknowledged = false; armExpiry();
  };
  const button = (text: string, action: () => void, disabled = false): HTMLButtonElement => {
    const element = node('button',text); element.type = 'button'; element.className = 'rx-btn rx-btn-secondary rx-btn-sm';
    element.style.cssText = 'max-width:100%;white-space:normal'; element.disabled = busy || installing || disabled; element.onclick = action; return element;
  };
  const json = (parent: HTMLElement, value: unknown): void => {
    const pre = node('pre',JSON.stringify(value,null,2)); pre.tabIndex = 0;
    pre.style.cssText = 'min-width:0;max-width:100%;max-height:24rem;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere'; parent.append(pre);
  };
  const render = (): void => {
    if (disposed) return; root.replaceChildren(node('h3',options.historyOnly ? 'Pack release history' : 'Saved-test update protection'));
    const status = node('p',error || (busy ? controller ? 'Testing staged pack recipes…' : 'Loading or staging the update…' : message));
    status.setAttribute('data-pack-update-status',''); status.setAttribute('role',error ? 'alert' : 'status'); status.tabIndex = -1; root.append(status);
    root.append(node('p',options.historyOnly
      ? 'Retained releases contain the exact manifests, recipes and pack versions applied together here. Stage a release, run fresh saved tests, then review and apply its restore. These tests use pretend service results.'
      : 'Stage the update to protect this pack. Later updates must pass every recipe’s latest saved tests. The installed pack keeps running while you test. These tests use pretend service results.'));
    const actions = node('div'); actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px'; root.append(actions);
    actions.append(button('Reload update protection',() => { void reload(); }));
    if (!options.historyOnly) actions.append(button(pendingStage ? 'Retry staging update' : current?.managed ? 'Restage current update' : 'Stage update and protect pack',() => { void stage(); },!!pendingApply || !!pendingRelease || !!pendingRestore));
    if (pendingRestore) actions.append(button('Retry staging release',() => { void restore(pendingRestore!.release_id); },!!pendingApply || !!pendingRelease));
    const runTests = button(current?.candidate?.restore ? 'Test staged restore' : 'Test staged update',() => { void test(); },!matching() || editingSuites() || !!pendingApply || !!pendingRelease || !!pendingRestore); runTests.setAttribute('data-pack-update-test',''); actions.append(runTests);
    if (grouped() && !current?.applied || pendingRelease) actions.append(button(pendingRelease ? 'Retry releasing plan' : 'Release staged dependency plan',() => { void release(); }));
    if (controller) { const cancel = button('Cancel update tests',() => controller?.abort()); cancel.disabled = installing; actions.append(cancel); }
    if (current?.releases?.length) {
      const releases = node('section'); releases.setAttribute('data-pack-release-list',''); releases.append(node('h4','Retained releases'));
      for (const release of current.releases) {
        const entry = node('div'); entry.setAttribute('data-pack-release',release.release_id);
        entry.append(node('p',`Release ${release.sequence} · ${new Date(release.created_at).toLocaleString()}${release.current ? ' · Currently installed' : ''}`));
        const packs = node('ul'); for (const pack of release.packs) packs.append(node('li',`${pack.name}: version ${pack.version}`)); entry.append(packs);
        entry.append(button(`Stage release ${release.sequence}`,() => { void restore(release.release_id); },release.current || !!pendingApply || !!pendingRelease || !!pendingStage || !!pendingRestore));
        releases.append(entry);
      }
      releases.append(node('p','Restores require the same recipe membership and surrounding pack inventory. Current Access, audiences and connections stay in place. Earlier provider calls are not reversed.'));
      root.append(releases);
    } else if (options.historyOnly && !busy) root.append(node('p','History begins with reviewed dependency updates successfully applied here. No release snapshots are retained yet.'));
    if (current?.applied) {
      root.append(node('p','The staged version is already installed. Refresh Packs to see the current version.'));
      if (grouped() && options.refresh) root.append(button('Refresh pack list',() => options.refresh!(),
        [...suitePanels.values()].some(panel => panel.hasUnsavedChanges() || panel.hasInFlightWork())));
    }
    else if (current?.candidate && !matching()) root.append(node('p',options.historyOnly
      ? 'A forward update is staged. Use the Update dialog to continue it, or stage a retained release here.'
      : 'A different update is staged. Restage the version shown in this dialog before continuing.'));
    if (current?.candidate) {
      if (current.candidate.restore) root.append(node('p',`Restoring retained release ${current.candidate.restore.sequence}. Review every pack and recipe below. Its previous test result does not qualify this restore.`));
      root.append(node('p',`Installed version ${current.installed_version ?? 'unavailable'} → staged version ${current.candidate.version}.`));
      if (grouped()) {
        root.append(node('p','This dependency update commits every listed pack together. Existing Access, audiences and connection choices stay in place. Use Apply reviewed dependency update here; the separate Update action does not apply this group.'));
        const list = node('ol'); list.setAttribute('data-pack-update-plan','');
        for (const pack of current.candidate.packs!) list.append(node('li',`${pack.name}: version ${pack.installed_version} → ${pack.version}${pack.dependencies.length ? `. Requires ${pack.dependencies.join(', ')}.` : '.'}`));
        root.append(list);
      }
      for (const recipe of current.candidate.recipes) {
        const details = node('details'); details.append(node('summary',`Recipe changes: ${recipe.recipe_id}`));
        details.append(node('h4','Before')); json(details,recipe.before); details.append(node('h4','After')); json(details,recipe.after); root.append(details);
        if (options.regressionCaller && !suitePanels.has(recipe.recipe_id)) {
          suitePanels.set(recipe.recipe_id,createRecipeRegressionPanel({ document: doc,recipeId: recipe.recipe_id,caller: options.regressionCaller,
            getRecipe: () => current?.candidate?.recipes.find(entry => entry.recipe_id === recipe.recipe_id)?.after ?? recipe.after,changed: () => {
              const panel = suitePanels.get(recipe.recipe_id), head = panel?.savedRevision();
              const priorHead = suiteRevisions.get(recipe.recipe_id) ?? current?.qualification?.suites.find(suite => suite.recipe_id === recipe.recipe_id)?.revision;
              if (head !== undefined) suiteRevisions.set(recipe.recipe_id,head);
              if (inCandidate(recipe.recipe_id) && (panel?.hasUnsavedChanges() || head !== undefined && priorHead !== undefined && head !== priorHead)) {
                acknowledged = false; if (current) current.qualification = null;
                message = 'Saved test cases changed. Finish and save edits, then test the staged update again.';
                root.querySelector('[data-pack-update-ack-label]')?.remove(); root.querySelector('[data-pack-update-qualified]')?.remove();
                const status = root.querySelector('[data-pack-update-status]'); if (status) status.textContent = message;
              }
              const test = root.querySelector<HTMLButtonElement>('[data-pack-update-test]');
              if (test) test.disabled = busy || installing || !matching() || editingSuites();
              const focused = doc.activeElement as HTMLElement | null;
              refreshApply(); options.changed(); if (focused?.isConnected && root.contains(focused)) focused.focus();
            } }));
        }

      }
    }
    for (const [id,panel] of suitePanels) {
      let details = suiteSections.get(id);
      if (!details) { details = node('details'); details.setAttribute('data-pack-update-suite',id); details.append(node('summary',`Saved tests: ${id}`),panel.element); suiteSections.set(id,details); }
      details.querySelector('summary')!.textContent = `Saved tests: ${id}${inCandidate(id) ? '' : ' (outside staged update)'}`;
      root.append(details);
      panel.element.inert = installing;
      if (!inCandidate(id)) root.append(node('p','These test edits belong to a recipe outside this staged update. Saving them does not include that recipe in the update.'));
    }
    if (comparisons) {
      const results = node('div'); results.setAttribute('data-pack-update-results','');
      for (const result of comparisons) {
        const details = node('details'); details.append(node('summary',`${result.recipe_id}: ${result.passed} passed, ${result.failed} failed`));
        for (const test of result.cases) if (!test.candidate.passed) { details.append(node('h4',test.name));
          for (const assertion of test.candidate.assertions) if (!assertion.passed) { details.append(node('p',assertion.message)); json(details,assertion); }
        }
        results.append(details);
      }
      root.append(results);
    }
    if (qualified()) {
      const qualifiedStatus = node('p',`${current!.qualification!.passed} saved cases passed. Valid until ${new Date(current!.qualification!.expires_at).toLocaleTimeString()}.`); qualifiedStatus.setAttribute('data-pack-update-qualified',''); root.append(qualifiedStatus);
      const label = node('label'), checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = acknowledged; checkbox.disabled = busy || installing;
      checkbox.setAttribute('data-pack-update-ack',''); checkbox.onchange = () => { acknowledged = checkbox.checked; refreshApply(); options.changed(); };
      label.setAttribute('data-pack-update-ack-label',''); label.append(checkbox,doc.createTextNode(grouped()
        ? current?.candidate?.restore ? ' I reviewed every pack and tested recipe in this restore.' : ' I reviewed every pack and tested recipe in this dependency update.' : ' I reviewed the tested recipe changes. Use this passing result for Update.')); root.append(label);
    }
    if (grouped() && !current?.applied || pendingApply) {
      const applyButton = button(pendingApply ? pendingWasRestore ? 'Recover restore' : 'Recover dependency update'
        : current?.candidate?.restore ? 'Apply reviewed restore' : 'Apply reviewed dependency update',() => { void apply(); },!canApply());
      applyButton.setAttribute('data-pack-update-apply',''); root.append(applyButton);
      if (pendingApply && !grouped()) {
        root.append(node('p','The staged dependency plan changed. Recover the previous request’s receipt, or clear its local retry before staging another update.'));
        root.append(button('Clear pending retry',() => {
          void perform(async () => {
            pendingApply = undefined; message = 'Pending retry cleared. Review the current update protection before staging again.';
          });
        }));
      }
    }
    if (current?.last_apply) root.append(node('p',`Completed dependency update receipt ${current.last_apply.request_id}. ${current.last_apply.packs.length} packs committed together.`));
  };
  const perform = async (operation: () => Promise<void>): Promise<void> => {
    if (busy || installing || disposed) return; busy = true; error = ''; acknowledged = false; render(); options.changed();
    try { await operation(); } catch (cause) { if (!disposed) { error = cause instanceof Error ? cause.message : String(cause); if (current) current.qualification = null; } }
    finally { if (!disposed) { busy = false; render(); options.changed(); root.querySelector<HTMLElement>('[data-pack-update-status]')?.focus(); } }
  };
  const reload = async (): Promise<void> => perform(async () => {
    const value = await options.caller.get({ pack_slug: options.packSlug }); if (disposed) return;
    accept(value); pendingStage = undefined; pendingRestore = undefined; pendingRelease = undefined; comparisons = undefined;
    if (pendingApply?.request_id === value.last_apply?.request_id) pendingApply = undefined;
    message = options.historyOnly ? 'Loaded retained release history. Choose a release to stage and test.'
      : value.managed ? 'Loaded staged update protection. Review the saved candidate and test it before updating.' : 'Update protection has not been started for this pack.';
  });
  const stage = async (): Promise<void> => perform(async () => {
    if (pendingApply || pendingRelease || pendingRestore) throw new Error('Recover the pending dependency operation before restaging.');
    if (!current) throw new Error('Reload update protection before staging.');
    pendingStage ??= { pack_slug: options.packSlug,source: options.source,expected_revision: current.revision,expected_manifest_hash: options.manifestHash,request_id: crypto.randomUUID(),include_dependencies: true };
    const value = await options.caller.stage(structuredClone(pendingStage)); if (disposed) return;
    pendingStage = undefined; accept(value); comparisons = undefined; message = 'Update staged. The installed pack has not changed. Run the saved tests for every candidate recipe.';
  });
  const restore = async (release_id: string): Promise<void> => perform(async () => {
    if (!current || pendingApply || pendingRelease || pendingStage) throw new Error('Reload or recover the pending update before staging a release.');
    pendingRestore ??= { pack_slug: options.packSlug,release_id,expected_revision: current.revision,request_id: crypto.randomUUID() };
    const value = await options.caller.restore(structuredClone(pendingRestore)); if (disposed) return;
    pendingRestore = undefined; accept(value); comparisons = undefined;
    message = 'Retained release staged. Installed recipes are unchanged. Run fresh saved tests for every recipe before restoring.';
  });
  const test = async (): Promise<void> => {
    if (!matching() || busy || installing || disposed || editingSuites() || pendingApply || pendingRelease || pendingRestore) return;
    controller = new AbortController(); const signal = controller.signal; if (current) current.qualification = null;
    await perform(async () => { try {
      const value = await options.caller.test({ pack_slug: options.packSlug,expected_revision: current!.revision },signal); signal.throwIfAborted();
      if (disposed) return; accept(value); comparisons = value.comparisons;
      message = value.qualification ? value.candidate?.restore ? 'The staged restore passed. Review every pack and recipe, then acknowledge and apply the restore.'
        : 'The staged update passed. Review its recipe changes, then confirm Update below.' : 'The staged update did not pass. The installed pack has not changed.';
    } catch (cause) { if (signal.aborted) throw new Error('Update tests cancelled. No passing result was kept.'); throw cause; }
    finally { controller = undefined; } });
  };
  const apply = async (): Promise<void> => {
    if (!canApply()) return;
    await perform(async () => {
      if (!pendingApply) pendingWasRestore = !!current?.candidate?.restore;
      pendingApply ??= { pack_slug: options.packSlug,expected_revision: current!.revision,
        review_id: current!.qualification!.review_id,request_id: crypto.randomUUID() };
      options.applying?.(true);
      try {
        const value = await options.caller.apply(structuredClone(pendingApply)); if (disposed) return;
        pendingApply = undefined; accept(value);
        message = `${value.applied ? value.receipt.restored_release_id ? 'Restore completed.' : 'Dependency update completed.' : 'Recovered a completed update; a newer pack state is present.'} ${value.receipt.packs.length} packs committed together; receipt ${value.receipt.request_id}.`;
      } finally { options.applying?.(false); }
    });
  };
  const release = async (): Promise<void> => perform(async () => {
    if (!current || !grouped() && !pendingRelease) return;
    pendingRelease ??= { pack_slug: options.packSlug,expected_revision: current.revision,request_id: crypto.randomUUID() };
    const value = await options.caller.release(structuredClone(pendingRelease)); if (disposed) return;
    pendingRelease = undefined; pendingApply = undefined; pendingRestore = undefined; accept(value); comparisons = undefined;
    message = 'Dependency plan released. Installed versions were not changed by release; saved tests and this pack’s update protection remain.';
  });
  render();
  queueMicrotask(() => { if (!disposed) { busy = false; void reload(); } });
  return { element: root,blocked,hasInFlightWork: () => busy || installing || [...suitePanels.values()].some(panel => panel.hasInFlightWork()),
    hasUnsavedChanges: () => [...suitePanels.values()].some(panel => panel.hasUnsavedChanges()),reviewId: (): string | undefined => !blocked() ? current?.qualification?.review_id : undefined,
    configure(context: { manifestHash: string; source: 'bundled' | 'marketplace'; historyOnly: boolean }) {
      if (context.manifestHash === options.manifestHash && context.source === options.source && context.historyOnly === !!options.historyOnly) return;
      Object.assign(options,context); acknowledged = false; comparisons = undefined; render();
    },
    hide() { controller?.abort(); acknowledged = false; const ack = root.querySelector<HTMLInputElement>('[data-pack-update-ack]'); if (ack) ack.checked = false; },
    setInstalling(value: boolean) { if (installing !== value) { installing = value; render(); } },
    invalidate() { acknowledged = false; if (current) current.qualification = null; render(); options.changed(); },
    dispose() { disposed = true; controller?.abort(); for (const panel of suitePanels.values()) panel.dispose(); if (expiry) clearTimeout(expiry); root.remove(); } };
};
