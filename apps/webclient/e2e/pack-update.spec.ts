import { expect,test,type Page } from '@playwright/test';
const open = async (page: Page,scenario = 'passing') => {
  await page.goto('/pack-update-harness.html?scenario=' + scenario);
  await page.locator('[data-recued-packs-row-install="reviewed-fixture"]').click();
  const panel = page.locator('[data-pack-update-tests]'); await expect(panel.getByRole('button',{ name: 'Stage update and protect pack',exact: true })).toBeEnabled(); return panel;
};
const stage = async (page: Page) => {
  const panel = page.locator('[data-pack-update-tests]'); await panel.getByRole('button',{ name: 'Stage update and protect pack',exact: true }).click();
  await expect(panel.locator('[data-pack-update-status]')).toContainText('Update staged.'); return panel;
};
const update = (page: Page) => page.locator('[data-recued-packs-dialog-install]');
for (const width of [280,1280]) {
  test(`reloading a smaller candidate preserves removed recipe drafts without holding its tests at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 }); await open(page); const panel = await stage(page);
    await panel.getByText('Saved tests: second',{ exact: true }).click();
    const tests = panel.locator('[data-pack-update-suite="second"] [data-recipe-regression]'); await tests.locator('summary').first().click();
    const name = tests.getByRole('textbox',{ name: 'Case name',exact: true }); await name.fill('Keep removed recipe edits');
    await page.evaluate(() => {
      const key = 'recued-pack-update-fixture', state = JSON.parse(sessionStorage.getItem(key)!);
      state.view.candidate.recipes = state.view.candidate.recipes.filter((recipe: { recipe_id: string }) => recipe.recipe_id === 'first');
      state.view.candidate.digest = 'smaller-candidate'; state.view.revision++; state.view.qualification = null;
      sessionStorage.setItem(key,JSON.stringify(state));
    });
    await panel.getByRole('button',{ name: 'Reload update protection',exact: true }).click();
    await expect(name).toHaveValue('Keep removed recipe edits');
    await expect(panel.getByText('Saved tests: second (outside staged update)',{ exact: true })).toBeVisible();
    await expect(panel.getByRole('button',{ name: 'Test staged update',exact: true })).toBeEnabled();
    await panel.getByRole('button',{ name: 'Test staged update',exact: true }).click();
    await expect(panel.locator('[data-pack-update-results]')).toContainText('first: 1 passed');
    await expect(name).toHaveValue('Keep removed recipe edits');
  });

  test(`reloading a smaller staged update removes its obsolete clean test editors at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 }); await open(page); const panel = await stage(page);
    await expect(panel.getByText('Saved tests: second',{ exact: true })).toBeVisible();
    await page.evaluate(() => {
      const key = 'recued-pack-update-fixture', state = JSON.parse(sessionStorage.getItem(key)!);
      state.view.candidate.recipes = state.view.candidate.recipes.filter((recipe: { recipe_id: string }) => recipe.recipe_id === 'first');
      state.view.candidate.digest = 'smaller-candidate'; state.view.revision++; state.view.qualification = null;
      sessionStorage.setItem(key,JSON.stringify(state));
    });
    await panel.getByRole('button',{ name: 'Reload update protection',exact: true }).click();
    await expect(panel.getByText('Saved tests: second',{ exact: true })).toHaveCount(0);
    await expect(panel.getByText('Saved tests: first',{ exact: true })).toBeVisible();
  });

  test(`protected update tests exact saved recipes and requires explicit review at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 }); await open(page); const panel = await stage(page);
    await expect(update(page)).toBeDisabled();
    await panel.getByRole('button',{ name: 'Test staged update',exact: true }).click();
    await expect(panel.locator('[data-pack-update-results]')).toContainText('second: 1 passed, 0 failed');
    await expect(update(page)).toBeDisabled();
    await panel.getByText('Recipe changes: first',{ exact: true }).click(); await expect(panel.getByRole('heading',{ name: 'Before',exact: true }).first()).toBeVisible();
    await panel.locator('[data-pack-update-ack]').check(); await expect(update(page)).toBeEnabled();
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-pack-update-fixture')!).view.installed_version)).toBe(1);
    await update(page).click(); await expect(page.locator('[data-recued-packs-dialog]')).toHaveCount(0);
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-pack-update-fixture')!).install_calls)).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
  test(`reopening retains protection but requires a fresh acknowledgement at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 }); await open(page); let panel = await stage(page);
    await panel.getByRole('button',{ name: 'Test staged update',exact: true }).click(); await panel.locator('[data-pack-update-ack]').check();
    await page.reload(); await page.locator('[data-recued-packs-row-install="reviewed-fixture"]').click(); panel = page.locator('[data-pack-update-tests]');
    await expect(panel.locator('[data-pack-update-ack]')).not.toBeChecked(); await expect(update(page)).toBeDisabled();
    await panel.locator('[data-pack-update-ack]').check(); await expect(update(page)).toBeEnabled();
  });
  for (const scenario of ['failed','missing','slow']) test(`${scenario} saved tests hold the installed pack at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 }); await open(page,scenario); const panel = await stage(page);
    await panel.getByRole('button',{ name: 'Test staged update',exact: true }).click();
    if (scenario === 'slow') { await panel.getByRole('button',{ name: 'Cancel update tests',exact: true }).click(); await expect(panel.getByRole('alert')).toContainText('cancelled'); }
    else if (scenario === 'missing') await expect(panel.getByRole('alert')).toContainText('Save recipe tests for second');
    else await expect(panel.locator('[data-pack-update-results]')).toContainText('second: 0 passed, 1 failed');
    await expect(update(page)).toBeDisabled(); expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-pack-update-fixture')!).view.installed_version)).toBe(1);
  });
  test(`staged recipes can author missing suites without installation at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 }); await open(page,'authoring'); const panel = await stage(page);
    await panel.getByRole('button',{ name: 'Test staged update',exact: true }).click(); await expect(panel.getByRole('alert')).toContainText('Save recipe tests for second');
    await panel.getByText('Saved tests: second',{ exact: true }).click();
    const tests = panel.locator('[data-recipe-regression]').nth(1); await tests.locator('summary').first().click();
    const name = tests.getByRole('textbox',{ name: 'Case name',exact: true }); await name.fill('New recipe case');
    await expect(name).toBeFocused(); await expect(panel.getByRole('button',{ name: 'Test staged update',exact: true })).toBeDisabled();
    await page.locator('[data-recued-packs-dialog-cancel]').click(); await page.locator('[data-recued-packs-row-install="reviewed-fixture"]').click();
    await expect(name).toHaveValue('New recipe case');
    await tests.getByRole('button',{ name: 'Save test version',exact: true }).click(); await expect(tests.locator('[data-regression-status]')).toContainText('Saved test version 1');
    await panel.getByRole('button',{ name: 'Test staged update',exact: true }).click(); await panel.locator('[data-pack-update-ack]').check();
    await expect(update(page)).toBeEnabled(); expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-pack-update-fixture')!).view.installed_version)).toBe(1);
  });
  test(`closing a running update test keeps unfinished suite edits and cancels the test at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 }); await open(page,'slow'); const panel = await stage(page);
    await panel.getByRole('button',{ name: 'Test staged update',exact: true }).click();
    await panel.getByText('Saved tests: first',{ exact: true }).click(); const tests = panel.locator('[data-recipe-regression]').first(); await tests.locator('summary').first().click();
    const name = tests.getByRole('textbox',{ name: 'Case name',exact: true });
    await expect(name).toBeDisabled(); await expect(tests.getByRole('combobox',{ name: 'Expected recipe status',exact: true })).toBeDisabled();
    await name.fill('Keep my unfinished test');
    await page.locator('[data-recued-packs-dialog-cancel]').click(); await page.locator('[data-recued-packs-row-install="reviewed-fixture"]').click();
    await expect(name).toHaveValue('Keep my unfinished test'); await expect(panel.getByRole('alert')).toContainText('cancelled'); await expect(update(page)).toBeDisabled();
  });
  test(`lost update replies recover the installed version without another apply at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 }); await open(page,'lost-apply'); const panel = await stage(page);
    await panel.getByRole('button',{ name: 'Test staged update',exact: true }).click(); await panel.locator('[data-pack-update-ack]').check();
    await update(page).click(); await expect(page.locator('[data-recued-packs-dialog-error]')).toContainText('Update reply lost');
    await panel.getByRole('button',{ name: 'Reload update protection',exact: true }).click(); await expect(panel).toContainText('already installed');
    await expect(update(page)).toBeDisabled(); expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-pack-update-fixture')!).install_calls)).toBe(1);
  });
  test(`stage retry keeps its identity and a changed suite cannot update at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 }); let panel = await open(page,'lost-stage');
    await panel.getByRole('button',{ name: 'Stage update and protect pack',exact: true }).click(); await expect(panel.getByRole('alert')).toContainText('Stage reply lost');
    await panel.getByRole('button',{ name: 'Retry staging update',exact: true }).click(); await expect(panel.locator('[data-pack-update-status]')).toContainText('Update staged.');
    await panel.getByRole('button',{ name: 'Test staged update',exact: true }).click(); await panel.locator('[data-pack-update-ack]').check();
    await page.evaluate(() => { const key = 'recued-pack-update-fixture', state = JSON.parse(sessionStorage.getItem(key)!); state.suite_revision++; sessionStorage.setItem(key,JSON.stringify(state)); });
    await update(page).click(); await expect(page.locator('[data-recued-packs-dialog-error]')).toContainText('Saved tests changed');
    await expect(update(page)).toBeDisabled(); expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-pack-update-fixture')!).install_calls)).toBe(0);
  });
}

for (const width of [280,1280]) {
  const history = async (page: Page,scenario = 'restore') => {
    await page.setViewportSize({ width,height: 900 }); await page.goto('/pack-update-harness.html?scenario=' + scenario);
    await page.getByRole('button',{ name: 'Release history',exact: true }).click();
    const panel = page.locator('[data-pack-update-tests]'); await expect(panel.getByRole('button',{ name: 'Stage release 1',exact: true })).toBeEnabled(); return panel;
  };
  const stageRestore = async (page: Page,scenario = 'restore') => {
    const panel = await history(page,scenario); await panel.getByRole('button',{ name: 'Stage release 1',exact: true }).click();
    await expect(panel.locator('[data-pack-update-status]')).toContainText('Retained release staged'); return panel;
  };
  test(`retained releases restore from an already-current pack at ${width}px`,async ({ page }) => {
    const panel = await stageRestore(page); await expect(panel.locator('[data-pack-update-plan]')).toContainText('version 3 → 2');
    const apply = panel.getByRole('button',{ name: 'Apply reviewed restore',exact: true }); await expect(apply).toBeDisabled();
    await expect(page.locator('[data-recued-packs-dialog-install]')).toHaveCount(0);
    await panel.getByRole('button',{ name: 'Test staged restore',exact: true }).click(); await expect(apply).toBeDisabled();
    await panel.locator('[data-pack-update-ack]').check(); await apply.click(); await expect(panel.locator('[data-pack-update-status]')).toContainText('Restore completed');
    const state = await page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-pack-update-fixture')!));
    expect(state.applied_versions).toEqual({ 'required-fixture': 3,'reviewed-fixture': 2 }); expect(state.install_calls).toBe(1);
    await expect(panel.locator('[data-pack-release-list]')).toContainText('Release 3');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
  for (const scenario of ['restore-missing-manifest','restore-catalog-unavailable']) test(`local release history survives ${scenario} at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 }); await page.goto('/pack-update-harness.html?scenario=' + scenario);
    await expect(page.getByRole('alert')).toContainText('Catalog unavailable');
    await page.getByRole('button',{ name: 'Release history',exact: true }).click();
    const panel = page.locator('[data-pack-update-tests]'); await panel.getByRole('button',{ name: 'Stage release 1',exact: true }).click();
    await expect(panel.locator('[data-pack-update-status]')).toContainText('Retained release staged');
    await expect(page.locator('[data-recued-packs-dialog-install]')).toHaveCount(0);
    await panel.getByRole('button',{ name: 'Test staged restore',exact: true }).click(); await panel.locator('[data-pack-update-ack]').check();
    await panel.getByRole('button',{ name: 'Apply reviewed restore',exact: true }).click();
    await expect(panel.locator('[data-pack-update-status]')).toContainText('Restore completed');
    const state = await page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-pack-update-fixture')!));
    expect(state.catalog_reads).toBe(1); expect(state.install_calls).toBe(1); expect(state.applied_versions).toEqual({ 'required-fixture': 3,'reviewed-fixture': 2 });
    await page.getByRole('button',{ name: 'Close release history',exact: true }).click();
    await expect(page.getByRole('button',{ name: 'Release history',exact: true })).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
  test(`restore receipts recover a lost reply without another write at ${width}px`,async ({ page }) => {
    const panel = await stageRestore(page,'restore-lost'); await panel.getByRole('button',{ name: 'Test staged restore',exact: true }).click();
    await panel.locator('[data-pack-update-ack]').check(); await panel.getByRole('button',{ name: 'Apply reviewed restore',exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('reply lost'); await panel.getByRole('button',{ name: 'Recover restore',exact: true }).click();
    await expect(panel.locator('[data-pack-update-status]')).toContainText('Restore completed');
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-pack-update-fixture')!).install_calls)).toBe(1);
  });
  test(`a lost restore stage retries its stable identity at ${width}px`,async ({ page }) => {
    const panel = await history(page,'restore-lost-stage'); await panel.getByRole('button',{ name: 'Stage release 1',exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('reply lost'); await panel.getByRole('button',{ name: 'Retry staging release',exact: true }).click();
    await expect(panel.locator('[data-pack-update-status]')).toContainText('Retained release staged');
    expect(await page.evaluate(() => Object.keys(JSON.parse(sessionStorage.getItem('recued-pack-update-fixture')!).requests).length)).toBe(1);
  });
  test(`missing saved tests hold an entire restore at ${width}px`,async ({ page }) => {
    const panel = await stageRestore(page,'restore-missing'); await panel.getByRole('button',{ name: 'Test staged restore',exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('Save recipe tests for second');
    await expect(panel.getByRole('button',{ name: 'Apply reviewed restore',exact: true })).toBeDisabled();
  });
  test(`surrounding inventory drift holds staging a retained release at ${width}px`,async ({ page }) => {
    const panel = await history(page,'restore-drift'); await panel.getByRole('button',{ name: 'Stage release 1',exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('surrounding pack inventory changed');
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-pack-update-fixture')!).install_calls)).toBe(0);
  });
  test(`release history close restores focus and a fresh acknowledgement is required after reopening at ${width}px`,async ({ page }) => {
    let panel = await stageRestore(page); await panel.getByRole('button',{ name: 'Test staged restore',exact: true }).click(); await panel.locator('[data-pack-update-ack]').check();
    await page.getByRole('button',{ name: 'Close release history',exact: true }).click();
    await expect(page.getByRole('button',{ name: 'Release history',exact: true })).toBeFocused();
    await page.getByRole('button',{ name: 'Release history',exact: true }).click(); panel = page.locator('[data-pack-update-tests]');
    await expect(panel.getByRole('button',{ name: 'Apply reviewed restore',exact: true })).toBeDisabled();
  });
  test(`a restore keeps unfinished saved-test edits after releasing its plan at ${width}px`,async ({ page }) => {
    const panel = await stageRestore(page); await panel.getByText('Saved tests: second',{ exact: true }).click();
    const tests = panel.locator('[data-pack-update-suite="second"] [data-recipe-regression]'); await tests.locator('summary').first().click();
    const name = tests.getByRole('textbox',{ name: 'Case name',exact: true }); await name.fill('Keep restore test draft');
    await panel.getByRole('button',{ name: 'Release staged dependency plan',exact: true }).click(); await expect(name).toHaveValue('Keep restore test draft');
    await expect(panel.getByText('Saved tests: second (outside staged update)',{ exact: true })).toBeVisible();
  });
  test(`an in-flight restore holds close and test editing at ${width}px`,async ({ page }) => {
    const panel = await stageRestore(page,'restore-slow'); await panel.getByRole('button',{ name: 'Test staged restore',exact: true }).click(); await panel.locator('[data-pack-update-ack]').check();
    await panel.getByRole('button',{ name: 'Apply reviewed restore',exact: true }).click();
    await expect(page.getByRole('button',{ name: 'Close release history',exact: true })).toBeDisabled();
    await expect(panel.locator('[data-recipe-regression]').first()).toHaveJSProperty('inert',true);
    await expect(panel.locator('[data-pack-update-status]')).toContainText('Restore completed');
  });
}

for (const width of [280,1280]) {
  test(`a reviewed dependency group applies together and leaves the ordinary Update held at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 }); await open(page,'dependency'); const panel = await stage(page);
    await expect(panel.locator('[data-pack-update-plan]')).toContainText('Required fixture pack: version 1 → 3');
    const apply = panel.getByRole('button',{ name: 'Apply reviewed dependency update',exact: true }); await expect(apply).toBeDisabled();
    await panel.getByRole('button',{ name: 'Test staged update',exact: true }).click(); await expect(apply).toBeDisabled();
    await panel.locator('[data-pack-update-ack]').check(); await expect(apply).toBeEnabled(); await expect(update(page)).toBeDisabled();
    await apply.click(); await expect(panel.locator('[data-pack-update-status]')).toContainText('2 packs committed together');
    const state = await page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-pack-update-fixture')!));
    expect(state.applied_versions).toEqual({ 'required-fixture': 3,'reviewed-fixture': 2 }); expect(state.install_calls).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await panel.getByRole('button',{ name: 'Refresh pack list',exact: true }).click(); await expect(page.locator('[data-recued-packs-dialog]')).toHaveCount(0);
  });
  test(`a dependency update recovers a lost reply through its exact receipt at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 }); await open(page,'dependency-lost'); const panel = await stage(page);
    await panel.getByRole('button',{ name: 'Test staged update',exact: true }).click(); await panel.locator('[data-pack-update-ack]').check();
    await panel.getByRole('button',{ name: 'Apply reviewed dependency update',exact: true }).click(); await expect(panel.getByRole('alert')).toContainText('reply lost');
    await panel.getByRole('button',{ name: 'Recover dependency update',exact: true }).click(); await expect(panel.locator('[data-pack-update-status]')).toContainText('completed');
    const state = await page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-pack-update-fixture')!));
    expect(state.install_calls).toBe(1); expect(Object.keys(state.applies)).toHaveLength(1);
    await expect(panel).toContainText('Completed dependency update receipt');
  });
  test(`a peer-released plan keeps a failed request recoverable without trapping restaging at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 }); await open(page,'dependency'); const panel = await stage(page);
    await panel.getByRole('button',{ name: 'Test staged update',exact: true }).click(); await panel.locator('[data-pack-update-ack]').check();
    await page.evaluate(() => { const key = 'recued-pack-update-fixture',state = JSON.parse(sessionStorage.getItem(key)!); state.view.candidate.digest = 'peer-candidate'; sessionStorage.setItem(key,JSON.stringify(state)); });
    await panel.getByRole('button',{ name: 'Apply reviewed dependency update',exact: true }).click(); await expect(panel.getByRole('alert')).toContainText('Candidate changed');
    await page.evaluate(() => { const key = 'recued-pack-update-fixture',state = JSON.parse(sessionStorage.getItem(key)!); state.view.candidate = null; state.view.qualification = null; state.view.revision++; sessionStorage.setItem(key,JSON.stringify(state)); });
    await panel.getByRole('button',{ name: 'Reload update protection',exact: true }).click();
    await expect(panel.getByRole('button',{ name: 'Recover dependency update',exact: true })).toBeEnabled();
    await panel.getByRole('button',{ name: 'Clear pending retry',exact: true }).click();
    await expect(panel.getByRole('button',{ name: 'Restage current update',exact: true })).toBeEnabled();
    await expect(panel.locator('[data-pack-update-status]')).toBeFocused();
    await panel.getByRole('button',{ name: 'Restage current update',exact: true }).click();
    await expect(panel.locator('[data-pack-update-plan]')).toBeVisible();
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-pack-update-fixture')!).install_calls)).toBe(0);
  });
  test(`a lost completion receipt stays recoverable after a peer restages a single pack at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 }); await open(page,'dependency-lost'); const panel = await stage(page);
    await panel.getByRole('button',{ name: 'Test staged update',exact: true }).click(); await panel.locator('[data-pack-update-ack]').check();
    await panel.getByRole('button',{ name: 'Apply reviewed dependency update',exact: true }).click(); await expect(panel.getByRole('alert')).toContainText('reply lost');
    const receipt = await page.evaluate(() => {
      const key = 'recued-pack-update-fixture',state = JSON.parse(sessionStorage.getItem(key)!),receipt = state.view.last_apply;
      state.view.candidate.packs = undefined; state.view.candidate.digest = 'peer-restage'; state.view.applied = false; state.view.revision++;
      state.view.last_apply = { ...receipt,request_id: 'later-operation' }; sessionStorage.setItem(key,JSON.stringify(state)); return receipt;
    });
    await panel.getByRole('button',{ name: 'Reload update protection',exact: true }).click();
    await panel.getByRole('button',{ name: 'Recover dependency update',exact: true }).click();
    await expect(panel.locator('[data-pack-update-status]')).toContainText(receipt.request_id);
    await expect(panel.locator('[data-pack-update-status]')).toContainText('Recovered a completed update');
    await expect(panel.getByRole('button',{ name: 'Recover dependency update',exact: true })).toHaveCount(0);
    const state = await page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-pack-update-fixture')!));
    expect(state.install_calls).toBe(1); expect(state.view.candidate.digest).toBe('peer-restage');
  });
  for (const scenario of ['dependency-failed','dependency-missing']) test(`${scenario} holds the complete plan at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 }); await open(page,scenario); const panel = await stage(page);
    await panel.getByRole('button',{ name: 'Test staged update',exact: true }).click();
    if (scenario === 'dependency-missing') await expect(panel.getByRole('alert')).toContainText('Save recipe tests for second');
    else await expect(panel.locator('[data-pack-update-results]')).toContainText('second: 0 passed, 1 failed');
    await expect(panel.getByRole('button',{ name: 'Apply reviewed dependency update',exact: true })).toBeDisabled();
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-pack-update-fixture')!).install_calls)).toBe(0);
  });
  test(`releasing a dependency plan preserves unfinished test edits at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 }); await open(page,'dependency'); const panel = await stage(page);
    await panel.getByText('Saved tests: second',{ exact: true }).click();
    const tests = panel.locator('[data-pack-update-suite="second"] [data-recipe-regression]'); await tests.locator('summary').first().click();
    const name = tests.getByRole('textbox',{ name: 'Case name',exact: true }); await name.fill('Keep the dependency draft');
    await panel.getByRole('button',{ name: 'Release staged dependency plan',exact: true }).click();
    await expect(panel.locator('[data-pack-update-status]')).toContainText('plan released'); await expect(name).toHaveValue('Keep the dependency draft');
    await expect(panel.getByText('Saved tests: second (outside staged update)',{ exact: true })).toBeVisible();
    await expect(update(page)).toBeDisabled();
    const state = await page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-pack-update-fixture')!));
    expect(state.view.managed).toBe(true); expect(state.view.installed_version).toBe(1); expect(state.install_calls).toBe(0);
  });
  test(`a changed dependency candidate holds applying after review at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 }); await open(page,'dependency'); const panel = await stage(page);
    await panel.getByRole('button',{ name: 'Test staged update',exact: true }).click(); await panel.locator('[data-pack-update-ack]').check();
    await page.evaluate(() => { const key = 'recued-pack-update-fixture',state = JSON.parse(sessionStorage.getItem(key)!); state.view.candidate.digest = 'new-candidate'; sessionStorage.setItem(key,JSON.stringify(state)); });
    await panel.getByRole('button',{ name: 'Apply reviewed dependency update',exact: true }).click(); await expect(panel.getByRole('alert')).toContainText('Candidate changed');
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-pack-update-fixture')!).install_calls)).toBe(0);
  });
  test(`the complete dependency apply joins the existing in-flight dialog guard at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 }); await open(page,'dependency-slow'); const panel = await stage(page);
    await panel.getByRole('button',{ name: 'Test staged update',exact: true }).click(); await panel.locator('[data-pack-update-ack]').check();
    await panel.getByRole('button',{ name: 'Apply reviewed dependency update',exact: true }).click();
    await expect(page.getByRole('button',{ name: 'Cancel',exact: true })).toBeDisabled();
    await expect(panel.locator('[data-recipe-regression]').first()).toHaveJSProperty('inert',true);
    await expect(panel.locator('[data-pack-update-status]')).toContainText('completed');
  });
  test(`an expired passing result cannot apply a dependency group at ${width}px`,async ({ page }) => {
    await page.clock.install(); await page.setViewportSize({ width,height: 900 }); await open(page,'dependency'); const panel = await stage(page);
    await panel.getByRole('button',{ name: 'Test staged update',exact: true }).click(); await panel.locator('[data-pack-update-ack]').check();
    await page.clock.fastForward(900_002); await expect(panel.getByRole('button',{ name: 'Apply reviewed dependency update',exact: true })).toBeDisabled();
    await expect(panel.locator('[data-pack-update-status]')).toContainText('expired');
  });
}
