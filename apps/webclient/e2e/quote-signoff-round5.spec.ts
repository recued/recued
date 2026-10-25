import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {expect,test,type Page} from '@playwright/test';
import {HARNESS_ORIGIN} from './helpers/harness-origin.js';
import {openSignoffRequestDetails} from './helpers/signoff-request.js';
import type {} from './harness/quote-signoff-harness.js';

const BASE=`${HARNESS_ORIGIN}/quote-signoff-harness.html`,errors=new WeakMap<Page,string[]>();
test.beforeEach(async({page})=>{
  const failures:string[]=[];errors.set(page,failures);page.on('pageerror',e=>failures.push(e.message));
  const policy=(await readFile(resolve(import.meta.dirname,'../public/_headers'),'utf8')).match(/^\s*Content-Security-Policy:\s*(.+)$/m)![1]!;
  await page.route(/\/(quote-signoff)-harness\.html/,async route=>{const response=await route.fetch();await route.fulfill({response,headers:{...response.headers(),'content-security-policy':policy}});});
});
test.afterEach(async({page})=>expect(errors.get(page)).toEqual([]));
const fillQuote=async(page:Page)=>{
  const creation=page.locator('[data-signoff-create]');if(!await creation.evaluate(n=>(n as HTMLDetailsElement).open))await creation.locator('summary').click();
  await page.getByRole('combobox',{name:'Open quote',exact:true}).selectOption('Q1');
  for(const [label,value]of[['Business name shown to the customer','Studio'],['Complete scope shown to the customer','Three drawings.'],['Task to create after your approval','Deliver drawings'],['Invoice reference','INV-NEW']])await page.getByLabel(label,{exact:true}).fill(value!);
};
const prepare=async(page:Page,kind:'quote'|'completion',query='')=>{
  await page.goto(BASE+'?'+(kind==='completion'?'completion&':'')+query);
  if(kind==='quote'){await fillQuote(page);await page.getByRole('button',{name:'Prepare sign-off preview',exact:true}).click();}
  else{
    await openSignoffRequestDetails(page.locator('[data-signoff-history] article').first());await page.getByRole('button',{name:'Request completion',exact:true}).click();
    await page.getByLabel('Delivered work shown to the customer',{exact:true}).fill('Delivered the agreed drawings.');await page.getByRole('button',{name:'Prepare completion preview',exact:true}).click();
  }
  await expect(page.getByRole('button',{name:kind==='quote'?'Publish sign-off link':'Publish completion link',exact:true})).toBeVisible();
  return kind==='quote'?page.locator('[data-signoff-preview]'):page.getByRole('form',{name:'Request customer completion',exact:true});
};
const publishCompletion=async(page:Page)=>{await prepare(page,'completion');await page.getByRole('button',{name:'Publish completion link',exact:true}).click();const share=page.locator('[data-customer-link-share]');await expect(share.locator('input')).not.toHaveValue('');return share;};

for(const decision of['accepted','corrections_requested'] as const){
  test(`retires the global share on a received ${decision} reply before processing`,async({page})=>{
    const share=await publishCompletion(page);
    await page.evaluate(decision=>window.__quoteSignoff.completionResponse(decision,decision==='corrections_requested'?'Fix the scale.':undefined,undefined,true),decision);
    await expect(page.locator('[data-completion-history] article')).toContainText(decision==='accepted'?'Customer accepted completion.':'Customer requested corrections.');
    await expect(share.getByRole('heading',{name:'Link unavailable',exact:true})).toBeVisible();await expect(share.locator('input')).toHaveValue('');await expect(share.getByRole('button',{name:'Copy link',exact:true})).toBeDisabled();
    expect(await page.evaluate(()=>window.__quoteSignoff.calls.filter(c=>c.method==='reception.signoff.link.check').length)).toBe(0);
  });

}

const requestDuringRefresh=async(page:Page)=>{
  await page.goto(BASE+'?completion');await openSignoffRequestDetails(page.locator('[data-signoff-history] article').first());
  const request=page.getByRole('button',{name:'Request completion',exact:true});await request.scrollIntoViewIfNeeded();
  await page.evaluate(()=>{window.__quoteSignoff.deferNext('reception.signoff.list');window.__quoteSignoff.update();});return request;
};
const releaseRead=async(page:Page)=>page.evaluate(async()=>{window.__quoteSignoff.release();await new Promise(resolve=>setTimeout(resolve,0));});
test('keeps a pressed mouse action alive until the native click completes',async({page})=>{
  const request=await requestDuringRefresh(page),original=(await request.elementHandle())!,box=(await request.boundingBox())!;
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await releaseRead(page);
  expect(await original.evaluate(n=>n.isConnected)).toBe(true);await expect(page.getByRole('form',{name:'Request customer completion',exact:true})).toBeHidden();
  await page.mouse.up();await expect(page.getByRole('form',{name:'Request customer completion',exact:true})).toBeVisible();await expect(page.getByLabel('Delivered work shown to the customer',{exact:true})).toBeFocused();
});
test('keeps a held Space activation alive through a history response',async({page})=>{
  const request=await requestDuringRefresh(page),original=(await request.elementHandle())!;await request.focus();await page.keyboard.down('Space');await releaseRead(page);
  expect(await original.evaluate(n=>n.isConnected)).toBe(true);await page.keyboard.up('Space');await expect(page.getByRole('form',{name:'Request customer completion',exact:true})).toBeVisible();
});
test('preserves a disclosure toggle when pointer-up and a history response meet',async({page})=>{
  await page.goto(BASE+'?completion');const details=page.locator('[data-signoff-disclosure=actions]'),summary=details.locator('summary').first();await summary.scrollIntoViewIfNeeded();
  await page.evaluate(()=>{window.__quoteSignoff.deferNext('reception.signoff.list');window.__quoteSignoff.update();});
  const original=(await summary.elementHandle())!,box=(await summary.boundingBox())!;await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await releaseRead(page);
  expect(await original.evaluate(n=>n.isConnected)).toBe(true);await page.mouse.up();await expect(details).toHaveAttribute('open','');await expect(summary).toBeFocused();
});
test('disposal releases an interaction-blocked response without restoring its controls',async({page})=>{
  const request=await requestDuringRefresh(page),box=(await request.boundingBox())!;await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await releaseRead(page);
  await page.evaluate(()=>window.__quoteSignoff.dispose());await page.mouse.up();await expect(page.locator('[data-recued-quote-signoffs]')).toHaveCount(0);
});

for(const kind of['quote','completion'] as const){
  test(`refreshes an expired ${kind} review before Publish without replacing the request or extending its customer deadline`,async({page})=>{
    await page.clock.install({time:new Date('2026-10-24T12:00:00Z')});const preview=await prepare(page,kind),publish=page.getByRole('button',{name:kind==='quote'?'Publish sign-off link':'Publish completion link',exact:true});
    const deadline=await preview.locator('[data-customer-request-expiry] time').getAttribute('datetime');await expect(preview.locator('[data-customer-preview-freshness]')).toContainText('Review valid until');
    await page.clock.fastForward(600_001);await expect(publish).toBeDisabled();const refresh=preview.getByRole('button',{name:kind==='quote'?'Refresh sign-off preview':'Refresh completion preview',exact:true});await expect(refresh).toBeVisible();
    expect(await page.evaluate(()=>window.__quoteSignoff.calls.filter(c=>c.method.endsWith('.publish')).length)).toBe(0);
    await refresh.click();await expect(publish).toBeEnabled();await expect(preview.locator('[data-customer-request-expiry] time')).toHaveAttribute('datetime',deadline!);
    const calls=await page.evaluate(()=>window.__quoteSignoff.calls);expect(calls.filter(c=>c.method===`reception.signoff.${kind==='quote'?'':'completion.'}prepare`)).toHaveLength(1);
    expect(calls.filter(c=>c.method===`reception.signoff.${kind==='quote'?'':'completion.'}resume`)).toHaveLength(1);
    await publish.click();await expect(page.locator('[data-customer-link-share] input')).not.toHaveValue('');
  });
  test(`editing an expired ${kind} review requires preparation instead of silently resuming saved terms`,async({page})=>{
    await page.clock.install({time:new Date('2026-10-24T12:00:00Z')});await prepare(page,kind);await page.clock.fastForward(600_001);
    await page.getByLabel(kind==='quote'?'Complete scope shown to the customer':'Delivered work shown to the customer',{exact:true}).fill('Changed terms.');await expect(page.locator('[data-customer-preview-freshness]')).toHaveCount(0);
    expect(await page.evaluate(()=>window.__quoteSignoff.calls.filter(c=>c.method.endsWith('.resume')).length)).toBe(0);
  });
}
for(const offset of[-18_000_000,18_000_000])test(`review freshness uses server timing when the owner clock differs by ${offset}ms`,async({page})=>{
  await page.clock.install({time:new Date('2026-10-24T12:00:00Z')});await prepare(page,'quote','server_clock_offset='+offset);const publish=page.getByRole('button',{name:'Publish sign-off link',exact:true});
  await expect(publish).toBeEnabled();await page.clock.fastForward(599_000);await expect(publish).toBeEnabled();await page.clock.fastForward(2_000);await expect(publish).toBeDisabled();
});
test('changing the owner wall clock does not expire a newly received review',async({page})=>{
  await page.clock.install({time:new Date('2026-10-24T12:00:00Z')});await prepare(page,'quote');await page.clock.setSystemTime('2026-10-25T12:00:00Z');await expect(page.getByRole('button',{name:'Publish sign-off link',exact:true})).toBeEnabled();
});
test('older servers retain the existing guarded publish-and-resume recovery',async({page})=>{
  await page.clock.install({time:new Date('2026-10-24T12:00:00Z')});await prepare(page,'quote','legacy_preview');await page.clock.fastForward(600_001);
  await expect(page.locator('[data-customer-preview-freshness]')).toHaveCount(0);await expect(page.getByRole('button',{name:'Publish sign-off link',exact:true})).toBeEnabled();
  await page.evaluate(()=>window.__quoteSignoff.failPublish('expired'));await page.getByRole('button',{name:'Publish sign-off link',exact:true}).click();await expect(page.getByRole('button',{name:'Resume preview',exact:true})).toBeVisible();
});
test('disposing a prepared view removes its review timer and refresh controls',async({page})=>{
  await page.clock.install({time:new Date('2026-10-24T12:00:00Z')});await prepare(page,'quote');await page.evaluate(()=>window.__quoteSignoff.remount());await page.clock.fastForward(600_001);await expect(page.locator('[data-customer-preview-freshness]')).toHaveCount(0);
});
