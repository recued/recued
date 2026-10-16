import { setCustomerReviewLink } from './customer-review-link.js';
import { CUSTOMER_REFUND_RECIPE,composeDialog,customerRefundBalanceLines,customerRefundDocumentLines,customerRefundDocumentTitle,
  type Conn,type ServerRpcRegistry,type CustomerPaymentHistory,type CustomerRefundPreview,type CustomerRefundPrepareInput,type CustomerRefundDocument,type CustomerRefundAction } from '@recued/contracts';
import { FORM_RENDERER_STYLES,MAIL_COMPOSE_STYLES } from '@recued/ui-shared';
import { mountCustomerRefundCorrections } from './customer-refund-corrections.js';
import type { QuoteSignoffPaymentOptions } from './quote-signoff-payment.js';
import { mountMailCompose,type MailComposeDeps } from '../mail/mail-compose-host.js';
import { downloadReceiptHtml } from './quote-signoff-receipt.js';
export type CustomerRefundsConn=Conn<Pick<ServerRpcRegistry,'reception.signoff.refund.prepare'|'reception.signoff.refund.history'|'reception.signoff.refund.copy'|'reception.signoff.refund.receipt.draft'|'reception.signoff.refund.correction.prepare'|'reception.signoff.refund.correction.history'>>;
const escape=(text: string)=>text.replace(/[&<>"']/g,c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]!);
export const customerRefundDocumentHtml=(copy: CustomerRefundDocument): string=>`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${escape(customerRefundDocumentTitle(copy))}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:850px;margin:32px auto;padding:0 24px;color:#17212b;background:white}p{white-space:pre-wrap;overflow-wrap:anywhere}@media print{body{margin:0;padding:0}}</style></head>
<body><h1>${escape(customerRefundDocumentTitle(copy))}</h1>${customerRefundDocumentLines(copy).map(line=>`<p>${escape(line)}</p>`).join('\n')}</body></html>`;
/** Persistent editor and copies stay outside rows replaced by payment-history refreshes. */
export const mountCustomerRefunds=(opts: { document: Document;host: HTMLElement;conn: CustomerRefundsConn;payment: QuoteSignoffPaymentOptions;mail?: MailComposeDeps;
  canReview: ()=>boolean;onChanged: ()=>void;onStateChanged: ()=>void;returnFocus: ()=>void })=>{
  const doc=opts.document;const root=doc.createElement('section');root.setAttribute('data-customer-refunds','');opts.host.appendChild(root);
  const add=(tag: string,text: string,host: HTMLElement=root)=>{ const node=doc.createElement(tag);node.textContent=text;host.appendChild(node);return node; };
  const button=(text: string,host: HTMLElement,click: ()=>void)=>{ const node=doc.createElement('button');node.type='button';node.textContent=text;host.appendChild(node);node.addEventListener('click',click);return node; };
  add('style','[data-customer-refunds] [hidden]{display:none!important}[data-customer-refunds] form,[data-customer-refunds] label{display:grid;gap:8px}[data-customer-refunds] input,[data-customer-refunds] select,[data-customer-refunds] textarea{box-sizing:border-box;min-width:0;max-width:100%}[data-customer-refunds] p,[data-customer-refunds] pre{white-space:pre-wrap;overflow-wrap:anywhere}');
  add('h3','Customer refunds');const manage=button('Manage refunds and receipts',root,()=>open());
  const region=add('div','');region.hidden=true;const totals=add('div','',region);
  add('p','First issue a credit against a recorded payment. Then record money already returned outside Recued. Each entry needs owner approval.',region);
  const editor=doc.createElement('form');editor.hidden=true;editor.tabIndex=-1;editor.setAttribute('aria-label','Customer refund entry');editor.setAttribute('data-refund-editor','');region.appendChild(editor);
  const select=(label: string,host: HTMLElement)=>{ const node=doc.createElement('select');node.id='recued-refund-'+crypto.randomUUID();const text=add('label',label,host);text.setAttribute('for',node.id);host.appendChild(node);return node; };
  const option=(select: HTMLSelectElement,value: string,label: string)=>{ const node=doc.createElement('option');node.value=value;node.textContent=label;select.appendChild(node); };
  const kind=select('Refund entry type',editor);option(kind,'credit','Issue a paid invoice credit');option(kind,'refund','Record a completed refund');
  const paymentHost=add('div','',editor);const payment=select('Original payment (this history page)',paymentHost);payment.required=true;
  const creditHost=add('div','',editor);const credit=select('Paid invoice credit to refund',creditHost);credit.required=true;
  const input=(label: string,type: string,name: string,host: HTMLElement=editor,required=true,max=512)=>{ const text=add('label',label,host);const node=doc.createElement('input');node.type=type;node.name=name;node.required=required;node.maxLength=max;text.appendChild(node);return node; };
  const amount=input('Refund or paid credit amount','text','refund_amount',editor,true,24);amount.inputMode='decimal';const date=input('Entry date','date','refund_date');
  const reasonLabel=add('label','Reason (shown on customer copies)',editor);const reason=doc.createElement('textarea');reason.required=true;reason.maxLength=1000;reason.name='refund_reason';reasonLabel.appendChild(reason);
  const refundFields=add('div','',editor);const method=input('Refund method','text','refund_method',refundFields,false);const reference=input('Refund reference','text','refund_reference',refundFields,false);
  const prepare=doc.createElement('button');prepare.type='submit';prepare.textContent='Preview refund entry';editor.appendChild(prepare);
  const closeEditor=button('Close refund entry',editor,()=>reset());const previewHost=add('div','',editor);previewHost.setAttribute('data-refund-preview','');
  const review=button('Review refund entry',editor,()=>{ void submit(); });review.hidden=true;const runs=add('a','Review refund entry in Runs',editor);runs.hidden=true;
  const status=add('p','',region);status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  add('h4','Paid credit and refund history',region);const rows=add('div','',region);rows.setAttribute('data-refund-history','');const historyStatus=add('p','',region);historyStatus.setAttribute('role','status');
  const refresh=button('Refresh refund history',region,()=>{ void loadHistory(cursor,[...previous]); });
  const newer=button('Newer refund entries',region,()=>{ if (previous.length) void loadHistory(previous.at(-1),previous.slice(0,-1)); });
  const older=button('Older refund entries',region,()=>{ if (nextCursor) void loadHistory(nextCursor,[...previous,cursor]); });
  const copyHost=add('section','',region);copyHost.hidden=true;copyHost.setAttribute('data-refund-copy','');const copyHeading=add('h4','Customer refund receipt',copyHost);const copyLines=add('div','',copyHost);
  const print=button('Print refund document / save PDF',copyHost,()=>printCopy());const download=button('Download refund document',copyHost,()=>{
    if (copy && !disposed) try { downloadReceiptHtml(doc,root,`${copy.kind==='refund' ? 'refund-receipt' : 'paid-invoice-credit'}-${copy.document_hash.slice(0,16)}.html`,customerRefundDocumentHtml(copy)); } catch { status.textContent='The copy could not be downloaded. Try Print instead.'; }
  });
  const emailForm=doc.createElement('form');emailForm.hidden=true;emailForm.setAttribute('aria-label','Prepare refund receipt email');copyHost.appendChild(emailForm);
  const email=input('Refund receipt customer email','email','refund_receipt_recipient',emailForm,true,254);const account=select('Refund receipt mail account',emailForm);account.required=true;
  const emailReview=doc.createElement('button');emailReview.type='submit';emailReview.textContent='Review refund receipt email';emailForm.appendChild(emailReview);
  button('Close refund document',copyHost,()=>{
    if (busy || compose?.hasInFlightWork()) return;
    if (hasEmail()) { status.textContent='Close the email you have open before closing this refund document.';return; }
    generation++;mailDirty=false;copy=null;copyStale=false;copyHost.hidden=true;clearPrint();controls();opts.onStateChanged();manage.focus();
  });
  const composeHost=add('div','',region);let compose: ReturnType<typeof mountMailCompose>|null=null;let corrections: ReturnType<typeof mountCustomerRefundCorrections>|null=null;
  let disposed=false;let busy=false;let dirty=false;let mailDirty=false;let queued=false;let generation=0;let historyGeneration=0;let loading=false;
  let history: CustomerPaymentHistory|null=null;let frozen: CustomerPaymentHistory|null=null;let prepared: { preview: CustomerRefundPreview;input: CustomerRefundPrepareInput }|null=null;
  let requestKey=crypto.randomUUID();let copy: CustomerRefundDocument|null=null;let copyStale=false;let cursor: string|undefined;let nextCursor: string|undefined;let previous: Array<string|undefined>=[];let rowButtons: HTMLButtonElement[]=[];
  let frame: HTMLIFrameElement|null=null;let timer: ReturnType<typeof setTimeout>|undefined;
  const hasEmail=()=>Boolean(compose && composeDialog(compose.state()));
  const message=(error: unknown)=>error instanceof Error ? error.message : 'The refund entry could not be loaded. Try again.';
  const clearPrint=()=>{ if (timer!==undefined) clearTimeout(timer);timer=undefined;frame?.remove();frame=null; };
  const controls=()=>{
    const locked=busy || queued;[kind,payment,credit,amount,date,reason,method,reference,prepare].forEach(node=>{ node.disabled=locked; });closeEditor.disabled=busy;review.disabled=locked || !prepared;
    paymentHost.hidden=kind.value!=='credit';payment.required=!paymentHost.hidden;creditHost.hidden=refundFields.hidden=kind.value!=='refund';credit.required=!creditHost.hidden;
    manage.disabled=busy || corrections?.isOpen()===true || !editor.hidden || mailDirty || hasEmail() || !history?.snapshot_hash;
    refresh.disabled=newer.disabled=older.disabled=loading || busy;newer.disabled ||= !previous.length;older.disabled ||= !nextCursor;
    rowButtons.forEach(node=>{ node.disabled=busy || corrections?.isOpen()===true || !editor.hidden || mailDirty || hasEmail(); });print.disabled=download.disabled=!copy || busy;print.disabled ||= frame!==null;
    email.disabled=account.disabled=busy || corrections?.isOpen()===true;emailReview.disabled=busy || copyStale || corrections?.isOpen()===true;corrections?.refreshControls();
  };
  const reset=(restoreFocus=true)=>{
    if (disposed || busy) return;generation++;frozen=null;prepared=null;dirty=queued=false;editor.hidden=true;previewHost.replaceChildren();review.hidden=true;runs.hidden=true;controls();opts.onStateChanged();if (restoreFocus) manage.focus();
  };
  const showAction=(a: CustomerRefundAction)=>{
    const card=add('article','',rows);card.setAttribute('data-refund-action',a.action_id);add('h5',a.kind==='credit' ? `Paid invoice credit ${a.credit.credit_ref}` : `Refund ${a.refund?.refund_ref}`,card);
    add('p',a.applied_at===null ? 'Prepared only — no ledger entry applied.' : `Applied ${new Date(a.applied_at).toISOString()}.`,card);
    add('p',a.kind==='credit' ? `${a.credit.amount} ${a.currency} · ${a.credit.issued_on} · ${a.credit.reason}` : `${a.refund?.amount} ${a.currency} · ${a.refund?.returned_on} · ${a.refund?.reason}`,card);
    add('p',`Refund owed: ${a.before.refund_due} → ${a.after.refund_due} ${a.currency}. Recorded net received: ${a.before.net_received} → ${a.after.net_received} ${a.currency}.`,card);
    add('p',`Customer debt when prepared: ${a.outstanding} ${a.currency}. Original recorded payments: ${a.amount_paid} ${a.currency}.`,card);
    add('p',`Original payment: ${a.payment.payment_id}. Prepared by paired client ${a.prepared_by}.`,card);
    if (a.run_id) add('p',`Reviewed run: ${a.run_id}${a.actor ? ` · ${a.actor}` : ''}`,card);
    if (a.applied_at!==null) rowButtons.push(button(a.kind==='refund' ? 'View customer refund receipt' : 'View paid invoice credit',card,()=>{ void readCopy(a.action_id); }));
    else if (a.run_id) { const link=add('a','Check refund review in Runs',card);setCustomerReviewLink(doc,link,a.run_id,'#reception/signoffs/'+encodeURIComponent(a.signoff_id)); }
  };
  const loadHistory=async(requested?: string,trail=[...previous])=>{
    if (disposed || !history || region.hidden) return;const id=history.signoff_id;const current=++historyGeneration;loading=true;controls();
    try { const result=await opts.conn('reception.signoff.refund.history',{ signoff_id: id,limit: 50,...(requested ? { cursor: requested } : {}) });if (disposed || current!==historyGeneration || id!==history?.signoff_id) return;
      if (result.actions.some(a=>a.signoff_id!==id)) throw new Error('Refund history does not match this invoice.');cursor=requested;previous=trail;nextCursor=result.next_cursor;rows.replaceChildren();rowButtons=[];result.actions.forEach(showAction);historyStatus.textContent=result.actions.length ? `Refund history page ${previous.length+1}.` : 'No paid invoice credits or refunds recorded.';
    } catch(error) { if (!disposed && current===historyGeneration) historyStatus.textContent=message(error); }
    finally { if (!disposed && current===historyGeneration) { loading=false;controls(); } }
  };
  const open=()=>{
    if (disposed || busy || corrections?.isOpen() || !editor.hidden || !history?.snapshot_hash || mailDirty || hasEmail() || !opts.canReview()) return;
    frozen=history;prepared=null;queued=dirty=false;generation++;requestKey=crypto.randomUUID();payment.replaceChildren();credit.replaceChildren();
    option(payment,'','Choose a recorded payment');history.payments.forEach(p=>option(payment,p.payment_id,`${p.amount} ${history!.currency} · ${p.received_on} · ${p.reference??p.payment_id}`));
    option(credit,'','Choose a paid invoice credit');for (const c of history.paid_credits??[]) {
      const returned=(history.refunds??[]).filter(r=>r.credit_id===c.credit_id && !r.reversal).reduce((n,r)=>n+BigInt(r.amount.replace('.','')),0n);if (returned<BigInt(c.amount.replace('.',''))) option(credit,c.credit_id,`${c.credit_ref} · ${c.amount} ${history.currency}`);
    }
    kind.value='credit';amount.value=reason.value=method.value=reference.value='';const now=new Date();date.value=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    copy=null;copyStale=false;copyHost.hidden=true;clearPrint();previewHost.replaceChildren();review.hidden=true;runs.hidden=true;editor.hidden=false;region.hidden=false;controls();status.textContent='Preview a paid invoice credit or a refund already completed outside Recued.';editor.focus();opts.onStateChanged();void loadHistory(cursor,[...previous]);
  };
  const printCopy=()=>{
    if (!copy || disposed || frame) return;const node=doc.createElement('iframe');frame=node;node.title='Refund document print view';node.setAttribute('data-refund-document-print','');node.setAttribute('sandbox','allow-same-origin allow-modals');node.style.cssText='position:fixed;width:0;height:0;border:0';controls();
    node.addEventListener('load',()=>{ if (disposed || frame!==node) return;if (timer!==undefined) clearTimeout(timer);timer=undefined;const view=node.contentWindow;if (!view) { clearPrint();controls();return; }
      view.addEventListener('afterprint',()=>{ if (frame===node) { clearPrint();controls();print.focus(); } },{ once:true });try { view.focus();view.print(); } catch { clearPrint();controls();status.textContent='Download the refund document to print it.'; } },{ once:true });
    timer=setTimeout(()=>{ if (frame===node) { clearPrint();controls();status.textContent='The print view could not load. Try again.'; } },10_000);node.srcdoc=customerRefundDocumentHtml(copy);root.appendChild(node);
  };
  const loadAccounts=async(current: number)=>{
    if (!opts.mail?.drafts) return;
    try {
      const accounts=await opts.mail.listMailInstances();if (disposed || current!==generation) return;account.replaceChildren();option(account,'','Choose a mail account');accounts.instances.filter(a=>a.send_capable).forEach(a=>option(account,a.slug,a.account_email||a.slug));email.value='';emailForm.hidden=account.options.length<2;
      status.textContent=emailForm.hidden ? 'Connect a mail account that can send. Print and download are ready.' : 'Review a private refund receipt draft, then choose Send.';
    } catch { if (!disposed && current===generation) status.textContent='Mail accounts could not be loaded. Print and download are ready.'; }
  };
  const readCopy=async(action_id: string)=>{
    if (disposed || busy || corrections?.isOpen() || !history || !editor.hidden || mailDirty || hasEmail() || !opts.canReview()) return;const id=history.signoff_id;const current=++generation;busy=true;copy=null;copyStale=false;clearPrint();copyHost.hidden=true;controls();opts.onStateChanged();
    try { const result=await opts.conn('reception.signoff.refund.copy',{ signoff_id: id,action_id });if (disposed || current!==generation) return;
      if (result.format!=='recued.customer-refund-document' || ![1,2].includes(result.version) || result.signoff_id!==id || result.action_id!==action_id || result.invoice_id!==history?.invoice_id || !/^[a-f0-9]{64}$/.test(result.document_hash) || result.kind==='refund' && !result.refund) throw new Error('This refund copy does not match the selected invoice.');
      copy=result;copyLines.replaceChildren();customerRefundDocumentLines(result).forEach(line=>add('p',line,copyLines));copyHeading.textContent=customerRefundDocumentTitle(result);copyHost.hidden=false;emailForm.hidden=true;mailDirty=false;
      if (result.kind==='refund') void loadAccounts(current);
      status.textContent='Customer copy ready. Amounts reflect the business’s records at capture.';
    } catch(error) { if (!disposed && current===generation) status.textContent=message(error); }
    finally { if (!disposed && current===generation) { busy=false;controls();opts.onStateChanged(); } }
  };
  const submit=async()=>{
    if (disposed || busy || queued || !prepared || !opts.canReview()) return;const target=prepared;const current=++generation;busy=true;controls();opts.onStateChanged();let applied=false;
    try {
      const inventory=await opts.payment.listRecipes();if (disposed || current!==generation) return;
      const matches=inventory.recipes.filter(r=>r.recipe_id===CUSTOMER_REFUND_RECIPE && r.recipe.recipe_id===CUSTOMER_REFUND_RECIPE && r.publisher_id==='recued-core' && r.version>=1 && r.recipe.version===r.version && r.recipe.metadata?.recipe_bundle==='recued-core/reception-approval');
      if (matches.length!==1) throw new Error('Install or update Reception — Approval from Packs before reviewing refunds.');
      const result=await opts.payment.execute({ recipe_id: CUSTOMER_REFUND_RECIPE,config: { ...target.preview.review } });if (disposed || current!==generation) return;
      if (result.awaiting_approval===true) { queued=true;dirty=false;setCustomerReviewLink(doc,runs,result.run_id,'#reception/signoffs/'+encodeURIComponent(target.input.signoff_id));status.textContent='Refund entry is waiting for owner approval. Review the exact credit or recorded refund in Runs.'; }
      else if (result.success===true && result.run_terminated===undefined) {
        const confirmed=await opts.conn('reception.signoff.refund.prepare',target.input);if (disposed || current!==generation) return;
        if (confirmed.action.action_id!==target.preview.action.action_id || confirmed.action.signoff_id!==target.input.signoff_id || confirmed.action.applied_at===null || confirmed.review.expected_plan_hash!==target.preview.review.expected_plan_hash) throw new Error('The run finished, but this refund entry is unconfirmed. Check Runs and refresh payment history.');
        applied=true;dirty=false;status.textContent='Refund entry applied. Refreshing the recorded balances.';
      } else throw new Error('The refund entry was not applied. Check Runs before trying again.');
    } catch(error) { if (!disposed && current===generation) status.textContent=message(error); }
    finally { if (!disposed && current===generation) { busy=false;controls();opts.onStateChanged();if (applied) { reset(false);opts.onChanged();void loadHistory(undefined,[]);opts.returnFocus(); } } }
  };
  const edited=()=>{ if (busy || queued) return;dirty=true;prepared=null;requestKey=crypto.randomUUID();previewHost.replaceChildren();review.hidden=true;controls();opts.onStateChanged(); };
  editor.addEventListener('input',edited);editor.addEventListener('change',edited);
  editor.addEventListener('submit',event=>{
    event.preventDefault();if (disposed || busy || queued || !frozen?.snapshot_hash || !opts.canReview()) return;const target=frozen;const current=++generation;
    const selectedCredit=target.paid_credits?.find(c=>c.credit_id===credit.value);const request: CustomerRefundPrepareInput={ request_key: requestKey,signoff_id: target.signoff_id,expected_snapshot_hash: target.snapshot_hash!,kind: kind.value==='refund' ? 'refund' : 'credit',
      payment_id: kind.value==='refund' ? selectedCredit?.payment_id??'' : payment.value,amount: amount.value,date: date.value,reason: reason.value,
      ...(kind.value==='refund' ? { credit_id: credit.value,...(method.value ? { method: method.value } : {}),...(reference.value ? { reference: reference.value } : {}) } : {}) };
    busy=true;prepared=null;review.hidden=true;previewHost.replaceChildren();status.textContent='Preparing refund entry…';controls();opts.onStateChanged();
    void(async()=>{ let replay=false;
      try { const result=await opts.conn('reception.signoff.refund.prepare',request);if (disposed || current!==generation) return;
        if (result.action.signoff_id!==target.signoff_id || result.action.invoice_id!==target.invoice_id || result.action.kind!==request.kind || result.action.payment.payment_id!==request.payment_id || result.action.action_id!==result.review.action_id || !/^[a-f0-9]{64}$/.test(result.review.expected_plan_hash)) throw new Error('This preview does not match the selected refund entry.');
        prepared={ preview: result,input: request };add('pre',result.review.summary,previewHost);replay=result.action.applied_at!==null;review.hidden=replay;dirty=!replay;status.textContent=replay ? 'This refund entry is already applied. Refreshing balances.' : 'Preview ready. Review it to request owner approval. No money is sent by Recued.';void loadHistory(undefined,[]);
      } catch(error) { if (!disposed && current===generation) status.textContent=message(error); }
      finally { if (!disposed && current===generation) { busy=false;controls();opts.onStateChanged();if (replay) { reset(false);opts.onChanged();opts.returnFocus(); } } }
    })();
  });
  emailForm.addEventListener('input',()=>{ mailDirty=true;controls();opts.onStateChanged(); });emailForm.addEventListener('change',()=>{ mailDirty=true;controls();opts.onStateChanged(); });
  emailForm.addEventListener('submit',event=>{
    event.preventDefault();if (disposed || busy || !copy || copyStale || copy.kind!=='refund' || !compose || !opts.mail?.drafts || hasEmail() || !opts.canReview()) return;
    const target=copy;const current=++generation;busy=true;controls();opts.onStateChanged();
    void(async()=>{ try { const draft=await opts.conn('reception.signoff.refund.receipt.draft',{ signoff_id: target.signoff_id,action_id: target.action_id,expected_document_hash: target.document_hash,sender_mail_instance: account.value,recipient_email: email.value.trim() });if (disposed || current!==generation) return;
      const saved=await opts.mail!.drafts!.create(draft);if (disposed || current!==generation) return;mailDirty=false;await compose!.refresh();if (disposed || current!==generation) return;
      if (!await compose!.openSaved(saved.draft_id)) throw new Error('The refund receipt draft is saved in Mail. Close your current email before opening it.');status.textContent='Refund receipt draft saved. Review it and choose Send using your normal mail approval controls.';
    } catch(error) { if (!disposed && current===generation) status.textContent=message(error); }
    finally { if (!disposed && current===generation) { busy=false;controls();opts.onStateChanged(); } } })();
  });
  if (opts.mail) {
    add('style',`${FORM_RENDERER_STYLES}\n${MAIL_COMPOSE_STYLES}`,composeHost);
    compose=mountMailCompose(composeHost,{ ...opts.mail,onStateChanged:()=>{
      if(disposed)return;opts.mail?.onStateChanged?.();controls();opts.onStateChanged();
    } });
  }
  corrections=mountCustomerRefundCorrections({ document:doc,host:root,conn:opts.conn,payment:opts.payment,
    canReview:()=>editor.hidden && !busy && !mailDirty && !hasEmail() && opts.canReview(),
    onOpen:()=>{generation++;copy=null;copyStale=false;copyHost.hidden=true;clearPrint();},
    onViewCopy:id=>{region.hidden=false;void readCopy(id);},
    onStateChanged:()=>{controls();opts.onStateChanged();},
    onChanged:()=>{copy=null;copyStale=false;copyHost.hidden=true;clearPrint();opts.onChanged();},
  });
  controls();return {showHistory:()=>{if(!disposed && history){region.hidden=false;void loadHistory(cursor,[...previous]);}},
    setInvoice(value: CustomerPaymentHistory) {
      const changed=history?.snapshot_hash!==value.snapshot_hash || history?.signoff_id!==value.signoff_id;
      if (history && history.signoff_id!==value.signoff_id) { busy=false;reset(false);historyGeneration++;cursor=nextCursor=undefined;previous=[];rows.replaceChildren();region.hidden=true;mailDirty=false; }
      if (changed) {
        clearPrint();
        if (copy && mailDirty) {
          copyStale=true;status.textContent='The invoice or refund changed. Your email details are kept. Close this copy and open a fresh receipt before preparing email.';
        } else { copy=null;copyStale=false;copyHost.hidden=true; }
        if (editor.hidden) { generation++;busy=false; }
      }
      history=value;corrections?.setInvoice(value);totals.replaceChildren();if (value.invoice.availability==='current') customerRefundBalanceLines(value.invoice,value.currency).forEach(line=>add('p',line,totals));controls();if (!region.hidden) void loadHistory(cursor,[...previous]);
    },
    reset: ()=>{ if (!busy && !corrections?.hasInFlightWork() && !hasEmail()) { corrections?.reset();reset(false);region.hidden=true;mailDirty=false;copy=null;copyStale=false;copyHost.hidden=true;clearPrint(); } },
    isOpen: ()=>corrections?.isOpen()===true || !editor.hidden || mailDirty || hasEmail(),hasOpenEmail: hasEmail,hasUnsavedChanges: ()=>corrections?.hasUnsavedChanges()===true || dirty || mailDirty || compose?.hasUnsavedChanges()===true,
    hasInFlightWork: ()=>corrections?.hasInFlightWork()===true || busy || compose?.hasInFlightWork()===true,
    dispose: ()=>{ disposed=true;generation++;historyGeneration++;clearPrint();corrections?.dispose();compose?.destroy();root.remove(); },
  };
};
