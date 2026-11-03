/** Readable downloads of the server's full conversation export. No extra reads. */
import { chatSourceCitationsOf, isChatMessageRole, isChatToolCallRecord, type ChatMessageRole } from '@recued/contracts';
import { formatClientDateTime, type ClientDateTimeOptions } from '@recued/ui-shared';
import { answerTextSegments, type AnswerTextSegment } from './answer-text.js';
import { sourceCitationHref } from './source-citations.js';

export type ChatExportFormat = 'json' | 'markdown';

interface ExportMessage {
  id: string;
  role: ChatMessageRole;
  content: string;
  ts: number;
  attachments: Array<{ file_id: string; filename?: string; availability?: string; legacy_capture?: boolean }>;
  sources: ReturnType<typeof chatSourceCitationsOf>;
  unresolvedSources: boolean;
  toolCall?: unknown;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const instant = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 8_640_000_000_000_000;
const invalidExport = (): never => { throw new Error('The conversation export is incomplete or unreadable. Refresh Chat and try again.'); };
const text = (value: string): string => value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/[\\\[\]`!]/gu, '\\$&');
const label = (value: string): string => text(value.replace(/\s+/gu, ' ').trim()).replace(/[*_~#]/gu, '\\$&');

const parseExport = (value: unknown, sessionId: string) => {
  const bundle = record(value), session = record(bundle?.session);
  if (!bundle || !session || session.id !== sessionId || !Array.isArray(bundle.messages)
    || !instant(bundle.exported_at) || (session.title !== undefined && typeof session.title !== 'string')) return invalidExport();
  const seen = new Set<string>();
  const messages: ExportMessage[] = bundle.messages.map((raw: unknown) => {
    const row = record(raw);
    if (!row || typeof row.id !== 'string' || !row.id || seen.has(row.id) || row.session_id !== sessionId
      || !isChatMessageRole(row.role) || typeof row.content !== 'string' || !instant(row.ts)) return invalidExport();
    seen.add(row.id);
    if (row.attachments !== undefined && !Array.isArray(row.attachments)) return invalidExport();
    const attachments = (row.attachments ?? []).map((rawAttachment: unknown) => {
      const attachment = record(rawAttachment);
      if (!attachment || typeof attachment.file_id !== 'string' || !attachment.file_id
        || (attachment.filename !== undefined && typeof attachment.filename !== 'string')
        || (attachment.availability !== undefined && (typeof attachment.availability !== 'string'
          || !['available', 'deleted', 'missing'].includes(attachment.availability)))
        || (attachment.legacy_capture !== undefined && typeof attachment.legacy_capture !== 'boolean')) return invalidExport();
      return { file_id: attachment.file_id,
        ...(typeof attachment.filename === 'string' ? { filename: attachment.filename } : {}),
        ...(typeof attachment.availability === 'string' ? { availability: attachment.availability } : {}),
        ...(attachment.legacy_capture === true ? { legacy_capture: true } : {}) };
    });
    const sources = chatSourceCitationsOf(row.source_citations);
    return { id: row.id, role: row.role, content: row.content, ts: row.ts, attachments, sources,
      unresolvedSources: row.source_citations !== undefined
        && (!Array.isArray(row.source_citations) || sources.length !== row.source_citations.length),
      toolCall: row.tool_call };
  });
  // Match the durable history order, including the cursor's tie breaker.
  messages.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { title: typeof session.title === 'string' && session.title.trim() ? session.title : 'Chat conversation',
    exportedAt: bundle.exported_at, messages };
};

const longestTicks = (content: string): number => {
  let longest = 0;
  for (const match of content.matchAll(/`+/gu)) longest = Math.max(longest, match[0].length);
  return longest;
};
const codeFence = (content: string, language = ''): string => {
  const longest = longestTicks(content);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  const info = /^[\w+.#-]{1,32}$/u.test(language) ? language : '';
  return `${fence}${info}\n${content}${content.endsWith('\n') ? '' : '\n'}${fence}`;
};

const inlineCode = (content: string): string => {
  const longest = longestTicks(content);
  const fence = '`'.repeat(longest + 1);
  const pad = content.startsWith('`') || content.endsWith('`') || /^\s|\s$/u.test(content) ? ' ' : '';
  return `${fence}${pad}${content}${pad}${fence}`;
};

/** Keep source links portable while excluding URL query credentials/settings. */
const workspaceLink = (href: string, baseUrl?: string): string => {
  if (!baseUrl) return href;
  try {
    const url = new URL(baseUrl);
    if (!['https:', 'http:'].includes(url.protocol)) return href;
    url.username = ''; url.password = ''; url.search = ''; url.hash = href;
    return url.href;
  } catch { return href; }
};
const link = (name: string, href: string): string =>
  `[${label(name)}](<${href.replace(/[\s<>\\]/gu, char => encodeURIComponent(char))}>)`;

const segmentsToMarkdown = (segments: readonly AnswerTextSegment[], baseUrl?: string): string => segments.map(segment => {
  if (segment.kind === 'text') return text(segment.text);
  if (segment.kind === 'code') return inlineCode(segment.text);
  if (segment.kind === 'strong') return `**${segmentsToMarkdown(segment.children, baseUrl)}**`;
  return link(segment.label, workspaceLink(segment.href, baseUrl));
}).join('');

/** Code is literal; normal text uses the same trusted link parser as Chat. */
const messageBody = (content: string, sources: ExportMessage['sources'], baseUrl?: string): string => {
  const lines = content.replace(/\r\n?/gu, '\n').split('\n');
  const blocks: string[] = []; let plain: string[] = [];
  const flush = () => {
    const prose = plain.join('\n').replace(/^\n+|\n+$/gu, '');
    if (prose) blocks.push(segmentsToMarkdown(answerTextSegments(prose, sources), baseUrl));
    plain = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const opening = lines[i]!.match(/^[ \t]*(`{3,}|~{3,})([^\r\n]*)$/u);
    if (!opening || (opening[1]![0] === '`' && opening[2]!.includes('`'))) {
      const heading = lines[i]!.match(/^ {0,3}(#{1,6})[ \t]+(.+)$/u);
      if (heading) {
        flush();
        blocks.push(`${'#'.repeat(Math.min(6, heading[1]!.length + 2))} ${segmentsToMarkdown(answerTextSegments(heading[2]!, sources), baseUrl)}`);
      } else plain.push(lines[i]!);
      continue;
    }
    flush();
    const marker = opening[1]!, body: string[] = [];
    while (++i < lines.length) {
      const closing = lines[i]!.match(/^[ \t]*(`{3,}|~{3,})[ \t]*$/u)?.[1];
      if (closing && closing.length >= marker.length && closing[0] === marker[0]) break;
      body.push(lines[i]!);
    }
    // Close even a partial streamed fence before appending sources/next turns.
    blocks.push(codeFence(body.join('\n'), opening[2]!.trim().split(/\s+/u)[0]));
  }
  flush();
  return blocks.join('\n\n');
};

export const formatChatMarkdownExport = (
  value: unknown,
  options: { sessionId: string; baseUrl?: string } & Pick<ClientDateTimeOptions, 'locale' | 'timeZone'>,
): string => {
  const bundle = parseExport(value, options.sessionId);
  const stamp = (at: number) => formatClientDateTime(at, options);
  const roles: Record<ChatMessageRole, string> = { user: 'User', assistant: 'Assistant', tool: 'Tool', system: 'System' };
  const parts = [`# ${label(bundle.title)}`, `Exported from Recued · ${stamp(bundle.exportedAt)}`];
  if (!bundle.messages.length) parts.push('No messages in this conversation.');
  let hasSources = false, hasAttachments = false;
  for (const message of bundle.messages) {
    parts.push('---', `## ${roles[message.role]} · ${stamp(message.ts)}`);
    const tool = message.toolCall;
    if (isChatToolCallRecord(tool) && tool.message_id === message.id && tool.session_id === options.sessionId) {
      parts.push(`Recorded tool status: ${label(tool.tool_name)} · ${
        tool.denied ? 'not approved' : tool.expired ? 'not answered in time' : tool.state}`);
    }
    if (message.content) parts.push(message.role === 'tool' || message.role === 'system'
      ? codeFence(message.content, 'text') : messageBody(message.content, message.sources, options.baseUrl));
    if (message.attachments.length) {
      hasAttachments = true;
      parts.push('### Attachments', message.attachments.map(attachment => {
        const state = attachment.availability === 'deleted' ? ' · Deleted'
          : attachment.availability === 'missing' ? ' · Unavailable' : '';
        return `- ${label(attachment.filename || attachment.file_id)}${state}${attachment.legacy_capture ? ' · Original submitted version unverified' : ''}`;
      }).join('\n'));
    }
    if (message.sources.length) {
      hasSources = true;
      parts.push('### Sources', message.sources.map(source => {
        const scope = source.kind === 'asset' ? 'Saved asset' : source.kind === 'file' ? 'Document'
          : source.projection.kind === 'context' ? 'Relationships · Bounded view'
            : source.projection.kind === 'field' ? 'Saved fact' : 'Saved facts · Partial view';
        return `- ${link(source.label, workspaceLink(sourceCitationHref(source, { sessionId: options.sessionId, messageId: message.id }), options.baseUrl))} · ${scope} · Read ${stamp(source.read_at)}`;
      }).join('\n'));
    }
    if (message.unresolvedSources) parts.push('Some source details could not be resolved in this export.');
  }
  if (hasSources) parts.push('Source links open current records in the original Recued workspace. Those records may have changed since they were read.');
  if (hasAttachments) parts.push('Attachments are listed by name; file contents are separate from this transcript.');
  return `${parts.join('\n\n')}\n`;
};
