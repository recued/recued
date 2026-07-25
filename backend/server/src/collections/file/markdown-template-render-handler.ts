import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  PAID_DOCUMENT_AI_DRAFT_KEY,
  PAID_DOCUMENT_AI_DRAFT_MAX_CHARS,
  PAID_DOCUMENT_TEMPLATE_MAX_BYTES,
  RpcError,
  type TempFileRef,
} from '@recued/contracts';

import { allocateRunScratchDir } from '../../execution/run-scratch.js';
import type { FileReadResponse } from './file-read-handler.js';
import { isInboundFileRecordId } from './inbound-file-collection.js';

/** D-200 Slice 3 — fixed local Markdown-template renderer. The operation reads
 * one already-gated durable file ref, substitutes a closed set of scalar merge
 * values, and emits exactly one run-scoped temp ref. It never accepts a path,
 * shell flags, template code, or network input. */
export const FILE_RENDER_MARKDOWN_TEMPLATE_INGREDIENT_SLUG =
  'file-render-markdown-template' as const;

export const MARKDOWN_TEMPLATE_MAX_BYTES = PAID_DOCUMENT_TEMPLATE_MAX_BYTES;
export const MARKDOWN_TEMPLATE_OUTPUT_MAX_BYTES = 2 * 1024 * 1024;
export const MARKDOWN_TEMPLATE_MAX_VALUES = 128;
export const MARKDOWN_TEMPLATE_MAX_VALUE_CHARS = 64 * 1024;
export const MARKDOWN_TEMPLATE_MAX_TOTAL_VALUE_BYTES = 1024 * 1024;
export const MARKDOWN_TEMPLATE_MAX_PLACEHOLDERS = 512;

const RESPONSE_KEY_RE = /^response\.[a-z][a-z0-9_]{0,63}$/;
const CLOSED_KEYS = new Set([
  'visitor.email',
  'system.accepted_date',
  PAID_DOCUMENT_AI_DRAFT_KEY,
]);
const ASCII_PUNCTUATION_RE = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g;
const SUPPORTED_TEMPLATE_MIME_TYPES = new Set(['text/markdown', 'text/plain']);
const INVALID_TEXT_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const CANONICAL_BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export interface MarkdownTemplateRenderRequest {
  template_file_ref: string;
  values: Record<string, unknown>;
  strict: true;
  run_id: string;
}

export interface MarkdownTemplateRenderResponse {
  file_ref: TempFileRef;
  template_sha256: string;
  content_sha256: string;
  used_keys: string[];
  missing_keys: string[];
}

export interface MarkdownTemplateRenderDeps {
  readFile(input: { record_id: string }): Promise<FileReadResponse>;
  allocateScratchDir?: (run_id: string) => string;
}

type PreparedRender = Omit<MarkdownTemplateRenderResponse, 'file_ref'> & {
  content: string;
};

function fail(
  code: string,
  message: string,
  status = 422,
  details?: Readonly<Record<string, unknown>>,
): never {
  throw new RpcError(code, message, status, undefined, details);
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const isAllowedKey = (key: string): boolean =>
  RESPONSE_KEY_RE.test(key) || CLOSED_KEYS.has(key);

const diagnosticPreview = (value: string): string =>
  JSON.stringify(value.slice(0, 128));

const scalarToString = (key: string, value: unknown): string => {
  if (value === null) return '';
  if (typeof value === 'string') {
    if (key === PAID_DOCUMENT_AI_DRAFT_KEY
      && value.length > PAID_DOCUMENT_AI_DRAFT_MAX_CHARS) {
      fail(
        'markdown_template_ai_draft_too_large',
        `markdown template value '${key}' exceeds ${PAID_DOCUMENT_AI_DRAFT_MAX_CHARS} characters`,
        413,
        { key, max_chars: PAID_DOCUMENT_AI_DRAFT_MAX_CHARS },
      );
    }
    if (value.length > MARKDOWN_TEMPLATE_MAX_VALUE_CHARS) {
      fail(
        'markdown_template_value_too_large',
        `markdown template value '${key}' exceeds ${MARKDOWN_TEMPLATE_MAX_VALUE_CHARS} characters`,
        413,
        { key, max_chars: MARKDOWN_TEMPLATE_MAX_VALUE_CHARS },
      );
    }
    if (INVALID_TEXT_CONTROL_RE.test(value)) {
      fail(
        'markdown_template_value_invalid',
        `markdown template value '${key}' contains a disallowed control character`,
        422,
        { key },
      );
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      fail(
        'markdown_template_value_invalid',
        `markdown template value '${key}' must be a finite number`,
        422,
        { key },
      );
    }
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  fail(
    'markdown_template_value_invalid',
    `markdown template value '${key}' must be a string, finite number, boolean, or null`,
    422,
    { key },
  );
};

/** Escape a visitor/response value as Markdown text. Escaping every ASCII
 * punctuation character prevents links, emphasis, raw tags, entities, and
 * extension syntax. Leading whitespace is encoded so a newline followed by
 * four spaces or a tab cannot introduce an indented code block. */
export const escapeMarkdownTemplateValue = (value: string): string =>
  value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => {
      const leading = line.match(/^[ \t]+/)?.[0] ?? '';
      const encodedLeading = [...leading]
        .map((char) => (char === '\t' ? '&#9;' : '&#32;'))
        .join('');
      return encodedLeading
        + line.slice(leading.length).replace(
          ASCII_PUNCTUATION_RE,
          (char) => char === '\\'
            ? '&#92;'
            : char === '@'
              ? '&#64;'
              : `\\${char}`,
        );
    })
    .join('\n');

const decodeUtf8 = (bytes: Buffer): string => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('markdown_template_invalid_utf8', 'Markdown template must contain valid UTF-8');
  }
};

const validateMarkdownSafety = (markdown: string, subject: string): void => {
  // Strict v1 has no trusted/raw mode. Refusing angle brackets is intentionally
  // stronger than trying to recognize every HTML/XML construct Pandoc accepts.
  if (/(?<!\\)[<>]/.test(markdown)) {
    fail(
      'markdown_template_raw_markup',
      `${subject} contains angle-bracket markup; raw HTML/autolinks are disabled`,
    );
  }
  // Pandoc raw-attribute blocks can inject HTML/TeX without angle brackets.
  if (/\{\s*=\s*[A-Za-z0-9_-]+\s*\}/.test(markdown)) {
    fail(
      'markdown_template_raw_markup',
      `${subject} contains a raw output attribute; trusted raw mode is disabled`,
    );
  }
  // The downstream D-200 Pandoc step must never turn a reviewed Markdown
  // template into an implicit host/network read or a raw TeX program.
  if (/!\[/.test(markdown)) {
    fail(
      'markdown_template_external_resource',
      `${subject} contains a Markdown image whose target could read a local or remote resource`,
    );
  }
  if (/\\[A-Za-z@]+/.test(markdown)) {
    fail(
      'markdown_template_raw_markup',
      `${subject} contains a TeX control sequence; trusted raw mode is disabled`,
    );
  }
  if (/^(?:\uFEFF)?---[ \t]*(?:\r?\n)/.test(markdown)) {
    fail(
      'markdown_template_metadata_disabled',
      `${subject} contains YAML metadata, which is disabled in strict mode`,
    );
  }
};

const validateTemplateSource = (template: string): void => {
  if (INVALID_TEXT_CONTROL_RE.test(template)) {
    fail(
      'markdown_template_invalid',
      'Markdown template contains a disallowed control character',
    );
  }
  // A source backslash immediately before a placeholder could combine with an
  // inserted alphabetic value into a raw TeX command. Strict v1 rejects source
  // backslashes wholesale; inserted backslashes are encoded as text entities.
  if (template.includes('\\')) {
    fail(
      'markdown_template_raw_markup',
      'Markdown template contains a backslash; trusted TeX/escape mode is disabled',
    );
  }
  validateMarkdownSafety(template, 'Markdown template');
};

const normalizeMarkdownTemplateValues = (
  valuesInput: unknown,
): Map<string, string> => {
  if (!isPlainRecord(valuesInput)) {
    fail('markdown_template_values_invalid', 'Markdown template values must be a plain object', 400);
  }
  const entries = Object.entries(valuesInput);
  if (entries.length > MARKDOWN_TEMPLATE_MAX_VALUES) {
    fail(
      'markdown_template_values_too_many',
      `Markdown template values exceed ${MARKDOWN_TEMPLATE_MAX_VALUES} entries`,
      413,
      { max_values: MARKDOWN_TEMPLATE_MAX_VALUES },
    );
  }

  const values = new Map<string, string>();
  let totalValueBytes = 0;
  for (const [key, rawValue] of entries) {
    if (!isAllowedKey(key)) {
      const keyPreview = diagnosticPreview(key);
      fail(
        'markdown_template_key_invalid',
        `Markdown template value key ${keyPreview} is outside the closed placeholder grammar`,
        422,
        { key_preview: keyPreview, key_length: key.length },
      );
    }
    const value = scalarToString(key, rawValue);
    totalValueBytes += Buffer.byteLength(value, 'utf8');
    if (totalValueBytes > MARKDOWN_TEMPLATE_MAX_TOTAL_VALUE_BYTES) {
      fail(
        'markdown_template_values_too_large',
        `Markdown template values exceed ${MARKDOWN_TEMPLATE_MAX_TOTAL_VALUE_BYTES} bytes in total`,
        413,
        { max_total_bytes: MARKDOWN_TEMPLATE_MAX_TOTAL_VALUE_BYTES },
      );
    }
    values.set(key, value);
  }
  return values;
};

interface MarkdownPlaceholderContext {
  cursor: number;
  inlineDestinationDepth: number;
  attributeDepth: number;
  bracketDepth: number;
}

const advancePlaceholderContext = (
  template: string,
  until: number,
  context: MarkdownPlaceholderContext,
): void => {
  while (context.cursor < until) {
    const char = template[context.cursor];
    const next = template[context.cursor + 1];
    if (context.inlineDestinationDepth === 0 && char === ']' && next === '(') {
      if (context.bracketDepth > 0) context.bracketDepth -= 1;
      context.inlineDestinationDepth = 1;
      context.cursor += 2;
      continue;
    }
    if (context.inlineDestinationDepth > 0) {
      if (char === '(') context.inlineDestinationDepth += 1;
      else if (char === ')') context.inlineDestinationDepth -= 1;
    } else if (char === '[') {
      context.bracketDepth += 1;
    } else if (char === ']' && context.bracketDepth > 0) {
      context.bracketDepth -= 1;
    }
    if (char === '{') context.attributeDepth += 1;
    else if (char === '}' && context.attributeDepth > 0) context.attributeDepth -= 1;
    context.cursor += 1;
  }
};

const findOutermostBracketClose = (
  template: string,
  from: number,
  initialDepth: number,
): number => {
  let depth = initialDepth;
  let cursor = from;
  while (cursor < template.length) {
    if (template.startsWith('[[', cursor)) {
      const placeholderClose = template.indexOf(']]', cursor + 2);
      if (placeholderClose === -1) return -1;
      cursor = placeholderClose + 2;
      continue;
    }
    const char = template[cursor];
    if (char === '[') depth += 1;
    else if (char === ']') {
      depth -= 1;
      if (depth === 0) return cursor;
    }
    cursor += 1;
  }
  return -1;
};

const assertPlaceholderTextContext = (
  template: string,
  open: number,
  close: number,
  context: MarkdownPlaceholderContext,
): void => {
  advancePlaceholderContext(template, open, context);
  const lineStart = template.lastIndexOf('\n', open - 1) + 1;
  const linePrefix = template.slice(lineStart, open);
  const previousLineEnd = lineStart > 0 ? lineStart - 1 : -1;
  const previousLineStart = previousLineEnd >= 0
    ? template.lastIndexOf('\n', previousLineEnd - 1) + 1
    : 0;
  const previousLine = previousLineEnd >= 0
    ? template.slice(previousLineStart, previousLineEnd).replace(/\r$/, '')
    : '';

  // A response value is TEXT, never link/reference authority. Backslash
  // escaping is undone by Markdown parsers inside a destination, so merely
  // escaping ':' would not stop `javascript:` from becoming a live PDF link.
  if (context.inlineDestinationDepth > 0) {
    fail(
      'markdown_template_placeholder_context_invalid',
      'Markdown template placeholders cannot appear inside a link destination or title',
    );
  }
  if (
    /^[ \t]{0,3}\[[^\]\n]+\]:[^\n]*$/.test(linePrefix)
    || /^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*$/.test(previousLine)
  ) {
    fail(
      'markdown_template_placeholder_context_invalid',
      'Markdown template placeholders cannot appear inside a reference-link definition',
    );
  }

  // Bracketed text without an immediate, owner-authored inline destination is
  // a shortcut/reference label. Letting visitor text fill that label would let
  // it select among template-defined destinations. Values remain allowed in the
  // visible label of `[Hello [[response.name]]](https://fixed.example)`.
  if (context.bracketDepth > 0) {
    const outerClose = findOutermostBracketClose(
      template,
      close + 2,
      context.bracketDepth,
    );
    if (outerClose === -1 || template[outerClose + 1] !== '(') {
      fail(
        'markdown_template_placeholder_context_invalid',
        'Markdown template placeholders cannot select a shortcut or reference-link label',
      );
    }
  }

  // Pandoc attribute blocks can turn alphabetic values into ids/classes or
  // writer-specific attributes without requiring punctuation from the value.
  if (context.attributeDepth > 0) {
    fail(
      'markdown_template_placeholder_context_invalid',
      'Markdown template placeholders cannot appear inside an attribute block',
    );
  }
};

const prepareMarkdownTemplateRenderWithValues = (
  templateBytes: Buffer,
  values: ReadonlyMap<string, string>,
): PreparedRender => {
  if (templateBytes.length > MARKDOWN_TEMPLATE_MAX_BYTES) {
    fail(
      'markdown_template_too_large',
      `Markdown template exceeds ${MARKDOWN_TEMPLATE_MAX_BYTES} bytes`,
      413,
      { max_bytes: MARKDOWN_TEMPLATE_MAX_BYTES },
    );
  }
  const template = decodeUtf8(templateBytes);
  validateTemplateSource(template);
  const usedKeys: string[] = [];
  const usedKeySet = new Set<string>();
  const missingKeys: string[] = [];
  const missingKeySet = new Set<string>();
  const chunks: string[] = [];
  let outputBytes = 0;
  const pushChunk = (chunk: string): void => {
    outputBytes += Buffer.byteLength(chunk, 'utf8');
    if (outputBytes > MARKDOWN_TEMPLATE_OUTPUT_MAX_BYTES) {
      fail(
        'markdown_template_output_too_large',
        `Rendered Markdown exceeds ${MARKDOWN_TEMPLATE_OUTPUT_MAX_BYTES} bytes`,
        413,
        { max_bytes: MARKDOWN_TEMPLATE_OUTPUT_MAX_BYTES },
      );
    }
    chunks.push(chunk);
  };
  let cursor = 0;
  let placeholderCount = 0;
  const placeholderContext: MarkdownPlaceholderContext = {
    cursor: 0,
    inlineDestinationDepth: 0,
    attributeDepth: 0,
    bracketDepth: 0,
  };

  while (cursor < template.length) {
    const open = template.indexOf('[[', cursor);
    const strayClose = template.indexOf(']]', cursor);
    if (strayClose !== -1 && (open === -1 || strayClose < open)) {
      fail(
        'markdown_template_syntax_invalid',
        'Markdown template contains an unmatched closing placeholder delimiter',
      );
    }
    if (open === -1) {
      pushChunk(template.slice(cursor));
      break;
    }
    pushChunk(template.slice(cursor, open));
    const close = template.indexOf(']]', open + 2);
    if (close === -1) {
      fail(
        'markdown_template_syntax_invalid',
        'Markdown template contains an unclosed placeholder delimiter',
      );
    }
    assertPlaceholderTextContext(template, open, close, placeholderContext);
    const key = template.slice(open + 2, close);
    if (key.includes('[[') || !isAllowedKey(key)) {
      const placeholderPreview = diagnosticPreview(key);
      fail(
        'markdown_template_placeholder_invalid',
        `Markdown template placeholder ${placeholderPreview} is outside the closed grammar`,
        422,
        { placeholder_preview: placeholderPreview, placeholder_length: key.length },
      );
    }
    placeholderCount += 1;
    if (placeholderCount > MARKDOWN_TEMPLATE_MAX_PLACEHOLDERS) {
      fail(
        'markdown_template_placeholders_too_many',
        `Markdown template exceeds ${MARKDOWN_TEMPLATE_MAX_PLACEHOLDERS} placeholders`,
        413,
        { max_placeholders: MARKDOWN_TEMPLATE_MAX_PLACEHOLDERS },
      );
    }
    if (!usedKeySet.has(key)) {
      usedKeySet.add(key);
      usedKeys.push(key);
    }
    const value = values.get(key);
    if (value === undefined) {
      if (!missingKeySet.has(key)) {
        missingKeySet.add(key);
        missingKeys.push(key);
      }
    } else {
      pushChunk(escapeMarkdownTemplateValue(value));
    }
    cursor = close + 2;
    placeholderContext.cursor = cursor;
  }

  if (missingKeys.length > 0) {
    fail(
      'markdown_template_missing_values',
      `Markdown template is missing ${missingKeys.length} required value(s)`,
      422,
      { missing_keys: missingKeys },
    );
  }

  const content = chunks.join('');
  // Re-check the composed output: otherwise safe fragments around a placeholder
  // could combine with an alphabetic value into a Pandoc raw/resource construct.
  validateMarkdownSafety(content, 'Rendered Markdown');
  const contentBytes = Buffer.from(content, 'utf8');
  return {
    content,
    template_sha256: createHash('sha256').update(templateBytes).digest('hex'),
    content_sha256: createHash('sha256').update(contentBytes).digest('hex'),
    used_keys: usedKeys,
    missing_keys: [],
  };
};

/** Pure substitution core. It validates every supplied key/value before
 * parsing the template, tracks unique keys in first-use order, and throws on a
 * missing/unknown/malformed placeholder before a file is allocated. */
export const prepareMarkdownTemplateRender = (
  templateBytes: Buffer,
  valuesInput: unknown,
): PreparedRender => prepareMarkdownTemplateRenderWithValues(
  templateBytes,
  normalizeMarkdownTemplateValues(valuesInput),
);

export const handleMarkdownTemplateRender = async (
  deps: MarkdownTemplateRenderDeps,
  args: MarkdownTemplateRenderRequest,
): Promise<MarkdownTemplateRenderResponse> => {
  if (!isInboundFileRecordId(args.template_file_ref)) {
    fail(
      'bad_request',
      'markdown.template.render: template_file_ref must be a canonical local data.file ref',
      400,
    );
  }
  if (args.strict !== true) {
    fail('bad_request', 'markdown.template.render: strict must be true', 400);
  }
  if (typeof args.run_id !== 'string' || args.run_id.length === 0) {
    fail('bad_request', 'markdown.template.render: a run scope is required', 400);
  }

  // Validate every caller-controlled scalar/key/aggregate ceiling before the
  // first sensitive file read. Template-dependent missing-key checks follow
  // only after the exact source bytes are available.
  const values = normalizeMarkdownTemplateValues(args.values);
  const source = await deps.readFile({ record_id: args.template_file_ref });
  if (source.record_id !== args.template_file_ref) {
    fail(
      'markdown_template_source_mismatch',
      'Markdown template reader returned a different record id',
      422,
    );
  }
  if (
    typeof source.mime_type !== 'string'
    || !SUPPORTED_TEMPLATE_MIME_TYPES.has(source.mime_type)
  ) {
    const mimePreview = typeof source.mime_type === 'string'
      ? diagnosticPreview(source.mime_type)
      : typeof source.mime_type;
    fail(
      'markdown_template_mime_unsupported',
      `Markdown template MIME ${mimePreview} is unsupported`,
      415,
      { mime_type_preview: mimePreview },
    );
  }
  if (!Number.isSafeInteger(source.size_bytes) || source.size_bytes < 0) {
    fail(
      'markdown_template_bytes_invalid',
      'Markdown template has an invalid declared byte size',
      422,
    );
  }
  if (source.size_bytes > MARKDOWN_TEMPLATE_MAX_BYTES) {
    fail(
      'markdown_template_too_large',
      `Markdown template exceeds ${MARKDOWN_TEMPLATE_MAX_BYTES} bytes`,
      413,
      { max_bytes: MARKDOWN_TEMPLATE_MAX_BYTES },
    );
  }
  const expectedBase64Length = 4 * Math.ceil(source.size_bytes / 3);
  if (
    typeof source.bytes_b64 !== 'string'
    || source.bytes_b64.length !== expectedBase64Length
    || !CANONICAL_BASE64_RE.test(source.bytes_b64)
  ) {
    fail(
      'markdown_template_bytes_invalid',
      'Markdown template byte payload is not canonical bounded base64',
      422,
    );
  }
  const templateBytes = Buffer.from(source.bytes_b64, 'base64');
  if (
    templateBytes.length !== source.size_bytes
    || templateBytes.toString('base64') !== source.bytes_b64
  ) {
    fail(
      'markdown_template_bytes_invalid',
      'Markdown template byte payload does not match its declared size',
      422,
    );
  }
  const templateSha256 = createHash('sha256').update(templateBytes).digest('hex');
  if (
    typeof source.blob_hash !== 'string'
    || !/^[0-9a-f]{64}$/.test(source.blob_hash)
    || source.blob_hash !== templateSha256
  ) {
    fail(
      'markdown_template_hash_mismatch',
      'Markdown template bytes do not match their durable CAS hash',
      422,
    );
  }
  const prepared = prepareMarkdownTemplateRenderWithValues(templateBytes, values);
  const outDir = (deps.allocateScratchDir ?? allocateRunScratchDir)(args.run_id);
  const outputPath = join(outDir, 'rendered.md');
  writeFileSync(outputPath, prepared.content, { encoding: 'utf8', flag: 'wx' });
  const { content: _content, ...result } = prepared;
  return {
    ...result,
    file_ref: {
      backing: 'temp',
      path: outputPath,
      mime_type: 'text/markdown',
      filename: 'rendered.md',
    },
  };
};
