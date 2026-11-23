import { describe, expect, it } from 'vitest';
import { taskNoteSource, workReaderLink } from '../task-note-source.js';
import { serializeShellRoute } from '../../shell/route.js';

const client = 'https://recued.test/client/?fixture=on#data/task/one';
describe('task-note source navigation', () => {
  it('resolves only the exact account and saved record, including encoded delimiters and Unicode', () => {
    const hash = '#data/mail/record/work%2Fone/mail%3F%E4%BA%8C';
    expect(taskNoteSource('https://recued.test/client/'+hash, client)).toEqual({ tab: 'mail', collectionSlug: 'work/one', recordId: 'mail?二', hash });
    expect(taskNoteSource('#data/calendar/record/home/cal%3Ahome%3Ashared-uid', client)).toEqual({ tab: 'calendar', collectionSlug: 'home', recordId: 'cal:home:shared-uid', hash: '#data/calendar/record/home/cal%3Ahome%3Ashared-uid' });
  });

  it('leaves other hosts, client paths, queries, credentials and ordinary routes to the browser', () => {
    const route = '#data/mail/record/work/message';
    for (const href of ['https://elsewhere.test/client/'+route, 'https://recued.test/another/'+route,
      'https://recued.test/client/?token=value'+route, 'https://owner:secret@recued.test/client/'+route,
      '#data/task/task-one', '#data/mail/message', '#data/files/record/work/file-one', '#data/calendar/record/work/event/return/chat/session/message']) {
      expect(taskNoteSource(href, client), href).toBeNull();
    }
  });

  it('rejects malformed, incomplete and control-bearing identities without guessing a fallback', () => {
    for (const href of ['#data/mail/record//message', '#data/mail/record/work/%ZZ', '#data/mail/record/work/%0a',
      '#data/mail/record/work/message/extra', '#data/calendar/record/work/', 'javascript:alert(1)', '#data/mail/record/wo\nrk/message']) {
      expect(taskNoteSource(href, client), href).toBeNull();
    }
  });
});

describe('reader record links', () => {
  it('keeps opaque contact, task and note identities in this deployment and preserves source links', () => {
    for (const tab of ['contact', 'task', 'note', 'commitment', 'project'] as const) {
      const id = "saved/二 ?#!'", hash = serializeShellRoute('data', tab, id);
      expect(workReaderLink('https://recued.test/client/'+hash, client)).toEqual({ tab, id, hash });
      expect(workReaderLink(hash, client)).toEqual({ tab, id, hash });
    }
    const href = '#data/mail/record/work/message';
    expect(workReaderLink(href, client)).toEqual(taskNoteSource(href, client));
  });

  it('does not claim external clients, unsafe URLs, editor routes, or malformed record identities', () => {
    const route = '#data/note/saved';
    for (const href of ['https://other.test/client/'+route, 'https://recued.test/elsewhere/'+route,
      'https://owner:secret@recued.test/client/'+route, 'https://recued.test/client/?token=secret'+route,
      'javascript:alert(1)', '#data/task/', '#data/task//one', '#data/note/one/edit', '#data/contact/one/extra',
      '#data/note/%ZZ', '#data/task/%0a', '#data/contact/%7f', '#data/note/%20', '#data/note/sa\nved',
      '#data/asset/one', '#data/files/record/work/one']) {
      expect(workReaderLink(href, client), href).toBeNull();
    }
  });
});
