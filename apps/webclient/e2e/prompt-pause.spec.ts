import { expect,test,type Page } from '@playwright/test';
import type { PromptSchedule } from '@recued/contracts';
import { HARNESS_URL,installFullAppHooks } from './helpers/full-app.js';
import { installPromptRecoveryFixture,PROMPT_RECOVERY_NOW as NOW } from './helpers/prompt-recovery-fixture.js';

installFullAppHooks();test.use({timezoneId:'America/Los_Angeles'});
const panel=(page:Page)=>page.locator('[data-prompt-schedules]');
const card=(page:Page,row:PromptSchedule)=>panel(page).locator(`[data-schedule-id="${row.schedule_id}"]`);
const form=(page:Page)=>panel(page).getByRole('region',{name:'Pause recurring prompt',exact:true});
const address=(row:PromptSchedule)=>'#automation/schedules/prompt/'+row.schedule_id;
const go=async(page:Page,hash:string)=>{await page.goto(`${HARNESS_URL}?journey=verification&recipes=installed&server_profiles=multiple&chat=session${hash}`);await page.waitForFunction(()=>window.__app?.ready===true);};
const setup=async(page:Page)=>{await page.clock.setFixedTime(new Date(NOW));const f=await installPromptRecoveryFixture(page),saved=await f.seed({cron_expression:'0 9 * * *'});return {f,saved};};
const open=async(page:Page,row:PromptSchedule)=>{await card(page,row).getByRole('button',{name:'Pause until…',exact:true}).focus();await page.keyboard.press('Enter');await expect(form(page).getByLabel('Resume time (America/New_York)',{exact:true})).toBeFocused();};
const confirm=async(page:Page)=>{const b=form(page).getByRole('button',{name:'Pause this prompt',exact:true});await expect(b).toBeEnabled();await b.focus();await page.keyboard.press('Enter');};

test('previews calendar-day presets across DST, pauses by keyboard, and resumes without changing the saved request',async({page},info)=>{
  const {f,saved}=await setup(page);
  try{
    await page.setViewportSize({width:390,height:900});await go(page,address(saved));await open(page,saved);
    await expect(form(page).locator('time').nth(0)).toHaveAttribute('datetime','2026-11-01T14:00:00.000Z');await expect(form(page).locator('time').nth(1)).toHaveAttribute('datetime','2026-11-01T14:00:00.000Z');
    expect(f.pauseRequests).toEqual([]);await form(page).getByRole('button',{name:'Next week at 9am',exact:true}).click();await expect(form(page).locator('time').nth(0)).toHaveAttribute('datetime','2026-11-07T14:00:00.000Z');
    await form(page).getByRole('button',{name:'Tomorrow at 9am',exact:true}).click();await expect(form(page).locator('time').nth(0)).toHaveAttribute('datetime','2026-11-01T14:00:00.000Z');
    await form(page).getByRole('heading',{name:'Pause until',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath('prompt-pause-phone.png'),animations:'disabled'});
    await confirm(page);await expect(card(page,saved).getByRole('button',{name:'Resume now',exact:true})).toBeVisible();await expect(card(page,saved)).toContainText('Paused until');
    expect(await f.get(saved.schedule_id)).toMatchObject({enabled:false,revision:2,prompt:saved.prompt,cron_expression:saved.cron_expression,timed_pause:{until_at:Date.parse('2026-11-01T14:00Z')}});
    await card(page,saved).getByRole('button',{name:'Resume now',exact:true}).click();await expect(card(page,saved).getByRole('button',{name:'Pause',exact:true})).toBeVisible();expect((await f.get(saved.schedule_id)).timed_pause).toBeNull();
    expect(f.pauseRequests).toHaveLength(1);expect(f.creates).toEqual([]);expect(f.runs()).toBe(0);
  }finally{f.dispose();}
});
test('validates custom times and keeps failed or malformed previews read-only',async({page})=>{
  const {f,saved}=await setup(page);
  try{
    await go(page,address(saved));f.nextPausePreview('fail');await open(page,saved);await expect(form(page).getByRole('alert')).toContainText('interrupted');await expect(form(page).getByRole('button',{name:'Pause this prompt',exact:true})).toBeDisabled();
    f.nextPausePreview('bad-ack');await form(page).getByRole('button',{name:'Retry pause preview',exact:true}).click();await expect(form(page).getByRole('alert')).toContainText('could not be confirmed');
    const input=form(page).getByLabel('Resume time (America/New_York)',{exact:true});await input.fill('2026-10-30T09:00');await input.press('Tab');await expect(form(page).getByRole('alert')).toContainText('future time');
    await input.fill('2027-03-14T02:30');await input.press('Tab');await expect(form(page).getByRole('alert')).toContainText('exists');
    await input.fill('2026-11-02T12:30');await input.press('Tab');await expect(form(page).locator('time').nth(0)).toHaveAttribute('datetime','2026-11-02T17:30:00.000Z');await expect(form(page).locator('time').nth(1)).toHaveAttribute('datetime','2026-11-03T14:00:00.000Z');
    await form(page).getByRole('button',{name:'Keep current timing',exact:true}).click();await expect(card(page,saved).getByRole('button',{name:'Pause until…',exact:true})).toBeFocused();expect(f.pauseRequests).toEqual([]);expect((await f.get(saved.schedule_id)).revision).toBe(1);
  }finally{f.dispose();}
});
test('checks a lost or malformed mutation reply with the original request across reload without pausing twice',async({page})=>{
  const {f,saved}=await setup(page);
  try{
    await go(page,address(saved));await open(page,saved);f.nextPause('lost');await confirm(page);await expect(card(page,saved).getByRole('button',{name:'Check timed pause',exact:true})).toBeVisible();expect((await f.get(saved.schedule_id)).revision).toBe(2);
    await page.reload();await page.waitForFunction(()=>window.__app?.ready===true);await card(page,saved).getByRole('button',{name:'Check timed pause',exact:true}).click();
    await expect(card(page,saved).getByRole('button',{name:'Change resume time',exact:true})).toBeVisible();expect(f.pauseRequests[1]).toEqual(f.pauseRequests[0]);expect((await f.get(saved.schedule_id)).revision).toBe(2);
    await card(page,saved).getByRole('button',{name:'Change resume time',exact:true}).click();await form(page).getByRole('button',{name:'Next week at 9am',exact:true}).click();f.nextPause('bad-ack');await confirm(page);
    await expect(card(page,saved).getByRole('button',{name:'Check timed pause',exact:true})).toBeVisible();await card(page,saved).getByRole('button',{name:'Check timed pause',exact:true}).click();
    await expect(card(page,saved).getByRole('button',{name:'Change resume time',exact:true})).toBeVisible();expect(f.pauseRequests[3]).toEqual(f.pauseRequests[2]);expect((await f.get(saved.schedule_id)).revision).toBe(3);expect(f.runs()).toBe(0);
  }finally{f.dispose();}
});
test('refuses a stale confirmation and ignores a late preview after leaving its prompt',async({page})=>{
  const {f,saved}=await setup(page);
  try{
    const other=await f.seed({title:'Oriole briefing'});await go(page,address(saved));await open(page,saved);await expect(form(page).getByRole('button',{name:'Pause this prompt',exact:true})).toBeEnabled();
    await f.update({schedule_id:saved.schedule_id,expected_revision:1,cron_expression:'0 10 * * *'});await confirm(page);
    await expect(panel(page).getByRole('alert').first()).toContainText(/changed|Refresh/i);expect(await f.get(saved.schedule_id)).toMatchObject({enabled:true,revision:2,timed_pause:null});
    f.nextPausePreview('hold');await open(page,await f.get(saved.schedule_id));await expect.poll(f.pausePreviewPending).toBe(true);
    await page.evaluate(hash=>window.__app.setHash(hash),address(other));f.releasePausePreview();await expect(card(page,other)).toBeVisible();await expect(form(page)).toHaveCount(0);expect(f.pauseRequests).toHaveLength(1);
  }finally{f.dispose();}
});
test('capability-gates timed pauses and keeps the Chat composer while showing and clearing a saved deadline',async({page})=>{
  const {f,saved}=await setup(page);
  try{
    const once=await f.seed({title:'One-off',mode:'one_shot',cron_expression:undefined,run_at:new Date(NOW+3600000).toISOString()});await go(page,'#automation/schedules');await expect(card(page,once).getByRole('button',{name:'Pause until…',exact:true})).toHaveCount(0);
    f.capabilities('old');await page.reload();await page.waitForFunction(()=>window.__app?.ready===true);await expect(panel(page).getByRole('button',{name:'Pause until…',exact:true})).toHaveCount(0);f.capabilities('current');
    await go(page,'#chat/session/'+saved.session_id);const composer=page.locator('[data-recued-chat-route-input]');await composer.fill('Keep this chat draft.');await panel(page).locator('[data-prompt-schedule-compact] > summary').click();await open(page,saved);await confirm(page);
    await expect(card(page,saved).getByRole('button',{name:'Resume now',exact:true})).toBeVisible();await expect(composer).toHaveValue('Keep this chat draft.');await card(page,saved).getByRole('button',{name:'Resume now',exact:true}).click();
    await expect(card(page,saved).getByRole('button',{name:'Pause',exact:true})).toBeVisible();await expect(composer).toHaveValue('Keep this chat draft.');expect(f.runs()).toBe(0);expect(f.creates).toEqual([]);
  }finally{f.dispose();}
});
