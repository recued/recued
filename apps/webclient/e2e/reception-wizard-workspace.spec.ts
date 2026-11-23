import {expect,test,type Page} from '@playwright/test';
import {applyPreset} from '@recued/contracts';
import {installWizardPage,goWizard,fillWizard,wizard,wizardField,wizardAction,wizardStep} from './helpers/reception-wizard.js';
import {endpointCount,endpointPage,endpointPrompt,holdEndpoint,releaseEndpoint,failEndpoint} from './helpers/reception-endpoints.js';
test.beforeEach(async({page})=>installWizardPage(page));
const pending=(page:Page,method:string)=>expect.poll(()=>page.evaluate(m=>(window as any).__endpoints.pending(m),method)).toBe(1);
async function ready(page:Page,extra=''){await goWizard(page,extra);await fillWizard(page);}

test('setup creates the reviewed disabled links and captures every one-shot share',async({page})=>{
 await ready(page);await wizardStep(page,'reception_page');await wizardField(page,'tagline').fill('');await wizardStep(page,'share');await wizardAction(page,'finish').click();await expect(wizard(page)).toHaveCount(0);
 expect(await page.evaluate(()=>(window as any).__authoring.saves[0].display_overrides.tagline)).toBe('');
 const created=await page.evaluate(()=>(window as any).__authoring.created);expect(created.map((c:any)=>c.kind)).toEqual(['scheduling_link','intake_form','drop_link']);
 expect(await endpointCount(page,'reception.page.upsert')).toBe(1);expect(await endpointCount(page,'reception.endpoint.create')).toBe(3);expect(await endpointCount(page,'reception.endpoint.enable')).toBe(0);expect(await endpointCount(page,'execute')).toBe(0);
 expect(await page.evaluate(()=>(window as any).__endpoints.calls.filter((c:any)=>c.method.startsWith('exposure.')&&c.method!=='exposure.get'))).toEqual([]);
 for(let i=1;i<=3;i++){await endpointPage(page).locator(`.reception-row[data-endpoint-id="created-${i}"] [data-action="reception-open-detail"]`).click();await expect(endpointPage(page).locator('.reception-share-snippet').first()).toContainText('created-once');await endpointPage(page).locator('[data-action="reception-close-detail"]').click();}
});

test('initial access information is present before any form validates',async({page})=>{
 await goWizard(page);await expect(wizard(page).getByRole('link',{name:'Review public access',exact:true})).toBeVisible();
 await expect(wizard(page)).toContainText('disabled');
 expect(await page.evaluate(()=>(window as any).__endpoints.calls.filter((c:any)=>c.method.startsWith('exposure.')&&c.method!=='exposure.get'))).toEqual([]);
});

test('a live access update preserves focus on the settings link',async({page})=>{
 await goWizard(page);const link=wizard(page).getByRole('link',{name:'Review public access',exact:true});await link.focus();
 const base=applyPreset('lan_only',{acknowledged:false});const resolution={...base,reception:{...base.reception,public:true}};
 await page.evaluate(resolution=>window.__app.fireMessage({type:'server_event',event:{kind:'exposure_changed',resolution,derived_preset_label:'custom',public_mcp_acknowledgement:{acknowledged:false},changed_at:1_700_000_000_010,changed_by_client_id:'device-other',cursor:1_700_000_000_010}}),resolution);
 await expect(wizard(page)).toContainText('Public Reception access is enabled');await expect(link).toBeFocused();
});

test('the narrow step rail remains reachable with the keyboard',async({page,browserName})=>{
 await page.setViewportSize({width:280,height:850});await goWizard(page);
 const steps=wizard(page).locator('.reception-wizard-stepper');await steps.locator('button').first().focus();
 // This WebKit lane uses Safari's Option-Tab policy for native controls.
 const nextKey=browserName==='webkit'?'Alt+Tab':'Tab';
 for(let i=0;i<6;i++)await page.keyboard.press(nextKey);
 await expect(steps.locator('[data-step-id="share"]')).toBeFocused();
 await expect.poll(()=>steps.evaluate(n=>n.scrollLeft)).toBeGreaterThan(0);
 await page.keyboard.press('Enter');await expect(wizard(page).locator('[data-current-step="share"]')).toBeVisible();
 await expect(wizard(page).locator('.reception-wizard-current-title')).toBeFocused();
});

test('a draft survives declined navigation and can be discarded explicitly',async({page})=>{
 await goWizard(page);await wizardStep(page,'reception_page');await wizardField(page,'display_name').fill('My studio');
 page.once('dialog',d=>{expect(d.message()).toContain('unsaved');void d.dismiss();});await page.locator('.reception-wizard-section-back').click();
 await expect(page).toHaveURL(/#reception\/endpoints\/setup$/);await expect(wizardField(page,'display_name')).toHaveValue('My studio');
 page.once('dialog',d=>void d.accept());await page.locator('.reception-wizard-section-back').click();await expect(wizard(page)).toHaveCount(0);
 expect(await endpointCount(page,'reception.page.upsert')).toBe(0);
});

test('validation is announced and its first correction preserves focus and selection',async({page})=>{
 await goWizard(page);await wizardStep(page,'share');await wizardAction(page,'finish').click();await expect(wizard(page).getByRole('alert')).toBeFocused();
 await wizardStep(page,'reception_page');const name=wizardField(page,'display_name');await name.fill('Customer studio');await expect(name).toBeFocused();
 await name.evaluate(n=>(n as HTMLInputElement).setSelectionRange(1,6,'backward'));await page.keyboard.insertText('ustom');await expect(name).toHaveValue('Customer studio');
 expect(await endpointCount(page,'reception.page.upsert')).toBe(0);
});

test('the optional file step can be skipped and put back without losing other drafts',async({page})=>{
 await ready(page);await wizardStep(page,'drop_link');await wizardAction(page,'toggle-drop-link').click();
 await expect(wizard(page).locator('[data-current-step="view_as_visitor"]')).toBeVisible();
 await wizard(page).getByRole('button',{name:'Include file uploads',exact:true}).click();await wizardStep(page,'drop_link');await expect(wizardField(page,'display_name')).toHaveValue('Project documents');
 await wizardAction(page,'toggle-drop-link').click();await wizardStep(page,'share');await wizardAction(page,'finish').click();await expect(wizard(page)).toHaveCount(0);
 expect(await page.evaluate(()=>(window as any).__authoring.created.map((c:any)=>c.kind))).toEqual(['scheduling_link','intake_form']);
});

test('intake destination changes reveal their mapping controls and retain focus',async({page})=>{
 await goWizard(page);await wizardStep(page,'intake_form');const target=wizardField(page,'submission_processing_rule.target_kind');await target.focus();await target.selectOption('contact');
 await expect(wizard(page).locator('[data-field-key^="submission_processing_rule.contact_mapping."]').first()).toBeVisible();await expect(target).toBeFocused();
});

test('repeater and step navigation put keyboard focus on their new content',async({page})=>{
 await goWizard(page);await wizardStep(page,'scheduling_link');await wizard(page).getByRole('button',{name:'Add Availability windows row',exact:true}).click();
 await expect(wizard(page).locator('[data-repeater-key="available_window_definition.explicit_windows"][data-row-field="day_of_week"]')).toBeFocused();
 await expect(wizard(page).locator('[data-repeater-key="available_window_definition.explicit_windows"][data-row-field="day_of_week"]')).toBeInViewport();
 await wizardAction(page,'next').click();await expect(wizard(page).locator('.reception-wizard-current-title')).toBeFocused();
});

test('visitor preview is sandboxed and failed previews can be retried without writes',async({page})=>{
 await ready(page);await wizardStep(page,'view_as_visitor');await failEndpoint(page,'reception.endpoint.preview_draft');await wizard(page).getByRole('button',{name:'Preview scheduling link',exact:true}).click();
 await expect(wizard(page).getByRole('alert')).toBeVisible();await failEndpoint(page);await wizard(page).getByRole('button',{name:'Preview scheduling link',exact:true}).click();
 const preview=wizard(page).getByRole('region',{name:'Visitor preview',exact:true});await expect(preview).toBeFocused();await expect(preview.locator('iframe')).toHaveAttribute('sandbox','');
 expect(await endpointCount(page,'reception.page.upsert')).toBe(0);expect(await endpointCount(page,'reception.endpoint.create')).toBe(0);
});

test('failed page save retains its draft and a retry creates each link once',async({page})=>{
 await ready(page);await failEndpoint(page,'reception.page.upsert');await wizardAction(page,'finish').click();await expect(wizard(page).getByRole('alert')).toBeVisible();
 await failEndpoint(page);await wizardAction(page,'finish').click();await expect(wizard(page)).toHaveCount(0);expect(await endpointCount(page,'reception.endpoint.create')).toBe(3);
});

test('a middle create failure resumes after acknowledged writes instead of duplicating them',async({page})=>{
 await ready(page,'wizard_fail_create_at=2');await wizardAction(page,'finish').click();await expect(wizard(page).getByRole('alert')).toBeVisible();
 await expect(wizard(page)).toContainText('1 of 3 links created');await wizardAction(page,'finish').click();await expect(wizard(page)).toHaveCount(0);
 expect(await endpointCount(page,'reception.page.upsert')).toBe(1);expect(await endpointCount(page,'reception.endpoint.create')).toBe(4);
 expect(await page.evaluate(()=>(window as any).__authoring.created.map((c:any)=>c.kind))).toEqual(['scheduling_link','intake_form','drop_link']);
});

test('a partial failure retains the first one-shot share after leaving setup',async({page})=>{
 await ready(page,'wizard_fail_create_at=2');await wizardAction(page,'finish').click();await expect(wizard(page).getByRole('alert')).toBeVisible();
 page.once('dialog',d=>void d.accept());await page.locator('.reception-wizard-section-back').click();await expect(wizard(page)).toHaveCount(0);
 await endpointPage(page).locator('.reception-row[data-endpoint-id="created-1"] [data-action="reception-open-detail"]').click();await expect(endpointPage(page).locator('.reception-share-snippet').first()).toContainText('created-once');
});

for(const phase of ['preview_draft','create']as const)test(`pending ${phase} remains owned and accepted departure stops unsent writes`,async({page})=>{
 await ready(page);const method='reception.endpoint.'+phase;await holdEndpoint(page,method);await wizardAction(page,'finish').click();await pending(page,method);
 await expect(wizardAction(page,'finish')).toBeDisabled();await wizardAction(page,'finish').evaluate(n=>n.dispatchEvent(new MouseEvent('click',{bubbles:true})));
 expect(await endpointCount(page,'reception.page.upsert')).toBe(1);
 page.once('dialog',d=>{expect(d.message()).toContain('Reception action');void d.dismiss();});await page.locator('.reception-wizard-section-back').click();
 await expect(page).toHaveURL(/#reception\/endpoints\/setup$/);await expect(wizardAction(page,'finish')).toBeDisabled();
 page.once('dialog',d=>{expect(d.message()).toContain('Reception action');void d.accept();});await page.locator('.reception-wizard-section-back').click();await expect(wizard(page)).toHaveCount(0);
 await releaseEndpoint(page,method);await expect.poll(()=>page.locator('[data-recued-account-menu-trigger]').getAttribute('aria-label')).not.toMatch(/\bactions? needs?\b/);
 expect(await endpointCount(page,'reception.endpoint.create')).toBe(phase==='create'?1:0);
 if(phase==='create'){await endpointPage(page).locator('.reception-row[data-endpoint-id="created-1"] [data-action="reception-open-detail"]').click();await expect(endpointPage(page).locator('.reception-share-snippet').first()).toContainText('created-once');}
});

test('a late visitor preview does not steal Account focus',async({page})=>{
 await ready(page);await wizardStep(page,'view_as_visitor');await holdEndpoint(page,'reception.endpoint.preview_draft');await wizard(page).getByRole('button',{name:'Preview scheduling link',exact:true}).click();await pending(page,'reception.endpoint.preview_draft');
 await page.locator('[data-recued-account-menu-trigger]').click();const close=page.locator('[data-recued-account-menu-close]');await close.focus();await releaseEndpoint(page,'reception.endpoint.preview_draft');
 await expect(wizard(page).getByRole('region',{name:'Visitor preview',exact:true})).toBeVisible();await expect(close).toBeFocused();
});

test('enabling a link after setup updates the open detail controls',async({page})=>{
 await ready(page);await wizardAction(page,'finish').click();await expect(wizard(page)).toHaveCount(0);
 await endpointPage(page).locator('.reception-row[data-endpoint-id="created-1"] [data-action="reception-open-detail"]').click();
 await endpointPage(page).locator('.reception-detail > .rx-action-bar [data-action="reception-enable"]').click();
 await expect(endpointPage(page).locator('.reception-detail > .rx-action-bar [data-action="reception-rotate-token"]')).toBeVisible();
 await endpointPage(page).locator('.reception-detail > .rx-action-bar [data-action="reception-rotate-token"]').click();
 await endpointPrompt(page).locator('[data-action="reception-prompt-submit"]').click();
 await expect(endpointPage(page).locator('.reception-share-snippet').first()).toContainText('rotated-fixture-token');
 expect(await endpointCount(page,'reception.endpoint.enable')).toBe(1);expect(await endpointCount(page,'reception.endpoint.rotate_token')).toBe(1);
});
