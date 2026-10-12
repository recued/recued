/** D-149 P7 § A.5.4 — a drop refused before its scratch file has opened leaves no
 *  file behind.
 *
 *  The scratch file is opened in the background. A first chunk over the cap, or a
 *  visitor gone at once, refuses the drop before that open lands: the unlink found
 *  nothing, and the open created the file after it (2026-10-11: 16-36% of such
 *  refusals under a sweep's load, and the sibling test's cleanup failing ENOTEMPTY
 *  when the file landed during its `rmSync`). The boot sweep reclaims the scratch
 *  tree, so the file lasted until the next restart. Here every scratch open is held
 *  back on purpose, so the order that left the file is the order every run takes. */

import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { writeDropBlobStream } from '../ports/reception/drop-blob-storage.js';
import { createBlobStore } from '../storage/blob-store.js';

/** One entry per scratch open, resolved once the open has created the file. */
const opens = vi.hoisted(() => ({ landed: [] as Promise<void>[] }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  /** `fs.open`, run only after the refusal has had every chance to come first. */
  const heldOpen = (...args: unknown[]): void => {
    const callback = args.pop() as (...result: unknown[]) => void;
    opens.landed.push(new Promise<void>((landed) => {
      setTimeout(() => {
        (actual.open as (...a: unknown[]) => void)(...args, (...result: unknown[]) => {
          landed();
          callback(...result);
        });
      }, 20);
    }));
  };
  return {
    ...actual,
    default: actual,
    createWriteStream: ((path: string, options: Record<string, unknown>) =>
      actual.createWriteStream(path, {
        ...options,
        fs: { open: heldOpen, write: actual.write, writev: actual.writev, close: actual.close },
      })) as unknown as typeof actual.createWriteStream,
  };
});

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'd149-early-refusal-'));
  opens.landed = [];
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const refusal = async (source: Readable): Promise<string> => {
  try {
    await writeDropBlobStream(source, { drop_blobs_root: root, blobs: createBlobStore(join(root, 'cas')), size_cap_bytes: 1024 });
    return 'stored';
  } catch (err) {
    return (err as Error).message;
  }
};

/** What the scratch tree holds once the open has certainly run. */
const scratchAfterTheOpen = async (): Promise<string[]> => {
  expect(opens.landed).toHaveLength(1);
  await opens.landed[0];
  return readdirSync(join(root, '_tmp'));
};

describe('a drop refused before its scratch file opened', () => {
  it('over the cap in its first chunk: no scratch file is left', async () => {
    expect(await refusal(Readable.from([Buffer.alloc(2048, 0x78)]))).toBe('size_cap_exceeded');
    expect(await scratchAfterTheOpen()).toEqual([]);
  });

  it('the visitor gone at once: no scratch file is left', async () => {
    const gone = new Readable({
      read() {
        this.destroy(new Error('visitor_gone'));
      },
    });
    expect(await refusal(gone)).toBe('visitor_gone');
    expect(await scratchAfterTheOpen()).toEqual([]);
  });
});
