import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {expect,test,type Page} from '@playwright/test';
import {HARNESS_ORIGIN} from './helpers/harness-origin.js';
import {openSignoffRequestDetails} from './helpers/signoff-request.js';
import {installCustomerWorkFixture} from './fixtures/customer-work.js';
import type {} from './harness/quote-signoff-harness.js';

const BASE=`${HARNESS_ORIGIN}/quote-signoff-harness.html`;
const failures=new WeakMap<Page,string[]>();
test.beforeEach(async({page})=>{
  const errors:string[]=[];failures.set(page,errors);page.on('pageerror',error=>errors.push(error.message));
  const headers=await readFile(resolve(import.meta.dirname,'../public/_headers'),'utf8');
  const policy=headers.match(/^\s*Content-Security-Policy:\s*(.+)$/m)![1]!;
  await page.route(/\/(quote-signoff|full-app)-harness\.html/,async route=>{
    const response=await route.fetch();await route.fulfill({response,headers:{...response.headers(),'content-security-policy':policy}});
  });
});
test.afterEach(async({page})=>expect(failures.get(page)).toEqual([]));
const fill=async(page:Page)=>{
  const creation=page.locator('[data-signoff-create]');if(!await creation.evaluate(n=>(n as HTMLDetailsElement).open))await creation.locator('summary').click();
  await page.getByRole('combobox',{name:'Open quote',exact:true}).selectOption('Q1');
  await page.getByLabel('Business name shown to the customer',{exact:true}).fill('Studio');
  await page.getByLabel('Complete scope shown to the customer',{exact:true}).fill('Three drawings and final PDF delivery.');
  await page.getByLabel('Task to create after your approval',{exact:true}).fill('Deliver drawings');
  await page.getByLabel('Invoice reference',{exact:true}).fill('INV-NEW');
};
const prepare=async(page:Page,kind:'quote'|'completion',query='')=>{
  await page.goto(BASE+'?'+(kind==='completion'?'completion&':'')+query);
  if(kind==='quote'){await fill(page);await page.getByRole('button',{name:'Prepare sign-off preview',exact:true}).click();}
  else{
    await openSignoffRequestDetails(page.locator('[data-signoff-history] article').first());
    await page.getByRole('button',{name:'Request completion',exact:true}).click();
    await page.getByLabel('Delivered work shown to the customer',{exact:true}).fill('Delivered the agreed drawings.');
    await page.getByRole('button',{name:'Prepare completion preview',exact:true}).click();
  }
  await expect(page.getByRole('button',{name:kind==='quote'?'Publish sign-off link':'Publish completion link',exact:true})).toBeVisible();
};
const publish=async(page:Page,kind:'quote'|'completion'='quote',query='')=>{
  await prepare(page,kind,query);await page.getByRole('button',{name:kind==='quote'?'Publish sign-off link':'Publish completion link',exact:true}).click();
  const share=page.locator('[data-customer-link-share]');await expect(share.locator('input')).not.toHaveValue('');return share;
};
for(const kind of['quote','completion'] as const)for(const failure of['expired','offline'] as const)test(`reveals a ${kind} ${failure} publish failure on a phone and resumes the same saved terms`,async({page})=>{
  await page.setViewportSize({width:390,height:844});await prepare(page,kind);
  const preview=page.getByRole('button',{name:kind==='quote'?'Publish sign-off link':'Publish completion link',exact:true}).locator('..');
  const expiry=await preview.locator('[data-customer-request-expiry] time').getAttribute('datetime');
  const field=page.getByLabel(kind==='quote'?'Complete scope shown to the customer':'Delivered work shown to the customer',{exact:true}),terms=await field.inputValue();
  await page.evaluate(failure=>window.__quoteSignoff.failPublish(failure),failure);
  await page.getByRole('button',{name:kind==='quote'?'Publish sign-off link':'Publish completion link',exact:true}).click();
  const error=page.getByRole('status').filter({hasText:failure==='expired'?'This preview expired.':'Fixture publish unavailable.'});await expect(error).toBeFocused();await expect(error).toBeInViewport();
  await expect(field).toHaveValue(terms);await page.getByRole('button',{name:kind==='quote'?'Resume preview':'Resume completion preview',exact:true}).click();
  await expect(page.getByRole('button',{name:kind==='quote'?'Publish sign-off link':'Publish completion link',exact:true})).toBeVisible();await expect(field).toHaveValue(terms);
  await expect(preview.locator('[data-customer-request-expiry] time')).toHaveAttribute('datetime',expiry!);
});

const openQueue=async(page:Page)=>{
  await page.addInitScript(installCustomerWorkFixture);
  await page.addInitScript(()=>setInterval(()=>window.__app?.fireMessage({type:'server_heartbeat',payload:{server_id:'fixture-server',last_seen_at:Date.now(),lifecycle_state:'running',uptime_s:120,supervisor_mode:'systemd'}}),1000));
  await page.goto(`${HARNESS_ORIGIN}/full-app-harness.html?jobs=1&completions=60#reception/signoffs`);
  const filter=page.getByRole('combobox',{name:'Completion requests',exact:true});await filter.selectOption('review');
  await page.getByRole('button',{name:'Older completions',exact:true}).click();
  const card=page.locator('[data-completion-history] article').first();await expect(card).toHaveAttribute('data-completion-id','completion-51');
  await card.locator('[data-completion-disclosure=terms] summary').click();
  return card;
};
const leaveQueue=async(page:Page)=>{
  const action=page.locator('[data-completion-history] article').first().getByRole('link',{name:'Review completion in Reception Inbox',exact:true});
  await action.scrollIntoViewIfNeeded();await action.focus();
  const scroll=await page.locator('[data-recued-webclient-content]').evaluate(n=>n.scrollTop);
  await action.click();await expect(page).toHaveURL(/#reception\/inbox\/completion-51$/);await expect(page.locator('[data-recued-quote-signoffs]')).toHaveCount(0);
  return scroll;
};
test('restores completion filter, page, disclosures, scroll and return focus after review and native Back',async({page})=>{
  await openQueue(page);const scroll=await leaveQueue(page);await page.goBack();
  await expect(page.getByRole('combobox',{name:'Completion requests',exact:true})).toHaveValue('review');
  const cards=page.locator('[data-completion-history] article');await expect(cards).toHaveCount(10);await expect(cards.first()).toHaveAttribute('data-completion-id','completion-51');
  await expect(cards.first().locator('[data-completion-disclosure=terms]')).toHaveAttribute('open','');
  await expect(cards.first().getByRole('link',{name:'Review completion in Reception Inbox',exact:true})).toBeFocused();
  await expect.poll(()=>page.locator('[data-recued-webclient-content]').evaluate(n=>n.scrollTop)).toBeCloseTo(scroll,0);
  const state=await page.evaluate(()=>history.state.recuedCustomerRequests);expect(state.returnBoard).toBe('completions');
  expect(state.completion).toMatchObject({filter:'review',cursor:'50',returnId:'completion-51'});
  expect(JSON.stringify(state)).not.toMatch(/Saved delivery|Delivered three drawings|share_url|delivery_summary/);
});
test('a delayed completion restoration respects the owner moving focus elsewhere',async({page})=>{
  await openQueue(page);await leaveQueue(page);
  await page.evaluate(()=>{(window as unknown as {__customerUxHold:string}).__customerUxHold='reception.signoff.completion.list';});await page.goBack();
  const search=page.getByLabel('Find customer, quote or invoice',{exact:true});await search.click();await search.fill('An unfinished search');
  await page.evaluate(()=>{(window as unknown as {__customerUxRelease?:()=>void}).__customerUxRelease?.();});
  await expect(page.locator('[data-completion-history] article').first()).toHaveAttribute('data-completion-id','completion-51');await expect(search).toBeFocused();await expect(search).toHaveValue('An unfinished search');
});

for(const kind of['quote','completion'] as const)test(`keeps the published ${kind} customer identity on its retained share card`,async({page})=>{
  const share=await publish(page,kind,'two_quotes');const url=await share.locator('input').inputValue();
  const creation=page.locator('[data-signoff-create]');if(!await creation.evaluate(n=>(n as HTMLDetailsElement).open))await creation.locator('summary').click();
  await page.getByRole('combobox',{name:'Open quote',exact:true}).selectOption('Q2');await page.getByLabel('Complete scope shown to the customer',{exact:true}).fill('A new brand book for Taylor.');
  const identity=share.locator('[data-customer-link-identity]');await expect(identity).toContainText('Drawings — Morgan');await expect(identity).not.toContainText('Taylor');
  if(kind==='quote')await expect(identity).toContainText('Quote Q1');
  await expect(share.locator('input')).toHaveValue(url);await expect(share.getByRole('button',{name:'Copy link',exact:true})).toBeEnabled();
  await page.evaluate(()=>{window.__quoteSignoff.linkStatus('unavailable');window.dispatchEvent(new Event('focus'));});
  await expect(share.getByRole('heading',{name:'Link availability unknown',exact:true})).toBeVisible();await expect(identity).toContainText('Drawings — Morgan');
});

test('coalesces return checks and preserves manual-copy feedback, focus and partial selection',async({page})=>{
  await page.addInitScript(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('Clipboard unavailable');}}}));
  const share=await publish(page);await share.getByRole('button',{name:'Copy link',exact:true}).click();const field=share.locator('input');await expect(field).toBeFocused();
  await field.evaluate(n=>(n as HTMLInputElement).setSelectionRange(5,20,'backward'));
  const before=await page.evaluate(()=>window.__quoteSignoff.calls.filter(c=>c.method==='reception.signoff.link.check').length);
  await page.evaluate(()=>{window.__quoteSignoff.deferNext('reception.signoff.link.check');window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));});
  await expect(field).toBeDisabled();await expect(field).toHaveValue('');
  expect(await page.evaluate(()=>window.__quoteSignoff.calls.filter(c=>c.method==='reception.signoff.link.check').length)).toBe(before+1);
  await page.evaluate(()=>window.__quoteSignoff.release());await expect(field).toBeFocused();
  await expect.poll(()=>field.evaluate(n=>[(n as HTMLInputElement).selectionStart,(n as HTMLInputElement).selectionEnd,(n as HTMLInputElement).selectionDirection])).toEqual([5,20,'backward']);
  await expect(share.getByRole('status')).toContainText('Copy is unavailable. The link is selected');
});
test('does not take focus back after the owner moves during a selected-link recheck',async({page})=>{
  const share=await publish(page);const field=share.locator('input');await field.focus();
  await page.evaluate(()=>{window.__quoteSignoff.deferNext('reception.signoff.link.check');window.dispatchEvent(new Event('focus'));});await expect(field).toBeDisabled();
  const scope=page.getByLabel('Complete scope shown to the customer',{exact:true});await scope.click();
  await page.evaluate(()=>window.__quoteSignoff.release());await expect(field).toBeEnabled();await expect(scope).toBeFocused();
});
for(const status of['inactive','unavailable'] as const)test(`keeps a selected link disabled when its return check is ${status}`,async({page})=>{
  const share=await publish(page);const field=share.locator('input');await field.focus();
  await page.evaluate(()=>{window.__quoteSignoff.deferNext('reception.signoff.link.check');window.dispatchEvent(new Event('focus'));});await expect(field).toBeDisabled();
  await page.evaluate(status=>{window.__quoteSignoff.linkStatus(status);window.__quoteSignoff.release();},status);
  await expect(share.getByRole('heading',{name:status==='inactive'?'Link unavailable':'Link availability unknown',exact:true})).toBeVisible();
  await expect(field).toBeDisabled();await expect(field).toHaveValue('');await expect(share.getByRole('button',{name:'Copy link',exact:true})).toBeDisabled();
});
test('a disposed selected-link recheck cannot focus or recreate the old share card',async({page})=>{
  const share=await publish(page);await share.locator('input').focus();
  await page.evaluate(()=>{window.__quoteSignoff.deferNext('reception.signoff.link.check');window.dispatchEvent(new Event('focus'));});await expect(share.locator('input')).toBeDisabled();
  await page.evaluate(()=>window.__quoteSignoff.remount());const search=page.getByLabel('Find customer, quote or invoice',{exact:true});await search.click();
  await page.evaluate(()=>window.__quoteSignoff.release());await expect(page.locator('[data-customer-link-share]')).toHaveCount(0);await expect(search).toBeFocused();
});
test('does not start a queued return check after the sharing view is disposed',async({page})=>{
  const share=await publish(page);await share.locator('input').focus();
  const before=await page.evaluate(()=>window.__quoteSignoff.calls.filter(c=>c.method==='reception.signoff.link.check').length);
  await page.evaluate(()=>{window.dispatchEvent(new Event('focus'));window.__quoteSignoff.dispose();});
  expect(await page.evaluate(()=>window.__quoteSignoff.calls.filter(c=>c.method==='reception.signoff.link.check').length)).toBe(before);
  await expect(page.locator('[data-customer-link-share]')).toHaveCount(0);
});
