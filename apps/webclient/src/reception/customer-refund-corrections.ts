import { setCustomerReviewLink } from './customer-review-link.js';
import { CUSTOMER_REFUND_CORRECTION_RECIPE,type Conn,type ServerRpcRegistry,type CustomerPaymentHistory,
  type CustomerRefundCorrectionPrepareInput,type CustomerRefundCorrectionPreview,type CustomerRefundCorrectionRecord } from '@recued/contracts';
import type { QuoteSignoffPaymentOptions } from './quote-signoff-payment.js';

export type CustomerRefundCorrectionsConn=Conn<Pick<ServerRpcRegistry,'reception.signoff.refund.correction.prepare' | 'reception.signoff.refund.correction.history'>>;
/** Keep the reviewed editor outside rows replaced by history refreshes. */
export const mountCustomerRefundCorrections=(opts: {
  document: Document;host: HTMLElement;conn: CustomerRefundCorrectionsConn;payment: QuoteSignoffPaymentOptions;
  canReview: ()=>boolean;onChanged: ()=>void;onStateChanged: ()=>void;onOpen: ()=>void;onViewCopy: (id: string)=>void;
})=>{
  const doc=opts.document;const root=doc.createElement('section');root.setAttribute('data-refund-corrections','');opts.host.appendChild(root);
  const add=(tag: string,text: string,host: HTMLElement=root)=>{ const node=doc.createElement(tag);node.textContent=text;host.appendChild(node);return node; };
  const button=(text: string,host: HTMLElement,fn: ()=>void)=>{ const node=doc.createElement('button');node.type='button';node.textContent=text;host.appendChild(node);node.addEventListener('click',fn);return node; };
  add('style','[data-refund-corrections] [hidden]{display:none!important}[data-refund-corrections] form,[data-refund-corrections] label{display:grid;gap:8px}[data-refund-corrections] input,[data-refund-corrections] textarea,[data-refund-corrections] select{box-sizing:border-box;max-width:100%;min-width:0}[data-refund-corrections] p,[data-refund-corrections] pre{white-space:pre-wrap;overflow-wrap:anywhere}');
  const manage=button('Correct a recorded refund',root,()=>open());const content=add('div','');content.hidden=true;
  add('p','Reverse a mistaken refund entry, or replace wrong details. Each correction keeps the original and needs your approval. Money stays outside Recued.',content);
  const editor=doc.createElement('form');editor.hidden=true;editor.tabIndex=-1;editor.setAttribute('aria-label','Correct recorded refund');editor.setAttribute('data-refund-correction-editor','');content.appendChild(editor);
  const select=(label: string,host: HTMLElement)=>{ const node=doc.createElement('select');node.id='recued-refund-correction-'+crypto.randomUUID();const text=add('label',label,host);text.setAttribute('for',node.id);host.appendChild(node);return node; };
  const option=(node: HTMLSelectElement,value: string,label: string)=>{ const child=doc.createElement('option');child.value=value;child.textContent=label;node.appendChild(child); };
  const source=select('Refund to correct',editor);source.required=true;
  const mode=select('Refund correction action',editor);option(mode,'reverse','Reverse this refund entry');option(mode,'replace','Reverse and replace this refund entry');
  const fields=add('div','',editor);
  const input=(label: string,type: string,name: string,host: HTMLElement,required=true,max=512)=>{ const text=add('label',label,host);const node=doc.createElement('input');node.type=type;node.name=name;node.required=required;node.maxLength=max;text.appendChild(node);return node; };
  const area=(label: string,name: string,host: HTMLElement)=>{ const text=add('label',label,host);const node=doc.createElement('textarea');node.name=name;node.required=true;node.maxLength=1000;text.appendChild(node);return node; };
  const amount=input('Replacement refund amount','text','replacement_refund_amount',fields,true,24);amount.inputMode='decimal';
  const returned=input('Replacement refund date','date','replacement_refund_date',fields);
  const replacementReason=area('Replacement refund reason (shown on customer copy)','replacement_refund_reason',fields);
  const method=input('Replacement refund method','text','replacement_refund_method',fields,false);const reference=input('Replacement refund reference','text','replacement_refund_reference',fields,false);
  const reversed=input('Refund reversal date','date','refund_reversed_on',editor);const reason=area('Refund correction reason (shown on customer copies)','refund_correction_reason',editor);
  const prepare=doc.createElement('button');prepare.type='submit';prepare.textContent='Preview refund correction';editor.appendChild(prepare);
  const close=button('Close refund correction',editor,()=>reset());const previewHost=add('div','',editor);previewHost.setAttribute('data-refund-correction-preview','');
  const review=button('Review refund correction',editor,()=>{ void submit(); });review.hidden=true;const runs=add('a','Review refund correction in Runs',editor);runs.hidden=true;
  const status=add('p','',content);status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  add('h4','Refund correction history',content);const rows=add('div','',content);rows.setAttribute('data-refund-correction-history','');const historyStatus=add('p','',content);historyStatus.setAttribute('role','status');
  const refresh=button('Refresh refund correction history',content,()=>{ void loadHistory(cursor,[...previous]); });
  const newer=button('Newer refund corrections',content,()=>{ if(previous.length)void loadHistory(previous.at(-1),previous.slice(0,-1)); });
  const older=button('Older refund corrections',content,()=>{ if(nextCursor)void loadHistory(nextCursor,[...previous,cursor]); });
  let disposed=false;let busy=false;let dirty=false;let queued=false;let generation=0;let historyGeneration=0;let loading=false;
  let history: CustomerPaymentHistory | null=null;let frozen: CustomerPaymentHistory | null=null;
  let prepared: { preview: CustomerRefundCorrectionPreview;input: CustomerRefundCorrectionPrepareInput } | null=null;
  let requestKey=crypto.randomUUID();let cursor: string | undefined;let nextCursor: string | undefined;let previous: Array<string | undefined>=[];let copyButtons: HTMLButtonElement[]=[];
  const message=(error: unknown)=>error instanceof Error ? error.message : 'The refund correction could not be loaded. Try again.';
  const controls=()=>{
    const locked=busy || queued;[source,mode,amount,returned,replacementReason,method,reference,reversed,reason,prepare].forEach(n=>{n.disabled=locked;});close.disabled=busy;review.disabled=locked || !prepared;
    fields.hidden=mode.value==='reverse';amount.required=returned.required=replacementReason.required=!fields.hidden;
    manage.textContent=history?.refunds?.length && history.refunds.every(r=>r.reversal) ? 'View refund corrections' : 'Correct a recorded refund';
    manage.disabled=busy || !editor.hidden || !history?.snapshot_hash || !history.refunds?.length || !opts.canReview();
    refresh.disabled=newer.disabled=older.disabled=loading || busy;newer.disabled ||= !previous.length;older.disabled ||= !nextCursor;
    copyButtons.forEach(n=>{n.disabled=busy || !editor.hidden || !opts.canReview();});
  };
  const reset=(focus=true)=>{ if(disposed || busy)return;generation++;frozen=null;prepared=null;dirty=queued=false;editor.hidden=true;previewHost.replaceChildren();review.hidden=true;runs.hidden=true;controls();opts.onStateChanged();if(focus)manage.focus(); };
  const show=(c: CustomerRefundCorrectionRecord)=>{
    const card=add('article','',rows);card.setAttribute('data-refund-correction-id',c.correction_id);add('h5',`${c.applied_at===null ? 'Prepared correction for' : 'Reversed refund'} ${c.before.refund_ref}`,card);
    add('p',c.applied_at===null ? 'Prepared only — no records changed.' : `Applied ${new Date(c.applied_at).toISOString()}. Reversal date: ${c.reversed_on}.`,card);
    add('p',`Original refund: ${c.before.amount} ${c.currency} · ${c.before.returned_on}. ${c.before.reason}`,card);
    add('p',c.replacement ? `Replacement ${c.replacement.refund_ref}: ${c.replacement.amount} ${c.currency} · ${c.replacement.returned_on}. ${c.replacement.reason}` : 'No replacement refund record.',card);
    add('p',`Recorded refunds: ${c.before_balance.amount_refunded} → ${c.after_balance.amount_refunded} ${c.currency}. Refund owed: ${c.before_balance.refund_due} → ${c.after_balance.refund_due} ${c.currency}.`,card);
    add('p',`Recorded net received: ${c.before_balance.net_received} → ${c.after_balance.net_received} ${c.currency}. Customer still owes: ${c.outstanding} ${c.currency}.`,card);
    add('p',`Correction reason: ${c.reason}`,card);add('p',`Prepared by paired client ${c.prepared_by}.`,card);if(c.run_id)add('p',`Reviewed run: ${c.run_id}${c.actor ? ' · '+c.actor : ''}`,card);
    if(c.applied_at!==null){copyButtons.push(button('View refund correction notice',card,()=>opts.onViewCopy(c.before.refund_id)));if(c.replacement)copyButtons.push(button('View corrected refund receipt',card,()=>opts.onViewCopy(c.replacement!.refund_id)));}
    else if(c.run_id){const link=add('a','Check correction review in Runs',card);setCustomerReviewLink(doc,link,c.run_id,'#reception/signoffs/'+encodeURIComponent(c.signoff_id));}
  };
  const loadHistory=async(requested?: string,trail=[...previous])=>{
    if(disposed || !history || content.hidden)return;const id=history.signoff_id;const current=++historyGeneration;loading=true;controls();
    try{const result=await opts.conn('reception.signoff.refund.correction.history',{signoff_id:id,limit:50,...(requested ? {cursor:requested} : {})});if(disposed || current!==historyGeneration || id!==history?.signoff_id)return;
      if(result.corrections.some(c=>c.signoff_id!==id))throw new Error('Refund correction history does not match this invoice.');cursor=requested;previous=trail;nextCursor=result.next_cursor;rows.replaceChildren();copyButtons=[];result.corrections.forEach(show);historyStatus.textContent=result.corrections.length ? `Correction history page ${previous.length+1}.` : 'No refund corrections recorded.';
    }catch(error){if(!disposed && current===historyGeneration)historyStatus.textContent=message(error);}
    finally{if(!disposed && current===historyGeneration){loading=false;controls();}}
  };
  const seed=()=>{const original=frozen?.refunds?.find(r=>r.refund_id===source.value);amount.value=original?.amount??'';returned.value=original?.returned_on??'';replacementReason.value=original?.reason??'';method.value=original?.method??'';reference.value=original?.reference??'';};
  source.addEventListener('change',seed);
  const open=()=>{
    if(disposed || busy || !editor.hidden || !history?.snapshot_hash || !opts.canReview())return;
    if(!(history.refunds??[]).some(r=>!r.reversal)){content.hidden=false;status.textContent='All recorded refunds have been reversed. Open a saved notice from correction history.';void loadHistory(undefined,[]);return;}
    opts.onOpen();frozen=history;prepared=null;dirty=queued=false;generation++;requestKey=crypto.randomUUID();source.replaceChildren();option(source,'','Choose a recorded refund');
    for(const r of history.refunds??[])if(!r.reversal)option(source,r.refund_id,`${r.refund_ref} · ${r.amount} ${history.currency} · ${r.returned_on}`);
    mode.value='reverse';seed();reason.value='';const today=new Date();reversed.value=`${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
    previewHost.replaceChildren();review.hidden=true;runs.hidden=true;editor.hidden=false;content.hidden=false;status.textContent='Preview the saved refund and exact balance change. No money is moved.';controls();editor.focus();opts.onStateChanged();void loadHistory(cursor,[...previous]);
  };
  const finish=()=>{reset(false);opts.onChanged();void loadHistory(undefined,[]);manage.focus();};
  const submit=async()=>{
    if(disposed || busy || queued || !prepared || !opts.canReview())return;const target=prepared;const current=++generation;busy=true;controls();opts.onStateChanged();let applied=false;
    try{const inventory=await opts.payment.listRecipes();if(disposed || current!==generation)return;
      const matches=inventory.recipes.filter(r=>r.recipe_id===CUSTOMER_REFUND_CORRECTION_RECIPE && r.recipe.recipe_id===CUSTOMER_REFUND_CORRECTION_RECIPE && r.publisher_id==='recued-core' && r.version>=1 && r.recipe.version===r.version && r.recipe.metadata?.recipe_bundle==='recued-core/reception-approval');
      if(matches.length!==1)throw new Error('Install or update Reception — Approval from Packs before reviewing refund corrections.');
      const result=await opts.payment.execute({recipe_id:CUSTOMER_REFUND_CORRECTION_RECIPE,config:{...target.preview.review}});if(disposed || current!==generation)return;
      if(result.awaiting_approval===true){queued=true;dirty=false;setCustomerReviewLink(doc,runs,result.run_id,'#reception/signoffs/'+encodeURIComponent(target.input.signoff_id));status.textContent='Refund correction is waiting for owner approval. Review the reversal, replacement and exact balances in Runs.';}
      else if(result.success===true && result.run_terminated===undefined){const confirmed=await opts.conn('reception.signoff.refund.correction.prepare',target.input);if(disposed || current!==generation)return;
        if(confirmed.correction.correction_id!==target.preview.correction.correction_id || confirmed.correction.signoff_id!==target.input.signoff_id || confirmed.correction.before.refund_id!==target.input.refund_id || confirmed.correction.applied_at===null || confirmed.review.expected_plan_hash!==target.preview.review.expected_plan_hash)throw new Error('The run finished, but the refund correction is unconfirmed. Check Runs and refresh payment history.');
        dirty=false;applied=true;status.textContent='Refund correction applied. Refreshing the recorded balances.';
      }else throw new Error('The refund correction was not applied. Check Runs before trying again.');
    }catch(error){if(!disposed && current===generation)status.textContent=message(error);}
    finally{if(!disposed && current===generation){busy=false;controls();opts.onStateChanged();if(applied)finish();}}
  };
  const edited=()=>{if(busy || queued)return;dirty=true;prepared=null;requestKey=crypto.randomUUID();previewHost.replaceChildren();review.hidden=true;controls();opts.onStateChanged();};editor.addEventListener('input',edited);editor.addEventListener('change',edited);
  editor.addEventListener('submit',event=>{
    event.preventDefault();if(disposed || busy || queued || !frozen?.snapshot_hash || !opts.canReview())return;const target=frozen;const current=++generation;
    const request: CustomerRefundCorrectionPrepareInput={request_key:requestKey,signoff_id:target.signoff_id,refund_id:source.value,expected_snapshot_hash:target.snapshot_hash!,action:mode.value==='replace'?'replace':'reverse',reason:reason.value,reversed_on:reversed.value,
      ...(mode.value==='replace'?{amount:amount.value,returned_on:returned.value,replacement_reason:replacementReason.value,...(method.value?{method:method.value}:{}),...(reference.value?{reference:reference.value}:{})}:{})};
    busy=true;prepared=null;review.hidden=true;previewHost.replaceChildren();status.textContent='Preparing refund correction…';controls();opts.onStateChanged();
    void(async()=>{let replay=false;try{const result=await opts.conn('reception.signoff.refund.correction.prepare',request);if(disposed || current!==generation)return;
      if(result.correction.signoff_id!==target.signoff_id || result.correction.invoice_id!==target.invoice_id || result.correction.before.refund_id!==request.refund_id || result.correction.action!==request.action || result.correction.correction_id!==result.review.correction_id || !/^[a-f0-9]{64}$/.test(result.review.expected_plan_hash))throw new Error('This correction preview does not match the selected refund.');
      prepared={preview:result,input:request};add('pre',result.review.summary,previewHost);replay=result.correction.applied_at!==null;review.hidden=replay;dirty=!replay;status.textContent=replay?'This correction is already applied. Refreshing balances.':'Preview ready. Review the correction to request owner approval.';void loadHistory(undefined,[]);
    }catch(error){if(!disposed && current===generation)status.textContent=message(error);}
    finally{if(!disposed && current===generation){busy=false;controls();opts.onStateChanged();if(replay)finish();}}})();
  });
  controls();return {
    setInvoice(value: CustomerPaymentHistory){if(history && history.signoff_id!==value.signoff_id){generation++;historyGeneration++;busy=false;reset(false);cursor=nextCursor=undefined;previous=[];rows.replaceChildren();content.hidden=true;}history=value;controls();if(!content.hidden)void loadHistory(cursor,[...previous]);},
    reset:()=>{if(!busy){reset(false);content.hidden=true;}},refreshControls:controls,isOpen:()=>!editor.hidden,hasUnsavedChanges:()=>dirty,hasInFlightWork:()=>busy,
    dispose:()=>{disposed=true;generation++;historyGeneration++;root.remove();},
  };
};
