/** Phase 7 (D-110) — adapter registry + caps framework tests. */

import { describe, expect, it, vi } from 'vitest';
import {
  createAdapterRegistry,
  isMutationCapable,
  probeAdapter,
  type FileAdapterFactory,
} from '../collections/file/adapter-registry.js';
import {
  CapsValidationError,
  effectiveCaps,
  hasCap,
  validateCaps,
} from '../collections/file/caps.js';
import { nullAdapterFactory } from '../collections/file/adapters/null-adapter.js';

const fullCaps = (): ReturnType<typeof validateCaps> =>
  validateCaps({
    read: 'yes',
    write: 'yes',
    delete: 'yes',
    watch: 'realtime',
    mirror: 'optional',
    auth: 'none',
    path_style: 'posix',
  });

describe('createAdapterRegistry (Phase 7 / D-110)', () => {
  it('registers, looks up, and lists in insertion order', () => {
    const reg = createAdapterRegistry();
    reg.register(nullAdapterFactory);

    const fakeS3: FileAdapterFactory = {
      type: 's3',
      async probeCaps() {
        return fullCaps();
      },
      create: (ctx) => ({
        async start() { ctx.log?.('info', 'fake-s3 start'); },
        async stop() {},
      }),
    };
    reg.register(fakeS3);

    expect(reg.get('null-adapter')).toBe(nullAdapterFactory);
    expect(reg.get('s3')).toBe(fakeS3);
    expect(reg.get('unknown')).toBeUndefined();
    expect(reg.listTypes()).toEqual(['null-adapter', 's3']);
  });

  it('refuses duplicate registrations', () => {
    const reg = createAdapterRegistry();
    reg.register(nullAdapterFactory);
    expect(() => reg.register(nullAdapterFactory)).toThrow(/duplicate registration/);
  });
});

describe('probeAdapter (Phase 7 / D-110)', () => {
  it('returns a validated caps shape on success', async () => {
    const caps = await probeAdapter(nullAdapterFactory, {});
    expect(caps.read).toBe('yes');
    expect(caps.write).toBe('yes');
    expect(caps.path_style).toBe('posix');
  });

  it('wraps adapter-probe errors in a labeled Error', async () => {
    await expect(
      probeAdapter(nullAdapterFactory, { probeThrows: true }),
    ).rejects.toThrow(/null-adapter.*synthetic probe failure/);
  });

  it('rejects a malformed probe result via validateCaps', async () => {
    const brokenFactory: FileAdapterFactory = {
      type: 'broken',
      async probeCaps() {
        // Adapter bug — returns shape without path_style.
        return {
          read: 'yes',
          write: 'no',
          delete: 'no',
          watch: 'none',
          mirror: 'disabled',
          auth: 'none',
        } as never;
      },
      create: () => ({ async start() {}, async stop() {} }),
    };
    await expect(probeAdapter(brokenFactory, {})).rejects.toThrow(CapsValidationError);
  });

  it('rejects OAuth adapters in favor of connection-backed D-192 Sources', async () => {
    const oauthAdapter: FileAdapterFactory = {
      type: 'oauth-file-adapter',
      async probeCaps() {
        return { ...fullCaps(), auth: 'oauth' };
      },
      create: () => ({ async start() {}, async stop() {} }),
    };

    await expect(probeAdapter(oauthAdapter, {})).rejects.toThrow(
      /connection-backed D-192 Source/,
    );
  });
});

describe('validateCaps / hasCap / effectiveCaps (Phase 7 / D-110)', () => {
  it('accepts a well-formed caps shape', () => {
    expect(fullCaps().write).toBe('yes');
  });

  it('rejects a shape missing required fields', () => {
    expect(() =>
      validateCaps({ read: 'yes', write: 'yes' }),
    ).toThrow(CapsValidationError);
  });

  it('rejects non-yes read (implementation invariant)', () => {
    expect(() =>
      validateCaps({
        read: 'no',
        write: 'no',
        delete: 'no',
        watch: 'none',
        mirror: 'disabled',
        auth: 'none',
        path_style: 'posix',
      }),
    ).toThrow(CapsValidationError);
  });

  it('hasCap checks mutation caps by name', () => {
    const caps = fullCaps();
    expect(hasCap(caps, 'write')).toBe(true);
    expect(hasCap(caps, 'delete')).toBe(true);

    const readOnly = validateCaps({
      ...caps,
      write: 'no',
      delete: 'no',
    });
    expect(hasCap(readOnly, 'write')).toBe(false);
    expect(hasCap(readOnly, 'delete')).toBe(false);
  });

  it('effectiveCaps forces mutations to no when auth is not healthy', () => {
    const caps = fullCaps();
    expect(effectiveCaps(caps, 'healthy')).toBe(caps); // identity
    const degraded = effectiveCaps(caps, 'expired');
    expect(degraded.write).toBe('no');
    expect(degraded.delete).toBe('no');
    expect(degraded.watch).toBe('none');
    // Non-mutating fields stay put so the UI can still render the
    // cached shape while the user re-auths.
    expect(degraded.path_style).toBe('posix');
    expect(degraded.auth).toBe('none');
  });
});

describe('null-adapter (test fixture)', () => {
  it('exposes the FileMutationCapable shape + round-trips records', async () => {
    const events: string[] = [];
    const instance = nullAdapterFactory.create({
      slug: 'test',
      config: {},
      onEvent: (e) => {
        events.push(`${e.type}:${e.path}`);
      },
      log: vi.fn(),
    });
    expect(isMutationCapable(instance)).toBe(true);

    await instance.start();
    await (instance as import('../collections/file/adapter-registry.js').FileMutationCapable).writeRecord(
      'a.txt',
      new TextEncoder().encode('hello'),
    );
    const read = await (instance as import('../collections/file/adapter-registry.js').FileMutationCapable).readRecord(
      'a.txt',
    );
    expect(new TextDecoder().decode(read)).toBe('hello');

    await (instance as import('../collections/file/adapter-registry.js').FileMutationCapable).deleteRecord('a.txt');
    await instance.stop();

    expect(events).toEqual(['change:a.txt', 'remove:a.txt']);
  });
});
