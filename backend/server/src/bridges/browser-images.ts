/** D-335 slice H — the screenshots the server holds for a short while.
 *
 *  A screenshot's bytes never ride in a step's output: the DOM adapter puts them
 *  here and the output carries a `BrowserImageRef`. So the run's history, chat
 *  and the audit log keep a reference of a few dozen bytes, not hundreds of
 *  kilobytes of picture, and the picture is gone after
 *  {@link BROWSER_IMAGE_TTL_MS}. An AI app over MCP receives the picture itself
 *  beside the result (`mcp-browser-images.ts`), which it does within seconds.
 *
 *  In memory only, by design: a screenshot is a page as the owner sees it, and
 *  nothing here writes it to disk. */

import { randomUUID } from 'node:crypto';

import { BROWSER_IMAGE_TTL_MS, type BrowserImageRef } from '@recued/contracts';

export interface BrowserImage {
  mime_type: BrowserImageRef['mime_type'];
  /** The picture, in base64. */
  data: string;
  width: number;
  height: number;
}

export interface BrowserImageStore {
  /** Keep a picture; the reference a step's output carries. */
  put(image: BrowserImage): BrowserImageRef;
  /** The picture a reference names, while it is held. */
  get(image_id: string): BrowserImage | undefined;
}

/** Everything held at once, in base64 characters (about 36 MB of pictures).
 *  Past it the oldest are dropped first. */
export const BROWSER_IMAGE_MAX_HELD = 48_000_000;

export const createBrowserImageStore = (options: { now?: () => number; ttlMs?: number; maxHeld?: number } = {}): BrowserImageStore => {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? BROWSER_IMAGE_TTL_MS;
  const maxHeld = options.maxHeld ?? BROWSER_IMAGE_MAX_HELD;
  // Insertion order is age order: a Map iterates oldest first.
  const held = new Map<string, BrowserImage & { at: number }>();
  let size = 0;
  const drop = (id: string) => {
    const image = held.get(id);
    if (!image) return;
    held.delete(id);
    size -= image.data.length;
  };
  const sweep = () => {
    const cutoff = now() - ttlMs;
    for (const [id, image] of held) {
      if (image.at > cutoff && size <= maxHeld) break;
      drop(id);
    }
  };
  return {
    put(image) {
      const image_id = randomUUID();
      held.set(image_id, { ...image, at: now() });
      size += image.data.length;
      sweep();
      return { type: 'image', image_id, mime_type: image.mime_type, width: image.width, height: image.height };
    },
    get(image_id) {
      sweep();
      const image = held.get(image_id);
      if (!image) return undefined;
      const { at: _at, ...picture } = image;
      return picture;
    },
  };
};

/** The process's store: the DOM adapter puts into it and the MCP server reads
 *  from it, so the two meet without being wired to each other. */
export const browserImages: BrowserImageStore = createBrowserImageStore();
