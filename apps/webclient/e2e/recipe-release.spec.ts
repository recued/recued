import { expect,test,type Page } from '@playwright/test';
const input = (page: Page) => page.locator('[data-recued-recipe-editor-step="count"] [data-recued-recipe-editor-field="param:input"]');
const open = async (page: Page,scenario = '1') => {
  await page.goto(`/kitchen-harness.html?surface=recipe&fixture=regression&regression=1&releases=${scenario}`);
  const panel = page.locator('[data-recipe-release]'); await panel.locator('summary').first().click();
  await expect(panel.getByRole('button',{ name: 'Start reviewed releases',exact: true })).toBeVisible(); return panel;
};
const suite = async (page: Page,assertOutput = false) => {
  const panel = page.locator('[data-recipe-regression]'); await panel.locator('summary').first().click();
  await expect(panel.getByRole('button',{ name: 'Save test version',exact: true })).toBeEnabled();
  if (assertOutput) { await panel.getByRole('button',{ name: 'Add check',exact: true }).click(); await panel.getByRole('textbox',{ name: 'Expected value (JSON)',exact: true }).fill('0'); }
  await panel.getByRole('button',{ name: 'Save test version',exact: true }).click();
  await expect(panel.locator('[data-regression-status]')).toContainText('Saved test version 1.');
};
const draft = async (page: Page) => {
  await input(page).fill('[1,2]'); await input(page).press('Tab');
  const panel = page.locator('[data-recipe-release]'); await panel.getByRole('button',{ name: 'Start reviewed releases',exact: true }).click();
  await expect(panel.locator('[data-release-status]')).toContainText('Saved release draft 1.'); return panel;
};
const review = async (page: Page) => {
  const panel = page.locator('[data-recipe-release]'); await panel.getByRole('button',{ name: 'Test saved draft',exact: true }).click();
  await expect(panel.locator('[data-release-status]')).toContainText('Saved draft passed.');
  await panel.getByRole('button',{ name: 'Review activation',exact: true }).click(); await expect(panel.locator('[data-release-review]')).toBeVisible(); return panel;
};
const activeInput = (page: Page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-release-browser')!).view.active.recipe.steps[0].input);
for (const width of [280,1280]) {
  // D-201 Slice 10BD (10AY findings 12 and 13) — a release draft kept without
  // `variables`: compared as written with the editor's copy, which has them
  // empty, it could not be tested; loaded back as written, the editor's
  // recovery, which needs them, kept none of the edits made after it.
  test(`a draft kept without variables is tested, loaded and recovered as the editor holds it at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 });
    await page.goto('/kitchen-harness.html?surface=recipe&fixture=regression&regression=1&releases=no-variables&recovery=1');
    let panel = page.locator('[data-recipe-release]'); await panel.locator('summary').first().click();
    await expect(panel.getByRole('button',{ name: 'Start reviewed releases',exact: true })).toBeVisible();
    await suite(page); panel = await draft(page);
    expect(await page.evaluate(() => 'variables' in JSON.parse(sessionStorage.getItem('recued-release-browser')!).view.draft.recipe)).toBe(false);
    await review(page);
    // Opened again from the saved draft, which has no variables: tested as it is.
    await page.reload(); panel = page.locator('[data-recipe-release]'); await panel.locator('summary').first().click();
    await expect.poll(async () => JSON.parse(await input(page).inputValue())).toEqual([1,2]);
    await review(page);
    await panel.getByRole('button',{ name: 'Activate reviewed draft',exact: true }).click();
    await expect(panel.locator('[data-release-status]')).toContainText('Activated release 2.');
    // Restored as a draft, which the panel loads into the editor, then edited:
    // the copy recovery keeps has its variables.
    await panel.getByRole('combobox',{ name: 'Release to restore',exact: true }).selectOption('1');
    await panel.getByRole('button',{ name: 'Restore as draft',exact: true }).click();
    await expect(panel.locator('[data-release-status]')).toContainText('as draft 3');
    await input(page).fill('[1,2,3]'); await input(page).press('Tab');
    // The editor writes its copy a moment after the edit.
    const kept = () => page.evaluate(() => {
      const key = Object.keys(sessionStorage).find((name) => name.startsWith('recued.kitchen.draft.v1:'));
      return key === undefined ? null : JSON.parse(sessionStorage.getItem(key)!);
    });
    await expect.poll(async () => (await kept())?.snapshot?.recipe?.steps?.[0]?.input).toEqual([1,2,3]);
    const recovered = await kept();
    expect(recovered?.snapshot?.recipe?.variables).toEqual({});
    expect(recovered?.base?.variables).toEqual({});
  });
  // D-201 Slice 10BL (10BF finding 18) — the editor's comparison and adoption
  // after a draft save and an activation, pinned by no test; and an
  // activation deleted a recovery copy the owner had not restored.
  test(`a draft kept without variables, saved and activated in one sitting, leaves the editor saved and its copy adopted at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 });
    const asked: string[] = [];
    page.on('dialog',async (dialog) => { asked.push(dialog.message()); await dialog.dismiss(); });
    await page.goto('/kitchen-harness.html?surface=recipe&fixture=regression&regression=1&releases=no-variables&recovery=1');
    let panel = page.locator('[data-recipe-release]'); await panel.locator('summary').first().click();
    await expect(panel.getByRole('button',{ name: 'Start reviewed releases',exact: true })).toBeVisible();
    await suite(page); panel = await draft(page); await review(page);
    await panel.getByRole('button',{ name: 'Activate reviewed draft',exact: true }).click();
    await expect(panel.locator('[data-release-status]')).toContainText('Activated release 2.');
    // Saved as the editor holds it: restoring asks nothing of unsaved edits.
    await panel.getByRole('combobox',{ name: 'Release to restore',exact: true }).selectOption('1');
    await panel.getByRole('button',{ name: 'Restore as draft',exact: true }).click();
    await expect(panel.locator('[data-release-status]')).toContainText('as draft 3');
    expect(asked).toEqual([]);
  });
  test(`the copy recovery keeps after an activation has the activated recipe's variables at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 });
    await page.goto('/kitchen-harness.html?surface=recipe&fixture=regression&regression=1&releases=no-variables&recovery=1');
    let panel = page.locator('[data-recipe-release]'); await panel.locator('summary').first().click();
    await expect(panel.getByRole('button',{ name: 'Start reviewed releases',exact: true })).toBeVisible();
    await suite(page); panel = await draft(page); await review(page);
    await panel.getByRole('button',{ name: 'Activate reviewed draft',exact: true }).click();
    await expect(panel.locator('[data-release-status]')).toContainText('Activated release 2.');
    await input(page).fill('[1,2,3]'); await input(page).press('Tab');
    const kept = () => page.evaluate(() => {
      const key = Object.keys(sessionStorage).find((name) => name.startsWith('recued.kitchen.draft.v1:'));
      return key === undefined ? null : JSON.parse(sessionStorage.getItem(key)!);
    });
    await expect.poll(async () => (await kept())?.snapshot?.recipe?.steps?.[0]?.input).toEqual([1,2,3]);
    // The base it would be restored against, as the editor holds the activated recipe.
    expect((await kept())?.base?.variables).toEqual({});
  });
  test(`a copy kept after an activation reads as this tab's when the page opens again at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 });
    await page.goto('/kitchen-harness.html?surface=recipe&fixture=regression&regression=1&releases=no-variables&recovery=1');
    let panel = page.locator('[data-recipe-release]'); await panel.locator('summary').first().click();
    await expect(panel.getByRole('button',{ name: 'Start reviewed releases',exact: true })).toBeVisible();
    await suite(page); panel = await draft(page); await review(page);
    await panel.getByRole('button',{ name: 'Activate reviewed draft',exact: true }).click();
    await expect(panel.locator('[data-release-status]')).toContainText('Activated release 2.');
    await input(page).fill('[1,2,3]'); await input(page).press('Tab');
    await expect.poll(() => page.evaluate(() => {
      const key = Object.keys(sessionStorage).find((name) => name.startsWith('recued.kitchen.draft.v1:'));
      return key === undefined ? null : JSON.parse(sessionStorage.getItem(key)!).snapshot?.recipe?.steps?.[0]?.input;
    })).toEqual([1,2,3]);
    await page.reload(); panel = page.locator('[data-recipe-release]'); await panel.locator('summary').first().click();
    // Compared as written after the activation, the editor kept its saved copy
    // from before it, and the offer said the saved recipe had changed since.
    await expect(page.locator('.recipe-editor-recovery')).toContainText('There is unsaved work from this tab.');
  });
  test(`an activation keeps a recovery copy the owner has not restored, offered and stored at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 });
    await page.goto('/kitchen-harness.html?surface=recipe&fixture=regression&regression=1&releases=1&recovery=1');
    let panel = page.locator('[data-recipe-release]'); await panel.locator('summary').first().click();
    await expect(panel.getByRole('button',{ name: 'Start reviewed releases',exact: true })).toBeVisible();
    await suite(page); await draft(page);
    // Unsaved work, kept as a recovery copy, then the page opened again.
    await input(page).fill('[1,2,3]'); await input(page).press('Tab');
    const kept = () => page.evaluate(() => {
      const key = Object.keys(sessionStorage).find((name) => name.startsWith('recued.kitchen.draft.v1:'));
      return key === undefined ? null : JSON.parse(sessionStorage.getItem(key)!);
    });
    await expect.poll(async () => (await kept())?.snapshot?.recipe?.steps?.[0]?.input).toEqual([1,2,3]);
    await page.reload(); panel = page.locator('[data-recipe-release]'); await panel.locator('summary').first().click();
    const offer = page.locator('.recipe-editor-recovery');
    await expect(offer).toContainText('There is unsaved work');
    // The saved draft activated, the copy not restored.
    await review(page);
    await panel.getByRole('button',{ name: 'Activate reviewed draft',exact: true }).click();
    await expect(panel.locator('[data-release-status]')).toContainText('Activated release 2.');
    // Before 10BL: the offer gone and the copy deleted.
    await expect(offer).toContainText('There is unsaved work');
    expect((await kept())?.snapshot?.recipe?.steps?.[0]?.input).toEqual([1,2,3]);
    await offer.getByRole('button',{ name: 'Restore draft',exact: true }).click();
    await expect.poll(async () => JSON.parse(await input(page).inputValue())).toEqual([1,2,3]);
  });
  // D-201 Slice 10BR (10BM finding 21) — "Reload saved draft" and "Restore as
  // draft" deleted a recovery copy the owner had not restored while it was still
  // offered, so the page opened again offered nothing.
  test(`reloading the saved draft or restoring a release keeps a recovery copy the owner has not restored at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 });
    await page.goto('/kitchen-harness.html?surface=recipe&fixture=regression&regression=1&releases=1&recovery=1');
    let panel = page.locator('[data-recipe-release]'); await panel.locator('summary').first().click();
    await expect(panel.getByRole('button',{ name: 'Start reviewed releases',exact: true })).toBeVisible();
    await suite(page); await draft(page);
    await input(page).fill('[1,2,3]'); await input(page).press('Tab');
    const kept = () => page.evaluate(() => {
      const key = Object.keys(sessionStorage).find((name) => name.startsWith('recued.kitchen.draft.v1:'));
      return key === undefined ? null : JSON.parse(sessionStorage.getItem(key)!);
    });
    await expect.poll(async () => (await kept())?.snapshot?.recipe?.steps?.[0]?.input).toEqual([1,2,3]);
    await page.reload(); panel = page.locator('[data-recipe-release]'); await panel.locator('summary').first().click();
    const offer = page.locator('.recipe-editor-recovery');
    await expect(offer).toContainText('There is unsaved work');
    page.on('dialog',dialog => dialog.accept());
    await panel.getByRole('button',{ name: 'Reload saved draft',exact: true }).click();
    await expect.poll(async () => JSON.parse(await input(page).inputValue())).toEqual([1,2]);
    await expect(offer).toContainText('There is unsaved work');
    expect((await kept())?.snapshot?.recipe?.steps?.[0]?.input).toEqual([1,2,3]);
    // The saved draft activated (release 2), the page opened again, and
    // release 1 restored as the draft.
    await review(page);
    await panel.getByRole('button',{ name: 'Activate reviewed draft',exact: true }).click();
    await expect(panel.locator('[data-release-status]')).toContainText('Activated release 2.');
    await page.reload(); panel = page.locator('[data-recipe-release]'); await panel.locator('summary').first().click();
    await expect(offer).toContainText('There is unsaved work');
    await expect(panel.getByRole('combobox',{ name: 'Release to restore',exact: true })).toHaveValue('1');
    await panel.getByRole('combobox',{ name: 'Release to restore',exact: true }).selectOption('1');
    await panel.getByRole('button',{ name: 'Restore as draft',exact: true }).click();
    await expect(panel.locator('[data-release-status]')).toContainText('as draft');
    await expect(input(page)).toHaveValue('[]');
    await expect(offer).toContainText('There is unsaved work');
    expect((await kept())?.snapshot?.recipe?.steps?.[0]?.input).toEqual([1,2,3]);
    // An undo after it moves the editor back, unsaved, and leaves the copy
    // offered: before 10BR, the copy became the undone state.
    await page.locator('[data-recued-recipe-undo]').click();
    await expect.poll(async () => JSON.parse(await input(page).inputValue())).toEqual([1,2]);
    await expect(offer).toContainText('There is unsaved work');
    // D-201 Slice 10BW (the 10BS review's gap) — and a redo, which no case did.
    await page.locator('[data-recued-recipe-redo]').click();
    await expect(input(page)).toHaveValue('[]');
    await expect(offer).toContainText('There is unsaved work');
    expect((await kept())?.snapshot?.recipe?.steps?.[0]?.input).toEqual([1,2,3]);
    await page.locator('[data-recued-recipe-undo]').click();
    await expect.poll(async () => JSON.parse(await input(page).inputValue())).toEqual([1,2]);
    // Opened again (the page's leave writes an unsaved editor's state): still
    // offered, and restored as it was kept.
    await page.reload(); await page.locator('[data-recipe-release] summary').first().click();
    await expect(page.locator('.recipe-editor-recovery')).toContainText('There is unsaved work');
    await page.locator('.recipe-editor-recovery').getByRole('button',{ name: 'Restore draft',exact: true }).click();
    await expect.poll(async () => JSON.parse(await input(page).inputValue())).toEqual([1,2,3]);
  });
  // D-201 Slice 10BW (10BS finding 19) — a saved draft that was never activated
  // was replaced unasked, kept only in a draft history no screen offers.
  test(`restoring a release over a saved draft that was never activated asks first at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 }); const panel = await open(page); await suite(page); await draft(page); await review(page);
    await panel.getByRole('button',{ name: 'Activate reviewed draft',exact: true }).click();
    await expect(panel.locator('[data-release-status]')).toContainText('Activated release 2.');
    // A new draft, saved and never activated.
    await input(page).fill('[9]'); await input(page).press('Tab');
    await panel.getByRole('button',{ name: 'Save release draft',exact: true }).click();
    await expect(panel.locator('[data-release-status]')).toContainText('Saved release draft');
    await panel.getByRole('combobox',{ name: 'Release to restore',exact: true }).selectOption('1');
    const asked: string[] = [];
    page.once('dialog',async (dialog) => { asked.push(dialog.message()); await dialog.dismiss(); });
    await panel.getByRole('button',{ name: 'Restore as draft',exact: true }).click();
    await expect.poll(() => asked.length).toBe(1);
    expect(asked[0]).toBe('Replace the saved draft, which was never activated, with the selected release as a new draft?');
    await expect.poll(async () => JSON.parse(await input(page).inputValue())).toEqual([9]);
    page.once('dialog',dialog => dialog.accept());
    await panel.getByRole('button',{ name: 'Restore as draft',exact: true }).click();
    await expect(panel.locator('[data-release-status]')).toContainText('as draft');
    await expect(input(page)).toHaveValue('[]');
  });
  // D-201 Slice 10CB (the 10BX review's gap) — unsaved edits over a saved draft
  // that was never activated: both said, which no case pinned.
  test(`restoring a release with unsaved edits over a draft never activated says both at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 }); const panel = await open(page); await suite(page); await draft(page); await review(page);
    await panel.getByRole('button',{ name: 'Activate reviewed draft',exact: true }).click();
    await expect(panel.locator('[data-release-status]')).toContainText('Activated release 2.');
    await input(page).fill('[9]'); await input(page).press('Tab');
    await panel.getByRole('button',{ name: 'Save release draft',exact: true }).click();
    await expect(panel.locator('[data-release-status]')).toContainText('Saved release draft');
    // Edited since, unsaved.
    await input(page).fill('[8]'); await input(page).press('Tab');
    await panel.getByRole('combobox',{ name: 'Release to restore',exact: true }).selectOption('1');
    const asked: string[] = [];
    page.once('dialog',async (dialog) => { asked.push(dialog.message()); await dialog.dismiss(); });
    await panel.getByRole('button',{ name: 'Restore as draft',exact: true }).click();
    await expect.poll(() => asked.length).toBe(1);
    expect(asked[0]).toBe('Discard unsaved edits, and replace the saved draft, which was never activated, with the selected release?');
    await expect.poll(async () => JSON.parse(await input(page).inputValue())).toEqual([8]);
  });
  // D-201 Slice 10CB (10BX finding 14) — a draft restored from a release was
  // active once: replacing it loses nothing, and it was asked about as never
  // activated.
  test(`restoring a release over a draft restored from another asks nothing at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 }); const panel = await open(page); await suite(page); await draft(page); await review(page);
    await panel.getByRole('button',{ name: 'Activate reviewed draft',exact: true }).click();
    await expect(panel.locator('[data-release-status]')).toContainText('Activated release 2.');
    const asked: string[] = [];
    page.on('dialog',async (dialog) => { asked.push(dialog.message()); await dialog.dismiss(); });
    for (const sequence of ['1', '2', '1']) {
      await panel.getByRole('combobox',{ name: 'Release to restore',exact: true }).selectOption(sequence);
      await panel.getByRole('button',{ name: 'Restore as draft',exact: true }).click();
      await expect(panel.locator('[data-release-status]')).toContainText(`Restored release ${sequence} as draft`);
    }
    // Before 10CB: asked twice, "…which was never activated…", and dismissed.
    expect(asked).toEqual([]);
  });
  // D-201 Slice 10BW (10BS finding 19) — a Save with no edits (none can be made
  // while a copy is offered) deleted the copy, against 10BL's ruling for a
  // release draft saved with no edits.
  test(`a save with no edits keeps a recovery copy the owner has not restored at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 });
    await page.goto('/kitchen-harness.html?surface=recipe&fixture=regression&recovery=1');
    await input(page).fill('[4,5]'); await input(page).press('Tab');
    const kept = () => page.evaluate(() => {
      const key = Object.keys(sessionStorage).find((name) => name.startsWith('recued.kitchen.draft.v1:'));
      return key === undefined ? null : JSON.parse(sessionStorage.getItem(key)!);
    });
    await expect.poll(async () => (await kept())?.snapshot?.recipe?.steps?.[0]?.input).toEqual([4,5]);
    await page.reload();
    const offer = page.locator('.recipe-editor-recovery');
    await expect(offer).toContainText('There is unsaved work');
    await page.locator('[data-recued-recipe-editor-save]').click();
    await expect.poll(() => page.evaluate(() => window.__harness.recipeSaveBodies.length)).toBe(1);
    await expect(offer).toContainText('There is unsaved work');
    expect((await kept())?.snapshot?.recipe?.steps?.[0]?.input).toEqual([4,5]);
    await page.reload();
    await expect(page.locator('.recipe-editor-recovery')).toContainText('There is unsaved work');
    await page.locator('.recipe-editor-recovery').getByRole('button',{ name: 'Restore draft',exact: true }).click();
    await expect.poll(async () => JSON.parse(await input(page).inputValue())).toEqual([4,5]);
  });
  test(`drafts resume without activating and reviewed restoration follows the same tests at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 }); await open(page); await suite(page); let panel = await draft(page);
    expect(await activeInput(page)).toEqual([]);
    await page.reload(); panel = page.locator('[data-recipe-release]'); await panel.locator('summary').first().click();
    await expect.poll(async () => JSON.parse(await input(page).inputValue())).toEqual([1,2]); expect(await activeInput(page)).toEqual([]);
    await review(page); await expect(panel.locator('[data-release-review]')).toContainText('steps');
    await panel.getByRole('button',{ name: 'Activate reviewed draft',exact: true }).click();
    await expect(panel.locator('[data-release-status]')).toContainText('Activated release 2.'); expect(await activeInput(page)).toEqual([1,2]);
    await page.reload(); panel = page.locator('[data-recipe-release]'); await panel.locator('summary').first().click();
    await expect(panel.getByRole('combobox',{ name: 'Release to restore',exact: true })).toHaveValue('1');
    await panel.getByRole('combobox',{ name: 'Release to restore',exact: true }).selectOption('1');
    await panel.getByRole('button',{ name: 'Restore as draft',exact: true }).click();
    await expect(panel.locator('[data-release-status]')).toContainText('as draft 3');
    await expect(input(page)).toHaveValue('[]'); expect(await activeInput(page)).toEqual([1,2]);
    await expect(panel.getByRole('button',{ name: 'Review activation',exact: true })).toBeDisabled();
    await review(page); await panel.getByRole('button',{ name: 'Activate reviewed draft',exact: true }).click();
    await expect(panel.locator('[data-release-status]')).toContainText('Activated release 3.'); expect(await activeInput(page)).toEqual([]);
    expect(await page.evaluate(() => window.__harness.recipeSaveBodies.length)).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
  test(`failed assertions and working edits prevent activation at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 }); await open(page); await suite(page,true); const panel = await draft(page);
    await panel.getByRole('button',{ name: 'Test saved draft',exact: true }).click();
    await expect(panel.locator('[data-release-results]')).toContainText('0 passed, 1 failed');
    await expect(panel.getByRole('button',{ name: 'Review activation',exact: true })).toBeDisabled(); expect(await activeInput(page)).toEqual([]);
    await input(page).fill('[]'); await input(page).press('ControlOrMeta+s');
    await expect(panel.locator('[data-release-status]')).toContainText('Saved release draft 2.');
    await review(page); await input(page).fill('[1]'); await input(page).press('Tab');
    await expect(panel.locator('[data-release-review]')).toHaveCount(0); await expect(panel.getByRole('button',{ name: 'Test saved draft',exact: true })).toBeDisabled();
    expect(await page.evaluate(() => window.__harness.recipeSaveBodies.length)).toBe(0);
  });
  test(`stable retries recover lost save and activation replies at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 }); let panel = await open(page,'lost-save'); await suite(page);
    await panel.getByRole('button',{ name: 'Start reviewed releases',exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('Draft save reply lost');
    // The first reply can be lost before the UI learns enrollment.
    await panel.getByRole('button',{ name: 'Start reviewed releases',exact: true }).click();
    await expect(panel.locator('[data-release-status]')).toContainText('Saved release draft 1.');
    await page.goto('/kitchen-harness.html?surface=recipe&fixture=regression&regression=1&releases=lost-activate');
    panel = page.locator('[data-recipe-release]'); await panel.locator('summary').first().click(); await review(page);
    await panel.getByRole('button',{ name: 'Activate reviewed draft',exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('Activation reply lost');
    await panel.getByRole('button',{ name: 'Retry activation',exact: true }).click();
    await expect(panel.locator('[data-release-status]')).toContainText('Activated release 2.');
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('recued-release-browser')!).view.releases.length)).toBe(2);
  });
  test(`changing saved tests invalidates an already displayed activation review at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 }); await open(page); await suite(page); const panel = await draft(page); await review(page);
    const tests = page.locator('[data-recipe-regression]'); await tests.getByRole('textbox',{ name: 'Case name',exact: true }).fill('Updated case');
    await tests.getByRole('button',{ name: 'Save test version',exact: true }).click();
    await expect(tests.locator('[data-regression-status]')).toContainText('Saved test version 2.');
    await panel.getByRole('button',{ name: 'Activate reviewed draft',exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('Saved tests changed'); expect(await activeInput(page)).toEqual([]);
  });
  test(`cancellation and edits during testing cannot activate a passing old working copy at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 }); await open(page,'slow'); await suite(page); let panel = await draft(page);
    await panel.getByRole('button',{ name: 'Test saved draft',exact: true }).click(); await panel.getByRole('button',{ name: 'Cancel release tests',exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('Release tests cancelled'); await expect(panel.getByRole('button',{ name: 'Review activation',exact: true })).toBeDisabled();
    await page.goto('/kitchen-harness.html?surface=recipe&fixture=regression&regression=1&releases=defer'); panel = page.locator('[data-recipe-release]'); await panel.locator('summary').first().click();
    await panel.getByRole('button',{ name: 'Test saved draft',exact: true }).click(); await input(page).fill('[1]'); await input(page).press('Tab');
    await expect(panel.locator('[data-release-status]')).toContainText('Working edits changed while tests ran');
    await expect(panel.getByRole('button',{ name: 'Review activation',exact: true })).toBeDisabled(); expect(await activeInput(page)).toEqual([]);
  });
  test(`a superseded save reply preserves the working recipe and requires a reload at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 }); const panel = await open(page,'peer'); await suite(page); await draft(page);
    await expect(panel.locator('[data-release-status]')).toContainText('Newer changes exist'); await expect.poll(async () => JSON.parse(await input(page).inputValue())).toEqual([1,2]);
    await expect(panel.getByRole('button',{ name: 'Test saved draft',exact: true })).toBeDisabled();
    await panel.getByRole('button',{ name: 'Reload saved draft',exact: true }).click(); await expect.poll(async () => JSON.parse(await input(page).inputValue())).toEqual([99]);
    await expect(panel.getByRole('button',{ name: 'Test saved draft',exact: true })).toBeEnabled();
    await review(page); expect(await activeInput(page)).toEqual([]);
  });
  test(`a late draft save retains unfinished JSON and the leave guard at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 }); const panel = await open(page,'late-save'); await suite(page);
    await input(page).fill('[1,2]'); await input(page).press('Tab');
    await panel.getByRole('button',{ name: 'Start reviewed releases',exact: true }).click();
    await input(page).fill('['); await input(page).press('Tab');
    await expect(panel.locator('[data-release-status]')).toContainText('Saved release draft 1.');
    await expect(input(page)).toHaveValue('[');
    await expect(page.locator('[data-recued-recipe-editor-dirty]')).toContainText('Unsaved');
    await expect(panel.getByRole('button',{ name: 'Test saved draft',exact: true })).toBeDisabled(); expect(await activeInput(page)).toEqual([]);
  });
  test(`a late reload preserves edits made while the private draft loads at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 }); const panel = await open(page,'late-load'); await suite(page); await draft(page);
    await panel.getByRole('button',{ name: 'Reload saved draft',exact: true }).click();
    await input(page).fill('[3]'); await input(page).press('Tab');
    await expect(panel.locator('[data-release-status]')).toContainText('Newer working edits were kept');
    await expect.poll(async () => JSON.parse(await input(page).inputValue())).toEqual([3]);
    await expect(panel.getByRole('button',{ name: 'Test saved draft',exact: true })).toBeDisabled();
    page.once('dialog',dialog => dialog.accept()); await panel.getByRole('button',{ name: 'Reload saved draft',exact: true }).click();
    await expect.poll(async () => JSON.parse(await input(page).inputValue())).toEqual([1,2]);
    await expect(panel.getByRole('button',{ name: 'Test saved draft',exact: true })).toBeEnabled();
  });
  test(`a late restoration preserves newer working edits and the active recipe at ${width}px`,async ({ page }) => {
    await page.setViewportSize({ width,height: 900 }); const panel = await open(page,'late-restore'); await suite(page); await draft(page); await review(page);
    await panel.getByRole('button',{ name: 'Activate reviewed draft',exact: true }).click();
    await expect(panel.locator('[data-release-status]')).toContainText('Activated release 2.');
    await panel.getByRole('button',{ name: 'Restore as draft',exact: true }).click();
    await input(page).fill('[3]'); await input(page).press('Tab');
    await expect(panel.locator('[data-release-status]')).toContainText('Newer working edits were kept');
    await expect.poll(async () => JSON.parse(await input(page).inputValue())).toEqual([3]);
    expect(await activeInput(page)).toEqual([1,2]);
    page.once('dialog',dialog => dialog.accept()); await panel.getByRole('button',{ name: 'Reload saved draft',exact: true }).click();
    await expect(input(page)).toHaveValue('[]'); expect(await activeInput(page)).toEqual([1,2]);
  });
}
