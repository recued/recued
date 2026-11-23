import { expect, test, type Page } from '@playwright/test';
import type { PromptSchedule } from '@recued/contracts';
import { HARNESS_URL, installFullAppHooks } from './helpers/full-app.js';
import { installPromptRecoveryFixture, PROMPT_RECOVERY_NOW as NOW } from './helpers/prompt-recovery-fixture.js';

installFullAppHooks(); test.use({ timezoneId: 'America/Los_Angeles' });
const panel = (page:Page) => page.locator('[data-prompt-schedules]');
const card = (page:Page,row:PromptSchedule) => panel(page).locator(`[data-schedule-id="${row.schedule_id}"]`);
const history = (page:Page,row:PromptSchedule) => card(page,row).getByRole('region',{name:'Recent runs for '+row.title,exact:true});
const rows = (page:Page,row:PromptSchedule) => history(page,row).locator('[data-prompt-run-id]');
const run = (page:Page,row:PromptSchedule,id:string) => rows(page,row).filter({has:page.locator(`a[href$="/answer/${id}"]`)});
const address = (row:PromptSchedule) => '#automation/schedules/prompt/'+row.schedule_id;
const go = async (page:Page,hash:string) => {
  await page.goto(`${HARNESS_URL}?journey=verification&recipes=installed&server_profiles=multiple&chat=session${hash}`);
  await page.waitForFunction(()=>window.__app?.ready===true);
};
const open = async (page:Page,row:PromptSchedule) => {
  await card(page,row).locator('.prompt-run-history > summary').focus(); await page.keyboard.press('Enter');
};
const setup = async (page:Page,count=0) => {
  await page.clock.setFixedTime(new Date(NOW)); const f=await installPromptRecoveryFixture(page);
  const saved=await f.seed({title:'Kestrel briefing'});
  for(let i=0;i<count;i++) await f.seedRun(saved,{key:String(i),trigger:i===count-1?'manual':'scheduled',due_at:NOW-3600000+i*60000,answer:'Recorded answer '+i});
  return {f,saved};
};
const idleReplies = (page:Page,count:number) => page.waitForFunction(n=>(window as unknown as {__promptHistoryReplies:number}).__promptHistoryReplies>=n,count);
const readOnly = (f:Awaited<ReturnType<typeof installPromptRecoveryFixture>>) => {
  expect(f.runs()).toBe(0); expect(f.creates).toEqual([]); expect(f.updates).toEqual([]); expect(f.skipChanges).toEqual([]);
  expect(f.calls.filter(call=>['chat.schedule.run_now','chat.plan.approve','chat.send'].includes(call.method))).toEqual([]);
};

test('lazily reads real runs, keeps historical timezones and keyboard paging, and opens an exact answer',async ({page},info)=>{
  const {f,saved}=await setup(page,23);
  try {
    await f.update({schedule_id:saved.schedule_id,expected_revision:saved.revision,time_zone:'Asia/Tokyo'});
    await page.setViewportSize({width:390,height:900});
    await go(page,address(saved)); expect(f.historyRequests).toEqual([]); await open(page,saved);
    await expect(rows(page,saved)).toHaveCount(10);
    const latest=run(page,saved,'history-answer-22'); await expect(latest).toContainText('Run now'); await expect(latest).toContainText('Finished');
    await expect(latest.locator('time')).toHaveAttribute('datetime',new Date(NOW-3600000+22*60000).toISOString());
    await expect(latest.locator('time')).toContainText('GMT-4'); await expect(rows(page,saved).nth(1)).toContainText('Scheduled');
    await card(page,saved).locator('.prompt-run-history > summary').scrollIntoViewIfNeeded();
    await page.screenshot({path:info.outputPath('prompt-runs-phone.png'),animations:'disabled'});
    const original=await rows(page,saved).evaluateAll(els=>els.map(el=>(el as HTMLElement).dataset.promptRunId));
    const more=history(page,saved).getByRole('button',{name:'Load more runs',exact:true}); await more.focus(); await page.keyboard.press('Enter');
    await expect(rows(page,saved)).toHaveCount(20);
    expect((await rows(page,saved).evaluateAll(els=>els.map(el=>(el as HTMLElement).dataset.promptRunId))).slice(0,10)).toEqual(original);
    await expect(rows(page,saved).nth(10).getByRole('link')).toBeFocused();
    await more.focus(); await page.keyboard.press('Enter'); await expect(rows(page,saved)).toHaveCount(23); await expect(more).toBeHidden();
    expect(f.historyRequests).toHaveLength(3);
    await run(page,saved,'history-answer-22').getByRole('link',{name:'Open run',exact:true}).click();
    await expect(page).toHaveURL(new RegExp('/answer/history-answer-22$'));
    await expect(page.locator('[data-recued-chat-route-message="history-answer-22"]')).toContainText('Recorded answer 22');
    readOnly(f);
  }finally{f.dispose();}
});

test('keeps confirmed pages and the same cursor after failed or wrong-target older reads',async ({page})=>{
  const {f,saved}=await setup(page,23);
  try {
    await go(page,address(saved)); await open(page,saved); await expect(rows(page,saved)).toHaveCount(10);
    const more=history(page,saved).getByRole('button',{name:'Load more runs',exact:true});
    f.nextHistory('fail'); await more.click(); await expect(history(page,saved).getByRole('alert')).toContainText('interrupted');
    await expect(rows(page,saved)).toHaveCount(10); expect(f.historyRequests[1]?.cursor).toBeTruthy();
    f.nextHistory('wrong-target'); await more.click(); await expect(history(page,saved).getByRole('alert')).toContainText('could not be confirmed');
    await expect(rows(page,saved)).toHaveCount(10); expect(f.historyRequests[2]).toEqual(f.historyRequests[1]);
    await more.click(); await expect(rows(page,saved)).toHaveCount(20); expect(f.historyRequests[3]).toEqual(f.historyRequests[1]);
    await expect(history(page,saved).getByRole('alert')).toBeHidden(); readOnly(f);
  }finally{f.dispose();}
});

test('an explicit refresh supersedes a held older page without accepting its late reply',async ({page})=>{
  const {f,saved}=await setup(page,23);
  try {
    await go(page,address(saved)); await open(page,saved); await expect(rows(page,saved)).toHaveCount(10);
    f.nextHistory('hold'); await history(page,saved).getByRole('button',{name:'Load more runs',exact:true}).click(); await expect.poll(f.historyPending).toBe(true);
    await f.seedRun(saved,{key:'fresh',due_at:NOW,answer:'Newest recorded answer'});
    await history(page,saved).getByRole('button',{name:'Refresh runs',exact:true}).click();
    await expect(run(page,saved,'history-answer-fresh')).toBeVisible(); await expect(rows(page,saved)).toHaveCount(10);
    f.releaseHistory(); await idleReplies(page,3);
    await expect(run(page,saved,'history-answer-fresh')).toBeVisible(); await expect(rows(page,saved)).toHaveCount(10);
    await expect(history(page,saved).getByRole('button',{name:'Load more runs',exact:true})).toBeEnabled(); readOnly(f);
  }finally{f.dispose();}
});

test('background card refreshes retain expanded older pages and mark activity until explicitly refreshed',async ({page})=>{
  const {f,saved}=await setup(page,23);
  try {
    await go(page,address(saved)); await open(page,saved); await expect(rows(page,saved)).toHaveCount(10);
    await history(page,saved).getByRole('button',{name:'Load more runs',exact:true}).click(); await expect(rows(page,saved)).toHaveCount(20);
    await f.seedRun(saved,{key:'background',due_at:NOW,answer:'New background answer'}); f.overlay(saved.schedule_id,{last_run_at:NOW});
    await panel(page).getByRole('button',{name:'Refresh',exact:true}).click();
    await expect(history(page,saved).getByRole('status')).toHaveText('Run activity changed. Refresh to update this list.');
    await expect(rows(page,saved)).toHaveCount(20); expect(f.historyRequests).toHaveLength(2);
    await expect(card(page,saved).locator('.prompt-run-history')).toHaveAttribute('open','');
    await history(page,saved).getByRole('button',{name:'Refresh runs',exact:true}).click();
    await expect(rows(page,saved)).toHaveCount(10); await expect(run(page,saved,'history-answer-background')).toBeVisible();
    await expect(history(page,saved).getByRole('status')).not.toContainText('changed'); readOnly(f);
  }finally{f.dispose();}
});

test('a held reply cannot overwrite another prompt after navigating away',async ({page})=>{
  const {f,saved}=await setup(page,12);
  try {
    const other=await f.seed({title:'Oriole briefing'}); await f.seedRun(other,{key:'oriole',due_at:NOW,answer:'Oriole answer'});
    await go(page,address(saved)); f.nextHistory('hold'); await open(page,saved); await expect.poll(f.historyPending).toBe(true);
    await page.evaluate(hash=>window.__app.setHash(hash),address(other)); await open(page,other);
    await expect(rows(page,other)).toHaveCount(1); f.releaseHistory(); await idleReplies(page,2);
    await expect(rows(page,other)).toHaveCount(1); await expect(run(page,other,'history-answer-oriole')).toBeVisible();
    await expect(card(page,saved)).toHaveCount(0); readOnly(f);
  }finally{f.dispose();}
});

test('distinguishes errors from empty history, capability-gates old servers, and keeps the Chat composer and exact approval link',async ({page})=>{
  const {f,saved}=await setup(page);
  try {
    await go(page,address(saved)); f.nextHistory('fail'); await open(page,saved);
    await expect(history(page,saved).getByRole('alert')).toContainText('interrupted'); await expect(history(page,saved)).not.toContainText('No runs recorded');
    await history(page,saved).getByRole('button',{name:'Refresh runs',exact:true}).click(); await expect(history(page,saved)).toContainText('No runs recorded');
    f.capabilities('old'); await page.reload(); await page.waitForFunction(()=>window.__app?.ready===true);
    await expect(card(page,saved).locator('.prompt-run-history')).toHaveCount(0); expect(f.historyRequests).toHaveLength(2);
    f.capabilities('current'); const seeded=await f.seedRun(saved,{key:'approval',due_at:NOW,answer:'Draft ready for review'});
    const message=await f.seedPlan(saved,seeded.turn_id,'history-mail-review');
    await go(page,'#chat/session/'+saved.session_id);
    const composer=page.locator('[data-recued-chat-route-input]'); await composer.fill('Keep this draft while reviewing runs.');
    await panel(page).locator('[data-prompt-schedule-compact] > summary').click(); await open(page,saved);
    await expect(rows(page,saved)).toHaveCount(1); await expect(rows(page,saved)).toContainText('Needs approval');
    await expect(rows(page,saved).getByRole('link',{name:'Review approval',exact:true})).toHaveAttribute('href',`#chat/session/${saved.session_id}/plan/history-mail-review/answer/${message}`);
    await history(page,saved).getByRole('button',{name:'Refresh runs',exact:true}).click();
    await expect(history(page,saved).getByRole('status')).toContainText('1 recorded run loaded');
    await expect(composer).toHaveValue('Keep this draft while reviewing runs.'); readOnly(f);
  }finally{f.dispose();}
});
