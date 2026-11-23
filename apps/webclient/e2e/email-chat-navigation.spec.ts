import {expect,test,type Page} from '@playwright/test';
import type {MailChatDoorSettings} from '@recued/contracts';
import {HARNESS_URL} from './helpers/full-app.js';
import type {MailChatDoorSetArgs} from '../src/settings/mail-chat-door-panel.js';

type ReviewState={calls:Array<{method:string;args:unknown}>;prompts:string[];failCheck:boolean;failSet:boolean;failRead:boolean};
declare global {interface Window {__emailChatNavigation:ReviewState}}
const panel=(page:Page)=>page.locator('[data-recued-mail-chat-door-panel]');
const at=(page:Page,name:string)=>panel(page).locator(`[data-recued-mail-chat-door-${name}]`);
const press=async(page:Page,name:string)=>{await at(page,name).focus();await at(page,name).press('Enter');};
const unloadBlocked=(page:Page)=>page.evaluate(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;});
const leave=(page:Page)=>page.evaluate(()=>window.__app.setHash('#chat'));
const release=(page:Page,method:string)=>page.evaluate(method=>window.__app.releaseRpcResponses?.(method),method);
const draftPrompt='Discard the unsaved Email chat settings?';
const workPrompt='An Email chat change is still in progress. Leave Settings anyway?';
const open=async(page:Page,width:number,on=true)=>{
 await page.setViewportSize({width,height:900});
 await page.addInitScript(on=>{
  let settings:MailChatDoorSettings={chat_mailbox:on?'recued-chat':null,chat_address:on?'recued@chat.example':null,ask_prefix:'ask:',owner_mailboxes:on?['me']:[],stale_after_minutes:60,paused_at:null,enrolled_senders:[]};
  const state:ReviewState={calls:[],prompts:[],failCheck:false,failSet:false,failRead:false};window.__emailChatNavigation=state;
  window.confirm=message=>{state.prompts.push(message??'');return false;};
  Object.assign(window,{__connectionsFixture:async(method:string,args:unknown)=>{
   if(!method.startsWith('collection.mail.chat_door.')&&method!=='collection.mail.list')return undefined;
   state.calls.push({method,args:structuredClone(args)});
   if(method==='collection.mail.chat_door.get'){if(state.failRead){state.failRead=false;return{error:{code:'UNAVAILABLE',message:'Email chat could not be refreshed.'}};}return{result:structuredClone(settings)};}
   if(method==='collection.mail.list')return{result:{instances:[{slug:'recued-chat',adapter_type:'imap',account_email:'recued@chat.example',send_capable:true},{slug:'me',adapter_type:'imap',account_email:'me@owner.example',send_capable:true}]}};
   if(method==='collection.mail.chat_door.recent')return{result:{requests:[]}};
   if(method==='collection.mail.chat_door.check')return{result:{ready:!state.failCheck,checks:state.failCheck?[{kind:'owner_mailbox',slug:'me',status:'fail',text:'Its Sent folder is unavailable.'}]:[]}};
   if(method==='collection.mail.chat_door.set'){
    if(state.failSet)return{error:{code:'UNAVAILABLE',message:'Email chat could not be saved. Try again.'}};
    const patch=args as MailChatDoorSetArgs;
    settings={...settings,...(patch.chat_mailbox!==undefined?{chat_mailbox:patch.chat_mailbox,chat_address:patch.chat_mailbox===null?null:'recued@chat.example'}:{}),...(patch.owner_mailboxes!==undefined?{owner_mailboxes:patch.owner_mailboxes}:{}),...(patch.ask_prefix!==undefined?{ask_prefix:patch.ask_prefix}:{}),...(patch.stale_after_minutes!==undefined?{stale_after_minutes:patch.stale_after_minutes}:{}),...(patch.resume?{paused_at:null}:{})};
    return{result:structuredClone(settings)};
   }
   return undefined;
  }});
 },on);
 await page.goto(`${HARNESS_URL}?settle_reads=1#settings/account`);await page.waitForFunction(()=>window.__app?.ready===true);
};
const activate=async(page:Page)=>{await page.evaluate(()=>window.__app.setHash('#settings/email-chat'));await expect(panel(page)).toHaveAttribute('data-recued-mail-chat-door-state',/^(off|on)$/);};
const calls=(page:Page,method:string)=>page.evaluate(method=>window.__emailChatNavigation.calls.filter(call=>call.method===method),method);
const errors=new WeakMap<Page,string[]>();
test.beforeEach(({page})=>{const list:string[]=[];errors.set(page,list);page.on('pageerror',error=>list.push(error.message));});
test.afterEach(({page})=>{expect(errors.get(page)).toEqual([]);});

for(const width of [390,1280]){
 test(`Email chat protects settings drafts from canceled navigation and releases reverted edits at ${width}px`,async({page})=>{
  await open(page,width);await activate(page);await at(page,'prefix').fill('hello:');await at(page,'stale').fill('90');
  expect(await unloadBlocked(page)).toBe(true);await leave(page);await expect(page).toHaveURL(/#settings\/email-chat$/);
  expect(await page.evaluate(()=>window.__emailChatNavigation.prompts)).toEqual([draftPrompt]);
  await expect(at(page,'prefix')).toHaveValue('hello:');await expect(at(page,'stale')).toHaveValue('90');
  await at(page,'prefix').fill('ask:');await at(page,'stale').fill('60');expect(await unloadBlocked(page)).toBe(false);
  await leave(page);await expect(page).toHaveURL(/#chat$/);expect(await calls(page,'collection.mail.chat_door.set')).toEqual([]);
 });
 test(`Email chat guards checks that can enable the door before any save is sent at ${width}px`,async({page})=>{
  await open(page,width,false);await activate(page);await at(page,'chat-pick').selectOption('recued-chat');
  await panel(page).locator('[data-recued-mail-chat-door-owner-pick="me"]').check();await at(page,'confirm').check();
  await page.evaluate(()=>{window.__emailChatNavigation.failCheck=true;window.__app.holdRpcResponses?.('collection.mail.chat_door.check');});
  await press(page,'turn-on');await expect(at(page,'turn-on')).toHaveText('Checking…');
  expect(await unloadBlocked(page)).toBe(true);await leave(page);await expect(page).toHaveURL(/#settings\/email-chat$/);
  expect(await page.evaluate(()=>window.__emailChatNavigation.prompts)).toEqual([workPrompt]);
  await release(page,'collection.mail.chat_door.check');await expect(panel(page).getByText('Its Sent folder is unavailable.',{exact:false})).toBeVisible();
  expect(await calls(page,'collection.mail.chat_door.set')).toEqual([]);
 });
 test(`Email chat reads only on activation and preserves drafts across Settings tabs at ${width}px`,async({page})=>{
  await open(page,width);expect(await calls(page,'collection.mail.chat_door.get')).toEqual([]);await activate(page);
  expect(await unloadBlocked(page)).toBe(false);await at(page,'prefix').fill('later:');
  await page.evaluate(()=>window.__app.setHash('#settings/account'));await expect(panel(page)).toBeHidden();
  await activate(page);await expect(at(page,'prefix')).toHaveValue('later:');
  expect(await page.evaluate(()=>window.__emailChatNavigation.prompts)).toEqual([]);
  expect(await calls(page,'collection.mail.chat_door.set')).toEqual([]);
 });
 test(`Email chat protects an address draft and discards it only after accepted departure at ${width}px`,async({page})=>{
  await open(page,width);await activate(page);await at(page,'enrol-input').fill('unfinished@personal.example');
  expect(await unloadBlocked(page)).toBe(true);await leave(page);await expect(page).toHaveURL(/#settings\/email-chat$/);
  await expect(at(page,'enrol-input')).toHaveValue('unfinished@personal.example');
  await page.evaluate(()=>{window.confirm=message=>{window.__emailChatNavigation.prompts.push(message??'');return true;};});
  await leave(page);await expect(page).toHaveURL(/#chat$/);await activate(page);
  await expect(at(page,'enrol-input')).toHaveValue('');expect(await unloadBlocked(page)).toBe(false);
  expect(await calls(page,'collection.mail.chat_door.set')).toEqual([]);
  expect(await page.evaluate(()=>window.__emailChatNavigation.prompts)).toEqual([draftPrompt,draftPrompt]);
 });
 test(`Email chat protects setup choices and permits leaving after they are reverted at ${width}px`,async({page})=>{
  await open(page,width,false);await activate(page);expect(await unloadBlocked(page)).toBe(false);
  await at(page,'chat-pick').selectOption('recued-chat');await panel(page).locator('[data-recued-mail-chat-door-owner-pick="me"]').check();await at(page,'confirm').check();
  await leave(page);await expect(page).toHaveURL(/#settings\/email-chat$/);await expect(at(page,'chat-pick')).toHaveValue('recued-chat');await expect(at(page,'confirm')).toBeChecked();
  await at(page,'confirm').uncheck();await panel(page).locator('[data-recued-mail-chat-door-owner-pick="me"]').uncheck();await at(page,'chat-pick').selectOption('');
  expect(await unloadBlocked(page)).toBe(false);await leave(page);await expect(page).toHaveURL(/#chat$/);
  expect(await calls(page,'collection.mail.chat_door.check')).toEqual([]);expect(await calls(page,'collection.mail.chat_door.set')).toEqual([]);
 });
 test(`Email chat guards a pending save and clears only the acknowledged draft at ${width}px`,async({page})=>{
  await open(page,width);await activate(page);await at(page,'prefix').fill('hello:');await at(page,'stale').fill('90');await at(page,'enrol-input').fill('still.a.draft@personal.example');
  await page.evaluate(()=>window.__app.holdRpcResponses?.('collection.mail.chat_door.set'));await press(page,'save');
  await expect(at(page,'save')).toBeDisabled();await at(page,'save').evaluate(button=>(button as HTMLButtonElement).click());
  expect(await calls(page,'collection.mail.chat_door.set')).toEqual([{method:'collection.mail.chat_door.set',args:{ask_prefix:'hello:',stale_after_minutes:90}}]);
  expect(await unloadBlocked(page)).toBe(true);await leave(page);await expect(page).toHaveURL(/#settings\/email-chat$/);
  expect(await page.evaluate(()=>window.__emailChatNavigation.prompts)).toEqual([workPrompt]);
  await release(page,'collection.mail.chat_door.set');await expect(at(page,'save')).toBeEnabled();await expect(at(page,'enrol-input')).toHaveValue('still.a.draft@personal.example');
  await leave(page);await expect(page).toHaveURL(/#settings\/email-chat$/);
  expect(await page.evaluate(()=>window.__emailChatNavigation.prompts)).toEqual([workPrompt,draftPrompt]);
  await at(page,'enrol-input').fill('');expect(await unloadBlocked(page)).toBe(false);await leave(page);await expect(page).toHaveURL(/#chat$/);
 });
 test(`Email chat ignores a refused save after an accepted departure at ${width}px`,async({page})=>{
  await open(page,width);await activate(page);await at(page,'prefix').fill('hello:');
  await page.evaluate(()=>{window.__emailChatNavigation.failSet=true;window.__app.holdRpcResponses?.('collection.mail.chat_door.set');window.confirm=message=>{window.__emailChatNavigation.prompts.push(message??'');return true;};});
  await press(page,'save');await expect(at(page,'save')).toBeDisabled();await leave(page);await expect(page).toHaveURL(/#chat$/);
  const input=page.locator('[data-recued-chat-route-input]');await input.focus();await release(page,'collection.mail.chat_door.set');
  await expect(input).toBeFocused();await expect(panel(page)).toHaveCount(0);await expect(page.locator('[data-recued-mail-chat-door-error]')).toHaveCount(0);
  expect(await page.evaluate(()=>window.__emailChatNavigation.prompts)).toEqual([workPrompt]);
 });
 test(`Email chat releases setup ownership after successful enable and confirmed turn-off at ${width}px`,async({page})=>{
  await open(page,width,false);await activate(page);await at(page,'chat-pick').selectOption('recued-chat');await panel(page).locator('[data-recued-mail-chat-door-owner-pick="me"]').check();await at(page,'confirm').check();
  await press(page,'turn-on');await expect(panel(page)).toHaveAttribute('data-recued-mail-chat-door-state','on');
  await expect(panel(page).getByText('Waiting for your email…',{exact:true})).toBeVisible();expect(await unloadBlocked(page)).toBe(false);
  await press(page,'turn-off');await press(page,'keep-on');expect(await calls(page,'collection.mail.chat_door.set')).toHaveLength(1);
  await press(page,'turn-off');await press(page,'turn-off-confirm');await expect(panel(page)).toHaveAttribute('data-recued-mail-chat-door-state','off');
  expect(await unloadBlocked(page)).toBe(false);await leave(page);await expect(page).toHaveURL(/#chat$/);
  expect(await calls(page,'collection.mail.chat_door.set')).toEqual([{method:'collection.mail.chat_door.set',args:{chat_mailbox:'recued-chat',owner_mailboxes:['me']}},{method:'collection.mail.chat_door.set',args:{chat_mailbox:null}}]);
 });

 test(`Email chat retries a failed refresh beside the retained rules without losing a draft at ${width}px`,async({page})=>{
  await open(page,width);await activate(page);await at(page,'prefix').fill('later:');
  await page.evaluate(()=>{window.__emailChatNavigation.failRead=true;window.__app.setHash('#settings/account');});
  await expect(panel(page)).toBeHidden();await page.evaluate(()=>window.__app.setHash('#settings/email-chat'));
  await expect(panel(page)).toHaveAttribute('data-recued-mail-chat-door-state','error');
  await expect(panel(page).getByRole('alert')).toHaveText('Email chat could not be refreshed.');await expect(at(page,'prefix')).toHaveValue('later:');
  await page.evaluate(()=>window.__app.holdRpcResponses?.('collection.mail.chat_door.get'));await press(page,'retry');
  await expect(at(page,'retry')).toHaveAttribute('aria-busy','true');await expect(at(page,'retry')).toBeFocused();
  await at(page,'retry').press('Enter');expect(await calls(page,'collection.mail.chat_door.get')).toHaveLength(3);
  await release(page,'collection.mail.chat_door.get');await expect(panel(page)).toHaveAttribute('data-recued-mail-chat-door-state','on');
  await expect(at(page,'retry')).toHaveCount(0);await expect(at(page,'prefix')).toHaveValue('later:');await expect(at(page,'prefix-on')).toBeFocused();
  expect(await unloadBlocked(page)).toBe(true);expect(await calls(page,'collection.mail.chat_door.set')).toEqual([]);
 });

}
