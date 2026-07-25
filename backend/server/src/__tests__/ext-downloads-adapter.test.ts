/** Phase 7 (D-110) — ext-downloads server-side listener tests. */

import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  createExtDownloadsAdapterFactory,
  createExtDownloadsRegistry,
  handleDownloadsStream,
  type DownloadStreamInput,
} from '../collections/file/adapters/ext-downloads/index.js';
import { probeAdapter } from '../collections/file/adapter-registry.js';

describe('ext-downloads server adapter (Phase 7 / D-110)', () => {
  it('probeCaps returns fixed read-only caps', async () => {
    const registry = createExtDownloadsRegistry();
    const factory = createExtDownloadsAdapterFactory({ registry });
    const caps = await probeAdapter(factory, {});
    expect(caps.read).toBe('yes');
    expect(caps.write).toBe('no');
    expect(caps.delete).toBe('no');
    expect(caps.mirror).toBe('required');
    expect(caps.path_style).toBe('uri');
    expect(caps.watch).toBe('realtime');
  });

  it('start() registers + stop() unregisters the stream handler', async () => {
    const registry = createExtDownloadsRegistry();
    const factory = createExtDownloadsAdapterFactory({ registry });

    const events: string[] = [];
    const adapter = factory.create({
      slug: 'laptop',
      config: {},
      onEvent: (e) => { events.push(`${e.type}:${e.path}`); },
    });

    expect(registry.get('laptop')).toBeUndefined();
    await adapter.start();
    expect(registry.get('laptop')).toBeDefined();

    await handleDownloadsStream(registry, {
      slug: 'laptop',
      path: '1/doc.pdf',
      mime: 'application/pdf',
      size_bytes: 5,
      body_b64: Buffer.from('hello').toString('base64'),
    });
    expect(events).toEqual(['change:1/doc.pdf']);

    await adapter.stop();
    expect(registry.get('laptop')).toBeUndefined();
  });

  it('handleDownloadsStream throws when the slug is not registered', async () => {
    const registry = createExtDownloadsRegistry();
    await expect(
      handleDownloadsStream(registry, {
        slug: 'ghost',
        path: 'x',
        size_bytes: 0,
        body_b64: '',
      } satisfies DownloadStreamInput),
    ).rejects.toThrow(/no adapter registered for slug 'ghost'/);
  });

  it('mutation methods refuse writes (caps enforce read-only)', async () => {
    const registry = createExtDownloadsRegistry();
    const factory = createExtDownloadsAdapterFactory({ registry });
    const adapter = factory.create({
      slug: 'laptop',
      config: {},
      onEvent: () => {},
    });
    await adapter.start();
    try {
      const mutate = adapter as import('../collections/file/adapter-registry.js').FileMutationCapable;
      await expect(
        mutate.writeRecord('x', new Uint8Array()),
      ).rejects.toThrow(/not supported/);
      await expect(
        mutate.deleteRecord('x'),
      ).rejects.toThrow(/not supported/);
    } finally {
      await adapter.stop();
    }
  });

  it('bytes_stored reflects decoded body length', async () => {
    const registry = createExtDownloadsRegistry();
    const factory = createExtDownloadsAdapterFactory({ registry });
    const adapter = factory.create({
      slug: 'laptop',
      config: {},
      onEvent: () => {},
    });
    await adapter.start();
    try {
      const body = new TextEncoder().encode('1234567890');
      const res = await handleDownloadsStream(registry, {
        slug: 'laptop',
        path: 'a.txt',
        size_bytes: body.length,
        body_b64: Buffer.from(body).toString('base64'),
      });
      expect(res.bytes_stored).toBe(10);
    } finally {
      await adapter.stop();
    }
  });

  it('createExtDownloadsRegistry isolates per-slug handlers', async () => {
    const registry = createExtDownloadsRegistry();
    let hitA = 0;
    let hitB = 0;
    registry.register('a', async () => { hitA++; });
    registry.register('b', async () => { hitB++; });

    await handleDownloadsStream(registry, {
      slug: 'a',
      path: 'x',
      size_bytes: 0,
      body_b64: '',
    });
    expect(hitA).toBe(1);
    expect(hitB).toBe(0);

    registry.unregister('a');
    await expect(
      handleDownloadsStream(registry, {
        slug: 'a',
        path: 'x',
        size_bytes: 0,
        body_b64: '',
      }),
    ).rejects.toThrow(/no adapter registered/);
  });
});
