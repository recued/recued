/** D-335 slice H — a screenshot reaches an AI app as a picture.
 *
 *  A step's output carries a `BrowserImageRef` and the server keeps the picture
 *  (`bridges/browser-images.ts`). An MCP tool result is JSON text, and the
 *  picture as base64 text there would cost a model hundreds of thousands of
 *  tokens and show it nothing. So the MCP server lifts each picture out as an
 *  MCP image content block beside the text, which an AI app shows its model as
 *  an image, and the reference in the text says the picture follows.
 *
 *  Recued's own chat does not show pictures to its model yet: there the
 *  reference says so ({@link noteBrowserImagesForChat}). A cloud model in chat
 *  receives names and addresses as aliases, and a picture of a page cannot be
 *  aliased. */

import { isBrowserImageRef } from '@recued/contracts';

import { browserImages, type BrowserImageStore } from './bridges/browser-images.js';

/** The most pictures one tool result carries. */
export const MCP_MAX_IMAGES_PER_RESULT = 4;

export interface McpImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

/** Walk a result and replace each picture reference by `mark(ref)`. The result
 *  is first made the JSON its text will be, so nothing else in it changes.
 *  A result with no picture reference comes back as it was. */
const replaceImageRefs = (data: unknown, mark: (ref: Record<string, unknown>) => Record<string, unknown>): unknown => {
  const json = JSON.stringify(data);
  if (json === undefined || !json.includes('"image_id"')) return data;
  let marked = 0;
  const walk = (value: unknown, depth: number): unknown => {
    if (value === null || typeof value !== 'object' || depth > 32) return value;
    if (Array.isArray(value)) return value.map(item => walk(item, depth + 1));
    if (isBrowserImageRef(value)) {
      marked++;
      return mark(value as unknown as Record<string, unknown>);
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item, depth + 1)]));
  };
  const out = walk(JSON.parse(json) as unknown, 0);
  return marked === 0 ? data : out;
};

/** A result's pictures, for an AI app: the result with each reference marked,
 *  and the pictures as MCP image content in the order they appear. */
export const liftBrowserImages = (
  data: unknown,
  store: BrowserImageStore = browserImages,
): { data: unknown; images: McpImageContent[] } => {
  const images: McpImageContent[] = [];
  // A run's result names one picture more than once (its output and its
  // step's): each is attached once, and every reference to it says which.
  const attachedAs = new Map<string, number>();
  const marked = replaceImageRefs(data, ref => {
    const id = ref.image_id as string;
    const known = attachedAs.get(id);
    if (known !== undefined) return { ...ref, attached: true, note: `The picture is attached to this result as image ${known}.` };
    if (images.length >= MCP_MAX_IMAGES_PER_RESULT) {
      return { ...ref, attached: false, note: `Not attached: one result carries at most ${MCP_MAX_IMAGES_PER_RESULT} pictures.` };
    }
    const picture = store.get(id);
    if (!picture) return { ...ref, attached: false, note: 'The picture is no longer held: take the screenshot again.' };
    images.push({ type: 'image', data: picture.data, mimeType: picture.mime_type });
    attachedAs.set(id, images.length);
    return { ...ref, attached: true, note: `The picture is attached to this result as image ${images.length}.` };
  });
  return { data: marked, images };
};

/** A result's pictures, for Recued's chat: each reference says the model in
 *  chat is not shown it. */
export const noteBrowserImagesForChat = (data: unknown): unknown => replaceImageRefs(data, ref => ({
  ...ref,
  attached: false,
  note: 'Recued\'s chat does not show pictures to its model yet. An AI app connected over MCP receives the picture itself.',
}));
