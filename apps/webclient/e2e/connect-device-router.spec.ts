import {expect,test,type Page} from '@playwright/test';
import {HARNESS_URL} from './helpers/full-app.js';

type RouterState={calls:Array<{method:string;args:unknown}>;prompts:string[];enabled:boolean;support:'enabled'|'unsupported';failWrite:boolean;failRead:boolean};
declare global {interface Window {__routerSetting:RouterState}}
const panel=(page:Page)=>page.locator('[data-recued-connect-device-panel]');
const action=(page:Page)=>panel(page).locator('[data-recued-connect-device-step-action]');
const status=(page:Page)=>panel(page).locator('[data-recued-connect-device-step-action-status]');
const error=(page:Page)=>panel(page).locator('[data-recued-connect-device-step-action-error]');
const outside=(page:Page)=>page.locator('[data-recued-settings-nav-item="account"]');
const workPrompt='A router setting is still updating. Leave Settings anyway?';
const writes=(page:Page)=>page.evaluate(()=>window.__routerSetting.calls.filter(call=>call.method==='server.setConfigField'));
const unloadBlocked=(page:Page)=>page.evaluate(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;});
const release=(page:Page,method:string)=>page.evaluate(method=>window.__app.releaseRpcResponses?.(method),method);
const press=async(page:Page)=>{await action(page).focus();await action(page).press('Enter');};
const open=async(page:Page,width:number,enabled=false)=>{
 await page.setViewportSize({width,height:900});
 await page.addInitScript(enabled=>{
  const state:RouterState={calls:[],prompts:[],enabled,support:'enabled',failWrite:false,failRead:false};window.__routerSetting=state;
  window.confirm=message=>{state.prompts.push(message??'');return false;};
  Object.assign(window,{__connectionsFixture:async(method:string,args:unknown)=>{
   if(method==='network.local_urls')return{result:{urls:[],lan_port:7717,public_port:443}};
   if(method==='tls_domain.list')return{result:{entries:[]}};
   if(method==='network.port_mapping'){
    state.calls.push({method,args});if(state.failRead){state.failRead=false;return{error:{code:'UNAVAILABLE',message:'The router could not be checked.'}};}
    return{result:{enabled:state.enabled,support:state.support,outcome:state.enabled?'mapped':'released'}};
   }
   if(method==='server.setConfigField'){
    state.calls.push({method,args:structuredClone(args)});
    if(state.failWrite)return{error:{code:'READ_ONLY',message:'The server could not save this setting. Try again.'}};
    state.enabled=(args as{value:boolean}).value;return{result:{ok:true}};
   }
   return undefined;
  }});
 },enabled);
 await page.goto(`${HARNESS_URL}?settle_reads=1&hold_rpc=server.setConfigField#settings/server/connect-device`);await page.waitForFunction(()=>window.__app?.ready===true);
 await expect(action(page)).toHaveAttribute('data-recued-connect-device-step-action-enable',String(!enabled));
};
const errors=new WeakMap<Page,string[]>();
test.beforeEach(({page})=>{const list:string[]=[];errors.set(page,list);page.on('pageerror',error=>list.push(error.message));});
test.afterEach(({page})=>{expect(errors.get(page)).toEqual([]);});

for(const width of [390,1280]){
 test(`Connect a device keeps the router action on focused progress and returns to the acknowledged setting at ${width}px`,async({page})=>{
  await open(page,width);await press(page);await expect(action(page)).toBeDisabled();await expect(status(page)).toBeFocused();
  await expect(status(page)).toHaveText('Updating the router setting…');await expect(status(page)).toHaveAttribute('role','status');
  await release(page,'server.setConfigField');await expect(action(page)).toHaveAttribute('data-recued-connect-device-step-action-enable','false');await expect(action(page)).toBeFocused();
  expect(await writes(page)).toEqual([{method:'server.setConfigField',args:{key:'network.auto_port_mapping',value:true}}]);
 });
 test(`Connect a device retains an unresolved router change after canceled navigation at ${width}px`,async({page})=>{
  await open(page,width);await press(page);expect(await unloadBlocked(page)).toBe(true);
  await page.evaluate(()=>window.__app.setHash('#chat'));await expect(page).toHaveURL(/#settings\/server\/connect-device$/);
  expect(await page.evaluate(()=>window.__routerSetting.prompts)).toEqual([workPrompt]);
  await release(page,'server.setConfigField');await expect(action(page)).toBeEnabled();expect(await unloadBlocked(page)).toBe(false);
  await page.evaluate(()=>window.__app.setHash('#chat'));await expect(page).toHaveURL(/#chat$/);
 });
 test(`Connect a device keeps a router refusal recoverable with the keyboard at ${width}px`,async({page})=>{
  await open(page,width);const old=await action(page).elementHandle();await page.evaluate(()=>{window.__routerSetting.failWrite=true;});await press(page);
  await old!.evaluate(button=>{(button as HTMLButtonElement).click();(button as HTMLButtonElement).click();});expect(await writes(page)).toHaveLength(1);
  await release(page,'server.setConfigField');await expect(error(page)).toHaveText('The server could not save this setting. Try again.');await expect(error(page)).toHaveAttribute('role','alert');
  await expect(action(page)).toBeFocused();await expect(action(page)).toHaveAttribute('data-recued-connect-device-step-action-enable','true');expect(await unloadBlocked(page)).toBe(false);
  await page.evaluate(()=>{window.__routerSetting.failWrite=false;});await action(page).press('Enter');await expect(status(page)).toBeFocused();await release(page,'server.setConfigField');
  await expect(action(page)).toHaveAttribute('data-recued-connect-device-step-action-enable','false');await expect(action(page)).toBeFocused();await expect(error(page)).toHaveCount(0);expect(await writes(page)).toHaveLength(2);
 });
 test(`Connect a device keeps outside focus while a router setting settles at ${width}px`,async({page})=>{
  await open(page,width);await press(page);await outside(page).focus();await release(page,'server.setConfigField');
  await expect(action(page)).toHaveAttribute('data-recued-connect-device-step-action-enable','false');await expect(outside(page)).toBeFocused();
 });
 test(`Connect a device owns the confirmation read after a router setting is acknowledged at ${width}px`,async({page})=>{
  await open(page,width);await press(page);await page.evaluate(()=>window.__app.holdRpcResponses?.('network.port_mapping'));await release(page,'server.setConfigField');
  await expect.poll(()=>page.evaluate(()=>window.__routerSetting.calls.filter(call=>call.method==='network.port_mapping').length)).toBe(2);
  await expect(status(page)).toBeFocused();await expect(action(page)).toBeDisabled();expect(await unloadBlocked(page)).toBe(true);
  await page.evaluate(()=>window.__app.setHash('#chat'));await expect(page).toHaveURL(/#settings\/server\/connect-device$/);
  expect(await page.evaluate(()=>window.__routerSetting.prompts)).toEqual([workPrompt]);
  await release(page,'network.port_mapping');await expect(action(page)).toHaveAttribute('data-recued-connect-device-step-action-enable','false');await expect(action(page)).toBeFocused();expect(await unloadBlocked(page)).toBe(false);
 });
 test(`Connect a device focuses the saved result when the router action is no longer available at ${width}px`,async({page})=>{
  await open(page,width,true);await page.evaluate(()=>{window.__routerSetting.support='unsupported';});await press(page);await release(page,'server.setConfigField');
  await expect(action(page)).toHaveCount(0);await expect(status(page)).toHaveText('Setting saved. Check the connection to see what your router did.');await expect(status(page)).toBeFocused();await expect(status(page)).toBeInViewport();expect(await unloadBlocked(page)).toBe(false);
  expect(await writes(page)).toEqual([{method:'server.setConfigField',args:{key:'network.auto_port_mapping',value:false}}]);
 });
 test(`Connect a device distinguishes a saved setting from an unread router outcome at ${width}px`,async({page})=>{
  await open(page,width);await page.evaluate(()=>{window.__routerSetting.failRead=true;});await press(page);await release(page,'server.setConfigField');
  await expect(status(page)).toHaveText('Setting saved. Check the connection to see what your router did.');await expect(action(page)).toBeFocused();await expect(action(page)).toBeEnabled();
  await expect(panel(page)).not.toContainText('Recued opened this port on your router.');expect(await unloadBlocked(page)).toBe(false);expect(await writes(page)).toHaveLength(1);
 });
 test(`Connect a device cannot write through a detached router control after disposal at ${width}px`,async({page})=>{
  await open(page,width);const old=await action(page).elementHandle();await page.evaluate(()=>window.__app.setHash('#chat'));await expect(panel(page)).toHaveCount(0);
  await old!.evaluate(button=>(button as HTMLButtonElement).click());expect(await writes(page)).toEqual([]);expect(await page.evaluate(()=>window.__routerSetting.prompts)).toEqual([]);
 });
 test(`Connect a device ignores a late router refusal after an accepted departure at ${width}px`,async({page})=>{
  await open(page,width);await page.evaluate(()=>{window.__routerSetting.failWrite=true;window.confirm=message=>{window.__routerSetting.prompts.push(message??'');return true;};});await press(page);
  await page.evaluate(()=>window.__app.setHash('#chat'));await expect(page).toHaveURL(/#chat$/);const input=page.locator('[data-recued-chat-route-input]');await input.focus();await release(page,'server.setConfigField');
  await expect(input).toBeFocused();await expect(panel(page)).toHaveCount(0);await expect(error(page)).toHaveCount(0);expect(await page.evaluate(()=>window.__routerSetting.calls.filter(call=>call.method==='network.port_mapping').length)).toBe(1);
  expect(await page.evaluate(()=>window.__routerSetting.prompts)).toEqual([workPrompt]);expect(await writes(page)).toHaveLength(1);
 });

}
