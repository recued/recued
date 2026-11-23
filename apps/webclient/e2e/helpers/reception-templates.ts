import { expect, type Page } from '@playwright/test';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { IntakeFormTemplate, ReceptionConfigTemplate, ReceptionTemplateListResult } from '@recued/contracts';
import { installReceptionEndpointsFixture } from '../fixtures/reception-endpoints.js';
import { installReceptionTemplatesFixture } from '../fixtures/reception-templates.js';
import { goEndpoints } from './reception-endpoints.js';

export const gallery = (page: Page) => page.locator('.reception-templates-browser');
export const galleryIntent = (page: Page) => gallery(page).locator('[data-recued-intent-input]');
export async function installTemplatesPage(page: Page) {
  const foundation = resolve(import.meta.dirname, '../../../../community/packs/recued-core/personal-organizer-foundation');
  const load = async (directory: string) => Promise.all((await readdir(directory)).filter(name => name.endsWith('.json')).sort().map(async name => JSON.parse(await readFile(resolve(directory, name), 'utf8'))));
  const templates = await load(resolve(foundation, 'templates')) as IntakeFormTemplate[];
  const config_templates = await load(resolve(foundation, 'config-templates')) as ReceptionConfigTemplate[];
  const catalog: ReceptionTemplateListResult = { templates, config_templates,
    pack_templates: [{ template: { ...templates[0]!, template_ref: 'pack:studio/project-intake/intake/project', name: 'Project intake from Studio' },
      publisher: 'studio', pack_slug: 'project-intake', pack_name: 'Studio project intake', pack_version: 2 }],
    pack_templates_unavailable: [{ template_ref: 'pack:studio/old-intake/intake/retired', pack_slug: 'old-intake', reason: 'version_invalid' }],
  };
  await page.addInitScript({ content: `(${installReceptionEndpointsFixture.toString()})();(${installReceptionTemplatesFixture.toString()})(${JSON.stringify(catalog)});` });
  const policy = (await readFile(resolve(import.meta.dirname, '../../public/_headers'), 'utf8')).match(/^\s*Content-Security-Policy:\s*(.+)$/m)![1]!;
  await page.route('**/full-app-harness.html*', async route => { const response = await route.fetch(); await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': policy } }); });
}
export async function openTemplates(page: Page, extra = '') {
  await goEndpoints(page, extra);
  await page.locator('[data-action="reception-open-templates"]:visible').click();
  await expect(gallery(page)).toBeVisible();
}
