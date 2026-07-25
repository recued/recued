import { describe, expect, it } from 'vitest';

import type { TempFileRef } from '@recued/contracts';
import { createKernelAdapter } from '../kernel.js';

const TEMP_REF: TempFileRef = {
  backing: 'temp',
  path: '/tmp/recued-run-scratch/run-1/op-x/rendered.md',
  mime_type: 'text/markdown',
  filename: 'rendered.md',
};

const RESULT = {
  file_ref: TEMP_REF,
  template_sha256: 'a'.repeat(64),
  content_sha256: 'b'.repeat(64),
  used_keys: ['response.full_name'],
  missing_keys: [],
};
const TEMPLATE_REF = `file:${'a'.repeat(32)}`;

const call = (
  input: Record<string, unknown>,
  run_id: string | null = 'run-1',
) => ({
  slug: 'file-render-markdown-template',
  risk_tier: 'write',
  input,
  output: {},
  ...(run_id === null ? {} : { stepMeta: { step_id: 'render', run_id } }),
}) as Parameters<ReturnType<typeof createKernelAdapter>>[0];

describe('D-200 Slice 3 — Markdown template kernel adapter', () => {
  it('forwards only the closed input and engine-supplied run scope', async () => {
    let captured: unknown;
    const adapter = createKernelAdapter({
      markdownTemplateRender: async (input) => {
        captured = input;
        return RESULT;
      },
    });
    const values = { 'response.full_name': 'Ada' };

    await expect(adapter(call({
      template_file_ref: TEMPLATE_REF,
      values,
      strict: true,
    }))).resolves.toBe(RESULT);
    expect(captured).toEqual({
      template_file_ref: TEMPLATE_REF,
      values,
      strict: true,
      run_id: 'run-1',
    });
  });

  it('fails closed without the renderer dispatcher', async () => {
    const adapter = createKernelAdapter({});
    await expect(adapter(call({
      template_file_ref: TEMPLATE_REF,
      values: {},
      strict: true,
    }))).rejects.toMatchObject({ code: 'SERVER_NOT_REACHABLE' });
  });

  it.each([
    [{ values: {}, strict: true }, 'template_file_ref'],
    [{ template_file_ref: TEMPLATE_REF, values: [], strict: true }, 'values'],
    [{ template_file_ref: TEMPLATE_REF, values: {}, strict: false }, 'strict'],
  ])('rejects malformed input %#', async (input, field) => {
    const adapter = createKernelAdapter({ markdownTemplateRender: async () => RESULT });
    await expect(adapter(call(input))).rejects.toMatchObject({
      code: 'BAD_INPUT',
      message: expect.stringContaining(field),
    });
  });

  it.each(['run_id', 'path', 'raw', 'flags'])('rejects undeclared authored input %s', async (key) => {
    const adapter = createKernelAdapter({ markdownTemplateRender: async () => RESULT });
    await expect(adapter(call({
      template_file_ref: TEMPLATE_REF,
      values: {},
      strict: true,
      [key]: key === 'raw' ? true : 'recipe-controlled',
    }))).rejects.toMatchObject({
      code: 'BAD_INPUT',
      message: expect.stringContaining('unknown input'),
    });
  });

  it('requires an engine-supplied run scope', async () => {
    const adapter = createKernelAdapter({ markdownTemplateRender: async () => RESULT });
    await expect(adapter(call({
      template_file_ref: TEMPLATE_REF,
      values: {},
      strict: true,
    }, null))).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });
});
