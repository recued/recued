/** Sidebar → Slack Block Kit conversion (D-101 P4d).
 *
 *  Takes the array shape used by `ExecutionResult.output.sidebar`
 *  (`{ type, data, label? }[]`) and returns the `blocks` array shape
 *  accepted by Slack's `chat.postMessage` API. Paired with the
 *  `slack-post` ingredient — a recipe composes:
 *
 *    { id: "fmt", transform: "to_slack_blocks", blocks: "{{step.sidebar}}" }
 *    { id: "post", ingredient: "slack-post",
 *      input: { "body.channel": "#alerts", "body.blocks": "{{step.fmt}}" } }
 *
 *  Supported sidebar block types:
 *    - summary      → section with `fields` pairs (chunked at 10)
 *    - checklist    → header (title) + section (mrkdwn with status icons)
 *    - table        → section with preformatted code-block text
 *    - ai_analysis  → section with JSON-stringified preformatted text
 *    - text         → section with mrkdwn
 *
 *  Slack hard limits enforced by the renderer:
 *    - 50 blocks per message (extras dropped)
 *    - 3000 chars per section text
 *    - 2000 chars per field text (10 fields max per section)
 *    - 150 chars per header text
 *
 *  Block `label` becomes a `header` block above the rendered content.
 *  Unknown block types fall back to text rendering so recipes don't
 *  fail hard on a typo.
 */

import type { TransformFn } from './types.js';

const MAX_BLOCKS = 50;
const MAX_SECTION_TEXT = 3000;
const MAX_FIELD_TEXT = 2000;
const MAX_HEADER_TEXT = 150;
const MAX_FIELDS_PER_SECTION = 10;

interface SlackMrkdwn { type: 'mrkdwn'; text: string }
interface SlackPlainText { type: 'plain_text'; text: string }
interface SlackSectionBlock {
  type: 'section';
  text?: SlackMrkdwn;
  fields?: SlackMrkdwn[];
}
interface SlackHeaderBlock { type: 'header'; text: SlackPlainText }
interface SlackDividerBlock { type: 'divider' }
type SlackBlock = SlackSectionBlock | SlackHeaderBlock | SlackDividerBlock;

const cap = (s: string, max: number): string =>
  s.length <= max ? s : s.slice(0, max - 1) + '…';

const section = (text: string): SlackSectionBlock => ({
  type: 'section',
  text: { type: 'mrkdwn', text: cap(text, MAX_SECTION_TEXT) },
});

const header = (text: string): SlackHeaderBlock => ({
  type: 'header',
  text: { type: 'plain_text', text: cap(text, MAX_HEADER_TEXT) },
});

const renderSummary = (data: unknown): SlackBlock[] => {
  const d = data as { fields?: Array<{ label?: unknown; value?: unknown }> } | null;
  const fields = d?.fields;
  if (!Array.isArray(fields) || fields.length === 0) return [];

  const mrkdwnFields: SlackMrkdwn[] = fields.map((f) => ({
    type: 'mrkdwn',
    text: cap(`*${String(f.label ?? '')}*\n${String(f.value ?? '—')}`, MAX_FIELD_TEXT),
  }));

  const blocks: SlackBlock[] = [];
  for (let i = 0; i < mrkdwnFields.length; i += MAX_FIELDS_PER_SECTION) {
    blocks.push({
      type: 'section',
      fields: mrkdwnFields.slice(i, i + MAX_FIELDS_PER_SECTION),
    });
  }
  return blocks;
};

const STATUS_ICON: Record<string, string> = {
  ok: ':white_check_mark:',
  issue: ':x:',
  null: ':grey_question:',
};

const renderChecklist = (data: unknown): SlackBlock[] => {
  const d = data as {
    title?: unknown;
    items?: Array<{ label?: unknown; status?: unknown; detail?: unknown }>;
  } | null;
  const items = d?.items;
  if (!Array.isArray(items)) return [];

  const blocks: SlackBlock[] = [];
  if (d?.title) blocks.push(header(String(d.title)));

  const text = items
    .map((item) => {
      const icon = STATUS_ICON[String(item.status ?? '')] ?? '•';
      const label = String(item.label ?? '');
      const detail = item.detail ? ` — ${String(item.detail)}` : '';
      return `${icon} ${label}${detail}`;
    })
    .join('\n');
  blocks.push(section(text || '_(empty)_'));
  return blocks;
};

const renderTable = (data: unknown): SlackBlock[] => {
  const d = data as {
    columns?: Array<{ field?: unknown; label?: unknown }>;
    rows?: unknown[];
  } | null;
  const columns = d?.columns;
  const rows = d?.rows;
  if (!Array.isArray(columns) || columns.length === 0 || !Array.isArray(rows)) return [];

  const headers = columns.map((c) => String(c.label ?? c.field ?? ''));
  const body = rows.map((r) => {
    const obj = r as Record<string, unknown>;
    return columns.map((c) => {
      const key = String(c.field ?? '');
      const v = obj?.[key];
      return v == null ? '—' : String(v);
    });
  });

  // Width-pad each column to the widest cell for readable alignment
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...body.map((r) => r[i]?.length ?? 0)),
  );
  const padRow = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i], ' ')).join(' | ');

  const sepLine = widths.map((w) => '-'.repeat(w)).join('-+-');
  const lines = [padRow(headers), sepLine, ...body.map(padRow)];
  return [section('```\n' + lines.join('\n') + '\n```')];
};

const renderAiAnalysis = (data: unknown): SlackBlock[] => {
  const text = typeof data === 'string' ? data : safeStringify(data);
  return [section('```\n' + text + '\n```')];
};

const renderText = (data: unknown): SlackBlock[] => {
  if (data == null || data === '') return [];
  return [section(String(data))];
};

const safeStringify = (obj: unknown): string => {
  try { return JSON.stringify(obj, null, 2); }
  catch { return String(obj); }
};

const RENDERERS: Record<string, (data: unknown) => SlackBlock[]> = {
  summary: renderSummary,
  checklist: renderChecklist,
  table: renderTable,
  ai_analysis: renderAiAnalysis,
  text: renderText,
};

export const to_slack_blocks: TransformFn = (p) => {
  const input = p.blocks as Array<{ type?: unknown; data?: unknown; label?: unknown }> | null;
  if (!Array.isArray(input)) return [];

  const out: SlackBlock[] = [];
  const push = (b: SlackBlock): boolean => {
    if (out.length >= MAX_BLOCKS) return false;
    out.push(b);
    return true;
  };

  for (const block of input) {
    if (out.length >= MAX_BLOCKS) break;
    const type = String(block?.type ?? '');
    if (block?.label) push(header(String(block.label)));
    const renderer = RENDERERS[type] ?? renderText;
    const rendered = renderer(block?.data);
    for (const b of rendered) if (!push(b)) break;
  }

  return out;
};
