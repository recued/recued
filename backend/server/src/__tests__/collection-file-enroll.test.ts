/** Phase 7 (D-110) — collection.file.* enroll rpc tests.
 *
 *  Exercises the handler-level contracts (input validation, caps
 *  probe, DB round-trip, error mapping) using the null-adapter +
 *  an in-memory SQLite instance store. No real FS / network. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RpcError, type FileCollectionCaps } from '@recued/contracts';
import {
  createInstanceStore,
  type CollectionInstanceStore,
} from '../collections/instance-store.js';
import {
  createAdapterRegistry,
  type FileAdapterRegistry,
} from '../collections/file/adapter-registry.js';
import { nullAdapterFactory } from '../collections/file/adapters/null-adapter.js';
import {
  handleFileDelete,
  handleFileEnroll,
  handleFileResync,
  handleFileUpdate,
  handleListInstances,
  type EnrollDeps,
} from '../collections/file/enroll.js';

const setup = (): { db: Database.Database; deps: EnrollDeps; adapters: FileAdapterRegistry; instances: CollectionInstanceStore } => {
  const db = new Database(':memory:');
  const instances = createInstanceStore({ db });
  const adapters = createAdapterRegistry();
  adapters.register(nullAdapterFactory);
  const deps: EnrollDeps = {
    instances,
    adapters,
    now: () => 1_700_000_000_000,
  };
  return { db, deps, adapters, instances };
};

const asRpc = (err: unknown): RpcError => {
  expect(err).toBeInstanceOf(RpcError);
  return err as RpcError;
};

describe('collection.file.enroll (Phase 7 / D-110)', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => { ctx.db.close(); });

  it('rejects invalid slugs', async () => {
    for (const bad of ['', 'UPPER', 'has spaces', 'ends-with-dash-', '-starts-with-dash']) {
      await expect(
        handleFileEnroll(ctx.deps, {
          slug: bad,
          adapter_type: 'null-adapter' as never,
          config: {},
        }),
      ).rejects.toThrow(RpcError);
    }
  });

  it('rejects unknown adapter types', async () => {
    await expect(
      handleFileEnroll(ctx.deps, {
        slug: 'x',
        adapter_type: 'bogus' as never,
        config: {},
      }),
    ).rejects.toThrow(/adapter_type must be one of/);
  });

  it('rejects non-object config', async () => {
    try {
      await handleFileEnroll(ctx.deps, {
        slug: 'x',
        adapter_type: 'null-adapter' as never,
        config: 'not-an-object',
      });
      throw new Error('expected throw');
    } catch (err) {
      const rpc = asRpc(err);
      expect(rpc.status).toBe(400);
    }
  });

  it('writes the row, returns caps, and calls onEnrolled', async () => {
    let enrolled = '';
    ctx.deps.onEnrolled = (row) => {
      enrolled = row.slug;
    };
    // Extend adapter set to include the expected 'fs' / 's3' values
    // so we don't depend on the null-adapter literal — use a new
    // slot.
    ctx.adapters.register({
      type: 'fs',
      probeCaps: nullAdapterFactory.probeCaps.bind(nullAdapterFactory),
      create: nullAdapterFactory.create.bind(nullAdapterFactory),
    });
    const res = await handleFileEnroll(ctx.deps, {
      slug: 'myhomedir',
      adapter_type: 'fs' as never,
      config: {},
    });

    expect(res.instance.slug).toBe('myhomedir');
    expect(res.instance.platform).toBe('file');
    expect((res.instance.caps as FileCollectionCaps).write).toBe('yes');
    expect(res.instance.auth_state).toBe('healthy');
    expect(res.probe_result.path_style).toBe('posix');
    expect(enrolled).toBe('myhomedir');
    expect(ctx.instances.get('file', 'myhomedir')).not.toBeNull();
  });

  it('refuses to enroll a duplicate slug', async () => {
    ctx.adapters.register({
      type: 'fs',
      probeCaps: nullAdapterFactory.probeCaps.bind(nullAdapterFactory),
      create: nullAdapterFactory.create.bind(nullAdapterFactory),
    });
    await handleFileEnroll(ctx.deps, {
      slug: 'dup',
      adapter_type: 'fs' as never,
      config: {},
    });
    try {
      await handleFileEnroll(ctx.deps, {
        slug: 'dup',
        adapter_type: 'fs' as never,
        config: {},
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(asRpc(err).status).toBe(409);
    }
  });

  it('maps probe failures to 422 probe_failed', async () => {
    ctx.adapters.register({
      type: 'fs',
      probeCaps: nullAdapterFactory.probeCaps.bind(nullAdapterFactory),
      create: nullAdapterFactory.create.bind(nullAdapterFactory),
    });
    try {
      await handleFileEnroll(ctx.deps, {
        slug: 'broken',
        adapter_type: 'fs' as never,
        config: { probeThrows: true },
      });
      throw new Error('expected throw');
    } catch (err) {
      const rpc = asRpc(err);
      expect(rpc.status).toBe(422);
      expect(rpc.message).toMatch(/synthetic probe failure/);
    }
  });
});

describe('collection.file.update (Phase 7 / D-110)', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(async () => {
    ctx = setup();
    ctx.adapters.register({
      type: 'fs',
      probeCaps: nullAdapterFactory.probeCaps.bind(nullAdapterFactory),
      create: nullAdapterFactory.create.bind(nullAdapterFactory),
    });
    await handleFileEnroll(ctx.deps, {
      slug: 'existing',
      adapter_type: 'fs' as never,
      config: { path: '/a' },
    });
  });
  afterEach(() => { ctx.db.close(); });

  it('merges config_patch without reprobing', async () => {
    const res = await handleFileUpdate(ctx.deps, {
      slug: 'existing',
      config_patch: { ignore: ['*.log'] },
    });
    expect(res.re_probed).toBe(false);
    const row = ctx.instances.get('file', 'existing');
    expect(row!.config).toEqual({ path: '/a', ignore: ['*.log'] });
  });

  it('runs a reprobe when reprobe: true', async () => {
    const res = await handleFileUpdate(ctx.deps, {
      slug: 'existing',
      config_patch: { caps: { write: 'no' } },
      reprobe: true,
    });
    expect(res.re_probed).toBe(true);
    expect((res.instance.caps as FileCollectionCaps).write).toBe('no');
  });

  it('404s when the instance is missing', async () => {
    try {
      await handleFileUpdate(ctx.deps, {
        slug: 'ghost',
        config_patch: {},
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(asRpc(err).status).toBe(404);
    }
  });
});

describe('collection.file.delete + resync (Phase 7 / D-110)', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(async () => {
    ctx = setup();
    ctx.adapters.register({
      type: 'fs',
      probeCaps: nullAdapterFactory.probeCaps.bind(nullAdapterFactory),
      create: nullAdapterFactory.create.bind(nullAdapterFactory),
    });
    await handleFileEnroll(ctx.deps, {
      slug: 'primary',
      adapter_type: 'fs' as never,
      config: {},
    });
  });
  afterEach(() => { ctx.db.close(); });

  it('delete removes the row and calls onDeleted', async () => {
    let removed = '';
    ctx.deps.onDeleted = (slug) => { removed = slug; };
    const res = await handleFileDelete(ctx.deps, { slug: 'primary' });
    expect(res.ok).toBe(true);
    expect(removed).toBe('primary');
    expect(ctx.instances.get('file', 'primary')).toBeNull();
  });

  it('resync refreshes caps + flips auth_state on probe failure', async () => {
    let rescanCalls = 0;
    ctx.deps.onResync = () => { rescanCalls++; };
    // First resync with healthy probe.
    const ok = await handleFileResync(ctx.deps, { slug: 'primary' });
    expect(ok.auth_state).toBe('healthy');
    expect(rescanCalls).toBe(1);
    expect(ctx.instances.get('file', 'primary')?.last_synced_at).toBe(1_700_000_000_000);

    // Mutate config to make probe throw, then resync again — caps
    // are preserved from the prior run, auth_state flips.
    await handleFileUpdate(ctx.deps, {
      slug: 'primary',
      config_patch: { probeThrows: true },
      reprobe: false,
    });

    const degraded = await handleFileResync(ctx.deps, { slug: 'primary' });
    expect(degraded.auth_state).toBe('degraded');
    expect(rescanCalls).toBe(1);
    // Caps preserved from the last successful probe.
    expect(degraded.probe_result.write).toBe('yes');
  });

  it('does not claim a sync timestamp when no lifecycle hook ran', async () => {
    const result = await handleFileResync(ctx.deps, { slug: 'primary' });

    expect(result.auth_state).toBe('healthy');
    expect(ctx.instances.get('file', 'primary')?.last_synced_at).toBeNull();
  });

  it('does not resurrect an instance deleted while its probe is in flight', async () => {
    let releaseProbe!: () => void;
    let markProbeStarted!: () => void;
    const probeStarted = new Promise<void>((resolve) => { markProbeStarted = resolve; });
    const probeGate = new Promise<void>((resolve) => { releaseProbe = resolve; });
    const factory = ctx.adapters.get('fs')!;
    factory.probeCaps = async (config) => {
      markProbeStarted();
      await probeGate;
      return nullAdapterFactory.probeCaps(config);
    };

    const pending = handleFileResync(ctx.deps, { slug: 'primary' });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'not_found' });
    await probeStarted;
    await handleFileDelete(ctx.deps, { slug: 'primary' });
    releaseProbe();

    await rejected;
    expect(ctx.instances.get('file', 'primary')).toBeNull();
  });

  it('does not overwrite configuration changed while its probe is in flight', async () => {
    let releaseProbe!: () => void;
    let markProbeStarted!: () => void;
    const probeStarted = new Promise<void>((resolve) => { markProbeStarted = resolve; });
    const probeGate = new Promise<void>((resolve) => { releaseProbe = resolve; });
    const factory = ctx.adapters.get('fs')!;
    factory.probeCaps = async (config) => {
      markProbeStarted();
      await probeGate;
      return nullAdapterFactory.probeCaps(config);
    };

    const pending = handleFileResync(ctx.deps, { slug: 'primary' });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'conflict' });
    await probeStarted;
    await handleFileUpdate(ctx.deps, {
      slug: 'primary',
      config_patch: { generation: 2 },
      reprobe: false,
    });
    releaseProbe();

    await rejected;
    expect(ctx.instances.get('file', 'primary')?.config).toMatchObject({ generation: 2 });
  });

  it('does not report success when deletion wins during lifecycle restart', async () => {
    ctx.deps.onResync = () => {
      ctx.instances.delete('file', 'primary');
    };

    await expect(
      handleFileResync(ctx.deps, { slug: 'primary' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('resync reports degraded when the one-shot restart fails', async () => {
    ctx.deps.onResync = () => { throw new Error('watch attach failed'); };

    const result = await handleFileResync(ctx.deps, { slug: 'primary' });

    expect(result.auth_state).toBe('degraded');
    expect(ctx.instances.get('file', 'primary')?.auth_state).toBe('degraded');
    expect(ctx.instances.get('file', 'primary')?.last_synced_at).toBeNull();
  });

});

describe('collection.listInstances (Phase 7 / D-110)', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(async () => {
    ctx = setup();
    ctx.adapters.register({
      type: 'fs',
      probeCaps: nullAdapterFactory.probeCaps.bind(nullAdapterFactory),
      create: nullAdapterFactory.create.bind(nullAdapterFactory),
    });
    ctx.adapters.register({
      type: 's3',
      probeCaps: async (cfg) => ({
        read: 'yes',
        write: 'yes',
        delete: 'no',
        watch: 'poll',
        mirror: 'optional',
        auth: 'keys',
        path_style: 's3-key',
        ...(cfg.caps as object ?? {}),
      }),
      create: nullAdapterFactory.create.bind(nullAdapterFactory),
    });

    await handleFileEnroll(ctx.deps, {
      slug: 'laptop',
      adapter_type: 'fs' as never,
      config: {},
    });
    await handleFileEnroll(ctx.deps, {
      slug: 'archive',
      adapter_type: 's3' as never,
      config: {},
    });
    ctx.instances.upsert({
      platform: 'mail',
      slug: 'gmail-main',
      adapter_type: 'gmail',
      config: {},
      caps: { read: 'yes', write: 'no', delete: 'no', watch: 'poll', mirror: 'required', auth: 'oauth', path_style: 'uri' },
      auth_state: 'healthy',
      last_synced_at: null,
    });
  });
  afterEach(() => { ctx.db.close(); });

  it('returns every instance when type is omitted', async () => {
    const res = await handleListInstances(ctx.deps, {});
    const slugs = res.instances.map((i) => i.slug).sort();
    expect(slugs).toEqual(['archive', 'gmail-main', 'laptop']);
  });

  it('narrows by type', async () => {
    const res = await handleListInstances(ctx.deps, { type: 'file' });
    expect(res.instances).toHaveLength(2);
    expect(res.instances.every((i) => i.platform === 'file')).toBe(true);
  });

  it('includes caps + auth_state for parseRecipe gating', async () => {
    const res = await handleListInstances(ctx.deps, { type: 'file' });
    const s3 = res.instances.find((i) => i.slug === 'archive')!;
    expect((s3.caps as FileCollectionCaps).delete).toBe('no');
    expect((s3.caps as FileCollectionCaps).auth).toBe('keys');
    expect(s3.auth_state).toBe('healthy');
  });
});
