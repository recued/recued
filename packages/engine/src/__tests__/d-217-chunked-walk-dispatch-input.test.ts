/** D-217 slice 2b-ii-β2 — the ENGINE half: one act's whole walk on ONE input.
 *
 *  🔑 **The decisive test in this file is `is byte-identical across two
 *  dispatches`.** Everything else checks that the descriptor is built
 *  correctly; that one checks the property the owner ruling turned on. The
 *  first shape had the engine stage the file and put the resulting TOKEN here.
 *  It would have worked — bytes would have left, the upload would have
 *  succeeded — while every attempt produced a different
 *  `canonical_payload_hash`, so no D-177 session grant could ever match an
 *  honest repeat and the owner re-approved every single upload. It failed
 *  CLOSED, which is exactly why no test would have caught it.
 *
 *  ⇒ A dispatch input for the same act must be STABLE. That is now asserted
 *  directly, over the real gateway, rather than reasoned about.
 *
 *  Spec: D-217 § 8a (+ amendment), § 9.2, § 9.9.
 */

import { describe, it, expect } from 'vitest';
import {
  CHUNKED_UPLOAD_WIRE_WALK_KEY,
  HTTP_UPLOAD_WIRE_FIELD_KEY,
  HTTP_UPLOAD_WIRE_KIND_KEY,
  HTTP_UPLOAD_WIRE_MAX_BYTES_KEY,
} from '@recued/contracts';
import type {
  ApiExecutionBinding,
  ChunkedUploadSpec,
  ChunkedUploadWalkInput,
  ConnectionOperationProfile,
  IngredientManifest,
  OperationSpec,
  ProviderSurfaces,
} from '@recued/contracts';

import { runCatalogOperation } from '../catalog-gateway.js';
import type { ExecutionContext, IngredientExecutor } from '../types.js';

const FILE_REF = 'file:9f2cvideo';
const SIZE = 100;
const CHUNK = 16;
const CONTENT_HASH = 'a'.repeat(64);

const chunkedSpec = (over: Partial<ChunkedUploadSpec> = {}): ChunkedUploadSpec => ({
  kind: 'chunked',
  // ⚠ A PLAIN arg key, never `body_file.*` — the predicate refuses the one-shot
  // wire slots for a chunked op, so the file stays an ordinary authority-bearing
  // arg exactly where `affects_target` expects it.
  arg: 'file',
  chunk_bytes: CHUNK,
  session_from: 'result.media_id',
  init: { method: 'POST', path: '/media', query: { command: 'INIT' } },
  append: { method: 'POST', path: '/media', query: { command: 'APPEND', id: '{session}' } },
  finalize: { method: 'POST', path: '/media', query: { command: 'FINALIZE', id: '{session}' } },
  ...over,
});

const bindingWith = (upload: unknown): ApiExecutionBinding => ({
  kind: 'rest',
  method: 'POST',
  path_template: '/media',
  upload,
} as unknown as ApiExecutionBinding);

const surfacesWith = (binding: ApiExecutionBinding): ProviderSurfaces => ({
  api: {
    transport: 'rest',
    default_base_url: 'https://upload.example.com',
    auth: { kind: 'none' },
    executes: { x: binding },
  },
});

const operation = (extras: Partial<OperationSpec> = {}): OperationSpec => ({
  operation_id: 'pub/cat.x',
  risk_tier: 'read',
  groups: ['g'],
  ...extras,
});

const manifestFor = (
  binding: ApiExecutionBinding,
  op: OperationSpec = operation(),
): IngredientManifest => ({
  slug: 'pub/cat',
  name: 'Catalog',
  description: '',
  author: 'pub',
  kind: 'connection',
  category: 'action',
  risk_tier: 'read',
  input: {},
  output: {},
  operations: { x: op },
  surfaces: surfacesWith(binding),
});

const allowedProfile = (): ConnectionOperationProfile => ({ allowed_operations: ['x'] });

const makeHarness = (opts: {
  size_bytes?: number;
  content_hash?: string;
  /** Omit the metadata dep entirely — the fail-closed host. */
  noDescriber?: boolean;
  /** Return undefined for any ref — the unknown-file path. */
  unknownFile?: boolean;
  /** Resolve a CONTRACTED source so a write-tier op HOLDS for approval.
   *  Without one the gateway resolves the owner `admin` ceiling and a write
   *  relaxes to silent — which is why an `approval: 'ask'` op alone does not
   *  pause here. */
  contracted?: boolean;
} = {}) => {
  const inputs: Array<Record<string, unknown>> = [];
  const described: string[] = [];
  const ingredientExecutor: IngredientExecutor = async (_slug, input) => {
    inputs.push(input);
    return { ok: true };
  };
  const ctx: ExecutionContext = {
    recipe: { recipe_id: 'r1' } as never,
    stores: {} as never,
    ingredientExecutor,
    connectionProfileResolver: () => allowedProfile(),
    ...(opts.contracted === true
      ? {
          execution_source: {
            channel: 'chat',
            actor: 'contracted_user',
            chat_session_id: 's1',
            user_id: 'u1',
            contract_id: 'k1',
          },
        }
      : {}),
    ...(opts.noDescriber === true
      ? {}
      : {
          describeUploadSource: async (file_ref: string) => {
            described.push(file_ref);
            if (opts.unknownFile === true) return undefined;
            return {
              size_bytes: opts.size_bytes ?? SIZE,
              content_hash: opts.content_hash ?? CONTENT_HASH,
            };
          },
        }),
  } as unknown as ExecutionContext;
  return { ctx, inputs, described };
};

const run = (
  ctx: ExecutionContext,
  manifest: IngredientManifest,
  args: Record<string, unknown> = { file: FILE_REF },
): Promise<unknown> => runCatalogOperation(
  ctx,
  manifest,
  'pub/cat',
  { operation: 'x', connection: 'raw-connection', args } as never,
  'primary-connection',
  undefined,
  undefined,
  undefined,
);

const walkOf = (input: Record<string, unknown>): ChunkedUploadWalkInput =>
  input[CHUNKED_UPLOAD_WIRE_WALK_KEY] as ChunkedUploadWalkInput;

describe('D-217 β2 — a chunked declaration becomes ONE walk descriptor', () => {
  it('fixes the request count from the file size, before any dispatch', async () => {
    const { ctx, inputs, described } = makeHarness();
    await run(ctx, manifestFor(bindingWith(chunkedSpec())));

    expect(described).toEqual([FILE_REF]);
    expect(inputs).toHaveLength(1);
    const walk = walkOf(inputs[0]!);
    // ⌈100/16⌉ = 7 — two locally-known numbers, neither of them anything the
    // target said. That is the § 8a carve-out in one expression.
    expect(walk.count).toBe(7);
    // INIT + 7 APPENDs + FINALIZE. `count` alone is not the approval bound.
    expect(walk.request_bound).toBe(9);
    expect(walk.total_bytes).toBe(SIZE);
    expect(walk.file_ref).toBe(FILE_REF);
    expect(walk.expect_sha256).toBe(CONTENT_HASH);
    expect(walk.spec.chunk_bytes).toBe(CHUNK);
  });

  it('⛔ is byte-identical across two dispatches of the same act', async () => {
    // 🔑 THE REGRESSION TEST FOR THE RULING. The commit Gateway hashes this
    // input for the action identity; anything per-attempt here gives every
    // honest repeat a different `canonical_payload_hash`, so a D-177 session
    // grant can never match and the owner re-approves every upload — failing
    // CLOSED, silently. A staging token was exactly that, which is why it now
    // lives below the commit boundary and only STABLE names ride the wire.
    const { ctx, inputs } = makeHarness();
    const manifest = manifestFor(bindingWith(chunkedSpec()));
    await run(ctx, manifest);
    await run(ctx, manifest);

    expect(inputs).toHaveLength(2);
    expect(JSON.stringify(inputs[0])).toBe(JSON.stringify(inputs[1]));
  });

  it('leaves the file arg at its own key, so it stays authority-bearing', async () => {
    // `affects_target` and the open-projection walk resolve `spec.arg` as an
    // ordinary path. Moving the ref INTO the walk and deleting it here would
    // quietly cost the op its authority binding.
    const { ctx, inputs } = makeHarness();
    await run(ctx, manifestFor(bindingWith(chunkedSpec())));
    expect(inputs[0]!.file).toBe(FILE_REF);
  });

  it('carries the op\'s own args for {arg} substitution in a phase', async () => {
    const { ctx, inputs } = makeHarness();
    await run(ctx, manifestFor(bindingWith(chunkedSpec())), {
      file: FILE_REF,
      media_category: 'tweet_video',
    });
    expect(walkOf(inputs[0]!).args).toMatchObject({ media_category: 'tweet_video' });
  });

  it('translates a ONE-SHOT declaration into an engine-owned upload wire shape', async () => {
    const { ctx, inputs } = makeHarness();
    await run(
      ctx,
      manifestFor(bindingWith({
        kind: 'multipart', arg: 'file', field: 'media', max_bytes: 1_024,
      })),
      { file: FILE_REF },
    );
    expect(inputs[0]).not.toHaveProperty(CHUNKED_UPLOAD_WIRE_WALK_KEY);
    expect(inputs[0]).not.toHaveProperty('file');
    expect(inputs[0]!['body_file.media']).toBe(FILE_REF);
    expect(inputs[0]![HTTP_UPLOAD_WIRE_KIND_KEY]).toBe('multipart');
    expect(inputs[0]![HTTP_UPLOAD_WIRE_FIELD_KEY]).toBe('media');
    expect(inputs[0]![HTTP_UPLOAD_WIRE_MAX_BYTES_KEY]).toBe(1_024);
  });

  it('leaves an op with no upload declaration alone', async () => {
    const { ctx, inputs } = makeHarness();
    await run(ctx, manifestFor(bindingWith(undefined)));
    expect(inputs[0]).not.toHaveProperty(CHUNKED_UPLOAD_WIRE_WALK_KEY);
  });
});

describe('D-217 β2 — every refusal happens before a byte can leave', () => {
  it('fails closed when the host cannot read file metadata', async () => {
    // An unfixable count is the one thing the carve-out does not permit, so a
    // host that cannot size the file must not dispatch at all.
    const { ctx, inputs } = makeHarness({ noDescriber: true });
    await expect(run(ctx, manifestFor(bindingWith(chunkedSpec())))).rejects.toThrow(
      /no .*upload-source reader is wired/,
    );
    expect(inputs).toHaveLength(0);
  });

  it('fails closed on an unknown file_ref', async () => {
    const { ctx, inputs } = makeHarness({ unknownFile: true });
    await expect(run(ctx, manifestFor(bindingWith(chunkedSpec())))).rejects.toThrow(
      /cannot read file/,
    );
    expect(inputs).toHaveLength(0);
  });

  it('fails closed when the declared arg carries no file_ref', async () => {
    const { ctx, inputs } = makeHarness();
    await expect(
      run(ctx, manifestFor(bindingWith(chunkedSpec())), { file: '' }),
    ).rejects.toThrow(/carries no file_ref/);
    expect(inputs).toHaveLength(0);
  });

  it('refuses a file over the ceiling before the first socket opens', async () => {
    const { ctx, inputs } = makeHarness({ size_bytes: 512 * 1024 * 1024 + 1 });
    await expect(run(ctx, manifestFor(bindingWith(chunkedSpec())))).rejects.toThrow(/ceiling/);
    expect(inputs).toHaveLength(0);
  });

  it('re-runs the § 8a predicate at RUN time, not just at authoring', async () => {
    // An installed pack may predate the rule or have arrived through a path
    // that skipped it — so a `chunk_bytes` that is not a literal integer is
    // refused here, where the requests would otherwise be counted from it.
    const { ctx, inputs } = makeHarness();
    const bad = { ...chunkedSpec(), chunk_bytes: '{session}' } as unknown as ChunkedUploadSpec;
    await expect(run(ctx, manifestFor(bindingWith(bad)))).rejects.toThrow(/§ 8a/);
    expect(inputs).toHaveLength(0);
  });

  it('omits the content pin rather than sending an empty one', async () => {
    // A record with no content hash still uploads; the pin is what strengthens
    // the identity when present, not a precondition invented here.
    const { ctx, inputs } = makeHarness({ content_hash: '' });
    await run(ctx, manifestFor(bindingWith(chunkedSpec())));
    expect(walkOf(inputs[0]!)).not.toHaveProperty('expect_sha256');
  });
});

describe('D-217 § 6.1 — the raise carries the amplification bound', () => {
  it('⛔ attaches egress_bound to the ask, off the walk descriptor it just built', async () => {
    // The RENDERING is tested in the gateway package; this is the COMPOSITION
    // site — that the number ever reaches the ask at all. A mutation sweep
    // found both `egress_bound` never being attached AND `chunkedEgressBound`
    // returning a constant surviving, because nothing drove this path.
    //
    // 🔑 It reads off the DISPATCH INPUT rather than recomputing, so the number
    // the owner sees and the number the adapter is pinned to are the same
    // number by construction — not two derivations that agree until one moves.
    const { ctx, inputs } = makeHarness({ contracted: true });
    const upload = chunkedSpec({
      status: {
        method: 'GET',
        path: '/media',
        query: { command: 'STATUS', id: '{session}' },
        max_polls: 4,
        done: { path: 'result.state', equals: 'succeeded' },
      },
    });
    const manifest = manifestFor(
      bindingWith(upload),
      operation({ risk_tier: 'write', approval: 'ask' }),
    );

    await expect(run(ctx, manifest)).rejects.toMatchObject({
      name: 'PreflightRequiredSignal',
      // INIT + ⌈100/16⌉ APPENDs + FINALIZE + up to 4 polls = 13.
      egress_bound: { requests: 13, total_bytes: SIZE },
    });
    // …and it really was a hold: nothing crossed the wire.
    expect(inputs).toHaveLength(0);
  });

  it('attaches NO bound when the held op is an ordinary single request', async () => {
    // The absence is what keeps the line meaningful on the asks that have it.
    const { ctx } = makeHarness({ contracted: true });
    const manifest = manifestFor(
      bindingWith(undefined),
      operation({ risk_tier: 'write', approval: 'ask' }),
    );

    const raised = await run(ctx, manifest).then(
      () => { throw new Error('expected a preflight hold'); },
      (e: unknown) => e as Record<string, unknown>,
    );
    expect(raised.name).toBe('PreflightRequiredSignal');
    expect(raised.egress_bound).toBeUndefined();
  });
});
