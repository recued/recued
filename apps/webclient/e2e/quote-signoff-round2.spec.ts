import { expect, test, type Page } from '@playwright/test';
import { renderApprovalLinkHtml, renderApprovalLinkErrorHtml } from '../../../backend/server/src/ports/reception/handlers/approval-link-render.js';
import { lookupReceptionStaticAsset } from '../../../backend/server/src/ports/reception/static-assets.js';
import { installCustomerWorkFixture } from './fixtures/customer-work.js';
import { HARNESS_ORIGIN } from './helpers/harness-origin.js';
import { openSignoffRequestDetails } from './helpers/signoff-request.js';
import type {} from './harness/quote-signoff-harness.js';
const BASE = `${HARNESS_ORIGIN}/quote-signoff-harness.html`;
const APP = `${HARNESS_ORIGIN}/full-app-harness.html`;
const errors = new WeakMap<Page,string[]>();
test.beforeEach(async ({page}) => {
  const failures: string[] = []; errors.set(page,failures); page.on('pageerror',error => failures.push(error.message));
  await page.addInitScript({content:`(${installCustomerWorkFixture.toString()})();
    setInterval(()=>window.__app?.fireMessage({type:'server_heartbeat',payload:{server_id:'fixture-server',last_seen_at:Date.now(),lifecycle_state:'running',uptime_s:120,supervisor_mode:'systemd'}}),1000);
    const previousRound2Fixture = window.__receptionFixture;
    window.__receptionFixture=async(method,raw)=>{
      const args=raw??{};
      if(method==='reception.signoff.quotes') return {result:{quotes:[{id:'Q1',label:'Drawings',customer:'Morgan Studio',amount:'120.0000',currency:'GBP',revision:3}],truncated:false}};
      if(method==='reception.jobs.closeout.get'&&String(args.job_id).startsWith('offer-')){
        const reply=await previousRound2Fixture(method,{...args,job_id:String(args.job_id).replace('offer-','job-')});
        if(reply?.result?.job){reply.result.job_id=args.job_id;reply.result.job.job_id=args.job_id;reply.result.archive.job_id=args.job_id;} return reply;
      }
      const reply=await previousRound2Fixture(method,args);
      if(method==='reception.signoff.list'&&reply?.result?.signoffs){
        const rows=reply.result.signoffs.filter(row=>(!args.search||(row.customer+' '+row.quote_label+' '+row.invoice_ref).toLowerCase().includes(args.search.toLowerCase()))&&(!args.state||row.state===args.state));
        const offset=Number(args.cursor??0),limit=args.limit??50;
        reply.result={signoffs:rows.slice(offset,offset+limit),truncated:offset+limit<rows.length,...(offset+limit<rows.length?{next_cursor:String(offset+limit)}:{})};
      }return reply;
    };`});
});
test.afterEach(async ({page}) => { expect(errors.get(page)).toEqual([]); });
const fill = async (page: Page) => {
  const creation = page.locator('[data-signoff-create]');
  if (!await creation.evaluate(node => (node as HTMLDetailsElement).open)) await creation.locator('summary').click();
  await page.getByLabel('Open quote').selectOption('Q1');
  await page.getByLabel('Business name shown to the customer').fill('Studio');
  await page.getByLabel('Complete scope shown to the customer').fill('Three drawings and a final PDF.');
  await page.getByLabel('Task to create after your approval').fill('Deliver drawings');
  await page.getByLabel('Invoice reference',{exact:true}).fill('INV-NEW');
};
const publishedSignoff = async (page: Page) => {
  await page.goto(BASE); await fill(page);
  await page.getByRole('button',{name:'Prepare sign-off preview',exact:true}).click();
  await page.getByRole('button',{name:'Publish sign-off link',exact:true}).click();
  await expect(page.getByLabel('Customer sign-off link',{exact:true})).not.toHaveValue('');
};
const openCompletion = async (page: Page, text = 'Delivered the saved drawings.') => {
  await openSignoffRequestDetails(page.locator('[data-signoff-history] article').first());
  await page.getByRole('button',{name:'Request completion',exact:true}).click();
  await page.getByLabel('Delivered work shown to the customer').fill(text);
};
const publishedCompletion = async (page: Page) => {
  await page.goto(BASE+'?completion'); await openCompletion(page);
  await page.getByRole('button',{name:'Prepare completion preview',exact:true}).click();
  await page.getByRole('button',{name:'Publish completion link',exact:true}).click();
  await expect(page.getByLabel('Customer completion link',{exact:true})).not.toHaveValue('');
};

test('holds the share field during preparation and recovers an active link after a failed sign-off preview',async ({page}) => {
  await publishedSignoff(page); const link=page.getByLabel('Customer sign-off link',{exact:true}); const url=await link.inputValue();
  await page.getByLabel('Complete scope shown to the customer').fill('Proposed replacement drawings.');
  await page.evaluate(()=>{window.__quoteSignoff.prepareFailure('before');window.__quoteSignoff.deferNext('reception.signoff.prepare');});
  await page.getByRole('button',{name:'Prepare sign-off preview',exact:true}).click();
  await expect(page.getByRole('button',{name:'Copy link',exact:true})).toBeDisabled(); await expect(link).toHaveValue('');
  await page.evaluate(()=>window.__quoteSignoff.release());
  await expect(page.getByText('Fixture preview unavailable. Try again.',{exact:true})).toBeVisible();
  await expect(link).toHaveValue(url); await expect(page.getByRole('button',{name:'Copy link',exact:true})).toBeEnabled();
});
test('keeps an actually replaced link inactive when failure follows saving a replacement',async ({page}) => {
  await publishedSignoff(page); await page.getByLabel('Complete scope shown to the customer').fill('Replacement scope.');
  await page.evaluate(()=>window.__quoteSignoff.prepareFailure('after'));
  await page.getByRole('button',{name:'Prepare sign-off preview',exact:true}).click();
  await expect(page.getByText('Link replaced, closed, expired or rotated. Do not share it.',{exact:true})).toBeVisible();
  await expect(page.getByLabel('Customer sign-off link',{exact:true})).toHaveValue('');
  await expect(page.getByRole('button',{name:'Copy link',exact:true})).toBeDisabled();
});
test('leaves an uncertain link disabled until a successful explicit availability check',async ({page}) => {
  await publishedSignoff(page); const url=await page.getByLabel('Customer sign-off link',{exact:true}).inputValue();
  await page.getByLabel('Complete scope shown to the customer').fill('Replacement scope.');
  await page.evaluate(()=>{window.__quoteSignoff.prepareFailure('before');window.__quoteSignoff.linkStatus('unavailable');});
  await page.getByRole('button',{name:'Prepare sign-off preview',exact:true}).click();
  await expect(page.getByText('Could not confirm this link’s availability. Check again before sharing.',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Copy link',exact:true})).toBeDisabled();
  await page.evaluate(()=>window.__quoteSignoff.linkStatus('current'));
  await page.getByRole('button',{name:'Check link availability',exact:true}).click();
  await expect(page.getByLabel('Customer sign-off link',{exact:true})).toHaveValue(url);
});
for (const mode of ['before','after'] as const) test(`rechecks a completion link after prepare fails ${mode} saving`,async ({page}) => {
  await publishedCompletion(page); const link=page.getByLabel('Customer completion link',{exact:true}); const url=await link.inputValue();
  await openCompletion(page,'Proposed completion revision.'); await page.evaluate(mode=>window.__quoteSignoff.prepareFailure(mode),mode);
  await page.getByRole('button',{name:'Prepare completion preview',exact:true}).click();
  await expect(page.getByText('Fixture preview unavailable. Try again.',{exact:true})).toBeVisible();
  await expect(link).toHaveValue(mode==='before'?url:'');
  if(mode==='before') await expect(page.getByRole('button',{name:'Copy link',exact:true})).toBeEnabled();
  else await expect(page.getByRole('button',{name:'Copy link',exact:true})).toBeDisabled();
});
test('warns about completion replacement before the prepare action and reports its timing accurately',async ({page}) => {
  await page.goto(BASE+'?completion'); await openCompletion(page);
  await expect(page.locator('[data-completion-replacement-notice]')).toContainText('immediately replaces earlier pending completion requests');
  expect(await page.evaluate(()=>window.__quoteSignoff.calls.some(call=>call.method==='reception.signoff.completion.prepare'))).toBe(false);
  await page.getByRole('button',{name:'Prepare completion preview',exact:true}).click();
  await expect(page.getByText('Completion preview prepared. Earlier pending completion requests have been replaced.',{exact:false})).toBeVisible();
  expect(await page.evaluate(()=>window.__quoteSignoff.calls.some(call=>call.method==='reception.signoff.completion.publish'))).toBe(false);
});
test('keeps a closed completion draft, returns focus, resumes it, and discards only explicitly',async ({page}) => {
  await page.goto(BASE+'?completion'); await openCompletion(page,'Keep these delivered terms.');
  await page.getByLabel('Completion link life (days)').fill('12');
  await page.getByRole('button',{name:'Close completion editor',exact:true}).click();
  await expect(page.getByRole('button',{name:'Request completion',exact:true})).toBeFocused();
  await expect(page.getByRole('button',{name:'Resume completion draft',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Resume completion draft',exact:true}).click();
  await expect(page.getByLabel('Delivered work shown to the customer')).toHaveValue('Keep these delivered terms.');
  await expect(page.getByLabel('Completion link life (days)')).toHaveValue('12');
  await page.getByRole('button',{name:'Discard completion draft',exact:true}).click();
  await page.getByRole('button',{name:'Request completion',exact:true}).click();
  await expect(page.getByLabel('Delivered work shown to the customer')).toHaveValue('');
  await expect(page.getByLabel('Completion link life (days)')).toHaveValue('7');
});
test('keeps completion terms and focus through polling and restores the manual refresh control',async ({page}) => {
  await page.clock.install(); await publishedCompletion(page);
  const history=page.locator('[data-completion-history]'); const summary=history.getByText('Completion offered to the customer',{exact:true});
  await summary.click(); await summary.focus();
  const count=await page.evaluate(()=>window.__quoteSignoff.calls.filter(call=>call.method==='reception.signoff.completion.list').length);
  await page.clock.fastForward(20_100);
  await expect.poll(()=>page.evaluate(()=>window.__quoteSignoff.calls.filter(call=>call.method==='reception.signoff.completion.list').length)).toBeGreaterThan(count);
  await expect(history.locator('details')).toHaveAttribute('open',''); await expect(summary).toBeFocused();
  await page.getByRole('button',{name:'Refresh completions',exact:true}).click();
  await expect(page.getByRole('button',{name:'Refresh completions',exact:true})).toBeFocused(); await expect(history.locator('details')).toHaveAttribute('open','');
});
test('protects hidden completion drafts when leaving the workspace',async ({page}) => {
  await page.goto(APP+'?jobs=6#reception/signoffs'); await openCompletion(page,'Unsaved delivery kept after close.');
  await page.getByRole('button',{name:'Close completion editor',exact:true}).click();
  const dialog=page.waitForEvent('dialog'); const click=page.getByRole('link',{name:'Jobs',exact:true}).click();
  await (await dialog).dismiss(); await click;
  await page.getByRole('button',{name:'Resume completion draft',exact:true}).click();
  await expect(page.getByLabel('Delivered work shown to the customer')).toHaveValue('Unsaved delivery kept after close.');
});
test('restores request search, status, page, disclosures, focus and scroll after opening a job and going Back',async ({page}) => {
  await page.goto(APP+'?jobs=72#reception/signoffs');
  await page.getByLabel('Find customer, quote or invoice').fill('Drawings');
  await page.getByRole('button',{name:'Search',exact:true}).click(); await page.getByLabel('Request status').selectOption('released');
  await page.getByRole('button',{name:'Older requests',exact:true}).click(); await expect(page.getByText(/^Page 2 ·/)).toBeVisible();
  const card=page.locator('[data-signoff-history] article').first(); const id=await card.getAttribute('data-signoff-id');
  await openSignoffRequestDetails(card); await card.getByText('Offered scope',{exact:true}).click();
  const open=card.getByRole('link',{name:'Open job',exact:true}); await open.scrollIntoViewIfNeeded();
  const pane=page.locator('[data-recued-webclient-content]'); const scroll=await pane.evaluate(node=>node.scrollTop);
  const count=await page.locator('[data-signoff-history] article').count();
  await open.click(); await expect(page.locator('[data-job-detail]')).toBeVisible(); await page.goBack();
  await expect(page.getByLabel('Find customer, quote or invoice')).toHaveValue('Drawings'); await expect(page.getByLabel('Request status')).toHaveValue('released');
  await expect(page.getByText(/^Page 2 ·/)).toBeVisible(); await expect(page.locator('[data-signoff-history] article')).toHaveCount(count);
  const returned=page.locator(`[data-signoff-id="${id}"]`);
  await expect(returned.locator('[data-signoff-disclosure=actions]')).toHaveAttribute('open',''); await expect(returned.locator('[data-signoff-disclosure=scope]')).toHaveAttribute('open','');
  await expect(returned.getByRole('link',{name:'Open job',exact:true})).toBeFocused();
  await expect.poll(async()=>Math.abs(await pane.evaluate(node=>node.scrollTop)-scroll)).toBeLessThan(24);
  const saved=await page.evaluate(()=>JSON.stringify(history.state.recuedCustomerRequests));
  expect(saved).not.toContain('share_url'); expect(saved).not.toContain('delivery_summary'); expect(saved).not.toContain('fixture-token');
});
test('keeps the last successful board state when a new search fails before leaving and returning',async ({page}) => {
  await page.goto(APP+'?jobs=72#reception/signoffs');
  await page.getByLabel('Find customer, quote or invoice').fill('Drawings');
  await page.getByRole('button',{name:'Search',exact:true}).click(); await page.getByLabel('Request status').selectOption('released');
  await page.getByRole('button',{name:'Older requests',exact:true}).click(); await expect(page.getByText(/^Page 2 ·/)).toBeVisible();
  await page.evaluate(() => {
    const fixtureWindow = window as unknown as {
      __receptionFixture: (method: string, args?: Record<string, unknown>) => Promise<unknown>;
    };
    const previous = fixtureWindow.__receptionFixture;
    fixtureWindow.__receptionFixture = async (method,args) => method === 'reception.signoff.list' && args?.search === 'Unavailable search'
      ? {error:{code:'fixture_unavailable',message:'Request board unavailable'}} : previous(method,args);
  });
  await page.getByLabel('Find customer, quote or invoice').fill('Unavailable search'); await page.getByRole('button',{name:'Search',exact:true}).click();
  await expect(page.getByText(/Could not load requests/)).toBeVisible();
  await page.getByRole('link',{name:'Jobs',exact:true}).click(); await expect(page.locator('[data-jobs-board]')).toBeVisible(); await page.goBack();
  await expect(page.getByLabel('Find customer, quote or invoice')).toHaveValue('Drawings'); await expect(page.getByLabel('Request status')).toHaveValue('released');
  await expect(page.getByText(/^Page 2 ·/)).toBeVisible();
});
test('resumes and publishes the same saved quote draft with a fresh server preview after remounting',async ({page}) => {
  await page.goto(BASE); await fill(page); await page.getByRole('button',{name:'Prepare sign-off preview',exact:true}).click();
  const prepared=await page.evaluate(()=>window.__quoteSignoff.calls.filter(call=>call.method==='reception.signoff.prepare').length);
  await page.evaluate(()=>window.__quoteSignoff.remount());
  await page.getByRole('button',{name:'Resume preview',exact:true}).click();
  await expect(page.getByLabel('Complete scope shown to the customer')).toHaveValue('Three drawings and a final PDF.');
  await expect(page.locator('[data-signoff-preview]')).toContainText('Saved preview for Morgan');
  await page.getByRole('button',{name:'Publish sign-off link',exact:true}).click();
  const calls=await page.evaluate(()=>window.__quoteSignoff.calls);
  expect(calls.filter(call=>call.method==='reception.signoff.prepare')).toHaveLength(prepared);
  expect(calls.find(call=>call.method==='reception.signoff.publish')?.payload).toMatchObject({signoff_id:'a1fecd4e-42ce-42a2-b7e7-731ce51a01b2',preview_hash:'e'.repeat(64)});
});
test('resumes saved added work from its server parent without preparing again',async ({page}) => {
  await page.goto(BASE+'?completion'); const card=page.locator('[data-signoff-history] article').first(); await openSignoffRequestDetails(card);
  await card.getByRole('button',{name:'Add work',exact:true}).click();
  await page.getByLabel('Business name shown to the customer').fill('Studio'); await page.getByLabel('Added scope shown to the customer',{exact:true}).fill('An extra drawing.');
  await page.getByLabel('Added amount including VAT').fill('30'); await page.getByLabel('Invoice reference',{exact:true}).fill('INV-ADD');
  await page.getByRole('button',{name:'Prepare added-work preview',exact:true}).click(); await page.evaluate(()=>window.__quoteSignoff.remount());
  await page.getByRole('button',{name:'Resume preview',exact:true}).click(); await expect(page.getByLabel('Added scope shown to the customer',{exact:true})).toHaveValue('An extra drawing.');
  await expect(page.getByLabel('Added amount including VAT')).toHaveValue('30'); await page.getByRole('button',{name:'Publish sign-off link',exact:true}).click();
  expect(await page.evaluate(()=>window.__quoteSignoff.calls.filter(call=>call.method==='reception.signoff.prepare_addition').length)).toBe(1);
});
test('resumes saved completion after local fields are discarded and publishes its saved id',async ({page}) => {
  await page.goto(BASE+'?completion'); await openCompletion(page,'Delivery saved on the server.');
  await page.getByRole('button',{name:'Prepare completion preview',exact:true}).click(); await page.getByRole('button',{name:'Discard completion draft',exact:true}).click();
  await page.getByRole('button',{name:'Resume completion preview',exact:true}).click(); await expect(page.getByLabel('Delivered work shown to the customer')).toHaveValue('Delivery saved on the server.');
  await page.getByRole('button',{name:'Publish completion link',exact:true}).click();
  const calls=await page.evaluate(()=>window.__quoteSignoff.calls);
  expect(calls.filter(call=>call.method==='reception.signoff.completion.prepare')).toHaveLength(1);
  expect(calls.find(call=>call.method==='reception.signoff.completion.publish')?.payload).toMatchObject({completion_id:'b1fecd4e-42ce-42a2-b7e7-731ce51a01b2',preview_hash:'f'.repeat(64)});
});

test('lets a customer correct an invalid optional email in place with a fresh form nonce',async ({page}) => {
  const posts:URLSearchParams[]=[]; const endpoint='browser-recovery';
  const input={completion:true,display_name:'Studio',action_kind:'approve_wording' as const,prompt:'Review delivery.',context_summary:'Delivered drawings.',visitor_field_constraints:{name:'optional' as const,email:'optional' as const},expiry_display:'Expires in seven days',submit_button_label:'Submit',endpoint_id:endpoint,bearer_secret:'fixture-token',form_nonce:'first-nonce'};
  await page.route(HARNESS_ORIGIN+'/reception/_static/*',async route=>{const asset=lookupReceptionStaticAsset(new URL(route.request().url()).pathname);await route.fulfill(asset?{contentType:asset.content_type,body:asset.bytes}:{status:404});});
  await page.route(HARNESS_ORIGIN+'/reception/approve/'+endpoint+'*',async route=>{
    if(route.request().method()==='GET'){await route.fulfill({contentType:'text/html',body:renderApprovalLinkHtml(input)});return;}
    const data=new URLSearchParams(route.request().postData()??'');posts.push(data);
    await route.fulfill(data.get('visitor_email')==='invalid'?{status:400,contentType:'text/html',body:renderApprovalLinkHtml({...input,form_nonce:'fresh-nonce',error_message:'Enter a valid email address, or leave it blank if optional.',submitted:Object.fromEntries(data)})}:{contentType:'text/html',body:'<!doctype html><h1>Response received</h1>'});
  });
  await page.goto(`${HARNESS_ORIGIN}/reception/approve/${endpoint}?t=fixture-token`);
  await page.getByLabel('Your name',{exact:false}).fill('Morgan <img src=x onerror=alert(1)>'); await page.getByLabel('Your email',{exact:false}).fill('invalid');
  await page.getByLabel('Corrections (required when requesting changes)').fill('Keep these comments.'); await page.getByRole('button',{name:'Accept completion',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Enter a valid email address'); await expect(page.getByLabel('Your name',{exact:false})).toHaveValue('Morgan <img src=x onerror=alert(1)>');
  await expect(page.locator('form img')).toHaveCount(0); await expect(page.getByLabel('Corrections (required when requesting changes)')).toHaveValue('Keep these comments.');
  await page.getByLabel('Your email',{exact:false}).fill('morgan@example.test'); await page.getByRole('button',{name:'Accept completion',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Response received',exact:true})).toBeVisible(); expect(posts).toHaveLength(2);expect(posts[1]!.get('form_nonce')).toBe('fresh-nonce');
});
test('uses a GET review link to recover from a stale POST without resubmitting it',async ({page}) => {
  let gets=0,posts=0; const path='/reception/approve/browser-stale?t=fixture-token';
  await page.route(HARNESS_ORIGIN+'/reception/approve/browser-stale*',async route=>{
    if(route.request().method()==='POST'){posts++;await route.fulfill({status:400,contentType:'text/html',body:renderApprovalLinkErrorHtml({display_name:'Studio',message:'This response form is stale. Review the request again before sending a response.',recovery_url:path})});}
    else {gets++;await route.fulfill({contentType:'text/html',body:renderApprovalLinkHtml({completion:true,display_name:'Studio',action_kind:'approve_wording',prompt:'Review delivery.',context_summary:'Delivered drawings.',visitor_field_constraints:{name:'optional',email:'optional'},expiry_display:'Expires in seven days',submit_button_label:'Submit',endpoint_id:'browser-stale',bearer_secret:'fixture-token',form_nonce:`nonce-${gets}`})});}
  });
  await page.goto(HARNESS_ORIGIN+path);await page.getByRole('button',{name:'Accept completion',exact:true}).click();
  await page.getByRole('link',{name:'Review request again',exact:true}).click();await expect(page.getByRole('button',{name:'Accept completion',exact:true})).toBeVisible();
  expect(posts).toBe(1);expect(gets).toBe(2);await expect(page.locator('input[name=form_nonce]')).toHaveValue('nonce-2');
});
