import { describe, expect, it, vi } from 'vitest';
import {
  readBoundedResponseBytes,
  readBoundedResponseText,
  ResponseBodyTooLargeError,
} from '../bounded-response-body.js';

describe('bounded provider response bodies', () => {
  it('rejects an oversized declared length and releases the unread body', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
      cancel,
    }), {
      headers: { 'content-length': '9' },
    });

    await expect(readBoundedResponseBytes(response, 8)).rejects.toMatchObject({
      name: 'ResponseBodyTooLargeError',
      maxBytes: 8,
      declaredBytes: 9,
    });
    await Promise.resolve();
    expect(response.bodyUsed).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('cancels a chunked response as soon as the observed bytes cross the cap', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
      },
      cancel,
    }));

    await expect(readBoundedResponseBytes(response, 5)).rejects.toBeInstanceOf(
      ResponseBodyTooLargeError,
    );
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('counts UTF-8 bytes, not JavaScript characters', async () => {
    const read = await readBoundedResponseText(new Response('éé'), 4);
    expect(read).toEqual({ text: 'éé', byteLength: 4 });
    await expect(readBoundedResponseText(new Response('éé'), 3))
      .rejects.toBeInstanceOf(ResponseBodyTooLargeError);
  });

  it('refuses an invalid trusted limit', async () => {
    await expect(readBoundedResponseBytes(new Response('x'), 0))
      .rejects.toThrow(/positive safe integer/);
  });
});
