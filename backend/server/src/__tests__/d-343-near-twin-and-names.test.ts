/** D-343 (the owner's day over Telegram, 2026-11-14) — two things the day's audit found.
 *  - The model miscopied a pursuit's ~90-character id by one character; the identifier gate refused
 *    it (rightly) and the model spent two calls finding it again. The refusal now names the value it
 *    was shown that differs by a character or two, so the retry needs no lookup.
 *  - "Ticks off" named the record's words ("Did the Spanish lesson"); with the task's name on the
 *    ask, it names the task. */
import { describe, expect, it } from 'vitest';
import { episodeRecordTickOffs, tier1CallDetails } from '@recued/contracts';
import { ungroundedArgumentsDetail, ungroundedArgumentsInCall } from '../tool-argument-grounding.js';

const real = `asset-idempotent-${'3863663666306366'.repeat(4)}`;
const typo = `${real.slice(0, 30)}1${real.slice(31)}`;

describe('D-343 — a miscopied long id', () => {
  it('names the value it was shown, a character or two away', () => {
    const packet = JSON.stringify({ items: [{ title: 'Read more books', ref: { collection: 'asset', id: real } }] });
    const found = ungroundedArgumentsInCall({ records: [{ item: { collection: 'asset', id: typo } }] }, packet, { tool: 'episode.record', packet });
    expect(found).toEqual([expect.objectContaining({ path: 'records[0].item.id', why: 'ungrounded', near: real })]);
    expect(ungroundedArgumentsDetail(found)).toContain(`the evidence has ${JSON.stringify(real)}, a character or two from it; if that is the one, send it.`);
  });

  it('names none for a value far from any, or near two', () => {
    const far = `asset-idempotent-${'0'.repeat(64)}`;
    const packet = JSON.stringify({ a: real });
    expect(ungroundedArgumentsInCall({ id: far }, packet, { tool: 'work.read', packet })[0]?.near).toBeUndefined();
    const twin = `${real.slice(0, 40)}9${real.slice(41)}`;
    const two = JSON.stringify({ a: real, b: twin });
    const between = `${real.slice(0, 30)}1${real.slice(31, 40)}9${real.slice(41)}`;
    expect(ungroundedArgumentsInCall({ id: between }, two, { tool: 'work.read', packet: two })[0]?.near).toBeUndefined();
  });
});

describe('D-343 — "Ticks off" names the task', () => {
  const args = { day: '2026-11-15', records: [{ title: 'Did the Spanish lesson', outcome: 'done', item: { collection: 'task', id: 't1' } },
    { title: 'Went for a walk', outcome: 'done' }] };
  it('by its own name when the ask has it, else the owner\'s words', () => {
    expect(episodeRecordTickOffs(args, { item: { t1: 'Spanish lesson' } })).toEqual(['Spanish lesson']);
    expect(episodeRecordTickOffs(args)).toEqual(['Did the Spanish lesson']);
    expect(tier1CallDetails('episode.record', args, { item: { t1: 'Spanish lesson' } }).args).toMatchObject({ 'Ticks off': ['Spanish lesson'] });
  });
});
