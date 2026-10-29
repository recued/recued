import { describe, expect, it, vi } from 'vitest';
import { handleCsvInspect, handleCsvTransform, type CsvToolkitDeps } from '../collections/file/csv-toolkit-handler.js';

const fixture = (source: () => string) => {
  const files = new Map<string, Buffer>();
  const readFile = vi.fn(async ({ record_id }: { record_id: string }) => ({
    record_id, bytes_b64: (files.get(record_id) ?? Buffer.from(source(), 'utf8')).toString('base64'),
  }));
  const ingest = vi.fn(async (input: { bytes: Buffer; filename: string; mime_type: string }) => {
    const record_id = `file:output-${files.size}`;
    files.set(record_id, input.bytes);
    return { record_id };
  });
  const deps: CsvToolkitDeps = { reader: { readFile }, ingest };
  return { deps, readFile, ingest };
};

describe('CSV Toolkit source consistency and exact encoding', () => {
  it('saves no partial artifact when a later mapping, sort value or duplicate fails', async () => {
    const f = fixture(() => 'id,n\n1,2\n1,0\n');
    for (const args of [
      { operation: 'map', mappings: [{ as: 'inverse', expression: { op: 'divide', left: { value: '1' }, right: { column: 'n' } } }] },
      { operation: 'sort', by: [{ column: 'missing' }], limit: 1 },
      { operation: 'deduplicate', keys: ['id'] },
    ]) await expect(handleCsvTransform(f.deps, { source: 'file:one', ...args })).rejects.toThrow();
    expect(f.ingest).not.toHaveBeenCalled();
  });
  it('compares a changing source with one snapshot of itself and reads afresh on the next call', async () => {
    let version = 0;
    const f = fixture(() => `id,value\n1,${++version}\n`);
    const args = { source: 'file:live', other_source: 'file:live', operation: 'diff', keys: ['id'] };
    const first = await handleCsvTransform(f.deps, args);
    expect(first.counts).toMatchObject({ changed: 0, added: 0, removed: 0, unchanged: 1 });
    expect(first.sources[0]!.content_hash).toBe(first.sources[1]!.content_hash);
    expect(f.readFile).toHaveBeenCalledTimes(1);
    const second = await handleCsvTransform(f.deps, args);
    expect(second.counts.unchanged).toBe(1);
    expect(second.sources[0]!.content_hash).toBe(second.sources[1]!.content_hash);
    expect(second.sources[0]!.content_hash).not.toBe(first.sources[0]!.content_hash);
    expect(f.readFile).toHaveBeenCalledTimes(2);
  });

  it('uses the same bytes when the two inputs parse one file with different delimiters', async () => {
    const f = fixture(() => 'a,b;c\n1,2;3\n');
    const result = await handleCsvTransform(f.deps, { operation: 'concat', source: 'file:one',
      other_source: 'file:one', delimiter: ',', other_delimiter: ';', schema: 'union' });
    expect(result.columns).toEqual(['a', 'b;c', 'a,b', 'c']);
    expect(result.preview).toEqual([['1', '2;3', '', ''], ['', '', '1,2', '3']]);
    expect(result.sources[0]!.content_hash).toBe(result.sources[1]!.content_hash);
    expect(f.readFile).toHaveBeenCalledTimes(1);
  });

  it('strips the encoding BOM once and preserves literal BOMs and emoji in saved column names', async () => {
    const f = fixture(() => '\ufeff\ufeffid,💼\n001,Ω\n');
    const original = await handleCsvInspect(f.deps, { source: 'file:one' });
    expect(original.columns).toEqual(['\ufeffid', '💼']);
    const saved = await handleCsvTransform(f.deps, { source: 'file:one', operation: 'project',
      columns: original.columns, names: ['\ufeffrenamed', '💼'] });
    const reread = await handleCsvInspect(f.deps, { source: saved.file_ref });
    expect(reread.columns).toEqual(saved.columns);
    expect(reread.preview).toEqual(saved.preview);
    expect(reread.source.content_hash).toBe(saved.content_hash);
  });

  it('rejects a rename that UTF-8 would change before reading or saving a file', async () => {
    const f = fixture(() => 'id\n001\n');
    await expect(handleCsvTransform(f.deps, { source: 'file:one', operation: 'project',
      columns: ['id'], names: ['\ud800id'] })).rejects.toThrow(/Unicode/);
    expect(f.readFile).not.toHaveBeenCalled(); expect(f.ingest).not.toHaveBeenCalled();
  });
});
