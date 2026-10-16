import { isFileDownloadChoices, type FileDownloadChoice, type FileDownloadChoices, type ManagedOAuthRequest, type ManagedOAuthResponse } from '@recued/contracts';

/** One explicit file choice before source preparation; opening never reads file bytes. */
export const createFileDownloadPicker = (deps: {
  document: Document;
  call(args: ManagedOAuthRequest): Promise<ManagedOAuthResponse>;
  changed(): void;
}) => {
  const doc = deps.document; let host: HTMLElement | null = null; let disposed = false; let generation = 0;
  let request: { name:string; revision:number; current():boolean; resolve(value:{fileId?:string}|null):void } | undefined;
  let data: FileDownloadChoices | undefined; let selected: FileDownloadChoice | undefined; let loading = false; let error = '';
  let query = ''; let cursor: string | undefined; let history: (string|undefined)[] = []; let focusPending = false;
  const element = <K extends keyof HTMLElementTagNameMap>(tag:K, value?:string):HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag); if (value !== undefined) node.textContent = value; return node;
  };
  const finish = (value:{fileId?:string}|null):void => {
    const previous = request; request = undefined; generation++; loading = false; data = undefined; selected = undefined;
    previous?.resolve(value); if (!disposed) deps.changed();
  };
  const button = (text:string,action:string,disabled:boolean,click:()=>void):HTMLButtonElement => {
    const context = request;
    const node = element('button',text); node.type='button'; node.disabled=disabled; node.setAttribute('data-file-download-picker-action',action);
    node.addEventListener('click',()=>{if(!disposed && context && request===context && context.current() && host?.contains(node) && !node.disabled)click();}); return node;
  };
  const render = ():void => {
    if (disposed || !host) return;
    const restoreFocus = focusPending || host.contains(doc.activeElement);
    while (host.firstChild) host.removeChild(host.firstChild);
    if (!request) return;
    if (!request.current()) { finish(null); return; }
    const context = request;
    const live = (node:HTMLElement):boolean => !disposed && request===context && context.current() && host?.contains(node) === true;
    const section = element('section'); section.className='file-download-picker';section.tabIndex=-1;section.setAttribute('aria-label','Choose a file to verify');section.setAttribute('data-file-download-picker','');section.setAttribute('aria-busy',String(loading));
    section.appendChild(element('h3','Check a file download or export'));
    section.appendChild(element('p','Choose one file from this source. Recued will read it with the current and selected authentication before switching. The file is not saved or sent to an AI service.'));
    section.appendChild(element('p','Checks allow up to 10 MiB. Google documents use their normal Office export. A metadata-only check remains available.'));
    const label=element('label','Find a file by name or path');label.htmlFor='file-download-picker-search';section.appendChild(label);
    const input=element('input');input.type='search';input.maxLength=200;input.id='file-download-picker-search';input.value=query;input.disabled=loading;
    input.setAttribute('data-file-download-picker-query','');input.addEventListener('input',()=>{if(live(input))query=input.value;});
    input.addEventListener('keydown',event=>{if(live(input)&&event.key==='Enter'&&!loading){event.preventDefault();history=[];cursor=undefined;void load();}});section.appendChild(input);
    section.appendChild(button('Search files','search',loading,()=>{history=[];cursor=undefined;void load();}));
    if(loading){const p=element('p','Reading saved file choices…');p.setAttribute('role','status');section.appendChild(p);}
    if(error){const p=element('p',error);p.setAttribute('role','alert');section.appendChild(p);}
    if(data && !data.available){const p=element('p',data.reason);p.setAttribute('role','status');section.appendChild(p);}
    if(data?.available){
      if(!data.files.length) section.appendChild(element('p','No saved files match. Sync this source or try another name.'));
      const list=element('ul');
      for(const file of data.files){
        const item=element('li');const option=element('input');option.type='radio';option.name='file-download-verification';option.value=file.remote_id;
        option.checked=selected?.remote_id===file.remote_id;option.disabled=loading||!!file.unavailable_reason;
        option.setAttribute('data-file-download-picker-choice',file.remote_id);
        option.addEventListener('change',()=>{if(live(option)&&!loading&&!file.unavailable_reason){selected=file;render();
          host?.querySelectorAll<HTMLInputElement>('[data-file-download-picker-choice]').forEach(input=>{if(input.value===file.remote_id)input.focus();});
        }});
        const choice=element('label');choice.appendChild(option);choice.appendChild(element('span',file.filename));item.appendChild(choice);
        item.appendChild(element('p',file.mode==='export'?'Export as '+file.output_filename:'Download original file'));
        if(file.path)item.appendChild(element('p',file.path));
        if(file.unavailable_reason)item.appendChild(element('p',file.unavailable_reason));list.appendChild(item);
      }
      section.appendChild(list);
      section.appendChild(button('Previous files','previous',loading||!history.length,()=>{cursor=history.pop();void load();}));
      section.appendChild(button('Next files','next',loading||!data.next_cursor,()=>{history.push(cursor);cursor=data!.next_cursor;void load();}));
    }
    if(selected)section.appendChild(element('p','Selected: '+selected.filename+(selected.mode==='export'?' → '+selected.output_filename:'')));
    const actions=element('div');actions.className='file-download-picker-actions';
    actions.appendChild(button('Verify this file and continue','verify',loading||!selected,()=>finish({fileId:selected!.remote_id})));
    actions.appendChild(button('Continue with metadata only','metadata-only',false,()=>finish({})));
    actions.appendChild(button('Cancel','cancel',false,()=>finish(null)));section.appendChild(actions);
    section.appendChild(element('p','A successful check covers this file and format. It does not prove writes or every file’s access.'));
    host.appendChild(section);
    if(restoreFocus){(loading?section:input).focus();focusPending=false;}
  };
  const load = async ():Promise<void> => {
    if(!request || disposed)return;
    const current=request; const gen=++generation;loading=true;error='';data=undefined;render();
    try{
      const reply=await deps.call({action:'file_authentication_files',name:current.name,expected_updated_at:current.revision,query,
        ...(cursor?{after:cursor}:{})});
      if(disposed||gen!==generation||request!==current)return;
      if(!current.current()){finish(null);return;}
      if(reply.action!=='file_authentication_files'||!isFileDownloadChoices(reply.choices)||reply.choices.connection_name!==current.name||reply.choices.updated_at!==current.revision)throw new Error('invalid file choices');
      data=structuredClone(reply.choices);
      // Keep an off-page choice, but never keep a disabled or unavailable one.
      const refreshed = selected && data.files.find(file=>file.remote_id===selected!.remote_id);
      if(!data.available || refreshed?.unavailable_reason)selected=undefined;
      else if(refreshed)selected=refreshed;
    }catch{
      if(!disposed&&gen===generation){selected=undefined;error='File choices could not be read. Refresh the source or continue with metadata only.';}
    }finally{if(!disposed&&gen===generation){loading=false;render();}}
  };
  return {
    choose(name:string,revision:number,current:()=>boolean):Promise<{fileId?:string}|null>{
      if(disposed)return Promise.resolve(null);
      if(request)finish(null);
      data=undefined;selected=undefined;query='';cursor=undefined;history=[];error='';focusPending=true;
      const result=new Promise<{fileId?:string}|null>(resolve=>{request={name,revision,current,resolve};});
      deps.changed();void load();return result;
    },
    active:():boolean=>!!request&&request.current(),
    mount(element:HTMLElement|null):void{host=element;if(request&&!request.current()){finish(null);return;}render();},
    cancel():void{if(request)finish(null);},
    dispose():void{disposed=true;finish(null);host=null;},
  };
};
export const FILE_DOWNLOAD_PICKER_STYLES = `.file-download-picker{padding:16px;border:1px solid var(--border,#d9dfeb);border-radius:10px;margin:12px 0;overflow-wrap:anywhere}.file-download-picker h3{margin-top:0}.file-download-picker label{display:block;margin:6px 0}.file-download-picker input[type=search]{display:block;box-sizing:border-box;font:inherit;width:100%;padding:8px}.file-download-picker ul{list-style:none;padding:0}.file-download-picker li{border-top:1px solid var(--border,#d9dfeb);padding:8px 0}.file-download-picker li p{margin:4px 0 4px 24px}.file-download-picker input[type=radio]{margin-right:8px}.file-download-picker button{font:inherit;min-height:44px;padding:7px 12px;margin:4px 8px 4px 0;max-width:100%;white-space:normal}.file-download-picker button:disabled{opacity:.6}.file-download-picker [role=alert]{color:var(--danger,#b42318)}`;
