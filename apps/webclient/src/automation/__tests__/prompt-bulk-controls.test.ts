import { expect,it } from 'vitest';
import { readPromptBulkRequest,readPromptBulkResult } from '../prompt-bulk-controls.js';

const request={request_id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',action:{kind:'pause' as const},items:[{schedule_id:'one',review_token:'a'.repeat(64)},{schedule_id:'two',review_token:'b'.repeat(64)}]};
it('copies the original bounded review and rejects duplicate, malformed or incomplete recovery requests',()=>{
  const read=readPromptBulkRequest(request);expect(read).toEqual(request);read.items[0]!.review_token='c'.repeat(64);expect(request.items[0]!.review_token).toBe('a'.repeat(64));
  for(const raw of [null,{...request,items:[]},{...request,items:[request.items[0],request.items[0]]},{...request,items:[{schedule_id:'one',review_token:'bad'}]},{...request,action:{kind:'remove'}},{...request,action:{kind:'pause_until',local_time:'tomorrow'}}])expect(()=>readPromptBulkRequest(raw)).toThrow('could not be read');
});
it('requires one confirmed result per submitted prompt before retiring an uncertain change',()=>{
  const response={items:[{schedule_id:'one',status:'applied',message:'Paused.'},{schedule_id:'two',status:'failed',message:'Retry the original request.'}]};
  expect(readPromptBulkResult(response,['one','two'])).toEqual(response);
  for(const raw of [null,{items:[]},{items:[response.items[0],response.items[0]]},{items:[response.items[0],{...response.items[1],schedule_id:'outside'}]},{items:[response.items[0],{...response.items[1],status:'finished'}]}])expect(()=>readPromptBulkResult(raw,['one','two'])).toThrow('could not be confirmed');
});
