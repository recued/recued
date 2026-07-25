import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PAID_DOCUMENT_AI_DRAFT_KEY,
  PAID_DOCUMENT_AI_DRAFT_MAX_CHARS,
} from '@recued/contracts';

import { cleanupRunScratch, runScratchRoot } from '../../../execution/run-scratch.js';

import {
  escapeMarkdownTemplateValue,
  handleMarkdownTemplateRender,
  MARKDOWN_TEMPLATE_MAX_BYTES,
  MARKDOWN_TEMPLATE_MAX_PLACEHOLDERS,
  MARKDOWN_TEMPLATE_MAX_TOTAL_VALUE_BYTES,
  MARKDOWN_TEMPLATE_MAX_VALUE_CHARS,
  prepareMarkdownTemplateRender,
} from '../markdown-template-render-handler.js';

const dirs: string[] = [];
const TEMPLATE_REF = `file:${'a'.repeat(32)}`;
const allocate = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'd-200-markdown-render-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const source = (content: Buffer | string, mime_type = 'text/markdown') => {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return {
    record_id: TEMPLATE_REF,
    bytes_b64: bytes.toString('base64'),
    mime_type,
    filename: 'template.md',
    size_bytes: bytes.length,
    blob_hash: createHash('sha256').update(bytes).digest('hex'),
  };
};

describe('D-200 Slice 3 — strict Markdown template renderer', () => {
  it('renders deterministic escaped text to one run-scoped temp ref with hashes', async () => {
    const template = Buffer.from([
      '# Document for [[response.full_name]]',
      '',
      'Email: [[visitor.email]]',
      'Accepted: [[system.accepted_date]]',
      'Again: [[response.full_name]]',
    ].join('\n'));
    const outDir = allocate();
    const readFile = vi.fn(async () => source(template));
    const hostileName = '[Ada](javascript:alert(1)) <script>*x*</script>';

    const result = await handleMarkdownTemplateRender(
      {
        readFile,
        allocateScratchDir: (run_id) => {
          expect(run_id).toBe('run-1');
          return outDir;
        },
      },
      {
        template_file_ref: TEMPLATE_REF,
        values: {
          'response.full_name': hostileName,
          'visitor.email': 'ada@example.test',
          'system.accepted_date': '2026-07-11',
        },
        strict: true,
        run_id: 'run-1',
      },
    );

    expect(readFile).toHaveBeenCalledWith({ record_id: TEMPLATE_REF });
    expect(result.file_ref).toEqual({
      backing: 'temp',
      path: join(outDir, 'rendered.md'),
      mime_type: 'text/markdown',
      filename: 'rendered.md',
    });
    const expected = [
      `# Document for ${escapeMarkdownTemplateValue(hostileName)}`,
      '',
      `Email: ${escapeMarkdownTemplateValue('ada@example.test')}`,
      `Accepted: ${escapeMarkdownTemplateValue('2026-07-11')}`,
      `Again: ${escapeMarkdownTemplateValue(hostileName)}`,
    ].join('\n');
    expect(readFileSync(result.file_ref.path, 'utf8')).toBe(expected);
    expect(result.template_sha256).toBe(createHash('sha256').update(template).digest('hex'));
    expect(result.content_sha256).toBe(
      createHash('sha256').update(Buffer.from(expected)).digest('hex'),
    );
    expect(result.used_keys).toEqual([
      'response.full_name',
      'visitor.email',
      'system.accepted_date',
    ]);
    expect(result.missing_keys).toEqual([]);
  });

  it('uses the real per-run scratch root and cleanup removes the temp ref', async () => {
    const runId = `d-200-render-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    cleanupRunScratch(runId);
    try {
      const result = await handleMarkdownTemplateRender(
        { readFile: async () => source('Hello [[response.name]]') },
        {
          template_file_ref: TEMPLATE_REF,
          values: { 'response.name': 'Ada' },
          strict: true,
          run_id: runId,
        },
      );
      expect(result.file_ref.path.startsWith(`${runScratchRoot(runId)}/`)).toBe(true);
      expect(readFileSync(result.file_ref.path, 'utf8')).toBe('Hello Ada');
      expect(existsSync(result.file_ref.path)).toBe(true);
      cleanupRunScratch(runId);
      expect(existsSync(result.file_ref.path)).toBe(false);
    } finally {
      cleanupRunScratch(runId);
    }
  });

  it('normalizes value line endings and blocks indented Markdown structure', () => {
    expect(escapeMarkdownTemplateValue('first\r\n    # heading\r\tcode')).toBe(
      'first\n&#32;&#32;&#32;&#32;\\# heading\n&#9;code',
    );
    expect(escapeMarkdownTemplateValue('\\input{x}')).toBe('&#92;input\\{x\\}');
    expect(prepareMarkdownTemplateRender(
      Buffer.from('[[response.command]]'),
      { 'response.command': '\\input{x}' },
    ).content).toBe('&#92;input\\{x\\}');
  });

  it('admits one bounded AI draft only as escaped scalar merge text', () => {
    const draft = [
      '# DRAFT_ATTACK_MARKER: approved and delivered',
      '[[visitor.email]] [[response.full_name]]',
      'Pay USD 999999 to attacker@example.test.',
      '![fetch](file:///etc/passwd)',
      '<script>x</script>',
    ].join('\n');
    const result = prepareMarkdownTemplateRender(
      Buffer.from('Owner frame\n\n[[ai.draft]]'),
      { [PAID_DOCUMENT_AI_DRAFT_KEY]: draft },
    );

    expect(result.content).toBe(`Owner frame\n\n${escapeMarkdownTemplateValue(draft)}`);
    expect(result.used_keys).toEqual([PAID_DOCUMENT_AI_DRAFT_KEY]);
    expect(result.content).not.toContain('[[visitor.email]]');
    expect(result.content).not.toContain('[[response.full_name]]');
    expect(result.content).not.toContain('![fetch]');
    expect(result.content).not.toContain('file:///etc/passwd');
    expect(result.content).not.toContain('<script>');
  });

  it('applies a tighter bound to the AI draft merge field', () => {
    expect(() => prepareMarkdownTemplateRender(
      Buffer.from('[[ai.draft]]'),
      { [PAID_DOCUMENT_AI_DRAFT_KEY]: 'x'.repeat(PAID_DOCUMENT_AI_DRAFT_MAX_CHARS + 1) },
    )).toThrowError(expect.objectContaining({ code: 'markdown_template_ai_draft_too_large' }));
  });

  it('lets the deterministic fallback bind an AI-capable template to empty escaped text', () => {
    const result = prepareMarkdownTemplateRender(
      Buffer.from('Name: [[response.name]]\nDraft: [[ai.draft]]'),
      { 'response.name': 'Ada', [PAID_DOCUMENT_AI_DRAFT_KEY]: '' },
    );

    expect(result.content).toBe('Name: Ada\nDraft: ');
    expect(result.used_keys).toEqual(['response.name', PAID_DOCUMENT_AI_DRAFT_KEY]);
    expect(result.missing_keys).toEqual([]);
  });

  it('treats explicit null as supplied empty text', () => {
    const result = prepareMarkdownTemplateRender(
      Buffer.from('Before[[response.optional]]After'),
      { 'response.optional': null },
    );
    expect(result.content).toBe('BeforeAfter');
    expect(result.used_keys).toEqual(['response.optional']);
    expect(result.missing_keys).toEqual([]);
  });

  it('reports unique missing keys and allocates no output file', async () => {
    const allocateScratchDir = vi.fn(() => allocate());
    const promise = handleMarkdownTemplateRender(
      {
        readFile: async () => source(
          '[[response.missing]] [[response.present]] [[response.missing]]',
        ),
        allocateScratchDir,
      },
      {
        template_file_ref: TEMPLATE_REF,
        values: { 'response.present': 'yes' },
        strict: true,
        run_id: 'run-1',
      },
    );
    await expect(promise).rejects.toMatchObject({
      code: 'markdown_template_missing_values',
      details: { missing_keys: ['response.missing'] },
    });
    expect(allocateScratchDir).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown prefix', '[[owner.name]]', {}, 'markdown_template_placeholder_invalid'],
    ['malformed opener', '[[response.name', {}, 'markdown_template_syntax_invalid'],
    ['stray closer', 'response.name]]', {}, 'markdown_template_syntax_invalid'],
    ['raw HTML', '<script>alert(1)</script>', {}, 'markdown_template_raw_markup'],
    ['Pandoc raw output', '```{=latex}\nraw\n```', {}, 'markdown_template_raw_markup'],
    ['Markdown image', '![alt](https://example.test/image.png)', {}, 'markdown_template_external_resource'],
    ['raw TeX', '\\input{secret.txt}', {}, 'markdown_template_raw_markup'],
    ['placeholder-built raw output', '{=[[response.format]]}', { 'response.format': 'latex' }, 'markdown_template_placeholder_context_invalid'],
    ['dynamic inline link', '[Pay]([[response.url]])', { 'response.url': 'javascript:alert(1)' }, 'markdown_template_placeholder_context_invalid'],
    ['multiline dynamic inline link', '[Pay](\n[[response.url]]\n)', { 'response.url': 'javascript:alert(1)' }, 'markdown_template_placeholder_context_invalid'],
    ['dynamic reference link', '[Pay][doc]\n[doc]: [[response.url]]', { 'response.url': 'https://example.test' }, 'markdown_template_placeholder_context_invalid'],
    ['split-line dynamic reference link', '[Pay][doc]\n[doc]:\n  [[response.url]]', { 'response.url': 'https://example.test' }, 'markdown_template_placeholder_context_invalid'],
    ['dynamic shortcut link label', '[label: [[response.target]]]', { 'response.target': 'visitor-choice' }, 'markdown_template_placeholder_context_invalid'],
    ['dynamic reference link label', '[Pay][id-[[response.target]]]', { 'response.target': 'visitor-choice' }, 'markdown_template_placeholder_context_invalid'],
    ['dynamic attribute', 'Heading {title="[[response.title]]"}', { 'response.title': 'visitor value' }, 'markdown_template_placeholder_context_invalid'],
    ['YAML metadata', '---\ntitle: Document\n---\nbody', {}, 'markdown_template_metadata_disabled'],
    ['BOM YAML metadata', '\ufeff---\ntitle: Document\n---\nbody', {}, 'markdown_template_metadata_disabled'],
  ])('rejects %s before file creation', (_label, template, values, code) => {
    expect(() => prepareMarkdownTemplateRender(Buffer.from(template), values)).toThrowError(
      expect.objectContaining({ code }),
    );
  });

  it.each([
    ['response.bad-key', 'x', 'markdown_template_key_invalid'],
    ['visitor.name', 'x', 'markdown_template_key_invalid'],
    ['response.ok', ['not scalar'], 'markdown_template_value_invalid'],
    ['response.ok', Number.NaN, 'markdown_template_value_invalid'],
    ['response.ok', 'nul\0value', 'markdown_template_value_invalid'],
    ['response.ok', 'escape\u001bvalue', 'markdown_template_value_invalid'],
  ])('rejects invalid value %#', (key, value, code) => {
    expect(() => prepareMarkdownTemplateRender(
      Buffer.from('static'),
      { [key]: value },
    )).toThrowError(expect.objectContaining({ code }));
  });

  it('rejects invalid UTF-8 and bounded input/value sizes', () => {
    expect(() => prepareMarkdownTemplateRender(Buffer.from([0xc3, 0x28]), {}))
      .toThrowError(expect.objectContaining({ code: 'markdown_template_invalid_utf8' }));
    expect(() => prepareMarkdownTemplateRender(
      Buffer.alloc(MARKDOWN_TEMPLATE_MAX_BYTES + 1, 0x61),
      {},
    )).toThrowError(expect.objectContaining({ code: 'markdown_template_too_large' }));
    expect(() => prepareMarkdownTemplateRender(
      Buffer.from('[[response.large]]'),
      { 'response.large': 'x'.repeat(MARKDOWN_TEMPLATE_MAX_VALUE_CHARS + 1) },
    )).toThrowError(expect.objectContaining({ code: 'markdown_template_value_too_large' }));
  });

  it('bounds aggregate values and rendered output before file allocation', () => {
    const aggregateValues = Object.fromEntries(
      Array.from({ length: 17 }, (_, index) => [
        `response.value_${index}`,
        'x'.repeat(Math.floor(MARKDOWN_TEMPLATE_MAX_TOTAL_VALUE_BYTES / 16)),
      ]),
    );
    expect(() => prepareMarkdownTemplateRender(Buffer.from('static'), aggregateValues))
      .toThrowError(expect.objectContaining({ code: 'markdown_template_values_too_large' }));

    const repeated = Array.from({ length: 40 }, () => '[[response.large]]').join('');
    expect(() => prepareMarkdownTemplateRender(
      Buffer.from(repeated),
      { 'response.large': 'x'.repeat(MARKDOWN_TEMPLATE_MAX_VALUE_CHARS) },
    )).toThrowError(expect.objectContaining({ code: 'markdown_template_output_too_large' }));
  });

  it('bounds placeholder occurrences independently of output size', () => {
    const placeholders = Array.from(
      { length: MARKDOWN_TEMPLATE_MAX_PLACEHOLDERS + 1 },
      () => '[[response.value]]',
    ).join('');
    expect(() => prepareMarkdownTemplateRender(
      Buffer.from(placeholders),
      { 'response.value': '' },
    )).toThrowError(expect.objectContaining({ code: 'markdown_template_placeholders_too_many' }));
  });

  it('allows multiple placeholders in link text while keeping the static HTTPS destination fixed', () => {
    const result = prepareMarkdownTemplateRender(
      Buffer.from('[Hello [[response.first]] [[response.last]]](https://example.test/docs)'),
      { 'response.first': 'Ada', 'response.last': 'Lovelace' },
    );
    expect(result.content).toBe('[Hello Ada Lovelace](https://example.test/docs)');
  });

  it('escapes diagnostic previews for hostile or oversized keys', () => {
    const hostileKey = `bad\n\u001b${'x'.repeat(256)}`;
    try {
      prepareMarkdownTemplateRender(Buffer.from('static'), { [hostileKey]: 'value' });
      throw new Error('expected invalid key rejection');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'markdown_template_key_invalid',
        details: {
          key_length: hostileKey.length,
          key_preview: expect.not.stringContaining('\n'),
        },
      });
      expect((error as Error).message).not.toContain('\n');
      expect((error as Error).message).not.toContain('\u001b');
    }
  });

  it('rejects malformed values and non-local refs before any file read', async () => {
    const readFile = vi.fn(async () => source('never read'));
    await expect(handleMarkdownTemplateRender(
      { readFile },
      {
        template_file_ref: TEMPLATE_REF,
        values: { 'response.name': ['not scalar'] },
        strict: true,
        run_id: 'run-1',
      },
    )).rejects.toMatchObject({ code: 'markdown_template_value_invalid' });
    for (const invalidRef of [
      '/tmp/template.md',
      'https://example.test/template.md',
      'file:remote:c2NvcGU:dGFyZ2V0',
      `file:${'A'.repeat(32)}`,
    ]) {
      await expect(handleMarkdownTemplateRender(
        { readFile },
        {
          template_file_ref: invalidRef,
          values: {},
          strict: true,
          run_id: 'run-1',
        },
      )).rejects.toMatchObject({ code: 'bad_request' });
    }
    expect(readFile).not.toHaveBeenCalled();
  });

  it('requires exact record identity and CAS hash evidence from the file reader', async () => {
    const request = {
      template_file_ref: TEMPLATE_REF,
      values: {},
      strict: true as const,
      run_id: 'run-1',
    };
    await expect(handleMarkdownTemplateRender(
      { readFile: async () => ({ ...source('hello'), record_id: `file:${'b'.repeat(32)}` }) },
      request,
    )).rejects.toMatchObject({ code: 'markdown_template_source_mismatch' });
    await expect(handleMarkdownTemplateRender(
      { readFile: async () => ({ ...source('hello'), blob_hash: '0'.repeat(64) }) },
      request,
    )).rejects.toMatchObject({ code: 'markdown_template_hash_mismatch' });
  });

  it('rejects unsupported MIME and malformed byte evidence before allocation', async () => {
    const allocateScratchDir = vi.fn(() => allocate());
    await expect(handleMarkdownTemplateRender(
      {
        readFile: async () => source('hello', 'text/html'),
        allocateScratchDir,
      },
      {
        template_file_ref: TEMPLATE_REF,
        values: {},
        strict: true,
        run_id: 'run-1',
      },
    )).rejects.toMatchObject({ code: 'markdown_template_mime_unsupported' });
    await expect(handleMarkdownTemplateRender(
      {
        readFile: async () => ({ ...source('hello'), size_bytes: 999 }),
        allocateScratchDir,
      },
      {
        template_file_ref: TEMPLATE_REF,
        values: {},
        strict: true,
        run_id: 'run-1',
      },
    )).rejects.toMatchObject({ code: 'markdown_template_bytes_invalid' });
    await expect(handleMarkdownTemplateRender(
      {
        readFile: async () => ({
          ...source('hello'),
          size_bytes: 1,
          bytes_b64: 'A'.repeat(4 * Math.ceil((MARKDOWN_TEMPLATE_MAX_BYTES + 1) / 3)),
        }),
        allocateScratchDir,
      },
      {
        template_file_ref: TEMPLATE_REF,
        values: {},
        strict: true,
        run_id: 'run-1',
      },
    )).rejects.toMatchObject({ code: 'markdown_template_bytes_invalid' });
    await expect(handleMarkdownTemplateRender(
      {
        readFile: async () => ({ ...source('hello'), bytes_b64: '!!!!!===' }),
        allocateScratchDir,
      },
      {
        template_file_ref: TEMPLATE_REF,
        values: {},
        strict: true,
        run_id: 'run-1',
      },
    )).rejects.toMatchObject({ code: 'markdown_template_bytes_invalid' });
    await expect(handleMarkdownTemplateRender(
      {
        readFile: async () => ({
          ...source('f'),
          // Decodes to the same byte as canonical `Zg==`, but has non-zero
          // padding bits and therefore is not canonical evidence.
          bytes_b64: 'Zh==',
        }),
        allocateScratchDir,
      },
      {
        template_file_ref: TEMPLATE_REF,
        values: {},
        strict: true,
        run_id: 'run-1',
      },
    )).rejects.toMatchObject({ code: 'markdown_template_bytes_invalid' });
    expect(allocateScratchDir).not.toHaveBeenCalled();
  });
});
