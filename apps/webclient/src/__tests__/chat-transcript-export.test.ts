import { describe, expect, it } from 'vitest';
import { formatChatMarkdownExport } from '../chat/transcript-export.js';

const at = Date.UTC(2026, 9, 30, 19, 0);
const message = (id: string, content: string, extra: Record<string, unknown> = {}) => ({
  id, session_id: 'chat-1', role: 'assistant', content, ts: at, ...extra,
});
const bundle = (messages: unknown[]) => ({ session: { id: 'chat-1', title: 'Plan — café' }, messages, exported_at: at + 60_000, format: 'json' });
const options = { sessionId: 'chat-1', baseUrl: 'https://owner.example/app/?token=private#chat', locale: 'en-US', timeZone: 'UTC' };
const source = { kind: 'asset', id: `src_${'a'.repeat(24)}`, asset_id: 'sensor/1', label: 'Saved sensor', read_at: at - 1, read_version: 'b'.repeat(64) };

describe('readable conversation export', () => {
  it('formats the full snapshot in history order with literal code, source evidence and attachment names', () => {
    const partialSource = { ...source, id: `src_${'c'.repeat(24)}`, kind: 'asset_projection',
      label: 'Returned facts', projection: { kind: 'details' } };
    const boundedSource = { ...source, id: `src_${'d'.repeat(24)}`, kind: 'asset_projection',
      label: 'Related facts', projection: { kind: 'context', root: { kind: 'rule', rule_id: 'rule-1' } } };
    const result = formatChatMarkdownExport(bundle([
      message('b', `# Reading\n\n**Answer**\n\n## Steps\n1. First\n   - Nested\n\n[Sensor](#source/${source.id})\n\n\`\`\`js example\nconsole.log('<tag>');\n\`\`\``, {
        source_citations: [source, partialSource, boundedSource], attachments: [{ file_id: 'file:1', filename: 'quote — café.pdf' }],
      }),
      message('a', 'First question', { role: 'user' }),
      message('earliest', 'Oldest page', { role: 'user', ts: at - 1000 }),
    ]), options);
    expect(result).toContain('# Plan — café');
    expect(result.indexOf('Oldest page')).toBeLessThan(result.indexOf('First question'));
    expect(result.indexOf('First question')).toBeLessThan(result.indexOf('**Answer**'));
    expect(result).toMatch(/^### Reading$/mu);
    expect(result).toMatch(/^#### Steps$/mu);
    expect(result).toContain('1. First\n   - Nested');
    expect(result).toContain("```js\nconsole.log('<tag>');\n```");
    expect(result).toContain('[Sensor](<https://owner.example/app/#yours/asset/sensor%2F1>)');
    expect(result).toContain('### Sources\n\n- [Saved sensor]');
    expect(result).toContain('Read Oct 30, 2026');
    expect(result).toContain('Saved facts · Partial view · Read');
    expect(result).toContain('Relationships · Bounded view · Read');
    expect(result).toContain('quote — café.pdf');
    expect(result).toContain('records may have changed');
    expect(result).not.toContain('token=private');
  });

  it('keeps unsupported links and HTML literal and closes unfinished code before later messages', () => {
    const result = formatChatMarkdownExport(bundle([
      message('a', `<img src=x onerror=alert(1)>\n[outside](javascript:alert(1))\n![image](#source/${source.id})\n\n\`\`\`html\n<script>literal sample</script>`, { source_citations: [source, { href: 'https://untrusted.example' }] }),
      message('b', 'A later answer\n\n```js`invalid\nThis remains prose.'),
    ]), options);
    expect(result).toContain('&lt;img src=x onerror=alert(1)>');
    expect(result).toContain('\\[outside\\](javascript:alert(1))');
    expect(result).toContain('\\![image]');
    expect(result).toContain('```html\n<script>literal sample</script>\n```');
    expect(result).toContain('Some source details could not be resolved');
    expect(result).not.toContain('https://untrusted.example');
    expect(result).toMatch(/```\n\n### Sources[\s\S]+## Assistant[\s\S]+A later answer/u);
    expect(result).toContain('\\`\\`\\`js\\`invalid\nThis remains prose.');
  });

  it('retains recorded action outcomes and unavailable-file qualifications without exporting raw tool arguments', () => {
    const result = formatChatMarkdownExport(bundle([message('tool-1', 'The action is waiting.', {
      role: 'tool', tool_call: { message_id: 'tool-1', session_id: 'chat-1', turn_id: 'turn-1', tool_name: 'send-mail',
        state: 'held', started_at: at, updated_at: at, args: { password: 'not-in-the-transcript' } },
      attachments: [{ file_id: 'file:1', filename: 'old.txt', availability: 'missing', legacy_capture: true }],
    })]), options);
    expect(result).toContain('Recorded tool status: send-mail · held');
    expect(result).toContain('```text\nThe action is waiting.\n```');
    expect(result).toContain('old.txt · Unavailable · Original submitted version unverified');
    expect(result).not.toContain('not-in-the-transcript');
  });

  it('refuses malformed or mixed-session snapshots instead of returning a partial transcript', () => {
    const valid = message('a', 'Valid message');
    for (const invalid of [
      { ...bundle([valid]), session: { id: 'another-chat' } },
      bundle([valid, message('b', 'Wrong conversation', { session_id: 'another-chat' })]),
      bundle([valid, message('a', 'Duplicate row')]),
      bundle([valid, message('b', 'Missing text', { content: null })]),
      bundle([valid, message('b', 'Broken attachment', { attachments: [{}] })]),
      bundle([valid, message('b', 'Broken file status', { attachments: [{ file_id: 'file:1', availability: ['deleted'] }] })]),
    ]) expect(() => formatChatMarkdownExport(invalid, options)).toThrow('incomplete or unreadable');
  });
});
