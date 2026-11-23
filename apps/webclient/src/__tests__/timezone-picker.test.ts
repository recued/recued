import { expect,it } from 'vitest';
import { timezoneCatalog,searchTimezones,timezoneLocalTime } from '../timezone-picker.js';

it('finds cities with spaces, full IDs and multiple case-insensitive terms without inventing abbreviation mappings',()=>{
  const zones=['America/New_York','America/Los_Angeles','Europe/London','Asia/Tokyo'];
  expect(searchTimezones(zones,'new york')).toEqual(['America/New_York']);
  expect(searchTimezones(zones,'AMERICA/NEW_YORK')).toEqual(['America/New_York']);
  expect(searchTimezones(zones,'america angeles')).toEqual(['America/Los_Angeles']);
  expect(searchTimezones(zones,'PST')).toEqual([]);expect(searchTimezones(zones,'unknown city')).toEqual([]);
});
it('preserves exact saved aliases and unknown retained values alongside the browser catalog',()=>{
  const zones=timezoneCatalog(['US/Eastern','Moon/Base','  Asia/Tokyo  '],()=>['America/New_York','Asia/Tokyo','America/New_York']);
  expect(zones).toContain('US/Eastern');expect(zones).toContain('Moon/Base');expect(zones).toContain('  Asia/Tokyo  ');expect(zones.filter(zone=>zone==='America/New_York')).toHaveLength(1);
  expect(searchTimezones(zones,'eastern')[0]).toBe('US/Eastern');expect(timezoneLocalTime('Moon/Base',0)).toBeNull();
});
it('offers UTC, common cities and exact retained zones when browser enumeration is unavailable',()=>{
  const zones=timezoneCatalog(['US/Pacific'],()=>{throw Error('Not implemented');});
  for(const zone of ['UTC','Asia/Tokyo','America/New_York','US/Pacific'])expect(zones).toContain(zone);
  expect(searchTimezones(zones,'los angeles')).toContain('America/Los_Angeles');
});
it('keeps accepted city aliases searchable when enumeration returns an older canonical spelling',()=>{
  const zones=timezoneCatalog([],()=>['Asia/Calcutta','Europe/Kiev']);
  expect(searchTimezones(zones,'kolkata')).toContain('Asia/Kolkata');expect(searchTimezones(zones,'kyiv')).toContain('Europe/Kyiv');
});
it('uses the offset at the sampled instant and does not replace unknown clocks with UTC',()=>{
  expect(timezoneLocalTime('America/New_York',Date.parse('2026-06-15T20:00Z'),'en-US')).toContain('GMT-4');
  expect(timezoneLocalTime('America/New_York',Date.parse('2026-12-15T20:00Z'),'en-US')).toContain('GMT-5');
  expect(timezoneLocalTime('UTC',Date.parse('2026-12-15T20:00Z'),'en-US')).toContain('GMT');
  expect(timezoneLocalTime('Unknown/Zone',Date.now())).toBeNull();expect(timezoneLocalTime('UTC',NaN)).toBeNull();
});
