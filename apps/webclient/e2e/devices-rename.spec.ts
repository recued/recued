import {expect,test,type Page} from '@playwright/test';
import {HARNESS_URL} from './helpers/full-app.js';

const field=(page:Page)=>page.getByRole('textbox',{name:'New name for this device',exact:true});
const action=(page:Page,kind:string,id='device-laptop')=>page.locator(`[data-action="${kind}"][data-instance-id="${id}"]`);
const release=(page:Page,method:string)=>page.evaluate(method=>window.__app.releaseRpcResponses?.(method),method);
const calls=(page:Page,method:string)=>page.evaluate(method=>window.__deviceRename.calls.filter(call=>call.method===method),method);
const selection=(page:Page)=>field(page).evaluate(input=>{const n=input as HTMLInputElement;return[n.selectionStart,n.selectionEnd,n.selectionDirection];});
const selectDraft=(page:Page)=>field(page).evaluate(input=>(input as HTMLInputElement).setSelectionRange(3,12,'backward'));
const press=async(control:ReturnType<typeof action>)=>{await control.focus();await control.press('Enter');};
declare global{interface Window{__deviceRename:{failRename:boolean;failRead:boolean;prompts:string[];calls:Array<{method:string;args:unknown}>}}}

const open=async(page:Page,width:number,failRename=false)=>{
 await page.setViewportSize({width,height:900});
 await page.addInitScript(failRename=>{
  let name='Travel laptop';
  const state={failRename,failRead:false,prompts:[] as string[],calls:[] as Array<{method:string;args:unknown}>};window.__deviceRename=state;
  window.confirm=message=>{state.prompts.push(message??'');return false;};
  Object.assign(window,{__connectionsFixture:async(method:string,args:unknown)=>{
   if(!['pair.list','pair.rename'].includes(method))return;
   state.calls.push({method,args});
   if(method==='pair.rename'){
    if(state.failRename)return{error:{code:'UNAVAILABLE',message:'The name could not be saved. Try again.'}};
    name=(args as{display_name:string}).display_name;return{result:{ok:true,display_name:name}};
   }
   if(state.failRead){state.failRead=false;return{error:{code:'UNAVAILABLE',message:'The roster could not be checked.'}};}
   return{result:{devices:[{instance_id:'device-current',display_name:'This browser',kind:'webclient',added_at:1700000000,revoked_at:null,connected:true},{instance_id:'device-laptop',display_name:name,kind:'webclient',added_at:1699900000,revoked_at:null,connected:false},{instance_id:'device-desktop',display_name:'Office desktop',kind:'bridge',added_at:1699800000,revoked_at:null,connected:true}]}};
  }});
 },failRename);
 await page.goto(`${HARNESS_URL}?devices=ready&settle_reads=1&hold_rpc=pair.rename#settings/devices`);
 await page.waitForFunction(()=>window.__app?.ready===true);
 await press(action(page,'rename-device'));await expect(field(page)).toBeFocused();
};
const errors=new WeakMap<Page,string[]>();
test.beforeEach(({page})=>{const list:string[]=[];errors.set(page,list);page.on('pageerror',error=>list.push(error.message));});
test.afterEach(({page})=>{expect(errors.get(page)).toEqual([]);});

for(const width of[390,1280]){
 test(`Settings Devices keeps each rename draft with its owning device when switching rows at ${width}px`,async({page})=>{
  await open(page,width);await field(page).fill('Unsubmitted travel laptop edit');
  await press(action(page,'rename-device','device-desktop'));await expect(field(page)).toBeFocused();
  await expect(field(page)).toHaveValue('Office desktop');
  await field(page).press('Escape');await expect(action(page,'rename-device','device-desktop')).toBeFocused();
  await expect(page.locator('.account-devices-row[data-instance-id="device-laptop"]')).toContainText('Travel laptop');
  expect(await calls(page,'pair.rename')).toEqual([]);
 });

 test(`Settings Devices guards a pending rename through canceled departure and releases it after acknowledgement at ${width}px`,async({page})=>{
  await open(page,width);await field(page).fill('North office laptop');await field(page).press('Enter');
  await expect(action(page,'save-rename')).toHaveAttribute('aria-busy','true');await expect(action(page,'save-rename')).toBeFocused();
  await action(page,'save-rename').evaluate(button=>(button as HTMLButtonElement).click());
  expect(await calls(page,'pair.rename')).toHaveLength(1);
  expect(await page.evaluate(()=>{const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented;})).toBe(true);
  await page.evaluate(()=>window.__app.setHash('#chat'));
  await expect(page).toHaveURL(/#settings\/devices$/);
  expect(await page.evaluate(()=>window.__deviceRename.prompts)).toEqual(['Recued is still renaming a device. Leave Settings anyway?']);
  await expect(field(page)).toHaveValue('North office laptop');
  await release(page,'pair.rename');await expect(field(page)).toHaveCount(0);await expect(action(page,'rename-device')).toBeFocused();
  expect(await page.evaluate(()=>{const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented;})).toBe(false);
  await page.evaluate(()=>window.__app.setHash('#chat'));await expect(page).toHaveURL(/#chat$/);
 });

 test(`Settings Devices leaves an accepted pending rename and ignores its late refusal at ${width}px`,async({page})=>{
  await open(page,width,true);await field(page).fill('North office laptop');await field(page).press('Enter');
  await page.evaluate(()=>{window.confirm=message=>{window.__deviceRename.prompts.push(message??'');return true;};window.__app.setHash('#chat');});
  await expect(page).toHaveURL(/#chat$/);
  expect(await page.evaluate(()=>window.__deviceRename.prompts)).toEqual(['Recued is still renaming a device. Leave Settings anyway?']);
  const current=await page.evaluate(()=>document.activeElement?.getAttribute('data-recued-chat-route-input'));
  await release(page,'pair.rename');await expect(field(page)).toHaveCount(0);await expect(page.locator('.account-devices-rename-error')).toHaveCount(0);
  expect(await page.evaluate(()=>document.activeElement?.getAttribute('data-recued-chat-route-input'))).toBe(current);
 });

 test(`Settings Devices retains raw rename text and selection through refusal and retry at ${width}px`,async({page})=>{
  await open(page,width,true);const raw='  North office laptop  ';await field(page).fill(raw);await selectDraft(page);await field(page).press('Enter');
  await release(page,'pair.rename');await expect(page.locator('.account-devices-rename-error')).toBeVisible();
  await expect(field(page)).toBeFocused();await expect(field(page)).toHaveValue(raw);expect(await selection(page)).toEqual([3,12,'backward']);
  expect(await calls(page,'pair.rename')).toEqual([{method:'pair.rename',args:{instance_id:'device-laptop',display_name:raw.trim()}}]);
  await page.evaluate(()=>{window.__deviceRename.failRename=false;});await field(page).press('Enter');await release(page,'pair.rename');
  await expect(field(page)).toHaveCount(0);await expect(action(page,'rename-device')).toBeFocused();
  await expect(page.locator('.account-devices-row[data-instance-id="device-laptop"]')).toContainText(raw.trim());
  expect(await calls(page,'pair.rename')).toHaveLength(2);
 });

 test(`Settings Devices keeps a rename selection through successful and failed background checks at ${width}px`,async({page})=>{
  await open(page,width);await field(page).fill('North office laptop');await selectDraft(page);
  await page.evaluate(()=>{window.__app.holdRpcResponses?.('pair.list');window.__app.fireMessage({type:'server_event',event:{kind:'pair.list_changed',op:'added',cursor:3}});});
  await expect.poll(()=>calls(page,'pair.list')).toHaveLength(2);await expect(field(page)).toBeFocused();expect(await selection(page)).toEqual([3,12,'backward']);
  await release(page,'pair.list');await expect(field(page)).toBeFocused();expect(await selection(page)).toEqual([3,12,'backward']);
  await page.evaluate(()=>{window.__deviceRename.failRead=true;window.__app.fireMessage({type:'server_event',event:{kind:'pair.list_changed',op:'added',cursor:4}});});
  await expect.poll(()=>calls(page,'pair.list')).toHaveLength(3);await release(page,'pair.list');
  await expect(page.locator('[data-error="list"]')).toBeVisible();await expect(field(page)).toHaveValue('North office laptop');await expect(field(page)).toBeFocused();expect(await selection(page)).toEqual([3,12,'backward']);
  expect(await calls(page,'pair.rename')).toEqual([]);
 });

 test(`Settings Devices keeps outside focus when a pending rename is refused at ${width}px`,async({page})=>{
  await open(page,width,true);await field(page).fill('North office laptop');await field(page).press('Enter');
  const outside=page.locator('[data-recued-settings-devices-add-link] a');await outside.focus();await release(page,'pair.rename');
  await expect(page.locator('.account-devices-rename-error')).toBeVisible();await expect(outside).toBeFocused();await expect(field(page)).toHaveValue('North office laptop');
 });

 test(`Settings Devices keeps the newer revoke confirmation focused when a rename succeeds at ${width}px`,async({page})=>{
  await open(page,width);await field(page).fill('North office laptop');await field(page).press('Enter');
  await press(action(page,'revoke-device','device-desktop'));const cancel=action(page,'cancel-revoke','device-desktop');await expect(cancel).toBeFocused();
  await release(page,'pair.rename');await expect(field(page)).toHaveCount(0);await expect(cancel).toBeFocused();
  await expect(page.getByRole('alertdialog',{name:'Confirm revoke Office desktop (device-desktop)'})).toBeVisible();
  await cancel.press('Enter');expect(await page.evaluate(()=>window.__app.rpcCallCount('pair.revoke'))).toBe(0);
 });
}
