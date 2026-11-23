import {test,expect} from '@playwright/test';
import {installPairingPage,pairLoaded,pairRoot,pairAction,pairConsent,pairChanged} from './helpers/reception-pairing.js';
import {endpointCount,holdEndpoint,releaseEndpoint,failEndpoint} from './helpers/reception-endpoints.js';

const errors=new WeakMap<import('@playwright/test').Page,string[]>();
test.beforeEach(async({page})=>{const rows:string[]=[];errors.set(page,rows);page.on('pageerror',error=>rows.push(error.message));await installPairingPage(page);});
test.afterEach(async({page})=>expect(errors.get(page)).toEqual([]));

test('a saved recipe selection retains native keyboard focus',async({page})=>{
 await pairLoaded(page);const select=pairAction(page,'select');await select.focus();await select.selectOption('project-followup');await expect(select).toBeFocused();
});

test('changing the recipe retires its prior consent and standing approval choice',async({page})=>{
 await pairConsent(page);await pairAction(page,'consent-standing').check();await pairAction(page,'select').selectOption('project-followup');
 await expect(pairAction(page,'consent-confirm')).toHaveCount(0);expect(await endpointCount(page,'reception.intake_recipe_pair.bind')).toBe(1);
 await pairAction(page,'bind').click();await expect(pairAction(page,'consent-standing')).not.toBeChecked();
});

test('a same-pair refresh preserves payment draft text and selection',async({page})=>{
 await pairLoaded(page);const field=pairAction(page,'config-connection');await field.fill('stripe-edited');await field.evaluate((node:HTMLInputElement)=>node.setSelectionRange(1,6,'backward'));
 await pairChanged(page);await expect(pairAction(page,'refresh')).toBeEnabled();await expect(field).toHaveValue('stripe-edited');await expect(field).toBeFocused();
 expect(await field.evaluate((node:HTMLInputElement)=>[node.selectionStart,node.selectionEnd,node.selectionDirection])).toEqual([1,6,'backward']);
});

test('pending pairing keeps navigation ownership until its response settles',async({page})=>{
 await pairLoaded(page);const method='reception.intake_recipe_pair.bind';await holdEndpoint(page,method);await pairAction(page,'bind').click();
 await expect.poll(()=>page.evaluate(m=>(window as any).__endpoints.pending(m),method)).toBe(1);
 let questions=0;page.on('dialog',async (dialog:import('@playwright/test').Dialog)=>{questions++;await dialog.dismiss();});await pairRoot(page).getByRole('link',{name:'← Endpoints',exact:true}).click();
 await expect(pairRoot(page)).toBeVisible();await expect.poll(()=>questions).toBe(1);await releaseEndpoint(page,method);await expect(pairAction(page,'bind')).toBeEnabled();
});


test('unsubmitted payment drafts participate in the app departure guard',async({page})=>{
 await pairLoaded(page);await pairAction(page,'config-connection').fill('stripe-edited');
 let questions=0;const decline=async (dialog:import('@playwright/test').Dialog)=>{questions++;await dialog.dismiss();};page.on('dialog',decline);
 await pairRoot(page).getByRole('link',{name:'← Endpoints',exact:true}).click();await expect(pairAction(page,'config-connection')).toHaveValue('stripe-edited');await expect.poll(()=>questions).toBe(1);
 page.off('dialog',decline);page.once('dialog',dialog=>dialog.accept());await pairRoot(page).getByRole('link',{name:'← Endpoints',exact:true}).click();await expect(pairRoot(page)).toHaveCount(0);expect(await endpointCount(page,'reception.intake_recipe_pair.configure')).toBe(0);
});

test('new pair authority retires consent and cannot inherit its standing choice',async({page})=>{
 await pairConsent(page);await pairAction(page,'consent-standing').check();await page.evaluate(()=>{(window as any).__pairing.pair.updated_at=303;});await pairChanged(page);
 await expect(pairAction(page,'consent-confirm')).toHaveCount(0);await pairAction(page,'bind').click();await expect(pairAction(page,'consent-standing')).not.toBeChecked();
});

test('consent submits only the reviewed recipe and explicit standing choice',async({page})=>{
 await pairConsent(page);const choice=pairAction(page,'consent-standing');await choice.focus();await page.keyboard.press('Space');await expect(choice).toBeChecked();await expect(choice).toBeFocused();
 await pairAction(page,'consent-confirm').click();await expect(pairRoot(page).getByRole('status')).toContainText('The form is live');
 expect(await page.evaluate(()=>(window as any).__endpoints.calls.filter((c:any)=>c.method==='reception.intake_recipe_pair.bind').map((c:any)=>c.args))).toEqual([
  {endpoint_id:'customer-intake',recipe_id:'project-checkout',expected_updated_at:101},
  {endpoint_id:'customer-intake',recipe_id:'project-checkout',expected_updated_at:102,confirm_capability:true,standing_closure:true},
 ]);
});

test('clear confirmation returns keyboard focus when cancelled and uses the observed locators',async({page})=>{
 await pairLoaded(page);await pairAction(page,'clear-request').focus();await page.keyboard.press('Enter');await expect(pairAction(page,'clear-confirm')).toBeFocused();
 await pairAction(page,'clear-cancel').click();await expect(pairAction(page,'clear-request')).toBeFocused();expect(await endpointCount(page,'reception.intake_recipe_pair.clear')).toBe(0);
 await pairAction(page,'clear-request').click();await pairAction(page,'clear-confirm').click();await expect(pairRoot(page)).toContainText('This remains a generic intake form');
 expect(await page.evaluate(()=>(window as any).__endpoints.calls.find((c:any)=>c.method==='reception.intake_recipe_pair.clear').args)).toEqual({endpoint_id:'customer-intake',expected_status:'ready',expected_updated_at:101,expected_pair_revision:'d200-pair-v1-'+ 'a'.repeat(64)});
});

for(const operation of ['configure','clear'] as const)test(`pending ${operation} includes its follow-up authority read`,async({page})=>{
 await pairLoaded(page);const read='reception.intake_recipe_pair.get';await holdEndpoint(page,read);
 if(operation==='clear'){await pairAction(page,'clear-request').click();await pairAction(page,'clear-confirm').click();}else await pairAction(page,'config-save').click();
 await expect.poll(()=>page.evaluate(m=>(window as any).__endpoints.pending(m),read)).toBe(1);
 let questions=0;page.once('dialog',async (dialog:import('@playwright/test').Dialog)=>{questions++;await dialog.dismiss();});await pairRoot(page).getByRole('link',{name:'← Endpoints',exact:true}).click();
 await expect(pairRoot(page)).toBeVisible();await expect.poll(()=>questions).toBe(1);await releaseEndpoint(page,read);await expect(pairAction(page,'refresh')).toBeEnabled();expect(await endpointCount(page,'reception.intake_recipe_pair.'+operation)).toBe(1);
});

test('a rejected payment save retains the corrected draft for an explicit retry',async({page})=>{
 await pairLoaded(page);const connection=pairAction(page,'config-connection');await connection.fill('Invalid name');await pairAction(page,'config-save').click();await expect(pairRoot(page).getByRole('alert')).toBeVisible();expect(await endpointCount(page,'reception.intake_recipe_pair.configure')).toBe(0);
 await connection.fill('stripe-edited');await expect(connection).toBeFocused();await expect(pairRoot(page).getByRole('alert')).toHaveCount(0);await failEndpoint(page,'reception.intake_recipe_pair.configure');await pairAction(page,'config-save').click();await expect(pairRoot(page).getByRole('alert')).toBeVisible();await expect(connection).toHaveValue('stripe-edited');
 await failEndpoint(page);await pairAction(page,'config-save').click();await expect(pairRoot(page)).toContainText('Payment set-up saved');expect(await endpointCount(page,'reception.intake_recipe_pair.configure')).toBe(2);await expect(pairAction(page,'config-save')).toHaveCount(0);
});

test('a failed read recovers without a write or moving later Account focus',async({page})=>{
 await pairLoaded(page);const method='reception.intake_recipe_pair.get';await failEndpoint(page,method);await pairAction(page,'refresh').click();await expect(pairRoot(page).getByRole('alert')).toBeVisible();await failEndpoint(page);await holdEndpoint(page,method);await pairAction(page,'refresh').click();
 await expect.poll(()=>page.evaluate(m=>(window as any).__endpoints.pending(m),method)).toBe(1);
 await page.locator('[data-recued-account-menu-trigger]').click();const close=page.locator('[data-recued-account-menu-close]');await close.focus();
 await releaseEndpoint(page,method);await expect(pairAction(page,'refresh')).toBeEnabled();await expect(close).toBeFocused();
 expect(await page.evaluate(()=>(window as any).__endpoints.calls.filter((c:any)=>/^reception\.intake_recipe_pair\.(bind|configure|clear)$/.test(c.method)||c.method==='execute').length)).toBe(0);
});
