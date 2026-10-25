import { describe, expect, it } from 'vitest';
import { readCustomerRequestBoardState } from './customer-request-board-state.js';
const saved = {scope:'all',hash:'#reception/signoffs',search:'Morgan',state:'released',cursor:'page2',previous:[undefined,'page1'],scrollTop:412,expanded:['["request","actions"]'],returnId:'request',returnAction:'Open job'};
describe('request board navigation metadata',() => {
  it('restores only bounded metadata for the exact mounted view',() => {
    expect(readCustomerRequestBoardState(saved,'all','#reception/signoffs')).toEqual(saved);
    expect(readCustomerRequestBoardState(saved,'another','#reception/signoffs')).toBeUndefined();
    expect(readCustomerRequestBoardState(saved,'all','#reception/signoffs/new')).toBeUndefined();
  });
  it.each([{search:'x'.repeat(201)},{state:'invented'},{cursor:'x'.repeat(2049)},{previous:Array(101).fill('a')},{previous:[false]},{scrollTop:Infinity},{scrollTop:-1},{expanded:Array(101).fill('a')},{returnAction:'x'.repeat(513)}])('rejects malformed or unbounded history: %j',delta => {
    expect(readCustomerRequestBoardState({...saved,...delta},'all','#reception/signoffs')).toBeUndefined();
  });
  it('projects away draft terms and bearer data, even if injected into history',() => {
    expect(readCustomerRequestBoardState({...saved,scope_text:'private',share_url:'secret',display_name:'private'},'all','#reception/signoffs')).toEqual(saved);
  });
  it('keeps a deep request lookup separate from a later board search',() => {
    const deep = {...saved,scope:'request',hash:'#reception/signoffs/request',search:'',state:undefined,cursor:undefined,previous:[],signoffId:'request'};
    expect(readCustomerRequestBoardState(deep,'request',deep.hash)?.signoffId).toBe('request');
    expect(readCustomerRequestBoardState({...deep,search:'Morgan'},'request',deep.hash)).toBeUndefined();
    expect(readCustomerRequestBoardState({...deep,signoffId:undefined,search:'Morgan'},'request',deep.hash)?.signoffId).toBeUndefined();
  });
  it('restores completion navigation metadata without storing delivery terms or links',() => {
    const completion = { filter:'review',cursor:'50',previous:[undefined],expanded:['["completion","terms"]'],returnId:'completion',returnAction:'#reception/inbox/completion' };
    const value = {...saved,completion:{...completion,delivery_summary:'Private delivery',share_url:'secret'},returnBoard:'completions'};
    expect(readCustomerRequestBoardState(value,'all',saved.hash)).toEqual({...saved,completion,returnBoard:'completions'});
    expect(readCustomerRequestBoardState(value,'another',saved.hash)).toBeUndefined();
  });
  it.each([{filter:'unknown'},{cursor:'x'.repeat(2049)},{previous:Array(101).fill('a')},{previous:[null]},
    {expanded:Array(101).fill('a')},{expanded:['x'.repeat(257)]},{returnId:'x'.repeat(129)},{returnAction:'x'.repeat(513)}])('rejects unbounded completion navigation: %j',delta => {
    expect(readCustomerRequestBoardState({...saved,completion:{filter:'all',previous:[],expanded:[],...delta}},'all',saved.hash)).toBeUndefined();
  });
  it('rejects an unknown return board',() => {
    expect(readCustomerRequestBoardState({...saved,returnBoard:'secrets'},'all',saved.hash)).toBeUndefined();
  });
});
