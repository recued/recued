import { expect,it } from 'vitest';
import type { PromptScheduleRunsPage } from '@recued/contracts';
import { readPromptRunsPage } from '../prompt-runs-view.js';

const target={schedule_id:'schedule',session_id:'conversation'};
const page=():PromptScheduleRunsPage=>({...target,runs:[{occurrence_id:'run-1',turn_id:'turn-1',revision:1,trigger:'scheduled',
  due_at:1,queued_at:2,time_zone:'America/New_York',outcome:{status:'needs_approval',plan_id:'approval-1',message_id:'answer-1'}}],next_cursor:null});
it('retains exact run and approval references without sharing mutable response objects',()=>{
  const source=page(),read=readPromptRunsPage(source,target);expect(read).toEqual(source);source.runs[0]!.outcome.plan_id='changed';
  expect(read.runs[0]?.outcome.plan_id).toBe('approval-1');
});
it('rejects wrong targets, duplicate runs, malformed timestamps/outcomes and incomplete cursor pages',()=>{
  const source=page();
  const bad:unknown[]=[null,{...source,schedule_id:'other'},{...source,session_id:'other'}, {...source,runs:[source.runs[0],source.runs[0]]},
    {...source,runs:[{...source.runs[0],due_at:NaN}]},{...source,runs:[{...source.runs[0],time_zone:'Not/AZone'}]},
    {...source,runs:[{...source.runs[0],outcome:{status:'invented'}}]}, {...source,runs:[{...source.runs[0],revision:0}]},
    {...source,next_cursor:'cursor'}, {...source,next_cursor:'x'.repeat(1025)}];
  for(const value of bad)expect(()=>readPromptRunsPage(value,target)).toThrow('could not be confirmed');
});
