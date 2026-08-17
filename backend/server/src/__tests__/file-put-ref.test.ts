/** D-245 — `file-put-ref`: a file the RECIPE names, filled from a ref.
 *
 *  🔑 THE KNOT THIS UNTIES. A recipe could own a file two ways and neither was
 *  usable as a durable, self-owned artifact:
 *
 *    - a CAS record takes big content without it ever touching step state, but
 *      its id is CONTENT-DERIVED — it changes whenever the content does, so the
 *      recipe cannot name it in advance and has to keep a note saying "the file
 *      I mean is currently called this";
 *    - a `{slug, path}` record has a stable name the recipe chooses, and
 *      `file-stat` already answers `{exists, modified_at_ms}` over it — but its
 *      only writer takes `body_b64`, so a 10 MB file round-trips through step
 *      state to get in.
 *
 *  ⇒ a stable NAME or memory-safe BYTES, never both. Every workaround this
 *  removes — the `data.shared` mark holding a current id, the eTag comparison
 *  deciding whether that note is still true — existed because of that knot, not
 *  because anyone chose it.
 */

import { describe, expect, it } from 'vitest';

import { handleFilePutRef, FILE_PUT_REF_MAX_BYTES } from '../collections/file/dispatcher.js';

const BYTES = 'Name,Email\nAcme,ops@acme.test\n';

const rig = (over: { write?: 'yes' | 'no'; live?: boolean; bytes?: string } = {}) => {
  const writes: Array<{ path: string; body: Buffer; mime?: string }> = [];
  const reads: string[] = [];
  const deps = {
    instances: {
      get: (_platform: string, slug: string) =>
        slug === 'vault'
          ? {
            slug,
            platform: 'file',
            adapter_type: 'fs',
            auth_state: 'healthy',
            caps: { read: 'yes', write: over.write ?? 'yes', delete: 'yes' },
          }
          : undefined,
    },
    getAdapter: (slug: string) =>
      over.live === false || slug !== 'vault'
        ? undefined
        : {
          // ⚠ All four — `isMutationCapable` narrows on writeRecord, deleteRecord,
          // readRecord AND statRecord all being functions. A double missing two of
          // them fails the gate for a reason that has nothing to do with the test.
          writeRecord: async (path: string, body: Buffer, mime?: string) => {
            writes.push({ path, body, mime });
          },
          deleteRecord: async () => {},
          readRecord: async () => ({ body: Buffer.alloc(0) }),
          statRecord: async () => ({ exists: false }),
        },
    readFile: async ({ record_id }: { record_id: string }) => {
      reads.push(record_id);
      return {
        bytes_b64: Buffer.from(over.bytes ?? BYTES, 'utf8').toString('base64'),
        mime_type: 'text/csv',
      };
    },
  };
  return { deps, writes, reads };
};

const call = (over = {}) => ({
  slug: 'vault', path: 'sheets/customers.csv', ref: `file:${'a'.repeat(32)}`, ...over,
});

describe('file-put-ref', () => {
  it('writes the ref bytes into the named record', async () => {
    const { deps, writes, reads } = rig();
    const r = await handleFilePutRef(deps as never, call());

    expect(r).toMatchObject({
      ok: true, bytes_written: Buffer.byteLength(BYTES), slug: 'vault', path: 'sheets/customers.csv',
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]!.path).toBe('sheets/customers.csv');
    expect(writes[0]!.body.toString('utf8')).toBe(BYTES);
    // The source is read by REF, once.
    expect(reads).toEqual([`file:${'a'.repeat(32)}`]);
  });

  /** The destination's own type wins only when the caller names none — the
   *  source's mime is a sensible default, not an override. */
  it('carries the source mime through, and lets the caller override it', async () => {
    const { deps, writes } = rig();
    await handleFilePutRef(deps as never, call());
    expect(writes[0]!.mime).toBe('text/csv');

    const b = rig();
    await handleFilePutRef(b.deps as never, call({ mime: 'text/plain' }));
    expect(b.writes[0]!.mime).toBe('text/plain');
  });

  /** ⛔ NAMING A FILE IS NOT PERMISSION TO WRITE IT. Same `write` capability gate
   *  `file-write` enforces — a recipe that can compose a path must not thereby
   *  reach an instance the owner enrolled read-only. */
  it('refuses an instance without the write capability', async () => {
    const { deps, writes } = rig({ write: 'no' });
    await expect(handleFilePutRef(deps as never, call())).rejects.toThrow();
    expect(writes).toEqual([]);
  });

  it('refuses an instance that is not live', async () => {
    const { deps } = rig({ live: false });
    await expect(handleFilePutRef(deps as never, call())).rejects.toThrow();
  });

  it('refuses an unknown instance', async () => {
    const { deps } = rig();
    await expect(handleFilePutRef(deps as never, call({ slug: 'nope' }))).rejects.toThrow();
  });

  /** ⛔ THE ORDER MATTERS. Reading a warehouse file and THEN discovering the
   *  destination refuses writes would pay the whole cost — the read, the decode,
   *  the memory — for a call that was never going to land. */
  it('checks the capability BEFORE reading the source', async () => {
    const { deps, reads } = rig({ write: 'no' });
    await expect(handleFilePutRef(deps as never, call())).rejects.toThrow();
    expect(reads).toEqual([]);
  });

  /** ⚠ Not streaming — the bytes are a Buffer for the length of the write, so a
   *  ceiling applies. What they never do is enter an op-step value, which is the
   *  difference between "bounded, inside one call" and "resident for the rest of
   *  the run alongside its base64 and its parsed form". */
  it('refuses a ref past the ceiling', async () => {
    const { deps, writes } = rig({ bytes: 'x'.repeat(4096) });
    await expect(handleFilePutRef(
      { ...deps, maxBytes: 1024 } as never,
      call(),
    )).rejects.toThrow(/past the 1024-byte ceiling/u);
    expect(writes).toEqual([]);
  });

  it('has a default ceiling', () => {
    expect(FILE_PUT_REF_MAX_BYTES).toBe(32 * 1024 * 1024);
  });

  it.each(['slug', 'path', 'ref'])('requires %s', async (field) => {
    const { deps } = rig();
    await expect(handleFilePutRef(deps as never, call({ [field]: '' }))).rejects.toThrow();
  });
});

describe('the ref shapes a CLI op actually produces', () => {
  /** ⛔⛔ THE JOIN NO TEST CROSSED, and it broke execution. A CLI op declaring
   *  `shape: 'ref'` without `storage` defaults to `temp` — a TempFileRef OBJECT,
   *  not a record-id string. `xlsx2csv.spreadsheet.to_csv` is exactly that, and
   *  the recipe fed its output straight to `file-put-ref`, which demanded a
   *  string and rejected it with BAD_INPUT before the handler ran.
   *
   *  🔑 Every existing test passed a CAS string, and the recipe test asserted
   *  the recipe's SHAPE — so both sides were green and the handoff between them
   *  was never executed. That is the two-suites-one-boundary failure, and the
   *  fix is a case that uses what the producer really emits. */
  it('accepts a TempFileRef object, not only a CAS id string', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { allocateRunScratchDir } = await import('../execution/run-scratch.js');

    const run_id = 'run-put-ref-temp';
    const dir = allocateRunScratchDir(run_id);
    const filePath = join(dir, 'sheet.csv');
    writeFileSync(filePath, BYTES, 'utf8');
    void mkdtempSync; void tmpdir;

    const { deps, writes, reads } = rig();
    const r = await handleFilePutRef(deps as never, {
      slug: 'vault',
      path: 'sheets/customers.csv',
      // The shape `to_csv` returns under the framework default `storage: 'temp'`.
      ref: { backing: 'temp', path: filePath, filename: 'sheet.csv', mime_type: 'text/csv' },
      run_id,
    } as never);

    expect(r.bytes_written).toBe(Buffer.byteLength(BYTES));
    expect(writes[0]!.body.toString('utf8')).toBe(BYTES);
    // ⛔ And it did NOT go through the CAS reader — a temp ref is already a file.
    expect(reads).toEqual([]);
  });

  /** A temp ref carries no authorization of its own beyond its producing run's
   *  scratch root, exactly as `file-persist` requires. */
  it('refuses a temp ref with no run scope', async () => {
    const { deps } = rig();
    await expect(handleFilePutRef(deps as never, {
      slug: 'vault', path: 'p.csv',
      // ⚠ mime_type included: `isTempFileRef` requires backing + path +
      // filename AND mime_type, so omitting one makes the value fall through
      // to the string branch and fail for the wrong reason.
      ref: { backing: 'temp', path: '/tmp/nope.csv', filename: 'nope.csv', mime_type: 'text/csv' },
    } as never)).rejects.toThrow(/run scope/u);
  });
});
