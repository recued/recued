import {expect,test,type Page} from '@playwright/test';
import {applyPreset,type ExposureState,type PathRole,type ExposurePreset,type RootApexMode} from '@recued/contracts';
import {FIXED_NOW,HARNESS_URL} from './helpers/full-app.js';

type OwnershipState={calls:Array<{method:string;args:unknown}>;prompts:string[];refuse:string|null};
declare global {interface Window {__exposureOwnership:OwnershipState}}
const panel=(page:Page)=>page.locator('[data-recued-exposure-panel]');
const cell=(page:Page,path='health',axis='lan')=>panel(page).locator(`[data-recued-exposure-cell="${path}.${axis}"]`);
const progress=(page:Page)=>panel(page).locator('[data-recued-exposure-write-status]');
const dialog=(page:Page)=>panel(page).locator('[data-recued-exposure-modal]');
const outside=(page:Page)=>page.locator('[data-recued-settings-nav-item="account"]');
const release=(page:Page,method:string)=>page.evaluate(method=>window.__app.releaseRpcResponses?.(method),method);
const leave=(page:Page)=>page.evaluate(()=>window.__app.setHash('#chat'));
const unloadBlocked=(page:Page)=>page.evaluate(()=>{const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented;});
const calls=(page:Page,method:string)=>page.evaluate(method=>window.__exposureOwnership.calls.filter(c=>c.method===method),method);
const workPrompt='An Exposure setting is still updating. Leave Settings anyway?';
const draftPrompt='Discard the unfinished Exposure confirmation?';
const activate=async(page:Page)=>{await cell(page).focus();await cell(page).press('Space');};
const open=async(page:Page,width:number,options:{publicLan?:boolean;missingAddress?:boolean;publicWebhook?:boolean}={})=>{
 await page.setViewportSize({width,height:900});
 const state:ExposureState={resolution:applyPreset('lan_only',{acknowledged:false}),derived_preset_label:'lan_only',public_mcp_acknowledgement:{acknowledged:false},last_changed_at:FIXED_NOW,changed_by_client_id:'device-current'};
 if(options.publicWebhook)state.resolution.webhooks.public=true;
 const presets=Object.fromEntries(['lan_only','public','maintenance'].map(preset=>[preset,applyPreset(preset as ExposurePreset,{acknowledged:false})])) as Record<ExposurePreset,ExposureState['resolution']>;
 await page.addInitScript(({initial,presets,options})=>{
  let state=initial;let apex:RootApexMode='not_found';const controls:OwnershipState={calls:[],prompts:[],refuse:null};window.__exposureOwnership=controls;
  window.confirm=message=>{controls.prompts.push(message??'');return false;};
  Object.assign(window,{__connectionsFixture:async(method:string,args:unknown)=>{
   if(method==='exposure.get')return{result:{state:structuredClone(state),apex_mode:apex,has_public_address:!options.missingAddress}};
   if(method==='network.local_urls')return{result:{urls:[],lan_port:7717,public_port:443,lan_exposure:{publicly_routable:options.publicLan===true,wildcard:false,public_addresses:options.publicLan?['203.0.113.7']:[]}}};
   if(!method.startsWith('exposure.'))return undefined;controls.calls.push({method,args:structuredClone(args)});
   if(controls.refuse===method)return{error:{code:method==='exposure.set_public_mcp_acknowledgement'?'public_mcp_phrase_mismatch':'UNAVAILABLE',message:'The exposure change was refused.'}};
   if(method==='exposure.set_apex'){apex=(args as{apex_mode:RootApexMode}).apex_mode;return{result:{apex_mode:apex}};}
   if(method==='exposure.set_path_resolution'){const p=args as{path:PathRole;resolution:{lan:boolean;public:boolean}};state={...state,resolution:{...state.resolution,[p.path]:p.resolution}};}
   if(method==='exposure.apply_preset'){const p=(args as{preset:ExposurePreset}).preset;state={...state,resolution:structuredClone(presets[p]),derived_preset_label:p};}
   if(method==='exposure.set_public_mcp_acknowledgement'){const p=args as{acknowledge:boolean;free_text_confirmation?:string};state={...state,public_mcp_acknowledgement:p.acknowledge?{acknowledged:true,acknowledged_at:state.last_changed_at+1,acknowledged_by_client_id:'device-current',free_text_confirmation:p.free_text_confirmation??''}:{acknowledged:false}};}
   state={...state,last_changed_at:state.last_changed_at+1};return{result:{state:structuredClone(state)}};
  }});
 },{initial:state,presets,options});
 let releaseProbe:(()=>void)|undefined;let probes=0;
 await page.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin===new URL(HARNESS_URL).origin)return route.continue();if(options.publicLan&&url.hostname==='probe.recued.com'&&url.pathname==='/v1/diagnostics/probe'){probes++;const request=route.request().postDataJSON();await new Promise<void>(resolve=>{releaseProbe=resolve;});return route.fulfill({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:JSON.stringify({data:{account_id:request.account_id,hostname:request.hostname,detected_public_ip:'203.0.113.5',resolved_ips:['203.0.113.5'],probed_at:Date.now(),results:[{kind:'port_reachability',status:'fail',payload:{kind:'port_reachability',port:7717,outcome:'blocked'}}]}})});}throw new Error('Unexpected network request: '+route.request().url());});
 await page.goto(`${HARNESS_URL}?settle_reads=1#settings/server/exposure`);await page.waitForFunction(()=>window.__app?.ready===true);await expect(cell(page)).toBeEnabled();
 return{probes:()=>probes,releaseProbe:()=>{expect(releaseProbe).toBeDefined();releaseProbe!();}};
};
const openConfirmation=async(page:Page,kind:'mcp'|'ws'|'chain'='mcp')=>{
 const trigger=kind==='mcp'?panel(page).locator('[data-recued-exposure-public-mcp]'):cell(page,kind==='ws'?'ws':'mcp',kind==='ws'?'lan':'public');
 await trigger.focus();await trigger.press(kind==='mcp'?'Enter':'Space');await expect(dialog(page)).toBeVisible();return dialog(page).getByRole('textbox');
};
const errors=new WeakMap<Page,string[]>();
test.beforeEach(({page})=>{const list:string[]=[];errors.set(page,list);page.on('pageerror',e=>list.push(e.message));});
test.afterEach(({page})=>{expect(errors.get(page)).toEqual([]);});

for(const width of[390,1280]){
 test(`Exposure keeps the changed switch on focused progress until acknowledgement at ${width}px`,async({page})=>{
  await open(page,width);await page.evaluate(()=>window.__app.holdRpcResponses?.('exposure.set_path_resolution'));await activate(page);
  await expect(cell(page)).toBeDisabled();await expect(progress(page)).toBeFocused();await expect(progress(page)).toHaveAttribute('role','status');
  await release(page,'exposure.set_path_resolution');await expect(cell(page)).toBeEnabled();await expect(cell(page)).not.toBeChecked();await expect(cell(page)).toBeFocused();await expect(progress(page)).toHaveCount(0);
 });
 test(`Exposure protects pending changes on canceled navigation at ${width}px`,async({page})=>{
  await open(page,width);await page.evaluate(()=>window.__app.holdRpcResponses?.('exposure.set_path_resolution'));await activate(page);expect(await unloadBlocked(page)).toBe(true);
  await leave(page);await expect(page).toHaveURL(/#settings\/server\/exposure$/);expect(await page.evaluate(()=>window.__exposureOwnership.prompts)).toEqual([workPrompt]);
  await release(page,'exposure.set_path_resolution');await expect(cell(page)).toBeEnabled();expect(await unloadBlocked(page)).toBe(false);await leave(page);await expect(page).toHaveURL(/#chat$/);
 });
 test(`Exposure protects unfinished confirmation text until it is cleared at ${width}px`,async({page})=>{
  await open(page,width);const phrase=await openConfirmation(page);await phrase.fill('unfinished confirmation');expect(await unloadBlocked(page)).toBe(true);
  await leave(page);await expect(page).toHaveURL(/#settings\/server\/exposure$/);await expect(phrase).toHaveValue('unfinished confirmation');expect(await page.evaluate(()=>window.__exposureOwnership.prompts)).toEqual([draftPrompt]);
  await phrase.fill('');expect(await unloadBlocked(page)).toBe(false);await phrase.press('Escape');await leave(page);await expect(page).toHaveURL(/#chat$/);expect(await calls(page,'exposure.set_public_mcp_acknowledgement')).toEqual([]);
 });
 for(const kind of ['preset','apex'] as const){
  test(`Exposure ${kind} action retains focus through refusal and retry at ${width}px`,async({page})=>{
   await open(page,width);const method=kind==='preset'?'exposure.apply_preset':'exposure.set_apex';const control=panel(page).locator(kind==='preset'?'[data-recued-exposure-preset="public"] input':'[data-recued-exposure-apex="redirect"] input');
   await page.evaluate(method=>{window.__exposureOwnership.refuse=method;window.__app.holdRpcResponses?.(method);},method);await control.focus();await control.press('Space');await expect(progress(page)).toBeFocused();
   await release(page,method);await expect(panel(page).locator('[data-recued-exposure-action-error]')).toBeVisible();await expect(control).toBeFocused();expect(await unloadBlocked(page)).toBe(false);
   await page.evaluate(()=>{window.__exposureOwnership.refuse=null;});await control.press('Space');await expect(progress(page)).toBeFocused();await release(page,method);await expect(control).toBeFocused();await expect(control).toBeChecked();expect(await calls(page,method)).toHaveLength(2);
  });
 }
 test(`Exposure keeps outside focus when an access change is refused at ${width}px`,async({page})=>{
  await open(page,width);await page.evaluate(()=>{window.__exposureOwnership.refuse='exposure.set_path_resolution';window.__app.holdRpcResponses?.('exposure.set_path_resolution');});await activate(page);await outside(page).focus();await release(page,'exposure.set_path_resolution');
  await expect(panel(page).locator('[data-recued-exposure-action-error]')).toBeVisible();await expect(outside(page)).toBeFocused();await expect(cell(page)).toBeChecked();
 });
 test(`Exposure preserves the active progress owner and newer broadcast through an older acknowledgement at ${width}px`,async({page})=>{
  await open(page,width);await page.evaluate(()=>window.__app.holdRpcResponses?.('exposure.set_path_resolution'));await activate(page);
  const resolution=applyPreset('lan_only',{acknowledged:false});await page.evaluate(({resolution,at})=>window.__app.fireMessage({type:'server_event',event:{kind:'exposure_changed',resolution,derived_preset_label:'lan_only',public_mcp_acknowledgement:{acknowledged:false},changed_at:at,changed_by_client_id:'device-other',cursor:at}}),{resolution,at:FIXED_NOW+10});
  await expect(progress(page)).toBeFocused();await release(page,'exposure.set_path_resolution');await expect(cell(page)).toBeEnabled();await expect(cell(page)).toBeFocused();await expect(cell(page)).toBeChecked();
 });
 test(`Exposure keeps row context when a closed public path becomes gated at ${width}px`,async({page})=>{
  await open(page,width,{missingAddress:true,publicWebhook:true});const control=cell(page,'webhooks','public');await page.evaluate(()=>window.__app.holdRpcResponses?.('exposure.set_path_resolution'));await control.focus();await control.press('Space');await expect(progress(page)).toBeFocused();await release(page,'exposure.set_path_resolution');
  await expect(control).not.toBeChecked();await expect(control).toBeDisabled();await expect(panel(page).locator('[data-recued-exposure-path="webhooks"] .exposure-grid-path')).toBeFocused();
 });
 for(const kind of ['mcp','ws'] as const){
  test(`Exposure ${kind} confirmation keeps its pending mutation attached to Settings at ${width}px`,async({page})=>{
   await open(page,width);const phrase=await openConfirmation(page,kind),method=kind==='mcp'?'exposure.set_public_mcp_acknowledgement':'exposure.set_path_resolution';await phrase.fill(kind==='mcp'?'enable public MCP':'disconnect webclients');
   await page.evaluate(method=>window.__app.holdRpcResponses?.(method),method);const submit=dialog(page).locator('[data-recued-exposure-modal-submit]');await submit.focus();await submit.press('Enter');await expect(submit).toBeDisabled();expect(await unloadBlocked(page)).toBe(true);await leave(page);await expect(page).toHaveURL(/#settings\/server\/exposure$/);
   expect(await page.evaluate(()=>window.__exposureOwnership.prompts)).toEqual([workPrompt]);await release(page,method);await expect(dialog(page)).toHaveCount(0);expect(await unloadBlocked(page)).toBe(false);
  });
 }
 test(`Exposure keeps the chained public MCP path change owned after acknowledgement at ${width}px`,async({page})=>{
  await open(page,width);const phrase=await openConfirmation(page,'chain');await phrase.fill('enable public MCP');const oldCancel=await dialog(page).locator('[data-recued-exposure-modal-cancel]').elementHandle();
  await page.evaluate(()=>window.__app.holdRpcResponses?.('exposure.set_path_resolution'));await dialog(page).locator('[data-recued-exposure-modal-submit]').press('Enter');await expect.poll(()=>calls(page,'exposure.set_path_resolution')).toHaveLength(1);
  await oldCancel!.evaluate(button=>(button as HTMLButtonElement).click());await expect(dialog(page)).toBeVisible();expect(await unloadBlocked(page)).toBe(true);await leave(page);await expect(page).toHaveURL(/#settings\/server\/exposure$/);
  await release(page,'exposure.set_path_resolution');await expect(dialog(page)).toHaveCount(0);await expect(cell(page,'mcp','public')).toBeChecked();expect(await calls(page,'exposure.set_public_mcp_acknowledgement')).toHaveLength(1);expect(await calls(page,'exposure.set_path_resolution')).toEqual([{method:'exposure.set_path_resolution',args:{path:'mcp',resolution:{lan:true,public:true}}}]);
 });
 for(const kind of ['mcp','ws','apex'] as const){
  test(`Exposure ignores a detached ${kind} control after disposal at ${width}px`,async({page})=>{
   await open(page,width);let old;
   if(kind==='apex')old=await panel(page).locator('[data-recued-exposure-apex="redirect"] input').elementHandle();else{const phrase=await openConfirmation(page,kind);await phrase.fill(kind==='mcp'?'enable public MCP':'disconnect webclients');old=await dialog(page).locator('[data-recued-exposure-modal-submit]').elementHandle();}
   await page.evaluate(()=>{window.confirm=()=>true;});await leave(page);await expect(panel(page)).toHaveCount(0);await old!.evaluate(node=>(node as HTMLInputElement).click());expect(await page.evaluate(()=>window.__exposureOwnership.calls)).toEqual([]);
  });
 }
 test(`Exposure ignores a late refused access change after accepted departure at ${width}px`,async({page})=>{
  await open(page,width);await page.evaluate(()=>{window.__exposureOwnership.refuse='exposure.set_path_resolution';window.__app.holdRpcResponses?.('exposure.set_path_resolution');window.confirm=message=>{window.__exposureOwnership.prompts.push(message??'');return true;};});await activate(page);await leave(page);await expect(page).toHaveURL(/#chat$/);
  const input=page.locator('[data-recued-chat-route-input]');await input.focus();await release(page,'exposure.set_path_resolution');await expect(input).toBeFocused();await expect(panel(page)).toHaveCount(0);expect(await page.evaluate(()=>window.__exposureOwnership.prompts)).toEqual([workPrompt]);
 });
 test(`Exposure keeps the local-port check focused without holding a read-only result on navigation at ${width}px`,async({page})=>{
  const fixture=await open(page,width,{publicLan:true});const check=panel(page).locator('[data-recued-exposure-lan-check]');await check.focus();await check.press('Enter');await expect(panel(page).locator('[data-recued-exposure-lan-check-status]')).toBeFocused();expect(await unloadBlocked(page)).toBe(false);await expect.poll(fixture.probes).toBe(1);fixture.releaseProbe();await expect(check).toBeEnabled();await expect(check).toBeFocused();expect(await page.evaluate(()=>window.__exposureOwnership.calls)).toEqual([]);
 });

}
