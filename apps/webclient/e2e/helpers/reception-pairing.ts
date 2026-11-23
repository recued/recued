import {expect,type Page} from '@playwright/test';
import {installAuthoringPage} from './reception-authoring.js';
import {installReceptionPairingFixture} from '../fixtures/reception-pairing.js';
import {goEndpoints} from './reception-endpoints.js';
export const pairRoot=(page:Page)=>page.locator('[data-reception-intake-recipe-pair-section]');
export const pairAction=(page:Page,action:string)=>pairRoot(page).locator(`[data-action="reception-pair-${action}"]`);
export async function installPairingPage(page:Page){await installAuthoringPage(page,`(${installReceptionPairingFixture.toString()})();`);}
export async function goPairing(page:Page,extra='') {await goEndpoints(page,'trigger_preapproval=form'+(extra?'&'+extra:''),'pair/customer-intake');await expect(pairRoot(page)).toBeVisible();}
export async function pairLoaded(page:Page,extra=''){await goPairing(page,extra);await expect(pairAction(page,'refresh')).toBeEnabled();}
export async function pairChanged(page:Page){
 const before=await page.evaluate(()=>(window as any).__endpoints.calls.filter((c:any)=>c.method==='reception.intake_recipe_pair.get').length);
 await page.evaluate(()=>window.__app.fireMessage({type:'server_event',event:{kind:'reception.endpoint_changed',op:'pair_bind',endpoint_id:'customer-intake',cursor:Date.now()}}));
 await expect.poll(()=>page.evaluate(()=>(window as any).__endpoints.calls.filter((c:any)=>c.method==='reception.intake_recipe_pair.get').length)).toBe(before+1);
 await expect(pairAction(page,'refresh')).toBeEnabled();
}
export async function pairConsent(page:Page){await pairLoaded(page,'pair_consent=1');await pairAction(page,'bind').click();await expect(pairAction(page,'consent-confirm')).toBeVisible();}
