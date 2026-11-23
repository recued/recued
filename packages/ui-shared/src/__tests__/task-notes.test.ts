import { describe, expect, it } from 'vitest';
import { renderTaskNotes } from '../work-entity-page/task-notes.js';

describe('links in saved task notes', () => {
  it('links exact qualified addresses while keeping markup and the surrounding text literal', () => {
    const url = 'https://recued.test/client/#data/mail/record/work%2Fone/mail%3F%E4%BA%8C';
    const html = renderTaskNotes(`Email: ${url}\n<script>bad()</script>\nNotes stay **plain**.`);
    expect(html).toContain(`href="${url}"`); expect(html).toContain(`>${url}</a>\n&lt;script&gt;bad()&lt;/script&gt;`);
    expect(html).toContain('Notes stay **plain**.'); expect(html).not.toMatch(/<script|<strong/);
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('preserves URL query text, balanced brackets and punctuation outside a link', () => {
    const html = renderTaskNotes('(https://example.test/path_(one)?a=1&b=2). Next https://example.test/end!');
    expect(html).toContain('href="https://example.test/path_(one)?a=1&amp;b=2"');
    expect(html).toContain('b=2</a>). Next '); expect(html).toContain('href="https://example.test/end"'); expect(html).toMatch(/end<\/a>!$/);
  });

  it('supports relative exact source links and leaves unsupported schemes as text', () => {
    const html = renderTaskNotes('#data/calendar/record/work/event%2Fone javascript:alert(1) data:text/html,bad ftp://example.test/file');
    expect(html.match(/<a /g)).toHaveLength(1); expect(html).toContain('href="#data/calendar/record/work/event%2Fone"');
    expect(html).toContain('javascript:alert(1) data:text/html,bad ftp://example.test/file');
  });

  it('escapes link attributes and rejects malformed HTTP URLs without losing text', () => {
    const html = renderTaskNotes('https://example.test/?q=<img src=x> https://[broken **literal**');
    expect(html).toContain('href="https://example.test/?q="'); expect(html).toContain('&lt;img src=x&gt;');
    expect(html).toContain('https://[broken **literal**'); expect(html.match(/<a /g)).toHaveLength(1);
  });
});

it('preserves punctuation inside qualified record identities, including links wrapped in parentheses', () => {
  const source = "https://recued.test/#data/mail/record/work/message.)!'*";
  const attribute = 'href="https://recued.test/#data/mail/record/work/message.)!&#39;*"';
  expect(renderTaskNotes('Email: '+source)).toContain(attribute);
  expect(renderTaskNotes('Context ('+source+').')).toContain(attribute);
  expect(renderTaskNotes('Context ('+source+').')).toMatch(/<\/a>\)\.$/u);
});

it('links copied contact, task and note addresses in both plain readers without trimming opaque identity punctuation', () => {
  for (const reader of ['task', 'note'] as const) for (const kind of ['contact', 'task', 'note'] as const) {
    const url = `https://recued.test/client/#data/${kind}/opaque%2F%E4%BA%8C.!`;
    expect(renderTaskNotes(url, reader)).toContain(`href="${url}"`);
    const wrapped = renderTaskNotes(`Reference (${url}). <img src=x>`, reader);
    expect(wrapped).toContain(`href="${url}"`); expect(wrapped).toContain('</a>). &lt;img src=x&gt;');
  }
});

it('links relative saved-record references in plain Notes and keeps ordinary external text unchanged', () => {
  const body = '#data/contact/person #data/task/task-one #data/note/note-one https://example.test/context javascript:alert(1)';
  const html = renderTaskNotes(body, 'note');
  expect(html.match(/data-note-note-link=/gu)).toHaveLength(3);
  for (const hash of ['#data/contact/person', '#data/task/task-one', '#data/note/note-one']) expect(html).toContain(`href="${hash}"`);
  expect(html).toContain(' https://example.test/context javascript:alert(1)'); expect(html).not.toContain('href="https://example.test');
});
