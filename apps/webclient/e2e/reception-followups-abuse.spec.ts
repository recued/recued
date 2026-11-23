import {expect,test,type Page} from '@playwright/test';
import {installFollowupAbusePage,goFollowupAbuse,loadedFollowups,loadedAbuse,followupKinds,followupGroup,followupState,holdFollowup,releaseFollowup,failFollowup,abuseRoot,firstAbuseBan} from './helpers/followups-abuse.js';
test.beforeEach(async({page})=>installFollowupAbusePage(page));
const count=async(page:Page,method:string)=>(await followupState(page)).calls.filter(c=>c.method===method).length;
async function focusAccount(page:Page){await page.locator('[data-recued-account-menu-trigger]').click();const close=page.locator('[data-recued-account-menu-close]');await close.focus();await expect(close).toBeFocused();return close;}
async function checkPendingOwner(page:Page){
 page.once('dialog',d=>d.accept());await page.getByRole('link',{name:'Records',exact:true}).click();await expect(abuseRoot(page)).toHaveCount(0);await expect(page.locator('[data-customer-work]')).toHaveCount(0);
 await page.locator('[data-recued-account-menu-trigger]').click();const account=page.locator('[data-recued-account-menu-popover]');const office=account.locator('[data-recued-server-switcher-item]').filter({hasText:'Office server'});await office.click();const review=account.locator('[data-recued-server-switcher-switch-confirm]');
 await expect(review).toContainText('Work is still finishing on');await expect(review.locator('[data-recued-server-switcher-switch-commit]')).toHaveText('Switch, and check later');await releaseFollowup(page);await review.locator('[data-recued-server-switcher-switch-cancel]').click();await office.click();await expect(review.locator('[data-recued-server-switcher-switch-commit]')).toHaveText('Switch server');
}
for(const kind of followupKinds)test(`saves the exact ${kind.key} follow-up from its global queue`,async({page})=>{
 await loadedFollowups(page);const group=followupGroup(page,kind),card=group.locator('article').first();await card.getByRole('button',{name:kind.key==='account'?'Edit account payment follow-up':kind.key==='payment'?'Edit payment follow-up':'Edit follow-up',exact:true}).click();
 const editor=group.locator(`[data-${kind.namespace}-reminder-editor]:visible`),when=editor.getByLabel('Follow-up time (your device timezone)',{exact:true});await expect(when).toBeEnabled();await when.fill('2026-11-23T12:00');const expectedDue=await when.evaluate(n=>new Date((n as HTMLInputElement).value).getTime());const save=editor.getByRole('button',{name:kind.key==='account'?'Save account payment follow-up':kind.key==='payment'?'Save payment follow-up':'Save follow-up',exact:true});await save.click();await expect(editor).toContainText('Follow-up saved.');const calls=(await followupState(page)).calls.filter(c=>c.method===kind.prefix+'.set');expect(calls).toHaveLength(1);expect(calls[0]!.args).toEqual({[kind.idKey]:kind.key+'-0',expected_revision:1,due_at:expectedDue,recipient_email:'morgan@example.test',sender_mail_instance:'work'});expect(await count(page,'mail.drafts.create')).toBe(0);expect(await count(page,'execute')).toBe(0);
});
test('reviewing a due reminder opens the saved private email without sending it',async({page})=>{
 await loadedFollowups(page);await followupGroup(page,followupKinds[0]).getByRole('button',{name:'Review reminder email',exact:true}).click();await expect(page.getByRole('button',{name:'Send',exact:true})).toBeVisible();const creates=(await followupState(page)).calls.filter(c=>c.method==='mail.drafts.create');expect(creates).toHaveLength(1);expect(creates[0]!.args).toMatchObject({idempotency_key:'followup-offer-0-1',content:{sender_mail_instance:'work',to:['morgan@example.test'],reconciliation_id:'followup-offer-0-1'}});expect(await count(page,'execute')).toBe(0);expect(await count(page,'mail.drafts.prepare')).toBe(0);
});
test('a saved reminder draft keeps a failed queue refresh visible and recoverable',async({page})=>{
 await loadedFollowups(page);const group=followupGroup(page,followupKinds[0]);await failFollowup(page,'reception.signoff.reminders.list');await group.getByRole('button',{name:'Review reminder email',exact:true}).click();await expect(page.getByRole('button',{name:'Send',exact:true})).toBeVisible();await page.getByRole('button',{name:'Cancel',exact:true}).click();const status=group.locator('[role=status]').first();await expect(status).toContainText('Reminder draft saved.');await expect(status).toContainText('Could not load follow-ups.');expect(await count(page,'mail.drafts.create')).toBe(1);expect(await count(page,'execute')).toBe(0);expect(await count(page,'mail.drafts.prepare')).toBe(0);await failFollowup(page);await group.getByRole('button',{name:'Refresh follow-ups',exact:true}).click();await expect(status).toHaveText('Follow-up page 1 · 3 requests.');expect(await count(page,'mail.drafts.create')).toBe(1);
});
test('a delayed reminder draft stays saved in Mail after focus moves to Account',async({page})=>{
 await loadedFollowups(page);const group=followupGroup(page,followupKinds[0]);await holdFollowup(page,'reception.signoff.reminders.draft');await group.getByRole('button',{name:'Review reminder email',exact:true}).click();await expect.poll(()=>count(page,'reception.signoff.reminders.draft')).toBe(1);const close=await focusAccount(page);await releaseFollowup(page);await expect.poll(()=>count(page,'mail.drafts.create')).toBe(1);await expect(group.locator('button').filter({hasText:'Refresh follow-ups'})).toBeEnabled();await expect(close).toBeFocused();await expect(group.getByRole('status').filter({hasText:'Reminder draft saved in Mail'})).toBeVisible();await expect(page.getByRole('button',{name:'Send',exact:true})).toHaveCount(0);expect(await count(page,'mail.drafts.create')).toBe(1);
});
test('a pending reminder Mail draft creation stays owned after departure',async({page})=>{
 await loadedFollowups(page);await holdFollowup(page,'mail.drafts.create');await followupGroup(page,followupKinds[0]).getByRole('button',{name:'Review reminder email',exact:true}).click();await expect.poll(()=>count(page,'mail.drafts.create')).toBe(1);expect((await followupState(page)).calls.find(c=>c.method==='mail.drafts.create')!.args.idempotency_key).toBe('followup-offer-0-1');await checkPendingOwner(page);expect(await count(page,'mail.drafts.create')).toBe(1);
});
test('an initial Abuse read failure has a working retry',async({page})=>{
 await goFollowupAbuse(page,'abuse','followup_fail=reception.abuse_inbox.list');await expect(abuseRoot(page).getByRole('alert')).toBeVisible();await failFollowup(page);await abuseRoot(page).getByRole('button',{name:'Retry abuse signals',exact:true}).click();await expect(abuseRoot(page).locator('.reception-abuse-row')).toHaveCount(6);await expect(abuseRoot(page).getByRole('button',{name:'Refresh',exact:true})).toBeFocused();
});
test('Abuse refresh restores its keyboard control after repainting the result',async({page})=>{
 await loadedAbuse(page);const refresh=abuseRoot(page).getByRole('button',{name:'Refresh',exact:true});const before=await count(page,'reception.abuse_inbox.list');await refresh.focus();await page.keyboard.press('Enter');await expect.poll(()=>count(page,'reception.abuse_inbox.list')).toBe(before+1);await expect(refresh).toBeFocused();
});
test('a failed Abuse ban restores the selected source action',async({page})=>{
 await loadedAbuse(page);await failFollowup(page,'reception.abuse_inbox.ban_ip');await firstAbuseBan(page).focus();await page.keyboard.press('Enter');await expect(abuseRoot(page).getByRole('alert')).toBeVisible();await expect(firstAbuseBan(page)).toBeFocused();expect((await followupState(page)).calls.find(c=>c.method==='reception.abuse_inbox.ban_ip')!.args).toEqual({endpoint_id:'endpoint/one',source_ip_hash:'1'.repeat(64)});
});
test('unbanning a removed block returns focus to Abuse refresh',async({page})=>{
 await loadedAbuse(page);const unban=abuseRoot(page).locator('.reception-abuse-blocked-row').getByRole('button',{name:'Unban IP',exact:true});await unban.focus();await page.keyboard.press('Enter');await expect(abuseRoot(page).locator('.reception-abuse-blocked-row')).toHaveCount(0);await expect(abuseRoot(page).getByRole('button',{name:'Refresh',exact:true})).toBeFocused();
});
for(const action of ['ban','unban'] as const){
 const method=`reception.abuse_inbox.${action}_ip`;
 const source=(page:Page)=>action==='ban'?firstAbuseBan(page):abuseRoot(page).locator('.reception-abuse-blocked-row').getByRole('button',{name:'Unban IP',exact:true});
 test(`Abuse ${action} is single-flight and keeps its exact source`,async({page})=>{
  await loadedAbuse(page);await holdFollowup(page,method);await source(page).click();await expect.poll(()=>count(page,method)).toBe(1);await expect(source(page)).toBeDisabled();await expect(abuseRoot(page).locator('.reception-abuse-row').first().getByRole('button',{name:'Investigate',exact:true})).toBeEnabled();const rect=await source(page).boundingBox();expect(rect).not.toBeNull();await page.mouse.click(rect!.x+rect!.width/2,rect!.y+rect!.height/2);expect(await count(page,method)).toBe(1);const expected={endpoint_id:action==='ban'?'endpoint/one':'blocked-endpoint',source_ip_hash:(action==='ban'?'1':'b').repeat(64)};expect((await followupState(page)).calls.find(c=>c.method===method)!.args).toEqual(expected);await releaseFollowup(page);await expect(abuseRoot(page).getByRole('button',{name:'Refresh',exact:true})).toBeEnabled();
 });
 test(`pending Abuse ${action} remains owned after leaving Reception`,async({page})=>{
  await loadedAbuse(page);await holdFollowup(page,method);await source(page).click();await expect.poll(()=>count(page,method)).toBe(1);await checkPendingOwner(page);expect(await count(page,method)).toBe(1);
 });
}
test('an Abuse refresh preserves later Account focus',async({page})=>{
 await loadedAbuse(page);await holdFollowup(page,'reception.abuse_inbox.list');await abuseRoot(page).getByRole('button',{name:'Refresh',exact:true}).click();await expect.poll(()=>page.evaluate(()=>typeof (window as any).__followupAbuse.release)).toBe('function');const close=await focusAccount(page);await releaseFollowup(page);await expect(abuseRoot(page).getByRole('button',{name:'Refresh',exact:true})).toBeEnabled();await expect(close).toBeFocused();
});
