import { expect, test } from '@playwright/test';
import {
  DATA_DETAIL_HEADING, HARNESS_URL, SHARED_PROVENANCE, SHARED_REFERENCE_ID,
  installFullAppHooks,
} from './helpers/full-app.js';

/** Run-result journeys cover Packs, Recipes, and verification through Logs, Data, and Chat. */
const DATA_VERIFICATION_ACTION =
  'data-recued-data-route-verification-action';
const LOGS_OUTCOME = 'data-recued-logs-outcome';
const LOGS_AFFECTED_ITEMS = 'data-recued-logs-affected-items';

installFullAppHooks();

test('copyable run results stay usable across Packs and Recipes', async ({ page }) => {
  await page.context().grantPermissions(
    ['clipboard-read', 'clipboard-write'],
    { origin: new URL(HARNESS_URL).origin },
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(
    `${HARNESS_URL}?packs=installed&recipe_result=copyable`
      + '#packs/installed-mail',
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const packApp = page.locator('[data-recued-pack-app="installed-mail"]');
  await packApp.locator(
    '[data-recued-pack-app-operation="installed-mail-digest"]',
  ).click();
  const runDialog = page.getByRole('dialog', { name: 'Run a Recipe' });
  await runDialog.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(runDialog.getByRole('status')).toContainText('Run completed');
  await runDialog.getByRole('button', { name: 'Close' }).click();
  await expect(runDialog).toHaveCount(0);
  const packCopy = packApp.locator('.copy-btn');
  const packRecipeReferences = packApp.locator(
    `[${SHARED_REFERENCE_ID}="installed-mail-digest"]`,
  );
  await expect(packRecipeReferences).toHaveCount(2);
  await expect(packRecipeReferences.first()).toBeVisible();
  await expect(packApp.locator(`[${SHARED_PROVENANCE}]`))
    .toHaveAttribute('data-kind', 'source');
  await expect(packCopy).toBeVisible();
  await expect(packCopy).toHaveAccessibleName('Copy');
  expect((await packCopy.boundingBox())?.height).toBeGreaterThanOrEqual(36);

  await page.setViewportSize({ width: 390, height: 844 });
  const packGeometry = await packApp.evaluate((surface) => {
    const button = surface.querySelector<HTMLButtonElement>('.copy-btn');
    const buttonRect = button?.getBoundingClientRect();
    return {
      contained: surface.scrollWidth <= surface.clientWidth,
      buttonHeight: buttonRect?.height ?? 0,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  });
  expect(packGeometry.contained).toBe(true);
  expect(packGeometry.buttonHeight).toBeGreaterThanOrEqual(44);
  expect(packGeometry.documentWidth).toBeLessThanOrEqual(
    packGeometry.viewportWidth,
  );
  await packCopy.focus();
  await page.keyboard.press('Enter');
  await expect(packCopy).toHaveText('Copied');
  await expect(packCopy).toBeFocused();

  await page.goto(
    `${HARNESS_URL}?recipes=installed&recipe_default_run=1`
      + '&recipe_result=copyable#recipes',
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.locator('[data-recued-recipes-card="autorun-live-1"]')
    .getByRole('button', { name: /Open .+ details/ })
    .click();
  const detail = page.locator(
    '[data-recued-recipes-detail="autorun-live-1"]',
  );
  await detail.locator('[data-recued-recipes-action="run-defaults"]')
    .click();

  const recipeCopy = detail.locator('.copy-btn');
  await expect(recipeCopy).toBeVisible();
  await expect(recipeCopy).toHaveAccessibleName('Copy');
  expect((await recipeCopy.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  expect(await detail.evaluate((surface) => (
    surface.scrollWidth <= surface.clientWidth
  ))).toBe(true);
  await recipeCopy.focus();
  await page.keyboard.press('Enter');
  await expect(recipeCopy).toHaveText('Copied');
  await expect(recipeCopy).toBeFocused();
});

test('JSON run results stay operable and contained across Packs and Recipes', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(
    `${HARNESS_URL}?packs=installed&recipe_result=json`
      + '#packs/installed-mail',
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const packApp = page.locator('[data-recued-pack-app="installed-mail"]');
  await packApp.locator(
    '[data-recued-pack-app-operation="installed-mail-digest"]',
  ).click();
  const runDialog = page.getByRole('dialog', { name: 'Run a Recipe' });
  await runDialog.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(runDialog.getByRole('status')).toContainText('Run completed');
  await runDialog.getByRole('button', { name: 'Close' }).click();
  await expect(runDialog).toHaveCount(0);

  const packDetails = packApp.locator('.json-details');
  const packSummary = packDetails.locator('.json-summary');
  await expect(packApp.locator('.recipes-result-card h3'))
    .toHaveText('Provider payload');
  await expect(packSummary).toHaveText('Data');
  expect((await packSummary.boundingBox())?.height).toBeGreaterThanOrEqual(36);
  await page.setViewportSize({ width: 390, height: 844 });
  expect((await packSummary.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await packSummary.focus();
  await page.keyboard.press('Enter');
  await expect(packDetails).toHaveAttribute('open', '');
  await expect(packSummary).toBeFocused();
  const packGeometry = await packApp.evaluate((surface) => {
    const surfaceRect = surface.getBoundingClientRect();
    const payload = surface.querySelector<HTMLElement>('.json-content');
    return {
      surfaceRight: surfaceRect.right,
      payloadContained: payload !== null
        && payload.scrollWidth <= payload.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  });
  expect(packGeometry.surfaceRight).toBeLessThanOrEqual(
    packGeometry.viewportWidth,
  );
  expect(packGeometry.payloadContained).toBe(true);
  expect(packGeometry.documentWidth).toBeLessThanOrEqual(
    packGeometry.viewportWidth,
  );

  await page.goto(
    `${HARNESS_URL}?recipes=installed&recipe_default_run=1`
      + '&recipe_result=json#recipes',
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.locator('[data-recued-recipes-card="autorun-live-1"]')
    .getByRole('button', { name: /Open .+ details/ })
    .click();
  const detail = page.locator(
    '[data-recued-recipes-detail="autorun-live-1"]',
  );
  await detail.locator('[data-recued-recipes-action="run-defaults"]')
    .click();

  const recipeDetails = detail.locator('.json-details');
  const recipeSummary = recipeDetails.locator('.json-summary');
  await expect(detail.locator('.recipes-result-card h3'))
    .toHaveText('Provider payload');
  await expect(recipeSummary).toHaveText('Data');
  expect((await recipeSummary.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await recipeSummary.focus();
  await page.keyboard.press('Enter');
  await expect(recipeDetails).toHaveAttribute('open', '');
  await expect(recipeSummary).toBeFocused();
  const recipeGeometry = await detail.evaluate((surface) => {
    const surfaceRect = surface.getBoundingClientRect();
    const payload = surface.querySelector<HTMLElement>('.json-content');
    return {
      surfaceRight: surfaceRect.right,
      payloadContained: payload !== null
        && payload.scrollWidth <= payload.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  });
  expect(recipeGeometry.surfaceRight).toBeLessThanOrEqual(
    recipeGeometry.viewportWidth,
  );
  expect(recipeGeometry.payloadContained).toBe(true);
  expect(recipeGeometry.documentWidth).toBeLessThanOrEqual(
    recipeGeometry.viewportWidth,
  );
});

test('record-field run results stay readable and contained across Packs and Recipes', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(
    `${HARNESS_URL}?packs=installed&recipe_result=record-fields`
      + '#packs/installed-mail',
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const packApp = page.locator('[data-recued-pack-app="installed-mail"]');
  const packFields = packApp.locator('.record-fields-block');
  await expect(packFields).toBeVisible();
  await expect(packApp.locator('.recipes-result-card h3'))
    .toHaveText('Work order');
  const packTitleRow = packFields.locator(
    '[data-recued-output-record-field="title"]',
  );
  const packDesktopLayout = await packTitleRow.evaluate((row) => {
    const label = row.querySelector('dt')?.getBoundingClientRect();
    const value = row.querySelector('dd')?.getBoundingClientRect();
    return {
      display: getComputedStyle(row).display,
      aligned: label !== undefined && value !== undefined
        && Math.abs(label.top - value.top) < 1,
    };
  });
  expect(packDesktopLayout).toEqual({ display: 'grid', aligned: true });

  await page.setViewportSize({ width: 390, height: 844 });
  const packGeometry = await packFields.evaluate((block) => {
    const host = block.closest<HTMLElement>('[data-recued-result-host]');
    const hostRect = host?.getBoundingClientRect();
    const row = block.querySelector<HTMLElement>(
      '[data-recued-output-record-field="external_reference"]',
    );
    const label = row?.querySelector('dt')?.getBoundingClientRect();
    const value = row?.querySelector<HTMLElement>('dd');
    const valueRect = value?.getBoundingClientRect();
    return {
      hostRight: hostRect?.right ?? Number.POSITIVE_INFINITY,
      stacked: label !== undefined && valueRect !== undefined
        && valueRect.top >= label.bottom,
      valueContained: value !== null && value !== undefined
        && value.scrollWidth <= value.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  });
  expect(packGeometry.hostRight).toBeLessThanOrEqual(packGeometry.viewportWidth);
  expect(packGeometry.stacked).toBe(true);
  expect(packGeometry.valueContained).toBe(true);
  expect(packGeometry.documentWidth).toBeLessThanOrEqual(
    packGeometry.viewportWidth,
  );
  await expect(packFields.locator('.record-field-unset'))
    .toHaveCSS('font-style', 'italic');

  await page.goto(
    `${HARNESS_URL}?recipes=installed&recipe_default_run=1`
      + '&recipe_result=record-fields#recipes',
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.locator('[data-recued-recipes-card="autorun-live-1"]')
    .getByRole('button', { name: /Open .+ details/ })
    .click();
  const detail = page.locator(
    '[data-recued-recipes-detail="autorun-live-1"]',
  );
  await detail.locator('[data-recued-recipes-action="run-defaults"]')
    .click();

  const recipeFields = detail.locator('.record-fields-block');
  await expect(recipeFields).toBeVisible();
  await expect(detail.locator('.recipes-result-card h3'))
    .toHaveText('Work order');
  const recipeGeometry = await recipeFields.evaluate((block) => {
    const host = block.closest<HTMLElement>('[data-recued-result-host]');
    const hostRect = host?.getBoundingClientRect();
    const row = block.querySelector<HTMLElement>(
      '[data-recued-output-record-field="external_reference"]',
    );
    const label = row?.querySelector('dt')?.getBoundingClientRect();
    const value = row?.querySelector<HTMLElement>('dd');
    const valueRect = value?.getBoundingClientRect();
    return {
      display: row === null ? '' : getComputedStyle(row).display,
      hostRight: hostRect?.right ?? Number.POSITIVE_INFINITY,
      stacked: label !== undefined && valueRect !== undefined
        && valueRect.top >= label.bottom,
      valueContained: value !== null && value !== undefined
        && value.scrollWidth <= value.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  });
  expect(recipeGeometry.display).toBe('grid');
  expect(recipeGeometry.hostRight).toBeLessThanOrEqual(
    recipeGeometry.viewportWidth,
  );
  expect(recipeGeometry.stacked).toBe(true);
  expect(recipeGeometry.valueContained).toBe(true);
  expect(recipeGeometry.documentWidth).toBeLessThanOrEqual(
    recipeGeometry.viewportWidth,
  );
});

test('AI-analysis run results stay structured and contained across Packs and Recipes', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(
    `${HARNESS_URL}?packs=installed&recipe_result=ai-analysis`
      + '#packs/installed-mail',
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const packApp = page.locator('[data-recued-pack-app="installed-mail"]');
  await packApp.locator(
    '[data-recued-pack-app-operation="installed-mail-digest"]',
  ).click();
  const runDialog = page.getByRole('dialog', { name: 'Run a Recipe' });
  await runDialog.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(runDialog.getByRole('status')).toContainText('Run completed');
  await runDialog.getByRole('button', { name: 'Close' }).click();
  await expect(runDialog).toHaveCount(0);

  const packAnalysis = packApp.locator('.ai-block');
  await expect(packAnalysis).toHaveCount(2);
  await expect(packAnalysis.first().locator('.ai-points li')).toHaveCount(2);
  const packDesktopRow = await packAnalysis.first().locator('.ai-row').first()
    .evaluate((row) => {
      const label = row.querySelector('.ai-label')?.getBoundingClientRect();
      const value = row.querySelector('.ai-label + span')?.getBoundingClientRect();
      return {
        display: getComputedStyle(row).display,
        aligned: label !== undefined && value !== undefined
          && Math.abs(label.top - value.top) < 1,
      };
    });
  expect(packDesktopRow).toEqual({ display: 'grid', aligned: true });

  await page.setViewportSize({ width: 390, height: 844 });
  const packGeometry = await packAnalysis.first().evaluate((analysis) => {
    const host = analysis.closest<HTMLElement>('[data-recued-result-host]');
    const hostRect = host?.getBoundingClientRect();
    const row = analysis.querySelector<HTMLElement>('.ai-row');
    const label = row?.querySelector('.ai-label')?.getBoundingClientRect();
    const value = row?.querySelector<HTMLElement>('.ai-label + span');
    const valueRect = value?.getBoundingClientRect();
    const reasoning = analysis.querySelector<HTMLElement>('.ai-reasoning');
    const raw = host?.querySelector<HTMLElement>('.ai-json') ?? null;
    return {
      hostRight: hostRect?.right ?? Number.POSITIVE_INFINITY,
      rowStacked: label !== undefined && valueRect !== undefined
        && valueRect.top >= label.bottom,
      reasoningContained: reasoning !== null
        && reasoning.scrollWidth <= reasoning.clientWidth,
      rawContained: raw !== null && raw.scrollWidth <= raw.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  });
  expect(packGeometry.hostRight).toBeLessThanOrEqual(packGeometry.viewportWidth);
  expect(packGeometry.rowStacked).toBe(true);
  expect(packGeometry.reasoningContained).toBe(true);
  expect(packGeometry.rawContained).toBe(true);
  expect(packGeometry.documentWidth).toBeLessThanOrEqual(
    packGeometry.viewportWidth,
  );

  await page.goto(
    `${HARNESS_URL}?recipes=installed&recipe_default_run=1`
      + '&recipe_result=ai-analysis#recipes',
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.locator('[data-recued-recipes-card="autorun-live-1"]')
    .getByRole('button', { name: /Open .+ details/ })
    .click();
  const detail = page.locator(
    '[data-recued-recipes-detail="autorun-live-1"]',
  );
  await detail.locator('[data-recued-recipes-action="run-defaults"]')
    .click();

  const recipeAnalysis = detail.locator('.ai-block');
  await expect(recipeAnalysis).toHaveCount(2);
  await expect(recipeAnalysis.first().locator('.ai-points li')).toHaveCount(2);
  const recipeGeometry = await recipeAnalysis.first().evaluate((analysis) => {
    const host = analysis.closest<HTMLElement>('[data-recued-result-host]');
    const hostRect = host?.getBoundingClientRect();
    const row = analysis.querySelector<HTMLElement>('.ai-row');
    const label = row?.querySelector('.ai-label')?.getBoundingClientRect();
    const value = row?.querySelector<HTMLElement>('.ai-label + span');
    const valueRect = value?.getBoundingClientRect();
    const reasoning = analysis.querySelector<HTMLElement>('.ai-reasoning');
    const raw = host?.querySelector<HTMLElement>('.ai-json') ?? null;
    return {
      display: getComputedStyle(analysis).display,
      hostRight: hostRect?.right ?? Number.POSITIVE_INFINITY,
      rowStacked: label !== undefined && valueRect !== undefined
        && valueRect.top >= label.bottom,
      reasoningContained: reasoning !== null
        && reasoning.scrollWidth <= reasoning.clientWidth,
      rawContained: raw !== null && raw.scrollWidth <= raw.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  });
  expect(recipeGeometry.display).toBe('grid');
  expect(recipeGeometry.hostRight).toBeLessThanOrEqual(
    recipeGeometry.viewportWidth,
  );
  expect(recipeGeometry.rowStacked).toBe(true);
  expect(recipeGeometry.reasoningContained).toBe(true);
  expect(recipeGeometry.rawContained).toBe(true);
  expect(recipeGeometry.documentWidth).toBeLessThanOrEqual(
    recipeGeometry.viewportWidth,
  );
});

test('link-button run results stay safe and usable across Packs and Recipes', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(
    `${HARNESS_URL}?packs=installed&recipe_result=link-buttons`
      + '#packs/installed-mail',
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const packApp = page.locator('[data-recued-pack-app="installed-mail"]');
  await packApp.locator(
    '[data-recued-pack-app-operation="installed-mail-digest"]',
  ).click();
  const runDialog = page.getByRole('dialog', { name: 'Run a Recipe' });
  await runDialog.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(runDialog.getByRole('status')).toContainText('Run completed');
  await runDialog.getByRole('button', { name: 'Close' }).click();
  await expect(runDialog).toHaveCount(0);

  const packLinks = packApp.locator('.link-button-link');
  await expect(packLinks).toHaveCount(2);
  const packPrimaryLink = packLinks.first();
  await expect(packPrimaryLink).toHaveAttribute(
    'href',
    'https://example.com/work/job_1',
  );
  await expect(packPrimaryLink).toHaveAttribute('rel', 'noopener noreferrer');
  expect((await packPrimaryLink.boundingBox())?.height)
    .toBeGreaterThanOrEqual(36);
  await page.setViewportSize({ width: 390, height: 844 });
  expect((await packPrimaryLink.boundingBox())?.height)
    .toBeGreaterThanOrEqual(44);
  const packGeometry = await packApp.locator('.link-button-block')
    .evaluate((block) => {
      const host = block.closest<HTMLElement>('[data-recued-result-host]');
      const hostRect = host?.getBoundingClientRect();
      const links = [...block.querySelectorAll<HTMLElement>('.link-button-link')];
      const descriptions = [
        ...block.querySelectorAll<HTMLElement>('.link-button-description'),
      ];
      return {
        hostRight: hostRect?.right ?? Number.POSITIVE_INFINITY,
        linksContained: links.every((link) => (
          link.scrollWidth <= link.clientWidth
        )),
        descriptionsContained: descriptions.every((description) => (
          description.scrollWidth <= description.clientWidth
        )),
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
      };
    });
  expect(packGeometry.hostRight).toBeLessThanOrEqual(packGeometry.viewportWidth);
  expect(packGeometry.linksContained).toBe(true);
  expect(packGeometry.descriptionsContained).toBe(true);
  expect(packGeometry.documentWidth).toBeLessThanOrEqual(
    packGeometry.viewportWidth,
  );
  await packPrimaryLink.focus();
  await expect(packPrimaryLink).toBeFocused();

  await page.goto(
    `${HARNESS_URL}?recipes=installed&recipe_default_run=1`
      + '&recipe_result=link-buttons#recipes',
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.locator('[data-recued-recipes-card="autorun-live-1"]')
    .getByRole('button', { name: /Open .+ details/ })
    .click();
  const detail = page.locator(
    '[data-recued-recipes-detail="autorun-live-1"]',
  );
  await detail.locator('[data-recued-recipes-action="run-defaults"]')
    .click();

  const recipeLinks = detail.locator('.link-button-link');
  await expect(recipeLinks).toHaveCount(2);
  const recipePrimaryLink = recipeLinks.first();
  await expect(recipePrimaryLink).toHaveAttribute(
    'href',
    'https://example.com/work/job_1',
  );
  await expect(recipePrimaryLink).toHaveAttribute('rel', 'noopener noreferrer');
  expect((await recipePrimaryLink.boundingBox())?.height)
    .toBeGreaterThanOrEqual(44);
  const recipeGeometry = await detail.locator('.link-button-block')
    .evaluate((block) => {
      const host = block.closest<HTMLElement>('[data-recued-result-host]');
      const hostRect = host?.getBoundingClientRect();
      const links = [...block.querySelectorAll<HTMLElement>('.link-button-link')];
      const descriptions = [
        ...block.querySelectorAll<HTMLElement>('.link-button-description'),
      ];
      return {
        hostRight: hostRect?.right ?? Number.POSITIVE_INFINITY,
        linksContained: links.every((link) => (
          link.scrollWidth <= link.clientWidth
        )),
        descriptionsContained: descriptions.every((description) => (
          description.scrollWidth <= description.clientWidth
        )),
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
      };
    });
  expect(recipeGeometry.hostRight).toBeLessThanOrEqual(
    recipeGeometry.viewportWidth,
  );
  expect(recipeGeometry.linksContained).toBe(true);
  expect(recipeGeometry.descriptionsContained).toBe(true);
  expect(recipeGeometry.documentWidth).toBeLessThanOrEqual(
    recipeGeometry.viewportWidth,
  );
  await recipePrimaryLink.focus();
  await expect(recipePrimaryLink).toBeFocused();
});

test('file-artifact run results keep exact identity contained across Packs and Recipes', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(
    `${HARNESS_URL}?packs=installed&recipe_result=file-artifact`
      + '#packs/installed-mail',
  );
  await page.waitForFunction(() => window.__app?.ready === true);

  const packApp = page.locator('[data-recued-pack-app="installed-mail"]');
  await packApp.locator(
    '[data-recued-pack-app-operation="installed-mail-digest"]',
  ).click();
  const runDialog = page.getByRole('dialog', { name: 'Run a Recipe' });
  await runDialog.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(runDialog.getByRole('status')).toContainText('Run completed');
  await runDialog.getByRole('button', { name: 'Close' }).click();
  await expect(runDialog).toHaveCount(0);

  const packArtifact = packApp.locator('.recipes-file-artifact');
  await expect(packArtifact).toBeVisible();
  await expect(packArtifact.locator('.recipes-file-artifact-badge'))
    .toHaveText('Exact immutable file');
  const packPreview = packArtifact.getByRole('button', {
    name: 'Preview exact PDF',
  });
  expect((await packPreview.boundingBox())?.height).toBeGreaterThanOrEqual(38);
  await page.setViewportSize({ width: 390, height: 844 });
  const packGeometry = await packArtifact.evaluate((card) => {
    const host = card.closest<HTMLElement>('[data-recued-result-host]');
    const hostRect = host?.getBoundingClientRect();
    const title = card.querySelector<HTMLElement>('h4');
    const filename = card.querySelector<HTMLElement>(
      '.recipes-file-artifact-header p',
    );
    const header = card.querySelector<HTMLElement>(
      '.recipes-file-artifact-header',
    );
    return {
      hostRight: hostRect?.right ?? Number.POSITIVE_INFINITY,
      cardContained: card.scrollWidth <= card.clientWidth,
      titleContained: title !== null && title.scrollWidth <= title.clientWidth,
      filenameContained: filename !== null
        && filename.scrollWidth <= filename.clientWidth,
      headerDisplay: header === null ? '' : getComputedStyle(header).display,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  });
  expect(packGeometry.hostRight).toBeLessThanOrEqual(packGeometry.viewportWidth);
  expect(packGeometry.cardContained).toBe(true);
  expect(packGeometry.titleContained).toBe(true);
  expect(packGeometry.filenameContained).toBe(true);
  expect(packGeometry.headerDisplay).toBe('grid');
  expect(packGeometry.documentWidth).toBeLessThanOrEqual(
    packGeometry.viewportWidth,
  );
  await packPreview.focus();
  await expect(packPreview).toBeFocused();

  await page.goto(
    `${HARNESS_URL}?recipes=installed&recipe_default_run=1`
      + '&recipe_result=file-artifact#recipes',
  );
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.locator('[data-recued-recipes-card="autorun-live-1"]')
    .getByRole('button', { name: /Open .+ details/ })
    .click();
  const detail = page.locator(
    '[data-recued-recipes-detail="autorun-live-1"]',
  );
  await detail.locator('[data-recued-recipes-action="run-defaults"]')
    .click();

  const recipeArtifact = detail.locator('.recipes-file-artifact');
  await expect(recipeArtifact).toBeVisible();
  await expect(recipeArtifact.locator('.recipes-file-artifact-badge'))
    .toHaveText('Exact immutable file');
  const recipePreview = recipeArtifact.getByRole('button', {
    name: 'Preview exact PDF',
  });
  const recipeGeometry = await recipeArtifact.evaluate((card) => {
    const host = card.closest<HTMLElement>('[data-recued-result-host]');
    const hostRect = host?.getBoundingClientRect();
    const title = card.querySelector<HTMLElement>('h4');
    const filename = card.querySelector<HTMLElement>(
      '.recipes-file-artifact-header p',
    );
    const header = card.querySelector<HTMLElement>(
      '.recipes-file-artifact-header',
    );
    return {
      hostRight: hostRect?.right ?? Number.POSITIVE_INFINITY,
      cardContained: card.scrollWidth <= card.clientWidth,
      titleContained: title !== null && title.scrollWidth <= title.clientWidth,
      filenameContained: filename !== null
        && filename.scrollWidth <= filename.clientWidth,
      headerDisplay: header === null ? '' : getComputedStyle(header).display,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  });
  expect(recipeGeometry.hostRight).toBeLessThanOrEqual(
    recipeGeometry.viewportWidth,
  );
  expect(recipeGeometry.cardContained).toBe(true);
  expect(recipeGeometry.titleContained).toBe(true);
  expect(recipeGeometry.filenameContained).toBe(true);
  expect(recipeGeometry.headerDisplay).toBe('grid');
  expect(recipeGeometry.documentWidth).toBeLessThanOrEqual(
    recipeGeometry.viewportWidth,
  );
  await recipePreview.focus();
  await expect(recipePreview).toBeFocused();
});

test('an uncertain run lands on its exact record with readable dark-theme next steps', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`${HARNESS_URL}?chat=session&journey=verification`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
    window.__app.setHash(
      '#logs/run-verify/return/chat/session/chat_1/plan/'
      + 'plan_email_1/answer/msg_action',
    );
  });

  const outcome = page.locator(`[${LOGS_OUTCOME}]`);
  await expect(outcome).toBeVisible();
  await expect(outcome).toContainText('Somebody needs to check what happened');
  await expect(outcome).toBeFocused();
  const openRun = page.getByRole('button', {
    name: 'Open run detail for Schedule customer review (run-verify)',
    exact: true,
  });
  const openRunBox = await openRun.boundingBox();
  expect(openRunBox?.width).toBeGreaterThanOrEqual(32);
  expect(openRunBox?.height).toBeGreaterThanOrEqual(32);
  const detailLinkHeights = await page
    .locator('.logs-row-links a, .logs-detail-meta a')
    .evaluateAll((links) =>
      links.map((link) => link.getBoundingClientRect().height)
    );
  expect(detailLinkHeights.length).toBeGreaterThan(0);
  expect(Math.min(...detailLinkHeights)).toBeGreaterThanOrEqual(24);

  const affected = page.locator(`[${LOGS_AFFECTED_ITEMS}]`);
  const verify = affected.getByRole('link', {
    name: 'Check before running it again',
  });
  await expect(verify).toBeVisible();
  await verify.click();

  const heading = page.locator(`[${DATA_DETAIL_HEADING}]`);
  await expect(heading).toBeVisible();
  await expect(heading).toHaveText('Customer review');
  await expect(heading).toHaveAttribute('tabindex', '-1');
  await expect(heading).toBeFocused();
  await expect(
    page.getByRole('heading', { name: 'Customer review', level: 2 }),
  ).toBeVisible();

  const primary = page.locator(
    `[${DATA_VERIFICATION_ACTION}="reviewed"]`,
  );
  await expect(primary).toBeVisible();
  const contrast = await page.evaluate(
    ({ primarySelector }) => {
      const parse = (value: string): [number, number, number] => {
        const numbers = value.match(/[\d.]+/g)?.map(Number) ?? [];
        return [numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0];
      };
      const luminance = (value: string): number => {
        const [r, g, b] = parse(value).map((channel) => {
          const normalized = channel / 255;
          return normalized <= 0.04045
            ? normalized / 12.92
            : ((normalized + 0.055) / 1.055) ** 2.4;
        }) as [number, number, number];
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const ratio = (fg: string, bg: string): number => {
        const first = luminance(fg);
        const second = luminance(bg);
        return (Math.max(first, second) + 0.05)
          / (Math.min(first, second) + 0.05);
      };
      const backgroundFor = (node: Element): string => {
        let candidate: Element | null = node;
        while (candidate !== null) {
          const background = getComputedStyle(candidate).backgroundColor;
          const channels = background.match(/[\d.]+/g)?.map(Number) ?? [];
          if ((channels[3] ?? 1) > 0) return background;
          candidate = candidate.parentElement;
        }
        return getComputedStyle(document.body).backgroundColor;
      };
      const measure = (): {
        value: number;
        label: number;
        action: number;
      } => {
        const value = document.querySelector(
          '.col-explorer-detail-field dd',
        );
        const label = document.querySelector(
          '.col-explorer-detail-field dt',
        );
        const action = document.querySelector(primarySelector);
        if (value === null || label === null || action === null) {
          throw new Error('verification contrast targets missing');
        }
        const actionStyle = getComputedStyle(action);
        return {
          value: ratio(getComputedStyle(value).color, backgroundFor(value)),
          label: ratio(getComputedStyle(label).color, backgroundFor(label)),
          action: ratio(actionStyle.color, actionStyle.backgroundColor),
        };
      };
      const dark = measure();
      document.documentElement.dataset.theme = 'light';
      const light = measure();
      document.documentElement.dataset.theme = 'dark';
      return {
        dark,
        light,
        pageWidth: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
      };
    },
    {
      primarySelector:
        `[${DATA_VERIFICATION_ACTION}="reviewed"]`,
    },
  );
  for (const theme of [contrast.light, contrast.dark]) {
    expect(theme.value).toBeGreaterThanOrEqual(4.5);
    expect(theme.label).toBeGreaterThanOrEqual(4.5);
    expect(theme.action).toBeGreaterThanOrEqual(4.5);
  }
  expect(contrast.pageWidth).toBeLessThanOrEqual(contrast.viewport);
  const rawDetails = page.locator('.col-explorer-detail-raw');
  const rawSummary = page.locator('.col-explorer-detail-raw summary');
  expect((await rawSummary.boundingBox())?.height).toBeGreaterThanOrEqual(36);
  await rawSummary.focus();
  await page.keyboard.press('Enter');
  await expect(rawDetails).toHaveAttribute('open', '');
  await expect(rawSummary).toBeFocused();
  expect(await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  )).toBe(true);

  await primary.click();
  await expect(page).toHaveURL(
    /#chat\/session\/chat_1\/plan\/plan_email_1/,
  );
  await expect(page.locator('[data-recued-chat-route]')).toBeVisible();
  const runOutcome = page.locator('.chat-data-verification-run');
  await expect(runOutcome).toHaveText('See how the run ended →');
  expect((await runOutcome.boundingBox())?.height).toBeGreaterThanOrEqual(36);
  await runOutcome.focus();
  await expect(runOutcome).toBeFocused();
});
