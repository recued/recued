import { describe, expect, it, vi } from 'vitest';
import { FILE_DOWNLOAD_VERIFICATION_MAX_BYTES, RpcError, type FileMetaProjection, type FileSourceOAuthProvider } from '@recued/contracts';
import { fileDownloadChoice, verifyFileSourceDownload } from '../file-download-verification.js';
import type { FileConnectionCredential, FileFetch } from '../file-source-adapters/index.js';

const origins = { google:'https://www.googleapis.com', onedrive:'https://graph.microsoft.com', sharepoint:'https://graph.microsoft.com', box:'https://api.box.com', dropbox:'https://api.dropboxapi.com' };
const pdf = Buffer.from('%PDF-1.7 chosen file');
const response = (data: Uint8Array = pdf, headers: HeadersInit = {'Content-Type':'application/pdf'}) => new Response(new Uint8Array(data),{headers});
const fixture = (provider:FileSourceOAuthProvider='google', managed=false) => {
  const meta:FileMetaProjection = {provider,remote_id:'chosen/id',filename:'Chosen.pdf',mime_type:'application/pdf',size:pdf.length,revision:'revision-1'};
  let reply:()=>Promise<Response>|Response=()=>response(); let anonymous=401;
  const direct=vi.fn<FileFetch>(async (url,init)=> {
    if(new URL(url).origin===origins[provider] || new URL(url).origin==='https://content.dropboxapi.com') {
      return new Headers(init.headers).has('authorization') ? reply() : new Response(null,{status:anonymous});
    }
    return reply();
  });
  const managedFetch=vi.fn<FileFetch>(async()=>reply());
  const cred:FileConnectionCredential={config:provider==='sharepoint'?{drive_id:'chosen library'}:{},
    auth:managed?{type:'managed_oauth',broker_profile_id:'profile',integration_id:provider,connection_id:'account',target_origin:origins[provider],requested_scopes:[]}
      :{type:'bearer',token:'vendor-secret'},...(managed?{managedFetch}:{})};
  const active=vi.fn(async()=>{});
  const check=(expected?:Awaited<ReturnType<typeof verifyFileSourceDownload>>)=>verifyFileSourceDownload({provider,meta,cred,direct,assertActive:active,...(expected?{expected}:{})});
  return {meta,cred,direct,managedFetch,active,check,set:(next:typeof reply)=>{reply=next;},anonymous:(status:number)=>{anonymous=status;}};
};
// Real uncompressed ZIP fixtures; the verifier checks directory and package parts without extraction.
const officeZip=(part:string,comment=''):Buffer=> {
  const bodies:Buffer[]=[]; const directory:Buffer[]=[]; let offset=0;
  for(const name of ['[Content_Types].xml','_rels/.rels',part]) {
    const filename=Buffer.from(name); const body=Buffer.from('<xml/>'); let crc=0xffffffff;
    for(const b of body){crc^=b;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
    crc=(crc^0xffffffff)>>>0;
    const local=Buffer.alloc(30); local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt32LE(crc,14);local.writeUInt32LE(body.length,18);local.writeUInt32LE(body.length,22);local.writeUInt16LE(filename.length,26);
    const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt32LE(crc,16);central.writeUInt32LE(body.length,20);central.writeUInt32LE(body.length,24);central.writeUInt16LE(filename.length,28);central.writeUInt32LE(offset,42);
    bodies.push(local,filename,body);directory.push(central,filename);offset+=local.length+filename.length+body.length;
  }
  const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(3,8);end.writeUInt16LE(3,10);end.writeUInt32LE(Buffer.concat(directory).length,12);end.writeUInt32LE(offset,16);end.writeUInt16LE(Buffer.byteLength(comment),20);
  return Buffer.concat([...bodies,...directory,end,Buffer.from(comment)]);
};

describe('selected-file verification through production download resolvers',()=> {
  it.each((['google','onedrive','sharepoint','box','dropbox'] as const).flatMap(p=>[false,true].map(m=>[p,m] as const)))('reads only the chosen %s file using managed=%s',async(provider,managed)=>{
    const f=fixture(provider,managed);const proof=await f.check();expect(proof.choice).toMatchObject({remote_id:'chosen/id',mode:'download'});
    expect(f.direct).toHaveBeenCalledTimes(managed?1:2);expect(f.managedFetch).toHaveBeenCalledTimes(managed?1:0);
    const calls=managed?f.managedFetch.mock.calls:f.direct.mock.calls.slice(1);
    const [url,init]=calls[0]!;const u=new URL(url);
    if(provider==='google'){expect(u.pathname).toBe('/drive/v3/files/chosen%2Fid');expect(u.searchParams.get('alt')).toBe('media');}
    else if(provider==='dropbox'){expect(u.origin+u.pathname).toBe('https://content.dropboxapi.com/2/files/download');expect(init.method).toBe('POST');expect(JSON.parse(new Headers(init.headers).get('Dropbox-API-Arg')!)).toEqual({path:'chosen/id'});}
    else expect(u.pathname).toBe(provider==='box'?'/2.0/files/chosen%2Fid/content':provider==='sharepoint'?'/v1.0/drives/chosen%20library/items/chosen%2Fid/content':'/v1.0/me/drive/items/chosen%2Fid/content');
    expect(init.redirect).toBe('manual');expect(init.body).toBeUndefined();expect(new Headers(f.direct.mock.calls[0]![1].headers).has('authorization')).toBe(false);
    expect(f.active.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
  it('requires equal bytes and unchanged file metadata for ordinary downloads',async()=>{
    const f=fixture();const first=await f.check();expect((await f.check(first)).digest).toBe(first.digest);
    f.set(()=>response(Buffer.from('%PDF-1.7 other  file')));await expect(f.check(first)).rejects.toThrow(/bytes differ/);
    f.meta.revision='revision-2';f.direct.mockClear();await expect(f.check(first)).rejects.toThrow('file changed');expect(f.direct).not.toHaveBeenCalled();
  });
  it.each([
    ['document','word/document.xml','application/vnd.openxmlformats-officedocument.wordprocessingml.document','.docx'],
    ['spreadsheet','xl/workbook.xml','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.xlsx'],
    ['presentation','ppt/presentation.xml','application/vnd.openxmlformats-officedocument.presentationml.presentation','.pptx'],
  ])('exports Google %s using its normal portable format',async(kind,part,mime,ext)=>{
    const f=fixture('google',true);f.meta.mime_type='application/vnd.google-apps.'+kind;f.meta.size=999999999;f.meta.filename='Native document';
    f.set(()=>response(officeZip(part!),{'Content-Type':mime!}));const first=await f.check();
    expect(first.choice).toMatchObject({mode:'export',output_filename:'Native document'+ext,mime_type:mime});
    const u=new URL(f.managedFetch.mock.calls[0]![0]);expect(u.pathname).toBe('/drive/v3/files/chosen%2Fid/export');expect(u.searchParams.get('mimeType')).toBe(mime);
    f.set(()=>response(officeZip(part!,'different ZIP container'),{'Content-Type':mime!}));expect((await f.check(first)).digest).not.toBe(first.digest);
    f.set(()=>response(officeZip('wrong/part.xml'),{'Content-Type':mime!}));await expect(f.check(first)).rejects.toThrow('Office export package');
    f.set(()=>response(Buffer.from('<html>not an export</html>'),{'Content-Type':mime!}));await expect(f.check()).rejects.toThrow('Office export package');
  });
  it('refuses malformed ZIP directory offsets and local header mismatches',async()=>{
    const f=fixture();f.meta.mime_type='application/vnd.google-apps.document';
    const mime='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const data=officeZip('word/document.xml');data.writeUInt16LE(8,8);f.set(()=>response(data,{'Content-Type':mime}));await expect(f.check()).rejects.toThrow('Office export package');
    f.set(()=>response(officeZip('word/document.xml').subarray(0,-1),{'Content-Type':mime}));await expect(f.check()).rejects.toThrow('Office export package');
  });
  it('disables unsupported exports and oversized original files before network access',async()=>{
    const f=fixture();f.meta.mime_type='application/vnd.google-apps.form';await expect(f.check()).rejects.toThrow('cannot be exported');expect(f.direct).not.toHaveBeenCalled();
    f.meta.mime_type='application/pdf';f.meta.size=FILE_DOWNLOAD_VERIFICATION_MAX_BYTES+1;await expect(f.check()).rejects.toThrow('10 MiB');expect(f.direct).not.toHaveBeenCalled();
    expect(fileDownloadChoice({...f.meta,filename:'\n\t'}).filename).toBe('File');
  });
  it.each([200,302,404,500])('refuses an unprotected or inconclusive anonymous download control (%s)',async status=>{
    const f=fixture();f.anonymous(status);await expect(f.check()).rejects.toThrow('protected file');expect(f.direct).toHaveBeenCalledTimes(1);
  });
  it.each([401,403,404,429,500])('sanitizes download failure %s',async status=>{
    const f=fixture();f.set(()=>new Response('secret-vendor-body signed-url.example',{status}));const error=await f.check().catch((e:unknown)=>e);
    expect(error).toMatchObject({code:'credential_verification_failed',details:{reason:'file_download_access_unconfirmed',existing_credential_preserved:true}});expect(JSON.stringify(error)).not.toMatch(/vendor-secret|secret-vendor-body|signed-url/);
  });
  it.each([()=>new Response(pdf,{status:206}),()=>response(pdf,{'Content-Range':'bytes 0-9/100'}),()=>response(pdf,{'Content-Length':'3'}),()=>response(pdf,{'Content-Length':'1e2'}),()=>response(pdf,{'Content-Type':'text/html'})])('refuses partial, truncated or wrong-format responses',async make=>{
    const f=fixture();f.set(make);await expect(f.check()).rejects.toMatchObject({code:'credential_verification_failed'});
  });
  it.each([false,true])('caps a streamed body with declared-length=%s',async declared=>{
    const f=fixture();delete f.meta.size;const cancel=vi.fn();f.set(()=>new Response(new ReadableStream<Uint8Array>({pull(c){c.enqueue(new Uint8Array(1024*1024));},cancel}),{headers:declared?{'Content-Length':String(FILE_DOWNLOAD_VERIFICATION_MAX_BYTES+1)}:{}}));
    await expect(f.check()).rejects.toThrow('10 MiB');expect(cancel).toHaveBeenCalled();
  });
  it.each(['google','box','onedrive','sharepoint','dropbox'] as const)('follows %s signed redirects without forwarding authentication',async provider=>{
    const f=fixture(provider,true);const host=provider==='google'?'files.googleusercontent.com':provider==='box'?'dl.boxcloud.com':provider==='dropbox'?'dl.dropboxusercontent.com':provider==='onedrive'?'public.dm.files.1drv.com':'tenant.sharepoint.com';
    f.set(()=>response());f.managedFetch.mockImplementation(async()=>new Response(null,{status:302,headers:{Location:'https://'+host+'/signed?secret=opaque'}}));
    await f.check();expect(f.managedFetch).toHaveBeenCalledTimes(1);expect(f.direct).toHaveBeenCalledTimes(2);
    const [url,init]=f.direct.mock.calls[1]!;expect(new URL(url).host).toBe(host);expect(new Headers(init.headers).has('authorization')).toBe(false);expect(new Headers(init.headers).has('cookie')).toBe(false);expect(init.method).toBe('GET');
  });
  it.each(['https://evil.invalid/leak','https://dl.boxcloud.com.evil.invalid/file','http://dl.boxcloud.com/file','https://user:pass@dl.boxcloud.com/file','https://dl.boxcloud.com:444/file'])('refuses unsafe redirect %s without following it',async location=>{
    const f=fixture('box');f.set(()=>new Response(null,{status:302,headers:{Location:location}}));await expect(f.check()).rejects.toThrow('outside');expect(f.direct).toHaveBeenCalledTimes(2);
  });
  it('bounds redirect loops',async()=>{
    const f=fixture();f.set(()=>new Response(null,{status:302,headers:{Location:'/drive/v3/files/chosen%2Fid?alt=media'}}));await expect(f.check()).rejects.toThrow('redirect');expect(f.direct.mock.calls.length).toBeLessThanOrEqual(8);
  });
  it('caps decoded bytes without confusing a compressed wire length with file size',async()=>{
    const f=fixture();f.set(()=>response(pdf,{'Content-Type':'application/pdf','Content-Encoding':'gzip','Content-Length':'3'}));
    expect((await f.check()).choice.remote_id).toBe('chosen/id');
  });
  it('stops waiting for an ignored transport abort and cancels its late body',async()=>{
    const f=fixture();let release!:(v:Response)=>void;f.set(()=>new Promise<Response>(r=>{release=r;}));const controller=new AbortController();const timeout=vi.spyOn(AbortSignal,'timeout').mockReturnValue(controller.signal);
    try{const checking=f.check();const rejection=expect(checking).rejects.toThrow('timed out');await vi.waitFor(()=>expect(release).toBeDefined());controller.abort();await rejection;const cancel=vi.fn();release(new Response(new ReadableStream({cancel})));await vi.waitFor(()=>expect(cancel).toHaveBeenCalled());}finally{timeout.mockRestore();}
  });
  it('propagates the background job cancellation into an in-flight download',async()=>{
    const f=fixture();let release!:(value:Response)=>void;f.set(()=>new Promise<Response>(resolve=>{release=resolve;}));const controller=new AbortController();
    const checking=verifyFileSourceDownload({provider:'google',meta:f.meta,cred:f.cred,direct:f.direct,assertActive:f.active,signal:controller.signal});
    const rejected=expect(checking).rejects.toThrow('timed out');await vi.waitFor(()=>expect(release).toBeDefined());controller.abort();await rejected;
    const cancel=vi.fn();release(new Response(new ReadableStream({cancel})));await vi.waitFor(()=>expect(cancel).toHaveBeenCalled());
    expect(f.direct.mock.calls[1]![1].signal?.aborted).toBe(true);
  });
  it('stops a body read that ignores cancellation',async()=>{
    const f=fixture();const cancel=vi.fn();f.set(()=>new Response(new ReadableStream({pull:()=>new Promise(()=>{}),cancel})));const controller=new AbortController();const timeout=vi.spyOn(AbortSignal,'timeout').mockReturnValue(controller.signal);
    try{const checking=f.check();const rejection=expect(checking).rejects.toThrow('timed out');await vi.waitFor(()=>expect(f.direct).toHaveBeenCalledTimes(2));controller.abort();await rejection;await vi.waitFor(()=>expect(cancel).toHaveBeenCalled());}finally{timeout.mockRestore();}
  });
  it('honors vault/capability/source guards before fetching and after the read',async()=>{
    const f=fixture();f.active.mockRejectedValueOnce(new Error('private-vault-secret'));await expect(f.check()).rejects.toMatchObject({code:'credential_verification_failed'});expect(f.direct).not.toHaveBeenCalled();
    f.active.mockImplementation(async()=>{if(f.active.mock.calls.length>=4)throw new RpcError('conflict','Source changed');});await expect(f.check()).rejects.toMatchObject({code:'conflict'});
  });
});
