import { describe, expect, it } from 'vitest';
import { FILE_DOWNLOAD_VERIFICATION_MAX_BYTES as max_bytes, isFileDownloadChoices, isFileDownloadVerification, isFileSourceAuthenticationPreview } from '../index.js';
const file={remote_id:'file-1',filename:'Report.pdf',output_filename:'Report.pdf',mime_type:'application/pdf',mode:'download' as const};
const choices=()=>({source_id:'google.work.file',connection_name:'work',updated_at:2,available:true,files:[file],max_bytes});
const proof=()=>({...file,review_id:'a'.repeat(64),status:'pending' as const,comparison:'same_bytes' as const,max_bytes});
describe('selected-file verification wire contract',()=>{
  it('accepts paged choices, unavailable responses and pending/verified proofs',()=>{
    expect(isFileDownloadChoices(choices())).toBe(true);expect(isFileDownloadChoices({...choices(),files:[],available:false,reason:'Unlock first'})).toBe(true);
    expect(isFileDownloadVerification(proof())).toBe(true);expect(isFileDownloadVerification({...proof(),mode:'export',comparison:'same_file_and_format',status:'verified'})).toBe(true);
  });
  it.each([{files:[file,file]},{files:Array.from({length:26},(_,i)=>({...file,remote_id:String(i)}))},{files:[{...file,remote_id:'x\n'}]},{files:[{...file,size_bytes:1.5}]},{max_bytes:max_bytes+1},{available:false},{updated_at:-1},{next_cursor:'\0'}])('rejects malformed file pages (%j)',change=>expect(isFileDownloadChoices({...choices(),...change})).toBe(false));
  it.each([{review_id:'guess'},{status:'unknown'},{mode:'export'},{comparison:'same_file_and_format'},{unavailable_reason:'unsupported'},{max_bytes:999},{filename:'\n'}])('rejects inconclusive or inconsistent proofs (%j)',change=>expect(isFileDownloadVerification({...proof(),...change})).toBe(false));
  it('requires the selected-file proof to agree with the parent review status',()=>{
    const parent={source_id:'google.work.file',connection_name:'work',provider:'google',expires_at:1000,current:{status:'known',account_id:'same'},file_count:1,selections:['Existing root'],status:'pending',download:proof()};
    expect(isFileSourceAuthenticationPreview(parent)).toBe(true);expect(isFileSourceAuthenticationPreview({...parent,status:'verified',target:parent.current})).toBe(false);
    expect(isFileSourceAuthenticationPreview({...parent,status:'verified',target:parent.current,download:{...proof(),status:'verified'}})).toBe(true);
  });
});
