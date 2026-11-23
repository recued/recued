import {expect,type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {HARNESS_ORIGIN} from './harness-origin.js';
import {installCustomerWorkFixture} from '../fixtures/customer-work.js';
import {installFollowupsAbuseFixture} from '../fixtures/followups-abuse.js';
export async function installFollowupAbusePage(page:Page){
 await page.addInitScript({content:`(${installCustomerWorkFixture.toString()})();(${installFollowupsAbuseFixture.toString()})();`});
 const policy=(await readFile(resolve(import.meta.dirname,'../../public/_headers'),'utf8')).match(/^\s*Content-Security-Policy:\s*(.+)$/m)![1]!;
 await page.route('**/full-app-harness.html*',async route=>{const response=await route.fetch();await route.fulfill({response,headers:{...response.headers(),'content-security-policy':policy}});});
}
export const followupState=(page:Page)=>page.evaluate(()=>(window as any).__followupAbuse as {calls:Array<{method:string;args:Record<string,any>}>});
export const holdFollowup=(page:Page,method:string)=>page.evaluate(method=>{(window as any).__followupAbuse.hold=method;},method);
export const releaseFollowup=(page:Page)=>page.evaluate(()=>(window as any).__followupAbuse.release?.());
export const failFollowup=(page:Page,method?:string)=>page.evaluate(method=>{(window as any).__followupAbuse.fail=method;},method);
export const abuseRoot=(page:Page)=>page.locator('[data-recued-reception-abuse-section]');
export const followupRoot=(page:Page)=>page.locator('[data-customer-work]');
export const followupKinds=[{key:'offer',title:'Sign-off requests',prefix:'reception.signoff.reminders',namespace:'signoff',idKey:'signoff_id'},{key:'completion',title:'Completion requests',prefix:'reception.signoff.completion.reminders',namespace:'completion',idKey:'completion_id'},{key:'payment',title:'Invoice payments',prefix:'reception.signoff.payment.reminders',namespace:'payment',idKey:'signoff_id'},{key:'account',title:'Account payments',prefix:'reception.accounts.payment.reminders',namespace:'account-payment',idKey:'account_id'}] as const;
export const followupGroup=(page:Page,kind:typeof followupKinds[number])=>followupRoot(page).locator('[data-customer-followup-group]').filter({has:page.locator('summary').filter({hasText:kind.title})});
export async function goFollowupAbuse(page:Page,route='followups',extra=''){
 await page.goto(`${HARNESS_ORIGIN}/full-app-harness.html?jobs=6&server_profiles=multiple${extra?'&'+extra:''}#reception/${route}`);await page.waitForFunction(()=>window.__app?.ready===true);
}
export async function loadedFollowups(page:Page){await goFollowupAbuse(page);for(const kind of followupKinds)await expect(followupGroup(page,kind).locator(`[data-${kind.namespace}-reminder-queue]>article`)).toHaveCount(3);}
export const firstAbuseBan=(page:Page)=>abuseRoot(page).locator('.reception-abuse-row').first().getByRole('button',{name:'Ban IP',exact:true});
export async function loadedAbuse(page:Page){await goFollowupAbuse(page,'abuse');await expect(abuseRoot(page).locator('.reception-abuse-row')).toHaveCount(6);}
