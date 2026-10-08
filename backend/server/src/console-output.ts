/** Console renderer for recipe execution output.
 *
 *  Renders the same output types the recipe result surfaces render (summary,
 *  checklist, table, ai_analysis, text, copyable, button, file_artifact) as formatted
 *  terminal text. Reads canonical output.render with an output.sidebar
 *  migration fallback. No dependencies beyond Node built-ins.
 *
 *  Data shapes mirror the transforms:
 *    summary:      { fields: [{ label, value }] }
 *    checklist:    { title?, items: [{ label, status, detail }] }
 *    table:        { columns: [{ field, label?, type? }], rows: object[] }
 *    ai_analysis:  string | { summary?, reasoning?, key_points?, score?, ... }
 *    text:         string
 *    copyable:     string | { content }
 *    button:       RecipeOutputAction | RecipeOutputAction[]
 *    file_artifact: immutable file metadata + inert owner-decision actions
 */

import { selectValidReceptionLinkButtons } from '@recued/contracts';
import { tableFieldValue } from '@recued/renderer';

import type { ExecuteResponse } from './types.js';

type ConsoleOutputBlock = {
  type: string;
  data: unknown;
  label?: string;
} & Record<string, unknown>;

type RecipeRunAction = {
  kind: 'recipe.run';
  label: string;
  recipe_id: string;
};

// ────────────────────────────────────────────────────────────────
// Styling helpers (ANSI)
// ────────────────────────────────────────────────────────────────

const isTTY = process.stdout.isTTY ?? false;

const RESET = isTTY ? '\x1b[0m' : '';
const BOLD = isTTY ? '\x1b[1m' : '';
const DIM = isTTY ? '\x1b[2m' : '';
const GREEN = isTTY ? '\x1b[32m' : '';
const RED = isTTY ? '\x1b[31m' : '';
const YELLOW = isTTY ? '\x1b[33m' : '';
const CYAN = isTTY ? '\x1b[36m' : '';

const CHECK = isTTY ? '✓' : '[ok]';
const CROSS = isTTY ? '✗' : '[!!]';
const DASH = isTTY ? '–' : '--';
const BULLET = isTTY ? '•' : '*';

// ────────────────────────────────────────────────────────────────
// Section renderers
// ────────────────────────────────────────────────────────────────

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const readRecipeRunAction = (
  value: unknown,
): { label: string; recipeId: string } | null => {
  const row = asRecord(value);
  if (
    row === null
    || row.kind !== 'recipe.run'
    || typeof row.label !== 'string'
    || row.label.trim().length === 0
    || typeof row.recipe_id !== 'string'
    || row.recipe_id.trim().length === 0
  ) {
    return null;
  }
  const action = row as RecipeRunAction;
  return {
    label: action.label.trim(),
    recipeId: action.recipe_id.trim(),
  };
};

const renderRecipeAction = (value: unknown): string => {
  const action = readRecipeRunAction(value);
  if (action === null) return `${DIM}Unsupported action${RESET}`;
  return `${action.label} ${DIM}(recipe.run: ${action.recipeId})${RESET}`;
};

const renderRecipeActionGroup = (value: unknown): string => {
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0) return `${DIM}No actions${RESET}`;
  return values.map(renderRecipeAction).join('; ');
};

const renderSummary = (data: unknown): string => {
  if (!data || typeof data !== 'object') return String(data ?? '');
  const { fields } = data as { fields?: Array<{ label: string; value: unknown }> };
  if (!Array.isArray(fields)) return JSON.stringify(data, null, 2);

  const labelW = Math.max(...fields.map(f => (f.label ?? '').length), 0);
  return fields
    .map(f => `  ${DIM}${(f.label ?? '').padEnd(labelW)}${RESET}  ${BOLD}${formatValue(f.value)}${RESET}`)
    .join('\n');
};

const renderChecklist = (data: unknown): string => {
  if (!data || typeof data !== 'object') return String(data ?? '');
  const { title, items } = data as {
    title?: string;
    items?: Array<{
      label: string;
      status: string;
      detail?: string;
      action?: unknown;
      actions?: unknown[];
    }>;
  };
  if (!Array.isArray(items)) return JSON.stringify(data, null, 2);

  const lines: string[] = [];
  if (title) lines.push(`  ${BOLD}${title}${RESET}`);
  for (const item of items) {
    const icon = item.status === 'ok' ? `${GREEN}${CHECK}${RESET}`
      : item.status === 'issue' ? `${RED}${CROSS}${RESET}`
      : `${DIM}${DASH}${RESET}`;
    lines.push(`  ${icon} ${item.label}${DIM}  ${item.detail ?? ''}${RESET}`);
    if (Array.isArray(item.actions)) {
      lines.push(`    ${renderRecipeActionGroup(item.actions)}`);
    } else if (item.action !== undefined) {
      lines.push(`    ${renderRecipeActionGroup(item.action)}`);
    }
  }
  return lines.join('\n');
};

const renderTable = (data: unknown): string => {
  if (!data || typeof data !== 'object') return String(data ?? '');
  const { columns, rows } = data as { columns?: Array<{ field: string; label?: string; type?: string }>; rows?: unknown[] };
  if (!Array.isArray(columns) || !Array.isArray(rows)) return JSON.stringify(data, null, 2);

  // Compute column widths
  const headers = columns.map(c => c.label ?? c.field);
  const cells = rows.map(row =>
    columns.map((c) => {
      const cell = tableFieldValue(row, c.field);
      return c.type === 'action'
        ? renderRecipeActionGroup(cell)
        : formatValue(cell);
    }),
  );
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...cells.map(r => r[i].length)),
  );

  const lines: string[] = [];
  // Header
  lines.push('  ' + headers.map((h, i) => `${BOLD}${h.padEnd(widths[i])}${RESET}`).join('  '));
  lines.push('  ' + widths.map(w => DIM + '─'.repeat(w) + RESET).join('  '));
  // Rows
  for (const row of cells) {
    lines.push('  ' + row.map((c, i) => c.padEnd(widths[i])).join('  '));
  }
  return lines.join('\n');
};

const renderAiAnalysis = (data: unknown): string => {
  if (typeof data === 'string') return wrapText(data, '  ');
  if (!data || typeof data !== 'object') return String(data ?? '');

  const obj = data as Record<string, unknown>;
  const lines: string[] = [];

  // Known fields in display order
  const known: Array<[string, string]> = [
    ['summary', 'Summary'],
    ['category', 'Category'],
    ['score', 'Score'],
    ['confidence', 'Confidence'],
    ['sentiment', 'Sentiment'],
    ['reasoning', 'Reasoning'],
  ];

  for (const [key, label] of known) {
    if (obj[key] == null) continue;
    lines.push(`  ${DIM}${label}:${RESET} ${formatValue(obj[key])}`);
  }

  // key_points as bullet list
  if (Array.isArray(obj.key_points)) {
    lines.push(`  ${DIM}Key Points:${RESET}`);
    for (const point of obj.key_points) {
      lines.push(`    ${BULLET} ${String(point)}`);
    }
  }

  // Remaining keys
  for (const [key, val] of Object.entries(obj)) {
    if (['summary', 'category', 'score', 'confidence', 'sentiment', 'reasoning', 'key_points'].includes(key)) continue;
    if (val == null) continue;
    lines.push(`  ${DIM}${key}:${RESET} ${formatValue(val)}`);
  }

  return lines.length > 0 ? lines.join('\n') : JSON.stringify(data, null, 2);
};

const renderText = (data: unknown): string => {
  if (typeof data === 'string') return wrapText(data, '  ');
  return `  ${formatValue(data)}`;
};

const renderCopyable = (data: unknown, label?: string): string => {
  const content = typeof data === 'string' ? data
    : (data as Record<string, unknown>)?.content ?? data;
  const header = label ? `  ${DIM}${label}:${RESET}\n` : '';
  return header + wrapText(String(content ?? ''), '  ');
};

/** Raw step detail. The terminal is the one surface with no disclosure control,
 *  so unlike the HTML block (which collapses behind `<details>`) this prints in
 *  full — a console reader scrolls, and truncating detail on the surface whose
 *  whole job is showing it would be the wrong trade. Indented, never one-line:
 *  the dispatcher's `default` would have JSON.stringify'd this flat, which is
 *  technically the data and practically unreadable. */
const renderJson = (data: unknown, label?: string): string => {
  const header = label ? `  ${DIM}${label}:${RESET}\n` : '';
  let json: string | undefined;
  try {
    json = JSON.stringify(data, null, 2);
  } catch {
    // Circular structure or BigInt — the block still prints a row.
    return `${header}  ${DIM}(not serialisable)${RESET}`;
  }
  if (json === undefined) return `${header}  ${DIM}(no data)${RESET}`;
  return header + json.split('\n').map((line) => `  ${line}`).join('\n');
};

const renderTimestamp = (data: unknown, label?: string): string => {
  const ms = typeof data === 'number' ? data
    : (data as Record<string, unknown>)?.time as number ?? NaN;
  if (isNaN(ms)) return `  ${DIM}(invalid timestamp)${RESET}`;
  const ago = formatRelativeTime(ms);
  const iso = new Date(ms).toISOString().slice(0, 19);
  const prefix = label ? `${DIM}${label}:${RESET} ` : '';
  return `  ${prefix}${ago} ${DIM}(${iso})${RESET}`;
};

const renderDiff = (data: unknown): string => {
  if (!data || typeof data !== 'object') return String(data ?? '');
  const { fields } = data as { fields?: Array<{ label?: string; from?: unknown; to?: unknown }> };
  if (!Array.isArray(fields)) return JSON.stringify(data, null, 2);

  const labelW = Math.max(...fields.map(f => (f.label ?? '').length), 0);
  return fields.map(f => {
    const label = (f.label ?? '?').padEnd(labelW);
    const from = formatValue(f.from);
    const to = formatValue(f.to);
    if (from === to) return `  ${DIM}${label}${RESET}  ${from}`;
    return `  ${DIM}${label}${RESET}  ${RED}${from}${RESET} ${YELLOW}\u2192${RESET} ${GREEN}${to}${RESET}`;
  }).join('\n');
};

const renderActions = (data: unknown): string => {
  if (!data || typeof data !== 'object') return '';
  const { buttons } = data as { buttons?: Array<{ label?: string; action?: string; value?: string }> };
  if (!Array.isArray(buttons) || buttons.length === 0) return '';

  return buttons.map(b => {
    const label = b.label ?? b.action ?? '?';
    const action = b.action ?? 'copy';
    if (action === 'open') return `  ${CYAN}${label}${RESET}  ${DIM}${b.value ?? ''}${RESET}`;
    if (action === 'copy') return `  ${label}  ${DIM}(copy: ${(b.value ?? '').slice(0, 60)})${RESET}`;
    return `  ${label}  ${DIM}[${action}]${RESET}`;
  }).join('\n');
};

const renderButton = (data: unknown): string => {
  const values = Array.isArray(data) ? data : [data];
  if (data === null || data === undefined || values.length === 0) {
    return `${DIM}(no button actions)${RESET}`;
  }
  return values.map((value) => `  ${renderRecipeAction(value)}`).join('\n');
};

/** D-207 slice 2 — the ninth block kind, in the terminal.
 *
 *  ⚠ NOT a duplicate of `@recued/renderer`'s `renderLinkButtonBlock`: this file
 *  is a different MEDIUM (ANSI, not HTML), which is why the CLI has always had
 *  its own block dispatcher. It still shares the ONE fence — the rows go
 *  through `selectValidReceptionLinkButtons`, so a bad URL is dropped here for
 *  the same reason and by the same rule as on a visitor's page. Left to the
 *  `default` branch, a link button would have printed as a raw JSON dump. */
const renderLinkButton = (data: unknown): string => {
  const buttons = selectValidReceptionLinkButtons(data);
  if (buttons.length === 0) return `${DIM}(no links)${RESET}`;
  return buttons
    .map((button) => {
      const description = typeof button.description === 'string' && button.description.length > 0
        ? `\n    ${DIM}${button.description}${RESET}`
        : '';
      return `  ${BOLD}${button.label}${RESET}\n    ${DIM}${button.url}${RESET}${description}`;
    })
    .join('\n');
};

const renderFileArtifact = (data: unknown): string => {
  const values = Array.isArray(data) ? data : [data];
  if (data === null || data === undefined || values.length === 0) {
    return `${DIM}(no file artifacts)${RESET}`;
  }
  return values.map((value) => {
    const row = asRecord(value);
    if (row === null) return `  ${DIM}(invalid file artifact)${RESET}`;
    const lines = [
      `  ${BOLD}${String(row.filename ?? 'Unnamed file')}${RESET}`,
      `    ref: ${String(row.record_id ?? '—')}`,
      `    type: ${String(row.mime_type ?? '—')}`,
      `    size: ${typeof row.size_bytes === 'number' ? `${row.size_bytes} bytes` : '—'}`,
      `    sha256: ${String(row.sha256 ?? '—')}`,
    ];
    if (row.approval_action !== undefined) {
      lines.push(`    ${renderRecipeAction(row.approval_action)}`);
    }
    if (Array.isArray(row.decision_actions)) {
      for (const action of row.decision_actions) {
        lines.push(`    ${renderRecipeAction(action)}`);
      }
    }
    return lines.join('\n');
  }).join('\n');
};

const formatRelativeTime = (epochMs: number): string => {
  const diff = Date.now() - epochMs;
  if (diff < 0 || diff < 60_000) return 'just now';
  if (diff < 3_600_000) { const m = Math.floor(diff / 60_000); return `${m} min${m !== 1 ? 's' : ''} ago`; }
  if (diff < 86_400_000) { const h = Math.floor(diff / 3_600_000); return `${h} hour${h !== 1 ? 's' : ''} ago`; }
  const d = Math.floor(diff / 86_400_000);
  return `${d} day${d !== 1 ? 's' : ''} ago`;
};

// ────────────────────────────────────────────────────────────────
// Block dispatcher
// ────────────────────────────────────────────────────────────────

/** The section's authored `label`, as a terminal header — same shape `renderCopyable` has
 *  always used. The terminal owns no chrome of its own (no `<h3>` to fall back on, unlike the
 *  webclient panel), so a label this dispatcher drops is a label the console reader never
 *  sees at all. It reached only copyable / json / timestamp; the kinds below carry 212 of the
 *  corpus's labelled sections between them. */
const labelHeader = (label?: string): string =>
  typeof label === 'string' && label.trim().length > 0 ? `  ${DIM}${label}:${RESET}\n` : '';

const renderBlock = (block: { type: string; data: unknown; label?: string }): string => {
  switch (block.type) {
    case 'summary': return labelHeader(block.label) + renderSummary(block.data);
    case 'checklist': return labelHeader(block.label) + renderChecklist(block.data);
    case 'table': return labelHeader(block.label) + renderTable(block.data);
    case 'ai_analysis': return labelHeader(block.label) + renderAiAnalysis(block.data);
    case 'text': return labelHeader(block.label) + renderText(block.data);
    case 'copyable': return renderCopyable(block.data, block.label);
    case 'button': return renderButton(block.data);
    case 'file_artifact': return labelHeader(block.label) + renderFileArtifact(block.data);
    case 'link_button': return renderLinkButton(block.data);
    case 'json': return renderJson(block.data, block.label);
    case 'timestamp': return renderTimestamp(block.data, block.label);
    case 'diff': return renderDiff(block.data);
    case 'actions': return renderActions(block.data);
    default: return `  ${DIM}[${block.type}]${RESET} ${JSON.stringify(block.data)}`;
  }
};

const resultOutputSections = (result: ExecuteResponse): ConsoleOutputBlock[] => {
  const output = result.output;
  if (Array.isArray(output?.render)) return output.render as ConsoleOutputBlock[];
  if (Array.isArray(output?.sidebar)) return output.sidebar as ConsoleOutputBlock[];
  return [];
};

// ────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────

/** Render a full execution result to console-formatted text. */
export const formatResult = (result: ExecuteResponse): string => {
  const lines: string[] = [];

  // Header
  const status = result.success
    ? `${GREEN}${CHECK} success${RESET}`
    : `${RED}${CROSS} failed${RESET}`;
  lines.push(`${BOLD}${result.recipe_id}${RESET}  ${status}  ${DIM}${result.duration_ms}ms${RESET}`);
  lines.push('');

  // Output sections
  const sections = resultOutputSections(result);
  if (sections.length > 0) {
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      lines.push(renderBlock(section));
      if (i < sections.length - 1) lines.push('');
    }
  }

  // ⛔ Per-item failures inside a `foreach`. They are NOT in `errors[]` and they
  // do not make `success` false — a partial write is not a failed run — so
  // without this line a run that refused every single item prints exactly like
  // one that wrote them all. That is how three defects shipped in one pack.
  const partial = (result.steps as ReadonlyArray<{
    id?: string; foreach?: { items: number; failed: number };
  }>).filter((s) => s.foreach !== undefined && s.foreach.failed > 0);
  if (partial.length > 0) {
    lines.push('');
    lines.push(`${YELLOW}${BOLD}Items refused:${RESET}`);
    for (const step of partial) {
      const { items, failed } = step.foreach!;
      lines.push(`  ${YELLOW}!${RESET} ${DIM}[${step.id ?? '?'}]${RESET} `
        + `${failed} of ${items} ${items === 1 ? 'item' : 'items'} failed`
        + `${failed === items ? ` ${DIM}— every one${RESET}` : ''}`);
    }
  }

  // Errors — show step source + code + message
  if (result.errors.length > 0) {
    lines.push('');
    lines.push(`${RED}${BOLD}Errors:${RESET}`);
    for (const err of result.errors) {
      const e = err as { code?: string; message?: string; source?: { step_id?: string; ingredient_slug?: string } };
      const stepTag = e.source?.step_id ? `${DIM}[${e.source.step_id}]${RESET} ` : '';
      lines.push(`  ${RED}${CROSS}${RESET} ${stepTag}${e.code ?? 'ERROR'}: ${e.message ?? JSON.stringify(err)}`);
    }
  }

  // Step trace — show each step's status when there are errors
  const stepCount = result.steps.length;
  const skipped = result.steps.filter(s => s.skipped).length;
  const errored = result.steps.filter(s => s.error).length;

  if (!result.success && result.steps.length > 0) {
    lines.push('');
    lines.push(`${DIM}Steps:${RESET}`);
    for (const s of result.steps) {
      const icon = s.error ? `${RED}${CROSS}${RESET}`
        : s.skipped ? `${DIM}${DASH}${RESET}`
        : `${GREEN}${CHECK}${RESET}`;
      const dur = s.duration_ms > 0 ? ` ${DIM}${s.duration_ms}ms${RESET}` : '';
      const errCode = s.error ? ` ${RED}${(s.error as { code?: string }).code ?? 'ERROR'}${RESET}` : '';
      lines.push(`  ${icon} ${s.id} ${DIM}(${s.type})${RESET}${dur}${errCode}`);
    }
  } else {
    lines.push('');
    lines.push(`${DIM}${stepCount} steps${skipped ? `, ${skipped} skipped` : ''}${errored ? `, ${RESET}${RED}${errored} errored${RESET}${DIM}` : ''}${RESET}`);
  }

  return lines.join('\n');
};

/** Print a formatted execution result to stdout. */
export const printResult = (result: ExecuteResponse): void => {
  console.log(formatResult(result));
};

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

/** Format a value for display. Objects become compact JSON, arrays show count. */
const formatValue = (value: unknown): string => {
  if (value == null) return `${DIM}–${RESET}`;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return `[${value.length} items]`;
  return JSON.stringify(value);
};

/** Wrap text at ~78 chars with a prefix indent. */
const wrapText = (text: string, prefix: string): string => {
  const maxWidth = 78 - prefix.length;
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current.length + word.length + 1 > maxWidth && current.length > 0) {
      lines.push(prefix + current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(prefix + current);
  return lines.join('\n');
};
