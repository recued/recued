import { expect, it } from 'vitest';
import { savedTextUrls, savedWorkAddress, savedWorkLinks, savedWorkLinkMatches } from '../saved-work-links.js';

it('finds exact encoded and hash-relative ids with original UTF-16 offsets and explicit wrappers', () => {
  const body = '二🙂 [open](https://APP.test:443/client/#data/task/opaque%2F%E4%BA%8C%3F). Then \'#data/note/last!\'.';
  const links = savedWorkLinks(body);
  expect(links.map(({ kind, id, client }) => ({ kind, id, client }))).toEqual([
    { kind: 'task', id: 'opaque/二?', client: 'https://app.test/client/' }, { kind: 'note', id: 'last!', client: '' },
  ]);
  for (const link of links) expect(body.slice(link.start, link.end)).toBe(link.href);
  expect(savedTextUrls('See https://external.test/a(b)).')).toEqual([{ href: 'https://external.test/a(b)', start: 4, end: 30 }]);
});

it('never guesses punctuation or treats an external deployment or another kind as the target', () => {
  const target = savedWorkAddress('https://app.test/client/#data/note/id!')!;
  const links = savedWorkLinks('https://app.test/client/#data/note/id!. #data/note/id! https://other.test/client/#data/note/id! https://app.test/other/#data/note/id! #data/task/id!');
  expect(links.filter(link => savedWorkLinkMatches(link, target)).map(link => link.href)).toEqual(['#data/note/id!']);
});

it('rejects ambiguous, malformed and non-reader URLs rather than indexing a nearby identity', () => {
  for (const href of ['https://app.test/?pairing=secret#data/task/id', 'https://u:p@app.test/#data/task/id',
    'file:///app/#data/task/id', '/other/#data/task/id', '#data/task/id/extra', '#data/task/%', '#data/task/%00',
    '#data/note/%20', '#data/note/edit/id', '#data/contact/%', '#data/task/a\nb']) expect(savedWorkAddress(href), href).toBeNull();
  expect(savedWorkLinks('https://u:p@app.test/#data/task/id https://app.test/?secret#data/task/id')).toEqual([]);
});

it('indexes contact identities and normalizes email references without changing saved text offsets', () => {
  const body = 'Contact #data/contact/Person%2F%E4%BA%8C and https://app.test/client/#data/contact/RILEY%40Example.TEST';
  const links = savedWorkLinks(body);
  expect(links.map(({ kind, id }) => ({ kind, id }))).toEqual([{ kind: 'contact', id: 'Person/二' }, { kind: 'contact', id: 'riley@example.test' }]);
  for (const link of links) expect(body.slice(link.start, link.end)).toBe(link.href);
  expect(savedWorkLinkMatches(links[1]!, savedWorkAddress('https://app.test/client/#data/contact/riley%40example.test')!)).toBe(true);
});

it('matches source records by exact platform, account, occurrence and deployment', () => {
  for (const kind of ['mail', 'calendar']) {
    const url = 'https://app.test/client/#data/' + kind + '/record/Work%2F%E4%BA%8C/shared%2Foccurrence%3F';
    const target = savedWorkAddress(url)!;
    expect(target).toMatchObject({ kind, collection_slug: 'Work/二', id: 'shared/occurrence?' });
    const body = '[source](' + url + '). #data/' + kind + '/record/Work%2F%E4%BA%8C/shared%2Foccurrence%3F';
    const links = savedWorkLinks(body);
    expect(links.filter(link => savedWorkLinkMatches(link, target))).toHaveLength(2);
    for (const link of links) expect(body.slice(link.start, link.end)).toBe(link.href);
    for (const other of [url.replace('Work%2F', 'work%2F'), url.replace('shared%2F', 'different%2F'), url.replace('app.test', 'else.test'), url.replace('/client/', '/else/'), url + '/extra', url + '/return/chat/session/message']) {
      const link = savedWorkAddress(other); expect(link && savedWorkLinkMatches(link, target)).toBeFalsy();
    }
  }
  for (const url of ['#data/mail/shared', '#data/calendar/record/work/%', '#data/mail/record/%20/id', '#data/mail/record/work/id/return/logs/run']) expect(savedWorkAddress(url)).toBeNull();
});
