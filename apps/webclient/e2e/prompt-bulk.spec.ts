import { expect,test,type Page } from '@playwright/test';
import type { PromptSchedule } from '@recued/contracts';
import { HARNESS_URL,installFullAppHooks } from './helpers/full-app.js';
import { installPromptRecoveryFixture,PROMPT_RECOVERY_NOW as NOW } from './helpers/prompt-recovery-fixture.js';

installFullAppHooks();test.use({timezoneId:'America/Los_Angeles'});
const panel=(page:Page)=>page.locator('[data-prompt-schedules]');
const toolbar=(page:Page)=>panel(page).getByRole('region',{name:'Bulk scheduled prompt controls',exact:true});
const review=(page:Page)=>panel(page).getByRole('region',{name:'Review selected scheduled prompts',exact:true});
const item=(page:Page,row:PromptSchedule)=>review(page).locator(`[data-prompt-bulk-id="${row.schedule_id}"]`);
const go=async(page:Page,hash='#automation/schedules')=>{await page.goto(`${HARNESS_URL}?journey=verification&recipes=installed&server_profiles=multiple&chat=session${hash}`);await page.waitForFunction(()=>window.__app?.ready===true);};
const setup=async(page:Page)=>{await page.clock.setFixedTime(new Date(NOW));const f=await installPromptRecoveryFixture(page),first=await f.seed({title:'Kestrel first',cron_expression:'0 9 * * *'}),second=await f.seed({title:'Kestrel second',cron_expression:'0 9 * * *'});return {f,first,second};};
const selectAll=async(page:Page,count:number)=>{const b=toolbar(page).getByRole('button',{name:`Select all ${count} matching prompts`,exact:true});await b.focus();await page.keyboard.press('Enter');};
const apply=async(page:Page,count:number)=>{const b=review(page).getByRole('button',{name:`Apply ${count} changes`,exact:true});await expect(b).toBeEnabled();await b.focus();await page.keyboard.press('Enter');};

test('selects matching prompts, keeps hidden selections explicit, and changes only the confirmed selection by keyboard',async({page})=>{
  const {f,first,second}=await setup(page);
  try{
    const outside=await f.seed({title:'Oriole briefing'});await go(page);await panel(page).getByRole('checkbox',{name:'Select Oriole briefing',exact:true}).focus();await page.keyboard.press('Space');
    await panel(page).getByRole('searchbox',{name:'Search scheduled prompts',exact:true}).fill('Kestrel');await selectAll(page,2);
    await expect(toolbar(page).getByRole('status').first()).toHaveText('3 selected · 1 outside this filter');await toolbar(page).getByRole('button',{name:'Pause selected',exact:true}).click();
    await expect(review(page).getByRole('button',{name:'Apply 3 changes',exact:true})).toBeEnabled();expect(f.bulkRequests).toEqual([]);
    await review(page).getByRole('button',{name:'Keep current schedules',exact:true}).click();await toolbar(page).getByRole('button',{name:'Clear selection',exact:true}).click();await selectAll(page,2);
    await toolbar(page).getByRole('button',{name:'Pause selected',exact:true}).focus();await page.keyboard.press('Enter');await apply(page,2);
    await expect(review(page).getByRole('status')).toHaveText('2 confirmed · 0 unresolved');expect(f.bulkRequests).toHaveLength(1);
    expect((f.bulkRequests[0]!.items as Array<{schedule_id:string}>).map(i=>i.schedule_id).sort()).toEqual([first.schedule_id,second.schedule_id].sort());
    for(const row of [first,second])expect(await f.get(row.schedule_id)).toMatchObject({enabled:false,revision:2});expect(await f.get(outside.schedule_id)).toMatchObject({enabled:true,revision:1});
    await review(page).getByRole('button',{name:'Done',exact:true}).click();await expect(toolbar(page).getByRole('status')).toHaveText('0 selected');expect(f.runs()).toBe(0);
  }finally{f.dispose();}
});
test('previews each prompt timezone and first run on a phone, and excludes unsupported one-off prompts from the timed change',async({page},info)=>{
  const {f,first,second}=await setup(page);
  try{
    await f.update({schedule_id:second.schedule_id,expected_revision:1,time_zone:'Asia/Tokyo'});
    const once=await f.seed({title:'One-off',mode:'one_shot',cron_expression:undefined,run_at:new Date(NOW+60000).toISOString()});await page.setViewportSize({width:390,height:900});await go(page);await selectAll(page,3);
    await toolbar(page).getByRole('button',{name:'Pause until selected…',exact:true}).click();const time=review(page).getByLabel('Resume date and time (in each prompt’s timezone)',{exact:true});await time.fill('2026-11-02T09:00');await time.press('Tab');
    await expect(item(page,first).locator('time').nth(0)).toHaveAttribute('datetime','2026-11-02T14:00:00.000Z');await expect(item(page,second).locator('time').nth(0)).toHaveAttribute('datetime','2026-11-02T00:00:00.000Z');
    await expect(item(page,first).locator('time').nth(1)).toHaveAttribute('datetime','2026-11-02T14:00:00.000Z');await expect(item(page,once)).toContainText('Only recurring prompts');
    await review(page).getByRole('heading',{name:'Pause selected until',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath('prompt-bulk-phone.png'),animations:'disabled'});await apply(page,2);
    await expect(review(page).getByRole('status')).toHaveText('2 confirmed · 0 unresolved');expect(await f.get(first.schedule_id)).toMatchObject({enabled:false,timed_pause:{until_at:Date.parse('2026-11-02T14:00Z')}});expect(await f.get(second.schedule_id)).toMatchObject({enabled:false,timed_pause:{until_at:Date.parse('2026-11-02T00:00Z')}});expect((await f.get(once.schedule_id)).enabled).toBe(true);
  }finally{f.dispose();}
});
test('keeps successful siblings confirmed and retries only the original unresolved item after a transactional failure',async({page})=>{
  const {f,first,second}=await setup(page);
  try{
    f.failBulkFor(second.schedule_id);await go(page);await selectAll(page,2);await toolbar(page).getByRole('button',{name:'Pause selected',exact:true}).click();await apply(page,2);
    await expect(item(page,first)).toContainText('Confirmed:');await expect(item(page,second)).toContainText('Unconfirmed:');await expect(review(page).getByRole('status')).toHaveText('1 confirmed · 1 unresolved');
    expect((await f.get(first.schedule_id)).revision).toBe(2);expect((await f.get(second.schedule_id)).revision).toBe(1);f.clearBulkFailure();await review(page).getByRole('button',{name:'Retry unresolved changes',exact:true}).click();
    await expect(review(page).getByRole('status')).toHaveText('2 confirmed · 0 unresolved');expect(f.bulkRequests[1]!.request_id).toBe(f.bulkRequests[0]!.request_id);expect(f.bulkRequests[1]!.items).toEqual((f.bulkRequests[0]!.items as Array<{schedule_id:string}>).filter(i=>i.schedule_id===second.schedule_id));
    for(const row of [first,second])expect((await f.get(row.schedule_id)).revision).toBe(2);expect(f.runs()).toBe(0);
  }finally{f.dispose();}
});
test('recovers lost and malformed replies with durable receipts across reload, including a later Resume batch',async({page})=>{
  const {f,first,second}=await setup(page);
  try{
    await go(page);await selectAll(page,2);await toolbar(page).getByRole('button',{name:'Pause selected',exact:true}).click();f.nextBulk('lost');await apply(page,2);await expect(review(page).getByRole('status')).toHaveText('0 confirmed · 2 unresolved');
    for(const row of [first,second])expect((await f.get(row.schedule_id)).revision).toBe(2);await page.reload();await page.waitForFunction(()=>window.__app?.ready===true);await review(page).getByRole('button',{name:'Retry unresolved changes',exact:true}).click();
    await expect(review(page).getByRole('status')).toHaveText('2 confirmed · 0 unresolved');expect(f.bulkRequests[1]).toEqual(f.bulkRequests[0]);await review(page).getByRole('button',{name:'Done',exact:true}).click();
    await selectAll(page,2);await toolbar(page).getByRole('button',{name:'Resume selected',exact:true}).click();f.nextBulk('bad-ack');await apply(page,2);await expect(review(page).getByRole('status')).toHaveText('0 confirmed · 2 unresolved');
    await review(page).getByRole('button',{name:'Retry unresolved changes',exact:true}).click();await expect(review(page).getByRole('status')).toHaveText('2 confirmed · 0 unresolved');expect(f.bulkRequests[3]).toEqual(f.bulkRequests[2]);
    for(const row of [first,second])expect(await f.get(row.schedule_id)).toMatchObject({enabled:true,revision:3});expect(f.runs()).toBe(0);expect(f.creates).toEqual([]);
  }finally{f.dispose();}
});
test('requires a fresh review for changed definitions or newly queued work and keeps those targets selected',async({page})=>{
  const {f,first,second}=await setup(page);
  try{
    await go(page);await selectAll(page,2);await toolbar(page).getByRole('button',{name:'Pause selected',exact:true}).click();await expect(review(page).getByRole('button',{name:'Apply 2 changes',exact:true})).toBeEnabled();
    await f.update({schedule_id:first.schedule_id,expected_revision:1,title:'Kestrel edited'});await f.seedRun(second,{key:'new-work',due_at:NOW,status:'queued'});await apply(page,2);
    await expect(item(page,first)).toContainText('Needs a new review');await expect(item(page,second)).toContainText('Needs a new review');await expect(review(page).getByRole('button',{name:'Retry unresolved changes',exact:true})).toHaveCount(0);
    expect(await f.get(first.schedule_id)).toMatchObject({enabled:true,revision:2});expect(await f.get(second.schedule_id)).toMatchObject({enabled:true,revision:1});await review(page).getByRole('button',{name:'Done',exact:true}).click();await expect(toolbar(page).getByRole('status')).toHaveText('2 selected');
    await toolbar(page).getByRole('button',{name:'Pause selected',exact:true}).click();await expect(item(page,second)).toContainText('1 queued run will be cancelled');await apply(page,2);await expect(review(page).getByRole('status')).toHaveText('2 confirmed · 0 unresolved');expect(f.bulkRequests[1]!.request_id).not.toBe(f.bulkRequests[0]!.request_id);
    expect(await f.get(first.schedule_id)).toMatchObject({enabled:false,revision:3});expect(await f.get(second.schedule_id)).toMatchObject({enabled:false,revision:2});
  }finally{f.dispose();}
});
test('keeps preview errors read-only, retires late replies, and offers selection only in the supported Automation list',async({page})=>{
  const {f,first}=await setup(page);
  try{
    await go(page);await selectAll(page,2);f.nextBulkPreview('fail');await toolbar(page).getByRole('button',{name:'Pause selected',exact:true}).click();await expect(review(page).getByRole('alert')).toContainText('interrupted');await expect(review(page).getByRole('button',{name:'Apply 0 changes',exact:true})).toBeDisabled();expect(f.bulkRequests).toEqual([]);
    await review(page).getByRole('button',{name:'Retry bulk review',exact:true}).click();await expect(review(page).getByRole('button',{name:'Apply 2 changes',exact:true})).toBeEnabled();await review(page).getByRole('button',{name:'Keep current schedules',exact:true}).click();
    f.nextBulkPreview('hold');await toolbar(page).getByRole('button',{name:'Pause selected',exact:true}).click();await expect.poll(f.bulkPreviewPending).toBe(true);await page.evaluate(id=>window.__app.setHash('#automation/schedules/prompt/'+id),first.schedule_id);f.releaseBulkPreview();await expect(toolbar(page)).toHaveCount(0);
    await go(page,'#chat/session/'+first.session_id);await panel(page).locator('[data-prompt-schedule-compact] > summary').click();await expect(toolbar(page)).toHaveCount(0);await expect(panel(page).getByRole('checkbox',{name:'Select Kestrel first',exact:true})).toHaveCount(0);
    f.capabilities('old');await go(page);await expect(toolbar(page)).toHaveCount(0);await expect(panel(page).getByRole('checkbox',{name:'Select Kestrel first',exact:true})).toHaveCount(0);expect(f.bulkRequests).toEqual([]);expect(f.runs()).toBe(0);
  }finally{f.dispose();}
});

test('lets the owner explicitly forget an unreadable local recovery copy without applying any changes',async({page})=>{
  const {f,first}=await setup(page);
  try{
    await go(page);const key='recued:prompt-bulk:'+encodeURIComponent(first.run_request_scope!);
    await page.evaluate(key=>sessionStorage.setItem(key,'{broken'),key);await page.reload();await page.waitForFunction(()=>window.__app?.ready===true);
    await expect(toolbar(page).getByRole('alert')).toContainText('could not be read');await expect(toolbar(page).getByRole('button',{name:'Select all 2 matching prompts',exact:true})).toBeDisabled();
    await toolbar(page).getByRole('button',{name:'Forget unreadable recovery',exact:true}).click();await toolbar(page).getByRole('button',{name:'Keep recovery copy',exact:true}).click();expect(await page.evaluate(key=>sessionStorage.getItem(key),key)).toBe('{broken');
    await toolbar(page).getByRole('button',{name:'Forget unreadable recovery',exact:true}).click();await toolbar(page).getByRole('button',{name:'Forget local copy',exact:true}).click();
    await expect(toolbar(page).getByRole('button',{name:'Select all 2 matching prompts',exact:true})).toBeEnabled();expect(await page.evaluate(key=>sessionStorage.getItem(key),key)).toBeNull();expect(f.bulkRequests).toEqual([]);expect((await f.get(first.schedule_id)).revision).toBe(1);
  }finally{f.dispose();}
});

test.describe('scheduled prompt bulk controls in Universal Search', () => {
  const group = (page: Page) => page.getByRole('region', { name: 'Scheduled prompt search results', exact: true });
  const bulk = (page: Page) => group(page).getByRole('region', { name: 'Bulk scheduled prompt controls', exact: true });
  const check = (page: Page) => group(page).getByRole('region', { name: 'Review selected scheduled prompts', exact: true });
  const query = (page: Page) => page.getByRole('searchbox', { name: 'Search everything', exact: true });
  const type = (page: Page) => page.getByRole('combobox', { name: 'Result type', exact: true });
  const choose = (page: Page, count = 2) => bulk(page).getByRole('button', { name: `Select loaded matching prompts (${count})`, exact: true });
  const result = (page: Page, row: PromptSchedule) => check(page).locator(`[data-prompt-bulk-id="${row.schedule_id}"]`);
  const find = async (page: Page, text = 'Kestrel') => {
    await go(page, '#data/search'); if (text) await query(page).fill(text);
    await type(page).selectOption('scheduled_prompt'); await expect(group(page)).toHaveAttribute('aria-busy', 'false');
  };
  const confirm = async (page: Page, count = 2) => {
    const button = check(page).getByRole('button', { name: `Apply ${count} changes`, exact: true });
    await expect(button).toBeEnabled(); await button.press('Enter');
  };

  test('changes only loaded matches by keyboard, supports Pause and Resume, and retains query, type, counts, and focus', async ({ page }, info) => {
    const { f, first, second } = await setup(page);
    try {
      const outside = await f.seed({ title: 'Oriole briefing' }); await find(page);
      const checkbox = group(page).getByRole('checkbox', { name: 'Select Kestrel first', exact: true });
      await checkbox.focus(); await checkbox.press('Space'); await expect(checkbox).toBeFocused();
      await page.keyboard.press(info.project.name === 'webkit' ? 'Alt+Tab' : 'Tab');
      await expect(group(page).locator(`[data-search-prompt-id="${first.schedule_id}"]`)).toBeFocused();
      await choose(page).press('Enter'); await expect(bulk(page).getByRole('status')).toHaveText('2 selected');
      await expect(bulk(page)).toContainText('loaded results only');
      await bulk(page).getByRole('button', { name: 'Pause selected', exact: true }).press('Enter');
      await expect(check(page)).toBeFocused(); expect(f.bulkRequests).toEqual([]);
      await confirm(page); await expect(check(page).getByRole('status')).toHaveText('2 confirmed · 0 unresolved');
      await expect(check(page).getByRole('status')).toBeFocused();
      expect((f.bulkRequests[0]!.items as { schedule_id: string }[]).map(i => i.schedule_id).sort()).toEqual([first.schedule_id, second.schedule_id].sort());
      for (const row of [first, second]) expect(await f.get(row.schedule_id)).toMatchObject({ enabled: false, revision: 2 });
      expect(await f.get(outside.schedule_id)).toMatchObject({ enabled: true, revision: 1 });
      await expect(query(page)).toHaveValue('Kestrel'); await expect(type(page)).toHaveValue('scheduled_prompt');
      await expect(group(page).locator('.rq-group-count')).toHaveText('2');
      await expect(group(page).locator(`[data-search-prompt-id="${first.schedule_id}"]`)).toContainText('Paused');
      await check(page).getByRole('button', { name: 'Done', exact: true }).press('Enter');
      await choose(page).press('Enter'); await bulk(page).getByRole('button', { name: 'Resume selected', exact: true }).press('Enter');
      await expect(result(page, first)).toContainText('First run:'); await confirm(page);
      await expect(check(page).getByRole('status')).toHaveText('2 confirmed · 0 unresolved');
      for (const row of [first, second]) expect(await f.get(row.schedule_id)).toMatchObject({ enabled: true, revision: 3 });
      expect(f.runs()).toBe(0); expect(f.creates).toEqual([]);
    } finally { f.dispose(); }
  });

  test('reviews each timezone and queued-run impact on a phone before a timed break, excluding unsupported one-offs', async ({ page }, info) => {
    const { f, first, second } = await setup(page);
    try {
      await f.update({ schedule_id: second.schedule_id, expected_revision: 1, time_zone: 'Asia/Tokyo' });
      const once = await f.seed({ title: 'Kestrel once', mode: 'one_shot', cron_expression: undefined, run_at: new Date(NOW + 60_000).toISOString() });
      await f.seedRun(first, { key: 'queued-search-run', due_at: NOW, status: 'queued' });
      await page.setViewportSize({ width: 390, height: 900 }); await find(page);
      await choose(page, 3).click(); await bulk(page).getByRole('button', { name: 'Pause until selected…', exact: true }).press('Enter');
      const time = check(page).getByLabel('Resume date and time (in each prompt’s timezone)', { exact: true });
      await time.fill('2026-11-02T09:00'); await time.press('Tab');
      await expect(result(page, first).locator('time').first()).toHaveAttribute('datetime', '2026-11-02T14:00:00.000Z');
      await expect(result(page, second).locator('time').first()).toHaveAttribute('datetime', '2026-11-02T00:00:00.000Z');
      await expect(result(page, first)).toContainText('1 queued run will be cancelled');
      await expect(result(page, first)).toContainText('Running work can finish; existing approvals stay in Chat.');
      await expect(result(page, once)).toContainText('Only recurring prompts'); expect(f.bulkRequests).toEqual([]);
      await check(page).scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath('search-prompt-bulk-phone.png'), animations: 'disabled' });
      await confirm(page); await expect(check(page).getByRole('status')).toHaveText('2 confirmed · 0 unresolved');
      expect(await f.get(first.schedule_id)).toMatchObject({ enabled: false, timed_pause: { until_at: Date.parse('2026-11-02T14:00Z') } });
      expect(await f.get(second.schedule_id)).toMatchObject({ enabled: false, timed_pause: { until_at: Date.parse('2026-11-02T00:00Z') } });
      expect((await f.get(once.schedule_id)).enabled).toBe(true); expect(f.runs()).toBe(0);
    } finally { f.dispose(); }
  });

  test('retains partial outcomes through a failed refresh and retries only the original unresolved item', async ({ page }) => {
    const { f, first, second } = await setup(page);
    try {
      await find(page); await choose(page).click(); await bulk(page).getByRole('button', { name: 'Pause selected', exact: true }).click();
      f.failBulkFor(second.schedule_id); f.failNextList(); await confirm(page);
      await expect(check(page).getByRole('status')).toHaveText('1 confirmed · 1 unresolved');
      await expect(result(page, first)).toContainText('Confirmed:'); await expect(result(page, second)).toContainText('Unconfirmed:');
      await expect(group(page).getByRole('alert')).toContainText('refresh was interrupted');
      await expect(group(page).getByRole('checkbox')).toHaveCount(0); f.clearBulkFailure();
      await check(page).getByRole('button', { name: 'Retry unresolved changes', exact: true }).press('Enter');
      await expect(check(page).getByRole('status')).toHaveText('2 confirmed · 0 unresolved');
      expect(f.bulkRequests[1]!.request_id).toBe(f.bulkRequests[0]!.request_id);
      expect(f.bulkRequests[1]!.items).toEqual((f.bulkRequests[0]!.items as { schedule_id: string }[]).filter(i => i.schedule_id === second.schedule_id));
      await expect(query(page)).toHaveValue('Kestrel'); await expect(type(page)).toHaveValue('scheduled_prompt');
      for (const row of [first, second]) expect(await f.get(row.schedule_id)).toMatchObject({ enabled: false, revision: 2 });
    } finally { f.dispose(); }
  });

  test('locks the search during a write, preserves later focus, and recovers a lost reply across reload without reapplying automatically', async ({ page }) => {
    const { f, first } = await setup(page);
    try {
      await find(page); await choose(page).click(); await bulk(page).getByRole('button', { name: 'Pause selected', exact: true }).click();
      f.holdNextBulkReply(); f.nextBulk('lost'); await confirm(page); await expect.poll(f.bulkPending).toBe(true);
      await expect(check(page).getByRole('status')).toHaveText('Applying scheduled prompt changes…');
      await expect(type(page)).toBeDisabled(); await expect(query(page)).not.toBeEditable();
      await group(page).locator(`[data-search-prompt-id="${first.schedule_id}"]`).click(); await expect(group(page)).toBeVisible();
      await query(page).focus(); f.releaseBulk();
      await expect(check(page).getByRole('status')).toHaveText('0 confirmed · 2 unresolved'); await expect(query(page)).toBeFocused();
      expect(await f.get(first.schedule_id)).toMatchObject({ enabled: false, revision: 2 });
      await page.reload(); await page.waitForFunction(() => window.__app?.ready === true);
      await type(page).selectOption('scheduled_prompt');
      await expect(check(page).getByRole('status')).toHaveText('0 confirmed · 2 unresolved'); expect(f.bulkRequests).toHaveLength(1);
      await check(page).getByRole('button', { name: 'Retry unresolved changes', exact: true }).press('Enter');
      await expect(check(page).getByRole('status')).toHaveText('2 confirmed · 0 unresolved');
      expect(f.bulkRequests[1]).toEqual(f.bulkRequests[0]); expect((await f.get(first.schedule_id)).revision).toBe(2); expect(f.runs()).toBe(0);
    } finally { f.dispose(); }
  });

  test('requires a fresh review when the request or queued work changes after preview', async ({ page }) => {
    const { f, first, second } = await setup(page);
    try {
      await find(page); await choose(page).click(); await bulk(page).getByRole('button', { name: 'Pause selected', exact: true }).click();
      await expect(check(page).getByRole('button', { name: 'Apply 2 changes', exact: true })).toBeEnabled();
      await f.update({ schedule_id: first.schedule_id, expected_revision: 1, title: 'Oriole revised' });
      await f.update({ schedule_id: second.schedule_id, expected_revision: 1, title: 'Oriole later' });
      await f.seedRun(second, { key: 'queued-after-search-review', due_at: NOW, status: 'queued' }); await confirm(page);
      await expect(result(page, first)).toContainText('Needs a new review'); await expect(result(page, second)).toContainText('Needs a new review');
      await expect(check(page).getByRole('button', { name: 'Retry unresolved changes', exact: true })).toHaveCount(0);
      await expect(group(page).locator('[data-search-prompt-id]')).toHaveCount(0);
      await expect(group(page).locator('.rq-group-count')).toHaveText('0');
      expect((await f.get(first.schedule_id)).enabled).toBe(true); expect((await f.get(second.schedule_id)).enabled).toBe(true);
      await check(page).getByRole('button', { name: 'Done', exact: true }).click();
      await expect(bulk(page).getByRole('status')).toHaveText('2 selected · 2 outside this filter');
      await bulk(page).getByRole('button', { name: 'Pause selected', exact: true }).click(); await expect(result(page, first)).toContainText('Oriole revised');
      await expect(result(page, second)).toContainText('1 queued run will be cancelled'); await confirm(page);
      await expect(check(page).getByRole('status')).toHaveText('2 confirmed · 0 unresolved');
      expect(f.bulkRequests[1]!.request_id).not.toBe(f.bulkRequests[0]!.request_id);
      await check(page).getByRole('button', { name: 'Done', exact: true }).press('Enter');
      await expect(query(page)).toBeFocused(); await expect(query(page)).toHaveValue('Kestrel');
    } finally { f.dispose(); }
  });

  test('retires late previews when the query, result type, or refresh changes and keeps newer focus', async ({ page }) => {
    const { f } = await setup(page);
    try {
      await find(page);
      for (const boundary of ['query', 'type', 'refresh']) {
        await choose(page).click(); f.nextBulkPreview('hold');
        await bulk(page).getByRole('button', { name: 'Pause selected', exact: true }).press('Enter');
        await expect.poll(f.bulkPreviewPending).toBe(true);
        if (boundary === 'query') await query(page).fill('Kestrel customer');
        if (boundary === 'type') { await type(page).selectOption('all'); await type(page).selectOption('scheduled_prompt'); }
        if (boundary === 'refresh') await group(page).getByRole('button', { name: 'Refresh scheduled prompts', exact: true }).click();
        await query(page).focus(); f.releaseBulkPreview();
        await expect(check(page)).toHaveCount(0); await expect(bulk(page).getByRole('status')).toHaveText('0 selected');
        await expect(group(page).getByRole('checkbox', { checked: true })).toHaveCount(0); await expect(query(page)).toBeFocused();
      }
      expect(f.bulkRequests).toEqual([]); expect(f.runs()).toBe(0);
    } finally { f.dispose(); }
  });

  test('gates older servers and keeps a failed review read-only until it can be confirmed', async ({ page }) => {
    const { f } = await setup(page);
    try {
      f.capabilities('old'); await find(page);
      await expect(bulk(page)).toHaveCount(0); await expect(group(page).getByRole('checkbox')).toHaveCount(0);
      f.capabilities('current');
      await group(page).getByRole('button', { name: 'Refresh scheduled prompts', exact: true }).click();
      await choose(page).click(); f.nextBulkPreview('fail');
      await bulk(page).getByRole('button', { name: 'Pause selected', exact: true }).click();
      await expect(check(page).getByRole('alert')).toContainText('review was interrupted');
      await expect(check(page).getByRole('button', { name: 'Apply 0 changes', exact: true })).toBeDisabled();
      expect(f.bulkRequests).toEqual([]);
      await check(page).getByRole('button', { name: 'Retry bulk review', exact: true }).click();
      await expect(check(page).getByRole('button', { name: 'Apply 2 changes', exact: true })).toBeEnabled(); expect(f.bulkRequests).toEqual([]);
    } finally { f.dispose(); }
  });
});
