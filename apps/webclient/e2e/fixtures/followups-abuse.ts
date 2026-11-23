import type { AbuseInboxRow, ReceptionIpBlockEntry, QuoteSignoffSummary, QuoteCompletionSummary, QuotePaymentReminderTarget, CustomerAccountPaymentReminderTarget, MailDraft, MailDraftContent } from '@recued/contracts';

/** Deterministic replies for the real Reception Follow-ups and Abuse routes. */
export const installFollowupsAbuseFixture = () => {
  type Reply={result?:unknown;error?:{code:string;message:string}};
  const view=window as Window & {__receptionFixture?:(method:string,args:unknown)=>Promise<Reply|undefined>;__followupAbuse?:{calls:Array<{method:string;args:Record<string,any>}>;hold?:string;release?:()=>void;fail?:string;mailUnavailable?:boolean};__app?:{fireMessage(message:unknown):void}};
  const original=view.__receptionFixture!;const state=view.__followupAbuse={calls:[]} as NonNullable<typeof view.__followupAbuse>;const params=new URLSearchParams(location.search);state.hold=params.get('followup_hold')??undefined;state.fail=params.get('followup_fail')??undefined;state.mailUnavailable=params.has('followup_no_mail');
  const now=Date.now(),day=86400000;const clone=<T>(value:T):T=>structuredClone(value);
  const blocks:ReceptionIpBlockEntry[]=[{endpoint_id:'blocked-endpoint',source_ip_hash:'b'.repeat(64),blocked_at:now-3600000,blocked_by_client_id:'fixture-owner',reason:'Repeated rejected requests.'}];
  const signalKinds=['spam_burst','mime_rejection','invalid_token_burst','endpoint_ddos','oversized_upload','suspicious_payload'] as const;
  const reminders=new Map<string,Record<string,any>>();let draft:MailDraft|undefined;
  const kinds=[{key:'offer',prefix:'reception.signoff.reminders',idKey:'signoff_id',rowKey:'signoff'},{key:'completion',prefix:'reception.signoff.completion.reminders',idKey:'completion_id',rowKey:'completion'},{key:'payment',prefix:'reception.signoff.payment.reminders',idKey:'signoff_id',rowKey:'invoice'},{key:'account',prefix:'reception.accounts.payment.reminders',idKey:'account_id',rowKey:'account'}];
  const initial=(kind:typeof kinds[number],id:string,n:number)=>({[kind.idKey]:id,revision:1,due_at:now+(n===1?day:-day),status:n===1?'scheduled':'due',notified_at:null,drafted_at:null,delivery:n===2?'uncertain':'not_prepared',sender_mail_instance:'work',recipient_email:'morgan@example.test',...(kind.key==='offer'||kind.key==='completion'?{has_saved_link:true}:{draft_stale:params.has('followup_stale')&&n===2})});
  const request=async(kind:typeof kinds[number],id:string,n:number)=>{
    const base=(await original('reception.signoff.list',{}))!.result as {signoffs:QuoteSignoffSummary[]};const offer={...base.signoffs[0]!,signoff_id:id,customer:n===1?'River Studio':'Morgan Studio',quote_label:'Studio drawings',quote_reference:'Q-'+(n+1),expires_at:now+7*day};
    if(kind.key==='offer')return offer;
    if(kind.key==='completion')return{completion_id:id,signoff_id:'offer-1',root_signoff_id:'offer-1',quote_label:offer.quote_label,customer:offer.customer,business_name:'Studio',agreed_scope:'Three drawings.',delivery_summary:'Delivered drawings and final PDF.',customer_preview:'Three drawings. Delivered drawings and final PDF.',state:'waiting',availability:'current',created_at:now-day,expires_at:now+7*day,endpoint_id:'completion-endpoint',response:{decision:'not_recorded',received_at:null,recorded_at:null},owner_action:null} satisfies QuoteCompletionSummary;
    if(kind.key==='payment')return{signoff_id:id,customer:offer.customer,quote_label:offer.quote_label,invoice_ref:'INV-'+(n+1),invoice_id:'invoice-'+n,amount:'120.0000',currency:'GBP',invoice:{availability:'current',status:'open',amount_paid:'20.0000',outstanding:'100.0000',due_on:'2026-11-20',overdue:true}} satisfies QuotePaymentReminderTarget;
    return{account_id:id,customer:offer.customer,job_count:2,balances:[{currency:'GBP',outstanding:'200.0000'}]} satisfies CustomerAccountPaymentReminderTarget;
  };
  view.__receptionFixture=async(method,raw)=>{
    const args=(raw??{}) as Record<string,any>;state.calls.push({method,args:clone(args)});
    if(!method.startsWith('reception.')&&!method.startsWith('mail.drafts.')&&method!=='collection.mail.list')return original(method,raw);
    if(state.hold===method){state.hold=undefined;await new Promise<void>(resolve=>{state.release=resolve;});}
    if(state.fail===method)return{error:{code:params.get('followup_error_code')??'UNAVAILABLE',message:'Follow-up fixture unavailable.'}};
    let result:unknown;
    if(method==='reception.abuse_inbox.list'){
      const rows:AbuseInboxRow[]=params.has('abuse_empty')?[]:signalKinds.map((signal_kind,n)=>({signal_kind,endpoint_id:n===0?'endpoint/one':'endpoint-'+n,source_ip_hash:String(n+1).repeat(64),event_count:n+4,first_seen_at:now-day,last_seen_at:now-60000,ip_blocked:blocks.some(b=>b.endpoint_id===(n===0?'endpoint/one':'endpoint-'+n)&&b.source_ip_hash===String(n+1).repeat(64))}));
      result={summary:{rows,total_signals:rows.length,window_start_at:now-7*day,window_end_at:now,cluster_threshold:3},blocked:params.has('abuse_empty')?[]:clone(blocks)};
    }else if(method==='reception.abuse_inbox.ban_ip'){
      const entry={endpoint_id:args.endpoint_id,source_ip_hash:args.source_ip_hash,blocked_at:now,blocked_by_client_id:'fixture-owner',reason:args.reason??null};if(!blocks.some(b=>b.endpoint_id===entry.endpoint_id&&b.source_ip_hash===entry.source_ip_hash))blocks.push(entry);result={blocked:entry};
    }else if(method==='reception.abuse_inbox.unban_ip'){
      const n=blocks.findIndex(b=>b.endpoint_id===args.endpoint_id&&b.source_ip_hash===args.source_ip_hash);if(n>=0)blocks.splice(n,1);result={removed:n>=0};
    }else if(method==='collection.mail.list')result={instances:state.mailUnavailable?[]:[{slug:'work',adapter_type:'imap',send_capable:true,draft_capable:true,account_email:'owner@example.test'}]};
    else if(method==='mail.drafts.create'){draft={draft_id:'mad_cccccccc-cccc-cccc-cccc-cccccccccccc',incarnation:'followup-fixture',revision:1,content:clone(args.content),origin_contract_id:null,created_at:now,updated_at:now};result=clone(draft);}
    else if(method==='mail.drafts.get')result=clone(draft);
    else if(method==='mail.drafts.list')result={drafts:draft?[{draft_id:draft.draft_id,incarnation:draft.incarnation,revision:draft.revision,origin_contract_id:draft.origin_contract_id,created_at:draft.created_at,updated_at:draft.updated_at,subject:draft.content.subject,sender_mail_instance:draft.content.sender_mail_instance}]:[],next_cursor:null};
    else if(method==='mail.drafts.update'&&draft){draft={...draft,revision:draft.revision+1,content:clone(args.content)};result=clone(draft);}
    else if(method==='reception.accounts.contact.get')result={format:'recued.customer-account-contact-defaults',version:1,account_id:args.account_id,revision:0,updated_at:null,contact:{}};
    else{
      const kind=kinds.find(k=>method.startsWith(k.prefix+'.'));if(!kind)return original(method,raw);
      const action=method.slice(kind.prefix.length+1),id=args[kind.idKey] as string;
      if(action==='list'){
        const start=args.cursor?3:0,ids=Array.from({length:args.cursor?1:3},(_,i)=>i+start);const rows=[];
        for(const n of ids){const rid=kind.key+'-'+n;let reminder=reminders.get(rid);if(!reminder){reminder=initial(kind,rid,n);reminders.set(rid,reminder);}if(reminder.due_at!==null)rows.push({[kind.rowKey]:await request(kind,rid,n),reminder:clone(reminder)});}
        result={reminders:params.has('followup_empty')?[]:rows,...(params.has('followup_pages')&&!args.cursor?{next_cursor:'next-page'}:{})};
      }else{
        const n=Number(id?.split('-').at(-1)??0);const old=reminders.get(id)??initial(kind,id,n);reminders.set(id,old);
        if(action==='get')result=clone(old);
        else if(action==='set'){
          if(args.expected_revision!==old.revision)return{error:{code:'CONFLICT',message:'This follow-up changed. Refresh and review it again.'}};
          const saved={...old,revision:old.revision+1,due_at:args.due_at,status:args.due_at===null?'paused':args.due_at<=now?'due':'scheduled',delivery:'not_prepared',...(args.recipient_email!==undefined?{recipient_email:args.recipient_email}:{}),...(args.sender_mail_instance!==undefined?{sender_mail_instance:args.sender_mail_instance}:{})};reminders.set(id,saved);result=clone(saved);
        }else if(action==='draft'){
          const content:MailDraftContent={sender_mail_instance:'work',to:['morgan@example.test'],subject:'Reminder: '+kind.key+' — Studio drawings',body:'Please review your saved '+kind.key+' request.\n\nhttps://fixture.example.test/reception/approve/fixture?t=fixture-token',body_format:'text',reconciliation_id:'followup-'+id+'-'+old.revision};result={idempotency_key:'followup-'+id+'-'+old.revision,content};
        }else return original(method,raw);
      }
    }
    return{result};
  };
  setInterval(()=>view.__app?.fireMessage({type:'heartbeat',connection_id:'followup-fixture',server_time:Date.now()}),1000);
};
