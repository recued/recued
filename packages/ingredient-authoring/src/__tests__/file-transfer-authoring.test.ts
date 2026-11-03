import { describe, expect, it } from 'vitest';
import { restFileTransferFields } from '../file-transfer-authoring.js';
import { operationBindingArgumentReferences } from '../binding-argument-references.js';
import { validateComposition } from '../validators.js';
import { decomposeComposition } from '../decomposer.js';
import type { CompositionIngredient } from '@recued/contracts';

const composition = (): CompositionIngredient => ({ schema_version: 1, slug: 'file-api', catalog_kind: 'official',
  ingredients: [{ slug: 'file-api', kind: 'http', http: { base: 'https://api.example.com' } }],
  operations: [{ op: 'file.download', ingredient: 'file-api', risk: 'read', approval: 'never', args: ['filename', { key: 'file', type: 'file_ref' }],
    bind: { kind: 'rest', method: 'GET', path_template: '/files' } }],
});
describe('shared REST file authoring contracts', () => {
  it('keeps all filename choices aligned with canonical validation and preserves capture metadata through lowering', () => {
    const choices = restFileTransferFields('filename').find(field => field.key === 'kind')!.choices!;
    for (const { value } of choices) {
      const body = composition(), op = body.operations[0] as any;
      op.bind.response_capture = { kind: 'file_ref', mime_type: 'application/pdf', filename_source: { kind: value, ...(value === 'static' ? { value: 'report.pdf' } : value === 'arg' ? { arg: 'filename' } : {}) }, ai_enrichment: 'opt_out' };
      expect(validateComposition(body).valid).toBe(true);
      expect((decomposeComposition[1](body).catalog!.surfaces!.api!.executes!['file.download'] as any).response_capture).toEqual(op.bind.response_capture);
      op.bind.response_capture.filename_source.kind += '_typo';
      expect(validateComposition(body).issues.some(issue => issue.code === 'composition_rest_response_capture_filename_kind')).toBe(true);
    }
  });
  it('exposes only the selected filename fields and never chooses an enrichment policy or provider value', () => {
    expect(restFileTransferFields('filename', 'header').map(field => field.key)).toEqual(['kind']);
    expect(restFileTransferFields('filename', 'static').find(field => field.key === 'value')!.required).toBe(true);
    expect(restFileTransferFields('filename', 'arg').find(field => field.key === 'arg')!.required).toBe(true);
    expect(restFileTransferFields('filename', 'unknown').map(field => field.key)).toEqual(['kind']);
    const opt = restFileTransferFields('capture', 'file_ref').find(field => field.key === 'ai_enrichment')!;
    expect(opt.required).toBe(false); expect(opt.description).toContain('Omit this setting');
    expect(restFileTransferFields('capture', 'file_ref').find(field => field.key === 'mime_type')!.choices).toBeUndefined();
  });
  it('distinguishes one-shot uploads and applies their lower-only ceiling independently of chunked protocol fields', () => {
    const body = composition(), op = body.operations[0] as any; op.risk = 'write'; op.approval = 'ask'; op.bind.method = 'POST';
    for (const kind of ['binary', 'multipart']) {
      op.bind.upload = { kind, arg: 'file', max_bytes: 1024, ...(kind === 'multipart' ? { field: 'attachment' } : {}) };
      expect(validateComposition(body).valid).toBe(true);
      expect(restFileTransferFields('upload', kind).some(field => field.key === 'field')).toBe(kind === 'multipart');
      op.bind.upload.max_bytes = 26 * 1024 * 1024;
      expect(validateComposition(body).issues.some(issue => issue.code === 'composition_http_upload_max_bytes')).toBe(true);
    }
    expect(restFileTransferFields('upload', 'chunked').map(field => field.key)).toEqual(['kind']);
  });
  it('shares file-mode admission with canonical checks and keeps typed selector fields distinct from actual string references', () => {
    const body = composition(), op = body.operations[0] as any;
    op.bind.response_capture = { kind: 'file-ref', filename_source: { kind: 'header' }, ai_enrichment: 'opt-oot' };
    expect(validateComposition(body).issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['composition_rest_response_capture_kind', 'composition_rest_response_capture_ai_enrichment']));
    op.bind.upload = { kind: 'bniary', arg: null };
    const usage = operationBindingArgumentReferences(op);
    expect(usage.fields.find(field => field.path.join('.') === 'bind.upload.arg')!.argumentType).toBe('file_ref');
    expect(usage.references.some(site => site.path.join('.') === 'bind.upload.arg')).toBe(false);
    expect(validateComposition(body).issues.some(issue => issue.code === 'composition_http_upload_kind')).toBe(true);
    op.bind.response_capture.filename_source = { kind: 'arg', arg: 'filename' };
    expect(operationBindingArgumentReferences(op).fields.find(field => field.path.join('.') === 'bind.response_capture.filename_source.arg')!.argumentType).toBe('string');
  });
});
