const FALLBACK_ZONES=['UTC','Africa/Cairo','Africa/Johannesburg','America/Anchorage','America/Argentina/Buenos_Aires','America/Chicago','America/Denver','America/Los_Angeles','America/Mexico_City','America/New_York','America/Sao_Paulo','America/Toronto','Asia/Dubai','Asia/Hong_Kong','Asia/Kolkata','Asia/Shanghai','Asia/Singapore','Asia/Tokyo','Australia/Sydney','Europe/Berlin','Europe/Kyiv','Europe/London','Europe/Paris','Pacific/Auckland','Pacific/Honolulu'];
const fold=(text:string)=>text.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[_/]/g,' ').replace(/\s+/g,' ').trim();
const supported=()=> (Intl as unknown as {supportedValuesOf?:(key:string)=>string[]}).supportedValuesOf?.('timeZone')??FALLBACK_ZONES;

/** Include exact retained values, including aliases or zones unknown to this
 * browser. The server remains responsible for validating a saved setting. */
export const timezoneCatalog=(retained:readonly string[]=[],enumerate:()=>readonly string[]=supported):string[]=>{
  let zones:readonly string[];try{zones=enumerate();}catch{zones=FALLBACK_ZONES;}
  return [...new Set([...retained.filter(value=>typeof value==='string'&&!!value.trim()&&value.length<=100),'UTC',...zones,...FALLBACK_ZONES.filter(validHere)])];
};
export const searchTimezones=(zones:readonly string[],query:string,current=''):string[]=>{
  const needle=fold(query),words=needle.split(' ').filter(Boolean);
  const rank=(zone:string)=>zone===current?0:fold(zone)===needle?1:fold(zone.split('/').at(-1)??zone)===needle?2:3;
  return zones.filter(zone=>words.every(word=>fold(zone).includes(word))).sort((a,b)=>rank(a)-rank(b)||a.localeCompare(b,'en'));
};
export const timezoneLocalTime=(zone:string,at:number,locale?:string):string|null=>{
  try{return new Intl.DateTimeFormat(locale,{timeZone:zone,month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'shortOffset'}).format(at);}
  catch{return null;}
};
const validHere=(zone:string)=>{try{new Intl.DateTimeFormat('en',{timeZone:zone.trim()}).format(0);return true;}catch{return false;}};
let serial=0;
export interface TimezonePicker { close():void; retain(values:readonly string[]):void; dispose():void }
export const mountTimezonePicker=(options:{document:Document;host:HTMLElement;input:HTMLInputElement;label:string;
  retained?:readonly string[];now?:()=>number;locale?:string}):TimezonePicker=>{
  const {document:doc,host,input,label}=options,retained=[input.value,...(options.retained??[])],id='timezone-choices-'+(++serial);
  let zones=timezoneCatalog(retained),current=input.value;
  const original=new Map(['role','aria-label','aria-autocomplete','aria-controls','aria-expanded','aria-activedescendant','aria-haspopup','autocomplete'].map(name=>[name,input.getAttribute?.(name)??null]));
  const popup=doc.createElement('div');popup.setAttribute('data-timezone-picker-popup','');popup.hidden=true;
  const status=doc.createElement('p');status.textContent=' ';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const list=doc.createElement('ul');list.id=id;list.setAttribute('role','listbox');list.setAttribute('aria-label',label+' choices');popup.appendChild(status);popup.appendChild(list);host.appendChild(popup);
  host.setAttribute('data-timezone-picker-host','');input.setAttribute('role','combobox');input.setAttribute('aria-label',label);
  input.setAttribute('autocomplete','off');input.setAttribute('aria-autocomplete','list');input.setAttribute('aria-haspopup','listbox');input.setAttribute('aria-controls',id);input.setAttribute('aria-expanded','false');
  let disposed=false,opened=false,choosingEnter=false,active=-1,visible:string[]=[];
  let pendingOpen:ReturnType<typeof setTimeout>|undefined;
  const cancelOpen=()=>{if(pendingOpen!==undefined){clearTimeout(pendingOpen);pendingOpen=undefined;}};
  const setText=(element:HTMLElement,value:string)=>{if(element.firstChild?.nodeType===3)element.firstChild.nodeValue=value;else element.textContent=value;};
  const close=()=>{cancelOpen();opened=false;active=-1;visible=[];popup.hidden=true;input.setAttribute('aria-expanded','false');input.removeAttribute?.('aria-activedescendant');};
  const place=()=>{
    const rect=input.getBoundingClientRect?.(),height=doc.defaultView?.innerHeight??0;
    popup.setAttribute('data-placement',rect&&height&&height-rect.bottom<Math.min(280,height*.4)&&rect.top>height-rect.bottom?'above':'below');
  };
  const highlight=(index:number)=>{active=index;rows.forEach(({item},i)=>item.setAttribute('aria-selected',String(i===active)));
    const item=rows[active]?.item;if(item){input.setAttribute('aria-activedescendant',item.id);item.scrollIntoView?.({block:'nearest'});}else input.removeAttribute?.('aria-activedescendant');};
  const choose=(zone:string)=>{
    if(disposed||input.disabled||input.readOnly){close();return;}
    current=zone;input.value=zone;
    const EventType=doc.defaultView?.Event??Event;
    input.dispatchEvent(new EventType('input',{bubbles:true}));input.dispatchEvent(new EventType('change',{bubbles:true}));
    if(!disposed){close();input.focus?.({preventScroll:true});}
  };
  // Reuse rows and text nodes: removing popup children during a native input
  // event ends Chromium's typing undo group, even though the editor stays put.
  const rows=Array.from({length:12},(_,index)=>{
    const item=doc.createElement('li');item.id=id+'-'+index;item.hidden=true;item.setAttribute('role','option');item.setAttribute('aria-selected','false');
    const name=doc.createElement('strong'),time=doc.createElement('span');name.textContent=' ';time.textContent=' ';time.id=item.id+'-time';item.setAttribute('aria-describedby',time.id);
    item.appendChild(name);item.appendChild(time);list.appendChild(item);
    item.addEventListener('pointerdown',event=>{event.preventDefault();});item.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();const zone=visible[index];if(zone)choose(zone);});
    return {item,name,time};
  });
  const open=()=>{
    cancelOpen();
    if(disposed||input.disabled||input.readOnly||doc.activeElement!==input)return;
    if(validHere(input.value)||zones.includes(input.value))current=input.value;
    const matches=searchTimezones(zones,input.value,current);visible=matches.slice(0,rows.length);active=-1;opened=true;popup.hidden=false;
    input.setAttribute('aria-expanded','true');input.removeAttribute?.('aria-activedescendant');
    const at=(options.now??Date.now)();
    setText(status,!matches.length?'No matching timezones. You can still enter a timezone ID.':matches.length>visible.length?`${matches.length} matching timezones. Showing the first ${visible.length}; type more to narrow the choices.`:`${matches.length} matching ${matches.length===1?'timezone':'timezones'}. Use arrow keys and Enter to choose.`);
    rows.forEach(({item,name,time},index)=>{
      const zone=visible[index];item.hidden=zone===undefined;item.setAttribute('aria-selected','false');if(zone===undefined)return;
      item.setAttribute('aria-label',zone);
      item.setAttribute('aria-posinset',String(index+1));item.setAttribute('aria-setsize',String(matches.length));item.setAttribute('data-timezone-value',zone);
      setText(name,zone);setText(time,(timezoneLocalTime(zone,at,options.locale)??'Local time unavailable in this browser')+(zone===current?' · Selected value':''));
    });
    place();
  };
  // Batch changes after a typing pause so the results do not split a native
  // typing undo group. Navigation flushes the latest query without a delay.
  const onInput=()=>{close();if(!disposed&&!input.disabled&&!input.readOnly&&doc.activeElement===input)pendingOpen=setTimeout(()=>{pendingOpen=undefined;open();},150);};
  const keydown=(event:KeyboardEvent)=>{
    if(disposed||input.disabled||input.readOnly||event.isComposing)return;
    const stop=()=>{event.preventDefault();event.stopImmediatePropagation();};
    if(event.key==='Enter'&&choosingEnter){stop();return;}
    if(pendingOpen!==undefined&&['ArrowDown','ArrowUp','Enter','Home','End'].includes(event.key))open();
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){
      stop();if(!opened)open();if(visible.length)highlight(active<0?event.key==='ArrowDown'?0:visible.length-1:Math.max(0,Math.min(visible.length-1,active+(event.key==='ArrowDown'?1:-1))));return;
    }
    if(event.key==='Escape'&&(opened||pendingOpen!==undefined)){stop();close();return;}
    if(event.key==='Tab'){close();return;}
    if(opened&&active>=0&&(event.key==='Home'||event.key==='End')){stop();highlight(event.key==='Home'?0:visible.length-1);return;}
    if(event.key==='Enter'&&opened){
      if(active>=0&&visible[active]){stop();choosingEnter=true;choose(visible[active]!);return;}
      // Preserve existing Enter-to-save for typed IDs, saved aliases, and
      // server-supported zones newer than this browser's timezone database.
      // Unmatched single-token IDs such as PST also belong to server validation.
      if(validHere(input.value)||/^[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)+$/.test(input.value.trim())||zones.includes(input.value)
        ||(!visible.length&&/^[A-Za-z0-9._+-]+$/.test(input.value.trim()))){close();return;}
      stop();setText(status,'Choose a timezone with the arrow keys and Enter, or enter its full ID.');
    }
  };
  const keyup=(event:KeyboardEvent)=>{if(event.key==='Enter')choosingEnter=false;};
  const blur=()=>{choosingEnter=false;close();};
  const outside=(event:Event)=>{if(opened&&!host.contains?.(event.target as Node))close();};
  input.addEventListener('focus',open);input.addEventListener('click',open);input.addEventListener('input',onInput);input.addEventListener('blur',blur);input.addEventListener('keydown',keydown,true);input.addEventListener('keyup',keyup);
  doc.addEventListener?.('pointerdown',outside,true);doc.defaultView?.addEventListener('resize',place);
  const Observer=doc.defaultView?.MutationObserver,observer=Observer?new Observer(()=>{if(input.disabled||input.readOnly)close();}):undefined;
  observer?.observe(input,{attributes:true,attributeFilter:['disabled','readonly']});
  return {close,retain(values){if(!disposed)zones=timezoneCatalog(values,()=>zones);},dispose(){
    if(disposed)return;disposed=true;close();observer?.disconnect();
    input.removeEventListener?.('focus',open);input.removeEventListener?.('click',open);input.removeEventListener?.('input',onInput);input.removeEventListener?.('blur',blur);input.removeEventListener?.('keydown',keydown,true);input.removeEventListener?.('keyup',keyup);
    doc.removeEventListener?.('pointerdown',outside,true);doc.defaultView?.removeEventListener('resize',place);popup.remove?.();host.removeAttribute?.('data-timezone-picker-host');
    for(const [name,value] of original)if(value===null)input.removeAttribute?.(name);else input.setAttribute(name,value);
  }};
};

export const TIMEZONE_PICKER_STYLES=`
[data-timezone-picker-host]{position:relative;min-width:0}
[data-timezone-picker-popup][hidden],[data-timezone-picker-popup] [hidden]{display:none!important}
[data-timezone-picker-popup]{position:absolute;left:0;right:0;top:100%;z-index:60;max-height:min(45vh,340px);overflow:auto;border:1px solid var(--border,#ccd2da);border-radius:8px;background:var(--surface,#fff);color:var(--fg,#18202b);box-shadow:0 8px 24px #0002;font-size:13px;text-align:left}
[data-timezone-picker-popup][data-placement=above]{top:auto;bottom:100%}
[data-timezone-picker-popup] p{margin:0;padding:10px;font-size:12px;color:var(--fg-muted,#586472)}
[data-timezone-picker-popup] ul{margin:0;padding:0;list-style:none}
[data-timezone-picker-popup] li{display:flex;flex-direction:column;justify-content:center;gap:4px;min-height:48px;padding:10px;cursor:pointer;overflow-wrap:anywhere}
[data-timezone-picker-popup] li span{font-size:12px;color:var(--fg-muted,#586472)}
[data-timezone-picker-popup] li:hover,[data-timezone-picker-popup] li[aria-selected=true]{background:var(--accent-weak,#e4f2f6);outline:2px solid var(--accent,#087e96);outline-offset:-2px}
`;
