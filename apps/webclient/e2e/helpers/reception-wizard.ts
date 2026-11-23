import {expect,type Page} from '@playwright/test';
import type {LaunchWizardStepId} from '@recued/contracts';
import {installAuthoringPage} from './reception-authoring.js';
import {installReceptionWizardFixture} from '../fixtures/reception-wizard.js';
import {goEndpoints} from './reception-endpoints.js';
export const wizard=(page:Page)=>page.locator('[data-reception-wizard-section]');
export const wizardField=(page:Page,key:string)=>wizard(page).locator(`[data-field-key="${key}"]`);
export const wizardAction=(page:Page,action:string)=>wizard(page).locator(`[data-action="reception-wizard-${action}"]`);
export async function installWizardPage(page:Page){await installAuthoringPage(page,`(${installReceptionWizardFixture.toString()})();`);}
export async function goWizard(page:Page,extra=''){await goEndpoints(page,'authoring_new_page=1'+(extra?'&'+extra:''),'setup');await expect(wizard(page)).toBeVisible();}
export async function wizardStep(page:Page,step:LaunchWizardStepId){await wizard(page).locator(`.reception-wizard-stepper [data-action="reception-wizard-goto-step"][data-step-id="${step}"]`).click();}
export async function fillWizard(page:Page){
  await wizardStep(page,'reception_page');await wizardField(page,'display_name').fill('Studio Reception');await wizardField(page,'tagline').fill('Thoughtful project planning');await wizardField(page,'tz_label').fill('Pacific Time');
  await wizardStep(page,'scheduling_link');await wizardField(page,'display_name').fill('Project consultation');await wizardField(page,'available_window_definition.tz').fill('America/Los_Angeles');
  await wizard(page).getByRole('button',{name:'Add Availability windows row',exact:true}).click();
  await wizardStep(page,'intake_form');await wizardField(page,'display_name').fill('Project inquiry');await wizardField(page,'form_definition.form_definition_id').fill('customer-project');
  await wizard(page).getByRole('button',{name:'Add Form fields row',exact:true}).click();
  await wizard(page).locator('[data-repeater-key="form_definition.fields"][data-row-field="name"]').fill('project_name');
  await wizard(page).locator('[data-repeater-key="form_definition.fields"][data-row-field="label"]').fill('Project name');
  await wizardStep(page,'drop_link');await wizardField(page,'display_name').fill('Project documents');
  await wizardStep(page,'share');
}
