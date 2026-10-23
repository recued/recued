import { HARNESS_ORIGIN } from './helpers/harness-origin.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect,test,type Page } from '@playwright/test';
import type {} from './harness/saved-oauth-apps-harness.js';
const BASE=`${process.env.E2E_SAVED_APPS_HARNESS_URL??HARNESS_ORIGIN}/saved-oauth-apps-harness.html`;
const field=(page:Page,key:string)=>page.locator(`[data-conn-field="${key}"]`);
const action=(page:Page,name:string)=>page.locator(`[data-action="${name}"]`);
const name=async(page:Page)=>{await field(page,'name').fill('drive');await field(page,'display_name').fill('Drive');};
const select=async(page:Page)=>{await page.getByRole('button',{name:'Use saved Google app',exact:true}).click();};
const authorize=async(page:Page)=>{await action(page,'connections-authorize-vendor').click();await expect.poll(()=>page.evaluate(()=>window.__savedApps.popupUrl())).toMatch(/^https:/);};
test.beforeEach(async({page})=>{
 const headers=await readFile(resolve(import.meta.dirname,'../public/_headers'),'utf8');const policy=headers.match(/^\s*Content-Security-Policy:\s*(.+)$/m)?.[1];if(!policy)throw new Error('Missing shipped CSP');
 await page.route('**/saved-oauth-apps-harness.html*',async route=>{const response=await route.fetch();await route.fulfill({response,headers:{...response.headers(),'content-security-policy':policy}});});
 await page.goto(BASE);await expect(page.getByRole('button',{name:'Use saved Google app',exact:true})).toBeVisible();
});
test('selects a saved app without displaying or entering its secret',async({page})=>{
 await name(page);await select(page);await expect(field(page,'auth.client_id')).toHaveValue('saved-google-id');await expect(field(page,'auth.client_id')).toHaveAttribute('readonly','');await expect(field(page,'auth.client_secret')).toHaveCount(0);
 await expect(action(page,'connections-authorize-vendor')).toBeFocused();expect(await page.evaluate(()=>window.__savedApps.state().dialog.values['auth.client_secret'])).toBeUndefined();
});
test('authorizes locally and saves a separate API connection with the app reference',async({page})=>{
 await name(page);await select(page);await authorize(page);await page.evaluate(()=>window.__savedApps.finish());await expect(page.locator('[data-oauth-next-step]')).toBeVisible();await action(page,'connections-submit-form').click();
 await expect.poll(()=>page.evaluate(()=>window.__savedApps.calls.filter(call=>call.method==='collection.connection.enroll').length)).toBe(1);
 const calls=await page.evaluate(()=>window.__savedApps.calls);const complete=calls.find(call=>call.method==='collection.connection.completeVendorOAuth')?.args;const enroll=calls.find(call=>call.method==='collection.connection.enroll')?.args;
 expect(complete).toMatchObject({client_id:'saved-google-id',oauth_app_issuer:'google'});expect(complete).not.toHaveProperty('client_secret');expect(enroll).toMatchObject({oauth_app_issuer:'google',auth:{type:'oauth2_refresh',client_id:'saved-google-id',refresh_token:'fixture-own-refresh'}});expect(enroll).not.toHaveProperty('auth.client_secret');
});
test('keeps public signed OAuth on its existing start and result-claim path',async({page})=>{
 await page.goto(BASE+'?cloud');await name(page);await select(page);await authorize(page);await page.evaluate(()=>window.__savedApps.finish());await expect(page.locator('[data-oauth-next-step]')).toBeVisible();
 const calls=await page.evaluate(()=>window.__savedApps.calls);expect(calls.find(call=>call.method==='collection.connection.startVendorOAuth')?.args).toMatchObject({client_id:'saved-google-id',oauth_app_issuer:'google'});expect(calls.some(call=>call.method==='collection.connection.completeVendorOAuth')).toBe(false);
});
test('keeps normal app entry available and clears old authorization when switching back',async({page})=>{
 await name(page);await select(page);await authorize(page);await page.evaluate(()=>window.__savedApps.finish());await expect(page.locator('[data-oauth-next-step]')).toBeVisible();await page.getByRole('button',{name:'Enter another app',exact:true}).click();
 await expect(field(page,'auth.client_id')).toHaveValue('');await expect(field(page,'auth.client_id')).toBeFocused();await expect(field(page,'auth.client_secret')).toBeVisible();await expect(action(page,'connections-submit-form')).toBeDisabled();
});
test('preserves manual credential edits while refreshing saved metadata',async({page})=>{
 await field(page,'auth.client_id').fill('manual-id');await field(page,'auth.client_secret').fill('manual-secret');await page.getByRole('button',{name:'Refresh saved apps',exact:true}).click();
 await expect(field(page,'auth.client_id')).toHaveValue('manual-id');await expect(field(page,'auth.client_secret')).toHaveValue('manual-secret');
});
test('clears a changed app and issued token while keeping the connection name',async({page})=>{
 await name(page);await select(page);await authorize(page);await page.evaluate(()=>window.__savedApps.finish());await expect(page.locator('[data-oauth-next-step]')).toBeVisible();await page.evaluate(()=>window.__savedApps.change());await page.getByRole('button',{name:'Refresh saved apps',exact:true}).click();
 await expect(page.getByText('The saved OAuth app changed or was removed. Choose an app and authorize again.',{exact:true})).toBeVisible();await expect(field(page,'name')).toHaveValue('drive');await expect(field(page,'auth.client_id')).toHaveValue('');await expect(action(page,'connections-submit-form')).toBeDisabled();
});
for(const cloud of [false,true])test(`reconciles metadata learned during ${cloud?'signed public':'local'} authorization`,async({page})=>{
 if(cloud)await page.goto(BASE+'?cloud');await name(page);await select(page);await authorize(page);
 await page.evaluate(async()=>{window.__savedApps.change();await window.__savedApps.refresh();});
 await expect.poll(()=>page.evaluate(()=>window.__savedApps.state().dialog.savedOAuthApps?.config?.google.client_id)).toBe('new-google-id');
 await expect(field(page,'auth.client_id')).toHaveValue('saved-google-id');
 await page.evaluate(()=>window.__savedApps.finish());
 await expect(page.getByText('The saved OAuth app changed or was removed. Choose an app and authorize again.',{exact:true})).toBeVisible();
 await expect(field(page,'name')).toHaveValue('drive');await expect(field(page,'auth.client_id')).toHaveValue('');await expect(action(page,'connections-submit-form')).toBeDisabled();
 await select(page);await expect(field(page,'auth.client_id')).toHaveValue('new-google-id');
});
test('keeps the manual form usable when metadata reads fail and recover',async({page})=>{
 await page.evaluate(()=>window.__savedApps.fail());await page.getByRole('button',{name:'Refresh saved apps',exact:true}).click();await expect(page.getByText('Saved apps could not be loaded. Try Refresh saved apps.',{exact:true})).toBeVisible();
 await field(page,'auth.client_id').fill('manual-id');await expect(field(page,'auth.client_id')).toHaveValue('manual-id');await page.evaluate(()=>window.__savedApps.recover());await page.getByRole('button',{name:'Refresh saved apps',exact:true}).click();await expect(page.getByText('Saved apps could not be loaded. Try Refresh saved apps.',{exact:true})).toHaveCount(0);
});
test('ignores a relay from the wrong origin before accepting the bound result',async({page})=>{
 await name(page);await select(page);await authorize(page);await page.evaluate(()=>window.__savedApps.wrongRelay());expect(await page.evaluate(()=>window.__savedApps.calls.some(call=>call.method==='collection.connection.completeVendorOAuth'))).toBe(false);
 await page.evaluate(()=>window.__savedApps.finish());await expect(page.locator('[data-oauth-next-step]')).toBeVisible();
});
test('fits the saved app choice at a narrow viewport',async({page},info)=>{
 await page.setViewportSize({width:390,height:844});await name(page);await select(page);expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);await page.locator('[data-saved-oauth-apps]').screenshot({path:info.outputPath('saved-oauth-app-mobile.png')});
});

test('requests a renewable generic Google grant with PKCE',async({page})=>{
 await action(page,'connections-back-to-kind').click();await page.locator('[data-action="connections-pick-kind"][data-kind="api"]').click();
 await field(page,'auth.type').selectOption('oauth2_refresh');await field(page,'auth.authorize_url').fill('https://accounts.google.com/o/oauth2/v2/auth');await field(page,'auth.token_endpoint').fill('https://oauth2.googleapis.com/token');await field(page,'config.base_url').fill('https://sheets.googleapis.com/v4');
 await name(page);await select(page);await authorize(page);const url=new URL(await page.evaluate(()=>window.__savedApps.popupUrl()));expect(url.searchParams.get('access_type')).toBe('offline');expect(url.searchParams.get('prompt')).toBe('consent');expect(url.searchParams.get('code_challenge_method')).toBe('S256');
 await page.evaluate(()=>window.__savedApps.finish());await expect(page.locator('[data-oauth-next-step]')).toBeVisible();const args=await page.evaluate(()=>window.__savedApps.calls.find(call=>call.method==='collection.connection.completeVendorOAuth')?.args);expect(args).toMatchObject({oauth_app_issuer:'google',code_verifier:expect.any(String)});
});
test('reuses the Microsoft app for a generic API with visible offline access and PKCE',async({page})=>{
 await action(page,'connections-back-to-kind').click();await page.locator('[data-action="connections-pick-kind"][data-kind="api"]').click();
 await field(page,'auth.type').selectOption('oauth2_refresh');await field(page,'auth.authorize_url').fill('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');await field(page,'auth.token_endpoint').fill('https://login.microsoftonline.com/common/oauth2/v2.0/token');await field(page,'config.base_url').fill('https://graph.microsoft.com/v1.0');await field(page,'auth.scopes').fill('User.Read');
 await name(page);await page.getByRole('button',{name:'Use saved Microsoft app',exact:true}).click();await expect(field(page,'auth.client_id')).toHaveValue('saved-microsoft-id');await expect(field(page,'auth.scopes')).toHaveValue('User.Read offline_access');
 await authorize(page);const url=new URL(await page.evaluate(()=>window.__savedApps.popupUrl()));expect(url.searchParams.get('scope')).toBe('User.Read offline_access');expect(url.searchParams.get('code_challenge_method')).toBe('S256');
 await page.evaluate(()=>window.__savedApps.finish());await expect(page.locator('[data-oauth-next-step]')).toBeVisible();const args=await page.evaluate(()=>window.__savedApps.calls.find(call=>call.method==='collection.connection.completeVendorOAuth')?.args);expect(args).toMatchObject({oauth_app_issuer:'microsoft',client_id:'saved-microsoft-id',code_verifier:expect.any(String)});expect(args).not.toHaveProperty('client_secret');
});
