import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { APPROVAL_LINK_VISITOR_COMMENT_MAX } from '@recued/contracts';
import { renderApprovalLinkHtml } from '../../../backend/server/src/ports/reception/handlers/approval-link-render.js';
import { lookupReceptionStaticAsset } from '../../../backend/server/src/ports/reception/static-assets.js';
import { HARNESS_ORIGIN } from './helpers/harness-origin.js';
import { openSignoffRequestDetails } from './helpers/signoff-request.js';
import type {} from './harness/quote-signoff-harness.js';

declare global { interface Window { __round3Copies?: string[] } }
const BASE = `${HARNESS_ORIGIN}/quote-signoff-harness.html`;
const errors = new WeakMap<Page,string[]>();
test.beforeEach(async ({page}) => {
  const failures: string[] = []; errors.set(page,failures); page.on('pageerror',error => failures.push(error.message));
  const headers = await readFile(resolve(import.meta.dirname,'../public/_headers'),'utf8');
  const policy = headers.match(/^\s*Content-Security-Policy:\s*(.+)$/m)![1]!;
  await page.route('**/quote-signoff-harness.html*',async route => { const response = await route.fetch(); await route.fulfill({response,headers:{...response.headers(),'content-security-policy':policy}}); });
});
test.afterEach(async ({page}) => { expect(errors.get(page)).toEqual([]); });
const creation = (page: Page) => page.locator('[data-signoff-create]');
const card = (page: Page) => page.locator('[data-signoff-history] article').first();
const fill = async (page: Page) => {
  if (!await creation(page).evaluate(node => (node as HTMLDetailsElement).open)) await creation(page).locator('summary').click();
  await page.getByRole('combobox',{name:'Open quote',exact:true}).selectOption('Q1');
  await page.getByLabel('Business name shown to the customer',{exact:true}).fill('Studio');
  await page.getByLabel('Complete scope shown to the customer',{exact:true}).fill('Three drawings and final PDF delivery.');
  await page.getByLabel('Task to create after your approval',{exact:true}).fill('Deliver drawings');
  await page.getByLabel('Invoice reference',{exact:true}).fill('INV-NEW');
};
const prepare = async (page: Page, kind: 'quote' | 'completion') => {
  await page.goto(BASE+(kind==='completion'?'?completion':''));
  if (kind==='quote') { await fill(page); await page.getByRole('button',{name:'Prepare sign-off preview',exact:true}).click(); }
  else {
    await openSignoffRequestDetails(card(page)); await page.getByRole('button',{name:'Request completion',exact:true}).click();
    await page.getByLabel('Delivered work shown to the customer',{exact:true}).fill('Delivered the agreed drawings.');
    await page.getByRole('button',{name:'Prepare completion preview',exact:true}).click();
  }
  await expect(page.getByRole('button',{name:kind==='quote'?'Publish sign-off link':'Publish completion link',exact:true})).toBeVisible();
};
const publish = async (page: Page,kind: 'quote' | 'completion') => {
  await prepare(page,kind); await page.getByRole('button',{name:kind==='quote'?'Publish sign-off link':'Publish completion link',exact:true}).click();
  await expect(page.getByLabel(kind==='quote'?'Customer sign-off link':'Customer completion link',{exact:true})).not.toHaveValue('');
  return page.locator('[data-customer-link-share]');
};
const clipboard = async (page: Page) => page.addInitScript(() => {
  window.__round3Copies=[];
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async (value: string) => { window.__round3Copies!.push(value); }}});
});

for (const kind of ['quote','completion'] as const) {
  test(`closes a ${kind} share after a refreshed customer response`,async ({page}) => {
    const share=await publish(page,kind);
    if(kind==='quote')await page.evaluate(()=>window.__quoteSignoff.setReview('waiting'));
    else await page.evaluate(()=>window.__quoteSignoff.completionResponse('accepted'));
    await expect(share.getByRole('heading',{name:'Link unavailable',exact:true})).toBeVisible();
    await expect(share.getByRole('button',{name:'Copy link',exact:true})).toBeDisabled(); await expect(share.locator('input')).toHaveValue('');
  });
  test(`closes the visible ${kind} share state after cancellation`,async ({page}) => {
    const share=await publish(page,kind);
    if(kind==='quote')await openSignoffRequestDetails(card(page));
    const cancel=kind==='quote'?card(page).getByRole('button',{name:'Cancel request',exact:true}):page.locator('[data-completion-history]').getByRole('button',{name:'Cancel completion request',exact:true});
    await cancel.click();
    await expect(share.getByRole('heading',{name:'Link unavailable',exact:true})).toBeVisible();
    await expect(share.getByRole('button',{name:'Copy link',exact:true})).toBeDisabled();
    await expect(share.locator('input')).toHaveValue('');
    expect(await page.evaluate(()=>window.__quoteSignoff.calls.some(call=>call.method==='reception.signoff.link.check'))).toBe(true);
  });
  test(`expires a ${kind} share without a new owner action`,async ({page}) => {
    await page.clock.install({time:new Date('2026-10-23T12:00:00Z')});
    const share=await publish(page,kind); const expiry=await share.locator('time').getAttribute('datetime');
    const now=await page.evaluate(()=>Date.now()); await page.clock.fastForward(Date.parse(expiry!)-now+1);
    await expect(share.getByRole('button',{name:'Copy link',exact:true})).toBeDisabled(); await expect(share.locator('input')).toHaveValue('');
    await expect(share.getByRole('status')).toContainText('Link expired');
  });
  test(`resumes its own unchanged ${kind} draft after an expired publish preview`,async ({page}) => {
    await prepare(page,kind); await page.evaluate(()=>window.__quoteSignoff.failPublish('expired'));
    await page.getByRole('button',{name:kind==='quote'?'Publish sign-off link':'Publish completion link',exact:true}).click();
    await expect(page.getByText(/^This preview expired\./)).toBeVisible();
    await page.getByRole('button',{name:kind==='quote'?'Resume preview':'Resume completion preview',exact:true}).click();
    const publishButton=page.getByRole('button',{name:kind==='quote'?'Publish sign-off link':'Publish completion link',exact:true}); await expect(publishButton).toBeVisible();
    const methods=kind==='quote'?{prepare:'reception.signoff.prepare',resume:'reception.signoff.resume',publish:'reception.signoff.publish',id:'a1fecd4e-42ce-42a2-b7e7-731ce51a01b2',hash:'e'}:{prepare:'reception.signoff.completion.prepare',resume:'reception.signoff.completion.resume',publish:'reception.signoff.completion.publish',id:'b1fecd4e-42ce-42a2-b7e7-731ce51a01b2',hash:'f'};
    const recovered=await page.evaluate(()=>window.__quoteSignoff.calls);
    expect(recovered.filter(call=>call.method===methods.prepare)).toHaveLength(1); expect(recovered.filter(call=>call.method===methods.resume)).toHaveLength(1);
    await page.evaluate(()=>window.__quoteSignoff.failPublish(null)); await publishButton.click();
    const result=await page.evaluate(()=>window.__quoteSignoff.calls);
    expect(result.filter(call=>call.method===methods.publish).at(-1)?.payload).toMatchObject({[kind==='quote'?'signoff_id':'completion_id']:methods.id,preview_hash:methods.hash.repeat(64)});
  });
  test(`keeps the dirty-form guard for edited ${kind} terms after a publish failure`,async ({page}) => {
    await prepare(page,kind); await page.evaluate(()=>window.__quoteSignoff.failPublish('offline'));
    await page.getByRole('button',{name:kind==='quote'?'Publish sign-off link':'Publish completion link',exact:true}).click();
    await expect(page.getByText(/Fixture publish unavailable/)).toBeVisible();
    const field=page.getByLabel(kind==='quote'?'Complete scope shown to the customer':'Delivered work shown to the customer',{exact:true}); await field.fill('Changed terms that have not been saved.');
    await page.getByRole('button',{name:kind==='quote'?'Resume preview':'Resume completion preview',exact:true}).click();
    await expect(page.getByText(kind==='quote'?'Finish or discard the current draft before resuming a saved preview.':'Finish or discard the current completion draft before resuming another preview.',{exact:true})).toBeVisible();
    await expect(field).toHaveValue('Changed terms that have not been saved.');
    expect(await page.evaluate(method=>window.__quoteSignoff.calls.filter(call=>call.method===method).length,kind==='quote'?'reception.signoff.resume':'reception.signoff.completion.resume')).toBe(0);
  });
  test(`shows the saved ${kind} deadline before publishing a resumed request`,async ({page}) => {
    await page.clock.install({time:new Date('2026-10-23T12:00:00Z')}); await prepare(page,kind);
    const preview=kind==='quote'?page.locator('[data-signoff-preview]'):page.getByRole('form',{name:'Request customer completion',exact:true});
    const initial=await preview.locator('[data-customer-request-expiry] time').getAttribute('datetime');
    await page.clock.fastForward(6 * 86_400_000); await page.evaluate(()=>window.__quoteSignoff.remount());
    await page.getByRole('button',{name:kind==='quote'?'Resume preview':'Resume completion preview',exact:true}).click();
    await expect(preview.locator('[data-customer-request-expiry] time')).toHaveAttribute('datetime',initial!);
    await expect(preview.locator('[data-customer-request-remaining]')).toContainText('24 hours left');
    const history=kind==='quote'?card(page):page.locator('[data-completion-history] article'); await expect(history.locator('[data-customer-request-expiry] time')).toHaveAttribute('datetime',initial!);
    await page.getByRole('button',{name:kind==='quote'?'Publish sign-off link':'Publish completion link',exact:true}).click();
    await expect(page.locator('[data-customer-link-share] time')).toHaveAttribute('datetime',initial!);
  });
}

test('checks the exact saved link again before copying and refuses a closed token',async ({page}) => {
  await clipboard(page); const share=await publish(page,'quote'); await page.evaluate(()=>window.__quoteSignoff.linkStatus('inactive'));
  await share.getByRole('button',{name:'Copy link',exact:true}).click();
  await expect(share.getByRole('heading',{name:'Link unavailable',exact:true})).toBeVisible();
  await expect(share.getByRole('button',{name:'Copy link',exact:true})).toBeDisabled(); expect(await page.evaluate(()=>window.__round3Copies)).toEqual([]);
});
test('does not copy an uncertain link and allows retry after availability recovers',async ({page}) => {
  await clipboard(page); const share=await publish(page,'quote'); await page.evaluate(()=>window.__quoteSignoff.linkStatus('unavailable'));
  await share.getByRole('button',{name:'Copy link',exact:true}).click(); await expect(share.getByRole('heading',{name:'Link availability unknown',exact:true})).toBeVisible();
  await expect(share.locator('input')).toHaveValue(''); expect(await page.evaluate(()=>window.__round3Copies)).toEqual([]);
  await page.evaluate(()=>window.__quoteSignoff.linkStatus('current')); await share.getByRole('button',{name:'Check link availability',exact:true}).click();
  await expect(share.getByRole('button',{name:'Copy link',exact:true})).toBeEnabled(); await share.getByRole('button',{name:'Copy link',exact:true}).click();
  await expect(share.getByRole('status')).toHaveText('Link copied.'); expect(await page.evaluate(()=>window.__round3Copies)).toHaveLength(1);
});
test('a cancelled request invalidates a pending copy availability check',async ({page}) => {
  await clipboard(page); const share=await publish(page,'quote'); await page.evaluate(()=>window.__quoteSignoff.deferNext('reception.signoff.link.check'));
  await share.getByRole('button',{name:'Copy link',exact:true}).click(); await expect(share.getByRole('heading',{name:'Checking saved link',exact:true})).toBeVisible();
  await openSignoffRequestDetails(card(page)); await card(page).getByRole('button',{name:'Cancel request',exact:true}).click();
  await expect(share.getByRole('heading',{name:'Link unavailable',exact:true})).toBeVisible(); await page.evaluate(()=>window.__quoteSignoff.release());
  await expect(share.getByRole('button',{name:'Copy link',exact:true})).toBeDisabled(); expect(await page.evaluate(()=>window.__round3Copies)).toEqual([]);
});
test('disposal removes share expiry and visibility work',async ({page}) => {
  await page.clock.install({time:new Date('2026-10-23T12:00:00Z')}); await publish(page,'quote');
  await page.evaluate(()=>window.__quoteSignoff.dispose()); const before=await page.evaluate(()=>window.__quoteSignoff.calls.length);
  await page.clock.fastForward(8*86_400_000);
  await page.evaluate(()=>{window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));});
  expect(await page.evaluate(()=>window.__quoteSignoff.calls.length)).toBe(before); await expect(page.locator('[data-customer-link-share]')).toHaveCount(0);
});
test('preserves the selected quote and terms through a failed roster read and recovery',async ({page}) => {
  await page.goto(BASE); await fill(page);
  await page.evaluate(()=>{window.__quoteSignoff.setQuoteRoster('error');window.__quoteSignoff.update();});
  await expect(page.getByText('Could not load open quotes. Fixture quote roster unavailable.',{exact:true})).toBeVisible(); await expect(page.getByRole('combobox',{name:'Open quote',exact:true})).toHaveValue('Q1');
  await page.evaluate(()=>{window.__quoteSignoff.setQuoteRoster('available');window.__quoteSignoff.update();}); await expect(page.getByText('Could not load open quotes. Fixture quote roster unavailable.',{exact:true})).toBeHidden();
  await expect(page.getByRole('combobox',{name:'Open quote',exact:true})).toHaveValue('Q1'); await expect(page.getByLabel('Complete scope shown to the customer',{exact:true})).toHaveValue('Three drawings and final PDF delivery.');
});
test('keeps a selected quote outside a truncated roster, then clears it only after a complete read',async ({page}) => {
  await page.goto(BASE); await fill(page); await page.evaluate(()=>{window.__quoteSignoff.setQuoteRoster('truncated');window.__quoteSignoff.update();});
  await expect(page.getByText('Only the first 100 open quotes are shown. Your selection is kept; preparing will check it again.',{exact:true})).toBeVisible();
  await expect(page.getByRole('combobox',{name:'Open quote',exact:true})).toHaveValue('Q1');
  await page.evaluate(()=>{window.__quoteSignoff.setQuoteRoster('missing');window.__quoteSignoff.update();});
  await expect(page.getByText('Your selected quote is no longer in the open quote list. Choose an open quote to prepare a request.',{exact:true})).toBeVisible(); await expect(page.getByRole('combobox',{name:'Open quote',exact:true})).toHaveValue('');
});
test('recovers an initial quote-list outage without claiming the required packs are missing',async ({page}) => {
  await page.goto(BASE+'?quotes_error'); await expect(page.getByText(/Could not load open quotes/)).toBeVisible();
  await expect(page.getByText(/Install Quote Pipeline and Invoice Book/)).toBeHidden();
  await page.evaluate(()=>window.__quoteSignoff.setQuoteRoster('available')); await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await page.getByRole('combobox',{name:'Open quote',exact:true}).selectOption('Q1'); await expect(page.getByRole('combobox',{name:'Open quote',exact:true})).toHaveValue('Q1');
});

test('focuses the customer error summary above long terms and links directly to retained fields',async ({page},info) => {
  await page.setViewportSize({width:390,height:844}); const endpoint='round3-customer'; const posts:URLSearchParams[]=[];
  const input={completion:true,display_name:'Morgan Design Studio',action_kind:'approve_wording' as const,prompt:'Please confirm the delivered work or describe corrections.',context_summary:Array.from({length:42},(_,i)=>`${i+1}. Deliver drawings with dimensions, labels, notes, exclusions and final PDFs. One round of corrections is included.\n`).join('').padEnd(6500,' Agreed scope.').slice(0,6500),visitor_field_constraints:{name:'optional' as const,email:'optional' as const},expiry_display:'Expires in 7 days',submit_button_label:'Submit',endpoint_id:endpoint,bearer_secret:'fixture-token',form_nonce:'first-nonce'};
  await page.route(HARNESS_ORIGIN+'/reception/_static/*',async route=>{const asset=lookupReceptionStaticAsset(new URL(route.request().url()).pathname);await route.fulfill(asset?{contentType:asset.content_type,body:asset.bytes}:{status:404});});
  await page.route(HARNESS_ORIGIN+'/reception/approve/'+endpoint+'*',async route=>{
    if(route.request().method()==='GET'){await route.fulfill({contentType:'text/html',body:renderApprovalLinkHtml(input)});return;}
    const data=new URLSearchParams(route.request().postData()??'');posts.push(data);
    await route.fulfill(data.get('visitor_email')==='invalid'?{status:400,contentType:'text/html',body:renderApprovalLinkHtml({...input,form_nonce:'fresh-nonce',error_message:'Enter a valid email address, or leave it blank if optional.',submitted:Object.fromEntries(data)})}:{contentType:'text/html',body:'<!doctype html><h1>Response received</h1>'});
  });
  await page.goto(`${HARNESS_ORIGIN}/reception/approve/${endpoint}?t=fixture-token`); await page.getByLabel('Your name',{exact:false}).fill('Morgan <script>alert(1)</script>'); await page.getByLabel('Your email',{exact:false}).fill('invalid');
  await page.getByRole('button',{name:'Accept completion',exact:true}).click(); const summary=page.getByRole('alert');
  await expect(summary).toBeFocused(); await expect(summary).toBeInViewport(); await expect(summary).toContainText('Enter a valid email address');
  await expect(page.locator('script')).toHaveCount(0); await page.screenshot({path:info.outputPath('customer-validation-summary.png')});
  await summary.getByRole('link',{name:'Fix your response',exact:true}).click(); await expect(page.getByLabel('Your email',{exact:false})).toBeInViewport();
  await expect(page.getByLabel('Your name',{exact:false})).toHaveValue('Morgan <script>alert(1)</script>'); await page.getByLabel('Your email',{exact:false}).fill('morgan@example.test');
  await page.getByRole('button',{name:'Accept completion',exact:true}).click(); await expect(page.getByRole('heading',{name:'Response received',exact:true})).toBeVisible();
  expect(posts).toHaveLength(2); expect(posts[1]!.get('form_nonce')).toBe('fresh-nonce');
});
test('keeps long corrections compact, exposes the full reply, and preserves each disclosure through polling',async ({page},info) => {
  await page.setViewportSize({width:390,height:844}); await page.clock.install(); await publish(page,'completion');
  const reply=Array.from({length:60},(_,i)=>`${i+1}. Correct the dimensions, weights, labels and scale before we accept the final drawings. <img src=x onerror=alert(1)>`).join('\n').slice(0,APPROVAL_LINK_VISITOR_COMMENT_MAX);
  await page.evaluate(reply=>window.__quoteSignoff.completionResponse('corrections_requested',reply),reply);
  const history=page.locator('[data-completion-history] article'); await expect(history.getByRole('link',{name:'Review completion in Reception Inbox',exact:true})).toBeVisible(); await history.scrollIntoViewIfNeeded();
  const offset=await history.evaluate(node=>node.querySelector('a')!.getBoundingClientRect().top-node.getBoundingClientRect().top); expect(offset).toBeLessThan(300);
  const teaser=history.locator('[data-completion-correction-summary]'); expect((await teaser.innerText()).length).toBeLessThanOrEqual(201);
  const full=history.locator('[data-completion-disclosure=corrections]'); await expect(full.locator('pre')).toBeHidden();
  await expect(history.locator('img')).toHaveCount(0); await page.screenshot({path:info.outputPath('completion-corrections-compact.png')});
  const summary=full.locator('summary'); await summary.click(); await expect(full.locator('pre')).toHaveText(reply); await summary.focus(); await page.clock.fastForward(20_100);
  await expect(full).toHaveAttribute('open',''); await expect(summary).toBeFocused(); await expect(history.locator('[data-completion-disclosure=terms]')).not.toHaveAttribute('open','');
  await summary.click(); const terms=history.locator('[data-completion-disclosure=terms]'); await terms.locator('summary').click(); await page.clock.fastForward(20_100);
  await expect(terms).toHaveAttribute('open',''); await expect(full).not.toHaveAttribute('open','');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
});
