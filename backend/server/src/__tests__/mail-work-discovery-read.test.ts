import { expect, it, vi } from 'vitest';
import type { ChatDispatchResult, ChatPriorToolCall } from '@recued/contracts';
import { createMailWorkDiscoveryReader, mailWorkDiscoveryQueries } from '../mail-work-discovery-read.js';

const search = (...ids: string[]): ChatDispatchResult => ({ ok: true, result: {
  collections: ['work'], matches: ids.map(record_id => ({ collection_slug: 'work', record_id })),
} });
const prior = (slug: string, record_id: string): ChatPriorToolCall => ({
  tool_name: 'mail.read', tier: 1, args: { slug, record_id }, status: 'ok', result: {}, started_at: 0, completed_at: 1,
});

it('starts bounded lexical searches from current anchors only, with no sender or date constraint', () => {
  const anchor = (record_id: string, subject: string): ChatPriorToolCall => ({ ...prior('work', record_id),
    result: { status: 'read', hot_fields: { subject } } });
  const calls = [anchor('one', 'Re: Fwd: Project-72 capacity request'), anchor('two', 'project 72 handover'),
    anchor('three', '續約 計劃'), anchor('four', 'A fourth subject'), anchor('unselected', 'Ignore this source')];
  expect(mailWorkDiscoveryQueries({ seeds: ['one', 'two', 'three', 'four'].map(record_id => ({ slug: 'work', record_id })) }, calls))
    .toEqual(['Project 72', '續約 計劃']);
  expect(mailWorkDiscoveryQueries({ seeds: [{ slug: 'elsewhere', record_id: 'one' }] }, calls)).toEqual([]);
});

it('does not derive discovery queries from failed reads, snippets, empty subjects or oversized terms', () => {
  const seeds = ['denied', 'snippet', 'empty', 'long'].map(record_id => ({ slug: 'work', record_id }));
  const calls: ChatPriorToolCall[] = [
    { ...prior('work', 'denied'), status: 'error', result: { status: 'read', hot_fields: { subject: 'Private project' } } },
    { ...prior('work', 'snippet'), tool_name: 'mail.search', result: { hot_fields: { subject: 'Search only' } } },
    { ...prior('work', 'empty'), result: { status: 'read', hot_fields: { subject: 'Re: !!!' } } },
    { ...prior('work', 'long'), result: { status: 'read', hot_fields: { subject: 'x'.repeat(1000) } } },
  ];
  expect(mailWorkDiscoveryQueries({ seeds }, calls)).toEqual([]);
});

it('reads unseen hits once across searches and rounds, bounded to four for the whole turn', async () => {
  const read = vi.fn(async () => {});
  const discover = createMailWorkDiscoveryReader();
  await discover([prior('work', 'seed'), prior('elsewhere', 'second')], [search('seed', 'second', 'second')], read);
  await discover([], [search('second', 'third', 'fourth', 'fifth', 'sixth')], read);
  await discover([], [search('seventh')], read);
  expect(read.mock.calls).toEqual(['second', 'third', 'fourth', 'fifth'].map(record_id => [{ slug: 'work', record_id }]));
});

it('does not manufacture reads from rejected searches, malformed matches or unlisted mailboxes', async () => {
  const read = vi.fn(async () => {});
  await createMailWorkDiscoveryReader()([], [
    { ok: false, reason: 'execution_error' },
    { ok: true, result: { matches: [{ collection_slug: 'work', record_id: 'unbound' }] } },
    { ok: true, result: { collections: ['work'], matches: [null, {},
      { collection_slug: 'elsewhere', record_id: 'hidden' }, { collection_slug: 'work', record_id: '' }] } },
    search('valid'),
  ], read);
  expect(read.mock.calls).toEqual([[{ slug: 'work', record_id: 'valid' }]]);
});

it('propagates cancellation and does not proceed to the next hit', async () => {
  const read = vi.fn(async () => { throw new Error('turn cancelled'); });
  await expect(createMailWorkDiscoveryReader()([], [search('first', 'second')], read)).rejects.toThrow('turn cancelled');
  expect(read).toHaveBeenCalledTimes(1);
});
