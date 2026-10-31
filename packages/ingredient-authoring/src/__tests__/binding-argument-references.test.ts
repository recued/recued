import { describe, expect, it } from 'vitest';
import { bindingArgumentTokens, bindingArgumentTokenAt, operationBindingArgumentReferences, assertBindingArgumentRename } from '../binding-argument-references.js';

describe('binding argument interpretation', () => {
  it('uses the runtime REST and CLI grammars and locates only the decoded argument name', () => {
    const rest = '/tasks/{{ task_id }}/{{query.status}}', cli = '--file={source.path}-{part-id}';
    for (const [value,syntax] of [[rest,'rest'],[cli,'cli']] as const) for (const token of bindingArgumentTokens(value,syntax)) expect(value.slice(token.start,token.end)).toBe(token.key);
    expect(bindingArgumentTokens(rest,'rest').map(row => row.key)).toEqual(['task_id','query.status']); expect(bindingArgumentTokens(cli,'cli').map(row => row.key)).toEqual(['source.path','part-id']);
    expect(bindingArgumentTokenAt('/tasks/{{ta','rest',11)).toMatchObject({key:'ta',suffix:'}}'}); expect(bindingArgumentTokenAt('{so','cli',3)).toMatchObject({key:'so',suffix:'}'});
    expect(bindingArgumentTokenAt('{ta ','cli',4)).toBeUndefined();
  });
  it('visits only schema-owned fields and distinguishes a binding-owned output location from caller arguments', () => {
    const row = {op:'run',ingredient:'tool',args:['source'],editable_args:[{key:'source',type:'text'}],record_id_arg:'source',bind:{kind:'cli_invocation',argv_template:['tool','{source}','{output_dir}',{expand_arg:'files'}],cwd:{arg:'{source}'},input_materialize:{kind:'file_ref',arg:'source'},output_capture:{dir_arg:'output_dir',mime_type:'text/plain'},exit_code_handling:'zero_is_success'}};
    const result = operationBindingArgumentReferences(row); expect(result.complete).toBe(true); expect(result.engineKeys).toEqual(['output_dir']); expect(result.references.filter(site => site.engine)).toHaveLength(2);
    expect(result.references.some(site => site.path.at(-1) === 'expand_arg' && site.key === 'files')).toBe(true);
    expect(() => assertBindingArgumentRename(row,'source','input')).not.toThrow(); expect(() => assertBindingArgumentRename(row,'source','output_dir')).toThrow('Engine-owned');
    const opaque = operationBindingArgumentReferences({...row,bind:{kind:'rest',method:'GET',path_template:'/items/{{source}}',static_body:{literal:'{{source}}'}}}); expect(opaque.references.filter(site => site.path[0] === 'bind')).toHaveLength(1);
  });
  it('refuses rename for unsupported schemas, metadata, transport keys, nested paths and partial reference discovery', () => {
    const row = {op:'read',ingredient:'api',args:['id'],bind:{kind:'rest',method:'GET',path_template:'/items/{{id}}'}};
    for (const extra of [{request_schema:{}},{authority_args:['id']},{path_scope:{target_path_template:'{{id}}'}}]) expect(() => assertBindingArgumentRename({...row,...extra},'id','item_id')).toThrow('explicit reference support');
    expect(() => assertBindingArgumentRename({...row,bind:{kind:'graphql',query:'query($id:ID!){item(id:$id)}'}},'id','item_id')).toThrow('REST paths');
    expect(() => assertBindingArgumentRename(row,'query.id','item_id')).toThrow('transport');
    expect(() => assertBindingArgumentRename({...row,bind:{kind:'cli_invocation',argv_template:['tool','{id.child}'],exit_code_handling:'zero_is_success'}},'id','item_id')).toThrow('Nested');
    const many = {...row,bind:{...row.bind,path_template:'{{id}}'.repeat(5001)}}; expect(operationBindingArgumentReferences(many).complete).toBe(false); expect(() => assertBindingArgumentRename(many,'id','item_id')).toThrow('5,000');
  });
});
