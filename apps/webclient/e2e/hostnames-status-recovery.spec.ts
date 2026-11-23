import {expect,test,type Page,type Locator} from '@playwright/test';
import {HARNESS_URL} from './helpers/full-app.js';
type AddressUsesFixture={
 uses:Array<{use:string;source:string;hostname:string|null;base_url:string|null}>;
 choices:Array<{hostname:string;base_url:string}>;
 links_now:{app:string;answers:string};
 registered_webhooks:number;
};
type StatusFixture={calls:Array<{method:string;args:unknown}>;failList:boolean;refuse:string|null;blocked:boolean};
declare global{interface Window{__hostnameStatus:StatusFixture}}
const panel=(p:Page)=>p.locator('[data-recued-hostnames-panel]');
const at=(p:Page,name:string)=>panel(p).locator(`[data-recued-hostnames-${name}]`);
const select=(p:Page,use='reception')=>panel(p).locator(`[data-recued-hostnames-address-select="${use}"]`);
const press=async(target:Locator)=>{await target.focus();await target.press('Enter');};
const release=(p:Page,method:string)=>p.evaluate(method=>window.__app.releaseRpcResponses?.(method),method);
const calls=(p:Page)=>p.evaluate(()=>window.__hostnameStatus.calls);
const open=async(p:Page,width:number,failList=false)=>{
 await p.setViewportSize({width,height:900});await p.addInitScript(failList=>{
  const state:StatusFixture={calls:[],failList,refuse:null,blocked:false};window.__hostnameStatus=state;
  const row={hostname_id:'fixture-host',hostname:'fixture.example.test',cert_source:'byo_external',verification_method:'dns_txt',ownership_status:'verified',listener_ports:[443],ddns_managed:false,enabled:true,tls_topology:'server_terminated'};
  let enabled=true;let response:AddressUsesFixture={uses:['webhooks','reception','customer_access'].map(use=>({use,source:'owner',hostname:row.hostname,base_url:'https://'+row.hostname})),choices:[row.hostname,'other.example.test'].map(hostname=>({hostname,base_url:'https://'+hostname})),links_now:{app:'https://'+row.hostname,answers:'https://'+row.hostname},registered_webhooks:4};
  Object.assign(window,{__connectionsFixture:async(method:string,args:any)=>{
   if(method==='collection.hostname.list')return state.failList?{error:{code:'UNAVAILABLE',message:'Your names could not be checked.'}}:{result:{hostnames:[row]}};
   if(method==='network.local_urls')return{result:{urls:[],lan_port:7717,public_port:443}};
   if(method==='tls_domain.list')return{result:{entries:[]}};
   if(method==='pro_convenience.status')return{result:{entitlement:'entitled',publisher_handle:'alice',ddns_hostname:state.blocked?'alice.recued.cloud':'alice.recued.net',items:{handle:{state:'active'},ddns:{state:'active'},acme:{state:'active'}}}};
   if(method==='ddns.status')return{result:{enabled}};
   if(method==='collection.hostname.addressUses')return{result:structuredClone(response)};
   if(['ddns.setEnabled','collection.hostname.setAddressUse'].includes(method)){
    state.calls.push({method,args:structuredClone(args)});if(state.refuse===method)return{error:{code:'UNAVAILABLE',message:'The address change could not be saved.'}};
    if(method==='ddns.setEnabled'){enabled=args.enabled;return{result:{enabled}};}
    response={...response,uses:response.uses.map(u=>u.use===args.use?{...u,hostname:args.hostname,base_url:args.hostname===null?null:'https://'+args.hostname}:u)};return{result:structuredClone(response)};
   }
   return undefined;
  }});
 },failList);await p.goto(`${HARNESS_URL}?settle_reads=1#settings/server/hostnames`);await p.waitForFunction(()=>window.__app?.ready===true);if(failList)await expect(at(p,'error').first()).toBeVisible();else await expect(at(p,'row')).toBeVisible();await expect(at(p,'ddns-toggle')).toBeVisible();await expect(select(p)).toBeVisible();
};
const errors=new WeakMap<Page,string[]>();test.beforeEach(({page})=>{const e:string[]=[];errors.set(page,e);page.on('pageerror',x=>e.push(x.message));});test.afterEach(({page})=>{expect(errors.get(page)).toEqual([]);});
for(const width of[390,1280]){
 test(`Hostnames DDNS retains focused progress until the toggle settles at ${width}px`,async({page})=>{
  await open(page,width);await page.evaluate(()=>window.__app.holdRpcResponses?.('ddns.setEnabled'));await press(at(page,'ddns-toggle'));await expect(at(page,'ddns-progress')).toBeFocused();await expect(at(page,'ddns-progress')).toHaveAttribute('role','status');await release(page,'ddns.setEnabled');await expect(at(page,'ddns-toggle')).toBeFocused();await expect(at(page,'ddns-toggle')).toHaveText('Start the address again');expect(await calls(page)).toEqual([{method:'ddns.setEnabled',args:{enabled:false}}]);
 });
 test(`Hostnames webhook confirmation owns focus and returns it on cancellation at ${width}px`,async({page})=>{
  await open(page,width);await select(page,'webhooks').focus();await select(page,'webhooks').selectOption('other.example.test');await expect(at(page,'address-cancel-btn')).toBeFocused();await expect(at(page,'address-confirm')).toContainText('4 webhooks');await at(page,'address-cancel-btn').press('Enter');await expect(select(page,'webhooks')).toBeFocused();expect(await calls(page)).toEqual([]);
 });
 test(`Hostnames failed inventory stays distinct from an empty registry at ${width}px`,async({page})=>{
  await open(page,width,true);await expect(at(page,'empty')).toHaveCount(0);await page.evaluate(()=>{window.__hostnameStatus.failList=false;window.__app.setHash('#chat');});await expect(panel(page)).toHaveCount(0);await page.evaluate(()=>window.__app.setHash('#settings/server/hostnames'));await expect(at(page,'row')).toBeVisible();await expect(at(page,'error')).toHaveCount(0);expect(await calls(page)).toEqual([]);
 });
 test(`Hostnames DDNS refusal retains a keyboard retry and outside focus at ${width}px`,async({page})=>{
  await open(page,width);await page.evaluate(()=>{window.__hostnameStatus.refuse='ddns.setEnabled';window.__app.holdRpcResponses?.('ddns.setEnabled');});await press(at(page,'ddns-toggle'));await release(page,'ddns.setEnabled');await expect(at(page,'ddns-error')).toBeVisible();await expect(at(page,'ddns-toggle')).toBeFocused();
  await page.evaluate(()=>{window.__hostnameStatus.refuse=null;});await at(page,'ddns-toggle').press('Enter');await expect(at(page,'ddns-progress')).toBeFocused();const outside=page.locator('[data-recued-settings-nav-item="account"]');await outside.focus();await release(page,'ddns.setEnabled');await expect(at(page,'ddns-toggle')).toHaveText('Start the address again');await expect(outside).toBeFocused();expect(await calls(page)).toHaveLength(2);
 });
 test(`Hostnames address refusal returns to the exact selector and permits retry at ${width}px`,async({page})=>{
  await open(page,width);await page.evaluate(()=>{window.__hostnameStatus.refuse='collection.hostname.setAddressUse';window.__app.holdRpcResponses?.('collection.hostname.setAddressUse');});await select(page).focus();await select(page).selectOption('other.example.test');await expect(at(page,'address-progress')).toBeFocused();await release(page,'collection.hostname.setAddressUse');await expect(at(page,'address-error')).toBeVisible();await expect(select(page)).toBeFocused();await expect(select(page)).toHaveValue('fixture.example.test');
  await page.evaluate(()=>{window.__hostnameStatus.refuse=null;});await select(page).selectOption('other.example.test');await release(page,'collection.hostname.setAddressUse');await expect(select(page)).toBeFocused();await expect(select(page)).toHaveValue('other.example.test');expect(await calls(page)).toHaveLength(2);
 });
 test(`Hostnames webhook move remains guarded through acknowledgement at ${width}px`,async({page})=>{
  await open(page,width);await page.evaluate(()=>{window.__app.holdRpcResponses?.('collection.hostname.setAddressUse');window.confirm=()=>false;});await select(page,'webhooks').focus();await select(page,'webhooks').selectOption('other.example.test');const old=await at(page,'address-confirm-btn').elementHandle();await press(at(page,'address-confirm-btn'));await expect(at(page,'address-progress')).toBeFocused();await old!.evaluate(button=>(button as HTMLButtonElement).click());
  expect(await page.evaluate(()=>{const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented;})).toBe(true);await page.evaluate(()=>window.__app.setHash('#chat'));await expect(page).toHaveURL(/#settings\/server\/hostnames$/);await release(page,'collection.hostname.setAddressUse');await expect(select(page,'webhooks')).toBeFocused();await expect(select(page,'webhooks')).toHaveValue('other.example.test');expect(await calls(page)).toEqual([{method:'collection.hostname.setAddressUse',args:{use:'webhooks',hostname:'other.example.test'}}]);
 });
 for(const kind of ['ddns','address'] as const){
  test(`Hostnames ${kind} write preserves a native editor and its selection at ${width}px`,async({page})=>{
   await open(page,width);await press(at(page,'add-open'));const proof=panel(page).locator('[data-recued-hostnames-add-field="verification_token_hash"]');await proof.fill('a'.repeat(64));const original=await proof.elementHandle();const method=kind==='ddns'?'ddns.setEnabled':'collection.hostname.setAddressUse';await page.evaluate(method=>window.__app.holdRpcResponses?.(method),method);
   if(kind==='ddns')await press(at(page,'ddns-toggle'));else{await select(page).focus();await select(page).selectOption('other.example.test');}
   expect(await original!.evaluate(node=>node.isConnected)).toBe(true);await proof.focus();await proof.evaluate(node=>(node as HTMLInputElement).setSelectionRange(3,11,'backward'));await release(page,method);await expect(proof).toBeFocused();expect(await original!.evaluate(node=>node.isConnected&&node===document.activeElement)).toBe(true);expect(await proof.evaluate(node=>{const n=node as HTMLInputElement;return[n.selectionStart,n.selectionEnd,n.selectionDirection];})).toEqual([3,11,'backward']);
  });
  test(`Hostnames ${kind} refusal respects focus outside the status panel at ${width}px`,async({page})=>{
   await open(page,width);const method=kind==='ddns'?'ddns.setEnabled':'collection.hostname.setAddressUse';await page.evaluate(method=>{window.__hostnameStatus.refuse=method;window.__app.holdRpcResponses?.(method);},method);if(kind==='ddns')await press(at(page,'ddns-toggle'));else{await select(page).focus();await select(page).selectOption('other.example.test');}
   const outside=page.locator('[data-recued-settings-nav-item="account"]');await outside.focus();await release(page,method);await expect(at(page,kind==='ddns'?'ddns-error':'address-error')).toBeVisible();await expect(outside).toBeFocused();
  });
 }
 test(`Hostnames ignores a detached DDNS toggle after route disposal at ${width}px`,async({page})=>{
  await open(page,width);const old=await at(page,'ddns-toggle').elementHandle();await page.evaluate(()=>window.__app.setHash('#chat'));await expect(panel(page)).toHaveCount(0);await old!.evaluate(button=>(button as HTMLButtonElement).click());expect(await calls(page)).toEqual([]);
 });

}
