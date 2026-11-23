import { expect,it } from 'vitest';
import type { PromptSchedule } from '@recued/contracts';
import { promptPausePreset } from '../prompt-pause-controls.js';
import { readPromptSchedules } from '../prompt-search.js';

it('chooses calendar dates on the prompt clock across DST and year boundaries',()=>{
  const now=Date.parse('2026-10-31T23:30Z');
  expect(promptPausePreset(1,now,'America/New_York')).toBe('2026-11-01T09:00');
  expect(promptPausePreset(7,now,'America/New_York')).toBe('2026-11-07T09:00');
  expect(promptPausePreset(1,now,'Asia/Tokyo')).toBe('2026-11-02T09:00');
  expect(promptPausePreset(7,Date.parse('2026-12-29T12:00Z'),'UTC')).toBe('2027-01-05T09:00');
});
it('accepts truthful timed-pause metadata and rejects contradictory capability or timing states',()=>{
  const saved:PromptSchedule={schedule_id:'prompt',session_id:'session',title:'Briefing',prompt:'Summarize the day.',mode:'recurring',time_zone:'UTC',cron_expression:'0 9 * * *',enabled:false,revision:2,created_at:1,next_run_at:null,last_run_at:null,last_turn_id:null,last_status:null,timed_pause:{until_at:100,first_run_at:200}};
  expect(readPromptSchedules([saved])[0]?.timed_pause).toEqual(saved.timed_pause);
  for(const patch of [{enabled:true},{timed_pause:{until_at:100,first_run_at:99}},{timed_pause:{until_at:NaN,first_run_at:200}},{mode:'one_shot',run_at:100,timed_pause:null}])
    expect(()=>readPromptSchedules([{...saved,...patch}])).toThrow('could not be confirmed');
  expect(readPromptSchedules([{...saved,timed_pause:undefined}])[0]?.timed_pause).toBeUndefined();
});
