import { expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildViewAsVisitorPanel, type PacketDeclaration, type ReceptionEndpointKind, type ReceptionPageConfig } from '@recued/contracts';
import { installReceptionEndpointsFixture } from '../fixtures/reception-endpoints.js';
import { installReceptionAuthoringFixture } from '../fixtures/reception-authoring.js';
import { goEndpoints } from './reception-endpoints.js';
export const authoringRoot = (page: Page) => page.locator('[data-reception-authoring-section]');
export const authoringField = (page: Page, key: string) => authoringRoot(page).locator(`[data-field-key="${key}"]`);
export const authoringAction = (page: Page, action: string) => authoringRoot(page).locator(`[data-action="reception-form-${action}"]`);
export async function installAuthoringPage(page: Page, afterFixture = '') {
  const config: ReceptionPageConfig = { display_overrides: { display_name: 'Morgan Studio', tagline: 'Design and project planning', tz_label: 'Pacific Time', preferred_contact_methods: ['email'] },
    sections_enabled: { contact_card: true, contact_methods: true, availability_cta: true, intake_cta: true, drop_cta: true, custom_links: true, link_buttons: true },
    linked_endpoints: {}, custom_links: [{ label: 'Portfolio', url: 'https://example.test/portfolio' }], link_buttons: [{ label: 'Project guide', url: 'https://example.test/project', description: 'How we work together' }], trust_footer_enabled: true, inbox_fanout_mode: 'approval' };
  const packets: Partial<Record<ReceptionEndpointKind, PacketDeclaration>> = {
    scheduling_link: { packet_kind: 'scheduling_link_packet', source_query_ref: { kind: 'data.calendar.combined' } },
    intake_form: { packet_kind: 'intake_form_packet', source_query_ref: { kind: 'reception_form_definition', form_definition_id: 'customer-project' } },
    drop_link: { packet_kind: 'drop_link_packet', source_query_ref: { kind: 'reception_drop_config', drop_config_id: 'documents' } },
    approval_link: { packet_kind: 'approval_link_packet', source_query_ref: { kind: 'reception_approval_intent', intent_id: 'project-approval' } },
  };
  const panels = Object.fromEntries(Object.entries(packets).map(([kind, packet]) => [kind, buildViewAsVisitorPanel({ kind: kind as ReceptionEndpointKind, packet_declaration: packet!, expires_at: null, now: 1_700_000_000_000 })]));
  await page.addInitScript({ content: `(${installReceptionEndpointsFixture.toString()})();(${installReceptionAuthoringFixture.toString()})(${JSON.stringify({ page: config, panels })});${afterFixture}` });
  const policy = (await readFile(resolve(import.meta.dirname, '../../public/_headers'), 'utf8')).match(/^\s*Content-Security-Policy:\s*(.+)$/m)![1]!;
  await page.route('**/full-app-harness.html*', async route => { const response = await route.fetch(); await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': policy } }); });
}
export async function goAuthoring(page: Page, kind: ReceptionEndpointKind = 'scheduling_link', extra = '', edit = false) {
  await goEndpoints(page, extra, `${edit ? 'edit' : 'new'}/${kind}`);
  await expect(authoringRoot(page)).toBeVisible();
}
export async function fillAuthoring(page: Page, kind: ReceptionEndpointKind = 'scheduling_link') {
  await authoringField(page, 'display_name').fill('Customer project');
  if (kind === 'scheduling_link') {
    await authoringField(page, 'available_window_definition.tz').fill('America/Los_Angeles');
    await authoringRoot(page).getByRole('button', { name: 'Add Availability windows row', exact: true }).click();
  }
  if (kind === 'intake_form') {
    await authoringField(page, 'form_definition.form_definition_id').fill('customer-project');
    await authoringRoot(page).getByRole('button', { name: 'Add Form fields row', exact: true }).click();
    await authoringRoot(page).locator('[data-repeater-key="form_definition.fields"][data-row-field="name"]').fill('project_name');
    await authoringRoot(page).locator('[data-repeater-key="form_definition.fields"][data-row-field="label"]').fill('Project name');
  }
  if (kind === 'approval_link') { await authoringField(page, 'prompt').fill('Please approve the proposed project scope.'); await authoringField(page, 'context_raw.summary').fill('Three drawings, followed by a planning call.'); await authoringField(page, 'on_action.target_id').fill('customer-project'); }
  if (kind === 'reception_page') await authoringField(page, 'tz_label').fill('Pacific Time');
}
