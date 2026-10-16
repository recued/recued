import { describe, expect, it, vi } from 'vitest';
import { FILE_DOWNLOAD_VERIFICATION_MAX_BYTES, type ManagedOAuthResponse } from '@recued/contracts';
import { createFileDownloadPicker } from '../settings/file-download-picker.js';
import { pickerTestDom } from './helpers/file-download-picker-dom.js';
const page=(name='work',revision=2):ManagedOAuthResponse=>({action:'file_authentication_files',choices:{source_id:'google.'+name+'.file',connection_name:name,updated_at:revision,available:true,max_bytes:FILE_DOWNLOAD_VERIFICATION_MAX_BYTES,
  files:[{remote_id:'one',filename:'Chosen <file>.pdf',path:'Work/Chosen <file>.pdf',output_filename:'Chosen.pdf',mode:'download',mime_type:'application/pdf'},
    {remote_id:'large',filename:'Too big.pdf',output_filename:'Too big.pdf',mode:'download',mime_type:'application/pdf',unavailable_reason:'Choose a smaller file.'}],next_cursor:'one'}});
const tick=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
const fixture=()=>{
  const dom=pickerTestDom();const call=vi.fn(async()=>page());let current=true;
  const picker=createFileDownloadPicker({document:dom.document,call,changed:()=>picker.mount(dom.root as unknown as HTMLElement)});
  picker.mount(dom.root as unknown as HTMLElement);
  return {...dom,call,picker,start:()=>picker.choose('work',2,()=>current),stale:()=>{current=false;}};
};
describe('explicit file download/export picker',()=>{
  it('does not choose or prepare a sample and returns only the owner-selected file',async()=>{
    const f=fixture();const selected=f.start();await tick();expect(f.action('verify').disabled).toBe(true);expect(f.choice('large').disabled).toBe(true);
    expect(f.root.textContent).toContain('Work/Chosen <file>.pdf');f.choice('one').fire('change');expect(f.choice('one').focused).toBe(true);f.action('verify').click();expect(await selected).toEqual({fileId:'one'});
    expect(f.call).toHaveBeenCalledExactlyOnceWith({action:'file_authentication_files',name:'work',expected_updated_at:2,query:''});
  });
  it.each(['metadata-only','cancel'] as const)('allows %s while the local list is still pending and ignores the late result',async action=>{
    const f=fixture();let finish!:(value:ManagedOAuthResponse)=>void;f.call.mockImplementation(()=>new Promise(r=>{finish=r;}));const selected=f.start();f.action(action).click();expect(await selected).toEqual(action==='cancel'?null:{});finish(page());await tick();expect(f.picker.active()).toBe(false);expect(f.root.children).toHaveLength(0);
  });
  it('supports search and previous/next pages without selecting a file',async()=>{
    const f=fixture();const selected=f.start();await tick();f.action('next').click();await tick();expect(f.call).toHaveBeenLastCalledWith({action:'file_authentication_files',name:'work',expected_updated_at:2,query:'',after:'one'});
    f.action('previous').click();await tick();expect(f.call).toHaveBeenLastCalledWith({action:'file_authentication_files',name:'work',expected_updated_at:2,query:''});
    const search=f.root.querySelector('[data-file-download-picker-query]')!;search.value='Chosen';search.fire('input');f.action('search').click();await tick();expect(f.call).toHaveBeenLastCalledWith({action:'file_authentication_files',name:'work',expected_updated_at:2,query:'Chosen'});
    expect(f.action('verify').disabled).toBe(true);f.picker.cancel();await selected;
  });
  it.each(['wrong-name','wrong-revision','malformed','rejected'] as const)('keeps an explicit metadata option if file choices are %s',async mode=>{
    const f=fixture();if(mode==='rejected')f.call.mockRejectedValue(new Error('private server detail'));else f.call.mockResolvedValue(mode==='malformed'?{action:'profiles',profiles:[]}:page(mode==='wrong-name'?'other':'work',mode==='wrong-revision'?3:2));
    const selected=f.start();await tick();expect(f.root.textContent).toContain('File choices could not be read');expect(f.root.textContent).not.toContain('private server');expect(f.action('verify').disabled).toBe(true);f.action('metadata-only').click();expect(await selected).toEqual({});
  });
  it.each(['dispose','stale'] as const)('retires pending choices on %s',async mode=>{
    const f=fixture();let finish!:(value:ManagedOAuthResponse)=>void;f.call.mockImplementation(()=>new Promise(r=>{finish=r;}));const selected=f.start();if(mode==='dispose')f.picker.dispose();else{f.stale();f.picker.mount(f.root as unknown as HTMLElement);}expect(await selected).toBeNull();finish(page());await tick();expect(f.picker.active()).toBe(false);
  });
});


describe('audit: invalidated file choices',()=>{
  it.each(['unavailable','failed','file-disabled'] as const)('retires a selected file after a %s reload',async mode=>{
    const f=fixture();const chosen=f.start();await tick();f.choice('one').fire('change');expect(f.action('verify').disabled).toBe(false);
    const next=page();if(next.action!=='file_authentication_files')throw new Error('Fixture');
    if(mode==='unavailable')next.choices={...next.choices,available:false,files:[],next_cursor:undefined,reason:'Remote file reads are disabled.'};
    if(mode==='file-disabled')next.choices={...next.choices,files:next.choices.files.map(file=>({...file,unavailable_reason:'No longer available.'}))};
    if(mode==='failed')f.call.mockRejectedValueOnce(new Error('not available'));else f.call.mockResolvedValueOnce(next);
    f.action('search').click();await tick();expect(f.action('verify').disabled).toBe(true);f.picker.cancel();expect(await chosen).toBeNull();
  });
  it('ignores detached choices and buttons from a replaced picker',async()=>{
    const f=fixture();const first=f.start();await tick();const oldChoice=f.choice('one');oldChoice.fire('change');const oldVerify=f.action('verify');
    f.call.mockResolvedValueOnce(page('other',3));let completed=false;
    const next=f.picker.choose('other',3,()=>true).then(value=>{completed=true;return value;});expect(await first).toBeNull();await tick();
    oldChoice.fire('change');expect(f.action('verify').disabled).toBe(true);expect(()=>oldVerify.click()).not.toThrow();await tick();expect(completed).toBe(false);
    f.action('metadata-only').click();expect(await next).toEqual({});
  });
});
