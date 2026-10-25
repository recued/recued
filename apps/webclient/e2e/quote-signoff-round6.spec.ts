import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {expect,test,type Page} from '@playwright/test';
import {renderApprovalLinkHtml} from '../../../backend/server/src/ports/reception/handlers/approval-link-render.js';
import {HARNESS_ORIGIN} from './helpers/harness-origin.js';
import {openSignoffRequestDetails} from './helpers/signoff-request.js';
import type {} from './harness/quote-signoff-harness.js';

const BASE=HARNESS_ORIGIN+'/quote-signoff-harness.html',errors=new WeakMap<Page,string[]>();
test.beforeEach(async({page})=>{
  const failures:string[]=[];errors.set(page,failures);page.on('pageerror',e=>failures.push(e.message));
  const policy=(await readFile(resolve(import.meta.dirname,'../public/_headers'),'utf8')).match(/^\s*Content-Security-Policy:\s*(.+)$/m)![1]!;
  await page.route(/\/(quote-signoff)-harness\.html/,async route=>{const response=await route.fetch();await route.fulfill({response,headers:{...response.headers(),'content-security-policy':policy}});});
});
test.afterEach(async({page})=>expect(errors.get(page)).toEqual([]));
const fillQuote=async(page:Page)=>{
  const creation=page.locator('[data-signoff-create]');if(!await creation.evaluate(n=>(n as HTMLDetailsElement).open))await creation.locator('summary').click();
  await page.getByRole('combobox',{name:'Open quote',exact:true}).selectOption('Q1');
  for(const[label,value]of[['Business name shown to the customer','Studio'],['Complete scope shown to the customer','Three drawings.'],['Task to create after your approval','Deliver drawings'],['Invoice reference','INV-NEW']])await page.getByLabel(label,{exact:true}).fill(value!);
};
const prepare=async(page:Page,kind:'quote'|'completion',options:{days?:number;query?:string}={})=>{
  await page.clock.install({time:new Date('2026-10-24T12:00:00Z')});
  await page.goto(BASE+'?reminders&'+(kind==='completion'?'completion&':'')+(options.query??''));
  if(kind==='quote'){
    await fillQuote(page);await page.getByLabel('Link lifetime in days',{exact:true}).fill(String(options.days??7));
    await page.getByRole('button',{name:'Prepare sign-off preview',exact:true}).click();
  }else{
    await openSignoffRequestDetails(page.locator('[data-signoff-history] article').first());
    await page.getByRole('button',{name:'Request completion',exact:true}).click();
    await page.getByLabel('Delivered work shown to the customer',{exact:true}).fill('Delivered the agreed drawings.');
    await page.getByLabel('Completion link life (days)',{exact:true}).fill(String(options.days??7));
    await page.getByRole('button',{name:'Prepare completion preview',exact:true}).click();
  }
  const publish=page.getByRole('button',{name:kind==='quote'?'Publish sign-off link':'Publish completion link',exact:true});await expect(publish).toBeEnabled();
  return {publish,preview:kind==='quote'?page.locator('[data-signoff-preview]'):page.getByRole('form',{name:'Request customer completion',exact:true}),
    refresh:page.getByRole('button',{name:kind==='quote'?'Refresh sign-off preview':'Refresh completion preview',exact:true})};
};

const publicForm=async(page:Page,recovered=false)=>{
  const submissions:URLSearchParams[]=[];
  await page.route(HARNESS_ORIGIN+'/reception/approve/fixture*',async route=>{
    if(route.request().method()==='POST'){
      submissions.push(new URLSearchParams(route.request().postData()!));await route.fulfill({contentType:'text/html',body:'<!doctype html><h1>Fixture response recorded</h1>'});return;
    }
    await route.fulfill({contentType:'text/html',body:renderApprovalLinkHtml({display_name:'Studio',action_kind:'approve_wording',completion:true,
      prompt:'Accept completion or request corrections.',context_summary:'Delivered drawings.',expiry_display:'expires in 7 days',
      visitor_field_constraints:{name:'optional',email:'optional'},submit_button_label:'Send response',endpoint_id:'fixture',bearer_secret:'fixture',form_nonce:'fixture',
      ...(recovered?{error_message:'Check your response.',submitted:{comment:'Please correct <these> drawings.'}}:{})})});
  });
  await page.goto(HARNESS_ORIGIN+'/reception/approve/fixture?t=fixture');return submissions;
};
for(const recovered of[false,true])test(`contact-field Enter does not choose completion acceptance (recovered=${recovered})`,async({page})=>{
  const submissions=await publicForm(page,recovered);await page.getByLabel('Your name',{exact:false}).fill('Morgan');await page.getByLabel('Your email',{exact:false}).fill('morgan@example.test');
  await page.locator('textarea[name=comment]').fill('Please correct <these> drawings.');
  for(const label of['Your name','Your email']){
    await page.getByLabel(label,{exact:false}).press('Enter');await page.waitForTimeout(100);
    expect(submissions).toHaveLength(0);await expect(page.locator('textarea[name=comment]')).toHaveValue('Please correct <these> drawings.');
  }
  await page.getByRole('button',{name:'Request corrections',exact:true}).focus();await page.keyboard.press('Enter');
  await expect(page.getByRole('heading',{name:'Fixture response recorded'})).toBeVisible();expect(submissions).toHaveLength(1);
  expect(submissions[0]!.get('decision')).toBe('reject');expect(submissions[0]!.get('comment')).toBe('Please correct <these> drawings.');
});
for(const action of[{label:'Accept completion',decision:'approve',key:'Enter'},{label:'Request corrections',decision:'reject',key:'Space'}])test(`explicit ${action.label} keeps its native keyboard action`,async({page})=>{
  const submissions=await publicForm(page);if(action.decision==='reject')await page.locator('textarea[name=comment]').fill('Correct the scale.');
  await page.getByRole('button',{name:action.label,exact:true}).focus();await page.keyboard.press(action.key);
  await expect(page.getByRole('heading',{name:'Fixture response recorded'})).toBeVisible();expect(submissions).toHaveLength(1);expect(submissions[0]!.get('decision')).toBe(action.decision);
});

test('shows a compact escaped decline reason and keeps its full disclosure and focus through polling',async({page})=>{
  await page.setViewportSize({width:390,height:844});await page.goto(BASE+'?waiting');const reason=('Please change <these> drawings. Keep “notes” intact.\n').repeat(90).slice(0,4000);
  await page.evaluate(reason=>window.__quoteSignoff.quoteResponse('declined',reason),reason);
  const card=page.locator('[data-signoff-history] article'),summary=card.locator('[data-signoff-response-reason]'),details=card.locator('[data-signoff-disclosure=reason]');
  await expect(card).toContainText('Customer declined');expect([...(await summary.innerText())]).toHaveLength(201);await expect(details.locator('pre')).toHaveText(reason.trim());
  await expect(details).not.toHaveAttribute('open','');await expect(card.locator('img,script')).toHaveCount(0);await details.locator('summary').click();
  const old=await details.elementHandle();await page.evaluate(()=>window.__quoteSignoff.update());await expect.poll(()=>old!.evaluate(n=>n.isConnected)).toBe(false);
  await expect(details).toHaveAttribute('open','');await expect(details.locator('summary')).toBeFocused();
  await page.evaluate(()=>window.__quoteSignoff.quoteResponse('accepted'));await expect(card).toContainText('Customer accepted');await expect(summary).toHaveCount(0);
});
test('marks an unavailable canonical quote reply instead of showing a decline reason',async({page})=>{
  await page.goto(BASE+'?waiting');await page.evaluate(()=>window.__quoteSignoff.quoteResponse('unavailable','PRIVATE reason.'));
  const card=page.locator('[data-signoff-history] article');await expect(card).toContainText('Customer reply unavailable. Refresh to try again.');await expect(card).not.toContainText('PRIVATE');await expect(card).toContainText('Reply processed');
});
test('shows that no decline reason was supplied',async({page})=>{
  await page.goto(BASE+'?waiting');await page.evaluate(()=>window.__quoteSignoff.quoteResponse('declined'));await expect(page.locator('[data-signoff-history] article')).toContainText('No reason supplied.');
});
test('retires a quote share when its canonical decline arrives before processing',async({page})=>{
  const {publish}=await prepare(page,'quote');await publish.click();const share=page.locator('[data-customer-link-share]');await expect(share.locator('input')).not.toHaveValue('');
  await page.evaluate(()=>window.__quoteSignoff.quoteResponse('declined','Reduce the scope.',true));await expect(page.locator('[data-signoff-history] article')).toContainText('Processing pending');
  await expect(share.locator('input')).toHaveValue('');await expect(share.getByRole('button',{name:'Copy link',exact:true})).toBeDisabled();
});

for(const kind of['quote','completion']as const){
  for(const reviewed of[false,true])test(`ends ${kind} publication at the saved customer deadline (fresh review=${reviewed})`,async({page})=>{
    const {publish,preview,refresh}=await prepare(page,kind,{days:1});const deadline=await preview.locator('[data-customer-request-expiry] time').getAttribute('datetime');
    await page.clock.fastForward(86_340_000);if(reviewed){await refresh.click();await expect(publish).toBeEnabled();}
    await page.clock.fastForward(61_000);await expect(publish).toBeDisabled();await expect(preview.locator('[data-customer-request-ended]')).toContainText('Prepare a new request');await expect(refresh).toBeHidden();
    await expect(preview.locator('[data-customer-request-expiry] time')).toHaveAttribute('datetime',deadline!);
    const before=await page.evaluate(()=>window.__quoteSignoff.calls.filter(c=>c.method.endsWith('.resume')).length);
    await preview.locator('[data-customer-request-ended] button').dispatchEvent('click');await publish.dispatchEvent('click');
    expect(await page.evaluate(()=>window.__quoteSignoff.calls.filter(c=>c.method.endsWith('.resume')).length)).toBe(before);
    expect(await page.evaluate(()=>window.__quoteSignoff.calls.filter(c=>c.method.endsWith('.publish')).length)).toBe(0);
  });
  test(`older servers still stop ${kind} publishing at the saved customer deadline`,async({page})=>{
    const {publish,preview}=await prepare(page,kind,{days:1,query:'legacy_preview'});await expect(page.locator('[data-customer-preview-freshness]')).toHaveCount(0);
    await page.clock.fastForward(86_400_001);await expect(publish).toBeDisabled();await expect(preview.locator('[data-customer-request-ended]')).toBeVisible();
  });
  test(`failed ${kind} refresh keeps the saved preview, choice, error and same-request retry`,async({page})=>{
    await page.setViewportSize({width:390,height:844});const {publish,preview,refresh}=await prepare(page,kind);
    const before=await preview.locator('pre').innerText(),deadline=await preview.locator('[data-customer-request-expiry] time').getAttribute('datetime');const keep=page.getByLabel('Save this link for follow-up emails',{exact:true});await keep.check();
    await page.clock.fastForward(600001);await page.evaluate(()=>window.__quoteSignoff.failResume(true));await refresh.click();
    await expect(preview.locator('pre')).toHaveText(before);await expect(publish).toBeDisabled();await expect(keep).toBeChecked();
    const status=preview.locator('[data-customer-preview-freshness]');await expect(status).toContainText('Could not refresh this review.');await expect(status).toBeFocused();
    const retry=preview.getByRole('button',{name:kind==='quote'?'Retry sign-off preview':'Retry completion preview',exact:true});await expect(retry).toBeEnabled();
    await page.evaluate(()=>window.__quoteSignoff.failResume(false));await retry.click();await expect(publish).toBeEnabled();await expect(keep).toBeChecked();
    await expect(preview.locator('[data-customer-request-expiry] time')).toHaveAttribute('datetime',deadline!);
    const calls=await page.evaluate(()=>window.__quoteSignoff.calls),prefix=`reception.signoff.${kind==='quote'?'':'completion.'}`;
    expect(calls.filter(c=>c.method===prefix+'prepare')).toHaveLength(1);const resumes=calls.filter(c=>c.method===prefix+'resume');expect(resumes).toHaveLength(2);expect(resumes[0]!.payload).toEqual(resumes[1]!.payload);
  });
  test(`a failed ${kind} refresh stops offering Retry when its customer deadline ends`,async({page})=>{
    const {publish,preview,refresh}=await prepare(page,kind,{days:1});await page.clock.fastForward(86_340_000);await page.evaluate(()=>window.__quoteSignoff.failResume(true));await refresh.click();
    const retry=preview.getByRole('button',{name:kind==='quote'?'Retry sign-off preview':'Retry completion preview',exact:true});await expect(retry).toBeVisible();
    await page.clock.fastForward(61_000);await expect(retry).toBeHidden();await expect(publish).toBeDisabled();await expect(preview.locator('[data-customer-request-ended]')).toContainText('Prepare a new request');
  });
  for(const checked of[false,true])test(`same-request ${kind} refresh retains the follow-up choice ${checked}`,async({page})=>{
    const {publish,refresh}=await prepare(page,kind);const keep=page.getByLabel('Save this link for follow-up emails',{exact:true});await keep.setChecked(checked);
    await page.clock.fastForward(600001);await refresh.click();await expect(publish).toBeEnabled();await expect(keep).toBeChecked({checked});await publish.click();
    await expect(page.locator('[data-customer-link-share] input')).not.toHaveValue('');const call=await page.evaluate(()=>window.__quoteSignoff.calls.filter(c=>c.method.endsWith('.publish')).at(-1));
    expect((call?.payload as {remember_link_for_reminders?:boolean}).remember_link_for_reminders).toBe(checked?true:undefined);
  });
  test(`preparing another ${kind} request clears the previous follow-up choice`,async({page})=>{
    const {publish}=await prepare(page,kind);const keep=page.getByLabel('Save this link for follow-up emails',{exact:true});await keep.check();
    await page.getByRole('button',{name:kind==='quote'?'Prepare sign-off preview':'Prepare completion preview',exact:true}).click();await expect(publish).toBeEnabled();await expect(keep).not.toBeChecked();
  });
  test(`discarding local ${kind} fields clears consent before resuming its saved request`,async({page})=>{
    const {publish}=await prepare(page,kind);const keep=page.getByLabel('Save this link for follow-up emails',{exact:true});await keep.check();
    await page.getByRole('button',{name:kind==='quote'?'Discard draft':'Discard completion draft',exact:true}).click();
    await page.getByRole('button',{name:kind==='quote'?'Resume preview':'Resume completion preview',exact:true}).click();await expect(publish).toBeEnabled();await expect(keep).not.toBeChecked();
  });
}
for(const offset of[-18_000_000,18_000_000])test(`customer expiry uses the server clock when the owner differs by ${offset}ms`,async({page})=>{
  const {publish,preview,refresh}=await prepare(page,'quote',{days:1,query:'server_clock_offset='+offset});await page.clock.fastForward(86_340_000);await refresh.click();await expect(publish).toBeEnabled();
  await page.clock.fastForward(61_000);await expect(publish).toBeDisabled();await expect(preview.locator('[data-customer-request-ended]')).toBeVisible();
});
test('an owner wall-clock adjustment changes neither the customer deadline gate nor its remaining-time hint',async({page})=>{
  const {publish,preview}=await prepare(page,'quote',{days:1});await page.clock.setSystemTime('2026-11-24T12:00:00Z');await page.evaluate(()=>window.__quoteSignoff.update());
  await expect(publish).toBeEnabled();await expect(preview.locator('[data-customer-request-expiry]')).not.toContainText('Expired.');
});
