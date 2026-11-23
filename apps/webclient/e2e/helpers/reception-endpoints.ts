import { expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { HARNESS_ORIGIN } from './harness-origin.js';
import { installReceptionEndpointsFixture } from '../fixtures/reception-endpoints.js';

export const CONSULTATION = 'consultation-0123456789-0123456789-0123456789-0123456789';
export const endpointPage = (page: Page) => page.locator('[data-reception-shell-page-main]');
export const endpointRow = (page: Page, id = CONSULTATION) => endpointPage(page).locator(`.reception-row[data-endpoint-id="${id}"]`);
export const endpointPrompt = (page: Page) => page.locator('[data-reception-shell-slot="prompts"]');
export const endpointCount = (page: Page, method: string) => page.evaluate(method =>
  (window as any).__endpoints.calls.filter((call: { method: string }) => call.method === method).length, method);
export const holdEndpoint = (page: Page, method: string) => page.evaluate(method => (window as any).__endpoints.held.push(method), method);
export const releaseEndpoint = (page: Page, method: string, failed = false) => page.evaluate(({ method, failed }) => {
  const state = (window as any).__endpoints; state.held = state.held.filter((m: string) => m !== method); state.release(method, failed);
}, { method, failed });
export const failEndpoint = (page: Page, method?: string) => page.evaluate(method => { (window as any).__endpoints.failing = method ? [method] : []; }, method);
export async function installEndpointPage(page: Page) {
  await page.addInitScript({ content: `(${installReceptionEndpointsFixture.toString()})();` });
  const policy = (await readFile(resolve(import.meta.dirname, '../../public/_headers'), 'utf8')).match(/^\s*Content-Security-Policy:\s*(.+)$/m)![1]!;
  await page.route('**/full-app-harness.html*', async route => { const response = await route.fetch(); await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': policy } }); });
}
export async function goEndpoints(page: Page, extra = '', id?: string) {
  await page.goto(`${HARNESS_ORIGIN}/full-app-harness.html?server_profiles=multiple${extra ? '&' + extra : ''}#reception/endpoints${id ? '/' + id : ''}`);
  await page.waitForFunction(() => window.__app?.ready === true);
}
export async function loadedEndpoints(page: Page) {
  await goEndpoints(page); await expect(endpointRow(page)).toBeVisible();
  await expect(endpointPage(page).getByRole('status', { name: 'Working…' })).toHaveCount(0);
}
