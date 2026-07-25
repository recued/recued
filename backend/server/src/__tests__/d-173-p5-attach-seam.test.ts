/** D-173 P5 — the reception drop file-attach seam.
 *
 *  `createReceptionAttachFileSeam` wraps the D-172 `attachFile` helper,
 *  binding the live deps + adapting the projection's narrow seam input to the
 *  `attachFile` arg shape. Asserts the field mapping (a swapped
 *  `to_collection`/`to_id` would attach the file to the wrong endpoint) + that
 *  the bound deps pass through. */

import { describe, expect, it } from 'vitest';
import { createReceptionAttachFileSeam } from '../ports/reception/projection/reception-attach-file.js';
import type { AttachFileArgs, AttachFileDeps, AttachFileResult } from '../collections/file/attach-file.js';

describe('D-173 P5 — attach-file seam', () => {
  it('maps the seam input to attachFile args + binds the deps', async () => {
    const calls: Array<{ args: AttachFileArgs; deps: AttachFileDeps }> = [];
    const attachDeps = {
      annotationDeps: { store: {} as never },
      registry: {} as never,
    } as AttachFileDeps;
    const seam = createReceptionAttachFileSeam({
      attachDeps,
      attach: async (args, deps): Promise<AttachFileResult> => {
        calls.push({ args, deps });
        return { link: {} as never, already_attached: false };
      },
    });

    await seam({ file_id: 'file:1', to_collection: 'task', to_id: 't1' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual({ file_id: 'file:1', to_collection: 'task', to_id: 't1' });
    expect(calls[0]!.deps).toBe(attachDeps);
  });
});
