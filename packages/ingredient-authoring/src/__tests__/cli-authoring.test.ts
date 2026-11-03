import { describe, expect, it } from 'vitest';
import { CLI_OUTPUT_SHAPES, CLI_OUTPUT_STORAGES, CLI_STDIN_HANDLINGS, CLI_BINDING_ENV_NAMES, CLI_PROGRESS_ADAPTERS, CLI_PROGRESS_ANSWER_ADAPTERS } from '@recued/contracts';
import { cliAuthoringFields } from '../cli-authoring.js';

const keys = (section: Parameters<typeof cliAuthoringFields>[0], selection?: Parameters<typeof cliAuthoringFields>[1]) => cliAuthoringFields(section, selection).map(row => row.key);
describe('shared foreground CLI authoring metadata', () => {
  it('uses contract choices while leaving output retention and process policies explicit', () => {
    const fields = cliAuthoringFields('binding');
    expect(fields.find(row => row.key === 'shape')!.values).toEqual(CLI_OUTPUT_SHAPES);
    expect(fields.find(row => row.key === 'storage')!.values).toEqual(CLI_OUTPUT_STORAGES);
    expect(fields.find(row => row.key === 'stdin_handling')!.values).toEqual(CLI_STDIN_HANDLINGS);
    expect(fields.find(row => row.key === 'storage')!.description).toContain('run-scoped temp');
    expect(keys('binding')).not.toContain('detached'); expect(keys('env')).toEqual(CLI_BINDING_ENV_NAMES);
    expect(fields.find(row => row.key === 'exit_code_handling')!.required).toBe(true);
  });
  it('narrows progress fields by contract and answer capture by the host adapter vocabulary', () => {
    expect(keys('progress')).toEqual(['contract', 'stall_ms']);
    expect(keys('progress', { mode: 'file-growth' })).toEqual(['contract', 'stall_ms', 'watch_path']);
    expect(keys('progress', { mode: 'heartbeat' })).toContain('first_output_ms');
    expect(cliAuthoringFields('progress', { mode: 'heartbeat' }).find(row => row.key === 'adapter')!.values).toEqual(CLI_PROGRESS_ADAPTERS);
    expect(cliAuthoringFields('progress', { mode: 'heartbeat', answerCapture: true }).find(row => row.key === 'adapter')!.values).toEqual(CLI_PROGRESS_ANSWER_ADAPTERS);
    expect(keys('progress', { mode: 'invented' })).not.toContain('adapter');
  });
  it('keeps capture sources exclusive and exposes filename only for authored stream or answer captures', () => {
    expect(keys('capture')).toEqual(['dir_arg', 'from_input_arg', 'from_stdout', 'from_progress_answer', 'mime_type']);
    expect(keys('capture', { captureKeys: ['dir_arg'] })).toEqual(['dir_arg', 'mime_type']);
    expect(keys('capture', { captureKeys: ['from_input_arg'] })).toEqual(['from_input_arg', 'mime_type']);
    const selection = { captureKeys: ['from_stdout'] }, before = JSON.stringify(selection);
    expect(keys('capture', selection)).toEqual(['from_stdout', 'mime_type', 'filename']);
    expect(cliAuthoringFields('capture', selection)[0]!.values).toEqual([true]); expect(JSON.stringify(selection)).toBe(before);
    expect(keys('capture', { captureKeys: ['dir_arg', 'from_stdout'] })).toEqual(['mime_type']);
    expect(keys('capture', { captureKeys: ['__proto__'] })).toEqual(['mime_type']);
  });
  it('requires a chosen materialization kind before showing scalar or array settings and keeps argv objects distinct', () => {
    expect(keys('materialize')).toEqual(['kind']);
    expect(keys('materialize', { mode: 'file_ref' })).toEqual(['kind', 'arg']);
    expect(keys('materialize', { mode: 'file_ref_array' })).toEqual(['kind', 'arg', 'min_items', 'max_items']);
    expect(cliAuthoringFields('materialize', { mode: 'file_ref_array' }).find(row => row.key === 'max_items')!.type).toBe('number');
    expect(keys('exit')).toEqual(['success_codes']); expect(keys('expansion')).toEqual(['expand_arg']); expect(keys('cwd')).toEqual(['arg']);
  });
});
