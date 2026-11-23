import { expect,test,type Page } from '@playwright/test';
import type { ServerTimeZoneGetResponse,ServerTimeZoneSetRequest } from '@recued/contracts';
import { HARNESS_URL,installFullAppHooks } from './helpers/full-app.js';
import { installPromptRecoveryFixture,PROMPT_RECOVERY_NOW as NOW } from './helpers/prompt-recovery-fixture.js';

installFullAppHooks();test.use({timezoneId:'America/Los_Angeles'});
const AT=Date.parse('2026-06-15T20:00Z');
const server=(page:Page)=>page.locator('[data-recued-server-timezone-panel]');
const zone=(page:Page)=>server(page).getByRole('combobox',{name:'Server timezone',exact:true});
const form=(page:Page)=>page.locator('[data-prompt-schedules] form');
const promptZone=(page:Page)=>form(page).getByRole('combobox',{name:'Recurring timezone',exact:true});
const option=(page:Page,id:string)=>page.getByRole('option',{name:id,exact:true});
type TimezoneFixture={writes:ServerTimeZoneSetRequest[];lost:boolean;hold:boolean;pending:boolean;release():void};
declare global {interface Window {__timezonePickerTest:TimezoneFixture}}
const openSettings=async(page:Page,saved='Europe/London',resolved=saved)=>{
  await page.clock.setFixedTime(new Date(AT));
  await page.evaluate(({saved,resolved})=>{
    let snapshot:ServerTimeZoneGetResponse={setting:{mode:'fixed',zone:saved,updated_at:1},resolved_zone:resolved,host_zone:'Europe/London'},release:(()=>void)|undefined;
    const f:TimezoneFixture={writes:[],lost:false,hold:false,pending:false,release(){if(!release)throw Error('No held timezone read.');const done=release;release=undefined;f.pending=false;done();}};
    Object.assign(window,{__timezonePickerTest:f,__connectionsFixture:async(method:string,args:unknown)=>{
      if(method==='server.timezone.get'){
        if(f.hold){f.hold=false;f.pending=true;await new Promise<void>(done=>{release=done;});}return {result:structuredClone(snapshot)};
      }
      if(method==='server.timezone.set'){
        const input=args as ServerTimeZoneSetRequest;f.writes.push(structuredClone(input));
        const chosen=input.zone??snapshot.setting.zone!;snapshot={setting:{mode:input.mode,zone:chosen,updated_at:snapshot.setting.updated_at+1},resolved_zone:input.mode==='fixed'?new Intl.DateTimeFormat('en',{timeZone:chosen}).resolvedOptions().timeZone:snapshot.host_zone,host_zone:snapshot.host_zone};
        if(f.lost){f.lost=false;return {error:{code:'timeout',message:'The timezone save reply was lost.'}};}return {result:structuredClone(snapshot)};
      }
      return undefined;
    }});
    window.__app.setHash('#settings/server/timezone');
  },{saved,resolved});
  await expect(zone(page)).toBeVisible();await expect(zone(page)).toHaveValue(saved);
};
const writes=(page:Page)=>page.evaluate(()=>window.__timezonePickerTest.writes);
const goPrompts=async(page:Page)=>{
  await page.goto(`${HARNESS_URL}?journey=verification&recipes=installed&server_profiles=multiple&chat=session#automation/schedules`);await page.waitForFunction(()=>window.__app?.ready===true);
};

test('chooses a city with the keyboard without saving, then preserves Enter-to-save for selected and typed IDs',async({page})=>{
  await openSettings(page);await zone(page).focus();await zone(page).press('ControlOrMeta+A');await page.keyboard.type('new york');
  // Native typing groups can differ while search results update. The complete
  // original and query must remain reachable through Undo and Redo.
  let undoSteps=0;while((await zone(page).inputValue())!=='Europe/London'&&undoSteps<10){await page.keyboard.press('ControlOrMeta+z');undoSteps++;}
  await expect(zone(page)).toHaveValue('Europe/London');for(let step=0;step<undoSteps;step++)await page.keyboard.press('ControlOrMeta+Shift+z');await expect(zone(page)).toHaveValue('new york');
  await expect(option(page,'America/New_York')).toBeVisible();await expect(option(page,'America/New_York')).toContainText('GMT-4');
  await zone(page).press('Enter');expect(await writes(page)).toEqual([]);await expect(zone(page)).toHaveValue('new york');
  await zone(page).press('ArrowDown');await expect(zone(page)).toHaveAttribute('aria-activedescendant',/timezone-choices-/);
  await zone(page).evaluate(input=>input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,isComposing:true})));expect(await writes(page)).toEqual([]);await expect(zone(page)).toHaveValue('new york');
  await page.keyboard.down('Enter');await expect(zone(page)).toHaveValue('America/New_York');await expect(zone(page)).toHaveAttribute('aria-expanded','false');await page.keyboard.down('Enter');expect(await writes(page)).toEqual([]);await page.keyboard.up('Enter');
  await zone(page).press('Enter');await expect.poll(()=>writes(page)).toEqual([{mode:'fixed',zone:'America/New_York'}]);await expect(server(page).locator('[data-recued-server-timezone-clock-role="authoritative"]')).toContainText('America/New_York');
  await zone(page).fill('Europe/Paris');await zone(page).press('Enter');await expect.poll(()=>writes(page)).toEqual([{mode:'fixed',zone:'America/New_York'},{mode:'fixed',zone:'Europe/Paris'}]);
});

test('shows local date, time and offset and selects by pointer on a phone without changing the server until Save',async({page},info)=>{
  await page.setViewportSize({width:390,height:900});await openSettings(page);await zone(page).fill('tokyo');await expect(option(page,'Asia/Tokyo')).toContainText('GMT+9');await expect(option(page,'Asia/Tokyo')).toContainText(/Jun 16/);
  await zone(page).scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath('timezone-picker-phone.png'),animations:'disabled'});
  await option(page,'Asia/Tokyo').click();await expect(zone(page)).toHaveValue('Asia/Tokyo');await expect(zone(page)).toBeFocused();await expect(zone(page)).toHaveAttribute('aria-expanded','false');expect(await writes(page)).toEqual([]);
  await server(page).getByRole('button',{name:'Save',exact:true}).click();await expect.poll(()=>writes(page)).toEqual([{mode:'fixed',zone:'Asia/Tokyo'}]);await expect(server(page).locator('[data-recued-server-timezone-clock-role="authoritative"]')).toContainText('Asia/Tokyo');
});

test('preserves exact saved aliases and unavailable browser clocks instead of replacing their IDs',async({page})=>{
  await openSettings(page,'US/Eastern','America/New_York');await zone(page).focus();await expect(option(page,'US/Eastern')).toBeVisible();await expect(zone(page)).toHaveValue('US/Eastern');await zone(page).press('Escape');expect(await writes(page)).toEqual([]);
  await page.goto(HARNESS_URL);await page.waitForFunction(()=>window.__app?.ready===true);await openSettings(page,'Moon/Base','Europe/London');await zone(page).focus();await expect(option(page,'Moon/Base')).toContainText('Local time unavailable in this browser');await zone(page).press('Escape');
  await expect(zone(page)).toHaveValue('Moon/Base');expect(await writes(page)).toEqual([]);await expect(server(page).locator('[data-recued-server-timezone-clock-role="authoritative"]')).toContainText('Europe/London');
});

test('keeps an active query and highlighted choice connected while an uncertain save is checked',async({page})=>{
  await openSettings(page);await zone(page).fill('tokyo');await zone(page).press('ArrowDown');await zone(page).press('Enter');await page.evaluate(()=>{window.__timezonePickerTest.lost=true;});await server(page).getByRole('button',{name:'Save',exact:true}).click();
  const check=server(page).getByRole('button',{name:'Check saved timezone',exact:true});await expect(check).toBeVisible();expect((await writes(page)).length).toBe(1);
  await page.evaluate(()=>{window.__timezonePickerTest.hold=true;});await check.click();await expect.poll(()=>page.evaluate(()=>window.__timezonePickerTest.pending)).toBe(true);
  await zone(page).fill('new york');await zone(page).press('ArrowDown');const field=await zone(page).elementHandle(),highlight=await zone(page).getAttribute('aria-activedescendant');
  await page.evaluate(()=>window.__timezonePickerTest.release());await expect(check).toHaveCount(0);await expect(zone(page)).toHaveValue('new york');await expect(zone(page)).toBeFocused();expect(await zone(page).evaluate((current,previous)=>current===previous,field)).toBe(true);await expect(zone(page)).toHaveAttribute('aria-activedescendant',highlight!);
  await zone(page).press('Enter');await expect(zone(page)).toHaveValue('America/New_York');expect((await writes(page)).length).toBe(1);await expect(server(page).locator('[data-recued-server-timezone-clock-role="authoritative"]')).toContainText('Asia/Tokyo');
});

test('refreshes the server run preview after selection and restores the selected zone through draft recovery',async({page})=>{
  await page.clock.setFixedTime(new Date(NOW));const f=await installPromptRecoveryFixture(page),saved=await f.seed({title:'Kestrel timezone',time_zone:'UTC',cron_expression:'0 9 * * *'});
  try{
    await goPrompts(page);const card=page.locator(`[data-schedule-id="${saved.schedule_id}"]`);await card.getByRole('button',{name:'Edit',exact:true}).click();await promptZone(page).fill('new york');await promptZone(page).press('ArrowDown');await promptZone(page).press('Enter');
    await expect(promptZone(page)).toHaveValue('America/New_York');const times=form(page).locator('.prompt-schedule-preview time');await expect(times.nth(0)).toHaveAttribute('datetime','2026-10-31T13:00:00.000Z');await expect(times.nth(1)).toHaveAttribute('datetime','2026-11-01T14:00:00.000Z');await expect(times.nth(1)).toContainText('GMT-5');expect(f.updates).toEqual([]);
    await form(page).getByRole('button',{name:'Keep draft for later',exact:true}).click();await page.reload();await page.waitForFunction(()=>window.__app?.ready===true);await page.getByRole('region',{name:'Unfinished scheduled prompts',exact:true}).getByRole('button',{name:'Resume draft',exact:true}).click();
    await expect(promptZone(page)).toHaveValue('America/New_York');await expect(form(page).getByLabel('Title',{exact:true})).toBeFocused();await form(page).getByRole('button',{name:'Save changes',exact:true}).click();await expect(form(page)).toHaveCount(0);
    expect(f.updates).toHaveLength(1);expect(f.updates[0]).toMatchObject({schedule_id:saved.schedule_id,expected_revision:1,time_zone:'America/New_York'});expect((await f.get(saved.schedule_id)).time_zone).toBe('America/New_York');expect(f.runs()).toBe(0);
  }finally{f.dispose();}
});

test('closes suggestions with Escape, blocks city text from submitting, and retires the old picker when editing ends',async({page})=>{
  await page.clock.setFixedTime(new Date(NOW));const f=await installPromptRecoveryFixture(page),saved=await f.seed({title:'Kestrel direct ID',time_zone:'UTC'});
  try{
    await goPrompts(page);const card=page.locator(`[data-schedule-id="${saved.schedule_id}"]`);await card.getByRole('button',{name:'Edit',exact:true}).click();await promptZone(page).fill('not a real city');await expect(form(page).locator('[data-timezone-picker-popup]').getByRole('status')).toContainText('No matching timezones');await expect(page.getByRole('listbox',{name:'Recurring timezone choices',exact:true}).getByRole('option')).toHaveCount(0);await promptZone(page).press('Enter');expect(f.updates).toEqual([]);await expect(form(page)).toBeVisible();
    await promptZone(page).press('Escape');await expect(promptZone(page)).toHaveAttribute('aria-expanded','false');await form(page).getByRole('button',{name:'Cancel',exact:true}).click();await expect(form(page)).toHaveCount(0);await expect(page.getByRole('listbox',{name:'Recurring timezone choices',exact:true})).toHaveCount(0);
    await card.getByRole('button',{name:'Edit',exact:true}).click();await expect(promptZone(page)).toHaveValue('UTC');await promptZone(page).fill('Asia/Tokyo');await promptZone(page).press('Enter');await expect(form(page)).toHaveCount(0);expect(f.updates).toHaveLength(1);expect(f.updates[0]?.time_zone).toBe('Asia/Tokyo');expect(f.runs()).toBe(0);
  }finally{f.dispose();}
});
