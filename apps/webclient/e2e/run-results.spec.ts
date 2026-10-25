import { expect, test, type Page } from '@playwright/test';
import type { RunAnchorStatus, RunDetail, ServerExecuteResponse } from '@recued/contracts';
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
  const back = page.getByRole('link', { name: 'Back to history' });
  const backBox = await back.boundingBox();
  expect(backBox?.height).toBeGreaterThanOrEqual(44);
  await expect(page.locator('[data-recued-logs-row]')).toHaveCount(0);

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

type RunHandoffSurface = 'recipes' | 'packs' | 'approvals';
const HANDOFF_PROPOSAL = 'pap_11111111-1111-4111-8111-111111111111';
const handoffSource = (surface: RunHandoffSurface) => surface === 'recipes' ? '#recipes/autorun-live-1'
  : surface === 'packs' ? '#packs/installed-mail' : `#approvals/preapproval/${HANDOFF_PROPOSAL}`;
const handoffBackLabel = (surface: RunHandoffSurface) => surface === 'recipes' ? 'Back to Recipe'
  : surface === 'packs' ? 'Back to Pack' : 'Back to approval review';

/** Page-local, reloadable recorded anchors. The normal transport and harness
 * stay unchanged; navigation must never create a new execution or decision. */
const installRunHandoffFixture = async (page: Page, status: RunAnchorStatus = 'succeeded') => {
  await page.addInitScript(({ status }) => {
    const now = 1_700_000_000_000;
    const run = (runId: string): RunDetail => ({
      audit: { run_id: runId, recipe_id: 'calendar/schedule-review', recipe_hash: 'handoff-hash',
        started_at: now - 4_000, finished_at: now - 2_000, duration_ms: 2_000, status,
        origin: { actor: 'user_self', label: 'user_self', channel: 'user' },
        trigger_source: 'manual', instance_id: 'handoff-server', errors: [],
        run_yield: { steps_run: 1, steps_skipped: 0, items_total: 1, items_failed: 0 } },
      approvals: { checkpoints: [], outcome: 'allow' }, errors: [],
      links: [{ entity_id: 'calendar:event-1', kind: 'execution.write', ts: now - 2_500 }],
      gateway: { policy_result: 'allowed', per_call_trace: [] },
    });
    window.__connectionsFixture = async (method, raw) => {
      const args = (raw ?? {}) as { recipe_id?: string; run_id?: string };
      if (method === 'execute' && ['autorun-live-1', 'installed-mail-digest'].includes(args.recipe_id ?? '')) {
        const result: ServerExecuteResponse = { run_id: 'run-handoff', recipe_id: args.recipe_id!, recipe_hash: 'handoff-hash',
          success: true, output: { render: [], sidebar: [] }, steps: [], errors: [], duration_ms: 7 };
        return { result };
      }
      if (method === 'execution.get') return args.run_id === 'run-handoff' || args.run_id === 'original-run'
        ? { result: { run: run(args.run_id) } }
        : { error: { code: 'not_found', message: 'This recorded run was not found.' } };
      return undefined;
    };
  }, { status });
};

const assertHandoffDidNotDecide = async (page: Page) => {
  for (const method of ['approval.resolve', 'preapproval.decide', 'preapproval.continue', 'local_undo.decide', 'chat.plan.approve', 'chat.send']) {
    expect(await page.evaluate(name => window.__app.rpcCallCount(name), method)).toBe(0);
  }
};

for (const surface of ['recipes', 'packs', 'approvals'] as const) {
  for (const width of [390, 768, 1280]) {
    for (const theme of ['light', 'dark'] as const) {
      test(`Run handoff returns from item checks to ${surface} at ${width}px in ${theme}`, async ({ page }) => {
        await installRunHandoffFixture(page, surface === 'approvals' ? 'in_doubt' : 'succeeded');
        await page.setViewportSize({ width, height: 900 });
        const query = surface === 'recipes' ? 'recipes=installed&recipe_default_run=1&recipe_result=copyable'
          : surface === 'packs' ? 'packs=installed&recipe_result=copyable' : 'preapproval=continuation-uncertain';
        await page.goto(`${HARNESS_URL}?journey=verification&${query}${handoffSource(surface)}`);
        await page.waitForFunction(() => window.__app?.ready === true);
        await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
        if (surface === 'recipes') {
          await page.locator('[data-recued-recipes-action="run-defaults"]').click();
        } else if (surface === 'packs') {
          await page.locator('[data-recued-pack-app-operation="installed-mail-digest"]').click();
          const dialog = page.getByRole('dialog', { name: 'Run a Recipe' });
          await dialog.getByRole('button', { name: 'Run', exact: true }).click();
          await expect(dialog.getByRole('status')).toContainText('Run completed');
          await dialog.getByRole('button', { name: 'Close', exact: true }).click();
        }
        const entry = page.locator('[data-recued-run-review-link]').first();
        await expect(entry).toHaveText('Review run');
        const target = (await entry.getAttribute('href'))!;
        const runId = surface === 'approvals' ? 'original-run' : 'run-handoff';
        expect(target).toBe(`#logs/${runId}/return/${handoffSource(surface).slice(1)}`);
        const executeCalls = await page.evaluate(() => window.__app.rpcCallCount('execute'));
        await entry.focus(); await page.keyboard.press('Enter');
        await expect(page.locator('[data-recued-logs-detail]')).toContainText(runId);
        await expect(page.locator(`[${LOGS_OUTCOME}]`)).toBeFocused();
        const back = page.getByRole('link', { name: handoffBackLabel(surface), exact: true });
        await expect(back).toHaveAttribute('href', handoffSource(surface));
        expect((await back.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        if (surface === 'approvals') {
          await expect(page.locator(`[${LOGS_OUTCOME}]`)).toContainText('Somebody needs to check what happened');
          await expect(page.getByRole('button', { name: /retry|continue/i })).toHaveCount(0);
        }
        await page.screenshot({ path: test.info().outputPath(`run-handoff-${surface}-${width}-${theme}.png`) });
        await page.reload();
        await expect(back).toHaveAttribute('href', handoffSource(surface));
        await page.locator(`[${LOGS_AFFECTED_ITEMS}] a`).first().click();
        await expect(page.locator(`[${DATA_DETAIL_HEADING}]`)).toHaveText('Customer review');
        await page.reload();
        const returnToRun = page.getByRole('link', { name: 'Back to run outcome', exact: true });
        await expect(returnToRun).toHaveAttribute('href', target);
        await returnToRun.focus(); await page.keyboard.press('Enter');
        await expect(back).toHaveAttribute('href', handoffSource(surface));
        expect(await page.evaluate(() => window.__app.rpcCallCount('execute'))).toBe(0);
        await assertHandoffDidNotDecide(page);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await back.focus(); await page.keyboard.press('Enter');
        await expect.poll(() => new URL(page.url()).hash).toBe(handoffSource(surface));
        const workspace = page.locator(surface === 'recipes' ? '[data-recued-recipes-route]'
          : surface === 'packs' ? '[data-recued-packs-route]' : '[data-recued-preapproval-route]');
        await expect.poll(() => workspace.evaluate(root => root.contains(document.activeElement))).toBe(true);
        await assertHandoffDidNotDecide(page);
        expect(executeCalls).toBeGreaterThanOrEqual(surface === 'approvals' ? 0 : 1);
      });
    }
  }
}

test('Run handoff keeps a missing record addressable and retries only its read', async ({ page }) => {
  await installRunHandoffFixture(page);
  await page.goto(`${HARNESS_URL}?journey=verification#logs/run-missing/return/packs/installed-mail`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(page.getByRole('link', { name: 'Back to Pack', exact: true })).toHaveAttribute('href', '#packs/installed-mail');
  const before = await page.evaluate(() => window.__app.rpcCallCount('execution.get'));
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('execution.get'))).toBe(before + 1);
  await expect(page.locator('[data-local-update-undo]')).toHaveCount(0);
  expect(await page.evaluate(() => window.__app.rpcCallCount('execute'))).toBe(0);
  await assertHandoffDidNotDecide(page);
});

test('Run handoff from Chat keeps the exact action and uses the shared review label', async ({ page }) => {
  await installRunHandoffFixture(page);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`${HARNESS_URL}?chat=session&local_mutation_receipt=live&journey=verification#chat/session/chat_1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  const card = page.locator('[data-recued-chat-route-plan-card][data-plan-id="plan_local_confirmed"]');
  await expect(card).toBeVisible();
  await page.evaluate(() => window.__app.fireMessage({ type: 'server_event', event: {
    kind: 'chat.tool_call_completed', session_id: 'chat_1', turn_id: 'execution_local', tool_name: 'calendar.update',
    plan_id: 'plan_local_confirmed', tier: 1, status: 'ok', run_id: 'run-handoff', cursor: 100,
    plan_execution: { status: 'completed', turn_id: 'execution_local', run_id: 'run-handoff' },
  } }));
  const link = card.getByRole('link', { name: 'Review this run in Logs', exact: true });
  await expect(link).toHaveText('Review run');
  await link.focus(); await page.keyboard.press('Enter');
  await expect(page.locator('[data-recued-logs-detail]')).toContainText('run-handoff');
  const back = page.getByRole('link', { name: 'Back to the originating Chat action', exact: true });
  await expect(back).toHaveAttribute('href', '#chat/session/chat_1/plan/plan_local_confirmed/answer/message_local_confirmed');
  await back.click(); await expect(card).toBeVisible();
  await assertHandoffDidNotDecide(page);
});

test('Run handoff reuses recorded undo review without approving a reverse change', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?journey=verification&local_mutation_receipt=1#logs/run-verify/return/recipes/autorun-live-1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  const host = page.locator('[data-local-update-undo]').first();
  await host.getByRole('button', { name: 'Review undo', exact: true }).click();
  await expect(host.getByRole('heading', { name: 'Review reverse changes' })).toBeFocused();
  await expect(host.locator('[data-local-update-undo-preview]')).toContainText('First row');
  await expect(page.getByRole('link', { name: 'Back to Recipe', exact: true })).toHaveAttribute('href', '#recipes/autorun-live-1');
  expect(await page.evaluate(() => window.__app.rpcCallCount('local_undo.review'))).toBe(1);
  await assertHandoffDidNotDecide(page);
});

test('Run handoff names the recipe-scoped fallback when an approval has no run anchor', async ({ page }) => {
  await page.goto(`${HARNESS_URL}?attention=pending#approvals`);
  await page.waitForFunction(() => window.__app?.ready === true);
  const card = page.locator('[data-recued-approvals-focus="approval-attention-1"]');
  const link = card.getByRole('link', { name: /Recipe run history for/ });
  await expect(link).toHaveAttribute('href', '#logs/recipe/crm%2Fupdate-contact');
  await expect(card.locator('[data-recued-run-review-link]')).toHaveCount(0);
  await assertHandoffDidNotDecide(page);
});

test('Run handoff keeps a newer keyboard focus choice while its source loads', async ({ page }) => {
  await installRunHandoffFixture(page);
  await page.goto(`${HARNESS_URL}?recipes=installed&recipe_default_run=1&journey=verification#logs/run-handoff/return/recipes/autorun-live-1`);
  await page.waitForFunction(() => window.__app?.ready === true);
  await expect(page.locator('[data-recued-logs-detail]')).toContainText('run-handoff');
  const before = await page.evaluate(() => window.__app.rpcCallCount('recipe.list'));
  await page.evaluate(() => window.__app.holdRpcResponses?.('recipe.list'));
  const back = page.getByRole('link', { name: 'Back to Recipe', exact: true });
  await back.focus(); await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__app.rpcCallCount('recipe.list'))).toBeGreaterThan(before);
  await page.keyboard.press('Tab');
  const chosen = await page.locator(':focus').elementHandle();
  expect(chosen).not.toBeNull();
  expect(await page.evaluate(() => window.__app.releaseRpcResponses?.('recipe.list'))).toBeGreaterThan(0);
  await expect(page.locator('[data-recued-recipes-detail-heading]')).toBeVisible();
  expect(await chosen!.evaluate(node => node === document.activeElement)).toBe(true);
  await assertHandoffDidNotDecide(page);
});
